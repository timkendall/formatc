// Path list shared via @scriptc/threads publish() (string[]) + SAB atomic claiming; results via postMessage.
// usage: t4_publish <threads> <msgmode: none|perfile|batch>
import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { publish } from "@scriptc/threads";
import * as fs from "node:fs";
import { lexKernel } from "./lexkernel.ts";

const ROOT = "/Users/timkendall/Developer/lab/scriptc-formatter/bench/vscode/";
interface Job { id: number; paths: string[]; ctrl: SharedArrayBuffer; msgmode: string; }
interface FileResult { idx: number; bytes: number; tokens: number; }

function runWorker(job: Job): void {
  const ctrl = new Int32Array(job.ctrl);
  const paths = job.paths;
  const tokOut = new Int32Array(65536 * 3 + 3);
  let scratch = Buffer.alloc(1 << 20);
  let totBytes = 0, totTokens = 0, nfiles = 0;
  const batch: FileResult[] = [];
  const nf = paths.length;
  while (true) {
    const idx = Atomics.add(ctrl, 0, 1);
    if (idx >= nf) break;
    let fd = -1;
    try { fd = fs.openSync(ROOT + paths[idx], "r"); } catch (e) { continue; }
    const size = fs.fstatSync(fd).size;
    if (size > scratch.length) scratch = Buffer.alloc(size * 2);
    let got = 0;
    while (got < size) { const n = fs.readSync(fd, scratch, got, size - got, got); if (n <= 0) break; got += n; }
    fs.closeSync(fd);
    const tk = lexKernel(scratch, got, tokOut);
    totBytes += got; totTokens += tk; nfiles++;
    if (job.msgmode === "perfile") parentPort!.postMessage({ idx, bytes: got, tokens: tk } as FileResult);
    else if (job.msgmode === "batch") batch.push({ idx, bytes: got, tokens: tk });
  }
  if (job.msgmode === "batch") parentPort!.postMessage(batch);
  parentPort!.postMessage({ idx: -1, bytes: totBytes, tokens: totTokens } as FileResult);
}

if (isMainThread) {
  const nthreads = Number(process.argv[2] || "1");
  const msgmode = process.argv[3] || "none";
  const t0 = performance.now();
  const text = fs.readFileSync("/tmp/vscode-files.txt", "utf8");
  const paths = text.split("\n").filter((s) => s.length > 0);
  publish(paths);
  const t1 = performance.now();
  const ctrl = new SharedArrayBuffer(64);
  let finished = 0, bytes = 0, tokens = 0, msgs = 0, seenFiles = 0;
  for (let i = 0; i < nthreads; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { id: i, paths, ctrl, msgmode } as Job });
    w.on("message", (m: FileResult | FileResult[]) => {
      msgs++;
      if (Array.isArray(m)) { seenFiles += m.length; return; }
      if (m.idx === -1) {
        bytes += m.bytes; tokens += m.tokens; finished++;
        if (finished === nthreads) {
          const t2 = performance.now();
          console.log(`threads=${nthreads} msg=${msgmode} paths=${paths.length} setup+publish=${(t1 - t0).toFixed(1)}ms work=${(t2 - t1).toFixed(1)}ms bytes=${bytes} tokens=${tokens} msgs=${msgs} perfileSeen=${seenFiles} => ${(bytes / 1e6 / ((t2 - t1) / 1000)).toFixed(0)} MB/s`);
        }
      } else seenFiles++;
    });
  }
} else {
  runWorker(workerData as Job);
}
