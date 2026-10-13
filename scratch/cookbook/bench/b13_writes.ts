import * as fs from "node:fs";
const REPS = 5;
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const out = new Uint8Array(N + 64);
const out32 = new Int32Array(N + 64);
function w1(src: Uint8Array, o: Uint8Array): number { for (let i = 0; i < src.length; i++) o[i] = src[i]; return o[5]; }
function w2(src: Uint8Array, o: Uint8Array): number { let n = 0; for (let i = 0; i < src.length; i++) { o[n] = src[i]; n++; } return n; }
function w3(src: Uint8Array, o: Uint8Array): number { let n = 0; for (let i = 0; i < src.length; i++) { o[n] = src[i]; n = ((n | 0) + 1) | 0; } return n; }
function w4(src: Uint8Array, o: Uint8Array): number { let n = 0; for (let i = 0; i < src.length; i++) { o[n | 0] = src[i]; n = ((n | 0) + 1) | 0; } return n; }
function w5(src: Uint8Array, o: Uint8Array): number { let n = 0; for (let i = 0; i < src.length; i++) { o[n] = src[i] | 0; n = (n + 1) | 0; } return n; }
function w6(src: Uint8Array, o: Int32Array): number { let n = 0; for (let i = 0; i < src.length; i++) { o[n] = src[i]; n = ((n | 0) + 1) | 0; } return n; }
function w7(src: Uint8Array, o: Uint8Array): number { const L = src.length; for (let i = 0; i < L; i++) o[i] = src[i]; return o[5]; }
function w8(src: Uint8Array, o: Uint8Array): number { let n = 0; for (let i = 0; i < src.length; i++) { if (n === o.length) break; o[n] = src[i]; n = ((n | 0) + 1) | 0; } return n; }
function w9(src: Uint8Array, o: Uint8Array): number { let n = 0; const cap = o.length | 0; for (let i = 0; i < src.length; i++) { if (n === cap) break; o[n] = src[i]; n = ((n | 0) + 1) | 0; } return n; }
function bench(name: string, f: () => number, ops: number = N): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op ", (ops / 1e6 / (best / 1000)).toFixed(0).padStart(7), "MB/s r=", r);
}
bench("o[i]=src[i]", () => w1(data, out));
bench("o[n]=..; n++", () => w2(data, out));
bench("o[n]=..; n=((n|0)+1)|0", () => w3(data, out));
bench("o[n|0]=..;", () => w4(data, out));
bench("src[i]|0; n=(n+1)|0", () => w5(data, out));
bench("-> Int32Array", () => w6(data, out32));
bench("L=src.length local", () => w7(data, out));
bench("with o.length check", () => w8(data, out));
bench("with cap local check", () => w9(data, out));
