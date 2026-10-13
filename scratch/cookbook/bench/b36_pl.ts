import type { ProgramLifetime, Acyclic } from "@scriptc/types";
const REPS = 5;

abstract class NodePlain  { kind: number; constructor(kind: number) { this.kind = kind; } abstract eval(): number; }
class NumPlain extends NodePlain { constructor(public v: number) { super(0); } eval(): number { return this.v; } }
class AddPlain extends NodePlain { constructor(public l: NodePlain, public r: NodePlain) { super(1); } eval(): number { return this.l.eval() + this.r.eval(); } }
function buildPlain(d: number): NodePlain { if (d === 0) return new NumPlain(1); return new AddPlain(buildPlain(d - 1), buildPlain(d - 1)); }

abstract class NodePL implements ProgramLifetime { kind: number; constructor(kind: number) { this.kind = kind; } abstract eval(): number; }
class NumPL extends NodePL { constructor(public v: number) { super(0); } eval(): number { return this.v; } }
class AddPL extends NodePL { constructor(public l: NodePL, public r: NodePL) { super(1); } eval(): number { return this.l.eval() + this.r.eval(); } }
function buildPL(d: number): NodePL { if (d === 0) return new NumPL(1); return new AddPL(buildPL(d - 1), buildPL(d - 1)); }

abstract class NodeAcy implements Acyclic { kind: number; constructor(kind: number) { this.kind = kind; } abstract eval(): number; }
class NumAcy extends NodeAcy { constructor(public v: number) { super(0); } eval(): number { return this.v; } }
class AddAcy extends NodeAcy { constructor(public l: NodeAcy, public r: NodeAcy) { super(1); } eval(): number { return this.l.eval() + this.r.eval(); } }
function buildAcy(d: number): NodeAcy { if (d === 0) return new NumAcy(1); return new AddAcy(buildAcy(d - 1), buildAcy(d - 1)); }

function bench(name: string, f: () => number, ops: number): void {
  let best = 1e18; let r = 0; let all = "";
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; all += (dt * 1e6 / ops).toFixed(1) + " "; if (dt < best) best = dt; }
  console.log(name.padEnd(34), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/node  reps:", all, " r=", r);
}
const D = 21; const NN = (1 << 22) - 1;
bench("build+drop plain", () => buildPlain(D).kind, NN);
bench("build+drop ProgramLifetime", () => buildPL(D).kind, NN);
bench("build+drop Acyclic", () => buildAcy(D).kind, NN);
const tp = buildPlain(D), tl = buildPL(D), ta = buildAcy(D);
bench("eval plain (virtual)", () => tp.eval(), NN);
bench("eval ProgramLifetime", () => tl.eval(), NN);
bench("eval Acyclic", () => ta.eval(), NN);
