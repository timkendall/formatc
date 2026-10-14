// Port of vendor/bun/src/sema/parser/parser/flow.rs: Flow's types and declarations as `flow-parser` reads them (`Dialect::flow`).
//
// The HIR has no node of its own for any of it: it is TypeScript's nodes, as the table at the top of flow.rs says. Conventions: those of
// mod.ts (module-level `lx`, `p`, `s`; free functions; several results via `p.outPos/outLen/outA/outB`). A function that returns a list
// returns its start and leaves the length in `p.outLen`. `Option<Id>` is -1.
import {
  BIN_AND,
  BIN_BIT_OR,
  BIN_COMMA,
  BIN_IN,
  BODY_BLOCK,
  BODY_NONE,
  CHAIN_NO,
  EXPR_CALL,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_INDEX,
  EXPR_INSTANTIATION,
  EXPR_SPREAD,
  FLAG_ABSTRACT,
  FLAG_AMBIENT,
  FLAG_ASYNC,
  FLAG_COMPUTED_NAME,
  FLAG_CONST,
  FLAG_DEFAULT,
  FLAG_EXPORT,
  FLAG_GENERATOR,
  FLAG_IN,
  FLAG_LITERAL_NAME,
  FLAG_OPTIONAL,
  FLAG_OUT,
  FLAG_READONLY,
  FLAG_REST,
  FLAG_STATIC,
  FLAG_STRING_NAME,
  FN_CALL_SIGNATURE,
  FN_DECL,
  FN_FUNCTION_TYPE,
  FN_GETTER,
  FN_INDEX_SIGNATURE,
  FN_METHOD,
  FN_SETTER,
  JSD_NULLABLE,
  KW_ANY,
  KW_BIG_INT,
  KW_NEVER,
  KW_NULL,
  KW_NUMBER,
  KW_STRING,
  KW_SYMBOL,
  KW_THIS,
  KW_UNDEFINED,
  KW_UNKNOWN,
  KW_VOID,
  MEMBER_CALL_SIGNATURE,
  MEMBER_GETTER,
  MEMBER_INDEX_SIGNATURE,
  MEMBER_METHOD,
  MEMBER_PROPERTY,
  MEMBER_SETTER,
  MM_ADD,
  MM_NONE,
  MM_REMOVE,
  MODK_DECORATOR,
  MODK_KEYWORD,
  NK_IDENTIFIER,
  NK_NUMERIC_LITERAL,
  NK_STRING_LITERAL,
  NONE,
  PAT_IDENT,
  PK_COMPUTED,
  PK_NAME,
  PK_NONE,
  PK_PRIVATE,
  PROP_INIT,
  PROP_SPREAD,
  TM_PLAIN,
  UN_MINUS,
  UN_PLUS,
  UN_VOID,
  hir,
  pushExprArray,
  pushExprAs,
  pushExprBinary,
  pushExprCall,
  pushExprDot,
  pushExprIdent,
  pushExprIndex,
  pushExprMissing,
  pushExprNew,
  pushExprObject,
  pushExprSpread,
  pushExprUnary,
  pushPatIdent,
  pushStmtEnum,
  pushStmtFn,
  pushStmtClass,
  pushStmtInterface,
  pushStmtSwitch,
  pushStmtTypeAlias,
  pushTypeArray,
  pushTypeBigIntLit,
  pushTypeBoolLit,
  pushTypeCond,
  pushTypeFn,
  pushTypeIndexedAccess,
  pushTypeInfer,
  pushTypeIntersection,
  pushTypeJSDoc,
  pushTypeKeyof,
  pushTypeKeyword,
  pushTypeMapped,
  pushTypeNumberLit,
  pushTypeObject,
  pushTypePredicate,
  pushTypeRef,
  pushTypeStringLit,
  pushTypeTuple,
  pushTypeTypeof,
  pushTypeUnion,
  pushTypeUnique,
} from "../../hir.ts";
import { A_default, A_this, ATOM_NONE } from "../../atom.ts";
import {
  T_AMPERSAND,
  T_AS,
  T_ASSERTS,
  T_ASTERISK,
  T_ASYNC,
  T_AT,
  T_BAR,
  T_BAR_BAR,
  T_BIG_INT,
  T_BOOLEAN,
  T_CLOSE_BRACE,
  T_CLOSE_BRACKET,
  T_CLOSE_PAREN,
  T_COLON,
  T_COMMA,
  T_CONST,
  T_DOT,
  T_DOT_DOT_DOT,
  T_EQUALS,
  T_EQUALS_GREATER_THAN,
  T_EXTENDS,
  T_FALSE,
  T_GET,
  T_GREATER_THAN,
  T_IDENTIFIER,
  T_IF,
  T_IMPLEMENTS,
  T_IN,
  T_INFER,
  T_IS,
  T_INTERFACE,
  T_KEY_OF,
  T_LESS_THAN,
  T_LESS_THAN_LESS_THAN,
  T_LET,
  T_MINUS,
  T_NEVER,
  T_NULL,
  T_NUMBER,
  T_NUMBER_KEYWORD,
  T_OF,
  T_OPEN_BRACE,
  T_OPEN_BRACKET,
  T_OPEN_PAREN,
  T_OUT,
  T_PERCENT,
  T_PLUS,
  T_PRIVATE_IDENTIFIER,
  T_QUESTION,
  T_QUESTION_DOT,
  T_QUESTION_QUESTION,
  T_READONLY,
  T_SEMICOLON,
  T_SET,
  T_STATIC,
  T_STRING,
  T_STRING_KEYWORD,
  T_SUPER,
  T_SYMBOL,
  T_THIS,
  T_TRUE,
  T_TYPE,
  T_TYPE_OF,
  T_UNDEFINED,
  T_UNKNOWN,
  T_VAR,
  T_VOID,
  T_BIG_INT_KEYWORD,
  T_ANY,
  T_EOF,
  isIdentifierOrKeyword,
} from "../token.ts";
import {
  CTX_AMBIENT,
  CTX_AWAIT,
  CTX_DECORATOR,
  CTX_DISALLOW_CONDITIONAL_TYPES,
  CTX_DISALLOW_IN,
  CTX_NO_ANONYMOUS_FUNCTION_TYPE,
  CTX_NO_RECORD,
  CTX_TOP_LEVEL,
  CTX_TYPE,
  CTX_YIELD,
  ambient,
  atom,
  atomText,
  eat,
  enterContext,
  enterDepth,
  expect,
  fail,
  hasContext,
  identifier,
  identifierName,
  isIdentifier,
  isInList,
  leaveDepth,
  lookAheadEnd,
  lookAheadParsingBegin,
  lookAheadParsingEnd,
  lx,
  p,
  peek,
  s,
  semicolon,
  takeIds,
  takeList,
  tokenSrcText,
  tryParseBegin,
  tryParseEnd,
  srcText,
} from "./mod.ts";
import { finishStmt, modifiers as _unused, optionalInitializer, takeModifiers, block } from "./stmt.ts";
import {
  assignmentExpression,
  expressionAllowingIn,
  isParenthesized,
  objectLiteral,
  primaryExpression,
  propertyName,
} from "./expr.ts";
import { functionBlock, functionRest, typeParameters } from "./func.ts";
import { identifierOrPattern } from "./pattern.ts";
import { negativeLiteralType, typeAnnotation, typeQuery } from "./ty.ts";
import { flagsOfMemberName } from "./class.ts";
import { BODY_TYPE, BODY_INTERFACE, BODY_CLASS, NO_EXPR } from "./flow.consts.ts";
export { NO_EXPR } from "./flow.consts.ts";

void _unused;


// ───────────────────────────── tokens ─────────────────────────────

/** Whether the token is the name `word`, which is no keyword of TypeScript's. */
function isWord(word: string): boolean {
  const lx$ = lx;
  if (lx$.token !== T_IDENTIFIER || lx$.hasEscape) return false;
  const start = lx$.start | 0;
  const n = (lx$.end - start) | 0;
  if (n !== word.length) return false;
  const src = lx$.src;
  for (let i = 0; i < n; i++) if ((src[(start + i) | 0] | 0) !== word.charCodeAt(i)) return false;
  return true;
}

/** Whether the text of the name `atom` is `word`. */
function atomIs(a: number, word: string): boolean {
  if (a < 0) return false;
  const lx$ = lx;
  const n = lx$.textLen(a) | 0;
  if (n !== word.length) return false;
  const buf = lx$.textBuf(a);
  const at = lx$.textStart(a) | 0;
  for (let i = 0; i < n; i++) if ((buf[(at + i) | 0] | 0) !== word.charCodeAt(i)) return false;
  return true;
}

/** Reads the first byte of the token as the token `first`. */
function splitToken(first: number): void {
  const lx$ = lx;
  lx$.token = first;
  lx$.end = (lx$.start + 1) | 0;
}

/** Whether the token is directly followed by `byte`. */
function isDirectlyBefore(byte: number): boolean {
  const lx$ = lx;
  const at = lx$.end | 0;
  return at < (lx$.len | 0) && (lx$.src[at] | 0) === byte;
}

/** Pushes the token on the stack of modifiers. */
function modifierToken(flag: number): void {
  const lx$ = lx;
  s.modifiers.push(hir.pushModifier(MODK_KEYWORD, flag, lx$.start));
  lx$.next();
}

/** Any word, which is consumed: its text. Its start is `p.outPos`, its end `p.outA`. */
function word(): number {
  const end = lx.end | 0;
  const name = identifierName();
  p.outA = end;
  return name;
}

/** Whether the top of the stack of expressions is the identifier `word` that starts at `pos` and is the expression `e`. */
function lastIdentifier(e: number, pos: number): number {
  const hir$ = hir;
  const last = (hir$.nExprs - 1) | 0;
  if (last < 0 || e + 1 !== hir$.nExprs) return ATOM_NONE;
  if ((hir$.exprTag[last] | 0) !== EXPR_IDENT || (hir$.exprPos[last] | 0) !== pos) return ATOM_NONE;
  return hir$.exprA[last] | 0;
}

// ───────────────────────────── types ─────────────────────────────

/** A type. */
export function flowType(): number {
  return flowTypeIn(0);
}

/** A type, in the context `context` beside that of all types. */
function flowTypeIn(context: number): number {
  if (!enterDepth()) return NONE;
  const cleared = CTX_YIELD | CTX_AWAIT | CTX_DISALLOW_CONDITIONAL_TYPES | CTX_NO_ANONYMOUS_FUNCTION_TYPE;
  const saved = enterContext(CTX_TYPE | context, cleared);
  const lx$ = lx;
  const start = lx$.start | 0;
  let t = flowUnionType();
  const p$ = p;
  if (eat(T_EXTENDS)) {
    // `A extends infer B extends C ? D : E` is `A extends (infer B extends C) ? D : E`.
    const outer = enterContext(CTX_DISALLOW_CONDITIONAL_TYPES, 0);
    const extendsTy = flowUnionType();
    p$.context = outer;
    expect(T_QUESTION);
    const yes = flowType();
    expect(T_COLON);
    const no = flowType();
    t = pushTypeCond(start, lx$.fullStart, t, extendsTy, yes, no);
  }
  p$.context = saved;
  leaveDepth();
  return t;
}

/** Whether the token is the `|` of a union: not that of `|}`. */
function isAtUnionOperator(): boolean {
  return lx.token === T_BAR && !isDirectlyBefore(125);
}

function flowUnionType(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  if (isAtUnionOperator()) lx$.next();
  const first = flowIntersectionType();
  if (!isAtUnionOperator()) return first;
  const s$ = s;
  const base = s$.ids.len;
  s$.ids.push(first);
  while (isAtUnionOperator()) {
    lx$.next();
    const member = flowIntersectionType();
    s$.ids.push(member);
  }
  const members = takeIds(base);
  return pushTypeUnion(start, lx$.fullStart, members, p.outLen);
}

function flowIntersectionType(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  eat(T_AMPERSAND);
  const first = flowFunctionTypeWithoutParentheses();
  if (lx$.token !== T_AMPERSAND) return first;
  const s$ = s;
  const base = s$.ids.len;
  s$.ids.push(first);
  while (eat(T_AMPERSAND)) {
    const member = flowFunctionTypeWithoutParentheses();
    s$.ids.push(member);
  }
  const members = takeIds(base);
  return pushTypeIntersection(start, lx$.fullStart, members, p.outLen);
}

/** `A`, `A => B` */
function flowFunctionTypeWithoutParentheses(): number {
  const lx$ = lx;
  const startPos = lx$.start | 0;
  const startFull = lx$.fullStart | 0;
  const t = flowPrefixType();
  if (lx$.token !== T_EQUALS_GREATER_THAN || hasContext(CTX_NO_ANONYMOUS_FUNCTION_TYPE)) return t;
  const s$ = s;
  const base = s$.params.len;
  pushUnnamedParameter(startPos, startFull, t, 0);
  const params = takeList(s$.params, base);
  return flowFunctionTypeRest(startPos, 0, 0, NONE, params, p.outLen | 0, startPos);
}

/** A parameter of a function type that is only the type `t`. */
function pushUnnamedParameter(startPos: number, startFull: number, t: number, flags: number): void {
  s.params.push(hir.pushParam(NONE, t, NONE, flags, startPos, startFull, lx.fullStart, 0, 0));
}

/** From the `=>` of a function type that starts at `start`. `anchor`: the `(` of its parameters. */
function flowFunctionTypeRest(start: number, tpStart: number, tpLen: number, thisParam: number, pStart: number, pLen: number, anchor: number): number {
  expect(T_EQUALS_GREATER_THAN);
  const ret = flowReturnType(p.context & CTX_NO_ANONYMOUS_FUNCTION_TYPE);
  const func = hir.pushFn(FN_FUNCTION_TYPE, 0, ATOM_NONE, start, tpStart, tpLen, pStart, pLen, thisParam, ret, BODY_NONE, 0, 0, anchor, start);
  return pushTypeFn(start, lx.fullStart, func);
}

function isNameToken(): boolean {
  return lx.token === T_THIS || isIdentifier();
}

/** `T`, `x is T`, `implies x is T`, `asserts x`, `asserts x is T` */
function flowReturnType(context: number): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  let hasPrefix = false;
  if (lx$.token === T_ASSERTS || isWord("implies")) {
    const m = lx$.mark();
    const had = lx$.refusal | 0;
    lx$.next();
    hasPrefix = isNameToken();
    lookAheadEnd(m, had);
  }
  const isGuard = hasPrefix || (isNameToken() && peek() === T_IS);
  if (!isGuard) return flowTypeIn(context);
  if (hasPrefix) lx$.next();
  const param = word();
  const t = eat(T_IS) ? flowTypeIn(context) : NONE;
  return pushTypePredicate(start, lx$.fullStart, param, t, hasPrefix ? 1 : 0);
}

/**
 * What follows the `:` after the parameters of a function with a body, of an arrow function (`context`: no function type without
 * parentheses) or of `declare function`.
 */
function flowReturnTypeAndPredicate(context: number): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  const t = lx$.token === T_PERCENT ? NONE : flowReturnType(context);
  if (lx$.token !== T_PERCENT) return t;
  lx$.next();
  if (!isWord("checks")) fail();
  lx$.next();
  if (lx$.token !== T_OPEN_PAREN) return pushTypePredicate(start, lx$.fullStart, atom("%checks"), t, 0);
  lx$.next();
  const saved = enterContext(0, CTX_TYPE | CTX_DISALLOW_IN);
  const e = assignmentExpression();
  const p$ = p;
  p$.context = saved;
  expect(T_CLOSE_PAREN);
  let argsStart = 0;
  let argsLen = 0;
  const s$ = s;
  if (t >= 0) {
    const base = s$.ids.len;
    s$.ids.push(t);
    argsStart = takeIds(base);
    argsLen = p$.outLen | 0;
  }
  return pushTypeTypeof(start, lx$.fullStart, 0, 0, argsStart, argsLen, e, 0);
}

/** The return type of a function with a body. */
export function flowReturnTypeOfFunction(): number {
  return flowReturnTypeAndPredicate(0);
}

/** The return type of an arrow function: in `(a): B => c` it is `B`. */
export function flowReturnTypeOfArrowFunction(): number {
  return flowReturnTypeAndPredicate(CTX_NO_ANONYMOUS_FUNCTION_TYPE);
}

/** `?T` */
function flowPrefixType(): number {
  if (!enterDepth()) return NONE;
  const lx$ = lx;
  if (lx$.token === T_QUESTION_QUESTION) splitToken(T_QUESTION);
  let t: number;
  if (lx$.token !== T_QUESTION) {
    t = flowPostfixType();
  } else {
    const start = lx$.start | 0;
    lx$.next();
    const operand = flowPrefixType();
    t = pushTypeJSDoc(start, lx$.fullStart, operand, JSD_NULLABLE);
  }
  leaveDepth();
  return t;
}

/** `T[]`, `T[K]`, `T?.[K]` */
function flowPostfixType(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  let t = flowPrimaryType();
  while ((lx$.token === T_OPEN_BRACKET || lx$.token === T_QUESTION_DOT) && !lx$.newlineBefore) {
    const isOptional = eat(T_QUESTION_DOT);
    expect(T_OPEN_BRACKET);
    if (!isOptional && eat(T_CLOSE_BRACKET)) {
      t = pushTypeArray(start, lx$.fullStart, t);
      continue;
    }
    const index = flowType();
    expect(T_CLOSE_BRACKET);
    t = pushTypeIndexedAccess(start, lx$.fullStart, t, index);
  }
  return t;
}

/** A type that is the token, which is consumed. */
function tokenKeyword(keyword: number): number {
  const lx$ = lx;
  const id = pushTypeKeyword(lx$.start, lx$.end, keyword);
  lx$.next();
  return id;
}

function flowPrimaryType(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  let keyword = -1;
  const p$ = p;
  switch (lx$.token) {
    case T_ANY:
      keyword = KW_ANY;
      break;
    case T_UNKNOWN:
      keyword = KW_UNKNOWN;
      break;
    case T_NEVER:
      keyword = KW_NEVER;
      break;
    case T_UNDEFINED:
      keyword = KW_UNDEFINED;
      break;
    case T_NUMBER_KEYWORD:
      keyword = KW_NUMBER;
      break;
    case T_STRING_KEYWORD:
      keyword = KW_STRING;
      break;
    case T_SYMBOL:
      keyword = KW_SYMBOL;
      break;
    case T_BIG_INT_KEYWORD:
      keyword = KW_BIG_INT;
      break;
    case T_VOID:
      keyword = KW_VOID;
      break;
    case T_NULL:
      keyword = KW_NULL;
      break;
    case T_THIS:
      keyword = KW_THIS;
      break;
    case T_TRUE: {
      const id = pushTypeBoolLit(lx$.start, lx$.end, 1);
      lx$.next();
      return id;
    }
    case T_FALSE: {
      const id = pushTypeBoolLit(lx$.start, lx$.end, 0);
      lx$.next();
      return id;
    }
    case T_STRING: {
      const id = pushTypeStringLit(lx$.start, lx$.end, lx$.atom);
      lx$.next();
      return id;
    }
    case T_NUMBER: {
      const number = hir.pushNumber(lx$.number);
      const id = pushTypeNumberLit(lx$.start, lx$.end, number);
      lx$.next();
      return id;
    }
    case T_BIG_INT: {
      const id = pushTypeBigIntLit(lx$.start, lx$.end, lx$.atom, 0);
      lx$.next();
      return id;
    }
    case T_MINUS:
      return negativeLiteralType();
    case T_ASTERISK:
      return flowTypeCalled("*");
    case T_BOOLEAN:
      return flowTypeCalled("boolean");
    case T_LESS_THAN:
    case T_LESS_THAN_LESS_THAN: {
      const tpStart = flowTypeParameters();
      const tpLen = p$.outLen | 0;
      const anchor = lx$.start | 0;
      flowFunctionTypeParameters();
      return flowFunctionTypeRest(start, tpStart, tpLen, p$.outB | 0, p$.outA | 0, p$.outLen | 0, anchor);
    }
    case T_OPEN_PAREN:
      return flowFunctionTypeOrGroup();
    case T_OPEN_BRACE: {
      const members = flowObjectTypeMembers(BODY_TYPE);
      return pushTypeObject(start, lx$.fullStart, members, p$.outLen);
    }
    case T_OPEN_BRACKET:
      return flowTupleType();
    case T_TYPE_OF:
      return typeQuery();
    case T_INTERFACE:
      return flowInterfaceType();
    case T_KEY_OF: {
      lx$.next();
      const operand = flowPrefixType();
      return pushTypeKeyof(start, lx$.fullStart, operand);
    }
    case T_INFER:
      return flowInferType();
    case T_IDENTIFIER:
      if (isWord("bool")) return flowTypeCalled("boolean");
      if (isWord("renders")) return flowRendersType(false);
      if (isWord("component")) return flowComponentType();
      if (isWord("hook")) {
        const n = peek();
        if (n === T_OPEN_PAREN || n === T_LESS_THAN) {
          lx$.next();
          const tpStart = typeParameters();
          const tpLen = p$.outLen | 0;
          const anchor = lx$.start | 0;
          flowFunctionTypeParameters();
          return flowFunctionTypeRest(start, tpStart, tpLen, p$.outB | 0, p$.outA | 0, p$.outLen | 0, anchor);
        }
      }
      return flowGenericType();
    default:
      return flowGenericType();
  }
  return tokenKeyword(keyword);
}

/** `renders T`, `renders? T`, `renders* T`. `isOfDeclaration`: after the parameters of a component that is declared, where `T` can be a union. */
function flowRendersType(isOfDeclaration: boolean): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  const hasMark = isDirectlyBefore(63) || isDirectlyBefore(42);
  lx$.next();
  if (hasMark) {
    if (lx$.token === T_QUESTION_QUESTION) splitToken(T_QUESTION);
    lx$.next();
  }
  const operand = isOfDeclaration ? flowType() : flowPrefixType();
  return pushTypeUnique(start, lx$.fullStart, operand);
}

/** `infer A`, `infer A extends B` */
function flowInferType(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  lx$.next();
  const name = identifier();
  const pos = p.outPos | 0;
  let constraint = NONE;
  if (lx$.token === T_EXTENDS) {
    const cp = tryParseBegin();
    if (cp >= 0) {
      lx$.next();
      const c = flowUnionType();
      // In `infer A extends B ? C : D` it is the `extends` of the conditional type.
      const isConstraint = hasContext(CTX_DISALLOW_CONDITIONAL_TYPES) || lx$.token !== T_QUESTION;
      if (tryParseEnd(cp, isConstraint)) constraint = c;
    }
  }
  const param = hir.pushTypeParam(name, pos, pos, lx$.fullStart, constraint, NONE, 0, 0, 0);
  return pushTypeInfer(start, lx$.fullStart, param);
}

/** The token as a reference to the type `name`. */
function flowTypeCalled(name: string): number {
  const a = atom(name);
  const s$ = s;
  const base = s$.names.len;
  const lx$ = lx;
  s$.names.push(hir.pushName(a, lx$.start, 0));
  const nameStart = takeList(s$.names, base);
  const nameLen = p.outLen | 0;
  const id = pushTypeRef(lx$.start, lx$.end, nameStart, nameLen, 0, 0);
  lx$.next();
  return id;
}

/** `A.B<C>` */
function flowGenericType(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  const s$ = s;
  const base = s$.names.len;
  let qualified = 0;
  const hir$ = hir;
  const p$ = p;
  while (true) {
    const name = identifierName();
    s$.names.push(hir$.pushName(name, p$.outPos, qualified));
    qualified = 1;
    if (!eat(T_DOT)) break;
  }
  const nameStart = takeList(s$.names, base);
  const nameLen = p$.outLen | 0;
  let argsStart = 0;
  let argsLen = 0;
  if (lx$.token === T_LESS_THAN || lx$.token === T_LESS_THAN_LESS_THAN) {
    argsStart = flowTypeArguments();
    argsLen = p$.outLen | 0;
  }
  return pushTypeRef(start, lx$.fullStart, nameStart, nameLen, argsStart, argsLen);
}

/** `A, B<C>` after `extends`, `mixins` or `implements`. */
function flowHeritage(): number {
  const s$ = s;
  const base = s$.ids.len;
  while (true) {
    const t = flowGenericType();
    s$.ids.push(t);
    if (!eat(T_COMMA)) break;
  }
  return takeIds(base);
}

/** `interface { }`, `interface extends A { }` */
function flowInterfaceType(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  lx$.next();
  const s$ = s;
  const base = s$.ids.len;
  if (eat(T_EXTENDS)) {
    while (true) {
      const t = flowGenericType();
      s$.ids.push(t);
      if (!eat(T_COMMA)) break;
    }
  }
  const open = lx$.start | 0;
  const members = flowObjectTypeMembers(BODY_INTERFACE);
  const p$ = p;
  const body = pushTypeObject(open, lx$.fullStart, members, p$.outLen);
  s$.ids.push(body);
  const parts = takeIds(base);
  return pushTypeIntersection(start, lx$.fullStart, parts, p$.outLen);
}

/** Type arguments, at the `<`. */
export function flowTypeArguments(): number {
  if (lx.token === T_LESS_THAN_LESS_THAN) splitToken(T_LESS_THAN);
  expect(T_LESS_THAN);
  const s$ = s;
  const base = s$.ids.len;
  while (isInList(T_GREATER_THAN)) {
    const t = flowType();
    s$.ids.push(t);
    if (!eat(T_COMMA)) break;
  }
  expect(T_GREATER_THAN);
  return takeIds(base);
}

/**
 * The type arguments of a call or of a record expression, at the `<`, if that is what it is: the list start (the length is in `p.outLen`),
 * or -1. `isInNew`: of a `new` expression, which needs no arguments.
 */
export function flowTypeArgumentsInExpression(isInNew: boolean): number {
  // flow-parser takes `async<T>(` for the start of an arrow function, which this is not.
  const p$ = p;
  const hir$ = hir;
  const lx$ = lx;
  if (!p$.isBabel) {
    const last = (hir$.nExprs - 1) | 0;
    if (last >= 0 && (hir$.exprTag[last] | 0) === EXPR_IDENT && (hir$.exprEnd[last] | 0) === (lx$.fullStart | 0) && atomIs(hir$.exprA[last] | 0, "async")) {
      fail();
      return -1;
    }
  }
  const cp = tryParseBegin();
  if (cp < 0) return -1;
  const args = flowTypeArguments();
  const len = p$.outLen | 0;
  const isBeforeBraces = lx$.token === T_OPEN_BRACE && !lx$.newlineBefore;
  const ok = isInNew || lx$.token === T_OPEN_PAREN || isBeforeBraces;
  if (!tryParseEnd(cp, ok)) return -1;
  p$.outLen = len;
  return args;
}

/** Type parameters, at the `<`. */
export function flowTypeParameters(): number {
  const lx$ = lx;
  if (lx$.token === T_LESS_THAN_LESS_THAN) splitToken(T_LESS_THAN);
  expect(T_LESS_THAN);
  const s$ = s;
  const base = s$.typeParams.len;
  while (true) {
    flowTypeParameter();
    if (!eat(T_COMMA) || lx$.token === T_GREATER_THAN) break;
  }
  expect(T_GREATER_THAN);
  return takeList(s$.typeParams, base);
}

function flowTypeParameter(): void {
  const lx$ = lx;
  const start = lx$.start | 0;
  const s$ = s;
  const firstModifier = s$.modifiers.len;
  let flags = 0;
  if (lx$.token === T_CONST) {
    flags = flags | FLAG_CONST;
    modifierToken(FLAG_CONST);
  }
  let variance = 0;
  const t = lx$.token;
  if (t === T_PLUS) {
    variance = FLAG_OUT;
  } else if (t === T_MINUS) {
    variance = FLAG_IN;
  } else if (t === T_IN || t === T_OUT) {
    // Each can be the name.
    const n = peek();
    if (isIdentifierOrKeyword(n) && n !== T_EXTENDS) variance = t === T_IN ? FLAG_IN : FLAG_OUT;
  }
  if (variance !== 0) {
    flags = flags | variance;
    modifierToken(variance);
  }
  const name = identifierName();
  const p$ = p;
  const pos = p$.outPos | 0;
  let constraint = NONE;
  if (lx$.token === T_COLON || lx$.token === T_EXTENDS) {
    lx$.next();
    constraint = flowType();
  }
  const defaultTy = eat(T_EQUALS) ? flowType() : NONE;
  const end = lx$.fullStart | 0;
  const modStart = takeModifiers(firstModifier);
  const modLen = p$.outLen | 0;
  s$.typeParams.push(hir.pushTypeParam(name, pos, start, end, constraint, defaultTy, flags, modStart, modLen));
}

/** Whether the token is a name that a `:` or `?:` follows: that of a parameter of a function type, of an element of a tuple, of an indexer. */
function isAtLabel(): boolean {
  const lx$ = lx;
  if (!isIdentifierOrKeyword(lx$.token) || lx$.token === T_PRIVATE_IDENTIFIER) return false;
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  lx$.next();
  eat(T_QUESTION);
  const r = lx$.token === T_COLON;
  lookAheadEnd(m, had);
  return r;
}

/** A parameter of a function type: `T`, `name: T`, `name?: T`, and each after `...`. */
function flowFunctionTypeParameter(): void {
  const lx$ = lx;
  const startPos = lx$.start | 0;
  const startFull = lx$.fullStart | 0;
  let flags = 0;
  if (eat(T_DOT_DOT_DOT)) flags = flags | FLAG_REST;
  if (!isAtLabel()) {
    const t = flowType();
    pushUnnamedParameter(startPos, startFull, t, flags);
    return;
  }
  const name = word();
  const p$ = p;
  const pos = p$.outPos | 0;
  const end = p$.outA | 0;
  const pat = pushPatIdent(pos, end, name);
  if (eat(T_QUESTION)) flags = flags | FLAG_OPTIONAL;
  expect(T_COLON);
  const t = flowType();
  s.params.push(hir.pushParam(pat, t, NONE, flags, startPos, startFull, lx$.fullStart, 0, 0));
}

/** Takes the parameters on the stack from `base` on: the `this` parameter (`p.outB`), and the others (`p.outA`, `p.outLen`). */
function takeFunctionTypeParameters(base: number): void {
  const list = takeList(s.params, base);
  const p$ = p;
  const len = p$.outLen | 0;
  const hir$ = hir;
  if (len > 0) {
    const first = hir$.ids[list] | 0;
    const pat = hir$.paramPat[first] | 0;
    if (pat >= 0 && (hir$.patTag[pat] | 0) === PAT_IDENT && (hir$.patA[pat] | 0) === A_this) {
      p$.outB = first;
      p$.outA = (list + 1) | 0;
      p$.outLen = (len - 1) | 0;
      return;
    }
  }
  p$.outB = NONE;
  p$.outA = list;
  p$.outLen = len;
}

/** The parameters of a function type, at the `(`: as `takeFunctionTypeParameters` leaves them. */
function flowFunctionTypeParameters(): void {
  expect(T_OPEN_PAREN);
  const base = s.params.len;
  flowFunctionTypeParameterList();
  expect(T_CLOSE_PAREN);
  takeFunctionTypeParameters(base);
}

/** Pushes the parameters up to the `)`. */
function flowFunctionTypeParameterList(): void {
  while (isInList(T_CLOSE_PAREN)) {
    flowFunctionTypeParameter();
    if (!eat(T_COMMA)) break;
  }
}

/** `(T)`, `(A, b: B) => C` */
function flowFunctionTypeOrGroup(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  lx$.next();
  const base = s.params.len;
  const allowsFunction = !hasContext(CTX_NO_ANONYMOUS_FUNCTION_TYPE);
  let isFunction = lx$.token === T_CLOSE_PAREN || lx$.token === T_DOT_DOT_DOT || isAtLabel();
  if (!isFunction) {
    const firstPos = lx$.start | 0;
    const firstFull = lx$.fullStart | 0;
    const t = flowType();
    isFunction = allowsFunction && (lx$.token === T_COMMA || (lx$.token === T_CLOSE_PAREN && peek() === T_EQUALS_GREATER_THAN));
    if (!isFunction) {
      expect(T_CLOSE_PAREN);
      return t;
    }
    pushUnnamedParameter(firstPos, firstFull, t, 0);
    eat(T_COMMA);
  }
  flowFunctionTypeParameterList();
  expect(T_CLOSE_PAREN);
  takeFunctionTypeParameters(base);
  const p$ = p;
  return flowFunctionTypeRest(start, 0, 0, p$.outB | 0, p$.outA | 0, p$.outLen | 0, start);
}

/** `[A, b: B, +c?: C, ...D, ...]` */
function flowTupleType(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  lx$.next();
  const s$ = s;
  const base = s$.tupleElems.len;
  while (isInList(T_CLOSE_BRACKET)) {
    flowTupleElement();
    if (!eat(T_COMMA)) break;
  }
  expect(T_CLOSE_BRACKET);
  const elems = takeList(s$.tupleElems, base);
  return pushTypeTuple(start, lx$.fullStart, elems, p.outLen);
}

function flowTupleElement(): void {
  const lx$ = lx;
  const start = lx$.start | 0;
  const hasDots = eat(T_DOT_DOT_DOT);
  let name = ATOM_NONE;
  let optional = false;
  let t = NONE;
  if (!hasDots) {
    const isVariance = lx$.token === T_PLUS || lx$.token === T_MINUS || isAtVarianceKeyword();
    if (isVariance) lx$.next();
  }
  if (isAtLabel()) {
    name = word();
    optional = eat(T_QUESTION);
    if (optional && hasDots) fail();
    expect(T_COLON);
  }
  // `...` alone: there can be more elements.
  if (!(hasDots && name === ATOM_NONE && lx$.token === T_CLOSE_BRACKET)) t = flowType();
  s.tupleElems.push(hir.pushTupleElem(t, t, TM_PLAIN, name, optional ? 1 : 0, hasDots ? 1 : 0, hasDots ? 1 : 0, start, lx$.fullStart));
}

/** Whether the token is `readonly` or `writeonly` before the name of a property, of an element of a tuple, or before an indexer. */
function isAtVarianceKeyword(): boolean {
  if (lx.token !== T_READONLY && !isWord("writeonly")) return false;
  const n = peek();
  return isIdentifierOrKeyword(n) || n === T_STRING || n === T_NUMBER || n === T_BIG_INT || n === T_OPEN_BRACKET;
}

/** The `+` or `-` before the name of a member of a class, which is no method. */
export function flowVariance(): void {
  flowVarianceToken();
  const cp = lookAheadParsingBegin();
  if (cp < 0) return;
  propertyName();
  const lx$ = lx;
  const isBeforeMethod = lx$.token === T_OPEN_PAREN || lx$.token === T_LESS_THAN;
  if (lookAheadParsingEnd(cp, isBeforeMethod)) fail();
}

/** Pushes `+`, `-`, `readonly` or `writeonly` on the stack of modifiers, if the token is one. */
function flowVarianceToken(): void {
  switch (lx.token) {
    case T_PLUS:
      modifierToken(FLAG_OUT);
      break;
    case T_MINUS:
      modifierToken(FLAG_IN);
      break;
    case T_READONLY:
      if (isAtVarianceKeyword()) modifierToken(FLAG_READONLY);
      break;
    case T_IDENTIFIER:
      if (isAtVarianceKeyword()) modifierToken(0);
      break;
    default:
      break;
  }
}

// ───────────────────────────── object types ─────────────────────────────

/** The members of an object type, at the `{`. The list start; the length is in `p.outLen`. */
function flowObjectTypeMembers(body: number): number {
  const p$ = p;
  if (!enterDepth()) {
    p$.outLen = 0;
    return 0;
  }
  const isExact = isDirectlyBefore(124);
  expect(T_OPEN_BRACE);
  const s$ = s;
  const base = s$.members.len;
  // `{||}`
  const lx$ = lx;
  if (lx$.token === T_BAR_BAR && isExact) splitToken(T_BAR);
  if (isExact) expect(T_BAR);
  const saved = enterContext(CTX_TYPE, 0);
  while (isInList(T_CLOSE_BRACE) && lx$.token !== T_BAR) {
    const member = flowObjectTypeMember(body);
    s$.members.push(member);
    if (lx$.token !== T_COMMA && lx$.token !== T_SEMICOLON) break;
    lx$.next();
  }
  p$.context = saved;
  if (isExact) expect(T_BAR);
  expect(T_CLOSE_BRACE);
  const list = takeList(s$.members, base);
  leaveDepth();
  return list;
}

/** From the type parameters of a method, an accessor or a call property to its return type. */
function flowMethodSignature(kind: number, flags: number, name: number, namePos: number, start: number): number {
  const tpStart = typeParameters();
  const p$ = p;
  const tpLen = p$.outLen | 0;
  const anchor = lx.start | 0;
  flowFunctionTypeParameters();
  const thisParam = p$.outB | 0;
  const pStart = p$.outA | 0;
  const pLen = p$.outLen | 0;
  expect(T_COLON);
  const ret = flowReturnType(0);
  return hir.pushFn(kind, flags, name, namePos, tpStart, tpLen, pStart, pLen, thisParam, ret, BODY_NONE, 0, 0, anchor, start);
}

/** The name of a property of an object type. `@@iterator` is one. */
function flowPropertyName(member: number): void {
  const lx$ = lx;
  const hir$ = hir;
  if (lx$.token === T_AT && isDirectlyBefore(64)) {
    const start = lx$.start | 0;
    lx$.next();
    lx$.next();
    const end = lx$.end | 0;
    identifierName();
    hir$.memberKeyKind[member] = PK_NAME;
    hir$.memberKeyVal[member] = atom(srcText(start, end));
    hir$.memberNamePos[member] = start;
    return;
  }
  if (lx$.token === T_OPEN_BRACKET) {
    fail();
    return;
  }
  propertyName();
  const p$ = p;
  hir$.memberKeyKind[member] = p$.keyKind | 0;
  hir$.memberKeyVal[member] = p$.keyVal | 0;
  hir$.memberNamePos[member] = p$.namePos | 0;
  const nameKind = p$.nameKind | 0;
  if (nameKind === NK_STRING_LITERAL) hir$.memberFlags[member] = hir$.memberFlags[member] | FLAG_STRING_NAME;
  else if (nameKind === NK_NUMERIC_LITERAL) hir$.memberFlags[member] = hir$.memberFlags[member] | FLAG_LITERAL_NAME;
}

function flowObjectTypeMember(body: number): number {
  const lx$ = lx;
  const startPos = lx$.start | 0;
  const startFull = lx$.fullStart | 0;
  const hir$ = hir;
  const member = hir$.newMember();
  hir$.memberNamePos[member] = startPos;
  hir$.memberStart[member] = startPos;
  const s$ = s;
  const firstModifier = s$.modifiers.len;
  flowObjectTypeMemberRest(body, startPos, startFull, member);
  // No method, accessor or call property has a variance.
  if ((hir$.memberFunc[member] | 0) >= 0 && (hir$.memberKind[member] | 0) !== MEMBER_INDEX_SIGNATURE) {
    const n = s$.modifiers.len;
    for (let i = firstModifier; i < n; i++) {
      const m = s$.modifiers.data[i] | 0;
      if ((hir$.modifierKind[m] | 0) === MODK_DECORATOR) continue;
      const flag = hir$.modifierValue[m] | 0;
      const isVariance = flag === 0 ? (lx$.src[hir$.modifierPos[m] | 0] | 0) === 119 : (flag & (FLAG_IN | FLAG_OUT | FLAG_READONLY)) !== 0;
      if (isVariance) {
        fail();
        break;
      }
    }
  }
  const modStart = takeModifiers(firstModifier);
  hir$.memberModStart[member] = modStart;
  hir$.memberModLen[member] = p.outLen | 0;
  hir$.memberLocPos[member] = startFull;
  hir$.memberLocEnd[member] = lx$.fullStart;
  return member;
}

function flowObjectTypeMemberRest(body: number, startPos: number, startFull: number, member: number): void {
  void startFull;
  const hir$ = hir;
  const lx$ = lx;
  if (eat(T_DOT_DOT_DOT)) {
    hir$.memberFlags[member] = hir$.memberFlags[member] | FLAG_REST;
    // `...` alone: there can be more properties.
    const t = lx$.token;
    if (t !== T_COMMA && t !== T_SEMICOLON && t !== T_CLOSE_BRACE && t !== T_BAR) hir$.memberTy[member] = flowType();
    return;
  }
  // `static` and `proto` are names before these, and everywhere but in `declare class` before the parameters of a method.
  const isStatic = lx$.token === T_STATIC;
  if (isStatic || isWord("proto")) {
    const n = peek();
    let isModifier = true;
    if (n === T_COLON || n === T_QUESTION) isModifier = false;
    else if (n === T_OPEN_PAREN || n === T_LESS_THAN) isModifier = body === BODY_CLASS && isStatic;
    if (isModifier && isStatic) {
      hir$.memberFlags[member] = hir$.memberFlags[member] | FLAG_STATIC;
      modifierToken(FLAG_STATIC);
    } else if (isModifier) {
      modifierToken(0);
    }
  }
  flowVarianceToken();
  const t0 = lx$.token;
  if (t0 === T_OPEN_BRACKET) {
    flowBracketedMember(startPos, member);
    return;
  }
  if (t0 === T_OPEN_PAREN || t0 === T_LESS_THAN) {
    hir$.memberKind[member] = MEMBER_CALL_SIGNATURE;
    hir$.memberFunc[member] = flowMethodSignature(FN_CALL_SIGNATURE, hir$.memberFlags[member] | 0, ATOM_NONE, startPos, startPos);
    return;
  }
  let fnKind = FN_METHOD;
  if (t0 === T_GET || t0 === T_SET) {
    const n = peek();
    if (n !== T_COLON && n !== T_QUESTION && n !== T_OPEN_PAREN && n !== T_LESS_THAN) {
      if (t0 === T_GET) {
        hir$.memberKind[member] = MEMBER_GETTER;
        fnKind = FN_GETTER;
      } else {
        hir$.memberKind[member] = MEMBER_SETTER;
        fnKind = FN_SETTER;
      }
      lx$.next();
    }
  }
  flowPropertyName(member);
  if ((hir$.memberKind[member] | 0) !== MEMBER_PROPERTY || lx$.token === T_OPEN_PAREN || lx$.token === T_LESS_THAN) {
    if ((hir$.memberKind[member] | 0) === MEMBER_PROPERTY) hir$.memberKind[member] = MEMBER_METHOD;
    const keyKind = hir$.memberKeyKind[member] | 0;
    const name = keyKind === PK_NAME || keyKind === PK_PRIVATE ? hir$.memberKeyVal[member] | 0 : ATOM_NONE;
    const flags = (hir$.memberFlags[member] | 0) & ~FLAG_LITERAL_NAME;
    hir$.memberFunc[member] = flowMethodSignature(fnKind, flags, name, hir$.memberNamePos[member] | 0, startPos);
    return;
  }
  if (eat(T_QUESTION)) hir$.memberFlags[member] = hir$.memberFlags[member] | FLAG_OPTIONAL;
  expect(T_COLON);
  hir$.memberTy[member] = flowType();
}

/** `[[slot]]: T`, `[K]: V`, `[k: K]: V`, `[K in T]: V`, at the `[`. */
function flowBracketedMember(startPos: number, member: number): void {
  const lx$ = lx;
  const bracket = lx$.start | 0;
  lx$.next();
  const p$ = p;
  const hir$ = hir;
  if (eat(T_OPEN_BRACKET)) {
    const name = identifierName();
    const namePos = p$.outPos | 0;
    expect(T_CLOSE_BRACKET);
    expect(T_CLOSE_BRACKET);
    hir$.memberKeyKind[member] = PK_NAME;
    hir$.memberKeyVal[member] = name;
    hir$.memberNamePos[member] = namePos;
    hir$.memberFlags[member] = hir$.memberFlags[member] | FLAG_COMPUTED_NAME;
    if (lx$.token === T_OPEN_PAREN || lx$.token === T_LESS_THAN) {
      hir$.memberKind[member] = MEMBER_METHOD;
      hir$.memberFunc[member] = flowMethodSignature(FN_METHOD, hir$.memberFlags[member] | 0, name, namePos, startPos);
      return;
    }
    if (eat(T_QUESTION)) hir$.memberFlags[member] = hir$.memberFlags[member] | FLAG_OPTIONAL;
    expect(T_COLON);
    hir$.memberTy[member] = flowType();
    return;
  }
  if (isIdentifierOrKeyword(lx$.token) && peek() === T_IN) {
    hir$.memberTy[member] = flowMappedTypeProperty(startPos);
    return;
  }
  const s$ = s;
  const base = s$.params.len;
  flowFunctionTypeParameter();
  const params = takeList(s$.params, base);
  const paramsLen = p$.outLen | 0;
  expect(T_CLOSE_BRACKET);
  expect(T_COLON);
  const t = flowType();
  hir$.memberKind[member] = MEMBER_INDEX_SIGNATURE;
  hir$.memberTy[member] = t;
  hir$.memberFunc[member] = hir$.pushFn(
    FN_INDEX_SIGNATURE,
    hir$.memberFlags[member] | 0,
    ATOM_NONE,
    bracket,
    0,
    0,
    params,
    paramsLen,
    NONE,
    t,
    BODY_NONE,
    0,
    0,
    bracket,
    startPos,
  );
}

/** `[K in T]: V`, `[K in T]?: V`, at the `K`. `start`: of the member. */
function flowMappedTypeProperty(start: number): number {
  const name = identifierName();
  const pos = p.outPos | 0;
  expect(T_IN);
  const constraint = flowType();
  const lx$ = lx;
  const paramEnd = lx$.fullStart | 0;
  expect(T_CLOSE_BRACKET);
  let optional = MM_NONE;
  let isOptionalWithPlus = 0;
  switch (lx$.token) {
    case T_QUESTION:
      optional = MM_ADD;
      break;
    case T_PLUS:
      lx$.next();
      optional = MM_ADD;
      isOptionalWithPlus = 1;
      break;
    case T_MINUS:
      lx$.next();
      optional = MM_REMOVE;
      break;
    default:
      break;
  }
  if (optional !== MM_NONE) expect(T_QUESTION);
  expect(T_COLON);
  const t = flowType();
  const hir$ = hir;
  const param = hir$.pushTypeParam(name, pos, pos, paramEnd, constraint, NONE, 0, 0, 0);
  const mapped = hir$.pushMapped(param, NONE, t, MM_NONE, optional, 0, isOptionalWithPlus, 0, 0);
  return pushTypeMapped(start, lx$.fullStart, mapped);
}

// ───────────────────────────── expressions ─────────────────────────────

/** `(e: T)`, at the `:`. `open`: the position of the `(`. */
export function flowTypeCast(open: number, e: number): number {
  const lx$ = lx;
  lx$.next();
  const t = flowType();
  expect(T_CLOSE_PAREN);
  return pushExprAs(open, lx$.fullStart, e, t);
}

// ───────────────────────────── declarations ─────────────────────────────

/** Whether the token is a word that starts a declaration of Flow's and that is a name for TypeScript: `opaque type`, `component A`, `hook useA`. */
export function flowIsAtDeclarationWord(): boolean {
  const lx$ = lx;
  if (lx$.token !== T_IDENTIFIER) return false;
  const a = lx$.atom | 0;
  if (atomIs(a, "opaque")) return peek() === T_TYPE;
  if (atomIs(a, "component") || atomIs(a, "hook") || atomIs(a, "record")) {
    const m = lx$.mark();
    const had = lx$.refusal | 0;
    lx$.next();
    const r = isIdentifier() && !lx$.newlineBefore;
    lookAheadEnd(m, had);
    return r;
  }
  return false;
}

/**
 * What starts at `startPos` with `expression`, after which the token cannot end a statement: a declaration, if the expression is one of
 * the words that start one.
 */
export function flowDeclarationAfterExpression(startPos: number, startFull: number, expression: number): number {
  const lx$ = lx;
  if (lx$.token === T_OPEN_BRACE && !lx$.newlineBefore && flowIsMatchHead(expression)) return flowMatchStatement(startPos, startFull, expression);
  const word_ = lastIdentifier(expression, startPos);
  const s$ = s;
  const base = s$.modifiers.len;
  const isBeforeWord = flowIsAtDeclarationWord();
  let flag = 0;
  let first = -1;
  if (atomIs(word_, "async") && isBeforeWord) {
    flag = FLAG_ASYNC;
  } else if (atomIs(word_, "opaque")) {
    first = 111;
  } else if (atomIs(word_, "component")) {
    first = 99;
  } else if (atomIs(word_, "hook")) {
    first = 104;
  } else if (atomIs(word_, "record")) {
    first = 114;
  } else {
    fail();
    return NONE;
  }
  const hir$ = hir;
  hir$.nExprs = (hir$.nExprs - 1) | 0;
  s$.modifiers.push(hir$.pushModifier(MODK_KEYWORD, flag, startPos));
  if (first >= 0) return flowDeclarationAfterModifiers(startPos, startFull, base, 0, first);
  return flowDeclarationAtWord(startPos, startFull, base, FLAG_ASYNC);
}

/** A declaration whose modifiers, which are on the stack from `base` on, are followed by a word for which `flowIsAtDeclarationWord` holds. */
export function flowDeclarationAtWord(startPos: number, startFull: number, base: number, flags: number): number {
  if (!flowIsAtDeclarationWord()) {
    fail();
    return NONE;
  }
  const lx$ = lx;
  const first = lx$.src[lx$.start | 0] | 0;
  modifierToken(0);
  return flowDeclarationAfterModifiers(startPos, startFull, base, flags, first);
}

/** `first`: the first letter of the word, which is the last of the modifiers. */
function flowDeclarationAfterModifiers(startPos: number, startFull: number, base: number, flags: number, first: number): number {
  const isAmbient = (flags & FLAG_AMBIENT) !== 0 || hasContext(CTX_AMBIENT);
  if (first === 111) return flowOpaqueType(startPos, startFull, base, flags);
  if (first === 99) return flowComponent(startPos, startFull, base, flags);
  if (first === 114) return flowRecord(startPos, startFull, base, flags);
  if (isAmbient) return flowDeclareFunctionRest(startPos, startFull, base, flags);
  const name = identifier();
  const p$ = p;
  const namePos = p$.outPos | 0;
  const fnFlags = flags & (FLAG_EXPORT | FLAG_DEFAULT | FLAG_ASYNC);
  const func = functionRest(FN_DECL, fnFlags, name, namePos, startPos);
  const modStart = takeModifiers(base);
  return finishStmt(pushStmtFn(startPos, func), startFull, modStart, p$.outLen);
}

/** The modifiers on the stack from `base` on are before what has no decorators. */
export function flowRefuseDecorators(base: number): void {
  const s$ = s;
  const n = s$.modifiers.len;
  const hir$ = hir;
  for (let i = base; i < n; i++) {
    if ((hir$.modifierKind[s$.modifiers.data[i] | 0] | 0) === MODK_DECORATOR) {
      fail();
      return;
    }
  }
}

/**
 * The modifiers on the stack from `base` on, whose flags are `flags`, are not all JavaScript's. `declare` before `export` belongs to the
 * `export`, not to what is exported: it gets no flag.
 */
export function flowDeclareBeforeExport(base: number, flags: number): void {
  const both = FLAG_AMBIENT | FLAG_EXPORT;
  const s$ = s;
  const hir$ = hir;
  if ((flags & both) === both && s$.modifiers.len > base) {
    const first = s$.modifiers.data[base] | 0;
    if ((hir$.modifierKind[first] | 0) === MODK_KEYWORD && (hir$.modifierValue[first] | 0) === FLAG_AMBIENT) hir$.modifierValue[first] = 0;
  }
}

/** The name of a type that is declared, which is not that of a type of the language. The position is `p.outPos`. */
function flowTypeName(): number {
  switch (tokenSrcText()) {
    case "any":
    case "bigint":
    case "bool":
    case "boolean":
    case "empty":
    case "extends":
    case "false":
    case "interface":
    case "mixed":
    case "null":
    case "number":
    case "static":
    case "string":
    case "symbol":
    case "true":
    case "typeof":
    case "void":
      fail();
      break;
    default:
      break;
  }
  return identifier();
}

/** `type A<T> = B`, at `type`. */
export function flowTypeAlias(startPos: number, startFull: number, base: number, flags: number): number {
  lx.next();
  const name = flowTypeName();
  const p$ = p;
  const namePos = p$.outPos | 0;
  const tpStart = typeParameters();
  const tpLen = p$.outLen | 0;
  expect(T_EQUALS);
  const t = flowType();
  semicolon();
  return addAlias(startPos, startFull, base, flags, name, namePos, tpStart, tpLen, t);
}

function addAlias(startPos: number, startFull: number, base: number, flags: number, name: number, namePos: number, tpStart: number, tpLen: number, t: number): number {
  const alias = hir.pushAlias(name, namePos, flags | ambient(), tpStart, tpLen, t, NONE);
  const modStart = takeModifiers(base);
  return finishStmt(pushStmtTypeAlias(startPos, alias), startFull, modStart, p.outLen);
}

function addInterface(startPos: number, startFull: number, base: number, iface: number): number {
  const modStart = takeModifiers(base);
  return finishStmt(pushStmtInterface(startPos, iface), startFull, modStart, p.outLen);
}

/** `opaque type A<T>: B = C`, at `type`. */
function flowOpaqueType(startPos: number, startFull: number, base: number, flags: number): number {
  expect(T_TYPE);
  const name = identifier();
  const p$ = p;
  const namePos = p$.outPos | 0;
  const tpStart = typeParameters();
  const tpLen = p$.outLen | 0;
  const s$ = s;
  const bounds = s$.ids.len;
  if (eat(T_SUPER)) {
    const saved = enterContext(CTX_TYPE, 0);
    const lower = flowUnionType();
    p$.context = saved;
    s$.ids.push(lower);
  }
  if (eat(T_EXTENDS) || (s$.ids.len === bounds && eat(T_COLON))) {
    const upper = flowType();
    s$.ids.push(upper);
  }
  const extendsStart = takeIds(bounds);
  const extendsLen = p$.outLen | 0;
  let otherStart = 0;
  let otherLen = 0;
  if (eat(T_EQUALS)) {
    const t = flowType();
    const b = s$.ids.len;
    s$.ids.push(t);
    otherStart = takeIds(b);
    otherLen = p$.outLen | 0;
  }
  semicolon();
  const iface = hir.pushInterface(name, namePos, flags | ambient(), tpStart, tpLen, extendsStart, extendsLen, otherStart, otherLen, 0, 0, NONE);
  return addInterface(startPos, startFull, base, iface);
}

/** `interface A<T> extends B { }`, at `interface`. */
export function flowInterface(startPos: number, startFull: number, base: number, flags: number): number {
  lx.next();
  const name = identifier();
  const p$ = p;
  const namePos = p$.outPos | 0;
  const tpStart = typeParameters();
  const tpLen = p$.outLen | 0;
  let extendsStart = 0;
  let extendsLen = 0;
  if (eat(T_EXTENDS)) {
    extendsStart = flowHeritage();
    extendsLen = p$.outLen | 0;
  }
  const members = flowObjectTypeMembers(BODY_INTERFACE);
  const membersLen = p$.outLen | 0;
  const iface = hir.pushInterface(name, namePos, flags | ambient(), tpStart, tpLen, extendsStart, extendsLen, 0, 0, members, membersLen, NONE);
  return addInterface(startPos, startFull, base, iface);
}

/** `declare class A<T> extends B<T> mixins C implements D { }`, at `class`. */
export function flowDeclareClass(startPos: number, startFull: number, base: number, flags: number): number {
  flowRefuseDecorators(base);
  if ((flags & FLAG_ABSTRACT) !== 0) fail();
  const lx$ = lx;
  lx$.next();
  const name = identifier();
  const p$ = p;
  const namePos = p$.outPos | 0;
  const tpStart = typeParameters();
  const tpLen = p$.outLen | 0;
  let extendsExpr = NONE;
  let extendsArgsStart = 0;
  let extendsArgsLen = 0;
  if (eat(T_EXTENDS)) {
    const first = lx$.start | 0;
    while (true) {
      const w = word();
      const wPos = p$.outPos | 0;
      const wEnd = p$.outA | 0;
      extendsExpr = extendsExpr < 0 ? pushExprIdent(first, wEnd, w) : pushExprDot(first, wEnd, extendsExpr, w, wPos, CHAIN_NO);
      if (!eat(T_DOT)) break;
    }
    if (lx$.token === T_LESS_THAN) {
      extendsArgsStart = flowTypeArguments();
      extendsArgsLen = p$.outLen | 0;
    }
  }
  let otherImplementsStart = 0;
  let otherImplementsLen = 0;
  if (isWord("mixins")) {
    lx$.next();
    otherImplementsStart = flowHeritage();
    otherImplementsLen = p$.outLen | 0;
  }
  let implementsStart = 0;
  let implementsLen = 0;
  if (eat(T_IMPLEMENTS)) {
    implementsStart = flowHeritage();
    implementsLen = p$.outLen | 0;
  }
  const members = flowObjectTypeMembers(BODY_CLASS);
  const membersLen = p$.outLen | 0;
  const modStart = takeModifiers(base);
  const modLen = p$.outLen | 0;
  const cls = hir.pushClass(
    name,
    namePos,
    FLAG_AMBIENT | (flags & (FLAG_EXPORT | FLAG_DEFAULT)),
    tpStart,
    tpLen,
    extendsExpr,
    extendsArgsStart,
    extendsArgsLen,
    0,
    0,
    implementsStart,
    implementsLen,
    otherImplementsStart,
    otherImplementsLen,
    members,
    membersLen,
    startPos,
    modStart,
    modLen,
  );
  return finishStmt(pushStmtClass(startPos, cls), startFull, modStart, modLen);
}

/** `declare function f<T>(A, b: B): C %checks(e);`, at `function`. */
export function flowDeclareFunction(startPos: number, startFull: number, base: number, flags: number): number {
  lx.next();
  return flowDeclareFunctionRest(startPos, startFull, base, flags);
}

/** From the name of a function or a hook that is declared. */
function flowDeclareFunctionRest(startPos: number, startFull: number, base: number, flags: number): number {
  const name = identifier();
  const p$ = p;
  const namePos = p$.outPos | 0;
  const tpStart = typeParameters();
  const tpLen = p$.outLen | 0;
  const anchor = lx.start | 0;
  const saved = enterContext(CTX_TYPE, 0);
  flowFunctionTypeParameters();
  const thisParam = p$.outB | 0;
  const pStart = p$.outA | 0;
  const pLen = p$.outLen | 0;
  p$.context = saved;
  expect(T_COLON);
  const ret = flowReturnTypeAndPredicate(0);
  semicolon();
  const func = hir.pushFn(
    FN_DECL,
    FLAG_AMBIENT | (flags & (FLAG_EXPORT | FLAG_DEFAULT)),
    name,
    namePos,
    tpStart,
    tpLen,
    pStart,
    pLen,
    thisParam,
    ret,
    BODY_NONE,
    0,
    0,
    anchor,
    startPos,
  );
  const modStart = takeModifiers(base);
  return finishStmt(pushStmtFn(startPos, func), startFull, modStart, p$.outLen);
}

/** `declare module.exports: T;`, at `module`. */
export function flowDeclareModuleExports(startPos: number, startFull: number, base: number): number {
  const lx$ = lx;
  const namePos = lx$.start | 0;
  lx$.next();
  expect(T_DOT);
  if (!isWord("exports")) fail();
  lx$.next();
  expect(T_COLON);
  const t = flowType();
  semicolon();
  return addAlias(startPos, startFull, base, FLAG_AMBIENT, atom("module.exports"), namePos, 0, 0, t);
}

/** `declare export default T;`, at the `default`. `export` is not among the modifiers yet. */
export function flowDeclareExportDefaultType(startPos: number, startFull: number, base: number, exportPos: number): number {
  s.modifiers.push(hir.pushModifier(MODK_KEYWORD, FLAG_EXPORT, exportPos));
  flowDeclareBeforeExport(base, FLAG_AMBIENT | FLAG_EXPORT);
  const namePos = lx.start | 0;
  modifierToken(FLAG_DEFAULT);
  const t = flowType();
  semicolon();
  return addAlias(startPos, startFull, base, FLAG_AMBIENT | FLAG_EXPORT | FLAG_DEFAULT, A_default, namePos, 0, 0, t);
}

/** `enum A of string { B = "b", ... }`, at `enum`. */
export function flowEnum(startPos: number, startFull: number, base: number, flags: number): number {
  const lx$ = lx;
  lx$.next();
  const name = identifier();
  const p$ = p;
  const namePos = p$.outPos | 0;
  if (eat(T_OF)) identifierName();
  expect(T_OPEN_BRACE);
  const s$ = s;
  const members = s$.enumMembers.len;
  const hir$ = hir;
  while (isInList(T_CLOSE_BRACE)) {
    const memberPos = lx$.start | 0;
    const memberFull = lx$.fullStart | 0;
    let memberName = ATOM_NONE;
    let init = NONE;
    if (!eat(T_DOT_DOT_DOT)) {
      memberName = identifierName();
      init = optionalInitializer();
    }
    s$.enumMembers.push(hir$.pushEnumMember(memberName, NK_IDENTIFIER, NONE, init, memberPos, memberFull, lx$.fullStart));
    if (!eat(T_COMMA)) break;
  }
  expect(T_CLOSE_BRACE);
  const list = takeList(s$.enumMembers, members);
  const listLen = p$.outLen | 0;
  const decl = hir$.pushEnum(name, namePos, ambient() | (flags & FLAG_EXPORT), list, listLen, NONE);
  const modStart = takeModifiers(base);
  return finishStmt(pushStmtEnum(startPos, decl), startFull, modStart, p$.outLen);
}

// ───────────────────────────── components ─────────────────────────────

/** `component A<T>(a: B, 'c' as d: E = 1, ...f: G) renders H { }`, at the name. */
function flowComponent(startPos: number, startFull: number, base: number, flags: number): number {
  const isAmbient = (flags & FLAG_AMBIENT) !== 0 || hasContext(CTX_AMBIENT);
  const name = identifier();
  const p$ = p;
  const namePos = p$.outPos | 0;
  const tpStart = typeParameters();
  const tpLen = p$.outLen | 0;
  const lx$ = lx;
  const anchor = lx$.start | 0;
  const params = isAmbient ? flowComponentTypeParameters() : flowComponentParameters();
  const paramsLen = p$.outLen | 0;
  const ret = isWord("renders") ? flowRendersType(true) : NONE;
  const context = (flags & FLAG_ASYNC) !== 0 ? CTX_AWAIT : 0;
  // Where everything is declared, like in a `.js.flow` file, it has no body either.
  let bodyKind = BODY_NONE;
  let bodyA = 0;
  let bodyB = 0;
  let open = 0;
  if (lx$.token === T_OPEN_BRACE && !isAmbient) {
    bodyA = functionBlock(context);
    bodyB = p$.outLen | 0;
    open = p$.outPos | 0;
    bodyKind = BODY_BLOCK;
  } else {
    semicolon();
  }
  const kept = FLAG_AMBIENT | FLAG_EXPORT | FLAG_DEFAULT | FLAG_ASYNC;
  const hir$ = hir;
  const func = hir$.pushFn(FN_DECL, flags & kept, name, namePos, tpStart, tpLen, params, paramsLen, NONE, ret, bodyKind, bodyA, bodyB, anchor, startPos);
  if (bodyKind === BODY_BLOCK) hir$.pushBodyStart(func, open);
  const modStart = takeModifiers(base);
  return finishStmt(pushStmtFn(startPos, func), startFull, modStart, p$.outLen);
}

/** The parameters of a component with a body, at the `(`. */
function flowComponentParameters(): number {
  expect(T_OPEN_PAREN);
  const s$ = s;
  const base = s$.params.len;
  const lx$ = lx;
  const hir$ = hir;
  while (isInList(T_CLOSE_PAREN)) {
    const startPos = lx$.start | 0;
    const startFull = lx$.fullStart | 0;
    let flags = 0;
    if (eat(T_DOT_DOT_DOT)) {
      flags = flags | FLAG_REST;
    } else if (lx$.token === T_STRING || peek() === T_AS) {
      // The name that the caller gives it.
      lx$.next();
      expect(T_AS);
    }
    const pat = identifierOrPattern();
    if (eat(T_QUESTION)) flags = flags | FLAG_OPTIONAL;
    const t = typeAnnotation();
    const def = optionalInitializer();
    s$.params.push(hir$.pushParam(pat, t, def, flags, startPos, startFull, lx$.fullStart, 0, 0));
    if (!eat(T_COMMA)) break;
  }
  expect(T_CLOSE_PAREN);
  return takeList(s$.params, base);
}

/** The parameters of a component type, or of a component that is declared, at the `(`: `a: A`, `'b'?: B`, `...C`, `...c: C`. */
function flowComponentTypeParameters(): number {
  expect(T_OPEN_PAREN);
  const s$ = s;
  const base = s$.params.len;
  const saved = enterContext(CTX_TYPE, 0);
  const lx$ = lx;
  while (isInList(T_CLOSE_PAREN)) {
    if (lx$.token !== T_STRING) {
      flowFunctionTypeParameter();
    } else {
      const startPos = lx$.start | 0;
      const startFull = lx$.fullStart | 0;
      lx$.next();
      const flags = eat(T_QUESTION) ? FLAG_OPTIONAL : 0;
      expect(T_COLON);
      const t = flowType();
      pushUnnamedParameter(startPos, startFull, t, flags);
    }
    if (!eat(T_COMMA)) break;
  }
  p.context = saved;
  expect(T_CLOSE_PAREN);
  return takeList(s$.params, base);
}

/** `component<T>(a: A, ...B) renders C` */
function flowComponentType(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  lx$.next();
  const tpStart = typeParameters();
  const p$ = p;
  const tpLen = p$.outLen | 0;
  const anchor = lx$.start | 0;
  const params = flowComponentTypeParameters();
  const paramsLen = p$.outLen | 0;
  const ret = isWord("renders") ? flowRendersType(false) : NONE;
  const func = hir.pushFn(FN_FUNCTION_TYPE, 0, ATOM_NONE, start, tpStart, tpLen, params, paramsLen, NONE, ret, BODY_NONE, 0, 0, anchor, start);
  return pushTypeFn(start, lx$.fullStart, func);
}

// ───────────────────────────── match ─────────────────────────────

/** Whether `e`, which was just parsed, is `match (a)`, `match (a, b)`. */
function flowIsMatchHead(e: number): boolean {
  const hir$ = hir;
  if (e < 0 || e >= (hir$.nExprs | 0) || (hir$.exprTag[e] | 0) !== EXPR_CALL) return false;
  const call = hir$.exprA[e] | 0;
  const argsStart = hir$.callArgsStart[call] | 0;
  const argsLen = hir$.callArgsLen[call] | 0;
  if ((hir$.callChain[call] | 0) !== CHAIN_NO || (hir$.callTypeArgsLen[call] | 0) !== 0 || argsLen === 0) return false;
  for (let i = 0; i < argsLen; i++) {
    const argument = hir$.ids[(argsStart + i) | 0] | 0;
    if (argument >= 0 && argument < (hir$.nExprs | 0) && (hir$.exprTag[argument] | 0) === EXPR_SPREAD) return false;
  }
  const callee = hir$.callCallee[call] | 0;
  if (callee < 0 || callee >= (hir$.nExprs | 0)) return false;
  if ((hir$.exprTag[callee] | 0) !== EXPR_IDENT || ((hir$.exprEnd[callee] - hir$.exprPos[callee]) | 0) !== 5 || !atomIs(hir$.exprA[callee] | 0, "match")) return false;
  return !isParenthesized(e);
}

/**
 * At a `{` after `expression`, which starts at `start`: the match expression or the record expression that the two are. `NO_EXPR`: the
 * `{` is not part of the expression.
 */
export function flowBracesAfterExpression(start: number, expression: number): number {
  if (lx.newlineBefore || hasContext(CTX_NO_RECORD)) return NO_EXPR;
  if (flowIsMatchHead(expression)) {
    // That is a statement.
    if (start === p.flowStatementStart) return NO_EXPR;
    return flowMatchExpression(start, expression);
  }
  if (isParenthesized(expression)) return NO_EXPR;
  let constructor = expression;
  let typeArgsStart = 0;
  let typeArgsLen = 0;
  const hir$ = hir;
  const last = (hir$.nExprs - 1) | 0;
  if (expression + 1 === hir$.nExprs && last >= 0 && (hir$.exprTag[last] | 0) === EXPR_INSTANTIATION) {
    const inner = hir$.exprA[last] | 0;
    if (!isConstructor(inner)) return NO_EXPR;
    typeArgsStart = hir$.exprB[last] | 0;
    typeArgsLen = hir$.exprC[last] | 0;
    hir$.nExprs = last;
    constructor = inner;
  } else if (!isConstructor(expression)) {
    return NO_EXPR;
  }
  const properties = objectLiteral();
  return flowExpressionWithBraces(start, constructor, typeArgsStart, typeArgsLen, properties);
}

function isConstructor(e: number): boolean {
  const hir$ = hir;
  if (e < 0 || e >= (hir$.nExprs | 0)) return false;
  const tag = hir$.exprTag[e] | 0;
  const lx$ = lx;
  if (tag === EXPR_IDENT) {
    const a = hir$.exprA[e] | 0;
    if (lx$.textLen(a) === 0) return false;
    const c = lx$.textBuf(a)[lx$.textStart(a) | 0] | 0;
    return !(c >= 97 && c <= 122);
  }
  if (tag === EXPR_DOT) return (hir$.exprAux[e] | 0) === CHAIN_NO;
  if (tag === EXPR_INDEX) return (hir$.exprAux[e] | 0) === CHAIN_NO;
  return false;
}

/** `head { }` */
function flowExpressionWithBraces(start: number, head: number, typeArgsStart: number, typeArgsLen: number, braces: number): number {
  const s$ = s;
  const base = s$.ids.len;
  s$.ids.push(braces);
  const args = takeIds(base);
  const call = hir.pushCall(head, args, p.outLen, typeArgsStart, typeArgsLen, -1, CHAIN_NO, NONE);
  return pushExprNew(start, lx.fullStart, call);
}

/** `match (a, b)` is `match ((a, b))`: the argument of `head`, which was just parsed, is one expression. */
function flowMatchHead(head: number): number {
  const hir$ = hir;
  const last = (hir$.nExprs - 1) | 0;
  if (last < 0 || (hir$.exprTag[last] | 0) !== EXPR_CALL) return head;
  const call = hir$.exprA[last] | 0;
  const pos = hir$.exprPos[last] | 0;
  const end = hir$.exprEnd[last] | 0;
  const argsStart = hir$.callArgsStart[call] | 0;
  const argsLen = hir$.callArgsLen[call] | 0;
  if (argsLen < 2 || head + 1 !== hir$.nExprs) return head;
  hir$.nExprs = last;
  let left = hir$.ids[argsStart] | 0;
  const start = left >= 0 ? hir$.exprPos[left] | 0 : pos;
  for (let i = 1; i < argsLen; i++) {
    const right = hir$.ids[(argsStart + i) | 0] | 0;
    const rightEnd = right >= 0 ? hir$.exprEnd[right] | 0 : end;
    left = pushExprBinary(start, rightEnd, left, right, BIN_COMMA);
  }
  const s$ = s;
  const base = s$.ids.len;
  s$.ids.push(left);
  const argument = takeIds(base);
  hir$.callArgsStart[call] = argument;
  hir$.callArgsLen[call] = p.outLen | 0;
  return pushExprCall(pos, end, call);
}

/** `match (a) { b => c, d if (e) => f }`, at the `{`. `head`: the `match (a)`. */
function flowMatchExpression(start: number, head0: number): number {
  if (!enterDepth()) return NONE;
  const head = flowMatchHead(head0);
  const lx$ = lx;
  const open = lx$.start | 0;
  lx$.next();
  const saved = enterContext(0, CTX_DISALLOW_IN | CTX_DECORATOR | CTX_NO_RECORD);
  const s$ = s;
  const base = s$.props.len;
  const hir$ = hir;
  while (isInList(T_CLOSE_BRACE)) {
    const pos = lx$.start | 0;
    const pattern = flowMatchPatternAndGuard();
    expect(T_EQUALS_GREATER_THAN);
    const value = assignmentExpression();
    s$.props.push(hir$.pushProp(PROP_INIT, PK_COMPUTED, pattern, NK_IDENTIFIER, value, pos, pos, lx$.fullStart, 0, 0, 0));
    if (!eat(T_COMMA)) break;
  }
  const p$ = p;
  p$.context = saved;
  expect(T_CLOSE_BRACE);
  const cases0 = takeList(s$.props, base);
  const cases = pushExprObject(open, lx$.fullStart, cases0, p$.outLen);
  const r = flowExpressionWithBraces(start, head, 0, 0, cases);
  leaveDepth();
  return r;
}

/** `match (a) { b => { } c if (d) => { } }`, at the `{`. `head`: the `match (a)`. */
function flowMatchStatement(startPos: number, startFull: number, head0: number): number {
  const head = flowMatchHead(head0);
  const lx$ = lx;
  lx$.next();
  const s$ = s;
  const base = s$.cases.len;
  const hir$ = hir;
  const p$ = p;
  while (isInList(T_CLOSE_BRACE)) {
    const pos = lx$.start | 0;
    const test = flowMatchPatternAndGuard();
    expect(T_EQUALS_GREATER_THAN);
    if (lx$.token !== T_OPEN_BRACE) {
      fail();
      break;
    }
    const ids = s$.ids.len;
    const blk = block();
    s$.ids.push(blk);
    const body = takeIds(ids);
    s$.cases.push(hir$.pushCase(test, body, p$.outLen, pos, lx$.fullStart));
    eat(T_COMMA);
  }
  expect(T_CLOSE_BRACE);
  const cases = takeList(s$.cases, base);
  return finishStmt(pushStmtSwitch(startPos, head, cases, p$.outLen), startFull, 0, 0);
}

/** `pattern`, `pattern if (guard)` */
function flowMatchPatternAndGuard(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  const left = flowMatchPattern();
  if (!eat(T_IF)) return left;
  expect(T_OPEN_PAREN);
  const right = expressionAllowingIn();
  expect(T_CLOSE_PAREN);
  return pushExprBinary(start, lx$.fullStart, left, right, BIN_AND);
}

/** `a`, `a | b`, `| a | b`, `a as b`, `a | b as const c` */
function flowMatchPattern(): number {
  if (!enterDepth()) return NONE;
  const lx$ = lx;
  const start = lx$.start | 0;
  eat(T_BAR);
  let left = flowMatchSubpattern();
  while (eat(T_BAR)) {
    const right = flowMatchSubpattern();
    left = pushExprBinary(start, lx$.fullStart, left, right, BIN_BIT_OR);
  }
  if (eat(T_AS)) {
    const t = lx$.token;
    const right = t === T_CONST || t === T_VAR || t === T_LET ? flowMatchBinding() : flowMatchName();
    left = pushExprBinary(start, lx$.fullStart, left, right, BIN_IN);
  }
  leaveDepth();
  return left;
}

/** A name that a pattern binds, or that it starts with. */
function flowMatchName(): number {
  const end = lx.end | 0;
  const name = identifier();
  const pos = p.outPos | 0;
  return pushExprIdent(pos, end, name);
}

/** `const a`, at the keyword. */
function flowMatchBinding(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  lx$.next();
  const operand = flowMatchName();
  return pushExprUnary(start, lx$.fullStart, operand, UN_VOID);
}

/** `...`, `...const a`, at the `...`: what is after the dots. */
function flowMatchRest(): number {
  const lx$ = lx;
  lx$.next();
  const t = lx$.token;
  if (t === T_CONST || t === T_VAR || t === T_LET) return flowMatchBinding();
  const end = lx$.fullStart | 0;
  return pushExprMissing(end, end);
}

function flowMatchSubpattern(): number {
  const lx$ = lx;
  const start = lx$.start | 0;
  const s$ = s;
  const p$ = p;
  switch (lx$.token) {
    case T_NULL:
    case T_TRUE:
    case T_FALSE:
    case T_NUMBER:
    case T_BIG_INT:
    case T_STRING:
      return primaryExpression();
    case T_PLUS:
    case T_MINUS: {
      const op = lx$.token === T_PLUS ? UN_PLUS : UN_MINUS;
      lx$.next();
      if (lx$.token !== T_NUMBER && lx$.token !== T_BIG_INT) {
        fail();
        return NONE;
      }
      const operand = primaryExpression();
      return pushExprUnary(start, lx$.fullStart, operand, op);
    }
    case T_CONST:
    case T_VAR:
    case T_LET:
      return flowMatchBinding();
    case T_OPEN_PAREN: {
      lx$.next();
      const pattern = flowMatchPattern();
      expect(T_CLOSE_PAREN);
      return pattern;
    }
    case T_OPEN_BRACE:
      return flowMatchObjectPattern();
    case T_OPEN_BRACKET: {
      lx$.next();
      const base = s$.ids.len;
      while (isInList(T_CLOSE_BRACKET)) {
        if (lx$.token === T_DOT_DOT_DOT) {
          const dots = lx$.start | 0;
          const rest = flowMatchRest();
          const spread = pushExprSpread(dots, lx$.fullStart, rest);
          s$.ids.push(spread);
          break;
        }
        const element = flowMatchPattern();
        s$.ids.push(element);
        if (!eat(T_COMMA)) break;
      }
      expect(T_CLOSE_BRACKET);
      const elements = takeIds(base);
      return pushExprArray(start, lx$.fullStart, elements, p$.outLen);
    }
    default: {
      let pattern = flowMatchName();
      while (true) {
        if (eat(T_DOT)) {
          const name = identifierName();
          const namePos = p$.outPos | 0;
          pattern = pushExprDot(start, lx$.fullStart, pattern, name, namePos, CHAIN_NO);
        } else if (eat(T_OPEN_BRACKET)) {
          if (lx$.token !== T_NUMBER && lx$.token !== T_BIG_INT && lx$.token !== T_STRING) {
            fail();
            return NONE;
          }
          const index = primaryExpression();
          expect(T_CLOSE_BRACKET);
          pattern = pushExprIndex(start, lx$.fullStart, pattern, index, CHAIN_NO);
        } else {
          break;
        }
      }
      if (lx$.token !== T_OPEN_BRACE) return pattern;
      const properties = flowMatchObjectPattern();
      return flowExpressionWithBraces(start, pattern, 0, 0, properties);
    }
  }
}

/** `{ a: b, const c, ...const d }`, at the `{`. */
function flowMatchObjectPattern(): number {
  const lx$ = lx;
  const open = lx$.start | 0;
  lx$.next();
  const s$ = s;
  const base = s$.props.len;
  const p$ = p;
  const hir$ = hir;
  while (isInList(T_CLOSE_BRACE)) {
    const pos = lx$.start | 0;
    let kind = PROP_INIT;
    let keyKind = PK_NONE;
    let keyVal = NONE;
    let nameKind = NK_IDENTIFIER;
    let value = NONE;
    const t = lx$.token;
    if (t === T_DOT_DOT_DOT) {
      kind = PROP_SPREAD;
      value = flowMatchRest();
    } else if (t === T_CONST || t === T_VAR || t === T_LET) {
      value = flowMatchBinding();
    } else if (t === T_OPEN_BRACKET || t === T_PRIVATE_IDENTIFIER) {
      fail();
    } else {
      propertyName();
      keyKind = p$.keyKind | 0;
      keyVal = p$.keyVal | 0;
      nameKind = p$.nameKind | 0;
      expect(T_COLON);
      value = flowMatchPattern();
    }
    s$.props.push(hir$.pushProp(kind, keyKind, keyVal, nameKind, value, pos, pos, lx$.fullStart, 0, 0, 0));
    if (kind === PROP_SPREAD || !eat(T_COMMA)) break;
  }
  expect(T_CLOSE_BRACE);
  const properties = takeList(s$.props, base);
  return pushExprObject(open, lx$.fullStart, properties, p$.outLen);
}

// ───────────────────────────── records ─────────────────────────────

/** `record A<T> implements B { a: T = b, static c: U = d, e() { } }`, after `record`, which is the last of the modifiers. */
function flowRecord(startPos: number, startFull: number, base: number, flags: number): number {
  flowRefuseDecorators(base);
  const name = identifier();
  const p$ = p;
  const namePos = p$.outPos | 0;
  const tpStart = typeParameters();
  const tpLen = p$.outLen | 0;
  let implementsStart = 0;
  let implementsLen = 0;
  if (eat(T_IMPLEMENTS)) {
    implementsStart = flowHeritage();
    implementsLen = p$.outLen | 0;
  }
  expect(T_OPEN_BRACE);
  p$.classesAround = (p$.classesAround + 1) | 0;
  const s$ = s;
  const first = s$.members.len;
  while (isInList(T_CLOSE_BRACE)) flowRecordMember();
  p$.classesAround = (p$.classesAround - 1) | 0;
  expect(T_CLOSE_BRACE);
  const members = takeList(s$.members, first);
  const membersLen = p$.outLen | 0;
  const modStart = takeModifiers(base);
  const modLen = p$.outLen | 0;
  const cls = hir.pushClass(
    name,
    namePos,
    flags & (FLAG_EXPORT | FLAG_DEFAULT),
    tpStart,
    tpLen,
    NONE,
    0,
    0,
    0,
    0,
    implementsStart,
    implementsLen,
    0,
    0,
    members,
    membersLen,
    startPos,
    modStart,
    modLen,
  );
  return finishStmt(pushStmtClass(startPos, cls), startFull, modStart, modLen);
}

/** Whether the token, `static` or `async`, is a modifier and not a name. */
function flowIsAtModifierInRecord(): boolean {
  const n = peek();
  return !(n === T_COLON || n === T_LESS_THAN || n === T_OPEN_PAREN || n === T_CLOSE_BRACE || n === T_EOF);
}

function flowRecordMember(): void {
  const lx$ = lx;
  const startPos = lx$.start | 0;
  const startFull = lx$.fullStart | 0;
  const s$ = s;
  const firstModifier = s$.modifiers.len;
  let flags = 0;
  if (lx$.token === T_STATIC && flowIsAtModifierInRecord()) {
    flags = flags | FLAG_STATIC;
    modifierToken(FLAG_STATIC);
  }
  if (lx$.token === T_ASYNC && flowIsAtModifierInRecord()) {
    flags = flags | FLAG_ASYNC;
    modifierToken(FLAG_ASYNC);
  }
  const isGenerator = eat(T_ASTERISK);
  if (lx$.token === T_OPEN_BRACKET || lx$.token === T_PRIVATE_IDENTIFIER) {
    fail();
    return;
  }
  const nameToken = lx$.token;
  propertyName();
  const p$ = p;
  let keyKind = p$.keyKind | 0;
  let keyVal = p$.keyVal | 0;
  const nameKind = p$.nameKind | 0;
  const namePos = p$.namePos | 0;
  if (nameToken === T_BIG_INT) {
    keyKind = PK_NONE;
    keyVal = NONE;
  }
  flags = flags | flagsOfMemberName(nameToken, nameKind, keyKind);
  const hir$ = hir;
  const member = hir$.newMember();
  hir$.memberKeyKind[member] = keyKind;
  hir$.memberKeyVal[member] = keyVal;
  hir$.memberFlags[member] = flags;
  hir$.memberNamePos[member] = namePos;
  hir$.memberStart[member] = startPos;
  let end = 0;
  if (lx$.token === T_COLON && !isGenerator && (flags & FLAG_ASYNC) === 0) {
    hir$.memberTy[member] = typeAnnotation();
    const cleared = CTX_YIELD | CTX_AWAIT | CTX_DISALLOW_IN | CTX_TOP_LEVEL;
    const saved = enterContext(0, cleared);
    hir$.memberInit[member] = optionalInitializer();
    p$.context = saved;
    end = lx$.fullStart | 0;
    if (lx$.token !== T_CLOSE_BRACE) expect(T_COMMA);
  } else if (lx$.token === T_OPEN_PAREN || lx$.token === T_LESS_THAN) {
    hir$.memberKind[member] = MEMBER_METHOD;
    const fnFlags = isGenerator ? flags | FLAG_GENERATOR : flags;
    const name = keyKind === PK_NAME || keyKind === PK_PRIVATE ? keyVal : ATOM_NONE;
    hir$.memberFunc[member] = functionRest(FN_METHOD, fnFlags, name, namePos, startPos);
    end = lx$.fullStart | 0;
  } else {
    fail();
  }
  hir$.memberLocPos[member] = startFull;
  hir$.memberLocEnd[member] = end;
  const modStart = takeModifiers(firstModifier);
  hir$.memberModStart[member] = modStart;
  hir$.memberModLen[member] = p$.outLen | 0;
  s$.members.push(member);
}

void atomText;
void T_BAR_BAR;
