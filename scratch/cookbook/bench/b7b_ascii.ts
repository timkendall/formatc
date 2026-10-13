import * as fs from "node:fs";
const REPS = 5;
const buf = fs.readFileSync("/tmp/cb/corpus.bin");
for (let i = 0; i < buf.length; i++) if (buf[i] >= 128) buf[i] = 63;
const text: string = buf.toString("latin1");
function ccSum(s: string): number { let t = 0; for (let i = 0; i < s.length; i++) t = ((t | 0) + (s.charCodeAt(i) | 0)) | 0; return t; }
function ccSumN(s: string): number { let t = 0; const n = s.length; for (let i = 0; i < n; i++) t = ((t | 0) + (s.charCodeAt(i) | 0)) | 0; return t; }
function ccSumNoOr(s: string): number { let t = 0; const n = s.length; for (let i = 0; i < n; i++) t += s.charCodeAt(i); return t; }
function idxSum(s: string): number { let t = 0; for (let i = 0; i < s.length; i++) if (s[i] === "e") t++; return t; }
function sliceCount(s: string, k: number): number { let t = 0; for (let i = 0; i < k; i++) t += s.slice(i, i + 8).length; return t; }
function substrEq(s: string, k: number): number { let t = 0; for (let i = 0; i < k; i++) if (s.slice(i, i + 3) === "fun") t++; return t; }
function bench(name: string, f: () => number, ops: number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op ", (ops / 1e6 / (best / 1000)).toFixed(0).padStart(7), "Mop/s  r=", r);
}
const M = 5_000_000;
bench("ASCII charCodeAt", () => ccSum(text), text.length);
bench("ASCII charCodeAt n-local", () => ccSumN(text), text.length);
bench("ASCII charCodeAt n-local+=", () => ccSumNoOr(text), text.length);
bench("ASCII s[i]===\"e\"", () => idxSum(text), text.length);
bench("ASCII slice(i,i+8)", () => sliceCount(text, M), M);
bench("ASCII slice(i,i+3)===lit", () => substrEq(text, M), M);
