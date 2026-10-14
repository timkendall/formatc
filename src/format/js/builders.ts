// Port of vendor/bun/src/format/js/builders.rs: builders that know about source positions: lists of nodes that keep the empty lines
// between them, and lists with separators.
//
// Rust's builders are objects that are fed entries. Here they are a loop in the caller and these functions:
//
//     // f.join_nodes_with_hardline().entry(span, &x).entry(span, &y).finish()
//     let hasElements = false;
//     for (...) {
//       if (hasElements) joinNodesSeparator(f, JOIN_HARDLINE, start, end);   // `separator_no_entry(span)`: an empty line or the separator
//       hasElements = true;
//       writeX(...);
//     }
//
//     // entries_with_trailing_separator(entries, ",", trailing_separator)  (FormatSeparatedIter)
//     for (i = 0; i < n; i++) {
//       write the entry;
//       writeSeparatorAfter(f, COMMA, i === n - 1, trailingSeparator, groupId /* 0: the enclosing group */);
//     }
import { Formatter } from "../ir/formatter.ts";
import { LM_SOFT, T_START_GROUP, T_START_INDENT, E_LINE } from "../ir/element.ts";
import {
  FLAVOR_OXFMT,
  TRAILING_SEPARATOR_ALLOWED,
  TRAILING_SEPARATOR_MANDATORY,
} from "../options.ts";
import { SP } from "../../lint/ast/index.ts";
import { cxOf } from "./context.ts";
import { nodeSpanOf, writeNode } from "./format.ts";

/** oxfmt sees no empty line in `a: 1\n\n, b: 2`. */
function commaEndsTheSearchForLineBreaks(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** The number of line breaks before the node at `(start, end)`, or before the comments that lead up to it. */
export function linesBefore(start: number, end: number, f: Formatter): number {
  const cx = cxOf(f);
  let cs = -1;
  let ce = -1;
  const SP$ = SP;
  if (cx.comments.firstUnprintedSpan()) {
    cs = SP$.s0 | 0;
    ce = SP$.s1 | 0;
  }
  return cx.src.getLinesBefore(start, end, cs, ce, !commaEndsTheSearchForLineBreaks(f));
}

/**
 * Whether nothing has been written since the start of a group but what the group starts a line with if it breaks.
 *
 * All that a group with nothing but text in it does is that the printer measures again from there on, as it does from the start of any
 * group. So here such a group makes no difference.
 */
export function isAtStartOfGroup(f: Formatter): boolean {
  const st = f.st;
  const n = st.len;
  let i = n - 1;
  let seen = 0;
  while (i >= 0 && seen < 3) {
    const t = st.tag[i] | 0;
    const isIndentation = t === T_START_INDENT || (t === E_LINE && (st.a[i] | 0) === LM_SOFT);
    if (!isIndentation) return t === T_START_GROUP;
    i = i - 1;
    seen = seen + 1;
  }
  return false;
}

export const JOIN_SOFT_LINE: number = 0;
export const JOIN_HARDLINE: number = 1;
export const JOIN_SPACE: number = 2;

/** The separator of `join_nodes_with_*` itself. */
export function writeJoinSeparator(f: Formatter, separator: number): void {
  if (separator === JOIN_SOFT_LINE) f.softLineBreakOrSpace();
  else if (separator === JOIN_HARDLINE) f.hardLineBreak();
  else f.space();
}

/** Whether there is an empty line before the node at `(start, end)`. */
export function hasLinesBefore(start: number, end: number, f: Formatter): boolean {
  return linesBefore(start, end, f) > 1;
}

/**
 * `JoinNodesBuilder::separator_no_entry(span)` when an entry has been written already: an empty line where the source has one before the
 * node at `(start, end)`, else the separator.
 */
export function joinNodesSeparator(f: Formatter, separator: number, start: number, end: number): void {
  if (hasLinesBefore(start, end, f)) f.emptyLine();
  else writeJoinSeparator(f, separator);
}

/**
 * `FormatSeparatedElement::fmt`'s separator, after an entry: `separator` is a token handle; `isLast`: the entry is the last;
 * `trailingSeparator`: `TRAILING_SEPARATOR_*`; `groupId`: the group that decides whether an allowed trailing separator is written (0: the
 * enclosing one).
 */
export function writeSeparatorAfter(f: Formatter, separator: number, isLast: boolean, trailingSeparator: number, groupId: number): void {
  if (!isLast) {
    f.token(separator);
    return;
  }
  if (trailingSeparator === TRAILING_SEPARATOR_ALLOWED) {
    if (groupId === 0) f.tokenIfBreaks(separator);
    else {
      f.startIfGroupBreaksId(groupId);
      f.token(separator);
      f.endConditional();
    }
  } else if (trailingSeparator === TRAILING_SEPARATOR_MANDATORY) {
    f.token(separator);
  }
}

/**
 * Formats the node `(wk, h)` only to see whether it breaks. The comments in it are not marked as printed. `wk`: a `WK_*` of format.ts
 * (what the Rust code passes as `impl Format + Spanned`).
 */
export function speculateWillBreak(wk: number, h: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  const printed = cm.snapshotPrinted();
  const limit = cm.snapshotLimit();
  nodeSpanOf(wk, h);
  cm.skipCommentsBefore(SP.s0 | 0);
  const slot = f.startCapture();
  writeNode(wk, h, f);
  const handle = f.endCapture(slot);
  const willBreak = handle >= 0 && f.willBreak(handle);
  cm.restore(printed, limit);
  return willBreak;
}
