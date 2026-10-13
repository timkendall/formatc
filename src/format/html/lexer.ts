// Port of vendor/bun/src/format/html/lexer.rs: `angular-html-parser` 10.12 `ml_parser/lexer.ts`, without the syntax that Prettier does not turn on.
//
// The text has `\n` only. What a token says is a part of the text, so a token has ranges of it.
//
// Rust's `Result<(), Fail>` is a thrown number here (`FAIL_PARSE`, `FAIL_CURSOR`): it is thrown only for text that has a syntax error
// (and caught in `tokenize` and `consumeTagOpen`), never on the path of a text without one.
import { lookupEntity } from "../../md/entity.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { jsWhitespaceLen, jsWhitespaceLenBack } from "../text.ts";
import {
  CT_ESCAPABLE_RAW_TEXT,
  CT_PARSABLE_DATA,
  CT_RAW_TEXT,
  eqLit,
  eqLitIgnoreCase,
  tagDefinition,
  defContentType,
} from "./data.ts";
import {
  EK_DECIMAL_ENTITY_WITHOUT_SEMICOLON,
  EK_HEXADECIMAL_ENTITY_WITHOUT_SEMICOLON,
  EK_OTHER,
  EK_UNEXPECTED_CHARACTER,
  EK_UNKNOWN_ENTITY,
  ErrorList,
} from "./error.ts";

// TokenType
export const TT_TAG_OPEN_START: number = 0;
export const TT_TAG_OPEN_END: number = 1;
export const TT_TAG_OPEN_END_VOID: number = 2;
export const TT_TAG_CLOSE: number = 3;
export const TT_INCOMPLETE_TAG_OPEN: number = 4;
export const TT_TEXT: number = 5;
export const TT_ESCAPABLE_RAW_TEXT: number = 6;
export const TT_RAW_TEXT: number = 7;
export const TT_INTERPOLATION: number = 8;
export const TT_ENCODED_ENTITY: number = 9;
export const TT_COMMENT_START: number = 10;
export const TT_COMMENT_END: number = 11;
export const TT_IN_ELEMENT_COMMENT: number = 12;
export const TT_CDATA_START: number = 13;
export const TT_CDATA_END: number = 14;
export const TT_ATTR_NAME: number = 15;
export const TT_ATTR_QUOTE: number = 16;
export const TT_ATTR_VALUE_TEXT: number = 17;
export const TT_ATTR_VALUE_INTERPOLATION: number = 18;
export const TT_DOC_TYPE_START: number = 19;
export const TT_DOC_TYPE_END: number = 20;
export const TT_EXPANSION_FORM_START: number = 21;
export const TT_EXPANSION_CASE_VALUE: number = 22;
export const TT_EXPANSION_CASE_EXP_START: number = 23;
export const TT_EXPANSION_CASE_EXP_END: number = 24;
export const TT_EXPANSION_FORM_END: number = 25;
export const TT_BLOCK_OPEN_START: number = 26;
export const TT_BLOCK_OPEN_END: number = 27;
export const TT_BLOCK_CLOSE: number = 28;
export const TT_BLOCK_PARAMETER: number = 29;
export const TT_INCOMPLETE_BLOCK_OPEN: number = 30;
export const TT_LET_START: number = 31;
export const TT_LET_VALUE: number = 32;
export const TT_LET_END: number = 33;
export const TT_INCOMPLETE_LET: number = 34;
export const TT_EOF: number = 35;

// `Parts`, where it is not all of the text of the token.
/** None, or the text of the token. */
export const PK_NONE: number = 0;
/** The prefix `(p0, p1)` and the name `(p2, p3)` of a tag or an attribute. */
export const PK_NAME: number = 1;
/** The name of a block or a declaration, the value of a case: `(p0, p1)`. */
export const PK_VALUE: number = 2;
/** `else if`, however many blanks there are. */
export const PK_ELSE_IF: number = 3;
/** `default never`, however many blanks there are. */
export const PK_DEFAULT_NEVER: number = 4;
/** What is in a comment in a start tag `(p0, p1)`, and whether the comment ends with the line `p2`. */
export const PK_COMMENT: number = 5;

// The fields of a token.
export const TK_STRIDE: number = 8;
export const TKF_KIND: number = 0;
export const TKF_START: number = 1;
export const TKF_END: number = 2;
export const TKF_PK: number = 3;
export const TKF_P0: number = 4;
export const TKF_P1: number = 5;
export const TKF_P2: number = 6;
export const TKF_P3: number = 7;

/** `ContentType` is `CT_*` of data.ts. */

// How the parser decides that a tag has raw text (`shouldParseAsRawText`).
export const RAW_NONE: number = 0;
export const RAW_MJML: number = 1;
export const RAW_VUE: number = 2;

const FAIL_PARSE = 1;
const FAIL_CURSOR = 2;

// What ends a text with interpolations.
const END_TEXT = 0;
const END_TAG_START = 1;
const END_NAME = 2;
/** 256 + the quote. */
const END_QUOTE = 256;

// What ends a raw text.
const MARK_STR = 0;
const MARK_GREATER_THAN = 1;
const MARK_TAG_CLOSE = 2;

const SUPPORTED_BLOCKS: string[] = [
  "@if", "@else", "@for", "@switch", "@case", "@default", "@empty", "@defer", "@placeholder", "@loading", "@boundary", "@error", "@content",
];

/** A character that is not ASCII and not a no-break space. */
const OTHER = 0xffff;
const NBSP = 160;

function isWhitespace(code: number): boolean {
  return (code >= 9 && code <= 32) || code === NBSP;
}
function isNotWhitespace(code: number): boolean {
  return !isWhitespace(code) || code === 0;
}
function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}
function isNewLine(code: number): boolean {
  return code === 10 || code === 13;
}
function isQuote(code: number): boolean {
  return code === 39 || code === 34 || code === 96;
}
function isNameEnd(code: number): boolean {
  return isWhitespace(code) || code === 62 || code === 60 || code === 47 || code === 39 || code === 34 || code === 61 || code === 0;
}
function isPrefixEnd(code: number): boolean {
  return !isAsciiLetter(code) && !isDigit(code);
}
function isHexDigit(code: number): boolean {
  return isDigit(code) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
}
function isDigitEntityEnd(code: number): boolean {
  return code === 59 || code === 0 || !isHexDigit(code);
}
function isNamedEntityEnd(code: number): boolean {
  return code === 59 || code === 0 || !(isAsciiLetter(code) || isDigit(code));
}
function isBlockNameChar(code: number): boolean {
  return isAsciiLetter(code) || isDigit(code) || code === 95;
}
function isBlockParameterChar(code: number): boolean {
  return code !== 59 && isNotWhitespace(code);
}
function isAttributeTerminator(code: number): boolean {
  return code === 47 || code === 62 || code === 60 || code === 0;
}

export class Lexer {
  /** The text, and where it ends (the text of the pool is longer than what is lexed). */
  text: Uint8Array;
  len: number;
  /** `_cursor` */
  pos: number;
  // Options
  tokenizeAngularBlocks: boolean;
  tokenizeLet: boolean;
  canSelfClose: boolean;
  allowHtmComponentClosingTags: boolean;
  allowStartTagComments: boolean;
  // `getTagContentType`
  rawMode: number;
  isCaseSensitive: boolean;
  /** `_currentTokenStart` and `_currentTokenType` */
  hasCurrent: boolean;
  currentStart: number;
  currentKind: number;
  expansionCaseStack: I32Vec;
  /** The prefixes and the names: four numbers each. */
  fullNameStack: I32Vec;
  /** Of the start tag that is being read: the name `(s, e)` and the last piece of the value `(s, e)`, -1: no value. */
  attrs: I32Vec;
  tokens: Int32Array;
  tokenCount: number;
  errors: ErrorList;
  /** What the last `Fail::Parse` is about: its kind, where what it names is, `_isInExpansionForm()`. */
  thrownKind: number;
  thrownNameS: number;
  thrownNameE: number;
  thrownExpansion: boolean;
  /** Where the last failure was. */
  failAt: number;
  /** `open_token` of `consume_tag_open`. */
  openToken: number;
  lower: Uint8Array;

  constructor() {
    this.text = new Uint8Array(0);
    this.len = 0;
    this.pos = 0;
    this.tokenizeAngularBlocks = false;
    this.tokenizeLet = false;
    this.canSelfClose = false;
    this.allowHtmComponentClosingTags = false;
    this.allowStartTagComments = false;
    this.rawMode = RAW_NONE;
    this.isCaseSensitive = false;
    this.hasCurrent = false;
    this.currentStart = 0;
    this.currentKind = 0;
    this.expansionCaseStack = new I32Vec(8);
    this.fullNameStack = new I32Vec(16);
    this.attrs = new I32Vec(16);
    this.tokens = new Int32Array(TK_STRIDE * 256);
    this.tokenCount = 0;
    this.errors = new ErrorList();
    this.thrownKind = EK_OTHER;
    this.thrownNameS = 0;
    this.thrownNameE = 0;
    this.thrownExpansion = false;
    this.failAt = 0;
    this.openToken = -1;
    this.lower = new Uint8Array(64);
  }

  // ───────────────────────────── characters ─────────────────────────────

  peekAt(pos: number): number {
    if (pos >= this.len) return 0;
    const b = this.text[pos] | 0;
    if (b < 128) return b;
    if (b === 0xc2 && pos + 1 < this.len && (this.text[pos + 1] | 0) === 0xa0) return NBSP;
    return OTHER;
  }

  peek(): number {
    return this.peekAt(this.pos);
  }

  advance(): void {
    if (this.pos >= this.len) {
      this.failAt = this.pos;
      throw FAIL_CURSOR;
    }
    this.pos = this.pos + (this.peek() === NBSP ? 2 : 1);
  }

  // ───────────────────────────── tokens ─────────────────────────────

  beginToken(kind: number): void {
    this.hasCurrent = true;
    this.currentStart = this.pos;
    this.currentKind = kind;
  }

  beginTokenAt(kind: number, start: number): void {
    this.hasCurrent = true;
    this.currentStart = start;
    this.currentKind = kind;
  }

  /** Returns the index of the token. */
  endTokenAt(pk: number, p0: number, p1: number, p2: number, p3: number, end: number): number {
    if (!this.hasCurrent) {
      this.errorOf(EK_OTHER, end, 0, 0);
    }
    this.hasCurrent = false;
    const idx = this.tokenCount;
    const i = idx * TK_STRIDE;
    if (i + TK_STRIDE > this.tokens.length) {
      const nt = new Int32Array(this.tokens.length * 2);
      nt.set(this.tokens);
      this.tokens = nt;
    }
    const t = this.tokens;
    t[i + TKF_KIND] = this.currentKind | 0;
    t[i + TKF_START] = this.currentStart | 0;
    t[i + TKF_END] = end | 0;
    t[i + TKF_PK] = pk | 0;
    t[i + TKF_P0] = p0 | 0;
    t[i + TKF_P1] = p1 | 0;
    t[i + TKF_P2] = p2 | 0;
    t[i + TKF_P3] = p3 | 0;
    this.tokenCount = idx + 1;
    return idx;
  }

  endTokenNone(): number {
    return this.endTokenAt(PK_NONE, 0, 0, 0, 0, this.pos);
  }

  /** `_createError(_unexpectedCharacterErrorMsg(this._cursor.peek()), this._cursor.getSpan(start))` */
  error(start: number): number {
    return this.errorOf(EK_UNEXPECTED_CHARACTER, start, this.pos, this.len);
  }

  /** `_createError`. `named`: where what the message names is. Throws. */
  errorOf(kind: number, start: number, namedS: number, namedE: number): number {
    this.hasCurrent = false;
    this.thrownKind = kind;
    this.thrownNameS = namedS;
    this.thrownNameE = namedE;
    this.thrownExpansion = this.isInExpansionForm();
    this.failAt = start;
    throw FAIL_PARSE;
  }

  /** `handleError` */
  handleError(at: number, kind: number, namedS: number, namedE: number, inExpansionForm: boolean): void {
    let s = namedS;
    let e = namedE;
    // `named.of(text)`: nothing if it is not in the text.
    if (s > e || e > this.len) {
      s = 0;
      e = 0;
    }
    this.errors.push(at, kind, 0, 0, s, e, inExpansionForm);
  }

  // ───────────────────────────── cursor ─────────────────────────────

  attemptCharCode(code: number): boolean {
    if (this.peek() === code && this.pos < this.len) {
      this.pos = this.pos + 1;
      return true;
    }
    return false;
  }

  requireCharCode(code: number): void {
    if (!this.attemptCharCode(code)) this.error(this.pos);
  }

  peekStr(chars: string): boolean {
    const n = chars.length;
    if (this.pos + n > this.len) return false;
    const text = this.text;
    const pos = this.pos;
    for (let i = 0; i < n; i++) {
      if ((text[pos + i] | 0) !== chars.charCodeAt(i)) return false;
    }
    return true;
  }

  attemptStr(chars: string): boolean {
    const is = this.peekStr(chars);
    if (is) this.pos = this.pos + chars.length;
    return is;
  }

  /** What matches is consumed even if not all of it does. */
  attemptStrCaseInsensitive(chars: string): boolean {
    for (let i = 0; i < chars.length; i++) {
      if (this.pos >= this.len) return false;
      let b = this.text[this.pos] | 0;
      if (b >= 65 && b <= 90) b = b + 32;
      if (b !== chars.charCodeAt(i)) return false;
      this.pos = this.pos + 1;
    }
    return true;
  }

  requireStr(chars: string): void {
    if (!this.attemptStr(chars)) this.error(this.pos);
  }

  skipWhitespace(): void {
    for (;;) {
      const c = this.peek();
      if (isNotWhitespace(c)) return;
      this.pos = this.pos + (c === NBSP ? 2 : 1);
    }
  }

  isBlockStart(): boolean {
    if (this.peek() !== 64) return false;
    for (let i = 0; i < SUPPORTED_BLOCKS.length; i++) {
      if (this.peekStr(SUPPORTED_BLOCKS[i])) return true;
    }
    return false;
  }

  isLetStart(): boolean {
    return this.peekStr("@let");
  }

  isInExpansionCase(): boolean {
    const v = this.expansionCaseStack;
    return v.len > 0 && v.last() === TT_EXPANSION_CASE_EXP_START;
  }

  isInExpansionForm(): boolean {
    const v = this.expansionCaseStack;
    return v.len > 0 && v.last() === TT_EXPANSION_FORM_START;
  }

  isExpansionFormStart(): boolean {
    return this.peek() === 123 && !this.peekStr("{{");
  }

  isTagStart(): boolean {
    if (this.peek() !== 60) return false;
    const code = this.peekAt(this.pos + 1);
    return isAsciiLetter(code) || code === 47 || code === 33 || code === 63;
  }

  isTextEnd(): boolean {
    if (this.isTagStart() || this.peek() === 0) return true;
    if (!this.tokenizeAngularBlocks) return false;
    if (this.isExpansionFormStart() || (this.peek() === 125 && this.isInExpansionCase())) return true;
    return !this.isInExpansionCase() && !this.isInExpansionForm() && (this.isBlockStart() || this.isLetStart() || this.peek() === 125);
  }

  isEnd(end: number): boolean {
    if (end === END_TEXT) return this.isTextEnd();
    if (end === END_TAG_START) return this.isTagStart();
    if (end === END_NAME) return isNameEnd(this.peek());
    return this.peek() === end - END_QUOTE;
  }

  /** Goes on to the next character that can end a text that `end` ends, or start something in it. */
  skipPlainText(end: number): void {
    const text = this.text;
    const len = this.len;
    let pos = this.pos;
    if (end === END_TEXT) {
      if (this.tokenizeAngularBlocks) {
        while (pos < len) {
          const b = text[pos] | 0;
          if (b === 60 || b === 123 || b === 38 || b === 0 || b === 64 || b === 125) break;
          pos = pos + 1;
        }
      } else {
        while (pos < len) {
          const b = text[pos] | 0;
          if (b === 60 || b === 123 || b === 38 || b === 0) break;
          pos = pos + 1;
        }
      }
    } else if (end >= END_QUOTE) {
      const quote = end - END_QUOTE;
      while (pos < len) {
        const b = text[pos] | 0;
        if (b === quote || b === 123 || b === 38) break;
        pos = pos + 1;
      }
    } else {
      return;
    }
    this.pos = pos;
  }

  // ───────────────────────────── the loop ─────────────────────────────

  tokenize(): void {
    while (this.peek() !== 0) {
      const start = this.pos;
      try {
        this.tokenizeOne();
        if (this.pos === start) {
          // Nothing goes on from here.
          this.handleError(start, EK_OTHER, 0, 0, false);
          break;
        }
      } catch (e) {
        if (e === FAIL_PARSE) {
          this.handleError(this.failAt, this.thrownKind, this.thrownNameS, this.thrownNameE, this.thrownExpansion);
        } else if (e === FAIL_CURSOR) {
          this.hasCurrent = false;
          this.handleError(this.failAt, EK_UNEXPECTED_CHARACTER, this.len, this.len, this.isInExpansionForm());
        } else {
          throw e;
        }
      }
    }
    this.beginToken(TT_EOF);
    // `let _ = self.end_token(Parts::None)`
    this.endTokenAt(PK_NONE, 0, 0, 0, 0, this.pos);
  }

  tokenizeOne(): void {
    const start = this.pos;
    const blocks = this.tokenizeAngularBlocks;
    if (this.attemptCharCode(60)) {
      if (this.attemptCharCode(33)) {
        if (this.attemptStr("[CDATA[")) {
          this.consumeDelimited(start, TT_CDATA_START, TT_CDATA_END, MARK_STR, "]]>", 0, 0);
        } else if (this.attemptStr("--")) {
          this.consumeDelimited(start, TT_COMMENT_START, TT_COMMENT_END, MARK_STR, "-->", 0, 0);
        } else if (this.attemptStrCaseInsensitive("doctype")) {
          this.consumeDelimited(start, TT_DOC_TYPE_START, TT_DOC_TYPE_END, MARK_GREATER_THAN, "", 0, 0);
        } else {
          this.consumeDelimited(start, TT_COMMENT_START, TT_COMMENT_END, MARK_GREATER_THAN, "", 0, 0);
        }
      } else if (this.attemptCharCode(47)) {
        this.consumeTagClose(start);
      } else if (this.peek() === 63) {
        this.consumeDelimited(start, TT_COMMENT_START, TT_COMMENT_END, MARK_GREATER_THAN, "", 0, 0);
      } else {
        this.consumeTagOpen(start);
      }
    } else if (this.tokenizeLet && this.isLetStart()) {
      this.consumeLetDeclaration(start);
    } else if (blocks && this.isBlockStart()) {
      this.consumeBlockStart(start);
    } else if (blocks && !this.isInExpansionCase() && !this.isInExpansionForm() && this.attemptCharCode(125)) {
      this.beginTokenAt(TT_BLOCK_CLOSE, start);
      this.endTokenNone();
    } else if (!(blocks && this.tokenizeExpansionForm())) {
      this.consumeWithInterpolation(TT_TEXT, TT_INTERPOLATION, END_TEXT, END_TAG_START);
    }
  }

  // ───────────────────────────── blocks ─────────────────────────────

  /** `block_name`: the token parts into `bp*`. */
  bpKind: number = 0;
  bpS: number = 0;
  bpE: number = 0;

  blockName(): void {
    let spacesInNameAllowed = false;
    const start = this.pos;
    for (;;) {
      const code = this.peek();
      let stop: boolean;
      if (isWhitespace(code)) {
        stop = !spacesInNameAllowed;
      } else if (isBlockNameChar(code)) {
        spacesInNameAllowed = true;
        stop = false;
      } else {
        stop = true;
      }
      if (stop) break;
      this.advance();
    }
    // `trimmed`
    const text = this.text;
    let s = start;
    let e = this.pos;
    while (s < e) {
      const n = jsWhitespaceLen(text, s, e);
      if (n === 0) break;
      s = s + n;
    }
    while (e > s) {
      const n = jsWhitespaceLenBack(text, s, e);
      if (n === 0) break;
      e = e - n;
    }
    if (this.isTwoWords(s, e, "else", "if")) {
      this.bpKind = PK_ELSE_IF;
    } else if (this.isTwoWords(s, e, "default", "never")) {
      this.bpKind = PK_DEFAULT_NEVER;
    } else {
      this.bpKind = PK_VALUE;
    }
    this.bpS = s;
    this.bpE = e;
  }

  /** `/^a[^\S\r\n]+b/` */
  isTwoWords(s: number, e: number, first: string, second: string): boolean {
    const text = this.text;
    const n = first.length;
    if (e - s < n) return false;
    for (let i = 0; i < n; i++) {
      if ((text[s + i] | 0) !== first.charCodeAt(i)) return false;
    }
    let at = s + n;
    const before = at;
    for (;;) {
      if (at >= e) break;
      const b = text[at] | 0;
      if (b === 10 || b === 13) break;
      const len = jsWhitespaceLen(text, at, e);
      if (len === 0) break;
      at = at + len;
    }
    if (at === before) return false;
    // `rest.starts_with(second)`
    if (e - at < second.length) return false;
    for (let i = 0; i < second.length; i++) {
      if ((text[at + i] | 0) !== second.charCodeAt(i)) return false;
    }
    return true;
  }

  emptyToken(kind: number): void {
    this.beginToken(kind);
    this.endTokenNone();
  }

  consumeBlockStart(start: number): void {
    this.requireCharCode(64);
    this.beginTokenAt(TT_BLOCK_OPEN_START, start);
    this.blockName();
    const nameKind = this.bpKind;
    const nameS = this.bpS;
    const nameE = this.bpE;
    const startToken = this.endTokenAt(nameKind, nameS, nameE, 0, 0, this.pos);
    if (this.peek() === 40) {
      this.advance();
      this.consumeBlockParameters();
      this.skipWhitespace();
      if (this.attemptCharCode(41)) {
        this.skipWhitespace();
      } else {
        this.tokens[startToken * TK_STRIDE + TKF_KIND] = TT_INCOMPLETE_BLOCK_OPEN;
        return;
      }
    }
    if (nameKind === PK_DEFAULT_NEVER && this.attemptCharCode(59)) {
      this.emptyToken(TT_BLOCK_OPEN_END);
      this.emptyToken(TT_BLOCK_CLOSE);
      return;
    }
    const isCase =
      nameKind === PK_VALUE && (eqLit(this.text, nameS, nameE, "case") || eqLit(this.text, nameS, nameE, "default"));
    if (this.peek() === 123) {
      // The token starts behind the brace.
      this.pos = this.pos + 1;
      this.emptyToken(TT_BLOCK_OPEN_END);
    } else if (this.isBlockStart() && isCase) {
      this.emptyToken(TT_BLOCK_OPEN_END);
      this.emptyToken(TT_BLOCK_CLOSE);
    } else {
      this.tokens[startToken * TK_STRIDE + TKF_KIND] = TT_INCOMPLETE_BLOCK_OPEN;
    }
  }

  consumeBlockParameters(): void {
    while (!isBlockParameterChar(this.peek())) this.advance();
    while (this.peek() !== 41 && this.peek() !== 0) {
      this.beginToken(TT_BLOCK_PARAMETER);
      let inQuote = -1;
      let openParens = 0;
      while ((this.peek() !== 59 && this.peek() !== 0) || inQuote >= 0) {
        const char = this.peek();
        if (char === 92) {
          this.advance();
        } else if (char === inQuote) {
          inQuote = -1;
        } else if (inQuote < 0 && isQuote(char)) {
          inQuote = char;
        } else if (char === 40 && inQuote < 0) {
          openParens = openParens + 1;
        } else if (char === 41 && inQuote < 0) {
          if (openParens === 0) break;
          openParens = openParens - 1;
        }
        this.advance();
      }
      this.endTokenNone();
      while (!isBlockParameterChar(this.peek())) this.advance();
    }
  }

  consumeLetDeclaration(start: number): void {
    this.requireStr("@let");
    this.beginTokenAt(TT_LET_START, start);
    if (isWhitespace(this.peek())) {
      this.skipWhitespace();
    } else {
      const token = this.endTokenAt(PK_VALUE, start, this.pos, 0, 0, this.pos);
      this.tokens[token * TK_STRIDE + TKF_KIND] = TT_INCOMPLETE_LET;
      return;
    }
    const nameStart = this.pos;
    let allowDigit = false;
    for (;;) {
      const code = this.peek();
      if (isAsciiLetter(code) || code === 36 || code === 95 || (allowDigit && isDigit(code))) {
        allowDigit = true;
      } else {
        break;
      }
      this.advance();
    }
    const startToken = this.endTokenAt(PK_VALUE, nameStart, this.pos, 0, 0, this.pos);
    this.skipWhitespace();
    if (!this.attemptCharCode(61)) {
      this.tokens[startToken * TK_STRIDE + TKF_KIND] = TT_INCOMPLETE_LET;
      return;
    }
    while (!(isNotWhitespace(this.peek()) && !isNewLine(this.peek()))) this.advance();
    this.beginToken(TT_LET_VALUE);
    this.attemptUntilIgnoreQuotes();
    this.endTokenNone();
    if (this.peek() === 59) {
      this.beginToken(TT_LET_END);
      this.advance();
      this.endTokenNone();
    } else {
      this.tokens[startToken * TK_STRIDE + TKF_KIND] = TT_INCOMPLETE_LET;
      this.tokens[startToken * TK_STRIDE + TKF_START] = start;
      this.tokens[startToken * TK_STRIDE + TKF_END] = this.pos;
    }
  }

  /** `attempt_until_ignore_quotes(|char| char == 59)` */
  attemptUntilIgnoreQuotes(): void {
    while (this.peek() !== 0) {
      const char = this.peek();
      if (char === 59) break;
      if (isQuote(char)) {
        this.advance();
        for (;;) {
          const inner = this.peek();
          if (inner === 92) {
            this.advance();
          } else if (inner === char) {
            break;
          }
          this.advance();
        }
      }
      this.advance();
    }
  }

  // ───────────────────────────── expansion forms ─────────────────────────────

  /** Returns whether a token has been made. */
  tokenizeExpansionForm(): boolean {
    if (this.isExpansionFormStart()) {
      this.consumeExpansionFormStart();
      return true;
    }
    if (this.peek() !== 125 && this.isInExpansionForm()) {
      this.consumeExpansionCaseStart();
      return true;
    }
    if (this.peek() === 125) {
      if (this.isInExpansionCase()) {
        this.beginToken(TT_EXPANSION_CASE_EXP_END);
        this.requireCharCode(125);
        this.endTokenNone();
        this.skipWhitespace();
        this.expansionCaseStack.pop();
        return true;
      }
      if (this.isInExpansionForm()) {
        this.beginToken(TT_EXPANSION_FORM_END);
        this.requireCharCode(125);
        this.endTokenNone();
        this.expansionCaseStack.pop();
        return true;
      }
    }
    return false;
  }

  readUntil(char: number): void {
    while (this.peek() !== char) this.advance();
  }

  consumeExpansionFormStart(): void {
    this.beginToken(TT_EXPANSION_FORM_START);
    this.requireCharCode(123);
    this.endTokenNone();
    this.expansionCaseStack.push(TT_EXPANSION_FORM_START);
    for (let i = 0; i < 2; i++) {
      this.beginToken(TT_RAW_TEXT);
      this.readUntil(44);
      this.endTokenNone();
      this.requireCharCode(44);
      this.skipWhitespace();
    }
  }

  consumeExpansionCaseStart(): void {
    this.beginToken(TT_EXPANSION_CASE_VALUE);
    const start = this.pos;
    this.readUntil(123);
    const end = this.pos;
    // `trimmed`
    const text = this.text;
    let s = start;
    let e = end;
    while (s < e) {
      const n = jsWhitespaceLen(text, s, e);
      if (n === 0) break;
      s = s + n;
    }
    while (e > s) {
      const n = jsWhitespaceLenBack(text, s, e);
      if (n === 0) break;
      e = e - n;
    }
    this.endTokenAt(PK_VALUE, s, e, 0, 0, this.pos);
    this.skipWhitespace();
    this.beginToken(TT_EXPANSION_CASE_EXP_START);
    this.requireCharCode(123);
    this.endTokenNone();
    this.skipWhitespace();
    this.expansionCaseStack.push(TT_EXPANSION_CASE_EXP_START);
  }

  // ───────────────────────────── entities ─────────────────────────────

  consumeEntity(textTokenType: number): void {
    this.beginToken(TT_ENCODED_ENTITY);
    const start = this.pos;
    this.advance();
    if (this.attemptCharCode(35)) {
      const isHex = this.attemptCharCode(120) || this.attemptCharCode(88);
      const codeStart = this.pos;
      while (!isDigitEntityEnd(this.peek())) this.advance();
      if (this.peek() !== 59) {
        this.advance();
        this.errorOf(
          isHex ? EK_HEXADECIMAL_ENTITY_WITHOUT_SEMICOLON : EK_DECIMAL_ENTITY_WITHOUT_SEMICOLON,
          this.pos,
          start,
          this.pos,
        );
      }
      const digitsEnd = this.pos;
      this.advance();
      // `String.fromCodePoint(parseInt(digits, radix))`
      const radix = isHex ? 16 : 10;
      let code = -1;
      const text = this.text;
      for (let i = codeStart; i < digitsEnd; i++) {
        const c = text[i] | 0;
        let d = -1;
        if (c >= 48 && c <= 57) d = c - 48;
        else if (c >= 97 && c <= 102) d = c - 87;
        else if (c >= 65 && c <= 70) d = c - 55;
        if (d < 0 || d >= radix) break;
        // saturating
        const v = (code < 0 ? 0 : code) * radix + d;
        code = v > 0xffffffff ? 0xffffffff : v;
      }
      if (code < 0 || code > 0x10ffff) {
        this.errorOf(EK_UNKNOWN_ENTITY, this.pos, start, this.pos);
      }
      this.endTokenNone();
      return;
    }
    const nameStart = this.pos;
    while (!isNamedEntityEnd(this.peek())) this.advance();
    if (this.peek() !== 59) {
      this.beginTokenAt(textTokenType, start);
      this.pos = nameStart;
      this.endTokenNone();
      return;
    }
    this.advance();
    // `entity != b"&ngsp;" && decode_entity_to_utf8(entity).is_none()`
    if (!eqLit(this.text, start, this.pos, "&ngsp;") && lookupEntity(this.text, start, this.pos) < 0) {
      this.errorOf(EK_UNKNOWN_ENTITY, start, nameStart, this.pos - 1);
    }
    this.endTokenNone();
  }

  // ───────────────────────────── raw text ─────────────────────────────

  /** Whether what ends a raw text is next. `tcS`/`tcE`: the name of a `MARK_TAG_CLOSE`. */
  isAtEndMarker(marker: number, str: string, tcS: number, tcE: number): boolean {
    if (marker === MARK_STR) return this.peekStr(str);
    if (marker === MARK_GREATER_THAN) return this.peek() === 62;
    if (!this.peekStr("</")) return false;
    let pos = this.skipWhitespaceAt(this.pos + 2);
    const nameLen = tcE - tcS;
    if (pos + nameLen > this.len) return false;
    if (!this.rangeEqIgnoreCase(pos, tcS, nameLen)) return false;
    pos = this.skipWhitespaceAt(pos + nameLen);
    return this.peekAt(pos) === 62;
  }

  skipWhitespaceAt(start: number): number {
    let pos = start;
    for (;;) {
      const c = this.peekAt(pos);
      if (isNotWhitespace(c)) return pos;
      pos = pos + (c === NBSP ? 2 : 1);
    }
  }

  rangeEqIgnoreCase(a: number, b: number, n: number): boolean {
    const text = this.text;
    for (let i = 0; i < n; i++) {
      let x = text[a + i] | 0;
      let y = text[b + i] | 0;
      if (x >= 65 && x <= 90) x = x + 32;
      if (y >= 65 && y <= 90) y = y + 32;
      if (x !== y) return false;
    }
    return true;
  }

  consumeRawText(consumeEntities: boolean, marker: number, str: string, tcS: number, tcE: number): void {
    const kind = consumeEntities ? TT_ESCAPABLE_RAW_TEXT : TT_RAW_TEXT;
    const first = marker === MARK_STR ? str.charCodeAt(0) : marker === MARK_GREATER_THAN ? 62 : 60;
    this.beginToken(kind);
    const text = this.text;
    const len = this.len;
    for (;;) {
      // Nothing happens before the next character that something can start with.
      let pos = this.pos;
      if (consumeEntities) {
        while (pos < len) {
          const b = text[pos] | 0;
          if (b === first || b === 38) break;
          pos = pos + 1;
        }
      } else {
        while (pos < len && (text[pos] | 0) !== first) pos = pos + 1;
      }
      this.pos = pos;
      if (this.isAtEndMarker(marker, str, tcS, tcE)) break;
      if (consumeEntities && this.peek() === 38) {
        this.endTokenNone();
        this.consumeEntity(TT_ESCAPABLE_RAW_TEXT);
        this.beginToken(TT_ESCAPABLE_RAW_TEXT);
      } else {
        this.advance();
      }
    }
    this.endTokenNone();
  }

  /** A comment, a CDATA section or a document type. */
  consumeDelimited(start: number, startKind: number, endKind: number, marker: number, str: string, tcS: number, tcE: number): void {
    this.beginTokenAt(startKind, start);
    this.endTokenNone();
    this.consumeRawText(false, marker, str, tcS, tcE);
    this.beginToken(endKind);
    if (marker === MARK_STR) this.requireStr(str);
    else this.advance();
    this.endTokenNone();
  }

  // ───────────────────────────── tags ─────────────────────────────

  /** `consume_prefix_and_name`'s result: the prefix `(cpS, cpE)` and the name `(cnS, cnE)`. `mode`: 0 `is_name_end`, 1 the one for `[` names. */
  cpS: number = 0;
  cpE: number = 0;
  cnS: number = 0;
  cnE: number = 0;
  openBrackets: number = 0;

  /** The predicate of the end of a name. */
  endPredicate(mode: number, code: number): boolean {
    if (mode === 0) return isNameEnd(code);
    if (mode === 1) {
      // `[` names
      if (code === 91) this.openBrackets = this.openBrackets + 1;
      else if (code === 93) this.openBrackets = this.openBrackets - 1;
      if (this.openBrackets <= 0) return isNameEnd(code);
      return isNewLine(code);
    }
    return code === 62;
  }

  consumePrefixAndName(mode: number): void {
    const nameOrPrefixStart = this.pos;
    while (this.peek() !== 58 && !isPrefixEnd(this.peek())) this.advance();
    let prefixS: number;
    let prefixE: number;
    let nameStart: number;
    if (this.peek() === 58) {
      prefixS = nameOrPrefixStart;
      prefixE = this.pos;
      this.advance();
      nameStart = this.pos;
    } else {
      prefixS = nameOrPrefixStart;
      prefixE = nameOrPrefixStart;
      nameStart = nameOrPrefixStart;
    }
    // `require_char_code_until(end_predicate, usize::from(prefix.len() > 0))`
    const untilStart = this.pos;
    while (!this.endPredicate(mode, this.peek())) this.advance();
    if (this.pos - untilStart < (prefixE > prefixS ? 1 : 0)) this.error(untilStart);
    this.cpS = prefixS;
    this.cpE = prefixE;
    this.cnS = nameStart;
    this.cnE = this.pos;
  }

  consumeStartTagComment(start: number, isSingleLine: boolean): void {
    const contentStart = this.pos;
    if (isSingleLine) {
      for (;;) {
        const c = this.peek();
        if (isNewLine(c) || c === 0) break;
        this.advance();
      }
      const contentEnd = this.pos;
      this.beginTokenAt(TT_IN_ELEMENT_COMMENT, start);
      this.endTokenAt(PK_COMMENT, contentStart, contentEnd, 1, 0, this.pos);
      this.skipWhitespace();
      return;
    }
    while (this.peek() !== 0 && !this.peekStr("*/")) this.advance();
    const contentEnd = this.pos;
    let spanEnd = this.pos;
    if (this.attemptStr("*/")) {
      spanEnd = this.pos;
      this.skipWhitespace();
    }
    this.beginTokenAt(TT_IN_ELEMENT_COMMENT, start);
    this.endTokenAt(PK_COMMENT, contentStart, contentEnd, 0, 0, spanEnd);
  }

  /** What is in the `try` of `_consumeTagOpen`. */
  consumeTagOpenTokens(start: number): void {
    if (!isAsciiLetter(this.peek())) this.error(start);
    this.beginTokenAt(TT_TAG_OPEN_START, start);
    this.consumePrefixAndName(0);
    this.openToken = this.endTokenAt(PK_NAME, this.cpS, this.cpE, this.cnS, this.cnE, this.pos);
    this.skipWhitespace();
    for (;;) {
      if (this.allowStartTagComments) {
        const commentStart = this.pos;
        if (this.attemptStr("//")) {
          this.consumeStartTagComment(commentStart, true);
          continue;
        }
        if (this.attemptStr("/*")) {
          this.consumeStartTagComment(commentStart, false);
          continue;
        }
      }
      if (isAttributeTerminator(this.peek())) break;
      this.consumeAttribute();
      // `self.attributes.push(..)`: the name and the last piece of the value.
      this.attrs.push(this.attrNameS);
      this.attrs.push(this.attrNameE);
      this.attrs.push(this.attrValueS);
      this.attrs.push(this.attrValueE);
    }
    const kind = this.attemptCharCode(47) ? TT_TAG_OPEN_END_VOID : TT_TAG_OPEN_END;
    this.beginToken(kind);
    this.requireCharCode(62);
    this.endTokenNone();
  }

  consumeTagOpen(start: number): void {
    this.openToken = -1;
    this.attrs.reset();
    try {
      this.consumeTagOpenTokens(start);
    } catch (e) {
      if (e === FAIL_PARSE) {
        if (this.openToken >= 0) {
          this.tokens[this.openToken * TK_STRIDE + TKF_KIND] = TT_INCOMPLETE_TAG_OPEN;
        } else {
          this.beginTokenAt(TT_TEXT, start);
          this.endTokenNone();
        }
        return;
      }
      throw e;
    }
    if (this.canSelfClose && this.tokenCount > 0 && (this.tokens[(this.tokenCount - 1) * TK_STRIDE + TKF_KIND] | 0) === TT_TAG_OPEN_END_VOID) return;
    if (this.openToken < 0) return;
    const ob = this.openToken * TK_STRIDE;
    if ((this.tokens[ob + TKF_PK] | 0) !== PK_NAME) return;
    const prefixS = this.tokens[ob + TKF_P0] | 0;
    const prefixE = this.tokens[ob + TKF_P1] | 0;
    const nameS = this.tokens[ob + TKF_P2] | 0;
    const nameE = this.tokens[ob + TKF_P3] | 0;
    const contentType = this.getTagContentType(nameS, nameE, this.fullNameStack.len > 0);
    // `_handleFullNameStackForTagOpen`
    const fs = this.fullNameStack;
    if (fs.len === 0 || this.isSameName(fs.data[fs.len - 4] | 0, fs.data[fs.len - 3] | 0, fs.data[fs.len - 2] | 0, fs.data[fs.len - 1] | 0, prefixS, prefixE, nameS, nameE)) {
      fs.push(prefixS);
      fs.push(prefixE);
      fs.push(nameS);
      fs.push(nameE);
    }
    if (contentType === CT_PARSABLE_DATA) return;
    // `_consumeRawTextWithTagClose`
    const fullS = prefixE > prefixS ? prefixS : nameS;
    this.consumeRawText(contentType === CT_ESCAPABLE_RAW_TEXT, MARK_TAG_CLOSE, "", fullS, nameE);
    this.beginToken(TT_TAG_CLOSE);
    // `require_char_code_until(|code| code == 62, 3)`
    const untilStart = this.pos;
    while (this.peek() !== 62) this.advance();
    if (this.pos - untilStart < 3) this.error(untilStart);
    this.advance();
    this.endTokenAt(PK_NAME, prefixS, prefixE, nameS, nameE, this.pos);
    this.handleFullNameStackForTagClose(prefixS, prefixE, nameS, nameE);
  }

  /** `getTagContentType(tagName, hasParent, attrs)`: a `CT_*`. */
  getTagContentType(nameS: number, nameE: number, hasParent: boolean): number {
    const text = this.text;
    let isRaw = false;
    if (this.rawMode === RAW_MJML) {
      // The name is in lower case if the tags are not case sensitive.
      isRaw = eqLitIgnoreCase(text, nameS, nameE, "mj-style") || eqLitIgnoreCase(text, nameS, nameE, "mj-raw");
    } else if (this.rawMode === RAW_VUE) {
      isRaw = !eqLitIgnoreCase(text, nameS, nameE, "html") && !hasParent && (!eqLit(text, nameS, nameE, "template") || this.hasLangAttribute());
    }
    if (isRaw) return CT_RAW_TEXT;
    return defContentType(this.definitionOf(nameS, nameE));
  }

  /** `attrs.any(|attr| attr.name == b"lang" && attr.value.is_some_and(|value| !matches!(value, b"html" | b"")))` */
  hasLangAttribute(): boolean {
    const a = this.attrs;
    const text = this.text;
    for (let i = 0; i + 3 < a.len; i += 4) {
      if (eqLit(text, a.data[i] | 0, a.data[i + 1] | 0, "lang")) {
        const vs = a.data[i + 2] | 0;
        const ve = a.data[i + 3] | 0;
        if (vs >= 0 && !(ve === vs || eqLit(text, vs, ve, "html"))) return true;
      }
    }
    return false;
  }

  /** `definition_of(name, is_case_sensitive)`: the definition id. */
  definitionOf(nameS: number, nameE: number): number {
    if (this.isCaseSensitive) return tagDefinition(this.text, nameS, nameE);
    let hasUpper = false;
    for (let i = nameS; i < nameE; i++) {
      const b = this.text[i] | 0;
      if (b >= 65 && b <= 90) {
        hasUpper = true;
        break;
      }
    }
    if (!hasUpper) return tagDefinition(this.text, nameS, nameE);
    const n = nameE - nameS;
    if (this.lower.length < n) this.lower = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      const b = this.text[nameS + i] | 0;
      this.lower[i] = b >= 65 && b <= 90 ? b + 32 : b;
    }
    return tagDefinition(this.lower, 0, n);
  }

  isSameName(aps: number, ape: number, ans: number, ane: number, bps: number, bpe: number, bns: number, bne: number): boolean {
    return this.rangesEqual(aps, ape, bps, bpe) && this.rangesEqual(ans, ane, bns, bne);
  }

  rangesEqual(as: number, ae: number, bs: number, be: number): boolean {
    if (ae - as !== be - bs) return false;
    const text = this.text;
    for (let i = 0; i < ae - as; i++) {
      if ((text[as + i] | 0) !== (text[bs + i] | 0)) return false;
    }
    return true;
  }

  handleFullNameStackForTagClose(prefixS: number, prefixE: number, nameS: number, nameE: number): void {
    const fs = this.fullNameStack;
    if (fs.len > 0 && this.isSameName(fs.data[fs.len - 4] | 0, fs.data[fs.len - 3] | 0, fs.data[fs.len - 2] | 0, fs.data[fs.len - 1] | 0, prefixS, prefixE, nameS, nameE)) {
      fs.len = fs.len - 4;
    }
  }

  /** The name and the last piece of text in the value (-1: no value) of the attribute read last. */
  attrNameS: number = 0;
  attrNameE: number = 0;
  attrValueS: number = -1;
  attrValueE: number = -1;
  /** `consume_with_interpolation`'s result: the last piece of text. */
  lastTextS: number = 0;
  lastTextE: number = 0;

  consumeAttribute(): void {
    const nameStart = this.peek();
    if (nameStart === 39 || nameStart === 34) this.error(this.pos);
    this.beginToken(TT_ATTR_NAME);
    if (nameStart === 91) {
      this.openBrackets = 0;
      this.consumePrefixAndName(1);
    } else {
      this.consumePrefixAndName(0);
    }
    this.endTokenAt(PK_NAME, this.cpS, this.cpE, this.cnS, this.cnE, this.pos);
    const nameS = this.cnS;
    const nameE = this.cnE;
    let valueS = -1;
    let valueE = -1;
    this.skipWhitespace();
    if (this.attemptCharCode(61)) {
      this.skipWhitespace();
      const quote = this.peek();
      if (quote === 39 || quote === 34) {
        this.consumeQuote(quote);
        this.consumeWithInterpolation(TT_ATTR_VALUE_TEXT, TT_ATTR_VALUE_INTERPOLATION, END_QUOTE + quote, END_QUOTE + quote);
        valueS = this.lastTextS;
        valueE = this.lastTextE;
        this.consumeQuote(quote);
      } else {
        this.consumeWithInterpolation(TT_ATTR_VALUE_TEXT, TT_ATTR_VALUE_INTERPOLATION, END_NAME, END_NAME);
        valueS = this.lastTextS;
        valueE = this.lastTextE;
      }
    }
    this.skipWhitespace();
    this.attrNameS = nameS;
    this.attrNameE = nameE;
    this.attrValueS = valueS;
    this.attrValueE = valueE;
  }

  consumeQuote(quote: number): void {
    this.beginToken(TT_ATTR_QUOTE);
    this.requireCharCode(quote);
    this.endTokenNone();
  }

  consumeTagClose(start: number): void {
    this.beginTokenAt(TT_TAG_CLOSE, start);
    this.skipWhitespace();
    if (this.allowHtmComponentClosingTags && this.attemptCharCode(47)) {
      this.skipWhitespace();
      this.requireCharCode(62);
      this.endTokenNone();
      return;
    }
    this.consumePrefixAndName(0);
    const prefixS = this.cpS;
    const prefixE = this.cpE;
    const nameS = this.cnS;
    const nameE = this.cnE;
    this.skipWhitespace();
    this.requireCharCode(62);
    this.endTokenAt(PK_NAME, prefixS, prefixE, nameS, nameE, this.pos);
    this.handleFullNameStackForTagClose(prefixS, prefixE, nameS, nameE);
  }

  /** The last piece of text goes into `lastTextS` and `lastTextE`. */
  consumeWithInterpolation(textTokenType: number, interpolationTokenType: number, end: number, endInterpolation: number): void {
    this.beginToken(textTokenType);
    let textStart = this.pos;
    for (;;) {
      this.skipPlainText(end);
      if (this.isEnd(end)) break;
      const current = this.pos;
      if (this.attemptStr("{{")) {
        this.endTokenAt(PK_NONE, 0, 0, 0, 0, current);
        this.consumeInterpolation(interpolationTokenType, current, endInterpolation);
        this.beginToken(textTokenType);
        textStart = this.pos;
      } else if (this.peek() === 38) {
        this.endTokenNone();
        this.consumeEntity(textTokenType);
        this.beginToken(textTokenType);
        textStart = this.pos;
      } else {
        this.advance();
      }
    }
    this.endTokenNone();
    this.lastTextS = textStart;
    this.lastTextE = this.pos;
  }

  consumeInterpolation(kind: number, start: number, prematureEnd: number): void {
    this.beginTokenAt(kind, start);
    let inQuote = -1;
    let inComment = false;
    while (this.peek() !== 0 && !this.isEnd(prematureEnd)) {
      if (this.isTagStart()) {
        this.endTokenNone();
        return;
      }
      if (inQuote < 0) {
        if (this.attemptStr("}}")) {
          this.endTokenNone();
          return;
        }
        if (this.attemptStr("//")) inComment = true;
      }
      const char = this.peek();
      this.advance();
      if (char === 92) {
        this.advance();
      } else if (char === inQuote) {
        inQuote = -1;
      } else if (!inComment && inQuote < 0 && isQuote(char)) {
        inQuote = char;
      }
    }
    this.endTokenNone();
  }
}

export const lx = new Lexer();

/**
 * `tokenize`, from `start` on, of `text[..len]`. The tokens are in `lx.tokens` (`lx.tokenCount`, `TK_STRIDE` numbers each), the errors in
 * `lx.errors`. `rawMode`: `RAW_*`.
 */
export function tokenize(
  text: Uint8Array,
  len: number,
  start: number,
  rawMode: number,
  isCaseSensitive: boolean,
  tokenizeAngularBlocks: boolean,
  tokenizeLet: boolean,
  canSelfClose: boolean,
  allowHtmComponentClosingTags: boolean,
  allowStartTagComments: boolean,
): void {
  const l = lx;
  l.text = text;
  l.len = len;
  l.pos = start;
  l.tokenizeAngularBlocks = tokenizeAngularBlocks;
  l.tokenizeLet = tokenizeLet;
  l.canSelfClose = canSelfClose;
  l.allowHtmComponentClosingTags = allowHtmComponentClosingTags;
  l.allowStartTagComments = allowStartTagComments;
  l.rawMode = rawMode;
  l.isCaseSensitive = isCaseSensitive;
  l.hasCurrent = false;
  l.expansionCaseStack.reset();
  l.fullNameStack.reset();
  l.attrs.reset();
  l.tokenCount = 0;
  l.errors.clear();
  l.tokenize();
  // `mergeTextTokens`
  const t = l.tokens;
  let w = 0;
  const n = l.tokenCount;
  for (let r = 0; r < n; r++) {
    const rb = r * TK_STRIDE;
    const kind = t[rb + TKF_KIND] | 0;
    if (w > 0) {
      const lb = (w - 1) * TK_STRIDE;
      const lk = t[lb + TKF_KIND] | 0;
      if (lk === kind && (kind === TT_TEXT || kind === TT_ATTR_VALUE_TEXT)) {
        t[lb + TKF_END] = t[rb + TKF_END] | 0;
        continue;
      }
    }
    if (w !== r) {
      const wb = w * TK_STRIDE;
      for (let k = 0; k < TK_STRIDE; k++) t[wb + k] = t[rb + k] | 0;
    }
    w = w + 1;
  }
  l.tokenCount = w;
}
