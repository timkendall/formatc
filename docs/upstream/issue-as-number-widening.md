Filed as https://github.com/vercel-labs/scriptc/issues/985 (2026-10-14).

## Summary

`arr[i] as number`, `stack.pop() as number` and a bare `arr[i]` passed as an argument are treated as possibly `undefined`; the `as number` cast does not narrow. The optional-binding fixpoint then carries `number | undefined` through loop-carried locals and return values into the parameters of every function they reach, and those functions get a union calling convention: `ptr` parameters, `scr_union_new_f64` boxing at every call site and `scr_union_destroy` after it. In our 183k-line program five such expressions in cold code (import sorting, cursor handling) boxed the parameters of eight of the hottest functions, 429 boxing call sites in all. Writing `| 0` at those five sites cut them to 121 and saved 3.7 G instructions (−4.2% of the whole run). Still reproduces on **0.3.2** (0.3.2 adds an `.i32` native clone, but the union ABI and the boxing remain).

## Repro

```ts
// c.ts
function hot(n: number): number { return (n * 2) | 0; }
export function cold(xs: number[]): number { let s = 0; for (let i = 0; i < xs.length; i++) s = (s + hot(xs[i] as number)) | 0; return s; }
export function main(): number { let t = 0; for (let i = 0; i < 1000; i++) t = (t + hot(i)) | 0; return t; }
console.log(cold([1, 2, 3]) + main());
```

```sh
scriptc build c.ts --emit llvm -o c.ll
grep -c 'scr_union_new_f64' c.ll      # 2 (0.3.0 and 0.3.2)
grep -E '^define .*hot' c.ll
```

0.3.2 output:

```
define internal double @sc_bf_hot(ptr %p_sc_l_n_0) #0 { ; hot
define internal double @sc_f_hot(ptr %p0) #0 {
define internal i32 @sc_f_hot_nativeNumber.i32(double %p_sc_l_n_0) #0 { ; hot.nativeNumber
define internal double @sc_f_hot_nativeNumber(double %p0) #0 {
```

`hot` is declared `(n: number)` and is only ever called with numbers. One `xs[i] as number` argument in `cold` gives it a `ptr` parameter; `main`'s calls go through the `_nativeNumber` clone, but any call site the fixpoint can't prove (here `cold`, and in a large program anything downstream of a loop-carried local or a returned value) boxes a double into a heap union per call. Replacing `xs[i] as number` with `xs[i] | 0` removes the union entirely.

## In our program

- Repro file: https://github.com/timkendall/formatc/blob/main/tools/scriptc-dev/repro/union.ts
- The workaround, `| 0` at the five cold sites that had widened eight hot callees (`exprTag`, `fmtExpr`, `parentOfExpr`, …): https://github.com/timkendall/formatc/commit/1d42d4d (`src/format/cursor.ts`, `src/format/js/print/flow.ts`, `src/format/js/sort_imports/{generator,organize}.ts`); boxing call sites 429 → 121, −3.7 G instructions (−4.2%) on our 238 MB benchmark.
- Write-up with the other findings: https://github.com/timkendall/formatc/blob/main/docs/SCRIPTC_UPSTREAM.md (item 12).

## Suggested fixes

- Trust `as number` (or lower it to a cheap NaN/undefined check at the cast) instead of widening.
- Report when a `number` parameter is widened to a union, naming the call site that caused it. Today the only way to find the culprit is to grep the emitted IR for `scr_union_new_f64` and work backwards; in our case the five sites were far from the functions they slowed down.
- Specialize hot callees on the plain-number ABI at every call site that passes a plain number (`numeric-call-specialization` does this only for some callers today).

Environment: macOS (Darwin 27) arm64, scriptc 0.3.0 CLI and `@scriptc/compiler` 0.3.2 from npm.
