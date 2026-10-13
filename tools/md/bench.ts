// Throughput of the md port: HTML rendering and the track-mode event stream (what the formatter reads) over a list of files.
//   node tools/md/bench.ts LIST ROOT [REPS [html|events|both]]        or compiled: scriptc build tools/md/bench.ts -o /tmp/mdbench
// LIST: paths relative to ROOT, one per line (only those ending in .md are used).
import * as fs from "node:fs";
import { ByteBuf, Options, Renderer, renderToHtmlWithOptions, renderWithExtensions } from "../../src/md/lib.ts";
import type { SpanDetail } from "../../src/md/lib.ts";

/** Counts events and touches the bytes, like a consumer would. */
class Counter extends Renderer {
  events = 0;
  bytes = 0;
  track = true;
  wantsSource(): boolean {
    return this.track;
  }
  enterBlock(_t: number, _d: number, _f: number): void {
    this.events++;
  }
  leaveBlock(_t: number, _d: number): void {
    this.events++;
  }
  enterSpan(_t: number, _d: SpanDetail): void {
    this.events++;
  }
  leaveSpan(_t: number): void {
    this.events++;
  }
  text(_t: number, _b: Uint8Array, s: number, e: number): void {
    this.events++;
    this.bytes += e - s;
  }
  inlineSource(_b: number, _e: number): void {
    this.events++;
  }
  leafSource(_t: number, _l: Int32Array, _n: number): boolean {
    return false;
  }
}

const args = process.argv.slice(2);
const list = fs.readFileSync(args[0], "utf8").split("\n").filter((l) => l.endsWith(".md"));
const root = args[1];
const reps = args.length > 2 ? Number(args[2]) : 5;
const files: Uint8Array[] = [];
let total = 0;
for (let i = 0; i < list.length; i++) {
  const b = fs.readFileSync(root + "/" + list[i]);
  files.push(b);
  total += b.length;
}
console.log("files", files.length, "bytes", total);

const out = new ByteBuf(1 << 20);
const options = new Options();
let bestHtml = 1e18;
let bestEvents = 1e18;
let sink = 0;
const counter = new Counter();
const fopts = new Options();
fopts.footnotes = true;
fopts.mathBlocks = true;
fopts.noSingleTilde = true;
fopts.micromark = true;
fopts.micromarkToTheLetter = true;
fopts.tasklists = false;
const mode = args.length > 3 ? args[3] : "both";
for (let rep = 0; rep < reps; rep++) {
  let t0 = performance.now();
  for (let i = 0; i < files.length && mode !== "events"; i++) {
    out.reset();
    renderToHtmlWithOptions(files[i], options, out);
    sink += out.len;
  }
  let dt = performance.now() - t0;
  if (dt < bestHtml) bestHtml = dt;
  t0 = performance.now();
  for (let i = 0; i < files.length && mode !== "html"; i++) {
    renderWithExtensions(files[i], fopts, counter, null);
  }
  dt = performance.now() - t0;
  if (dt < bestEvents) bestEvents = dt;
}
console.log("html   ", bestHtml.toFixed(1), "ms", (total / 1e6 / (bestHtml / 1000)).toFixed(1), "MB/s  (out bytes", sink / reps, ")");
console.log("events ", bestEvents.toFixed(1), "ms", (total / 1e6 / (bestEvents / 1000)).toFixed(1), "MB/s  (events", counter.events, ")");
