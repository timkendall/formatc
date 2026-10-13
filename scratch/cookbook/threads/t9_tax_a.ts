import * as fs from "node:fs";
import { lexKernel } from "./lexkernel.ts";
const data: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const out = new Int32Array(65536 * 3 + 3);
let best = 1e18; let r = 0;
for (let rep = 0; rep < 5; rep++) { const t0 = performance.now(); r = lexKernel(data, data.length, out); const dt = performance.now() - t0; if (dt < best) best = dt; }
console.log("lexKernel", (data.length / 1e6 / (best / 1000)).toFixed(0), "MB/s tokens=", r);
