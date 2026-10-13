import type { Int32 } from "@scriptc/types";
import * as fs from "node:fs";

const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const REPS = 5;

function sumPlain(buf: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i];
  return s;
}
function sumOr0(buf: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s = (s + buf[i]) | 0;
  return s;
}
function sumOr0Local(buf: Uint8Array): number {
  let s = 0;
  const n = buf.length;
  for (let i = 0; i < n; i++) s = (s + buf[i]) | 0;
  return s;
}
function sumWhile(buf: Uint8Array): number {
  let s = 0;
  let i = 0;
  const n = buf.length;
  while (i < n) { s += buf[i]; i++; }
  return s;
}
function sumWhileOr0(buf: Uint8Array): number {
  let s = 0;
  let i = 0;
  const n = buf.length;
  while (i < n) { s += buf[i]; i = (i + 1) | 0; }
  return s;
}
function sumWhileInt32(buf: Uint8Array): number {
  let s = 0;
  let i: Int32 = 0;
  const n: Int32 = buf.length | 0;
  while (i < n) { s += buf[i]; i = (i + 1) | 0; }
  return s;
}
function sum4(buf: Uint8Array): number {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  const n = buf.length - 3;
  let i = 0;
  for (; i < n; i += 4) { s0 += buf[i]; s1 += buf[i + 1]; s2 += buf[i + 2]; s3 += buf[i + 3]; }
  for (; i < buf.length; i++) s0 += buf[i];
  return s0 + s1 + s2 + s3;
}
function sumU32(buf: Uint8Array, u32: Uint32Array): number {
  let s = 0;
  for (let i = 0; i < u32.length; i++) { const w = u32[i]; s += (w & 255) + ((w >>> 8) & 255) + ((w >>> 16) & 255) + (w >>> 24); }
  return s + buf[0] * 0;
}
function sumXorShift(buf: Uint8Array): number {
  // hash-like chain: h = h*31 + b  (imul)
  let h = 0;
  for (let i = 0; i < buf.length; i++) h = (Math.imul(h, 31) + buf[i]) | 0;
  return h;
}
function sumXorShiftNoOr(buf: Uint8Array): number {
  let h = 0;
  for (let i = 0; i < buf.length; i++) h = (h * 31 + buf[i]) % 1000003;
  return h;
}

class Acc { s: number = 0; s32: Int32 = 0; }
function sumField(buf: Uint8Array, a: Acc): number {
  for (let i = 0; i < buf.length; i++) a.s += buf[i];
  return a.s;
}
function sumField32(buf: Uint8Array, a: Acc): number {
  for (let i = 0; i < buf.length; i++) a.s32 = (a.s32 + buf[i]) | 0;
  return a.s32;
}
let gsum = 0;
function sumGlobal(buf: Uint8Array): number {
  gsum = 0;
  for (let i = 0; i < buf.length; i++) gsum += buf[i];
  return gsum;
}

function bench(name: string, f: () => number): void {
  let best = 1e18;
  let r = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const t0 = performance.now();
    r = f();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  console.log(name.padEnd(16), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s  r=", r);
}
const u32 = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
const acc = new Acc();
bench("plain", () => sumPlain(data));
bench("or0", () => sumOr0(data));
bench("or0 n-local", () => sumOr0Local(data));
bench("while", () => sumWhile(data));
bench("while i|0", () => sumWhileOr0(data));
bench("while Int32", () => sumWhileInt32(data));
bench("unroll4", () => sum4(data));
bench("u32 words", () => sumU32(data, u32));
bench("imul hash", () => sumXorShift(data));
bench("mod hash", () => sumXorShiftNoOr(data));
bench("field", () => { acc.s = 0; return sumField(data, acc); });
bench("field Int32", () => { acc.s32 = 0; return sumField32(data, acc); });
bench("module let", () => sumGlobal(data));
