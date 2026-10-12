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
| Host / preview | `src/extension.ts`, `src/preview.ts` | `host.*`, `preview.*` en `src/i18n/messages.ts` y `src/i18n/es.ts` | Validaciones de comandos, errores presentados, estado de origen, título/modeLabel preview, confirmación clipboard y selección CSV | `sourceMode`, URI, contenido, formatos/limites técnicos y causas externas permanecen intactos | ML-03A implementado |
| Persistencia y recovery | `src/storage.ts`, `src/storage-node.ts`, `src/recovery.ts` | `storage.*`, `recovery.*` en `src/i18n/messages.ts` y `src/i18n/es.ts` | Errores propios de permisos, verificación, conflicto, respaldo y sobre/daño de recovery | Rutas interpoladas y objetos `cause` se conservan; operaciones y contratos de bytes intactos | ML-03A implementado |
| Acciones y estados del editor | `src/editor.ts` (open, save/reload, edit/draft, formula/fill, CSV/XLSX structure/table/sheet/move/style, conflict/output/history) | `editor.*` en `src/i18n/messages.ts` y `src/i18n/es.ts` | Mensajes y etiquetas completas con placeholders; confirmaciones comparan IDs estables | URI, nombre de hoja/tabla, delimitador, tipo de celda, límites, contenido de fórmulas y causas externas se pasan como datos. `getHtml` sigue pendiente ML-04A; capability reasons del formato pueden tener texto propio de ML-03C | ML-03B verificado localmente |
| Dominio y adaptadores | `src/edit-model.ts`, `clipboard.ts`, `fill.ts`, `move-range.ts`, `formula-reference.ts`, `formats/csv.ts`, `xlsx.ts`, `ods.ts` | `domain.cell.*`, `domain.fill.*`, `domain.move.*`, `domain.clipboard.*`, `domain.formula.*`, `domain.csv.*`, `domain.xlsx.*`, `domain.ods.*` | Validaciones y warnings propios; conteos de UI formateados por locale | Causas externas CSV parser conservadas como argumento. Valores, fórmulas, bytes y estructura OOXML/ODF intactos | ML-03C implementado |
| Formula help | `src/formula-assistance.ts` | `domain.formula.help.*` (21 claves) | Descripción elegida por locale al solicitar completions | Nombres y firmas Excel permanecen en inglés como sintaxis | ML-03C implementado |
| Capability XLSX | `src/formats/xlsx-structure.ts`, `src/document.ts`, `src/editor.ts`, `src/protocol.ts`, `src/webview/main.ts` | `reasonCode` estables: `not-xlsx`, `unsafe-profile`, `connections`, `missing-structure`, `missing-sheet`, `unsupported-sheet-content`, `unknown-parts`, `defined-names`, `external-references`, `unsupported-cells`, `protected-structures`, `external-diagnostic`, `read-only`, `pending-changes` | La webview traduce por código y conserva reason externo como dato | Sin comparar el texto del reason para decidir comportamiento; el helper ML-01B reactiva solo `pending-changes` | ML-03C implementado |
| Excepciones ML-03C / siguientes | `document.ts`, errores internos de adaptadores XLSX/ODS, `xlsx-sheets.ts`, `xlsx-tables.ts`, `xlsx-styles.ts`, `view-metadata.ts`; `editor.ts` `getHtml` | Pendiente ML-04/05 para UI webview; ML-06 para cobertura | Causas OOXML/XML, diagnósticos del parser, errores de serialización y fallos de invariantes siguen como errores/args técnicos | Nombres sintéticos `Hoja N` son identificadores estables, no localizar. Celdas, rutas, nombres, códigos de parser, XML/bytes y detalle externo no se traducen | Excepciones registradas; revisar sinks webview durante ML-04/05 |
| HTML inicial | `src/editor.ts` → `getHtml` | `html.runtime.*`, `ui.loading`, `webview.startup.*` en catálogos es/en | Etiquetas, botones, opciones visibles, tooltips, `title`, `aria-label`, búsqueda y estados de bootstrap; todo texto HTML pasa por `escapeHtml` | `General`, numeric formats, option values, IDs, selectors, CSP/nonces y `B54` (referencia de celda) conservan su valor. Filename/mode se escapan como HTML | ML-04A implementado; test de getHtml agregado (host pendiente) |
| Bootstrap y protocolo locale | `src/webview/main.ts`, `src/protocol.ts`, `src/editor.ts`, `src/preview.ts`, `src/i18n/index.ts` | `LocalizationMessage`, `localizationLocaleFromMessage`, `setActiveLocale` | `<html lang>` inicial, locale idempotente antes de acceso DOM, primer mensaje de `ready` editor/preview; payload desconocido ignorado | Cambios de locale live no reconstruyen grid, estado ni draft. Host real pendiente por bloqueo registrado | ML-04A implementado localmente |
| Worker | `src/webview/main.ts`, `src/webview/formula-worker.ts` | `worker.wasmMissing` | Locale incluido en `calculate`, validado/configurado antes de error propio WASM | Resultados, fórmulas, request IDs y datos técnicos no se localizan | ML-04A implementado y verificado en web-target |
| Webview dinámica | `src/webview/main.ts`, `src/webview/grid-renderer.ts`, `src/webview/selection.ts` | Pendiente de ML-05A/B/C | Mensajes y controles que cambian después del HTML inicial | Datos y nombres del documento no se traducen | Pendiente |
| Dominio, adaptadores y worker | `src/*.ts`, `src/formats/*.ts`, `src/webview/formula-worker.ts` | Pendiente de ML-03C/04 | Errores propios y descripciones | Detalle externo se conserva como diagnóstico | Pendiente |

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
