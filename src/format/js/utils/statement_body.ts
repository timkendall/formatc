// Port of vendor/bun/src/format/js/utils/statement_body.rs.
import { Formatter } from "../../ir/formatter.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  SP,
  STMT_EMPTY,
  STMT_RETURN,
  STMT_THROW,
  stmtIfNo,
  stmtIfYes,
  stmtIsBlock,
  stmtSpan,
  stmtTag,
} from "../../../lint/ast/index.ts";
import { AN_IF_STATEMENT, anId, anTag, stmtAstParent } from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { fmtStmt, WK_STMT } from "../format.ts";
import { commentsStayBetweenHeadAndBody, formatLeadingComments, formatTrailingCommentsRange, writeHeadBodySeparator } from "../trivia.ts";
import { fmtNodeWithoutTrailingComments } from "./format_node_without_trailing_comments.ts";

/**
 * `FormatStatementBody::new(body).with_forced_space(forced)`. Prettier's `printClause`: the body of an `if`, an `else`, a loop or a `with`.
 * After a space if it is a block, otherwise on the next line if it does not fit.
 *
 * The comments between the head of the statement and the body lead the body.
 */
export function fmtStatementBody(body: number, forcedSpace: boolean, f: Formatter): void {
  const cx = cxOf(f);
  const tag = stmtTag(body);
  const isEmpty = tag === STMT_EMPTY;
  const isBlock = stmtIsBlock(body);
  stmtSpan(body);
  const SP$ = SP;
  const bodyStart = SP$.s0 | 0;
  const bodyEnd = SP$.s1 | 0;
  const cm = cx.comments;
  if (commentsStayBetweenHeadAndBody(f) && (isEmpty || isBlock)) {
    if (!isEmpty || cm.hasCommentBefore(bodyStart)) writeHeadBodySeparator(bodyStart, f);
    writeBodyAndItsComments(body, f);
    return;
  }
  if (isEmpty) {
    // Not `is_quiet`: to the statement that this is the body of, a `;` at its end and the comments before that are not part of it.
    f.maybeSpace(cm.hasCommentBefore(bodyStart));
    formatLeadingComments(bodyStart, bodyEnd, f);
    writeBodyAndItsComments(body, f);
    return;
  }

  let first = -1;
  if (!cx.isQuiet && cm.commentsBefore(bodyStart) > 0) first = cm.from;
  // Prettier's `shouldPrintLeadingHardline`
  if (first >= 0 && (cm.isMultilineBlock(first) || cm.precededByNewline(first))) {
    if (isBlock) {
      f.hardLineBreak();
      writeBodyAndItsComments(body, f);
    } else {
      f.startIndent();
      f.hardLineBreak();
      writeBodyAndItsComments(body, f);
      f.endIndent();
    }
  } else if (isBlock || forcedSpace) {
    f.space();
    writeBodyAndItsComments(body, f);
  } else {
    if (hasLineCommentBeforeSemicolon(body, f)) f.expandParent();
    f.startSoftLineIndentOrSpace();
    writeBodyAndItsComments(body, f);
    f.endSoftLineIndentOrSpace();
  }
}

function isAsciiBlank(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 12 || b === 13;
}

/**
 * `if (a) b() // comment⏎;[c].d()`: the `;` ends `b()`, so the comment is in the statement. oxfmt writes it behind the `;`, and what it is in
 * breaks. Not after `return` and `throw`, which write such a comment themselves.
 */
function hasLineCommentBeforeSemicolon(body: number, f: Formatter): boolean {
  if (f.options.flavor !== FLAVOR_OXFMT) return false;
  const cx = cxOf(f);
  if (cx.isQuiet) return false;
  const tag = stmtTag(body);
  if (tag === STMT_RETURN || tag === STMT_THROW) return false;
  stmtSpan(body);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const spanEnd = SP$.s1 | 0;
  let end = spanEnd > 0 ? spanEnd - 1 : 0;
  const text = cx.src.text;
  if (!(end < spanEnd && end < text.length && (text[end] | 0) === 59)) return false;
  const cm = cx.comments;
  cm.commentsIn(start, spanEnd);
  const from = cm.from;
  const to = cm.to;
  for (let i = to - 1; i >= from; i--) {
    const ce = cm.ce[i] | 0;
    let a = ce < end ? ce : end;
    while (a < end) {
      if (!isAsciiBlank(text[a] | 0)) return false;
      a = a + 1;
    }
    if (cm.isLine(i) && !cm.precededByNewline(i)) return true;
    end = cm.cs[i] | 0;
  }
  return false;
}

/** `FormatBodyAndItsComments`. */
function writeBodyAndItsComments(body: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    fmtStmt(body, f);
    return;
  }
  const parent = stmtAstParent(body);
  let alternate = -1;
  if (anTag(parent) === AN_IF_STATEMENT) {
    const ifStatement = anId(parent);
    if (stmtIfYes(ifStatement) === body) alternate = stmtIfNo(ifStatement);
  }
  if (alternate < 0) {
    fmtStmt(body, f);
    return;
  }

  //     if (condition)
  //       statement; // comment1
  //     // comment2
  //     else {}
  //
  // `comment1` trails the statement, `comment2` is left for the `else`.
  if (stmtIsBlock(body)) {
    fmtNodeWithoutTrailingComments(WK_STMT, body, f);
    return;
  }
  const cm = cx.comments;
  stmtSpan(body);
  const SP$ = SP;
  const bodyStart = SP$.s0 | 0;
  const bodyEnd = SP$.s1 | 0;
  const end = cm.withoutSemicolon(bodyStart, bodyEnd);
  // `statement; // prettier-ignore` has to see its comment. The `;` can be behind the comment.
  let limit = end;
  let at = -1;
  if (cm.hasTrailingSuppressionComment(bodyEnd)) at = bodyEnd;
  else if (cm.hasTrailingSuppressionComment(end)) at = end;
  if (at >= 0) {
    const n = cm.endOfLineCommentsAfter(at);
    if (n > 0) limit = cm.spanEnd[(cm.to - 1) | 0] | 0;
  }
  const previousLimit = cm.limitCommentsUpTo(limit);
  fmtStmt(body, f);
  cm.restoreViewLimit(previousLimit);
  // They are written before the `else`, outside of the group that this is in.
  if (commentsStayBetweenHeadAndBody(f)) return;
  const n = commentsBeforeElse(body, alternate, f);
  const from = cm.from;
  let count = 0;
  while (count < n) {
    const i = (from + count) | 0;
    if (cm.isMultilineBlock(i) || cx.src.containsNewline(end, cm.spanStart[i] | 0)) break;
    count = (count + 1) | 0;
  }
  formatTrailingCommentsRange(from, (from + count) | 0, f);
}

/**
 * The comments that are not printed yet between `consequent` and the `else` after it: returns their number, and they are the range
 * `[cm.from, cm.to)`.
 */
export function commentsBeforeElse(consequent: number, alternate: number, f: Formatter): number {
  const cx = cxOf(f);
  const cm = cx.comments;
  stmtSpan(alternate);
  const SP$ = SP;
  const alternateStart = SP$.s0 | 0;
  stmtSpan(consequent);
  let position = SP$.s1 | 0;
  cm.commentsBefore(alternateStart);
  const from = cm.from;
  const to = cm.to;
  const text = cx.src.text;
  let count = 0;
  for (let i = from; i < to; i++) {
    // `Span::before(position, comment.span)`: the gap holds `else`
    const gapEnd = cm.spanStart[i] | 0;
    if (containsElse(text, position, gapEnd)) break;
    position = cm.spanEnd[i] | 0;
    count = (count + 1) | 0;
  }
  cm.from = from;
  cm.to = (from + count) | 0;
  return count;
}

function containsElse(text: Uint8Array, start: number, end0: number): boolean {
  const end = end0 < text.length ? end0 : text.length;
  for (let i = start; i + 4 <= end; i++) {
    if ((text[i] | 0) === 101 && (text[i + 1] | 0) === 108 && (text[i + 2] | 0) === 115 && (text[i + 3] | 0) === 101) return true;
  }
  return false;
}
