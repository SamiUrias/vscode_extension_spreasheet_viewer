# Localization inventory

Estado inicial de ML-01A. Las claves de runtime se agregan al migrar cada superficie; el inventario de cobertura se completará en ML-02–ML-06.

| Área | Archivo/función o DOM | Claves iniciales | Contexto | Excepción | Estado |
| --- | --- | --- | --- | --- | --- |
| Runtime base | `src/i18n/messages.ts` | `ui.loading`, `ui.sheetCount`, `ui.rowCount`, `ui.openFailed`, `ui.actionFailed`, `ui.rawValue`, `ui.resetView`, `ui.autoFitColumn` | Ejemplos base inglés para estados y acciones de UI | Ninguna | Implementado |
| Runtime español | `src/i18n/es.ts` | Mismas claves que el catálogo base | Traducción española tipada | Ninguna | Implementado |
| Helper | `src/i18n/index.ts` | API `resolveLocale`, `configureLocale`, `getLocale`, `t`, `formatUiNumber` | Normalización, fallback y formato de conteos | El inglés es fallback para locales desconocidos | Implementado |
| Host / preview / manifiesto | `src/extension.ts`, `src/preview.ts`, `package.json` | Pendiente de ML-02/03A | Strings visibles al usuario | IDs y valores del manifiesto permanecen estables | Pendiente |
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
