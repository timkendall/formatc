// Port of vendor/bun/src/format/css/mod.rs: CSS, the way Prettier formats it.
//
// Prettier parses a style sheet with `postcss`, and what is in it with three more parsers: `postcss-values-parser` for values,
// `postcss-selector-parser` for selectors and `postcss-media-query-parser` for media queries. What it prints depends on how
// they take the text apart, mistakes included. So this has the same four parsers.
//
// Entry points: `format(text, parser, options, out)` (and `formatWith` with a `Scratch`), `document(text, parser, options)`
// (Prettier's `textToDoc`: a `Doc` handle, see docs/CSS_DOC_API.md), `parserForPath`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { Stack } from "../../base/stack.ts";
import {
  FORMAT_NESTED_TOO_DEEPLY,
  FORMAT_OK,
  FORMAT_SYNTAX_ERROR_AT,
  syntaxErrorBeforeNormalizing,
} from "../errors.ts";
import { parseFrontMatter, hasIndentedDelimiter } from "../front_matter.ts";
import {
  EMBEDDED_OFF,
  FormatOptions,
  HTML_ROOT_NONE,
  QUOTE_SINGLE,
  TRAILING_COMMAS_NONE,
  FLAVOR_OXFMT,
} from "../options.ts";
import { beforeParsingCss } from "../pragma.ts";
import { refusalMessage, refusalOffset, noteRefusal, SyntaxError } from "../syntax_error.ts";
import { startsWithBom, trimJsWhitespaceEnd, trimJsWhitespaceStart, leadingWhiteSpaceLen } from "../text.ts";
import { byteOffsetOfUtf16, utf16Len } from "../../base/utf8.ts";
import { yamlDocument } from "../yaml/mod.ts";
import {
  DOC_EMPTY,
  DOC_HARDLINE,
  Printer as DocPrinter,
  docAscii,
  docPool,
  docPop,
  docPush,
  docText,
  printDoc,
  replaceEndOfLineWithLiteralLines,
  textToDoc,
} from "./doc.ts";
import { Memo } from "./memo.ts";
import { Context, Parsed } from "./parse.ts";
import { PLACEHOLDER_AT_RULE, PLACEHOLDER_STATEMENT, PostcssParser } from "./postcss.ts";
import { Printer } from "./printer.ts";
import { Sink } from "./sink.ts";
import { SYNTAX_CSS, SYNTAX_LESS, SYNTAX_SCSS, syntaxFromName } from "./syntax.ts";
import { indexOfByteIn, indexOfLit, isAsciiWhitespace } from "./misc.ts";

export { SYNTAX_CSS, SYNTAX_LESS, SYNTAX_SCSS, syntaxFromName };
/** `css::Parser` */
export const PARSER_CSS = SYNTAX_CSS;
export const PARSER_LESS = SYNTAX_LESS;
export const PARSER_SCSS = SYNTAX_SCSS;

/** The parser that Prettier infers from the name of a file. -1: it is not a style sheet. */
export function parserForPath(path: string): number {
  const p = path.toLowerCase();
  if (p.endsWith(".scss")) return SYNTAX_SCSS;
  if (p.endsWith(".css") || p.endsWith(".wxss") || p.endsWith(".pcss") || p.endsWith(".postcss")) return SYNTAX_CSS;
  if (p.endsWith(".less")) return SYNTAX_LESS;
  return -1;
}

/** Everything that is allocated to format a style sheet. It is reused for the next one. */
export class Scratch {
  memo: Memo;
  parser: PostcssParser;
  ctx: Context;
  parsed: Parsed;
  sink: Sink;
  docPrinter: DocPrinter;
  printer: Printer;
  constructor() {
    this.memo = new Memo();
    this.parser = new PostcssParser();
    this.ctx = new Context();
    this.parsed = new Parsed();
    this.sink = new Sink();
    this.docPrinter = new DocPrinter();
    this.printer = new Printer(this.ctx, this.parsed, this.sink, this.memo, this.parser.tree);
  }
}

let defaultScratch: Scratch | null = null;

/** The scratch of this thread. */
export function threadScratch(): Scratch {
  if (defaultScratch === null) defaultScratch = new Scratch();
  return defaultScratch;
}

// ───────────────────────────── preparing the text ─────────────────────────────

const ICQ_INITIAL = 0;
const ICQ_QUOTES = 1;
const ICQ_URL = 2;
const ICQ_COMMENT_BLOCK = 3;
const ICQ_COMMENT_INLINE = 4;

/** Prettier's `replaceQuotesInInlineComments`: the inline comments in which quotes and asterisks are to be replaced by blanks,
 * for `postcss-less` not to stumble over them: (start, end) pairs in the result. */
function inlineCommentsWithQuotes(text: Uint8Array, len: number): number[] {
  let state = ICQ_INITIAL;
  let quote = 0;
  let stateToReturnFromQuotes = ICQ_INITIAL;
  let inlineCommentStart = 0;
  let inlineCommentContainsQuotes = false;
  const comments: number[] = [];
  let i = 0;
  while (i < len) {
    const c = text[i] | 0;
    switch (state) {
      case ICQ_INITIAL:
        if (c === 39 || c === 34) {
          state = ICQ_QUOTES;
          quote = c;
        } else if ((c === 117 || c === 85) && i + 4 <= len && lowerEq4(text, i)) {
          state = ICQ_URL;
          i = i + 3;
        } else if (c === 47 && i + 1 < len && (text[i + 1] | 0) === 42) {
          state = ICQ_COMMENT_BLOCK;
          i = i + 1;
        } else if (c === 47 && i + 1 < len && (text[i + 1] | 0) === 47) {
          state = ICQ_COMMENT_INLINE;
          inlineCommentStart = i;
          i = i + 1;
        }
        break;
      case ICQ_QUOTES:
        if (c === quote && (text[i - 1] | 0) !== 92) {
          state = stateToReturnFromQuotes;
          stateToReturnFromQuotes = ICQ_INITIAL;
        }
        if (c === 10 || c === 13) return [];
        break;
      case ICQ_URL:
        if (c === 41) {
          state = ICQ_INITIAL;
        } else if (c === 10 || c === 13) {
          return [];
        } else if (c === 39 || c === 34) {
          state = ICQ_QUOTES;
          quote = c;
          stateToReturnFromQuotes = ICQ_URL;
        }
        break;
      case ICQ_COMMENT_BLOCK:
        if (c === 47 && (text[i - 1] | 0) === 42) state = ICQ_INITIAL;
        break;
      default:
        if (c === 34 || c === 39 || c === 42) {
          inlineCommentContainsQuotes = true;
        } else if (c === 10 || c === 13) {
          if (inlineCommentContainsQuotes) {
            comments.push(inlineCommentStart, i);
          }
          state = ICQ_INITIAL;
          inlineCommentContainsQuotes = false;
        }
        break;
    }
    i = i + 1;
  }
  return comments;
}

/** `text[i..i + 4].eq_ignore_ascii_case("url(")` */
function lowerEq4(text: Uint8Array, i: number): boolean {
  return (
    (text[i] | 0 | 32) === 117 && (text[i + 1] | 0 | 32) === 114 && (text[i + 2] | 0 | 32) === 108 && (text[i + 3] | 0) === 40
  );
}

/** `each(@list, { .. })` of Less is a statement for oxfmt, which writes the `;` behind it if there is none. `postcss-less` goes
 * on to the next `;`, wherever that is. So here the `;` is there before anything is parsed. */
function withSemicolonsBehindEach(text: Uint8Array): Uint8Array {
  if (indexOfLit(text, 0, text.length, "each(") < 0) return text;
  const n = text.length;
  // How many `(` are open, and how many were when the statement started that the scan is in. What is in its parentheses is
  // printed as it is.
  let depth = 0;
  let statement = -1;
  const missing: number[] = [];
  // The last character that is neither white space nor in a comment.
  let last = 59;
  let at = 0;
  while (at < n) {
    const byte = text[at] | 0;
    let len: number;
    if (byte === 34 || byte === 39) {
      let end = 1;
      while (at + end < n && (text[at + end] | 0) !== byte) {
        end = end + 1 + ((text[at + end] | 0) === 92 ? 1 : 0);
      }
      len = end + 1;
    } else if (byte === 47 && at + 1 < n && (text[at + 1] | 0) === 42) {
      const f = indexOfLit(text, at + 2, n, "*/");
      at = f < 0 ? n : f + 2;
      continue;
    } else if (byte === 47 && at + 1 < n && (text[at + 1] | 0) === 47 && last !== 58) {
      const f = indexOfByteIn(text, at, n, 10);
      at = f < 0 ? n : f;
      continue;
    } else if (
      byte === 101 && statement < 0 && (last === 59 || last === 123 || last === 125) && indexOfLitAt(text, at, n, "each(")
    ) {
      statement = depth;
      depth = depth + 1;
      len = 5;
    } else if (byte === 40) {
      depth = depth + 1;
      len = 1;
    } else if (byte === 41) {
      depth = depth > 0 ? depth - 1 : 0;
      if (statement === depth) {
        statement = -1;
        const blanks = leadingWhiteSpaceLen(text, at + 1, n);
        if (!(at + 1 + blanks < n && (text[at + 1 + blanks] | 0) === 59)) missing.push(at + 1);
        at = at + 1;
        last = 59;
        continue;
      }
      len = 1;
    } else {
      len = 1;
    }
    at = at + len;
    if (!isAsciiWhitespace(byte)) last = at - 1 < n ? text[at - 1] | 0 : byte;
  }
  if (missing.length === 0) return text;
  const out = new Uint8Array(n + missing.length);
  let from = 0;
  let o = 0;
  for (let k = 0; k < missing.length; k++) {
    const m = missing[k] | 0;
    out.set(text.subarray(from, m), o);
    o = o + (m - from);
    out[o] = 59;
    o = o + 1;
    from = m;
  }
  out.set(text.subarray(from, n), o);
  return out;
}

function indexOfLitAt(text: Uint8Array, at: number, end: number, lit: string): boolean {
  if (at + lit.length > end) return false;
  for (let i = 0; i < lit.length; i++) {
    if ((text[at + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** `bun_core::strings::crlf_as_lf`: each `\r\n` and each `\r` is `\n`. The text itself if there is no `\r`. */
function crlfAsLf(text: Uint8Array): Uint8Array {
  let cr = -1;
  for (let i = 0; i < text.length; i++) {
    if ((text[i] | 0) === 13) { cr = i; break; }
  }
  if (cr < 0) return text;
  const n = text.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const c = text[i] | 0;
    if (c === 13) {
      out[o] = 10;
      o = o + 1;
      if (i + 1 < n && (text[i + 1] | 0) === 10) i = i + 1;
    } else {
      out[o] = c;
      o = o + 1;
    }
  }
  return out.subarray(0, o);
}

// ───────────────────────────── parse and print ─────────────────────────────

let lastDocumentError = 0;
/** The `FORMAT_*` code that the last `document` call that returned a negative number ended with. */
export function documentError(): number {
  return lastDocumentError;
}

/** Parses `text`, whose line breaks are `\n`, and writes it to `sc.sink` (which `toOutput` or `toDocument` has set). Returns a
 * `FORMAT_*` code (`FORMAT_SYNTAX_ERROR_AT`: the place and the words are in the refusal slots). */
function parseAndPrint(text0: Uint8Array, parser: number, options: FormatOptions, sc: Scratch): number {
  const isOxfmt = options.flavor === FLAVOR_OXFMT;
  const text = parser === SYNTAX_LESS && isOxfmt ? withSemicolonsBehindEach(text0) : text0;
  const len = text.length;
  // What is parsed has blanks in the place of the front matter, so that all positions stay.
  const fm = parseFrontMatter(text);
  let blanked = text;
  let isBorrowed = true;
  if (fm !== null) {
    blanked = new Uint8Array(len);
    blanked.set(text);
    for (let i = 0; i < fm.end; i++) {
      if ((blanked[i] | 0) !== 10) blanked[i] = 32;
    }
    isBorrowed = false;
  }
  if (parser === SYNTAX_LESS) {
    const comments = inlineCommentsWithQuotes(blanked, len);
    if (comments.length > 0) {
      if (isBorrowed) {
        const copy = new Uint8Array(len);
        copy.set(blanked);
        blanked = copy;
        isBorrowed = false;
      }
      for (let k = 0; k < comments.length; k += 2) {
        for (let i = comments[k] | 0; i < (comments[k + 1] | 0); i++) {
          const b = blanked[i] | 0;
          if (b === 34 || b === 39 || b === 42) blanked[i] = 32;
        }
      }
    }
  }

  const placeholder = isOxfmt ? PLACEHOLDER_STATEMENT : PLACEHOLDER_AT_RULE;
  const tree = sc.parser.parseText(blanked, len, parser, 0, false, placeholder);
  if (tree === null) return FORMAT_SYNTAX_ERROR_AT;
  const sink = sc.sink;
  if (fm !== null) {
    const hasNodes = (tree.f[3] | 0) !== 0; // F_FIRST_CHILD of the root
    writeFrontMatter(text, fm.end, hasNodes, options, sink);
  }
  const ctx = sc.ctx;
  ctx.buf = sc.parser.buf;
  ctx.cssLen = len;
  ctx.originalText = text;
  ctx.originalLen = len;
  ctx.isOriginalText = isBorrowed;
  ctx.syntax = parser;
  ctx.isOxfmt = isOxfmt;
  ctx.stack = Stack.forTree();
  ctx.convertibleSets.clear();
  const printer = sc.printer;
  printer.rootTree = tree;
  printer.singleQuote = options.quoteStyle === QUOTE_SINGLE;
  printer.trailingComma = options.trailingCommas !== TRAILING_COMMAS_NONE;
  printer.isOxfmt = isOxfmt;
  printer.isHtmlStyleAttribute = options.inHtml.isStyleAttribute;
  printer.tailwind = options.tailwind;
  printer.nValueStack = 0;
  printer.commentBehindComma = 0;
  printer.indexInCommaGroup = 0;
  printer.commentsAboveItem = 0;
  printer.commentsAboveCount = 0;
  printer.failed = false;
  printer.isMemoizable = false;
  printer.cacheValid = false;
  sc.parsed.selectors.clear();
  sc.parsed.values.clear();
  printer.printRoot(tree, sc.parsed);
  if (ctx.stack.ranOut()) return FORMAT_NESTED_TOO_DEEPLY;
  if (printer.failed) {
    noteRefusal(printer.failMessage, printer.failOffset);
    return FORMAT_SYNTAX_ERROR_AT;
  }
  return sink.result();
}

/** Prettier's `printEmbedFrontMatter`, for the front matter text[0, end). */
function writeFrontMatter(text: Uint8Array, end: number, hasNodes: boolean, options: FormatOptions, sink: Sink): void {
  const p = docPool;
  const fm = text;
  // first_line_end
  let firstLineEnd = indexOfByteIn(fm, 0, end, 10);
  if (firstLineEnd < 0) firstLineEnd = end;
  let lastLineStart = 0;
  for (let i = end - 1; i >= 0; i--) {
    if ((fm[i] | 0) === 10) { lastLineStart = i + 1; break; }
  }
  const langS = trimJsWhitespaceStart(fm, 3, firstLineEnd);
  const langE = trimJsWhitespaceEnd(fm, langS, firstLineEnd);
  const isLang = (lit: string): boolean => {
    if (langE - langS !== lit.length) return false;
    for (let i = 0; i < lit.length; i++) {
      if ((fm[langS + i] | 0) !== lit.charCodeAt(i)) return false;
    }
    return true;
  };
  const languageEmpty = langE <= langS;
  const startsPlus = end >= 3 && (fm[0] | 0) === 43 && (fm[1] | 0) === 43 && (fm[2] | 0) === 43;
  const isToml = isLang("toml") || (languageEmpty && startsPlus);
  const isYaml = isLang("yaml") || (languageEmpty && !isToml);
  const vs0 = firstLineEnd <= lastLineStart ? firstLineEnd : end;
  const ve0 = firstLineEnd <= lastLineStart ? lastLineStart : end;
  const vs = trimJsWhitespaceStart(fm, vs0, ve0);
  const ve = trimJsWhitespaceEnd(fm, vs, ve0);
  // There is no formatter for TOML, and what is not YAML after all stays as it is.
  let formatted = -1;
  if (options.embeddedLanguageFormatting === EMBEDDED_OFF || hasIndentedDelimiter(fm, 0, end)) {
    formatted = -1;
  } else if (ve <= vs && (isYaml || isToml)) {
    formatted = DOC_EMPTY;
  } else if (isYaml) {
    const d = yamlDocument(fm.subarray(vs, ve), ve - vs, options);
    if (d >= 0) formatted = textToDoc(d);
  }
  let frontMatter: number;
  if (formatted >= 0) {
    const m = p.begin();
    p.add(docText(fm, 0, 3));
    p.add(docText(fm, langS, langE));
    p.add(DOC_HARDLINE);
    if (p.isEmptyText(formatted)) p.add(DOC_EMPTY);
    else p.add(p.array2(formatted, DOC_HARDLINE));
    p.add(docText(fm, lastLineStart, end));
    frontMatter = p.markAsRoot(p.array(m));
  } else {
    frontMatter = docText(fm, 0, end);
  }
  sink.document(p.array3(frontMatter, DOC_HARDLINE, hasNodes ? DOC_HARDLINE : DOC_EMPTY));
}

/** Prettier's `textToDoc`: the document for `text`, whose line breaks are `\n`, in another language. A `Doc` handle (>= 0), or
 * `-FORMAT_*` (`documentError()`; for a syntax error the place and the words are in the refusal slots). The document lives
 * in the pool of `doc.ts` until the next `docReset`/`docPop` of the caller. */
export function document(text: Uint8Array, parser: number, options: FormatOptions): number {
  const sc = threadScratch();
  sc.sink.toDocument();
  const r = parseAndPrint(text, parser, options, sc);
  if (r !== FORMAT_OK) {
    lastDocumentError = r;
    return -r;
  }
  const d = sc.sink.intoDocument();
  if (d < 0) {
    lastDocumentError = FORMAT_NESTED_TOO_DEEPLY;
    return -FORMAT_NESTED_TOO_DEEPLY;
  }
  const t = textToDoc(d);
  if (t < 0) {
    lastDocumentError = FORMAT_NESTED_TOO_DEEPLY;
    return -FORMAT_NESTED_TOO_DEEPLY;
  }
  return t;
}

/** Prettier's `textToDoc` for embedded code, before `textToDoc` of doc.ts: the document of `text` (line breaks `\n`) in the
 * syntax `parser`, as a `Doc` handle, or -1. */
export function parseAndPrintToDocument(text: Uint8Array, parser: number, options: FormatOptions): number {
  const sc = new Scratch();
  sc.sink.toDocument();
  const r = parseAndPrint(text, parser, options, sc);
  if (r !== FORMAT_OK) return -1;
  return sc.sink.intoDocument();
}

/** The byte offset in `original` of the UTF-16 offset `index` (-1: none: the text is shorter, or it is before `first`), moved
 * behind a `\r\n` that it is in the middle of. (`Offsets::new` of range.rs.) */
function offsetOf(original: Uint8Array, first: number, index: number): number {
  if (index < 0) return -1;
  if (index > utf16Len(original, 0, original.length)) return -1;
  let at = byteOffsetOfUtf16(original, 0, original.length, index);
  if (at >= 1 && at < original.length && (original[at - 1] | 0) === 13 && (original[at] | 0) === 10) at = at + 1;
  return at >= first ? at : -1;
}

/** Appends the formatted `text` to `out`. Returns a `FORMAT_*` code. */
export function formatWith(text0: Uint8Array, parser: number, options: FormatOptions, sc: Scratch, out: ByteBuf): number {
  const original = text0;
  const hasBom = startsWithBom(original, 0);
  const first = hasBom ? 3 : 0;
  const noBom = hasBom ? original.subarray(3) : original;
  // Prettier's `normalizeInputAndOptions`: the offsets count UTF-16 code units of `original`.
  let start = first;
  let end = original.length;
  if (options.rangeStart >= 0 || options.rangeEnd >= 0) {
    const s = offsetOf(original, first, options.rangeStart);
    if (s >= 0) start = s;
    const e = offsetOf(original, first, options.rangeEnd);
    if (e >= 0) end = e;
  }
  if (start >= end && noBom.length > 0) {
    out.append(original, 0, original.length);
    return FORMAT_OK;
  }
  // Nothing in a style sheet is something that Prettier formats on its own.
  const isRange = start > first || end < original.length;
  const lf = crlfAsLf(noBom);
  const fmEnd = parseFrontMatter(lf);
  const prepared = beforeParsingCss(lf, fmEnd === null ? 0 : fmEnd.end, !isRange, options);
  if (prepared === null) {
    out.append(original, 0, original.length);
    return FORMAT_OK;
  }
  const text = prepared;
  {
    const ts = trimJsWhitespaceStart(text, 0, text.length);
    if (ts >= text.length) {
      if (hasBom) out.append(original, 0, 3);
      return FORMAT_OK;
    }
  }
  const outStart = out.len;
  if (hasBom) out.append(original, 0, 3);
  docPush();
  let r: number;
  if (isRange) {
    sc.sink.toDocument();
    r = parseAndPrint(text, parser, options, sc);
    if (r === FORMAT_OK) {
      const doc = replaceEndOfLineWithLiteralLines(text, 0, text.length);
      r = printDoc(doc, options, original, out);
    }
  } else {
    const isInHtml = options.inHtml.root !== HTML_ROOT_NONE;
    sc.docPrinter.init(options, original, out);
    sc.sink.toOutput(sc.docPrinter, isInHtml);
    r = parseAndPrint(text, parser, options, sc);
  }
  docPop();
  if (r !== FORMAT_OK) {
    out.truncate(outStart);
    if (r === FORMAT_SYNTAX_ERROR_AT) {
      const e = syntaxErrorBeforeNormalizing(new SyntaxError(refusalMessage(), refusalOffset()), noBom);
      noteRefusal(e.message, e.offset);
    }
  }
  return r;
}

/** Appends the formatted `text` to `out` with the thread's scratch. Returns a `FORMAT_*` code. */
export function format(text: Uint8Array, parser: number, options: FormatOptions, out: ByteBuf): number {
  return formatWith(text, parser, options, threadScratch(), out);
}

void docAscii;
void PARSER_CSS;
