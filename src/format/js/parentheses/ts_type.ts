// Port of vendor/bun/src/format/js/parentheses/ts_type.rs: which types need parentheses where they are.
import { Formatter } from "../../ir/formatter.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  FN_CONSTRUCTOR_TYPE,
  TYPE_COND,
  TYPE_FN,
  TYPE_IMPORT,
  TYPE_INFER,
  TYPE_INTERSECTION,
  TYPE_KEYOF,
  TYPE_PREDICATE,
  TYPE_READONLY,
  TYPE_TYPEOF,
  TYPE_UNION,
  TYPE_UNIQUE,
  TYPE_UNIQUE_SYMBOL,
  TYPE_INDEXED_ACCESS,
  fileIsFlow,
  funcKind,
  funcReturnType,
  typeCondCheck,
  typeCondExtends,
  typeFnFn,
  typeImportFlags,
  typeIndexedAccessObj,
  typeInferParam,
  typeIntersectionTypesLen,
  typePredicateTy,
  typeTag,
  typeUnionTypesLen,
  typeParamConstraint,
} from "../../../lint/ast/index.ts";
import {
  AN_ARROW_FUNCTION_EXPRESSION,
  AN_TS_ARRAY_TYPE,
  AN_TS_CONDITIONAL_TYPE,
  AN_TS_INDEXED_ACCESS_TYPE,
  AN_TS_INTERSECTION_TYPE,
  AN_TS_OPTIONAL_TYPE,
  AN_TS_REST_TYPE,
  AN_TS_TYPE_ANNOTATION,
  AN_TS_TYPE_OPERATOR,
  AN_TS_TYPE_PARAMETER,
  AN_TS_UNION_TYPE,
  anId,
  anParent,
  anTag,
  typeAstParent,
} from "../ast_nodes.ts";
import { needsParentheses as flowNeedsParentheses } from "../print/flow.ts";

function memberCount(ty: number): number {
  switch (typeTag(ty)) {
    case TYPE_UNION:
      return typeUnionTypesLen(ty);
    case TYPE_INTERSECTION:
      return typeIntersectionTypesLen(ty);
    default:
      return 0;
  }
}

/**
 * `| A` is a union of one type here. Prettier's parsers have it as `A`, so the parent of `A` is what the union is in. Takes and returns an
 * `AstNodes`.
 */
export function effectiveParent(parent0: number): number {
  let parent = parent0;
  while (true) {
    const t = anTag(parent);
    if ((t === AN_TS_UNION_TYPE || t === AN_TS_INTERSECTION_TYPE) && memberCount(anId(parent)) <= 1) parent = anParent(parent);
    else return parent;
  }
}

export function needsParentheses(ty: number, f: Formatter): boolean {
  if (fileIsFlow()) return flowNeedsParentheses(ty);
  switch (typeTag(ty)) {
    case TYPE_FN: {
      const func = typeFnFn(ty);
      const parent = effectiveParent(typeAstParent(ty));
      // `(): (() => void) => ..`
      if (funcKind(func) !== FN_CONSTRUCTOR_TYPE && anTag(parent) === AN_TS_TYPE_ANNOTATION && anTag(anParent(parent)) === AN_ARROW_FUNCTION_EXPRESSION) {
        return true;
      }
      return functionLikeTypeNeedsParentheses(ty, parent, funcReturnType(func), f);
    }
    case TYPE_INFER: {
      const parent = effectiveParent(typeAstParent(ty));
      const t = anTag(parent);
      if (t === AN_TS_INTERSECTION_TYPE || t === AN_TS_UNION_TYPE) {
        return typeParamConstraint(typeInferParam(ty)) >= 0 || everyInferInUnionHasParentheses(f);
      }
      if (t === AN_TS_REST_TYPE) return false;
      return operatorTypeOrHigherNeedsParens(ty, parent);
    }
    case TYPE_UNION:
    case TYPE_INTERSECTION: {
      if (memberCount(ty) <= 1) return false;
      const parent = effectiveParent(typeAstParent(ty));
      const t = anTag(parent);
      if (t === AN_TS_UNION_TYPE || t === AN_TS_INTERSECTION_TYPE) return memberCount(anId(parent)) > 1;
      return operatorTypeOrHigherNeedsParens(ty, parent);
    }
    case TYPE_COND: {
      const parent = effectiveParent(typeAstParent(ty));
      const t = anTag(parent);
      if (t === AN_TS_CONDITIONAL_TYPE) {
        const p = anId(parent);
        return typeTag(p) === TYPE_COND && (typeCondCheck(p) === ty || typeCondExtends(p) === ty);
      }
      // `<A extends (B extends C ? D : E)>() => {}`
      if (t === AN_TS_TYPE_PARAMETER) return typeParamConstraintOf(anId(parent)) === ty;
      if (t === AN_TS_UNION_TYPE || t === AN_TS_INTERSECTION_TYPE) return memberCount(anId(parent)) > 1;
      return operatorTypeOrHigherNeedsParens(ty, parent);
    }
    case TYPE_KEYOF:
    case TYPE_READONLY:
    case TYPE_UNIQUE_SYMBOL:
    case TYPE_UNIQUE:
      return operatorTypeOrHigherNeedsParens(ty, effectiveParent(typeAstParent(ty)));
    case TYPE_TYPEOF:
      return typeofNeedsParentheses(ty);
    case TYPE_IMPORT:
      if ((typeImportFlags(ty) & 1) !== 0) return typeofNeedsParentheses(ty);
      return false;
    default:
      return false;
  }
}

function typeParamConstraintOf(param: number): number {
  return typeParamConstraint(param);
}

function typeofNeedsParentheses(ty: number): boolean {
  const parent = effectiveParent(typeAstParent(ty));
  const t = anTag(parent);
  if (t === AN_TS_ARRAY_TYPE) return true;
  // `(typeof a)[0]` means the same as `typeof a[0]`, unlike in an expression.
  if (t === AN_TS_INDEXED_ACCESS_TYPE) {
    const p = anId(parent);
    return typeTag(p) === TYPE_INDEXED_ACCESS && typeIndexedAccessObj(p) === ty;
  }
  return false;
}

/** `A extends (infer B) | C`. Prettier writes the parentheses only if `B` has a constraint. */
function everyInferInUnionHasParentheses(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `A extends ((b: B) => b is C) ? D : E`. Prettier writes the parentheses only if `C` is an `infer` with a constraint. */
function everyPredicateAfterExtendsHasParentheses(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

function functionLikeTypeNeedsParentheses(ty: number, parent: number, returnType0: number, f: Formatter): boolean {
  const t = anTag(parent);
  if (t === AN_TS_CONDITIONAL_TYPE) {
    const p = anId(parent);
    if (typeTag(p) !== TYPE_COND) return false;
    if (typeCondCheck(p) === ty) return true;
    if (typeCondExtends(p) !== ty) return false;
    let returnType = returnType0;
    if (returnType >= 0 && typeTag(returnType) === TYPE_PREDICATE && typePredicateTy(returnType) >= 0) {
      if (everyPredicateAfterExtendsHasParentheses(f)) return true;
      returnType = typePredicateTy(returnType);
    }
    return returnType >= 0 && typeTag(returnType) === TYPE_INFER && typeParamConstraint(typeInferParam(returnType)) >= 0;
  }
  if (t === AN_TS_UNION_TYPE || t === AN_TS_INTERSECTION_TYPE) return memberCount(anId(parent)) > 1;
  return operatorTypeOrHigherNeedsParens(ty, parent);
}

/** Whether `parent` (an `AstNodes`) is an operator that binds more tightly than any that `ty` can be. */
function operatorTypeOrHigherNeedsParens(ty: number, parent: number): boolean {
  switch (anTag(parent)) {
    case AN_TS_ARRAY_TYPE:
    case AN_TS_TYPE_OPERATOR:
    case AN_TS_REST_TYPE:
    case AN_TS_OPTIONAL_TYPE:
      return true;
    case AN_TS_INDEXED_ACCESS_TYPE: {
      const p = anId(parent);
      return typeTag(p) === TYPE_INDEXED_ACCESS && typeIndexedAccessObj(p) === ty;
    }
    default:
      return false;
  }
}
