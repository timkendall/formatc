import type { Int32 } from "@scriptc/types";
const REPS = 5;
const K = 20_000_000;
class V1 { data: Int32Array = new Int32Array(8); len: number = 0;
  push(v: number): void { const n = this.len; if (n === this.data.length) { const nd = new Int32Array(n * 2); nd.set(this.data); this.data = nd; } this.data[n] = v | 0; this.len = n + 1; } }
class V2 { data: Int32Array = new Int32Array(8); len: number = 0;
  push(v: number): void { const n = this.len | 0; if (n === this.data.length) { const nd = new Int32Array(n * 2); nd.set(this.data); this.data = nd; } this.data[n] = v | 0; this.len = (n + 1) | 0; } }
class V3 { data: Int32Array = new Int32Array(8); len: Int32 = 0;
  push(v: number): void { const n = this.len; if (n === this.data.length) { const nd = new Int32Array(n * 2); nd.set(this.data); this.data = nd; } this.data[n] = v | 0; this.len = (n + 1) | 0; } }
class V4 { data: Int32Array = new Int32Array(8); len: number = 0;
  grow(): void { const nd = new Int32Array(this.data.length * 2); nd.set(this.data); this.data = nd; }
  push(v: number): void { const n = this.len | 0; if (n === this.data.length) this.grow(); this.data[n] = v | 0; this.len = ((n | 0) + 1) | 0; } }
function f1(): number { const v = new V1(); for (let i = 0; i < K; i++) v.push(i); return v.len; }
function f2(): number { const v = new V2(); for (let i = 0; i < K; i++) v.push(i); return v.len; }
function f3(): number { const v = new V3(); for (let i = 0; i < K; i++) v.push(i); return v.len; }
function f4(): number { const v = new V4(); for (let i = 0; i < K; i++) v.push(i); return v.len; }
function f5(): number { let d = new Int32Array(8); let n = 0; for (let i = 0; i < K; i++) { if (n === d.length) { const nd = new Int32Array(n * 2); nd.set(d); d = nd; } d[n] = i | 0; n = ((n | 0) + 1) | 0; } return n; }
function f6(): number { const d = new Int32Array(K); let n = 0; for (let i = 0; i < K; i++) { d[n] = i | 0; n = ((n | 0) + 1) | 0; } return n; }
function bench(name: string, f: () => number, ops: number = K): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op  r=", r);
}
bench("V1 plain", f1); bench("V2 |0", f2); bench("V3 Int32 len", f3); bench("V4 grow() split", f4); bench("local grow", f5); bench("presized local", f6);
