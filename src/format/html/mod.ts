// Port of vendor/bun/src/format/html/mod.rs: HTML, Vue, Angular templates, Lightning Web Components and MJML.
//
// The specification is Prettier's `src/language-html`, which parses with `angular-html-parser`.
//
//   text ─ lexer ─→ tokens ─ parser, parse ─→ Tree ─ preprocess ─→ what white space counts ─ printer ─→ the document of `ir`
//
// What is in another language (scripts, style sheets, expressions in attributes) is written to the same document by the formatter for that
// language: `embed`.
//
//   format(path, text, parser, options, out): FORMAT_* code
//
// `FORMAT_SYNTAX_ERROR`: `syntaxError(text, parser)` says why (Prettier's message) and where. The cursor: `lastCursor()`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { utf16Len } from "../../base/utf8.ts";
import { parseFrontMatter } from "../front_matter.ts";
import {
  FORMAT_INVALID_DOCUMENT,
  FORMAT_NESTED_TOO_DEEPLY,
  FORMAT_OK,
  FORMAT_SYNTAX_ERROR,
} from "../errors.ts";
import { FLAVOR_PRETTIER, FormatOptions, HTML_ROOT_NG_ACTION, InHtml, resolveLineEnding } from "../options.ts";
import { Formatter } from "../ir/formatter.ts";
import { Scratch, finishAndPrint, marksEnd, marksStart, startDocument } from "../ir/run.ts";
import { cursorInRegion, cursorOffsetInBytes, cursorInFormattedText } from "../cursor.ts";
import { computeOffsets, normalizedLen, offsetsEnd, offsetsStart, writeWithLineEnding } from "../graphql/range.ts";
import { jsWhitespaceLen, startsWithBom, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  HTree,
  P_ANGULAR,
  P_HTML,
  P_LWC,
  P_MJML,
  P_VUE,
  firstChild,
  nextOf,
} from "./ast.ts";
import { HOptions } from "./hoptions.ts";
import { Cursor, Printer, CUR_NOWHERE } from "./pstate.ts";
import { Writer } from "./writer.ts";
import { PARSE_NESTED_TOO_DEEPLY, PARSE_OK, PE, parseErrorAt, parseErrorMessage, parseTree } from "./parse.ts";
import { preprocess } from "./preprocess.ts";
import { printRoot } from "./printer.ts";
import { locate, regionOf } from "./cursor.ts";
import { wouldRepeatSubstitution } from "./in_js.ts";
import { writeAngularExpression } from "./angular.ts";
import { HUG_BARE } from "./js.ts";
import { hasSameContent as contentIsSame } from "./verify.ts";

// Prettier's `parser` for the expressions of Angular: the numbers of `HTML_NG_*` of src/driver/kinds.ts.
export const PARSER_NG_ACTION: number = 5;
export const PARSER_NG_BINDING: number = 6;
export const PARSER_NG_DIRECTIVE: number = 7;
export const PARSER_NG_INTERPOLATION: number = 8;

export { P_ANGULAR, P_HTML, P_LWC, P_MJML, P_VUE };

/** Prettier's `parser` option: -1 if it is none of these. */
export function parserFromName(name: string): number {
  switch (name) {
    case "html": return P_HTML;
    case "angular": return P_ANGULAR;
    case "vue": return P_VUE;
    case "lwc": return P_LWC;
    case "mjml": return P_MJML;
    case "__ng_action": return PARSER_NG_ACTION;
    case "__ng_binding": return PARSER_NG_BINDING;
    case "__ng_directive": return PARSER_NG_DIRECTIVE;
    case "__ng_interpolation": return PARSER_NG_INTERPOLATION;
    default: return -1;
  }
}

/** The parser that Prettier infers from the name of a file. -1 if it is none of these languages. */
export function parserForPath(path: string): number {
  const lower = path.toLowerCase();
  if (lower.endsWith(".component.html")) return P_ANGULAR;
  if (
    lower.endsWith(".html") ||
    lower.endsWith(".hta") ||
    lower.endsWith(".htm") ||
    lower.endsWith(".html.hl") ||
    lower.endsWith(".inc") ||
    lower.endsWith(".xht") ||
    lower.endsWith(".xhtml")
  ) {
    return P_HTML;
  }
  if (lower.endsWith(".mjml")) return P_MJML;
  if (lower.endsWith(".vue")) return P_VUE;
  return -1;
}

/** Everything that is allocated to format a text and can be used again for the next one. */
class DocState {
  scratch: Scratch | null = null;
  /** The trees, by how deep documents are in each other. */
  trees: HTree[] = [];
  depth: number = 0;
  topLevelCount: number = 0;
  region: ReturnType<typeof regionOf> = null;
  cursor: number = -1;
}
const state = new DocState();

/** Where the cursor ended up in what the last `format` call made (UTF-16 code units; -1: nowhere). */
export function lastCursor(): number {
  return state.cursor;
}

function scratchFor(options: FormatOptions): Scratch {
  let s = state.scratch;
  if (s === null) {
    s = new Scratch(options);
    state.scratch = s;
  }
  return s;
}

const BOM_BYTES = new Uint8Array([0xef, 0xbb, 0xbf]);
const PRAGMA_COMMENT = "<!-- @format -->\n\n";

/** `/^\s*<!--\s*@(?:a|b)\s*-->/.test(text)` */
function hasPragma(text: Uint8Array, a: string, b: string): boolean {
  let at = trimJsWhitespaceStart(text, 0, text.length);
  if (!(at + 4 <= text.length && text[at] === 60 && text[at + 1] === 33 && text[at + 2] === 45 && text[at + 3] === 45)) return false;
  at = trimJsWhitespaceStart(text, at + 4, text.length);
  if (!(at < text.length && text[at] === 64)) return false;
  at = at + 1;
  for (const pragma of [a, b]) {
    let ok = at + pragma.length <= text.length;
    for (let i = 0; ok && i < pragma.length; i++) {
      if ((text[at + i] | 0) !== pragma.charCodeAt(i)) ok = false;
    }
    if (!ok) continue;
    const rest = trimJsWhitespaceStart(text, at + pragma.length, text.length);
    if (rest + 3 <= text.length && text[rest] === 45 && text[rest + 1] === 45 && text[rest + 2] === 62) return true;
  }
  return false;
}

/** `bun_core::strings::crlf_as_lf`: each `\r\n` and each `\r` is `\n`. The text itself if there is no `\r`. */
export function crlfAsLf(text: Uint8Array, from: number): Uint8Array {
  let cr = -1;
  for (let i = from; i < text.length; i++) {
    if ((text[i] | 0) === 13) {
      cr = i;
      break;
    }
  }
  if (cr < 0) return from === 0 ? text : text.subarray(from);
  const out = new Uint8Array(text.length - from);
  let o = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i] | 0;
    if (c === 13) {
      out[o] = 10;
      o = o + 1;
      if (i + 1 < text.length && (text[i + 1] | 0) === 10) i = i + 1;
    } else {
      out[o] = c;
      o = o + 1;
    }
  }
  return out.subarray(0, o);
}

/** What is formatted of a text: see `preparedText`. */
class Prepared {
  text: Uint8Array = new Uint8Array(0);
  isRange: boolean = false;
}
const prepared = new Prepared();

/**
 * What is formatted of `text`: without the byte order mark, with `\n` for every line break, and with the pragma that is to be inserted.
 * And whether only a part of it is to be formatted. false: because of a pragma, or because that part is empty, it stays as it is.
 */
function preparedText(text: Uint8Array, options: FormatOptions): boolean {
  const first = startsWithBom(text, 0) ? 3 : 0;
  let start = first;
  let end = text.length;
  if (options.rangeStart >= 0 || options.rangeEnd >= 0 || options.cursorOffset >= 0) {
    computeOffsets(text, first, options.rangeStart, options.rangeEnd);
    start = offsetsStart();
    end = offsetsEnd();
  }
  start = normalizedLen(text, first, start < first ? first : start > text.length ? text.length : start);
  end = normalizedLen(text, first, end < first ? first : end > text.length ? text.length : end);
  const lf = crlfAsLf(text, first);
  const hasFormatPragma = (options.requirePragma || options.insertPragma) && hasPragma(lf, "format", "prettier");
  if (
    (start >= end && lf.length > 0) ||
    (options.requirePragma && !hasFormatPragma) ||
    (options.checkIgnorePragma && hasPragma(lf, "noformat", "noprettier"))
  ) {
    return false;
  }
  const isRange = start > 0 || end < lf.length;
  if (!isRange && options.insertPragma && !options.requirePragma && !hasFormatPragma) {
    const buf = new ByteBuf(lf.length + 24);
    buf.appendAscii(PRAGMA_COMMENT);
    buf.appendAll(lf);
    prepared.text = buf.view();
    prepared.isRange = false;
    return true;
  }
  prepared.text = lf;
  prepared.isRange = isRange;
  return true;
}

/** Whether `after`, which `before` has been formatted to with `options`, has all that is in `before` and nothing else. */
function keepsContent(before: Uint8Array, after: Uint8Array, parser: number, options: FormatOptions): boolean {
  const first = startsWithBom(after, 0) ? 3 : 0;
  const afterLf = crlfAsLf(after, first);
  if (!preparedText(before, options)) return true;
  const beforeText = prepared.text;
  if (trimJsWhitespaceStart(beforeText, 0, beforeText.length) >= beforeText.length) return true;
  return contentIsSame(beforeText, afterLf, parser);
}

/**
 * The same, whatever has become of imports and JSDoc comments if `options` has something to say about them. See `verify.ts`.
 */
export function hasSameContent(before: Uint8Array, after: Uint8Array, parser: number, options: FormatOptions): boolean {
  if (parser >= PARSER_NG_ACTION || keepsContent(before, after, parser, options)) return true;
  if (options.sortImports < 0 && options.jsdoc === null && options.tailwind < 0) return false;
  // Two imports of a module can become one, words of a JSDoc comment others, and a class that is there twice is there once. The rest is
  // compared without that.
  const plain = options.copy();
  plain.sortImports = -1;
  plain.jsdoc = null;
  plain.tailwind = -1;
  const out = new ByteBuf(before.length + 64);
  const saved = state.cursor;
  const r = format("", before, parser, plain, out);
  state.cursor = saved;
  return r === FORMAT_OK && keepsContent(before, out.view(), parser, plain);
}

/** Whether oxfmt formats the scripts of a text that `parser` parses by itself. HTML and all other code in it is Prettier's. */
function isVueFile(options: FormatOptions, parser: number): boolean {
  return parser === P_VUE && !options.isInMarkdown;
}

/** `options` for a text that `parser` parses. */
export function optionsOfHost(options: FormatOptions, parser: number): FormatOptions {
  const o = options.copy();
  const isVue = isVueFile(options, parser);
  // The plugins of Prettier have sorted the imports of a Vue file when it is parsed. (TODO(port) for the owner of `sort_imports`:
  // `how.is_applied_by_format()` / `how.applies_to_embedded_code()`.)
  o.sortImports = -1;
  o.jsdoc = isVue ? options.jsdoc : null;
  o.flavor = FLAVOR_PRETTIER;
  return o;
}

/** The text with blanks in the place of the front matter, so that all positions stay; the length of the front matter (-1: none). */
class WithoutFrontMatter {
  content: Uint8Array = new Uint8Array(0);
  len: number = -1;
}
const withoutFm = new WithoutFrontMatter();

function withoutFrontMatter(text: Uint8Array): void {
  const fm = parseFrontMatter(text);
  if (fm === null) {
    withoutFm.content = text;
    withoutFm.len = -1;
    return;
  }
  const blanked = text.slice();
  for (let i = 0; i < fm.end; i++) {
    if ((blanked[i] | 0) !== 10) blanked[i] = 32;
  }
  withoutFm.content = blanked;
  withoutFm.len = fm.end;
}

function treeAt(depth: number): HTree {
  while (state.trees.length <= depth) state.trees.push(new HTree());
  return state.trees[depth];
}

/** The message of the syntax error of the last `syntaxError` that said yes, and its offset in the original text. */
class SyntaxErrorInfo {
  message: string = "";
  offset: number = 0;
}
const lastSyntaxError = new SyntaxErrorInfo();
export function syntaxErrorMessage(): string {
  return lastSyntaxError.message;
}
export function syntaxErrorOffset(): number {
  return lastSyntaxError.offset;
}

/**
 * Why `text` cannot be parsed: Prettier's message, and at which byte of `text`, not counting a byte order mark (see `syntaxErrorMessage()`,
 * `syntaxErrorOffset()`). false: it can be.
 */
export function syntaxError(text: Uint8Array, parser: number): boolean {
  if (parser >= PARSER_NG_ACTION) return false;
  const bom = startsWithBom(text, 0) ? 3 : 0;
  const original = bom === 0 ? text : text.subarray(bom);
  const lf = crlfAsLf(original, 0);
  withoutFrontMatter(lf);
  const t = treeAt(state.depth);
  t.reset(withoutFm.content);
  const r = parseTree(t, withoutFm.len, parser);
  if (r !== PARSE_OK) {
    if (r === PARSE_NESTED_TOO_DEEPLY) return false;
    const msg = new ByteBuf(64);
    parseErrorMessage(t.pool.data, msg);
    lastSyntaxError.message = msg.toUtf8();
    // A line break of two bytes is one in what has been parsed.
    let at = 0;
    let left = parseErrorAt();
    while (left > 0 && at < original.length) {
      at = at + ((original[at] | 0) === 13 && at + 1 < original.length && (original[at + 1] | 0) === 10 ? 2 : 1);
      left = left - 1;
    }
    lastSyntaxError.offset = at;
    return true;
  }
  return false;
}

/** Whether `text`, in which every line break is `\n`, has no syntax error. */
export function canBeParsed(text: Uint8Array, parser: number): boolean {
  withoutFrontMatter(text);
  const t = treeAt(state.depth);
  t.reset(withoutFm.content);
  return parseTree(t, withoutFm.len, parser) === PARSE_OK;
}

/**
 * Writes the document for `text`, in which every line break is `\n`. Returns a `FORMAT_*` code; `state.topLevelCount` is how many nodes are at
 * the top level.
 *
 * `isEmbedded`: the text is in a text in another language, and no line break is written at the end. `indentLevel`: how many `indent`s are
 * around what is written, if that is known (-1: not). `cursorOffset`: where the cursor is in `text` (-1: nowhere). `scriptFlavor`: whose
 * output the scripts are.
 */
export function writeDocument(
  f: Formatter,
  text: Uint8Array,
  parser: number,
  path: string | null,
  options: FormatOptions,
  isEmbedded: boolean,
  indentLevel: number,
  cursorOffset: number,
  scriptFlavor: number,
): number {
  withoutFrontMatter(text);
  const fmLen = withoutFm.len;
  const depth = state.depth;
  const t = treeAt(depth);
  t.reset(withoutFm.content);
  const r = parseTree(t, fmLen, parser);
  if (r !== PARSE_OK) return r === PARSE_NESTED_TOO_DEEPLY ? FORMAT_NESTED_TOO_DEEPLY : FORMAT_SYNTAX_ERROR;
  const cursor = cursorOffset >= 0 ? locate(t, cursorOffset) : new Cursor();
  const o = new HOptions(parser, text, options, path !== null, path === null ? "" : path, isEmbedded || options.isInMarkdown, scriptFlavor);
  if (!preprocess(t, o)) return FORMAT_NESTED_TOO_DEEPLY;
  if (options.htmlTemplateDepth > 0 && wouldRepeatSubstitution(t)) return FORMAT_SYNTAX_ERROR;
  const w = new Writer(f, indentLevel, !isEmbedded);
  const p = new Printer(t, o, w, cursor);
  state.depth = depth + 1;
  printRoot(p, !isEmbedded);
  state.depth = depth;
  const isNestedTooDeeply = p.isNestedTooDeeply;
  w.finish();
  if (isNestedTooDeeply) return FORMAT_NESTED_TOO_DEEPLY;
  let count = 0;
  for (let c = firstChild(t, t.root); c >= 0; c = nextOf(t, c)) count = count + 1;
  state.topLevelCount = count;
  state.region = cursor.kind !== CUR_NOWHERE ? regionOf(t, cursor) : null;
  return FORMAT_OK;
}

/** How many nodes were at the top level of the last document written. */
export function topLevelCount(): number {
  return state.topLevelCount;
}

/** HTML in HTML: writes `text` as a document that is in another one, to `f`. Returns whether it has been written. */
export function writeEmbeddedDocument(f: Formatter, text: Uint8Array, parser: number, host: HOptions, indentLevel: number): boolean {
  const r = writeDocument(f, text, parser, host.hasFilepath ? host.filepath : null, host.format, true, indentLevel, -1, FLAVOR_PRETTIER);
  return r === FORMAT_OK;
}

/** Appends `text`, which is an expression of Angular, as it is formatted to `out`. No line break ends it. */
function formatAngularExpression(text: Uint8Array, parser: number, options: FormatOptions, out: ByteBuf): number {
  const start = out.len;
  const o = options.copy();
  o.lineEnding = resolveLineEnding(options.lineEnding, text);
  let body = text;
  if (startsWithBom(text, 0)) {
    out.appendAll(BOM_BYTES);
    body = text.subarray(3);
  }
  body = crlfAsLf(body, 0);
  if (trimJsWhitespaceStart(body, 0, body.length) >= body.length) return FORMAT_OK;
  const f = startDocument(scratchFor(o), body, o, null);
  const t = treeAt(state.depth);
  t.reset(new Uint8Array(0));
  const ho = new HOptions(P_ANGULAR, body, o, false, "", false, o.flavor);
  const w = new Writer(f, 0, true);
  const p = new Printer(t, ho, w, new Cursor());
  const inHtml = new InHtml();
  inHtml.root = HTML_ROOT_NG_ACTION + (parser - PARSER_NG_ACTION);
  const isWritten = writeAngularExpression(p, body, 0, body.length, inHtml, HUG_BARE);
  w.finish();
  if (!isWritten) {
    out.truncate(start);
    return FORMAT_SYNTAX_ERROR;
  }
  const r = finishAndPrint(f, out);
  if (r !== FORMAT_OK) out.truncate(start);
  return r;
}

/** Appends the formatted `text` to `out`. `path`: the name of the file. Returns a `FORMAT_*` code. */
export function format(path: string, text: Uint8Array, parser: number, options: FormatOptions, out: ByteBuf): number {
  state.cursor = -1;
  if (parser >= PARSER_NG_ACTION) return formatAngularExpression(text, parser, options, out);
  const original = text;
  const hasBom = startsWithBom(text, 0);
  if (!preparedText(text, options)) {
    out.appendAll(original);
    state.cursor = options.cursorOffset;
    return FORMAT_OK;
  }
  const body = prepared.text;
  const isRange = prepared.isRange;
  const bomStart = out.len;
  if (hasBom) out.appendAll(BOM_BYTES);
  // Prettier goes by what is white space in JavaScript, and makes nothing of a no-break space.
  let blank = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] | 0;
    if (!(c === 32 || c === 9 || c === 10 || c === 12 || c === 13)) {
      blank = false;
      break;
    }
  }
  if (blank) return FORMAT_OK;
  // Prettier's `isSourceElement`: nothing can be formatted on its own, except that in Vue everything can. It does not find what is in the root,
  // so that is all of the text.
  if (isRange && parser !== P_VUE) {
    if (!canBeParsed(body, parser)) {
      out.truncate(bomStart);
      return FORMAT_SYNTAX_ERROR;
    }
    const from = bomStart;
    writeWithLineEnding(body, 0, body.length, resolveLineEnding(options.lineEnding, original), out);
    // `options.cursor_offset` counts in `original`.
    state.cursor = options.cursorOffset >= 0 ? cursorInFormattedText(original, options, out.data.subarray(from, out.len)) : -1;
    return FORMAT_OK;
  }
  // (TODO(port): `with_sorted_scripts` for the plugins that sort imports in Vue, and `tailwind::with_sorted_classes`.)
  // In `text`, which has one byte for every line break and no byte order mark.
  let cursorOffset = -1;
  if (options.cursorOffset >= 0) {
    const at = cursorOffsetInBytes(original, options);
    if (at >= 0) {
      let crlf = 0;
      for (let i = 0; i + 1 < at && i + 1 < original.length; i++) {
        if ((original[i] | 0) === 13 && (original[i + 1] | 0) === 10) crlf = crlf + 1;
      }
      cursorOffset = at - crlf - (hasBom ? 3 : 0);
      if (cursorOffset < 0) cursorOffset = 0;
    }
  }
  const scriptFlavor = isVueFile(options, parser) ? options.flavor : FLAVOR_PRETTIER;
  const o = optionsOfHost(options, parser);
  o.lineEnding = resolveLineEnding(options.lineEnding, original);
  o.isInHtmlFile = path.endsWith(".html") || path.endsWith(".htm");
  o.filepath = options.filepath.length > 0 ? options.filepath : path;
  const f = startDocument(scratchFor(o), body, o, null);
  const status = writeDocument(f, body, parser, path.length > 0 ? path : null, o, false, 0, cursorOffset, scriptFlavor);
  if (status !== FORMAT_OK) {
    out.truncate(bomStart);
    return status;
  }
  const region = state.region;
  const printedFrom = out.len;
  const r = finishAndPrint(f, out);
  if (r !== FORMAT_OK) {
    out.truncate(bomStart);
    return r;
  }
  // `formatRange` leaves out the line break at the end.
  if (isRange) out.len = printedFrom + (trimJsWhitespaceEnd(out.data, printedFrom, out.len) - printedFrom);
  if (cursorOffset < 0 || region === null) return FORMAT_OK;
  // Without a node on one side, the part goes to that end of the document.
  const first = marksStart();
  const second = marksEnd();
  let m0 = first;
  let m1 = second;
  if (!region.isNode && region.beforeStart < 0 && region.afterStart >= 0) m0 = 0;
  else if (!region.isNode && region.beforeStart >= 0 && region.afterStart < 0) m1 = out.len - printedFrom;
  if (m0 < 0 || m1 < 0) {
    m0 = -1;
    m1 = -1;
  }
  state.cursor = cursorInRegion(body, cursorOffset, region, out.data, printedFrom, out.len, m0, m1) + (hasBom ? 1 : 0);
  return FORMAT_OK;
}

void FORMAT_INVALID_DOCUMENT;
void jsWhitespaceLen;
void utf16Len;
