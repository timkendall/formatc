import type { NoThrow, Int32 } from "@scriptc/types";
import { crossFn, crossFnNT } from "./gen/mod_a.ts";
const REPS = 5;
const K = 200_000_000;

function plainFn(c: number): number { return ((c | 0) * 7 + 3) & 255; }
function ntFn(c: number): NoThrow<number> { return ((c | 0) * 7 + 3) & 255; }
function i32Fn(c: Int32): Int32 { return (c * 7 + 3) & 255; }
function branchy(c: number): number { if (c < 48) return 0; if (c < 58) return 1; if (c < 65) return 2; return (c & 7) + 3; }
class C {
  k: number = 7;
  method(c: number): number { return ((c | 0) * this.k + 3) & 255; }
  static smethod(c: number): number { return ((c | 0) * 7 + 3) & 255; }
}
class Base { virt(c: number): number { return c & 255; } }
class D1 extends Base { virt(c: number): number { return (c * 3) & 255; } }
class D2 extends Base { virt(c: number): number { return (c * 5) & 255; } }
let rec = 0;
function recur(n: number): number { return n <= 0 ? 0 : 1 + recur(n - 1); }
function rec2(n: number, acc: number): number { if (n <= 0) return acc; return rec2(n - 1, acc + 1); }

function loopPlain(): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + plainFn(i & 1023)) | 0; return s; }
function loopNT(): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + ntFn(i & 1023)) | 0; return s; }
function loopI32(): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + i32Fn(i & 1023)) | 0; return s; }
function loopMethod(o: C): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + o.method(i & 1023)) | 0; return s; }
function loopStatic(): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + C.smethod(i & 1023)) | 0; return s; }
function loopCross(): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + crossFn(i & 1023)) | 0; return s; }
function loopCrossNT(): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + crossFnNT(i & 1023)) | 0; return s; }
function loopClosure(f: (c: number) => number): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + (f(i & 1023) | 0)) | 0; return s; }
function loopVirt(os: Base[]): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + (os[i & 1].virt(i & 1023) | 0)) | 0; return s; }
function loopRec(): number { let s = 0; for (let i = 0; i < K / 100; i++) s = ((s | 0) + (recur(100) | 0)) | 0; return s; }
function loopRec2(): number { let s = 0; for (let i = 0; i < K / 100; i++) s = ((s | 0) + (rec2(100, 0) | 0)) | 0; return s; }
function loopInline(): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + ((((i & 1023) | 0) * 7 + 3) & 255)) | 0; return s; }
function loopSwitch(): number {
  let s = 0;
  for (let i = 0; i < K; i++) {
    let r = 0;
    switch (i & 15) { case 0: r = 5; break; case 1: r = 9; break; case 2: r = 13; break; case 3: r = 2; break; case 4: r = 7; break; case 5: r = 1; break; case 6: r = 8; break; case 7: r = 11; break; case 8: r = 4; break; default: r = 3; }
    s = ((s | 0) + r) | 0;
  }
  return s;
}
const TBL = new Int32Array([5, 9, 13, 2, 7, 1, 8, 11, 4, 3, 3, 3, 3, 3, 3, 3]);
function loopTable(): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + (TBL[i & 15] | 0)) | 0; return s; }
function loopIfChain(): number {
  let s = 0;
  for (let i = 0; i < K; i++) {
    const c = i & 15; let r = 3;
    if (c === 0) r = 5; else if (c === 1) r = 9; else if (c === 2) r = 13; else if (c === 3) r = 2; else if (c === 4) r = 7; else if (c === 5) r = 1; else if (c === 6) r = 8; else if (c === 7) r = 11; else if (c === 8) r = 4;
    s = ((s | 0) + r) | 0;
  }
  return s;
}
function loopBranchy(): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + branchy(i & 127)) | 0; return s; }

function bench(name: string, f: () => number, ops: number = K): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(20), (best * 1e6 / ops).toFixed(2).padStart(7), "ns/op  r=", r);
}
const o = new C();
const os: Base[] = [new D1(), new D2()];
const clos = (c: number): number => ((c | 0) * 7 + 3) & 255;
const k3 = 7;
const clos2 = (c: number): number => ((c | 0) * k3 + 3) & 255;
bench("inline expr", loopInline);
bench("top-level fn", loopPlain);
bench("NoThrow fn", loopNT);
bench("Int32 fn", loopI32);
bench("method", () => loopMethod(o));
bench("static method", loopStatic);
bench("cross-module fn", loopCross);
bench("cross-module NoThrow", loopCrossNT);
bench("closure (no cap)", () => loopClosure(clos));
bench("closure (capture)", () => loopClosure(clos2));
bench("virtual (2 impls)", () => loopVirt(os));
bench("recursion d=100", loopRec, K / 100 * 100);
bench("tail-rec d=100", loopRec2, K / 100 * 100);
bench("switch 16", loopSwitch);
bench("table lookup", loopTable);
bench("if-chain", loopIfChain);
bench("branchy fn", loopBranchy);
