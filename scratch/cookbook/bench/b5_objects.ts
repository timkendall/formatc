import type { Acyclic, ProgramLifetime } from "@scriptc/types";
const REPS = 5;
const K = 20_000_000;

class P { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
class PA implements Acyclic { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
class PL implements ProgramLifetime { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
class Node { kind: number; start: number; end: number; left: Node | null; right: Node | null;
  constructor(kind: number, start: number, end: number) { this.kind = kind; this.start = start; this.end = end; this.left = null; this.right = null; } }
class NodeL implements ProgramLifetime { kind: number; start: number; end: number; left: NodeL | null; right: NodeL | null;
  constructor(kind: number, start: number, end: number) { this.kind = kind; this.start = start; this.end = end; this.left = null; this.right = null; } }
class NodeA implements Acyclic { readonly kind: number; readonly start: number; readonly end: number; readonly left: NodeA | null; readonly right: NodeA | null;
  constructor(kind: number, start: number, end: number, left: NodeA | null, right: NodeA | null) { this.kind = kind; this.start = start; this.end = end; this.left = left; this.right = right; } }

function allocTemp(): number { let s = 0; for (let i = 0; i < K; i++) { const p = new P(i, 2); s += p.x + p.y; } return s; }
function allocTempA(): number { let s = 0; for (let i = 0; i < K; i++) { const p = new PA(i, 2); s += p.x + p.y; } return s; }
function allocTempL(): number { let s = 0; for (let i = 0; i < K; i++) { const p = new PL(i, 2); s += p.x + p.y; } return s; }
function allocKeep(): number { const a: P[] = []; for (let i = 0; i < K / 4; i++) a.push(new P(i, 2)); let s = 0; for (let i = 0; i < a.length; i++) s += a[i].x; return s; }
function allocKeepA(): number { const a: PA[] = []; for (let i = 0; i < K / 4; i++) a.push(new PA(i, 2)); let s = 0; for (let i = 0; i < a.length; i++) s += a[i].x; return s; }
function allocKeepL(): number { const a: PL[] = []; for (let i = 0; i < K / 4; i++) a.push(new PL(i, 2)); let s = 0; for (let i = 0; i < a.length; i++) s += a[i].x; return s; }
// AST-like: build a tree of Node (mutable, cyclic-capable), then walk
function buildTree(d: number): Node { const n = new Node(d, 0, d); if (d > 0) { n.left = buildTree(d - 1); n.right = buildTree(d - 1); } return n; }
function walkTree(n: Node): number { let s = n.kind; if (n.left !== null) s += walkTree(n.left); if (n.right !== null) s += walkTree(n.right); return s; }
function buildTreeL(d: number): NodeL { const n = new NodeL(d, 0, d); if (d > 0) { n.left = buildTreeL(d - 1); n.right = buildTreeL(d - 1); } return n; }
function walkTreeL(n: NodeL): number { let s = n.kind; if (n.left !== null) s += walkTreeL(n.left); if (n.right !== null) s += walkTreeL(n.right); return s; }
function buildTreeA(d: number): NodeA { return d === 0 ? new NodeA(0, 0, 0, null, null) : new NodeA(d, 0, d, buildTreeA(d - 1), buildTreeA(d - 1)); }
function walkTreeA(n: NodeA): number { let s = n.kind; if (n.left !== null) s += walkTreeA(n.left); if (n.right !== null) s += walkTreeA(n.right); return s; }
function treeBench(): number { const t = buildTree(21); return walkTree(t); }
function treeBenchL(): number { const t = buildTreeL(21); return walkTreeL(t); }
function treeBenchA(): number { const t = buildTreeA(21); return walkTreeA(t); }
// AoS vs SoA sum
function aosSum(a: P[]): number { let s = 0; for (let r = 0; r < 20; r++) for (let i = 0; i < a.length; i++) s += a[i].x + a[i].y; return s; }
function soaSum(xs: Float64Array, ys: Float64Array): number { let s = 0; for (let r = 0; r < 20; r++) for (let i = 0; i < xs.length; i++) s += xs[i] + ys[i]; return s; }
function soaSumI(xs: Int32Array, ys: Int32Array): number { let s = 0; for (let r = 0; r < 20; r++) for (let i = 0; i < xs.length; i++) s += xs[i] + ys[i]; return s; }
// passing objects
function useP(p: P): number { return p.x + p.y; }
function passLoop(p: P): number { let s = 0; for (let i = 0; i < K; i++) s += useP(p); return s; }
class Counter { n: number = 0; inc(): void { this.n++; } incBy(d: number): void { this.n += d; } }
function fieldLoop(c: Counter): number { for (let i = 0; i < K * 4; i++) c.n += 1; return c.n; }
function methodLoop(c: Counter): number { for (let i = 0; i < K * 4; i++) c.inc(); return c.n; }

function bench(name: string, f: () => number, ops: number = K): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(24), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op  r=", r);
}
bench("new P temp", allocTemp);
bench("new P(Acyclic) temp", allocTempA);
bench("new P(ProgLife) temp", allocTempL);
bench("new P + push+read", allocKeep, K / 4);
bench("new PA + push+read", allocKeepA, K / 4);
bench("new PL + push+read", allocKeepL, K / 4);
const NT = (1 << 22) - 1;
bench("tree build+walk Node", treeBench, NT);
bench("tree build+walk NodeL", treeBenchL, NT);
bench("tree build+walk NodeA", treeBenchA, NT);
const M = 1_000_000;
const arr: P[] = []; for (let i = 0; i < M; i++) arr.push(new P(i, 1));
const xs = new Float64Array(M), ys = new Float64Array(M); for (let i = 0; i < M; i++) { xs[i] = i; ys[i] = 1; }
const xi = new Int32Array(M), yi = new Int32Array(M); for (let i = 0; i < M; i++) { xi[i] = i; yi[i] = 1; }
bench("AoS sum", () => aosSum(arr), M * 20);
bench("SoA f64 sum", () => soaSum(xs, ys), M * 20);
bench("SoA i32 sum", () => soaSumI(xi, yi), M * 20);
const p = new P(1, 2);
bench("pass obj to fn", () => passLoop(p));
bench("field += loop", () => fieldLoop(new Counter()), K * 4);
bench("method inc loop", () => methodLoop(new Counter()), K * 4);
