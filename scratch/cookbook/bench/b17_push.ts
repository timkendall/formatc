import * as fs from "node:fs";
const REPS = 5;
const data: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
class BA { data: Uint8Array; len: number = 0; constructor(c: number) { this.data = new Uint8Array(c); }
  push(b: number): void { const n = this.len; if (n === this.data.length) this.grow(); this.data[n] = b; this.len = n + 1; }
  grow(): void { const nd = new Uint8Array(this.data.length * 2); nd.set(this.data); this.data = nd; } }
class BB { data: Uint8Array; len: number = 0; constructor(c: number) { this.data = new Uint8Array(c); }
  push(b: number): void { const n = this.len | 0; if (n === this.data.length) this.grow(); this.data[n] = b | 0; this.len = ((n | 0) + 1) | 0; }
  grow(): void { const nd = new Uint8Array(this.data.length * 2); nd.set(this.data); this.data = nd; } }
class BC { data: Buffer; len: number = 0; constructor(c: number) { this.data = Buffer.alloc(c); }
  push(b: number): void { const n = this.len | 0; if (n === this.data.length) this.grow(); this.data[n] = b | 0; this.len = ((n | 0) + 1) | 0; }
  grow(): void { const nd = Buffer.alloc(this.data.length * 2); this.data.copy(nd, 0, 0, this.len); this.data = nd; } }
class BD { data: Uint8Array; len: number = 0; constructor(c: number) { this.data = new Uint8Array(c); }
  push(b: number): void { const n = this.len | 0; if (n === this.data.length) this.grow(); this.data[n] = b | 0; this.len = n + 1; }
  grow(): void { const nd = new Uint8Array(this.data.length * 2); nd.set(this.data); this.data = nd; } }
function pa(): number { const b = new BA(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
function pb(): number { const b = new BB(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
function pc(): number { const b = new BC(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
function pd(): number { const b = new BD(N * 2); for (let i = 0; i < N; i++) b.push(data[i] | 0); return b.len; }
function bench(name: string, f: () => number, ops: number = N): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op ", (N / 1e6 / (best / 1000)).toFixed(0).padStart(7), "MB/s r=", r);
}
bench("A: plain push", pa); bench("B: |0 idioms Uint8Array", pb); bench("C: |0 idioms Buffer", pc); bench("D: len=n+1", pd);
