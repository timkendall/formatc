// Port of vendor/bun/src/format/js/print/return_or_throw_statement.rs.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { LPAREN, RPAREN } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  BIN_COMMA,
  EXPR_BINARY,
  EXPR_COND,
  EXPR_DOT,
  EXPR_JSX,
  SP,
  exprBinaryOpOf,
  exprCondNo,
  exprCondYes,
  exprDotName,
  exprDotNamePos,
  exprDotObj,
  exprEnd,
  exprIsPrivateMember,
  exprOuterEnd,
  exprSpan,
  exprStart,
  exprTag,
  identEndOf,
  stmtSpan,
} from "../../../lint/ast/index.ts";
import { AN_RETURN_STATEMENT, AN_YIELD_EXPRESSION, anId, anTag, exprAsAstNodes, exprAstParent } from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { fmtExpr, writeTrailingCommentsOf } from "../format.ts";
import { DANGLING_NONE, formatDanglingCommentsRange, formatLeadingComments } from "../trivia.ts";
import { expressionLeftSideLeft, LEFT_SIDE } from "../utils/expression.ts";
import { isCastTargetThatHidesItsKind } from "../utils/typecast.ts";
import { ignoredJsxGetsNoParentheses } from "./jsx/element.ts";
import { optionalSemicolon } from "./semicolon.ts";

const KW_RETURN = token("return");
const KW_THROW = token("throw");

export function writeReturnStatement(statement: number, argument: number /* -1: none */, f: Formatter): void {
  writeReturnOrThrow(KW_RETURN, 6, statement, argument, f);
}

export function writeThrowStatement(statement: number, argument: number, f: Formatter): void {
  writeReturnOrThrow(KW_THROW, 5, statement, argument, f);
}

function writeReturnOrThrow(keyword: number, keywordLen: number, statement: number, argument: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  f.token(keyword);
  const contentEnd = endBeforeCommentsThatCountForTheWidth(statement, argument, keywordLen, f);
  if (contentEnd < 0) {
    if (argument >= 0) {
      f.space();
      writeAdjacentArgument(argument, f);
    }
    optionalSemicolon(f);
    return;
  }
  if (argument >= 0) {
    const previousLimit = cm.limitCommentsUpTo(contentEnd);
    f.space();
    writeAdjacentArgument(argument, f);
    cm.restoreViewLimit(previousLimit);
  }
  stmtSpan(statement);
  cm.commentsBefore(SP.s1 | 0);
  const from = cm.from;
  const to = cm.to;
  let onTheLine = 0;
  while (from + onTheLine < to && !cm.precededByNewline((from + onTheLine) | 0)) onTheLine = (onTheLine + 1) | 0;
  optionalSemicolon(f);
  f.space();
  formatDanglingCommentsRange(from, (from + onTheLine) | 0, DANGLING_NONE, f);
}

/**
 * `return a // comment⏎;`: the `;` is on a later line, so the comment is in the statement. oxfmt writes it behind the `;` as a text like another,
 * which has to fit on the line. Returns where what is before the comment ends, or -1.
 */
function endBeforeCommentsThatCountForTheWidth(statement: number, argument: number, keywordLen: number, f: Formatter): number {
  const cx = cxOf(f);
  if (f.options.flavor !== FLAVOR_OXFMT || cx.isQuiet) return -1;
  stmtSpan(statement);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  const contentEnd = argument >= 0 ? exprOuterEnd(argument) : (start + keywordLen) | 0;
  const cm = cx.comments;
  if (cm.commentsIn(contentEnd, end > contentEnd ? end : contentEnd) === 0) return -1;
  const first = cm.from;
  const firstStart = cm.cs[first] | 0;
  const text = cx.src.text;
  let isRightBehind = true;
  for (let i = contentEnd; i < firstStart; i++) {
    const b = text[i] | 0;
    if (!(b === 32 || b === 9 || b === 10 || b === 12 || b === 13)) {
      isRightBehind = false;
      break;
    }
  }
  if (isRightBehind && !cm.precededByNewline(first) && !cm.hasTrailingSuppressionComment(contentEnd)) return contentEnd;
  return -1;
}

function isSequence(e: number): boolean {
  return exprTag(e) === EXPR_BINARY && exprBinaryOpOf(e) === BIN_COMMA;
}

/**
 * What has to start on the line of the keyword before it: the argument of `return` or `throw`. If it breaks, or starts with a comment, it is
 * written in parentheses. `FormatAdjacentArgument`.
 */
function writeAdjacentArgument(argument: number, f: Formatter): void {
  const cx = cxOf(f);
  const tag = exprTag(argument);
  const sequence = isSequence(argument);
  // JSX writes parentheses of its own around its comments, unless it is written as it is.
  const argumentStart = exprStart(argument);
  const hasOwnParentheses = tag === EXPR_JSX && !(ignoredJsxGetsNoParentheses(f) && cx.comments.isSuppressed(argumentStart));

  const SP$ = SP;
  if (!hasOwnParentheses && !cx.isQuiet && hasArgumentLeadingComments(argument, f)) {
    f.token(LPAREN);
    f.startBlockIndent();
    fmtExpr(argument, f);
    f.endBlockIndent();
    f.token(RPAREN);
  } else if (isCastTargetThatHidesItsKind(argument, f)) {
    // For Prettier it is a `ParenthesizedExpression`, whatever is in it.
    fmtExpr(argument, f);
  } else if (
    (tag === EXPR_BINARY && !sequence) ||
    (f.options.experimentalTernaries && tag === EXPR_COND && (exprTag(exprCondYes(argument)) === EXPR_COND || exprTag(exprCondNo(argument)) === EXPR_COND))
  ) {
    f.startGroup();
    f.tokenIfBreaks(LPAREN);
    f.startSoftBlockIndent();
    fmtExpr(argument, f);
    f.endSoftBlockIndent();
    f.tokenIfBreaks(RPAREN);
    f.endGroup();
  } else if (sequence) {
    if (cx.isQuiet) {
      writeSequenceArgument(argument, f);
      return;
    }
    const cm = cx.comments;
    exprSpan(argument);
    const spanStart = SP$.s0 | 0;
    const spanEnd = SP$.s1 | 0;
    if (cm.getTypeCastCommentIndex(spanStart) < 0) formatLeadingComments(spanStart, spanEnd, f);
    // The comments before the `)` go behind it. After `return`, only those that start their line: see `write_comments_before_closing_parenthesis`.
    const isReturn = anTag(exprAstParent(argument)) === AN_RETURN_STATEMENT;
    const outerEnd = exprOuterEnd(argument);
    let limit = outerEnd;
    cm.commentsIn(spanEnd, outerEnd);
    for (let i = cm.from; i < cm.to; i++) {
      if (!isReturn || cm.precededByNewline(i)) {
        limit = cm.spanStart[i] | 0;
        break;
      }
    }
    const previousLimit = cm.limitCommentsUpTo(limit);
    writeSequenceArgument(argument, f);
    cm.restoreViewLimit(previousLimit);
    writeTrailingCommentsOf(exprAsAstNodes(argument), f);
  } else {
    fmtExpr(argument, f);
  }
}

function writeSequenceArgument(argument: number, f: Formatter): void {
  f.startGroup();
  f.token(LPAREN);
  f.startSoftBlockIndent();
  fmtExpr(argument, f);
  f.endSoftBlockIndent();
  f.token(RPAREN);
  f.endGroup();
}

/** Whether a comment that ends its line, or spans several, is before `argument` or before anything down its left edge. */
export function hasArgumentLeadingComments(argument: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;

  // The comments inside the parentheses of a type cast are dealt with there.
  const argumentStart = exprStart(argument);
  const typeCastIndex = cm.getTypeCastCommentIndex(argumentStart);
  const typeCastCommentEnd = typeCastIndex >= 0 ? cm.spanEnd[(cm.printedCount + typeCastIndex) | 0] | 0 : -1;

  const isYield = anTag(exprAstParent(argument)) === AN_YIELD_EXPRESSION;
  let e = argument;
  let isAssignmentTarget = false;
  const LEFT_SIDE$ = LEFT_SIDE;
  while (true) {
    const leftStart = exprStart(e);
    const n = cm.commentsBefore(leftStart);
    const from = cm.from;
    for (let i = from; i < from + n; i++) {
      if ((cm.isMultilineBlock(i) || cm.followedByNewline(i)) && (typeCastCommentEnd < 0 || (cm.spanStart[i] | 0) < typeCastCommentEnd)) return true;
    }
    // After `yield`, which only oxfmt asks about, only what is before the left edge counts.
    if (!(isAssignmentTarget || isYield)) {
      if (exprTag(e) === EXPR_DOT && !exprIsPrivateMember(e)) {
        const obj = exprDotObj(e);
        const nameEnd = identEndOf(exprDotName(e), exprDotNamePos(e));
        const count = cm.commentsIn(exprEnd(obj), nameEnd);
        const cf = cm.from;
        for (let i = cf; i < cf + count; i++) {
          // Prettier's `handleMemberExpressionComments`: it leads the member expression.
          if (
            cm.precededByNewline(i) &&
            (cm.isMultilineBlock(i) || cm.followedByNewline(i)) &&
            (typeCastCommentEnd < 0 || (cm.spanStart[i] | 0) < typeCastCommentEnd)
          ) {
            return true;
          }
        }
      }
    }
    if (!expressionLeftSideLeft(e, isAssignmentTarget)) break;
    e = LEFT_SIDE$.s0 | 0;
    isAssignmentTarget = (LEFT_SIDE$.s1 | 0) !== 0;
  }
  return false;
}
