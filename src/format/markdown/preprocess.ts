// Port of vendor/bun/src/format/markdown/preprocess.rs: what Prettier does to the tree before it prints it:
// `print/preprocess.js`.
//
// Texts are split into words and white space, and lists get to know whether their content is aligned to the tab width.
// What else that file notes on nodes is found out when it is asked for.
import { ByteBuf } from "../../base/bytebuf.ts";
import { decodeUtf8, decodeUtf8Back, utf8Len } from "../../base/utf8.ts";
import { Stack } from "../../base/stack.ts";
import { trimJsWhitespaceStart } from "../text.ts";
import {
  F_ALIGNED,
  F_ORDERED,
  F_SPREAD,
  K_BLOCKQUOTE,
  K_CODE,
  K_EMPHASIS,
  K_HEADING,
  K_HTML,
  K_JSX,
  K_LIST,
  K_PARAGRAPH,
  K_SENTENCE,
  K_STRONG,
  K_TEXT,
  K_WIKI_LINK,
  NONE,
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
  isInlineWrapper,
} from "./ast.ts";
import { hasHtmlComment } from "./spans.ts";
import {
  containsByte,
  containsStr,
  indexOfStr,
  isAllAscii,
  isAsciiAlpha,
  isAsciiDigit,
  isAsciiPunct,
  isAsciiWs,
  isBlank,
  isIn,
} from "./strings.ts";
import { CJK, HANGUL, PUNCTUATION, VARIATION_SELECTORS } from "./unicode_tables.ts";

// `Node::number` of a sentence that has not been split into words. Its text is its `value`. `F_ALIGNED` says that it is in
// emphasis.
export const PLAIN = -1;

// Prettier's `PUNCTUATION_REGEXP`
export function isPunctuation(c: number): boolean {
  if (c < 128) return isAsciiPunct(c);
  return isIn(PUNCTUATION, c);
}

// The same for one UTF-16 code unit: half of a character is not punctuation. `c` is -1 for none.
export function isPunctuationUnit(c: number): boolean {
  return c >= 0 && c <= 0xffff && isPunctuation(c);
}

function isWhiteSplit(b: number): boolean {
  return b === 9 || b === 10 || b === 32;
}

// ---- splitText

let swLastKind = -1;
let swLastWide = false;
// Where the text of the token with the offsets `0..` of the text being split starts in the string that the tokens point to.
let swBase = 0;
let swFlags = 0;

function hasWideSpace(text: Uint8Array, start: number, end: number): boolean {
  // U+3000: E3 80 80
  for (let i = start; i + 2 < end; i++) {
    if ((text[i] | 0) === 0xe3 && (text[i + 1] | 0) === 0x80 && (text[i + 2] | 0) === 0x80) return true;
  }
  return false;
}

// Prettier's `appendNode`
function swWord(tree: Tree, text: Uint8Array, tStart: number, kind: number, start: number, end: number, punctFlags: number): void {
  const wide = hasWideSpace(text, start, end);
  // Two words next to each other have an empty space between them, but for punctuation of Chinese and Japanese next to
  // other text, and a full-width space.
  if (swLastKind >= 0) {
    const isBetween =
      (swLastKind === TK_NON_CJK && kind === TK_CJK_PUNCTUATION) || (swLastKind === TK_CJK_PUNCTUATION && kind === TK_NON_CJK);
    if (!isBetween && !wide && !swLastWide) tree.addToken(TK_NO_SPACE, 0, 0, 0);
  }
  tree.addToken(kind, punctFlags | swFlags, swBase + (start - tStart), end - start);
  swLastKind = kind;
  swLastWide = wide;
}

function swOtherWord(tree: Tree, text: Uint8Array, tStart: number, start: number, end: number): void {
  if (start < end) {
    let flags = 0;
    const first = text[start] | 0;
    let firstCp = first;
    if (first >= 128) firstCp = decodeUtf8(text, start, end);
    if (isPunctuationUnit(firstCp)) flags = flags | TF_LEADING_PUNCT;
    const last = text[end - 1] | 0;
    let lastCp = last;
    if (last >= 128) lastCp = decodeUtf8Back(text, start, end);
    if (isPunctuationUnit(lastCp)) flags = flags | TF_TRAILING_PUNCT;
    swWord(tree, text, tStart, TK_NON_CJK, start, end, flags);
  }
}

// Prettier's `splitText`: appends the tokens of text[tStart, tEnd) to the tree. The text of a token is a range of the string
// that starts at `baseStart` (the text itself, or `strings` if `owned`) and corresponds to text[tStart..].
export function splitText(tree: Tree, text: Uint8Array, tStart: number, tEnd: number, baseStart: number, owned: boolean): void {
  swLastKind = -1;
  swLastWide = false;
  swBase = baseStart;
  swFlags = owned ? TF_OWNED : 0;
  let index = tStart;
  while (index < tEnd) {
    if (isWhiteSplit(text[index] | 0)) {
      let len = 0;
      let hasNewline = false;
      while (index + len < tEnd && isWhiteSplit(text[index + len] | 0)) {
        if ((text[index + len] | 0) === 10) hasNewline = true;
        len = len + 1;
      }
      tree.addToken(hasNewline ? TK_NEWLINE : TK_SPACE, 0, 0, 0);
      swLastKind = -1;
      index = index + len;
      continue;
    }
    let wordEnd = index;
    let ascii = true;
    while (wordEnd < tEnd && !isWhiteSplit(text[wordEnd] | 0)) {
      if ((text[wordEnd] | 0) >= 128) ascii = false;
      wordEnd = wordEnd + 1;
    }
    if (ascii) {
      swOtherWord(tree, text, tStart, index, wordEnd);
      index = wordEnd;
      continue;
    }
    // Every character of Chinese, Japanese and Korean is a word.
    let runStart = index;
    while (index < wordEnd) {
      const c = decodeUtf8(text, index, wordEnd);
      const len = utf8Len();
      if (!isIn(CJK, c)) {
        index = index + len;
        continue;
      }
      swOtherWord(tree, text, tStart, runStart, index);
      let selectorLen = 0;
      if (index + len < wordEnd) {
        const s = decodeUtf8(text, index + len, wordEnd);
        if (isIn(VARIATION_SELECTORS, s)) selectorLen = utf8Len();
      }
      const end = index + len + selectorLen;
      let kind = TK_CJ_LETTER;
      if (isPunctuation(c)) kind = TK_CJK_PUNCTUATION;
      else if (isIn(HANGUL, c)) kind = TK_K_LETTER;
      const flags = kind === TK_CJK_PUNCTUATION ? TF_LEADING_PUNCT | TF_TRAILING_PUNCT : 0;
      swWord(tree, text, tStart, kind, index, end, flags);
      index = end;
      runStart = end;
    }
    swOtherWord(tree, text, tStart, runStart, wordEnd);
    index = wordEnd;
  }
}

// ---- blockquote markers

// The length of a `>` at the start of line[start, end), however it is written, with the blanks around it. -1: none.
function blockquoteMarkerLen(line: Uint8Array, start: number, end: number): number {
  let blanks = 0;
  while (start + blanks < end && isBlank(line[start + blanks] | 0)) blanks = blanks + 1;
  const r = start + blanks;
  let len = 0;
  if (r < end && (line[r] | 0) === 62) len = 1;
  else if (r + 1 < end && (line[r] | 0) === 92 && (line[r + 1] | 0) === 62) len = 2;
  else if (
    r + 3 < end &&
    (line[r] | 0) === 38 &&
    (((line[r + 1] | 0) === 103 && (line[r + 2] | 0) === 116) || ((line[r + 1] | 0) === 71 && (line[r + 2] | 0) === 84)) &&
    (line[r + 3] | 0) === 59
  ) {
    len = 4;
  } else {
    // `&#62;`, `&#x3e;`
    if (!(r + 1 < end && (line[r] | 0) === 38 && (line[r + 1] | 0) === 35)) return -1;
    const number = r + 2;
    if (number >= end) return -1;
    let digits = number;
    let prefix = 2;
    let hex = false;
    const nb = line[number] | 0;
    if (nb === 120 || nb === 88) {
      digits = number + 1;
      prefix = 3;
      hex = true;
    }
    let zeros = 0;
    while (digits + zeros < end && (line[digits + zeros] | 0) === 48) zeros = zeros + 1;
    const v = digits + zeros;
    if (v + 1 >= end) return -1;
    const a = line[v] | 0;
    const b = line[v + 1] | 0;
    const ok = hex ? a === 51 && (b === 101 || b === 69) : a === 54 && b === 50;
    if (!ok || v + 2 >= end || (line[v + 2] | 0) !== 59) return -1;
    len = prefix + zeros + 3;
  }
  let after = 0;
  while (r + len + after < end && isBlank(line[r + len + after] | 0)) after = after + 1;
  return blanks + len + after;
}

// How many references to a line break are in line[start, end): `&NewLine;`, `&#10;`, `&#xA;`, not escaped.
function countNewlineReferences(line: Uint8Array, start: number, end: number): number {
  let count = 0;
  let index = start;
  while (index < end) {
    if ((line[index] | 0) !== 38) {
      index = index + 1;
      continue;
    }
    const at = index;
    index = at + 1;
    let backslashes = 0;
    while (at - 1 - backslashes >= start && (line[at - 1 - backslashes] | 0) === 92) backslashes = backslashes + 1;
    if (backslashes % 2 === 1) continue;
    const rest = at + 1;
    let isNewline = false;
    if (indexOfAt(line, rest, end, "NewLine;")) isNewline = true;
    else if (rest < end && (line[rest] | 0) === 35) {
      let digits = rest + 1;
      let wanted = "10;";
      if (digits < end && ((line[digits] | 0) === 120 || (line[digits] | 0) === 88)) {
        digits = digits + 1;
        wanted = "a;";
      }
      let zeros = 0;
      while (digits + zeros < end && (line[digits + zeros] | 0) === 48) zeros = zeros + 1;
      const v = digits + zeros;
      if (v + wanted.length <= end) {
        let ok = true;
        for (let k = 0; k < wanted.length; k++) {
          let c = line[v + k] | 0;
          if (c >= 65 && c <= 90) c = c + 32;
          if (c !== wanted.charCodeAt(k)) ok = false;
        }
        isNewline = ok;
      }
    }
    if (isNewline) count = count + 1;
  }
  return count;
}

function indexOfAt(buf: Uint8Array, at: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (at + n > end) return false;
  for (let i = 0; i < n; i++) {
    if ((buf[at + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

const markerStarts = new Int32Array(1024);
let markerStartsBig: Int32Array = markerStarts;

// Prettier's `getBlockquoteRawText`: `raw` without the markers of the block quotes at the start of its lines, appended to `out`.
// `value`: what the text stands for, which tells how many `>` are its own.
function blockquoteRawText(raw: Uint8Array, rs: number, re: number, value: Uint8Array, vs: number, ve: number, out: ByteBuf): void {
  let vPos = vs;
  let rPos = rs;
  let index = 0;
  while (true) {
    const rLineEnd = lineEnd(raw, rPos, re);
    // the line of `value`
    const vLineStart = vPos;
    let vLineEnd = vPos;
    let vHas = vPos <= ve;
    if (vHas) vLineEnd = lineEnd(value, vPos, ve);
    if (vHas) vPos = vLineEnd < ve ? vLineEnd + 1 : ve + 1;
    const refs = countNewlineReferences(raw, rPos, rLineEnd);
    for (let k = 0; k < refs; k++) {
      if (vPos <= ve) {
        const e = lineEnd(value, vPos, ve);
        vPos = e < ve ? e + 1 : ve + 1;
      }
    }
    if (index === 0) {
      out.append(raw, rPos, rLineEnd);
    } else {
      out.push(10);
      let toKeep = 0;
      if (vHas) {
        for (let i = vLineStart; i < vLineEnd; i++) {
          const b = value[i] | 0;
          if (b === 62) toKeep = toKeep + 1;
          else if (b === 32 || b === 9) {
            // skip
          } else break;
        }
      }
      let n = 0;
      let position = rPos;
      while (true) {
        const len = blockquoteMarkerLen(raw, position, rLineEnd);
        if (len < 0) break;
        if (n === markerStartsBig.length) {
          const g = new Int32Array(n * 2);
          g.set(markerStartsBig);
          markerStartsBig = g;
        }
        markerStartsBig[n] = position | 0;
        n = n + 1;
        position = position + len;
      }
      let from = position;
      if (toKeep !== 0) {
        from = n >= toKeep ? markerStartsBig[n - toKeep] | 0 : rPos;
      }
      out.append(raw, from, rLineEnd);
    }
    if (rLineEnd >= re) break;
    rPos = rLineEnd + 1;
    index = index + 1;
  }
}

function lineEnd(buf: Uint8Array, from: number, end: number): number {
  let i = from;
  while (i < end && (buf[i] | 0) !== 10) i = ((i | 0) + 1) | 0;
  return i;
}

// `{ numberText, leadingSpaces }` of Prettier's `getOrderedListItemInfo`: the number of an item of an ordered list and how
// much white space is behind its marker.
class OrderedInfo {
  number: number = 0;
  spaces: number = 0;
}
export const oi: OrderedInfo = new OrderedInfo();

export function orderedItemInfo(text: Uint8Array, tree: Tree, item: number): void {
  oi.number = 0;
  oi.spaces = 0;
  if (item < 0 || item >= tree.n) return;
  const first = tree.firstChild[item] | 0;
  const end = first >= 0 ? tree.start[first] | 0 : tree.end[item] | 0;
  const start0 = tree.start[item] | 0;
  if (start0 > end || end > text.length) return;
  const start = trimJsWhitespaceStart(text, start0, end);
  let digits = 0;
  let number = 0;
  while (start + digits < end && isAsciiDigit(text[start + digits] | 0)) {
    number = number * 10 + ((text[start + digits] | 0) - 48);
    digits = digits + 1;
  }
  const afterStart = start + digits + 1;
  oi.number = number;
  if (afterStart <= end) {
    oi.spaces = trimJsWhitespaceStart(text, afterStart, end) - afterStart;
  }
}

// The number of an item of an ordered list.
export function orderedNumber(text: Uint8Array, tree: Tree, item: number): number {
  orderedItemInfo(text, tree, item);
  return oi.number;
}

// How much white space is behind the marker of an item of an ordered list.
export function orderedSpaces(text: Uint8Array, tree: Tree, item: number): number {
  orderedItemInfo(text, tree, item);
  return oi.spaces;
}

// Whether `code` is indented code, by the looks of it.
export function isIndentedCode(text: Uint8Array, tree: Tree, code: number): boolean {
  if (code < 0 || code >= tree.n || (tree.kind[code] | 0) !== K_CODE) return false;
  // oxfmt knows.
  if ((tree.number[code] | 0) === 1) return true;
  let s = tree.start[code] | 0;
  const e = tree.end[code] | 0;
  if (s > e || e > text.length) return false;
  if (s < e && (text[s] | 0) === 10) s = s + 1;
  if (s + 4 <= e && (text[s] | 0) === 32 && (text[s + 1] | 0) === 32 && (text[s + 2] | 0) === 32 && (text[s + 3] | 0) === 32) return true;
  return s < e && (text[s] | 0) === 9;
}

// ---- Preprocessor

const AR_ALIGNED_LISTS = 1;
const AR_BLOCKQUOTE = 2;
const AR_EMPHASIS = 4;
const AR_PARAGRAPH_IN_BLOCKQUOTE = 8;

const pre1 = new ByteBuf(256);
const pre2 = new ByteBuf(256);

export class Preprocessor {
  text: Uint8Array;
  // See `Printer::original`.
  original: Uint8Array;
  // Lines are wrapped: `proseWrap: "always"`.
  wrapsLines: boolean;
  isMdx: boolean;
  isForOxfmt: boolean;
  tree: Tree;
  tabWidth: number;
  stack: Stack;
  isNestedTooDeeply: boolean;
  // The text may have `[[` in it (false: it has not).
  mayHaveDoubleBracket: boolean;

  constructor(text: Uint8Array, original: Uint8Array, wrapsLines: boolean, isMdx: boolean, isForOxfmt: boolean, tree: Tree, tabWidth: number, mayHaveDoubleBracket: boolean) {
    this.mayHaveDoubleBracket = mayHaveDoubleBracket;
    this.text = text;
    this.original = original;
    this.wrapsLines = wrapsLines;
    this.isMdx = isMdx;
    this.isForOxfmt = isForOxfmt;
    this.tree = tree;
    this.tabWidth = tabWidth;
    this.stack = Stack.forTree();
    this.isNestedTooDeeply = false;
  }

  run(root: number): void {
    if (!this.isMdx) this.markRiskyParagraphs(root);
    this.visit(root, AR_ALIGNED_LISTS, NONE);
  }

  // A paragraph in which wrapping could make `[[` and `]]` a wiki link keeps its texts as they are. Such a paragraph has `spread`
  // set.
  markRiskyParagraphs(root: number): void {
    if (!this.mayHaveDoubleBracket) return;
    const tree = this.tree;
    const original = this.original;
    // In the order of the text. The paragraphs around the current node are on `open`, each with whether `[[` has been seen in it.
    const openNode: number[] = [];
    const openCan: boolean[] = [];
    const stack: number[] = [root, 0];
    while (stack.length > 0) {
      const isExit = stack.pop() as number;
      const id = stack.pop() as number;
      if (isExit === 1) {
        openNode.pop();
        openCan.pop();
        continue;
      }
      const kind = tree.kind[id] | 0;
      if (kind === K_WIKI_LINK) {
        for (let i = 0; i < openNode.length; i++) {
          if (openCan[i]) markSpread(tree, openNode[i] | 0);
        }
      } else if (kind === K_TEXT) {
        const s = tree.start[id] | 0;
        const e = tree.end[id] | 0;
        if (containsStr(original, s, e, "[[")) {
          for (let i = 0; i < openCan.length; i++) openCan[i] = true;
        }
        if (containsStr(original, s, e, "]]")) {
          for (let i = 0; i < openNode.length; i++) {
            if (openCan[i]) markSpread(tree, openNode[i] | 0);
          }
        }
      } else if (kind === K_PARAGRAPH) {
        openNode.push(id);
        openCan.push(false);
        stack.push(id);
        stack.push(1);
      }
      const first = stack.length;
      for (let c = tree.firstChild[id] | 0; c >= 0; c = tree.next[c] | 0) {
        stack.push(c);
        stack.push(0);
      }
      // reverse the pairs pushed
      let lo = first;
      let hi = stack.length - 2;
      while (lo < hi) {
        const a = stack[lo];
        const b = stack[lo + 1];
        stack[lo] = stack[hi];
        stack[lo + 1] = stack[hi + 1];
        stack[hi] = a;
        stack[hi + 1] = b;
        lo = lo + 2;
        hi = hi - 2;
      }
    }
  }

  // `paragraph`: the paragraph or heading that it is in (NONE: none); AR_PARAGRAPH_IN_BLOCKQUOTE says whether that is in a
  // block quote.
  visit(id: number, around0: number, paragraph0: number): void {
    if (!this.stack.enter()) {
      this.isNestedTooDeeply = true;
      return;
    }
    const tree = this.tree;
    let around = around0;
    let paragraph = paragraph0;
    const kind = tree.kind[id] | 0;
    if (kind === K_TEXT) {
      this.splitIntoSentence(id, around, paragraph);
      this.stack.leave();
      return;
    }
    if (kind === K_LIST && (tree.firstChild[id] | 0) >= 0) {
      const isAligned =
        (around & AR_ALIGNED_LISTS) !== 0 &&
        (this.isMdx || !isIndentedCode(this.original, tree, tree.next[id] | 0)) &&
        this.isAligned(id);
      around = isAligned ? around | AR_ALIGNED_LISTS : around & ~AR_ALIGNED_LISTS;
      // Prettier's `getNthListSiblingIndex`
      const previous = tree.previous[id] | 0;
      let nth = 0;
      if (previous >= 0 && (tree.kind[previous] | 0) === K_LIST && ((tree.flags[previous] | 0) & F_ORDERED) === ((tree.flags[id] | 0) & F_ORDERED)) {
        nth = (tree.firstAlign[previous] | 0) + 1;
      }
      tree.flags[id] = isAligned ? (tree.flags[id] | 0) | F_ALIGNED : (tree.flags[id] | 0) & ~F_ALIGNED;
      tree.firstAlign[id] = nth;
    } else if ((kind === K_PARAGRAPH || kind === K_HEADING) && paragraph < 0) {
      paragraph = id;
      around = (around & AR_BLOCKQUOTE) !== 0 ? around | AR_PARAGRAPH_IN_BLOCKQUOTE : around & ~AR_PARAGRAPH_IN_BLOCKQUOTE;
    } else if (kind === K_BLOCKQUOTE) {
      around = around | AR_BLOCKQUOTE;
    } else if (kind === K_EMPHASIS || kind === K_STRONG) {
      around = around | AR_EMPHASIS;
    } else if (
      kind === K_HTML &&
      this.isMdx &&
      !isInlineWrapper(tree.kindOf(tree.parent[id] | 0)) &&
      !this.hasComment(tree.value[id] | 0)
    ) {
      // Prettier's `htmlToJsx`
      tree.kind[id] = K_JSX;
    } else if (kind === K_CODE && this.isMdx && isIndentedCode(this.original, tree, id)) {
      // Prettier's `transformIndentedCodeblockAndMarkItsParentList`: `hasIndentedCodeblock` is `checked` here.
      let parent = tree.parent[id] | 0;
      while (parent >= 0) {
        if ((tree.kind[parent] | 0) === K_LIST) {
          if ((tree.checked[parent] | 0) !== 0) break;
          tree.checked[parent] = 1;
        }
        parent = tree.parent[parent] | 0;
      }
    }
    let child = tree.firstChild[id] | 0;
    while (child >= 0) {
      const next = tree.next[child] | 0;
      this.visit(child, around, paragraph);
      child = next;
    }
    this.stack.leave();
  }

  hasComment(value: number): boolean {
    const tree = this.tree;
    tree.resolve(value);
    return hasHtmlComment(tree.rBuf, tree.rStart, tree.rEnd);
  }

  // Prettier's `isAligned`
  isAligned(list: number): boolean {
    const tree = this.tree;
    const original = this.original;
    if (((tree.flags[list] | 0) & F_ORDERED) === 0) return true;
    const first = tree.firstChild[list] | 0;
    const second = first >= 0 ? tree.next[first] | 0 : NONE;
    // oxfmt: blanks behind the marker of an item that starts with indented code would be code.
    if (this.isForOxfmt) {
      let item = first;
      while (item >= 0) {
        if (isIndentedCode(original, tree, tree.firstChild[item] | 0)) return false;
        item = tree.next[item] | 0;
      }
    }
    if (orderedSpaces(original, tree, first) > 1) return true;
    const firstStart = this.itemStart(first);
    if (firstStart < 0) return false;
    const tabWidth = this.tabWidth < 1 ? 1 : this.tabWidth;
    if (second < 0) return firstStart % tabWidth === 0;
    if (firstStart !== this.itemStart(second)) return false;
    if (firstStart % tabWidth === 0) return true;
    return orderedSpaces(original, tree, second) > 1;
  }

  // The column that the content of an item starts in; -1: it has none.
  itemStart(item: number): number {
    const tree = this.tree;
    if (item < 0 || item >= tree.n) return -1;
    const child = tree.firstChild[item] | 0;
    if (child < 0) return -1;
    const cs = tree.start[child] | 0;
    if (cs >= 1) {
      const before = cs - 1;
      // mdast-util-gfm-task-list-item passes the character behind `[x]` by adding one to the column, also if it is a line break.
      if ((tree.checked[item] | 0) !== 0 && !this.isForOxfmt && before < this.original.length && (this.original[before] | 0) === 10) {
        return before - tree.lineStart(before) + 1;
      }
    }
    return cs - tree.lineStart(cs);
  }

  // Prettier's `splitTextIntoSentences`, for one text.
  splitIntoSentence(id: number, around: number, paragraph: number): void {
    const tree = this.tree;
    let buf = this.original;
    let ts = tree.start[id] | 0;
    let te = tree.end[id] | 0;
    let copied = false;
    if (paragraph >= 0 && (around & AR_PARAGRAPH_IN_BLOCKQUOTE) !== 0 && containsByte(buf, ts, te, 10)) {
      pre1.reset();
      tree.resolve(tree.value[id] | 0);
      blockquoteRawText(buf, ts, te, tree.rBuf, tree.rStart, tree.rEnd, pre1);
      buf = pre1.data;
      ts = 0;
      te = pre1.len;
      copied = true;
    }
    if (paragraph >= 0 && tree.kindOf(tree.parent[id] | 0) === K_PARAGRAPH) {
      if ((tree.previous[id] | 0) < 0) {
        while (ts < te && isAsciiWs(buf[ts] | 0)) ts = ts + 1;
      }
      if ((tree.next[id] | 0) < 0) {
        while (te > ts && isAsciiWs(buf[te - 1] | 0)) te = te - 1;
      }
    }

    // remark-parse 8 gives the characters that are meant, and Prettier's `restoreUnescapedCharacter` puts back how they are
    // written, except for `*` and `_`, which are escaped anew where they are written.
    if (this.isMdx && (containsStr(buf, ts, te, "\\*") || containsStr(buf, ts, te, "\\_"))) {
      pre2.reset();
      let index = ts;
      while (index < te) {
        const byte = buf[index] | 0;
        const next = index + 1 < te ? buf[index + 1] | 0 : -1;
        if (byte === 92 && (next === 42 || next === 95)) {
          pre2.push(next);
          index = index + 2;
        } else if (byte === 92 && next >= 0 && isAsciiPunct(next)) {
          pre2.push(byte);
          pre2.push(next);
          index = index + 2;
        } else {
          pre2.push(byte);
          index = index + 1;
        }
      }
      buf = pre2.data;
      ts = 0;
      te = pre2.len;
      copied = true;
    }

    // The strings are parts of the file, or of a copy if something has been taken out.
    let base: number;
    let baseStart: number;
    if (copied) {
      const at = tree.ownedBegin();
      tree.strings.append(buf, ts, te);
      base = tree.ownedEnd(at);
      baseStart = at;
    } else {
      base = tree.strSource(ts, te);
      baseStart = ts;
    }
    let isRisky = false;
    if (paragraph >= 0) {
      isRisky = (tree.kind[paragraph] | 0) === K_PARAGRAPH && ((tree.flags[paragraph] | 0) & F_SPREAD) !== 0;
    }
    if (isRisky) {
      tree.value[id] = base;
      return;
    }
    const inEmphasis = (around & AR_EMPHASIS) !== 0;
    // Without wrapping, words only matter where there is more to them than ASCII, and where they can get escapes.
    if (!this.wrapsLines && isAllAscii(buf, ts, te) && !((inEmphasis || this.isMdx) && hasStarOrUnderscore(buf, ts, te))) {
      tree.kind[id] = K_SENTENCE;
      tree.value[id] = base;
      tree.number[id] = PLAIN;
      tree.flags[id] = inEmphasis ? (tree.flags[id] | 0) | F_ALIGNED : (tree.flags[id] | 0) & ~F_ALIGNED;
      return;
    }
    const firstToken = tree.nTokens;
    splitText(tree, buf, ts, te, baseStart, copied);
    const count = tree.nTokens - firstToken;
    tree.kind[id] = K_SENTENCE;
    tree.firstAlign[id] = firstToken;
    tree.number[id] = count;
  }
}

function markSpread(tree: Tree, id: number): void {
  tree.flags[id] = (tree.flags[id] | 0) | F_SPREAD;
}

function hasStarOrUnderscore(buf: Uint8Array, s: number, e: number): boolean {
  for (let i = s; i < e; i++) {
    const b = buf[i] | 0;
    if (b === 42 || b === 95) return true;
  }
  return false;
}

export { STR_NO, indexOfStr, isAsciiAlpha };
