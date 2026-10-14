// Port of vendor/bun/src/sema/parser/parser/expr.rs: expressions (typescript-go's parser.go: parseExpression ...
// parseNewExpressionOrNewDotTarget, parseObjectLiteralExpression, parsePropertyName, ...). See mod.ts for the conventions.
//
// Not ported (TODO notes in place): recovery (`recovers()`), oxc, Flow and JSDoc branches; `specifier_uses` (the checker's list
// of `import("m")` / `require("m")` specifiers: HIR has no table for it).
import {
  BIN_ADD,
  BIN_AND,
  BIN_BIT_AND,
  BIN_BIT_OR,
  BIN_BIT_XOR,
  BIN_COMMA,
  BIN_DIV,
  BIN_EQ_EQ,
  BIN_EQ_EQ_EQ,
  BIN_GE,
  BIN_GT,
  BIN_IN,
  BIN_INSTANCEOF,
  BIN_LE,
  BIN_LT,
  BIN_MUL,
  BIN_NOT_EQ,
  BIN_NOT_EQ_EQ,
  BIN_NULLISH,
  BIN_OR,
  BIN_POW,
  BIN_REM,
  BIN_SHL,
  BIN_SHR,
  BIN_SUB,
  BIN_USHR,
  CHAIN_CONTINUE,
  CHAIN_NO,
  CHAIN_START,
  DK_GRAMMAR,
  EXPR_AWAIT,
  EXPR_SPREAD,
  EXPR_YIELD,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_BINARY,
  EXPR_DOT,
  EXPR_FN,
  EXPR_IDENT,
  EXPR_INSTANTIATION,
  EXPR_NON_NULL,
  EXPR_NUMBER,
  EXPR_SATISFIES,
  EXPR_STRING,
  EXPR_UNARY,
  EXPR_ASSIGN,
  EXPR_CALL,
  EXPR_COND,
  EXPR_INDEX,
  EXPR_TAGGED_TEMPLATE,
  FLAG_ASYNC,
  FLAG_GENERATOR,
  FN_ARROW,
  FN_GETTER,
  FN_METHOD,
  FN_SETTER,
  INCOMPLETE_TEMPLATE,
  MODK_DECORATOR,
  NK_COMPUTED_NUMBER,
  NK_COMPUTED_STRING,
  NK_IDENTIFIER,
  NK_NUMERIC_LITERAL,
  NK_STRING_LITERAL,
  NONE,
  PK_COMPUTED,
  PK_NAME,
  PK_NONE,
  PK_PRIVATE,
  PROP_GETTER,
  PROP_INIT,
  PROP_METHOD,
  PROP_SETTER,
  PROP_SHORTHAND,
  PROP_SPREAD,
  RARE_DEFAULT_IN_OBJECT,
  RARE_DELETES_A_NAME,
  RARE_NEW_TARGET,
  RARE_ODD_PRIVATE_NAME,
  RARE_ODD_TARGET,
  UN_BIT_NOT,
  UN_DELETE,
  UN_MINUS,
  UN_NOT,
  UN_PLUS,
  UN_POST_DEC,
  UN_POST_INC,
  UN_PRE_DEC,
  UN_PRE_INC,
  UN_TYPEOF,
  UN_VOID,
  hir,
  pushExprArray,
  pushExprAs,
  pushExprAsConst,
  pushExprAssign,
  pushExprAwait,
  pushExprBigInt,
  pushExprBinary,
  pushExprCall,
  pushExprCond,
  pushExprDot,
  pushExprFalse,
  pushExprFn,
  pushExprIdent,
  pushExprImportCall,
  pushExprImportMeta,
  pushExprIndex,
  pushExprInstantiation,
  pushExprMissing,
  pushExprNew,
  pushExprNewTarget,
  pushExprNonNull,
  pushExprNull,
  pushExprNumber,
  pushExprObject,
  pushExprPrivateIdentifier,
  pushExprRegex,
  pushExprSatisfies,
  pushExprSpread,
  pushExprString,
  pushExprSuper,
  pushExprTaggedTemplate,
  pushExprTemplate,
  pushExprThis,
  pushExprTrue,
  pushExprUnary,
  pushExprYield,
} from "../../hir.ts";
import { A_empty, A_require, ATOM_NONE } from "../../atom.ts";
import {
  T_AMPERSAND,
  T_AMPERSAND_AMPERSAND,
  T_AMPERSAND_AMPERSAND_EQUALS,
  T_AMPERSAND_EQUALS,
  T_ASTERISK,
  T_ASTERISK_ASTERISK,
  T_ASTERISK_ASTERISK_EQUALS,
  T_ASTERISK_EQUALS,
  T_AS,
  T_AT,
  T_ASYNC,
  T_AWAIT,
  T_BAR,
  T_BAR_BAR,
  T_BAR_BAR_EQUALS,
  T_BAR_EQUALS,
  T_BIG_INT,
  T_CARET,
  T_CARET_EQUALS,
  T_CLASS,
  T_CLOSE_BRACE,
  T_CLOSE_BRACKET,
  T_CLOSE_PAREN,
  T_COLON,
  T_COMMA,
  T_CONST,
  T_DELETE,
  T_DOT,
  T_DOT_DOT_DOT,
  T_EQUALS,
  T_EQUALS_EQUALS,
  T_EQUALS_EQUALS_EQUALS,
  T_EQUALS_GREATER_THAN,
  T_EXCLAMATION,
  T_EXCLAMATION_EQUALS,
  T_EXCLAMATION_EQUALS_EQUALS,
  T_FALSE,
  T_FUNCTION,
  T_GET,
  T_GREATER_THAN,
  T_GREATER_THAN_EQUALS,
  T_GREATER_THAN_GREATER_THAN,
  T_GREATER_THAN_GREATER_THAN_EQUALS,
  T_GREATER_THAN_GREATER_THAN_GREATER_THAN,
  T_GREATER_THAN_GREATER_THAN_GREATER_THAN_EQUALS,
  T_IDENTIFIER,
  T_IMPORT,
  T_IN,
  T_INSTANCE_OF,
  T_LESS_THAN,
  T_LESS_THAN_EQUALS,
  T_LESS_THAN_LESS_THAN,
  T_LESS_THAN_LESS_THAN_EQUALS,
  T_MINUS,
  T_MINUS_EQUALS,
  T_MINUS_MINUS,
  T_NEW,
  T_NO_SUBSTITUTION_TEMPLATE,
  T_NULL,
  T_NUMBER,
  T_OPEN_BRACE,
  T_OPEN_BRACKET,
  T_OPEN_PAREN,
  T_PERCENT,
  T_PERCENT_EQUALS,
  T_PLUS,
  T_PLUS_EQUALS,
  T_PLUS_PLUS,
  T_PRIVATE_IDENTIFIER,
  T_QUESTION,
  T_QUESTION_DOT,
  T_QUESTION_QUESTION,
  T_QUESTION_QUESTION_EQUALS,
  T_SATISFIES,
  T_SET,
  T_SLASH,
  T_SLASH_EQUALS,
  T_STRING,
  T_SUPER,
  T_TEMPLATE_HEAD,
  T_TEMPLATE_MIDDLE,
  T_THIS,
  T_TILDE,
  T_TRUE,
  T_TYPE_OF,
  T_VOID,
  T_YIELD,
  T_COUNT,
  canFollowMemberExpression,
  endsExpression,
  isAssignmentOperator,
  isIdentifierOrKeyword,
  isModifier,
  PRECEDENCE,
} from "../token.ts";
import {
  CTX_AWAIT,
  CTX_DECORATOR,
  CTX_DISALLOW_IN,
  CTX_TOP_LEVEL,
  CTX_TYPE,
  CTX_YIELD,
  LK_ARGUMENT_EXPRESSIONS,
  LK_ARRAY_LITERAL_MEMBERS,
  LK_OBJECT_LITERAL_MEMBERS,
  MODS_DECLARATION,
  eat,
  enterContext,
  enterDepth,
  enterList,
  expect,
  expectMatching,
  fail,
  failUnlessRecovering,
  flag,
  identifierName,
  isIdentifier,
  isIdentifierInContext,
  isInList,
  leaveDepth,
  leaveList,
  lx,
  missingExpression,
  missingIdentifier,
  next,
  nextAfterName,
  noteIdentifier,
  numberName,
  p,
  peek,
  refuse,
  report,
  s,
  takeAsName,
  takeIds,
  takeList,
  tryParseBegin,
  tryParseEnd,
  names,
  lookAheadEnd,
  errorAndGoOn,
  error,
  errorAtToken,
  expected,
} from "./mod.ts";
import { isAtElement, goesOnWithoutComma } from "./recover.ts";
import { R_REPORTED, R_UNSUPPORTED } from "../lib.ts";
import { jsError, jsErrorAtType, checkJsMethodOfObject } from "./js_syntax.ts";
import {
  functionExpression,
  simpleArrowFunction,
  tryArrowFunction,
  functionRest,
} from "./func.ts";
import { classExpression, decoratedExpression } from "./class.ts";
import { isLiteralPropertyName, modifiers, takeModifiers } from "./stmt.ts";
import { ty, typeArgumentList, typeArgsErrorEnd, typeArgsErrorStart } from "./ty.ts";
import { NO_EXPR, flowBracesAfterExpression, flowType, flowTypeArgumentsInExpression, flowTypeCast } from "./flow.ts";
import { jsxElementOrFragment, jsxElements } from "./jsx.ts";
import { errorArgs } from "./mod.ts";
import { tokenText } from "../token.ts";
import { flagArgs, atomText, tokenSrcText, lookAheadParsingBegin, lookAheadParsingEnd } from "./mod.ts";
import { srcText, errorAtTokenArgs } from "./mod.ts";
import { EXPR_MISSING } from "../../hir.ts";
import { parenthesizedArrowFunction, TS_TRUE } from "./func.ts";
import { skipTrivia } from "../../check/spans.ts";
import { DK_PARSE } from "../../hir.ts";

// ───────────────────────────── operator tables ─────────────────────────────

/** `binary_operator`: the BinOp of a binary operator token (`BIN_COMMA` for a token that is none). */
const BINARY_OP = new Uint8Array(T_COUNT);
BINARY_OP.fill(BIN_COMMA);
BINARY_OP[T_PLUS] = BIN_ADD;
BINARY_OP[T_MINUS] = BIN_SUB;
BINARY_OP[T_ASTERISK] = BIN_MUL;
BINARY_OP[T_SLASH] = BIN_DIV;
BINARY_OP[T_PERCENT] = BIN_REM;
BINARY_OP[T_ASTERISK_ASTERISK] = BIN_POW;
BINARY_OP[T_LESS_THAN_LESS_THAN] = BIN_SHL;
BINARY_OP[T_GREATER_THAN_GREATER_THAN] = BIN_SHR;
BINARY_OP[T_GREATER_THAN_GREATER_THAN_GREATER_THAN] = BIN_USHR;
BINARY_OP[T_AMPERSAND] = BIN_BIT_AND;
BINARY_OP[T_BAR] = BIN_BIT_OR;
BINARY_OP[T_CARET] = BIN_BIT_XOR;
BINARY_OP[T_LESS_THAN] = BIN_LT;
BINARY_OP[T_LESS_THAN_EQUALS] = BIN_LE;
BINARY_OP[T_GREATER_THAN] = BIN_GT;
BINARY_OP[T_GREATER_THAN_EQUALS] = BIN_GE;
BINARY_OP[T_EQUALS_EQUALS] = BIN_EQ_EQ;
BINARY_OP[T_EXCLAMATION_EQUALS] = BIN_NOT_EQ;
BINARY_OP[T_EQUALS_EQUALS_EQUALS] = BIN_EQ_EQ_EQ;
BINARY_OP[T_EXCLAMATION_EQUALS_EQUALS] = BIN_NOT_EQ_EQ;
BINARY_OP[T_IN] = BIN_IN;
BINARY_OP[T_INSTANCE_OF] = BIN_INSTANCEOF;
BINARY_OP[T_AMPERSAND_AMPERSAND] = BIN_AND;
BINARY_OP[T_BAR_BAR] = BIN_OR;
BINARY_OP[T_QUESTION_QUESTION] = BIN_NULLISH;

/** `assignment_operator`: 0 for `=`, `BIN_x + 1` for a compound assignment (the encoding of `Assign.op`). */
const ASSIGN_OP = new Uint8Array(T_COUNT);
ASSIGN_OP[T_PLUS_EQUALS] = BIN_ADD + 1;
ASSIGN_OP[T_MINUS_EQUALS] = BIN_SUB + 1;
ASSIGN_OP[T_ASTERISK_EQUALS] = BIN_MUL + 1;
ASSIGN_OP[T_ASTERISK_ASTERISK_EQUALS] = BIN_POW + 1;
ASSIGN_OP[T_SLASH_EQUALS] = BIN_DIV + 1;
ASSIGN_OP[T_PERCENT_EQUALS] = BIN_REM + 1;
ASSIGN_OP[T_LESS_THAN_LESS_THAN_EQUALS] = BIN_SHL + 1;
ASSIGN_OP[T_GREATER_THAN_GREATER_THAN_EQUALS] = BIN_SHR + 1;
ASSIGN_OP[T_GREATER_THAN_GREATER_THAN_GREATER_THAN_EQUALS] = BIN_USHR + 1;
ASSIGN_OP[T_AMPERSAND_EQUALS] = BIN_BIT_AND + 1;
ASSIGN_OP[T_BAR_EQUALS] = BIN_BIT_OR + 1;
ASSIGN_OP[T_CARET_EQUALS] = BIN_BIT_XOR + 1;
ASSIGN_OP[T_BAR_BAR_EQUALS] = BIN_OR + 1;
ASSIGN_OP[T_AMPERSAND_AMPERSAND_EQUALS] = BIN_AND + 1;
ASSIGN_OP[T_QUESTION_QUESTION_EQUALS] = BIN_NULLISH + 1;

const PREC_POW = PRECEDENCE[T_ASTERISK_ASTERISK] | 0;
const PREC_IN = PRECEDENCE[T_IN] | 0;

// ───────────────────────────── small helpers ─────────────────────────────

/** Whether the text of the current token (source bytes) is the ASCII `text`. */
function tokenTextIs(text: string): boolean {
  const n = text.length;
  const lx$ = lx;
  if (lx$.end - lx$.start !== n) return false;
  const src = lx$.src;
  let at = lx$.start | 0;
  for (let i = 0; i < n; i++) {
    if ((src[at] | 0) !== text.charCodeAt(i)) return false;
    at = (at + 1) | 0;
  }
  return true;
}

/** Whether `e` (which was just parsed) is in parentheses: the last `parens` row is its. */
export function isParenthesized(e: number): boolean {
  const hir$ = hir;
  const n = hir$.nParens;
  return n > 0 && (hir$.parenExpr[n - 1] | 0) === e;
}

/** `Expr::kind` of an id that may be NONE: -1 for none. */
function tagOf(e: number): number {
  const hir$ = hir;
  return e >= 0 && e < hir$.nExprs ? hir$.exprTag[e] | 0 : -1;
}

/** An expression that ends with the previous token: not a function, the code is inline everywhere. */

/** `await` is read as a keyword. */
export function noteAwait(): void {
  const p$ = p;
  if ((p$.context & CTX_TOP_LEVEL) !== 0) {
    p$.hasTopLevelAwait = true;
    p$.hasPlainTopLevelAwait = true;
    p$.hasAwaitInStatement = true;
  }
}

/** `allowInAnd(parseExpression)` */
export function expressionAllowingIn(): number {
  const saved = enterContext(0, CTX_DISALLOW_IN);
  const expression_ = expression();
  p.context = saved;
  return expression_;
}

/** `allowInAnd(parseAssignmentExpressionOrHigher)` */
export function assignmentExpressionAllowingIn(): number {
  const saved = enterContext(0, CTX_DISALLOW_IN);
  const expression_ = assignmentExpression();
  p.context = saved;
  return expression_;
}

/**
 * `createMissingIdentifier`: if `operand` is one at the token, as in `(a, )` and `( , a)`, it is at the end of the token before, which
 * is returned (-1: it is not).
 */
function placeMissingOperand(operand: number): number {
  const hir$ = hir;
  if (operand < 0 || operand >= hir$.nExprs) return -1;
  const lx$ = lx;
  if ((hir$.exprTag[operand] | 0) !== EXPR_MISSING || (hir$.exprPos[operand] | 0) !== (lx$.start | 0)) return -1;
  const after = lx$.fullStart | 0;
  hir$.exprPos[operand] = after;
  return after;
}

/** `parseExpression` */
export function expression(): number {
  return expressionMaybeInParentheses(false);
}

/** `parseExpression`. `isInParentheses`: for `parseParenthesizedExpression`. */
function expressionMaybeInParentheses(isInParentheses: boolean): number {
  const saved = enterContext(0, CTX_DECORATOR);
  const lx$ = lx;
  let start = lx$.start | 0;
  let expr = assignmentExpression();
  // `()` stays at its `)`.
  const p$ = p;
  if (isInParentheses && p$.recovers && lx$.token !== T_CLOSE_PAREN) {
    const placed = placeMissingOperand(expr);
    if (placed >= 0) start = placed;
  }
  while (lx$.token === T_COMMA) {
    next();
    const right = assignmentExpression();
    if (isInParentheses && p$.recovers) placeMissingOperand(right);
    expr = pushExprBinary(start, lx$.fullStart, expr, right, BIN_COMMA);
  }
  p$.context = saved;
  return expr;
}

export function assignmentExpression(): number {
  return assignmentExpressionOrHigher(true);
}

/** `IsLeftHandSideExpression` for `e`, which was just parsed and stands before an assignment operator. Sets `rare::ODD_TARGET` unless it is a plain name or member. */
function isLeftHandSide(e: number): boolean {
  const hir$ = hir;
  if (e < 0 || e >= hir$.nExprs) return false;
  if (isPlainTarget_(e)) return true;
  hir$.rareSyntax = hir$.rareSyntax | RARE_ODD_TARGET;
  const tag = hir$.exprTag[e] | 0;
  switch (tag) {
    case EXPR_FN:
      return (hir$.fnKind[hir$.exprA[e] | 0] | 0) !== FN_ARROW || isParenthesized(e);
    // oxc converts these into a target, and reports what can't be one.
    case EXPR_UNARY:
    case EXPR_BINARY:
    case EXPR_AWAIT:
    case EXPR_AS:
    case EXPR_SATISFIES:
    case EXPR_AS_CONST:
      return isParenthesized(e); // TODO(oxc): `|| dialect.oxc`
    case EXPR_ASSIGN:
    case EXPR_COND:
    case EXPR_SPREAD:
    case EXPR_YIELD:
      return isParenthesized(e);
    default:
      return true;
  }
}

function isPlainTarget_(e: number): boolean {
  const hir$ = hir;
  const t = hir$.exprTag[e] | 0;
  if (t === EXPR_IDENT) return true;
  if (t === EXPR_DOT || t === EXPR_INDEX) return (hir$.exprAux[e] | 0) === CHAIN_NO;
  return false;
}

/** Sets `rare::ODD_TARGET` unless `target` is a plain name or member. */
export function noteTarget(target: number): void {
  const hir$ = hir;
  if (!(target >= 0 && target < hir$.nExprs && isPlainTarget_(target))) {
    hir$.rareSyntax = hir$.rareSyntax | RARE_ODD_TARGET;
  }
}

/** `parseAssignmentExpressionOrHigher` */
export function assignmentExpressionOrHigher(allowReturnType: boolean): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  const full = lx$.fullStart | 0;
  // Most arguments, elements and initializers are a name or a literal and nothing more.
  const primary = nameOrLiteral();
  if (primary < 0) return assignmentExpressionInGeneral(allowReturnType);
  if (endsExpression(lx$.token)) return primary;
  if (!enterDepth()) return NONE;
  const operand = restOfOperand(start, primary);
  const expr = binaryExpressionRest(0, operand, start);
  const r = assignmentExpressionRest(expr, start, full, allowReturnType);
  leaveDepth();
  return r;
}

/** `parsePrimaryExpression` if the token is all of it: -1 if it is not. */
function nameOrLiteral(): number {
  const lx$ = lx;
  const t = lx$.token | 0;
  let e: number;
  if (t === T_IDENTIFIER) {
    const atom = noteIdentifier(lx$.atom, lx$.start);
    e = pushExprIdent(lx$.start, lx$.end, atom);
  } else if (t === T_STRING) {
    e = pushExprString(lx$.start, lx$.end, lx$.atom);
  } else if (t === T_NUMBER) {
    e = pushExprNumber(lx$.start, lx$.end, hir.pushNumber(lx$.number));
  } else if (t === T_THIS) {
    e = pushExprThis(lx$.start, lx$.end);
  } else if (t === T_TRUE) {
    e = pushExprTrue(lx$.start, lx$.end);
  } else if (t === T_FALSE) {
    e = pushExprFalse(lx$.start, lx$.end);
  } else if (t === T_NULL) {
    e = pushExprNull(lx$.start, lx$.end);
  } else {
    return -1;
  }
  lx$.next();
  return e;
}

function assignmentExpressionInGeneral(allowReturnType: boolean): number {
  if (!enterDepth()) return NONE;
  const lx$ = lx;
  const start = lx$.start | 0;
  const full = lx$.fullStart | 0;
  const t = lx$.token | 0;
  const p$ = p;
  if (t === T_OPEN_PAREN || t === T_LESS_THAN || t === T_ASYNC) {
    const arrow = tryArrowFunction(allowReturnType);
    if (arrow >= 0) {
      leaveDepth();
      return arrow;
    }
  } else if (t === T_EQUALS_GREATER_THAN && p$.recovers) {
    // `isParenthesizedArrowFunctionExpression`: "If we see a standalone => try to parse it as an arrow function expression as that's
    // likely what the user intended to write."
    const arrow = parenthesizedArrowFunction(TS_TRUE, allowReturnType);
    if (arrow >= 0) {
      leaveDepth();
      return arrow;
    }
  } else if (t === T_YIELD) {
    if ((p$.context & CTX_YIELD) !== 0) {
      const y = yieldExpression();
      leaveDepth();
      return y;
    }
    // `isYieldExpression`
    if (suspendsOutsideContext()) {
      const y = yieldExpression();
      leaveDepth();
      return y;
    }
  }
  const expr = binaryExpression(0);
  const r = assignmentExpressionRest(expr, start, full, allowReturnType);
  leaveDepth();
  return r;
}

/** What `parseAssignmentExpressionOrHigher` does after `parseBinaryExpressionOrHigher`. */
function assignmentExpressionRest(expr: number, start: number, full: number, allowReturnType: boolean): number {
  const lx$ = lx;
  const t = lx$.token | 0;
  if (endsExpression(t)) return expr;
  const hir$ = hir;
  if (t === T_EQUALS_GREATER_THAN) {
    // `parseSimpleArrowFunctionExpression`
    const last = hir$.nExprs - 1;
    if (expr === last && expr >= 0 && (hir$.exprTag[expr] | 0) === EXPR_IDENT && (hir$.exprPos[expr] | 0) === start) {
      const name = hir$.exprA[expr] | 0;
      const pos_ = hir$.exprPos[expr] | 0;
      const end = hir$.exprEnd[expr] | 0;
      hir$.nExprs = last;
      return simpleArrowFunction(name, pos_, end, full, false, pos_, allowReturnType);
    }
    failUnlessRecovering();
    return expr;
  }
  if (isAssignmentOperator(t)) return assignment(expr, start, allowReturnType);
  if (t === T_QUESTION) {
    // `parseConditionalExpressionRest`
    next();
    const saved = enterContext(0, CTX_DISALLOW_IN | CTX_DECORATOR);
    const yes = assignmentExpressionOrHigher(false);
    p.context = saved;
    let no: number;
    if (expect(T_COLON)) no = assignmentExpressionOrHigher(allowReturnType);
    else no = pushExprMissing(lx$.start, lx$.fullStart);
    return pushExprCond(start, lx$.fullStart, expr, yes, no);
  }
  return expr;
}

/** The same at an assignment operator. Out of line: every expression goes through the caller. */
function assignment(target: number, start: number, allowReturnType: boolean): number {
  const lx$ = lx;
  const t = lx$.token | 0;
  if (!isLeftHandSide(target)) {
    failUnlessRecovering();
    return target;
  }
  const p$ = p;
  if (tagOf(target) === EXPR_FN && !isParenthesized(target) && (!p$.recovers || p$.isEcmascript)) {
    report();
  }
  next();
  const value = assignmentExpressionOrHigher(allowReturnType);
  return pushExprAssign(start, lx$.fullStart, target, value, ASSIGN_OP[t] | 0);
}

/** `nextTokenIsIdentifierOrKeywordOrLiteralOnSameLine` */
function nextIsWordOrLiteralOnSameLine(): boolean {
  const lx$ = lx;
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  lx$.next();
  const t = lx$.token | 0;
  const r = !lx$.newlineBefore && (isIdentifierOrKeyword(t) || t === T_NUMBER || t === T_BIG_INT || t === T_STRING);
  lookAheadEnd(m, had);
  return r;
}

/**
 * At an `await` or a `yield` that could be a name here: it's still read as the keyword before a word or a literal.
 * TypeScript's checker reports that. (oxc: not ported.)
 */
function suspendsOutsideContext(): boolean {
  return !p.isEcmascript && nextIsWordOrLiteralOnSameLine();
}

/** `parseYieldExpression` */
function yieldExpression(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  next();
  let value = NONE;
  let star = 0;
  if (!lx$.newlineBefore && (lx$.token === T_ASTERISK || isStartOfExpression())) {
    star = eat(T_ASTERISK) ? 1 : 0;
    value = assignmentExpression();
  }
  const p$ = p;
  p$.suspensions = p$.suspensions + 1;
  return pushExprYield(start, lx$.fullStart, value, star);
}

/** `isBinaryOperator` */
function isBinaryOperator(): boolean {
  const lx$ = lx;
  if (lx$.token === T_IN && (p.context & CTX_DISALLOW_IN) !== 0) return false;
  return (PRECEDENCE[lx$.token] | 0) > 0;
}

/** `isStartOfLeftHandSideExpression` */
export function isStartOfLeftHandSideExpression(): boolean {
  switch (lx.token | 0) {
    case T_THIS:
    case T_SUPER:
    case T_NULL:
    case T_TRUE:
    case T_FALSE:
    case T_NUMBER:
    case T_BIG_INT:
    case T_STRING:
    case T_NO_SUBSTITUTION_TEMPLATE:
    case T_TEMPLATE_HEAD:
    case T_OPEN_PAREN:
    case T_OPEN_BRACKET:
    case T_OPEN_BRACE:
    case T_FUNCTION:
    case T_CLASS:
    case T_NEW:
    case T_SLASH:
    case T_SLASH_EQUALS:
    case T_IDENTIFIER:
      return true;
    case T_IMPORT: {
      const t = peek();
      return t === T_OPEN_PAREN || t === T_LESS_THAN || t === T_DOT;
    }
    default:
      return isIdentifier();
  }
}

/** `isStartOfExpression` */
export function isStartOfExpression(): boolean {
  if (isStartOfLeftHandSideExpression()) return true;
  switch (lx.token | 0) {
    case T_PLUS:
    case T_MINUS:
    case T_TILDE:
    case T_EXCLAMATION:
    case T_DELETE:
    case T_TYPE_OF:
    case T_VOID:
    case T_PLUS_PLUS:
    case T_MINUS_MINUS:
    case T_LESS_THAN:
    case T_AWAIT:
    case T_YIELD:
    case T_PRIVATE_IDENTIFIER:
    case T_AT:
      return true;
    // "Error tolerance. If we see the start of some binary operator, we consider that the start of an expression."
    default:
      return isBinaryOperator() || isIdentifier();
  }
}

/** `parseBinaryExpressionOrHigher` */
function binaryExpression(precedence: number): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  if (lx$.token === T_PRIVATE_IDENTIFIER && p.isEcmascript) privateNameBeforeIn(precedence);
  const left = unaryExpression();
  return binaryExpressionRest(precedence, left, start);
}

/** At a `#a` that is the first token of an operand, for acorn and Babel: it is the left side of `in` or nothing. */
function privateNameBeforeIn(precedence: number): void {
  const p$ = p;
  if (precedence < PREC_IN && (p$.context & CTX_DISALLOW_IN) === 0 && peek() === T_IN) {
    p$.privateNameBeforeIn = lx.start | 0;
  }
}

/** `parseBinaryExpressionRest` */
function binaryExpressionRest(precedence: number, left: number, start: number): number {
  // No operator is here, nor a `>` that one may start with.
  if ((PRECEDENCE[lx.token] | 0) === 0) return left;
  return binaryExpressionRestAtOperator(precedence, left, start);
}

function binaryExpressionRestAtOperator(precedence: number, left: number, start: number): number {
  // The right operand of `**` can have the same operator.
  if (!enterDepth()) return left;
  const r = binaryExpressionLoop(precedence, left, start);
  leaveDepth();
  return r;
}

function binaryExpressionLoop(precedence: number, left0: number, start: number): number {
  let left = left0;
  // Of the operator of `left`, if this loop has made it. `OperatorPrecedenceHighest` otherwise.
  let lastPrecedence = 255;
  const lx$ = lx;
  const p$ = p;
  for (;;) {
    // "We either have a binary operator here, or we're finished."
    if (lx$.token === T_GREATER_THAN) lx$.rescanGreaterThan();
    const t = lx$.token | 0;
    const newPrecedence = PRECEDENCE[t] | 0;
    // `**` is right associative.
    const consumes = t === T_ASTERISK_ASTERISK ? newPrecedence >= precedence : newPrecedence > precedence;
    if (!consumes) return left;
    if (t === T_IN && (p$.context & CTX_DISALLOW_IN) !== 0) return left;
    if (t === T_AS || t === T_SATISFIES) {
      // "Make sure we *do* perform ASI for constructs like this: var x = foo \n as (Bar)"
      if (lx$.newlineBefore) return left;
      next();
      if (t === T_AS && lx$.token === T_CONST && isAtConstAlone()) {
        jsError(lx$.start, lx$.end, 8016);
        constAssertionType();
        left = pushExprAsConst(start, lx$.fullStart, left);
      } else {
        const type = p$.isFlow ? flowType() : ty();
        if (p$.isJavascript) jsErrorAtType(type, t === T_AS ? 8016 : 8037);
        left = t === T_AS ? pushExprAs(start, lx$.fullStart, left, type) : pushExprSatisfies(start, lx$.fullStart, left, type);
      }
      // "Stop if the precedence of the next operator is too high": in `a + b as T * c` the `as T` could not be erased.
      if (lx$.token === T_GREATER_THAN) lx$.rescanGreaterThan();
      if ((PRECEDENCE[lx$.token] | 0) > lastPrecedence && !p$.isFlow) return left;
    } else if (t === T_QUESTION_QUESTION) {
      next();
      // `checkNullishCoalesceOperands` reports `a ?? b || c`, and who follows acorn or Babel looks for it in the tree.
      // Asked before the right side adds its parentheses.
      const looksForAMix = !p$.recovers;
      const isLeftAMix = looksForAMix && isLogicalAndOrOr(left);
      const right = binaryExpression(newPrecedence);
      if (isLeftAMix || (looksForAMix && isLogicalAndOrOr(right))) report();
      left = pushExprBinary(start, lx$.fullStart, left, right, BIN_NULLISH);
      lastPrecedence = newPrecedence;
    } else {
      next();
      const right = binaryExpression(newPrecedence);
      left = pushExprBinary(start, lx$.fullStart, left, right, BINARY_OP[t] | 0);
      lastPrecedence = newPrecedence;
    }
  }
}

/** `e` is `a || b` or `a && b`, not in parentheses: not an operand of `??`. */
function isLogicalAndOrOr(e: number): boolean {
  if (tagOf(e) !== EXPR_BINARY) return false;
  const hir$ = hir;
  const op = hir$.exprAux[e] | 0;
  if (op !== BIN_AND && op !== BIN_OR) return false;
  const n = hir$.nParens;
  if (n > 0 && (hir$.parenExpr[n - 1] | 0) === e) return false;
  if (n > 1 && (hir$.parenExpr[n - 2] | 0) === e) return false;
  return true;
}

/** `IsConstTypeReference`, at a `const` that is a type: without recovery it is true (see `constAssertionType`). */
function isAtConstAlone(): boolean {
  if (!p.recovers) return true;
  const lx$ = lx;
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  lx$.next();
  let r: boolean;
  switch (lx$.token) {
    case T_DOT:
      r = false;
      break;
    case T_OPEN_BRACKET:
      r = lx$.newlineBefore;
      break;
    case T_LESS_THAN:
      lx$.next();
      r = lx$.token === T_GREATER_THAN;
      break;
    default:
      r = true;
  }
  lookAheadEnd(m, had);
  return r;
}

/** The `const` of `e as const` and of `<const>e`. */
function constAssertionType(): void {
  next();
  // `const<>`
  const lx$ = lx;
  if (p.recovers && lx$.token === T_LESS_THAN) {
    next();
    next();
    return;
  }
  // `const` goes on as a type.
  const t = lx$.token | 0;
  if (((t === T_DOT || t === T_LESS_THAN || t === T_OPEN_BRACKET) && !lx$.newlineBefore) || t === T_DOT || t === T_LESS_THAN) {
    refuse(R_REPORTED);
  }
}

/** `parseUnaryExpressionOrHigher` */
export function unaryExpression(): number {
  const start = lx.start | 0;
  const primary = nameOrLiteral();
  if (primary >= 0) return restOfOperand(start, primary);
  return unaryExpressionInGeneral();
}

function unaryExpressionInGeneral(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  const t = lx$.token | 0;
  const p$ = p;
  switch (t) {
    case T_PLUS:
    case T_MINUS:
    case T_TILDE:
    case T_EXCLAMATION:
    case T_DELETE:
    case T_TYPE_OF:
    case T_VOID:
    case T_AWAIT:
      break;
    case T_LESS_THAN:
      if (!p$.isJsx) break;
      {
        const e = updateExpression();
        return restOfPower(start, e);
      }
    default: {
      const e = updateExpression();
      return restOfPower(start, e);
    }
  }
  const isAwaitName = t === T_AWAIT && !isAwaitExpression();
  const expr = simpleUnaryExpression();
  if (lx$.token === T_ASTERISK_ASTERISK) {
    if (isAwaitName && !p$.recovers) {
      return binaryExpressionRest(PREC_POW, expr, start);
    }
    unaryExpressionBeforePower(t, start);
  }
  return expr;
}

/** The end of `parseUnaryExpressionOrHigher`, at a `**` after what starts with an operator. */
function unaryExpressionBeforePower(operator: number, start: number): void {
  if (!p.recovers) {
    refuse(R_REPORTED);
    return;
  }
  const end = lx.fullStart | 0;
  if (operator === T_LESS_THAN) {
    error(17007, start, start === end ? -1 : end);
    return;
  }
  let text: string;
  if (operator === T_PLUS) text = "+";
  else if (operator === T_MINUS) text = "-";
  else if (operator === T_TILDE) text = "~";
  else if (operator === T_EXCLAMATION) text = "!";
  else text = tokenText(operator);
  errorArgs(17006, start, start === end ? -1 : end, [text]);
}

/** What `parseUnaryExpressionOrHigher` does after `parseUpdateExpression`. */
function restOfPower(start: number, base: number): number {
  if (lx.token === T_ASTERISK_ASTERISK) return binaryExpressionRest(PREC_POW, base, start);
  return base;
}

/** What `parseUnaryExpressionOrHigher` does after `parsePrimaryExpression`. */
function restOfOperand(start: number, primary: number): number {
  const operand = expressionRest(start, primary, true);
  const updated = restOfUpdate(start, operand);
  return restOfPower(start, updated);
}

/** `isAwaitExpression` */
function isAwaitExpression(): boolean {
  if ((p.context & CTX_AWAIT) !== 0) return true;
  // "here we are using similar heuristics as 'isYieldExpression'"
  return suspendsOutsideContext();
}

/** `parseSimpleUnaryExpression` */
export function simpleUnaryExpression(): number {
  if (!enterDepth()) return NONE;
  const r = simpleUnaryExpressionBody();
  leaveDepth();
  return r;
}

function simpleUnaryExpressionBody(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  const t = lx$.token | 0;
  let op: number;
  const p$ = p;
  switch (t) {
    case T_PLUS:
      op = UN_PLUS;
      break;
    case T_MINUS:
      op = UN_MINUS;
      break;
    case T_TILDE:
      op = UN_BIT_NOT;
      break;
    case T_EXCLAMATION:
      op = UN_NOT;
      break;
    case T_DELETE:
      op = UN_DELETE;
      break;
    case T_TYPE_OF:
      op = UN_TYPEOF;
      break;
    case T_VOID:
      op = UN_VOID;
      break;
    case T_LESS_THAN:
      if (!p$.isJsx) return typeAssertion();
      if (!p$.isEcmascript) return jsxElements(true);
      return updateExpression();
    case T_AWAIT: {
      if (!isAwaitExpression()) return updateExpression();
      // TODO(oxc): `is_await_a_name_to_oxc`
      const hadPlain = p$.hasPlainTopLevelAwait;
      noteAwait();
      // Outside the context it is a name, but before a word or a literal.
      if ((p$.context & CTX_TOP_LEVEL) !== 0 && !nextIsWordOrLiteralOnSameLine()) {
        p$.hasAwaitIdentifier = true;
        p$.hasPlainTopLevelAwait = hadPlain;
      }
      next();
      const operand = simpleUnaryExpression();
      p$.suspensions = p$.suspensions + 1;
      return pushExprAwait(start, lx$.fullStart, operand);
    }
    default:
      return updateExpression();
  }
  next();
  const operand = simpleUnaryExpression();
  const hir$ = hir;
  if (op === UN_DELETE) {
    const tag = tagOf(operand);
    if (tag === EXPR_IDENT) {
      hir$.rareSyntax = hir$.rareSyntax | RARE_DELETES_A_NAME;
    } else if (tag === EXPR_DOT) {
      if ((lx$.src[hir$.exprC[operand] | 0] | 0) === 35 /* '#' */) hir$.rareSyntax = hir$.rareSyntax | RARE_DELETES_A_NAME;
    } else if (tag === EXPR_AS || tag === EXPR_AS_CONST || tag === EXPR_SATISFIES || tag === EXPR_NON_NULL) {
      // oxc looks through them.
      hir$.rareSyntax = hir$.rareSyntax | RARE_DELETES_A_NAME;
    }
  }
  return pushExprUnary(start, lx$.fullStart, operand, op);
}

/** `parseTypeAssertion` */
function typeAssertion(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  expect(T_LESS_THAN);
  let type = NONE;
  let isConst = false;
  if (lx$.token === T_CONST && isAtConstAlone()) {
    constAssertionType();
    isConst = true;
  } else {
    type = ty();
  }
  expect(T_GREATER_THAN);
  const operand = simpleUnaryExpression();
  if (isConst) return pushExprAsConst(start, lx$.fullStart, operand);
  return pushExprAs(start, lx$.fullStart, operand, type);
}

/** `parseUpdateExpression` */
function updateExpression(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  const t = lx$.token | 0;
  if (t === T_PLUS_PLUS || t === T_MINUS_MINUS) return prefixUpdate();
  // For acorn an element is a primary expression.
  const p$ = p;
  if (t === T_LESS_THAN && p$.isJsx && !p$.isEcmascript) return jsxElementOrFragment();
  const operand = leftHandSideExpression();
  return restOfUpdate(start, operand);
}

/** `parseUpdateExpression`, at a `++` or a `--`. */
function prefixUpdate(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  const op = lx$.token === T_PLUS_PLUS ? UN_PRE_INC : UN_PRE_DEC;
  next();
  const operand = leftHandSideExpression();
  noteTarget(operand);
  return pushExprUnary(start, lx$.fullStart, operand, op);
}

/** What `parseUpdateExpression` does after `parseLeftHandSideExpressionOrHigher`. */
function restOfUpdate(start: number, operand: number): number {
  const lx$ = lx;
  const t = lx$.token | 0;
  if ((t === T_PLUS_PLUS || t === T_MINUS_MINUS) && !lx$.newlineBefore) return postfixUpdate(start, operand);
  return operand;
}

/** Out of line: every operand goes through the caller. */
function postfixUpdate(start: number, operand: number): number {
  const lx$ = lx;
  const op = lx$.token === T_PLUS_PLUS ? UN_POST_INC : UN_POST_DEC;
  next();
  noteTarget(operand);
  return pushExprUnary(start, lx$.fullStart, operand, op);
}

/** `parseDecoratorExpression` */
export function decoratorExpression(): number {
  const lx$ = lx;
  if (lx$.token === T_AWAIT && (p.context & CTX_AWAIT) !== 0) return awaitAsDecorator();
  // An element is no decorator.
  if (lx$.token === T_LESS_THAN) failUnlessRecovering();
  return leftHandSideExpression();
}

/** `parseDecoratorExpression`, at an `await` that is no name. */
function awaitAsDecorator(): number {
  const p$ = p;
  if (!p$.recovers) {
    refuse(R_REPORTED);
    return NONE;
  }
  // The context of the top level reaches the decorators of the parameters of a method.
  p$.hasTopLevelAwait = true;
  const start = lx.start | 0;
  const missing = missingExpression(1109);
  next();
  return expressionRest(start, missing, true);
}

/** `parseLeftHandSideExpressionOrHigher` */
export function leftHandSideExpression(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  let expr: number;
  const t = lx$.token | 0;
  if (t === T_IMPORT) {
    expr = importExpression();
  } else if (t === T_SUPER) {
    expr = pushExprSuper(lx$.start, lx$.end);
    next();
    const u = lx$.token | 0;
    if (u !== T_OPEN_PAREN && u !== T_DOT && u !== T_OPEN_BRACKET) expr = superWithoutAccess(start, expr);
  } else {
    expr = primaryExpression();
  }
  return expressionRest(start, expr, true);
}

/** What `parseSuperExpression` does after a `super` that neither `(`, `.` nor `[` follows. */
function superWithoutAccess(start: number, obj0: number): number {
  let obj = obj0;
  const p$ = p;
  if (!p$.recovers) {
    fail();
    return obj;
  }
  const lx$ = lx;
  if (lx$.token === T_LESS_THAN && p$.hasTypeArgumentsInExpressions) {
    // TODO(recover): `super<T>`: `type_arguments_of_super`.
    fail();
    return obj;
  }
  errorAtToken(1034);
  const name = rightSideOfDot();
  return pushExprDot(start, lx$.fullStart, obj, name, p$.outPos, CHAIN_NO);
}

/** `import(..)`, `import.meta` */
function importExpression(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  // `nextTokenIsOpenParenOrLessThan`, `nextTokenIsDot`: otherwise `parsePrimaryExpression`.
  const p$ = p;
  if (p$.recovers) {
    const after = peek();
    if (after !== T_OPEN_PAREN && after !== T_LESS_THAN && after !== T_DOT) return missingExpression(1109);
  }
  next();
  let isDeferred = false;
  if (lx$.token === T_DOT) {
    next();
    const which = nameAfterImportAndDot();
    if (which === 1 /* meta */ && lx$.token === T_IDENTIFIER) {
      next();
      return pushExprImportMeta(start, lx$.fullStart);
    } else if (which === 2 /* defer */ && peek() === T_OPEN_PAREN) {
      // falls out
    } else if (which === 2 /* defer */ && p$.recovers && isCallee_(true)) {
      // falls out
    } else if (which === 3 /* source */ && p$.isBabel) {
      // For Babel and oxc `source` is a phase too. It is kept like `defer`: the text tells them apart.
    } else {
      return otherMetaPropertyOfImport(start);
    }
    // `parseIdentifierName`
    nextAfterName();
    isDeferred = true;
    // `IsImportCall` does not ask for it.
    if (p$.recovers) eat(T_QUESTION_DOT);
  }
  if (lx$.token === T_OPEN_PAREN) return importCall(start, isDeferred);
  return importWithoutArguments(start, isDeferred);
}

/** `parseCallExpressionRest`, after an `import` that no `(` follows. The keyword is kept as a missing expression. */
function importWithoutArguments(start: number, isDeferred: boolean): number {
  const p$ = p;
  const lx$ = lx;
  if (!p$.recovers || lx$.token !== T_LESS_THAN) {
    fail();
    return NONE;
  }
  const lessThan = lx$.start | 0;
  const hir$ = hir;
  const reported = hir$.diagnosticsLen | 0;
  const typeArgs = p$.hasTypeArgumentsInExpressions ? tryTypeArgumentsInExpression(true) : -1;
  if (typeArgs < 0) return pushExprMissing(start, start);
  const typeArgsLen = p$.outLen | 0;
  if (lx$.token === T_OPEN_PAREN) {
    // `checkImportCallExpression` does not look at them: what was added since is dropped, but for the errors of the parser.
    let w = reported;
    const n = hir$.diagnosticsLen | 0;
    for (let i = reported; i < n; i += 5) {
      if ((hir$.diagnostics[i] | 0) !== DK_PARSE) continue;
      if (w !== i) for (let k = 0; k < 5; k++) hir$.diagnostics[w + k] = hir$.diagnostics[i + k] | 0;
      w = (w + 5) | 0;
    }
    hir$.diagnosticsLen = w;
    return importCall(start, isDeferred);
  }
  const keyword = pushExprMissing(start, start);
  if (lx$.token === T_NO_SUBSTITUTION_TEMPLATE || lx$.token === T_TEMPLATE_HEAD) return taggedTemplate(start, keyword, typeArgs, typeArgsLen, false);
  // `checkGrammarExpressionWithTypeArguments`
  flag(DK_GRAMMAR, 1326, start, lx$.fullStart);
  const instantiation = pushExprInstantiation(start, lx$.fullStart, keyword, typeArgs, typeArgsLen);
  if (lx$.token === T_DOT) {
    const access = accessToInstantiation(start, instantiation, lessThan, true);
    return access;
  }
  // The chain would go on in `expressionRest`.
  if (lx$.token === T_QUESTION_DOT) {
    refuse(R_UNSUPPORTED);
    return instantiation;
  }
  return instantiation;
}

/**
 * `parseCallExpressionRest`: whether what ends here is called: a `(` follows, with or without `?.` and type arguments before it.
 * `isAtLastToken`: here is after the token.
 */
function isCallee_(isAtLastToken: boolean): boolean {
  const cp = lookAheadParsingBegin();
  if (cp < 0) return false;
  if (isAtLastToken) next();
  eat(T_QUESTION_DOT);
  let result: boolean;
  const lx$ = lx;
  if ((lx$.token === T_LESS_THAN || lx$.token === T_LESS_THAN_LESS_THAN) && (!p.hasTypeArgumentsInExpressions || tryTypeArgumentsInExpression(true) < 0)) result = false;
  else result = lx$.token === T_OPEN_PAREN;
  return lookAheadParsingEnd(cp, result);
}

/** `meta` (1), `defer` (2) or `source` (3), or nothing (0). For TypeScript's parser a name is what it is with an escape too. */
function nameAfterImportAndDot(): number {
  const lx$ = lx;
  const names$ = names;
  if (lx$.hasEscape && !p.isEcmascript) {
    const a = lx$.atom | 0;
    if (names$.atomIs(a, "meta")) return 1;
    if (names$.atomIs(a, "defer")) return 2;
    if (names$.atomIs(a, "source")) return 3;
    return 0;
  }
  if (tokenTextIs("meta")) return 1;
  if (tokenTextIs("defer")) return 2;
  if (tokenTextIs("source")) return 3;
  return 0;
}

/** At the `(` of `import(..)`, which starts at `start`: the call and its arguments. */
function importCall(start: number, isDeferred: boolean): number {
  next();
  const saved = enterContext(0, CTX_DISALLOW_IN | CTX_DECORATOR);
  const s$ = s;
  const base = s$.ids.len;
  const lists = enterList(LK_ARGUMENT_EXPRESSIONS);
  const lx$ = lx;
  while (isInList(T_CLOSE_PAREN) && isAtElement(LK_ARGUMENT_EXPRESSIONS)) {
    const element = lx$.fullStart | 0;
    const argument = lx$.token === T_DOT_DOT_DOT ? spreadElement() : assignmentExpression();
    s$.ids.push(argument);
    // TODO: `call_specifier(argument, ImportCall)` when it is the only argument and not in parentheses (checker's list).
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_ARGUMENT_EXPRESSIONS, element)) break;
  }
  leaveList(lists);
  const p$ = p;
  p$.context = saved;
  const close = closeOfArgumentList();
  if (s$.ids.len === base) {
    const missing = pushExprMissing(close, close);
    s$.ids.push(missing);
  }
  const argsStart = takeIds(base);
  const argsLen = p$.outLen | 0;
  const hir$ = hir;
  if (isDeferred && argsLen > 0) hir$.pushDeferredImportCalls(hir$.ids[argsStart] | 0, close);
  return pushExprImportCall(start, lx$.fullStart, argsStart, argsLen);
}

/** At the `x` of `import.x`, which starts at `start`: it is kept as a property of nothing. */
function otherMetaPropertyOfImport(start: number): number {
  // `tokenIsIdentifierOrKeyword` is true of a private name.
  const lx$ = lx;
  const p$ = p;
  if (!isIdentifierOrKeyword(lx$.token)) {
    const name = missingIdentifier(0, 0);
    const namePos = p$.outPos | 0;
    const obj = pushExprMissing(start, start);
    void obj;
    return pushExprDot(start, lx$.fullStart, obj, name, namePos, CHAIN_NO);
  }
  if (lx$.token === T_PRIVATE_IDENTIFIER && !p$.recovers) refuse(R_UNSUPPORTED);
  const isPrivate = lx$.token === T_PRIVATE_IDENTIFIER;
  const name = lx$.atom | 0;
  const atStart = lx$.start | 0;
  const atEnd = lx$.end | 0;
  const word = lx$.hasEscape ? atomText(name) : tokenSrcText();
  const isDefer = word === "defer";
  // `parseIdentifierName`
  nextAfterName();
  // Type arguments, and a call with `?.`, are looked at on the way.
  let isCallee = false;
  const t = lx$.token | 0;
  if (t === T_OPEN_PAREN) {
    isCallee = true;
  } else if (t === T_LESS_THAN || t === T_LESS_THAN_LESS_THAN || t === T_QUESTION_DOT) {
    if (p$.recovers) isCallee = isCallee_(false);
    else refuse(R_UNSUPPORTED);
  }
  if (isDefer && !isCallee) flagArgs(DK_GRAMMAR, 1005, atEnd, -1, ["("]);
  else if (isCallee) flagArgs(DK_GRAMMAR, 18061, atStart, atEnd, [word]);
  else flagArgs(DK_GRAMMAR, 17012, atStart, atEnd, [word, "import", "meta"]);
  const obj = pushExprMissing(start, start);
  // `parseIdentifierName` makes an `Identifier` of a private name, about which nothing else is said.
  const nm = isPrivate ? A_empty : name;
  const nmPos = isPrivate ? start : atStart;
  return pushExprDot(start, atEnd, obj, nm, nmPos, CHAIN_NO);
}

/** `parseRightSideOfDot`: the name after a `.` or a `?.`, which is the token. Its position is `p.outPos`. */
function rightSideOfDot(): number {
  const lx$ = lx;
  const p$ = p;
  if (isIdentifierOrKeyword(lx$.token)) {
    // "a name on the next line that is followed by a word on its line belongs to the next statement"
    if (lx$.newlineBefore && !p$.isEcmascript && isFollowedByWordOnSameLine()) {
      if (p$.recovers) {
        const afterDot = lx$.fullStart | 0;
        error(1003, afterDot, -1);
        p$.outPos = afterDot;
        return A_empty;
      }
      refuse(R_REPORTED);
    }
  } else {
    // `createMissingIdentifier`
    const afterDot = lx$.fullStart | 0;
    const name = missingIdentifier(0, 0);
    p$.outPos = afterDot;
    return name;
  }
  const name = lx$.atom | 0;
  const at = lx$.start | 0;
  nextAfterName();
  p$.outPos = at;
  return name;
}

/** `nextTokenIsIdentifierOrKeywordOnSameLine` */
export function isFollowedByWordOnSameLine(): boolean {
  const lx$ = lx;
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  lx$.next();
  const r = isIdentifierOrKeyword(lx$.token) && !lx$.newlineBefore;
  lookAheadEnd(m, had);
  return r;
}

/** `parseMemberExpressionRest` and, with `allowsCalls`, `parseCallExpressionRest`. */
export function expressionRest(start: number, expression_: number, allowsCalls: boolean): number {
  if (!canFollowMemberExpression(lx.token)) return expression_;
  return expressionRestInGeneral(start, expression_, allowsCalls);
}

function expressionRestInGeneral(start: number, expression0: number, allowsCalls: boolean): number {
  let expr = expression0;
  let chain = CHAIN_NO;
  // `expression`, if it is a `NonNull` with nothing after it yet.
  let nonNull = NONE;
  const lx$ = lx;
  const p$ = p;
  const hir$ = hir;
  for (;;) {
    const t = lx$.token | 0;
    if (t === T_DOT) {
      next();
      if (chain !== CHAIN_NO && lx$.token === T_PRIVATE_IDENTIFIER) privateNameInOptionalChain();
      const name = rightSideOfDot();
      expr = pushExprDot(start, lx$.fullStart, expr, name, p$.outPos, chain);
    } else if (t === T_OPEN_PAREN && allowsCalls) {
      expr = call(start, expr, 0, 0, chain);
    } else if (t === T_OPEN_BRACKET) {
      if ((p$.context & CTX_DECORATOR) !== 0) return expr;
      expr = elementAccess(start, expr, chain);
    } else if (t === T_EXCLAMATION && !lx$.newlineBefore) {
      next();
      const end = lx$.fullStart | 0;
      if (p$.isJavascript) jsError(start, end, 8013);
      if (nonNull === expr) {
        const inner = hir$.exprEnd[expr] | 0;
        hir$.exprEnd[expr] = end;
        hir$.pushNonNullEnd(expr, inner);
      } else {
        expr = pushExprNonNull(start, end, expr);
        nonNull = expr;
      }
      continue;
    } else if (t === T_QUESTION_DOT) {
      // `parseNewExpressionOrNewDotTarget` reports `new a?.b()`.
      if (!allowsCalls) return expr;
      next();
      const u = lx$.token | 0;
      if (u === T_OPEN_PAREN) {
        expr = call(start, expr, 0, 0, CHAIN_START);
      } else if (u === T_OPEN_BRACKET) {
        expr = elementAccess(start, expr, CHAIN_START);
      } else if (u === T_LESS_THAN || u === T_LESS_THAN_LESS_THAN) {
        // `parseTypeArgumentsInExpression` finds none in JavaScript.
        const typeArgs = p$.hasTypeArgumentsInExpressions ? tryTypeArgumentsInExpression(true) : -1;
        if (typeArgs < 0) return missingNameAfterQuestionDot(start, expr);
        const typeArgsLen = p$.outLen | 0;
        if (lx$.token === T_OPEN_PAREN) {
          expr = call(start, expr, typeArgs, typeArgsLen, CHAIN_START);
        } else {
          expr = optionalCallWithoutOpenParen(start, expr, typeArgs, typeArgsLen);
          if (expr < 0) return NONE;
        }
      } else if (u === T_NO_SUBSTITUTION_TEMPLATE || u === T_TEMPLATE_HEAD) {
        expr = taggedTemplate(start, expr, 0, 0, true);
      } else if (!isIdentifierOrKeyword(u)) {
        return missingNameAfterQuestionDot(start, expr);
      } else {
        if (u === T_PRIVATE_IDENTIFIER) privateNameInOptionalChain();
        const name = rightSideOfDot();
        expr = pushExprDot(start, lx$.fullStart, expr, name, p$.outPos, CHAIN_START);
      }
      chain = CHAIN_CONTINUE;
    } else if (t === T_NO_SUBSTITUTION_TEMPLATE || t === T_TEMPLATE_HEAD) {
      // To oxc `a?.b!` is still in the chain.
      const isInChain = chain !== CHAIN_NO && nonNull !== expr;
      expr = taggedTemplate(start, expr, 0, 0, isInChain);
    } else if ((t === T_LESS_THAN || t === T_LESS_THAN_LESS_THAN) && p$.hasTypeArgumentsInExpressions) {
      const lessThan = lx$.start | 0;
      const typeArgs = tryTypeArgumentsInExpression(allowsCalls);
      if (typeArgs < 0) return expr;
      const typeArgsLen = p$.outLen | 0;
      const u = lx$.token | 0;
      if (u === T_OPEN_PAREN && allowsCalls) {
        expr = call(start, expr, typeArgs, typeArgsLen, chain);
      } else if (u === T_NO_SUBSTITUTION_TEMPLATE || u === T_TEMPLATE_HEAD) {
        const isInChain = chain !== CHAIN_NO && nonNull !== expr;
        expr = taggedTemplate(start, expr, typeArgs, typeArgsLen, isInChain);
      } else {
        let instantiation = pushExprInstantiation(start, lx$.fullStart, expr, typeArgs, typeArgsLen);
        // `tryReparseOptionalChain`: it is in no chain.
        if (!p$.isFlow) chain = CHAIN_NO;
        if (lx$.token === T_DOT || lx$.token === T_QUESTION_DOT) {
          instantiation = accessToInstantiation(start, instantiation, lessThan, allowsCalls);
          chain = p$.outA | 0;
        }
        expr = instantiation;
        instantiation = NONE;
      }
    } else if (t === T_OPEN_BRACE && allowsCalls && p$.isFlow) {
      const withBraces = flowBracesAfterExpression(start, expr);
      if (withBraces === NO_EXPR) return expr;
      expr = withBraces;
    } else {
      return expr;
    }
    nonNull = NONE;
  }
}

/** The end of `parseCallExpressionRest`, after a `?.` that nothing follows. */
function missingNameAfterQuestionDot(start: number, obj: number): number {
  errorAtToken(1003);
  const lx$ = lx;
  return pushExprDot(start, lx$.fullStart, obj, A_empty, lx$.fullStart, CHAIN_START);
}

/** `parseCallExpressionRest`, after `callee?.<T>` at a token that is no `(`. */
function optionalCallWithoutOpenParen(start: number, callee: number, typeArgsStart: number, typeArgsLen: number): number {
  const p$ = p;
  if (!p$.recovers) {
    refuse(R_REPORTED);
    return callee;
  }
  const lx$ = lx;
  if (lx$.token === T_NO_SUBSTITUTION_TEMPLATE || lx$.token === T_TEMPLATE_HEAD) return taggedTemplate(start, callee, typeArgsStart, typeArgsLen, true);
  expected(T_OPEN_PAREN);
  const argsStart = restOfArgumentList();
  const argsLen = p$.outLen | 0;
  const closePos = p$.outA | 0;
  const c = hir.pushCall(callee, argsStart, argsLen, typeArgsStart, typeArgsLen, closePos, CHAIN_START, NONE);
  return pushExprCall(start, lx$.fullStart, c);
}

/**
 * `parsePropertyAccessExpressionRest`, at the `.` or the `?.` after `obj`, which is `a<b>`: the access and the chain that goes on
 * (`p.outA`), or `obj` before a `?.` that no name follows.
 */
function accessToInstantiation(start: number, obj: number, lessThan: number, allowsChain: boolean): number {
  const p$ = p;
  if (!p$.recovers) {
    refuse(R_REPORTED);
    p$.outA = CHAIN_NO;
    return obj;
  }
  const lx$ = lx;
  const isOptional = lx$.token === T_QUESTION_DOT;
  // `isStartOfOptionalPropertyOrElementAccessChain`
  if (isOptional && !(allowsChain && isIdentifierOrKeyword(peek()))) {
    p$.outA = CHAIN_NO;
    return obj;
  }
  const greaterThanEnd = lx$.fullStart | 0;
  next();
  if (isOptional && lx$.token === T_PRIVATE_IDENTIFIER) privateNameInOptionalChain();
  const name = rightSideOfDot();
  const namePos = p$.outPos | 0;
  error(1477, lessThan, greaterThanEnd);
  const chain = isOptional ? CHAIN_START : CHAIN_NO;
  const r = pushExprDot(start, lx$.fullStart, obj, name, namePos, chain);
  p$.outA = isOptional ? CHAIN_CONTINUE : CHAIN_NO;
  return r;
}

/** At the `#b` of `a?.#b` or `a?.b.#c`, which is an error of TypeScript's parser. */
function privateNameInOptionalChain(): void {
  const lx$ = lx;
  if (p.isEcmascript) flag(DK_GRAMMAR, 18030, lx$.start, lx$.end);
  else errorAndGoOn(18030, lx$.start, lx$.end);
}

/** `parseElementAccessExpressionRest`, at the `[`. */
function elementAccess(start: number, obj: number, chain: number): number {
  next();
  let index: number;
  const lx$ = lx;
  if (lx$.token === T_CLOSE_BRACKET) {
    error(1011, lx$.fullStart, -1);
    // `createMissingIdentifier`
    index = pushExprMissing(lx$.fullStart, lx$.fullStart);
  } else {
    index = expressionAllowingIn();
  }
  expect(T_CLOSE_BRACKET);
  return pushExprIndex(start, lx$.fullStart, obj, index, chain);
}

/** `parseArgumentList`, at the `(`: the arguments (start; length in `p.outLen`) and the position of the `)` (`p.outA`). */
function argumentList(): number {
  next();
  return restOfArgumentList();
}

/** `parseArgumentList`, after the `(`. */
function restOfArgumentList(): number {
  const saved = enterContext(0, CTX_DISALLOW_IN | CTX_DECORATOR);
  const s$ = s;
  const base = s$.ids.len;
  const lists = enterList(LK_ARGUMENT_EXPRESSIONS);
  const lx$ = lx;
  while (isInList(T_CLOSE_PAREN) && isAtElement(LK_ARGUMENT_EXPRESSIONS)) {
    const element = lx$.fullStart | 0;
    const argument = lx$.token === T_DOT_DOT_DOT ? spreadElement() : assignmentExpression();
    s$.ids.push(argument);
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_ARGUMENT_EXPRESSIONS, element)) break;
  }
  leaveList(lists);
  const p$ = p;
  p$.context = saved;
  const close = closeOfArgumentList();
  const start = takeIds(base);
  p$.outA = close;
  return start;
}

/** The end of `parseArgumentList`: the position of the `)`, or of the last character before. */
function closeOfArgumentList(): number {
  const lx$ = lx;
  const close = lx$.start | 0;
  if (expect(T_CLOSE_PAREN)) return close;
  const pe = (lx$.fullStart | 0) - 1;
  return pe < 0 ? 0 : pe;
}

/** `parseSpreadElement` */
function spreadElement(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  next();
  const operand = assignmentExpression();
  return pushExprSpread(start, lx$.fullStart, operand);
}

function call(start: number, callee: number, typeArgsStart: number, typeArgsLen: number, chain: number): number {
  // `IsRequireCall`
  const p$ = p;
  const hir$ = hir;
  const isRequire =
    p$.isJavascript && tagOf(callee) === EXPR_IDENT && (hir$.exprA[callee] | 0) === A_require && !isParenthesized(callee);
  void isRequire; // TODO: `call_specifier(argument, RequireCall)` (checker's list of specifiers)
  const argsStart = argumentList();
  const argsLen = p$.outLen | 0;
  const closePos = p$.outA | 0;
  const c = hir$.pushCall(callee, argsStart, argsLen, typeArgsStart, typeArgsLen, closePos, chain, NONE);
  return pushExprCall(start, lx.fullStart, c);
}

// ───────────────────────────── type arguments in expressions ─────────────────────────────

/** Lower bound of `pos` among the first values of the rows (of `stride` ints) of the sorted vector: the number of rows below it. */
function lowerBoundRows(v: Int32Array, rows: number, stride: number, pos_: number): number {
  let lo = 0;
  let hi = rows;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((v[mid * stride] | 0) < pos_) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** `parseTypeArgumentsInExpression`, in a `tryParse`. `allowsCalls`: not in the callee of `new`. -1: none; else the list (length `p.outLen`). */
function tryTypeArgumentsInExpression(allowsCalls: boolean): number {
  const p$ = p;
  if (p$.isFlow) return flowTypeArgumentsInExpression(!allowsCalls);
  const lx$ = lx;
  const lessThan = lx$.start | 0;
  const context = p$.context | 0;
  // What follows a `<` that starts no type arguments is parsed again as an expression, with every `<` in it. An attempt that
  // got far and failed is not made again: otherwise each level of `a < ({b = a < ({b = ..` takes twice as long as the one in it.
  const nta = p$.notTypeArguments;
  if (nta.len > 0) {
    // What is before a token that is read for good is not read again.
    if (p$.speculations === 0) {
      const read = lowerBoundRows(nta.data, nta.len >> 1, 2, lessThan);
      if (read > 0) {
        nta.data.copyWithin(0, read * 2, nta.len);
        nta.len = nta.len - read * 2;
      }
    }
    // binary search for (lessThan, context)
    const rows = nta.len >> 1;
    let k = lowerBoundRows(nta.data, rows, 2, lessThan);
    while (k < rows && (nta.data[k * 2] | 0) === lessThan) {
      if ((nta.data[k * 2 + 1] | 0) === context) return -1;
      k = k + 1;
    }
  }
  let end = lessThan;
  let typeArguments = -1;
  let len = 0;
  const cp = tryParseBegin();
  if (cp >= 0) {
    typeArguments = typeArgumentsInExpression(lessThan);
    len = p$.outLen | 0;
    end = lx$.start | 0;
    if (!tryParseEnd(cp, typeArguments >= 0)) typeArguments = -1;
  }
  if (p$.wasAbandoned) end = p$.wasAbandonedPos | 0;
  if (typeArguments < 0 && lx$.refusal === 0 && end - lessThan > 64) {
    // insert (lessThan, context) at the partition point of the rows below it (lexicographic)
    let k = lowerBoundRows(nta.data, nta.len >> 1, 2, lessThan);
    const rows = nta.len >> 1;
    while (k < rows && (nta.data[k * 2] | 0) === lessThan && (nta.data[k * 2 + 1] | 0) < context) k = k + 1;
    nta.push(0);
    nta.push(0);
    const d = nta.data;
    d.copyWithin(k * 2 + 2, k * 2, nta.len - 2);
    d[k * 2] = lessThan | 0;
    d[k * 2 + 1] = context | 0;
  }
  if (typeArguments < 0) refuseTypeArgumentsWithAnError(lessThan);
  p$.outLen = len;
  return typeArguments;
}

/** `parseTypeArgumentsInExpression`, at the `<` at `lessThan`. -1: none; else the list (length `p.outLen`). */
function typeArgumentsInExpression(lessThan: number): number {
  // `ReScanLessThanToken`
  const lx$ = lx;
  if (lx$.token === T_LESS_THAN_LESS_THAN) {
    lx$.token = T_LESS_THAN;
    lx$.end = (lx$.start + 1) | 0;
  }
  next();
  const base = s.ids.len;
  const code = typeArgumentList(lessThan);
  if (code !== 0) flag(DK_GRAMMAR, code, typeArgsErrorStart(), typeArgsErrorEnd());
  // The scanner never joins a `>` with what follows it.
  if (lx$.token !== T_GREATER_THAN) return -1;
  // `ReScanGreaterThanToken`: `>=`, `>>` and so on do not end the list.
  lx$.rescanGreaterThan();
  if (lx$.token !== T_GREATER_THAN) return -1;
  next();
  // `canFollowTypeArgumentsInExpression`
  let follows: boolean;
  switch (lx$.token | 0) {
    case T_OPEN_PAREN:
    case T_NO_SUBSTITUTION_TEMPLATE:
    case T_TEMPLATE_HEAD:
      follows = true;
      break;
    case T_LESS_THAN:
    case T_GREATER_THAN:
    case T_PLUS:
    case T_MINUS:
      follows = false;
      break;
    default:
      follows = lx$.newlineBefore || isBinaryOperator() || !isStartOfExpression();
  }
  if (!follows) return -1;
  return takeIds(base);
}

/** After an attempt at the `<` at `lessThan` that failed. */
function refuseTypeArgumentsWithAnError(lessThan: number): void {
  const p$ = p;
  if (p$.wasAbandoned && canBeTypeArgumentsWithAnError(lessThan, p$.wasAbandonedTok | 0, p$.wasAbandonedPos | 0)) {
    refuse(R_REPORTED);
  }
}

const openScratch = new Int32Array(300);

function isAsciiAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/**
 * TypeScript reports an error in a type and goes on. What it goes on with can end with a `>`, and then these are type
 * arguments with an error in them. `lessThan`: where the `<` is. The attempt has failed at the token `failedToken` at `failedAt`.
 */
function canBeTypeArgumentsWithAnError(lessThan: number, failedToken: number, failedAt: number): boolean {
  const lx$ = lx;
  const src = lx$.src;
  const textEnd = lx$.len | 0;
  if (lessThan > textEnd) return false;
  let end = lessThan + 256 < textEnd ? lessThan + 256 : textEnd;
  // up to the first ';'
  let i = lessThan;
  while (i < end) {
    if ((src[i] | 0) === 59) {
      end = i;
      break;
    }
    i = (i + 1) | 0;
  }
  // It skips no token on the way: any but a comma ends a list of type arguments, which makes `isInSomeParsingContext` true. So
  // it does not get past a bracket that closes what was opened before the `<`.
  let depth = 0;
  i = lessThan;
  while (i < end) {
    const c = src[i] | 0;
    if (c === 40 || c === 91 || c === 123) {
      depth = (depth + 1) | 0;
    } else if (c === 41 || c === 93 || c === 125) {
      if (depth === 0) {
        end = i;
        break;
      }
      depth = (depth - 1) | 0;
    }
    i = (i + 1) | 0;
  }
  const len = end - lessThan; // the statement is src[lessThan, end)
  // What is before the error was read without one.
  let from = failedAt - lessThan;
  if (from < 0) from = 0;
  // A word where none is expected is left to what is around. Only a list takes it, as its next element after a missing comma.
  if (isIdentifierOrKeyword(failedToken) && !isInListOfType(lessThan, len, from)) from = len;
  while (from <= len) {
    // find '>' at or after `from`
    let at = -1;
    for (let j = from; j < len; j++) {
      if ((src[lessThan + j] | 0) === 62) {
        at = j;
        break;
      }
    }
    if (at < 0) return false;
    if (endsAList(lessThan, len, at)) return true;
    from = at + 1;
  }
  return false;
}

/** `canFollowTypeArgumentsInExpression` for the `>` at `at` of the statement `src[base, base + len)`. */
function endsAList(base: number, len: number, at: number): boolean {
  const src = lx.src;
  const before = at === 0 ? 0 : src[base + at - 1] | 0;
  if (at !== 0 && before === 61) return false; // `=`
  const afterFirst = at + 1 < len ? src[base + at + 1] | 0 : -1;
  if (afterFirst === 62 || afterFirst === 61) return false;
  // the next byte that is not a blank
  let j = at + 1;
  while (j < len) {
    const c = src[base + j] | 0;
    if (c !== 32 && c !== 9) break;
    j = (j + 1) | 0;
  }
  if (j < len) {
    const c = src[base + j] | 0;
    if (isAsciiAlnum(c) || c >= 0x80) return false;
    // "_$\"'{[<+-~#@"
    switch (c) {
      case 95:
      case 36:
      case 34:
      case 39:
      case 123:
      case 91:
      case 60:
      case 43:
      case 45:
      case 126:
      case 35:
      case 64:
        return false;
      default:
    }
  }
  return true;
}

/** Whether `end` is in a tuple, in an object type or among parameters in the text of types `src[base, base + len)`. */
function isInListOfType(base: number, len: number, end: number): boolean {
  const src = lx.src;
  const open = openScratch;
  let top = 0;
  const stop = end < len ? end : len;
  for (let at = 0; at < stop; at++) {
    const c = src[base + at] | 0;
    if (c === 40 || c === 91 || c === 123) {
      if (top < 300) {
        open[top] = at;
        top = (top + 1) | 0;
      }
    } else if (c === 41 || c === 93 || c === 125) {
      if (top > 0) top = (top - 1) | 0;
    }
  }
  for (let k = 0; k < top; k++) {
    const at = open[k] | 0;
    if ((src[base + at] | 0) !== 40 || startsParameters(base, len, at + 1)) return true;
  }
  return false;
}

/** `isUnambiguouslyStartOfFunctionType`: otherwise it is a type in parentheses. */
function startsParameters(base: number, len: number, from: number): boolean {
  const src = lx.src;
  let j = from;
  while (j < len && isAsciiSpace(src[base + j] | 0)) j = (j + 1) | 0;
  let name = 0;
  while (j + name < len) {
    const c = src[base + j + name] | 0;
    if (isAsciiAlnum(c) || c === 95 || c === 36 || c >= 0x80) name = (name + 1) | 0;
    else break;
  }
  if (name === 0) return true;
  let k = j + name;
  while (k < len && isAsciiSpace(src[base + k] | 0)) k = (k + 1) | 0;
  if (k >= len) return true;
  const c = src[base + k] | 0;
  return c === 58 || c === 44 || c === 63 || c === 61 || c === 41;
}

function isAsciiSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

// ───────────────────────────── primary expressions ─────────────────────────────

/** `parsePrimaryExpression` */
export function primaryExpression(): number {
  const lx$ = lx;
  const t = lx$.token | 0;
  const hir$ = hir;
  const p$ = p;
  switch (t) {
    case T_IDENTIFIER: {
      const name = lx$.atom | 0;
      noteIdentifier(name, lx$.start);
      return tokenExprIdent(name);
    }
    case T_STRING: {
      const e = pushExprString(lx$.start, lx$.end, lx$.atom);
      next();
      return e;
    }
    case T_THIS: {
      const e = pushExprThis(lx$.start, lx$.end);
      next();
      return e;
    }
    case T_OPEN_PAREN:
      return parenthesizedExpression();
    case T_NUMBER: {
      const e = pushExprNumber(lx$.start, lx$.end, hir$.pushNumber(lx$.number));
      next();
      return e;
    }
    case T_OPEN_BRACE:
      return objectLiteral();
    case T_OPEN_BRACKET:
      return arrayLiteral();
    case T_TRUE: {
      const e = pushExprTrue(lx$.start, lx$.end);
      next();
      return e;
    }
    case T_FALSE: {
      const e = pushExprFalse(lx$.start, lx$.end);
      next();
      return e;
    }
    case T_NULL: {
      const e = pushExprNull(lx$.start, lx$.end);
      next();
      return e;
    }
    case T_NEW:
      return newExpression();
    case T_FUNCTION:
      return functionExpression();
    case T_ASYNC:
      if (nextIsFunctionOnSameLine()) return functionExpression();
      break;
    case T_NO_SUBSTITUTION_TEMPLATE:
    case T_TEMPLATE_HEAD:
      return templateExpression();
    case T_CLASS:
      return classExpression();
    case T_AT:
      return decoratedExpression();
    case T_SLASH:
    case T_SLASH_EQUALS: {
      lx$.rescanSlash();
      const e = pushExprRegex(lx$.start, lx$.end);
      next();
      return e;
    }
    case T_BIG_INT: {
      const e = pushExprBigInt(lx$.start, lx$.end, lx$.atom);
      next();
      return e;
    }
    case T_PRIVATE_IDENTIFIER: {
      hir$.rareSyntax = hir$.rareSyntax | RARE_ODD_PRIVATE_NAME;
      if (p$.isEcmascript && p$.privateNameBeforeIn !== lx$.start) fail();
      const e = pushExprPrivateIdentifier(lx$.start, lx$.end, lx$.atom);
      next();
      return e;
    }
    case T_SUPER: {
      const e = pushExprSuper(lx$.start, lx$.end);
      next();
      return e;
    }
    case T_LESS_THAN:
      if (p$.isEcmascript) return jsxElementOrFragment();
      break;
    // After `new`.
    case T_IMPORT:
      if (p$.isEcmascript) return importExpression();
      break;
    default:
  }
  if (isIdentifier()) {
    takeAsName();
    const name = lx$.atom | 0;
    noteIdentifier(name, lx$.start);
    return tokenExprIdent(name);
  }
  return missingExpression(1109);
}

function tokenExprIdent(name: number): number {
  const lx$ = lx;
  const e = pushExprIdent(lx$.start, lx$.end, name);
  next();
  return e;
}

/** `nextTokenIsFunctionKeywordOnSameLine` */
export function nextIsFunctionOnSameLine(): boolean {
  const lx$ = lx;
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  lx$.next();
  const r = lx$.token === T_FUNCTION && !lx$.newlineBefore;
  lookAheadEnd(m, had);
  return r;
}

/** `parseParenthesizedExpression` */
function parenthesizedExpression(): number {
  const lx$ = lx;
  const open = lx$.start | 0;
  next();
  const saved = enterContext(0, CTX_DISALLOW_IN);
  const expr = expressionMaybeInParentheses(true);
  const p$ = p;
  p$.context = saved;
  const hir$ = hir;
  if (lx$.token !== T_CLOSE_PAREN) {
    // `unclosed_parenthesized_expression`
    if (lx$.token === T_COLON && p$.isFlow) return flowTypeCast(open, expr);
    expected(T_CLOSE_PAREN);
    if (p$.recovers) hir$.pushParen(expr, open, lx$.fullStart);
    return expr;
  }
  next();
  const end = lx$.fullStart | 0;
  hir$.pushParen(expr, open, end);
  return expr;
}

/** `parseArrayLiteralExpression` */
function arrayLiteral(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  next();
  const p$ = p;
  const cleared = (p$.isEcmascript ? CTX_DISALLOW_IN : 0) | CTX_DECORATOR;
  const saved = enterContext(0, cleared);
  const s$ = s;
  const base = s$.ids.len;
  const lists = enterList(LK_ARRAY_LITERAL_MEMBERS);
  while (isInList(T_CLOSE_BRACKET) && isAtElement(LK_ARRAY_LITERAL_MEMBERS)) {
    const full = lx$.fullStart | 0;
    let element: number;
    const t = lx$.token | 0;
    if (t === T_DOT_DOT_DOT) element = spreadElement();
    // `NewOmittedExpression`
    else if (t === T_COMMA) element = pushExprMissing(lx$.start, lx$.fullStart);
    else element = assignmentExpression();
    s$.ids.push(element);
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_ARRAY_LITERAL_MEMBERS, full)) break;
  }
  leaveList(lists);
  p$.context = saved;
  expectMatching(T_OPEN_BRACKET, T_CLOSE_BRACKET, start);
  const elements = takeIds(base);
  return pushExprArray(start, lx$.fullStart, elements, p$.outLen);
}

// ───────────────────────────── templates ─────────────────────────────

/** `parseTemplateExpression`, and a template without substitutions. */
function templateExpression(): number {
  // A `NoSubstitutionTemplateLiteral` is a string.
  const lx$ = lx;
  if (lx$.token === T_NO_SUBSTITUTION_TEMPLATE) {
    pieceOfTemplateWithoutTag();
    const e = pushExprString(lx$.start, lx$.end, lx$.atom);
    next();
    return e;
  }
  const start = lx$.start | 0;
  const exprs = templateParts(false);
  return pushExprTemplate(start, lx$.fullStart, exprs, p.outLen);
}

/** The token is a piece of a template in which every escape has to be valid. */
export function pieceOfTemplateWithoutTag(): void {
  if (lx.hasEscape) rescanTemplatePiece();
}

/** `reScanTemplateToken(false)`: the invalid escapes of the piece are reported. */
function rescanTemplatePiece(): void {
  // Prettier lets Babel recover from them.
  const p$ = p;
  if (p$.isBabel) return;
  if (p$.recovers) lx.rescanTemplateWithoutTag();
  else report();
}

/** `IsUnterminated` of the last piece of a template, which is the token. */
function isAtUnterminatedPiece(): boolean {
  const lx$ = lx;
  if (!p.recovers || (lx$.end | 0) !== (lx$.len | 0)) return false;
  // The piece of a template at the end of the text has no `` ` `` of its own at its end.
  const start = ((lx$.start | 0) + 1) | 0;
  const end = lx$.end | 0;
  if (end <= start || (lx$.src[end - 1] | 0) !== 96) return true;
  let backslashes = 0;
  let i = end - 2;
  while (i >= start && (lx$.src[i] | 0) === 92) {
    backslashes = (backslashes + 1) | 0;
    i = (i - 1) | 0;
  }
  return backslashes % 2 === 1;
}

/**
 * The substitutions of the template at the token, which the texts follow in the list of ids (start returned; the number of
 * substitutions is `p.outLen`), and `callIsIncomplete` (`p.outA`, 0/1).
 */
function templateParts(hasTag: boolean): number {
  // The first text, then each substitution and the text after it.
  const s$ = s;
  const base = s$.ids.len;
  if (!hasTag) pieceOfTemplateWithoutTag();
  const lx$ = lx;
  s$.ids.push(lx$.atom);
  let goesOn = lx$.token === T_TEMPLATE_HEAD;
  let isIncomplete = hasTag && !goesOn && isAtUnterminatedPiece();
  next();
  while (goesOn) {
    const e = expressionAllowingIn();
    s$.ids.push(e);
    if (lx$.token !== T_CLOSE_BRACE) {
      // `parseLiteralOfTemplateSpan`
      expected(T_CLOSE_BRACE);
      s$.ids.push(A_empty);
      isIncomplete = true;
      break;
    }
    lx$.rescanTemplateContinuation();
    if (!hasTag) pieceOfTemplateWithoutTag();
    s$.ids.push(lx$.atom);
    goesOn = lx$.token === T_TEMPLATE_MIDDLE;
    isIncomplete = hasTag && !goesOn && isAtUnterminatedPiece();
    next();
  }
  // parts = [text0, expr1, text1, expr2, text2, ...]: the substitutions first, then the texts.
  const n = s$.ids.len - base;
  const count = (n / 2) | 0;
  const hir$ = hir;
  hir$.ensureIds(n);
  const start = hir$.idsLen;
  const ids = hir$.ids;
  const parts = s$.ids.data;
  let w = start;
  for (let i = 1; i < n; i += 2) {
    ids[w] = parts[base + i] | 0;
    w = (w + 1) | 0;
  }
  for (let i = 0; i < n; i += 2) {
    ids[w] = parts[base + i] | 0;
    w = (w + 1) | 0;
  }
  hir$.idsLen = w;
  s$.ids.len = base;
  const p$ = p;
  p$.outLen = count;
  p$.outA = isIncomplete ? 1 : 0;
  return start;
}

/** `parseTaggedTemplateRest` */
function taggedTemplate(start: number, callee: number, typeArgsStart: number, typeArgsLen: number, isInChain: boolean): number {
  const lx$ = lx;
  const backtick = lx$.start | 0;
  const head = lx$.atom | 0;
  // `checkTaggedTemplateExpression`: `checkGrammarTypeArguments` is not asked after the error below.
  const hir$ = hir;
  if (isInChain && typeArgsLen === 0 && hir$.diagnosticsLen >= 5) {
    const k = hir$.diagnosticsLen - 5;
    const code = hir$.diagnostics[k + 3] | 0;
    const dstart = hir$.diagnostics[k + 1] | 0;
    if (code === 1099 && dstart >= start && dstart < backtick) hir$.diagnosticsLen = k;
  }
  const exprs = templateParts(true);
  const p$ = p;
  const exprsLen = p$.outLen | 0;
  const isIncomplete = (p$.outA | 0) !== 0;
  // `checkGrammarTaggedTemplateChain`
  if (isInChain) flag(DK_GRAMMAR, 1358, backtick, lx$.fullStart);
  // A `NoSubstitutionTemplateLiteral` is a string, as it is without a tag.
  const template = exprsLen === 0 ? pushExprString(backtick, lx$.fullStart, head) : pushExprTemplate(backtick, lx$.fullStart, exprs, exprsLen);
  const c = hir$.pushCall(callee, exprs, exprsLen, typeArgsStart, typeArgsLen, isIncomplete ? INCOMPLETE_TEMPLATE : -1, CHAIN_NO, template);
  return pushExprTaggedTemplate(start, lx$.fullStart, c);
}

// ───────────────────────────── new ─────────────────────────────

/** `parseNewExpressionOrNewDotTarget` */
function newExpression(): number {
  if (!enterDepth()) return NONE;
  const r = newExpressionBody();
  leaveDepth();
  return r;
}

function newExpressionBody(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  next();
  const hir$ = hir;
  if (eat(T_DOT)) {
    // `checkGrammarMetaProperty`
    if (!tokenTextIs("target") && !lx$.hasEscape) flagArgs(DK_GRAMMAR, 17012, lx$.start, lx$.end, [tokenSrcText(), "new", "target"]);
    const name = identifierName();
    hir$.rareSyntax = hir$.rareSyntax | RARE_NEW_TARGET;
    return pushExprNewTarget(start, lx$.fullStart, name);
  }
  const calleeStart = lx$.start | 0;
  let callee = primaryExpression();
  callee = expressionRest(calleeStart, callee, false);
  let typeArgsStart = 0;
  let typeArgsLen = 0;
  // The type arguments belong to the `new` expression.
  if (callee >= 0 && callee + 1 === hir$.nExprs && (hir$.exprTag[callee] | 0) === EXPR_INSTANTIATION && !isParenthesized(callee)) {
    const inner = hir$.exprA[callee] | 0;
    typeArgsStart = hir$.exprB[callee] | 0;
    typeArgsLen = hir$.exprC[callee] | 0;
    hir$.nExprs = hir$.nExprs - 1;
    callee = inner;
  }
  let argsStart = 0;
  let argsLen = 0;
  let closePos = -1;
  const t = lx$.token | 0;
  const p$ = p;
  if (t === T_OPEN_PAREN) {
    argsStart = argumentList();
    argsLen = p$.outLen | 0;
    closePos = p$.outA | 0;
  } else if (t === T_QUESTION_DOT) {
    optionalChainFromNewExpression(callee);
  }
  const c = hir$.pushCall(callee, argsStart, argsLen, typeArgsStart, typeArgsLen, closePos, CHAIN_NO, NONE);
  return pushExprNew(start, lx$.fullStart, c);
}

/** `parseNewExpressionOrNewDotTarget`, at the `?.` after `new callee`. */
function optionalChainFromNewExpression(callee: number): void {
  if (!p.recovers) {
    refuse(R_REPORTED);
    return;
  }
  // `GetTextOfNodeFromSourceText`: where `callee` is written, with its parentheses if no other expression has got any since.
  let from = 0;
  let to = 0;
  const hir$ = hir;
  const np = hir$.nParens;
  if (np > 0 && (hir$.parenExpr[np - 1] | 0) === callee) {
    from = hir$.parenStart[np - 1] | 0;
    to = hir$.parenEnd[np - 1] | 0;
  } else if (callee >= 0 && callee < hir$.nExprs) {
    from = hir$.exprPos[callee] | 0;
    to = hir$.exprEnd[callee] | 0;
  }
  errorAtTokenArgs(1209, [srcText(from, to)]);
}

// ───────────────────────────── object literals ─────────────────────────────

/** `parseObjectLiteralExpression` */
export function objectLiteral(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  // Only `parseJSONText` is here at another token.
  const open = expect(T_OPEN_BRACE) ? start : -1;
  const p$ = p;
  const cleared = (p$.isEcmascript ? CTX_DISALLOW_IN : 0) | CTX_DECORATOR;
  const saved = enterContext(0, cleared);
  const s$ = s;
  const base = s$.props.len;
  const lists = enterList(LK_OBJECT_LITERAL_MEMBERS);
  while (isInList(T_CLOSE_BRACE) && isAtElement(LK_OBJECT_LITERAL_MEMBERS)) {
    const element = lx$.fullStart | 0;
    objectLiteralElement();
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_OBJECT_LITERAL_MEMBERS, element)) break;
  }
  leaveList(lists);
  p$.context = saved;
  expectMatching(T_OPEN_BRACE, T_CLOSE_BRACE, open);
  const props = takeList(s$.props, base);
  return pushExprObject(start, lx$.fullStart, props, p$.outLen);
}

/**
 * `parsePropertyName`: the key and its kind and position are written to `p.keyKind` (PK_*), `p.keyVal` (atom or ExprId),
 * `p.nameKind` (NK_*) and `p.namePos`.
 */
export function propertyName(): void {
  const lx$ = lx;
  const pos_ = lx$.start | 0;
  const t = lx$.token | 0;
  const p$ = p;
  if (t === T_STRING) {
    p$.keyKind = PK_NAME;
    p$.keyVal = lx$.atom | 0;
    p$.nameKind = NK_STRING_LITERAL;
  } else if (t === T_NUMBER) {
    p$.keyKind = PK_NAME;
    p$.keyVal = numberName(lx$.number);
    p$.nameKind = NK_NUMERIC_LITERAL;
  } else if (t === T_OPEN_BRACKET) {
    computedPropertyName(pos_);
    return;
  } else if (t === T_PRIVATE_IDENTIFIER) {
    p$.keyKind = PK_PRIVATE;
    p$.keyVal = lx$.atom | 0;
    p$.nameKind = NK_IDENTIFIER;
  } else if (t === T_BIG_INT) {
    p$.keyKind = PK_NAME;
    p$.keyVal = lx$.atom | 0;
    p$.nameKind = NK_IDENTIFIER;
  } else if (isIdentifierOrKeyword(t)) {
    p$.keyKind = PK_NAME;
    p$.keyVal = lx$.atom | 0;
    p$.nameKind = NK_IDENTIFIER;
  } else {
    const name = missingName_();
    if (name < 0) {
      p$.keyKind = PK_NONE;
      p$.keyVal = NONE;
    } else {
      p$.keyKind = PK_NAME;
      p$.keyVal = name;
    }
    p$.nameKind = NK_IDENTIFIER;
    return; // p.namePos was set by missingName_
  }
  p$.namePos = pos_;
  nextAfterName();
}

function missingName_(): number {
  const full = lx.fullStart | 0;
  const name = missingIdentifier(0, 0);
  const p$ = p;
  const at = p$.outPos | 0;
  p$.namePos = name === A_empty ? full : at;
  return name;
}

/** `parseComputedPropertyName`, at the `[`. */
function computedPropertyName(pos_: number): void {
  // `parseComputedPropertyName`
  next();
  const hir$ = hir;
  const parens = hir$.nParens;
  const p$ = p;
  const hadIdentifier = p$.hasAwaitIdentifier;
  p$.hasAwaitIdentifier = false;
  const left = 0; // TODO(recover): `await_context_of_module()`
  const saved = enterContext(0, CTX_DISALLOW_IN | CTX_TYPE | left);
  // "We parse any expression (including a comma expression)."
  const expr = p$.isEcmascript ? assignmentExpression() : expression();
  p$.context = saved;
  // `parsePropertyName` of the native parser restores `statementHasAwaitIdentifier`, so that no statement is parsed again
  // for an `await` in a name: see `top_level_statement`.
  if (p$.hasAwaitIdentifier && !p$.isTypescript5 && !p$.isEcmascript && !p$.recovers) refuse(R_UNSUPPORTED);
  p$.hasAwaitIdentifier = hadIdentifier;
  expect(T_CLOSE_BRACKET);
  // `IsDynamicName`: only a bare literal is a name.
  const isBare = hir$.nParens === parens;
  const tag = tagOf(expr);
  if (tag === EXPR_STRING && isBare) {
    const name = hir$.exprA[expr] | 0;
    dropLastExpr(expr);
    p$.keyKind = PK_NAME;
    p$.keyVal = name;
    p$.nameKind = NK_COMPUTED_STRING;
    p$.namePos = pos_;
    return;
  }
  if (tag === EXPR_NUMBER && isBare) {
    const name = numberName(hir$.numbers[hir$.exprA[expr] | 0]);
    dropLastExpr(expr);
    p$.keyKind = PK_NAME;
    p$.keyVal = name;
    p$.nameKind = NK_COMPUTED_NUMBER;
    p$.namePos = pos_;
    return;
  }
  // The kind of the literal under casts and parentheses.
  let inner = expr;
  for (;;) {
    const it = tagOf(inner);
    if (it === EXPR_AS || it === EXPR_SATISFIES || it === EXPR_AS_CONST || it === EXPR_NON_NULL) inner = hir$.exprA[inner] | 0;
    else break;
  }
  const it = tagOf(inner);
  p$.keyKind = PK_COMPUTED;
  p$.keyVal = expr;
  p$.nameKind = it === EXPR_STRING ? NK_COMPUTED_STRING : it === EXPR_NUMBER ? NK_COMPUTED_NUMBER : NK_IDENTIFIER;
  p$.namePos = pos_;
}

/** Removes `e`, which is the last expression and is not referred to. */
function dropLastExpr(e: number): void {
  const hir$ = hir;
  if (e >= 0 && e + 1 === hir$.nExprs) {
    const tag = hir$.exprTag[e] | 0;
    const a = hir$.exprA[e] | 0;
    hir$.nExprs = e;
    if (tag === EXPR_NUMBER && a + 1 === hir$.numbersLen) hir$.numbersLen = a;
  }
}

/** `parseObjectLiteralElement`: pushes it on the stack of properties. */
function objectLiteralElement(): void {
  const lx$ = lx;
  const start = lx$.start | 0;
  const t0 = lx$.token | 0;
  const hir$ = hir;
  const s$ = s;
  if (t0 === T_DOT_DOT_DOT) {
    next();
    const value = assignmentExpression();
    const pos_ = firstOperandPos(value);
    const prop = hir$.pushProp(PROP_SPREAD, PK_NONE, NONE, NK_IDENTIFIER, value, pos_, start, lx$.fullStart, 0, 0, 0);
    s$.props.push(prop);
    return;
  }
  let flags = 0;
  let kind = PROP_INIT;
  const firstModifier = s$.modifiers.len;
  if (isModifier(t0) || t0 === T_AT) {
    flags = modifiers(MODS_DECLARATION);
    for (let k = firstModifier; k < s$.modifiers.len; k++) {
      if ((hir$.modifierKind[s$.modifiers.data[k]] | 0) === MODK_DECORATOR) {
        refuse(R_REPORTED);
        break;
      }
    }
  }
  if (lx$.token === T_GET || lx$.token === T_SET) {
    // `parseContextualModifier`
    const accessor = lx$.token | 0;
    const m = lx$.mark();
    next();
    if (canFollowAccessorKeyword()) {
      lx$.release(m);
      kind = accessor === T_GET ? PROP_GETTER : PROP_SETTER;
    } else {
      lx$.reset(m);
    }
  }
  const isGenerator = kind === PROP_INIT && eat(T_ASTERISK);
  // Not even for oxc is `{ await }` a shorthand where `await` is a keyword.
  const isIdent = isIdentifierInContext();
  // TODO(recover): `await_context_of_module() != 0` and oxc's `is_module_or_script` cases.
  const isBigint = lx$.token === T_BIG_INT;
  const nameEnd = lx$.end | 0;
  propertyName();
  const p$ = p;
  let keyKind = p$.keyKind | 0;
  let keyVal = p$.keyVal | 0;
  const nameKind = p$.nameKind | 0;
  const pos_ = p$.namePos | 0;
  if (keyKind === PK_PRIVATE) hir$.rareSyntax = hir$.rareSyntax | RARE_ODD_PRIVATE_NAME;
  // `getDeclarationName`: a private name outside a class declares nothing. Neither does a bigint.
  if ((p$.classesAround === 0 && keyKind === PK_PRIVATE) || isBigint) {
    keyKind = PK_NONE;
    keyVal = NONE;
  }
  // "Disallowing of optional property assignments and definite assignment assertion happens in the grammar checker."
  let postfixToken = 0;
  if (kind === PROP_INIT && (lx$.token === T_QUESTION || lx$.token === T_EXCLAMATION) && !p$.isEcmascript) {
    postfixToken = lx$.start | 0;
    next();
  }
  const isFunction = kind !== PROP_INIT || isGenerator || lx$.token === T_OPEN_PAREN || lx$.token === T_LESS_THAN;
  let value: number;
  if (isFunction) {
    let fnKind: number;
    if (kind === PROP_GETTER) {
      fnKind = FN_GETTER;
    } else if (kind === PROP_SETTER) {
      fnKind = FN_SETTER;
    } else {
      kind = PROP_METHOD;
      fnKind = FN_METHOD;
    }
    let fnFlags = kind === PROP_METHOD ? flags & FLAG_ASYNC : 0;
    if (isGenerator) fnFlags = fnFlags | FLAG_GENERATOR;
    const name = keyKind === PK_NAME || keyKind === PK_PRIVATE ? keyVal : ATOM_NONE;
    const func = functionRest(fnKind, fnFlags, name, pos_, start);
    // The function expression starts at its parameters.
    const parameters = p$.recovers ? startOfParameters(func) : hir$.fnAnchor[func] | 0;
    value = pushExprFn(parameters, lx$.fullStart, func);
  } else if (isIdent && lx$.token !== T_COLON) {
    kind = PROP_SHORTHAND;
    if (keyKind !== PK_NAME) {
      fail();
      return;
    }
    noteIdentifier(keyVal, pos_);
    const target = pushExprIdent(pos_, nameEnd, keyVal);
    if (lx$.token === T_EQUALS) {
      // `{ a = 1 }`, which only a destructuring assignment can have.
      next();
      hir$.rareSyntax = hir$.rareSyntax | RARE_DEFAULT_IN_OBJECT;
      const v = assignmentExpressionAllowingIn();
      value = pushExprAssign(pos_, lx$.fullStart, target, v, 0);
    } else {
      value = target;
    }
  } else {
    // TODO(recover): in a script `{ await }` is a shorthand.
    expect(T_COLON);
    value = assignmentExpressionAllowingIn();
  }
  let modStart = 0;
  let modLen = 0;
  if (s$.modifiers.len > firstModifier) {
    modStart = takeModifiers(firstModifier);
    modLen = p$.outLen | 0;
  }
  const prop = hir$.pushProp(kind, keyKind, keyVal, nameKind, value, pos_, start, lx$.fullStart, postfixToken, modStart, modLen);
  if (p$.isJavascript && isFunction) checkJsMethodOfObject(prop, modStart, modLen);
  s$.props.push(prop);
}

/** The position of the first token of `e` that is neither a parenthesis nor part of `<T>`. */
export function firstOperandPos(e0: number): number {
  let e = e0;
  const hir$ = hir;
  for (;;) {
    if (e < 0 || e >= hir$.nExprs) return 0;
    switch (hir$.exprTag[e] | 0) {
      case EXPR_BINARY:
        e = hir$.exprA[e] | 0;
        break;
      case EXPR_ASSIGN:
        e = hir$.exprA[e] | 0;
        break;
      case EXPR_COND:
        e = hir$.exprA[e] | 0;
        break;
      case EXPR_DOT:
      case EXPR_INDEX:
        e = hir$.exprA[e] | 0;
        break;
      case EXPR_CALL:
      case EXPR_TAGGED_TEMPLATE:
        e = hir$.callCallee[hir$.exprA[e] | 0] | 0;
        break;
      case EXPR_UNARY: {
        const op = hir$.exprAux[e] | 0;
        if (op === UN_POST_INC || op === UN_POST_DEC) {
          e = hir$.exprA[e] | 0;
          break;
        }
        return hir$.exprPos[e] | 0;
      }
      case EXPR_AS:
      case EXPR_SATISFIES:
      case EXPR_INSTANTIATION:
      case EXPR_AS_CONST:
      case EXPR_NON_NULL:
        e = hir$.exprA[e] | 0;
        break;
      default:
        return hir$.exprPos[e] | 0;
    }
  }
}

/** The `(` of the parameters of `func`, or the token in its place. */
function startOfParameters(func: number): number {
  const anchor = hir.fnAnchor[func] | 0;
  const lx$ = lx;
  if ((lx$.src[anchor] | 0) === 40) return anchor;
  // `createMissingList`: the anchor is before the end of the previous token.
  return skipTrivia(lx$.src, lx$.len, (anchor + 1) | 0);
}

/** `canFollowGetOrSetKeyword` */
export function canFollowAccessorKeyword(): boolean {
  const t = lx.token | 0;
  if (t === T_OPEN_BRACKET || t === T_PRIVATE_IDENTIFIER) return true;
  // acorn's `isClassElementNameStart`. Without recovery an accessor fails at them.
  const p$ = p;
  if (t === T_OPEN_BRACE || t === T_ASTERISK || t === T_DOT_DOT_DOT) return !p$.isEcmascript && !p$.recovers;
  return isLiteralPropertyName();
}

