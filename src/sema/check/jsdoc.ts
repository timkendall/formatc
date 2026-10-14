// Port of vendor/bun/src/sema/check/jsdoc.rs, as far as `Flavor::Oxc` goes: where the tags of the JSDoc comments of a file are, and
// where the type, the name, the default and the text of each tag are, the way the crate oxc_jsdoc (which oxlint and oxfmt read
// comments with) finds them.
//
// NOT PORTED: `Flavor::TypeScript` (jsdoc.go of TypeScript 7) and everything that a `Syntax` hook is for (the parser that makes the HIR
// of a JavaScript file reads JSDoc types; the parser here never does): `links`, `tags`, `parse_tag` of the tags with children, the
// type expressions. With `Flavor::Oxc` and no `Syntax` the reader only needs the scanner, `LineStartRule`, `find_*_range` and
// `parse_tag_comments`.
//
// A Rust `Tag` is a row of `TAG_STRIDE` ints in `outline.tags` (`TG_*` are the columns); a `Range` is two ints, `0, 0` for none (nothing
// in a comment is at 0).
import { I32Vec } from "../vec.ts";
import { decodeUtf8, utf8Len } from "../../base/utf8.ts";
import { isIdentifierPart, isIdentifierStart, isWhiteSpaceSingleLine } from "../parser/unicode.ts";
import { ESC_CP, identEnd, unicodeEscapeAt } from "./spans.ts";
import { Slots2 } from "../../base/slots.ts";

export const TAG_STRIDE: number = 10;
/** The `@`. */
export const TG_AT: number = 0;
/** The name is `at + 1 .. nameEnd`. It can be empty. */
export const TG_NAME_END: number = 1;
/** `{type}`, with the braces. */
export const TG_TY_START: number = 2;
export const TG_TY_END: number = 3;
/** `name`, `a.b`, `[name]`, `[name = default]`, with the brackets. */
export const TG_NAME_START: number = 4;
export const TG_NAME_STOP: number = 5;
/** What is between the `=` and the `]`. In `[name=]` it is empty and not none. */
export const TG_DEFAULT_START: number = 6;
export const TG_DEFAULT_END: number = 7;
/** Where the description starts, which ends at `end`. */
export const TG_TEXT: number = 8;
/** Where the next tag starts that is not in this one, or the end of what the comment says. */
export const TG_END: number = 9;

/** `char::is_whitespace`. */
export function isUnicodeWhitespace(c: number): boolean {
  if (c < 0x80) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f ||
    c === 0x205f || c === 0x3000
  );
}

// JSDocToken
const T_EOF = 0;
const T_WHITESPACE = 1;
const T_NEWLINE = 2;
const T_COMMENT_TEXT = 3;
const T_AT = 4;
const T_ASTERISK = 5;
const T_OPEN_BRACE = 6;
const T_CLOSE_BRACE = 7;
const T_OPEN_BRACKET = 8;
const T_CLOSE_BRACKET = 9;
const T_LESS_THAN = 10;
const T_EQUALS = 11;
const T_COMMA = 12;
const T_DOT = 13;
const T_BACKTICK = 14;
const T_HASH = 15;
const T_IDENTIFIER = 16;
const T_UNKNOWN = 17;
const T_OTHER = 18;

// JSDocState
const S_BEGINNING_OF_LINE = 0;
const S_SAW_ASTERISK = 1;
const S_SAVING_COMMENTS = 2;
const S_SAVING_BACKTICKS = 3;

function savingState(inBackticks: boolean): number {
  return inBackticks ? S_SAVING_BACKTICKS : S_SAVING_COMMENTS;
}
function isSaving(s: number): boolean {
  return s === S_SAVING_COMMENTS || s === S_SAVING_BACKTICKS;
}

/** `isJSDocLikeText`, of a comment that is closed: `/**` and not `/**&#47;`, with `*&#47;` behind the `/**`. */
function isJsdocLike(text: Uint8Array, start: number, end: number): boolean {
  return (
    end - start >= 5 &&
    (text[start] | 0) === 47 &&
    (text[start + 1] | 0) === 42 &&
    (text[start + 2] | 0) === 42 &&
    (text[start + 3] | 0) !== 47 &&
    (text[end - 2] | 0) === 42 &&
    (text[end - 1] | 0) === 47
  );
}

/** What oxc_jsdoc knows at a position of a comment: `parse_jsdoc`, without the split. */
class LineStartRule {
  /** Up to where it has read. */
  seen: number = 0;
  curlyBraceDepth: number = 0;
  /** How many backticks have opened the code that this is in. */
  backtickCount: number = 0;
  /** `"`, `'` or 0. */
  quote: number = 0;
  atLineStart: boolean = true;
  lineSeenStar: boolean = false;
  spacesAfterStar: number = 0;

  reset(at: number): void {
    this.seen = at;
    this.curlyBraceDepth = 0;
    this.backtickCount = 0;
    this.quote = 0;
    this.atLineStart = true;
    this.lineSeenStar = false;
    this.spacesAfterStar = 0;
  }

  advance(text: Uint8Array, lim: number, upto: number): void {
    while (this.seen < upto) {
      if (this.seen >= lim) return;
      const byte = text[this.seen] | 0;
      const isPlain = this.backtickCount === 0 && this.quote === 0;
      let len = 1;
      if (byte === 96 && this.quote === 0) {
        let run = 0;
        while (this.seen + run < lim && (text[this.seen + run] | 0) === 96) run = run + 1;
        len = run;
        if (this.backtickCount === 0) this.backtickCount = len;
        else if (this.backtickCount === len) this.backtickCount = 0;
      } else if ((byte === 34 || byte === 39) && isPlain) this.quote = byte;
      else if ((byte === 34 || byte === 39) && this.quote === byte) this.quote = 0;
      else if (byte === 10) this.quote = 0;
      else if (byte === 123 && isPlain) this.curlyBraceDepth = this.curlyBraceDepth + 1;
      else if (byte === 125 && isPlain) this.curlyBraceDepth = this.curlyBraceDepth > 0 ? this.curlyBraceDepth - 1 : 0;
      if (byte === 10) {
        this.atLineStart = true;
        this.lineSeenStar = false;
        this.spacesAfterStar = 0;
      } else if (this.atLineStart) {
        if (byte === 42) {
          this.lineSeenStar = true;
          this.spacesAfterStar = 0;
        } else if (byte === 32 || byte === 9 || byte === 13) {
          this.spacesAfterStar = this.spacesAfterStar + (this.lineSeenStar ? 1 : 0);
        } else this.atLineStart = false;
      }
      this.seen = this.seen + len;
    }
  }

  allowsTag(): boolean {
    return this.atLineStart && this.curlyBraceDepth === 0 && this.backtickCount === 0 && !(this.lineSeenStar && this.spacesAfterStar >= 5);
  }
}

/** A found range of `find_*_range`, relative to the start of the slice. */
const FOUND = new Slots2();

/** `find_token_range` of oxc_jsdoc: where the first word of `text[from, to)` is. A `{` ends it as well: `@kind{type}`. */
function findTokenRange(text: Uint8Array, from: number, to: number): boolean {
  let start = -1;
  let index = from;
  const FOUND$ = FOUND;
  while (index < to) {
    const c = decodeUtf8(text, index, to);
    const len = utf8Len();
    if (isUnicodeWhitespace(c) || c === 123) {
      if (start >= 0) {
        FOUND$.s0 = (start - from) | 0;
        FOUND$.s1 = (index - from) | 0;
        return true;
      }
    } else if (start < 0) start = index;
    index = index + len;
  }
  if (start < 0) return false;
  FOUND$.s0 = (start - from) | 0;
  FOUND$.s1 = (to - from) | 0;
  return true;
}

/** `find_type_range`: where the `{...}` is that the text starts with, after white space. */
function findTypeRange(text: Uint8Array, from: number, to: number): boolean {
  let at = from;
  while (at < to) {
    const c = decodeUtf8(text, at, to);
    if (!isUnicodeWhitespace(c)) break;
    at = at + utf8Len();
  }
  if (at >= to || (text[at] | 0) !== 123) return false;
  const offset = at - from;
  let braceCount = 0;
  const FOUND$ = FOUND;
  for (let i = at; i < to; i++) {
    const byte = text[i] | 0;
    if (byte === 123) braceCount = braceCount + 1;
    else if (byte === 125) {
      if (braceCount === 1) {
        FOUND$.s0 = (offset) | 0;
        FOUND$.s1 = (offset + (i - at) + 1) | 0;
        return true;
      }
      braceCount = braceCount - 1;
    }
  }
  return false;
}

/** `find_type_name_range`: like a token, but there can be white space in `[name = default]`. */
function findTypeNameRange(text: Uint8Array, from: number, to: number): boolean {
  let at = from;
  while (at < to) {
    const c = decodeUtf8(text, at, to);
    if (!isUnicodeWhitespace(c)) break;
    at = at + utf8Len();
  }
  if (!(at < to && (text[at] | 0) === 91)) return findTokenRange(text, from, to);
  let bracket = 0;
  let start = -1;
  let index = from;
  const FOUND$ = FOUND;
  while (index < to) {
    const c = decodeUtf8(text, index, to);
    const len = utf8Len();
    if (isUnicodeWhitespace(c)) {
      if (bracket === 0 && start >= 0) {
        FOUND$.s0 = (start - from) | 0;
        FOUND$.s1 = (index - from) | 0;
        return true;
      }
    } else {
      if (c === 91) bracket = bracket + 1;
      else if (c === 93) bracket = bracket > 0 ? bracket - 1 : 0;
      if (start < 0) start = index;
    }
    index = index + len;
  }
  if (start < 0 || bracket !== 0) return false;
  FOUND$.s0 = (start - from) | 0;
  FOUND$.s1 = (to - from) | 0;
  return true;
}

function endOfWhiteSpaceRun(text: Uint8Array, lim: number, from: number): number {
  let p = from;
  while (p < lim) {
    const c = decodeUtf8(text, p, lim);
    if (!isWhiteSpaceSingleLine(c)) break;
    p = p + utf8Len();
  }
  return p;
}

/** The JSDoc comments of a text, in order, and their tags, in order. */
export class Outline {
  /** Columns of the comments. */
  starts: I32Vec = new I32Vec(64);
  ends: I32Vec = new I32Vec(64);
  firstTag: I32Vec = new I32Vec(64);
  tagCount: I32Vec = new I32Vec(64);
  /** Rows of `TAG_STRIDE`. */
  tags: I32Vec = new I32Vec(256);

  reset(): void {
    this.starts.reset();
    this.ends.reset();
    this.firstTag.reset();
    this.tagCount.reset();
    this.tags.reset();
  }

  /** The number of comments. */
  count(): number {
    return this.starts.len;
  }

  /** The index of the comment whose `/**` is at `start`, or -1. */
  indexAt(start: number): number {
    let lo = 0;
    let hi = this.starts.len - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.starts.data[mid] | 0;
      if (s === start) return mid;
      if (s < start) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}

/** The reader. One per thread; it writes the tags of the comment to `tags`. */
class Reader {
  text: Uint8Array = new Uint8Array(0);
  /** The source up to the `*&#47;` of the comment. */
  lim: number = 0;
  // the scanner
  token: number = T_OTHER;
  fullStart: number = 0;
  start: number = 0;
  pos: number = 0;
  /** Rows of `TAG_STRIDE`, indexes relative to the comment. */
  tags: I32Vec = new I32Vec(64);
  /** The index in `tags` (a row number) of the tag that is being parsed. */
  row: number = 0;
  rule: LineStartRule = new LineStartRule();

  begin(source: Uint8Array, start: number, end: number): void {
    this.text = source;
    this.lim = end > 2 ? end - 2 : 0;
    this.token = T_OTHER;
    this.fullStart = start + 3;
    this.start = start + 3;
    this.pos = start + 3;
    this.tags.reset();
    this.row = 0;
    this.rule.reset(start + 3);
  }

  /** `nextTokenJSDoc`, `ScanJSDocToken` */
  nextTokenJsdoc(): number {
    const text = this.text;
    const lim = this.lim;
    const start = this.pos;
    let pos = start + 1;
    let token = T_UNKNOWN;
    if (start >= lim) {
      pos = start;
      token = T_EOF;
    } else {
      const b = text[start] | 0;
      if (b === 9 || b === 0x0b || b === 0x0c || b === 32) {
        pos = endOfWhiteSpaceRun(text, lim, pos);
        token = T_WHITESPACE;
      } else if (b === 64) token = T_AT;
      else if (b === 13) {
        if (pos < lim && (text[pos] | 0) === 10) pos = pos + 1;
        token = T_NEWLINE;
      } else if (b === 10) token = T_NEWLINE;
      else if (b === 42) token = T_ASTERISK;
      else if (b === 123) token = T_OPEN_BRACE;
      else if (b === 125) token = T_CLOSE_BRACE;
      else if (b === 91) token = T_OPEN_BRACKET;
      else if (b === 93) token = T_CLOSE_BRACKET;
      else if (b === 60) token = T_LESS_THAN;
      else if (b === 61) token = T_EQUALS;
      else if (b === 44) token = T_COMMA;
      else if (b === 46) token = T_DOT;
      else if (b === 96) token = T_BACKTICK;
      else if (b === 35) token = T_HASH;
      else if (b === 40 || b === 41 || b === 62) token = T_OTHER;
      else if (b === 92) {
        const e = unicodeEscapeAt(text, lim, start);
        if (e > 0 && isIdentifierStart(ESC_CP[0] | 0)) {
          pos = identEnd(text, lim, start + e);
          token = T_IDENTIFIER;
        } else token = T_UNKNOWN;
      } else {
        const ch = decodeUtf8(text, start, lim);
        pos = start + utf8Len();
        if (isIdentifierStart(ch)) {
          while (pos < lim) {
            const c = decodeUtf8(text, pos, lim);
            if (!(isIdentifierPart(c) || c === 45)) break;
            pos = pos + utf8Len();
          }
          if (pos < lim && (text[pos] | 0) === 92) pos = identEnd(text, lim, pos);
          token = T_IDENTIFIER;
        } else token = T_UNKNOWN;
      }
    }
    this.token = token;
    this.fullStart = start;
    this.start = start;
    this.pos = pos;
    return token;
  }

  /** `nextJSDocCommentTextToken`, `ScanJSDocCommentTextToken` */
  nextJsdocCommentTextToken(inBackticks: boolean): number {
    const text = this.text;
    const lim = this.lim;
    const start = this.pos;
    let pos = start;
    while (pos < lim) {
      const ch = text[pos] | 0;
      if (ch === 96 || ch === 10 || ch === 13) break;
      if (ch === 0xe2 && pos + 2 < lim && (text[pos + 1] | 0) === 0x80 && ((text[pos + 2] | 0) === 0xa8 || (text[pos + 2] | 0) === 0xa9)) break;
      // `starts_tag` is asked about each.
      if (ch === 64) break;
      if (!inBackticks && ch === 123) break;
      pos = pos + 1;
    }
    if (pos === start) return this.nextTokenJsdoc();
    this.token = T_COMMENT_TEXT;
    this.fullStart = start;
    this.start = start;
    this.pos = pos;
    return T_COMMENT_TEXT;
  }

  /** Whether the current token, an `@`, starts a tag. */
  startsTag(): boolean {
    this.rule.advance(this.text, this.lim, this.start);
    return this.rule.allowsTag();
  }

  /** `ResetPos` */
  resetPos(pos: number): void {
    this.fullStart = pos;
    this.start = pos;
    this.pos = pos;
  }

  /** Starts the tag whose `@` is at `at`. Returns the `row` of the tag that it is in. */
  openRow(at: number): number {
    const outer = this.row;
    this.row = (this.tags.len / TAG_STRIDE) | 0;
    const t = this.tags;
    t.push(at);
    t.push(at + 1);
    for (let i = 0; i < 6; i++) t.push(0);
    t.push(0);
    t.push(0);
    return outer;
  }

  /** The tag ends before the current token. */
  closeRow(outer: number): void {
    const i = this.row * TAG_STRIDE;
    if (i + TG_END < this.tags.len) this.tags.data[i + TG_END] = this.fullStart | 0;
    this.row = outer;
  }

  parseOptionalJsdoc(token: number): boolean {
    const isNext = this.token === token;
    if (isNext) this.nextTokenJsdoc();
    return isNext;
  }

  /** `parseJSDocCommentWorker` for the comment that starts at `start`. */
  parseJsdocCommentWorker(): void {
    let state = S_SAW_ASTERISK;
    let backtickCount = 0;
    let inFencedCodeBlock = false;
    this.nextTokenJsdoc();
    while (this.parseOptionalJsdoc(T_WHITESPACE)) {
      // skip
    }
    if (this.parseOptionalJsdoc(T_NEWLINE)) state = S_BEGINNING_OF_LINE;
    while (true) {
      // "Three or more consecutive backticks toggle the fenced code block state."
      if (this.token !== T_BACKTICK && backtickCount > 0) {
        if (backtickCount >= 3) inFencedCodeBlock = !inFencedCodeBlock;
        backtickCount = 0;
      }
      const token = this.token;
      if (token === T_AT && this.startsTag()) {
        this.parseTag();
        state = S_BEGINNING_OF_LINE;
      } else if (token === T_NEWLINE) state = S_BEGINNING_OF_LINE;
      // "Ignore the first asterisk on a line"
      else if (token === T_ASTERISK && state !== S_SAW_ASTERISK) state = S_SAW_ASTERISK;
      else if (token === T_WHITESPACE) {
        // nothing
      } else if (token === T_EOF) break;
      else if (token === T_BACKTICK) {
        backtickCount = backtickCount + 1;
        state = savingState(state !== S_SAVING_BACKTICKS);
      } else if (token === T_ASTERISK) state = S_SAVING_COMMENTS;
      else if (token === T_AT || token === T_OPEN_BRACE) state = savingState(inFencedCodeBlock);
      else if (state !== S_SAVING_BACKTICKS) state = savingState(inFencedCodeBlock);
      if (isSaving(state)) this.nextJsdocCommentTextToken(state === S_SAVING_BACKTICKS);
      else this.nextTokenJsdoc();
    }
  }

  /** `parseTag` for the tag whose `@` is at the current token (`Flavor::Oxc`). */
  parseTag(): void {
    const start = this.start;
    const outer = this.openRow(start);
    this.parseTagOfOxc(start);
    this.closeRow(outer);
  }

  /** `text.get(from..to)` is empty when it is not in the text: the end that counts. */
  writtenEnd(from: number, to: number): number {
    return from <= to && to <= this.lim ? to : from;
  }

  /** `parse_jsdoc_tag` of oxc_jsdoc for the tag whose `@` is at `at`, and what its `type_name_comment` finds in the tag. */
  parseTagOfOxc(at: number): void {
    const text = this.text;
    const lim = this.lim;
    let nameEnd = at + 1;
    const FOUND$ = FOUND;
    if (at <= lim && findTokenRange(text, at, lim)) nameEnd = at + FOUND$.s1;
    this.resetPos(nameEnd);
    this.nextTokenJsdoc();
    this.parseTagComments();
    const end = this.fullStart;
    let tyStart = 0;
    let tyEnd = 0;
    const to1 = this.writtenEnd(nameEnd, end);
    if (findTypeRange(text, nameEnd, to1)) {
      tyStart = nameEnd + FOUND$.s0;
      tyEnd = nameEnd + FOUND$.s1;
    }
    const afterType = tyEnd !== 0 ? tyEnd : nameEnd;
    let nStart = 0;
    let nEnd = 0;
    const to2 = this.writtenEnd(afterType, end);
    if (findTypeNameRange(text, afterType, to2)) {
      nStart = afterType + FOUND$.s0;
      nEnd = afterType + FOUND$.s1;
    }
    let defStart = 0;
    let defEnd = 0;
    if (nEnd !== 0 && nEnd <= lim && nStart <= nEnd) {
      let equals = -1;
      for (let i = nStart; i < nEnd; i++) {
        if ((text[i] | 0) === 61) {
          equals = i - nStart;
          break;
        }
      }
      if (equals >= 0 && (text[nStart] | 0) === 91 && (text[nEnd - 1] | 0) === 93) {
        defStart = nStart + equals + 1;
        defEnd = nEnd - 1;
      }
    }
    const i = this.row * TAG_STRIDE;
    if (i + TG_END < this.tags.len) {
      const d = this.tags.data;
      d[i + TG_NAME_END] = nameEnd;
      d[i + TG_TY_START] = tyStart;
      d[i + TG_TY_END] = tyEnd;
      d[i + TG_NAME_START] = nStart;
      d[i + TG_NAME_STOP] = nEnd;
      d[i + TG_DEFAULT_START] = defStart;
      d[i + TG_DEFAULT_END] = defEnd;
      d[i + TG_TEXT] = nEnd !== 0 ? nEnd : afterType;
    }
  }

  /** `parseTagComments` (without the text, which `Flavor::Oxc` does not collect). */
  parseTagComments(): void {
    let state = S_BEGINNING_OF_LINE;
    let backtickCount = 0;
    let inFencedCodeBlock = false;
    const i = this.row * TAG_STRIDE;
    if (i + TG_END < this.tags.len) this.tags.data[i + TG_TEXT] = this.fullStart;
    while (true) {
      if (this.token !== T_BACKTICK && backtickCount > 0) {
        if (backtickCount >= 3) inFencedCodeBlock = !inFencedCodeBlock;
        backtickCount = 0;
      }
      const token = this.token;
      if (token === T_NEWLINE) state = S_BEGINNING_OF_LINE;
      else if (token === T_AT && this.startsTag()) {
        this.resetPos(this.pos - 1);
        break;
      } else if (token === T_EOF) break;
      else if (token === T_WHITESPACE) {
        // nothing
      } else if (token === T_AT || token === T_OPEN_BRACE) state = savingState(inFencedCodeBlock);
      else if (token === T_BACKTICK) {
        backtickCount = backtickCount + 1;
        state = savingState(state !== S_SAVING_BACKTICKS);
      }
      // "leading asterisks start recording on the *next* (non-whitespace) token"
      else if (token === T_ASTERISK && state === S_BEGINNING_OF_LINE) state = S_SAW_ASTERISK;
      else if (state !== S_SAVING_BACKTICKS) state = savingState(inFencedCodeBlock);
      if (isSaving(state)) this.nextJsdocCommentTextToken(state === S_SAVING_BACKTICKS);
      else this.nextTokenJsdoc();
    }
  }
}

const reader = new Reader();

/** Reads the JSDoc comments among `comments` (`pairs` of start, end, from `hir.comments`) of `text` into `out`. */
export function outlineRead(text: Uint8Array, comments: Int32Array, nComments: number, out: Outline): void {
  out.reset();
  const reader$ = reader;
  for (let k = 0; k < nComments; k++) {
    const start = comments[k * 2] | 0;
    const end = comments[k * 2 + 1] | 0;
    if (!isJsdocLike(text, start, end)) continue;
    const firstTag = (out.tags.len / TAG_STRIDE) | 0;
    let hasAt = false;
    for (let i = start; i < end; i++) {
      if ((text[i] | 0) === 64) {
        hasAt = true;
        break;
      }
    }
    if (hasAt) {
      reader$.begin(text, start, end);
      reader$.parseJsdocCommentWorker();
      const t = reader$.tags;
      for (let i = 0; i < t.len; i++) out.tags.push(t.data[i] | 0);
    }
    out.starts.push(start);
    out.ends.push(end);
    out.firstTag.push(firstTag);
    out.tagCount.push((out.tags.len / TAG_STRIDE) - firstTag);
  }
}
