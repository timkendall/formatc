// Helpers of the code in this directory: text of the file as JS strings (the sorts compare strings), and the small operations on bytes that
// Rust's `&[u8]` has.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { SP, commentEndAt, commentStartAt, commentsLen, hir, nameBuf, nameLen, nameStart } from "../../../lint/ast/index.ts";

const decoder = new TextDecoder();

/** `hir.text[start, end)` as a string. */
export function textString(start: number, end: number): string {
  if (end <= start) return "";
  return decoder.decode(hir.text.subarray(start, end));
}

/** `bytes[start, end)` as a string. */
export function bytesString(bytes: Uint8Array, start: number, end: number): string {
  if (end <= start) return "";
  return decoder.decode(bytes.subarray(start, end));
}

/** The text of the name `atom`. */
export function nameString(atom: number): string {
  if (atom < 0) return "";
  const n = nameLen(atom);
  if (n === 0) return "";
  const s = nameStart(atom);
  return decoder.decode(nameBuf(atom).subarray(s, s + n));
}

/** The text of the name `atom` as bytes (a view; valid until the next file). */
export function nameBytes(atom: number): Uint8Array {
  if (atom < 0) return hir.text.subarray(0, 0);
  const s = nameStart(atom);
  return nameBuf(atom).subarray(s, s + nameLen(atom));
}

/** ASCII white space: what Rust's `trim_ascii` takes off. */
export function isAsciiBlank(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 12 || b === 13;
}

/** `text[..end].trim_ascii().is_empty()` */
export function isBlankBefore(text: Uint8Array, end: number): boolean {
  for (let i = 0; i < end && i < text.length; i++) if (!isAsciiBlank(text[i] | 0)) return false;
  return true;
}

/** `bytes.trim_ascii_end()` of `text[start, end)`: the new end. */
export function trimAsciiEnd(text: Uint8Array, start: number, end: number): number {
  let e = end;
  while (e > start && isAsciiBlank(text[e - 1] | 0)) e = e - 1;
  return e;
}

/** `bytes.trim_ascii_start()` of `text[start, end)`: the new start. */
export function trimAsciiStart(text: Uint8Array, start: number, end: number): number {
  let s = start;
  while (s < end && isAsciiBlank(text[s] | 0)) s = s + 1;
  return s;
}

/** Whether `text[start, end)` contains the ASCII `lit`. */
export function containsAscii(text: Uint8Array, start: number, end: number, lit: string): boolean {
  const n = lit.length;
  for (let i = start; i + n <= end; i++) {
    let same = true;
    for (let k = 0; k < n; k++) {
      if ((text[i + k] | 0) !== lit.charCodeAt(k)) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

/** Whether `text[start, end)` starts with the ASCII `lit`. */
export function startsWithAscii(text: Uint8Array, start: number, end: number, lit: string): boolean {
  if (end - start < lit.length) return false;
  for (let k = 0; k < lit.length; k++) if ((text[start + k] | 0) !== lit.charCodeAt(k)) return false;
  return true;
}

/** The first `b` in `text[start, end)`, or -1. */
export function indexOfByteIn(text: Uint8Array, start: number, end: number, b: number): number {
  for (let i = start; i < end; i++) if ((text[i] | 0) === b) return i;
  return -1;
}

/** The last `b` in `text[start, end)`, or -1. */
export function lastIndexOfByteIn(text: Uint8Array, start: number, end: number, b: number): number {
  for (let i = end - 1; i >= start; i--) if ((text[i] | 0) === b) return i;
  return -1;
}

/** Whether `text[start, end)` has a `\n` or `\r`. */
export function hasLineBreakIn(text: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const b = text[i] | 0;
    if (b === 10 || b === 13) return true;
  }
  return false;
}

/** `contains_js_line_break`: a `\n`, `\r`, U+2028 or U+2029 in `text[start, end)`. */
export function hasJsLineBreakIn(text: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const b = text[i] | 0;
    if (b === 10 || b === 13) return true;
    if (b === 0xe2 && i + 2 < end && (text[i + 1] | 0) === 0x80) {
      const c = text[i + 2] | 0;
      if (c === 0xa8 || c === 0xa9) return true;
    }
  }
  return false;
}

/** `text[start, end)` equals `other[otherStart, otherEnd)`. */
export function sameBytes(a: Uint8Array, aStart: number, aEnd: number, b: Uint8Array, bStart: number, bEnd: number): boolean {
  if (aEnd - aStart !== bEnd - bStart) return false;
  for (let i = 0; i < aEnd - aStart; i++) if ((a[aStart + i] | 0) !== (b[bStart + i] | 0)) return false;
  return true;
}

/** The number of UTF-16 code units of the (WTF-8) text `text[start, end)`. */
export function utf16Len(text: Uint8Array, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) {
    const b = text[i] | 0;
    if (b < 0x80 || b >= 0xc0) n = n + (b >= 0xf0 ? 2 : 1);
  }
  return n;
}

/** The number of bytes of `s` as UTF-8. */
export function utf8LengthOf(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** A `Span`: here, where it is an object, the code is not hot. */
export class Span {
  start: number;
  end: number;
  constructor(start: number, end: number) {
    this.start = start;
    this.end = end;
  }
  /** `Span::len` */
  len(): number {
    return this.end > this.start ? this.end - this.start : 0;
  }
}

/** The span that the last call that writes `SP` has written. */
export function spanOfSP(): Span {
  return new Span(SP[0] | 0, SP[1] | 0);
}

/** The comments of the file (`file.comments()`) that are entirely inside `[start, end]`: the indices `[commentRange.from, commentRange.to)`. */
export class CommentRange {
  from: number = 0;
  to: number = 0;
}
export const commentRange = new CommentRange();

/** `file.comments_in(span)`: returns how many, and sets `commentRange`. */
export function commentsWithin(start: number, end: number): number {
  const n = commentsLen();
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (commentStartAt(mid) < start) lo = mid + 1;
    else hi = mid;
  }
  let to = lo;
  while (to < n && commentEndAt(to) <= end) to = to + 1;
  const commentRange$ = commentRange;
  commentRange$.from = lo;
  commentRange$.to = to;
  return to - lo;
}

/** Whether `text[aStart, aEnd)` is less than `text[bStart, bEnd)` as bytes (`<[u8]>::cmp`): -1, 0 or 1. */
export function compareBytes(a: Uint8Array, aStart: number, aEnd: number, b: Uint8Array, bStart: number, bEnd: number): number {
  const n = aEnd - aStart < bEnd - bStart ? aEnd - aStart : bEnd - bStart;
  for (let i = 0; i < n; i++) {
    const x = a[aStart + i] | 0;
    const y = b[bStart + i] | 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  const la = aEnd - aStart;
  const lb = bEnd - bStart;
  return la === lb ? 0 : la < lb ? -1 : 1;
}

/** The bytes of a buffer, copied. */
export function bufBytes(b: ByteBuf): Uint8Array {
  return b.data.slice(0, b.len);
}
