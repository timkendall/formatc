// Port of vendor/bun/src/format/js/utils/expression.rs: the way down the left edge of an expression.
//
// `ExpressionLeftSide` is the pair `(expr, isAssignmentTarget)`: two numbers, `LEFT_SIDE[0]` and `LEFT_SIDE[1]` after `expressionLeftSideLeft`.
import {
  BIN_COMMA,
  BIN_IN,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_ASSIGN,
  EXPR_BINARY,
  EXPR_CALL,
  EXPR_COND,
  EXPR_DOT,
  EXPR_INDEX,
  EXPR_NON_NULL,
  EXPR_PRIVATE_IDENTIFIER,
  EXPR_SATISFIES,
  EXPR_TAGGED_TEMPLATE,
  EXPR_UNARY,
  UN_POST_DEC,
  UN_POST_INC,
  callCallee,
  exprAsCallLike,
  exprAsConstExpr,
  exprAsExpr,
  exprAssignTarget,
  exprBinaryLeft,
  exprBinaryOpOf,
  exprCondTest,
  exprDotObj,
  exprIndexObj,
  exprIsAngleBracketAssertion,
  exprNonNullExpr,
  exprOperand,
  exprSatisfiesExpr,
  exprSequence,
  exprTag,
  exprUnaryOpOf,
} from "../../../lint/ast/index.ts";
import { I32Vec } from "../../../sema/vec.ts";
import { Slots2 } from "../../../base/slots.ts";

/** Result of `expressionLeftSideLeft`: the expression, and whether it is, or is at the left edge of, what an assignment or `++` writes to. */
export const LEFT_SIDE = new Slots2();
const scratch = new I32Vec(8);

/**
 * What `expr` starts with, if that is an expression: the `a` of `a.b`, `a()`, `a + b`, `a = b`, `a ? b : c`, `a, b`, `a as T`, `a!`, `a++`,
 * `` a`b` ``. Prettier's `hasNakedLeftSide` and `getLeftSide`. `isTarget`: `expr` is an assignment target. Returns whether there is one;
 * it is in `LEFT_SIDE`.
 */
export function expressionLeftSideLeft(expr: number, isTarget: boolean): boolean {
  if (isTarget) {
    switch (exprTag(expr)) {
      case EXPR_AS:
        return setLeft(exprAsExpr(expr), 0);
      case EXPR_AS_CONST:
        return setLeft(exprAsConstExpr(expr), 0);
      case EXPR_SATISFIES:
        return setLeft(exprSatisfiesExpr(expr), 0);
      case EXPR_NON_NULL:
        return setLeft(exprNonNullExpr(expr), 0);
      case EXPR_DOT:
        return setLeft(exprDotObj(expr), 0);
      case EXPR_INDEX:
        return setLeft(exprIndexObj(expr), 0);
      default:
        return false;
    }
  }
  const scratch$ = scratch;
  switch (exprTag(expr)) {
    case EXPR_BINARY: {
      const op = exprBinaryOpOf(expr);
      if (op === BIN_COMMA) {
        const base = scratch$.len;
        exprSequence(expr, scratch$);
        const first = scratch$.len > base ? scratch$.data[base] | 0 : -1;
        scratch$.len = base;
        return first >= 0 && setLeft(first, 0);
      }
      const left = exprBinaryLeft(expr);
      if (op === BIN_IN && exprTag(left) === EXPR_PRIVATE_IDENTIFIER) return false;
      return setLeft(left, 0);
    }
    case EXPR_DOT:
      return setLeft(exprDotObj(expr), 0);
    case EXPR_INDEX:
      return setLeft(exprIndexObj(expr), 0);
    case EXPR_TAGGED_TEMPLATE:
    case EXPR_CALL:
      return setLeft(callCallee(exprAsCallLike(expr)), 0);
    case EXPR_COND:
      return setLeft(exprCondTest(expr), 0);
    case EXPR_AS:
      if (exprIsAngleBracketAssertion(expr)) return false;
      return setLeft(exprAsExpr(expr), 0);
    case EXPR_AS_CONST:
      if (exprIsAngleBracketAssertion(expr)) return false;
      return setLeft(exprAsConstExpr(expr), 0);
    case EXPR_SATISFIES:
      return setLeft(exprSatisfiesExpr(expr), 0);
    case EXPR_NON_NULL:
      return setLeft(exprNonNullExpr(expr), 0);
    case EXPR_ASSIGN:
      return setLeft(exprAssignTarget(expr), 1);
    case EXPR_UNARY: {
      const op = exprUnaryOpOf(expr);
      return (op === UN_POST_INC || op === UN_POST_DEC) && setLeft(exprOperand(expr), 1);
    }
    default:
      return false;
  }
}

function setLeft(e: number, isTarget: number): boolean {
  const LEFT_SIDE$ = LEFT_SIDE;
  LEFT_SIDE$.s0 = (e) | 0;
  LEFT_SIDE$.s1 = (isTarget) | 0;
  return true;
}

/** The last of the expressions down the left edge of `expression` that ESTree calls an `Expression`. */
export function leftmost(expression: number): number {
  let expr = expression;
  let isTarget = false;
  let last = expression;
  const LEFT_SIDE$ = LEFT_SIDE;
  while (true) {
    if (!isTarget) last = expr;
    if (!expressionLeftSideLeft(expr, isTarget)) return last;
    expr = LEFT_SIDE$.s0 | 0;
    isTarget = (LEFT_SIDE$.s1 | 0) !== 0;
  }
}
