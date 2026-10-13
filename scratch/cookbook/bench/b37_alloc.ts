import type { ProgramLifetime } from "@scriptc/types";
const REPS = 5;
const D = 21; const NN = (1 << 22) - 1;
// V1: as b36 (abstract eval, base ctor kind, param props)
abstract class N1 implements ProgramLifetime { kind: number; constructor(kind: number) { this.kind = kind; } abstract eval(): number; }
class Num1 extends N1 { constructor(public v: number) { super(0); } eval(): number { return this.v; } }
class Add1 extends N1 { constructor(public l: N1, public r: N1) { super(1); } eval(): number { return this.l.eval() + this.r.eval(); } }
function b1(d: number, s: number): N1 { if (d === 0) return new Num1(s % 10); return new Add1(b1(d - 1, s * 7 + 1), b1(d - 1, s * 5 + 2)); }
// V2: no s arithmetic
function b1b(d: number): N1 { if (d === 0) return new Num1(1); return new Add1(b1b(d - 1), b1b(d - 1)); }
// V3: with three kinds like b32
class Mul1 extends N1 { constructor(public l: N1, public r: N1) { super(2); } eval(): number { return this.l.eval() * this.r.eval() % 1000; } }
function b3(d: number, s: number): N1 { if (d === 0) return new Num1(s % 10); const k = s % 3; if (k === 0) return new Add1(b3(d - 1, s * 7 + 1), b3(d - 1, s * 5 + 2)); if (k === 1) return new Mul1(b3(d - 1, s * 3 + 1), b3(d - 1, s * 11 + 3)); return new Add1(b3(d - 1, s + 1), b3(d - 1, s + 2)); }
function cnt(n: N1): number { if (n.kind === 0) return 1; if (n.kind === 1) { const a = n as Add1; return 1 + cnt(a.l) + cnt(a.r); } const m = n as Mul1; return 1 + cnt(m.l) + cnt(m.r); }
function bench(name: string, f: () => number, ops: number): void {
  let best = 1e18; let r = 0; let all = "";
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; all += (dt * 1e6 / ops).toFixed(1) + " "; if (dt < best) best = dt; }
  console.log(name.padEnd(34), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/node  reps:", all, " r=", r);
}
bench("b1 build (s arithmetic)", () => b1(D, 1).kind, NN);
bench("b1b build (no arithmetic)", () => b1b(D).kind, NN);
bench("b3 build (3 kinds)", () => b3(D, 1).kind, NN);
bench("b3 build + cnt", () => cnt(b3(D, 1)), NN);
