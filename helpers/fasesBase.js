/* Fases y actividades predefinidas — compartidas para RC, AV y PM */
const FASES_PREDEFINIDAS = [
  {
    numero: 0, nombre: 'Apertura',
    actividades: [
      { nombre: 'Definición de alertas para renovación o nuevos programas',                               responsables: 'Consejo Superior, Rector, Secretario Académico' },
      { nombre: 'Capacitación sobre el sentido del proceso',                                              responsables: 'Vicerrectoría' },
      { nombre: 'Reunión inicial con Decano, Programa, Secretario Académico y Analista de Vicerrectoría', responsables: 'Decano(a), Programa, Secretario Académico, Analista Vicerrectoría' },
      { nombre: 'Definición de agenda y cronograma del proceso',                                          responsables: 'Programa, Decano(a), Secretario Académico' },
      { nombre: 'Capacitación en herramienta MIRO',                                                      responsables: 'Vicerrectoría' },
    ],
  },
  {
    numero: 1, nombre: 'Preparación',
    actividades: [
      { nombre: 'Entrega de información, documentos y formatos (SACES, CNA)',                             responsables: 'Programa' },
      { nombre: 'Construcción del documento maestro o informe de autoevaluación',                         responsables: 'Programa, Decano(a)' },
      { nombre: 'Reuniones periódicas de seguimiento',                                                    responsables: 'Secretario Académico, Analista Vicerrectoría' },
      { nombre: 'Revisión y aval del Decano(a)',                                                          responsables: 'Decano(a)' },
      { nombre: 'Revisión Analista de Vicerrectoría',                                                    responsables: 'Analista Vicerrectoría' },
      { nombre: 'Aprobación del documento por Vicerrector',                                               responsables: 'Vicerrector' },
    ],
  },
  {
    numero: 2, nombre: 'Estructuración',
    actividades: [
      { nombre: 'Formulación del plan de mejoramiento',                                                   responsables: 'Programa, Decanatura' },
      { nombre: 'Identificación de proyectos con viabilidad financiera',                                  responsables: 'Programa, Planeación' },
      { nombre: 'Revisión y aval Consejo de Facultad',                                                    responsables: 'Consejo de Facultad' },
      { nombre: 'Revisión por Vicerrectoría / Planeación',                                                responsables: 'Vicerrectoría, Planeación' },
    ],
  },
  {
    numero: 3, nombre: 'Verificación y Formalización',
    actividades: [
      { nombre: 'Montaje en plataforma (SACES/CNA)',                                                      responsables: 'Secretario Académico, Analista Vicerrectoría' },
      { nombre: 'Radicación en debida forma',                                                             responsables: 'Vicerrectoría' },
      { nombre: 'Confirmación de completitud',                                                            responsables: 'MEN, Vicerrectoría' },
    ],
  },
  {
    numero: 4, nombre: 'Radicación',
    actividades: [
      { nombre: 'Radicación oficial en plataforma',                                                       responsables: 'Secretario Académico' },
      { nombre: 'Gestión de requerimientos de información complementaria',                                responsables: 'Programa, Decano(a), Analista Vicerrectoría' },
      { nombre: 'Elaboración y radicación de respuestas',                                                 responsables: 'Programa, Decano(a), Rector, Vicerrector' },
    ],
  },
  {
    numero: 5, nombre: 'Evaluación',
    actividades: [
      { nombre: 'Visita de pares académicos (si aplica)',                                                 responsables: 'MEN, Pares Académicos' },
      { nombre: 'Revisión de informe de pares',                                                           responsables: 'Rector, Vicerrector' },
      { nombre: 'Acto administrativo (Resolución)',                                                       responsables: 'MEN' },
      { nombre: 'Decisión institucional frente al programa',                                              responsables: 'Consejo Académico, Rectoría' },
    ],
  },
  {
    numero: 6, nombre: 'Plan de Mejoramiento',
    actividades: [
      { nombre: 'Consolidación del plan de mejoramiento ajustado',                                        responsables: 'Programa, Planeación' },
      { nombre: 'Aprobación del Consejo Académico',                                                       responsables: 'Consejo Académico' },
      { nombre: 'Radicación del plan ante CNA',                                                           responsables: 'Secretario Académico' },
      { nombre: 'Seguimiento y evaluación del plan',                                                      responsables: 'Vicerrectoría, Programa' },
      { nombre: 'Radicación de informe de avance al CNA',                                                 responsables: 'Vicerrectoría' },
    ],
  },
];

module.exports = FASES_PREDEFINIDAS;
