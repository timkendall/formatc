// Port of vendor/bun/src/format/js/print/statements.rs: the statements that do not have a file of their own.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { LPAREN, RPAREN, SEMI, SPACE_TOKEN } from "../../ir/tokens.ts";
import { HTML_ROOT_VUE_EVENT_BINDING, SEMICOLONS_AS_NEEDED, FLAVOR_OXFMT } from "../../options.ts";
import {
  BIN_COMMA,
  EXPR_ARRAY,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_BINARY,
  EXPR_DOT,
  EXPR_FN,
  EXPR_IDENT,
  EXPR_INDEX,
  EXPR_INSTANTIATION,
  EXPR_JSX,
  EXPR_NEW,
  EXPR_NON_NULL,
  EXPR_REGEX,
  EXPR_SATISFIES,
  EXPR_TEMPLATE,
  EXPR_UNARY,
  EXPR_AWAIT,
  EXPR_YIELD,
  EXPR_COND,
  N_EXPR,
  N_STMT,
  SP,
  STMT_EMPTY,
  STMT_EXPR,
  STMT_IF,
  UN_MINUS,
  UN_NOT,
  UN_PLUS,
  exprAsConstExpr,
  exprAsExpr,
  exprBinaryOpOf,
  exprEnd,
  exprFnFn,
  exprInstantiationExpr,
  exprIsAngleBracketAssertion,
  exprIsParenthesized,
  exprNonNullExpr,
  exprParenCount,
  exprParenFirst,
  exprParent,
  exprSatisfiesExpr,
  exprSpan,
  exprStart,
  exprTag,
  exprUnaryOperand,
  exprUnaryOpOf,
  fileBodyLen,
  funcIsArrow,
  hir,
  identSpan,
  nodeId,
  nodeKind,
  stmtDirectiveSpan,
  stmtExprExpr,
  stmtIsBlock,
  stmtIsWith,
  stmtLabel,
  stmtLabelPos,
  stmtSpan,
  stmtTag,
} from "../../../lint/ast/index.ts";
import { I32Vec } from "../../../sema/vec.ts";
import {
  AN_BLOCK_STATEMENT,
  AN_DO_WHILE_STATEMENT,
  AN_FOR_IN_STATEMENT,
  AN_FOR_OF_STATEMENT,
  AN_FOR_STATEMENT,
  AN_IF_STATEMENT,
  AN_LABELED_STATEMENT,
  AN_PROGRAM,
  AN_WHILE_STATEMENT,
  AN_WITH_STATEMENT,
  anId,
  anTag,
  stmtAsAstNodes,
  stmtAstParent,
} from "../ast_nodes.ts";
import { linesBefore } from "../builders.ts";
import { cxOf } from "../context.ts";
import {
  WK_EXPR,
  WK_STMT,
  fmtExpr,
  fmtStmt,
  identifier,
} from "../format.ts";
import {
  DANGLING_NONE,
  commentsStayBetweenHeadAndBody,
  formatDanglingCommentsRange,
  formatLeadingCommentsRange,
  formatTrailingCommentsRange,
  writeCommentsBetweenBlocks,
  writeHeadBodySeparator,
  writeTrailingCommentsBefore,
} from "../trivia.ts";
import { BT_ASCII_WS, BT_SPACE_TAB, BT_WS_OPEN_PAREN } from "../source_text.ts";
import { binOpIsLogical } from "../utils/operators.ts";
import { expressionNeedsParentheses } from "../parentheses/expression.ts";
import { expressionLeftSideLeft, LEFT_SIDE } from "../utils/expression.ts";
import { fmtNodeWithoutTrailingComments } from "../utils/format_node_without_trailing_comments.ts";
import { commentsBeforeElse, fmtStatementBody } from "../utils/statement_body.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { canAvoidParentheses } from "./parameters.ts";
import { endsBeforeSemicolon } from "./program.ts";
import { optionalSemicolon } from "./semicolon.ts";

const KW_DO = token("do");
const KW_WHILE = token("while");
const KW_WITH = token("with");
const KW_FOR = token("for");
const KW_FOR_PAREN = token("for (");
const KW_FOR_EMPTY = token("(;;)");
const KW_AWAIT = token("await");
const KW_IN = token("in");
const KW_OF = token("of");
const KW_IF_PAREN = token("if (");
const KW_ELSE = token("else");
const KW_BREAK = token("break");
const KW_CONTINUE = token("continue");
const COLON_TOKEN = token(":");

export const COMMENT_PLACEMENT_OWN_LINE: number = 0;
export const COMMENT_PLACEMENT_END_OF_LINE: number = 1;
export const COMMENT_PLACEMENT_BEFORE_TOKEN: number = 2;
export const COMMENT_PLACEMENT_BEFORE_NODE: number = 3;

/** Whether a placement leads the following node. */
export function commentPlacementLeads(placement: number): boolean {
  return placement === COMMENT_PLACEMENT_OWN_LINE || placement === COMMENT_PLACEMENT_BEFORE_NODE;
}

/** `;`, which is only written where a statement has to be: Prettier's `isMeaningfulEmptyStatement`. */
export function writeEmptyStatement(statement: number, f: Formatter): void {
  if (isHeadOfStatement(stmtAstParent(statement))) f.token(SEMI);
}

/** Whether the node with the tag `t` is a statement that has a head and a body: `statement` is in it, not after it. */
function isHeadOfStatement(an: number): boolean {
  const t = anTag(an);
  // js-core issue: the `AstNodes` of a `with` statement is `AN_BLOCK_STATEMENT` (`innerOfStmt`).
  if (t === AN_BLOCK_STATEMENT) return stmtIsWith(anId(an));
  return (
    t === AN_DO_WHILE_STATEMENT ||
    t === AN_IF_STATEMENT ||
    t === AN_WHILE_STATEMENT ||
    t === AN_FOR_STATEMENT ||
    t === AN_FOR_IN_STATEMENT ||
    t === AN_FOR_OF_STATEMENT ||
    t === AN_WITH_STATEMENT ||
    t === AN_LABELED_STATEMENT
  );
}

/** Whether `statement` is after the end of another, and not after the head of one. */
function canFollowAStatement(statement: number): boolean {
  return !isHeadOfStatement(stmtAstParent(statement)) && !stmtDirectiveSpan(statement);
}

/**
 * Without semicolons, whether a `(` that is written before `e`, and that `expressionStatementNeedsSemicolon` does not know about, has to have a
 * `;` before it: a statement starts with `e`. Prettier writes none.
 */
export function parenthesisBeforeNeedsSemicolon(e: number, f: Formatter): boolean {
  const inHtml = f.options.inHtml;
  if (f.options.semicolons !== SEMICOLONS_AS_NEEDED || inHtml.isInlineEventHandler || inHtml.root === HTML_ROOT_VUE_EVENT_BINDING) return false;
  let top = e;
  while (true) {
    const parent = exprParent(top);
    const kind = nodeKind(parent);
    if (kind === N_EXPR) {
      const p = nodeId(parent);
      // Which writes one before this one.
      if (exprTag(p) === EXPR_COND) return false;
      if (expressionLeftSideLeft(p, false) && (LEFT_SIDE[0] | 0) === top) {
        top = p;
        continue;
      }
      return false;
    }
    if (kind === N_STMT) {
      const statement = nodeId(parent);
      return stmtTag(statement) === STMT_EXPR && stmtExprExpr(statement) === top && canFollowAStatement(statement) && !expressionStatementNeedsSemicolon(statement, top, f);
    }
    return false;
  }
}

/**
 * Without semicolons, whether the statement has to start with one so that it is not read as the continuation of the line before: it starts with
 * `(`, `[`, `` ` ``, `+`, `-`, `/` or `<`.
 */
export function expressionStatementNeedsSemicolon(statement: number, expression: number, f: Formatter): boolean {
  if (!canFollowAStatement(statement)) return false;
  switch (exprTag(expression)) {
    // `a => {}` starts with a name.
    case EXPR_FN: {
      const func = exprFnFn(expression);
      if (funcIsArrow(func)) return !canAvoidParentheses(func, f);
      break;
    }
    case EXPR_NEW:
    case EXPR_AWAIT:
    case EXPR_YIELD:
      return false;
    default:
      break;
  }

  const cm = cxOf(f).comments;
  let e = expression;
  let isTarget = false;
  while (true) {
    // `/** @type {T} */ (a).b` keeps its parentheses.
    if (cm.hasTypeCastComments && exprIsParenthesized(e)) {
      const first = exprParenFirst(e);
      const count = exprParenCount(e);
      for (let i = 0; i < count; i++) {
        if (followsTypeCastComment(hir.parenStart[(first + i) | 0] | 0, f)) return true;
      }
    }
    const tag = exprTag(e);
    if (isTarget) {
      if (tag === EXPR_ARRAY || tag === EXPR_AS || tag === EXPR_AS_CONST || tag === EXPR_SATISFIES) return true;
    } else if (expressionNeedsParentheses(e, f)) {
      return true;
    } else {
      switch (tag) {
        case EXPR_ARRAY:
        case EXPR_REGEX:
        case EXPR_JSX:
        case EXPR_TEMPLATE:
          return true;
        case EXPR_AS:
        case EXPR_AS_CONST:
          if (exprIsAngleBracketAssertion(e)) return true;
          break;
        case EXPR_FN:
          if (funcIsArrow(exprFnFn(e))) return true;
          break;
        case EXPR_UNARY: {
          const op = exprUnaryOpOf(e);
          if (op === UN_PLUS || op === UN_MINUS) return true;
          break;
        }
        default:
          break;
      }
    }
    if (!expressionLeftSideLeft(e, isTarget)) return false;
    e = LEFT_SIDE[0] | 0;
    isTarget = (LEFT_SIDE[1] | 0) !== 0;
  }
}

/** Whether the last comment before `position` is a type cast comment. */
export function followsTypeCastComment(position: number, f: Formatter): boolean {
  const cx = cxOf(f);
  const cm = cx.comments;
  if (!cm.hasTypeCastComments) return false;
  const n = cm.commentsBefore(position);
  const last = n > 0 ? (cm.to - 1) | 0 : cm.lastPrinted();
  if (last < 0) return false;
  return cm.isTypeCastComment(last) && (cm.spanEnd[last] | 0) <= position && cx.src.allBytes(cm.spanEnd[last] | 0, position, BT_ASCII_WS);
}

/** Prettier's `isSingleJsxExpressionStatementInMarkdown`: all of the code in a block in Markdown is JSX. */
function isSingleJsxStatementInMarkdown(statement: number, expression: number, f: Formatter): boolean {
  return f.options.isInMarkdown && exprTag(expression) === EXPR_JSX && anTag(stmtAstParent(statement)) === AN_PROGRAM && fileBodyLen() === 1;
}

/**
 * Prettier's `shouldPrintSemicolon` for a statement that is all of the value of an attribute in HTML. -1 (`None`): it is not, and the statement
 * ends like any other. 0, 1: it ends with a `;` or not.
 */
function semicolonOfOnlyStatementInHtml(statement: number, expression0: number, f: Formatter): number {
  const inHtml = f.options.inHtml;
  if (!(inHtml.isInlineEventHandler || inHtml.root === HTML_ROOT_VUE_EVENT_BINDING) || fileBodyLen() !== 1 || anTag(stmtAstParent(statement)) !== AN_PROGRAM) {
    return -1;
  }
  if (inHtml.isInlineEventHandler) return 0;
  // `unwrapVueEventBindingTsNode`
  let expression = expression0;
  while (true) {
    const t = exprTag(expression);
    if (t === EXPR_AS) expression = exprAsExpr(expression);
    else if (t === EXPR_SATISFIES) expression = exprSatisfiesExpr(expression);
    else if (t === EXPR_INSTANTIATION) expression = exprInstantiationExpr(expression);
    else if (t === EXPR_AS_CONST) expression = exprAsConstExpr(expression);
    else if (t === EXPR_NON_NULL) expression = exprNonNullExpr(expression);
    else break;
  }
  // A function, or the path to one: Vue calls it.
  const t = exprTag(expression);
  if (t === EXPR_FN || t === EXPR_DOT || t === EXPR_INDEX) return 1;
  if (t === EXPR_IDENT) {
    const text = cxOf(f).src.text;
    const start = exprStart(expression);
    const end = exprEnd(expression);
    const isUndefined =
      end - start === 9 &&
      (text[start] | 0) === 117 &&
      (text[start + 1] | 0) === 110 &&
      (text[start + 2] | 0) === 100 &&
      (text[start + 3] | 0) === 101 &&
      (text[start + 4] | 0) === 102 &&
      (text[start + 5] | 0) === 105 &&
      (text[start + 6] | 0) === 110 &&
      (text[start + 7] | 0) === 101 &&
      (text[start + 8] | 0) === 100;
    return isUndefined ? 0 : 1;
  }
  return 0;
}

export function writeExpressionStatement(statement: number, expression: number, f: Formatter): void {
  if (isSingleJsxStatementInMarkdown(statement, expression, f)) {
    fmtExpr(expression, f);
    return;
  }
  const cx = cxOf(f);
  const semicolonInHtml = semicolonOfOnlyStatementInHtml(statement, expression, f);
  stmtSpan(statement);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  // Before a type cast comment, `FormatStatements` has written the `;`.
  if (
    f.options.semicolons === SEMICOLONS_AS_NEEDED &&
    semicolonInHtml < 0 &&
    expressionStatementNeedsSemicolon(statement, expression, f) &&
    !followsTypeCastComment(start, f)
  ) {
    f.token(SEMI);
  }
  const cm = cx.comments;
  // `statement(); // prettier-ignore`
  if (!cx.isQuiet && cm.hasTrailingSuppressionComment(end)) {
    writeSuppressedNode(start, end, f);
    return;
  }
  // Prettier's `handleParenthesizedExpressionTrailingComment`: `(a /* comment */);` is `a; /* comment */`.
  fmtNodeWithoutTrailingComments(WK_EXPR, expression, f);
  if (semicolonInHtml < 0) optionalSemicolon(f);
  else if (semicolonInHtml === 1) f.token(SEMI);
  if (!cx.isQuiet) {
    cm.commentsBefore(cm.withoutSemicolon(start, end));
    formatTrailingCommentsRange(cm.from, cm.to, f);
  }
}

export function writeDoWhileStatement(statement: number, body: number, test: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const isBlock = stmtIsBlock(body);
  let needsSeparator = true;
  if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f)) {
    if (isBlock) {
      f.token(KW_DO);
      stmtSpan(body);
      writeHeadBodySeparator(SP[0] | 0, f);
      fmtNodeWithoutTrailingComments(WK_STMT, body, f);
    } else {
      f.startGroup();
      f.token(KW_DO);
      fmtStatementBody(body, false, f);
      f.endGroup();
    }
    stmtSpan(body);
    cm.commentsBeforeCharacter(SP[1] | 0, 119 /* w */);
    needsSeparator = writeCommentsBetweenBlocks(cm.from, cm.to, f);
  } else {
    f.startGroup();
    f.token(KW_DO);
    fmtStatementBody(body, false, f);
    f.endGroup();
  }
  if (needsSeparator) {
    if (isBlock) f.space();
    else f.hardLineBreak();
  }
  f.token(KW_WHILE);
  f.space();
  f.token(LPAREN);
  writeCondition(test, HEAD_ENDS_WITH, statement, f);
  f.token(RPAREN);
  optionalSemicolon(f);
}

/** The parentheses after the keyword of a statement. */
/** They are followed by the body of the statement. */
const HEAD_BEFORE = 0;
/** `do .. while (..);` */
const HEAD_ENDS_WITH = 1;

/**
 * A position after the `)` and before the first comment after it. That comment is not in the head: it leads the body, or trails the statement.
 * `stmt`: the body (`HEAD_BEFORE`) or the statement (`HEAD_ENDS_WITH`).
 */
function headEnd(kind: number, stmt: number, f: Formatter): number {
  const cx = cxOf(f);
  const cm = cx.comments;
  stmtSpan(stmt);
  if (kind === HEAD_BEFORE) {
    let end = SP[0] | 0;
    const n = cm.commentsBefore(end);
    const from = cm.from;
    for (let i = from + n - 1; i >= from; i--) {
      if (cx.src.containsByte(cm.spanEnd[i] | 0, end, 41 /* ) */)) break;
      end = cm.spanStart[i] | 0;
    }
    return end;
  }
  return cm.withoutSemicolon(SP[0] | 0, SP[1] | 0);
}

/** `FormatInHead`: begins writing what is in the head of a statement. Meanwhile the comments after the `)` are hidden. Returns what to restore. */
function beginInHead(kind: number, stmt: number, f: Formatter): number {
  if (cxOf(f).isQuiet) return -2;
  const end = headEnd(kind, stmt, f);
  return cxOf(f).comments.limitCommentsUpTo(end);
}

function endInHead(previousLimit: number, f: Formatter): void {
  if (previousLimit !== -2) cxOf(f).comments.restoreViewLimit(previousLimit);
}

/**
 * Prettier's `shouldInlineCondition`, but for the comments: `!(a || b)` and `!!(a || b)` start right after the `(` of the statement, so that the
 * indentation is the same as without the `!`.
 */
function isNegatedLogicalExpression(test: number): boolean {
  if (exprTag(test) !== EXPR_UNARY || exprUnaryOpOf(test) !== UN_NOT) return false;
  let argument = exprUnaryOperand(test);
  if (exprTag(argument) === EXPR_UNARY && exprUnaryOpOf(argument) === UN_NOT) argument = exprUnaryOperand(argument);
  return exprTag(argument) === EXPR_BINARY && binOpIsLogical(exprBinaryOpOf(argument));
}

/** Prettier 3.9 writes `if (!(` on one line. oxfmt follows 3.8, which breaks after `if (`. */
function hugsNegatedCondition(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/**
 * Prettier's `printIfOrWhileConditionOrWithStatementObject`: all there is in the head of an `if`, a `while`, a `do` or a `with`.
 * `(headKind, headStmt)`: see `headEnd`.
 */
function writeCondition(test: number, headKind: number, headStmt: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    if (isNegatedLogicalExpression(test) && hugsNegatedCondition(f)) fmtExpr(test, f);
    else {
      f.startGroup();
      f.startSoftBlockIndent();
      fmtExpr(test, f);
      f.endSoftBlockIndent();
      f.endGroup();
    }
    return;
  }
  const cm = cx.comments;
  const end = headEnd(headKind, headStmt, f);
  exprSpan(test);
  const hasComments = cm.hasCommentBefore(SP[0] | 0) || cm.hasCommentInRange(SP[1] | 0, end);
  const hug = !hasComments && isNegatedLogicalExpression(test) && hugsNegatedCondition(f);
  if (!hug) {
    f.startGroup();
    f.startSoftBlockIndent();
  }
  // All comments between the condition and the `)` trail the condition.
  const previousLimit = cm.limitCommentsUpTo(end);
  fmtNodeWithoutTrailingComments(WK_EXPR, test, f);
  cm.unprinted();
  formatTrailingCommentsRange(cm.from, cm.to, f);
  cm.restoreViewLimit(previousLimit);
  if (!hug) {
    f.endSoftBlockIndent();
    f.endGroup();
  }
}

function writeWhileOrWithStatement(keyword: number, test: number, body: number, f: Formatter): void {
  f.startGroup();
  f.token(keyword);
  f.space();
  f.token(LPAREN);
  writeCondition(test, HEAD_BEFORE, body, f);
  f.token(RPAREN);
  fmtStatementBody(body, false, f);
  f.endGroup();
}

export function writeWhileStatement(statement: number, test: number, body: number, f: Formatter): void {
  void statement;
  writeWhileOrWithStatement(KW_WHILE, test, body, f);
}

export function writeWithStatement(statement: number, object: number, body: number, f: Formatter): void {
  void statement;
  writeWhileOrWithStatement(KW_WITH, object, body, f);
}

// ───────────────────────────── for ─────────────────────────────

/** `FormatForHead(init)`'s span (`init` is a statement: a declaration, or the wrapper of an expression) into `SP`. */
function forHeadSpan(init: number): void {
  if (stmtTag(init) === STMT_EXPR) exprSpan(stmtExprExpr(init));
  else stmtSpan(init);
}

/** `write!(f, FormatForHead(init))`: a declaration without its `;`, or an expression. */
function fmtForHead(init: number, f: Formatter): void {
  if (stmtTag(init) === STMT_EXPR) fmtExpr(stmtExprExpr(init), f);
  else fmtStmt(init, f);
}

/**
 * See `comments_stay_between_head_and_body`: `node` (`(wk, h)`, `wk` -1: none), which is before one of the two `;` in the head of a `for`, or
 * nothing, the comments before the `;`, the `;` and the comments behind it on its line. `cursor`: where this part of the head starts. Returns
 * where the next one starts.
 */
function writeForHeadSlot(wk: number, h: number, cursor: number, f: Formatter): number {
  const cm = cxOf(f).comments;
  let anchor = cursor;
  if (wk >= 0) {
    if (wk === WK_EXPR) anchor = exprEnd(h);
    else {
      forHeadSpan(h);
      anchor = SP[1] | 0;
    }
    fmtForHeadNodeWithoutTrailingComments(wk, h, f);
  }
  // A line comment breaks the group of the head, so a line break follows the `;`.
  writeTrailingCommentsBefore(anchor, 59 /* ; */, f);
  f.token(SEMI);
  const next = cm.positionAfterCharacter(anchor, 59);
  cm.endOfLineCommentsAfter(next);
  formatTrailingCommentsRange(cm.from, cm.to, f);
  return next;
}

/** `FormatNodeWithoutTrailingComments(&node)` for the node of a slot: an expression, or (`WK_STMT`) the init of a `for`. */
function fmtForHeadNodeWithoutTrailingComments(wk: number, h: number, f: Formatter): void {
  if (wk === WK_EXPR) fmtNodeWithoutTrailingComments(WK_EXPR, h, f);
  else if (stmtTag(h) === STMT_EXPR) fmtNodeWithoutTrailingComments(WK_EXPR, stmtExprExpr(h), f);
  else fmtNodeWithoutTrailingComments(WK_STMT, h, f);
}

/**
 * See `comments_stay_between_head_and_body`: what is in the parentheses of a `for` that has comments before its body. Each stays on its side of
 * the two `;` and of the `)`.
 */
function writeForHeadWithCommentsInPlace(statement: number, init: number, test: number, update: number, body: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  const isEmpty = init < 0 && test < 0 && update < 0;
  stmtSpan(statement);
  let cursor = cm.positionAfterCharacter(SP[0] | 0, 40 /* ( */);
  cursor = writeForHeadSlot(init >= 0 ? WK_STMT : -1, init, cursor, f);
  if (!isEmpty) f.softLineBreakOrSpace();
  cursor = writeForHeadSlot(test >= 0 ? WK_EXPR : -1, test, cursor, f);
  if (update < 0) {
    writeTrailingCommentsBefore(cursor, 41 /* ) */, f);
    return;
  }
  f.softLineBreakOrSpace();
  fmtNodeWithoutTrailingComments(WK_EXPR, update, f);
  cm.commentsBefore(headEnd(HEAD_BEFORE, body, f));
  formatTrailingCommentsRange(cm.from, cm.to, f);
}

export function writeForStatement(statement: number, init: number /* -1: none */, test: number /* -1: none */, update: number /* -1: none */, body: number, f: Formatter): void {
  const cx = cxOf(f);
  if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f)) {
    stmtSpan(body);
    if (cx.comments.hasCommentBefore(SP[0] | 0)) {
      f.startGroup();
      f.token(KW_FOR_PAREN);
      f.startGroup();
      f.startSoftBlockIndent();
      writeForHeadWithCommentsInPlace(statement, init, test, update, body, f);
      f.endSoftBlockIndent();
      f.endGroup();
      f.token(RPAREN);
      fmtStatementBody(body, false, f);
      f.endGroup();
      return;
    }
  }
  if (init < 0 && test < 0 && update < 0) {
    f.startGroup();
    f.token(KW_FOR);
    f.space();
    f.token(KW_FOR_EMPTY);
    fmtStatementBody(body, false, f);
    f.endGroup();
    return;
  }
  f.startGroup();
  f.token(KW_FOR);
  f.space();
  f.token(LPAREN);
  const previousLimit = beginInHead(HEAD_BEFORE, body, f);
  f.startGroup();
  f.startSoftBlockIndent();
  if (init >= 0) fmtForHead(init, f);
  f.token(SEMI);
  f.softLineBreakOrSpace();
  if (test >= 0) fmtExpr(test, f);
  f.token(SEMI);
  if (update >= 0) {
    f.softLineBreakOrSpace();
    fmtExpr(update, f);
  }
  f.endSoftBlockIndent();
  f.endGroup();
  endInHead(previousLimit, f);
  f.token(RPAREN);
  fmtStatementBody(body, false, f);
  f.endGroup();
}

// ───────────────────────────── comments between nodes ─────────────────────────────

/** The placements of the comments of the last call to `commentPlacements`: `COMMENT_PLACEMENT_*`, one per comment. */
export const PLACEMENTS = new I32Vec(16);

/**
 * What Prettier's `attachComments` does with the comments `[from, to)`: all the comments between a node and the next one, which starts at
 * `followingStart`. Of the handlers, only the one for type cast comments is heeded. The placements are in `PLACEMENTS[0 .. to - from)`.
 */
export function commentPlacements(from: number, to: number, followingStart: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const src = cx.src;
  const out = PLACEMENTS;
  out.len = 0;
  const n = to - from;

  // A comment behind one that starts the line counts as starting it.
  let previousStartsLine: boolean = false;
  let previous = -1;
  for (let k = 0; k < n; k++) {
    const i = (from + k) | 0;
    const startsLine: boolean = cm.precededByNewline(i) || (previous >= 0 && previousStartsLine && src.allBytes(cm.spanEnd[previous] | 0, cm.spanStart[i] | 0, BT_SPACE_TAB));
    out.push(startsLine ? COMMENT_PLACEMENT_OWN_LINE : COMMENT_PLACEMENT_BEFORE_TOKEN);
    previous = i;
    previousStartsLine = startsLine;
  }

  // The same for the end of the line.
  let endsLine = false;
  let nextStart = followingStart;
  let gapEnd = followingStart;
  for (let k = n - 1; k >= 0; k--) {
    const i = (from + k) | 0;
    endsLine = cm.followedByNewline(i) || (endsLine && src.allBytes(cm.spanEnd[i] | 0, nextStart, BT_SPACE_TAB));
    nextStart = cm.spanStart[i] | 0;
    if ((out.data[k] | 0) === COMMENT_PLACEMENT_OWN_LINE) continue;
    if (endsLine) {
      // Prettier's `handleClosureTypeCastComments`
      out.data[k] = cm.isTypeCastComment(i) ? COMMENT_PLACEMENT_BEFORE_NODE : COMMENT_PLACEMENT_END_OF_LINE;
      continue;
    }
    // The parentheses of a type cast are a node, which starts right behind the comment.
    const isBeforeCast = cm.isTypeCastComment(i) && src.nextNonWhitespaceByteIs(cm.spanEnd[i] | 0, 40 /* ( */);
    let gap = -1;
    if (gapEnd >= 0 && (isBeforeCast || src.allBytes(cm.spanEnd[i] | 0, gapEnd, BT_WS_OPEN_PAREN))) gap = gapEnd;
    if (gap < 0 && isBeforeCast) gap = 0;
    gapEnd = gap >= 0 ? cm.spanStart[i] | 0 : -1;
    if (gapEnd >= 0) out.data[k] = COMMENT_PLACEMENT_BEFORE_NODE;
  }
}

/** `left in right`, `left of right`. `keyword`: a token. */
function writeForInOrOfHead(left: number, keyword: number, right: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    fmtForHead(left, f);
    f.space();
    f.token(keyword);
    f.space();
    fmtExpr(right, f);
    return;
  }
  const cm = cx.comments;
  stmtSpan(left);
  const previousLimit = cm.limitCommentsUpTo(SP[1] | 0);
  fmtForHead(left, f);
  cm.restoreViewLimit(previousLimit);

  // A comment that leads `right` can be before one that trails `left`.
  const rightStart = exprStart(right);
  cm.commentsBefore(rightStart);
  const from = cm.from;
  const to = cm.to;
  commentPlacements(from, to, rightStart, f);
  const n = to - from;
  const placements = PLACEMENTS.data;

  let trailingCount = 0;
  while (trailingCount < n && !commentPlacementLeads(placements[trailingCount] | 0)) trailingCount = (trailingCount + 1) | 0;
  let restAllLead = true;
  for (let k = trailingCount; k < n; k++) {
    if (!commentPlacementLeads(placements[k] | 0)) {
      restAllLead = false;
      break;
    }
  }
  if (restAllLead) {
    formatTrailingCommentsRange(from, (from + trailingCount) | 0, f);
    f.space();
    f.token(keyword);
    f.space();
    fmtExpr(right, f);
    return;
  }
  for (let k = 0; k < n; k++) {
    if (!commentPlacementLeads(PLACEMENTS.data[k] | 0)) formatTrailingCommentsRange((from + k) | 0, (from + k + 1) | 0, f);
  }
  f.space();
  f.token(keyword);
  f.space();
  for (let k = 0; k < n; k++) {
    if (commentPlacementLeads(PLACEMENTS.data[k] | 0)) formatLeadingCommentsRange((from + k) | 0, (from + k + 1) | 0, f);
  }
  fmtExpr(right, f);
}

export function writeForInStatement(statement: number, left: number, right: number, body: number, f: Formatter): void {
  void statement;
  f.startGroup();
  f.token(KW_FOR);
  f.space();
  f.token(LPAREN);
  const previousLimit = beginInHead(HEAD_BEFORE, body, f);
  writeForInOrOfHead(left, KW_IN, right, f);
  endInHead(previousLimit, f);
  writeBoundaryBeforeParenthesis(f);
  f.token(RPAREN);
  fmtStatementBody(body, false, f);
  f.endGroup();
}

/**
 * See `comments_stay_between_head_and_body`: a line comment in the head of a `for (a in b)`, which does not break, is written before the `)`. In
 * Prettier it comes out behind the `{`.
 */
function writeBoundaryBeforeParenthesis(f: Formatter): void {
  if (!cxOf(f).isQuiet && commentsStayBetweenHeadAndBody(f)) f.lineSuffixBoundary();
}

export function writeForOfStatement(statement: number, left: number, right: number, body: number, isAwait: boolean, f: Formatter): void {
  void statement;
  f.startGroup();
  f.token(KW_FOR);
  if (isAwait) {
    f.space();
    f.token(KW_AWAIT);
  }
  f.space();
  f.token(LPAREN);
  const previousLimit = beginInHead(HEAD_BEFORE, body, f);
  writeForInOrOfHead(left, KW_OF, right, f);
  endInHead(previousLimit, f);
  writeBoundaryBeforeParenthesis(f);
  f.token(RPAREN);
  fmtStatementBody(body, false, f);
  f.endGroup();
}

export function writeIfStatement(statement: number, test: number, consequent: number, alternate: number /* -1: none */, f: Formatter): void {
  void statement;
  const cx = cxOf(f);
  const cm = cx.comments;
  f.startGroup();
  f.token(KW_IF_PAREN);
  writeCondition(test, HEAD_BEFORE, consequent, f);
  f.token(RPAREN);
  fmtStatementBody(consequent, false, f);
  f.endGroup();
  if (alternate < 0) return;

  const isConsequentBlock = stmtIsBlock(consequent);
  const isElseIf = stmtTag(alternate) === STMT_IF;
  if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f)) {
    commentsBeforeElse(consequent, alternate, f);
    if (writeCommentsBetweenBlocks(cm.from, cm.to, f)) {
      if (isConsequentBlock) f.space();
      else f.hardLineBreak();
    }
    f.token(KW_ELSE);
    f.lineSuffixBoundary();
    f.startGroup();
    fmtStatementBody(alternate, isElseIf, f);
    f.endGroup();
    return;
  }
  if (!isConsequentBlock) f.hardLineBreak();
  let count = 0;
  let from = 0;
  if (!cx.isQuiet) {
    count = commentsBeforeElse(consequent, alternate, f);
    from = cm.from;
  }
  if (count > 0) {
    const last = (from + count - 1) | 0;
    const lines = linesBefore(cm.spanStart[from] | 0, cm.spanEnd[from] | 0, f);
    if (lines === 0) f.token(SPACE_TOKEN);
    else if (lines === 1) {
      if (isConsequentBlock) f.hardLineBreak();
    } else f.emptyLine();
    formatDanglingCommentsRange(from, (from + count) | 0, DANGLING_NONE, f);
    if (cm.followedByNewline(last)) f.hardLineBreak();
    else f.space();
  } else if (isConsequentBlock) {
    f.space();
  }

  f.token(KW_ELSE);
  f.startGroup();
  fmtStatementBody(alternate, isElseIf, f);
  f.endGroup();
}

function writeJump(keyword: number, statement: number, f: Formatter): void {
  f.token(keyword);
  const label = stmtLabel(statement);
  if (label >= 0) {
    f.space();
    identifier(label, stmtLabelPos(statement), stmtAsAstNodes(statement), f);
  }
  optionalSemicolon(f);
}

export function writeContinueStatement(statement: number, f: Formatter): void {
  writeJump(KW_CONTINUE, statement, f);
}

export function writeBreakStatement(statement: number, f: Formatter): void {
  writeJump(KW_BREAK, statement, f);
}

export function writeLabeledStatement(statement: number, body: number, f: Formatter): void {
  const label = stmtLabel(statement);
  if (label < 0) return;
  const cx = cxOf(f);
  const cm = cx.comments;
  const labelPos = stmtLabelPos(statement);
  identSpan(label, labelPos);
  const labelStart = SP[0] | 0;
  const labelEnd = SP[1] | 0;
  stmtSpan(body);
  const bodyStart = SP[0] | 0;
  const isEmpty = stmtTag(body) === STMT_EMPTY;
  if (!cm.hasCommentBefore(bodyStart)) {
    f.sourceText(labelStart, labelEnd);
    f.token(COLON_TOKEN);
    f.maybeSpace(!isEmpty);
    fmtStmt(body, f);
    return;
  }
  if (commentsStayBetweenHeadAndBody(f)) {
    f.sourceText(labelStart, labelEnd);
    const followsLineComment = writeTrailingCommentsBefore(labelEnd, 58 /* : */, f);
    f.token(COLON_TOKEN);
    if (followsLineComment) f.hardLineBreak();
    if (isEmpty) {
      fmtStatementBody(body, false, f);
      return;
    }
    writeHeadBodySeparator(bodyStart, f);
    fmtStmt(body, f);
    return;
  }

  // Prettier's `handleLabeledStatementComments`: a comment that starts or ends its line goes before the label.
  cm.commentsBefore(bodyStart);
  const from = cm.from;
  const to = cm.to;
  commentPlacements(from, to, bodyStart, f);
  const n = to - from;
  let hasBeforeNode = false;
  for (let k = 0; k < n; k++) {
    const p = PLACEMENTS.data[k] | 0;
    if (p === COMMENT_PLACEMENT_OWN_LINE || p === COMMENT_PLACEMENT_END_OF_LINE) {
      if (cm.isSuppressionComment((from + k) | 0)) {
        stmtSpan(statement);
        const start = SP[0] | 0;
        const end = cm.withoutSemicolon(start, SP[1] | 0);
        writeSuppressedNode(start, end, f);
        if (endsBeforeSemicolon(statement)) optionalSemicolon(f);
        return;
      }
    } else if (p === COMMENT_PLACEMENT_BEFORE_NODE) hasBeforeNode = true;
  }
  for (let k = 0; k < n; k++) {
    const p = PLACEMENTS.data[k] | 0;
    if (p === COMMENT_PLACEMENT_OWN_LINE || p === COMMENT_PLACEMENT_END_OF_LINE) formatLeadingCommentsRange((from + k) | 0, (from + k + 1) | 0, f);
  }
  f.sourceText(labelStart, labelEnd);
  for (let k = 0; k < n; k++) {
    if ((PLACEMENTS.data[k] | 0) === COMMENT_PLACEMENT_BEFORE_TOKEN) formatTrailingCommentsRange((from + k) | 0, (from + k + 1) | 0, f);
  }
  f.token(COLON_TOKEN);
  f.maybeSpace(!isEmpty || hasBeforeNode);
  for (let k = 0; k < n; k++) {
    if ((PLACEMENTS.data[k] | 0) === COMMENT_PLACEMENT_BEFORE_NODE) formatLeadingCommentsRange((from + k) | 0, (from + k + 1) | 0, f);
  }
  fmtStmt(body, f);
}
