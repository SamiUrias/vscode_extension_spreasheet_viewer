# Change Log

All notable changes to the "spreadsheet-viewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
