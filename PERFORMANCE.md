# Performance baseline

Run `npm run benchmark:performance` to compile the current sources and measure the parser, edit model, JSON payload preparation, and row projection on locally generated fixtures. The benchmark uses five samples by default; set `BENCHMARK_ITERATIONS` to change that count. It prints runtime, OS, CPU, fixture sizes, p50/p95, and per-operation heap/RSS peaks. The numbers below are a baseline, not a performance guarantee.

## Baseline — 2026-10-11

Machine: Apple M1 Max, macOS 25.2, Node v18.20.4. Five samples per operation; p50/p95 in milliseconds.

| Operation | Fixture | p50 | p95 | Peak heap |
| --- | --- | ---: | ---: | ---: |
| CSV parse | 35,290 × 5; 1.36 MB | 101.0 | 107.2 | 106 MiB |
| Get CSV rows | 35,290 × 5 | 0.85 | 1.00 | 43 MiB |
| CSV serialization | 35,290 × 5 | 0.16 | 0.31 | 40 MiB |
| JSON payload preparation | 35,290 × 5; 1.78 MB JSON | 4.16 | 4.24 | 41 MiB |
| Sort projection | 35,290 × 5 | 9.64 | 9.94 | 55 MiB |
| XLSX worksheet XML DOM parse | 35,290 × 5; 5.75 MB XML | 1,429 | 1,616 | 525 MiB |
| Full XLSX parse | 35,290 × 5; 649 KiB ZIP | 3,302 | 3,404 | 686 MiB |
| XLSX unzip | 35,290 × 5 | 55.9 | 81.1 | 40 MiB |
| Wide CSV getRows | 500 × 256; 0.94 MB | 28.2 | 42.7 | 65 MiB |

This identifies XLSX XML parsing as the main memory and latency cost for this fixture. The benchmark does not measure Extension Host message delivery, browser rendering, or formula calculation: those require an instrumented VS Code/Webview host and formula-bearing fixtures. The JSON measurement estimates serialization size/time; it does not claim to be an IPC timing measurement. The tested XLSX has numeric cells and no formulas, styles, merges, or relationships beyond the minimum workbook parts.

## Current limits and follow-up

- Formula workbook bytes are sent to a Webview once per document/revision and retained there for subsequent sheet changes. A newly initialized Webview receives the current revision again.
- Scroll and viewport rendering remain client-side; they do not request a workbook snapshot from the extension.
- The current parser peak for a 35,290 × 5 XLSX is high and needs profiling before increasing file-size or cell-count limits.
- V2-19A2 still needs delta/resync transport between transaction snapshots. Rendering and formula timing remain unmeasured until an Extension Host runner can capture them reliably.
