// Helpers for the code that works on JavaScript strings where the Rust code works on UTF-8 bytes (the JSDoc formatter: it is an option
// that is off by default, so strings are fine there; bytes that are not UTF-8 are U+FFFD in them). "White space" is `char::is_whitespace`.

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

/** `bytes[start, end)` as a string. */
export function decodeBytes(bytes: Uint8Array, start: number, end: number): string {
  if (end <= start) return "";
  return DECODER.decode(bytes.subarray(start, end));
}

/** The UTF-8 bytes of `s`. */
export function encodeString(s: string): Uint8Array {
  return ENCODER.encode(s);
}

/** `char::is_whitespace` */
export function isUnicodeWhitespace(c: number): boolean {
  if (c < 0x80) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f ||
    c === 0x205f || c === 0x3000
  );
}

/** `u8::is_ascii_whitespace`: space, tab, line feed, form feed, carriage return (not the vertical tab). */
export function isAsciiWhitespaceByte(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

export function trimUnicodeWhitespaceStart(s: string): string {
  let i = 0;
  const n = s.length;
  while (i < n && isUnicodeWhitespace(s.charCodeAt(i))) i = i + 1;
  return i === 0 ? s : s.substring(i);
}

export function trimUnicodeWhitespaceEnd(s: string): string {
  let n = s.length;
  while (n > 0 && isUnicodeWhitespace(s.charCodeAt(n - 1))) n = n - 1;
  return n === s.length ? s : s.substring(0, n);
}

export function trimUnicodeWhitespace(s: string): string {
  return trimUnicodeWhitespaceStart(trimUnicodeWhitespaceEnd(s));
}

export function isAllUnicodeWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (!isUnicodeWhitespace(s.charCodeAt(i))) return false;
  return true;
}

/** `str::split_whitespace` (`split_unicode_whitespace`). */
export function splitUnicodeWhitespace(s: string): string[] {
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && isUnicodeWhitespace(s.charCodeAt(i))) i = i + 1;
    if (i >= n) break;
    const start = i;
    while (i < n && !isUnicodeWhitespace(s.charCodeAt(i))) i = i + 1;
    out.push(s.substring(start, i));
  }
  return out;
}

/** `str::lines`: split at `\n`, a `\r` before it goes; no empty line after a last `\n`. */
export function linesOf(s: string): string[] {
  const out: string[] = [];
  const n = s.length;
  if (n === 0) return out;
  let start = 0;
  while (start < n) {
    let at = s.indexOf("\n", start);
    if (at < 0) {
      out.push(s.substring(start));
      return out;
    }
    let end = at;
    if (end > start && s.charCodeAt(end - 1) === 13) end = end - 1;
    out.push(s.substring(start, end));
    start = at + 1;
  }
  return out;
}

/** The number of bytes of `s` in UTF-8. */
export function utf8Length(s: string): number {
  let n = 0;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n = n + 1;
    else if (c < 0x800) n = n + 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n = n + 4;
        i = i + 1;
      } else n = n + 3;
    } else n = n + 3;
  }
  return n;
}

/** The code point at `s[i]` (a surrogate pair is one); its length in units is `cpLen(cp)`. */
export function codePointAt(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
  }
  return c;
}

export function cpLen(cp: number): number {
  return cp >= 0x10000 ? 2 : 1;
}

/** The code point that ends at `s[end)`. */
export function codePointBefore(s: string, end: number): number {
  const d = s.charCodeAt(end - 1);
  if (d >= 0xdc00 && d <= 0xdfff && end >= 2) {
    const c = s.charCodeAt(end - 2);
    if (c >= 0xd800 && c <= 0xdbff) return 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
  }
  return d;
}

const ALPHABETIC = /\p{Alphabetic}/u;
const NUMERIC = /\p{N}/u;

function cpString(cp: number): string {
  return String.fromCodePoint(cp);
}

/** `char::is_alphabetic` */
export function isAlphabetic(cp: number): boolean {
  if (cp < 0x80) return (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122);
  return ALPHABETIC.test(cpString(cp));
}

/** `char::is_alphanumeric` */
export function isAlphanumeric(cp: number): boolean {
  if (cp < 0x80) return (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57);
  return ALPHABETIC.test(cpString(cp)) || NUMERIC.test(cpString(cp));
}
