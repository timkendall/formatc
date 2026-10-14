// Port of vendor/bun/src/format/handlebars/mod.rs: Handlebars, as Glimmer reads it: Prettier's `language-handlebars`, with
// ports of the parsers that it uses.
//
//   text ─ lexer.lex ─→ tokens ─ parser.parse ─→ statements ─ tokenizer.build ─→ Tree ─ Printer ─→ Elements
//          @handlebars/parser                                   simple-html-tokenizer, @glimmer/syntax
//
// Prettier prints what the parsers give it, and they drop and change things: there is no `<!DOCTYPE html>` in the tree,
// `{{this/a}}` is `{{a}}`. Its printer changes some more: the lines of a `<script>` are joined. Here the output says what
// the template says. Where Prettier's does, it is Prettier's. Where it does not, it is what Prettier would have to print,
// or the text of the smallest node around the place as it is written (`Tree.written`).
//
// API: `format(text, options, out): number` appends the formatted `text` to `out` and returns a `FORMAT_*` code of
// `../errors.ts` (0 ok; `FORMAT_SYNTAX_ERROR_AT`: `refusalReason()` of `../syntax_error.ts` says what and where, as a byte
// of `text` without a byte order mark; `FORMAT_NESTED_TOO_DEEPLY`; `FORMAT_TOO_LONG`).
import { ByteBuf } from "../../base/bytebuf.ts";
import { byteOffsetOfUtf16, utf16Len } from "../../base/utf8.ts";
import { Elements, Printer as DocPrinter, docPop, docPush, printDoc, replaceEndOfLineWithLiteralLines } from "../css/doc.ts";
import { FORMAT_NESTED_TOO_DEEPLY, FORMAT_OK, FORMAT_SYNTAX_ERROR_AT, FORMAT_TOO_LONG } from "../errors.ts";
import { parseFrontMatter } from "../front_matter.ts";
import { FormatOptions, HTML_WS_IGNORE } from "../options.ts";
import { MSG_TOO_LARGE, clearRefusal, noteRefusal, refusalReason } from "../syntax_error.ts";
import { startsWithBom } from "../text.ts";
import { K_FRONT_MATTER, Tree } from "./ast.ts";
import { Tokens, lex } from "./lexer.ts";
import { Statements, parse as parseStatements } from "./parser.ts";
import { Printer } from "./printer.ts";
import { sortClasses, hasSorter } from "./tailwind.ts";
import { build } from "./tokenizer.ts";
import { Writer } from "./verify.ts";

const BOM_LEN = 3;

// Whether Prettier takes the file at `path` for Handlebars.
export function isHandlebarsPath(path: string): boolean {
  const n = path.length;
  return endsWithIgnoreCase(path, n, ".hbs") || endsWithIgnoreCase(path, n, ".handlebars");
}

function endsWithIgnoreCase(path: string, n: number, ext: string): boolean {
  const m = ext.length;
  if (n < m) return false;
  for (let i = 0; i < m; i++) {
    let c = path.charCodeAt(n - m + i);
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== ext.charCodeAt(i)) return false;
  }
  return true;
}

// What can be used again for the next file.
const tokens = new Tokens();
const statements = new Statements();
const tree = new Tree();
const elements = new Elements();
const printer = new Printer();
const docPrinter = new DocPrinter();

// Return codes of `parse`.
const PARSED = 0;
const REFUSED = -1;
const NESTED = -2;

// Prettier's `parse`, of a text without `\r` that has blanks in the place of its front matter, which ends at
// `frontMatterEnd`. The template is in `parsedTemplate`. Returns 0, -1 (refused: `refusalReason()`) or -2.
let parsedTemplate = 0;

function parse(content: Uint8Array, frontMatterEnd: number): number {
  const tokens$ = tokens;
  tokens$.n = 0;
  const tree$ = tree;
  tree$.clear(content);
  // Positions have 31 bits.
  if (content.length > 2147483647) return noteRefusal(MSG_TOO_LARGE, 0);
  clearRefusal();
  let r = lex(content, tokens$);
  if (r < 0) return r;
  const statements$ = statements;
  r = parseStatements(content, tokens$, tree$, statements$);
  if (r < 0) return r;
  let frontMatter = -1;
  if (frontMatterEnd > 0) frontMatter = tree$.add(K_FRONT_MATTER, 0, frontMatterEnd);
  r = build(content, statements$, frontMatter, tree$);
  if (r < 0) return r;
  parsedTemplate = r;
  return PARSED;
}

// `bun_core::strings::crlf_as_lf` of `text[from..]`: each `\r\n` and each `\r` is `\n`. A view of `text` if there is no `\r`.
function crlfAsLf(text: Uint8Array, from: number): Uint8Array {
  const n = text.length;
  let cr = -1;
  for (let i = from; i < n; i++) {
    if ((text[i] | 0) === 13) {
      cr = i;
      break;
    }
  }
  if (cr < 0) return text.subarray(from, n);
  const out = new Uint8Array(n - from);
  let o = 0;
  for (let i = from; i < n; i++) {
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

// The front matter at the start of `text`, which has no `\r`: where it ends (0: there is none). And `text` with blanks in
// its place, so that all positions stay (the text itself if there is none).
let withoutFrontMatterEnd = 0;

function withoutFrontMatter(text: Uint8Array): Uint8Array {
  const fm = parseFrontMatter(text);
  withoutFrontMatterEnd = fm === null ? 0 : fm.end;
  if (withoutFrontMatterEnd === 0) return text;
  const content = new Uint8Array(text.length);
  content.set(text);
  for (let i = 0; i < withoutFrontMatterEnd; i++) {
    if ((content[i] | 0) !== 10) content[i] = 32;
  }
  return content;
}

// ------------------------------------------------------------------------------------------ --debug-check

const verifyWriter = new Writer();
const verifyA = new ByteBuf(1024);
const verifyB = new ByteBuf(1024);

// The text written down by `verify.ts`. 0: it cannot be parsed; 1: ok; 2: nested too deeply. `lost`: it is the text itself.
function written(text: Uint8Array, options: FormatOptions, into: ByteBuf): number {
  const first = startsWithBom(text, 0) ? BOM_LEN : 0;
  const lf = crlfAsLf(text, first);
  const content = withoutFrontMatter(lf);
  const frontMatterEnd = withoutFrontMatterEnd;
  const r = parse(content, frontMatterEnd);
  if (r < 0) return 0;
  into.reset();
  const tree$ = tree;
  if (tree$.hasLostText) {
    into.append(content, 0, content.length);
    return 1;
  }
  const w = verifyWriter;
  w.tree = tree$;
  w.source = content;
  w.isWhiteSpaceSensitive = options.htmlWhitespaceSensitivity !== HTML_WS_IGNORE;
  w.out = into;
  w.run.reset();
  w.preDepth = 0;
  w.tailwind = options.tailwind >= 0 && hasSorter();
  w.touches = -1;
  w.stack.reset();
  w.template(parsedTemplate);
  return w.stack.ranOut() ? 2 : 1;
}

// `--debug-check`: whether `after`, which `format` has made of `before`, says what that says. See `verify.ts`. 1: it does,
// 0: it does not, -1: nested too deeply (`FormatError::NestedTooDeeply`).
export function saysTheSame(before: Uint8Array, after: Uint8Array, options: FormatOptions): number {
  const verifyA$ = verifyA;
  const rb = written(before, options, verifyA$);
  if (rb === 0) return 0;
  const verifyB$ = verifyB;
  const ra = written(after, options, verifyB$);
  if (ra === 0) return 0;
  if (rb === 2 || ra === 2) return -1;
  if (verifyA$.len !== verifyB$.len) return 0;
  const a = verifyA$.data;
  const b = verifyB$.data;
  const n = verifyA$.len;
  for (let i = 0; i < n; i++) {
    if ((a[i] | 0) !== (b[i] | 0)) return 0;
  }
  return 1;
}

// ------------------------------------------------------------------------------------------ format

// How long `text[from, to)` is after each `\r\n` in it has become `\n`.
function normalizedLen(text: Uint8Array, from: number, to: number): number {
  let n = to - from;
  for (let i = from; i + 1 < to; i++) {
    if ((text[i] | 0) === 13 && (text[i + 1] | 0) === 10) n = n - 1;
  }
  return n;
}

// The byte offset of the UTF-16 offset `index` of `text` (-1: `text` is shorter), moved behind a `\r\n` that it is in the
// middle of, and -1 if that is before `first`. (`Offsets::new` of range.rs.)
function offsetOf(text: Uint8Array, first: number, index: number): number {
  if (index < 0) return -1;
  if (index > utf16Len(text, 0, text.length)) return -1;
  let at = byteOffsetOfUtf16(text, 0, text.length, index);
  // After `\r\n` has become `\n`, an offset between the two is behind it.
  if (at >= 1 && at < text.length && (text[at - 1] | 0) === 13 && (text[at] | 0) === 10) at = at + 1;
  return at >= first ? at : -1;
}

// Appends the formatted `text` to `out`: Prettier's `formatWithCursor`, without the cursor. Returns a `FORMAT_*` code.
export function format(text: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  const original = text;
  const first = startsWithBom(original, 0) ? BOM_LEN : 0;
  // `Offsets::new`
  let start = first;
  let end = original.length;
  if (options.rangeStart >= 0 || options.rangeEnd >= 0) {
    const s = offsetOf(original, first, options.rangeStart);
    if (s >= 0) start = s;
    const e = offsetOf(original, first, options.rangeEnd);
    if (e >= 0) end = e;
  }
  // The offsets after `\r\n` has become `\n`.
  start = normalizedLen(original, first, start < first ? first : start);
  end = normalizedLen(original, first, end < first ? first : end);
  const lf = crlfAsLf(original, first);
  const len = lf.length;
  if (start >= end && len > 0) {
    out.append(original, 0, original.length);
    return FORMAT_OK;
  }
  const isRange = start > 0 || end < len;
  // For Prettier a no-break space is white space too.
  if (!isRange) {
    let blank = true;
    for (let i = 0; i < len; i++) {
      const c = lf[i] | 0;
      if (!(c === 32 || c === 9 || c === 10 || c === 12 || c === 13)) {
        blank = false;
        break;
      }
    }
    if (blank) {
      out.append(original, 0, first);
      return FORMAT_OK;
    }
  }
  const content = withoutFrontMatter(lf);
  const frontMatterEnd = withoutFrontMatterEnd;
  const r = parse(content, frontMatterEnd);
  if (r < 0) {
    if (r === NESTED) return FORMAT_NESTED_TOO_DEEPLY;
    const e = refusalReason().beforeNormalizingEndOfLine(original.subarray(first));
    noteRefusal(e.message, e.offset);
    return FORMAT_SYNTAX_ERROR_AT;
  }
  const tree$ = tree;
  if (tree$.hasLostText) {
    out.append(original, 0, original.length);
    return FORMAT_OK;
  }
  out.append(original, 0, first);
  // Nothing in a template is something that Prettier formats on its own.
  if (isRange) {
    docPush();
    const doc = replaceEndOfLineWithLiteralLines(lf, 0, len);
    const rr = printDoc(doc, options, original, out);
    docPop();
    return rr;
  }
  if (options.tailwind >= 0) sortClasses(tree$);
  const elements$ = elements;
  elements$.clear();
  const printer$ = printer;
  printer$.init(tree$, content, lf, frontMatterEnd, options, elements$);
  printer$.template(parsedTemplate);
  if (printer$.stack.ranOut()) return FORMAT_NESTED_TOO_DEEPLY;
  const docPrinter$ = docPrinter;
  docPrinter$.init(options, original, out);
  docPrinter$.print(elements$, 0, 0);
  return docPrinter$.result();
}
