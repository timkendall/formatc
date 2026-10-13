import * as fs from "node:fs";
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const bufData = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const REPS = 5;
const G: Uint8Array = data;
let gl: Uint8Array = data;

class Holder { src: Uint8Array; constructor(s: Uint8Array) { this.src = s; }
  sum(): number { let s = 0; for (let i = 0; i < this.src.length; i++) s = ((s | 0) + (this.src[i] | 0)) | 0; return s; }
  sumLocal(): number { const src = this.src; let s = 0; for (let i = 0; i < src.length; i++) s = ((s | 0) + (src[i] | 0)) | 0; return s; }
}
function sumLocal(b: Uint8Array): number { let s = 0; for (let i = 0; i < b.length; i++) s = ((s | 0) + (b[i] | 0)) | 0; return s; }
function sumConst(): number { let s = 0; for (let i = 0; i < G.length; i++) s = ((s | 0) + (G[i] | 0)) | 0; return s; }
function sumLet(): number { let s = 0; for (let i = 0; i < gl.length; i++) s = ((s | 0) + (gl[i] | 0)) | 0; return s; }
function sumBuffer(b: Buffer): number { let s = 0; for (let i = 0; i < b.length; i++) s = ((s | 0) + (b[i] | 0)) | 0; return s; }
function sumBufferRead(b: Buffer): number { let s = 0; for (let i = 0; i < b.length; i++) s = ((s | 0) + b.readUInt8(i)) | 0; return s; }
function sumDV(dv: DataView): number { let s = 0; const n = dv.byteLength; for (let i = 0; i < n; i++) s = ((s | 0) + dv.getUint8(i)) | 0; return s; }
function sumDV32(dv: DataView): number { let s = 0; const n = dv.byteLength - 3; for (let i = 0; i < n; i += 4) s = ((s | 0) + (dv.getUint32(i, true) | 0)) | 0; return s; }
function sumU32(a: Uint32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = ((s | 0) + (a[i] | 0)) | 0; return s; }
function sumI32(a: Int32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = ((s | 0) + (a[i] | 0)) | 0; return s; }
function sumU16(a: Uint16Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = ((s | 0) + (a[i] | 0)) | 0; return s; }
function sumF64(a: Float64Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function sumSub(b: Uint8Array): number {
  let s = 0; const CH = 4096;
  for (let o = 0; o < b.length; o += CH) { const sub = b.subarray(o, Math.min(o + CH, b.length)); for (let i = 0; i < sub.length; i++) s = ((s | 0) + (sub[i] | 0)) | 0; }
  return s;
}
function subAlloc(b: Uint8Array, k: number): number { let s = 0; for (let i = 0; i < k; i++) { const sub = b.subarray(i, i + 16); s = ((s | 0) + (sub[0] | 0)) | 0; } return s; }
function bench(name: string, f: () => number, bytes: number = N): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(18), (bytes / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s  r=", r);
}
const h = new Holder(data);
const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
const n4 = data.length >> 2;
const u32 = new Uint32Array(n4); const i32 = new Int32Array(n4); const u16 = new Uint16Array(n4 * 2); const f64 = new Float64Array(n4);
for (let i = 0; i < n4; i++) { u32[i] = i; i32[i] = i; f64[i] = i; }
for (let i = 0; i < u16.length; i++) u16[i] = i;
bench("local param", () => sumLocal(data));
bench("class field", () => h.sum());
bench("class field->local", () => h.sumLocal());
bench("module const", () => sumConst());
bench("module let", () => sumLet());
bench("Buffer[i]", () => sumBuffer(bufData));
bench("Buffer.readUInt8", () => sumBufferRead(bufData));
bench("DataView.getUint8", () => sumDV(dv));
bench("DataView.getUint32", () => sumDV32(dv), N);
bench("Uint32Array", () => sumU32(u32), n4 * 4);
bench("Int32Array", () => sumI32(i32), n4 * 4);
bench("Uint16Array", () => sumU16(u16), n4 * 4);
bench("Float64Array", () => sumF64(f64), n4 * 8);
bench("subarray chunks", () => sumSub(data));
{
  const K = 5_000_000; let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = subAlloc(data, K); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log("subarray alloc".padEnd(18), (best * 1e6 / K).toFixed(1), "ns/op r=", r);
}
