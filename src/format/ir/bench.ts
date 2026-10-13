// Printer throughput micro-benchmark. Builds a document that looks like what the JS formatter writes (functions, calls
// with arguments that fit or break, objects, arrays, if statements; text is ranges of a source buffer) and measures
//   - writing the document (elements per second, MB of output per second),
//   - printing it (MB of output per second, ns per element).
//
//   node src/format/ir/bench.ts [functions per document] [documents] [reps]
//   scriptc build src/format/ir/bench.ts -o /tmp/ir-bench && /tmp/ir-bench
import { ByteBuf } from "../../base/bytebuf.ts";
import { FormatOptions } from "../options.ts";
import { Scratch, startDocument } from "./run.ts";
import { Formatter } from "./formatter.ts";
import { printDocument } from "./printer.ts";
import { token } from "./element.ts";

const LPAREN = token("(");
const RPAREN = token(")");
const LBRACE = token("{");
const RBRACE = token("}");
const LBRACKET = token("[");
const RBRACKET = token("]");
const COMMA = token(",");
const SEMI = token(";");
const EQ = token("=");
const COLON = token(":");
const FUNCTION = token("function");
const CONST = token("const");
const IF = token("if");
const RETURN = token("return");
const GT = token(">");
const PLUS = token("+");

// A source buffer with identifiers of different lengths, separated by spaces.
function makeSource(): Uint8Array {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "x", "yy", "zzz", "counter", "someLongIdentifierName", "value", "item", "options", "result", "handler"];
  const bytes: number[] = [];
  for (let r = 0; r < 64; r++) {
    for (let i = 0; i < words.length; i++) {
      const w = words[(i * 7 + r * 3) % words.length];
      for (let k = 0; k < w.length; k++) bytes.push(w.charCodeAt(k));
      bytes.push(32);
    }
  }
  return new Uint8Array(bytes);
}

const source = makeSource();
// Start offsets and lengths of the identifiers in `source`.
const wordStart = new Int32Array(2048);
const wordEnd = new Int32Array(2048);
let nWords = 0;
{
  let i = 0;
  while (i < source.length) {
    let j = i;
    while (j < source.length && (source[j] | 0) !== 32) j++;
    wordStart[nWords] = i;
    wordEnd[nWords] = j;
    nWords++;
    i = j + 1;
  }
}

let seed = 12345;
function rnd(n: number): number {
  seed = (Math.imul(seed, 1103515245) + 12345) | 0;
  return ((seed >>> 8) & 0xffffff) % n;
}

function ident(f: Formatter): void {
  const k = rnd(nWords);
  f.sourceText(wordStart[k], wordEnd[k]);
}

function args(f: Formatter, n: number): void {
  f.startGroup();
  f.token(LPAREN);
  f.startSoftBlockIndent();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      f.token(COMMA);
      f.softLineBreakOrSpace();
    }
    if (rnd(6) === 0) {
      object(f);
    } else {
      ident(f);
    }
  }
  f.tokenIfBreaks(COMMA);
  f.endSoftBlockIndent();
  f.token(RPAREN);
  f.endGroup();
}

function object(f: Formatter): void {
  f.startGroup();
  f.token(LBRACE);
  f.startSoftSpaceOrBlockIndent();
  const n = 1 + rnd(4);
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      f.token(COMMA);
      f.softLineBreakOrSpace();
    }
    ident(f);
    f.token(COLON);
    f.space();
    if (rnd(5) === 0) {
      f.startGroup();
      f.token(LBRACKET);
      f.startSoftBlockIndent();
      ident(f);
      f.token(COMMA);
      f.softLineBreakOrSpace();
      ident(f);
      f.endSoftBlockIndent();
      f.token(RBRACKET);
      f.endGroup();
    } else {
      ident(f);
    }
  }
  f.tokenIfBreaks(COMMA);
  f.endSoftSpaceOrBlockIndent();
  f.token(RBRACE);
  f.endGroup();
}

function statement(f: Formatter): void {
  const k = rnd(4);
  if (k === 0) {
    f.token(CONST);
    f.space();
    ident(f);
    f.space();
    f.token(EQ);
    f.space();
    ident(f);
    args(f, 1 + rnd(5));
    f.token(SEMI);
  } else if (k === 1) {
    ident(f);
    args(f, 1 + rnd(6));
    f.token(SEMI);
  } else if (k === 2) {
    f.token(IF);
    f.space();
    f.startGroup();
    f.token(LPAREN);
    f.startSoftBlockIndent();
    ident(f);
    f.space();
    f.token(GT);
    f.space();
    ident(f);
    f.endSoftBlockIndent();
    f.token(RPAREN);
    f.endGroup();
    f.space();
    f.token(LBRACE);
    f.startBlockIndent();
    f.token(RETURN);
    f.space();
    ident(f);
    args(f, 1 + rnd(3));
    f.token(SEMI);
    f.endBlockIndent();
    f.token(RBRACE);
  } else {
    f.token(CONST);
    f.space();
    ident(f);
    f.space();
    f.token(EQ);
    f.space();
    f.startGroup();
    ident(f);
    f.space();
    f.token(PLUS);
    f.startIndent();
    f.softLineBreakOrSpace();
    ident(f);
    f.space();
    f.token(PLUS);
    f.softLineBreakOrSpace();
    ident(f);
    f.endIndent();
    f.endGroup();
    f.token(SEMI);
  }
}

function writeProgram(f: Formatter, functions: number): void {
  seed = 12345 + (functions | 0);
  for (let i = 0; i < functions; i++) {
    f.token(FUNCTION);
    f.space();
    ident(f);
    f.startGroup();
    f.token(LPAREN);
    f.startSoftBlockIndent();
    ident(f);
    f.token(COMMA);
    f.softLineBreakOrSpace();
    ident(f);
    f.tokenIfBreaks(COMMA);
    f.endSoftBlockIndent();
    f.token(RPAREN);
    f.endGroup();
    f.space();
    f.token(LBRACE);
    f.startBlockIndent();
    const n = 3 + rnd(5);
    for (let s = 0; s < n; s++) {
      if (s > 0) f.hardLineBreak();
      statement(f);
    }
    f.endBlockIndent();
    f.token(RBRACE);
    f.hardLineBreak();
    f.emptyLine();
  }
}

// Documents of `functions` functions each (about 180 elements per function, so ~4 K elements and 50 KB of output for the
// default of 20: like a source file of 40 KB), written and printed `docs` times. The text is that of a real file: the
// document is in the caches when it is printed.
const functions = process.argv.length > 2 ? parseInt(process.argv[2]) : 20;
const docs = process.argv.length > 3 ? parseInt(process.argv[3]) : 1000;
const reps = process.argv.length > 4 ? parseInt(process.argv[4]) : 5;
const options = new FormatOptions();
const scratch = new Scratch(options);
const out = new ByteBuf(1 << 20);
let bestWrite = 1e18;
let bestPrint = 1e18;
let outBytes = 0;
let elements = 0;
let checksum = 0;
for (let rep = 0; rep < reps; rep++) {
  let writeMs = 0;
  let printMs = 0;
  let bytes = 0;
  let elems = 0;
  let h = 0;
  for (let d = 0; d < docs; d++) {
    const t0 = performance.now();
    const f = startDocument(scratch, source, options, null);
    writeProgram(f, functions);
    const t1 = performance.now();
    out.reset();
    const r = printDocument(f.st, f.rootStart(), f.rootEnd(), source, options, out);
    const t2 = performance.now();
    if (r !== 0) {
      console.log("print error " + r);
      process.exit(1);
    }
    writeMs += t1 - t0;
    printMs += t2 - t1;
    bytes += out.len;
    elems += f.len();
    h = (Math.imul(h, 31) + out.len) | 0;
  }
  if (writeMs < bestWrite) bestWrite = writeMs;
  if (printMs < bestPrint) bestPrint = printMs;
  outBytes = bytes;
  elements = elems;
  checksum = h;
}
console.log(docs + " documents of " + functions + " functions: " + elements + " elements, " + outBytes + " bytes of output, checksum " + checksum);
console.log("write  " + bestWrite.toFixed(1) + " ms  " + ((bestWrite * 1e6) / elements).toFixed(1) + " ns/element  " + (outBytes / 1e6 / (bestWrite / 1000)).toFixed(0) + " MB/s of output");
console.log("print  " + bestPrint.toFixed(1) + " ms  " + ((bestPrint * 1e6) / elements).toFixed(1) + " ns/element  " + (outBytes / 1e6 / (bestPrint / 1000)).toFixed(0) + " MB/s of output");
