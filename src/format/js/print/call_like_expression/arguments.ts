// Port of vendor/bun/src/format/js/print/call_like_expression/arguments.rs: the arguments of a call. Prettier's `printCallArguments`.
//
// `(a, b)`: `fmtArguments(argsStart, argsLen, parent, f)`; `parent` is the `CallExpression`, the `NewExpression` or the `ImportExpression`
// (an `AstNodes`). The arguments that are formatted ahead of the layout are captures (`f.startCapture()`): their handles are in `av`, a
// stack: a call in an argument takes what is above, and gives it back.
import { Formatter } from "../../../ir/formatter.ts";
import { COMMA, EMPTY_PARENS, LPAREN, RPAREN } from "../../../ir/tokens.ts";
import { I32Vec } from "../../../../base/i32vec.ts";
import {
  FLAVOR_OXFMT,
  FTC_ARGUMENTS,
  trailingSeparator,
} from "../../../options.ts";
import {
  BIN_COMMA,
  BODY_BLOCK,
  BODY_EXPR,
  EXPR_ARRAY,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_BINARY,
  EXPR_CALL,
  EXPR_COND,
  EXPR_FN,
  EXPR_IDENT,
  EXPR_IMPORT_CALL,
  EXPR_JSX,
  EXPR_NEW,
  EXPR_NON_NULL,
  EXPR_OBJECT,
  EXPR_REGEX,
  EXPR_SATISFIES,
  EXPR_SPREAD,
  EXPR_TAGGED_TEMPLATE,
  EXPR_TEMPLATE,
  N_EXPR,
  SP,
  TYPE_ARRAY,
  TYPE_BIG_INT_LIT,
  TYPE_BOOL_LIT,
  TYPE_KEYWORD,
  TYPE_NUMBER_LIT,
  TYPE_REF,
  TYPE_STRING_LIT,
  TYPE_TEMPLATE,
  VAR_CONST,
  callArgsLen,
  callArgsStart,
  callCallee,
  exprArrayElemsLen,
  exprArrayElemsStart,
  exprAsCallLike,
  exprAsFn,
  exprBinaryLeft,
  exprBinaryOp,
  exprBinaryRight,
  exprAssignTarget,
  exprDotName,
  EXPR_DOT,
  exprCallee,
  exprDotObj,
  exprEnd,
  exprImportCallArgsLen,
  exprImportCallArgsStart,
  exprIsAngleBracketAssertion,
  exprIsFlowTypeCast,
  exprIsParenthesized,
  exprIdentName,
  exprObjectPropsLen,
  exprOperand,
  exprSpan,
  exprStart,
  exprTag,
  fileIsFlow,
  funcBodyExpr,
  funcBodyKind,
  funcIsArrow,
  funcOwner,
  funcParamsLen,
  funcReturnType,
  funcThisParam,
  funcTypeParamsLen,
  listAt,
  nameIs,
  nodeId,
  nodeKind,
  stmtTag,
  STMT_VAR,
  stmtVarDeclsLen,
  typeArrayElem,
  typeRefArgsLen,
  typeRefArgsStart,
  typeSpan,
  typeTag,
  varDeclKind,
} from "../../../../lint/ast/index.ts";
import {
  AN_ARROW_FUNCTION_EXPRESSION,
  AN_ARRAY_EXPRESSION,
  AN_ASSIGNMENT_EXPRESSION,
  AN_CALL_EXPRESSION,
  AN_DECORATOR,
  AN_EXPORT_DEFAULT_DECLARATION,
  AN_FORMAL_PARAMETERS,
  AN_FUNCTION,
  AN_IDENTIFIER_REFERENCE,
  AN_IMPORT_EXPRESSION,
  AN_NEW_EXPRESSION,
  AN_OBJECT_EXPRESSION,
  AN_STATIC_MEMBER_EXPRESSION,
  AN_TS_AS_EXPRESSION,
  AN_TS_EXPORT_ASSIGNMENT,
  AN_TS_SATISFIES_EXPRESSION,
  AN_TS_TYPE_ASSERTION,
  AN_VARIABLE_DECLARATION,
  AN_VARIABLE_DECLARATOR,
  anId,
  anParent,
  anSpan,
  anEnd,
  anTag,
  exprAsAstNodes,
  exprAsChainElement,
  exprAstParent,
  mkAn,
} from "../../ast_nodes.ts";
import { cxOf } from "../../context.ts";
import { exprArrowFunction, exprTypeAnnotation } from "../../fields.ts";
import {
  EO_NONE,
  exprOptionsArrow,
  exprOptionsFunction,
  fmtExpr,
  writeExpression,
} from "../../format.ts";
import { formatDanglingComments, DANGLING_SOFT } from "../../trivia.ts";
import { linesBefore, writeSeparatorAfter } from "../../builders.ts";
import { canConciselyPrintArrayList } from "../array_element_list.ts";
import {
  FUNCTION_CACHE_MODE_CACHE,
  GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_FIRST_ARGUMENT,
  GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_LAST_ARGUMENT,
  endSignatureWithoutLines,
  isMultilineTemplateStartingOnSameLine,
} from "../arrow_function_expression.ts";
import { hasOnlySimpleParameters } from "../parameters.ts";
import { isNextLineEmpty } from "../program.ts";
import { isCallExpression, stripChainElementWrappers } from "../../utils/call_expression.ts";
import { isSimpleArgument, isSimpleArgumentWithDepth } from "../../utils/member_chain/simple_argument.ts";
import { isCastTarget } from "../../utils/typecast.ts";
import { isLongCurriedCall } from "../../utils/mod.ts";

/** The handles of what has been formatted ahead of the layout of a call (-1: nothing was written). */
const av = new I32Vec(64);

// ───────────────────────────── the flavors ─────────────────────────────

/** oxfmt goes by the line breaks between two arguments, wherever the comma is. Prettier goes by the line after the argument. */
function countsLineBreaksBetweenArguments(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** Prettier's `allArgsBrokenOut` has `line`, not `softline`, behind the `(` and before the `)`. They are line breaks either way, until `removeLines` makes blanks of them. */
function hasLinesInParentheses(expand: boolean, f: Formatter): boolean {
  return expand && f.options.flavor !== FLAVOR_OXFMT;
}

/**
 * `setTimeout((() => { a(); }), 1)`, as minifiers write it: oxfmt looks for the `,` right behind the function, finds a `)`, and puts each
 * argument on a line of its own. The parentheses go, so the second time it does not.
 */
function functionInParenthesesIsNotHugged(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `new A(b, function (c, d) {})`: for Prettier the parameters can break while the function is hugged. For oxfmt they cannot, as in a call. */
function newIsACallLikeAnother(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * ```js
 * a                 a
 *   .b(`              .b(
 * c                     `
 * `)                c
 *   .d();           `,
 *                     )
 *                     .d();
 * ```
 *
 * oxfmt on the left, Prettier on the right, which only looks at the last call of a chain.
 */
function hugsLoneTemplateInMemberChain(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** oxfmt, like Prettier 3.8, keeps the type parameters of `a(<T>() => {})` on one line while it is hugged, as it does if there are parameters. */
function flattensTypeParametersWithoutParameters(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

// ───────────────────────────── helpers ─────────────────────────────

function isFunctionLike(e: number): boolean {
  return exprAsFn(e) >= 0;
}

/** Whether `e` is a template that is written as the language in it. TODO(port): css, graphql, markdown and html embeds (`has_embed_label`). */
export function hasEmbedLabel(e: number, f: Formatter): boolean {
  return hasEmbedLabelOfOtherThanHtml(e, f) || htmlInJsLabel(e, f) !== HTML_LABEL_NONE;
}

/** TODO(port): `css::embed::has_embed_label`, `graphql::embed::has_embed_label`, `markdown::embed::has_embed_label`. */
export function hasEmbedLabelOfOtherThanHtml(e: number, f: Formatter): boolean {
  return false;
  void e;
  void f;
}

export const HTML_LABEL_NONE: number = -1;
export const HTML_LABEL_EMBED: number = 0;
export const HTML_LABEL_EMBED_WITHOUT_HUG: number = 1;
/** `html::in_js::label(e, f)`: `HTML_LABEL_*`. TODO(port): html. */
export function htmlInJsLabel(e: number, f: Formatter): number {
  return HTML_LABEL_NONE;
  void e;
  void f;
}

/** `label?.embed && label?.hug !== false` */
function hasEmbedLabelWithHug(e: number, f: Formatter): boolean {
  return hasEmbedLabelOfOtherThanHtml(e, f) || htmlInJsLabel(e, f) === HTML_LABEL_EMBED;
}

/** Prettier's `isTemplateOnItsOwnLine` of the only argument, which is not written as the language in it. */
export function isTemplateOnItsOwnLineOnlyArgument(argsStart: number, argsLen: number, f: Formatter): boolean {
  if (argsLen !== 1) return false;
  const only = listAt(argsStart, 0);
  return isMultilineTemplateStartingOnSameLine(only, f) && !hasEmbedLabel(only, f) && !isCastTarget(only, f);
}

/** `(a, b)`, without a way to break between the arguments. */
export function writeArgumentsOnOneLine(argsStart: number, argsLen: number, f: Formatter): void {
  f.token(LPAREN);
  for (let i = 0; i < argsLen; i++) {
    if (i > 0) f.space();
    fmtExpr(listAt(argsStart, i), f);
    if (i + 1 < argsLen) f.token(COMMA);
  }
  f.token(RPAREN);
}

/** Whether the arguments of an `import()` have no trailing comma: no comma is allowed after the last. */
function writeTrailingCommasOfArguments(parent: number, f: Formatter): void {
  if (anTag(parent) !== AN_IMPORT_EXPRESSION) f.writeTrailingCommas(FTC_ARGUMENTS, COMMA);
}

/** `parent` of the call or the `new` expression `e`. */
export function fmtArgumentsOfCall(e: number, call: number, f: Formatter): void {
  const parent = exprTag(e) === EXPR_CALL ? mkAn(AN_CALL_EXPRESSION, e) : exprAsChainElement(e);
  fmtArguments(callArgsStart(call), callArgsLen(call), parent, f);
}

// ───────────────────────────── the layouts ─────────────────────────────

export function fmtArguments(argsStart: number, argsLen: number, parent: number, f: Formatter): void {
  const cx = cxOf(f);
  if (argsLen === 0) {
    if (cx.isQuiet) {
      f.token(EMPTY_PARENS);
      return;
    }
    // `call/* comment1 */(/* comment2 */)`
    f.token(LPAREN);
    anSpan(parent);
    formatDanglingComments(SP[0] | 0, SP[1] | 0, DANGLING_SOFT, f);
    f.token(RPAREN);
    return;
  }
  const lastIndex = argsLen - 1;

  // Most arguments are of none of the kinds that it takes for a layout other than the plain one.
  let hasFunction = false;
  let hasArray = false;
  let hasTemplate = false;
  let hasFnCallNonNull = false;
  let hasCanBeGrouped = false;
  // An empty line between two arguments is kept, which takes breaking them all.
  let hasEmptyLine = false;
  let previousEnd = -1;
  for (let index = 0; index < argsLen; index++) {
    const argument = listAt(argsStart, index);
    const t = exprTag(argument);
    switch (t) {
      case EXPR_FN:
        hasFunction = true;
        hasFnCallNonNull = true;
        hasCanBeGrouped = true;
        break;
      case EXPR_ARRAY:
        hasArray = true;
        hasCanBeGrouped = true;
        break;
      case EXPR_TEMPLATE:
      case EXPR_TAGGED_TEMPLATE:
        hasTemplate = true;
        hasCanBeGrouped = true;
        break;
      case EXPR_CALL:
      case EXPR_NON_NULL:
        hasFnCallNonNull = true;
        break;
      case EXPR_OBJECT:
      case EXPR_AS:
      case EXPR_AS_CONST:
      case EXPR_SATISFIES:
        hasCanBeGrouped = true;
        break;
      default:
        break;
    }
    if (previousEnd >= 0 && !hasEmptyLine) hasEmptyLine = isEmptyLineBetween(previousEnd, argument, f);
    if (index !== lastIndex) {
      previousEnd = exprEndOf(argument);
    }
  }

  if (hasFunction && hasArray && isReactHookWithDepsArray(argsStart, argsLen, parent, f)) {
    writeArgumentsOnOneLine(argsStart, argsLen, f);
    return;
  }

  if (hasTemplate && hugsLoneTemplateInMemberChain(f) && isTemplateOnItsOwnLineOnlyArgument(argsStart, argsLen, f)) {
    writeArgumentsOnOneLine(argsStart, argsLen, f);
    return;
  }

  if (
    hasEmptyLine ||
    (hasFnCallNonNull && isFunctionCompositionArgs(argsStart, argsLen, f) && anTag(anParent(parent)) !== AN_DECORATOR)
  ) {
    formatAllArgsBrokenOut(argsStart, argsLen, parent, true, f);
    return;
  }

  let groupLayout = -1;
  if (hasCanBeGrouped) groupLayout = argumentsGroupedLayout(argsStart, argsLen, f);
  if (groupLayout >= 0) {
    writeGroupedArguments(argsStart, argsLen, parent, groupLayout, f);
  } else if (anTag(parent) === AN_CALL_EXPRESSION && isLongCurriedCall(anId(parent), f)) {
    const ts = trailingSeparator(FTC_ARGUMENTS, f.options);
    f.token(LPAREN);
    f.startSoftBlockIndent();
    for (let i = 0; i < argsLen; i++) {
      if (i > 0) f.softLineBreakOrSpace();
      fmtExpr(listAt(argsStart, i), f);
      writeSeparatorAfter(f, COMMA, i === argsLen - 1, ts, 0);
    }
    f.endSoftBlockIndent();
    f.token(RPAREN);
  } else {
    // Whether the group breaks is known when its content is written.
    const start = f.reserveTag();
    f.token(LPAREN);
    f.startSoftBlockIndent();
    for (let i = 0; i < argsLen; i++) {
      if (i > 0) {
        f.token(COMMA);
        f.softLineBreakOrSpace();
      }
      fmtExpr(listAt(argsStart, i), f);
    }
    writeTrailingCommasOfArguments(parent, f);
    f.endSoftBlockIndent();
    f.token(RPAREN);
    const shouldExpand = f.willBreakFrom(start + 1);
    f.groupFrom(start, shouldExpand);
  }
}


function exprEndOf(e: number): number {
  return exprEnd(e);
}

/** The same for an argument that ends at `end` and is followed by `next`. */
function isEmptyLineBetween(end: number, next: number, f: Formatter): boolean {
  const cx = cxOf(f);
  if (countsLineBreaksBetweenArguments(f)) {
    const start = exprStart(next);
    const text = cx.src.text;
    let count = 0;
    for (let i = end; i < start; i++) {
      if ((text[i] | 0) === 10) {
        count = (count + 1) | 0;
        if (count >= 2) return true;
      }
    }
    return false;
  }
  return isNextLineEmpty(cx.src, end);
}

/** Whether the arguments break because of what is between the one at `index` and the next. */
function isFollowedByEmptyLine(argsStart: number, argsLen: number, index: number, f: Formatter): boolean {
  if (index >= argsLen) return false;
  const argument = listAt(argsStart, index);
  const end = exprEnd(argument);
  if (index + 1 < argsLen) return isEmptyLineBetween(end, listAt(argsStart, index + 1), f);
  return isNextLineEmpty(cxOf(f).src, end);
}

/** Whether there is an empty line after the argument at `index`, which has been written. */
function isEmptyLineKeptAfter(argsStart: number, argsLen: number, index: number, f: Formatter): boolean {
  if (countsLineBreaksBetweenArguments(f) && index + 1 < argsLen) {
    const next = listAt(argsStart, index + 1);
    exprSpan(next);
    return linesBefore(SP[0] | 0, SP[1] | 0, f) > 1;
  }
  return isFollowedByEmptyLine(argsStart, argsLen, index, f);
}

/**
 * Prettier's `isFunctionCompositionArguments`: `compose(sortBy(x => x), flatten, map(x => [x, x * 2]))` has several functions among the
 * arguments, or in the arguments of an argument.
 */
function isFunctionCompositionArgs(argsStart: number, argsLen: number, f: Formatter): boolean {
  if (argsLen <= 1) return false;
  let hasSeenFunctionLike = false;
  for (let i = 0; i < argsLen; i++) {
    const arg = listAt(argsStart, i);
    if (isCastTarget(arg, f)) {
      // Neither a function nor a call.
    } else if (isFunctionLike(arg)) {
      if (hasSeenFunctionLike) return true;
      hasSeenFunctionLike = true;
    } else {
      const t = exprTag(arg);
      if (t === EXPR_CALL || t === EXPR_NON_NULL) {
        const stripped = stripChainElementWrappers(arg, f);
        if (exprTag(stripped) === EXPR_CALL) {
          const call = exprAsCallLike(stripped);
          const n = callArgsLen(call);
          const as = callArgsStart(call);
          for (let k = 0; k < n; k++) if (isFunctionLike(listAt(as, k))) return true;
        }
      }
    }
  }
  return false;
}

/** Each argument on its own line; the arguments are the captures `av[ebase .. ebase + n)`. */
function formatAllElementsBrokenOut(ebase: number, n: number, parent: number, expand: boolean, f: Formatter): void {
  const hasLines = hasLinesInParentheses(expand, f);
  f.startGroupExpand(expand);
  f.token(LPAREN);
  f.startSoftBlockIndentWithMaybeSpace(hasLines);
  const av$ = av;
  for (let index = 0; index < n; index++) {
    const element = av$.data[(ebase + index) | 0] | 0;
    if (element >= 0) {
      if (index > 0) f.softLineBreakOrSpace();
      f.writeInterned(element);
    }
  }
  writeTrailingCommasOfArguments(parent, f);
  f.endSoftBlockIndentWithMaybeSpace(hasLines);
  f.token(RPAREN);
  f.endGroup();
}

function formatAllArgsBrokenOut(argsStart: number, argsLen: number, parent: number, expand: boolean, f: Formatter): void {
  const lastIndex = argsLen > 0 ? argsLen - 1 : 0;
  const hasLines = hasLinesInParentheses(expand, f);
  f.startGroupExpand(expand);
  f.token(LPAREN);
  f.startSoftBlockIndentWithMaybeSpace(hasLines);
  for (let index = 0; index < argsLen; index++) {
    fmtExpr(listAt(argsStart, index), f);
    if (index !== lastIndex) {
      f.token(COMMA);
      if (isEmptyLineKeptAfter(argsStart, argsLen, index, f)) f.emptyLine();
      else f.softLineBreakOrSpace();
    }
  }
  writeTrailingCommasOfArguments(parent, f);
  f.endSoftBlockIndentWithMaybeSpace(hasLines);
  f.token(RPAREN);
  f.endGroup();
}

/** `argument` unless it is a spread, else -1. */
function asExpression(argument: number): number {
  return exprTag(argument) === EXPR_SPREAD ? -1 : argument;
}

/** Prettier's `shouldGroupFirst` and `shouldGroupLast`. Returns a `GROUPED_CALL_ARGUMENT_LAYOUT_*`, or -1. */
function argumentsGroupedLayout(argsStart: number, argsLen: number, f: Formatter): number {
  const cx = cxOf(f);
  // What is written as it is has no label. oxfmt does not look.
  if (argsLen === 1) {
    const only = listAt(argsStart, 0);
    if (hasEmbedLabelWithHug(only, f)) {
      if (cx.isQuiet || f.options.flavor === FLAVOR_OXFMT || !cx.comments.isSuppressed(exprStart(only))) {
        return GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_LAST_ARGUMENT;
      }
    }
  }
  if (argsLen === 2) {
    const first0 = listAt(argsStart, 0);
    const second = asExpression(listAt(argsStart, 1));
    if (second < 0) return -1;
    const first = asExpression(first0);
    if (canGroupExpressionArgument(second, f)) {
      return shouldGroupLastArgumentImpl(argsStart, argsLen, first, second, f) ? GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_LAST_ARGUMENT : -1;
    }
    if (first < 0) return -1;
    return shouldGroupFirstArgument(first, second, f) ? GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_FIRST_ARGUMENT : -1;
  }
  const last = asExpression(listAt(argsStart, argsLen - 1));
  if (last < 0) return -1;
  const penultimate = argsLen >= 2 ? asExpression(listAt(argsStart, argsLen - 2)) : -1;
  if (canGroupExpressionArgument(last, f) && shouldGroupLastArgumentImpl(argsStart, argsLen, penultimate, last, f)) {
    return GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_LAST_ARGUMENT;
  }
  return -1;
}

function shouldGroupFirstArgument(first: number, second: number, f: Formatter): boolean {
  // A function expression, or an arrow function with a block.
  const func = exprAsFn(first);
  if (func < 0 || funcBodyKind(func) === BODY_EXPR || isCastTarget(first, f)) return false;
  if (isFunctionLike(second) || exprTag(second) === EXPR_COND) return false;
  if (exprIsParenthesized(first) && functionInParenthesesIsNotHugged(f)) return false;

  // Not if there are comments around the first argument: before it, between it and the comma, or behind the comma at the end of the line.
  const cx = cxOf(f);
  if (!cx.isQuiet) {
    const cm = cx.comments;
    exprSpan(first);
    const firstStart = SP[0] | 0;
    const firstEnd = SP[1] | 0;
    if (cm.hasCommentBefore(firstStart)) return false;
    cm.commentsIn(firstEnd, exprStart(second));
    const to = cm.to;
    for (let i = cm.from; i < to; i++) {
      if (cm.followedByNewline(i) || !cx.src.containsByte(firstEnd, cm.spanStart[i] | 0, 44)) return false;
    }
  }
  return isHopefullyShortCallArgument(second, f);
}

function sameKindOfNode(a: number, b: number): boolean {
  const ta = anTag(exprAsAstNodes(a));
  const tb = anTag(exprAsAstNodes(b));
  if (ta !== tb) return false;
  return (
    ta === AN_OBJECT_EXPRESSION ||
    ta === AN_ARRAY_EXPRESSION ||
    ta === AN_TS_AS_EXPRESSION ||
    ta === AN_TS_SATISFIES_EXPRESSION ||
    ta === AN_TS_TYPE_ASSERTION ||
    ta === AN_ARROW_FUNCTION_EXPRESSION ||
    ta === AN_FUNCTION
  );
}

function shouldGroupLastArgumentImpl(argsStart: number, argsLen: number, penultimate: number, last: number, f: Formatter): boolean {
  const cx = cxOf(f);
  const previousEnd = argsLen >= 2 ? exprEnd(listAt(argsStart, argsLen - 2)) : -1;

  // Not if the one before is of the same kind.
  if (penultimate >= 0 && !isCastTarget(penultimate, f) && sameKindOfNode(penultimate, last)) return false;

  // Not if there are comments around the last argument.
  if (!cx.isQuiet) {
    const cm = cx.comments;
    exprSpan(last);
    const lastStart = SP[0] | 0;
    const lastEnd = SP[1] | 0;
    // A comment at the end of the line of the argument before, or before the comma, trails that.
    let hasCommentBeforeLast = false;
    if (previousEnd >= 0) {
      cm.commentsIn(previousEnd, lastStart);
      const to = cm.to;
      for (let i = cm.from; i < to; i++) {
        if (cm.precededByNewline(i) || (!cm.followedByNewline(i) && !cx.src.containsByte(cm.spanEnd[i] | 0, lastStart, 44))) {
          hasCommentBeforeLast = true;
          break;
        }
      }
    } else {
      hasCommentBeforeLast = cm.hasCommentBefore(lastStart);
    }
    if (hasCommentBeforeLast) return false;
    if (cm.commentsAfter(lastEnd) > 0) {
      if (!cx.src.containsByte(lastEnd, cm.spanStart[cm.from] | 0, 41)) return false;
    }
  }

  if (exprTag(last) === EXPR_ARRAY && argsLen > 1) {
    // Not for `useEffect(() => {}, [a, b])`.
    if (argsLen === 2 && penultimate >= 0 && exprArrowFunction(penultimate) >= 0) return false;
    exprSpan(last);
    return !canConciselyPrintArrayList(SP[0] | 0, SP[1] | 0, exprArrayElemsStart(last), exprArrayElemsLen(last), f);
  }
  return true;
}

/** A keyword, a literal or a name without type arguments. Up to two `[]` and one type argument are looked through: `string[][]`, `Foo<string>[]`. */
function isSimpleTsType(ty: number): boolean {
  let extractedArrayType = ty;
  if (typeTag(ty) === TYPE_ARRAY) {
    const element = typeArrayElem(ty);
    extractedArrayType = typeTag(element) === TYPE_ARRAY ? typeArrayElem(element) : element;
  }
  let extractedGenericType = extractedArrayType;
  if (typeTag(extractedArrayType) === TYPE_REF && typeRefArgsLen(extractedArrayType) === 1) {
    extractedGenericType = listAt(typeRefArgsStart(extractedArrayType), 0);
  }
  switch (typeTag(extractedGenericType)) {
    case TYPE_KEYWORD:
    case TYPE_STRING_LIT:
    case TYPE_NUMBER_LIT:
    case TYPE_BIG_INT_LIT:
    case TYPE_BOOL_LIT:
    case TYPE_TEMPLATE:
      return true;
    case TYPE_REF:
      return typeRefArgsLen(extractedGenericType) === 0;
    default:
      return false;
  }
}

/** Prettier's `isHopefullyShortCallArgument`. */
function isHopefullyShortCallArgument(argument: number, f: Formatter): boolean {
  const t = exprTag(argument);
  if (t === EXPR_AS || t === EXPR_AS_CONST || t === EXPR_SATISFIES) {
    if (!exprIsAngleBracketAssertion(argument) || fileIsFlow()) {
      const ty = exprTypeAnnotation(argument);
      return (ty < 0 || isSimpleTsType(ty)) && isSimpleArgumentWithDepth(exprOperand(argument), 1, f);
    }
  } else if (t === EXPR_CALL) {
    if (callArgsLen(exprAsCallLike(argument)) > 1 && isCallExpression(argument, f)) return false;
  } else if (t === EXPR_NEW) {
    if (callArgsLen(exprAsCallLike(argument)) > 1) return false;
  } else if (t === EXPR_IMPORT_CALL) {
    if (exprImportCallArgsLen(argument) > 1) return false;
  } else if (t === EXPR_BINARY) {
    if (exprBinaryOp(argument) !== BIN_COMMA) {
      return isSimpleArgumentWithDepth(exprBinaryLeft(argument), 1, f) && isSimpleArgumentWithDepth(exprBinaryRight(argument), 1, f);
    }
  } else if (t === EXPR_REGEX) {
    return true;
  }
  return isSimpleArgument(argument, f);
}

/** Prettier's `couldExpandArg`. */
function canGroupExpressionArgument(argument0: number, f: Formatter): boolean {
  let argument = argument0;
  for (;;) {
    if (isCastTarget(argument, f)) return false;
    switch (exprTag(argument)) {
      case EXPR_OBJECT:
        if (exprObjectPropsLen(argument) > 0) return true;
        exprSpan(argument);
        return cxOf(f).comments.hasCommentInRange(SP[0] | 0, SP[1] | 0);
      case EXPR_ARRAY:
        if (exprArrayElemsLen(argument) > 0) return true;
        exprSpan(argument);
        return cxOf(f).comments.hasCommentInRange(SP[0] | 0, SP[1] | 0);
      case EXPR_AS:
        if (exprIsFlowTypeCast(argument)) return false;
        argument = exprOperand(argument);
        break;
      case EXPR_AS_CONST:
      case EXPR_SATISFIES:
        argument = exprOperand(argument);
        break;
      case EXPR_FN: {
        const func = exprAsFn(argument);
        if (funcIsArrow(func)) return canGroupArrowFunctionExpressionArgument(func, f);
        return true;
      }
      default:
        return false;
    }
  }
}

function canGroupArrowFunctionExpressionArgument(arrow0: number, f: Formatter): boolean {
  let arrowFunction = arrow0;
  // It is the body of another one.
  let isArrowRecursion = false;
  for (;;) {
    if (funcBodyKind(arrowFunction) !== BODY_EXPR) return true;
    const expression = funcBodyExpr(arrowFunction);
    // The parentheses of a type cast are a node for Prettier, which is not one of these.
    if (isCastTarget(expression, f)) return false;
    const t = exprTag(expression);
    if (t === EXPR_OBJECT || t === EXPR_ARRAY || t === EXPR_JSX) return true;
    if (t === EXPR_FN && funcIsArrow(exprAsFn(expression))) {
      arrowFunction = exprAsFn(expression);
      isArrowRecursion = true;
    } else if (t === EXPR_COND) {
      return !isArrowRecursion;
    } else {
      return !isArrowRecursion && exprTag(stripChainElementWrappers(expression, f)) === EXPR_CALL;
    }
  }
}

// ───────────────────────────── grouped arguments ─────────────────────────────

/** The writer of `FormatGroupedFirstArgument`. */
function writeGroupedFirstArgument(argument: number, lastIndex: number, f: Formatter): void {
  if (exprArrowFunction(argument) >= 0) {
    writeExpression(
      argument,
      exprOptionsArrow(-1, GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_FIRST_ARGUMENT, FUNCTION_CACHE_MODE_CACHE),
      f,
    );
  } else {
    // It has been formatted and cached.
    fmtExpr(argument, f);
  }
  if (lastIndex !== 0) f.token(COMMA);
}

/** The writer of `FormatGroupedLastArgument`. `expandsParameters`: it is a function expression whose parameters stay on one line. */
function writeGroupedLastArgument(argument: number, expandsParameters: boolean, f: Formatter): void {
  const func = exprAsFn(argument);
  if (func >= 0 && funcIsArrow(func)) {
    writeExpression(
      argument,
      exprOptionsArrow(-1, GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_LAST_ARGUMENT, FUNCTION_CACHE_MODE_CACHE),
      f,
    );
  } else if (func >= 0 && expandsParameters) {
    writeExpression(argument, exprOptionsFunction(FUNCTION_CACHE_MODE_CACHE), f);
  } else {
    fmtExpr(argument, f);
  }
}

/**
 * `() => {}`, without comments: there is no signature to keep on one line, and only a body that is an expression depends on where the
 * arrow function is.
 */
function isWrittenTheSameWhenGrouped(arrow: number, f: Formatter): boolean {
  return (
    cxOf(f).isQuiet &&
    funcBodyKind(arrow) === BODY_BLOCK &&
    funcParamsLen(arrow) === 0 &&
    funcThisParam(arrow) < 0 &&
    funcTypeParamsLen(arrow) === 0 &&
    funcReturnType(arrow) < 0
  );
}

/** Takes the soft line breaks out of what is cached under `(start, end)`. Returns whether it is on one line then. */
function removeSoftLinesOfCachedElement(start: number, end: number, f: Formatter): boolean {
  const cx = cxOf(f);
  const cached = cx.getCachedElement(start, end);
  if (cached < 0) return true;
  const outer = f.startCapture();
  const inner = f.startCapture();
  f.writeInterned(cached);
  endSignatureWithoutLines(inner, f);
  const interned = f.endCapture(outer);
  if (interned < 0) return true;
  if (f.willBreak(interned)) return false;
  cx.cacheElement(start, end, interned);
  return true;
}

/**
 * Whether the signature of a function that is a grouped argument is kept on one line. Prettier's `printFunctionParameters` with
 * `shouldExpandParameters`.
 */
function hasSignatureWithoutSoftLines(func: number): boolean {
  // `decorator("name")((props: {..}) => {..})` stays hugged even if its signature breaks.
  const owner = funcOwner(func);
  if (nodeKind(owner) === N_EXPR && isDecoratedFunction(nodeId(owner))) return false;
  // Without parameters, the type parameters and the comments in `()` break as they do anywhere else. Only the return type of an arrow
  // function does not, which is what is cached for it.
  return funcIsArrow(func) || funcParamsLen(func) > 0 || funcThisParam(func) >= 0;
}

function writeGroupedArguments(argsStart: number, argsLen: number, parent: number, groupLayout: number, f: Formatter): void {
  const cx = cxOf(f);
  const lastIndex = argsLen > 0 ? argsLen - 1 : 0;
  const groupedFirst = groupLayout === GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_FIRST_ARGUMENT;
  const groupedLast = groupLayout === GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_LAST_ARGUMENT;
  // Prettier's `shouldExpandParameters` in `printFunction`. Not for `new A(function () {})`.
  const parentTag = anTag(parent);
  const isCall = parentTag === AN_CALL_EXPRESSION || (parentTag === AN_NEW_EXPRESSION && newIsACallLikeAnother(f));
  let nonGroupedBreaks = false;
  let groupedBreaks = false;
  let hasCached = false;

  // All arguments are formatted first, to see which of them break.
  const av$ = av;
  const ebase = av$.len;
  for (let index = 0; index < argsLen; index++) {
    const argument = listAt(argsStart, index);
    const isGroupedArgument = (groupedFirst && index === 0) || (groupedLast && index === lastIndex);

    let options = EO_NONE;
    const func = exprAsFn(argument);
    if (func >= 0 && isGroupedArgument) {
      if (!funcIsArrow(func) && !groupedFirst && isCall && (lastIndex !== 0 || hasOnlySimpleParameters(func, false))) {
        options = exprOptionsFunction(FUNCTION_CACHE_MODE_CACHE);
      } else if (funcIsArrow(func) && !isWrittenTheSameWhenGrouped(func, f)) {
        options = exprOptionsArrow(-1, -1, FUNCTION_CACHE_MODE_CACHE);
      }
    }
    if (options !== EO_NONE) hasCached = true;
    const slot = f.startCapture();
    if (options !== EO_NONE) writeExpression(argument, options, f);
    else fmtExpr(argument, f);
    if (index !== lastIndex) f.token(COMMA);
    const interned = f.endCapture(slot);

    const breaks = interned >= 0 && f.willBreak(interned);
    if (isGroupedArgument) groupedBreaks = groupedBreaks || breaks;
    else nonGroupedBreaks = nonGroupedBreaks || breaks;
    av$.push(interned);
  }

  // If an argument that is not grouped breaks, they are all on lines of their own.
  if (nonGroupedBreaks) {
    formatAllElementsBrokenOut(ebase, argsLen, parent, true, f);
    av$.len = ebase;
    return;
  }

  const mostExpandedSlot = f.startVariant();
  formatAllElementsBrokenOut(ebase, argsLen, parent, true, f);
  const mostExpanded = f.endVariant(mostExpandedSlot);

  // A function that is grouped is formatted again, without the soft line breaks in its signature. Its body is taken from the cache, so
  // that this is not quadratic for nested calls.
  if (hasCached) {
    const groupedIndex = groupedFirst ? 0 : lastIndex;
    const argument = listAt(argsStart, groupedIndex);

    // Of an arrow function that is the last argument, a body that is an arrow function is written like the argument itself.
    let next = exprAsFn(argument);
    while (next >= 0) {
      const func = next;
      next = -1;
      if (groupedLast && funcBodyKind(func) === BODY_EXPR) {
        const inner = exprArrowFunction(funcBodyExpr(func));
        next = inner;
      }
      if (!hasSignatureWithoutSoftLines(func)) {
        // Prettier's `printArrowFunctionSignature` gives up whatever the function is in.
        const returnType = funcReturnType(func);
        if (returnType >= 0 && f.options.flavor !== FLAVOR_OXFMT) {
          typeSpan(returnType);
          const cached = cx.getCachedElement(SP[0] | 0, SP[1] | 0);
          if (cached >= 0 && f.willBreak(cached)) {
            formatAllElementsBrokenOut(ebase, argsLen, parent, true, f);
            av$.len = ebase;
            return;
          }
        }
        continue;
      }
      // If the signature breaks even without soft line breaks, grouping is not a good fit.
      anSpan(mkAn(AN_FORMAL_PARAMETERS, func));
      const pStart = SP[0] | 0;
      const pEnd = SP[1] | 0;
      const hasParameters = funcParamsLen(func) > 0 || funcThisParam(func) >= 0;
      if (
        !removeSoftLinesOfCachedElement(pStart, pEnd, f) ||
        (!hasParameters &&
          flattensTypeParametersWithoutParameters(f) &&
          // What an arrow function keeps its `<T>()` under.
          !removeSoftLinesOfCachedElement(pStart, pStart + 1, f))
      ) {
        formatAllElementsBrokenOut(ebase, argsLen, parent, true, f);
        av$.len = ebase;
        return;
      }
    }

    const slot = f.startCapture();
    if (groupedFirst) {
      writeGroupedFirstArgument(argument, lastIndex, f);
    } else {
      const fn = exprAsFn(argument);
      const expandsParameters = fn >= 0 && isCall && (lastIndex !== 0 || hasOnlySimpleParameters(fn, false));
      writeGroupedLastArgument(argument, expandsParameters, f);
    }
    const element = f.endCapture(slot);
    // An arrow chain, for one, is written differently when it is grouped.
    groupedBreaks = element >= 0 && f.willBreak(element);
    av$.data[(ebase + groupedIndex) | 0] = element | 0;
  }

  // The grouped argument is expanded, the others are on the line.
  const middleSlot = f.startVariant();
  f.token(LPAREN);
  for (let index = 0; index < argsLen; index++) {
    if (index > 0) f.softLineBreakOrSpace();
    const element = av$.data[(ebase + index) | 0] | 0;
    if ((groupedFirst && index === 0) || (groupedLast && index === lastIndex)) {
      f.startGroupExpand(true);
      f.writeInterned(element);
      f.endGroup();
    } else {
      f.writeInterned(element);
    }
  }
  f.token(RPAREN);
  const middleVariant = f.endVariant(middleSlot);

  // If the grouped argument breaks, it is known not to fit on one line.
  if (groupedBreaks) {
    f.expandParent();
    f.bestFitting2(middleVariant, mostExpanded);
  } else {
    const flatSlot = f.startVariant();
    f.token(LPAREN);
    for (let index = 0; index < argsLen; index++) {
      if (index > 0) f.softLineBreakOrSpace();
      f.writeInterned(av$.data[(ebase + index) | 0] | 0);
    }
    f.token(RPAREN);
    const mostFlat = f.endVariant(flatSlot);
    f.bestFitting3(mostFlat, middleVariant, mostExpanded);
  }
  av$.len = ebase;
}

/** `useMemo(() => {}, [a, b])`, `useImperativeHandle(ref, () => {}, [a, b])` */
function isReactHookWithDepsArray(argsStart: number, argsLen: number, parent: number, f: Formatter): boolean {
  if (argsLen > 3 || argsLen < 2) return false;
  let at = 0;
  if (argsLen === 3) {
    if (exprTag(listAt(argsStart, 0)) !== EXPR_IDENT) return false;
    at = 1;
  }
  const callback = listAt(argsStart, at);
  const deps = listAt(argsStart, at + 1);
  const func = exprArrowFunction(callback);
  if (func < 0) return false;
  if (exprTag(deps) !== EXPR_ARRAY || funcParamsLen(func) !== 0 || funcBodyKind(func) === BODY_EXPR) return false;
  // Not if there is a comment that is not in the callback or the array. For Prettier one in an empty array is a comment of the array.
  const isEmpty = f.options.flavor !== FLAVOR_OXFMT && exprArrayElemsLen(deps) === 0;
  const cm = cxOf(f).comments;
  const parentEnd = anEnd(parent);
  exprSpan(callback);
  const cbStart = SP[0] | 0;
  const cbEnd = SP[1] | 0;
  exprSpan(deps);
  const depsStart = SP[0] | 0;
  const depsEnd = SP[1] | 0;
  cm.commentsBefore(parentEnd);
  const to = cm.to;
  for (let i = cm.from; i < to; i++) {
    const cs = cm.spanStart[i] | 0;
    const ce = cm.spanEnd[i] | 0;
    const inCallback = cbStart <= cs && ce <= cbEnd;
    if (!inCallback) {
      const inDeps = depsStart <= cs && ce <= depsEnd;
      if (isEmpty || !inDeps) return false;
    }
  }
  return true;
}

/**
 * Prettier's `isDecoratedFunction`:
 *
 * ```js
 * const decoratedFn = decorator(param1, param2)((
 *   ...
 * ) => {
 *   ...
 * });
 * ```
 */
function isDecoratedFunction(argument: number): boolean {
  const arrow = exprArrowFunction(argument);
  if (arrow < 0) return false;
  if (funcBodyKind(arrow) === BODY_EXPR) return false;
  const parent = exprAstParent(argument);
  if (anTag(parent) !== AN_CALL_EXPRESSION) return false;
  const parentExpr = anId(parent);
  const parentCall = exprAsCallLike(parentExpr);
  if (parentCall < 0 || callArgsLen(parentCall) !== 1) return false;
  const callee = callCallee(parentCall);
  if (anTag(exprAsAstNodes(callee)) !== AN_CALL_EXPRESSION) return false;
  // The decorator is `a` or `a.b`.
  const decorator = exprCallee(callee);
  if (decorator < 0) return false;
  const dt = anTag(exprAsAstNodes(decorator));
  let isValidDecorator = false;
  if (dt === AN_IDENTIFIER_REFERENCE) isValidDecorator = true;
  else if (dt === AN_STATIC_MEMBER_EXPRESSION) {
    const object = exprDotObj(decorator);
    isValidDecorator = object >= 0 && exprTag(object) === EXPR_IDENT;
  }
  if (!isValidDecorator) return false;

  const grandparent = anParent(parent);
  switch (anTag(grandparent)) {
    case AN_VARIABLE_DECLARATOR: {
      const declaration = anParent(grandparent);
      if (anTag(declaration) === AN_VARIABLE_DECLARATION) {
        const stmt = anId(declaration);
        return varDeclKind(anId(grandparent)) === VAR_CONST && stmtTag(stmt) === STMT_VAR && stmtVarDeclsLen(stmt) === 1;
      }
      return true;
    }
    case AN_EXPORT_DEFAULT_DECLARATION:
    case AN_TS_EXPORT_ASSIGNMENT:
      return true;
    // `module.exports = ..`
    case AN_ASSIGNMENT_EXPRESSION: {
      const left = exprAssignTarget(anId(grandparent));
      if (left < 0 || exprTag(left) !== EXPR_DOT) return false;
      const obj = exprDotObj(left);
      return exprTag(obj) === EXPR_IDENT && nameIs(exprIdentName(obj), "module") && nameIs(exprDotName(left), "exports");
    }
    default:
      return false;
  }
}
