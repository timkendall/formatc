import { Worker } from "node:worker_threads";
import { helper, K_CYCLIC } from "./b.ts";
export const K_LEAF = 7;
const state = { n: 0, arr: new Int32Array(16) };
export function three(i: number): number { return state.arr[i & 15] + state.arr[(i + 1) & 15] + state.n; }
function rec(n: number): number { return n <= 0 ? 0 : 1 + rec(n - 1); }
export function sw(k: number): number { switch (k) { case K_CYCLIC: return 1; default: return 2; } }
const shared = new Uint8Array(1024);
export function scan(n: number): number { let s = 0; for (let i = 0; i < n; i++) s = (s + (shared[i] | 0)) | 0; return s; }
const dv = new DataView(new ArrayBuffer(16));
export function rd(): number { return dv.getUint32(0, true); }
if (process.argv.length > 99) new Worker(new URL(import.meta.url));
console.log(three(3) + rec(5) + sw(helper()) + scan(10) + rd());
