// Port of vendor/bun/src/format/js/utils/string.rs: string literals: which quotes they get, and what has to be escaped then.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { decodeUtf8, utf8Len } from "../../../base/utf8.ts";
import { isIdentifierPart, isIdentifierStart, isTypeScriptIdentifierPart } from "../../../sema/parser/unicode.ts";
import { Formatter } from "../../ir/formatter.ts";
import { twSingle } from "../../ir/element.ts";
import {
  FLAVOR_OXFMT,
  QUOTE_DOUBLE,
  QUOTE_PROPS_AS_NEEDED,
  QUOTE_PROPS_PRESERVE,
  QUOTE_SINGLE,
  quoteStyleAsByte,
  quoteStyleFromByte,
  quoteStyleOther,
} from "../../options.ts";
import { cxOf } from "../context.ts";
import { PART_LESS, PART_MORE, START_LESS, START_MORE } from "./es5_identifier_tables.ts";

export const STRING_LITERAL_PARENT_KIND_EXPRESSION: number = 0;
export const STRING_LITERAL_PARENT_KIND_IMPORT_ATTRIBUTE: number = 1;
export const STRING_LITERAL_PARENT_KIND_DIRECTIVE: number = 2;

/** The inclusive ranges `[lo0, hi0, lo1, hi1, ..]` (sorted) contain `c`. */
function inRanges16(table: Uint16Array, c: number): boolean {
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

/**
 * ES5's `IdentifierName`, as the package `is-es5-identifier-name` has it, whose letters are those of an old version of Unicode: Bun's tables of
 * today, but for what `es5_identifier_tables` lists. Prettier only removes the quotes of such a name. `text[start, end)`.
 */
export function isEs5IdentifierName(text: Uint8Array, start: number, end: number): boolean {
  if (end <= start) return false;
  let i = start;
  while (i < end) {
    const b = text[i] | 0;
    if (b < 0x80) {
      const ok = (b >= 97 && b <= 122) || (b >= 65 && b <= 90) || b === 36 || b === 95 || (i !== start && b >= 48 && b <= 57);
      if (!ok) return false;
      i = i + 1;
      continue;
    }
    const c = decodeUtf8(text, i, end);
    const l = utf8Len();
    if (c > 0xffff) return false;
    if (i === start) {
      if (!((isIdentifierStart(c) && !inRanges16(START_LESS, c)) || inRanges16(START_MORE, c))) return false;
    } else if (!((isTypeScriptIdentifierPart(c) && !inRanges16(PART_LESS, c)) || inRanges16(PART_MORE, c))) {
      return false;
    }
    i = i + l;
  }
  return true;
}

/** `bun_core::lexer::is_identifier(name)` */
function isIdentifierName(text: Uint8Array, start: number, end: number): boolean {
  if (end <= start) return false;
  let i = start;
  while (i < end) {
    const c = decodeUtf8(text, i, end);
    const l = utf8Len();
    if (i === start ? !isIdentifierStart(c) : !isIdentifierPart(c)) return false;
    i = i + l;
  }
  return true;
}

/** Whether the name of a property can do without its quotes. For oxfmt whatever is an identifier today can: `{ ℘: 1 }`. */
export function isNameWithoutQuotes(text: Uint8Array, start: number, end: number, flavor: number): boolean {
  return flavor === FLAVOR_OXFMT ? isIdentifierName(text, start, end) : isEs5IdentifierName(text, start, end);
}

/** Prettier's `isSimpleNumber`: `123` and `2.5`, but not `1_000`, `1e+100` or `0b10`. */
export function isSimpleNumber(text: Uint8Array, start: number, end: number): boolean {
  let i = start;
  while (i < end) {
    const b = text[i] | 0;
    if (b < 48 || b > 57) break;
    i = i + 1;
  }
  if (i === start) return false;
  if (i === end) return true;
  if ((text[i] | 0) !== 46) return false;
  i = i + 1;
  const fraction = i;
  while (i < end) {
    const b = text[i] | 0;
    if (b < 48 || b > 57) return false;
    i = i + 1;
  }
  return i > fraction;
}

function asciiString(text: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(text[i] | 0);
  return s;
}

/** `String(Number(text)) === text`, for a simple number. */
export function isCanonicalSimpleNumber(text: Uint8Array, start: number, end: number): boolean {
  // The usual ones: no leading zero, no trailing zero of a fraction.
  const first = text[start] | 0;
  if (end - start > 1 && first === 48 && (text[start + 1] | 0) !== 46) return false;
  const s = asciiString(text, start, end);
  return String(Number(s)) === s;
}

/**
 * Where `cleanStringLiteralText` writes what it makes. `CLEAN.data[0 .. CLEAN.len)`. Valid until the next call.
 */
export const CLEAN = new ByteBuf(256);

/**
 * Prettier's `getPreferredQuote`, packed: bit 0 the quote the literal has (`QUOTE_*`), bit 1 the one that takes fewer escapes, bit 2 whether there
 * is a quote in it. `first`: the first byte of the literal; `content`: `text[cs, ce)`.
 */
function computeStringInformation(text: Uint8Array, first: number, cs: number, ce: number, chosenQuote: number): number {
  const chosen = quoteStyleAsByte(chosenQuote);
  const alternate = quoteStyleAsByte(quoteStyleOther(chosenQuote));
  let chosenCount = 0;
  let alternateCount = 0;
  for (let i = cs; i < ce; i++) {
    const b = text[i] | 0;
    if (b === chosen) chosenCount = (chosenCount + 1) | 0;
    else if (b === alternate) alternateCount = (alternateCount + 1) | 0;
  }
  const current0 = quoteStyleFromByte(first);
  const current = current0 < 0 ? QUOTE_DOUBLE : current0;
  const preferred = chosenCount > alternateCount ? quoteStyleOther(chosenQuote) : chosenQuote;
  return current | (preferred << 1) | ((chosenCount > 0 || alternateCount > 0 ? 1 : 0) << 2);
}

function containsByte(text: Uint8Array, start: number, end: number, b: number): boolean {
  for (let i = start; i < end; i++) if ((text[i] | 0) === b) return true;
  return false;
}

/** Appends `text[cs, ce)` with `\r\n` and `\r` as `\n`. */
function pushCrlfAsLf(text: Uint8Array, cs: number, ce: number): void {
  let i = cs;
  const CLEAN$ = CLEAN;
  while (i < ce) {
    const b = text[i] | 0;
    if (b === 13) {
      CLEAN$.push(10);
      i = i + (i + 1 < ce && (text[i + 1] | 0) === 10 ? 2 : 1);
    } else {
      CLEAN$.push(b);
      i = i + 1;
    }
  }
}

/** `normalize_directive`: false if the literal is as it is written. */
function normalizeDirective(text: Uint8Array, start: number, end: number, cs: number, ce: number, info: number): boolean {
  const current = info & 1;
  const quote = (info & 4) !== 0 ? current : (info >> 1) & 1;
  if (quote === current && !containsByte(text, cs, ce, 13)) return false;
  const CLEAN$ = CLEAN;
  CLEAN$.reset();
  const q = quoteStyleAsByte(quote);
  CLEAN$.push(q);
  pushCrlfAsLf(text, cs, ce);
  CLEAN$.push(q);
  void start;
  void end;
  return true;
}

/** Prettier's `makeString`: false if the literal is as it is written. */
function normalizeStringLiteral(text: Uint8Array, cs: number, ce: number, info: number): boolean {
  const preferred = (info >> 1) & 1;
  const quotesWillChange = (info & 1) !== preferred;
  if (!quotesWillChange && !containsByte(text, cs, ce, 13)) return false;
  const preferredQuote = quoteStyleAsByte(preferred);
  const alternateQuote = quoteStyleAsByte(quoteStyleOther(preferred));
  const CLEAN$ = CLEAN;
  CLEAN$.reset();
  CLEAN$.push(preferredQuote);
  let i = cs;
  while (i < ce) {
    const b = text[i] | 0;
    if (b === 92) {
      if (i + 1 < ce) {
        const escaped = text[i + 1] | 0;
        if (quotesWillChange && escaped === alternateQuote) {
          // It does not have to be escaped any more.
          i = i + 1;
        } else if (escaped === 13) {
          CLEAN$.push(92);
          i = i + 1;
        } else {
          CLEAN$.push(92);
          CLEAN$.push(escaped);
          i = i + 2;
        }
      } else {
        CLEAN$.push(92);
        i = i + 1;
      }
    } else if (b === 13) {
      i = i + (i + 1 < ce && (text[i + 1] | 0) === 10 ? 2 : 1);
      CLEAN$.push(10);
    } else if (b === preferredQuote) {
      CLEAN$.push(92);
      CLEAN$.push(b);
      i = i + 1;
    } else {
      CLEAN$.push(b);
      i = i + 1;
    }
  }
  CLEAN$.push(preferredQuote);
  return true;
}

function startsWithAt(text: Uint8Array, at: number, end: number, a: number, b: number, c: number, d: number, e: number, g: number): boolean {
  return (
    at + 6 <= end &&
    (text[at] | 0) === a &&
    (text[at + 1] | 0) === b &&
    (text[at + 2] | 0) === c &&
    (text[at + 3] | 0) === d &&
    (text[at + 4] | 0) === e &&
    (text[at + 5] | 0) === g
  );
}

/** `&apos;` */
function isApos(text: Uint8Array, at: number, end: number): boolean {
  return startsWithAt(text, at, end, 38, 97, 112, 111, 115, 59);
}
/** `&quot;` */
function isQuot(text: Uint8Array, at: number, end: number): boolean {
  return startsWithAt(text, at, end, 38, 113, 117, 111, 116, 59);
}

/** In the value of a JSX attribute, a quote is escaped as `&quot;` or `&apos;`. False if the literal is as it is written. */
function normalizeJsxAttribute(text: Uint8Array, start: number, cs: number, ce: number, preferredQuote: number): boolean {
  const currentQuote = quoteStyleFromByte(text[start] | 0);
  let singleCount = 0;
  let doubleCount = 0;
  for (let i = cs; i < ce; i++) {
    const b = text[i] | 0;
    if (b === 39) singleCount = (singleCount + 1) | 0;
    else if (b === 34) doubleCount = (doubleCount + 1) | 0;
    else if (b === 38) {
      if (isApos(text, i, ce)) {
        singleCount = (singleCount + 1) | 0;
        i = i + 5;
      } else if (isQuot(text, i, ce)) {
        doubleCount = (doubleCount + 1) | 0;
        i = i + 5;
      }
    }
  }
  let chosenQuote = preferredQuote;
  if (preferredQuote === QUOTE_DOUBLE && doubleCount > singleCount) chosenQuote = QUOTE_SINGLE;
  else if (preferredQuote === QUOTE_SINGLE && singleCount > doubleCount) chosenQuote = QUOTE_DOUBLE;

  if (singleCount === 0 && doubleCount === 0 && (currentQuote < 0 ? QUOTE_DOUBLE : currentQuote) === chosenQuote && !containsByte(text, cs, ce, 13)) {
    return false;
  }
  const CLEAN$ = CLEAN;
  CLEAN$.reset();
  const q = quoteStyleAsByte(chosenQuote);
  CLEAN$.push(q);
  let i = cs;
  while (i < ce) {
    const b = text[i] | 0;
    // 0: not a quote, 1: single, 2: double
    let quote = 0;
    let len = 1;
    if (b === 38) {
      if (isApos(text, i, ce)) {
        quote = 1;
        len = 6;
      } else if (isQuot(text, i, ce)) {
        quote = 2;
        len = 6;
      }
    } else if (b === 39) quote = 1;
    else if (b === 34) quote = 2;
    if (quote === 1) {
      if (chosenQuote === QUOTE_SINGLE) CLEAN$.appendAscii("&apos;");
      else CLEAN$.push(39);
    } else if (quote === 2) {
      if (chosenQuote === QUOTE_DOUBLE) CLEAN$.appendAscii("&quot;");
      else CLEAN$.push(34);
    } else if (b === 13) {
      CLEAN$.push(10);
      if (i + 1 < ce && (text[i + 1] | 0) === 10) len = 2;
    } else {
      CLEAN$.push(b);
    }
    i = i + len;
  }
  CLEAN$.push(q);
  return true;
}

/**
 * The text that is written for the literal `f.source[start, end)` (with its quotes): `FormatLiteralStringToken::clean_text`. Returns false if
 * that is the literal as it is written; else the text is `CLEAN.data[0 .. CLEAN.len)`.
 */
export function cleanStringLiteralText(start: number, end: number, jsx: boolean, parentKind: number, f: Formatter): boolean {
  const text = f.source;
  const options = f.options;
  const chosenQuoteStyle = jsx ? options.jsxQuoteStyle : options.quoteStyle;
  const cs = end - start >= 2 ? start + 1 : end;
  const ce = end - start >= 2 ? end - 1 : end;

  if (jsx && parentKind === STRING_LITERAL_PARENT_KIND_EXPRESSION) {
    return normalizeJsxAttribute(text, start, cs, ce, chosenQuoteStyle);
  }
  const isInHtmlAttribute = options.inHtml.isInAttribute;
  const CLEAN$ = CLEAN;
  if (!isInHtmlAttribute && parentKind === STRING_LITERAL_PARENT_KIND_EXPRESSION && end - start >= 2) {
    // One scan of the content for the quote counts, the backslashes and the `\r`s.
    const chosen = quoteStyleAsByte(chosenQuoteStyle);
    const alternate = quoteStyleAsByte(quoteStyleOther(chosenQuoteStyle));
    let chosenCount = 0;
    let alternateCount = 0;
    let cr = false;
    let backslash = false;
    for (let i = cs; i < ce; i++) {
      const b = text[i] | 0;
      if (b === chosen) chosenCount = ((chosenCount | 0) + 1) | 0;
      else if (b === alternate) alternateCount = ((alternateCount | 0) + 1) | 0;
      else if (b === 92) backslash = true;
      else if (b === 13) cr = true;
    }
    const current = (text[start] | 0) === 39 ? QUOTE_SINGLE : QUOTE_DOUBLE;
    const preferred = chosenCount > alternateCount ? quoteStyleOther(chosenQuoteStyle) : chosenQuoteStyle;
    if (!cr) {
      if (preferred === current) return false;
      if (!backslash && (preferred === chosenQuoteStyle ? chosenCount : alternateCount) === 0) {
        const q = quoteStyleAsByte(preferred);
        CLEAN$.reset();
        CLEAN$.push(q);
        CLEAN$.append(text, cs, ce);
        CLEAN$.push(q);
        return true;
      }
    }
    const info0 = current | (preferred << 1) | ((chosenCount > 0 || alternateCount > 0 ? 1 : 0) << 2);
    return normalizeStringLiteral(text, cs, ce, info0);
  }
  const isDirective = parentKind === STRING_LITERAL_PARENT_KIND_DIRECTIVE;
  let info = computeStringInformation(text, end > start ? text[start] | 0 : 0, cs, ce, isInHtmlAttribute && isDirective ? options.inHtml.quoteStyle : chosenQuoteStyle);
  if (isInHtmlAttribute && !isDirective) info = (info & ~2) | (QUOTE_SINGLE << 1);
  if (parentKind === STRING_LITERAL_PARENT_KIND_EXPRESSION) return normalizeStringLiteral(text, cs, ce, info);
  if (parentKind === STRING_LITERAL_PARENT_KIND_DIRECTIVE) return normalizeDirective(text, start, end, cs, ce, info);
  // An import attribute.
  const qp = options.quoteProperties;
  const isQuoteNeeded = qp === QUOTE_PROPS_AS_NEEDED ? false : qp === QUOTE_PROPS_PRESERVE ? true : cxOf(f).isQuoteNeeded();
  if (!isQuoteNeeded && isNameWithoutQuotes(text, cs, ce, options.flavor)) {
    CLEAN$.reset();
    CLEAN$.append(text, cs, ce);
    return true;
  }
  return normalizeStringLiteral(text, cs, ce, info);
}

/** The number of columns that the text `cleanStringLiteralText` made takes; `isSource`: it returned false, the text is `f.source[start, end)`. */
export function cleanedStringLiteralWidth(start: number, end: number, isSource: boolean, f: Formatter): number {
  const CLEAN$ = CLEAN;
  return isSource ? f.stringWidth(f.source, start, end) : f.stringWidth(CLEAN$.data, 0, CLEAN$.len);
}

/** Whether `text[start, end)` is printable ASCII without `quote`. */
function isPrintableAsciiWithout(text: Uint8Array, start: number, end: number, quote: number): boolean {
  for (let i = start; i < end; i++) {
    const c = text[i] | 0;
    if (c < 32 || c > 126 || c === quote) return false;
  }
  return true;
}

/**
 * `FormatLiteralStringToken::new(string, jsx, parent_kind).fmt(f)`: a string literal with the quotes of the options. `f.source[start, end)`: the
 * literal as it is written, with its quotes.
 */
export function fmtLiteralStringToken(start: number, end: number, jsx: boolean, parentKind: number, f: Formatter): void {
  const text = f.source;
  const CLEAN$ = CLEAN;
  if (!jsx && parentKind === STRING_LITERAL_PARENT_KIND_EXPRESSION && end - start >= 2 && !f.options.inHtml.isInAttribute) {
    // One scan of the content decides: as it is written, or only the quotes swapped, or the general way.
    const chosenQuote = f.options.quoteStyle;
    const chosen = quoteStyleAsByte(chosenQuote);
    const alternate = quoteStyleAsByte(quoteStyleOther(chosenQuote));
    let chosenCount = 0;
    let alternateCount = 0;
    let odd = false; // a byte that is not printable ASCII
    let cr = false;
    let backslash = false;
    for (let i = start + 1; i < end - 1; i++) {
      const b = text[i] | 0;
      if (b === chosen) chosenCount = ((chosenCount | 0) + 1) | 0;
      else if (b === alternate) alternateCount = ((alternateCount | 0) + 1) | 0;
      else if (b === 92) backslash = true;
      else if (b < 32 || b > 126) {
        odd = true;
        if (b === 13) cr = true;
      }
    }
    const current = (text[start] | 0) === 39 ? QUOTE_SINGLE : QUOTE_DOUBLE;
    const preferred = chosenCount > alternateCount ? quoteStyleOther(chosenQuote) : chosenQuote;
    if (!cr) {
      if (preferred === current) {
        if (odd) f.textSource(start, end);
        else f.textSourceWithWidth(start, end, twSingle(end - start));
        return;
      }
      if (!backslash && (preferred === chosenQuote ? chosenCount : alternateCount) === 0) {
        const q = quoteStyleAsByte(preferred);
        CLEAN$.reset();
        CLEAN$.push(q);
        CLEAN$.append(text, start + 1, end - 1);
        CLEAN$.push(q);
        if (odd) f.textBytes(CLEAN$.data, 0, CLEAN$.len);
        else f.textBytesWithWidth(CLEAN$.data, 0, CLEAN$.len, twSingle(CLEAN$.len));
        return;
      }
    }
  } else if (!jsx && parentKind === STRING_LITERAL_PARENT_KIND_EXPRESSION && end - start >= 2) {
    const quote = quoteStyleAsByte(f.options.quoteStyle);
    if ((text[start] | 0) === quote && (text[end - 1] | 0) === quote && isPrintableAsciiWithout(text, start + 1, end - 1, quote)) {
      f.textSourceWithWidth(start, end, twSingle(end - start));
      return;
    }
  }
  if (!cleanStringLiteralText(start, end, jsx, parentKind, f)) f.textSource(start, end);
  else f.textBytes(CLEAN$.data, 0, CLEAN$.len);
}
