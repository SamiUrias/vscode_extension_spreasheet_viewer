# Change Log

All notable changes to the "spreadsheet-viewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

No unreleased changes.

## [0.0.3] - 2026-10-11

### Added

- Calculate supported XLSX formulas in a local worker and show results without writing calculated values back to the workbook.
- Edit normal XLSX formulas with syntax validation, tested function suggestions, explicit cell-reference insertion, and relative formula fill.
- Fill selected ranges with repeated values or an explicitly chosen numeric series, with preview and undo.
- Create native tables, add/rename/delete sheets, apply basic formatting, merge cells, save frozen panes, and move value ranges in compatible XLSX workbooks.
- Add, append, and delete CSV records; optionally preview the VS Code stdin buffer as a read-only table.
- Open XLSM files in read-only mode without executing macros.

### Fixed

- Load the packaged formula WebAssembly resource through the Extension Host so the formula worker does not time out fetching it from the webview.
- Preserve later edits during consecutive saves and keep recovered drafts pending when manual-save mode is enabled.

### Verified

- The full VS Code test suite passes 113 tests with 1 pending. Production packaging, type checks, lint, the formula worker smoke test, and focused tests for formula editing, fill, XLSX operations, CSV dialects, runtime capabilities, and Restricted Mode pass.
- The 0.0.3 VSIX passes ZIP integrity checks and installs in a clean VS Code 1.141.0 profile. Excel/LibreOffice, VS Code Web/remotes, and some visual/accessibility checks remain unverified; the interface is currently Spanish-only.

## [0.0.2] - 2026-10-11

### Added

- When appending the first row to a completely empty CSV, choose how many fields the record should contain.

### Fixed

- Recovered backups now remain pending when manual-save mode is enabled, instead of being written to disk automatically.
- The README now documents the implemented in-sheet range move and no longer says that moving ranges is unavailable.

### Verified

- Production package, type checks, and lint pass. CSV row operations and recovery lifecycle tests pass, including the empty-file first row and manual-save recovery behavior. Focused formula-fill host coverage verifies preview cancellation, relative references, one-step undo/redo, save scheduling, and stale-revision rejection.
- The broader V2 suite and Extension Host checks are documented in `planning.md`; visual and external-application checks remain open.

## [0.0.1] - 2026-10-11

### Añadido

- Editor de tablas para CSV, TSV, TAB, XLSX y ODS, con navegación entre hojas en libros XLSX y ODS.
- Edición de celdas y guardado en el archivo original, con estado de guardado, recuperación de errores y protección de cambios locales pendientes.
- Vista previa de hojas y vista previa CSV del buffer de texto, incluida la opción de interpretar explícitamente como CSV un archivo de texto con otra extensión.
- Búsqueda en la hoja activa, navegación por referencia de celda y selección con teclado, incluidos rangos y navegación por filas visibles.
- Ordenamiento por varias columnas y filtros por valores o condiciones; los criterios afectan la vista y no reordenan los datos guardados.
- Ajuste manual de columnas y filas, autoajuste de columnas y opciones de ajuste de texto y congelación de filas o columnas de la vista.
- Persistencia por archivo, hoja y modo de la selección, scroll, búsqueda, orden y tamaños; opción para desactivarla y comando **Restablecer vista**, configurable en `settings.json`.
- Configuración para mostrar u ocultar los botones **Restablecer vista** y **Limpiar orden**. Los botones incluidos tienen tooltips explicativos.
- Opciones CSV para prefijo de comentarios, tratamiento de la primera fila como encabezado y capitalización visual de encabezados.
- XLSX: cálculo de fórmulas para presentación con Formualizer 0.10.1. Los resultados calculados no se escriben y el motor no modifica las fórmulas ni las cachés originales.
- ODS: lectura, navegación entre hojas y edición/guardado preservando valores crudos; las fórmulas se muestran con su caché y no se recalculan.
- XLSX: acciones acotadas para crear tablas, gestionar hojas, aplicar formato básico, combinar celdas, congelar paneles y rellenar rangos con valores, series o fórmulas relativas.
- XLSX: mover rangos de valores dentro de una hoja y editar estructura en perfiles compatibles; libros XLSM, VBA o con firma digital permanecen en solo lectura.
- Las acciones de edición XLSX se bloquean cuando el libro contiene estructuras que la operación no puede preservar; los límites por acción están descritos en `README.md`.
- Interfaz: **Recargar** vuelve a leer el archivo desde disco y solicita confirmación cuando hay cambios locales pendientes.

### Cambiado

- La tabla muestra los valores crudos sin convertirlos silenciosamente a fechas, porcentajes u otros formatos visuales.
- La configuración de la extensión y el significado de sus valores están documentados en `CONFIGURATION.md`.
- La versión mínima requerida de VS Code es 1.140, acorde con los tipos y APIs usados al compilar.
- Se incluye la licencia MIT para el proyecto.
- Se incluyen los avisos y textos de licencia de las dependencias empaquetadas.

### Corregido

- Guardados sucesivos de celdas: las ediciones posteriores a la primera también se guardan correctamente.
- Errores de interfaz en libros XLSX cuando faltaba el contenedor de chips de filtros.
- Presentación de los controles de autoajuste y tooltip del botón para limpiar el orden.
