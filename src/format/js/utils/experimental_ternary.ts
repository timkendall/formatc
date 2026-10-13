// Port of vendor/bun/src/format/js/utils/experimental_ternary.rs: `a ? b : c` and `A extends B ? C : D` with the option
// `experimentalTernaries`: the `?` is at the end of the line of the condition. Prettier's `printTernary`.
//
//     const animal =
//       isBird ? "bird"
//       : isCat ? "cat"
//       : "unknown";
//
// `conditional` is `(kind, h)` as in utils/conditional.ts. An `Operand` is `(isType, h)`; a list of comments is a range `[from, to)` of
// comment indices.
import { Formatter } from "../../ir/formatter.ts";
import { LPAREN, RPAREN, SEMI } from "../../ir/tokens.ts";
import { token } from "../../ir/element.ts";
import { INDENT_TAB } from "../../options.ts";
import { isTooLong } from "../../errors.ts";
import {
  BIN_COMMA,
  BODY_EXPR,
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
  EXPR_ARRAY,
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
  TYPE_ARRAY,
  TYPE_BOOL_LIT,
  TYPE_COND,
  TYPE_KEYWORD,
  TYPE_MAPPED,
  TYPE_REF,
  TYPE_STRING_LIT,
  SP,
  callArgsLen,
  callCallee,
  callTypeArgsLen,
  className,
  classExtends,
  exprAsCallLike,
  exprAsClass,
  exprAsTy,
  exprSatisfiesTy,
  exprAsFn,
  exprAssignTarget,
  exprAssignValue,
  exprBinaryLeft,
  exprBinaryOpOf,
  exprBinaryRight,
  exprCondNo,
  exprCondTest,
  exprCondYes,
  exprDotObj,
  exprEnd,
  exprImportCallArgsLen,
  exprImportCallArgsStart,
  exprInstantiationExpr,
  exprIndexIndex,
  exprIndexObj,
  exprIsChainRoot,
  exprNonNullCount,
  exprOperand,
  exprSpan,
  exprStart,
  exprTag,
  exprYieldValue,
  fileIsJavascript,
  funcBodyExpr,
  funcBodyKind,
  funcName,
  funcReturnType,
  funcTypeParamsLen,
  exprIsPrivateMember,
  exprTaggedTemplateCall,
  listAt,
  typeArrayElem,
  typeCondCheck,
  typeCondExtends,
  typeCondNo,
  typeCondYes,
  typeEnd,
  typeRefArgsLen,
  typeRefNameLen,
  typeSpan,
  typeStart,
  typeTag,
} from "../../../lint/ast/index.ts";
import {
  AN_ASSIGNMENT_EXPRESSION,
  AN_BINARY_EXPRESSION,
  AN_CONDITIONAL_EXPRESSION,
  AN_JSX_ATTRIBUTE,
  AN_JSX_EXPRESSION_CONTAINER,
  AN_PRIVATE_FIELD_EXPRESSION,
  AN_RETURN_STATEMENT,
  AN_STATIC_MEMBER_EXPRESSION,
  AN_THROW_STATEMENT,
  AN_TS_CONDITIONAL_TYPE,
  anId,
  anParent,
  anTag,
  exprAstParent,
  typeAstParent,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { WK_EXPR, WK_TYPE } from "../format.ts";
import { DANGLING_NONE, formatDanglingCommentsRange, formatTrailingCommentsRange } from "../trivia.ts";
import { fmtNodeWithoutTrailingComments } from "./format_node_without_trailing_comments.ts";
import { isShortArgument } from "./assignment_like.ts";
import {
  CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION,
  operandIsConditional,
  shouldExtraIndent,
} from "./conditional.ts";
import { fmtType } from "../format.ts";
import { isAngularPipe } from "../print/binary_like_expression.ts";
import { parenthesisBeforeNeedsSemicolon } from "../print/statements.ts";
import { needsParentheses as typeNeedsParentheses } from "../parentheses/ts_type.ts";

const T_QUESTION = token("?");
const T_COLON = token(":");
const T_EXTENDS = token("extends");

/**
 * The comments between the operands, by what they belong to (Prettier's `handleConditionalExpressionComments`): ranges `[from, to)`.
 * `OC[2 * k]`, `OC[2 * k + 1]` for `k`: 0 after the test, 1 before the consequent, 2 after the consequent, 3 on lines of their own before the
 * `:`, 4 before the alternate. Valid until the next call of `operandComments`.
 */
const OC = new Int32Array(10);

function operandSpan(isType: boolean, h: number): void {
  if (isType) typeSpan(h);
  else exprSpan(h);
}

function operandEnd(isType: boolean, h: number): number {
  return isType ? typeEnd(h) : exprEnd(h);
}

function operandStart(isType: boolean, h: number): number {
  return isType ? typeStart(h) : exprStart(h);
}

/**
 * How many of the comments `[from, to)`, which are between an operand that ends at `start` and the next, trail the former: those on its
 * line, if they are before `operator` or the last of them ends the line.
 */
function trailingCount(from: number, to: number, start0: number, operator: number, f: Formatter): number {
  const cx = cxOf(f);
  const cm = cx.comments;
  const src = cx.src;
  let start = start0;
  let firstAfterOperator = -1;
  for (let i = from; i < to; i++) {
    const index = (i - from) | 0;
    const commentStart = cm.spanStart[i] | 0;
    if (src.containsNewline(start, commentStart)) return index;
    if (cm.isLine(i) || cm.followedByNewline(i)) return (index + 1) | 0;
    if (firstAfterOperator < 0 && src.containsByte(start, commentStart, operator)) firstAfterOperator = index;
    start = cm.spanEnd[i] | 0;
  }
  return firstAfterOperator >= 0 ? firstAfterOperator : (to - from) | 0;
}

/**
 * Fills `OC` with the comments between `test`, `consequent` and `alternate` (operands `(isType, h)`; `isType` is the same for all).
 */
function operandComments(isType: boolean, test: number, consequent: number, alternate: number, f: Formatter): void {
  for (let i = 0; i < 10; i++) OC[i] = 0;
  const cx = cxOf(f);
  if (cx.isQuiet) return;
  const cm = cx.comments;
  // (after_test, before_consequent)
  cm.commentsIn(operandEnd(isType, test), operandStart(isType, consequent));
  let from = cm.from;
  let to = cm.to;
  let n = trailingCount(from, to, operandEnd(isType, test), 63, f);
  OC[0] = from;
  OC[0 + 1] = (from + n) | 0;
  OC[2] = (from + n) | 0;
  OC[2 + 1] = to;
  // (after_consequent, rest)
  cm.commentsIn(operandEnd(isType, consequent), operandStart(isType, alternate));
  from = cm.from;
  to = cm.to;
  n = trailingCount(from, to, operandEnd(isType, consequent), 58, f);
  OC[4] = from;
  OC[4 + 1] = (from + n) | 0;
  const restFrom = (from + n) | 0;
  // Anything but a block comment on one line. Not in a conditional type, and not before a `ChainExpression`, which TypeScript files have:
  // Prettier compares the alternate with the node that follows the comment, and that is the member access or the call in it.
  let count = 0;
  if (!isType && (fileIsJavascript() || !exprIsChainRoot(alternate))) {
    for (let i = restFrom; i < to; i++) {
      if (cm.isLine(i) || cm.isMultilineBlock(i)) count = (count + 1) | 0;
      else break;
    }
  }
  OC[6] = restFrom;
  OC[6 + 1] = (restFrom + count) | 0;
  OC[8] = (restFrom + count) | 0;
  OC[8 + 1] = to;
}

/** Prettier's `hasMultilineBlockComments`: of the comments of the operands (in `OC`). */
function ocHasMultilineBlock(f: Formatter): boolean {
  const cm = cxOf(f).comments;
  for (let k = 0; k < 10; k += 2) {
    if (k === 6) continue;
    for (let i = OC[k] | 0; i < (OC[k + 1] | 0); i++) if (cm.isMultilineBlock(i)) return true;
  }
  return false;
}

/** An operand and the comments `[from, to)` after it. */
function writeOperand(isType: boolean, h: number, from: number, to: number, f: Formatter): void {
  fmtNodeWithoutTrailingComments(isType ? WK_TYPE : WK_EXPR, h, f);
  formatTrailingCommentsRange(from, to, f);
}

/**
 * Whether `conditional`, an expression, breaks whatever its width: there is a conditional after its `?` or its `:`, or an operand has a
 * block comment of several lines. Prettier's `shouldBreak`.
 */
export function shouldBreak(conditional: number, f: Formatter): boolean {
  if (exprTag(conditional) !== EXPR_COND) return false;
  const test = exprCondTest(conditional);
  const consequent = exprCondYes(conditional);
  const alternate = exprCondNo(conditional);
  if (exprTag(consequent) === EXPR_COND || exprTag(alternate) === EXPR_COND) return true;
  operandComments(false, test, consequent, alternate, f);
  return ocHasMultilineBlock(f);
}

/** What the outermost conditional is in that `e` is a consequent or an alternate of, directly or not (an `AstNodes`). */
function firstNonConditionalParent(e: number): number {
  let previous = e;
  let current = exprAstParent(e);
  while (anTag(current) === AN_CONDITIONAL_EXPRESSION && exprCondTest(anId(current)) !== previous) {
    previous = anId(current);
    current = anParent(current);
  }
  return current;
}

/**
 * Whether a line break is written right after `e`, which is in JSX: it is the end of what is after the `?` of a conditional, or of the
 * value of an attribute.
 */
function isFollowedByLineBreak(e: number): boolean {
  let last = e;
  let parent = exprAstParent(e);
  while (anTag(parent) === AN_CONDITIONAL_EXPRESSION) {
    const conditional = anId(parent);
    if (exprCondNo(conditional) !== last) return exprCondTest(conditional) !== last;
    last = conditional;
    parent = anParent(parent);
  }
  return anTag(parent) === AN_JSX_EXPRESSION_CONTAINER && anTag(anParent(parent)) === AN_JSX_ATTRIBUTE;
}

/**
 * Prettier's `isSimpleExpressionByNodeCount`: whether there are at most `max` nodes in `e`, of those that are the value of a property of a
 * node of ESTree. What is in a list, like the arguments of a call, does not count.
 */
function isSimpleExpressionByNodeCount(e: number, max: number, f: Formatter): boolean {
  return innerNodeCount(e, max, cxOf(f).hasTreeOfBabel) <= max;
}

function child(e: number, count: number, max: number, isJavascript: boolean): number {
  return count > max ? count : (count + 1 + innerNodeCount(e, (max - count) | 0, isJavascript)) | 0;
}

/**
 * The count can stop at anything above `max`. Babel, which reads JavaScript for Prettier, has no `ChainExpression` and has a name in a
 * `PrivateName`.
 */
function innerNodeCount(e: number, max: number, isJavascript: boolean): number {
  const privateName = isJavascript ? 1 : 0;
  let count: number;
  switch (exprTag(e)) {
    case EXPR_MISSING:
    case EXPR_IDENT:
    case EXPR_THIS:
    case EXPR_SUPER:
    case EXPR_NULL:
    case EXPR_TRUE:
    case EXPR_FALSE:
    case EXPR_NUMBER:
    case EXPR_STRING:
    case EXPR_BIG_INT:
    case EXPR_REGEX:
    case EXPR_TEMPLATE:
    case EXPR_ARRAY:
    case EXPR_OBJECT:
      count = 0;
      break;
    case EXPR_PRIVATE_IDENTIFIER:
      count = privateName;
      break;
    case EXPR_IMPORT_META:
    case EXPR_NEW_TARGET:
      count = 2;
      break;
    case EXPR_DOT:
      count = child(exprDotObj(e), (1 + (exprIsPrivateMember(e) ? privateName : 0)) | 0, max, isJavascript);
      break;
    case EXPR_INDEX:
      count = child(exprIndexIndex(e), child(exprIndexObj(e), 0, max, isJavascript), max, isJavascript);
      break;
    case EXPR_CALL:
    case EXPR_NEW: {
      const call = exprAsCallLike(e);
      count = child(callCallee(call), callTypeArgsLen(call) > 0 ? 1 : 0, max, isJavascript);
      break;
    }
    // The template is a node.
    case EXPR_TAGGED_TEMPLATE: {
      const call = exprAsCallLike(e);
      count = child(callCallee(call), (1 + (callTypeArgsLen(call) > 0 ? 1 : 0)) | 0, max, isJavascript);
      break;
    }
    case EXPR_UNARY:
    case EXPR_AWAIT:
    case EXPR_SPREAD:
      count = child(exprOperand(e), 0, max, isJavascript);
      break;
    case EXPR_YIELD: {
      const value = exprYieldValue(e);
      count = value >= 0 ? child(value, 0, max, isJavascript) : 0;
      break;
    }
    case EXPR_BINARY:
      if (exprBinaryOpOf(e) === BIN_COMMA) count = 0;
      else count = child(exprBinaryRight(e), child(exprBinaryLeft(e), 0, max, isJavascript), max, isJavascript);
      break;
    case EXPR_ASSIGN:
      count = child(exprAssignValue(e), child(exprAssignTarget(e), 0, max, isJavascript), max, isJavascript);
      break;
    case EXPR_COND:
      count = child(
        exprCondNo(e),
        child(exprCondYes(e), child(exprCondTest(e), 0, max, isJavascript), max, isJavascript),
        max,
        isJavascript,
      );
      break;
    case EXPR_NON_NULL: {
      const marks = exprNonNullCount(e);
      count = child(exprOperand(e), marks > 0 ? (marks - 1) | 0 : 0, max, isJavascript);
      break;
    }
    case EXPR_AS:
    case EXPR_SATISFIES:
      count = child(exprOperand(e), (1 + innerTypeNodeCount(typeOfAssertion(e))) | 0, max, isJavascript);
      break;
    // `const` is a `TSTypeReference` with a name.
    case EXPR_AS_CONST:
      count = child(exprOperand(e), 2, max, isJavascript);
      break;
    case EXPR_INSTANTIATION:
      count = child(exprInstantiationExpr(e), 1, max, isJavascript);
      break;
    case EXPR_IMPORT_CALL: {
      count = 0;
      const s = exprImportCallArgsStart(e);
      const n = exprImportCallArgsLen(e);
      for (let i = 0; i < n; i++) count = child(listAt(s, i), count, max, isJavascript);
      break;
    }
    case EXPR_FN: {
      const func = exprAsFn(e);
      const returnType = funcReturnType(func);
      const signature = ((funcName(func) >= 0 ? 1 : 0) + (funcTypeParamsLen(func) > 0 ? 1 : 0) + (returnType >= 0 ? (2 + innerTypeNodeCount(returnType)) | 0 : 0)) | 0;
      count = funcBodyKind(func) === BODY_EXPR ? child(funcBodyExpr(func), signature, max, isJavascript) : (signature + 1) | 0;
      break;
    }
    // At least the body, or the opening element and its name.
    case EXPR_CLASS: {
      const cls = exprAsClass(e);
      const extendsExpr = classExtends(cls);
      count = (1 + (className(cls) >= 0 ? 1 : 0) + (extendsExpr >= 0 ? child(extendsExpr, 0, max, isJavascript) : 0)) | 0;
      break;
    }
    case EXPR_JSX:
      count = 2;
      break;
    default:
      count = 0;
      break;
  }
  return !isJavascript && exprIsChainRoot(e) ? (count + 1) | 0 : count;
}

/** The type of an `as` or `satisfies` expression. */
function typeOfAssertion(e: number): number {
  return exprTag(e) === EXPR_AS ? exprAsTy(e) : exprSatisfiesTy(e);
}

/** The same for a type. Anything but the simplest counts as many. */
function innerTypeNodeCount(ty0: number): number {
  let ty = ty0;
  let arrays = 0;
  while (typeTag(ty) === TYPE_ARRAY) {
    ty = typeArrayElem(ty);
    arrays = (arrays + 1) | 0;
  }
  switch (typeTag(ty)) {
    case TYPE_KEYWORD:
      return arrays;
    case TYPE_STRING_LIT:
    case TYPE_BOOL_LIT:
      return (arrays + 1) | 0;
    case TYPE_REF: {
      const nameLen = typeRefNameLen(ty);
      return (arrays + (nameLen > 0 ? (2 * nameLen - 1) | 0 : 0) + (typeRefArgsLen(ty) > 0 ? 1 : 0)) | 0;
    }
    default:
      return (arrays + 4) | 0;
  }
}

/** Prettier's `wrapInParens`: in parentheses, on lines of its own, if the enclosing group breaks. `write` is done by the caller between. */
function openWrapInParens(f: Formatter): void {
  f.tokenIfBreaks(LPAREN);
  f.startSoftBlockIndent();
}
function closeWrapInParens(f: Formatter): void {
  f.endSoftBlockIndent();
  f.tokenIfBreaks(RPAREN);
}

/** What lines the alternate up with the consequent, which is indented. */
function writeFillTab(useTabs: boolean, indentWidth: number, f: Formatter): void {
  if (useTabs) {
    const buf = f.textBuf();
    const at = buf.len;
    buf.push(9);
    f.endBuiltText(at);
    return;
  }
  // What is too long for a text is too long for the indentation of the consequent, which the printer refuses.
  if (isTooLong(indentWidth)) return;
  const buf = f.textBuf();
  const at = buf.len;
  buf.fill(32, indentWidth > 0 ? (indentWidth - 1) | 0 : 0);
  f.endBuiltText(at);
}

export function writeTernary(kind: number, h: number, f: Formatter): void {
  const isTsConditional = kind !== CONDITIONAL_LIKE_CONDITIONAL_EXPRESSION;
  // The last of what is before the `?`, what is after it, and what is after the `:`.
  let test: number;
  let consequent: number;
  let alternate: number;
  let parent: number;
  if (!isTsConditional) {
    if (exprTag(h) !== EXPR_COND) return;
    test = exprCondTest(h);
    consequent = exprCondYes(h);
    alternate = exprCondNo(h);
    parent = exprAstParent(h);
  } else {
    test = typeCondExtends(h);
    consequent = typeCondYes(h);
    alternate = typeCondNo(h);
    parent = typeAstParent(h);
  }

  let isParentTernary = false;
  let isInTest = false;
  let isInAlternate = false;
  if (!isTsConditional) {
    if (anTag(parent) === AN_CONDITIONAL_EXPRESSION) {
      const p = anId(parent);
      isParentTernary = true;
      isInTest = exprCondTest(p) === h;
      isInAlternate = exprCondNo(p) === h;
    }
  } else if (anTag(parent) === AN_TS_CONDITIONAL_TYPE) {
    const p = anId(parent);
    isParentTernary = true;
    isInTest = typeCondCheck(p) === h || typeCondExtends(p) === h;
    isInAlternate = typeCondNo(p) === h;
  }
  const isConsequentTernary = operandIsConditional(isTsConditional, consequent);
  const isAlternateTernary = operandIsConditional(isTsConditional, alternate);
  const isInChain = isAlternateTernary || isInAlternate;
  const useTabs = f.options.indentStyle === INDENT_TAB;
  const indentWidth = f.options.indentWidth;
  const isBigTabs = indentWidth > 2 || useTabs;

  const parentTag = anTag(parent);
  const isOnSameLineAsReturn = (parentTag === AN_RETURN_STATEMENT || parentTag === AN_THROW_STATEMENT) && !isConsequentTernary && !isAlternateTernary;
  const isInJsx =
    !isTsConditional &&
    anTag(firstNonConditionalParent(h)) === AN_JSX_EXPRESSION_CONTAINER &&
    anTag(anParent(parent)) !== AN_JSX_ATTRIBUTE;
  const shouldExtraIndentHere = !isTsConditional && shouldExtraIndent(h);
  // So that what follows is right behind the `)`: `(a ? b : c\n).d`
  let breakClosingParen = false;
  if (!isTsConditional) {
    if (parentTag === AN_STATIC_MEMBER_EXPRESSION || parentTag === AN_PRIVATE_FIELD_EXPRESSION) breakClosingParen = true;
    // It is the left side.
    else if (parentTag === AN_BINARY_EXPRESSION) {
      const operator = exprBinaryOpOf(anId(parent));
      breakClosingParen = operator >= 0 && isAngularPipe(operator, f);
    }
  }
  const breakTsClosingParen = isTsConditional && typeNeedsParentheses(h, f);

  // A chain breaks as a whole.
  operandComments(isTsConditional, test, consequent, alternate, f);
  const afterTestFrom = OC[0] | 0;
  const afterTestTo = OC[0 + 1] | 0;
  const beforeConsequentFrom = OC[2] | 0;
  const beforeConsequentTo = OC[2 + 1] | 0;
  const afterConsequentFrom = OC[4] | 0;
  const afterConsequentTo = OC[4 + 1] | 0;
  const beforeColonFrom = OC[6] | 0;
  const beforeColonTo = OC[6 + 1] | 0;
  const shouldBreak = isConsequentTernary || isAlternateTernary || ocHasMultilineBlock(f);

  // So that a short consequent is not pushed to the next line:
  //
  //   const result = foo != null ? foo : (
  //     some + long + expression
  //   );
  let tryToParenthesizeAlternate = false;
  if (!isInChain && !isParentTernary && !isTsConditional) {
    if (isInJsx) {
      tryToParenthesizeAlternate = exprTag(consequent) === EXPR_NULL;
    } else {
      tryToParenthesizeAlternate =
        beforeConsequentFrom === beforeConsequentTo &&
        afterConsequentFrom === afterConsequentTo &&
        isShortArgument(consequent, (f.options.lineWidth / 4) >>> 0, f) &&
        isSimpleExpressionByNodeCount(test, 3, f);
    }
  }

  const shouldGroupTestAndConsequent =
    isInChain ||
    (isTsConditional && !isParentTernary) ||
    (isParentTernary && !isTsConditional && isSimpleExpressionByNodeCount(test, 1, f)) ||
    tryToParenthesizeAlternate;

  const testId = f.groupId();
  const testAndConsequentId = f.groupId();

  // The wrapper of `format_parts`.
  if (isOnSameLineAsReturn) {
    f.startGroup();
    f.startIndent();
  } else if (shouldExtraIndentHere || (isTsConditional && isInTest)) {
    f.startGroup();
    f.startIndent();
    f.softLineBreak();
  } else if (!isParentTernary || isInTest) {
    f.startGroup();
  }

  // format_parts
  // format_test_and_consequent
  if (!shouldGroupTestAndConsequent) {
    writeTestWithQuestionMark(isTsConditional, h, test, afterTestFrom, afterTestTo, testId, f);
    writeConsequent(
      isTsConditional,
      consequent,
      isConsequentTernary,
      isInJsx,
      isParentTernary,
      isInChain,
      afterConsequentFrom,
      afterConsequentTo,
      f,
    );
  } else {
    f.startGroupId(testAndConsequentId);
    writeTestWithQuestionMark(isTsConditional, h, test, afterTestFrom, afterTestTo, testId, f);
    if (isInChain) {
      writeConsequent(
        isTsConditional,
        consequent,
        isConsequentTernary,
        isInJsx,
        isParentTernary,
        isInChain,
        afterConsequentFrom,
        afterConsequentTo,
        f,
      );
    } else {
      // If the test breaks, so does the consequent.
      const slot = f.startCapture();
      writeConsequent(
        isTsConditional,
        consequent,
        isConsequentTernary,
        isInJsx,
        isParentTernary,
        isInChain,
        afterConsequentFrom,
        afterConsequentTo,
        f,
      );
      const interned = f.endCapture(slot);
      f.startIfGroupBreaksId(testId);
      f.writeInterned(interned);
      f.endConditional();
      f.startIfGroupFitsId(testId);
      f.startGroup();
      f.writeInterned(interned);
      f.endGroup();
      f.endConditional();
    }
    f.endGroup();
  }

  if (beforeColonFrom < beforeColonTo) {
    f.startIndent();
    f.hardLineBreak();
    formatDanglingCommentsRange(beforeColonFrom, beforeColonTo, DANGLING_NONE, f);
    f.endIndent();
    f.hardLineBreak();
  } else if (isAlternateTernary) {
    f.hardLineBreak();
  } else if (tryToParenthesizeAlternate) {
    f.startIfGroupBreaksId(testAndConsequentId);
    f.softLineBreakOrSpace();
    f.endConditional();
    f.startIfGroupFitsId(testAndConsequentId);
    f.space();
    f.endConditional();
  } else {
    f.softLineBreakOrSpace();
  }

  f.token(T_COLON);

  if (isAlternateTernary || !isBigTabs) {
    f.space();
  } else if (shouldGroupTestAndConsequent) {
    f.startIfGroupBreaksId(testAndConsequentId);
    writeFillTab(useTabs, indentWidth, f);
    f.endConditional();
    f.startIfGroupFitsId(testAndConsequentId);
    if (isInChain || tryToParenthesizeAlternate) {
      f.space();
    } else {
      f.startIfGroupBreaks();
      writeFillTab(useTabs, indentWidth, f);
      f.endConditional();
      f.startIfGroupFits();
      f.space();
      f.endConditional();
    }
    f.endConditional();
  } else {
    f.startIfGroupBreaks();
    writeFillTab(useTabs, indentWidth, f);
    f.endConditional();
    f.startIfGroupFits();
    f.space();
    f.endConditional();
  }

  const wk = isTsConditional ? WK_TYPE : WK_EXPR;
  if (isAlternateTernary) {
    writeAlternate(wk, alternate, false, testAndConsequentId, f);
  } else {
    f.startGroup();
    f.startIndent();
    writeAlternate(wk, alternate, tryToParenthesizeAlternate, testAndConsequentId, f);
    f.endIndent();
    if (isInJsx && !tryToParenthesizeAlternate) {
      // Prettier writes both line breaks, which makes an empty line.
      if (!isTsConditional && isFollowedByLineBreak(h)) f.softEmptyLine();
      else f.softLineBreak();
    }
    f.endGroup();
  }

  if (breakClosingParen && !shouldExtraIndentHere) f.softLineBreak();
  if (shouldBreak) f.expandParent();

  // Close the wrapper.
  if (isOnSameLineAsReturn) {
    f.endIndent();
    f.endGroup();
  } else if (shouldExtraIndentHere || (isTsConditional && isInTest)) {
    f.endIndent();
    if (breakTsClosingParen) f.softLineBreak();
    f.endGroup();
  } else if (!isParentTernary || isInTest) {
    f.endGroup();
  }
}

/** `group(format_test, space, "?").with_group_id(test_id)` */
function writeTestWithQuestionMark(
  isTsConditional: boolean,
  h: number,
  test: number,
  afterTestFrom: number,
  afterTestTo: number,
  testId: number,
  f: Formatter,
): void {
  f.startGroupId(testId);
  if (!isTsConditional) {
    const isConditional = exprTag(test) === EXPR_COND;
    if (parenthesisBeforeNeedsSemicolon(h, f)) f.tokenIfBreaks(SEMI);
    openWrapInParens(f);
    writeOperand(false, test, afterTestFrom, afterTestTo, f);
    closeWrapInParens(f);
    if (isConditional) f.expandParent();
  } else {
    fmtType(typeCondCheck(h), f);
    f.space();
    f.token(T_EXTENDS);
    f.space();
    const t = typeTag(test);
    if (t === TYPE_COND || t === TYPE_MAPPED) {
      writeOperand(true, test, afterTestFrom, afterTestTo, f);
    } else {
      f.startGroup();
      openWrapInParens(f);
      writeOperand(true, test, afterTestFrom, afterTestTo, f);
      closeWrapInParens(f);
      f.endGroup();
    }
  }
  f.space();
  f.token(T_QUESTION);
  f.endGroup();
}

function writeConsequent(
  isType: boolean,
  consequent: number,
  isConsequentTernary: boolean,
  isInJsx: boolean,
  isParentTernary: boolean,
  isInChain: boolean,
  afterConsequentFrom: number,
  afterConsequentTo: number,
  f: Formatter,
): void {
  const isOnItsOwnLine =
    isConsequentTernary || (isInJsx && (isParentTernary || isInChain || (!isType && exprTag(consequent) === EXPR_JSX)));
  f.startIndent();
  if (isOnItsOwnLine) f.hardLineBreak();
  else f.softLineBreakOrSpace();
  writeOperand(isType, consequent, afterConsequentFrom, afterConsequentTo, f);
  f.endIndent();
}

/** `format_alternate` */
function writeAlternate(wk: number, alternate: number, tryToParenthesize: boolean, testAndConsequentId: number, f: Formatter): void {
  if (!tryToParenthesize) {
    fmtNodeWithoutTrailingComments(wk, alternate, f);
    return;
  }
  const slot = f.startCapture();
  fmtNodeWithoutTrailingComments(wk, alternate, f);
  const interned = f.endCapture(slot);
  f.startIfGroupBreaksId(testAndConsequentId);
  f.writeInterned(interned);
  f.endConditional();
  f.startIfGroupFitsId(testAndConsequentId);
  f.startDedent();
  openWrapInParens(f);
  f.writeInterned(interned);
  closeWrapInParens(f);
  f.endDedent();
  f.endConditional();
}
