// Port of vendor/bun/src/format/text.rs: what the printers of all languages ask of a text: Prettier's
// `src/utilities/` (skipSpaces, hasNewline, isNextLineEmpty, ...) and `makeString`.
//
// An index is an offset in bytes into a `Uint8Array` holding the whole text; `text.length` is its end. Where Prettier
// goes backwards from the index of a character, the functions here take the offset behind it:
// `hasNewline(text, index, { backwards: true })`, which starts at `index - 1`, is `hasNewlineBackwards(text, index)`.
// Out-of-range indexes are clamped like Rust's `.get(at..)`: nothing here reads outside `text`.
import { ByteBuf } from "../base/bytebuf.ts";
import { indexOfByte, eqAscii } from "../base/bytes.ts";
import { decodeUtf8, decodeUtf8Back, utf8Len } from "../base/utf8.ts";

export const BOM_LEN = 3;
// The UTF-8 byte order mark: EF BB BF.
export function startsWithBom(text: Uint8Array, at: number): boolean {
  return at + 2 < text.length && (text[at] | 0) === 0xef && (text[at + 1] | 0) === 0xbb && (text[at + 2] | 0) === 0xbf;
}

// The length in bytes of the character at text[at] that JavaScript's `\s` matches, or 0.
// `\s` = tab, LF, VT, FF, CR, space, NBSP (U+00A0), U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
export function jsWhitespaceLen(text: Uint8Array, at: number, end: number): number {
  if (at >= end) return 0;
  const b = text[at] | 0;
  if (b < 0x80) return (b === 0x20 || (b >= 0x09 && b <= 0x0d)) ? 1 : 0;
  if (b === 0xc2) return (at + 1 < end && (text[at + 1] | 0) === 0xa0) ? 2 : 0;
  if (b === 0xe1) return (at + 2 < end && (text[at + 1] | 0) === 0x9a && (text[at + 2] | 0) === 0x80) ? 3 : 0;
  if (b === 0xe2) {
    if (at + 2 >= end) return 0;
    const b1 = text[at + 1] | 0;
    const b2 = text[at + 2] | 0;
    if (b1 === 0x80) return ((b2 >= 0x80 && b2 <= 0x8a) || b2 === 0xa8 || b2 === 0xa9 || b2 === 0xaf) ? 3 : 0;
    if (b1 === 0x81 && b2 === 0x9f) return 3;
    return 0;
  }
  if (b === 0xe3) return (at + 2 < end && (text[at + 1] | 0) === 0x80 && (text[at + 2] | 0) === 0x80) ? 3 : 0;
  if (b === 0xef) return (at + 2 < end && (text[at + 1] | 0) === 0xbb && (text[at + 2] | 0) === 0xbf) ? 3 : 0;
  return 0;
}

// The length of the JS whitespace character that ends at text[end), or 0.
export function jsWhitespaceLenBack(text: Uint8Array, start: number, end: number): number {
  if (end <= start) return 0;
  const last = text[end - 1] | 0;
  if (last < 0x80) return (last === 0x20 || (last >= 0x09 && last <= 0x0d)) ? 1 : 0;
  // Multi-byte: test the candidates by looking 2 or 3 bytes back.
  if (end - 2 >= start && jsWhitespaceLen(text, end - 2, end) === 2) return 2;
  if (end - 3 >= start && jsWhitespaceLen(text, end - 3, end) === 3) return 3;
  return 0;
}

// `/^\s/.test(text)` for text[at, end)
export function startsWithWhiteSpace(text: Uint8Array, at: number, end: number): boolean {
  return jsWhitespaceLen(text, at, end) > 0;
}

// The index of the first character of text[start, end) that `\s` does not match (`trimStart`).
export function trimJsWhitespaceStart(text: Uint8Array, start: number, end: number): number {
  let i = start;
  while (i < end) {
    const n = jsWhitespaceLen(text, i, end);
    if (n === 0) break;
    i = i + n;
  }
  return i;
}

// The end of text[start, end) without its trailing `\s` (`trimEnd`).
export function trimJsWhitespaceEnd(text: Uint8Array, start: number, end: number): number {
  let e = end;
  while (e > start) {
    const n = jsWhitespaceLenBack(text, start, e);
    if (n === 0) break;
    e = e - n;
  }
  return e;
}

// The number of bytes of text[start, end) that are before its first character that `\s` does not match.
export function leadingWhiteSpaceLen(text: Uint8Array, start: number, end: number): number {
  return trimJsWhitespaceStart(text, start, end) - start;
}

// `text.indexOf(part, from)` for an ASCII `part` (a search in text[from, text.length)). -1 if absent.
export function indexOfFrom(text: Uint8Array, part: string, from: number): number {
  const n = part.length;
  const end = text.length - n;
  if (n === 0) return from <= text.length ? from : -1;
  const first = part.charCodeAt(0);
  for (let i = from < 0 ? 0 : from; i <= end; i++) {
    if ((text[i] | 0) === first && eqAscii(text, i, part)) return i;
  }
  return -1;
}

// A set of bytes, for the ends of tokens. 256-entry table.
export class ByteSet {
  table: Uint8Array;
  constructor(bytes: string) {
    this.table = new Uint8Array(256);
    for (let i = 0; i < bytes.length; i++) this.table[bytes.charCodeAt(i)] = 1;
  }
  has(b: number): boolean {
    return (this.table[b & 255] | 0) !== 0;
  }
  // The index of the first byte of text at or after `from` (and before `end`) that is in the set, or -1.
  find(text: Uint8Array, from: number, end: number): number {
    const t = this.table;
    for (let i = from; i < end; i++) {
      if ((t[text[i] | 0] | 0) !== 0) return i;
    }
    return -1;
  }
}

// `skipSpaces`: blanks and tabs.
export function skipSpaces(text: Uint8Array, at: number): number {
  const n = text.length;
  let i = at < 0 ? 0 : at;
  while (i < n) {
    const b = text[i] | 0;
    if (b !== 32 && b !== 9) break;
    i = i + 1;
  }
  return i;
}

// `skipSpaces(.., { backwards: true })`
export function skipSpacesBackwards(text: Uint8Array, end: number): number {
  let i = end > text.length ? text.length : end;
  while (i > 0) {
    const b = text[i - 1] | 0;
    if (b !== 32 && b !== 9) break;
    i = i - 1;
  }
  return i;
}

// The length of the line break at text[at]: `\r\n`, `\n`, `\r`, U+2028, U+2029. 0 if none.
export function jsLineBreakLen(text: Uint8Array, at: number): number {
  const n = text.length;
  if (at < 0 || at >= n) return 0;
  const b = text[at] | 0;
  if (b === 10) return 1;
  if (b === 13) return (at + 1 < n && (text[at + 1] | 0) === 10) ? 2 : 1;
  if (b === 0xe2 && at + 2 < n && (text[at + 1] | 0) === 0x80) {
    const b2 = text[at + 2] | 0;
    if (b2 === 0xa8 || b2 === 0xa9) return 3;
  }
  return 0;
}

// The length of the line break that ends at text[end). 0 if none.
export function jsLineBreakLenBack(text: Uint8Array, end: number): number {
  const e = end > text.length ? text.length : end;
  if (e <= 0) return 0;
  const b = text[e - 1] | 0;
  if (b === 10) return (e >= 2 && (text[e - 2] | 0) === 13) ? 2 : 1;
  if (b === 13) return 1;
  if ((b === 0xa8 || b === 0xa9) && e >= 3 && (text[e - 2] | 0) === 0x80 && (text[e - 3] | 0) === 0xe2) return 3;
  return 0;
}

// `skipNewline`
export function skipNewline(text: Uint8Array, at: number): number {
  return at + jsLineBreakLen(text, at);
}

// `skipNewline(.., { backwards: true })`
export function skipNewlineBackwards(text: Uint8Array, end: number): number {
  return end - jsLineBreakLenBack(text, end);
}

// `skipInlineComment`
export function skipInlineComment(text: Uint8Array, at: number): number {
  const n = text.length;
  if (at + 1 < n && (text[at] | 0) === 47 && (text[at + 1] | 0) === 42) {
    for (let i = at + 2; i + 1 < n; i++) {
      if ((text[i] | 0) === 42 && (text[i + 1] | 0) === 47) return i + 2;
    }
  }
  return at;
}

// `skipTrailingComment`
export function skipTrailingComment(text: Uint8Array, at: number): number {
  const n = text.length;
  if (at + 1 < n && (text[at] | 0) === 47 && (text[at + 1] | 0) === 47) {
    let i = at + 2;
    while (i < n) {
      const b = text[i] | 0;
      if (b === 10 || b === 13) break;
      i = i + 1;
    }
    return i;
  }
  return at;
}

// `hasNewline`: nothing but blanks is between `at` and the end of the line.
export function hasNewline(text: Uint8Array, at: number): boolean {
  const lineEnd = skipSpaces(text, at);
  return skipNewline(text, lineEnd) !== lineEnd;
}

// `hasNewline(.., { backwards: true })`: nothing but blanks is between the start of the line and `end`.
// Not on the first line.
export function hasNewlineBackwards(text: Uint8Array, end: number): boolean {
  const lineStart = skipSpacesBackwards(text, end);
  return skipNewlineBackwards(text, lineStart) !== lineStart;
}

// Skips bytes that are `,` `;` blank or tab.
function skipCommaSemiBlank(text: Uint8Array, at: number): number {
  const n = text.length;
  let i = at;
  while (i < n) {
    const b = text[i] | 0;
    if (b !== 44 && b !== 59 && b !== 32 && b !== 9) break;
    i = i + 1;
  }
  return i;
}

// `isNextLineEmpty`: whether the line after the one that `at` is on is empty. Commas, semicolons and comments
// after `at` are passed over.
export function isNextLineEmpty(text: Uint8Array, at: number): boolean {
  const n = text.length;
  if (at < n) {
    const b = text[at] | 0;
    // Nearly always the line ends here, or something else follows on it.
    if (b === 10) return hasNewline(text, at + 1);
    if (b === 44 && at + 2 < n && (text[at + 1] | 0) === 32) {
      const next = text[at + 2] | 0;
      if (next !== 44 && next !== 59 && next !== 32 && next !== 9 && next !== 47 && next !== 10 && next !== 13 && next !== 0xe2) {
        return false;
      }
    }
  }
  return isLineAfterTheRestOfTheLineEmpty(text, at);
}

function isLineAfterTheRestOfTheLineEmpty(text: Uint8Array, start: number): boolean {
  let at = start;
  while (true) {
    const lineEnd = skipCommaSemiBlank(text, at);
    const next = skipSpaces(text, skipInlineComment(text, lineEnd));
    if (next === at) break;
    at = next;
  }
  return hasNewline(text, skipNewline(text, skipTrailingComment(text, at)));
}

// `isPreviousLineEmpty`
export function isPreviousLineEmpty(text: Uint8Array, at: number): boolean {
  const lineStart = skipSpacesBackwards(text, at);
  return hasNewlineBackwards(text, skipNewlineBackwards(text, lineStart));
}

// What `printLeadingComment` asks: whether the line after the one that ends at `at`, but for blanks, is empty.
export function isFollowedByEmptyLine(text: Uint8Array, at: number): boolean {
  return hasNewline(text, skipNewline(text, skipSpaces(text, at)));
}

// `makeString`: appends content[start, end), which is what is between quotes of either kind, in `quote`
// (a byte, `"` or `'`), with its quotes, to `out`.
export function makeString(content: Uint8Array, start: number, end: number, quote: number, out: ByteBuf): void {
  const other = quote === 34 ? 39 : 34;
  out.push(quote);
  let i = start;
  while (i < end) {
    const b = content[i] | 0;
    i = i + 1;
    if (b === 92) {
      if (i < end) {
        const escaped = content[i] | 0;
        i = i + 1;
        // It does not have to be escaped any more.
        if (escaped === other) out.push(escaped);
        else {
          out.push(92);
          out.push(escaped);
        }
      } else {
        out.push(92);
      }
    } else if (b === quote) {
      out.push(92);
      out.push(b);
    } else {
      out.push(b);
    }
  }
  out.push(quote);
}

// `/^\s*#[^\S\n]*@(?:a|b)\s*?(?:\n|$)/`: what YAML and GraphQL have for `hasPragma` and `hasIgnorePragma`.
// `pragmaA`, `pragmaB`: ASCII pragma names without the `@`.
export function hasPragmaInHashComment(text: Uint8Array, pragmaA: string, pragmaB: string): boolean {
  const n = text.length;
  let i = trimJsWhitespaceStart(text, 0, n);
  if (i >= n || (text[i] | 0) !== 35) return false;
  i = withoutBlanks(text, i + 1);
  if (i >= n || (text[i] | 0) !== 64) return false;
  i = i + 1;
  if (eqAscii(text, i, pragmaA) && pragmaEnds(text, i + pragmaA.length)) return true;
  return eqAscii(text, i, pragmaB) && pragmaEnds(text, i + pragmaB.length);
}

// Skips JS whitespace that is not a `\n`.
function withoutBlanks(text: Uint8Array, at: number): number {
  const n = text.length;
  let i = at;
  while (i < n && (text[i] | 0) !== 10) {
    const len = jsWhitespaceLen(text, i, n);
    if (len === 0) break;
    i = i + len;
  }
  return i;
}

function pragmaEnds(text: Uint8Array, at: number): boolean {
  const i = withoutBlanks(text, at);
  return i >= text.length || (text[i] | 0) === 10;
}

// The first character of text[at, end) (a code point) and, through `charLen()`, how many bytes it has.
// Bytes that are not UTF-8 are U+FFFD. Returns -1 if empty.
let lastCharLen = 0;
export function firstChar(text: Uint8Array, at: number, end: number): number {
  if (at >= end) { lastCharLen = 0; return -1; }
  const b = text[at] | 0;
  if (b < 128) { lastCharLen = 1; return b; }
  const cp = decodeUtf8(text, at, end);
  lastCharLen = utf8Len();
  return cp;
}
// The same for the last character of text[start, at).
export function lastChar(text: Uint8Array, start: number, at: number): number {
  if (at <= start) { lastCharLen = 0; return -1; }
  const b = text[at - 1] | 0;
  if (b < 128) { lastCharLen = 1; return b; }
  const cp = decodeUtf8Back(text, start, at);
  lastCharLen = utf8Len();
  return cp;
}
// Number of bytes of the character returned by the last `firstChar` / `lastChar`.
export function charLen(): number {
  return lastCharLen;
}

// Whether text[start, end) ends with the ASCII `ending`, whatever the case of the ASCII letters.
export function endsWithIgnoreAsciiCase(text: Uint8Array, start: number, end: number, ending: string): boolean {
  const n = ending.length;
  const at = end - n;
  if (at < start) return false;
  for (let i = 0; i < n; i++) {
    let a = text[at + i] | 0;
    let b = ending.charCodeAt(i);
    if (a >= 65 && a <= 90) a = a + 32;
    if (b >= 65 && b <= 90) b = b + 32;
    if (a !== b) return false;
  }
  return true;
}

// `text.toLowerCase()` of text[start, end), appended to `out`. ASCII is mapped in place; anything else takes
// the slow path through JS strings (full Unicode lowercasing).
export function appendLowerCase(text: Uint8Array, start: number, end: number, out: ByteBuf): void {
  let ascii = true;
  for (let i = start; i < end; i++) {
    if ((text[i] | 0) >= 0x80) { ascii = false; break; }
  }
  if (ascii) {
    out.reserve(end - start);
    for (let i = start; i < end; i++) {
      const b = text[i] | 0;
      out.push(b >= 65 && b <= 90 ? b + 32 : b);
    }
    return;
  }
  const s = new TextDecoder().decode(text.subarray(start, end)).toLowerCase();
  out.appendAll(new TextEncoder().encode(s));
}

// Whether text[start, end) contains the byte.
export function containsByte(text: Uint8Array, start: number, end: number, byte: number): boolean {
  return indexOfByte(text, start, end, byte) >= 0;
}
