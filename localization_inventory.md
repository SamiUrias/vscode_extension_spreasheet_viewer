# Localization inventory

Inventario incremental de cobertura de manifiesto y runtime. Las claves de runtime se agregan al migrar cada superficie.

| Área | Archivo/función o DOM | Claves iniciales | Contexto | Excepción | Estado |
| --- | --- | --- | --- | --- | --- |
| Runtime base | `src/i18n/messages.ts` | `ui.loading`, `ui.sheetCount`, `ui.rowCount`, `ui.openFailed`, `ui.actionFailed`, `ui.rawValue`, `ui.resetView`, `ui.autoFitColumn` | Ejemplos base inglés para estados y acciones de UI | Ninguna | Implementado |
| Runtime español | `src/i18n/es.ts` | Mismas claves que el catálogo base | Traducción española tipada | Ninguna | Implementado |
| Conflicto de guardado | `src/user-errors.ts`, `src/storage.ts`, `src/storage-node.ts`, `src/editor.ts` | Error code `external-file-conflict` | Identifica conflicto externo sin depender del mensaje | El texto de usuario sigue en español hasta ML-03A/B | Implementado en ML-01B |
| Capacidad estructural XLSX | `src/protocol.ts`, `src/formats/xlsx-structure.ts`, `src/editor.ts`, `src/structure-capability.ts`, `src/webview/main.ts` | `reasonCode: pending-changes` | Reactiva acciones después de `saved`/`clean` solo para bloqueo transitorio | Los motivos de incompatibilidad restantes conservan su bloqueo | Implementado en ML-01B |
| Acciones del host | `src/editor.ts` (`copy`, reload, external conflict, drafts, dirty text buffer) | IDs `copy`, `reload`, `apply`, `save`, `cancel`, `discard` | La acción se decide por id de `MessageItem` | Los títulos visibles se localizan en ML-03A/B | Implementado en ML-01B |
| Prompt de relleno | `src/fill-prompt.ts`, `src/webview/main.ts` | Opciones en/es mapeadas a `down`, `right`, `repeat`, `series` | Parser puro del prompt de relleno | No altera contenido de celdas; cancelar/vacío/desconocido cancela | Implementado en ML-01B |
| Helper | `src/i18n/index.ts` | API `resolveLocale`, `configureLocale`, `getLocale`, `t`, `formatUiNumber` | Normalización, fallback y formato de conteos | El inglés es fallback para locales desconocidos | Implementado |
| Metadatos públicos de extensión | `package.json` → `description` | `extension.description` | Descripción pública de capacidades | Nombres propios y marca se conservan | ML-02 implementado |
| Títulos de comandos | `package.json` → `contributes.commands` | `command.open`, `command.preview`, `command.previewBuffer`, `command.previewCsv`, `command.resetView` | Cinco títulos mostrados por VS Code | IDs de comandos y categoría no se traducen | ML-02 implementado |
| Settings del manifiesto | `package.json` → `contributes.configuration.properties` | `config.csv.*`, `config.stdin.*`, `config.xlsx.*`, `config.view.*`, `config.edit.*` (21 claves) | Descripciones en la pantalla Settings | IDs, tipos, enums y defaults permanecen estables | ML-02 implementado |
| Catálogos NLS del manifiesto | `package.nls.json`, `package.nls.es.json` | 27 claves de descripción/comandos/configuración | Inglés base/fallback y español | Claves exactas y placeholders se validan con `check:localization` | ML-02 implementado |
| Host / preview | `src/extension.ts`, `src/preview.ts` | Pendiente de ML-03A | Strings visibles al usuario | IDs y valores del manifiesto permanecen estables | Pendiente |
| HTML y webview | `src/editor.ts`, `src/webview/main.ts`, `src/webview/grid-renderer.ts`, `src/webview/selection.ts` | Pendiente de ML-04/05 | Labels, estados, tooltips y accesibilidad | Datos y nombres del documento no se traducen | Pendiente |
| Dominio, adaptadores y worker | `src/*.ts`, `src/formats/*.ts`, `src/webview/formula-worker.ts` | Pendiente de ML-03B/03C/04 | Errores propios y descripciones | Detalle externo se conserva como diagnóstico | Pendiente |

## Glosario inicial

| English | Español |
| --- | --- |
| sheet | hoja |
| row | fila |
| column | columna |
| raw value | valor crudo |
| draft | borrador |
| sort | ordenar |
| filter | filtro |
| reset view | restablecer vista |
| auto-fit | autoajustar |

Al añadir una clave, incluirla en ambos catálogos con la frase completa y placeholders equivalentes. No construir HTML ni concatenar fragmentos de traducción; interpolar datos sin re-evaluarlos.
