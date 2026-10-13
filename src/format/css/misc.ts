// Port of vendor/bun/src/format/css/misc.rs: Prettier's `print/misc.js`, and the utilities of Prettier that it uses:
// strings, numbers, units.
//
// Conventions: a text is `(src, start, end)`. A function that makes another text (`Cow` in Rust) appends it to the
// `out` it is given and returns true; false means "the text is as it was" (`Cow::Borrowed`) and nothing was written.
import { ByteBuf } from "../../base/bytebuf.ts";
import { makeString, trimJsWhitespaceEnd } from "../text.ts";

export const PLACEHOLDER_START = "PRETTIER_HTML_PLACEHOLDER_";

/** `u8::is_ascii_whitespace`: space, tab, line feed, form feed, carriage return. */
export function isWsB(b: number): boolean {
  return b === 32 || b === 10 || b === 13 || b === 9 || b === 12;
}
export function isDigitB(b: number): boolean {
  return b >= 48 && b <= 57;
}
export function isAlphaB(b: number): boolean {
  const l = b | 32;
  return l >= 97 && l <= 122;
}
export function isHexB(b: number): boolean {
  if (b >= 48 && b <= 57) return true;
  const l = b | 32;
  return l >= 97 && l <= 102;
}
/** `\w`: `[A-Za-z0-9_]` */
export function isWordB(b: number): boolean {
  if (b >= 48 && b <= 57) return true;
  const l = b | 32;
  return (l >= 97 && l <= 122) || b === 95;
}

export function isAsciiWhitespace(b: number): boolean {
  return isWsB(b);
}
export function isAsciiDigit(b: number): boolean {
  return isDigitB(b);
}
export function isAsciiAlphabetic(b: number): boolean {
  return isAlphaB(b);
}
export function isAsciiHexDigit(b: number): boolean {
  return isHexB(b);
}
export function isAsciiAlphanumeric(b: number): boolean {
  return isDigitB(b) || isAlphaB(b);
}
/** `is_regexp_word_byte`: `\w` */
export function isRegexpWordByte(b: number): boolean {
  return isWordB(b);
}

export function lowerByte(b: number): number {
  return b >= 65 && b <= 90 ? b + 32 : b;
}

/** `src[start, end) == lit` */
export function eqLit(src: Uint8Array, start: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (end - start !== n) return false;
  for (let i = 0; i < n; i++) {
    if ((src[start + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** `src[start, end).eq_ignore_ascii_case(lit)`; `lit` is lower case. */
export function eqLitIgnoreCase(src: Uint8Array, start: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (end - start !== n) return false;
  for (let i = 0; i < n; i++) {
    if (lowerByte(src[start + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** `src[start, end).starts_with(lit)` */
export function startsWithLit(src: Uint8Array, start: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (end - start < n) return false;
  for (let i = 0; i < n; i++) {
    if ((src[start + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** `src[start, end).ends_with(lit)` */
export function endsWithLit(src: Uint8Array, start: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (end - start < n) return false;
  const o = end - n;
  for (let i = 0; i < n; i++) {
    if ((src[o + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** `src[from, end).starts_with(lit)` ignoring ASCII case, `lit` lower case. */
export function startsWithLitIgnoreCase(src: Uint8Array, start: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (end - start < n) return false;
  for (let i = 0; i < n; i++) {
    if (lowerByte(src[start + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** The index of the first `lit` in src[from, end), or -1. */
export function indexOfLit(src: Uint8Array, from: number, end: number, lit: string): number {
  const n = lit.length;
  if (n === 0) return from <= end ? from : -1;
  const first = lit.charCodeAt(0);
  const last = end - n;
  for (let i = from; i <= last; i++) {
    if ((src[i] | 0) !== first) continue;
    let ok = true;
    for (let k = 1; k < n; k++) {
      if ((src[i + k] | 0) !== lit.charCodeAt(k)) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/** The index of the last `lit` in src[from, end), or -1. */
export function lastIndexOfLit(src: Uint8Array, from: number, end: number, lit: string): number {
  const n = lit.length;
  for (let i = end - n; i >= from; i--) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if ((src[i + k] | 0) !== lit.charCodeAt(k)) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/** The index of the first `byte` in src[from, end), or -1. */
export function indexOfByteIn(src: Uint8Array, from: number, end: number, byte: number): number {
  for (let i = from; i < end; i++) {
    if ((src[i] | 0) === byte) return i;
  }
  return -1;
}

export function lastIndexOfByteIn(src: Uint8Array, from: number, end: number, byte: number): number {
  for (let i = end - 1; i >= from; i--) {
    if ((src[i] | 0) === byte) return i;
  }
  return -1;
}

export function containsByteIn(src: Uint8Array, from: number, end: number, byte: number): boolean {
  for (let i = from; i < end; i++) {
    if ((src[i] | 0) === byte) return true;
  }
  return false;
}

export function countByte(src: Uint8Array, from: number, end: number, byte: number): number {
  let n = 0;
  for (let i = from; i < end; i++) {
    if ((src[i] | 0) === byte) n = ((n | 0) + 1) | 0;
  }
  return n;
}

/** The index of the first byte of src[from, end) that is `a` or `b` (or `c`, `d`), or -1. */
export function indexOfAny2(src: Uint8Array, from: number, end: number, a: number, b: number): number {
  for (let i = from; i < end; i++) {
    const c = src[i] | 0;
    if (c === a || c === b) return i;
  }
  return -1;
}

export function indexOfAny3(src: Uint8Array, from: number, end: number, a: number, b: number, c3: number): number {
  for (let i = from; i < end; i++) {
    const c = src[i] | 0;
    if (c === a || c === b || c === c3) return i;
  }
  return -1;
}

// ───────────────────────────── units ─────────────────────────────

/** The units of `css-units-list`, as they are written. */
const CSS_UNITS: string[] = [
  "em", "rem", "ex", "rex", "cap", "rcap", "ch", "rch", "ic", "ric", "lh", "rlh",
  "vw", "svw", "lvw", "dvw", "vh", "svh", "lvh", "dvh", "vi", "svi", "lvi", "dvi",
  "vb", "svb", "lvb", "dvb", "vmin", "svmin", "lvmin", "dvmin", "vmax", "svmax",
  "lvmax", "dvmax", "cm", "mm", "Q", "in", "pt", "pc", "px", "deg", "grad", "rad",
  "turn", "s", "ms", "Hz", "kHz", "dpi", "dpcm", "dppx", "x", "cqw", "cqh", "cqi",
  "cqb", "cqmin", "cqmax", "fr",
];

const UNIT_BYTES = new Uint8Array(256);
const UNIT_OFF = new Int32Array(CSS_UNITS.length + 1);
const UNIT_KEYS = new Map<number, number>();
{
  let at = 0;
  for (let i = 0; i < CSS_UNITS.length; i++) {
    const u = CSS_UNITS[i];
    UNIT_OFF[i] = at;
    let key = 0;
    for (let k = 0; k < u.length; k++) {
      UNIT_BYTES[at + k] = u.charCodeAt(k);
      key = key * 256 + lowerByte(u.charCodeAt(k));
    }
    UNIT_KEYS.set(key, i);
    at = at + u.length;
  }
  UNIT_OFF[CSS_UNITS.length] = at;
}

/** The index in the list of units of the unit src[start, end) (without regard for case), or -1. */
export function cssUnitIndex(src: Uint8Array, start: number, end: number): number {
  const n = end - start;
  if (n <= 0 || n > 5) return -1;
  let key = 0;
  for (let i = start; i < end; i++) key = key * 256 + lowerByte(src[i] | 0);
  const r = UNIT_KEYS.get(key);
  return r === undefined ? -1 : r;
}

/** The bytes of all units. */
export function unitBytes(): Uint8Array {
  return UNIT_BYTES;
}
export function unitStart(index: number): number {
  return UNIT_OFF[index] | 0;
}
export function unitEnd(index: number): number {
  return UNIT_OFF[index + 1] | 0;
}

// ───────────────────────────── numbers ─────────────────────────────

function digitsFrom(text: Uint8Array, from: number, end: number): number {
  let i = from;
  while (i < end && isDigitB(text[i] | 0)) i = i + 1;
  return i - from;
}

/** Appends src[start, end) in lower case. */
export function appendLower(src: Uint8Array, start: number, end: number, out: ByteBuf): void {
  for (let i = start; i < end; i++) out.push(lowerByte(src[i] | 0));
}

/** `printCssNumber`: `printNumber`, and no `.0` at the end. `raw` is a number as the parsers for values and the regular
 * expression of `adjustNumbers` take it. */
export function printCssNumber(raw: Uint8Array, start: number, end: number, out: ByteBuf): void {
  if (end - start === 1) {
    out.push(raw[start] | 0);
    return;
  }
  let at = start;
  let sign = 0;
  const c0 = raw[at] | 0;
  if (c0 === 43 || c0 === 45) {
    sign = c0;
    at = at + 1;
  }
  const integerStart = at;
  at = at + digitsFrom(raw, at, end);
  const integerEnd = at;
  let fractionStart = at;
  let fractionEnd = at;
  if (at < end && (raw[at] | 0) === 46) {
    fractionStart = at + 1;
    fractionEnd = fractionStart + digitsFrom(raw, fractionStart, end);
    at = fractionEnd;
  }
  let exponentSign = 0;
  let exponentStart = end;
  const exponentEnd = end;
  if (at < end) {
    const e = raw[at] | 0;
    if (e === 101 || e === 69) {
      const s = at + 1 < end ? raw[at + 1] | 0 : 0;
      if (s === 43 || s === 45) {
        exponentSign = s;
        exponentStart = at + 2;
      } else {
        exponentStart = at + 1;
      }
    } else {
      // Not a number after all.
      appendLower(raw, start, end, out);
      return;
    }
  }
  if (integerStart === integerEnd && fractionStart === fractionEnd) {
    appendLower(raw, start, end, out);
    return;
  }
  if (sign !== 0) out.push(sign);
  if (integerStart === integerEnd) out.push(48);
  else out.append(raw, integerStart, integerEnd);
  let fractionLen = fractionEnd - fractionStart;
  while (fractionLen > 0 && (raw[fractionStart + fractionLen - 1] | 0) === 48) fractionLen = fractionLen - 1;
  if (fractionLen > 0) {
    out.push(46);
    out.append(raw, fractionStart, fractionStart + fractionLen);
  }
  let es = exponentStart;
  while (es < exponentEnd && (raw[es] | 0) === 48) es = es + 1;
  if (es < exponentEnd) {
    out.push(101);
    if (exponentSign === 45) out.push(45);
    out.append(raw, es, exponentEnd);
  }
}

// ───────────────────────────── strings ─────────────────────────────

/** `/(["'])(?:(?!\1)[^\\]|\\.)*\1/s` at src[at, end): the length of the match, or -1. */
export function stringLen(text: Uint8Array, at0: number, end: number): number {
  if (at0 >= end) return -1;
  const quote = text[at0] | 0;
  if (quote !== 34 && quote !== 39) return -1;
  let at = at0 + 1;
  while (true) {
    if (at >= end) return -1;
    const b = text[at] | 0;
    if (b === 92) {
      if (at + 1 >= end) return -1;
      at = at + 2;
    } else if (b === quote) {
      return at + 1 - at0;
    } else {
      at = at + 1;
    }
  }
}

/** Prettier's `printString`. `raw` has its quotes. */
export function printString(raw: Uint8Array, start: number, end: number, singleQuote: boolean, out: ByteBuf): void {
  // `raw.get(1..len.saturating_sub(1)).unwrap_or_default()`
  const len = end - start;
  let cs = start + 1;
  let ce = end - 1;
  if (len < 2) {
    cs = start;
    ce = start;
  }
  const preferred = singleQuote ? 39 : 34;
  const alternate = singleQuote ? 34 : 39;
  const countP = countByte(raw, cs, ce, preferred);
  const countA = countByte(raw, cs, ce, alternate);
  const enclosing = countP > countA ? alternate : preferred;
  if (len > 0 && (raw[start] | 0) === enclosing) {
    out.append(raw, start, end);
    return;
  }
  makeString(raw, cs, ce, enclosing, out);
}

/** `adjustStrings` */
export function adjustStrings(value: Uint8Array, start: number, end: number, singleQuote: boolean, out: ByteBuf): boolean {
  let any = false;
  for (let i = start; i < end; i++) {
    const c = value[i] | 0;
    if (c === 34 || c === 39) { any = true; break; }
  }
  if (!any) return false;
  let at = start;
  while (at < end) {
    const len = stringLen(value, at, end);
    if (len >= 0) {
      printString(value, at, at + len, singleQuote, out);
      at = at + len;
    } else {
      out.push(value[at] | 0);
      at = at + 1;
    }
  }
  return true;
}

/** `/(?:\d*\.\d+|\d+\.?)(?:e[+-]?\d+)?/i` at text[at, end): the length of the match, or -1. */
export function numberLen(text: Uint8Array, at0: number, end: number): number {
  const integer = digitsFrom(text, at0, end);
  const afterInteger = at0 + integer;
  let len: number;
  if (afterInteger < end && (text[afterInteger] | 0) === 46 && digitsFrom(text, afterInteger + 1, end) > 0) {
    len = integer + 1 + digitsFrom(text, afterInteger + 1, end);
  } else if (integer > 0) {
    len = integer + (afterInteger < end && (text[afterInteger] | 0) === 46 ? 1 : 0);
  } else {
    return -1;
  }
  const p = at0 + len;
  if (p < end) {
    const e = text[p] | 0;
    if (e === 101 || e === 69) {
      const s = p + 1 < end ? text[p + 1] | 0 : 0;
      const sign = s === 43 || s === 45 ? 1 : 0;
      const exponent = digitsFrom(text, p + 1 + sign, end);
      if (exponent > 0) len = len + 1 + sign + exponent;
    }
  }
  return len;
}

function isWordStart(b: number): boolean {
  return b === 95 || isAlphaB(b & 255) || b >= 0x80;
}
function isWordPart(b: number): boolean {
  return isWordB(b & 255) || b === 45 || b >= 0x80;
}

function unitLen(value: Uint8Array, from: number, end: number): number {
  let i = from;
  while (i < end && isAlphaB(value[i] | 0)) i = i + 1;
  return i - from;
}

/** `adjustNumbers` */
export function adjustNumbers(value: Uint8Array, start: number, end: number, out: ByteBuf): boolean {
  let anyDigit = false;
  for (let i = start; i < end; i++) {
    if (isDigitB(value[i] | 0)) { anyDigit = true; break; }
  }
  if (!anyDigit) return false;
  // The numbers in a word are part of it, and so is everything in a name.
  let nameStart = start;
  while (nameStart < end && (value[nameStart] | 0) === 45) nameStart = nameStart + 1;
  if (nameStart < end && isWordStart(value[nameStart] | 0)) {
    let all = true;
    for (let i = nameStart; i < end; i++) {
      if (!isWordPart(value[i] | 0)) { all = false; break; }
    }
    if (all) return false;
  }
  let at = start;
  while (at < end) {
    const byte = value[at] | 0;
    const slen = stringLen(value, at, end);
    if (slen >= 0) {
      out.append(value, at, at + slen);
      at = at + slen;
      continue;
    }
    // `[$@]?[_a-z\u0080-￿][\w\u0080-￿-]*`, which gives back what it takes for a number to follow.
    const prefix = byte === 36 || byte === 64 ? 1 : 0;
    if (at + prefix < end && isWordStart(value[at + prefix] | 0)) {
      const shortest = at + prefix + 1;
      let longest = shortest;
      while (longest < end && isWordPart(value[longest] | 0)) longest = longest + 1;
      let numberStart = -1;
      for (let s = longest; s >= shortest; s--) {
        if (numberLen(value, s, end) >= 0) { numberStart = s; break; }
      }
      let wordEnd: number;
      if (numberStart >= 0) {
        const e = numberStart + numberLen(value, numberStart, end);
        wordEnd = e + unitLen(value, e, end);
      } else {
        // Nor does any word that starts later in this one have a number behind it.
        wordEnd = longest;
      }
      out.append(value, at, wordEnd);
      at = wordEnd;
      continue;
    }
    const len = numberLen(value, at, end);
    if (len < 0) {
      out.push(byte);
      at = at + 1;
      continue;
    }
    const unitStartAt = at + len;
    const ulen = unitLen(value, unitStartAt, end);
    const unitEndAt = unitStartAt + ulen;
    const unitIndex = cssUnitIndex(value, unitStartAt, unitEndAt);
    if (ulen === 0 || (ulen === 1 && lowerByte(value[unitStartAt] | 0) === 110) || unitIndex >= 0) {
      printCssNumber(value, at, at + len, out);
      if (unitIndex >= 0) out.append(UNIT_BYTES, UNIT_OFF[unitIndex] | 0, UNIT_OFF[unitIndex + 1] | 0);
      else appendLower(value, unitStartAt, unitEndAt, out);
    } else {
      out.append(value, at, at + len);
      out.append(value, unitStartAt, unitEndAt);
    }
    at = unitEndAt;
  }
  return true;
}

/** `quoteAttributeValue` */
export function quoteAttributeValue(value: Uint8Array, start: number, end: number, singleQuote: boolean, out: ByteBuf): boolean {
  // `/^(?<value>.+?)\s+(?<flag>[a-z])$/i`, in which `.` is not a line break.
  let flagLen = -1;
  let flag = 0;
  if (end > start) {
    const last = value[end - 1] | 0;
    if (isAlphaB(last)) {
      const beforeEnd = end - 1;
      const unflaggedEnd = trimEndWs(value, start, beforeEnd);
      const isMatch = unflaggedEnd < beforeEnd && unflaggedEnd > start && !hasLineBreak(value, start, unflaggedEnd);
      if (isMatch) {
        flagLen = unflaggedEnd - start;
        flag = last;
      }
    }
  }
  const unflaggedEnd = flagLen >= 0 ? start + flagLen : end;
  let hasQuotes = false;
  for (let i = start; i < unflaggedEnd; i++) {
    const c = value[i] | 0;
    if (c === 34 || c === 39) { hasQuotes = true; break; }
  }
  if (hasQuotes && flagLen < 0) return false;
  const quote = singleQuote ? 39 : 34;
  if (!hasQuotes) out.push(quote);
  out.append(value, start, unflaggedEnd);
  if (!hasQuotes) out.push(quote);
  if (flagLen >= 0) {
    out.push(32);
    out.push(flag);
  }
  return true;
}

function hasLineBreak(text: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = text[i] | 0;
    if (c === 10 || c === 13) return true;
  }
  return false;
}

function trimEndWs(text: Uint8Array, start: number, end: number): number {
  return trimJsWhitespaceEnd(text, start, end);
}

/** `value.toLowerCase()`, of the letters of ASCII: to CSS, the others are not the same in the other case. */
export function toLowerCase(value: Uint8Array, start: number, end: number, out: ByteBuf): boolean {
  let any = false;
  for (let i = start; i < end; i++) {
    const c = value[i] | 0;
    if (c >= 65 && c <= 90) { any = true; break; }
  }
  if (!any) return false;
  appendLower(value, start, end, out);
  return true;
}

/** `maybeToLowerCase` */
export function maybeToLowerCase(value: Uint8Array, start: number, end: number, out: ByteBuf): boolean {
  // The last stands for a substitution in a template of JavaScript. Prettier does not find it again in lower case.
  let keepsCase = false;
  let hasOpen = false;
  let hasClose = false;
  for (let i = start; i < end; i++) {
    const c = value[i] | 0;
    if (c === 36 || c === 64 || c === 35) { keepsCase = true; break; }
    if (c === 40) hasOpen = true;
    else if (c === 41) hasClose = true;
  }
  if (!keepsCase) {
    keepsCase = (end > start && (value[start] | 0) === 37) ||
      startsWithLit(value, start, end, "--") ||
      startsWithLit(value, start, end, ":--") ||
      (hasOpen && hasClose) ||
      (end - start > PLACEHOLDER_START.length && indexOfLit(value, start, end, PLACEHOLDER_START) >= 0);
  }
  if (keepsCase) return false;
  return toLowerCase(value, start, end, out);
}

/** Whether `text` ends with a backslash that is not escaped itself. If `text` is all of a value or of the parameters of an
 * at-rule, what it escapes is white space, which `postcss` takes for what is behind them: anything else would be in `text`.
 * Not so for a word of a value: `\@a` is `\` and `@a`. */
export function endsBeforeEscapedBlank(text: Uint8Array, start: number, end: number): boolean {
  if (end <= start || (text[end - 1] | 0) !== 92) return false;
  let n = 0;
  let i = end - 1;
  while (i >= start && (text[i] | 0) === 92) {
    n = n + 1;
    i = i - 1;
  }
  return n % 2 === 1;
}

/** `lastLineHasInlineComment` */
export function lastLineHasInlineComment(value: Uint8Array, start: number, end: number): boolean {
  let lastLineStart = start;
  for (let i = end - 1; i >= start; i--) {
    const c = value[i] | 0;
    if (c === 10 || c === 13) { lastLineStart = i + 1; break; }
  }
  return indexOfLit(value, lastLineStart, end, "//") >= 0;
}
