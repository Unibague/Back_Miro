# Importación de PQR desde Excel

En **Comunicaciones MEN → Importar PQR desde Excel**, selecciona un `.xlsx` de hasta 5 MB y pulsa **Revisar archivo**. Revisa los avisos, selecciona las solicitudes nuevas y, cuando corresponda, asigna su programa académico. Pulsa **Importar N PQR** para guardarlas.

Se reconocen los encabezados del formato PQR MEN, aunque cambien de orden, espacios o tildes: Solicitud, Fecha de radicación, Hora, Número de radicado, Que medio x cual se realizo, Fecha de la respuesta, Observación/Respuesta y Link Respuesta. La columna Cédula del encargado es opcional; también se reconoce una cédula explícita en el medio (`c.c.` o una línea que contiene únicamente la cédula).

- Los nuevos registros quedan activos. Tener respuesta no implica que la gestión esté cerrada.
- Los registros existentes, activos o cerrados, se omiten por radicado. No se actualizan sus datos con el Excel.
- Sin radicado válido se compara la descripción y la fecha de radicación. Si tampoco hay una fecha válida, hay que corregir el archivo.
- Las filas repetidas con datos compatibles se agrupan y conservan todos sus enlaces. Las diferencias entre datos o los grupos parcialmente coincidentes se señalan como errores para corregir en el Excel.
- Las fechas se guardan como `AAAA-MM-DD` y las horas en formato de 24 horas. Si una celda contiene varias fechas, se usa la más reciente con un aviso. El texto original sigue disponible.
- Los enlaces HTTP/HTTPS se pueden abrir. Las rutas locales se conservan como referencia: el Excel no contiene los PDF y hay que adjuntarlos desde Documentos del PQR.
- El Excel no tiene una columna de programa. El usuario puede asignarlo en la vista previa; sin selección, se guarda como MEN directo.

Los datos originales y enlaces se consultan en **Documentos del PQR** y, después de cerrar el registro, en **Datos y enlaces del Excel** en el historial. No se modifica el archivo de origen.

## API y verificación

`POST /pqr/importar/preview`: multipart con `file`; analiza el archivo y consulta coincidencias, sin guardar registros.

`POST /pqr/importar`: mismo archivo y campo `seleccion` con JSON `[{ "key": "clave de la vista previa", "programa_id": null }]`. El servidor vuelve a analizar y validar el archivo, los programas y las coincidencias. Devuelve creados, omitidos, errores por fila y los nuevos PQR. Los errores de una fila no se presentan como éxito; se puede volver a revisar/importar para reintentar los pendientes.

El índice único disperso `importacion_clave` evita duplicados al reintentar o importar concurrentemente el mismo conjunto de radicados. No requiere cambiar registros anteriores. El límite es de 2.000 filas de datos por importación.

Pruebas: `node --test tests/pqrImport.test.js`. Las pruebas HTTP usan una base simulada y no escriben en la base de datos de la aplicación.
