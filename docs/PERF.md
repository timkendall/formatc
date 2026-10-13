# Perf phase: shared rules (read before touching code)

**Goal:** `bin/fmt --check` on bench/vscode as fast as `~/.bun/bin/bun fmt --check` at equal thread counts (8 is Bun's published
benchmark; 1 and 18 too). Start (2026-10-13): ours 9.5 s @1 thread / 2.7 s @8; Bun 2.3 s / 0.43 s.

**Metric (noise-free, use it):** instructions retired, single thread, whole corpus:
```sh
cd bench/vscode && /usr/bin/time -l /tmp/fmt-<you> --check --threads=1 2>&1 >/dev/null | grep -E "instructions retired|cycles elapsed|real"
```
Start: **156.7 G instructions, 36.4 G cycles** (Bun: **35.9 G instructions, 10.8 G cycles**). The machine is shared by many agents,
so wall-clock numbers are ±15%; instructions are stable. Also use cycles (they include memory stalls). Subsystem harnesses must be
built in **worker mode** (the real binary imports `Worker`: add an unused `import { Worker } from "node:worker_threads"`) or
measure inside the real binary — otherwise you optimize a configuration we don't ship (cookbook §0.3, §12).

**Profile:** `xcrun xctrace record --template 'Time Profiler' --output /tmp/<you>.trace --launch -- /tmp/fmt-<you> --check --threads=1`
in bench/vscode, then `python3 tools/xctrace-top.py /tmp/<you>.trace /tmp/fmt-<you> [fn-suffix...]` (leaf functions; with names,
hottest addresses for `objdump -d`).

**Correctness gates (must hold after every change you keep):**
1. `cd bench/vscode && /tmp/fmt-<you> --check --threads=18 --compare-to=../vscode-fmt` → `mismatch 0` for every extension except
   `.html` (being ported).
2. `node tools/conformance.ts prettier` numbers ≥ `docs/conformance-baseline.txt` for every language (flow/html/vue/angular/lwc/
   mjml/misc are still being ported by other agents and will rise).
3. Compiled and node output identical.

**Coordination:** five perf agents and four porting agents edit the tree at once. Only edit your area. Keep the tree building:
make each edit complete before you build; if the whole-program build fails in someone else's file, wait a minute and retry.
Build your own binary: `SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-<you> scriptc build src/main.ts -o /tmp/fmt-<you>` (~25 s).
Log each kept optimization with its instruction delta in your STATUS entry; revert what doesn't pay.

**Known hot spots at the start** (leaf samples, 1 thread): `buildUnicodeEscapes` 7.9% (byte loop → native `indexOf`), `__open`
5.5%, `Lexer_name` 3.6%, `Lexer_scan` 2.3%, `markOddBlocks` 2.1%, `Names_atomOfKeys` 1.8%, `Formatter_token` 1.5%, a typed-array
`fill` 1.4% (per-file fill of whole capacity?), `Formatter_pushPlain`, `Printer_printElements`, `Formatter_push4`, `exprTag`,
`Printer_fitsElement`, `Tracker_note`, `Printer_outSource`, `exprSpan`, `fmtExpr`, `scr_dataview_set`, `exprParent`,
`mayNeedParentheses`. By area: lint/ast+parents ~19%, js format logic ~12%, IR formatter/tracker ~11%, lexer/names ~11%,
syscalls ~9%, printer ~9%, scriptc runtime ~4%, the rest spread thin.

**Tigerstyle ideas worth trying** (tigerstyle.dev): static allocation (no per-file reallocation, no per-node allocation), batching
(do work over large contiguous ranges; native bulk ops like `indexOf`/`set`/`copyWithin`), avoid copying (format straight from the
read buffer, compare output to input while printing and stop early is NOT allowed — Bun formats fully; but don't copy the output
again to compare), back-of-the-envelope: Bun spends ~2 instructions per... measure per-byte and per-node instruction budgets.
