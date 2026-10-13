// Port of vendor/bun/src/format/markdown/embed.rs: Markdown in the templates of JavaScript: Prettier's
// `language-js/embed/markdown.js`.
//
//   writeMarkdownTemplate(f, raw, rawStart, rawEnd, options): boolean
//
// The formatter of JavaScript decides what is a candidate (Rust `is_candidate`, `has_embed_label`: a template with one quasi, in a
// tagged template whose tag is the identifier `md` or `markdown`, and `embeddedLanguageFormatting: "auto"`, whose cooked text
// exists) and gives the *raw* text of the quasi, `raw[rawStart, rawEnd)`. A blank template is "``" (`isBlank`: nothing but JS white
// space), which it writes itself. Returns whether the template was written; otherwise nothing is written.
import { ByteBuf } from "../../base/bytebuf.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { Stack } from "../../base/stack.ts";
import { Formatter } from "../ir/formatter.ts";
import { twMultiline } from "../ir/element.ts";
import { FormatOptions } from "../options.ts";
import {
  DOC_ALIGN,
  DOC_ARRAY,
  DOC_BREAK_PARENT,
  DOC_DEDENT,
  DOC_DEDENT_TO_ROOT,
  DOC_FILL,
  DOC_GROUP,
  DOC_IF_BREAK,
  DOC_INDENT,
  DOC_LINE,
  DOC_LINE_SUFFIX,
  DOC_LINE_SUFFIX_BOUNDARY,
  DOC_MARK_AS_ROOT,
  DOC_TEXT,
  IC_ALIGN_SPACES,
  LINE_HARD,
  LINE_LITERAL,
  LINE_SOFT,
  LINE_SPACE,
  docPool,
  docPop,
  docPush,
  textToDoc,
} from "../css/doc.ts";
import { templateDocument } from "./mod.ts";

// Parts of the flat document: (kind, a, b).
const OP_TEXT = 0;
const OP_LINE = 1;
const OP_ELEMENT = 2;

// Elements (`a` of an OP_ELEMENT)
const E_START_INDENT = 0;
const E_END_INDENT = 1;
const E_START_ALIGN = 2; // b: width
const E_END_ALIGN = 3; // b: width
const E_START_GROUP_FLAT = 4;
const E_START_GROUP_EXPAND = 5;
const E_END_GROUP = 6;
const E_START_FILL = 7;
const E_END_FILL = 8;
const E_START_ENTRY = 9;
const E_END_ENTRY = 10;
const E_START_COND_EXPANDED = 11;
const E_START_COND_FLAT = 12;
const E_END_COND = 13;
const E_EXPAND_PARENT = 14;

const ops = new I32Vec(256);

function push(kind: number, a: number, b: number): void {
  ops.push(kind);
  ops.push(a);
  ops.push(b);
}

function element(code: number, b: number): void {
  push(OP_ELEMENT, code, b);
}

// The parts of `doc`. Returns whether all of it can be written as a part of a document for JavaScript.
function flatten(doc: number, stack: Stack): boolean {
  if (!stack.enter()) return false;
  const ok = flattenInner(doc, stack);
  stack.leave();
  return ok;
}

function flattenInner(doc: number, stack: Stack): boolean {
  const p = docPool;
  const tag = p.tag[doc] | 0;
  switch (tag) {
    case DOC_TEXT:
      if ((p.b[doc] | 0) > 0) push(OP_TEXT, doc, 0);
      return true;
    case DOC_ARRAY: {
      const count = p.b[doc] | 0;
      for (let i = 0; i < count; i++) {
        if (!flatten(docPool.kids[(docPool.a[doc] | 0) + i] | 0, stack)) return false;
      }
      return true;
    }
    case DOC_INDENT: {
      element(E_START_INDENT, 0);
      const ok = flatten(p.a[doc] | 0, stack);
      element(E_END_INDENT, 0);
      return ok;
    }
    case DOC_ALIGN: {
      const kind = p.b[doc] | 0;
      // The lines of a block quote start with a text, which the other documents have no way to say.
      if (kind !== IC_ALIGN_SPACES) return false;
      const width = p.c[doc] | 0;
      if (width === 0) return flatten(p.a[doc] | 0, stack);
      element(E_START_ALIGN, width);
      const ok = flatten(p.a[doc] | 0, stack);
      element(E_END_ALIGN, width);
      return ok;
    }
    case DOC_MARK_AS_ROOT:
      return flatten(p.a[doc] | 0, stack);
    case DOC_GROUP: {
      element(((p.b[doc] | 0) & 1) !== 0 ? E_START_GROUP_EXPAND : E_START_GROUP_FLAT, 0);
      const ok = flatten(p.a[doc] | 0, stack);
      element(E_END_GROUP, 0);
      return ok;
    }
    case DOC_FILL: {
      element(E_START_FILL, 0);
      const count = p.b[doc] | 0;
      let ok = true;
      for (let i = 0; i < count && ok; i++) {
        element(E_START_ENTRY, 0);
        ok = flatten(docPool.kids[(docPool.a[doc] | 0) + i] | 0, stack);
        element(E_END_ENTRY, 0);
      }
      element(E_END_FILL, 0);
      return ok;
    }
    case DOC_IF_BREAK: {
      if ((p.c[doc] | 0) !== 0) return false;
      element(E_START_COND_EXPANDED, 0);
      let ok = flatten(p.a[doc] | 0, stack);
      element(E_END_COND, 0);
      if (!ok) return false;
      element(E_START_COND_FLAT, 0);
      ok = flatten(p.b[doc] | 0, stack);
      element(E_END_COND, 0);
      return ok;
    }
    case DOC_LINE:
      push(OP_LINE, p.a[doc] | 0, 0);
      return true;
    case DOC_BREAK_PARENT:
      element(E_EXPAND_PARENT, 0);
      return true;
    // DOC_DEDENT, DOC_DEDENT_TO_ROOT, DOC_LINE_SUFFIX, DOC_LINE_SUFFIX_BOUNDARY: not in a document for JavaScript.
    case DOC_DEDENT:
    case DOC_DEDENT_TO_ROOT:
    case DOC_LINE_SUFFIX:
    case DOC_LINE_SUFFIX_BOUNDARY:
    default:
      return false;
  }
}

const NEWLINES = new Uint8Array(0);
let newlines: Uint8Array = NEWLINES;

// Line breaks that are written as they are, with nothing taken away before them and nothing put behind them.
function writeLineBreaks(count: number, f: Formatter): void {
  if (newlines.length < count) {
    newlines = new Uint8Array(count * 2);
    newlines.fill(10);
  }
  f.textBytesWithWidth(newlines, 0, count, twMultiline(0));
}

const escaped = new ByteBuf(256);

// Prettier's `escapeTemplateCharacters(doc, true)`, for one text.
function writeEscaped(text: Uint8Array, s: number, e: number, f: Formatter): void {
  let hasBacktick = false;
  for (let i = s; i < e; i++) {
    if ((text[i] | 0) === 96) {
      hasBacktick = true;
      break;
    }
  }
  if (!hasBacktick) {
    f.textBytes(text, s, e);
    return;
  }
  escaped.reset();
  let backslashes = 0;
  for (let i = s; i < e; i++) {
    const b = text[i] | 0;
    if (b === 96) {
      // The backslashes before it are doubled.
      escaped.fill(92, backslashes + 1);
    }
    backslashes = b === 92 ? backslashes + 1 : 0;
    escaped.push(b);
  }
  f.textBytes(escaped.data, 0, escaped.len);
}

function writeElement(code: number, b: number, f: Formatter): void {
  switch (code) {
    case E_START_INDENT:
      f.startIndent();
      break;
    case E_END_INDENT:
      f.endIndent();
      break;
    case E_START_ALIGN:
      f.startAlign(b);
      break;
    case E_END_ALIGN:
      f.endAlign(b);
      break;
    case E_START_GROUP_FLAT:
      f.startGroupExpand(false);
      break;
    case E_START_GROUP_EXPAND:
      f.startGroupExpand(true);
      break;
    case E_END_GROUP:
      f.endGroup();
      break;
    case E_START_FILL:
      f.startFill();
      break;
    case E_END_FILL:
      f.endFill();
      break;
    case E_START_ENTRY:
      f.startEntry();
      break;
    case E_END_ENTRY:
      f.endEntry();
      break;
    case E_START_COND_EXPANDED:
      f.startIfGroupBreaks();
      break;
    case E_START_COND_FLAT:
      f.startIfGroupFits();
      break;
    case E_END_COND:
      f.endConditional();
      break;
    case E_EXPAND_PARENT:
      f.expandParent();
      break;
    default:
      break;
  }
}

function writeOps(f: Formatter): void {
  const d = ops.data;
  const n = (ops.len / 3) | 0;
  let index = 0;
  while (index < n) {
    const kind = d[index * 3] | 0;
    const a = d[index * 3 + 1] | 0;
    const b = d[index * 3 + 2] | 0;
    index = index + 1;
    if (kind === OP_TEXT) {
      const start = docPool.a[a] | 0;
      writeEscaped(docPool.bytes, start, start + (docPool.b[a] | 0), f);
    } else if (kind === OP_ELEMENT) {
      writeElement(a, b, f);
    } else if (a === LINE_SPACE) {
      f.softLineBreakOrSpace();
    } else if (a === LINE_SOFT) {
      f.softLineBreak();
    } else if (a === LINE_LITERAL) {
      // The line break is written as it is. The other only says how far the next line is indented.
      writeLineBreaks(1, f);
      f.hardLineBreak();
    } else {
      // LINE_HARD. Several in a row, with nothing written between them, are empty lines. The last says how far the next line is
      // indented.
      let run = 0;
      while (index + run < n) {
        const k = d[(index + run) * 3] | 0;
        if (k === OP_LINE && (d[(index + run) * 3 + 1] | 0) !== LINE_HARD) break;
        if (k === OP_TEXT) break;
        run = run + 1;
      }
      let last = -1;
      for (let i = run - 1; i >= 0; i--) {
        if ((d[(index + i) * 3] | 0) === OP_LINE) {
          last = i;
          break;
        }
      }
      if (last < 0) {
        f.hardLineBreak();
        continue;
      }
      let lines = 0;
      for (let i = 0; i < last; i++) {
        if ((d[(index + i) * 3] | 0) === OP_LINE) lines = lines + 1;
      }
      const count = 2 + lines;
      // The printer writes no more than one empty line for line breaks.
      if (count === 2) f.hardLineBreak();
      else writeLineBreaks(count, f);
      for (let i = 0; i < last; i++) {
        if ((d[(index + i) * 3] | 0) === OP_ELEMENT) writeElement(d[(index + i) * 3 + 1] | 0, d[(index + i) * 3 + 2] | 0, f);
      }
      if (count === 2) f.emptyLine();
      else f.hardLineBreak();
      index = index + last + 1;
    }
  }
}

const dedented = new ByteBuf(1024);
const text = new ByteBuf(1024);

/** Writes the template whose raw text is `raw[rawStart, rawEnd)` as Markdown, if it can be. Returns whether it has. */
export function writeMarkdownTemplate(f: Formatter, raw: Uint8Array, rawStart: number, rawEnd: number, options: FormatOptions): boolean {
  // `\\`` is a backtick, and the backslashes before it are escaped.
  text.reset();
  let backslashes = 0;
  for (let index = rawStart; index < rawEnd; index++) {
    let byte = raw[index] | 0;
    if (byte === 96) {
      // text.truncate(text.len() - backslashes.div_ceil(2))
      text.len = text.len - ((backslashes + 1) >> 1);
    } else if (byte === 13) {
      if (index + 1 < rawEnd && (raw[index + 1] | 0) === 10) continue;
      byte = 10;
    }
    backslashes = byte === 92 ? backslashes + 1 : 0;
    text.push(byte);
  }
  // The indentation of the first line that has something on it is taken away from all lines.
  let indentStart = 0;
  let indentEnd = 0;
  {
    let from = 0;
    while (true) {
      let le = from;
      while (le < text.len && (text.data[le] | 0) !== 10) le = le + 1;
      let allWs = true;
      for (let i = from; i < le; i++) {
        const b = text.data[i] | 0;
        if (!(b === 32 || b === 9 || b === 12 || b === 13)) {
          allWs = false;
          break;
        }
      }
      if (!allWs) {
        indentStart = from;
        indentEnd = from;
        while (indentEnd < le && isBlankByte(text.data[indentEnd] | 0)) indentEnd = indentEnd + 1;
        break;
      }
      if (le >= text.len) break;
      from = le + 1;
    }
  }
  const indentLen = indentEnd - indentStart;
  let source = text.view();
  if (indentLen > 0) {
    dedented.reset();
    let from = 0;
    let first = true;
    const t = text.data;
    while (true) {
      let le = from;
      while (le < text.len && (t[le] | 0) !== 10) le = le + 1;
      if (!first) dedented.push(10);
      first = false;
      let hasPrefix = le - from >= indentLen;
      for (let i = 0; i < indentLen && hasPrefix; i++) {
        if ((t[from + i] | 0) !== (t[indentStart + i] | 0)) hasPrefix = false;
      }
      dedented.append(t, hasPrefix ? from + indentLen : from, le);
      if (le >= text.len) break;
      from = le + 1;
    }
    source = dedented.view();
  }

  docPush();
  let written = false;
  const document = templateDocument(source, options);
  if (document >= 0) {
    const doc = textToDoc(document);
    if (doc >= 0) {
      ops.reset();
      if (flatten(doc, Stack.create())) {
        f.tokenStr("`");
        if (indentLen === 0) {
          writeLineBreaks(1, f);
          f.expandParent();
          f.startDedentToRoot();
          writeOps(f);
          f.endDedentToRoot();
        } else {
          f.startIndent();
          f.softLineBreak();
          writeOps(f);
          f.endIndent();
        }
        f.softLineBreak();
        f.tokenStr("`");
        written = true;
      }
    }
  }
  docPop();
  return written;
}

function isBlankByte(b: number): boolean {
  return b === 32 || b === 9 || b === 12 || b === 13;
}
