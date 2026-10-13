import * as fs from "node:fs";
const REPS = 5;
const data: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
class BA { data: Uint8Array; len: number = 0; constructor(c: number) { this.data = new Uint8Array(c); }
  push(b: number): void { const n = this.len; if (n === this.data.length) this.grow(); this.data[n] = b; this.len = n + 1; }
  grow(): void { const nd = new Uint8Array(this.data.length * 2); nd.set(this.data); this.data = nd; } }
function pA(): number { const b = new BA(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
class BE { data: Uint8Array; len: number = 0; constructor(c: number) { this.data = new Uint8Array(c); }
  push(b: number): void { const n = this.len; if (n === this.data.length) this.grow(); this.data[n] = b | 0; this.len = n + 1; }
  grow(): void { const nd = new Uint8Array(this.data.length * 2); nd.set(this.data); this.data = nd; } }
function pE(): number { const b = new BE(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
class BF { data: Uint8Array; len: number = 0; constructor(c: number) { this.data = new Uint8Array(c); }
  push(b: number): void { const n = this.len | 0; if (n === this.data.length) this.grow(); this.data[n] = b; this.len = n + 1; }
  grow(): void { const nd = new Uint8Array(this.data.length * 2); nd.set(this.data); this.data = nd; } }
function pF(): number { const b = new BF(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
class BG { data: Uint8Array; len: number = 0; constructor(c: number) { this.data = new Uint8Array(c); }
  push(b: number): void { const n = this.len; if (n === this.data.length) this.grow(); this.data[n] = b; this.len = (n + 1) | 0; }
  grow(): void { const nd = new Uint8Array(this.data.length * 2); nd.set(this.data); this.data = nd; } }
function pG(): number { const b = new BG(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
class BH { data: Uint8Array; len: number = 0; constructor(c: number) { this.data = new Uint8Array(c); }
  push(b: number): void { const n = this.len; if (n === this.data.length) this.grow(); this.data[n] = b; this.len = ((n | 0) + 1) | 0; }
  grow(): void { const nd = new Uint8Array(this.data.length * 2); nd.set(this.data); this.data = nd; } }
function pH(): number { const b = new BH(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
class BI { data: Uint8Array; len: number = 0; constructor(c: number) { this.data = new Uint8Array(c); }
  push(b: number): void { const n = this.len; if (n === this.data.length) this.grow(); this.data[n] = b | 0; this.len = ((n | 0) + 1) | 0; }
  grow(): void { const nd = new Uint8Array(this.data.length * 2); nd.set(this.data); this.data = nd; } }
function pI(): number { const b = new BI(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
class BJ { data: Uint8Array; len: number = 0; constructor(c: number) { this.data = new Uint8Array(c); }
  push(b: number): void { const n = this.len | 0; if (n === this.data.length) this.grow(); this.data[n] = b; this.len = ((n | 0) + 1) | 0; }
  grow(): void { const nd = new Uint8Array(this.data.length * 2); nd.set(this.data); this.data = nd; } }
function pJ(): number { const b = new BJ(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
function bench(name: string, f: () => number, ops: number = N): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(40), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op ", (N / 1e6 / (best / 1000)).toFixed(0).padStart(7), "MB/s r=", r);
}
bench("A: const n = this.len; b / n + 1", pA);
bench("E: const n = this.len; b | 0 / n + 1", pE);
bench("F: const n = this.len | 0; b / n + 1", pF);
bench("G: const n = this.len; b / (n + 1) | 0", pG);
bench("H: const n = this.len; b / ((n | 0) + 1) | 0", pH);
bench("I: const n = this.len; b | 0 / ((n | 0) + 1) | 0", pI);
bench("J: const n = this.len | 0; b / ((n | 0) + 1) | 0", pJ);
