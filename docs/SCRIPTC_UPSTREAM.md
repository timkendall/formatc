# scriptc 0.3.0: bugs and performance findings to report upstream

Found while making formatc (a 183k-line TypeScript port of `bun fmt`) fast. All of them concern **worker mode**, the code
generation every program gets once it imports `Worker` (macOS arm64, scriptc 0.3.0, released CLI and `@scriptc/compiler@0.3.0`
from npm). Locations are in the npm package's `dist/`. Our fixes are patches in `tools/scriptc-dev/patches/`. They are
validated only on formatc: byte-identical output on 18,080 files and Prettier's conformance fixtures. scriptc's own test suite
is not in the npm package and was not run.

Minimal repro for items 1–8: `tools/scriptc-dev/repro/{a.ts,b.ts}`. `a.ts` and `b.ts` import each other and `a.ts` creates a
`Worker`. Build it with `scriptc build a.ts --emit llvm -o a.ll` and grep `a.ll` as noted below. With our patches applied
(`node tools/scriptc-dev/scriptc.mjs build ...`) the symptoms of items 1, 2, 3, 6, 7 and 8 are gone.

Impact is measured on formatc's whole benchmark at 1 thread (instructions retired; the stock build is 133.3 G). The
patches together take it to 92.9 G (−30%) and the 8-thread wall time from 0.90 s to 0.73 s.

## Bugs (clear defects)

### 1. `sanitize_address` is on every function in normal builds
- **Symptom:** without `--sanitize`, `a.ll` still ends with `attributes #0 = { sanitize_address }`, and every emitted function
  carries it (`dist/backend/llvm/emitter.js` ~:1624 and ~:1740).
- **Cost:** the attribute stops LLVM from speculating and hoisting loads (LICM). Loop-invariant loads, such as a typed
  array's length and data pointer, are reloaded on every iteration.
- **Fix (patch 30):** emit `sanitize_address` only for `--sanitize` builds, and use `uwtable` otherwise.

### 2. The inline `DataView`/`Buffer` number path is disabled in worker programs
- **Symptom:** `dist/backend/llvm/byte-numbers.js` ~:37 has `if (host.mod.workers) return fallback();`. So every `getUint32`,
  `setInt16`, `readUInt32LE`, … is an out-of-line `scr_dataview_get`/`set` call in worker programs (`a.ll`: `call ...
  @scr_dataview_get`), even though the inline path (bounds check, align-1 load, byte swap) exists and is correct.
- **Fix (patch 85):** remove the guard. It needs item 3's fix so that shared and local views use the same access path.
  Saved 2.8 G.

### 3. Every shared typed-array access takes one process-wide mutex
- **Symptom:** in worker programs every element access is split on `bytes->shared` (`dist/backend/llvm/expr-bytes.js`
  ~:150–215). A shared view (a `SharedArrayBuffer` view, or bytes passed with `@scriptc/threads` `publish()`) goes to
  `scr_bytes_get`/`scr_bytes_get_or_nan`/`scr_bytes_set`. Those take `SCR_SHARED_GUARD` (`scr_runtime.h` ~:6063), a single
  global pthread mutex, around a plain `memcpy`.
- **Why it's a bug:**
  - In the JS memory model, non-`Atomics` accesses to shared memory are unordered and may race. A mutex around them gives no
    ordering against other threads' plain accesses.
  - The data pointer is stable: shared buffers have a fixed length, with no detach and no realloc.
  - All workers that read published input contend on that one lock. Even uncontended, it is a call plus lock/unlock per element.
- **Fix (patch 50):** use the inline access for both cases. `Atomics.*` keep their runtime path. Saved 13.6 G, the largest
  single patch; an ablation of the whole split measured 12.8 G.
- **Edge case:** a spin loop on a plain shared read (`while (a[0] === 0) {}`) may be hoisted and never see the write. The JS
  spec makes no progress guarantee for that pattern either, and `Atomics.load` is unaffected.

### 4. Constants of modules in an import cycle are not constants
- **Symptom:** a module-level `const K = 3` is folded, unless its module is in an import cycle. Then it becomes a thread-local
  global plus a `K_x25_initialized` flag, and every use costs two thread-local lookups, including every `case K:` label of a
  `switch`. Repro: `a.ll` has `@sc_g_m0_K_CYCLIC` and `@sc_g_m0_K_CYCLIC_x25_initialized`.
- **Cost:** in formatc one switch-heavy function (`anSpan`) made 326 thread-local calls. 698 such constants existed.
- **Workaround:** `tools/codemod/leaf-consts.mjs` moves them into import-free modules. Saved 11.4 G.
- **Suggested fix:** fold literal-initialized `const`s regardless of cycles. Reading one before its initializer runs is the
  only observable difference, and it could stay a debug-build check. At the very least, don't make immutable values
  thread-local.

### 5. The `Int32` annotation on a local doesn't change its storage
- **Symptom:** a local annotated `Int32` produces the same IR as a plain `number` local: an `alloca double`. The contract only
  feeds the range analysis (`contracts/check.js`, `ir/int32-slots.js`), though the 0.2.10 changelog says proven `Int32`
  slots are stored as native integers.
- **Cost:** loop counters written `i = ((i | 0) + 1) | 0` keep a double phi with a float-convert chain of about 7 cycles per
  iteration. `for (...; i++)` with integer bounds already gets an integer counter.
- **Fix (patch 90):** run the existing prover per function and store accepted locals as `i32`. 11,100 of about 26,000 locals
  converted, saving 1.1 G. This is the least certain of our patches.

## Performance (correct today, but expensive)

### 6. One thread-local lookup per mention of a module global
- **Symptom:** every module-level binding is `thread_local` in worker mode. Accesses reference `@g` directly, so on Darwin
  every source-level mention is lowered to its own `_tlv_get_addr` call, and LLVM merges none of them. In the repro, `three()`
  mentions `state` twice and makes two calls.
- **Cost:** `_tlv_get_addr` was 11% of all samples in formatc. Source workarounds (`tools/codemod/hoist-globals.mjs`,
  `outslots.mjs`) saved 6 G and are clumsy.
- **Fix (patch 70):**
  - Put the program's 4,788 thread-locals into one `@scr_program_tls` struct, addressed by `llvm.threadlocal.address` at each
    use, so LLVM shares one lookup per function. This is the technique `alloc.js` already uses for `@scr_thread_hot`.
  - Static TLV calls went from 22,989 to 6,035, saving 5.7 G.
- **Tried, didn't help:**
  - Hoisting one lookup per global to function entry: +2%, from spills.
  - A pthread-TSD fast path: neutral.

### 7. A stack-overflow check in every function on a call-graph cycle
- **Symptom:** `dist/backend/may-throw.js` puts the stack guard in every function on a cycle.
- **Why it's more than needed:** a feedback vertex set is enough, i.e. one checked function per cycle. That set is the
  self-recursive functions plus the busiest hub of each remaining strongly connected component. Frames between checks are
  bounded by the acyclic stretch of the graph, far inside the 256 KB reserve.
- **Fix (patch 40):** check only that set. Saved 7.7 G (−5.8%). Fewer functions are also marked as possibly throwing, so
  callers do fewer exception checks. Mutual and self recursion still raise a catchable `RangeError`.

### 8. Termination polls in every loop of every worker program
- **Symptom:** loops that don't already poll get a cancellation budget (`emitter.js` `workerLoopBudget`, ~:3160–3195): a
  decrement, compare and branch per iteration, plus entry polls (`may-throw.js` `entryPolls`). This happens even when nothing
  in the program can request termination. Repro: `a.ll` contains `worker cancellation budget`.
- **Cost:** about 6 G in formatc. Polling less often doesn't help; the cost is the per-iteration decrement.
- **Fix (patch 60):** a whole-program check. If no source file mentions `terminate` or `unref`, emit no budgets and no entry
  polls; per-call exception checks are unchanged. Saved 5.9 G.
- **Edge case to handle upstream:** if the main thread dies of an uncaught error while a referenced worker spins forever,
  exit cleanup now waits for it instead of terminating it.

### 9. Retain/release when a typed array is bound to a local
- **Symptom:** `const a = this.arr` emits `scr_bytes_retain_v` plus a release at scope end; both are runtime calls.
- **Cost:** 2–3% of formatc's samples, mostly in short per-token functions. Aliasing an object costs nothing, but aliasing a
  typed array does, which makes local aliasing a pessimization in short functions.
- **Suggested fix:** borrow without a retain when the owner outlives the alias and is not reassigned in scope.
  `--optimization speed` (inline reference counting) made no measurable difference.

### 10. Immutable module data is re-created per thread
- **Symptom:** constant lookup tables (`const T = new Uint8Array([...])` that is never written) are thread-local in worker
  mode. Every thread rebuilds them and every access is a thread-local lookup. In formatc, a per-byte table read in the lexer
  cost one `_tlv_get_addr` per byte.
- **Suggested fix:** keep provably immutable module data process-global.

### 11. Smaller items
- **Byte search:**
  - `Uint8Array.prototype.indexOf` doesn't compile (`SC2020`).
  - `Buffer.prototype.indexOf` with a single byte is a byte-at-a-time loop in the runtime (`scr_bytes.c` ~:2572) rather
    than `memchr`.
  - Without them a program has no fast native byte search; hand-written byte loops cost ~20 instructions per byte in worker
    mode, or ~8 with patches 30 and 50.
- **Number unions:** `number | undefined` values are boxed (`scr_union_new_f64` / `scr_union_destroy`), 0.5% here.
- **Import cycles:** a module-level `const X = new C()` in a module inside an import cycle failed to build with SC1016 when
  `C` came from another module in the cycle (seen while converting `HAS_DASH`, `src/format/js/jsdoc/tag_formatters.ts`).
- **Worker entry:** `new Worker("./a.ts")` (the entry file by path) is unsupported (`SC2020`); only
  `new Worker(new URL(import.meta.url))` works.
- **Earlier findings:** listed in `docs/SCRIPTC_COOKBOOK.md` §13:
  - `publish()` of object graphs read corrupted data inside recursive functions with 2 or more workers.
  - A throwing worker leaves the main thread waiting unless it has `on("error")`.
  - `fs.openSync` has no mode argument, and `Stats` has no `mode`.
  - `spawnSync` lacks `cwd`, `input` and `env`.

## Checked and fine

- **Exception checks after calls:** already inline in worker mode. Each is one load of the process-wide alert word and a
  branch; `scr_exc_pending()` runs only on the cold path, and termination is observed through the alert word.
- **Stack-guard limit:** read inline from thread-specific data; there is no call on the fast path.

## Summary

| # | kind | fix | instructions saved (formatc, 1 thread) |
| - | - | - | - |
| 3 | bug: global mutex on shared views | patch 50 | 13.6 G |
| 4 | bug: cyclic-module consts not folded | codemod (compiler fix suggested) | 11.4 G |
| 7 | perf: stack guard everywhere on cycles | patch 40 | 7.7 G |
| 8 | perf: termination polls without `terminate` | patch 60 | 5.9 G |
| 6 | perf: TLV call per mention | patch 70 (+ codemods: 6 G) | 5.7 G |
| 2 | bug: inline DataView disabled for workers | patch 85 | 2.8 G |
| 1 | bug: `sanitize_address` in normal builds | patch 30 | 1.9 G (with invariant header loads) |
| 5 | bug: `Int32` locals stay double | patch 90 | 1.1 G |
| 9, 10 | perf: retain/release on aliases, per-thread immutable data | not patched | ~3 G, unknown |
