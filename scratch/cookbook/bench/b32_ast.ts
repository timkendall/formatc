import type { ProgramLifetime } from "@scriptc/types";
const REPS = 5;
const NK = 3;
abstract class Node implements ProgramLifetime { kind: number; constructor(kind: number) { this.kind = kind; } abstract eval(): number; }
class Num extends Node { constructor(public v: number) { super(0); } eval(): number { return this.v; } }
class Add extends Node { constructor(public l: Node, public r: Node) { super(1); } eval(): number { return this.l.eval() + this.r.eval(); } }
class Mul extends Node { constructor(public l: Node, public r: Node) { super(2); } eval(): number { return this.l.eval() * this.r.eval() % 1000; } }
function build(d: number, s: number): Node {
  if (d === 0) return new Num(s % 10);
  const k = s % 3;
  if (k === 0) return new Add(build(d - 1, s * 7 + 1), build(d - 1, s * 5 + 2));
  if (k === 1) return new Mul(build(d - 1, s * 3 + 1), build(d - 1, s * 11 + 3));
  return new Add(build(d - 1, s + 1), build(d - 1, s + 2));
}
function evalVirtual(n: Node): number { return n.eval(); }
function evalSwitchCast(n: Node): number {
  switch (n.kind) {
    case 0: return (n as Num).v;
    case 1: { const a = n as Add; return evalSwitchCast(a.l) + evalSwitchCast(a.r); }
    default: { const m = n as Mul; return evalSwitchCast(m.l) * evalSwitchCast(m.r) % 1000; }
  }
}
function evalInstanceof(n: Node): number {
  if (n instanceof Num) return n.v;
  if (n instanceof Add) return evalInstanceof(n.l) + evalInstanceof(n.r);
  const m = n as Mul; return evalInstanceof(m.l) * evalInstanceof(m.r) % 1000;
}
// union type of classes
type U = Num2 | Add2 | Mul2;
class Num2 { readonly kind = 0; constructor(public v: number) {} }
class Add2 { readonly kind = 1; constructor(public l: U, public r: U) {} }
class Mul2 { readonly kind = 2; constructor(public l: U, public r: U) {} }
function build2(d: number, s: number): U {
  if (d === 0) return new Num2(s % 10);
  const k = s % 3;
  if (k === 0) return new Add2(build2(d - 1, s * 7 + 1), build2(d - 1, s * 5 + 2));
  if (k === 1) return new Mul2(build2(d - 1, s * 3 + 1), build2(d - 1, s * 11 + 3));
  return new Add2(build2(d - 1, s + 1), build2(d - 1, s + 2));
}
function evalUnion(n: U): number {
  switch (n.kind) {
    case 0: return n.v;
    case 1: return evalUnion(n.l) + evalUnion(n.r);
    default: return evalUnion(n.l) * evalUnion(n.r) % 1000;
  }
}
// SoA
function buildSoa(d: number, s: number, kind: Int32Array, l: Int32Array, r: Int32Array, val: Int32Array, cnt: Int32Array): number {
  const id = cnt[0] | 0; cnt[0] = id + 1;
  if (d === 0) { kind[id] = 0; val[id] = s % 10; return id; }
  const k = s % 3;
  let a = 0, b = 0;
  if (k === 0) { a = buildSoa(d - 1, s * 7 + 1, kind, l, r, val, cnt); b = buildSoa(d - 1, s * 5 + 2, kind, l, r, val, cnt); kind[id] = 1; }
  else if (k === 1) { a = buildSoa(d - 1, s * 3 + 1, kind, l, r, val, cnt); b = buildSoa(d - 1, s * 11 + 3, kind, l, r, val, cnt); kind[id] = 2; }
  else { a = buildSoa(d - 1, s + 1, kind, l, r, val, cnt); b = buildSoa(d - 1, s + 2, kind, l, r, val, cnt); kind[id] = 1; }
  l[id] = a; r[id] = b;
  return id;
}
function evalSoa(n: number, kind: Int32Array, l: Int32Array, r: Int32Array, val: Int32Array): number {
  const k = kind[n] | 0;
  if (k === 0) return val[n] | 0;
  const a = evalSoa(l[n] | 0, kind, l, r, val), b = evalSoa(r[n] | 0, kind, l, r, val);
  return k === 1 ? a + b : a * b % 1000;
}
function countNodes(n: Node): number { if (n.kind === 0) return 1; if (n.kind === 1) { const a = n as Add; return 1 + countNodes(a.l) + countNodes(a.r); } const m = n as Mul; return 1 + countNodes(m.l) + countNodes(m.r); }
function bench(name: string, f: () => number, ops: number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(30), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/node  r=", r);
}
const D = 21;
const tree = build(D, 1);
const nn = countNodes(tree);
const tree2 = build2(D, 1);
const cap = nn + 10;
const kind = new Int32Array(cap), l = new Int32Array(cap), r = new Int32Array(cap), val = new Int32Array(cap), cnt = new Int32Array(1);
const rootSoa = buildSoa(D, 1, kind, l, r, val, cnt);
console.log("nodes", nn, "soa nodes", cnt[0]);
bench("build class tree (PL)", () => countNodes(build(D, 1)), nn);
bench("build union-class tree", () => { const t = build2(D, 1); return evalUnion(t); }, nn);
bench("build SoA tree", () => { cnt[0] = 0; return buildSoa(D, 1, kind, l, r, val, cnt); }, nn);
bench("eval virtual method", () => evalVirtual(tree), nn);
bench("eval switch(kind)+as cast", () => evalSwitchCast(tree), nn);
bench("eval instanceof chain", () => evalInstanceof(tree), nn);
bench("eval union-of-classes", () => evalUnion(tree2), nn);
bench("eval SoA", () => evalSoa(rootSoa, kind, l, r, val), nn);
