// The consumer: reads a file, formats it, compares, writes if asked, and reports. It runs in the main process (one thread) and in
// the child processes (child.ts).
import * as fs from "node:fs";
import { ByteBuf } from "../base/bytebuf.ts";
import * as dispatch from "./dispatch.ts";
import { OptionSet } from "./dispatch.ts";
import * as fsx from "./fsx.ts";
import * as pipe from "./pipe.ts";
import { problemAt, problemOfFile, Problem } from "./problem.ts";

// Result codes of a file (`Done` of mod.rs).
export const D_NONE = 0;
export const D_UNCHANGED = 1;
export const D_DIFFERENT = 2;
export const D_FAILED = 3; // a message for the user (`message`)
export const D_REFUSED = 4; // a problem with a place (`message`, `line`, `column`, `lineText`)
export const D_BUG = 5;
export const D_CHANGED = 6; // --debug-check: formatting would change what the file says (`message`)
export const D_UNREAD = 7; // a problem about a TOML file that is no error
export const D_COMPARE = 8; // --compare-to: 1 byte of detail in `column`: 0 match, 1 mismatch

// What the consumers are told besides the queue.
export class LoopCfg {
  writes: boolean;
  // every file gets an entry in the report (--compare-to, and oxfmt which tells how long each file took)
  detail: boolean;
  chunk: number;
  compareTo: string;
  compareRoot: string;
  dumpTo: string;
  cwd: string;
  constructor(writes: boolean, detail: boolean, chunk: number, compareTo: string, compareRoot: string, dumpTo: string, cwd: string) {
    this.writes = writes;
    this.detail = detail;
    this.chunk = chunk;
    this.compareTo = compareTo;
    this.compareRoot = compareRoot;
    this.dumpTo = dumpTo;
    this.cwd = cwd;
  }
}

// What a worker reports. Parallel arrays: only plain numbers and strings cross the thread boundary. `idx` is `2 * (index in
// the lane) + lane`. Only files whose result needs words are in it (not those that are unchanged or different, unless `detail`).
export class Report {
  idx: number[] = [];
  code: number[] = [];
  message: string[] = [];
  line: number[] = [];
  column: number[] = [];
  lineText: string[] = [];
  // how long it took to find out what became of the file, in ms
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

// ---- a stand-in for the work of the formatters (FMT_FAKE_WORK=<ns per byte>) ----
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

function fakeWork(buf: Uint8Array, len: number): void {
  if (len === 0) return;
  fakeSink = fakeKernel(buf, len, Math.round(len * fakeItersPerByte));
}

// Reads the file into `scratch` (growing it). Returns the number of bytes, or -1 (the error in fsx.lastError*). Three system
// calls: open, one read into a buffer that is larger than the file, close. A read that returns less than was asked for is the end.
let scratch: Buffer = Buffer.alloc(1 << 20);

function readInto(path: string, sizeHint: number): number {
  let fd = -1;
  try {
    fd = fs.openSync(path, "r");
    if (sizeHint + 1 > scratch.length) scratch = Buffer.alloc((sizeHint + 1) * 2);
    let got = 0;
    while (true) {
      if (got === scratch.length) {
        const bigger = Buffer.alloc(scratch.length * 2);
        scratch.copy(bigger, 0, 0, got);
        scratch = bigger;
      }
      const want = scratch.length - got;
      const n = fs.readSync(fd, scratch, got, want, got);
      if (n <= 0) break;
      got = got + n;
      if (n < want) break;
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

function pushReport(r: Report, key: number, code: number, message: string, p: Problem | null): void {
  r.took.push(performance.now() - fileStart);
  r.idx.push(key);
  r.code.push(code);
  r.message.push(message);
  r.line.push(p === null ? -1 : p.line);
  r.column.push(p === null ? -1 : p.column);
  r.lineText.push(p === null ? "" : p.lineText);
}

function shownOf(path: string, cwd: string): string {
  return path.startsWith(cwd + "/") ? path.substring(cwd.length + 1) : path;
}

// One file. Returns the status byte for the queue (pipe.ST_*).
export function formatOne(cfg: LoopCfg, report: Report, out: ByteBuf, key: number, path: string, set: OptionSet, size: number): number {
  fileStart = cfg.detail ? performance.now() : 0;
  const got = readInto(path, size);
  if (got < 0) {
    pushReport(report, key, D_FAILED, 'Unable to read file "' + shownOf(path, cfg.cwd) + '":\n' + fsx.describeError(fsx.lastErrorCode, fsx.lastErrorMessage), null);
    return pipe.ST_OTHER;
  }
  report.bytes = report.bytes + got;
  report.files = report.files + 1;
  out.reset();
  if (fakeItersPerByte > 0) fakeWork(scratch, got);
  const st = dispatch.formatFile(path, scratch, got, set, out);
  if (st === dispatch.ST_OK) {
    const isSame = same(scratch, got, out.data, out.len);
    if (cfg.compareTo.length > 0) {
      compareFile(cfg, report, key, path, out, isSame);
      return pipe.ST_OTHER;
    }
    if (isSame) {
      if (cfg.detail) {
        pushReport(report, key, D_UNCHANGED, "", null);
        return pipe.ST_OTHER;
      }
      return pipe.ST_UNCHANGED;
    }
    if (cfg.writes) {
      const why = fsx.writeFile(path, out.data, out.len);
      if (why !== "") {
        pushReport(report, key, D_FAILED, 'Unable to write file "' + shownOf(path, cfg.cwd) + '":\n' + why, null);
        return pipe.ST_OTHER;
      }
    }
    if (cfg.detail) {
      pushReport(report, key, D_DIFFERENT, "", null);
      return pipe.ST_OTHER;
    }
    return pipe.ST_DIFFERENT;
  } else if (st === dispatch.ST_SYNTAX) {
    const p = dispatch.errOffset < 0 ? problemOfFile(dispatch.errMessage) : problemAt(scratch, got, dispatch.errMessage, dispatch.errOffset, dispatch.errIsJs);
    pushReport(report, key, D_REFUSED, p.message, p);
  } else if (st === dispatch.ST_UNREAD) {
    const p = problemAt(scratch, got, dispatch.errMessage, dispatch.errOffset, false);
    pushReport(report, key, D_UNREAD, p.message, p);
  } else if (st === dispatch.ST_CHANGED) {
    pushReport(report, key, D_CHANGED, dispatch.errMessage, null);
  } else {
    pushReport(report, key, D_BUG, "", null);
  }
  return pipe.ST_OTHER;
}

// `--compare-to=<dir>`: the output against `<dir>/<relative path>`. `column` carries 0 for a match, 1 for a mismatch.
let compareBuf: Buffer = Buffer.alloc(1 << 20);

function compareFile(cfg: LoopCfg, report: Report, key: number, path: string, out: ByteBuf, isSame: boolean): void {
  const rel = path.startsWith(cfg.compareRoot) ? path.substring(cfg.compareRoot.length) : path;
  const oracle = cfg.compareTo + "/" + rel;
  let fd = -1;
  try {
    fd = fs.openSync(oracle, "r");
    const size = fs.fstatSync(fd).size;
    if (size + 1 > compareBuf.length) compareBuf = Buffer.alloc((size + 1) * 2);
    let have = 0;
    while (have < size) {
      const nn = fs.readSync(fd, compareBuf, have, size - have, have);
      if (nn <= 0) break;
      have = have + nn;
    }
    fs.closeSync(fd);
    fd = -1;
    const match = same(compareBuf, have, out.data, out.len);
    if (cfg.dumpTo.length > 0 && !match) dumpOutput(cfg, rel, out);
    pushReport(report, key, D_COMPARE, "", new Problem("", match ? 0 : 1, 0, ""));
  } catch (e) {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch (e2) {
        // ignore
      }
    }
    pushReport(report, key, D_COMPARE, "missing", new Problem("", 2, 0, ""));
  }
}

function dumpOutput(cfg: LoopCfg, rel: string, out: ByteBuf): void {
  const target = cfg.dumpTo + "/" + rel;
  try {
    const slash = target.lastIndexOf("/");
    fs.mkdirSync(target.substring(0, slash), { recursive: true });
    fs.writeFileSync(target, out.data.subarray(0, out.len));
  } catch (e) {
    // ignore
  }
}
