// Port of vendor/bun/src/sema/parser/parser/ty.rs: types, and the declarations that consist of types.
//
// Conventions: those of mod.ts (module-level `lx`, `p`, `s`; free functions; several results via `p.outPos/outLen/outA/outB`).
// Only the non-recovering Babel/TypeScript parse is ported: the branches for oxc (`is_for_oxc`, `reports_like_oxc`), Flow (`is_flow`)
// and recovery (`recovers()`) are `// TODO(oxc|flow|recover)` comments.
//
// Functions that return a list return its start and leave the length in `p.outLen`. `Option<Id>` is -1. `NO_WORD` (-2) is the
// answer "none" of a function that can also answer with a node id.
import {
  BODY_BLOCK,
  BODY_NONE,
  CHAIN_NO,
  DK_CHECKER,
  DK_GRAMMAR,
  FLAG_ABSTRACT,
  FLAG_COMPUTED_NAME,
  FLAG_DEFAULT,
  FLAG_LITERAL_NAME,
  FLAG_OPTIONAL,
  FLAG_REST,
  FLAG_STRING_NAME,
  FN_CALL_SIGNATURE,
  FN_CONSTRUCT_SIGNATURE,
  FN_CONSTRUCTOR_TYPE,
  FN_FUNCTION_TYPE,
  FN_GETTER,
  FN_INDEX_SIGNATURE,
  FN_METHOD,
  FN_SETTER,
  IAT_ASSERT,
  IAT_NONE,
  IAT_WITH,
  JSD_NON_NULLABLE,
  JSD_NULLABLE,
  KW_ANY,
  KW_BIG_INT,
  KW_BOOLEAN,
  KW_INTRINSIC,
  KW_NEVER,
  KW_NULL,
  KW_NUMBER,
  KW_OBJECT,
  KW_STRING,
  KW_SYMBOL,
  KW_THIS,
  KW_UNDEFINED,
  KW_UNKNOWN,
  KW_VOID,
  MEMBER_CALL_SIGNATURE,
  MEMBER_CONSTRUCT_SIGNATURE,
  MEMBER_GETTER,
  MEMBER_INDEX_SIGNATURE,
  MEMBER_METHOD,
  MEMBER_PROPERTY,
  MEMBER_SETTER,
  MM_ADD,
  MM_NONE,
  MM_REMOVE,
  NK_COMPUTED_STRING,
  NK_NUMERIC_LITERAL,
  NK_STRING_LITERAL,
  NONE,
  PK_NAME,
  PK_NONE,
  PK_PRIVATE,
  RARE_JSDOC_TYPE,
  RARE_TYPE_PREDICATE,
  RM_NONE,
  TM_OPTIONAL,
  TM_REST,
  TYPE_ARRAY,
  TYPE_JSDOC,
  TYPE_KEYWORD,
  TYPE_STRING_LIT,
  EXPR_INSTANTIATION,
  hir,
  pushExprDot,
  pushExprIdent,
  pushExprThis,
  pushStmtInterface,
  pushStmtTypeAlias,
  pushTypeArray,
  pushTypeBigIntLit,
  pushTypeBoolLit,
  pushTypeCond,
  pushTypeFn,
  pushTypeHeritage,
  pushTypeImport,
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
  pushTypeReadonly,
  pushTypeRef,
  pushTypeStringLit,
  pushTypeTemplate,
  pushTypeTuple,
  pushTypeTypeof,
  pushTypeUnion,
  pushTypeUnique,
  pushTypeUniqueSymbol,
} from "../../hir.ts";
import { A_default, A_empty, A_this, ATOM_NONE } from "../../atom.ts";
import {
  T_AMPERSAND,
  T_ABSTRACT,
  T_ANY,
  T_AS,
  T_ASSERT,
  T_ASSERTS,
  T_AT,
  T_ASTERISK,
  T_ASTERISK_EQUALS,
  T_BAR,
  T_BIG_INT,
  T_BIG_INT_KEYWORD,
  T_BOOLEAN,
  T_CLOSE_BRACE,
  T_CLOSE_BRACKET,
  T_CLOSE_PAREN,
  T_COLON,
  T_COMMA,
  T_DOT,
  T_DOT_DOT_DOT,
  T_EQUALS,
  T_EQUALS_GREATER_THAN,
  T_ESCAPED_RESERVED_WORD,
  T_EXCLAMATION,
  T_EXTENDS,
  T_FALSE,
  T_FUNCTION,
  T_GET,
  T_GREATER_THAN,
  T_IDENTIFIER,
  T_IMPLEMENTS,
  T_IMPORT,
  T_IN,
  T_INFER,
  T_INTRINSIC,
  T_IS,
  T_KEY_OF,
  T_LESS_THAN,
  T_LESS_THAN_LESS_THAN,
  T_MINUS,
  T_NEVER,
  T_NEW,
  T_NO_SUBSTITUTION_TEMPLATE,
  T_NULL,
  T_NUMBER,
  T_NUMBER_KEYWORD,
  T_OBJECT,
  T_OPEN_BRACE,
  T_OPEN_BRACKET,
  T_OPEN_PAREN,
  T_PLUS,
  T_PRIVATE_IDENTIFIER,
  T_QUESTION,
  T_QUESTION_DOT,
  T_QUESTION_QUESTION,
  T_READONLY,
  T_SET,
  T_STRING,
  T_STRING_KEYWORD,
  T_SYMBOL,
  T_TEMPLATE_HEAD,
  T_TEMPLATE_MIDDLE,
  T_THIS,
  T_TRUE,
  T_TYPE_OF,
  T_UNDEFINED,
  T_UNIQUE,
  T_UNKNOWN,
  T_VOID,
  T_WITH,
  isModifier,
} from "../token.ts";
import { R_ESCAPED_KEYWORD, R_REPORTED } from "../lib.ts";
import {
  CTX_CONDITIONAL_EXTENDS,
  CTX_DISALLOW_CONDITIONAL_TYPES,
  CTX_TYPE,
  LK_HERITAGE_CLAUSE_ELEMENT,
  LK_HERITAGE_CLAUSES,
  LK_TUPLE_ELEMENT_TYPES,
  LK_TYPE_ARGUMENTS,
  LK_TYPE_MEMBERS,
  MODS_TYPE_MEMBER,
  ambient,
  canParseSemicolon,
  eat,
  enterContext,
  enterDepth,
  enterList,
  errorAndGoOn,
  errorAtToken,
  expect,
  expected,
  fail,
  failUnlessRecovering,
  flag,
  hasFailed,
  identifier,
  identifierName,
  isBindingIdentifier,
  isIdentifier,
  isIdentifierInContext,
  isInList,
  leaveDepth,
  leaveList,
  lookAheadEnd,
  lookAheadParsingBegin,
  lookAheadParsingEnd,
  lx,
  missingIdentifier,
  nextAfterName,
  noteIdentifier,
  noteNameInType,
  p,
  peek,
  refuse,
  s,
  semicolon,
  takeIds,
  takeList,
  tryParseBegin,
  tryParseEnd,
} from "./mod.ts";
import { isAtElement, goesOnWithoutComma, isAtHeritageClause } from "./recover.ts";
import {
  canFollowAccessorKeyword,
  isFollowedByWordOnSameLine,
  isStartOfExpression,
  isStartOfLeftHandSideExpression,
  leftHandSideExpression,
  pieceOfTemplateWithoutTag,
  propertyName,
} from "./expr.ts";
import { identifierOrPattern } from "./pattern.ts";
import { functionBlock, noteParametersOfAccessor, parameterList, parameters, typeParameters } from "./func.ts";
import { jsErrorAtType } from "./js_syntax.ts";
import { flowReturnTypeOfFunction, flowType, flowTypeArguments } from "./flow.ts";
import { finishStmt, isLiteralPropertyName, modifiers, optionalInitializer, takeModifiers } from "./stmt.ts";
import { importAttributes, unclosedImportAttributes } from "./module.ts";
import { flagArgs } from "./mod.ts";
import { takeErrorsOfScanner, error } from "./mod.ts";
import { DK_PARSE } from "../../hir.ts";
import { errorAtTokenArgs } from "./mod.ts";
import { NO_WORD } from "./ty.consts.ts";

/** The flags of a member of a type that its name says. `nameToken`: its first token. */
function flagsOfTypeMemberName(nameToken: number, nameKind: number, keyKind: number): number {
  if (nameKind === NK_STRING_LITERAL) return FLAG_STRING_NAME;
  if (nameKind === NK_NUMERIC_LITERAL) return FLAG_LITERAL_NAME;
  if (nameKind === NK_COMPUTED_STRING && keyKind === PK_NAME) return FLAG_STRING_NAME | FLAG_COMPUTED_NAME;
  if (nameToken === T_OPEN_BRACKET) return FLAG_COMPUTED_NAME;
  return 0;
}

/** A type that is the token, which is consumed: a keyword. */
function tokenTypeKeyword(keyword: number): number {
  const lx$ = lx;
  const id = pushTypeKeyword(lx$.start, lx$.end, keyword);
  lx$.next();
  return id;
}

/** `parseTypeAnnotation` */
export function typeAnnotation(): number {
  const lx$ = lx;
  if (lx$.token !== T_COLON) return NONE;
  lx$.next();
  if (p.isJavascript) return typeAnnotationInJavascript();
  return ty();
}

/** `parseTypeAnnotation`, after the `:`. */
function typeAnnotationInJavascript(): number {
  if (p.isFlow) return flowType();
  const t = ty();
  jsErrorAtType(t, 8010);
  return t;
}

/** `parseType` */
export function ty(): number {
  if (!enterDepth()) return NONE;
  let r = NO_WORD;
  if (lx.token >= T_IDENTIFIER) r = typeOfOneWord();
  const p$ = p;
  if (r === NO_WORD) {
    const saved = enterContext(CTX_TYPE, p$.clearedInTypes);
    r = typeInContext();
    p$.context = saved;
  }
  leaveDepth();
  return r;
}

/** `parseType`, at a word after which the text says that no type goes on: most types are such. `NO_WORD`: it says no such thing, or the word is more than a name or the name of a type. */
function typeOfOneWord(): number {
  const lx$ = lx;
  const follows = lx$.firstByteOfNext() | 0;
  // , ) ; = > { } ]
  if (!(follows === 44 || follows === 41 || follows === 59 || follows === 61 || follows === 62 || follows === 123 || follows === 125 || follows === 93)) {
    return NO_WORD;
  }
  let keyword = -1;
  switch (lx$.token) {
    case T_IDENTIFIER:
      return typeReference();
    case T_ANY:
      keyword = KW_ANY;
      break;
    case T_UNKNOWN:
      keyword = KW_UNKNOWN;
      break;
    case T_STRING_KEYWORD:
      keyword = KW_STRING;
      break;
    case T_NUMBER_KEYWORD:
      keyword = KW_NUMBER;
      break;
    case T_BIG_INT_KEYWORD:
      keyword = KW_BIG_INT;
      break;
    case T_SYMBOL:
      keyword = KW_SYMBOL;
      break;
    case T_BOOLEAN:
      keyword = KW_BOOLEAN;
      break;
    case T_UNDEFINED:
      keyword = KW_UNDEFINED;
      break;
    case T_NEVER:
      keyword = KW_NEVER;
      break;
    case T_OBJECT:
      keyword = KW_OBJECT;
      break;
    case T_VOID:
      keyword = KW_VOID;
      break;
    case T_NULL:
      keyword = KW_NULL;
      break;
    default:
      return NO_WORD;
  }
  return tokenTypeKeyword(keyword);
}

function typeInContext(): number {
  if (isStartOfFunctionOrConstructorType()) return functionOrConstructorType();
  const lx$ = lx;
  const start = lx$.start;
  const check = unionType();
  const p$ = p;
  if (lx$.token !== T_EXTENDS || (p$.context & CTX_DISALLOW_CONDITIONAL_TYPES) !== 0 || lx$.newlineBefore) return check;
  lx$.next();
  // "The type following 'extends' is not permitted to be another conditional type"
  let saved = enterContext(CTX_DISALLOW_CONDITIONAL_TYPES | CTX_CONDITIONAL_EXTENDS, 0);
  const extendsTy = ty();
  p$.context = saved;
  expect(T_QUESTION);
  saved = enterContext(0, CTX_DISALLOW_CONDITIONAL_TYPES);
  const yes = ty();
  expect(T_COLON);
  const no = ty();
  p$.context = saved;
  return pushTypeCond(start, lx$.fullStart, check, extendsTy, yes, no);
}

/** `isStartOfFunctionTypeOrConstructorType` */
function isStartOfFunctionOrConstructorType(): boolean {
  const t = lx.token;
  if (t === T_LESS_THAN || t === T_NEW) return true;
  if (t === T_OPEN_PAREN) return isAtParametersOfFunctionType();
  if (t === T_ABSTRACT) return peek() === T_NEW;
  return false;
}

/** `lookAhead(isUnambiguouslyStartOfFunctionType)` */
function isAtParametersOfFunctionType(): boolean {
  // A pattern after the `(` is parsed to get past it, with the types in it, and in them every `(` is asked about again, twice.
  // An answer that took long is kept: otherwise each level of `({[a as ({[b as ..` takes three times as long as the one in it.
  const lx$ = lx;
  const atPos = lx$.start | 0;
  const p$ = p;
  const atCtx = p$.context | 0;
  // Rows (pos, context, answer), sorted by (pos, context).
  const kept = p$.functionTypeStarts;
  let place = 0;
  if (kept.len !== 0) {
    // What is before a token that is read for good is not read again.
    if (p$.speculations === 0) {
      const rows = (kept.len / 3) | 0;
      let lo = 0;
      let hi = rows;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((kept.data[mid * 3] | 0) < atPos) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) {
        kept.data.copyWithin(0, lo * 3, kept.len);
        kept.len = (kept.len - lo * 3) | 0;
      }
    }
    const rows = (kept.len / 3) | 0;
    let lo = 0;
    let hi = rows;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const mp = kept.data[mid * 3] | 0;
      const mc = kept.data[mid * 3 + 1] | 0;
      if (mp < atPos || (mp === atPos && mc < atCtx)) lo = mid + 1;
      else hi = mid;
    }
    if (lo < rows && (kept.data[lo * 3] | 0) === atPos && (kept.data[lo * 3 + 1] | 0) === atCtx) {
      return (kept.data[lo * 3 + 2] | 0) !== 0;
    }
    place = lo;
  }
  let end = atPos;
  let answer = false;
  const cp = lookAheadParsingBegin();
  if (cp >= 0) {
    answer = isUnambiguouslyStartOfFunctionType();
    end = lx$.start | 0;
    answer = lookAheadParsingEnd(cp, answer);
  }
  // What was kept on the way is behind it.
  if (end - atPos > 64) {
    const n = kept.len;
    if (n + 3 > kept.data.length) kept.grow();
    const d = kept.data;
    d.copyWithin(place * 3 + 3, place * 3, n);
    d[place * 3] = atPos | 0;
    d[place * 3 + 1] = atCtx | 0;
    d[place * 3 + 2] = answer ? 1 : 0;
    kept.len = (n + 3) | 0;
  }
  return answer;
}

/** `isUnambiguouslyStartOfFunctionType` */
function isUnambiguouslyStartOfFunctionType(): boolean {
  const lx$ = lx;
  lx$.next();
  if (lx$.token === T_CLOSE_PAREN || lx$.token === T_DOT_DOT_DOT) {
    // "( )", "( ..."
    return true;
  }
  // `skipParameterStart`
  const s$ = s;
  if (isModifier(lx$.token)) {
    const base = s$.modifiers.len;
    modifiers(MODS_TYPE_MEMBER);
    s$.modifiers.truncate(base);
    eat(T_DOT_DOT_DOT);
  }
  const p$ = p;
  if (isIdentifier() || lx$.token === T_THIS) {
    lx$.next();
  } else if (lx$.token === T_OPEN_BRACKET || lx$.token === T_OPEN_BRACE) {
    // "Return true if we can parse an array or object binding pattern with no errors"
    const errors = p$.recovers ? numberOfErrors() : 0;
    identifierOrPattern();
    if (hasFailed() || (p$.recovers && numberOfErrors() !== errors)) return false;
  } else {
    return false;
  }
  const t = lx$.token;
  // "( xxx :", "( xxx ,", "( xxx ?", "( xxx ="
  if (t === T_COLON || t === T_COMMA || t === T_QUESTION || t === T_EQUALS) return true;
  if (t === T_CLOSE_PAREN) {
    lx$.next();
    // "( xxx ) =>"
    return lx$.token === T_EQUALS_GREATER_THAN;
  }
  return false;
}

/** `parseFunctionOrConstructorType` */
function functionOrConstructorType(): number {
  const lx$ = lx;
  const start = lx$.start;
  let flags = 0;
  if (eat(T_ABSTRACT)) flags = flags | FLAG_ABSTRACT;
  const kind = eat(T_NEW) ? FN_CONSTRUCTOR_TYPE : FN_FUNCTION_TYPE;
  const namePos = lx$.start;
  const tpStart = typeParameters();
  const p$ = p;
  const tpLen = p$.outLen | 0;
  const anchor = lx$.start;
  const thisParam = parameters(0);
  const pStart = p$.outA | 0;
  const pLen = p$.outLen | 0;
  expect(T_EQUALS_GREATER_THAN);
  const ret = typeOrTypePredicate();
  const func = hir.pushFn(kind, flags, ATOM_NONE, namePos, tpStart, tpLen, pStart, pLen, thisParam, ret, BODY_NONE, 0, 0, anchor, start);
  // TODO(oxc): `if (isOddFunction(..)) checkFunctionLikeOxc(func, 0)`
  return pushTypeFn(start, lx$.fullStart, func);
}

/** `parseTypeOrTypePredicate` */
export function typeOrTypePredicate(): number {
  const p$ = p;
  if (p$.isFlow) return flowReturnTypeOfFunction();
  // `parseReturnType`: `T extends () => A extends B ? 1 : 0 ? C : D`
  const saved = enterContext(0, CTX_DISALLOW_CONDITIONAL_TYPES);
  const t = typeOrTypePredicateInContext();
  p$.context = saved;
  return t;
}

function typeOrTypePredicateInContext(): number {
  const lx$ = lx;
  const hir$ = hir;
  if (isIdentifier()) {
    const b = lx$.firstByteOfNext() | 0;
    if (b === 0 || b === 105) {
      // `parseTypePredicatePrefix`
      const m = lx$.mark();
      const had = lx$.refusal | 0;
      lx$.next();
      const isPredicate = lx$.token === T_IS && !lx$.newlineBefore;
      lookAheadEnd(m, had);
      if (isPredicate) {
        const param = identifier();
        const start = p.outPos | 0;
        lx$.next();
        const t = ty();
        hir$.rareSyntax = hir$.rareSyntax | RARE_TYPE_PREDICATE;
        return pushTypePredicate(start, lx$.fullStart, param, t, 0);
      }
    }
  }
  return ty();
}

/** `parseUnionTypeOrHigher` */
function unionType(): number {
  const lx$ = lx;
  const start = lx$.start;
  const hasLeadingOperator = eat(T_BAR);
  const first = hasLeadingOperator ? memberOfUnion() : intersectionType();
  if (lx$.token !== T_BAR && !hasLeadingOperator) return first;
  const s$ = s;
  const base = s$.ids.len;
  s$.ids.push(first);
  while (eat(T_BAR)) {
    const member = memberOfUnion();
    s$.ids.push(member);
  }
  const members = takeIds(base);
  return pushTypeUnion(start, lx$.fullStart, members, p.outLen);
}

/** `parseIntersectionTypeOrHigher` */
function intersectionType(): number {
  const lx$ = lx;
  const start = lx$.start;
  const hasLeadingOperator = eat(T_AMPERSAND);
  const first = hasLeadingOperator ? memberOfIntersection() : typeOperator();
  if (lx$.token !== T_AMPERSAND && !hasLeadingOperator) return first;
  const s$ = s;
  const base = s$.ids.len;
  s$.ids.push(first);
  while (eat(T_AMPERSAND)) {
    const member = memberOfIntersection();
    s$.ids.push(member);
  }
  const members = takeIds(base);
  return pushTypeIntersection(start, lx$.fullStart, members, p.outLen);
}

/** `parseFunctionOrConstructorTypeToError(true, parseIntersectionTypeOrHigher)`, after a `|`. oxc doesn't look for a function type there. */
function memberOfUnion(): number {
  // TODO(oxc): `&& !dialect.oxc`
  if (isStartOfFunctionOrConstructorType()) return functionTypeWithoutParentheses(T_BAR);
  return intersectionType();
}

/** `parseFunctionOrConstructorTypeToError(false, parseTypeOperatorOrHigher)`, after a `&`. */
function memberOfIntersection(): number {
  // TODO(oxc): `&& !dialect.oxc`
  if (isStartOfFunctionOrConstructorType()) return functionTypeWithoutParentheses(T_AMPERSAND);
  return typeOperator();
}

/** `parseFunctionOrConstructorTypeToError`, where a function type starts after `operator`. */
function functionTypeWithoutParentheses(operator: number): number {
  if (!p.recovers) {
    refuse(R_REPORTED);
    return NONE;
  }
  const lx$ = lx;
  const full = lx$.fullStart | 0;
  const isConstructor = lx$.token === T_NEW || lx$.token === T_ABSTRACT;
  const t = functionOrConstructorType();
  let code: number;
  if (operator === T_BAR) code = isConstructor ? 1386 : 1385;
  else code = isConstructor ? 1388 : 1387;
  error(code, full, lx$.fullStart | 0);
  return t;
}

/** `len(p.diagnostics)`. Only recovery has any. */
function numberOfErrors(): number {
  // One of the scanner's that starts where the last error starts does not count.
  takeErrorsOfScanner();
  let count = 0;
  const hir$ = hir;
  const n = hir$.diagnosticsLen | 0;
  for (let i = 0; i < n; i += 5) if ((hir$.diagnostics[i] | 0) === DK_PARSE) count = (count + 1) | 0;
  return count;
}

/** `parseTypeOperatorOrHigher` */
function typeOperator(): number {
  const lx$ = lx;
  const start = lx$.start;
  const hir$ = hir;
  switch (lx$.token) {
    case T_KEY_OF: {
      lx$.next();
      const operand = nestedTypeOperator();
      return pushTypeKeyof(start, lx$.fullStart, operand);
    }
    case T_READONLY: {
      lx$.next();
      // TODO(oxc): `readonlyType` diagnostic when the operand is no array or tuple type.
      const operand = nestedTypeOperator();
      return pushTypeReadonly(start, lx$.fullStart, operand);
    }
    case T_UNIQUE: {
      lx$.next();
      const operandStart = lx$.start;
      const operand = nestedTypeOperator();
      const last = (hir$.nTypes - 1) | 0;
      if (
        last >= 0 &&
        (hir$.typeTag[last] | 0) === TYPE_KEYWORD &&
        (hir$.typeA[last] | 0) === KW_SYMBOL &&
        (hir$.typePos[last] | 0) === operandStart &&
        operand + 1 === hir$.nTypes
      ) {
        hir$.nTypes = last;
        return pushTypeUniqueSymbol(start, lx$.fullStart);
      }
      // `checkGrammarTypeOperatorNode` reports it.
      return pushTypeUnique(start, lx$.fullStart, operand);
    }
    case T_INFER:
      return inferType();
    default: {
      const saved = enterContext(0, CTX_DISALLOW_CONDITIONAL_TYPES);
      const t = postfixType();
      p.context = saved;
      return t;
    }
  }
}

function nestedTypeOperator(): number {
  if (!enterDepth()) return NONE;
  const t = typeOperator();
  leaveDepth();
  return t;
}

/** `parseInferType` */
function inferType(): number {
  const lx$ = lx;
  const start = lx$.start;
  lx$.next();
  // `parseTypeParameterOfInferType`
  const name = identifier();
  const p$ = p;
  const pos = p$.outPos | 0;
  // `tryParseConstraintOfInferType`
  let constraint = NONE;
  if (lx$.token === T_EXTENDS) {
    const cp = tryParseBegin();
    if (cp >= 0) {
      lx$.next();
      const saved = enterContext(CTX_DISALLOW_CONDITIONAL_TYPES, 0);
      const c = ty();
      p$.context = saved;
      const isConstraint = (p$.context & CTX_DISALLOW_CONDITIONAL_TYPES) !== 0 || lx$.token !== T_QUESTION;
      if (tryParseEnd(cp, isConstraint)) constraint = c;
    }
  }
  const param = hir.pushTypeParam(name, pos, pos, lx$.fullStart, constraint, NONE, 0, 0, 0);
  // TODO(oxc): `if (!hasContext(CTX_CONDITIONAL_EXTENDS) && reportsLikeOxc()) oxc::infer_type(..)`
  return pushTypeInfer(start, lx$.fullStart, param);
}

/** `parsePostfixTypeOrHigher` */
function postfixType(): number {
  const lx$ = lx;
  const start = lx$.start;
  let t = nonArrayType();
  const p$ = p;
  const hir$ = hir;
  while (!lx$.newlineBefore) {
    const tk = lx$.token;
    if (tk === T_OPEN_BRACKET) {
      lx$.next();
      if (eat(T_CLOSE_BRACKET)) {
        t = pushTypeArray(start, lx$.fullStart, t);
      } else {
        if (p$.recovers && !isStartOfType(false)) {
          expected(T_CLOSE_BRACKET);
          t = pushTypeArray(start, lx$.fullStart, t);
        } else {
          const index = typeInList();
          expect(T_CLOSE_BRACKET);
          t = pushTypeIndexedAccess(start, lx$.fullStart, t, index);
        }
      }
    } else if (tk === T_QUESTION) {
      const m = lx$.mark();
      const had = lx$.refusal | 0;
      lx$.next();
      const isBeforeType = isStartOfType(false);
      lookAheadEnd(m, had);
      if (isBeforeType) return t;
      // A `JSDocNullableType`, which the checker reports unless it is an element of a tuple: see `takeBackNullableType`.
      lx$.next();
      hir$.rareSyntax = hir$.rareSyntax | RARE_JSDOC_TYPE;
      t = pushTypeJSDoc(start, lx$.fullStart, t, JSD_NULLABLE | 4);
      p$.lastNullableType = t;
      p$.lastNullableTypeEnd = lx$.fullStart;
    } else if (tk === T_EXCLAMATION) {
      // A `JSDocNonNullableType`, which the checker reports.
      lx$.next();
      hir$.rareSyntax = hir$.rareSyntax | RARE_JSDOC_TYPE;
      t = pushTypeJSDoc(start, lx$.fullStart, t, JSD_NON_NULLABLE | 4);
    } else {
      break;
    }
  }
  return t;
}

/** `isStartOfType` */
export function isStartOfType(isInParameter: boolean): boolean {
  const lx$ = lx;
  if (lx$.token !== T_OPEN_PAREN) return isStartOfTypeWithoutParenthesis(isInParameter);
  // "Only consider '(' the start of a type if followed by ')', '...', an identifier, a modifier, or something that starts a type."
  // A loop over the parentheses that follow each other, where TypeScript recurses.
  if (isInParameter) return false;
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  let result = false;
  while (true) {
    lx$.next();
    if (lx$.token === T_CLOSE_PAREN || isStartOfParameter()) {
      result = true;
      break;
    }
    if (lx$.token !== T_OPEN_PAREN) {
      result = isStartOfTypeWithoutParenthesis(false);
      break;
    }
  }
  lookAheadEnd(m, had);
  return result;
}

/** `isStartOfType`, at any token but a `(`. */
function isStartOfTypeWithoutParenthesis(isInParameter: boolean): boolean {
  switch (lx.token) {
    case T_ANY:
    case T_UNKNOWN:
    case T_STRING_KEYWORD:
    case T_NUMBER_KEYWORD:
    case T_BIG_INT_KEYWORD:
    case T_BOOLEAN:
    case T_READONLY:
    case T_SYMBOL:
    case T_UNIQUE:
    case T_VOID:
    case T_UNDEFINED:
    case T_NULL:
    case T_THIS:
    case T_TYPE_OF:
    case T_NEVER:
    case T_OPEN_BRACE:
    case T_OPEN_BRACKET:
    case T_LESS_THAN:
    case T_BAR:
    case T_AMPERSAND:
    case T_NEW:
    case T_STRING:
    case T_NUMBER:
    case T_BIG_INT:
    case T_TRUE:
    case T_FALSE:
    case T_OBJECT:
    case T_ASTERISK:
    case T_QUESTION:
    case T_EXCLAMATION:
    case T_DOT_DOT_DOT:
    case T_INFER:
    case T_IMPORT:
    case T_ASSERTS:
    case T_NO_SUBSTITUTION_TEMPLATE:
    case T_TEMPLATE_HEAD:
      return true;
    case T_FUNCTION:
      return !isInParameter;
    case T_MINUS: {
      if (isInParameter) return false;
      const t = peek();
      return t === T_NUMBER || t === T_BIG_INT;
    }
    default:
      // Not even for oxc: `a as T ? await b : c`.
      return isIdentifierInContext();
  }
}

/** `isStartOfParameter` */
export function isStartOfParameter(): boolean {
  const lx$ = lx;
  return (
    lx$.token === T_DOT_DOT_DOT ||
    isBindingIdentifier() ||
    lx$.token === T_OPEN_BRACKET ||
    lx$.token === T_OPEN_BRACE ||
    isModifier(lx$.token) ||
    lx$.token === T_AT ||
    isStartOfTypeWithoutParenthesis(true)
  );
}

/** `parseNonArrayType` */
function nonArrayType(): number {
  let keyword = -1;
  const lx$ = lx;
  const hir$ = hir;
  switch (lx$.token) {
    case T_IDENTIFIER:
      return typeReference();
    case T_ANY:
      keyword = KW_ANY;
      break;
    case T_UNKNOWN:
      keyword = KW_UNKNOWN;
      break;
    case T_STRING_KEYWORD:
      keyword = KW_STRING;
      break;
    case T_NUMBER_KEYWORD:
      keyword = KW_NUMBER;
      break;
    case T_BIG_INT_KEYWORD:
      keyword = KW_BIG_INT;
      break;
    case T_SYMBOL:
      keyword = KW_SYMBOL;
      break;
    case T_BOOLEAN:
      keyword = KW_BOOLEAN;
      break;
    case T_UNDEFINED:
      keyword = KW_UNDEFINED;
      break;
    case T_NEVER:
      keyword = KW_NEVER;
      break;
    case T_OBJECT:
      keyword = KW_OBJECT;
      break;
    case T_VOID:
      return tokenTypeKeyword(KW_VOID);
    case T_NULL:
      return tokenTypeKeyword(KW_NULL);
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
    // `parseLiteralExpression` does not scan it again: an invalid escape passes.
    case T_NO_SUBSTITUTION_TEMPLATE: {
      // TODO(oxc): `if (lx.hasEscape && reportsLikeOxc()) pieceOfTemplateWithoutTag()`
      const id = pushTypeStringLit(lx$.start, lx$.end, lx$.atom);
      lx$.next();
      return id;
    }
    // It may be the keyword, which is an error.
    case T_ESCAPED_RESERVED_WORD:
      refuse(R_ESCAPED_KEYWORD);
      return NONE;
    case T_NUMBER: {
      const number = hir$.pushNumber(lx$.number);
      const id = pushTypeNumberLit(lx$.start, lx$.end, number);
      lx$.next();
      return id;
    }
    case T_BIG_INT: {
      const id = pushTypeBigIntLit(lx$.start, lx$.end, lx$.atom, 0);
      lx$.next();
      return id;
    }
    case T_MINUS: {
      const t = peek();
      if (t === T_NUMBER || t === T_BIG_INT) return negativeLiteralType();
      return typeReference();
    }
    case T_THIS: {
      const start = lx$.start;
      const thisType = tokenTypeKeyword(KW_THIS);
      if (lx$.token === T_IS && !lx$.newlineBefore) {
        // `parseThisTypePredicate`
        hir$.nTypes = (hir$.nTypes - 1) | 0;
        lx$.next();
        const t = ty();
        hir$.rareSyntax = hir$.rareSyntax | RARE_TYPE_PREDICATE;
        return pushTypePredicate(start, lx$.fullStart, A_this, t, 0);
      }
      return thisType;
    }
    case T_TYPE_OF: {
      if (peek() === T_IMPORT) return importType();
      return typeQuery();
    }
    case T_OPEN_BRACE: {
      const first = lx$.firstByteOfNext() | 0;
      // 0 + - r [
      const canBeMapped = first === 0 || first === 43 || first === 45 || first === 114 || first === 91;
      if (canBeMapped) {
        const m = lx$.mark();
        const had = lx$.refusal | 0;
        const isMapped = isStartOfMappedType();
        lookAheadEnd(m, had);
        if (isMapped) return mappedType();
      }
      return typeLiteral();
    }
    case T_OPEN_BRACKET:
      return tupleType();
    case T_OPEN_PAREN: {
      // `parseParenthesizedType`, which has no node.
      lx$.next();
      const t = ty();
      if (lx$.token === T_CLOSE_PAREN) lx$.next();
      else unclosedTypeInParentheses();
      return t;
    }
    case T_IMPORT:
      return importType();
    case T_ASSERTS: {
      const m = lx$.mark();
      const had = lx$.refusal | 0;
      lx$.next();
      const isName = p.recovers ? lx$.token >= T_IDENTIFIER : isIdentifier() || lx$.token === T_THIS;
      const isPredicate = isName && !lx$.newlineBefore;
      lookAheadEnd(m, had);
      return isPredicate ? assertsTypePredicate() : typeReference();
    }
    case T_TEMPLATE_HEAD:
      return templateType();
    case T_ASTERISK:
    case T_ASTERISK_EQUALS:
    case T_QUESTION:
    case T_QUESTION_QUESTION:
    case T_EXCLAMATION:
      return jsdocPrefixType();
    default:
      return typeReference();
  }
  // `parseKeywordAndNoDot`
  const b = lx$.firstByteOfNext() | 0;
  if ((b === 0 || b === 46) && peek() === T_DOT) return typeReference();
  return tokenTypeKeyword(keyword);
}

/** `parseJSDocAllType`, `parseJSDocNullableType`, `parseJSDocNonNullableType`: the checker reports them. */
function jsdocPrefixType(): number {
  const lx$ = lx;
  const token = lx$.token;
  const start = lx$.start;
  // `ReScanAsteriskEqualsToken`, `ReScanQuestionToken`
  if (token === T_ASTERISK_EQUALS || token === T_QUESTION_QUESTION) lx$.end = (start + 1) | 0;
  lx$.next();
  // `parseJSDocUnknownOrNullableType` of TypeScript 5: a `?` by itself.
  let isUnknownType = false;
  const p$ = p;
  if (token === T_QUESTION && p$.isTypescript5) {
    const t = lx$.token;
    isUnknownType = t === T_COMMA || t === T_CLOSE_BRACE || t === T_CLOSE_PAREN || t === T_GREATER_THAN || t === T_EQUALS || t === T_BAR;
  }
  if (token === T_ASTERISK || token === T_ASTERISK_EQUALS || isUnknownType) {
    // `checkJSDocTypeIsInJsFile`
    if (!p$.isJavascript) flag(DK_GRAMMAR, 8020, start, start + 1);
    return pushTypeKeyword(start, start + 1, KW_ANY);
  }
  const t = nestedTypeOperator();
  const hir$ = hir;
  hir$.rareSyntax = hir$.rareSyntax | RARE_JSDOC_TYPE;
  const kind = token === T_EXCLAMATION ? JSD_NON_NULLABLE : JSD_NULLABLE;
  return pushTypeJSDoc(start, lx$.fullStart, t, kind);
}

/** `parseAssertsTypePredicate` */
function assertsTypePredicate(): number {
  const lx$ = lx;
  const start = lx$.start;
  lx$.next();
  let param = ATOM_NONE;
  if (lx$.token === T_THIS) {
    lx$.next();
    param = A_this;
  } else if (isIdentifier()) {
    param = lx$.atom;
    noteNameInType(param, start);
    nextAfterName();
  } else {
    param = missingIdentifier(0, 0);
  }
  const t = eat(T_IS) ? ty() : NONE;
  const hir$ = hir;
  hir$.rareSyntax = hir$.rareSyntax | RARE_TYPE_PREDICATE;
  return pushTypePredicate(start, lx$.fullStart, param, t, 1);
}

/** `-1` or `-1n`, at the `-`. */
export function negativeLiteralType(): number {
  const lx$ = lx;
  const start = lx$.start;
  lx$.next();
  if (lx$.token === T_NUMBER) {
    const number = hir.pushNumber(-lx$.number);
    lx$.next();
    return pushTypeNumberLit(start, lx$.fullStart, number);
  }
  if (lx$.token === T_BIG_INT) {
    const atom = lx$.atom;
    lx$.next();
    return pushTypeBigIntLit(start, lx$.fullStart, atom, 1);
  }
  fail();
  return NONE;
}

/** `parseEntityName`, with reserved words allowed. Returns the list start, the length is in `p.outLen`. */
function entityName(): number {
  const s$ = s;
  const base = s$.names.len;
  let first = 0;
  let firstPos = 0;
  const lx$ = lx;
  if (lx$.token >= T_IDENTIFIER) {
    first = identifierName();
    firstPos = p.outPos | 0;
  } else {
    // "Type expected."
    first = missingIdentifier(1110, 0);
    firstPos = p.outPos | 0;
  }
  noteNameInType(first, firstPos);
  s$.names.push(hir.pushName(first, firstPos, 0));
  // `checkTypeReferenceNode`: `A.<T>`
  if (restOfEntityName(base) && !lx$.newlineBefore) {
    const dot = lx$.fullStart > 0 ? (lx$.fullStart - 1) | 0 : 0;
    flag(DK_GRAMMAR, 8020, dot, dot + 1);
  }
  return takeList(s$.names, base);
}

/** The loop of `parseEntityName`: pushes the names after the first on the stack of names (from `base`). Whether it ends between the dot and the `<` of `A.<T>`. */
function restOfEntityName(base: number): boolean {
  void base;
  const lx$ = lx;
  const s$ = s;
  const hir$ = hir;
  const p$ = p;
  while (lx$.token === T_DOT) {
    lx$.next();
    const token = lx$.token;
    if (token >= T_IDENTIFIER && token !== T_PRIVATE_IDENTIFIER && !lx$.newlineBefore) {
      s$.names.push(hir$.pushName(lx$.atom, lx$.start, 1));
      nextAfterName();
      continue;
    }
    const name = nameAfterDotInType();
    if (name === NO_WORD) return true;
    s$.names.push(hir$.pushName(name, p$.outPos, 1));
  }
  return false;
}

/** `parseRightSideOfDot(allowIdentifierNames, !allowPrivateIdentifiers)`. `NO_WORD`: at a `<`, where `parseEntityName` does not call it. The position is `p.outPos`. */
function nameAfterDotInType(): number {
  const lx$ = lx;
  const token = lx$.token;
  // Flow, whose `typeof a.b` is read here, has neither rule.
  const p$ = p;
  if (token === T_LESS_THAN && !p$.isFlow) return NO_WORD;
  const isWord = token >= T_IDENTIFIER;
  const startsSomethingElse = isWord && lx$.newlineBefore && !p$.isFlow && isFollowedByWordOnSameLine();
  if (startsSomethingElse && !p$.recovers) refuse(R_REPORTED);
  if (isWord && !startsSomethingElse) {
    if (token !== T_PRIVATE_IDENTIFIER) return identifierName();
    // `parsePrivateIdentifier`
    if (p$.recovers) lx$.next();
    else fail();
  }
  const at = lx$.fullStart | 0;
  if (isWord) {
    // "Report that we need an identifier. However, report it right after the dot"
    error(1003, at, -1);
  } else {
    missingIdentifier(0, 0);
  }
  p$.outPos = at;
  return A_empty;
}

/** `scanTypeMemberStart`, at a modifier: whether the list of members goes on with the token. */
function scanTypeMemberStart(): boolean {
  // "Eat up all modifiers, but hold on to the last one in case it is actually an identifier"
  const lx$ = lx;
  while (isModifier(lx$.token)) lx$.next();
  // "Index signatures and computed property names are type members"
  if (lx$.token === T_OPEN_BRACKET) return true;
  if (isLiteralPropertyName()) lx$.next();
  const t = lx$.token;
  return t === T_OPEN_PAREN || t === T_LESS_THAN || t === T_QUESTION || t === T_COLON || t === T_COMMA || canParseSemicolon();
}

// What `checkGrammarTypeArguments` reports about the last list of type arguments: the code (0: none), and the range.
let taErrCode = 0;
let taErrStart = 0;
let taErrEnd = 0;
/** The code of the error `typeArgumentList` / `typeArgumentsUnchecked` found last (0: none). */
export function typeArgsErrorCode(): number {
  return taErrCode;
}
export function typeArgsErrorStart(): number {
  return taErrStart;
}
export function typeArgsErrorEnd(): number {
  return taErrEnd;
}

/** `parseTypeArguments`, at the `<`, and `checkGrammarTypeArguments`. Returns the list start, the length is in `p.outLen`. */
export function typeArguments(): number {
  const list = typeArgumentsUnchecked();
  if (taErrCode !== 0) flag(DK_GRAMMAR, taErrCode, taErrStart, taErrEnd);
  return list;
}

/** After the expression of a heritage clause, or the name of a JSX element. `parseTypeArguments` does not rescan a `<<`. Babel's does. */
export function isAtTypeArgumentsOfHeritageElement(): boolean {
  const lx$ = lx;
  if (lx$.token === T_LESS_THAN_LESS_THAN && p.isBabel) {
    lx$.token = T_LESS_THAN;
    lx$.end = (lx$.start + 1) | 0;
  }
  return lx$.token === T_LESS_THAN;
}

/**
 * `parseTypeArguments`, at the `<`: the list (start returned, length in `p.outLen`), and what `checkGrammarTypeArguments` reports
 * about it where it is called, in `typeArgsErrorCode/Start/End`.
 */
export function typeArgumentsUnchecked(): number {
  if (p.isFlow) {
    taErrCode = 0;
    return flowTypeArguments();
  }
  const lx$ = lx;
  const lessThan = lx$.start;
  lx$.next();
  const base = s.ids.len;
  typeArgumentList(lessThan);
  expect(T_GREATER_THAN);
  return takeIds(base);
}

/**
 * `parseDelimitedList(PCTypeArguments, parseType)`, after the `<` at `lessThan`: pushes the types on the stack of ids. "The list ends
 * before any token that is neither a comma nor the start of a type", so it can be empty (1099) and can end with a comma (1009).
 * Returns the code of the error (0: none); the range is in `typeArgsErrorStart/End`.
 */
export function typeArgumentList(lessThan: number): number {
  const s$ = s;
  const base = s$.ids.len;
  const lists = enterList(LK_TYPE_ARGUMENTS);
  // Locals first: the lists nested in the types set the module slots too, and the last to finish is the outermost.
  let code = 0;
  let errStart = 0;
  let errEnd = 0;
  const lx$ = lx;
  while (true) {
    // TODO(oxc): `&& !isNameInTypeForOxc()`
    if (lx$.token !== T_COMMA && !isStartOfType(false)) {
      if (s$.ids.len === base) {
        // Up to the end of the token after the list, which is one character long.
        code = 1099;
        errStart = lessThan;
        errEnd = (lx$.start + 1) | 0;
      } else {
        code = 1009;
        errStart = (lx$.fullStart - 1) | 0;
        errEnd = lx$.fullStart;
      }
      break;
    }
    const t = ty();
    s$.ids.push(t);
    if (!eat(T_COMMA)) break;
  }
  leaveList(lists);
  taErrCode = code;
  taErrStart = errStart;
  taErrEnd = errEnd;
  return code;
}

/** `parseType` where `isStartOfType` is asked first, as `isListElement` does: for it a reserved word starts no type, although it can be the name in a type reference. */
function typeInList(): number {
  // With recovery `is_at_element` has asked, and a comma is an element whose type is missing.
  // TODO(oxc): `&& !isNameInTypeForOxc()`
  if (!p.recovers && !isStartOfType(false)) {
    fail();
    return NONE;
  }
  return ty();
}

/** `parseTypeArgumentsOfTypeReference`. Returns the list start (0 for none), the length is in `p.outLen`. */
function typeArgumentsOfTypeReference(isChecked: boolean): number {
  const lx$ = lx;
  const p$ = p;
  if (lx$.newlineBefore) {
    p$.outLen = 0;
    return 0;
  }
  const t = lx$.token;
  if (t === T_LESS_THAN) {
    // the list
  } else if (t === T_LESS_THAN_LESS_THAN) {
    // `ReScanLessThanToken`
    lx$.token = T_LESS_THAN;
    lx$.end = (lx$.start + 1) | 0;
  } else {
    p$.outLen = 0;
    return 0;
  }
  return typeArgumentsCheckedIf(isChecked);
}

/** `parseTypeArguments`, at the `<`. `isChecked`: with `checkGrammarTypeArguments`. */
function typeArgumentsCheckedIf(isChecked: boolean): number {
  return isChecked ? typeArguments() : typeArgumentsUnchecked();
}

/** `parseTypeReference` */
function typeReference(): number {
  const lx$ = lx;
  const start = lx$.start;
  const nameStart = entityName();
  const p$ = p;
  const nameLen = p$.outLen | 0;
  const argsStart = typeArgumentsOfTypeReference(true);
  const argsLen = p$.outLen | 0;
  return pushTypeRef(start, lx$.fullStart, nameStart, nameLen, argsStart, argsLen);
}

/** `isListElement(PCHeritageClauseElement)` */
export function isHeritageElement(): boolean {
  // TODO(oxc): `isInImplementsForOxc` / `isInInterfaceExtendsForOxc`, `{` and `implements` are names, `await`/`yield` in a type.
  const lx$ = lx;
  switch (lx$.token) {
    // `isValidHeritageClauseObjectLiteral`: `{}` is the body unless something follows that can follow an element.
    case T_OPEN_BRACE: {
      const m = lx$.mark();
      const had = lx$.refusal | 0;
      lx$.next();
      let result = true;
      if (lx$.token === T_CLOSE_BRACE) {
        lx$.next();
        const t = lx$.token;
        result = t === T_COMMA || t === T_OPEN_BRACE || t === T_EXTENDS || t === T_IMPLEMENTS;
      }
      lookAheadEnd(m, had);
      return result;
    }
    case T_EXTENDS:
      return false;
    // `isHeritageClauseExtendsOrImplementsKeyword`
    case T_IMPLEMENTS: {
      const m = lx$.mark();
      const had = lx$.refusal | 0;
      lx$.next();
      const startsExpression = isStartOfExpression();
      lookAheadEnd(m, had);
      return !startsExpression;
    }
    case T_LESS_THAN:
      if (p.isEcmascript) return true;
      return isStartOfLeftHandSideExpression();
    default:
      return isStartOfLeftHandSideExpression();
  }
}

// The comma at the end of the list of the last `heritageElements` (Rust: `Option<(u32, u32)>`).
let heritageHasComma = false;
let heritageCommaStart = 0;
let heritageCommaEnd = 0;
export function heritageListHasComma(): boolean {
  return heritageHasComma;
}
export function heritageListCommaStart(): number {
  return heritageCommaStart;
}
export function heritageListCommaEnd(): number {
  return heritageCommaEnd;
}

/**
 * `parseDelimitedList(PCHeritageClauseElement, ..)`, after `extends` or `implements`: calls `element(index)` for each. Returns their
 * number; `heritageListHasComma()/CommaStart()/CommaEnd()` describe the comma at the end of the list if there is one.
 */
export function heritageElements(element: (index: number) => void): number {
  let count = 0;
  heritageHasComma = false;
  const lists = enterList(LK_HERITAGE_CLAUSE_ELEMENT);
  const p$ = p;
  const lx$ = lx;
  while (isAtElement(LK_HERITAGE_CLAUSE_ELEMENT)) {
    if (!p$.recovers && !isHeritageElement()) break;
    const full = lx$.fullStart;
    element(count);
    count = (count + 1) | 0;
    heritageHasComma = lx$.token === T_COMMA;
    if (heritageHasComma) {
      heritageCommaStart = lx$.start;
      heritageCommaEnd = lx$.end;
    }
    if (hasFailed() || (!eat(T_COMMA) && !goesOnWithoutComma(LK_HERITAGE_CLAUSE_ELEMENT, full))) break;
  }
  leaveList(lists);
  // `isListTerminator`
  const t = lx$.token;
  if (!(t === T_OPEN_BRACE || t === T_EXTENDS || t === T_IMPLEMENTS)) failUnlessRecovering();
  return count;
}

/**
 * `parseExpressionWithTypeArguments` in a clause whose elements are types: any of an interface, `implements` of a class. `isChecked`:
 * `checkTypeReferenceNode` gets to it. `notEntityName`: what it says about `A?.B`.
 */
export function heritageType(isChecked: boolean, notEntityName: number): number {
  const lx$ = lx;
  const before = lx$.mark();
  let reference = NO_WORD;
  const p$ = p;
  if (p$.recovers) {
    // What type arguments have built is taken back if the expression goes on after them.
    const cp = tryParseBegin();
    if (cp >= 0) {
      reference = heritageEntityName(isChecked, notEntityName);
      if (!tryParseEnd(cp, reference !== NO_WORD)) reference = NO_WORD;
    }
  } else {
    reference = heritageEntityName(isChecked, notEntityName);
  }
  if (reference !== NO_WORD) {
    lx$.release(before);
    return reference;
  }
  if (hasFailed()) {
    lx$.release(before);
    return NONE;
  }
  // An error of its parser.
  if (p$.isFlow) {
    refuse(R_REPORTED);
    return NONE;
  }
  lx$.reset(before);
  // TODO(oxc): `isInImplementsForOxc`: `checkImplementedLikeOxc()` and a `/` that starts no regular expression.
  return heritageExpression(isChecked);
}

/** `heritage_type`, if `IsEntityNameExpression` is true of the expression. `NO_WORD`: it is not, and without recovery only tokens have been read. */
function heritageEntityName(isChecked: boolean, notEntityName: number): number {
  // TODO(oxc): `&& !isNameInTypeForOxc()` and `isInImplementsForOxc` words.
  if (!isIdentifier()) return NO_WORD;
  const lx$ = lx;
  const start = lx$.start;
  const s$ = s;
  const base = s$.names.len;
  const first = identifierName();
  const p$ = p;
  const firstPos = p$.outPos | 0;
  const hir$ = hir;
  s$.names.push(hir$.pushName(first, firstPos, 0));
  let isOptionalChain = false;
  while (lx$.token === T_DOT || lx$.token === T_QUESTION_DOT) {
    if (lx$.token === T_QUESTION_DOT) isOptionalChain = true;
    lx$.next();
    const token = lx$.token;
    if (token < T_IDENTIFIER || token === T_PRIVATE_IDENTIFIER || (lx$.newlineBefore && isFollowedByWordOnSameLine())) {
      s$.names.truncate(base);
      return NO_WORD;
    }
    s$.names.push(hir$.pushName(lx$.atom, lx$.start, 1));
    nextAfterName();
  }
  // `parseMemberExpressionRest` and `parseCallExpressionRest` go on.
  {
    const t = lx$.token;
    if (t === T_OPEN_PAREN || t === T_OPEN_BRACKET || t === T_NO_SUBSTITUTION_TEMPLATE || t === T_TEMPLATE_HEAD || (t === T_EXCLAMATION && !lx$.newlineBefore)) {
      s$.names.truncate(base);
      return NO_WORD;
    }
  }
  noteNameInType(first, firstPos);
  const nameStart = takeList(s$.names, base);
  const nameLen = p$.outLen | 0;
  if (isOptionalChain && isChecked) flag(DK_CHECKER, notEntityName, start, lx$.fullStart);
  // TODO(oxc): `if (isOptionalChain && notEntityName === 2499 && reportsLikeOxc()) oxc::interface_extends_expression(..)`
  let argsStart = 0;
  let argsLen = 0;
  if (lx$.token === T_LESS_THAN) {
    argsStart = typeArgumentsCheckedIf(isChecked);
    argsLen = p$.outLen | 0;
    const t = lx$.token;
    if (
      (t === T_OPEN_PAREN ||
        t === T_OPEN_BRACKET ||
        t === T_DOT ||
        t === T_QUESTION_DOT ||
        t === T_EXCLAMATION ||
        t === T_NO_SUBSTITUTION_TEMPLATE ||
        t === T_TEMPLATE_HEAD) &&
      goesOnAfterTypeArguments()
    ) {
      return NO_WORD;
    }
  }
  return pushTypeRef(start, lx$.fullStart, nameStart, nameLen, argsStart, argsLen);
}

/** Whether `parseLeftHandSideExpressionOrHigher` takes the type arguments before the token and goes on with it (`canFollowTypeArgumentsInExpression`). */
function goesOnAfterTypeArguments(): boolean {
  const p$ = p;
  if (!p$.recovers) {
    refuse(R_REPORTED);
    return false;
  }
  // In JavaScript no expression takes type arguments.
  if (!p$.hasTypeArgumentsInExpressions) return false;
  const lx$ = lx;
  const t = lx$.token;
  // It starts an expression, and only on the next line it goes on with this one.
  if (t === T_OPEN_BRACKET) return lx$.newlineBefore;
  // On the next line it goes on with nothing.
  if (t === T_EXCLAMATION) return false;
  return true;
}

/** `parseParenthesizedType`, where the `)` is missing. oxc looks for no comma there. */
function unclosedTypeInParentheses(): void {
  // TODO(oxc): `if (recovers && isForOxc()) expectedLikeOxc(")")`
  expect(T_CLOSE_PAREN);
}

/** `parseExpressionWithTypeArguments`, of an expression that is no entity name: the checker reports it. */
function heritageExpression(isChecked: boolean): number {
  const lx$ = lx;
  const start = lx$.start;
  const saved = enterContext(0, CTX_TYPE);
  let expr = leftHandSideExpression();
  const p$ = p;
  p$.context = saved;
  let argsStart = 0;
  let argsLen = 0;
  const hir$ = hir;
  const lastExpr = (hir$.nExprs - 1) | 0;
  if (
    expr + 1 === hir$.nExprs &&
    (hir$.exprTag[lastExpr] | 0) === EXPR_INSTANTIATION &&
    !(hir$.nParens > 0 && (hir$.parenExpr[(hir$.nParens - 1) | 0] | 0) === expr)
  ) {
    const instantiated = hir$.exprA[lastExpr] | 0;
    argsStart = hir$.exprB[lastExpr] | 0;
    argsLen = hir$.exprC[lastExpr] | 0;
    hir$.nExprs = lastExpr;
    expr = instantiated;
  } else if (lx$.token === T_LESS_THAN) {
    argsStart = typeArgumentsCheckedIf(isChecked);
    argsLen = p$.outLen | 0;
  }
  return pushTypeHeritage(start, lx$.fullStart, expr, argsStart, argsLen);
}

/**
 * `checkGrammarExpressionWithTypeArguments`, after an element of a heritage clause whose first token is at `firstStart..firstEnd`: what
 * it says about `import<T>`. Returns the start of the range of the error (-1: none); the end is in `p.outLen`, the code in `p.outA`.
 */
export function importWithTypeArguments(firstStart: number, firstEnd: number): number {
  void firstStart;
  void firstEnd;
  // TODO(recover): only with recovery (`import<T>` as a heritage element).
  return -1;
}

// Scratch of `interfaceHeritage`: the `extends` list and the other clauses' types.
const otherHeritage = s.ids; // (the others are pushed on the stack of ids and moved at the end)
let interfaceExtendsStart = 0;
let interfaceExtendsLen = 0;
let interfaceOthersStart = 0;
let interfaceOthersLen = 0;

/**
 * `parseHeritageClauses` of an interface, with what `checkGrammarInterfaceDeclaration` reports but for `implements`, which the checker
 * finds in the text: the types of the first `extends` clause, and those of the other clauses. Results in `interfaceExtends*`,
 * `interfaceOthers*` (read by `interfaceDeclaration` right away).
 */
function interfaceHeritage(): void {
  interfaceExtendsStart = 0;
  interfaceExtendsLen = 0;
  // The others are kept on the stack of ids below the clause that is being parsed: the stack is `[others.., current..]`.
  const s$ = s;
  const othersBase = s$.ids.len;
  let othersCount = 0;
  // The checker returns after 1172 or at `implements`.
  let hasExtends = false;
  let isChecked = true;
  const lists = enterList(LK_HERITAGE_CLAUSES);
  let isFirst = true;
  const lx$ = lx;
  const p$ = p;
  while (isAtHeritageClause(isFirst)) {
    isFirst = false;
    const keywordStart = lx$.start;
    const keywordEnd = lx$.end;
    const isExtends = lx$.token === T_EXTENDS;
    const isFirstExtends = isExtends && !hasExtends;
    if (!isFirstExtends && isChecked) {
      isChecked = false;
      if (isExtends) flag(DK_GRAMMAR, 1172, keywordStart, 0);
    }
    // TODO(oxc): misplaced clause diagnostics (`oxc::misplaced_clause`), `implements` keywords.
    hasExtends = hasExtends || isExtends;
    lx$.next();
    const base = s$.ids.len;
    // `heritage_elements(|p, _| { .. })`
    let count = 0;
    heritageHasComma = false;
    const lists2 = enterList(LK_HERITAGE_CLAUSE_ELEMENT);
    while (isAtElement(LK_HERITAGE_CLAUSE_ELEMENT)) {
      if (!p$.recovers && !isHeritageElement()) break;
      const full = lx$.fullStart;
      // ---- the element ----
      // TODO(oxc): `extendedLikeOxc`, `oxc::interface_extends_expression`; TODO(recover): `import_with_type_arguments` (element_error)
      const t = heritageType(isFirstExtends, 2499);
      s$.ids.push(t);
      // ---- end of the element ----
      count = (count + 1) | 0;
      heritageHasComma = lx$.token === T_COMMA;
      if (heritageHasComma) {
        heritageCommaStart = lx$.start;
        heritageCommaEnd = lx$.end;
      }
      if (hasFailed() || (!eat(T_COMMA) && !goesOnWithoutComma(LK_HERITAGE_CLAUSE_ELEMENT, full))) break;
    }
    leaveList(lists2);
    {
      const tk = lx$.token;
      if (!(tk === T_OPEN_BRACE || tk === T_EXTENDS || tk === T_IMPLEMENTS)) failUnlessRecovering();
    }
    // `checkGrammarHeritageClause`
    if (!isChecked) {
      // nothing
    } else if (heritageHasComma) {
      flag(DK_GRAMMAR, 1009, heritageCommaStart, 0);
    } else if (count === 0) {
      flagArgs(DK_GRAMMAR, 1097, keywordEnd, keywordEnd, ["extends"]);
    }
    if (isFirstExtends) {
      // The first `extends` list is moved to `ids` now; the others stay on the stack (above `othersBase`) — it is on top.
      interfaceExtendsStart = takeIds(base);
      interfaceExtendsLen = p$.outLen | 0;
    } else {
      // The types of this clause stay where they are, below the next clause: they become part of the `others`.
      othersCount = (othersCount + (s$.ids.len - base)) | 0;
    }
  }
  leaveList(lists);
  // `self.f.list(&others)`: the ids from `othersBase` on are exactly the others (the first `extends` was taken off the top).
  const otherHeritage$ = otherHeritage;
  interfaceOthersStart = hir.listFrom(otherHeritage$.data, otherHeritage$.len, othersBase);
  interfaceOthersLen = (otherHeritage$.len - othersBase) | 0;
  otherHeritage$.truncate(othersBase);
  void othersCount;
}

/** `parseTypeQuery` */
export function typeQuery(): number {
  const lx$ = lx;
  const start = lx$.start;
  lx$.next();
  // `parseEntityName(allowReservedWords, nil)`
  const s$ = s;
  const base = s$.names.len;
  let first = 0;
  let firstPos = 0;
  const p$ = p;
  if (lx$.token >= T_IDENTIFIER) {
    first = identifierName();
    firstPos = p$.outPos | 0;
  } else {
    const at = lx$.fullStart | 0;
    missingIdentifier(0, 0);
    first = A_empty;
    firstPos = at;
  }
  const hir$ = hir;
  s$.names.push(hir$.pushName(first, firstPos, 0));
  restOfEntityName(base);
  // No atom of a name that is missing is looked at.
  if (hasFailed()) {
    s$.names.truncate(base);
    return NONE;
  }
  // `a.b.c` as an expression.
  let expr = NONE;
  const names = s$.names;
  for (let i = base; i < names.len; i++) {
    const nm = names.data[i] | 0;
    const name = hir$.nameText[nm] | 0;
    const pos = hir$.namePos[nm] | 0;
    // The name ends where its text ends: no name here has an escape.
    const end = (pos + lx$.textLen(name)) | 0;
    if (expr < 0) {
      expr = name === A_this ? pushExprThis(firstPos, end) : pushExprIdent(firstPos, end, name);
    } else {
      expr = pushExprDot(firstPos, end, expr, name, pos, CHAIN_NO);
    }
  }
  for (let i = base; i < names.len; i++) {
    const nm = names.data[i] | 0;
    noteNameInType(hir$.nameText[nm] | 0, hir$.namePos[nm] | 0);
  }
  const nameStart = takeList(names, base);
  const nameLen = p$.outLen | 0;
  const hasTypeArguments = lx$.token === T_LESS_THAN && !lx$.newlineBefore;
  let argsStart = 0;
  let argsLen = 0;
  if (hasTypeArguments) {
    argsStart = typeArguments();
    argsLen = p$.outLen | 0;
  }
  return pushTypeTypeof(start, lx$.fullStart, nameStart, nameLen, argsStart, argsLen, expr, hasTypeArguments ? 1 : 0);
}

// Results of `attributesOfImportType`.
let importTypeMode = 0;
let importTypeAttributes = 0;

/** `parseImportType` */
function importType(): number {
  const lx$ = lx;
  const start = lx$.start;
  const isTypeof = eat(T_TYPE_OF);
  expect(T_IMPORT);
  expect(T_OPEN_PAREN);
  let spec = lx$.atom;
  const before = lx$.mark();
  // `IsLiteralImportTypeNode`
  let argument = NONE;
  if (eat(T_STRING) && (lx$.token === T_COMMA || lx$.token === T_CLOSE_PAREN)) {
    lx$.release(before);
  } else {
    argument = argumentOfImportType(before);
  }
  let mode = RM_NONE;
  let attributes = IAT_NONE;
  if (eat(T_COMMA)) {
    attributesOfImportType();
    mode = importTypeMode;
    attributes = importTypeAttributes;
  }
  expect(T_CLOSE_PAREN);
  // `if (argument < 0)`: a `SpecifierUse` (a table the formatter does not keep).
  let nameStart = 0;
  let nameLen = 0;
  const s$ = s;
  const p$ = p;
  if (eat(T_DOT)) {
    // `parseEntityNameOfTypeReference`
    const base = s$.names.len;
    if (lx$.token >= T_IDENTIFIER) {
      const first = identifierName();
      s$.names.push(hir.pushName(first, p$.outPos, 0));
    } else {
      missingQualifierOfImportType();
    }
    restOfEntityName(base);
    if (s$.names.len > base) {
      nameStart = takeList(s$.names, base);
      nameLen = p$.outLen | 0;
    }
  }
  // `checkImportType` does not look at the list.
  let argsStart = 0;
  let argsLen = 0;
  if (argument < 0) {
    // TODO(oxc): `isChecked = reportsLikeOxc()`
    argsStart = typeArgumentsOfTypeReference(false);
    argsLen = p$.outLen | 0;
  } else {
    spec = ATOM_NONE;
    mode = RM_NONE;
    argsStart = argumentInPlaceOfTypeArguments(argument);
    argsLen = p$.outLen | 0;
  }
  const flags = (isTypeof ? 1 : 0) | (mode << 1) | (attributes << 3);
  return pushTypeImport(start, lx$.fullStart, spec, nameStart, nameLen, argsStart, argsLen, flags);
}

/**
 * The argument of `import(..)`, which starts at `before`, unless it is nothing but a string: `getTypeFromImportTypeNode` reports it.
 * Resets or releases `before`.
 */
function argumentOfImportType(before: number): number {
  const lx$ = lx;
  if (hasFailed()) {
    lx$.release(before);
    return NONE;
  }
  lx$.reset(before);
  const start = lx$.start;
  const isString = lx$.token === T_STRING;
  const argument = ty();
  const hir$ = hir;
  const last = (hir$.nTypes - 1) | 0;
  if (isString && argument + 1 === hir$.nTypes && last >= 0 && (hir$.typeTag[last] | 0) === TYPE_STRING_LIT && (hir$.typePos[last] | 0) === start) {
    hir$.nTypes = last;
    return NONE;
  }
  flag(DK_CHECKER, 1141, start, lx$.fullStart);
  // TODO(oxc): `oxc::argument_of_import_type(..)`
  return argument;
}

/**
 * The `args` of `import(argument)`: `checkImportType` looks at an argument that is no string. The tree has no place for the type
 * arguments, which the token can be the `<` of. Returns the list start, the length is in `p.outLen`.
 */
function argumentInPlaceOfTypeArguments(argument: number): number {
  forgetNodesBegin();
  typeArgumentsOfTypeReference(false);
  forgetNodesEnd();
  const s$ = s;
  const base = s$.ids.len;
  s$.ids.push(argument);
  return takeIds(base);
}

// `forget_nodes(&checkpoint)`: the nodes built since are dropped, the tokens stay consumed. Only the tables that the type arguments of
// a type reference can fill are restored (the kept ones — diagnostics, keyword identifier positions — are left).
const forgotten = new Int32Array(32);
function forgetNodesBegin(): void {
  const hir$ = hir;
  forgotten[0] = hir$.idsLen | 0;
  forgotten[1] = hir$.numbersLen | 0;
  forgotten[2] = hir$.nExprs | 0;
  forgotten[3] = hir$.nTypes | 0;
  forgotten[4] = hir$.nPats | 0;
  forgotten[5] = hir$.nPatProps | 0;
  forgotten[6] = hir$.nPatElems | 0;
  forgotten[7] = hir$.nFns | 0;
  forgotten[8] = hir$.nParams | 0;
  forgotten[9] = hir$.nTypeParams | 0;
  forgotten[10] = hir$.nMembers | 0;
  forgotten[11] = hir$.nTupleElems | 0;
  forgotten[12] = hir$.nMapped | 0;
  forgotten[13] = hir$.nModifiers | 0;
  forgotten[14] = hir$.nNames | 0;
  forgotten[15] = hir$.nParens | 0;
  forgotten[16] = hir$.nCalls | 0;
  forgotten[17] = hir$.nProps | 0;
  forgotten[18] = hir$.nVarDecls | 0;
  forgotten[19] = hir$.nStmts | 0;
  forgotten[20] = hir$.nClasses | 0;
  forgotten[21] = hir$.nJsx | 0;
  forgotten[22] = hir$.nNonNullEnds | 0;
  forgotten[23] = hir$.nJsxExpressions | 0;
  forgotten[24] = hir$.nBodyStarts | 0;
  forgotten[25] = hir$.nInterfaces | 0;
  forgotten[26] = hir$.nAliases | 0;
  forgotten[27] = hir$.nEnums | 0;
  forgotten[28] = hir$.nDecorators | 0;
}
function forgetNodesEnd(): void {
  const hir$ = hir;
  hir$.idsLen = forgotten[0] | 0;
  hir$.numbersLen = forgotten[1] | 0;
  hir$.nExprs = forgotten[2] | 0;
  hir$.nTypes = forgotten[3] | 0;
  hir$.nPats = forgotten[4] | 0;
  hir$.nPatProps = forgotten[5] | 0;
  hir$.nPatElems = forgotten[6] | 0;
  hir$.nFns = forgotten[7] | 0;
  hir$.nParams = forgotten[8] | 0;
  hir$.nTypeParams = forgotten[9] | 0;
  hir$.nMembers = forgotten[10] | 0;
  hir$.nTupleElems = forgotten[11] | 0;
  hir$.nMapped = forgotten[12] | 0;
  hir$.nModifiers = forgotten[13] | 0;
  hir$.nNames = forgotten[14] | 0;
  hir$.nParens = forgotten[15] | 0;
  hir$.nCalls = forgotten[16] | 0;
  hir$.nProps = forgotten[17] | 0;
  hir$.nVarDecls = forgotten[18] | 0;
  hir$.nStmts = forgotten[19] | 0;
  hir$.nClasses = forgotten[20] | 0;
  hir$.nJsx = forgotten[21] | 0;
  hir$.nNonNullEnds = forgotten[22] | 0;
  hir$.nJsxExpressions = forgotten[23] | 0;
  hir$.nBodyStarts = forgotten[24] | 0;
  hir$.nInterfaces = forgotten[25] | 0;
  hir$.nAliases = forgotten[26] | 0;
  hir$.nEnums = forgotten[27] | 0;
  hir$.nDecorators = forgotten[28] | 0;
}

/** `parseImportType`, after the comma: `{ with: { name: "value" } }`. Results in `importTypeMode/Attributes`. */
function attributesOfImportType(): void {
  const lx$ = lx;
  const open = lx$.start;
  expect(T_OPEN_BRACE);
  let attributes = IAT_NONE;
  const t = lx$.token;
  if (t === T_WITH) {
    attributes = IAT_WITH;
  } else if (t === T_ASSERT) {
    // An error of the native parser.
    if (p.isTypescript5) flag(DK_GRAMMAR, 2880, lx$.start, 0);
    else errorAndGoOn(2880, lx$.start, 0);
    attributes = IAT_ASSERT;
  } else {
    // The token stays, and `import_attributes` goes on at it.
    errorAtTokenArgs(1005, ["with"]);
    attributes = IAT_WITH;
  }
  const mode = importAttributes(true);
  eat(T_COMMA);
  if (!eat(T_CLOSE_BRACE)) unclosedImportAttributes(open);
  importTypeMode = mode;
  importTypeAttributes = attributes;
}

/** `parseIdentifierNameWithDiagnostic(Type_expected)` after `import(..).`, at no name. */
function missingQualifierOfImportType(): void {
  const lx$ = lx;
  const at = lx$.fullStart | 0;
  missingIdentifier(1110, 0);
  // `NodeIsMissing(n.Qualifier)`: a missing name that none follows is no qualifier.
  if (lx$.token === T_DOT && peek() !== T_LESS_THAN) s.names.push(hir.pushName(A_empty, at, 0));
}

/** `parseTemplateType` */
function templateType(): number {
  const lx$ = lx;
  const start = lx$.start;
  // The first text, then each type and the text after it.
  const s$ = s;
  const base = s$.ids.len;
  pieceOfTemplateWithoutTag();
  s$.ids.push(lx$.atom);
  lx$.next();
  while (true) {
    const t = ty();
    // `parseLiteralOfTemplateSpan`
    if (lx$.token !== T_CLOSE_BRACE) {
      expected(T_CLOSE_BRACE);
      s$.ids.push(t);
      s$.ids.push(A_empty);
      break;
    }
    lx$.rescanTemplateContinuation();
    pieceOfTemplateWithoutTag();
    s$.ids.push(t);
    s$.ids.push(lx$.atom);
    const goesOn = lx$.token === T_TEMPLATE_MIDDLE;
    lx$.next();
    if (!goesOn) break;
  }
  const ids = s$.ids;
  const parts = (ids.len - base) | 0;
  const count = (parts / 2) | 0;
  const hir$ = hir;
  const first = hir$.idsLen | 0;
  // The types are the odd parts, then the texts: the even ones.
  for (let i = 1; i < parts; i += 2) hir$.pushId(ids.data[base + i] | 0);
  for (let i = 0; i < parts; i += 2) hir$.pushId(ids.data[base + i] | 0);
  ids.truncate(base);
  return pushTypeTemplate(start, lx$.fullStart, first, count, (first + count) | 0, (count + 1) | 0);
}

/** `parseTupleType` */
function tupleType(): number {
  const lx$ = lx;
  const start = lx$.start;
  lx$.next();
  const s$ = s;
  const base = s$.tupleElems.len;
  const lists = enterList(LK_TUPLE_ELEMENT_TYPES);
  while (isInList(T_CLOSE_BRACKET) && isAtElement(LK_TUPLE_ELEMENT_TYPES)) {
    const element = lx$.fullStart;
    tupleElement();
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_TUPLE_ELEMENT_TYPES, element)) break;
  }
  leaveList(lists);
  expect(T_CLOSE_BRACKET);
  // TODO(oxc): `oxc::tuple_elements(..)` when an element is optional.
  const elems = takeList(s$.tupleElems, base);
  return pushTypeTuple(start, lx$.fullStart, elems, p.outLen);
}

/** `parseTupleElementNameOrTupleElementType` */
function tupleElement(): void {
  const lx$ = lx;
  const start = lx$.start;
  // `isTupleElementName`
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  eat(T_DOT_DOT_DOT);
  let isNamed = false;
  if (lx$.token >= T_IDENTIFIER) {
    lx$.next();
    isNamed = lx$.token === T_COLON || (eat(T_QUESTION) && lx$.token === T_COLON);
  }
  lookAheadEnd(m, had);
  const hasDots = eat(T_DOT_DOT_DOT);
  const hir$ = hir;
  const element = hir$.newTupleElem();
  hir$.tupleElemRest[element] = hasDots ? 1 : 0;
  hir$.tupleElemHasDots[element] = hasDots ? 1 : 0;
  hir$.tupleElemStart[element] = start;
  const p$ = p;
  if (isNamed) {
    const name = lx$.atom;
    hir$.tupleElemName[element] = name;
    noteNameInType(name, start);
    nextAfterName();
    const optional = eat(T_QUESTION);
    hir$.tupleElemOptional[element] = optional ? 1 : 0;
    expect(T_COLON);
    // `parseTupleElementType`
    const typeStart = lx$.start;
    const hasDotsBeforeType = eat(T_DOT_DOT_DOT);
    const t = ty();
    hir$.tupleElemTy[element] = t;
    hir$.tupleElemWritten[element] = t;
    const end = lx$.fullStart | 0;
    hir$.tupleElemEnd[element] = end;
    if (hasDotsBeforeType || (hasDots && optional) || (p$.lastNullableType === t && p$.lastNullableTypeEnd === end)) {
      checkNamedTupleMember(element, typeStart, hasDotsBeforeType);
    }
  } else {
    // `parseTupleElementType`: a `JSDocNullableType` that is the whole type is an optional element.
    let t = typeInList();
    hir$.tupleElemTy[element] = t;
    if (!hasDots) {
      const inner = takeBackNullableType(t);
      if (inner !== NO_WORD) {
        t = inner;
        hir$.tupleElemTy[element] = t;
        hir$.tupleElemOptional[element] = 1;
      }
    }
    hir$.tupleElemWritten[element] = t;
    hir$.tupleElemEnd[element] = lx$.fullStart;
  }
  s.tupleElems.push(element);
}

/** `T`, if `t` is the `T?` that ends with the previous token. Its node is removed. `NO_WORD` otherwise. */
function takeBackNullableType(t: number): number {
  const p$ = p;
  const hir$ = hir;
  if (p$.lastNullableType !== t || p$.lastNullableTypeEnd !== lx.fullStart || t + 1 !== hir$.nTypes) return NO_WORD;
  const last = (hir$.nTypes - 1) | 0;
  if ((hir$.typeTag[last] | 0) !== TYPE_JSDOC) return NO_WORD;
  const aux = hir$.typeAux[last] | 0;
  // kind = Nullable, is_postfix
  if ((aux & 3) !== JSD_NULLABLE || (aux & 4) === 0) return NO_WORD;
  const operand = hir$.typeA[last] | 0;
  hir$.nTypes = last;
  return operand;
}

/** `getTypeFromRestTypeNode`: the element type if `t` is an array type, otherwise `t`. */
function restElementType(t: number): number {
  const hir$ = hir;
  if (t >= 0 && t < hir$.nTypes && (hir$.typeTag[t] | 0) === TYPE_ARRAY) return hir$.typeA[t] | 0;
  return t;
}

/** `checkNamedTupleMember`, of `name: ...T`, `name: T?` and `...name?: T`. The type starts at `typeStart`, with its dots. */
function checkNamedTupleMember(element: number, typeStart: number, hasDotsBeforeType: boolean): void {
  const hir$ = hir;
  const end = hir$.tupleElemEnd[element] | 0;
  const s$ = s;
  if (hasDotsBeforeType) {
    hir$.tupleElemMemberType[element] = TM_REST;
    flag(DK_GRAMMAR, 5087, typeStart, end);
    hir$.tupleElemTy[element] = restElementType(hir$.tupleElemTy[element] | 0);
  } else {
    const operand = takeBackNullableType(hir$.tupleElemTy[element] | 0);
    if (operand !== NO_WORD) {
      hir$.tupleElemMemberType[element] = TM_OPTIONAL;
      hir$.tupleElemWritten[element] = operand;
      flag(DK_GRAMMAR, 5086, typeStart, end);
      // `getTypeFromOptionalTypeNode`
      const undefinedTy = pushTypeKeyword(typeStart, typeStart, KW_UNDEFINED);
      const base = s$.ids.len;
      s$.ids.push(operand);
      s$.ids.push(undefinedTy);
      const members = takeIds(base);
      hir$.tupleElemTy[element] = pushTypeUnion(typeStart, end, members, p.outLen);
    }
  }
  if ((hir$.tupleElemHasDots[element] | 0) !== 0 && (hir$.tupleElemOptional[element] | 0) !== 0) {
    flag(DK_GRAMMAR, 5085, hir$.tupleElemStart[element] | 0, end);
    // `getTupleElementFlags`: it is optional.
    hir$.tupleElemRest[element] = 0;
    hir$.tupleElemTy[element] = restElementType(hir$.tupleElemTy[element] | 0);
  }
}

/** `isStartOfMappedType` */
function isStartOfMappedType(): boolean {
  const lx$ = lx;
  lx$.next();
  if (lx$.token === T_PLUS || lx$.token === T_MINUS) {
    lx$.next();
    return lx$.token === T_READONLY;
  }
  if (lx$.token === T_READONLY) lx$.next();
  if (lx$.token !== T_OPEN_BRACKET) return false;
  lx$.next();
  if (!isIdentifier()) return false;
  lx$.next();
  return lx$.token === T_IN;
}

/** `parseMappedType` */
function mappedType(): number {
  const lx$ = lx;
  const start = lx$.start;
  lx$.next();
  let readonly = MM_NONE;
  let isReadonlyWithPlus = 0;
  switch (lx$.token) {
    case T_READONLY:
      lx$.next();
      readonly = MM_ADD;
      break;
    case T_PLUS:
      lx$.next();
      expect(T_READONLY);
      readonly = MM_ADD;
      isReadonlyWithPlus = 1;
      break;
    case T_MINUS:
      lx$.next();
      expect(T_READONLY);
      readonly = MM_REMOVE;
      break;
    default:
      break;
  }
  expect(T_OPEN_BRACKET);
  // `parseMappedTypeParameter`
  const name = identifierName();
  const p$ = p;
  const pos = p$.outPos | 0;
  noteIdentifier(name, pos);
  expect(T_IN);
  const constraint = ty();
  const paramEnd = lx$.fullStart | 0;
  const nameTy = eat(T_AS) ? ty() : NONE;
  expect(T_CLOSE_BRACKET);
  let optional = MM_NONE;
  let isOptionalWithPlus = 0;
  switch (lx$.token) {
    case T_QUESTION:
      lx$.next();
      optional = MM_ADD;
      break;
    case T_PLUS:
      lx$.next();
      expect(T_QUESTION);
      optional = MM_ADD;
      isOptionalWithPlus = 1;
      break;
    case T_MINUS:
      lx$.next();
      expect(T_QUESTION);
      optional = MM_REMOVE;
      break;
    default:
      break;
  }
  const t = typeAnnotation();
  // TODO(oxc): `dialect.oxc`: `eat(T_SEMICOLON)` instead of `semicolon()`.
  semicolon();
  let membersStart = 0;
  let membersLen = 0;
  if (lx$.token !== T_CLOSE_BRACE) {
    membersStart = membersAfterMappedType();
    membersLen = p$.outLen | 0;
  }
  expect(T_CLOSE_BRACE);
  const hir$ = hir;
  const param = hir$.pushTypeParam(name, pos, pos, paramEnd, constraint, NONE, 0, 0, 0);
  const mapped = hir$.pushMapped(param, nameTy, t, readonly, optional, isReadonlyWithPlus, isOptionalWithPlus, membersStart, membersLen);
  return pushTypeMapped(start, lx$.fullStart, mapped);
}

/** The `parseList(PCTypeMembers, parseTypeMember)` of `parseMappedType`, and `checkGrammarMappedType`. */
function membersAfterMappedType(): number {
  // TODO(oxc): `expectedLikeOxc("}")`
  const members = typeMemberList();
  const p$ = p;
  const len = p$.outLen | 0;
  const hir$ = hir;
  if (len !== 0) {
    const first = hir$.ids[members] | 0;
    // `GetErrorRangeForNode`
    const kind = hir$.memberKind[first] | 0;
    if (kind === MEMBER_PROPERTY || kind === MEMBER_GETTER || kind === MEMBER_SETTER) {
      flag(DK_GRAMMAR, 7061, hir$.memberNamePos[first] | 0, 0);
    } else {
      flag(DK_GRAMMAR, 7061, hir$.memberStart[first] | 0, hir$.memberLocEnd[first] | 0);
    }
  }
  p$.outLen = len;
  return members;
}

/** `parseTypeLiteral` */
function typeLiteral(): number {
  const lx$ = lx;
  const start = lx$.start;
  const members = objectTypeMembers();
  return pushTypeObject(start, lx$.fullStart, members, p.outLen);
}

/** `parseObjectTypeMembers`, at the `{`. Returns the list start, the length is in `p.outLen`. */
export function objectTypeMembers(): number {
  const p$ = p;
  if (!expect(T_OPEN_BRACE)) {
    p$.outLen = 0;
    return 0;
  }
  const members = typeMemberList();
  const len = p$.outLen | 0;
  expect(T_CLOSE_BRACE);
  p$.outLen = len;
  return members;
}

/** `parseList(PCTypeMembers, parseTypeMember)`. Returns the list start, the length is in `p.outLen`. */
function typeMemberList(): number {
  const s$ = s;
  const base = s$.members.len;
  const lists = enterList(LK_TYPE_MEMBERS);
  while (isInList(T_CLOSE_BRACE) && isAtElement(LK_TYPE_MEMBERS)) {
    const member = typeMember();
    s$.members.push(member);
  }
  leaveList(lists);
  return takeList(s$.members, base);
}

/** `parseTypeMemberSemicolon` */
function typeMemberSemicolon(): void {
  // "We allow type members to be separated by commas or (possibly ASI) semicolons."
  if (!eat(T_COMMA)) semicolon();
}

/** `isIndexSignature`, at a `[`. */
export function isIndexSignature(): boolean {
  // `isUnambiguouslyIndexSignature`
  const lx$ = lx;
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  lx$.next();
  let r = false;
  if (lx$.token === T_DOT_DOT_DOT || lx$.token === T_CLOSE_BRACKET) {
    r = true;
  } else {
    let cont = true;
    if (isModifier(lx$.token)) {
      lx$.next();
      if (isIdentifier()) {
        r = true;
        cont = false;
      }
    } else if (!isIdentifier()) {
      cont = false;
    } else {
      lx$.next();
    }
    if (cont) {
      if (lx$.token === T_COLON || lx$.token === T_COMMA) {
        r = true;
      } else if (lx$.token === T_QUESTION) {
        lx$.next();
        r = lx$.token === T_COLON || lx$.token === T_COMMA || lx$.token === T_CLOSE_BRACKET;
      }
    }
  }
  lookAheadEnd(m, had);
  return r;
}

/**
 * `checkGrammarIndexSignatureParameters`, up to the check of the type of the parameter. `comma`: the one at the end of the list (-1: none).
 * `memberStart..memberEnd`: from the start to the end of the signature.
 */
function checkIndexSignatureParameters(paramsStart: number, paramsLen: number, comma: number, memberStart: number, memberEnd: number): void {
  if (hasFailed()) return;
  if (paramsLen === 0) {
    flag(DK_GRAMMAR, 1096, memberStart, memberEnd);
    return;
  }
  const hir$ = hir;
  const first = hir$.ids[paramsStart] | 0;
  const firstPat = hir$.paramPat[first] | 0;
  const name = firstPat >= 0 && firstPat < hir$.nPats ? hir$.patPos[firstPat] | 0 : 0;
  if (paramsLen !== 1) {
    flag(DK_GRAMMAR, 1096, name, 0);
    return;
  }
  if (comma >= 0) flag(DK_GRAMMAR, 1025, comma, 0);
  const flags = hir$.paramFlags[first] | 0;
  let at = -1;
  let code = 0;
  if ((flags & FLAG_REST) !== 0) {
    at = hir$.paramPos[first] | 0;
    code = 1017;
  } else if ((hir$.paramPos[first] | 0) !== name) {
    at = name;
    code = 1018;
  } else if ((flags & FLAG_OPTIONAL) !== 0) {
    at = p.questionOfParameter;
    code = 1019;
  } else if ((hir$.paramDefault[first] | 0) >= 0) {
    at = name;
    code = 1020;
  } else if ((hir$.paramTy[first] | 0) < 0) {
    at = name;
    code = 1022;
  }
  if (at >= 0) flag(DK_GRAMMAR, code, at, 0);
}

/** `parseIndexSignatureDeclaration`, at the `[`. Returns the member id. */
export function indexSignature(startPos: number, startFull: number, flags: number, modStart: number, modLen: number): number {
  const lx$ = lx;
  const bracket = lx$.start;
  lx$.next();
  const saved = enterContext(CTX_TYPE, 0);
  const params = parameterList(0, T_CLOSE_BRACKET);
  const p$ = p;
  const paramsLen = p$.outLen | 0;
  const last = lx$.fullStart > 0 ? (lx$.fullStart - 1) | 0 : 0;
  const comma = paramsLen !== 0 && (lx$.src[last] | 0) === 44 ? last : -1;
  expect(T_CLOSE_BRACKET);
  const t = typeAnnotation();
  // TODO(oxc): `if (t < 0 && reportsLikeOxc()) oxc::index_signature_without_type(..)`
  p$.context = saved;
  typeMemberSemicolon();
  checkIndexSignatureParameters(params, paramsLen, comma, startPos, lx$.fullStart);
  // TODO(oxc): `if (paramsLen === 1 && reportsLikeOxc()) oxc::index_signature_parameter(..)`
  const hir$ = hir;
  const func = hir$.pushFn(FN_INDEX_SIGNATURE, flags, ATOM_NONE, bracket, 0, 0, params, paramsLen, NONE, t, BODY_NONE, 0, 0, bracket, startPos);
  return hir$.pushMember(MEMBER_INDEX_SIGNATURE, PK_NONE, NONE, flags, t, NONE, func, startPos, startPos, startFull, lx$.fullStart, modStart, modLen);
}

/** From the type parameters of a signature to its return type. */
function signature(kind: number, flags: number, name: number, namePos: number, start: number): number {
  const tpStart = typeParameters();
  const p$ = p;
  const tpLen = p$.outLen | 0;
  // `createMissingList`
  const lx$ = lx;
  const anchor = lx$.token === T_OPEN_PAREN ? lx$.start : lx$.fullStart > 0 ? (lx$.fullStart - 1) | 0 : 0;
  const thisParam = parameters(0);
  const pStart = p$.outA | 0;
  const pLen = p$.outLen | 0;
  noteParametersOfAccessor(kind, pStart, pLen);
  // `shouldParseReturnType`: "This is easy to get backward, especially in type contexts, so parse the type anyway"
  if (lx$.token === T_EQUALS_GREATER_THAN && p$.recovers && kind !== FN_GETTER && kind !== FN_SETTER) {
    expected(T_COLON);
    lx$.token = T_COLON;
  }
  const ret = eat(T_COLON) ? typeOrTypePredicate() : NONE;
  const func = hir.pushFn(kind, flags, name, namePos, tpStart, tpLen, pStart, pLen, thisParam, ret, BODY_NONE, 0, 0, anchor, start);
  // TODO(oxc): `if (isOddFunction(..)) checkFunctionLikeOxc(func, 0)`
  return func;
}

/** `parseTypeMember`. Returns the member id. */
function typeMember(): number {
  const lx$ = lx;
  const startPos = lx$.start;
  const startFull = lx$.fullStart;
  const hir$ = hir;
  const member = hir$.newMember();
  hir$.memberNamePos[member] = startPos;
  hir$.memberStart[member] = startPos;
  let signatureKind = -1;
  let signatureFnKind = 0;
  const t0 = lx$.token;
  if (t0 === T_OPEN_PAREN || t0 === T_LESS_THAN) {
    signatureKind = MEMBER_CALL_SIGNATURE;
    signatureFnKind = FN_CALL_SIGNATURE;
  } else if (t0 === T_NEW) {
    const n = peek();
    if (n === T_OPEN_PAREN || n === T_LESS_THAN) {
      lx$.next();
      signatureKind = MEMBER_CONSTRUCT_SIGNATURE;
      signatureFnKind = FN_CONSTRUCT_SIGNATURE;
    }
  }
  const p$ = p;
  if (signatureKind >= 0) {
    hir$.memberKind[member] = signatureKind;
    hir$.memberFunc[member] = signature(signatureFnKind, 0, ATOM_NONE, startPos, startPos);
  } else {
    const firstModifier = s.modifiers.len;
    let flags = 0;
    if (isModifier(lx$.token)) {
      // With recovery `is_at_element` has asked.
      if (!p$.recovers) {
        const m = lx$.mark();
        const had = lx$.refusal | 0;
        const ok = scanTypeMemberStart();
        lookAheadEnd(m, had);
        if (!ok) fail();
      }
      flags = modifiers(MODS_TYPE_MEMBER);
    }
    hir$.memberFlags[member] = flags;
    const modStart = takeModifiers(firstModifier);
    const modLen = p$.outLen | 0;
    hir$.memberModStart[member] = modStart;
    hir$.memberModLen[member] = modLen;
    let kind = MEMBER_PROPERTY;
    let fnKind = FN_METHOD;
    if (lx$.token === T_GET || lx$.token === T_SET) {
      // `parseContextualModifier`
      const accessor = lx$.token;
      const m = lx$.mark();
      lx$.next();
      if (canFollowAccessorKeyword()) {
        lx$.release(m);
        if (accessor === T_GET) {
          kind = MEMBER_GETTER;
          fnKind = FN_GETTER;
        } else {
          kind = MEMBER_SETTER;
          fnKind = FN_SETTER;
        }
      } else {
        lx$.reset(m);
      }
    }
    hir$.memberKind[member] = kind;
    if (kind === MEMBER_PROPERTY && lx$.token === T_OPEN_BRACKET && isIndexSignature()) {
      // TODO(oxc): `if (flags & ~FLAG_READONLY && reportsLikeOxc()) oxc::index_signature(..)`
      // The member row made above is not used: the signature makes its own.
      hir$.nMembers = member;
      return indexSignature(startPos, startFull, flags, modStart, modLen);
    }
    // `parsePropertyOrMethodSignature`
    const nameToken = lx$.token;
    propertyName();
    let keyKind = p$.keyKind | 0;
    let keyVal = p$.keyVal | 0;
    const nameKind = p$.nameKind | 0;
    const namePos = p$.namePos | 0;
    // `declared_key`
    if (nameToken === T_BIG_INT) {
      // `getDeclarationName`: a bigint name declares nothing.
      keyKind = PK_NONE;
      keyVal = NONE;
    } else if (keyKind === PK_NAME && (flags & FLAG_DEFAULT) !== 0) {
      // `declareSymbolEx`: `isDefaultExport && parent != nil`
      keyVal = A_default;
    }
    // `getDeclarationName`: a private name outside a class declares nothing.
    if (p$.classesAround === 0 && keyKind === PK_PRIVATE) {
      keyKind = PK_NONE;
      keyVal = NONE;
    }
    hir$.memberKeyKind[member] = keyKind;
    hir$.memberKeyVal[member] = keyVal;
    hir$.memberNamePos[member] = namePos;
    flags = flags | flagsOfTypeMemberName(nameToken, nameKind, keyKind);
    // `parseAccessorDeclaration` takes none.
    if (kind === MEMBER_PROPERTY && eat(T_QUESTION)) flags = flags | FLAG_OPTIONAL;
    hir$.memberFlags[member] = flags;
    if (kind !== MEMBER_PROPERTY || lx$.token === T_OPEN_PAREN || lx$.token === T_LESS_THAN) {
      if (kind === MEMBER_PROPERTY) {
        kind = MEMBER_METHOD;
        hir$.memberKind[member] = kind;
      }
      const name = keyKind === PK_NAME || keyKind === PK_PRIVATE ? keyVal : ATOM_NONE;
      const func = signature(fnKind, flags & ~FLAG_LITERAL_NAME, name, namePos, startPos);
      hir$.memberFunc[member] = func;
      // `parseFunctionBlockOrSemicolon`: nothing has to follow a body.
      if (lx$.token === T_OPEN_BRACE && bodyInType(kind, func)) {
        hir$.memberLocPos[member] = startFull;
        hir$.memberLocEnd[member] = lx$.fullStart;
        return member;
      }
    } else {
      const ann = typeAnnotation();
      hir$.memberTy[member] = ann;
      // The checker reports it. `scanTypeMemberStart`: no member starts with `a =`.
      if (ann >= 0 || (flags & FLAG_OPTIONAL) !== 0) {
        const saved = enterContext(0, CTX_TYPE);
        hir$.memberInit[member] = optionalInitializer();
        p$.context = saved;
      }
    }
  }
  typeMemberSemicolon();
  hir$.memberLocPos[member] = startFull;
  hir$.memberLocEnd[member] = lx$.fullStart;
  // TODO(oxc): `if (modLen !== 0 && reportsLikeOxc()) oxc::type_member(..)`
  return member;
}

/**
 * At the `{` after the signature `func` of a member of a type. Whether it is an accessor, which `parseAccessorDeclaration` gives a body:
 * `checkGrammarAccessor` reports it.
 */
function bodyInType(kind: number, func: number): boolean {
  const p$ = p;
  if (kind !== MEMBER_GETTER && kind !== MEMBER_SETTER) {
    // `parseTypeMemberSemicolon` reports the `{`.
    if (!p$.recovers) refuse(R_REPORTED);
    return false;
  }
  const saved = enterContext(0, CTX_TYPE);
  const bodyStart = functionBlock(0);
  const bodyLen = p$.outLen | 0;
  const open = p$.outPos | 0;
  p$.context = saved;
  const hir$ = hir;
  hir$.fnBodyKind[func] = BODY_BLOCK;
  hir$.fnBodyA[func] = bodyStart;
  hir$.fnBodyB[func] = bodyLen;
  hir$.pushBodyStart(func, open);
  flag(DK_GRAMMAR, 1183, open, lx.fullStart);
  return true;
}

// ───────────────────────────── declarations ─────────────────────────────

/** `parseInterfaceDeclaration` */
export function interfaceDeclaration(startPos: number, startFull: number, base: number, flags: number): number {
  lx.next();
  // TODO(oxc): `if (token !== T_IDENTIFIER && reportsLikeOxc()) checkTypeNameLikeOxc(Interface)`
  const name = identifier();
  const p$ = p;
  const namePos = p$.outPos | 0;
  // TODO(oxc): `declare(name, DECLARES_INTERFACE)`
  const saved = enterContext(CTX_TYPE, 0);
  const tpStart = typeParameters();
  const tpLen = p$.outLen | 0;
  interfaceHeritage();
  const extendsStart = interfaceExtendsStart;
  const extendsLen = interfaceExtendsLen;
  const othersStart = interfaceOthersStart;
  const othersLen = interfaceOthersLen;
  const members = objectTypeMembers();
  const membersLen = p$.outLen | 0;
  p$.context = saved;
  const iface = hir.pushInterface(name, namePos, flags | ambient(), tpStart, tpLen, extendsStart, extendsLen, othersStart, othersLen, members, membersLen, NONE);
  const modStart = takeModifiers(base);
  const modLen = p$.outLen | 0;
  return finishStmt(pushStmtInterface(startPos, iface), startFull, modStart, modLen);
}

/** `parseTypeAliasDeclaration` */
export function typeAliasDeclaration(startPos: number, startFull: number, base: number, flags: number): number {
  const lx$ = lx;
  lx$.next();
  // After `declare type` a line break is possible, and an error.
  if (lx$.newlineBefore) errorAndGoOn(1142, lx$.start, lx$.start === lx$.end ? -1 : lx$.end);
  // TODO(oxc): `if (token !== T_IDENTIFIER && reportsLikeOxc()) checkTypeNameLikeOxc(TypeAlias)`
  const name = identifier();
  const p$ = p;
  const namePos = p$.outPos | 0;
  // TODO(oxc): `declare(name, DECLARES_ALIAS)`
  const saved = enterContext(CTX_TYPE, 0);
  const tpStart = typeParameters();
  const tpLen = p$.outLen | 0;
  p$.context = saved;
  expect(T_EQUALS);
  let t = NONE;
  if (lx$.token === T_INTRINSIC && peek() !== T_DOT) t = tokenTypeKeyword(KW_INTRINSIC);
  else t = ty();
  semicolon();
  const alias = hir.pushAlias(name, namePos, flags | ambient(), tpStart, tpLen, t, NONE);
  const modStart = takeModifiers(base);
  const modLen = p$.outLen | 0;
  return finishStmt(pushStmtTypeAlias(startPos, alias), startFull, modStart, modLen);
}
