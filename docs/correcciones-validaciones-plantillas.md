# Correcciones de validaciones de reportes de plantillas

Se atendieron los hallazgos del informe de validaciones del 22 de octubre de 2026. Las reglas se aplican en el controlador de validación que utiliza la carga definitiva de plantillas, tanto para una hoja como para libros con varias hojas. El saneamiento de campos también entrega las reglas a los formularios y a las descargas de Excel, incluidos los snapshots publicados. No se necesita una migración de registros para aplicar estas reglas al validar o consultar plantillas.

| Hallazgo | Comportamiento implementado o verificado |
| --- | --- |
| FECHA_INICIO y FECHA_FINAL | Fechas de calendario válidas con DD/MM/AAAA o DD/MM/AA; los años de dos dígitos se interpretan como 2000–2099. Se conservan las fechas nativas de Excel que llegan como ISO. Se rechazan fechas escritas con palabras y fechas imposibles. |
| DESCRIPCION_ACTIVIDAD | Acepta texto libre con letras, números y puntuación (comas, dos puntos, comillas, guiones y guion bajo), aunque la configuración anterior indique contenido alfabético. Conserva el límite de longitud y la obligatoriedad. La descarga de Excel utiliza validación de longitud para este campo. |
| ID_TIPO_ACTIVIDAD_BIENESTAR | Los códigos y las etiquetas se contrastan con el catálogo; la longitud del código no se aplica a la etiqueta completa. |
| ID_FUENTE_NACIONAL | Mismo tratamiento de catálogo. No se aceptan posiciones de fila como sustituto del código ni etiquetas inventadas con un prefijo válido. |
| Financiación internacional | ID_PAIS_FINANCIADOR y los nombres de entidad NOMBRE_ENTIDAD_FTE_INTERNACIONAL / NOMBRE_ENTIDAD_FTE_INTERNAC aceptan 0 cuando no aplica. Los dos nombres de entidad también aceptan N/A y nombres con puntuación, conservando longitud y obligatoriedad. Las listas de los formularios y del Excel incluyen las alternativas correspondientes. N/A no se habilita para códigos de país. |
| País de institución asociada | Exige código numérico; una etiqueta completa solo se acepta si tiene código numérico y coincide con una opción registrada. |
| OTRAS_ACTIVIDADES_COOPERACIÓN | Solo S o N, con lista desplegable e indicación explícita. Rechaza descripciones, Sí/No e índices numéricos. |
| País extranjero | ID_PAIS_EXTRANJERO rechaza 170 y 170 - Colombia independientemente del nombre de la plantilla, incluidas hojas MOV_ESTUD_HACIA_COLOMBIA. La importación muestra el error de país junto con los de obligatoriedad. Los desplegables excluyen Colombia; la descarga sin catálogo aplica una regla que bloquea 170. Se conservan los códigos de otros países y no se aplica esta exclusión a ID_PAIS_FINANCIADOR. |
| Actualización de validadores | Los campos y sus controles forman una misma fila. Arrastrar mueve todos sus valores; eliminar afecta a esa fila. Se eliminan los desplazamientos calculados por separado que desalineaban los botones. |

La importación de Excel conserva el texto original de las fechas y evita convertir valores como 123abc en 123 antes de validarlos. Las listas se siguen verificando en el servidor, independientemente de la validación de celdas de Excel. Se conserva el flujo de borradores existente.

Los campos alfabéticos admiten letras, tildes, espacios, puntuación y símbolos, incluidos puntos de razones sociales, comas, comillas rectas o tipográficas, guiones Unicode, paréntesis, barras y ampersand. Siguen rechazando números. Los campos alfanuméricos admiten también números y separadores como guion bajo. Esta regla es general y no depende del nombre del campo; se mantienen la longitud máxima, la obligatoriedad, los catálogos y las reglas específicas de fechas, códigos numéricos y S/N. El Excel descargable incluye estas reglas tanto para campos configurados explícitamente como para los que obtienen su tipo del comentario.

## Verificación

En Back_Miro: `npm test`.

En Front_Miro: `npm run test:templates`, `npx tsc --noEmit --incremental false` y ESLint sobre los archivos modificados.

Las pruebas incluyen el controlador real con servicios externos aislados y una escritura/lectura de Excel para verificar las reglas de descarga. No equivalen a una sesión completa en navegador con usuarios, base de datos y servicios de producción.
