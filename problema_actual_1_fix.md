# Diagnóstico y plan de corrección: Spreadsheet Viewer no inicia su interfaz

Fecha: 2026-10-09. Este documento complementa `problema_actual_1.md` y sirve como guía de implementación para otro modelo. **La corrección descrita todavía no se ha aplicado.** Durante el diagnóstico solo se leyó el código y se ejecutaron pruebas en memoria; no se modificaron fuentes ni bundles.

## 1. Conclusión comprobada

El bundle actual `dist/webview.js` lanza esta excepción al ejecutar la entrada del webview:

```text
Error: Cannot find module './styles.css'
code: MODULE_NOT_FOUND
```

La excepción ocurre antes de registrar los listeners de mensajes y botones, antes de adquirir la API del webview y antes de enviar `ready`. Por eso la tabla permanece vacía y Recargar no hace nada.

**El CSS existe. El problema es una contradicción en el empaquetado del JavaScript**, no la falta física de la hoja de estilos.

## 2. Evidencia y archivos implicados

En `src/webview/main.ts`, cerca del comienzo, existe:

```ts
import './styles.css';
```

En `esbuild.js`, dentro de `buildWebview()`, webpack está configurado con:

```js
plugins: [new webpack.IgnorePlugin({ resourceRegExp: /\.css$/ })],
```

El import sigue existiendo en el código de entrada, pero el plugin impide resolver ese módulo CSS. En el bundle observado durante el diagnóstico, webpack genera lo siguiente en la línea 446 (la posición puede cambiar al recompilar):

```js
Object(function webpackMissingModule() {
  var e = new Error("Cannot find module './styles.css'");
  e.code = 'MODULE_NOT_FOUND';
  throw e;
}());
```

Esta instrucción está antes de los `window.addEventListener('error', ...)`, `window.addEventListener('message', ...)` y de `acquireVsCodeApi()` del código de aplicación.

El proyecto ya tiene una ruta independiente y suficiente para el CSS:

1. `esbuild.js` compila `src/webview/styles.css` como entrada separada y genera `dist/webview.css`.
2. `src/editor.ts`, en `getHtml()`, calcula la URI de `dist/webview.css` mediante `webview.asWebviewUri`.
3. El HTML incluye `<link rel="stylesheet" href="...">` para cargar esa hoja.

Por lo tanto, importar el mismo CSS desde `main.ts` es redundante en la arquitectura actual y es el import que dispara la excepción con esta configuración de webpack.

## 3. Reproducción realizada y resultado

Se ejecutó el bundle actual usando `node:vm` con un entorno DOM mínimo simulado. Se registraron los listeners, las adquisiciones de la API y los mensajes enviados.

Resultado del bundle original:

```text
Error reproducido: Cannot find module './styles.css'
Código: MODULE_NOT_FOUND
Contadores al detenerse:
  eventListeners: 0
  apiAcquisitions: 0
  messages: 0
```

Después se retiró **solo en memoria** la instrucción generada que lanza la excepción, sin escribir ningún archivo. Con el mismo entorno simulado, la entrada terminó de ejecutarse y se invocó el listener de Recargar.

```text
Inicio y clic ejecutados
Mensajes enviados:
  { type: 'ready' }
  { type: 'reloadFile' }
```

Esta comparación demuestra que el error CSS bloquea las dos rutas que fallan al usuario. Es una prueba del arranque y del envío de mensajes del frontend; **no es una prueba del renderizado real de VS Code, de los parsers ni del guardado**.

## 4. Por qué cada síntoma encaja con esta causa

| Síntoma | Explicación en el código actual |
|---|---|
| Se ven el título, controles y estilos | El extension host genera HTML estático y carga el CSS mediante un `<link>`, independientemente de que la aplicación JavaScript arranque. |
| Sigue «Cargando archivo…» | Es el texto inicial del HTML. La ejecución nunca llega al envío de `ready` ni a los temporizadores que deberían sustituirlo. |
| No se muestran celdas | El webview no solicita ni procesa el mensaje inicial `csvData`/`xlsxData`. |
| Recargar no responde | El listener `reloadFileButton.addEventListener('click', ...)` nunca se registra. |
| No aparece el toast | `showInformationMessage('Recargando')` se ejecuta en la extensión solamente al recibir `reloadFile`; ese mensaje nunca sale del webview. |
| No se crea `debug_spreadsheetviewer_*.txt` | El logger también se crea únicamente en el handler `reloadFile` del extension host. |
| No se ven los errores agregados en `main.ts` | Sus handlers se registran después de los imports; la excepción del import ocurre primero. |
| El aviso bootstrap del HTML tampoco aparece | El handler de `getHtml()` filtra `event.target instanceof HTMLScriptElement`. Captura fallos de carga del recurso, pero este es un error al ejecutar el código del script, cuyo evento global no cumple ese filtro. |
| Compilar y comprobar sintaxis da éxito | El JS generado es sintácticamente válido. `IgnorePlugin` permite terminar la compilación, y TypeScript acepta los imports CSS mediante `src/webview/styles.d.ts`. La excepción solo aparece al ejecutar el bundle. |

## 5. Relación con el historial y límites de la conclusión

El error actual está en el empaquetado webpack del webview. Ese empaquetado se usa para admitir Formualizer, sus chunks y WebAssembly. El conflicto con el import CSS es el punto concreto que debe corregirse.

Por el historial, los usuarios probaron CSV/XLSX antes de esta regresión y reportaron que la funcionalidad principal servía. No existe una comparación de commits que permita fechar exactamente cuándo se introdujo la combinación defectuosa: el estado Git inspeccionado muestra los archivos del proyecto como no rastreados. **No afirmar que agregar ODS fue la causa solo porque el fallo se reportó después.** El parser ODS no necesita ejecutarse para reproducir esta excepción; el fallo bloquea la entrada común a todos los formatos.

El antiguo error de guardado `No custom document found` es otro problema, en la ruta de documentos custom/edición/guardado. El usuario confirmó que el guardado volvió a funcionar tras correcciones anteriores. No usarlo como explicación del bloqueo CSS actual.

Los reintentos de `ready`, cambios CSP, toast y archivo de debug no eliminaron la excepción inicial. Varios de esos diagnósticos dependían del código que nunca llegaba a ejecutarse. No es necesario seguir cambiándolos antes de corregir el import.

## 6. Alcance exacto de la solución recomendada

**Cambio mínimo requerido:** retirar únicamente `import './styles.css';` de `src/webview/main.ts` y volver a generar los artefactos.

La corrección debe conservar:

- La compilación separada de `styles.css` hacia `dist/webview.css`.
- El `<link>` a `webview.css` en `getHtml()`.
- webpack y la configuración actual de chunks/WASM para Formualizer.
- Soporte CSV, XLSX y ODS; cálculos de vista previa; edición y guardado; navegación, búsqueda y redimensionamiento.
- El botón Recargar, el toast y el logger que el usuario pidió.

No instalar loaders CSS ni paquetes adicionales para esta corrección: el CSS ya se genera y se carga por otra ruta. No modificar manualmente `dist/webview.js`, pues una recompilación sobrescribiría ese arreglo. No eliminar funcionalidades ni hacer refactors.

No hace falta retirar `IgnorePlugin` para solucionar este caso si ya no existe el import CSS en la entrada. Dejar ese plugin y `styles.d.ts` como están en este primer cambio evita ampliar el alcance. Su limpieza puede evaluarse por separado después de que el editor funcione.

## 7. Implementación por pasos

### Paso 1: inspeccionar y confirmar el estado real

Leer este documento y revisar `src/webview/main.ts`, `esbuild.js` y `src/editor.ts`. Comprobar que todavía existe el import CSS redundante, que el CSS se compila por separado y que el HTML contiene su `<link>`. Buscar la excepción en el bundle actual:

```sh
rg -n "webpackMissingModule|Cannot find module.*styles" dist/webview.js
```

Si los archivos ya no coinciden con este diagnóstico, explicar la diferencia antes de aplicar cambios distintos. Las líneas citadas son referencias de la versión inspeccionada, no posiciones fijas.

### Paso 2: corregir la fuente

Eliminar la línea `import './styles.css';` de `src/webview/main.ts`. Mantener las demás importaciones y el comportamiento del archivo. Esta es la única modificación de fuente necesaria prevista.

### Paso 3: compilar y comprobar el bundle ejecutable

Ejecutar:

```sh
npm run compile
```

Esto incluye tipos, lint y build. Después volver a buscar la excepción del CSS en `dist/webview.js`: no debe existir. `rg` devuelve código 1 cuando no hay coincidencias; en este caso esa ausencia es el resultado esperado.

La compilación correcta por sí sola no basta. Ejecutar también la prueba de arranque del apartado 8. Debe alcanzar `ready` y el listener de Recargar sin quitar ni reemplazar instrucciones del bundle en memoria.

Si se comprueba también `npm run package`, ejecutarlo de forma secuencial y repetir la prueba sobre su bundle de producción. Evitar que un watcher sobrescriba los artefactos mientras se está validando una variante. Al terminar puede ejecutarse de nuevo `npm run compile` para dejar los artefactos de desarrollo actualizados.

### Paso 4: comprobar en VS Code

Reiniciar el Extension Development Host o usar **Developer: Reload Window** en esa ventana para que se recree el webview con los archivos nuevos. Una vista que ya está abierta puede seguir ejecutando la versión anterior. Abrir de nuevo el CSV mediante el menú contextual **Visualizar en Spreadsheet**.

Ejecutar el checklist del apartado 9. Si no se dispone de acceso a la prueba manual, reportarla como pendiente; no afirmar que pasó por haber compilado o ejecutado la simulación.

### Paso 5: entregar un informe de la corrección

Indicar archivos fuente modificados, artefactos regenerados, resultado de compilación y prueba de arranque, comprobaciones manuales realizadas/pendientes y cualquier fallo restante. No declarar resuelto todo el MVP por haber retirado esta excepción: este cambio resuelve el bloqueo identificado del inicio.

## 8. Prueba de arranque sin VS Code

Este comando ejecuta el bundle real con un DOM mínimo y una API VS Code simulada. No toca archivos. La versión defectuosa falla con `MODULE_NOT_FOUND`; después de corregir y compilar, debe imprimir `PASS` y los mensajes `ready` y `reloadFile`.

```sh
node <<'NODE'
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const messages = [];
const elements = new Map();
class Script {
  constructor() {
    this.tagName = 'SCRIPT';
    this.src = 'https://file.vscode-resource.vscode-cdn.net/dist/webview.js';
    this.nonce = 'test';
  }
}
function getElement(selector) {
  if (!elements.has(selector)) {
    elements.set(selector, {
      listeners: {},
      classList: { add() {} },
      setAttribute() {},
      addEventListener(type, callback) { this.listeners[type] = callback; }
    });
  }
  return elements.get(selector);
}
const context = {
  console,
  HTMLScriptElement: Script,
  document: { currentScript: new Script(), querySelector: getElement },
  window: {
    addEventListener() {},
    setTimeout() { return 1; },
    clearTimeout() {}
  },
  acquireVsCodeApi() {
    return { postMessage(message) { messages.push(message); } };
  }
};
try {
  vm.runInNewContext(fs.readFileSync('dist/webview.js', 'utf8'), context,
    { filename: 'dist/webview.js' });
  const reloadClick = getElement('#reload-file').listeners.click;
  assert.equal(typeof reloadClick, 'function');
  reloadClick();
  assert.deepEqual(messages.map(message => message.type), ['ready', 'reloadFile']);
  console.log('PASS: inicio y Recargar envían mensajes:', JSON.stringify(messages));
} catch (error) {
  console.error('FAIL:', error.stack);
  process.exitCode = 1;
}
NODE
```

Limitación deliberada: esta prueba no renderiza celdas, no carga WASM y no ejecuta el extension host. Detecta el fallo de inicialización observado y verifica que la entrada llegue al handshake y al envío del clic. El toast, la escritura del log y la lectura de archivos requieren la prueba real de VS Code.

## 9. Criterios de aceptación y checklist manual

- [ ] `npm run compile` pasa.
- [ ] El bundle regenerado no contiene la excepción por `./styles.css`.
- [ ] La prueba del apartado 8 pasa sin modificar el bundle en memoria.
- [ ] En un Extension Development Host reiniciado, el CSV deja de mostrar «Cargando archivo…» y presenta filas, columnas y dimensiones.
- [ ] Los estilos siguen visibles gracias al `<link>` externo.
- [ ] Al pulsar Recargar, el webview envía `reloadFile` y se muestra la notificación «Recargando» de VS Code (comprobar también el centro de notificaciones si la configuración del usuario afecta su presentación).
- [ ] Se crea `debug_spreadsheetviewer_<fecha-hora>.txt` en la raíz del workspace que contiene el archivo; si no hay workspace, en la carpeta del documento.
- [ ] El archivo incluye la recepción del clic, lectura de bytes, reemplazo del modelo y la línea final de recarga terminada; si aparece una excepción, se reporta y se investiga ese nuevo punto.
- [ ] Una segunda recarga genera un archivo de debug nuevo, sin sobreescribir el anterior.
- [ ] XLSX y ODS también abren su tabla; el inicio común ya no se detiene en la excepción CSS.
- [ ] Un XLSX con fórmulas conserva la ruta de cálculo de vista previa. Si falla el chunk o WASM, registrar el error como un problema adicional específico; no retirar Formualizer para ocultarlo.

## 10. Si hay otro fallo después de esta corrección

Primero confirmar que el bundle ejecutado corresponde al recompilado. Luego revisar la consola específica del webview y sus mensajes `ready`/`reloadFile`. Si Recargar llega al extension host, usar el archivo de debug para localizar lectura, parseo o envío de datos. Si `postMessage` no entrega datos, inspeccionar su `Thenable<boolean>` y la validación de `csvData`/`xlsxData`.

Los ajustes adicionales de manejo de errores antes de cargar el bundle, validación del logger, CSP o ciclo de vida de documentos deben basarse en una nueva evidencia. No son necesarios para retirar la excepción CSS confirmada.

## Instrucción reutilizable para el modelo implementador

> Lee `problema_actual_1_fix.md` y revisa los archivos reales antes de editar. Implementa la corrección mínima del import CSS redundante, regenera los artefactos y ejecuta la prueba de arranque indicada. Conserva todas las funcionalidades y dependencias actuales; no hagas refactors ni edites manualmente el bundle. Reporta qué cambiaste, los resultados reales de las comprobaciones y qué prueba manual falta en VS Code. Si aparece otro error después de resolver este bloqueo, descríbelo con evidencia antes de ampliar el cambio.
