// Port of vendor/bun/src/format/js/print/array_element_list.rs: `ArrayElementList::new(array, elements, group_id)` + `fmt`; `can_concisely_print_array_list`.
import { Formatter } from "../../ir/formatter.ts";
import { COMMA } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT, FTC_ES5, trailingSeparator } from "../../options.ts";
import { EXPR_NUMBER, EXPR_UNARY, SP, UN_MINUS, UN_PLUS, exprOperand, exprSpan, exprTag, exprUnaryOpOf, listAt } from "../../../lint/ast/index.ts";
import { exprAsAstNodes } from "../ast_nodes.ts";
import { writeSeparatorAfter } from "../builders.ts";
import { cxOf } from "../context.ts";
import { WK_EXPR, fmtExpr, writeTrailingCommentsOf } from "../format.ts";
import { formatLeadingComments } from "../trivia.ts";
import { isLineAfterElementEmpty, writeArrayNode } from "../utils/array.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";

/** `[1,⏎/* comment *&#47;⏎2]`: for oxfmt the comment stays on its line, for Prettier it is behind the `1,`. */
function blockCommentThatEndsLineStartsOne(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** The elements of the array literal `array`. */
export function fmtArrayElementList(array: number, elementsStart: number, elementsLen: number, groupId: number, f: Formatter): void {
  exprSpan(array);
  const arrayStart = SP[0] | 0;
  const arrayEnd = SP[1] | 0;
  if (!canConciselyPrintArrayList(arrayStart, arrayEnd, elementsStart, elementsLen, f)) {
    // One per line, if they do not fit on one line.
    writeArrayNode(elementsLen, WK_EXPR, elementsStart, elementsLen, f);
    return;
  }

  // As many on each line as fit.
  const cx = cxOf(f);
  const cm = cx.comments;
  const separator = trailingSeparator(FTC_ES5, f.options);
  // A comment on a line of its own after the last element is written after the fill: what forces a line break in an item of a fill puts the item on a
  // line of its own.
  const last = listAt(elementsStart, elementsLen - 1);
  let lastWithOwnLineComment = -1;
  if (!cx.isQuiet) {
    exprSpan(last);
    const n = cm.commentsIn(SP[1] | 0, arrayEnd);
    if (n > 0 && cm.precededByNewline(cm.from)) lastWithOwnLineComment = last;
  }
  const oxfmt = blockCommentThatEndsLineStartsOne(f);
  const text = f.source;
  f.startFill();
  let previousEnd = 0;
  for (let i = 0; i < elementsLen; i++) {
    const element = listAt(elementsStart, i);
    exprSpan(element);
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    if (i > 0) {
      f.startEntry();
      if (isLineAfterElementEmpty(text, previousEnd)) f.emptyLine();
      else {
        let breaks = false;
        const n = cm.commentsBefore(start);
        const from = cm.from;
        for (let k = 0; k < n; k++) {
          const c = (from + k) | 0;
          if (oxfmt ? cm.followedByNewline(c) : cm.isLine(c)) {
            breaks = true;
            break;
          }
        }
        if (breaks) f.hardLineBreak();
        else f.softLineBreakOrSpace();
      }
      f.endEntry();
    }
    f.startEntry();
    if (lastWithOwnLineComment === element) {
      // FormatNodeWithoutTrailingComments(&element) of the element with its separator: a node whose trailing comment suppresses it gets no separator.
      if (cx.isQuiet) {
        fmtExpr(element, f);
        writeSeparatorAfter(f, COMMA, i === elementsLen - 1, separator, groupId);
      } else if (cm.hasTrailingSuppressionComment(end)) {
        formatLeadingComments(start, end, f);
        writeSuppressedNode(start, end, f);
      } else {
        // The comments after the node are hidden while it is written.
        const previousLimit = cm.limitCommentsUpTo(end);
        fmtExpr(element, f);
        cm.restoreViewLimit(previousLimit);
        writeSeparatorAfter(f, COMMA, i === elementsLen - 1, separator, groupId);
      }
    } else {
      fmtExpr(element, f);
      writeSeparatorAfter(f, COMMA, i === elementsLen - 1, separator, groupId);
    }
    f.endEntry();
    previousEnd = end;
  }
  f.endFill();
  if (lastWithOwnLineComment >= 0) writeTrailingCommentsOf(exprAsAstNodes(lastWithOwnLineComment), f);
}

/** Prettier's `isConciselyPrintedArray`: all elements are numbers, with or without a sign. */
export function canConciselyPrintArrayList(arrayStart: number, arrayEnd: number, listStart: number, listLen: number, f: Formatter): boolean {
  if (listLen === 0) return false;
  const cm = cxOf(f).comments;
  // The unprinted comments before the end of the array.
  const count = cm.commentsBefore(arrayEnd);
  const from = cm.from;
  const to = (from + count) | 0;
  let next = from;
  for (let i = 0; i < listLen; i++) {
    const item = listAt(listStart, i);
    const t = exprTag(item);
    if (t === EXPR_NUMBER) continue;
    if (t === EXPR_UNARY) {
      const op = exprUnaryOpOf(item);
      if ((op === UN_PLUS || op === UN_MINUS) && exprTag(exprOperand(item)) === EXPR_NUMBER) {
        // `-(/* comment */ 1)`
        exprSpan(item);
        const s = SP[0] | 0;
        const e = SP[1] | 0;
        while (next < to && (cm.spanStart[next] | 0) <= s) next = (next + 1) | 0;
        if (next < to && s <= (cm.spanStart[next] | 0) && (cm.spanEnd[next] | 0) <= e) return false;
        continue;
      }
    }
    return false;
  }

  // Not with a line comment behind an element.
  const first = listAt(listStart, 0);
  exprSpan(first);
  const firstStart = SP[0] | 0;
  for (let i = from; i < to; i++) {
    if (cm.isLine(i) && !cm.precededByNewline(i) && (cm.spanStart[i] | 0) > firstStart) return false;
  }
  void arrayStart;
  return true;
}
