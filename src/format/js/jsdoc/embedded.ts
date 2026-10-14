// Port of vendor/bun/src/format/js/jsdoc/embedded.rs: code and types in comments, which are formatted as what they are.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { FormatOptions, EMBEDDED_OFF, LINE_ENDING_LF, TRAILING_COMMAS_NONE } from "../../options.ts";
import { decodeBytes, encodeString, trimUnicodeWhitespaceEnd, trimUnicodeWhitespaceStart, trimUnicodeWhitespace } from "../../../base/ustr.ts";
import { trimEndMatchesCp } from "./text.ts";
import { format as formatCss, PARSER_CSS, PARSER_LESS, PARSER_SCSS } from "../../css/mod.ts";
import { formatJson } from "../../json/mod.ts";
import { PARSER_JSON } from "../../json/config.ts";
import { formatYaml } from "../../yaml/mod.ts";
import { FORMAT_OK } from "../../errors.ts";

/** The widest line that oxfmt knows. */
const MAX_LINE_WIDTH = 320;

/** The options for something in a comment of a file that is formatted with `options`. */
export function embeddedOptions(options: FormatOptions, printWidth: number): FormatOptions {
  // oxfmt has 16 bits for it.
  let width = printWidth <= 65535 ? printWidth : 80;
  if (width < 1) width = 1;
  if (width > MAX_LINE_WIDTH) width = MAX_LINE_WIDTH;
  const o = options.copy();
  o.lineWidth = width;
  // The lines are written to the document of the file, one by one.
  o.lineEnding = LINE_ENDING_LF;
  o.jsdoc = null;
  o.sortImports = -1;
  o.filepath = "";
  o.parser = "";
  o.rangeStart = -1;
  o.rangeEnd = -1;
  o.cursorOffset = -1;
  o.insertPragma = false;
  o.requirePragma = false;
  o.checkIgnorePragma = false;
  o.isInMarkdown = false;
  return o;
}

/** Tells the formatter of JSDoc that the HIR of the file has been replaced by that of another text (see mod.ts). */
export class NestedState {
  dirty: boolean = false;
  /** Parses the file that is being formatted again, after a nested format has replaced it. */
  restore: (() => boolean) | null = null;
}
export const nested = new NestedState();

/** `code` formatted as the file at `path`, without white space at its end. null if it has a syntax error. */
function parseAndBuild(path: string, code: string, options: FormatOptions): string | null {
  const formatJavascript = options.formatJavascript;
  if (formatJavascript === null) return null;
  const bytes = encodeString(code);
  const out = new ByteBuf(bytes.length + 64);
  const nested$ = nested;
  nested$.dirty = true;
  const ok = formatJavascript(path, bytes, 0, bytes.length, options, out);
  // The nested format has replaced the HIR of the file that is being formatted.
  if (nested$.restore !== null) nested$.restore();
  if (!ok) return null;
  return trimUnicodeWhitespaceEnd(decodeBytes(out.data, 0, out.len));
}

const TSX = "dummy.tsx";
const JSX = "dummy.jsx";

export function isJsTsLang(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === "js" || l === "javascript" || l === "jsx" || l === "ts" || l === "typescript" || l === "tsx";
}

/**
 * Code in a description in one of the languages that prettier-plugin-jsdoc formats and that is neither JavaScript nor TypeScript.
 * null: it stays as it is.
 */
export function formatEmbeddedLanguage(lang: string, code: string, printWidth: number, options0: FormatOptions): string | null {
  if (options0.embeddedLanguageFormatting === EMBEDDED_OFF) return null;
  const options = embeddedOptions(options0, printWidth);
  options.lineWidth = printWidth;
  const bytes = encodeString(code);
  const out = new ByteBuf(bytes.length + 64);
  let r = FORMAT_OK;
  switch (lang.toLowerCase()) {
    case "css":
      r = formatCss(bytes, PARSER_CSS, options, out);
      break;
    case "less":
      r = formatCss(bytes, PARSER_LESS, options, out);
      break;
    case "scss":
      r = formatCss(bytes, PARSER_SCSS, options, out);
      break;
    case "json":
      r = formatJson(bytes, bytes.length, PARSER_JSON, options, out);
      break;
    case "yaml":
      r = formatYaml(bytes, bytes.length, options, out);
      break;
    default:
      return null;
  }
  if (r !== FORMAT_OK) return null;
  return trimUnicodeWhitespaceEnd(decodeBytes(out.data, 0, out.len));
}

/** How deep in template literals the end of `line` is, if its start is `depth` deep. */
export function updateTemplateDepth(line: string, depth0: number): number {
  let depth = depth0;
  // For each `${` that is open: how many braces are open in it.
  const expressionBraceDepth: number[] = [];
  let i = 0;
  while (i < line.length) {
    const b = line.charCodeAt(i);
    if (b === 92) i = i + 1;
    else if (b === 96 && expressionBraceDepth.length === 0) {
      depth = (depth === 0 ? 1 : 0) + (depth > 0 ? depth - 1 : 0);
    } else if (b === 96) expressionBraceDepth.push(0);
    else if (b === 36 && depth > 0 && i + 1 < line.length && line.charCodeAt(i + 1) === 123) {
      expressionBraceDepth.push(0);
      i = i + 1;
    } else if (b === 123) {
      if (expressionBraceDepth.length > 0) expressionBraceDepth[expressionBraceDepth.length - 1] = expressionBraceDepth[expressionBraceDepth.length - 1] + 1;
    } else if (b === 125) {
      if (expressionBraceDepth.length > 0) {
        const last = expressionBraceDepth[expressionBraceDepth.length - 1];
        if (last === 0) expressionBraceDepth.pop();
        else expressionBraceDepth[expressionBraceDepth.length - 1] = last - 1;
      }
    }
    i = i + 1;
  }
  return depth;
}

/** `code` formatted as JavaScript or TypeScript, in lines of at most `printWidth` columns. null if it is neither. */
export function formatEmbeddedJs(code: string, printWidth: number, options: FormatOptions): string | null {
  const baseOptions = embeddedOptions(options, printWidth);
  const trimmed = trimUnicodeWhitespace(code);
  if (!trimmed.startsWith("{")) {
    // TSX first: `getItem<number>(..)` is something else in JSX.
    const r = parseAndBuild(TSX, code, baseOptions);
    if (r !== null) return r;
    return parseAndBuild(JSX, code, baseOptions);
  }
  // An object, which would be a block with labels. prettier-plugin-jsdoc formats it as JSON, which keeps the quotes of keys, so one with
  // quotes is left alone.
  const quote = trimmed.indexOf('"');
  const brace = trimmed.indexOf("}");
  if (quote >= 0 && brace >= 0 && quote < brace) return null;
  const wrapped = "(" + trimmed + ")";
  const objectOptions = baseOptions.copy();
  objectOptions.trailingCommas = TRAILING_COMMAS_NONE;
  const first = formatObject(JSX, wrapped, objectOptions);
  if (first !== null) return first;
  return formatObject(TSX, wrapped, objectOptions);
}

function formatObject(path: string, wrapped: string, objectOptions: FormatOptions): string | null {
  const formatted = parseAndBuild(path, wrapped, objectOptions);
  if (formatted === null) return null;
  if (!(formatted.startsWith("(") && formatted.endsWith(");"))) return formatted;
  const inner = formatted.substring(1, formatted.length - 2);
  // Something behind the object: it is a call, and the parentheses are not the ones that were added.
  return trimUnicodeWhitespace(inner).endsWith("}") ? inner : null;
}

/**
 * `formatType` of prettier-plugin-jsdoc: the type is formatted as that of `type __t = ..;`. null if that fails or changes nothing.
 * `options`: from `embeddedOptions`.
 */
export function formatTypeViaFormatter(typeStr: string, options: FormatOptions): string | null {
  if (typeStr.length === 0) return null;
  // `...Type` is formatted as `(Type)[]`.
  if (typeStr.startsWith("...")) {
    const rest = trimUnicodeWhitespaceStart(typeStr.substring(3));
    if (rest.length === 0) return null;
    const formatted = formatTypeViaFormatter("(" + rest + ")[]", options);
    if (formatted === null || !formatted.endsWith("[]")) return null;
    return "..." + formatted.substring(0, formatted.length - 2);
  }
  if (!needsFormatterPass(typeStr)) return null;
  const START = "type __t = ";
  const formatted = parseAndBuild(TSX, START + typeStr + ";", options);
  if (formatted === null || formatted.length < START.length) return null;
  let result = trimUnicodeWhitespaceStart(formatted.substring(START.length));
  result = trimEndMatchesSemiOrNewline(result);
  result = trimUnicodeWhitespace(result.startsWith("|") ? result.substring(1) : result);
  return result.length > 0 && result !== typeStr ? result : null;
}

function trimEndMatchesSemiOrNewline(s: string): string {
  let n = s.length;
  while (n > 0 && (s.charCodeAt(n - 1) === 59 || s.charCodeAt(n - 1) === 10)) n = n - 1;
  return s.substring(0, n);
}

/** Whether there is anything in the type that the formatter could change. */
function needsFormatterPass(typeStr: string): boolean {
  for (let i = 0; i < typeStr.length; i++) {
    const c = typeStr.charCodeAt(i);
    if (c === 124 || c === 38 || c === 123 || c === 125 || c === 40 || c === 41 || c === 10) return true;
  }
  return typeStr.indexOf("=>") >= 0;
}

void trimEndMatchesCp;
