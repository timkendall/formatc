## Summary

We compile a 183k-line TypeScript program (a port of `bun fmt`, whole-program, `worker_threads` + `@scriptc/threads`) and profiled it on macOS arm64 against the Rust original. Nine code-generation costs account for about a third of all instructions it executes. All of them appear as soon as a program imports `Worker`. All are still present in **0.3.2** (checked today with the repro below). With local patches to `@scriptc/compiler`'s `dist/` (items 1–3 and 5–8, plus two smaller ones) the same source goes from **125.8 G to 83.0 G instructions** (−34%) and from 6.1 s to 4.0 s single-thread wall on our benchmark (18,080 files, 238 MB). Output stays byte-identical on all of them. We can share the patches (unified diffs against `dist/`, validated only on this program).

## Repro

`a.ts` and `b.ts` import each other and `a.ts` creates a `Worker`:

```ts
// a.ts
import { Worker } from "node:worker_threads";
import { helper, K_CYCLIC } from "./b.ts";
export const K_LEAF = 7;
const state = { n: 0, arr: new Int32Array(16) };
export function three(i: number): number { return state.arr[i & 15] + state.arr[(i + 1) & 15] + state.n; }
function rec(n: number): number { return n <= 0 ? 0 : 1 + rec(n - 1); }
export function sw(k: number): number { switch (k) { case K_CYCLIC: return 1; default: return 2; } }
const shared = new Uint8Array(1024);
export function scan(n: number): number { let s = 0; for (let i = 0; i < n; i++) s = (s + (shared[i] | 0)) | 0; return s; }
const dv = new DataView(new ArrayBuffer(16));
export function rd(): number { return dv.getUint32(0, true); }
if (process.argv.length > 99) new Worker(new URL(import.meta.url));
console.log(three(3) + rec(5) + sw(helper()) + scan(10) + rd());
```

```ts
// b.ts
import { K_LEAF } from "./a.ts";
export const K_CYCLIC = 3;
export function helper(): number { return K_LEAF; }
```

```sh
scriptc build a.ts --emit llvm -o a.ll      # 0.3.2, darwin-arm64
grep -c 'sanitize_address' a.ll              # 1   (item 1)
grep -c 'call.*@scr_dataview_get' a.ll       # 1   (item 2)
grep -c 'call.*@scr_bytes_\(get\|set\)' a.ll # 3   (item 3)
grep -o '@sc_g_m0_K_CYCLIC[a-z_0-9]*' a.ll | sort -u   # K_CYCLIC and K_CYCLIC_x25_initialized (item 4)
grep -c -i 'cancellation budget' a.ll        # 1   (item 6)
```

## Bugs

### 1. `sanitize_address` is on every function in normal builds
Without `--sanitize`, every emitted function carries `sanitize_address` (`dist/backend/llvm/emitter.js`, the function attribute groups). The attribute stops LLVM from speculating and hoisting loads, so loop-invariant loads such as a typed array's length and data pointer are reloaded every iteration. Fix we applied: emit it only for `--sanitize` builds (`uwtable` otherwise), and mark the `ScrBytes` header loads `!invariant.load`. −1.9 G instructions.

### 2. The inline `DataView`/`Buffer` number path is disabled in worker programs
`dist/backend/llvm/byte-numbers.js` returns the runtime fallback when `host.mod.workers` is set, so every `getUint32`/`setInt16`/`readUInt32LE`… is an out-of-line `scr_dataview_get`/`set` call, although the inline path (bounds check, align-1 load, byte swap) exists and is correct. Fix we applied: remove the guard (needs item 3 so shared and local views share the access path). −2.8 G.

### 3. Every shared typed-array access takes one process-wide mutex
In worker programs every element access is split on `bytes->shared` (`dist/backend/llvm/expr-bytes.js`). The shared path (a `SharedArrayBuffer` view, or bytes passed through `@scriptc/threads` `publish()`) calls `scr_bytes_get`/`scr_bytes_get_or_nan`/`scr_bytes_set`, which take `SCR_SHARED_GUARD`, one global pthread mutex, around a plain `memcpy`. In the JS memory model non-`Atomics` accesses to shared memory are unordered and may race, so the mutex gives no ordering against other threads' plain accesses; the data pointer and length of a shared buffer are fixed; and every worker reading published input contends on the same lock. Fix we applied: use the inline access on both paths (`Atomics.*` keep the runtime path). **−13.6 G, the largest single item.** Edge case: a spin loop on a plain shared read may be hoisted, which the spec allows and `Atomics.load` avoids.

### 4. Constants of modules in an import cycle are not constants
A module-level `const K = 3` is folded, unless its module is in an import cycle. Then it becomes a thread-local global plus a `K_x25_initialized` flag, and every use costs two thread-local lookups, including each `case K:` label of a `switch`. Our program had 698 such constants; one switch-heavy function made 326 thread-local calls. Workaround: a codemod that moves them into import-free modules, −11.4 G. Suggested fix: fold literal-initialized `const`s regardless of cycles (reading one before its initializer runs is the only observable difference), or at least don't make immutable values thread-local.

## Performance

### 5. A stack-overflow check in every function on a call-graph cycle
`dist/backend/may-throw.js` puts the stack guard in every function on a cycle. A feedback vertex set is enough: the self-recursive functions plus one hub per remaining strongly connected component; frames between checks are bounded by the acyclic stretch of the graph. Fix we applied: check only that set. −7.7 G (−5.8%), and fewer functions are marked as possibly throwing, so callers do fewer exception checks. Mutual and self recursion still raise a catchable `RangeError`.

### 6. Termination polls in every loop of every worker program
Loops get a cancellation budget (`emitter.js`, "worker cancellation budget": a decrement, compare and branch per iteration) plus entry polls, even when nothing in the program can request termination. Polling less often doesn't help; the cost is the per-iteration decrement, about 6 G here. Fix we applied: if no source file mentions `terminate` or `unref`, emit no budgets and no entry polls (per-call exception checks unchanged). −5.9 G. Edge case to handle upstream: a referenced worker spinning forever after the main thread dies of an uncaught error.

### 7. One thread-local lookup per mention of a module global
Every module-level binding is `thread_local` in worker mode, and on Darwin every source-level mention is lowered to its own `_tlv_get_addr` call; LLVM merges none of them (`three()` above mentions `state` twice and makes two calls). `_tlv_get_addr` was 11% of all samples in our profile. Fix we applied: put the program's thread-locals (4,788 here) into one `@scr_program_tls` struct addressed with `llvm.threadlocal.address` at each use, so LLVM shares one lookup per function, the technique `alloc.js` already uses for `@scr_thread_hot`. Static TLV calls 22,989 → 6,035, −5.7 G. Hoisting one lookup per global to function entry was +2% (spills); a pthread-TSD fast path was neutral.

### 8. Retain/release when a typed array is bound to a local
`const a = this.arr` emits `scr_bytes_retain_v` plus a release at scope end, both runtime calls; aliasing an object costs nothing. 2–3% of samples in short per-token functions. Fix we applied: extend the existing borrow analysis (`unwrittenAlias`, effect summaries) to typed arrays when the owner outlives the alias and is not reassigned in scope. Static retains 2,437 → 1,178, −1.6 G.

### 9. Immutable module data is re-created per thread
Constant lookup tables (`const T = new Uint8Array([...])`, never written) are thread-local in worker mode: every thread rebuilds them and every access is a thread-local lookup (one `_tlv_get_addr` per byte in our lexer's table-driven loop). Not patched. Suggested fix: keep provably immutable module data process-global.

### Smaller
- `Uint8Array.prototype.indexOf` doesn't compile (`SC2020`), and `Buffer.prototype.indexOf` with a single byte is a byte-at-a-time loop in the runtime rather than `memchr`, so a program has no fast native byte search.
- The 0.3.0 `Int32` contract on a local didn't change its storage (still `alloca double`). 0.3.1's "locals proven to stay within 32 bits are stored as 32-bit integers" covers this; thanks.

## Measured on our program (1 thread, instructions retired, 0.3.0 at the time of each measurement)

| # | item | fix | saved |
| - | - | - | - |
| 3 | shared views under a global mutex | inline access | 13.6 G |
| 4 | cyclic-module consts not folded | codemod (compiler fix suggested) | 11.4 G |
| 5 | stack guard on every cyclic function | feedback vertex set | 7.7 G |
| 6 | termination polls without `terminate` | whole-program check | 5.9 G |
| 7 | TLV call per global mention | one TLS block | 5.7 G |
| 2 | inline DataView disabled for workers | remove guard | 2.8 G |
| 1 | `sanitize_address` in normal builds | only with `--sanitize` | 1.9 G |
| 8 | retain/release on typed-array aliases | borrow | 1.6 G |

Environment: macOS (Darwin 27) arm64, M5 Pro, scriptc 0.3.0 CLI and `@scriptc/compiler` 0.3.0/0.3.2 from npm, LLVM pack 22.1.8.
