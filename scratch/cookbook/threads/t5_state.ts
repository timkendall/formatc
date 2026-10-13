import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import * as fs from "node:fs";
import { lexKernel } from "./lexkernel.ts";

let moduleCounter = 0;            // per-worker module state?
const moduleScratch = new Int32Array(4);
interface Job { id: number; sab: SharedArrayBuffer; }

if (isMainThread) {
  moduleCounter = 100;
  moduleScratch[0] = 7;
  const sab = new SharedArrayBuffer(1 << 20);
  const shared = new Uint8Array(sab);
  const data = fs.readFileSync("/tmp/cb/corpus.bin");
  for (let i = 0; i < shared.length; i++) shared[i] = data[i] | 0;
  let done = 0;
  const n = 3;
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { id: i, sab } as Job });
    w.on("message", (m: string) => { console.log(m); if (++done === n) console.log("main moduleCounter =", moduleCounter, "scratch[0] =", moduleScratch[0]); });
  }
} else {
  const job = workerData as Job;
  moduleCounter += job.id + 1;
  moduleScratch[0] = 1000 + job.id;
  // shared-backed Uint8Array used as lexer input + as read target
  const view = new Uint8Array(job.sab);
  const out = new Int32Array(65536 * 3 + 3);
  let best = 1e18; let tk = 0;
  for (let r = 0; r < 5; r++) { const t0 = performance.now(); tk = lexKernel(view, view.length, out); const dt = performance.now() - t0; if (dt < best) best = dt; }
  // also: readSync into shared view
  const fd = fs.openSync("/tmp/cb/corpus.bin", "r");
  const nread = fs.readSync(fd, view, 0, view.length, 0);
  fs.closeSync(fd);
  parentPort!.postMessage(`worker ${job.id}: moduleCounter=${moduleCounter} scratch[0]=${moduleScratch[0]} lex(SAB view 1MB)=${tk} tokens, ${(view.length / 1e6 / (best / 1000)).toFixed(0)} MB/s; readSync into SAB bytes=${nread}`);
}
