# Spreadsheet Viewer

Extensión de VS Code para ver y editar archivos CSV/TSV/TAB, XLSX y ODS sencillos desde una pestaña del editor. Usa **Abrir en Spreadsheet Viewer** desde el menú contextual del Explorer o de una pestaña, el botón del título del editor, la paleta de comandos o el atajo `Ctrl+Alt+Shift+O` (`Cmd+Alt+Shift+O` en macOS) cuando el recurso activo sea compatible. La vista permite cambiar entre hojas XLSX y ODS, buscar en la hoja activa, navegar a una celda por referencia y guardar las ediciones en el archivo de origen. **Recargar** vuelve a leer el archivo desde disco; si hay cambios locales pendientes, pide confirmación antes de descartarlos. Puedes redimensionar columnas desde sus divisores en los encabezados y ajustar la altura de una fila desde el borde inferior de su encabezado numerado.

El comando también aparece en la paleta **Spreadsheet Viewer: Abrir en Spreadsheet Viewer**. Si no recibe un URI explícito, usa la pestaña o el editor activo, y muestra un mensaje si el recurso no es compatible. La asociación del editor es opcional: para abrir XLSX con esta vista de forma predeterminada, usa **Open With…** en VS Code y selecciona Spreadsheet Viewer; CSV y ODS conservan su asociación actual.

Para una vista de solo lectura usa **Spreadsheet Viewer: Vista previa de hoja** (lee desde disco), **Vista previa del buffer CSV/TSV/TAB** (sigue los cambios de texto sin guardar) o **Vista previa como CSV…** para interpretar explícitamente un archivo de texto con extensión arbitraria como CSV. Abrir el editor editable cuando existe un buffer textual modificado pide guardar, descartar o cancelar primero.

Las opciones de VS Code, sus valores y su efecto están documentados en [CONFIGURATION.md](CONFIGURATION.md).

## Fidelidad y límites conocidos

- Los valores se muestran sin formatos visuales ni conversiones inferidas. CSV conserva valores como texto; XLSX y ODS muestran los valores almacenados en XML, incluyendo seriales numéricos de fechas y decimales tal como están escritos. En ODS los valores se leen de `content.xml`; los estilos no se aplican a la tabla.
- Las fórmulas XLSX no se pueden editar. Formualizer 0.10.1 calcula resultados para presentación cuando las pruebas verifican un resultado independiente. Nombres inválidos y errores de fórmula se muestran como errores; funciones no implementadas, derrames y casos conocidos de fechas incorrectas se muestran como **Fórmula NO compatible**. La caché original permanece visible. El resultado es solo visual: nunca se escribe en el archivo ni sustituye la fórmula o su caché. Formualizer publica el paquete bajo MIT o Apache-2.0; esto no implica compatibilidad con todas las fórmulas de Excel.
- La tabla conserva y muestra el texto crudo del archivo. El motor convierte entradas numéricas al tipo numérico requerido para calcular, por lo que un resultado calculado puede tener la precisión normal de punto flotante; esto no cambia el valor crudo mostrado ni guardado.
- Las fórmulas XLSX se calculan solo para mostrarlas con Formualizer. Las fórmulas ODS se muestran junto con el valor guardado en caché; no se recalculan. Las fórmulas de ambos formatos no se pueden editar.
- El editor admite CSV UTF-8 y UTF-16 con BOM, y detecta coma, punto y coma o tabulador. Al editar reemplaza solo los campos tocados y conserva bytes de los campos no editados cuando es posible.
- CSV, XLSX y ODS tienen un máximo de 10 MiB en disco. Los paquetes XLSX/ODS limitan la expansión ZIP a 64 MiB, 10 000 partes, 50 hojas, 50 000 filas, 256 columnas y 500 000 celdas con datos; se rechaza la carga completa si se excede un límite, sin mostrar una tabla parcial editable.
- XLSX se edita modificando las partes XML de celdas y reempaquetando el archivo. Macros, gráficos, tablas dinámicas, vínculos externos y firmas digitales no se interpretan en la tabla; la presencia de algunas de estas características se advierte en la vista. No se promete preservación integral de características de Excel. Valida copias de libros importantes en Excel o LibreOffice antes de depender del resultado.
- ODS se edita modificando las celdas afectadas en `content.xml` y reempaquetando el contenedor ZIP, conservando las demás partes del paquete. No se aplican estilos y las fórmulas solo se muestran con su caché. La extensión cubre hojas tabulares y no garantiza preservar cada función avanzada del estándar ODF; valida copias importantes en LibreOffice antes de depender del resultado.
- No admite XLS, colaboración, compatibilidad completa con fórmulas Excel, gráficos, macros, tablas dinámicas ni formato avanzado. Ante cambios externos con ediciones pendientes, la extensión solicita recargar descartando cambios o guardar una copia.

Los límites y el comportamiento descritos corresponden a la implementación y pruebas disponibles en este repositorio. La compatibilidad con libros reales complejos requiere validación adicional.

### Registro probado de fórmulas

La suite usa dos fixtures propios de 2 KiB con sistemas de fechas 1900 y 1904 y un fixture adicional de regresión. “Probada” se limita a los casos y resultados enumerados aquí; no certifica compatibilidad completa con Excel.

| Familia | Casos comprobados | Estado y límite conocido |
| --- | --- | --- |
| Aritmética y lógica | Comparación numérica, `IF`, división protegida con `IFERROR` | Calculada y verificada con valores esperados. |
| Agregados y criterios | `SUM`, `COUNT`, `AVERAGE`, `COUNTIF`, `SUMPRODUCT` | Casos pequeños verificados con valores independientes. |
| Texto | `TEXT` numérico, `LEN`, `LEFT`, `CONCAT`, `TEXTJOIN` | Los casos enumerados se verifican. `TEXT` de fecha con salida serial-zero conocida queda cache-only. |
| Fechas | `DATE`, `YEAR`, `MONTH`, `DAY`, `WEEKDAY`, `EDATE`, `EOMONTH`, `NETWORKDAYS`; sistemas 1900/1904 | Casos 1900 verificados. `EDATE`/`EOMONTH` seriales en libros 1904 quedan incompatibles porque el motor no ajusta el sistema; `TEXT` fecha con serial-zero también queda cache-only. |
| Búsqueda y referencia | `VLOOKUP`, `HLOOKUP`, `MATCH`, `INDEX`, `INDIRECT`, `ROW`, `COLUMN`, `ADDRESS`; referencias entre hojas | Coincidencia exacta, posición, direcciones y referencias verificadas contra las celdas fuente. |
| Errores | `NA()`, `#NAME?` por función inválida | Se distinguen error real y nombre inválido; `#N/A` no se clasifica como función no implementada. |
| Matrices | `UNIQUE`, `SORT`, `FILTER`, `SEQUENCE`, `TRANSPOSE`, `AGGREGATE`, `LAMBDA`; `#SPILL!`, `#N/IMPL!` | El derrame no se materializa; las funciones que Formualizer no implementa y los derrames quedan explícitamente incompatibles/cache-only. |
| Financieras | `RATE` con 12 pagos mensuales y valores conocidos | Caso verificado contra el resultado esperado `0.029228540769133535`; otras funciones financieras no certificadas. |

`npm run test:formulas` también recorre el fixture grande para detectar cambios de conteo/estado. Los resultados se consideran soporte solo cuando hay expectativas pequeñas independientes; no se usa el total de fórmulas como certificado de compatibilidad.

## Desarrollo y verificación

Requisitos: Node.js compatible con la versión de VS Code usada por el proyecto y npm. Instala dependencias con `npm install`.

- `npm run compile`: comprueba tipos, lint y compila la extensión y la interfaz web.
- `npm run package`: ejecuta las mismas comprobaciones y genera los bundles minificados de producción en `dist/`.
- `npm test`: compila y ejecuta pruebas en Extension Host; requiere un runtime de Node compatible con las herramientas de prueba instaladas.
- Para probar la interfaz en VS Code, abre el proyecto, ejecuta **Run Extension** con F5 y prueba el menú contextual del Explorer. Mueve la pestaña a otro grupo y sigue el checklist de verificación manual en `planning.md`.

El paquete VSIX todavía debe generarse y comprobarse con `vsce package` en un entorno donde esté disponible `@vscode/vsce`.
