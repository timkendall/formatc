// Port of vendor/bun/src/format/html/embed.rs: Prettier's `language-html/embed.js` and `embed/*.js`: what is in another language.
import { ByteBuf } from "../../base/bytebuf.ts";
import { utf16Len } from "../../base/utf8.ts";
import { FORMAT_OK } from "../errors.ts";
import { FormatOptions, FLAVOR_OXFMT, HTML_ROOT_JS_EXPRESSION, HTML_ROOT_NG_INTERPOLATION, HTML_ROOT_PROGRAM, HTML_ROOT_VUE_EXPRESSION, InHtml, LINE_ENDING_LF } from "../options.ts";
import { token } from "../ir/element.ts";
import { hasIndentedDelimiter } from "../front_matter.ts";
import { jsWhitespaceLen, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import { syntaxFromName } from "../css/syntax.ts";
import * as css from "../css/mod.ts";
import { writeDocument as writeCssDocument } from "../css/embed.ts";
import { docPop, docPool, docPush } from "../css/doc.ts";
import { formatJson, parserFromName as jsonParserFromName } from "../json/mod.ts";
import * as yaml from "../yaml/mod.ts";
import * as markdown from "../markdown/mod.ts";
import * as graphql from "../graphql/mod.ts";
import * as handlebars from "../handlebars/mod.ts";
import {
  AF_HAS_VAL,
  AF_NAME_E,
  AF_NAME_S,
  AF_NS_E,
  AF_NS_S,
  AF_VAL_E,
  AF_VAL_S,
  A_STRIDE,
  F_SPAN_E,
  F_SPAN_S,
  HAS_LEADING_SPACES,
  IS_SELF_CLOSING,
  K_ELEMENT,
  K_FRONT_MATTER,
  K_INTERPOLATION,
  K_TEXT,
  P_ANGULAR,
  P_HTML,
  P_LWC,
  P_MJML,
  P_VUE,
  attribute,
  attributeWithValue,
  has,
  kindOf,
  nGet,
  nameEnd,
  nameStart,
  nextOf,
  nodeIsFullName,
  parentOf,
  valEnd,
  valStart,
  attrIsFullName,
  attrValueIs,
  aGet,
  nsIsEmpty,
} from "./ast.ts";
import { eqLit, isEventAttribute } from "./data.ts";
import { Printer } from "./pstate.ts";
import { builtClosingTag, builtClosingTagSuffix, builtOpeningTagPrefix, formatsEmbedded, printOpeningTag, writeRawName } from "./printer.ts";
import { closingTagSuffix, closingTag, needsToBorrowPrevClosingTagEndMarker, nodeContent, NODE_CONTENT } from "./tag.ts";
import {
  UQ,
  dedentString,
  hasPrettierIgnore,
  htmlTrimPreserveIndentation,
  isAsciiWs,
  isScriptLikeTag,
  isVueNonHtmlBlock,
  shouldUnquoteAttributeValue,
  trimAsciiEnd,
  trimAsciiStart,
  TRIM,
  unescapeQuoteEntities,
} from "./utilities.ts";
import {
  BINDING_PARAMETERS,
  HUG_NEVER,
  SOURCE_MODULE,
  SOURCE_SCRIPT,
  SOURCE_UNKNOWN,
  SYN_BABEL,
  SYN_TS,
  SYN_TSX,
  SYN_TYPESCRIPT,
  optionsInHtml,
  writeProgram,
  writeProgramInAttribute,
  writeWithQuoteEntities,
} from "./js.ts";
import { collapseWhiteSpace } from "./parse.ts";
import { embedAngularAttribute } from "./angular.ts";
import { embedVueAttribute, isVueSfcWithTypescriptScript, hasTsxScript } from "./vue.ts";
import { writeEmbeddedDocument } from "./mod.ts";
import { inferParser } from "../markdown/mod.ts";
import { bytesToString } from "../../base/bytes.ts";

const TK_DASH_UNIT_W = token("w");
const TK_DASH_UNIT_H = token("h");
const TK_DASH_UNIT_X = token("x");
const TK_COMMA = token(",");
const TK_SPACE = token(" ");
const TK_SEMI = token(";");
const TK_EQ = token("=");

/** `inferParserByTypeAttribute` */
function inferParserByTypeAttribute(b: Uint8Array, s: number, e: number): string | null {
  if (
    eqLit(b, s, e, "module") ||
    eqLit(b, s, e, "text/javascript") ||
    eqLit(b, s, e, "text/babel") ||
    eqLit(b, s, e, "text/jsx") ||
    eqLit(b, s, e, "application/javascript")
  ) {
    return "babel";
  }
  if (eqLit(b, s, e, "application/x-typescript")) return "typescript";
  if (eqLit(b, s, e, "text/markdown")) return "markdown";
  if (eqLit(b, s, e, "text/html")) return "html";
  if (eqLit(b, s, e, "text/x-handlebars-template")) return "glimmer";
  const n = e - s;
  const endsWith = (suffix: string): boolean => n >= suffix.length && eqLit(b, e - suffix.length, e, suffix);
  if (endsWith("json") || endsWith("importmap") || eqLit(b, s, e, "speculationrules")) return "json";
  return null;
}

/** `/^\d+$/.test(text)` */
function isNonNegativeInteger(b: Uint8Array, s: number, e: number): boolean {
  if (s >= e) return false;
  for (let i = s; i < e; i++) {
    const c = b[i] | 0;
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** `/^-?(?:[0-9]+|[0-9]*\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)` */
function isFloatingPoint(b: Uint8Array, s: number, e: number): boolean {
  const digits = (at: number): number => {
    let n = 0;
    while (at + n < e && (b[at + n] | 0) >= 48 && (b[at + n] | 0) <= 57) n = n + 1;
    return n;
  };
  let at = s;
  if (at < e && (b[at] | 0) === 45) at = at + 1;
  const whole = digits(at);
  at = at + whole;
  if (at < e && (b[at] | 0) === 46) {
    const frac = digits(at + 1);
    if (frac === 0) return false;
    at = at + 1 + frac;
  } else if (whole === 0) {
    return false;
  }
  if (at < e && ((b[at] | 0) === 101 || (b[at] | 0) === 69)) {
    at = at + 1;
    if (at < e && ((b[at] | 0) === 43 || (b[at] | 0) === 45)) at = at + 1;
    const ex = digits(at);
    if (ex === 0) return false;
    at = at + ex;
  }
  return at === e;
}

/** A candidate of a `srcset`: the address, and the descriptor with its unit. */
class Candidates {
  urlS: number[] = [];
  urlE: number[] = [];
  /** NaN: none. */
  width: number[] = [];
  density: number[] = [];
  height: number[] = [];
}

function isSrcsetSpace(c: number): boolean {
  return c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
}

function hasNumber(v: number): boolean {
  return !Number.isNaN(v) && v !== 0;
}

function parseNumber(b: Uint8Array, s: number, e: number): number {
  return Number(bytesToString(b, s, e));
}

/** `@prettier/parse-srcset`. null: it throws. */
function parseSrcset(b: Uint8Array, s: number, e: number): Candidates | null {
  const candidates = new Candidates();
  let position = s;
  for (;;) {
    while (position < e && ((b[position] | 0) === 44 || isSrcsetSpace(b[position] | 0))) position = position + 1;
    if (position >= e) return candidates.urlS.length > 0 ? candidates : null;
    let len = 0;
    while (position + len < e && !isSrcsetSpace(b[position + len] | 0)) len = len + 1;
    const urlS = position;
    let urlE = position + len;
    position = position + len;
    const descS: number[] = [];
    const descE: number[] = [];
    if ((b[urlE - 1] | 0) === 44) {
      while (urlE > urlS && (b[urlE - 1] | 0) === 44) urlE = urlE - 1;
    } else {
      // The descriptor tokenizer. A descriptor is a part of the input.
      while (position < e && isSrcsetSpace(b[position] | 0)) position = position + 1;
      let start = position;
      let isInParens = false;
      for (;;) {
        const hasC = position < e;
        const c = hasC ? b[position] | 0 : -1;
        let isEnd = false;
        if (hasC && c === 41 && isInParens) isInParens = false;
        else if (hasC && isInParens) {
          // nothing
        } else if (hasC && c === 40) isInParens = true;
        else if (hasC && c !== 44 && !isSrcsetSpace(c)) {
          // nothing
        } else {
          isEnd = true;
        }
        if (isEnd) {
          if (position > start) {
            descS.push(start);
            descE.push(position);
          }
          if (!(hasC && isSrcsetSpace(c))) {
            position = position + (hasC ? 1 : 0);
            break;
          }
          while (position < e && isSrcsetSpace(b[position] | 0)) position = position + 1;
          start = position;
          continue;
        }
        position = position + 1;
      }
    }
    let width = NaN;
    let density = NaN;
    let height = NaN;
    for (let i = 0; i < descS.length; i++) {
      const ds = descS[i];
      const de = descE[i];
      if (de <= ds) return null;
      const unit = b[de - 1] | 0;
      const vs = ds;
      const ve = de - 1;
      const number = parseNumber(b, vs, ve);
      if (unit === 119 && isNonNegativeInteger(b, vs, ve)) {
        if (hasNumber(width) || hasNumber(density)) return null;
        if (Number.isNaN(number) || number === 0) return null;
        width = number;
      } else if (unit === 120 && isFloatingPoint(b, vs, ve)) {
        if (hasNumber(width) || hasNumber(density) || hasNumber(height)) return null;
        if (Number.isNaN(number) || number < 0) return null;
        density = number;
      } else if (unit === 104 && isNonNegativeInteger(b, vs, ve)) {
        if (hasNumber(height) || hasNumber(density)) return null;
        if (Number.isNaN(number) || number === 0) return null;
        height = number;
      } else {
        return null;
      }
    }
    // A density of 0 is as good as none.
    if (density === 0) density = NaN;
    candidates.urlS.push(urlS);
    candidates.urlE.push(urlE);
    candidates.width.push(width);
    candidates.density.push(density);
    candidates.height.push(height);
  }
}

// ───────────────────────────── `textToDoc` ─────────────────────────────

/** The options for a formatter whose text is written with `Writer::printed_text`. null: where the lines start is not known. */
function optionsForPrintedText(p: Printer): FormatOptions | null {
  const indentation = p.w.indentationWidth();
  if (indentation < 0) return null;
  const width = p.o.format.lineWidth - indentation;
  const o = optionsInHtml(p.o.format, new InHtml());
  o.lineWidth = width < 1 ? 1 : width;
  o.lineEnding = LINE_ENDING_LF;
  o.isInMarkdown = true;
  // For the blocks of code in Markdown.
  o.sortImports = p.o.format.sortImports;
  o.jsdoc = p.o.format.jsdoc;
  return o;
}

// What `write_printed_text` formats.
const FMT_CSS = 0;
const FMT_JSON = 1;
const FMT_YAML = 2;
const FMT_MARKDOWN = 3;
const FMT_GRAPHQL = 4;
const FMT_GLIMMER = 5;

/**
 * Writes what the formatter `fmt` appends to a buffer it is given, without the line breaks at its end. `parser`: the number of the
 * parser of CSS or JSON.
 */
function writePrintedText(p: Printer, isMarkdown: boolean, fmt: number, parser: number, b: Uint8Array, s: number, e: number, inHtmlRoot: boolean): boolean {
  const options = optionsForPrintedText(p);
  if (options === null) return false;
  if (inHtmlRoot) {
    const ih = new InHtml();
    ih.root = HTML_ROOT_PROGRAM;
    options.inHtml = ih;
  }
  const printed = new ByteBuf(e - s + 64);
  const code = b.subarray(s, e);
  let r: number;
  switch (fmt) {
    case FMT_CSS:
      r = css.format(code, parser, options, printed);
      if (r === FORMAT_OK && printed.len === 0) r = 1;
      break;
    case FMT_JSON:
      r = formatJson(code, code.length, parser, options, printed);
      break;
    case FMT_YAML:
      r = yaml.format(code, options, printed);
      break;
    case FMT_MARKDOWN:
      r = markdown.format(code, options, printed);
      break;
    case FMT_GRAPHQL:
      r = graphql.format(code, options, printed);
      break;
    default:
      r = handlebars.format(code, options, printed);
      break;
  }
  if (r !== FORMAT_OK) return false;
  // Where a line break that is part of a text leads is not the same for all that Markdown prints: to the first column in code, to where
  // the lines start in HTML. Which it is, the text does not say.
  if (isMarkdown && p.w.indentLevel !== 0) {
    const d = printed.data;
    for (let i = 0; i + 1 < printed.len; i++) {
      if ((d[i] | 0) === 13 && (d[i + 1] | 0) === 10) return false;
    }
  }
  let end = printed.len;
  while (end > 0 && ((printed.data[end - 1] | 0) === 10 || (printed.data[end - 1] | 0) === 13)) end = end - 1;
  p.w.printedText(printed.data, 0, end);
  return true;
}

/**
 * `textToDoc(code, { parser, __embeddedInHtml: true })`. Returns whether it has written something: if not, Prettier throws, or the document
 * is empty. `code` is `b[s, e)`.
 */
export function textToDoc(p: Printer, b: Uint8Array, s: number, e: number, parser: string, sourceType: number): boolean {
  const inHtml = new InHtml();
  inHtml.root = HTML_ROOT_PROGRAM;
  const cssParser = syntaxFromName(parser);
  if (cssParser >= 0 && p.w.indentLevel >= 0 && !p.o.hasParentParser) {
    // Nothing in a style sheet depends on what is around it but the width that is left, which is known in a file of HTML.
    return writePrintedText(p, false, FMT_CSS, cssParser, b, s, e, true);
  }
  if (cssParser >= 0) {
    const options = optionsInHtml(p.o.format, inHtml);
    docPush();
    const doc = css.document(b.subarray(s, e), cssParser, options);
    let ok = false;
    if (doc >= 0 && !docPool.isEmptyText(doc)) {
      const start = p.w.beginForeign();
      writeCssDocument(doc, p.w.f);
      p.w.endForeign(start);
      ok = true;
    }
    docPop();
    return ok;
  }
  const jsonParser = jsonParserFromName(parser);
  if (jsonParser >= 0) {
    // To these parsers, a text with nothing in it is a syntax error.
    return trimJsWhitespaceStart(b, s, e) < e && writePrintedText(p, false, FMT_JSON, jsonParser, b, s, e, false);
  }
  switch (parser) {
    case "html":
      return printEmbeddedHtml(p, b, s, e, P_HTML);
    case "angular":
      return printEmbeddedHtml(p, b, s, e, P_ANGULAR);
    case "vue":
      return printEmbeddedHtml(p, b, s, e, P_VUE);
    case "lwc":
      return printEmbeddedHtml(p, b, s, e, P_LWC);
    case "mjml":
      return printEmbeddedHtml(p, b, s, e, P_MJML);
    case "babel":
      return writeProgram(p, b, s, e, SYN_BABEL, sourceType, inHtml, p.o.scriptFlavor);
    // oxfmt parses one way, which the file says.
    case "typescript":
      if (p.o.scriptFlavor === FLAVOR_OXFMT) {
        return writeProgram(p, b, s, e, hasTsxScript(p) ? SYN_TSX : SYN_TS, sourceType, inHtml, p.o.scriptFlavor);
      }
      return writeProgram(p, b, s, e, SYN_TYPESCRIPT, sourceType, inHtml, p.o.scriptFlavor);
    case "yaml":
      return writePrintedText(p, false, FMT_YAML, 0, b, s, e, false);
    case "markdown":
      return writePrintedText(p, true, FMT_MARKDOWN, 0, b, s, e, false);
    case "graphql":
      return writePrintedText(p, false, FMT_GRAPHQL, 0, b, s, e, false);
    case "glimmer":
      return writePrintedText(p, false, FMT_GLIMMER, 0, b, s, e, false);
    default:
      return false;
  }
}

/** HTML in HTML. */
function printEmbeddedHtml(p: Printer, b: Uint8Array, s: number, e: number, parser: number): boolean {
  if (trimJsWhitespaceStart(b, s, e) >= e) return false;
  p.w.startAttempt();
  const indentLevel = p.w.indentLevel;
  const start = p.w.beginForeign();
  const isWritten = writeEmbeddedDocument(p.w.f, b.subarray(s, e), parser, p.o, indentLevel);
  p.w.endForeign(start);
  return p.w.endAttempt(isWritten);
}

// ───────────────────────────── `embed` ─────────────────────────────

/** `inferElementParser` */
function inferElementParser(p: Printer, id: number): string | null {
  const t = p.t;
  const b = t.pool.data;
  const byAttributes = (): string | null => {
    const lang = attributeWithValue(t, id, "lang");
    if (lang >= 0) {
      const l = inferParser(bytesToString(b, aGet(t, lang, AF_VAL_S), aGet(t, lang, AF_VAL_E)));
      if (l !== null) return l;
    }
    const type = attributeWithValue(t, id, "type");
    if (type >= 0) return inferParserByTypeAttribute(b, aGet(t, type, AF_VAL_S), aGet(t, type, AF_VAL_E));
    return null;
  };
  const ns = nameStart(t, id);
  const ne = nameEnd(t, id);
  // `inferScriptParser`
  if (eqLit(b, ns, ne, "script") && attribute(t, id, "src") < 0) {
    if (attributeWithValue(t, id, "lang") < 0 && attributeWithValue(t, id, "type") < 0) return "babel";
    const r = byAttributes();
    if (r !== null) return r;
  }
  // `inferStyleParser`
  if (eqLit(b, ns, ne, "style")) {
    const lang = attributeWithValue(t, id, "lang");
    if (lang < 0) return "css";
    const l = inferParser(bytesToString(b, aGet(t, lang, AF_VAL_S), aGet(t, lang, AF_VAL_E)));
    if (l !== null) return l;
  }
  if (eqLit(b, ns, ne, "mj-style") && p.o.parser === P_MJML) return "css";
  // `inferVueSfcBlockParser`
  if (!isVueNonHtmlBlock(t, id, p.o) || attribute(t, id, "src") >= 0) return null;
  return byAttributes();
}

/** Prettier's `embed`. Returns whether it has written the node. */
export function embed(p: Printer, id: number): boolean {
  const kind = kindOf(p.t, id);
  if (kind === K_FRONT_MATTER) return embedFrontMatter(p, id);
  if (kind === K_ELEMENT) return embedElement(p, id);
  if (kind === K_TEXT) return embedText(p, id);
  return false;
}

/** `printEmbedFrontMatter` */
function embedFrontMatter(p: Printer, id: number): boolean {
  const t = p.t;
  const text = p.o.originalText;
  const rs = nGet(t, id, F_SPAN_S);
  const re = nGet(t, id, F_SPAN_E);
  let firstLineEnd = -1;
  let lastLineStart = -1;
  for (let i = rs; i < re; i++) {
    if ((text[i] | 0) === 10) {
      if (firstLineEnd < 0) firstLineEnd = i;
      lastLineStart = i + 1;
    }
  }
  if (firstLineEnd < 0) return false;
  const langS = trimJsWhitespaceStart(text, rs + 3, firstLineEnd);
  const langE = trimJsWhitespaceEnd(text, langS, firstLineEnd);
  const isToml = eqLit(text, langS, langE, "toml") || (langS === langE && (text[rs] | 0) === 43);
  const isYaml = eqLit(text, langS, langE, "yaml") || (langS === langE && !isToml);
  const vs = trimJsWhitespaceStart(text, firstLineEnd, lastLineStart);
  const ve = trimJsWhitespaceEnd(text, vs, lastLineStart);
  // There is no formatter for TOML.
  if (!(isYaml || (isToml && vs === ve)) || hasIndentedDelimiter(text, rs, re)) return false;
  const w = p.w;
  w.startAttempt();
  w.text(text, rs, rs + 3);
  w.text(text, langS, langE);
  w.hardline();
  let isWritten = true;
  if (vs < ve) {
    isWritten = textToDoc(p, text, vs, ve, "yaml", SOURCE_UNKNOWN);
    w.hardline();
  }
  w.text(text, lastLineStart, re);
  return w.endAttempt(isWritten);
}

/** A block of a Vue file that is not HTML. */
function embedElement(p: Printer, id: number): boolean {
  const t = p.t;
  const w = p.w;
  if (isScriptLikeTag(t, id, p.o) || has(t, id, IS_SELF_CLOSING) || !isVueNonHtmlBlock(t, id, p.o)) return false;
  const parser = inferElementParser(p, id);
  if (parser === null) return false;
  nodeContent(t, p.o, id);
  const cs = NODE_CONTENT[0] | 0;
  const ce = NODE_CONTENT[1] | 0;
  const text = p.o.originalText;
  w.startAttempt();
  builtOpeningTagPrefix(p, id);
  w.startGroup();
  printOpeningTag(p, id);
  w.endGroup();
  let isWritten = true;
  if (trimJsWhitespaceStart(text, cs, ce) < ce) {
    w.hardline();
    htmlTrimPreserveIndentation(text, cs, ce);
    isWritten = textToDoc(p, text, TRIM[0] | 0, TRIM[1] | 0, parser, SOURCE_UNKNOWN);
    w.hardline();
  }
  const out = w.beginBuilt();
  const at = out.len;
  closingTag(t, p.o, id, out);
  closingTagSuffix(t, p.o, id, out);
  w.endBuilt(at);
  return w.endAttempt(isWritten);
}

function embedText(p: Printer, id: number): boolean {
  const t = p.t;
  const w = p.w;
  const parent = parentOf(t, id);
  if (parent < 0) return false;
  const b = t.pool.data;
  const vs = valStart(t, id);
  const ve = valEnd(t, id);
  if (isScriptLikeTag(t, parent, p.o)) {
    const parser = inferElementParser(p, parent);
    if (parser === null) return false;
    let buf = b;
    let s = vs;
    let e = ve;
    if (parser === "markdown") {
      // `.replace(/^[^\S\n]*\n/, "")`
      const blank = trimJsWhitespaceStart(b, vs, ve) - vs;
      let firstLineEnd = 0;
      for (let i = 0; i < blank; i++) {
        if ((b[vs + i] | 0) === 10) {
          firstLineEnd = i + 1;
          break;
        }
      }
      const ded = new ByteBuf(ve - vs);
      if (dedentString(b, vs + firstLineEnd, ve, ded)) {
        buf = ded.data;
        s = 0;
        e = ded.len;
      } else {
        s = vs + firstLineEnd;
      }
    }
    let sourceType = SOURCE_UNKNOWN;
    if (p.o.parser === P_HTML && parser === "babel") {
      const ta = attribute(t, parent, "type");
      let isModule = false;
      if (ta >= 0 && aGet(t, ta, AF_HAS_VAL) !== 0) {
        isModule = attrValueIs(t, ta, "module");
        if (!isModule && (attrValueIs(t, ta, "text/babel") || attrValueIs(t, ta, "text/jsx"))) {
          const da = attribute(t, parent, "data-type");
          isModule = da >= 0 && attrValueIs(t, da, "module");
        }
      }
      sourceType = isModule ? SOURCE_MODULE : SOURCE_SCRIPT;
    }
    w.startAttempt();
    w.breakParent();
    builtOpeningTagPrefix(p, id);
    const isWritten = textToDoc(p, buf, s, e, parser, sourceType);
    builtClosingTagSuffix(p, id);
    return w.endAttempt(isWritten);
  }
  if (kindOf(t, parent) !== K_INTERPOLATION) return false;
  const inHtml = new InHtml();
  inHtml.root = p.o.parser === P_ANGULAR ? HTML_ROOT_NG_INTERPOLATION : p.o.parser === P_VUE ? HTML_ROOT_VUE_EXPRESSION : HTML_ROOT_JS_EXPRESSION;
  inHtml.isInInterpolation = true;
  w.startAttempt();
  w.startIndent();
  w.line();
  let isWritten: boolean;
  if (p.o.parser === P_ANGULAR) {
    isWritten = writeAngularExpressionOf(p, b, vs, ve, inHtml);
  } else {
    const isTypescript = p.o.parser === P_VUE && isVueSfcWithTypescriptScript(p);
    isWritten = writeExpressionOf(p, b, vs, ve, isTypescript, inHtml);
  }
  w.endIndent();
  const next = nextOf(t, parent);
  if (next >= 0 && needsToBorrowPrevClosingTagEndMarker(t, next)) w.token(TK_SPACE);
  else w.line();
  return w.endAttempt(isWritten);
}

import { HUG_BARE, writeExpression } from "./js.ts";
import { writeAngularExpression as writeAngularExpressionBare } from "./angular.ts";

function writeExpressionOf(p: Printer, b: Uint8Array, s: number, e: number, isTypescript: boolean, inHtml: InHtml): boolean {
  return writeExpression(p, b, s, e, isTypescript, inHtml, HUG_BARE);
}
function writeAngularExpressionOf(p: Printer, b: Uint8Array, s: number, e: number, inHtml: InHtml): boolean {
  return writeAngularExpressionBare(p, b, s, e, inHtml, HUG_BARE);
}

// ───────────────────────────── `embed/attribute.js` ─────────────────────────────

/** `createAttributePrinter`, the start: what follows writes the value, then `endAttributeValue`. */
export function beginAttributeValue(p: Printer): void {
  p.w.startAttemptBehindText();
}

/** The end: `isWritten` says that the value was written. Returns whether the attribute is written. */
export function endAttributeValue(p: Printer, a: number, isWritten: boolean): boolean {
  const content = p.w.endAttemptAsContent(isWritten);
  if (content < 0) return false;
  writeRawName(p, a);
  p.w.token(TK_EQ_QUOTE);
  p.w.startGroup();
  const start = p.w.beginForeign();
  writeWithQuoteEntities(p.w.f, content);
  p.w.endForeign(start);
  p.w.endGroup();
  p.w.token(TK_QUOTE);
  return true;
}

const TK_EQ_QUOTE = token('="');
const TK_QUOTE = token('"');

/** `printExpand(doc, canHaveTrailingWhitespace)`, the start. */
export function beginExpand(p: Printer): void {
  p.w.startIndent();
  p.w.softline();
}
export function endExpand(p: Printer, canHaveTrailingWhitespace: boolean): void {
  p.w.endIndent();
  if (canHaveTrailingWhitespace) p.w.softline();
}

/** `printAttribute`. Returns whether it has written the attribute. */
export function embedAttribute(p: Printer, element: number, a: number): boolean {
  const t = p.t;
  const w = p.w;
  const ab = a * A_STRIDE;
  if ((t.a[ab + AF_HAS_VAL] | 0) === 0 || (t.a[ab + AF_VAL_S] | 0) === (t.a[ab + AF_VAL_E] | 0)) return false;
  const b = t.pool.data;
  const rawS = t.a[ab + AF_VAL_S] | 0;
  const rawE = t.a[ab + AF_VAL_E] | 0;
  if (shouldUnquoteAttributeValue(t, a, p.o)) {
    writeRawName(p, a);
    w.token(TK_EQ);
    w.text(b, rawS, rawE);
    return true;
  }
  let hasBraces = false;
  for (let i = rawS; i + 1 < rawE; i++) {
    if ((b[i] | 0) === 123 && (b[i + 1] | 0) === 123) {
      hasBraces = true;
      break;
    }
  }
  const isPlain = !p.o.hasParentParser && !hasBraces;
  unescapeQuoteEntities(b, rawS, rawE);
  const vb = UQ.buf;
  const vs = UQ.s;
  const ve = UQ.e;
  if ((t.a[ab + AF_NS_S] | 0) === (t.a[ab + AF_NS_E] | 0)) {
    const ns = t.a[ab + AF_NAME_S] | 0;
    const ne = t.a[ab + AF_NAME_E] | 0;
    if (eqLit(b, ns, ne, "srcset") && (nodeIsFullName(t, element, "img") || nodeIsFullName(t, element, "source"))) {
      beginAttributeValue(p);
      return endAttributeValue(p, a, printSrcset(p, vb, vs, ve));
    }
    if (eqLit(b, ns, ne, "style") && isPlain) {
      beginAttributeValue(p);
      return endAttributeValue(p, a, printStyle(p, vb, vs, ve));
    }
    if (isPlain && isEventAttribute(b, ns, ne)) {
      if (p.o.scriptFlavor === FLAVOR_OXFMT) {
        // In a Vue file oxfmt takes over the parser `babel`, whatever it is called for: a script like another, and Prettier, which is not
        // told what is in it, hugs it.
        beginAttributeValue(p);
        return endAttributeValue(p, a, textToDoc(p, vb, vs, ve, "babel", SOURCE_UNKNOWN));
      }
      const inHtml = new InHtml();
      inHtml.root = HTML_ROOT_PROGRAM;
      inHtml.isInAttribute = true;
      inHtml.isInlineEventHandler = true;
      beginAttributeValue(p);
      return endAttributeValue(p, a, writeProgramInAttribute(p, vb, vs, ve, SYN_BABEL, inHtml, HUG_NEVER));
    }
    if (eqLit(b, ns, ne, "class") && isPlain) {
      beginAttributeValue(p);
      const collapsed = new ByteBuf(ve - vs);
      collapseWhiteSpace(vb, vs, ve, collapsed);
      w.text(collapsed.data, 0, collapsed.len);
      return endAttributeValue(p, a, true);
    }
    if (eqLit(b, ns, ne, "allow") && isPlain && nodeIsFullName(t, element, "iframe")) {
      beginAttributeValue(p);
      return endAttributeValue(p, a, printPermissionsPolicy(p, vb, vs, ve));
    }
  }
  if (p.o.parser === P_VUE) return embedVueAttribute(p, element, a, vb, vs, ve);
  if (p.o.parser === P_ANGULAR) return embedAngularAttribute(p, element, a, b, rawS, rawE, vb, vs, ve);
  return false;
}

/** `printSrcset` */
function printSrcset(p: Printer, vb: Uint8Array, vs: number, ve: number): boolean {
  const w = p.w;
  const c = parseSrcset(vb, vs, ve);
  if (c === null) return false;
  const n = c.urlS.length;
  let hasWidth = false;
  let hasHeight = false;
  let hasDensity = false;
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(c.width[i])) hasWidth = true;
    if (!Number.isNaN(c.height[i])) hasHeight = true;
    if (!Number.isNaN(c.density[i])) hasDensity = true;
  }
  const used = (hasWidth ? 1 : 0) + (hasHeight ? 1 : 0) + (hasDensity ? 1 : 0);
  // `let (kind, None) = (used.next(), used.next()) else return false`
  if (used > 1) return false;
  let values: number[] = c.width;
  let unit = TK_DASH_UNIT_W;
  if (hasWidth) {
    values = c.width;
    unit = TK_DASH_UNIT_W;
  } else if (hasHeight) {
    values = c.height;
    unit = TK_DASH_UNIT_H;
  } else if (hasDensity) {
    values = c.density;
    unit = TK_DASH_UNIT_X;
  }
  const hasKind = used === 1;
  const descriptors: string[] = [];
  for (let i = 0; i < n; i++) {
    if (hasKind && !Number.isNaN(values[i])) {
      const v = values[i];
      if (!(v === 0 || (v >= 1e-6 && v < 1e21))) return false;
      descriptors.push(String(v));
    } else {
      descriptors.push("");
    }
  }
  const leftLen = (d: string): number => {
    const at = d.indexOf(".");
    return at < 0 ? d.length : at;
  };
  let maxUrlLen = 0;
  let maxDescriptorLeftLen = 0;
  for (let i = 0; i < n; i++) {
    const l = utf16Len(vb, c.urlS[i], c.urlE[i]);
    if (l > maxUrlLen) maxUrlLen = l;
    const d = leftLen(descriptors[i]);
    if (d > maxDescriptorLeftLen) maxDescriptorLeftLen = d;
  }
  beginExpand(p);
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      w.token(TK_COMMA);
      w.line();
    }
    w.text(vb, c.urlS[i], c.urlE[i]);
    const d = descriptors[i];
    if (d.length === 0) continue;
    const alignment = maxUrlLen - utf16Len(vb, c.urlS[i], c.urlE[i]) + 1 + maxDescriptorLeftLen - leftLen(d);
    w.startIf(true, 0);
    w.textLit(" ".repeat(alignment));
    w.endIf();
    w.startIf(false, 0);
    w.token(TK_SPACE);
    w.endIf();
    w.textLit(d);
    w.token(hasKind ? unit : TK_SPACE);
  }
  endExpand(p, true);
  return true;
}

/** `printStyle` */
function printStyle(p: Printer, vb: Uint8Array, vs: number, ve: number): boolean {
  const inHtml = new InHtml();
  inHtml.root = HTML_ROOT_PROGRAM;
  inHtml.isStyleAttribute = true;
  const options = optionsInHtml(p.o.format, inHtml);
  docPush();
  const doc = css.document(vb.subarray(vs, ve), css.PARSER_CSS, options);
  if (doc < 0) {
    docPop();
    return false;
  }
  beginExpand(p);
  const start = p.w.beginForeign();
  writeCssDocument(doc, p.w.f);
  p.w.endForeign(start);
  endExpand(p, true);
  docPop();
  return true;
}

/** `printPermissionsPolicy` */
function printPermissionsPolicy(p: Printer, vb: Uint8Array, vs: number, ve: number): boolean {
  const w = p.w;
  // The directives: split at `;`, trimmed, not empty.
  const ds: number[] = [];
  const de: number[] = [];
  let ls = vs;
  for (;;) {
    let le = ls;
    while (le < ve && (vb[le] | 0) !== 59) le = le + 1;
    const s = trimAsciiStart(vb, ls, le);
    const e = trimAsciiEnd(vb, s, le);
    if (s < e) {
      ds.push(s);
      de.push(e);
    }
    if (le >= ve) break;
    ls = le + 1;
  }
  const count = ds.length;
  if (count === 0) {
    // An attribute with nothing between its quotes.
    w.startGroup();
    w.endGroup();
    return true;
  }
  beginExpand(p);
  for (let index = 0; index < count; index++) {
    let pos = ds[index];
    const end = de[index];
    for (let wi = 0; ; wi++) {
      let we = pos;
      while (we < end && !isAsciiWs(vb[we] | 0)) we = we + 1;
      if (wi > 0) w.token(TK_SPACE);
      w.text(vb, pos, we);
      if (we >= end) break;
      pos = we;
      while (pos < end && isAsciiWs(vb[pos] | 0)) pos = pos + 1;
    }
    if (index + 1 === count) {
      w.tokenIfBreak(TK_SEMI);
    } else {
      w.token(TK_SEMI);
      w.line();
    }
  }
  endExpand(p, true);
  return true;
}

void K_ELEMENT;
void HAS_LEADING_SPACES;
void hasPrettierIgnore;
void F_SPAN_E;
void builtClosingTag;
void formatsEmbedded;
void jsWhitespaceLen;
void nsIsEmpty;
void attrIsFullName;
void AF_NS_S;
void AF_NS_E;
