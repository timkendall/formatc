// The worker as it was before the pipeline (walk everything, then format): kept for the "before" numbers of tools/driver-perf.
// Plus FMT_FAKE_WORK, the same stand-in load as in src/driver/worker.ts.
import * as fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { publish } from "@scriptc/threads";
import { ByteBuf } from "../base/bytebuf.ts";
import * as dispatch from "./dispatch.ts";
import { OptionSet } from "./dispatch.ts";
import * as fsx from "./fsx.ts";
import { problemAt, problemOfFile, Problem } from "./problem.ts";
import { runScan, ScanTask } from "./scan.ts";

export const D_NONE = 0;
export const D_UNCHANGED = 1;
export const D_DIFFERENT = 2;
export const D_FAILED = 3;
export const D_REFUSED = 4;
export const D_BUG = 5;
export const D_CHANGED = 6;
export const D_UNREAD = 7;
export const D_COMPARE = 8;

export class Job {
  paths: string[];
  setIds: number[];
  sets: OptionSet[];
  writes: boolean;
  chunk: number;
  compareTo: string;
  compareRoot: string;
  dumpTo: string;
  constructor(paths: string[], setIds: number[], sets: OptionSet[], writes: boolean, chunk: number, compareTo: string, compareRoot: string, dumpTo: string) {
    this.paths = paths;
    this.setIds = setIds;
    this.sets = sets;
    this.writes = writes;
    this.chunk = chunk;
    this.compareTo = compareTo;
    this.compareRoot = compareRoot;
    this.dumpTo = dumpTo;
  }
}

export class Report {
  idx: number[] = [];
  code: number[] = [];
  message: string[] = [];
  line: number[] = [];
  column: number[] = [];
  lineText: string[] = [];
  took: number[] = [];
  bytes = 0;
  files = 0;
  ms = 0;
}

function same(a: Uint8Array, alen: number, b: Uint8Array, blen: number): boolean {
  if (alen !== blen) return false;
  const ba = a as Buffer;
  return ba.compare(b as Buffer, 0, blen, 0, alen) === 0;
}

const FAKE_NS = Number(process.env["FMT_FAKE_WORK"] === undefined ? "0" : (process.env["FMT_FAKE_WORK"] as string));
let fakeItersPerByte = 0;
let fakeSink = 0;

function fakeKernel(buf: Uint8Array, len: number, iters: number): number {
  let h = 0x811c9dc5 | 0;
  let j = 0;
  for (let i = 0; i < iters; i++) {
    h = Math.imul(h ^ (buf[j] | 0), 16777619) | 0;
    j = j + 1;
    if (j >= len) j = 0;
  }
  return h;
}

function calibrateFake(): void {
  const probe = Buffer.alloc(4096);
  for (let i = 0; i < probe.length; i++) probe[i] = (i * 7) & 255;
  fakeKernel(probe, probe.length, 100000);
  let best = 1e18;
  for (let rep = 0; rep < 5; rep++) {
    const t0 = performance.now();
    fakeSink = fakeKernel(probe, probe.length, 400000);
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  const nsPerIter = (best * 1e6) / 400000;
  fakeItersPerByte = FAKE_NS / nsPerIter;
}

let scratch: Buffer = Buffer.alloc(1 << 20);

function readInto(path: string): number {
  let fd = -1;
  try {
    fd = fs.openSync(path, "r");
    const size = fs.fstatSync(fd).size;
    if (size + 1 > scratch.length) scratch = Buffer.alloc((size + 1) * 2);
    let got = 0;
    while (true) {
      if (got === scratch.length) {
        const bigger = Buffer.alloc(scratch.length * 2);
        scratch.copy(bigger, 0, 0, got);
        scratch = bigger;
      }
      const n = fs.readSync(fd, scratch, got, scratch.length - got, got);
      if (n <= 0) break;
      got = got + n;
    }
    fs.closeSync(fd);
    return got;
  } catch (e) {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch (e2) {
        // ignore
      }
    }
    fsx.noteError(e);
    return -1;
  }
}

let fileStart = 0;

function pushReport(r: Report, idx: number, code: number, message: string, p: Problem | null): void {
  r.took.push(performance.now() - fileStart);
  r.idx.push(idx);
  r.code.push(code);
  r.message.push(message);
  r.line.push(p === null ? -1 : p.line);
  r.column.push(p === null ? -1 : p.column);
  r.lineText.push(p === null ? "" : p.lineText);
}

export function formatPaths(job: Job, ctrl: Int32Array, shown: (i: number) => string): Report {
  const t0 = performance.now();
  if (FAKE_NS > 0 && fakeItersPerByte === 0) calibrateFake();
  const report = new Report();
  const out = new ByteBuf(1 << 20);
  const paths = job.paths;
  const n = paths.length;
  const chunk = job.chunk;
  let cur = 0;
  let chunkEnd = 0;
  let bytes = 0;
  let files = 0;
  while (true) {
    if (cur >= chunkEnd) {
      cur = Atomics.add(ctrl, 0, chunk);
      chunkEnd = cur + chunk;
    }
    if (cur >= n) break;
    const idx = cur;
    cur = cur + 1;
    fileStart = performance.now();
    const path = paths[idx];
    const got = readInto(path);
    if (got < 0) {
      pushReport(report, idx, D_FAILED, 'Unable to read file "' + shown(idx) + '":\n' + fsx.describeError(fsx.lastErrorCode, fsx.lastErrorMessage), null);
      continue;
    }
    bytes = bytes + got;
    files = files + 1;
    const set = job.sets[job.setIds[idx]];
    out.reset();
    if (fakeItersPerByte > 0) {
      fakeSink = fakeKernel(scratch, got, Math.round(got * fakeItersPerByte));
    }
    const st = dispatch.formatFile(path, scratch, got, set, out);
    if (st === dispatch.ST_OK) {
      const isSame = same(scratch, got, out.data, out.len);
      if (isSame) {
        pushReport(report, idx, D_UNCHANGED, "", null);
      } else {
        if (job.writes) {
          const why = fsx.writeFile(path, out.data, out.len);
          if (why !== "") {
            pushReport(report, idx, D_FAILED, 'Unable to write file "' + shown(idx) + '":\n' + why, null);
            continue;
          }
        }
        pushReport(report, idx, D_DIFFERENT, "", null);
      }
    } else if (st === dispatch.ST_SYNTAX) {
      const p = dispatch.errOffset < 0 ? problemOfFile(dispatch.errMessage) : problemAt(scratch, got, dispatch.errMessage, dispatch.errOffset, dispatch.errIsJs);
      pushReport(report, idx, D_REFUSED, p.message, p);
    } else if (st === dispatch.ST_UNREAD) {
      const p = problemAt(scratch, got, dispatch.errMessage, dispatch.errOffset, false);
      pushReport(report, idx, D_UNREAD, p.message, p);
    } else if (st === dispatch.ST_CHANGED) {
      pushReport(report, idx, D_CHANGED, dispatch.errMessage, null);
    } else {
      pushReport(report, idx, D_BUG, "", null);
    }
  }
  report.bytes = bytes;
  report.files = files;
  report.ms = performance.now() - t0;
  return report;
}

export interface WorkerInit {
  kind: number;
  job: Job | null;
  scan: ScanTask | null;
  ctrl: SharedArrayBuffer;
  id: number;
  cwd: string;
}

export function runWorker(): void {
  const data = workerData as WorkerInit;
  const ctrl = new Int32Array(data.ctrl);
  if (data.kind === 1) {
    const out = runScan(data.scan as ScanTask, ctrl);
    (parentPort as NonNullable<typeof parentPort>).postMessage(publish(out));
    return;
  }
  const cwd = data.cwd;
  const job = data.job as Job;
  const shown = (i: number): string => {
    const p = job.paths[i];
    return p.startsWith(cwd + "/") ? p.substring(cwd.length + 1) : p;
  };
  const report = formatPaths(job, ctrl, shown);
  (parentPort as NonNullable<typeof parentPort>).postMessage({
    idx: report.idx,
    code: report.code,
    message: report.message,
    line: report.line,
    column: report.column,
    lineText: report.lineText,
    took: report.took,
    bytes: report.bytes,
    files: report.files,
    ms: report.ms,
  });
}
