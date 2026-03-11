/* Fases y actividades predefinidas para procesos AV (Acreditación Voluntaria) */
const FASES_BASE_AV = [
  {
    numero: 0, nombre: 'Apertura',
    actividades: [
      { nombre: 'Notificación de la apertura del proceso para solicitud de renovación de registro calificado',                           responsables: 'Analista de calidad de Vicerrectoría' },
      { nombre: 'Notificación de aval del Consejo Superior para solicitud por primera vez o no renovación de la acreditación de calidad voluntaria', responsables: 'Consejo Superior, Rector(a), Vicerrector(a) y Decano(a)' },
    ],
  },
  {
    numero: 1, nombre: 'Preparación',
    actividades: [
      { nombre: 'Reunión inicial: capacitación sobre el sentido del proceso y uso de la plataforma Miró, lineamientos y plantillas', responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico) y analista de calidad de Vicerrectoría' },
      { nombre: 'Preparación interna del programa',             responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico)' },
      { nombre: 'Definición de agenda y cronograma de trabajo', responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico) y analista de calidad de Vicerrectoría' },
    ],
  },
  {
    numero: 2, nombre: 'Estructuración',
    actividades: [
      { nombre: 'Construcción del documento maestro, anexos, plan de mejoramiento, plantillas y cuadros CNA',                                                                    responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico)' },
      { nombre: 'Reuniones parciales de avance',                                                                                                                                  responsables: 'Decano(a), Director(a) de escuela, coordinador(a) de área (programa académico) y analista de calidad de Vicerrectoría' },
      { nombre: 'Revisión y aval de decanatura: versión final de los documentos',                                                                                                 responsables: 'Decano(a)' },
      { nombre: 'Entrega 1: documento maestro, enlace drive, tabla de anexos, plan de mejoramiento, plantillas y cuadros CNA',                                                    responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico)' },
      { nombre: 'Entrega 2: documentos pestañas CNA, versión ajustada del documento maestro, drive y tabla de anexos, plan de mejoramiento, plantillas y cuadros CNA',           responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico)' },
    ],
  },
  {
    numero: 3, nombre: 'Verificación y Formalización',
    actividades: [
      { nombre: 'Revisión general de los documentos', responsables: 'Analista de calidad de Vicerrectoría' },
      { nombre: 'Aprobación de los documentos',       responsables: 'Vicerrector(a), analista de calidad de Vicerrectoría' },
    ],
  },
  {
    numero: 4, nombre: 'Radicación',
    actividades: [
      { nombre: 'Montaje en plataforma SACES CNA',                                responsables: 'Auxiliar administrativo de Vicerrectoría' },
      { nombre: 'Notificación de confirmación de radicación en plataforma',       responsables: 'Analista de calidad de Vicerrectoría' },
    ],
  },
  {
    numero: 5, nombre: 'Evaluación',
    actividades: [
      { nombre: 'Completitud',                                                              responsables: '' },
      { nombre: 'Notificación de solicitud de completitud',                                 responsables: 'MEN, analista de calidad de Vicerrectoría' },
      { nombre: 'Reunión para revisión de las observaciones de la completitud',             responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico), Vicerrector(a) y analista de calidad de Vicerrectoría' },
      { nombre: 'Elaboración de respuesta de la completitud',                               responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico)' },
      { nombre: 'Revisión y aval de decanatura a la respuesta de la completitud',          responsables: 'Decano(a)' },
      { nombre: 'Revisión y aval de vicerrectoría a la respuesta de la completitud',       responsables: 'Analista de calidad de Vicerrectoría' },
      { nombre: 'Radicación y notificación de respuesta de completitud en plataforma',     responsables: 'Analista de calidad y auxiliar administrativo de Vicerrectoría' },
      { nombre: 'Visita de pares académicos',                                               responsables: '' },
      { nombre: 'Notificación de la visita de pares académicos',                           responsables: 'MEN, analista de calidad de Vicerrectoría' },
      { nombre: 'Coordinar la agenda y visita de pares',                                   responsables: 'Analista de calidad de Vicerrectoría, decano(a)' },
      { nombre: 'Evaluación de visita de pares',                                           responsables: 'Decano(a), analista de calidad de Vicerrectoría' },
      { nombre: 'Notificación del informe de pares para comentarios del Rector',           responsables: 'Analista de calidad de Vicerrectoría' },
      { nombre: 'Elaboración de respuesta a informe de pares',                             responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico)' },
      { nombre: 'Revisión y aval de decanatura a la respuesta a informe de pares',        responsables: 'Decano(a)' },
      { nombre: 'Revisión y aval de vicerrectoría a la respuesta a informe de pares',     responsables: 'Rector(a), Vicerrector(a), analista de calidad de Vicerrectoría' },
      { nombre: 'Radicación de respuesta del informe de pares en plataforma',              responsables: 'Analista de calidad de Vicerrectoría' },
      { nombre: 'Notificación del acto administrativo',                                    responsables: 'MEN, analista de calidad de Vicerrectoría' },
      { nombre: 'Recurso de reposición en caso no satisfactorio',                          responsables: 'Rector(a), Vicerrector(a), Decano(a), director(a) de escuela, coordinador(a) de área (programa académico) y analista de calidad de Vicerrectoría' },
      { nombre: 'Radicación del recurso de reposición',                                    responsables: 'Analista de calidad de Vicerrectoría' },
    ],
  },
  {
    numero: 6, nombre: 'Plan de Mejoramiento',
    actividades: [
      { nombre: 'Reunión inicial: socialización de lineamientos internos y externos, entrega de plantilla', responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico), Dirección de Planeación y analista de Vicerrectoría' },
      { nombre: 'Consolidación del plan de mejoramiento',                      responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico)' },
      { nombre: 'Revisión y aval del Consejo de Facultad',                     responsables: 'Decano(a)' },
      { nombre: 'Revisión y aval de viabilidad financiera',                    responsables: 'Gerente de Servicios y Sostenibilidad, Director(a) Administrativo y Financiero y Decano(a)' },
      { nombre: 'Revisión y aval del equipo de aseguramiento de la calidad',   responsables: 'Vicerrectoría y Dirección de Planeación' },
      { nombre: 'Aprobación del Consejo Académico',                            responsables: 'Decano(a)' },
      { nombre: 'Radicación en plataforma CNA',                                responsables: 'Auxiliar administrativo de Vicerrectoría' },
      { nombre: 'Seguimiento y evaluación del cumplimiento de acciones',       responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico), Vicerrectoría, Dirección de Planeación' },
      { nombre: 'Elaboración de informe de avance',                            responsables: 'Decano(a), director(a) de escuela, coordinador(a) de área (programa académico)' },
      { nombre: 'Radicación de informe de avance en plataforma CNA',           responsables: 'Auxiliar administrativo de Vicerrectoría' },
      { nombre: 'Notificación y coordinación de la visita de seguimiento y evaluación', responsables: 'MEN, analista de calidad de Vicerrectoría' },
      { nombre: 'Notificación del aval de aprobación del informe de avance del plan de mejoramiento', responsables: 'MEN, analista de calidad de Vicerrectoría' },
    ],
  },
];

module.exports = FASES_BASE_AV;
