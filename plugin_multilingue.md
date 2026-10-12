# Internacionalización español/inglés — objetivo release 1.0.0

**Estado:** planificación técnica detallada; ML-01A, ML-01B y ML-02 implementadas localmente; quedan tarjetas pendientes. **Revisión:** 2026-10-11 sobre el código 0.0.3. **Planificador solicitado:** GPT-6.1 Sol, esfuerzo medio. **Implementador previsto:** GPT-6 Luna, esfuerzo bajo, una subtarjeta por vez.

El usuario considera el estado actual de V2 suficiente para empezar los idiomas. Este bloque puede comenzar ahora, manteniendo los checks abiertos de V2 en sus tarjetas. La entrega con interfaz completa en español e inglés será **1.0.0**; no implica declarar verificados los hosts, formatos o checks externos pendientes. La versión se cambia al preparar el release, no al empezar a traducir. No se ejecuta V3 durante este trabajo.

## 1. Resultado esperado y decisiones ya resueltas

- Con VS Code en español, comandos, Settings, notificaciones, diálogos, editor y previews se muestran en español. En inglés, se muestran en inglés. El idioma lo determina **Display Language** de VS Code, disponible como `vscode.env.language`; no el idioma de un CSV, el language ID del editor, la región del sistema ni el contenido del documento.
- No añadir selector de idioma, `localization.enabled`, carga de traducciones externas ni botones nuevos en 1.0.0. La localización se aplica automáticamente a toda la UI. Cambiar Display Language y reiniciar la ventana aplica el nuevo idioma; no hace falta implementar cambios de idioma live ni un nuevo listener de Settings.
- **Inglés como idioma base y fallback coherente en las tres superficies.** Español es la traducción incluida. `es` y variantes regionales se normalizan a `es` en el runtime; `en` y demás idiomas a `en`. Comprobar el fallback regional del manifiesto con VS Code real.
- No modificar valores, encabezados del documento, nombres de hojas/tablas ya existentes, comentarios/notas, fórmulas, referencias A1, formatos numéricos Excel, tipos, operadores, IDs, URIs, separadores, codificaciones, drafts, historial o preferencias guardadas. Localizar exclusivamente texto generado para UI.
- Los errores propios se traducen completos, incluidos detalles propios originados en adaptadores. Los detalles externos de VS Code/parser/librería se conservan como diagnóstico dentro de una explicación localizada; no intentar traducir por coincidencias de frases externas.
- Mantener los botones/tooltips actuales y traducirlos juntos. Los ajustes existentes conservan IDs, valores y defaults. Toda nueva funcionalidad opcional futura sigue la regla de `default: true`, documentación y tooltip; **esta entrega no añade una nueva feature opcional**, y por eso no inventa un boolean para apagar el idioma.

### Qué corrige este plan respecto al anterior

El plan anterior proponía español fuente, `package.nls.en.json`, `bundle.l10n.en.json` y un boolean para desactivar mensajes dinámicos. La documentación oficial indica que inglés usa `package.nls.json`; el bundle runtime normalmente no se carga en el idioma por defecto. Esa propuesta podía dejar español con VS Code en inglés. Además, el boolean afectaría host/webview, mientras VS Code seguiría traduciendo el manifiesto: produciría una UI mezclada.

Se reemplaza el fallback español heredado por fallback inglés explícito para alinear manifiesto y runtime con el mecanismo estándar de VS Code. Un fallback español solo en runtime mezclaría idiomas en VS Code alemán, por ejemplo. Conservar fallback español en **todas** las superficies exigiría una estrategia adicional de manifiesto/idiomas que no aporta valor a la primera entrega es/en. Esta es una decisión de implementación de este plan, no una capacidad ya entregada; documentarla en README y CONFIGURATION. Si se pide después otro fallback, diseñarlo como cambio separado.

## 2. Inspección del código actual y cobertura obligatoria

Confirmado en el repo: `package.json` 0.0.3, engine `^1.140.0`, tipos `@types/vscode ^1.140.0`, 5 comandos y **21 Settings**. El plan anterior hablaba de seis opciones: ya está desactualizado. Node de trabajo: `.nvmrc` / 24.21.0. Entradas desktop y Web distintas; la webview también tiene un worker WASM propio.

| Superficie | Archivos y puntos reales | Texto a cubrir |
| --- | --- | --- |
| Manifiesto | `package.json` | Descripción de extensión, 5 títulos de comandos, 21 descripciones de Settings; textos visibles adicionales que se encuentren. Nombre/categoría `Spreadsheet Viewer` y marca/autor permanecen como nombre propio. Los menús actuales remiten a comandos, no tienen títulos extra. |
| Activación | `src/extension.ts`, entradas `src/extension-node.ts`, `src/extension-web.ts` | Mensajes de apertura, stdin, preview/buffer/CSV, restablecimiento. Inicialización de idioma común antes de crear providers o parsear documentos. |
| Editor/host | `src/editor.ts` | Notificaciones, progreso, confirmaciones, Quick Picks, Input Boxes, selección de dialecto, guardado/recarga/conflictos, permisos, recuperación, edición/fórmulas, relleno, estructura, tablas, hojas, formato, etiquetas undo/redo y output visible. |
| Preview | `src/preview.ts` | Título del panel y modo `Vista previa`, fuente disco/buffer, límites, dialecto, portapapeles, reload y estado recuperado. Usa el HTML de `editor.getHtml`. |
| HTML inicial | `src/editor.ts` → `getHtml` | `<html lang>`, loading, labels, botones, select/options de presentación, tooltips, placeholders, aria-label, grupos, `<title>` y encabezado. No cambiar IDs/selectors/CSP/nonces. |
| Webview dinámica | `src/webview/main.ts` | Startup, dimensiones, estados de save/reload, navegación y hojas, edición inline, panel de fórmula, búsqueda, sort/filter/chips/popups, range/fill/move, XLSX actions, autoajuste/freeze/wrap y errores. Incluye `window.prompt`, no solo `textContent`. |
| Renderer/selección | `src/webview/grid-renderer.ts`, `src/webview/selection.ts` | Hoja vacía, cabeceras/resize/filter, accesibilidad de celdas, fórmula/cache/resultado, celda ausente/vacía y avisos. |
| Ayuda de fórmulas | `src/formula-assistance.ts`, `src/formula-reference.ts` | Descripciones de las 21 funciones, diagnósticos/validación. Mantener `ABS`, `SUMPRODUCT`, firmas, tokens de inserción y referencias. |
| Dominio compartido | `src/clipboard.ts`, `src/edit-model.ts`, `src/fill.ts`, `src/move-range.ts`, `src/document.ts`, `src/recovery.ts` | Validaciones y `reason`/warnings visibles que hoy se construyen en español y llegan a host/webview. |
| Adaptadores | `src/formats/csv.ts`, `xlsx.ts`, `ods.ts`, `xlsx-structure.ts`, `xlsx-sheets.ts`, `xlsx-tables.ts`, `xlsx-styles.ts` | Errores propios, límites, warnings macros/firmas/protección/partes no compatibles. Revisar también `view-metadata.ts` por strings visibles aunque no tengan acentos. |
| Persistencia/IO | `src/storage.ts`, `src/storage-node.ts`; revisar `src/filesystem-capability.ts`, `src/csv-dialect.ts`, `src/formula-parser-loader.ts` | Conflictos, verificación, recuperación, rutas/causas externas; localizar presentación sin cambiar operaciones IO. |
| Worker | `src/webview/formula-worker.ts` | Diagnóstico propio de bytes WASM ausentes; inicializar el mismo locale en el worker. Mensajes del motor y `FormulaEvaluation.reason` siguen códigos/datos. |
| Pruebas/build | `src/test/*.test.ts`, `scripts/test-*.js`, `esbuild.js`, `.vscode-test.mjs`, `.vscodeignore`, tsconfigs | Expectativas con texto español/labels, mocks del host, tres bundles JS y worker, exclusiones VSIX y ejecución con locale. |

Este mapa es la cobertura inicial, no un conteo definitivo de strings. Buscar también texto sin acentos, templates, `new Error`, `warnings.push`, `reason`, `sourceStatus`, labels undo/redo, `title`, `placeholder`, `aria-*`, `window.prompt/confirm`, `innerHTML` y asignaciones DOM. No basta un `rg` de acentos para afirmar cobertura total.

## 3. Arquitectura elegida para que Luna pueda implementarla

### 3.1 Manifiesto: NLS nativo de VS Code

Crear `package.nls.json` (inglés base) y `package.nls.es.json` (español) en raíz. Reemplazar textos traducibles de `package.json` por `%extension.description%`, `%command.open.title%`, `%config.view.restoreState.description%`, etc. Usar claves estables por contexto. No crear `package.nls.en.json`: inglés ya es el base.

No traducir IDs de commands/viewType/Settings, `when`, filenamePattern, enum values (`none`, `upper`, `lower`), categorías API, keywords, formatos ni shortcuts. Si se añaden `enumDescriptions` por legibilidad, localizarlas; no son necesarias para aprobar esta fase. Revisar las 21 propiedades actuales, no copiar la cantidad del plan antiguo.

### 3.2 Runtime: catálogo pequeño compartido, sin dependencia nueva

Usar un helper **puro y compartido** por host, módulos de dominio, webview y worker. Es la alternativa elegida a `vscode.l10n.t`: muchos errores se originan en módulos compartidos con navegador y tests sin API VS Code. Importar `vscode` allí rompería Web; convertir todos los errores en descriptors y depender de extracción de wrappers agregaría trabajo y riesgos innecesarios para esta entrega.

Archivos propuestos obligatorios:

```text
src/i18n/messages.ts       catálogo base inglés; claves por contexto y strings con {0}, {1}
src/i18n/es.ts             mismo conjunto de claves en español, tipado contra el base
src/i18n/index.ts          resolveLocale, configureLocale, getLocale, t, formatUiNumber
package.nls.json           catálogo estático inglés (solo manifiesto)
package.nls.es.json        catálogo estático español
src/test/localization.test.ts       unit tests del helper/catálogos/contratos
scripts/test-localization.js        runner Node sin host, patrón de scripts existentes
scripts/check-localization.js       guard de cobertura/inventario y manifiesto
localization_inventory.md           inventario revisable de superficies/keys/exclusiones
```

El catálogo se empaqueta por imports en `dist/extension.js`, `extension-web.js`, `webview.js` y `formula-worker.js`; **no** hay fetch de JSON ni lectura Node para obtener idioma. No añadir `l10n` en package.json ni archivos `bundle.l10n.*` si se usa esta arquitectura: no anunciar que VS Code carga un runtime bundle que no existe. No instalar `@vscode/l10n`/`l10n-dev` para después no usarlos. Tradeoff documentado: catálogo propio tipado, mantenimiento manual de dos idiomas; migrar a tooling oficial más adelante requiere una decisión distinta.

Contrato del helper:

- `type UiLocale = 'en' | 'es'`; `resolveLocale(language: string): UiLocale`: normaliza case y `_` a `-`, `es`/`es-*` → `es`; resto → `en`. Probar `es`, `es-MX`, `ES_gt`, `en`, `en-US`, `de`, vacío.
- `configureLocale(language: string): void` guarda solo idioma del runtime actual; inicial `en`. Cada bundle/worker tiene su instancia. `getLocale(): UiLocale` devuelve el resuelto.
- `MessageKey = keyof typeof messages`. Español usa `satisfies Record<MessageKey, string>`; no `as Record` para silenciar faltantes. Base inglés se declara con `as const`.
- `t(key: MessageKey, ...args: Array<string | number | boolean>): string`: usa español o base inglés; reemplaza placeholders con una función callback (no replacement string susceptible a `$&`/`$1`). No interpreta HTML, no vuelve a sustituir placeholders contenidos en los argumentos y no usa `eval`.
- Catálogo completo requerido en build. Fallback defensivo por clave faltante devuelve base inglés, nunca `undefined`/key vacía. Un key desconocido es error de tipos; payloads externos se validan antes de llamar, no silenciar inconsistencias internas.
- `formatUiNumber(value: number): string`: `Intl.NumberFormat(getLocale())` para **conteos/estados de UI**. Mantener valores de celdas, formatos SSF, numeric parsers, fechas de archivo y comparación de sort exactamente como están. No usar idioma de UI para cambiar semántica de orden, búsqueda o edición.
- Frase completa por mensaje con placeholders. Singular/plural frecuente usa dos claves explícitas; no introducir framework de plurales para solo en/es. Glossary: hoja/sheet, fila/row, columna/column, valor crudo/raw value, borrador/draft, ordenar/sort, filtro/filter, restablecer vista/reset view, autoajustar/auto-fit.

No construir strings localizados a nivel de módulo antes de `configureLocale`. Arrays de ayuda/labels se guardan como keys o se calculan dentro de funciones. Por ejemplo, `getFormulaCompletions` produce `description: t(descriptionKey)` al pedir completions; conserva la forma pública existente y la semántica de `name/signature`.

### 3.3 Inicialización sin flicker ni mensajes perdidos

1. `activateCore` en `src/extension.ts` llama `configureLocale(vscode.env.language)` antes de instanciar providers/registrar flujos. Entradas node/web siguen delegando a activateCore, sin API alternativa de idioma.
2. `editor.getHtml` genera todas las etiquetas con `escapeHtml(t(...))`; pone `<html lang="en|es">`. La traducción no puede inyectar markup. Mantiene interpolaciones seguras de filename/modo como hoy.
3. `src/webview/main.ts` inicializa el helper desde `document.documentElement.lang` **antes** de instalar handlers de startup, hacer `requiredElement`, construir labels, pedir datos o crear worker. Así los fallos de arranque ya tienen idioma correcto y el HTML inicial no muestra español esperando un catálogo inglés.
4. Añadir `LocalizationMessage { type: 'localization'; locale: UiLocale }` a `ExtensionToWebviewMessage` en `src/protocol.ts`. El host lo envía como primer mensaje de cada `ready`, tanto editor como preview. `ready` se reintenta hasta 5 veces: envío idempotente. Mantener orden y listeners actuales, no agregar segundo handshake bloqueante.
5. La webview acepta exclusivamente `en/es`, configura el helper y ajusta `html.lang`. Repetir el mismo locale no resetea snapshot, vista, draft o selección. El idioma de la ventana no cambia live; si un test fuerza un locale distinto, puede actualizar labels estáticos por mapa explícito sin reconstruir grid/editor. No crear ciclo de recarga del documento para cambiar texto.
6. El request `calculate` enviado al worker incluye `locale: UiLocale`. `formula-worker.ts` lo valida/configura antes de errores propios. Mantener requestId/revision/resultados/AST y cálculo intactos.

Enviar solo locale, no cientos de strings por panel. Catálogos incluidos en los bundles evitan red y nuevos recursos CSP. Las nuevas interfaces usan imports `type` de módulos puros; nunca importar API VS Code en webview/worker. `tsconfig.webview.json` incluye el módulo compartido transitivamente por imports.

### 3.4 Desacoplar texto de decisiones antes de traducir

Hay dependencias reales confirmadas que no deben sobrevivir como comparaciones con español:

| Lugar actual | Problema | Cambio mínimo necesario |
| --- | --- | --- |
| `editor.ts` catch de save: `message.includes('cambió en disco')` | En inglés deja de programar comprobación externa. | Crear error de conflicto con `code` estable, por ejemplo `external-file-conflict`, en módulo puro compartido de errores. Emitirlo desde los conflictos de `storage.ts`, `storage-node.ts` y el preflight de save del editor; detectar code/tipo, no texto. Conservar causa, backup y políticas IO. |
| `webview/main.ts` `updateSaveStatus` compara `structureCapability.reason` español | En inglés puede no rehabilitar las acciones tras guardar. | Añadir `reasonCode?: 'pending-changes'` al contrato/capacidad usado para ese caso, en `formats/xlsx-structure.ts`, `protocol.ts` y productor `editor.ts`. Consumir reasonCode; reason sigue siendo presentación. No marcar allowed true para otros bloqueos. |
| Diálogos editor/preview comparan `'Copiar de todos modos'`, `'Cancelar'`, `'Aplicar borradores y guardar'` | Traducir solo la etiqueta pierde la acción. | Usar objetos `MessageItem` con `title: t(...)` y `id` estable; comparar el objeto/id. En QuickPick conservar `value`/id interno. Actualizar mocks para devolver items, sin seleccionar por texto español. |
| Relleno en `main.ts` parsea `abajo/derecha/repetir/serie` de `window.prompt` | Un prompt inglés no acepta la respuesta inglesa. | Extraer parser pequeño de opciones que mapee `down/abajo`, `right/derecha`, `repeat/repetir`, `series/serie` a enums existentes; prompts y defaults se muestran en el locale activo. Cancel/vacío/unknown conservan cancelación. No agregar un nuevo diálogo visual en esta fase. |
| Tests/harnesses comparan frases/labels españoles | Pueden fallar por traducción aunque comportamiento esté bien o esconder cambios reales. | Para checks de mensaje, configurar locale explícito y restaurar después. Para acciones, comparar id/enum/code. No sustituir todas las aserciones por regex vaga ni quitar cobertura de corrupción/guardado. |

`storage.ts` tiene un `message.includes(backup.toString())`: compara una URI diagnóstica, no una frase traducible. Mantener el argumento URI intacto; probar que la recuperación no cambia. `isCancellationError` usa tipos/codes más fallback `canceled/cancelled` de proveedores: no traducir esos nombres/codes ni reemplazar CancellationError por error genérico.

## 4. Etapas ejecutables y commits

**Estado por tarjeta en la tabla.** Cada subtarjeta se implementa y se verifica separadamente; el estado distingue `implementada`, `verificada` y `pendiente de entorno`. Al cerrar una etapa, actualizar este documento y el estado breve de planning.md antes de commit. Después del commit, confirmar `git status`/log y coherencia del estado. No introducir refactor funcional incidental.

| Tarjeta | Depende | Entrega acotada | Commit sugerido |
| --- | --- | --- | --- |
| ML-01A | 0.0.3 | Inventario/glosario y helper/catálogos mínimos con tests. | Implementada (commit previo) |
| ML-01B | ML-01A | Quitar las dos decisiones por frase, IDs de acciones y parser de prompts; tests de comportamiento. | Implementada (commit previo; Extension Host pendiente) |
| ML-02 | ML-01A | Manifiesto NLS completo, 21 Settings y tests del manifiesto. | Implementada en este commit: `feat(i18n): localize extension commands and settings` |
| ML-03A | ML-01B | Inicialización host y mensajes extensión/preview/dialogs/IO. | `feat(i18n): localize extension and preview messages` |
| ML-03B | ML-03A | **Implementada y verificada localmente (2026-10-11)**. Mensajes visibles de save/reload/edit/formulas/fill, estructura CSV/XLSX, tablas/hojas/movimiento/estilo, conflictos, prompts, history y Output en `editor.ts`; el HTML de `getHtml` sigue en ML-04A. | `feat(i18n): localize editor actions and save feedback` |
| ML-03C | ML-01B | Mensajes dominio/adaptadores, capabilities/warnings y ayuda de funciones. | `feat(i18n): localize document validation and formula help` |
| ML-04A | ML-02, ML-03A/B/C | HTML inicial completo, bootstrap webview, protocolo locale/ready y worker. | `feat(i18n): initialize localized editor and webview safely` |
| ML-05A | ML-04A | Startup/grid/selección/celda, save/reload, fórmulas, sheets y preview dinámico. | `feat(i18n): localize grid navigation and cell feedback` |
| ML-05B | ML-05A | Search/sort/filter, popup/chips/operators, autosize/freeze/wrap. | `feat(i18n): localize search filters and view controls` |
| ML-05C | ML-05A, ML-01B | Acciones range/copy/fill/move/CSV/XLSX restantes, prompts y estados. | `feat(i18n): localize range and workbook action feedback` |
| ML-06A | ML-02…05 | Cobertura, invariantes de datos, docs y smoke acotado en/es. | `test(i18n): verify localization coverage and document language behavior` |
| ML-06B | ML-06A | Preparación release 1.0.0, VSIX, instalación limpia y checklist; publicar solo con autorización. | `chore(release): prepare bilingual spreadsheet viewer 1.0.0` |

Las subtarjetas ML-03C y ML-02 son independientes de la traducción webview. Esta dependencia permite seguir avanzando si una comprobación GUI falla por entorno. El release requiere completar los cambios funcionales de las tres superficies; los checkpoints intermedios pueden mostrar partes aún sin traducir y no se anuncian como bilingües terminados.

### ML-01A — Inventario y helper

**Estado local (implementada; 2026-10-11):** helper puro `src/i18n/index.ts`, catálogos ingles/español con 8 mensajes iniciales y glosario/inventario inicial creados. `src/test/localization.test.ts`, `scripts/test-localization.js` y `npm run test:localization` cubren locales regionales, inglés fallback, placeholders repetidos/reordenados y datos `$`/llaves, fallback defensivo y formato numérico UI. `npm run check-types` pasa; lint y test focalizado pasan con Node 24.21.0. En Node 18.20.4, `npm run lint` falla en el formatter de ESLint por `util.styleText is not a function`; ejecución directa de ESLint con Node 24.21.0 pasa (dos warnings de estilo corregidos y lint final pendiente de repetir). No se migró UI ni manifiesto. **Pendiente:** ampliar inventario y catálogos al migrar cada superficie; migración de UI, NLS, bootstrap/worker y verificaciones reales pertenecen a tarjetas posteriores.

- Crear `localization_inventory.md` con área/archivo+función o DOM id, clave(s), contexto, excepción justificada y estado. Registrar todos los archivos de la tabla de cobertura; no llenar cientos de líneas duplicadas de prosa si una lista de claves por área sirve.
- Implementar helper puro y catálogos con mensajes de ejemplo reales y glosario. Añadir claves a medida que se migra cada área; al finalizar cada tarjeta sus claves tienen ambos idiomas.
- Crear `src/test/localization.test.ts` y runner `scripts/test-localization.js` siguiendo runners existentes. Agregar script `test:localization` y `check:localization` cuando exista el guard.
- Tests: normalización regional, en/es/fallback, parámetros repetidos/reordenados, `$&`, braces dentro del dato, falta defensiva de traducción, números UI, y `configureLocale` restaurado entre casos. No ejecutar tests en paralelo dentro del mismo proceso con locale global distinto.
- Aceptación: helper funciona sin `vscode`, `node:fs` o DOM y no introduce dependencia. `npm run check-types`, `npm run lint`, tests focalizados.

### ML-01B — Lógica independiente de idioma

**Estado local (implementada; verificación local aprobada, Extension Host pendiente; commit de etapa creado, 2026-10-11):** `src/user-errors.ts` define `external-file-conflict` y storage web/Node y el preflight de save usan esa identidad; el editor programa `scheduleExternalCheck` por code. `reasonCode: pending-changes` se emite solo para el bloqueo transitorio y la webview reactiva acciones únicamente en `saved`/`clean`; los demás bloqueos permanecen. Acciones pactadas usan `MessageItem { id, title }`; el parser `src/fill-prompt.ts` mapea opciones en/es a enums actuales. Pruebas que pasan con Node 24.21.0: `test:storage-node-conflict`, `test:ml-01b-contracts`, `test:save-coordinator`, `test:fill`, `test:xlsx-structure`, `test:recovery`, `check-types`, `lint` y `git diff --check`. `test:save-lifecycle` no se verificó: `@vscode/test-electron` usó VS Code 1.141.0 instalado pero el Extension Host terminó con `SIGABRT` (resolución de versión falló por `ENOTFOUND update.code.visualstudio.com`). Reintentar en entorno con Extension Host estable. No se cambió backup/atomic write ni se tradujeron cadenas de UI.

- Cambiar exclusivamente los casos de la tabla 3.4; crear un módulo `src/user-errors.ts` solo si necesita error de conflicto/code, no una jerarquía universal de errores.
- Para conflicto externo, probar same outcome en/es y que scheduleExternalCheck sigue invocado. Cubrir ambos storage paths; no cambiar backup/atomic write.
- Para structure pending-changes, probar que save clean/saved habilita ese caso y no permite un libro protegido/no compatible.
- Diálogos: aplicar/cancelar/guardar solo cambios/copy confirm conservan acciones con títulos traducidos y IDs estables; ajustar stubs focalizados.
- Prompts: strings es/en, whitespace/case, cancel y unknown devuelven los mismos enums/cancel. Las opciones son UI, nunca tocar el contenido de celdas.
- Aceptación: `test:save-coordinator`/`test:save-lifecycle` y pruebas focalizadas de estos contratos, según harness afectado; paquete pasa. Si GUI bloqueada, registrar y seguir ML-02/03.

### ML-02 — Manifiesto

**Estado local (implementada; verificación local aprobada, Extension Host pendiente; 2026-10-11):** `package.nls.json` y `package.nls.es.json` contienen 27 claves coincidentes: descripción pública, cinco títulos de comandos y las 21 descripciones de Settings. Se conservaron IDs, defaults, tipos y enums. `scripts/check-localization.js` y `npm run check:localization` comprueban claves referenciadas/no usadas, catálogos iguales y placeholders. `src/test/extension.test.ts` valida conteos, referencias, traducciones, IDs/defaults. Pasan `check:localization`, `compile-tests`, `test:localization`, `check-types`, `lint` y `git diff --check` con Node 24.21.0. `npm test -- --grep 'contributes the Explorer command'` compila y empaqueta, pero el Extension Host instalado VS Code 1.141.0 termina con `SIGABRT`; la resolución de versión también reporta `ENOTFOUND update.code.visualstudio.com`. Por ello no se verificó la prueba de manifiesto en Extension Host ni el smoke real es/en. CONFIGURATION documenta Display Language, inglés fallback, español, reinicio y ausencia de selector/setting.

### ML-02 — Manifiesto

- Crear catálogos NLS y sustituir todos los campos traducibles existentes. La descripción pública de la extensión permanece completa y fiel a capacidades actuales. (Implementado.)
- Ajustar `src/test/extension.test.ts` para validar token NLS, resolución en/es, default/ID sin cambios y todas las propiedades. Verificar placeholders `%...%` completos. (Implementado; ejecución anotada al cierre.)
- El guard verifica igualdad exacta de claves NLS y ninguna clave usada ausente. Cero strings `%...%` sin resolver en smoke real. (Guard implementado; smoke real pendiente.)
- Documentar en CONFIGURATION que los 21 Settings conservan IDs/valores mientras su descripción en la UI sigue Display Language. No agregar un setting ficticio ni cambios de default. (Implementado.)

### ML-03A/B/C — Host y mensajes compartidos

**ML-03A implementada (2026-10-11):** `activateCore` configura `vscode.env.language` antes de crear providers; las entradas Node y Web delegan a esa función. Se localizaron los mensajes propios de `extension.ts`, `preview.ts`, `storage.ts`, `storage-node.ts` y `recovery.ts`, incluido título y modeLabel de preview. Se conservan `sourceMode`, URI, contenido, límites técnicos, errores externos y semántica IO. Se añadieron mensajes completos es/en con placeholders equivalentes, tests puros de runtime/catálogos en `test:localization` y verificación de claves/placeholders runtime en `check:localization`; se actualizaron ambos inventarios. Pendiente de este bloque: suite de Extension Host, no ejecutada por los fallos SIGABRT/ENOTFOUND ya documentados en ML-01B/02.

**ML-03B implementada y verificada localmente (2026-10-11):** `editor.ts` usa claves `editor.*` completas en inglés/español para las confirmaciones, validaciones, estados de guardado/recarga, edición/drafts, fórmulas/fill, operaciones CSV/XLSX, tablas/hojas/movimiento/estilos, errores y Output/historial. Los placeholders conservan URI, nombres de hoja/tabla, delimitadores, celdas/fórmulas, límites y causas; las selecciones usan IDs estables. `getHtml` y sus 21 botones/tips quedan intactos para ML-04A. `check:localization`, `check-types`, `lint`, `test:localization`, `test:edit-transactions`, `test:formula-edits`, `test:fill`, `test:csv-row-operations`, `test:xlsx-tables`, `test:xlsx-sheets`, `test:xlsx-structure`, `test:xlsx-styles`, `test:move-range`, `test:clipboard` y `test:save-coordinator` pasan. El save coordinator requirió `NODE_OPTIONS=--experimental-global-webcrypto` por Node 18; `test:recovery` no se completó porque su harness lanza `ReferenceError: setup is not defined`. No se ejecutó Extension Host por el SIGABRT/ENOTFOUND previamente documentado. Candidatos de baja confianza reservados: capability reasons de estructuras/formats que se originan fuera de los sinks migrados, y etiquetas/texto en `getHtml` (ML-04A); nombres sintéticos de hoja y formatos/límites son datos técnicos.

- ML-03A: configurar locale al inicio de activateCore; traducir `extension.ts`, `preview.ts`, textos propios `storage.ts`/`storage-node.ts`/`recovery.ts` y sus mensajes mostrados. Traducir título preview y modeLabel con helper. Conservar sourceMode/URI y contenido.
- ML-03B: migrar bloques `editor.ts` por grupos: apertura/carga/dialectos; save/reload/conflicto/backup; edit/copy/drafts; formula/fill; structure/table/sheet/move/style; eventos de historial/output. `getHtml` se hace en ML-04A.
- ML-03C: migrar validaciones/warnings/capabilities de dominio/adaptadores y formula help. No importar vscode. Usar strings formateados actuales como argumentos, manteniendo rutas, códigos, nombres y XML intactos. Corregir conteos de UI con `formatUiNumber`; no tocar serialización.
- Revisar strings en campos por defecto de clases (`document.ts`), arrays a nivel módulo y etiquetas en maps: localizar cuando se usan después de bootstrap, no guardar un idioma congelado al importar.
- Donde XLSX/ODS usan un nombre sintético de hoja ausente, no convertirlo por locale si participa en identidad/guardado: tratarlo como dato técnico estable y registrarlo como excepción. El nombre propuesto al crear una hoja nueva puede tener etiqueta localizada porque es una acción explícita del usuario, pero no renombrar hojas existentes.
- Adaptar expectativas de tests afectadas: escoger idioma explícito para assert de mensaje; preservar tipos/rechazos y verificaciones de bytes. Pruebas localizadas se ejecutan es y en; legacy suites pueden fijar es temporalmente sin afirmar que eso verifica inglés.
- Aceptación por subtarjeta: tipos/lint, tests de área afectada y diff sin operaciones funcionales nuevas. Mantener inventario/keys completo para los bloques migrados.

### ML-04A — HTML, bootstrap y protocolo

- En `getHtml`, sustituir textos por helper+escapeHtml, incluidas options visibles y atributos. No traducir `value` de options, IDs, formatos `0.00`, `mm-dd-yy` o `General` cuando es token de formato.
- Crear `<html lang>` correcto desde la primera carga. Colocar configuración webview al inicio de main; startupError y requiredElement usan t.
- Añadir mensaje locale al union host→webview y handlers de ready editor/preview. Prueba con repetición ready y payloads desconocidos, y que no cambia estado/draft.
- Pasar locale al worker con contrato tipado en request calculate; configurar antes de diagnóstico propio. Resultado de fórmula y errores de celda continúan como datos.
- Tests de getHtml con mock webview/uri por en/es: loading, tooltip, aria-label, placeholders y escaping de filename/mode con `<`, comillas y `&`. No necesita abrir VS Code para comprobar string HTML.
- `npm run package` y `npm run test:web-target` verifican que los bundles browser no importan Node; añadir check de que webview/worker no importan API vscode. No cambiar CSP ni usar translated innerHTML.

### ML-05A/B/C — Webview por áreas

- ML-05A: `showStartupError`, startup/timeouts, `grid-renderer.ts`, `selection.ts`/`unsupportedFormulaLabel`, selectCell/editor, updateSaveStatus/reload, dimensiones, updateSheetOptions, formula assistance/status y atributos aria. Los nombres de hojas/datos de celda permanecen exactamente iguales.
- ML-05B: `updateSearchStatus`, `updateProjectionControls`, `describeFilter`, `renderFilterPopup`, `renderValuesFilter`, `renderConditionsFilter`, `createConditionRow`, `filterValueLabel`, `operatorsFor/operatorLabel`, autoFit/freeze/resize. `(vacío)`/`(sin campo)` son etiquetas UI traducibles; el null/empty original no cambia. Labels se traducen y enums/operators/column numbers se conservan.
- ML-05C: event listeners y funciones de range copy/delete/fill, updateMove/XlsxStyle/Sheet/Structure/FormulaFill/TableActions y mensajes de destino/confirmación. Usar parser de prompts ya verificado; no reimplementar fill ni mover celdas.
- Revisar handlers del gran listener `message` además de funciones nombradas. Revisar `title`, `aria-label`, `textContent`, templates y makeButton para no dejar tooltips o mensajes efímeros sin traducir.
- Aceptación: catálogos completos para área, sin fragmentos de frase concatenados, tipos/lint, pruebas focalizadas de presentación/clipboard/fill según área. Smoke visual se acota en ML-06A; no hacer suite completa después de cada texto.

### ML-06A — Verificación, docs y pendientes

- Guard de catálogos: mismas keys en/es, strings no vacíos, multiconjunto de placeholders igual, claves usadas existentes y catálogo NLS sin faltantes. Detectar keys runtime sin uso o justificar uso generado/técnico.
- Guard de cobertura: analizar strings/templates de los archivos inventariados y reportar candidatos de UI fuera de t; mantener allowlist revisable para IDs, rutas, XML/formulas, valores/brand y diagnóstico externo. Evitar declarar cobertura por escanear acentos únicamente; revisión humana de sinks y comparación con inventario completa el check.
- Un smoke de interfaz por idioma (matriz abajo), capturas/checklist documentadas. Un fallo real de focus/acción/save se corrige; un host no disponible se registra como check pendiente.
- Tests de invariantes en/es con fixtures: abrir/parsear y copiar la misma selección da mismos valores/TSV; edición equivalente y guardar produce mismos bytes de CSV y mismos valores/partes OOXML esperados. No escribir nuevo resultado calculado. Locale no cambia nombres/drafts ni view-state; un t recibe datos y no los modifica.
- Probar fuente base no soportada (`de`) e `es-MX` al menos en helper; smoke real regional del manifiesto si el entorno lo permite. No fingir que mock env.language prueba selección real del catálogo NLS de VS Code.
- Ejecutar una vez `npm test` con Node 24.21.0 y host fuera del sandbox si se necesita. Añadir tests nuevos al patrón `.vscode-test.mjs` o mantener runner independiente documentado. Comparar con baseline 113 passing/1 pending; no ocultar pending heredado ni anunciar 0 pendientes.
- README mantiene la página principal en inglés y describe English/Spanish, Display Language/Configure Display Language, reinicio y English fallback; reemplaza advertencia Spanish-only. No obliga traducir README entero para que UI sea bilingüe.
- CONFIGURATION describe idioma automático y ausencia de selector/boolean, ejemplos de las opciones reales con IDs estables y efecto visual. No sugerir cambiar idioma mediante un setting inexistente. Actualizar localization_inventory con claves/excepciones y guía de añadir traducción.
- planning.md marca estado ML por evidencia y conserva los pendientes V2. CHANGELOG añade futura 1.0.0 solo cuando la entrega realmente esté lista; mientras tanto usar sección Unreleased si hace falta.

### ML-06B — Preparar release 1.0.0

- Cambiar `package.json`/lock a 1.0.0 después de completar UI/host/manifiesto y pruebas disponibles, no antes. Sin cambio de publisher/IDs ni apertura automática extra.
- `npm run package`; VSCE con mismo runtime/herramienta del release 0.0.3 genera `spreadsheet-viewer-1.0.0.vsix`. Confirmar `package.nls.json` y `.es.json` dentro del VSIX y catálogos runtime compilados en ambos extension bundles/webview/worker. `.vscodeignore` excluye `src/**`, scripts/planning; por eso los catálogos runtime deben estar importados, no cargarse desde src.
- `unzip -t`, versión/archivos clave, instalación en perfil limpio y smoke en/es del VSIX (no solo F5). No repetir benchmarks/Excel checks sin riesgo nuevo ocasionado por localización.
- README/CONFIGURATION/CHANGELOG/planning sincronizados; versión de release y limitaciones heredadas expresas. Commit de release, tag acorde al flujo existente. Publicar/push solo si están autorizados en esa sesión; la petición actual es planear la versión, no publica 1.0.0 automáticamente.
- No marcar completa ML-06B si únicamente compiló; registrar instalación/idiomas probados y checks GUI pendientes. Un paquete funcional puede quedar como candidato 1.0.0 hasta completar confirmación de idiomas.

## 5. Matriz corta de aceptación manual

Hacer cada fila una vez en **en** y **es**, en Extension Development Host o copia VSIX indicada. Usar perfil temporal y Display Language real/`--locale` con recursos de idioma apropiados; no modificar la configuración personal del usuario. El mecanismo nativo puede requerir Language Pack y reinicio. Registrar versión de VS Code, locale observado y tipo de instalación.

| Caso | Resultado observable |
| --- | --- |
| Paleta/Settings/Open With | 5 comandos/descripciones de Settings traducidos; marca/IDs/valores intactos; cero `%key%` visibles. |
| Abrir CSV y preview de buffer | Loading/título/toolbar/tooltip, búsqueda/sort/filter y chips en idioma elegido; el archivo/nombres/valores intactos. |
| Editar dos celdas y guardar | Estados localizados; segunda edición y Ctrl/Cmd+S funcionan; undo/redo y tabs sin cambios de semántica. |
| XLSX varias hojas/fórmula | Sheet controls/UI localizados; nombres originales conservados; función/formula/referencia idénticas; ayuda localizada y motor igual. |
| Acción permitida y rechazada | Copy confirm o fill repeat+series es/en actúa correctamente; cancelar conserva datos; read-only/protección explica el rechazo en idioma elegido. |
| Reload/restore y accesibilidad | Tooltip visible con hover/focus, aria y status en idioma; restablecer conserva archivo/draft como antes; close/reopen conserva selección/scroll. |
| Layout angosto | Header y toolbars se adaptan, filename no se vuelve vertical, select/options/tooltip no ocultan acción; pruebe ancho ~800 px y más angosto. |
| Fallo propio + detalle externo | Ejemplo de CSV inválido/limit/parse con explicación propia localizada; ruta/error del parser conservados como diagnóstico, sin HTML ejecutado. |

Pseudo-localización no es dependencia obligatoria. Para detectar textos largos basta ampliar textos de prueba de catálogo de forma temporal/no commiteada o usar fixture de mensajes largos y smoke angosto. No convertir lector de pantalla/Excel/Web externo en un bloqueo de meses: registrar lo que efectivamente se revisó.

## 6. Regla operativa, contexto y límite de esfuerzo

Aplican las instrucciones 15.11 de planning.md en **cada** ML-01A…ML-06B: no enciclarse en checks pequeños. Tras dos intentos útiles o unos 30 minutos con el mismo bloqueo, anotar comando/runtime/error, conducta sin verificar y estrategia de recuperación; commitear checkpoint funcional con estado honesto y avanzar a tarjeta independiente. No continuar sobre evidencia de corrupción/pérdida de datos o una regresión grave de guardado; esos fallos sí se resuelven.

Al iniciar/retomar: leer esta sección, tarjeta activa/decisiones 1–3, `git status` y el último commit. Consultar fuera del sandbox `python3 /Users/samuelurias/Downloads/codex_usage.py --json` en checkpoints importantes; restante = `100 - rateLimits.primary.usedPercent`, ventana `windowDurationMins = 300`. Con 15% o menos, detener programación en checkpoint seguro, actualizar planning y esperar input. No confundir cuota con avance de tareas.

Modelos: Sol 6.1 **medio** se usó para diseñar este plan por solicitud del usuario. Luna 6 **bajo** implementa una subtarjeta acotada y hace commits/documentación rutinaria. Si un contrato real no coincide con lo planeado o hay bloqueo de arquitectura, Sol 6.1 bajo analiza la causa concreta y propone ajuste; no pedirle una investigación completa en cada texto. Esta tarea deja planning, no implementa idiomas ni hace release.

## 7. Prompt reutilizable para Luna

> Implementa únicamente **[ML-NNA]** de `plugin_multilingue.md`, usando GPT-6 Luna con esfuerzo bajo. Lee primero decisiones de producto/arquitectura (secciones 1 y 3), la subtarjeta, su fila de dependencias y la regla operativa de sección 6 / planning.md 15.11. Inspecciona las firmas actuales antes de editar. Mantén el inglés base y español incluido siguiendo Display Language, catálogos runtime puros compartidos y NLS nativo del manifiesto. No inventes selector/boolean de idioma ni metas vscode/Node en navegador.
>
> Cambia solo strings/presentación y los desacoplamientos de lógica previstos para esa tarjeta. No traduzcas contenido del documento, fórmulas/funciones, IDs, enum values ni formatos numéricos. Completa es/en y placeholders para cada clave nueva; HTML traducido pasa por escapeHtml/textContent y todos los tooltips/aria se conservan. Mantén catálogos e inventario al día.
>
> Ejecuta tipos/lint y pruebas focalizadas del comportamiento cambiado. Acota checks de entorno; si se atascan, registra evidencia/estrategia pendiente y continúa lo independiente. No debilites tests ni declares un mock como prueba del idioma real de VS Code. Al cerrar actualiza el estado exacto de la tarjeta en plugin_multilingue.md/planning.md, README/CONFIGURATION si aplica, revisa diff, crea commit de checkpoint verificado y comprueba que Git/planning coinciden. Reporta archivos, pruebas y pendientes. No avances a V3 ni publiques una versión sin instrucción vigente.

## 8. Fuentes verificadas y compatibilidad

- [microsoft/vscode-l10n](https://github.com/microsoft/vscode-l10n): inglés usa `package.nls.json`, locales `package.nls.<locale>.json` y fallback; distingue manifiesto, runtime y otros procesos. Esta entrega usa NLS para estático y helper propio para runtime, explícitamente.
- [VS Code API — env.language](https://code.visualstudio.com/api/references/vscode-api#env): idioma preferido de interfaz, incluidos tags regionales.
- [VS Code API — l10n](https://code.visualstudio.com/api/references/vscode-api#l10n): placeholders y bundles; `bundle`/`uri` pueden ser undefined para idioma base o ausencia de traducción. API existe en tipos instalados, pero no hace falta aumentar engine ni usar proposed API.
- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest): contribuciones/metadata localizables. [Display Language](https://code.visualstudio.com/docs/getstarted/locales): configuración de idioma y Language Packs.

Los tipos del repo confirman `vscode.env.language` y namespace `vscode.l10n`. Las entradas actuales confirmadas son extension-node/web, compiladas por esbuild; webview/worker por webpack. Ninguna decisión de este plan exige cambiar el engine ^1.140.0, framework, formato de archivo o motor WASM.
