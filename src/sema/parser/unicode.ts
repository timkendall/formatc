// Character classes for the lexer: the parts of `bun_core::lexer` that the sema lexer uses (is_identifier_start/part,
// is_white_space_*), UTF-8 decoding with the strictness of Rust's `str::from_utf8`.
//
// ASCII is table driven (`ID_START_TBL` / `ID_PART_TBL`: 1 for a byte that can start / continue a name). Above U+007F the
// ranges in unicode_tables.ts (generated from node's ID_Start / ID_Continue) are searched. Rust has a second, newer table
// for ecmascript dialects (`is_recent_identifier_*`); the generated tables are of one Unicode version (node 24's), so
// `isRecentIdentifier*` and `isTypeScriptIdentifierPart` are the same functions. TODO(port): compare with Bun's exact
// tables if a vscode file with an exotic identifier character ever differs.
import { ID_PART_RANGES, ID_START_RANGES } from "./unicode_tables.ts";
import { Slots2 } from "../../base/slots.ts";

export const ID_START_TBL = new Uint8Array(256);
export const ID_PART_TBL = new Uint8Array(256);
for (let c = 0; c < 128; c++) {
  const alpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
  const digit = c >= 48 && c <= 57;
  ID_START_TBL[c] = alpha ? 1 : 0;
  ID_PART_TBL[c] = alpha || digit ? 1 : 0;
}

function inRanges(table: Int32Array, c: number): boolean {
  let lo = 0;
  let hi = (table.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c < (table[mid * 2] | 0)) hi = mid - 1;
    else if (c > (table[mid * 2 + 1] | 0)) lo = mid + 1;
    else return true;
  }
  return false;
}

/** `is_identifier_start`: ID_Start, `$`, `_`. */
export function isIdentifierStart(c: number): boolean {
  if (c < 128) return c >= 0 && (ID_START_TBL[c] | 0) !== 0;
  return inRanges(ID_START_RANGES, c);
}
/** `is_identifier_part`: ID_Continue, `$`, ZWNJ, ZWJ. */
export function isIdentifierPart(c: number): boolean {
  if (c < 128) return c >= 0 && (ID_PART_TBL[c] | 0) !== 0;
  return inRanges(ID_PART_RANGES, c);
}
export function isRecentIdentifierStart(c: number): boolean {
  return isIdentifierStart(c);
}
export function isRecentIdentifierPart(c: number): boolean {
  return isIdentifierPart(c);
}
export function isTypeScriptIdentifierPart(c: number): boolean {
  return isIdentifierPart(c);
}

/** TypeScript's `IsWhiteSpaceSingleLine`. */
export function isWhiteSpaceSingleLine(c: number): boolean {
  if (c < 128) return c === 32 || c === 9 || c === 11 || c === 12;
  return (
    c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200b) || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}
/** `is_white_space_like`: white space or a line break. */
export function isWhiteSpaceLike(c: number): boolean {
  return isWhiteSpaceSingleLine(c) || c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}
/** `is_js_line_terminator` */
export function isJsLineTerminator(c: number): boolean {
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

/** Result slot of decode(): the code point. */
export const DEC = new Slots2();

/**
 * Rust `decode`: the code point at `src[pos]` and its length in bytes, strict UTF-8 (no overlong forms, no surrogates, <=
 * U+10FFFF). Returns the length (1..4), or 0 if it is not UTF-8 / `pos >= end`. The code point is in `DEC[0]`.
 */
export function decode(src: Uint8Array, pos: number, end: number): number {
  if (pos >= end) return 0;
  const b0 = src[pos] | 0;
  const DEC$ = DEC;
  if (b0 < 0x80) {
    DEC$.s0 = (b0) | 0;
    return 1;
  }
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    if (pos + 2 > end) return 0;
    const b1 = src[pos + 1] | 0;
    if ((b1 & 0xc0) !== 0x80) return 0;
    DEC$.s0 = (((b0 & 0x1f) << 6) | (b1 & 0x3f)) | 0;
    return 2;
  }
  if (b0 >= 0xe0 && b0 <= 0xef) {
    if (pos + 3 > end) return 0;
    const b1 = src[pos + 1] | 0;
    const b2 = src[pos + 2] | 0;
    if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return 0;
    if (b0 === 0xe0 && b1 < 0xa0) return 0;
    if (b0 === 0xed && b1 > 0x9f) return 0;
    DEC$.s0 = (((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f)) | 0;
    return 3;
  }
  if (b0 >= 0xf0 && b0 <= 0xf4) {
    if (pos + 4 > end) return 0;
    const b1 = src[pos + 1] | 0;
    const b2 = src[pos + 2] | 0;
    const b3 = src[pos + 3] | 0;
    if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return 0;
    if (b0 === 0xf0 && b1 < 0x90) return 0;
    if (b0 === 0xf4 && b1 > 0x8f) return 0;
    DEC$.s0 = (((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)) | 0;
    return 4;
  }
  return 0;
}

/** `decode_last`: the code point that ends at `end` (exclusive), searching backwards from `end`; length or 0. Code point in `DEC[0]`. */
export function decodeLast(src: Uint8Array, end: number): number {
  for (let len = 1; len <= 4; len++) {
    if (end - len < 0) return 0;
    const n = decode(src, end - len, end);
    if (n === len) return len;
  }
  return 0;
}

/** Whether `src[start, end)` is valid UTF-8. */
export function isUtf8(src: Uint8Array, start: number, end: number): boolean {
  let p = start;
  while (p < end) {
    if ((src[p] | 0) < 0x80) {
      p = (p + 1) | 0;
      continue;
    }
    const n = decode(src, p, end);
    if (n === 0) return false;
    p = (p + n) | 0;
  }
  return true;
}
