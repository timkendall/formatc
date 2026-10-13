import { Worker, isMainThread, workerData } from "node:worker_threads";

interface Job { sab: SharedArrayBuffer; id: number; iters: number; }
if (isMainThread) {
  const sab = new SharedArrayBuffer(64);
  const ctr = new Int32Array(sab);
  const n = 4;
  const iters = 1_000_000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) new Worker(new URL(import.meta.url), { workerData: { sab, id: i, iters } as Job });
  // wait for completion with Atomics.wait on slot 1 (workers notify when slot 1 reaches n)
  while (true) {
    const done = Atomics.load(ctr, 1);
    if (done >= n) break;
    Atomics.wait(ctr, 1, done, 1000);
  }
  console.log("counter =", Atomics.load(ctr, 0), "expected", n * iters, "done in", (performance.now() - t0).toFixed(1), "ms");
} else {
  const job = workerData as Job;
  const ctr = new Int32Array(job.sab);
  for (let i = 0; i < job.iters; i++) Atomics.add(ctr, 0, 1);
  Atomics.add(ctr, 1, 1);
  Atomics.notify(ctr, 1);
}
