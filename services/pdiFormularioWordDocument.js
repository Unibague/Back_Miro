const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const { UPLOAD_DIR, buildUrl, deleteFile } = require('./pdiFormularioStorage');

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

const generateWordForRespuesta = async ({ respuesta, formularioNombre, indicadorNombre, indicadorCodigo }) => {
    const doc = new Document({
        sections: [{
            properties: {},
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
                ...buildAnswerParagraphs(respuesta.respuestas),
            ],
        }],
    });

    const buffer = await Packer.toBuffer(doc);
    const unique = crypto.randomBytes(8).toString('hex');
    const filename = `formulario_${sanitizeFilePart(formularioNombre)}_${sanitizeFilePart(respuesta.corte)}_${unique}.docx`;
    const outputPath = path.join(UPLOAD_DIR, filename);

    fs.writeFileSync(outputPath, buffer);

    return {
        filename,
        url: buildUrl(filename),
    };
};

const replaceWordDocument = async ({ respuesta, formularioNombre, indicadorNombre, indicadorCodigo }) => {
    if (respuesta.word_filename) {
        deleteFile(respuesta.word_filename);
    }

    const generated = await generateWordForRespuesta({
        respuesta,
        formularioNombre,
        indicadorNombre,
        indicadorCodigo,
    });

    respuesta.word_filename = generated.filename;
    respuesta.word_url = generated.url;
    await respuesta.save();

    return respuesta;
};

module.exports = {
    replaceWordDocument,
};
