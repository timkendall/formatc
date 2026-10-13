import * as fs from "node:fs";
import { ByteBuf } from "../lib/bytebuf.ts";
import { I32Vec } from "../lib/i32vec.ts";
const REPS = 5;
const data: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
function pushBytes(bb: ByteBuf): number { bb.reset(); const src = data; for (let i = 0; i < src.length; i++) bb.push(src[i] | 0); return bb.len; }
function pushLocal(bb: ByteBuf): number {
  bb.reset(); const src = data; let d = bb.data; let n = 0;
  for (let i = 0; i < src.length; i++) { if (n === d.length) { bb.len = n; bb.grow(n + 1); d = bb.data; } d[n] = src[i] | 0; n = ((n | 0) + 1) | 0; }
  bb.len = n; return n;
}
function appendRuns(bb: ByteBuf, run: number): number { bb.reset(); const src = data; const lim = src.length - run; for (let i = 0; i < lim; i += run) bb.append(src, i, i + run); return bb.len; }
function setRuns(out: Uint8Array, run: number): number { const src = data; const lim = src.length - run; let n = 0; for (let i = 0; i < lim; i += run) { out.set(src.subarray(i, i + run), n); n += run; } return n; }
function loopRuns(out: Uint8Array, run: number): number { const src = data; const lim = src.length - run; let n = 0; for (let i = 0; i < lim; i += run) { for (let j = 0; j < run; j++) out[n + j] = src[i + j] | 0; n += run; } return n; }
function asciiAppend(bb: ByteBuf, k: number): number { bb.reset(); for (let i = 0; i < k; i++) bb.appendAscii("function "); return bb.len; }
function vecPush(v: I32Vec, k: number): number { v.reset(); for (let i = 0; i < k; i++) v.push(i); return v.len; }
function bench(name: string, f: () => number, ops: number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op ", (N / 1e6 / (best / 1000)).toFixed(0).padStart(7), "MB/s r=", r);
}
const bb = new ByteBuf(N * 2);
const bbSmall = new ByteBuf(16);
bench("ByteBuf.push (presized)", () => pushBytes(bb), N);
bench("ByteBuf.push (grow from 16)", () => { const b = new ByteBuf(16); return pushBytes(b); }, N);
bench("push w/ local data/len", () => pushLocal(bb), N);
const out = new Uint8Array(N);
for (const run of [1, 4, 8, 16, 32, 64, 256, 4096]) {
  bench("ByteBuf.append run=" + run, () => appendRuns(bb, run), N / run);
}
for (const run of [4, 16, 64, 256]) {
  bench("set(subarray) run=" + run, () => setRuns(out, run), N / run);
  bench("byte loop run=" + run, () => loopRuns(out, run), N / run);
}
bench("appendAscii(\"function \")", () => asciiAppend(bb, 5_000_000), 5_000_000);
const iv = new I32Vec(8);
bench("I32Vec.push 20M", () => vecPush(iv, 20_000_000), 20_000_000);
const iv2 = new I32Vec(20_000_000);
bench("I32Vec.push presized", () => vecPush(iv2, 20_000_000), 20_000_000);
