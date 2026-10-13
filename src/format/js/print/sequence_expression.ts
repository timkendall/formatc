// Port of vendor/bun/src/format/js/print/sequence_expression.rs: `a, b, c`.
import { I32Vec } from "../../../sema/vec.ts";
import { Formatter } from "../../ir/formatter.ts";
import { COMMA } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  EXPR_BINARY,
  BIN_COMMA,
  SP,
  exprBinaryOpOf,
  exprOuterEnd,
  exprRight,
  exprSequence,
  exprSpan,
  exprTag,
  stmtStart,
  varDeclInit,
} from "../../../lint/ast/index.ts";
import {
  AN_ASSIGNMENT_EXPRESSION,
  AN_EXPRESSION_STATEMENT,
  AN_FOR_STATEMENT,
  AN_RETURN_STATEMENT,
  AN_THROW_STATEMENT,
  AN_VARIABLE_DECLARATOR,
  anId,
  anIsArrowFunctionBody,
  anIsExpressionStatement,
  anTag,
  exprAstParent,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { fmtExpr } from "../format.ts";
import { hasOwnLineCommentBetween } from "../parentheses/expression.ts";
import { formatTrailingCommentsRange } from "../trivia.ts";

const scratch = new I32Vec(16);

/**
 * ```js
 * return (          return (
 *   a(),              a(), b(), c
 *   b(),            );
 *   c
 * );
 * ```
 *
 * Prettier on the left: what does not fit behind `return` has one expression on each line. oxfmt on the right.
 */
function sequenceAfterReturnIsAGroupOfItsOwn(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * `((/* comment *&#47; a), b)`: the parentheses of `a` go, and for oxfmt the comment in them leads the sequence: it is written before the
 * parentheses that the sequence gets. For Prettier it leads `a`. Writes into `SP` what the comments before `e` are the comments before:
 * oxc's `sequence_leading_comments_start`.
 */
export function spanThatCommentsLead(e: number, f: Formatter): void {
  exprSpan(e);
  if (f.options.flavor !== FLAVOR_OXFMT || exprTag(e) !== EXPR_BINARY || exprBinaryOpOf(e) !== BIN_COMMA) return;
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  // A type cast comment is about the parentheses behind it, which stay.
  if (cxOf(f).comments.isCastParenthesis(start)) return;
  const base = scratch.len;
  exprSequence(e, scratch);
  const first = scratch.len > base ? scratch.data[base] | 0 : -1;
  scratch.len = base;
  if (first < 0) return;
  exprSpan(first);
  SP[1] = end;
}

/** `a, b, c` */
export function writeSequenceExpression(e: number, f: Formatter): void {
  const parent = exprAstParent(e);
  const base = scratch.len;
  exprSequence(e, scratch);
  const n = scratch.len - base;
  if (n === 0) return;
  // The sequence may contain sequences of its own in the HIR (each `fmtExpr` below uses `scratch` above `end`), so `base` is kept.
  const pt = anTag(parent);

  // Where it is not in parentheses, what follows the first expression is indented.
  if (pt === AN_FOR_STATEMENT || pt === AN_EXPRESSION_STATEMENT) {
    f.startGroup();
    fmtExpr(scratch.data[base] | 0, f);
    for (let i = 1; i < n; i++) {
      f.token(COMMA);
      f.startIndent();
      f.softLineBreakOrSpace();
      fmtExpr(scratch.data[(base + i) | 0] | 0, f);
      f.endIndent();
    }
    f.endGroup();
    scratch.len = base;
    return;
  }

  // Whether it breaks is decided at the `(` of the statement (an expression statement is the body of an arrow function here).
  // The statement of a `return` or a `throw` has a group for the parentheses and what is in them, unless a comment breaks them.
  let wrapper = 0; // 0: group, 1: group(soft_block_indent), 2: none
  if (anIsExpressionStatement(parent)) wrapper = 1;
  else if (
    (pt === AN_RETURN_STATEMENT || pt === AN_THROW_STATEMENT) &&
    !sequenceAfterReturnIsAGroupOfItsOwn(f) &&
    !hasOwnLineCommentBetween(stmtStart(anId(parent)), exprStartOf(e), f)
  ) {
    wrapper = 2;
  }
  if (wrapper === 0) f.startGroup();
  else if (wrapper === 1) {
    f.startGroup();
    f.startSoftBlockIndent();
  }
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      f.token(COMMA);
      f.softLineBreakOrSpace();
    }
    fmtExpr(scratch.data[(base + i) | 0] | 0, f);
  }
  scratch.len = base;
  writeCommentsBeforeClosingParenthesis(e, f);
  if (wrapper === 0) f.endGroup();
  else if (wrapper === 1) {
    f.endSoftBlockIndent();
    f.endGroup();
  }
}

function exprStartOf(e: number): number {
  exprSpan(e);
  return SP[0] | 0;
}

/**
 * Prettier's `handleParenthesizedExpressionTrailingComment`: the comments between the end of `e`, a sequence or an assignment, and the `)` after it
 * trail the last expression in it.
 */
export function writeCommentsBeforeClosingParenthesis(e: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) return;
  const parent = exprAstParent(e);
  const pt = anTag(parent);
  let isWholeSide = false;
  if (anIsExpressionStatement(parent)) isWholeSide = anIsArrowFunctionBody(parent);
  else if (pt === AN_VARIABLE_DECLARATOR) isWholeSide = varDeclInit(anId(parent)) === e;
  else if (pt === AN_ASSIGNMENT_EXPRESSION) isWholeSide = exprRight(anId(parent)) === e;
  else if (pt === AN_RETURN_STATEMENT) isWholeSide = true;
  if (!isWholeSide) return;
  exprSpan(e);
  const end = SP[1] | 0;
  const cm = cx.comments;
  const count = cm.commentsIn(end, exprOuterEnd(e));
  const from = cm.from;
  let taken = 0;
  while (taken < count && !cm.precededByNewline((from + taken) | 0)) taken = (taken + 1) | 0;
  formatTrailingCommentsRange(from, (from + taken) | 0, f);
}
