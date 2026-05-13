const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    AlignmentType, BorderStyle, Table, TableRow, TableCell, WidthType,
} = require('docx');

const UPLOAD_DIR = path.join(__dirname, '../uploads/pdi/informes');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const BASE_URL = () => process.env.BACKEND_URL || 'http://localhost:6000';
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

const formatCOP = (v) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v ?? 0);

// ── Tabla de periodos de un indicador ────────────────────────────────────────

function tablaPeriodos(periodos = []) {
    if (!periodos.length) return [];

    const headerRow = new TableRow({
        children: ['Periodo', 'Meta', 'Avance', 'Estado', 'Reportado por'].map((t) =>
            new TableCell({
                width: { size: 20, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, size: 18 })] })],
            })
        ),
    });

    const rows = periodos.map((p) =>
        new TableRow({
            children: [
                p.periodo,
                String(p.meta ?? '—'),
                String(p.avance ?? '—'),
                p.estado_reporte ?? 'Borrador',
                p.reportado_por || '—',
            ].map((v) =>
                new TableCell({
                    width: { size: 20, type: WidthType.PERCENTAGE },
                    children: [new Paragraph({ children: [new TextRun({ text: v, size: 18 })] })],
                })
            ),
        })
    );

    return [
        new Paragraph({ spacing: { before: 100, after: 60 }, children: [new TextRun({ text: 'Periodos reportados', bold: true })] }),
        new Table({ rows: [headerRow, ...rows], width: { size: 100, type: WidthType.PERCENTAGE } }),
    ];
}

// ── Sección de un indicador ───────────────────────────────────────────────────

function seccionIndicador(ind) {
    const bloques = [
        h3(`${ind.codigo} · ${ind.nombre}`),
        campo('Responsable', ind.responsable),
        campo('Avance actual', `${ind.avance_total_real ?? ind.avance ?? 0}%`),
        campo('Meta final', ind.meta_final_2029),
        campo('Tipo de cálculo', ind.tipo_calculo),
        ...tablaPeriodos(ind.periodos ?? []),
    ];

    // Campos cualitativos del último periodo con datos
    const periodosConDatos = (ind.periodos ?? []).filter(
        (p) => p.resultados_alcanzados || p.logros || p.alertas || p.justificacion_retrasos
    );
    for (const p of periodosConDatos) {
        bloques.push(new Paragraph({ spacing: { before: 120, after: 40 }, children: [new TextRun({ text: `Corte ${p.periodo}`, bold: true, italics: true })] }));
        if (p.resultados_alcanzados) bloques.push(campo('Resultados alcanzados', p.resultados_alcanzados));
        if (p.logros)                bloques.push(campo('Logros', p.logros));
        if (p.alertas)               bloques.push(campo('Alertas', p.alertas));
        if (p.justificacion_retrasos) bloques.push(campo('Justificación de retrasos', p.justificacion_retrasos));
    }

    // Evidencias
    if (ind.evidencias?.length) {
        bloques.push(new Paragraph({ spacing: { before: 100, after: 40 }, children: [new TextRun({ text: 'Evidencias adjuntas:', bold: true })] }));
        for (const ev of ind.evidencias) {
            bloques.push(new Paragraph({
                spacing: { before: 40, after: 20 },
                children: [
                    new TextRun({ text: `• ${ev.nombre_original}` }),
                    new TextRun({ text: `  [${ev.estado}]`, color: ev.estado === 'Aprobado' ? '0D9488' : ev.estado === 'Rechazado' ? 'EF4444' : '3B82F6' }),
                    new TextRun({ text: `  ${ev.url}`, color: '6B7280' }),
                ],
            }));
        }
    }

    return bloques;
}

// ── Sección de una acción ─────────────────────────────────────────────────────

function seccionAccion(accion, indicadores) {
    return [
        h2(`Acción: ${accion.codigo} · ${accion.nombre}`),
        campo('Responsable', accion.responsable),
        campo('Avance', `${accion.avance ?? 0}%`),
        campo('Presupuesto asignado', formatCOP(accion.presupuesto)),
        campo('Presupuesto ejecutado', formatCOP(accion.presupuesto_ejecutado)),
        ...indicadores.flatMap((ind) => seccionIndicador(ind)),
        separador(),
    ];
}

// ── Generador principal ───────────────────────────────────────────────────────

async function generarInformeProyecto({ proyecto, acciones, indicadoresPorAccion }) {
    const children = [
        new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 300 },
            children: [new TextRun({ text: 'Informe de Avance — Proyecto PDI', bold: true, size: 36 })],
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
            seccionAccion(acc, indicadoresPorAccion[String(acc._id)] ?? [])
        ),
    ];

    const doc = new Document({ sections: [{ properties: {}, children }] });
    const buffer = await Packer.toBuffer(doc);
    const filename = `informe_proyecto_${sanitize(proyecto.codigo)}_${crypto.randomBytes(6).toString('hex')}.docx`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    return { filename, url: buildUrl(filename) };
}

async function generarInformeMacro({ macro, proyectos, accionesPorProyecto, indicadoresPorAccion }) {
    const children = [
        new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 300 },
            children: [new TextRun({ text: 'Informe de Avance — Macroproyecto PDI', bold: true, size: 36 })],
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
            children.push(...seccionAccion(acc, indicadoresPorAccion[String(acc._id)] ?? []));
        }
    }

    const doc = new Document({ sections: [{ properties: {}, children }] });
    const buffer = await Packer.toBuffer(doc);
    const filename = `informe_macro_${sanitize(macro.codigo)}_${crypto.randomBytes(6).toString('hex')}.docx`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
    return { filename, url: buildUrl(filename) };
}

module.exports = { generarInformeProyecto, generarInformeMacro, UPLOAD_DIR, buildUrl };
