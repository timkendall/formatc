// Port of vendor/bun/src/format/yaml/mod.rs. YAML: Prettier's `language-yaml` and the tree of `yaml-unist-parser`, which is
// made of what Bun's parser reads.
//
//   formatYaml(src, len, options, out): FORMAT_* code        (`format(text, options, out)` for a whole `Uint8Array`)
//   yamlDocument(src, len, options): Doc handle | -FORMAT_*  (`document`: the front matter of style sheets and Markdown)
//   isYamlPath(path): boolean
//
// - `src[0, len)` is the text of the file (a byte order mark and the line endings are part of it). The formatted text is
//   appended to `out`; on an error `out` is as it was.
// - `FORMAT_SYNTAX_ERROR_AT`: the words and the place are `refusalMessage()` / `refusalOffset()` (`../syntax_error.ts`),
//   the offset counts bytes of the text without a byte order mark and before `\r\n` became `\n`.
// - `yamlDocument` expects a text whose line breaks are `\n`. It returns the handle of a `Doc` (made in the pool of the
//   caller's epoch: do not `docPop` it), or `-FORMAT_*` (`-2`: syntax error, see above; `-3`: nested too deeply).
import { ByteBuf } from "../../base/bytebuf.ts";
import { byteOffsetOfUtf16, utf16Len } from "../../base/utf8.ts";
import { yamlErrorPos, yamlParseAsWritten } from "../../parsers/yaml.ts";
import {
  PE_INVALID_DIRECTIVE,
  PE_MULTILINE_IMPLICIT_KEY,
  PE_MULTIPLE_ANCHORS,
  PE_MULTIPLE_TAGS,
  PE_MULTIPLE_YAML_DIRECTIVES,
  PE_OUT_OF_MEMORY,
  PE_STACK_OVERFLOW,
  PE_TAB_INDENTATION,
  PE_UNEXPECTED_CHARACTER,
  PE_UNEXPECTED_DOCUMENT_END,
  PE_UNEXPECTED_DOCUMENT_START,
  PE_UNEXPECTED_EOF,
  PE_UNRESOLVED_TAG_HANDLE,
} from "../../parsers/yaml.ts";
import {
  Elements,
  Printer,
  docPop,
  docPush,
  printDoc,
  replaceEndOfLineWithLiteralLines,
} from "../css/doc.ts";
import {
  FORMAT_NESTED_TOO_DEEPLY,
  FORMAT_OK,
  FORMAT_SYNTAX_ERROR_AT,
} from "../errors.ts";
import { FLAVOR_OXFMT, FormatOptions, QUOTE_SINGLE, TRAILING_COMMAS_NONE } from "../options.ts";
import { PARSER_JSON, formatJson } from "../json/mod.ts";
import {
  MSG_INVALID_DIRECTIVE,
  MSG_INVALID_TAG,
  MSG_KEY_OVER_SEVERAL_LINES,
  MSG_REPEATED_PROPERTY,
  MSG_TAB_AS_INDENTATION,
  MSG_TOO_LARGE,
  MSG_UNCLOSED_STRING,
  MSG_UNEXPECTED_CHARACTER,
  MSG_UNEXPECTED_END,
  MSG_UNEXPECTED_TOKEN,
  noteRefusal,
  refusalMessage,
  refusalOffset,
} from "../syntax_error.ts";
import { hasPragmaInHashComment, startsWithBom } from "../text.ts";
import { build, treeStack } from "./ast.ts";
import { printTree, setup } from "./printer.ts";

/** What can be used again for the next file. */
const elements = new Elements();
const documentElements = new Elements();
const printer = new Printer();
const withoutNul = new ByteBuf(1024);
const normalized = new ByteBuf(1024);
const withPragma = new ByteBuf(1024);

// Bytes that need a closer look: NUL (1), CR (2)
const SPECIAL = new Uint8Array(256);
SPECIAL[0] = 1;
SPECIAL[13] = 2;

/** 1: there is a NUL in text[0, len), 2: there is a CR, 3: both */
function scanSpecial(text: Uint8Array): number {
  const n = text.length;
  const t = SPECIAL;
  let acc = 0;
  for (let i = 0; i < n; i++) acc = acc | (t[text[i] | 0] | 0);
  return acc;
}

const EXTENSIONS: string[] = [
  ".yml",
  ".mir",
  ".reek",
  ".rviz",
  ".sublime-syntax",
  ".syntax",
  ".yaml",
  ".yaml-tmlanguage",
  ".yaml.sed",
  ".yml.mysql",
];
const NAMES: string[] = [
  ".clang-format",
  ".clang-tidy",
  ".clangd",
  ".gemrc",
  "citation.cff",
  "glide.lock",
  "pixi.lock",
  ".prettierrc",
  ".stylelintrc",
  ".lintstagedrc",
];

function fileName(path: string): string {
  let i = path.length;
  while (i > 0) {
    const c = path.charCodeAt(i - 1);
    if (c === 47 || c === 92) break;
    i = i - 1;
  }
  return path.substring(i);
}

/** Whether Prettier takes the file at `path` for YAML. */
export function isYamlPath(path: string): boolean {
  // Prettier's `getLanguageByFileName` compares the name in lower case.
  const name = fileName(path).toLowerCase();
  for (let i = 0; i < NAMES.length; i++) {
    if (name === NAMES[i]) return true;
  }
  for (let i = 0; i < EXTENSIONS.length; i++) {
    if (name.endsWith(EXTENSIONS[i])) return true;
  }
  return false;
}

/** What Bun's parser refuses at the byte `at`. */
function refusal(error: number, at: number): number {
  let message = MSG_UNEXPECTED_TOKEN;
  switch (error) {
    case PE_STACK_OVERFLOW:
      return FORMAT_NESTED_TOO_DEEPLY;
    case PE_OUT_OF_MEMORY:
      message = MSG_TOO_LARGE;
      break;
    case PE_UNEXPECTED_EOF:
      message = MSG_UNEXPECTED_END;
      break;
    case PE_UNEXPECTED_CHARACTER:
      message = MSG_UNEXPECTED_CHARACTER;
      break;
    case PE_TAB_INDENTATION:
      message = MSG_TAB_AS_INDENTATION;
      break;
    case PE_INVALID_DIRECTIVE:
    case PE_MULTIPLE_YAML_DIRECTIVES:
      message = MSG_INVALID_DIRECTIVE;
      break;
    case PE_UNRESOLVED_TAG_HANDLE:
      message = MSG_INVALID_TAG;
      break;
    case PE_MULTILINE_IMPLICIT_KEY:
      message = MSG_KEY_OVER_SEVERAL_LINES;
      break;
    case PE_MULTIPLE_ANCHORS:
    case PE_MULTIPLE_TAGS:
      message = MSG_REPEATED_PROPERTY;
      break;
    case PE_UNEXPECTED_DOCUMENT_START:
    case PE_UNEXPECTED_DOCUMENT_END:
      message = MSG_UNCLOSED_STRING;
      break;
    default:
      break;
  }
  noteRefusal(message, at);
  return FORMAT_SYNTAX_ERROR_AT;
}

/** Writes the document for `text` (exactly the bytes of the file, whose line breaks are `\n`) to `els`, which is empty.
 * Returns a `FORMAT_*` code. */
function writeDocument(text: Uint8Array, options: FormatOptions, els: Elements, hasNul: boolean): number {
  const len = text.length;
  const treeStack$ = treeStack;
  treeStack$.reset();
  // For `yaml`, U+0000 is a character like another.
  let parseText = text;
  const withoutNul$ = withoutNul;
  if (hasNul) {
    withoutNul$.reset();
    withoutNul$.reserve(len);
    for (let i = 0; i < len; i++) {
      const b = text[i] | 0;
      withoutNul$.push(b === 0 ? 1 : b);
    }
    parseText = withoutNul$.data;
  }
  const error = yamlParseAsWritten(parseText, len);
  if (error !== 0) {
    const pos = yamlErrorPos();
    return refusal(error, pos < len ? pos : len);
  }
  if (build(text, len) !== 0) {
    // Whatever else is said to be wrong where the stack has run out.
    return treeStack$.ranOut() ? FORMAT_NESTED_TOO_DEEPLY : FORMAT_SYNTAX_ERROR_AT;
  }
  const oxfmt = options.flavor === FLAVOR_OXFMT;
  // Without indentation there is no structure, so for oxfmt there is some.
  const tab = options.indentWidth > (oxfmt ? 1 : 0) ? options.indentWidth : oxfmt ? 1 : 0;
  setup(
    els,
    text,
    len,
    options.proseWrap,
    options.quoteStyle === QUOTE_SINGLE,
    options.bracketSpacing,
    options.trailingCommas !== TRAILING_COMMAS_NONE,
    tab,
    oxfmt,
  );
  const fits = printTree();
  return fits ? FORMAT_OK : FORMAT_NESTED_TOO_DEEPLY;
}

/** The document for src[0, len), whose line breaks are `\n`, as a tree. A `Doc` handle, or `-FORMAT_*`. */
export function yamlDocument(src: Uint8Array, len: number, options: FormatOptions): number {
  const documentElements$ = documentElements;
  documentElements$.clear();
  const text = len === src.length ? src : src.subarray(0, len);
  const r = writeDocument(text, options, documentElements$, (scanSpecial(text) & 1) !== 0);
  if (r !== FORMAT_OK) return -r;
  const doc = documentElements$.toTree();
  return doc < 0 ? -FORMAT_NESTED_TOO_DEEPLY : doc;
}

/** `/(?:[/\\]|^)\.(?:prettier|stylelint|lintstaged)rc$/`: a file that Prettier first tries to format as JSON. */
function canBeJson(path: string): boolean {
  const name = fileName(path);
  return name === ".prettierrc" || name === ".stylelintrc" || name === ".lintstagedrc";
}

/** Prettier's `offsetToUtf16`-free half of `normalizeInputAndOptions`: the byte offset in `original` of the UTF-16 index, or
 * -1 if there is none (the text is shorter, or the offset is before `first`). */
function offsetOf(original: Uint8Array, index: number, first: number): number {
  if (index < 0) return -1;
  const n = original.length;
  if (index > utf16Len(original, 0, n)) return -1;
  let at = byteOffsetOfUtf16(original, 0, n, index);
  // After `\r\n` has become `\n`, an offset between the two is behind it.
  if (at >= 1 && at < n && (original[at - 1] | 0) === 13 && (original[at] | 0) === 10) at = at + 1;
  return at >= first ? at : -1;
}

function isAsciiBlank(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 12 || b === 13;
}

/** Appends the formatted src[0, len) to `out`. `options.filepath` says whether it can be JSON. Returns a `FORMAT_*` code. */
export function formatYaml(src: Uint8Array, len: number, options: FormatOptions, out: ByteBuf): number {
  const original = len === src.length ? src : src.subarray(0, len);
  const hasBom = startsWithBom(original, 0);
  const first = hasBom ? 3 : 0;
  const textNoBom = hasBom ? original.subarray(3) : original;
  // Prettier's `normalizeInputAndOptions`: the offsets count UTF-16 code units of `original`.
  let start = first;
  let end = original.length;
  if (options.rangeStart >= 0) {
    const o = offsetOf(original, options.rangeStart, first);
    if (o >= 0) start = o;
  }
  if (options.rangeEnd >= 0) {
    const o = offsetOf(original, options.rangeEnd, first);
    if (o >= 0) end = o;
  }
  // `\r\n` is `\n`
  const special = scanSpecial(textNoBom);
  const hasCr = (special & 2) !== 0;
  let text = textNoBom;
  const normalized$ = normalized;
  if (hasCr) {
    const n = textNoBom.length;
    normalized$.reset();
    normalized$.reserve(n);
    let runStart = 0;
    for (let i = 0; i < n; i++) {
      if ((textNoBom[i] | 0) === 13) {
        normalized$.append(textNoBom, runStart, i);
        normalized$.push(10);
        if (i + 1 < n && (textNoBom[i + 1] | 0) === 10) i = i + 1;
        runStart = i + 1;
      }
    }
    normalized$.append(textNoBom, runStart, n);
    text = normalized$.view();
  }
  if (
    (start >= end && text.length > 0) ||
    (options.requirePragma && !hasPragmaInHashComment(text, "format", "prettier")) ||
    (options.checkIgnorePragma && hasPragmaInHashComment(text, "noformat", "noprettier"))
  ) {
    out.append(original, 0, original.length);
    return FORMAT_OK;
  }
  // Nothing in YAML is something that Prettier formats on its own.
  const isRange = start > first || end < original.length;
  const withPragma$ = withPragma;
  if (options.insertPragma && !options.requirePragma && !isRange && !hasPragmaInHashComment(text, "format", "prettier")) {
    withPragma$.reset();
    withPragma$.appendAscii("# @format\n\n");
    withPragma$.append(text, 0, text.length);
    text = withPragma$.view();
  }
  const outStart = out.len;
  if (hasBom) {
    out.push(0xef);
    out.push(0xbb);
    out.push(0xbf);
  }
  let blank = true;
  for (let i = 0; i < text.length; i++) {
    if (!isAsciiBlank(text[i] | 0)) {
      blank = false;
      break;
    }
  }
  if (blank) return FORMAT_OK;
  // It has to be YAML in any case.
  const elements$ = elements;
  elements$.clear();
  const r = writeDocument(text, options, elements$, (special & 1) !== 0);
  if (r !== FORMAT_OK) {
    out.truncate(outStart);
    if (r === FORMAT_SYNTAX_ERROR_AT) {
      // The offset is in what `normalizeEndOfLine` made; the caller has the text as it is.
      const mapped = hasCr ? mapOffsetBack(textNoBom, refusalOffset()) : refusalOffset();
      noteRefusal(refusalMessage(), mapped);
    }
    return r;
  }
  if (isRange) {
    docPush();
    const doc = replaceEndOfLineWithLiteralLines(text, 0, text.length);
    const rr = printDoc(doc, options, original, out);
    docPop();
    return rr;
  }
  if (options.filepath.length > 0 && canBeJson(options.filepath)) {
    const jsonEnd = out.len;
    if (formatJson(text, text.length, PARSER_JSON, options, out) === FORMAT_OK) return FORMAT_OK;
    out.truncate(jsonEnd);
  }
  const printer$ = printer;
  printer$.init(options, original, out);
  printer$.print(elements$, 0, 0);
  return printer$.result();
}

/** `SyntaxError::before_normalizing_end_of_line` of `original`, which has `\r`. */
function mapOffsetBack(original: Uint8Array, offset: number): number {
  let left = offset;
  let at = 0;
  const n = original.length;
  while (left > 0 && at < n) {
    at = at + ((original[at] | 0) === 13 && at + 1 < n && (original[at + 1] | 0) === 10 ? 2 : 1);
    left = left - 1;
  }
  return at;
}

/** `format(text, options, out)` for the whole `text`. */
export function format(text: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  return formatYaml(text, text.length, options, out);
}
