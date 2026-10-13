// Port of vendor/bun/src/format/js/jsdoc/normalize.rs: the names of tags, emphasis, capital letters, and types.
import { Stack } from "../../../base/stack.ts";
import { QUOTE_DOUBLE } from "../../options.ts";
import { codePointAt, codePointBefore, cpLen, isAlphabetic, isUnicodeWhitespace, linesOf, trimUnicodeWhitespace, trimUnicodeWhitespaceEnd, trimUnicodeWhitespaceStart } from "../../../base/ustr.ts";
import { isAsciiAlphanumeric, isAsciiDigit, parseIndex } from "./text.ts";

/** The name that stands for all the names of a tag: `TAGS_SYNONYMS` of prettier-plugin-jsdoc. */
export function normalizeTagKind(kind: string): string {
  switch (kind) {
    case "return":
      return "returns";
    case "arg":
    case "argument":
    case "params":
      return "param";
    case "yield":
      return "yields";
    case "prop":
      return "property";
    case "constructor":
      return "class";
    case "const":
      return "constant";
    case "desc":
      return "description";
    case "host":
      return "external";
    case "fileoverview":
    case "overview":
      return "file";
    case "emits":
      return "fires";
    case "func":
    case "method":
      return "function";
    case "var":
      return "member";
    case "virtual":
      return "abstract";
    case "exception":
      return "throws";
    case "examples":
      return "example";
    case "hidden":
      return "ignore";
    default:
      return kind;
  }
}

/** `u8::is_ascii_whitespace` of a UTF-16 unit that is a byte of the text. */
function isAsciiWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

function fromCodes(codes: number[]): string {
  let s = "";
  for (let i = 0; i < codes.length; i++) s = s + String.fromCharCode(codes[i]);
  return s;
}

function toCodes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}

/** Where the `*` is that closes the emphasis that the `*` at `opener` opens; -1 if there is none. */
function findEmphasisEnd(bytes: number[], opener: number): number {
  const len = bytes.length;
  let j = opener + 1;
  while (j < len) {
    if (bytes[j] === 96) {
      // Code.
      j = j + 1;
      while (j < len && bytes[j] !== 96) j = j + 1;
      if (j < len) j = j + 1;
      continue;
    }
    if (bytes[j] === 42 && j + 1 < len && bytes[j + 1] === 42) {
      j = j + 2;
      continue;
    }
    if (bytes[j] === 42 && j > opener + 1 && !isAsciiWs(bytes[j - 1])) return j;
    j = j + 1;
  }
  return -1;
}

/** `__text__` becomes `**text**`, `*text*` becomes `_text_`. */
export function normalizeMarkdownEmphasis(text: string): string {
  if (text.indexOf("__") < 0 && text.indexOf("*") < 0) return text;
  const bytes = toCodes(text);
  const len = bytes.length;
  let hasChanged = false;
  let inCode = false;
  let i = 0;
  while (i < len) {
    if (bytes[i] === 96) inCode = !inCode;
    else if (!inCode && bytes[i] === 95 && i + 1 < len && bytes[i + 1] === 95) {
      bytes[i] = 42;
      bytes[i + 1] = 42;
      hasChanged = true;
      i = i + 1;
    }
    i = i + 1;
  }
  inCode = false;
  i = 0;
  while (i < len) {
    if (bytes[i] === 96) {
      inCode = !inCode;
      i = i + 1;
      continue;
    }
    if (inCode || bytes[i] !== 42) {
      i = i + 1;
      continue;
    }
    if (i + 1 < len && bytes[i + 1] === 42) {
      i = i + 2;
      continue;
    }
    // It opens emphasis if something other than white space follows it.
    if (i + 1 < len && !isAsciiWs(bytes[i + 1])) {
      const closer = findEmphasisEnd(bytes, i);
      if (closer >= 0) {
        bytes[i] = 95;
        bytes[closer] = 95;
        hasChanged = true;
        i = closer;
      }
    }
    i = i + 1;
  }
  return hasChanged ? fromCodes(bytes) : text;
}

function startsWithIgnoreCase(text: string, prefix: string): boolean {
  if (text.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    let a = text.charCodeAt(i);
    let b = prefix.charCodeAt(i);
    if (a >= 65 && a <= 90) a = a + 32;
    if (b >= 65 && b <= 90) b = b + 32;
    if (a !== b) return false;
  }
  return true;
}

/**
 * Makes the first letter a capital one, if it is an ASCII letter. Not that of code or of a URL. What comes after any number of `- ` counts
 * as the start.
 */
export function capitalizeFirst(text: string): string {
  if (text.length === 0 || text.startsWith("`") || startsWithIgnoreCase(text, "http://") || startsWithIgnoreCase(text, "https://")) return text;
  let remaining = text;
  while (remaining.startsWith("- ")) remaining = remaining.substring(2);
  const prefixLen = text.length - remaining.length;
  if (prefixLen > 0) {
    const capitalized = capitalizeFirst(remaining);
    return capitalized === remaining ? text : text.substring(0, prefixLen) + capitalized;
  }
  const first = text.charCodeAt(0);
  if (first >= 97 && first <= 122) return String.fromCharCode(first - 32) + text.substring(1);
  return text;
}

/** `text.replace(/([\w\p{L}])$/u, "$1.")` */
export function appendTrailingDot(text: string): string {
  if (text.length === 0) return text;
  const last = codePointBefore(text, text.length);
  if (isAlphabetic(last) || isAsciiDigit(last) || last === 95) return text + ".";
  return text;
}

/** A type over several lines, without the `*` at the start of each, with `separator` in the place of the line breaks. */
function stripStars(text: string, separator: string): string {
  let result = "";
  const ls = linesOf(text);
  for (let index = 0; index < ls.length; index++) {
    const line = ls[index];
    if (index === 0) {
      result = result + line;
      continue;
    }
    result = result + separator;
    const trimmed = trimUnicodeWhitespaceStart(line);
    if (trimmed.startsWith("*")) {
      const rest = trimmed.substring(1);
      result = result + (rest.startsWith(" ") ? rest.substring(1) : rest);
    } else result = result + trimmed;
  }
  return result;
}

export function stripJsdocStarsPreserveNewlines(text: string): string {
  return text.indexOf("\n") >= 0 ? stripStars(text, "\n") : text;
}

/** No quote style: the quotes of `import()` stay as they are. */
const NO_QUOTE_STYLE: number = -1;

/**
 * `convertToModernType` of prettier-plugin-jsdoc: `?Type` and `Type?` become `Type | null`, `*` becomes `any`, `Array<T>` becomes `T[]`,
 * `Foo.<T>` becomes `Foo<T>`, and the quotes in `import()` are those of `quoteStyle`.
 */
export function normalizeType(typeStr: string, quoteStyle: number, stack: Stack): string {
  return normalizeTypeImpl(typeStr, quoteStyle, stack);
}

/** The same with the quotes as they are, for `@type`, `@typedef` and `@satisfies`. */
export function normalizeTypePreserveQuotes(typeStr: string, stack: Stack): string {
  return normalizeTypeImpl(typeStr, NO_QUOTE_STYLE, stack);
}

function normalizeTypeImpl(typeStr: string, quoteStyle: number, stack: Stack): string {
  if (typeStr.indexOf("\n") >= 0) {
    const stripped = stripStars(typeStr, " ");
    return normalizeTypeImpl(stripped, quoteStyle, stack);
  }
  const trimmed = trimUnicodeWhitespace(typeStr);
  if (isAlreadyNormalized(trimmed)) return trimmed;
  const transformed = withoutStrings(typeStr, stack);
  let unquoted = transformed;
  if (quoteStyle !== NO_QUOTE_STYLE) {
    const quoted = normalizeTypeQuotes(transformed, quoteStyle);
    unquoted = unquoteObjectPropertyNames(quoted);
  }
  return fixObjectCommas(unquoted);
}

/** `withoutStrings`: the transformation sees `String$N$` in the place of each string. */
function withoutStrings(typeStr: string, stack: Stack): string {
  if (typeStr.indexOf("'") < 0 && typeStr.indexOf('"') < 0) {
    // A template literal type is left alone.
    return typeStr.indexOf("`") >= 0 ? typeStr : normalizeTypeInner(typeStr, stack);
  }
  const originals: string[] = [];
  let modified = "";
  const len = typeStr.length;
  let i = 0;
  while (i < len) {
    const quote = typeStr.charCodeAt(i);
    if (quote !== 34 && quote !== 39) {
      modified = modified + typeStr.charAt(i);
      i = i + 1;
      continue;
    }
    const start = i;
    i = i + 1;
    while (i < len) {
      if (typeStr.charCodeAt(i) === 92) {
        i = i + (i + 1 < len ? 2 : 1);
        continue;
      }
      i = i + 1;
      if (typeStr.charCodeAt(i - 1) === quote) break;
    }
    modified = modified + "String$" + originals.length + "$";
    originals.push(typeStr.substring(start, i < len ? i : len));
  }
  if (modified.indexOf("`") >= 0) return typeStr;
  const result = normalizeTypeInner(modified, stack);

  // The strings come back.
  const PREFIX = "String$";
  let restored = "";
  let rest = result;
  while (true) {
    const at = rest.indexOf(PREFIX);
    if (at < 0) break;
    const afterStart = at + PREFIX.length;
    let digits = 0;
    while (afterStart + digits < rest.length && isAsciiDigit(rest.charCodeAt(afterStart + digits))) digits = digits + 1;
    let original = -1;
    if (digits > 0 && afterStart + digits < rest.length && rest.charCodeAt(afterStart + digits) === 36) {
      const index = parseIndex(rest.substring(afterStart, afterStart + digits));
      if (index >= 0 && index < originals.length) original = index;
    }
    if (original >= 0) {
      restored = restored + rest.substring(0, at) + originals[original];
      rest = rest.substring(afterStart + digits + 1);
    } else {
      restored = restored + rest.substring(0, at + 1);
      rest = rest.substring(at + 1);
    }
  }
  return restored + rest;
}

function normalizeTypeInner(typeStr: string, stack: Stack): string {
  if (!stack.enter()) return typeStr;
  const r = normalizeTypeInner2(typeStr, stack);
  stack.leave();
  return r;
}

function replaceAll(text: string, from: string, to: string): string {
  return text.split(from).join(to);
}

function normalizeTypeInner2(typeStr: string, stack: Stack): string {
  const replaced = typeStr.indexOf("*") >= 0 ? replaceAll(typeStr, "*", " any ") : typeStr;
  const trimmed = trimUnicodeWhitespace(replaced);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed;
  // `... type`
  if (trimmed.startsWith("...")) {
    const rest = trimUnicodeWhitespaceStart(trimmed.substring(3));
    if (rest.length === 0) return trimmed;
    const normalized = normalizeTypeInner(rest, stack);
    return needsParensForUnion(normalized) ? "...(" + normalized + ")" : "..." + normalized;
  }
  // `?Type`
  if (trimmed.startsWith("?")) {
    const inner = trimUnicodeWhitespace(trimmed.substring(1));
    if (inner.length > 0) return normalizeTypeCore(inner, stack) + " | null";
  }
  // `Type?`
  if (trimmed.endsWith("?")) {
    const inner = trimmed.substring(0, trimmed.length - 1);
    if (!containsQuotes(trimmed) && inner.length > 0 && inner.indexOf("?") < 0) return normalizeTypeCore(inner, stack) + " | null";
  }
  return normalizeTypeCore(trimmed, stack);
}

/** Arrays, the dots before `<`, white space. Each member of a union by itself. */
function normalizeTypeCore(typeStr: string, stack: Stack): string {
  const trimmed = trimUnicodeWhitespace(typeStr);
  const parts = splitAtTopLevelPipe(trimmed);
  if (parts.length > 1) {
    const normalized: string[] = [];
    for (let i = 0; i < parts.length; i++) normalized.push(normalizeTypeCore(trimUnicodeWhitespace(parts[i]), stack));
    return normalized.join(" | ");
  }
  let converted = removeClosureDotGenerics(trimmed);
  while (true) {
    const next = replaceOneArrayPattern(converted, stack);
    if (next === null) break;
    converted = next;
  }
  // What is made of it is of no use.
  if (stack.ranOut()) return converted;
  return normalizeTypeWhitespace(converted);
}

/** Makes `T[]` of one `Array<T>` in `typeStr`. null if there is none. */
function replaceOneArrayPattern(typeStr: string, stack: Stack): string | null {
  if (stack.ranOut()) return null;
  let searchStart = 0;
  while (true) {
    const found = typeStr.indexOf("Array", searchStart);
    if (found < 0) return null;
    const pos = found;
    searchStart = pos + 5;
    if (pos > 0) {
      const prev = typeStr.charCodeAt(pos - 1);
      if (isAsciiAlphanumeric(prev) || prev === 95 || prev === 36 || prev > 0x7f) continue;
    }
    let innerStart = 0;
    if (typeStr.startsWith(".<", pos + 5)) innerStart = pos + 7;
    else if (typeStr.startsWith("<", pos + 5)) innerStart = pos + 6;
    else continue;
    const endOffset = findMatchingCloseAngle(typeStr, innerStart);
    if (endOffset < 0) continue;
    const inner = normalizeTypeInner(typeStr.substring(innerStart, innerStart + endOffset), stack);
    if (stack.ranOut()) return null;
    const after = typeStr.substring(innerStart + endOffset + 1);
    return needsParensForArray(inner) ? typeStr.substring(0, pos) + "(" + inner + ")[]" + after : typeStr.substring(0, pos) + inner + "[]" + after;
  }
}

/** Where the `>` is that closes the `<` before `text[from..]` (relative to `from`); -1 if none. */
function findMatchingCloseAngle(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const b = text.charCodeAt(i);
    if (b === 60) depth = depth + 1;
    // Not that of `=>`.
    else if (b === 62 && (i === from || text.charCodeAt(i - 1) !== 61)) {
      depth = depth - 1;
      if (depth === 0) return i - from;
    }
  }
  return -1;
}

/** The parts of `typeStr` between the `|` that are not in brackets of any kind. */
function splitAtTopLevelPipe(typeStr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < typeStr.length; i++) {
    const b = typeStr.charCodeAt(i);
    if (b === 40 || b === 60 || b === 91 || b === 123) depth = depth + 1;
    else if (b === 41 || b === 93 || b === 125) depth = depth - 1;
    else if (b === 62 && (i === 0 || typeStr.charCodeAt(i - 1) !== 61)) depth = depth - 1;
    else if (b === 124 && depth === 0) {
      parts.push(typeStr.substring(start, i));
      start = i + 1;
    }
  }
  parts.push(typeStr.substring(start));
  return parts;
}

/** Whether `trimmed` ends with the `=` of Closure's optional types. */
function hasOptionalSuffix(trimmed: string): boolean {
  return trimmed.endsWith("=") && !containsQuotes(trimmed);
}

/** For `@returns`, `@yields` and `@throws`: `type=` is `type | undefined`. */
export function normalizeTypeReturn(typeStr: string, quoteStyle: number, stack: Stack): string {
  const trimmed = trimUnicodeWhitespace(typeStr);
  if (hasOptionalSuffix(trimmed) && trimmed.length > 1) {
    const normalized = normalizeType(trimmed.substring(0, trimmed.length - 1), quoteStyle, stack);
    return normalized + " | undefined";
  }
  return normalizeType(trimmed, quoteStyle, stack);
}

/** The type without the `=` at its end (into `OPTIONAL_TYPE[0]`: whether there is one). */
export const OPTIONAL_TYPE = new Int32Array(1);
export function stripOptionalTypeSuffix(typeStr: string): string {
  const trimmed = trimUnicodeWhitespace(typeStr);
  OPTIONAL_TYPE[0] = 0;
  if (hasOptionalSuffix(trimmed)) {
    const inner = trimUnicodeWhitespaceEnd(trimmed.substring(0, trimmed.length - 1));
    if (inner.length > 0) {
      OPTIONAL_TYPE[0] = 1;
      return inner;
    }
  }
  return trimmed;
}

function needsParensForArray(typeStr: string): boolean {
  if (typeStr.startsWith("(") && typeStr.endsWith(")")) return false;
  return needsParensForUnion(typeStr) || containsTopLevelArrow(typeStr);
}

function containsTopLevelArrow(typeStr: string): boolean {
  let depth = 0;
  let prev = 0;
  for (let i = 0; i < typeStr.length; i++) {
    const b = typeStr.charCodeAt(i);
    if (b === 40 || b === 60 || b === 91 || b === 123) depth = depth + 1;
    else if (b === 41 || b === 93 || b === 125) depth = depth - 1;
    else if (b === 62 && prev !== 61) depth = depth - 1;
    else if (b === 61 && depth === 0 && i + 1 < typeStr.length && typeStr.charCodeAt(i + 1) === 62) return true;
    prev = b;
  }
  return false;
}

function needsParensForUnion(typeStr: string): boolean {
  if (typeStr.startsWith("(") && typeStr.endsWith(")")) return false;
  let depth = 0;
  let prev = 0;
  for (let i = 0; i < typeStr.length; i++) {
    const b = typeStr.charCodeAt(i);
    if (b === 40 || b === 60 || b === 91 || b === 123) depth = depth + 1;
    else if (b === 41 || b === 93 || b === 125) depth = depth - 1;
    else if (b === 62 && prev !== 61) depth = depth - 1;
    else if (b === 124 && depth === 0) return true;
    prev = b;
  }
  return false;
}

/** `Object.<String, Number>` becomes `Object<String, Number>`. */
function removeClosureDotGenerics(typeStr: string): string {
  if (typeStr.indexOf(".<") < 0) return typeStr;
  let result = "";
  let quote = 0;
  for (let i = 0; i < typeStr.length; i++) {
    const b = typeStr.charCodeAt(i);
    if (quote !== 0) {
      if (b === quote) quote = 0;
    } else if (b === 34 || b === 39) quote = b;
    else if (b === 46 && i + 1 < typeStr.length && typeStr.charCodeAt(i + 1) === 60) continue;
    result = result + typeStr.charAt(i);
  }
  return result;
}

function containsQuotes(text: string): boolean {
  return text.indexOf('"') >= 0 || text.indexOf("'") >= 0;
}

/** The quotes of the paths in `import()` become those of `quoteStyle`. No others do. */
function normalizeTypeQuotes(typeStr: string, quoteStyle: number): string {
  const sourceQuote = quoteStyle === QUOTE_DOUBLE ? 39 : 34;
  const targetQuote = quoteStyle === QUOTE_DOUBLE ? 34 : 39;
  if (typeStr.indexOf(String.fromCharCode(sourceQuote)) < 0) return typeStr;
  let result = "";
  const len = typeStr.length;
  let i = 0;
  while (i < len) {
    if (!typeStr.startsWith("import(", i)) {
      result = result + typeStr.charAt(i);
      i = i + 1;
      continue;
    }
    result = result + "import(";
    i = i + 7;
    while (i < len && typeStr.charCodeAt(i) === 32) {
      result = result + " ";
      i = i + 1;
    }
    if (i >= len || typeStr.charCodeAt(i) !== sourceQuote) continue;
    result = result + String.fromCharCode(targetQuote);
    i = i + 1;
    while (i < len && typeStr.charCodeAt(i) !== sourceQuote) {
      const c = typeStr.charCodeAt(i);
      if (c === 92 && i + 1 < len) {
        if (typeStr.charCodeAt(i + 1) === sourceQuote) {
          result = result + String.fromCharCode(sourceQuote);
          i = i + 2;
        } else {
          // The backslash and the character after it.
          const charLen = cpLen(codePointAt(typeStr, i + 1));
          result = result + typeStr.substring(i, i + 1 + charLen);
          i = i + 1 + charLen;
        }
      } else if (c === targetQuote) {
        result = result + "\\" + String.fromCharCode(targetQuote);
        i = i + 1;
      } else {
        result = result + typeStr.charAt(i);
        i = i + 1;
      }
    }
    if (i < len) {
      result = result + String.fromCharCode(targetQuote);
      i = i + 1;
    }
  }
  return result;
}

/** `lexer::is_identifier` of ASCII text. */
function isAsciiIdentifier(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const start = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
    if (c >= 0x80) return false;
    if (i === 0 ? !start : !(start || isAsciiDigit(c))) return false;
  }
  return true;
}

/** `"userId": string` becomes `userId: string`. */
function unquoteObjectPropertyNames(typeStr: string): string {
  if (typeStr.indexOf('"') < 0) return typeStr;
  const len = typeStr.length;
  let result = "";
  let i = 0;
  while (i < len) {
    if (typeStr.charCodeAt(i) !== 34) {
      result = result + typeStr.charAt(i);
      i = i + 1;
      continue;
    }
    const start = i + 1;
    i = i + 1;
    let end = -1;
    while (i < len) {
      if (typeStr.charCodeAt(i) === 92 && i + 1 < len) {
        i = i + 2;
        continue;
      }
      i = i + 1;
      if (typeStr.charCodeAt(i - 1) === 34) {
        end = i - 1;
        break;
      }
    }
    if (end < 0) {
      result = result + '"' + typeStr.substring(start);
      continue;
    }
    const content = typeStr.substring(start, end);
    if (trimUnicodeWhitespaceStart(typeStr.substring(i)).startsWith(":") && isAsciiIdentifier(content)) result = result + content;
    else result = result + typeStr.substring(start - 1, end + 1);
  }
  return result;
}

/** `fixObjectCommas`: in the type of an object, `; x` becomes `, x`. */
function fixObjectCommas(typeStr: string): string {
  const trimmed = trimUnicodeWhitespace(typeStr);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || trimmed.length < 2 || trimmed.substring(1, trimmed.length - 1).indexOf(":") < 0 || trimmed.indexOf("; ") < 0) return typeStr;
  const result = toCodes(trimmed);
  for (let i = 0; i + 2 < result.length; i++) {
    if (result[i] === 59 && result[i + 1] === 32 && (isAsciiAlphanumeric(result[i + 2]) || result[i + 2] === 95)) result[i] = 44;
  }
  return fromCodes(result);
}

/** One space in the place of any white space, and spaces around `|`, `&` and `=>`. */
export function normalizeTypeWhitespace(typeStr: string): string {
  const trimmed = trimUnicodeWhitespace(typeStr);
  const len = trimmed.length;
  let result = "";
  let prevWasSpace = false;
  let i = 0;
  while (i < len) {
    const b = trimmed.charCodeAt(i);
    // A comment stays as it is, up to the end of its line.
    if (b === 47 && i + 1 < len && trimmed.charCodeAt(i + 1) === 47) {
      const nl = trimmed.indexOf("\n", i);
      const end = nl < 0 ? len : nl + 1;
      result = result + trimmed.substring(i, end);
      i = end;
      prevWasSpace = false;
      continue;
    }
    let operatorLen = 0;
    if (b === 61 && i + 1 < len && trimmed.charCodeAt(i + 1) === 62) operatorLen = 2;
    else if (b === 124 || b === 38) operatorLen = 1;
    if (operatorLen > 0) {
      if (!prevWasSpace && result.length > 0) result = result + " ";
      result = result + trimmed.substring(i, i + operatorLen);
      i = i + operatorLen;
      prevWasSpace = i < len && !isAsciiWs(trimmed.charCodeAt(i));
      if (prevWasSpace) result = result + " ";
      continue;
    }
    const cp = codePointAt(trimmed, i);
    const charLen = cpLen(cp);
    if (b < 128 ? isAsciiWs(b) : isUnicodeWhitespace(cp)) {
      if (!prevWasSpace) {
        result = result + " ";
        prevWasSpace = true;
      }
    } else {
      result = result + trimmed.substring(i, i + charLen);
      prevWasSpace = false;
    }
    i = i + charLen;
  }
  return result === trimmed ? trimmed : result;
}

/** Whether nothing in `text` is something that `normalizeType` changes. */
function isAlreadyNormalized(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 63 || c === 39 || c === 34 || c === 123 || c === 125 || c === 42 || c === 61 || c === 38 || c === 124 || c === 33 || c === 10) return false;
  }
  return text.indexOf("Array<") < 0 && text.indexOf("Array.<") < 0 && !text.startsWith("...") && text.indexOf("  ") < 0;
}
