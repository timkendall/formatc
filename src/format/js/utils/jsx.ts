// Port of vendor/bun/src/format/js/utils/jsx.rs: what `print/jsx/` and the code around JSX elements share.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { QUOTE_DOUBLE } from "../../options.ts";
import { EXPR_STRING, SP, exprIsJsxText, exprJsxContainerSpan, exprStringValue, exprTag, nameBuf, nameLen, nameStart } from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";

export const WRAP_STATE_NO_WRAP: number = 0;
export const WRAP_STATE_WRAP_ON_BREAK: number = 1;
/** Nothing else is white space in JSX. */
export function isJsxWhitespace(byte: number): boolean {
  return byte === 32 || byte === 10 || byte === 9 || byte === 13;
}

export function hasLineBreak(text: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const b = text[i] | 0;
    if (b === 10 || b === 13) return true;
  }
  return false;
}

/** Prettier's `isMeaningfulJsxText`: it is not only white space with a line break in it. */
export function isMeaningfulJsxText(text: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (!isJsxWhitespace(text[i] | 0)) return true;
  return !hasLineBreak(text, start, end);
}
const RAW_SPACE_DOUBLE = token('{" "}');
const RAW_SPACE_SINGLE = token("{' '}");

/** `{" "}`. `child`: what is in the braces. */
export function isWhitespaceJsxExpression(child: number, f: Formatter): boolean {
  if (exprTag(child) !== EXPR_STRING) return false;
  const value = exprStringValue(child);
  if (value < 0 || nameLen(value) !== 1 || (nameBuf(value)[nameStart(value)] | 0) !== 32) return false;
  if (exprIsJsxText(child)) return false;
  if (!exprJsxContainerSpan(child)) return false;
  const SP$ = SP;
  return !cxOf(f).comments.hasCommentInRange(SP$.s0 | 0, SP$.s1 | 0);
}

/** A space between children. At the end of a line it has to be written as `{" "}`. */
export function fmtJsxSpace(f: Formatter): void {
  f.startIfGroupBreaks();
  fmtJsxRawSpace(f);
  f.softLineBreak();
  f.endConditional();
  f.startIfGroupFits();
  f.space();
  f.endConditional();
}

/** `{" "}` */
export function fmtJsxRawSpace(f: Formatter): void {
  f.token(f.options.quoteStyle === QUOTE_DOUBLE ? RAW_SPACE_DOUBLE : RAW_SPACE_SINGLE);
}
