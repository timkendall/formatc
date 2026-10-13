// Port of vendor/bun/src/sema/parser/lexer.rs: the scanner of the TypeScript-Go-shaped parser.
//
// A PULL lexer: `next()` scans the next token; the token is in the fields `token` (T_*), `start`, `end`, `fullStart` (end of
// the previous token: `node.Pos()`), `newlineBefore`, `hasEscape`, `atom` (name / keyword / string value / bigint /
// JSX text) and `number` (value of a numeric literal). The parser calls the re-scanning entry points where the grammar
// needs another reading of the same characters: rescanGreaterThan, rescanSlash, rescanTemplateContinuation,
// rescanTemplateWithoutTag, scanJsxIdentifier, scanJsxAttributeValue, nextJsxChild.
//
// What it cannot scan it REFUSES (`refuse(why)`, why = R_* of lib.ts): from then on every token is the end of the file,
// so the parser unwinds without testing anything; the first refusal is in `refusal`/`refusedAt`/`refusedAfter`. With
// `recovers` it reports an error (code, start, end in `errors`) and goes on as TypeScript's scanner does.
//
// Differences to the Rust file (all deliberate):
//  - no SIMD "stops" tables: byte-class tables and plain loops. Name scanning hashes while it scans (FNV, names.ts), so one
//    probe gives the atom and (via atomTok) the token kind.
//  - `Mark` is a stack slot index (LIFO): `const m = lx.mark(); ... lx.reset(m)` restores and pops, `lx.release(m)` pops
//    without restoring (Rust: dropping the Mark).
//  - Diagnostics have no argument texts (code + range only).
//  - comments, comment directives, leading comments, flagged, errors, jsdoc asterisks, private names are I32Vec rows; see
//    the field docs.
//  - Hot-loop idioms of docs/SCRIPTC_COOKBOOK.md section 2: fields -> locals at method entry, `| 0` on every typed-array
//    read, int32 cursor math, 256-entry class tables.
import {
  R_CONFLICT_MARKER,
  R_ESCAPED_KEYWORD,
  R_INVALID_ESCAPE,
  R_NOT_UTF8,
  R_REPORTED,
  R_UNEXPECTED_CHARACTER,
  R_UNSUPPORTED,
  R_UNTERMINATED,
  R_UNUSUAL_NUMBER,
} from "./lib.ts";
import { ELSEWHERE, Names } from "./names.ts";
import {
  T_AMPERSAND, T_AMPERSAND_AMPERSAND, T_AMPERSAND_AMPERSAND_EQUALS, T_AMPERSAND_EQUALS, T_ASTERISK, T_ASTERISK_ASTERISK,
  T_ASTERISK_ASTERISK_EQUALS, T_ASTERISK_EQUALS, T_AT, T_AWAIT, T_ASYNC, T_BAR, T_BAR_BAR, T_BAR_BAR_EQUALS, T_BAR_EQUALS,
  T_BIG_INT, T_CARET, T_CARET_EQUALS, T_CLOSE_BRACE, T_CLOSE_BRACKET, T_CLOSE_PAREN, T_COLON, T_COMMA, T_CONFLICT_MARKER,
  T_DOT, T_DOT_DOT_DOT, T_EOF, T_EQUALS, T_EQUALS_EQUALS, T_EQUALS_EQUALS_EQUALS, T_EQUALS_GREATER_THAN, T_ESCAPED_RESERVED_WORD,
  T_EXCLAMATION, T_EXCLAMATION_EQUALS, T_EXCLAMATION_EQUALS_EQUALS, T_GREATER_THAN, T_GREATER_THAN_EQUALS,
  T_GREATER_THAN_GREATER_THAN, T_GREATER_THAN_GREATER_THAN_EQUALS, T_GREATER_THAN_GREATER_THAN_GREATER_THAN,
  T_GREATER_THAN_GREATER_THAN_GREATER_THAN_EQUALS, T_IDENTIFIER, T_INVALID, T_JSX_TEXT, T_LESS_THAN, T_LESS_THAN_EQUALS,
  T_LESS_THAN_LESS_THAN, T_LESS_THAN_LESS_THAN_EQUALS, T_LESS_THAN_SLASH, T_MINUS, T_MINUS_EQUALS, T_MINUS_MINUS,
  T_NO_SUBSTITUTION_TEMPLATE, T_NOT_TEXT, T_NUMBER, T_OPEN_BRACE, T_OPEN_BRACKET, T_OPEN_PAREN, T_PERCENT, T_PERCENT_EQUALS,
  T_PLUS, T_PLUS_EQUALS, T_PLUS_PLUS, T_PRIVATE_IDENTIFIER, T_QUESTION, T_QUESTION_DOT, T_QUESTION_QUESTION,
  T_QUESTION_QUESTION_EQUALS, T_REGEX, T_SEMICOLON, T_SLASH, T_SLASH_EQUALS, T_STRING, T_TEMPLATE_HEAD, T_TEMPLATE_MIDDLE,
  T_TEMPLATE_TAIL, T_TILDE, T_YIELD, isIdentifierOrKeyword, isReservedWord,
} from "./token.ts";
import {
  DEC, decode, decodeLast, isIdentifierPart, isIdentifierStart, isJsLineTerminator, isRecentIdentifierPart,
  isRecentIdentifierStart, isTypeScriptIdentifierPart, isUtf8, isWhiteSpaceLike, isWhiteSpaceSingleLine,
} from "./unicode.ts";
import { JSX_ENTITY_CODES, JSX_ENTITY_NAMES } from "./jsx_entities.ts";
import { Bytes, I32Vec } from "../vec.ts";
import { ATOM_NONE } from "../atom.ts";
import { hir } from "../hir.ts";

// ───────────────────────────── tables ─────────────────────────────

// What a token starts with, or what is between two (Rust `First`). Bytes whose token is unambiguous are in SIMPLE instead.
const F_INVALID = 0;
const F_BLANK = 1;
const F_LINE_FEED = 2;
const F_CARRIAGE_RETURN = 3;
const F_NAME = 4;
const F_DOT = 5;
const F_EQUALS = 6;
const F_QUOTE = 7;
const F_SLASH = 8;
const F_DIGIT = 9;
const F_EXCLAMATION = 10;
const F_QUESTION = 11;
const F_LESS_THAN = 12;
const F_GREATER_THAN = 13;
const F_PLUS = 14;
const F_MINUS = 15;
const F_ASTERISK = 16;
const F_PERCENT = 17;
const F_AMPERSAND = 18;
const F_BAR = 19;
const F_CARET = 20;
const F_BACKTICK = 21;
const F_HASH = 22;
const F_BACKSLASH = 23;
const F_NOT_ASCII = 24;
/** FIRST[c] >= F_SIMPLE: the byte is a token by itself, FIRST[c] - F_SIMPLE. */
const F_SIMPLE = 100;

const FIRST = new Uint8Array(256);
/** Token of a byte that is a token by itself: ( ) { } [ ] ; , : ~ @ */
const SIMPLE = new Uint8Array(256);
/** 1 for a byte that continues a name: [A-Za-z0-9_$] */
const NAME_BYTE = new Uint8Array(256);
/** 1 for a byte that ends the fast scan of a line comment: \n \r 0xE2 */
const EOL = new Uint8Array(256);
/** 1 for a byte that stops the fast scan of a string: control characters except tab, backslash, 0x7F.., and anything >= 0x80 */
const STR_STOP = new Uint8Array(256);
/** 1 for a byte that stops the scan of a block comment: * \n \r 0xE2 */
const BC_STOP = new Uint8Array(256);
for (let c = 0; c < 256; c++) {
  let k = F_INVALID;
  if (c === 32 || c === 9 || c === 0x0b || c === 0x0c) k = F_BLANK;
  else if (c === 10) k = F_LINE_FEED;
  else if (c === 13) k = F_CARRIAGE_RETURN;
  else if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36) k = F_NAME;
  else if (c === 46) k = F_DOT;
  else if (c === 61) k = F_EQUALS;
  else if (c === 39 || c === 34) k = F_QUOTE;
  else if (c === 47) k = F_SLASH;
  else if (c >= 48 && c <= 57) k = F_DIGIT;
  else if (c === 33) k = F_EXCLAMATION;
  else if (c === 63) k = F_QUESTION;
  else if (c === 60) k = F_LESS_THAN;
  else if (c === 62) k = F_GREATER_THAN;
  else if (c === 43) k = F_PLUS;
  else if (c === 45) k = F_MINUS;
  else if (c === 42) k = F_ASTERISK;
  else if (c === 37) k = F_PERCENT;
  else if (c === 38) k = F_AMPERSAND;
  else if (c === 124) k = F_BAR;
  else if (c === 94) k = F_CARET;
  else if (c === 96) k = F_BACKTICK;
  else if (c === 35) k = F_HASH;
  else if (c === 92) k = F_BACKSLASH;
  else if (c >= 0x80) k = F_NOT_ASCII;
  FIRST[c] = k;
  NAME_BYTE[c] = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 ? 1 : 0;
  EOL[c] = c === 10 || c === 13 || c === 0xe2 ? 1 : 0;
  STR_STOP[c] = (c < 32 && c !== 9) || c === 92 || c >= 127 ? 1 : 0;
  BC_STOP[c] = c === 42 || c === 10 || c === 13 || c === 0xe2 ? 1 : 0;
}
SIMPLE[40] = T_OPEN_PAREN;
SIMPLE[41] = T_CLOSE_PAREN;
SIMPLE[123] = T_OPEN_BRACE;
SIMPLE[125] = T_CLOSE_BRACE;
SIMPLE[91] = T_OPEN_BRACKET;
SIMPLE[93] = T_CLOSE_BRACKET;
SIMPLE[59] = T_SEMICOLON;
SIMPLE[44] = T_COMMA;
SIMPLE[58] = T_COLON;
SIMPLE[126] = T_TILDE;
SIMPLE[64] = T_AT;
// Simple bytes are dispatched in the same lookup as the class: FIRST[c] = F_SIMPLE + token (all tokens < 155).
for (let c = 0; c < 256; c++) {
  if ((SIMPLE[c] | 0) !== 0) FIRST[c] = (F_SIMPLE + (SIMPLE[c] | 0)) | 0;
}


/** The byte at `p`, or 0 beyond the end of the text (no token contains a zero byte outside a string or a comment). */
function at(src: Uint8Array, n: number, p: number): number {
  return p < n ? src[p] | 0 : 0;
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isHexDigit(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}
/** Value of the digit `c` in `radix`, or -1. */
function digitValue(c: number, radix: number): number {
  let v = -1;
  if (c >= 48 && c <= 57) v = c - 48;
  else if (c >= 97 && c <= 122) v = c - 97 + 10;
  else if (c >= 65 && c <= 90) v = c - 65 + 10;
  return v >= 0 && v < radix ? v : -1;
}

const POW10 = new Float64Array(16);
for (let i = 0, p = 1; i < 16; i++, p *= 10) POW10[i] = p;
/** Result slot of the unicode-escape reader: the code point. */
const ESC = new Int32Array(2);
let jsxEntities: Map<string, number> | null = null;

// Indices of a Mark in the mark stack (Float64Array, 8 numbers per mark).
const MARK_STRIDE = 8;

/** `v.toString(radix)` for a whole number (`Number.prototype.toString` with a radix is not used: the compiled code does not take it). */
export function radixText(v: number, radix: number): string {
  if (v <= 0) return "0";
  let s = "";
  let x = Math.floor(v);
  while (x > 0) {
    const d = x % radix;
    s = String.fromCharCode(d < 10 ? 48 + d : 87 + d) + s;
    x = Math.floor(x / radix);
  }
  return s;
}

export class Lexer {
  /** The text. The scanner never reads at or after `len`. */
  src: Uint8Array;
  /** Where the text ends (the length of the source; shortened by `setSrcEnd`). */
  len: number;
  /** The physical length of `src` (the DataView reads up to it; bytes at or after `len` are never part of a token). */
  physLen: number = 0;
  names: Names;
  /** T_* of the current token. */
  token: number = T_EOF;
  /** A line break precedes the token. */
  newlineBefore: boolean = false;
  /** The name or keyword has a Unicode escape, or the piece of a template an invalid escape. */
  hasEscape: boolean = false;
  /** The start of the token. */
  start: number = 0;
  /** The end of the token. */
  end: number = 0;
  /** The end of the previous token: `node.Pos()` of a node that starts with the token. */
  fullStart: number = 0;
  /** The text of a name, a keyword or a bigint (decimal digits), the value of a string or of a piece of a template; -1 for no atom. */
  atom: number = ATOM_NONE;
  /** The value of a numeric literal. */
  number: number = 0;
  /** Where the last string starts that has nothing between its quotes but printable ASCII, and no backslash (-1: none). */
  plainString: number = -1;
  /** 0, or the R_* code of the first refusal. */
  refusal: number = 0;
  /** Where the text was refused. */
  refusedAt: number = 0;
  /** `fullStart`, then. */
  refusedAfter: number = 0;
  /** `</` is one token. */
  isJsx: boolean = false;
  /** `Dialect::ecmascript`, in a JavaScript file. */
  isEcmascript: boolean = false;
  /** The goal symbol is Script. */
  isScript: boolean = false;
  /** `Dialect::typescript_5` */
  isTypescript5: boolean = false;
  /** `Dialect::babel` */
  isBabel: boolean = false;
  /** `Dialect::oxc` */
  isOxc: boolean = false;
  /** Where the first `<!--` is that was read as a `<`, outside a script (-1: none). */
  htmlOpensFirst: number = -1;
  /** The first of those that nothing but blanks and comments precedes on its line (-1: none). */
  htmlOpensFirstOnItsLine: number = -1;
  /** Each private name (atom) that was scanned; ATOM_NONE (-1): one after `super.`. For `rare::ODD_PRIVATE_NAME`. */
  privateNames: I32Vec;
  /** Rows (start, end, kind) of `@ts-expect-error` (0) / `@ts-ignore` (1) comments, in order (`hir::File::comment_directives`). */
  commentDirectives: I32Vec;
  /** Rows (start, end) of the comments before the first token. */
  leadingComments: I32Vec;
  /** Rows (start, end) of every `//` and `/* *​/` comment, in source order (`hir::File::comments`). Not a `#!` line, nor an HTML comment. */
  comments: I32Vec;
  /** Rows (code, start, end): what TypeScript's scanner reports and ECMAScript allows outside strict code. Only with `isEcmascript`. */
  flagged: I32Vec;
  /** `Options::recovers` */
  recovers: boolean = false;
  /** The argument of the message of an error that has one (`{0}`): the code and the start of the error, and the text. Looked up when the parser takes the errors. */
  argCode: number[] = [];
  argStart: number[] = [];
  argText: string[] = [];
  /** Rows (code, start, end) that `error` has reported and the parser has not taken yet (`takeErrors`). */
  errors: I32Vec;
  /** For each row of `errors`, where the scan that reported it began. */
  origins: I32Vec;
  /** `skipJSDocLeadingAsterisks`: the lexer is in a type of a JSDoc comment. */
  skipsJsdocAsterisks: boolean = false;
  /** `hir::File::jsdoc_asterisks`, in the order of events: not sorted, and one more than once. */
  jsdocAsterisks: I32Vec;
  /** Where values with escapes are decoded. */
  buffer: Bytes;
  jsxBuffer: Bytes;
  marks: Float64Array;
  markTop: number = 0;
  /** The recursion guard of `scanAfterComments` (Rust: stack_check). A comment run is a loop, so this only counts nesting. */
  depth: number = 0;

  constructor(names: Names) {
    this.src = new Uint8Array(0);
    this.len = 0;
    this.names = names;
    this.privateNames = new I32Vec(16);
    this.commentDirectives = hir.commentDirectives;
    this.leadingComments = new I32Vec(16);
    this.comments = hir.comments;
    this.flagged = new I32Vec(16);
    this.errors = new I32Vec(16);
    this.origins = new I32Vec(16);
    this.jsdocAsterisks = new I32Vec(16);
    this.buffer = new Bytes(256);
    this.jsxBuffer = new Bytes(256);
    this.marks = new Float64Array(8 * 64);
  }

  /**
   * Before a text is scanned: `src[0, len)`; `src.length >= len`. `comments` may be passed to share the HIR's comment table
   * (Rust: `lx.comments = take(file.comments)`); it is cleared.
   */
  begin(src: Uint8Array, len: number): void {
    this.src = src;
    this.len = len | 0;
    this.physLen = src.length;
    this.names.begin(src, len);
    this.token = T_EOF;
    this.newlineBefore = false;
    this.hasEscape = false;
    this.start = 0;
    this.end = 0;
    this.fullStart = 0;
    this.atom = ATOM_NONE;
    this.number = 0;
    this.plainString = -1;
    this.refusal = 0;
    this.refusedAt = 0;
    this.refusedAfter = 0;
    this.htmlOpensFirst = -1;
    this.htmlOpensFirstOnItsLine = -1;
    this.privateNames.reset();
    this.commentDirectives.reset();
    this.leadingComments.reset();
    this.comments.reset();
    this.flagged.reset();
    this.errors.reset();
    this.origins.reset();
    this.argCode = [];
    this.argStart = [];
    this.argText = [];
    this.jsdocAsterisks.reset();
    this.skipsJsdocAsterisks = false;
    this.markTop = 0;
    this.depth = 0;
  }

  /** Sets the dialect flags from lib.ts DIALECT_* bits and the file kind (`parser/mod.rs::run`). */
  configure(dialect: number, isJsx: boolean, isJavascript: boolean, isJson: boolean, recovers: boolean): void {
    const ecma = (dialect & 2) !== 0 && isJavascript && !isJson;
    this.isJsx = isJsx;
    this.recovers = recovers;
    this.isEcmascript = ecma;
    this.isTypescript5 = (dialect & 1) !== 0;
    this.isBabel = (dialect & 4) !== 0;
    this.isOxc = (dialect & 32) !== 0;
    this.isScript = (ecma || this.isOxc) && (dialect & 8) !== 0;
  }

  // ───────────────────────────── marks (lookahead) ─────────────────────────────

  /** Rust `mark()`. Returns a slot; marks are strictly LIFO. */
  mark(): number {
    let top = this.markTop | 0;
    if (top + MARK_STRIDE > this.marks.length) {
      const nm = new Float64Array(this.marks.length * 2);
      nm.set(this.marks);
      this.marks = nm;
    }
    const m = this.marks;
    m[top] = this.token;
    m[top + 1] = this.newlineBefore ? 1 : 0;
    m[top + 2] = this.hasEscape ? 1 : 0;
    m[top + 3] = this.start;
    m[top + 4] = this.end;
    m[top + 5] = this.fullStart;
    m[top + 6] = this.atom;
    m[top + 7] = this.number;
    this.markTop = top + MARK_STRIDE;
    return top;
  }

  /** Rust `reset(mark)`: restores the token and forgets what was recorded since (comments, flagged, errors). Pops the mark (and any above it). */
  reset(m: number): void {
    const a = this.marks;
    this.token = a[m] | 0;
    this.newlineBefore = (a[m + 1] | 0) !== 0;
    this.hasEscape = (a[m + 2] | 0) !== 0;
    this.start = a[m + 3] | 0;
    this.end = a[m + 4] | 0;
    this.fullStart = a[m + 5] | 0;
    this.atom = a[m + 6] | 0;
    this.number = a[m + 7];
    this.markTop = m;
    const end = this.end;
    const cl = this.comments.len;
    if (cl > 0 && (this.comments.data[cl - 2] | 0) >= end) this.forgetCommentsFrom(end);
    const fl = this.flagged.len;
    if (fl > 0 && (this.flagged.data[fl - 2] | 0) >= end) this.forgetFlaggedFrom(end);
    if (this.errors.len > 0) this.forgetErrorsFrom((((this.start | 0) + 1) | 0));
  }

  /** Drops the mark `m` without restoring (the speculation succeeded: Rust drops the `Mark`). */
  release(m: number): void {
    this.markTop = m;
  }

  /** What follows `pos` is scanned again, maybe as something else. */
  private forgetCommentsFrom(pos: number): void {
    const d = this.comments.data;
    let n = this.comments.len;
    while (n > 0 && (d[n - 2] | 0) >= pos) n = (((n | 0) - 2) | 0);
    this.comments.len = n;
  }
  private forgetFlaggedFrom(pos: number): void {
    const d = this.flagged.data;
    let n = this.flagged.len;
    while (n > 0 && (d[n - 2] | 0) >= pos) n = (((n | 0) - 3) | 0);
    this.flagged.len = n;
  }
  /** Forgets the errors of the scans that began at `pos` or later: they are made again. */
  private forgetErrorsFrom(pos: number): void {
    const o = this.origins.data;
    let k = this.origins.len;
    while (k > 0 && (o[k - 1] | 0) >= pos) k = (((k | 0) - 1) | 0);
    this.origins.len = k;
    this.errors.len = (k * 3) | 0;
  }

  // ───────────────────────────── errors / refusals ─────────────────────────────

  /**
   * `s.errorAt(message, pos, length)`: the message `code` from `start` to `end`. Returns whether the scanner goes on. Without
   * recovery it does not: the text is refused for `why`, and the caller returns.
   */
  error(why: number, code: number, start: number, end: number): boolean {
    if (!this.recovers) {
      this.refuse(why);
      return false;
    }
    // end = NO_LENGTH (-1): an empty range at `start`
    const e = start === end ? -1 : end;
    // A scan begins where the token before ends, a second scan of the token behind its start.
    const origin = this.fullStart === this.end ? this.fullStart : (((this.start | 0) + 1) | 0);
    // The parser has taken the others.
    this.origins.len = (this.errors.len / 3) | 0;
    this.origins.push(origin);
    this.errors.push3(code, start, e);
    return true;
  }

  /** `report` with the argument of the message. */
  reportWithArg(code: number, start: number, end: number, arg: string): void {
    if (this.recovers) {
      this.argCode.push(code);
      this.argStart.push(start);
      this.argText.push(arg);
    }
    this.report(code, start, end);
  }

  /** The text `src[start, end)` (error messages only). */
  textBetween(start: number, end: number): string {
    return Buffer.from(this.src.buffer, this.src.byteOffset + start, end - start).toString("utf8");
  }

  /** The argument noted for the error `code` at `start`, or "". */
  argOf(code: number, start: number): string {
    for (let i = this.argCode.length - 1; i >= 0; i--) if (this.argCode[i] === code && this.argStart[i] === start) return this.argText[i];
    return "";
  }

  /** `error`, where only recovery gets. */
  report(code: number, start: number, end: number): void {
    this.error(R_UNSUPPORTED, code, start, end);
  }

  /**
   * Moves the errors reported so far into `into` (rows of 3: code, start, end), except a "Keywords cannot contain escape
   * characters." (1260) about the current token, which `nextToken` reports when it leaves the token. Returns the number of rows moved.
   */
  takeErrors(into: I32Vec): number {
    const d = this.errors.data;
    let n = (this.errors.len / 3) | 0;
    let waiting = false;
    if (n > 0 && (d[(n - 1) * 3] | 0) === 1260 && (d[(n - 1) * 3 + 1] | 0) === this.start) {
      waiting = true;
      n = (((n | 0) - 1) | 0);
    }
    for (let i = 0; i < n; i++) into.push3(d[i * 3] | 0, d[i * 3 + 1] | 0, d[i * 3 + 2] | 0);
    if (waiting) {
      const origin = n < this.origins.len ? this.origins.data[n] | 0 : this.fullStart;
      const c = d[n * 3] | 0;
      const s = d[n * 3 + 1] | 0;
      const e = d[n * 3 + 2] | 0;
      this.errors.reset();
      this.origins.reset();
      this.errors.push3(c, s, e);
      this.origins.push(origin);
    } else {
      this.errors.reset();
      this.origins.reset();
    }
    return n;
  }

  /** `nextTokenWithoutCheck`: the token is taken as a name. Returns whether that error about it was still here. */
  forgetEscapedKeyword(): boolean {
    const n = (this.errors.len / 3) | 0;
    if (n > 0) {
      const d = this.errors.data;
      if ((d[(n - 1) * 3] | 0) === 1260 && (d[(n - 1) * 3 + 1] | 0) === this.start) {
        this.errors.len = ((n - 1) * 3) | 0;
        return true;
      }
    }
    return false;
  }

  /** Notes what is in `flagged`, or refuses the text (returns false). */
  private flag(code: number, start: number, end: number): boolean {
    if (this.isEcmascript) this.flagged.push3(code, start, end);
    return this.isEcmascript;
  }

  /** Gives up on the file, or on the speculative parse that is going on. */
  refuse(why: number): void {
    if (this.refusal === 0) {
      this.refusal = why;
      this.refusedAt = this.start;
      this.refusedAfter = this.fullStart;
    }
    this.token = T_EOF;
    this.start = this.len;
    this.end = this.len;
  }

  /** From here on the text ends where `end` is: before the `*​/` of a comment, or with the file (Rust `set_src`). */
  setSrcEnd(end: number): void {
    this.len = end | 0;
  }

  // ───────────────────────────── small queries ─────────────────────────────

  /** The buffer and offsets of the text of `atom`: `names.textBuf/textStart/textLen` (Rust `text_of`). */
  textBuf(atom: number): Uint8Array {
    return this.names.textBuf(atom);
  }
  textStart(atom: number): number {
    return this.names.textStart(atom);
  }
  textLen(atom: number): number {
    return this.names.textLen(atom);
  }

  /**
   * The first byte of the next token, if it is written right after the token or after one space. 0: there is more
   * between the two, or the byte does not say what the token is.
   */
  firstByteOfNext(): number {
    if (this.isScript) return 0;
    const n = this.len;
    let p = this.end;
    let c = at(this.src, n, p);
    if (c === 32) {
      p = (((p | 0) + 1) | 0);
      c = at(this.src, n, p);
    }
    if (c === 47 || c === 92) return 0;
    if (c >= 33 && c <= 126) return c;
    return 0;
  }

  /** At a `const`: the text says without a scan that no `enum` follows. false: it may. */
  isConstBeforeBinding(): boolean {
    const n = this.len;
    const p = this.end;
    if (at(this.src, n, p) !== 32 || p + 1 >= n) return false;
    const f = this.src[p + 1] | 0;
    return (
      (f >= 97 && f <= 100) || (f >= 102 && f <= 122) || (f >= 65 && f <= 90) || f === 95 || f === 36 || f === 123 || f === 91
    );
  }

  private set(token: number, start: number, end: number): void {
    this.token = token;
    this.start = start;
    this.end = end;
  }

  // ───────────────────────────── scan ─────────────────────────────

  /** Scans the next token. */
  next(): void {
    this.fullStart = this.end;
    this.newlineBefore = false;
    this.scan(this.end);
  }

  /** Scans the token at `pos0`, or after the blanks and comments there. */
  scan(pos0: number): void {
    const n = this.len | 0;
    let pos = pos0 | 0;
    while (true) {
      if (pos >= n) {
        this.set(T_EOF, n, n);
        return;
      }
      const byte = this.src[pos] | 0;
      const next = (((pos | 0) + 1) | 0);
      const k = FIRST[byte] | 0;
      if (k === F_BLANK) {
        pos = next;
        continue;
      }
      if (k === F_NAME) {
        this.name(pos);
        return;
      }
      if (k >= F_SIMPLE) {
        this.set((k - F_SIMPLE) | 0, pos, next);
        return;
      }
      if (k === F_LINE_FEED) {
        this.scanAfterLineFeed(next);
        return;
      }
      if (k === F_CARRIAGE_RETURN) {
        this.newlineBefore = true;
        pos = next;
        continue;
      }
      const c1 = next < n ? this.src[next] | 0 : 0;
      if (k === F_DOT) {
        if (c1 >= 48 && c1 <= 57) this.number_(pos);
        else if (c1 === 46 && at(this.src, n, next + 1) === 46) this.set(T_DOT_DOT_DOT, pos, (((pos | 0) + 3) | 0));
        else this.set(T_DOT, pos, next);
        return;
      }
      if (k === F_QUOTE) {
        this.string(pos);
        return;
      }
      if (k === F_DIGIT) {
        this.number_(pos);
        return;
      }
      if (k === F_EQUALS) {
        if (c1 === 61) {
          if (at(this.src, n, next + 1) !== 61) this.set(T_EQUALS_EQUALS, pos, (((pos | 0) + 2) | 0));
          else if (at(this.src, n, pos + 3) === 61) this.sameFourTimes(pos);
          else this.set(T_EQUALS_EQUALS_EQUALS, pos, (((pos | 0) + 3) | 0));
        } else if (c1 === 62) this.set(T_EQUALS_GREATER_THAN, pos, (((pos | 0) + 2) | 0));
        else this.set(T_EQUALS, pos, next);
        return;
      }
      if (k === F_SLASH) {
        if (c1 === 47 || c1 === 42) this.scanAfterComments(pos);
        else if (c1 === 61) this.set(T_SLASH_EQUALS, pos, (((pos | 0) + 2) | 0));
        else this.set(T_SLASH, pos, next);
        return;
      }
      if (k === F_EXCLAMATION) {
        if (c1 === 61) {
          if (at(this.src, n, next + 1) === 61) this.set(T_EXCLAMATION_EQUALS_EQUALS, pos, (((pos | 0) + 3) | 0));
          else this.set(T_EXCLAMATION_EQUALS, pos, (((pos | 0) + 2) | 0));
        } else this.set(T_EXCLAMATION, pos, next);
        return;
      }
      if (k === F_QUESTION) {
        const c2 = at(this.src, n, next + 1);
        if (c1 === 46 && !(c2 >= 48 && c2 <= 57)) this.set(T_QUESTION_DOT, pos, (((pos | 0) + 2) | 0));
        else if (c1 === 63 && c2 === 61) this.set(T_QUESTION_QUESTION_EQUALS, pos, (((pos | 0) + 3) | 0));
        else if (c1 === 63) this.set(T_QUESTION_QUESTION, pos, (((pos | 0) + 2) | 0));
        else this.set(T_QUESTION, pos, next);
        return;
      }
      if (k === F_LESS_THAN) {
        const c2 = at(this.src, n, next + 1);
        if (c1 === 60 && c2 === 60 && at(this.src, n, pos + 3) === 60) this.sameFourTimes(pos);
        else if (c1 === 60 && c2 === 61) this.set(T_LESS_THAN_LESS_THAN_EQUALS, pos, (((pos | 0) + 3) | 0));
        else if (c1 === 60) this.set(T_LESS_THAN_LESS_THAN, pos, (((pos | 0) + 2) | 0));
        else if (c1 === 61) this.set(T_LESS_THAN_EQUALS, pos, (((pos | 0) + 2) | 0));
        else if (c1 === 47 && this.isJsx && !this.isEcmascript && c2 !== 42) this.set(T_LESS_THAN_SLASH, pos, (((pos | 0) + 2) | 0));
        else if (c1 === 33 && c2 === 45 && (this.isScript || this.isOxc) && at(this.src, n, pos + 3) === 45) this.scanAtHtmlOpen(pos);
        else this.set(T_LESS_THAN, pos, next);
        return;
      }
      if (k === F_GREATER_THAN) {
        // The parser asks for `>=`, `>>` and so on where they can be.
        if (
          c1 === 62 && at(this.src, n, next + 1) === 62 && at(this.src, n, next + 2) === 62
        ) {
          this.sameFourTimes(pos);
          return;
        }
        this.set(T_GREATER_THAN, pos, next);
        return;
      }
      if (k === F_PLUS) {
        if (c1 === 43) this.set(T_PLUS_PLUS, pos, (((pos | 0) + 2) | 0));
        else if (c1 === 61) this.set(T_PLUS_EQUALS, pos, (((pos | 0) + 2) | 0));
        else this.set(T_PLUS, pos, next);
        return;
      }
      if (k === F_MINUS) {
        const c2 = at(this.src, n, next + 1);
        if (c1 === 45 && c2 === 62 && this.isScript && (this.newlineBefore || this.fullStart === 0)) this.scanAfterComments(pos);
        else if (c1 === 45) this.set(T_MINUS_MINUS, pos, (((pos | 0) + 2) | 0));
        else if (c1 === 61) this.set(T_MINUS_EQUALS, pos, (((pos | 0) + 2) | 0));
        else this.set(T_MINUS, pos, next);
        return;
      }
      if (k === F_ASTERISK) {
        const c2 = at(this.src, n, next + 1);
        if (c1 === 42 && c2 === 61) this.set(T_ASTERISK_ASTERISK_EQUALS, pos, (((pos | 0) + 3) | 0));
        else if (c1 === 42) this.set(T_ASTERISK_ASTERISK, pos, (((pos | 0) + 2) | 0));
        else if (c1 === 61) this.set(T_ASTERISK_EQUALS, pos, (((pos | 0) + 2) | 0));
        else if (this.newlineBefore && this.skipsJsdocAsterisks) this.scanAtJsdocAsterisk(pos);
        else this.set(T_ASTERISK, pos, next);
        return;
      }
      if (k === F_PERCENT) {
        if (c1 === 61) this.set(T_PERCENT_EQUALS, pos, (((pos | 0) + 2) | 0));
        else this.set(T_PERCENT, pos, next);
        return;
      }
      if (k === F_AMPERSAND) {
        const c2 = at(this.src, n, next + 1);
        if (c1 === 38 && c2 === 61) this.set(T_AMPERSAND_AMPERSAND_EQUALS, pos, (((pos | 0) + 3) | 0));
        else if (c1 === 38) this.set(T_AMPERSAND_AMPERSAND, pos, (((pos | 0) + 2) | 0));
        else if (c1 === 61) this.set(T_AMPERSAND_EQUALS, pos, (((pos | 0) + 2) | 0));
        else this.set(T_AMPERSAND, pos, next);
        return;
      }
      if (k === F_BAR) {
        const c2 = at(this.src, n, next + 1);
        if (c1 === 124 && c2 === 124 && at(this.src, n, pos + 3) === 124) this.sameFourTimes(pos);
        else if (c1 === 124 && c2 === 61) this.set(T_BAR_BAR_EQUALS, pos, (((pos | 0) + 3) | 0));
        else if (c1 === 124) this.set(T_BAR_BAR, pos, (((pos | 0) + 2) | 0));
        else if (c1 === 61) this.set(T_BAR_EQUALS, pos, (((pos | 0) + 2) | 0));
        else this.set(T_BAR, pos, next);
        return;
      }
      if (k === F_CARET) {
        if (c1 === 61) this.set(T_CARET_EQUALS, pos, (((pos | 0) + 2) | 0));
        else this.set(T_CARET, pos, next);
        return;
      }
      if (k === F_BACKTICK) {
        this.template(pos, true);
        return;
      }
      if (k === F_HASH) {
        this.hash(pos);
        return;
      }
      if (k === F_BACKSLASH) {
        this.nameSlowly(pos, pos);
        return;
      }
      if (k === F_NOT_ASCII) {
        this.scanAfterComments(pos);
        return;
      }
      this.invalidCharacter(R_UNEXPECTED_CHARACTER, pos);
      return;
    }
  }

  /**
   * Scans the token after the line feed before `pos0`, and after the indentation and the empty lines there. What most lines
   * start with (a name, a `}`) is dispatched here.
   */
  private scanAfterLineFeed(pos0: number): void {
    this.newlineBefore = true;
    const n = this.len | 0;
    let pos = pos0 | 0;
    while (true) {
      // indentation
      while (pos < n) {
        const c = this.src[pos] | 0;
        if (c !== 32 && c !== 9) break;
        pos = (((pos | 0) + 1) | 0);
      }
      if (pos >= n) {
        this.set(T_EOF, n, n);
        return;
      }
      const c = this.src[pos] | 0;
      const k = FIRST[c] | 0;
      if (k === F_NAME) {
        this.name(pos);
        return;
      }
      if (c === 125) {
        this.set(T_CLOSE_BRACE, pos, (((pos | 0) + 1) | 0));
        return;
      }
      if (k === F_LINE_FEED || k === F_CARRIAGE_RETURN || k === F_BLANK) {
        pos = (((pos | 0) + 1) | 0);
        continue;
      }
      this.scanAfterComments(pos);
      return;
    }
  }

  /** See `Parser::is_too_deep`: scanAfterComments is a loop; the guard only counts re-entrancy of `scan`. */
  private isTooDeep(): boolean {
    if (this.depth < 2000) return false;
    this.refuse(4 /* R_TOO_DEEP */);
    return true;
  }

  /** The `default:` of `Scan`, at what starts no token. Go reads invalid UTF-8 as U+FFFD. */
  private invalidCharacter(why: number, pos: number): void {
    if (!this.recovers) {
      this.refuse(why);
      return;
    }
    const len = decode(this.src, pos, this.len);
    if (len > 0 && (DEC[0] | 0) !== 0xfffd) {
      this.report(1127, pos, (((pos | 0) + (len | 0)) | 0));
      this.set(T_INVALID, pos, (((pos | 0) + (len | 0)) | 0));
    } else {
      // "File appears to be binary."
      this.report(1490, 0, 0);
      this.set(T_NOT_TEXT, pos, this.len);
    }
  }

  /**
   * At a comment, or at a character that is not ASCII: scans the token after it and after the blanks and comments that follow
   * it. They are passed over in a loop: a file can start with thousands of comments.
   */
  scanAfterComments(pos0: number): void {
    if (this.isTooDeep()) return;
    const n = this.len | 0;
    let pos = pos0 | 0;
    while (true) {
      const c = at(this.src, n, pos);
      let end = -1;
      if (c === 47) {
        const c1 = at(this.src, n, pos + 1);
        if (c1 === 47) end = this.lineComment(pos);
        else if (c1 === 42) {
          end = this.blockComment(pos);
          if (end < 0) return;
        } else {
          this.scan(pos);
          return;
        }
      } else if (c === 10) {
        this.newlineBefore = true;
        end = (((pos | 0) + 1) | 0);
      } else if (c === 13) {
        this.newlineBefore = true;
        end = (((pos | 0) + 1) | 0);
      } else if (c === 32 || c === 9 || c === 0x0b || c === 0x0c) {
        end = (((pos | 0) + 1) | 0);
      } else if (c === 60 || c === 45 || c === 35) {
        end = this.endOfUnusualComment(pos);
        if (end < 0) {
          this.scan(pos);
          return;
        }
      } else if (c >= 0x80) {
        end = this.notAscii(pos);
        if (end < 0) return; // the token is set
      } else {
        this.scan(pos);
        return;
      }
      pos = end;
    }
  }

  /** At a `<!--`, in a script or with `isOxc`. */
  private scanAtHtmlOpen(pos: number): void {
    if (this.isScript) {
      this.scanAfterComments(pos);
      return;
    }
    if (this.htmlOpensFirst < 0) this.htmlOpensFirst = pos;
    if ((this.newlineBefore || this.fullStart === 0) && this.htmlOpensFirstOnItsLine < 0) this.htmlOpensFirstOnItsLine = pos;
    this.set(T_LESS_THAN, pos, (((pos | 0) + 1) | 0));
  }

  /**
   * `Scan`, at a `*` behind a line break, with `skipJSDocLeadingAsterisks`: the first one in the trivia of a token is trivia
   * too (`TokenFlagsPrecedingJSDocLeadingAsterisks`).
   */
  private scanAtJsdocAsterisk(pos: number): void {
    if (this.isTooDeep()) return;
    const fullStart = this.fullStart;
    const n = this.jsdocAsterisks.len;
    if (n > 0) {
      const last = this.jsdocAsterisks.data[n - 1] | 0;
      if (fullStart <= last && last < pos) {
        this.set(T_ASTERISK, pos, (((pos | 0) + 1) | 0));
        return;
      }
    }
    this.jsdocAsterisks.push(pos);
    this.scan((((pos | 0) + 1) | 0));
  }

  /** At a character that is not ASCII: its end, if it is a blank or a line break. Otherwise it starts a name (scanned: -1) or the text is refused (-1). */
  private notAscii(pos: number): number {
    const len = decode(this.src, pos, this.len);
    if (len === 0) {
      this.invalidCharacter(R_NOT_UTF8, pos);
      return -1;
    }
    const c = DEC[0] | 0;
    if (c === 0x2028 || c === 0x2029) {
      this.newlineBefore = true;
    } else if (!isWhiteSpaceSingleLine(c)) {
      this.nameSlowly(pos, pos);
      return -1;
    }
    return (((pos | 0) + (len | 0)) | 0);
  }

  /** The end of the line of `pos`, if a `<!--`, a `-->` or a `#!` there makes the rest of it a comment; else -1. */
  private endOfUnusualComment(pos: number): number {
    const n = this.len;
    const c = this.src[pos] | 0;
    let isComment = false;
    if (this.isScript && c === 60 && at(this.src, n, pos + 1) === 33 && at(this.src, n, pos + 2) === 45 && at(this.src, n, pos + 3) === 45) {
      isComment = true;
    } else if (this.isScript && c === 45 && at(this.src, n, pos + 1) === 45 && at(this.src, n, pos + 2) === 62) {
      // Only blanks and comments are before it on its line.
      isComment = this.newlineBefore || this.fullStart === 0;
    } else if (!this.isScript || c === 35) {
      if (c === 35 && at(this.src, n, pos + 1) === 33) {
        isComment =
          pos === 0 || (pos === 3 && (this.src[0] | 0) === 0xef && (this.src[1] | 0) === 0xbb && (this.src[2] | 0) === 0xbf);
      }
    }
    return isComment ? this.endOfLine(pos) : -1;
  }

  /** `isConflictMarkerTrivia` */
  private isConflictMarker(pos: number): boolean {
    const n = this.len;
    const isFirstInLine = pos === 0 || at(this.src, n, pos - 1) === 10 || at(this.src, n, pos - 1) === 13;
    if (pos + 8 > n) return false;
    const m = this.src[pos] | 0;
    for (let i = 1; i < 7; i++) {
      if ((this.src[pos + i] | 0) !== m) return false;
    }
    const after = this.src[pos + 7] | 0;
    if (!(m === 61 || after === 32)) return false;
    return isFirstInLine || (this.recovers && this.isThirdInLine(pos));
  }

  /** `isConflictMarkerTrivia` takes that for the start of a line too. */
  private isThirdInLine(pos: number): boolean {
    if (pos < 2) return false;
    const len = decodeLast(this.src, pos - 2);
    if (len === 0) return false;
    const c = DEC[0] | 0;
    return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
  }

  /** `scanConflictMarkerTrivia`, at `pos`. Returns the end of what is passed over. */
  private conflictMarker(pos: number): number {
    this.report(1185, pos, (((pos | 0) + 7) | 0));
    const marker = at(this.src, this.len, pos);
    if (marker === 60 || marker === 62) return this.endOfLine(pos);
    // To the next `=======` or `>>>>>>>`.
    let end = pos;
    const n = this.len;
    while (end < n) {
      const c = this.src[end] | 0;
      if ((c === 61 || c === 62) && c !== marker && this.isConflictMarker(end)) break;
      end = (((end | 0) + 1) | 0);
    }
    return end;
  }

  /** At `====`, `<<<<`, `>>>>` or `||||`. */
  private sameFourTimes(pos: number): void {
    if (this.isConflictMarker(pos)) {
      if (!this.recovers) {
        this.refuse(R_CONFLICT_MARKER);
        return;
      }
      const end = this.conflictMarker(pos);
      this.scanAfterComments(end);
      return;
    }
    const c = at(this.src, this.len, pos);
    if (c === 61) this.set(T_EQUALS_EQUALS_EQUALS, pos, (((pos | 0) + 3) | 0));
    else if (c === 60) this.set(T_LESS_THAN_LESS_THAN, pos, (((pos | 0) + 2) | 0));
    else if (c === 124) this.set(T_BAR_BAR, pos, (((pos | 0) + 2) | 0));
    else this.set(T_GREATER_THAN, pos, (((pos | 0) + 1) | 0));
  }

  // ───────────────────────────── names ─────────────────────────────

  /**
   * A name or a keyword that starts at `start` with an ASCII letter, `_` or `$`. The hottest function: the scan of the name
   * also builds its key (names.ts: the first eight bytes as two little endian words, the last four bytes for names longer than
   * eight), so the atom is one probe away.
   */
  name(start: number): void {
    this.hasEscape = false;
    const n = this.len | 0;
    let p = ((start | 0) + 1) | 0;
    let k0 = this.src[start] | 0;
    let k1 = 0;
    // bytes 1..3
    let stop = ((start | 0) + 4) | 0;
    if (stop > n) stop = n;
    let sh = 8;
    while (p < stop) {
      const c = this.src[p] | 0;
      if ((NAME_BYTE[c] | 0) === 0) break;
      k0 = k0 | (c << sh);
      sh = (sh + 8) | 0;
      p = ((p | 0) + 1) | 0;
    }
    if (p === (((start | 0) + 4) | 0)) {
      // bytes 4..7
      stop = ((start | 0) + 8) | 0;
      if (stop > n) stop = n;
      sh = 0;
      while (p < stop) {
        const c = this.src[p] | 0;
        if ((NAME_BYTE[c] | 0) === 0) break;
        k1 = k1 | (c << sh);
        sh = (sh + 8) | 0;
        p = ((p | 0) + 1) | 0;
      }
      if (p === (((start | 0) + 8) | 0)) {
        // the rest of a long name
        while (p < n && (NAME_BYTE[this.src[p] | 0] | 0) !== 0) p = ((p | 0) + 1) | 0;
      }
    }
    if (p < n) {
      const c = this.src[p] | 0;
      if (c >= 0x80 || c === 92) {
        this.nameSlowly(start, p);
        return;
      }
    }
    const len = (p - start) | 0;
    let k2 = 0;
    if (len > 8) {
      k2 = (this.src[p - 4] | 0) | ((this.src[p - 3] | 0) << 8) | ((this.src[p - 2] | 0) << 16) | ((this.src[p - 1] | 0) << 24);
    }
    const atom = this.names.atomOfKeys(start, len, k0, k1, k2);
    this.atom = atom;
    this.token = this.names.atomToken(atom);
    this.start = start;
    this.end = p;
  }

  /** A name that starts at `start` and has a character that is not ASCII, or an escape, at `from` or later. */
  nameSlowly(start: number, from: number): void {
    const n = this.len;
    const text = this.buffer;
    text.reset();
    text.append(this.src, start, from);
    let pos = from;
    this.hasEscape = false;
    // The text of a private name has the `#`.
    const isPrivate = at(this.src, n, start) === 35;
    const privateLen = isPrivate ? 1 : 0;
    while (true) {
      // `scanIdentifierParts`: with `recovers` the name ends before what is no part of it.
      let c = 0;
      let len = 0;
      let isEscape = false;
      if (pos >= n) break;
      const b = this.src[pos] | 0;
      if (b === 92) {
        isEscape = true;
        if (this.unicodeEscape((((pos | 0) + 1) | 0))) {
          c = ESC[0] | 0;
          len = ((ESC[1] | 0) - pos) | 0;
        } else if (this.recovers) break;
        else {
          this.refuse(R_INVALID_ESCAPE);
          return;
        }
      } else {
        len = decode(this.src, pos, n);
        if (len === 0) {
          if (this.recovers) break;
          this.refuse(R_NOT_UTF8);
          return;
        }
        c = DEC[0] | 0;
      }
      let belongs = false;
      if (text.len === privateLen) {
        belongs = isIdentifierStart(c) || (this.isEcmascript && isRecentIdentifierStart(c));
      } else {
        belongs =
          isIdentifierPart(c) || isTypeScriptIdentifierPart(c) || (this.isEcmascript && isRecentIdentifierPart(c));
      }
      if (!belongs) {
        if (isEscape && !this.recovers) {
          this.refuse(R_INVALID_ESCAPE);
          return;
        }
        break;
      }
      if (c >= 0xd800 && c <= 0xdfff) {
        this.refuse(R_INVALID_ESCAPE);
        return;
      }
      if (isEscape) this.hasEscape = true;
      text.pushCodepointWtf8(c);
      pos = (((pos | 0) + (len | 0)) | 0);
    }
    if (text.len === privateLen) {
      if (isPrivate) this.hashWithoutName(start);
      else this.invalidCharacter(R_UNEXPECTED_CHARACTER, start);
      return;
    }
    const names = this.names;
    this.atom = names.atomOfBytes(text.data, 0, text.len);
    let kind = names.atomToken(this.atom);
    if (isPrivate) {
      this.notePrivateName(start);
      this.set(T_PRIVATE_IDENTIFIER, start, pos);
      return;
    }
    if (this.hasEscape && kind !== T_IDENTIFIER) {
      // `GetIdentifierToken`. See `takeErrors`.
      if (this.recovers) {
        this.report(1260, start, pos);
        this.set(kind, start, pos);
        return;
      }
      if (kind === T_AWAIT || kind === T_YIELD || kind === T_ASYNC) {
        this.refuse(R_ESCAPED_KEYWORD);
        return;
      }
      // It is an error where it is read as the keyword. TypeScript reads a word that is only reserved in some places as
      // the keyword where it can.
      if (isReservedWord(kind)) kind = T_ESCAPED_RESERVED_WORD;
      else if (this.isEcmascript) kind = T_IDENTIFIER;
      else {
        this.refuse(R_ESCAPED_KEYWORD);
        return;
      }
    }
    this.set(kind, start, pos);
  }

  /** `u1234` or `u{1234}` at `pos` (the `u`): on success the code point is `ESC[0]` and the end `ESC[1]`. */
  private unicodeEscape(pos: number): boolean {
    const n = this.len;
    if (at(this.src, n, pos) !== 117) return false;
    if (at(this.src, n, pos + 1) === 123) {
      let p = (((pos | 0) + 2) | 0);
      const digitsStart = p;
      while (p < n && isHexDigit(this.src[p] | 0)) p = (((p | 0) + 1) | 0);
      const len = (((p | 0) - (digitsStart | 0)) | 0);
      if (len === 0 || at(this.src, n, p) !== 125) return false;
      let zeros = 0;
      while (zeros < len && (this.src[digitsStart + zeros] | 0) === 48) zeros = (((zeros | 0) + 1) | 0);
      if (len - zeros > 6) return false;
      let c = 0;
      for (let i = zeros; i < len; i++) c = ((c << 4) | digitValue(this.src[digitsStart + i] | 0, 16)) | 0;
      if (c > 0x10ffff) return false;
      ESC[0] = c;
      ESC[1] = (((p | 0) + 1) | 0);
      return true;
    }
    if (pos + 5 > n) return false;
    let c = 0;
    for (let i = 1; i <= 4; i++) {
      const d = digitValue(this.src[pos + i] | 0, 16);
      if (d < 0) return false;
      c = (c << 4) | d;
    }
    ESC[0] = c;
    ESC[1] = (((pos | 0) + 5) | 0);
    return true;
  }

  /** At a `#`. */
  private hash(pos: number): void {
    const isFirst = pos === 0 || (pos === 3 && (this.src[0] | 0) === 0xef && (this.src[1] | 0) === 0xbb && (this.src[2] | 0) === 0xbf);
    if (isFirst && at(this.src, this.len, pos + 1) === 33) {
      this.scanAfterComments(pos);
      return;
    }
    this.privateName(pos);
  }

  /** `#name` at `start`. Its text has the `#`. */
  private privateName(start: number): void {
    const n = this.len;
    let end = (((start | 0) + 1) | 0);
    if (end < n && isDigit(this.src[end] | 0)) {
      this.hashWithoutName(start);
      return;
    }
    while (end < n && (NAME_BYTE[this.src[end] | 0] | 0) !== 0) end = (((end | 0) + 1) | 0);
    const after = at(this.src, n, end);
    if (end === start + 1 || after === 92 || after >= 0x80) {
      this.nameSlowly(start, end);
      return;
    }
    this.hasEscape = false;
    this.atom = this.names.atomOfSourceRange(start, end);
    this.notePrivateName(start);
    this.set(T_PRIVATE_IDENTIFIER, start, end);
  }

  /** `this.atom` is the private name at `start`. */
  private notePrivateName(start: number): void {
    this.privateNames.push(this.atom);
    // Is it right after `super.`?
    let p = start - 1;
    while (p >= 0 && (this.src[p] === 32 || this.src[p] === 9 || this.src[p] === 10 || this.src[p] === 13)) p = (((p | 0) - 1) | 0);
    if (p >= 0 && (this.src[p] | 0) === 46) {
      p = (((p | 0) - 1) | 0);
      while (p >= 0 && (this.src[p] === 32 || this.src[p] === 9 || this.src[p] === 10 || this.src[p] === 13)) p = (((p | 0) - 1) | 0);
      // ends with "super"
      if (
        p >= 4 && this.src[p] === 114 && this.src[p - 1] === 101 && this.src[p - 2] === 112 && this.src[p - 3] === 117 && this.src[p - 4] === 115
      ) {
        this.privateNames.push(ATOM_NONE);
      }
    }
  }

  /** The `#` of `Scan`, at `start`, that no name follows. */
  private hashWithoutName(start: number): void {
    if (!this.recovers) {
      this.refuse(R_UNEXPECTED_CHARACTER);
      return;
    }
    // "'#!' can only be used at the start of a file."
    if (at(this.src, this.len, start + 1) === 33) {
      this.report(18026, start, (((start | 0) + 2) | 0));
      this.set(T_INVALID, start, (((start | 0) + 1) | 0));
      return;
    }
    this.report(1127, start, (((start | 0) + 1) | 0));
    this.hasEscape = false;
    this.atom = this.names.atomOfSourceRange(start, (((start | 0) + 1) | 0));
    this.set(T_PRIVATE_IDENTIFIER, start, (((start | 0) + 1) | 0));
  }

  // ───────────────────────────── comments ─────────────────────────────

  /** The position of the line break that ends the line of `pos0`, or the end of the text. */
  private endOfLine(pos0: number): number {
    const n = this.len | 0;
    let p = pos0 | 0;
    while (true) {
      while (p < n && (EOL[this.src[p] | 0] | 0) === 0) p = (((p | 0) + 1) | 0);
      if (p >= n) return n;
      const c = this.src[p] | 0;
      if (c !== 0xe2) return p;
      if ((this.src[p + 1] | 0) === 0x80 && p + 2 < n && ((this.src[p + 2] | 0) === 0xa8 || (this.src[p + 2] | 0) === 0xa9)) return p;
      p = (((p | 0) + 1) | 0);
    }
  }

  /** Notes the `//` comment at `start`. Returns its end. */
  private lineComment(start: number): number {
    const end = this.endOfLine((((start | 0) + 2) | 0));
    if (this.fullStart === 0) this.leadingComments.push2(start, end);
    this.comments.push2(start, end);
    // `processCommentDirective`: "Skip opening //", "Skip another / if present"
    let pos = (((start | 0) + 2) | 0);
    while (pos < end && (this.src[pos] | 0) === 47) pos = (((pos | 0) + 1) | 0);
    this.commentDirective(start, pos, end);
    return end;
  }

  /** Notes the `/*` comment at `start`. Returns its end, or -1 if it has none and the text is refused. */
  private blockComment(start: number): number {
    const n = this.len | 0;
    let p = (((start | 0) + 2) | 0);
    let lastLine = start;
    let found = -1;
    while (p < n) {
      const c = this.src[p] | 0;
      if ((BC_STOP[c] | 0) === 0) {
        p = (((p | 0) + 1) | 0);
        continue;
      }
      if (c === 42) {
        if (at(this.src, n, p + 1) === 47) {
          found = p;
          break;
        }
      } else if (c === 10 || c === 13) {
        this.newlineBefore = true;
        lastLine = (((p | 0) + 1) | 0);
      } else if ((this.src[p + 1] | 0) === 0x80 && p + 2 < n && ((this.src[p + 2] | 0) === 0xa8 || (this.src[p + 2] | 0) === 0xa9)) {
        this.newlineBefore = true;
        lastLine = (((p | 0) + 3) | 0);
      }
      p = (((p | 0) + 1) | 0);
    }
    let end = 0;
    if (found >= 0) end = (((found | 0) + 2) | 0);
    else if (this.error(R_UNTERMINATED, 1010, n, n)) end = n;
    else return -1;
    if (this.fullStart === 0) this.leadingComments.push2(start, end);
    this.comments.push2(start, end);
    // `processCommentDirective`: "Skip whitespace", "Skip combinations of / and *"
    let pos = lastLine;
    while (pos < end && ((this.src[pos] | 0) === 32 || (this.src[pos] | 0) === 9)) pos = (((pos | 0) + 1) | 0);
    while (pos < end && ((this.src[pos] | 0) === 47 || (this.src[pos] | 0) === 42)) pos = (((pos | 0) + 1) | 0);
    this.commentDirective(lastLine, pos, end);
    return end;
  }

  /** `processCommentDirective`, from the blanks before the `@` on. */
  private commentDirective(start: number, pos0: number, end: number): void {
    let pos = pos0 | 0;
    while (pos < end && ((this.src[pos] | 0) === 32 || (this.src[pos] | 0) === 9)) pos = (((pos | 0) + 1) | 0);
    if (pos < end && (this.src[pos] | 0) === 64) this.commentDirectiveAt(start, (((pos | 0) + 1) | 0), end);
  }

  private startsWith(pos: number, lit: string): boolean {
    const n = this.len;
    const l = lit.length;
    if (pos + l > n) return false;
    for (let i = 0; i < l; i++) {
      if ((this.src[pos + i] | 0) !== lit.charCodeAt(i)) return false;
    }
    return true;
  }

  private commentDirectiveAt(start: number, name: number, end: number): void {
    let kind = -1;
    if (this.startsWith(name, "ts-expect-error")) kind = 0;
    else if (this.startsWith(name, "ts-ignore")) kind = 1;
    else return;
    // A lookahead scans a comment again.
    const n = this.commentDirectives.len;
    if (n === 0 || (this.commentDirectives.data[n - 2] | 0) < end) {
      this.commentDirectives.push3(start, end, kind);
    }
  }

  // ───────────────────────────── strings ─────────────────────────────

  /** The string at `start`, in the quotes `quote`. */
  private string(start: number): void {
    const n = this.len | 0;
    const quote = this.src[start] | 0;
    let end = (((start | 0) + 1) | 0);
    while (end < n) {
      const c = this.src[end] | 0;
      if (c === quote) break;
      if ((STR_STOP[c] | 0) !== 0) {
        // A backslash, a control character, or anything that is not ASCII.
        this.stringSlowly(start, quote);
        return;
      }
      end = (((end | 0) + 1) | 0);
    }
    if (end >= n) {
      this.stringSlowly(start, quote);
      return;
    }
    this.atom = this.names.atomOfSourceRange((((start | 0) + 1) | 0), end);
    this.plainString = start;
    this.set(T_STRING, start, (((end | 0) + 1) | 0));
  }

  /** Where the first of the bytes `a b c d` is from `pos` on, or the end of the text. */
  private endOfRunBefore(pos0: number, a: number, b: number, c: number, d: number): number {
    const n = this.len | 0;
    let p = pos0 | 0;
    while (p < n) {
      const x = this.src[p] | 0;
      if (x === a || x === b || x === c || x === d) return p;
      p = (((p | 0) + 1) | 0);
    }
    return n;
  }

  /** Decodes the escape whose backslash is at `pos` and appends what it stands for to `text`. Returns its end, or -1: TypeScript reports an error for it. */
  private escape(pos: number, text: Bytes): number {
    const n = this.len;
    if (pos + 1 >= n) return -1;
    const c = this.src[pos + 1] | 0;
    let simple = c;
    if (c === 110) simple = 10;
    else if (c === 116) simple = 9;
    else if (c === 114) simple = 13;
    else if (c === 98) simple = 8;
    else if (c === 102) simple = 12;
    else if (c === 118) simple = 11;
    else if (c === 48) {
      if (isDigit(at(this.src, n, pos + 2))) return -1;
      simple = 0;
    } else if (c >= 49 && c <= 57) return -1;
    else if (c === 120) {
      if (pos + 4 > n) return -1;
      const d0 = digitValue(this.src[pos + 2] | 0, 16);
      const d1 = digitValue(this.src[pos + 3] | 0, 16);
      if (d0 < 0 || d1 < 0) return -1;
      text.pushCodepointWtf8((d0 << 4) | d1);
      return (((pos | 0) + 4) | 0);
    } else if (c === 117) {
      if (!this.unicodeEscape((((pos | 0) + 1) | 0))) return -1;
      text.pushCodepointWtf8(ESC[0] | 0);
      return ESC[1] | 0;
    } else if (c === 13) {
      // A line continuation.
      if (at(this.src, n, pos + 2) === 10) return (((pos | 0) + 3) | 0);
      return (((pos | 0) + 2) | 0);
    } else if (c === 10) {
      return (((pos | 0) + 2) | 0);
    } else if (c >= 0x80) {
      const len = decode(this.src, (((pos | 0) + 1) | 0), n);
      if (len === 0) return this.escapedByte(pos, text);
      const cp = DEC[0] | 0;
      if (cp !== 0x2028 && cp !== 0x2029) text.append(this.src, (((pos | 0) + 1) | 0), (pos + 1 + len) | 0);
      return (pos + 1 + len) | 0;
    }
    text.push(simple);
    return (((pos | 0) + 2) | 0);
  }

  /** `scanEscapeSequence`, at a backslash before a byte that is not UTF-8: Go reads U+FFFD. */
  private escapedByte(pos: number, text: Bytes): number {
    if (!this.recovers) return -1;
    text.pushCodepointWtf8(0xfffd);
    return (((pos | 0) + 2) | 0);
  }

  /** `\1` to `\377`, `\8` or `\9` at `pos` in a string. Returns its end, or -1. */
  private legacyEscape(pos: number, text: Bytes): number {
    const end = this.endOfInvalidEscape(pos);
    if (pos + 1 >= end) return -1;
    const first = this.src[pos + 1] | 0;
    let code = 0;
    let c = 0;
    if (first >= 48 && first <= 55) {
      code = 1487;
      for (let i = pos + 1; i < end; i++) {
        const d = this.src[i] | 0;
        if (d < 48 || d > 55) return -1;
        c = (c * 8 + (d - 48)) | 0;
      }
    } else if (first === 56 || first === 57) {
      code = 1488;
      c = first;
    } else return -1;
    if (!this.flag(code, pos, end)) return -1;
    text.pushCodepointWtf8(c);
    return end;
  }

  /** `scanEscapeSequence`: how far the invalid escape at `pos` goes. */
  private endOfInvalidEscape(pos: number): number {
    const n = this.len;
    let end = (((pos | 0) + 2) | 0);
    const c = at(this.src, n, pos + 1);
    if (c >= 48 && c <= 51) {
      if (this.isOctalAt(end)) end = (((end | 0) + 1) | 0);
      if (this.isOctalAt(end)) end = (((end | 0) + 1) | 0);
    } else if (c >= 52 && c <= 55) {
      if (this.isOctalAt(end)) end = (((end | 0) + 1) | 0);
    } else if (c === 120) {
      while (end < pos + 4 && end < n && isHexDigit(this.src[end] | 0)) end = (((end | 0) + 1) | 0);
    } else if (c === 117 && at(this.src, n, end) === 123) {
      end = (((end | 0) + 1) | 0);
      while (end < n && isHexDigit(this.src[end] | 0)) end = (((end | 0) + 1) | 0);
      if (at(this.src, n, end) === 125) end = (((end | 0) + 1) | 0);
    } else if (c === 117) {
      while (end < pos + 6 && end < n && isHexDigit(this.src[end] | 0)) end = (((end | 0) + 1) | 0);
    }
    return end < n ? end : n;
  }
  private isOctalAt(p: number): boolean {
    const c = at(this.src, this.len, p);
    return c >= 48 && c <= 55;
  }

  private stringSlowly(start: number, quote: number): void {
    const n = this.len | 0;
    const text = this.buffer;
    text.reset();
    let pos = (((start | 0) + 1) | 0);
    let isAscii = true;
    let hasEnd = false;
    while (true) {
      if (pos >= n || (this.src[pos] | 0) === 10 || (this.src[pos] | 0) === 13) {
        // "Unterminated string literal." The string ends there.
        if (!this.error(R_UNTERMINATED, 1002, pos, pos)) return;
        hasEnd = false;
        break;
      }
      const c = this.src[pos] | 0;
      if (c === quote) {
        hasEnd = true;
        break;
      }
      if (c === 92) {
        const c1 = at(this.src, n, pos + 1);
        // The commonest of those that stand for what follows the backslash.
        if (c1 === 34 || c1 === 39 || c1 === 92) {
          text.push(c1);
          pos = (((pos | 0) + 2) | 0);
          continue;
        }
        let end = this.escape(pos, text);
        if (end < 0) {
          end = this.legacyEscape(pos, text);
          if (end < 0) {
            if (this.recovers) end = this.invalidEscape(pos, text, true);
            else {
              this.refuse(R_INVALID_ESCAPE);
              return;
            }
          }
        }
        pos = end;
        continue;
      }
      const end = this.endOfRunBefore((((pos | 0) + 1) | 0), quote, 92, 10, 13);
      for (let i = pos; i < end; i++) {
        if ((this.src[i] | 0) >= 0x80) {
          isAscii = false;
          break;
        }
      }
      text.append(this.src, pos, end);
      pos = end;
    }
    // TypeScript's scanner takes the bytes as they are.
    if (!isAscii && !this.recovers && !isUtf8(this.src, (((start | 0) + 1) | 0), pos)) {
      this.refuse(R_NOT_UTF8);
      return;
    }
    this.atom = this.names.atomOfBytes(text.data, 0, text.len);
    this.set(T_STRING, start, (pos + (hasEnd ? 1 : 0)) | 0);
  }

  /** `scanEscapeSequence`, for what `escape` does not decode. `reports`: `ReportErrors`. Returns the end. */
  private invalidEscape(pos: number, text: Bytes, reports: boolean): number {
    const n = this.len;
    const end = this.endOfInvalidEscape(pos);
    if (pos + 1 >= n) {
      // "Unexpected end of text." It stands for nothing.
      this.error(R_UNTERMINATED, 1126, end, end);
      return end;
    }
    const c = this.src[pos + 1] | 0;
    if (!reports) {
      text.append(this.src, pos, end);
      return end;
    }
    if (c >= 48 && c <= 55) {
      let code = 0;
      for (let i = pos + 1; i < end; i++) code = (code * 8 + ((this.src[i] | 0) - 48)) | 0;
      this.reportWithArg(1487, pos, end, "\\x" + (code < 16 ? "0" : "") + radixText(code, 16));
      text.pushCodepointWtf8(code);
    } else if (c === 56 || c === 57) {
      this.reportWithArg(1488, pos, end, this.textBetween(pos, end));
      text.push(c);
    } else if (c === 120) {
      // "Hexadecimal digit expected."
      this.report(1125, end, end);
      text.append(this.src, pos, end);
    } else if (c === 117) {
      this.reportInvalidUnicodeEscape(pos, end);
      text.append(this.src, pos, end);
    } else {
      // `escape` decodes the others.
      return (((pos | 0) + 1) | 0);
    }
    return end;
  }

  /** `scanUnicodeEscape(true)`, for the `\u` from `pos` to `end` that is not valid. */
  private reportInvalidUnicodeEscape(pos: number, end: number): void {
    const n = this.len;
    if (at(this.src, n, pos + 2) !== 123) {
      this.report(1125, end, end);
      return;
    }
    const first = (((pos | 0) + 3) | 0);
    let after = first;
    let value = 0;
    while (after < n && isHexDigit(this.src[after] | 0)) {
      value = Math.min(value * 16 + digitValue(this.src[after] | 0, 16), 0x7fffffff);
      after = (((after | 0) + 1) | 0);
    }
    if (after === first) {
      this.report(1125, after, after);
      return;
    }
    if (value > 0x10ffff) this.report(1198, first, after);
    if (after >= n) this.report(1126, after, after);
    else if ((this.src[after] | 0) !== 125) this.report(1199, after, after);
  }

  // ───────────────────────────── templates ─────────────────────────────

  /** A piece of a template, from the `` ` `` (`isHead`) or the `}` at `start`. */
  private template(start: number, isHead: boolean): void {
    this.pieceOfTemplate(start, isHead, false);
  }

  /** `scanTemplateAndSetTokenValue`. `reports`: `shouldEmitInvalidEscapeError`. */
  private pieceOfTemplate(start: number, isHead: boolean, reports: boolean): void {
    const n = this.len | 0;
    const text = this.buffer;
    text.reset();
    let pos = (((start | 0) + 1) | 0);
    let isAscii = true;
    this.hasEscape = false;
    const last = isHead ? T_NO_SUBSTITUTION_TEMPLATE : T_TEMPLATE_TAIL;
    let token = 0;
    let end = 0;
    while (true) {
      if (pos >= n) {
        // "Unterminated template literal." The template ends there.
        if (!this.error(R_UNTERMINATED, 1160, pos, pos)) return;
        token = last;
        end = pos;
        break;
      }
      const c = this.src[pos] | 0;
      if (c === 96) {
        token = last;
        end = (((pos | 0) + 1) | 0);
        break;
      }
      if (c === 36 && at(this.src, n, pos + 1) === 123) {
        token = isHead ? T_TEMPLATE_HEAD : T_TEMPLATE_MIDDLE;
        end = (((pos | 0) + 2) | 0);
        break;
      }
      if (c === 92) {
        const e = this.escape(pos, text);
        if (e >= 0) pos = e;
        else {
          // That is an error unless the template has a tag.
          if (pos + 1 < n) this.hasEscape = true;
          isAscii = false;
          pos = this.invalidEscape(pos, text, reports);
        }
        continue;
      }
      // A line break is a line feed, however it is written.
      if (c === 13) {
        text.push(10);
        pos = (pos + (at(this.src, n, pos + 1) === 10 ? 2 : 1)) | 0;
        continue;
      }
      let e = (((pos | 0) + 1) | 0);
      while (e < n) {
        const x = this.src[e] | 0;
        if (x === 96 || x === 36 || x === 92 || x === 13) break;
        e = (((e | 0) + 1) | 0);
      }
      for (let i = pos; i < e; i++) {
        if ((this.src[i] | 0) >= 0x80) {
          isAscii = false;
          break;
        }
      }
      text.append(this.src, pos, e);
      pos = e;
    }
    if (!isAscii && !this.recovers && !isUtf8(this.src, (((start | 0) + 1) | 0), pos)) {
      this.refuse(R_NOT_UTF8);
      return;
    }
    this.atom = this.names.atomOfBytes(text.data, 0, text.len);
    this.set(token, start, end);
  }

  /** `ReScanTemplateToken`: the token is the `}` that ends a substitution. */
  rescanTemplateContinuation(): void {
    this.template(this.start, false);
  }

  /** `ReScanTemplateToken(false)`, at a piece of a template that has an invalid escape. */
  rescanTemplateWithoutTag(): void {
    if (!this.recovers) {
      this.refuse(R_REPORTED);
      return;
    }
    // TypeScript scans what follows a `}` once.
    this.forgetErrorsFrom((((this.start | 0) + 1) | 0));
    const start = this.start;
    this.pieceOfTemplate(start, at(this.src, this.len, start) === 96, true);
  }

  // ───────────────────────────── numbers ─────────────────────────────

  /** The digits of base `radix` from `pos` on, with separators between them. Returns their end, or -1. */
  private digits(pos0: number, radix: number): number {
    const n = this.len;
    let pos = pos0 | 0;
    const first = pos;
    while (true) {
      const c = at(this.src, n, pos);
      if (pos < n && digitValue(c, radix) >= 0) {
        pos = (((pos | 0) + 1) | 0);
      } else if (c === 95 && pos < n) {
        // Only between two digits.
        if (pos > first && (this.src[pos - 1] | 0) !== 95 && pos + 1 < n && digitValue(this.src[pos + 1] | 0, radix) >= 0) {
          pos = (((pos | 0) + 1) | 0);
        } else return -1;
      } else break;
    }
    return pos > first ? pos : -1;
  }

  /** A number token (`number` is also the name of the field, hence the underscore). */
  number_(start: number): void {
    const n = this.len | 0;
    // The common case: a few digits.
    let pos = start | 0;
    let value = 0;
    while (pos < n) {
      const c = this.src[pos] | 0;
      if (c < 48 || c > 57) break;
      value = value * 10 + (c - 48);
      pos = (((pos | 0) + 1) | 0);
    }
    const after = at(this.src, n, pos);
    const isPlain = !(
      after === 46 || after === 95 || after === 36 || after === 92 || (after >= 97 && after <= 122) ||
      (after >= 65 && after <= 90) || after >= 0x80
    );
    if (isPlain && pos - start <= 15 && ((this.src[start] | 0) !== 48 || pos - start === 1)) {
      this.number = value;
      this.set(T_NUMBER, start, pos);
      return;
    }
    this.numberInGeneral(start);
  }

  /**
   * `123.45` (at most 15 digits, no separator, no exponent) and `0xFF` (at most 12 digits, no separator): the value without a
   * string (a decimal is `digits / 10^k`, both exact doubles, so the division is correctly rounded). Returns false for the rest.
   */
  private simpleNumber(start: number): boolean {
    const n = this.len | 0;
    const c0 = this.src[start] | 0;
    let pos = start | 0;
    if (c0 === 48 && (at(this.src, n, start + 1) | 32) === 120) {
      pos = ((start | 0) + 2) | 0;
      let v = 0;
      let count = 0;
      while (pos < n) {
        const d = digitValue(this.src[pos] | 0, 16);
        if (d < 0) break;
        v = v * 16 + d;
        count = ((count | 0) + 1) | 0;
        pos = ((pos | 0) + 1) | 0;
      }
      if (count === 0 || count > 12) return false;
      const t = at(this.src, n, pos);
      if ((NAME_BYTE[t] | 0) !== 0 || t === 92 || t >= 0x80) return false;
      this.number = v;
      this.set(T_NUMBER, start, pos);
      return true;
    }
    let mant = 0;
    let digits = 0;
    while (pos < n) {
      const c = this.src[pos] | 0;
      if (c < 48 || c > 57) break;
      mant = mant * 10 + (c - 48);
      digits = ((digits | 0) + 1) | 0;
      pos = ((pos | 0) + 1) | 0;
    }
    if (c0 === 48 && digits > 1) return false;
    let frac = 0;
    if (at(this.src, n, pos) === 46) {
      pos = ((pos | 0) + 1) | 0;
      while (pos < n) {
        const c = this.src[pos] | 0;
        if (c < 48 || c > 57) break;
        mant = mant * 10 + (c - 48);
        frac = ((frac | 0) + 1) | 0;
        pos = ((pos | 0) + 1) | 0;
      }
      if (frac === 0) return false;
    } else if (digits === 0) return false;
    if (digits + frac > 15) return false;
    const t = at(this.src, n, pos);
    if ((NAME_BYTE[t] | 0) !== 0 || t === 46 || t === 92 || t >= 0x80) return false;
    this.number = frac === 0 ? mant : mant / (POW10[frac] as number);
    this.set(T_NUMBER, start, pos);
    return true;
  }

  private numberInGeneral(start: number): void {
    if (this.simpleNumber(start)) return;
    const end = this.unusualNumber(start);
    if (end >= 0) {
      this.set(this.tmpToken, start, end);
      return;
    }
    this.invalidNumber(start);
  }

  /** Token kind that `unusualNumber` / `numberWithLeadingZero` found. */
  tmpToken: number = T_NUMBER;

  /** Whether what cannot follow a number directly is at `pos`. */
  private isAtStartOfName(pos: number): boolean {
    const n = this.len;
    if (pos >= n) return false;
    const c = this.src[pos] | 0;
    if (c < 0x80) return (NAME_BYTE[c] | 0) !== 0 || c === 92;
    const len = decode(this.src, pos, n);
    if (len === 0) return true;
    return isIdentifierPart(DEC[0] | 0);
  }

  /** The text src[start,end) without `_`, as a JS number (decimal). */
  private parseDecimal(start: number, end: number): number {
    let s = "";
    for (let i = start; i < end; i++) {
      const c = this.src[i] | 0;
      if (c !== 95) s += String.fromCharCode(c);
    }
    const v = parseFloat(s);
    return v;
  }

  /** `0b/0o/0x` digits (separators removed) as the number rounded once. */
  private numberFromDigits(start: number, end: number, radix: number): number {
    let v = 0;
    let count = 0;
    let exact = true;
    for (let i = start; i < end; i++) {
      const c = this.src[i] | 0;
      if (c === 95) continue;
      count = (((count | 0) + 1) | 0);
      if (count > 12) {
        exact = false;
        break;
      }
      v = v * radix + digitValue(c, radix);
    }
    if (exact) return v;
    let s = radix === 16 ? "0x" : radix === 8 ? "0o" : "0b";
    for (let i = start; i < end; i++) {
      const c = this.src[i] | 0;
      if (c !== 95) s += String.fromCharCode(c);
    }
    return Number(s);
  }

  /** `010`, which is 8, or `08` and `08.5`, which are decimal. Returns the end or -1. */
  private numberWithLeadingZero(start: number): number {
    const n = this.len;
    let end = start;
    while (end < n && isDigit(this.src[end] | 0)) end = (((end | 0) + 1) | 0);
    let isOctal = true;
    for (let i = start; i < end; i++) {
      const d = this.src[i] | 0;
      if (d < 48 || d > 55) {
        isOctal = false;
        break;
      }
    }
    if (isOctal) {
      // The message is about `-010` as a whole.
      const from = (start - (this.token === T_MINUS && this.end === start ? 1 : 0)) | 0;
      if (!this.flag(1121, from, end)) return -1;
      this.number = this.numberFromDigits(start, end, 8);
    } else {
      if (at(this.src, n, end) === 46) {
        end = (((end | 0) + 1) | 0);
        if (isDigit(at(this.src, n, end))) {
          end = this.digits(end, 10);
          if (end < 0) return -1;
        } else if (at(this.src, n, end) === 95) return -1;
      }
      const e = at(this.src, n, end);
      if (e === 101 || e === 69) {
        end = (((end | 0) + 1) | 0);
        const s = at(this.src, n, end);
        if (s === 43 || s === 45) end = (((end | 0) + 1) | 0);
        end = this.digits(end, 10);
        if (end < 0) return -1;
      }
      if (!this.flag(1489, start, end)) return -1;
      this.number = this.parseDecimal(start, end);
    }
    if (this.isAtStartOfName(end)) return -1;
    this.tmpToken = T_NUMBER;
    return end;
  }

  /** Numbers that are not a few plain digits. Sets `tmpToken`; returns the end or -1 (invalid). */
  private unusualNumber(start: number): number {
    const n = this.len;
    const c0 = this.src[start] | 0;
    const c1 = at(this.src, n, start + 1);
    let radix = 10;
    if (c0 === 48 && (c1 === 120 || c1 === 88)) radix = 16;
    else if (c0 === 48 && (c1 === 111 || c1 === 79)) radix = 8;
    else if (c0 === 48 && (c1 === 98 || c1 === 66)) radix = 2;
    else if (c0 === 48 && c1 === 95) return -1;
    else if (c0 === 48 && isDigit(c1)) return this.numberWithLeadingZero(start);
    let isInteger = true;
    let end = 0;
    if (radix !== 10) {
      end = this.digits((((start | 0) + 2) | 0), radix);
      if (end < 0) return -1;
    } else {
      end = start;
      if (c0 !== 46) {
        end = this.digits(start, 10);
        if (end < 0) return -1;
      }
      if (at(this.src, n, end) === 46) {
        isInteger = false;
        end = (((end | 0) + 1) | 0);
        if (isDigit(at(this.src, n, end))) {
          end = this.digits(end, 10);
          if (end < 0) return -1;
        } else if (at(this.src, n, end) === 95) return -1;
      }
      const e = at(this.src, n, end);
      if (e === 101 || e === 69) {
        isInteger = false;
        end = (((end | 0) + 1) | 0);
        const s = at(this.src, n, end);
        if (s === 43 || s === 45) end = (((end | 0) + 1) | 0);
        end = this.digits(end, 10);
        if (end < 0) return -1;
      }
    }
    const isBigint = isInteger && at(this.src, n, end) === 110;
    let token = T_NUMBER;
    if (isBigint) {
      const digitsStart = radix === 10 ? start : (((start | 0) + 2) | 0);
      this.atom = this.bigintAtom(digitsStart, end, radix);
      end = (((end | 0) + 1) | 0);
      token = T_BIG_INT;
    } else {
      this.number = radix === 10 ? this.parseDecimal(start, end) : this.numberFromDigits((((start | 0) + 2) | 0), end, radix);
    }
    if (this.isAtStartOfName(end)) return -1;
    this.tmpToken = token;
    return end;
  }

  /** The atom of the decimal digits of src[start,end) (digits of base `radix`, separators allowed) - `ParsePseudoBigInt`. */
  private bigintAtom(start: number, end: number, radix: number): number {
    const text = this.buffer;
    text.reset();
    if (radix === 10) {
      for (let i = start; i < end; i++) {
        const c = this.src[i] | 0;
        if (c !== 95) text.push(c);
      }
    } else {
      let s = radix === 16 ? "0x" : radix === 8 ? "0o" : "0b";
      for (let i = start; i < end; i++) {
        const c = this.src[i] | 0;
        if (c !== 95) s += String.fromCharCode(c);
      }
      const dec = BigInt(s).toString();
      text.appendAscii(dec);
    }
    return this.names.atomOfBytes(text.data, 0, text.len);
  }

  /** `scanNumberFragment`, `scanHexDigits`, `scanBinaryOrOctalDigits`. Appends the digits to `digits`; returns the end. */
  private digitsAndSeparators(pos0: number, radix: number, digits: Bytes): number {
    let allowsSeparator = false;
    let isAfterSeparator = false;
    const n = this.len;
    let pos = pos0 | 0;
    while (pos < n) {
      const c = this.src[pos] | 0;
      if (digitValue(c, radix) >= 0) {
        digits.push(c);
        allowsSeparator = true;
        isAfterSeparator = false;
      } else if (c !== 95) {
        break;
      } else if (allowsSeparator) {
        allowsSeparator = false;
        isAfterSeparator = true;
      } else if (isAfterSeparator) {
        this.report(6189, pos, (((pos | 0) + 1) | 0));
      } else {
        this.report(6188, pos, (((pos | 0) + 1) | 0));
      }
      pos = (((pos | 0) + 1) | 0);
    }
    if (isAfterSeparator) this.report(6188, (((pos | 0) - 1) | 0), pos);
    return pos;
  }

  /** `scanIdentifierParts`: the end of what goes on a name at `pos`. */
  private endOfIdentifierParts(pos0: number): number {
    const n = this.len;
    let pos = pos0 | 0;
    while (true) {
      let len = 0;
      let c = 0;
      if (at(this.src, n, pos) === 92) {
        if (this.unicodeEscape((((pos | 0) + 1) | 0))) {
          c = ESC[0] | 0;
          len = ((ESC[1] | 0) - pos) | 0;
        }
      } else {
        len = decode(this.src, pos, n);
        if (len > 0) c = DEC[0] | 0;
      }
      if (len > 0 && isIdentifierPart(c)) pos = (((pos | 0) + (len | 0)) | 0);
      else return pos;
    }
  }

  /** `scanNumber`, and the `0x`, `0b` and `0o` of `Scan`, for what `unusualNumber` refuses. */
  private invalidNumber(start: number): void {
    if (!this.recovers) {
      this.refuse(R_UNUSUAL_NUMBER);
      return;
    }
    const digits = new Bytes(32);
    const end = this.numberWithErrors(start, digits);
    this.set(this.tmpToken, start, end);
  }

  private digitsNumber(digits: Bytes): number {
    let s = "";
    for (let i = 0; i < digits.len; i++) s += String.fromCharCode(digits.data[i] | 0);
    const v = parseFloat(s);
    return v;
  }

  /** The end; the token is in `tmpToken`. `digits`: empty, to work in. */
  private numberWithErrors(start: number, digits: Bytes): number {
    const n = this.len;
    const a = at(this.src, n, start);
    const b = at(this.src, n, start + 1);
    let radix = 10;
    if (a === 48 && (b === 120 || b === 88)) radix = 16;
    else if (a === 48 && (b === 98 || b === 66)) radix = 2;
    else if (a === 48 && (b === 111 || b === 79)) radix = 8;
    if (radix !== 10) {
      const end = this.digitsAndSeparators((((start | 0) + 2) | 0), radix, digits);
      if (digits.len === 0) {
        this.report(radix === 16 ? 1125 : radix === 2 ? 1177 : 1178, end, end);
        digits.push(48);
      }
      // `scanBigIntSuffix`. Whatever follows is the next token.
      if (at(this.src, n, end) === 110) {
        const tmp = this.buffer;
        tmp.reset();
        let s = radix === 16 ? "0x" : radix === 8 ? "0o" : "0b";
        for (let i = 0; i < digits.len; i++) s += String.fromCharCode(digits.data[i] | 0);
        tmp.appendAscii(BigInt(s).toString());
        this.atom = this.names.atomOfBytes(tmp.data, 0, tmp.len);
        this.tmpToken = T_BIG_INT;
        return (((end | 0) + 1) | 0);
      }
      let s = radix === 16 ? "0x" : radix === 8 ? "0o" : "0b";
      for (let i = 0; i < digits.len; i++) s += String.fromCharCode(digits.data[i] | 0);
      this.number = Number(s);
      this.tmpToken = T_NUMBER;
      return end;
    }
    let end = 0;
    let hasLeadingZero = false;
    if (a === 48 && b === 95) {
      this.report(6188, (((start | 0) + 1) | 0), (((start | 0) + 2) | 0));
      end = this.digitsAndSeparators(start, 10, digits);
    } else if (a === 48 && isDigit(b)) {
      // `scanDigits`
      end = (((start | 0) + 1) | 0);
      while (isDigit(at(this.src, n, end))) end = (((end | 0) + 1) | 0);
      let allOctal = true;
      for (let i = start + 1; i < end; i++) {
        const d = this.src[i] | 0;
        if (d < 48 || d > 55) {
          allOctal = false;
          break;
        }
      }
      if (allOctal) {
        let value = 0;
        for (let i = start + 1; i < end; i++) value = value * 8 + ((this.src[i] | 0) - 48);
        this.number = value;
        // After a `-`, whatever is between them, the error starts one byte earlier.
        const from = this.token === T_MINUS ? Math.max(start - 1, 0) : start;
        // The digits without the leading zeros are `value.toString(8)`; only recovery reads the argument.
        if (this.recovers) {
          let z = (((start | 0) + 1) | 0);
          while (z < end - 1 && (this.src[z] | 0) === 48) z = (((z | 0) + 1) | 0);
          this.reportWithArg(1121, from, end, (this.token === T_MINUS ? "-" : "") + "0o" + this.textBetween(z, end));
        } else {
          this.report(1121, from, end);
        }
        this.tmpToken = T_NUMBER;
        return end;
      }
      hasLeadingZero = true;
      digits.append(this.src, (((start | 0) + 1) | 0), end);
    } else {
      end = this.digitsAndSeparators(start, 10, digits);
    }
    const endOfFixedPart = end;
    if (at(this.src, n, end) === 46) {
      digits.push(46);
      end = this.digitsAndSeparators((((end | 0) + 1) | 0), 10, digits);
    }
    const e = at(this.src, n, end);
    const isScientific = e === 101 || e === 69;
    if (isScientific) {
      const mantissa = digits.len;
      digits.push(101);
      end = (((end | 0) + 1) | 0);
      const sign = at(this.src, n, end);
      if (sign === 43 || sign === 45) {
        digits.push(sign);
        end = (((end | 0) + 1) | 0);
      }
      const preamble = digits.len;
      end = this.digitsAndSeparators(end, 10, digits);
      if (digits.len === preamble) {
        // "Digit expected."
        this.report(1124, end, end);
        digits.len = mantissa;
      }
    }
    this.number = this.digitsNumber(digits);
    if (hasLeadingZero) {
      // Neither an `n` nor what follows is looked at.
      this.report(1489, start, end);
      this.tmpToken = T_NUMBER;
      return end;
    }
    let token = T_NUMBER;
    if (endOfFixedPart === end && at(this.src, n, end) === 110) {
      // `scanBigIntSuffix`, `ParsePseudoBigInt`
      let zeros = 0;
      while (zeros < digits.len && (digits.data[zeros] | 0) === 48) zeros = (((zeros | 0) + 1) | 0);
      if (zeros > digits.len - 1) zeros = Math.max(digits.len - 1, 0);
      const tmp = this.buffer;
      tmp.reset();
      tmp.append(digits.data, zeros, digits.len);
      this.atom = this.names.atomOfBytes(tmp.data, 0, tmp.len);
      token = T_BIG_INT;
      end = (((end | 0) + 1) | 0);
    }
    const flen = decode(this.src, end, n);
    const isBeforeName = flen > 0 && isIdentifierStart(DEC[0] | 0);
    if (!isBeforeName) {
      this.tmpToken = token;
      return end;
    }
    const endOfName = this.endOfIdentifierParts(end);
    if (token !== T_BIG_INT && endOfName === end + 1 && (this.src[end] | 0) === 110) {
      // The `n` is part of the token.
      if (isScientific) {
        this.report(1352, start, endOfName);
        this.tmpToken = token;
        return endOfName;
      }
      if (endOfFixedPart < end) {
        this.report(1353, start, endOfName);
        this.tmpToken = token;
        return endOfName;
      }
    }
    // The name is the next token.
    this.report(1351, end, endOfName);
    this.tmpToken = token;
    return end;
  }

  // ───────────────────────────── what the parser asks for ─────────────────────────────

  /** `ReScanGreaterThanToken`: the token is a `>`. */
  rescanGreaterThan(): void {
    const n = this.len;
    const pos = this.start;
    const c1 = at(this.src, n, pos + 1);
    const c2 = at(this.src, n, pos + 2);
    const c3 = at(this.src, n, pos + 3);
    let token = 0;
    let len = 0;
    if (c1 === 62 && c2 === 62 && c3 === 61) {
      token = T_GREATER_THAN_GREATER_THAN_GREATER_THAN_EQUALS;
      len = 4;
    } else if (c1 === 62 && c2 === 62) {
      token = T_GREATER_THAN_GREATER_THAN_GREATER_THAN;
      len = 3;
    } else if (c1 === 62 && c2 === 61) {
      token = T_GREATER_THAN_GREATER_THAN_EQUALS;
      len = 3;
    } else if (c1 === 62) {
      token = T_GREATER_THAN_GREATER_THAN;
      len = 2;
    } else if (c1 === 61) {
      token = T_GREATER_THAN_EQUALS;
      len = 2;
    } else return;
    this.token = token;
    this.end = (((pos | 0) + (len | 0)) | 0);
  }

  /** `ReScanSlashToken`: the token is a `/` or a `/=` where an expression starts. */
  rescanSlash(): void {
    const n = this.len | 0;
    const start = this.start;
    let pos = (((start | 0) + 1) | 0);
    let isInClass = false;
    while (true) {
      if (pos >= n) {
        this.unterminatedRegex(pos);
        return;
      }
      const c = this.src[pos] | 0;
      if (c === 10 || c === 13) {
        this.unterminatedRegex(pos);
        return;
      }
      if (c === 47 && !isInClass) break;
      if (c === 91) isInClass = true;
      else if (c === 93) isInClass = false;
      else if (c === 92) {
        const c1 = at(this.src, n, pos + 1);
        if (pos + 1 >= n || c1 === 10 || c1 === 13) {
          this.unterminatedRegex((((pos | 0) + 1) | 0));
          return;
        }
        // What follows is looked at as if it stood alone, unless it is one byte.
        if (c1 < 0x80) pos = (((pos | 0) + 1) | 0);
      } else if (c === 0xe2 && this.isTypescript5) {
        // The scanner of TypeScript 7 reads bytes here: only "\n" and "\r" end a line.
        if ((this.src[pos + 1] | 0) === 0x80 && pos + 2 < n && ((this.src[pos + 2] | 0) === 0xa8 || (this.src[pos + 2] | 0) === 0xa9)) {
          this.unterminatedRegex(pos);
          return;
        }
      }
      pos = (((pos | 0) + 1) | 0);
    }
    pos = (((pos | 0) + 1) | 0);
    // The flags: whatever can be part of a name.
    while (pos < n) {
      const c = this.src[pos] | 0;
      if ((NAME_BYTE[c] | 0) !== 0) {
        pos = (((pos | 0) + 1) | 0);
      } else if (c >= 0x80) {
        const len = decode(this.src, pos, n);
        if (len === 0) {
          if (this.recovers) break;
          this.refuse(R_NOT_UTF8);
          return;
        }
        if (isIdentifierPart(DEC[0] | 0)) pos = (((pos | 0) + (len | 0)) | 0);
        else break;
      } else break;
    }
    if (!this.recovers && !isUtf8(this.src, start, pos)) {
      this.refuse(R_NOT_UTF8);
      return;
    }
    this.set(T_REGEX, start, pos);
  }

  /** `ReScanSlashToken`, for a regular expression whose line ends at `endOfLine`. */
  private unterminatedRegex(endOfLine: number): void {
    if (!this.recovers) {
      this.refuse(R_UNTERMINATED);
      return;
    }
    const start = this.start;
    // "Search for the nearest unbalanced bracket for better recovery."
    let isInEscape = false;
    let isInQuantifier = false;
    let classes = 0;
    let groups = 0;
    let end = (((start | 0) + 1) | 0);
    const stop = Math.min(endOfLine, this.len);
    for (; end < stop; end = (((end | 0) + 1) | 0)) {
      const c = this.src[end] | 0;
      if (isInEscape) {
        isInEscape = false;
      } else if (c === 92) isInEscape = true;
      else if (c === 91) classes = (((classes | 0) + 1) | 0);
      else if (c === 93 && classes !== 0) classes = (((classes | 0) - 1) | 0);
      else if (classes !== 0) {
        // inside a class
      } else if (c === 123) isInQuantifier = true;
      else if (c === 125 && isInQuantifier) isInQuantifier = false;
      else if (isInQuantifier) {
        // inside a quantifier
      } else if (c === 40) groups = (((groups | 0) + 1) | 0);
      else if (c === 41 && groups !== 0) groups = (((groups | 0) - 1) | 0);
      else if (c === 41 || c === 93 || c === 125) break;
    }
    // "Whitespaces and semicolons at the end are not likely to be part of the regex"
    while (end > start + 1) {
      const len = decodeLast(this.src, end);
      if (len > 0 && (isWhiteSpaceLike(DEC[0] | 0) || (DEC[0] | 0) === 59)) end = (((end | 0) - (len | 0)) | 0);
      else break;
    }
    this.report(1161, start, end);
    this.set(T_REGEX, start, end);
  }

  // ───────────────────────────── JSX ─────────────────────────────

  /** `ScanJsxIdentifier`: the token is a name or a keyword, which goes on through `-`. */
  scanJsxIdentifier(): void {
    if (!isIdentifierOrKeyword(this.token) || this.token === T_PRIVATE_IDENTIFIER) return;
    const n = this.len;
    let end = this.end;
    if (at(this.src, n, end) === 45) {
      while (end < n && ((NAME_BYTE[this.src[end] | 0] | 0) !== 0 || (this.src[end] | 0) === 45)) end = (((end | 0) + 1) | 0);
      const c = at(this.src, n, end);
      if (c === 92 || c >= 0x80) {
        this.refuse(R_UNSUPPORTED);
        return;
      }
      this.atom = this.names.atomOfSourceRange(this.start, end);
      this.end = end;
    }
    this.token = T_IDENTIFIER;
  }

  /** `ScanJsxAttributeValue`: scans the token after the `=` of an attribute. A string has no escapes; its value is the text between the quotes. */
  scanJsxAttributeValue(): void {
    const before = this.end;
    // A string with a line break in it is refused as a string of JavaScript.
    const hadRefused = this.refusal;
    this.next();
    const n = this.len;
    let start = 0;
    if (this.refusal === hadRefused) {
      if (this.token !== T_STRING) return;
      // It is the same string here as in JavaScript.
      if (this.plainString === this.start && this.flagged.len === 0 && this.errors.len === 0) return;
      start = this.start;
    } else {
      if (this.recovers) return;
      // It is scanned again from the quote.
      this.refusal = hadRefused;
      let pos = before;
      while (true) {
        const c = at(this.src, n, pos);
        const c1 = at(this.src, n, pos + 1);
        if (c === 32 || c === 9 || c === 10 || c === 13) pos = (((pos | 0) + 1) | 0);
        else if (c === 47 && c1 === 47 && this.skipsCommentsBeforeJsxStrings()) pos = this.endOfLine(pos);
        else if (c === 47 && c1 === 42 && this.skipsCommentsBeforeJsxStrings()) {
          let q = (((pos | 0) + 2) | 0);
          let found = -1;
          while (q + 1 < n) {
            if ((this.src[q] | 0) === 42 && (this.src[q + 1] | 0) === 47) {
              found = q;
              break;
            }
            q = (((q | 0) + 1) | 0);
          }
          if (found < 0) break;
          pos = (((found | 0) + 2) | 0);
        } else break;
      }
      const q = at(this.src, n, pos);
      if (q !== 34 && q !== 39) {
        this.refuse(R_UNSUPPORTED);
        return;
      }
      // There it is a string of JavaScript, and refused as one.
      if (pos > before && this.scansJsxStringsAsTypescript5()) {
        this.refuse(R_UNTERMINATED);
        return;
      }
      start = pos;
    }
    // What looked like an escape is none.
    this.forgetFlaggedFrom(start);
    if (this.errors.len > 0 && this.isStringOfJavascript(before, start)) return;
    const quote = this.src[start] | 0;
    let close = (((start | 0) + 1) | 0);
    while (close < n && (this.src[close] | 0) !== quote) close = (((close | 0) + 1) | 0);
    if (close >= n) {
      this.unterminatedJsxString(before, start);
      return;
    }
    let hasBackslash = false;
    for (let i = start + 1; i < close; i++) {
      if ((this.src[i] | 0) === 92) hasBackslash = true;
    }
    if (!this.recovers && !isUtf8(this.src, (((start | 0) + 1) | 0), close)) {
      this.refuse(R_NOT_UTF8);
      return;
    }
    if (start !== before && hasBackslash && this.isStringWithEscapes(before, start)) return;
    this.atom = this.names.atomOfSourceRange((((start | 0) + 1) | 0), close);
    this.set(T_STRING, start, (((close | 0) + 1) | 0));
  }

  /** Whether the string at `start`, which has a backslash, stays as `next` has scanned it. */
  private isStringWithEscapes(before: number, start: number): boolean {
    if (!this.recovers) {
      this.refuse(R_UNSUPPORTED);
      return true;
    }
    return this.isStringOfJavascript(before, start);
  }

  /** For `scanJsxAttributeValue` of TypeScript 5 and 6 (typescript-estree), blanks before the quote leave the string to `scan`. */
  private scansJsxStringsAsTypescript5(): boolean {
    return this.isTypescript5 && !this.isEcmascript && !this.isBabel && !this.isOxc;
  }

  /** acorn, Babel and oxc skip a comment between the `=` and the quote, like anywhere else. */
  private skipsCommentsBeforeJsxStrings(): boolean {
    return this.isEcmascript || this.isOxc;
  }

  /** `ScanJsxAttributeValue`: whether `Scan` scans the string at `start`, after a comment. */
  private isStringOfJavascript(before: number, start: number): boolean {
    let pos = before;
    while (pos < start) {
      const len = decode(this.src, pos, start);
      if (len > 0 && isWhiteSpaceLike(DEC[0] | 0)) pos = (((pos | 0) + (len | 0)) | 0);
      else break;
    }
    if ((pos < start && !this.skipsCommentsBeforeJsxStrings()) || (before < start && this.scansJsxStringsAsTypescript5())) {
      return true;
    }
    this.forgetErrorsFrom(before);
    return false;
  }

  /** `scanString(true)`, for the string at `start` that goes to the end of the text. */
  private unterminatedJsxString(before: number, start: number): void {
    const end = this.len;
    if (!this.error(R_UNTERMINATED, 1002, end, end)) return;
    // It is of the scan that began at `before`, and a mark at the string is after that.
    if (this.origins.len > 0) this.origins.data[this.origins.len - 1] = before;
    this.atom = this.names.atomOfSourceRange((((start | 0) + 1) | 0), end);
    this.set(T_STRING, start, end);
  }

  /**
   * `ScanJsxToken`: scans a child of an element, from the end of the token. Text that is nothing but blanks and has a line
   * break is no child.
   */
  nextJsxChild(): void {
    const n = this.len | 0;
    this.fullStart = this.end;
    let newlineBefore = false;
    let start = this.end | 0;
    while (true) {
      const c = at(this.src, n, start);
      if (start >= n) {
        this.newlineBefore = newlineBefore;
        this.set(T_EOF, n, n);
        return;
      }
      if (c === 123) {
        this.newlineBefore = newlineBefore;
        this.set(T_OPEN_BRACE, start, (((start | 0) + 1) | 0));
        return;
      }
      if (c === 60) {
        this.newlineBefore = newlineBefore;
        if (at(this.src, n, start + 1) === 47 && !this.isEcmascript && !this.isOxc) this.set(T_LESS_THAN_SLASH, start, (((start | 0) + 2) | 0));
        else this.set(T_LESS_THAN, start, (((start | 0) + 1) | 0));
        return;
      }
      // Between two elements there is mostly a line break and the indentation.
      let end = start;
      let hasLineBreak = false;
      while (end < n) {
        const x = this.src[end] | 0;
        if (x === 10 || x === 13) hasLineBreak = true;
        else if (x !== 32 && x !== 9) break;
        end = (((end | 0) + 1) | 0);
      }
      let isAll = false;
      if (end >= n) isAll = true;
      else {
        const x = this.src[end] | 0;
        if (x === 123) isAll = true;
        // Not what may be a conflict marker.
        else if (x === 60) isAll = at(this.src, n, end + 1) !== 60;
      }
      if (isAll && hasLineBreak) {
        newlineBefore = true;
        start = end;
        continue;
      }
      let len = start;
      while (len < n) {
        const x = this.src[len] | 0;
        if (x === 123 || x === 60) break;
        len = (((len | 0) + 1) | 0);
      }
      // Each is an error, and stays text.
      let hasCloser = false;
      let needsFixing = false;
      for (let i = start; i < len; i++) {
        const x = this.src[i] | 0;
        if (x === 62 || x === 125) hasCloser = true;
        if (x === 38 || x === 10 || x === 13 || x >= 0x80) needsFixing = true;
      }
      if (hasCloser && !this.closersInJsxText(start, len)) return;
      if (at(this.src, n, len) === 60 && at(this.src, n, len + 1) === 60 && this.conflictMarkerInJsx(len)) return;
      this.newlineBefore = newlineBefore;
      if (!isUtf8(this.src, start, len)) {
        this.jsxTextOfBytes(start, len);
        return;
      }
      if (!needsFixing) {
        this.atom = this.names.atomOfSourceRange(start, len);
        this.set(T_JSX_TEXT, start, len);
        return;
      }
      const out = this.jsxBuffer;
      out.reset();
      fixWhitespaceAndDecodeJsxEntities(this.src, start, len, out);
      if (out.len === 0) {
        newlineBefore = true;
        start = len;
        continue;
      }
      this.atom = this.names.atomOfBytes(out.data, 0, out.len);
      this.set(T_JSX_TEXT, start, len);
      return;
    }
  }

  /** `ScanJsxTokenEx`: reports each `>` and `}` of the text from `start` to `end`. Returns whether the scanner goes on. */
  private closersInJsxText(start: number, end: number): boolean {
    if (!this.recovers) {
      this.refuse(R_REPORTED);
      return false;
    }
    for (let at_ = start; at_ < end; at_++) {
      const c = this.src[at_] | 0;
      if (c === 62) this.report(1382, at_, (((at_ | 0) + 1) | 0));
      else if (c === 125) this.report(1381, at_, (((at_ | 0) + 1) | 0));
    }
    return true;
  }

  /** `ScanJsxTokenEx`: whether a conflict marker ends JSX text at `pos`. They are one token. */
  private conflictMarkerInJsx(pos: number): boolean {
    if (!this.isConflictMarker(pos)) return false;
    if (!this.recovers) {
      this.refuse(R_CONFLICT_MARKER);
      return true;
    }
    const end = this.conflictMarker(pos);
    // `newlineBefore` stays that of the token before, as `tokenFlags` does.
    this.set(T_CONFLICT_MARKER, this.fullStart, end);
    return true;
  }

  /** The JSX text from `start` to `end`, which is not UTF-8. */
  private jsxTextOfBytes(start: number, end: number): void {
    if (!this.recovers) {
      this.refuse(R_NOT_UTF8);
      return;
    }
    // Each byte that is not UTF-8 is U+FFFD (Go).
    const tmp = new Bytes(end - start + 16);
    let p = start;
    while (p < end) {
      const len = decode(this.src, p, end);
      if (len === 0) {
        tmp.pushCodepointWtf8(0xfffd);
        p = (((p | 0) + 1) | 0);
      } else {
        tmp.append(this.src, p, (((p | 0) + (len | 0)) | 0));
        p = (((p | 0) + (len | 0)) | 0);
      }
    }
    const out = this.jsxBuffer;
    out.reset();
    fixWhitespaceAndDecodeJsxEntities(tmp.data, 0, tmp.len, out);
    this.atom = this.names.atomOfBytes(out.data, 0, out.len);
    this.set(T_JSX_TEXT, start, end);
  }
}

/**
 * The value of the JSX text `text[start, end)` (valid UTF-8): lines are trimmed and joined by a blank, lines of blanks are
 * dropped, and entities are decoded. Appends to `out`.
 */
export function fixWhitespaceAndDecodeJsxEntities(text: Uint8Array, start: number, end: number, out: Bytes): void {
  let afterLast = -1;
  // The blanks at the start of the first line stay.
  let first = start;
  let p = start;
  while (p < end) {
    const b = text[p] | 0;
    let len = 1;
    let isLineBreak = false;
    let isBlank = false;
    if (b >= 33 && b <= 126) {
      // not blank
    } else if (b === 32 || b === 9) {
      isBlank = true;
    } else {
      len = decode(text, p, end);
      if (len === 0) len = 1;
      const c = len === 1 ? b : DEC[0] | 0;
      isLineBreak = isJsLineTerminator(c);
      isBlank = isWhiteSpaceSingleLine(c);
    }
    if (isLineBreak) {
      if (first >= 0 && afterLast >= 0) {
        if (out.len > 0) out.push(32);
        decodeJsxEntities(text, first, afterLast, out);
      }
      first = -1;
    } else if (!isBlank) {
      afterLast = (((p | 0) + (len | 0)) | 0);
      if (first < 0) first = p;
    }
    p = (((p | 0) + (len | 0)) | 0);
  }
  // So do those at the end of the last line.
  if (first >= 0) {
    if (out.len > 0) out.push(32);
    decodeJsxEntities(text, first, end, out);
  }
}

function jsxEntityTable(): Map<string, number> {
  let m = jsxEntities;
  if (m === null) {
    m = new Map<string, number>();
    for (let i = 0; i < JSX_ENTITY_NAMES.length; i++) m.set(JSX_ENTITY_NAMES[i], JSX_ENTITY_CODES[i]);
    jsxEntities = m;
  }
  return m;
}

/** The code point of the digits text[start,end) in `radix`, or 0xFFFD (`parse_entity_number`). */
function parseEntityNumber(text: Uint8Array, start: number, end: number, radix: number): number {
  if (end <= start) return 0xfffd;
  let v = 0;
  for (let i = start; i < end; i++) {
    const d = digitValue(text[i] | 0, radix);
    if (d < 0) return 0xfffd;
    v = v * radix + d;
    if (v > 0x7fffffff) return 0xfffd;
  }
  return v <= 0x10ffff ? v : 0xfffd;
}

function decodeJsxEntities(text: Uint8Array, start: number, end: number, out: Bytes): void {
  let p = start;
  while (true) {
    let amp = p;
    while (amp < end && (text[amp] | 0) !== 38) amp = (((amp | 0) + 1) | 0);
    if (amp >= end) break;
    out.append(text, p, amp);
    p = (((amp | 0) + 1) | 0);
    let semi = p;
    while (semi < end && (text[semi] | 0) !== 59) semi = (((semi | 0) + 1) | 0);
    let c = -1;
    if (semi < end && semi > p) {
      if ((text[p] | 0) === 35) {
        if ((text[p + 1] | 0) === 120 && semi - (p + 1) > 1) c = parseEntityNumber(text, (((p | 0) + 2) | 0), semi, 16);
        else c = parseEntityNumber(text, (((p | 0) + 1) | 0), semi, 10);
      } else {
        let s = "";
        for (let i = p; i < semi; i++) s += String.fromCharCode(text[i] | 0);
        const v = jsxEntityTable().get(s);
        if (v !== undefined) c = v;
      }
    }
    if (c >= 0) {
      out.pushCodepointWtf8(c);
      p = (((semi | 0) + 1) | 0);
    } else {
      out.push(38);
    }
  }
  out.append(text, p, end);
}
