# Problema actual 1: Spreadsheet Viewer deja la tabla vacía y Recargar no responde

**Fecha de preparación:** 2026-10-09  
**Proyecto:** extensión de VS Code `Spreadsheet Viewer`  
**Propósito:** transferir el historial técnico y la evidencia disponible a otro modelo para que diagnostique por qué la extensión dejó de funcionar.

## Resumen del problema actual

En una ventana titulada **Extension Development Host** con el workspace `test_folder`, al abrir `ciudades_dummy.csv` con Spreadsheet Viewer la interfaz HTML aparece, pero la tabla permanece vacía. El texto de estado se queda en **«Cargando archivo…»**, no se muestra una selección y no se ven filas ni columnas. El botón **Recargar** aparece en la interfaz, pero el usuario informa que no hace nada. No se muestra el toast **«Recargando»** que se añadió después.

El usuario pidió crear, al pulsar Recargar, un archivo `debug_spreadsheetviewer_<fechahora>.txt` e ir agregando cada fase. La implementación actual crea el archivo únicamente cuando el extension host recibe el mensaje `reloadFile` del webview. El usuario confirmó que al pulsar Recargar no aparece el toast y no se crea el archivo.

La ausencia del archivo no distingue todavía entre estos casos: el JavaScript del webview no corre; el listener del botón no corre; el mensaje no llega al extension host; o falla la escritura. El logger captura fallos de escritura en `console.error`, pero no tiene un mecanismo alterno para crear el archivo si la propia vista no puede enviar mensajes.

## Estado visible y evidencia

La última captura compartida muestra:

- Título de VS Code: **[Extension Development Host] test_folder**.
- Pestaña activa: `ciudades_dummy.csv`, abierta como editor de Spreadsheet Viewer.
- Workspace Explorer con `csv_test_files/ciudades_dummy.csv`, `ods_test_files/ciudades_dummy.ods` y `xlsx_test_files/ciudades_dummy.xlsx`.
- Encabezado de la vista con `ciudades_dummy.csv` y **«Cargando archivo…»**.
- Estado **«Sin cambios»** y botón **↻ Recargar**.
- Referencia de celda `B54` como placeholder, **«Sin selección»**, editor de valor vacío y área de tabla vacía.
- No aparece un toast ni un mensaje de error de carga.

La ruta del CSV encontrada en los registros de VS Code es:

`/Users/samuelurias/code/evimus/file_counter/test_folder/csv_test_files/ciudades_dummy.csv`

Se buscó `debug_spreadsheetviewer_*.txt` en la raíz de `test_folder` y no se encontró archivo. Esto concuerda con lo que reporta el usuario. Es evidencia de que no se alcanzó la creación del archivo en esa ubicación; no demuestra por sí sola qué parte del canal falló.

## Historia funcional del proyecto

La secuencia siguiente se reconstruye a partir de esta conversación. El repositorio no ofrece un historial Git útil para atribuir cada cambio: `git status --short` muestra los archivos del proyecto como no rastreados (`??`), incluyendo `src/`, `package.json`, `planning.md` y `README.md`.

1. Se creó `planning.md` para el MVP y se desarrollaron las etapas de implementación de forma incremental. La funcionalidad base se implementó como custom editor de VS Code, con una interfaz de tabla en webview.
2. Se añadieron apertura contextual desde Explorer, lectura CSV/XLSX, pestañas de editor, selección/navegación, búsqueda, cambio de hoja XLSX, edición y guardado.
3. Hubo regresiones de navegación y scroll vertical/horizontal: al desplazar la vista regresaba al inicio. Se corrigió y el usuario confirmó que ambos scrolls funcionaron. También confirmó la navegación por flechas.
4. Las etapas posteriores cubrieron errores, referencia de celda, serialización, cambios externos y otros casos del plan. El usuario probó manualmente CSV y XLSX, edición, guardado, búsqueda, cambio de hojas, resultados repetidos/sin coincidencias, navegación con flechas y referencias de columnas posteriores a Z. Probó hasta la columna DP. También confirmó que un cambio externo al archivo recarga la vista.
5. Se añadió edición de celda con doble clic y guardado al perder foco. El usuario confirmó que probó esa edición.
6. Se incorporó redimensionamiento de columnas. Hubo un fallo y un error de guardado; tras correcciones, el usuario confirmó que las columnas sí se redimensionan y que el guardado volvió a funcionar.
7. Se pidió redimensionamiento de filas y se añadió al código. No consta en la conversación una confirmación manual posterior de esa parte.
8. El usuario pidió mostrar valores calculados de fórmulas XLSX además de la expresión y el valor almacenado en caché. Se integró Formualizer como cálculo de vista previa de fórmulas XLSX. El usuario respondió que el resultado visual le gustaba. El cálculo es solo para mostrar y no escribe valores calculados al libro.
9. Se incorporó soporte ODS como último cambio grande de formato. El usuario había probado CSV y XLSX; no consta una validación manual de ODS con LibreOffice.
10. Después del cambio ODS, el usuario reportó que la extensión dejó de funcionar: aparece la interfaz, pero no se carga la tabla y Recargar tampoco la recupera.

Antes de la regresión actual, el usuario informó que ya había validado gran parte del flujo en CSV y XLSX: edición/guardado, búsqueda (incluidas coincidencias repetidas y ninguna coincidencia), cambio entre hojas, navegación por flechas, scroll vertical/horizontal, columnas después de Z hasta DP, edición con doble clic, y recarga al detectar cambios externos. Esto confirma que esas rutas funcionaron en algún estado previo, pero no prueba que funcionen en el bundle actual.

## Cambios relacionados con la regresión y diagnósticos intentados

1. **Botón de recarga:** se añadió al encabezado del webview. La acción envía `{ type: 'reloadFile' }`; el extension host ejecuta `reloadFromDisk(document)`.
2. **Reintento del handshake:** se cambió el envío inicial `ready` para que ocurra inmediatamente y se repita hasta cinco veces, con intervalos de un segundo. Si el webview recibe datos CSV/XLSX, detiene el temporizador; si no, se espera que deje de mostrar «Cargando archivo…» y muestre una advertencia.
3. **Errores en el envío inicial:** se envolvió `postDocument` en `try/catch`; el error se registra en consola y se envían estados `reloadState:error` y `saveState:error` al webview.
4. **Errores de interfaz:** se añadieron handlers de `error` y `unhandledrejection` al bundle, y un handler bootstrap en HTML para reportar si no carga el script externo.
5. **CSP:** se modificó `script-src` para incluir `${webview.cspSource}` además del nonce y `'wasm-unsafe-eval'`, siguiendo el patrón de la documentación de VS Code. La hipótesis fue que el webview no cargaba `webview.js`. No se capturó una consola de webview que confirme bloqueo CSP ni se validó de forma concluyente que el cambio arregle la causa.
6. **Toast:** el handler del extension host muestra `vscode.window.showInformationMessage('Recargando')` y ejecuta también `withProgress` con título `Recargando`. El usuario informa que no ve el toast.
7. **Log por recarga:** al recibir `reloadFile`, el extension host crea un logger secuencial y escribe cada fase en un archivo nuevo bajo la raíz del workspace. El usuario informa que no aparece ningún archivo.
8. **Compilación:** después de estos cambios, `npm run compile` y `npm run compile-tests` pasaron. La compilación verifica tipos, lint y genera `dist/extension.js`, `dist/webview.js` y CSS. Pasar compilación no comprueba ejecución de JavaScript dentro del webview.
9. **Ventanas de desarrollo:** se abrió el CSV usando el CLI `code --new-window --extensionDevelopmentPath=...`; los registros de VS Code muestran activación de `undefined_publisher.spreadsheet-viewer` por `onCustomEditor:spreadsheet-viewer.editor`. No se pudo inspeccionar el DOM o la consola del webview en esa ejecución.

## Flujo técnico actual que debe analizarse

### Apertura del documento

- `package.json` declara el comando `spreadsheet-viewer.open`, el custom editor `spreadsheet-viewer.editor` y un selector con prioridad `option` para `.csv`, `.xlsx` y `.ods`.
- `src/extension.ts` registra `SpreadsheetEditorProvider` con `registerCustomEditorProvider` y registra el comando contextual.
- El comando llama a `provider.open(uri)`, que invoca `vscode.openWith` con el tipo `spreadsheet-viewer.editor`.
- `openCustomDocument` llama `SpreadsheetDocument.open(uri, backup)`, que lee el archivo y selecciona el parser por extensión.
- `resolveCustomEditor` guarda el panel en `this.panels`, configura `enableScripts: true`, define `localResourceRoots` apuntando a `dist`, registra `onDidReceiveMessage`, y al final asigna `panel.webview.html = this.getHtml(...)`.

### Carga de la interfaz

- `getHtml` construye el HTML con el nombre de archivo, estilos `dist/webview.css` y script `dist/webview.js` transformados con `webview.asWebviewUri`.
- La política actual incluye `default-src 'none'`, `connect-src ${webview.cspSource}`, `style-src ${webview.cspSource}` y `script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`.
- La etiqueta de estado inicial del HTML es `<p id="dimensions">Cargando archivo…</p>`.
- El código `src/webview/main.ts` debería adquirir la API de VS Code, registrar un listener `window.message`, registrar controles como Recargar, y al final invocar `requestInitialData()`, que envía `ready` y reintenta hasta cinco veces.
- El mensaje `ready` en `src/editor.ts` llama `postDocument(document, panel)` y envía `saveState`.
- Para CSV, `postDocument` produce un `csvData` con `rows`, `rowCount`, `columnCount` y `revision` usando `document.editSession.getRows(0)`.
- El webview valida estrictamente el esquema del mensaje. Si recibe un `csvData` inválido, debería mostrar un error; si no recibe ningún mensaje, el reintento inicial debería cambiar el estado tras cinco intentos.

### Recarga y archivo de diagnóstico

- El listener de Recargar en `src/webview/main.ts` deshabilita el botón, cambia el texto a `Recargando…`, actualiza el estado de la vista y envía `reloadFile` mediante `vscodeApi.postMessage`.
- El extension host recibe `reloadFile`, crea `debug_spreadsheetviewer_<ISO timestamp>.txt` en la raíz del workspace (fallback: raíz del primer workspace o carpeta del archivo), muestra el toast y llama `reloadFromDisk` bajo `withProgress`.
- La primera línea del archivo solamente se escribe al entrar a este handler. Por eso, sin mensaje recibido no se crea el archivo.
- `reloadFromDisk` anota: inicio; estado loading; cambios locales pendientes; espera de guardado previo; lectura de bytes; parseo/reemplazo del modelo; intento de reenvío de datos; estado final o excepción.
- La escritura se implementa con `vscode.workspace.fs.writeFile`; cada nueva línea lee el contenido existente y lo vuelve a escribir en una cola serial.
- Los errores de escritura del logger se atrapan e imprimen con `console.error`; no se muestran al usuario ni se escriben en un archivo alterno.

## Dependencias actuales

Las versiones resueltas por `npm ls --depth=0` al preparar este reporte:

| Dependencia | Versión resuelta | Uso conocido |
|---|---:|---|
| `papaparse` | 5.7.0 | Lectura/serialización CSV; se eligió después de que el usuario aprobó usar Papa Parse. En `package.json` figura `^5.7.0`. |
| `fflate` | 0.8.3 | ZIP en los formatos XLSX y ODS. |
| `@xmldom/xmldom` | 0.9.12 | Lectura y edición del XML interno XLSX/ODS. |
| `formualizer` | 0.10.1 | Cálculo de vista previa de fórmulas XLSX desde el webview; WASM incluido en el bundle de fórmula. Incluye licencias MIT y Apache-2.0 copiadas al directorio `dist`. |

No se usa una biblioteca general como SheetJS para leer XLSX en el código revisado; el proyecto contiene parsers propios en `src/formats/xlsx.ts` y `src/formats/ods.ts` sobre ZIP/XML.

## Errores y señales históricas de VS Code

Se inspeccionaron registros de la sesión local de VS Code. No todos corresponden necesariamente a la captura más reciente; se deben tratar como evidencia histórica, no atribuir automáticamente a la última acción.

- En `~/Library/Application Support/Code/logs/20261009T001142/window10/exthost/exthost.log` aparecen varias excepciones `Error: No custom document found` en sesiones anteriores. Las trazas apuntan a `SpreadsheetEditorProvider.applyEdit` y a mensajes recibidos del host. También hay un caso en `$disposeCustomDocument`. El código actual conserva un `CustomDocumentEditEvent` por edición y hay borradores de webview que se aplican al cerrar panel; revisar el ciclo de vida si es pertinente, pero no se ha demostrado que cause la carga vacía.
- En `window10/renderer.log`, a las 03:33 aparecen dos avisos de `UNRESPONSIVE extension host: 'undefined_publisher.spreadsheet-viewer'`; VS Code guardó perfiles en `/var/folders/m7/7mvk5lqd5s96sgwz9jwrrwhc0000gn/T/exthost-27f545.cpuprofile` y `exthost-674435.cpuprofile`. No se analizaron esos perfiles. No se ha comprobado que esta señal esté relacionada con el fallo actual.
- En sesiones posteriores (`window11`, `window12`, `window13`) VS Code registró activación del custom editor. No se encontró en las porciones revisadas un `console.error` del logger nuevo del estilo `Spreadsheet Viewer: no se pudo escribir el log...` ni `Spreadsheet Viewer: failed to send the document...`.
- Hay muchos `TypeError: Missing dataLength in event` en los logs de Extension Host relacionados con `node:inspector`, y errores de otra extensión (`Document ... not found in AST tracker`). No atribuirlos a Spreadsheet Viewer sin más evidencia.
- No se inspeccionó aún la consola específica del webview con **Developer: Open Webview Developer Tools**. Tampoco se capturó el HTML final/CSP en runtime ni el resultado de cargar la URL de `webview.js`.

## Qué se había confirmado como funcional

Confirmaciones del usuario antes de la regresión:

- CSV y XLSX abren y muestran los datos.
- Edición de celdas y guardado en disco funcionan.
- Búsqueda con coincidencias, coincidencias repetidas y sin coincidencias funciona.
- Navegación entre hojas XLSX funciona.
- Navegación con flechas y scroll vertical/horizontal funciona después de corregir un problema donde regresaban al inicio.
- Navegación a columnas posteriores a Z funciona; el usuario probó hasta DP.
- Cambios externos al archivo recargan la vista.
- Edición de celda mediante doble clic fue probada.
- El usuario confirmó el redimensionamiento de columnas.
- La presentación de fórmula en la vista previa se vio bien para su archivo de ejemplo tras incorporar Formualizer.

No asumir confirmadas por el usuario: soporte manual ODS, redimensionamiento de filas, compatibilidad general de fórmulas de Excel, y funcionamiento actual tras las últimas compilaciones.

## Qué no se ha podido verificar o resolver

- No se ha demostrado que `webview.js` actual sea el script ejecutado por el webview que muestra la captura.
- No se ha demostrado si el script alcanza la línea `requestInitialData()` ni si VS Code recibe `ready`.
- No se ha probado que el handler `reloadFile` se ejecute en la extensión durante el clic reportado.
- No se crea el archivo de debug y no aparece el toast, según el usuario.
- No se examinó la consola específica del webview ni el HTML final generado al ejecutarse `resolveCustomEditor`.
- La apertura por CLI de una ventana nueva sí mostró la activación del custom editor en registros, pero no fue posible observar el estado visible de esa ventana ni confirmar que el script JS funcionara.
- `npm run compile` y `npm run compile-tests` pasan, pero son chequeos estáticos/compilación; no prueban el webview en VS Code.
- En intentos anteriores, `npm test` no se completó de forma confiable: una ejecución con Node 18 falló por regex `/v` no soportada; otras intentaron descargar VS Code y fallaron por DNS (`ENOTFOUND update.code.visualstudio.com`); una tentativa con una instalación local terminó con `SIGABRT`. No hay una suite de integración de webview pasando que cubra el clic de Recargar.

## Archivos principales que debe revisar el siguiente modelo

- `package.json`: selector, comando, activación y scripts.
- `src/extension.ts`: registro del provider y comando `spreadsheet-viewer.open`.
- `src/editor.ts`: `resolveCustomEditor`, listener de mensajes, `getHtml`, CSP, `postDocument`, logger de debug y `reloadFromDisk`.
- `src/webview/main.ts`: listener de mensaje, listener del botón Recargar, handshake `ready`, temporizadores, validación CSV/XLSX y estado visual.
- `src/protocol.ts`: tipos de mensajes `ready`, `reloadFile`, `csvData`, `reloadState` y `saveState`.
- `src/document.ts`, `src/formats/csv.ts`, `src/edit-model.ts`: lectura y materialización del CSV antes de `postDocument`.
- `esbuild.js`: salida de `dist/extension.js` y `dist/webview.js`, chunks de fórmula y configuración de webpack.
- `dist/extension.js`, `dist/webview.js`, `dist/webview.css`: artefactos generados que efectivamente carga el extension host; verificar fechas, contenido y rutas contra el código fuente.
- `src/test/`: pruebas unitarias existentes; no contienen una prueba del webview real ni la ruta completa del click-reload.

## Preguntas de diagnóstico para el siguiente modelo

1. ¿La captura puede explicarse por una ventana/instalación de VS Code ejecutando artefactos viejos? Confirmar la ruta real de la extensión cargada, `context.extensionUri`, fecha/hash de `dist/webview.js`, URL runtime del script y cuál ventana tiene el extension host de depuración activo.
2. ¿Se está ejecutando el bundle del webview? Usar Developer Tools específico del webview y comprobar errores de carga del recurso, CSP, excepciones JS y si aparece el handshake `ready`.
3. ¿El botón genera un evento click y llama `vscodeApi.postMessage({ type: 'reloadFile' })`? Verificarlo directamente en el renderer y en `onDidReceiveMessage` del extension host.
4. Si el handler sí recibe `reloadFile`, ¿por qué no se crea el archivo de log? Verificar workspace URI/raíz, permisos, error de `workspace.fs.writeFile` y si la promesa se resuelve. Añadir registro accesible alterno solo si hace falta, sin ocultar fallos.
5. ¿El mensaje `ready` llega a `resolveCustomEditor`? Si llega, confirmar que `postDocument` construya un `csvData` válido y que `panel.webview.postMessage` resulte exitoso (`Thenable<boolean>`), no solo iniciar el envío.
6. ¿Hay un problema de carrera/ciclo de vida con `supportsMultipleEditorsPerDocument: false`, `retainContextWhenHidden: false`, paneles, documento custom o múltiples ventanas?
7. ¿Qué relación, si alguna, tienen los errores históricos `No custom document found` y los perfiles de extensión no responsiva con el fallo actual?
8. Después de encontrar causa, crear una prueba que verifique el flujo de inicio y Recargar en una instancia de VS Code, si el entorno de test lo permite; la compilación por sí sola no valida este comportamiento.

## Comandos y resultado reciente

Ejecutados después de las últimas modificaciones de código:

```text
npm run compile        PASS (tipos, lint y build)
npm run compile-tests  PASS (compilación de pruebas)
```

El usuario debe proporcionar al siguiente modelo también la captura actual si no tiene acceso directo a este workspace. La principal evidencia reproducible es: la vista de CSV queda en «Cargando archivo…»; pulsar Recargar no muestra toast y no crea el archivo debug solicitado.
