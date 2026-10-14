// Port of vendor/bun/src/format/ir/width.rs: Prettier's `getStringWidth`: the number of columns that a text takes.
import { FLAVOR_OXFMT } from "../options.ts";
import { EMOJI, EMOJI_MODIFIER_BASE, NARROW_EMOJI, OXFMT_ZERO_WIDTH, WIDE } from "./width_tables.ts";
import { decodeUtf8, utf8Len } from "../../base/utf8.ts";
import { twMultiline, twSingle } from "./element.ts";

// Binary search in a table of flattened inclusive ranges [lo0, hi0, lo1, hi1, ...].
function isIn(table: Int32Array, c: number): boolean {
  let lo = 0;
  let hi = table.length >> 1;
  // partition_point: the number of ranges whose start is <= c
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((table[mid * 2] | 0) <= c) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && c <= (table[(lo - 1) * 2 + 1] | 0);
}

const VARIATION_SELECTOR_16 = 0xfe0f;
const ZERO_WIDTH_JOINER = 0x200d;
const COMBINING_ENCLOSING_KEYCAP = 0x20e3;

function isSkinTone(c: number): boolean {
  return c >= 0x1f3fb && c <= 0x1f3ff;
}

function isRegionalIndicator(c: number): boolean {
  return c >= 0x1f1e6 && c <= 0x1f1ff;
}

// The characters of the text being measured (code points), and how many there are. Reused: per thread.
let chars = new Int32Array(256);
let charCount = 0;

function at(i: number): number {
  return i < charCount ? chars[i] | 0 : 0;
}

// The number of characters at chars[i..] that are one emoji, in the sense of the `emoji-regex` package. This accepts
// any sequence that is joined like an emoji, where the package only accepts those that are recommended for
// interchange.
function emojiLen(i: number): number {
  const first = at(i);
  if (first === 0x23 || first === 0x2a || (first >= 0x30 && first <= 0x39)) {
    const mark = at(i + 1) === VARIATION_SELECTOR_16 ? 2 : 1;
    return at(i + mark) === COMBINING_ENCLOSING_KEYCAP ? mark + 1 : 0;
  }
  if (isRegionalIndicator(first)) {
    return isRegionalIndicator(at(i + 1)) ? 2 : 0;
  }
  if (!isIn(EMOJI, first)) return 0;
  let len = 0;
  while (true) {
    const base = at(i + len);
    len = len + 1;
    if (at(i + len) === VARIATION_SELECTOR_16 || (isSkinTone(at(i + len)) && isIn(EMOJI_MODIFIER_BASE, base))) {
      len = len + 1;
    }
    // The flags of England, Scotland and Wales.
    if (base === 0x1f3f4 && at(i + len) >= 0xe0020 && at(i + len) <= 0xe007e) {
      while (at(i + len) >= 0xe0020 && at(i + len) <= 0xe007e) len = len + 1;
      if (at(i + len) === 0xe007f) len = len + 1;
    }
    if (at(i + len) === ZERO_WIDTH_JOINER && isIn(EMOJI, at(i + len + 1))) {
      len = len + 1;
    } else {
      return len;
    }
  }
}

// To the crate `unicode-width`, which oxfmt measures with, every character up to U+00A0 in a text is as wide as a
// letter. To Prettier a control character has no width.
function controlCharacterIsAColumn(flavor: number): boolean {
  return flavor === FLAVOR_OXFMT;
}

// 0x20 to 0x7E
function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

// Whether `c` takes no column of its own behind chars[0..end), to the crate `unicode-width`: the other ligatures that it
// knows, of which the previous one has one column.
function endsLigature(end: number, c: number): boolean {
  // A Khmer letter under another one.
  if (
    (c >= 0x1780 && c <= 0x1782) || (c >= 0x1784 && c <= 0x1787) || (c >= 0x1789 && c <= 0x178c) ||
    (c >= 0x178e && c <= 0x1793) || (c >= 0x1795 && c <= 0x1798) || (c >= 0x179b && c <= 0x179d) ||
    c === 0x17a0 || c === 0x17a2 || c === 0x17a7 || (c >= 0x17ab && c <= 0x17ac) || c === 0x17af
  ) {
    return end >= 1 && (chars[end - 1] | 0) === 0x17d2;
  }
  // Two tone letters of Lisu.
  if (c === 0xa4fc || c === 0xa4fd) {
    return end >= 1 && (chars[end - 1] | 0) >= 0xa4f8 && (chars[end - 1] | 0) <= 0xa4fb;
  }
  // Hebrew alef and lamed, two consonants of Tifinagh, Old Turkic, each with a joiner.
  if (c === 0x5dc) return end >= 2 && (chars[end - 2] | 0) === 0x5d0 && (chars[end - 1] | 0) === 0x200d;
  if ((c >= 0x2d31 && c <= 0x2d65) || c === 0x2d6f) {
    if (end < 2 || (chars[end - 1] | 0) !== 0x200d) return false;
    const p = chars[end - 2] | 0;
    return (p >= 0x2d31 && p <= 0x2d65) || p === 0x2d6f;
  }
  if (c === 0x10c03) return end >= 2 && (chars[end - 2] | 0) === 0x10c32 && (chars[end - 1] | 0) === 0x200d;
  return false;
}

// Width of the characters of text[start, end) (UTF-8 decoded; invalid bytes are U+FFFD).
function widthOfCharacters(text: Uint8Array, start: number, end: number, flavor: number): number {
  // Decode.
  let n = 0;
  let pos = start;
  if (chars.length < end - start + 1) chars = new Int32Array((end - start + 1) * 2);
  const cs = chars;
  while (pos < end) {
    const b = text[pos] | 0;
    if (b < 0x80) {
      cs[n] = b | 0;
      pos = pos + 1;
    } else {
      cs[n] = decodeUtf8(text, pos, end) | 0;
      pos = pos + utf8Len();
    }
    n = n + 1;
  }
  charCount = n;
  const oxfmt = flavor === FLAVOR_OXFMT;
  let width = 0;
  let i = 0;
  // To the crate `unicode-width`, an Arabic lam and the alef after it are one ligature.
  let followsLam = false;
  while (i < n) {
    const c = cs[i] | 0;
    const isAlefOfLigature =
      followsLam &&
      oxfmt &&
      (c === 0x622 || c === 0x623 || c === 0x625 || c === 0x627 || (c >= 0x671 && c <= 0x673) || c === 0x675 || c === 0x773 || c === 0x774);
    // A joiner or a non-joiner between them keeps them apart.
    followsLam =
      c === 0x644 || (c >= 0x6b5 && c <= 0x6b8) || c === 0x76a || c === 0x8a6 || c === 0x8c7 ||
      (followsLam &&
        isIn(OXFMT_ZERO_WIDTH, c) &&
        !(c === 0x605 || (c >= 0x890 && c <= 0x891) || c === 0x8e2 || (c >= 0x200c && c <= 0x200d) || (c >= 0x2065 && c <= 0x2069)));
    let el = emojiLen(i);
    // No emoji that `emoji-regex` knows starts with a skin tone: the joiner behind it is a column.
    if (el >= 2 && isSkinTone(c) && !oxfmt) el = 1;
    if (el !== 0) {
      width = width + (el === 1 && isIn(NARROW_EMOJI, c) ? 1 : 2);
      i = i + el;
      continue;
    }
    i = i + 1;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) width = width + (controlCharacterIsAColumn(flavor) ? 1 : 0);
    else if (c <= 0x7e) width = width + 1;
    else if ((c >= 0x300 && c <= 0x36f) || (c >= 0xfe00 && c <= 0xfe0f)) width = width + 0;
    else if (isAlefOfLigature) width = width + 0;
    else if (oxfmt && endsLigature(i - 1, c)) width = width + 0;
    else if (oxfmt && isIn(OXFMT_ZERO_WIDTH, c)) width = width + 0;
    else if (isIn(WIDE, c)) width = width + 2;
    else width = width + 1;
  }
  return width;
}

function widthOfNonAscii(text: Uint8Array, start: number, end: number, flavor: number): number {
  let width = 0;
  let rest = start;
  const control = controlCharacterIsAColumn(flavor);
  // ASCII only takes a closer look next to other characters: `#` is an emoji before a keycap, or joined to one.
  while (rest < end) {
    let firstNonAscii = end;
    for (let i = rest; i < end; i++) {
      if ((text[i] | 0) >= 0x80) { firstNonAscii = i; break; }
    }
    const ascii = firstNonAscii - rest;
    const total = end - rest;
    const plain = ascii === total ? ascii : (ascii > 0 ? ascii - 1 : 0);
    for (let i = rest; i < rest + plain; i++) {
      const b = text[i] | 0;
      if (isPrintable(b) || control) width = width + 1;
    }
    rest = rest + plain;
    let len = ascii - plain;
    while (true) {
      while (rest + len < end && (text[rest + len] | 0) >= 0x80) len = len + 1;
      // ends with U+200D (E2 80 8D)?
      if (rest + len === end || !(len >= 3 && (text[rest + len - 3] | 0) === 0xe2 && (text[rest + len - 2] | 0) === 0x80 && (text[rest + len - 1] | 0) === 0x8d)) break;
      len = len + 1;
    }
    width = width + widthOfCharacters(text, rest, rest + len, flavor);
    rest = rest + len;
  }
  return width;
}

// Table: 1 for the bytes 0x20..=0x7F (what `stringWidth` counts one column each), else 0.
const PW = new Uint8Array(256);
// Table: 1 for the bytes 0x20..=0x7E (what `isAllPrintable` accepts), else 0.
const PRINT = new Uint8Array(256);
// Table: 1 for the bytes that make a 64-byte block of the source "odd" (see `markOddBlocks`).
const ODD = new Uint8Array(256);
for (let c = 0; c < 256; c++) {
  if (c >= 0x20 && c <= 0x7f) PW[c] = 1;
  if (c >= 0x20 && c <= 0x7e) PRINT[c] = 1;
  const plain = (c >= 0x20 && c <= 0x5b) || (c >= 0x5d && c <= 0x7e) || c === 9 || c === 10 || c === 13;
  ODD[c] = plain ? 0 : 1;
}

export function oddTable(): Uint8Array {
  return ODD;
}

/** Whether text[start, end) is one line of ASCII, as wide as it is long. */
export function isAllPrintable(text: Uint8Array, start: number, end: number): boolean {
  const table = PRINT; // module state is thread-local in worker programs: read it once
  const e = end | 0;
  let bad = 0;
  let i = start | 0;
  for (; (i + 4) <= e; i = (i + 4) | 0) {
    bad = bad | (table[text[i] | 0] | 0) ^ 1 | (table[text[(i + 1) | 0] | 0] | 0) ^ 1 | (table[text[(i + 2) | 0] | 0] | 0) ^ 1 |
      (table[text[(i + 3) | 0] | 0] | 0) ^ 1;
  }
  for (; i < e; i = (i + 1) | 0) bad = bad | (1 ^ (table[text[i] | 0] | 0));
  return bad === 0;
}

/** text[start, end) has no line breaks. Prettier's flavor. */
export function stringWidth(text: Uint8Array, start: number, end: number): number {
  return stringWidthAs(text, start, end, 0);
}

/** The same as `flavor` counts. */
export function stringWidthAs(text: Uint8Array, start: number, end: number, flavor: number): number {
  const table = PW;
  const e = end | 0;
  let bad = 0;
  let i = start | 0;
  for (; (i + 4) <= e; i = (i + 4) | 0) {
    bad = bad | (table[text[i] | 0] | 0) ^ 1 | (table[text[(i + 1) | 0] | 0] | 0) ^ 1 | (table[text[(i + 2) | 0] | 0] | 0) ^ 1 |
      (table[text[(i + 3) | 0] | 0] | 0) ^ 1;
  }
  for (; i < e; i = (i + 1) | 0) bad = bad | (1 ^ (table[text[i] | 0] | 0));
  if (bad === 0) return e - (start | 0);
  return widthOfNonAscii(text, start, end, flavor);
}

/**
 * The width of a text that can have tabs, `\n` and anything else, as `TextWidth` (packed: see element.ts). A tab counts as
 * `tabWidth`: nothing (0) like any control character, which is what Prettier's `getStringWidth` does, and for
 * oxfmt in JavaScript as wide as the indentation.
 */
export function textWidth(text: Uint8Array, start: number, end: number, flavor: number, tabWidth: number): number {
  if (isAllPrintable(text, start, end)) return twSingle(end - start);
  let width = 0;
  let rest = start;
  while (true) {
    let at = -1;
    const e = end | 0;
    for (let i = rest | 0; i < e; i = (i + 1) | 0) {
      const b = text[i] | 0;
      if (b === 9 || b === 10) { at = i; break; }
    }
    if (at < 0) return twSingle(width + stringWidthAs(text, rest, end, flavor));
    width = width + stringWidthAs(text, rest, at, flavor);
    if ((text[at] | 0) === 10) return twMultiline(width);
    width = width + tabWidth;
    rest = at + 1;
  }
}

/**
 * Marks the blocks of 64 bytes of `source` that have something in them that takes a closer look: a character whose
 * width is not 1, other than a tab or a line break, or a backslash (bytes other than 0x20..0x7E without 0x5C, tab,
 * `\n` and `\r`). Writes one byte per block into `out[0, nBlocks)` (1 = odd) and returns the number of blocks.
 */
export function markOddBlocks(source: Uint8Array, out: Uint8Array): number {
  const n = source.length;
  const blocks = (n + 63) >> 6;
  const table = ODD;
  for (let blk = 0; blk < blocks; blk++) {
    const s = blk << 6;
    const e = s + 64 < n ? s + 64 : n;
    let odd = 0;
    for (let i = s; i < e; i++) odd = odd | (table[source[i] | 0] | 0);
    out[blk] = odd | 0;
  }
  return blocks;
}
