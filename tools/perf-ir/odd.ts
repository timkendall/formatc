// markOddBlocks / width scan micro-benchmark in worker mode. node tools/perf-ir/odd.ts file | compiled: /tmp/pir-odd file
import { Worker } from "node:worker_threads";
import * as fs from "node:fs";
import { markOddBlocks } from "../../src/format/ir/width.ts";
let neverWorker: Worker | null = null;
if (process.argv.length > 99) neverWorker = new Worker(new URL(import.meta.url));
const src = new Uint8Array(fs.readFileSync(process.argv[2]));
const out = new Uint8Array((src.length >> 6) + 4);
let best = 1e18;
let r = 0;
for (let rep = 0; rep < 20; rep++) {
  const t0 = performance.now();
  for (let k = 0; k < 20; k++) r = (r + markOddBlocks(src, out)) | 0;
  const dt = performance.now() - t0;
  if (dt < best) best = dt;
}
console.log(src.length + " bytes: " + ((best * 1e6) / (20 * src.length)).toFixed(3) + " ns/byte r=" + r);
