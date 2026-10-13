// Port of vendor/bun/src/format/handlebars/lexer.rs: the lexer of `@handlebars/parser` (`src/handlebars.l`): in each
// state the first rule that matches wins.
//
// Rust `Result<(), Error>` is an int: 0 is ok, -1 a syntax error (noted with `noteRefusal`).
import {
  MSG_UNCLOSED_BLOCK,
  MSG_UNCLOSED_BRACKET,
  MSG_UNCLOSED_COMMENT,
  MSG_UNCLOSED_STRING,
  MSG_UNEXPECTED_CHARACTER,
  MSG_UNEXPECTED_END,
  noteRefusal,
} from "../syntax_error.ts";
import { jsWhitespaceLen, leadingWhiteSpaceLen } from "../text.ts";

export const TK_CONTENT: number = 0; // from `start` to `end` is its value: without the backslash that escapes what follows
export const TK_COMMENT: number = 1;
export const TK_OPEN_SEXPR: number = 2;
export const TK_CLOSE_SEXPR: number = 3;
export const TK_OPEN_RAW_BLOCK: number = 4;
export const TK_CLOSE_RAW_BLOCK: number = 5;
export const TK_END_RAW_BLOCK: number = 6;
export const TK_OPEN_PARTIAL: number = 7;
export const TK_OPEN_PARTIAL_BLOCK: number = 8;
export const TK_OPEN_BLOCK: number = 9;
export const TK_OPEN_END_BLOCK: number = 10;
export const TK_INVERSE: number = 11;
export const TK_OPEN_INVERSE: number = 12;
export const TK_OPEN_INVERSE_CHAIN: number = 13;
export const TK_OPEN_UNESCAPED: number = 14;
export const TK_OPEN: number = 15;
export const TK_EQUALS: number = 16;
export const TK_ID: number = 17;
export const TK_SEP: number = 18;
export const TK_PRIVATE_SEP: number = 19;
export const TK_CLOSE_UNESCAPED: number = 20;
export const TK_CLOSE: number = 21;
export const TK_STRING: number = 22;
export const TK_DATA: number = 23;
export const TK_BOOLEAN: number = 24;
export const TK_UNDEFINED: number = 25;
export const TK_NULL: number = 26;
export const TK_NUMBER: number = 27;
export const TK_OPEN_BLOCK_PARAMS: number = 28;
export const TK_CLOSE_BLOCK_PARAMS: number = 29;
export const TK_EOF: number = 30;

const S_INITIAL: number = 0;
const S_MU: number = 1;
const S_EMU: number = 2;
const S_COM: number = 3;
const S_RAW: number = 4;

// The ASCII bytes that `[^\s!"#%-,\.\/;->@\[-\^`\{-~]` matches.
const ID_ASCII = new Uint8Array(256);
{
  const set = "$-:?_\x7F";
  for (let i = 0; i < set.length; i++) ID_ASCII[set.charCodeAt(i)] = 1;
  for (let c = 0x00; c <= 0x08; c++) ID_ASCII[c] = 1;
  for (let c = 0x0e; c <= 0x1f; c++) ID_ASCII[c] = 1;
  for (let c = 48; c <= 57; c++) ID_ASCII[c] = 1;
  for (let c = 65; c <= 90; c++) ID_ASCII[c] = 1;
  for (let c = 97; c <= 122; c++) ID_ASCII[c] = 1;
}
export const ID_TABLE: Uint8Array = ID_ASCII;

// How many bytes at the start of `text[at, end)` can be in an `ID`.
export function idLen(text: Uint8Array, at: number, end: number): number {
  const table = ID_ASCII;
  let p = at;
  while (true) {
    while (p < end && (table[text[p] | 0] | 0) !== 0) p = ((p | 0) + 1) | 0;
    if (p < end && (text[p] | 0) >= 0x80 && jsWhitespaceLen(text, p, end) === 0) {
      p = ((p | 0) + 1) | 0;
    } else {
      return p - at;
    }
  }
}

// `LOOKAHEAD`: `[=~}\s\/.)\]|]`, at `text[at]`.
function isLookahead(text: Uint8Array, at: number, end: number): boolean {
  if (at >= end) return false;
  const c = text[at] | 0;
  if (c === 61 || c === 126 || c === 125 || c === 47 || c === 46 || c === 41 || c === 93 || c === 124) return true;
  return jsWhitespaceLen(text, at, end) > 0;
}

// `LITERAL_LOOKAHEAD`: `[~}\s)\]]`
function isLiteralLookahead(text: Uint8Array, at: number, end: number): boolean {
  if (at >= end) return false;
  const c = text[at] | 0;
  if (c === 126 || c === 125 || c === 41 || c === 93) return true;
  return jsWhitespaceLen(text, at, end) > 0;
}

// `open(\\close|[^close])*close`, where `text[at]` is the opening character: where the match ends (an offset), or -1.
// It ends at the first `close` without a backslash before it. If there is none, at the last one with a backslash.
function delimitedEnd(text: Uint8Array, at: number, end: number, close: number): number {
  let p = at + 1;
  let lastEscaped = -1;
  while (p < end) {
    let found = -1;
    for (let i = p; i < end; i++) {
      if ((text[i] | 0) === close) {
        found = i;
        break;
      }
    }
    if (found < 0) break;
    p = found + 1;
    if ((text[p - 2] | 0) !== 92) return p;
    lastEscaped = p;
  }
  return lastEscaped;
}

// `\-?[0-9]+(?:\.[0-9]+)?/{LITERAL_LOOKAHEAD}`: the length of the match at `text[at]`, or -1.
function numberLen(text: Uint8Array, at: number, end: number): number {
  let p = at;
  if (p < end && (text[p] | 0) === 45) p = p + 1;
  const whole = p;
  while (p < end && (text[p] | 0) >= 48 && (text[p] | 0) <= 57) p = p + 1;
  if (p === whole) return -1;
  if (p < end && (text[p] | 0) === 46) {
    const frac = p + 1;
    let q = frac;
    while (q < end && (text[q] | 0) >= 48 && (text[q] | 0) <= 57) q = q + 1;
    if (q === frac) return -1;
    p = q;
  }
  return isLiteralLookahead(text, p, end) ? p - at : -1;
}

// `text[at..]` starts with the printable-ASCII `lit`.
function startsWithAt(text: Uint8Array, at: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (at + n > end) return false;
  for (let i = 0; i < n; i++) {
    if ((text[at + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

// The first `needle` (printable ASCII) in text[from, end), or -1.
function findAscii(text: Uint8Array, from: number, end: number, needle: string): number {
  const n = needle.length;
  const first = needle.charCodeAt(0) | 0;
  const last = (end - n) | 0;
  for (let i = from | 0; i <= last; i++) {
    if ((text[i] | 0) === first && startsWithAt(text, i, end, needle)) return i;
  }
  return -1;
}

// Where the first `{{` is in `text[at, end)`: -1 if there is none, -2 if a NUL is before it. Four bytes at a time.
function scanContent(text: Uint8Array, dv: DataView, at: number, end: number): number {
  let i = at | 0;
  const e = end | 0;
  const e4 = (e - 4) | 0;
  while (i < e) {
    if (i <= e4) {
      const w = dv.getUint32(i, true) | 0;
      const x = w ^ 0x7b7b7b7b;
      // A byte of `w` is `{` or NUL.
      const z = (((x - 0x01010101) & ~x) | ((w - 0x01010101) & ~w)) & -2139062144;
      if (z === 0) {
        i = ((i | 0) + 4) | 0;
        continue;
      }
    }
    const c = text[i] | 0;
    if (c === 123) {
      if (i + 1 < e && (text[i + 1] | 0) === 123) return i;
    } else if (c === 0) {
      return -2;
    }
    i = ((i | 0) + 1) | 0;
  }
  return -1;
}

export class Tokens {
  kind: Uint8Array;
  start: Int32Array;
  end: Int32Array;
  n: number;
  constructor() {
    this.kind = new Uint8Array(256);
    this.start = new Int32Array(256);
    this.end = new Int32Array(256);
    this.n = 0;
  }
  grow(): void {
    const cap = this.kind.length * 2;
    const k = new Uint8Array(cap);
    k.set(this.kind);
    this.kind = k;
    const s = new Int32Array(cap);
    s.set(this.start);
    this.start = s;
    const e = new Int32Array(cap);
    e.set(this.end);
    this.end = e;
  }
  push(kind: number, start: number, end: number): void {
    const i = this.n;
    if (i === this.kind.length) this.grow();
    this.kind[i] = kind | 0;
    this.start[i] = start | 0;
    this.end[i] = end | 0;
    this.n = i + 1;
  }
}

class Lexer {
  text: Uint8Array;
  len: number;
  at: number;
  states: Uint8Array;
  nStates: number;
  tokens: Tokens;
  // Where the next `\0` at or behind `at` is, if that is known (-1: not).
  nextNul: number;
  dv: DataView;

  constructor() {
    this.text = new Uint8Array(0);
    this.len = 0;
    this.at = 0;
    this.states = new Uint8Array(64);
    this.nStates = 0;
    this.tokens = new Tokens();
    this.nextNul = -1;
    this.dv = new DataView(new ArrayBuffer(8));
  }

  pushState(s: number): void {
    if (this.nStates === this.states.length) {
      const n = new Uint8Array(this.states.length * 2);
      n.set(this.states);
      this.states = n;
    }
    this.states[this.nStates] = s | 0;
    this.nStates = this.nStates + 1;
  }

  popState(): void {
    if (this.nStates > 1) this.nStates = this.nStates - 1;
  }

  // A token of `len` bytes.
  token(kind: number, len: number): void {
    const at = this.at;
    this.tokens.push(kind, at, at + len);
    this.at = at + len;
  }

  // `[^\x00]` matches all of `text[at..end]`.
  isWithoutNul(end: number): boolean {
    let next = this.nextNul;
    if (next < this.at) {
      next = this.len;
      const text = this.text;
      const n = this.len | 0;
      for (let i = this.at | 0; i < n; i++) {
        if ((text[i] | 0) === 0) {
          next = i;
          break;
        }
      }
    }
    this.nextNul = next;
    return next >= end;
  }

  // `message`, where the lexer is.
  error(message: number): number {
    return noteRefusal(message, this.at);
  }

  initial(): number {
    const text = this.text;
    const at = this.at | 0;
    const n = this.len | 0;
    // The first `{{`, and a NUL before it is a syntax error: one pass over the content.
    const found = scanContent(text, this.dv, at, n);
    const nul = found === -2;
    const mustache = found;
    if (nul) return this.error(MSG_UNEXPECTED_CHARACTER);
    if (mustache < 0) {
      this.token(TK_CONTENT, n - at);
      return 0;
    }
    let end = mustache;
    let state = S_MU;
    if (mustache - at >= 2 && (text[mustache - 1] | 0) === 92 && (text[mustache - 2] | 0) === 92) {
      end = mustache - 1;
      state = S_MU;
    } else if (mustache - at >= 1 && (text[mustache - 1] | 0) === 92) {
      end = mustache - 1;
      state = S_EMU;
    }
    this.pushState(state);
    if (end > at) this.tokens.push(TK_CONTENT, at, end);
    this.at = mustache;
    return 0;
  }

  // `[^\x00]{2,}?/("{{"|"\\{{"|"\\\\{{"|<<EOF>>)`
  escapedMustache(): number {
    const text = this.text;
    const first = this.at + 2;
    let end = this.len;
    const mustache = findAscii(text, first, this.len, "{{");
    if (mustache >= 0) {
      let backslashes = 0;
      let p = mustache;
      while (backslashes < 2 && p > first && (text[p - 1] | 0) === 92) {
        backslashes = backslashes + 1;
        p = p - 1;
      }
      end = mustache - backslashes;
    }
    if (!this.isWithoutNul(end)) return this.error(MSG_UNEXPECTED_CHARACTER);
    this.popState();
    this.token(TK_CONTENT, end - this.at);
    return 0;
  }

  // `[\s\S]*?"--"{RIGHT_STRIP}?"}}"`
  comment(): number {
    const text = this.text;
    const n = this.len;
    let from = this.at;
    while (true) {
      const dashes = findAscii(text, from, n, "--");
      if (dashes < 0) return this.error(MSG_UNCLOSED_COMMENT);
      let p = dashes + 2;
      if (p < n && (text[p] | 0) === 126) p = p + 1;
      if (startsWithAt(text, p, n, "}}")) {
        this.popState();
        this.token(TK_COMMENT, p + 2 - this.at);
        return 0;
      }
      from = dashes + 1;
    }
  }

  raw(): number {
    const text = this.text;
    const n = this.len;
    const at = this.at;
    if (startsWithAt(text, at, n, "{{{{")) {
      const after = at + 4;
      if (after >= n) {
        // [] => {}
      } else if ((text[after] | 0) === 47) {
        const nameStart = after + 1;
        const len = idLen(text, nameStart, n);
        if (len > 0 && startsWithAt(text, nameStart + len, n, "}}}}")) {
          this.popState();
          const isNested = this.nStates > 0 && (this.states[this.nStates - 1] | 0) === S_RAW;
          this.token(isNested ? TK_CONTENT : TK_END_RAW_BLOCK, 5 + len + 4);
          return 0;
        }
      } else {
        this.pushState(S_RAW);
        this.token(TK_CONTENT, 4);
        return 0;
      }
    }
    const end = findAscii(text, at + 1, n, "{{{{");
    if (end < 0) return this.error(MSG_UNCLOSED_BLOCK);
    if (!this.isWithoutNul(end)) return this.error(MSG_UNEXPECTED_CHARACTER);
    this.token(TK_CONTENT, end - at);
    return 0;
  }

  // `\s*{RIGHT_STRIP}?"}}"` from `from` (an offset): the offset behind it, or -1.
  closeEnd(from: number): number {
    const text = this.text;
    const n = this.len;
    let p = from + leadingWhiteSpaceLen(text, from, n);
    if (p < n && (text[p] | 0) === 126) p = p + 1;
    return startsWithAt(text, p, n, "}}") ? p + 2 : -1;
  }

  // What starts with `{{`.
  open(): number {
    const text = this.text;
    const n = this.len;
    const rest = this.at;
    if (startsWithAt(text, rest, n, "{{{{")) {
      this.token(TK_OPEN_RAW_BLOCK, 4);
      return 0;
    }
    const at = rest + 2 < n && (text[rest + 2] | 0) === 126 ? 3 : 2;
    const p = rest + at;
    const c = p < n ? text[p] | 0 : -1;
    if (c === 62) {
      this.token(TK_OPEN_PARTIAL, at + 1);
    } else if (c === 35) {
      const d = p + 1 < n ? text[p + 1] | 0 : -1;
      if (d === 62) this.token(TK_OPEN_PARTIAL_BLOCK, at + 2);
      else if (d === 42) this.token(TK_OPEN_BLOCK, at + 2);
      else this.token(TK_OPEN_BLOCK, at + 1);
    } else if (c === 47) {
      this.token(TK_OPEN_END_BLOCK, at + 1);
    } else if (c === 94) {
      const e = this.closeEnd(p + 1);
      if (e >= 0) {
        this.popState();
        this.token(TK_INVERSE, e - rest);
      } else {
        this.token(TK_OPEN_INVERSE, at + 1);
      }
    } else if (c === 123) {
      this.token(TK_OPEN_UNESCAPED, at + 1);
    } else if (c === 38) {
      this.token(TK_OPEN, at + 1);
    } else if (c === 33 && startsWithAt(text, p, n, "!--")) {
      this.popState();
      this.pushState(S_COM);
    } else if (c === 33) {
      const end = findAscii(text, p + 1, n, "}}");
      if (end < 0) return this.error(MSG_UNCLOSED_COMMENT);
      this.popState();
      this.token(TK_COMMENT, end + 2 - rest);
    } else if (c === 42) {
      this.token(TK_OPEN, at + 1);
    } else {
      const keyword = p + leadingWhiteSpaceLen(text, p, n);
      const after = keyword + 4;
      if (!startsWithAt(text, keyword, n, "else")) {
        this.token(TK_OPEN, at);
      } else {
        const e = this.closeEnd(after);
        if (e >= 0) {
          this.popState();
          this.token(TK_INVERSE, e - rest);
        } else if (after < n && isAlnumOrUnderscore(text[after] | 0)) {
          this.token(TK_OPEN, at);
        } else {
          this.token(TK_OPEN_INVERSE_CHAIN, after - rest);
        }
      }
    }
    return 0;
  }

  // `word` (printable ASCII) at `at`, followed by a `LITERAL_LOOKAHEAD`.
  followedBy(word: string): boolean {
    const at = this.at;
    return startsWithAt(this.text, at, this.len, word) && isLiteralLookahead(this.text, at + word.length, this.len);
  }

  // The tokens of a mustache, as long as the state is `Mu`. The common ones are here, the others are `mustacheOne`.
  mustache(): number {
    const text = this.text;
    const n = this.len | 0;
    const table = ID_ASCII;
    const tokens = this.tokens;
    let at = this.at | 0;
    while (at < n) {
      const c = text[at] | 0;
      if ((table[c] | 0) !== 0) {
        // An `ID` that is not a keyword, a number or `as`: all of the bytes that can be in it, and then a `LOOKAHEAD`.
        let p = (at + 1) | 0;
        while (p < n && (table[text[p] | 0] | 0) !== 0) p = ((p | 0) + 1) | 0;
        const len = (p - at) | 0;
        const d = p < n ? text[p] | 0 : -1;
        if (
          (d === 125 || d === 32 || (d >= 9 && d <= 13) || d === 61 || d === 126 || d === 47 || d === 46 || d === 41 || d === 93 || d === 124) &&
          c !== 45 &&
          (c < 48 || c > 57) &&
          !(len === 2 && c === 97) &&
          !((len === 4 || len === 5 || len === 9) && (c === 116 || c === 102 || c === 117 || c === 110))
        ) {
          tokens.push(TK_ID, at, p);
          at = p;
          continue;
        }
      } else if (c === 32 || (c >= 9 && c <= 13)) {
        at = ((at | 0) + 1) | 0;
        continue;
      } else if (c === 125 && at + 1 < n && (text[at + 1] | 0) === 125 && (at + 2 >= n || (text[at + 2] | 0) !== 125)) {
        tokens.push(TK_CLOSE, at, at + 2);
        this.at = at + 2;
        this.popState();
        return 0;
      } else if (c === 40) {
        tokens.push(TK_OPEN_SEXPR, at, at + 1);
        at = ((at | 0) + 1) | 0;
        continue;
      } else if (c === 41) {
        tokens.push(TK_CLOSE_SEXPR, at, at + 1);
        at = ((at | 0) + 1) | 0;
        continue;
      } else if (c === 61) {
        tokens.push(TK_EQUALS, at, at + 1);
        at = ((at | 0) + 1) | 0;
        continue;
      }
      this.at = at;
      const r = this.mustacheOne();
      if (r < 0) return r;
      at = this.at | 0;
      if (this.nStates === 0 || (this.states[this.nStates - 1] | 0) !== S_MU) return 0;
    }
    this.at = at;
    return 0;
  }

  // One token (or a run of white space) of a mustache.
  mustacheOne(): number {
    const text = this.text;
    const n = this.len | 0;
    const at = this.at | 0;
    if (at >= n) return this.error(MSG_UNEXPECTED_END);
    const c = text[at] | 0;
    // What can be in an `ID` and starts no other token: the common case.
    if ((ID_ASCII[c] | 0) !== 0) return this.wordOrId(c, at, n);
    if (c === 32 || (c >= 9 && c <= 13)) {
      // White space
      let p = (at + 1) | 0;
      while (p < n) {
        const d = text[p] | 0;
        if (d === 32 || (d >= 9 && d <= 13)) {
          p = ((p | 0) + 1) | 0;
        } else if (d >= 0x80) {
          const l = jsWhitespaceLen(text, p, n);
          if (l === 0) break;
          p = p + l;
        } else {
          break;
        }
      }
      this.at = p;
      return 0;
    }
    if (c === 40) {
      this.token(TK_OPEN_SEXPR, 1);
    } else if (c === 41) {
      this.token(TK_CLOSE_SEXPR, 1);
    } else if (c === 91) {
      const end = delimitedEnd(text, at, n, 93);
      if (end < 0) return this.error(MSG_UNCLOSED_BRACKET);
      this.token(TK_ID, end - at);
    } else if (c === 123 && startsWithAt(text, at, n, "{{")) {
      return this.open();
    } else if (c === 125 && startsWithAt(text, at, n, "}}}}")) {
      this.popState();
      this.pushState(S_RAW);
      this.token(TK_CLOSE_RAW_BLOCK, 4);
    } else if (c === 125 && (startsWithAt(text, at, n, "}}}") || startsWithAt(text, at, n, "}~}}"))) {
      this.popState();
      this.token(TK_CLOSE_UNESCAPED, (text[at + 1] | 0) === 126 ? 4 : 3);
    } else if (c === 125 && startsWithAt(text, at, n, "}}")) {
      this.popState();
      this.token(TK_CLOSE, 2);
    } else if (c === 126 && startsWithAt(text, at, n, "~}}")) {
      this.popState();
      this.token(TK_CLOSE, 3);
    } else if (c === 61) {
      this.token(TK_EQUALS, 1);
    } else if (c === 46 && startsWithAt(text, at, n, "..")) {
      this.token(TK_ID, 2);
    } else if (c === 46 && isLookahead(text, at + 1, n)) {
      this.token(TK_ID, 1);
    } else if (c === 46 && startsWithAt(text, at, n, ".#")) {
      this.token(TK_PRIVATE_SEP, 2);
    } else if (c === 46 || c === 47) {
      this.token(TK_SEP, 1);
    } else if (c === 34 || c === 39) {
      const end = delimitedEnd(text, at, n, c);
      if (end < 0) return this.error(MSG_UNCLOSED_STRING);
      this.token(TK_STRING, end - at);
    } else if (c === 64) {
      this.token(TK_DATA, 1);
    } else if (c === 124) {
      this.token(TK_CLOSE_BLOCK_PARAMS, 1);
    } else if (c >= 0x80 && jsWhitespaceLen(text, at, n) > 0) {
      this.at = at + leadingWhiteSpaceLen(text, at, n);
    } else {
      return this.wordOrId(c, at, n);
    }
    return 0;
  }

  // A keyword, a number, `as |`, or an `ID`, at `text[at]` (`c`).
  wordOrId(c: number, at: number, n: number): number {
    const text = this.text;
    if (c === 116 && this.followedBy("true")) {
      this.token(TK_BOOLEAN, 4);
      return 0;
    }
    if (c === 102 && this.followedBy("false")) {
      this.token(TK_BOOLEAN, 5);
      return 0;
    }
    if (c === 117 && this.followedBy("undefined")) {
      this.token(TK_UNDEFINED, 9);
      return 0;
    }
    if (c === 110 && this.followedBy("null")) {
      this.token(TK_NULL, 4);
      return 0;
    }
    if ((c >= 48 && c <= 57) || c === 45) {
      const num = numberLen(text, at, n);
      if (num >= 0) {
        this.token(TK_NUMBER, num);
        return 0;
      }
    }
    if (c === 97 && at + 1 < n && (text[at + 1] | 0) === 115) {
      const afterAs = at + 2;
      const blanks = leadingWhiteSpaceLen(text, afterAs, n);
      if (blanks > 0 && afterAs + blanks < n && (text[afterAs + blanks] | 0) === 124) {
        this.token(TK_OPEN_BLOCK_PARAMS, 2 + blanks + 1);
        return 0;
      }
    }
    const len = idLen(text, at, n);
    if (len === 0 || !isLookahead(text, at + len, n)) {
      return noteRefusal(at + len === n ? MSG_UNEXPECTED_END : MSG_UNEXPECTED_CHARACTER, at + len);
    }
    this.token(TK_ID, len);
    return 0;
  }
}

function isAlnumOrUnderscore(b: number): boolean {
  return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95;
}

const lexer = new Lexer();

// Writes the tokens of `text` to `tokens`, which is empty. The last is `Eof`. 0, or -1 (a syntax error is noted).
export function lex(text: Uint8Array, tokens: Tokens): number {
  const lx = lexer;
  lx.text = text;
  lx.dv = new DataView(text.buffer, text.byteOffset, text.length);
  lx.len = text.length;
  lx.at = 0;
  lx.nStates = 0;
  lx.pushState(S_INITIAL);
  lx.tokens = tokens;
  lx.nextNul = -1;
  const n = text.length;
  while (true) {
    const state = lx.nStates > 0 ? lx.states[lx.nStates - 1] | 0 : S_INITIAL;
    if (lx.at >= n) {
      // Only there is the end of the text something that the grammar can go on with.
      if (state !== S_INITIAL) return lx.error(MSG_UNEXPECTED_END);
      lx.token(TK_EOF, 0);
      return 0;
    }
    let r = 0;
    if (state === S_MU) r = lx.mustache();
    else if (state === S_INITIAL) r = lx.initial();
    else if (state === S_EMU) r = lx.escapedMustache();
    else if (state === S_COM) r = lx.comment();
    else r = lx.raw();
    if (r < 0) return r;
  }
}
