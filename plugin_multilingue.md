# Plan para hacer Spreadsheet Viewer multilingüe

**Estado:** requisito confirmado; no implementa todavía la internacionalización.
**Revisado:** 2026-10-11.
**Idiomas obligatorios de la primera versión:** español e inglés.

Este documento explica cómo adaptar la extensión actual, cuya interfaz está escrita principalmente en español, para que su interfaz siga el idioma de VS Code. El plan debe coordinarse con las reglas de entrega de [`planning.md`](planning.md): todo control nuevo tiene tooltip, las funcionalidades quedan habilitadas por defecto y se pueden desactivar desde Settings, la documentación se actualiza en el mismo cambio y una etapa verificada termina en commit.

**Orden del roadmap:** este trabajo comienza después de completar V2-25. No reemplaza ni adelanta las etapas pendientes de V2. Al terminar la V2, ejecutar ML-01, ML-02, ML-03, ML-04, ML-05 y ML-06 en ese orden.

## Qué significa “multilingüe” en esta extensión

La extensión tiene tres superficies distintas de texto:

1. **Contribuciones de VS Code:** nombre y descripción de comandos, títulos de menús, categorías y descripciones de Settings que viven en `package.json`.
2. **Extension Host:** errores, notificaciones, Quick Picks y otros mensajes creados desde TypeScript del host, como `src/extension.ts`, `src/editor.ts` y `src/preview.ts`.
3. **Webview:** etiquetas HTML, botones, tooltips, placeholders, estados de guardado, mensajes de búsqueda/filtro y anuncios accesibles dentro de `src/webview/`.

Traducir solo una superficie dejaría una interfaz mezclada. La primera entrega debe cubrir las tres. Los textos de los propios datos —valores del CSV/libro, nombres de hojas, fórmulas, referencias de celdas y lexemas— **no** se traducen ni se modifican.

## Comportamiento propuesto

- VS Code determina el idioma con el que se muestran las contribuciones y la interfaz localizada. La extensión admite inicialmente español e inglés; los idiomas no disponibles usan español como idioma base.
- No se añade un selector de idioma independiente en la primera versión. El idioma se cambia en VS Code mediante su configuración de idioma de visualización y el reinicio que VS Code solicite.
- Se añade `spreadsheet-viewer.localization.enabled`, booleano con valor predeterminado `true`, para cumplir la regla del proyecto de poder desactivar una funcionalidad desde `settings.json`. Con `false`, los mensajes dinámicos propios de la extensión y la webview usan el texto base español. Las traducciones de etiquetas estáticas del manifiesto las aplica VS Code según el idioma del usuario.
- `.vscode/settings.json` incluye la opción con `true` para probar la ruta habilitada. El setting y sus efectos se describen en `CONFIGURATION.md`.
- El idioma es una preferencia de interfaz. No cambia documentos, archivos, fórmulas, drafts, búsquedas guardadas ni estado persistido por hoja.

Ejemplo previsto:

```json
{
  "spreadsheet-viewer.localization.enabled": true
}
```

Al ponerlo en `false`, la interfaz dinámica usa el texto base en español. En ausencia de una configuración, la opción se activa por defecto.

## Arquitectura recomendada

### Textos estáticos de `package.json`

VS Code permite localizar las contribuciones del manifiesto con claves `%...%`, `package.nls.json` y archivos `package.nls.<locale>.json`. El español actual puede quedar como base en `package.nls.json` y el inglés en `package.nls.en.json`. Se reemplazan con claves los títulos y descripciones definidos en `commands`, `menus`, `customEditors`, `configuration` y cualquier otra contribución visible.

No se deben incluir traducciones dentro de `package.json` como lógica condicional: el manifiesto debe apuntar a claves estables y los catálogos contienen los textos.

### Mensajes del Extension Host

Usar la API estable `vscode.l10n.t()` para textos visibles al usuario y declarar en `package.json` la ruta de los catálogos `bundle.l10n.<locale>.json` mediante la propiedad `l10n`. Los mensajes fuente permanecen en español; los bundles aportan sus traducciones al inglés. Para mensajes con valores dinámicos, usar argumentos con placeholders (`{0}`, `{1}` o nombres) y nunca interpolar contenido sin formato de forma que se pierda el contexto de traducción.

El setting `localization.enabled` se consulta desde un helper central. Si está activo, el helper usa el texto que devuelve `vscode.l10n.t`; si está desactivado, devuelve el mensaje fuente español. Mantener los usos de `vscode.l10n.t()` detectables por las herramientas de extracción.

### Mensajes de la webview

La webview usa HTML/JavaScript propio y no tiene acceso directo a la API completa de VS Code. El host debe enviarle el catálogo ya localizado mediante el protocolo de mensajes existente:

1. El HTML muestra una cadena de carga/base segura mientras espera el mensaje `ready`.
2. El host crea un objeto de mensajes con claves estables y resultados de `vscode.l10n.t()` —o los textos fuente si la opción está apagada— y lo envía a cada panel/editor.
3. La webview guarda el catálogo y usa una función `t(key, args?)` para renderizar etiquetas, atributos accesibles y mensajes dinámicos.
4. Los eventos de cambio de configuración actualizan el estado de la opción en vistas abiertas; el idioma de VS Code puede requerir reiniciar la ventana, conforme al comportamiento de Language Packs.

El catálogo debe ser una lista explícita de mensajes usados, no la traducción improvisada de cadenas en tiempo de render. Para mensajes que incluyan conteos, fechas o números, usar `Intl.NumberFormat` y reglas de plural del locale cuando haga falta. Los errores técnicos mantienen sus datos útiles —ruta, código o detalle— separados del texto traducible.

No enviar HTML traducido para insertarlo con `innerHTML`. Usar `textContent`, atributos controlados y argumentos escapados como ya hace el renderer con los datos del archivo. Mantener CSP, ARIA y los tooltips en ambos idiomas.

### Catálogos y herramientas

Mantener mensajes en fuentes/catálogos verificables y usar `@vscode/l10n-dev` como herramienta de desarrollo para extraer/exportar cadenas, crear archivos de traducción y generar pseudo-localización. Las salidas generadas no se editan a mano. Revisar el empaquetado para confirmar que `package.nls.*.json` y los bundles declarados en `l10n` llegan al VSIX.

Antes de añadir otra dependencia de runtime, evaluar si las APIs de VS Code y un helper pequeño cubren las necesidades. Una biblioteca de traducción no debe modificar la lógica de parseo, guardado o selección.

## Etapas propuestas

### ML-01 — Inventario, idioma base y contratos

- Inventariar todas las cadenas visibles en `package.json`, código de Extension Host, HTML, renderer, filtros, diálogos y estados.
- Clasificar por contexto: título, acción, explicación/tooltip, validación, estado, error, aria-label y contenido dinámico.
- Definir un glosario español/inglés para términos como hoja/sheet, fila/row, columna/column, ordenar/sort, filtro/filter, draft y valor crudo/raw value.
- Definir una clave estable por mensaje; evitar reutilizar una traducción si los contextos tienen sentidos distintos.
- Criterio: el inventario permite comprobar que no queda una superficie de interfaz sin plan de traducción.

### ML-02 — Localización del manifiesto

- Añadir `package.nls.json` y `package.nls.en.json`.
- Cambiar las cadenas visibles de `package.json` por claves localizables.
- Traducir comandos, menús, nombre/descripcion y las descripciones de las seis opciones actuales, incluida la nueva opción de idioma.
- Criterio: probar el manifiesto en inglés y español y comprobar que no aparece una clave `%...%` sin resolver.

### ML-03 — Helper del host y configuración

- Añadir `spreadsheet-viewer.localization.enabled`, default `true`, con lectura centralizada y actualización en paneles abiertos.
- Localizar notificaciones, errores, Quick Picks y prompts en `extension.ts`, `editor.ts`, `preview.ts` y módulos invocados por el host.
- Crear bundles base/español e inglés compatibles con `vscode.l10n.t()` y ejecutar la extracción de mensajes.
- Documentar nombre, tipo, default, efecto y ejemplo true/false en `CONFIGURATION.md`; actualizar `.vscode/settings.json` con `true`.
- Criterio: tests para idioma base, inglés, locale no soportado, setting desactivado y mensajes con parámetros.

### ML-04 — Catálogo y protocolo de la webview

- Añadir un mensaje de localización al protocolo sin alterar los mensajes de edición/guardado.
- Enviar el catálogo a cada editor y preview después de `ready`; soportar recreación del panel y cambio live del setting.
- Añadir un helper `t()` tipado en webview, con valores por defecto para la fase inicial y sustitución segura de parámetros.
- Criterio: una vista nueva nunca enseña IDs de claves ni se queda sin texto si el mensaje de idioma tarda o no llega.

### ML-05 — Traducir UI por áreas

- Navegación, selección y editor de celdas.
- Orden, filtros, chips, búsqueda y referencias ocultas.
- Guardado, recarga, conflictos, validación y avisos de límites.
- Tooltips y todos los atributos ARIA, placeholders y títulos.
- Renderer/formato: mensajes propios localizables; contenido crudo del archivo intacto.
- Criterio: cada etiqueta visible, texto de ayuda y anuncio accesible está traducido en es/en.

### ML-06 — Cobertura, accesibilidad y distribución

- Añadir pruebas de completitud de claves: cada clave base tiene traducción en inglés y el catálogo no contiene IDs obsoletos.
- Usar pseudo-localización para encontrar strings concatenadas, etiquetas truncadas y layouts que no toleran textos largos.
- Verificar teclado, lector de pantalla, tooltips, botones y popup en ambos idiomas y en preview/editor.
- Probar `npm run compile`, tests focalizados, Extension Host y empaquetado con `vsce package`; confirmar archivos de localización dentro del VSIX.
- Actualizar README, `CONFIGURATION.md`, `planning.md` y notas para traductores.
- Marcar ML-06 verificada solo cuando los checks manuales estén hechos; después crear commit de la etapa.

## Reglas para traducir

- Mantener nombres de comandos internos, IDs de mensajes, propiedades, operadores y referencias de celdas estables; traducir solo su presentación.
- Mantener `Ctrl`, `Cmd`, `Shift`, `Alt`, `Enter`, `Escape`, `F2`, `A1` y nombres de formatos como CSV/XLSX/ODS en su forma estándar.
- Evitar concatenar frases traducibles. Una oración con datos variables debe ser un solo mensaje con placeholders.
- No traducir texto del usuario, valores del archivo, fórmulas, errores almacenados en las celdas ni nombres de hojas.
- Mantener todos los tooltips requeridos por `planning.md` y localizarlos junto con la etiqueta de su botón.
- Si una traducción falta o el locale no se reconoce, usar el mensaje fuente español; nunca mostrar `undefined`, claves internas ni texto vacío.

## Archivos previstos

```text
package.json                      claves de contribuciones y setting de localización
package.nls.json                  textos estáticos base en español
package.nls.en.json               textos estáticos en inglés
l10n/bundle.l10n.json             catálogo base runtime
l10n/bundle.l10n.en.json          catálogo runtime en inglés
src/localization.ts               helper y catálogo localizado del host
src/protocol.ts                   mensaje de localización a la webview
src/webview/i18n.ts               helper de traducción tipado
src/test/localization.test.ts     cobertura de fallback, claves y parámetros
CONFIGURATION.md                  ajuste de idioma y valores soportados
README.md                         idiomas y forma de seleccionar el idioma de VS Code
planning.md                       referencia y estado de ML-01…ML-06
```

Los nombres son una propuesta. Reutilizar los módulos existentes si simplifica el diseño; no crear una capa genérica innecesaria.

## Fuentes de VS Code

- [Localización del Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest): claves `%...%` y `package.nls` para contribuciones estáticas.
- [VS Code API — `l10n`](https://code.visualstudio.com/api/references/vscode-api#l10n): `vscode.l10n.t()` y carga de bundles runtime.
- [microsoft/vscode-l10n](https://github.com/microsoft/vscode-l10n): formato de bundles y herramientas `@vscode/l10n-dev` para exportar, importar y pseudo-localizar cadenas.
- [Custom Editors](https://code.visualstudio.com/api/extension-guides/custom-editors): la UI del custom editor es una webview y se comunica con el host mediante mensajes.
