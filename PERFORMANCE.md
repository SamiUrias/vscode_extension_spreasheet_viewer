# Performance baseline

Run `npm run benchmark:performance` to compile the current sources and measure the parser, edit model, JSON payload preparation, and row projection on locally generated fixtures. The benchmark uses five samples by default; set `BENCHMARK_ITERATIONS` to change that count. It prints runtime, OS, CPU, fixture sizes, p50/p95, and per-operation heap/RSS peaks. The numbers below are a baseline, not a performance guarantee.

## Baseline — 2026-10-11

Machine: Apple M1 Max, macOS 25.2, Node v18.20.4. Five samples per operation; p50/p95 in milliseconds.

| Operation | Fixture | p50 | p95 | Peak heap |
| --- | --- | ---: | ---: | ---: |
| CSV parse | 35,290 × 5; 1.36 MB | 104.6 | 108.5 | 106 MiB |
| Get CSV rows | 35,290 × 5 | 0.91 | 1.14 | 43 MiB |
| CSV serialization | 35,290 × 5 | 0.17 | 0.39 | 40 MiB |
| JSON payload preparation | 35,290 × 5; 1.78 MB JSON | 4.18 | 4.34 | 41 MiB |
| One cell edit delta JSON | 1 changed cell | — | — | 129 bytes |
| Sort projection | 35,290 × 5 | 9.87 | 10.55 | 55 MiB |
| XLSX worksheet XML DOM parse | 35,290 × 5; 5.75 MB XML | 1,453 | 1,601 | 524 MiB |
| Full XLSX parse | 35,290 × 5; 649 KiB ZIP | 3,299 | 3,349 | 687 MiB |
| XLSX unzip | 35,290 × 5 | 54.7 | 60.2 | 40 MiB |
| Wide CSV getRows | 500 × 256; 0.94 MB | 28.6 | 40.7 | 68 MiB |

For this fixture, one changed CSV cell serializes to 129 bytes versus 1,779,673 bytes for the full CSV data message. This compares JSON payload sizes only; VS Code IPC timing is not measured.

This identifies XLSX XML parsing as the main memory and latency cost for this fixture. The benchmark does not measure Extension Host message delivery, browser rendering, or formula calculation: those require an instrumented VS Code/Webview host and formula-bearing fixtures. The JSON measurement estimates serialization size/time; it does not claim to be an IPC timing measurement. The tested XLSX has numeric cells and no formulas, styles, merges, or relationships beyond the minimum workbook parts.

## Current limits and follow-up

- Formula workbook bytes are sent to a Webview once per document/revision and retained there for subsequent sheet changes. A newly initialized Webview receives the current revision again.
- Scroll and viewport rendering remain client-side; they do not request a workbook snapshot from the extension.
- The current parser peak for a 35,290 × 5 XLSX is high and needs profiling before increasing file-size or cell-count limits.
- V2-19A2 currently sends CSV cell-edit deltas and requests a full snapshot after a revision gap; its real provider/Webview integration check remains pending. XLSX/ODS edits still use full snapshots in V2-19A3. Rendering and formula timing remain unmeasured until an Extension Host runner can capture them reliably.
