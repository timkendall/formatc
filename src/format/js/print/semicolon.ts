// Port of vendor/bun/src/format/js/print/semicolon.rs.
import { Formatter } from "../../ir/formatter.ts";
import { SEMI } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT, SEMICOLONS_ALWAYS } from "../../options.ts";
import {
  BIN_COMMA,
  BODY_EXPR,
  EXPR_ASSIGN,
  EXPR_BINARY,
  EXPR_JSX,
  STMT_EXPR,
  STMT_RETURN,
  STMT_VAR,
  exprAssignValue,
  exprBinaryOpOf,
  exprEnd,
  exprOuterEnd,
  exprTag,
  funcBodyExpr,
  funcBodyKind,
  stmtExprExpr,
  stmtReturnExpr,
  stmtTag,
  stmtVarDeclsLen,
  stmtVarDeclsStart,
  listAt,
  varDeclInit,
} from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";
import { exprArrowFunction } from "../fields.ts";
import { isCastTarget } from "../utils/typecast.ts";

/** `OptionalSemicolon`: a `;`, unless the options say to leave them out. */
export function optionalSemicolon(f: Formatter): void {
  if (f.options.semicolons === SEMICOLONS_ALWAYS) f.token(SEMI);
}

/**
 * `a = (b /* comment *&#47;);` is `a = b; /* comment *&#47;` for oxfmt: the parentheses are not written, so the comment is before the `;`, and
 * goes behind it like any other that is. Prettier writes `a = b /* comment *&#47;;`, and makes that of it when it formats it again.
 */
export function commentsInDroppedParenthesesGoBehindSemicolon(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

function isComma(e: number): boolean {
  return exprTag(e) === EXPR_BINARY && exprBinaryOpOf(e) === BIN_COMMA;
}

/**
 * Prettier's `handleParenthesizedExpressionTrailingComment`: whether the parentheses at the end of `e` are written, with the comment before the
 * `)` in them: those of a sequence or an assignment that is the value of a variable, the argument of `return`, the body of an arrow function or
 * the right side of an assignment. `isInSuchAPlace`: `e` is.
 */
function keepsCommentInParentheses(e0: number, isInSuchAPlace0: boolean): boolean {
  let e = e0;
  let isInSuchAPlace = isInSuchAPlace0;
  while (true) {
    if (isComma(e)) return isInSuchAPlace;
    if (exprTag(e) === EXPR_ASSIGN) {
      const value = exprAssignValue(e);
      if (isInSuchAPlace || isComma(value)) return true;
      e = value;
      continue;
    }
    const arrow = exprArrowFunction(e);
    if (arrow >= 0 && funcBodyKind(arrow) === BODY_EXPR) {
      e = funcBodyExpr(arrow);
      isInSuchAPlace = true;
      continue;
    }
    return false;
  }
}

/**
 * The last thing in `e` that is no assignment and no arrow function with an expression for a body. The parentheses between its end and the end
 * of `e` are not written.
 */
function lastOfAssignmentsAndArrows(e0: number): number {
  let e = e0;
  while (true) {
    if (exprTag(e) === EXPR_ASSIGN) {
      e = exprAssignValue(e);
      continue;
    }
    const arrow = exprArrowFunction(e);
    if (arrow >= 0 && funcBodyKind(arrow) === BODY_EXPR) {
      const body = funcBodyExpr(arrow);
      const t = exprTag(body);
      if (t !== EXPR_ASSIGN && t !== EXPR_JSX && !isComma(body)) {
        e = body;
        continue;
      }
    }
    return e;
  }
}

/**
 * See `commentsInDroppedParenthesesGoBehindSemicolon`: where the comments start that go behind the `;` after `e`, if there are any in `e` or in the
 * parentheses around it. `isInSuchAPlace`: see `keepsCommentInParentheses`: 0, 1, or -1 for `None`. -1: it makes no difference.
 */
export function startOfCommentsInDroppedParentheses(e: number, isInSuchAPlace: number, f: Formatter): number {
  const cx = cxOf(f);
  if (cx.isQuiet || !commentsInDroppedParenthesesGoBehindSemicolon(f)) return -1;
  if (isInSuchAPlace >= 0 && keepsCommentInParentheses(e, isInSuchAPlace !== 0)) return -1;
  const last = lastOfAssignmentsAndArrows(e);
  const position = exprEnd(last);
  const hasComments = cx.comments.hasCommentInRange(position, exprOuterEnd(e));
  // One that is about what is before it has to be seen there.
  if (hasComments && !isCastTarget(last, f) && !cx.comments.hasTrailingSuppressionComment(position)) return position;
  return -1;
}

/** The same for the `;` of `statement`. -1: none. */
export function startOfCommentsBehindSemicolon(statement: number, f: Formatter): number {
  if (cxOf(f).isQuiet || !commentsInDroppedParenthesesGoBehindSemicolon(f)) return -1;
  switch (stmtTag(statement)) {
    case STMT_EXPR:
      return startOfCommentsInDroppedParentheses(stmtExprExpr(statement), 0, f);
    case STMT_VAR: {
      const n = stmtVarDeclsLen(statement);
      if (n === 0) return -1;
      const init = varDeclInit(listAt(stmtVarDeclsStart(statement), n - 1));
      return init >= 0 ? startOfCommentsInDroppedParentheses(init, 1, f) : -1;
    }
    case STMT_RETURN: {
      // Those in the parentheses around all of it stay there.
      const e = stmtReturnExpr(statement);
      if (e < 0) return -1;
      const position = startOfCommentsInDroppedParentheses(e, -1, f);
      return position >= 0 && position < exprEnd(e) ? position : -1;
    }
    default:
      return -1;
  }
}
