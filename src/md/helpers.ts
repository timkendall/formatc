// Port of vendor/bun/src/md/helpers.rs.
//
// Byte classes come from one 256-entry table. All functions that take a byte expect 0..255 (a `| 0`-ed Uint8Array read).
import { ALNUM_RANGES, PUNCT_RANGES } from "./tables.ts";
import { decodeB36 } from "./unicode.ts";
import { entityCodepoint0, entityCodepoint1, lookupEntity } from "./entity.ts";
import { TX_BR, TX_ENTITY, TX_HTML, TX_NULLCHAR, TX_SOFTBR } from "./types.ts";
import { ByteBuf } from "./buf.ts";
import type { Parser } from "./state.ts";

const C_BLANK = 1;
const C_NEWLINE = 2;
const C_WS = 4;
const C_ALPHA = 8;
const C_DIGIT = 16;
const C_PUNCT = 32;
const C_HEX = 64;

const CT = new Uint8Array(256);
for (let c = 0; c < 256; c++) {
  let k = 0;
  if (c === 32 || c === 9) k |= C_BLANK;
  if (c === 10 || c === 13) k |= C_NEWLINE;
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) k |= C_WS;
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) k |= C_ALPHA;
  if (c >= 48 && c <= 57) k |= C_DIGIT;
  if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) k |= C_PUNCT;
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) k |= C_HEX;
  CT[c] = k;
}

/** Check if a byte is ASCII whitespace (space, tab, LF, CR, FF, VT). */
export function isWhitespace(c: number): boolean {
  return ((CT[c & 255] | 0) & C_WS) !== 0;
}

/** Check if a byte is a blank character (space or tab). */
export function isBlank(c: number): boolean {
  return ((CT[c & 255] | 0) & C_BLANK) !== 0;
}

/** Check if a byte is a newline (CR or LF). */
export function isNewline(c: number): boolean {
  return ((CT[c & 255] | 0) & C_NEWLINE) !== 0;
}

export function isAlphaNum(c: number): boolean {
  return ((CT[c & 255] | 0) & (C_ALPHA | C_DIGIT)) !== 0;
}

export function isAlpha(c: number): boolean {
  return ((CT[c & 255] | 0) & C_ALPHA) !== 0;
}

export function isDigit(c: number): boolean {
  return ((CT[c & 255] | 0) & C_DIGIT) !== 0;
}

export function isHexDigit(c: number): boolean {
  return ((CT[c & 255] | 0) & C_HEX) !== 0;
}

/** Check if byte is ASCII punctuation per CommonMark spec. */
export function isAsciiPunctuation(c: number): boolean {
  return ((CT[c & 255] | 0) & C_PUNCT) !== 0;
}

/** U+0020, U+00A0, U+1680, U+2000..U+200A, U+202F, U+205F, U+3000 (Unicode category Zs). */
export function isUnicodeSpaceSeparator(cp: number): boolean {
  return (
    cp === 0x20 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** Check if a Unicode codepoint is whitespace per CommonMark spec. This includes ASCII whitespace + Unicode Zs category. */
export function isUnicodeWhitespace(codepoint: number): boolean {
  if (codepoint < 128) return isWhitespace(codepoint);
  return isUnicodeSpaceSeparator(codepoint);
}

// [lo0, hi0, lo1, hi1, ...] of the ranges, decoded on first use.
let punct: Int32Array = new Int32Array(0);
let alnum: Int32Array = new Int32Array(0);

function decodeRanges(src: string): Int32Array {
  const d = decodeB36(src, 0, src.length);
  let prev = 0;
  for (let i = 0; i < d.length; i += 2) {
    const lo = prev + (d[i] | 0);
    const hi = lo + (d[i + 1] | 0);
    d[i] = lo | 0;
    d[i + 1] = hi | 0;
    prev = hi;
  }
  return d;
}

function inRanges(r: Int32Array, codepoint: number): boolean {
  let lo = 0;
  let hi = (r.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (codepoint < (r[2 * mid] | 0)) hi = mid - 1;
    else if (codepoint > (r[2 * mid + 1] | 0)) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Check if a Unicode codepoint is punctuation per CommonMark spec. */
export function isUnicodePunctuation(codepoint: number): boolean {
  if (codepoint < 128) return isAsciiPunctuation(codepoint);
  // Unicode categories Pc, Pd, Pe, Pf, Pi, Po, Ps, Sc, Sk, Sm, So
  if (punct.length === 0) punct = decodeRanges(PUNCT_RANGES);
  return inRanges(punct, codepoint);
}

/** Rust's `char::is_alphanumeric` for a codepoint (used by `:::name`). */
export function isUnicodeAlphanumeric(codepoint: number): boolean {
  if (codepoint < 128) return isAlphaNum(codepoint);
  if (alnum.length === 0) alnum = decodeRanges(ALNUM_RANGES);
  return inRanges(alnum, codepoint);
}

/** `buf[0, len)` without the spaces and tabs at its end: returns the new length. */
export function trimBlankEnd(buf: Uint8Array, off: number, len: number): number {
  let n = len;
  while (n > 0) {
    const c = buf[off + n - 1] | 0;
    if (c !== 32 && c !== 9) break;
    n = ((n | 0) - 1) | 0;
  }
  return n;
}

/**
 * The indentation of a line starting from `off`, counting spaces and tabs. Returns the new offset (past the white
 * space); the indent width is in `p.liIndent`.
 */
export function lineIndentation(p: Parser, text: Uint8Array, totalIndent: number, offStart: number): number {
  const size = text.length | 0;
  const ti = totalIndent | 0;
  let off = offStart | 0;
  let indent = 0;
  while (off < size) {
    const c = text[off] | 0;
    if (c === 32) {
      indent = ((indent | 0) + 1) | 0;
    } else if (c === 9) {
      indent = ((((((ti + indent) | 0) + 4) >> 2) << 2) - ti) | 0;
    } else {
      break;
    }
    off = ((off | 0) + 1) | 0;
  }
  p.liIndent = indent;
  return off;
}

/** The length of the sequence decoded last by `decodeUtf8`/`decodeUtf8Backward`. */
export class Utf8Len {
  len = 1;
}
export const UTF8 = new Utf8Len();

/**
 * Decodes a UTF-8 codepoint of `buf[base, base + size)` at `off` (relative to `base`). Returns the codepoint; its
 * length is in `UTF8.len`.
 */
export function decodeUtf8(buf: Uint8Array, base: number, size: number, off: number): number {
  const UTF8$ = UTF8;
  if (off >= size) {
    UTF8$.len = 1;
    return 0;
  }
  const b0 = buf[base + off] | 0;
  if (b0 < 0x80) {
    UTF8$.len = 1;
    return b0;
  }
  // utf8_byte_sequence_length
  const seqLen = (b0 & 0xe0) === 0xc0 ? 2 : (b0 & 0xf0) === 0xe0 ? 3 : (b0 & 0xf8) === 0xf0 ? 4 : 0;
  if (seqLen === 0) {
    UTF8$.len = 1;
    return 0xfffd;
  }
  if (size - off < seqLen) {
    UTF8$.len = 1;
    return 0xfffd;
  }
  UTF8$.len = seqLen;
  // decode_wtf8_rune_t(buf, seq_len, 0xFFFD)
  const s1 = buf[base + off + 1] | 0;
  if ((s1 & 0xc0) !== 0x80) return 0xfffd;
  if (seqLen === 2) {
    const cp = ((b0 & 0x1f) << 6) | (s1 & 0x3f);
    return cp < 0x80 ? 0xfffd : cp;
  }
  const s2 = buf[base + off + 2] | 0;
  if ((s2 & 0xc0) !== 0x80) return 0xfffd;
  if (seqLen === 3) {
    const cp = ((b0 & 0x0f) << 12) | ((s1 & 0x3f) << 6) | (s2 & 0x3f);
    return cp < 0x800 ? 0xfffd : cp;
  }
  const s3 = buf[base + off + 3] | 0;
  if ((s3 & 0xc0) !== 0x80) return 0xfffd;
  const cp = ((b0 & 0x07) << 18) | ((s1 & 0x3f) << 12) | ((s2 & 0x3f) << 6) | (s3 & 0x3f);
  return cp < 0x10000 || cp > 0x10ffff ? 0xfffd : cp;
}

/** Decodes the codepoint ending just before `off`: the codepoint whose last byte is at `off - 1`. */
export function decodeUtf8Backward(buf: Uint8Array, base: number, size: number, off: number): number {
  const UTF8$ = UTF8;
  if (off === 0 || off > size) {
    UTF8$.len = 1;
    return 0;
  }
  const last = buf[base + off - 1] | 0;
  if (last < 0x80) {
    UTF8$.len = 1;
    return last;
  }
  // Walk back over continuation bytes (10xxxxxx)
  let start = off - 1;
  while (start > 0 && ((buf[base + start] | 0) & 0xc0) === 0x80) start = ((start | 0) - 1) | 0;
  return decodeUtf8(buf, base, size, start);
}

/** Encodes a Unicode codepoint as UTF-8 (WTF-8: surrogates too) into `out[at..]`. Returns the length. */
export function encodeUtf8(codepoint: number, out: Uint8Array, at: number): number {
  if (codepoint < 0x80) {
    out[at] = codepoint | 0;
    return 1;
  }
  if (codepoint < 0x800) {
    out[at] = (0xc0 | (codepoint >> 6)) | 0;
    out[at + 1] = (0x80 | (codepoint & 0x3f)) | 0;
    return 2;
  }
  if (codepoint < 0x10000) {
    out[at] = (0xe0 | (codepoint >> 12)) | 0;
    out[at + 1] = (0x80 | ((codepoint >> 6) & 0x3f)) | 0;
    out[at + 2] = (0x80 | (codepoint & 0x3f)) | 0;
    return 3;
  }
  out[at] = (0xf0 | (codepoint >> 18)) | 0;
  out[at + 1] = (0x80 | ((codepoint >> 12) & 0x3f)) | 0;
  out[at + 2] = (0x80 | ((codepoint >> 6) & 0x3f)) | 0;
  out[at + 3] = (0x80 | (codepoint & 0x3f)) | 0;
  return 4;
}

/** Does `buf[start, start + lit.length)` equal `lit` (lowercase ASCII) ignoring ASCII case? The caller checked the bounds. */
export function ciEqLit(buf: Uint8Array, start: number, lit: string): boolean {
  const n = lit.length;
  for (let i = 0; i < n; i++) {
    let c = buf[start + i] | 0;
    if (c >= 65 && c <= 90) c = ((c | 0) + ((32) | 0)) | 0;
    if (c !== (lit.charCodeAt(i) | 0)) return false;
  }
  return true;
}

/**
 * Finds an HTML entity starting at `start` (which must point to '&') in the content `buf[off, off + len)`. Returns the
 * end position (one past the ';', relative to `off`) or -1 if no valid entity is found.
 */
export function findEntity(buf: Uint8Array, off: number, len: number, start: number): number {
  if (start + 2 >= len) return -1;

  // Numeric entity
  if ((buf[off + start + 1] | 0) === 35) {
    let pos = start + 2;
    const x = pos < len ? buf[off + pos] | 0 : 0;
    if (pos < len && (x === 120 || x === 88)) {
      // Hex
      pos = ((pos | 0) + 1) | 0;
      const digitStart = pos;
      while (pos < len && isHexDigit(buf[off + pos] | 0) && pos - digitStart < 6) pos = ((pos | 0) + 1) | 0;
      if (pos > digitStart && pos < len && (buf[off + pos] | 0) === 59) return pos + 1;
    } else {
      // Decimal
      const digitStart = pos;
      while (pos < len && isDigit(buf[off + pos] | 0) && pos - digitStart < 7) pos = ((pos | 0) + 1) | 0;
      if (pos > digitStart && pos < len && (buf[off + pos] | 0) === 59) return pos + 1;
    }
    return -1;
  }

  // Named entity
  let pos = start + 1;
  if (pos < len && isAlpha(buf[off + pos] | 0)) {
    pos = ((pos | 0) + 1) | 0;
    while (pos < len && isAlphaNum(buf[off + pos] | 0) && pos - start < 48) pos = ((pos | 0) + 1) | 0;
    if (pos < len && (buf[off + pos] | 0) === 59) {
      if (lookupEntity(buf, off + start, off + pos + 1) >= 0) return pos + 1;
    }
  }
  return -1;
}

/**
 * Parses a numeric character reference (&#DDD; or &#xHHH;) in `buf[s, e)` and returns the codepoint, -1 if it is none.
 */
export function parseEntityCodepoint(buf: Uint8Array, s: number, e: number): number {
  if (e - s < 4 || (buf[s] | 0) !== 38 || (buf[s + 1] | 0) !== 35) return -1;
  let cp = 0;
  const x = buf[s + 2] | 0;
  if (x === 120 || x === 88) {
    for (let i = s + 3; i < e; i++) {
      const ec = buf[i] | 0;
      if (ec === 59) break;
      // md4c is lenient on bad hex (`_ => 0`).
      let v = 0;
      if (ec >= 48 && ec <= 57) v = ec - 48;
      else if (ec >= 97 && ec <= 102) v = ec - 87;
      else if (ec >= 65 && ec <= 70) v = ec - 55;
      cp = (Math.imul(cp, 16) + v) >>> 0;
    }
  } else {
    for (let i = s + 2; i < e; i++) {
      const ec = buf[i] | 0;
      if (ec === 59) break;
      cp = (Math.imul(cp, 10) + ((ec - 48) & 255)) >>> 0;
    }
  }
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return cp;
}

/**
 * Decodes an HTML entity `buf[s, e)` to raw UTF-8 bytes into `out` (at least 8 bytes). Returns the length, -1 for
 * unknown entities.
 */
export function decodeEntityToUtf8(buf: Uint8Array, s: number, e: number, out: Uint8Array): number {
  const cp = parseEntityCodepoint(buf, s, e);
  if (cp >= 0) return encodeUtf8(cp, out, 0);
  const index = lookupEntity(buf, s, e);
  if (index < 0) return -1;
  const len1 = encodeUtf8(entityCodepoint0(index), out, 0);
  const cp1 = entityCodepoint1(index);
  if (cp1 !== 0) return (len1 + encodeUtf8(cp1, out, len1)) | 0;
  return len1;
}

// ---- heading ids ----

/**
 * Generates a GitHub-compatible slug from the text content of `buf` (modified in place). Returns the slug as a string
 * (it is ASCII only). Uses `slugCounts` for -N deduplication.
 */
export function generateSlug(buf: ByteBuf, slugCounts: Map<string, number>): string {
  const data = buf.data;
  const textLen = buf.len;
  let outLen = 0;
  let prevHyphen = true; // true to trim leading hyphens
  for (let idx = 0; idx < textLen; idx++) {
    const c = data[idx] | 0;
    if (c >= 65 && c <= 90) {
      data[outLen] = (c + 32) | 0;
      outLen = ((outLen | 0) + 1) | 0;
      prevHyphen = false;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      data[outLen] = c | 0;
      outLen = ((outLen | 0) + 1) | 0;
      prevHyphen = false;
    } else if (c === 45 || c === 32) {
      if (!prevHyphen) {
        data[outLen] = 45;
        outLen = ((outLen | 0) + 1) | 0;
        prevHyphen = true;
      }
    }
    // else: skip non-alphanumeric characters
  }
  // Trim trailing hyphens
  while (outLen > 0 && (data[outLen - 1] | 0) === 45) outLen = ((outLen | 0) - 1) | 0;
  let slug = "";
  for (let i = 0; i < outLen; i++) slug += String.fromCharCode(data[i] | 0);
  const seen = slugCounts.get(slug);
  if (seen === undefined) {
    slugCounts.set(slug, 0);
    return slug;
  }
  // Already seen -- append -N suffix
  const count = seen + 1;
  slugCounts.set(slug, count);
  return slug + "-" + count;
}

/**
 * Shared heading-ID state used by all renderers. Tracks whether we're inside a heading, accumulates text for slug
 * generation, and deduplicates slugs via a count map.
 */
export class HeadingIdTracker {
  enabled = false;
  inHeading = false;
  textBuf: ByteBuf = new ByteBuf(64);
  slugCounts: Map<string, number> = new Map<string, number>();
  private entityOut: Uint8Array = new Uint8Array(8);

  init(enabled: boolean): void {
    this.enabled = enabled;
    this.inHeading = false;
    this.textBuf.reset();
    this.slugCounts.clear();
  }

  /** Call on entering a heading block. */
  enterHeading(): void {
    if (this.enabled) this.inHeading = true;
  }

  /** Call from the text callback to accumulate text for the slug. No-op if not inside a heading or disabled. */
  trackText(textType: number, buf: Uint8Array, start: number, end: number): void {
    if (!this.inHeading) return;
    const t = this.textBuf;
    if (textType === TX_NULLCHAR) {
      t.push(0xef);
      t.push(0xbf);
      t.push(0xbd);
    } else if (textType === TX_BR || textType === TX_SOFTBR) {
      t.push(32);
    } else if (textType === TX_HTML) {
      // skip HTML tags in slug
    } else if (textType === TX_ENTITY) {
      const n = decodeEntityToUtf8(buf, start, end, this.entityOut);
      if (n >= 0) t.append(this.entityOut, 0, n);
      else t.append(buf, start, end);
    } else {
      t.append(buf, start, end);
    }
  }

  /** Call on leaving a heading block. Returns the slug (null if disabled). */
  leaveHeading(): string | null {
    if (!this.enabled) return null;
    this.inHeading = false;
    return generateSlug(this.textBuf, this.slugCounts);
  }

  /** Call after using the slug to reset the text buffer. */
  clearAfterHeading(): void {
    this.textBuf.reset();
  }
}
