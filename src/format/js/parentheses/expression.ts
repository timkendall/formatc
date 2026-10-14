// Port of vendor/bun/src/format/js/parentheses/expression.rs: which expressions need parentheses where they are. Prettier's
// `needsParentheses`.
import { Formatter } from "../../ir/formatter.ts";
import { FLAVOR_OXFMT, SEMICOLONS_AS_NEEDED } from "../../options.ts";
import {
  BIN_COMMA,
  BIN_IN,
  BIN_INSTANCEOF,
  BIN_LT,
  BIN_POW,
  BIN_SHL,
  EXPR_ARRAY,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_ASSIGN,
  EXPR_AWAIT,
  EXPR_BIG_INT,
  EXPR_BINARY,
  EXPR_CALL,
  EXPR_CLASS,
  EXPR_COND,
  EXPR_DOT,
  EXPR_FALSE,
  EXPR_FN,
  EXPR_IDENT,
  EXPR_IMPORT_CALL,
  EXPR_IMPORT_META,
  EXPR_INDEX,
  EXPR_INSTANTIATION,
  EXPR_JSX,
  EXPR_MISSING,
  EXPR_NEW,
  EXPR_NEW_TARGET,
  EXPR_NON_NULL,
  EXPR_NULL,
  EXPR_NUMBER,
  EXPR_OBJECT,
  EXPR_PRIVATE_IDENTIFIER,
  EXPR_REGEX,
  EXPR_SATISFIES,
  EXPR_SPREAD,
  EXPR_STRING,
  EXPR_SUPER,
  EXPR_TAGGED_TEMPLATE,
  EXPR_TEMPLATE,
  EXPR_THIS,
  EXPR_TRUE,
  EXPR_UNARY,
  EXPR_YIELD,
  FN_EXPR,
  N_CASE,
  N_CLASS,
  N_EXPR,
  N_FUNC,
  N_MEMBER,
  N_PARAM,
  N_PAT_ELEM,
  N_PAT_PROP,
  N_PROP,
  N_STMT,
  N_VAR_DECL,
  STMT_EXPORT_DEFAULT,
  STMT_EXPR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_RETURN,
  UN_MINUS,
  UN_PLUS,
  UN_POST_DEC,
  UN_POST_INC,
  UN_PRE_DEC,
  UN_PRE_INC,
  SP,
  classModifiersLen,
  classModifiersStart,
  exprAsFn,
  exprAssignTarget,
  exprBinaryLeft,
  exprBinaryOp,
  exprBinaryRight,
  exprCallee,
  exprCondTest,
  exprDotObj,
  exprEnd,
  exprIndexObj,
  exprIsAngleBracketAssertion,
  exprIsAssignmentTarget,
  exprIsChainRoot,
  exprIsOptional,
  exprIsParenthesized,
  exprLeft,
  exprNonNullExpr,
  exprParent,
  exprSequence,
  exprSpan,
  exprStart,
  exprTag,
  exprUnaryOpOf,
  exprBinaryOpOf,
  exprAsExpr,
  exprAsConstExpr,
  exprSatisfiesExpr,
  exprAsClass,
  exprAsCallLike,
  callCallee,
  funcIsArrow,
  funcKind,
  hir,
  fileIsFlow,
  listAt,
  modifierDecorator,
  nameBuf,
  nameIs,
  nameLen,
  nameStart,
  exprIdentName,
  exprObject,
  nodeId,
  nodeKind,
  stmtForInLeft,
  stmtForInit,
  stmtTag,
  stmtSpan,
  stmtExprExpr,
  varDeclInit,
  varDeclParent,
  stmtParent,
  stmtForOfIsAwait,
  stmtForOfLeft,
  stmtForUpdate,
  BIN_NULLISH,
} from "../../../lint/ast/index.ts";
import {
  AN_ARRAY_EXPRESSION,
  AN_ASSIGNMENT_EXPRESSION,
  AN_ASSIGNMENT_PATTERN_ELEM,
  AN_ASSIGNMENT_PATTERN_PROP,
  AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY,
  AN_ASSIGNMENT_TARGET_WITH_DEFAULT,
  AN_AWAIT_EXPRESSION,
  AN_BINARY_EXPRESSION,
  AN_BLOCK_STATEMENT,
  AN_CALL_EXPRESSION,
  AN_CHAIN_EXPRESSION,
  AN_CLASS,
  AN_COMPUTED_MEMBER_EXPRESSION,
  AN_CONDITIONAL_EXPRESSION,
  AN_DECORATOR,
  AN_EXPORT_DEFAULT_DECLARATION,
  AN_EXPRESSION_STATEMENT,
  AN_FOR_IN_STATEMENT,
  AN_FOR_OF_STATEMENT,
  AN_FOR_STATEMENT,
  AN_FORMAL_PARAMETER,
  AN_FUNCTION_BODY,
  AN_IDENTIFIER_REFERENCE,
  AN_JSX_ATTRIBUTE,
  AN_JSX_ELEMENT,
  AN_JSX_EXPRESSION_CONTAINER,
  AN_JSX_FRAGMENT,
  AN_JSX_SPREAD_ATTRIBUTE,
  AN_JSX_SPREAD_CHILD,
  AN_LOGICAL_EXPRESSION,
  AN_NEW_EXPRESSION,
  AN_OBJECT_PROPERTY,
  AN_PRIVATE_FIELD_EXPRESSION,
  AN_PRIVATE_IN_EXPRESSION,
  AN_PROGRAM,
  AN_ARROW_BODY_EXPRESSION_STATEMENT,
  AN_RETURN_STATEMENT,
  AN_SEQUENCE_EXPRESSION,
  AN_STATIC_MEMBER_EXPRESSION,
  AN_TAGGED_TEMPLATE_EXPRESSION,
  AN_THROW_STATEMENT,
  AN_TS_AS_EXPRESSION,
  AN_TS_INSTANTIATION_EXPRESSION,
  AN_TS_NON_NULL_EXPRESSION,
  AN_TS_PROPERTY_SIGNATURE,
  AN_TS_SATISFIES_EXPRESSION,
  AN_TS_TYPE_ASSERTION,
  AN_TYPE_CAST_EXPRESSION,
  AN_UNARY_EXPRESSION,
  AN_UPDATE_EXPRESSION,
  AN_VARIABLE_DECLARATOR,
  AN_YIELD_EXPRESSION,
  AN_SPREAD_ELEMENT_EXPR,
  AN_SPREAD_ELEMENT_PROP,
  anId,
  anIsCallLikeCallee,
  anIsExpressionStatement,
  anParent,
  anTag,
  exprAsChainElement,
  exprAstParent,
  mkAn,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import {
  binOpIsLogical,
  binOpIsRemainder,
  binOpPrecedence,
  precedenceIsAdditive,
  precedenceIsBitwise,
  precedenceIsShift,
} from "../utils/operators.ts";
import { isAngularPipe, shouldFlatten } from "../print/binary_like_expression.ts";
import { unaryArgumentHasComments } from "../print/expressions.ts";
import { isCastTarget } from "../utils/typecast.ts";
import { I32Vec } from "../../../sema/vec.ts";

/** The second result of `leftEdgeEnd` (the first is returned). */
export const LEFT_EDGE = new Int32Array(2);
const sequenceScratch = new I32Vec(16);

/** Whether ESTree's `Expression` that `e` is needs parentheses. For the whole of an optional chain that is the `ChainExpression`. */
export function expressionNeedsParentheses(e: number, f: Formatter): boolean {
  return exprIsChainRoot(e) ? chainExpressionNeedsParentheses(e, f) : needsParentheses(e, f);
}

/** Whether the `ChainExpression` around `e`, which is the whole of an optional chain, needs parentheses. */
export function chainExpressionNeedsParentheses(e: number, f: Formatter): boolean {
  if (isCastTarget(e, f)) return false;
  const parent = anParent(mkAn(AN_CHAIN_EXPRESSION, e));
  const answer = parentNeedsParentheses(e, parent, f);
  if (answer >= 0) return answer === 1;
  // Prettier's `shouldAddParenthesesToChainExpression`: something goes on after it that is not part of the chain.
  const id = anId(parent);
  switch (anTag(parent)) {
    case AN_TS_NON_NULL_EXPRESSION:
    case AN_TAGGED_TEMPLATE_EXPRESSION:
      return true;
    case AN_STATIC_MEMBER_EXPRESSION:
    case AN_PRIVATE_FIELD_EXPRESSION:
      return !exprIsOptional(id);
    case AN_COMPUTED_MEMBER_EXPRESSION:
      return !exprIsOptional(id) && exprObject(id) === e;
    case AN_CALL_EXPRESSION:
      return !exprIsOptional(id) && exprCallee(id) === e;
    case AN_NEW_EXPRESSION:
      return exprCallee(id) === e;
    default:
      return false;
  }
}

/** Whether `e` itself needs parentheses, not the `ChainExpression` around it. */
export function needsParentheses(e: number, f: Formatter): boolean {
  return mayNeedParentheses(e) && needsParenthesesWhereItIs(e, f);
}

function isNameThatMayNeedParentheses(buf: Uint8Array, start: number, len: number): boolean {
  switch (len) {
    case 3:
      return eqLit(buf, start, "let");
    case 4:
      return eqLit(buf, start, "hook") || eqLit(buf, start, "type");
    case 5:
      return eqLit(buf, start, "async") || eqLit(buf, start, "await") || eqLit(buf, start, "using") || eqLit(buf, start, "yield");
    case 6:
      return eqLit(buf, start, "module");
    case 9:
      return eqLit(buf, start, "interface") || eqLit(buf, start, "component");
    default:
      return false;
  }
}

function eqLit(buf: Uint8Array, start: number, lit: string): boolean {
  for (let i = 0; i < lit.length; i++) if ((buf[start + i] | 0) !== lit.charCodeAt(i)) return false;
  return true;
}

/**
 * A necessary condition that takes no more than the kind of `e`, what it is directly in, and the kind of that. It is false for nearly every
 * expression. Each `false` here is what `needsParenthesesWhereItIs` comes to for that pair.
 */
function mayNeedParentheses(e: number): boolean {
  const tag = exprTag(e);
  switch (tag) {
    case EXPR_MISSING:
    case EXPR_PRIVATE_IDENTIFIER:
    case EXPR_SUPER:
    case EXPR_SPREAD:
      return false;
    case EXPR_IDENT: {
      const text = hir.text;
      const start = exprStart(e);
      const len = exprEnd(e) - start;
      if (isNameThatMayNeedParentheses(text, start, len)) return true;
      if (len >= 8) {
        for (let i = start; i < start + len; i++) if ((text[i] | 0) === 92) return true;
      }
      return len >= 35 && eqLit(text, start, "PRETTIER_");
    }
    case EXPR_BINARY: {
      const op = exprBinaryOpOf(e);
      if (op < 0 || op === BIN_IN || op === BIN_COMMA) return true;
      break;
    }
    default:
      break;
  }
  const parent = exprParent(e);
  const pk = nodeKind(parent);
  const pid = nodeId(parent);
  // For anything but an assignment, `for (var a = (e) in b);` is all there is to an initializer.
  if (pk === N_VAR_DECL && tag !== EXPR_ASSIGN) return isForInStatementInit(e);
  switch (tag) {
    case EXPR_THIS:
    case EXPR_NULL:
    case EXPR_TRUE:
    case EXPR_FALSE:
    case EXPR_BIG_INT:
    case EXPR_REGEX:
    case EXPR_TEMPLATE:
    case EXPR_IMPORT_META:
    case EXPR_NEW_TARGET:
    case EXPR_ARRAY:
      return false;
    case EXPR_NUMBER:
      return pk === N_EXPR && (exprTag(pid) === EXPR_DOT || exprTag(pid) === EXPR_INDEX);
    case EXPR_STRING:
      return pk === N_STMT;
    case EXPR_NEW:
      return pk === N_CLASS;
    case EXPR_DOT:
    case EXPR_INDEX:
    case EXPR_CALL:
    case EXPR_IMPORT_CALL:
    case EXPR_NON_NULL:
    case EXPR_TAGGED_TEMPLATE:
      if (pk === N_EXPR) return exprTag(pid) === EXPR_NEW;
      if (pk === N_STMT) return stmtTag(pid) === STMT_EXPORT_DEFAULT;
      if (pk === N_CLASS) return tag === EXPR_NON_NULL || tag === EXPR_TAGGED_TEMPLATE;
      return false;
    case EXPR_OBJECT:
    case EXPR_FN:
      switch (pk) {
        case N_EXPR:
          return exprTag(pid) !== EXPR_ARRAY && !isArgument(pid, e);
        case N_STMT:
          return stmtTag(pid) !== STMT_RETURN;
        case N_FUNC:
          return tag === EXPR_OBJECT;
        case N_PROP:
        case N_PARAM:
        case N_PAT_PROP:
        case N_PAT_ELEM:
        case N_MEMBER:
          return false;
        default:
          return true;
      }
    case EXPR_ASSIGN:
      if (pk === N_STMT && stmtTag(pid) === STMT_EXPR) {
        const left = exprLeft(e);
        return left < 0 || exprTag(left) === EXPR_OBJECT;
      }
      return true;
    case EXPR_BINARY:
    case EXPR_UNARY:
    case EXPR_COND:
    case EXPR_AS:
    case EXPR_AS_CONST:
    case EXPR_SATISFIES:
    case EXPR_AWAIT:
    case EXPR_YIELD:
      switch (pk) {
        case N_EXPR:
          return !isArgument(pid, e);
        case N_STMT:
          return stmtTag(pid) === STMT_EXPORT_DEFAULT;
        case N_FUNC:
        case N_CASE:
        case N_PARAM:
        case N_PAT_PROP:
        case N_PAT_ELEM:
        case N_MEMBER:
          return false;
        default:
          return true;
      }
    default:
      return true;
  }
}

/** `call` is a call or a `new` and `e` is not what it calls. */
function isArgument(call: number, e: number): boolean {
  const t = exprTag(call);
  return (t === EXPR_CALL || t === EXPR_NEW) && exprCallee(call) !== e;
}

function needsParenthesesWhereItIs(e: number, f: Formatter): boolean {
  const tag = exprTag(e);
  switch (tag) {
    case EXPR_MISSING:
    case EXPR_PRIVATE_IDENTIFIER:
    case EXPR_SUPER:
    case EXPR_SPREAD:
      return false;
    case EXPR_IDENT:
      return identifierNeedsParentheses(e, f);
    case EXPR_THIS:
    case EXPR_NULL:
    case EXPR_TRUE:
    case EXPR_FALSE:
    case EXPR_BIG_INT:
    case EXPR_REGEX:
    case EXPR_TEMPLATE:
    case EXPR_IMPORT_META:
    case EXPR_NEW_TARGET:
      return isForInStatementInit(e) && !isCastTarget(e, f) && !fewInitializersOfForInGetParentheses(f);
    // A pattern is not an expression.
    case EXPR_ARRAY:
    case EXPR_OBJECT:
      if (exprIsAssignmentTarget(e)) return false;
      break;
    // The function of a method is not an expression of its own.
    case EXPR_FN: {
      const fn = exprAsFn(e);
      if (fn >= 0 && !funcIsArrow(fn) && funcKind(fn) !== FN_EXPR) return false;
      break;
    }
    // The `ChainExpression` has them.
    case EXPR_DOT:
    case EXPR_INDEX:
    case EXPR_CALL:
    case EXPR_NON_NULL:
      if (exprIsChainRoot(e)) return false;
      break;
    default:
      break;
  }
  if (isCastTarget(e, f)) return false;

  const parent = exprAstParent(e);

  let startsStatement = false;
  if (tag === EXPR_OBJECT) {
    const body = leftEdgeEnd(e, exprAsChainElement(e));
    const endNode = LEFT_EDGE[1] | 0;
    if (anTag(endNode) === AN_EXPRESSION_STATEMENT) {
      startsStatement = true;
    } else if (anTag(endNode) === AN_ARROW_BODY_EXPRESSION_STATEMENT) {
      // A sequence and an assignment are in parentheses there anyway.
      const bt = exprTag(body);
      startsStatement = !(bt === EXPR_ASSIGN || (bt === EXPR_BINARY && exprBinaryOpOf(body) === BIN_COMMA));
    }
  } else if (tag === EXPR_FN && funcIsArrow(exprAsFn(e))) {
    startsStatement = false;
  } else if (tag === EXPR_FN || tag === EXPR_CLASS) {
    leftEdgeEnd(e, exprAsChainElement(e));
    startsStatement = anTag(LEFT_EDGE[1] | 0) === AN_EXPRESSION_STATEMENT;
  }
  if (startsStatement) return true;

  const answer = parentNeedsParentheses(e, parent, f);
  if (answer >= 0) return answer === 1;

  const pt = anTag(parent);
  const pid = anId(parent);
  switch (tag) {
    case EXPR_NUMBER:
      return numberBeforeBracketsIsBare(f) ? pt === AN_STATIC_MEMBER_EXPRESSION : isMemberObject(e, parent);
    // So that it does not become a directive.
    case EXPR_STRING: {
      if (pt !== AN_EXPRESSION_STATEMENT) return false;
      const gt = anTag(anParent(parent));
      return gt === AN_PROGRAM || gt === AN_FUNCTION_BODY || gt === AN_BLOCK_STATEMENT;
    }
    case EXPR_UNARY: {
      const op = exprUnaryOpOf(e);
      if (pt === AN_UNARY_EXPRESSION) {
        const parentOperator = exprUnaryOpOf(pid);
        switch (op) {
          case UN_PRE_INC:
            return parentOperator === UN_PLUS;
          case UN_PRE_DEC:
            return parentOperator === UN_MINUS;
          case UN_PLUS:
          case UN_MINUS:
            return parentOperator === op;
          default:
            return false;
        }
      }
      if (pt === AN_TAGGED_TEMPLATE_EXPRESSION || pt === AN_TS_NON_NULL_EXPRESSION) return true;
      if (pt === AN_BINARY_EXPRESSION) {
        if (exprLeft(pid) !== e) return false;
        const bop = exprBinaryOpOf(pid);
        if (bop === BIN_POW) return true;
        // `!a instanceof B` was probably meant to be `!(a instanceof B)`. `(!a) instanceof B` shows what it is.
        if (bop === BIN_IN || bop === BIN_INSTANCEOF) return !isUpdateOp(op);
        return false;
      }
      return isMemberObject(e, parent) || anIsCallLikeCallee(parent, e);
    }
    case EXPR_BINARY: {
      const op = exprBinaryOpOf(e);
      if (op === BIN_COMMA) {
        switch (pt) {
          case AN_FOR_STATEMENT:
            return false;
          // Written by `print/return_or_throw_statement.rs` and `print/arrow_function_expression.rs`.
          case AN_RETURN_STATEMENT:
          case AN_THROW_STATEMENT:
            return false;
          case AN_EXPRESSION_STATEMENT:
            return true;
          case AN_ARROW_BODY_EXPRESSION_STATEMENT:
            return false;
          default:
            return true;
        }
      }
      if (isAngularPipe(op, f)) return angularPipeNeedsParentheses(e, parent);
      return pt === AN_UPDATE_EXPRESSION || (op === BIN_IN && isInForStatementInitializer(e, f)) || binaryOrCastNeedsParentheses(e, op, parent, f);
    }
    case EXPR_AS:
    case EXPR_AS_CONST:
    case EXPR_SATISFIES:
      return binaryOrCastNeedsParentheses(e, -1, parent, f);
    case EXPR_YIELD:
    case EXPR_AWAIT:
      switch (pt) {
        case AN_AWAIT_EXPRESSION:
        case AN_TS_TYPE_ASSERTION:
          return tag === EXPR_YIELD;
        case AN_TAGGED_TEMPLATE_EXPRESSION:
        case AN_UNARY_EXPRESSION:
        case AN_LOGICAL_EXPRESSION:
        case AN_BINARY_EXPRESSION:
        case AN_PRIVATE_IN_EXPRESSION:
        case AN_SPREAD_ELEMENT_EXPR:
        case AN_SPREAD_ELEMENT_PROP:
        case AN_TS_AS_EXPRESSION:
        case AN_TS_SATISFIES_EXPRESSION:
        case AN_TS_NON_NULL_EXPRESSION:
          return true;
        case AN_CONDITIONAL_EXPRESSION:
          return exprCondTest(pid) === e;
        default:
          return isMemberObject(e, parent) || anIsCallLikeCallee(parent, e);
      }
    case EXPR_ASSIGN:
      return assignmentNeedsParentheses(e, exprAssignTarget(e), parent, f);
    case EXPR_COND:
      switch (pt) {
        case AN_TAGGED_TEMPLATE_EXPRESSION:
        case AN_UNARY_EXPRESSION:
        case AN_SPREAD_ELEMENT_EXPR:
        case AN_SPREAD_ELEMENT_PROP:
        case AN_BINARY_EXPRESSION:
        case AN_PRIVATE_IN_EXPRESSION:
        case AN_LOGICAL_EXPRESSION:
        case AN_AWAIT_EXPRESSION:
        case AN_JSX_SPREAD_ATTRIBUTE:
        case AN_TS_TYPE_ASSERTION:
        case AN_TYPE_CAST_EXPRESSION:
        case AN_TS_AS_EXPRESSION:
        case AN_TS_SATISFIES_EXPRESSION:
        case AN_TS_NON_NULL_EXPRESSION:
          return true;
        case AN_CONDITIONAL_EXPRESSION:
          return exprCondTest(pid) === e && !f.options.experimentalTernaries;
        default:
          return isMemberObject(e, parent) || anIsCallLikeCallee(parent, e);
      }
    case EXPR_FN: {
      const fn = exprAsFn(e);
      if (fn >= 0 && funcIsArrow(fn)) {
        if (pt === AN_BINARY_EXPRESSION && isAngularPipe(exprBinaryOpOf(pid), f)) return false;
        switch (pt) {
          case AN_BINARY_EXPRESSION:
          case AN_PRIVATE_IN_EXPRESSION:
          case AN_TS_AS_EXPRESSION:
          case AN_TS_SATISFIES_EXPRESSION:
          case AN_TS_NON_NULL_EXPRESSION:
          case AN_TAGGED_TEMPLATE_EXPRESSION:
          case AN_UNARY_EXPRESSION:
          case AN_LOGICAL_EXPRESSION:
          case AN_AWAIT_EXPRESSION:
          case AN_TS_TYPE_ASSERTION:
          case AN_TS_INSTANTIATION_EXPRESSION:
            return true;
          case AN_CONDITIONAL_EXPRESSION:
            return exprCondTest(pid) === e;
          default:
            return isMemberObject(e, parent) || anIsCallLikeCallee(parent, e);
        }
      }
      // An IIFE. A tagged template is much the same.
      return pt === AN_TAGGED_TEMPLATE_EXPRESSION || anIsCallLikeCallee(parent, e);
    }
    case EXPR_CLASS:
      return pt === AN_NEW_EXPRESSION && anIsCallLikeCallee(parent, e);
    case EXPR_DOT:
    case EXPR_INDEX:
    case EXPR_CALL:
    case EXPR_NON_NULL:
    case EXPR_TAGGED_TEMPLATE:
    case EXPR_IMPORT_CALL:
      return pt === AN_NEW_EXPRESSION && anIsCallLikeCallee(parent, e) && hasCallOnLeftEdge(e);
    case EXPR_INSTANTIATION:
      return isMemberObject(e, parent);
    case EXPR_JSX:
      return jsxNeedsParentheses(e, parent, f);
    default:
      return false;
  }
}

function isUpdateOp(op: number): boolean {
  return op === UN_PRE_INC || op === UN_PRE_DEC || op === UN_POST_INC || op === UN_POST_DEC;
}

/** Prettier's `parentNeedsParentheses`: what depends on the parent more than on `e`. -1: not decided; else 0 or 1. */
function parentNeedsParentheses(e: number, parent: number, f: Formatter): number {
  switch (anTag(parent)) {
    // `class A extends (e) {}`
    case AN_CLASS: {
      let superClass = e;
      while (exprTag(superClass) === EXPR_NON_NULL) superClass = exprNonNullExpr(superClass);
      switch (exprTag(superClass)) {
        case EXPR_ASSIGN:
        case EXPR_AWAIT:
        case EXPR_BINARY:
        case EXPR_COND:
        case EXPR_NEW:
        case EXPR_OBJECT:
        case EXPR_TAGGED_TEMPLATE:
        case EXPR_UNARY:
        case EXPR_YIELD:
          return 1;
        case EXPR_FN: {
          const fn = exprAsFn(superClass);
          return fn >= 0 && funcIsArrow(fn) ? 1 : -1;
        }
        case EXPR_CLASS: {
          const cls = exprAsClass(superClass);
          return cls >= 0 && classHasDecorators(cls) ? 1 : -1;
        }
        default:
          return -1;
      }
    }
    case AN_EXPORT_DEFAULT_DECLARATION:
      return shouldWrapFunctionForExportDefault(e, f) ? 1 : -1;
    // Written by `print/decorators.rs`.
    case AN_DECORATOR:
      return 0;
    case AN_VARIABLE_DECLARATOR: {
      if (!isForInStatementInit(e)) return -1;
      if (!fewInitializersOfForInGetParentheses(f)) return 1;
      switch (exprTag(e)) {
        case EXPR_ARRAY:
        case EXPR_OBJECT:
        case EXPR_BINARY:
        case EXPR_FN:
        case EXPR_CLASS:
          return 1;
        default:
          return -1;
      }
    }
    case AN_TS_INSTANTIATION_EXPRESSION: {
      const t = exprTag(e);
      return t === EXPR_AWAIT || t === EXPR_YIELD ? 1 : -1;
    }
    default:
      return -1;
  }
}

function classHasDecorators(cls: number): boolean {
  const s = classModifiersStart(cls);
  const n = classModifiersLen(cls);
  for (let i = 0; i < n; i++) if (modifierDecorator(listAt(s, i)) >= 0) return true;
  return false;
}

/**
 * Prettier's `shouldWrapFunctionForExportDefault`: nothing can follow `export default function` and `export default class`, so
 * `export default (function () {}).a` is `export default (function () {}.a)`.
 */
function shouldWrapFunctionForExportDefault(declaration: number, f: Formatter): boolean {
  let current = declaration;
  const sequenceScratch$ = sequenceScratch;
  while (true) {
    const isDeclaration = current === declaration;
    let isFunctionOrClass = false;
    const t = exprTag(current);
    if (t === EXPR_FN) {
      const fn = exprAsFn(current);
      isFunctionOrClass = fn >= 0 && !funcIsArrow(fn);
    } else if (t === EXPR_CLASS) isFunctionOrClass = true;
    if (isFunctionOrClass) return isDeclaration || !needsParentheses(current, f);
    if (!isDeclaration && expressionNeedsParentheses(current, f)) return false;
    switch (t) {
      case EXPR_BINARY:
        if (exprBinaryOpOf(current) === BIN_COMMA) {
          const base = sequenceScratch$.len;
          exprSequence(current, sequenceScratch$);
          const first = sequenceScratch$.len > base ? sequenceScratch$.data[base] | 0 : -1;
          sequenceScratch$.len = base;
          if (first < 0) return false;
          current = first;
        } else current = exprBinaryLeft(current);
        break;
      case EXPR_ASSIGN:
        current = exprAssignTarget(current);
        break;
      case EXPR_COND:
        current = exprCondTest(current);
        break;
      case EXPR_DOT:
        current = exprDotObj(current);
        break;
      case EXPR_INDEX:
        current = exprIndexObj(current);
        break;
      case EXPR_CALL:
      case EXPR_TAGGED_TEMPLATE:
        current = callCallee(exprAsCallLike(current));
        break;
      case EXPR_UNARY: {
        const op = exprUnaryOpOf(current);
        if (op === UN_POST_INC || op === UN_POST_DEC) current = exprOperandOf(current);
        else return false;
        break;
      }
      case EXPR_AS:
      case EXPR_AS_CONST:
        if (exprIsAngleBracketAssertion(current)) return false;
        current = t === EXPR_AS ? exprAsExpr(current) : exprAsConstExpr(current);
        break;
      case EXPR_SATISFIES:
        current = exprSatisfiesExpr(current);
        break;
      case EXPR_NON_NULL:
        current = exprNonNullExpr(current);
        break;
      default:
        return false;
    }
  }
}

function exprOperandOf(e: number): number {
  return hir.exprA[e] | 0;
}

/**
 * Prettier's `startsWithNoLookaheadToken`, from the bottom up: goes up from `e`, which is `node` (an `AstNodes`), for as long as it is
 * what its parent starts with. Returns the last expression on the way, and writes what that is in (an `AstNodes`) to `LEFT_EDGE[1]` (and
 * the expression to `LEFT_EDGE[0]`).
 */
export function leftEdgeEnd(e: number, node0: number): number {
  let current = e;
  let node = node0;
  const sequenceScratch$ = sequenceScratch;
  while (true) {
    const parent = anParent(node);
    const pid = anId(parent);
    // An IIFE is in parentheses already.
    let isFunction = false;
    if (exprTag(current) === EXPR_FN) {
      const fn = exprAsFn(current);
      isFunction = fn >= 0 && !funcIsArrow(fn);
    }
    let next = -1;
    switch (anTag(parent)) {
      case AN_BINARY_EXPRESSION:
      case AN_LOGICAL_EXPRESSION:
      case AN_ASSIGNMENT_EXPRESSION:
        if (exprLeft(pid) === current) next = pid;
        break;
      case AN_STATIC_MEMBER_EXPRESSION:
      case AN_PRIVATE_FIELD_EXPRESSION:
      case AN_COMPUTED_MEMBER_EXPRESSION:
        if (exprObject(pid) === current) next = pid;
        break;
      case AN_TAGGED_TEMPLATE_EXPRESSION:
        if (!isFunction && exprCallee2(pid) === current) next = pid;
        break;
      case AN_CALL_EXPRESSION:
        if (!isFunction && exprCallee(pid) === current) next = pid;
        break;
      case AN_CONDITIONAL_EXPRESSION:
        if (exprCondTest(pid) === current) next = pid;
        break;
      case AN_UPDATE_EXPRESSION: {
        const op = exprUnaryOpOf(pid);
        if (op === UN_POST_INC || op === UN_POST_DEC) next = pid;
        break;
      }
      case AN_SEQUENCE_EXPRESSION: {
        const base = sequenceScratch$.len;
        exprSequence(pid, sequenceScratch$);
        const first = sequenceScratch$.len > base ? sequenceScratch$.data[base] | 0 : -1;
        sequenceScratch$.len = base;
        if (first === current) next = pid;
        break;
      }
      case AN_CHAIN_EXPRESSION:
      case AN_TS_NON_NULL_EXPRESSION:
      case AN_TS_AS_EXPRESSION:
      case AN_TS_SATISFIES_EXPRESSION:
        next = pid;
        break;
      default:
        break;
    }
    if (next < 0) {
      LEFT_EDGE[0] = current;
      LEFT_EDGE[1] = parent;
      return current;
    }
    current = next;
    node = parent;
  }
}

function exprCallee2(e: number): number {
  const call = exprAsCallLike(e);
  return call < 0 ? -1 : callCallee(call);
}

/** Prettier's `shouldAddParenthesesToIdentifier`. */
function identifierNeedsParentheses(e: number, f: Formatter): boolean {
  // Without escapes, as it is written: `(let)[0]` is `(let)[0]`.
  const atom = exprIdentName(e);
  const buf = nameBuf(atom);
  const start = nameStart(atom);
  const len = nameLen(atom);
  // It stands for an expression in a template that this code is in the text of.
  if (exprIsParenthesized(e) && isPlaceholderInJs(buf, start, len)) return true;
  if (!isNameThatMayNeedParentheses(buf, start, len) || isCastTarget(e, f)) return false;
  const parent = exprAstParent(e);
  const pt = anTag(parent);
  if (nameIs(atom, "async")) {
    // `for ((async) of []);`
    return pt === AN_FOR_OF_STATEMENT && !stmtIsForAwaitOf(anId(parent)) && isLeftOf(anId(parent), e);
  }

  if (nameIs(atom, "let")) {
    const top = leftEdgeEnd(e, mkAn(AN_IDENTIFIER_REFERENCE, e));
    const end = LEFT_EDGE[1] | 0;
    const et = anTag(end);
    // `for ((let) of []);`, `for ((let).a of []);`, `for ((let).a in []);`
    if ((et === AN_FOR_OF_STATEMENT || et === AN_FOR_IN_STATEMENT) && isLeftOf(anId(end), top)) return true;
    // `(let)[a] = 1`
    if (et === AN_EXPRESSION_STATEMENT || et === AN_FOR_STATEMENT) {
      let isStart = true;
      if (et === AN_FOR_STATEMENT) {
        const init = stmtForInit(anId(end));
        isStart = init >= 0 && stmtTag(init) === STMT_EXPR && stmtExprExpr(init) === top;
      }
      if (isStart && pt === AN_COMPUTED_MEMBER_EXPRESSION && exprObject(anId(parent)) === e && !exprIsOptional(anId(parent))) return true;
      // Without a `;`, the next line would be what it declares. Prettier writes it bare.
      if (anIsExpressionStatement(parent) && f.options.semicolons === SEMICOLONS_AS_NEEDED) return true;
    }
  }

  // `(type) satisfies never;`
  let ancestor = parent;
  while (anTag(ancestor) === AN_TS_SATISFIES_EXPRESSION || anTag(ancestor) === AN_TS_AS_EXPRESSION) ancestor = anParent(ancestor);
  return ancestor !== parent && anTag(ancestor) === AN_EXPRESSION_STATEMENT;
}

/** `crate::html::in_js::is_placeholder_in_js(name)`. TODO(port): html. */
function isPlaceholderInJs(buf: Uint8Array, start: number, len: number): boolean {
  return len < 0 && buf.length < 0 && start < 0;
}

function stmtIsForAwaitOf(s: number): boolean {
  return stmtForOfIsAwait(s) !== 0;
}

/** `StmtFields::for_left`: `ForInStatement.left`, `ForOfStatement.left`: a `Var` statement, or the wrapper of an expression. */
function stmtForLeft(s: number): number {
  switch (stmtTag(s)) {
    case STMT_FOR_IN:
      return stmtForInLeft(s);
    case STMT_FOR_OF:
      return stmtForOfLeft(s);
    default:
      return -1;
  }
}

/** `statement.for_left().is_some_and(|it| matches!(it.kind(), StmtKind::Expr(it) if it == left))` */
function isLeftOf(statement: number, left: number): boolean {
  const l = stmtForLeft(statement);
  return l >= 0 && stmtTag(l) === STMT_EXPR && stmtExprExpr(l) === left;
}

function assignmentNeedsParentheses(e: number, left: number, parent: number, f: Formatter): boolean {
  // `[a = 1] = b`
  if (anTag(exprAsChainElement(e)) === AN_ASSIGNMENT_TARGET_WITH_DEFAULT) return false;
  const pt = anTag(parent);
  const pid = anId(parent);
  switch (pt) {
    case AN_FOR_STATEMENT:
      return !isInitOrUpdate(pid, e);
    // `({ a } = b);` would be a block otherwise. `() => (a = b)`
    case AN_ARROW_BODY_EXPRESSION_STATEMENT:
      return true;
    case AN_EXPRESSION_STATEMENT:
      return exprTag(left) === EXPR_OBJECT && exprIsAssignmentTarget(left);
    // `interface A { [a = 1]; }`, `a = b = c`, Prettier's `JsExpressionRoot`
    case AN_TS_PROPERTY_SIGNATURE:
    case AN_ASSIGNMENT_EXPRESSION:
    case AN_PROGRAM:
      return false;
    // `({ a: (b = 1) } = c)`, which is an error. Not `({ [(a = 1)]: b } = c)`.
    case AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY:
      return propValueOf(pid) !== e;
    // `for (a = 1, b = 2; ; a++, b++)`
    case AN_SEQUENCE_EXPRESSION: {
      const gp = anParent(parent);
      return !(anTag(gp) === AN_FOR_STATEMENT && isInitOrUpdate(anId(gp), pid));
    }
    // The statement writes parentheses around a comment and what follows it.
    case AN_RETURN_STATEMENT:
    case AN_THROW_STATEMENT:
      stmtSpan(pid);
      return !hasOwnLineCommentBetween(SP[0] | 0, exprStart(e), f);
    default:
      return true;
  }
}

function propValueOf(prop: number): number {
  return hir.propValue[prop] | 0;
}

/** `for (init; ; update)`: `e` is the update, or the expression that the init is. */
function isInitOrUpdate(statement: number, e: number): boolean {
  if (stmtForUpdate(statement) === e) return true;
  const init = stmtForInit(statement);
  return init >= 0 && stmtTag(init) === STMT_EXPR && stmtExprExpr(init) === e;
}

/** Whether one of the comments between `start` and `end`, printed or not, ends its line or spans several. */
export function hasOwnLineCommentBetween(start: number, end: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  for (let i = cm.printedCount - 1; i >= 0 && (cm.cs[i] | 0) >= start; i--) {
    if (cm.followedByNewline(i) || cm.isMultilineBlock(i)) return true;
  }
  const lim = cm.limit();
  for (let i = cm.printedCount; i < lim && (cm.ce[i] | 0) <= end; i++) {
    if (cm.followedByNewline(i) || cm.isMultilineBlock(i)) return true;
  }
  return false;
}

/**
 * `<T>a | 0`: Prettier puts `<T>a` in parentheses next to `|`, `&`, `^` and the shifts. oxfmt only where it has to: before and after `<<`,
 * and before `**`.
 */
function typeAssertionIsLikeUnaryExpression(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** For a `BinaryExpression`, a `LogicalExpression`, `a as T`, `a satisfies T` and `<T>a`. `operator`: of the first two (-1 for the others). */
function binaryOrCastNeedsParentheses(e: number, operator: number, parent: number, f: Formatter): boolean {
  const isTypeAssertion = operator < 0 && exprIsAngleBracketAssertion(e);
  const isBinaryCast = operator < 0 && !isTypeAssertion;
  // Flow's `(e: T)` has its own.
  if (isTypeAssertion && fileIsFlow()) return false;
  const pt = anTag(parent);
  const pid = anId(parent);
  let parentBinary = -1;
  switch (pt) {
    // `a as unknown as T`
    case AN_TS_AS_EXPRESSION:
    case AN_TS_SATISFIES_EXPRESSION:
      return !isBinaryCast;
    case AN_CONDITIONAL_EXPRESSION:
      return isBinaryCast || operator === BIN_NULLISH;
    case AN_CLASS:
    case AN_TS_TYPE_ASSERTION:
    case AN_TAGGED_TEMPLATE_EXPRESSION:
    case AN_JSX_SPREAD_ATTRIBUTE:
    case AN_SPREAD_ELEMENT_EXPR:
    case AN_SPREAD_ELEMENT_PROP:
    case AN_AWAIT_EXPRESSION:
    case AN_TS_NON_NULL_EXPRESSION:
    case AN_UPDATE_EXPRESSION:
      return true;
    // It writes parentheses around an argument with comments. For oxfmt `a as T` has its own in them.
    case AN_UNARY_EXPRESSION:
      return (isBinaryCast && f.options.flavor === FLAVOR_OXFMT) || !unaryArgumentHasComments(pid, e, f);
    case AN_ASSIGNMENT_EXPRESSION:
    case AN_ASSIGNMENT_TARGET_WITH_DEFAULT:
      return operator < 0 && exprLeft(pid) === e;
    case AN_LOGICAL_EXPRESSION:
      if (operator >= 0 && binOpIsLogical(operator)) return exprBinaryOpOf(pid) !== operator;
      parentBinary = pid;
      break;
    case AN_BINARY_EXPRESSION:
    case AN_PRIVATE_IN_EXPRESSION:
      parentBinary = pid;
      break;
    default:
      return isMemberObject(e, parent) || anIsCallLikeCallee(parent, e);
  }
  if (exprTag(parentBinary) !== EXPR_BINARY) return false;
  const parentOperator = exprBinaryOp(parentBinary);
  const right = exprBinaryRight(parentBinary);
  if (isAngularPipe(parentOperator, f)) return false;
  const parentPrecedence = binOpPrecedence(parentOperator);
  const isParentBitwise = precedenceIsBitwise(parentPrecedence) || precedenceIsShift(parentPrecedence);
  if (operator < 0) {
    if (isTypeAssertion && typeAssertionIsLikeUnaryExpression(f)) return parentOperator === BIN_SHL || (parentOperator === BIN_POW && right !== e);
    return isBinaryCast || isParentBitwise;
  }
  const precedence = binOpPrecedence(operator);
  return (
    parentPrecedence > precedence ||
    // `a ** (b ** c)`
    (parentPrecedence === precedence && (right === e || !shouldFlatten(parentOperator, operator))) ||
    // `(a % 4) + 4`
    (parentPrecedence < precedence && binOpIsRemainder(operator) && precedenceIsAdditive(parentPrecedence)) ||
    // `(a * 3) >> 5`
    isParentBitwise
  );
}

/** For Prettier's `NGPipeExpression`. One that is an argument of a pipe is written in parentheses by that pipe. */
function angularPipeNeedsParentheses(e: number, parent: number): boolean {
  const pid = anId(parent);
  switch (anTag(parent)) {
    case AN_PROGRAM:
    case AN_ARRAY_EXPRESSION:
    case AN_ASSIGNMENT_EXPRESSION:
      return false;
    // AngularJS needs those that are there.
    case AN_OBJECT_PROPERTY:
      return exprIsParenthesized(e);
    case AN_CALL_EXPRESSION:
      return exprCallee(pid) === e;
    // Babel's `MemberExpression`, not its `OptionalMemberExpression`.
    case AN_COMPUTED_MEMBER_EXPRESSION:
      return exprObject(pid) === e || isOptionalMemberExpressionOfBabel(pid);
    default:
      return true;
  }
}

/** Whether `angular-estree-parser` makes an `OptionalMemberExpression` or an `OptionalCallExpression` of `e`. A tagged template ends an optional chain there. */
function isOptionalMemberExpressionOfBabel(e0: number): boolean {
  let e = e0;
  while (true) {
    let head = -1;
    switch (exprTag(e)) {
      case EXPR_DOT:
      case EXPR_INDEX:
        if (exprIsOptional(e)) return true;
        head = exprObject(e);
        break;
      case EXPR_CALL:
        if (exprIsOptional(e)) return true;
        head = exprCallee(e);
        break;
      case EXPR_NON_NULL:
        head = exprNonNullExpr(e);
        break;
      default:
        break;
    }
    if (head >= 0 && !exprIsParenthesized(head)) e = head;
    else return false;
  }
}

/** Prettier's `isPathInForStatementInitializer`: `in` would end the initializer of a `for` statement, `for (var a = (b in c); ; )`. */
function isInForStatementInitializer(e: number, f: Formatter): boolean {
  const endsEarly = searchForInitializerEndsAtStatements(f);
  let a = exprAstParent(e);
  while (true) {
    let isEnd = false;
    switch (anTag(a)) {
      case AN_FOR_STATEMENT: {
        const init = stmtForInit(anId(a));
        if (init >= 0) {
          stmtSpan(init);
          const s = SP[0] | 0;
          const en = SP[1] | 0;
          exprSpan(e);
          if (s <= (SP[0] | 0) && (SP[1] | 0) <= en) return true;
        }
        isEnd = true;
        break;
      }
      case AN_EXPRESSION_STATEMENT:
        isEnd = anTag(anParent(a)) !== AN_FUNCTION_BODY;
        break;
      case AN_FOR_IN_STATEMENT:
        isEnd = true;
        break;
      default:
        break;
    }
    if (isEnd && endsEarly) return false;
    if (anTag(a) === AN_PROGRAM) return false;
    a = anParent(a);
  }
}

/**
 * oxc's `is_in_for_initializer` looks no further than the first `for` statement of any kind, or the first expression statement that is not
 * right in the body of a function. Prettier looks at everything around the expression.
 */
function searchForInitializerEndsAtStatements(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `for (var a = 1 in b);`: oxfmt writes the parentheses around an array, an object, a function, a class, and what has an operator. Prettier writes them around everything. */
function fewInitializersOfForInGetParentheses(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `4["a"]` for oxfmt, `(4)["a"]` for Prettier. */
function numberBeforeBracketsIsBare(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `for (var a = (e) in b);`, which is only allowed in sloppy mode. */
function isForInStatementInit(e: number): boolean {
  const declarator = exprParent(e);
  if (nodeKind(declarator) !== N_VAR_DECL) return false;
  const d = nodeId(declarator);
  const declaration = varDeclParent(d);
  if (nodeKind(declaration) !== N_STMT) return false;
  if (varDeclInit(d) !== e) return false;
  const outer = stmtParent(nodeId(declaration));
  return nodeKind(outer) === N_STMT && stmtTag(nodeId(outer)) === STMT_FOR_IN && stmtForInLeft(nodeId(outer)) === nodeId(declaration);
}

/** `e.a`, `e[a]` */
function isMemberObject(e: number, parent: number): boolean {
  switch (anTag(parent)) {
    case AN_STATIC_MEMBER_EXPRESSION:
    case AN_PRIVATE_FIELD_EXPRESSION:
      return true;
    case AN_COMPUTED_MEMBER_EXPRESSION:
      return exprObject(anId(parent)) === e;
    default:
      return false;
  }
}

/** Whether there is a call down the left edge of `e`: `new (a().b)()`. */
function hasCallOnLeftEdge(e: number): boolean {
  let current = e;
  while (true) {
    // What is in a `ChainExpression` is in parentheses.
    if (current !== e && exprIsChainRoot(current)) return false;
    switch (exprTag(current)) {
      case EXPR_CALL:
      case EXPR_IMPORT_CALL:
        return true;
      case EXPR_INDEX:
        current = exprIndexObj(current);
        break;
      case EXPR_DOT:
        current = exprDotObj(current);
        break;
      case EXPR_TAGGED_TEMPLATE:
        current = callCallee(exprAsCallLike(current));
        break;
      case EXPR_NON_NULL:
        current = exprNonNullExpr(current);
        break;
      default:
        return false;
    }
  }
}

/** Prettier has a list of what JSX needs no parentheses in, oxfmt has one of what it needs them in. In neither: `class A { b = (<c />); }`, `` `${(<a />)}` ``, `if ((<a />)) {}`. */
function listsWhatJsxNeedsParenthesesIn(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

function jsxNeedsParentheses(e: number, parent: number, f: Formatter): boolean {
  const pt = anTag(parent);
  if (pt === AN_BINARY_EXPRESSION) return exprBinaryOpOf(anId(parent)) === BIN_LT && exprLeft(anId(parent)) === e;
  if (pt === AN_CALL_EXPRESSION || pt === AN_NEW_EXPRESSION) return anIsCallLikeCallee(parent, e);
  if (listsWhatJsxNeedsParenthesesIn(f)) {
    switch (pt) {
      case AN_CLASS:
      case AN_TS_AS_EXPRESSION:
      case AN_TS_SATISFIES_EXPRESSION:
      case AN_AWAIT_EXPRESSION:
      case AN_STATIC_MEMBER_EXPRESSION:
      case AN_COMPUTED_MEMBER_EXPRESSION:
      case AN_SEQUENCE_EXPRESSION:
      case AN_UNARY_EXPRESSION:
      case AN_TS_NON_NULL_EXPRESSION:
      case AN_SPREAD_ELEMENT_EXPR:
      case AN_SPREAD_ELEMENT_PROP:
      case AN_TAGGED_TEMPLATE_EXPRESSION:
      case AN_JSX_SPREAD_ATTRIBUTE:
      case AN_JSX_SPREAD_CHILD:
        return true;
      default:
        return false;
    }
  }
  switch (pt) {
    case AN_ARRAY_EXPRESSION:
    case AN_PRIVATE_IN_EXPRESSION:
    case AN_ASSIGNMENT_EXPRESSION:
    case AN_ASSIGNMENT_PATTERN_PROP:
    case AN_ASSIGNMENT_PATTERN_ELEM:
    case AN_ASSIGNMENT_TARGET_WITH_DEFAULT:
    case AN_FORMAL_PARAMETER:
    case AN_CONDITIONAL_EXPRESSION:
    case AN_EXPRESSION_STATEMENT:
    case AN_ARROW_BODY_EXPRESSION_STATEMENT:
    case AN_PROGRAM:
    case AN_JSX_ATTRIBUTE:
    case AN_JSX_ELEMENT:
    case AN_JSX_FRAGMENT:
    case AN_JSX_EXPRESSION_CONTAINER:
    case AN_LOGICAL_EXPRESSION:
    case AN_OBJECT_PROPERTY:
    case AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY:
    case AN_RETURN_STATEMENT:
    case AN_THROW_STATEMENT:
    case AN_VARIABLE_DECLARATOR:
    case AN_YIELD_EXPRESSION:
    case AN_TYPE_CAST_EXPRESSION:
    case AN_EXPORT_DEFAULT_DECLARATION:
      return false;
    default:
      return true;
  }
}

