// Port of the text scanners of vendor/bun/src/sema/check/spans.rs (lines 19-628): end positions that the HIR does not store
// (names, keywords, type arguments, parentheses around a type) are found in the source text, token by token.
// The checker half of the file (`Spans`, `Checker`, `end_of_brackets`, JSX element skipping) is not ported: nothing in the
// formatter asks for it.
//
// Every function takes `(text, len, ...)`: `text` is the scratch buffer of the file and may be longer than the source;
// `len` is `hir.sourceLen`. A position at or past `len` reads as "no byte" (-1), as Rust's `text.get(i)` is `None`.
// Rust `usize` positions are plain numbers here.
import { decodeUtf8, utf8Len } from "../../base/utf8.ts";
import { isIdentifierPart, isIdentifierStart, isWhiteSpaceSingleLine } from "../parser/unicode.ts";

/** Result slot of `unicodeEscapeAt`: the code point. */
export const ESC_CP = new Int32Array(1);

/** `text.get(i)`: the byte, or -1 past the end. */
function at(text: Uint8Array, len: number, i: number): number {
  return i >= 0 && i < len ? text[i] | 0 : -1;
}

/** `IsWhiteSpaceLike` for a non-ASCII character: its length in bytes, 0 if there is none at `pos`. */
export function whiteSpaceLen(text: Uint8Array, len: number, pos: number): number {
  if (pos >= len) return 0;
  const c = decodeUtf8(text, pos, len);
  const size = utf8Len();
  if (c === 0x2028 || c === 0x2029) return size;
  if (c >= 0x80 && isWhiteSpaceSingleLine(c)) return size;
  return 0;
}

/** `IsLineBreak`: the length in bytes of the line break at `pos`, 0 if there is none. `\r\n` is two line breaks. */
export function lineBreakLen(text: Uint8Array, len: number, pos: number): number {
  const c = at(text, len, pos);
  if (c === 10 || c === 13) return 1;
  if (c === 0xe2 && at(text, len, pos + 1) === 0x80) {
    const d = at(text, len, pos + 2);
    if (d === 0xa8 || d === 0xa9) return 3;
  }
  return 0;
}

/** End of the line that contains `pos`, before its line break. */
export function lineEnd(text: Uint8Array, len: number, pos: number): number {
  let p = pos | 0;
  while (p < len && lineBreakLen(text, len, p) === 0) p = ((p | 0) + 1) | 0;
  return p < len ? p : len;
}

/** The index of the first `*` `/` at or after `from`, or -1. */
function indexOfBlockEnd(text: Uint8Array, len: number, from: number): number {
  for (let i = from; i + 1 < len; i = ((i | 0) + 1) | 0) {
    if ((text[i] | 0) === 42 && (text[i + 1] | 0) === 47) return i;
  }
  return -1;
}

/** `SkipTrivia`: from `pos`, past whitespace and comments. */
export function skipTrivia(text: Uint8Array, len: number, pos: number): number {
  return skipTriviaEx(text, len, pos, false);
}

/** `SkipTriviaEx`. `stopAfterLineBreak`: `StopAfterLineBreak`. */
export function skipTriviaEx(text: Uint8Array, len: number, pos0: number, stopAfterLineBreak: boolean): number {
  let p = pos0 | 0;
  while (true) {
    const c = at(text, len, p);
    if (c === 10 || c === 13) {
      p = (c === 13 && at(text, len, p + 1) === 10) ? ((p | 0) + 2) | 0 : ((p | 0) + 1) | 0;
      if (stopAfterLineBreak) return p;
    } else if (c === 32 || c === 9 || c === 0x0b || c === 0x0c) {
      p = ((p | 0) + 1) | 0;
    } else if (c === 47) {
      const n = at(text, len, p + 1);
      if (n === 47) {
        p = lineEnd(text, len, p + 2);
      } else if (n === 42) {
        const e = indexOfBlockEnd(text, len, p + 2);
        p = e < 0 ? len : (e + 2) | 0;
      } else {
        return p;
      }
    } else if (c === 35 && p === 0 && at(text, len, 1) === 33) {
      // `isShebangTrivia`, `scanShebangTrivia`
      p = lineEnd(text, len, 2);
    } else if (c >= 0x80) {
      const w = whiteSpaceLen(text, len, p);
      if (w === 0) return p;
      p = ((p | 0) + w) | 0;
    } else if (c < 0) {
      return p < len ? p : len;
    } else {
      return p;
    }
  }
}

/** Start of the `//` comment that ends the line `text[from, to)`, or -1. */
function lineCommentStart(text: Uint8Array, len: number, from: number, to: number): number {
  let p = from | 0;
  while (p < to) {
    const c = text[p] | 0;
    if (c === 34 || c === 39 || c === 96) {
      p = ((p | 0) + 1) | 0;
      while (p < to) {
        const s = text[p] | 0;
        p = ((p | 0) + 1) | 0;
        if (s === 92) p = ((p | 0) + 1) | 0;
        else if (s === c) break;
      }
    } else if (c === 47 && at(text, len, p + 1) === 47 && p + 1 < to) {
      return (p - from) | 0;
    } else if (c === 47 && at(text, len, p + 1) === 42 && p + 1 < to) {
      // `line[at + 2..]` search for `*/` inside the line only
      let e = -1;
      for (let i = (p + 2) | 0; i + 1 < to; i = ((i | 0) + 1) | 0) {
        if ((text[i] | 0) === 42 && (text[i + 1] | 0) === 47) {
          e = i;
          break;
        }
      }
      if (e < 0) return -1;
      p = (e + 2) | 0;
    } else {
      p = ((p | 0) + 1) | 0;
    }
  }
  return -1;
}

/** Last index of `\n` or `\r` in `text[0, to)`, or -1. */
function lastLineBreak(text: Uint8Array, to: number): number {
  for (let i = to - 1; i >= 0; i = ((i | 0) - 1) | 0) {
    const c = text[i] | 0;
    if (c === 10 || c === 13) return i;
  }
  return -1;
}

/** End of the token before `pos`: scans back over whitespace and comments. A missing node is positioned there (`createMissingNode`). */
export function skipTriviaBack(text: Uint8Array, len: number, pos: number): number {
  let p = pos < len ? pos : len;
  while (true) {
    const before = p;
    while (p > 0) {
      const b = text[p - 1] | 0;
      if (b === 10 || b === 13) {
        p = ((p | 0) - 1) | 0;
        const line = (lastLineBreak(text, p) + 1) | 0;
        const c = lineCommentStart(text, len, line, p);
        if (c >= 0) p = (line + c) | 0;
      } else if (b === 32 || b === 9 || b === 0x0b || b === 0x0c) {
        p = ((p | 0) - 1) | 0;
      } else if (p >= 2 && whiteSpaceLen(text, len, p - 2) === 2) {
        p = ((p | 0) - 2) | 0;
      } else if (p >= 3 && whiteSpaceLen(text, len, p - 3) === 3) {
        p = ((p | 0) - 3) | 0;
      } else {
        break;
      }
    }
    if (p >= 2 && (text[p - 2] | 0) === 42 && (text[p - 1] | 0) === 47) {
      // `last_index_of(&text[..at - 2], b"/*")`
      let open = -1;
      for (let i = (p - 4) | 0; i >= 0; i = ((i | 0) - 1) | 0) {
        if ((text[i] | 0) === 47 && (text[i + 1] | 0) === 42) {
          open = i;
          break;
        }
      }
      if (open >= 0) p = open;
    }
    if (p === before) {
      // `isShebangTrivia`: the first line of a file.
      if (len >= 2 && (text[0] | 0) === 35 && (text[1] | 0) === 33 && lastLineBreak(text, p) < 0) return 0;
      return p;
    }
  }
}

/** `unicodeEscape` at `pos`, which is a `\`: the length of `\uXXXX` / `\u{X..}` (0 if it is none); the code point is in `ESC_CP[0]`. */
export function unicodeEscapeAt(text: Uint8Array, len: number, pos: number): number {
  if (at(text, len, pos) !== 92 || at(text, len, pos + 1) !== 117) return 0;
  let p = (pos + 2) | 0;
  if (at(text, len, p) === 123) {
    p = ((p | 0) + 1) | 0;
    let v = 0;
    let n = 0;
    while (true) {
      const h = hexValue(at(text, len, p));
      if (h < 0) break;
      v = v * 16 + h;
      if (v > 0x10ffff) return 0;
      n = ((n | 0) + 1) | 0;
      p = ((p | 0) + 1) | 0;
    }
    if (n === 0 || at(text, len, p) !== 125) return 0;
    ESC_CP[0] = v | 0;
    return ((p + 1) - pos) | 0;
  }
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const h = hexValue(at(text, len, p));
    if (h < 0) return 0;
    v = (v * 16 + h) | 0;
    p = ((p | 0) + 1) | 0;
  }
  ESC_CP[0] = v | 0;
  return (p - pos) | 0;
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

/** `scanIdentifierParts`: the end of what goes on a name at `pos`. */
export function identEnd(text: Uint8Array, len: number, pos0: number): number {
  let p = pos0 < len ? pos0 : len;
  while (true) {
    const b = at(text, len, p);
    if (b < 0) return p;
    if (b < 0x80) {
      if (b === 92) {
        const e = unicodeEscapeAt(text, len, p);
        if (e > 0 && isIdentifierPart(ESC_CP[0] | 0)) {
          p = ((p | 0) + e) | 0;
          continue;
        }
        return p;
      }
      // ASCII name byte
      if ((b >= 97 && b <= 122) || (b >= 65 && b <= 90) || (b >= 48 && b <= 57) || b === 95 || b === 36) {
        p = ((p | 0) + 1) | 0;
        continue;
      }
      return p;
    }
    const c = decodeUtf8(text, p, len);
    const size = utf8Len();
    if (c !== 0xfffd && isIdentifierPart(c)) p = ((p | 0) + size) | 0;
    else return p;
  }
}

/** `scanIdentifier`: the same from the start of a name, which must satisfy `IsIdentifierStart`. */
export function identifierEnd(text: Uint8Array, len: number, pos: number): number {
  const b = at(text, len, pos);
  let first = -1;
  if (b === 92) {
    if (unicodeEscapeAt(text, len, pos) > 0) first = ESC_CP[0] | 0;
  } else if (b >= 0x80) {
    first = decodeUtf8(text, pos, len);
  }
  if (first >= 0 && !isIdentifierStart(first)) return pos;
  return identEnd(text, len, pos);
}

/** The same for a name that may be private. */
export function wordEnd(text: Uint8Array, len: number, pos: number): number {
  if (at(text, len, pos) === 35) return identEnd(text, len, pos + 1);
  return identEnd(text, len, pos);
}

/** `scanString`, at the quote. */
export function stringEnd(text: Uint8Array, len: number, pos: number): number {
  const quote = at(text, len, pos);
  let end = (pos + 1) | 0;
  while (true) {
    const c = at(text, len, end);
    if (c < 0) return len;
    if (c === quote) return (end + 1) | 0;
    if (c === 92) {
      end = (at(text, len, end + 1) === 13 && at(text, len, end + 2) === 10) ? ((end | 0) + 3) | 0 : ((end | 0) + 2) | 0;
    } else if (c === 10 || c === 13) {
      return end; // not terminated
    } else {
      end = ((end | 0) + 1) | 0;
    }
  }
}

/** `scanString(jsxAttributeString)`: no escapes are recognized, and it may span line breaks. */
export function jsxStringEnd(text: Uint8Array, len: number, pos: number): number {
  const quote = at(text, len, pos);
  for (let i = (pos + 1) | 0; i < len; i = ((i | 0) + 1) | 0) {
    if ((text[i] | 0) === quote) return (i + 1) | 0;
  }
  return len;
}

/** Result slot of `templateText`: 1 if it ended at a `${`. */
export const TT_SUBST = new Int32Array(1);

/** `scanTemplateAndSetTokenValue`, from inside the text of a template: the end of the text, past the `` ` `` or the `${`; `TT_SUBST[0]` is 1 for the latter. */
export function templateText(text: Uint8Array, len: number, pos0: number): number {
  let p = pos0 | 0;
  TT_SUBST[0] = 0;
  while (true) {
    const c = at(text, len, p);
    if (c < 0) return len;
    if (c === 96) return (p + 1) | 0;
    if (c === 36 && at(text, len, p + 1) === 123) {
      TT_SUBST[0] = 1;
      return (p + 2) | 0;
    }
    if (c === 92) p = ((p | 0) + 2) | 0;
    else p = ((p | 0) + 1) | 0;
  }
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** `scanNumber`, and what `Scan` does for `0x`, `0b` and `0o`. */
export function numberEnd(text: Uint8Array, len: number, start: number): number {
  let p = start | 0;
  const b0 = at(text, len, p);
  const b1 = at(text, len, p + 1);
  if (b0 === 48 && b1 >= 0 && ((b1 | 0x20) === 120 || (b1 | 0x20) === 98 || (b1 | 0x20) === 111)) {
    const radix = b1 | 0x20;
    p = ((p | 0) + 2) | 0;
    while (true) {
      const c = at(text, len, p);
      let ok = false;
      if (c === 95) ok = true;
      else if (radix === 120) ok = hexValue(c) >= 0;
      else if (radix === 98) ok = c === 48 || c === 49;
      else ok = c >= 48 && c <= 55;
      if (!ok) break;
      p = ((p | 0) + 1) | 0;
    }
    return at(text, len, p) === 110 ? ((p | 0) + 1) | 0 : p;
  }
  let hasLeadingZero = false;
  if (b0 === 48) {
    p = ((p | 0) + 1) | 0;
    if (at(text, len, p) === 95) {
      p = numberFragment(text, len, start);
    } else {
      const digits = p;
      let isOctal = true;
      while (isDigit(at(text, len, p))) {
        if (at(text, len, p) > 55) isOctal = false;
        p = ((p | 0) + 1) | 0;
      }
      if (p > digits) {
        if (isOctal) return p;
        hasLeadingZero = true;
      }
    }
  } else {
    p = numberFragment(text, len, p);
  }
  const fixedPartEnd = p;
  if (at(text, len, p) === 46) p = numberFragment(text, len, p + 1);
  const e = at(text, len, p);
  if (e === 101 || e === 69) {
    p = ((p | 0) + 1) | 0;
    const s = at(text, len, p);
    if (s === 43 || s === 45) p = ((p | 0) + 1) | 0;
    p = numberFragment(text, len, p);
  }
  if (hasLeadingZero) return p;
  // After a fraction or an exponent the `n` is an error, and is consumed anyway.
  if (at(text, len, p) === 110 && (fixedPartEnd === p || identEnd(text, len, p) === p + 1)) p = ((p | 0) + 1) | 0;
  return p;
}

function numberFragment(text: Uint8Array, len: number, from: number): number {
  let i = from | 0;
  while (true) {
    const c = at(text, len, i);
    if (isDigit(c) || c === 95) i = ((i | 0) + 1) | 0;
    else return i;
  }
}

/** `ReScanSlashToken`, at the `/`. */
export function regexEnd(text: Uint8Array, len: number, start: number): number {
  const body = (start + 1) | 0;
  let p = body;
  let inEscape = false;
  let inClass = false;
  while (true) {
    const c = at(text, len, p);
    if (c < 0 || c === 10 || c === 13) break;
    if (inEscape) inEscape = false;
    else if (c === 47 && !inClass) return identEnd(text, len, p + 1);
    else if (c === 91) inClass = true;
    else if (c === 92) inEscape = true;
    else if (c === 93) inClass = false;
    p = ((p | 0) + 1) | 0;
  }
  // Unterminated: it ends at the nearest unmatched closing bracket.
  const bodyEnd = p < len ? p : len;
  let classDepth = 0;
  let groupDepth = 0;
  let inQuantifier = false;
  p = body;
  inEscape = false;
  while (p < bodyEnd) {
    const c = text[p] | 0;
    if (inEscape) {
      inEscape = false;
    } else if (c === 92) {
      inEscape = true;
    } else if (c === 91) {
      classDepth = ((classDepth | 0) + 1) | 0;
    } else if (c === 93 && classDepth !== 0) {
      classDepth = ((classDepth | 0) - 1) | 0;
    } else if (classDepth === 0) {
      if (c === 123) {
        inQuantifier = true;
      } else if (c === 125 && inQuantifier) {
        inQuantifier = false;
      } else if (!inQuantifier) {
        if (c === 40) {
          groupDepth = ((groupDepth | 0) + 1) | 0;
        } else if (c === 41 && groupDepth !== 0) {
          groupDepth = ((groupDepth | 0) - 1) | 0;
        } else if (c === 41 || c === 93 || c === 125) {
          break;
        }
      }
    }
    p = ((p | 0) + 1) | 0;
  }
  while (p > body) {
    const b = text[p - 1] | 0;
    if (b === 32 || b === 9 || b === 0x0b || b === 0x0c || b === 59) p = ((p | 0) - 1) | 0;
    else if (p >= body + 2 && whiteSpaceLen(text, len, p - 2) === 2) p = ((p | 0) - 2) | 0;
    else if (p >= body + 3 && whiteSpaceLen(text, len, p - 3) === 3) p = ((p | 0) - 3) | 0;
    else break;
  }
  return p;
}

/** `ScanJsxIdentifier` */
export function jsxIdentifierEnd(text: Uint8Array, len: number, pos0: number): number {
  let p = pos0 | 0;
  while (true) {
    const end = identEnd(text, len, p);
    if (at(text, len, end) !== 45) return end;
    p = ((end | 0) + 1) | 0;
  }
}

/** The same, and the `:name` of `parseJsxAttributeName` and `parseJsxTagName`. */
export function jsxNameEnd(text: Uint8Array, len: number, pos: number): number {
  const end = jsxIdentifierEnd(text, len, pos);
  const colon = skipTrivia(text, len, end);
  if (at(text, len, colon) === 58) {
    const name = skipTrivia(text, len, colon + 1);
    const nameEnd = jsxIdentifierEnd(text, len, name);
    // The name after the `:` may be missing.
    return nameEnd > name ? nameEnd : (colon + 1) | 0;
  }
  return end;
}

/** The operators of more than one character, the longer first. `>` is always scanned by itself. */
const LONG_OPERATORS: string[] = [
  "...", "===", "!==", "**=", "<<=", "&&=", "||=", "??=", "=>", "==", "!=", "<=",
  "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "&&", "||", "??",
  "**", "<<", "?.",
];

function operatorLenAt(text: Uint8Array, len: number, pos: number): number {
  const c = at(text, len, pos);
  const d = at(text, len, pos + 1);
  // first bytes of the long operators: . = ! * < & | ? => + - / % ^
  switch (c) {
    case 46: // ...
      return d === 46 && at(text, len, pos + 2) === 46 ? 3 : 0;
    case 61: // === == =>
      if (d === 61) return at(text, len, pos + 2) === 61 ? 3 : 2;
      return d === 62 ? 2 : 0;
    case 33: // !== !=
      if (d === 61) return at(text, len, pos + 2) === 61 ? 3 : 2;
      return 0;
    case 42: // **= ** *=
      if (d === 42) return at(text, len, pos + 2) === 61 ? 3 : 2;
      return d === 61 ? 2 : 0;
    case 60: // <<= << <=
      if (d === 60) return at(text, len, pos + 2) === 61 ? 3 : 2;
      return d === 61 ? 2 : 0;
    case 38: // &&= && &=
      if (d === 38) return at(text, len, pos + 2) === 61 ? 3 : 2;
      return d === 61 ? 2 : 0;
    case 124: // ||= || |=
      if (d === 124) return at(text, len, pos + 2) === 61 ? 3 : 2;
      return d === 61 ? 2 : 0;
    case 63: // ??= ?? ?.
      if (d === 63) return at(text, len, pos + 2) === 61 ? 3 : 2;
      return d === 46 ? 2 : 0;
    case 43: // ++ +=
      return d === 43 || d === 61 ? 2 : 0;
    case 45: // -- -=
      return d === 45 || d === 61 ? 2 : 0;
    case 47: // /=
    case 37: // %=
    case 94: // ^=
      return d === 61 ? 2 : 0;
    default:
      return 0;
  }
}

/** `wtf8_byte_sequence_length` */
export function wtf8SequenceLength(first: number): number {
  if (first < 0xc0) return 1;
  if (first < 0xe0) return 2;
  if (first < 0xf0) return 3;
  if (first < 0xf8) return 4;
  return 1;
}

/**
 * `Scan`: the end of the token that starts at `pos`. A template ends at its first `${`, and a `/` is never a regular expression.
 * `>` is a token of its own. `isJsx`: `</` is a token.
 */
export function tokenEnd(text: Uint8Array, len: number, pos: number, isJsx: boolean): number {
  const first = at(text, len, pos);
  if (first < 0) return pos < len ? pos : len;
  const next = at(text, len, pos + 1);
  switch (first) {
    case 34:
    case 39:
      return stringEnd(text, len, pos);
    case 96:
      return templateText(text, len, pos + 1);
    case 35:
      return identEnd(text, len, pos + 1);
    case 60:
      if (isJsx && next === 47 && at(text, len, pos + 2) !== 42) return (pos + 2) | 0;
      break;
    case 63:
      if (next === 46 && isDigit(at(text, len, pos + 2))) return (pos + 1) | 0;
      break;
    case 46:
      if (isDigit(next)) return numberEnd(text, len, pos);
      break;
    default:
      if (first >= 48 && first <= 57) return numberEnd(text, len, pos);
      break;
  }
  const op = operatorLenAt(text, len, pos);
  if (op > 0) return (pos + op) | 0;
  const end = identifierEnd(text, len, pos);
  if (end > pos) return end;
  const n = (pos + wtf8SequenceLength(first)) | 0;
  return n < len ? n : len;
}

/** `IsIdentifierPart`, of a byte: as `isIdentifierStartByte`, and the digits. */
export function isIdentifierPartByte(c: number): boolean {
  return isDigit(c) || isIdentifierStartByte(c);
}

export function isIdentifierStartByte(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c === 92 || c >= 0x80;
}

/** Whether `text[start, end)` is `word`. */
export function isWordAt(text: Uint8Array, len: number, pos: number, word: string): boolean {
  const n = word.length;
  if (pos + n > len) return false;
  for (let i = 0; i < n; i++) if ((text[pos + i] | 0) !== word.charCodeAt(i)) return false;
  return identEnd(text, len, pos) === pos + n;
}

// LONG_OPERATORS is kept as the documentation of `operatorLenAt`.
export const LONG_OPERATOR_TEXTS: string[] = LONG_OPERATORS;
