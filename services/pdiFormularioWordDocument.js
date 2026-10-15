const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
} = require('docx');
const { UPLOAD_DIR, buildUrl, deleteFile } = require('./pdiFormularioStorage');
const { uploadOrReplaceFile } = require('./pdiDriveStorage');
const { getHierarchyForIndicador, withCorte } = require('./pdiDriveHierarchy');
const Indicador = require('../models/pdiIndicador');
const {
    buildMembreteHeader: buildPdiMembreteHeader,
    applyMembreteDocxTemplate,
} = require('./pdiWordAssets');

function buildMembreteHeader() {
    return buildPdiMembreteHeader();
}

const DOCX_MIMETYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const sanitizeFilePart = (value) =>
    String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'formulario';

const buildAnswerParagraphs = (respuestas = []) => {
    const blocks = [];

    respuestas.forEach((respuesta, index) => {
        const etiqueta = respuesta.etiqueta || `Campo ${index + 1}`;
        blocks.push(
            new Paragraph({
                spacing: { before: 220, after: 80 },
                children: [new TextRun({ text: etiqueta, bold: true })],
            })
        );

        if (respuesta.valor_texto) {
            String(respuesta.valor_texto)
                .split(/\r?\n/)
                .forEach((line) => {
                    blocks.push(new Paragraph({ children: [new TextRun(line || ' ')] }));
                });
        } else if (respuesta.url) {
            blocks.push(
                new Paragraph({
                    children: [
                        new TextRun(`Documento adjunto: ${respuesta.nombre_original || respuesta.filename || respuesta.url}`),
                    ],
                })
            );
            blocks.push(new Paragraph({ children: [new TextRun(`URL: ${respuesta.url}`)] }));
        } else {
            blocks.push(new Paragraph({ children: [new TextRun('Sin respuesta')] }));
        }
    });

    return blocks;
};

const getDocumentosEvidencia = (respuesta) => {
    const documentos = Array.isArray(respuesta.documentos)
        ? respuesta.documentos.filter((doc) => doc?.url || doc?.nombre_original || doc?.filename)
        : [];
    if (documentos.length) return documentos;
    if (!respuesta.documento_url && !respuesta.documento_nombre_original && !respuesta.documento_filename) return [];
    return [{
        nombre_original: respuesta.documento_nombre_original,
        filename: respuesta.documento_filename,
        url: respuesta.documento_url,
    }];
};

const buildEvidenciaSection = (respuesta) => {
    const blocks = [];
    const documentos = getDocumentosEvidencia(respuesta);
    if (!documentos.length) return blocks;

    blocks.push(
        new Paragraph({
            spacing: { before: 400, after: 100 },
            children: [new TextRun({ text: 'Evidencias adjuntas', bold: true, size: 26 })],
        })
    );

    documentos.forEach((documento, index) => {
        const nombre = documento.nombre_original || documento.filename || 'Archivo adjunto';
        blocks.push(
            new Paragraph({
                children: [new TextRun(`Archivo ${index + 1}: ${nombre}`)],
            })
        );
        if (documento.url) {
            blocks.push(
                new Paragraph({ children: [new TextRun(`URL: ${documento.url}`)] })
            );
        }
    });

    return blocks;
};

const toNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(String(value).replace('%', '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
};

const formatPct = (value) => `${(Math.round(value * 100) / 100).toLocaleString('es-CO')}%`;

// Resumen del avance del indicador para el corte reportado: meta y avance del
// periodo, % de cumplimiento del periodo y % de avance acumulado frente a la meta final.
const buildAvanceSection = (indicador, corte) => {
    if (!indicador) return [];
    const corteKey = String(corte ?? '').trim().toUpperCase();
    const periodo = (indicador.periodos ?? []).find(
        (p) => String(p.periodo ?? '').trim().toUpperCase() === corteKey
    );
    const meta = toNumber(periodo?.meta);
    const avance = toNumber(periodo?.avance);
    const cumplimientoPeriodo = meta && avance !== null ? Math.min((avance / meta) * 100, 100) : null;
    const avanceTotal = toNumber(indicador.avance_total_real ?? indicador.avance);

    const fila = (label, value) => new Paragraph({
        children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(value)],
    });

    return [
        new Paragraph({
            spacing: { before: 300, after: 100 },
            children: [new TextRun({ text: 'Porcentaje de avance', bold: true, size: 26 })],
        }),
        fila('Meta del periodo', periodo?.meta != null && periodo?.meta !== '' ? String(periodo.meta) : 'Sin dato'),
        fila('Avance reportado', periodo?.avance != null && periodo?.avance !== '' ? String(periodo.avance) : 'Sin dato'),
        fila('Cumplimiento del periodo', cumplimientoPeriodo !== null ? formatPct(cumplimientoPeriodo) : 'Sin dato'),
        fila(
            `Avance total frente a la meta final${indicador.meta_final_2029 != null ? ` (${indicador.meta_final_2029})` : ''}`,
            avanceTotal !== null ? formatPct(avanceTotal) : 'Sin dato'
        ),
    ];
};

const generateWordForRespuesta = async ({ respuesta, formularioNombre, indicadorNombre, indicadorCodigo, indicador }) => {
    const membreteHeader = buildMembreteHeader();
    const section = {
        children: [
            new Paragraph({
                heading: HeadingLevel.TITLE,
                children: [new TextRun({ text: formularioNombre || 'Formulario de evidencias', bold: true })],
            }),
            new Paragraph({
                children: [new TextRun(`Indicador: ${indicadorCodigo ? `${indicadorCodigo} · ` : ''}${indicadorNombre || 'Sin indicador'}`)],
            }),
            new Paragraph({ children: [new TextRun(`Periodo: ${respuesta.corte || 'Sin periodo'}`)] }),
            new Paragraph({ children: [new TextRun(`Responsable: ${respuesta.respondido_por || 'Sin responsable'}`)] }),
            new Paragraph({
                children: [new TextRun(`Fecha de envío: ${respuesta.fecha_envio ? new Date(respuesta.fecha_envio).toLocaleDateString('es-CO') : 'Sin fecha'}`)],
            }),
            ...buildAvanceSection(indicador, respuesta.corte),
            ...buildAnswerParagraphs(respuesta.respuestas),
        ],
    };
    if (membreteHeader) section.headers = { default: membreteHeader };
    const doc = new Document({ sections: [section] });

    const buffer = applyMembreteDocxTemplate(await Packer.toBuffer(doc));
    const unique = crypto.randomBytes(8).toString('hex');
    const filename = `formulario_${sanitizeFilePart(formularioNombre)}_${sanitizeFilePart(respuesta.corte)}_${unique}.docx`;
    const driveNombre = `Reporte de avances - ${indicadorCodigo || indicadorNombre || formularioNombre}.docx`;
    const outputPath = path.join(UPLOAD_DIR, filename);

    fs.writeFileSync(outputPath, buffer);

    return {
        filename,
        driveNombre,
        url: buildUrl(filename),
        buffer,
        mimetype: DOCX_MIMETYPE,
    };
};

const replaceWordDocument = async ({ respuesta, formularioNombre, indicadorNombre, indicadorCodigo }) => {
    if (respuesta.word_filename) {
        deleteFile(respuesta.word_filename);
    }

    const indicadorId = typeof respuesta.indicador_id === 'object'
        ? respuesta.indicador_id?._id
        : respuesta.indicador_id;
    const indicador = indicadorId
        ? await Indicador.findById(indicadorId)
            .select('codigo nombre periodos meta_final_2029 avance avance_total_real')
            .lean()
        : null;

    const generated = await generateWordForRespuesta({
        respuesta,
        formularioNombre,
        indicadorNombre,
        indicadorCodigo,
        indicador,
    });

    // Se reemplaza el reporte anterior en Drive (mismo archivo) para que solo
    // exista la última versión y no se acumulen copias que generen confusión.
    const uploaded = indicadorId
        ? await (async () => {
            const { jerarquia } = await getHierarchyForIndicador(indicadorId);
            return uploadOrReplaceFile(
                generated.buffer,
                generated.driveNombre,
                generated.mimetype,
                withCorte(jerarquia, respuesta.corte),
                { previousFileId: respuesta.word_drive_file_id }
            );
        })()
        : null;

    respuesta.word_filename = generated.filename;
    respuesta.word_url = uploaded?.webViewLink || uploaded?.webContentLink || generated.url;
    respuesta.word_nombre_original = generated.driveNombre;
    respuesta.word_drive_file_id = uploaded?.fileId || '';
    respuesta.word_drive_web_view_link = uploaded?.webViewLink || '';
    respuesta.word_drive_web_content_link = uploaded?.webContentLink || '';
    await respuesta.save();

    return respuesta;
};

module.exports = {
    replaceWordDocument,
};
