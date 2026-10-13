// Port of vendor/bun/src/format/js/mod.rs (+ `write_document` / `format_with_marks` of ir/run.rs): JavaScript, JSX and TypeScript.
//
// The entry: `formatFile(text, options, out)` formats the file that has just been parsed and bound (`parseFile` + `fileBegin`, see
// src/driver/dispatch.ts) and appends the text to `out`. `text` is the source (exactly: `hir.text.subarray(0, hir.sourceLen)`).
//
// Everything the formatter reads is per thread: the HIR and the handles (src/lint/ast), the IR (`Scratch`), the comments and the
// context (`JsFormatContext`).
import { ByteBuf } from "../../base/bytebuf.ts";
import { FORMAT_SYNTAX_ERROR, FORMAT_TOO_LONG } from "../errors.ts";
import { FormatOptions } from "../options.ts";
import { Scratch, finishAndPrint, startDocument } from "../ir/run.ts";
import { Formatter } from "../ir/formatter.ts";
import { fileHasParseErrors, hir } from "../../lint/ast/index.ts";
import { AN_MAX_ROWS } from "./ast_nodes.ts";
import { collectComments } from "./comments.ts";
import type { JsFormatContext } from "./context.ts";
import { newContext } from "./context.ts";
import { writeProgram } from "./print/program.ts";
import type { CursorRegion } from "../cursor_region.ts";
import { trimInfo } from "./state.ts";
import { prepareJsdoc } from "./jsdoc/mod.ts";

/** Rust `format_file(file, f)`: writes the document of the file. */
export function formatFile(f: Formatter): void {
  writeProgram(f);
}

class Thread {
  scratch: Scratch | null = null;
  cx: JsFormatContext | null = null;
}
const thread = new Thread();

/** Whether a table of the HIR has more rows than `AstNodes` can name. */
function hasTooManyNodes(): boolean {
  return (
    hir.nExprs >= AN_MAX_ROWS ||
    hir.nStmts >= AN_MAX_ROWS ||
    hir.nTypes >= AN_MAX_ROWS ||
    hir.nFns >= AN_MAX_ROWS ||
    hir.nProps >= AN_MAX_ROWS ||
    hir.nMembers >= AN_MAX_ROWS ||
    hir.nPats >= AN_MAX_ROWS ||
    hir.nParams >= AN_MAX_ROWS ||
    hir.nVarDecls >= AN_MAX_ROWS ||
    hir.nCases >= AN_MAX_ROWS ||
    hir.nPatProps >= AN_MAX_ROWS ||
    hir.nPatElems >= AN_MAX_ROWS ||
    hir.nTupleElems >= AN_MAX_ROWS ||
    hir.nTypeParams >= AN_MAX_ROWS ||
    hir.nClasses >= AN_MAX_ROWS ||
    hir.nEnumMembers >= AN_MAX_ROWS ||
    hir.nImportSpecs >= AN_MAX_ROWS ||
    hir.nExportSpecs >= AN_MAX_ROWS
  );
}

/**
 * Appends to `out` the formatted text of the file that was parsed last, whose text is `text`. `alignment`: the document is indented by so
 * many columns more (range formatting, Prettier's `addAlignmentToDoc`); the blanks at both ends of what is printed go and a line break
 * ends it. Returns a `FORMAT_*` code.
 */
export function formatDocument(text: Uint8Array, options: FormatOptions, out: ByteBuf, alignment: number, cursor: CursorRegion): number {
  if (fileHasParseErrors()) return FORMAT_SYNTAX_ERROR;
  if (hasTooManyNodes()) return FORMAT_TOO_LONG;
  // oxfmt's `jsdoc`: the comments are formatted before the document is started (jsdoc/mod.ts says why); `text` may be a copy.
  text = prepareJsdoc(text, options);
  let scratch = thread.scratch;
  if (scratch === null) {
    scratch = new Scratch(options);
    thread.scratch = scratch;
  }
  let cx = thread.cx;
  if (cx === null) {
    cx = newContext(options, cursor);
    thread.cx = cx;
  }
  cx.reset(options, text, cursor);
  collectComments(cx.comments, text, options.flavor, cx.hasTreeOfBabel);
  const f = startDocument(scratch, text, options, cx);
  cx.formatter = f;
  if (alignment > 0) writeAligned(alignment, f);
  else formatFile(f);
  const start = out.len;
  const status = finishAndPrint(f, out);
  if (status !== 0 || alignment <= 0) return status;
  // Of what is printed, the blanks at both ends are left out, and a line break ends it.
  const data = out.data;
  let begin = start;
  let end = out.len;
  while (begin < end && isAsciiWhitespace(data[begin] | 0)) begin = begin + 1;
  while (end > begin && isAsciiWhitespace(data[end - 1] | 0)) end = end - 1;
  out.data.copyWithin(start, begin, end);
  trimInfo.leading = begin - start;
  trimInfo.end = end - start;
  out.len = start + (end - begin);
  out.push(10);
  return status;
}

function isAsciiWhitespace(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 12 || b === 13;
}

/** Writes the document so that every line is indented by `alignment` columns more. Prettier's `addAlignmentToDoc`. */
function writeAligned(alignment: number, f: Formatter): void {
  const tabWidth = f.options.indentWidth > 1 ? f.options.indentWidth : 1;
  const levels = (alignment / tabWidth) | 0;
  const spaces = alignment % tabWidth;
  f.startAlign(spaces);
  for (let i = 0; i < levels; i++) f.startIndent();
  // It makes the indentation count for the first line, and is trimmed from the result.
  f.hardLineBreak();
  formatFile(f);
  for (let i = 0; i < levels; i++) f.endIndent();
  f.endAlign(spaces);
}


/** For tests: how many comments the last `formatDocument` left unprinted. */
export function unprintedComments(): number {
  const cx = thread.cx;
  if (cx === null) return 0;
  const cm = cx.comments;
  return (cm.n - cm.printedCount) | 0;
}
