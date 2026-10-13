import * as fs from "node:fs";
const REPS = 5;
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const out = new Uint8Array(N + 64);
function a1(src: Uint8Array, o: Uint8Array): number { let n = 0; for (let i = 0; i < src.length; i++) { o[n] = src[i] | 0; n = ((n | 0) + 1) | 0; } return n; }
function a2(src: Uint8Array, o: Uint8Array): number { let n = 0; for (let i = 0; i < src.length; i++) { const c = src[i] | 0; o[n] = c; n = ((n | 0) + 1) | 0; } return n; }
function a3(src: Uint8Array, o: Uint8Array): number { for (let i = 0; i < src.length; i++) { o[i] = src[i] | 0; } return o[5] | 0; }
function a4(src: Uint8Array, o: Uint8Array): number { for (let i = 0; i < src.length; i++) { o[i] = (src[i] | 0) & 255; } return o[5] | 0; }
function a5(src: Uint8Array, o: Uint8Array): number { for (let i = 0; i < src.length; i++) { const c: number = src[i]; o[i] = c; } return o[5] | 0; }
function a6(src: Uint8Array, o: Uint8Array): number { for (let i = 0; i < src.length; i++) { o[i] = src[i]!; } return o[5] | 0; }
function a7(src: Uint8Array, o: Uint8Array): number { for (let i = 0; i < src.length; i++) { o[i] = src[i] as number; } return o[5] | 0; }
function a8(src: Uint8Array, o: Uint8Array): number { for (let i = 0; i < src.length; i++) { o[i] = i & 255; } return o[5] | 0; }
function a9(src: Uint8Array, o: Uint8Array): number { for (let i = 0; i < src.length; i++) { o[i] = 65; } return o[5] | 0; }
function b1(src: Uint8Array, o: Uint8Array): number { let s = 0; for (let i = 0; i < src.length; i++) { s = ((s | 0) + (src[i] | 0)) | 0; o[i] = s & 255; } return s; }
function b2(src: Uint8Array, o: Uint8Array): number { let s = 0; for (let i = 0; i < src.length; i++) { const c = src[i] | 0; s = ((s | 0) + c) | 0; o[i] = s; } return s; }
function bench(name: string, f: () => number, ops: number = N): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op ", (ops / 1e6 / (best / 1000)).toFixed(0).padStart(7), "MB/s r=", r);
}
bench("o[n]=src[i]|0; n=(n|0)+1", () => a1(data, out));
bench("c=src[i]|0; o[n]=c", () => a2(data, out));
bench("o[i]=src[i]|0", () => a3(data, out));
bench("o[i]=(src[i]|0)&255", () => a4(data, out));
bench("c:number=src[i]; o[i]=c", () => a5(data, out));
bench("o[i]=src[i]!", () => a6(data, out));
bench("o[i]=src[i] as number", () => a7(data, out));
bench("o[i]=i&255", () => a8(data, out));
bench("o[i]=65", () => a9(data, out));
bench("s chain, o[i]=s&255", () => b1(data, out));
bench("s chain, o[i]=s", () => b2(data, out));
