/* Fase única para procesos PM (Plan de Mejoramiento) creados al cerrar AV o AE.
   Contiene las actividades que antes formaban la Fase 6 de la Acreditación Voluntaria. */
const FASES_BASE_PM = [
  {
    numero: 1, nombre: 'Plan de Mejoramiento',
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

module.exports = FASES_BASE_PM;
