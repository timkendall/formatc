// Port of vendor/bun/src/format/markdown/strings.rs: characters and strings as micromark sees them, and the byte-string
// helpers (`bun_core::strings`) that the rest of this directory uses. Every function takes `(buf, start, end)`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { encodeUtf8 } from "../../base/utf8.ts";
import { decodeEntityToUtf8, isUnicodePunctuation } from "../../md/lib.ts";

// Does the sorted list of ranges `table` (flat pairs lo, hi) contain `c`?
export function isIn(table: Int32Array, c: number): boolean {
  let lo = 0;
  let hi = (table.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = table[mid * 2] | 0;
    if (c < a) hi = mid - 1;
    else if (c > (table[mid * 2 + 1] | 0)) lo = mid + 1;
    else return true;
  }
  return false;
}

// ---- bytes

// `u8::is_ascii_whitespace`: space, tab, LF, FF, CR (not VT).
export function isAsciiWs(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 12 || b === 13;
}
// `u8::is_ascii_punctuation`
export function isAsciiPunct(b: number): boolean {
  return (b >= 33 && b <= 47) || (b >= 58 && b <= 64) || (b >= 91 && b <= 96) || (b >= 123 && b <= 126);
}
export function isAsciiDigit(b: number): boolean {
  return b >= 48 && b <= 57;
}
export function isAsciiAlpha(b: number): boolean {
  return (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
}
export function isAsciiAlnum(b: number): boolean {
  return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
}
// A blank: space or tab.
export function isBlank(b: number): boolean {
  return b === 32 || b === 9;
}

// The index of the first `\n` in buf[from, end), or `end`.
export function lineEndIn(buf: Uint8Array, from: number, end: number): number {
  let i = from;
  while (i < end && (buf[i] | 0) !== 10) i = ((i | 0) + 1) | 0;
  return i;
}

// The index of `needle` (ASCII) in buf[from, end), or -1.
export function indexOfStr(buf: Uint8Array, from: number, end: number, needle: string): number {
  const n = needle.length;
  const first = needle.charCodeAt(0);
  const last = end - n;
  for (let i = from; i <= last; i++) {
    if ((buf[i] | 0) !== first) continue;
    let k = 1;
    while (k < n && (buf[i + k] | 0) === needle.charCodeAt(k)) k = k + 1;
    if (k === n) return i;
  }
  return -1;
}

export function containsStr(buf: Uint8Array, from: number, end: number, needle: string): boolean {
  return indexOfStr(buf, from, end, needle) >= 0;
}

// Index of the last `needle` (ASCII) in buf[from, end), or -1.
export function lastIndexOfStr(buf: Uint8Array, from: number, end: number, needle: string): number {
  const n = needle.length;
  for (let i = end - n; i >= from; i--) {
    let k = 0;
    while (k < n && (buf[i + k] | 0) === needle.charCodeAt(k)) k = k + 1;
    if (k === n) return i;
  }
  return -1;
}

export function startsWithStr(buf: Uint8Array, start: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (start + n > end) return false;
  for (let i = 0; i < n; i++) {
    if ((buf[start + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

export function endsWithStr(buf: Uint8Array, start: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (end - n < start) return false;
  const at = end - n;
  for (let i = 0; i < n; i++) {
    if ((buf[at + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

// Whether buf[a, a + len) equals the ASCII `lit` ignoring the case of letters; `lit` is lower case.
export function startsWithIgnoreCase(buf: Uint8Array, start: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (start + n > end) return false;
  for (let i = 0; i < n; i++) {
    let c = buf[start + i] | 0;
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== lit.charCodeAt(i)) return false;
  }
  return true;
}

export function containsByte(buf: Uint8Array, start: number, end: number, byte: number): boolean {
  for (let i = start; i < end; i++) {
    if ((buf[i] | 0) === byte) return true;
  }
  return false;
}

export function countByte(buf: Uint8Array, start: number, end: number, byte: number): number {
  let n = 0;
  for (let i = start; i < end; i++) {
    if ((buf[i] | 0) === byte) n = ((n | 0) + 1) | 0;
  }
  return n;
}

export function isAllAscii(buf: Uint8Array, start: number, end: number): boolean {
  let acc = 0;
  for (let i = start; i < end; i++) acc = acc | (buf[i] | 0);
  return (acc & 0x80) === 0;
}

// ---- characters

// `bun_core::strings::is_js_whitespace`: JavaScript's `\s`.
export function isJsWhitespaceCp(c: number): boolean {
  if (c < 0x80) return c === 0x20 || (c >= 9 && c <= 13);
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// `bun_core::strings::is_unicode_space_separator`: the category Zs.
export function isUnicodeSpaceSeparatorCp(c: number): boolean {
  return c === 0x20 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;
}

// `[\p{Space_Separator}\t\n\f\r]`
export function isCommonmarkWhitespace(c: number): boolean {
  return c === 9 || c === 10 || c === 12 || c === 13 || isUnicodeSpaceSeparatorCp(c);
}

export const CLASS_WHITESPACE = 0;
export const CLASS_PUNCTUATION = 1;
export const CLASS_OTHER = 2;

// micromark's `classifyCharacter`. `c` is -1 at the start or the end of the text.
export function classify(c: number): number {
  if (c < 0) return CLASS_WHITESPACE;
  if (isJsWhitespaceCp(c)) return CLASS_WHITESPACE;
  if (isUnicodePunctuation(c)) return CLASS_PUNCTUATION;
  return CLASS_OTHER;
}

// micromark's `decodeNumericCharacterReference`
export function numericCharacter(code: number): number {
  const isBad =
    code < 9 || code === 11 || (code > 13 && code < 32) || (code > 126 && code < 160) || (code >= 0xfdd0 && code <= 0xfdef) || (code & 0xffff) >= 0xfffe;
  if (isBad) return 0xfffd;
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return 0xfffd;
  return code;
}

const decodedEntity = new Uint8Array(16);

function digitValue(b: number, radix: number): number {
  let v = -1;
  if (b >= 48 && b <= 57) v = b - 48;
  else if (b >= 97 && b <= 102) v = b - 87;
  else if (b >= 65 && b <= 70) v = b - 55;
  return v >= 0 && v < radix ? v : -1;
}

// The character reference that buf[start, end) starts with, `&amp;`, `&#38;` or `&#x26;`: its length, or -1. What it stands
// for is appended to `out`, if there is one.
export function characterReference(buf: Uint8Array, start: number, end: number, out: ByteBuf | null): number {
  if (start >= end || (buf[start] | 0) !== 38) return -1;
  const body = start + 1;
  if (body < end && (buf[body] | 0) === 35) {
    const number = body + 1;
    let digits = number;
    let radix = 10;
    let max = 7;
    let prefix = 2;
    if (number < end && ((buf[number] | 0) === 120 || (buf[number] | 0) === 88)) {
      digits = number + 1;
      radix = 16;
      max = 6;
      prefix = 3;
    }
    let count = 0;
    while (digits + count < end && digitValue(buf[digits + count] | 0, radix) >= 0) count = count + 1;
    if (count === 0 || count > max || digits + count >= end || (buf[digits + count] | 0) !== 59) return -1;
    if (out !== null) {
      let code = 0;
      for (let i = 0; i < count; i++) code = code * radix + digitValue(buf[digits + i] | 0, radix);
      encodeUtf8(out, numericCharacter(code));
    }
    return prefix + count + 1;
  }
  let count = 0;
  while (body + count < end && isAsciiAlnum(buf[body + count] | 0)) count = count + 1;
  if (count === 0 || count > 31 || body + count >= end || (buf[body + count] | 0) !== 59) return -1;
  const len = decodeEntityToUtf8(buf, start, start + count + 2, decodedEntity);
  if (len < 0) return -1;
  if (out !== null) out.append(decodedEntity, 0, len);
  return count + 2;
}

// micromark's `decodeString`: buf[start, end) without the backslashes of its escapes and with what its character
// references stand for, appended to `out`.
export function unescape(buf: Uint8Array, start: number, end: number, out: ByteBuf): void {
  let from = start;
  let i = start;
  while (i < end) {
    const b = buf[i] | 0;
    if (b !== 92 && b !== 38) {
      i = ((i | 0) + 1) | 0;
      continue;
    }
    out.append(buf, from, i);
    if (b === 92 && i + 1 < end && isAsciiPunct(buf[i + 1] | 0)) {
      out.push(buf[i + 1] | 0);
      i = i + 2;
    } else {
      const len = characterReference(buf, i, end, out);
      if (len >= 0) i = i + len;
      else {
        out.push(b);
        i = i + 1;
      }
    }
    from = i;
  }
  out.append(buf, from, end);
}
