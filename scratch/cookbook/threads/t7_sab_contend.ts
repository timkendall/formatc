import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import * as fs from "node:fs";
import { lexKernel } from "./lexkernel.ts";
interface Job { id: number; sab: SharedArrayBuffer; mode: string; }
function sum(a: Uint8Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = ((s | 0) + (a[i] | 0)) | 0; return s; }
if (isMainThread) {
  const n = Number(process.argv[2] || "1");
  const mode = process.argv[3] || "lex";
  const sab = new SharedArrayBuffer(1 << 20);
  const shared = new Uint8Array(sab);
  const data = fs.readFileSync("/tmp/cb/corpus.bin");
  for (let i = 0; i < shared.length; i++) shared[i] = data[i] | 0;
  let done = 0;
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { id: i, sab, mode } as Job });
    w.on("message", (m: string) => { console.log(m); done++; });
  }
} else {
  const job = workerData as Job;
  const src: Uint8Array = job.mode.endsWith("copy") ? new Uint8Array(new Uint8Array(job.sab)) : new Uint8Array(job.sab);
  const out = new Int32Array(65536 * 3 + 3);
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < 5; rep++) {
    const t0 = performance.now();
    r = job.mode.startsWith("lex") ? lexKernel(src, src.length, out) : sum(src);
    const dt = performance.now() - t0; if (dt < best) best = dt;
  }
  parentPort!.postMessage(`worker ${job.id} ${job.mode}: ${(src.length / 1e6 / (best / 1000)).toFixed(0)} MB/s (r=${r})`);
}
