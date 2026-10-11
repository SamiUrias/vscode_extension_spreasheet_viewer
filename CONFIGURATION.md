# Configuración de Spreadsheet Viewer

Este documento describe las opciones que la extensión declara actualmente en `package.json` y cómo se aplican en el código. La sección `contributes.configuration.properties` de `package.json` define los nombres, tipos, valores admitidos y valores predeterminados que VS Code muestra en Settings. El código consulta esas mismas claves; si se cambia una propiedad, hay que revisar tanto su declaración como todos sus usos.

## Dónde configurar

Abre **Preferences: Open User Settings (JSON)** para preferencias personales o **Preferences: Open Workspace Settings (JSON)** para el proyecto. También puedes abrir Settings con `Ctrl+,` (`Cmd+,` en macOS) y buscar `@ext:spreadsheet-viewer` o el nombre de una opción. En un workspace multi-root puedes usar los settings de la carpeta correspondiente cuando VS Code permita ese ámbito.

Ejemplo de `.vscode/settings.json`:

```json
{
  "spreadsheet-viewer.csv.commentPrefix": "#",
  "spreadsheet-viewer.csv.firstRowHeader": true,
  "spreadsheet-viewer.csv.headerCase": "none",
  "spreadsheet-viewer.stdin.openStdin": false,
  "spreadsheet-viewer.xlsx.showStructureActions": true,
  "spreadsheet-viewer.view.restoreState": true,
  "spreadsheet-viewer.view.showResetButton": true,
  "spreadsheet-viewer.view.showClearSortButton": true,
  "spreadsheet-viewer.view.showCopyButtons": true,
  "spreadsheet-viewer.view.showFillActions": true,
  "spreadsheet-viewer.view.showDisplayModeButton": true,
  "spreadsheet-viewer.view.showWorkbookAppearance": true,
  "spreadsheet-viewer.edit.saveOnCommit": true
}
```

Los valores siguientes son los predeterminados. No hace falta escribirlos en `settings.json` salvo que quieras sobrescribirlos. Las propiedades no declaran un ámbito de recurso o lenguaje; se configuran en User o Workspace Settings, no como una opción distinta para cada archivo CSV.

Para probar el comportamiento de la extensión en este repositorio, `.vscode/settings.json` deja habilitadas las opciones disponibles: opciones CSV, restauración de vista, botones **Restablecer vista**, **Limpiar orden**, copia, presentación cruda/libro y acciones de filas, además del guardado al confirmar. `headerCase: "upper"` solo transforma la etiqueta visual; no cambia el archivo. Las opciones de autoajuste, multilínea, freeze y teclado de tabla de V2-09/V2-10 son controles de vista, no propiedades de `settings.json`.

## Opciones disponibles

| Propiedad | Tipo y valores admitidos | Predeterminado | Efecto |
| --- | --- | --- | --- |
| `spreadsheet-viewer.csv.commentPrefix` | Cadena de 0 a 128 caracteres | `"#"` | Interpreta como comentario un registro CSV cuyo primer texto sea exactamente este prefijo. Los comentarios se conservan en el archivo, se pueden ocultar de la tabla y no se editan como celdas. Una cadena vacía desactiva la detección de comentarios. |
| `spreadsheet-viewer.stdin.openStdin` | Booleano: `true` o `false` | `false` | Con `true`, al abrir el buffer temporal de texto creado por VS Code para `code -` en modo Plain Text o CSV compatible, muestra automáticamente una vista previa de solo lectura. Solo reconoce el archivo stdin temporal de VS Code; no inspecciona otros archivos. No guarda ni modifica ese recurso. Al desactivarlo, se puede seguir usando **Vista previa como CSV…** manualmente. |
| `spreadsheet-viewer.csv.firstRowHeader` | Booleano: `true` o `false` | `true` | Si es `true`, usa el primer registro de datos (no un comentario) como etiqueta visual de las columnas. No elimina ni mueve esa fila: sigue apareciendo en la tabla como dato editable. |
| `spreadsheet-viewer.csv.headerCase` | Cadena: `"none"`, `"upper"` o `"lower"` | `"none"` | Deja igual, convierte a mayúsculas o convierte a minúsculas las etiquetas visuales del encabezado. No cambia el texto guardado en el CSV. |
| `spreadsheet-viewer.csv.showRowActions` | Booleano: `true` o `false` | `true` | Muestra u oculta las acciones **Insertar fila**, **Añadir fila** y **Eliminar fila(s)** en el editor CSV. No afecta a XLSX/ODS ni a las vistas previas. |
| `spreadsheet-viewer.xlsx.showStructureActions` | Booleano: `true` o `false` | `true` | Muestra u oculta el menú para insertar o eliminar filas y columnas en el editor XLSX. Solo se aplican a libros que pasan el preflight de seguridad; no afecta CSV/ODS ni vistas previas. |
| `spreadsheet-viewer.xlsx.allowFormulaEditing` | Booleano: `true` o `false` | `true` | Permite crear o editar fórmulas XLSX con el modo explícito **Editar como fórmula**. El host valida la sintaxis antes de aplicar y una fórmula válida puede guardarse aunque el motor no la calcule. No habilita edición de fórmulas ODS, compartidas ni matriciales. El cambio se aplica a los paneles abiertos. |
| `spreadsheet-viewer.xlsx.showFormulaAssistance` | Booleano: `true` o `false` | `true` | Muestra sugerencias de funciones que se verificaron con las fixtures de compatibilidad y el modo **Insertar referencia seleccionada**. Una sugerencia completa solo el nombre en el cursor; la referencia se inserta al hacer clic en una celda y deja el borrador sin confirmar. No afirma compatibilidad con otras funciones o variantes. |
| `spreadsheet-viewer.view.restoreState` | Booleano: `true` o `false` | `true` | Guarda y restaura por archivo, hoja y modo de vista la selección, scroll, búsqueda, orden, visibilidad de comentarios y tamaños manuales de columnas/filas. Con `false` no lee ni guarda este estado. No afecta el contenido, los cambios pendientes ni los backups del documento. |
| `spreadsheet-viewer.view.showResetButton` | Booleano: `true` o `false` | `true` | Muestra u oculta el botón **Restablecer vista** en el editor y las vistas previas. Con `false` el botón no aparece; la acción de restablecimiento sigue disponible como **Spreadsheet Viewer: Restablecer vista de hoja** en la paleta de comandos. El cambio se refleja en las vistas que ya están abiertas. |
| `spreadsheet-viewer.view.showClearSortButton` | Booleano: `true` o `false` | `true` | Permite mostrar **Limpiar orden** cuando hay criterios de orden activos. Con `false` oculta el botón en el editor y las vistas previas; el orden se puede quitar haciendo clic en el encabezado o usando el comando **Restablecer vista**. El cambio se refleja en las vistas abiertas. |
| `spreadsheet-viewer.view.showCopyButtons` | Booleano: `true` o `false` | `true` | Muestra u oculta los botones **Copiar**, **Copiar mostrado** y **Copiar con encabezados**. También habilita o deshabilita `Ctrl+C`/`Cmd+C` al tener el foco en la tabla. La preferencia se aplica a editor y vistas previas y se actualiza en paneles abiertos. |
| `spreadsheet-viewer.view.showFillActions` | Booleano: `true` o `false` | `true` | Muestra u oculta **Rellenar rango**. Repite un patrón de valores o extiende una serie numérica desde dos valores seleccionados, muestra una vista previa y aplica todos los destinos en una operación reversible. Requiere quitar orden, filtros y búsqueda; por ahora admite CSV y XLSX editables, no fórmulas ni ODS. |
| `spreadsheet-viewer.view.showDisplayModeButton` | Booleano: `true` o `false` | `true` | Muestra u oculta **Ver libro** en archivos XLSX. Alterna el formato numérico visible y los valores crudos; no modifica la celda ni el archivo. También cambia lo que copia **Copiar mostrado**. La selección de modo es temporal para el panel y vuelve a crudo al abrir otro archivo. No aplica a CSV u ODS. |
| `spreadsheet-viewer.view.showWorkbookAppearance` | Booleano: `true` o `false` | `true` | Aplica estilos básicos de celda y presenta celdas combinadas de XLSX/ODS. Con `false`, las celdas se muestran sin esos estilos ni combinaciones; los valores, anchos, altos y paneles congelados permanecen. Se actualiza en vistas abiertas y no modifica el archivo. |
| `spreadsheet-viewer.edit.saveOnCommit` | Booleano: `true` o `false` | `true` | Con `true`, cada edición confirmada se guarda automáticamente. Con `false`, la extensión conserva los cambios como pendientes y espera el guardado de VS Code (`Ctrl+S`/`Cmd+S`). Los borradores sin confirmar se preguntan al guardar. |

Ejemplo para desactivar los comentarios convencionales y la persistencia:

```json
{
  "spreadsheet-viewer.csv.commentPrefix": "",
  "spreadsheet-viewer.view.restoreState": false,
  "spreadsheet-viewer.view.showResetButton": false,
  "spreadsheet-viewer.view.showClearSortButton": false,
  "spreadsheet-viewer.view.showCopyButtons": false,
  "spreadsheet-viewer.xlsx.allowFormulaEditing": false,
  "spreadsheet-viewer.xlsx.showFormulaAssistance": false,
  "spreadsheet-viewer.edit.saveOnCommit": false
}
```

El botón **Restablecer vista** muestra una ayuda emergente al pasar el puntero o enfocarlo con el teclado. Restablece búsqueda, orden, filtros, selección y tamaños de vista; no modifica el archivo ni descarta el borrador de edición.

El botón **Limpiar orden** también muestra una ayuda breve al pasar el puntero o enfocarlo. Quita todos los criterios de orden activos; no cambia los datos del archivo.

Las acciones de filas CSV muestran tooltips. Insertar y añadir crean un registro vacío del ancho de la tabla; eliminar pide confirmación. Las operaciones se pueden deshacer y respetan los registros de comentario y el formato del archivo. Se deshabilitan mientras haya orden, filtros o búsqueda activos, y una edición borrador se confirma antes de cambiar la estructura.

## Detalles de comportamiento

### Comentarios CSV

CSV no define comentarios en el estándar. Esta opción habilita una convención de algunas herramientas: una línea que empieza con el prefijo configurado se trata como comentario. La comparación es literal y distingue mayúsculas de minúsculas; el prefijo debe aparecer al principio del registro, sin espacios iniciales. Por ejemplo, con `"#"`, `# nota` es comentario, mientras que ` # nota` y `"#dato"` son datos. La extensión guarda los comentarios originales al guardar cambios en otras celdas. La opción se usa al interpretar el archivo; al cambiarla, el editor vuelve a cargar/reinterpretar el CSV y puede pedir resolver cambios pendientes. En la vista previa se vuelve a interpretar el contenido.

Una fila con cantidad irregular de campos no se convierte por eso en comentario. CSV tampoco impone que todas las filas tengan la misma cantidad de columnas; el tratamiento de filas irregulares depende del contenido y de la aplicación.

El delimitador no tiene una propiedad de Settings actualmente: se detecta al abrir el archivo. `.tsv`/`.tab` fuerzan tabulador; cuando el documento tiene un language ID reconocido, `tsv`, `csv (tab)`, `csv (semicolon)` y `csv (pipe)` (además de sus variantes `csv-semicolon`/`csv-pipe`) fuerzan el delimitador correspondiente. La extensión no requiere Rainbow CSV: usa solo el `languageId` que VS Code ya asignó. En caso de `.tsv`/`.tab`, la extensión del archivo tiene prioridad; en otros archivos de texto, el ID especializado tiene prioridad sobre la detección automática. `csv` genérico conserva la detección automática. La selección que puede aparecer ante una interpretación ambigua es una decisión para esa apertura.

### Proveedores de archivos y escritura

Para URI que usan proveedores de archivos de VS Code, el editor solo habilita cambios cuando `workspace.fs.isWritableFileSystem` confirma que el esquema admite escritura. Los esquemas que indican solo lectura o no informan capacidad se abren en modo de solo lectura; el guardado vuelve a consultar la capacidad antes de escribir. **Guardar como** también valida el destino. La vista previa siempre es de solo lectura. La API de capacidad indica soporte del esquema, no garantiza que una operación específica vaya a funcionar; si el proveedor falla al escribir, se conserva el documento y el borrador queda pendiente.

Los libros XLSM y los paquetes XLSX que declaran contenido macro-enabled, un proyecto VBA o firmas digitales se abren en solo lectura. Las macros no se ejecutan y las fórmulas XLSM muestran la expresión y caché almacenada, sin cálculo. Como no se escribe el paquete, se conservan sus partes VBA y firmas.

### Encabezados

El encabezado solo cambia las etiquetas visuales de las columnas y no la matriz de datos. La primera fila de datos se puede editar como cualquier fila. La capitalización modifica la etiqueta que aparece sobre la columna, no el valor almacenado. Los cambios a `firstRowHeader` y `headerCase` se reflejan visualmente sin reescribir el archivo.

### Estado de vista

El estado se guarda en `workspaceState` de VS Code y se separa entre editor editable y vistas previas. La implementación limita cada registro a 256 KiB, conserva hasta 100 URI de archivo mediante LRU y admite hasta 256 hojas por registro. No guarda matrices, contenido del libro, drafts ni backups en este almacenamiento. El comando **Spreadsheet Viewer: Restablecer vista de hoja** limpia las preferencias de vista para el archivo activo; el botón **Restablecer vista** hace lo mismo desde la tabla. No modifica el archivo.

## Para quienes mantienen la extensión

Al añadir o modificar una propiedad de configuración:

1. Declárala en `contributes.configuration.properties` de `package.json`, con nombre completo, tipo, `default`, `description` y, si aplica, `enum`, `minimum`/`maximum` o `scope`.
2. Lee la opción desde `vscode.workspace.getConfiguration('spreadsheet-viewer.<grupo>', uri)` cuando el comportamiento dependa del recurso. Usa el valor predeterminado declarado también como fallback en código; evita defaults divergentes.
3. Si el cambio debe surtir efecto con una vista abierta, maneja `workspace.onDidChangeConfiguration` y filtra con `affectsConfiguration`. Decide si necesita actualizar presentación, reparsear datos o guardar; no alteres datos guardados por un cambio solamente visual.
4. Valida límites y entradas en el punto de uso. La descripción del manifiesto y este documento deben especificar los valores realmente aceptados y cualquier efecto sobre datos existentes o borradores.
5. Añade o actualiza pruebas para valores predeterminados, valores extremos/invalidación y el comportamiento visible que corresponda.
6. Actualiza **CONFIGURATION.md** en el mismo cambio y añade en `planning.md` el trabajo/documentación correspondiente. Si una propiedad deja de existir, retírala también de este documento y anota cualquier migración necesaria.

La definición publicada en `package.json` es la fuente de verdad para el catálogo de Settings; las lecturas y reacciones en `src/` son la fuente de verdad para los efectos en ejecución. Si no coinciden, corrige ambas y este documento.

El atajo `Ctrl+Alt+Shift+O` (macOS: `Cmd+Alt+Shift+O`) es una contribución de teclado, no una propiedad de Settings. Se puede cambiar desde **Keyboard Shortcuts** de VS Code; su identificador de comando es `spreadsheet-viewer.open`.
