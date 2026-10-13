import * as fs from "node:fs";
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const REPS = 5;
function xorAcc(buf: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s = s ^ buf[i];
  return s;
}
function xorShift(buf: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s = (s << 1) ^ buf[i];
  return s;
}
function fnv(buf: Uint8Array): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 16777619); }
  return h;
}
function fnv2(buf: Uint8Array): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < buf.length; i++) { h = Math.imul(h ^ buf[i], 16777619); }
  return h;
}
function djb(buf: Uint8Array): number {
  let h = 5381;
  for (let i = 0; i < buf.length; i++) h = ((h << 5) + h + buf[i]) | 0;
  return h;
}
function andAcc(buf: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s = (s + buf[i]) & 0xffff;
  return s;
}
function addPlainNoOr(buf: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s = s + buf[i];
  return s;
}
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(16), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s  r=", r);
}
bench("xorAcc", () => xorAcc(data));
bench("xorShift", () => xorShift(data));
bench("fnv h^=;imul", () => fnv(data));
bench("fnv imul(h^b)", () => fnv2(data));
bench("djb", () => djb(data));
bench("and 0xffff", () => andAcc(data));
bench("plain add", () => addPlainNoOr(data));
