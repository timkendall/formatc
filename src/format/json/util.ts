// What json uses of `format/js/utils/*` (number.rs, string.rs, array.rs) and `comments.rs`: Prettier's `printNumber`,
// `isEs5IdentifierName`, `isSimpleNumber`, `isLineAfterElementEmpty`, `isTypeCastComment`. Nothing here is specific to JSON;
// when `src/format/js/utils/` is ported these can be replaced by its functions (TODO(port): dedupe).
import { ByteBuf } from "../../base/bytebuf.ts";
import { decodeUtf8, utf8Len } from "../../base/utf8.ts";
import { isIdentifierStart, isTypeScriptIdentifierPart } from "../../sema/parser/unicode.ts";
import { isNextLineEmpty, skipInlineComment, skipTrailingComment } from "../text.ts";
import { ES5_PART_LESS, ES5_PART_MORE, ES5_START_LESS, ES5_START_MORE } from "./es5_tables.ts";

// ------------------------------------------------------------------------------------------ format_trimmed_number

// Prettier's `printNumber`: now in `format/js/utils/number.ts`.
export { numBuf, numLen, trimmedNumber } from "../js/utils/number.ts";

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

// ------------------------------------------------------------------------------------------ strings

function inRanges(table: Int32Array, c: number): boolean {
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
 * ES5's `IdentifierName`, as the package `is-es5-identifier-name` has it, whose letters are those of an old version of
 * Unicode: Bun's tables of today, but for what `es5_tables` lists. Prettier only removes the quotes of such a name.
 */
export function isEs5IdentifierName(text: Uint8Array, start: number, end: number): boolean {
  if (start >= end) return false;
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
      if (!((isIdentifierStart(c) && !inRanges(ES5_START_LESS, c)) || inRanges(ES5_START_MORE, c))) return false;
    } else if (!((isTypeScriptIdentifierPart(c) && !inRanges(ES5_PART_LESS, c)) || inRanges(ES5_PART_MORE, c))) {
      return false;
    }
    i = i + l;
  }
  return true;
}

/** Prettier's `isSimpleNumber`: `123` and `2.5`, but not `1_000`, `1e+100` or `0b10`. */
export function isSimpleNumber(text: Uint8Array, start: number, end: number): boolean {
  let i = start;
  while (i < end && isDigit(text[i] | 0)) i = i + 1;
  if (i === start) return false;
  if (i === end) return true;
  if ((text[i] | 0) !== 46) return false;
  i = i + 1;
  const f = i;
  while (i < end && isDigit(text[i] | 0)) i = i + 1;
  return i > f && i === end;
}

function asciiString(text: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(text[i] | 0);
  return s;
}

/** `String(Number(text)) === text`, for a simple number. */
export function isCanonicalSimpleNumber(text: Uint8Array, start: number, end: number): boolean {
  const s = asciiString(text, start, end);
  return String(Number(s)) === s;
}

/** `String(Number(text)) === text` (`number_to_string(js_string_to_number(source)) == source`). */
export function numberToStringIsSame(text: Uint8Array, start: number, end: number): boolean {
  const s = asciiString(text, start, end);
  return String(Number(s)) === s;
}

/** Prettier's `isLineAfterElementEmpty`: the line after the comma that follows the element that ends at `end` is empty. */
export function isLineAfterElementEmpty(text: Uint8Array, end: number): boolean {
  let at = end;
  const n = text.length;
  while (at < n && (text[at] | 0) !== 44) at = skipInlineComment(text, skipTrailingComment(text, at + 1));
  return isNextLineEmpty(text, at);
}

/** Prettier's `/@(?:type|satisfies)\b/` in text[start, end). */
export function isTypeCastText(text: Uint8Array, start: number, end: number): boolean {
  let i = start;
  while (i < end) {
    if ((text[i] | 0) !== 64) {
      i = i + 1;
      continue;
    }
    i = i + 1;
    if (tagAt(text, i, end, "type") || tagAt(text, i, end, "satisfies")) return true;
  }
  return false;
}

function tagAt(text: Uint8Array, at: number, end: number, tag: string): boolean {
  const n = tag.length;
  if (at + n > end) return false;
  for (let k = 0; k < n; k++) if ((text[at + k] | 0) !== tag.charCodeAt(k)) return false;
  if (at + n < end) {
    const c = text[at + n] | 0;
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------------ JSON.stringify

const HEX = "0123456789abcdef";

/** `bun_core::printer::json_stringify`: text[start, end) (UTF-8 / WTF-8) as a JSON string, with its quotes. */
export function jsonStringify(text: Uint8Array, start: number, end: number, out: ByteBuf): void {
  out.push(34);
  let i = start;
  while (i < end) {
    const b = text[i] | 0;
    if (b === 34 || b === 92) {
      out.push(92);
      out.push(b);
    } else if (b < 0x20) {
      switch (b) {
        case 8: out.push(92); out.push(98); break;
        case 9: out.push(92); out.push(116); break;
        case 10: out.push(92); out.push(110); break;
        case 12: out.push(92); out.push(102); break;
        case 13: out.push(92); out.push(114); break;
        default:
          out.push(92);
          out.push(117);
          out.push(48);
          out.push(48);
          out.push(HEX.charCodeAt(b >> 4));
          out.push(HEX.charCodeAt(b & 15));
      }
    } else if (b === 0xed && i + 2 < end && ((text[i + 1] | 0) & 0xe0) === 0xa0 && ((text[i + 2] | 0) & 0xc0) === 0x80) {
      // A lone surrogate (WTF-8).
      const c = 0xd000 | (((text[i + 1] | 0) & 0x3f) << 6) | ((text[i + 2] | 0) & 0x3f);
      out.push(92);
      out.push(117);
      out.push(HEX.charCodeAt((c >> 12) & 15));
      out.push(HEX.charCodeAt((c >> 8) & 15));
      out.push(HEX.charCodeAt((c >> 4) & 15));
      out.push(HEX.charCodeAt(c & 15));
      i = i + 2;
    } else {
      out.push(b);
    }
    i = i + 1;
  }
  out.push(34);
}

// ------------------------------------------------------------------------------------------ line endings

/** Appends the line break `le` (`LE_LF`, `LE_CRLF`, `LE_CR` of config.ts). */
export function pushLineEnding(out: ByteBuf, le: number): void {
  if (le === 1) {
    out.push(13);
    out.push(10);
  } else if (le === 2) {
    out.push(13);
  } else {
    out.push(10);
  }
}

/** Appends text[start, end) with each `\r\n`, `\r` and `\n` replaced by the line break `le`. */
export function writeWithLineEnding(text: Uint8Array, start: number, end: number, le: number, out: ByteBuf): void {
  let i = start;
  let runStart = start;
  while (i < end) {
    const b = text[i] | 0;
    if (b === 10 || b === 13) {
      out.append(text, runStart, i);
      pushLineEnding(out, le);
      i = i + (b === 13 && i + 1 < end && (text[i + 1] | 0) === 10 ? 2 : 1);
      runStart = i;
    } else {
      i = i + 1;
    }
  }
  out.append(text, runStart, end);
}
