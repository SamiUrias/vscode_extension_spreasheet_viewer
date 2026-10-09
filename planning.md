# Spreadsheet Viewer — guía de implementación del MVP

## 1. Resumen del producto

Extensión para quienes inspeccionan y corrigen dumps y archivos tabulares sencillos en VS Code. Desde el Explorer, clic derecho en CSV/XLSX/ODS → **Visualizar en Spreadsheet** → pestaña de tabla asociada al archivo y movible entre grupos. Permite cambiar de hoja en libros XLSX/ODS, buscar, ir a una referencia, editar celdas y guardar en el original. La prioridad es conservar los datos crudos, sin reproducir el formato visual de las hojas ni transformar valores silenciosamente.

## 2. Alcance y límites

**Incluido en el MVP**

- Menú contextual únicamente para archivos CSV/XLSX/ODS; vista en el área de editores con nombre/URI de origen y reutilización de la vista abierta.
- Tabla editable con encabezados de fila/columna, referencia seleccionada y número de filas/columnas.
- Campo para ir a una celda; referencia inválida o fuera de rango produce notificación de VS Code con texto exacto **Celda inválida**, sin cambiar selección.
- Búsqueda en la hoja actual, navegación entre coincidencias e indicador de coincidencia actual/total cuando sea posible.
- Navegación entre hojas XLSX/ODS, sincronizando tabla, dimensiones, selección y búsqueda. CSV tiene una sola vista sin selector de hojas.
- Lectura del contenido actual de disco; guardar cada edición confirmada en el archivo original, informar estados/errores y manejar cambios externos.
- Mostrar y editar valores crudos: sin porcentajes derivados, fechas inferidas, moneda, separadores de miles, estilos ni conversión automática de tipos.

**Excluido del MVP**

Macros, gráficos/pivots interactivos, edición de fórmulas, compatibilidad completa con Excel u ODF, formato visual avanzado y colaboración. El motor calcula fórmulas XLSX para presentación; en ODS las fórmulas y su caché se muestran sin recalcular. Los resultados calculados nunca se escriben al archivo. No se requiere insertar/eliminar filas, columnas u hojas. Excluir una función no autoriza a eliminar su contenido al guardar un libro.

**Supuestos que deben validarse**

- VS Code de escritorio y archivos locales como entorno inicial; confirmar antes de restringir esquemas remotos/virtuales. Tampoco se presupone equivalencia de URI entre enlaces simbólicos.
- Propuestas heredadas del plan: una vista por documento, sin división simultánea; búsqueda literal sin distinguir mayúsculas; conservar consulta y reiniciar selección a A1 al cambiar hoja.
- CSV: coma, punto y coma o tabulador; UTF-8 con/sin BOM y UTF-16 LE/BE con BOM como conjunto inicial. Separador ambiguo requiere elección; codificación no admitida requiere aviso sin reescritura.
- Límites implementados: 10 MiB en disco, 64 MiB descomprimidos para XLSX/ODS, 10 000 partes, 50 hojas, 50 000 filas/256 columnas/1 000 000 posiciones por hoja y 500 000 celdas presentes/campos por archivo. Se rechaza la carga completa si se excede un límite.
- Si una característica de XLSX/ODS fuera de alcance impide preservar el libro, explicar la limitación y ofrecer solo lectura o rechazar lectura incompatible. Esto no sustituye la edición/guardado exigidos para archivos tabulares sencillos.

## 3. Diseño técnico propuesto

### Estado real y compatibilidad

Revisados `package.json`, fuentes, pruebas, configuración TS/esbuild y archivos de `.vscode/`:

- Extensión 0.0.1; entrada `dist/extension.js`; comando Explorer `spreadsheet-viewer.open`; custom editor `spreadsheet-viewer.editor` para CSV/XLSX/ODS.
- `src/extension.ts`, `src/editor.ts`, `src/document.ts`, adaptadores de formato y pruebas ya implementan el flujo; TS estricto, ES2022/Node16; esbuild genera CommonJS para Node, excluyendo `vscode`.
- F5 usa `Run Extension` con watch. Existen scripts de compilación, tipos, lint, pruebas y bundle de producción; `npm run package` no genera por sí solo un VSIX. En esta revisión, `npm test` no inicia con Node 18 porque una dependencia del runner usa una característica de regex no disponible en ese runtime.
- Manifiesto: `engines.vscode ^1.137.0` y `@types/vscode ^1.140.0`. Tipos instalados 1.140.0, TypeScript 6.0.3 y esbuild 0.28.2.
- Las declaraciones instaladas contienen `CustomEditorProvider`, `registerCustomEditorProvider` y `supportsMultipleEditorsPerDocument`. **Por confirmar:** ejecución en la versión mínima, comandos de apertura/revelado, activación, empaquetado y compatibilidad de las dependencias propuestas. La presencia de tipos no demuestra integración funcional.

### Apertura, asociación e interfaz

Recomendar custom editor con webview y prioridad `option`: integra recurso/nombre, pestaña movible y ciclo de guardado de VS Code. Un WebviewPanel independiente también sería movible, pero exige gestionar asociación, duplicados y recuperación manualmente. Para CSV, CustomTextEditorProvider simplificaría el ciclo textual; se propone un proveedor común CSV/XLSX para conservar bytes/codificación y compartir persistencia. La contrapartida es implementar el contrato de edición, save, save-as, revert y backup; verificarlo antes de habilitar edición.

Flujo implementado: comando `spreadsheet-viewer.open` → URI del Explorer validada → custom editor `spreadsheet-viewer.editor` → documento/adaptador CSV, XLSX u ODS → tabla. El menú **Visualizar en Spreadsheet** filtra extensiones y excluye carpetas. La apertura usa `vscode.openWith`; registro por URI/viewType revela la vista existente y deduplica solicitudes concurrentes.

La extensión controla archivos/modelo; la webview envía intenciones mediante `postMessage`/`onDidReceiveMessage`. Contrato pequeño: carga, selección, cambio de hoja, referencia, búsqueda, edición y estado de guardado, con ID de solicitud, revisión y hoja. Validar datos y descartar mensajes obsoletos. Recursos locales, CSP y presentación textual evitan interpretar contenido como HTML.

### Representación y preservación

**CSV:** todas las celdas son texto, incluida la primera fila. Papa Parse es candidato **por confirmar**; desactivar tipado dinámico, encabezados, trim, transformaciones y eliminación de filas vacías. Conservar ceros iniciales, espacios, decimales y fechas textuales exactamente; distinguir campo vacío de campo ausente en una fila corta. Contar registros, no líneas físicas; un salto terminal no agrega por sí solo otra fila.

Guardar preservando separador, comillas, escapes, saltos internos, finales de línea, BOM y codificación. Propuesta: tokenizador con segmentos originales y sustitución del campo editado; un parse/unparse completo no garantiza fidelidad. Escapar comillas y entrecomillar cuando corresponda; completar solo los separadores necesarios si se edita un campo ausente. No anteponer apóstrofos ni transformar texto como `=ABC`. Decodificación estricta; no sustituir caracteres inválidos.

**XLSX:** `fflate` para ZIP y `@xmldom/xmldom` para el adaptador SpreadsheetML. Son herramientas ZIP/XML, no un editor XLSX completo. El adaptador resuelve workbook, relaciones, hojas y shared/inline strings; las pruebas comprueban lectura y escritura de lexemas crudos.

- Celda: coordenadas, tipo original y valor léxico completo. Números/seriales como cadenas, sin pasar por Number o Date: `0.25` sigue `0.25` aunque tenga formato porcentaje; un serial de fecha conserva todos sus dígitos. Fecha textual permanece textual; fecha explícita `t="d"` mantiene su texto almacenado. Booleanos conservan `0`/`1`.
- Vacío, cadena vacía y celda ausente son distintos. Mantener tipo al editar; validar sin convertir. Propuesta pendiente: celdas ausentes reciben texto por defecto y cualquier cambio de tipo exige elección explícita. Mostrar valor completo y tipo de la selección; no truncar el editor.
- Escribir lexemas numéricos originales; editar shared strings sin alterar otras referencias, por ejemplo mediante inline strings. Preservar espacios, escapes SpreadsheetML y caracteres XML.
- Fórmulas: mostrar la expresión con `=` y conservar el valor crudo cacheado, sin editar la fórmula ni escribir resultados calculados al archivo. La etapa de cálculo 1 evalúa solo operaciones aritméticas/comparaciones y `IF`, `CONCAT`, `SUM`, `AVERAGE`, `MAX`, `MIN`, `COUNT`, `ROUND`; otras fórmulas se identifican como **Fórmula NO compatible**. Un error de cálculo se muestra separado del resultado cacheado. La etapa 2 evaluará integrar un motor amplio bajo licencia permisiva. El cálculo es solo para mostrar y no sustituye ni actualiza la caché del XLSX.
- Preservar atributos de formato sin aplicarlos a la tabla y copiar partes no modificadas. La propuesta no garantiza identidad binaria, compresión/metadatos ZIP ni serialización XML idéntica. Firmas, macros, gráficos, pivots, protección, combinaciones y contenido enriquecido requieren comprobar preservación; registrar qué no conserva realmente la librería elegida. No reescribir eliminando características incompatibles.

**ODS:** el adaptador `formats/ods.ts` inspecciona el `mimetype` del ZIP y lee `content.xml` directamente. Expande celdas/filas repetidas dentro de los límites de la tabla; toma números/porcentajes de `office:value`, fechas de `office:date-value`, texto de `text:p` y fórmulas de `table:formula` con su valor almacenado. No convierte valores por estilo. Al guardar modifica solo las celdas editadas en `content.xml`, reempaqueta el archivo con `mimetype` primero y sin compresión, y conserva las demás partes ZIP. Las fórmulas se muestran con caché y no se recalculan. La preservación semántica de contenido ODF complejo, filas combinadas y funciones avanzadas debe verificarse con LibreOffice; no asumir compatibilidad total con el estándar.

Rango XLSX: A1 hasta la última celda con contenido, conservando huecos y evitando dimensiones infladas solo por estilos. CSV: registros y ancho máximo. Hoja vacía: 0 filas/0 columnas, sin selección. Renderizar solo la región visible y procesar operaciones grandes por lotes/worker según medición.

### Navegación, guardado y conflictos

Referencias A1: letras base 26 y fila positiva, coordenadas internas base 0; comprobar formato y rango antes de seleccionar/hacer scroll. Búsqueda propuesta: subcadena de valores crudos de la hoja activa, orden por fila/columna, anterior/siguiente circular, `i / total`, cero coincidencias y estado de cálculo. Editar o cambiar hoja recalcula resultados; mensajes tardíos no afectan otra hoja.

Confirmar edición con Enter o salida de celda; Escape cancela. El guardado tras confirmar es obligatorio; debounce de 300 ms es una propuesta a validar, sin depender de la configuración Auto Save. Cola por documento/revisión; cambiar hoja no cancela escrituras. Ctrl/Cmd+S usa la misma ruta. Cancelar o confirmar el valor original no reescribe.

Propuesta de persistencia local: serializar a temporal vecino, releer/validar, verificar hash del original y reemplazar por rename conservando permisos. **Por confirmar:** garantías en el sistema de archivos objetivo; no afirmar atomicidad universal. Error conserva original y borrador/backup, mantiene estado sucio y permite reintento. Implementar undo/redo y contrato del proveedor sin ampliar funciones de Excel.

Estados: Sin cambios, Cambios pendientes, Guardando…, Guardado y Error al guardar; error también en notificación VS Code. Una respuesta antigua no marca ediciones nuevas como guardadas. Observar cambios/eliminaciones: sin borrador, recargar y reconciliar tabla/selección/búsqueda; con borrador o editor textual sucio, bloquear sobrescritura y ofrecer recargar descartando o guardar copia. Hash distingue escrituras propias, pero no garantiza exclusión de escritores simultáneos.

## 4. Estructura propuesta de archivos

Árbol basado en archivos reales. **E** = existente; **P** = propuesta, crear solo cuando la etapa lo necesite. Mantener selección, búsqueda y edición en un modelo pequeño, sin capas adicionales.

```text
spreadsheet-viewer/
├── planning.md [E]             Guía y decisiones verificadas para las etapas.
├── package.json [E]            Comando, menú, editor, scripts y dependencias.
├── package-lock.json [E]       Versiones efectivamente elegidas.
├── esbuild.js [E]              Esbuild para extensión/CSS y Webpack para webview con WASM.
├── tsconfig.json [E]           Tipado de la extensión y pruebas.
├── tsconfig.webview.json [E]   Tipado DOM de la interfaz, aislado de Node.
├── eslint.config.mjs [E]       Reglas de lint; ajustar solo si hace falta.
├── .vscodeignore [E]           Inclusión de recursos necesarios al empaquetar.
├── .vscode-test.mjs [E]        Ejecución de pruebas en Extension Host.
├── .vscode/
│   ├── launch.json [E]         Ejecución F5 de la extensión.
│   └── tasks.json [E]          Watch y compilación durante desarrollo.
├── README.md [E]               Uso y limitaciones comprobadas.
├── CHANGELOG.md [E]            Funcionalidad realmente entregada.
└── src/
    ├── extension.ts [E]       Activación, registro del comando y proveedor.
    ├── editor.ts [E]          Ciclo del custom editor, vistas y mensajes.
    ├── document.ts [E]        Datos crudos, hojas, selección, búsqueda y revisiones.
    ├── storage.ts [E]         Guardado, backups y conflictos externos.
    ├── protocol.ts [E]        Contrato de mensajes entre extensión y tabla.
    ├── formats/
    │   ├── csv.ts [E]         Lectura y modificaciones fieles de CSV.
    │   ├── xlsx.ts [E]        Lectura y modificaciones fieles de XLSX.
    │   └── ods.ts [E]         Lectura cruda de ODS y edición de celdas en content.xml.
    ├── webview/
    │   ├── main.ts [E]        Tabla, controles e interacción del usuario.
    │   ├── formula-calculator.ts [E] Cálculo visual de fórmulas con Formualizer.
    │   └── styles.css [E]     Diseño legible, sin formatos visuales de Excel.
    └── test/
        ├── extension.test.ts [E] Integración y flujo del editor.
        ├── document.test.ts [E]  Referencias, búsqueda, hojas y ediciones.
        ├── formats.test.ts [E]   Fidelidad CSV/XLSX/ODS con fixtures.
        └── storage.test.ts [E]   Fallos, revisiones y conflictos de guardado.
```

`dist/` ya existe como salida generada; `out/` es la salida prevista por `compile-tests`, todavía no presente en la estructura revisada. No editar salidas manualmente. Otros archivos existentes no necesitan cambios por este plan.

## 5. Etapas de implementación para Luna

Ejecutar una etapa por solicitud, en orden. Si falta una anterior, informar la dependencia; no implementarla silenciosamente. Las vistas de etapas intermedias pueden ser solo lectura: el MVP solo se acepta después de completar edición y guardado para ambos formatos.

### Etapa 1 — Base funcional y compatibilidad

- **Objetivo:** preparar ejecución y bundles compatibles, sin implementar funciones de tabla.
- **Archivos que podría modificar:** `package.json`, lockfile, esbuild/tsconfig, `tsconfig.webview.json`, `src/protocol.ts`, `src/webview/main.ts`; tareas/launch solo si es necesario; `planning.md` para registrar verificaciones.
- **Resultado esperado:** extensión ejecutable por F5 y recursos de interfaz compilables; propuesta de proveedor contrastada con runtime.
- **Criterios de aceptación comprobables:** `npm run compile` pasa; F5 y la ejecución del comando activan la extensión sin errores; tipos DOM no contaminan Node; versión mínima/API y dependencias están identificadas.
- **Qué debe quedar fuera de esa etapa:** apertura Spreadsheet, parsers, tabla, navegación, edición y guardado.

### Etapa 2 — Comando y pestaña asociada

- **Objetivo:** conectar Explorer con una vista nativa de editor.
- **Archivos que podría modificar:** `package.json`, `src/extension.ts`, `editor.ts`, `protocol.ts`, webview, `src/test/extension.test.ts`.
- **Resultado esperado:** pestaña asociada a la URI, inicialmente solo lectura y sin datos ficticios.
- **Criterios de aceptación comprobables:** título exacto del menú solo en CSV/XLSX; pestaña muestra nombre, se mueve entre grupos y se reutiliza tras moverla; dos solicitudes simultáneas no duplican vista; cerrar/reabrir funciona.
- **Qué debe quedar fuera de esa etapa:** parseo, datos tabulares, controles de navegación y escritura al archivo.

### Etapa 3 — CSV y tabla fiel

- **Objetivo:** leer disco y mostrar CSV sin coerción.
- **Archivos que podría modificar:** dependencias/lockfile, `document.ts`, `formats/csv.ts`, editor/webview/styles, `formats.test.ts` y fixtures.
- **Resultado esperado:** tabla CSV solo lectura con coordenadas, selección y contadores, sin selector de hojas.
- **Criterios de aceptación comprobables:** fechas, decimales, ceros iniciales y espacios intactos; comillas/saltos/filas irregulares correctos; codificaciones admitidas verificadas; errores de parseo informados; abrir/seleccionar no modifica bytes.
- **Qué debe quedar fuera de esa etapa:** XLSX/ODS, búsqueda, salto por referencia y edición/guardado.

### Etapa 4 — XLSX y valores crudos

- **Objetivo:** validar adaptador y mostrar la primera hoja XLSX fielmente.
- **Archivos que podría modificar:** dependencias/lockfile, `formats/xlsx.ts`, document/editor/webview, pruebas de formatos y fixtures.
- **Resultado esperado:** libro cargado con identidad/orden de hojas y primera hoja visible, todavía solo lectura.
- **Criterios de aceptación comprobables:** porcentaje `0.25`, serial preciso, textos de fecha, booleanos y huecos se muestran sin formato; shared/inline strings correctas; fórmulas/cache diferenciados; incompatibilidades identificadas. Probar modificación/serialización únicamente en copias de fixtures y confirmar reapertura sin reparación ni cambios ajenos.
- **Qué debe quedar fuera de esa etapa:** navegación de hojas en UI, búsqueda y cambios en archivos del usuario. No avanzar sin resolver fallos de fidelidad del adaptador.

### Etapa 5 — Hojas y referencias

- **Objetivo:** navegar hojas XLSX e ir a una celda.
- **Archivos que podría modificar:** document/editor/protocol/webview y `document.test.ts`.
- **Resultado esperado:** selector XLSX y campo de referencia con selección/scroll sincronizados.
- **Criterios de aceptación comprobables:** B54 y columnas posteriores a Z se resuelven correctamente; A0, 54B y fuera de rango notifican exactamente Celda inválida y conservan selección. Cambiar hoja actualiza tabla, dimensiones y referencia; hojas vacías y CSV se comportan según diseño.
- **Qué debe quedar fuera de esa etapa:** búsqueda, edición y persistencia.

### Etapa 6 — Búsqueda de hoja activa

- **Objetivo:** buscar contenido y recorrer coincidencias.
- **Archivos que podría modificar:** document/editor/protocol/webview y pruebas del documento.
- **Resultado esperado:** búsqueda literal con anterior/siguiente y contador.
- **Criterios de aceptación comprobables:** repetidos, ninguna coincidencia y consulta vacía; navegación/scroll correctos; total o estado de cálculo veraz; cambiar hoja recalcula sin resultados tardíos de otra hoja.
- **Qué debe quedar fuera de esa etapa:** búsqueda global del libro, regex, edición y guardado.

### Etapa 7 — Modelo de edición y serialización

- **Objetivo:** preparar cambios de celda y undo/redo sin conversiones.
- **Archivos que podría modificar:** document/protocol, adaptadores, document/formats tests y fixtures.
- **Resultado esperado:** edición y serialización comprobadas en memoria/copias; interfaz del usuario sigue solo lectura hasta tener persistencia segura.
- **Criterios de aceptación comprobables:** cambiar/restaurar celdas conserva tipo y precisión; inválidos mantienen valor anterior; vacío/ausente/texto vacío definidos; editar shared string no afecta otra celda. Copias serializadas conservan datos no editados y hojas restantes.
- **Qué debe quedar fuera de esa etapa:** habilitar edición del usuario, escribir el original y resolver concurrencia externa.

### Etapa 8 — Edición y guardado en el original

- **Objetivo:** habilitar edición para CSV/XLSX con persistencia y recuperación.
- **Archivos que podría modificar:** `storage.ts`, document/editor/protocol/webview, adaptadores y pruebas de storage/integración.
- **Resultado esperado:** cada edición confirmada guarda el original y comunica su estado; contrato editable del proveedor completo.
- **Criterios de aceptación comprobables:** reabrir verifica cambios de varias hojas; cola no pierde ediciones rápidas; estados/errores correctos; fallo de permisos/escritura conserva original y borrador. Undo/redo, Save, revert, save-as y backup/restauración funcionan según contrato verificado.
- **Qué debe quedar fuera de esa etapa:** merge, colaboración, funciones de Excel y cambios estructurales.

### Etapa 9 — Cambios externos y límites

- **Objetivo:** proteger frente a conflictos, eliminaciones y archivos excesivos.
- **Archivos que podría modificar:** storage/editor/document, adaptadores, webview y pruebas pertinentes.
- **Resultado esperado:** recarga o conflicto explícitos, límites medidos y carga/renderizado acotados.
- **Criterios de aceptación comprobables:** cambio externo sin borrador recarga; con borrador/texto sucio no sobrescribe; eliminación informa; escrituras propias no disparan recarga errónea. Límites de disco/descompresión/rango se comprueban durante lectura, sin truncamiento editable; región visible/búsqueda mantienen interfaz reactiva.
- **Qué debe quedar fuera de esa etapa:** resolver conflictos mediante merge o garantizar edición simultánea.

### Etapa 10 — Verificación del MVP

- **Objetivo:** comprobar el conjunto y documentar límites reales.
- **Archivos que podría modificar:** pruebas/fixtures, README, CHANGELOG, `.vscodeignore` y configuración de pruebas/empaquetado si es necesario; correcciones mínimas en archivos afectados.
- **Resultado esperado:** checklist completo con evidencia y decisiones pendientes resueltas para el subconjunto admitido.
- **Criterios de aceptación comprobables:** compile, pruebas pertinentes y package pasan; F5 verifica flujo completo; recursos/dependencias se incluyen en el paquete distribuible; limitaciones XLSX/ODS/CSV corresponden a pruebas, no promesas.
- **Qué debe quedar fuera de esa etapa:** funcionalidades nuevas, refactors amplios y publicación de la extensión.

## 6. Instrucciones para ejecutar cada etapa

Bloque reutilizable para entregar a Luna:

> Implementa únicamente la etapa **[N]** de `planning.md`.
> Lee primero el contexto, alcance, diseño y estructura de `planning.md`; de las tareas de implementación, ejecuta solo la etapa solicitada. Inspecciona los archivos actuales y las instrucciones del repositorio antes de editar.
> Comprueba que sus dependencias anteriores están implementadas y respétalas. No implementes otras etapas, refactors ni cambios de alcance no solicitados; crea solo los archivos necesarios.
> Si hay conflicto entre plan y proyecto, explica el conflicto y propone una solución antes de ampliar el alcance. No sustituyas requisitos de fidelidad, edición o guardado por atajos técnicos.
> Ejecuta solo las comprobaciones pertinentes y reporta comando, resultado y limitaciones. Si no puedes verificar algo, indícalo expresamente.
> Al terminar, resume archivos modificados, decisiones verificadas o pendientes y pasos manuales para revisar esa etapa en VS Code. No declares completo el MVP al cerrar una etapa intermedia.

## 7. Riesgos y verificación final

- **Valores crudos XLSX/ODS:** conversión a Number/Date, shared strings, repeticiones ODF y escapes pueden perder precisión/contenido; comparar lexemas/tipos XML y probar los adaptadores antes de habilitar escritura.
- **Preservación:** CSV reserializado puede cambiar comillas/encoding; XLSX/ODS pueden perder partes/características o metadatos ZIP/XML. Comparar bytes CSV y partes no editadas de los paquetes; reabrir con LibreOffice.
- **Archivos grandes:** ZIP pequeño puede expandirse excesivamente; comprobar tamaño durante descompresión y medir rango/renderizado/búsqueda.
- **Cambios concurrentes:** hash/rename no es bloqueo transaccional entre procesos; conservar borrador y evitar sobrescritura automática.
- **Navegación:** offsets base 0/1, columnas base 26 y mensajes asíncronos pueden seleccionar otra celda/hoja; probar límites y transiciones durante búsqueda/guardado.

Checklist manual en Extension Development Host con F5 (`Run Extension`), usando copias con al menos 54 filas y varias hojas. Estado actualizado con las pruebas manuales reportadas por el usuario; no equivale a evidencia automatizada de todos los casos del punto:

- [x] Abrir archivos CSV y XLSX en Spreadsheet Viewer y editar celdas; el usuario confirmó que funciona en ambos formatos.
- [x] Guardar ediciones en el archivo original; el usuario confirmó que funciona en CSV y XLSX.
- [x] Buscar contenido y navegar celdas con flechas; el usuario confirmó que funciona en CSV y XLSX.
- [x] Leer y mostrar datos hasta la columna DP; el usuario confirmó que funciona.
- [x] Redimensionar columnas; el usuario confirmó que funciona.
- [x] Cambiar un archivo externamente sin ediciones locales pendientes y comprobar que la vista se recarga; el usuario confirmó que funciona.
- [x] Hacer doble clic en una celda para editar en línea y comprobar que al perder el foco se guarda; el usuario confirmó que lo probó.
- [ ] Menú exacto solo en CSV/XLSX/ODS, no en carpetas/otros formatos; pestaña identificable, alternable y movible entre grupos por acciones normales de VS Code. Repetir apertura reutiliza la vista incluso después de moverla.
- [x] Navegar mediante referencia a una columna posterior a Z; el usuario confirmó que lo probó.
- [ ] Navegar a B54 y probar referencias inválidas/fuera de rango; comprobar aviso exacto y que la selección permanezca intacta.
- [x] Cambiar entre hojas XLSX; el usuario confirmó que probó la navegación entre hojas.
- [x] Buscar con coincidencias, coincidencias repetidas y sin coincidencias; el usuario confirmó que probó estos escenarios.
- [ ] Comprobar que al cambiar de hoja se actualicen tabla, dimensiones, selección y búsqueda; probar una hoja vacía y confirmar que CSV no ofrece selector de hojas.
- [ ] Probar anterior/siguiente, consulta vacía, contador y recálculo de búsqueda al editar/cambiar hoja.
- [ ] CSV conserva `0.25`, `00123`, `1.2300`, `2026-02-04`, `04-02-2026`, espacios y `=ABC`; probar separadores, comillas escapadas, saltos internos, LF/CRLF, filas vacías/irregulares y codificaciones/BOM admitidos.
- [ ] XLSX muestra `0.25` con formato porcentaje y serial `46057.1234567890123` con formato fecha literalmente; editar conserva precisión/tipo. Probar texto de fecha, `1.2300` y entero mayor que 2^53 mediante fixture XML, sin redondearlo previamente en Excel.
- [ ] ODS abre un libro creado en LibreOffice, permite cambiar de hoja, buscar, ir a referencia y editar/guardar celdas. `0.25`, fechas ISO y fórmulas con valor en caché se ven crudos; al editar una celda se mantienen las otras hojas, fórmulas/cachés y partes ODF no editadas. Reabrir en Spreadsheet Viewer y LibreOffice.
- [ ] Guardar/reabrir ambos formatos y varias hojas; datos ajenos intactos, shared strings independientes y sin reparación del libro. Abrir sin editar no reescribe.
- [ ] Al editar otras celdas, conservar fórmulas y cachés originales; el resultado calculado para la vista no se serializa al XLSX. Ninguna característica se elimina silenciosamente.
- [ ] Probar manualmente las operaciones y funciones soportadas; confirmar resultado y fórmula original. Probar una función no soportada y verificar **Fórmula NO compatible**.
- [ ] Ediciones rápidas, cambio de hoja durante escritura, undo/redo y Save; error de permisos preserva original/borrador y permite reintento; backup recupera pendientes tras reiniciar.
- [ ] Cambiar externamente el archivo mientras hay una edición local pendiente: verificar que no se sobrescriba y que se ofrezcan las opciones de conflicto. Probar también eliminar el archivo mientras está abierto.
- [ ] Archivos dentro/sobre límites, incluida expansión ZIP: aviso comprensible, sin carga parcial editable ni bloqueo prolongado.
- [ ] Ejecutar las pruebas de integración con una versión de Node compatible, completar la verificación final y comprobar el empaquetado distribuible.
- [ ] Probar **Recargar** en una vista atascada y confirmar que vuelve a mostrar el contenido actual del archivo; con cambios locales, cancelar conserva el borrador y aceptar recarga desde disco.

Referencias de la propuesta, **no evidencia de compatibilidad con este proyecto**: [Custom editors](https://code.visualstudio.com/api/extension-guides/custom-editors), [comandos](https://code.visualstudio.com/api/references/commands), [menús](https://code.visualstudio.com/api/references/contribution-points), [Papa Parse](https://www.papaparse.com/docs), [fflate](https://github.com/101arrowz/fflate), [xmldom](https://github.com/xmldom/xmldom) y [CellValue de SpreadsheetML](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cellvalue).

## 8. Etapa posterior — Redimensionar columnas

- **Objetivo:** permitir ajustar el ancho de las columnas desde la tabla.
- **Archivos que podría modificar:** `src/webview/main.ts`, `src/webview/styles.css` y pruebas pertinentes.
- **Resultado esperado:** el borde entre encabezados funciona como divisor arrastrable; al pasar el cursor por ese borde aparece el cursor de redimensionamiento y al arrastrarlo cambia el ancho de la columna.
- **Criterios de aceptación comprobables:** el cursor de redimensionamiento aparece únicamente sobre el divisor; se puede arrastrar para ensanchar y estrechar columnas; encabezados y celdas mantienen su alineación y el desplazamiento horizontal continúa funcionando.
- **Qué debe quedar fuera de esa etapa:** cambiar datos de celdas, alterar el tamaño del archivo o introducir otras funciones de formato.

## 9. Cálculo de fórmulas — etapas posteriores

El usuario amplió el alcance para mostrar resultados calculados. Este cálculo es de solo presentación; las fórmulas y cachés originales se conservan sin reescritura. No afirmar compatibilidad completa con Excel.

### Etapa de fórmulas 1 — Conjunto de ejemplo

- **Estado:** cubierta por el motor de la etapa 2; el evaluador acotado inicial ya no se utiliza.
- **Soporte:** `+`, `-`, `*`, `/`, comparaciones `>`, `<`, `>=`, `<=`, `=`, `<>`, paréntesis y referencias/rangos de la misma hoja; funciones `IF`, `CONCAT`, `SUM`, `AVERAGE`, `MAX`, `MIN`, `COUNT` y `ROUND`.
- **Presentación:** mantener la fórmula y la caché cruda; mostrar **Fórmula (calculada)** con el resultado evaluado. Errores muestran el código de error. Funciones/sintaxis no soportadas muestran exactamente **Fórmula NO compatible**.
- **Criterios de aceptación:** operaciones y funciones del fixture de ejemplo producen los resultados esperados; referencias a fórmulas se evalúan; circularidad se informa; editar un valor de entrada actualiza las fórmulas dependientes; calcular no cambia ni guarda el archivo; función fuera del conjunto se identifica como no compatible.
- **Qué queda fuera:** recalcular resultados dentro del XLSX, guardar cachés, funciones no listadas y garantía de equivalencia total con Excel.

### Etapa de fórmulas 2 — Motor abierto de mayor compatibilidad

- **Estado:** implementada; pendiente de prueba manual en VS Code con el libro de fórmulas del usuario.
- **Motor fijado:** [Formualizer 0.10.1](https://www.npmjs.com/package/formualizer/v/0.10.1), dependencia exacta con licencia dual MIT o Apache-2.0. Se carga bajo demanda para libros que contienen fórmulas. La webview usa un bundle Webpack con WASM asíncrono; el bundle de la extensión continúa con esbuild. Se incluyen ambas licencias del paquete en `dist/` para el VSIX.
- **Integración verificada:** paquete, API `Workbook.fromXlsxBytes` y evaluación de una fórmula se probaron; Webpack emitió el bundle, el módulo auxiliar y el WASM. Los resultados se calculan desde una copia serializada en memoria del libro y nunca se guardan. La tabla continúa usando sus valores crudos parseados por el lector XLSX.
- **Límite:** Formualizer anuncia cientos de funciones, pero no se garantiza compatibilidad con todas las fórmulas de Excel. Cuando el motor devuelve `#NAME?` o no acepta la fórmula, la interfaz muestra **Fórmula NO compatible**; los errores de cálculo se muestran aparte. La evaluación numérica usa los tipos numéricos del motor y puede tener precisión de punto flotante; no altera el lexema crudo visible ni guardado.
- **Alternativa descartada para este requisito:** HyperFormula requiere GPLv3 o licencia comercial, por lo que no satisface la preferencia de licencia permisiva sin pago.
- **Verificación pendiente:** probar en VS Code el libro de ejemplo, fórmulas compatibles/no compatibles, recálculo después de editar una entrada y confirmar que el archivo conserva fórmula y caché tras guardar otras celdas. Medir carga/cálculo con un XLSX representativo. No afirmar equivalencia total con Excel.
- **Qué queda fuera:** prometer soporte de todas las funciones de Excel o modificar el archivo para guardar los resultados del motor.

## 10. Etapa posterior — Redimensionar filas

- **Estado:** implementada; pendiente de prueba manual en VS Code.
- **Objetivo:** permitir ajustar la altura de una fila desde su encabezado numerado.
- **Archivos que podría modificar:** `src/webview/main.ts`, `src/webview/styles.css` y pruebas pertinentes.
- **Resultado esperado:** el borde inferior del encabezado de fila funciona como divisor arrastrable; al pasar el cursor aparece el cursor de redimensionamiento vertical y al arrastrarlo cambia la altura de esa fila.
- **Criterios de aceptación comprobables:** el cursor aparece únicamente sobre el divisor; se puede aumentar y reducir la altura con el mouse y teclado; las celdas de la fila permanecen alineadas; las filas siguientes, el scroll vertical, selección y navegación siguen funcionando; la altura se conserva al volver a la misma hoja durante la sesión.
- **Qué debe quedar fuera de esa etapa:** modificar contenido, guardar alturas dentro del archivo CSV/XLSX o introducir otras funciones de formato.

## 11. Etapa posterior — Recarga manual del archivo

- **Estado:** implementada; pendiente de prueba manual en VS Code.
- **Objetivo:** ofrecer un control visible para releer el archivo desde disco y recuperar una vista que quedó cargando.
- **Resultado esperado:** **Recargar** vuelve a leer y validar el archivo, reconstruye el documento y actualiza la tabla. Si hay ediciones locales pendientes, solicita confirmación antes de descartarlas; errores se muestran en la vista y como notificación de VS Code.
- **Criterios de aceptación:** al usar el botón, se actualiza el contenido desde disco; con cambios pendientes, cancelar los conserva y confirmar los descarta y relee; un error de lectura no deja el botón bloqueado y comunica la causa.
- **Qué debe quedar fuera:** fusionar cambios locales con el archivo recargado o recuperar borradores descartados.

## 12. Etapa añadida — Soporte ODS

- **Estado:** implementación y pruebas de formato añadidas; falta verificación manual en VS Code y LibreOffice.
- **Objetivo:** abrir, navegar, buscar, editar y guardar libros `.ods` desde el menú contextual, conservando valores crudos y partes no editadas del contenedor.
- **Archivos que podría modificar:** `package.json`, `src/extension.ts`, `src/document.ts`, `src/editor.ts`, `src/protocol.ts`, `src/edit-model.ts`, `src/formats/ods.ts`, `src/webview/main.ts`, `src/test/extension.test.ts`, `src/test/formats.test.ts`, `README.md` y este plan.
- **Resultado esperado:** las pestañas ODS usan las mismas acciones tabulares que XLSX; el adaptador lee `content.xml`, expande repeticiones dentro de límites, y guarda las celdas editadas conservando las demás partes ZIP. Las fórmulas ODS muestran expresión y valor en caché, sin recalcularse.
- **Criterios de aceptación comprobables:** el menú y el custom editor admiten `.ods`; varias hojas, celdas repetidas, decimales, fechas, texto, vacíos y fórmulas/cachés se muestran sin formato inferido; búsqueda/referencia/edición/guardado/reapertura funcionan; un valor `0.25` continúa `0.25` bajo formato porcentaje; al editar otra celda se mantienen fórmula, caché y partes ajenas; límites y errores inválidos se informan.
- **Qué debe quedar fuera:** recálculo de fórmulas ODF, macros/extensiones, compatibilidad total del estándar, estilos visuales y promesa de preservar funciones ODF avanzadas sin pruebas.

## 13. Seguimiento de pruebas de fórmulas — 2026-10-09 05:03 (America/Guatemala, UTC−06:00)

Se ejecutó `npm run test:formulas` contra `src/test/fixtures/xlsx/formula_excel.xlsx`, usando el evaluador Formualizer 0.10.1 que integra la extensión. La suite recorre 2,968 fórmulas de siete hojas y **pasa como prueba de caracterización**: 2,906 resultados llevan estado `calculated`, 62 llevan estado `error` y ninguno lleva estado `unsupported`. “Calculated” describe el estado que devuelve el código actual; no certifica por sí solo que el resultado sea correcto. La suite también fija dos resultados de fecha ya identificados como incorrectos para que el problema permanezca visible; esos asserts deben reemplazarse por expectativas correctas cuando se corrija el evaluador.

Checklist para resolver y ampliar la cobertura en trabajo posterior:

- [ ] **Fechas y seriales:** corregir y probar `TEXT(Datos!I2,"yyyy-mm-dd")` y `TEXT(C2,"yyyymmdd")`; en este libro producen `1900-01-00`/`19000100` en vez de representar la fecha de origen. Revisar también el resultado de `DATE(YEAR(...),MONTH(...),DAY(...))`, actualmente serializado como una cadena con comillas, y comprobar `YEAR`, `MONTH`, `DAY`, `WEEKDAY`, `EDATE`, `EOMONTH`, `TODAY` y `NETWORKDAYS` con resultados esperados independientes.
- [ ] **Búsquedas:** investigar los 54 resultados `error` de la hoja `Busquedas`. Casos representativos `VLOOKUP`, `HLOOKUP`, `INDEX`/`MATCH` devuelven `#N/A` aunque el libro contiene coincidencias; comprobar referencias, coincidencia exacta, filas/columnas y resultados contra valores calculados independientemente.
- [ ] **Fórmulas matriciales/dinámicas:** evaluar el soporte de `UNIQUE`, `SORT`, `FILTER`, `SEQUENCE` y `TRANSPOSE`. Actualmente cinco celdas devuelven `#SPILL!`; decidir con pruebas si el motor puede exponer resultados derramados a la interfaz o si deben clasificarse explícitamente como no compatibles.
- [ ] **Funciones no implementadas y errores legítimos:** `AGGREGATE` y `LAMBDA` devuelven `#N/IMPL!`; hoy se clasifican como `error`, no como `unsupported`. Revisar cómo distinguir incompatibilidad del motor de un error real de fórmula. `NA()` produce `#N/A` y debe seguir tratándose como error de fórmula, no como función no compatible.
- [ ] **Mensaje de incompatibilidad:** comprobar que una fórmula efectivamente no compatible se muestra como **Fórmula NO compatible**. En la corrida del fixture no se produjo ningún estado `unsupported`, así que ese flujo visual aún no quedó ejercitado por esta prueba.
- [ ] **Pruebas de resultados independientes:** mantener la cobertura exhaustiva de cantidad/estado por hoja, pero ampliar los valores esperados correctos por familia de funciones. Los asserts de resultados incorrectos conocidos son temporales de caracterización; sustituirlos por asserts del resultado correcto al resolver cada problema, sin dejar errores conocidos como comportamiento esperado.
- [ ] **Cambios de entradas y revisión:** serializar una edición de una celda de entrada en una copia en memoria y comprobar que las fórmulas dependientes se recalculan al aumentar la revisión, que no se conserva un resultado viejo y que el archivo fixture original/cachés de fórmula no se modifican.
- [x] **Verificación automatizada de la línea base:** se ejecutaron `npm run test:formulas`, `npm run check-types:webview`, `npm run lint` y `git diff --check`; todos pasaron con los resultados y limitaciones descritos arriba.
- [ ] **Regresión tras las correcciones:** cuando se resuelvan los puntos anteriores, repetir `npm run test:formulas`, `npm run check-types:webview` y `npm run lint`; actualizar este checklist con lo corregido y los límites restantes.
