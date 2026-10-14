// Port of vendor/bun/src/format/js/print/jsx/child_list.rs: the children of an element. Prettier's `printJsxChildren` and what
// `printJsxElementInternal` does with the result.
//
// Rust builds `Vec<FormatElement>`s of the children, one for the layout on the line of the tags (`flat`) and one for the layout with the
// children on lines of their own (`multiline`). Here the children are formatted once, in source order, into captures (`handle`s); the two
// layouts are written from the parts afterwards, as captures too. The result is in `childrenResult`; copy what you need from it at once: it is
// overwritten by the next element.
import { Formatter } from "../../../ir/formatter.ts";
import { I32Vec } from "../../../../sema/vec.ts";
import { isAlphabetic } from "../../../../base/ustr.ts";
import { decodeUtf8, utf8Len } from "../../../../base/utf8.ts";
import { FLAVOR_OXFMT } from "../../../options.ts";
import {
  EXPR_JSX,
  EXPR_MISSING,
  EXPR_SPREAD,
  JC_EXPR,
  SP,
  exprIsJsxText,
  exprJsxContainerSpan,
  exprSpan,
  exprTag,
  jsxChildrenWithWhitespace,
  jsxIsSelfClosing,
  jsxTag,
} from "../../../../lint/ast/index.ts";
import { cxOf } from "../../context.ts";
import { fmtJsxChild } from "./mod.ts";
import { hasLineBreak, isJsxWhitespace, isMeaningfulJsxText, isWhitespaceJsxExpression, fmtJsxRawSpace, fmtJsxSpace } from "../../utils/jsx.ts";
import { writeSuppressedNode } from "../../utils/suppressed.ts";
import { SEP_JSX_WHITESPACE, SEP_LINE, SEP_SOFT_LINE, SEP_HARD_LINE, ITEM_WORD, ITEM_NODE, PART_CONTENT, PART_SEPARATOR, CHILDREN_FORCE_MULTILINE, CHILDREN_BEST_FITTING, CHILDREN_SINGLE_CHILD, CH_TEXT, CH_NODE } from "./child_list.consts.ts";
export { CHILDREN_FORCE_MULTILINE, CHILDREN_BEST_FITTING, CHILDREN_SINGLE_CHILD } from "./child_list.consts.ts";





/** `FormatChildrenResult`. */
export class ChildrenResult {
  kind: number = 0;
  /** The multiline layout is a fill (there is text), else a group that breaks. */
  isFill: boolean = false;
  /** The entries of the multiline layout (a capture), -1: nothing (`elements` is `None`). */
  multiline: number = -1;
  /** The entries of the flat layout (BestFitting only), -1: nothing. */
  flat: number = -1;
  /** SingleChild: the item `(ITEM_WORD, start, end)` or `(ITEM_NODE, expr, 0)`. */
  itemType: number = 0;
  itemA: number = 0;
  itemB: number = 0;
  forcedBreak: boolean = false;
}

export const childrenResult = new ChildrenResult();

const ITEMS = new I32Vec(96);
const PARTS = new I32Vec(192);
const KEPT = new I32Vec(192);
/** The children, classified: quadruples `(CH_TEXT | CH_NODE, a, b, buffer)`. */
const CH = new I32Vec(96);
const ROWS = new I32Vec(96);


/** `{" "}` as text. */
const SPACE_BUF = new Uint8Array([32]);

/** What `Children` has while it is built (no recursion in between). */
class Builder {
  ib: number = 0;
  pb: number = 0;
  src: Uint8Array = SPACE_BUF;
  isMdx: boolean = false;
  isOxfmt: boolean = false;
  isFbt: boolean = false;
  containsTag: boolean = false;
  containsMultipleExpressions: boolean = false;
  containsText: boolean = false;
}

const B = new Builder();

function bufOf(sel: number): Uint8Array {
  return sel === 0 ? B.src : SPACE_BUF;
}

function itemCount(): number {
  return ((ITEMS.len - B.ib) / 3) | 0;
}

function partsCount(): number {
  return ((PARTS.len - B.pb) / 3) | 0;
}

function push(type: number, a: number, b: number): void {
  const ITEMS$ = ITEMS;
  ITEMS$.push(type);
  ITEMS$.push(a);
  ITEMS$.push(b);
  const PARTS$ = PARTS;
  if (PARTS$.len > B.pb && (PARTS$.data[PARTS$.len - 3] | 0) === PART_CONTENT) PARTS$.data[PARTS$.len - 1] = itemCount();
}

function pushLine(separator0: number): void {
  const separator = separator0 === SEP_LINE && B.isMdx ? SEP_JSX_WHITESPACE : separator0;
  const PARTS$ = PARTS;
  PARTS$.push(PART_SEPARATOR);
  PARTS$.push(separator);
  PARTS$.push(0);
  const at = itemCount();
  PARTS$.push(PART_CONTENT);
  PARTS$.push(at);
  PARTS$.push(at);
}

function skipWhitespace(buf: Uint8Array, start: number, end: number): number {
  let i = start;
  while (i < end && isJsxWhitespace(buf[i] | 0)) i = i + 1;
  return i;
}

function skipWord(buf: Uint8Array, start: number, end: number): number {
  let i = start;
  while (i < end && !isJsxWhitespace(buf[i] | 0)) i = i + 1;
  return i;
}

/** The only character of the word, or -1. */
function singleCharacter(buf: Uint8Array, start: number, end: number): number {
  if (end <= start) return -1;
  const cp = decodeUtf8(buf, start, end);
  if (start + utf8Len() !== end) return -1;
  return cp;
}

/** `word.length === 1` for Prettier, which counts UTF-16. For oxfmt an emoji is one character too. */
function isSingleCharacter(buf: Uint8Array, start: number, end: number): boolean {
  const cp = singleCharacter(buf, start, end);
  return cp >= 0 && (B.isOxfmt || cp <= 0xffff);
}

/**
 * What oxfmt has for `pushSeparatorWithWhitespace` before the text `[start, end)`, which starts with a word: a letter with more words after
 * it is the start of a sentence, `A dog`, and stays on its line. What follows the text only counts if the text is that one word.
 */
function isJoinedToWhatIsBeforeIt(buf: Uint8Array, start: number, end: number, isBeforeSelfClosingElement: boolean): boolean {
  const wordEnd = skipWord(buf, start, end);
  const restStart = skipWhitespace(buf, wordEnd, end);
  const cp = singleCharacter(buf, start, wordEnd);
  if (cp < 0) return false;
  if (restStart >= end) {
    return !(isBeforeSelfClosingElement && (restStart === wordEnd || hasLineBreak(buf, wordEnd, restStart)));
  }
  return !isAlphabetic(cp);
}

/** Prettier's `separatorNoWhitespace`. `[wordStart, wordEnd)`: the word next to the place. */
function pushSeparatorNoWhitespace(buf: Uint8Array, wordStart: number, wordEnd: number, isNextToSelfClosingElement: boolean): void {
  if (B.isFbt) return;
  pushLine(isNextToSelfClosingElement && !isSingleCharacter(buf, wordStart, wordEnd) ? SEP_HARD_LINE : SEP_SOFT_LINE);
}

/** Prettier's `separatorWithWhitespace`. */
function pushSeparatorWithWhitespace(buf: Uint8Array, wordStart: number, wordEnd: number, isNextToSelfClosingElement: boolean): void {
  const isSoft = !B.isFbt && isSingleCharacter(buf, wordStart, wordEnd) && !isNextToSelfClosingElement;
  pushLine(isSoft ? SEP_SOFT_LINE : SEP_HARD_LINE);
}

function countNewlines(buf: Uint8Array, start: number, end: number): number {
  // `\r\n`, `\r` and `\n` end a line.
  let n = 0;
  for (let i = start; i < end; i++) {
    const b = buf[i] | 0;
    if (b === 10) n = (n + 1) | 0;
    else if (b === 13 && !(i + 1 < end && (buf[i + 1] | 0) === 10)) n = (n + 1) | 0;
  }
  return n;
}

/** `next`: the child after the text, as `CH[r + 1]`, or none. */
function pushText(buf: Uint8Array, start: number, end: number, nextType: number, nextIsSelfClosing: boolean): void {
  if (!isMeaningfulJsxText(buf, start, end)) {
    // Up to one empty line between two children is kept.
    if (countNewlines(buf, start, end) >= 2) pushLine(SEP_HARD_LINE);
    return;
  }
  const B$ = B;
  B$.containsText = true;
  const isBeforeSelfClosingElement = nextType === CH_NODE && nextIsSelfClosing;

  const restStart0 = skipWhitespace(buf, start, end);
  let rest = restStart0;
  if (restStart0 > start) {
    if (hasLineBreak(buf, start, restStart0)) {
      if (B$.isOxfmt && !B$.isFbt) {
        pushLine(isJoinedToWhatIsBeforeIt(buf, rest, end, isBeforeSelfClosingElement) ? SEP_SOFT_LINE : SEP_HARD_LINE);
      } else {
        pushSeparatorWithWhitespace(buf, rest, skipWord(buf, rest, end), isBeforeSelfClosingElement);
      }
    } else {
      pushLine(SEP_JSX_WHITESPACE);
    }
  }

  while (rest < end) {
    const wordStart = rest;
    const wordEnd = skipWord(buf, rest, end);
    const afterWhitespace = skipWhitespace(buf, wordEnd, end);
    push(ITEM_WORD, wordStart, wordEnd);
    rest = afterWhitespace;
    if (rest < end) pushLine(SEP_LINE);
    else if (afterWhitespace === wordEnd) pushSeparatorNoWhitespace(buf, wordStart, wordEnd, isBeforeSelfClosingElement);
    else if (hasLineBreak(buf, wordEnd, afterWhitespace)) pushSeparatorWithWhitespace(buf, wordStart, wordEnd, isBeforeSelfClosingElement);
    else pushLine(SEP_JSX_WHITESPACE);
  }
}

function pushNode(node: number, nextType: number, nextBufSel: number, nextA: number, nextB: number): void {
  if (!exprJsxContainerSpan(node)) B.containsTag = true;
  push(ITEM_NODE, node, -1);
  if (nextType === CH_TEXT) {
    const buf = bufOf(nextBufSel);
    if (isMeaningfulJsxText(buf, nextA, nextB)) {
      const wordStart = skipWhitespace(buf, nextA, nextB);
      const wordEnd = skipWord(buf, wordStart, nextB);
      pushSeparatorNoWhitespace(buf, wordStart, wordEnd, isSelfClosingElement(node));
      return;
    }
  }
  pushLine(SEP_HARD_LINE);
}

/** `<a />` */
function isSelfClosingElement(e: number): boolean {
  return !exprJsxContainerSpan(e) && exprTag(e) === EXPR_JSX && jsxIsSelfClosing(e);
}

function partKind(p: number): number {
  return PARTS.data[B.pb + 3 * p] | 0;
}
function partA(p: number): number {
  return PARTS.data[B.pb + 3 * p + 1] | 0;
}
function partB(p: number): number {
  return PARTS.data[B.pb + 3 * p + 2] | 0;
}

/** `Part::is_empty_content` */
function isEmptyContent(kind: number, a: number, b: number): boolean {
  return kind === PART_CONTENT && a === b;
}

/** Prettier's `isEmptyStringOrAnyLine` */
function isEmptyContentOrAnyLine(kind: number, a: number, b: number): boolean {
  if (kind === PART_CONTENT) return a === b;
  return B.isMdx || a !== SEP_JSX_WHITESPACE;
}

/**
 * Several separators in a row, with nothing between them, are made one. Those at the start and at the end are removed.
 *
 * Prettier goes from the end to the start and splices. Here what is kept is put on a stack, whose top is the part after the one that is
 * looked at.
 */
function removeRedundantSeparators(): void {
  const B$ = B;
  const containsText = B$.containsText;
  const n = partsCount();
  const KEPT$ = KEPT;
  KEPT$.len = 0;
  for (let i = n - 1; i >= 0; i--) {
    const kind = partKind(i);
    const a = partA(i);
    const b = partB(i);
    const kl = KEPT$.len;
    let handled = false;
    if (kind === PART_SEPARATOR && kl >= 6 && (KEPT$.data[kl - 6] | 0) === PART_SEPARATOR) {
      // (part, Some(next), Some(Separator(after_next)))
      const nextKind = KEPT$.data[kl - 3] | 0;
      const nextA = KEPT$.data[kl - 2] | 0;
      const nextB = KEPT$.data[kl - 1] | 0;
      if (isEmptyContent(nextKind, nextA, nextB)) {
        const afterNext = KEPT$.data[kl - 5] | 0;
        const separator = a;
        if (separator === SEP_HARD_LINE && afterNext === SEP_HARD_LINE && !containsText) {
          // kept.push(part)
        } else if (
          (separator === SEP_HARD_LINE && afterNext === SEP_HARD_LINE) ||
          ((separator === SEP_SOFT_LINE || separator === SEP_HARD_LINE) && afterNext === SEP_JSX_WHITESPACE) ||
          (separator === SEP_JSX_WHITESPACE && afterNext === SEP_JSX_WHITESPACE) ||
          (separator === SEP_SOFT_LINE && afterNext === SEP_HARD_LINE) ||
          (separator === SEP_HARD_LINE && afterNext === SEP_SOFT_LINE)
        ) {
          KEPT$.len = kl - 3;
          handled = true;
        } else if (separator === SEP_JSX_WHITESPACE && (afterNext === SEP_SOFT_LINE || afterNext === SEP_HARD_LINE)) {
          KEPT$.len = kl - 6;
          // kept.push(part)
        }
      }
    }
    if (!handled) {
      KEPT$.push(kind);
      KEPT$.push(a);
      KEPT$.push(b);
    }
  }
  // `kept.reverse()`: the forward order is from the end of KEPT to its start.
  let count = (KEPT$.len / 3) | 0;
  // `while let [rest @ .., last] = parts && last.is_empty_content_or_any_line()`: the last forward part is KEPT[0].
  let lo = 0;
  while (count > 0) {
    const at = 3 * lo;
    if (isEmptyContentOrAnyLine(KEPT$.data[at] | 0, KEPT$.data[at + 1] | 0, KEPT$.data[at + 2] | 0)) {
      lo = lo + 1;
      count = count - 1;
    } else break;
  }
  // `while let [first, second, rest @ ..] = parts && both are`: the first forward part is the last of KEPT.
  let hi = (KEPT$.len / 3) | 0; // forward part j is KEPT[hi - 1 - j]
  while (hi - lo >= 2) {
    const f1 = 3 * (hi - 1);
    const f2 = 3 * (hi - 2);
    if (
      isEmptyContentOrAnyLine(KEPT$.data[f1] | 0, KEPT$.data[f1 + 1] | 0, KEPT$.data[f1 + 2] | 0) &&
      isEmptyContentOrAnyLine(KEPT$.data[f2] | 0, KEPT$.data[f2 + 1] | 0, KEPT$.data[f2 + 2] | 0)
    ) {
      hi = hi - 2;
    } else break;
  }
  const PARTS$ = PARTS;
  PARTS$.len = B$.pb;
  for (let k = hi - 1; k >= lo; k--) {
    PARTS$.push(KEPT$.data[3 * k] | 0);
    PARTS$.push(KEPT$.data[3 * k + 1] | 0);
    PARTS$.push(KEPT$.data[3 * k + 2] | 0);
  }
}

/** Fills `CH` from the children of `e` (rows of `jsxChildrenWithWhitespace`). */
function classifyChildren(e: number, f: Formatter): void {
  const ROWS$ = ROWS;
  ROWS$.len = 0;
  const CH$ = CH;
  CH$.len = 0;
  jsxChildrenWithWhitespace(e, ROWS$);
  const SP$ = SP;
  for (let i = 0; i < ROWS$.len; i = i + 3) {
    const kind = ROWS$.data[i] | 0;
    const a = ROWS$.data[i + 1] | 0;
    const b = ROWS$.data[i + 2] | 0;
    if (kind !== JC_EXPR) {
      CH$.push(CH_TEXT);
      CH$.push(a);
      CH$.push(b);
      CH$.push(0);
    } else if (exprIsJsxText(a)) {
      exprSpan(a);
      CH$.push(CH_TEXT);
      CH$.push(SP$.s0 | 0);
      CH$.push(SP$.s1 | 0);
      CH$.push(0);
    } else if (isWhitespaceJsxExpression(a, f)) {
      CH$.push(CH_TEXT);
      CH$.push(0);
      CH$.push(1);
      CH$.push(1);
    } else {
      CH$.push(CH_NODE);
      CH$.push(a);
      CH$.push(0);
      CH$.push(0);
    }
  }
}

/** Prettier's `printJsxChildren`, before anything is formatted. Leaves the items and the parts above the bases `B.ib`, `B.pb`. */
function buildChildren(e: number, isMdxBlock: boolean, f: Formatter): void {
  const B$ = B;
  B$.ib = ITEMS.len;
  const PARTS$ = PARTS;
  B$.pb = PARTS$.len;
  B$.src = f.source;
  B$.isMdx = isMdxBlock;
  B$.isOxfmt = f.options.flavor === FLAVOR_OXFMT;
  B$.containsTag = false;
  B$.containsMultipleExpressions = false;
  B$.containsText = false;
  // `<fbt>`: Facebook's translation tag, in which white space is kept as it is.
  const tag = jsxTag(e);
  B$.isFbt = false;
  const SP$ = SP;
  if (tag >= 0) {
    exprSpan(tag);
    const ts = SP$.s0 | 0;
    const te = SP$.s1 | 0;
    const src = f.source;
    B$.isFbt = te - ts === 3 && (src[ts] | 0) === 102 && (src[ts + 1] | 0) === 98 && (src[ts + 2] | 0) === 116;
  }
  PARTS$.push(PART_CONTENT);
  PARTS$.push(0);
  PARTS$.push(0);

  classifyChildren(e, f);
  const CH$ = CH;
  const n = (CH$.len / 4) | 0;
  let expressionCount = 0;
  for (let r = 0; r < n; r++) {
    const type = CH$.data[4 * r] | 0;
    const a = CH$.data[4 * r + 1] | 0;
    const b = CH$.data[4 * r + 2] | 0;
    const sel = CH$.data[4 * r + 3] | 0;
    let nextType = 0;
    let nextSel = 0;
    let nextA = 0;
    let nextB = 0;
    let nextIsSelfClosing = false;
    if (r + 1 < n) {
      nextType = CH$.data[4 * r + 4] | 0;
      nextA = CH$.data[4 * r + 5] | 0;
      nextB = CH$.data[4 * r + 6] | 0;
      nextSel = CH$.data[4 * r + 7] | 0;
      if (nextType === CH_NODE) nextIsSelfClosing = isSelfClosingElement(nextA);
    }
    if (type === CH_TEXT) {
      pushText(bufOf(sel), a, b, nextType, nextIsSelfClosing);
    } else {
      const isExpressionContainer = exprJsxContainerSpan(a) && exprTag(a) !== EXPR_SPREAD;
      if (isExpressionContainer) expressionCount = (expressionCount + 1) | 0;
      pushNode(a, nextType, nextSel, nextA, nextB);
    }
  }
  B$.containsMultipleExpressions = expressionCount > 1;
  removeRedundantSeparators();
}

/**
 * Formats the children of the element `e`. `forcedBreak`: it is known that they are on lines of their own. The result is in
 * `childrenResult`; its kind is returned.
 */
export function formatChildren(e: number, forcedBreak0: boolean, isMdxBlock: boolean, f: Formatter): number {
  const cx = cxOf(f);
  const cm = cx.comments;
  buildChildren(e, isMdxBlock, f);
  const B$ = B;
  const ib = B$.ib;
  const pb = B$.pb;
  const containsText = B$.containsText;
  const isOxfmt = B$.isOxfmt;
  const nParts = partsCount();
  let forcedBreak = forcedBreak0 || B$.containsTag || B$.containsMultipleExpressions;
  const res = childrenResult;

  const ITEMS$ = ITEMS;
  const PARTS$ = PARTS;
  if (nParts === 1 && partKind(0) === PART_CONTENT && partB(0) - partA(0) === 1 && !isMdxBlock) {
    const at = ib + 3 * partA(0);
    res.kind = CHILDREN_SINGLE_CHILD;
    res.itemType = ITEMS$.data[at] | 0;
    res.itemA = ITEMS$.data[at + 1] | 0;
    res.itemB = ITEMS$.data[at + 2] | 0;
    res.forcedBreak = forcedBreak;
    PARTS$.len = pb;
    ITEMS$.len = ib;
    return CHILDREN_SINGLE_CHILD;
  }

  // Pass 1: the nodes are formatted, in source order. The last child that is not white space with a line break is `{/* prettier-ignore */}`.
  let isAfterIgnoreComment = false;
  const SP$ = SP;
  for (let p = 0; p < nParts; p++) {
    const kind = PARTS$.data[pb + 3 * p] | 0;
    const a = PARTS$.data[pb + 3 * p + 1] | 0;
    if (kind === PART_SEPARATOR) {
      if (a === SEP_JSX_WHITESPACE) isAfterIgnoreComment = false;
      else if (a === SEP_HARD_LINE) forcedBreak = true;
      continue;
    }
    const end = PARTS$.data[pb + 3 * p + 2] | 0;
    for (let i = a; i < end; i++) {
      const at = ib + 3 * i;
      if ((ITEMS$.data[at] | 0) === ITEM_WORD) {
        isAfterIgnoreComment = false;
        continue;
      }
      const node = ITEMS$.data[at + 1] | 0;
      // For Prettier it is about an element or a fragment. For oxfmt about `{e}` too.
      const isSuppressed = isAfterIgnoreComment && (exprTag(node) === EXPR_JSX || isOxfmt);
      if (!exprJsxContainerSpan(node)) exprSpan(node);
      const nodeStart = SP$.s0 | 0;
      const nodeEnd = SP$.s1 | 0;
      isAfterIgnoreComment = exprTag(node) === EXPR_MISSING && cm.isSuppressed(nodeEnd);
      const slot = f.startCapture();
      if (isSuppressed) writeSuppressedNode(nodeStart, nodeEnd, f);
      else fmtJsxChild(node, f);
      const h = f.endCapture(slot);
      if (!forcedBreak) forcedBreak = f.willBreak(h);
      // The items may have been moved by a nested element: they are above the bases of this call only.
      ITEMS$.data[ib + 3 * i + 2] = h | 0;
    }
  }

  const isFill = containsText;

  // Pass 2, the layout with the children on lines of their own: Prettier's `multilineChildren`.
  const multiline = writeMultilineEntries(nParts, ib, pb, isFill, isMdxBlock, f);

  let flat = -1;
  if (!forcedBreak) flat = writeFlatEntries(nParts, ib, pb, f);

  res.kind = forcedBreak ? CHILDREN_FORCE_MULTILINE : CHILDREN_BEST_FITTING;
  res.isFill = isFill;
  res.multiline = multiline;
  res.flat = flat;
  res.forcedBreak = forcedBreak;
  PARTS$.len = pb;
  ITEMS$.len = ib;
  return res.kind;
}

function writeSeparator(separator: number, f: Formatter): void {
  switch (separator) {
    case SEP_JSX_WHITESPACE:
      fmtJsxSpace(f);
      break;
    case SEP_LINE:
      f.softLineBreakOrSpace();
      break;
    case SEP_SOFT_LINE:
      f.softLineBreak();
      break;
    default:
      f.hardLineBreak();
      break;
  }
}

function writeItems(first: number, end: number, ib: number, f: Formatter): void {
  const ITEMS$ = ITEMS;
  for (let i = first; i < end; i++) {
    const at = ib + 3 * i;
    if ((ITEMS$.data[at] | 0) === ITEM_WORD) f.textSourceNoWs(ITEMS$.data[at + 1] | 0, ITEMS$.data[at + 2] | 0);
    else f.writeInterned(ITEMS$.data[at + 2] | 0);
  }
}

/** The flat layout: everything in order. */
function writeFlatEntries(nParts: number, ib: number, pb: number, f: Formatter): number {
  const slot = f.startCapture();
  const PARTS$ = PARTS;
  for (let p = 0; p < nParts; p++) {
    const kind = PARTS$.data[pb + 3 * p] | 0;
    if (kind === PART_SEPARATOR) writeSeparator(PARTS$.data[pb + 3 * p + 1] | 0, f);
    else writeItems(PARTS$.data[pb + 3 * p + 1] | 0, PARTS$.data[pb + 3 * p + 2] | 0, ib, f);
  }
  return f.endCapture(slot);
}

/** `MultilineBuilder`: with text, as many children are on each line as fit (a fill of entries). Otherwise each is on its own line. */
function writeMultilineEntries(nParts: number, ib: number, pb: number, isFill: boolean, isMdxBlock: boolean, f: Formatter): number {
  const slot = f.startCapture();
  if (isFill) f.startEntry();
  const PARTS$ = PARTS;
  for (let index = 0; index < nParts; index++) {
    const kind = PARTS$.data[pb + 3 * index] | 0;
    const a = PARTS$.data[pb + 3 * index + 1] | 0;
    if (kind === PART_CONTENT) {
      writeItems(a, PARTS$.data[pb + 3 * index + 2] | 0, ib, f);
      continue;
    }
    const separator = a;
    // previous(1), previous(2)
    const p1IsEmpty = index >= 1 && (PARTS$.data[pb + 3 * (index - 1)] | 0) === PART_CONTENT && (PARTS$.data[pb + 3 * (index - 1) + 1] | 0) === (PARTS$.data[pb + 3 * (index - 1) + 2] | 0);
    const p2IsHard = index >= 2 && (PARTS$.data[pb + 3 * (index - 2)] | 0) === PART_SEPARATOR && (PARTS$.data[pb + 3 * (index - 2) + 1] | 0) === SEP_HARD_LINE;
    const isAfterLineBreak = p1IsEmpty && p2IsHard;
    if (separator === SEP_JSX_WHITESPACE) {
      if (index === 1 && p1IsEmpty) {
        if (nParts === 2) {
          fmtJsxRawSpace(f);
        } else {
          writeEntrySeparatorStart(isFill, f);
          fmtJsxRawSpace(f);
          f.hardLineBreak();
          writeEntrySeparatorEnd(isFill, f);
        }
        continue;
      }
      const isLast = index + 1 === nParts;
      if (isLast || isAfterLineBreak) {
        fmtJsxRawSpace(f);
        continue;
      }
    }
    writeEntrySeparatorStart(isFill, f);
    if (separator === SEP_HARD_LINE && isAfterLineBreak) {
      // The printer makes one line break of two in a row.
      f.emptyLine();
    } else if (isMdxBlock && separator === SEP_JSX_WHITESPACE) {
      f.softLineBreakOrSpace();
    } else {
      writeSeparator(separator, f);
    }
    writeEntrySeparatorEnd(isFill, f);
  }
  if (isFill) f.endEntry();
  return f.endCapture(slot);
}

function writeEntrySeparatorStart(isFill: boolean, f: Formatter): void {
  if (isFill) {
    f.endEntry();
    f.startEntry();
  }
}

function writeEntrySeparatorEnd(isFill: boolean, f: Formatter): void {
  if (isFill) {
    f.endEntry();
    f.startEntry();
  }
}

/** `FormatMultilineChildren::fmt_content` (Prettier's `content`). */
export function writeMultilineContent(isFill: boolean, multiline: number, f: Formatter): void {
  if (isFill) f.startFill();
  else f.startGroupExpand(true);
  f.writeInterned(multiline);
  if (isFill) f.endFill();
  else f.endGroup();
}

/** `FormatMultilineChildren::fmt` */
export function writeMultilineChildren(isFill: boolean, multiline: number, f: Formatter): void {
  if (multiline < 0) {
    // The line break after the opening tag and the one before the closing tag.
    f.hardLineBreak();
    f.emptyLine();
    return;
  }
  f.startBlockIndent();
  writeMultilineContent(isFill, multiline, f);
  f.endBlockIndent();
}

/** `FormatSingleChild::fmt` */
export function writeSingleChild(itemType: number, itemA: number, itemB: number, forcedBreak: boolean, f: Formatter): void {
  if (forcedBreak) f.startBlockIndent();
  else f.startSoftBlockIndent();
  if (itemType === ITEM_WORD) f.textSourceNoWs(itemA, itemB);
  else fmtJsxChild(itemA, f);
  if (forcedBreak) f.endBlockIndent();
  else f.endSoftBlockIndent();
}
