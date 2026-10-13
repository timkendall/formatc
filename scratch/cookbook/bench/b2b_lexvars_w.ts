import { Worker, isMainThread } from "node:worker_threads";
import * as fs from "node:fs";
import { lexFree_plain, lexFree_or0, lexFree_idxor0, lexFree_int32, lexFree_ntplain, lexFree_ntplain2, lexFree_full0 } from "./gen/lexvars.ts";
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const REPS = 5;
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(16), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s  tokens=", r);
}
const out = new Int32Array(3 * 12_000_000);
bench("plain", () => lexFree_plain(data, out));
bench("or0", () => lexFree_or0(data, out));
bench("idx|0", () => lexFree_idxor0(data, out));
bench("int32", () => lexFree_int32(data, out));
bench("ntplain", () => lexFree_ntplain(data, out));
bench("ntplain2", () => lexFree_ntplain2(data, out));
bench("full0", () => lexFree_full0(data, out));
if (process.argv[2] === "spawn" && isMainThread) { new Worker(new URL(import.meta.url)); }

