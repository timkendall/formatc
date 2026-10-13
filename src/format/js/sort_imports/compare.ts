// Port of vendor/bun/src/format/js/sort_imports/compare.rs: the orders that module specifiers and names are sorted by.
//
// JavaScript compares strings by UTF-16 code units. Text here is JS strings (`bytesToString`); an order is -1, 0 or 1.

/** Compares by UTF-16 code units (JavaScript's `<`). */
export function compareUnits(a: string, b: string): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function cmpNumber(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Each character in lower case by itself, which is how the crate `natord` ignores case. Not `text.toLowerCase()`, in which a sigma at the end of a word is another letter. */
export function lowercaseEach(text: string): string {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return text.toLowerCase();
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i) as number;
    if (c > 0xffff) i = i + 1;
    out += String.fromCodePoint(c).toLowerCase();
  }
  return out;
}

function isDigit(unit: number): boolean {
  return unit >= 0x30 && unit <= 0x39;
}

function digitsAt(text: string, at: number): number {
  let n = 0;
  while (at + n < text.length && isDigit(text.charCodeAt(at + n))) n = n + 1;
  return n;
}

function startsWithAscii(text: string, at: number, prefix: string): boolean {
  if (text.length - at < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (text.charCodeAt(at + i) !== prefix.charCodeAt(i)) return false;
  return true;
}

/** `is_js_whitespace` */
function isJsWhitespace(c: number): boolean {
  return (
    (c >= 9 && c <= 13) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** How many units of `text[at..end)` are a `StrUnsignedDecimalLiteral` other than `Infinity`. */
function decimalLiteralLen(text: string, at: number, end: number): number {
  const whole = Math.min(digitsAt(text, at), end - at);
  let len = whole;
  let fraction = 0;
  if (at + len < end && text.charCodeAt(at + len) === 0x2e) {
    fraction = Math.min(digitsAt(text, at + len + 1), end - (at + len + 1));
    if (whole > 0 || fraction > 0) len = len + 1 + fraction;
  }
  if (whole === 0 && fraction === 0) return 0;
  if (at + len < end && (text.charCodeAt(at + len) === 0x45 || text.charCodeAt(at + len) === 0x65)) {
    const sign = at + len + 1 < end && (text.charCodeAt(at + len + 1) === 0x2b || text.charCodeAt(at + len + 1) === 0x2d) ? 1 : 0;
    const exponent = Math.min(digitsAt(text, at + len + 1 + sign), end - (at + len + 1 + sign));
    if (exponent > 0) len = len + 1 + sign + exponent;
  }
  return len;
}

/** `parseFloat(text)`. `NaN` for NaN. */
function parseFloatUnits(text: string): number {
  let blank = 0;
  while (blank < text.length && isJsWhitespace(text.charCodeAt(blank))) blank = blank + 1;
  let at = blank;
  const first = at < text.length ? text.charCodeAt(at) : -1;
  const sign = first === 0x2b || first === 0x2d ? 1 : 0;
  const isNegative = sign === 1 && first === 0x2d;
  at = at + sign;
  let value = 0;
  if (startsWithAscii(text, at, "Infinity")) {
    value = Infinity;
  } else {
    const len = decimalLiteralLen(text, at, text.length);
    if (len === 0) return NaN;
    if (len <= 15 && digitsAt(text, at) === len) {
      for (let i = 0; i < len; i++) value = value * 10 + (text.charCodeAt(at + i) - 0x30);
    } else {
      value = Number(text.substring(at, at + len));
      if (value !== value) return NaN;
    }
  }
  return isNegative ? -value : value;
}

/** `isNaN(text)` */
function isNanAsNumber(text: string): boolean {
  if (text.length > 0) {
    const c = text.charCodeAt(0);
    // What nearly all text starts with.
    if ((c >= 0x21 && c <= 0x2a) || c === 0x2c || c === 0x2e || c === 0x2f || (c >= 0x3a && c <= 0x48) || (c >= 0x4a && c <= 0x7e)) return true;
  }
  let start = 0;
  while (start < text.length && isJsWhitespace(text.charCodeAt(start))) start = start + 1;
  let end = text.length;
  while (end > start && isJsWhitespace(text.charCodeAt(end - 1))) end = end - 1;
  if (start === end) return false;
  if (end - start > 2 && text.charCodeAt(start) === 0x30) {
    const r = text.charCodeAt(start + 1) | 0x20;
    const radix = r === 0x78 ? 16 : r === 0x6f ? 8 : r === 0x62 ? 2 : 0;
    if (radix !== 0) {
      for (let i = start + 2; i < end; i++) {
        const c = text.charCodeAt(i);
        let d = -1;
        if (c >= 0x30 && c <= 0x39) d = c - 0x30;
        else if ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a) d = (c | 0x20) - 0x61 + 10;
        if (d < 0 || d >= radix) return true;
      }
      return false;
    }
  }
  const c0 = text.charCodeAt(start);
  const sign = c0 === 0x2b || c0 === 0x2d ? 1 : 0;
  const unsignedStart = start + sign;
  const unsignedLen = end - unsignedStart;
  if (unsignedLen === 8 && startsWithAscii(text, unsignedStart, "Infinity")) return false;
  return !(unsignedLen > 0 && decimalLiteralLen(text, unsignedStart, end) === unsignedLen);
}

// ───────────────────────────── javascript-natural-sort ─────────────────────────────

/** Whether all of `text` is `[+-]?(0|[1-9]\d*)(\.\d*)?([eE][+-]?\d+)?`. */
function isNumber(text: string): boolean {
  let at = text.length > 0 && (text.charCodeAt(0) === 0x2b || text.charCodeAt(0) === 0x2d) ? 1 : 0;
  const c = at < text.length ? text.charCodeAt(at) : -1;
  if (c === 0x30) at = at + 1;
  else if (c >= 0x31 && c <= 0x39) at = at + digitsAt(text, at);
  else return false;
  if (at < text.length && text.charCodeAt(at) === 0x2e) at = at + 1 + digitsAt(text, at + 1);
  if (at < text.length && (text.charCodeAt(at) === 0x45 || text.charCodeAt(at) === 0x65)) {
    const sign = at + 1 < text.length && (text.charCodeAt(at + 1) === 0x2b || text.charCodeAt(at + 1) === 0x2d) ? 1 : 0;
    const exponent = digitsAt(text, at + 1 + sign);
    if (exponent === 0) return false;
    at = at + 1 + sign + exponent;
  }
  return at === text.length;
}

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  const l = c | 0x20;
  if (l >= 0x61 && l <= 0x66) return l - 0x61 + 10;
  return -1;
}

/** The value of `text` if all of it is `0x[0-9a-f]+`, in either case; -1 if it is not. */
function hexadecimal(text: string): number {
  if (text.length < 3) return -1;
  if (text.charCodeAt(0) !== 0x30 || (text.charCodeAt(1) | 0x20) !== 0x78) return -1;
  let value = 0;
  for (let i = 2; i < text.length; i++) {
    const d = hexDigit(text.charCodeAt(i));
    if (d < 0) return -1;
    value = value * 16 + d;
  }
  return value;
}

/** The chunks of a text: runs of digits and what is between them. A number is one chunk. */
class Chunks {
  text: string;
  at: number;
  isWhole: boolean;
  /** The chunk that `next` has found. */
  chunk: string;
  constructor(text: string, isWhole: boolean) {
    this.text = text;
    this.at = 0;
    this.isWhole = isWhole;
    this.chunk = "";
  }
  /** false at the end. */
  next(): boolean {
    const text = this.text;
    if (this.at >= text.length) return false;
    const first = isDigit(text.charCodeAt(this.at));
    let len = text.length - this.at;
    if (!this.isWhole) {
      len = 0;
      while (this.at + len < text.length && isDigit(text.charCodeAt(this.at + len)) === first) len = len + 1;
    }
    this.chunk = text.substring(this.at, this.at + len);
    this.at = this.at + len;
    return true;
  }
}

function newChunks(text: string): Chunks {
  return new Chunks(text, text.length === 0 || isNumber(text) || hexadecimal(text) >= 0);
}

/** `!(chunk || '').match(/^0/) && parseFloat(chunk) || chunk || 0`: the number, or NaN if it is the text. */
function numberOf(chunk: string, has: boolean): number {
  if (!has || chunk.length === 0) return 0;
  if (chunk.charCodeAt(0) === 0x30) return NaN;
  const n = parseFloatUnits(chunk);
  if (n !== n || n === 0) return NaN;
  return n;
}

function compareNumberWithText(n: number, text: string): number {
  return compareUnits(String(n), text);
}

function compareChunks(xs: Chunks, ys: Chunks): number {
  while (true) {
    const hasX = xs.next();
    const hasY = ys.next();
    if (!hasX && !hasY) return 0;
    const x = xs.chunk;
    const y = ys.chunk;
    const xn = numberOf(x, hasX);
    const yn = numberOf(y, hasY);
    const xIsNumber = xn === xn;
    const yIsNumber = yn === yn;
    let order = 0;
    if (xIsNumber && yIsNumber) {
      order = cmpNumber(xn, yn);
    } else if (!xIsNumber && !yIsNumber) {
      const xNan = isNanAsNumber(x);
      const yNan = isNanAsNumber(y);
      if (xNan && !yNan) order = 1;
      else if (!xNan && yNan) order = -1;
      else order = compareUnits(x, y);
    } else if (xIsNumber) {
      order = isNanAsNumber(y) ? -1 : compareNumberWithText(xn, y);
    } else {
      order = isNanAsNumber(x) ? 1 : -compareNumberWithText(yn, x);
    }
    if (order !== 0) return order;
  }
}

function naturalSortUnits(x0: string, y0: string): number {
  // Neither side is trimmed of anything but spaces.
  let xs = 0;
  let xe = x0.length;
  while (xs < xe && x0.charCodeAt(xs) === 0x20) xs = xs + 1;
  while (xe > xs && x0.charCodeAt(xe - 1) === 0x20) xe = xe - 1;
  let ys = 0;
  let ye = y0.length;
  while (ys < ye && y0.charCodeAt(ys) === 0x20) ys = ys + 1;
  while (ye > ys && y0.charCodeAt(ye - 1) === 0x20) ye = ye - 1;
  const x = x0.substring(xs, xe);
  const y = y0.substring(ys, ye);
  // Dates, which `Date.parse` is asked about, are not recognized.
  const yValue = hexadecimal(y);
  if (yValue > 0) {
    const xValue = hexadecimal(x);
    const order = cmpNumber(xValue < 0 ? 0 : xValue, yValue);
    if (order !== 0) return order;
  }
  return compareChunks(newChunks(x), newChunks(y));
}

/** `naturalSort(x, y)` of the package `javascript-natural-sort`, 0.7.1. `isInsensitive`: `naturalSort.insensitive`. */
export function naturalSort(x: string, y: string, isInsensitive: boolean): number {
  if (isInsensitive) return naturalSortUnits(x.toLowerCase(), y.toLowerCase());
  return naturalSortUnits(x, y);
}

// ───────────────────────────── @ianvs/prettier-plugin-sort-imports ─────────────────────────────

function asciiNumber(text: string, at: number, len: number): number {
  const n = Number(text.substring(at, at + len));
  return n !== n ? Infinity : n;
}

/** The plugin's `naturalSortCaseSensitive`. */
export function naturalSortCaseSensitive(a: string, b: string): number {
  let aIndex = 0;
  let bIndex = 0;
  const max = a.length > b.length ? a.length : b.length;
  while (aIndex < max) {
    const aDigits = digitsAt(a, aIndex);
    const bDigits = digitsAt(b, bIndex);
    if (aDigits === 0 && bDigits === 0) {
      // Neither is a number.
    } else if (bDigits === 0) {
      return -1;
    } else if (aDigits === 0) {
      return 1;
    } else {
      const order = cmpNumber(asciiNumber(a, aIndex, aDigits), asciiNumber(b, bIndex, bDigits));
      if (order !== 0) return order;
      aIndex = aIndex + aDigits;
      bIndex = bIndex + bDigits;
    }
    const aHas = aIndex < a.length;
    const bHas = bIndex < b.length;
    if (aHas && !bHas) return 1;
    if (!aHas && bHas) return -1;
    if (aHas && bHas) {
      const x = a.charCodeAt(aIndex);
      const y = b.charCodeAt(bIndex);
      if (x !== y) return x < y ? -1 : 1;
    }
    aIndex = aIndex + 1;
    bIndex = bIndex + 1;
  }
  return 0;
}

// ───────────────────────────── natord ─────────────────────────────

/** Unicode `White_Space` */
function isWhitespaceChar(c: number): boolean {
  return (
    (c >= 9 && c <= 13) ||
    c === 0x20 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

function codePointsOf(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i) as number;
    if (c > 0xffff) i = i + 1;
    out.push(c);
  }
  return out;
}

function natordChars(left: number[], right: number[]): number {
  let li = 0;
  let ri = 0;
  while (true) {
    while (li < left.length && isWhitespaceChar(left[li] as number)) li = li + 1;
    while (ri < right.length && isWhitespaceChar(right[ri] as number)) ri = ri + 1;
    const hasL = li < left.length;
    const hasR = ri < right.length;
    if (!hasL && !hasR) return 0;
    if (hasL && !hasR) return 1;
    if (!hasL && hasR) return -1;
    const l = left[li] as number;
    const r = right[ri] as number;
    const lIsDigit = l >= 0x30 && l <= 0x39;
    const rIsDigit = r >= 0x30 && r <= 0x39;
    if (!lIsDigit || !rIsDigit) {
      if (l !== r) return l < r ? -1 : 1;
      li = li + 1;
      ri = ri + 1;
      continue;
    }
    // With a zero at the start, digits are compared from the left: `015` < `12`.
    // Otherwise the longer number is the greater one: `15` < `123`.
    const isLeftAligned = l === 0x30 || r === 0x30;
    let order = cmpNumber(l, r);
    while (true) {
      if (isLeftAligned && order !== 0) return order;
      li = li + 1;
      ri = ri + 1;
      const ld = li < left.length && (left[li] as number) >= 0x30 && (left[li] as number) <= 0x39;
      const rd = ri < right.length && (right[ri] as number) >= 0x30 && (right[ri] as number) <= 0x39;
      if (ld && rd) {
        if (order === 0) order = cmpNumber(left[li] as number, right[ri] as number);
      } else if (ld) {
        return 1;
      } else if (rd) {
        return -1;
      } else {
        break;
      }
    }
    if (order !== 0) return order;
  }
}

/** `natord::compare` of the crate `natord`, 1.0.9. `ignoresCase`: of the two in lower case. */
export function natord(left: string, right: string, ignoresCase: boolean): number {
  if (ignoresCase) return natordChars(codePointsOf(lowercaseEach(left)), codePointsOf(lowercaseEach(right)));
  return natordChars(codePointsOf(left), codePointsOf(right));
}

// ───────────────────────────── localeCompare ─────────────────────────────

/** `a.localeCompare(b)` */
export function localeCompare(a: string, b: string): number {
  const r = a.localeCompare(b);
  return r < 0 ? -1 : r > 0 ? 1 : 0;
}

function isAsciiDigitCode(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** The value of the digits `s[from..to)`, without the zeros at the start: where they start. */
function skipZeros(s: string, from: number, to: number): number {
  let i = from;
  while (i < to - 1 && s.charCodeAt(i) === 0x30) i = i + 1;
  return i;
}

/** The text at the level of `sensitivity: "base"`: no case and no accents. */
function baseOf(s: string): string {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return s.toLowerCase();
  const d = s.normalize("NFD");
  let out = "";
  for (let i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i);
    if (c >= 0x300 && c <= 0x36f) continue;
    out += d.charAt(i);
  }
  return out.toLowerCase();
}

/** The code point at `at`, as a string. */
function firstChar(s: string, at: number): string {
  const c = s.codePointAt(at);
  return c === undefined ? "" : String.fromCodePoint(c);
}

function isDigitAt(s: string, i: number): boolean {
  return isAsciiDigitCode(s.charCodeAt(i));
}

/** The end of the run at `at` that is all digits, or all that are not. */
function runEnd(s: string, at: number): number {
  const digits = isDigitAt(s, at);
  let e = at + 1;
  while (e < s.length && isDigitAt(s, e) === digits) e = e + 1;
  return e;
}

/**
 * `new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare(a, b)`: case and accents do not count, and a run of digits is one
 * number. The rest is compared by the order of ICU's root collation (`localeCompare`).
 */
export function localeCompareNumericBase(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ie = runEnd(a, i);
    const je = runEnd(b, j);
    const da = isDigitAt(a, i);
    const db = isDigitAt(b, j);
    if (da && db) {
      const is = skipZeros(a, i, ie);
      const js = skipZeros(b, j, je);
      const la = ie - is;
      const lb = je - js;
      if (la !== lb) return la < lb ? -1 : 1;
      for (let k = 0; k < la; k++) {
        const x = a.charCodeAt(is + k);
        const y = b.charCodeAt(js + k);
        if (x !== y) return x < y ? -1 : 1;
      }
    } else if (da || db) {
      // A number and text: the text goes first if it is before the digits.
      const text = baseOf(da ? b.substring(j, je) : a.substring(i, ie));
      const order = da ? localeCompare("0", firstChar(text, 0)) : localeCompare(firstChar(text, 0), "0");
      if (order !== 0) return order;
    } else {
      const x = baseOf(a.substring(i, ie));
      const y = baseOf(b.substring(j, je));
      if (x !== y) {
        if (y.startsWith(x) && ie < a.length) {
          // `x` goes on with digits, `y` with its next character.
          const order = localeCompare("0", firstChar(y, x.length));
          if (order !== 0) return order;
        } else if (x.startsWith(y) && je < b.length) {
          const order = localeCompare(firstChar(x, y.length), "0");
          if (order !== 0) return order;
        } else {
          const order = localeCompare(x, y);
          if (order !== 0) return order;
        }
      }
    }
    i = ie;
    j = je;
  }
  const restA = i < a.length;
  const restB = j < b.length;
  return restA === restB ? 0 : restA ? 1 : -1;
}
