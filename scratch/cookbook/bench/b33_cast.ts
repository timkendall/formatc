import type { ProgramLifetime } from "@scriptc/types";
const REPS = 5;
const K = 20_000_000;
abstract class Node { abstract readonly kind: number; }
class Num extends Node { readonly kind = 0; constructor(public v: number) { super(); } }
class Add extends Node { readonly kind = 1; constructor(public l: number, public r: number) { super(); } }
class NodeP implements ProgramLifetime { kind: number = 0; }
class NumP extends NodeP { v: number = 0; constructor(v: number) { super(); this.kind = 0; this.v = v; } }
class AddP extends NodeP { l: number = 0; constructor(l: number) { super(); this.kind = 1; this.l = l; } }
function castLoop(ns: Node[]): number { let s = 0; for (let i = 0; i < K; i++) { const n = ns[i & 1]; if (n.kind === 0) s += (n as Num).v; else s += (n as Add).l; } return s; }
function instLoop(ns: Node[]): number { let s = 0; for (let i = 0; i < K; i++) { const n = ns[i & 1]; if (n instanceof Num) s += n.v; else if (n instanceof Add) s += n.l; } return s; }
function castLoopP(ns: NodeP[]): number { let s = 0; for (let i = 0; i < K; i++) { const n = ns[i & 1]; if (n.kind === 0) s += (n as NumP).v; else s += (n as AddP).l; } return s; }
function instLoopP(ns: NodeP[]): number { let s = 0; for (let i = 0; i < K; i++) { const n = ns[i & 1]; if (n instanceof NumP) s += n.v; else if (n instanceof AddP) s += n.l; } return s; }
function kindOnly(ns: Node[]): number { let s = 0; for (let i = 0; i < K; i++) { const n = ns[i & 1]; s += n.kind; } return s; }
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(30), (best * 1e6 / K).toFixed(2).padStart(8), "ns/op  r=", r);
}
const ns: Node[] = [new Num(1), new Add(2, 3)];
const nsp: NodeP[] = [new NumP(1), new AddP(2)];
bench("kind field read only", () => kindOnly(ns));
bench("as-cast after kind check", () => castLoop(ns));
bench("instanceof narrowing", () => instLoop(ns));
bench("as-cast (ProgramLifetime)", () => castLoopP(nsp));
bench("instanceof (ProgramLifetime)", () => instLoopP(nsp));
