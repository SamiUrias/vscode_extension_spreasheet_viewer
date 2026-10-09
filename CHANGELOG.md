# Change Log

All notable changes to the "spreadsheet-viewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release
- XLSX: añade cálculo de fórmulas para presentación con Formualizer 0.10.1; resultados, fórmulas y cachés originales no se escriben ni se modifican por el motor.
- Interfaz: añade **Recargar** para volver a leer el archivo desde disco y recuperarse de una vista atascada; solicita confirmación si hay ediciones locales pendientes.
- ODS: añade apertura desde el Explorer, navegación entre hojas y edición/guardado de celdas preservando valores crudos; las fórmulas ODS se muestran con su caché y no se recalculan.
