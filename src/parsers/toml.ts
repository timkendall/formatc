// Port of vendor/bun/src/parsers/toml.rs, as the formatter uses it: `TOML::tokens`.
//
// The tokens of a document as ranges of its text, and the syntax error (Bun's own words, and the byte) of a text that
// is not TOML. What tables and keys mean is not looked at (a key can be there twice), and an integer can have any
// size, as in Rust (`keeps_text`); the half of the Rust file that builds values (`Parser`) is not here.
//
// No recursion (the Rust tokenizer keeps the open arrays and inline tables in a vector; here in `openStack`). Storage
// is per thread (module state). A syntax error is a return value.

// ---------------------------------------------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------------------------------------------

// Rust `TokenKind` (same order)
export const TT_TABLE_OPEN = 0; // `[` of `[a]`
export const TT_TABLE_CLOSE = 1; // `]` of `[a]`
export const TT_ARRAY_TABLE_OPEN = 2; // `[[` of `[[a]]`
export const TT_ARRAY_TABLE_CLOSE = 3; // `]]` of `[[a]]`
export const TT_KEY = 4; // one segment of a key, with its quotes
export const TT_DOT = 5;
export const TT_EQUALS = 6;
export const TT_SCALAR = 7; // a string, a number, a date, a time or a boolean
export const TT_ARRAY_OPEN = 8;
export const TT_ARRAY_CLOSE = 9;
export const TT_INLINE_OPEN = 10;
export const TT_INLINE_CLOSE = 11;
export const TT_COMMA = 12;

export function tomlTokenKindName(k: number): string {
  switch (k) {
    case TT_TABLE_OPEN: return "TableOpen";
    case TT_TABLE_CLOSE: return "TableClose";
    case TT_ARRAY_TABLE_OPEN: return "ArrayTableOpen";
    case TT_ARRAY_TABLE_CLOSE: return "ArrayTableClose";
    case TT_KEY: return "Key";
    case TT_DOT: return "Dot";
    case TT_EQUALS: return "Equals";
    case TT_SCALAR: return "Scalar";
    case TT_ARRAY_OPEN: return "ArrayOpen";
    case TT_ARRAY_CLOSE: return "ArrayClose";
    case TT_INLINE_OPEN: return "InlineOpen";
    case TT_INLINE_CLOSE: return "InlineClose";
    case TT_COMMA: return "Comma";
    default: return "?";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------------------------

// is_bare_key_char: [A-Za-z0-9_-]
const BARE = new Uint8Array(256);
for (let c = 0x30; c <= 0x39; c++) BARE[c] = 1;
for (let c = 0x41; c <= 0x5a; c++) BARE[c] = 1;
for (let c = 0x61; c <= 0x7a; c++) BARE[c] = 1;
BARE[0x2d] = 1;
BARE[0x5f] = 1;

const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------

let src: Uint8Array = EMPTY;
let n = 0;
let pos = 0;

// The error
let errMessage = "";
let errPosValue = 0;

// The tokens
let tokKind = new Uint8Array(1024);
let tokStart = new Int32Array(1024);
let tokEnd = new Int32Array(1024);
let tokCount = 0;

// What closes the arrays and inline tables that are open (TT_ARRAY_CLOSE / TT_INLINE_CLOSE).
let openStack = new Uint8Array(256);
let openLen = 0;

// Results of the scan functions that return more than one thing
let rKeyPos = 0; // KeySeg.pos
let rValuePos = 0; // ValueToken.pos
let rValueKind = 0; // VK_*

// Rust `ValueData`: what a value token is
const VK_STRING = 0;
const VK_NUMBER = 1;
const VK_DATETIME = 2;
const VK_BOOLEAN = 3;
const VK_ARRAY_OPEN = 4;
const VK_INLINE_OPEN = 5;

// Rust `LineStart`
const LS_EOF = 0;
const LS_TABLE_OPEN = 1;
const LS_KEY = 2;

// results of scanLineStart
let rLineAot = false;
let rLinePos = 0;

// Rust `InlineKey`, `ArrayItem`
const IK_KEY = 0;
const IK_CLOSE = 1;
const IK_EOF = 2;
const AI_VALUE = 0;
const AI_CLOSE = 1;
const AI_EOF = 2;

// ---------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------

function fail(at: number, msg: string): number {
  errMessage = msg;
  errPosValue = at;
  return -1;
}

function hex2(c: number): string {
  const h = c.toString(16).toUpperCase();
  return h.length < 2 ? "0" + h : h;
}

// `{what} '{c}'`, `{what} (0x..)`, `{what} end of file`
function failChar(at: number, what: string): number {
  if (at >= n) return fail(at, what + " end of file");
  const c = src[at] | 0;
  if (c > 0x20 && c < 0x7f) return fail(at, what + " '" + String.fromCharCode(c) + "'");
  return fail(at, what + " (0x" + hex2(c) + ")");
}

const BARE_CR = "Bare carriage return is not allowed; use \\r\\n or \\n";
const UNDERSCORE_IN_NUMBER = "Underscores in numbers must be surrounded by digits";

function failUnquotedString(at: number): number {
  let end = at;
  while (end < n && (BARE[src[end] | 0] === 1) && end - at < 64) end = end + 1;
  if (end === at) return fail(at, "Strings must be quoted");
  let word = "";
  for (let i = at; i < end; i++) word += String.fromCharCode(src[i] | 0);
  return fail(at, 'Strings must be quoted: "' + word + '"');
}

// ---------------------------------------------------------------------------------------------------------------
// Growable arrays
// ---------------------------------------------------------------------------------------------------------------

function growTokens(): void {
  const cap = tokKind.length * 2;
  const k = new Uint8Array(cap);
  k.set(tokKind);
  tokKind = k;
  const s = new Int32Array(cap);
  s.set(tokStart);
  tokStart = s;
  const e = new Int32Array(cap);
  e.set(tokEnd);
  tokEnd = e;
}

function growOpen(): void {
  const c = new Uint8Array(openStack.length * 2);
  c.set(openStack);
  openStack = c;
}

// A token from `start` to the cursor.
function pushToken(kind: number, start: number): void {
  if (tokCount === tokKind.length) growTokens();
  tokKind[tokCount] = kind | 0;
  tokStart[tokCount] = start | 0;
  tokEnd[tokCount] = pos | 0;
  tokCount = tokCount + 1;
}

// A token of `len` bytes that ends at the cursor.
function pushLast(kind: number, len: number): void {
  pushToken(kind, pos - len);
}

// ---------------------------------------------------------------------------------------------------------------
// Byte cursor
// ---------------------------------------------------------------------------------------------------------------

function peek(): number {
  return pos < n ? src[pos] | 0 : 0;
}

function peekAt(p: number): number {
  return p < n ? src[p] | 0 : 0;
}

function atEof(): boolean {
  return pos >= n;
}

function skipWs(): void {
  let p = pos;
  const e = n;
  const s = src;
  while (p < e) {
    const c = s[p] | 0;
    if (c !== 0x20 && c !== 0x09) break;
    p = p + 1;
  }
  pos = p;
}

// Consumes a newline (LF or CRLF). 0, or -1 for a bare CR or something else.
function expectNewline(): number {
  const c = peek();
  if (c === 0x0a) {
    pos = pos + 1;
    return 0;
  }
  if (c === 0x0d) {
    if (peekAt(pos + 1) === 0x0a) {
      pos = pos + 2;
      return 0;
    }
    return fail(pos, BARE_CR);
  }
  return failChar(pos, "Expected a newline but found");
}

// Scans a `# comment` up to (not including) the line terminator, rejecting control characters.
function skipComment(): number {
  pos = pos + 1;
  let p = pos;
  const e = n;
  const s = src;
  while (p < e) {
    const c = s[p] | 0;
    if (c === 0x0a) break;
    if (c === 0x0d) {
      if (peekAt(p + 1) === 0x0a) break;
      pos = p;
      return fail(p, BARE_CR);
    }
    if (c === 0x09) {
      p = p + 1;
      continue;
    }
    if (c < 0x20 || c === 0x7f) {
      pos = p;
      return failChar(p, "Control character is not allowed in a comment:");
    }
    p = p + 1;
  }
  pos = p;
  return 0;
}

// Skips white space, comments, and newlines (`ws-comment-newline`).
function skipWsCommentNewline(): number {
  for (;;) {
    const c = peek();
    if (c === 0x20 || c === 0x09) {
      pos = pos + 1;
    } else if (c === 0x0a || c === 0x0d) {
      if (expectNewline() < 0) return -1;
    } else if (c === 0x23) {
      if (skipComment() < 0) return -1;
    } else {
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Document setup
// ---------------------------------------------------------------------------------------------------------------

// Whole-document validation and BOM handling, before any scanning. A TOML document must be valid UTF-8 as a whole;
// the error is at the first byte of the first bad sequence (simdutf).
function initDocument(): number {
  const bad = invalidUtf8At();
  if (bad >= 0) return fail(bad, "Invalid UTF-8 byte sequence");
  // Skip a leading byte-order mark.
  if (n >= 3 && (src[0] | 0) === 0xef && (src[1] | 0) === 0xbb && (src[2] | 0) === 0xbf) pos = 3;
  return 0;
}

// The index of the first byte of the first bad UTF-8 sequence of src[0, n), -1 if it is all UTF-8.
function invalidUtf8At(): number {
  const s = src;
  const e = n;
  let i = 0;
  while (i < e) {
    // ASCII in runs
    while (i < e && (s[i] | 0) < 0x80) i = i + 1;
    if (i >= e) return -1;
    const b0 = s[i] | 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      if (i + 1 >= e || ((s[i + 1] | 0) & 0xc0) !== 0x80) return i;
      i = i + 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      if (i + 2 >= e) return i;
      const b1 = s[i + 1] | 0;
      const b2 = s[i + 2] | 0;
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return i;
      if (b0 === 0xe0 && b1 < 0xa0) return i; // overlong
      if (b0 === 0xed && b1 > 0x9f) return i; // surrogate
      i = i + 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      if (i + 3 >= e) return i;
      const b1 = s[i + 1] | 0;
      const b2 = s[i + 2] | 0;
      const b3 = s[i + 3] | 0;
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return i;
      if (b0 === 0xf0 && b1 < 0x90) return i; // overlong
      if (b0 === 0xf4 && b1 > 0x8f) return i; // too large
      i = i + 4;
    } else {
      return i; // a continuation byte alone, 0xc0, 0xc1, 0xf5..
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------
// Scan modes
// ---------------------------------------------------------------------------------------------------------------

// What may begin a top-level expression: `ws-comment-newline ( keyval / table )`. Returns LS_*, or -1.
function scanLineStart(): number {
  if (skipWsCommentNewline() < 0) return -1;
  if (atEof()) return LS_EOF;
  if (peek() === 0x5b) {
    rLinePos = pos;
    pos = pos + 1;
    // `array-table-open = %x5B.5B`: the second bracket is adjacent.
    rLineAot = peek() === 0x5b;
    if (rLineAot) pos = pos + 1;
    return LS_TABLE_OPEN;
  }
  if (scanKeySegment() < 0) return -1;
  return LS_KEY;
}

// One key segment (bare, basic-quoted, or literal-quoted). Sets rKeyPos.
function scanKeySegment(): number {
  const start = pos;
  rKeyPos = start;
  const c = peek();
  if (c === 0x22) return scanBasicString(false);
  if (c === 0x27) return scanLiteralString(false);
  if (BARE[c] === 1 && pos < n) {
    let p = pos;
    const e = n;
    const s = src;
    while (p < e && BARE[s[p] | 0] === 1) p = p + 1;
    pos = p;
    return 0;
  }
  return failChar(start, "Expected a key but found");
}

// The segment after a dot or a table-open bracket (`dot-sep = ws "." ws` and `std-table-open = "[" ws`: spaces/tabs
// only, then a key).
function scanKeyAfterSep(): number {
  skipWs();
  return scanKeySegment();
}

// After a key segment in a `key = value` path: `ws` then `.` or `=`. Returns 1 (dot), 2 (equals), or -1.
function scanKeyvalSep(): number {
  skipWs();
  const c = peek();
  if (c === 0x2e) {
    pos = pos + 1;
    return 1;
  }
  if (c === 0x3d) {
    pos = pos + 1;
    return 2;
  }
  return failChar(pos, "Expected '=' after a key but found");
}

// After a key segment in a header: `ws` then `.` or the closing bracket(s). `]]` must be adjacent. Returns 1 (dot),
// 2 (close), or -1.
function scanHeaderSep(aot: boolean): number {
  skipWs();
  const c = peek();
  if (c === 0x2e) {
    pos = pos + 1;
    return 1;
  }
  if (c === 0x5d) {
    pos = pos + 1;
    if (aot) {
      if (peek() !== 0x5d) {
        return failChar(pos, "Expected ']]' to close an array-of-tables header but found");
      }
      pos = pos + 1;
    }
    return 2;
  }
  if (aot) return failChar(pos, "Expected ']]' to close an array-of-tables header but found");
  return failChar(pos, "Expected ']' to close a table header but found");
}

// What begins an inline-table entry: `ws-comment-newline` then a key or the closing brace (TOML 1.1 allows
// multi-line inline tables). Returns IK_*, or -1. IK_EOF: rKeyPos is where.
function scanInlineKey(): number {
  if (skipWsCommentNewline() < 0) return -1;
  if (peek() === 0x7d) {
    pos = pos + 1;
    return IK_CLOSE;
  }
  if (atEof()) {
    rKeyPos = pos;
    return IK_EOF;
  }
  if (scanKeySegment() < 0) return -1;
  return IK_KEY;
}

// The value after `=`: `keyval-sep = ws %x3D ws` - spaces/tabs only, never a newline or comment, then exactly one
// value.
function scanValueRequired(): number {
  skipWs();
  const c = peek();
  if (c === 0x0a || c === 0x0d) return fail(pos, "Missing value after '='; values must be on the same line");
  if (c === 0 && atEof()) return fail(pos, "Missing value after '='");
  return scanValueToken();
}

// An array element position: `ws-comment-newline` then a value, the closing bracket (empty array or trailing comma),
// or EOF. Returns AI_*, or -1. AI_EOF: rValuePos is where.
function scanArrayItem(): number {
  if (skipWsCommentNewline() < 0) return -1;
  if (peek() === 0x5d) {
    pos = pos + 1;
    return AI_CLOSE;
  }
  if (atEof()) {
    rValuePos = pos;
    return AI_EOF;
  }
  if (scanValueToken() < 0) return -1;
  return AI_VALUE;
}

// After a list element: `ws-comment-newline` then `,` or the closer. Returns 1 (comma), 2 (close), or -1.
function scanListSep(close: number, what: string): number {
  if (skipWsCommentNewline() < 0) return -1;
  const c = peek();
  if (c === 0x2c) {
    pos = pos + 1;
    return 1;
  }
  if (c === close) {
    pos = pos + 1;
    return 2;
  }
  return failChar(pos, what);
}

// After an expression: optional white space, optional comment, then a newline or EOF.
function scanLineEnd(after: string): number {
  skipWs();
  if (peek() === 0x23) {
    if (skipComment() < 0) return -1;
  }
  if (atEof()) return 0;
  const c = peek();
  if (c === 0x0a || c === 0x0d) return expectNewline();
  return fail(pos, "Expected a newline or end of file after " + after);
}

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------

// One value token at the cursor. Sets rValuePos, rValueKind.
function scanValueToken(): number {
  const start = pos;
  rValuePos = start;
  const c = peek();
  if (c === 0x22) {
    rValueKind = VK_STRING;
    if (startsWith3(0x22)) return scanBasicString(true);
    return scanBasicString(false);
  }
  if (c === 0x27) {
    rValueKind = VK_STRING;
    if (startsWith3(0x27)) return scanLiteralString(true);
    return scanLiteralString(false);
  }
  if (c === 0x74) {
    rValueKind = VK_BOOLEAN;
    return expectKeyword(0x74, 0x72, 0x75, 0x65, 4);
  }
  if (c === 0x66) {
    rValueKind = VK_BOOLEAN;
    return expectKeyword(0x66, 0x61, 0x6c, 0x73, 5);
  }
  if (c === 0x5b) {
    pos = pos + 1;
    rValueKind = VK_ARRAY_OPEN;
    return 0;
  }
  if (c === 0x7b) {
    pos = pos + 1;
    rValueKind = VK_INLINE_OPEN;
    return 0;
  }
  if (c === 0x69 || c === 0x6e || c === 0x2b || c === 0x2d || (c >= 0x30 && c <= 0x39)) {
    return scanNumberOrDatetime();
  }
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return failUnquotedString(start);
  return failChar(start, "Expected a value but found");
}

// src[pos..] starts with three of `q`
function startsWith3(q: number): boolean {
  return peekAt(pos) === q && peekAt(pos + 1) === q && peekAt(pos + 2) === q;
}

// `true` / `false`: the word must be followed by a value terminator, not more bare characters. `a`..`d`: the first
// four bytes (the fifth, `e`, of `false` is checked as the last).
function expectKeyword(a: number, b: number, c: number, d: number, len: number): number {
  const start = pos;
  let ok = peekAt(pos) === a && peekAt(pos + 1) === b && peekAt(pos + 2) === c && peekAt(pos + 3) === d;
  if (ok && len === 5) ok = peekAt(pos + 4) === 0x65;
  if (ok && !(pos + len < n && BARE[src[pos + len] | 0] === 1)) {
    pos = pos + len;
    return 0;
  }
  return failUnquotedString(start);
}

function isDigitAt(p: number): boolean {
  const c = peekAt(p);
  return c >= 0x30 && c <= 0x39;
}

function scanNumberOrDatetime(): number {
  // Date/times start with an unsigned digit run: `DDDD-` or `DD:`.
  if (isDigitAt(pos)) {
    const d1 = digitRunLen(pos);
    if (d1 === 4 && peekAt(pos + 4) === 0x2d) {
      if (scanDatetimeFromDate() < 0) return -1;
      if (expectValueTerminator() < 0) return -1;
      rValueKind = VK_DATETIME;
      return 0;
    }
    if (d1 === 2 && peekAt(pos + 2) === 0x3a) {
      if (scanTimeDigits() < 0) return -1;
      if (expectValueTerminator() < 0) return -1;
      rValueKind = VK_DATETIME;
      return 0;
    }
  }
  return scanNumber();
}

function digitRunLen(start: number): number {
  let i = start;
  while (isDigitAt(i)) i = i + 1;
  return i - start;
}

// Exactly `n` ASCII digits at the cursor; returns their value, or -1 (error set).
function readDigits(count: number, what: string): number {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const c = peek();
    if (c < 0x30 || c > 0x39) return fail(pos, what);
    value = value * 10 + (c - 0x30);
    pos = pos + 1;
  }
  return value;
}

// `YYYY-MM-DD` and everything that may follow it (time, offset).
function scanDatetimeFromDate(): number {
  const start = pos;

  const year = readDigits(4, "Invalid date: expected a 4-digit year");
  if (year < 0) return -1;
  if (peek() !== 0x2d) return fail(pos, "Invalid date: expected '-' after the year");
  pos = pos + 1;
  const month = readDigits(2, "Invalid date: expected a 2-digit month");
  if (month < 0) return -1;
  if (peek() !== 0x2d) return fail(pos, "Invalid date: expected '-' after the month");
  pos = pos + 1;
  const dayPos = pos;
  const day = readDigits(2, "Invalid date: expected a 2-digit day");
  if (day < 0) return -1;

  if (month < 1 || month > 12) return fail(start, "Invalid date: month must be between 01 and 12");
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  let maxDay: number;
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12: maxDay = 31; break;
    case 4: case 6: case 9: case 11: maxDay = 30; break;
    default: maxDay = leap ? 29 : 28;
  }
  if (day < 1 || day > maxDay) return fail(dayPos, "Invalid date: day is out of range for the month");

  // Optional time part: 'T'/'t', or a space when a time clearly follows.
  let hasTime = false;
  const c = peek();
  if (c === 0x54 || c === 0x74) {
    pos = pos + 1;
    hasTime = true;
  } else if (c === 0x20 && isDigitAt(pos + 1) && isDigitAt(pos + 2) && peekAt(pos + 3) === 0x3a) {
    pos = pos + 1;
    hasTime = true;
  }

  if (!hasTime) return 0;

  if (scanTimeDigits() < 0) return -1;
  // Optional offset.
  const o = peek();
  if (o === 0x5a || o === 0x7a) {
    pos = pos + 1;
  } else if (o === 0x2b || o === 0x2d) {
    pos = pos + 1;
    const hour = readDigits(2, "Invalid date-time offset: expected 2-digit hours");
    if (hour < 0) return -1;
    if (peek() !== 0x3a) return fail(pos, "Invalid date-time offset: expected ':' between hours and minutes");
    pos = pos + 1;
    const minute = readDigits(2, "Invalid date-time offset: expected 2-digit minutes");
    if (minute < 0) return -1;
    if (hour > 23) return fail(start, "Invalid date-time offset: hours must be between 00 and 23");
    if (minute > 59) return fail(start, "Invalid date-time offset: minutes must be between 00 and 59");
  }
  return 0;
}

// `HH:MM[:SS[.frac]]` - seconds are optional in TOML 1.1.
function scanTimeDigits(): number {
  const start = pos;
  const hour = readDigits(2, "Invalid time: expected 2-digit hours");
  if (hour < 0) return -1;
  if (peek() !== 0x3a) return fail(pos, "Invalid time: expected ':' after hours");
  pos = pos + 1;
  const minute = readDigits(2, "Invalid time: expected 2-digit minutes");
  if (minute < 0) return -1;
  if (hour > 23) return fail(start, "Invalid time: hours must be between 00 and 23");
  if (minute > 59) return fail(start, "Invalid time: minutes must be between 00 and 59");
  // Seconds are optional in TOML 1.1.
  if (peek() === 0x3a) {
    pos = pos + 1;
    const secPos = pos;
    const second = readDigits(2, "Invalid time: expected 2-digit seconds");
    if (second < 0) return -1;
    // 60 covers leap seconds, per RFC 3339.
    if (second > 60) return fail(secPos, "Invalid time: seconds must be between 00 and 60");
    if (peek() === 0x2e) {
      pos = pos + 1;
      if (!isDigitAt(pos)) return fail(pos, "Invalid time: expected at least one digit of fractional seconds");
      while (isDigitAt(pos)) pos = pos + 1;
    }
  }
  return 0;
}

// Validates an `_` between digits and consumes it. `radix`: 10, 16, 8 or 2.
function checkUnderscore(radix: number): number {
  if (!isDigitOf(peekAt(pos - 1), radix) || !isDigitOf(peekAt(pos + 1), radix)) return fail(pos, UNDERSCORE_IN_NUMBER);
  pos = pos + 1;
  return 0;
}

function isDigitOf(c: number, radix: number): boolean {
  switch (radix) {
    case 16: return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
    case 8: return c >= 0x30 && c <= 0x37;
    case 2: return c === 0x30 || c === 0x31;
    default: return c >= 0x30 && c <= 0x39;
  }
}

// Scans `digit (digit | _)*` with underscore placement validation.
function scanDecimalDigits(): number {
  for (;;) {
    const c = peek();
    if (c >= 0x30 && c <= 0x39) pos = pos + 1;
    else if (c === 0x5f) {
      if (checkUnderscore(10) < 0) return -1;
    } else return 0;
  }
}

function scanNumber(): number {
  const start = pos;

  let negative = false;
  const sign = peek();
  if (sign === 0x2d) {
    pos = pos + 1;
    negative = true;
  } else if (sign === 0x2b) {
    pos = pos + 1;
  }

  // inf / nan, optionally signed. A longer bare word that merely starts with them (`infinity`, `nanoseconds`) is an
  // unquoted string.
  if (peekAt(pos) === 0x69 && peekAt(pos + 1) === 0x6e && peekAt(pos + 2) === 0x66 && BARE[peekAt(pos + 3)] !== 1) {
    pos = pos + 3;
    if (expectValueTerminator() < 0) return -1;
    rValueKind = VK_NUMBER;
    return 0;
  }
  if (peekAt(pos) === 0x6e && peekAt(pos + 1) === 0x61 && peekAt(pos + 2) === 0x6e && BARE[peekAt(pos + 3)] !== 1) {
    pos = pos + 3;
    if (expectValueTerminator() < 0) return -1;
    rValueKind = VK_NUMBER;
    return 0;
  }

  // Radix-prefixed integers (unsigned only).
  if (peek() === 0x30) {
    const r = peekAt(pos + 1);
    if (r === 0x78 || r === 0x6f || r === 0x62) {
      if (negative || (src[start] | 0) === 0x2b) {
        return fail(start, "A sign is not allowed on hexadecimal, octal, or binary integers");
      }
      return scanRadixInteger();
    }
  }

  if (!isDigitAt(pos)) {
    // An unsigned bare word (`linker = isolated`) is an unquoted string; anything after a sign is a malformed number.
    const c = peek();
    if (start === pos && ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) return failUnquotedString(start);
    return failChar(pos, "Expected a number but found");
  }

  // Integer part
  const intStart = pos;
  let digits = 0;
  for (;;) {
    const c = peek();
    if (c >= 0x30 && c <= 0x39) {
      digits = digits + 1;
      pos = pos + 1;
    } else if (c === 0x5f) {
      if (checkUnderscore(10) < 0) return -1;
    } else {
      break;
    }
  }
  if (digits > 1 && (src[intStart] | 0) === 0x30) return fail(intStart, "Leading zeros are not allowed in numbers");

  // Fractional part.
  if (peek() === 0x2e) {
    pos = pos + 1;
    if (!isDigitAt(pos)) return fail(pos, "A decimal point must be followed by at least one digit");
    if (scanDecimalDigits() < 0) return -1;
  }

  // Exponent part.
  const e = peek();
  if (e === 0x65 || e === 0x45) {
    pos = pos + 1;
    const s = peek();
    if (s === 0x2b || s === 0x2d) pos = pos + 1;
    if (!isDigitAt(pos)) return fail(pos, "An exponent must contain at least one digit");
    if (scanDecimalDigits() < 0) return -1;
  }

  if (expectValueTerminator() < 0) return -1;
  // `keeps_text`: an integer need not fit anything.
  rValueKind = VK_NUMBER;
  return 0;
}

function scanRadixInteger(): number {
  const radixChar = peekAt(pos + 1);
  const radix = radixChar === 0x78 ? 16 : radixChar === 0x6f ? 8 : 2;
  pos = pos + 2;

  if (!isDigitOf(peek(), radix)) return fail(pos, "Expected at least one digit after the radix prefix");

  for (;;) {
    const c = peek();
    if (isDigitOf(c, radix)) {
      pos = pos + 1;
    } else if (c === 0x5f) {
      if (checkUnderscore(radix) < 0) return -1;
    } else if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
      return failChar(pos, "Invalid digit in number:");
    } else {
      break;
    }
  }

  if (expectValueTerminator() < 0) return -1;
  rValueKind = VK_NUMBER;
  return 0;
}

// A number or keyword value must be followed by something that can legitimately come after a value.
function expectValueTerminator(): number {
  const c = peek();
  if (c === 0 && atEof()) return 0;
  if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x2c || c === 0x5d || c === 0x7d || c === 0x23) return 0;
  return failChar(pos, "Unexpected character after a value:");
}

// ---------------------------------------------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------------------------------------------

// Counts the quote run at the cursor. Runs of 3-5 close a multi-line string (the final 3 are the delimiter, up to 2
// belong to the content); longer runs are an error. Returns the run, or -1.
function quoteRun(quote: number): number {
  let run = 0;
  while (peekAt(pos + run) === quote) run = run + 1;
  if (run > 5) return fail(pos, "Too many quotes at the end of a multi-line string");
  return run;
}

// Rust `scan_basic_string`, for the syntax: the text is not decoded.
function scanBasicString(multiline: boolean): number {
  const openPos = pos;
  pos = pos + (multiline ? 3 : 1);

  if (multiline) {
    // A newline immediately after the opening delimiter is trimmed.
    const c = peek();
    if (c === 0x0a) pos = pos + 1;
    else if (c === 0x0d && peekAt(pos + 1) === 0x0a) pos = pos + 2;
  }

  for (;;) {
    if (atEof()) return fail(openPos, "Unterminated string");
    const c = peek();
    if (c === 0x22) {
      if (!multiline) {
        pos = pos + 1;
        return 0;
      }
      const run = quoteRun(0x22);
      if (run < 0) return -1;
      if (run >= 3) {
        pos = pos + run;
        return 0;
      }
      pos = pos + run;
    } else if (c === 0x5c) {
      // Line-ending backslash (multi-line only): trim all white space up to the next non-white-space character.
      if (multiline) {
        let i = pos + 1;
        while (peekAt(i) === 0x20 || peekAt(i) === 0x09) i = i + 1;
        const d = peekAt(i);
        const atLineEnd = d === 0x0a || (d === 0x0d && peekAt(i + 1) === 0x0a);
        if (atLineEnd) {
          pos = i;
          for (;;) {
            const w = peek();
            if (w === 0x20 || w === 0x09 || w === 0x0a) pos = pos + 1;
            else if (w === 0x0d && peekAt(pos + 1) === 0x0a) pos = pos + 2;
            else break;
          }
          continue;
        }
      }
      if (scanEscape() < 0) return -1;
    } else if (c === 0x0a) {
      if (!multiline) return fail(openPos, "Unterminated string; newlines must be escaped in basic strings");
      pos = pos + 1;
    } else if (c === 0x0d) {
      if (peekAt(pos + 1) !== 0x0a) return fail(pos, BARE_CR);
      if (!multiline) {
        // A CRLF in a single-line string is the same mistake as a bare LF, so it gets the same diagnostic.
        return fail(openPos, "Unterminated string; newlines must be escaped in basic strings");
      }
      // CRLF normalizes to LF in multi-line strings.
      pos = pos + 2;
    } else if (c === 0x09) {
      pos = pos + 1;
    } else if (c < 0x20 || c === 0x7f) {
      return failChar(pos, "Control character must be escaped in a string:");
    } else {
      // the run of bytes that need no care
      let p = pos + 1;
      const e = n;
      const s = src;
      while (p < e) {
        const d = s[p] | 0;
        if (d === 0x22 || d === 0x5c || d < 0x20 || d === 0x7f) break;
        p = p + 1;
      }
      pos = p;
    }
  }
}

function scanEscape(): number {
  const escapePos = pos;
  pos = pos + 1;
  const c = peek();
  pos = pos + 1;
  switch (c) {
    case 0x62: case 0x74: case 0x6e: case 0x66: case 0x72: case 0x22: case 0x5c:
    case 0x65: // TOML 1.1: \e
      return 0;
    case 0x78: {
      const cp = readHexCodepoint("hex escape", 2, escapePos);
      if (cp < 0) return -1;
      return checkScalarValue(cp, escapePos);
    }
    case 0x75: {
      const cp = readHexCodepoint("Unicode escape", 4, escapePos);
      if (cp < 0) return -1;
      return checkScalarValue(cp, escapePos);
    }
    case 0x55: {
      const cp = readHexCodepoint("Unicode escape", 8, escapePos);
      if (cp < 0) return -1;
      return checkScalarValue(cp, escapePos);
    }
    default:
      if (c === 0 && atEof()) return fail(escapePos, "Unterminated escape sequence");
      pos = pos - 1;
      return failChar(pos, "Invalid escape sequence:");
  }
}

// Returns the code point (0 .. 0xFFFFFFFF), or -1 (error set).
function readHexCodepoint(what: string, digits: number, escapePos: number): number {
  let value = 0;
  for (let i = 0; i < digits; i++) {
    const d = peek();
    let v = -1;
    if (d >= 0x30 && d <= 0x39) v = d - 0x30;
    else if (d >= 0x61 && d <= 0x66) v = d - 0x61 + 10;
    else if (d >= 0x41 && d <= 0x46) v = d - 0x41 + 10;
    if (v < 0) return fail(escapePos, "A " + what + " must be followed by exactly " + digits + " hex digits");
    value = value * 16 + v;
    pos = pos + 1;
  }
  return value;
}

function checkScalarValue(cp: number, escapePos: number): number {
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return fail(escapePos, "Escaped code point must be a Unicode scalar value");
  return 0;
}

// Rust `scan_literal_string`: literal strings have no escapes.
function scanLiteralString(multiline: boolean): number {
  const openPos = pos;
  pos = pos + (multiline ? 3 : 1);

  if (multiline) {
    const c = peek();
    if (c === 0x0a) pos = pos + 1;
    else if (c === 0x0d && peekAt(pos + 1) === 0x0a) pos = pos + 2;
  }

  for (;;) {
    if (atEof()) return fail(openPos, "Unterminated string");
    const c = peek();
    if (c === 0x27) {
      if (!multiline) {
        pos = pos + 1;
        return 0;
      }
      const run = quoteRun(0x27);
      if (run < 0) return -1;
      if (run >= 3) {
        pos = pos + run;
        return 0;
      }
      pos = pos + run;
    } else if (c === 0x0a) {
      if (!multiline) return fail(openPos, "Unterminated string; literal strings cannot contain newlines");
      pos = pos + 1;
    } else if (c === 0x0d) {
      if (peekAt(pos + 1) !== 0x0a) return fail(pos, BARE_CR);
      if (!multiline) {
        return fail(openPos, "Unterminated string; literal strings cannot contain newlines");
      }
      pos = pos + 2;
    } else if (c === 0x09) {
      pos = pos + 1;
    } else if (c < 0x20 || c === 0x7f) {
      return failChar(pos, "Control character is not allowed in a literal string:");
    } else {
      let p = pos + 1;
      const e = n;
      const s = src;
      while (p < e) {
        const d = s[p] | 0;
        if (d === 0x27 || d < 0x20 || d === 0x7f) break;
        p = p + 1;
      }
      pos = p;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tokenizer (Rust `Tokenizer`)
// ---------------------------------------------------------------------------------------------------------------

function document(): number {
  if (initDocument() < 0) return -1;
  for (;;) {
    const ls = scanLineStart();
    if (ls < 0) return -1;
    if (ls === LS_EOF) return 0;
    if (ls === LS_TABLE_OPEN) {
      const aot = rLineAot;
      const open = aot ? TT_ARRAY_TABLE_OPEN : TT_TABLE_OPEN;
      const close = aot ? TT_ARRAY_TABLE_CLOSE : TT_TABLE_CLOSE;
      pushToken(open, rLinePos);
      for (;;) {
        if (scanKeyAfterSep() < 0) return -1;
        pushToken(TT_KEY, rKeyPos);
        const sep = scanHeaderSep(aot);
        if (sep < 0) return -1;
        if (sep === 1) pushLast(TT_DOT, 1);
        else break;
      }
      pushLast(close, aot ? 2 : 1);
      if (scanLineEnd("a table header") < 0) return -1;
    } else {
      if (keyval() < 0) return -1;
      if (scanLineEnd("a key/value pair") < 0) return -1;
    }
  }
}

// The first key segment has been scanned (rKeyPos): the rest of its key, `=` and the value with all that is in it.
function keyval(): number {
  // What closes the arrays and inline tables that are open.
  openLen = 0;
  outer: for (;;) {
    pushToken(TT_KEY, rKeyPos);
    for (;;) {
      const sep = scanKeyvalSep();
      if (sep < 0) return -1;
      if (sep !== 1) break;
      pushLast(TT_DOT, 1);
      if (scanKeyAfterSep() < 0) return -1;
      pushToken(TT_KEY, rKeyPos);
    }
    pushLast(TT_EQUALS, 1);
    if (scanValueRequired() < 0) return -1;
    inner: for (;;) {
      // Whether a value is complete. Otherwise an array or an inline table has been opened.
      let isAfterValue = false;
      if (rValueKind === VK_ARRAY_OPEN) {
        pushToken(TT_ARRAY_OPEN, rValuePos);
        pushOpen(TT_ARRAY_CLOSE);
      } else if (rValueKind === VK_INLINE_OPEN) {
        pushToken(TT_INLINE_OPEN, rValuePos);
        pushOpen(TT_INLINE_CLOSE);
      } else {
        pushToken(TT_SCALAR, rValuePos);
        isAfterValue = true;
      }
      for (;;) {
        if (openLen === 0) return 0;
        const close = openStack[openLen - 1] | 0;
        const isInline = close === TT_INLINE_CLOSE;
        if (isAfterValue) {
          const sep = isInline
            ? scanListSep(0x7d, "Expected ',' or '}' in an inline table but found")
            : scanListSep(0x5d, "Expected ',' or ']' in an array but found");
          if (sep < 0) return -1;
          if (sep === 1) {
            pushLast(TT_COMMA, 1);
          } else {
            pushLast(close, 1);
            openLen = openLen - 1;
            continue;
          }
        }
        if (isInline) {
          const ik = scanInlineKey();
          if (ik < 0) return -1;
          if (ik === IK_EOF) return fail(rKeyPos, "Unterminated inline table; expected '}'");
          if (ik === IK_KEY) continue outer;
        } else {
          const ai = scanArrayItem();
          if (ai < 0) return -1;
          if (ai === AI_EOF) return fail(rValuePos, "Unterminated array; expected ']'");
          if (ai === AI_VALUE) continue inner;
        }
        pushLast(close, 1);
        openLen = openLen - 1;
        isAfterValue = true;
      }
    }
  }
}

function pushOpen(close: number): void {
  if (openLen === openStack.length) growOpen();
  openStack[openLen] = close | 0;
  openLen = openLen + 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point and result
// ---------------------------------------------------------------------------------------------------------------

// Tokenizes `input[0 .. length)`. Returns 0, or -1 for a text that is not TOML: `tomlErrorMessage()` and
// `tomlErrorPos()` say why and where. The tokens are read with the functions below, until the next call.
export function tomlTokens(input: Uint8Array, length: number): number {
  src = input;
  n = length;
  pos = 0;
  tokCount = 0;
  openLen = 0;
  errMessage = "";
  errPosValue = 0;
  const r = document();
  src = EMPTY;
  return r < 0 ? -1 : 0;
}

// The words of Bun's parser for the error, and the byte of the text.
export function tomlErrorMessage(): string {
  return errMessage;
}

export function tomlErrorPos(): number {
  return errPosValue;
}

export function tomlTokenCount(): number {
  return tokCount;
}

export function tomlTokenKind(i: number): number {
  return tokKind[i] | 0;
}

export function tomlTokenStart(i: number): number {
  return tokStart[i] | 0;
}

export function tomlTokenEnd(i: number): number {
  return tokEnd[i] | 0;
}

// The arrays themselves, for loops (valid until the next call; read the first `tomlTokenCount()` entries).
export function tomlTokenKinds(): Uint8Array {
  return tokKind;
}

export function tomlTokenStarts(): Int32Array {
  return tokStart;
}

export function tomlTokenEnds(): Int32Array {
  return tokEnd;
}
