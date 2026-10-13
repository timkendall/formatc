import { Worker, isMainThread } from "node:worker_threads";
import * as fs from "node:fs";
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const REPS = 5;
function a_or0(buf: Uint8Array): number { let s = 0; for (let i = 0; i < buf.length; i++) s = (s + buf[i]) | 0; return s; }
function b_sor0(buf: Uint8Array): number { let s = 0; for (let i = 0; i < buf.length; i++) s = ((s | 0) + buf[i]) | 0; return s; }
function c_xor0(buf: Uint8Array): number { let s = 0; for (let i = 0; i < buf.length; i++) s = (s + (buf[i] | 0)) | 0; return s; }
function d_both(buf: Uint8Array): number { let s = 0; for (let i = 0; i < buf.length; i++) s = ((s | 0) + (buf[i] | 0)) | 0; return s; }
function e_ret(buf: Uint8Array): number { let s = 0; for (let i = 0; i < buf.length; i++) s = ((s | 0) + (buf[i] | 0)) | 0; return s | 0; }
function f_plain(buf: Uint8Array): number { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i]; return s; }
function g_plainfield(buf: Uint8Array): number { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] | 0; return s; }
function h_arrstate(buf: Uint8Array, st: Int32Array): number { st[0] = 0; for (let i = 0; i < buf.length; i++) st[0] = (st[0] + buf[i]) | 0; return st[0]; }
function i_sub(buf: Uint8Array): number { let s = 0; for (let i = 0; i < buf.length; i++) s = (s - buf[i]) | 0; return s; }
function j_mask(buf: Uint8Array): number { let s = 0; for (let i = 0; i < buf.length; i++) s = ((s | 0) + (buf[i] | 0)) & 0xffff; return s; }
function k_cnt(buf: Uint8Array): number { let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++; return n; }
function l_cnt0(buf: Uint8Array): number { let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n = (n + 1) | 0; return n; }
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(16), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s  r=", r);
}
const st = new Int32Array(1);
bench("a (s+b)|0", () => a_or0(data));
bench("b (s|0)+b|0", () => b_sor0(data));
bench("c s+(b|0)|0", () => c_xor0(data));
bench("d (s|0)+(b|0)|0", () => d_both(data));
bench("e d + ret|0", () => e_ret(data));
bench("f s+=b", () => f_plain(data));
bench("g s+=b|0", () => g_plainfield(data));
bench("h st[0] acc", () => h_arrstate(data, st));
bench("i s-b|0", () => i_sub(data));
bench("j &0xffff", () => j_mask(data));
bench("k cnt n++", () => k_cnt(data));
bench("l cnt n=n+1|0", () => l_cnt0(data));
if (process.argv[2] === "spawn" && isMainThread) { new Worker(new URL(import.meta.url)); }

