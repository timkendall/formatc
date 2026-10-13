// UTF-8 helpers for width computation and offset translation. Bytes are never turned into JS strings.
//
// `decodeUtf8` follows the WHATWG decoder (and Rust's `bstr::decode_utf8`): an invalid sequence is one U+FFFD
// per maximal invalid prefix. Results are returned without allocation: the code point is the return value, the
// number of bytes consumed is read with `utf8Len()` right after.
import { ByteBuf } from "./bytebuf.ts";

let lastLen = 1;

// Number of bytes consumed by the last `decodeUtf8` / `decodeUtf8Back` call.
export function utf8Len(): number {
  return lastLen;
}

// Decodes the character at src[pos] (pos < end). Invalid bytes give U+FFFD.
export function decodeUtf8(src: Uint8Array, pos: number, end: number): number {
  const b0 = src[pos] | 0;
  if (b0 < 0x80) { lastLen = 1; return b0; }
  if (b0 < 0xc2 || b0 > 0xf4) { lastLen = 1; return 0xfffd; }
  if (b0 < 0xe0) {
    if (pos + 1 < end) {
      const b1 = src[pos + 1] | 0;
      if ((b1 & 0xc0) === 0x80) { lastLen = 2; return ((b0 & 0x1f) << 6) | (b1 & 0x3f); }
    }
    lastLen = 1;
    return 0xfffd;
  }
  if (b0 < 0xf0) {
    const lo = b0 === 0xe0 ? 0xa0 : 0x80;
    const hi = b0 === 0xed ? 0x9f : 0xbf;
    if (pos + 1 >= end) { lastLen = 1; return 0xfffd; }
    const b1 = src[pos + 1] | 0;
    if (b1 < lo || b1 > hi) { lastLen = 1; return 0xfffd; }
    if (pos + 2 >= end) { lastLen = 2; return 0xfffd; }
    const b2 = src[pos + 2] | 0;
    if ((b2 & 0xc0) !== 0x80) { lastLen = 2; return 0xfffd; }
    lastLen = 3;
    return ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
  }
  const lo4 = b0 === 0xf0 ? 0x90 : 0x80;
  const hi4 = b0 === 0xf4 ? 0x8f : 0xbf;
  if (pos + 1 >= end) { lastLen = 1; return 0xfffd; }
  const c1 = src[pos + 1] | 0;
  if (c1 < lo4 || c1 > hi4) { lastLen = 1; return 0xfffd; }
  if (pos + 2 >= end) { lastLen = 2; return 0xfffd; }
  const c2 = src[pos + 2] | 0;
  if ((c2 & 0xc0) !== 0x80) { lastLen = 2; return 0xfffd; }
  if (pos + 3 >= end) { lastLen = 3; return 0xfffd; }
  const c3 = src[pos + 3] | 0;
  if ((c3 & 0xc0) !== 0x80) { lastLen = 3; return 0xfffd; }
  lastLen = 4;
  return ((b0 & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
}

// Decodes the character that ends at src[end) (start <= end - 1). Invalid bytes give U+FFFD (one byte).
export function decodeUtf8Back(src: Uint8Array, start: number, end: number): number {
  const last = src[end - 1] | 0;
  if (last < 0x80) { lastLen = 1; return last; }
  // Find the lead byte within 4 bytes.
  let i = end - 1;
  const stop = end - 4 < start ? start : end - 4;
  while (i > stop && ((src[i] | 0) & 0xc0) === 0x80) i = i - 1;
  const cp = decodeUtf8(src, i, end);
  if (i + lastLen === end) return cp;
  lastLen = 1;
  return 0xfffd;
}

// Appends the UTF-8 encoding of a code point (lone surrogates are encoded as 3 bytes, like WTF-8).
export function encodeUtf8(out: ByteBuf, cp: number): void {
  if (cp < 0x80) out.push(cp);
  else if (cp < 0x800) {
    out.push(0xc0 | (cp >> 6));
    out.push(0x80 | (cp & 0x3f));
  } else if (cp < 0x10000) {
    out.push(0xe0 | (cp >> 12));
    out.push(0x80 | ((cp >> 6) & 0x3f));
    out.push(0x80 | (cp & 0x3f));
  } else {
    out.push(0xf0 | (cp >> 18));
    out.push(0x80 | ((cp >> 12) & 0x3f));
    out.push(0x80 | ((cp >> 6) & 0x3f));
    out.push(0x80 | (cp & 0x3f));
  }
}

// Whether src[start, end) is all ASCII.
export function isAscii(src: Uint8Array, start: number, end: number): boolean {
  let acc = 0;
  for (let i = start; i < end; i++) acc = acc | (src[i] | 0);
  return (acc & 0x80) === 0;
}

// Number of UTF-16 code units of the UTF-8 text src[start, end) (Prettier counts positions in code units;
// `rangeStart`, `rangeEnd`, `cursorOffset`). A 4-byte sequence is a surrogate pair.
export function utf16Len(src: Uint8Array, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) {
    const b = src[i] | 0;
    if ((b & 0xc0) !== 0x80) n = n + 1;
    if (b >= 0xf0) n = n + 1;
  }
  return n;
}

// Byte offset in src[start, end) of the UTF-16 code unit offset `units` (clamped to `end`).
export function byteOffsetOfUtf16(src: Uint8Array, start: number, end: number, units: number): number {
  let n = 0;
  let i = start;
  while (i < end && n < units) {
    const b = src[i] | 0;
    if (b < 0x80) { n = n + 1; i = i + 1; continue; }
    const cp = decodeUtf8(src, i, end);
    n = n + (cp >= 0x10000 ? 2 : 1);
    i = i + lastLen;
  }
  return i;
}
