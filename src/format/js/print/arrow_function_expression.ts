// Port of vendor/bun/src/format/js/print/arrow_function_expression.rs.
// FormatJsArrowFunctionExpressionOptions { assignment_layout, call_argument_layout, cache_mode } are three ints (-1: none).
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { ARROW, COMMA, LPAREN, RPAREN } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT, FTC_ALL } from "../../options.ts";
import {
  BIN_COMMA,
  BODY_BLOCK,
  BODY_EXPR,
  EXPR_ARRAY,
  EXPR_BINARY,
  EXPR_COND,
  EXPR_FN,
  EXPR_JSX,
  EXPR_OBJECT,
  EXPR_TAGGED_TEMPLATE,
  EXPR_TEMPLATE,
  SP,
  callTemplate,
  exprAsCallLike,
  exprBinaryOpOf,
  exprOuterEnd,
  exprOuterStart,
  exprEnd,
  exprSpan,
  exprStart,
  exprTag,
  exprTemplateQuasiCount,
  exprTemplateQuasiSpan,
  funcArrowSpan,
  funcBodyExpr,
  funcBodyKind,
  funcIsArrow,
  funcIsAsync,
  funcParamsLen,
  funcReturnType,
  funcSpan,
  funcThisParam,
  funcTypeParamsLen,
  funcTypeParamsStart,
  typeSpan,
  hir,
  nodeOfFunc,
} from "../../../lint/ast/index.ts";
import {
  AN_BINARY_EXPRESSION,
  AN_CALL_EXPRESSION,
  AN_FORMAL_PARAMETERS,
  AN_FUNCTION_BODY,
  AN_IMPORT_EXPRESSION,
  AN_JSX_EXPRESSION_CONTAINER,
  AN_LOGICAL_EXPRESSION,
  AN_NEW_EXPRESSION,
  anIsCallLikeCallee,
  anParent,
  anSpan,
  anEnd,
  anTag,
  exprAstParent,
  funcAsAstNodes,
  mkAn,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { exprArrowFunction } from "../fields.ts";
import { WK_TYPE_ANNOTATION, fmtExpr, writeExpression } from "../format.ts";
import { ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR, ASSIGNMENT_LIKE_LAYOUT_CHAIN_TAIL_ARROW_FUNCTION } from "../utils/assignment_like.ts";
import { byteTable } from "../source_text.ts";
import {
  commentsStayBetweenHeadAndBody,
  formatLeadingComments,
  formatLeadingCommentsRange,
  formatTrailingCommentsRange,
} from "../trivia.ts";
import { leftmost } from "../utils/expression.ts";
import { fmtNodeWithoutTrailingComments } from "../utils/format_node_without_trailing_comments.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { isCastTarget } from "../utils/typecast.ts";
import { hasEmbedLabelOfOtherThanHtml, htmlInJsLabel, HTML_LABEL_EMBED_WITHOUT_HUG, HTML_LABEL_NONE } from "./call_like_expression/arguments.ts";
import { CACHE_HIT, cacheBegin, cacheEnd, fmtFunctionBody } from "./function.ts";
import {
  CB,
  commentIsBetween,
  commentsBetween,
  hasCommentsBetween,
  fmtFormalParameters,
  hasOnlySimpleParameters,
  writeEmptyText,
} from "./parameters.ts";
import { spanThatCommentsLead } from "./sequence_expression.ts";
import { typeParameters } from "./type_parameters.ts";
import { GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_FIRST_ARGUMENT, GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_LAST_ARGUMENT, FUNCTION_CACHE_MODE_NO_CACHE, FUNCTION_CACHE_MODE_CACHE } from "./arrow_function_expression.consts.ts";
export { GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_FIRST_ARGUMENT, GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_LAST_ARGUMENT, FUNCTION_CACHE_MODE_NO_CACHE, FUNCTION_CACHE_MODE_CACHE } from "./arrow_function_expression.consts.ts";


const T_ASYNC = token("async ");

const BT_WS_OR_OPEN_PAREN: Uint8Array = byteTable("(", true);

/** The body, if it is an expression: an ExprId, else -1. */
function getExpression(arrow: number): number {
  return funcBodyKind(arrow) === BODY_EXPR ? funcBodyExpr(arrow) : -1;
}

function isSequence(e: number): boolean {
  return exprTag(e) === EXPR_BINARY && exprBinaryOpOf(e) === BIN_COMMA;
}

/** The arrow function that is the body of `arrow`, or -1. */
function nextInChain(arrow: number): number {
  const body = getExpression(arrow);
  return body < 0 ? -1 : exprArrowFunction(body);
}

/**
 * `f(a, b =>⏎ // comment⏎ c ? d : e)`: for oxfmt the line of the `=>` is one column longer than it looks, as if a space were behind it.
 */
function countsSpaceBeforeCommentedConditional(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * `a => b => (c ? d : e)`: for oxfmt the conditional expression is on the next line, without the parentheses, if the chain does not fit
 * on its line. For Prettier it is a group of its own behind a blank, which counts: a line that the `=>` fills to the last column is too
 * long.
 */
function conditionalBodyBreaksWithTheChain(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * ```ts
 * return (                   return (
 *   a: A,                        a: A,
 *   b: B,                        b: B,
 * ) =>                         ) =>
 *   (c) => {};                 (c) => {};
 * ```
 *
 * oxfmt on the left, Prettier on the right: wherever the chain is, not only as an argument or an operand.
 */
function firstSignatureStartsWhereChainStarts(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `() =>⏎ /* comment *&#47; (a, b)` for oxfmt, `() => /* comment *&#47; (a, b)` for Prettier. */
function sequenceBehindCommentsIsOnItsOwnLine(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `const a = (b) => (⏎b && c⏎// comment⏎);`: for oxfmt the comment is behind the statement. For Prettier it trails `b && c`. */
function onlyTheBodyOfAnArgumentKeepsCommentsBeforeItsParenthesis(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** The parameters and the return type of a function that is hugged as an argument: Prettier's `removeLines`. oxfmt writes them on one line. */
export function endSignatureWithoutLines(slot: number, f: Formatter): void {
  if (f.options.flavor === FLAVOR_OXFMT) f.endWithoutSoftLines(slot);
  else f.endWithLinesRemoved(slot);
}

/** Prettier's `printArrowFunction`. `e`: the expression that `arrow` is. */
export function writeArrowFunctionExpression(
  e: number,
  arrow: number,
  assignmentLayout: number,
  callArgumentLayout: number,
  cacheMode: number,
  f: Formatter,
): void {
  writeArrow(e, arrow, assignmentLayout, callArgumentLayout, cacheMode, false, f);
}

/** `isNested`: `arrow` is the body of an arrow function that is the expanded last argument of a call. */
function writeArrow(
  e: number,
  arrow: number,
  al: number,
  cal: number,
  cacheMode: number,
  isNested: boolean,
  f: Formatter,
): void {
  const cx = cxOf(f);
  const expandLastArg = cal === GROUPED_CALL_ARGUMENT_LAYOUT_GROUPED_LAST_ARGUMENT;

  // Arrow functions that are each the body of the one before break after each `=>`:
  //
  //     const x =
  //       (a): string =>
  //       (b) =>
  //       (c) =>
  //         d;
  const shouldPrintAsChain = !expandLastArg && nextInChain(arrow) >= 0;
  let tail = arrow;
  let shouldBreakChain = false;
  if (shouldPrintAsChain) {
    for (;;) {
      shouldBreakChain = shouldBreakChain || hasComplexSignature(tail);
      const next = nextInChain(tail);
      if (next < 0) break;
      tail = next;
    }
  }

  const hasOwnLineComment = hasLeadingOwnLineComment(tail, cacheMode, f);
  // For Prettier the body is a `ParenthesizedExpression` then, whatever is in it.
  const tailBody = getExpression(tail);
  const isBodyTypeCast = tailBody >= 0 && isCastTarget(tailBody, f);
  const addParensIfNotBreak = !isBodyTypeCast && shouldAddParensIfNotBreak(tail);
  const isBodyOnSameLine =
    (!hasOwnLineComment &&
      !isBodyTypeCast &&
      (tailBody < 0 || isSequence(tailBody) || mayBreakAfterShortPrefix(tailBody, f) || (!shouldBreakChain && addParensIfNotBreak))) ||
    (addParensIfNotBreak && expandLastArg && countsSpaceBeforeCommentedConditional(f));

  const breaksWithChain = shouldPrintAsChain && isBodyOnSameLine && addParensIfNotBreak && conditionalBodyBreaksWithTheChain(f);

  if (!shouldPrintAsChain) {
    writeSignature(arrow, cacheMode, isNested, f);
    f.space();
    f.token(ARROW);
    const groupBody = !(isBodyOnSameLine && !addParensIfNotBreak);
    if (groupBody) f.startGroup();
    writeFormatBody(e, arrow, tail, expandLastArg, isBodyOnSameLine, addParensIfNotBreak, breaksWithChain, hasOwnLineComment, al, cal, cacheMode, f);
    if (groupBody) f.endGroup();
    return;
  }

  // `(() => () => a)()`: as a callee, the chain breaks onto lines of its own, to show that it is the result that is called.
  const parent = exprAstParent(e);
  const isCallee = anIsCallLikeCallee(parent, e);
  // As a callee or on the right of an assignment, all signatures are indented by one level.
  const shouldIndentSignatures = isCallee || al >= 0;
  // Not after a comment, which has a line break of its own.
  const shouldPrintSoftLine =
    shouldIndentSignatures && al !== ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR && !hasLeadingComment(e, isCallee, f);
  const shouldBreakSignatures =
    al === ASSIGNMENT_LIKE_LAYOUT_CHAIN_TAIL_ARROW_FUNCTION || (isCallee && (!isBodyOnSameLine || breaksWithChain));
  // As an argument or an operand, the first starts where the chain starts.
  const pt = anTag(parent);
  const isFirstIndented =
    !firstSignatureStartsWhereChainStarts(f) &&
    !(
      pt === AN_CALL_EXPRESSION ||
      pt === AN_NEW_EXPRESSION ||
      pt === AN_IMPORT_EXPRESSION ||
      pt === AN_BINARY_EXPRESSION ||
      pt === AN_LOGICAL_EXPRESSION
    );

  const groupId = f.groupId();
  f.startGroup();
  f.startGroupWith(groupId, shouldBreakSignatures);
  // format_signatures
  if (shouldIndentSignatures) {
    f.startIndent();
    // If the assignment has broken after the operator, Prettier breaks the line once more. The empty text is what makes this line break
    // count.
    if (shouldPrintSoftLine) {
      writeEmptyText(f);
      f.softLineBreak();
    }
    f.startGroupExpand(shouldBreakChain);
    writeSignature(arrow, cacheMode, false, f);
    writeRest(arrow, tail, cacheMode, f);
    f.endGroup();
    f.endIndent();
  } else if (isFirstIndented) {
    f.startGroupExpand(shouldBreakChain);
    f.startIndent();
    writeSignature(arrow, cacheMode, false, f);
    writeRest(arrow, tail, cacheMode, f);
    f.endIndent();
    f.endGroup();
  } else {
    f.startGroupExpand(shouldBreakChain);
    writeSignature(arrow, cacheMode, false, f);
    f.startIndent();
    writeRest(arrow, tail, cacheMode, f);
    f.endIndent();
    f.endGroup();
  }
  f.endGroup();
  f.space();
  f.token(ARROW);
  f.startIndentIfGroupBreaks(groupId);
  writeFormatBody(e, arrow, tail, expandLastArg, isBodyOnSameLine, addParensIfNotBreak, breaksWithChain, hasOwnLineComment, al, cal, cacheMode, f);
  f.endIndentIfGroupBreaks(groupId);
  if (isCallee) {
    f.startIfGroupBreaksId(groupId);
    f.softLineBreak();
    f.endConditional();
  }
  f.endGroup();
  void cx;
}

/** Prettier's `printArrowFunctionSignatures`, but for the first. */
function writeRest(arrow: number, tail: number, cacheMode: number, f: Formatter): void {
  let current = arrow;
  while (current !== tail) {
    const next = nextInChain(current);
    if (next < 0) break;
    f.space();
    f.token(ARROW);
    f.softLineBreakOrSpace();
    writeCommentsBeforeArrow(next, cacheMode, f);
    writeSignature(next, cacheMode, false, f);
    current = next;
  }
}

/** Prettier's `printArrowFunctionBody`. */
function writeFormatBody(
  e: number,
  arrow: number,
  tail: number,
  expandLastArg: boolean,
  isBodyOnSameLine: boolean,
  addParensIfNotBreak: boolean,
  breaksWithChain: boolean,
  hasOwnLineComment: boolean,
  al: number,
  cal: number,
  cacheMode: number,
  f: Formatter,
): void {
  if (isBodyOnSameLine && !addParensIfNotBreak) {
    f.space();
    writeArrowBody(tail, al, cal, cacheMode, hasOwnLineComment, f);
    return;
  }
  const cx = cxOf(f);
  // The `)` of the call, or the `}` in JSX, is on a line of its own if the body is.
  let shouldAddSoftLine = expandLastArg && !hasDanglingComments(arrow, cacheMode, f);
  if (!shouldAddSoftLine) {
    const parent = exprAstParent(e);
    if (anTag(parent) === AN_JSX_EXPRESSION_CONTAINER) {
      const end = exprEnd(e);
      shouldAddSoftLine = !cx.comments.hasCommentInRange(end, anEnd(parent));
    }
  }
  if (breaksWithChain) {
    f.startSoftLineIndentOrSpace();
    f.startIfGroupFits();
    f.token(LPAREN);
    f.endConditional();
    writeArrowBody(tail, al, cal, cacheMode, hasOwnLineComment, f);
    f.startIfGroupFits();
    f.token(RPAREN);
    f.endConditional();
    f.endSoftLineIndentOrSpace();
    if (expandLastArg) f.writeTrailingCommas(FTC_ALL, COMMA);
    if (shouldAddSoftLine) f.softLineBreak();
  } else if (isBodyOnSameLine) {
    f.space();
    // A body that is a conditional expression: `a => (b ? c : d)`, so that it is not mistaken for `a <= b ? c : d`. If it breaks, it
    // goes on the next line without the parentheses.
    f.startGroup();
    f.startIfGroupFits();
    f.token(LPAREN);
    f.endConditional();
    f.startIndent();
    f.softLineBreak();
    writeArrowBody(tail, al, cal, cacheMode, hasOwnLineComment, f);
    f.endIndent();
    f.startIfGroupFits();
    f.token(RPAREN);
    f.endConditional();
    if (expandLastArg) f.writeTrailingCommas(FTC_ALL, COMMA);
    if (shouldAddSoftLine) f.softLineBreak();
    f.endGroup();
  } else {
    // See `commentsStayBetweenHeadAndBody`.
    if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f) && funcBodyKind(tail) === BODY_BLOCK && funcArrowSpan(tail)) {
      const tokenEnd = SP.s1 | 0;
      const cm = cx.comments;
      cm.endOfLineCommentsAfter(tokenEnd);
      formatTrailingCommentsRange(cm.from, cm.to, f);
    }
    f.startSoftLineIndentOrSpace();
    writeArrowBody(tail, al, cal, cacheMode, hasOwnLineComment, f);
    f.endSoftLineIndentOrSpace();
    if (expandLastArg) f.writeTrailingCommas(FTC_ALL, COMMA);
    if (shouldAddSoftLine) f.softLineBreak();
  }
}

/** Whether the signature is too complex to share a line with others: it has type parameters, a destructuring, rest or default parameter, or parameters and a return type. */
function hasComplexSignature(arrow: number): boolean {
  if (funcTypeParamsLen(arrow) > 0 || !hasOnlySimpleParameters(arrow, true)) return true;
  return funcReturnType(arrow) >= 0 && (funcParamsLen(arrow) > 0 || funcThisParam(arrow) >= 0);
}

/** Whether a comment, printed or not, is the last thing before `e`. Before the parentheses of a callee, it belongs to the call. */
function hasLeadingComment(e: number, isCallee: boolean, f: Formatter): boolean {
  const cx = cxOf(f);
  const cm = cx.comments;
  const start = exprStart(e);
  let last: number;
  const n = cm.commentsBefore(start);
  if (n > 0) last = (cm.to - 1) | 0;
  else last = cm.lastPrinted();
  if (last < 0) return false;
  const ce = cm.ce[last] | 0;
  if (ce > start) return false;
  if (isCallee && (cm.cs[last] | 0) < exprOuterStart(e)) return false;
  return cx.src.allBytes(ce, start, BT_WS_OR_OPEN_PAREN);
}

/** Whether there are comments in the `()` of `arrow`, or before its `=>`. */
function hasDanglingComments(arrow: number, cacheMode: number, f: Formatter): boolean {
  if (cxOf(f).isQuiet && cacheMode === FUNCTION_CACHE_MODE_NO_CACHE) return false;
  if (!funcArrowSpan(arrow)) return false;
  const SP$ = SP;
  const tokenStart = SP$.s0 | 0;
  anSpan(mkAn(AN_FORMAL_PARAMETERS, arrow));
  const paramsStart = SP$.s0 | 0;
  const paramsEnd = SP$.s1 | 0;
  let signatureEnd = paramsEnd;
  const rt = funcReturnType(arrow);
  if (rt >= 0) {
    typeSpan(rt);
    signatureEnd = SP$.s1 | 0;
  }
  if (hasCommentsBetween(signatureEnd, tokenStart, f)) return true;
  return funcParamsLen(arrow) === 0 && funcThisParam(arrow) < 0 && hasCommentsBetween(paramsStart, paramsEnd, f);
}

/** Prettier's `hasLeadingOwnLineComment` for the body of `arrow`: then the body goes on the next line, after the comment. */
function hasLeadingOwnLineComment(arrow: number, cacheMode: number, f: Formatter): boolean {
  const cx = cxOf(f);
  if (cx.isQuiet && cacheMode === FUNCTION_CACHE_MODE_NO_CACHE) return false;
  if (!funcArrowSpan(arrow)) return false;
  const SP$ = SP;
  const tokenStart = SP$.s0 | 0;
  const tokenEnd = SP$.s1 | 0;
  const hasPrecedingNode = funcParamsLen(arrow) > 0 || funcThisParam(arrow) >= 0 || funcTypeParamsLen(arrow) > 0 || funcReturnType(arrow) >= 0;
  // If nothing else is between them and the body, the comments before the `(` lead it as well.
  let start = tokenEnd;
  if (!hasPrecedingNode) {
    funcSpan(arrow);
    start = SP$.s0 | 0;
  }
  anSpan(mkAn(AN_FORMAL_PARAMETERS, arrow));
  const paramsStart = SP$.s0 | 0;
  anSpan(mkAn(AN_FUNCTION_BODY, arrow));
  const bodyStart = SP$.s0 | 0;
  commentsBetween(start, bodyStart, f);
  const from = CB[0] | 0;
  const to = CB[1] | 0;
  const cm = cx.comments;
  const body = getExpression(arrow);
  const bodyIsJsx = body >= 0 && exprTag(body) === EXPR_JSX;
  for (let i = from; i < to; i++) {
    if (!commentIsBetween(i, start, bodyStart, f)) continue;
    // comments.filter(|comment| has_preceding_node || !is_before_arrow_token(comment))
    if (!hasPrecedingNode && (cm.cs[i] | 0) >= paramsStart && (cm.ce[i] | 0) <= tokenStart) continue;
    if (body >= 0) {
      if (bodyIsJsx) {
        if (cm.isSuppressionComment(i)) return true;
      } else if (cm.followedByNewline(i)) return true;
    } else if (cm.followedByNewline(i) && (cm.precededByNewline(i) || !hasPrecedingNode)) {
      // A comment at the end of the line of the `=>` is moved into the block, if there is anything before the `=>` that it could belong to.
      return true;
    }
  }
  return false;
}

/**
 * Prettier's `mayBreakAfterShortPrefix`: an array, an object, an arrow function, JSX and a template have their own way to break, so they
 * start right after the `=>`.
 */
function mayBreakAfterShortPrefix(body: number, f: Formatter): boolean {
  switch (exprTag(body)) {
    case EXPR_ARRAY:
    case EXPR_OBJECT:
    case EXPR_JSX:
      return true;
    case EXPR_FN:
      return exprArrowFunction(body) >= 0;
    case EXPR_TEMPLATE:
    case EXPR_TAGGED_TEMPLATE: {
      const html = htmlInJsLabel(body, f);
      return (
        html !== HTML_LABEL_EMBED_WITHOUT_HUG &&
        (html !== HTML_LABEL_NONE || isMultilineAndStartsOnSameLine(body, f) || hasEmbedLabelOfOtherThanHtml(body, f))
      );
    }
    default:
      return false;
  }
}

/** Whether `expression` is a template that has a line break in its text and starts on the line of the token before it. */
export function isMultilineTemplateStartingOnSameLine(expression: number, f: Formatter): boolean {
  const t = exprTag(expression);
  return (t === EXPR_TEMPLATE || t === EXPR_TAGGED_TEMPLATE) && isMultilineAndStartsOnSameLine(expression, f);
}

/** `expression`: a template. */
function isMultilineAndStartsOnSameLine(expression: number, f: Formatter): boolean {
  let template = expression;
  if (exprTag(expression) === EXPR_TAGGED_TEMPLATE) {
    const call = exprAsCallLike(expression);
    template = call < 0 ? -1 : callTemplate(call);
    if (template < 0 || exprTag(template) !== EXPR_TEMPLATE) return false;
  } else if (exprTag(expression) !== EXPR_TEMPLATE) {
    return false;
  }
  const src = cxOf(f).src;
  const n = exprTemplateQuasiCount(template);
  let hasNewline = false;
  const SP$ = SP;
  for (let i = 0; i < n; i++) {
    exprTemplateQuasiSpan(template, i);
    if (src.containsNewline(SP$.s0 | 0, SP$.s1 | 0)) {
      hasNewline = true;
      break;
    }
  }
  return hasNewline && !src.hasLineTerminatorBefore(exprStart(expression));
}

/**
 * Prettier's `shouldAddParensIfNotBreak`: `a => (b ? c : d)`, so that it is not mistaken for `a <= b ? c : d`. Not if the condition
 * starts with something that is in parentheses anyway.
 */
function shouldAddParensIfNotBreak(arrow: number): boolean {
  const expression = getExpression(arrow);
  if (expression < 0 || exprTag(expression) !== EXPR_COND) return false;
  return exprTag(leftmost(expression)) !== EXPR_OBJECT;
}

/** The comments before `arrow`, which is the body of another arrow function. */
function writeCommentsBeforeArrow(arrow: number, cacheMode: number, f: Formatter): void {
  if (cxOf(f).isQuiet && cacheMode === FUNCTION_CACHE_MODE_NO_CACHE) return;
  anSpan(funcAsAstNodes(arrow));
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  const slot = cacheBegin(start, start, cacheMode, f);
  if (slot !== CACHE_HIT) formatLeadingComments(start, end, f);
  cacheEnd(slot, start, start, f);
}

/** Prettier's `printArrowFunctionSignature`: `async`, the type parameters, the parameters, the return type and the comments before the `=>`. */
function writeSignature(arrow: number, cacheMode: number, shouldRemoveSoftLines: boolean, f: Formatter): void {
  const cx = cxOf(f);
  anSpan(mkAn(AN_FORMAL_PARAMETERS, arrow));
  const SP$ = SP;
  const paramsStart = SP$.s0 | 0;
  const paramsEnd = SP$.s1 | 0;
  const tpStart = funcTypeParamsStart(arrow);
  const tpLen = funcTypeParamsLen(arrow);
  const returnType = funcReturnType(arrow);
  const hasParameters = funcParamsLen(arrow) > 0 || funcThisParam(arrow) >= 0;

  f.startGroup();
  if (funcIsAsync(arrow)) f.token(T_ASYNC);
  // What loses its soft line breaks in an expanded argument is cached under the span of the parameters. Without parameters, that is only
  // the return type.
  if (!hasParameters) {
    const slot = cacheBegin(paramsStart, paramsStart + 1, cacheMode, f);
    if (slot !== CACHE_HIT) {
      typeParameters(tpStart, tpLen, nodeOfFunc(arrow), 0, false, f);
      fmtFormalParameters(arrow, f);
    }
    cacheEnd(slot, paramsStart, paramsStart + 1, f);
  }
  let removeSlot = -1;
  if (shouldRemoveSoftLines) removeSlot = f.startCapture();
  const flatSlot = cacheBegin(paramsStart, paramsEnd, cacheMode, f);
  if (flatSlot !== CACHE_HIT) {
    if (hasParameters && returnType >= 0) {
      // The arguments ask whether the return type breaks.
      typeSpan(returnType);
      const rtStart = SP$.s0 | 0;
      const rtEnd = SP$.s1 | 0;
      typeParameters(tpStart, tpLen, nodeOfFunc(arrow), 0, false, f);
      fmtFormalParameters(arrow, f);
      const rs = cacheBegin(rtStart, rtEnd, cacheMode, f);
      if (rs !== CACHE_HIT) fmtNodeWithoutTrailingComments(WK_TYPE_ANNOTATION, returnType, f);
      cacheEnd(rs, rtStart, rtEnd, f);
    } else if (hasParameters) {
      typeParameters(tpStart, tpLen, nodeOfFunc(arrow), 0, false, f);
      fmtFormalParameters(arrow, f);
    } else if (returnType >= 0) {
      fmtNodeWithoutTrailingComments(WK_TYPE_ANNOTATION, returnType, f);
    } else if (cacheMode === FUNCTION_CACHE_MODE_CACHE) {
      // The arguments expect to find something in the cache.
      f.nop();
    }
  }
  cacheEnd(flatSlot, paramsStart, paramsEnd, f);
  if (shouldRemoveSoftLines) endSignatureWithoutLines(removeSlot, f);
  f.endGroup();

  if (cx.isQuiet && cacheMode === FUNCTION_CACHE_MODE_NO_CACHE) return;
  if (!funcArrowSpan(arrow)) return;
  const tokenStart = SP$.s0 | 0;
  // If the first is from before the `(`, it leads the body, and takes the others along.
  const cm = cx.comments;
  const n = cm.commentsBefore(tokenStart);
  let from = cm.from;
  let to = cm.to;
  if (n > 0 && (cm.cs[from] | 0) < paramsEnd) to = from;
  anSpan(funcAsAstNodes(arrow));
  const ks = SP$.s0 | 0;
  const ke = SP$.s1 | 0;
  const slot = cacheBegin(ks, ke, cacheMode, f);
  if (slot !== CACHE_HIT) formatTrailingCommentsRange(from, to, f);
  cacheEnd(slot, ks, ke, f);
  void from;
}

/** What is after the `=>`, with the comments before it. */
function writeArrowBody(arrow: number, al: number, cal: number, cacheMode: number, hasOwnLineComment: boolean, f: Formatter): void {
  // In the expanded last argument of a call. Anywhere else it is part of a chain.
  const body = getExpression(arrow);
  if (body >= 0) {
    const next = exprArrowFunction(body);
    if (next >= 0) {
      // It is not written by way of `Expr`.
      if (!f.stack.enter()) return;
      writeCommentsBeforeArrow(next, cacheMode, f);
      writeArrow(body, next, al, cal, cacheMode, true, f);
      f.stack.leave();
      return;
    }
  }
  anSpan(mkAn(AN_FUNCTION_BODY, arrow));
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  const slot = cacheBegin(start, end, cacheMode, f);
  if (slot !== CACHE_HIT) {
    if (body >= 0) {
      writeExpressionBody(body, hasOwnLineComment, f);
    } else {
      // Otherwise the block takes the block comments, and the others are moved into it.
      if (hasOwnLineComment) formatLeadingComments(start, end, f);
      fmtFunctionBody(arrow, f);
    }
  }
  cacheEnd(slot, start, end, f);
}

/** `isOnItsOwnLine`: a comment has moved it off the line of the `=>` already. */
function writeExpressionBody(body: number, isOnItsOwnLine: boolean, f: Formatter): void {
  const cx = cxOf(f);
  const isSeq = isSequence(body) && !isCastTarget(body, f);
  if (cx.isQuiet) {
    if (isSeq) f.token(LPAREN);
    fmtExpr(body, f);
    if (isSeq) f.token(RPAREN);
    return;
  }
  const cm = cx.comments;
  const SP$ = SP;
  if (isSeq) {
    // The comments are outside of the parentheses.
    exprSpan(body);
    const start = SP$.s0 | 0;
    const end = SP$.s1 | 0;
    const isSuppressed = cm.isSuppressed(start);
    spanThatCommentsLead(body, f);
    const leadingStart = SP$.s0 | 0;
    const leadingEnd = SP$.s1 | 0;
    const own = !isOnItsOwnLine && sequenceBehindCommentsIsOnItsOwnLine(f) && cm.hasCommentBefore(leadingStart);
    if (own) {
      f.startGroup();
      f.startIndent();
      f.hardLineBreak();
    }
    const n = cm.commentsBefore(start);
    if (n > 0 && sequenceBehindCommentsIsOnItsOwnLine(f) && cm.isCastParenthesis(start)) {
      // But for one that is about the parentheses behind it.
      const from = cm.from;
      const castAt = cm.to - 1;
      formatLeadingCommentsRange(from, castAt, f);
      f.token(LPAREN);
      formatLeadingCommentsRange(castAt, castAt + 1, f);
    } else {
      formatLeadingComments(leadingStart, leadingEnd, f);
      f.token(LPAREN);
    }
    if (isSuppressed) writeSuppressedNode(start, end, f);
    else writeExpression(body, 0, f);
    f.token(RPAREN);
    if (own) {
      f.endIndent();
      f.endGroup();
    }
    return;
  }
  fmtExpr(body, f);
  const spanEnd = exprEnd(body);
  cm.commentsIn(spanEnd, exprOuterEnd(body));
  const total = (cm.to - cm.from) | 0;
  const from = cm.from;
  let count = 0;
  const tag = exprTag(body);
  if (tag === EXPR_COND) {
    // `(a ? b : c /* comment */)`: in the parentheses that are written if it does not break.
    const to = cm.to;
    for (let i = from; i < to; i++) {
      if (cm.precededByNewline(i)) break;
      count = (count + 1) | 0;
    }
  } else if (tag === EXPR_BINARY && total > 0) {
    // What is before the `)` of parentheses that go trails the body, with its indentation.
    if (!onlyTheBodyOfAnArgumentKeepsCommentsBeforeItsParenthesis(f)) count = total;
    else {
      // The statement that the body is, the body, the function, what that is in.
      const p = anParent(anParent(anParent(exprAstParent(body))));
      const pt = anTag(p);
      if (pt === AN_CALL_EXPRESSION || pt === AN_NEW_EXPRESSION) count = total;
    }
  }
  formatTrailingCommentsRange(from, from + count, f);
}

void hir;
