// Port of vendor/bun/src/format/js/source_text.rs: questions about the source text around a position.
//
// A Rust `SourceText` is the text of the file. Here it is a class that holds the bytes (`text`, exactly the source: `hir.text` may be
// longer than the source, the formatter makes a view of it). A `Span` is `(start, end)`. Where Rust takes a predicate closure
// (`all_bytes`), TS takes a 256-entry table (`BT_*` below, or `byteTable(..)`): the byte is looked up in it.
import { indexOfByte } from "../../base/bytes.ts";
import {
  jsLineBreakLen,
  jsLineBreakLenBack,
  jsWhitespaceLen,
  jsWhitespaceLenBack,
} from "../text.ts";
import { Slots2 } from "../../base/slots.ts";

/** A table of bytes for `SourceText.allBytes`: `byteTable(" \t", false)`. `ascii`: also the ASCII whitespace of Rust (`is_ascii_whitespace`). */
export function byteTable(chars: string, asciiWhitespace: boolean): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = 1;
  if (asciiWhitespace) {
    // U+0020, U+0009, U+000A, U+000C, U+000D (not U+000B)
    t[32] = 1;
    t[9] = 1;
    t[10] = 1;
    t[12] = 1;
    t[13] = 1;
  }
  return t;
}

/** `b.is_ascii_whitespace()` */
export const BT_ASCII_WS: Uint8Array = byteTable("", true);
/** `b.is_ascii_whitespace() || b == b'('` */
export const BT_WS_OPEN_PAREN: Uint8Array = byteTable("(", true);
/** `b.is_ascii_whitespace() || matches!(b, b')' | b',' | b';')` */
export const BT_WS_CLOSE_PAREN_COMMA_SEMI: Uint8Array = byteTable("),;", true);
/** `b.is_ascii_whitespace() || matches!(b, b',' | b';')` */
export const BT_WS_COMMA_SEMI: Uint8Array = byteTable(",;", true);
/** `b.is_ascii_whitespace() || b == b';'` */
export const BT_WS_SEMI: Uint8Array = byteTable(";", true);
/** `matches!(b, b' ' | b'\t' | 0x0B | 0x0C)` */
export const BT_BLANK_VT_FF: Uint8Array = byteTable(" \t\x0b\x0c", false);
/** `matches!(b, b' ' | b'\t')` */
export const BT_SPACE_TAB: Uint8Array = byteTable(" \t", false);
/** `matches!(b, b' ' | b'\t' | b')' | b';')` */
export const BT_SPACE_TAB_CLOSE_PAREN_SEMI: Uint8Array = byteTable(" \t);", false);
/** `matches!(b, b'\t' | b' ' | b'=' | b':' | b',')` */
export const BT_END_OF_LINE_BETWEEN: Uint8Array = byteTable("\t =:,", false);

/** Whether text[start, end) has a line break (`\n`, `\r`, U+2028, U+2029). */
export function containsJsLineBreak(text: Uint8Array, start: number, end: number): boolean {
  const e = end < text.length ? end : text.length;
  for (let i = start; i < e; i++) {
    const b = text[i] | 0;
    if (b === 10 || b === 13) return true;
    if (b === 0xe2 && i + 2 < e && (text[i + 1] | 0) === 0x80) {
      const b2 = text[i + 2] | 0;
      if (b2 === 0xa8 || b2 === 0xa9) return true;
    }
  }
  return false;
}

/** `has_line_terminator(rest)` for rest = text[start, end) */
function hasLineTerminator(text: Uint8Array, start: number, end: number): boolean {
  if (start >= end) return false;
  if (start + 1 < end && (text[start + 1] | 0) === 10) return true;
  return containsJsLineBreak(text, start, end);
}

/** `trim_ascii_start` */
function trimAsciiStart(text: Uint8Array, at: number): number {
  const n = text.length;
  let i = at;
  while (i < n) {
    const b = text[i] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) i = i + 1;
    else break;
  }
  return i;
}

export class SourceText {
  text: Uint8Array;

  constructor(text: Uint8Array) {
    this.text = text;
  }

  /** `text.get(position)`, or -1. */
  byteAt(position: number): number {
    return position >= 0 && position < this.text.length ? this.text[position] | 0 : -1;
  }

  /** The text after `position` starts with `expected` once white space (also the kind that is not ASCII) is skipped. */
  nextNonWhitespaceByteIs(position: number, expected: number): boolean {
    const text = this.text;
    const n = text.length;
    let at = trimAsciiStart(text, position < n ? position : n);
    while (at < n && (text[at] | 0) >= 0x80) {
      const len = jsWhitespaceLen(text, at, n);
      if (len === 0) break;
      at = trimAsciiStart(text, at + len);
    }
    return at < n && (text[at] | 0) === expected;
  }

  containsByte(start: number, end: number, byte: number): boolean {
    const e = end < this.text.length ? end : this.text.length;
    return start < e && indexOfByte(this.text, start, e, byte) >= 0;
  }

  /**
   * Whether every byte of text[start, end) is in `table`. White space that is not ASCII counts as a space, U+2028 and U+2029 as
   * `\n`.
   */
  allBytes(start: number, end: number, table: Uint8Array): boolean {
    const text = this.text;
    const e = end < text.length ? end : text.length;
    let i = start;
    while (i < e) {
      const b = text[i] | 0;
      if ((table[b] | 0) !== 0) {
        i = i + 1;
        continue;
      }
      // `rest = &rest[at..]`: stands_for by what is at i.
      const lb = jsLineBreakLen(text, i);
      const stands = lb === 0 ? 32 : 10;
      const len = jsWhitespaceLen(text, i, e);
      if (len < 2 || (table[stands] | 0) === 0) return false;
      i = i + len;
    }
    return true;
  }

  /** The number of characters in text[start, end). */
  spanWidth(start: number, end: number): number {
    const text = this.text;
    const e = end < text.length ? end : text.length;
    let count = 0;
    for (let i = start; i < e; i++) {
      // Each byte that is not a continuation byte starts a character (an invalid byte counts as one).
      if (((text[i] | 0) & 0xc0) !== 0x80) count = (count + 1) | 0;
    }
    return count;
  }

  containsNewline(start: number, end: number): boolean {
    return hasLineTerminator(this.text, start, end < this.text.length ? end : this.text.length);
  }

  /** Prettier's `hasNewlineInRange`, which does not know U+2028 and U+2029. */
  hasNewlineInRange(start: number, end: number): boolean {
    const text = this.text;
    const e = end < text.length ? end : text.length;
    for (let i = start; i < e; i++) {
      const b = text[i] | 0;
      if (b === 10 || b === 13) return true;
    }
    return false;
  }

  /** The number of line breaks between `end` and the next thing that is not whitespace. 0 if there is nothing more. */
  linesAfter(end: number): number {
    const text = this.text;
    const n = text.length;
    let at = end < n ? end : n;
    let count = 0;
    while (true) {
      // What there is between most nodes.
      while (at < n) {
        const b = text[at] | 0;
        if (b === 32 || b === 9) at = at + 1;
        else if (b === 10) {
          count = (count + 1) | 0;
          at = at + 1;
        } else break;
      }
      const lb = jsLineBreakLen(text, at);
      const ws = jsWhitespaceLen(text, at, n);
      if (lb === 0 && ws === 0) return at >= n ? 0 : count;
      if (lb === 0) at = at + ws;
      else {
        at = at + lb;
        count = (count + 1) | 0;
      }
    }
  }

  /**
   * The number of line breaks between the previous token and the node at `(spanStart, spanEnd)`, or the comments that lead up to it,
   * the first of which is at `(firstCommentStart, firstCommentEnd)` (-1: there is none). Parentheses around the node are looked
   * through.
   *
   * `looksPastComma`: in `a: 1\n\n, b: 2` the comma is on the line of what follows it, and the line breaks before it count.
   */
  getLinesBefore(spanStart: number, spanEnd: number, firstCommentStart: number, firstCommentEnd: number, looksPastComma: boolean): number {
    const text = this.text;
    const n = text.length;
    let start = spanStart;
    if (firstCommentStart >= 0 && firstCommentEnd <= start) start = firstCommentStart;
    else if (start !== 0 && this.byteAt(start - 1) === 59) {
      // `;(function() {})`
      start = start - 1;
    }
    let count = 0;
    let isAfterComma = !looksPastComma;
    let following = spanEnd < n ? spanEnd : n;
    let before = start < n ? start : n;
    while (true) {
      // What there is between most nodes.
      while (before > 0) {
        const last = text[before - 1] | 0;
        if (last !== 32 && last !== 9 && last !== 10) break;
        before = before - 1;
        if (last === 10) {
          count = (count + 1) | 0;
          if (before > 0 && (text[before - 1] | 0) === 13) before = before - 1;
        }
      }
      if (jsLineBreakLenBack(text, before) === 0) {
        const space = jsWhitespaceLenBack(text, 0, before);
        if (space >= 1) {
          before = before - space;
          continue;
        }
      }
      if (before > 0 && (text[before - 1] | 0) === 40) {
        // The line breaks inside the parentheses do not count.
        following = trimAsciiStart(text, following);
        if (following < n) {
          if ((text[following] | 0) === 41) following = following + 1;
          else return count;
        }
        before = before - 1;
        count = 0;
        continue;
      }
      const len = jsLineBreakLenBack(text, before);
      if (len === 0) {
        if (before === 0) return 0;
        if (count === 0 && !isAfterComma && (text[before - 1] | 0) === 44) {
          before = before - 1;
          isAfterComma = true;
          continue;
        }
        return count;
      }
      before = before - len;
      count = (count + 1) | 0;
    }
  }

  /** Whether only spaces and tabs are between the previous line break and `position`. */
  hasLineTerminatorBefore(position: number): boolean {
    const text = this.text;
    let end = position < text.length ? position : text.length;
    while (end > 0) {
      const b = text[end - 1] | 0;
      if (b !== 32 && b !== 9) break;
      end = end - 1;
    }
    return jsLineBreakLenBack(text, end) !== 0;
  }

  /** Whether only spaces and tabs are between `position` and the next line break. */
  hasLineTerminatorAfter(position: number): boolean {
    const text = this.text;
    const n = text.length;
    let at = position < n ? position : n;
    while (at < n) {
      const b = text[at] | 0;
      if (b !== 32 && b !== 9) break;
      at = at + 1;
    }
    return jsLineBreakLen(text, at) !== 0;
  }

  /** Whether there is a line break between `position` and the next token, which can be in or after a comment. */
  hasLineTerminatorAfterSkippingComments(position: number): boolean {
    const text = this.text;
    const n = text.length;
    let at = position < n ? position : n;
    while (true) {
      const b = at < n ? text[at] | 0 : -1;
      if (b === 32 || b === 9) {
        at = at + 1;
      } else if (b === 47 && at + 1 < n && (text[at + 1] | 0) === 47) {
        return hasLineTerminator(text, at + 2, n);
      } else if (b === 47 && at + 1 < n && (text[at + 1] | 0) === 42) {
        const tail = at + 2;
        let end = tail;
        while (end < n && !((text[end] | 0) === 42 && end + 1 < n && (text[end + 1] | 0) === 47)) end = end + 1;
        if (hasLineTerminator(text, tail, end)) return true;
        at = end + 2 > n ? n : end + 2;
        if (end >= n) at = n;
      } else {
        return jsLineBreakLen(text, at) !== 0;
      }
    }
  }
}

/**
 * `split_crlf_lines`: the end of the line that starts at `pos` in text[.., end) and the length of the line break that ends it (0 at
 * the end of the text). `\r\n`, `\n` and `\r` end a line. Writes the line end to `LINE[0]` and the break length to `LINE[1]`.
 */
export const LINE = new Slots2();
export function lineEndAt(text: Uint8Array, pos: number, end: number): void {
  let e = pos;
  while (e < end) {
    const b = text[e] | 0;
    if (b === 10 || b === 13) break;
    e = e + 1;
  }
  const LINE$ = LINE;
  LINE$.s0 = (e) | 0;
  if (e >= end) {
    LINE$.s1 = 0;
  } else if ((text[e] | 0) === 13 && e + 1 < end && (text[e + 1] | 0) === 10) {
    LINE$.s1 = 2;
  } else {
    LINE$.s1 = 1;
  }
}
