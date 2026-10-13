// Runs the port over packed documents ([u32 length][bytes]..., as written by diff-events.ts to /tmp/md-pack-*.bin) and
// prints a hash of everything it outputs, so that `node tools/md/compiled-check.ts PACK...` and the scriptc build of
// this file can be compared:   scriptc build tools/md/compiled-check.ts -o /tmp/mdcheck && /tmp/mdcheck /tmp/md-pack-*.bin
import * as fs from "node:fs";
import { ByteBuf, Options, Renderer, renderToHtmlWithOptions, renderWithExtensions } from "../../src/md/lib.ts";
import type { Definition, SpanDetail } from "../../src/md/lib.ts";

let hash = 0;
function mix(v: number): void {
  hash = Math.imul(hash ^ (v | 0), 16777619) | 0;
}
function mixBytes(b: Uint8Array, s: number, e: number): void {
  for (let i = s; i < e; i++) mix(b[i] | 0);
  mix(e - s);
}

class Hasher extends Renderer {
  track = true;
  wantsSource(): boolean {
    return this.track;
  }
  enterBlock(t: number, d: number, f: number): void {
    mix(1); mix(t); mix(d); mix(f);
  }
  leaveBlock(t: number, d: number): void {
    mix(2); mix(t); mix(d);
  }
  enterSpan(t: number, d: SpanDetail): void {
    mix(3); mix(t); mixBytes(d.hrefBuf, d.hrefStart, d.hrefEnd); mixBytes(d.titleBuf, d.titleStart, d.titleEnd);
    mix(d.reference); mix(d.autolink ? 1 : 0); mix(d.autolinkEmail ? 1 : 0); mix(d.permissiveAutolink ? 1 : 0); mix(d.autolinkWww ? 1 : 0);
  }
  leaveSpan(t: number): void {
    mix(4); mix(t);
  }
  text(t: number, b: Uint8Array, s: number, e: number): void {
    mix(5); mix(t); mixBytes(b, s, e);
  }
  lineStarts(starts: Int32Array, n: number): void {
    mix(6); for (let i = 0; i < n; i++) mix(starts[i] | 0);
  }
  containerSource(beg: number, end: number, indent: number): void {
    mix(7); mix(beg); mix(end); mix(indent);
  }
  leafSource(t: number, lines: Int32Array, n: number): boolean {
    mix(8); mix(t); for (let i = 0; i < n * 3; i++) mix(lines[i] | 0);
    return false;
  }
  inlineSource(beg: number, end: number): void {
    mix(9); mix(beg); mix(end);
  }
  definition(d: Definition): void {
    mix(10); mix(d.beg); mix(d.end); mixBytes(d.buf, d.labelStart, d.labelEnd); mixBytes(d.buf, d.destStart, d.destEnd); mixBytes(d.buf, d.titleStart, d.titleEnd);
    mix(d.linesCount);
  }
}

const out = new ByteBuf(1 << 16);
const hasher = new Hasher();
const options = new Options();
const fopts = new Options();
fopts.footnotes = true;
fopts.mathBlocks = true;
fopts.directives = true;
fopts.noSingleTilde = true;
fopts.micromark = true;
fopts.wikiLinks = true;
fopts.permissiveAutolinks = true;
fopts.latexMath = true;
fopts.tasklists = false;
const mdx = new Options();
mdx.mdx = true;
mdx.micromark = true;
mdx.footnotes = true;
let docs = 0;
for (let a = 2; a < process.argv.length; a++) {
  const pack = fs.readFileSync(process.argv[a]);
  let at = 0;
  while (at + 4 <= pack.length) {
    const len = pack[at] | (pack[at + 1] << 8) | (pack[at + 2] << 16) | (pack[at + 3] << 24);
    const doc = pack.subarray(at + 4, at + 4 + len);
    at += 4 + len;
    out.reset();
    renderToHtmlWithOptions(doc, options, out);
    mixBytes(out.data, 0, out.len);
    renderWithExtensions(doc, fopts, hasher, null);
    renderWithExtensions(doc, mdx, hasher, null);
    docs++;
  }
}
console.log("documents", docs, "hash", hash);
