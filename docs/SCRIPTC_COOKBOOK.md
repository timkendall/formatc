# scriptc performance + compatibility cookbook

Measured on scriptc **0.3.0** (the installed release), Apple M5 Pro (18 cores), macOS, Node 24, release build
(`scriptc build x.ts -o x`). All numbers are best-of-N on the first 41 MB of the vscode corpus unless stated
(`scratch/cookbook/bench/make_corpus.sh`). "node" = `node x.ts` on the same source. Every claim below has a
benchmark in `scratch/cookbook/bench/` or `scratch/cookbook/threads/`; reference code is in `scratch/cookbook/lib/`.

**Rule zero: scriptc codegen is pattern based, not a general optimizer.** The same JS can be 10x apart depending on
spelling. Verify any hot function with the 30-second loop in section 0.2. Idioms that are fast today may change in a
new release (see 0.3).

## 0. Top rules (read this, then the sections)

| # | Do | Don't | Evidence |
|---|----|-------|----------|
| 1 | Read typed arrays as `x[i] \| 0` (or `x[i]!`) whenever the value is stored, pushed, passed or assigned | `o[i] = src[i]`, `arr.push(src[i])`, `obj.f = src[i]`, `const c: number = src[i]` | 4.9 ns/byte (206 MB/s) vs 0.38 ns (2634 MB/s) |
| 2 | Store only `\| 0`-ed values into typed arrays (`d[n] = v \| 0`, `d[n] = i \| 0`) | `d[n] = i` with a bare number/loop var | 2.63 ns vs 0.44 ns |
| 3 | Int accumulators/counters: `s = ((s \| 0) + (x \| 0)) \| 0`, `n = ((n \| 0) + 1) \| 0` | `s = (s + x) \| 0`, `n = (n + 1) \| 0`, `n++` | 2112 MB/s vs 287 MB/s (counter: 2121 / 298 / 858) |
| 4 | Plain `s += x` is fine when no int32 wrap is needed (sum of bytes etc.) | `Int32` contract types (no gain in 0.3.0) | 1770 MB/s (node 1855) |
| 5 | Copy `this.src`, `this.pos`, `this.end` (and module-level `let` state) into locals at function entry; write back once | `this.src[this.pos]` / `this.src.length` / `gpos++` inside loops | 2104 vs 345 MB/s (fields); 615 vs 275 MB/s (module `let`) |
| 6 | Loop `for (let i = 0; i < a.length; i++)` for `number[]`; `const n = s.length` for `string` and typed arrays | `const n = a.length; i < n` on `number[]`; `i < s.length` on strings | 0.62 vs 2.9 ns (arrays); 0.5 vs 2.7 ns (ASCII strings) |
| 7 | Class dispatch tables as 256-entry `Uint8Array` lookups | big `switch` for byte classification | 2272 vs 450-770 MB/s (switch) |
| 8 | Work on bytes (`Buffer`/`Uint8Array`), intern identifiers via byte hash | strings in hot paths (`charCodeAt`, `slice`, `===`, `Map<string>` + `slice`) | 0.38 ns/byte vs 1.9-3.4 ns/char; slice 4-11 ns, slice===lit 8-13 ns |
| 9 | AST nodes: `implements ProgramLifetime` classes with a **concrete `kind` field in the base class**, or SoA Int32Array arenas | `abstract readonly kind` overridden in subclasses (**134 ns/read**), reading data fields through an *interface* type (26 ns) | section 4 |
| 10 | Parallelism: N child processes (`fork`) or Workers with atomically-claimed file indices; N = 12-18 | `SharedArrayBuffer`-backed typed arrays in hot loops inside a worker-enabled program (10-20x slower, global lock) | section 7 |
| 11 | Avoid closures/callbacks in hot paths (2.3-3 ns/call incl. runtime this-push/pop) | `forEach`/`map`/`filter` in tight loops | section 5 |
| 12 | Throw freely for rare errors (7-42 ns); `try` on the hot path costs nothing | — | section 5 |

### 0.1 How to see what the compiler did
- `scriptc build x.ts -o out/x` leaves `out/<entry>.ll` (pre-optimization LLVM IR). `--emit=asm -o x.s` gives final
  arm64 asm (small functions are inlined into callers; look for the loop body).
- Red flags in a hot loop's asm: `scvtf`/`fcvtzs` pairs (double round trip of an int), `fcmp`+`fccmp` before a byte load
  (index is a double needing an integer check), `bl _scr_...` calls, `_scr_bytes_get_or_nan`, `scr_dyn_this_push`.
- Red flags in the IR: `alloca double` for variables that should be ints with only `integer view`/`integer induction`
  shadows, `bytes_idxOr` + `scr_union_release` (the boxed-undefined path of rule 1), `uint32.coerce.slow` blocks.
- `SCRIPTC_TIMING=1 scriptc build ...` prints per-phase compile times.

### 0.2 Micro-benchmark harness (copy this)
```ts
function bench(name: string, f: () => number, bytes: number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < 5; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(28), (bytes / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s r=", r);   // print r so nothing is dead-code-eliminated
}
```
Compile and run it compiled AND with `node --experimental-transform-types --no-warnings x.ts` (plain `node x.ts` rejects
enums / `namespace` / parameter properties; scriptc accepts them).

### 0.3 Caveats that change the numbers
1. **Worker tax.** If the program imports `node:worker_threads` `Worker` (even if never spawned) *every* typed-array
   access gets a `bytes->shared` check and *every loop back-edge* a cancellation counter. The branchy lexer kernel drops
   550 -> 420-460 MB/s (-17..-24%); simple sum loops are unaffected. **Benchmark in the final configuration**
   (child processes avoid the tax entirely, section 7).
2. scriptc 0.3.0 keeps every number local as a `double` (plus i64 "integer induction" for canonical `for` loops and i32
   "integer views"). The vendored repo HEAD (`vendor/scriptc`, commit a4bb3ff, unreleased) contains `int32-locals.ts`
   (true i32 slots, `Int32`-contract aware); its own test source compiles to `alloca double` on 0.3.0. When a new
   release lands, re-run `bench/b1d_acc2.ts` / `b1e_cnt.ts` / `b2b_lexvars.ts`; idioms 1-3 stay correct but may become
   unnecessary and the `Int32` contract may start to pay off.
3. `--optimization speed` made **no measurable difference** (0-3% on lexer, objects, switch, libs) at the same build time.
   Not worth the larger binary; use default release.

## 1. Environment facts
- Executables are ~110-400 KB; process start+run of hello world ~2 ms (Node: 19 ms). Worker spawn ~40 us each.
- Strings are **UTF-8 internally** with a cached ASCII bit; UTF-16 semantics (`length`, `charCodeAt`, `[i]`) on
  non-ASCII strings need index translation (slow). Encode/decode (`TextEncoder`, `Buffer.from(str)`, `buf.toString()`)
  are memcpy-class (8-60 GB/s). So: decode input once if you must, but parse bytes.
- Typed arrays are heap objects `{rc, len, elem, data*, backing, ...}`: every `a[i]` is `a->data[i]` with a bounds check
  (cheap and predictable). Reference counts are **non-atomic** (per-thread heap); published objects are immortal.
- Deep recursion: catchable `RangeError`; main thread handles ~200k frames of a trivial function (Node: ~10k).
  Cost ~0.85 ns/frame shallow, 5-7 ns/frame at depth 100-1000 (return-stack effects; Node identical).
- `os.availableParallelism()` works (18); `os.cpus()` does not compile.

## 2. Hot loops

### 2.1 Template (verified: 613 MB/s vs Node 802 MB/s vs C -O2 744 MB/s on a JS/TS lexer)
`scratch/cookbook/lib/lexer_template.ts` (pull lexer `next()` returning a kind, token in `tokStart/tokEnd` fields):
```ts
next(): number {
  const src = this.src;            // (1) fields -> locals
  const n = this.end;
  let pos = this.pos | 0;
  while (pos < n) {
    const c = src[pos] | 0;        // (3) every element read is `| 0`
    const k = CT[c] | 0;           // (4) class table, not a switch
    if (k === 1) { pos = ((pos | 0) + 1) | 0; continue; }   // (2) i32 cursor math
    ...
    this.tokStart = start; this.tokEnd = pos; this.pos = pos;   // write back once
    return kind;
  }
  this.pos = pos; return T_EOF;
}
```
Same algorithm, naive port (`this.pos++`, `this.src[this.pos]` in loops, no `|0`): **345 MB/s** (Node 567). Free-function
variants (`bench/b2b_lexvars.ts`): `pos++` 300, `pos=(pos+1)|0` 550-600, `Int32` annotations 540-600 (no gain),
class fields 283, module-level state 315, helper functions 318 (all in plain-number style).

### 2.2 Integer arithmetic table (`bench/b1b_acc.ts`, `b1c_bit.ts`, `b1d_acc2.ts`, `b1e_cnt.ts`; MB/s, node in parens)
| kernel | scriptc | node |
|---|---|---|
| `s += buf[i]` (double accumulate) | 1770 | 1855 |
| `s = (s + buf[i]) \| 0` | 287 | 1713 |
| `s = ((s\|0) + buf[i]) \| 0` | 285 | 2534 |
| `s = (s + (buf[i]\|0)) \| 0` | 343 | 2489 |
| `s = ((s\|0) + (buf[i]\|0)) \| 0` | **2112** | 2545 |
| `... & 0xffff` (all operands `\|0`) | 2105 | 1913 |
| 4 independent accumulators, unrolled | 2910 | 2231 |
| xor / shift / `Math.imul` only (FNV) | 33444 (vectorized) / 2131 / 1073 | 2351 / 2121 / 1044 |
| `((h<<5)+h+b)\|0` (djb) | 248 | 252 |
| `while (i<n){ s+=b[i]; i=(i+1)\|0 }` | 1627 | 2022 |
| `while (i<n)` with `i: Int32`, `s += b[i]` | 349 | 2077 |
| class-field accumulator `a.s += b[i]` | 431 | 1704 |
| count with `n++` / `n=(n+1)\|0` / `n=((n\|0)+1)\|0` | 858 / 298 / 2121 | 1631 / 1676 / 1523 |

Why: `(s + x) | 0` where `x` is a double-typed read makes a double add + an overflow-checked range coercion
(`uint32.coerce.slow` blocks) and the accumulator is carried as a double (`scvtf`/`fcvtzs` ~8 cycles per iteration).
When every operand is an explicit `| 0` int32 expression the add is a real i32 add. Bitwise-only chains are already
int-typed.

Caveats found by measurement (don't "optimize" these blindly):
- **Class fields**: keep counters/lengths plain doubles (`this.len = n + 1`). Adding `| 0` to field math made
  `ByteBuf.push` 3x slower (1.1 -> 3.5 ns).
- Passing an induction variable or number param to a function that stores it into a typed array needs `| 0` at the store.
- `Int32` contract annotations: accepted and checked (SC7002 tells you which expression needs `| 0`) but gave **no speedup**
  in 0.3.0 and sometimes slower (`i: Int32` while loop 349 vs 1627 MB/s). Skip them until the i32-slot release.

### 2.3 Loop forms (all fine unless noted; ns/element, 20M elements)
- `for (let i = 0; i < a.length; i++)` on typed arrays / bytes -> i64 induction + elided checks (best).
- `for (let i = lo; i < hi; i++)`, `i--` reverse loops, `while` with `i=(i+1)|0`: same speed as canonical.
- `number[]`: limit must be `i < a.length` literally (0.62 ns) — `const n = a.length; i < n` is **2.9 ns**.
- `for (const v of arr)` over `number[]`: 0.59 ns. `arr.forEach(cb)` 2.75 ns, `map` 3.2, `reduce` 0.63, `filter` 7.3.
- strings: `const n = s.length; for (i < n) s.charCodeAt(i)` 0.5 ns (ASCII) / 1.9 ns (non-ASCII); `i < s.length` 2.7-3.4 ns.

### 2.4 Dispatch (`bench/b31_switch.ts`, classify every byte into 17 classes, MB/s; node in parens)
256-entry `Uint8Array` lookup 2272 (2291) · switch inline 770 (562) · if-chain 747 (508) · switch in a helper fn 450 (582).
A `switch` on small ints is not a jump-table win here; use tables for byte classes, switch for rare dispatch.
`enum`, `const enum`, module `const`, `static readonly`, `as const` objects all compile to the same code as literals
(`bench/b35_consts.ts`).

## 3. Byte access, buffers, vectors
Per-element access (local `Uint8Array`, `((s|0)+(b[i]|0))|0`, MB/s): local param 2123 · module `const` 2124 · module
`let` 2107 · `Buffer[i]` 2116 · `Buffer.readUInt8` 2139 · `DataView.getUint8` 2112 (Node: 794 / 3179) · class field **345**
(copy to a local!). `Uint32Array`/`Int32Array` 8.4-8.6 GB/s, `Uint16Array` 4.2 GB/s, `DataView.getUint32(i,true)` 8.4 GB/s.

Bulk ops (ns fixed cost + memcpy): `subarray()` alloc 9.5 ns (Node 21) · `dst.set(src.subarray(a,b), n)` ~11 ns ·
`Buffer.copy(dst, n, a, b)` **6 ns** (no view allocation) · `copyWithin` 3.5 ns (same buffer only) · `fill(b, s, e)` 5 ns ·
byte loop 0.63 ns/byte (1.5 GB/s). Crossover: loop below ~8 bytes, `Buffer.copy` above.
`new Uint8Array(n)` is zero-filled lazily (20M-int array alloc 0.4 ms); growth = allocate + `copy`/`set`.

### 3.1 ByteBuf (`lib/bytebuf.ts`) — append-only output buffer
`push` 0.94 ns (1.06 GB/s; 1.6 GB/s if you hoist `data`/`len` into locals around a tight loop), `append(src,a,b)`:
run=4 3.8 ns, 16 7.2 ns, 64 7.6 ns, 256 10.3 ns (24 GB/s), 4096 86 ns (48 GB/s); `appendAscii("function ")` 8.6 ns.
Use `Buffer` as the element type so `Buffer.copy` is available; `view()` returns a `subarray`.
```ts
const out = new ByteBuf(1 << 20);
out.appendAscii("function "); out.append(src, start, end); out.push(10);
fs.writeSync(1, out.data, 0, out.len);
```
### 3.2 I32Vec (`lib/i32vec.ts`)
Growable Int32 vector; `push` 2.7 ns through the method (0.53 ns when the push loop is inlined by hand with local
`d`/`n`). For per-token tables prefer fixed worst-case sizing (`new Int32Array(srcLen + 1)`) — there are at most
`srcLen` tokens, so no growth check is needed.
### 3.3 SoA tables and arenas (`lib/ast_arena.ts`)
Node = index; fields = parallel `Int32Array` columns (`kind,start,end,first,next,data`). `add + link + walk` 10M nodes:
**8 ns/node** vs 19 ns for linked class instances (Node 30). Pre-size columns from source length to skip growth.
### 3.4 Hash tables
`Map<number,number>` get 1.0 ns, set 1.85 ns (small) / 6.4 ns (growing to 2.5M); `Map<string,number>` get 2.45 ns (hash is
cached in the string header), set 5.35 ns; `Set<number>.has` 3.2 ns. Native maps are fine. Hand-rolled open addressing:
`lib/hashtable.ts` `IntMap` (3 ns through methods, 0.66 ns inlined), `Uint8Array` presence table 0.28 ns.
**`lib/intern.ts` `Interner`**: bytes -> dense id with no string creation, 8.1 ns/ident (avg 7 bytes) vs `Map<string>` +
`slice` 11.4 ns. Keyword test `eqAscii(src, i, "function")` 2.4 ns (`lib/bytes.ts`).

## 4. Functions, classes, objects

### 4.1 Calls (`bench/b4_calls.ts`, ns/call in a hot loop)
Small top-level functions, methods, static methods, cross-module functions, `NoThrow<T>`-annotated functions: **all
inlined**, 0.47 ns (loop floor); `NoThrow` made no measurable difference. Not inlined (large body, recursion): normal
call + stack-guard (2 loads+cmp) + exception-flag check ~1-2 ns. **Closure call 2.3 ns** (+ `scr_dyn_this_push/pop`),
create-closure-and-call 3 ns, virtual call over 2 impls 1.5 ns, recursion see section 1.
Passing the *same object* through a non-inlined call in a loop costs ~2.6 ns (retain/release read-modify-write chain on the
object's refcount); different objects each iteration (AST walking) don't pay this serialization.

### 4.2 Allocation (`bench/b36_pl.ts`, 4M-node binary tree, build+drop, ns/node)
| | scriptc | node |
|---|---|---|
| plain classes | 3.8 | 13.8 |
| `implements ProgramLifetime` (never freed, no RC) | **1.8-3.2** | |
| `implements Acyclic` | 3.7 | |
Standalone `new P(x,y)` temp in a loop 7.8 ns (Node escape-analyzes to 0.6 ns — avoid allocating short-lived objects in
inner loops; use locals / typed arrays); `new` + `push` into an array 14 ns (12 with ProgramLifetime); array literal `[a,b,c]`
10.7 ns (Node 0.6). `ProgramLifetime` is the right marker for AST nodes (checked: root of its hierarchy, executables only).

### 4.3 **Field-access cliffs** (`bench/b34_fieldaccess.ts`, ns per `xs[i].kind` read over 2 subclasses; node ~0.7 for all)
| pattern | ns |
|---|---|
| base class declares `kind: number`, subclass ctors call `super(k)` | **0.86** |
| base declares `kind`, subclasses `override kind = k` | 0.86 |
| abstract getter `get kind()` / abstract method `kind()` | 1.1 |
| **`abstract readonly kind: number;` + subclasses declare `readonly kind = 0`** | **134.5** |
| field read through an *interface* type implemented by classes | **25.8** |
| union of unrelated classes with literal `kind` (`readonly kind = 0` in each) | 9.7 |
| interface-typed object literals / records | 0.6 |
Rules: put discriminant/data fields in a concrete base class; read data fields only via class-typed (not interface-typed)
receivers; use interface *methods* if you need interface dispatch. The 134 ns case is the common
`abstract readonly kind` TypeScript AST style — don't port it literally.

After fixing the discriminant, class ASTs are fast (`bench/b32_ast.ts`, 4M nodes, ns/node): eval via virtual method 0.87,
`switch(kind)` + `as` cast 2.9, `instanceof` chain 2.9, union-of-classes narrowing 3.5, SoA 2.9; build: class tree 3-5,
SoA 2.6. (Node: 2.6 / 4.4 / 5.0 / 4.0 / 3.7; build 33-50.) `as Sub` casts between program classes are runtime-checked
(a wrong cast throws `TypeError: Value is not an instance of 'X'` — it caught a real bug in one of my benchmarks).

## 5. Arrays, strings, closures, exceptions (ns/op; node in parens)
**Arrays** (`b6`, `b38`): `number[]` push 3.15 (4.06) · index read 0.59 · push/pop 4.2 · `Int32Array` hand-grown push loop 0.53 ·
sort 1M `number[]` with comparator 104/elt (143), `P[]` 133 · `TypedArray.sort()` **unsupported** (SC2020) · object stack
push/pop 5.1.

**Strings** (`b7`, `b7b`; utf8 corpus / ASCII-only): `charCodeAt` 1.9 (n hoisted) / 0.5 · `s[i]` 7.1 / 3.9 · `slice(i,i+8)`
11.2 / 4.3 · `slice(i,i+3) === "fun"` 12.9 / 8.1 · `startsWith(lit,i)` 6.1 · `s += "ab"` 4.4 (node 15.0!) · `s +=
String.fromCharCode(c)` 5.2 · template literal with 2 numbers 18 (8.6) · `String.fromCharCode` 2.1 · `[...].join("")` 8.2 ·
`Map<string,number>.get(s.slice(a,b))` 14.7 · equal 20k-char strings `===` 354 (memcmp; Node same-pointer 0.7) ·
`TextDecoder.decode` 41 MB 4.6 ms · `Buffer.toString("utf8")` 3.7 ms · `TextEncoder.encode(str)` ~0.8 ms (memcpy) ·
`str.split("\n")` 0.61/elt · `str.indexOf("function")` 0.16 ns/char. **Conclusion confirmed**: bytes are 5-30x faster
than strings per character; string *building* (`+=`) is actually good, `charCodeAt`/indexing on non-ASCII text is not.

**Closures** (`b9`): create+call (capture) 3.2, (no capture) 2.9; call stored closure 2.6; mutating capture 2.6.

**Exceptions** (`b10`): `try/catch` and `try/finally` inside a hot loop with no throw: no measurable cost. `throw new
Error()`+catch **42** (Node 1023), `throw 5` 7.1 (38), `throw new ParseError(i)` 9.4 (41), unwind through 50 frames 300 (1855).
Not needed (NoThrow): measured no difference.

## 6. File I/O (`bench/b20_io.ts`, `b21_walk.ts`, `b22_write.ts`; 18,080 files, 238 MB, warm page cache)
| approach (single thread) | ms | MB/s |
|---|---|---|
| `fs.readFileSync(path)` -> Buffer | 253 (cold cache first run: 1711) | 941 |
| `openSync + fstatSync + readSync` into reused Buffer + `closeSync` | 232 | 1027 |
| `openSync + readSync(8 MB buf) + closeSync` (no fstat) | 225 | 1061 |
| `readFileSync(path, "utf8")` | 271 | 878 |
| `statSync` only | 26 | — |
~13 us per file, syscall-bound (open+read+close); Node is identical (232-253 ms). Reuse one scratch buffer (grow
x2 when `size > scratch.length`). Directory walk: `readdirSync(dir, {withFileTypes:true})` 61 ms for 20,378 files
(readdir + statSync: 93 ms). Writing: `process.stdout.write(buf)` and `fs.writeSync(1, buf, off, len)` are equivalent
(41 MB to a pipe: 5 ms); `fs.writeSync(1, bigString)` of a 41 MB string 13 ms. **Creating/overwriting files costs ~70 us each**
on APFS (18,000 x 13 KB: 1.25 s, parallelizable) — skip writes when the output equals the input.
In parallel the read floor is ~116 ms for the whole corpus (2 GB/s) no matter how many threads (>= 8).
Worker/child startup is not an issue (< 1 ms for 18 workers, ~4 ms per child process).
The paths file contains spaces — never `xargs` it; split on `\n`.

## 7. Parallelism (`scratch/cookbook/threads/`)

### 7.1 Capabilities (all verified)
- `node:worker_threads` `Worker`, `workerData`, `postMessage`, `parentPort.on("message")`, separate worker file via
  `new URL("./w.ts", import.meta.url)` or the same file (`new URL(import.meta.url)` + `isMainThread`). Workers are
  native threads; **module-level state is per-worker** (`t5_state.ts`: main=100, workers 1/2/3, independent).
- `SharedArrayBuffer`, `Atomics.add/load/store/exchange/compareExchange/wait/notify` on Int32Array work (main thread may
  `Atomics.wait`). Contended `Atomics.add`: ~35 ns (Node 17). `Atomics.waitAsync`, BigInt atomics unsupported.
- `publish(value)` from `@scriptc/threads` shares immutable graphs (arrays, strings, class instances, Maps) by reference:
  publishing + sending an 18,080-string path list: **1.3 ms**; workers read it with no copy. Typed arrays and
  SharedArrayBuffers cannot be published (`TypeError: Cannot publish this value`) — publish only the plain-data part and
  send SABs as separate fields (do not `publish()` the whole job object).
- `postMessage` round trip 8.9 us (Node 7.7); 18,080 per-file result messages cost nothing measurable.
- Worker errors surface as the `error` event then `exit(1)`; `os.availableParallelism()` = 18.
- Child processes: `child_process.fork(fileURLToPath(new URL("./child.ts", import.meta.url)), args, { silent: true })`;
  the child **cannot use `process.send`** (SC2020) — report via stdout (one JSON line) and read `c.stdout.on("data")`.
  `exit` event fires after; ~4 ms startup per child.

### 7.2 The big pitfalls
1. **SharedArrayBuffer-backed typed arrays are slow inside worker-enabled programs**: every element access takes a global
   runtime lock (`scr_bytes_get_or_nan`). `lexKernel` over a SAB view: 99 MB/s with 1 worker, **5 MB/s per worker with 4**
   (total *worse*); sum loop 172 MB/s (vs 2000 private). Copy into a private array first (`new Uint8Array(sabView)` = memcpy,
   `priv.set(shared)` 66 GB/s) -> 451 MB/s per worker and no contention. Use SABs only for control words
   (`Atomics`) and result slots. Read-heavy shared data should be `publish()`ed plain data, not SAB bytes.
2. **Worker tax** (0.3): see 0.3. Child processes have none.
3. Published objects are immortal (never freed) and writes throw; plan memory accordingly.
4. Don't put the whole job record through `publish()` if it contains SABs.

### 7.3 Prototype 1: workers + atomic claiming (`t3_distribute.ts`, `t4_publish.ts`)
Main: read the path list, `publish(paths)` (string[]), create `ctrl = new SharedArrayBuffer(64)`, spawn N `Worker`s
with `{ paths, ctrl, ... }`, `Atomics.wait` (or message events) until `ctrl[1] == N`. Worker:
```ts
const ctrl = new Int32Array(job.ctrl);
while (true) {
  const idx = Atomics.add(ctrl, 0, 1);            // or claim a chunk of 16
  if (idx >= paths.length) break;
  const fd = fs.openSync(ROOT + paths[idx], "r");
  const size = fs.fstatSync(fd).size;
  if (size > scratch.length) scratch = Buffer.alloc(size * 2);   // private scratch, never a SAB view
  let got = 0; while (got < size) { const n = fs.readSync(fd, scratch, got, size - got, got); if (n <= 0) break; got += n; }
  fs.closeSync(fd);
  tokens += lexKernel(scratch, got, tokOut);      // the real work
}
parentPort.postMessage({ idx: -1, bytes, tokens });   // totals once at the end
```
Results (read 238 MB + lex 34.4M tokens, wall incl. setup; best of 3; `t3_distribute <N> sab atomic 16`):
| threads | 1 | 2 | 4 | 6 | 8 | 12 | 16 | 18 |
|---|---|---|---|---|---|---|---|---|
| MB/s | 304 | 541 | 952 | 1222 | 1308-1357 | 1589 | 1674 | **1750-1810** |
| wall ms | 801 | 448 | 258 | 204 | 184-192 | 159 | 151 | **140** |
Static strided partition (`idx += N`) performs identically (1725 vs 1753 MB/s @18) — the file set is large enough that
balance is not an issue; atomic claiming with chunk=16 is marginally best (1809). 24/36 threads: no further gain (1830).
Read-only (no lex): 1 thread 805 MB/s, 4: 1784, 18: **2053** (floor ~116 ms) — I/O is the ceiling at >= 12 threads for
this cheap kernel; a heavier formatting kernel will scale further. Dropping `fstat` doesn't help. Setup: 1.3 ms with
`publish(paths)` vs 8.6 ms building a SAB blob with byte loops (and the SAB path array is slow per-access, pitfall 1).
Under Node the same source works (`node t3_distribute.ts 8 sab atomic 16` -> 925 MB/s).

### 7.4 Prototype 2: child processes (`t8_fork.ts` + `t8_child.ts`) — recommended for pure file-sharding
Strided shard `idx = id; idx < n; idx += N` inside each child (child re-reads the list, 1 ms), one JSON line to stdout:
| procs | 1 | 4 | 8 | 12 | 18 |
|---|---|---|---|---|---|
| MB/s | 328 | 1106 | 1398 | 1590 | **1770-1786** |
No worker tax (1 proc: 720 ms vs 800 ms for 1 worker), no SAB/publish constraints, no shared state; identical to workers at
12+. Choose Workers only when you need shared published graphs, dynamic load balancing or low-latency messaging.

### 7.5 Recommended end-to-end design
1. Main: `readFileSync(list)` -> split on `\n` -> shard by size if available (largest first) or stride.
2. N = `min(os.availableParallelism(), files)` children (or workers), each: per-thread scratch `Buffer` (grow x2),
   per-thread `ByteBuf` output, per-thread tables (module state is per thread).
3. Write results in place (skip unchanged files) or buffer into one `ByteBuf` and `fs.writeSync(1, ...)` once.
4. Report via exit code + one stdout line per child (or `postMessage` totals); never per-token messages.

## 8. Compile-ability (tested: 132 snippets in `scratch/cookbook/compat/`, `./run_all.sh`, `./run_multi.sh`)
Compared against `node --experimental-transform-types`. **Work and match Node**: enums (numeric/string/`const enum`),
optional chaining/`??` on classes and arrays, array/object destructuring (params, defaults, swap `[a[i],a[j]]=[a[j],a[i]]`),
spread (array/call/object), getters/setters (instance), abstract classes, interfaces with methods (+ `implements`),
`instanceof`, labeled break/continue/blocks, BigInt, regex literals/`exec`/`test`/`replace`/unicode props, generic
functions & classes (`Stack<T>`, `Reg<V>`, `Box<T>`), discriminated unions (string and number literal `kind`), unions of
classes with `instanceof`/kind narrowing, `T | null` linked lists, tuples, `static`/`#private`/`private`/parameter
properties/`readonly`/static blocks, `namespace`, `switch` (string, fallthrough, grouped cases, large), `for in/of`
(array/string/Map/Set/entries), generators, `async/await`, top-level await, closures in loops, default/rest params,
`satisfies`/`as const`, tagged templates, `Record<K,V>`/index signatures, `Object.keys/values/entries`, `delete`, overloads,
mutual recursion, string methods, `JSON`, `new Array<number>(n).fill(0)`, `Uint8Array.from/set/subarray`, `Buffer`,
`TextEncoder/Decoder`, `Map`/`Set`/`WeakMap`, custom `Error` subclasses, `try/finally` with return, `Partial/Readonly/Pick`,
function tables (`((a,b)=>number)[]`), mixins, `super`, polymorphic arrays of interface-typed objects,
**cyclic module imports (functions and classes), `export *`, `export { x as y }`, default re-export, `import type`,
namespace imports, module-level mutable state** (all multi-file tests match Node, including evaluation order).

**Fail to compile (diagnostic, rewrite):**
| construct | code / message | rewrite |
|---|---|---|
| generic over typed arrays / constrained `T` property read: `function f<T extends Uint8Array\|Int32Array>(a: T)` `a[i]`, `T extends {length:number}` `x.length` | SC1090 "reading 'length' from a value of type 'T' / element access on non-array values ... (instantiating ... with <string>)" | write one function per concrete type (or take `Uint8Array` only); generics over *unconstrained* T work |
| `static get K()` accessors | SC1090 static accessors | `static readonly K = 7` |
| generator method `*[Symbol.iterator]()` in a class used with `for..of` | SC1090 "for-of over this [Symbol.iterator] shape" | give the class `next()`/array accessor, or return an array |
| `f() === undefined` where `f(): void` | SC1043 "comparing non-number, non-string values" | don't compare a void call; return a value |
| compound assignment `s += h.m(x)` where `h` is interface-typed array element (bug, section 10) | SC1043 | `s = s + h.m(x)` |
| `new Array(3).fill(0)` | SC2009 `any[]` element type | `new Array<number>(3).fill(0)` |
| `(f as any).prop = 1` (function props), `eval`, `Proxy` with non-plain handler | SC1090 / SC2020 / runtime throw | avoid |
| `process.exit` / `n.toFixed` used as a *value* (`typeof process.exit`, `x?.toFixed`) | SC1090 "methods as values" | call directly |
| `console.log(uint8array)`; object literal with method in template string | SC1090 / SC2001 | print `Array.from(a)` / explicit fields |
| `TypedArray.prototype.sort`, `process.send`, `os.cpus` | SC2020 / SC0001 | `Array.sort(cmp)` on `number[]`; stdout for IPC; `os.availableParallelism()` |
| functions with > ~2000-3000 straight-line branches | SC0001 "containing function ... too large for control flow analysis" (TS limit) | split the function |
Behaviors that differ from Node: `console.log(a, a.reverse())` prints `a` as it was when evaluated (Node prints the
mutated array twice); `Object.isFrozen(Object.freeze({}))` throws "no lowering" at *runtime*; program-class casts
(`x as Sub`) are verified at runtime; `Int32` contract violations are compile errors (SC7002, hint tells where to put `| 0`).
Literal tables: a 50,000-element `new Uint16Array([...])` literal costs ~3 s of build time (runtime free); prefer
generating large tables at startup (a loop: 0.16 s build).

## 9. Build times (`scratch/cookbook/buildtime/`, 500 functions x (20-case switch + class) = 16,000 lines)
| scenario | time |
|---|---|
| cold, release, single file | **7.8 s** (frontend 0.4, lower 2.0, llvm-emit 3.6, clang -O2 1.7) |
| cold, `--optimization speed` | 7.8 s |
| cold, `--optimization dev` (-O0) | 7.3 s (exe runs correctly; 1.9 MB) |
| same source split into 50 modules | 7.8 s |
| unchanged rebuild (cache hit) | **0.12 s** |
| edit one module, rebuild (release) | **6.1-7.8 s** — whole-program; no per-module incrementality |
| edit one module, rebuild (dev; cached LLVM shards) | 6.5 s (only native-object drops to 0.3 s) |
| 3000-case `switch`, one function | 0.33 s |
Expect ~0.4-0.5 ms per source line cold, dominated by IR emission, so a 25k-line formatter will be ~10-12 s per build.
Keep unit/benchmark entry points small (each compiles only what it imports: the lexer template bench builds in 0.25 s cold, the thread prototype in 0.33 s).
Use `SCRIPTC_CACHE_DIR=/tmp/...` to isolate caches in parallel agents.

## 10. scriptc bugs / sharp edges found (minimal repros)
1. **ICE SC9001** `bare unitLit 'null' outside a unionWrap`:
   `class A { f(): number { return 1; } }  console.log((null as A | null)?.f());`
2. **SC1043 on compound assignment through interface dispatch** (`s = s + h.handle(5)` compiles):
   ```ts
   interface H { handle(n: number): number }
   class A implements H { handle(n: number): number { return n + 1; } }
   const hs: H[] = [new A()]; let s = 0;
   for (const h of hs) s += h.handle(5);   // error SC1043: comparing non-number, non-string values
   ```
3. **Perf cliff, not an error**: `abstract class N { abstract readonly kind: number } class A extends N { readonly kind = 0 }`
   then `n.kind` on a `N`-typed value costs 134 ns (property-bag lookup instead of a field offset); same for fields read
   through an interface type (26 ns). Repro: `bench/b34_fieldaccess.ts`.
4. **Perf cliff**: `o[i] = src[i]` / `arr.push(src[i])` / `obj.f = src[i]` (bare typed-array read stored) goes through a boxed
   `number | undefined` union (`bytes_idxOr` + `scr_union_release`): 25x slower than `src[i] | 0`. Repro `bench/b13c_bare.ts`.
5. **Perf cliff**: storing a bare `number` (loop variable, parameter) into an `Int32Array` (`d[n] = i`) takes the
   `uint32.coerce` slow path: 6x slower than `d[n] = i | 0`. Repro `bench/b14b.ts`.
6. **Perf cliff**: SharedArrayBuffer-backed typed arrays in worker-enabled programs take a global lock per element
   (`threads/t6_sab_cost.ts` single thread fine; `t7_sab_contend.ts`: 1 worker 99 MB/s, 4 workers 5 MB/s each).
7. **Worker-enabled programs get a codegen tax** (shared check on every typed-array access + cancellation counter on every
   loop edge): -17..-24% on branchy byte loops (`threads/t9_tax_a.ts` vs `t9_tax_b.ts`, differ only by an unused `Worker`).
8. `console.log(a, a.reverse())` argument snapshotting differs from Node (minor).
9. Unsupported-at-runtime instead of compile-time: `Object.isFrozen`, non-plain `Proxy` (throw "has no lowering" /
   "not supported" when executed).
10. The released 0.3.0 compiler lacks the i32 local slots present in the vendored HEAD (see 0.3).

## 11. File index
- `scratch/cookbook/lib/` — `bytebuf.ts`, `i32vec.ts`, `intern.ts`, `hashtable.ts`, `ast_arena.ts`, `bytes.ts`
  (`eqAscii`, `CC` char-class table), `lexer_template.ts` (hot-loop template), `selftest.ts` (identical output under Node and compiled).
- `scratch/cookbook/bench/` — every micro-benchmark cited (`b1*` loops/accumulators, `b2*` lexer variants, `b3` bytes, `b4` calls,
  `b5/b36/b32/b34` objects & field cliffs, `b6` arrays, `b7` strings, `b8` maps, `b9` closures, `b10` exceptions, `b12/b16/b17`
  buffers/copy, `b13*` bare-read cliff, `b20-22` file I/O, `b30` libs, `b31` switch, `b33` casts, `b35` consts, `b40` template).
- `scratch/cookbook/threads/` — `t1` startup, `t2` atomics, `t3_distribute` (workers + atomic claim), `t4_publish`
  (publish + postMessage modes), `t5_state`, `t6/t7` SAB cost, `t8_fork`/`t8_child` (processes), `t9` worker tax, `t10` ping-pong,
  `lexkernel.ts`.
- `scratch/cookbook/compat/` — 132 feature snippets + runners; `buildtime/` — generators for the build-time study.

## 12. Addendum (orchestrator): what "worker mode" changes in codegen (scriptc 0.3.0 source, `backend/llvm/emitter.ts`, `expr-bytes.ts`)
A program whose module graph uses `Worker` is compiled with `mod.workers === true`, which:
1. makes **every module-level global `thread_local`** (on macOS: no "executable TLS" fast path → access via the TLV
   descriptor), including module-level typed arrays, `let` state and closure globals → **never touch module-level state
   inside a hot loop; hoist it into locals at function entry** (rule 5 is twice as important in the final binary);
2. splits **every typed-array access** on `bytes->shared` (a load + expected-false branch, and an out-of-line
   `scr_bytes_get` call on the cold path — the call is opaque to LLVM, so it can also block hoisting/LICM of other loads);
3. adds a **cancellation budget** to loops whose test doesn't already poll (decrement + branch per iteration, a runtime
   poll every 64 iterations);
4. reads the stack-guard limit through thread-specific data on Darwin.
The vendored scriptc HEAD (unreleased) is still 0.3.0-numbered; we build with the released 0.3.0.

## 13. Addendum (driver agent findings)
- **Bug:** `publish()` of object graphs gave corrupted reads inside recursive functions with ≥ 2 workers. Publish only
  flat data (strings, numbers, flat arrays) and rebuild objects per worker.
- A worker that throws leaves the main thread waiting forever unless `worker.on("error")` exits the process.
- ≥ 8 threads walking directories contend in the kernel (open/getdirentries/lstat): walk in small rounds.
- scriptc `fs` lacks the `openSync` mode argument and `Stats.mode`; `spawnSync` lacks `cwd`, `input`, `env`.
- Floor measured with stub formatters on vscode `--check`: 545 ms @1 thread, 293 ms @8, 276 ms @18 (Bun, real formatting:
  2602 / 464 / 311). Walk+classify+options ≈ 75-100 ms, read+compare ≈ 135-170 ms @8.
