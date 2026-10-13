// Self-test of css/doc.ts, sink.ts, memo.ts. Runs under node and compiled by scriptc with identical output:
//   node src/format/css/doc.test.ts
//   SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-css scriptc build src/format/css/doc.test.ts -o /tmp/css-doc-test && /tmp/css-doc-test
// (tools/css/doc-fuzz.ts compares the printer with Prettier's printDocToString on random documents.)
import { ByteBuf } from "../../base/bytebuf.ts";
import { FormatOptions } from "../options.ts";
import {
  DOC_EMPTY,
  DOC_HARDLINE,
  DOC_LINE_DOC,
  DOC_SOFTLINE,
  Elements,
  Printer,
  alignTextId,
  docAscii,
  docArray,
  docBegin,
  docAdd,
  docFill,
  docPool,
  docReset,
  docs3,
  group,
  indent,
  joinList,
  printDoc,
  replaceEndOfLineWithLiteralLines,
  textToDoc,
} from "./doc.ts";
import { Memo } from "./memo.ts";
import { Sink } from "./sink.ts";

let total = 0;
let failures = 0;
function check(name: string, actual: string, expected: string): void {
  total = total + 1;
  if (actual === expected) return;
  failures = failures + 1;
  console.log("FAIL " + name);
  console.log("  expected: " + JSON.stringify(expected));
  console.log("  actual:   " + JSON.stringify(actual));
}

function show(doc: number, width: number): string {
  const opts = new FormatOptions();
  opts.lineWidth = width;
  const out = new ByteBuf(64);
  printDoc(doc, opts, new Uint8Array(0), out);
  return out.toUtf8();
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// group fits / breaks
docReset();
const body = docs3(docAscii("a"), DOC_LINE_DOC, docAscii("b"));
check("group fits", show(group(body), 10), "a b");
check("group breaks", show(group(body), 2), "a\nb");
check("indent", show(group(docs3(docAscii("a"), indent(docs3(DOC_SOFTLINE, docAscii("b"), DOC_SOFTLINE)), docAscii("c"))), 2), "a\n  b\n  c");

// fill
{
  docReset();
  const m = docBegin();
  docAdd(docAscii("aaa"));
  docAdd(DOC_LINE_DOC);
  docAdd(docAscii("bbb"));
  docAdd(DOC_LINE_DOC);
  docAdd(docAscii("ccc"));
  const f = docFill(m);
  check("fill 7", show(f, 7), "aaa bbb\nccc");
  check("fill 11", show(f, 11), "aaa bbb ccc");
}

// join, hardline, empty lines
{
  docReset();
  const m = docBegin();
  docAdd(docAscii("x"));
  docAdd(docAscii("y"));
  docAdd(docAscii("z"));
  joinList(DOC_HARDLINE, m);
  check("join hardline", show(docArray(m), 80), "x\ny\nz");
}

// text with newlines as literal lines
{
  docReset();
  const t = bytes("a\nb\n\nc");
  const d = replaceEndOfLineWithLiteralLines(t, 0, t.length);
  check("literal lines", show(indent(d), 80), "a\nb\n\nc");
}

// align text and textToDoc
{
  docReset();
  const q = alignTextId("> ");
  const d = docPool.array2(docAscii("> "), docPool.alignWithText(q, docs3(docAscii("a"), DOC_HARDLINE, docAscii("b"))));
  check("align text", show(d, 80), "> a\n> b");
  const t = textToDoc(docPool.array2(docAscii("x"), DOC_HARDLINE));
  check("textToDoc strips", show(t, 80), "x");
}

// Elements -> toTree round trip
{
  docReset();
  const e = new Elements();
  e.startGroup(false, 0, false);
  e.token("a");
  e.line(1);
  e.token("b");
  e.endGroup();
  const tree = e.toTree();
  check("toTree", show(tree, 80), "ab");
  check("toTree narrow", show(tree, 0), "a\nb");
  e.clear();
  e.startGroup(false, 0, false);
  e.token("a");
  e.line(0);
  e.token("b");
  e.endGroup();
  const tree2 = e.toTree();
  check("toTree line", show(tree2, 80), "a b");
  check("toTree line narrow", show(tree2, 1), "a\nb");
}

// Printer directly
{
  const e = new Elements();
  e.startGroup(false, 0, false);
  e.token("one");
  e.line(0);
  e.token("two");
  e.endGroup();
  const out = new ByteBuf(16);
  const pr = new Printer();
  const o = new FormatOptions();
  o.lineWidth = 5;
  pr.init(o, new Uint8Array(0), out);
  pr.print(e, 0, 0);
  check("printer", out.toUtf8(), "one\ntwo");
}

// Sink: straight output, then a document when a group does not fit
{
  const out = new ByteBuf(64);
  const pr = new Printer();
  const o = new FormatOptions();
  o.lineWidth = 12;
  pr.init(o, new Uint8Array(0), out);
  const sink = new Sink();
  sink.toOutput(pr, false);
  const t = bytes("abc");
  for (let round = 0; round < 2; round++) {
    const write = (): void => {
      sink.startGroup(false);
      sink.text(t, 0, 3);
      sink.token(",");
      sink.line();
      sink.text(t, 0, 3);
      sink.token(",");
      sink.line();
      sink.text(t, 0, 3);
      sink.endGroup();
      sink.token(";");
    };
    const marked = sink.startUnit();
    write();
    if (marked && !sink.endUnit()) {
      sink.startDocument();
      write();
      sink.endDocument();
    }
    sink.hardLine();
  }
  check("sink", out.toUtf8(), "abc,\nabc,\nabc;\nabc,\nabc,\nabc;\n");
  const out2 = new ByteBuf(64);
  o.lineWidth = 40;
  pr.init(o, new Uint8Array(0), out2);
  sink.toOutput(pr, false);
  const marked = sink.startUnit();
  sink.startGroup(false);
  sink.text(t, 0, 3);
  sink.line();
  sink.text(t, 0, 3);
  sink.endGroup();
  sink.token(";");
  if (marked) sink.endUnit();
  sink.hardLine();
  check("sink fits", out2.toUtf8(), "abc abc;\n");
}

// Memo
{
  const m = new Memo();
  const at = bytes("media");
  const c1 = m.context(5, at, 0, 5);
  const c2 = m.context(5, at, 0, 5);
  const c3 = m.context(6, at, 0, 5);
  check("memo context", c1 + "," + c2 + "," + c3, "0,0,1");
  const text = bytes("color: red;");
  const output = bytes("color: red;");
  check("memo miss", String(m.get(c1, text, 0, text.length)), "false");
  m.insert(c1, text, 0, text.length, output, 0, output.length, true);
  check("memo hit", String(m.get(c1, text, 0, text.length)), "true");
  check("memo hasGroup", String(m.hasGroup) + String(m.outEnd - m.outStart), "true11");
  check("memo other context", String(m.get(c3, text, 0, text.length)), "false");
  for (let i = 0; i < 3000; i++) {
    const s = bytes("a" + i + ": b;");
    if (!m.get(c1, s, 0, s.length)) m.insert(c1, s, 0, s.length, s, 0, s.length, false);
  }
  const s77 = bytes("a77: b;");
  check("memo many", String(m.get(c1, s77, 0, s77.length)) + String(m.get(c1, text, 0, text.length)), "truetrue");
}

void DOC_EMPTY;
console.log(failures === 0 ? "ok: " + total + " checks" : "FAILED: " + failures + " of " + total);
if (failures !== 0) process.exit(1);
