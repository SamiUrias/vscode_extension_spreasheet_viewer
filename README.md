# Spreadsheet Viewer by Samuel Urias

**View, search, sort, filter, and edit CSV, TSV, TAB, XLSX, and ODS files without leaving VS Code.** Spreadsheet Viewer keeps the values stored in your files visible and lets you save cell edits back to the original document.

> **Language:** The extension's interface is currently in **Spanish**. This Marketplace page is in English. English interface translations are planned for a future release.

## Highlights

- **One table for common spreadsheet files:** open CSV, TSV, TAB, XLSX, and ODS files in an editor tab.
- **Edit and save cells:** edit values in place or in the cell editor and save changes to the original file.
- **Keep raw values visible:** values are not silently converted to dates, percentages, or display-formatted numbers.
- **Find data quickly:** search the active sheet and jump to a cell by reference, such as `B54`.
- **Sort and filter the view:** sort by multiple columns and filter by raw values or conditions. These operations do not reorder or remove data in the file.
- **Navigate with the keyboard:** move through cells, select ranges, and begin editing by typing or pressing `F2`.
- **Adjust the table layout:** resize columns and rows, auto-fit columns, wrap text, and freeze visible rows or columns.
- **Remember your view:** restore selection, scroll position, search, sort, filters, and sizes per file and sheet. This can be disabled in Settings.
- **Preview without editing:** inspect a file from disk, preview unsaved CSV/TSV/TAB text, or explicitly preview another text file as CSV.
- **Inspect XLSX formulas:** supported formulas can be calculated for display; calculated results are never written to the workbook.

## Get started

1. Use VS Code 1.140 or newer and install **Spreadsheet Viewer by Samuel Urias** from the Extensions view.
2. In the Explorer, right-click a CSV, TSV, TAB, XLSX, or ODS file.
3. Choose **Abrir en Spreadsheet Viewer** (Open in Spreadsheet Viewer).

You can also use the editor title button or run **Spreadsheet Viewer: Abrir en Spreadsheet Viewer** from the Command Palette. The default shortcut is `Ctrl+Alt+Shift+O` (`Cmd+Alt+Shift+O` on macOS).

Spreadsheet Viewer is an optional editor for these formats. To make it the default for a file type, use **Open With…** in VS Code and select the extension.

## Work with data

### Sort and filter

Click a column heading to sort ascending, descending, and then clear that sort. Click another heading to replace the sort; use `Shift` + click to add a sort column. The numbered indicators show sort priority. `T` and `N` indicate text and numeric comparison. Use `Alt` + click to switch comparison mode, or `Ctrl` + click (`Cmd` + click on macOS) to remove one sort criterion. **Limpiar orden** (Clear Sort) removes every active sort criterion.

Use the filter button beside a heading to select raw values or enter up to two conditions joined with **AND** or **OR**. Filters on separate columns are combined with **AND**. The values list can be searched and paged; **Apply**, **Cancel**, and **Clear** control the filter. Active filters appear as removable chips above the table.

Sorting and filtering only change the visible projection. The source rows and the saved file remain in their original order. Search covers visible rows by default; choose **Toda la hoja** (Entire Sheet) to include filtered rows. If a match or cell reference is hidden, the view can reveal it by clearing the active filters.

### Navigate and edit

- Click and drag to select a range. `Shift` + click or `Shift` + arrow extends the selection.
- Use arrow keys, `Home`, `End`, `PageUp`, `PageDown`, `Tab`, and `Enter` to move around the table.
- Press `F2` or start typing to edit the selected cell. Press `Enter` or `Tab` to confirm; press `Escape` to cancel.
- Use the cell reference field to jump to a location such as `B54`.
- Use the search field and its previous/next controls to move through matches in the active sheet.

Range selection follows the visible order and skips filtered-out rows. Copying, pasting, and moving cell ranges are not available yet.

### Adjust the view

Drag the dividers in the column and row headings to resize them. **Autoajustar** (Auto Fit) can fit the first column or all columns to their headings and a deterministic sample of up to 200 visible rows. Its tooltip explains the selected scope and sample-based sizing. The width is bounded to keep the table usable. Turn on **Ajustar texto** (Wrap Text) to wrap cell contents and grow visible rows automatically; manual row heights are retained while wrapping is active.

Set **Filas fijas** (Frozen Rows) and **Columnas fijas** (Frozen Columns) to keep the first visible rows or columns in place while scrolling. These layout choices affect the view only and are remembered per sheet.

## Previews

The Command Palette includes these read-only options:

- **Vista previa de hoja** (Preview Sheet) reads the file from disk.
- **Vista previa del buffer CSV/TSV/TAB** (Preview Text Buffer) follows unsaved text changes in the active text editor.
- **Vista previa como CSV…** (Preview as CSV…) explicitly interprets a text file as CSV.

Opening the editable view while the text buffer has unsaved changes asks whether to save, discard, or cancel first.

## Raw values and file compatibility

- CSV values remain text. The editor supports UTF-8 and UTF-16 files with a byte-order mark and detects comma, semicolon, or tab separators. `.tsv` and `.tab` files use tabs.
- XLSX and ODS values are read from their stored XML values. For example, a date-formatted XLSX number is shown as its stored serial value, not converted to a formatted date.
- XLSX formula expressions and cached values remain distinct. Formula calculation is for display only and does not replace the original formula or cache. Unsupported formulas show their stored cache and are identified as unsupported.
- ODS formulas are shown with their stored cached value and are not recalculated.
- The first CSV row can be displayed as a column heading; optional header capitalization changes only the visual label. CSV comment records can be hidden from the table while remaining in the file.
- CSV, XLSX, and ODS files are limited to 10 MiB. XLSX/ODS archives also have limits for expanded size, number of parts, sheets, rows, columns, and populated cells. Files over a limit are rejected as a whole rather than shown as a partial editable table.

XLSX and ODS support focuses on tabular data. Macros, charts, pivot tables, signatures, external links, advanced formatting, and other complex workbook features are not fully supported. The extension may warn about unsupported content; it does not promise full Excel or ODF round-trip fidelity. Validate important workbooks on copies in Excel or LibreOffice before relying on saved results.

## Settings

All settings default to the values shown below. Add only the settings you want to override to User or Workspace `settings.json`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `spreadsheet-viewer.csv.commentPrefix` | `"#"` | Recognize CSV records beginning with this prefix as comments. Use `""` to disable comment detection. |
| `spreadsheet-viewer.csv.firstRowHeader` | `true` | Use the first CSV data row as the visual column label. The row remains in the data. |
| `spreadsheet-viewer.csv.headerCase` | `"none"` | Choose `"none"`, `"upper"`, or `"lower"` for visual CSV heading labels. |
| `spreadsheet-viewer.view.restoreState` | `true` | Save and restore view preferences per file, sheet, and mode. |
| `spreadsheet-viewer.view.showResetButton` | `true` | Show or hide **Restablecer vista** (Reset View). |
| `spreadsheet-viewer.view.showClearSortButton` | `true` | Show or hide **Limpiar orden** (Clear Sort). |

For complete behavior details and examples, see the `CONFIGURATION.md` file included with the extension. **Restablecer vista** clears view preferences such as search, sort, filters, selection, and sizes. It does not change the document or discard an edit draft. Both view buttons include tooltips.

## Language and support

The current interface is Spanish-only. English UI localization is planned but is not part of this release.

This is a personal project provided **as is**, without a promise of support, maintenance, or compatibility with every spreadsheet. Keep backups of important files and validate important workbooks on copies before relying on saved results.

## License

Spreadsheet Viewer is licensed under the MIT License (see `LICENSE`). Bundled dependencies retain their own licenses; see `THIRD-PARTY-NOTICES.md` and the included license texts.
