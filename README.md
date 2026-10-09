# Spreadsheet Viewer

Extensión de VS Code para ver y editar archivos CSV, XLSX y ODS sencillos desde una pestaña del editor. En el Explorer, usa **Visualizar en Spreadsheet** en el menú contextual del archivo. La vista permite cambiar entre hojas XLSX y ODS, buscar en la hoja activa, navegar a una celda por referencia y guardar las ediciones en el archivo de origen. **Recargar** vuelve a leer el archivo desde disco; si hay cambios locales pendientes, pide confirmación antes de descartarlos. Puedes redimensionar columnas desde sus divisores en los encabezados y ajustar la altura de una fila desde el borde inferior de su encabezado numerado.

## Fidelidad y límites conocidos

- Los valores se muestran sin formatos visuales ni conversiones inferidas. CSV conserva valores como texto; XLSX y ODS muestran los valores almacenados en XML, incluyendo seriales numéricos de fechas y decimales tal como están escritos. En ODS los valores se leen de `content.xml`; los estilos no se aplican a la tabla.
- Las fórmulas XLSX no se pueden editar. Formualizer 0.10.1 calcula resultados para presentación con las funciones y construcciones que soporta; si el motor devuelve `#NAME?` o no puede interpretar una fórmula, se muestra **Fórmula NO compatible**. Los errores de cálculo se informan aparte. El resultado es solo visual: nunca se escribe en el archivo ni sustituye la fórmula o su caché. Formualizer publica el paquete bajo MIT o Apache-2.0; esto no implica compatibilidad con todas las fórmulas de Excel.
- La tabla conserva y muestra el texto crudo del archivo. El motor convierte entradas numéricas al tipo numérico requerido para calcular, por lo que un resultado calculado puede tener la precisión normal de punto flotante; esto no cambia el valor crudo mostrado ni guardado.
- Las fórmulas XLSX se calculan solo para mostrarlas con Formualizer. Las fórmulas ODS se muestran junto con el valor guardado en caché; no se recalculan. Las fórmulas de ambos formatos no se pueden editar.
- El editor admite CSV UTF-8 y UTF-16 con BOM, y detecta coma, punto y coma o tabulador. Al editar reemplaza solo los campos tocados y conserva bytes de los campos no editados cuando es posible.
- CSV, XLSX y ODS tienen un máximo de 10 MiB en disco. Los paquetes XLSX/ODS limitan la expansión ZIP a 64 MiB, 10 000 partes, 50 hojas, 50 000 filas, 256 columnas y 500 000 celdas con datos; se rechaza la carga completa si se excede un límite, sin mostrar una tabla parcial editable.
- XLSX se edita modificando las partes XML de celdas y reempaquetando el archivo. Macros, gráficos, tablas dinámicas, vínculos externos y firmas digitales no se interpretan en la tabla; la presencia de algunas de estas características se advierte en la vista. No se promete preservación integral de características de Excel. Valida copias de libros importantes en Excel o LibreOffice antes de depender del resultado.
- ODS se edita modificando las celdas afectadas en `content.xml` y reempaquetando el contenedor ZIP, conservando las demás partes del paquete. No se aplican estilos y las fórmulas solo se muestran con su caché. La extensión cubre hojas tabulares y no garantiza preservar cada función avanzada del estándar ODF; valida copias importantes en LibreOffice antes de depender del resultado.
- No admite XLS, colaboración, compatibilidad completa con fórmulas Excel, gráficos, macros, tablas dinámicas ni formato avanzado. Ante cambios externos con ediciones pendientes, la extensión solicita recargar descartando cambios o guardar una copia.

Los límites y el comportamiento descritos corresponden a la implementación y pruebas disponibles en este repositorio. La compatibilidad con libros reales complejos requiere validación adicional.

## Desarrollo y verificación

Requisitos: Node.js compatible con la versión de VS Code usada por el proyecto y npm. Instala dependencias con `npm install`.

- `npm run compile`: comprueba tipos, lint y compila la extensión y la interfaz web.
- `npm run package`: ejecuta las mismas comprobaciones y genera los bundles minificados de producción en `dist/`.
- `npm test`: compila y ejecuta pruebas en Extension Host; requiere un runtime de Node compatible con las herramientas de prueba instaladas.
- Para probar la interfaz en VS Code, abre el proyecto, ejecuta **Run Extension** con F5 y prueba el menú contextual del Explorer. Mueve la pestaña a otro grupo y sigue el checklist de verificación manual en `planning.md`.

El paquete VSIX todavía debe generarse y comprobarse con `vsce package` en un entorno donde esté disponible `@vscode/vsce`.
