# Performance: where we are, where the time goes, how to close the gap

Measured 2026-10-13 on an Apple M5 Pro (18 cores), macOS, scriptc 0.3.0, Bun canary 1.4.4, bench/vscode (18,080 files, 238 MB).

## 1. The numbers

`--check`, wall time, interleaved runs, min of 3 (5 at 8 threads). Before the perf rounds vs after round 8 (2026-10-13, see the
README's "Swarm rounds" table for each round):

| threads | formatc before → after | `bun fmt` | gap |
| ------- | ---------------------- | --------- | --- |
| 1       | 8.42 → 6.10 s | 2.36 s | 3.5× → 2.6× |
| 8       | 1.25 → 0.90 s | 0.43 s | 2.85× → 2.09× |
| 18      | 0.75 → 0.57 s | 0.29 s | 2.5× → 2.0× |

Whole run, one thread, from `/usr/bin/time -l` (instructions retired are stable when the machine is busy; wall time is not):

| | instructions retired | cycles | IPC | peak RSS |
| - | - | - | - | - |
| formatc | 170.6 G before the perf rounds → **132.2 G** after round 8 (156.7 G was the first build) | 38.6 → 27.9 G | ~4.7 | 305 MB |
| `bun fmt` | 35.9 G | 10.8 G | 3.3 | 124 MB |

**We execute 3.7× more instructions than Bun.** They are cheap ones (IPC ~4.7 vs 3.3), so the cycle gap is ~2.6×. The
problem is instruction count, not cache misses or stalls.

Per-language throughput, measured by the porting agents (compiled, single thread, in-process, MB/s; Bun estimated from `bun fmt
--threads=1` on the same files):

| | formatc | Bun | notes |
| - | - | - | - |
| JSON | 435–530 | ~700 | parse alone ~950 MB/s, writer 1.2–1.5 GB/s |
| YAML | ~80 | ~100 | |
| Markdown | ~75 | ~120 | `bun_md` parser port ~335 MB/s (Rust: 591) |
| CSS/SCSS/Less | ~67 (50 in worker mode) | >100 | |
| GraphQL | ~75 | ~140 | |
| Handlebars | ~40 | ~75 | |
| JS/TS lexer only | 345–357 (~240 in worker mode) | — | |
| JS/TS parser | 207–220 (~160 with refusal checks) | — | |
| **whole corpus (93% JS/TS)** | **~28** | **~100** | |

The language ports other than JS/TS run at 1.3–2× Bun's per-core speed. The JS/TS path, which is most of the corpus, is
~3.5× slower.

## 2. Where the time goes (one thread, leaf samples, Time Profiler)

| area | share | hottest functions |
| - | - | - |
| tree handles + per-file setup (`src/lint`, `src/sema/bind`) | ~19% | `buildUnicodeEscapes` **7.9%**, a typed-array `fill` 1.4%, `exprTag`, `exprSpan`, `exprParent`, `buildTypeParents` |
| JS formatting logic (`src/format/js`) | ~12% | `fmtExpr`, `mayNeedParentheses`, `fmtArguments`, `writeExpressionOf`, `fmtAssignmentLike`, `normalizeStringLiteral` |
| IR writing + Tracker (`src/format/ir`) | ~11% | `markOddBlocks` 2.1%, `Formatter_token`, `pushPlain`, `push4`, `Tracker_note`, `isPlainSource`, `scr_dataview_set` |
| lexer + atoms (`src/sema/parser`) | ~11% | `Lexer_name` 3.6%, `Lexer_scan` 2.3%, `Names_atomOfKeys` 1.8% |
| syscalls | ~9% | `__open` 5.5%, `pread` |
| printer | ~9% | `printElements`, `fitsElement`, `outSource`, `printFlat` |
| scriptc runtime | ~4% | `scr_dataview_get/set`, `scr_shared_guard`, `_tlv_get_addr` |
| everything else (parser, refusal checks, strings, ...) | ~25% | flat: no function above 0.6% |

The profile is flat. Apart from a few hot spots it is the same factor everywhere, which points at **code generation** more than
at any one algorithm.

## 3. Findings

### 3.1 The driver, the file system and threads are not the bottleneck

- The pipelined driver (`src/driver/`) walks the tree and formats in parallel. With a stand-in load of 9 ns/byte (Bun's
  per-core speed) it **beats Bun at 8 threads (398 vs 436 ms) and ties at 18 (318 vs 312 ms)**.
- The floor for both tools is the kernel. `open()` costs 8–11 µs per file under contention and saturates near 100k opens/s
  from ~4 threads. 18,080 files plus 4,604 directories is ~230 ms at any thread count.
- Scaling on an idle machine is fine: 8.42 s → 1.25 s at 8 threads is 6.7×; Bun gets 5.5×.
- So matching Bun at 8 threads means matching Bun's per-core formatting speed, ~110 MB/s, inside a worker.

### 3.2 scriptc 0.3.0 code generation (all measured, details in [SCRIPTC_COOKBOOK.md](SCRIPTC_COOKBOOK.md))

1. **Every number local is a `double`.** Integer code becomes `fcvtzs`/`scvtf` round trips unless every operand is written as
   `x | 0`. Even then, a function's result is a double, so values crossing a call are converted twice. `Int32` contracts
   gave no speedup in 0.3.0. scriptc HEAD (unreleased) has real `i32` locals.
2. **Spelling cliffs.** Storing a bare typed-array read (`o[i] = src[i]`) is 25× slower than `src[i] | 0`. Storing a bare
   number into an `Int32Array` is 6× slower. `(n + 1) | 0` is 7× slower than `((n | 0) + 1) | 0`. Reading a typed-array
   field inside a loop is 6× slower than reading a local. A data field read through an interface type costs 26 ns; an
   `abstract readonly kind` costs 134 ns. 183k lines written by 32 agents certainly still contain some of these.
3. **Worker mode.** A program that uses `Worker`, which we must for `@scriptc/threads`, is compiled with:
   - every module-level variable `thread_local`, read through the TLV descriptor on macOS;
   - every typed-array access split on `bytes->shared`, with an opaque runtime call on the cold path that also blocks LLVM
     from hoisting other loads;
   - a cancellation counter in loops;
   - the stack limit read through thread-specific data.

   This cost the lexer 30% and CSS 25%. Our design keeps per-thread state in module-level singletons (tigerstyle "static
   allocation"), which is exactly what worker mode makes expensive.
4. **Reading `.stack` anywhere turns on stack tracking in every function** (−33% in the parser). It was in `main.ts` and is
   removed. Independently, the stack guard on every non-inlined call was ~19% of the parser's samples.
3a. **Measured in perf rounds 4–7 (the biggest wins so far):** every source-level mention of a module-level binding is a
   separate `_tlv_get_addr` call (LLVM merges none: `exprLeft` mentions `hir` 3 times, 3 calls). A module-level numeric
   constant is folded unless its module is in an import cycle; then it is a thread-local global with a checked
   `X_x25_initialized` flag, two calls per use, also as a `case` label (`anSpan` made 326 such calls). Moving those 578
   constants into import-free leaf modules saved 11 G instructions (−7.8%). Aliasing a module-level object into a local is
   one call and no refcount work; aliasing a typed array into a local adds `scr_bytes_retain_v`/release calls. The codemods
   in `tools/codemod/` apply these rules. What remains (~6% of samples) is mostly functions that mention `hir`, `lx` or `p`
   once per call; removing it means passing them as parameters.
5. **`DataView` get/set are runtime calls, not inlined.** `scr_dataview_set` alone is ~1% of the profile.
6. Closures cost 2.3–3 ns per call. Small top-level functions and methods are inlined. `try` is free. Allocating a small
   object costs 4–8 ns (V8 often allocates nothing for the same code).

### 3.3 Specific hot spots that are plain bugs

- `buildUnicodeEscapes` (7.9%) scans every file byte by byte, two typed-array reads per byte with the worker-mode check on
  each, to find `\u`. A native `indexOf(92)` (memchr) or the lexer's own record of escapes makes it nearly free.
- A per-file `fill` (1.4%) is likely O(capacity) instead of O(used): per-thread tables are sized for the largest file seen,
  and the 8.4 MB `test-checker.ts` sets that size.
- `markOddBlocks` + `isAllPrintable` + width scans (≥3%) re-scan source bytes that a single pass or a native search could
  classify.

## 4. How to close the gap, ranked by expected effect

### A. Fix the hot spots (cheap, ~10–15%)
The three items in §3.3, `DataView` → typed-array columns in the IR, and auditing hot loops for the §3.2 spelling cliffs.
A five-agent perf pass on exactly this (front-end, handles, IR/printer, JS formatter, driver) was started and paused by the
API limit; its partial changes are in the tree.

### B. Make per-thread state cheap in worker mode (~20–30%)
- Hoist module-level singletons (`hir`, `lx`, `p`, the Formatter's columns) into locals at the top of every hot function, or
  pass one per-thread context object as a parameter so its fields are plain loads instead of TLS lookups.
- Keep tight loops on locals only. Prefer native bulk operations (`indexOf`, `set`, `copyWithin`, `fill` over the used
  range) to per-element typed-array access, which pays the shared-buffer check on every element.
- Measure with a single-threaded build of the same code (no `Worker`) to know the exact tax per area; the cookbook (§12–14)
  has the rules.

### C. Do less work per node (~20–40%, needs care to stay byte-exact)
- Make sure the `is_quiet` fast path really skips comment queries. Decide from the syntax before looking at text, and
  compute per-file what is asked per node: line starts, "has newline between", string-literal info.
- Fewer captures and best-fitting re-formats where Bun can prove the result.
- Cheaper handle accessors: one column read instead of several layers, no `SP` out-slot writes on hot paths.
- Fuse the refusal checks (`src/sema/parser/syntax`) into the parse, or run them only where Bun does.

### D. Compiler-level (largest potential, outside this repo)
These would move every line of the 183k at once:
- **`i32` locals and integer function results.** In scriptc HEAD (unreleased) for locals. This removes the double round
  trips and most of the `| 0` noise.
- **Thread-private typed arrays in worker mode.** An array allocated by this thread and never posted cannot be shared, so it
  needs no `shared` split. A per-array "private" bit checked once per loop, or escape analysis, would recover the 20–30%.
- **Cache TLS addresses per function** instead of per access.
- **Cheaper stack guard** for recursive descent: check once per N levels, or only in functions that recurse.
- **Inline `DataView` access** and 32/64-bit loads from `Uint8Array`, which enables word-at-a-time (SWAR) scanning in lexers
  the way Bun uses SIMD.

### E. Options that change the design
- **Processes instead of threads.** Forked children carry no worker-mode tax; the cookbook measured identical scaling. This is
  a 20–30% win, but it drops `@scriptc/threads`, which this project set out to use, so we have not done it.
- **Stop printing at the first difference in `--check`.** This is legitimate, and the result is the same. It saves at most
  the printer's ~9% on files that differ. Bun doesn't do it, so it would not be a like-for-like comparison.

## 5. Back of the envelope

Bun spends 35.9 G instructions on 238 MB, about **150 instructions per byte**. We spend ~700. To match at 8 threads we need
roughly Bun's per-core speed inside a worker, i.e. the same ~150 instructions per byte.

| step | from (instructions/byte) | to | gain |
| - | - | - | - |
| A (hot spots) | ~700 | ~600 | ~15% |
| B (worker-mode state) | ~600 | ~450 | ~25% |
| C (less work per node) | ~450 | ~300 | ~30–40% |

A–C alone plausibly reach ~300 instructions per byte, about 2× Bun. The rest most likely needs D: integer locals and
thread-private arrays in scriptc itself. That is our estimate, not a measurement.
