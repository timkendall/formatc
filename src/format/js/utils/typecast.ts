// Port of vendor/bun/src/format/js/utils/typecast.rs: `/** @type {T} */ (e)`: a type cast of the Closure Compiler and of TypeScript in
// JavaScript. It only is one with the parentheses, so they stay: Prettier keeps the `ParenthesizedExpression` that Babel has for them.
// What looks at the kind of an expression to lay something out sees that node and not what is in it: it asks `isCastTarget`.
import { Formatter } from "../../ir/formatter.ts";
import { LPAREN, RPAREN } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  EXPR_ARRAY,
  EXPR_OBJECT,
  SP,
  exprIsParenthesized,
  exprParenCount,
  exprParenFirst,
  exprSpan,
  exprTag,
  hir,
} from "../../../lint/ast/index.ts";
import { I32Vec } from "../../../base/i32vec.ts";
import { cxOf } from "../context.ts";
import { fmtInTypeCasts, writeTrailingCommentsOf } from "../format.ts";
import { formatLeadingComments, formatTrailingCommentsRange } from "../trivia.ts";
import { writeSuppressedNode } from "./suppressed.ts";

/** Whether `e` is in parentheses that stay. */
export function isCastTarget(e: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  if (!cm.hasTypeCastComments || !exprIsParenthesized(e)) return false;
  const first = exprParenFirst(e);
  const n = exprParenCount(e);
  const hir$ = hir;
  for (let i = 0; i < n; i++) {
    if (cm.isCastParenthesis(hir$.parenStart[(first + i) | 0] | 0)) return true;
  }
  return false;
}

/**
 * The same, where only Prettier takes the parentheses for what is there. oxfmt looks at what is in them: in the argument of `return` and
 * `throw`, in a branch of a conditional expression, in the object of a member access.
 */
export function isCastTargetThatHidesItsKind(e: number, f: Formatter): boolean {
  return isCastTarget(e, f) && f.options.flavor !== FLAVOR_OXFMT;
}

/** The parentheses around `e` that stay, from the outside in: pairs of (start, end) pushed on `castStack`. Returns how many. */
const castStack = new I32Vec(16);
function pushCastParentheses(e: number, f: Formatter): number {
  const cm = cxOf(f).comments;
  const first = exprParenFirst(e);
  const n = exprParenCount(e);
  let count = 0;
  const hir$ = hir;
  const castStack$ = castStack;
  for (let i = n - 1; i >= 0; i--) {
    const row = (first + i) | 0;
    const start = hir$.parenStart[row] | 0;
    if (cm.isCastParenthesis(start)) {
      castStack$.push(start);
      castStack$.push(hir$.parenEnd[row] | 0);
      count = (count + 1) | 0;
    }
  }
  return count;
}

/**
 * If `e` is in parentheses that stay, writes them with the comments around them, and `e` in them (`fmtInTypeCasts(e, options,
 * isInChainExpression, isChainExpression, node, f)`). Returns whether it has.
 *
 * `node`: `e`, or the `ChainExpression` around it (an `AstNodes`).
 */
export function writeTypeCasts(
  e: number,
  node: number,
  options: number,
  isChainExpression: boolean,
  isInChainExpression: boolean,
  f: Formatter,
): boolean {
  const cm = cxOf(f).comments;
  if (!cm.hasTypeCastComments || !exprIsParenthesized(e)) return false;
  const castStack$ = castStack;
  const base = castStack$.len;
  const count = pushCastParentheses(e, f);
  if (count === 0) return false;
  const outStart = castStack$.data[base] | 0;
  const outEnd = castStack$.data[base + 1] | 0;
  const isSuppressed = cm.isSuppressed(outStart) || cm.hasTrailingSuppressionComment(outEnd);
  formatLeadingComments(outStart, outEnd, f);
  if (isSuppressed) writeSuppressedNode(outStart, outEnd, f);
  else writeParenthesizedExpression(e, base, 0, count, node, options, isChainExpression, isInChainExpression, f);
  castStack$.len = base;
  writeTrailingCommentsOf(node, f);
  return true;
}

/** Prettier's `ParenthesizedExpression`s around `target`, without the comments around the outermost. */
function writeParenthesizedExpression(
  e: number,
  base: number,
  idx: number,
  count: number,
  node: number,
  options: number,
  isChainExpression: boolean,
  isInChainExpression: boolean,
  f: Formatter,
): void {
  if (idx >= count) {
    fmtInTypeCasts(e, options, isInChainExpression, isChainExpression, node, f);
    return;
  }
  // The parentheses in it are not written by way of `Expr`.
  if (!f.stack.enter()) return;
  const cm = cxOf(f).comments;
  const castStack$ = castStack;
  const start = castStack$.data[base + 2 * idx] | 0;
  const end = castStack$.data[base + 2 * idx + 1] | 0;
  // The comments in the parentheses are written in them, also where those after the expression are left to somebody else.
  const previousLimit = cm.showCommentsUpTo(end);
  exprSpan(e);
  const SP$ = SP;
  const targetStart = SP$.s0 | 0;
  const targetEnd = SP$.s1 | 0;
  const t = exprTag(e);
  const hugs =
    idx + 1 >= count && (t === EXPR_OBJECT || t === EXPR_ARRAY) && !cm.hasCommentInRange(start, targetStart) && !cm.hasCommentInRange(targetEnd, end);
  if (hugs) f.token(LPAREN);
  else {
    f.startGroup();
    f.token(LPAREN);
    f.startSoftBlockIndent();
  }
  if (idx + 1 < count) {
    formatLeadingComments(castStack$.data[base + 2 * idx + 2] | 0, castStack$.data[base + 2 * idx + 3] | 0, f);
  }
  writeParenthesizedExpression(e, base, idx + 1, count, node, options, isChainExpression, isInChainExpression, f);
  // Nothing follows the expression in here, so whatever is left trails it.
  cm.commentsBefore(end);
  formatTrailingCommentsRange(cm.from, cm.to, f);
  if (hugs) f.token(RPAREN);
  else {
    f.endSoftBlockIndent();
    f.token(RPAREN);
    f.endGroup();
  }
  cm.restoreViewLimit(previousLimit);
  f.stack.leave();
}
