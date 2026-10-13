// Port of vendor/bun/src/format/yaml/printer.rs. Prettier's `language-yaml`: `printer-yaml.js`, `print/*.js` and
// `utilities.js`.
//
// It writes to the `Elements` of `css/doc.ts` (one list of operations, no `Doc` tree). The printer's state is module
// level (per thread). What Rust holds in `Vec<Words>` / `Cow` is in scratch arrays here (`wS`/`wE`: the words as ranges
// of `wBuf`; `lnFirst`/`lnCount`/`lnKind`: the lines made of them).
import { ByteBuf } from "../../base/bytebuf.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { Elements, LINE_LITERAL, LINE_SOFT, LINE_SPACE } from "../css/doc.ts";
import { PROSE_WRAP_NEVER, PROSE_WRAP_PRESERVE } from "../options.ts";
import {
  hasNewlineBackwards,
  isPreviousLineEmpty,
  jsWhitespaceLen,
  startsWithWhiteSpace,
  trimJsWhitespaceEnd,
  trimJsWhitespaceStart,
} from "../text.ts";
import {
  CH_KEEP,
  F_KIND,
  F_PARENT,
  F_NEXT,
  F_CH_FIRST,
  F_CH_LAST,
  F_CH_LEN,
  F_LD_FIRST,
  F_LD_LAST,
  F_LD_LEN,
  F_MD_FIRST,
  F_MD_LAST,
  F_MD_LEN,
  F_EN_FIRST,
  F_EN_LAST,
  F_EN_LEN,
  F_TRAILING,
  F_INDICATOR,
  F_TAG,
  F_ANCHOR,
  F_S_OFF,
  F_S_LINE,
  F_E_OFF,
  F_E_LINE,
  F_V_START,
  F_V_END,
  F_INDENT,
  F_FLAGS,
  F_HAS_COMMENTS,
  F_HAS_PROPS,
  CH_STRIP,
  K_ALIAS,
  K_BLOCK_FOLDED,
  K_BLOCK_LITERAL,
  K_COMMENT,
  K_DIRECTIVE,
  K_DOCUMENT,
  K_DOCUMENT_BODY,
  K_DOCUMENT_HEAD,
  K_FLOW_MAPPING,
  K_FLOW_MAPPING_ITEM,
  K_FLOW_SEQUENCE,
  K_FLOW_SEQUENCE_ITEM,
  K_MAPPING,
  K_MAPPING_ITEM,
  K_MAPPING_KEY,
  K_MAPPING_VALUE,
  K_PLAIN,
  K_QUOTE_DOUBLE,
  K_QUOTE_SINGLE,
  K_ROOT,
  K_SEQUENCE,
  K_SEQUENCE_ITEM,
  K_TAG,
  K_ANCHOR,
  T,
  treeIsAscii,
  treeStack,
} from "./ast.ts";
import { scalarOut, scalarSource } from "./scalar.ts";

// `Words`: the kind of a line of a scalar
const LK_NONE = 0;
const LK_ONE = 1;
const LK_SLICES = 2;
const LK_JOINED = 3;

// ---------------------------------------------------------------------------------------------- state

let out: Elements = new Elements();
let text: Uint8Array = new Uint8Array(0);
let textLen = 0;
let proseWrap = PROSE_WRAP_PRESERVE;
let singleQuote = false;
let bracketSpacing = true;
let trailingComma = true;
let tabWidth = 2;
let isOxfmt = false;
// Of the document that is being printed.
let isLastDocument = true;
// Of the mapping or sequence whose first item is printed next.
let isFirstItemIgnored = false;
// A comment that is printed behind the `[` or `{` that is at the position, not behind the key before it.
let commentInBrackets = -1;
let commentInBracketsStart = 0;
// `printedEmptyLineCache`: for each position, whether a node ends there whose next line has been looked at.
// (a position is marked when it holds `printedStamp`: a new file needs no clearing)
let printedEmptyLines: Int32Array = new Int32Array(256);
let printedStamp = 0;
let lastGroupId = 0;
// How many keys are around what is being printed.
let keyDepth = 0;
// Where the first character of the text is that is no white space.
let startOfContent = 0;
// All of the text is ASCII: a text is as wide as it is long
let asciiFile = false;

// The words of a scalar, as ranges of `wBuf`, and the lines made of them
let wBuf: Uint8Array = new Uint8Array(0);
let wS: Int32Array = new Int32Array(256);
let wE: Int32Array = new Int32Array(256);
let nW = 0;
let lnFirst: Int32Array = new Int32Array(64);
let lnCount: Int32Array = new Int32Array(64);
let lnKind: Uint8Array = new Uint8Array(64);
let nLn = 0;
// The raw lines of a scalar
let rlS: Int32Array = new Int32Array(64);
let rlE: Int32Array = new Int32Array(64);
let nRl = 0;
// The content of a quoted scalar, when it is not as written
const contentBuf: ByteBuf = new ByteBuf(256);
const joinBuf: ByteBuf = new ByteBuf(256);
// The content that `printQuoted` hands to `printFlowScalarContent`
let cBuf: Uint8Array = new Uint8Array(0);
let cStart = 0;
let cEnd = 0;
const leftVec = new I32Vec(16);

/** Gives the printer what it prints and how. `src`: the text with `\n` line breaks and no BOM. `elements` is cleared by the
 * caller. */
export function setup(
  elements: Elements,
  src: Uint8Array,
  len: number,
  prose: number,
  singleQuoteOption: boolean,
  bracketSpacingOption: boolean,
  trailingCommaOption: boolean,
  tabWidthOption: number,
  oxfmt: boolean,
): void {
  out = elements;
  text = src;
  textLen = len;
  proseWrap = prose;
  singleQuote = singleQuoteOption;
  bracketSpacing = bracketSpacingOption;
  trailingComma = trailingCommaOption;
  tabWidth = tabWidthOption;
  isOxfmt = oxfmt;
  isLastDocument = true;
  isFirstItemIgnored = false;
  commentInBrackets = -1;
  commentInBracketsStart = 0;
  if (printedEmptyLines.length < len + 1) printedEmptyLines = new Int32Array(len + 64);
  printedStamp = ((printedStamp | 0) + 1) | 0;
  lastGroupId = 0;
  keyDepth = 0;
  let i = 0;
  while (i < len) {
    const b = src[i] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) i = i + 1;
    else break;
  }
  startOfContent = i;
  asciiFile = treeIsAscii();
}

/** Prints the tree (`T.root`). Returns false if the stack ran out. */
export function printTree(): boolean {
  print(T.root | 0, true);
  return !treeStack.ranOut();
}

// ---------------------------------------------------------------------------------------------- predicates

/** `isInlineNode` of a node, or -1 (none). */
function isInlineNode(node: number): boolean {
  if (node < 0) return true;
  const k = T.d[(node << 5) + F_KIND] | 0;
  return k === K_PLAIN || k === K_QUOTE_DOUBLE || k === K_QUOTE_SINGLE || k === K_ALIAS || k === K_FLOW_MAPPING || k === K_FLOW_SEQUENCE;
}

function hasComments(node: number): boolean {
  return ((T.d[(node << 5) + F_FLAGS] | 0) & F_HAS_COMMENTS) !== 0;
}

/** All that is printed of it is what `printNode` prints. */
function isBare(node: number): boolean {
  return ((T.d[(node << 5) + F_FLAGS] | 0) & (F_HAS_COMMENTS | F_HAS_PROPS)) === 0;
}

/** `isEmptyNode` */
function isEmptyNode(node: number): boolean {
  return (T.d[(node << 5) + F_CH_LEN] | 0) === 0 && !hasComments(node);
}

/** `shouldPrintEndComments` */
function shouldPrintEndComments(node: number): boolean {
  if ((T.d[(node << 5) + F_EN_LEN] | 0) === 0) return false;
  const k = T.d[(node << 5) + F_KIND] | 0;
  return k !== K_DOCUMENT_HEAD && k !== K_DOCUMENT_BODY && k !== K_FLOW_MAPPING && k !== K_FLOW_SEQUENCE;
}

function firstChild(node: number): number {
  return (T.d[(node << 5) + F_CH_LEN] | 0) > 0 ? T.d[(node << 5) + F_CH_FIRST] | 0 : -1;
}

function parentOf(node: number): number {
  return T.d[(node << 5) + F_PARENT] | 0;
}

/** `getLastDescendantNode` */
function lastDescendant(nodeIn: number): number {
  let node = nodeIn;
  while ((T.d[(node << 5) + F_CH_LEN] | 0) > 0) node = T.d[(node << 5) + F_CH_LAST] | 0;
  return node;
}

function startAlign(width: number): void {
  out.startAlign(width);
}

function isBlockScalarKind(k: number): boolean {
  return k === K_BLOCK_FOLDED || k === K_BLOCK_LITERAL;
}

/** After it, `printNextEmptyLine` is nothing. */
function hasNoNextEmptyLine(id: number): void {
  const end = T.d[(id << 5) + F_E_OFF] | 0;
  if (end < printedEmptyLines.length) printedEmptyLines[end] = printedStamp | 0;
}

/** oxfmt's one rule for empty lines, between the parts of a stream: a line break, and an empty line if there is one in
 * front of `next` in the text. */
function printLineBreakBefore(next: number): void {
  out.hardLine();
  if (isPreviousLineEmpty(text, next)) out.hardLine();
}

/** `join(hardline, path.map(print, ..))`, for comments. */
function printComments(first: number, count: number): void {
  let c = first;
  for (let index = 0; index < count; index++) {
    if (index > 0) out.hardLine();
    // Of a comment, nobody asks whether it is the last.
    print(c, false);
    c = T.d[(c << 5) + F_NEXT] | 0;
  }
}

/** `join(hardline, path.map(print, "children"))` */
function printChildren(node: number, isLastDescendant: boolean): void {
  const n = T.d[(node << 5) + F_CH_LEN] | 0;
  const last = T.d[(node << 5) + F_CH_LAST] | 0;
  let c = T.d[(node << 5) + F_CH_FIRST] | 0;
  for (let index = 0; index < n; index++) {
    if (index > 0) out.hardLine();
    print(c, isLastDescendant && last === c);
    c = T.d[(c << 5) + F_NEXT] | 0;
  }
}

/** `isNextLineEmpty` */
function isNextLineEmpty(node: number): boolean {
  const end = T.d[(node << 5) + F_E_OFF] | 0;
  let i = end > 0 ? end - 1 : 0;
  // The rest of the line, whatever it is. Most of the time that is one character.
  while (i < textLen && (text[i] | 0) !== 10) i = i + 1;
  i = i + 1;
  for (;;) {
    while (i < textLen && (text[i] | 0) === 32) i = i + 1;
    const len = jsWhitespaceLen(text, i, textLen);
    if (len === 0) return false;
    if ((text[i] | 0) === 10) return true;
    i = i + len;
  }
}

/** `printNextEmptyLine`: whether it is a `softline`. */
function hasNextEmptyLine(node: number): boolean {
  const end = T.d[(node << 5) + F_E_OFF] | 0;
  if (end >= printedEmptyLines.length) return false;
  if ((printedEmptyLines[end] | 0) === (printedStamp | 0)) return false;
  printedEmptyLines[end] = printedStamp | 0;
  if (!isNextLineEmpty(node)) return false;
  const parent = parentOf(node);
  return !(parent >= 0 && shouldPrintEndComments(parent));
}

/** The text of a comment is `prettier-ignore` (or `oxfmt-ignore`) */
function isIgnoreComment(comment: number): boolean {
  const s = trimJsWhitespaceStart(text, T.d[(comment << 5) + F_V_START] | 0, T.d[(comment << 5) + F_V_END] | 0);
  const e = trimJsWhitespaceEnd(text, s, T.d[(comment << 5) + F_V_END] | 0);
  if (matchesAscii(s, e, "prettier-ignore")) return true;
  return matchesAscii(s, e, "oxfmt-ignore") && isOxfmt;
}

function matchesAscii(s: number, e: number, lit: string): boolean {
  const n = lit.length;
  if (e - s !== n) return false;
  for (let i = 0; i < n; i++) {
    if ((text[s + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** `hasPrettierIgnore` */
function hasPrettierIgnore(node: number): boolean {
  let last = -1;
  if ((T.d[(node << 5) + F_KIND] | 0) === K_DOCUMENT_BODY) {
    const document = parentOf(node);
    if (document < 0) return false;
    const head = firstChild(document);
    if (head < 0) return false;
    if ((T.d[(head << 5) + F_EN_LEN] | 0) > 0) last = T.d[(head << 5) + F_EN_LAST] | 0;
  } else if ((T.d[(node << 5) + F_LD_LEN] | 0) > 0) {
    last = T.d[(node << 5) + F_LD_LAST] | 0;
  }
  return last >= 0 && isIgnoreComment(last);
}

/** `out.text(buf, start, end)`; for an ASCII file the width is the length and nothing is looked at twice. */
function writeText(buf: Uint8Array, start: number, end: number): void {
  const len = end - start;
  if (len <= 0) return;
  if (!asciiFile || len > 96) {
    out.text(buf, start, end);
    return;
  }
  out.reserveTexts(len);
  const at = out.nt;
  const texts = out.texts;
  for (let i = 0; i < len; i++) texts[at + i] = buf[start + i] | 0;
  out.nt = at + len;
  out.addText(at, len, len);
}

/** What `print` does with most nodes: a scalar on one line or an alias, or the key or value that is nothing else. They are
 * groups with a text in them. Of anything else nothing is written. */
function printsText(node: number): boolean {
  if (!isBare(node)) return false;
  let scalar = node;
  const k = T.d[(node << 5) + F_KIND] | 0;
  if (k === K_MAPPING_KEY || k === K_MAPPING_VALUE || k === K_FLOW_SEQUENCE_ITEM) {
    const content = firstChild(node);
    if (content < 0 || !isBare(content)) return false;
    scalar = content;
  }
  const sk = T.d[(scalar << 5) + F_KIND] | 0;
  if (sk === K_ALIAS) {
    // fall through to the write
  } else if (
    (sk === K_PLAIN || sk === K_QUOTE_DOUBLE || sk === K_QUOTE_SINGLE) &&
    proseWrap === PROSE_WRAP_PRESERVE &&
    (T.d[(scalar << 5) + F_S_LINE] | 0) === (T.d[(scalar << 5) + F_E_LINE] | 0)
  ) {
    // fall through to the write
  } else {
    return false;
  }
  out.textGroup();
  printNode(scalar, false);
  return true;
}

// ---------------------------------------------------------------------------------------------- print

/** `genericPrint`. `isLastDescendant`: `isLastDescendantNode(path)`, for what is not a comment, a tag or an anchor. */
export function print(id: number, isLastDescendant: boolean): void {
  if (printsText(id)) return;
  if (!treeStack.enter()) return;
  printInner(id, isLastDescendant);
  treeStack.leave();
}

function printInner(node: number, isLastDescendant: boolean): void {
  const kind = T.d[(node << 5) + F_KIND] | 0;
  // Nothing around it: no comment, tag or anchor (the comment of a document body is in its head)
  if (((T.d[(node << 5) + F_FLAGS] | 0) & (F_HAS_COMMENTS | F_HAS_PROPS)) === 0 && kind !== K_DOCUMENT_BODY) {
    let hasNextEmptyLine1 = false;
    if (
      (kind === K_MAPPING || kind === K_SEQUENCE || kind === K_COMMENT || kind === K_DIRECTIVE || kind === K_MAPPING_ITEM || kind === K_SEQUENCE_ITEM) &&
      !(isLastDescendant && kind !== K_COMMENT)
    ) {
      hasNextEmptyLine1 = hasNextEmptyLine(node);
    }
    let ignored = false;
    if (isOxfmt) {
      // For oxfmt the comment is about one node: before a mapping or a sequence, about the first in it.
      if (kind === K_MAPPING || kind === K_SEQUENCE) {
        isFirstItemIgnored = false;
      } else if (kind === K_MAPPING_ITEM || kind === K_SEQUENCE_ITEM) {
        ignored = isFirstItemIgnored;
        isFirstItemIgnored = false;
      }
    }
    if (ignored) {
      printIgnored(node);
    } else {
      out.startPlainGroup(false);
      printNode(node, isLastDescendant);
      out.endGroup();
    }
    if (hasNextEmptyLine1) out.line(LINE_SOFT);
    return;
  }
  if (kind !== K_MAPPING_VALUE && (T.d[(node << 5) + F_LD_LEN] | 0) > 0) {
    printComments(T.d[(node << 5) + F_LD_FIRST] | 0, T.d[(node << 5) + F_LD_LEN] | 0);
    out.hardLine();
  }
  let tag = T.d[(node << 5) + F_TAG] | 0;
  let anchor = T.d[(node << 5) + F_ANCHOR] | 0;
  if (isOxfmt && tag >= 0 && anchor >= 0 && (T.d[(anchor << 5) + F_S_OFF] | 0) < (T.d[(tag << 5) + F_S_OFF] | 0)) {
    const t = tag;
    tag = anchor;
    anchor = t;
  }
  let nProps = 0;
  if (tag >= 0) {
    print(tag, false);
    nProps = 1;
  }
  if (anchor >= 0) {
    if (nProps > 0) out.token(" ");
    print(anchor, false);
  }

  let hasNextEmpty = false;
  if (
    (kind === K_MAPPING || kind === K_SEQUENCE || kind === K_COMMENT || kind === K_DIRECTIVE || kind === K_MAPPING_ITEM || kind === K_SEQUENCE_ITEM) &&
    !(isLastDescendant && kind !== K_COMMENT)
  ) {
    hasNextEmpty = hasNextEmptyLine(node);
  }

  if ((T.d[(node << 5) + F_TAG] | 0) >= 0 || (T.d[(node << 5) + F_ANCHOR] | 0) >= 0) {
    if ((kind === K_SEQUENCE || kind === K_MAPPING) && (T.d[(node << 5) + F_MD_LEN] | 0) === 0) out.hardLine();
    else out.token(" ");
  }
  if ((T.d[(node << 5) + F_MD_LEN] | 0) > 0) {
    if ((T.d[(node << 5) + F_MD_LEN] | 0) !== 1) out.hardLine();
    printComments(T.d[(node << 5) + F_MD_FIRST] | 0, T.d[(node << 5) + F_MD_LEN] | 0);
    out.hardLine();
  }

  let isIgnored = hasPrettierIgnore(node);
  if (isOxfmt) {
    // For oxfmt the comment is about one node: before a mapping or a sequence, about the first in it.
    if (kind === K_MAPPING || kind === K_SEQUENCE) {
      isFirstItemIgnored = isIgnored;
      isIgnored = false;
    } else if (kind === K_MAPPING_ITEM || kind === K_SEQUENCE_ITEM) {
      isIgnored = isIgnored || isFirstItemIgnored;
      isFirstItemIgnored = false;
    }
  }
  if (isIgnored) {
    printIgnored(node);
  } else {
    out.startPlainGroup(false);
    printNode(node, isLastDescendant);
    out.endGroup();
  }

  const trailingComment = T.d[(node << 5) + F_TRAILING] | 0;
  if (trailingComment >= 0 && kind !== K_DOCUMENT && kind !== K_DOCUMENT_HEAD && (commentInBrackets < 0 || commentInBrackets !== trailingComment)) {
    const parent = parentOf(node);
    let isKeyOfMapping = false;
    if (parent >= 0 && (T.d[(parent << 5) + F_KIND] | 0) === K_MAPPING_KEY) {
      const item = parentOf(parent);
      const mapping = item >= 0 ? parentOf(item) : -1;
      isKeyOfMapping = mapping >= 0 && ((T.d[(mapping << 5) + F_KIND] | 0) === K_MAPPING || isOxfmt);
    }
    out.startLineSuffix();
    if (!(kind === K_MAPPING_VALUE && (T.d[(node << 5) + F_CH_LEN] | 0) === 0)) out.token(" ");
    if (!(isKeyOfMapping && isInlineNode(node))) out.breakParent();
    if (isOxfmt) hasNoNextEmptyLine(trailingComment);
    print(trailingComment, false);
    out.endLineSuffix();
  }

  if (shouldPrintEndComments(node)) {
    const isAligned = kind === K_SEQUENCE_ITEM;
    if (isAligned) startAlign(2);
    let c = T.d[(node << 5) + F_EN_FIRST] | 0;
    for (let n = T.d[(node << 5) + F_EN_LEN] | 0; n > 0; n = n - 1) {
      out.hardLine();
      if (isPreviousLineEmpty(text, T.d[(c << 5) + F_S_OFF] | 0)) out.hardLine();
      print(c, false);
      c = T.d[(c << 5) + F_NEXT] | 0;
    }
    if (isAligned) out.endIndent();
  }
  if (hasNextEmpty) out.line(LINE_SOFT);
}

/** A node that is as it is written: `replaceEndOfLine` */
function printIgnored(node: number): void {
  const s = T.d[(node << 5) + F_S_OFF] | 0;
  const e = trimJsWhitespaceEnd(text, s, T.d[(node << 5) + F_E_OFF] | 0);
  let lineStart = s;
  let index = 0;
  for (let i = s; i <= e; i++) {
    if (i === e || (text[i] | 0) === 10) {
      if (index > 0) {
        out.line(LINE_LITERAL);
        out.breakParent();
      }
      out.text(text, lineStart, i);
      lineStart = i + 1;
      index = index + 1;
    }
  }
}

function isAsciiWhitespaceByte(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 12 || b === 13;
}

function printNode(node: number, isLastDescendant: boolean): void {
  const kind = T.d[(node << 5) + F_KIND] | 0;
  switch (kind) {
    case K_ROOT:
      printRoot(node);
      break;
    case K_DOCUMENT:
      printDocument(node, isLastDescendant);
      break;
    case K_DOCUMENT_HEAD:
      printChildren(node, isLastDescendant);
      if ((T.d[(node << 5) + F_CH_LEN] | 0) > 0 && (T.d[(node << 5) + F_EN_LEN] | 0) > 0) out.hardLine();
      printComments(T.d[(node << 5) + F_EN_FIRST] | 0, T.d[(node << 5) + F_EN_LEN] | 0);
      break;
    case K_DOCUMENT_BODY:
      printDocumentBody(node, isLastDescendant);
      break;
    case K_DIRECTIVE: {
      // The name without the `%`, and the parameters.
      out.token("%");
      const e = trimJsWhitespaceEnd(text, T.d[(node << 5) + F_V_START] | 0, T.d[(node << 5) + F_V_END] | 0);
      let i = trimJsWhitespaceStart(text, T.d[(node << 5) + F_V_START] | 0, e);
      let index = 0;
      while (i < e) {
        while (i < e && ((text[i] | 0) === 32 || (text[i] | 0) === 9)) i = i + 1;
        if (i >= e) break;
        const s = i;
        while (i < e && (text[i] | 0) !== 32 && (text[i] | 0) !== 9) i = i + 1;
        if (index > 0) out.token(" ");
        if (index === 0 && (text[s] | 0) === 37) out.text(text, s + 1, i);
        else out.text(text, s, i);
        index = index + 1;
      }
      break;
    }
    case K_COMMENT:
      out.token("#");
      writeText(text, T.d[(node << 5) + F_V_START] | 0, T.d[(node << 5) + F_V_END] | 0);
      break;
    case K_ALIAS:
      out.token("*");
      writeText(text, T.d[(node << 5) + F_V_START] | 0, T.d[(node << 5) + F_V_END] | 0);
      break;
    case K_TAG:
      writeText(text, T.d[(node << 5) + F_S_OFF] | 0, T.d[(node << 5) + F_E_OFF] | 0);
      break;
    case K_ANCHOR:
      out.token("&");
      writeText(text, T.d[(node << 5) + F_V_START] | 0, T.d[(node << 5) + F_V_END] | 0);
      break;
    case K_PLAIN:
      printFlowScalarContent(node, text, T.d[(node << 5) + F_S_OFF] | 0, T.d[(node << 5) + F_E_OFF] | 0);
      break;
    case K_QUOTE_DOUBLE:
    case K_QUOTE_SINGLE:
      printQuoted(node);
      break;
    case K_BLOCK_FOLDED:
    case K_BLOCK_LITERAL:
      printBlock(node, isLastDescendant);
      break;
    case K_MAPPING:
    case K_SEQUENCE:
      printChildren(node, isLastDescendant);
      break;
    case K_SEQUENCE_ITEM: {
      out.token("- ");
      startAlign(2);
      const content = firstChild(node);
      if (content >= 0) print(content, isLastDescendant);
      out.endIndent();
      break;
    }
    case K_MAPPING_KEY:
    case K_MAPPING_VALUE:
    case K_FLOW_SEQUENCE_ITEM: {
      const content = firstChild(node);
      if (content >= 0) print(content, isLastDescendant);
      break;
    }
    case K_MAPPING_ITEM:
    case K_FLOW_MAPPING_ITEM:
      printMappingItem(node, isLastDescendant);
      break;
    default:
      // K_FLOW_MAPPING, K_FLOW_SEQUENCE
      printFlowMapping(node, isLastDescendant);
      break;
  }
}

function isBlockKeep(node: number): boolean {
  return isBlockScalarKind(T.d[(node << 5) + F_KIND] | 0) && (((T.d[(node << 5) + F_FLAGS] | 0) >> 1) & 3) === CH_KEEP;
}

function chompingOf(node: number): number {
  return ((T.d[(node << 5) + F_FLAGS] | 0) >> 1) & 3;
}

function printRoot(node: number): void {
  const last = lastDescendant(node);
  let shouldPrintHardline = !isBlockKeep(last);
  if (!shouldPrintHardline && isOxfmt) {
    // For oxfmt a file ends with a line break, and here none has been kept.
    const s = T.d[(last << 5) + F_S_OFF] | 0;
    const e = T.d[(last << 5) + F_E_OFF] | 0;
    let nl = -1;
    for (let i = s; i < e; i++) {
      if ((text[i] | 0) === 10) {
        nl = i;
        break;
      }
    }
    if (nl < 0) shouldPrintHardline = true;
    else {
      let allSpaces = true;
      for (let i = nl + 1; i < e; i++) {
        if ((text[i] | 0) !== 32) {
          allSpaces = false;
          break;
        }
      }
      shouldPrintHardline = allSpaces;
    }
  }
  let keepsLineBreaks = false;
  let document = firstChild(node);
  for (let index = 0, n = T.d[(node << 5) + F_CH_LEN] | 0; index < n; index++) {
    if (index > 0) {
      if (isOxfmt && !keepsLineBreaks) printLineBreakBefore(startOfDocument(document));
      else out.hardLine();
    }
    const next = T.d[(document << 5) + F_NEXT] | 0;
    isLastDocument = next < 0;
    // For oxfmt, what is between two documents is not up to what is in them.
    print(document, isLastDocument || isOxfmt);
    const lastOfDocument = lastDescendant(document);
    keepsLineBreaks = isBlockKeep(lastOfDocument);
    if (shouldPrintDocumentEndMarker(document, next)) {
      keepsLineBreaks = false;
      if (shouldPrintHardline && !(isOxfmt && isEmptyDocument(document))) out.hardLine();
      out.token("...");
      const comment = T.d[(document << 5) + F_TRAILING] | 0;
      if (comment >= 0) {
        out.token(" ");
        print(comment, false);
      }
    }
    document = next;
  }
  if (shouldPrintHardline) out.hardLine();
}

function printDocument(node: number, isLastDescendant: boolean): void {
  if ((T.d[(node << 5) + F_CH_LEN] | 0) !== 2) return;
  const head = T.d[(node << 5) + F_CH_FIRST] | 0;
  const body = T.d[(node << 5) + F_CH_LAST] | 0;
  let hasHead = false;
  // At the start of a line, where Prettier puts it, it would be a marker.
  let looksLikeMarker = false;
  const content = firstChild(body);
  if (content >= 0 && (T.d[(content << 5) + F_KIND] | 0) === K_PLAIN && (T.d[(content << 5) + F_TAG] | 0) < 0 && (T.d[(content << 5) + F_ANCHOR] | 0) < 0 && (T.d[(content << 5) + F_LD_LEN] | 0) === 0) {
    const s = T.d[(content << 5) + F_S_OFF] | 0;
    const e = T.d[(content << 5) + F_E_OFF] | 0;
    if (e - s >= 3) {
      const b0 = text[s] | 0;
      if ((b0 === 45 || b0 === 46) && (text[s + 1] | 0) === b0 && (text[s + 2] | 0) === b0) {
        looksLikeMarker = e - s === 3 || isAsciiWhitespaceByte(text[s + 3] | 0);
      }
    }
  }
  const headTrailing = T.d[(head << 5) + F_TRAILING] | 0;
  // `shouldPrintDocumentHeadEndMarker`
  if (
    (((T.d[(node << 5) + F_FLAGS] | 0) & 8) !== 0) ||
    looksLikeMarker ||
    (T.d[(head << 5) + F_CH_LEN] | 0) !== 0 ||
    (T.d[(head << 5) + F_EN_LEN] | 0) !== 0 ||
    headTrailing >= 0
  ) {
    if ((T.d[(head << 5) + F_CH_LEN] | 0) !== 0 || (T.d[(head << 5) + F_EN_LEN] | 0) !== 0) {
      print(head, isLastDescendant);
      out.hardLine();
    }
    out.token("---");
    if (headTrailing >= 0) {
      out.token(" ");
      print(headTrailing, false);
    }
    hasHead = true;
  }
  if ((T.d[(body << 5) + F_CH_LEN] | 0) !== 0 || (T.d[(body << 5) + F_EN_LEN] | 0) !== 0) {
    if (hasHead && (!looksLikeMarker || headTrailing >= 0)) out.hardLine();
    if (looksLikeMarker) out.token(" ");
    print(body, isLastDescendant);
  }
}

function printDocumentBody(node: number, isLastDescendant: boolean): void {
  printChildren(node, isLastDescendant);
  if ((T.d[(node << 5) + F_CH_LEN] | 0) > 0 && (T.d[(node << 5) + F_EN_LEN] | 0) > 0) {
    const lastChild = T.d[(node << 5) + F_CH_LAST] | 0;
    const firstComment = T.d[(node << 5) + F_EN_FIRST] | 0;
    const last = lastDescendant(node);
    const start = T.d[(firstComment << 5) + F_S_OFF] | 0;
    const isBlock = isBlockScalarKind(T.d[(last << 5) + F_KIND] | 0);
    let hardLines = 0;
    if (isOxfmt && !hasNewlineBackwards(text, start)) {
      // It stays on its line. Behind a tag or an anchor that nothing follows there is a blank.
      if ((T.d[(last << 5) + F_E_OFF] | 0) > (T.d[(last << 5) + F_S_OFF] | 0)) out.token(" ");
      hardLines = 0;
    } else if (isOxfmt && !(isBlock && chompingOf(last) === CH_KEEP)) {
      hardLines = 1 + (isPreviousLineEmpty(text, start) ? 1 : 0);
    } else if (isBlock) {
      // There is a line break at the end of a block scalar that keeps its line breaks.
      hardLines = chompingOf(last) === CH_KEEP ? 0 : 2;
    } else {
      const keepsEmptyLine = (T.d[(lastChild << 5) + F_KIND] | 0) === K_MAPPING && isPreviousLineEmpty(text, start);
      hardLines = keepsEmptyLine ? 2 : 1;
    }
    for (let i = 0; i < hardLines; i++) out.hardLine();
  }
  if (isOxfmt && (T.d[(node << 5) + F_EN_LEN] | 0) > 0) hasNoNextEmptyLine(T.d[(node << 5) + F_EN_LAST] | 0);
  printComments(T.d[(node << 5) + F_EN_FIRST] | 0, T.d[(node << 5) + F_EN_LEN] | 0);
}

/** Where the first of what is printed of a document is in the text. */
function startOfDocument(document: number): number {
  let start = T.d[(document << 5) + F_S_OFF] | 0;
  const head = firstChild(document);
  if (head < 0) return start;
  if ((T.d[(head << 5) + F_CH_LEN] | 0) > 0) {
    const o = T.d[((T.d[(head << 5) + F_CH_FIRST] | 0) << 5) + F_S_OFF] | 0;
    if (o < start) start = o;
  }
  if ((T.d[(head << 5) + F_EN_LEN] | 0) > 0) {
    const o = T.d[((T.d[(head << 5) + F_EN_FIRST] | 0) << 5) + F_S_OFF] | 0;
    if (o < start) start = o;
  }
  return start;
}

/** Nothing is printed of it but its end. */
function isEmptyDocument(document: number): boolean {
  if (((T.d[(document << 5) + F_FLAGS] | 0) & 8) !== 0) return false;
  let part = T.d[(document << 5) + F_CH_FIRST] | 0;
  for (let n = T.d[(document << 5) + F_CH_LEN] | 0; n > 0; n = n - 1) {
    if ((T.d[(part << 5) + F_CH_LEN] | 0) !== 0 || (T.d[(part << 5) + F_EN_LEN] | 0) !== 0 || (T.d[(part << 5) + F_TRAILING] | 0) >= 0) return false;
    part = T.d[(part << 5) + F_NEXT] | 0;
  }
  return true;
}

/** `shouldPrintDocumentEndMarker`. `next`: the next document, or -1. */
function shouldPrintDocumentEndMarker(document: number, next: number): boolean {
  if (((T.d[(document << 5) + F_FLAGS] | 0) & 16) !== 0 || (T.d[(document << 5) + F_TRAILING] | 0) >= 0) return true;
  // For oxfmt, comments between two documents are no reason for a `...` that is not there.
  if (next < 0) return false;
  const head = firstChild(next);
  if (head < 0) return false;
  return (T.d[(head << 5) + F_CH_LEN] | 0) !== 0 || (!isOxfmt && (T.d[(head << 5) + F_EN_LEN] | 0) !== 0);
}

// ---------------------------------------------------------------------------------------------- scalars

function growW(): void {
  const n = wS.length * 2;
  const a = new Int32Array(n);
  a.set(wS);
  wS = a;
  const b = new Int32Array(n);
  b.set(wE);
  wE = b;
}

function pushWord(s: number, e: number): void {
  if (nW === wS.length) growW();
  wS[nW] = s | 0;
  wE[nW] = e | 0;
  nW = ((nW | 0) + 1) | 0;
}

function pushLine(first: number, count: number, kind: number): void {
  if (nLn === lnFirst.length) {
    const n = nLn * 2;
    const a = new Int32Array(n);
    a.set(lnFirst);
    lnFirst = a;
    const b = new Int32Array(n);
    b.set(lnCount);
    lnCount = b;
    const c = new Uint8Array(n);
    c.set(lnKind);
    lnKind = c;
  }
  lnFirst[nLn] = first | 0;
  lnCount[nLn] = count | 0;
  lnKind[nLn] = kind | 0;
  nLn = ((nLn | 0) + 1) | 0;
}

function pushRawLine(s: number, e: number): void {
  if (nRl === rlS.length) {
    const n = nRl * 2;
    const a = new Int32Array(n);
    a.set(rlS);
    rlS = a;
    const b = new Int32Array(n);
    b.set(rlE);
    rlE = b;
  }
  rlS[nRl] = s | 0;
  rlE[nRl] = e | 0;
  nRl = ((nRl | 0) + 1) | 0;
}

/** `splitWithSingleSpace`: `" a   b c   d e   f "` is `[" a   b", "c   d", "e   f "]`. Pushes the words. */
function splitWithSingleSpace(buf: Uint8Array, s: number, e: number): void {
  if (e <= s) return;
  let start = s;
  for (let i = s + 1; i < e - 1; i++) {
    if ((buf[i] | 0) === 32 && (buf[i - 1] | 0) !== 32 && (buf[i + 1] | 0) !== 32) {
      pushWord(start, i);
      start = i + 1;
    }
  }
  pushWord(start, e);
}

/** `fill(join(line, words))` of line `i` */
function writeFill(i: number): void {
  const kind = lnKind[i] | 0;
  if (kind === LK_NONE) return;
  const first = lnFirst[i] | 0;
  const count = lnCount[i] | 0;
  if (kind === LK_ONE) {
    // Nothing is to be filled with one word.
    writeText(wBuf, wS[first] | 0, wE[first] | 0);
    return;
  }
  if (kind === LK_SLICES) {
    out.startFill();
    for (let k = 0; k < count; k++) {
      if (k > 0) {
        out.startItem();
        out.line(LINE_SPACE);
        out.endItem();
      }
      out.startItem();
      writeText(wBuf, wS[first + k] | 0, wE[first + k] | 0);
      out.endItem();
    }
    out.endFill();
    return;
  }
  // LK_JOINED
  joinBuf.reset();
  for (let k = 0; k < count; k++) {
    if (k > 0) joinBuf.push(32);
    joinBuf.append(wBuf, wS[first + k] | 0, wE[first + k] | 0);
  }
  out.startFill();
  out.startItem();
  out.text(joinBuf.data, 0, joinBuf.len);
  out.endItem();
  out.endFill();
}

/** `Words::is_empty` */
function lineIsEmpty(i: number): boolean {
  const kind = lnKind[i] | 0;
  return kind === LK_NONE || (kind === LK_SLICES && (lnCount[i] | 0) === 0);
}

function wordEndsWithBlank(k: number): boolean {
  const s = wS[k] | 0;
  const e = wE[k] | 0;
  return trimJsWhitespaceEnd(wBuf, s, e) < e;
}

/** `printFlowScalarContent`: the content is buf[start, end). */
function printFlowScalarContent(node: number, buf: Uint8Array, start: number, end: number): void {
  // Most are one line that stays as it is.
  if (proseWrap === PROSE_WRAP_PRESERVE && (T.d[(node << 5) + F_S_LINE] | 0) === (T.d[(node << 5) + F_E_LINE] | 0)) {
    writeText(buf, start, end);
    return;
  }
  flowScalarLineContents(T.d[(node << 5) + F_KIND] | 0, buf, start, end);
  for (let index = 0; index < nLn; index++) {
    if (index > 0) out.hardLine();
    writeFill(index);
  }
}

/** `getFlowScalarLineContents` */
function flowScalarLineContents(kind: number, buf: Uint8Array, start: number, end: number): void {
  wBuf = buf;
  nW = 0;
  nLn = 0;
  nRl = 0;
  // The raw lines
  let ls = start;
  for (let i = start; i <= end; i++) {
    if (i === end || (buf[i] | 0) === 10) {
      pushRawLine(ls, i);
      ls = i + 1;
    }
  }
  const count = nRl;
  for (let index = 0; index < count; index++) {
    const first = index === 0;
    const last = index + 1 === count;
    let s = rlS[index] | 0;
    let e = rlE[index] | 0;
    if (!first) s = trimJsWhitespaceStart(buf, s, e);
    if (!last) e = trimJsWhitespaceEnd(buf, s, e);
    rlS[index] = s;
    rlE[index] = e;
  }
  if (proseWrap === PROSE_WRAP_PRESERVE) {
    for (let index = 0; index < count; index++) {
      const s = rlS[index] | 0;
      const e = rlE[index] | 0;
      if (e <= s) {
        pushLine(nW, 0, LK_NONE);
      } else {
        pushLine(nW, 1, LK_ONE);
        pushWord(s, e);
      }
    }
    return;
  }
  for (let index = 0; index < count; index++) {
    const wordsStart = nW;
    splitWithSingleSpace(buf, rlS[index] | 0, rlE[index] | 0);
    const nNew = nW - wordsStart;
    let merge = false;
    if (nLn > 0 && index > 0 && (rlE[index - 1] | 0) > (rlS[index - 1] | 0) && nNew > 0) {
      merge = true;
      if (kind === K_QUOTE_DOUBLE && (lnCount[nLn - 1] | 0) > 0) {
        // A backslash at the end of a line in double quotes stays there.
        const lastWordEnd = wE[wordsStart - 1] | 0;
        const lastWordStart = wS[wordsStart - 1] | 0;
        if (lastWordEnd > lastWordStart && (buf[lastWordEnd - 1] | 0) === 92) merge = false;
      }
    }
    if (merge) lnCount[nLn - 1] = ((lnCount[nLn - 1] | 0) + nNew) | 0;
    else pushLine(wordsStart, nNew, LK_SLICES);
  }
  if (proseWrap === PROSE_WRAP_NEVER) {
    for (let i = 0; i < nLn; i++) lnKind[i] = LK_JOINED;
  }
}

/** `printQuoted` */
function printQuoted(node: number): void {
  const s = T.d[(node << 5) + F_S_OFF] | 0;
  const e = T.d[(node << 5) + F_E_OFF] | 0;
  const rs = s + 1;
  const re = e > s ? e - 1 : e;
  const isDouble = (T.d[(node << 5) + F_KIND] | 0) === K_QUOTE_DOUBLE;
  let hasBackslash = false;
  let hasEscape = false;
  let hasDoubleQuote = false;
  let hasSingleQuote = false;
  for (let i = rs; i < re; i++) {
    const b = text[i] | 0;
    if (b === 92) {
      hasBackslash = true;
      if (i + 1 < re && (text[i + 1] | 0) !== 34) hasEscape = true;
    } else if (b === 34) hasDoubleQuote = true;
    else if (b === 39) hasSingleQuote = true;
  }
  let quote = 34;
  let buf: Uint8Array = text;
  let cs = rs;
  let ce = re;
  if ((!isDouble && hasBackslash) || (isDouble && hasEscape)) {
    // Only in double quotes are there escapes, and in single quotes a backslash needs none.
    quote = isDouble ? 34 : 39;
  } else if (hasDoubleQuote) {
    if (isDouble) {
      // `.replaceAll('\\"', '"').replaceAll("'", "''")`
      contentBuf.reset();
      let i = rs;
      while (i < re) {
        const b = text[i] | 0;
        if (b === 92 && i + 1 < re && (text[i + 1] | 0) === 34) {
          contentBuf.push(34);
          i = i + 1;
        } else if (b === 39) {
          contentBuf.push(39);
          contentBuf.push(39);
        } else {
          contentBuf.push(b);
        }
        i = i + 1;
      }
      buf = contentBuf.data;
      cs = 0;
      ce = contentBuf.len;
    }
    quote = 39;
  } else if (hasSingleQuote) {
    if (!isDouble) {
      // `.replaceAll("''", "'")`
      contentBuf.reset();
      let i = rs;
      while (i < re) {
        const b = text[i] | 0;
        contentBuf.push(b);
        i = i + (b === 39 && i + 1 < re && (text[i + 1] | 0) === 39 ? 2 : 1);
      }
      buf = contentBuf.data;
      cs = 0;
      ce = contentBuf.len;
    }
    quote = 34;
  } else {
    quote = singleQuote ? 39 : 34;
  }
  const q = quote === 34 ? '"' : "'";
  out.token(q);
  printFlowScalarContent(node, buf, cs, ce);
  out.token(q);
}

/** `getBlockValueLineContents`: the lines are in `ln*`. */
function blockValueLineContents(node: number, parentIndent: number, isLastDescendant: boolean): void {
  wBuf = text;
  nW = 0;
  nLn = 0;
  nRl = 0;
  if ((T.d[(node << 5) + F_S_LINE] | 0) === (T.d[(node << 5) + F_E_LINE] | 0)) return;
  // Without the line of the `>` or `|`.
  const sourceStart = T.d[(node << 5) + F_S_OFF] | 0;
  const sourceEnd = T.d[(node << 5) + F_E_OFF] | 0;
  let contentStart = -1;
  for (let i = sourceStart; i < sourceEnd; i++) {
    if ((text[i] | 0) === 10) {
      contentStart = i + 1;
      break;
    }
  }
  if (contentStart < 0 || contentStart >= sourceEnd) return;
  const contentEnd = sourceEnd;
  const chomping = chompingOf(node);
  const indent = T.d[(node << 5) + F_INDENT];
  let leadingSpaceCount = 0;
  if (indent < 0) {
    // `/^(?<leadingSpace> *)[^\n\r ]/m`
    leadingSpaceCount = 2147483647;
    let ls = contentStart;
    for (let i = contentStart; i <= contentEnd; i++) {
      if (i === contentEnd || (text[i] | 0) === 10) {
        let spaces = 0;
        while (ls + spaces < i && (text[ls + spaces] | 0) === 32) spaces = spaces + 1;
        if (spaces < i - ls) {
          leadingSpaceCount = spaces;
          break;
        }
        ls = i + 1;
      }
    }
  } else {
    const v = indent + parentIndent - 1;
    leadingSpaceCount = v > 0 ? v : 0;
  }
  // The raw lines, without what is cut
  let ls = contentStart;
  for (let i = contentStart; i <= contentEnd; i++) {
    if (i === contentEnd || (text[i] | 0) === 10) {
      const lineLen = i - ls;
      if (leadingSpaceCount > lineLen) pushRawLine(i, i);
      else pushRawLine(ls + leadingSpaceCount, i);
      ls = i + 1;
    }
  }
  const nRaw = nRl;
  if (proseWrap === PROSE_WRAP_PRESERVE || (T.d[(node << 5) + F_KIND] | 0) === K_BLOCK_LITERAL) {
    for (let index = 0; index < nRaw; index++) {
      const s = rlS[index] | 0;
      const e = rlE[index] | 0;
      if (e <= s) {
        pushLine(nW, 0, LK_NONE);
      } else {
        pushLine(nW, 1, LK_ONE);
        pushWord(s, e);
      }
    }
  } else {
    for (let index = 0; index < nRaw; index++) {
      const lineS = rlS[index] | 0;
      const lineE = rlE[index] | 0;
      const wordsStart = nW;
      if (isOxfmt && startsWithWhiteSpace(text, lineS, lineE)) pushWord(lineS, lineE);
      else splitWithSingleSpace(text, lineS, lineE);
      const nNew = nW - wordsStart;
      let merge = false;
      if (nLn > 0 && index > 0 && nNew > 0 && (rlE[index - 1] | 0) > (rlS[index - 1] | 0)) {
        // The test is made with the words joined by commas.
        const lastCount = lnCount[nLn - 1] | 0;
        const lastFirst = lnFirst[nLn - 1] | 0;
        merge = true;
        if (startsWithWhiteSpace(text, wS[wordsStart] | 0, wE[wordsStart] | 0)) merge = false;
        if (merge && lastCount > 0 && startsWithWhiteSpace(text, wS[lastFirst] | 0, wE[lastFirst] | 0)) merge = false;
        if (merge && lastCount > 0 && wordEndsWithBlank(lastFirst + lastCount - 1)) merge = false;
      }
      if (merge) lnCount[nLn - 1] = ((lnCount[nLn - 1] | 0) + nNew) | 0;
      else pushLine(wordsStart, nNew, LK_SLICES);
    }
    // No white space at the end of a line: a word that ends with some takes the next one along.
    for (let li = 0; li < nLn; li++) {
      const first = lnFirst[li] | 0;
      const count = lnCount[li] | 0;
      let needsMerging = false;
      for (let k = 0; k < count - 1; k++) {
        if (wordEndsWithBlank(first + k)) {
          needsMerging = true;
          break;
        }
      }
      if (!needsMerging && proseWrap !== PROSE_WRAP_NEVER) continue;
      // For Prettier the empty lines at the end of a scalar that keeps them are lines with an empty word here, so it does
      // not take the last for the line break that ends the scalar, and there is one more.
      if (count === 0 && chomping === CH_KEEP) {
        lnKind[li] = LK_NONE;
        continue;
      }
      if (proseWrap === PROSE_WRAP_NEVER) {
        lnKind[li] = LK_JOINED;
        continue;
      }
      // The words are next to each other in the text, with one space in between.
      let w = first;
      for (let k = 0; k < count; k++) {
        const ws = wS[first + k] | 0;
        const we = wE[first + k] | 0;
        if (w > first && wordEndsWithBlank(w - 1)) {
          wE[w - 1] = we;
        } else {
          wS[w] = ws;
          wE[w] = we;
          w = w + 1;
        }
      }
      lnCount[li] = w - first;
    }
  }

  // `removeUnnecessaryTrailingNewlines`
  if (chomping === CH_KEEP) {
    if (((text[contentEnd - 1] | 0) === 10 || isOxfmt) && nLn > 0 && lineIsEmpty(nLn - 1)) nLn = nLn - 1;
    return;
  }
  let trailingNewlineCount = 0;
  for (let li = nLn - 1; li >= 0; li--) {
    if (!lineIsBlank(li)) break;
    trailingNewlineCount = trailingNewlineCount + 1;
  }
  let removed = trailingNewlineCount;
  if (trailingNewlineCount >= 2 && !isLastDescendant) removed = trailingNewlineCount - 1;
  nLn = nLn - removed;
}

function wordIsBlank(s: number, e: number): boolean {
  if (isOxfmt) return e <= s;
  for (let i = s; i < e; i++) {
    const b = wBuf[i] | 0;
    if (b !== 32 && b !== 9) return false;
  }
  return true;
}

function lineIsBlank(li: number): boolean {
  const kind = lnKind[li] | 0;
  if (kind === LK_NONE) return true;
  const first = lnFirst[li] | 0;
  const count = lnCount[li] | 0;
  if (kind === LK_ONE) return wordIsBlank(wS[first] | 0, wE[first] | 0);
  if (kind === LK_SLICES) {
    for (let k = 0; k < count; k++) {
      if (!wordIsBlank(wS[first + k] | 0, wE[first + k] | 0)) return false;
    }
    return true;
  }
  // LK_JOINED: the words joined with a blank
  if (isOxfmt) return count === 0 || (count === 1 && (wE[first] | 0) <= (wS[first] | 0));
  for (let k = 0; k < count; k++) {
    if (!wordIsBlank(wS[first + k] | 0, wE[first + k] | 0)) return false;
  }
  return true;
}

/** `printBlock` */
function printBlock(node: number, isLastDescendant: boolean): void {
  let parentIndent = 0;
  let ancestor = parentOf(node);
  while (ancestor >= 0) {
    const k = T.d[(ancestor << 5) + F_KIND] | 0;
    if (k === K_SEQUENCE || k === K_MAPPING) parentIndent = parentIndent + 1;
    ancestor = parentOf(ancestor);
  }
  const kind = T.d[(node << 5) + F_KIND] | 0;
  out.token(kind === K_BLOCK_FOLDED ? ">" : "|");
  const indent = T.d[(node << 5) + F_INDENT];
  if (indent >= 0) out.token(String(indent));
  const chomping = chompingOf(node);
  if (chomping === CH_KEEP) out.token("+");
  else if (chomping === CH_STRIP) out.token("-");
  const comment = T.d[(node << 5) + F_INDICATOR] | 0;
  if (comment >= 0) {
    // oxfmt does not count it when it asks whether the `|` fits behind the key.
    if (isOxfmt) out.startLineSuffix();
    out.token(" ");
    print(comment, false);
    if (isOxfmt) out.endLineSuffix();
  }
  blockValueLineContents(node, parentIndent, isLastDescendant);
  if (indent < 0) {
    out.startDedent();
    startAlign(tabWidth);
  } else {
    out.startDedentToRoot();
    const w = indent + parentIndent - 1;
    startAlign(w > 0 ? w : 0);
  }
  const n = nLn;
  for (let index = 0; index < n; index++) {
    if (index === 0) out.hardLine();
    writeFill(index);
    const isEmpty = lineIsEmpty(index);
    if (isOxfmt && !isEmpty) out.keepBlanks();
    if (index + 1 !== n) {
      if (isEmpty) {
        out.hardLine();
      } else {
        out.startMarkAsRoot();
        out.line(LINE_LITERAL);
        out.breakParent();
        out.endIndent();
      }
    } else if (chomping === CH_KEEP && isLastDescendant && isLastDocument && keyDepth === 0) {
      out.startDedentToRoot();
      if (isEmpty) {
        out.hardLine();
      } else {
        out.line(LINE_LITERAL);
        out.breakParent();
      }
      out.endIndent();
    }
  }
  out.endIndent();
  out.endIndent();
}

// ---------------------------------------------------------------------------------------------- flow collections

/** `printFlowMapping` and `printFlowSequence` */
function printFlowMapping(node: number, isLastDescendant: boolean): void {
  const isMapping = (T.d[(node << 5) + F_KIND] | 0) === K_FLOW_MAPPING;
  const hasChildren = (T.d[(node << 5) + F_CH_LEN] | 0) > 0;
  const lineKind = isMapping && hasChildren && bracketSpacing ? LINE_SPACE : LINE_SOFT;
  let isLastItemEmptyMappingItem = false;
  if (hasChildren) {
    const last = T.d[(node << 5) + F_CH_LAST] | 0;
    if ((T.d[(last << 5) + F_KIND] | 0) === K_FLOW_MAPPING_ITEM) {
      isLastItemEmptyMappingItem = true;
      let c = T.d[(last << 5) + F_CH_FIRST] | 0;
      for (let n = T.d[(last << 5) + F_CH_LEN] | 0; n > 0; n = n - 1) {
        if (!isEmptyNode(c)) {
          isLastItemEmptyMappingItem = false;
          break;
        }
        c = T.d[(c << 5) + F_NEXT] | 0;
      }
    }
  }
  out.token(isMapping ? "{" : "[");
  startAlign(tabWidth);
  out.line(lineKind);
  if (commentInBrackets >= 0 && commentInBracketsStart === (T.d[(node << 5) + F_S_OFF] | 0)) {
    const comment = commentInBrackets;
    commentInBrackets = -1;
    hasNoNextEmptyLine(comment);
    print(comment, false);
    out.hardLine();
  }
  let id = T.d[(node << 5) + F_CH_FIRST] | 0;
  for (let i = 0, n = T.d[(node << 5) + F_CH_LEN] | 0; i < n; i++) {
    const child = id;
    const next = T.d[(child << 5) + F_NEXT] | 0;
    print(child, isLastDescendant && next < 0);
    // For oxfmt, what is between the brackets is on one line or each on its own.
    if (isOxfmt && (T.d[(child << 5) + F_KIND] | 0) === K_FLOW_MAPPING_ITEM) {
      const key = firstChild(child);
      const keyContent = key >= 0 ? firstChild(key) : -1;
      if (keyContent >= 0) {
        const kk = T.d[(keyContent << 5) + F_KIND] | 0;
        if (
          (T.d[(keyContent << 5) + F_TRAILING] | 0) >= 0 ||
          ((kk === K_PLAIN || kk === K_QUOTE_DOUBLE || kk === K_QUOTE_SINGLE) && (T.d[(keyContent << 5) + F_S_LINE] | 0) !== (T.d[(keyContent << 5) + F_E_LINE] | 0))
        ) {
          out.breakParent();
        }
      }
    }
    if (next < 0) break;
    out.token(",");
    out.line(LINE_SPACE);
    if ((T.d[(child << 5) + F_S_LINE] | 0) !== (T.d[(next << 5) + F_S_LINE] | 0) && hasNextEmptyLine(child)) out.line(LINE_SOFT);
    id = next;
  }
  if (trailingComma) {
    out.startIfBreak(0);
    out.token(",");
    out.otherwise();
    out.endIfBreak();
  }
  if ((T.d[(node << 5) + F_EN_LEN] | 0) > 0) {
    out.hardLine();
    printComments(T.d[(node << 5) + F_EN_FIRST] | 0, T.d[(node << 5) + F_EN_LEN] | 0);
  }
  out.endIndent();
  if (!isLastItemEmptyMappingItem) out.line(lineKind);
  out.token(isMapping ? "}" : "]");
}

// ---------------------------------------------------------------------------------------------- mappings

/** `isAbsolutelyPrintedAsSingleLineNode`. `node`: -1 for none. */
function isAbsolutelyPrintedAsSingleLine(node: number): boolean {
  if (node < 0) return true;
  const kind = T.d[(node << 5) + F_KIND] | 0;
  if (kind === K_ALIAS) return true;
  if (kind !== K_PLAIN && kind !== K_QUOTE_SINGLE && kind !== K_QUOTE_DOUBLE) return false;
  if (proseWrap === PROSE_WRAP_PRESERVE) return (T.d[(node << 5) + F_S_LINE] | 0) === (T.d[(node << 5) + F_E_LINE] | 0);
  // A backslash at the end of a line: `/\\$/m`
  const s = T.d[(node << 5) + F_S_OFF] | 0;
  const e = T.d[(node << 5) + F_E_OFF] | 0;
  if (e > s && (text[e - 1] | 0) === 92) return false;
  for (let i = s; i + 1 < e; i++) {
    if ((text[i] | 0) === 92 && (text[i + 1] | 0) === 10) return false;
  }
  scalarSource(kind, text, s, e);
  const d = scalarOut.data;
  const n = scalarOut.len;
  if (proseWrap === PROSE_WRAP_NEVER) {
    for (let i = 0; i < n; i++) if ((d[i] | 0) === 10) return false;
    return true;
  }
  for (let i = 0; i < n; i++) {
    const b = d[i] | 0;
    if (b === 10 || b === 32) return false;
  }
  return true;
}

/** To Prettier a key is the last of what it is in if the pair is. So it ends a scalar in it that keeps its line breaks as it
 * ends one at the end of the file, with one line break more. */
function printKey(key: number, isLastDescendant: boolean): void {
  keyDepth = keyDepth + 1;
  print(key, isLastDescendant);
  keyDepth = keyDepth - 1;
}

/** Whether a scalar in `node` is on more than one line. */
function hasScalarOverSeveralLines(node: number): boolean {
  if (node < 0) return false;
  const base = leftVec.len;
  let c = T.d[(node << 5) + F_CH_FIRST] | 0;
  for (let n = T.d[(node << 5) + F_CH_LEN] | 0; n > 0; n = n - 1) {
    leftVec.push(c);
    c = T.d[(c << 5) + F_NEXT] | 0;
  }
  while (leftVec.len > base) {
    const id = leftVec.pop();
    const k = T.d[(id << 5) + F_KIND] | 0;
    if ((k === K_PLAIN || k === K_QUOTE_DOUBLE || k === K_QUOTE_SINGLE) && (T.d[(id << 5) + F_S_LINE] | 0) !== (T.d[(id << 5) + F_E_LINE] | 0)) {
      leftVec.truncate(base);
      return true;
    }
    let ch = T.d[(id << 5) + F_CH_FIRST] | 0;
    for (let n = T.d[(id << 5) + F_CH_LEN] | 0; n > 0; n = n - 1) {
      leftVec.push(ch);
      ch = T.d[(ch << 5) + F_NEXT] | 0;
    }
  }
  return false;
}

function isBlockCollection(node: number): boolean {
  const k = T.d[(node << 5) + F_KIND] | 0;
  return k === K_MAPPING || k === K_SEQUENCE;
}

function writeColon(spaceBeforeColon: boolean, hasEndComments: boolean, valueContent: number, value: number, parent: number, keyComment: number): void {
  if (spaceBeforeColon) out.token(" ");
  out.token(":");
  if (
    hasEndComments &&
    valueContent >= 0 &&
    ((T.d[(valueContent << 5) + F_KIND] | 0) === K_FLOW_MAPPING || (T.d[(valueContent << 5) + F_KIND] | 0) === K_FLOW_SEQUENCE) &&
    (T.d[(valueContent << 5) + F_CH_LEN] | 0) === 0
  ) {
    out.token(" ");
  } else if (
    (valueContent >= 0 && (T.d[(valueContent << 5) + F_LD_LEN] | 0) > 0) ||
    (hasEndComments && !isOxfmt && valueContent >= 0 && !isBlockCollection(valueContent)) ||
    (parent >= 0 && ((T.d[(parent << 5) + F_KIND] | 0) === K_MAPPING || isOxfmt) && keyComment >= 0 && isInlineNode(valueContent)) ||
    (valueContent >= 0 && isBlockCollection(valueContent) && (T.d[(valueContent << 5) + F_TAG] | 0) < 0 && (T.d[(valueContent << 5) + F_ANCHOR] | 0) < 0)
  ) {
    out.hardLine();
  } else if (valueContent >= 0) {
    out.line(LINE_SPACE);
  } else if ((T.d[(value << 5) + F_TRAILING] | 0) >= 0) {
    out.token(" ");
  }
}

function noCommentsBeforeOrIn(content: number): boolean {
  return content < 0 || ((T.d[(content << 5) + F_LD_LEN] | 0) === 0 && (T.d[(content << 5) + F_MD_LEN] | 0) === 0);
}

/** `printMappingItem` */
function printMappingItem(node: number, isLastDescendant: boolean): void {
  if ((T.d[(node << 5) + F_CH_LEN] | 0) !== 2) return;
  const key = T.d[(node << 5) + F_CH_FIRST] | 0;
  const value = T.d[(node << 5) + F_CH_LAST] | 0;
  const parent = parentOf(node);
  const isEmptyKey = isEmptyNode(key);
  const isEmptyValue = isEmptyNode(value);
  if (isEmptyKey && isEmptyValue) {
    out.token(": ");
    return;
  }
  const keyContent = firstChild(key);
  const valueContent = firstChild(value);
  // For oxfmt a comment behind the `[` or `{` of the value stays between the brackets. Prettier takes it for one behind the
  // key.
  let keyComment = keyContent >= 0 ? T.d[(keyContent << 5) + F_TRAILING] | 0 : -1;
  if (isOxfmt && keyComment >= 0 && valueContent >= 0) {
    const vk = T.d[(valueContent << 5) + F_KIND] | 0;
    if ((vk === K_FLOW_MAPPING || vk === K_FLOW_SEQUENCE) && (T.d[(valueContent << 5) + F_CH_LEN] | 0) > 0 && (T.d[(valueContent << 5) + F_S_OFF] | 0) < (T.d[(keyComment << 5) + F_S_OFF] | 0)) {
      commentInBrackets = keyComment;
      commentInBracketsStart = T.d[(valueContent << 5) + F_S_OFF] | 0;
      keyComment = -1;
    }
  }
  // `needsSpaceInFrontOfMappingValue`
  const spaceBeforeColon = keyContent >= 0 && (T.d[(keyContent << 5) + F_KIND] | 0) === K_ALIAS;

  // At the start of the file, U+FEFF is a byte order mark. Prettier puts it there.
  let wouldBeByteOrderMark = false;
  if ((T.d[(node << 5) + F_S_OFF] | 0) === startOfContent && keyContent >= 0) {
    const s = T.d[(keyContent << 5) + F_S_OFF] | 0;
    wouldBeByteOrderMark = (T.d[(keyContent << 5) + F_E_OFF] | 0) - s >= 3 && (text[s] | 0) === 0xef && (text[s + 1] | 0) === 0xbb && (text[s + 2] | 0) === 0xbf;
  }
  const nodeKind = T.d[(node << 5) + F_KIND] | 0;

  if (isEmptyValue) {
    if (nodeKind === K_FLOW_MAPPING_ITEM && parent >= 0 && (T.d[(parent << 5) + F_KIND] | 0) === K_FLOW_MAPPING) {
      printKey(key, isLastDescendant);
      return;
    }
    let isInSet = false;
    if (parent >= 0) {
      const ptag = T.d[(parent << 5) + F_TAG] | 0;
      isInSet = ptag >= 0 && ((T.d[(ptag << 5) + F_FLAGS] | 0) & 1) !== 0;
    }
    if (
      nodeKind === K_MAPPING_ITEM &&
      isAbsolutelyPrintedAsSingleLine(keyContent) &&
      (keyContent < 0 || (T.d[(keyContent << 5) + F_TRAILING] | 0) < 0) &&
      !isInSet &&
      !wouldBeByteOrderMark
    ) {
      printKey(key, isLastDescendant);
      if (spaceBeforeColon) out.token(" ");
      out.token(":");
      return;
    }
    out.token("? ");
    startAlign(2);
    printKey(key, isLastDescendant);
    out.endIndent();
    return;
  }

  if (isEmptyKey) {
    out.token(": ");
    startAlign(2);
    print(value, isLastDescendant);
    out.endIndent();
    return;
  }

  // An explicit key.
  if ((T.d[(value << 5) + F_LD_LEN] | 0) > 0 || !isInlineNode(keyContent) || wouldBeByteOrderMark) {
    out.token("? ");
    startAlign(2);
    printKey(key, isLastDescendant);
    out.endIndent();
    out.hardLine();
    let c = T.d[(value << 5) + F_LD_FIRST] | 0;
    for (let n = T.d[(value << 5) + F_LD_LEN] | 0; n > 0; n = n - 1) {
      print(c, false);
      out.hardLine();
      c = T.d[(c << 5) + F_NEXT] | 0;
    }
    out.token(": ");
    startAlign(2);
    print(value, isLastDescendant);
    out.endIndent();
    return;
  }

  const keyHasNoComments =
    noCommentsBeforeOrIn(keyContent) && keyComment < 0 && (T.d[(key << 5) + F_EN_LEN] | 0) === 0;
  // `isSingleLineNode`
  let isSingleLineKey = true;
  if (keyContent >= 0) {
    const kk = T.d[(keyContent << 5) + F_KIND] | 0;
    if (kk === K_PLAIN || kk === K_QUOTE_DOUBLE || kk === K_QUOTE_SINGLE) isSingleLineKey = (T.d[(keyContent << 5) + F_S_LINE] | 0) === (T.d[(keyContent << 5) + F_E_LINE] | 0);
    else isSingleLineKey = kk === K_ALIAS;
  }
  const hasEndComments = (T.d[(value << 5) + F_EN_LEN] | 0) > 0;

  // On one line.
  if (
    isSingleLineKey &&
    keyHasNoComments &&
    noCommentsBeforeOrIn(valueContent) &&
    // For oxfmt the comments behind a value do not matter to where it is.
    (!hasEndComments || isOxfmt) &&
    isAbsolutelyPrintedAsSingleLine(valueContent) &&
    isAbsolutelyPrintedAsSingleLine(keyContent)
  ) {
    printKey(key, isLastDescendant);
    if (spaceBeforeColon) out.token(" ");
    out.token(": ");
    if (!hasEndComments) {
      print(value, isLastDescendant);
      return;
    }
    startAlign(tabWidth);
    print(value, isLastDescendant);
    out.endIndent();
    return;
  }

  // `conditionalGroup`
  out.startGroup(false, 0, true);
  // A key that is on one line for sure is implicit, however long it is.
  if (isAbsolutelyPrintedAsSingleLine(keyContent) && keyHasNoComments) {
    printKey(key, isLastDescendant);
    startAlign(tabWidth);
    writeColon(spaceBeforeColon, hasEndComments, valueContent, value, parent, keyComment);
    print(value, isLastDescendant);
    out.endIndent();
    out.endGroup();
    return;
  }

  // Explicit if the key breaks, implicit otherwise. The line break in a scalar in a pair in `{ }` breaks no group around the
  // pair, so Prettier prints a key over several lines that is implicit, which cannot be read.
  const shouldBreak = hasScalarOverSeveralLines(keyContent);
  lastGroupId = lastGroupId + 1;
  const groupId = lastGroupId;
  out.startPlainGroup(shouldBreak);
  out.startIfBreak(0);
  out.token("? ");
  out.otherwise();
  out.endIfBreak();
  out.startGroup(shouldBreak, groupId, false);
  startAlign(2);
  printKey(key, isLastDescendant);
  out.endIndent();
  out.endGroup();
  out.endGroup();

  // `ifBreak([hardline, ": ", align(2, value)], align(tabWidth, [colon, value]), { groupId })`. The value is written once: with
  // it in both, a mapping in a mapping would be written four times, and so on.
  out.startIfBreak(groupId);
  out.hardLine();
  out.token(": ");
  out.otherwise();
  out.endIfBreak();
  out.startAlignIfBreak(groupId, 2, tabWidth);
  out.startIfBreak(groupId);
  out.otherwise();
  writeColon(spaceBeforeColon, hasEndComments, valueContent, value, parent, keyComment);
  out.endIfBreak();
  print(value, isLastDescendant);
  out.endIndent();
  out.endGroup();
}
