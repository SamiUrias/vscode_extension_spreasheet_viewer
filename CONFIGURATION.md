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
  "spreadsheet-viewer.view.restoreState": true,
  "spreadsheet-viewer.view.showResetButton": true,
  "spreadsheet-viewer.view.showClearSortButton": true,
  "spreadsheet-viewer.view.showCopyButtons": true,
  "spreadsheet-viewer.edit.saveOnCommit": true
}
```

Los valores siguientes son los predeterminados. No hace falta escribirlos en `settings.json` salvo que quieras sobrescribirlos. Las propiedades no declaran un ámbito de recurso o lenguaje; se configuran en User o Workspace Settings, no como una opción distinta para cada archivo CSV.

Para probar el comportamiento de la extensión en este repositorio, `.vscode/settings.json` activa las ocho opciones disponibles: las opciones CSV, restauración de vista, botones **Restablecer vista**, **Limpiar orden** y copia, además del guardado al confirmar. `headerCase: "upper"` solo transforma la etiqueta visual; no cambia el archivo. Las opciones de autoajuste, multilínea, freeze y teclado de tabla de V2-09/V2-10 son controles de vista, no propiedades de `settings.json`.

## Opciones disponibles

| Propiedad | Tipo y valores admitidos | Predeterminado | Efecto |
| --- | --- | --- | --- |
| `spreadsheet-viewer.csv.commentPrefix` | Cadena de 0 a 128 caracteres | `"#"` | Interpreta como comentario un registro CSV cuyo primer texto sea exactamente este prefijo. Los comentarios se conservan en el archivo, se pueden ocultar de la tabla y no se editan como celdas. Una cadena vacía desactiva la detección de comentarios. |
| `spreadsheet-viewer.csv.firstRowHeader` | Booleano: `true` o `false` | `true` | Si es `true`, usa el primer registro de datos (no un comentario) como etiqueta visual de las columnas. No elimina ni mueve esa fila: sigue apareciendo en la tabla como dato editable. |
| `spreadsheet-viewer.csv.headerCase` | Cadena: `"none"`, `"upper"` o `"lower"` | `"none"` | Deja igual, convierte a mayúsculas o convierte a minúsculas las etiquetas visuales del encabezado. No cambia el texto guardado en el CSV. |
| `spreadsheet-viewer.view.restoreState` | Booleano: `true` o `false` | `true` | Guarda y restaura por archivo, hoja y modo de vista la selección, scroll, búsqueda, orden, visibilidad de comentarios y tamaños manuales de columnas/filas. Con `false` no lee ni guarda este estado. No afecta el contenido, los cambios pendientes ni los backups del documento. |
| `spreadsheet-viewer.view.showResetButton` | Booleano: `true` o `false` | `true` | Muestra u oculta el botón **Restablecer vista** en el editor y las vistas previas. Con `false` el botón no aparece; la acción de restablecimiento sigue disponible como **Spreadsheet Viewer: Restablecer vista de hoja** en la paleta de comandos. El cambio se refleja en las vistas que ya están abiertas. |
| `spreadsheet-viewer.view.showClearSortButton` | Booleano: `true` o `false` | `true` | Permite mostrar **Limpiar orden** cuando hay criterios de orden activos. Con `false` oculta el botón en el editor y las vistas previas; el orden se puede quitar haciendo clic en el encabezado o usando el comando **Restablecer vista**. El cambio se refleja en las vistas abiertas. |
| `spreadsheet-viewer.view.showCopyButtons` | Booleano: `true` o `false` | `true` | Muestra u oculta los botones **Copiar**, **Copiar mostrado** y **Copiar con encabezados**. También habilita o deshabilita `Ctrl+C`/`Cmd+C` al tener el foco en la tabla. La preferencia se aplica a editor y vistas previas y se actualiza en paneles abiertos. |
| `spreadsheet-viewer.edit.saveOnCommit` | Booleano: `true` o `false` | `true` | Con `true`, cada edición confirmada se guarda automáticamente. Con `false`, la extensión conserva los cambios como pendientes y espera el guardado de VS Code (`Ctrl+S`/`Cmd+S`). Los borradores sin confirmar se preguntan al guardar. |

Ejemplo para desactivar los comentarios convencionales y la persistencia:

```json
{
  "spreadsheet-viewer.csv.commentPrefix": "",
  "spreadsheet-viewer.view.restoreState": false,
  "spreadsheet-viewer.view.showResetButton": false,
  "spreadsheet-viewer.view.showClearSortButton": false,
  "spreadsheet-viewer.view.showCopyButtons": false,
  "spreadsheet-viewer.edit.saveOnCommit": false
}
```

El botón **Restablecer vista** muestra una ayuda emergente al pasar el puntero o enfocarlo con el teclado. Restablece búsqueda, orden, filtros, selección y tamaños de vista; no modifica el archivo ni descarta el borrador de edición.

El botón **Limpiar orden** también muestra una ayuda breve al pasar el puntero o enfocarlo. Quita todos los criterios de orden activos; no cambia los datos del archivo.

## Detalles de comportamiento

### Comentarios CSV

CSV no define comentarios en el estándar. Esta opción habilita una convención de algunas herramientas: una línea que empieza con el prefijo configurado se trata como comentario. La comparación es literal y distingue mayúsculas de minúsculas; el prefijo debe aparecer al principio del registro, sin espacios iniciales. Por ejemplo, con `"#"`, `# nota` es comentario, mientras que ` # nota` y `"#dato"` son datos. La extensión guarda los comentarios originales al guardar cambios en otras celdas. La opción se usa al interpretar el archivo; al cambiarla, el editor vuelve a cargar/reinterpretar el CSV y puede pedir resolver cambios pendientes. En la vista previa se vuelve a interpretar el contenido.

Una fila con cantidad irregular de campos no se convierte por eso en comentario. CSV tampoco impone que todas las filas tengan la misma cantidad de columnas; el tratamiento de filas irregulares depende del contenido y de la aplicación.

El delimitador no tiene una propiedad de Settings actualmente: se detecta al abrir el archivo, y `.tsv`/`.tab` fuerzan tabulador. La selección de delimitador que puede aparecer ante una interpretación ambigua es una decisión para esa apertura.

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
