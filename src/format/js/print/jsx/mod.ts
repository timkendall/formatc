// Port of vendor/bun/src/format/js/print/jsx/mod.rs: JSX. Prettier's `print/jsx.js`.
import { Formatter } from "../../../ir/formatter.ts";
import { token } from "../../../ir/element.ts";
import { COLON, DOT, ELLIPSIS, LBRACE, LANGLE, RANGLE, RBRACE } from "../../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../../options.ts";
import {
  EXPR_ARRAY,
  EXPR_CALL,
  EXPR_DOT,
  EXPR_MISSING,
  EXPR_NEW,
  EXPR_NON_NULL,
  EXPR_OBJECT,
  EXPR_SPREAD,
  KEY_NONE,
  PROP_SPREAD,
  SP,
  callArgsLen,
  callCallee,
  exprArrayElemsLen,
  exprAwaitExpr,
  exprCallCall,
  exprDotName,
  exprDotNamePos,
  exprDotObj,
  exprNewCall,
  exprNonNullExpr,
  exprObjectPropsLen,
  exprJsxContainerSpan,
  exprOuterEnd,
  exprSpan,
  exprSpreadExpr,
  exprTag,
  identSpan,
  keyKind,
  keySpan,
  nodeOfProp,
  propKind,
  propSpan,
  propValue,
} from "../../../../lint/ast/index.ts";
import {
  AN_ARRAY_EXPRESSION,
  AN_ARROW_FUNCTION_EXPRESSION,
  AN_AWAIT_EXPRESSION,
  AN_BINARY_EXPRESSION,
  AN_CALL_EXPRESSION,
  AN_CONDITIONAL_EXPRESSION,
  AN_FUNCTION,
  AN_JSX_ATTRIBUTE,
  AN_JSX_ELEMENT,
  AN_JSX_EXPRESSION_CONTAINER,
  AN_JSX_FRAGMENT,
  AN_JSX_SPREAD_CHILD,
  AN_LOGICAL_EXPRESSION,
  AN_OBJECT_EXPRESSION,
  AN_PRIVATE_IN_EXPRESSION,
  AN_TAGGED_TEMPLATE_EXPRESSION,
  AN_TEMPLATE_LITERAL,
  anParent,
  anSpan,
  anTag,
  exprAsAstNodes,
  exprAsChainElement,
  mkAn,
} from "../../ast_nodes.ts";
import { cxOf } from "../../context.ts";
import {
  PK_NODE,
  PK_PARENT,
  enterScope,
  fmtExpr,
  leaveScope,
  writeTrailingCommentsIn,
} from "../../format.ts";
import {
  DANGLING_BLOCK,
  DANGLING_NONE,
  formatDanglingCommentsRange,
  formatLeadingComments,
  formatLeadingCommentsRange,
  formatTrailingCommentsRange,
} from "../../trivia.ts";
import { contextOfAttribute } from "../../utils/tailwindcss.ts";
import { writeSuppressedNode } from "../../utils/suppressed.ts";
import { writeAnyJsxTagWithChildren } from "./element.ts";

const CLOSE_OPEN = token("</");
const LBRACE_TOKEN = LBRACE;
const EQ = token("=");

/** `<a>b</a>`, `<a />`, `<>b</>` */
export function writeJsxElement(e: number, f: Formatter): void {
  writeAnyJsxTagWithChildren(e, f);
}

/** The name in a tag: `a`, `a.b`, `a-b`, `a:b`. `parent`: the element (an `AstNodes`). */
export function fmtJsxName(name: number, parent: number, f: Formatter): void {
  exprSpan(name);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const cx = cxOf(f);
  // format_node(name.span(), || parent, f, |f| ..)
  if (cx.isQuiet) {
    writeJsxNameBody(name, start, end, parent, f);
    return;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    writeJsxNameBody(name, start, end, parent, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_PARENT, parent, f);
}

function writeJsxNameBody(name: number, start: number, end: number, parent: number, f: Formatter): void {
  if (exprTag(name) === EXPR_DOT) {
    if (!f.stack.enter()) return;
    fmtJsxName(exprDotObj(name), parent, f);
    f.token(DOT);
    identSpan(exprDotName(name), exprDotNamePos(name));
    f.sourceText(SP[0] | 0, SP[1] | 0);
    f.stack.leave();
  } else {
    writeJsxIdentifier(start, end, f);
  }
}

function isPart(b: number): boolean {
  return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95 || b === 36 || b === 45 || b >= 0x80;
}

/** `a`, `a-b`, `a:b` */
function writeJsxIdentifier(start: number, end: number, f: Formatter): void {
  const text = f.source;
  let nsEnd = start;
  while (nsEnd < end && isPart(text[nsEnd] | 0)) nsEnd = nsEnd + 1;
  if (nsEnd === end) {
    f.textSourceNoWs(start, end);
    return;
  }
  let nameStart = end;
  while (nameStart > start && isPart(text[nameStart - 1] | 0)) nameStart = nameStart - 1;
  const cm = cxOf(f).comments;
  cm.commentsBeforeCharacter(nsEnd, 58);
  const beforeColonFrom = cm.from;
  const beforeColonTo = cm.to;
  f.sourceText(start, nsEnd);
  formatTrailingCommentsRange(beforeColonFrom, beforeColonTo, f);
  f.token(COLON);
  cm.commentsBefore(nameStart);
  formatLeadingCommentsRange(cm.from, cm.to, f);
  f.sourceText(nameStart, end);
}

/** `</a>` */
export function writeJsxClosingElement(e: number, name: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  exprSpan(name);
  cm.commentsBefore(SP[0] | 0);
  const from = cm.from;
  const to = cm.to;
  const nameHasLeadingComment = to > from;
  let nameHasOwnLineLeadingComment = false;
  for (let i = from; i < to; i++) {
    if (cm.isLine(i)) {
      nameHasOwnLineLeadingComment = true;
      break;
    }
  }
  const parent = mkAn(AN_JSX_ELEMENT, e);
  f.token(CLOSE_OPEN);
  if (nameHasOwnLineLeadingComment) {
    f.hardLineBreak();
    f.startBlockIndent();
    fmtJsxName(name, parent, f);
    f.endBlockIndent();
    f.hardLineBreak();
  } else {
    if (nameHasLeadingComment) f.space();
    fmtJsxName(name, parent, f);
  }
  f.token(RANGLE);
}

/** `<>` and `</>`. `(spanStart, spanEnd)`: of the tag. */
export function writeJsxFragmentTag(spanStart: number, spanEnd: number, isClosing: boolean, f: Formatter): void {
  const cm = cxOf(f).comments;
  void spanStart;
  cm.commentsBefore(spanEnd);
  const from = cm.from;
  const to = cm.to;
  if (to <= from) {
    f.token(isClosing ? CLOSE_OPEN : LANGLE);
    f.token(RANGLE);
    return;
  }
  let hasOwnLineComment = false;
  for (let i = from; i < to; i++) {
    if (cm.isLine(i)) {
      hasOwnLineComment = true;
      break;
    }
  }
  f.token(isClosing ? CLOSE_OPEN : LANGLE);
  f.startIndent();
  if (hasOwnLineComment) f.hardLineBreak();
  else if (isClosing) f.space();
  formatDanglingCommentsRange(from, to, DANGLING_NONE, f);
  f.endIndent();
  if (hasOwnLineComment) f.hardLineBreak();
  f.token(RANGLE);
}

/** A child of an element, or the value of an attribute: text, an element, `{e}`, `{...e}` (`FormatJsxChild`). */
export function fmtJsxChild(e: number, f: Formatter): void {
  if (!exprJsxContainerSpan(e)) {
    fmtExpr(e, f);
    return;
  }
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const cx = cxOf(f);
  const isSpread = exprTag(e) === EXPR_SPREAD;
  const node = mkAn(isSpread ? AN_JSX_SPREAD_CHILD : AN_JSX_EXPRESSION_CONTAINER, e);
  // format_node(span, || node.parent(), f, |f| ..)
  if (cx.isQuiet) {
    writeContainerBody(e, node, isSpread, start, end, f);
    return;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    writeContainerBody(e, node, isSpread, start, end, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_NODE, node, f);
}

function writeContainerBody(e: number, node: number, isSpread: boolean, start: number, end: number, f: Formatter): void {
  if (isSpread) writeJsxSpread(exprSpreadExpr(e), start, end, f);
  else writeJsxExpressionContainer(e, node, start, end, f);
}

/** `{e}`. `(spanStart, spanEnd)`: of the braces. `node`: the `JSXExpressionContainer`. */
function writeJsxExpressionContainer(expression: number, node: number, spanStart: number, spanEnd: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  void spanStart;
  if (exprTag(expression) === EXPR_MISSING) {
    // `{/* comment */}`
    cm.commentsBefore(spanEnd);
    const from = cm.from;
    const to = cm.to;
    let hasLineComment = false;
    for (let i = from; i < to; i++) {
      if (cm.isLine(i)) {
        hasLineComment = true;
        break;
      }
    }
    f.startGroup();
    f.token(LBRACE_TOKEN);
    formatDanglingCommentsRange(from, to, hasLineComment ? DANGLING_BLOCK : DANGLING_NONE, f);
    f.lineSuffixBoundary();
    f.token(RBRACE);
    f.endGroup();
    return;
  }

  exprSpan(expression);
  const exprStart = SP[0] | 0;
  const exprEnd = SP[1] | 0;
  let hasComment = false;
  if (!cx.isQuiet) {
    hasComment =
      cm.hasCommentBefore(exprStart) ||
      cm.hasCommentInRange(exprEnd, spanEnd) ||
      (hasOnlyComments(expression, f) && commentsAloneInBracesAreNotHugged(f));
  }
  const parentTag = anTag(anParent(node));
  const isChild = parentTag === AN_JSX_ELEMENT || parentTag === AN_JSX_FRAGMENT;
  if (!hasComment && shouldInlineJsxExpression(expression, isChild)) {
    f.startGroup();
    f.token(LBRACE_TOKEN);
    fmtExpr(expression, f);
    f.lineSuffixBoundary();
    f.token(RBRACE);
    f.endGroup();
    return;
  }

  f.startGroup();
  f.token(LBRACE_TOKEN);
  f.startSoftBlockIndent();
  fmtExpr(expression, f);
  cm.commentsBefore(spanEnd);
  formatTrailingCommentsRange(cm.from, cm.to, f);
  f.endSoftBlockIndent();
  f.lineSuffixBoundary();
  f.token(RBRACE);
  f.endGroup();
}

/** `{}`, `[]` or the `()` of a call with nothing but comments in it, which are comments of `expression` for Prettier. */
function hasOnlyComments(expression: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  const tag = exprTag(expression);
  if (tag === EXPR_OBJECT && exprObjectPropsLen(expression) === 0) {
    exprSpan(expression);
    return cm.hasCommentInRange(SP[0] | 0, SP[1] | 0);
  }
  if (tag === EXPR_ARRAY && exprArrayElemsLen(expression) === 0) {
    exprSpan(expression);
    return cm.hasCommentInRange(SP[0] | 0, SP[1] | 0);
  }
  if (tag === EXPR_CALL || tag === EXPR_NEW) {
    const call = tag === EXPR_CALL ? exprCallCall(expression) : exprNewCall(expression);
    if (callArgsLen(call) !== 0) return false;
    exprSpan(expression);
    const end = SP[1] | 0;
    return cm.hasCommentInRange(exprOuterEnd(callCallee(call)), end);
  }
  return false;
}

/**
 * ```jsx
 * <a                 <a
 *   b={                b={{
 *     {                  // comment
 *       // comment     }}
 *     }              />
 *   }
 * />
 * ```
 *
 * Prettier on the left, oxfmt on the right.
 */
function commentsAloneInBracesAreNotHugged(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/**
 * Prettier's `shouldInline` in `printJsxExpressionContainer`: it starts right after the `{` and ends right before the `}`, even if it
 * breaks. `isChild0`: the braces are among the children of an element.
 */
function shouldInlineJsxExpression(expression0: number, isChild0: boolean): boolean {
  let expression = expression0;
  let isChild = isChild0;
  while (true) {
    const node = exprAsAstNodes(expression);
    switch (anTag(node)) {
      case AN_ARRAY_EXPRESSION:
      case AN_OBJECT_EXPRESSION:
      case AN_ARROW_FUNCTION_EXPRESSION:
      case AN_FUNCTION:
      case AN_TEMPLATE_LITERAL:
      case AN_TAGGED_TEMPLATE_EXPRESSION:
        return true;
      case AN_AWAIT_EXPRESSION: {
        const argument = exprAwaitExpr(expression);
        if (argument < 0) return false;
        if (anTag(exprAsAstNodes(argument)) === AN_JSX_ELEMENT) return true;
        expression = argument;
        isChild = false;
        break;
      }
      case AN_CONDITIONAL_EXPRESSION:
      case AN_LOGICAL_EXPRESSION:
      case AN_BINARY_EXPRESSION:
      case AN_PRIVATE_IN_EXPRESSION:
        return isChild;
      default: {
        // Prettier's `stripChainElementWrappers`
        let callee = expression;
        while (exprTag(callee) === EXPR_NON_NULL) callee = exprNonNullExpr(callee);
        return anTag(exprAsChainElement(callee)) === AN_CALL_EXPRESSION;
      }
    }
  }
}

/** `a="b"`, `a={b}`, `a`, `{...a}` */
export function writeJsxAttribute(attribute: number, f: Formatter): void {
  const cx = cxOf(f);
  if (propKind(attribute) === PROP_SPREAD) {
    const argument = propValue(attribute);
    if (argument >= 0) {
      propSpan(attribute);
      writeJsxSpread(argument, SP[0] | 0, SP[1] | 0, f);
    }
    return;
  }
  const key = nodeOfProp(attribute);
  let nameStart = -1;
  let nameEnd = -1;
  if (keyKind(key) !== KEY_NONE && keySpan(key)) {
    nameStart = SP[0] | 0;
    nameEnd = SP[1] | 0;
    const parent = mkAn(AN_JSX_ATTRIBUTE, attribute);
    // format_node(span, || AstNodes::JSXAttribute(attribute), f, |f| write_jsx_identifier(span, f))
    if (cx.isQuiet) {
      writeJsxIdentifier(nameStart, nameEnd, f);
    } else {
      const cm = cx.comments;
      const isSuppressed = cm.isSuppressed(nameStart) || cm.hasTrailingSuppressionComment(nameEnd);
      formatLeadingComments(nameStart, nameEnd, f);
      if (isSuppressed) writeSuppressedNode(nameStart, nameEnd, f);
      else {
        const outer = enterScope(cx, nameStart, nameEnd);
        writeJsxIdentifier(nameStart, nameEnd, f);
        leaveScope(cx, outer);
      }
      writeTrailingCommentsIn(nameStart, nameEnd, PK_PARENT, parent, f);
    }
  }
  const value = propValue(attribute);
  if (value >= 0) {
    const context = nameStart >= 0 ? contextOfAttribute(f.source, nameStart, nameEnd, f) : -1;
    f.token(EQ);
    if (context >= 0) cx.pushTailwindContext(context);
    fmtJsxChild(value, f);
    if (context >= 0) cx.popTailwindContext();
  }
}

/** `{...argument}`. `(spanStart, spanEnd)`: of the braces. */
function writeJsxSpread(argument: number, spanStart: number, spanEnd: number, f: Formatter): void {
  const cx = cxOf(f);
  void spanStart;
  exprSpan(argument);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const hasComment = !cx.isQuiet && (cx.comments.hasCommentBefore(start) || cx.comments.hasCommentInRange(end, spanEnd));
  f.token(LBRACE_TOKEN);
  if (hasComment) f.startSoftBlockIndent();
  formatLeadingComments(start, end, f);
  f.token(ELLIPSIS);
  fmtExpr(argument, f);
  if (hasComment) f.endSoftBlockIndent();
  f.token(RBRACE);
}

/** `{...e}` among the children of an element. `e`: the `Spread`. */
export function writeJsxSpreadChild(e: number, f: Formatter): void {
  if (exprTag(e) === EXPR_SPREAD) {
    anSpan(mkAn(AN_JSX_SPREAD_CHILD, e));
    writeJsxSpread(exprSpreadExpr(e), SP[0] | 0, SP[1] | 0, f);
  }
}

/** Text that is written by itself. That among the children of an element is written word by word: see `child_list.ts`. */
export function writeJsxText(e: number, f: Formatter): void {
  exprSpan(e);
  f.textSource(SP[0] | 0, SP[1] | 0);
}


