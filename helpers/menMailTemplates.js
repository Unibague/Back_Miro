/**
 * Mensajes predeterminados del Buzón MEN: textos por defecto, tabla de fechas
 * del proceso y armado del HTML final a partir de las variables {{...}}.
 */

const PLANTILLAS_DEFECTO = {
  responsables: {
    asunto: 'Fechas del proceso {{tipo}} – {{programa}}',
    cuerpo: `Reciban un cordial saludo.

Con el propósito de facilitar la planeación y el cumplimiento oportuno de los compromisos del programa, nos permitimos recordar las fechas establecidas para el vencimiento de {{proceso}} y la entrega del informe y formatos correspondientes a su proceso de renovación.

{{tabla}}

De acuerdo con el procedimiento institucional, es necesario programar una reunión inicial para socializar la información general, los formatos correspondientes y definir conjuntamente el cronograma de trabajo.

Quedamos atentos a cualquier inquietud y a la coordinación de este espacio.

Cordialmente,`,
  },
  administradores: {
    asunto: 'Recordatorio: el {{fecha_inicio}} inicia el proceso {{tipo}} de {{programa}}',
    cuerpo: `Cordial saludo.

Le recordamos que en {{dias}} días, el {{fecha_inicio}}, inicia el proceso de renovación de {{proceso}} del programa {{programa}}. Ese día se enviará automáticamente al programa y a su línea (área, escuela y facultad) el recordatorio con las fechas establecidas.

Estas son las fechas del proceso, incluida la radicación de la solicitud:

{{tabla}}

Le sugerimos preparar la reunión inicial con el programa para socializar la información general, los formatos correspondientes y el cronograma de trabajo.

Cordialmente,`,
  },
};

/** Días de anticipación con que llega el aviso al administrador antes de la fecha de inicio. */
const DIAS_AVISO_ADMIN = 15;

/** Variables que admite cada plantilla (se muestran como ayuda al editar). */
const VARIABLES = {
  responsables: {
    '{{programa}}': 'Nombre del programa',
    '{{tipo}}': 'Tipo de proceso: AV o RC',
    '{{proceso}}': '«la acreditación en alta calidad» o «el registro calificado»',
    '{{tabla}}': 'Tabla con las fechas del proceso del programa',
  },
  administradores: {
    '{{programa}}': 'Nombre del programa',
    '{{tipo}}': 'Tipo de proceso: AV o RC',
    '{{proceso}}': '«la acreditación en alta calidad» o «el registro calificado»',
    '{{fecha_inicio}}': 'Fecha de inicio del proceso',
    '{{dias}}': `Días que faltan para el inicio (${DIAS_AVISO_ADMIN})`,
    '{{tabla}}': 'Tabla con las fechas del proceso, incluida la radicación',
  },
};

const NOMBRE_PROCESO = { AV: 'la acreditación en alta calidad', RC: 'el registro calificado' };

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 'YYYY-MM-DD' → '30-jul-2029' (como en el formato institucional) */
const formatFecha = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}-${MESES[Number(m[2]) - 1]}-${m[1]}` : '—';
};

/** Meses entre una fecha y el vencimiento (lo que muestra el encabezado «N meses antes») */
const mesesAntes = (fecha, vencimiento) => {
  const a = /^(\d{4})-(\d{2})/.exec(String(fecha ?? ''));
  const b = /^(\d{4})-(\d{2})/.exec(String(vencimiento ?? ''));
  if (!a || !b) return null;
  const meses = (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
  return meses > 0 ? meses : null;
};

const TH = 'border:1px solid #9aa5b1;padding:6px 8px;font-weight:bold;text-align:center;vertical-align:middle;';
const TD = 'border:1px solid #9aa5b1;padding:6px 8px;vertical-align:bottom;';
const COLOR = {
  base: 'background:#1f3864;color:#ffffff;',
  vencimiento: 'background:#ffff00;color:#000000;',
  inicio: 'background:#b8cce4;color:#000000;',
  documento: 'background:#ccc0da;color:#000000;',
  radicacion: 'background:#c6efce;color:#000000;',
};

const conMeses = (texto, meses) => (meses ? `${texto} (${meses} meses antes vencimiento)` : texto);

/* ── Ejemplo de la plantilla: en lugar de datos reales muestra qué va en cada lugar ── */
const ESTILO_EJEMPLO = 'color:#6b7280;font-style:italic;font-weight:normal;';
const marcador = (texto) => `<span style="${ESTILO_EJEMPLO}">[${escapeHtml(texto)}]</span>`;

const FILA_EJEMPLO = {
  nivel: 'Nivel',
  snies: 'SNIES',
  programa: 'Nombre del programa',
  tipo_proceso: 'AV / RC',
  fecha_vencimiento: 'Fecha de vencimiento',
  fecha_inicio: 'Fecha de inicio',
  fecha_documento_par: 'Fecha documento Vicerrectoría',
  fecha_radicado_men: 'Fecha de radicación',
};

const VARIABLES_EJEMPLO = {
  programa: 'Nombre del programa',
  tipo: 'AV / RC',
  proceso: 'la acreditación en alta calidad / el registro calificado',
  fecha_inicio: 'Fecha de inicio',
  dias: 'Días',
};

/**
 * Tabla de fechas de un proceso, con los meses antes del vencimiento en cada
 * encabezado. Con radicacion (solo el aviso al administrador) agrega la
 * fecha de radicación de la solicitud.
 * fila = { nivel, snies, programa, tipo_proceso, fecha_vencimiento,
 *          fecha_inicio, fecha_documento_par, fecha_radicado_men }
 */
const tablaFechas = (fila, { radicacion = false, ejemplo = false } = {}) => {
  const tipo = ` ${fila.tipo_proceso || ''}`;
  // En el ejemplo los meses dependen de cada proceso: se indica con «N»
  const meses = (campo) => (ejemplo ? 'N' : mesesAntes(fila[campo], fila.fecha_vencimiento));
  const encabezados = [
    ['Nivel', COLOR.base],
    ['SNIES', COLOR.base],
    ['Programa', COLOR.base],
    [`Año vencimiento${tipo}`, COLOR.vencimiento],
    [conMeses(`Iniciación proceso${tipo}`, meses('fecha_inicio')), COLOR.inicio],
    [conMeses('Documento para revisión Vicerrectoría', meses('fecha_documento_par')), COLOR.documento],
    ...(radicacion ? [[conMeses(`Radicación solicitud${tipo}`, meses('fecha_radicado_men')), COLOR.radicacion]] : []),
  ];

  const texto = (valor, { mayus = false } = {}) => (ejemplo
    ? marcador(valor)
    : escapeHtml(mayus ? String(valor || '').toUpperCase() : (valor || '—')));
  const fecha = (valor) => `<td style="${TD}text-align:right;font-weight:bold;">${ejemplo ? marcador(valor) : formatFecha(valor)}</td>`;

  return `
    <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin:6px 0;width:100%;max-width:820px;">
      <thead><tr>${encabezados.map(([t, c]) => `<th style="${TH}${c}">${escapeHtml(t)}</th>`).join('')}</tr></thead>
      <tbody>
        <tr>
          <td style="${TD}">${texto(fila.nivel)}</td>
          <td style="${TD}text-align:center;">${texto(fila.snies)}</td>
          <td style="${TD}">${texto(fila.programa, { mayus: true })}</td>
          ${fecha(fila.fecha_vencimiento)}
          ${fecha(fila.fecha_inicio)}
          ${fecha(fila.fecha_documento_par)}
          ${radicacion ? fecha(fila.fecha_radicado_men) : ''}
        </tr>
      </tbody>
    </table>`;
};

const reemplazar = (texto, variables) =>
  Object.entries(variables).reduce((t, [k, v]) => t.split(`{{${k}}}`).join(v), String(texto ?? ''));

/**
 * Arma asunto y HTML. El cuerpo es texto plano (se escapa y se respetan los
 * saltos de línea); {{tabla}} se reemplaza por la tabla. Si la plantilla no
 * trae {{tabla}}, la tabla se agrega al final para que las fechas no se pierdan.
 */
const renderPlantilla = ({ asunto, cuerpo }, variables, tablaHtml, { ejemplo = false } = {}) => {
  const vars = Object.fromEntries(Object.entries(variables).map(([k, v]) => [k, String(v ?? '')]));
  const varsHtml = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, ejemplo ? marcador(v) : escapeHtml(v)]));
  if (ejemplo) Object.keys(vars).forEach((k) => { vars[k] = `[${vars[k]}]`; });

  let html = reemplazar(escapeHtml(cuerpo), varsHtml);
  html = html.includes('{{tabla}}') ? html.split('{{tabla}}').join(tablaHtml) : `${html}\n${tablaHtml}`;
  // Saltos de línea → <br>, sin romper el HTML de la tabla
  html = html.split(tablaHtml).map((parte) => parte.replace(/\r?\n/g, '<br>')).join(tablaHtml);

  return {
    asunto: reemplazar(asunto, vars).trim(),
    html: `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #212529; line-height: 1.5;">${html}</div>`,
  };
};

module.exports = {
  PLANTILLAS_DEFECTO,
  VARIABLES,
  NOMBRE_PROCESO,
  DIAS_AVISO_ADMIN,
  FILA_EJEMPLO,
  VARIABLES_EJEMPLO,
  escapeHtml,
  formatFecha,
  tablaFechas,
  renderPlantilla,
};
