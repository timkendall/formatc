// Port of vendor/bun/src/format/markdown/mod.rs: Markdown and MDX.
//
// The specification is Prettier's `src/language-markdown`, which parses with micromark. The parser is Bun's own, `bun_md`.
//
//   text ─ bun_md ─→ events ─ parse ─→ Tree (mdast) ─ preprocess ─→ sentences ─ printer ─→ the document of `css/doc`
//
//   format(text, options, out): FORMAT_* code            Markdown
//   formatMdx(text, options, out): FORMAT_* code         MDX
//
// Code blocks go to the other formatters (`embeddedFormat` below): JSON, GraphQL, YAML, Handlebars and Markdown are called; style
// sheets and HTML have a HOOK each (`hookCss`, `hookHtml`: `return false` = the block stays as it is written, which is what Bun
// does when the formatter is absent or fails). For JavaScript and TypeScript the caller sets `options.formatJavascript`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { bytesToString } from "../../base/bytes.ts";
import { byteOffsetOfUtf16, utf16Len } from "../../base/utf8.ts";
import { FORMAT_NESTED_TOO_DEEPLY, FORMAT_OK } from "../errors.ts";
import {
  EMBEDDED_AUTO,
  FLAVOR_OXFMT,
  FLAVOR_PRETTIER,
  FormatOptions,
  LINE_ENDING_AUTO,
  LINE_ENDING_CR,
  LINE_ENDING_CRLF,
  LINE_ENDING_LF,
  PROSE_WRAP_ALWAYS,
  resolveLineEnding,
} from "../options.ts";
import { parseFrontMatter } from "../front_matter.ts";
import { startsWithBom, trimJsWhitespaceStart } from "../text.ts";
import { docPop, docPush } from "../css/doc.ts";
import { Tree } from "./ast.ts";
import { blankFrontMatter, parse, SY_MARKDOWN, SY_MDX, SY_WITH_DIRECTIVES } from "./parse.ts";
import { Preprocessor } from "./preprocess.ts";
import { EmbedHook, MDX_ES_SYNTAX, MDX_JSX, Printer, printDocument } from "./printer.ts";
import { embeddedFormat } from "./embedded.ts";
import { startsWithStr } from "./strings.ts";

/** Whether Prettier takes the file at `path` for Markdown. */
export function isMarkdownPath(path: string): boolean {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = (slash >= 0 ? path.substring(slash + 1) : path).toLowerCase();
  if (name === "contents.lr" || name === "readme") return true;
  return (
    name.endsWith(".md") ||
    name.endsWith(".livemd") ||
    name.endsWith(".markdown") ||
    name.endsWith(".mdown") ||
    name.endsWith(".mdwn") ||
    name.endsWith(".mkd") ||
    name.endsWith(".mkdn") ||
    name.endsWith(".mkdown") ||
    name.endsWith(".ronn") ||
    name.endsWith(".scd") ||
    name.endsWith(".workbook")
  );
}

export function isMdxPath(path: string): boolean {
  return path.length >= 4 && path.substring(path.length - 4).toLowerCase() === ".mdx";
}

/** Prettier's `inferParser(options, { language })`: the parser for code in `language`. null: none. */
export function inferParser(language: string): string | null {
  switch (language) {
    // The names of languages, then other names for them, then extensions of files.
    case "json.stringify":
    case "geojson":
    case "jsonl":
    case "sarif":
    case "topojson":
    case "importmap":
      return "json-stringify";
    case "json":
    case "4DForm":
    case "4DProject":
    case "avsc":
    case "gltf":
    case "har":
    case "ice":
    case "JSON-tmLanguage":
    case "json.example":
    case "mcmeta":
    case "slnlaunch":
    case "tact":
    case "tfstate":
    case "tfstate.backup":
    case "webapp":
    case "webmanifest":
    case "yy":
    case "yyp":
      return "json";
    case "jsonc":
    case "code-snippets":
    case "code-workspace":
    case "sublime-build":
    case "sublime-color-scheme":
    case "sublime-commands":
    case "sublime-completions":
    case "sublime-keymap":
    case "sublime-macro":
    case "sublime-menu":
    case "sublime-mousemap":
    case "sublime-project":
    case "sublime-settings":
    case "sublime-theme":
    case "sublime-workspace":
    case "sublime_metrics":
    case "sublime_session":
      return "jsonc";
    case "json5":
      return "json5";
    case "javascript":
    case "jsx":
    case "js":
    case "node":
    case "_js":
    case "bones":
    case "cjs":
    case "es":
    case "es6":
    case "gs":
    case "jake":
    case "jsb":
    case "jscad":
    case "jsfl":
    case "jslib":
    case "jsm":
    case "jspre":
    case "jss":
    case "mjs":
    case "njs":
    case "pac":
    case "sjs":
    case "ssjs":
    case "xsjs":
    case "xsjslib":
    case "start.frag":
    case "end.frag":
    case "wxs":
      return "babel";
    case "typescript":
    case "tsx":
    case "ts":
    case "typescriptreact":
    case "cts":
    case "mts":
    case "angular-ts":
      return "typescript";
    case "graphql":
    case "gql":
    case "graphqls":
      return "graphql";
    case "handlebars":
    case "hbs":
    case "htmlbars":
      return "glimmer";
    case "mdx":
      return "mdx";
    case "html":
    case "hta":
    case "htm":
    case "html.hl":
    case "inc":
    case "xht":
      return "html";
    // `xhtml` is another name for two languages, of which this is the first.
    case "angular":
    case "xhtml":
    case "component.html":
      return "angular";
    case "vue":
      return "vue";
    case "lightning web components":
    case "LWC":
    case "lwc":
      return "lwc";
    case "mjml":
    case "MJML":
      return "mjml";
    case "markdown":
    case "md":
    case "pandoc":
    case "livemd":
    case "mdown":
    case "mdwn":
    case "mkd":
    case "mkdn":
    case "mkdown":
    case "ronn":
    case "scd":
    case "workbook":
      return "markdown";
    case "css":
    case "postcss":
    case "wxss":
    case "pcss":
      return "css";
    case "less":
    case "less-css":
      return "less";
    case "scss":
      return "scss";
    case "yaml":
    case "yml":
    case "mir":
    case "reek":
    case "rviz":
    case "sublime-syntax":
    case "syntax":
    case "yaml-tmlanguage":
    case "yaml.sed":
    case "yml.mysql":
      return "yaml";
    default:
      return null;
  }
}

// What `parserOfOxfmt` returns: the parser and the name of a file that says what a script is ("" for none).
let oxfmtFile = "";

/** oxfmt's `route`: the parser for a block of code in `language`, and for JavaScript and TypeScript the name of a file that says what
 * it is (`oxfmtFile`). The names are those of Shiki. What has none of them stays as it is written. null: none. */
export function parserOfOxfmt(language: string): string | null {
  oxfmtFile = "";
  switch (language) {
    case "graphql":
    case "gql":
      return "graphql";
    case "css":
    case "postcss":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "yaml":
    case "yml":
      return "yaml";
    case "json":
      return "json";
    case "jsonc":
      return "jsonc";
    case "json5":
      return "json5";
    case "html":
      return "html";
    case "angular":
    case "angular-html":
      return "angular";
    case "vue":
      return "vue";
    case "handlebars":
    case "hbs":
      return "glimmer";
    case "mdx":
      return "mdx";
    case "markdown":
    case "md":
      return "markdown";
    case "javascript":
    case "js":
      oxfmtFile = "dummy.js";
      return "babel";
    case "jsx":
      oxfmtFile = "dummy.jsx";
      return "babel";
    case "mjs":
      oxfmtFile = "dummy.mjs";
      return "babel";
    case "cjs":
      oxfmtFile = "dummy.cjs";
      return "babel";
    case "typescript":
    case "angular-ts":
    case "ts":
      oxfmtFile = "dummy.ts";
      return "typescript";
    case "tsx":
      oxfmtFile = "dummy.tsx";
      return "typescript";
    case "mts":
      oxfmtFile = "dummy.mts";
      return "typescript";
    case "cts":
      oxfmtFile = "dummy.cts";
      return "typescript";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------- pragma

// Where `strip_pragma` ends for the text at `at`: the length after `@`, or -1.
function stripPragma(text: Uint8Array, at: number, end: number, p1: string, p2: string): number {
  if (at >= end || (text[at] | 0) !== 64) return -1;
  if (startsWithStr(text, at + 1, end, p1)) return p1.length + 1;
  if (startsWithStr(text, at + 1, end, p2)) return p2.length + 1;
  return -1;
}

/** Whether a comment with `@` and one of `pragmas` is at the start of `text`, behind the front matter. */
function hasPragma(text: Uint8Array, p1: string, p2: string): boolean {
  const n = text.length;
  const fm = parseFrontMatter(text);
  const content = trimJsWhitespaceStart(text, fm === null ? 0 : fm.end, n);
  // `<!-- @format -->`, `{/* @format */}`
  if (isBetween(text, content, n, "<!--", "", "-->", "", p1, p2)) return true;
  if (isBetween(text, content, n, "{", "/*", "*/", "}", p1, p2)) return true;
  // A comment with a line that is nothing but the pragma, which ends on a later line.
  if (!startsWithStr(text, content, n, "<!--")) return false;
  // lines after the first
  let at = content;
  while (at < n && (text[at] | 0) !== 10) at = at + 1;
  if (at >= n) return false;
  let from = at + 1;
  let found = false;
  while (true) {
    let le = from;
    while (le < n && (text[le] | 0) !== 10) le = le + 1;
    if (!found) {
      const t = trimJsWhitespaceStart(text, from, le);
      const len = stripPragma(text, t, le, p1, p2);
      if (len >= 0) {
        let blank = true;
        for (let i = t + len; i < le; i++) {
          const b = text[i] | 0;
          if (!(b === 32 || b === 9 || b === 10 || b === 12 || b === 13)) {
            blank = false;
            break;
          }
        }
        if (blank) found = true;
      }
    } else {
      for (let i = from; i + 3 <= le; i++) {
        if ((text[i] | 0) === 45 && (text[i + 1] | 0) === 45 && (text[i + 2] | 0) === 62) return true;
      }
    }
    if (le >= n) break;
    from = le + 1;
  }
  return false;
}

function isBetween(text: Uint8Array, content: number, n: number, open1: string, open2: string, close1: string, close2: string, p1: string, p2: string): boolean {
  let rest = content;
  if (!startsWithStr(text, rest, n, open1)) return false;
  rest = trimJsWhitespaceStart(text, rest + open1.length, n);
  if (open2.length > 0) {
    if (!startsWithStr(text, rest, n, open2)) return false;
    rest = trimJsWhitespaceStart(text, rest + open2.length, n);
  }
  const len = stripPragma(text, rest, n, p1, p2);
  if (len < 0) return false;
  rest = rest + len;
  const t1 = trimJsWhitespaceStart(text, rest, n);
  if (!startsWithStr(text, t1, n, close1)) return false;
  rest = t1 + close1.length;
  if (close2.length > 0) {
    const t2 = trimJsWhitespaceStart(text, rest, n);
    if (!startsWithStr(text, t2, n, close2)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------- code blocks

// What the printer asks for code blocks and front matter.
class MdEmbed extends EmbedHook {
  options: FormatOptions;
  isInTemplate: boolean;
  formatsEmbedded: boolean;
  depth: number;

  constructor(options: FormatOptions, isInTemplate: boolean, depth: number) {
    super();
    this.options = options;
    this.isInTemplate = isInTemplate;
    this.formatsEmbedded = options.embeddedLanguageFormatting === EMBEDDED_AUTO;
    this.depth = depth;
  }

  format(lbuf: Uint8Array, ls: number, le: number, cbuf: Uint8Array, cs: number, ce: number, width: number, out: ByteBuf): boolean {
    if (!this.formatsEmbedded) return false;
    return formatEmbedded(lbuf, ls, le, cbuf, cs, ce, width, this.options, this.isInTemplate, this.depth, out);
  }

  knowsOxfmtLanguage(lbuf: Uint8Array, ls: number, le: number): boolean {
    return parserOfOxfmt(bytesToString(lbuf, ls, le)) !== null;
  }
}

function isEqBytes(a: Uint8Array, as: number, ae: number, b: Uint8Array): boolean {
  if (ae - as !== b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if ((a[as + i] | 0) !== (b[i] | 0)) return false;
  }
  return true;
}

/** Formats `code`, which is in a block of code in `language`, for lines of `width` columns. Appends to `out`; false: it cannot be. */
function formatEmbedded(
  lbuf: Uint8Array,
  ls: number,
  le: number,
  cbuf: Uint8Array,
  cs0: number,
  ce0: number,
  width: number,
  options0: FormatOptions,
  isInTemplate: boolean,
  depth: number,
  out: ByteBuf,
): boolean {
  // Nothing to format: front matter without anything in it.
  if (ls === le) return true;
  const isMdxJsx = isEqBytes(lbuf, ls, le, MDX_JSX);
  const isMdxEs = isEqBytes(lbuf, ls, le, MDX_ES_SYNTAX);
  const language = isMdxJsx || isMdxEs ? "" : bytesToString(lbuf, ls, le);
  let fileOfOxfmt = "";
  let parser: string;
  if (isMdxJsx || isMdxEs) parser = "babel";
  else if (options0.flavor === FLAVOR_OXFMT) {
    const p = parserOfOxfmt(language);
    if (p === null) return false;
    parser = p;
    fileOfOxfmt = oxfmtFile;
  } else if (language === "angular-html") parser = "angular";
  else {
    const p = inferParser(language);
    if (p === null) return false;
    parser = p;
  }
  let code = cbuf;
  let cs = cs0;
  let ce = ce0;
  if (isMdxJsx) {
    const wrapped = new Uint8Array(ce - cs + 7);
    wrapped[0] = 60;
    wrapped[1] = 36;
    wrapped[2] = 62;
    wrapped.set(cbuf.subarray(cs, ce), 3);
    wrapped[wrapped.length - 4] = 60;
    wrapped[wrapped.length - 3] = 47;
    wrapped[wrapped.length - 2] = 36;
    wrapped[wrapped.length - 1] = 62;
    code = wrapped;
    cs = 0;
    ce = wrapped.length;
  }
  // To the parsers of Prettier it is white space.
  if (startsWithBom(code, cs) && cs + 3 <= ce) cs = cs + 3;
  // To these parsers, nothing is a syntax error. Only a whole file with nothing in it does not get to them.
  if ((parser === "json" || parser === "json5" || parser === "json-stringify" || parser === "graphql") && trimJsWhitespaceStart(code, cs, ce) >= ce) {
    return false;
  }
  const options = options0.copy();
  options.lineWidth = width < 1 ? 1 : width > 4294967295 ? 4294967295 : width;
  options.lineEnding = LINE_ENDING_LF;
  options.parser = "";
  options.filepath = "";
  options.rangeStart = -1;
  options.rangeEnd = -1;
  options.cursorOffset = -1;
  options.insertPragma = false;
  options.requirePragma = false;
  options.checkIgnorePragma = false;
  options.isInMarkdown = true;
  options.isMdxJsx = isMdxJsx;
  options.isMdxEsSyntax = isMdxEs;
  if (parser === "markdown" || parser === "mdx") {
    return formatIn(code.subarray(cs, ce), options, out, parser === "mdx", isInTemplate, depth + 1) === FORMAT_OK;
  }
  if (parser === "babel" || parser === "typescript") {
    let path: string;
    if (fileOfOxfmt.length > 0) path = fileOfOxfmt;
    else if (parser === "babel") path = "dummy.jsx";
    else if (language === "tsx") path = "dummy.tsx";
    else path = "dummy.ts";
    const fj = options.formatJavascript;
    if (fj === null) return false;
    return fj(path, code, cs, ce, options, out);
  }
  return embeddedFormat(parser, code, cs, ce, options, out);
}

// ---------------------------------------------------------------------------------------------- format

// One set of buffers per level of nesting: a Markdown code block in Markdown formats while the outer text is still being used.
class Level {
  tree: Tree = new Tree();
  normalized: ByteBuf = new ByteBuf(1024);
  withPragma: ByteBuf = new ByteBuf(1024);
}
const levels: Level[] = [];

function levelAt(depth: number): Level {
  while (levels.length <= depth) levels.push(new Level());
  return levels[depth];
}

// What `scanText` finds.
const SCAN_CR = 1;
const SCAN_NUL = 2;
const SCAN_DOUBLE_BRACKET = 4;

const SCAN = new Uint8Array(256);
SCAN[13] = SCAN_CR;
SCAN[0] = SCAN_NUL;
SCAN[91] = SCAN_DOUBLE_BRACKET;

// Which of CR, NUL and `[[` the text has.
function scanText(text: Uint8Array): number {
  const n = text.length;
  const table = SCAN;
  let acc = 0;
  let dbl = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const f = table[text[i] | 0] | 0;
    acc = acc | f;
    dbl = dbl | (f & prev);
    prev = f;
  }
  return (acc & (SCAN_CR | SCAN_NUL)) | (dbl & SCAN_DOUBLE_BRACKET);
}

// Appends text[start, end) with each `\r\n`, `\r` and `\n` replaced by `lineEnding`.
function writeWithLineEnding(text: Uint8Array, start: number, end: number, lineEnding: number, out: ByteBuf): void {
  let from = start;
  for (let i = start; i < end; i++) {
    const b = text[i] | 0;
    if (b !== 13 && b !== 10) continue;
    out.append(text, from, i);
    if (lineEnding === LINE_ENDING_CRLF) {
      out.push(13);
      out.push(10);
    } else if (lineEnding === LINE_ENDING_CR) out.push(13);
    else out.push(10);
    if (b === 13 && i + 1 < end && (text[i + 1] | 0) === 10) i = i + 1;
    from = i + 1;
  }
  out.append(text, from, end);
}

// The byte offset of the UTF-16 offset `index` of `text` (-1: `text` is shorter), moved behind a `\r\n` that it is in the middle of,
// and -1 if that is before `first`. (`Offsets::new` of range.rs.)
function offsetOf(text: Uint8Array, first: number, index: number): number {
  if (index < 0) return -1;
  if (index > utf16Len(text, 0, text.length)) return -1;
  let at = byteOffsetOfUtf16(text, 0, text.length, index);
  // After `\r\n` has become `\n`, an offset between the two is behind it.
  if (at >= 1 && at < text.length && (text[at - 1] | 0) === 13 && (text[at] | 0) === 10) at = at + 1;
  return at >= first ? at : -1;
}

const PRAGMA_COMMENT = new Uint8Array([60, 33, 45, 45, 32, 64, 102, 111, 114, 109, 97, 116, 32, 45, 45, 62]); // <!-- @format -->

/** Appends the formatted `text` to `out`. Returns a `FORMAT_*` code (0: ok). */
export function format(text: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  return formatIn(text, options, out, false, false, 0);
}

/** The same for MDX. */
export function formatMdx(text: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  return formatIn(text, options, out, true, false, 0);
}

/** The same for the document of a template in JavaScript. */
export function formatInTemplate(text: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  return formatIn(text, options, out, false, true, 0);
}

function formatIn(text0: Uint8Array, options0: FormatOptions, out: ByteBuf, isMdx: boolean, isInTemplate: boolean, depth: number): number {
  const original = text0;
  const first = startsWithBom(original, 0) ? 3 : 0;
  // `Offsets::new`
  let start = first;
  let end = original.length;
  if (options0.rangeStart >= 0 || options0.rangeEnd >= 0) {
    const s = offsetOf(original, first, options0.rangeStart);
    if (s >= 0) start = s;
    const e = offsetOf(original, first, options0.rangeEnd);
    if (e >= 0) end = e;
  }
  let text = first === 0 ? original : original.subarray(first);
  let options = options0;
  if (options.lineEnding === LINE_ENDING_AUTO || (isMdx && options.flavor === FLAVOR_OXFMT)) {
    options = options0.copy();
    options.lineEnding = resolveLineEnding(options0.lineEnding, text);
    // oxfmt hands MDX to the Prettier that comes with it, and nothing in it comes back: the code in it is Prettier's too, and what
    // only oxfmt does is not done.
    if (isMdx && options.flavor === FLAVOR_OXFMT) {
      options.flavor = FLAVOR_PRETTIER;
      options.sortImports = -1;
      options.jsdoc = null;
      options.tailwind = -1;
    }
  }
  const isWhole = start <= first && end >= original.length;
  const level = levelAt(depth);
  // One pass over the text: a carriage return, a NUL, `[[`.
  const flags = scanText(text);
  if ((flags & SCAN_CR) !== 0) {
    level.normalized.reset();
    level.normalized.reserve(text.length);
    writeWithLineEnding(text, 0, text.length, LINE_ENDING_LF, level.normalized);
    text = level.normalized.view();
  }
  if (
    (start >= end && text.length > 0) ||
    (options.requirePragma && !hasPragma(text, "format", "prettier")) ||
    (options.checkIgnorePragma && hasPragma(text, "noformat", "noprettier"))
  ) {
    out.append(original, 0, original.length);
    return FORMAT_OK;
  }
  out.append(original, 0, first);
  // Nothing in Markdown can be formatted on its own.
  if (!isWhole) {
    writeWithLineEnding(text, 0, text.length, options.lineEnding, out);
    return FORMAT_OK;
  }
  if (options.insertPragma && !options.requirePragma && !hasPragma(text, "format", "prettier")) {
    const wp = level.withPragma;
    wp.reset();
    const fm = parseFrontMatter(text);
    const fmEnd = fm === null ? 0 : fm.end;
    if (fmEnd > 0) {
      wp.append(text, 0, fmEnd);
      wp.push(10);
      wp.push(10);
    }
    wp.append(PRAGMA_COMMENT, 0, PRAGMA_COMMENT.length);
    wp.push(10);
    wp.push(10);
    wp.append(text, fmEnd, text.length);
    text = wp.view();
  }
  // Prettier goes by what is white space in JavaScript, and makes nothing of a no-break space.
  {
    let blank = true;
    for (let i = 0; i < text.length; i++) {
      const b = text[i] | 0;
      if (!(b === 32 || b === 9 || b === 10 || b === 12 || b === 13)) {
        blank = false;
        break;
      }
    }
    if (blank) return FORMAT_OK;
  }
  return formatDocument(text, options, level.tree, isMdx, isInTemplate, depth, flags, out);
}

let buildFailure = FORMAT_OK;

// Builds the document for `text0`, in which every line break is `\n`: a handle of the pool of css/doc, or -1 (then `buildFailure` is
// the reason). The caller owns the pool: `docPush()` before, `docPop()` when it is done with the document.
function buildDocument(text0: Uint8Array, options: FormatOptions, tree: Tree, isMdx: boolean, isInTemplate: boolean, depth: number, flags: number): number {
  const blanked = blankFrontMatter(text0);
  const original = text0;
  const text = blanked === null ? text0 : blanked;
  const syntax = isMdx ? SY_MDX : options.flavor === FLAVOR_OXFMT ? SY_WITH_DIRECTIVES : SY_MARKDOWN;
  const root = parse(text, original, syntax, tree, (flags & SCAN_NUL) !== 0 ? 1 : 0);
  if (root < 0) {
    buildFailure = FORMAT_NESTED_TOO_DEEPLY;
    return -1;
  }
  const pre = new Preprocessor(text, original, options.proseWrap === PROSE_WRAP_ALWAYS, isMdx, options.flavor === FLAVOR_OXFMT, tree, options.indentWidth, (flags & SCAN_DOUBLE_BRACKET) !== 0);
  pre.run(root);
  if (pre.isNestedTooDeeply) {
    buildFailure = FORMAT_NESTED_TOO_DEEPLY;
    return -1;
  }
  const embed = new MdEmbed(options, isInTemplate, depth);
  const printer = new Printer(text, original, tree, options, embed, isInTemplate, isMdx);
  const document = printer.print(root);
  if (printer.stack.ranOut()) {
    buildFailure = FORMAT_NESTED_TOO_DEEPLY;
    return -1;
  }
  if (printer.failure !== FORMAT_OK) {
    buildFailure = printer.failure;
    return -1;
  }
  return document;
}

// Prints the document for `text`, in which every line break is `\n`.
function formatDocument(text0: Uint8Array, options: FormatOptions, tree: Tree, isMdx: boolean, isInTemplate: boolean, depth: number, flags: number, out: ByteBuf): number {
  docPush();
  const document = buildDocument(text0, options, tree, isMdx, isInTemplate, depth, flags);
  const r = document < 0 ? buildFailure : printDocument(document, options, text0, out);
  docPop();
  return r;
}

/** For the formatter of JavaScript (Markdown in the templates tagged `md` and `markdown`, `embed.ts`): the document of `text`, which
 * has `\n` for every line break, as a handle of the pool of css/doc.ts. -1 if it cannot be made (`templateFailure()` says why).
 * The caller brackets it with `docPush()` / `docPop()`. */
export function templateDocument(text: Uint8Array, options: FormatOptions): number {
  return buildDocument(text, options, new Tree(), false, true, 0, scanText(text));
}

export function templateFailure(): number {
  return buildFailure;
}
