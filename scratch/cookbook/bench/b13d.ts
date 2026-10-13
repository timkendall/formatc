import * as fs from "node:fs";
const REPS = 5;
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
function t_push(b: Uint8Array, a: number[]): number { a.length = 0; for (let i = 0; i < 1000000; i++) a.push(b[i] | 0); return a.length; }
function t_pushBang(b: Uint8Array, a: number[]): number { a.length = 0; for (let i = 0; i < 1000000; i++) a.push(b[i]!); return a.length; }
function t_store_field(b: Uint8Array, o: { v: number }): number { for (let i = 0; i < b.length; i++) o.v = b[i] | 0; return o.v; }
class W { v: number = 0; }
function t_store_class(b: Uint8Array, o: W): number { for (let i = 0; i < b.length; i++) o.v = b[i] | 0; return o.v; }
function t_i32read(b: Int32Array, o: Int32Array): number { for (let i = 0; i < b.length; i++) o[i] = b[i] | 0; return o[5]; }
function t_u32read(b: Uint32Array, o: Uint32Array): number { for (let i = 0; i < b.length; i++) o[i] = b[i]!; return o[5]; }
function t_f64read(b: Float64Array, o: Float64Array): number { for (let i = 0; i < b.length; i++) o[i] = b[i]!; return o[5]; }
function t_f64read2(b: Float64Array, o: Float64Array): number { for (let i = 0; i < b.length; i++) o[i] = b[i] + 0; return o[5]; }
function t_arr_get(b: number[], i: number): number { return b[i]; }
function t_arr(b: number[], o: number[]): number { for (let i = 0; i < b.length; i++) o[i] = b[i]; return o[5]; }
function bench(name: string, f: () => number, ops: number = N): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op ", (ops / 1e6 / (best / 1000)).toFixed(0).padStart(7), "MB/s r=", r);
}
const a: number[] = [];
const i32 = new Int32Array(N >> 2), i32o = new Int32Array(N >> 2), f64 = new Float64Array(N >> 3), f64o = new Float64Array(N >> 3);
const u32 = new Uint32Array(N >> 2), u32o = new Uint32Array(N >> 2);
bench("arr.push(b[i]|0)", () => t_push(data, a), 1000000);
bench("arr.push(b[i]!)", () => t_pushBang(data, a), 1000000);
bench("obj.v = b[i]|0", () => t_store_field(data, { v: 0 }));
bench("class.v = b[i]|0", () => t_store_class(data, new W()));
bench("i32: o[i]=b[i]|0", () => t_i32read(i32, i32o), N >> 2);
bench("u32: o[i]=b[i]!", () => t_u32read(u32, u32o), N >> 2);
bench("f64: o[i]=b[i]!", () => t_f64read(f64, f64o), N >> 3);
bench("f64: o[i]=b[i]+0", () => t_f64read2(f64, f64o), N >> 3);
