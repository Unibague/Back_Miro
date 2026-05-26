const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    AlignmentType, BorderStyle, Table, TableRow, TableCell, WidthType,
    ImageRun, Header,
    HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
} = require('docx');

const UPLOAD_DIR   = path.join(__dirname, '../uploads/pdi/informes');
const MEMBRETE_PATH = path.join(__dirname, '../assets/pdi/membrete-header.jpeg');
const PORTADA_PATH  = path.join(__dirname, '../assets/pdi/portada.jpeg');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// A4 a 96 DPI (px). Membrete: 2550×3300 → escalar al ancho A4 manteniendo relación.
const MEMBRETE_W = 794;
const MEMBRETE_H = Math.round(794 * 3300 / 2550); // ≈ 1027

// Portada: 1236×1600 → escalar al ancho A4 manteniendo relación.
const PORTADA_W  = 794;
const PORTADA_H  = Math.round(794 * 1600 / 1236); // ≈ 1027

function buildMembreteHeader() {
    if (!fs.existsSync(MEMBRETE_PATH)) return null;
    return new Header({
        children: [
            new Paragraph({
                children: [
                    new ImageRun({
                        type: 'jpg',
                        data: fs.readFileSync(MEMBRETE_PATH),
                        transformation: { width: MEMBRETE_W, height: MEMBRETE_H },
                        floating: {
                            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
                            verticalPosition:   { relative: VerticalPositionRelativeFrom.PAGE,   offset: 0 },
                            behindDocument: true,
                            allowOverlap:   true,
                        },
                    }),
                ],
            }),
        ],
    });
}

function buildPortadaSection() {
    if (!fs.existsSync(PORTADA_PATH)) return null;
    return {
        properties: { page: { margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0 } } },
        children: [
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 0 },
                children: [
                    new ImageRun({
                        type: 'jpg',
                        data: fs.readFileSync(PORTADA_PATH),
                        transformation: { width: PORTADA_W, height: PORTADA_H },
                    }),
                ],
            }),
        ],
    };
}

function buildContentSection(children) {
    const header = buildMembreteHeader();
    return header ? { headers: { default: header }, children } : { children };
}

const DOCX_MIMETYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const BASE_URL = () => process.env.BACKEND_URL || 'http://localhost:3456';
const buildUrl = (filename) => `${BASE_URL()}/uploads/pdi/informes/${filename}`;

const sanitize = (v) =>
    String(v ?? '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'informe';

// ── Helpers de párrafos ───────────────────────────────────────────────────────

const h1 = (text) => new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 120 },
    children: [new TextRun({ text, bold: true, size: 28 })],
});

const h2 = (text) => new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 100 },
    children: [new TextRun({ text, bold: true, size: 24, color: '4B0082' })],
});

const h3 = (text) => new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, size: 22, color: '6B21A8' })],
});

const h4 = (text) => new Paragraph({
    spacing: { before: 160, after: 60 },
    children: [new TextRun({ text, bold: true, size: 20, color: '374151' })],
});

const campo = (label, value) => new Paragraph({
    spacing: { before: 80, after: 40 },
    children: [
        new TextRun({ text: `${label}: `, bold: true }),
        new TextRun({ text: String(value ?? '—') }),
    ],
});

const separador = () => new Paragraph({
    spacing: { before: 200, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
    children: [],
});

const separadorFino = () => new Paragraph({
    spacing: { before: 100, after: 100 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E5E7EB' } },
    children: [],
});

const formatCOP = (v) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v ?? 0);

function saveDocumentBuffer(buffer, filename) {
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    return {
        filename,
        url: buildUrl(filename),
        buffer,
        mimetype: DOCX_MIMETYPE,
    };
}

// ── Ordenar periodos ───────────────────────────────────────────────────────────────
function ordenarPeriodos(periodos = []) {
    return [...periodos].sort((a, b) => String(a.periodo ?? '').localeCompare(String(b.periodo ?? '')));
}

function filtrarPeriodos(periodos = [], corte = null) {
    const ordenados = ordenarPeriodos(periodos);
    if (!corte) return ordenados;
    return ordenados.filter((p) => p.periodo === corte);
}

// ── Tabla genérica ──────────────────────────────────────────────────────────────────
function crearTabla(headers, filas) {
    const pct = Math.floor(100 / headers.length);
    const headerRow = new TableRow({
        children: headers.map((t) => new TableCell({
            width: { size: pct, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, size: 18 })] })],
        })),
    });
    const rows = filas.map((fila) => new TableRow({
        children: fila.map((v) => new TableCell({
            width: { size: pct, type: WidthType.PERCENTAGE },
            children: [new Paragraph({ children: [new TextRun({ text: String(v ?? '—'), size: 18 })] })],
        })),
    }));
    return new Table({ rows: [headerRow, ...rows], width: { size: 100, type: WidthType.PERCENTAGE } });
}

// ── Tabla de periodos ──────────────────────────────────────────────────────────────
function tablaPeriodos(periodos = []) {
    if (!periodos.length) return [];
    return [
        new Paragraph({ spacing: { before: 100, after: 60 }, children: [new TextRun({ text: 'Periodos reportados', bold: true })] }),
        crearTabla(
            ['Periodo', 'Meta', 'Avance', 'Estado', 'Reportado por', 'Fecha envío'],
            periodos.map((p) => [
                p.periodo,
                p.meta,
                p.avance,
                p.estado_reporte ?? 'Borrador',
                p.reportado_por,
                p.fecha_envio ? new Date(p.fecha_envio).toLocaleDateString('es-CO') : '—',
            ])
        ),
    ];
}

// ── Tabla de evidencias ──────────────────────────────────────────────────────────────
function tablaEvidencias(evidencias = [], corte = null) {
    const filtradas = corte ? evidencias.filter((ev) => ev.periodo === corte) : evidencias;
    if (!filtradas.length) return [];
    return [
        new Paragraph({ spacing: { before: 100, after: 60 }, children: [new TextRun({ text: 'Evidencias adjuntas', bold: true })] }),
        crearTabla(
            ['Nombre archivo', 'Periodo', 'Estado', 'Subido por', 'Fecha', 'URL'],
            filtradas.map((ev) => [
                ev.nombre_original,
                ev.periodo,
                ev.estado,
                ev.subido_por,
                ev.fecha_subida ? new Date(ev.fecha_subida).toLocaleDateString('es-CO') : '—',
                ev.url,
            ])
        ),
    ];
}

// ── Sección de formularios/respuestas del indicador (igual que en el informe de indicador) ──────
function seccionFormularios(respuestas = [], corte = null) {
    const filtradas = corte
        ? respuestas.filter((r) => r.corte === corte)
        : respuestas;

    const enviadas = filtradas.filter((r) => r.estado === 'Enviado');
    if (!enviadas.length) return [];

    const bloques = [
        new Paragraph({ spacing: { before: 140, after: 60 }, children: [new TextRun({ text: 'Formularios de evidencias enviados', bold: true, size: 20 })] }),
    ];

    for (const r of enviadas) {
        const formularioNombre = typeof r.formulario_id === 'object'
            ? (r.formulario_id?.nombre ?? 'Formulario')
            : 'Formulario';
        const fechaEnvio = r.fecha_envio ? new Date(r.fecha_envio).toLocaleDateString('es-CO') : '—';
        const avalEstado = r.estado_aval ?? 'Pendiente';
        const avalPor    = r.aval_por ? ` · ${r.aval_por}` : '';
        const avalFecha  = r.aval_fecha ? ` (${new Date(r.aval_fecha).toLocaleDateString('es-CO')})` : '';

        bloques.push(
            h4(`${formularioNombre} — Corte ${r.corte || '—'}`),
            campo('Enviado por', r.respondido_por),
            campo('Fecha de envío', fechaEnvio),
            campo('Estado del aval', `${avalEstado}${avalPor}${avalFecha}`),
        );

        if (r.aval_comentario) {
            bloques.push(campo('Observaciones del líder', r.aval_comentario));
        }

        // Respuestas campo a campo
        if (r.respuestas?.length) {
            bloques.push(new Paragraph({
                spacing: { before: 80, after: 40 },
                children: [new TextRun({ text: 'Respuestas del formulario:', bold: true })],
            }));
            for (const resp of r.respuestas) {
                bloques.push(new Paragraph({
                    spacing: { before: 60, after: 20 },
                    indent: { left: 360 },
                    children: [new TextRun({ text: `${resp.etiqueta}: `, bold: true })],
                }));
                if (resp.valor_texto) {
                    for (const linea of String(resp.valor_texto).split(/\r?\n/)) {
                        bloques.push(new Paragraph({
                            spacing: { before: 0, after: 20 },
                            indent: { left: 720 },
                            children: [new TextRun({ text: linea || ' ' })],
                        }));
                    }
                } else if (resp.url) {
                    bloques.push(new Paragraph({
                        spacing: { before: 0, after: 20 },
                        indent: { left: 720 },
                        children: [
                            new TextRun({ text: resp.nombre_original || 'Archivo adjunto' }),
                            new TextRun({ text: `  ${resp.url}`, color: '6B7280' }),
                        ],
                    }));
                } else {
                    bloques.push(new Paragraph({
                        spacing: { before: 0, after: 20 },
                        indent: { left: 720 },
                        children: [new TextRun({ text: 'Sin respuesta', color: '9CA3AF' })],
                    }));
                }
            }
        }

        if (r.word_url) {
            bloques.push(campo('Formato Word del formulario', `${r.word_nombre_original || r.word_filename || 'Formulario generado'}  ${r.word_url}`));
        }

        const documentosEvidencia = Array.isArray(r.documentos) && r.documentos.length
            ? r.documentos
            : (r.documento_url ? [{
                nombre_original: r.documento_nombre_original,
                filename: r.documento_filename,
                url: r.documento_url,
            }] : []);
        documentosEvidencia.forEach((documento, index) => {
            bloques.push(campo(
                `Documento de evidencia adjunto ${index + 1}`,
                `${documento.nombre_original || documento.filename || 'Archivo adjunto'}  ${documento.url || ''}`
            ));
        });

        bloques.push(separadorFino());
    }

    return bloques;
}

// ── Sección de un indicador ───────────────────────────────────────────────────
function seccionIndicador(ind, respuestasInd = [], corte = null) {
    const periodosAMostrar = filtrarPeriodos(ind.periodos ?? [], corte);

    const bloques = [
        h3(`${ind.codigo} · ${ind.nombre}`),
        campo('Responsable', ind.responsable),
        campo('Avance actual', `${ind.avance_total_real ?? ind.avance ?? 0}%`),
        campo('Meta final', ind.meta_final_2029),
        campo('Tipo de cálculo', ind.tipo_calculo),
        ...tablaPeriodos(periodosAMostrar),
    ];

    // Campos cualitativos por periodo
    for (const p of periodosAMostrar) {
        const tieneCualitativo = p.resultados_alcanzados || p.logros || p.alertas || p.justificacion_retrasos;
        if (!tieneCualitativo) continue;
        bloques.push(new Paragraph({
            spacing: { before: 120, after: 40 },
            children: [new TextRun({ text: `Corte ${p.periodo} — detalle`, bold: true, italics: true })],
        }));
        if (p.resultados_alcanzados) bloques.push(campo('Resultados alcanzados', p.resultados_alcanzados));
        if (p.logros)                bloques.push(campo('Logros', p.logros));
        if (p.alertas)               bloques.push(campo('Alertas', p.alertas));
        if (p.justificacion_retrasos) bloques.push(campo('Justificación de retrasos', p.justificacion_retrasos));
    }

    // Evidencias del indicador
    bloques.push(...tablaEvidencias(ind.evidencias ?? [], corte));

    // Formularios enviados por el responsable (igual que en el informe de indicador)
    bloques.push(...seccionFormularios(respuestasInd, corte));

    return bloques;
}

// ── Sección de una acción ───────────────────────────────────────────────────
function seccionAccion(accion, indicadores, respuestasPorIndicador, corte = null) {
    return [
        h2(`Acción: ${accion.codigo} · ${accion.nombre}`),
        campo('Responsable', accion.responsable),
        campo('Avance', `${accion.avance ?? 0}%`),
        campo('Presupuesto asignado', formatCOP(accion.presupuesto)),
        campo('Presupuesto ejecutado', formatCOP(accion.presupuesto_ejecutado)),
        ...indicadores.flatMap((ind) =>
            seccionIndicador(ind, respuestasPorIndicador[String(ind._id)] ?? [], corte)
        ),
        separador(),
    ];
}

// ── Generadores principales ───────────────────────────────────────────────────────

async function generarInformeIndicador({ indicador, respuestasInd = [], corte = null }) {
    const subtitulo = corte ? `Corte: ${corte}` : 'Todos los cortes';
    const children = [
        new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 300 },
            children: [new TextRun({ text: 'Informe de Evidencias - Indicador PDI', bold: true, size: 36 })],
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 100 },
            children: [new TextRun({ text: subtitulo, color: '7C3AED', bold: true })],
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 600 },
            children: [new TextRun({ text: `Generado el ${new Date().toLocaleDateString('es-CO')}`, color: '6B7280' })],
        }),
        ...seccionIndicador(indicador, respuestasInd, corte),
    ];

    const doc = new Document({ sections: [buildContentSection(children)] });
    const buffer = await Packer.toBuffer(doc);
    const cortePart = corte ? `_${sanitize(corte)}` : '_todos';
    const filename = `informe_indicador_${sanitize(indicador.codigo)}${cortePart}_${crypto.randomBytes(6).toString('hex')}.docx`;
    return saveDocumentBuffer(buffer, filename);
}

async function generarInformeAccion({ accion, indicadores = [], respuestasPorIndicador = {}, corte = null }) {
    const subtitulo = corte ? `Corte: ${corte}` : 'Todos los cortes';
    const children = [
        new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 300 },
            children: [new TextRun({ text: 'Informe de Avance - Accion PDI', bold: true, size: 36 })],
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 100 },
            children: [new TextRun({ text: subtitulo, color: '7C3AED', bold: true })],
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 600 },
            children: [new TextRun({ text: `Generado el ${new Date().toLocaleDateString('es-CO')}`, color: '6B7280' })],
        }),
        ...seccionAccion(accion, indicadores, respuestasPorIndicador, corte),
    ];

    const doc = new Document({ sections: [buildContentSection(children)] });
    const buffer = await Packer.toBuffer(doc);
    const cortePart = corte ? `_${sanitize(corte)}` : '_todos';
    const filename = `informe_accion_${sanitize(accion.codigo)}${cortePart}_${crypto.randomBytes(6).toString('hex')}.docx`;
    return saveDocumentBuffer(buffer, filename);
}

async function generarInformeProyecto({ proyecto, acciones, indicadoresPorAccion, respuestasPorIndicador = {}, corte = null }) {
    const subtitulo = corte ? `Corte: ${corte}` : 'Todos los cortes';
    const children = [
        new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 300 },
            children: [new TextRun({ text: 'Informe de Avance — Proyecto PDI', bold: true, size: 36 })],
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 100 },
            children: [new TextRun({ text: subtitulo, color: '7C3AED', bold: true })],
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 600 },
            children: [new TextRun({ text: `Generado el ${new Date().toLocaleDateString('es-CO')}`, color: '6B7280' })],
        }),
        h1(`${proyecto.codigo} · ${proyecto.nombre}`),
        campo('Responsable', proyecto.responsable),
        campo('Formulador', proyecto.formulador),
        campo('Avance del proyecto', `${proyecto.avance ?? 0}%`),
        campo('Presupuesto asignado', formatCOP(proyecto.presupuesto)),
        campo('Presupuesto ejecutado', formatCOP(proyecto.presupuesto_ejecutado)),
        campo('Fecha inicio', proyecto.fecha_inicio ?? '—'),
        campo('Fecha fin', proyecto.fecha_fin ?? '—'),
        separador(),
        ...acciones.flatMap((acc) =>
            seccionAccion(acc, indicadoresPorAccion[String(acc._id)] ?? [], respuestasPorIndicador, corte)
        ),
    ];

    const portada = buildPortadaSection();
    const sections = portada
        ? [portada, buildContentSection(children)]
        : [buildContentSection(children)];
    const doc = new Document({ sections });
    const buffer = await Packer.toBuffer(doc);
    const filename = `informe_proyecto_${sanitize(proyecto.codigo)}.docx`;
    return saveDocumentBuffer(buffer, filename);
}

async function generarInformeMacro({ macro, proyectos, accionesPorProyecto, indicadoresPorAccion, respuestasPorIndicador = {}, corte = null }) {
    const subtitulo = corte ? `Corte: ${corte}` : 'Todos los cortes';
    const children = [
        new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 300 },
            children: [new TextRun({ text: 'Informe de Avance — Macroproyecto PDI', bold: true, size: 36 })],
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 100 },
            children: [new TextRun({ text: subtitulo, color: '7C3AED', bold: true })],
        }),
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 600 },
            children: [new TextRun({ text: `Generado el ${new Date().toLocaleDateString('es-CO')}`, color: '6B7280' })],
        }),
        h1(`${macro.codigo} · ${macro.nombre}`),
        campo('Líder', macro.lider),
        campo('Avance del macroproyecto', `${macro.avance ?? 0}%`),
        campo('Presupuesto asignado', formatCOP(macro.presupuesto)),
        campo('Presupuesto ejecutado', formatCOP(macro.presupuesto_ejecutado)),
        separador(),
    ];

    for (const proy of proyectos) {
        children.push(
            h1(`Proyecto: ${proy.codigo} · ${proy.nombre}`),
            campo('Responsable', proy.responsable),
            campo('Avance', `${proy.avance ?? 0}%`),
            campo('Presupuesto asignado', formatCOP(proy.presupuesto)),
            campo('Presupuesto ejecutado', formatCOP(proy.presupuesto_ejecutado)),
            separador(),
        );
        const acciones = accionesPorProyecto[String(proy._id)] ?? [];
        for (const acc of acciones) {
            children.push(...seccionAccion(acc, indicadoresPorAccion[String(acc._id)] ?? [], respuestasPorIndicador, corte));
        }
    }

    const portada = buildPortadaSection();
    const sections = portada
        ? [portada, buildContentSection(children)]
        : [buildContentSection(children)];
    const doc = new Document({ sections });
    const buffer = await Packer.toBuffer(doc);
    const filename = `informe_macro_${sanitize(macro.codigo)}.docx`;
    return saveDocumentBuffer(buffer, filename);
}

module.exports = {
    generarInformeIndicador,
    generarInformeAccion,
    generarInformeProyecto,
    generarInformeMacro,
    UPLOAD_DIR,
    buildUrl,
};
