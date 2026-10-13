// Port of vendor/bun/src/format/js/print/jsx/element.rs: an element or a fragment.
import { Formatter } from "../../../ir/formatter.ts";
import { token } from "../../../ir/element.ts";
import { FLAVOR_OXFMT } from "../../../options.ts";
import {
  EXPR_TAGGED_TEMPLATE,
  EXPR_TEMPLATE,
  JC_EXPR,
  SP,
  exprCallee,
  exprJsxContainerSpan,
  exprSpan,
  exprTag,
  jsxAttrsLen,
  jsxChildrenWithWhitespace,
  jsxCloseTag,
  jsxClosingSpan,
  jsxIsFragment,
  jsxOpeningSpan,
} from "../../../../lint/ast/index.ts";
import { I32Vec } from "../../../../sema/vec.ts";
import {
  AN_ARRAY_EXPRESSION,
  AN_CALL_EXPRESSION,
  AN_CONDITIONAL_EXPRESSION,
  AN_EXPRESSION_STATEMENT,
  AN_JSX_ATTRIBUTE,
  AN_JSX_ELEMENT,
  AN_JSX_EXPRESSION_CONTAINER,
  AN_JSX_FRAGMENT,
  AN_NEW_EXPRESSION,
  AN_PROGRAM,
  AN_TEMPLATE_LITERAL,
  AN_TS_TEMPLATE_LITERAL_TYPE,
  anId,
  anIsArrowFunctionBody,
  anIsExpressionStatement,
  anParent,
  anSpan,
  anTag,
  anWithoutChainExpression,
  exprAsAstNodes,
  exprAstParent,
} from "../../ast_nodes.ts";
import { exprAlternate } from "../../fields.ts";
import { cxOf } from "../../context.ts";
import { writeTrailingCommentsOf } from "../../format.ts";
import { needsParentheses } from "../../parentheses/expression.ts";
import { formatLeadingComments, formatTrailingCommentsRange } from "../../trivia.ts";
import { writeSuppressedNode } from "../../utils/suppressed.ts";
import {
  CHILDREN_FORCE_MULTILINE,
  CHILDREN_SINGLE_CHILD,
  childrenResult,
  formatChildren,
  writeMultilineChildren,
  writeMultilineContent,
  writeSingleChild,
} from "./child_list.ts";
import { fmtJsxChild, writeJsxClosingElement, writeJsxFragmentTag } from "./mod.ts";
import { writeOpeningElement } from "./opening_element.ts";

const LPAREN = token("(");
const RPAREN = token(")");

// ElementLayout
const LAYOUT_NO_CHILDREN: number = 0;
const LAYOUT_TEMPLATE: number = 1;
const LAYOUT_DEFAULT: number = 2;

const ROWS = new I32Vec(16);

/**
 * ```jsx
 * a = (                      a =
 *   // prettier-ignore         // prettier-ignore
 *   <b   />                    <b   />;
 * );
 * ```
 *
 * oxfmt on the left, Prettier on the right.
 */
export function ignoredJsxGetsNoParentheses(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/** The comments after the element `e` (`format_trailing_comments`). */
function writeTrailingComments(e: number, parent: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) return;
  const cm = cx.comments;
  exprSpan(e);
  const end = SP[1] | 0;
  const tag = anTag(parent);
  if (anIsExpressionStatement(parent) && anIsArrowFunctionBody(parent)) {
    // All up to the end of the arrow function
    anSpan(anParent(anParent(parent)));
    cm.commentsBefore(SP[1] | 0);
  } else if (tag === AN_CONDITIONAL_EXPRESSION) {
    const conditional = anId(parent);
    if (exprAlternate(conditional) === e) {
      exprSpan(conditional);
      cm.commentsBefore(SP[1] | 0);
    } else {
      cm.endOfLineCommentsAfter(end);
    }
  } else if (tag === AN_TEMPLATE_LITERAL || tag === AN_TS_TEMPLATE_LITERAL_TYPE) {
    cm.commentsBeforeCharacter(end, 125);
  } else {
    writeTrailingCommentsOf(exprAsAstNodes(e), f);
    return;
  }
  formatTrailingCommentsRange(cm.from, cm.to, f);
}

/** Prettier's `maybeWrapJsxElementInParens`: whether the element gets parentheses if it breaks. */
function wrapsOnBreak(parent: number): boolean {
  switch (anTag(parent)) {
    case AN_ARRAY_EXPRESSION:
    case AN_JSX_ATTRIBUTE:
    case AN_JSX_EXPRESSION_CONTAINER:
    case AN_CONDITIONAL_EXPRESSION:
    case AN_CALL_EXPRESSION:
    case AN_NEW_EXPRESSION:
    case AN_PROGRAM:
      return false;
    case AN_EXPRESSION_STATEMENT:
      return anIsArrowFunctionBody(parent);
    default:
      return anIsExpressionStatement(parent) ? anIsArrowFunctionBody(parent) : true;
  }
}

function writeOpening(e: number, f: Formatter): void {
  if (jsxIsFragment(e)) {
    jsxOpeningSpan(e);
    writeJsxFragmentTag(SP[0] | 0, SP[1] | 0, false, f);
  } else {
    writeOpeningElement(e, f);
  }
}

function writeClosing(e: number, f: Formatter): void {
  const name = jsxCloseTag(e);
  if (name >= 0) {
    writeJsxClosingElement(e, name, f);
  } else if (jsxIsFragment(e) && jsxClosingSpan(e)) {
    writeJsxFragmentTag(SP[0] | 0, SP[1] | 0, true, f);
  }
}

/** The layout, and for `Template` the child (in `templateChild`). */
const templateChildSlot = new Int32Array(1);

function layoutOf(e: number): number {
  const isFragment = jsxIsFragment(e);
  ROWS.len = 0;
  jsxChildrenWithWhitespace(e, ROWS);
  const rows = (ROWS.len / 3) | 0;
  if (rows === 0 && !isFragment) return LAYOUT_NO_CHILDREN;
  if (rows === 1 && !isFragment && (ROWS.data[0] | 0) !== JC_EXPR) return LAYOUT_NO_CHILDREN;
  if (rows === 1 && (ROWS.data[0] | 0) === JC_EXPR) {
    const child = ROWS.data[1] | 0;
    if (exprJsxContainerSpan(child)) {
      const tag = exprTag(child);
      if (tag === EXPR_TEMPLATE || tag === EXPR_TAGGED_TEMPLATE) {
        templateChildSlot[0] = child;
        return LAYOUT_TEMPLATE;
      }
    }
  }
  return LAYOUT_DEFAULT;
}

/** `{items.map((item) => <a />)}`: the body of an arrow function that is an argument of a call that is all there is in braces. */
function shouldExpand(parent: number): boolean {
  if (!anIsExpressionStatement(parent) || !anIsArrowFunctionBody(parent)) return false;
  // The `FunctionBody`, and then the arrow function.
  const arrow = anParent(anParent(parent));
  const call = anParent(arrow);
  if (anTag(call) !== AN_CALL_EXPRESSION) return false;
  const callee = exprCallee(anId(call));
  if (callee >= 0) {
    exprSpan(callee);
    const calleeStart = SP[0] | 0;
    const calleeEnd = SP[1] | 0;
    anSpan(arrow);
    if (calleeStart === (SP[0] | 0) && calleeEnd === (SP[1] | 0)) return false;
  }
  return anTag(anWithoutChainExpression(anParent(call))) === AN_JSX_EXPRESSION_CONTAINER;
}

/** `<a>b</a>`, `<a />`, `<>b</>` */
export function writeAnyJsxTagWithChildren(e: number, f: Formatter): void {
  const cx = cxOf(f);
  exprSpan(e);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const isSuppressed = cx.comments.isSuppressed(start);
  const parent = exprAstParent(e);
  const parentTag = anTag(parent);
  if (parentTag === AN_JSX_ELEMENT || parentTag === AN_JSX_FRAGMENT) {
    writeTag(e, isSuppressed, start, end, f);
    return;
  }

  if (isSuppressed && ignoredJsxGetsNoParentheses(f)) {
    // Prettier's `printIgnored` comes before `maybeWrapJsxElementInParens`.
    writeWithComments(e, isSuppressed, start, end, parent, f);
  } else if (!wrapsOnBreak(parent)) {
    writeWithComments(e, isSuppressed, start, end, parent, f);
  } else {
    const parens = needsParentheses(e, f);
    f.startGroupExpand(shouldExpand(parent));
    if (!parens) f.tokenIfBreaks(LPAREN);
    f.startSoftBlockIndent();
    writeWithComments(e, isSuppressed, start, end, parent, f);
    f.endSoftBlockIndent();
    if (!parens) f.tokenIfBreaks(RPAREN);
    f.endGroup();
  }
}

function writeWithComments(e: number, isSuppressed: boolean, start: number, end: number, parent: number, f: Formatter): void {
  formatLeadingComments(start, end, f);
  writeTag(e, isSuppressed, start, end, f);
  writeTrailingComments(e, parent, f);
}

/** `format_tag` */
function writeTag(e: number, isSuppressed: boolean, start: number, end: number, f: Formatter): void {
  if (isSuppressed) {
    writeSuppressedNode(start, end, f);
    return;
  }
  const layout = layoutOf(e);
  if (layout === LAYOUT_NO_CHILDREN) {
    writeOpening(e, f);
    writeClosing(e, f);
    return;
  }
  if (layout === LAYOUT_TEMPLATE) {
    const expression = templateChildSlot[0] | 0;
    writeOpening(e, f);
    fmtJsxChild(expression, f);
    writeClosing(e, f);
    return;
  }

  let slot = f.startCapture();
  writeOpening(e, f);
  const hOpening = f.endCapture(slot);
  const openingBreaks = f.willBreak(hOpening);
  const multipleAttributes = jsxAttrsLen(e) > 1;

  // Prettier's `isMdxBlock`
  const isMdxBlock = f.options.isMdxJsx && start === 0;
  const kind = formatChildren(e, multipleAttributes || openingBreaks, isMdxBlock, f);
  const res = childrenResult;
  const isFill = res.isFill;
  const multiline = res.multiline;
  const flat = res.flat;
  if (isMdxBlock && kind !== CHILDREN_SINGLE_CHILD) {
    writeMultilineContent(isFill, multiline, f);
    return;
  }
  if (kind === CHILDREN_SINGLE_CHILD) {
    const itemType = res.itemType;
    const itemA = res.itemA;
    const itemB = res.itemB;
    const forcedBreak = res.forcedBreak;
    f.startGroup();
    f.writeInterned(hOpening);
    writeSingleChild(itemType, itemA, itemB, forcedBreak, f);
    writeClosing(e, f);
    f.endGroup();
  } else if (kind === CHILDREN_FORCE_MULTILINE) {
    f.startGroup();
    f.writeInterned(hOpening);
    writeMultilineChildren(isFill, multiline, f);
    writeClosing(e, f);
    f.endGroup();
  } else {
    slot = f.startCapture();
    writeClosing(e, f);
    const hClosing = f.endCapture(slot);
    let s = f.startVariant();
    f.startGroup();
    f.writeInterned(hOpening);
    f.writeInterned(flat);
    f.writeInterned(hClosing);
    f.endGroup();
    const v0 = f.endVariant(s);
    s = f.startVariant();
    f.startGroup();
    f.writeInterned(hOpening);
    writeMultilineChildren(isFill, multiline, f);
    f.writeInterned(hClosing);
    f.endGroup();
    const v1 = f.endVariant(s);
    f.bestFitting2(v0, v1);
  }
}
