// Port of vendor/bun/src/format/markdown/spans.rs: what is in a paragraph and is not CommonMark's or GFM's as `bun_md` reads
// them: links that are not marked as such as micromark finds them, math. And how micromark and mdast write down a title
// and a text with NUL in it.
//
// Functions take `(bytes, start, end)`: the text of the paragraph is `bytes[start, end)`, and every index they take or
// return is an absolute index into `bytes`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { decodeUtf8, utf8Len } from "../../base/utf8.ts";
import {
  CLASS_OTHER,
  CLASS_PUNCTUATION,
  CLASS_WHITESPACE,
  classify,
  containsByte,
  indexOfStr,
  isAsciiAlnum,
  isAsciiAlpha,
  isAsciiDigit,
  lineEndIn,
  unescape,
} from "./strings.ts";

function isSpace(b: number): boolean {
  return b === 32 || b === 9;
}

function isAsciiControl(b: number): boolean {
  return b < 32 || b === 127;
}

function skipSpaces(buf: Uint8Array, index: number, end: number): number {
  let i = index;
  while (i < end && isSpace(buf[i] | 0)) i = ((i | 0) + 1) | 0;
  return i;
}

const titleScratch = new ByteBuf(256);

// A title without the indentation of its lines, appended to `out`.
export function pushTitle(buf: Uint8Array, start: number, end: number, out: ByteBuf): void {
  if (!containsByte(buf, start, end, 10)) {
    unescape(buf, start, end, out);
    return;
  }
  const stripped = titleScratch;
  stripped.reset();
  let from = start;
  let first = true;
  while (true) {
    let lineEnd = lineEndIn(buf, from, end);
    if (first) {
      stripped.append(buf, from, lineEnd);
      first = false;
    } else {
      stripped.push(10);
      stripped.append(buf, skipSpaces(buf, from, lineEnd), lineEnd);
    }
    if (lineEnd >= end) break;
    from = lineEnd + 1;
  }
  unescape(stripped.data, 0, stripped.len, out);
}

// The code point at `bytes[index]` as micromark's regexes see it (an UTF-16 unit): beyond U+FFFF it is "other". -1 at the end.
function classUnitAt(bytes: Uint8Array, index: number, end: number): number {
  if (index >= end) return CLASS_WHITESPACE;
  const b = bytes[index] | 0;
  if (b < 0x80) return classify(b);
  const c = decodeUtf8(bytes, index, end);
  if (c > 0xffff) return CLASS_OTHER;
  return classify(c);
}

function isWhitespaceAt(bytes: Uint8Array, index: number, end: number): boolean {
  return classUnitAt(bytes, index, end) === CLASS_WHITESPACE;
}

function charLenAt(bytes: Uint8Array, index: number, end: number): number {
  if (index >= end) return 1;
  if ((bytes[index] | 0) < 0x80) return 1;
  decodeUtf8(bytes, index, end);
  return utf8Len();
}

// `tokenizeTrail`: whether what is at `index` is punctuation at the end of a link, which is not part of it.
function isTrail(bytes: Uint8Array, start: number, end: number, from: number): boolean {
  let index = from;
  while (true) {
    const b = index < end ? bytes[index] | 0 : -1;
    if (b === 33 || b === 34 || b === 39 || b === 41 || b === 42 || b === 44 || b === 46 || b === 58 || b === 59 || b === 63 || b === 95 || b === 126) {
      index = index + 1;
    } else if (b === 38) {
      let letters = 0;
      while (index + 1 + letters < end && isAsciiAlpha(bytes[index + 1 + letters] | 0)) letters = letters + 1;
      if (letters === 0 || index + 1 + letters >= end || (bytes[index + 1 + letters] | 0) !== 59) return false;
      index = index + letters + 2;
    } else if (b === 93) {
      index = index + 1;
      if (index >= end || (bytes[index] | 0) === 40 || (bytes[index] | 0) === 91 || isWhitespaceAt(bytes, index, end)) return true;
    } else if (b === 60 || b === -1) {
      return true;
    } else {
      return isWhitespaceAt(bytes, index, end);
    }
  }
}

// `tokenizeDomain`: where the domain at `start` ends, or -1.
function parseDomain(bytes: Uint8Array, start: number, end: number): number {
  let inLast = false;
  let inLastButOne = false;
  let hasData = false;
  let index = start;
  while (true) {
    if (index >= end) break;
    const byte = bytes[index] | 0;
    if (byte === 46 || byte === 95) {
      if (isTrail(bytes, start, end, index)) break;
      if (byte === 95) inLast = true;
      else {
        inLastButOne = inLast;
        inLast = false;
      }
      index = index + 1;
    } else {
      const cls = classUnitAt(bytes, index, end);
      if (cls === CLASS_WHITESPACE || (byte !== 45 && cls === CLASS_PUNCTUATION)) break;
      hasData = true;
      index = index + charLenAt(bytes, index, end);
    }
  }
  return !inLast && !inLastButOne && hasData ? index : -1;
}

// `tokenizePath`: where the path at `start` ends.
function parsePath(bytes: Uint8Array, start: number, end: number): number {
  let open = 0;
  let close = 0;
  let index = start;
  while (true) {
    if (index >= end) return index;
    const byte = bytes[index] | 0;
    if (byte === 40) {
      open = open + 1;
      index = index + 1;
    } else if (byte === 41 && close < open) {
      close = close + 1;
      index = index + 1;
    } else if (
      byte === 33 || byte === 34 || byte === 38 || byte === 39 || byte === 41 || byte === 42 || byte === 44 || byte === 46 || byte === 58 ||
      byte === 59 || byte === 60 || byte === 63 || byte === 93 || byte === 95 || byte === 126
    ) {
      if (isTrail(bytes, start, end, index)) return index;
      if (byte === 41) close = close + 1;
      index = index + 1;
    } else if (isWhitespaceAt(bytes, index, end)) {
      return index;
    } else {
      index = index + charLenAt(bytes, index, end);
    }
  }
}

export function isGfmAtext(b: number): boolean {
  return b === 43 || b === 45 || b === 46 || b === 95 || isAsciiAlnum(b);
}

// `tokenizeEmailAutolink`: where the address at `start` ends, or -1.
export function parseEmailLiteral(bytes: Uint8Array, start: number, end: number): number {
  let name = 0;
  while (start + name < end && isGfmAtext(bytes[start + name] | 0)) name = name + 1;
  if (name === 0 || start + name >= end || (bytes[start + name] | 0) !== 64) return -1;
  let index = start + name + 1;
  let hasData = false;
  let hasDot = false;
  while (index < end) {
    const b = bytes[index] | 0;
    if (b === 46 && index + 1 < end && isAsciiAlnum(bytes[index + 1] | 0)) hasDot = true;
    else if (b === 45 || b === 95 || isAsciiAlnum(b)) hasData = true;
    else break;
    index = index + 1;
  }
  return hasData && hasDot && isAsciiAlpha(bytes[index - 1] | 0) ? index : -1;
}

function eqIgnoreCase4(bytes: Uint8Array, at: number): boolean {
  return (
    ((bytes[at] | 0) | 32) === 119 && ((bytes[at + 1] | 0) | 32) === 119 && ((bytes[at + 2] | 0) | 32) === 119 && (bytes[at + 3] | 0) === 46
  );
}

// `tokenizeWwwAutolink`: where the link at `start` ends, or -1.
export function parseWwwLiteral(bytes: Uint8Array, start: number, end: number): number {
  if (start + 4 > end || !eqIgnoreCase4(bytes, start) || end === start + 4) return -1;
  const domain = parseDomain(bytes, start, end);
  if (domain < 0) return -1;
  return parsePath(bytes, domain, end);
}

function startsWithCi(bytes: Uint8Array, at: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (at + n > end) return false;
  for (let i = 0; i < n; i++) {
    let c = bytes[at + i] | 0;
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== lit.charCodeAt(i)) return false;
  }
  return true;
}

// `tokenizeProtocolAutolink`: where the link at `start` ends, or -1.
export function parseProtocolLiteral(bytes: Uint8Array, start: number, end: number): number {
  let len = 0;
  if (startsWithCi(bytes, start, end, "https://")) len = 8;
  else if (startsWithCi(bytes, start, end, "http://")) len = 7;
  else return -1;
  const after = start + len;
  if (after >= end) return -1;
  const first = bytes[after] | 0;
  if (isAsciiControl(first) || classUnitAt(bytes, after, end) !== CLASS_OTHER) return -1;
  const domain = parseDomain(bytes, after, end);
  if (domain < 0) return -1;
  return parsePath(bytes, domain, end);
}

// bytes[start, end) with `nul` (a range of `nulBuf`) in the place of each NUL, appended to `out`.
export function pushWithoutNul(bytes: Uint8Array, start: number, end: number, nul: Uint8Array, out: ByteBuf): void {
  let from = start;
  for (let i = start; i < end; i++) {
    if ((bytes[i] | 0) === 0) {
      out.append(bytes, from, i);
      out.append(nul, 0, nul.length);
      from = i + 1;
    }
  }
  out.append(bytes, from, end);
}

// Prettier's `COMMENT_REGEX`, anywhere in `html`: `<!---->|<!---?[^>-](?:-?[^-])*-->`
export function hasHtmlComment(html: Uint8Array, start: number, end: number): boolean {
  let from = start;
  while (true) {
    const at = indexOfStr(html, from, end, "<!--");
    if (at < 0) return false;
    const s = at + 4;
    if (s + 3 <= end && (html[s] | 0) === 45 && (html[s + 1] | 0) === 45 && (html[s + 2] | 0) === 62) return true;
    // An optional dash, something that is neither `>` nor a dash, then no two dashes in a row before `-->`.
    const first = s + (s < end && (html[s] | 0) === 45 ? 1 : 0);
    if (first < end && (html[first] | 0) !== 62 && (html[first] | 0) !== 45) {
      const dashes = indexOfStr(html, first, end, "--");
      if (dashes >= 0 && dashes + 2 < end && (html[dashes + 2] | 0) === 62) return true;
    }
    from = s;
  }
}

// remark-math 3: where the `$ .. $` or `$$ .. $$` at `start` ends, or -1.
export function findMathEnd(bytes: Uint8Array, start: number, end: number): number {
  const isDouble = start + 1 < end && (bytes[start + 1] | 0) === 36;
  let index = start + 1 + (isDouble ? 1 : 0);
  if (index < end && isSpace(bytes[index] | 0)) return -1;
  while (index < end) {
    const byte = bytes[index] | 0;
    const next = index + 1 < end ? bytes[index + 1] | 0 : -1;
    if (byte === 36 && !isSpace(bytes[index - 1] | 0) && !(next >= 48 && next <= 57) && (!isDouble || next === 36)) {
      return index + 1 + (isDouble ? 1 : 0);
    }
    if (byte === 92) index = index + 1;
    index = index + 1;
  }
  return -1;
}

// Where the run of exactly `size` times `marker` ends that closes code or math whose content starts at `from`, or -1.
export function findClosingRun(bytes: Uint8Array, from0: number, end: number, marker: number, size: number): number {
  let from = from0;
  while (true) {
    while (from < end && (bytes[from] | 0) !== marker) from = from + 1;
    if (from >= end) return -1;
    let run = 0;
    while (from + run < end && (bytes[from + run] | 0) === marker) run = run + 1;
    from = from + run;
    if (run === size) return from;
  }
}

export { isAsciiDigit };
