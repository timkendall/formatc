// Port of vendor/bun/src/format/markdown/printer.rs: the document of a Markdown text: Prettier's
// `src/language-markdown/print/*.js`.
//
// Documents are handles of the pool of `css/doc.ts` (see docs/CSS_DOC_API.md). Where Rust builds a `Vec<Doc>` and then a `fill`
// or an array, the parts are pushed on the pool's stack (`docBegin()` / `docAdd()` / `docArray(mark)`): a list is finished
// before the code that follows it starts another, so lists nest like a stack. A function that returns a `Doc` leaves the stack as
// it found it.
import { ByteBuf } from "../../base/bytebuf.ts";
import { decodeUtf8, decodeUtf8Back, utf8Len } from "../../base/utf8.ts";
import { Stack } from "../../base/stack.ts";
import { FORMAT_NESTED_TOO_DEEPLY, FORMAT_OK } from "../errors.ts";
import {
  FormatOptions,
  PROSE_WRAP_ALWAYS,
  PROSE_WRAP_NEVER,
  PROSE_WRAP_PRESERVE,
  QUOTE_DOUBLE,
  FLAVOR_OXFMT,
  INDENT_TAB,
} from "../options.ts";
import { stringWidthAs } from "../ir/width.ts";
import { hasIndentedDelimiter, parseFrontMatter } from "../front_matter.ts";
import { firstChar, charLen, lastChar, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  DOC_BREAK_PARENT_DOC,
  DOC_EMPTY,
  DOC_HARDLINE,
  DOC_HARD_LINE,
  DOC_LINE_DOC,
  DOC_LITERAL_LINE,
  DOC_SOFTLINE,
  DOC_ARRAY,
  DOC_FILL,
  alignTextId,
  alignWithSpaces,
  docAdd,
  docArray,
  docAscii,
  docBegin,
  docFill,
  docPool,
  docText,
  docs2,
  docs3,
  docs4,
  group,
  hardline,
  indent,
  Elements,
  Printer as DocPrinter,
} from "../css/doc.ts";
import { isUnicodePunctuation } from "../../md/lib.ts";
import {
  ALIGN_CENTER,
  ALIGN_LEFT,
  ALIGN_NONE,
  ALIGN_RIGHT,
  F_ALIGNED,
  F_ORDERED,
  F_SPREAD,
  K_BLOCKQUOTE,
  K_BREAK,
  K_CODE,
  K_DEFINITION,
  K_DELETE,
  K_DIRECTIVE,
  K_EMPHASIS,
  K_ES_COMMENT,
  K_EXPORT,
  K_FOOTNOTE_DEFINITION,
  K_FOOTNOTE_REFERENCE,
  K_FRONT_MATTER,
  K_HEADING,
  K_HTML,
  K_IMAGE,
  K_IMAGE_REFERENCE,
  K_IMPORT,
  K_INLINE_CODE,
  K_INLINE_MATH,
  K_JSX,
  K_LINK,
  K_LINK_REFERENCE,
  K_LIQUID_NODE,
  K_LIST,
  K_LIST_ITEM,
  K_MATH,
  K_PARAGRAPH,
  K_ROOT,
  K_SENTENCE,
  K_STRONG,
  K_TABLE,
  K_TABLE_CELL,
  K_TABLE_ROW,
  K_TEXT,
  K_THEMATIC_BREAK,
  K_WIKI_LINK,
  NONE,
  REFERENCE_COLLAPSED,
  REFERENCE_FULL,
  STR_NO,
  TF_LEADING_PUNCT,
  TF_OWNED,
  TF_TRAILING_PUNCT,
  TK_CJ_LETTER,
  TK_CJK_PUNCTUATION,
  TK_K_LETTER,
  TK_NEWLINE,
  TK_NON_CJK,
  TK_NO_SPACE,
  TK_SPACE,
  Tree,
  isInline,
  isInlineWrapper,
} from "./ast.ts";
import { isIndentedCode, isPunctuation, isPunctuationUnit, orderedNumber, PLAIN, splitText } from "./preprocess.ts";
import {
  characterReference,
  containsByte,
  containsStr,
  countByte,
  endsWithStr,
  indexOfStr,
  isAsciiAlnum,
  isAsciiDigit,
  isAsciiPunct,
  isAsciiWs,
  isBlank,
  isCommonmarkWhitespace,
  startsWithStr,
} from "./strings.ts";

// `printDoc` of css/doc.ts with the `Elements` and the printer kept from one document to the next: a document is printed once per
// file and once per cell of a table, and the printer is a handful of arrays.
const sharedElements = new Elements();
const sharedPrinter = new DocPrinter();
let sharedBusy = false;

/** Appends what `doc` prints to `out`. `text` is what is formatted, for `endOfLine: "auto"`. Returns 0 or a `FORMAT_*` code. */
export function printDocument(doc: number, options: FormatOptions, text: Uint8Array, out: ByteBuf): number {
  let elements = sharedElements;
  let printer = sharedPrinter;
  let own = false;
  if (sharedBusy) {
    elements = new Elements();
    printer = new DocPrinter();
    own = true;
  } else {
    sharedBusy = true;
    elements.clear();
  }
  elements.document(doc);
  printer.init(options, text, out);
  printer.print(elements, 0, 0);
  const r = printer.result();
  if (!own) sharedBusy = false;
  return r;
}

// Code in another language, to be formatted. The code of mod.ts's `EmbedHook` gets the language, the code, how many columns are
// left of the line, and writes the formatted code to `out`.
export class EmbedHook {
  // Returns whether it has formatted `code` (cbuf[cs, ce)) of `language` (lbuf[ls, le)); then `out` has the text.
  format(lbuf: Uint8Array, ls: number, le: number, cbuf: Uint8Array, cs: number, ce: number, width: number, out: ByteBuf): boolean {
    return false;
  }
  // oxfmt's `parser_of_oxfmt(language).is_some()`: whether it formats code in `language`.
  knowsOxfmtLanguage(lbuf: Uint8Array, ls: number, le: number): boolean {
    return false;
  }
}

// Languages that mod.ts names (`MDX_JSX`, `MDX_ES_SYNTAX`: NUL, then `jsx` / `es`).
export const MDX_JSX = new Uint8Array([0, 106, 115, 120]);
export const MDX_ES_SYNTAX = new Uint8Array([0, 101, 115]);

const IGNORE_NONE = 0;
const IGNORE_NEXT = 1;
const IGNORE_START = 2;
const IGNORE_END = 3;

// What white space is written as.
const W_SPACE = 0;
const W_EMPTY = 1;
const W_LINE = 2;
const W_SOFTLINE = 3;
const W_HARDLINE = 4;

const QUOTE_ALIGN = alignTextId("> ");

const EMPTY = new Uint8Array(0);
const FOLLOW_DASH = 45;

// ---- scratch
const scratch = new ByteBuf(256);
const scratch2 = new ByteBuf(256);
let presentRuns = new Uint8Array(64);

// Whether a space or a tab is right before a line break in the code last scanned by `scanCode`.
let codeBlank = 0;

// The longest run of `marker` in buf[s, e); `codeBlank` says whether a space or a tab is right before a line break.
function scanCode(buf: Uint8Array, s: number, e: number, marker: number): number {
  let max = 0;
  let run = 0;
  let blank = 0;
  let prev = 0;
  for (let i = s; i < e; i++) {
    const b = buf[i] | 0;
    if (b === marker) {
      run = ((run | 0) + 1) | 0;
      if (run > max) max = run;
    } else {
      run = 0;
      if (b === 10 && (prev === 32 || prev === 9)) blank = 1;
    }
    prev = b;
  }
  codeBlank = blank;
  return max;
}

// Whether a space or a tab is right before a line break in buf[s, e).
function hasBlankBeforeNewline(buf: Uint8Array, s: number, e: number): boolean {
  for (let i = s + 1; i < e; i++) {
    if ((buf[i] | 0) === 10) {
      const p = buf[i - 1] | 0;
      if (p === 32 || p === 9) return true;
    }
  }
  return false;
}

// oxfmt's `print_url`
function urlOfOxfmt(url: Uint8Array, us: number, ue: number, isInParentheses: boolean, out: ByteBuf): void {
  let needsBrackets = false;
  for (let i = us; i < ue; i++) {
    const b = url[i] | 0;
    if (b < 32 || b === 127 || b === 32) {
      needsBrackets = true;
      break;
    }
  }
  if (!needsBrackets) {
    if (ue > us && (url[us] | 0) === 60) needsBrackets = true;
    else if (isInParentheses) {
      for (let i = us; i < ue; i++) {
        const b = url[i] | 0;
        if (b === 40 || b === 41) {
          needsBrackets = true;
          break;
        }
      }
    } else {
      // not balanced
      let depth = 0;
      let balanced = true;
      for (let i = us; i < ue; i++) {
        const b = url[i] | 0;
        if (b === 40) depth = depth + 1;
        else if (b === 41) depth = depth - 1;
        if (depth < 0 || depth > 3) {
          balanced = false;
          break;
        }
      }
      if (depth !== 0) balanced = false;
      needsBrackets = !balanced;
    }
  }
  if (needsBrackets) out.push(60);
  for (let i = us; i < ue; i++) {
    const b = url[i] | 0;
    let isEscaped = false;
    if (b === 92) isEscaped = i + 1 >= ue || isAsciiPunct(url[i + 1] | 0);
    else if (b === 38) isEscaped = characterReference(url, i, ue, null) >= 0;
    else if (b === 60 || b === 62) isEscaped = needsBrackets;
    if (isEscaped) out.push(92);
    out.push(b);
  }
  if (needsBrackets) out.push(62);
}

// oxfmt's `has_line_ranges`
function hasLineRanges(meta: Uint8Array, s: number, e: number): boolean {
  let i = s;
  // for each `{` after the first part
  while (true) {
    while (i < e && (meta[i] | 0) !== 123) i = i + 1;
    if (i >= e) return false;
    i = i + 1;
    let j = i;
    while (j < e && (meta[j] | 0) !== 125) j = j + 1;
    if (j >= e) return false;
    let hasDigit = false;
    let all = true;
    for (let k = i; k < j; k++) {
      const b = meta[k] | 0;
      if (isAsciiDigit(b)) hasDigit = true;
      else if (!(b === 44 || b === 45 || b === 32)) all = false;
    }
    if (hasDigit && all) return true;
    i = j;
  }
}

// The longest run of `marker` in text[s, e).
function maxContinuousCount(text: Uint8Array, s: number, e: number, marker: number): number {
  let max = 0;
  let i = s;
  while (i < e) {
    if ((text[i] | 0) !== marker) {
      i = i + 1;
      continue;
    }
    let run = 0;
    while (i + run < e && (text[i + run] | 0) === marker) run = run + 1;
    if (run > max) max = run;
    i = i + run;
  }
  return max;
}

// Prettier's `getMinNotPresentContinuousCount`
function minNotPresentContinuousCount(text: Uint8Array, s: number, e: number, marker: number): number {
  const max = maxContinuousCount(text, s, e, marker);
  if (max === 0) return 1;
  if (presentRuns.length < max + 2) presentRuns = new Uint8Array((max + 2) * 2);
  const present = presentRuns;
  for (let i = 0; i <= max + 1; i++) present[i] = 0;
  let i = s;
  while (i < e) {
    if ((text[i] | 0) !== marker) {
      i = i + 1;
      continue;
    }
    let run = 0;
    while (i + run < e && (text[i + run] | 0) === marker) run = run + 1;
    present[run] = 1;
    i = i + run;
  }
  let k = 1;
  while (present[k] === 1) k = k + 1;
  return k;
}

// Collects the parts of a `fill`: content and separators take turns.
//
// Where lines are not wrapped, every separator is a forced line break, and a `fill` writes the same as its parts one after the
// other. So that is what is made then, which is less work for everybody.
class FillParts {
  isFill: boolean;
  mark: number;
  // Where the content that is being put together, of a `fill`, starts on the pool's stack.
  contentMark: number;

  constructor(isFill: boolean) {
    this.isFill = isFill;
    this.mark = docBegin();
    this.contentMark = this.mark;
  }

  content(doc: number): void {
    docPool.add(doc);
  }

  endContent(): void {
    const p = docPool;
    const count = p.ns - this.contentMark;
    let d: number;
    if (count === 0) d = DOC_EMPTY;
    else if (count === 1) {
      d = p.stack[p.ns - 1] | 0;
      p.ns = p.ns - 1;
    } else d = p.array(this.contentMark);
    p.add(d);
    this.contentMark = p.ns;
  }

  separator(sep: number): void {
    if (this.isFill) this.endContent();
    docPool.add(sep);
    this.contentMark = docPool.ns;
  }

  hardline(): void {
    if (this.isFill) this.separator(DOC_HARDLINE);
    else {
      docPool.add(DOC_HARD_LINE);
      docPool.add(DOC_BREAK_PARENT_DOC);
    }
  }

  // Prettier's `flattenFill`: the parts of a `fill` in `doc` become parts of this one.
  flatten(doc: number): void {
    const p = docPool;
    const tag = p.tag[doc] | 0;
    if (tag === DOC_ARRAY) {
      if (!this.isFill) {
        p.addParts(doc);
        return;
      }
      const start = p.a[doc] | 0;
      const count = p.b[doc] | 0;
      for (let i = 0; i < count; i++) this.flatten(docPool.kids[start + i] | 0);
    } else if (tag === DOC_FILL) {
      const start = p.a[doc] | 0;
      const count = p.b[doc] | 0;
      for (let i = 0; i < count; i++) {
        const part = docPool.kids[start + i] | 0;
        if (i % 2 === 0) this.content(part);
        else this.separator(part);
      }
    } else {
      this.content(doc);
    }
  }

  finish(): number {
    if (!this.isFill) return docPool.array(this.mark);
    this.endContent();
    return docPool.fill(this.mark);
  }
}

function literalline(): number {
  return docs2(DOC_LITERAL_LINE, DOC_BREAK_PARENT_DOC);
}

export class Printer {
  // The text and the same with the front matter in any case: see `parse.blankFrontMatter`.
  text: Uint8Array;
  original: Uint8Array;
  tree: Tree;
  options: FormatOptions;
  embed: EmbedHook;
  // The document is for a template in JavaScript: no backticks.
  isInTemplate: boolean;
  isMdx: boolean;
  // How many columns what is being written is indented by.
  indentation: number;
  // What is being written is in a reference whose label is its text, which has to stay as it is.
  isInLabel: boolean;
  // For oxfmt: of the lists that have been asked about, the first of the lists of their kind that they follow.
  firstOfRun: Int32Array;
  stack: Stack;
  // Why a cell of a table could not be printed.
  failure: number;

  // ---- options, resolved
  proseWrap: number;
  isOxfmt: boolean;
  lineWidth: number;
  indentWidth: number;

  // ---- handles
  literallineDoc: number;
  markRootLiteralline: number;
  verbatimLineDoc: number;
  tickDoc: number;
  spaceDoc: number;

  // ---- scratch
  fmtOut: ByteBuf;

  // ---- root with `prettier-ignore-start` ranges
  rangeStarts: number[];
  rangeEnds: number[];
  rangeAt: number;
  isInRange: boolean;

  // `strOf` result
  sBuf: Uint8Array;
  sStart: number;
  sEnd: number;

  constructor(text: Uint8Array, original: Uint8Array, tree: Tree, options: FormatOptions, embed: EmbedHook, isInTemplate: boolean, isMdx: boolean) {
    this.text = text;
    this.original = original;
    this.tree = tree;
    this.options = options;
    this.embed = embed;
    this.isInTemplate = isInTemplate;
    this.isMdx = isMdx;
    this.indentation = 0;
    this.isInLabel = false;
    this.firstOfRun = new Int32Array(0);
    this.stack = Stack.forTree();
    this.failure = FORMAT_OK;
    this.proseWrap = options.proseWrap;
    this.isOxfmt = options.flavor === FLAVOR_OXFMT;
    this.lineWidth = options.lineWidth;
    this.indentWidth = options.indentWidth;
    this.literallineDoc = literalline();
    this.markRootLiteralline = docPool.markAsRoot(this.literallineDoc);
    this.verbatimLineDoc = docPool.dedentToRoot(DOC_HARDLINE);
    this.tickDoc = docAscii("`");
    this.spaceDoc = docAscii(" ");
    this.fmtOut = new ByteBuf(1024);
    this.rangeStarts = [];
    this.rangeEnds = [];
    this.rangeAt = 0;
    this.isInRange = false;
    this.sBuf = EMPTY;
    this.sStart = 0;
    this.sEnd = 0;
  }

  // ---------------------------------------------------------------------------------------------- small helpers

  // After it the string `h` is `sBuf[sStart, sEnd)`.
  strOf(h: number): void {
    const tree = this.tree;
    if (h === STR_NO) {
      this.sBuf = EMPTY;
      this.sStart = 0;
      this.sEnd = 0;
      return;
    }
    const s = tree.strStart[h] | 0;
    this.sBuf = (tree.strOwned[h] | 0) !== 0 ? tree.strings.data : this.text;
    this.sStart = s;
    this.sEnd = s + (tree.strLen[h] | 0);
  }

  // The bytes that the string `h` is a range of (the range is `strStart[h]`, `strLen[h]`).
  bufOf(h: number): Uint8Array {
    return (this.tree.strOwned[h] | 0) !== 0 ? this.tree.strings.data : this.text;
  }

  // A text doc of the string `h`.
  strDoc(h: number): number {
    this.strOf(h);
    return docText(this.sBuf, this.sStart, this.sEnd);
  }

  // A text doc of the source of `node` (original[start, end)).
  sourceDoc(node: number): number {
    const tree = this.tree;
    const s = tree.start[node] | 0;
    const e = tree.end[node] | 0;
    if (s > e || e > this.original.length) return DOC_EMPTY;
    return docText(this.original, s, e);
  }

  kind(id: number): number {
    return id >= 0 && id < this.tree.n ? this.tree.kind[id] | 0 : -1;
  }

  startLine(node: number): number {
    return this.tree.line(this.tree.start[node] | 0);
  }

  endLine(node: number): number {
    return this.tree.line(this.tree.end[node] | 0);
  }

  column(offset: number): number {
    return offset - this.tree.lineStart(offset);
  }

  hasAncestorKind(id: number, k: number): boolean {
    const tree = this.tree;
    let a = tree.parent[id] | 0;
    while (a >= 0) {
      if ((tree.kind[a] | 0) === k) return true;
      a = tree.parent[a] | 0;
    }
    return false;
  }

  findAncestorKind(id: number, k1: number, k2: number): number {
    const tree = this.tree;
    let a = tree.parent[id] | 0;
    while (a >= 0) {
      const k = tree.kind[a] | 0;
      if (k === k1 || k === k2) return a;
      a = tree.parent[a] | 0;
    }
    return NONE;
  }

  // `lines(text, is_literal)`: the lines of `text`, with `hardline` between them, or with `markAsRoot(literalline)`.
  //
  // Where lines are not indented and nothing is to be taken away at their ends, the text is written as it is. `blank`: whether a
  // space or a tab is right before a line break in the text, if that is known (0 or 1; -1 if not).
  lines(buf: Uint8Array, s: number, e: number, isLiteral: boolean, blank: number = -1): number {
    let isAsItIs = this.indentation === 0 && !this.isInTemplate && !this.options.isInMarkdown;
    if (isAsItIs && !isLiteral) {
      isAsItIs = blank < 0 ? !hasBlankBeforeNewline(buf, s, e) : blank === 0;
    }
    if (isAsItIs) return docText(buf, s, e);
    return this.replaceEndOfLine(buf, s, e, isLiteral ? this.markRootLiteralline : DOC_HARDLINE);
  }

  // Prettier's `replaceEndOfLine(text, separator)`
  replaceEndOfLine(buf: Uint8Array, s: number, e: number, separator: number): number {
    if (!containsByte(buf, s, e, 10)) return docText(buf, s, e);
    const m = docBegin();
    let from = s;
    let first = true;
    while (true) {
      let at = from;
      while (at < e && (buf[at] | 0) !== 10) at = at + 1;
      if (!first) docAdd(separator);
      first = false;
      docAdd(docText(buf, from, at));
      if (at >= e) break;
      from = at + 1;
    }
    return docArray(m);
  }

  // Code that has been formatted, line by line. A line break in a text, which is marked by a `\r`, is a literal line: see
  // `FormatOptions::is_in_markdown`.
  linesOf(buf: Uint8Array, s: number, e: number): number {
    const m = docBegin();
    let isAfterLiteralLineBreak = false;
    let from = s;
    let first = true;
    while (true) {
      let at = from;
      while (at < e && (buf[at] | 0) !== 10) at = at + 1;
      if (!first) docAdd(isAfterLiteralLineBreak ? this.literallineDoc : DOC_HARDLINE);
      first = false;
      let le = at;
      isAfterLiteralLineBreak = le > from && (buf[le - 1] | 0) === 13;
      if (isAfterLiteralLineBreak) le = le - 1;
      docAdd(docText(buf, from, le));
      if (at >= e) break;
      from = at + 1;
    }
    return docArray(m);
  }

  // ---------------------------------------------------------------------------------------------- what is asked of nodes

  isSetextHeading(node: number): boolean {
    return this.startLine(node) !== this.endLine(node);
  }

  // Prettier's `isPrettierIgnore`
  prettierIgnore(id: number): number {
    const tree = this.tree;
    if (id < 0 || id >= tree.n) return IGNORE_NONE;
    const k = tree.kind[id] | 0;
    let buf: Uint8Array;
    let s: number;
    let e: number;
    if (k === K_HTML) {
      this.strOf(tree.value[id] | 0);
      buf = this.sBuf;
      s = this.sStart;
      e = this.sEnd;
      if (!startsWithStr(buf, s, e, "<!--")) return IGNORE_NONE;
      s = s + 4;
      if (!endsWithStr(buf, s, e, "-->")) return IGNORE_NONE;
      e = e - 3;
      s = trimJsWhitespaceStart(buf, s, e);
      e = trimJsWhitespaceEnd(buf, s, e);
    } else if (k === K_ES_COMMENT) {
      this.strOf(tree.value[id] | 0);
      buf = this.sBuf;
      s = this.sStart;
      e = this.sEnd;
    } else if (k === K_PARAGRAPH && this.isMdx && (tree.firstChild[id] | 0) === (tree.lastChild[id] | 0)) {
      const c = tree.firstChild[id] | 0;
      if (c < 0 || (tree.kind[c] | 0) !== K_ES_COMMENT) return IGNORE_NONE;
      this.strOf(tree.value[c] | 0);
      buf = this.sBuf;
      s = this.sStart;
      e = this.sEnd;
    } else return IGNORE_NONE;
    // `-start`, `-end` or nothing behind `prettier-ignore` (or `oxfmt-ignore`)
    if (this.isIgnoreText(buf, s, e)) return IGNORE_NEXT;
    if (endsWithStr(buf, s, e, "-start") && this.isIgnoreText(buf, s, e - 6)) return IGNORE_START;
    if (endsWithStr(buf, s, e, "-end") && this.isIgnoreText(buf, s, e - 4)) return IGNORE_END;
    return IGNORE_NONE;
  }

  isIgnoreText(buf: Uint8Array, s: number, e: number): boolean {
    const n = e - s;
    if (n === 15) return startsWithStr(buf, s, e, "prettier-ignore");
    if (n === 12) return this.isOxfmt && startsWithStr(buf, s, e, "oxfmt-ignore");
    return false;
  }

  // Prettier's `isAutolink`
  isAutolink(id: number): boolean {
    const tree = this.tree;
    if (this.kind(id) !== K_LINK) return false;
    const f = tree.firstChild[id] | 0;
    if (f !== (tree.lastChild[id] | 0) || f < 0) return false;
    return (tree.start[f] | 0) === (tree.start[id] | 0) && (tree.end[f] | 0) === (tree.end[id] | 0);
  }

  // Prettier's `getNthListSiblingIndex`: how many lists of the same kind are right before `list`.
  nthListSiblingIndex(list: number): number {
    return this.tree.firstAlign[list] | 0;
  }

  // The first of the lists of its kind that `list` follows, or itself.
  firstListOfRun(list: number): number {
    const tree = this.tree;
    if (this.firstOfRun.length === 0) {
      this.firstOfRun = new Int32Array(tree.n);
      this.firstOfRun.fill(NONE);
    }
    let at = list;
    let first: number;
    while (true) {
      const known = this.firstOfRun[at] | 0;
      if (known !== NONE) {
        first = known;
        break;
      }
      if ((tree.firstAlign[at] | 0) > 0) at = tree.previous[at] | 0;
      else {
        first = at;
        break;
      }
    }
    this.firstOfRun[list] = first;
    return first;
  }

  // Whether `list` has `*` or `)`: lists of the same kind that follow each other take turns.
  usesAlternateMarker(list: number): boolean {
    const index = this.nthListSiblingIndex(list);
    let isFirstAlternate = false;
    // oxfmt: a list that is left as it is written has the marker that it has.
    if (this.isOxfmt && index > 0) {
      const first = this.firstListOfRun(list);
      if (this.prettierIgnore(this.tree.previous[first] | 0) === IGNORE_NEXT) {
        const tree = this.tree;
        const s = tree.start[first] | 0;
        const e = tree.end[first] | 0;
        let digits = 0;
        while (s + digits < e && isAsciiDigit(this.original[s + digits] | 0)) digits = digits + 1;
        const m = s + digits < e ? this.original[s + digits] | 0 : -1;
        isFirstAlternate = m === 42 || m === 41;
      }
    }
    return isFirstAlternate !== (index % 2 !== 0);
  }

  // Whether a hard line break is in `id`.
  hasHardBreak(id: number): boolean {
    const tree = this.tree;
    let next = tree.firstChild[id] | 0;
    while (next >= 0) {
      const node = next;
      if ((tree.kind[node] | 0) === K_BREAK) return true;
      next = tree.firstChild[node] | 0;
      let at = node;
      while (next === NONE && (tree.parent[at] | 0) !== NONE) {
        next = tree.next[at] | 0;
        if ((tree.parent[at] | 0) === id && next === NONE) return false;
        at = tree.parent[at] | 0;
      }
    }
    return false;
  }

  // Prettier's `isLooseListItem`
  isLooseListItem(id: number): boolean {
    const tree = this.tree;
    if (this.kind(id) !== K_LIST_ITEM) return false;
    if (this.isMdx) return this.isLooseListItemLegacy(id);
    if (((tree.flags[id] | 0) & F_SPREAD) !== 0) return true;
    if (this.kind(tree.parent[id] | 0) !== K_LIST) return false;
    const next = tree.next[id] | 0;
    return next >= 0 && (tree.kind[next] | 0) === K_LIST_ITEM && this.endLine(id) + 1 < this.startLine(next);
  }

  // Prettier's `isLooseListItemLegacy`, with what remark-parse 8 says about an item: it is spread out if there is an empty line in
  // it that something follows, and it ends behind the empty lines before the next item.
  isLooseListItemLegacy(item: number): boolean {
    const tree = this.tree;
    const buf = this.original;
    const s = tree.start[item] | 0;
    const e0 = tree.end[item] | 0;
    const e = trimJsWhitespaceEnd(buf, s, e0);
    // The indentation of the item is taken away from its lines first, also from one with nothing else on it.
    const first = tree.firstChild[item] | 0;
    const indent = first >= 0 ? this.column(tree.start[first] | 0) : 0;
    let from = s;
    while (true) {
      let at = from;
      while (at < e && (buf[at] | 0) !== 10) at = at + 1;
      if (at >= e) break;
      from = at + 1;
      let blanks = 0;
      while (from + blanks < e && isBlank(buf[from + blanks] | 0)) blanks = blanks + 1;
      if (blanks <= indent && from + blanks < e && (buf[from + blanks] | 0) === 10) return true;
    }
    const next = tree.next[item] | 0;
    return next >= 0 && this.endLine(item) + 1 < this.startLine(next);
  }

  shouldPrePrintHardline(node: number): boolean {
    const tree = this.tree;
    const k = tree.kind[node] | 0;
    const isInWrapper = isInlineWrapper(this.kind(tree.parent[node] | 0));
    const isInlineNode = isInline(k) && !(k === K_LIQUID_NODE && !isInWrapper);
    const isInlineHtml = k === K_HTML && isInWrapper;
    // Prettier takes text that it has not split into words for a block.
    const isText = k === K_TEXT && this.isOxfmt;
    return !isInlineNode && !isInlineHtml && !isText;
  }

  shouldPrePrintDoubleHardline(node: number): boolean {
    const tree = this.tree;
    const previous = tree.previous[node] | 0;
    const parent = tree.parent[node] | 0;
    if (previous < 0 || parent < 0) return false;
    const k = tree.kind[node] | 0;
    const pk = tree.kind[previous] | 0;
    const parentKind = tree.kind[parent] | 0;
    if (!this.isMdx && this.isSetextHeading(node) && this.startLine(node) < this.endLine(previous)) return false;
    const followsDirectly = this.endLine(previous) + 1 === this.startLine(node);
    if (
      this.isLooseListItem(previous) ||
      (k === K_LIST &&
        parentKind === K_LIST_ITEM &&
        (pk === K_CODE || pk === K_PARAGRAPH || (pk === K_HTML && (tree.number[previous] | 0) === 0 && this.isOxfmt)) &&
        this.endLine(previous) + 1 < this.startLine(node))
    ) {
      return true;
    }
    const isSiblingNode = pk === k && (k === K_LIST_ITEM || k === K_DEFINITION);
    const isInTightListItem = parentKind === K_LIST_ITEM && (k === K_LIST || !this.isLooseListItem(parent));
    const isPreviousIgnore = this.prettierIgnore(previous) === IGNORE_NEXT;
    let isHtmlAfterHtmlOrParagraph = false;
    if (k === K_HTML && followsDirectly) {
      if (pk === K_HTML) isHtmlAfterHtmlOrParagraph = true;
      else if (pk === K_PARAGRAPH) isHtmlAfterHtmlOrParagraph = (!this.isMdx || parentKind === K_LIST_ITEM) && !this.isLazyHtml(node);
    }
    const isLiquidWithoutBlankLine = (k === K_LIQUID_NODE || pk === K_LIQUID_NODE) && followsDirectly;
    return !(isSiblingNode || isInTightListItem || isPreviousIgnore || isHtmlAfterHtmlOrParagraph || isLiquidWithoutBlankLine);
  }

  // oxfmt's `front_matter_risk`: the first paragraph of the document starts with `---` or `+++`, and what follows would end front matter
  // when it is read again.
  wouldBeFrontMatter(paragraph: number): boolean {
    if (!this.isOxfmt) return false;
    const tree = this.tree;
    const prev = tree.previous[paragraph] | 0;
    if (prev >= 0 && (tree.kind[prev] | 0) !== K_FRONT_MATTER) return false;
    if (this.kind(tree.parent[paragraph] | 0) !== K_ROOT) return false;
    const headStart = tree.start[paragraph] | 0;
    const orig = this.original;
    const dashes = startsWithStr(orig, headStart, orig.length, "---");
    if (!dashes && !startsWithStr(orig, headStart, orig.length, "+++")) return false;
    if (parseFrontMatter(orig.subarray(headStart)) !== null) return true;
    let sibling = tree.next[paragraph] | 0;
    while (sibling >= 0) {
      if ((tree.kind[sibling] | 0) === K_THEMATIC_BREAK && dashes) return true;
      sibling = tree.next[sibling] | 0;
    }
    return false;
  }

  // oxfmt: HTML right behind a paragraph of a list item, on a line that is not indented as the item is, is in the item only as long as
  // that line is not.
  isLazyHtmlInTightItem(node: number): boolean {
    if (!this.isOxfmt) return false;
    const parent = this.tree.parent[node] | 0;
    return this.isLazyHtml(node) && this.kind(parent) === K_LIST_ITEM && !this.isLooseListItem(parent);
  }

  // oxfmt: HTML right behind a paragraph of a container, on a line without what the lines of the container start with.
  isLazyHtml(node: number): boolean {
    if (!this.isOxfmt) return false;
    const tree = this.tree;
    if ((tree.kind[node] | 0) !== K_HTML) return false;
    const previous = tree.previous[node] | 0;
    const parent = tree.parent[node] | 0;
    if (previous < 0 || parent < 0) return false;
    if ((tree.kind[previous] | 0) !== K_PARAGRAPH || this.endLine(previous) + 1 !== this.startLine(node)) return false;
    const pk = tree.kind[parent] | 0;
    if (pk === K_LIST_ITEM) {
      const first = tree.firstChild[parent] | 0;
      return first >= 0 && this.column(tree.start[node] | 0) < this.column(tree.start[first] | 0);
    }
    if (pk === K_BLOCKQUOTE) return this.column(tree.start[node] | 0) <= this.column(tree.start[parent] | 0);
    return false;
  }

  // ---------------------------------------------------------------------------------------------- children

  // The separators that Prettier's `printChildren` puts before `child` (there is a part before it).
  addSeparators(child: number): void {
    if (this.isLazyHtmlInTightItem(child)) {
      docAdd(docPool.dedent(DOC_HARDLINE));
    } else if (this.shouldPrePrintHardline(child)) {
      docAdd(DOC_HARD_LINE);
      docAdd(DOC_BREAK_PARENT_DOC);
      if (this.shouldPrePrintDoubleHardline(child)) {
        docAdd(DOC_HARD_LINE);
        docAdd(DOC_BREAK_PARENT_DOC);
      }
    }
  }

  // Prettier's `printChildren`
  printChildren(parent: number): number {
    const tree = this.tree;
    const m = docBegin();
    let any = false;
    let child = tree.firstChild[parent] | 0;
    while (child >= 0) {
      const result = this.print(child);
      if (any) this.addSeparators(child);
      docAdd(result);
      any = true;
      child = tree.next[child] | 0;
    }
    return docArray(m);
  }

  // A node: as it is in the text if it is ignored, or as the language in it, or as Markdown.
  print(id: number): number {
    if (!this.stack.enter()) return DOC_EMPTY;
    const doc = this.printNode(id);
    this.stack.leave();
    return doc;
  }

  printNode(id: number): number {
    const tree = this.tree;
    if (id < 0 || id >= tree.n) return DOC_EMPTY;
    const previous = tree.previous[id] | 0;
    if (previous >= 0 && this.prettierIgnore(previous) === IGNORE_NEXT) return this.printIgnored(id);
    const k = tree.kind[id] | 0;
    if (k === K_IMPORT || k === K_EXPORT || k === K_JSX || (k === K_CODE && (tree.second[id] | 0) !== STR_NO)) {
      const embedded = this.printEmbedded(id);
      if (embedded >= 0) return embedded;
    }
    return this.printMdast(id);
  }

  // Prettier's `printPrettierIgnored`
  printIgnored(id: number): number {
    const tree = this.tree;
    const s = tree.start[id] | 0;
    let e = tree.end[id] | 0;
    if (s > e || e > this.original.length) return DOC_EMPTY;
    if (
      (tree.kind[id] | 0) === K_LIST &&
      !this.isMdx &&
      (this.proseWrap !== PROSE_WRAP_ALWAYS || this.isOxfmt) &&
      this.hasAncestorKind(id, K_BLOCKQUOTE)
    ) {
      // `/\n>\s*$/`
      const t = trimJsWhitespaceEnd(this.original, s, e);
      if (t - s >= 2 && (this.original[t - 1] | 0) === 62 && (this.original[t - 2] | 0) === 10) e = t - 2;
    }
    return docText(this.original, s, e);
  }

  // ---------------------------------------------------------------------------------------------- text

  // Whether white space in `id` cannot be a line break: it is in something that is on one line.
  isOnSingleLine(id: number): boolean {
    const tree = this.tree;
    let a = tree.parent[id] | 0;
    while (a >= 0) {
      const k = tree.kind[a] | 0;
      if (k === K_TABLE_CELL || k === K_LINK || k === K_WIKI_LINK) return true;
      if (k === K_HEADING && (this.isMdx || !this.isSetextHeading(a))) return true;
      a = tree.parent[a] | 0;
    }
    return false;
  }

  // Prettier's `isInSentenceWithCJSpaces`; the tokens are `first .. first + count`.
  usesCjSpaces(first: number, count: number): boolean {
    const kinds = this.tree.tkKind;
    let withSpace = 0;
    let without = 0;
    for (let index = 1; index < count; index++) {
      if (index + 1 >= count) break;
      const k = kinds[first + index] | 0;
      const before = kinds[first + index - 1] | 0;
      const after = kinds[first + index + 1] | 0;
      const isBetween = (before === TK_CJ_LETTER && after === TK_NON_CJK) || (before === TK_NON_CJK && after === TK_CJ_LETTER);
      if (isBetween) {
        if (k === TK_SPACE) withSpace = withSpace + 1;
        else if (k === TK_NO_SPACE) without = without + 1;
      }
    }
    return withSpace > without;
  }

  // The first byte of the token `ti`'s text, or -1.
  tokFirstByte(ti: number): number {
    const tree = this.tree;
    if ((tree.tkLen[ti] | 0) === 0) return -1;
    const buf = (tree.tkFlags[ti] & TF_OWNED) !== 0 ? tree.strings.data : this.text;
    return buf[tree.tkStart[ti] | 0] | 0;
  }

  tokLastByte(ti: number): number {
    const tree = this.tree;
    const len = tree.tkLen[ti] | 0;
    if (len === 0) return -1;
    const buf = (tree.tkFlags[ti] & TF_OWNED) !== 0 ? tree.strings.data : this.text;
    return buf[(tree.tkStart[ti] | 0) + len - 1] | 0;
  }

  // Prettier's `lineBreakCanBeConvertedToSpace`
  lineBreakCanBeSpace(first: number, count: number, index: number): boolean {
    if (index < 1 || index + 1 >= count) return true;
    const kinds = this.tree.tkKind;
    const pk = kinds[first + index - 1] | 0;
    const nk = kinds[first + index + 1] | 0;
    const isNonCjkOrKorean = (k: number): boolean => k === TK_NON_CJK || k === TK_K_LETTER;
    if (isNonCjkOrKorean(pk) && isNonCjkOrKorean(nk)) return true;
    if ((pk === TK_K_LETTER && nk === TK_CJ_LETTER) || (pk === TK_CJ_LETTER && nk === TK_K_LETTER)) return true;
    if (pk === TK_CJK_PUNCTUATION || nk === TK_CJK_PUNCTUATION || (pk === TK_CJ_LETTER && nk === TK_CJ_LETTER)) return false;
    // Between Chinese or Japanese and something else.
    const nb = this.tokFirstByte(first + index + 1);
    const pb = this.tokLastByte(first + index - 1);
    if ((nb >= 0 && isAsciiPunct(nb)) || (pb >= 0 && isAsciiPunct(pb))) return true;
    const flags = this.tree.tkFlags;
    if ((flags[first + index - 1] & TF_TRAILING_PUNCT) !== 0 || (flags[first + index + 1] & TF_LEADING_PUNCT) !== 0) return false;
    return this.usesCjSpaces(first, count);
  }

  // Prettier's `isBreakable`, but for what does not depend on the white space.
  isBreakable(first: number, count: number, index: number): boolean {
    if (index < 1 || index + 1 >= count) return true;
    const kinds = this.tree.tkKind;
    if ((kinds[first + index] | 0) === TK_NO_SPACE) return false;
    const pk = kinds[first + index - 1] | 0;
    const nk = kinds[first + index + 1] | 0;
    if ((pk === TK_K_LETTER && nk === TK_CJ_LETTER) || (pk === TK_CJ_LETTER && nk === TK_K_LETTER)) return true;
    const pcj = pk === TK_CJ_LETTER || pk === TK_CJK_PUNCTUATION;
    const ncj = nk === TK_CJ_LETTER || nk === TK_CJK_PUNCTUATION;
    return !pcj && !ncj;
  }

  // Prettier's `printWhitespace`. `canBreak`: lines are wrapped, and this is not on a single line.
  printWhitespace(first: number, count: number, index: number, proseWrap: number, isLink: boolean, canBreak: boolean): number {
    const kind = this.tree.tkKind[first + index] | 0;
    if (proseWrap === PROSE_WRAP_PRESERVE && kind === TK_NEWLINE) return W_HARDLINE;
    const canBeSpace = kind === TK_SPACE || (kind === TK_NEWLINE && (isLink || this.lineBreakCanBeSpace(first, count, index)));
    const isBreakable = proseWrap === PROSE_WRAP_ALWAYS && canBreak && (isLink ? kind !== TK_NO_SPACE : this.isBreakable(first, count, index));
    if (isBreakable) return canBeSpace ? W_LINE : W_SOFTLINE;
    return canBeSpace ? W_SPACE : W_EMPTY;
  }

  // Whether a line that starts with `word` could be taken for something else: a quote, a list, a heading.
  static mayStartBlock(buf: Uint8Array, s: number, e: number): boolean {
    const n = e - s;
    if (n === 0) return false;
    const first = buf[s] | 0;
    if (first === 62) return true;
    if (n === 1 && (first === 42 || first === 43 || first === 45)) return true;
    if (first === 35) {
      if (n > 6) return false;
      for (let i = s; i < e; i++) {
        if ((buf[i] | 0) !== 35) return false;
      }
      return true;
    }
    const last = buf[e - 1] | 0;
    if (n >= 2 && (last === 41 || last === 46)) {
      for (let i = s; i < e - 1; i++) {
        if (!isAsciiDigit(buf[i] | 0)) return false;
      }
      return true;
    }
    return false;
  }

  tokMayStartBlock(ti: number): boolean {
    const tree = this.tree;
    const buf = (tree.tkFlags[ti] & TF_OWNED) !== 0 ? tree.strings.data : this.text;
    const s = tree.tkStart[ti] | 0;
    return Printer.mayStartBlock(buf, s, s + (tree.tkLen[ti] | 0));
  }

  addWhitespace(parts: FillParts, w: number): void {
    switch (w) {
      case W_SPACE:
        parts.content(docAscii(" "));
        break;
      case W_EMPTY:
        parts.content(DOC_EMPTY);
        break;
      case W_LINE:
        parts.separator(DOC_LINE_DOC);
        break;
      case W_SOFTLINE:
        parts.separator(DOC_SOFTLINE);
        break;
      default:
        parts.hardline();
        break;
    }
  }

  // The same for a sentence that has not been split into words: it is ASCII, and lines are not wrapped. What is written as it is in
  // the text is one text here.
  printPlainSentence(node: number): number {
    const tree = this.tree;
    const h = tree.value[node] | 0;
    const buf = this.bufOf(h);
    const ts = tree.strStart[h] | 0;
    const te = ts + (tree.strLen[h] | 0);
    const isPreserved = this.proseWrap === PROSE_WRAP_PRESERVE;
    // The common text has no white space but single spaces: it is one text.
    const white = WHITE3;
    let i = ts;
    while (i < te) {
      const b = buf[i] | 0;
      if ((white[b] | 0) === 0) {
        i = ((i | 0) + 1) | 0;
        continue;
      }
      if (b === 32 && !((white[i + 1 < te ? buf[i + 1] | 0 : 0] | 0) !== 0)) {
        i = ((i | 0) + 1) | 0;
        continue;
      }
      break;
    }
    if (i >= te) return docText(buf, ts, te);
    const parts = new FillParts(false);
    // Where what has not been written yet starts.
    let start = ts;
    // The white space that is not a single space: runs of white space of two or more, and a tab or a line break alone.
    while (i < te) {
      const b = buf[i] | 0;
      if ((white[b] | 0) === 0) {
        i = ((i | 0) + 1) | 0;
        continue;
      }
      let j = i + 1;
      let hasNewline = b === 10;
      while (j < te && (white[buf[j] | 0] | 0) !== 0) {
        if ((buf[j] | 0) === 10) hasNewline = true;
        j = ((j | 0) + 1) | 0;
      }
      const whiteStart = i;
      const whiteEnd = j;
      i = j;
      if (whiteEnd - whiteStart === 1 && b === 32) continue;
      if (start < whiteStart) parts.content(docText(buf, start, whiteStart));
      start = whiteEnd;
      if (!hasNewline || !isPreserved) {
        parts.content(docAscii(" "));
        continue;
      }
      // The word at the start of the next line, and whether it is all of that line.
      let wordLen = 0;
      while (whiteEnd + wordLen < te && (white[buf[whiteEnd + wordLen] | 0] | 0) === 0) wordLen = wordLen + 1;
      let afterLen = 0;
      while (whiteEnd + wordLen + afterLen < te && (white[buf[whiteEnd + wordLen + afterLen] | 0] | 0) !== 0) afterLen = afterLen + 1;
      const isWholeLine = whiteEnd + wordLen === te || containsByte(buf, whiteEnd + wordLen, whiteEnd + wordLen + afterLen, 10);
      const wordIsDash = wordLen === 1 && (buf[whiteEnd] | 0) === 45;
      if (Printer.mayStartBlock(buf, whiteEnd, whiteEnd + wordLen) && !(wordIsDash && isWholeLine)) {
        parts.content(docAscii(" "));
        continue;
      }
      parts.hardline();
      // What looks like the line under a heading is escaped.
      let allEq = true;
      let allDash = true;
      for (let k = whiteEnd; k < whiteEnd + wordLen; k++) {
        const c = buf[k] | 0;
        if (c !== 61) allEq = false;
        if (c !== 45) allDash = false;
      }
      const isFakeSetextLine =
        wordLen > 0 && isWholeLine && (allEq || allDash) && ((tree.flags[node] | 0) & F_ALIGNED) === 0 && !this.isMdx;
      if (isFakeSetextLine) parts.content(docAscii("\\"));
    }
    if (start < te) parts.content(docText(buf, start, te));
    return parts.finish();
  }

  // Prettier's `printSentence`
  printSentence(id: number): number {
    const tree = this.tree;
    if ((tree.number[id] | 0) === PLAIN) return this.printPlainSentence(id);
    const first = tree.firstAlign[id] | 0;
    const count = tree.number[id] | 0;
    const isAlways = this.proseWrap === PROSE_WRAP_ALWAYS;
    const canBreak = isAlways && !this.isOnSingleLine(id);
    const emphasis = this.findAncestorKind(id, K_EMPHASIS, K_STRONG);
    const parts = new FillParts(isAlways);
    const kinds = tree.tkKind;
    for (let index = 0; index < count; index++) {
      const k = kinds[first + index] | 0;
      if (k !== TK_NO_SPACE && k !== TK_SPACE && k !== TK_NEWLINE) {
        parts.content(this.printWord(id, first, count, index, emphasis));
        continue;
      }
      const hasNext = index + 1 < count;
      const hasAfterNext = index + 2 < count;
      let isNextFakeSetextLine = false;
      if (k === TK_NEWLINE && hasNext) {
        const ni = first + index + 1;
        const isDash = (tree.tkLen[ni] | 0) === 1 && this.tokFirstByte(ni) === FOLLOW_DASH;
        isNextFakeSetextLine = isDash && (!hasAfterNext || (kinds[first + index + 2] | 0) === TK_NEWLINE);
      }
      const joins =
        hasNext &&
        this.tokMayStartBlock(first + index + 1) &&
        !(hasAfterNext && (kinds[first + index + 2] | 0) === TK_NO_SPACE) &&
        !(this.proseWrap === PROSE_WRAP_PRESERVE && isNextFakeSetextLine);
      const proseWrap = joins ? PROSE_WRAP_NEVER : this.proseWrap;
      this.addWhitespace(parts, this.printWhitespace(first, count, index, proseWrap, false, canBreak));
    }
    return parts.finish();
  }

  // Prettier's `printWord`. `emphasis`: the emphasis or strong emphasis that it is in.
  printWord(sentence: number, first: number, count: number, index: number, emphasis: number): number {
    const tree = this.tree;
    const ti = first + index;
    const ts = tree.tkStart[ti] | 0;
    const te = ts + (tree.tkLen[ti] | 0);
    const buf = (tree.tkFlags[ti] & TF_OWNED) !== 0 ? tree.strings.data : this.text;
    if (this.isMdx) return this.printWordLegacy(sentence, buf, ts, te, index === 0);
    const kinds = tree.tkKind;
    const prevIsNewline = index > 0 && (kinds[ti - 1] | 0) === TK_NEWLINE;
    const hasNext = index + 1 < count;
    const nextIsNewline = hasNext && (kinds[ti + 1] | 0) === TK_NEWLINE;
    if (emphasis < 0) {
      // What looks like the line under a heading is escaped: `Previous line↵␣␣␣␣===`.
      if (this.proseWrap === PROSE_WRAP_PRESERVE && prevIsNewline && (!hasNext || nextIsNewline)) {
        let allEq = true;
        let allDash = true;
        for (let i = ts; i < te; i++) {
          const b = buf[i] | 0;
          if (b !== 61) allEq = false;
          if (b !== 45) allDash = false;
        }
        if (allEq || allDash) {
          scratch.reset();
          scratch.push(92);
          scratch.append(buf, ts, te);
          return docText(scratch.data, 0, scratch.len);
        }
      }
      return docText(buf, ts, te);
    }
    let hasMarker = false;
    for (let i = ts; i < te; i++) {
      const b = buf[i] | 0;
      if (b === 42 || b === 95) {
        hasMarker = true;
        break;
      }
    }
    if (!hasMarker) return docText(buf, ts, te);

    // UTF-16 units of the word
    let units = this.units;
    if (units.length < (te - ts) + 2) units = this.units = new Uint16Array((te - ts) * 2 + 4);
    let n = 0;
    // At the very start of the emphasis.
    const firstByte = buf[ts] | 0;
    if (index === 0 && (firstByte === 42 || firstByte === 95) && (tree.previous[sentence] | 0) === NONE && (tree.parent[sentence] | 0) === emphasis) {
      units[n] = 92;
      n = n + 1;
    }
    let i = ts;
    while (i < te) {
      const b = buf[i] | 0;
      if (b < 0x80) {
        units[n] = b;
        n = n + 1;
        i = i + 1;
        continue;
      }
      const cp = decodeUtf8(buf, i, te);
      i = i + utf8Len();
      if (cp >= 0x10000) {
        const c = cp - 0x10000;
        units[n] = 0xd800 + (c >> 10);
        units[n + 1] = 0xdc00 + (c & 0x3ff);
        n = n + 2;
      } else {
        units[n] = cp;
        n = n + 1;
      }
    }
    const before = index > 0 ? this.unitOfToken(ti - 1, true) : -1;
    const after = hasNext ? this.unitOfToken(ti + 1, false) : -1;
    const outLen = this.escapeDelimiterRuns(units, n, before, after);
    scratch.reset();
    this.encodeUnits(this.escOut, outLen, scratch);
    return docText(scratch.data, 0, scratch.len);
  }

  units: Uint16Array = new Uint16Array(64);
  escOut: Uint16Array = new Uint16Array(64);

  // The first or last UTF-16 unit of the token `ti` (as `printWord` sees its neighbours); -1: none.
  unitOfToken(ti: number, isLast: boolean): number {
    const tree = this.tree;
    const k = tree.tkKind[ti] | 0;
    if (k === TK_NO_SPACE) return -1;
    if (k === TK_SPACE) return 32;
    if (k === TK_NEWLINE) return 10;
    const len = tree.tkLen[ti] | 0;
    if (len === 0) return -1;
    const buf = (tree.tkFlags[ti] & TF_OWNED) !== 0 ? tree.strings.data : this.text;
    const s = tree.tkStart[ti] | 0;
    const e = s + len;
    if (isLast) {
      const b = buf[e - 1] | 0;
      if (b < 0x80) return b;
      const cp = decodeUtf8Back(buf, s, e);
      if (cp >= 0x10000) return 0xdc00 + ((cp - 0x10000) & 0x3ff);
      return cp;
    }
    const b = buf[s] | 0;
    if (b < 0x80) return b;
    const cp = decodeUtf8(buf, s, e);
    if (cp >= 0x10000) return 0xd800 + ((cp - 0x10000) >> 10);
    return cp;
  }

  // `String::from_utf16_lossy`, as UTF-8.
  encodeUnits(units: Uint16Array, n: number, out: ByteBuf): void {
    for (let i = 0; i < n; i++) {
      const u = units[i] | 0;
      if (u < 0x80) out.push(u);
      else if (u < 0x800) {
        out.push(0xc0 | (u >> 6));
        out.push(0x80 | (u & 0x3f));
      } else if (u >= 0xd800 && u <= 0xdbff && i + 1 < n && (units[i + 1] | 0) >= 0xdc00 && (units[i + 1] | 0) <= 0xdfff) {
        const cp = 0x10000 + ((u - 0xd800) << 10) + ((units[i + 1] | 0) - 0xdc00);
        out.push(0xf0 | (cp >> 18));
        out.push(0x80 | ((cp >> 12) & 0x3f));
        out.push(0x80 | ((cp >> 6) & 0x3f));
        out.push(0x80 | (cp & 0x3f));
        i = i + 1;
      } else if (u >= 0xd800 && u <= 0xdfff) {
        out.push(0xef);
        out.push(0xbf);
        out.push(0xbd);
      } else {
        out.push(0xe0 | (u >> 12));
        out.push(0x80 | ((u >> 6) & 0x3f));
        out.push(0x80 | (u & 0x3f));
      }
    }
  }

  // What `printWord` does with `/(\\+|^|.)(\*+|_+)($|.)/g`: a run of `*` or `_` in a word in emphasis that could open or close
  // emphasis is escaped. `before` and `after`: what is next to the word (-1: nothing). The result is `escOut[0, n)`.
  escapeDelimiterRuns(units: Uint16Array, len: number, before: number, after: number): number {
    if (this.escOut.length < len * 2 + 4) this.escOut = new Uint16Array(len * 2 + 8);
    const out = this.escOut;
    let o = 0;
    let index = 0;
    search: while (index <= len) {
      const from = index;
      for (let start = from; start <= len; start++) {
        // `\\+`, `^` or `.`
        let backslashes = 0;
        while (start + backslashes < len && (units[start + backslashes] | 0) === 92) backslashes = backslashes + 1;
        for (let cand = 0; cand < 3; cand++) {
          let precedingLen: number;
          if (cand === 0) {
            if (backslashes === 0) continue;
            precedingLen = backslashes;
          } else if (cand === 1) {
            if (start !== 0) continue;
            precedingLen = 0;
          } else {
            if (start >= len) continue;
            precedingLen = 1;
          }
          const runStart = start + precedingLen;
          if (runStart >= len) continue;
          const marker = units[runStart] | 0;
          if (marker !== 42 && marker !== 95) continue;
          let runLen = 0;
          while (runStart + runLen < len && (units[runStart + runLen] | 0) === marker) runLen = runLen + 1;
          const runEnd = runStart + runLen;
          const followingLen = runEnd < len ? 1 : 0;
          if (out.length < o + (runEnd + followingLen - from) + 4) {
            const g = new Uint16Array((o + (runEnd + followingLen - from) + 4) * 2);
            g.set(out.subarray(0, o));
            this.escOut = g;
            return this.escapeDelimiterRunsAgain(units, len, before, after);
          }
          for (let k = from; k < start; k++) {
            out[o] = units[k] | 0;
            o = o + 1;
          }
          let allBackslash = true;
          for (let k = start; k < runStart; k++) {
            if ((units[k] | 0) !== 92) allBackslash = false;
          }
          const isEscaped = allBackslash && (runStart - start) % 2 === 1 && runStart > start;
          let canOpenOrClose = false;
          if (!isEscaped) {
            const precedingUnit = runStart > start ? units[runStart - 1] | 0 : before;
            const followingUnit = runEnd < len ? units[runEnd] | 0 : after;
            canOpenOrClose = this.canOpenOrCloseEmphasis(precedingUnit, marker, followingUnit);
          }
          for (let k = start; k < runStart; k++) {
            out[o] = units[k] | 0;
            o = o + 1;
          }
          if (canOpenOrClose) {
            out[o] = 92;
            o = o + 1;
          }
          for (let k = runStart; k < runEnd + followingLen; k++) {
            out[o] = units[k] | 0;
            o = o + 1;
          }
          index = runEnd + followingLen;
          continue search;
        }
      }
      break;
    }
    const rest = index < len ? index : len;
    if (out.length < o + (len - rest) + 2) {
      const g = new Uint16Array((o + (len - rest) + 2) * 2);
      g.set(out.subarray(0, o));
      this.escOut = g;
    }
    const out2 = this.escOut;
    for (let k = rest; k < len; k++) {
      out2[o] = units[k] | 0;
      o = o + 1;
    }
    return o;
  }

  escapeDelimiterRunsAgain(units: Uint16Array, len: number, before: number, after: number): number {
    // The output buffer was too small: it has been replaced by a bigger one; start over.
    return this.escapeDelimiterRuns(units, len, before, after);
  }

  // Prettier's `canOpenOrCloseStrongOrEmphasis`
  canOpenOrCloseEmphasis(preceding: number, marker: number, following: number): boolean {
    if (preceding < 0 || following < 0) return false;
    const isWhitespace = (u: number): boolean => !(u >= 0xd800 && u <= 0xdfff) && isCommonmarkWhitespace(u);
    const isPunct = (u: number): boolean => !(u >= 0xd800 && u <= 0xdfff) && isPunctuationUnit(u);
    const followedByWhitespace = isWhitespace(following);
    const precededByWhitespace = isWhitespace(preceding);
    const followedByPunctuation = isPunct(following);
    const precededByPunctuation = isPunct(preceding);
    const isLeftFlanking = !followedByWhitespace && (!followedByPunctuation || precededByWhitespace || precededByPunctuation);
    const isRightFlanking = !precededByWhitespace && (!precededByPunctuation || followedByWhitespace || followedByPunctuation);
    if (marker === 42) return isLeftFlanking || isRightFlanking;
    if (isLeftFlanking) return !isRightFlanking || precededByPunctuation;
    return isRightFlanking;
  }

  // Prettier's `printWordLegacy`: every `*` is escaped, and `_` at the ends of a word and next to punctuation.
  printWordLegacy(sentence: number, buf: Uint8Array, ts: number, te: number, isFirst: boolean): number {
    let hasMarker = false;
    for (let i = ts; i < te; i++) {
      const b = buf[i] | 0;
      if (b === 42 || b === 95) {
        hasMarker = true;
        break;
      }
    }
    if (!hasMarker) return docText(buf, ts, te);
    const chars: number[] = [];
    let i = ts;
    while (i < te) {
      const cp = (buf[i] | 0) < 0x80 ? buf[i] | 0 : decodeUtf8(buf, i, te);
      i = i + ((buf[i] | 0) < 0x80 ? 1 : utf8Len());
      if (cp === 42) chars.push(92);
      chars.push(cp);
    }
    // `(^|punctuation)(_+)|(_+)(punctuation|$)`
    const escaped: number[] = [];
    const runAt = (from: number): number => {
      let n = 0;
      while (from + n < chars.length && chars[from + n] === 95) n = n + 1;
      return n;
    };
    let index = 0;
    while (index < chars.length) {
      const c = chars[index];
      let len = 0;
      if (index === 0 && c === 95) len = runAt(0);
      else if (isPunctuation(c) && runAt(index + 1) > 0) len = 1 + runAt(index + 1);
      else if (c === 95) {
        const run = runAt(index);
        if (index + run >= chars.length) len = run;
        else if (isPunctuation(chars[index + run])) len = run + 1;
        // The last of them is punctuation itself.
        else if (run > 1) len = run;
        else len = 0;
      }
      if (len === 0) escaped.push(c);
      else {
        for (let k = index; k < index + len; k++) {
          if (chars[k] === 95) escaped.push(92);
          escaped.push(chars[k]);
        }
      }
      index = index + (len > 1 ? len : 1);
    }
    // Behind an autolink, a backslash would become a part of it.
    const tree = this.tree;
    const parent = tree.parent[sentence] | 0;
    if (
      isFirst &&
      (this.isAutolink(tree.previous[sentence] | 0) ||
        (this.kind(parent) === K_EMPHASIS && (tree.previous[sentence] | 0) === NONE && this.isAutolink(tree.previous[parent] | 0)))
    ) {
      let prefix = 0;
      while (true) {
        const marker = prefix + (escaped[prefix] === 92 ? 1 : 0);
        if (!(escaped[marker] === 42 || escaped[marker] === 95)) break;
        prefix = marker + 1;
      }
      const head = escaped.slice(prefix);
      const tail: number[] = [];
      for (let k = 0; k < prefix; k++) {
        if (escaped[k] !== 92) tail.push(escaped[k]);
      }
      // `escaped.split_off(prefix)` keeps the first part; `retain` takes the backslashes out of it; the rest is appended.
      escaped.length = 0;
      for (let k = 0; k < tail.length; k++) escaped.push(tail[k]);
      for (let k = 0; k < head.length; k++) escaped.push(head[k]);
    }
    scratch.reset();
    for (let k = 0; k < escaped.length; k++) pushCodePoint(scratch, escaped[k]);
    return docText(scratch.data, 0, scratch.len);
  }

  // What is in a reference whose label is its text: as it is, but for where its lines break.
  printSameContent(id: number): number {
    const tree = this.tree;
    const s = tree.start[id] | 0;
    const e = tree.end[id] | 0;
    if (s > e || e > this.original.length) return DOC_EMPTY;
    const saveN = tree.nTokens;
    const first = tree.nTokens;
    splitText(tree, this.original, s, e, s, false);
    const count = tree.nTokens - first;
    const isAlways = this.proseWrap === PROSE_WRAP_ALWAYS;
    const canBreak = isAlways && !this.isOnSingleLine(id);
    const parts = new FillParts(isAlways);
    for (let index = 0; index < count; index++) {
      const k = tree.tkKind[first + index] | 0;
      if (k !== TK_NO_SPACE && k !== TK_SPACE && k !== TK_NEWLINE) {
        const ti = first + index;
        parts.content(docText(this.original, tree.tkStart[ti] | 0, (tree.tkStart[ti] | 0) + (tree.tkLen[ti] | 0)));
      } else {
        this.addWhitespace(parts, this.printWhitespace(first, count, index, this.proseWrap, true, canBreak));
      }
    }
    tree.nTokens = saveN;
    return parts.finish();
  }

  // Prettier's `prevOrNextWord`: whether a word is right before or behind `node`.
  hasWordNextTo(node: number): boolean {
    const tree = this.tree;
    return this.siblingIsWord(tree.previous[node] | 0, true) || this.siblingIsWord(tree.next[node] | 0, false);
  }

  // Whether the word at the end (`isLast`) of the sentence `sibling` is a word to micromark (not punctuation or white space).
  siblingIsWord(sibling: number, isLast: boolean): boolean {
    const tree = this.tree;
    if (sibling < 0 || (tree.kind[sibling] | 0) !== K_SENTENCE) return false;
    let hasPunct: boolean;
    let cp: number;
    if ((tree.number[sibling] | 0) === PLAIN) {
      this.strOf(tree.value[sibling] | 0);
      if (this.sEnd === this.sStart) return false;
      const byte = this.sBuf[isLast ? this.sEnd - 1 : this.sStart] | 0;
      if (byte === 9 || byte === 10 || byte === 32) return false;
      hasPunct = isAsciiPunct(byte);
      cp = byte;
    } else {
      const count = tree.number[sibling] | 0;
      if (count === 0) return false;
      const ti = (tree.firstAlign[sibling] | 0) + (isLast ? count - 1 : 0);
      const k = tree.tkKind[ti] | 0;
      if (k === TK_NO_SPACE || k === TK_SPACE || k === TK_NEWLINE) return false;
      const len = tree.tkLen[ti] | 0;
      if (len === 0) return false;
      const buf = (tree.tkFlags[ti] & TF_OWNED) !== 0 ? tree.strings.data : this.text;
      const s = tree.tkStart[ti] | 0;
      if (isLast) {
        hasPunct = ((tree.tkFlags[ti] | 0) & TF_TRAILING_PUNCT) !== 0;
        cp = lastChar(buf, s, s + len);
      } else {
        hasPunct = ((tree.tkFlags[ti] | 0) & TF_LEADING_PUNCT) !== 0;
        cp = firstChar(buf, s, s + len);
      }
      if (cp < 0) return false;
    }
    // oxfmt asks its parser, to which symbols are punctuation.
    const isPunct = this.isOxfmt ? isUnicodePunctuation(cp) : hasPunct;
    return !isPunct && !isCommonmarkWhitespace(cp);
  }

  // ---------------------------------------------------------------------------------------------- strings

  // Prettier's `printUrl`. `isInParentheses`: a `)` cannot be in it as it is.
  printUrl(h: number, isInParentheses: boolean): number {
    this.strOf(h);
    const buf = this.sBuf;
    const s = this.sStart;
    const e = this.sEnd;
    if (s === e && !this.isMdx) return docAscii("<>");
    if (this.isOxfmt) {
      scratch.reset();
      urlOfOxfmt(buf, s, e, isInParentheses, scratch);
      return docText(scratch.data, 0, scratch.len);
    }
    const isDangerous = containsByte(buf, s, e, 32) || (isInParentheses && containsByte(buf, s, e, 41));
    if (!isDangerous) return docText(buf, s, e);
    scratch.reset();
    scratch.push(60);
    for (let i = s; i < e; i++) {
      const b = buf[i] | 0;
      if (b === 60) {
        scratch.push(37);
        scratch.push(51);
        scratch.push(67);
      } else if (b === 62) {
        scratch.push(37);
        scratch.push(51);
        scratch.push(69);
      } else scratch.push(b);
    }
    scratch.push(62);
    return docText(scratch.data, 0, scratch.len);
  }

  // Prettier's `printTitle`
  printTitle(h: number, hasSpace: boolean): number {
    this.strOf(h);
    let buf = this.sBuf;
    let s = this.sStart;
    let e = this.sEnd;
    if (s === e) return DOC_EMPTY;
    // `title.replaceAll(/\\(?=["')])/g, "")`
    if (this.isMdx && containsByte(buf, s, e, 92)) {
      scratch2.reset();
      for (let i = s; i < e; i++) {
        const b = buf[i] | 0;
        if (b === 92 && i + 1 < e) {
          const n = buf[i + 1] | 0;
          if (n === 34 || n === 39 || n === 41) continue;
        }
        scratch2.push(b);
      }
      buf = scratch2.data;
      s = 0;
      e = scratch2.len;
    }
    const has = (byte: number): boolean => containsByte(buf, s, e, byte);
    const out = scratch;
    out.reset();
    if (hasSpace) out.push(32);
    const preferred = this.options.quoteStyle === QUOTE_DOUBLE ? 34 : 39;
    const alternate = this.options.quoteStyle === QUOTE_DOUBLE ? 39 : 34;
    if (this.isOxfmt) {
      const isInParentheses = has(34) && has(39) && !has(40) && !has(41);
      let open: number;
      let close: number;
      if (isInParentheses) {
        open = 40;
        close = 41;
      } else if (countByte(buf, s, e, preferred) > countByte(buf, s, e, alternate)) {
        open = alternate;
        close = alternate;
      } else {
        open = preferred;
        close = preferred;
      }
      out.push(open);
      for (let i = s; i < e; i++) {
        const b = buf[i] | 0;
        let isEscaped = false;
        if (b === 92) isEscaped = true;
        else if (b === 38) isEscaped = characterReference(buf, i, e, null) >= 0;
        else isEscaped = b === open && !isInParentheses;
        if (isEscaped) out.push(92);
        out.push(b);
      }
      out.push(close);
      // In a definition the lines of a title are printed as they are.
      if (!hasSpace || !has(10)) return docText(out.data, 0, out.len);
      const m = docBegin();
      let from = 0;
      let first = true;
      while (true) {
        let at = from;
        while (at < out.len && (out.data[at] | 0) !== 10) at = at + 1;
        if (!first) docAdd(this.verbatimLineDoc);
        first = false;
        docAdd(docText(out.data, from, at));
        if (at >= out.len) break;
        from = at + 1;
      }
      return docArray(m);
    }
    if (has(34) && has(39) && !has(41)) {
      out.push(40);
      out.append(buf, s, e);
      out.push(41);
      return docText(out.data, 0, out.len);
    }
    const quote = countByte(buf, s, e, preferred) > countByte(buf, s, e, alternate) ? alternate : preferred;
    out.push(quote);
    for (let i = s; i < e; i++) {
      const b = buf[i] | 0;
      if (b === 92 || b === quote) out.push(92);
      out.push(b);
    }
    out.push(quote);
    return docText(out.data, 0, out.len);
  }

  // Prettier's `printLinkReference`: `[label]`
  printLabel(h: number): number {
    this.strOf(h);
    const buf = this.sBuf;
    const s = this.sStart;
    const e = this.sEnd;
    const out = scratch;
    out.reset();
    out.push(91);
    // The package collapse-white-space: every run of white space is a space.
    let i = s;
    while (i < e) {
      const t = trimJsWhitespaceStart(buf, i, e);
      if (t > i) {
        out.push(32);
        i = t;
        continue;
      }
      const b = buf[i] | 0;
      let len = 1;
      if (b >= 0x80) {
        decodeUtf8(buf, i, e);
        len = utf8Len();
      }
      if (b === 92 || b === 91 || b === 93) out.push(92);
      out.append(buf, i, i + len);
      i = i + len;
    }
    out.push(93);
    return docText(out.data, 0, out.len);
  }

  // Prettier's `getBracketContent`: what is between the first `[` of `node` and the `]` that closes it. Sets `sBuf`... returns
  // false if there is none; else the range is `bcStart..bcEnd` of the original.
  bcStart: number = 0;
  bcEnd: number = 0;

  bracketContent(node: number): boolean {
    const tree = this.tree;
    const s = tree.start[node] | 0;
    const e = tree.end[node] | 0;
    const source = this.original;
    if (s > e || e > source.length) return false;
    let first = s;
    while (first < e && (source[first] | 0) !== 91) first = first + 1;
    if (first >= e) return false;
    let depth = 1;
    let index = first + 1;
    while (index < e) {
      const byte = source[index] | 0;
      if (byte === 92) {
        // The character behind it, however many bytes it is.
        let l = 1;
        if (index + 1 < e) {
          if ((source[index + 1] | 0) >= 0x80) {
            decodeUtf8(source, index + 1, e);
            l = utf8Len();
          }
        }
        index = index + 1 + l;
        continue;
      }
      if (byte === 91) depth = depth + 1;
      else if (byte === 93) {
        depth = depth - 1;
        if (depth === 0) {
          this.bcStart = first + 1;
          this.bcEnd = index;
          return true;
        }
      }
      index = index + 1;
    }
    return false;
  }

  printImageAlt(node: number): number {
    const tree = this.tree;
    if (this.isOxfmt) {
      this.strOf(tree.third[node] | 0);
      return this.replaceEndOfLine(this.sBuf, this.sStart, this.sEnd, this.verbatimLineDoc);
    }
    if (!this.isMdx && this.bracketContent(node) && this.bcEnd > this.bcStart) {
      return docText(this.original, this.bcStart, this.bcEnd);
    }
    return this.strDoc(tree.third[node] | 0);
  }

  // ---------------------------------------------------------------------------------------------- nodes

  // Whether `node`, an emphasis or a strong emphasis, has another of its kind right before or behind it, or is at an end of one that
  // has. Prettier gives both the same marker: `*a*_b_` becomes `_a__b_`, which is one emphasis, and `**a**__b__` becomes `**a****b**`.
  keepsMarker(node0: number): boolean {
    const tree = this.tree;
    let node = node0;
    while (true) {
      const k = tree.kind[node] | 0;
      const previous = tree.previous[node] | 0;
      const next = tree.next[node] | 0;
      if ((previous >= 0 && (tree.kind[previous] | 0) === k) || (next >= 0 && (tree.kind[next] | 0) === k)) return true;
      const parent = tree.parent[node] | 0;
      if (parent >= 0 && (tree.kind[parent] | 0) === k && (previous === NONE || next === NONE)) node = parent;
      else return false;
    }
  }

  // Prettier's `printMdast`
  printMdast(id: number): number {
    if (this.isInLabel) return this.printSameContent(id);
    const tree = this.tree;
    const kind = tree.kind[id] | 0;
    switch (kind) {
      case K_ROOT: {
        if ((tree.firstChild[id] | 0) === NONE) return DOC_EMPTY;
        return docs2(this.printRoot(id), DOC_HARDLINE);
      }
      case K_FRONT_MATTER:
        return this.printFrontMatter(id);
      case K_PARAGRAPH: {
        const parts = new FillParts(this.proseWrap === PROSE_WRAP_ALWAYS);
        let child = tree.firstChild[id] | 0;
        while (child >= 0) {
          const next = tree.next[child] | 0;
          const doc = this.print(child);
          parts.flatten(doc);
          child = next;
        }
        if (this.wouldBeFrontMatter(id)) {
          const rest = parts.finish();
          return docs2(docAscii("\\"), rest);
        }
        return parts.finish();
      }
      case K_SENTENCE:
        return this.printSentence(id);
      case K_EMPHASIS: {
        let marker: number;
        const first = tree.firstChild[id] | 0;
        if (this.isAutolink(first) || this.keepsMarker(id)) {
          const s = tree.start[id] | 0;
          marker = s < tree.end[id] && s < this.original.length ? this.original[s] | 0 : 95;
        } else {
          const parent = tree.parent[id] | 0;
          const isInStrongNextToWord = parent >= 0 && (tree.kind[parent] | 0) === K_STRONG && this.hasWordNextTo(parent);
          const needsAsterisk = this.hasWordNextTo(id) || isInStrongNextToWord || this.hasAncestorKind(id, K_EMPHASIS);
          marker = needsAsterisk ? 42 : 95;
        }
        const children = this.printChildren(id);
        scratch.reset();
        scratch.push(marker);
        const style = docText(scratch.data, 0, 1);
        return docs3(style, children, style);
      }
      case K_STRONG: {
        const children = this.printChildren(id);
        const style = this.keepsMarker(id) ? this.sourcePrefix(id, 2, "**") : docAscii("**");
        return docs3(style, children, style);
      }
      case K_DELETE: {
        const children = this.printChildren(id);
        return docs3(docAscii("~~"), children, docAscii("~~"));
      }
      case K_INLINE_CODE:
        return this.printInlineCode(id);
      case K_WIKI_LINK:
        return this.printWikiLink(id);
      case K_LINK:
        return this.printLink(id);
      case K_IMAGE: {
        const m = docBegin();
        docAdd(docAscii("!["));
        docAdd(this.printImageAlt(id));
        docAdd(docAscii("]("));
        docAdd(this.printUrl(tree.value[id] | 0, true));
        docAdd(this.printTitle(tree.second[id] | 0, true));
        docAdd(docAscii(")"));
        return docArray(m);
      }
      case K_BLOCKQUOTE: {
        this.indentation = this.indentation + 2;
        let children = this.printChildren(id);
        this.indentation = this.indentation - 2;
        children = this.contentOfContainer(children);
        return docs2(docAscii("> "), docPool.alignWithText(QUOTE_ALIGN, children));
      }
      case K_HEADING:
        return this.printHeading(id);
      case K_CODE:
        return this.printCode(id, -1, -1);
      case K_HTML:
        return this.printHtml(id);
      case K_LIST:
        return this.printList(id);
      case K_LIST_ITEM:
      case K_TABLE_ROW:
        return DOC_EMPTY;
      case K_IMPORT:
      case K_EXPORT:
      case K_JSX: {
        this.strOf(tree.value[id] | 0);
        const e = trimJsWhitespaceEnd(this.sBuf, this.sStart, this.sEnd);
        return docText(this.sBuf, this.sStart, e);
      }
      case K_ES_COMMENT:
        return docs3(docAscii("{/* "), this.strDoc(tree.value[id] | 0), docAscii(" */}"));
      case K_THEMATIC_BREAK: {
        let isOfAsterisks: boolean;
        const list = this.findAncestorKind(id, K_LIST, K_LIST);
        if (list >= 0) isOfAsterisks = !this.usesAlternateMarker(list);
        else {
          // oxfmt: at the start of a document `---` would start front matter.
          const prev = tree.previous[id] | 0;
          isOfAsterisks = this.isOxfmt && this.kind(tree.parent[id] | 0) === K_ROOT && (prev < 0 || (tree.kind[prev] | 0) === K_FRONT_MATTER);
        }
        return docAscii(isOfAsterisks ? "***" : "---");
      }
      case K_LINK_REFERENCE: {
        const isInLabel = (tree.referenceType[id] | 0) !== REFERENCE_FULL;
        const was = this.isInLabel;
        this.isInLabel = isInLabel;
        const children = this.printChildren(id);
        this.isInLabel = was;
        const rt = tree.referenceType[id] | 0;
        const tail = rt === REFERENCE_FULL ? this.printLabel(tree.value[id] | 0) : rt === REFERENCE_COLLAPSED ? docAscii("[]") : DOC_EMPTY;
        return docs4(docAscii("["), children, docAscii("]"), tail);
      }
      case K_IMAGE_REFERENCE: {
        const rt = tree.referenceType[id] | 0;
        if (rt === REFERENCE_FULL) {
          return docs4(docAscii("!["), this.printImageAlt(id), docAscii("]"), this.printLabel(tree.value[id] | 0));
        }
        if (rt === REFERENCE_COLLAPSED && this.isMdx) return docs3(docAscii("!["), this.printImageAlt(id), docAscii("][]"));
        if (rt !== REFERENCE_COLLAPSED && this.isMdx) return docs3(docAscii("!["), this.printImageAlt(id), docAscii("]"));
        if (rt === REFERENCE_COLLAPSED) return docs3(docAscii("!"), this.printLabel(tree.value[id] | 0), docAscii("[]"));
        return docs2(docAscii("!"), this.printLabel(tree.value[id] | 0));
      }
      case K_DEFINITION: {
        const isAlways = this.proseWrap === PROSE_WRAP_ALWAYS;
        let title: number;
        if ((tree.second[id] | 0) === STR_NO) title = DOC_EMPTY;
        else title = docs2(isAlways ? DOC_LINE_DOC : docAscii(" "), this.printTitle(tree.second[id] | 0, false));
        const label = this.printLabel(tree.third[id] | 0);
        const inner = indent(docs3(isAlways ? DOC_LINE_DOC : docAscii(" "), this.printUrl(tree.value[id] | 0, false), title));
        return group(docs3(label, docAscii(":"), inner));
      }
      case K_FOOTNOTE_REFERENCE:
        return docs3(docAscii("[^"), this.strDoc(tree.value[id] | 0), docAscii("]"));
      case K_DIRECTIVE:
        return this.printDirective(id);
      case K_FOOTNOTE_DEFINITION:
        return this.printFootnoteDefinition(id);
      case K_TABLE:
        return this.printTable(id);
      case K_TABLE_CELL:
        return this.printChildren(id);
      case K_BREAK: {
        const s = tree.start[id] | 0;
        if (s < this.original.length && (this.original[s] | 0) === 92) return docs2(docAscii("\\"), DOC_HARDLINE);
        return docs2(docAscii("  "), this.markRootLiteralline);
      }
      case K_LIQUID_NODE:
      case K_TEXT:
        this.strOf(tree.value[id] | 0);
        return this.replaceEndOfLine(this.sBuf, this.sStart, this.sEnd, DOC_HARDLINE);
      case K_MATH: {
        this.strOf(tree.value[id] | 0);
        const buf = this.sBuf;
        const s = this.sStart;
        const e = this.sEnd;
        const m = docBegin();
        docAdd(docAscii("$$"));
        const third = tree.third[id] | 0;
        if (!(third === STR_NO || (tree.strLen[third] | 0) === 0)) {
          docAdd(docs2(docAscii(" "), this.strDoc(third)));
        }
        docAdd(DOC_HARDLINE);
        if (e > s) docAdd(docs2(this.replaceEndOfLine(buf, s, e, DOC_HARDLINE), DOC_HARDLINE));
        docAdd(docAscii("$$"));
        return docArray(m);
      }
      case K_INLINE_MATH:
        return this.sourceDoc(id);
      default:
        return DOC_EMPTY;
    }
  }

  // The first `n` bytes of the source of `node`, or `fallback`.
  sourcePrefix(node: number, n: number, fallback: string): number {
    const s = this.tree.start[node] | 0;
    const e = this.tree.end[node] | 0;
    if (s + n <= e && e <= this.original.length) return docText(this.original, s, s + n);
    return docAscii(fallback);
  }

  printWikiLink(id: number): number {
    const tree = this.tree;
    this.strOf(tree.value[id] | 0);
    const buf = this.sBuf;
    const s = this.sStart;
    const e = this.sEnd;
    let hasBlanks = false;
    for (let i = s; i < e; i++) {
      const b = buf[i] | 0;
      if (b === 9 || b === 10) {
        hasBlanks = true;
        break;
      }
    }
    if (this.proseWrap === PROSE_WRAP_PRESERVE || !hasBlanks) {
      return docs3(docAscii("[["), docText(buf, s, e), docAscii("]]"));
    }
    const out = scratch2;
    out.reset();
    for (let i = s; i < e; i++) {
      const b = buf[i] | 0;
      if (b === 9 || b === 10) {
        if (out.len > 0 && (out.data[out.len - 1] | 0) === 0) continue;
        out.push(0);
      } else out.push(b);
    }
    for (let i = 0; i < out.len; i++) {
      if ((out.data[i] | 0) === 0) out.data[i] = 32;
    }
    return docs3(docAscii("[["), docText(out.data, 0, out.len), docAscii("]]"));
  }

  printLink(id: number): number {
    const tree = this.tree;
    const s = tree.start[id] | 0;
    const e = tree.end[id] | 0;
    const first = s < e && s < this.original.length ? this.original[s] | 0 : -1;
    if (first === 60) {
      this.strOf(tree.value[id] | 0);
      let us = this.sStart;
      const ue = this.sEnd;
      const buf = this.sBuf;
      // `<hello@example.com>` has the URL `mailto:hello@example.com`.
      if (startsWithStr(buf, us, ue, "mailto:") && !startsWithStr(this.original, s + 1, e, "mailto:")) us = us + 7;
      return docs3(docAscii("<"), docText(buf, us, ue), docAscii(">"));
    }
    if (first === 91) {
      const m = docBegin();
      docAdd(docAscii("["));
      docAdd(this.printChildren(id));
      docAdd(docAscii("]("));
      docAdd(this.printUrl(tree.value[id] | 0, true));
      docAdd(this.printTitle(tree.second[id] | 0, true));
      docAdd(docAscii(")"));
      return docArray(m);
    }
    return this.sourceDoc(id);
  }

  printHeading(id: number): number {
    const tree = this.tree;
    if (!this.isMdx && this.isSetextHeading(id)) {
      const end = tree.end[id] | 0;
      const lastLineStart = tree.lineStart(end > 0 ? end - 1 : 0);
      const orig = this.original;
      let eq = -1;
      let dash = -1;
      for (let i = lastLineStart; i < end; i++) {
        const b = orig[i] | 0;
        if (b === 61 && eq < 0) eq = i - lastLineStart;
        if (b === 45 && dash < 0) dash = i - lastLineStart;
      }
      const found = eq > dash ? eq : dash;
      const lineLen = end - lastLineStart;
      const from = found >= 0 ? found : lineLen > 0 ? lineLen - 1 : 0;
      const children = this.printChildren(id);
      return docs3(children, DOC_HARDLINE, docText(orig, lastLineStart + from, end));
    }
    const n = tree.number[id] | 0;
    scratch.reset();
    const hashes = n < 6 ? n : 6;
    for (let i = 0; i < hashes; i++) scratch.push(35);
    scratch.push(32);
    const prefix = docText(scratch.data, 0, scratch.len);
    return docs2(prefix, this.printChildren(id));
  }

  printHtml(id: number): number {
    const tree = this.tree;
    this.strOf(tree.value[id] | 0);
    const buf = this.sBuf;
    const s = this.sStart;
    let e = this.sEnd;
    if (this.kind(tree.parent[id] | 0) === K_ROOT && (tree.next[id] | 0) === NONE) e = trimJsWhitespaceEnd(buf, s, e);
    if (this.isOxfmt && e > s && (buf[e - 1] | 0) === 10) e = e - 1;
    const isComment = e - s >= 7 && startsWithStr(buf, s, e, "<!--") && endsWithStr(buf, s, e, "-->");
    // In a line, what follows it is measured from its last line break on.
    const inWrapper = isInlineWrapper(this.kind(tree.parent[id] | 0));
    if (!inWrapper) return this.lines(buf, s, e, !isComment);
    if (this.isOxfmt) return this.replaceEndOfLine(buf, s, e, this.verbatimLineDoc);
    if (isComment) return this.replaceEndOfLine(buf, s, e, DOC_HARDLINE);
    return this.replaceEndOfLine(buf, s, e, this.markRootLiteralline);
  }

  // oxfmt's `Block::ContainerDirective`: the two lines are printed as they are written. An empty line behind the first and before the
  // second stays.
  printDirective(id: number): number {
    const tree = this.tree;
    const gap = (isEmptyLine: boolean): number => (isEmptyLine ? docs2(DOC_HARDLINE, DOC_HARDLINE) : DOC_HARDLINE);
    const openingLine = this.startLine(id);
    this.strOf(tree.value[id] | 0);
    const obuf = this.sBuf;
    const os = this.sStart;
    const oe = this.sEnd;
    const m = docBegin();
    docAdd(docText(obuf, os, oe));
    let lastLine = openingLine;
    const first = tree.firstChild[id] | 0;
    const last = tree.lastChild[id] | 0;
    if (first >= 0 && last >= 0) {
      const isEmptyLine = this.startLine(first) > openingLine + 1;
      // The blanks at its end stay.
      const endsInBlank = oe > os && ((obuf[oe - 1] | 0) === 32 || (obuf[oe - 1] | 0) === 9);
      if (endsInBlank && isEmptyLine) docAdd(docs2(this.markRootLiteralline, DOC_HARDLINE));
      else if (endsInBlank) docAdd(this.markRootLiteralline);
      else docAdd(gap(isEmptyLine));
      lastLine = this.endLine(last);
      docAdd(this.printChildren(id));
    }
    if ((tree.second[id] | 0) !== STR_NO) {
      docAdd(gap(this.endLine(id) > lastLine + 1));
      docAdd(this.strDoc(tree.second[id] | 0));
    }
    return docArray(m);
  }

  printFootnoteDefinition(id: number): number {
    const tree = this.tree;
    const first = tree.firstChild[id] | 0;
    const onlyParagraph = first >= 0 && (tree.kind[first] | 0) === K_PARAGRAPH && first === (tree.lastChild[id] | 0);
    let isInline = false;
    if (onlyParagraph) {
      if (this.proseWrap === PROSE_WRAP_NEVER) isInline = this.isOxfmt ? !this.hasHardBreak(first) : true;
      else if (this.proseWrap === PROSE_WRAP_PRESERVE) isInline = this.startLine(first) === this.endLine(first);
      else isInline = false;
    }
    let children: number;
    if (isInline) children = this.printChildren(id);
    else {
      this.indentation = this.indentation + 4;
      const m = docBegin();
      let any = false;
      let child = first;
      while (child >= 0) {
        let doc = this.print(child);
        if (child === first) doc = group(docs2(DOC_SOFTLINE, doc));
        if (any) this.addSeparators(child);
        docAdd(doc);
        any = true;
        child = tree.next[child] | 0;
      }
      const list = docArray(m);
      this.indentation = this.indentation - 4;
      children = group(alignWithSpaces(4, list));
    }
    return docs4(docAscii("[^"), this.strDoc(tree.value[id] | 0), docAscii("]: "), children);
  }

  printInlineCode(id: number): number {
    const tree = this.tree;
    const h = tree.value[id] | 0;
    let buf = this.bufOf(h);
    let s = tree.strStart[h] | 0;
    let e = s + (tree.strLen[h] | 0);
    // Nothing special in it (no backtick, line break or pipe): the common case.
    {
      let special = 0;
      const table = INLINE_CODE_SPECIAL;
      for (let i = s; i < e; i++) special = special | (table[buf[i] | 0] | 0);
      if (special === 0) {
        const first = e > s ? buf[s] | 0 : -1;
        const last = e > s ? buf[e - 1] | 0 : -1;
        let needsPadding = false;
        if (first === 32 && last === 32) {
          for (let i = s; i < e; i++) {
            if ((buf[i] | 0) !== 32) {
              needsPadding = true;
              break;
            }
          }
        }
        if (!needsPadding) return docs3(this.tickDoc, docText(buf, s, e), this.tickDoc);
        const m = docBegin();
        docAdd(this.tickDoc);
        docAdd(this.spaceDoc);
        docAdd(docText(buf, s, e));
        docAdd(this.spaceDoc);
        docAdd(this.tickDoc);
        return docArray(m);
      }
    }
    const hasNewline = containsByte(buf, s, e, 10);
    if (this.proseWrap !== PROSE_WRAP_PRESERVE && hasNewline) {
      scratch2.reset();
      for (let i = s; i < e; i++) {
        const b = buf[i] | 0;
        scratch2.push(b === 10 ? 32 : b);
      }
      buf = scratch2.data;
      s = 0;
      e = scratch2.len;
    }
    if (!this.isMdx && containsByte(buf, s, e, 124) && this.hasAncestorKind(id, K_TABLE_CELL)) {
      scratch.reset();
      for (let i = s; i < e; i++) {
        const b = buf[i] | 0;
        if (b === 124) scratch.push(92);
        scratch.push(b);
      }
      buf = scratch.data;
      s = 0;
      e = scratch.len;
    }
    const nTicks = minNotPresentContinuousCount(buf, s, e, 96);
    const first = e > s ? buf[s] | 0 : -1;
    const last = e > s ? buf[e - 1] | 0 : -1;
    const isBl = (b: number): boolean => b === 10 || b === 32;
    let allBlank = true;
    for (let i = s; i < e; i++) {
      if (!isBl(buf[i] | 0)) {
        allBlank = false;
        break;
      }
    }
    const needsPadding = first === 96 || last === 96 || (first >= 0 && isBl(first) && isBl(last) && !allBlank);
    const ticks = docPool.repeated(96, nTicks);
    const padding = needsPadding ? docAscii(" ") : DOC_EMPTY;
    if (this.isOxfmt && containsByte(buf, s, e, 10)) {
      const m = docBegin();
      let from = s;
      let firstLine = true;
      while (true) {
        let at = from;
        while (at < e && (buf[at] | 0) !== 10) at = at + 1;
        if (!firstLine) docAdd(this.verbatimLineDoc);
        firstLine = false;
        docAdd(docText(buf, from, at));
        if (at >= e) break;
        from = at + 1;
      }
      const lines = docArray(m);
      const m2 = docBegin();
      docAdd(ticks);
      docAdd(padding);
      docAdd(lines);
      docAdd(padding);
      docAdd(ticks);
      return docArray(m2);
    }
    const m = docBegin();
    docAdd(ticks);
    docAdd(padding);
    docAdd(docText(buf, s, e));
    docAdd(padding);
    docAdd(ticks);
    return docArray(m);
  }

  // What is behind the opening fence of the block of code `node`.
  printInfo(node: number): number {
    const tree = this.tree;
    const part = (h: number): number => {
      this.strOf(h);
      const buf = this.sBuf;
      const s = this.sStart;
      const e = this.sEnd;
      if (!this.isOxfmt || !containsByte(buf, s, e, 92)) return docText(buf, s, e);
      // oxfmt: or it would escape what follows it when it is read again.
      const out = scratch2;
      out.reset();
      for (let i = s; i < e; i++) {
        const b = buf[i] | 0;
        if (b === 92) out.push(92);
        out.push(b);
      }
      return docText(out.data, 0, out.len);
    };
    const second = part(tree.second[node] | 0);
    const third = tree.third[node] | 0;
    if (tree.strLength(third) === 0) return docs2(second, DOC_EMPTY);
    return docs2(second, docs2(docAscii(" "), part(third)));
  }

  // What the fence of the block of code `node` is made of.
  fenceUnit(node: number): number {
    const tree = this.tree;
    // oxfmt: behind backticks there can be no backtick.
    let isBacktickInInfo = false;
    if (this.isOxfmt) {
      this.strOf(tree.second[node] | 0);
      if (containsByte(this.sBuf, this.sStart, this.sEnd, 96)) isBacktickInInfo = true;
      else {
        this.strOf(tree.third[node] | 0);
        isBacktickInInfo = containsByte(this.sBuf, this.sStart, this.sEnd, 96);
      }
    }
    return this.isInTemplate || isBacktickInInfo ? 126 : 96;
  }

  // `formatted`: the code, if it has been formatted (a doc; -1: it has not), and for oxfmt the longest run of what the fence is made of
  // in it (`run`; -1: look at the value): Prettier looks at the code as it was.
  printCode(id: number, formatted: number, run0: number): number {
    const tree = this.tree;
    this.strOf(tree.value[id] | 0);
    const vbuf = this.sBuf;
    const vs = this.sStart;
    const ve = this.sEnd;
    if (formatted < 0 && isIndentedCode(this.original, tree, id)) {
      return alignWithSpaces(4, docs2(docAscii("    "), this.replaceEndOfLine(vbuf, vs, ve, DOC_HARDLINE)));
    }
    const unit = this.fenceUnit(id);
    let run = run0;
    let blank = -1;
    if (run0 < 0) {
      if (formatted < 0) {
        // One pass for the longest run of the fence and the blanks before line breaks.
        run = scanCode(vbuf, vs, ve, unit);
        blank = codeBlank;
      } else run = maxContinuousCount(vbuf, vs, ve, unit);
    }
    const n = run + 1 > 3 ? run + 1 : 3;
    const style = docPool.repeated(unit, n);
    const info = this.printInfo(id);
    const body = formatted >= 0 ? formatted : this.lines(vbuf, vs, ve, false, blank);
    const m = docBegin();
    docAdd(style);
    docAdd(info);
    docAdd(DOC_HARDLINE);
    docAdd(body);
    docAdd(DOC_HARDLINE);
    docAdd(style);
    return docArray(m);
  }

  // Prettier's `embed`. Returns the document, or -1.
  printEmbedded(id: number): number {
    const tree = this.tree;
    const kind = tree.kind[id] | 0;
    if (kind === K_IMPORT || kind === K_EXPORT || kind === K_JSX) {
      this.strOf(tree.value[id] | 0);
      const width = this.lineWidth > this.indentation ? this.lineWidth - this.indentation : 0;
      const lang = kind === K_JSX ? MDX_JSX : MDX_ES_SYNTAX;
      this.fmtOut.reset();
      if (!this.embed.format(lang, 0, lang.length, this.sBuf, this.sStart, this.sEnd, width, this.fmtOut)) return -1;
      const out = this.fmtOut;
      const e = trimJsWhitespaceEnd(out.data, 0, out.len);
      return this.linesOf(out.data, 0, e);
    }
    if (kind !== K_CODE) return -1;
    const second = tree.second[id] | 0;
    if (second === STR_NO) return -1;
    this.strOf(second);
    const lbuf = this.sBuf;
    const ls = this.sStart;
    const le = this.sEnd;
    if (ls === le) return -1;
    const width = this.lineWidth > this.indentation ? this.lineWidth - this.indentation : 0;
    this.strOf(tree.value[id] | 0);
    const cbuf = this.sBuf;
    const cs = this.sStart;
    const ce = this.sEnd;
    const isOxfmt = this.isOxfmt;
    if (isOxfmt) {
      // Formatting would move the lines that the numbers are about.
      this.strOf(tree.third[id] | 0);
      if (hasLineRanges(this.sBuf, this.sStart, this.sEnd)) return -1;
      // Nothing but white space in a language that is formatted: an empty line.
      if (trimJsWhitespaceEnd(cbuf, cs, ce) === cs && this.embed.knowsOxfmtLanguage(lbuf, ls, le)) {
        const style = docPool.repeated(this.fenceUnit(id), 3);
        const m = docBegin();
        docAdd(style);
        docAdd(this.printInfo(id));
        docAdd(DOC_HARDLINE);
        docAdd(DOC_HARDLINE);
        docAdd(style);
        return docArray(m);
      }
    }
    this.fmtOut.reset();
    if (!this.embed.format(lbuf, ls, le, cbuf, cs, ce, width, this.fmtOut)) return -1;
    const out = this.fmtOut;
    const fe = trimJsWhitespaceEnd(out.data, 0, out.len);
    const run = isOxfmt ? maxContinuousCount(out.data, 0, fe, this.fenceUnit(id)) : -1;
    const isAsItIs = this.indentation === 0 && !this.isInTemplate && !this.options.isInMarkdown && !containsByte(out.data, 0, fe, 13);
    const formatted = isAsItIs ? docText(out.data, 0, fe) : this.linesOf(out.data, 0, fe);
    return docPool.markAsRoot(this.printCode(id, formatted, run));
  }

  // Prettier's `printEmbedFrontMatter`
  printFrontMatter(node: number): number {
    const tree = this.tree;
    const orig = this.original;
    const end = tree.end[node] | 0;
    const fm = parseFrontMatter(orig);
    if (fm === null || end > orig.length) return docText(orig, 0, end);
    const ls = fm.languageStart;
    const le = fm.languageEnd;
    const isPlus = startsWithStr(orig, 0, end, "+++");
    const isLangToml = le - ls === 4 && startsWithStr(orig, ls, le, "toml");
    const isLangYaml = le - ls === 4 && startsWithStr(orig, ls, le, "yaml");
    const isToml = isLangToml || (le === ls && isPlus);
    const isYaml = isLangYaml || (le === ls && !isToml);
    const vs = trimJsWhitespaceStart(orig, fm.valueStart, fm.valueEnd);
    const ve = trimJsWhitespaceEnd(orig, vs, fm.valueEnd);
    let ok = false;
    this.fmtOut.reset();
    if (vs === ve && (isYaml || isToml)) {
      ok = this.embed.format(EMPTY, 0, 0, EMPTY, 0, 0, 0, this.fmtOut);
    } else if (hasIndentedDelimiter(orig, 0, end)) {
      ok = false;
    } else if (isYaml) {
      ok = this.embed.format(YAML_LANG, 0, 4, orig, vs, ve, this.lineWidth, this.fmtOut);
    }
    if (!ok) return docText(orig, 0, end);
    const out = this.fmtOut;
    const fe = trimJsWhitespaceEnd(out.data, 0, out.len);
    const m = docBegin();
    docAdd(docText(orig, 0, 3));
    docAdd(docText(orig, ls, le));
    docAdd(DOC_HARDLINE);
    if (fe > 0) docAdd(docs2(this.linesOf(out.data, 0, fe), DOC_HARDLINE));
    docAdd(docText(orig, end - 3, end));
    return docPool.markAsRoot(docArray(m));
  }

  // Prettier's `printRoot`: what is between `<!-- prettier-ignore-start -->` and `<!-- prettier-ignore-end -->` stays as it is.
  printRoot(root: number): number {
    const tree = this.tree;
    const starts: number[] = [];
    const ends: number[] = [];
    let start = NONE;
    for (let child = tree.firstChild[root] | 0; child >= 0; child = tree.next[child] | 0) {
      const ig = this.prettierIgnore(child);
      if (ig === IGNORE_START && start < 0) start = child;
      else if (ig === IGNORE_END) {
        if (start >= 0) {
          starts.push(start);
          ends.push(child);
        }
        start = NONE;
      }
    }
    if (starts.length === 0) return this.printChildren(root);
    let at = 0;
    let isInRange = false;
    const m = docBegin();
    let any = false;
    let child = tree.firstChild[root] | 0;
    while (child >= 0) {
      let result = -1;
      if (at < starts.length) {
        const rs = starts[at];
        const re = ends[at];
        if (child === rs) {
          isInRange = true;
          const a = this.ignoreComment(rs);
          const b = this.ignoreComment(re);
          result = docs3(a, docText(this.original, tree.end[rs] | 0, tree.start[re] | 0), b);
        } else if (child === re) {
          isInRange = false;
          at = at + 1;
        } else if (isInRange) {
          // left out
        } else result = this.print(child);
      } else result = this.print(child);
      if (result >= 0) {
        if (any) this.addSeparators(child);
        docAdd(result);
        any = true;
      }
      child = tree.next[child] | 0;
    }
    return docArray(m);
  }

  // Prettier's `printIgnoreComment`
  ignoreComment(node: number): number {
    const tree = this.tree;
    const c = tree.firstChild[node] | 0;
    if (c >= 0) return docs3(docAscii("{/* "), this.strDoc(tree.value[c] | 0), docAscii(" */}"));
    return this.strDoc(tree.value[node] | 0);
  }

  // ---------------------------------------------------------------------------------------------- lists

  // Prettier's `hasGitDiffFriendlyOrderedList`: `1. 1. 1.` or `0. 0. 0.`
  isGitDiffFriendly(list: number): boolean {
    const tree = this.tree;
    const first = tree.firstChild[list] | 0;
    if (first < 0) return false;
    const second = tree.next[first] | 0;
    if (second < 0 || ((tree.flags[list] | 0) & F_ORDERED) === 0) return false;
    if (orderedNumber(this.original, tree, second) !== 1) return false;
    if (orderedNumber(this.original, tree, first) !== 0) return true;
    const third = tree.next[second] | 0;
    if (third < 0) return false;
    return orderedNumber(this.original, tree, third) === 1;
  }

  // Prettier's `printList`
  printList(list: number): number {
    const tree = this.tree;
    const usesAlternateMarker = this.usesAlternateMarker(list);
    const isGitDiffFriendly = this.isGitDiffFriendly(list);
    const isOrdered = ((tree.flags[list] | 0) & F_ORDERED) !== 0;
    // Before indented code, the content has to be indented deeper than that is.
    let minIndent = 0;
    const nextNode = tree.next[list] | 0;
    if (nextNode >= 0 && isIndentedCode(this.original, tree, nextNode)) {
      this.strOf(tree.value[nextNode] | 0);
      let sum = 0;
      let i = this.sStart;
      while (i < this.sEnd) {
        const b = this.sBuf[i] | 0;
        if (b !== 32 && b !== 9) break;
        sum = sum + (b === 9 ? 4 : 1);
        i = i + 1;
      }
      minIndent = 4 + sum + 1;
    }
    const tabWidth = this.indentWidth > 1 ? this.indentWidth : 1;
    const listNumber = tree.number[list] | 0;
    const isAligned = ((tree.flags[list] | 0) & F_ALIGNED) !== 0;
    const listChecked = (tree.checked[list] | 0) !== 0;
    const m = docBegin();
    let any = false;
    let index = 0;
    let item = tree.firstChild[list] | 0;
    while (item >= 0) {
      const nextItem = tree.next[item] | 0;
      const pfx = scratch;
      pfx.reset();
      if (isOrdered) {
        let number: number;
        if (index === 0) number = listNumber;
        else if (isGitDiffFriendly) number = 1;
        else if (this.isMdx) number = listNumber + index;
        else number = Math.min(listNumber + index, 999999999);
        pfx.appendUint(number);
        if (usesAlternateMarker) {
          pfx.push(41);
          pfx.push(32);
        } else {
          pfx.push(46);
          pfx.push(32);
        }
      } else {
        pfx.push(usesAlternateMarker ? 42 : 45);
        pfx.push(32);
      }
      index = index + 1;
      if ((isAligned || (this.isMdx && listChecked)) && isOrdered) {
        // Prettier's `alignListPrefix`. Four or more would make it indented code.
        const additional = (tabWidth - (pfx.len % tabWidth)) % tabWidth;
        if (additional < 4) pfx.fill(32, additional);
      }
      if (pfx.len < minIndent && !this.isMdx) {
        // trim_ascii_end
        while (pfx.len > 0 && isAsciiWs(pfx.data[pfx.len - 1] | 0)) pfx.len = pfx.len - 1;
        const trailing = Math.min(minIndent - pfx.len, 4);
        if (trailing > 0) pfx.fill(32, trailing);
        const leading = Math.min(minIndent - pfx.len, 3);
        if (leading > 0) {
          const old = pfx.view().slice();
          pfx.reset();
          pfx.fill(32, leading);
          pfx.append(old, 0, old.length);
        }
      }

      const first = tree.firstChild[item] | 0;
      const second = tree.lastChild[item] | 0;
      const isHtmlOutOfLine =
        !this.isOxfmt &&
        first >= 0 &&
        second >= 0 &&
        (tree.next[first] | 0) === second &&
        (tree.kind[second] | 0) === K_HTML &&
        this.column(tree.start[first] | 0) !== this.column(tree.start[second] | 0);
      const len = pfx.len;
      const prefixDoc = docText(pfx.data, 0, pfx.len);
      let doc: number;
      if (isHtmlOutOfLine) {
        doc = docs2(prefixDoc, this.printListItem(item, len));
      } else {
        this.indentation = this.indentation + len;
        let contents = this.printListItem(item, len);
        this.indentation = this.indentation - len;
        contents = this.contentOfContainer(contents);
        doc = docs2(prefixDoc, alignWithSpaces(len, contents));
      }
      if (any) this.addSeparators(item);
      docAdd(doc);
      any = true;
      item = nextItem;
    }
    return docArray(m);
  }

  // oxfmt: see `verbatim_line`.
  contentOfContainer(contents: number): number {
    return this.isOxfmt ? docPool.markAsRoot(contents) : contents;
  }

  // Prettier's `printListItem`
  printListItem(id: number, listPrefixLen: number): number {
    const tree = this.tree;
    const checked = tree.checked[id] | 0;
    const prefixLen = checked === 0 ? 0 : 4;
    const prefix = checked === 0 ? DOC_EMPTY : docAscii(checked === 1 ? "[ ] " : "[x] ");
    const first = tree.firstChild[id] | 0;
    const tabWidth = this.indentWidth;
    const m = docBegin();
    let any = false;
    let child = first;
    while (child >= 0) {
      const next = tree.next[child] | 0;
      const kind = tree.kind[child] | 0;
      let doc: number;
      // oxfmt: HTML is in the column of what is in the item, as indented code is.
      if (kind === K_HTML && child !== first && this.isOxfmt) {
        doc = this.print(child);
      } else if ((child === first && kind !== K_LIST) || (kind === K_HTML && !this.isMdx)) {
        this.indentation = this.indentation + prefixLen;
        const d = this.print(child);
        this.indentation = this.indentation - prefixLen;
        doc = alignWithSpaces(prefixLen, d);
      } else if (isIndentedCode(this.original, tree, child)) {
        doc = this.print(child);
      } else {
        // Four or more would make it indented code.
        let alignment = tabWidth > listPrefixLen ? tabWidth - listPrefixLen : 0;
        if (alignment > 3) alignment = 3;
        this.indentation = this.indentation + alignment;
        const d = this.print(child);
        this.indentation = this.indentation - alignment;
        doc = docs2(docPool.repeated(32, alignment), alignWithSpaces(alignment, d));
      }
      if (any) this.addSeparators(child);
      docAdd(doc);
      any = true;
      child = next;
    }
    const children = docArray(m);
    return docs2(prefix, children);
  }

  // ---------------------------------------------------------------------------------------------- tables

  // Prettier's `printTable`
  printTable(id: number): number {
    const tree = this.tree;
    const firstAlign = tree.firstAlign[id] | 0;
    const nAlign = tree.number[id] | 0;
    // The cells, printed to text: all the bytes in `cells`, (start, end, width) per cell in `cellInfo`.
    const cells = new ByteBuf(256);
    const info: number[] = [];
    const rowLens: number[] = [];
    const widths: number[] = [];
    for (let row = tree.firstChild[id] | 0; row >= 0; row = tree.next[row] | 0) {
      let column = 0;
      for (let cell = tree.firstChild[row] | 0; cell >= 0; cell = tree.next[cell] | 0) {
        const doc = this.print(cell);
        const start = cells.len;
        const r = printDocument(doc, this.options, NEWLINE_TEXT, cells);
        if (r !== FORMAT_OK) this.failure = r;
        const width = stringWidthAs(cells.data, start, cells.len, this.options.flavor);
        if (widths.length <= column) {
          // `---`, `:--`, `:-:`, `--:`
          widths.push(3);
        }
        if (width > widths[column]) widths[column] = width;
        info.push(start);
        info.push(cells.len);
        info.push(width);
        column = column + 1;
      }
      rowLens.push(column);
    }
    const headLen = this.isMdx ? 0x7fffffff : rowLens.length > 0 ? rowLens[0] : 0;
    const alignOf = (column: number): number => (column < nAlign ? tree.aligns[firstAlign + column] | 0 : ALIGN_NONE);

    const printContents = (isCompact: boolean): number => {
      const m = docBegin();
      const line = new ByteBuf(256);
      let first = true;
      const pushLine = (): void => {
        if (!first) docAdd(DOC_HARD_LINE);
        first = false;
        docAdd(docText(line.data, 0, line.len));
      };
      let ci = 0;
      for (let r = 0; r < rowLens.length; r++) {
        line.reset();
        line.push(124);
        line.push(32);
        for (let column = 0; column < rowLens[r]; column++) {
          if (column > 0) {
            line.push(32);
            line.push(124);
            line.push(32);
          }
          const s = info[ci * 3];
          const e = info[ci * 3 + 1];
          const width = info[ci * 3 + 2];
          ci = ci + 1;
          if (isCompact) {
            line.append(cells.data, s, e);
            continue;
          }
          const blanks = widths[column] - width;
          const a = alignOf(column);
          const before = a === ALIGN_RIGHT ? blanks : a === ALIGN_CENTER ? Math.floor(blanks / 2) : 0;
          line.fill(32, before);
          line.append(cells.data, s, e);
          line.fill(32, blanks - before);
        }
        line.push(32);
        line.push(124);
        pushLine();
        if (r === 0) {
          // The row under the head has as many cells as the head.
          line.reset();
          line.push(124);
          line.push(32);
          const n = Math.min(widths.length, headLen);
          for (let column = 0; column < n; column++) {
            if (column > 0) {
              line.push(32);
              line.push(124);
              line.push(32);
            }
            const a = alignOf(column);
            line.push(a === ALIGN_CENTER || a === ALIGN_LEFT ? 58 : 45);
            const total = isCompact ? 2 : widths[column] - 1;
            // `cell.resize(total, '-')`: the cell has one byte already
            for (let k = 1; k < total; k++) line.push(45);
            line.push(a === ALIGN_CENTER || a === ALIGN_RIGHT ? 58 : 45);
          }
          line.push(32);
          line.push(124);
          pushLine();
        }
      }
      return docArray(m);
    };

    const aligned = printContents(false);
    if (this.proseWrap !== PROSE_WRAP_NEVER) return docs2(DOC_BREAK_PARENT_DOC, aligned);
    // Without the padding if it does not fit.
    const compact = printContents(true);
    return docs2(DOC_BREAK_PARENT_DOC, group(docPool.ifBreak(compact, aligned, 0)));
  }
}

const NEWLINE_TEXT = new Uint8Array([10]);

// 1 for the bytes that make inline code take the long way: a line break, a backtick, a pipe.
const INLINE_CODE_SPECIAL = new Uint8Array(256);
INLINE_CODE_SPECIAL[10] = 1;
INLINE_CODE_SPECIAL[96] = 1;
INLINE_CODE_SPECIAL[124] = 1;
const YAML_LANG = new Uint8Array([121, 97, 109, 108]);

// 1 for a tab, a line break and a space.
const WHITE3 = new Uint8Array(256);
WHITE3[9] = 1;
WHITE3[10] = 1;
WHITE3[32] = 1;

function pushCodePoint(out: ByteBuf, cp: number): void {
  if (cp < 0x80) out.push(cp);
  else if (cp < 0x800) {
    out.push(0xc0 | (cp >> 6));
    out.push(0x80 | (cp & 0x3f));
  } else if (cp < 0x10000) {
    out.push(0xe0 | (cp >> 12));
    out.push(0x80 | ((cp >> 6) & 0x3f));
    out.push(0x80 | (cp & 0x3f));
  } else {
    out.push(0xf0 | (cp >> 18));
    out.push(0x80 | ((cp >> 12) & 0x3f));
    out.push(0x80 | ((cp >> 6) & 0x3f));
    out.push(0x80 | (cp & 0x3f));
  }
}

