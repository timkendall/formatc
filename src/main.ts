// `bun fmt`, compiled with scriptc: `scriptc build src/main.ts -o bin/fmt`. Also runs under `node src/main.ts`.
import { isMainThread, Worker } from "node:worker_threads";
import { main } from "./driver/entry.ts";
import { setSpawnWorker } from "./driver/pool.ts";
import { setSpawnScanWorker } from "./driver/scan.ts";
import { runWorker } from "./driver/worker.ts";
import type { WorkerInit } from "./driver/worker.ts";
import { writeAll } from "./driver/entry.ts";

// A worker that dies would leave the main thread waiting for its report for ever.
function watch(worker: Worker): Worker {
  worker.on("error", (e: Error) => {
    // Never read `e.stack`: any `.stack` read makes scriptc track the call stack in every function (-33% in the parser).
    writeAll(2, Buffer.from("error: a worker failed: " + e.message + "\n"));
    process.exit(2);
  });
  return worker;
}

if (isMainThread) {
  setSpawnWorker((data: WorkerInit) => watch(new Worker(new URL(import.meta.url), { workerData: data })));
  setSpawnScanWorker((scan, ctrl) => watch(new Worker(new URL(import.meta.url), { workerData: { kind: 1, scan: scan, ctrl: ctrl, bufs: null, id: 0, cwd: "", writes: false, detail: false, chunk: 1, compareTo: "", compareRoot: "", dumpTo: "" } })));
  main(process.argv.slice(2));
} else {
  runWorker();
}
