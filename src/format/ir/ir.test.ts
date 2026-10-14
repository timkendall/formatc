// Self-test of the IR and its printer. Runs under `node src/format/ir/ir.test.ts` and as a scriptc-compiled binary
// (`scriptc build src/format/ir/ir.test.ts -o /tmp/ir-test`) with identical output. Exit code 1 if a check failed.
//
// - the documents of cases.ts (each also checked against Prettier by tools/ir-check.ts);
// - behaviour that is specific to ir/ (spaces, empty lines, line endings, capturing, reserved tags, source texts,
//   multi-line texts, cursor marks, embedded sources, ...);
// - a checksum of the output for random documents (tools/ir-fuzz.ts compares those with Prettier), so that the compiled
//   program and node can be compared by diffing the output.
import { ByteBuf } from "../../base/bytebuf.ts";
import { FormatOptions, FLAVOR_OXFMT, INDENT_TAB, LINE_ENDING_AUTO, LINE_ENDING_CR, LINE_ENDING_CRLF } from "../options.ts";
import { Scratch, startDocument, finishAndPrint, marksStart, marksEnd } from "./run.ts";
import { Formatter } from "./formatter.ts";
import { cases, Case } from "./cases.ts";
import * as T from "./testdoc.ts";
import {
  CURSOR_REGION_END,
  CURSOR_REGION_START,
  LABEL_MEMBER_CHAIN,
  token,
  tokenText,
} from "./element.ts";
import { propagateExpand } from "./document.ts";
import { printDocument } from "./printer.ts";
import { Storage } from "./storage.ts";
import { Tracker } from "./document.ts";
import { stringWidth, stringWidthAs, textWidth } from "./width.ts";
import { twIsMultiline, twIsOneString, twValue } from "./element.ts";
import { utf8Bytes } from "../../base/bytes.ts";

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

function checkNum(name: string, actual: number, expected: number): void {
  total = total + 1;
  if (actual === expected) return;
  failures = failures + 1;
  console.log("FAIL " + name + ": expected " + expected + ", got " + actual);
}

function checkBool(name: string, actual: boolean, expected: boolean): void {
  total = total + 1;
  if (actual === expected) return;
  failures = failures + 1;
  console.log("FAIL " + name + ": expected " + expected + ", got " + actual);
}

const defaults = new FormatOptions();
const scratch = new Scratch(defaults);
const out = new ByteBuf(1024);

function optionsFor(width: number, useTabs: boolean, tabWidth: number): FormatOptions {
  const o = new FormatOptions();
  o.lineWidth = width;
  o.indentWidth = tabWidth;
  if (useTabs) o.indentStyle = INDENT_TAB;
  return o;
}

function printed(f: Formatter): string {
  const out$ = out;
  out$.reset();
  const r = finishAndPrint(f, out$);
  if (r !== 0) return "<error " + r + ">";
  return out$.toUtf8();
}

function render(d: T.D, o: FormatOptions): string {
  const f = startDocument(scratch, new Uint8Array(0), o, null);
  T.emit(new T.Emitter(f), d);
  return printed(f);
}

// ───────────────────────────── the documents of cases.ts ─────────────────────────────

function runCases(): void {
  const all = cases();
  let ok = 0;
  for (let i = 0; i < all.length; i++) {
    const c: Case = all[i];
    const actual = render(c.doc, optionsFor(c.width, c.useTabs, c.tabWidth));
    total = total + 1;
    if (actual === c.expected) {
      ok = ok + 1;
    } else {
      failures = failures + 1;
      console.log("FAIL case: " + c.name);
      console.log("  expected: " + JSON.stringify(c.expected));
      console.log("  actual:   " + JSON.stringify(actual));
    }
  }
  console.log("cases: " + ok + "/" + all.length);
}

// ───────────────────────────── behaviour that is specific to ir/ ─────────────────────────────

function w(width: number): FormatOptions {
  return optionsFor(width, false, 2);
}

function specific(): void {
  const t = T.text;
  // Space: not at the start or at the end of a line, one at most
  check("space between", render(T.seq(t("a"), T.space(), t("b")), w(80)), "a b");
  check("space at the start", render(T.seq(T.space(), t("a")), w(80)), "a");
  check("space at the end of a line", render(T.seq(t("a"), T.space(), T.hardline(), t("b")), w(80)), "a\nb");
  check("two spaces are one", render(T.seq(t("a"), T.space(), T.space(), t("b")), w(80)), "a b");
  check("space after a line break", render(T.seq(t("a"), T.hardline(), T.space(), t("b")), w(80)), "a\nb");
  check("space and a soft line", render(T.group(t("a"), T.space(), T.line(), t("b")), w(80)), "a b");
  // Empty lines
  check("empty line", render(T.seq(t("a"), T.emptyLine(), t("b")), w(80)), "a\n\nb");
  check("two empty lines are one", render(T.seq(t("a"), T.emptyLine(), T.emptyLine(), t("b")), w(80)), "a\n\nb");
  check("no line break on an empty line", render(T.seq(t("a"), T.hardline(), T.hardline(), t("b")), w(80)), "a\nb");
  check("empty line after a hard line", render(T.seq(t("a"), T.hardline(), T.emptyLine(), t("b")), w(80)), "a\n\nb");
  check("indentation of an empty line", render(T.indent(t("a"), T.emptyLine(), t("b")), w(80)), "a\n\n  b");
  check("trailing white space is trimmed", render(T.seq(t("a "), T.hardline(), t("b")), w(80)), "a\nb");
  check("trailing tab is trimmed", render(T.seq(t("a\t"), T.hardline(), t("b")), w(80)), "a\nb");
  // Line endings
  const crlf = w(80);
  crlf.lineEnding = LINE_ENDING_CRLF;
  check("crlf", render(T.seq(t("a"), T.hardline(), t("b"), T.emptyLine(), t("c")), crlf), "a\r\nb\r\n\r\nc");
  const cr = w(80);
  cr.lineEnding = LINE_ENDING_CR;
  check("cr", render(T.seq(t("a"), T.hardline(), t("b")), cr), "a\rb");
  const auto = w(80);
  auto.lineEnding = LINE_ENDING_AUTO;
  const scratch$ = scratch;
  {
    const src = utf8Bytes("x\r\ny\n");
    const f = startDocument(scratch$, src, auto, null);
    T.emit(new T.Emitter(f), T.seq(t("a"), T.hardline(), t("b")));
    check("auto picks crlf from the source", printed(f), "a\r\nb");
    const f2 = startDocument(scratch$, utf8Bytes("x\ny\n"), auto, null);
    T.emit(new T.Emitter(f2), T.seq(t("a"), T.hardline(), t("b")));
    check("auto picks lf from the source", printed(f2), "a\nb");
    const f3 = startDocument(scratch$, utf8Bytes("x\ry\n"), auto, null);
    T.emit(new T.Emitter(f3), T.seq(t("a"), T.hardline(), t("b")));
    check("auto picks cr from the source", printed(f3), "a\rb");
  }
  // Line suffix and indentation
  check(
    "line suffix keeps the indentation of its place",
    render(T.indent(T.seq(t("a"), T.lineSuffix(T.hardline(), t("c")), T.hardline(), t("b"))), w(80)),
    "a\n  c\n  b",
  );
  check(
    "line suffixes in order",
    render(T.seq(t("a"), T.lineSuffix(t(" 1")), T.lineSuffix(t(" 2")), T.hardline(), t("b")), w(80)),
    "a 1 2\nb",
  );
  // ExpandParent in a best fitting does not break what is around it
  check(
    "best fitting does not expand its parent",
    render(T.group(t("a"), T.line(), T.best(T.seq(t("b"), T.hardline(), t("c")), t("d"))), w(80)),
    "a b\nc",
  );

  // Multi-line texts: the width is that of the first line, and a line break in a text breaks the groups around it
  {
    const src = utf8Bytes("`a\nbb`");
    const f = startDocument(scratch$, src, w(80), null);
    f.startGroup();
    f.token(token("x"));
    f.softLineBreakOrSpace();
    f.textSource(0, src.length);
    f.softLineBreakOrSpace();
    f.token(token("y"));
    f.endGroup();
    check("a text with a line break breaks the group", printed(f), "x\n`a\nbb`\ny");
  }
  {
    const src = utf8Bytes("`a\nbb`");
    const f = startDocument(scratch$, src, w(80), null);
    f.token(token("x"));
    f.textSource(0, src.length);
    f.token(token("y"));
    check("a text with a line break is printed as it is", printed(f), "x`a\nbb`y");
  }
  checkNum("width of text with a tab", twValue(textWidth(utf8Bytes("a\tb"), 0, 3, 0, 0)), 2);
  checkNum("width of text with a tab, oxfmt", twValue(textWidth(utf8Bytes("a\tb"), 0, 3, FLAVOR_OXFMT, 4)), 6);
  checkBool("multi-line", twIsMultiline(textWidth(utf8Bytes("abc\ndef"), 0, 7, 0, 0)), true);
  checkNum("width up to the first line break", twValue(textWidth(utf8Bytes("abc\ndef"), 0, 7, 0, 0)), 3);
  checkBool("not one string", twIsOneString(textWidth(utf8Bytes("abc\ndef"), 0, 7, 0, 0)), false);

  // Source texts
  {
    const src = utf8Bytes("foo 中文 bar\\u0061b ok");
    const f = startDocument(scratch$, src, w(10), null);
    f.startGroup();
    f.sourceText(0, 3); // foo
    f.softLineBreakOrSpace();
    f.sourceText(4, 10); // CJK: width 4 (odd block)
    f.softLineBreakOrSpace();
    f.sourceText(11, src.length - 3);
    f.endGroup();
    check("source texts of odd width", printed(f), "foo\n中文\nbarab");
  }
  {
    // `ab` is written `ab`
    const src = utf8Bytes("\\u0061b \\u{62}c");
    const f = startDocument(scratch$, src, w(80), null);
    f.sourceText(0, 7);
    f.space();
    f.sourceText(8, src.length);
    check("unicode escapes in names", printed(f), "ab bc");
  }
  {
    const src = utf8Bytes("abcdefghij".repeat(20));
    const f = startDocument(scratch$, src, w(80), null);
    f.textSourceNoWs(0, 15);
    f.space();
    f.textSource(20, 25);
    check("long source text", printed(f), "abcdefghijabcde abcde");
  }
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(80), null);
    const buf = f.textBuf();
    const at = buf.len;
    buf.appendAscii("built");
    buf.appendAscii("-text");
    f.endBuiltText(at);
    f.space();
    f.textBytes(utf8Bytes("xyz"), 0, 3);
    f.space();
    f.textBytesNoWs(utf8Bytes("中"), 0, 3);
    f.space();
    f.textStr("s");
    check("owned texts", printed(f), "built-text xyz 中 s");
  }

  // Capturing: memoized content is written any number of times; willBreak is known at once
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(8), null);
    const slot = f.startCapture();
    f.token(token("aa"));
    f.softLineBreakOrSpace();
    f.token(token("bb"));
    const h = f.endCapture(slot);
    checkBool("capture has no hard break", f.willBreak(h), false);
    checkBool("capture may directly break", f.mayDirectlyBreak(h), true);
    checkNum("a capture stays where it is written, behind a skip", f.len(), 14);
    f.startGroup();
    f.writeInterned(h);
    f.endGroup();
    f.hardLineBreak();
    f.startGroup();
    f.writeInterned(h);
    f.writeInterned(h);
    f.endGroup();
    check("interned content written twice", printed(f), "aa bb\naa\nbbaa\nbb");
  }
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(80), null);
    const slot = f.startCapture();
    f.token(token("a"));
    f.hardLineBreak();
    f.token(token("b"));
    const h = f.endCapture(slot);
    checkBool("capture with a hard break", f.willBreak(h), true);
    f.startGroup();
    f.token(token("x"));
    f.softLineBreakOrSpace();
    f.writeInterned(h);
    f.endGroup();
    check("a hard break in interned content breaks the group", printed(f), "x\na\nb");
  }
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(80), null);
    const slot = f.startCapture();
    f.endCapture(slot);
    checkNum("an empty capture is -1", f.endCapture(f.startCapture()), -1);
    f.writeInterned(-1);
    f.token(token("a"));
    check("writing nothing", printed(f), "a");
  }
  {
    // a capture of a single element is written as that element
    const f = startDocument(scratch$, new Uint8Array(0), w(80), null);
    const slot = f.startCapture();
    f.token(token("one"));
    const h = f.endCapture(slot);
    const before = f.len();
    f.writeInterned(h);
    checkNum("a single element is copied", f.len() - before, 1);
    check("single", printed(f), "one");
  }
  // Labels
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(80), null);
    const start = f.len();
    f.startLabelled(LABEL_MEMBER_CHAIN);
    f.token(token("a"));
    f.endLabelled();
    checkBool("label from a position", f.hasLabelFrom(start, LABEL_MEMBER_CHAIN), true);
    checkBool("another label", f.hasLabelFrom(start, 2), false);
    const s2 = f.startCapture();
    f.startLabelled(LABEL_MEMBER_CHAIN);
    f.token(token("b"));
    f.endLabelled();
    const h = f.endCapture(s2);
    checkBool("label of captured content", f.hasLabel(h, LABEL_MEMBER_CHAIN), true);
    const s3 = f.startCapture();
    f.token(token("c"));
    f.startLabelled(LABEL_MEMBER_CHAIN);
    f.endLabelled();
    checkBool("label must come first", f.hasLabel(f.endCapture(s3), LABEL_MEMBER_CHAIN), false);
    check("labels print nothing", printed(f), "a");
  }
  // reserveTag / groupFrom
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(8), null);
    const start = f.reserveTag();
    f.token(token("("));
    f.startSoftBlockIndent();
    f.token(token("aaaa"));
    f.token(token(","));
    f.softLineBreakOrSpace();
    f.token(token("bbbb"));
    f.endSoftBlockIndent();
    f.token(token(")"));
    const shouldExpand = f.willBreakFrom(start + 1);
    checkBool("nothing forces a break", shouldExpand, false);
    f.groupFrom(start, shouldExpand);
    check("group from a reserved tag, breaking", printed(f), "(\n  aaaa,\n  bbbb\n)");
  }
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(80), null);
    const start = f.reserveTag();
    f.token(token("a"));
    f.softLineBreakOrSpace();
    f.hardLineBreak();
    f.token(token("b"));
    checkBool("a hard line break is seen", f.willBreakFrom(start + 1), true);
    f.groupFrom(start, true);
    check("group from a reserved tag, expanded", printed(f), "a\nb");
  }
  {
    // a reserved place that is never used is nothing
    const f = startDocument(scratch$, new Uint8Array(0), w(80), null);
    f.startGroup();
    const unused = f.reserveTag();
    f.token(token("a"));
    f.softLineBreakOrSpace();
    f.token(token("b"));
    f.endGroup();
    checkBool("unused reserved place", unused > 0, true);
    check("unused reserved tag", printed(f), "a b");
  }
  // a reserved tag inside a capture, used and not used
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(8), null);
    const slot = f.startCapture();
    const r1 = f.reserveTag();
    f.token(token("("));
    f.startSoftBlockIndent();
    f.token(token("aaaa"));
    f.softLineBreakOrSpace();
    f.token(token("bbbb"));
    f.endSoftBlockIndent();
    f.token(token(")"));
    f.groupFrom(r1, f.willBreakFrom(r1 + 1));
    const r2 = f.reserveTag();
    f.token(token("x"));
    checkBool("unused reserve is a nop", r2 > r1, true);
    const h = f.endCapture(slot);
    checkBool("capture with a reserved tag does not break", f.willBreak(h), false);
    f.writeInterned(h);
    f.writeInterned(h);
    check("reserved tags in a capture", printed(f), "(\n  aaaa\n  bbbb\n)x(\n  aaaa\n  bbbb\n)x");
  }
  // write without soft lines
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(1), null);
    const slot = f.startCapture();
    f.startGroup();
    f.token(token("a"));
    f.softLineBreakOrSpace();
    f.token(token("b"));
    f.softLineBreak();
    f.token(token("c"));
    f.startIfGroupBreaks();
    f.token(token("!"));
    f.endConditional();
    f.startSoftBlockIndent();
    f.token(token("d"));
    f.endSoftBlockIndent();
    f.endGroup();
    f.endWithoutSoftLines(slot);
    check("without soft lines", printed(f), "a bcd");
  }
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(80), null);
    const slot = f.startCapture();
    const v1 = f.startVariant();
    f.token(token("flat"));
    const h1 = f.endVariant(v1);
    const v2 = f.startVariant();
    f.token(token("x"));
    f.softLineBreak();
    f.token(token("y"));
    const h2 = f.endVariant(v2);
    f.bestFitting2(h1, h2);
    f.endWithoutSoftLines(slot);
    check("without soft lines takes the flattest variant", printed(f), "flat");
  }
  // best fitting, variants written by hand
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(7), null);
    const v1 = f.startVariant();
    f.token(token("aaaaaaaaaa"));
    const h1 = f.endVariant(v1);
    const v2 = f.startVariant();
    f.token(token("bbbb"));
    f.softLineBreak();
    f.token(token("bbbb"));
    const h2 = f.endVariant(v2);
    const v3 = f.startVariant();
    f.token(token("c"));
    f.hardLineBreak();
    f.token(token("c"));
    const h3 = f.endVariant(v3);
    f.bestFitting3(h1, h2, h3);
    check("best fitting of 3", printed(f), "c\nc");
  }
  // group ids and the stability of ids
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(80), null);
    const a = f.groupId();
    const b = f.groupId();
    checkBool("ids differ", a !== b && a > 0 && b > 0, true);
  }
  // cursor marks
  {
    const f = startDocument(scratch$, new Uint8Array(0), w(80), null);
    f.token(token("ab"));
    f.cursor(CURSOR_REGION_START);
    f.token(token("cd"));
    f.cursor(CURSOR_REGION_END);
    f.token(token("ef"));
    check("cursor prints nothing", printed(f), "abcdef");
    checkNum("cursor start", marksStart(), 2);
    checkNum("cursor end", marksEnd(), 4);
  }
  // Embedded: a document for another source is written into this one
  {
    const outer = utf8Bytes("outer 12345 end");
    const f = startDocument(scratch$, outer, w(80), null);
    f.sourceText(0, 5);
    f.space();
    // a part of the outer source: ranges are shifted
    f.beginEmbedded(outer.subarray(6, 11), 6);
    f.sourceText(0, 2);
    f.sourceText(3, 5);
    f.endEmbedded();
    f.space();
    // another text: it is copied
    f.beginEmbedded(utf8Bytes("inner"), -1);
    f.sourceText(0, 5);
    f.endEmbedded();
    f.space();
    f.sourceText(12, 15);
    check("embedded sources", printed(f), "outer 1245 inner end");
  }
  // propagateExpand over a document that was written without a Formatter gives what the Formatter gives
  const out$ = out;
  {
    const st = new Storage(64);
    const tr = new Tracker(st);
    const a = token("a");
    const l = token("(");
    st.push(26 /* T_START_GROUP */, 0, 0, 0);
    st.pushToken(l);
    st.push(18 /* T_START_INDENT_WITH_LINE */, 1 /* soft */, 0, 0);
    st.pushToken(a);
    st.push(3 /* E_LINE */, 2 /* hard */, 0, 0);
    st.pushToken(a);
    st.push(19 /* T_END_INDENT_WITH_LINE */, 1, 0, 0);
    st.push(27 /* T_END_GROUP */, 0, 0, 0);
    propagateExpand(10, st.len, tr);
    out$.reset();
    const r = printDocument(st, 10, st.len, new Uint8Array(0), w(80), out$);
    checkNum("propagateExpand result", r, 0);
    check("propagateExpand breaks the group of a hard line break", out$.toUtf8(), "(\n  a\n  a\n");
  }
  // reuse: the same scratch twice gives the same text
  {
    const d = T.randomDoc(7, 3, false);
    const a = render(d, w(40));
    const b = render(d, w(40));
    check("reuse of the scratch", a, b);
  }
  // tokens
  {
    const h1 = token("=>");
    const h2 = token("=>");
    checkNum("tokens are deduplicated", h1, h2);
    check("token text", tokenText(h1), "=>");
  }
  // tokens of every length: 1 to 12 bytes are in the element, longer ones are in the table of tokens
  {
    const words = ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg", "abcdefgh", "abcdefghi", "abcdefghij", "abcdefghijk", "abcdefghijkl", "abcdefghijklm", "abcdefghijklmn", "abcdefghijklmnopqrstuvwxyz0123456789"];
    const f = startDocument(scratch$, new Uint8Array(0), w(1000), null);
    let expected = "";
    for (let i = 0; i < words.length; i++) {
      f.token(token(words[i]));
      f.space();
      expected += words[i] + " ";
    }
    check("tokens of every length", printed(f), expected.substring(0, expected.length - 1));
    const g = startDocument(scratch$, new Uint8Array(0), w(10), null);
    g.startGroup();
    g.tokenIfBreaks(token("abcdefghijklmnopq"));
    g.token(token("abcdefghijklm"));
    g.softLineBreak();
    g.tokenIfBreaks(token("xyz"));
    g.tokenIfBreaks(token("abcdefghijklmnopq"));
    g.endGroup();
    check("token if breaks, broken", printed(g), "abcdefghijklmnopqabcdefghijklm\nxyzabcdefghijklmnopq");
    const h = startDocument(scratch$, new Uint8Array(0), w(100), null);
    h.startGroup();
    h.tokenIfBreaks(token("abcdefghijklmnopq"));
    h.token(token("abcdefghijklm"));
    h.softLineBreak();
    h.tokenIfBreaks(token("xyz"));
    h.endGroup();
    check("token if breaks, flat", printed(h), "abcdefghijklm");
  }
  // widths
  checkNum("ascii width", stringWidth(utf8Bytes("hello"), 0, 5), 5);
  checkNum("cjk width", stringWidth(utf8Bytes("中文"), 0, 6), 4);
  checkNum("emoji width", stringWidth(utf8Bytes("👍"), 0, 4), 2);
  checkNum("combining width", stringWidth(utf8Bytes("é"), 0, 3), 1);
  checkNum("control characters are nothing", stringWidth(utf8Bytes("a\u0001b"), 0, 3), 2);
  checkNum("control characters are columns in oxfmt", stringWidthAs(utf8Bytes("a\u0001b"), 0, 3, FLAVOR_OXFMT), 3);
  checkNum("regional indicators", stringWidth(utf8Bytes("🇺🇸"), 0, 8), 2);
  checkNum("keycap", stringWidth(utf8Bytes("1️⃣"), 0, 7), 2);
  checkNum("zwj family", stringWidth(utf8Bytes("👨‍👩‍👧"), 0, 20), 2);
}

// ───────────────────────────── random documents ─────────────────────────────

function hashString(h: number, s: string): number {
  let x = h;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return x | 0;
}

function randoms(): void {
  let h = -2128831035;
  let n = 0;
  let errors = 0;
  const widths = [10, 16, 20, 30, 40, 80];
  for (let seed = 1; seed <= 3000; seed++) {
    const d = T.randomDoc(seed, 1 + (seed % 4), seed % 7 === 0);
    const o = optionsFor(widths[seed % 6], seed % 5 === 0, seed % 3 === 0 ? 4 : 2);
    const s = render(d, o);
    if (s.charCodeAt(0) === 60 && s.startsWith("<error")) errors = errors + 1;
    h = hashString(h, s);
    h = hashString(h, "\u0000");
    n = n + 1;
  }
  checkNum("random documents without errors", errors, 0);
  console.log("random documents: " + n + " checksum " + (h >>> 0).toString(16));
}

runCases();
specific();
randoms();
console.log("checks: " + (total - failures) + "/" + total);
if (failures > 0) {
  console.log("FAILED");
  process.exit(1);
}
console.log("ok");
