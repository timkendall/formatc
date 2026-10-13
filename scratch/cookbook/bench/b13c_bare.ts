import * as fs from "node:fs";
const REPS = 5;
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
function id(x: number): number { return x; }
function bigId(x: number): number { let r = x; for (let i = 0; i < 1; i++) r = (r * 3) % 1000; return r; }
function t_cmp(b: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const c = b[i]; if (c === 10) n++; } return n; }
function t_callarg(b: Uint8Array): number { let s = 0; for (let i = 0; i < b.length; i++) s = ((s | 0) + (id(b[i]) | 0)) | 0; return s; }
function t_callarg2(b: Uint8Array): number { let s = 0; for (let i = 0; i < b.length; i++) s = ((s | 0) + (bigId(b[i]) | 0)) | 0; return s; }
function t_callargOr(b: Uint8Array): number { let s = 0; for (let i = 0; i < b.length; i++) s = ((s | 0) + (bigId(b[i] | 0) | 0)) | 0; return s; }
function t_ret(b: Uint8Array, i: number): number { return b[i]; }
function t_retLoop(b: Uint8Array): number { let s = 0; for (let i = 0; i < b.length; i++) s = ((s | 0) + (t_ret(b, i) | 0)) | 0; return s; }
function t_assignLet(b: Uint8Array): number { let c = 0; let s = 0; for (let i = 0; i < b.length; i++) { c = b[i]; s = ((s | 0) + (c | 0)) | 0; } return s; }
function t_switch(b: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { switch (b[i]) { case 10: n++; break; case 32: n += 2; break; default: break; } } return n; }
function t_switchc(b: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const c = b[i]; switch (c) { case 10: n++; break; case 32: n += 2; break; default: break; } } return n; }
function t_max(b: Uint8Array): number { let m = 0; for (let i = 0; i < b.length; i++) m = Math.max(m, b[i]); return m; }
function t_cond(b: Uint8Array): number { let s = 0; for (let i = 0; i < b.length; i++) s += i > 5 ? b[i] : 0; return s; }
function t_push(b: Uint8Array, a: number[]): number { a.length = 0; for (let i = 0; i < 1000000; i++) a.push(b[i]); return a.length; }
function t_tbl(b: Uint8Array, t: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const k = t[b[i]]; if (k === 2) n++; } return n; }
function t_tblc(b: Uint8Array, t: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const c = b[i]; const k = t[c]; if (k === 2) n++; } return n; }
function t_store_field(b: Uint8Array, o: { v: number }): number { for (let i = 0; i < b.length; i++) o.v = b[i]; return o.v; }
function t_i32read(b: Int32Array, o: Int32Array): number { for (let i = 0; i < b.length; i++) o[i] = b[i]; return o[5]; }
function t_f64read(b: Float64Array, o: Float64Array): number { for (let i = 0; i < b.length; i++) o[i] = b[i]; return o[5]; }
function t_i32ret(b: Int32Array, i: number): number { return b[i]; }
function t_i32retLoop(b: Int32Array): number { let s = 0; for (let i = 0; i < b.length; i++) s = ((s | 0) + (t_i32ret(b, i) | 0)) | 0; return s; }
function t_arrRead(b: number[], o: number[]): number { for (let i = 0; i < b.length; i++) o[i] = b[i]; return o[5]; }
function bench(name: string, f: () => number, ops: number = N): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op ", (ops / 1e6 / (best / 1000)).toFixed(0).padStart(7), "MB/s r=", r);
}
const tb = new Uint8Array(256); tb[101] = 2;
const a: number[] = [];
const i32 = new Int32Array(N >> 2), i32o = new Int32Array(N >> 2), f64 = new Float64Array(N >> 3), f64o = new Float64Array(N >> 3);
const na: number[] = []; for (let i = 0; i < 2000000; i++) na.push(i); const nao: number[] = []; for (let i = 0; i < 2000000; i++) nao.push(0);
bench("const c=b[i]; c===10", () => t_cmp(data));
bench("f(b[i]) inlined small", () => t_callarg(data));
bench("bigId(b[i]) ", () => t_callarg2(data));
bench("bigId(b[i]|0) ", () => t_callargOr(data));
bench("return b[i] via fn", () => t_retLoop(data));
bench("c = b[i] (let)", () => t_assignLet(data));
bench("switch (b[i])", () => t_switch(data));
bench("const c=b[i]; switch(c)", () => t_switchc(data));
bench("Math.max(m, b[i])", () => t_max(data));
bench("cond ? b[i] : 0", () => t_cond(data));
bench("arr.push(b[i])", () => t_push(data, a), 1000000);
bench("t[b[i]]", () => t_tbl(data, tb));
bench("const c=b[i]; t[c]", () => t_tblc(data, tb));
bench("obj.v = b[i]", () => t_store_field(data, { v: 0 }));
bench("i32: o[i]=b[i]", () => t_i32read(i32, i32o), N >> 2);
bench("f64: o[i]=b[i]", () => t_f64read(f64, f64o), N >> 3);
bench("i32 return b[i]", () => t_i32retLoop(i32), N >> 2);
bench("number[]: o[i]=b[i]", () => t_arrRead(na, nao), 2000000);
