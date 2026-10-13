// Work-distribution prototype: N workers atomically claim file indices, read + lex each file.
// usage: t3_distribute <threads> <pathmode: sab|pub> <claim: atomic|static> [chunk]
import { Worker, isMainThread, workerData } from "node:worker_threads";
import * as fs from "node:fs";
import { lexKernel } from "./lexkernel.ts";

const ROOT = "/Users/timkendall/Developer/lab/scriptc-formatter/bench/vscode/";

interface Job {
  id: number;
  nthreads: number;
  claim: string;
  chunk: number;
  mode: number;
  nfiles: number;
  pathBytes: SharedArrayBuffer; // concatenated path bytes
  pathOffs: SharedArrayBuffer;  // Int32 offsets, nfiles+1 entries
  ctrl: SharedArrayBuffer;      // Int32 [0]=next file index, [1]=done count
  results: SharedArrayBuffer;   // Float64 per-thread slots: [bytes, tokens, files, ms]
}

function runWorker(job: Job): void {
  const t0 = performance.now();
  const bytes = new Uint8Array(job.pathBytes);
  const offs = new Int32Array(job.pathOffs);
  const ctrl = new Int32Array(job.ctrl);
  const res = new Float64Array(job.results);
  const tokOut = new Int32Array(65536 * 3 + 3);
  let scratch = Buffer.alloc(job.mode >= 2 ? 1 << 18 : 1 << 20);
  const rootLen = ROOT.length;
  let totBytes = 0;
  let totTokens = 0;
  let nfiles = 0;
  const nf = job.nfiles;
  const chunk = job.chunk;
  let next = job.id; // static partition cursor
  let chunkEnd = 0;
  let cur = 0;
  while (true) {
    let idx = -1;
    if (job.claim === "atomic") {
      if (cur >= chunkEnd) {
        cur = Atomics.add(ctrl, 0, chunk);
        chunkEnd = cur + chunk;
      }
      if (cur >= nf) break;
      idx = cur;
      cur = cur + 1;
    } else {
      if (next >= nf) break;
      idx = next;
      next = next + job.nthreads;
    }
    const a = offs[idx * 2] | 0;
    const b = offs[idx * 2 + 1] | 0;
    const path = Buffer.from(bytes.buffer, a, b - a).toString("utf8");
    let fd = -1;
    try { fd = fs.openSync(ROOT + path, "r"); } catch (e) { continue; }
    let got = 0;
    if (job.mode === 2 || job.mode === 3) {
      // no fstat: one big read; a short read (< buffer) means EOF
      got = fs.readSync(fd, scratch, 0, scratch.length, 0);
      while (got === scratch.length) {
        const bigger = Buffer.alloc(scratch.length * 2);
        scratch.copy(bigger, 0, 0, got);
        scratch = bigger;
        const n = fs.readSync(fd, scratch, got, scratch.length - got, got);
        got += n;
      }
    } else {
      const st = fs.fstatSync(fd);
      const size = st.size;
      if (size > scratch.length) scratch = Buffer.alloc(size * 2);
      while (got < size) {
        const n = fs.readSync(fd, scratch, got, size - got, got);
        if (n <= 0) break;
        got += n;
      }
    }
    fs.closeSync(fd);
    totBytes += got;
    if (job.mode !== 1 && job.mode !== 2) totTokens += lexKernel(scratch, got, tokOut);
    nfiles++;
  }
  res[job.id * 4] = totBytes;
  res[job.id * 4 + 1] = totTokens;
  res[job.id * 4 + 2] = nfiles;
  res[job.id * 4 + 3] = performance.now() - t0;
  Atomics.add(ctrl, 1, 1);
  Atomics.notify(ctrl, 1);
}

if (isMainThread) {
  const nthreads = Number(process.argv[2] || "1");
  const claim = process.argv[4] || "atomic";
  const chunk = Number(process.argv[5] || "1");
  const mode = process.argv[6] === "readonly" ? 1 : process.argv[6] === "nostat-readonly" ? 2 : process.argv[6] === "nostat" ? 3 : 0;
  const tStart = performance.now();
  const list = fs.readFileSync("/tmp/vscode-files.txt");
  // split on \n into shared byte blob + offsets
  const pathBytes = new SharedArrayBuffer(list.length);
  const pb = new Uint8Array(pathBytes);
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i] | 0;
    pb[i] = c;
    if (c === 10) count++;
  }
  const pairs = new SharedArrayBuffer((count * 2 + 2) * 4);
  const pp = new Int32Array(pairs);
  let nf = 0;
  let st = 0;
  for (let i = 0; i < list.length; i++) {
    if ((list[i] | 0) === 10) {
      if (i > st) { pp[nf * 2] = st; pp[nf * 2 + 1] = i; nf++; }
      st = i + 1;
    }
  }
  const ctrl = new SharedArrayBuffer(64);
  const cv = new Int32Array(ctrl);
  const results = new SharedArrayBuffer(nthreads * 4 * 8);
  const tSetup = performance.now();
  for (let i = 0; i < nthreads; i++) {
    const job: Job = { id: i, nthreads, claim, chunk, mode, nfiles: nf, pathBytes, pathOffs: pairs, ctrl, results };
    new Worker(new URL(import.meta.url), { workerData: job });
  }
  while (true) {
    const done = Atomics.load(cv, 1);
    if (done >= nthreads) break;
    Atomics.wait(cv, 1, done, 5000);
  }
  const tEnd = performance.now();
  const r = new Float64Array(results);
  let bytes = 0, tokens = 0, files = 0, maxMs = 0;
  for (let i = 0; i < nthreads; i++) { bytes += r[i * 4]; tokens += r[i * 4 + 1]; files += r[i * 4 + 2]; if (r[i * 4 + 3] > maxMs) maxMs = r[i * 4 + 3]; }
  console.log(`threads=${nthreads} claim=${claim} chunk=${chunk} files=${files}/${nf} bytes=${bytes} tokens=${tokens} setup=${(tSetup - tStart).toFixed(1)}ms work=${(tEnd - tSetup).toFixed(1)}ms (slowest worker ${maxMs.toFixed(1)}ms) total=${(tEnd - tStart).toFixed(1)}ms => ${(bytes / 1e6 / ((tEnd - tSetup) / 1000)).toFixed(0)} MB/s`);
} else {
  runWorker(workerData as Job);
}
