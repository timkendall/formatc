import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) {
  const n = Number(process.argv[2] || "1");
  const t0 = performance.now();
  let done = 0;
  let firstOnline = 0;
  let allOnline = 0;
  let online = 0;
  const workers: Worker[] = [];
  for (let i = 0; i < n; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { id: i } });
    w.on("online", () => { online++; if (online === 1) firstOnline = performance.now() - t0; if (online === n) allOnline = performance.now() - t0; });
    w.on("message", (m: number) => {
      done++;
      if (done === n) console.log(`workers=${n} spawn+run+msg all done: ${(performance.now() - t0).toFixed(2)} ms (first online ${firstOnline.toFixed(2)}, all online ${allOnline.toFixed(2)})`);
    });
    workers.push(w);
  }
} else {
  parentPort!.postMessage((workerData as { id: number }).id);
}
