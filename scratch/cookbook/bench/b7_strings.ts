import * as fs from "node:fs";
const REPS = 5;
const buf = fs.readFileSync("/tmp/cb/corpus.bin");
const data: Uint8Array = buf;
const N = data.length;
const dec = new TextDecoder();
const enc = new TextEncoder();
const text: string = buf.toString("utf8");
const ascii: string = buf.toString("latin1");
function ccSum(s: string): number { let t = 0; for (let i = 0; i < s.length; i++) t = ((t | 0) + (s.charCodeAt(i) | 0)) | 0; return t; }
function ccSumN(s: string): number { let t = 0; const n = s.length; for (let i = 0; i < n; i++) t = ((t | 0) + (s.charCodeAt(i) | 0)) | 0; return t; }
function idxSum(s: string): number { let t = 0; for (let i = 0; i < s.length; i++) if (s[i] === "e") t++; return t; }
function sliceCount(s: string, k: number): number { let t = 0; for (let i = 0; i < k; i++) t += s.slice(i, i + 8).length; return t; }
function substrEq(s: string, k: number): number { let t = 0; for (let i = 0; i < k; i++) if (s.slice(i, i + 3) === "fun") t++; return t; }
function startsWithCnt(s: string, k: number): number { let t = 0; for (let i = 0; i < k; i++) if (s.startsWith("fun", i)) t++; return t; }
function concatPlus(k: number): number { let s = ""; for (let i = 0; i < k; i++) s += "ab"; return s.length; }
function concatChar(k: number): number { let s = ""; for (let i = 0; i < k; i++) s += String.fromCharCode(97 + (i & 15)); return s.length; }
function concatTemplate(k: number): number { let s = 0; for (let i = 0; i < k; i++) s += `${i}:${i + 1}`.length; return s; }
function fromCC(k: number): number { let t = 0; for (let i = 0; i < k; i++) t += String.fromCharCode(97 + (i & 15)).length; return t; }
function arrJoin(k: number): number { const a: string[] = []; for (let i = 0; i < k; i++) a.push("ab"); return a.join("").length; }
function mapLookup(m: Map<string, number>, s: string, k: number): number { let t = 0; for (let i = 0; i < k; i++) t += m.get(s.slice(i % 1000, (i % 1000) + 3)) ?? 0; return t; }
function eqLit(s: string, k: number): number { let t = 0; const key = s.slice(5, 13); for (let i = 0; i < k; i++) if (key === "function") t++; return t; }
function eqDyn(a: string, b: string, k: number): number { let t = 0; for (let i = 0; i < k; i++) if (a === b) t++; return t; }
function bench(name: string, f: () => number, ops: number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op ", (ops / 1e6 / (best / 1000)).toFixed(0).padStart(7), "Mop/s  r=", r);
}
const M = 5_000_000;
console.log("text.length", text.length, "ascii.length", ascii.length);
bench("charCodeAt utf8 str", () => ccSum(text), text.length);
bench("charCodeAt latin1 str", () => ccSum(ascii), ascii.length);
bench("charCodeAt n-local", () => ccSumN(text), text.length);
bench("s[i]===\"e\"", () => idxSum(text), text.length);
bench("slice(i,i+8)", () => sliceCount(text, M), M);
bench("slice(i,i+3)===lit", () => substrEq(text, M), M);
bench("startsWith(lit,i)", () => startsWithCnt(text, M), M);
bench("s += \"ab\"", () => concatPlus(M), M);
bench("s += fromCharCode", () => concatChar(M), M);
bench("template `${i}:${i+1}`", () => concatTemplate(M), M);
bench("fromCharCode alone", () => fromCC(M), M);
bench("push+join", () => arrJoin(M), M);
const km = new Map<string, number>(); for (const w of ["fun", "let", "var", "con", "ret", "imp", "exp", "cla", "if(", "for"]) km.set(w, 1);
bench("Map<string> get(slice)", () => mapLookup(km, text, M), M);
bench("str === lit (same)", () => eqLit(text, M * 4), M * 4);
bench("str === str", () => eqDyn(text.slice(0, 20000), text.slice(0, 20000), M), M);
bench("decode utf8 41MB", () => dec.decode(data).length, N);
bench("Buffer.toString utf8", () => buf.toString("utf8").length, N);
bench("Buffer.toString latin1", () => buf.toString("latin1").length, N);
bench("encode utf8 41MB", () => enc.encode(text).length, N);
bench("Buffer.from(text)", () => Buffer.from(text, "utf8").length, N);
bench("split(\"\\n\")", () => text.split("\n").length, N);
bench("indexOf(\"function\") scan", () => { let c = 0, p = 0; while (true) { p = text.indexOf("function", p); if (p < 0) break; c++; p++; } return c; }, N);
bench("buf.indexOf(\"function\")", () => { let c = 0, p = 0; while (true) { p = buf.indexOf("function", p); if (p < 0) break; c++; p++; } return c; }, N);
