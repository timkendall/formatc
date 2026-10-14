// Port of vendor/bun/src/format/js/print/binary_like_expression.rs: `a + b`, `a && b`. Prettier's `printBinaryishExpression`.
//
// Rust's `BinaryLikeExpression { expr, operator, left, right }` is the ExprId `e` here (the rest is read from it). The operands of a chain
// (`BinaryLeftOrRightSide`) are pairs of ints on `parts`: (the expression, a code `SIDE_*` | `OPERANDS_*` | `INSIDE_CONDITION`).
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { SPACE_TOKEN } from "../../ir/tokens.ts";
import { I32Vec } from "../../../base/i32vec.ts";
import {
  FLAVOR_OXFMT,
  HTML_ROOT_NG_ACTION,
  HTML_ROOT_NG_DIRECTIVE,
  HTML_ROOT_NG_INTERPOLATION,
  HTML_ROOT_VUE_EXPRESSION,
  OPERATOR_POSITION_END,
  htmlRootIsAngular,
} from "../../options.ts";
import {
  BIN_BIT_OR,
  BIN_COMMA,
  BIN_GT,
  BIN_LT,
  EXPR_ARRAY,
  EXPR_CALL,
  EXPR_COND,
  EXPR_IDENT,
  EXPR_JSX,
  EXPR_OBJECT,
  EXPR_THIS,
  EXPR_NUMBER,
  EXPR_TRUE,
  EXPR_FALSE,
  EXPR_NULL,
  N_EXPR,
  SP,
  binOpText,
  callArgsLen,
  callArgsStart,
  callCallee,
  exprArrayElemsLen,
  exprAsCall,
  exprAsCallLike,
  exprBinaryOpOf,
  exprCallee,
  exprIsIdent,
  exprIsOptional,
  exprLeft,
  exprObjectPropsLen,
  exprParent,
  exprRight,
  exprSpan,
  exprEnd,
  exprStart,
  exprTag,
  fileIsFlow,
  fileIsJavascript,
  listAt,
  nodeId,
  nodeKind,
  stmtDoWhileTest,
  stmtIfTest,
  stmtSwitchExpr,
  stmtWhileTest,
} from "../../../lint/ast/index.ts";
import {
  AN_BINARY_EXPRESSION,
  AN_CALL_EXPRESSION,
  AN_CONDITIONAL_EXPRESSION,
  AN_DO_WHILE_STATEMENT,
  AN_FOR_STATEMENT,
  AN_IF_STATEMENT,
  AN_JSX_ATTRIBUTE,
  AN_JSX_EXPRESSION_CONTAINER,
  AN_LOGICAL_EXPRESSION,
  AN_NEW_EXPRESSION,
  AN_PRIVATE_FIELD_EXPRESSION,
  AN_PRIVATE_IN_EXPRESSION,
  AN_PROGRAM,
  AN_PROPERTY_DEFINITION,
  AN_RETURN_STATEMENT,
  AN_STATIC_MEMBER_EXPRESSION,
  AN_SWITCH_STATEMENT,
  AN_TEMPLATE_LITERAL,
  AN_THROW_STATEMENT,
  AN_UNARY_EXPRESSION,
  AN_VARIABLE_DECLARATOR,
  AN_WHILE_STATEMENT,
  AN_OBJECT_PROPERTY,
  AN_ASSIGNMENT_EXPRESSION,
  AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY,
  anId,
  anIsArrowFunctionBody,
  anIsCallLikeCallee,
  anIsExpressionStatement,
  anParent,
  anTag,
  exprAsAstNodes,
  exprAstParent,
} from "../ast_nodes.ts";
import { PROP_INIT, PROP_SHORTHAND, propKind } from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";
import { fmtExpr, writeTrailingCommentsOf } from "../format.ts";
import { isAtStartOfGroup } from "../builders.ts";
import { formatLeadingComments, formatTrailingCommentsRange } from "../trivia.ts";
import { isCastTarget, isCastTargetThatHidesItsKind } from "../utils/typecast.ts";
import {
  PREC_EQUALS,
  PREC_EXPONENTIATION,
  PREC_MULTIPLY,
  PREC_SHIFT,
  binOpIsLogical,
  binOpIsRemainder,
  binOpPrecedence,
} from "../utils/operators.ts";
import { isLastBinaryOperandComment, unaryArgumentHasComments } from "./expressions.ts";

// `Operands`: which operands of a right side that is a logical expression with the same operator are written.
const OPERANDS_ALL: number = 0;
const OPERANDS_ALL_BUT_LAST: number = 1;
const OPERANDS_LAST: number = 2;
// The code of a part: bit 0: it is a right side (0: the left side that starts the chain); bits 1-2: `OPERANDS_*`; bit 3: the chain is the
// condition of an `if`, a `while`, a `do`-`while` or a `switch`.
const PART_RIGHT: number = 1;
const PART_OPERANDS_SHIFT: number = 1;
const PART_INSIDE_CONDITION: number = 8;

/** The operands of the chains that are being written, two ints each. The chain of a call is above the chains of the calls above it. */
const parts = new I32Vec(64);

const T_PIPE_SPACE = token("| ");
const T_COLON_SPACE = token(": ");
const T_LPAREN = token("(");
const T_RPAREN = token(")");

/** `" +"` .. for each `BIN_*`: a space and the operator, in one token. */
const OPERATOR_AFTER_SPACE: Int32Array = makeOperatorTokens(true);
/** `"+"` .. for each `BIN_*`. */
const OPERATOR_TOKEN: Int32Array = makeOperatorTokens(false);

function makeOperatorTokens(withSpace: boolean): Int32Array {
  const out = new Int32Array(BIN_COMMA + 1);
  for (let op = 0; op <= BIN_COMMA; op++) {
    const text = binOpText(op);
    out[op] = token(withSpace ? " " + text : text);
  }
  return out;
}

/** Whether `e` is Rust's `BinaryLikeExpression::new(e)`: `a + b`, `a && b`, not `a, b`. */
function isBinaryLike(e: number): boolean {
  const op = exprBinaryOpOf(e);
  return op >= 0 && op !== BIN_COMMA;
}

// Whether an expression with `operator` is Prettier's `NGPipeExpression`. Angular has no bitwise operators: `a | b: c : d` is parsed as `a | b(c, d)`.
export function isAngularPipe(operator: number, f: Formatter): boolean {
  return operator === BIN_BIT_OR && htmlRootIsAngular(f.options.inHtml.root);
}

/** Whether `e`, which is in an expression of Angular, is one of the `arguments` of an `NGPipeExpression`. */
export function isArgumentOfAngularPipe(e: number): boolean {
  const call = exprParent(e);
  if (nodeKind(call) !== N_EXPR || exprTag(nodeId(call)) !== EXPR_CALL || exprCallee(nodeId(call)) === e) return false;
  const pipe = exprParent(nodeId(call));
  return nodeKind(pipe) === N_EXPR && exprBinaryOpOf(nodeId(pipe)) === BIN_BIT_OR && exprRight(nodeId(pipe)) === nodeId(call);
}

/** Prettier's `shouldFlatten`: whether `a op b parent_op c` is written as one chain. */
export function shouldFlatten(parentOperator: number, operator: number): boolean {
  const precedence = binOpPrecedence(operator);
  if (binOpPrecedence(parentOperator) !== precedence) return false;
  switch (precedence) {
    // `**` is right associative. `(a == b) == c`, `(a << 3) << 4`.
    case PREC_EXPONENTIATION:
    case PREC_EQUALS:
    case PREC_SHIFT:
      return false;
    // `(a * 3) % 5`, `(a * 3) / 5`
    case PREC_MULTIPLY:
      return !binOpIsRemainder(parentOperator) && !binOpIsRemainder(operator) && parentOperator === operator;
    default:
      return true;
  }
}

/** Prettier rebalances the trees of its parsers for JavaScript, not the tree of its parser for Angular. */
function isTreeAsItIsParsed(f: Formatter): boolean {
  return htmlRootIsAngular(f.options.inHtml.root);
}

/** Whether `e` (a binary-like expression) is the condition of `parent` (an `AstNodes`): `if (a + b) {}`, `switch (a + b) {}`. */
function isInsideCondition(e: number, parent: number): boolean {
  switch (anTag(parent)) {
    case AN_IF_STATEMENT:
      return stmtIfTest(anId(parent)) === e;
    case AN_DO_WHILE_STATEMENT:
      return stmtDoWhileTest(anId(parent)) === e;
    case AN_WHILE_STATEMENT:
      return stmtWhileTest(anId(parent)) === e;
    case AN_SWITCH_STATEMENT:
      return stmtSwitchExpr(anId(parent)) === e;
    default:
      return false;
  }
}

/** The left side of `e` if it is written as part of the same chain: `a + b` in `a + b + c`. -1 if it is not. */
function canFlatten(e: number, f: Formatter): number {
  const left = exprLeft(e);
  if (!isBinaryLike(left)) return -1;
  if (!shouldFlatten(exprBinaryOpOf(e), exprBinaryOpOf(left)) || isCastTarget(left, f)) return -1;
  return left;
}

/**
 * The right side of `e` if it is a logical expression with the same operator: `a && (b && c)`. Prettier rebalances the tree after parsing:
 * to it, that is `(a && b) && c`. -1 if it is not.
 */
function rightWithSameOperator(e: number, f: Formatter): number {
  const op = exprBinaryOpOf(e);
  if (!binOpIsLogical(op) || isTreeAsItIsParsed(f)) return -1;
  const right = exprRight(e);
  if (isBinaryLike(right) && exprBinaryOpOf(right) === op && !isCastTarget(right, f)) return right;
  return -1;
}

/** Prettier's `shouldInlineLogicalExpression`: `a && { b }`, `a || [b]`, `a && <b />`. */
export function shouldInlineLogicalExpression(e: number, f: Formatter): boolean {
  if (!binOpIsLogical(exprBinaryOpOf(e))) return false;
  let last = e;
  for (;;) {
    const right = rightWithSameOperator(last, f);
    if (right < 0) break;
    last = right;
  }
  const right = exprRight(last);
  return isInlinedOperand(right) && !isCastTargetThatHidesItsKind(right, f);
}

/** Whether `parent` indents it already. */
function shouldNotIndentIfParentIndents(e: number, parent: number, f: Formatter): boolean {
  switch (anTag(parent)) {
    case AN_PROGRAM: {
      const root = f.options.inHtml.root;
      // Prettier's `NGRoot`.
      if (root === HTML_ROOT_NG_ACTION || root === HTML_ROOT_NG_DIRECTIVE || root === HTML_ROOT_NG_INTERPOLATION) return false;
      // The same for `__ng_binding`, and `JsExpressionRoot`.
      return exprBinaryOpOf(e) !== BIN_BIT_OR;
    }
    case AN_RETURN_STATEMENT:
    case AN_THROW_STATEMENT:
    case AN_FOR_STATEMENT:
    case AN_TEMPLATE_LITERAL:
    case AN_UNARY_EXPRESSION:
      return true;
    case AN_JSX_EXPRESSION_CONTAINER:
      return anTag(anParent(parent)) === AN_JSX_ATTRIBUTE;
    case AN_CONDITIONAL_EXPRESSION: {
      const grand = anTag(anParent(parent));
      return (
        !(grand === AN_RETURN_STATEMENT || grand === AN_THROW_STATEMENT || grand === AN_CALL_EXPRESSION || grand === AN_NEW_EXPRESSION) ||
        (htmlRootIsAngular(f.options.inHtml.root) && isArgumentOfAngularPipe(anId(parent)))
      );
    }
    // `Boolean(a && b)`
    case AN_CALL_EXPRESSION: {
      const callExpression = anId(parent);
      const call = exprAsCallLike(callExpression);
      if (call < 0) return false;
      const callee = callCallee(call);
      return callee !== e && !exprIsOptional(callExpression) && callArgsLen(call) === 1 && exprIsIdent(callee, "Boolean");
    }
    default:
      // `ExpressionStatement`: the body of an arrow function.
      return anIsExpressionStatement(parent) && anIsArrowFunctionBody(parent);
  }
}

/** `a + b` and `a && b`. */
export function writeBinaryLikeExpression(e: number, f: Formatter): void {
  if (!isBinaryLike(e)) return;
  const op = exprBinaryOpOf(e);
  if (op !== BIN_BIT_OR || f.options.inHtml.root !== HTML_ROOT_VUE_EXPRESSION) {
    writeChain(e, f);
    return;
  }
  // Prettier's `isVueFilterSequenceExpression`: nothing is around it but the same, up to the root. What is around this one is being written.
  const cx = cxOf(f);
  const parent = exprAstParent(e);
  let isFilterSequence = false;
  if (anTag(parent) === AN_PROGRAM) isFilterSequence = true;
  else if (anTag(parent) === AN_BINARY_EXPRESSION && exprBinaryOpOf(anId(parent)) === BIN_BIT_OR) isFilterSequence = cx.isVueFilterSequence;
  const outer = cx.isVueFilterSequence;
  cx.isVueFilterSequence = isFilterSequence;
  writeChain(e, f);
  cx.isVueFilterSequence = outer;
}

/** `const a = /** @type {T} *\/ (⏎b ||⏎c⏎)`: oxfmt looks at what the cast is in, and does not indent `c`. */
function parenthesesOfCastAreANode(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/** Whether `parent` writes it on the line of its operator, so that it has to indent itself. */
function shouldIndentIfParentInlines(parent: number, f: Formatter): boolean {
  switch (anTag(parent)) {
    case AN_OBJECT_PROPERTY: {
      const kind = propKind(anId(parent));
      // oxfmt: `{ ["b" + "c"]() {} }` is not indented.
      return kind === PROP_INIT || kind === PROP_SHORTHAND || f.options.flavor === FLAVOR_OXFMT;
    }
    case AN_ASSIGNMENT_EXPRESSION:
    case AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY:
    case AN_VARIABLE_DECLARATOR:
    case AN_PROPERTY_DEFINITION:
      return true;
    default:
      return false;
  }
}

function writeChain(e: number, f: Formatter): void {
  const parent = exprAstParent(e);
  // For Prettier it is in a `ParenthesizedExpression` then, which is none of what is asked for.
  const isInTypeCast = parenthesesOfCastAreANode(f) && isCastTarget(e, f);

  // A condition has its own indentation and group.
  if (!isInTypeCast && isInsideCondition(e, parent)) {
    writeFlattenedLogicalExpression(e, true, f);
    return;
  }

  // Where it is in parentheses: `(a + b)()`, `!(a + b)`, `(a + b).c`.
  let isInsideParenthesis: boolean;
  const pt = anTag(parent);
  if (pt === AN_STATIC_MEMBER_EXPRESSION || pt === AN_PRIVATE_FIELD_EXPRESSION) isInsideParenthesis = true;
  // It writes the parentheses and indents an argument with comments.
  else if (pt === AN_UNARY_EXPRESSION) isInsideParenthesis = !unaryArgumentHasComments(anId(parent), e, f);
  else isInsideParenthesis = anIsCallLikeCallee(parent, e);
  if (isInsideParenthesis && !isInTypeCast) {
    f.startGroup();
    f.startSoftBlockIndent();
    writeFlattenedLogicalExpression(e, false, f);
    f.endSoftBlockIndent();
    f.endGroup();
    return;
  }

  if (!isInTypeCast && shouldNotIndentIfParentIndents(e, parent, f)) {
    f.startGroup();
    writeFlattenedLogicalExpression(e, false, f);
    f.endGroup();
    return;
  }

  const inlineLogicalExpression = shouldInlineLogicalExpression(e, f);
  const shouldIndentIfInlines = !isInTypeCast && shouldIndentIfParentInlines(parent, f);
  const parts$ = parts;
  const base = parts$.len;
  splitIntoLeftAndRightSides(e, false, f);
  const n = ((parts$.len - base) >> 1) | 0;
  const flattened = n > 2 || rightWithSameOperator(e, f) >= 0;

  if ((inlineLogicalExpression && !flattened) || (!inlineLogicalExpression && shouldIndentIfInlines)) {
    f.startGroup();
    for (let i = 0; i < n; i++) writePart(parts$.data[base + 2 * i] | 0, parts$.data[base + 2 * i + 1] | 0, f);
    f.endGroup();
    parts$.len = base;
    return;
  }

  // `parts[0]` is the left side that the chain starts with, `parts[1..]` are the right sides.
  // A JSX element at the end has a group of its own, so that it does not break the chain.
  const lastExpr = parts$.data[base + 2 * (n - 1)] | 0;
  const lastCode = parts$.data[base + 2 * (n - 1) + 1] | 0;
  let jsxElement = -1;
  let beforeJsxElement = -1;
  if (n > 1 && (lastCode & PART_RIGHT) !== 0 && exprTag(lastOperand(lastExpr, lastCode, f)) === EXPR_JSX) {
    jsxElement = lastExpr;
    if (rightWithSameOperator(lastExpr, f) >= 0) beforeJsxElement = lastExpr;
  }
  const tailEnd = jsxElement >= 0 ? n - 1 : n;

  const groupId = f.groupId();

  // A line comment behind the operator before a JSX element at the end trails what is before the operator, which is in the chain.
  let shouldExpandChain = false;
  const cx = cxOf(f);
  if (!cx.isQuiet && jsxElement >= 0) {
    const cm = cx.comments;
    cm.commentsBefore(exprStart(lastOperand(lastExpr, lastCode, f)));
    for (let i = cm.from; i < cm.to; i++) {
      if (cm.isLine(i) && !cm.precededByNewline(i)) {
        shouldExpandChain = true;
        break;
      }
    }
  }

  if (jsxElement >= 0) f.startGroup();
  f.startGroupWith(groupId, shouldExpandChain);
  writePart(parts$.data[base] | 0, parts$.data[base + 1] | 0, f);
  if (tailEnd > 1 || beforeJsxElement >= 0) {
    f.startIndent();
    for (let i = 1; i < tailEnd; i++) writePart(parts$.data[base + 2 * i] | 0, parts$.data[base + 2 * i + 1] | 0, f);
    if (beforeJsxElement >= 0) writePart(beforeJsxElement, PART_RIGHT | (OPERANDS_ALL_BUT_LAST << PART_OPERANDS_SHIFT), f);
    f.endIndent();
  }
  f.endGroup();
  if (jsxElement >= 0) {
    f.startIndentIfGroupBreaks(groupId);
    writePart(jsxElement, PART_RIGHT | (OPERANDS_LAST << PART_OPERANDS_SHIFT), f);
    f.endIndentIfGroupBreaks(groupId);
    f.endGroup();
  }
  parts$.len = base;
}

/** Writes all operands of a chain one after the other. */
function writeFlattenedLogicalExpression(e: number, insideCondition: boolean, f: Formatter): void {
  // `a && ((b && ((c && ..) && d)) && e)`: it is not written by way of `Expr`.
  if (!f.stack.enter()) return;
  const parts$ = parts;
  const base = parts$.len;
  splitIntoLeftAndRightSides(e, insideCondition, f);
  const n = ((parts$.len - base) >> 1) | 0;
  for (let i = 0; i < n; i++) writePart(parts$.data[base + 2 * i] | 0, parts$.data[base + 2 * i + 1] | 0, f);
  parts$.len = base;
  f.stack.leave();
}

/**
 * The operands of a chain, in order, pushed on `parts`: the leftmost that is not part of the chain, and then the right side of each
 * expression on the way up.
 */
function splitIntoLeftAndRightSides(binary: number, insideCondition: boolean, f: Formatter): void {
  const parts$ = parts;
  const base = parts$.len;
  const code = PART_RIGHT | (insideCondition ? PART_INSIDE_CONDITION : 0);
  let current = binary;
  for (;;) {
    parts$.push(current);
    parts$.push(code);
    const left = canFlatten(current, f);
    if (left < 0) break;
    current = left;
  }
  parts$.push(current);
  parts$.push(0);
  // Reverse the pairs.
  let i = base;
  let j = (parts$.len - 2) | 0;
  const data = parts$.data;
  while (i < j) {
    const a = data[i] | 0;
    const b = data[i + 1] | 0;
    data[i] = data[j] | 0;
    data[i + 1] = data[j + 1] | 0;
    data[j] = a;
    data[j + 1] = b;
    i = (i + 2) | 0;
    j = (j - 2) | 0;
  }
}

/** The operand that is written last by the part `(parent, code)`. */
function lastOperand(parent: number, code: number, f: Formatter): number {
  if ((code & PART_RIGHT) === 0) return exprLeft(parent);
  let last = parent;
  for (;;) {
    const right = rightWithSameOperator(last, f);
    if (right < 0) break;
    last = right;
  }
  return exprRight(last);
}

/** Whether all that is written for `e` is text on one line. */
function isOneText(e: number): boolean {
  switch (exprTag(e)) {
    case EXPR_IDENT:
    case EXPR_THIS:
    case EXPR_NUMBER:
    case EXPR_TRUE:
    case EXPR_FALSE:
    case EXPR_NULL:
      return true;
    default:
      return false;
  }
}

/** The comments after `left`, if it is written as a part of the chain and not as a node of its own. */
function writeTrailingCommentsOfNested(left: number, f: Formatter): void {
  if (cxOf(f).isQuiet) return;
  const node = exprAsAstNodes(left);
  const t = anTag(node);
  if (t === AN_LOGICAL_EXPRESSION || t === AN_BINARY_EXPRESSION || t === AN_PRIVATE_IN_EXPRESSION) writeTrailingCommentsOf(node, f);
}

/** `BinaryLeftOrRightSide::fmt` */
function writePart(parent: number, code: number, f: Formatter): void {
  if ((code & PART_RIGHT) === 0) {
    const left = exprLeft(parent);
    if (cxOf(f).isQuiet && isOneText(left) && isAtStartOfGroup(f)) {
      fmtExpr(left, f);
      return;
    }
    f.startGroup();
    fmtExpr(left, f);
    f.endGroup();
    return;
  }
  const insideParenthesis = (code & PART_INSIDE_CONDITION) !== 0;
  const operands = (code >> PART_OPERANDS_SHIFT) & 3;
  let binary = parent;
  const operator = exprBinaryOpOf(binary);
  const isLogical = binOpIsLogical(operator);
  const outermost = binary;

  // `a && (b && c)` is written like `a && b && c`, in one group. Prettier rebalances the tree for that after parsing.
  if (isLogical) {
    for (;;) {
      const rightLogical = rightWithSameOperator(binary, f);
      if (rightLogical < 0) break;
      if (operands !== OPERANDS_LAST) {
        if (f.options.flavor !== FLAVOR_OXFMT) writeTrailingCommentsOfNested(exprLeft(binary), f);
        const right = exprLeft(rightLogical);
        writeOperator(operator, right, isInlinedOperand(right), f);
        if (isBinaryLike(right) && exprBinaryOpOf(right) === operator && !isCastTarget(right, f)) {
          writeFlattenedLogicalExpression(right, insideParenthesis, f);
        } else {
          fmtExpr(right, f);
        }
      }
      binary = rightLogical;
    }
  }
  if (operands === OPERANDS_ALL_BUT_LAST) return;

  const left = exprLeft(binary);
  const right = exprRight(binary);
  const binaryOperator = exprBinaryOpOf(binary);

  // Both are logical expressions, or both are binary expressions, or both are pipes of Angular.
  const isPipe = isAngularPipe(binaryOperator, f);
  const binaryIsLogical = binOpIsLogical(binaryOperator);
  let shouldGroup = true;
  const parentNode = exprParent(binary);
  if (nodeKind(parentNode) === N_EXPR && isSameKind(nodeId(parentNode), binaryIsLogical, isPipe, f)) shouldGroup = false;
  else if (isPipe && isArgumentOfAngularPipe(binary)) shouldGroup = false;
  else if (isSameKind(left, binaryIsLogical, isPipe, f) || isSameKind(right, binaryIsLogical, isPipe, f)) shouldGroup = false;
  else if (insideParenthesis && isLogical) shouldGroup = false;

  writeTrailingCommentsOfNested(left, f);

  const cx = cxOf(f);
  if (!shouldGroup) {
    writeOperatorAndRightExpression(binary, outermost, f);
    return;
  }
  // A line comment between the left side and the right side, which has been printed by now, breaks the line:
  //
  //     a =
  //       b || // comment
  //       c;
  let shouldBreak = false;
  if (!cx.isQuiet) {
    const cm = cx.comments;
    const leftEnd = exprEnd(left);
    const rightStart = exprStart(right);
    for (let i = (cm.printedCount - 1) | 0; i >= 0; i--) {
      if (!(leftEnd <= (cm.cs[i] | 0) && rightStart >= (cm.ce[i] | 0))) break;
      if (cm.isLine(i)) {
        shouldBreak = true;
        break;
      }
    }
  }
  f.startGroupExpand(shouldBreak);
  writeOperatorAndRightExpression(binary, outermost, f);
  f.endGroup();
}

/** Whether `other` is a binary-like expression of the same kind as the chain: both logical or both not, both pipes of Angular or both not. */
function isSameKind(other: number, isLogical: boolean, isPipe: boolean, f: Formatter): boolean {
  const operator = exprBinaryOpOf(other);
  if (operator < 0 || operator === BIN_COMMA) return false;
  return binOpIsLogical(operator) === isLogical && isAngularPipe(operator, f) === isPipe;
}

/** The operator and the right side of `binary`: `outermost` is the expression the chain started with. */
function writeOperatorAndRightExpression(binary: number, outermost: number, f: Formatter): void {
  const operator = exprBinaryOpOf(binary);
  const right = exprRight(binary);
  if (isAngularPipe(operator, f)) {
    writeNameAndArgumentsOfAngularPipe(right, f);
    return;
  }
  const isJsx = exprTag(right) === EXPR_JSX;
  const isInlined = shouldInlineLogicalExpression(binary, f) || wouldEndTypeArguments(binary, f);
  writeOperator(operator, right, isInlined, f);
  const cx = cxOf(f);
  exprSpan(right);
  const SP$ = SP;
  const rightStart = SP$.s0 | 0;
  const rightEnd = SP$.s1 | 0;
  if (isInlined && !isJsx && cx.comments.hasLeadingOwnLineComment(rightStart)) {
    f.startSoftLineIndentOrSpace();
    fmtExpr(right, f);
    f.endSoftLineIndentOrSpace();
    return;
  }
  fmtExpr(right, f);
  if (cx.isQuiet) return;
  const cm = cx.comments;
  // `a && (b && c /* comment */)`: in the tree that Prettier has rebalanced, the comment is in the expression that `c` is the right side of.
  if (binary !== outermost) {
    cm.commentsIn(rightEnd, exprEnd(outermost));
    formatTrailingCommentsRange(cm.from, cm.to, f);
  }
  // See `isLastBinaryOperandComment`.
  const outerParent = exprAstParent(outermost);
  if (anTag(outerParent) === AN_UNARY_EXPRESSION && cm.unprinted() > 0) {
    const comment = cm.from;
    const unaryEnd = exprEnd(anId(outerParent));
    if ((cm.cs[comment] | 0) >= rightEnd && (cm.ce[comment] | 0) <= unaryEnd && isLastBinaryOperandComment(outermost, comment, f)) {
      formatTrailingCommentsRange(comment, (comment + 1) | 0, f);
    }
  }
}

/** `| b: c : d`. `right`: `b(c, d)`. */
function writeNameAndArgumentsOfAngularPipe(right: number, f: Formatter): void {
  const call = exprAsCall(right);
  const name = call >= 0 ? callCallee(call) : right;
  f.softLineBreakOrSpace();
  f.token(T_PIPE_SPACE);
  exprSpan(name);
  const SP$ = SP;
  f.sourceText(SP$.s0 | 0, SP$.s1 | 0);
  if (call < 0) return;
  f.startGroup();
  f.startIndent();
  f.softLineBreak();
  f.token(T_COLON_SPACE);
  const start = callArgsStart(call);
  const n = callArgsLen(call);
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      f.softLineBreakOrSpace();
      f.token(T_COLON_SPACE);
    }
    const argument = listAt(start, i);
    const needsParentheses = exprTag(argument) === EXPR_COND || exprBinaryOpOf(argument) === BIN_BIT_OR;
    f.startAlign(2);
    f.startGroup();
    if (needsParentheses) f.token(T_LPAREN);
    fmtExpr(argument, f);
    if (needsParentheses) f.token(T_RPAREN);
    f.endGroup();
    f.endAlign(2);
  }
  f.endIndent();
  f.endGroup();
}

/**
 * To TypeScript, `a < b >` at the end of a line is `a` with a type argument, and the next line another statement. Prettier breaks the line
 * there.
 */
function wouldEndTypeArguments(binary: number, f: Formatter): boolean {
  return (
    exprBinaryOpOf(binary) === BIN_GT &&
    exprBinaryOpOf(exprLeft(binary)) === BIN_LT &&
    !fileIsJavascript() &&
    !fileIsFlow() &&
    f.options.experimentalOperatorPosition === OPERATOR_POSITION_END
  );
}

/** Whether `operator`, which is being written, is the `|` before a filter of Vue: a line is broken before it. */
function isBeforeVueFilter(operator: number, f: Formatter): boolean {
  return operator === BIN_BIT_OR && cxOf(f).isVueFilterSequence;
}

/** oxfmt has no such space. */
function writesSpaceBeforeCommentsBeforeOperator(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/**
 * Writes `operator` and what is around it. `right`: the operand after it. `isInlined`: it stays on the line of the operator.
 */
function writeOperator(operator: number, right: number, isInlined: boolean, f: Formatter): void {
  if (isInlined) {
    f.token(OPERATOR_AFTER_SPACE[operator] | 0);
    f.space();
    return;
  }
  const cx = cxOf(f);
  if (isBeforeVueFilter(operator, f)) {
    if (!cx.comments.hasLeadingOwnLineComment(exprStart(right))) {
      f.softLineBreakOrSpace();
      f.token(OPERATOR_TOKEN[operator] | 0);
      f.space();
      return;
    }
  }
  if (f.options.experimentalOperatorPosition === OPERATOR_POSITION_END) {
    f.token(OPERATOR_AFTER_SPACE[operator] | 0);
    f.softLineBreakOrSpace();
    return;
  }
  // A comment that ends its line stays before the operator.
  exprSpan(right);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  let hasCommentBeforeOperator = false;
  if (!cx.isQuiet) {
    const cm = cx.comments;
    hasCommentBeforeOperator = exprTag(right) === EXPR_JSX ? cm.isSuppressed(start) : cm.hasLeadingOwnLineComment(start);
    if (hasCommentBeforeOperator) {
      cm.commentsBefore(start);
      for (let i = cm.from; i < cm.to; i++) {
        if (cm.isTypeCastComment(i)) {
          hasCommentBeforeOperator = false;
          break;
        }
      }
    }
  }
  if (hasCommentBeforeOperator) {
    // Prettier writes a space here. It is seen before a line comment that trails the left side, and it is one more column that has to fit.
    if (writesSpaceBeforeCommentsBeforeOperator(f)) f.token(SPACE_TOKEN);
    f.softLineBreakOrSpace();
    formatLeadingComments(start, end, f);
  } else {
    f.softLineBreakOrSpace();
  }
  f.token(OPERATOR_TOKEN[operator] | 0);
  f.space();
}

/** Whether `right`, the right side of a logical expression, stays on the line of the operator. */
function isInlinedOperand(right: number): boolean {
  switch (exprTag(right)) {
    case EXPR_OBJECT:
      return exprObjectPropsLen(right) > 0;
    case EXPR_ARRAY:
      return exprArrayElemsLen(right) > 0;
    case EXPR_JSX:
      return true;
    default:
      return false;
  }
}
