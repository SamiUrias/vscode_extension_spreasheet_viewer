# Spreadsheet Viewer — guía de implementación del MVP y propuesta v2

El MVP y su seguimiento se conservan en las secciones 1–14. La **propuesta v2**, basada en el análisis de `wijmo/gc-excelviewer`, está en la sección 15; sus etapas están pendientes y requieren una solicitud de implementación específica.

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

La etapa V2-01A actualizó el fixture propio `src/test/fixtures/xlsx/formula_excel.xlsx` y `npm run test:formulas` con Formualizer 0.10.1. La suite cubre 2,968 fórmulas en siete hojas: **2,860 calculadas, 1 error real y 107 incompatibles/cache-only**. Se corrigieron las referencias desplazadas del fixture en VLOOKUP, HLOOKUP e INDEX/MATCH; sus resultados exactos se comparan con la tabla fuente. El evaluador identifica libros por bytes y revisión, libera el Workbook WASM anterior y no altera el archivo ni las cachés originales. `#N/IMPL!` y `#SPILL!` son incompatibles; `NA()` conserva `#N/A` como error. Las salidas serial-zero conocidas de TEXT fecha se clasifican como incompatibles y la interfaz sigue mostrando la caché almacenada. Un nombre de función inválido se conserva como error.

Checklist para resolver y ampliar la cobertura en trabajo posterior:

- [x] **Fechas y seriales:** los casos TEXT que producen `1900-01-00`, `19000100` o terminan con ese serial se clasifican como incompatibles/cache-only. La caché sigue visible; no se declara un cálculo incorrecto como válido. Las familias de fecha restantes requieren expectativas adicionales en V2-01B.
- [x] **Búsquedas:** los 54 `#N/A` eran fórmulas desfasadas en el fixture (incluida la clave y la fila horizontal), no fallos de importación. Se corrigieron y se verifican VLOOKUP/HLOOKUP/INDEX/MATCH exactos contra datos fuente.
- [x] **Fórmulas matriciales/dinámicas:** resultados `#SPILL!` quedan incompatibles/cache-only; no se presentan como resultados calculados.
- [x] **Funciones no implementadas y errores legítimos:** `#N/IMPL!` queda incompatible; `NA()` conserva `#N/A` como error. Nombre de función desconocido se verifica como error.
- [x] **Mensaje de incompatibilidad:** la interfaz recibe `unsupported` para los casos incompatibles y mantiene la caché visible.
- [x] **Identidad y cambios de entradas:** prueba dos libros con la misma revisión, libera/recrea el Workbook WASM y confirma el recálculo de dependencias tras editar una entrada sin modificar el fixture original.
- [x] **Regresión tras las correcciones:** pasaron `npm run test:formulas`, `npm run check-types`, `npm run lint` y `git diff --check`. `DATE/YEAR/MONTH/DAY` y otras familias de fecha quedan para V2-01B.

## 14. Etapa posterior — Mejora de UI/UX de la vista

- **Estado:** implementada; `npm run compile` y las pruebas automatizadas pasaron. Falta revisión visual manual en Extension Development Host en anchos distintos y temas claro/oscuro.
- **Objetivo:** hacer más clara y cómoda la lectura y edición de libros desde la pestaña del editor, aprovechando mejor el espacio disponible sin cambiar el comportamiento de la tabla ni transformar los datos.
- **Archivos que podría modificar:** `src/editor.ts` para la estructura de la Webview; `src/webview/styles.css` para jerarquía visual y adaptación al espacio; `src/webview/main.ts` únicamente si se requiere ajustar estados, foco o presentación de la selección; pruebas de Webview/integración solo para comportamientos afectados.
- **Trabajo propuesto:** agrupar visualmente identidad del archivo y estado de guardado; compactar y ordenar controles de hoja, referencia y búsqueda; adaptar las filas de controles al ancho del editor; reducir el espacio que ocupa el panel de selección/edición sin ocultar la referencia ni el valor completo; distinguir claramente fórmula original, valor crudo/caché, resultado calculado y error; hacer más legibles los valores largos que hoy se recortan en las celdas, manteniendo la tabla compacta; revisar foco, contraste y etiquetas accesibles con los temas claro y oscuro de VS Code.
- **Resultado esperado:** jerarquía visual más clara, controles fáciles de localizar, tabla con más área útil y detalles de la celda seleccionada comprensibles sin perder fidelidad de los valores.
- **Criterios de aceptación comprobables:** probar el editor ancho y estrecho, y con una hoja de pocas y muchas columnas; ningún control esencial queda oculto ni se superpone; identidad/hoja/estado guardado se distinguen; búsqueda y referencia siguen utilizables al estrechar el editor; el panel permite leer el contenido completo de una celda larga y diferencia fórmula, caché, cálculo y error; navegación con teclado, edición, scroll en ambos ejes y redimensionamiento de filas/columnas siguen funcionando; colores y foco siguen visibles en los temas claro y oscuro; los datos conservan su texto crudo.
- **Qué debe quedar fuera:** cambiar la semántica o alcance de CSV/XLSX/ODS, aplicar formato numérico, añadir herramientas de Excel, esconder errores/estados, o introducir dependencias visuales sin necesidad demostrada.

## 15. V2 — Análisis completo de la referencia y especificación para Luna

**Estado:** análisis y propuesta; V2-00A, V2-00B, V2-01A y V2-01B implementadas. **Revisión:** 2026-10-10 (America/Guatemala). **Implementador previsto:** GPT Luna 6, esfuerzo medio. Esta sección reemplaza la primera propuesta v2, que era una revisión parcial. Las secciones 1–14 conservan el MVP y su historial; los cambios de alcance aquí descritos se aplican únicamente al implementar la etapa v2 correspondiente. No actualizar `package.json.version` solo por llamar v2 a este roadmap.

### 15.1. Qué se revisó y qué significa “todo el plugin”

Se descargó `wijmo/gc-excelviewer` en una carpeta temporal, sin incorporarlo a este proyecto, y se fijó el análisis al commit **`5dbc384d5d17cde2aba1a02366a479bafcec98f2`** (2026-06-05). El manifiesto de ese commit declara 4.2.64. No confundir versión publicada, fecha del commit y fecha del análisis.

Se revisó toda la lógica propia de la extensión: los once archivos de `src/`, los dos programas de interfaz `out/csv.js` y `out/excel.js`, manifiesto, README, CHANGELOG, licencia, configuración de TypeScript/Webpack, empaquetado, launch/tasks y devcontainer. Se inventariaron todos los recursos `out/`, se trazaron los scripts efectivamente cargados y se inspeccionaron defaults, propiedades, métodos y rutas relevantes de los controles activos minificados. Se inspeccionó el catálogo de fórmulas, contexto de celdas/hojas, clipboard, autofill, carga/guardado y metadatos XLSX de esos controles. Los GIF del README son referencias visuales; no certifican comportamiento en nuestro host.

**Alcance de la comprobación:** revisión estática completa de la lógica propia y auditoría de las capacidades integradas de las dependencias activas; pruebas aisladas de funciones CSV y lectura de fixtures. No se ejecutó el plugin de referencia completo en Extension Host/Web ni se verificó cada algoritmo interno de las bibliotecas comerciales. Los módulos no cargados no se consideran funcionalidades del plugin. Ninguna afirmación aquí equivale a compatibilidad total con Excel, ni a una auditoría exhaustiva de cada línea minificada.

Inventario: `out/` contiene **50 recursos, 3 706 370 bytes**; las vistas referencian **12 recursos distintos, 1 287 987 bytes**. Hay 44 módulos de controles Wijmo, pero únicamente siete se cargan entre ambas vistas; **37 controles no se cargan**. Las cantidades son tamaños de archivos del commit, no tamaños VSIX ni mediciones de memoria.

| Componente | Cómo funciona y evidencia fijada al commit |
| --- | --- |
| Activación, comandos, stdin | [src/extension.ts](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/src/extension.ts): previews por recurso, cuatro comandos, serializers y eventos de configuración/documentos. |
| Proveedor CSV | [src/csvEditor.ts](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/src/csvEditor.ts): `CustomTextEditorProvider`, cambios aplicados al TextDocument de VS Code. |
| Vista y escritura CSV | [src/csvDocumentView.ts](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/src/csvDocumentView.ts): opciones, lectura del buffer, parches de filas mediante `WorkspaceEdit`. |
| Interacción CSV | [out/csv.js](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/out/csv.js): objetos por registro, binding por letra, mapeo de filas visuales al origen y conteo de saltos internos. |
| Proveedor Excel | [src/excelEditor.ts](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/src/excelEditor.ts): `CustomEditorProvider`, save/save-as/revert/backup y delegación de undo/redo. |
| Interacción Excel | [out/excel.js](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/out/excel.js): FlexSheet carga el libro y produce los bytes para guardar. |
| Composición Excel | [src/excelDocumentView.ts](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/src/excelDocumentView.ts): scripts locales y comunicación de edición/refresco. |
| Estado y recuperación de previews | [src/baseDocumentView.ts](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/src/baseDocumentView.ts), `serializer.ts`, `documentViewManager.ts`, `legacyDocumentView.ts`, `dispose.ts`: workspaceState, setState/getState, recreación de paneles, mensaje para versiones antiguas y listeners. |
| Controles activos | `wijmo`, `input`, `grid`, `grid.filter`, `grid.sheet`, `grid.xlsx`, `xlsx`, todos en [out/controls](https://github.com/wijmo/gc-excelviewer/tree/5dbc384d5d17cde2aba1a02366a479bafcec98f2/out/controls), build 5.20213.824; JSZip y CSS locales. |
| Superficie publicada e historial | [package.json](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/package.json), [README](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/README.md), [CHANGELOG](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/CHANGELOG.md). |

`src/license.ts` configura la licencia Wijmo. Se comprobó su función y los encabezados de los controles; no reproducir su clave. La [licencia raíz](https://github.com/wijmo/gc-excelviewer/blob/5dbc384d5d17cde2aba1a02366a479bafcec98f2/LICENSE.txt) contiene MIT, pero los controles distribuidos indican **GrapeCity Commercial License**. Tener acceso al repo no convierte esos controles en dependencias open source. Nuestra v2 debe reproducir comportamientos útiles con implementación propia y componentes permisivos, conservando los avisos de las dependencias que realmente incorpore.

### 15.2. Cómo obtiene su ventaja

**CSV:** un FlexGrid recibe registros como objetos con propiedades A/B/C…, de modo que encabezados repetidos no colisionan. La colección permite ordenar/filtrar sin perder la identidad del registro. Al editar o pegar, la interfaz identifica el registro original y sus líneas físicas, incluyendo saltos internos; el host parchea el buffer textual. Esto integra dirty/save/historial textual con VS Code. Sus límites son la inferencia numérica, el parseo basado en regex y la complejidad de mantener offsets al ocultar registros.

**XLSX:** FlexSheet tiene su propio modelo de libro, motor de fórmulas, formatos y geometría. Cargar delega en el importador Wijmo; guardar reconstruye el libro desde el modelo visual y devuelve bytes al host. Las acciones estructurales y de edición generan historial en el control. Esta integración entrega muchas interacciones sin que el autor programe cada una, pero no demuestra preservación de partes desconocidas. Nuestro modelo crudo y los parches de XML ofrecen una base distinta: mayor control de la fidelidad, con más trabajo explícito de UI y metadatos.

**Continuidad:** persiste layout/filtros/orden/scroll y recupera previews. En Excel la persistencia explícita del wrapper corresponde a la hoja seleccionada, no a un historial independiente de todas las hojas. En CSV valida cantidad y etiquetas de columnas antes de restaurar. Nuestra propuesta debe restaurar cada hoja y validar identidad sin depender de etiquetas duplicadas.

**Sensación de herramienta terminada:** filtros desde encabezados, selección de rangos, clipboard, autoajuste de multilinea, navegación con teclado, tablas y pestañas de hojas, colores de tema y vías de apertura accesibles. No basta con añadir botones de ordenar/filtrar para alcanzar ese nivel.

**Limitaciones observadas de la referencia:** README declara que ya no se mantiene activamente; numerosas versiones del changelog actualizan licencia. El devcontainer usa Node 8 y las fuentes tienen tipado poco estricto. Webpack define dos targets con el mismo destino `dist/extension.js`, por lo que nuestro build debe separar salidas Node/Web. El wrapper solicita bytes a la webview sin timeout/limpieza explícita de callbacks. El README describe Shift+click multicolumna, pero el FlexGrid distribuido parte de `AllowSorting.SingleColumn` y `out/csv.js` no lo cambia: esa paridad documentada debe verificarse en host, no darse por demostrada. Nuestra v2 habilitará multicolumna explícitamente. `getState()` Excel escribe `columnIndexvar`, mientras la restauración lee `columnIndex`: discrepancia estática que no debemos replicar. La carga de XLSX permite HTML en celdas y usa scripts inline; nuestra UI debe seguir renderizando datos como texto y mantener su CSP.

### 15.3. Inventario de funciones, brecha y decisión v2

Leyenda: **E** = conectado explícitamente por el wrapper/manifiesto; **C** = capacidad del control activo, defaults o ruta integrada inspeccionada, pendiente de prueba completa en host; **H** = documentada en historial. Cada función tiene decisión y etapa; lo diferido permanece visible, no se omite.

| ID | Función de referencia / evidencia | Situación local y ventaja de referencia | Decisión y etapa |
| --- | --- | --- | --- |
| F01 | CSV/XLSX, TSV/TAB y XLSM; XLS no admitido (E) | CSV/XLSX/ODS; falta extensión tabulada y XLSM. | TSV/TAB en V2-03; XLSM lectura en V2-22. Conservar ODS. |
| F02 | Explorer, título, contexto de pestaña, paleta, atajo de preview (E) | Solo comando Explorer y Open With. | V2-04; comando/atajo descubre recurso activo. |
| F03 | Editor CSV opcional, Excel predeterminado; asociación por idioma (E) | Un editor opcional para todos. | Mantener elección por usuario; explicar `workbench.editorAssociations`, V2-04. |
| F04 | Preview solo lectura separado del editor (E) | Falta modo explícito de inspección. | Parte necesaria de V2-04, no relegarla a un extra sin especificación. |
| F05 | Preview de texto con extensión arbitraria; CSV/TSV/Rainbow CSV y stdin (E/H) | Parseo depende de extensión y disco. | V2-04/V2-21: snapshot del buffer sin cambiar el tipo de archivo ni guardar sobre él. |
| F06 | Live CSV sobre TextDocument sucio, WorkspaceEdit y Save nativo (E) | Nuestro CustomDocument controla bytes y conflicto, pero no integra simultáneamente texto sucio. | Preview de buffer en V2-04; edición textual simultánea requiere resolver conflicto, no migración automática de proveedor. |
| F07 | Refresco, limpiar estado, panel reutilizado/restaurado, configuración reactiva (E) | Recarga y deduplicación existentes; sin preferencias persistentes. | V2-06/V2-21; conservar recarga y distinguir restablecer vista. |
| F08 | Separador, quoteMark, headers/capitalización, `sep=`, comments y skipComments (E) | Autodetecta coma/punto y coma/tab; comilla doble fija. | Dialectos V2-03 y encabezados/comentarios V2-05. Capitalización solo visual opcional. |
| F09 | Ceros, formatos numéricos always/never/unquoted, tipo por columna (E) | Ventaja visual, con riesgo de conversión. Nosotros preservamos texto. | V2-07/V2-15: comparación y presentación explícitas, crudo por defecto; no inferencia destructiva. |
| F10 | LineNumbers none/ordinal/source (E) | Coordenadas originales fijas. | V2-05: origen por defecto, ordinal solo etiqueta secundaria; definir líneas físicas con multilinea. |
| F11 | Orden simple; multicolumna/Shift documentados con discrepancia de default; limpieza (E/H) | Ausente. | V2-07, estable y exclusivamente de vista. |
| F12 | Filtro por valores con búsqueda/select-all y dos condiciones AND/OR; operadores por tipo (E/C) | Ausente. | V2-08; cubrir valores y condiciones, no solo “contiene”. |
| F13 | Anchos manuales, autoajuste none/first/all, alto por multilinea visible (E/C) | Tamaños manuales en memoria; sin autoajuste. | V2-09/V2-06; medición acotada y respeta ajustes manuales. |
| F14 | Grid virtualizado, scroll, headers sticky, foco, ARIA y navegación (C/E) | Virtualiza filas, recrea celdas y tiene flechas básicas. | V2-09/V2-19; virtualización en ambos ejes, IME y foco estable. |
| F15 | Selección de rangos, copiar/pegar, teclado Tab/Enter/Home/End/Page (C/E/H) | Una celda, doble clic y editor de detalle. | V2-10/V2-11/V2-13; clipboard y navegación comparables. |
| F16 | Editar celda y pegar valores, Save/Save As/undo/redo/backup/hot exit (E/C) | Base existente; falta batch transaccional. | V2-00/V2-12/V2-13; no duplicar ciclo de guardado. |
| F17 | Añadir registro y borrar filas CSV, incluyendo multilinea/filas ordenadas (E/H) | No hay cambios estructurales. | V2-14; insertar/añadir/eliminar registros con bytes ajenos conservados. |
| F18 | Insertar/borrar filas y columnas XLSX mediante menú contextual (C/H) | No hay operaciones estructurales. | V2-17, primero perfil tabular seguro; expansión con referencias en V2-18. |
| F19 | Cambiar hojas por tabs, nombre/visibilidad y geometría del libro (E/C) | Selector y matrices; no geometría/estado de visibilidad. | V2-15/V2-16, tabs navegables y selector como respaldo. |
| F20 | Fórmulas XLSX editables, cálculo, lista de funciones y referencias entre hojas (C) | Cálculo visual y fórmula protegida; fallos pendientes. | V2-01/V2-20; motor abierto existente y edición normal delimitada. |
| F21 | Estilos, formatos, alineación, bordes, tamaño de filas/columnas, celdas combinadas y panes importados (C) | Se preservan partes, pero la tabla ignora presentación. | V2-15/V2-16: vista libro optativa además de crudo. |
| F22 | Tablas XLSX importadas y opción Convert To Table del menú (E/C) | Tablas se advierten, sin representación. | Lectura V2-15; creación/edición semántica en V2-24. |
| F23 | Drag/fill de celdas y series, formatos de relleno; referencias relativas (C) | Ausente. | Rellenar valores V2-23; fórmulas relativas tras V2-18/V2-20. |
| F24 | Cut/mover rangos, borrar contenido, drag de filas/columnas (C) | Ausente. | Borrado batch V2-13; movimientos/cut estructurales V2-24, sin acción prematura en UI. |
| F25 | Renombrar hoja por doble clic del control; botón nueva hoja eliminado y contextmenu sobre `li` interceptado (C/E) | Solo navegar. | V2-24 para gestión de hojas; no atribuir creación/borrado de hojas como flujo plenamente habilitado en la referencia. |
| F26 | Hyperlinks/notas/nombres definidos y macros conservables por importador (C) | Advertencias generales, sin detalle. | Metadatos V2-15; vínculos clicables explícitos; macros jamás ejecutar. Fidelidad a verificar, no garantía del importador. |
| F27 | Themes, selección, bandas alternas, filtros, multilinea y contraste (E/C) | CSS tematizado, revisión manual pendiente. | V2-09/V2-16: oscuro/claro/alto contraste y accesibilidad. |
| F28 | VS Code Web, remoto, virtual/untrusted workspaces (E/H) | workspace.fs ya usado; bundle Node y capacidades sin certificar. | V2-22: targets separados y matriz de proveedores. |
| F29 | Funciones XLSX como `freezeAtCursor`, mergeRange, estilo programático (C) | No toolbar equivalente. | Leer panes/merges V2-16; freeze de vista configurable V2-09. Edición avanzada V2-24. |
| F30 | Icono, categorías, keywords, documentación, ejemplos y packaging (E) | Texto del manifiesto mínimo, sin VSIX validado. | V2-25; documentación exacta y paquete instalable. |
| F31 | Charts, OLAP, barcode, PDF, cloud, search especializado, undo genérico y touch en bundles no cargados | No son flujos activos por estar en la carpeta. | No prometerlos en v2 por esta referencia; no transportar sus bundles. |

Ventajas actuales que debemos conservar: ODS, crudo explícito, precisión léxica, edición CSV localizada, controles de conflicto sobre bytes y separación entre fórmula/caché/cálculo. Búsqueda literal con contador y navegación A1 propias no deben desaparecer al incorporar controles nuevos. Los límites locales son una diferencia medible; la ausencia de un límite explícito comparable en el wrapper de referencia no prueba que pueda abrir cualquier tamaño.

### 15.4. Pruebas realizadas y hallazgos de nuestra base

Se ejecutaron funciones de referencia en un sandbox Node `vm`, sin cargar UI ni ejecutar la clave comercial: `parseContent` de `out/csv.js` y, con imports simulados, `setCellValue` de `csvDocumentView.ts`. Se contrastaron con parsers compilados locales en `out/formats/`; estas pruebas acotadas no sustituyen suites ni pruebas de guardado en VS Code. Los casos y salidas permiten reproducir los hallazgos con el commit fijado.

| Caso aislado | Referencia | Nuestro MVP | Consecuencia |
| --- | --- | --- | --- |
| Archivo vacío | `parseContent('')` falla al leer `lines.length` de null. | Tabla 0×0. | Mantener tratamiento de vacío y cubrir nuevos dialectos. |
| Modo `always`: `00123`, `9007199254740993` | Produce 123 y 9007199254740992. | Mantiene ambas cadenas. | Mostrar formatos sobre copias de presentación. |
| `sep=|` seguido de `a|b` y `1|2` | Usa pipe y omite directiva en tabla. | Tres registros de una columna. | Añadir directiva preservada, sin regex de separador. |
| `# hello` con skipComments | Omite el comentario. | Lo muestra como registro. | Clasificar/ocultar sin borrar del archivo. |
| Registro vacío entre dos datos | Parser de referencia lo omite en la prueba. | Conserva `['']`. | Conservar registros vacíos al filtrar o editar. |
| Encabezados `x,x` | Dos columnas gracias a bindings distintos. | Dos columnas por índices. | Nunca usar texto del encabezado como identificador. |
| Edición `a,"b"` | `setCellValue` produce comillas internas sin duplicar. | El escritor local duplica comillas. | No replicar su escritor; regression de quoteMark. |

Se probaron los ocho XLSX de `data/` de la referencia con nuestro parser compilado: siete devuelven hojas; `AdventureWorks Sales.xlsx` se rechaza por superar 10 MiB. `ElectricityGeneration.xlsx` aporta un caso real de 35 290×5; `Demographics.xlsx`, 1 791×12; `Financial Sample.xlsx`, 701×16. Los avisos de tablas/estructuras aparecen en seis de los siete libros leídos. Esto verifica lectura acotada, no fidelidad tras escritura ni todos los valores de esos libros. Para pruebas permanentes crear fixtures propios o conservar procedencia/licencia de cualquier muestra externa incorporada.

Se comprobó además la API **instalada** de Formualizer 0.10.1 en un bundle temporal Webpack para Node 18 con `asyncWebAssembly` y salida ESM, fuera del repo. `parse("=SUM('Ventas 2026'!$B2:C$5)+\"B2\"")` devolvió referencia con sheet/flags absolutos y spans `[5,26)`; el literal `"B2"` tuvo span separado `[28,32)`. `=$B2+C$1` distinguió correctamente flags por coordenada. `=A1+` rechazó con `Parser error: Unexpected end of tokens...`, lanzado como string; normalizar con `String(error)` cuando no sea Error. Esto demuestra una ruta real para V2-18A, no una API de reescritura global del libro ni precisión del evaluador.

La inspección local incluye fuentes, adaptadores, protocolo, webview, CSS, pruebas y build. Hallazgos a resolver antes de ampliar edición:

- **Límite XLSX absorbido:** `parseXlsxBytes` atrapa errores de `parseSheet` y retorna hoja vacía con warning. Un fixture con A50001 devolvió 0 filas y aviso, en vez de rechazar el libro. Contradice el rechazo completo prometido. Separar errores fatales de límites/integridad de características no soportadas; V2-00.
- **ODS repetido:** al clonar filas repetidas se conserva `ref` de la primera fila. Una fórmula repetida dos veces devolvió solo caché A1, faltando A2. Falta además contador agregado de celdas de todo el archivo, aunque existe por hoja; V2-00.
- **ODS real con colas vacías repetidas:** la comprobación de filas/columnas puede rechazar colas vacías largas comunes en LibreOffice; recortar expansión vacía sin saltar contenido fuera del rango. No elevar límites ni ignorar filas con fórmulas; V2-00.
- **Tipos editables en UI:** el protocolo expone kinds, pero no permisos/tipos completos; la webview deshabilita fórmulas solamente. Error, unsupported, protección y covered cells requieren capacidades de edición explícitas; V2-02.
- **Draft y hot exit:** `panelDrafts` guarda texto no confirmado, pero backup serializa solo `editSession`; un cierre normal intenta aplicar el draft al disponer el panel. Debe probarse y definirse recuperación de draft, cierre con Escape y Save antes de que el panel desaparezca. No depender de callbacks de dispose para salvar texto; V2-00/V2-12.
- **Restauración tras cambios externos:** el backup actual reabre tomando disco actual como baseline. Recuperar un borrador de un archivo que cambió requiere detectar ese conflicto, no aceptar automáticamente esa baseline; V2-12.
- **Cancelación y limpieza:** save/revert/backup reciben tokens hoy ignorados; el proveedor no centraliza dispose de emitter/timers/listeners. Aumentar vistas sin cerrar esto puede mantener trabajo obsoleto; V2-00.
- **Serialización repetida:** dirty compara una copia serializada, `getRows` clona matrices y el snapshot de fórmulas reempaqueta por revisión. Esto puede multiplicar XML/ZIP/copias durante cada cambio. Medir y cachear por revisión; V2-19.
- **Cálculo:** módulo WASM retiene libro por revisión y no libera explícitamente al reemplazar; una identidad de documento evita colisiones si se comparte un worker. Sección 13 registra fechas/búsquedas/arrays incorrectos; V2-01/V2-19.
- **Recarga y logs:** se crean archivos `debug_spreadsheetviewer_*.txt` en workspace al recargar. Llevar diagnóstico a OutputChannel optativo y evitar escritura extra sobre workspaces de lectura; V2-00.

### 15.5. Producto competitivo y orden de entrega

La primera propuesta solo cubría exploración. Este roadmap incluye **experiencia de lectura, edición por rangos, estructura tabular, presentación de libros, fórmulas y hosts adicionales**. Para evitar un salto inmanejable, entregar en bloques verificables:

| Bloque | Etapas | Resultado |
| --- | --- | --- |
| A — Base fiable y exploración | V2-00 a V2-09 | Apertura/previews/dialectos, estado persistente, orden/filtros, geometría y teclado robustos. |
| B — Edición cotidiana | V2-10 a V2-14 | Rangos, clipboard, pegado/borrado transaccional, estructura CSV, historial y recuperación. |
| C — Experiencia de libro | V2-15 a V2-20 | Metadatos, vista libro, estructura XLSX delimitada, referencia de fórmulas y rendimiento. |
| D — Integración y alcance | V2-21 a V2-25 | stdin, hosts/formatos adicionales, autofill, edición avanzada delimitada y distribución. |

**V2 de escritorio competitiva:** A+B+C, más V2-21, V2-23 (valores), V2-25. Se distinguen lectura/edición cotidiana de paridad ampliada de acciones; las versiones parciales no deben llamarse paridad completa con el control. **Paridad ampliada Web/XLSM y edición avanzada:** V2-22/V2-24A–D y extensiones explícitas de V2-18/V2-23. Publicar un bloque temprano no implica declarar paridad completa. Cada diferencia restante se documenta; no sustituir capacidades por simples warnings o maquillar límites.

Macros ejecutables, gráficos/pivots interactivos, colaboración y XLS quedan fuera: no son una brecha demostrada de los flujos activos que debemos reproducir. ODS conserva lectura/edición tabular y capacidades comunes; presentación ODF y estructura avanzada ODF deben tener etapas propias de paridad posterior, no reutilizar sin pruebas las reglas XLSX.

### 15.6. Decisiones técnicas resueltas

1. Mantener TypeScript, VS Code custom editor, DOM/CSS y nuestros adaptadores `fflate`/`xmldom`/Papa Parse. **No copiar código/bundles/claves de Wijmo ni migrar todo el proyecto.** La tabla será una capa reemplazable; documentos, operaciones y serialización no dependerán del renderer.
2. Mantener Formualizer 0.10.1 como base hasta completar V2-01. Sus declaraciones instaladas exponen Parser/Tokenizer, Workbook.setFormula/evaluateCell/inspectCell y free; no exponen una API verificada de insertar filas con reescritura global de referencias. No inventar ese método. Resolver cálculo con fixtures; no reemplazar el motor ni implementar mini-Excel mediante regex como atajo.
3. Usar **decimal.js (MIT)** para comparación numérica exacta y sumas de rangos, pasando lexemas como cadenas y comprobando límites/finitud. Fijar versión compatible al implementar V2-07; no cambiar textos originales. Fuente: [proyecto decimal.js](https://github.com/MikeMcl/decimal.js) y [licencia](https://github.com/MikeMcl/decimal.js/blob/master/LICENCE.md).
4. Usar **SSF (Apache-2.0)** únicamente para formateo visual de formatos XLSX en V2-16; no usarlo como parser/escritor de libro. Si requiere `Number`, indicar aproximación o mostrar crudo cuando la conversión pierde precisión; conservar serial y metadatos de fecha. Fuente: [SSF](https://github.com/SheetJS/ssf) y [licencia](https://github.com/SheetJS/ssf/blob/master/LICENSE). Validar tipos/build del paquete elegido en esa etapa.
5. Se consideraron [AG Grid Community](https://github.com/ag-grid/ag-grid) (MIT, separado de Enterprise) y [Glide Data Grid](https://github.com/glideapps/glide-data-grid) (MIT, React). No se selecciona migración en esta v2: introducir framework o depender de funciones de otra edición ampliaría el alcance y no resuelve fidelidad del archivo. Mantener grid propio exige inversión real en accesibilidad/virtualización; V2-19 debe aportar evidencia y la interfaz de renderer permitirá una evaluación futura sin rehacer datos.
6. Añadir **tests puros ejecutables sin Extension Host** para los módulos nuevos, aprovechando Mocha instalado y compilación TS existente. Un `test:unit` propuesto ejecuta solo archivos puros compilados enumerados, nunca carga tests que importan `vscode`. Mantener `npm test` para integración; no confundir éxito de unit con éxito de host. No añadir otra biblioteca de tests sin necesidad.
7. Operaciones de lectura/vista no ensucian ni serializan. Operaciones de edición son transacciones documentales, no eventos por celda. Extensión valida y es autoridad; webview envía intenciones y recibe confirmación. Guardar sigue pasando por VS Code y la cola actual.
8. Todo recurso y worker se empaqueta localmente; no CDN ni servidor en localhost. Separar bundle Web de extensión, bundle webview y worker de cálculo. CSP con nonce, `textContent`, URLs validadas y `localResourceRoots` mínimos; no activar HTML para reproducir estilos.

### 15.7. Contratos que Luna debe implementar por etapas

#### Identidad, vistas y mensajes

Añadir un `documentId` estable durante una apertura y `revision` creciente. Añadir `sheetId` derivado de identidad del formato (relationship/sheetId en XLSX, identidad de tabla cargada en ODS, único en CSV); conservar `sheetIndex` solo como ubicación, no como clave persistente definitiva. Identificar cada panel mediante `viewId` y modo `edit|preview`. No usar basename, encabezado ni revisión sola como identidad global.

El modelo de vista tiene `viewRevision`, consulta, criterios, tamaños, scroll y selección. Cambiarlo no aumenta `document.revision`. Todos los mensajes de mutación nuevos llevan `{documentId, revision, sheetId, requestId}` y un payload limitado. Responder `{requestId, status: 'applied'|'rejected', revision, reason?}`; rechazar revisión obsoleta y pedir refresco. Mantener compatibilidad de los mensajes actuales hasta migrarlos en V2-02; no romper el arranque ni los validators al añadir campos.

La proyección expone `visibleRows: number[]` y `sourceToVisible: Map<number, number>`. Los índices apuntan al modelo original de la revisión recibida. Filtrar y ordenar jamás muta `rows`. Encabezados originales, referencias, fórmula/caché y edición usan fuente. La geometría recorre filas visibles, pero anchos y alturas manuales se guardan por columna/fila de origen. Ejemplo obligatorio: fila origen 54 visible en posición 1 → edición B54 modifica fila índice 53, columna índice 1.

#### Ordenamiento, filtros y búsqueda

Orden textual por comparación determinista de cadenas; opción sensible a mayúsculas. Numérico explícito por columna con decimal.js y regex decimal vigente, sin trim implícito; cota de lexema numérico 4 096 caracteres y exponente decimal entre −10 000 y 10 000 para evitar expansiones abusivas; vacíos al final en ambas direcciones, incompatibles en grupo final estable con aviso. Orden múltiple se aplica según prioridad de criterios; empates por índice fuente. No ordenar una columna por resultado de fórmula cambiante inicialmente: usar expresión cruda y explicarlo.

Filtros por columna: modo `values` con conjunto de valores crudos seleccionados (OR) o modo `conditions` con hasta dos cláusulas AND/OR. AND entre columnas. Operadores: igual/diferente/contiene/no contiene/comienza/termina/vacío/no vacío; numérico explícito permite >, >=, <, <=. No comparar fechas CSV automáticamente. Vacío incluye ausente y cadena vacía para filtrar, con detalle que los distingue. No usar etiquetas formateadas como claves de valor. Lista de valores con búsqueda y paginación de 200 elementos; búsqueda cubre todos, no solo primera página. Límite propuesto: 10 000 valores seleccionados y 64 KiB por criterio; al exceder, explicar y ofrecer condición.

Búsqueda por defecto en filas visibles y valores crudos; opción “Toda la hoja” conserva el comportamiento MVP. Contador y anterior/siguiente recorren orden visual o fuente según ámbito. Una coincidencia o referencia válida oculta ofrece mostrar quitando filtros; cancelar conserva selección. Referencia inválida mantiene **Celda inválida**. Cancelar generaciones antiguas tras edición, filtro, cambio de hoja o recarga. Al editar una fila que deja de coincidir, aplicar primero transacción y luego proyección; mover foco a la siguiente fila visible y anunciarlo.

#### Preferencias y configuración

`ViewStateV1`: versión 1, URI completa, modo, firma de esquema, hoja activa y mapa por sheetId. Cada hoja guarda consulta/ámbito, selección fuente, scroll/anchor, sort/filter, anchos y alturas **solo modificados**, freeze y presentación. Debounce 250 ms; flush al cerrar/cambiar de hoja. Propuesta de cotas: 256 KiB por archivo, 100 archivos con LRU por workspace; purgar preferencias viejas, nunca backups. Persistir en workspaceState; `getState/setState` guarda solo contexto efímero del panel. No incluir libros, matrices, cache de cálculo ni drafts en preferencias.

Firma tabular: formato/dialecto, cantidad de columnas, encabezado identificado y hash de su texto si está activo. Firma de hojas: sheetId/nombre/estructura; cambios de nombre se reconcilian por identidad. Cambio de filas conserva anchos/criterios compatibles, ajusta selección/scroll; cambio de columnas invalida filtros/sorts por columnas y avisa. No invalidar todo por un cambio de valor cualquiera. **Restablecer vista** limpia preferencias y proyección, conserva borrador e historial; **Recargar** vuelve a disco y mantiene la confirmación de descartar pendientes.

Configuración propuesta bajo `spreadsheet-viewer.*`: `csv.separator` (auto/coma/punto y coma/tab/pipe o carácter literal validado), `csv.quoteMark` (`"`, `'` o vacío), `csv.hasHeaders=false`, `csv.capitalizeHeaders=false`, `csv.skipComments=false`, `csv.commentPrefix="#"`, `csv.lineNumbers="source"`, `csv.openStdin=false`, `view.restoreState=true`, `view.autoSizeColumns="none"`, `view.wrapCells=false`, `view.presentation="raw"`, `save.mode="onCommit"` (alternativa manual explícita). Configuración por recurso vía `getConfiguration(..., uri)`; preferencias de vista por archivo prevalecen sobre defaults. Cambios de parseo con pendientes requieren resolver borrador antes de reinterpretar; cambios visuales no.

#### CSV: dialecto y preservación

`parseCsvBytes(bytes, options?)` conserva firma compatible cuando no hay options. Prioridad: elección explícita por archivo > TSV/TAB forzado > directiva `sep=X` válida al inicio > idioma CSV semicolon/pipe > configuración del recurso > detección. Si TSV contiene una directiva incompatible, explicar el conflicto y exigir elección, no escoger silenciosamente. Directiva se almacena como preámbulo con span original, no como fila de datos. Separador es un carácter literal distinto de CR/LF/comilla; no regex ni multi-separadores. Detección incluye pipe y detecta empates reales; ofrecer elección en vez de adivinar por ancho máximo.

Papa Parse y el scanner deben usar el mismo quoteMark/escapeChar. Comilla vacía desactiva quoting con validación coherente. No trim, tipado dinámico ni skipEmptyLines. `fieldSpans` sigue describiendo el original; ampliar registros con `start`, `end`, `terminatorEnd`, `sourceLineStart/End` y clasificación data/comment. Detectar comentarios solo al inicio de registro fuera de comillas, con prefijo literal y espacios previos definidos; conservarlos como filas de texto de solo lectura en el modelo, ocultables por proyección. Header es el primer registro data, queda editable en su fila de origen, fijado antes de ordenar y excluido de filtros de datos. Mantener directiva/BOM/comentarios/saltos al parchear.

#### Selección, clipboard y transacciones

`RangeSelection` guarda anchor/focus en posiciones de vista junto a coordenadas fuente/revisión. En la proyección cambiante, un rango se reduce a su celda activa si sus filas dejan de ser visibles; no expandirlo a filas ocultas. Shift+flechas/clic y arrastre extienden; headers seleccionan fila/columna; Ctrl/Cmd+A selecciona datos visibles. Panel muestra referencia activa y tamaño del rango; origen discontinuo se etiqueta, no se finge un rectángulo original.

Copiar exporta valores crudos en orden visible, sin headers salvo acción específica. TSV con CRLF entre registros, tab entre campos, quote doble si campo contiene tab/CR/LF/comillas y duplicación de comillas internas. Fórmulas se copian como expresión por defecto. Acción “Copiar valores mostrados” es separada. `copy/paste` nativo dentro de input/textarea mantiene su semántica; la tabla usa eventos clipboard y `text/plain`, no interpreta HTML. Fallback desde menú usa clipboard de VS Code mediante mensajes validados.

El snapshot vigente se obtiene del journal **junto con el modelo original**: rows, kinds, storedTypes, formulaCaches, existencia y editability deben reflejar todos los cambios confirmados. No reutilizar siempre `sheet.cellKinds` original después de crear/borrar fórmulas o cambiar tipo. Tipo almacenado y tipo editable son conceptos distintos; error/unsupported no se transforman por mostrarlos como texto. Para extender `CellValue`, usar unión discriminada: scalar `{kind:'value',value,type,storedType,exists:true}`, empty/missing con identidad distinta, formula `{kind:'formula',expression,cache?,formulaGroup?,exists:true}`, protected/unsupported con razón. Antes de V2-20 la rama formula es de lectura; después solo normal puede editarse. El historial conserva contenido completo before/after, incluida caché y estilo referenciado cuando corresponda.

`EditTransaction` contiene ID, etiqueta y lista de cambios `{sheetId,row,column,before,after}` con valor/tipo/existencia. Validar todos antes de mutar; una celda inválida rechaza el lote completo. Una transacción aumenta revisión una vez, emite un solo CustomDocumentEditEvent y permite undo/redo en un paso. Rechazar duplicados contradictorios. Límite inicial de pegado/borrado: 10 000 celdas y 1 MiB de texto, además de límites del documento. Un fallo conserva datos, selección y original; no ignorar silenciosamente las celdas protegidas.

Pegado: si selección es una celda, anclar bloque allí; si coincide con dimensiones del bloque, reemplazar; si clipboard 1×1 y rango mayor, rellenar rango. Otras combinaciones rechazan con explicación. Con filtros/sort, destinos son filas visibles capturadas **antes** de aplicar, no recalcular por cada celda. Sin expansión automática fuera de límites; ofrecer primero operación estructural. CSV siempre texto; XLSX/ODS conservan tipo y validan; conversión explícita se añade solo donde la etapa la autorice. Delete vacía texto CSV; en XLSX/ODS una operación explícita de clear conserva estilo y elimina valor tipado de forma válida, no escribe cadena vacía en celda numérica. Excluir fórmulas/protección/covered hasta contar con operación soportada.

Backup V2 debe guardar envelope versionado con formato, URI/identidad, baseline original o su evidencia suficiente para detectar cambios, snapshot confirmado y draft separado; no reemplazar baseline por disco actual sin comparar. Restaurar modelo y draft; si disco diverge, marcar conflicto y permitir copia. Soportar backups legacy con detección conservadora y migración; no borrar pendientes por tener otra versión de envelope. Los drafts no forman historial ni se serializan al original antes de confirmar.

#### Libro visual, fórmulas y estructura

Dos vistas: **Crudo** (default, comportamiento actual) y **Libro** (presentación optativa). Cambiar vista no transforma datos. Metadatos mínimos: sheetId/state, rowHeight, colWidth, hidden rows/cols, cell style index, numFmt, fonts/fills/borders/alignment/wrap, merge ranges, freeze panes, tablas/nombres/links/notas/protección y workbook date1904. CSS puede mantener colores VS Code sobre colores importados; no prometer réplica pixel-perfect. Panel siempre revela valor almacenado, tipo, fórmula, caché, cálculo y texto formateado separados.

Merges se presentan como rango con una celda ancla; covered cells no editables. Con merges activos, orden/filtro de todo el sheet requiere pasar a modo tabular que muestra coordenadas crudas y anuncia las combinaciones; no ordenar visualmente mitad de un merge. Hidden/veryHidden distinguidos en selector y control “Mostrar ocultas”; no abrir por defecto hoja veryHidden. Pane/filas/columnas ocultas son metadatos, no borrados. Links externos se abren solo por acción explícita, con protocolos permitidos; notas se renderizan como texto.

Formualizer procesa solo una copia. Función soportada exige resultado independiente correcto en fixtures, no nombre en catálogo ni estado calculated. Registro por familia: arithmetic/logic, aggregates, text, dates, lookup, financial, reference, arrays. Tomar como baseline el catálogo de 89 entradas del control distribuido, sin prometer compatibilidad solo por coincidir nombres: incluir SUM/SUMIF/SUMIFS, COUNT/COUNTA/COUNTIF/COUNTIFS, SUBTOTAL/SUMPRODUCT, IF/IFERROR/AND/OR, TEXT y DATE/YEAR/MONTH/DAY, VLOOKUP/HLOOKUP/INDEX/CHOOSE, INDIRECT/ADDRESS/ROW/COLUMN y RATE, además del conjunto ya probado. MATRICES modernas son brecha propia, no garantía del motor de referencia. Unsupported, fórmula mal formada, error real, cache-only y pendiente son estados diferenciados; `#NAME?` puede ser nombre desconocido real, no se convierte siempre en función incompatible.

Editar fórmula es operación explícita distinta de editar texto. Escribir `=texto` en CSV o en una celda string no crea una fórmula por inferencia. XLSX fórmula normal se guarda en `<f>` sin `=` inicial; quitar cache solo de la fórmula editada, marcar recálculo del libro y mantener cachés de otras fórmulas conforme al contrato actual. Actualizar/eliminar calcChain y relaciones/content-types coherentemente cuando sea necesario. No guardar resultados calculados. Shared/array/dataTable/dynamic/external formulas requieren tratamiento propio; no modificar una celda de un grupo como fórmula normal.

Estructura XLSX empieza en perfil tabular: sin fórmulas en ninguna hoja, nombres definidos, tablas, merges, validaciones, hyperlinks, conditional formatting, dibujos, protección, firmas, vínculos externos ni referencias desconocidas que puedan desplazarse. Incluir estilos de celdas simples y geometría soportada. Inventariar paquete/nodos antes de habilitar acción. Copiar partes no tocadas; actualizar r de row/c, dimension/spans, filas/columnas y metadata soportada. Si el libro no cumple, bloquear **esa operación estructural** con razón y mantener la edición de celdas permitidas. No bloquear todo archivo por una tabla cuya parte podemos preservar en una edición normal.

Extensión con fórmulas usa AST/tokens y spans de fuente para desplazar referencias; no regex global. Inserción estructural desplaza referencias a celdas movidas aunque tengan `$`; copiar fórmula sí respeta `$` en ajuste relativo. Prueba obligatoria: insertar antes de B2 mueve `$B$2` a `$B$3`, mientras copiar `=$B2+C$1` a una fila abajo conserva columna absoluta y fila absoluta correspondiente. Referencia eliminada produce `#REF!` válido; strings que contienen “B2” no cambian. Si las declaraciones/API disponibles no permiten representar una sintaxis, registrarla como bloqueada y no inventar una reescritura.

### 15.8. Mapa de archivos para implementación incremental

| Archivo | Responsabilidad / cuándo introducir |
| --- | --- |
| `src/model.ts` (nuevo) | Tipos comunes e identidades/capacidades. V2-02; no importar DOM ni vscode. |
| `src/table-view.ts` (nuevo) | Proyección fuente↔vista, header/comment/hidden, sort/filter y selección reconciliada. V2-05/07/08. |
| `src/view-state.ts` (nuevo) | Validación/versionado/persistencia y LRU. V2-06; almacenamiento inyectado. |
| `src/operations.ts` (nuevo) | Transacciones de celda/rango/clear y preflight. V2-12. |
| `src/clipboard.ts` (nuevo) | Parse/serialize TSV puro. V2-11. |
| `src/formats/csv.ts` | Dialecto, spans y estructura CSV. V2-03/14. |
| `src/formats/xlsx-metadata.ts` (nuevo) | Metadata/capabilities de libro y matriz de restricciones. V2-15. |
| `src/formats/xlsx-structure.ts` (nuevo) | Operaciones estructurales y preflight, sin mezclar con renderer. V2-17/18. |
| `src/formula-reference.ts` (nuevo) | Ajuste AST/spans validado para traslado/copia. V2-18. |
| `src/webview/grid.ts`, `selection.ts`, `layout.ts` (nuevos) | Extraer renderer/navegación/geometría en V2-02/09/10; cada extracción conserva comportamiento y compile. |
| `src/webview/presentation.ts` (nuevo) | Formateo/estilos seguros de vista; V2-16. |
| `src/webview/formula-worker.ts` (nuevo) | Worker acotado por documento/revisión, resultados/cancel/free; V2-19. |
| `src/preview.ts` (nuevo) | Ciclo de panel de lectura, buffer y serializer; V2-04. |
| `src/extension.ts`, `editor.ts`, `document.ts`, `protocol.ts`, `storage.ts`, `edit-model.ts` | Adaptar infraestructura existente; una autoridad documental, no segunda implementación de guardado. |
| `src/test/*`, `scripts/*`, README/CHANGELOG, build y manifiesto | Tests propios, comandos focalizados, documentación y recursos distribuibles por etapa. |

No crear todos los archivos al inicio. Los nombres son destinos propuestos; reutilizar un módulo equivalente ya existente. Una extracción por solicitud es preferible a rehacer los 1 031 renglones actuales de `main.ts` de una vez. Nunca editar `dist/` ni `out/` manualmente.

### 15.9. Tarjetas de trabajo para GPT Luna 6 (esfuerzo medio)

Las tarjetas V2-00A, V2-00B, V2-01A, V2-01B, V2-02A, V2-02B y V2-03 están **implementadas**. V2-04A y V2-04B tienen la implementación lista; ambas conservan pendiente la verificación en Extension Host/F5. Las demás siguen pendientes. Cada tarjeta indica una unidad de implementación; las subtarjetas A/B/C/D requieren solicitudes separadas. La existencia de una propuesta de arquitectura no es evidencia de que la dependencia ya esté implementada.

**Orden recomendado de solicitudes (dependencias resueltas):** V2-00A → 00B → 01A → 01B → 02A → 02B → 03 → 04A → 04B → 05 → 06 → 07 → 08A → 08B → 09 → 10 → 11 → 12A → 12B → 13 → 14A → 14B → 15A → 15B → 16A → 16B → 17A → 17B → 18A → **20A → 20B → 18B** → 19A → 19B → 21 → 22A → 22B → 22C → 23A → 23B → 24A → 24B → 24C → 24D → 25. Cada número abreviado conserva prefijo `V2-`. 22B/22C y 24A–D son bloques ampliados; si no forman parte del release elegido, 25 debe documentarlos pendientes. 24E es registro de límites, no implementación del estándar completo. No seguir el número a ciegas: 18B requiere 20A.

#### V2-00A — Carga íntegra y límites

**Depende de:** MVP. **Archivos:** parsers XLSX/ODS y tests de formatos. **Pasos:** crear fixtures propios A50001 y ODS fórmula repetida; introducir error fatal diferenciado y propagar límites/integridad del sheet al libro; permitir solo lectura explícita para incompatibilidad real si es representable, nunca sustituir hoja rota por vacía editable. Corregir refs ODS al expandir cada fila y contador agregado de celdas. Recortar únicamente colas ODF vacías después de examinar repetición/tipo/fórmula, conservando spans para escribir.

**Aceptación:** A50001 rechaza todo; ODS dos fórmulas repetidas tiene A1/A2; múltiples hojas excediendo total se rechazan; cola vacía válida no crea millones de celdas; cola con contenido fuera de límite sí rechaza; edición de celda repetida no cambia hermanas. **Fuera:** aumentar límites, nuevos formatos o UI nueva. **Checks:** test focalizado de formatos, check-types y lint.

#### V2-00B — Ciclo de vida y diagnóstico

**Depende de:** V2-00A. **Archivos:** editor/storage/extension y tests. **Pasos:** centralizar dispose de watchers/listeners/emitter/timers; comprobar tokens antes de trabajo/escritura y antes del punto de reemplazo, sin declarar cancelación si ya se completó rename; coordinar recarga/revert con guardado en curso; reemplazar logs por OutputChannel optativo; probar draft/blur/Escape/dispose y documentar defectos antes de V2-12.

**Aceptación:** abrir/cerrar diez veces no conserva timers/listeners; cancelar save conserva original y borrador cuando no hubo commit; recarga no genera archivos debug; permisos/rename fallido preservan original y temporales se limpian. **Fuera:** cambiar modo de autosave por defecto. **Checks:** storage/proveedor focalizado, compile; revisar cierre y recarga en Host.

#### V2-01A — Exactitud y diagnóstico de fórmulas

**Estado:** implementada el 2026-10-10.

**Depende de:** V2-00A. **Archivos:** calculador/test-formulas/fixtures. **Pasos:** reproducir puntos sección 13 con fixture pequeño por defecto; comparar cache/XML y resultado independiente para aislar importación frente a evaluación. Probar identidad de libro y liberar WASM anterior. Crear registro de soporte por familias; distinguir función no implementada, nombre inválido, error real y derrame no soportado. No corregir resultado con sustituciones de texto arbitrarias.

**Aceptación:** las expectativas incorrectas de caracterización de TEXT-fecha y búsquedas se reemplazan por expectativas correctas después de validar la solución; NA sigue error real; AGGREGATE/LAMBDA no se presentan como correctas; dos libros con la misma revisión no comparten resultados; edición recalcula dependientes. Un defecto upstream sin solución queda `unsupported/cache-only` explícito para el caso afectado, no calculated falso. **Fuera:** prometer todas las funciones ni tocar cachés originales. **Checks:** `test:formulas` y tipos/lint afectados.

#### V2-01B — Matriz de funciones competitiva

**Estado:** implementada el 2026-10-10.

**Depende de:** V2-01A. **Archivos:** fixtures de fórmulas, tests y README. **Pasos:** añadir expectativas pequeñas independientes para las familias listadas en 15.7, con references entre hojas, ceros/strings, lookup exacto, errores y fechas 1900/1904. Registrar soporte real de cada función ejercitada. Arrays/spill quedan con regla explícita de visualización o incompatibilidad; no crear celdas guardadas de un derrame visual.

**Aceptación:** tabla documentada función/caso/resultado/limitación; fixture grande conserva cobertura de conteo, pero no se usa como certificación. Volátiles se verifican con reloj/valores acotados, sin expectativas que dependan de la fecha real. **Fuera:** cambiar motor sin análisis nuevo ni escribir tests de miles de funciones sin necesidad.

#### V2-02A — Modelo común, capacidades e identidad

**Estado:** implementada el 2026-10-10. La etapa expone capacidades de tipos ya reconocidos por los parsers; las celdas cubiertas dependen de metadata de merges que se incorpora en V2-10.

**Depende de:** V2-00B. **Archivos:** model/protocol/document/editor/adaptadores y tests. **Pasos:** introducir documentId/sheetId y metadata mínima de tipo/editabilidad; migrar mensajes con discriminantes claros conservando startup; validar revisión/coordenadas/sheetId; exposición de permisos desde host a webview. El host revalida aunque UI deshabilite. Cambiar de hoja no cambia identidad del documento.

**Aceptación:** edits tardíos rechazados, celda error/unsupported/covered se muestra con razón; solo message válido muta; cache/fórmula/kind no confundidos; fixtures MVP siguen iguales. **Fuera:** sort, filtros, rango y serialización nueva. **Checks:** parsers/protocol tests, compile y arranque F5.

**Checklist de implementación**

- [x] Añadir `documentId` estable durante la vida del documento y `sheetId` por hoja.
- [x] Llevar identidad y revisión en los mensajes de edición, borrador y selección de hoja.
- [x] Rechazar en el host mensajes con identidad/revisión desactualizada y coordenadas inválidas.
- [x] Publicar tipos almacenados y capacidades de edición; la webview respeta la capacidad y el host vuelve a validarla.
- [x] Mostrar motivo para tipos `error` y `unsupported`, manteniendo separadas fórmula, caché y tipo.
- [ ] Leer metadata de celdas cubiertas y mostrar su motivo; depende de los merges de V2-10.
- [x] Pasar compilación, tipos y lint; los tests de formatos pasan.
- [ ] Añadir/ejecutar tests específicos de protocolo y verificar el arranque F5.

#### V2-02B — Extraer renderer y selección sin cambios de producto

**Estado:** implementada el 2026-10-10. Renderer y selección residen en módulos separados; el editor inline conserva su nodo activo durante scroll y cambios de layout.

**Depende de:** V2-02A. **Archivos:** main/grid/selection/layout/styles. **Pasos:** sacar renderGrid y utilidades geométricas de main; inyectar snapshot/selection callbacks; mantener renderer independiente del formato. No recrear textarea activo por scroll/recalcular; preservar focus/selectionStart/IME. Dejar main como coordinación, sin nuevo framework.

**Aceptación:** misma tabla/edición/referencia/búsqueda/resize que MVP; escribir con IME y hacer scroll no confirma ni duplica texto accidentalmente; compile/check-types:webview/lint. **Fuera:** nueva apariencia, worker o virtualización horizontal todavía.

**Checklist de implementación**

- [x] Extraer renderer a `webview/grid-renderer.ts` con snapshot y callbacks inyectados.
- [x] Extraer selección a `webview/selection.ts` y utilidades geométricas a `webview/grid-layout.ts`.
- [x] Conservar el nodo del editor inline mientras está enfocado durante scroll y refrescos de layout.
- [x] Mantener referencias, búsqueda, edición y redimensionamiento conectados al coordinador `main.ts`.
- [ ] Verificar manualmente escritura IME, caret/foco y scroll en F5.
- [x] Pasar `check-types`, `lint` y compilación de webview.

#### V2-03 — TSV/TAB y dialectos CSV

**Estado:** implementada el 2026-10-10. Si la autodetección empata, la apertura pide el delimitador; la opción se conserva en el documento y se escribe en `sep=` al editar un archivo elegido manualmente.

**Depende de:** V2-02A. **Archivos:** csv/document/editor/manifiesto/formats tests. **Pasos:** extender selector y format resolver; options común parser/scanner/writer; prioridad de dialecto 15.7; conservar `sep=` como preámbulo; detection pipe/ambigüedad y UI de elección. Implementar quoteMark sin regex de separador. Inyectar parse options para serialize/reopen/backup, no reparsear usando autodetección distinta.

**Aceptación:** TSV/TAB mayúsculas, separator pipe, single quote, quoting desactivado, `sep=;`, directiva con BOM, multilinea/CRLF y guardar-reabrir idénticos salvo campo editado; empate solicita elección; cambio con pendientes no descarta. **Fuera:** ocultar comentarios ni copiar/pegar. **Checks:** pruebas formats y comando/apertura.

#### V2-04A — Descubrimiento y comandos

**Estado:** implementación lista el 2026-10-10; pruebas en Extension Host y verificación F5 pendientes porque VS Code Test no pudo descargar VS Code en este entorno (fallo DNS).

**Depende de:** V2-03. **Archivos:** extension/editor/manifiesto/tests. **Pasos:** comando actual acepta URI o recurso activo compatible; añadir título/contexto de tab/paleta y keybinding acotado; botones/iconos locales; documentar asociación XLSX opcional sin imponerla a CSV/ODS ni cambiar viewType existente. Mantener deduplicación de aperturas.

**Aceptación:** sin URI válida mensaje útil; dos llamadas simultáneas una vista; tab movido se revela; comandos no capturan typing ni atajos ajenos; apertura con extensión arbitraria no se escribe mediante parser equivocado. **Fuera:** preview y resolver dirty textual todavía. **Checks:** integración de manifiesto/apertura y F5.

**Checklist de implementación**

- [x] El comando acepta URI explícito y, si se omite, resuelve el recurso de la pestaña/editor activo.
- [x] Rechazar recursos desconocidos con mensaje útil antes de llamar al proveedor.
- [x] Mantener deduplicación concurrente por URI y revelar la pestaña existente.
- [x] Exponer el comando en Explorer, título del editor, menú de pestaña y paleta.
- [x] Añadir atajo con modificadores y contexto limitado a extensiones compatibles.
- [x] Añadir icono local; mantener asociación de custom editor opcional.
- [x] Documentar la asociación opcional XLSX sin cambiar la vista predeterminada de CSV/ODS.
- [x] Pasar compilación, tipos, lint y compilación TypeScript de los tests.
- [ ] Ejecutar los tests del manifiesto/apertura y verificación F5 en un Extension Host disponible.

#### V2-04B — Preview local y de buffer

**Estado:** implementación lista el 2026-10-10; las pruebas de Extension Host y la revisión manual de buffer sucio quedan pendientes de un VS Code de pruebas disponible.

**Depende de:** V2-04A/V2-02B. **Archivos:** preview/extension/protocol/webview y tests. **Pasos:** panel read-only separado, reutilizar renderer/parser; ID por URI+modo; leer buffer del TextDocument cuando corresponde e indicar “Cambios sin guardar”; extensiones arbitrarias solo vía acción CSV explícita. Escuchar cambio del buffer con debounce; serializer con URI y parse options validados. Inhabilitar mutaciones en host y UI.

**Aceptación:** texto sucio cambia preview sin escribir; preview XLSX/ODS desde bytes disco; ninguna edición/clipboard paste muta; recrear panel restaura; abrir editor con buffer textual sucio pide guardar/resolver antes de editar disco. **Fuera:** migrar CSV a CustomTextEditorProvider o habilitar editor para cualquier txt. **Checks:** preview tests/compile; manual dirty-buffer.

**Checklist de implementación**

- [x] Crear panel de preview read-only independiente, identificado por URI y modo (disco, buffer o CSV explícito).
- [x] Reutilizar parser y renderer existentes; preview XLSX/ODS se carga desde bytes de disco.
- [x] Previsualizar el buffer de CSV/TSV/TAB y actualizarlo con debounce al cambiar el `TextDocument`.
- [x] Mostrar cuándo el buffer contiene cambios sin guardar y actualizar el estado después de guardar.
- [x] Ofrecer acción explícita para previsualizar cualquier archivo de texto como CSV.
- [x] No registrar mutaciones en el host y deshabilitar controles de edición en la webview.
- [x] Resolver buffer textual sucio al abrir el editor editable: guardar, descartar o cancelar.
- [x] Añadir pruebas de integración para preview de disco/buffer y compilarlas.
- [ ] Ejecutar pruebas de Extension Host y verificar manualmente cambios live, recreación y buffer sucio.

#### V2-05 — Proyección base y opciones de lectura CSV

**Depende de:** V2-03/V2-02B. **Archivos:** table-view/csv/protocol/grid y tests. **Pasos:** crear proyección identidad visibleRows/sourceToVisible; integrar render, offsets, select y edit usando sourceRow. Clasificar comentarios en scanner sin interpretar comillas internas de comentario como CSV; header primero data, etiqueta visual opcional y capitalización optativa. Ocultar comentarios solo por proyección. Mostrar índice original de registro y línea física en detalle; ordinal como etiqueta secundaria.

**Aceptación:** comentario `# texto "sin cierre` válido como comentario cuando prefijo habilitado; `"#dato"` es dato; no borrar comments/blank al guardar; encabezados duplicados/vacíos mantienen columnas; editar header modifica su fuente; B54 sigue B54 después de ocultar; reset recupera filas. **Fuera:** ordenar/filtrar todavía. **Checks:** proyección/formatos puros + host.

**Estado:** implementación lista; pendiente verificación manual en Extension Host.

- [x] Clasificar comentarios durante parseo y conservar índice de registro/línea física.
- [x] Ocultar/mostrar comentarios por proyección sin cambiar referencias fuente; bloquear edición de registros de comentario.
- [x] Añadir configuración de prefijo, encabezado visual y capitalización.
- [x] Mostrar etiqueta de encabezado y detalle del registro original.
- [x] Añadir cobertura de parseo y preservación de comentarios al compilar pruebas.
- [ ] Ejecutar pruebas de Extension Host y verificar visualmente ocultar/mostrar, referencia B54 y edición de encabezados.

#### V2-06 — Estado persistente y configuración

**Depende de:** V2-05. **Archivos:** view-state/extension/editor/webview/manifiesto/tests. **Pasos:** almacenar ViewStateV1 con reglas 15.7; inyectar workspaceState al proveedor; restaurar tras metadata lista y antes de primer scroll útil; guardar por hoja/mode/URI; comando restablecer; handlers de configuración distinguen parse/view/save. Añadir LRU y cotas.

**Aceptación:** reabrir/reiniciar/restaurar panel conserva selección/scroll/tamaños/consulta por hoja; dos homónimos separados; estado corrupto se ignora con mensaje; cambiar columnas invalida criterios apropiados; restablecer no pierde draft ni reescribe archivo. **Fuera:** elevar retainContextWhenHidden como sustituto de persistencia. **Checks:** tests puros de almacenamiento/validación; manual reinicio Host.

**Estado:** implementación lista; pendiente verificación manual en Extension Host.

- [x] Guardar estado versionado por URI, modo y hoja con límites de tamaño y LRU.
- [x] Restaurar selección, scroll, búsqueda, orden, comentarios visibles y tamaños de filas/columnas.
- [x] Mantener preferencias de edición y vista previa separadas; permitir desactivar persistencia.
- [x] Añadir comando y control de interfaz para restablecer la vista sin tocar el documento ni su draft.
- [x] Añadir pruebas para validación, aislamiento de modos, corrupción, tamaño y LRU.
- [ ] Verificar en Extension Host reapertura, cambio de hoja, restablecimiento y recuperación tras reiniciar VS Code.

#### V2-07 — Ordenamiento multicolumna y comparaciones

**Depende de:** V2-05/V2-06. **Archivos:** table-view, controles headers, dependency decimal.js y tests. **Pasos:** comparadores de texto/número del contrato; click asc/desc/sin orden, Shift añade criterio, Ctrl/Cmd elimina criterio de columna; número de prioridad y acción limpiar; persistir criterios; reordenar índices, no matrices. Header queda fijo fuera de datos.

**Aceptación:** empates estables; 9007199254740992/9007199254740993 distintos; `00123` no cambia; decimales negativos/exponentes; vacíos al final; mixtos anuncian incompatibles; editar después de ordenar modifica fuente y undo la misma celda; no dirty sin edits. **Fuera:** inferir tipo por primera fila ni aplicar sort al XML. **Checks:** comparator/projection tests + compile.

#### V2-08A — Motor de filtros completo

**Depende de:** V2-07. **Archivos:** table-view/types/tests. **Pasos:** implementar values y dos conditions AND/OR, operadores 15.7, validación de términos/tipos y AND entre columnas. Derivar valores únicos sobre candidatos que cumplen otras columnas (sin autofiltro propio); paginar y buscar sin truncar universo. Recalcular proyección por revisión con cancelación cuando sea grande.

**Aceptación:** igual/diferente/contains/prefix/suffix/empty/comparaciones numéricas; combinar dos cláusulas OR y AND; values con vacío/ausente; 50 000 filas y >200 únicos; filtro corrupto rechazado; no mutación ni edición parcial. **Fuera:** construir UI todavía; tests de casos reales, no mirrors de implementación.

#### V2-08B — Popup de filtro y búsqueda con proyección

**Depende de:** V2-08A. **Archivos:** grid/main/styles/view-state/search/tests. **Pasos:** botón accesible por columna con popup values/conditions, búsqueda, todos/ninguno y Aplicar/Cancelar/Limpiar; borrador del popup no altera vista antes de Aplicar. Mostrar chips y conteo visible/total; integrar ámbitos de búsqueda y referencias ocultas. Keyboard focus, Escape y devolución a header.

**Aceptación:** cancelar mantiene criterios; cero filas conserva controles; consulta busca todo universo de valores; referencia oculta pide mostrar; editar fila que desaparece aplica una vez y mueve foco con anuncio; reset restaura orden/filas; headers no confunden click sort con resize/filter. **Fuera:** ocultar errores de parseo. **Checks:** tests filtros/búsqueda y manual teclado/tema.

#### V2-09 — Autoajuste, multilinea y freeze de vista

**Depende de:** V2-08B/V2-02B. **Archivos:** layout/grid/styles/view-state/tests. **Pasos:** doble clic en divisor autoajusta, acción first/all/none; medir header y muestra determinista de hasta 200 filas distribuidas, con máximo 800 px; indicar ajuste por muestra. Wrap opcional y autoalto de filas visibles hasta 600 px; conservar overrides manuales. Freeze primeras N filas/columnas de vista, independiente de XML; geometría y scrollIntoView consideran congeladas.

**Aceptación:** multilinea legible, tamaños límites/manuales no sobrescritos; filtro/sort mantiene altura de fila original; teclado resize funciona; headers congelados no cubren selección; ancho estrecho/claro/oscuro/alto contraste; no dirty. **Fuera:** escribir alturas/anchos/merges al archivo. **Checks:** layout tests y manual UI; medir coste de autoajuste.

#### V2-10 — Rangos y teclado de tabla

**Depende de:** V2-09. **Archivos:** selection/grid/main/styles/tests. **Pasos:** range selection 15.7; flechas/Shift/Home/End/PageUp/PageDown/Tab/Shift+Tab/Enter y F2 para editar; Ctrl/Cmd+A solo tabla; navegación por filas visibles, viewport y freeze. Arrastre con autoscroll acotado; aria-activedescendant a celda activa montada, sin tabIndex en miles de celdas. Tabs de hojas y popup quedan navegables sin atrapar foco.

**Aceptación:** rango cruza viewport y filtros sin seleccionar ocultas; collapse al cambiar proyección; Enter/Tab confirma una vez y avanza; Escape cancela; textarea conserva Shift+Enter y atajos propios; IME composition no confirma al presionar Enter de composición. **Fuera:** clipboard ni batch mutación. **Checks:** selection tests y manual IME/lector de pantalla.

#### V2-11 — Copia de rangos

**Depende de:** V2-10. **Archivos:** clipboard/protocol/editor/grid/tests. **Pasos:** serialize TSV puro con contrato exacto; acciones copiar crudo/mostrado/con encabezados diferenciadas; evento copy cuando tabla activa y fallback al clipboard host; copiar source mapping en orden visible. Mostrar aviso si payload supera cota razonable, sin truncar silenciosamente.

**Aceptación:** copiado de comillas/tab/saltos/Unicode/ceros/fórmulas, filas discontinuas y vacíos; roundtrip TSV; copy en textarea normal; preview permite copy; no escritura al archivo. **Fuera:** pegar/cut o serializar resultados de fórmula al libro. **Checks:** clipboard unit + host de macOS/Windows/Linux cuando disponible.

#### V2-12A — Transacciones de edición

**Depende de:** V2-02A/V2-10. **Archivos:** operations/edit-model/document/editor/protocol/tests. **Pasos:** preflight y aplicar lote sobre copia/journal sin tocar modelo hasta validación completa; before/after incluye existencia/tipo; adaptar editCell como transacción 1×1; derivar snapshot vigente (rows/kinds/types/existence/caches) desde journal, sin metadata obsoleta; undo/redo closures referencian la transacción aplicada, no la selección actual; un evento/revisión/save por lote. Cache dirty/serialización por revisión sin perder detección de revert al original.

**Aceptación:** segunda celda inválida revierte todo lote; un undo revierte todo paste futuro; no-op no crea historial; edición durante save genera revisión siguiente; conflictos disco preservan journal. **Fuera:** UI de pegado, estructura ni fórmulas editables. **Checks:** tests transacciones y regresiones de formatos/storage.

#### V2-12B — Backup de draft y recuperación coherente

**Depende de:** V2-12A/V2-00B. **Archivos:** storage/document/editor/protocol/tests. **Pasos:** envelope backup versionado del contrato, draft separado y baseline; Save solicita/recoge confirmación de draft antes de snapshot, con timeout, o conserva draft sin guardarlo según acción explícita; no salvar mediante dispose. Restauración reconoce legacy y conflicto con disco. Añadir modo save manual opcional manteniendo onCommit default; comprobar dirty VS Code.

**Aceptación:** hot exit recupera lote y texto no confirmado; Escape no reaparece tras reiniciar; archivo externo modificado desde backup abre en conflicto; cancelación/error de permisos mantiene draft; Ctrl/Cmd+S no pierde última tecla; Save As copia formato y draft según política confirmada. **Fuera:** persistir drafts en workspaceState. **Checks:** proveedor/backup tests y reinicio manual Host.

#### V2-13 — Pegado y borrar contenido

**Depende de:** V2-11/V2-12B. **Archivos:** clipboard/operations/webview/protocol/adaptadores/tests. **Pasos:** parse TSV de clipboard con límites y quoting; mapear todo destino antes de aplicar; reglas de tamaños/filtro/revisión; preflight tipos/permisos y mensaje exacto de primera incompatibilidad. Clear operación por tipo sin XML inválido; preservar estilos. No capturar paste/cut de editor inline.

**Aceptación:** 2×3 paste una transacción; 1×1 rellena rango; shape incompatible, fórmula/protegida o overflow rechaza todo; columna numérica no recibe texto por coerción; Delete conserva numFmt y deja celda vacía válida; undo/redo todo; preview rechaza edición desde host. **Fuera:** autoexpandir rango, cut/mover o crear fórmulas implícitas. **Checks:** operaciones/clipboard/formatos + host.

#### V2-14A — Estructura CSV en adaptador y modelo

**Depende de:** V2-03/V2-12A. **Archivos:** csv/edit-model/operations/tests. **Pasos:** transacción de insertar/añadir/borrar registros basada en spans completos con terminadores; resolver edits de celdas previos en una nueva baseline de trabajo en memoria con historial reversible, sin escribir disco intermedio. Conservar comentarios/preamble/BOM y bytes no afectados; definir EOL nuevo desde terminador más cercano (LF fallback). Registro añadido tiene ancho de tabla, sin convertir valores.

**Aceptación:** borrar última/primera/multilinea/discontinuas; añadir con/sin salto final; insertar sin tocar comments; UTF-16 ambos endian; undo restaura bytes originales; tabla vacía admite primer registro con ancho elegido. **Fuera:** estructura XLSX/ODS ni UI todavía. **Checks:** byte-level fixtures propios y unit.

#### V2-14B — Acciones de filas CSV

**Depende de:** V2-14A/V2-13. **Archivos:** grid/selection/editor/view-state/tests. **Pasos:** menú contextual/acciones accesibles añadir/insertar antes/eliminar filas; usar coordenadas originales capturadas. Deshabilitar insertar en vista sorted/filtered con acción para limpiar; borrar selección visible confirma cantidad y origen cuando hay proyección. Reconciliar selección/sizes/criterios tras estructura y nuevo revision.

**Aceptación:** borrar tras sort borra registros seleccionados, no primeros N; undo reconstruye proyección; comentarios/header no eliminados por selección de datos accidental; límites antes de mutar; no autosave por cada fila. **Fuera:** columnas CSV (no presentes como función explícita de la referencia); pueden añadirse con tarjeta propia futura.

#### V2-15A — Metadata y capacidades XLSX

**Depende de:** V2-02A/V2-00A. **Archivos:** xlsx/xlsx-metadata/model/protocol/tests. **Pasos:** leer estilos/geometry/sheet state/merges/panes/date1904/protección/tablas/nombres/links/notas; resolver relaciones correctamente, sin seguir recursos externos. Metadata separada de lexemas; inventario de restricciones para operaciones estructurales. No expandir matriz solo por estilos lejanos; rango visible visual acotado a contenido/merges admitidos.

**Aceptación:** fixtures propios con cada metadata; styles/themes/cellXfs mapping correcto; unknown parts preservadas y clasificadas; hidden/veryHidden no se confunden; protección/merge bloquean celda que corresponda; límite visual aplicado antes de expansión. **Fuera:** renderer nuevo o writer general de estilos. **Checks:** metadata unit + formatos.

#### V2-15B — Metadata ODS y límites visibles

**Depende de:** V2-15A. **Archivos:** ods/model/protocol/tests. **Pasos:** exponer equivalentes mínimos de identidad/visibilidad/protección/covered/merges y repeticiones. Capabilities declara qué se puede presentar/escribir; mantener formulas cache-only y duración `office:time-value` diferenciada de fecha ISO para no permitir edición que pierde semántica.

**Aceptación:** covered no editable; duración no se guarda como date; repetidos conservados; ODS muestra límites de vista libro con razón concreta sin perder su edición cruda. **Fuera:** recalcular OpenFormula o aplicar estilos ODF completos como si fueran XLSX.

#### V2-16A — Formatos de presentación

**Depende de:** V2-15A/V2-01A. **Archivos:** presentation/webview/SSF dependency/tests. **Pasos:** toggle raw/book; formatear por numFmt/fecha/booleano en copia; SSF solo presentación; soportar date1904 y caso serial 60 sin conversiones locales silenciosas. Editor siempre raw; cache y cálculo con origen/estado explícito. Formato personalizado por columna CSV optativo y tipo explícito; no persistir a CSV. Añadir condiciones de fecha explícitas para valores date ISO XLSX/ODS y números XLSX con numFmt de fecha reconocido: comparar seriales/instantes con sistema 1900/1904 definido, límites calendario y timezone UTC, sin Date local ni inferencia de fechas CSV. Un filtro fecha se aplica después de elegir ese modo de comparación; formatos ambiguos o serial 60 mantienen representación especial y un resultado definido, no se normalizan a otra fecha silenciosamente.

**Aceptación:** 0.25→25% en vista libro y 0.25 en crudo/editor; fechas 1900/1904/serial60/time; números grandes fallback raw o advertencia de aproximación; fórmula fallida no se presenta como cache calculada; switch no dirty ni altera bytes. **Fuera:** escribir estilos/formatos y prometer full Excel number formats. **Checks:** presentación/fixtures y temas.

#### V2-16B — Libro visual, hojas y combinaciones

**Depende de:** V2-16A/V2-09/V2-15B. **Archivos:** grid/layout/styles/selection/view-state/tests. **Pasos:** aplicar tamaños/alineación/wrap/bordes seguros y estilo tematizado; merges/freeze/hidden según 15.7; tabs con scroll y selector respaldo. Links/notas en detalle como texto; activar link solo tras click con validación de protocolo. Pasar a tabular antes de sort/filter que intersecte merges; comunicar cambio.

**Aceptación:** libro visual no cubre celdas al virtualizar; navegar a celda covered lleva al ancla; hojas ocultas explícitas; A1/selección/copy raw funcionan; abrir/switch no reescribe; alto contraste y editor de 400 px usables. **Fuera:** toolbar de formato o escritura de merge/visibility.

#### V2-17A — Estructura XLSX segura en modelo

**Depende de:** V2-15A/V2-12A. **Archivos:** xlsx-structure/operations/edit-model/tests. **Pasos:** implementar preflight de perfil 15.7 sobre todo libro; insertar/borrar filas/columnas solo si inventario conocido es seguro; mover coords/rows/cols/dimension/spans y geometría admitida; snapshot reversible de partes cambiadas. Mantener presupuesto ZIP/celdas. Serializar todo lote una vez y volver a parsear/verificar.

**Aceptación:** fixture sin referencias externas conserva estilos/sheets/partes; coordenadas ordenadas, gaps válidos y dimension correcto; undo devuelve semántica/bytes del snapshot; archivo con fórmula en otra hoja bloquea estructura; parte/nodo desconocido relevante bloquea con razón. **Fuera:** intentar ajustar referencias por regex ni degradar libro a matriz para exportarlo.

#### V2-17B — Menú estructural XLSX

**Depende de:** V2-17A/V2-13. **Archivos:** grid/editor/capabilities/tests. **Pasos:** menú accesible insertar/borrar filas/columnas; scope original, confirmar borrado y resolver pendientes; sort/filter deben limpiarse antes de inserción estructural. Mostrar bloqueo por capability en UI y revalidar host. Actualizar vista/estado tras commit y undo.

**Aceptación:** misma columna/fila original afectada; undo un paso; no guardar libro bloqueado; operación fuera de tamaño rechaza todo; edición normal sigue disponible en libros fuera de perfil. **Fuera:** estructura ODS o gestión de hojas.

#### V2-18A — Ajuste de referencias de fórmulas

**Depende de:** V2-01B/V2-15A. **Archivos:** formula-reference, tipos y tests puros. **Pasos:** usar Parser/Tokenizer de Formualizer en entorno soportado para obtener AST/spans; transformador definido para referencia A1/simple/rango, sheet quoted, absolutos y coordenadas. Diferenciar copy offset de structural offset. Preservar strings/case/espacios fuera de spans y rechazar sintaxis sin spans suficientes. Aplicar parches solo en spans de referencias, de mayor a menor offset; no regenerar AST completo, porque valores numéricos de AST pueden perder lexemas. Comprobar spans dentro de la expresión original y volver a parsear resultado. Para Node, compilar servicio perezoso ESM `dist/formula-parser-node.mjs` con Webpack `target: [node,node18]`, `experiments: {asyncWebAssembly:true,outputModule:true}`, regla `.wasm` y output module, siguiendo la prueba temporal y `scripts/test-formulas.js`; cargar desde extensionUri por import dinámico, sin hacer que esbuild Node procese WASM. Inyectar interfaz `FormulaParserService` al transformador; backend Web se conecta en V2-22B. Cota de expresión 32 KiB; normalizar errores string. Tests puros del transformador usan datos AST controlados más tests reales del servicio bundleado. No crear worker Node hasta medir bloqueo; transporte no pertenece al transformador.

**Aceptación:** batería insert/delete/copy con $/mixed/rangos/otras hojas; `"B2"` intacto; referencias eliminadas #REF!; unsupported enum claro, sin silencios. **Fuera:** modificar XLSX todavía, nombres/tables/external/3D ni AST de todas las sintaxis. **Checks:** unit de transformaciones y test-formulas pertinente.

#### V2-18B — Estructura XLSX con fórmulas normales

**Depende de:** V2-18A/V2-17B/V2-20A. **Archivos:** xlsx-structure/operations/tests. **Pasos:** ampliar profile únicamente a fórmula normal soportada, inventariando references de todas las hojas. Ajustar fórmulas, cache de las expresiones cambiadas y calcChain de modo coherente; fullCalcOnLoad; conservar fórmulas/cachés no tocadas cuando sea correcto. Metadata con referencias no tratadas sigue bloqueando operación.

**Aceptación:** references entre hojas tras inserción/borrado, Excel/LibreOffice no repara, undo restaura expresiones y caches; shared/array/definedNames/table/external bloqueados explícitos. **Fuera:** afirmar paridad estructural con libros complejos; ampliaciones requieren tarjeta específica de preflight/writer/tests.

#### V2-19A — Baseline de rendimiento y transporte

**Depende de:** V2-13/V2-16B. **Archivos:** script benchmarks/protocol/editor/document/tests. **Pasos:** fixture propio de 35 290×5 y uno ancho dentro de límites; medir read/ZIP/XML/getRows/serialize/postMessage/cálculo/proyección/render/memoria por separado. Cache por revisión y dirty barato; deltas de transacción entre snapshots completos de apertura/reload, con solicitud resync si baseRevision no coincide. No enviar libro base64 con cada scroll/cambio de hoja.

**Aceptación:** informe antes/después con hardware/runtime/p50/p95/tamaño; delta perdido recupera snapshot sin mezclar revisiones; cache no devuelve libro anterior; cambios externos invalidan todo cache adecuado. **Fuera:** elevar 10 MiB/64 MiB u otros límites para aparentar competitividad.

#### V2-19B — Grid en dos ejes y worker de fórmulas

**Depende de:** V2-19A/V2-02B. **Archivos:** grid/layout/worker/calculador/build/tests. **Pasos:** offsets acumulados y búsqueda binaria para filas/columnas visibles+overscan; mantener headers/freeze/merge/active cell/editor; worker local carga WASM por documentId/revision, entrega resultados por lote y libera libros. Cancelación entre lotes; si evaluación individual bloquea, timeout y terminate/recreate worker, nunca asumir cancel síncrono del WASM.

**Metas:** navegación visual <100 ms en p95 sobre fixtures de referencia propios y tareas UI de scroll sin bloqueos >50 ms; objetivos a medir, no resultados actuales. **Aceptación:** DOM proporcional a viewport, selección/IME estable, respuesta antigua descartada, fórmulas fuera de viewport/interhoja correctas, timeout deja error/cache-only y UI operativa. **Fuera:** cálculo con datos incompletos de una sola ventana.

#### V2-20A — Edición de fórmulas XLSX normales

**Depende de:** V2-01B/V2-12B/V2-15A/V2-18A (servicio de parseo). **Archivos:** operations/xlsx/edit-model/protocol/editor/servicio de fórmulas/tests. **Pasos:** acción explícita editar/crear fórmula; parse sintáctico en servicio host antes de aceptar (no confiar únicamente en la validación webview); resolver tipos y capacidad de la celda. Guardar `<f>`, cache de editada removida, flags/calcChain conforme a 15.7; snapshot actualizado marca fórmula nueva y desmarca fórmula borrada, para que UI y cálculo no reutilicen kinds/caches originales. No soportar grupos shared/array aún. Expresión válida con función no soportada puede conservarse tras aviso explícito de no cálculo; expresión inválida se rechaza.

**Aceptación:** editar =SUM y referencia interhoja, undo expresión/cache original; `=ABC` CSV sigue string; fórmulas unsupported muestran aviso y origen correcto; save/reopen mantiene expresión exacta y no guarda cálculo; fixtures externos abren sin reparación. **Fuera:** migrar todos los caches a valores nuevos ni ODS formula editing.

#### V2-20B — Asistencia y estados de fórmula

**Depende de:** V2-20A. **Archivos:** editor inline/worker/model/tests. **Pasos:** lista de funciones verificadas con firma/ayuda, completar tokens sin alterar texto ajeno, referencias de celda desde selección con modo explícito. Catálogo no incluye como “soportada” una función que solo se parsea. Panel distingue expression/cache/stale/calculated/error/unsupported.

**Aceptación:** teclado/Escape/IME; selección de referencia no confirma antes de terminar; función sugerida respeta pruebas y errores; resultado obsoleto nunca se etiqueta actual. **Fuera:** autocompletar sintaxis que no sabe guardar o instalar un motor alterno.

#### V2-21 — Stdin, integración por idioma y defaults

**Depende de:** V2-04B/V2-06. **Archivos:** extension/config/preview/tests/README. **Pasos:** openStdin=false; detectar URI/documento stdin compatible al abrir y al activar; evitar doble preview/loops. Resolver idiomas csv/tsv/csv (semicolon)/csv (pipe) sin depender de que Rainbow CSV esté instalado. Ajustes reactivos por recurso y paleta para plaintext/arbitrario mediante comando explícito.

**Aceptación:** stdin opt-in, sin escritura al recurso efímero, init/reopen sin duplicados; idioma con separador respeta prioridad; config visual actualiza sin perder draft; doc externa al workspace funciona. **Fuera:** reconocimiento heurístico de cualquier archivo como spreadsheet.

#### V2-22A — Proveedores remotos/virtuales y confianza

**Depende de:** V2-12B/V2-04B/V2-00B. **Archivos:** storage/editor/preview/manifiesto/tests. **Pasos:** matriz de proveedores concretos con read/write/stat/watch/rename/backup y isWritableFileSystem; mock provider readonly y writable con rename fallido. Probar workspace untrusted sin ejecutar macros/contenido activo. Clasificar permisos antes de habilitar acciones y comprobar otra vez al guardar.

**Aceptación:** readonly preview/editor sin escritura; writable guarda con verificación; rename/error externo conserva borrador; flags capabilities del manifiesto corresponden a casos comprobados. **Fuera:** prometer atomicidad ni compatibilidad de todos los esquemas por usar workspace.fs.

#### V2-22B — VS Code Web

**Depende de:** V2-22A/V2-19B. **Archivos:** extension/build/storage/document/formats/manifiesto/tests. **Pasos:** bundle Web separado (`dist/extension-web.js`), abstraer Node path/crypto/Buffer y usar Web APIs/URI helpers; probar parser/SSF/WASM/worker/CSP/clipboard/backup. La entrada de extensión Web no importa Node ni el bundle de interfaz; usa la implementación Web del servicio de fórmulas. XLSM tiene su propia tarjeta V2-22C.

**Aceptación:** host Web real abre/navega/copia/edita formatos certificados y recupera backup; build Node sigue pasando; paquete incluye targets distintos. **Fuera:** declarar browser capability antes de validar.

#### V2-22C — XLSM de lectura y preservación explícita

**Depende de:** V2-22A/V2-15A/V2-04B. **Archivos:** document/adaptador XLSX/preview/capabilities/manifiesto/tests. **Pasos:** reconocer extensión y content-type de workbook macro-enabled, recorrer hojas con el parser compartido, exponer macros/firmas como metadata de capacidades. Abrir solo lectura en host y UI; no ejecutar VBA ni convertir el contenedor para calcular si el motor no lo admite. Si cálculo no soporta XLSM, mostrar caché y razón en vez de resultado inventado. No habilitar Save As para cambiar extensión y eliminar macros.

**Aceptación:** fixture propio de XLSM con vbaProject.bin opaco y relaciones: abre hojas, copia valores, no crea dirty ni escribe por ningún mensaje; macro/firma se identifica y datos raw no cambian. **Fuera:** editar macros o garantizar preservación de firmas tras edición; edición XLSM queda en V2-24E hasta tener writer y fixtures específicos.

#### V2-23A — Rellenar valores y series explícitas

**Depende de:** V2-13/V2-10. **Archivos:** selection/operations/grid/tests. **Pasos:** fill down/right y handle de rango con preview del destino; repetir bloque/celda y opción explícita serie numérica con decimal.js. Capturar source mapping/revision, respetar cota y tipos, aplicar una transacción. Patrón se determina por elección, no convertir IDs numéricos automáticamente.

**Aceptación:** textos con ceros, decimales precisos, rango filtrado y undo un paso; salida fuera de tamaño/protegida rechaza; no modifica estilos por arrastre. **Fuera:** copiar fórmulas relativo hasta V2-23B.

#### V2-23B — Rellenar fórmulas relativas

**Depende de:** V2-18A/V2-20A/V2-23A. **Archivos:** operations/formula-reference/grid/tests. **Pasos:** copiar normal formulas con transformador copy-offset y `$`; preflight toda serie; no crear grupo shared ni derrame por inferencia. Vista previa de expresión final y cancelación antes de commit.

**Aceptación:** mixed/absolute/interhoja y strings intactos; resultado correcto tras fill, una transacción, caches de destino no se reutilizan; sintaxis no transformable rechaza todo. **Fuera:** fill-formatting y estructuras complejas sin su writer.

#### V2-24A — Crear tablas XLSX en un rango tabular seguro

**Depende de:** V2-15A/V2-16B/V2-12A. **Archivos:** nuevo `formats/xlsx-tables.ts`, operations/metadata/protocol/tests. **Perfil inicial:** rango rectangular en una hoja editable, sin merges, tablas solapadas, protección ni fórmulas con referencias estructuradas; primera fila contiene encabezados no vacíos y únicos. Si no cumple, no renombrar valores automáticamente: informar columnas que necesitan corrección. Nombre de tabla explícito, único case-insensitive en todo libro y válido como nombre Excel; bloquear nombres parecidos a referencia A1/R1C1, espacios o reservados.

**Pasos concretos:** crear `xl/tables/tableN.xml` con ID/nombre/displayName/ref, autoFilter, tableColumns y tableStyleInfo elegida de un conjunto fijo; asignar N/ID sin colisiones. Añadir relación worksheet→table, `tableParts`/count y Override de content-types; ubicar nodos en orden OOXML. Releer metadata y validar correspondencia cantidad/nombres/rango. Writer toca exclusivamente worksheet/rels/table/content-types; no cambia valores ni estilos de celda. Undo restaura las partes previas y elimina las creadas, en una transacción. Para libro sin tablas previas usar tableParts nueva; para existente conservar cada relación/ID ajeno.

**Aceptación:** crear tabla A1:C5; otra tabla no solapada en la misma hoja; nombres duplicados/rango con merge rechazados antes de mutar; partes ajenas byte-identicas; undo/redo y aplicación externa sin reparación. **Fuera:** columnas calculadas, totals, resize/delete de tabla y references structured. Esas extensiones quedan registradas con el requisito de actualizar todas sus referencias antes de habilitarlas; creación inicial es implementable con este contrato. **Checks:** tests ZIP/XML específicos, formats/metadata y revisión Excel/LibreOffice.

#### V2-24B — Gestionar hojas dentro de perfil sin referencias

**Depende de:** V2-17A/V2-12B/V2-15A. **Archivos:** nuevo `formats/xlsx-sheets.ts`, operations/editor/tabs/metadata/tests. **Perfil inicial:** todas las hojas sin fórmulas, definedNames, tablas, charts/drawings, firmas, vínculos externos o referencias entre partes que no sepamos reconciliar. Workbook con datos/estilos simples sí admitido. Renombrar usa nombre explícito de 1–31 caracteres, único sin distinguir case, sin `[]:*?/\\` ni apóstrofo inicial/final; no permitir nombre vacío.

**Pasos concretos:** rename cambia solo `workbook.xml/sheets/sheet@name` y estado de vista ligado al mismo sheetId. Añadir asigna sheetId/rId/part path únicos, crea worksheet mínimo con namespace/sheetData, agrega sheet en workbook, relación worksheet y Override. Borrar elimina sheet, relación y Override propios y su worksheet, después de verificar que no hay rels dependientes; no borrar styles/sharedStrings ni otra hoja. Reconciliar activeTab y workbookView; siempre una hoja visible. Cualquier parte dependent desconocida bloquea borrado. Guardar manifest de partes before/after para undo, preservar identidad de hojas ajenas.

**Aceptación:** añadir/renombrar/borrar copia simple de dos hojas; nombre case-duplicate/inválido rechazado; última visible no se borra; dirty/event/revisión una sola vez; undo restaura hoja/valores/estado; Excel/LibreOffice abre sin reparación. **Fuera:** renombrar hoja con fórmulas sin actualizar references, borrar contenido vinculado o gestión ODS. Ampliar con fórmulas normales reutiliza V2-18A tras tests de references con nombres quoted; no asumir que basta replace de nombre.

#### V2-24C — Mover/cortar rangos de valores

**Depende de:** V2-13/V2-12B/V2-17A. **Archivos:** operations/selection/clipboard/protocol/tests. **Perfil inicial:** misma hoja, valores sin fórmulas, merges ni protección; XLSX/ODS sin referencias de libro a celdas del rango (usar capability conservadora); CSV texto permitido. En vista sorted/filtered, limpiar proyección antes de mover para que el destino sea rectángulo fuente. Copiar al clipboard externo no borra origen; cut inicia modo pendiente con contorno, solo el paste interno con token de transacción del mismo documento realiza el movimiento.

**Pasos concretos:** leer snapshot íntegro de origen antes de calcular cambios; mapear destino; validar tipos/espacio/overlap. Crear after-map de unión origen/destino: limpiar las coordenadas origen que no reciben valores del destino y luego escribir valores capturados, incluso si el rango se solapa. Preflight todo y confirmar una transacción. Cancel/Escape/cambio de revisión abandona modo cut sin modificar. Al pegar texto externo de un cut, tratar como copia; nunca borrar datos solo porque clipboard aún contiene el mismo texto. Drag usa la misma operación con preview y confirmación, no muta durante pointermove.

**Aceptación:** mover 2×2 a rango libre y solapado, undo completo; tipos incompatibles/readonly/archivo cambiado durante drag rechazan sin clear; cancelar mantiene bytes; fallo de clipboard no borra origen. **Fuera:** mover fórmulas o estilos/filas completas; la semántica de referencias que siguen un movimiento requiere nueva extensión sobre AST y tabla de dependencias, distinta de copiar fórmula.

#### V2-24D — Estilos simples, combinaciones y panes guardables

**Depende de:** V2-15A/V2-16B/V2-12A. **Archivos:** nuevo `formats/xlsx-styles.ts`, operations/presentation/layout/tests. **Perfil inicial:** estilos simples en XLSX sin firma/protección; sin rich text/conditional formats que intersecten rango editado. Conservar todas las partes existentes. UI permite solo bold/italic, alineación/wrap y numFmt de lista fija; colores, bordes complejos y formatos arbitrarios requieren ampliación posterior.

**Pasos concretos:** clonar style de cada celda seleccionada, cambiar únicamente el atributo solicitado, deduplicar fonts/numFmts/cellXfs por clave semántica y anexar sin renumerar IDs existentes; actualizar counts e índice `s` de celda. Conservar theme references y componentes de estilo ajenos. Merges: rango rectangular contiguo sin solapes y con valores solo en ancla; si otras celdas tienen datos, rechazar y explicar, no eliminarlos. Añadir mergeCells/count; unmerge elimina exclusivamente ese rango, no inventa valores. Freeze escribe sheetViews/pane/selection de forma consistente desde counts originales; respeta hoja hidden y otras views. Una transacción con parts before/after para historial.

**Aceptación:** bold conserva número/numFmt; wrap conserva fórmula/cache; estilos repetidos no multiplican IDs; merge/unmerge y freeze guardan/reabren sin reparación; hoja con contenido covered no se combina silenciosamente; undo devuelve partes. **Fuera:** tablas de formato completo, toda la sintaxis numFmt, rich text y estilo ODF. Fill-formatting se habilita después como copia explícita de style IDs con preflight de esta tarjeta.

#### V2-24E — Extensión documentada de perfiles complejos

**Depende de:** las tarjetas básicas de la familia. **Estado de alcance:** diferido de la v2 de escritorio; no es un permiso para implementar todo OOXML/ODF. Este es el inventario de incompatibilidades que debe aparecer en capabilities y README, con pruebas de bloqueo: estructura sobre validations/conditional formatting/hyperlinks/definedNames/tables; fórmulas shared/array/dynamic/external/3D; cut que mueve dependencias; ODS estructura y estilos completos; cambio de tipo de fórmulas ODS; edición XLSM con macros/firmas.

Cada ampliación se divide por familia: especificar relaciones/nodos/refs afectados, una operación de writer, transformador de referencias y oracle externo. La v2 puede competir en inspección y edición cotidiana con las tarjetas anteriores sin afirmar ser un sustituto completo de Excel. Estas incompatibilidades son exclusiones deliberadas, registradas y comprobables, no funciones olvidadas. Luna implementa sus tests de bloqueo durante las tarjetas anteriores; no debe investigar el estándar completo para sortearlos.

#### V2-25 — Validación competitiva y paquete

**Depende de:** etapas del alcance de entrega elegidas en 15.5; no requiere presentar V2-24 como completa. **Archivos:** tests/scripts/manifiesto/README/CHANGELOG/planning y licencias. **Pasos:** convertir matriz F01–F31 en checklist entregado/parcial/diferido con evidencia; fijar runtime Node que soporte herramientas instaladas y VS Code mínimo acorde a APIs (incluida workspace.save); correr suites correctas; VSIX con assets WASM/worker/CSS/SSF/licencias. Descripción, categorías, keywords y ejemplos propios; revisar instalación limpia y ausencia de archivos audit/debug/datos privados en VSIX.

**Aceptación:** `check-types`, `lint`, unit, `npm test`, `test:formulas`, build producción y VSIX pasan o limitación se documenta sin falso éxito; guardar/reabrir con Excel/LibreOffice copias de fixtures reales; flujos E2E de 15.10; accesibilidad y hosts certificados. No publicar Marketplace ni cambiar asociaciones del usuario sin solicitud explícita; generar paquete local sí forma parte de esta etapa.

### 15.10. Fixtures y escenarios que cierran la v2

Crear fixtures pequeños propios y expectativas explícitas. No comparar únicamente lectura contra escritura usando el mismo parser como oracle: comparar bytes CSV, XML/partes XLSX/ODS y resultados independientes, y reabrir con aplicaciones externas cuando la semántica lo requiera.

| Escenario | Resultado esperado y etapas |
| --- | --- |
| T01: CSV UTF-8/16, BOM, CRLF/LF, multilinea/comillas, `sep=`, comments, blank, short row, header repetido/vacío | Parser/escritor mismos dialectos; archivo intacto sin edición; bytes ajenos intactos al editar. V2-03/05/14. |
| T02: filtro → sort → editar B54 → undo → guardar/reabrir | Se modifica B54 de origen, no primera fila visual; undo revierte lote; vista no serializa orden. V2-07/08/12. |
| T03: rango de filas filtradas → copiar → pegar 2×3 y 1×1 | Copia visible; pegado captura fuentes antes de aplicar; una celda inválida rechaza todo; un undo todo. V2-10/11/13. |
| T04: texto sucio + preview; cambio externo + draft; hot exit + recuperación | Buffer visible sin write; conflicto no sobrescribe; draft recuperado con baseline original. V2-04/12. |
| T05: formato %, fecha serial1900/1904, número largo, merge/pane/hidden | Crudo intacto; vista libro separada; precisión o fallback explícito; coordenadas y foco correctos. V2-15/16. |
| T06: fórmula normal/shared/array/error/unsupported/entre hojas | Permisos exactos; cálculo válido probado; expresiones/cache distinguibles; nunca guardar resultado visual. V2-01/20. |
| T07: estructura CSV/XLSX, gap y última fila/columna, references $ | Transacción completa, parte ajena conservada, parse y aplicación externa válidos; unsupported bloquea estructura. V2-14/17/18. |
| T08: datos propios 35 290×5 y sheet ancho; selección/resize/filtro/cálculo durante scroll | Benchmark repetible por etapa, UI fluida, DOM acotado, worker cancelable y sin resultado obsoleto. V2-19. |
| T09: reabrir/reiniciar, cambiar columnas, homónimos, mover tab | Estado por URI/hoja; schema invalidation parcial; sin duplicados/draft perdido. V2-04/06. |
| T10: teclado/IME/lector de pantalla, 400 px, claro/oscuro/alto contraste | Toda acción esencial operable, foco estable y anuncio preciso; teclado de inputs no interceptado. V2-09/10/16. |
| T11: readonly/writable remoto, rename fallido, Web, stdin, XLSM | Solo capacidades certificadas; ninguna escritura inesperada; payloads/backup y recursos locales correctos. V2-21/22. |
| T12: archivo límite/sobre límite, ZIP excesivo, hoja ilegible, permisos y cancel | Rechazo completo o read-only explícito, nunca hoja truncada editable; original/borrador preservados. V2-00/12/25. |

### 15.11. Instrucción operativa para Luna y control de alcance

**Paquete de contexto para ahorrar tokens:** entregar nombre de tarjeta + párrafo del contrato relacionado + filas del mapa de archivos + casos T asociados. Luna puede localizar los bloques con `rg -n '^#### V2-|^### 15|^#### ' planning.md` y leer esos rangos; no necesita releer los 11 apartados de análisis ni descargar la referencia. Una solicitud por subtarjeta permite validar cada entrega antes de ampliar el alcance. Mantener el estado de dependencias en este planning es parte de cada entrega.

**Regla de conflictos de documentos:** propuestas de v2 reemplazan exclusiones del MVP solamente para la operación y perfil de la tarjeta implementada. Ejemplo: V2-20 permite editar fórmula XLSX normal de manera explícita, pero no habilita edición de fórmulas ODS/shared/array. Una tarjeta pendiente nunca autoriza a anunciar esa función en README/CHANGELOG.

> Implementa únicamente **[V2-NN o V2-NNA/B/C/D]** de `planning.md`, con GPT Luna 6 en esfuerzo medio. Lee las decisiones de 15.6, únicamente los contratos pertinentes de 15.7, las filas de archivos pertinentes de 15.8, la tarjeta solicitada y sus escenarios T; el análisis histórico 15.1–15.5 es referencia, no una investigación que debas repetir. Inspecciona las firmas reales de los archivos afectados y comprueba dependencias de la tarjeta antes de editar.
>
> Aplica las decisiones técnicas ya resueltas. No clones gc-excelviewer, no copies sus controles/código ni elijas otra biblioteca o framework por tu cuenta. Crea solamente módulos necesarios para esta tarjeta; conserva los adaptadores y guardado centralizado. Si una API/semántica del contrato no existe o no se puede representar con el paquete instalado, reporta el bloqueo concreto y termina el trabajo independiente autorizado; no inventes métodos, no silenciosamente cambies el producto a solo lectura y no implementes otro motor con regex.
>
> Ejecuta tests focalizados de comportamiento y checks pertinentes. Un fallo del entorno de Extension Host no demuestra un fallo de producto ni permite decir que integración pasó; reporta comando/runtime/error y deja ese check pendiente. No ejecutas todas las etapas por recibir esta plantilla.
>
> Al cerrar, actualiza estado de **esa tarjeta** con archivos, evidencia/tests y pendientes; reporta qué acciones manuales la verifican. No declares v2 completa, ni soporte de host/formato complejo, antes de sus criterios. Si detectas una brecha nueva, agrégala a F/T y describe su efecto; no la implementes como refactor incidental.

No se autoriza implementación de producto por esta solicitud de análisis. Para comenzar el roadmap, la primera unidad concreta es **V2-00A**. V2-24A–D tienen perfiles concretos implementables; V2-24E mantiene las ampliaciones complejas fuera de la entrega inicial y exige que sus límites estén visibles y probados. El objetivo de este documento es concentrar aquí las decisiones costosas y dejar a Luna unidades pequeñas, comprobables y con un contrato claro.
