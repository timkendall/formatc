// Port of vendor/bun/src/format/js/fields.rs: the fields of ESTree nodes, as functions of the handles.
//
// `switch (exprTag(e))` is the way to take a node apart. These are for a question about one field of a node whose kind is known,
// mostly a parent: `exprObject(parent) === e`. Each returns -1 (`None`), or false, for a node that has no such field.
import {
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_AWAIT,
  EXPR_COND,
  EXPR_INDEX,
  EXPR_INSTANTIATION,
  EXPR_NON_NULL,
  EXPR_SATISFIES,
  EXPR_SPREAD,
  EXPR_TAGGED_TEMPLATE,
  EXPR_UNARY,
  EXPR_YIELD,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IF,
  STMT_TRY,
  exprAsCallLike,
  exprAsFn,
  exprAsTy,
  callCallee,
  exprCondNo,
  exprCondTest,
  exprIndexIndex,
  exprOperand,
  exprSatisfiesTy,
  exprTag,
  exprYieldValue,
  funcIsArrow,
  stmtForInLeft,
  stmtForInit,
  stmtForOfIsAwait,
  stmtForOfLeft,
  stmtIfNo,
  stmtIfYes,
  stmtTag,
  stmtTryFinalizer,
} from "../../lint/ast/index.ts";

/** `TaggedTemplateExpression.tag` */
export function exprTagExpression(e: number): number {
  if (exprTag(e) !== EXPR_TAGGED_TEMPLATE) return -1;
  const call = exprAsCallLike(e);
  return call < 0 ? -1 : callCallee(call);
}

/** `ConditionalExpression.test` */
export function exprTest(e: number): number {
  return exprTag(e) === EXPR_COND ? exprCondTest(e) : -1;
}

/** `ConditionalExpression.alternate` */
export function exprAlternate(e: number): number {
  return exprTag(e) === EXPR_COND ? exprCondNo(e) : -1;
}

/** `.argument` of a `UnaryExpression`, an `UpdateExpression`, an `AwaitExpression`, a `YieldExpression` or a `SpreadElement`. */
export function exprArgument(e: number): number {
  switch (exprTag(e)) {
    case EXPR_UNARY:
    case EXPR_AWAIT:
    case EXPR_SPREAD:
      return exprOperand(e);
    case EXPR_YIELD:
      return exprYieldValue(e);
    default:
      return -1;
  }
}

/**
 * `.expression` of a `TSAsExpression`, a `TSSatisfiesExpression`, a `TSTypeAssertion`, a `TSNonNullExpression` or a
 * `TSInstantiationExpression`, and the index of a `ComputedMemberExpression`.
 */
export function exprExpression(e: number): number {
  switch (exprTag(e)) {
    case EXPR_AS:
    case EXPR_SATISFIES:
    case EXPR_AS_CONST:
    case EXPR_NON_NULL:
    case EXPR_INSTANTIATION:
      return exprOperand(e);
    case EXPR_INDEX:
      return exprIndexIndex(e);
    default:
      return -1;
  }
}

/** `.typeAnnotation` of a `TSAsExpression`, a `TSSatisfiesExpression` or a `TSTypeAssertion`. -1 for `as const`. */
export function exprTypeAnnotation(e: number): number {
  switch (exprTag(e)) {
    case EXPR_AS:
      return exprAsTy(e);
    case EXPR_SATISFIES:
      return exprSatisfiesTy(e);
    default:
      return -1;
  }
}

/** The function of an `ArrowFunctionExpression`: a FnId or -1. */
export function exprArrowFunction(e: number): number {
  const func = exprAsFn(e);
  return func >= 0 && funcIsArrow(func) ? func : -1;
}

/** `ForInStatement.left`, `ForOfStatement.left`: a `Var` statement, or the wrapper of an expression. */
export function stmtForLeft(s: number): number {
  switch (stmtTag(s)) {
    case STMT_FOR_IN:
      return stmtForInLeft(s);
    case STMT_FOR_OF:
      return stmtForOfLeft(s);
    default:
      return -1;
  }
}

/** `ForStatement.init` */
export function stmtForInitOf(s: number): number {
  return stmtTag(s) === STMT_FOR ? stmtForInit(s) : -1;
}

/** `IfStatement.consequent` */
export function stmtConsequent(s: number): number {
  return stmtTag(s) === STMT_IF ? stmtIfYes(s) : -1;
}

/** `IfStatement.alternate` */
export function stmtAlternate(s: number): number {
  return stmtTag(s) === STMT_IF ? stmtIfNo(s) : -1;
}

/** `TryStatement.finalizer` */
export function stmtFinalizer(s: number): number {
  return stmtTag(s) === STMT_TRY ? stmtTryFinalizer(s) : -1;
}

/** `for await` */
export function stmtIsForAwait(s: number): boolean {
  return stmtTag(s) === STMT_FOR_OF && stmtForOfIsAwait(s) !== 0;
}
