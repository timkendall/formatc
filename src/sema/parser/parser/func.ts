// Port of vendor/bun/src/sema/parser/parser/func.rs: functions: declarations, expressions, arrow functions, parameters.
// See mod.ts for the conventions. Not ported: oxc, Flow, JSDoc, recovery (TODO notes), `Declared` (a no-op for the formatter).
import {
  BODY_BLOCK,
  BODY_EXPR,
  BODY_NONE,
  DECO_PARAM,
  FLAG_ABSTRACT,
  FLAG_ASYNC,
  FLAG_CONST,
  FLAG_DEFAULT,
  FLAG_EXPORT,
  FLAG_GENERATOR,
  FLAG_IN,
  FLAG_MISSING_BODY,
  FLAG_OPTIONAL,
  FLAG_OUT,
  FLAG_OVERRIDE,
  FLAG_PARAMETER_PROPERTY,
  FLAG_PRIVATE,
  FLAG_PROTECTED,
  FLAG_PUBLIC,
  FLAG_READONLY,
  FLAG_REST,
  FLAG_STATIC,
  FN_ARROW,
  FN_DECL,
  FN_EXPR,
  FN_GETTER,
  FN_SETTER,
  MODK_DECORATOR,
  MODK_KEYWORD,
  NONE,
  PAT_IDENT,
  RARE_DIRECTIVE_IN_FUNCTION,
  RARE_ODD_ACCESSOR,
  RARE_SUSPENDS_IN_PARAMETERS,
  RARE_TYPE_PARAMETER_MODIFIER,
  hir,
  pushExprFn,
  pushPatIdent,
  pushStmtFn,
} from "../../hir.ts";
import { A_this, ATOM_NONE } from "../../atom.ts";
import { endOfExpr } from "../../hir_util.ts";
import {
  T_ASYNC,
  T_AS,
  T_AT,
  T_CLOSE_BRACE,
  T_CLOSE_PAREN,
  T_COLON,
  T_COMMA,
  T_CONST,
  T_DOT_DOT_DOT,
  T_EQUALS,
  T_EQUALS_GREATER_THAN,
  T_EXTENDS,
  T_FUNCTION,
  T_GREATER_THAN,
  T_IN,
  T_LESS_THAN,
  T_OPEN_BRACE,
  T_OPEN_BRACKET,
  T_OPEN_PAREN,
  T_PRIVATE_IDENTIFIER,
  T_QUESTION,
  T_SLASH,
  T_THIS,
  T_ASTERISK,
  isModifier,
} from "../token.ts";
import {
  CTX_AWAIT,
  CTX_CLASS_MEMBER,
  CTX_DECORATOR,
  CTX_IN_LOOP,
  CTX_IN_SWITCH,
  CTX_TOP_LEVEL,
  CTX_TYPE,
  CTX_YIELD,
  LK_PARAMETERS,
  LK_TYPE_PARAMETERS,
  MODS_DECLARATION,
  MODS_TYPE_PARAMETER,
  ambient,
  disallowInIfBracketsEndIt,
  eat,
  enterContext,
  enterList,
  expect,
  expectMatching,
  fail,
  failUnlessRecovering,
  finishStmt,
  hasFailed,
  isBefore,
  isBindingIdentifier,
  isIdentifier,
  isInList,
  leaveList,
  lookAheadEnd,
  lx,
  missingIdentifier,
  next,
  nextAfterName,
  noteIdentifier,
  p,
  refuse,
  report,
  s,
  semicolon,
  takeList,
  tryParseBegin,
  tryParseEnd,
  errorAtToken,
  expected,
} from "./mod.ts";
import { goesOnWithoutComma } from "./recover.ts";
import { R_REPORTED } from "../lib.ts";
import { assignmentExpressionOrHigher, isStartOfExpression } from "./expr.ts";
import { identifierOrPattern, missingBindingIdentifier } from "./pattern.ts";
import { jsError, jsErrorAtType, modifierTextLen } from "./js_syntax.ts";
import { equalsAfterBlock, modifiers, optionalInitializer, statementsUntilCloseBrace, takeModifiers } from "./stmt.ts";
import { isStartOfType, ty, typeAnnotation, typeOrTypePredicate } from "./ty.ts";
import { flowReturnTypeOfArrowFunction, flowTypeParameters } from "./flow.ts";
import { CTX_AMBIENT } from "./mod.ts";
import { isAtElement } from "./recover.ts";
import { flag, error, enterDepth, leaveDepth } from "./mod.ts";
import { DK_GRAMMAR } from "../../hir.ts";
import { unaryExpression, firstOperandPos } from "./expr.ts";
import { TYPE_REF, TYPE_FN, typeRefNameLen, typeRefNameStart, typeFnFn, pushExprIdent } from "../../hir.ts";
import { A_empty } from "../../atom.ts";
import { takeAsName, missingExpression } from "./mod.ts";
import { isStartOfStatement } from "./recover.ts";
import { T_SEMICOLON, T_CLASS } from "../token.ts";
import { canParseSemicolon } from "./mod.ts";

/** `Tristate` */
const TS_FALSE = 0;
export const TS_TRUE = 1;
const TS_UNKNOWN = 2;

/** `allowAmbiguity`: what is not surely a list of parameters is none. */
const AMBIGUITY_ALLOWED = false;

const PROPERTY_MODIFIERS = FLAG_PUBLIC | FLAG_PRIVATE | FLAG_PROTECTED | FLAG_READONLY | FLAG_OVERRIDE;

/** The context of the parameters and the body of a function with `flags`. */
function signatureContext(flags: number): number {
  let context = 0;
  if ((flags & FLAG_GENERATOR) !== 0) context = context | CTX_YIELD;
  if ((flags & FLAG_ASYNC) !== 0) context = context | CTX_AWAIT;
  return context;
}

/** `parseFunctionDeclaration` */
export function functionDeclaration(startPos: number, startFull: number, base: number, flags0: number): number {
  // Only its modifiers say that `default function f() {}` has `default`.
  const flags = (flags0 & FLAG_EXPORT) !== 0 ? flags0 : flags0 & ~FLAG_DEFAULT;
  next();
  let fnFlags = ambient() | (flags & (FLAG_EXPORT | FLAG_DEFAULT | FLAG_ASYNC));
  if (eat(T_ASTERISK)) fnFlags = fnFlags | FLAG_GENERATOR;
  let name: number;
  let namePos: number;
  const lx$ = lx;
  const p$ = p;
  const s$ = s;
  const hir$ = hir;
  if (isBindingIdentifier()) {
    name = lx$.atom | 0;
    namePos = lx$.start | 0;
    noteIdentifier(name, namePos);
    nextAfterName();
  } else if ((flags & FLAG_DEFAULT) === 0) {
    // TODO(oxc): `declare function ();`, `function <T>() {}`: oxc wants no name there.
    const full = lx$.fullStart | 0;
    name = missingIdentifier(0, 0);
    namePos = name === 0 /* A_empty */ ? full : p$.outPos | 0;
  } else {
    // A default export without a name is placed at `export`.
    name = ATOM_NONE;
    namePos = startPos;
    for (let k = s$.modifiers.len - 1; k >= base; k--) {
      const m = s$.modifiers.data[k] | 0;
      if ((hir$.modifierKind[m] | 0) === MODK_KEYWORD && (hir$.modifierValue[m] | 0) === FLAG_EXPORT) {
        namePos = hir$.modifierPos[m] | 0;
        break;
      }
    }
  }
  const func = functionRest(FN_DECL, fnFlags, name, namePos, startPos);
  const modStart = takeModifiers(base);
  const modLen = p$.outLen | 0;
  const stmt = pushStmtFn(startPos, func);
  return finishStmt(stmt, startFull, modStart, modLen);
}

/** `parseFunctionExpression` */
export function functionExpression(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  let flags = 0;
  if (eat(T_ASYNC)) flags = flags | FLAG_ASYNC;
  expect(T_FUNCTION);
  if (eat(T_ASTERISK)) flags = flags | FLAG_GENERATOR;
  // Its name is read in the context of its body.
  const cleared = CTX_YIELD | CTX_AWAIT | CTX_TOP_LEVEL;
  let saved = enterContext(signatureContext(flags), cleared);
  let name = ATOM_NONE;
  let namePos = start;
  if (isBindingIdentifier()) {
    name = lx$.atom | 0;
    namePos = lx$.start | 0;
    noteIdentifier(name, namePos);
    nextAfterName();
  }
  const p$ = p;
  p$.context = saved;
  saved = enterContext(0, CTX_DECORATOR);
  const func = functionRest(FN_EXPR, flags, name, namePos, start);
  p$.context = saved;
  if ((hir.fnBodyKind[func] | 0) === BODY_NONE) failUnlessRecovering();
  // TODO(jsdoc): `function_jsdoc(func, start)`
  return pushExprFn(start, lx$.fullStart, func);
}

/** From the type parameters of a function to the end of its body. */
export function functionRest(kind: number, flags: number, name: number, namePos: number, start: number): number {
  // "'{' or ';' expected."
  const code = kind === FN_DECL ? 1144 : 1005;
  return functionRestOr(code, kind, flags, name, namePos, start);
}

/** The same. `code`: the error about a token that neither starts nor stands for the body. */
export function functionRestOr(code: number, kind: number, flags0: number, name: number, namePos: number, start: number): number {
  let flags = flags0;
  // TODO(oxc): the type parameters and the return type are in the function for oxc.
  const p$ = p;
  const outer = p$.context | 0;
  const typeParamsStart = typeParameters();
  const typeParamsLen = p$.outLen | 0;
  const lx$ = lx;
  const anchor = lx$.token === T_OPEN_PAREN ? lx$.start | 0 : Math.max(0, (lx$.fullStart | 0) - 1);
  const thisParam = parameters(signatureContext(flags));
  const paramsStart = p$.outA | 0;
  const paramsLen = p$.outLen | 0;
  noteParametersOfAccessor(kind, paramsStart, paramsLen);
  let ret = NONE;
  if (lx$.token === T_COLON) {
    next();
    ret = typeOrTypePredicate();
  }
  p$.context = outer;
  // `parseFunctionBlockOrSemicolon`
  let bodyKind = BODY_NONE;
  let bodyA = 0;
  let bodyB = 0;
  let open = 0;
  if (lx$.token === T_OPEN_BRACE) {
    // note_parameters: Declared is off
    bodyA = functionBlock(signatureContext(flags));
    bodyB = p$.outLen | 0;
    open = p$.outPos | 0;
    bodyKind = BODY_BLOCK;
  } else if (kind === FN_EXPR || (p$.recovers && !canParseSemicolon())) {
    // `parseBlock` without its `{`
    if (code === 1005) expected(T_OPEN_BRACE);
    else errorAtToken(code);
    flags = flags | FLAG_MISSING_BODY;
  } else {
    // Flow has a function without a body only where it is declared.
    if (p$.isFlow && (p$.context & CTX_AMBIENT) === 0) fail();
    semicolon();
  }
  // Without a body the whole is reported.
  if (p$.isJavascript && (bodyKind !== BODY_NONE || (flags & FLAG_MISSING_BODY) !== 0)) jsErrorAtType(ret, 8010);
  const hir$ = hir;
  const func = hir$.pushFn(kind, flags, name, namePos, typeParamsStart, typeParamsLen, paramsStart, paramsLen, thisParam, ret, bodyKind, bodyA, bodyB, anchor, start);
  if (bodyKind === BODY_BLOCK) hir$.pushBodyStart(func, open);
  // TODO(oxc): `is_odd_function` / `check_function_like_oxc`
  return func;
}

/**
 * `parseFunctionBlock`, at the `{`: the body (the start of the list of statements; the length is `p.outLen`), and the position of
 * the `{` (`p.outPos`).
 */
export function functionBlock(context: number): number {
  const lx$ = lx;
  const open = lx$.start | 0;
  let cleared = CTX_YIELD | CTX_AWAIT | CTX_TOP_LEVEL | CTX_DECORATOR | CTX_CLASS_MEMBER;
  cleared = cleared | CTX_IN_LOOP | CTX_IN_SWITCH;
  cleared = cleared | disallowInIfBracketsEndIt();
  const saved = enterContext(context, cleared);
  // Only a block whose `{` is put up with has none.
  const openAt = expect(T_OPEN_BRACE) ? open : -1;
  const hir$ = hir;
  if (lx$.token === 6 /* T_STRING */) hir$.rareSyntax = hir$.rareSyntax | RARE_DIRECTIVE_IN_FUNCTION;
  // open_function: Declared is off
  const list = statementsUntilCloseBrace();
  const p$ = p;
  const len = p$.outLen | 0;
  // close_scope: Declared is off
  p$.context = saved;
  expectMatching(T_OPEN_BRACE, T_CLOSE_BRACE, openAt);
  if (lx$.token === T_EQUALS) equalsAfterBlock();
  p$.outLen = len;
  p$.outPos = open;
  return list;
}

// ───────────────────────────── parameters ─────────────────────────────

/**
 * `checkGrammarTypeParameterList`: `<` and `>` with something between them, but no parameter. The checker finds `<>` in the text.
 */
function emptyTypeParameters(lessThan: number): void {
  const lx$ = lx;
  if (lx$.token !== T_GREATER_THAN || lx$.fullStart !== lessThan + 1) flag(DK_GRAMMAR, 1098, lessThan, ((lx$.start | 0) + 1) | 0);
}

/** `parseUnaryExpressionOrHigher` in `parseTypeParameter`: the tree has no place for it. */
function expressionInPlaceOfConstraint(): void {
  if (!p.recovers) {
    fail();
    return;
  }
  if (!enterDepth()) return;
  // `checkTypeParameter`
  const lx$ = lx;
  flag(DK_GRAMMAR, 1110, lx$.start, lx$.start === lx$.end ? -1 : lx$.end);
  const s$ = s;
  const strays = s$.strayDecorators.len;
  unaryExpression();
  s$.strayDecorators.len = strays;
  leaveDepth();
}

/** `parseTypeParameters`: the list (start; length in `p.outLen`). */
export function typeParameters(): number {
  const lx$ = lx;
  const p$ = p;
  if (lx$.token !== T_LESS_THAN) {
    p$.outLen = 0;
    return 0;
  }
  if (p$.isFlow) return flowTypeParameters();
  const lessThan = lx$.start | 0;
  next();
  const s$ = s;
  const base = s$.typeParams.len;
  const lists = enterList(LK_TYPE_PARAMETERS);
  const hir$ = hir;
  while (isInList(T_GREATER_THAN) && isAtElement(LK_TYPE_PARAMETERS)) {
    // `isListElement`
    if (lx$.token !== T_IN && lx$.token !== T_CONST && !isIdentifier()) fail();
    // `parseTypeParameter`
    const element = lx$.fullStart | 0;
    let start = lx$.start | 0;
    const modifiersBase = s$.modifiers.len;
    let flags = 0;
    if (isModifier(lx$.token)) {
      hir$.rareSyntax = hir$.rareSyntax | RARE_TYPE_PARAMETER_MODIFIER;
      flags = modifiers(MODS_TYPE_PARAMETER);
    }
    // The checker reports the others, which are in the list.
    flags = flags & (FLAG_IN | FLAG_OUT | FLAG_CONST);
    let name: number;
    let pos_: number;
    if (isIdentifier()) {
      name = lx$.atom | 0;
      pos_ = lx$.start | 0;
      noteIdentifier(name, pos_);
      nextAfterName();
    } else {
      // `missing_name_of_type_parameter`
      const full = lx$.fullStart | 0;
      const token = lx$.start | 0;
      name = missingIdentifier(0, 0);
      if (name === 0 /* A_empty */) {
        pos_ = full;
        if (start === token) start = full;
      } else {
        pos_ = p$.outPos | 0;
      }
    }
    let constraint = NONE;
    if (eat(T_EXTENDS)) {
      if (!isStartOfType(false) && isStartOfExpression()) {
        expressionInPlaceOfConstraint();
      } else {
        constraint = ty();
      }
    }
    let defaultTy = NONE;
    if (eat(T_EQUALS)) defaultTy = ty();
    const end = lx$.fullStart | 0;
    const modStart = takeModifiers(modifiersBase);
    const modLen = p$.outLen | 0;
    s$.typeParams.push(hir$.pushTypeParam(name, pos_, start, end, constraint, defaultTy, flags, modStart, modLen));
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_TYPE_PARAMETERS, element)) break;
  }
  leaveList(lists);
  const count = s$.typeParams.len - base;
  if (p$.recovers && count === 0) emptyTypeParameters(lessThan);
  if (p$.isJavascript && count > 0) {
    const first = s$.typeParams.data[base] | 0;
    const last = s$.typeParams.data[s$.typeParams.len - 1] | 0;
    jsError(hir$.typeParamStart[first] | 0, hir$.typeParamEnd[last] | 0, 8004);
  } else if (p$.isEcmascript) {
    // TODO(oxc): `js_error((lessThan + 1, NO_LENGTH), 8004)` for oxc
    report();
  }
  expect(T_GREATER_THAN);
  return takeList(s$.typeParams, base);
}

/**
 * `parseParameters`, at the `(`: returns the `this` parameter (or NONE); the other parameters are the list `p.outA` (start),
 * `p.outLen` (length).
 */
export function parameters(context: number): number {
  const p$ = p;
  if (!parametersIf(context, AMBIGUITY_ALLOWED)) {
    p$.outA = 0;
    p$.outLen = 0;
    return NONE;
  }
  return p$.outB | 0;
}

/**
 * The same, as `parseParenthesizedArrowFunctionExpression` has it. False: none. True: the `this` parameter is `p.outB`, the
 * others the list `p.outA`, `p.outLen`.
 */
function parametersIf(context: number, refused: boolean): boolean {
  const p$ = p;
  if (!expect(T_OPEN_PAREN)) {
    // `createMissingList`
    p$.outA = 0;
    p$.outLen = 0;
    p$.outB = NONE;
    return !refused;
  }
  const listStart = parameterListIf(context, T_CLOSE_PAREN, refused);
  if (listStart < 0) return false;
  let len = p$.outLen | 0;
  if (!expect(T_CLOSE_PAREN) && refused) return false;
  // `GetThisParameter`: the first, if it is named `this`.
  let thisParam = NONE;
  let start = listStart;
  const hir$ = hir;
  if (len > 0) {
    const first = hir$.ids[listStart] | 0;
    const pat = hir$.paramPat[first] | 0;
    if (pat >= 0 && (hir$.patTag[pat] | 0) === PAT_IDENT && (hir$.patA[pat] | 0) === A_this) {
      thisParam = first;
      start = (listStart + 1) | 0;
      len = (len - 1) | 0;
    }
  }
  p$.outA = start;
  p$.outLen = len;
  p$.outB = thisParam;
  return true;
}

/** `rare::ODD_ACCESSOR`, after the parameters of a function. */
export function noteParametersOfAccessor(kind: number, paramsStart: number, paramsLen: number): void {
  let isOdd = false;
  const hir$ = hir;
  if (kind === FN_GETTER) {
    isOdd = paramsLen !== 0;
  } else if (kind === FN_SETTER) {
    isOdd = paramsLen !== 1 || (paramsLen > 0 && ((hir$.paramFlags[hir$.ids[paramsStart] | 0] | 0) & FLAG_REST) !== 0);
  }
  if (isOdd) hir$.rareSyntax = hir$.rareSyntax | RARE_ODD_ACCESSOR;
}

/** `parseParametersWorker` (the list: start; length in `p.outLen`). */
export function parameterList(context: number, close: number): number {
  const start = parameterListIf(context, close, AMBIGUITY_ALLOWED);
  if (start < 0) {
    p.outLen = 0;
    return 0;
  }
  return start;
}

/** After two or more parameters, which are on the stack from `base` on: `File::may_bind_a_parameter_twice`. */
function noteNamesOfParameters(base: number): void {
  const s$ = s;
  const n = s$.params.len - base;
  // A long list is not compared, each name with each.
  const hir$ = hir;
  if (n > 8) {
    hir$.mayBindAParameterTwice = true;
    return;
  }
  const d = s$.params.data;
  for (let i = 0; i < n; i++) {
    const name = paramName(d[base + i] | 0);
    if (name < 0) {
      hir$.mayBindAParameterTwice = true;
      return;
    }
    for (let j = i + 1; j < n; j++) {
      if (paramName(d[base + j] | 0) === name) {
        hir$.mayBindAParameterTwice = true;
        return;
      }
    }
  }
}

/** The name of a parameter that is a plain identifier; NONE for a pattern. */
function paramName(param: number): number {
  const hir$ = hir;
  const pat = hir$.paramPat[param] | 0;
  if (pat >= 0 && pat < hir$.nPats && (hir$.patTag[pat] | 0) === PAT_IDENT) return hir$.patA[pat] | 0;
  return ATOM_NONE;
}

/**
 * `parseParametersWorker`. -1: it is no list of parameters, and what was built is left to the speculative parse that is going on.
 * Otherwise the list (start; length in `p.outLen`).
 */
function parameterListIf(context: number, close: number, refused: boolean): number {
  const p$ = p;
  const outerAwait = p$.context & CTX_AWAIT;
  // oxc reads the parameters of a signature in a type in the context around the type; the others clear it.
  let cleared: number;
  if ((p$.context & CTX_TYPE) !== 0) cleared = p$.clearedInTypes | CTX_TOP_LEVEL;
  else cleared = CTX_YIELD | CTX_AWAIT | CTX_TOP_LEVEL;
  cleared = cleared | disallowInIfBracketsEndIt();
  const saved = enterContext(context, cleared);
  const suspensions = p$.suspensions;
  const s$ = s;
  const base = s$.params.len;
  const decorators = s$.decorators.len;
  const lists = enterList(LK_PARAMETERS);
  const lx$ = lx;
  while (isInList(close) && (!p$.recovers || lx$.token === T_PRIVATE_IDENTIFIER || isAtElement(LK_PARAMETERS))) {
    const element = lx$.fullStart | 0;
    if (!parameter(base, outerAwait, refused)) return -1;
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_PARAMETERS, element)) break;
  }
  leaveList(lists);
  p$.context = saved;
  const hir$ = hir;
  if (p$.suspensions !== suspensions) hir$.rareSyntax = hir$.rareSyntax | RARE_SUSPENDS_IN_PARAMETERS;
  if (s$.params.len > base + 1) noteNamesOfParameters(base);
  const start = takeList(s$.params, base);
  const len = p$.outLen | 0;
  const dec = s$.decorators;
  for (let k = decorators; k < dec.len; k += 2) {
    const index = dec.data[k] | 0;
    const owner = hir$.ids[(start + index) | 0] | 0;
    hir$.pushDecorator(DECO_PARAM, owner, dec.data[k + 1] | 0);
  }
  dec.len = decorators;
  // TODO(jsdoc): `parameters_jsdoc(params)`
  p$.outLen = len;
  return start;
}

/** `parseParameterEx`: pushes it on the stack of parameters, of which the list's start at `base`. False: it is none. */
function parameter(base: number, outerAwait: number, refused: boolean): boolean {
  const lx$ = lx;
  const startPos = lx$.start | 0;
  const startFull = lx$.fullStart | 0;
  let flags = 0;
  let hasModifiers = false;
  let modStart = 0;
  let modLen = 0;
  const token = lx$.token | 0;
  const s$ = s;
  const p$ = p;
  const hir$ = hir;
  if (isModifier(token) || token === T_AT) {
    // "Decorators are parsed in the outer [Await] context, the rest of the parameter is parsed in the function's [Await] context."
    const first = s$.modifiers.len;
    const saved = enterContext(outerAwait, CTX_AWAIT);
    const seen = modifiers(MODS_DECLARATION);
    p$.context = saved;
    const index = s$.params.len - base;
    for (let k = first; k < s$.modifiers.len; k++) {
      const m = s$.modifiers.data[k] | 0;
      if ((hir$.modifierKind[m] | 0) === MODK_DECORATOR) {
        s$.decorators.push(index);
        s$.decorators.push(hir$.modifierValue[m] | 0);
      }
    }
    // The checker reports the others, which are in the list. `abstract` and `static` are still among the flags of the property
    // (`getDeclarationModifierFlagsFromSymbol`).
    flags = flags | (seen & PROPERTY_MODIFIERS);
    if ((seen & PROPERTY_MODIFIERS) !== 0) {
      flags = flags | FLAG_PARAMETER_PROPERTY | (seen & (FLAG_ABSTRACT | FLAG_STATIC));
    }
    // In a type all are.
    if ((p$.context & CTX_TYPE) !== 0) flags = flags | seen;
    if (p$.isJavascript) checkJsParameterModifiers(first, startPos);
    modStart = takeModifiers(first);
    modLen = p$.outLen | 0;
    if (modLen > 0) hasModifiers = true;
  }
  let pat: number;
  const isThis = lx$.token === T_THIS;
  if (isThis) {
    pat = pushPatIdent(lx$.start, lx$.end, A_this);
    next();
    // A decorator of `this` is an error of the parser.
    if (isModifier(token) || token === T_AT) {
      if (p$.recovers) return thisParameterAfterModifiers(base, startPos, startFull, pat, flags, modStart, modLen);
      refuse(R_REPORTED);
    }
  } else {
    if (eat(T_DOT_DOT_DOT)) flags = flags | FLAG_REST;
    // `isParameterNameStart`
    if (refused && !isBindingIdentifier() && lx$.token !== T_OPEN_BRACKET && lx$.token !== T_OPEN_BRACE) return false;
    // `parseNameOfParameter`
    pat = lx$.token === T_PRIVATE_IDENTIFIER ? missingBindingIdentifier(18009) : identifierOrPattern();
    // "to avoid this we'll advance cursor to the next token."
    if (p$.recovers && !hasModifiers && isModifier(lx$.token) && pat >= 0 && (hir$.patPos[pat] | 0) === (hir$.patEnd[pat] | 0)) next();
    if (lx$.token === T_QUESTION) {
      jsError(lx$.start, 0, 8009, "?");
      p$.questionOfParameter = lx$.start | 0;
      next();
      flags = flags | FLAG_OPTIONAL;
    }
  }
  if (flags !== 0 || hasModifiers) p$.oddParameters = (p$.oddParameters + 1) | 0;
  const type = typeAnnotation();
  // `this` has none.
  const defaultValue = isThis ? NONE : optionalInitializer();
  const param = hir$.pushParam(pat, type, defaultValue, flags, startPos, startFull, lx$.fullStart, modStart, modLen);
  s$.params.push(param);
  return true;
}

/** The rest of `parseParameterEx` after a `this` with modifiers, the last list of the file. */
function thisParameterAfterModifiers(base: number, startPos: number, startFull: number, pat: number, flags0: number, modStart0: number, modLen0: number): boolean {
  let flags = flags0;
  let modStart = modStart0;
  let modLen = modLen0;
  const s$ = s;
  const index = s$.params.len - base;
  // `modifiers.Nodes[0].Loc`
  let endOfFirst = -1;
  const hir$ = hir;
  if (modLen > 0) {
    const first = hir$.ids[modStart] | 0;
    if ((hir$.modifierKind[first] | 0) === MODK_KEYWORD) endOfFirst = ((hir$.modifierPos[first] | 0) + modifierTextLen(hir$.modifierValue[first] | 0)) | 0;
    else endOfFirst = endOfExpr(hir$.modifierValue[first] | 0);
  }
  // `GetThisParameter`: nothing asks for its modifiers, and `checkDecorators` passes it by.
  const strays = s$.modifiers.len;
  const namePos = (hir$.patPos[pat] | 0);
  const p$ = p;
  if (index === 0 && modLen > 0 && (p$.context & CTX_TYPE) === 0) {
    let decorators = 0;
    for (let k = 0; k < modLen; k++) {
      const m = hir$.ids[(modStart + k) | 0] | 0;
      if ((hir$.modifierKind[m] | 0) === MODK_DECORATOR) {
        decorators = (decorators + 1) | 0;
        const expr = hir$.modifierValue[m] | 0;
        const start = firstOperandPos(expr);
        hir$.pushStrayDecorators(start, namePos);
        s$.strayDecorators.push(start);
        s$.strayDecorators.push(expr);
      }
    }
    const dec = s$.decorators;
    const ofOthers = dec.len - decorators * 2;
    dec.len = ofOthers > 0 ? ofOthers : 0;
    modStart = 0;
    modLen = 0;
    flags = 0;
  }
  void strays;
  const type = typeAnnotation();
  if (endOfFirst >= 0) error(1433, startFull, endOfFirst);
  p$.oddParameters = (p$.oddParameters + 1) | 0;
  const param = hir$.pushParam(pat, type, NONE, flags, startPos, startFull, lx.fullStart, modStart, modLen);
  s$.params.push(param);
  return true;
}

/** `checkJSSyntax` for the modifiers of the parameter that starts at `start`, which are on the stack from `first` on. */
function checkJsParameterModifiers(first: number, start: number): void {
  if (hasFailed()) return;
  let hasKeyword = false;
  let maxEnd = -1;
  const s$ = s;
  const hir$ = hir;
  for (let k = first; k < s$.modifiers.len; k++) {
    const m = s$.modifiers.data[k] | 0;
    let end: number;
    if ((hir$.modifierKind[m] | 0) === MODK_KEYWORD) {
      hasKeyword = true;
      end = ((hir$.modifierPos[m] | 0) + modifierTextLen(hir$.modifierValue[m] | 0)) | 0;
    } else {
      end = endOfExpr(hir$.modifierValue[m] | 0);
    }
    if (end > maxEnd) maxEnd = end;
  }
  if (hasKeyword && maxEnd >= 0) jsError(start, maxEnd, 8012);
}

// ───────────────────────────── arrow functions ─────────────────────────────

/** `tryParseParenthesizedArrowFunctionExpression` and `tryParseAsyncSimpleArrowFunctionExpression`, at a `(`, a `<` or `async`. -1: none. */
export function tryArrowFunction(allowReturnType: boolean): number {
  // Of `() =>` the text says what the tokens would.
  let isOne: number;
  const lx$ = lx;
  if (lx$.token === T_OPEN_PAREN && isBefore(") =>")) {
    isOne = TS_TRUE;
  } else {
    const m = lx$.mark();
    const had = lx$.refusal | 0;
    isOne = isParenthesizedArrowFunction();
    lookAheadEnd(m, had);
  }
  const p$ = p;
  if (isOne === TS_TRUE) {
    return parenthesizedArrowFunction(TS_TRUE, true);
  } else if (isOne === TS_UNKNOWN) {
    // `parsePossibleParenthesizedArrowFunctionExpression`
    const at = lx$.start | 0;
    const na = p$.notArrows;
    // What is before a token that is read for good is not read again.
    if (p$.speculations === 0) {
      let read = 0;
      while (read < na.len && (na.data[read] | 0) < at) read = (read + 1) | 0;
      if (read > 0) {
        na.data.copyWithin(0, read, na.len);
        na.len = na.len - read;
      }
    }
    let k = 0;
    while (k < na.len && (na.data[k] | 0) < at) k = (k + 1) | 0;
    if (!(k < na.len && (na.data[k] | 0) === at)) {
      let arrow = NONE;
      const cp = tryParseBegin();
      if (cp >= 0) {
        arrow = parenthesizedArrowFunction(TS_UNKNOWN, allowReturnType);
        if (!tryParseEnd(cp, arrow >= 0)) arrow = NONE;
      }
      if (arrow >= 0) return arrow;
      let place = 0;
      while (place < na.len && (na.data[place] | 0) < at) place = (place + 1) | 0;
      na.push(0);
      na.data.copyWithin(place + 1, place, na.len - 1);
      na.data[place] = at;
    }
  }
  if (lx$.token !== T_ASYNC) return NONE;
  // `isUnParenthesizedAsyncArrowFunctionWorker`
  const m2 = lx$.mark();
  const had2 = lx$.refusal | 0;
  lx$.next();
  let isArrow = false;
  if (!lx$.newlineBefore && isIdentifier()) {
    lx$.next();
    // oxc takes the arrow function, and reports the line break.
    isArrow = lx$.token === T_EQUALS_GREATER_THAN && !lx$.newlineBefore;
  }
  lookAheadEnd(m2, had2);
  if (!isArrow) return NONE;
  const start = lx$.start | 0;
  next();
  const full = lx$.fullStart | 0;
  const name = lx$.atom | 0;
  const pos_ = lx$.start | 0;
  const end = lx$.end | 0;
  noteIdentifier(name, pos_);
  nextAfterName();
  return simpleArrowFunction(name, pos_, end, full, true, start, allowReturnType);
}

/** `isParenthesizedArrowFunctionExpressionWorker` (inside a lookahead). */
function isParenthesizedArrowFunction(): number {
  const lx$ = lx;
  if (lx$.token === T_ASYNC) {
    next();
    if (lx$.newlineBefore || (lx$.token !== T_OPEN_PAREN && lx$.token !== T_LESS_THAN)) return TS_FALSE;
  }
  const first = lx$.token | 0;
  next();
  const second = lx$.token | 0;
  const p$ = p;
  if (first === T_OPEN_PAREN) {
    switch (second) {
      // "Simple cases: '() =>', '(): ', and '() {'."
      case T_CLOSE_PAREN: {
        next();
        const t = lx$.token | 0;
        return t === T_EQUALS_GREATER_THAN || t === T_COLON || t === T_OPEN_BRACE ? TS_TRUE : TS_FALSE;
      }
      // "If encounter '([' or '({', this could be the start of a binding pattern."
      case T_OPEN_BRACKET:
      case T_OPEN_BRACE:
        return TS_UNKNOWN;
      // "Simple case: '(...'"
      case T_DOT_DOT_DOT:
        return TS_TRUE;
      default:
    }
    // "Check for '(xxx yyy', where xxx is a modifier and yyy is an identifier."
    if (isModifier(second) && second !== T_ASYNC) {
      const m = lx$.mark();
      const had = lx$.refusal | 0;
      lx$.next();
      const isBeforeIdentifier = isIdentifier();
      lookAheadEnd(m, had);
      if (isBeforeIdentifier) {
        next();
        return lx$.token === T_AS ? TS_FALSE : TS_TRUE;
      }
    }
    // "If we had '(' followed by something that's not an identifier, then this definitely wasn't a lambda."
    if (!isIdentifier() && second !== T_THIS) return TS_FALSE;
    next();
    const t = lx$.token | 0;
    // "If we have something like '(a:', then we must have a type-annotated parameter"
    if (t === T_COLON) return p$.isFlow ? TS_UNKNOWN : TS_TRUE; // `(a: T)` can be a cast in Flow
    if (t === T_QUESTION) {
      next();
      // "If we have '(a?:' or '(a?,' or '(a?=' or '(a?)' then it is definitely a lambda."
      const u = lx$.token | 0;
      return u === T_COLON || u === T_COMMA || u === T_EQUALS || u === T_CLOSE_PAREN ? TS_TRUE : TS_FALSE;
    }
    // "If we have '(a,' or '(a=' or '(a)' this *could* be an arrow function"
    if (t === T_COMMA || t === T_EQUALS || t === T_CLOSE_PAREN) return TS_UNKNOWN;
    return TS_FALSE;
  }
  // "If we have '<' not followed by an identifier, then this definitely is not an arrow function."
  if (!isIdentifier() && lx$.token !== T_CONST) return TS_FALSE;
  if (!p$.isJsx || p$.isFlow) return TS_UNKNOWN;
  // "JSX overrides"
  eat(T_CONST);
  next();
  const t = lx$.token | 0;
  if (t === T_EXTENDS) {
    next();
    const u = lx$.token | 0;
    return u === T_EQUALS || u === T_GREATER_THAN || u === T_SLASH ? TS_FALSE : TS_TRUE;
  }
  if (t === T_COMMA || t === T_EQUALS) return TS_TRUE;
  return TS_FALSE;
}

/** `parseParenthesizedArrowFunctionExpression`. `isOne`: what the tokens ahead have said. -1: none. */
export function parenthesizedArrowFunction(isOne: number, allowReturnType: boolean): number {
  const allowAmbiguity = isOne === TS_TRUE;
  const lx$ = lx;
  const start = lx$.start | 0;
  let flags = 0;
  if (eat(T_ASYNC)) flags = flags | FLAG_ASYNC;
  const typeParamsStart = typeParameters();
  const p$ = p;
  const typeParamsLen = p$.outLen | 0;
  const refused = !allowAmbiguity;
  const context = signatureContext(flags);
  if (!parametersIf(context, refused)) return NONE;
  const paramsStart = p$.outA | 0;
  const paramsLen = p$.outLen | 0;
  const thisParam = p$.outB | 0;
  const hir$ = hir;
  const errors = hir$.diagnosticsLen;
  const hasReturnColon = lx$.token === T_COLON;
  let ret = NONE;
  if (hasReturnColon) {
    next();
    ret = p$.isFlow ? flowReturnTypeOfArrowFunction() : typeOrTypePredicate();
  }
  if (!allowAmbiguity && p$.recovers && hir$.diagnosticsLen > errors && hasArrowFunctionBlockingParseError(ret)) return NONE;
  const last = lx$.token | 0;
  if (last !== T_EQUALS_GREATER_THAN && !p$.recovers) {
    // Before a `{` TypeScript takes it for an arrow function whose `=>` is missing.
    if (last === T_OPEN_BRACE && !hasFailed() && !p$.isEcmascript) refuse(R_REPORTED);
    if (allowAmbiguity) fail();
    return NONE;
  }
  if (!allowAmbiguity && last !== T_EQUALS_GREATER_THAN && last !== T_OPEN_BRACE) return NONE;
  let anchor = lx$.start | 0;
  if (!expect(T_EQUALS_GREATER_THAN)) {
    // `parseExpectedToken`: the missing token is at `nodePos()`.
    anchor = lx$.fullStart | 0;
  }
  // note_parameters: Declared is off
  let bodyKind: number;
  let bodyA: number;
  let bodyB: number;
  let open: number;
  if (last === T_EQUALS_GREATER_THAN || last === T_OPEN_BRACE) {
    bodyKind = arrowFunctionBody(flags, allowReturnType);
    bodyA = p$.outA | 0;
    bodyB = p$.outB | 0;
    open = p$.outPos | 0;
  } else {
    // `parseIdentifier`
    bodyKind = BODY_EXPR;
    if (isIdentifier()) {
      takeAsName();
      const name = noteIdentifier(lx$.atom, lx$.start);
      bodyA = pushExprIdent(lx$.start, lx$.end, name);
      next();
    } else {
      bodyA = missingExpression(0);
    }
    bodyB = 0;
    open = 0;
  }
  // "Given: x ? y => ({ y }) : z => ({ z }) .. we only allow a return type if it is followed by a colon"
  if (!allowReturnType && hasReturnColon && lx$.token !== T_COLON) return NONE;
  if (hasFailed()) return NONE;
  if (p$.isJavascript) jsErrorAtType(ret, 8010);
  const func = hir$.pushFn(FN_ARROW, flags, ATOM_NONE, start, typeParamsStart, typeParamsLen, paramsStart, paramsLen, thisParam, ret, bodyKind, bodyA, bodyB, anchor, start);
  if (bodyKind === BODY_BLOCK) hir$.pushBodyStart(func, open);
  // TODO(jsdoc): `function_jsdoc(func, start)`
  return pushExprFn(start, lx$.fullStart, func);
}

/** `typeHasArrowFunctionBlockingParseError`, of a type in which an error was reported. */
function hasArrowFunctionBlockingParseError(ty0: number): boolean {
  let t = ty0;
  const hir$ = hir;
  for (;;) {
    if (t < 0 || t >= hir$.nTypes) return false;
    const tag = hir$.typeTag[t] | 0;
    if (tag === TYPE_REF) {
      if (typeRefNameLen(t) !== 1) return false;
      const first = hir$.ids[typeRefNameStart(t)] | 0;
      return (hir$.nameText[first] | 0) === A_empty;
    }
    if (tag === TYPE_FN) {
      const f = typeFnFn(t);
      if (f < 0 || f >= hir$.nFns) return false;
      // `isMissingNodeList`: `anchor` is where `parseParameters` has started.
      if ((hir$.text[hir$.fnAnchor[f] | 0] | 0) !== 40) return true;
      t = hir$.fnRet[f] | 0;
      continue;
    }
    return false;
  }
}

/**
 * `parseArrowFunctionExpressionBody`: returns the kind of the body (BODY_BLOCK: the list is `p.outA` (start) and `p.outB`
 * (length), and the position of its `{` is `p.outPos`; BODY_EXPR: the expression is `p.outA`).
 */
function arrowFunctionBody(flags: number, allowReturnType: boolean): number {
  const context = signatureContext(flags);
  const lx$ = lx;
  const p$ = p;
  if (lx$.token === T_OPEN_BRACE) {
    const list = functionBlock(context);
    p$.outA = list;
    p$.outB = p$.outLen | 0;
    return BODY_BLOCK;
  }
  // It starts a statement and no expression statement: a block whose `{` is missing.
  if (lx$.token === T_AT) failUnlessRecovering();
  // `isStartOfExpressionStatement`
  if (p$.recovers && lx$.token !== T_SEMICOLON && lx$.token !== T_FUNCTION && lx$.token !== T_CLASS && isStartOfStatement() && (lx$.token === T_AT || !isStartOfExpression())) {
    const list = functionBlock(context);
    p$.outA = list;
    p$.outB = p$.outLen | 0;
    return BODY_BLOCK;
  }
  const saved = enterContext(context, CTX_YIELD | CTX_AWAIT | CTX_TOP_LEVEL);
  const body = assignmentExpressionOrHigher(allowReturnType);
  p$.context = saved;
  p$.outA = body;
  p$.outB = 0;
  p$.outPos = 0;
  return BODY_EXPR;
}

/**
 * `parseSimpleArrowFunctionExpression`, at the `=>`. `name`: that of the parameter, with its start `pos_`, its end and its full
 * start `full`.
 */
export function simpleArrowFunction(
  name: number,
  pos_: number,
  end: number,
  full: number,
  isAsync: boolean,
  start: number,
  allowReturnType: boolean,
): number {
  const pat = pushPatIdent(pos_, end, name);
  const hir$ = hir;
  const param = hir$.pushParam(pat, NONE, NONE, 0, pos_, full, end, 0, 0);
  const lx$ = lx;
  const anchor = lx$.start | 0;
  next();
  const flags = isAsync ? FLAG_ASYNC : 0;
  // note_parameters: Declared is off
  const bodyKind = arrowFunctionBody(flags, allowReturnType);
  const p$ = p;
  const bodyA = p$.outA | 0;
  const bodyB = p$.outB | 0;
  const open = p$.outPos | 0;
  const paramsStart = hir$.pushId(param);
  const func = hir$.pushFn(FN_ARROW, flags, ATOM_NONE, start, 0, 0, paramsStart, 1, NONE, NONE, bodyKind, bodyA, bodyB, anchor, start);
  if (bodyKind === BODY_BLOCK) hir$.pushBodyStart(func, open);
  // TODO(jsdoc): `function_jsdoc(func, start)`
  return pushExprFn(start, lx$.fullStart, func);
}

