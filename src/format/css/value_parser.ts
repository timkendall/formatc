// Port of vendor/bun/src/format/css/value_parser.rs: `postcss-values-parser` 2.0.1 in loose mode (`lib/tokenize.js`,
// `lib/parser.js`), and what Prettier makes of its result (`parse/parse-value.js`).
//
// The positions that the parser gives its nodes are wrong in several ways. They are kept that way, since Prettier goes by
// them.
//
// `Values` is the arena of everything parsed so far (texts, nodes as SoA, lists), reused for the next node of the style
// sheet (`clear()`). A node is an id (0: none).
import { valueAtEnd, valueWordEnd, valueWordEndNum } from "./charsets.ts";
import { Stack } from "../../base/stack.ts";
import { ByteBuf } from "../../base/bytebuf.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  isDigitB,
  isHexB,
  isWsB,
  countByte,
  eqLit,
  endsWithLit,
  indexOfByteIn,
  indexOfLit,
  isAsciiAlphanumeric,
  startsWithLit,
} from "./misc.ts";
import { Selectors } from "./selector_parser.ts";
import { SYNTAX_LESS, SYNTAX_SCSS } from "./syntax.ts";

// ── token kinds
const T_SPACE = 0;
const T_COLON = 1;
const T_COMMA = 2;
const T_OPEN_BRACE = 3;
const T_CLOSE_BRACE = 4;
const T_OPEN_PAREN = 5;
const T_CLOSE_PAREN = 6;
const T_STRING = 7;
const T_ATWORD = 8;
const T_WORD = 9;
const T_OPERATOR = 10;
const T_COMMENT = 11;
const T_HASH = 12;
const T_UNICODE_RANGE = 13;
// token record: kind, pos, end, line, column, endLine, endColumn
const TS = 7;


// `ValueKind`
export const VK_ROOT = 0;
export const VK_VALUE = 1;
export const VK_WORD = 2;
export const VK_NUMBER = 3;
export const VK_STRING = 4;
export const VK_OPERATOR = 5;
export const VK_COLON = 6;
export const VK_COMMA = 7;
export const VK_COMMENT = 8;
export const VK_FUNC = 9;
export const VK_PAREN = 10;
export const VK_AT_WORD = 11;
export const VK_UNICODE_RANGE = 12;
export const VK_PAREN_GROUP = 13;
export const VK_COMMA_GROUP = 14;
/** A string in the `groups` of the parentheses of `url()`. */
export const VK_TEXT = 15;
/** What is in the parentheses of `selector()`. */
export const VK_SELECTOR = 16;
/** `value-unknown` */
export const VK_UNKNOWN = 17;

// `Before`
/** A group has no `raws`. */
export const BEFORE_NONE = 0;
export const BEFORE_EMPTY = 1;
export const BEFORE_SPACES = 2;

/** "There is none" for the locations. */
export const NONE = 2147483647;
const NO_BALANCE = -2147483648;

export class ValueParseError {}

function growI(a: Int32Array, cap: number): Int32Array {
  const n = new Int32Array(cap);
  n.set(a);
  return n;
}
function growU(a: Uint8Array, cap: number): Uint8Array {
  const n = new Uint8Array(cap);
  n.set(a);
  return n;
}

/** `number_prefix_len`: `/^[+-]?((\d+(\.\d*)?)|(\.\d+))([eE][+-]?\d+)?/`: the length of the match, or -1. */
export function numberPrefixLen(text: Uint8Array, s: number, e: number): number {
  let at = s;
  if (at < e) {
    const c = text[at] | 0;
    if (c === 43 || c === 45) at = at + 1;
  }
  const integer = digitsLen(text, at, e);
  if (integer > 0) {
    at = at + integer;
    if (at < e && (text[at] | 0) === 46) at = at + 1 + digitsLen(text, at + 1, e);
  } else if (at < e && (text[at] | 0) === 46 && digitsLen(text, at + 1, e) > 0) {
    at = at + 1 + digitsLen(text, at + 1, e);
  } else {
    return -1;
  }
  if (at < e) {
    const c = text[at] | 0;
    if (c === 101 || c === 69) {
      const sg = at + 1 < e ? text[at + 1] | 0 : 0;
      const sign = sg === 43 || sg === 45 ? 1 : 0;
      const exponent = digitsLen(text, at + 1 + sign, e);
      if (exponent > 0) at = at + 1 + sign + exponent;
    }
  }
  return at - s;
}

function digitsLen(text: Uint8Array, from: number, e: number): number {
  let i = from;
  while (i < e && isDigitB(text[i] | 0)) i = i + 1;
  return i - from;
}

function hasDelimiter(data: Uint8Array, a: number, b: number): boolean {
  return indexOfLit(data, a, b, "/*") >= 0 || indexOfLit(data, a, b, "*/") >= 0;
}

/** The index of the first occurrence of needle[ns, ne) in hay[hs, he), or -1. */
function indexOfBytes(hay: Uint8Array, hs: number, he: number, needle: Uint8Array, ns: number, ne: number): number {
  const n = ne - ns;
  if (n === 0) return hs;
  for (let i = hs; i + n <= he; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if ((hay[i + k] | 0) !== (needle[ns + k] | 0)) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function fixValueWordLoc(value: Uint8Array, s: number, e: number, index: number): number {
  const n = e - s;
  // b"-" | b"--" => index
  if (n === 1 && (value[s] | 0) === 45) return index;
  if (n === 2 && (value[s] | 0) === 45 && (value[s + 1] | 0) === 45) return index;
  if (n >= 2 && (value[s] | 0) === 45 && (value[s + 1] | 0) === 45) return index > 2 ? index - 2 : 0;
  if (n >= 1 && (value[s] | 0) === 45) return index > 1 ? index - 1 : 0;
  return index;
}

export class Values {
  /** The texts of the values, and the strings that are not a part of them. */
  text: ByteBuf;
  // nodes (SoA); 0 is the dummy
  kind: Uint8Array;
  firstByte: Uint8Array;
  vs: Int32Array;
  ve: Int32Array;
  unitS: Int32Array;
  unitE: Int32Array;
  isHex: Uint8Array;
  isColor: Uint8Array;
  inline: Uint8Array;
  before: Uint8Array;
  group: Int32Array;
  open: Int32Array;
  close: Int32Array;
  groupsS: Int32Array;
  groupsE: Int32Array;
  selector: Int32Array;
  locSourceIndex: Int32Array;
  locStartLine: Int32Array;
  locStartOffset: Int32Array;
  locEndOffset: Int32Array;
  hasEnd: Uint8Array;
  firstChild: Int32Array;
  lastChild: Int32Array;
  nextSibling: Int32Array;
  unbalanced: Int32Array;
  n: number;
  lists: Int32Array;
  nLists: number;
  // the tokens
  tokens: Int32Array;
  nTokens: number;
  unclosedParens: Int32Array;
  nUnclosed: number;
  /** `cache` of the parser */
  cache: Int32Array;
  nCache: number;
  // The groupers' stacks: open parens (open, groupsStart, groupStart), groups, group
  openParens: Int32Array;
  nOpenParens: number;
  groups: Int32Array;
  nGroups: number;
  groupStack: Int32Array;
  nGroupStack: number;
  // The parser's state
  base: number;
  len: number;
  rootOffset: number;
  position: number;
  current: number;
  spaces: boolean;
  lineNo: number;
  lineIndex: number;
  // The grouper's state
  isUnbalanced: boolean;
  syntax: number;
  stack: Stack;
  selectors: Selectors;

  constructor() {
    this.text = new ByteBuf(256);
    const cap = 64;
    this.kind = new Uint8Array(cap);
    this.firstByte = new Uint8Array(cap);
    this.vs = new Int32Array(cap);
    this.ve = new Int32Array(cap);
    this.unitS = new Int32Array(cap);
    this.unitE = new Int32Array(cap);
    this.isHex = new Uint8Array(cap);
    this.isColor = new Uint8Array(cap);
    this.inline = new Uint8Array(cap);
    this.before = new Uint8Array(cap);
    this.group = new Int32Array(cap);
    this.open = new Int32Array(cap);
    this.close = new Int32Array(cap);
    this.groupsS = new Int32Array(cap);
    this.groupsE = new Int32Array(cap);
    this.selector = new Int32Array(cap);
    this.locSourceIndex = new Int32Array(cap);
    this.locStartLine = new Int32Array(cap);
    this.locStartOffset = new Int32Array(cap);
    this.locEndOffset = new Int32Array(cap);
    this.hasEnd = new Uint8Array(cap);
    this.firstChild = new Int32Array(cap);
    this.lastChild = new Int32Array(cap);
    this.nextSibling = new Int32Array(cap);
    this.unbalanced = new Int32Array(cap);
    this.n = 0;
    this.lists = new Int32Array(64);
    this.nLists = 0;
    this.tokens = new Int32Array(TS * 32);
    this.nTokens = 0;
    this.unclosedParens = new Int32Array(16);
    this.nUnclosed = 0;
    this.cache = new Int32Array(16);
    this.nCache = 0;
    this.openParens = new Int32Array(3 * 16);
    this.nOpenParens = 0;
    this.groups = new Int32Array(32);
    this.nGroups = 0;
    this.groupStack = new Int32Array(32);
    this.nGroupStack = 0;
    this.base = 0;
    this.len = 0;
    this.rootOffset = 0;
    this.position = 0;
    this.current = 0;
    this.spaces = false;
    this.lineNo = 1;
    this.lineIndex = 0;
    this.isUnbalanced = false;
    this.syntax = 0;
    this.stack = Stack.create();
    this.selectors = new Selectors();
  }

  /** Forgets all values. */
  clear(): void {
    this.text.len = 0;
    this.n = 0;
    this.nLists = 0;
  }

  private growNodes(): void {
    const cap = this.kind.length * 2;
    this.kind = growU(this.kind, cap);
    this.firstByte = growU(this.firstByte, cap);
    this.vs = growI(this.vs, cap);
    this.ve = growI(this.ve, cap);
    this.unitS = growI(this.unitS, cap);
    this.unitE = growI(this.unitE, cap);
    this.isHex = growU(this.isHex, cap);
    this.isColor = growU(this.isColor, cap);
    this.inline = growU(this.inline, cap);
    this.before = growU(this.before, cap);
    this.group = growI(this.group, cap);
    this.open = growI(this.open, cap);
    this.close = growI(this.close, cap);
    this.groupsS = growI(this.groupsS, cap);
    this.groupsE = growI(this.groupsE, cap);
    this.selector = growI(this.selector, cap);
    this.locSourceIndex = growI(this.locSourceIndex, cap);
    this.locStartLine = growI(this.locStartLine, cap);
    this.locStartOffset = growI(this.locStartOffset, cap);
    this.locEndOffset = growI(this.locEndOffset, cap);
    this.hasEnd = growU(this.hasEnd, cap);
    this.firstChild = growI(this.firstChild, cap);
    this.lastChild = growI(this.lastChild, cap);
    this.nextSibling = growI(this.nextSibling, cap);
    this.unbalanced = growI(this.unbalanced, cap);
  }

  /** `ValueNode::new(kind)` pushed. */
  pushNode(kind: number): number {
    if (this.n === this.kind.length) this.growNodes();
    const id = this.n;
    this.n = id + 1;
    this.kind[id] = kind | 0;
    this.firstByte[id] = 0;
    this.vs[id] = 0;
    this.ve[id] = 0;
    this.unitS[id] = 0;
    this.unitE[id] = 0;
    this.isHex[id] = 0;
    this.isColor[id] = 0;
    this.inline[id] = 0;
    this.before[id] = BEFORE_NONE;
    this.group[id] = 0;
    this.open[id] = 0;
    this.close[id] = 0;
    this.groupsS[id] = 0;
    this.groupsE[id] = 0;
    this.selector[id] = 0;
    this.locSourceIndex[id] = NONE;
    this.locStartLine[id] = NONE;
    this.locStartOffset[id] = NONE;
    this.locEndOffset[id] = NONE;
    this.hasEnd[id] = 0;
    this.firstChild[id] = 0;
    this.lastChild[id] = 0;
    this.nextSibling[id] = 0;
    this.unbalanced[id] = NO_BALANCE;
    return id;
  }

  // ── lists
  private reserveLists(extra: number): void {
    if (this.nLists + extra > this.lists.length) {
      let cap = this.lists.length;
      while (cap < this.nLists + extra) cap = cap * 2;
      this.lists = growI(this.lists, cap);
    }
  }
  /** Adds a list of one id. Returns the start; the end is start + 1. */
  addList1(id: number): number {
    this.reserveLists(1);
    const s = this.nLists;
    this.lists[s] = id | 0;
    this.nLists = s + 1;
    return s;
  }
  /** Moves `group[from..]` to the lists. Returns the start (the end is nLists). */
  addListFromGroup(from: number): number {
    const count = this.nGroupStack - from;
    this.reserveLists(count);
    const s = this.nLists;
    for (let i = 0; i < count; i++) this.lists[s + i] = this.groupStack[from + i] | 0;
    this.nLists = s + count;
    this.nGroupStack = from;
    return s;
  }
  addListFromGroups(from: number): number {
    const count = this.nGroups - from;
    this.reserveLists(count);
    const s = this.nLists;
    for (let i = 0; i < count; i++) this.lists[s + i] = this.groups[from + i] | 0;
    this.nLists = s + count;
    this.nGroups = from;
    return s;
  }

  private pushGroupItem(id: number): void {
    if (this.nGroupStack === this.groupStack.length) this.groupStack = growI(this.groupStack, this.groupStack.length * 2);
    this.groupStack[this.nGroupStack] = id | 0;
    this.nGroupStack = this.nGroupStack + 1;
  }
  private pushGroupsItem(id: number): void {
    if (this.nGroups === this.groups.length) this.groups = growI(this.groups, this.groups.length * 2);
    this.groups[this.nGroups] = id | 0;
    this.nGroups = this.nGroups + 1;
  }
  private pushOpenParen(open: number, groupsStart: number, groupStart: number): void {
    if ((this.nOpenParens + 1) * 3 > this.openParens.length) this.openParens = growI(this.openParens, this.openParens.length * 2);
    const o = this.nOpenParens * 3;
    this.openParens[o] = open | 0;
    this.openParens[o + 1] = groupsStart | 0;
    this.openParens[o + 2] = groupStart | 0;
    this.nOpenParens = this.nOpenParens + 1;
  }
  private pushCache(id: number): void {
    if (this.nCache === this.cache.length) this.cache = growI(this.cache, this.cache.length * 2);
    this.cache[this.nCache] = id | 0;
    this.nCache = this.nCache + 1;
  }
  private pushUnclosed(v: number): void {
    if (this.nUnclosed === this.unclosedParens.length) this.unclosedParens = growI(this.unclosedParens, this.unclosedParens.length * 2);
    this.unclosedParens[this.nUnclosed] = v | 0;
    this.nUnclosed = this.nUnclosed + 1;
  }

  /** `add_text`: appends a text; returns its start (the end is `text.len`). */
  addTextFrom(src: Uint8Array, s: number, e: number): number {
    const at = this.text.len;
    this.text.append(src, s, e);
    return at;
  }

  // ── queries

  /** `Values::value(id)` exists (`Some`). */
  hasValueText(id: number): boolean {
    const k = this.kind[id] | 0;
    return !(k === VK_ROOT || k === VK_VALUE || k === VK_PAREN_GROUP || k === VK_COMMA_GROUP || k === VK_TEXT || k === VK_SELECTOR);
  }

  /** Whether the node `id` has a `source` after `calculateLoc`. */
  hasSource(id: number): boolean {
    return (this.locStartOffset[id] | 0) !== NONE || (this.hasEnd[id] | 0) !== 0;
  }

  /** A group with nothing in it, which nothing says where it is. */
  isEmptyGroup(id: number): boolean {
    const k = this.kind[id] | 0;
    return (k === VK_PAREN_GROUP || k === VK_COMMA_GROUP) && (this.groupsS[id] | 0) === (this.groupsE[id] | 0) && !this.hasSource(id);
  }

  /** How many blanks follow its `value` in the text. */
  blanksBehind(id: number): number {
    const d = this.text.data;
    let i = this.ve[id] | 0;
    const n = this.text.len;
    let c = 0;
    while (i < n && isWsB(d[i] | 0)) {
      i = i + 1;
      c = c + 1;
    }
    return c;
  }

  /** Whether something that is no blank follows its `value` in the text. */
  isBeforeMore(id: number): boolean {
    const d = this.text.data;
    let i = this.ve[id] | 0;
    const n = this.text.len;
    while (i < n && isWsB(d[i] | 0)) i = i + 1;
    return i < n;
  }

  /** The number of `groups` of the node. */
  groupCount(id: number): number {
    return (this.groupsE[id] | 0) - (this.groupsS[id] | 0);
  }

  /** `node.groups[index]` (0 if there is none). */
  groupAt(id: number, index: number): number {
    const s = this.groupsS[id] | 0;
    if (index < 0 || index >= (this.groupsE[id] | 0) - s) return 0;
    return this.lists[s + index] | 0;
  }

  // ───────────────────────────── the tokenizer ─────────────────────────────

  private pushToken(kind: number, pos: number, end: number, line: number, column: number, endLine: number, endColumn: number): void {
    if ((this.nTokens + 1) * TS > this.tokens.length) this.tokens = growI(this.tokens, this.tokens.length * 2);
    const o = this.nTokens * TS;
    const t = this.tokens;
    t[o] = kind | 0;
    t[o + 1] = pos | 0;
    t[o + 2] = end | 0;
    t[o + 3] = line | 0;
    t[o + 4] = column | 0;
    t[o + 5] = endLine | 0;
    t[o + 6] = endColumn | 0;
    this.nTokens = this.nTokens + 1;
  }

  /** The index of the first character from `from` on that ends a word (-1: none). A `/` does if `slash` says so: for
   * numbers always, else if `*` follows. */
  private wordEnd(css: Uint8Array, s: number, e: number, from: number, isNumber: boolean): number {
    let at = from;
    while (true) {
      let f = s + at;
      if (isNumber) {
        while (f < e && !valueWordEndNum(css[f] | 0)) f = f + 1;
      } else {
        while (f < e && !valueWordEnd(css[f] | 0)) f = f + 1;
      }
      if (f >= e) return -1;
      at = f - s;
      if ((css[s + at] | 0) !== 47 || isNumber || (at + 1 < e - s && (css[s + at + 1] | 0) === 42)) return at;
      at = at + 1;
    }
  }

  /** Tokens of css[s, e). Returns false on error. */
  private tokenize(css: Uint8Array, s: number, e: number): boolean {
    this.nTokens = 0;
    this.nUnclosed = 0;
    const length = e - s;
    // The position of the last line break, which is -1 at first: all columns are one more.
    let offset = -1;
    let line = 1;
    let pos = 0;
    let parenCount = 0;
    let isUrlArg = false;

    while (pos < length) {
      const code = css[s + pos] | 0;
      if (code === 10) {
        offset = pos;
        line = line + 1;
      }
      const startLine = line;
      const startColumn = pos - offset;
      let kind: number;
      let end: number;
      let next: number;
      switch (code) {
        case 10: case 32: case 9: case 13: case 12: {
          let at = pos + 1;
          while (at < length && isWsB(css[s + at] | 0)) {
            if ((css[s + at] | 0) === 10) {
              offset = at;
              line = line + 1;
            }
            at = at + 1;
          }
          kind = T_SPACE;
          end = at;
          next = at;
          break;
        }
        case 58: kind = T_COLON; end = pos + 1; next = pos + 1; break;
        case 44: kind = T_COMMA; end = pos + 1; next = pos + 1; break;
        case 123: kind = T_OPEN_BRACE; end = pos + 1; next = pos + 1; break;
        case 125: kind = T_CLOSE_BRACE; end = pos + 1; next = pos + 1; break;
        case 40: {
          parenCount = parenCount + 1;
          this.pushUnclosed(this.nTokens);
          let lastIsUrl = false;
          if (this.nTokens > 0) {
            const lo = (this.nTokens - 1) * TS;
            if ((this.tokens[lo] | 0) === T_WORD) lastIsUrl = eqLit(css, s + (this.tokens[lo + 1] | 0), s + (this.tokens[lo + 2] | 0), "url");
          }
          isUrlArg = !isUrlArg && parenCount === 1 && lastIsUrl;
          kind = T_OPEN_PAREN;
          end = pos + 1;
          next = pos + 1;
          break;
        }
        case 41:
          parenCount = parenCount - 1;
          if (this.nUnclosed > 0) this.nUnclosed = this.nUnclosed - 1;
          isUrlArg = isUrlArg && parenCount > 0;
          kind = T_CLOSE_PAREN;
          end = pos + 1;
          next = pos + 1;
          break;
        case 39: case 34: {
          let close = pos;
          while (true) {
            const f = indexOfByteIn(css, s + close + 1, e, code);
            if (f < 0) return false;
            close = f - s;
            let backslashes = 0;
            while (close - 1 - backslashes >= 0 && (css[s + close - 1 - backslashes] | 0) === 92) backslashes = backslashes + 1;
            if (backslashes % 2 === 0) break;
          }
          kind = T_STRING;
          end = close + 1;
          next = close;
          break;
        }
        case 64: {
          let f = s + pos + 1;
          while (f < e && !valueAtEnd(css[f] | 0)) f = f + 1;
          if (f >= e) f = -1;
          const at = f < 0 ? length : f - s;
          kind = T_ATWORD;
          end = at;
          next = at - 1;
          break;
        }
        case 92:
          kind = T_WORD;
          end = pos + 1;
          next = pos;
          break;
        case 43: case 45: case 42:
          if (code === 45 && pos + 1 < length && (css[s + pos + 1] | 0) === 45) {
            kind = T_WORD;
            end = pos + 2;
            next = pos + 2;
          } else {
            kind = T_OPERATOR;
            end = pos + 1;
            next = pos + 1;
          }
          break;
        default: {
          const n1 = pos + 1 < length ? css[s + pos + 1] | 0 : -1;
          if (code === 47 && (n1 === 42 || (!isUrlArg && n1 === 47))) {
            let last: number;
            if (n1 === 42) {
              const f = indexOfLit(css, s + pos + 2, e, "*/");
              if (f < 0) return false;
              last = f - s + 1;
            } else {
              const f = indexOfByteIn(css, s + pos + 2, e, 10);
              last = f < 0 ? length : f - s - 1;
            }
            const contentEnd = last + 1 < length ? last + 1 : length;
            const lines = countByte(css, s + pos, s + contentEnd, 10);
            if (lines > 0) {
              let lastNl = 0;
              for (let i = contentEnd - 1; i >= pos; i--) {
                if ((css[s + i] | 0) === 10) { lastNl = i - pos; break; }
              }
              const lastLineLen = contentEnd - pos - 1 - lastNl;
              line = line + lines;
              offset = last - lastLineLen;
            }
            kind = T_COMMENT;
            end = contentEnd;
            next = last;
          } else if (code === 35 && !(pos + 1 < length && isAsciiAlphanumeric(css[s + pos + 1] | 0))) {
            kind = T_HASH;
            end = pos + 1;
            next = pos + 1;
          } else if ((code === 117 || code === 85) && n1 === 43) {
            let at = pos + 3;
            while (at < length) {
              const c = css[s + at] | 0;
              if (isHexB(c) || c === 63 || c === 45) at = at + 1;
              else break;
            }
            const cap = length > pos + 3 ? length : pos + 3;
            if (at > cap) at = cap;
            kind = T_UNICODE_RANGE;
            end = at < length ? at : length;
            next = at;
          } else if (code === 47) {
            kind = T_OPERATOR;
            end = pos + 1;
            next = pos + 1;
          } else {
            const isNumber = isDigitB(code);
            const f1 = this.wordEnd(css, s, e, pos + 1, isNumber);
            let last = f1 < 0 ? length - 1 : f1 - 1;
            // `1e-10`, `1e+10`
            if (isNumber || code === 46) {
              const le = last < length ? css[s + last] | 0 : -1;
              const l1 = last + 1 < length ? css[s + last + 1] | 0 : -1;
              const l2 = last + 2 < length ? css[s + last + 2] | 0 : -1;
              if ((le === 101 || le === 69) && (l1 === 45 || l1 === 43) && l2 >= 48 && l2 <= 57) {
                const f2 = this.wordEnd(css, s, e, last + 2, true);
                last = f2 < 0 ? length - 1 : f2 - 1;
              }
            }
            kind = T_WORD;
            end = last + 1;
            next = last;
          }
          break;
        }
      }
      this.pushToken(kind, pos, end, kind === T_SPACE ? line : startLine, startColumn, line, next - offset);
      pos = end;
    }
    return true;
  }

  // ───────────────────────────── the parser ─────────────────────────────

  private tkKind(position: number): number {
    return position >= 0 && position < this.nTokens ? this.tokens[position * TS] | 0 : -1;
  }

  private lastOfCurrent(): number {
    return this.lastChild[this.current] | 0;
  }

  /** `new_node`: a node under the current container. `srcIndex`, `startLine`, `endLine`, `endColumn`: what `Source` says. */
  private newNode(kind: number, vs: number, ve: number, srcIndex: number, startLine: number, endLine: number, endColumn: number): number {
    // `calculateNodeLoc`
    const end = endLine === 1 ? endColumn : this.lineColumnToIndex(endLine, endColumn);
    let startPos: number;
    let endPos: number;
    if (kind === VK_WORD) {
      startPos = fixValueWordLoc(this.text.data, vs, ve, srcIndex);
      endPos = fixValueWordLoc(this.text.data, vs, ve, end);
    } else if (kind === VK_PAREN) {
      startPos = srcIndex;
      endPos = srcIndex + (ve - vs === 1 && (this.text.data[vs] | 0) === 41 ? 1 : 0);
    } else {
      startPos = srcIndex;
      endPos = end;
    }
    const maxEnd = this.rootOffset + this.len;
    const id = this.pushNode(kind);
    this.firstByte[id] = ve > vs ? this.text.data[vs] | 0 : 0;
    this.hasEnd[id] = 1;
    this.vs[id] = vs;
    this.ve[id] = ve;
    this.before[id] = this.spaces ? BEFORE_SPACES : BEFORE_EMPTY;
    this.spaces = false;
    this.locSourceIndex[id] = srcIndex;
    this.locStartLine[id] = startLine;
    const so = startPos + this.rootOffset;
    const eo = endPos + this.rootOffset;
    this.locStartOffset[id] = so < maxEnd ? so : maxEnd;
    this.locEndOffset[id] = eo < maxEnd ? eo : maxEnd;
    this.unbalanced[id] = kind === VK_FUNC ? -1 : NO_BALANCE;
    const current = this.current;
    const previous = this.lastChild[current] | 0;
    this.lastChild[current] = id;
    if (previous === 0) this.firstChild[current] = id;
    else this.nextSibling[previous] = id;
    return id;
  }

  /** It goes on from the line that it was asked about before, if that is not a later one: a value of n lines has n nodes. */
  private lineColumnToIndex(line: number, column: number): number {
    let from = 1;
    let index = 0;
    if (this.lineNo <= line) {
      from = this.lineNo;
      index = this.lineIndex;
    }
    const data = this.text.data;
    const base = this.base;
    const len = this.len;
    for (let l = from; l < line; l++) {
      const f = indexOfByteIn(data, base + index, base + len, 10);
      index = f < 0 ? 0 : f - base + 1;
    }
    this.lineNo = line > 1 ? line : 1;
    this.lineIndex = index;
    return index + column;
  }

  /** A node whose value is the text of the token at index `t` (record offset `o`). */
  private simple(kind: number, o: number): void {
    const tk = this.tokens;
    const vs = this.base + (tk[o + 1] | 0);
    const ve = this.base + (tk[o + 2] | 0);
    this.newNode(kind, vs, ve, tk[o + 1] | 0, tk[o + 3] | 0, tk[o + 5] | 0, tk[o + 6] | 0);
    this.position = this.position + 1;
  }

  /** Returns false on error. */
  private parseTokens(): boolean {
    while (this.position < this.nTokens) {
      const o = this.position * TS;
      const kind = this.tokens[o] | 0;
      const start = this.tokens[o + 1] | 0;
      const end = this.tokens[o + 2] | 0;
      switch (kind) {
        case T_SPACE:
          if (!this.space()) return false;
          break;
        case T_COLON:
          this.simple(VK_COLON, o);
          break;
        case T_COMMA:
          this.simple(VK_COMMA, o);
          break;
        case T_COMMENT: {
          // `.replace(/\/\*|\*\//g, "")`
          const data = this.text.data;
          const ts = this.base + start;
          const te = this.base + end;
          let vs: number;
          let ve: number;
          if (te - ts >= 4 && startsWithLit(data, ts, te, "/*") && endsWithLit(data, ts, te, "*/") && !hasDelimiter(data, ts + 2, te - 2)) {
            vs = ts + 2;
            ve = te - 2;
          } else if (!hasDelimiter(data, ts, te)) {
            vs = ts;
            ve = te;
          } else {
            const at = this.text.len;
            let i = ts;
            while (i < te) {
              const b0 = this.text.data[i] | 0;
              const b1 = i + 1 < te ? this.text.data[i + 1] | 0 : -1;
              if ((b0 === 47 && b1 === 42) || (b0 === 42 && b1 === 47)) {
                i = i + 2;
              } else {
                this.text.push(b0);
                i = i + 1;
              }
            }
            vs = at;
            ve = this.text.len;
          }
          const inline = ve - vs >= 2 && (this.text.data[vs] | 0) === 47 && (this.text.data[vs + 1] | 0) === 47;
          if (inline) vs = vs + 2;
          const tk = this.tokens;
          const id = this.newNode(VK_COMMENT, vs, ve, tk[o + 1] | 0, tk[o + 3] | 0, tk[o + 5] | 0, tk[o + 6] | 0);
          this.inline[id] = inline ? 1 : 0;
          this.position = this.position + 1;
          break;
        }
        case T_OPEN_PAREN:
          if (!this.parenOpen(o)) return false;
          break;
        case T_CLOSE_PAREN:
          if (!this.parenClose(o)) return false;
          break;
        case T_OPERATOR:
          if (!this.operator(o)) return false;
          break;
        case T_STRING: {
          // The quotes are `raws.quote`.
          const tk = this.tokens;
          this.newNode(VK_STRING, this.base + start + 1, this.base + end - 1, tk[o + 1] | 0, tk[o + 3] | 0, tk[o + 5] | 0, tk[o + 6] | 0);
          this.position = this.position + 1;
          break;
        }
        case T_UNICODE_RANGE:
          this.simple(VK_UNICODE_RANGE, o);
          break;
        default:
          this.splitWord();
          break;
      }
    }
    return true;
  }

  private space(): boolean {
    const nextKind = this.tkKind(this.position + 1);
    if (nextKind < 0 || nextKind === T_CLOSE_PAREN) {
      // It is added to the `raws.after` of the last node, which has to be there.
      if (this.lastOfCurrent() === 0) return false;
    } else {
      this.spaces = true;
    }
    this.position = this.position + 1;
    return true;
  }

  private operator(o: number): boolean {
    const tk = this.tokens;
    const s = this.base + (tk[o + 1] | 0);
    const e = this.base + (tk[o + 2] | 0);
    const data = this.text.data;
    if (e - s === 1 && ((data[s] | 0) === 43 || (data[s] | 0) === 45)) {
      const last = this.lastOfCurrent();
      const isSign = last === 0 ? true : (this.kind[last] | 0) === VK_OPERATOR;
      if (isSign) {
        const nk = this.tkKind(this.position + 1);
        if (nk < 0) return false;
        if (nk === T_WORD) {
          this.splitWord();
          return true;
        }
      }
    }
    // `this.currToken[4]`, which is a line.
    this.newNode(VK_OPERATOR, s, e, tk[o + 5] | 0, tk[o + 3] | 0, tk[o + 3] | 0, tk[o + 4] | 0);
    this.position = this.position + 1;
    return true;
  }

  private parenOpen(o: number): boolean {
    // `unclosed_parens.binary_search(&position)`
    let lo = 0;
    let hi = this.nUnclosed;
    const position = this.position;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const v = this.unclosedParens[mid] | 0;
      if (v === position) return false;
      if (v < position) lo = mid + 1;
      else hi = mid;
    }
    const last = this.lastOfCurrent();
    if (last !== 0 && (this.kind[last] | 0) === VK_FUNC && (this.unbalanced[last] | 0) < 0) {
      this.unbalanced[last] = 0;
      this.current = last;
    }
    const current = this.current;
    if ((this.unbalanced[current] | 0) !== NO_BALANCE) this.unbalanced[current] = (this.unbalanced[current] | 0) + 1;
    this.simple(VK_PAREN, o);
    return true;
  }

  private parenClose(o: number): boolean {
    this.simple(VK_PAREN, o);
    const current = this.current;
    const ub = this.unbalanced[current] | 0;
    if (this.position + 1 >= this.nTokens && (ub === NO_BALANCE || ub === 0)) return true;
    if (ub !== NO_BALANCE) {
      this.unbalanced[current] = ub - 1;
      if (ub - 1 < 0) return false;
    }
    const ub2 = this.unbalanced[current] | 0;
    if ((ub2 === NO_BALANCE || ub2 === 0) && this.nCache > 0) {
      this.nCache = this.nCache - 1;
      this.current = this.cache[this.nCache] | 0;
    }
    return true;
  }

  private splitWord(): void {
    if (this.position >= this.nTokens) return;
    const tk = this.tokens;
    let o = this.position * TS;
    const wordStart = tk[o + 1] | 0;
    // `/^(?!#([a-z0-9]+))[#{}]/i`
    const data = this.text.data;
    const base = this.base;
    const firstS = base + wordStart;
    const firstE = base + (tk[o + 2] | 0);
    let noFollow = false;
    if (firstE > firstS) {
      const c = data[firstS] | 0;
      if (c === 123 || c === 125) noFollow = true;
      else if (c === 35) noFollow = !(firstE > firstS + 1 && isAsciiAlphanumeric(data[firstS + 1] | 0));
    }
    if (!noFollow) {
      while (this.tkKind(this.position + 1) === T_WORD) this.position = this.position + 1;
    }
    // The positions are taken from the last token, as if the word started there.
    o = this.position * TS;
    const curPos = tk[o + 1] | 0;
    const curEnd = tk[o + 2] | 0;
    const curLine = tk[o + 3] | 0;
    const curColumn = tk[o + 4] | 0;
    const curEndLine = tk[o + 5] | 0;
    const nextIsParen = this.tkKind(this.position + 1) === T_OPEN_PAREN;
    const wordLen = curEnd - wordStart;
    const isNumber = numberPrefixLen(data, base + curPos, base + curEnd) >= 0;

    // It is split before every `@` but one at the start.
    let ind = 0;
    while (true) {
      const wordS = base + wordStart;
      let index = wordLen;
      for (let i = wordS + ind + 1; i < wordS + wordLen; i++) {
        if ((data[i] | 0) === 64) { index = i - wordS; break; }
      }
      const vs0 = wordS + ind;
      const ve0 = wordS + index;
      const start = wordStart + ind;
      const end = wordStart + index;
      void start;
      void end;
      const srcIndex = curPos + ind;
      const endColumn = curColumn + index > 0 ? curColumn + index - 1 : 0;
      if ((data[vs0] | 0) === 64 && ve0 > vs0) {
        this.newNode(VK_AT_WORD, vs0 + 1, ve0, srcIndex, curLine, curEndLine, endColumn);
      } else if (isNumber) {
        const unitStartOff = numberPrefixLen(data, vs0, ve0);
        const unitOff = unitStartOff < 0 ? 0 : unitStartOff;
        const unitS = vs0 + unitOff;
        const unitLen = ve0 - unitS;
        // `value.replace(unit, "")` removes the first occurrence, wherever it is. It can only start earlier with what can
        // be in a number.
        let isElsewhere = false;
        if (unitLen > 0) {
          const u = data[unitS] | 0;
          isElsewhere = u === 43 || u === 45 || u === 46 || u === 101 || u === 69 || (u >= 48 && u <= 57);
        }
        let at = -1;
        if (isElsewhere) at = indexOfBytes(data, vs0, ve0, data, unitS, ve0);
        let numS: number;
        let numE: number;
        if (at >= 0 && unitLen > 0 && at - vs0 !== unitOff) {
          // value[..at] + value[at + unit.len()..]
          const t0 = this.text.len;
          this.text.append(data, vs0, at);
          this.text.append(this.text.data, at + unitLen, ve0);
          numS = t0;
          numE = this.text.len;
        } else {
          numS = vs0;
          numE = unitS;
        }
        const id = this.newNode(VK_NUMBER, numS, numE, srcIndex, curLine, curEndLine, endColumn);
        this.unitS[id] = unitS;
        this.unitE[id] = ve0;
      } else if (nextIsParen) {
        this.pushCache(this.current);
        this.newNode(VK_FUNC, vs0, ve0, srcIndex, curLine, curEndLine, endColumn);
      } else {
        const n = ve0 - vs0;
        const isHex = n > 1 && (data[vs0] | 0) === 35;
        let isColor = false;
        if (isHex && (n === 4 || n === 5 || n === 7 || n === 9)) {
          isColor = true;
          for (let i = vs0 + 1; i < ve0; i++) {
            if (!isHexB(data[i] | 0)) { isColor = false; break; }
          }
        }
        const id = this.newNode(VK_WORD, vs0, ve0, srcIndex, curLine, curEndLine, endColumn);
        this.isHex[id] = isHex ? 1 : 0;
        this.isColor[id] = isColor ? 1 : 0;
      }
      if (index === wordLen) break;
      ind = index;
    }
    this.position = this.position + 1;
  }

  // ───────────────────────────── Prettier's `parse-value.js` ─────────────────────────────

  private addGroup(id: number): void {
    // `id` is a group node with `open`, `close`, `groups` set and its loc empty. Computes the loc from the children, and
    // `fillEmptyChildLocs`.
    const open = this.open[id] | 0;
    const close = this.close[id] | 0;
    const gs = this.groupsS[id] | 0;
    const ge = this.groupsE[id] | 0;
    let hasEmptyGroup = false;
    const count = (open !== 0 ? 1 : 0) + (close !== 0 ? 1 : 0) + (ge - gs);
    for (let k = 0; k < count; k++) {
      const child = this.childOfGroup(open, close, gs, k);
      if (this.isEmptyGroup(child)) hasEmptyGroup = true;
      const start = this.locStartOffset[child] | 0;
      const end = this.locEndOffset[child] | 0;
      if (start !== NONE && end !== NONE) {
        // The first time, it is before `NONE`.
        if (start < (this.locStartOffset[id] | 0)) {
          this.locStartLine[id] = this.locStartLine[child] | 0;
          this.locStartOffset[id] = start;
        }
        if ((this.locEndOffset[id] | 0) === NONE || end > (this.locEndOffset[id] | 0)) this.locEndOffset[id] = end;
      }
    }
    if (hasEmptyGroup && (this.locStartOffset[id] | 0) !== NONE) {
      for (let k = 0; k < count; k++) {
        const child = this.childOfGroup(open, close, gs, k);
        this.fillEmptyLoc(child, id);
      }
    }
  }

  private childOfGroup(open: number, close: number, gs: number, k: number): number {
    let i = k;
    if (open !== 0) {
      if (i === 0) return open;
      i = i - 1;
    }
    if (close !== 0) {
      if (i === 0) return close;
      i = i - 1;
    }
    return this.lists[gs + i] | 0;
  }

  /** `fillEmptyLocFromParent`: `parent` is a node whose loc is used. */
  fillEmptyLoc(child: number, parent: number): void {
    if (this.isEmptyGroup(child) && (this.locEndOffset[parent] | 0) !== NONE) {
      this.locStartOffset[child] = this.locStartOffset[parent] | 0;
      this.locEndOffset[child] = this.locStartOffset[parent] | 0;
      this.locStartLine[child] = this.locStartLine[parent] | 0;
    }
  }

  /** What is between the parentheses of the function whose `group` is `group`, counted from the start of the value:
   * -1 if there is none; else sets `argStart`, `argEnd`. */
  argStart = 0;
  argEnd = 0;
  private argumentsRange(group: number): boolean {
    if ((this.kind[group] | 0) !== VK_PAREN_GROUP || (this.open[group] | 0) === 0 || (this.close[group] | 0) === 0) return false;
    const a = this.locSourceIndex[this.open[group] | 0] | 0;
    const b = this.locSourceIndex[this.close[group] | 0] | 0;
    if (a === NONE || b === NONE) return false;
    this.argStart = a + 1;
    this.argEnd = b;
    return true;
  }

  /** A `value-comma_group` of `group[start..]`, after `flattenGroups`: if it is only one, that is it. */
  private takeCommaGroup(start: number): number {
    if (this.nGroupStack - start === 1) {
      const only = this.groupStack[start] | 0;
      this.nGroupStack = start;
      return only;
    }
    const gs = this.addListFromGroup(start);
    const id = this.pushNode(VK_COMMA_GROUP);
    this.groupsS[id] = gs;
    this.groupsE[id] = this.nLists;
    this.addGroup(id);
    return id;
  }

  /** `parseNestedValue` and `parseValueNode` for the container `id`, and `flattenGroups` for the result. */
  private groupNodesOf(id: number): number {
    if (!this.stack.enter()) return 0;
    const r = this.groupNodesOfInner(id);
    this.stack.leave();
    return r;
  }

  private groupNodesOfInner(id: number): number {
    // A group of one node is that node.
    const firstChild = this.firstChild[id] | 0;
    if ((this.nextSibling[firstChild] | 0) === 0) {
      const k = this.kind[firstChild] | 0;
      if (k === VK_WORD || k === VK_STRING || k === VK_AT_WORD || k === VK_OPERATOR) return firstChild;
    }
    // The functions in it first.
    let child = firstChild;
    while (child !== 0) {
      if ((this.kind[child] | 0) === VK_FUNC) {
        const group = this.groupNodesOf(child);
        this.group[child] = group;
        this.fillEmptyLoc(group, child);
      }
      child = this.nextSibling[child] | 0;
    }
    // How many there are, and the last two.
    let len = 0;
    let last = 0;
    let beforeLast = 0;
    child = firstChild;
    while (child !== 0) {
      len = len + 1;
      beforeLast = last;
      last = child;
      child = this.nextSibling[child] | 0;
    }
    // Whether a comma is followed by a comment and the `)` that ends the list.
    const endsWithCommentAndParen =
      len >= 3 && (this.kind[beforeLast] | 0) === VK_COMMENT && (this.kind[last] | 0) === VK_PAREN && (this.firstByte[last] | 0) === 41;

    const parensStart = this.nOpenParens;
    const groupsStart = this.nGroups;
    const groupStart = this.nGroupStack;
    this.pushOpenParen(0, groupsStart, groupStart);

    let next = firstChild;
    for (let i = 0; i < len; i++) {
      const cid = next;
      next = this.nextSibling[cid] | 0;
      const kind = this.kind[cid] | 0;
      const firstByte = this.firstByte[cid] | 0;
      const nvs = this.vs[cid] | 0;
      const nve = this.ve[cid] | 0;
      const nGroup = this.group[cid] | 0;
      if (
        this.syntax === SYNTAX_SCSS && kind === VK_NUMBER && eqLit(this.text.data, this.unitS[cid] | 0, this.unitE[cid] | 0, "..") &&
        endsWithLit(this.text.data, nvs, nve, ".")
      ) {
        const at = this.text.len;
        this.text.push(46);
        this.text.push(46);
        this.text.push(46);
        this.ve[cid] = nve - 1;
        this.unitS[cid] = at;
        this.unitE[cid] = this.text.len;
      }

      if (kind === VK_FUNC) {
        const isSelector = eqLit(this.text.data, nvs, nve, "selector");
        const isUrl = eqLit(this.text.data, nvs, nve, "url");
        if (isSelector && this.argumentsRange(nGroup)) {
          const start = this.argStart;
          const end = this.argEnd;
          const selector = this.selectors.parse(this.text.data, this.base + start, this.base + end, this.stack);
          const sel = this.pushNode(VK_SELECTOR);
          this.selector[sel] = selector;
          this.locSourceIndex[sel] = start;
          const ls = this.addList1(sel);
          this.groupsS[nGroup] = ls;
          this.groupsE[nGroup] = ls + 1;
        }
        if (isUrl && (this.kind[nGroup] | 0) === VK_PAREN_GROUP) {
          const hasRange = this.argumentsRange(nGroup);
          const rangeStart = this.argStart;
          const rangeEnd = this.argEnd;
          // What is in the parentheses, and in the groups there.
          let hasInterpolation = false;
          let hasStringOrFunction = false;
          let first = 0;
          let previous = 0;
          const gS = this.groupsS[nGroup] | 0;
          const gE = this.groupsE[nGroup] | 0;
          for (let gi = gS; gi < gE; gi++) {
            const g = this.lists[gi] | 0;
            if ((this.kind[g] | 0) === VK_COMMA_GROUP) {
              const hs = this.groupsS[g] | 0;
              const he = this.groupsE[g] | 0;
              for (let hi = hs; hi < he; hi++) {
                const m = this.lists[hi] | 0;
                // look_at(m)
                const isWord = (this.kind[m] | 0) === VK_WORD;
                if (
                  isWord && eqLit(this.text.data, this.vs[m] | 0, this.ve[m] | 0, "{") && previous !== 0 &&
                  (this.kind[previous] | 0) === VK_WORD && endsWithLit(this.text.data, this.vs[previous] | 0, this.ve[previous] | 0, "#")
                ) hasInterpolation = true;
                const mk = this.kind[m] | 0;
                if (mk === VK_STRING) hasStringOrFunction = true;
                else if (mk === VK_FUNC && !endsWithLit(this.text.data, this.vs[m] | 0, this.ve[m] | 0, "\\")) hasStringOrFunction = true;
                if (first === 0) first = m;
                previous = m;
              }
            } else {
              const m = g;
              const isWord = (this.kind[m] | 0) === VK_WORD;
              if (
                isWord && eqLit(this.text.data, this.vs[m] | 0, this.ve[m] | 0, "{") && previous !== 0 &&
                (this.kind[previous] | 0) === VK_WORD && endsWithLit(this.text.data, this.vs[previous] | 0, this.ve[previous] | 0, "#")
              ) hasInterpolation = true;
              const mk = this.kind[m] | 0;
              if (mk === VK_STRING) hasStringOrFunction = true;
              else if (mk === VK_FUNC && !endsWithLit(this.text.data, this.vs[m] | 0, this.ve[m] | 0, "\\")) hasStringOrFunction = true;
              if (first === 0) first = m;
              previous = m;
            }
          }
          const isScssVariable =
            this.syntax === SYNTAX_SCSS && first !== 0 && (this.kind[first] | 0) === VK_WORD &&
            startsWithLit(this.text.data, this.vs[first] | 0, this.ve[first] | 0, "$");
          if ((hasInterpolation || (!hasStringOrFunction && !isScssVariable)) && hasRange) {
            const innerS = this.base + rangeStart;
            const innerE = this.base + rangeEnd;
            const skipped = trimJsWhitespaceStart(this.text.data, innerS, innerE);
            const trimmedEnd = trimJsWhitespaceEnd(this.text.data, skipped, innerE);
            const text = this.pushNode(VK_TEXT);
            this.vs[text] = skipped;
            this.ve[text] = trimmedEnd;
            const ls = this.addList1(text);
            this.groupsS[nGroup] = ls;
            this.groupsE[nGroup] = ls + 1;
          }
        }
      }

      if (kind === VK_PAREN && firstByte === 40) {
        this.pushOpenParen(cid, this.nGroups, this.nGroupStack);
      } else if (kind === VK_PAREN) {
        if (this.nOpenParens < parensStart + 2) {
          this.isUnbalanced = true;
          continue;
        }
        this.nOpenParens = this.nOpenParens - 1;
        const po = this.nOpenParens * 3;
        const pOpen = this.openParens[po] | 0;
        const pGroupsStart = this.openParens[po + 1] | 0;
        const pGroupStart = this.openParens[po + 2] | 0;
        if (this.nGroupStack > pGroupStart) {
          const lastGroup = this.takeCommaGroup(pGroupStart);
          this.pushGroupsItem(lastGroup);
        }
        const gs = this.addListFromGroups(pGroupsStart);
        const g = this.pushNode(VK_PAREN_GROUP);
        this.open[g] = pOpen;
        this.close[g] = cid;
        this.groupsS[g] = gs;
        this.groupsE[g] = this.nLists;
        this.addGroup(g);
        this.pushGroupItem(g);
      } else if (kind === VK_COMMA) {
        if (i + 3 === len && endsWithCommentAndParen) continue;
        if (this.nOpenParens > 0) {
          const po = (this.nOpenParens - 1) * 3;
          const group = this.takeCommaGroup(this.openParens[po + 2] | 0);
          this.pushGroupsItem(group);
        }
      } else {
        this.pushGroupItem(cid);
      }
    }
    // An unclosed parenthesis cannot get here: its groups would be lost, as in Prettier.
    if (this.nOpenParens > 0) {
      const po = (this.nOpenParens - 1) * 3;
      const gst = this.openParens[po + 2] | 0;
      if (this.nGroupStack > gst) {
        const lastGroup = this.takeCommaGroup(gst);
        this.pushGroupsItem(lastGroup);
      }
    }
    this.nOpenParens = parensStart;
    this.nGroupStack = groupStart;
    if (this.nGroups - groupsStart === 1) {
      const only = this.groups[groupsStart] | 0;
      this.nGroups = groupsStart;
      return only;
    }
    const gs = this.addListFromGroups(groupsStart);
    const g = this.pushNode(VK_PAREN_GROUP);
    this.groupsS[g] = gs;
    this.groupsE[g] = this.nLists;
    this.addGroup(g);
    return g;
  }

  /** `value-unknown` */
  unknown(value: Uint8Array, s: number, e: number, rootOffset: number): number {
    if (this.n === 0) this.pushNode(VK_UNKNOWN);
    const at = this.text.len;
    this.text.append(value, s, e);
    const id = this.pushNode(VK_UNKNOWN);
    this.vs[id] = at;
    this.ve[id] = this.text.len;
    this.locStartOffset[id] = rootOffset;
    this.locEndOffset[id] = rootOffset + (e - s);
    return id;
  }

  /** Prettier's `parseValue`, and `calculateLoc` for its result. `rootOffset`: where Prettier takes `value` to start in the
   * style sheet. The id of the root, or -1: an error is one that Prettier does not catch: a `)` without a `(`. */
  parse(value: Uint8Array, s: number, e: number, syntax: number, rootOffset: number, selectors: Selectors, stack: Stack): number {
    // Inline JavaScript in Less.
    if (syntax === SYNTAX_LESS && e - s >= 2 && (value[s] | 0) === 126 && (value[s + 1] | 0) === 96) {
      return this.unknown(value, s, e, rootOffset);
    }
    if (this.n === 0) this.pushNode(VK_UNKNOWN);
    const base = this.text.len;
    const firstNode = this.n;
    this.text.append(value, s, e);
    this.nCache = 0;
    // The `Value`, which is the only node of the root.
    const container = this.pushNode(VK_VALUE);
    this.unbalanced[container] = 0;
    let parsed = this.tokenize(this.text.data, base, base + (e - s));
    if (parsed) {
      this.base = base;
      this.len = e - s;
      this.rootOffset = rootOffset;
      this.position = 0;
      this.current = container;
      this.spaces = false;
      this.lineNo = 1;
      this.lineIndex = 0;
      parsed = this.parseTokens();
    }
    if (!parsed) {
      this.text.len = base;
      this.n = firstNode;
      return this.unknown(value, s, e, rootOffset);
    }
    this.syntax = syntax;
    this.selectors = selectors;
    this.stack = stack;
    this.isUnbalanced = false;
    this.base = base;
    const group = this.groupNodesOf(container);
    const isUnbalanced = this.isUnbalanced;
    // `fillLocFromChildren`
    let locStartLine = NONE;
    let locStartOffset = NONE;
    let locEndOffset = NONE;
    if ((this.locStartOffset[group] | 0) !== NONE && (this.locEndOffset[group] | 0) !== NONE) {
      locStartLine = this.locStartLine[group] | 0;
      locStartOffset = this.locStartOffset[group] | 0;
      locEndOffset = this.locEndOffset[group] | 0;
    }
    this.group[container] = group;
    this.locSourceIndex[container] = NONE;
    this.locStartLine[container] = locStartLine;
    this.locStartOffset[container] = locStartOffset;
    this.locEndOffset[container] = locEndOffset;
    const root = this.pushNode(VK_ROOT);
    this.group[root] = container;
    this.locStartLine[root] = locStartLine;
    this.locStartOffset[root] = rootOffset;
    this.locEndOffset[root] = rootOffset + (e - s);
    return isUnbalanced ? -1 : root;
  }
}

// ───────────────────────────── shared helpers of the printer ─────────────────────────────

/** `isAtWordPlaceholderNode` */
export function isAtWordPlaceholder(values: Values, id: number): boolean {
  return (values.kind[id] | 0) === VK_AT_WORD &&
    startsWithLit(values.text.data, values.vs[id] | 0, values.ve[id] | 0, "prettier-placeholder-");
}

/** `node.value.group.group`: 0 if there is none. */
export function topLevelGroup(values: Values, root: number): number {
  const valueNode = values.group[root] | 0;
  if ((values.kind[root] | 0) !== VK_ROOT || (values.kind[valueNode] | 0) !== VK_VALUE) return 0;
  return values.group[valueNode] | 0;
}

/** `-apple-system`, `+3em`: to postcss-value-parser a sign that is not the first thing in a value is an operator, so to
 * Prettier this is two things. */
function isSignedWord(values: Values, id: number): boolean {
  if (values.groupCount(id) !== 2) return false;
  const sign = values.groupAt(id, 0);
  const word = values.groupAt(id, 1);
  const fb = values.firstByte[sign] | 0;
  return (values.kind[sign] | 0) === VK_OPERATOR && (fb === 45 || fb === 43) && (values.before[word] | 0) === BEFORE_EMPTY;
}

/** The first condition of `shouldBreakList`. `signedWordIsOne`: as for oxfmt, which keeps `font-family: a, -apple-system` on
 * one line. */
export function isListWithCommaGroup(values: Values, id: number, signedWordIsOne: boolean): boolean {
  if ((values.kind[id] | 0) !== VK_PAREN_GROUP || (values.open[id] | 0) !== 0) return false;
  const gs = values.groupsS[id] | 0;
  const ge = values.groupsE[id] | 0;
  for (let i = gs; i < ge; i++) {
    const it = values.lists[i] | 0;
    if ((values.kind[it] | 0) === VK_COMMA_GROUP && !(signedWordIsOne && isSignedWord(values, it))) return true;
  }
  return false;
}
