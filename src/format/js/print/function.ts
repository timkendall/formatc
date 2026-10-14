// Port of vendor/bun/src/format/js/print/function.rs.
// FormatFunctionOptions { cache_mode } is the int `cacheMode` (FUNCTION_CACHE_MODE_*).
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { EMPTY_BRACES, LBRACE, LPAREN, RBRACE, RPAREN, STAR } from "../../ir/tokens.ts";
import { FLAG_AMBIENT } from "../../../sema/hir.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  BODY_BLOCK,
  N_STMT,
  SP,
  TYPE_MAPPED,
  TYPE_OBJECT,
  exprAsCallLike,
  callArgsLen,
  callCallee,
  exprAsFn,
  exprCallee,
  exprOuterEnd,
  exprSpan,
  fileIsFlow,
  funcBodyKind,
  funcBodyStmtsLen,
  funcBodyStmtsStart,
  funcIsArrow,
  funcIsAsync,
  funcIsGenerator,
  funcName,
  funcNamePos,
  funcOwner,
  funcParamsLen,
  funcParamsStart,
  funcReturnType,
  funcThisParam,
  funcTypeParamsLen,
  funcTypeParamsStart,
  funcHasBody,
  listAt,
  modifierFlagOf,
  nodeId,
  nodeKind,
  nodeOfFunc,
  paramSpan,
  stmtModifiersLen,
  stmtModifiersStart,
  typeAnnotationSpan,
  typeParamConstraint,
  typeParamDefault,
  typeTag,
} from "../../../lint/ast/index.ts";
import {
  AN_CALL_EXPRESSION,
  AN_FORMAL_PARAMETERS,
  AN_FUNCTION_BODY,
  AN_TAGGED_TEMPLATE_EXPRESSION,
  anId,
  anSpan,
  anTag,
  exprAstParent,
  funcAsAstNodes,
  mkAn,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { enterNode, extendNode } from "../../cursor_region.ts";
import { exprTagExpression } from "../fields.ts";
import {
  PK_PARENT,
  WK_TYPE_ANNOTATION,
  fmtTypeAnnotation,
  identifier,
  writeExpression,
  writeTrailingCommentsIn,
} from "../format.ts";
import {
  DANGLING_BLOCK,
  commentsStayBetweenHeadAndBody,
  formatDanglingComments,
  formatLeadingComments,
  formatLeadingCommentsRange,
  formatTrailingCommentsRange,
  writeHeadBodySeparator,
} from "../trivia.ts";
import { fmtNodeWithoutTrailingComments } from "../utils/format_node_without_trailing_comments.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { endOfLineComments } from "../utils/typescript.ts";
import { FUNCTION_CACHE_MODE_NO_CACHE } from "./arrow_function_expression.ts";
import { isEmptyBlock } from "./block_statement.ts";
import { fmtFormalParameters, followsNameOrTypeParameters } from "./parameters.ts";
import { fmtStatements } from "./program.ts";
import { optionalSemicolon } from "./semicolon.ts";
import { typeParameters } from "./type_parameters.ts";
import { writeComponentOrKeyword } from "./flow.ts";
import { CACHE_HIT, CACHE_DIRECT } from "./function.consts.ts";
export { CACHE_HIT, CACHE_DIRECT } from "./function.consts.ts";

const T_DECLARE = token("declare ");
const T_ASYNC = token("async ");
const T_FUNCTION = token("function");


/**
 * `FormatContentWithCacheMode::fmt`, for content that is written by the caller: content that is formatted once and written as often as
 * it takes to find the layout of a call that it is an argument of. It cannot be formatted again, because its comments would be gone.
 * `(start, end)`: a span that nothing else is cached under.
 *
 *     const slot = cacheBegin(start, end, cacheMode, f);
 *     if (slot !== CACHE_HIT) { ..write the content.. }
 *     cacheEnd(slot, start, end, f);
 */
export function cacheBegin(start: number, end: number, cacheMode: number, f: Formatter): number {
  if (cacheMode === FUNCTION_CACHE_MODE_NO_CACHE) return CACHE_DIRECT;
  const cached = cxOf(f).getCachedElement(start, end);
  if (cached >= 0) {
    f.writeInterned(cached);
    return CACHE_HIT;
  }
  return f.startCapture();
}

export function cacheEnd(slot: number, start: number, end: number, f: Formatter): void {
  if (slot < 0) return;
  const handle = f.endCapture(slot);
  if (handle >= 0) {
    cxOf(f).cacheElement(start, end, handle);
    f.writeInterned(handle);
  }
}

/** A function declaration or expression. Not a method: see `class.ts`. */
export function writeFunction(func: number, cacheMode: number, f: Formatter): void {
  const node = funcAsAstNodes(func);
  let keywordIsFunction = true;
  let keyword = "function";
  if (fileIsFlow()) {
    keyword = writeComponentOrKeyword(func, f);
    if (keyword === "") return;
    keywordIsFunction = keyword === "function";
  }
  let isDeclared = false;
  const owner = funcOwner(func);
  if (nodeKind(owner) === N_STMT) {
    const s = nodeId(owner);
    const ms = stmtModifiersStart(s);
    const mn = stmtModifiersLen(s);
    for (let i = 0; i < mn; i++) {
      if (modifierFlagOf(listAt(ms, i)) === FLAG_AMBIENT) {
        isDeclared = true;
        break;
      }
    }
  }

  anSpan(node);
  const SP$ = SP;
  const nodeStart = SP$.s0 | 0;
  const nodeEnd = SP$.s1 | 0;
  let slot = cacheBegin(nodeStart, nodeEnd, cacheMode, f);
  if (slot !== CACHE_HIT) {
    if (isDeclared) f.token(T_DECLARE);
    if (funcIsAsync(func)) f.token(T_ASYNC);
    if (keywordIsFunction) f.token(T_FUNCTION);
    else f.tokenStr(keyword);
    if (funcIsGenerator(func)) f.token(STAR);
    f.space();
    const name = funcName(func);
    if (name >= 0) identifier(name, funcNamePos(func), node, f);
    f.startGroup();
    typeParameters(funcTypeParamsStart(func), funcTypeParamsLen(func), nodeOfFunc(func), 0, false, f);
    f.endGroup();
    fmtCommentsBehindParenthesis(func, f);
  }
  cacheEnd(slot, nodeStart, nodeEnd, f);

  // the parameters and the return type
  anSpan(mkAn(AN_FORMAL_PARAMETERS, func));
  const paramsStart = SP$.s0 | 0;
  const paramsEnd = SP$.s1 | 0;
  const returnType = funcReturnType(func);
  let rtStart = 0;
  let rtEnd = 0;
  if (returnType >= 0) {
    typeAnnotationSpan(returnType);
    rtStart = SP$.s0 | 0;
    rtEnd = SP$.s1 | 0;
  }
  const hasBody = funcHasBody(func);

  f.startGroup();
  if (!canGroupFunctionParameters(func)) {
    slot = cacheBegin(paramsStart, paramsEnd, cacheMode, f);
    if (slot !== CACHE_HIT) fmtFormalParameters(func, f);
    cacheEnd(slot, paramsStart, paramsEnd, f);
    if (returnType >= 0) {
      slot = cacheBegin(rtStart, rtEnd, cacheMode, f);
      if (slot !== CACHE_HIT) writeReturnType(returnType, hasBody, f);
      cacheEnd(slot, rtStart, rtEnd, f);
    }
  } else {
    // The parameters have to be formatted before the return type, which `shouldGroupFunctionParameters` may do.
    const parameters = captureCached(paramsStart, paramsEnd, cacheMode, f, func, -1, false);
    const rt = captureCached(rtStart, rtEnd, cacheMode, f, func, returnType, hasBody);
    const groupParameters = shouldGroupFunctionParameters(func, rt, f);
    if (groupParameters) f.startGroup();
    f.writeInterned(parameters);
    if (groupParameters) f.endGroup();
    f.writeInterned(rt);
  }
  f.endGroup();

  if (hasBody) {
    f.space();
    anSpan(mkAn(AN_FUNCTION_BODY, func));
    const bs = SP$.s0 | 0;
    const be = SP$.s1 | 0;
    slot = cacheBegin(bs, be, cacheMode, f);
    if (slot !== CACHE_HIT) fmtFunctionBody(func, f);
    cacheEnd(slot, bs, be, f);
  } else {
    optionalSemicolon(f);
  }
}

/** The return type, with the space before it if a comment is before it. */
function writeReturnType(returnType: number, hasBody: boolean, f: Formatter): void {
  typeAnnotationSpan(returnType);
  const needsSpace = cxOf(f).comments.hasCommentBefore(SP.s0 | 0);
  f.maybeSpace(needsSpace);
  // The comments before the `{` are written with the body.
  if (hasBody) fmtNodeWithoutTrailingComments(WK_TYPE_ANNOTATION, returnType, f);
  else fmtTypeAnnotation(returnType, f);
}

/** Formats the parameters (`returnType` < 0) or the return type of `func` once, as a capture. */
function captureCached(start: number, end: number, cacheMode: number, f: Formatter, func: number, returnType: number, hasBody: boolean): number {
  const slot = f.startCapture();
  const cslot = cacheBegin(start, end, cacheMode, f);
  if (cslot !== CACHE_HIT) {
    if (returnType < 0) fmtFormalParameters(func, f);
    else writeReturnType(returnType, hasBody, f);
  }
  cacheEnd(cslot, start, end, f);
  return f.endCapture(slot);
}

/**
 * The comments behind the `(` of the parameters on its line, if nothing else follows on that line. They trail what is before the `(`, a
 * name or type parameters, if there is such a node:
 *
 * ```js
 * function f( // comment
 *   a) {}
 * ```
 */
export function fmtCommentsBehindParenthesis(func: number, f: Formatter): void {
  const cx = cxOf(f);
  // For oxfmt the parentheses are a node, and the comments in it lead the first parameter.
  if (cx.isQuiet || f.options.flavor === FLAVOR_OXFMT) return;
  let first = funcThisParam(func);
  if (first < 0) {
    if (funcParamsLen(func) === 0) return;
    first = listAt(funcParamsStart(func), 0);
  }
  if (!followsNameOrTypeParameters(func)) return;
  const cm = cx.comments;
  paramSpan(first);
  cm.commentsBefore(SP.s0 | 0);
  const from = cm.from;
  const to = endOfLineComments(f, from, cm.to);
  formatTrailingCommentsRange(from, to, f);
}

/** Prettier's `isIifeCalleeOrTaggedTemplateExpressionTag`. */
function isIifeCalleeOrTaggedTemplateTag(e: number): boolean {
  const parent = exprAstParent(e);
  const t = anTag(parent);
  if (t === AN_CALL_EXPRESSION) return exprCallee(anId(parent)) === e;
  if (t === AN_TAGGED_TEMPLATE_EXPRESSION) return exprTagExpression(anId(parent)) === e;
  return false;
}

/**
 * `// comment ⏎ (function () {})()`: oxfmt follows Prettier 3.8, for which the parentheses are written around the function alone, as
 * around anything else.
 */
function commentsOfCalledFunctionAreOutsideOfItsParentheses(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** How many comments in `(spanEnd, end)` trail the function. */
function countTrailing(spanEnd: number, end: number, isFollowed: boolean, f: Formatter): number {
  const cm = cxOf(f).comments;
  cm.commentsIn(spanEnd, end);
  let count = 0;
  const to = cm.to;
  for (let i = cm.from; i < to; i++) {
    if (isFollowed && cm.precededByNewline(i)) break;
    count = (count + 1) | 0;
  }
  return count;
}

/**
 * Prettier's `printCommentsForFunction`: the comments around a function that is called, or is the tag of a template, are written in its
 * parentheses.
 *
 * ```js
 * (
 *   // comment
 *   function () {}
 * )();
 * ```
 *
 * Returns whether `e` is such a function and has been written.
 */
export function writeCalledFunctionWithComments(e: number, options: number, f: Formatter): boolean {
  if (exprAsFn(e) < 0 || !isIifeCalleeOrTaggedTemplateTag(e) || commentsOfCalledFunctionAreOutsideOfItsParentheses(f)) return false;
  const cm = cxOf(f).comments;
  exprSpan(e);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const spanEnd = SP$.s1 | 0;
  const end = exprOuterEnd(e);
  // Whoever writes the callee may have hidden the comments after it.
  const viewLimit = cm.limitCommentsUpTo(0);
  cm.restoreViewLimit(-1);
  cm.limitCommentsUpTo(end);

  // On a line of its own, a comment leads what follows: the first argument or the template.
  const parent = exprAstParent(e);
  let isFollowed = true;
  if (anTag(parent) === AN_CALL_EXPRESSION) {
    const call = exprAsCallLike(anId(parent));
    isFollowed = call >= 0 && callArgsLen(call) > 0;
  }
  const hasComments = cm.hasCommentBefore(start) || countTrailing(spanEnd, end, isFollowed, f) > 0;
  if (hasComments) {
    const isSuppressed = cm.isSuppressed(start);
    f.token(LPAREN);
    f.startSoftBlockIndent();
    formatLeadingComments(start, spanEnd, f);
    if (isSuppressed) writeSuppressedNode(start, spanEnd, f);
    else writeExpression(e, options, f);
    const count = countTrailing(spanEnd, end, isFollowed, f);
    cm.commentsBefore(end);
    formatTrailingCommentsRange(cm.from, cm.from + count, f);
    f.endSoftBlockIndent();
    f.token(RPAREN);
  }
  cm.restoreViewLimit(viewLimit);
  return hasComments;
}

/** The `{ .. }` of a function. */
export function fmtFunctionBody(func: number, f: Formatter): void {
  if (funcBodyKind(func) !== BODY_BLOCK) return;
  const cx = cxOf(f);
  const sStart = funcBodyStmtsStart(func);
  const sLen = funcBodyStmtsLen(func);
  const empty = isEmptyBlock(sStart, sLen);
  if (cx.isQuiet) {
    f.space();
    if (empty) f.token(EMPTY_BRACES);
    else {
      f.token(LBRACE);
      f.startBlockIndent();
      fmtStatements(sStart, sLen, f);
      f.endBlockIndent();
      f.token(RBRACE);
    }
    return;
  }
  anSpan(mkAn(AN_FUNCTION_BODY, func));
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  // format_node_without_comments(span, || func.as_ast_nodes(), f, write)
  if (cx.comments.isSuppressed(start)) {
    formatLeadingComments(start, end, f);
    enterNode(start, end, f);
    writeSuppressedNode(start, end, f);
    extendNode(start, end, f);
    writeTrailingCommentsIn(start, end, PK_PARENT, funcAsAstNodes(func), f);
    return;
  }
  if (commentsStayBetweenHeadAndBody(f) && !funcIsArrow(func)) {
    writeHeadBodySeparator(start, f);
  } else {
    writeCommentsBeforeBody(func, start, f);
    f.space();
  }
  if (empty) {
    f.token(LBRACE);
    formatDanglingComments(start, end, DANGLING_BLOCK, f);
    f.token(RBRACE);
  } else {
    f.token(LBRACE);
    f.startBlockIndent();
    fmtStatements(sStart, sLen, f);
    f.endBlockIndent();
    f.token(RBRACE);
  }
}

/**
 * The comments before the `{` of a function that stay there. A line comment right before the `{` does not: it is moved into the block.
 * Prettier's `handleLastFunctionParameterComments`.
 */
function writeCommentsBeforeBody(func: number, bodyStart: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) return;
  const cm = cx.comments;
  const n = cm.commentsBefore(bodyStart);
  if (n === 0) return;
  const from = cm.from;
  const to = cm.to;
  // Those from before the `(` lead the block, whatever they are.
  anSpan(mkAn(AN_FORMAL_PARAMETERS, func));
  const parametersStart = SP.s0 | 0;
  // After a `=>`, a comment at the end of the line is moved into the block as well: `handleArrowExpressionComments`.
  const isArrow = funcIsArrow(func);
  let count = 0;
  for (let i = from; i < to; i++) {
    if ((cm.isBlock(i) && !(isArrow && cm.followedByNewline(i))) || (cm.ce[i] | 0) <= parametersStart) count = (count + 1) | 0;
    else break;
  }
  const end = from + count;
  let movedEnd = from;
  while (movedEnd < end && (cm.ce[movedEnd] | 0) <= parametersStart) movedEnd = (movedEnd + 1) | 0;
  let trailingEnd = movedEnd;
  while (trailingEnd < end && !cm.precededByNewline(trailingEnd)) trailingEnd = (trailingEnd + 1) | 0;
  f.space();
  formatLeadingCommentsRange(from, movedEnd, f);
  formatTrailingCommentsRange(movedEnd, trailingEnd, f);
  f.space();
  formatLeadingCommentsRange(trailingEnd, end, f);
}

/** Whether the parameters are a group of their own, so that the return type breaks first. `formattedReturnType`: the capture of the return type. */
export function shouldGroupFunctionParameters(func: number, formattedReturnType: number, f: Formatter): boolean {
  if (!canGroupFunctionParameters(func)) return false;
  const returnType = funcReturnType(func);
  if (returnType < 0) return false;
  const t = typeTag(returnType);
  return t === TYPE_OBJECT || t === TYPE_MAPPED || (formattedReturnType >= 0 && f.willBreak(formattedReturnType));
}

/** What it takes, whatever the return type is written as. */
export function canGroupFunctionParameters(func: number): boolean {
  const n = funcTypeParamsLen(func);
  if (n > 1) return false;
  if (n === 1) {
    const first = listAt(funcTypeParamsStart(func), 0);
    // Prettier does not ask for the `bound` of Flow.
    if ((typeParamConstraint(first) >= 0 && !fileIsFlow()) || typeParamDefault(first) >= 0) return false;
  }
  return funcReturnType(func) >= 0 && funcParamsLen(func) + (funcThisParam(func) >= 0 ? 1 : 0) === 1;
}
