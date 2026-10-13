// Port of vendor/bun/src/format/css/postcss.rs: `postcss` 8.5 (`lib/tokenize.js`, `lib/parser.js`), `postcss-scss` 4.0
// (`lib/scss-tokenize.js`, `lib/scss-parser.js`) and `postcss-less` 6.0 (`lib/LessParser.js`, `lib/nodes/*.js`).
//
// Everything that `postcss` keeps as a string is made of tokens that follow each other, so here it is a range of the text.
//
// ## Rust -> TS
// - The text is a `ByteBuf` `buf`: `[0, cssLen)` is the style sheet, `buf[cssLen]` a gap, and from `cssLen + 1` on are the
//   strings that are not a part of it (`Texts::extra`: `postcss-less` drops tokens and uses others twice). So a `Range` is
//   always `(start, end)` in `buf` (Rust's `text_of_range` is the identity). After the parse the printer appends the strings it
//   makes above that, and cuts them off again.
// - A node of the tree is a row of `Tree.f` (`NS` Int32 per node, `F_*` are the columns); 0 is the root and "none". A `Range`
//   field is two columns; `Option<Range>` has -1 in the first; `Option<u32>` (`end`) is -1. `Box<[u8]>` (`clean_*`) are ranges
//   of `Tree.cleans`.
// - A token is six Int32 in a `TokList` (kind, range start, range end, start, last (-1: none), inline); the current token of the
//   tokenizer is in the fields `tk*`. `Result<_, Refused>` is an int (< 0: refused, see `noteRefusal`).
import { ByteBuf } from "../../base/bytebuf.ts";
import { jsWhitespaceLen, leadingWhiteSpaceLen, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  MSG_AT_RULE_WITHOUT_NAME,
  MSG_EXPECTED_COLON,
  MSG_NEITHER_DECLARATION_NOR_RULE,
  MSG_PROPERTY_WITHOUT_NAME,
  MSG_TOO_LARGE,
  MSG_UNCLOSED_BLOCK,
  MSG_UNCLOSED_BRACKET,
  MSG_UNCLOSED_COMMENT,
  MSG_UNCLOSED_INTERPOLATION,
  MSG_UNCLOSED_STRING,
  MSG_UNEXPECTED_CLOSING_BRACE,
  MSG_UNEXPECTED_COLON,
  MSG_UNEXPECTED_END,
  noteRefusal,
} from "../syntax_error.ts";
import {
  isDigitB,
  isHexB,
  isWsB,
  containsByteIn,
  eqLit,
  eqLitIgnoreCase,
  indexOfAny2,
  indexOfByteIn,
  indexOfLit,
  isRegexpWordByte,
  lastIndexOfByteIn,
  lowerByte,
  startsWithLit,
} from "./misc.ts";
import { SYNTAX_CSS, SYNTAX_LESS, SYNTAX_SCSS } from "./syntax.ts";
import { postcssAtEnd, postcssBad, postcssScssWordEnd, postcssWordEnd } from "./charsets.ts";

// `Kind`
export const K_ROOT = 0;
export const K_COMMENT = 1;
export const K_RULE = 2;
export const K_DECL = 3;
export const K_AT_RULE = 4;

// ── node columns
export const F_KIND = 0;
export const F_PARENT = 1;
export const F_HAS_BLOCK = 2;
export const F_FIRST_CHILD = 3;
export const F_LAST_CHILD = 4;
export const F_NEXT_SIBLING = 5;
export const F_START = 6;
/** `source.end.offset`, -1: not set */
export const F_END = 7;
export const F_BEFORE_S = 8;
export const F_BEFORE_E = 9;
export const F_AFTER_S = 10;
export const F_AFTER_E = 11;
export const F_BETWEEN_S = 12;
export const F_BETWEEN_E = 13;
export const F_SEMICOLON = 14;
/** Of a comment: what is between the delimiters, trimmed. */
export const F_TEXT_S = 15;
export const F_TEXT_E = 16;
export const F_INLINE = 17;
export const F_RAW_INLINE = 18;
/** Of a rule: `raws.selector.raw`, or `selector` if there is no such thing. */
export const F_SELECTOR_S = 19;
export const F_SELECTOR_E = 20;
/** `selector`, if it is not the same as `raws.selector.raw`: a range of `cleans` (start -1: it is). */
export const F_CLEAN_SELECTOR_S = 21;
export const F_CLEAN_SELECTOR_E = 22;
export const F_PROP_S = 23;
export const F_PROP_E = 24;
/** Of a declaration: `raws.value.raw`, or `value`. */
export const F_VALUE_S = 25;
export const F_VALUE_E = 26;
export const F_CLEAN_VALUE_S = 27;
export const F_CLEAN_VALUE_E = 28;
export const F_IMPORTANT = 29;
/** start -1: none */
export const F_RAW_IMPORTANT_S = 30;
export const F_RAW_IMPORTANT_E = 31;
/** Of a declaration of SCSS with a block. */
export const F_IS_NESTED = 32;
/** Of an at-rule, without the `@`. */
export const F_NAME_S = 33;
export const F_NAME_E = 34;
export const F_AFTER_NAME_S = 35;
export const F_AFTER_NAME_E = 36;
/** Of an at-rule: `raws.params.raw`, or `params`. */
export const F_PARAMS_S = 37;
export const F_PARAMS_E = 38;
export const F_CLEAN_PARAMS_S = 39;
export const F_CLEAN_PARAMS_E = 40;
export const F_EXTEND = 41;
export const F_MIXIN = 42;
export const F_FUNCTION = 43;
export const F_VARIABLE = 44;
export const F_VALUE_SKIPS = 45;
export const F_IDENTIFIER_S = 46;
export const F_IDENTIFIER_E = 47;
export const F_OWN_SEMICOLON = 48;
export const NS = 49;

/** A tree of `postcss` nodes. */
export class Tree {
  f: Int32Array;
  n: number;
  /** The strings of `clean_*` fields. */
  cleans: ByteBuf;
  /** How long `Texts::extra` is. */
  extraLen: number;

  constructor(capacity: number) {
    this.f = new Int32Array(NS * (capacity < 4 ? 4 : capacity));
    this.n = 0;
    this.cleans = new ByteBuf(64);
    this.extraLen = 0;
  }

  /** The `nodes` of the node `id` are `first = f[id * NS + F_FIRST_CHILD]` and then `F_NEXT_SIBLING`, 0 is the end. */
  reset(): void {
    this.n = 0;
    this.cleans.len = 0;
    this.extraLen = 0;
  }

  /** A new row with the defaults of `Node::default()` (all 0, the optional ones -1). */
  push(): number {
    const id = this.n;
    if ((id + 1) * NS > this.f.length) {
      const nf = new Int32Array(this.f.length * 2);
      nf.set(this.f);
      this.f = nf;
    }
    const f = this.f;
    const o = id * NS;
    f.fill(0, o, o + NS);
    f[o + F_END] = -1;
    f[o + F_CLEAN_SELECTOR_S] = -1;
    f[o + F_CLEAN_VALUE_S] = -1;
    f[o + F_RAW_IMPORTANT_S] = -1;
    f[o + F_CLEAN_PARAMS_S] = -1;
    this.n = id + 1;
    return id;
  }
}

// ── tokens
const TK_SPACE = 0;
const TK_BRACKETS = 1;
const TK_STRING = 2;
const TK_AT_WORD = 3;
const TK_WORD = 4;
const TK_COMMENT = 5;
/** `Control(byte)`: 256 + byte */
const TK_CONTROL = 256;
const C_LBRACKET = TK_CONTROL + 91;
const C_RBRACKET = TK_CONTROL + 93;
const C_LBRACE = TK_CONTROL + 123;
const C_RBRACE = TK_CONTROL + 125;
const C_COLON = TK_CONTROL + 58;
const C_SEMI = TK_CONTROL + 59;
const C_LPAREN = TK_CONTROL + 40;
const C_RPAREN = TK_CONTROL + 41;

/** A list of tokens: `Vec<Token>`. */
class TokList {
  a: Int32Array;
  n: number;
  constructor() {
    this.a = new Int32Array(6 * 64);
    this.n = 0;
  }
  push(kind: number, rs: number, re: number, start: number, last: number, inline: number): void {
    if ((this.n + 1) * 6 > this.a.length) {
      const na = new Int32Array(this.a.length * 2);
      na.set(this.a);
      this.a = na;
    }
    const o = this.n * 6;
    const a = this.a;
    a[o] = kind | 0;
    a[o + 1] = rs | 0;
    a[o + 2] = re | 0;
    a[o + 3] = start | 0;
    a[o + 4] = last | 0;
    a[o + 5] = inline | 0;
    this.n = this.n + 1;
  }
  pushFrom(other: TokList, i: number): void {
    const o = i * 6;
    this.push(other.a[o], other.a[o + 1], other.a[o + 2], other.a[o + 3], other.a[o + 4], other.a[o + 5]);
  }
  kind(i: number): number {
    return this.a[i * 6] | 0;
  }
  rs(i: number): number {
    return this.a[i * 6 + 1] | 0;
  }
  re(i: number): number {
    return this.a[i * 6 + 2] | 0;
  }
  start(i: number): number {
    return this.a[i * 6 + 3] | 0;
  }
  last(i: number): number {
    return this.a[i * 6 + 4] | 0;
  }
  isSpaceOrComment(i: number): boolean {
    const k = this.a[i * 6] | 0;
    return k === TK_SPACE || k === TK_COMMENT;
  }
  /** `token[3] || token[2]`; a space has no position (-1). */
  lastPosition(i: number): number {
    const o = i * 6;
    if ((this.a[o] | 0) === TK_SPACE) return -1;
    const l = this.a[o + 4] | 0;
    return l >= 0 ? l : this.a[o + 3] | 0;
  }
  truncate(n: number): void {
    if (n < this.n) this.n = n;
  }
  /** Removes tokens [from, to). */
  removeRange(from: number, to: number): void {
    const a = this.a;
    a.copyWithin(from * 6, to * 6, this.n * 6);
    this.n = this.n - (to - from);
  }
  /** Replaces the tokens [from, to) by one. */
  replaceRange(from: number, to: number, kind: number, rs: number, re: number, start: number, last: number, inline: number): void {
    this.removeRange(from + 1, to);
    const o = from * 6;
    this.a[o] = kind | 0;
    this.a[o + 1] = rs | 0;
    this.a[o + 2] = re | 0;
    this.a[o + 3] = start | 0;
    this.a[o + 4] = last | 0;
    this.a[o + 5] = inline | 0;
  }
}


/** What `@prettier-placeholder-1-id`, which stands for a `${}` in a template of JavaScript, is at the start of a statement. */
export const PLACEHOLDER_AT_RULE = 0;
/** A statement, with the others that are behind it on its line, as for oxfmt. */
export const PLACEHOLDER_STATEMENT = 1;

/** Whether name[s, e) is all of such a name, without the `@`: `prettier-placeholder-<digits>-id`. */
function isPlaceholder(buf: Uint8Array, s: number, e: number): boolean {
  const prefix = "prettier-placeholder-";
  if (!startsWithLit(buf, s, e, prefix)) return false;
  let i = s + prefix.length;
  const ds = i;
  while (i < e && (buf[i] | 0) >= 48 && (buf[i] | 0) <= 57) i = i + 1;
  if (i === ds) return false;
  return e - i === 3 && (buf[i] | 0) === 45 && (buf[i + 1] | 0) === 105 && (buf[i + 2] | 0) === 100;
}

/** `/extend\(.+\)/i.test(text)` with prefix `extend(` or `:extend(`: `text[s, e)`. */
function hasExtend(text: Uint8Array, s: number, e: number, prefix: string): boolean {
  const n = prefix.length;
  let from = s;
  while (true) {
    // index of `prefix` (ignoring case) from `from`
    let at = -1;
    for (let i = from; i + n <= e; i++) {
      let ok = true;
      for (let k = 0; k < n; k++) {
        if (lowerByte(text[i + k] | 0) !== prefix.charCodeAt(k)) { ok = false; break; }
      }
      if (ok) { at = i; break; }
    }
    if (at < 0) return false;
    const restStart = at + n;
    let lineEnd = e;
    for (let i = restStart; i < e; i++) {
      const c = text[i] | 0;
      if (c === 10 || c === 13) { lineEnd = i; break; }
    }
    // the last `)` in the line, at an index > 0
    for (let i = lineEnd - 1; i >= restStart; i--) {
      if ((text[i] | 0) === 41) {
        if (i > restStart) return true;
        break;
      }
    }
    from = at + 1;
  }
}

export class PostcssParser {
  // the text
  buf: ByteBuf;
  cssLen: number;
  syntax: number;
  isInOrder: boolean;
  placeholder: number;
  // tokenizer
  pos: number;
  shift: number;
  /** The words that no `(` has taken yet: (start, end) pairs. */
  wordBuf: Int32Array;
  nWordBuf: number;
  /** `returned`: records of 7: some (1) or none (0), then a token */
  returned: Int32Array;
  nReturned: number;
  lastBadParen: number;
  /** 0: `None`; 1: `Some(None)`; 2: `Some(Some(nextCloseAt))` */
  nextCloseState: number;
  nextCloseAt: number;
  // the current token
  tk: number;
  trs: number;
  tre: number;
  tstart: number;
  tlast: number;
  tinline: number;
  // the parser
  tree: Tree;
  current: number;
  lastNode: number;
  spaceS: number;
  spaceE: number;
  semicolon: boolean;
  isCustomPropertySet: boolean;
  stmt: TokList;
  params: TokList;
  cache: TokList;
  brkA: Uint8Array;
  nBrkA: number;
  brkO: Uint8Array;
  nBrkO: number;
  // out of `join`
  jE: number;
  // out of `colon` etc.
  outS: number;
  outE: number;

  constructor() {
    this.buf = new ByteBuf(1024);
    this.cssLen = 0;
    this.syntax = SYNTAX_CSS;
    this.isInOrder = true;
    this.placeholder = PLACEHOLDER_AT_RULE;
    this.pos = 0;
    this.shift = 0;
    this.wordBuf = new Int32Array(64);
    this.nWordBuf = 0;
    this.returned = new Int32Array(7 * 8);
    this.nReturned = 0;
    this.lastBadParen = -1;
    this.nextCloseState = 0;
    this.nextCloseAt = 0;
    this.tk = 0;
    this.trs = 0;
    this.tre = 0;
    this.tstart = 0;
    this.tlast = -1;
    this.tinline = 0;
    this.tree = new Tree(64);
    this.current = 0;
    this.lastNode = 0;
    this.spaceS = 0;
    this.spaceE = 0;
    this.semicolon = false;
    this.isCustomPropertySet = false;
    this.stmt = new TokList();
    this.params = new TokList();
    this.cache = new TokList();
    this.brkA = new Uint8Array(16);
    this.nBrkA = 0;
    this.brkO = new Uint8Array(16);
    this.nBrkO = 0;
    this.jE = 0;
    this.outS = 0;
    this.outE = 0;
  }

  // ───────────────────────────── texts ─────────────────────────────

  /** `a + b` for ranges: returns the start, the end is `jE`. */
  join(aS: number, aE: number, bS: number, bE: number): number {
    if (aS >= aE) {
      this.jE = bE;
      return bS;
    }
    if (bS >= bE) {
      this.jE = aE;
      return aS;
    }
    if (aE === bS) {
      this.jE = bE;
      return aS;
    }
    return this.joinApart(aS, aE, bS, bE);
  }

  /** `a + b`, which do not touch and are not empty. */
  private joinApart(aS: number, aE: number, bS: number, bE: number): number {
    const buf = this.buf;
    const offset = this.cssLen + 1;
    let start: number;
    let appendA: boolean;
    // What has been added last grows in place.
    if (aS >= offset && aE === buf.len) {
      start = aS;
      appendA = false;
    } else {
      start = buf.len;
      appendA = true;
    }
    if (appendA) this.appendRange(aS, aE);
    this.appendRange(bS, bE);
    this.jE = buf.len;
    return start;
  }

  private appendRange(s: number, e: number): void {
    const buf = this.buf;
    const len = e - s;
    if (buf.len + len > buf.data.length) buf.grow(buf.len + len);
    buf.data.copyWithin(buf.len, s, e);
    buf.len = buf.len + len;
  }

  /** The texts of tokens [from, to) of `tokens`, one after the other: returns the start, the end is `jE`. */
  rangeOf(tokens: TokList, from: number, to: number): number {
    if (to <= from) {
      this.jE = 0;
      return 0;
    }
    if (to - from >= 2 && this.isInOrder) {
      this.jE = tokens.re(to - 1);
      return tokens.rs(from);
    }
    let s = 0;
    let e = 0;
    for (let i = from; i < to; i++) {
      s = this.join(s, e, tokens.rs(i), tokens.re(i));
      e = this.jE;
    }
    this.jE = e;
    return s;
  }

  /** Cuts the spaces and comments from the end of `tokens`; returns the start of their text, the end is `jE`. */
  private spacesAndCommentsFromEnd(tokens: TokList): number {
    let keep = 0;
    for (let i = tokens.n - 1; i >= 0; i--) {
      if (!tokens.isSpaceOrComment(i)) { keep = i + 1; break; }
    }
    const s = this.rangeOf(tokens, keep, tokens.n);
    tokens.truncate(keep);
    return s;
  }

  // ───────────────────────────── the tokenizer ─────────────────────────────

  private endOfFile(): boolean {
    return this.nReturned === 0 && this.pos >= this.cssLen;
  }

  /** `back(Some(token))` of the token in the `tk*` fields. */
  private backCurrent(): void {
    this.pushReturned(1, this.tk, this.trs, this.tre, this.tstart, this.tlast, this.tinline);
  }
  private backNone(): void {
    this.pushReturned(0, 0, 0, 0, 0, 0, 0);
  }
  private backTok(kind: number, rs: number, re: number, start: number, last: number, inline: number): void {
    this.pushReturned(1, kind, rs, re, start, last, inline);
  }
  private backFrom(list: TokList, i: number): void {
    const o = i * 6;
    this.pushReturned(1, list.a[o], list.a[o + 1], list.a[o + 2], list.a[o + 3], list.a[o + 4], list.a[o + 5]);
  }
  private pushReturned(some: number, kind: number, rs: number, re: number, start: number, last: number, inline: number): void {
    if ((this.nReturned + 1) * 7 > this.returned.length) {
      const nr = new Int32Array(this.returned.length * 2);
      nr.set(this.returned);
      this.returned = nr;
    }
    const o = this.nReturned * 7;
    const r = this.returned;
    r[o] = some | 0;
    r[o + 1] = kind | 0;
    r[o + 2] = rs | 0;
    r[o + 3] = re | 0;
    r[o + 4] = start | 0;
    r[o + 5] = last | 0;
    r[o + 6] = inline | 0;
    this.nReturned = this.nReturned + 1;
  }

  private setCurrent(kind: number, rs: number, re: number, start: number, last: number, inline: number): void {
    this.tk = kind;
    this.trs = rs;
    this.tre = re;
    this.tstart = start;
    this.tlast = last;
    this.tinline = inline;
  }

  /** The position of the next `byte` after `from` that is not escaped; -1: none. */
  private findUnescaped(byte: number, from: number): number {
    const css = this.buf.data;
    let next = from;
    while (true) {
      next = indexOfByteIn(css, next + 1, this.cssLen, byte);
      if (next < 0) return -1;
      let backslashes = 0;
      let i = next - 1;
      while (i >= 0 && (css[i] | 0) === 92) {
        backslashes = backslashes + 1;
        i = i - 1;
      }
      if (backslashes % 2 === 0) return next;
    }
  }

  /** `interpolation` of `postcss-scss`. `next`: where the `#` is. Returns where the `}` is, or -1 (refused). */
  private interpolation(next0: number): number {
    const css = this.buf.data;
    const start = next0;
    let next = next0;
    let deep = 1;
    let stringQuote = 0;
    let stringEscaped = false;
    while (deep > 0) {
      next = next + 1;
      if (next >= this.cssLen) return noteRefusal(MSG_UNCLOSED_INTERPOLATION, start);
      const code = css[next] | 0;
      if (stringQuote !== 0) {
        if (!stringEscaped && code === stringQuote) {
          stringQuote = 0;
        } else if (code === 92) {
          stringEscaped = !stringEscaped;
        } else {
          stringEscaped = false;
        }
      } else if (code === 39 || code === 34) {
        stringQuote = code;
      } else if (code === 125) {
        deep = deep - 1;
      } else if (code === 35 && next + 1 < this.cssLen && (css[next + 1] | 0) === 123) {
        deep = deep + 1;
      }
    }
    return next;
  }

  /** Reads the next token into the `tk*` fields. Returns 1 (a token), 0 (`None`, an `undefined` that has been given back,
   * or the end), -1 (refused). */
  nextToken(ignoreUnclosed: boolean): number {
    if (this.nReturned > 0) {
      this.nReturned = this.nReturned - 1;
      const o = this.nReturned * 7;
      const r = this.returned;
      if ((r[o] | 0) === 0) return 0;
      this.setCurrent(r[o + 1] | 0, r[o + 2] | 0, r[o + 3] | 0, r[o + 4] | 0, r[o + 5] | 0, r[o + 6] | 0);
      return 1;
    }
    const css = this.buf.data;
    const pos = this.pos;
    const len = this.cssLen;
    if (pos >= len) return 0;
    const code = css[pos] | 0;
    // Most tokens are blanks, punctuation and words.
    switch (code) {
      case 10: case 32: case 9: case 13: case 12: {
        let end = pos + 1;
        while (end < len && isWsB(css[end] | 0)) end = end + 1;
        this.makeToken(TK_SPACE, pos, end - 1, 0);
        return 1;
      }
      case 91: case 93: case 123: case 125: case 58: case 59: case 41:
        this.makeToken(TK_CONTROL + code, pos, pos, 0);
        return 1;
      case 44: case 40: case 39: case 34: case 64: case 92: case 35: case 47:
        return this.nextSpecialToken(code, ignoreUnclosed);
      default: {
        // a word
        let end = pos + 1;
        if (this.syntax === SYNTAX_SCSS) {
          while (true) {
            while (end < len && !postcssScssWordEnd(css[end] | 0)) end = end + 1;
            if (end < len && (css[end] | 0) === 47 && !(end + 1 < len && (css[end + 1] | 0) === 42)) {
              end = end + 1;
              continue;
            }
            break;
          }
        } else {
          while (true) {
            while (end < len && !postcssWordEnd(css[end] | 0)) end = end + 1;
            if (end < len && (css[end] | 0) === 47 && !(end + 1 < len && (css[end + 1] | 0) === 42)) {
              end = end + 1;
              continue;
            }
            break;
          }
        }
        this.pushWord(pos, end);
        this.pos = end;
        this.tk = TK_WORD;
        this.trs = pos;
        this.tre = end;
        this.tstart = pos - this.shift;
        this.tlast = this.syntax === SYNTAX_SCSS && code === 44 ? pos - this.shift + 1 : end - 1 - this.shift;
        this.tinline = 0;
        return 1;
      }
    }
  }

  private pushWord(s: number, e: number): void {
    if ((this.nWordBuf + 1) * 2 > this.wordBuf.length) {
      const nw = new Int32Array(this.wordBuf.length * 2);
      nw.set(this.wordBuf);
      this.wordBuf = nw;
    }
    this.wordBuf[this.nWordBuf * 2] = s;
    this.wordBuf[this.nWordBuf * 2 + 1] = e;
    this.nWordBuf = this.nWordBuf + 1;
  }

  /** Where the word ends that starts at `pos` (the rare paths; `nextToken` does it in line). */
  private endOfWord(pos: number): number {
    const css = this.buf.data;
    const scss = this.syntax === SYNTAX_SCSS;
    const len = this.cssLen;
    let end = pos + 1;
    while (true) {
      while (end < len && !(scss ? postcssScssWordEnd(css[end] | 0) : postcssWordEnd(css[end] | 0))) end = end + 1;
      if (end < len && (css[end] | 0) === 47 && !(end + 1 < len && (css[end + 1] | 0) === 42)) {
        end = end + 1;
        continue;
      }
      break;
    }
    this.pushWord(pos, end);
    return end;
  }

  /** The token from `pos` to `next`, which is its last character. The next one starts behind it. */
  private makeToken(kind: number, pos: number, next: number, inline: number): void {
    this.pos = next + 1;
    const start = pos - this.shift;
    let last: number;
    if (kind === TK_SPACE || kind >= TK_CONTROL) {
      last = -1;
    } else if (kind === TK_WORD && this.syntax === SYNTAX_SCSS && (this.buf.data[pos] | 0) === 44) {
      // What `postcss-scss` says of a comma.
      last = start + 1;
    } else {
      last = next - this.shift;
    }
    const re = next + 1 < this.cssLen ? next + 1 : this.cssLen;
    this.setCurrent(kind, pos, re, start, last, inline);
  }

  /** The token that starts with `code`, where `this.pos` is. */
  private nextSpecialToken(code: number, ignoreUnclosed: boolean): number {
    const css = this.buf.data;
    const len = this.cssLen;
    const pos = this.pos;
    const isScss = this.syntax === SYNTAX_SCSS;
    let next: number;
    let kind: number;
    let inline = 0;
    switch (code) {
      case 44:
        if (isScss) {
          kind = TK_WORD;
          next = pos;
          break;
        }
        this.makeToken(TK_WORD, pos, this.endOfWord(pos) - 1, 0);
        return 1;
      case 40: {
        // `prev`: the word that was popped
        let prevS = 0;
        let prevE = 0;
        if (this.nWordBuf > 0) {
          this.nWordBuf = this.nWordBuf - 1;
          prevS = this.wordBuf[this.nWordBuf * 2] | 0;
          prevE = this.wordBuf[this.nWordBuf * 2 + 1] | 0;
        }
        const hasN = pos + 1 < len;
        const n = hasN ? css[pos + 1] | 0 : -1;
        const prevIsUrl = eqLit(css, prevS, prevE, "url");
        if (prevIsUrl && n !== 39 && n !== 34 && isScss) {
          let brackets = 1;
          let at = pos + 1;
          while (at < len) {
            const c = css[at] | 0;
            if (c === 40) {
              brackets = brackets + 1;
            } else if (c === 41) {
              brackets = brackets - 1;
              if (brackets === 0) break;
            }
            at = at + 1;
          }
          kind = TK_BRACKETS;
          next = at;
        } else if (prevIsUrl && n !== 39 && n !== 34 && !(hasN && isWsB(n))) {
          let close = this.findUnescaped(41, pos);
          if (close < 0) {
            if (ignoreUnclosed) close = pos;
            else return noteRefusal(MSG_UNCLOSED_BRACKET, pos);
          }
          kind = TK_BRACKETS;
          next = close;
        } else if (!isScss && this.lastBadParen >= 0 && pos <= this.lastBadParen) {
          kind = C_LPAREN;
          next = pos;
        } else {
          let close: number;
          // `Some(close) if close.is_none_or(|at| at > pos)`
          if (this.nextCloseState === 1) {
            close = -1;
          } else if (this.nextCloseState === 2 && this.nextCloseAt > pos) {
            close = this.nextCloseAt;
          } else {
            close = indexOfByteIn(css, pos + 1, len, 41);
          }
          if (close < 0) {
            this.nextCloseState = 1;
          } else {
            this.nextCloseState = 2;
            this.nextCloseAt = close;
          }
          // `/.[\r\n"'(/\\]/` in css[pos..=close]
          let isBad = false;
          if (close >= 0) {
            let from = pos + 1;
            while (true) {
              let at = from;
              while (at <= close && !postcssBad(css[at] | 0)) at = at + 1;
              if (at > close) break;
              const before = css[at - 1] | 0;
              if (before !== 10 && before !== 13) { isBad = true; break; }
              from = at + 1;
            }
          }
          if (close >= 0 && !isBad) {
            kind = TK_BRACKETS;
            next = close;
          } else {
            this.lastBadParen = close >= 0 ? close : len;
            kind = C_LPAREN;
            next = pos;
          }
        }
        break;
      }
      case 39: case 34:
        if (isScss) {
          let at = pos;
          let escaped = false;
          while (true) {
            at = at + 1;
            if (at >= len) return noteRefusal(MSG_UNCLOSED_STRING, pos);
            const byte = css[at] | 0;
            if (!escaped && byte === code) {
              break;
            } else if (byte === 92) {
              escaped = !escaped;
            } else if (escaped) {
              escaped = false;
            } else if (byte === 35 && at + 1 < len && (css[at + 1] | 0) === 123) {
              at = this.interpolation(at);
              if (at < 0) return -1;
            }
          }
          kind = TK_STRING;
          next = at;
        } else {
          let close = this.findUnescaped(code, pos);
          if (close < 0) {
            if (ignoreUnclosed) close = pos + 1;
            else return noteRefusal(MSG_UNCLOSED_STRING, pos);
          }
          kind = TK_STRING;
          next = close;
        }
        break;
      case 64: {
        let end = pos + 1;
        while (end < len && !postcssAtEnd(css[end] | 0)) end = end + 1;
        kind = TK_AT_WORD;
        next = end - 1;
        break;
      }
      case 92: {
        let last = pos;
        let escape = true;
        while (last + 1 < len && (css[last + 1] | 0) === 92) {
          last = last + 1;
          escape = !escape;
        }
        const hasAfter = last + 1 < len;
        const after = hasAfter ? css[last + 1] | 0 : -1;
        if (escape && hasAfter && after !== 47 && !isWsB(after)) {
          last = last + 1;
          if (isHexB(css[last] | 0)) {
            while (last + 1 < len && isHexB(css[last + 1] | 0)) last = last + 1;
            if (last + 1 < len && (css[last + 1] | 0) === 32) last = last + 1;
          }
        }
        kind = TK_WORD;
        next = last;
        break;
      }
      case 35:
        if (isScss && pos + 1 < len && (css[pos + 1] | 0) === 123) {
          kind = TK_WORD;
          next = this.interpolation(pos);
          if (next < 0) return -1;
        } else {
          this.makeToken(TK_WORD, pos, this.endOfWord(pos) - 1, 0);
          return 1;
        }
        break;
      case 47: {
        const n1 = pos + 1 < len ? css[pos + 1] | 0 : -1;
        if (n1 === 42) {
          let close = indexOfLit(css, pos + 2, len, "*/");
          if (close < 0) {
            if (ignoreUnclosed) close = len;
            else return noteRefusal(MSG_UNCLOSED_COMMENT, pos);
          } else {
            close = close + 1;
          }
          kind = TK_COMMENT;
          next = close;
        } else if (isScss && n1 === 47) {
          let end = len;
          for (let i = pos + 1; i < len; i++) {
            const c = css[i] | 0;
            if (c === 10 || c === 12 || c === 13) { end = i; break; }
          }
          kind = TK_COMMENT;
          next = end - 1;
          inline = 1;
        } else {
          this.makeToken(TK_WORD, pos, this.endOfWord(pos) - 1, 0);
          return 1;
        }
        break;
      }
      default:
        this.makeToken(TK_WORD, pos, this.endOfWord(pos) - 1, 0);
        return 1;
    }
    this.makeToken(kind, pos, next, inline);
    return 1;
  }

  // ───────────────────────────── the parser ─────────────────────────────

  private atEnd(): number {
    return noteRefusal(MSG_UNEXPECTED_END, this.cssLen);
  }

  /** `init` */
  private newNodeOf(kind: number, offset: number): number {
    const tree = this.tree;
    const id = tree.n;
    const current = this.current;
    tree.push();
    const f = tree.f;
    const po = current * NS;
    const previous = f[po + F_LAST_CHILD] | 0;
    f[po + F_LAST_CHILD] = id;
    f[po + F_HAS_BLOCK] = 1;
    if (previous === 0) f[po + F_FIRST_CHILD] = id;
    else f[previous * NS + F_NEXT_SIBLING] = id;
    const o = id * NS;
    f[o + F_KIND] = kind;
    f[o + F_PARENT] = current;
    f[o + F_START] = offset;
    f[o + F_BEFORE_S] = this.spaceS;
    f[o + F_BEFORE_E] = this.spaceE;
    this.spaceS = 0;
    this.spaceE = 0;
    if (kind !== K_COMMENT) this.semicolon = false;
    this.lastNode = id;
    return id;
  }

  private open(id: number): void {
    this.tree.f[id * NS + F_HAS_BLOCK] = 1;
    this.current = id;
  }

  /** Returns 0, or -1 (refused). */
  private parse(): number {
    while (!this.endOfFile()) {
      const r = this.nextToken(false);
      if (r < 0) return -1;
      if (r === 0) return this.atEnd();
      const kind = this.tk;
      switch (kind) {
        case TK_SPACE:
          this.spaceS = this.join(this.spaceS, this.spaceE, this.trs, this.tre);
          this.spaceE = this.jE;
          break;
        case C_SEMI:
          this.freeSemicolon(this.trs, this.tre, this.tstart);
          break;
        case C_RBRACE:
          if (this.end(this.tstart, this.trs) < 0) return -1;
          break;
        case TK_COMMENT:
          this.comment();
          break;
        case TK_AT_WORD:
          if (this.atrule() < 0) return -1;
          break;
        case C_LBRACE: {
          const id = this.newNodeOf(K_RULE, this.tstart);
          this.open(id);
          break;
        }
        default:
          if (this.syntax !== SYNTAX_LESS) {
            if (this.other() < 0) return -1;
          } else {
            const kind0 = this.tk;
            const rs0 = this.trs;
            const re0 = this.tre;
            const start0 = this.tstart;
            const last0 = this.tlast;
            const inline0 = this.tinline;
            const handled = this.lessInlineComment(kind0, rs0, re0, start0, last0, inline0);
            if (handled < 0) return -1;
            if (handled === 0) {
              this.setCurrent(kind0, rs0, re0, start0, last0, inline0);
              if (this.other() < 0) return -1;
            }
          }
          break;
      }
    }
    // `endFile`
    if (this.current !== 0) {
      return noteRefusal(MSG_UNCLOSED_BLOCK, this.tree.f[this.current * NS + F_START] | 0);
    }
    this.closeCurrent();
    return 0;
  }

  /** What `end` and `endFile` have in common. */
  private closeCurrent(): void {
    const current = this.current;
    const f = this.tree.f;
    const o = current * NS;
    if ((f[o + F_FIRST_CHILD] | 0) !== 0) f[o + F_SEMICOLON] = this.semicolon ? 1 : 0;
    const spaceS = this.spaceS;
    const spaceE = this.spaceE;
    this.spaceS = 0;
    this.spaceE = 0;
    const s = this.join(f[o + F_AFTER_S] | 0, f[o + F_AFTER_E] | 0, spaceS, spaceE);
    this.tree.f[o + F_AFTER_S] = s;
    this.tree.f[o + F_AFTER_E] = this.jE;
    this.semicolon = false;
  }

  private end(tokenStart: number, tokenRs: number): number {
    this.closeCurrent();
    if (this.current === 0) return noteRefusal(MSG_UNEXPECTED_CLOSING_BRACE, tokenRs);
    const o = this.current * NS;
    const f = this.tree.f;
    f[o + F_END] = tokenStart + 1;
    this.current = f[o + F_PARENT] | 0;
    return 0;
  }

  private freeSemicolon(rs: number, re: number, start: number): void {
    this.spaceS = this.join(this.spaceS, this.spaceE, rs, re);
    this.spaceE = this.jE;
    const f = this.tree.f;
    const prev = f[this.current * NS + F_LAST_CHILD] | 0;
    if (prev === 0) return;
    const po = prev * NS;
    if ((f[po + F_KIND] | 0) === K_RULE && (f[po + F_OWN_SEMICOLON] | 0) === 0) {
      f[po + F_END] = start + (this.spaceE - this.spaceS);
      f[po + F_OWN_SEMICOLON] = 1;
      this.spaceS = 0;
      this.spaceE = 0;
    }
  }

  /** The part of [s, e) that is left when it is trimmed: sets `outS`, `outE`. */
  private trimmed(s: number, e: number): void {
    const data = this.buf.data;
    const ts = trimJsWhitespaceStart(data, s, e);
    const te = trimJsWhitespaceEnd(data, ts, e);
    this.outS = ts;
    this.outE = te;
  }

  private comment(): void {
    const rs = this.trs;
    const re = this.tre;
    const start = this.tstart;
    const inline = this.tinline;
    const lastPos = this.tlast >= 0 ? this.tlast : this.tstart;
    const id = this.newNodeOf(K_COMMENT, start);
    const s = rs + 2;
    if (inline !== 0) {
      this.trimmed(s, re);
    } else {
      const e = re - 2 > s ? re - 2 : s;
      this.trimmed(s, e);
    }
    const f = this.tree.f;
    const o = id * NS;
    f[o + F_END] = lastPos + 1;
    f[o + F_TEXT_S] = this.outS;
    f[o + F_TEXT_E] = this.outE;
    f[o + F_RAW_INLINE] = inline;
  }

  private atrule(): number {
    const tokStart = this.tstart;
    const nameS = this.trs + 1;
    let nameE = this.tre;
    switch (this.syntax) {
      case SYNTAX_CSS:
        return this.baseAtrule(tokStart, nameS, nameE);
      case SYNTAX_SCSS: {
        let prevLast = this.tlast;
        while (!this.endOfFile()) {
          const r = this.nextToken(false);
          if (r < 0) return -1;
          if (r === 0) return this.atEnd();
          if (this.tk === TK_WORD && prevLast >= 0 && this.tstart === prevLast + 1) {
            nameE = this.tre;
            prevLast = this.tlast;
          } else {
            this.backCurrent();
            break;
          }
        }
        return this.baseAtrule(tokStart, nameS, nameE);
      }
      default:
        return this.lessAtrule(this.tk, this.trs, this.tre, this.tstart, this.tlast, this.tinline, nameS, nameE);
    }
  }

  private pushBrkA(b: number): void {
    if (this.nBrkA === this.brkA.length) {
      const n = new Uint8Array(this.brkA.length * 2);
      n.set(this.brkA);
      this.brkA = n;
    }
    this.brkA[this.nBrkA] = b;
    this.nBrkA = this.nBrkA + 1;
  }
  private pushBrkO(b: number): void {
    if (this.nBrkO === this.brkO.length) {
      const n = new Uint8Array(this.brkO.length * 2);
      n.set(this.brkO);
      this.brkO = n;
    }
    this.brkO[this.nBrkO] = b;
    this.nBrkO = this.nBrkO + 1;
  }

  /** `atrule` of `postcss`. `start`: `token[2]`. `name`: `token[1].slice(1)`. */
  private baseAtrule(start: number, nameS: number, nameE: number): number {
    if (nameS >= nameE) return noteRefusal(MSG_AT_RULE_WITHOUT_NAME, start);
    const id = this.newNodeOf(K_AT_RULE, start);
    const tree = this.tree;
    tree.f[id * NS + F_NAME_S] = nameS;
    tree.f[id * NS + F_NAME_E] = nameE;
    const isStatement = this.placeholder === PLACEHOLDER_STATEMENT && isPlaceholder(this.buf.data, nameS, nameE);

    let last = false;
    let open = false;
    const params = this.params;
    params.n = 0;
    this.nBrkA = 0;

    while (!this.endOfFile()) {
      const r = this.nextToken(false);
      if (r < 0) return -1;
      if (r === 0) return this.atEnd();
      const kind = this.tk;
      if (kind === C_LPAREN) this.pushBrkA(41);
      else if (kind === C_LBRACKET) this.pushBrkA(93);
      else if (kind === C_LBRACE && this.nBrkA > 0) this.pushBrkA(125);
      else if (kind >= TK_CONTROL && this.nBrkA > 0 && (this.brkA[this.nBrkA - 1] | 0) === kind - TK_CONTROL) this.nBrkA = this.nBrkA - 1;
      if (this.nBrkA === 0) {
        if (kind === C_SEMI) {
          this.tree.f[id * NS + F_END] = this.tstart + 1;
          this.semicolon = true;
          break;
        } else if (kind === C_LBRACE) {
          open = true;
          break;
        } else if (kind === C_RBRACE) {
          for (let i = params.n - 1; i >= 0; i--) {
            if (params.kind(i) !== TK_SPACE) {
              const lp = params.lastPosition(i);
              this.tree.f[id * NS + F_END] = lp >= 0 ? lp + 1 : -1;
              break;
            }
          }
          if (this.end(this.tstart, this.trs) < 0) return -1;
          break;
        }
      }
      if (isStatement && kind === TK_SPACE && containsByteIn(this.buf.data, this.trs, this.tre, 10)) {
        let allOk = true;
        for (let i = 0; i < params.n; i++) {
          const k = params.kind(i);
          if (k === TK_SPACE) continue;
          if (k === TK_AT_WORD && isPlaceholder(this.buf.data, params.rs(i) + 1, params.re(i))) continue;
          allOk = false;
          break;
        }
        if (allOk) {
          this.backCurrent();
          this.tree.f[id * NS + F_END] = nameE;
          last = true;
          break;
        }
      }
      params.push(this.tk, this.trs, this.tre, this.tstart, this.tlast, this.tinline);
      if (this.endOfFile()) {
        last = true;
        break;
      }
    }

    const betweenS = this.spacesAndCommentsFromEnd(params);
    const betweenE = this.jE;
    this.tree.f[id * NS + F_BETWEEN_S] = betweenS;
    this.tree.f[id * NS + F_BETWEEN_E] = betweenE;
    if (params.n > 0) {
      let skip = params.n;
      for (let i = 0; i < params.n; i++) {
        if (!params.isSpaceOrComment(i)) { skip = i; break; }
      }
      const afterNameS = this.rangeOf(params, 0, skip);
      const afterNameE = this.jE;
      const rangeS = this.rangeOf(params, skip, params.n);
      const rangeE = this.jE;
      const hasClean = this.clean(params, skip, params.n, false);
      const cs = this.cleanS;
      const ce = this.cleanE;
      const f = this.tree.f;
      const o = id * NS;
      f[o + F_AFTER_NAME_S] = afterNameS;
      f[o + F_AFTER_NAME_E] = afterNameE;
      f[o + F_PARAMS_S] = rangeS;
      f[o + F_PARAMS_E] = rangeE;
      f[o + F_CLEAN_PARAMS_S] = hasClean ? cs : -1;
      f[o + F_CLEAN_PARAMS_E] = hasClean ? ce : 0;
      if (last) {
        // `params.last().last_position()`
        const lp = params.n > skip ? params.lastPosition(params.n - 1) : -1;
        f[o + F_END] = lp >= 0 ? lp + 1 : -1;
        f[o + F_BETWEEN_S] = 0;
        f[o + F_BETWEEN_E] = 0;
        this.spaceS = betweenS;
        this.spaceE = betweenE;
      }
    }
    if (open) this.open(id);
    return 0;
  }

  // The result of `clean`: a range of `tree.cleans`.
  cleanS = 0;
  cleanE = 0;

  /** `clean`: the text of tokens [from, to) without the comments that have a space next to them. Returns false if that is all
   * of their text; else the range of the new text is `cleanS..cleanE` of `tree.cleans`. */
  private clean(tokens: TokList, from: number, to: number, customProperty: boolean): boolean {
    const css = this.buf.data;
    const n = to - from;
    const endsWithSpace = !customProperty && n > 0 && tokens.kind(to - 1) === TK_SPACE;
    let anyComment = false;
    for (let i = from; i < to; i++) {
      if (tokens.kind(i) === TK_COMMENT) { anyComment = true; break; }
    }
    if (!endsWithSpace && !anyComment) return false;
    const cleans = this.tree.cleans;
    const startAt = cleans.len;
    let isClean = true;
    for (let i = from; i < to; i++) {
      const kind = tokens.kind(i);
      if (kind === TK_SPACE && i + 1 === to && !customProperty) {
        isClean = false;
      } else if (kind === TK_COMMENT) {
        const prevSafe = i === from || tokens.kind(i - 1) === TK_SPACE;
        const nextSafe = i + 1 >= to || tokens.kind(i + 1) === TK_SPACE;
        const endsWithComma = cleans.len > startAt && (cleans.data[cleans.len - 1] | 0) === 44;
        if (prevSafe || nextSafe || endsWithComma) isClean = false;
        else cleans.append(css, tokens.rs(i), tokens.re(i));
      } else {
        cleans.append(css, tokens.rs(i), tokens.re(i));
      }
    }
    if (isClean) {
      cleans.len = startAt;
      return false;
    }
    this.cleanS = startAt;
    this.cleanE = cleans.len;
    return true;
  }

  /** Where the first `(` or `[` of `tokens` is that nothing closes. */
  private unclosedBracket(tokens: TokList): number {
    // a stack of (closing byte, token index)
    const open: number[] = [];
    for (let i = 0; i < tokens.n; i++) {
      const kind = tokens.kind(i);
      if (kind === C_LPAREN) {
        open.push(41, i);
      } else if (kind === C_LBRACKET) {
        open.push(93, i);
      } else if (kind >= TK_CONTROL && open.length >= 2 && open[open.length - 2] === kind - TK_CONTROL) {
        open.length = open.length - 2;
      }
    }
    if (open.length >= 2) return tokens.rs(open[1]);
    return tokens.n > 0 ? tokens.rs(0) : 0;
  }

  private other(): number {
    const tokens = this.stmt;
    tokens.n = 0;
    return this.otherWith(tokens);
  }

  /** `tokens` is empty; the current token is the start. */
  private otherWith(tokens: TokList): number {
    let end = false;
    let colon = false;
    this.nBrkO = 0;
    const startRs = this.trs;
    const startRe = this.tre;
    const startsWithDashes = startsWithLit(this.buf.data, startRs, startRe, "--");
    let customProperty = !this.isCustomPropertySet && startsWithDashes;
    this.isCustomPropertySet = false;

    let has = 1;
    while (has === 1) {
      tokens.push(this.tk, this.trs, this.tre, this.tstart, this.tlast, this.tinline);
      const kind = this.tk;
      if (kind === C_LPAREN) {
        this.pushBrkO(41);
      } else if (kind === C_LBRACKET) {
        this.pushBrkO(93);
      } else if (kind === C_LBRACE && customProperty && colon) {
        this.pushBrkO(125);
      } else if (kind >= TK_CONTROL && this.nBrkO === 0) {
        if (kind === C_SEMI) {
          if (colon) return this.decl(tokens, customProperty);
          break;
        } else if (kind === C_LBRACE) {
          if (this.syntax === SYNTAX_LESS) {
            const r = this.lessRuleInterpolation(tokens);
            if (r < 0) return -1;
            if (r === 1) {
              customProperty = startsWithLit(this.buf.data, startRs, startRe, "--");
            } else {
              return this.rule(tokens);
            }
          } else {
            return this.rule(tokens);
          }
        } else if (kind === C_RBRACE) {
          tokens.truncate(tokens.n - 1);
          this.backCurrent();
          end = true;
          break;
        } else if (kind === C_COLON) {
          colon = true;
        }
      } else if (kind >= TK_CONTROL && (this.brkO[this.nBrkO - 1] | 0) === kind - TK_CONTROL) {
        this.nBrkO = this.nBrkO - 1;
      }
      has = this.nextToken(false);
      if (has < 0) return -1;
    }

    if (this.endOfFile()) end = true;
    if (this.nBrkO > 0) return noteRefusal(MSG_UNCLOSED_BRACKET, this.unclosedBracket(tokens));
    if (!(end && colon)) return this.unknownWord(tokens);
    if (!customProperty) {
      while (tokens.n > 0 && tokens.isSpaceOrComment(tokens.n - 1)) {
        this.backFrom(tokens, tokens.n - 1);
        tokens.truncate(tokens.n - 1);
      }
    }
    return this.decl(tokens, customProperty);
  }

  private rule(tokens: TokList): number {
    switch (this.syntax) {
      case SYNTAX_CSS:
        return this.baseRule(tokens);
      case SYNTAX_SCSS:
        return this.scssRule(tokens);
      default:
        return this.lessRule(tokens);
    }
  }

  private baseRule(tokens: TokList): number {
    tokens.truncate(tokens.n - 1);
    const start = tokens.n > 0 ? tokens.start(0) : 0;
    const id = this.newNodeOf(K_RULE, start);
    const betweenS = this.spacesAndCommentsFromEnd(tokens);
    const betweenE = this.jE;
    const hasClean = this.clean(tokens, 0, tokens.n, false);
    const cs = this.cleanS;
    const ce = this.cleanE;
    const selS = this.rangeOf(tokens, 0, tokens.n);
    const selE = this.jE;
    const f = this.tree.f;
    const o = id * NS;
    f[o + F_BETWEEN_S] = betweenS;
    f[o + F_BETWEEN_E] = betweenE;
    f[o + F_SELECTOR_S] = selS;
    f[o + F_SELECTOR_E] = selE;
    f[o + F_CLEAN_SELECTOR_S] = hasClean ? cs : -1;
    f[o + F_CLEAN_SELECTOR_E] = hasClean ? ce : 0;
    this.open(id);
    return 0;
  }

  /** `colon`: the index of the first `:` outside of parentheses in tokens [from, to): -1 if there is none, -2 on an error
   * (nothing is before it). */
  private colon(tokens: TokList, from: number, to: number): number {
    let brackets = 0;
    let prev = -1;
    for (let index = from; index < to; index++) {
      const kind = tokens.kind(index);
      if (kind === C_LPAREN) brackets = brackets + 1;
      if (kind === C_RPAREN) brackets = brackets - 1;
      if (brackets === 0 && kind === C_COLON) {
        if (prev < 0) return noteRefusal(MSG_UNEXPECTED_COLON, tokens.rs(index)) - 1;
        if (tokens.kind(prev) === TK_WORD && eqLit(this.buf.data, tokens.rs(prev), tokens.re(prev), "progid")) {
          continue;
        }
        return index;
      }
      prev = index;
    }
    return -1;
  }

  /** Takes `!important` from the end of `tokens`, of which only those from `base` on are there for it. `lowest`: the index of
   * the first of them that is looked at. `anyCase`: whether it can be written in upper case. */
  private takeImportant(id: number, tokens: TokList, base: number, lowest: number, anyCase: boolean): void {
    const css = this.buf.data;
    let index = tokens.n;
    while (index > base + lowest) {
      index = index - 1;
      const tokKind = tokens.kind(index);
      const ts = tokens.rs(index);
      const te = tokens.re(index);
      const isBangImportant = anyCase ? eqLitIgnoreCase(css, ts, te, "!important") : eqLit(css, ts, te, "!important");
      const isImportant = !isBangImportant && (anyCase ? eqLitIgnoreCase(css, ts, te, "important") : eqLit(css, ts, te, "important"));
      if (isBangImportant) {
        let sS = this.rangeOf(tokens, index, tokens.n);
        let sE = this.jE;
        tokens.truncate(index);
        let keep = base;
        for (let i = tokens.n - 1; i >= base; i--) {
          if (tokens.kind(i) !== TK_SPACE) { keep = i + 1; break; }
        }
        const spS = this.rangeOf(tokens, keep, tokens.n);
        const spE = this.jE;
        sS = this.join(spS, spE, sS, sE);
        sE = this.jE;
        tokens.truncate(keep);
        const isPlain = eqLit(this.buf.data, sS, sE, " !important");
        const f = this.tree.f;
        const o = id * NS;
        f[o + F_IMPORTANT] = 1;
        if (!isPlain) {
          f[o + F_RAW_IMPORTANT_S] = sS;
          f[o + F_RAW_IMPORTANT_E] = sE;
        } else {
          f[o + F_RAW_IMPORTANT_S] = -1;
        }
        break;
      } else if (isImportant) {
        const cache = this.cache;
        cache.n = 0;
        for (let i = base; i < tokens.n; i++) cache.pushFrom(tokens, i);
        let sS = 0;
        let sE = 0;
        let j = index - base;
        while (j > 0) {
          const ws = trimJsWhitespaceStart(this.buf.data, sS, sE);
          const startsWithBang = ws < sE && (this.buf.data[ws] | 0) === 33;
          if (startsWithBang && j < cache.n && cache.kind(j) !== TK_SPACE) break;
          if (cache.n > 0) {
            const last = cache.n - 1;
            sS = this.join(cache.rs(last), cache.re(last), sS, sE);
            sE = this.jE;
            cache.truncate(last);
          }
          j = j - 1;
        }
        const ws = trimJsWhitespaceStart(this.buf.data, sS, sE);
        if (ws < sE && (this.buf.data[ws] | 0) === 33) {
          const f = this.tree.f;
          const o = id * NS;
          f[o + F_IMPORTANT] = 1;
          f[o + F_RAW_IMPORTANT_S] = sS;
          f[o + F_RAW_IMPORTANT_E] = sE;
          tokens.truncate(base);
          for (let i = 0; i < cache.n; i++) tokens.pushFrom(cache, i);
        }
      }
      if (!(tokKind === TK_SPACE || tokKind === TK_COMMENT)) break;
    }
  }

  private decl(tokens: TokList, customProperty: boolean): number {
    if (tokens.n === 0) return this.atEnd();
    const firstStart = tokens.start(0);
    const firstRs = tokens.rs(0);
    const lastIdx = tokens.n - 1;
    const id = this.newNodeOf(K_DECL, firstStart);
    if (tokens.kind(lastIdx) === C_SEMI) {
      this.semicolon = true;
    }
    // `last.last_position().or_else(|| tokens.iter().rev().find_map(...))`: with the `;` taken off, as Rust does
    const lastWasSemi = tokens.kind(lastIdx) === C_SEMI;
    let endPos = tokens.lastPosition(lastIdx);
    if (lastWasSemi) tokens.truncate(tokens.n - 1);
    if (endPos < 0) {
      for (let i = tokens.n - 1; i >= 0; i--) {
        const lp = tokens.lastPosition(i);
        if (lp >= 0) { endPos = lp; break; }
      }
    }
    this.tree.f[id * NS + F_END] = endPos >= 0 ? endPos + 1 : -1;

    let start = -1;
    for (let i = 0; i < tokens.n; i++) {
      if (tokens.kind(i) === TK_WORD) { start = i; break; }
    }
    if (start < 0) return noteRefusal(MSG_PROPERTY_WITHOUT_NAME, firstRs);
    const beforeS = this.rangeOf(tokens, 0, start);
    const beforeE = this.jE;
    {
      const f = this.tree.f;
      const o = id * NS;
      const s = this.join(f[o + F_BEFORE_S] | 0, f[o + F_BEFORE_E] | 0, beforeS, beforeE);
      this.tree.f[o + F_BEFORE_S] = s;
      this.tree.f[o + F_BEFORE_E] = this.jE;
      this.tree.f[o + F_START] = tokens.start(start);
    }

    let propLen = tokens.n - start;
    for (let i = start; i < tokens.n; i++) {
      const k = tokens.kind(i);
      if (k === C_COLON || k === TK_SPACE || k === TK_COMMENT) { propLen = i - start; break; }
    }
    let propS = this.rangeOf(tokens, start, start + propLen);
    const propE = this.jE;
    let at = start + propLen;

    const betweenStart = at;
    while (at < tokens.n) {
      const k = tokens.kind(at);
      at = at + 1;
      if (k === C_COLON) break;
      if (k === TK_WORD) {
        const css = this.buf.data;
        const rs = tokens.rs(at - 1);
        const re = tokens.re(at - 1);
        let anyWord = false;
        for (let i = rs; i < re; i++) {
          if (isRegexpWordByte(css[i] | 0)) { anyWord = true; break; }
        }
        if (anyWord) return noteRefusal(MSG_EXPECTED_COLON, rs);
      }
    }
    let betweenS = this.rangeOf(tokens, betweenStart, at);
    let betweenE = this.jE;

    if (propE > propS) {
      const c = this.buf.data[propS] | 0;
      if (c === 95 || c === 42) {
        const f = this.tree.f;
        const o = id * NS;
        const s = this.join(f[o + F_BEFORE_S] | 0, f[o + F_BEFORE_E] | 0, propS, propS + 1);
        this.tree.f[o + F_BEFORE_S] = s;
        this.tree.f[o + F_BEFORE_E] = this.jE;
        propS = propS + 1;
      }
    }

    const firstSpacesStart = at;
    while (at < tokens.n && tokens.isSpaceOrComment(at)) at = at + 1;
    this.takeImportant(id, tokens, at, 0, true);
    // `(first_spaces, tokens)`: [firstSpacesStart, at) and [at, n)
    let hasWord = false;
    for (let i = at; i < tokens.n; i++) {
      if (!tokens.isSpaceOrComment(i)) { hasWord = true; break; }
    }
    let valueS = this.rangeOf(tokens, at, tokens.n);
    let valueE = this.jE;
    const fsS = this.rangeOf(tokens, firstSpacesStart, at);
    const fsE = this.jE;
    let hasClean: boolean;
    if (hasWord) {
      betweenS = this.join(betweenS, betweenE, fsS, fsE);
      betweenE = this.jE;
      hasClean = this.clean(tokens, at, tokens.n, customProperty);
    } else {
      valueS = this.join(fsS, fsE, valueS, valueE);
      valueE = this.jE;
      hasClean = this.clean(tokens, firstSpacesStart, tokens.n, customProperty);
    }
    const cs = this.cleanS;
    const ce = this.cleanE;
    let extend = false;
    if (this.syntax === SYNTAX_LESS) {
      if (hasClean) extend = hasExtend(this.tree.cleans.data, cs, ce, "extend(");
      else extend = hasExtend(this.buf.data, valueS, valueE, "extend(");
    }
    {
      const f = this.tree.f;
      const o = id * NS;
      f[o + F_PROP_S] = propS;
      f[o + F_PROP_E] = propE;
      f[o + F_BETWEEN_S] = betweenS;
      f[o + F_BETWEEN_E] = betweenE;
      f[o + F_VALUE_S] = valueS;
      f[o + F_VALUE_E] = valueE;
      f[o + F_CLEAN_VALUE_S] = hasClean ? cs : -1;
      f[o + F_CLEAN_VALUE_E] = hasClean ? ce : 0;
      f[o + F_EXTEND] = extend ? 1 : 0;
    }

    if (!customProperty) {
      const colon = this.colon(tokens, at, tokens.n);
      if (colon === -2) return -1;
      if (colon >= 0) return noteRefusal(MSG_UNEXPECTED_COLON, tokens.rs(colon));
    }
    return 0;
  }

  private unknownWord(tokens: TokList): number {
    if (this.syntax !== SYNTAX_LESS || tokens.n === 0) {
      if (tokens.n > 0) return noteRefusal(MSG_NEITHER_DECLARATION_NOR_RULE, tokens.rs(0));
      return this.atEnd();
    }
    const css = this.buf.data;
    const fs = tokens.rs(0);
    const fe = tokens.re(0);
    if (eqLit(css, fs, fe, "each")) {
      if (tokens.n < 2) return noteRefusal(MSG_NEITHER_DECLARATION_NOR_RULE, fs);
      if (tokens.kind(1) === C_LPAREN) return this.lessEach(tokens);
    }
    // `isMixinToken`
    let isHashColor = false;
    if ((css[fs] | 0) === 35 && (fe - fs === 4 || fe - fs === 7)) {
      isHashColor = true;
      for (let i = fs + 1; i < fe; i++) {
        if (!isHexB(css[i] | 0)) { isHashColor = false; break; }
      }
    }
    let hasFraction = false;
    for (let i = fs + 1; i < fe; i++) {
      const c = css[i] | 0;
      if ((css[i - 1] | 0) === 46 && c >= 48 && c <= 57) { hasFraction = true; break; }
    }
    const first = fe > fs ? css[fs] | 0 : -1;
    if ((first === 46 || first === 35) && !isHashColor && !hasFraction) return this.lessMixin(tokens);
    return noteRefusal(MSG_NEITHER_DECLARATION_NOR_RULE, fs);
  }

  // ───────────────────────────── postcss-scss ─────────────────────────────

  private scssRule(tokens: TokList): number {
    let withColon = false;
    let brackets = 0;
    // Of what is behind the colon, comments aside: the first character, and whether there is more to it than white space.
    let firstByte = -1;
    let isBlank = true;
    const css = this.buf.data;
    for (let i = 0; i < tokens.n; i++) {
      const kind = tokens.kind(i);
      const rs = tokens.rs(i);
      const re = tokens.re(i);
      if (withColon) {
        if (kind !== TK_COMMENT && kind !== C_LBRACE) {
          if (firstByte < 0 && re > rs) firstByte = css[rs] | 0;
          isBlank = isBlank && trimJsWhitespaceStart(css, rs, re) === re;
        }
      } else if (kind === TK_SPACE && containsByteIn(css, rs, re, 10)) {
        break;
      } else if (kind === C_LPAREN) {
        brackets = brackets + 1;
      } else if (kind === C_RPAREN) {
        brackets = brackets - 1;
      } else if (brackets === 0 && kind === C_COLON) {
        withColon = true;
      }
    }
    if (!withColon || isBlank || (firstByte >= 0 && (firstByte === 35 || firstByte === 58 || firstByte === 45 || (lowerByte(firstByte) >= 97 && lowerByte(firstByte) <= 122)))) {
      return this.baseRule(tokens);
    }

    tokens.truncate(tokens.n - 1);
    if (tokens.n === 0) return this.atEnd();
    const id = this.newNodeOf(K_DECL, tokens.start(0));
    this.tree.f[id * NS + F_IS_NESTED] = 1;
    let lastIdx = -1;
    for (let i = tokens.n - 1; i >= 0; i--) {
      if (tokens.kind(i) !== TK_SPACE) { lastIdx = i; break; }
    }
    if (lastIdx < 0) return this.atEnd();
    {
      const lp = tokens.lastPosition(lastIdx);
      this.tree.f[id * NS + F_END] = lp >= 0 ? lp + 1 : -1;
    }

    let start = -1;
    for (let i = 0; i < tokens.n; i++) {
      if (tokens.kind(i) === TK_WORD) { start = i; break; }
    }
    if (start < 0) return noteRefusal(MSG_PROPERTY_WITHOUT_NAME, this.tree.f[id * NS + F_START] | 0);
    const beforeS = this.rangeOf(tokens, 0, start);
    const beforeE = this.jE;
    {
      const f = this.tree.f;
      const o = id * NS;
      const s = this.join(f[o + F_BEFORE_S] | 0, f[o + F_BEFORE_E] | 0, beforeS, beforeE);
      this.tree.f[o + F_BEFORE_S] = s;
      this.tree.f[o + F_BEFORE_E] = this.jE;
      this.tree.f[o + F_START] = tokens.start(start);
    }

    let propLen = tokens.n - start;
    for (let i = start; i < tokens.n; i++) {
      const k = tokens.kind(i);
      if (k === C_COLON || k === TK_SPACE || k === TK_COMMENT) { propLen = i - start; break; }
    }
    let propS = this.rangeOf(tokens, start, start + propLen);
    const propE = this.jE;
    let at = start + propLen;
    const betweenStart = at;
    while (at < tokens.n) {
      const k = tokens.kind(at);
      at = at + 1;
      if (k === C_COLON) break;
    }
    if (propE > propS) {
      const c = this.buf.data[propS] | 0;
      if (c === 95 || c === 42) {
        const f = this.tree.f;
        const o = id * NS;
        const s = this.join(f[o + F_BEFORE_S] | 0, f[o + F_BEFORE_E] | 0, propS, propS + 1);
        this.tree.f[o + F_BEFORE_S] = s;
        this.tree.f[o + F_BEFORE_E] = this.jE;
        propS = propS + 1;
      }
    }
    while (at < tokens.n && tokens.isSpaceOrComment(at)) at = at + 1;
    const betweenS = this.rangeOf(tokens, betweenStart, at);
    const betweenE = this.jE;
    this.takeImportant(id, tokens, at, 1, false);
    const hasClean = this.clean(tokens, at, tokens.n, false);
    const cs = this.cleanS;
    const ce = this.cleanE;
    const valueS = this.rangeOf(tokens, at, tokens.n);
    const valueE = this.jE;
    {
      const f = this.tree.f;
      const o = id * NS;
      f[o + F_PROP_S] = propS;
      f[o + F_PROP_E] = propE;
      f[o + F_BETWEEN_S] = betweenS;
      f[o + F_BETWEEN_E] = betweenE;
      f[o + F_VALUE_S] = valueS;
      f[o + F_VALUE_E] = valueE;
      f[o + F_CLEAN_VALUE_S] = hasClean ? cs : -1;
      f[o + F_CLEAN_VALUE_E] = hasClean ? ce : 0;
    }
    const colon = this.colon(tokens, at, tokens.n);
    if (colon === -2) return -1;
    if (colon >= 0) return noteRefusal(MSG_UNEXPECTED_COLON, tokens.rs(colon));
    this.open(id);
    return 0;
  }

  // ───────────────────────────── postcss-less ─────────────────────────────

  /** `interpolation`: makes one word of `@{a}` and what is attached to it. `token`: the `@` token. Returns 1 (it did), 0, or -1
   * (refused). */
  private lessInterpolation(tkRs: number, tkRe: number, tkStart: number): number {
    let r = this.nextToken(false);
    if (r < 0) return -1;
    // `next`
    if (tkRe - tkRs > 1) {
      if (r === 1) this.backCurrent();
      else this.backNone();
      return 0;
    }
    if (r === 0) return this.atEnd();
    if (this.tk !== C_LBRACE) {
      this.backCurrent();
      return 0;
    }
    let lastRe = this.tre;
    let lastStart = this.tstart;
    r = this.nextToken(false);
    if (r < 0) return -1;
    while (r === 1 && (this.tk === TK_WORD || this.tk === C_RBRACE)) {
      lastRe = this.tre;
      lastStart = this.tstart;
      r = this.nextToken(false);
      if (r < 0) return -1;
    }
    if (r === 1) this.backCurrent();
    else this.backNone();
    this.backTok(TK_WORD, tkRs, lastRe, tkStart, lastStart, 0);
    return 1;
  }

  private lessAtrule(tkKind: number, tkRs: number, tkRe: number, tkStart: number, tkLast: number, tkInline: number, nameS: number, nameE: number): number {
    void tkKind;
    void tkLast;
    void tkInline;
    const r = this.lessInterpolation(tkRs, tkRe, tkStart);
    if (r < 0) return -1;
    if (r === 1) return 0;
    if (this.baseAtrule(tkStart, nameS, nameE) < 0) return -1;

    // `nodes/variable.js`
    const f0 = this.tree.f;
    const o = this.lastNode * NS;
    const ns = f0[o + F_NAME_S] | 0;
    const ne = f0[o + F_NAME_E] | 0;
    const css = this.buf.data;
    if (!(ne > ns && (css[ne - 1] | 0) === 58)) return 0;
    // `name.replace(":", "")` takes the first colon, which need not be the last.
    let firstColon = 0;
    for (let i = ns; i < ne; i++) {
      if ((css[i] | 0) === 58) { firstColon = i - ns; break; }
    }
    const lastColonS = ne - 1;
    const nS = this.join(ns, ns + firstColon, ns + firstColon + 1, ne);
    const nE = this.jE;
    this.tree.f[o + F_NAME_S] = nS;
    this.tree.f[o + F_NAME_E] = nE;
    const an = this.join(lastColonS, ne, this.tree.f[o + F_AFTER_NAME_S] | 0, this.tree.f[o + F_AFTER_NAME_E] | 0);
    this.tree.f[o + F_AFTER_NAME_S] = an;
    this.tree.f[o + F_AFTER_NAME_E] = this.jE;
    this.tree.f[o + F_VARIABLE] = 1;
    // `/^:(\s+)?/`
    const f = this.tree.f;
    const hasCleanParams = (f[o + F_CLEAN_PARAMS_S] | 0) >= 0;
    const pdata = hasCleanParams ? this.tree.cleans.data : this.buf.data;
    const ps = hasCleanParams ? f[o + F_CLEAN_PARAMS_S] | 0 : f[o + F_PARAMS_S] | 0;
    const pe = hasCleanParams ? f[o + F_CLEAN_PARAMS_E] | 0 : f[o + F_PARAMS_E] | 0;
    if (pe > ps && (pdata[ps] | 0) === 58) {
      const skips = 1 + leadingWhiteSpaceLen(pdata, ps + 1, pe);
      f[o + F_VALUE_SKIPS] = skips;
      const paramsStart = f[o + F_PARAMS_S] | 0;
      const a2 = this.join(f[o + F_AFTER_NAME_S] | 0, f[o + F_AFTER_NAME_E] | 0, paramsStart, paramsStart + skips);
      this.tree.f[o + F_AFTER_NAME_S] = a2;
      this.tree.f[o + F_AFTER_NAME_E] = this.jE;
    }
    return 0;
  }

  private lessEach(tokens: TokList): number {
    let firstParen = -1;
    for (let i = 0; i < tokens.n; i++) {
      if (tokens.kind(i) === C_LPAREN) { firstParen = i; break; }
    }
    if (firstParen < 0) return this.atEnd();
    let lastParen = -1;
    for (let i = tokens.n - 1; i >= 0; i--) {
      if (tokens.kind(i) === C_RPAREN) { lastParen = i; break; }
    }
    if (lastParen < 0) return noteRefusal(MSG_UNCLOSED_BRACKET, this.unclosedBracket(tokens));
    const upTo = firstParen + lastParen < tokens.n ? firstParen + lastParen : tokens.n;
    const pS = this.rangeOf(tokens, firstParen, upTo);
    const pE = this.jE;
    tokens.removeRange(firstParen, upTo);
    for (let i = tokens.n - 1; i >= 0; i--) this.backFrom(tokens, i);
    const r = this.nextToken(false);
    if (r < 0) return -1;
    if (r === 0) return this.atEnd();
    // A space has been put before the name, which the `@` is taken for.
    if (this.lessAtrule(this.tk, this.trs, this.tre, this.tstart, this.tlast, this.tinline, this.trs, this.tre) < 0) return -1;
    const o = this.lastNode * NS;
    const f = this.tree.f;
    f[o + F_FUNCTION] = 1;
    f[o + F_PARAMS_S] = pS;
    f[o + F_PARAMS_E] = pE;
    f[o + F_CLEAN_PARAMS_S] = -1;
    return 0;
  }

  private lessMixin(tokens: TokList): number {
    if (tokens.n === 0) return this.atEnd();
    const css = this.buf.data;
    const identS = tokens.rs(0);
    let bracketsIndex = -1;
    let firstParen = -1;
    for (let i = 0; i < tokens.n; i++) {
      if (bracketsIndex < 0 && tokens.kind(i) === TK_BRACKETS) bracketsIndex = i;
      if (firstParen < 0 && tokens.kind(i) === C_LPAREN) firstParen = i;
    }
    // Rule sets as arguments: everything in the parentheses becomes one token.
    if ((bracketsIndex < 0 || bracketsIndex > 3) && firstParen > 0) {
      let lastParen = -1;
      for (let i = tokens.n - 1; i >= 0; i--) {
        if (tokens.kind(i) === C_RPAREN) { lastParen = i; break; }
      }
      if (lastParen < 0) return noteRefusal(MSG_UNCLOSED_BRACKET, this.unclosedBracket(tokens));
      // The end is what `postcss-less` takes, which is too far if there is more than the name before the parenthesis.
      const cEnd = lastParen + firstParen < tokens.n ? lastParen + firstParen : tokens.n;
      const has = cEnd > firstParen;
      const rs = has ? tokens.rs(firstParen) : 0;
      const re = has ? tokens.re(cEnd - 1) : 0;
      const start = tokens.start(firstParen);
      const to = (lastParen > firstParen ? lastParen : firstParen) + 1;
      tokens.replaceRange(firstParen, to < tokens.n ? to : tokens.n, TK_BRACKETS, rs, re, start, -1, 0);
    }

    let importantStart = -1;
    let importantEnd = 0;
    for (let index = 0; index < tokens.n; index++) {
      const isBang = eqLit(css, tokens.rs(index), tokens.re(index), "!");
      if (isBang || importantStart >= 0) {
        if (importantStart < 0) importantStart = index;
        importantEnd = index + 1;
      }
      if (eqLit(css, tokens.rs(index), tokens.re(index), "important")) break;
    }
    if (importantStart >= 0) {
      tokens.replaceRange(
        importantStart,
        importantEnd,
        TK_WORD,
        tokens.rs(importantStart),
        tokens.re(importantEnd - 1),
        tokens.start(importantStart),
        tokens.last(importantStart),
        0,
      );
    }

    // `/(!\s*important)$/i`
    let importantIndex = -1;
    for (let i = 0; i < tokens.n; i++) {
      const rs = tokens.rs(i);
      const re = tokens.re(i);
      if (re - rs >= 9 && eqLitIgnoreCase(css, re - 9, re, "important")) {
        const before = trimJsWhitespaceEnd(css, rs, re - 9);
        if (before > rs && (css[before - 1] | 0) === 33) { importantIndex = i; break; }
      }
    }
    let impS = -1;
    let impE = 0;
    if (importantIndex > 0) {
      impS = tokens.rs(importantIndex);
      impE = tokens.re(importantIndex);
      tokens.removeRange(importantIndex, importantIndex + 1);
    }

    for (let i = tokens.n - 1; i >= 0; i--) this.backFrom(tokens, i);
    const r = this.nextToken(false);
    if (r < 0) return -1;
    if (r === 0) return this.atEnd();
    if (this.lessAtrule(this.tk, this.trs, this.tre, this.tstart, this.tlast, this.tinline, this.trs + 1, this.tre) < 0) return -1;
    const o = this.lastNode * NS;
    const f = this.tree.f;
    f[o + F_MIXIN] = 1;
    f[o + F_IDENTIFIER_S] = identS;
    f[o + F_IDENTIFIER_E] = identS + 1;
    if (impS >= 0) {
      f[o + F_IMPORTANT] = 1;
      f[o + F_RAW_IMPORTANT_S] = impS;
      f[o + F_RAW_IMPORTANT_E] = impE;
    }
    return 0;
  }

  /** The first half of `rule`: whether `tokens` end with the `@{` of an interpolation. These two are taken from them then, and
   * the next token is the interpolation. Returns 1 (they do), 0, -1 (refused). */
  private lessRuleInterpolation(tokens: TokList): number {
    if (tokens.n < 2) return 0;
    const prev = tokens.n - 2;
    const last = tokens.n - 1;
    if (tokens.kind(prev) !== TK_AT_WORD || tokens.kind(last) !== C_LBRACE) return 0;
    this.backFrom(tokens, last);
    const r = this.lessInterpolation(tokens.rs(prev), tokens.re(prev), tokens.start(prev));
    if (r < 0) return -1;
    if (r === 1) tokens.truncate(tokens.n - 2);
    return r;
  }

  private lessRule(tokens: TokList): number {
    if (this.baseRule(tokens) < 0) return -1;
    const f = this.tree.f;
    const o = this.lastNode * NS;
    const cs = f[o + F_CLEAN_SELECTOR_S] | 0;
    if (cs >= 0) f[o + F_EXTEND] = hasExtend(this.tree.cleans.data, cs, f[o + F_CLEAN_SELECTOR_E] | 0, ":extend(") ? 1 : 0;
    else f[o + F_EXTEND] = hasExtend(this.buf.data, f[o + F_SELECTOR_S] | 0, f[o + F_SELECTOR_E] | 0, ":extend(") ? 1 : 0;
    return 0;
  }

  /** `isInlineComment`: the token is given by its fields. Returns 1 if it was one, 0 if not, -1 (refused). */
  private lessInlineComment(kind0: number, rs0: number, re0: number, start0: number, last0: number, inline0: number): number {
    const rs = rs0;
    let re = re0;
    const start = start0;
    void last0;
    void inline0;
    const css = this.buf.data;
    if (kind0 === TK_WORD && startsWithLit(css, rs, re, "//")) {
      let end = rs;
      let remainingInput = -1;
      // `current`: the token being looked at (the first is `token` itself)
      let curRs = rs;
      let curRe = re;
      let curKind = kind0;
      let curLast = last0;
      let curStart = start0;
      let curInline = inline0;
      let hasCurrent = true;
      while (hasCurrent) {
        const text = this.buf.data;
        const lineBreak = indexOfByteIn(text, curRs, curRe, 10);
        if (lineBreak >= 0) {
          // `/['"].*\r?\n/`: a string that goes on in the next line.
          const lastLineBreak = lastIndexOfByteIn(text, curRs, curRe, 10);
          if (indexOfAny2(text, curRs, lastLineBreak, 39, 34) >= 0) {
            end = curRs + (lineBreak - curRs);
            remainingInput = end;
          } else {
            this.backTok(curKind, curRs, curRe, curStart, curLast, curInline);
          }
          break;
        }
        end = curRe;
        const r = this.nextToken(true);
        if (r < 0) return -1;
        if (r === 0) {
          hasCurrent = false;
        } else {
          curKind = this.tk;
          curRs = this.trs;
          curRe = this.tre;
          curStart = this.tstart;
          curLast = this.tlast;
          curInline = this.tinline;
        }
      }
      const id = this.newNodeOf(K_COMMENT, start);
      this.trimmed(rs + 2, end);
      const f = this.tree.f;
      const o = id * NS;
      f[o + F_INLINE] = 1;
      f[o + F_TEXT_S] = this.outS;
      f[o + F_TEXT_E] = this.outE;
      // From here on, `postcss-less` counts from the start of the rest of the text.
      if (remainingInput >= 0) {
        this.pos = remainingInput;
        this.shift = remainingInput;
        this.nWordBuf = 0;
        this.nReturned = 0;
        this.lastBadParen = -1;
      }
      return 1;
    }
    if (eqLit(css, rs, re, "/")) {
      const r = this.nextToken(true);
      if (r < 0) return -1;
      if (r === 0) return this.atEnd();
      if (this.tk === TK_COMMENT && startsWithLit(this.buf.data, this.trs, this.tre, "/*")) {
        // next.kind = Word; next.range.start += 1; token.range.end += 1; back(next)
        this.backTok(TK_WORD, this.trs + 1, this.tre, this.tstart, this.tlast, this.tinline);
        re = re + 1;
        return this.lessInlineComment(kind0, rs, re, start, last0, inline0);
      }
      // Otherwise the token is lost.
    }
    return 0;
  }

  /** Dev aid: the number of tokens of text[0, len) (tokenizer only). */
  tokenizeOnly(text: Uint8Array, len: number): number {
    const buf = this.buf;
    buf.len = 0;
    buf.append(text, 0, len);
    buf.push(0);
    this.cssLen = len;
    this.syntax = SYNTAX_CSS;
    this.pos = 0;
    this.shift = 0;
    this.nWordBuf = 0;
    this.nReturned = 0;
    this.lastBadParen = -1;
    this.nextCloseState = 0;
    let n = 0;
    while (!this.endOfFile()) {
      const r = this.nextToken(false);
      if (r <= 0) break;
      n = n + 1;
    }
    return n;
  }

  // ───────────────────────────── entry ─────────────────────────────

  /** Parses `text[0, len)`; `startPos` > 0 for a custom property set. Returns the tree, or null (refused). */
  parseText(text: Uint8Array, len: number, syntax: number, pos: number, isCustomPropertySet: boolean, placeholder: number): Tree | null {
    // Half of the numbers are for `Texts::extra`, which is no longer than the text.
    if (len >= 1073741823) {
      noteRefusal(MSG_TOO_LARGE, 0);
      return null;
    }
    const buf = this.buf;
    buf.len = 0;
    buf.append(text, 0, len);
    buf.push(0);
    this.cssLen = len;
    this.syntax = syntax;
    this.isInOrder = syntax !== SYNTAX_LESS;
    this.placeholder = placeholder;
    this.pos = pos;
    this.shift = 0;
    this.nWordBuf = 0;
    this.nReturned = 0;
    this.lastBadParen = -1;
    this.nextCloseState = 0;
    this.current = 0;
    this.lastNode = 0;
    this.spaceS = 0;
    this.spaceE = 0;
    this.semicolon = false;
    this.isCustomPropertySet = isCustomPropertySet;
    const tree = this.tree;
    tree.reset();
    // the root
    tree.push();
    tree.f[F_HAS_BLOCK] = 1;
    if (this.parse() < 0) return null;
    tree.extraLen = buf.len - (len + 1);
    return tree;
  }
}

/** The texts of `refusal`: re-exported for the callers. */
export { noteRefusal };
void SYNTAX_LESS;
void jsWhitespaceLen;
