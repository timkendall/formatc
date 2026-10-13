// Event-stream dumper of the TS port: the same lines as tools/md/rust-oracle (mdoracle), for differential tests.
//   node tools/md/events.ts [--track] [--hooks] [--read-leaves] [+opt|-opt]... FILE      (options: snake_case, as mdoracle)
import fs from "node:fs";
import {
  BT_CODE,
  BT_HR,
  BT_HTML,
  Definition,
  Extensions,
  Options,
  Renderer,
  SpanDetail,
  renderWithExtensions,
  startsContainerInParagraph,
} from "../../src/md/lib.ts";
import type { Parser } from "../../src/md/lib.ts";

export function esc(b: Uint8Array, s: number, e: number): string {
  let r = '"';
  for (let i = s; i < e; i++) {
    const c = b[i];
    if (c === 92) r += "\\\\";
    else if (c === 34) r += '\\"';
    else if (c === 10) r += "\\n";
    else if (c >= 0x20 && c <= 0x7e) r += String.fromCharCode(c);
    else r += "\\x" + c.toString(16).padStart(2, "0");
  }
  return r + '"';
}

const U32_MAX = 4294967295;
const u32 = (n: number) => (n < 0 ? U32_MAX : n);

export class Dump extends Renderer {
  out: string[] = [];
  track: boolean;
  readLeaves: boolean;
  constructor(track: boolean, readLeaves: boolean) {
    super();
    this.track = track;
    this.readLeaves = readLeaves;
  }
  enterBlock(t: number, data: number, flags: number): void {
    this.out.push(`EB ${t} ${data} ${flags}`);
  }
  leaveBlock(t: number, data: number): void {
    this.out.push(`LB ${t} ${data}`);
  }
  enterSpan(t: number, d: SpanDetail): void {
    this.out.push(
      `ES ${t} href=${esc(d.hrefBuf, d.hrefStart, d.hrefEnd)} title=${esc(d.titleBuf, d.titleStart, d.titleEnd)} ac=${+d.autolink} ae=${+d.autolinkEmail} pa=${+d.permissiveAutolink} aw=${+d.autolinkWww} ref=${d.reference}`,
    );
  }
  leaveSpan(t: number): void {
    this.out.push(`LS ${t}`);
  }
  text(t: number, buf: Uint8Array, s: number, e: number): void {
    this.out.push(`TX ${t} ${esc(buf, s, e)}`);
  }
  wantsSource(): boolean {
    return this.track;
  }
  lineStarts(starts: Int32Array, n: number): void {
    const v: number[] = [];
    for (let i = 0; i < n; i++) v.push(u32(starts[i]));
    this.out.push(`LN ${n} ${v.join(",")}`);
  }
  containerSource(beg: number, end: number, indent: number): void {
    this.out.push(`CS ${u32(beg)} ${end} ${indent}`);
  }
  leafSource(t: number, lines: Int32Array, n: number): boolean {
    const v: string[] = [];
    for (let i = 0; i < n; i++) v.push(`${lines[i * 3]}:${lines[i * 3 + 1]}:${lines[i * 3 + 2]}`);
    const reads = this.readLeaves && (t === BT_CODE || t === BT_HTML || t === BT_HR);
    this.out.push(`LF ${t} ${+reads} [${v.join(",")}]`);
    return reads;
  }
  inlineSource(beg: number, end: number): void {
    this.out.push(`IS ${beg} ${end}`);
  }
  extensionSpan(tag: number, buf: Uint8Array, s: number, e: number): void {
    this.out.push(`XS ${tag} ${esc(buf, s, e)}`);
  }
  definition(d: Definition): void {
    const v: string[] = [];
    for (let i = 0; i < d.linesCount; i++) {
      const k = (d.linesFrom + i) * 3;
      v.push(`${d.lines[k]}:${d.lines[k + 1]}:${d.lines[k + 2]}`);
    }
    this.out.push(
      `DF ${d.beg} ${d.end} label=${esc(d.buf, d.labelStart, d.labelEnd)} dest=${esc(d.buf, d.destStart, d.destEnd)} title=${esc(d.buf, d.titleStart, d.titleEnd)} lines=[${v.join(",")}]`,
    );
  }
}

// ---- the hooks (identical to those of mdoracle) ----

function lineEndIn(text: Uint8Array, off: number): number {
  let i = off;
  while (i < text.length && text[i] !== 10) i++;
  return i;
}
function find(h: Uint8Array, from: number, to: number, n: string): number {
  const m = n.length;
  for (let i = from; i + m <= to; i++) {
    let ok = true;
    for (let k = 0; k < m; k++) if (h[i + k] !== n.charCodeAt(k)) { ok = false; break; }
    if (ok) return i - from;
  }
  return -1;
}
const isAsciiWs = (b: number) => b === 32 || b === 9 || b === 10 || b === 12 || b === 13;
const isAtext = (b: number) => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 46 || b === 45 || b === 95 || b === 43;

export class HookExtensions extends Extensions {
  mdx: boolean;
  constructor(mdx: boolean) {
    super();
    this.mdx = mdx;
    this.leafBytes = Buffer.from(mdx ? "ie" : "{");
    this.spanBytes = Buffer.from("$[{@:");
  }
  leaf(p: Parser, off: number, indent: number, isInContainer: boolean, interruptsParagraph: boolean): number {
    const text = p.text;
    if (this.mdx) {
      if (isInContainer || indent > 0 || interruptsParagraph) return -1;
      const startsImport = text.subarray(off, off + 6).toString() === "import" || text.subarray(off, off + 6).toString() === "export";
      if (!startsImport || off + 6 >= text.length || !isAsciiWs(text[off + 6])) return -1;
      const at = find(text, off, text.length, "\n\n");
      return off + (at < 0 ? text.length - off : at);
    }
    if (off + 1 >= text.length) return -1;
    const c1 = text[off + 1];
    let closing: string;
    if (c1 === 123) closing = "}}";
    else if (c1 === 37) closing = "%}";
    else return -1;
    let lineEnd = lineEndIn(text, off);
    const from = off + 2;
    let at: number;
    if (isInContainer) {
      if (from > lineEnd) return -1;
      const f = find(text, from, lineEnd, closing);
      if (f < 0) return -1;
      at = from + f;
    } else {
      if (from > text.length) return -1;
      const f = find(text, from, text.length, closing);
      if (f < 0) return -1;
      at = from + f;
    }
    const end = at + 2;
    const e2 = lineEndIn(text, end);
    for (let i = end; i < e2; i++) if (text[i] !== 32 && text[i] !== 9) return -1;
    while (lineEnd < end) {
      if (startsContainerInParagraph(p, lineEnd + 1)) return -1;
      lineEnd = lineEndIn(text, lineEnd + 1);
    }
    return end;
  }
  span(b: Uint8Array, off: number, len: number, index: number, from: number, isAfterOpenBracket: boolean): boolean {
    const at = (i: number) => b[off + i];
    const c = at(index);
    if (c === 36) {
      if (index > 0 && at(index - 1) === 36) return false;
      let k = index + 1;
      while (k < len && at(k) !== 36) k++;
      if (k >= len) return false;
      const rest = k - (index + 1);
      if (rest === 0) return false;
      this.spanBeg = index; this.spanEnd = index + 2 + rest; this.spanTag = 2;
      return true;
    }
    if (c === 123) {
      if (index + 1 >= len || at(index + 1) !== 123) return false;
      const f = find(b, off + index + 2, off + len, "}}");
      if (f < 0) return false;
      this.spanBeg = index; this.spanEnd = index + 2 + f + 2; this.spanTag = 0;
      return true;
    }
    if (c === 91) {
      if (index + 1 >= len || at(index + 1) !== 91) return false;
      const f = find(b, off + index + 2, off + len, "]]");
      if (f < 0) return false;
      this.spanBeg = index; this.spanEnd = index + 2 + f + 2; this.spanTag = 3;
      return true;
    }
    if (isAfterOpenBracket) return false;
    if (c === 64) {
      let beg = index;
      while (beg > from && isAtext(at(beg - 1))) beg--;
      if (beg === index) return false;
      let end = index + 1;
      while (end < len && isAtext(at(end))) end++;
      if (end === index + 1) return false;
      this.spanBeg = beg; this.spanEnd = end; this.spanTag = 4;
      return true;
    }
    if (c === 58) {
      if (!(index + 2 < len && at(index + 1) === 47 && at(index + 2) === 47)) return false;
      const lo = Math.min(from, index);
      let n = 0;
      for (let k = index - 1; k >= lo; k--) {
        const x = at(k);
        if ((x >= 65 && x <= 90) || (x >= 97 && x <= 122)) n++;
        else break;
      }
      if (n === 0) return false;
      let end = index + 3;
      while (end < len && !isAsciiWs(at(end))) end++;
      this.spanBeg = index - n; this.spanEnd = end; this.spanTag = 5;
      return true;
    }
    return false;
  }
}

export interface Settings {
  track: boolean;
  hooks: boolean;
  readLeaves: boolean;
  options: Options;
}

const SNAKE: Record<string, string> = {};
for (const n of [
  "tables", "strikethrough", "tasklists", "permissiveAutolinks", "permissiveUrlAutolinks", "permissiveWwwAutolinks",
  "permissiveEmailAutolinks", "hardSoftBreaks", "wikiLinks", "underline", "latexMath", "collapseWhitespace",
  "permissiveAtxHeaders", "noIndentedCodeBlocks", "noHtmlBlocks", "noHtmlSpans", "tagFilter", "headingIds",
  "autolinkHeadings", "footnotes", "mathBlocks", "directives", "noSingleTilde", "micromark", "micromarkToTheLetter", "mdx",
]) SNAKE[n.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())] = n;

/** Parses the flags of mdoracle (`--track`, `+tables`, ...). */
export function parseSettings(args: string[]): Settings {
  const s: Settings = { track: false, hooks: false, readLeaves: false, options: new Options() };
  for (const a of args) {
    if (a === "--track") s.track = true;
    else if (a === "--hooks") s.hooks = true;
    else if (a === "--read-leaves") s.readLeaves = true;
    else if (a === "--bare") s.options.clearAll();
    else if (a[0] === "+" || a[0] === "-") {
      const name = SNAKE[a.slice(1)];
      if (!name || !s.options.setByName(name, a[0] === "+")) throw new Error("unknown option " + a);
    } else throw new Error("bad arg " + a);
  }
  return s;
}

/** The event lines of a document, one string per line (with the final newline), as mdoracle prints them. */
export function dump(bytes: Uint8Array, s: Settings): string {
  const d = new Dump(s.track, s.readLeaves);
  const ext = s.hooks ? new HookExtensions(s.options.mdx) : null;
  const rc = renderWithExtensions(bytes, s.options, d, ext);
  if (rc !== 0) d.out.push("ERROR");
  return d.out.length ? d.out.join("\n") + "\n" : "";
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const file = args.pop() as string;
  process.stdout.write(dump(fs.readFileSync(file), parseSettings(args)));
}
