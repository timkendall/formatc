// Port of vendor/bun/src/format/js/utils/conditional.rs: `a ? b : c` and `A extends B ? C : D`. Prettier's `printTernary`.
//
// `ConditionalLike::X(h)` is `(kind, h)`: `fmtConditionalLike(kind, h, f)`. An `Operand` (an expression or a type) is `(isType, h)`.
import { Formatter } from "../../ir/formatter.ts";
import { LPAREN, RPAREN } from "../../ir/tokens.ts";
import { token } from "../../ir/element.ts";
import { I32Vec } from "../../../base/i32vec.ts";
import { INDENT_SPACE } from "../../options.ts";
import {
  EXPR_COND,
  EXPR_JSX,
  EXPR_IDENT,
  EXPR_NULL,
  TYPE_COND,
  TYPE_MAPPED,
  TYPE_UNION,
  SP,
  exprAsIdent,
  exprBinaryOpOf,
  exprCondNo,
  exprCondTest,
  exprCondYes,
  exprEnd,
  exprObject,
  exprCallee,
  exprRight,
  exprSpan,
  exprStart,
  exprTag,
  nameIs,
  typeCondCheck,
  typeCondExtends,
  typeCondNo,
  typeCondYes,
  typeEnd,
  typeSpan,
  typeStart,
  typeTag,
  typeUnionTypesLen,
  varDeclInit,
} from "../../../lint/ast/index.ts";
import {
  AN_ASSIGNMENT_EXPRESSION,
  AN_AWAIT_EXPRESSION,
  AN_BINARY_EXPRESSION,
  AN_CALL_EXPRESSION,
  AN_CHAIN_EXPRESSION,
  AN_COMPUTED_MEMBER_EXPRESSION,
  AN_CONDITIONAL_EXPRESSION,
  AN_NEW_EXPRESSION,
  AN_PRIVATE_FIELD_EXPRESSION,
  AN_RETURN_STATEMENT,
  AN_STATIC_MEMBER_EXPRESSION,
  AN_THROW_STATEMENT,
  AN_TS_AS_EXPRESSION,
  AN_TS_CONDITIONAL_TYPE,
  AN_TS_NON_NULL_EXPRESSION,
  AN_TS_SATISFIES_EXPRESSION,
  AN_UNARY_EXPRESSION,
  AN_VARIABLE_DECLARATOR,
  AN_YIELD_EXPRESSION,
  anId,
  anParent,
  anTag,
  exprAstParent,
  typeAstParent,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { exprArgument } from "../fields.ts";
import { WK_EXPR, WK_TYPE, fmtExpr, fmtType } from "../format.ts";
import { formatLeadingCommentsRange, formatTrailingCommentsRange } from "../trivia.ts";
import { fmtNodeWithoutTrailingComments } from "./format_node_without_trailing_comments.ts";
import { isCastTargetThatHidesItsKind } from "./typecast.ts";
import { isAngularPipe } from "../print/binary_like_expression.ts";
import { writeTernary } from "./experimental_ternary.ts";
import { CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION, CONDITIONAL_LIKE_TS_CONDITIONAL_TYPE, LAYOUT_ROOT, LAYOUT_NESTED_TEST, LAYOUT_NESTED_CONSEQUENT, LAYOUT_NESTED_ALTERNATE, LAYOUT_JSX_CHAIN } from "./conditional.consts.ts";
export { CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION, CONDITIONAL_LIKE_TS_CONDITIONAL_TYPE } from "./conditional.consts.ts";


const T_QUESTION = token("?");
const T_COLON = token(":");
const T_EXTENDS = token("extends");


const pending = new I32Vec(8);

/** `ConditionalLike::span` into `SP`. */
function conditionalSpan(kind: number, h: number): void {
  if (kind === CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION) exprSpan(h);
  else typeSpan(h);
}

/** `ConditionalLike::parent` (an `AstNodes`). */
function conditionalParent(kind: number, h: number): number {
  return kind === CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION ? exprAstParent(h) : typeAstParent(h);
}

/** `Operand::span` into `SP`. */
function operandSpan(isType: boolean, h: number): void {
  if (isType) typeSpan(h);
  else exprSpan(h);
}

/** `Operand::is_conditional` */
export function operandIsConditional(isType: boolean, h: number): boolean {
  return isType ? typeTag(h) === TYPE_COND : exprTag(h) === EXPR_COND;
}

/**
 * Prettier's `shouldExtraIndentForConditionalExpression`: whether `conditional` is what a chain of member accesses and calls starts with,
 * which is the whole of what is returned, assigned, ..:
 *
 *     return (
 *       a
 *         ? b
 *         : c
 *     ).member;
 */
export function shouldExtraIndent(conditional: number): boolean {
  let expression = conditional;
  let parent = exprAstParent(conditional);
  for (;;) {
    const t = anTag(parent);
    let stop = false;
    if (t === AN_CHAIN_EXPRESSION) {
      // keep going
    } else if (t === AN_STATIC_MEMBER_EXPRESSION || t === AN_PRIVATE_FIELD_EXPRESSION || t === AN_COMPUTED_MEMBER_EXPRESSION) {
      const e = anId(parent);
      if (exprObject(e) === expression) expression = e;
      else break;
    } else if (t === AN_CALL_EXPRESSION) {
      const e = anId(parent);
      if (exprCallee(e) === expression) expression = e;
      else break;
    } else if (t === AN_TS_NON_NULL_EXPRESSION) {
      expression = anId(parent);
    } else if (t === AN_NEW_EXPRESSION) {
      // The chain ends here.
      const e = anId(parent);
      if (exprCallee(e) !== expression) break;
      expression = e;
      parent = anParent(parent);
      stop = true;
    } else if (t === AN_TS_AS_EXPRESSION || t === AN_TS_SATISFIES_EXPRESSION) {
      expression = anId(parent);
      parent = anParent(parent);
      stop = true;
    } else {
      break;
    }
    if (stop) break;
    parent = anParent(parent);
  }
  if (expression === conditional) return false;

  switch (anTag(parent)) {
    case AN_VARIABLE_DECLARATOR:
      return varDeclInit(anId(parent)) === expression;
    case AN_RETURN_STATEMENT:
    case AN_THROW_STATEMENT:
      return true;
    case AN_UNARY_EXPRESSION:
    case AN_YIELD_EXPRESSION:
    case AN_AWAIT_EXPRESSION:
      return exprArgument(anId(parent)) === expression;
    case AN_ASSIGNMENT_EXPRESSION:
      return exprRight(anId(parent)) === expression;
    default:
      return false;
  }
}

/**
 * Writes the comments after an operand, up to `operator` or to the end of the line. `(gapStart, gapEnd)`: what is between the operand and
 * the next one.
 */
function formatOperandTrailingComments(gapStart: number, gapEnd: number, operator: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) return;
  const cm = cx.comments;
  const n = cm.unprinted();
  if (n === 0) return;
  const from = cm.from;
  const to = cm.to;
  const src = cx.src;
  let start = gapStart;
  let indexBeforeOperator = -1;
  let count = -1;
  for (let i = from; i < to; i++) {
    const index = (i - from) | 0;
    if ((cm.ce[i] | 0) > gapEnd) {
      count = indexBeforeOperator >= 0 ? indexBeforeOperator : index;
      break;
    }
    const commentStart = cm.spanStart[i] | 0;
    if (src.containsNewline(start, commentStart)) {
      // It is on a new line.
      count = index;
      break;
    } else if (cm.isLine(i) || cm.followedByNewline(i)) {
      // Prettier's `handleClosureTypeCastComments`: `a ? /** @type {T} */ ⏎ b : c`
      count = (index + (cm.looksLikeTypeCastComment(i) ? 0 : 1)) | 0;
      break;
    } else if (src.containsByte(start, commentStart, operator)) {
      indexBeforeOperator = index;
    }
    start = cm.spanEnd[i] | 0;
  }
  if (count < 0) count = indexBeforeOperator >= 0 ? indexBeforeOperator : (to - from) | 0;
  formatTrailingCommentsRange(from, (from + count) | 0, f);
}

/** Whether there is a JSX element among the operands of `e`, a conditional expression, or of the conditionals in it. */
function isJsxConditionalChain(e: number): boolean {
  const pending$ = pending;
  const base = pending$.len;
  pending$.push(e);
  let result = false;
  while (pending$.len > base && !result) {
    const current = pending$.pop();
    if (exprTag(current) !== EXPR_COND) continue;
    const test = exprCondTest(current);
    const yes = exprCondYes(current);
    const no = exprCondNo(current);
    for (let i = 0; i < 3; i++) {
      const operand = i === 0 ? test : i === 1 ? yes : no;
      const t = exprTag(operand);
      if (t === EXPR_JSX) {
        result = true;
        break;
      }
      if (t === EXPR_COND) pending$.push(operand);
    }
  }
  pending$.len = base;
  return result;
}

/** The layout of the conditional `(kind, h)` (a `LAYOUT_*`, with `LAYOUT_JSX_CHAIN` or'd in). */
function layoutOf(kind: number, h: number, f: Formatter): number {
  const parent = conditionalParent(kind, h);
  if (kind === CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION) {
    // For Prettier the parentheses of a type cast are a node, which is what it is in then.
    if (anTag(parent) === AN_CONDITIONAL_EXPRESSION && !isCastTargetThatHidesItsKind(h, f)) {
      const p = anId(parent);
      if (exprCondTest(p) === h) return LAYOUT_NESTED_TEST | (isJsxConditionalChain(h) ? LAYOUT_JSX_CHAIN : 0);
      if (exprCondYes(p) === h) return LAYOUT_NESTED_CONSEQUENT;
      return LAYOUT_NESTED_ALTERNATE;
    }
    return LAYOUT_ROOT | (isJsxConditionalChain(h) ? LAYOUT_JSX_CHAIN : 0);
  }
  if (anTag(parent) === AN_TS_CONDITIONAL_TYPE) {
    const p = anId(parent);
    if (typeCondCheck(p) === h || typeCondExtends(p) === h) return LAYOUT_NESTED_TEST;
    if (typeCondYes(p) === h) return LAYOUT_NESTED_CONSEQUENT;
    return LAYOUT_NESTED_ALTERNATE;
  }
  return LAYOUT_ROOT;
}

function isParentStaticMemberExpression(kind: number, h: number, layout: number, f: Formatter): boolean {
  if ((layout & 3) !== LAYOUT_ROOT || kind !== CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION) return false;
  const parent = exprAstParent(h);
  const t = anTag(parent);
  if (t === AN_STATIC_MEMBER_EXPRESSION || t === AN_PRIVATE_FIELD_EXPRESSION) return true;
  // It is the left side.
  if (t === AN_BINARY_EXPRESSION) {
    const operator = exprBinaryOpOf(anId(parent));
    return operator >= 0 && isAngularPipe(operator, f);
  }
  return false;
}

function formatTest(kind: number, h: number, layout: number, f: Formatter): void {
  const isNestedAlternate = (layout & 3) === LAYOUT_NESTED_ALTERNATE;
  if (isNestedAlternate) {
    // The comments before it are not aligned.
    const cm = cxOf(f).comments;
    conditionalSpan(kind, h);
    cm.commentsBefore(SP.s0 | 0);
    formatLeadingCommentsRange(cm.from, cm.to, f);
    f.startAlign(2);
  }
  if (kind === CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION) {
    const test = exprCondTest(h);
    const yes = exprCondYes(h);
    fmtNodeWithoutTrailingComments(WK_EXPR, test, f);
    formatOperandTrailingComments(exprEnd(test), exprStart(yes), 63, f);
  } else {
    const check = typeCondCheck(h);
    const extendsType = typeCondExtends(h);
    const yes = typeCondYes(h);
    fmtType(check, f);
    f.space();
    f.token(T_EXTENDS);
    f.space();
    // A union writes the comments after it in its own group.
    if (typeTag(extendsType) === TYPE_UNION && typeUnionTypesLen(extendsType) > 1) fmtType(extendsType, f);
    else fmtNodeWithoutTrailingComments(WK_TYPE, extendsType, f);
    formatOperandTrailingComments(typeEnd(extendsType), typeStart(yes), 63, f);
  }
  if (isNestedAlternate) f.endAlign(2);
}

function formatConsequentAndAlternate(kind: number, h: number, f: Formatter): void {
  const isType = kind !== CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION;
  const consequent = isType ? typeCondYes(h) : exprCondYes(h);
  const alternate = isType ? typeCondNo(h) : exprCondNo(h);
  const wk = isType ? WK_TYPE : WK_EXPR;
  const isSpace = f.options.indentStyle === INDENT_SPACE;
  f.softLineBreakOrSpace();
  f.token(T_QUESTION);
  f.space();

  // `a ? (b ? c : d) : e`
  const isNestedConsequent = operandIsConditional(isType, consequent);
  if (isNestedConsequent) {
    f.startIfGroupFits();
    f.token(LPAREN);
    f.endConditional();
  }
  if (isSpace) f.startAlign(2);
  else f.startIndent();
  fmtNodeWithoutTrailingComments(wk, consequent, f);
  operandSpan(isType, consequent);
  const SP$ = SP;
  const consequentEnd = SP$.s1 | 0;
  operandSpan(isType, alternate);
  formatOperandTrailingComments(consequentEnd, SP$.s0 | 0, 58, f);
  if (isSpace) f.endAlign(2);
  else f.endIndent();
  if (isNestedConsequent) {
    f.startIfGroupFits();
    f.token(RPAREN);
    f.endConditional();
  }
  f.softLineBreakOrSpace();
  f.token(T_COLON);
  f.space();

  if (isSpace) f.startAlign(2);
  else f.startIndent();
  fmtNodeWithoutTrailingComments(wk, alternate, f);
  if (isSpace) f.endAlign(2);
  else f.endIndent();
}

/** `ConditionalLike::X(h).fmt(f)` */
export function fmtConditionalLike(kind: number, h: number, f: Formatter): void {
  if (f.options.experimentalTernaries) {
    writeTernary(kind, h, f);
    return;
  }
  writeConditionalLike(kind, h, false, f);
}

/** `FormatConditionalLike { conditional, jsx_chain }`: `jsxChain`: it is in a conditional that is a JSX chain. */
function writeConditionalLike(kind: number, h: number, jsxChain: boolean, f: Formatter): void {
  const layout = layoutOf(kind, h, f);
  const layoutKind = layout & 3;
  const isRoot = layoutKind === LAYOUT_ROOT;
  const isNestedTest = layoutKind === LAYOUT_NESTED_TEST;
  const shouldExtra = isRoot && kind === CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION && shouldExtraIndent(h);
  const isJsxChain = jsxChain || (layout & LAYOUT_JSX_CHAIN) !== 0;

  const grouped = isNestedTest || shouldExtra;
  if (grouped) {
    f.startGroup();
    f.startSoftBlockIndent();
  }
  const groupInner = isRoot || isNestedTest;
  if (groupInner) f.startGroup();

  formatTest(kind, h, layout, f);

  if (isJsxChain && kind === CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION) {
    const yes = exprCondYes(h);
    const no = exprCondNo(h);
    f.space();
    f.token(T_QUESTION);
    f.space();
    writeJsxChainExpression(yes, no, f);
    f.space();
    f.token(T_COLON);
    f.space();
    writeJsxChainExpression(no, -1, f);
  } else if (isRoot || isNestedTest) {
    f.startIndent();
    formatConsequentAndAlternate(kind, h, f);
    f.endIndent();
  } else if (layoutKind === LAYOUT_NESTED_CONSEQUENT) {
    // The `dedent` takes back the `align` of the parent, which with tabs would become an indentation of its own.
    f.startDedent();
    f.startIndent();
    formatConsequentAndAlternate(kind, h, f);
    f.endIndent();
    f.endDedent();
  } else {
    formatConsequentAndAlternate(kind, h, f);
  }

  // (a
  //   ? b
  //   : c
  // ).d
  if (!shouldExtra && !isJsxChain && isParentStaticMemberExpression(kind, h, layout, f)) f.softLineBreak();

  if (groupInner) f.endGroup();
  if (grouped) {
    f.endSoftBlockIndent();
    f.endGroup();
  }
}

/**
 * An operand of a conditional that has a JSX element in it. If the conditional breaks, it is in parentheses, unless it is `null`,
 * `undefined` or a conditional after the `:`.
 *
 *     a ? (
 *       <b>
 *         <c />
 *       </b>
 *     ) : (
 *       <d>
 *         <e />
 *       </d>
 *     );
 *
 * `following`: what is after the `:`, if `expression` is what is before it (-1: none).
 */
function writeJsxChainExpression(expression: number, following: number, f: Formatter): void {
  // A conditional expression in here is not written by way of `Expr`.
  if (!f.stack.enter()) return;
  const isConditional = exprTag(expression) === EXPR_COND;
  let noWrap: boolean;
  switch (exprTag(expression)) {
    case EXPR_IDENT: {
      const name = exprAsIdent(expression);
      noWrap = name >= 0 && nameIs(name, "undefined");
      break;
    }
    case EXPR_NULL:
      noWrap = true;
      break;
    default:
      noWrap = isConditional && following < 0;
      break;
  }
  if (!noWrap) {
    f.startIfGroupBreaks();
    f.token(LPAREN);
    f.endConditional();
    f.startSoftBlockIndent();
  }
  if (isConditional) {
    writeConditionalLike(CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION, expression, true, f);
  } else if (following >= 0) {
    fmtNodeWithoutTrailingComments(WK_EXPR, expression, f);
    formatOperandTrailingComments(exprEnd(expression), exprStart(following), 58, f);
  } else {
    fmtExpr(expression, f);
  }
  if (!noWrap) {
    f.endSoftBlockIndent();
    f.startIfGroupBreaks();
    f.token(RPAREN);
    f.endConditional();
  }
  f.stack.leave();
}

