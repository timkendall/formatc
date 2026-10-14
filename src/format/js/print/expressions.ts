// Port of vendor/bun/src/format/js/print/expressions.rs: the expressions that take only a few lines each.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { ELLIPSIS, EQ, LBRACKET, LPAREN, QUESTION, RBRACKET, RPAREN } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT, QUOTE_PROPS_CONSISTENT, htmlRootIsAngular } from "../../options.ts";
import {
  BIN_COMMA,
  EXPR_ARRAY,
  EXPR_BINARY,
  EXPR_IMPORT_META,
  EXPR_JSX,
  EXPR_MISSING,
  EXPR_OBJECT,
  EXPR_SPREAD,
  N_EXPR,
  PROP_GETTER,
  PROP_SETTER,
  PROP_SHORTHAND,
  PROP_SPREAD,
  SP,
  KEY_NONE,
  callArgsLen,
  callArgsStart,
  callCallee,
  exprArrayElemsLen,
  exprArrayElemsStart,
  exprAsExpr,
  exprAssignTarget,
  exprAssignValue,
  exprBinaryOpOf,
  exprCallCall,
  exprCallee,
  exprIsChainRoot,
  exprIndexObj,
  exprObjectPropsLen,
  exprObjectPropsStart,
  exprOuterEnd,
  exprParent,
  exprRight,
  exprSpan,
  exprStart,
  exprTag,
  funcHasBody,
  keyLoad,
  keySpan,
  funcIsAsync,
  funcIsGenerator,
  listAt,
  nodeId,
  nodeKind,
  nodeOfProp,
  propFunc,
  propIsOptional,
  propKind,
  propSpan,
  propValue,
  unOpText,
} from "../../../lint/ast/index.ts";
import {
  AN_ARROW_BODY_EXPRESSION_STATEMENT,
  AN_ASSIGNMENT_TARGET_PROPERTY_IDENTIFIER,
  AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY,
  AN_ASSIGNMENT_TARGET_REST,
  AN_ASSIGNMENT_TARGET_WITH_DEFAULT,
  AN_AWAIT_EXPRESSION,
  AN_BINARY_EXPRESSION,
  AN_CALL_EXPRESSION,
  AN_COMPUTED_MEMBER_EXPRESSION,
  AN_CONDITIONAL_EXPRESSION,
  AN_JSX_ATTRIBUTE,
  AN_JSX_SPREAD_ATTRIBUTE,
  AN_LOGICAL_EXPRESSION,
  AN_NEW_EXPRESSION,
  AN_OBJECT_EXPRESSION,
  AN_OBJECT_PROPERTY,
  AN_PRIVATE_FIELD_EXPRESSION,
  AN_SPREAD_ELEMENT_PROP,
  AN_STATIC_MEMBER_EXPRESSION,
  AN_UNARY_EXPRESSION,
  anId,
  anParent,
  anTag,
  exprAsChainElement,
  exprAstParent,
  mkAn,
  propAsAstNodes,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { exprAlternate, exprExpression, exprTypeAnnotation } from "../fields.ts";
import {
  PK_NODE,
  WK_EXPR,
  enterScope,
  fmtChainElementExpr,
  fmtExpr,
  fmtType,
  leaveScope,
  writeTrailingCommentsIn,
} from "../format.ts";
import { LEFT_EDGE, leftEdgeEnd } from "../parentheses/expression.ts";
import { DANGLING_SOFT, formatDanglingComments, formatLeadingComments, formatLeadingCommentsRange } from "../trivia.ts";
import { writeArrayNode } from "../utils/array.ts";
import {
  ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION,
  ASSIGNMENT_LIKE_OBJECT_PROPERTY,
  commentsStayAroundOperator,
  fmtAssignmentLike,
} from "../utils/assignment_like.ts";
import { CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION, fmtConditionalLike } from "../utils/conditional.ts";
import { formatComputedOrPropertyKey, shouldPreserveQuote } from "../utils/object.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { isArgumentOfAngularPipe } from "./binary_like_expression.ts";
import { formatGroupedParametersWithReturnTypeForMethod } from "./class.ts";
import { fmtFunctionBody } from "./function.ts";
import { writeJsxAttribute } from "./jsx/mod.ts";
import { writeObjectLikeExpression } from "./object_like.ts";
import { writeObjectPatternLikeAssignmentTarget } from "./object_pattern_like.ts";
import { hasArgumentLeadingComments } from "./return_or_throw_statement.ts";

import { unOpIsKeyword, unOpIsPrefix } from "../utils/operators.ts";

const T_ASYNC_SP = token("async ");
const T_GET = token("get");
const T_SET = token("set");
const T_YIELD = token("yield");
const T_STAR = token("*");
const T_AWAIT = token("await");
const T_IMPORT_META = token("import.meta");
const T_NEW_TARGET = token("new.target");
const T_NEW_DOT = token("new.");
const T_LT = token("<");
const T_GT = token(">");
const T_LT_CONST_GT = token("<const>");

/** The token of each operator, by `UN_*` (11 operators). */
const UN_TOKENS = new Int32Array(16);
for (let op = 0; op <= 10; op++) UN_TOKENS[op] = token(unOpText(op)) | 0;

/** All of `a?.b.c`. */
export function writeChainExpression(e: number, f: Formatter): void {
  fmtChainElementExpr(e, f);
}

/**
 * Prettier's `isFollowedByRightBracket`, for an object between `{{` and `}}` in HTML that is written without spaces in its braces: the `}` of another
 * object follows its own, and `}}` would be the end.
 */
function isFollowedByRightBracketInHtml(e: number, f: Formatter): boolean {
  const inHtml = f.options.inHtml;
  if (!inHtml.isInInterpolation || f.options.bracketSpacing) return false;
  let current = e;
  while (true) {
    const parent = exprAstParent(current);
    const pt = anTag(parent);
    const pid = anId(parent);
    if (pt === AN_OBJECT_PROPERTY) {
      if (propValue(pid) !== current) return false;
      const object = anParent(parent);
      if (anTag(object) !== AN_OBJECT_EXPRESSION) return false;
      const oid = anId(object);
      const n = exprObjectPropsLen(oid);
      return n > 0 && listAt(exprObjectPropsStart(oid), n - 1) === pid;
    } else if (pt === AN_BINARY_EXPRESSION || pt === AN_LOGICAL_EXPRESSION) {
      if (exprRight(pid) !== current) return false;
      current = pid;
    } else if (pt === AN_CONDITIONAL_EXPRESSION) {
      if (exprAlternate(pid) !== current) return false;
      current = pid;
    } else if (pt === AN_UNARY_EXPRESSION) {
      current = pid;
    } else if (pt === AN_CALL_EXPRESSION) {
      // The last argument of a pipe of Angular.
      if (!htmlRootIsAngular(inHtml.root) || !isArgumentOfAngularPipe(current)) return false;
      const call = exprCallCall(pid);
      const n = callArgsLen(call);
      if (n === 0 || listAt(callArgsStart(call), n - 1) !== current) return false;
      const up = exprParent(pid);
      if (nodeKind(up) !== N_EXPR) return false;
      current = nodeId(up);
    } else return false;
  }
}

/** `{ a: 1 }` */
export function writeObjectExpression(e: number, propsStart: number, propsLen: number, f: Formatter): void {
  if (isFollowedByRightBracketInHtml(e, f)) {
    f.token(LPAREN);
    writeObjectExpressionWithoutParentheses(e, propsStart, propsLen, f);
    f.token(RPAREN);
    return;
  }
  writeObjectExpressionWithoutParentheses(e, propsStart, propsLen, f);
}

function writeObjectExpressionWithoutParentheses(e: number, propsStart: number, propsLen: number, f: Formatter): void {
  const isConsistent = f.options.quoteProperties === QUOTE_PROPS_CONSISTENT;
  const cx = cxOf(f);
  if (isConsistent) {
    let quoteNeeded = false;
    for (let i = 0; i < propsLen; i++) {
      const property = listAt(propsStart, i);
      if (propKind(property) !== PROP_SPREAD && shouldPreserveQuote(nodeOfProp(property), f)) {
        quoteNeeded = true;
        break;
      }
    }
    cx.pushQuoteNeeded(quoteNeeded);
  }
  writeObjectLikeExpression(e, propsStart, propsLen, f);
  if (isConsistent) cx.popQuoteNeeded();
}

/** A property of an object literal, of the target of a destructuring assignment, or an attribute of a JSX element. */
export function writeProperty(property: number, f: Formatter): void {
  const node = propAsAstNodes(property);
  const t = anTag(node);
  if (t === AN_JSX_ATTRIBUTE || t === AN_JSX_SPREAD_ATTRIBUTE) {
    writeJsxAttribute(property, f);
  } else if (t === AN_SPREAD_ELEMENT_PROP || t === AN_ASSIGNMENT_TARGET_REST) {
    f.token(ELLIPSIS);
    const value = propValue(property);
    if (value >= 0) fmtExpr(value, f);
  } else if (t === AN_ASSIGNMENT_TARGET_PROPERTY_IDENTIFIER) {
    // `{ a }`, `{ a = 1 }`
    const value = propValue(property);
    if (value >= 0) fmtExpr(value, f);
  } else if (t === AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY) {
    fmtAssignmentLike(ASSIGNMENT_LIKE_OBJECT_PROPERTY, property, f);
  } else {
    writeObjectProperty(property, f);
  }
}

/** `FormatObjectMember(property).fmt(f)`: a property of an object literal that is not the target of a destructuring assignment. */
export function fmtObjectMember(property: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    writeObjectMember(property, f);
    return;
  }
  // format_node(property.span(), || property.as_ast_nodes().parent(), f, write)
  propSpan(property);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    writeObjectMember(property, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_NODE, propAsAstNodes(property), f);
}

function writeObjectMember(property: number, f: Formatter): void {
  if (propKind(property) === PROP_SPREAD) {
    f.token(ELLIPSIS);
    const value = propValue(property);
    if (value >= 0) fmtExpr(value, f);
  } else writeObjectProperty(property, f);
}

/** A property of an object literal that is not the target of a destructuring assignment. */
function writeObjectProperty(property: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const SP$ = SP;
  if (!cx.isQuiet) {
    propSpan(property);
    if (cm.hasTrailingSuppressionComment(SP$.s1 | 0)) {
      writeSuppressedNode(SP$.s0 | 0, SP$.s1 | 0, f);
      return;
    }
  }
  const value = propFunc(property);
  if (value < 0) {
    // Prettier's `handlePropertyComments`: a comment at the end of the line of the key leads the property.
    if (!cx.isQuiet && !commentsStayAroundOperator(f) && propKind(property) !== PROP_SHORTHAND) {
      const owner = nodeOfProp(property);
      const v = propValue(property);
      if (keyLoad(owner) !== KEY_NONE && v >= 0 && keySpan(owner)) {
        const keyStart = SP$.s0 | 0;
        const keyEnd = SP$.s1 | 0;
        if (!cm.hasCommentInRange(keyStart, keyEnd)) {
          const n = cm.commentsLeadingProperty(keyEnd, exprStart(v));
          const from = cm.from;
          for (let i = 0; i < n; i++) {
            if (cm.isSuppressionComment((from + i) | 0)) {
              propSpan(property);
              writeSuppressedNode(SP$.s0 | 0, SP$.s1 | 0, f);
              return;
            }
          }
          formatLeadingCommentsRange(from, (from + n) | 0, f);
        }
      }
    }
    fmtAssignmentLike(ASSIGNMENT_LIKE_OBJECT_PROPERTY, property, f);
    return;
  }
  const kind = propKind(property);
  if (kind === PROP_GETTER) {
    f.token(T_GET);
    f.space();
  } else if (kind === PROP_SETTER) {
    f.token(T_SET);
    f.space();
  }
  if (funcIsAsync(value)) f.token(T_ASYNC_SP);
  if (funcIsGenerator(value)) f.token(T_STAR);
  formatComputedOrPropertyKey(nodeOfProp(property), mkAn(AN_OBJECT_PROPERTY, property), f);
  // An error.
  if (propIsOptional(property)) f.token(QUESTION);
  formatGroupedParametersWithReturnTypeForMethod(value, f);
  if (funcHasBody(value)) {
    f.space();
    fmtFunctionBody(value, f);
  }
}

/** `import.meta`, `new.target` */
export function writeMetaProperty(e: number, f: Formatter): void {
  if (exprTag(e) === EXPR_IMPORT_META) {
    f.token(T_IMPORT_META);
    return;
  }
  exprSpan(e);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  const text = f.source;
  // With its escapes: `new.t\u0061rget`, `new.t\u{61}rget`.
  let name = start;
  for (let i = end - 1; i >= start; i--) {
    const b = text[i] | 0;
    const isInName = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95 || b === 36 || b === 92 || b === 123 || b === 125 || b >= 0x80;
    if (!isInName) {
      name = i + 1;
      break;
    }
  }
  const isTarget =
    end - name === 6 &&
    (text[name] | 0) === 116 &&
    (text[name + 1] | 0) === 97 &&
    (text[name + 2] | 0) === 114 &&
    (text[name + 3] | 0) === 103 &&
    (text[name + 4] | 0) === 101 &&
    (text[name + 5] | 0) === 116;
  if (isTarget) f.token(T_NEW_TARGET);
  else {
    // An error: `new.targ`.
    f.token(T_NEW_DOT);
    f.sourceText(name, end);
  }
}

/** `++a`, `a--` */
export function writeUpdateExpression(op: number, operand: number, f: Formatter): void {
  if (unOpIsPrefix(op)) {
    f.token(UN_TOKENS[op] | 0);
    fmtExpr(operand, f);
  } else {
    fmtExpr(operand, f);
    f.token(UN_TOKENS[op] | 0);
  }
}

/** `!a`, `typeof a` */
export function writeUnaryExpression(e: number, op: number, operand: number, f: Formatter): void {
  f.token(UN_TOKENS[op] | 0);
  if (unOpIsKeyword(op)) f.space();
  if (!cxOf(f).isQuiet && unaryArgumentHasComments(e, operand, f)) {
    f.startGroup();
    f.token(LPAREN);
    f.startSoftBlockIndent();
    fmtExpr(operand, f);
    f.endSoftBlockIndent();
    f.token(RPAREN);
    f.endGroup();
  } else fmtExpr(operand, f);
}

/** Whether a comment leads or trails `argument`, which is the operand of `unary`. The answer does not depend on which comments are printed already. */
export function unaryArgumentHasComments(unary: number, argument: number, f: Formatter): boolean {
  const cx = cxOf(f);
  // Prettier attaches no comment to a `ChainExpression`, so what is in it has them.
  if (f.options.flavor !== FLAVOR_OXFMT && !cx.hasTreeOfBabel && exprIsChainRoot(argument)) return false;
  const cm = cx.comments;
  exprSpan(unary);
  const SP$ = SP;
  const outerStart = SP$.s0 | 0;
  const outerEnd = SP$.s1 | 0;
  exprSpan(argument);
  const innerStart = SP$.s0 | 0;
  const innerEnd = SP$.s1 | 0;
  const lastPrinted = cm.lastPrinted();
  if (lastPrinted >= 0 && (cm.cs[lastPrinted] | 0) >= outerStart && (cm.ce[lastPrinted] | 0) <= innerStart) return true;
  const n = cm.unprinted();
  if (n === 0) return false;
  const from = cm.from;
  const to = cm.to;
  if ((cm.cs[from] | 0) >= outerEnd) return false;
  if ((cm.cs[from] | 0) >= outerStart && (cm.ce[from] | 0) <= innerStart) return true;
  let after = from;
  while (after < to && (cm.cs[after] | 0) < innerEnd) after = (after + 1) | 0;
  for (let i = after; i < to && (cm.ce[i] | 0) <= outerEnd; i++) {
    if (!isLastBinaryOperandComment(argument, i, f)) return true;
  }
  return false;
}

/**
 * Prettier's `handleLastBinaryOperatorOperand`: whether `comment` (a comment index), which is after `argument`, the operand of a unary expression,
 * trails the last operand of `argument` and not all of it:
 *
 * ```javascript
 * !(
 *   a || // 1
 *   b // 2
 * );
 * ```
 */
export function isLastBinaryOperandComment(argument: number, comment: number, f: Formatter): boolean {
  if (exprTag(argument) !== EXPR_BINARY) return false;
  const op = exprBinaryOpOf(argument);
  if (op === BIN_COMMA) return false;
  // For oxfmt a comment before the `)` trails all that is in the parentheses here as everywhere else, and breaks no chain of operators.
  if (f.options.flavor === FLAVOR_OXFMT) return false;
  const cx = cxOf(f);
  const cm = cx.comments;
  if (cm.precededByNewline(comment) || !cm.followedByNewline(comment) || cm.isMultilineBlock(comment)) return false;
  const right = exprRight(argument);
  const argumentStart = exprStart(argument);
  const rightStart = exprStart(right);
  const src = cx.src;
  return src.containsNewline(argumentStart, rightStart) && !src.containsNewline(rightStart, cm.spanStart[comment] | 0);
}

/** `a = b`, `a += b`. In the target of a destructuring assignment, a target with its default value. */
export function writeAssignmentExpression(e: number, f: Formatter): void {
  if (anTag(exprAsChainElement(e)) === AN_ASSIGNMENT_TARGET_WITH_DEFAULT) {
    fmtExpr(exprAssignTarget(e), f);
    f.space();
    f.token(EQ);
    f.space();
    fmtExpr(exprAssignValue(e), f);
    return;
  }
  fmtAssignmentLike(ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION, e, f);
}

/** `a ? b : c` */
export function writeConditionalExpression(e: number, f: Formatter): void {
  fmtConditionalLike(CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION, e, f);
}

/** `[a, b] = c` */
export function writeArrayAssignmentTarget(e: number, elementsStart: number, elementsLen: number, f: Formatter): void {
  f.token(LBRACKET);
  const SP$ = SP;
  if (elementsLen === 0) {
    exprSpan(e);
    formatDanglingComments(SP$.s0 | 0, SP$.s1 | 0, DANGLING_SOFT, f);
  } else {
    const last = listAt(elementsStart, elementsLen - 1);
    const rest = exprTag(last) === EXPR_SPREAD ? last : -1;
    const count = elementsLen - (rest >= 0 ? 1 : 0);
    f.startGroup();
    f.startSoftBlockIndent();
    if (count > 0) writeArrayNode(elementsLen, WK_EXPR, elementsStart, count, f);
    if (rest >= 0) fmtExpr(rest, f);
    f.endSoftBlockIndent();
    f.endGroup();
  }
  f.token(RBRACKET);
}

/** `({ a, b } = c)` */
export function writeObjectAssignmentTarget(e: number, propsStart: number, propsLen: number, f: Formatter): void {
  writeObjectPatternLikeAssignmentTarget(e, propsStart, propsLen, f);
}

/** `await a` */
export function writeAwaitExpression(e: number, argument: number, f: Formatter): void {
  const parent = exprAstParent(e);
  const pt = anTag(parent);
  let isCalleeOrObject = false;
  if (pt === AN_STATIC_MEMBER_EXPRESSION || pt === AN_PRIVATE_FIELD_EXPRESSION) isCalleeOrObject = true;
  else if (pt === AN_COMPUTED_MEMBER_EXPRESSION) isCalleeOrObject = exprIndexObj(anId(parent)) === e;
  else if (pt === AN_CALL_EXPRESSION) isCalleeOrObject = callCallee(exprCallCall(anId(parent))) === e;
  // `new (await a())()`
  else if (pt === AN_NEW_EXPRESSION) isCalleeOrObject = exprCallee(anId(parent)) === e && f.options.flavor === FLAVOR_OXFMT;
  if (!isCalleeOrObject) {
    f.token(T_AWAIT);
    f.space();
    fmtExpr(argument, f);
    return;
  }
  // `await (await a).b`: the parentheses break along with what the outer `await` is in.
  leftEdgeEnd(e, mkAn(AN_AWAIT_EXPRESSION, e));
  const isInAwait = anTag(LEFT_EDGE[1] | 0) === AN_AWAIT_EXPRESSION;
  if (!isInAwait) f.startGroup();
  f.startSoftBlockIndent();
  f.token(T_AWAIT);
  f.space();
  fmtExpr(argument, f);
  f.endSoftBlockIndent();
  if (!isInAwait) f.endGroup();
}

/** oxfmt, like Prettier 3.8, writes the argument of `yield` as that of `return`. */
function yieldWritesItsArgumentAsReturnDoes(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `yield a`, `yield* a` */
export function writeYieldExpression(argument: number /* -1: none */, delegate: boolean, f: Formatter): void {
  f.token(T_YIELD);
  if (delegate) f.token(T_STAR);
  if (argument < 0) return;
  f.space();
  const asReturn = yieldWritesItsArgumentAsReturnDoes(f);
  if (!cxOf(f).isQuiet && asReturn && exprTag(argument) !== EXPR_JSX && hasArgumentLeadingComments(argument, f)) {
    f.token(LPAREN);
    f.startBlockIndent();
    fmtExpr(argument, f);
    f.endBlockIndent();
    f.token(RPAREN);
    return;
  }
  const isBinaryish = exprTag(argument) === EXPR_BINARY && exprBinaryOpOf(argument) !== BIN_COMMA;
  if (isBinaryish && asReturn) {
    f.startGroup();
    f.tokenIfBreaks(LPAREN);
    f.startSoftBlockIndent();
    fmtExpr(argument, f);
    f.endSoftBlockIndent();
    f.tokenIfBreaks(RPAREN);
    f.endGroup();
  } else fmtExpr(argument, f);
}

/** `<T>a` */
export function writeTsTypeAssertion(e: number, f: Formatter): void {
  const expression = exprExpression(e);
  if (expression < 0) return;
  const ty = exprTypeAnnotation(e);
  const et = exprTag(expression);
  if (et === EXPR_ARRAY || et === EXPR_OBJECT) {
    writeCast(ty, f);
    fmtExpr(expression, f);
    return;
  }
  let slot = f.startCapture();
  writeCast(ty, f);
  const cast = f.endCapture(slot);
  slot = f.startCapture();
  fmtExpr(expression, f);
  const expr = f.endCapture(slot);

  let s = f.startVariant();
  f.writeInterned(cast);
  f.writeInterned(expr);
  const v0 = f.endVariant(s);

  s = f.startVariant();
  f.writeInterned(cast);
  f.startGroup();
  f.token(LPAREN);
  f.startBlockIndent();
  f.writeInterned(expr);
  f.endBlockIndent();
  f.token(RPAREN);
  f.endGroup();
  const v1 = f.endVariant(s);

  s = f.startVariant();
  f.writeInterned(cast);
  f.writeInterned(expr);
  const v2 = f.endVariant(s);

  f.bestFitting3(v0, v1, v2);
}

function writeCast(ty: number, f: Formatter): void {
  if (ty >= 0) {
    f.token(T_LT);
    f.startGroup();
    f.startSoftBlockIndent();
    fmtType(ty, f);
    f.endSoftBlockIndent();
    f.endGroup();
    f.token(T_GT);
  } else f.token(T_LT_CONST_GT);
}
