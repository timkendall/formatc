// Port of vendor/bun/src/format/js/jsdoc/mod.rs: oxfmt's option `jsdoc`: JSDoc comments are formatted the way
// [prettier-plugin-jsdoc](https://github.com/hosseinmd/prettier-plugin-jsdoc) does it.
//
// This follows `oxc_formatter`'s `formatter/jsdoc`, which is under the MIT license. The comments are read by `src/lint/ast/jsdoc.ts`
// (`File::jsdoc`), descriptions are parsed by the parser for Markdown of this crate.
//
// DIFFERENCE FROM THE RUST CODE. Rust formats the code and the types in a comment (`@example`, `{type}`) while it writes the document, with
// a second `Scratch`. Here the HIR, the formatter and its context are one per thread, so a nested format would destroy the file that is being
// written. `prepareJsdoc` therefore formats every JSDoc comment of the file BEFORE the document is started (`formatDocument` calls it), keeps
// the result by the position of the comment, and parses the file again if a nested format has replaced it. `writeComment` writes the result.
import { Stack } from "../../../base/stack.ts";
import { FormatOptions, HTML_ROOT_NONE, HTML_ROOT_PROGRAM, INDENT_TAB } from "../../options.ts";
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { Comments, collectComments } from "../comments.ts";
import { cxOf } from "../context.ts";
import { fileIsJavascript } from "../../../lint/ast/index.ts";
import { jsdocAt, jsdocCommentEnd, jsdocIsAllAsterisks, sourceSlice } from "../../../lint/ast/jsdoc.ts";
import { FJ_EMPTY, FJ_MULTI_LINE, FJ_SINGLE_LINE, FormattedJsdoc, formatJsdocComment } from "./serialize.ts";
import { nested } from "./embedded.ts";

const T_OPEN = token("/**");
const T_LINE_START = token(" *");
const T_SPACE = token(" ");
const T_OPEN_SPACE = token("/** ");
const T_CLOSE = token(" */");

/** What `prepareJsdoc` found for a comment. */
class JsdocResult {
  /** 1: nothing is written; 2: a single line (`lines[0]`); 3: `lines` (one text of lines, or several comments' texts); */
  kind: number;
  texts: string[];
  ranOut: boolean;
  constructor(kind: number, texts: string[], ranOut: boolean) {
    this.kind = kind;
    this.texts = texts;
    this.ranOut = ranOut;
  }
}

class JsdocState {
  results: Map<number, JsdocResult> = new Map<number, JsdocResult>();
  comments: Comments = new Comments();
  /** Parses the file that is being formatted again (nested formats replace the HIR). Set by the caller of the formatter. */
  reparse: ((text: Uint8Array) => boolean) | null = null;
}
const state = new JsdocState();

/** Registers what parses `text` like the file that is formatted was parsed, and does `fileBegin`. null: nothing. */
export function setJsdocReparse(reparse: ((text: Uint8Array) => boolean) | null): void {
  state.reparse = reparse;
}

/**
 * Formats the JSDoc comments of the file that was parsed last, whose text is `text`, if `options.jsdoc` is set. Returns the text to format
 * (`text`, or a copy of it if the file had to be parsed again).
 */
export function prepareJsdoc(text: Uint8Array, options: FormatOptions): Uint8Array {
  if (options.jsdoc === null) return text;
  state.results.clear();
  const jsdocOptions = options.jsdoc;
  let hasDoc = false;
  for (let i = 0; i + 2 < text.length; i++) {
    if ((text[i] | 0) === 47 && (text[i + 1] | 0) === 42 && (text[i + 2] | 0) === 42) {
      hasDoc = true;
      break;
    }
  }
  if (!hasDoc) return text;
  const copy = text.slice();
  const root = options.inHtml.root;
  const cm = state.comments;
  collectComments(cm, copy, options.flavor, fileIsJavascript() || (root !== HTML_ROOT_NONE && root !== HTML_ROOT_PROGRAM));
  // The comments are copied: the nested formats replace them.
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < cm.n; i++) {
    if (cm.isLine(i)) continue;
    starts.push(cm.spanStart[i] | 0);
    ends.push(cm.spanEnd[i] | 0);
  }
  const reparse = state.reparse;
  if (reparse === null) return text;
  nested.restore = (): boolean => reparse(copy);
  nested.dirty = false;
  for (let k = 0; k < starts.length; k++) {
    const result = formatComment(copy, starts[k], ends[k], options, jsdocOptions);
    if (result !== null) state.results.set(starts[k], result);
  }
  nested.restore = null;
  return nested.dirty ? copy : text;
}

/** `write_formatted` without the writing. */
function formatComment(text: Uint8Array, start: number, end: number, options: FormatOptions, jsdocOptions: import("../../options.ts").JsdocOptions): JsdocResult | null {
  if (!((text[start] | 0) === 47 && start + 2 < text.length && (text[start + 1] | 0) === 42 && (text[start + 2] | 0) === 42)) return null;
  // `/*****/` is none.
  const first = jsdocAt(start);
  if (first < 0 || jsdocIsAllAsterisks(first)) return null;
  let indent = 0;
  for (let i = start - 1; i >= 0; i--) {
    const b = text[i] | 0;
    if (b === 32) indent = indent + 1;
    else if (b === 9) indent = indent + options.indentWidth;
    else break;
  }
  const lineWidth = options.lineWidth;
  const availableWidth = lineWidth > indent ? lineWidth - indent : 0;
  const stack = Stack.forTree();

  // Comments that directly follow each other have been made one. Each is formatted by itself, and they go on following each other directly
  // if each has several lines.
  if (jsdocCommentEnd(first) < end) {
    const formatted: string[] = [];
    let at = start;
    while (at < end) {
      const doc = jsdocAt(at);
      if (doc < 0) return null;
      const f = formatChecked(doc, jsdocOptions, options, availableWidth, stack);
      if (f !== null && f.kind === FJ_MULTI_LINE) formatted.push(f.text);
      else return null;
      at = jsdocCommentEnd(doc);
    }
    return new JsdocResult(3, formatted, stack.ranOut());
  }

  const f = formatChecked(first, jsdocOptions, options, availableWidth, stack);
  if (f === null) return null;
  if (f.kind === FJ_EMPTY) return new JsdocResult(1, [], stack.ranOut());
  if (f.kind === FJ_SINGLE_LINE) return new JsdocResult(2, [f.text], stack.ranOut());
  return new JsdocResult(3, [f.text], stack.ranOut());
}

/** An escape or a blank that is gone would end the comment early. */
function formatChecked(doc: number, jsdocOptions: import("../../options.ts").JsdocOptions, options: FormatOptions, availableWidth: number, stack: Stack): FormattedJsdoc | null {
  const f = formatJsdocComment(doc, jsdocOptions, options, availableWidth, stack);
  if (f === null) return null;
  if ((f.kind === FJ_SINGLE_LINE || f.kind === FJ_MULTI_LINE) && f.text.indexOf("*/") >= 0) return null;
  return f;
}

function writeLines(lines: string, f: Formatter): void {
  f.token(T_OPEN);
  const parts = lines.split("\n");
  for (let i = 0; i < parts.length; i++) {
    f.hardLineBreak();
    f.token(T_LINE_START);
    if (parts[i].length > 0) {
      f.token(T_SPACE);
      f.textStr(parts[i]);
    }
  }
  f.hardLineBreak();
  f.token(T_CLOSE);
}

/** Writes the comment `commentIndex` formatted as JSDoc, if the option is on and it is one. Returns whether it has. */
export function writeComment(commentIndex: number, f: Formatter): boolean {
  if (f.options.jsdoc === null || state.results.size === 0) return false;
  const cx = cxOf(f);
  const result = state.results.get(cx.comments.spanStart[commentIndex] | 0);
  if (result === undefined) return false;
  if (result.ranOut) cx.ranOutOfStack = true;
  if (result.kind === 1) return true;
  if (result.kind === 2) {
    f.token(T_OPEN_SPACE);
    f.textStr(result.texts[0]);
    f.token(T_CLOSE);
    return true;
  }
  for (let i = 0; i < result.texts.length; i++) writeLines(result.texts[i], f);
  return true;
}

void INDENT_TAB;
void sourceSlice;
