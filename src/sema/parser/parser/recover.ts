// Port of vendor/bun/src/sema/parser/parser/recover.rs: going on after a syntax error, as TypeScript's parser does:
// `parseList`, `parseDelimitedList`, `abortParsingListOrMoveToNextToken`, `isInSomeParsingContext`, `parsingContextErrors`,
// `isListElement`, `isListTerminator`. The entry points that report (`error`, `expected`, `missingIdentifier`, ...) are in the leaf
// `mod.ts`; this file has what needs the rest of the grammar.
//
// Only with `p.recovers`. Without it the first error ends the file, or the speculative parse that is going on: a text without errors
// pays one test of a flag at each list.
import { MODK_DECORATOR, hir, pushStmtExpr } from "../../hir.ts";
import {
  CTX_AWAIT,
  CTX_TOP_LEVEL,
  LK_ARGUMENT_EXPRESSIONS,
  LK_ARRAY_BINDING_ELEMENTS,
  LK_ARRAY_LITERAL_MEMBERS,
  LK_BLOCK_STATEMENTS,
  LK_CLASS_MEMBERS,
  LK_ENUM_MEMBERS,
  LK_HERITAGE_CLAUSES,
  LK_HERITAGE_CLAUSE_ELEMENT,
  LK_IMPORT_ATTRIBUTES,
  LK_IMPORT_OR_EXPORT_SPECIFIERS,
  LK_JSX_ATTRIBUTES,
  LK_JSX_CHILDREN,
  LK_OBJECT_BINDING_ELEMENTS,
  LK_OBJECT_LITERAL_MEMBERS,
  LK_PARAMETERS,
  LK_SOURCE_ELEMENTS,
  LK_SWITCH_CLAUSES,
  LK_SWITCH_CLAUSE_STATEMENTS,
  LK_TUPLE_ELEMENT_TYPES,
  LK_TYPE_ARGUMENTS,
  LK_TYPE_MEMBERS,
  LK_TYPE_PARAMETERS,
  LK_VARIABLE_DECLARATIONS,
  canParseSemicolon,
  checkpoint,
  errorAtToken,
  errorAtTokenArgs,
  hasContext,
  fail,
  hasFailed,
  isBindingIdentifier,
  isIdentifier,
  lookAheadEnd,
  lx,
  next,
  p,
  peek,
  rollback,
  s,
  tokenSrcText,
  expected,
} from "./mod.ts";
import {
  T_ACCESSOR,
  T_ASTERISK,
  T_ASYNC,
  T_AT,
  T_AWAIT,
  T_BREAK,
  T_CASE,
  T_CATCH,
  T_CLASS,
  T_CLOSE_BRACE,
  T_CLOSE_BRACKET,
  T_CLOSE_PAREN,
  T_COLON,
  T_COMMA,
  T_CONST,
  T_CONTINUE,
  T_DEBUGGER,
  T_DECLARE,
  T_DEFAULT,
  T_DEFER,
  T_DO,
  T_DOT,
  T_DOT_DOT_DOT,
  T_ENUM,
  T_EOF,
  T_EQUALS,
  T_EQUALS_GREATER_THAN,
  T_EXCLAMATION,
  T_EXPORT,
  T_EXTENDS,
  T_FINALLY,
  T_FOR,
  T_FROM,
  T_FUNCTION,
  T_GET,
  T_GLOBAL,
  T_GREATER_THAN,
  T_IF,
  T_IMPLEMENTS,
  T_IMPORT,
  T_IN,
  T_INTERFACE,
  T_LESS_THAN,
  T_LET,
  T_MODULE,
  T_NAMESPACE,
  T_OF,
  T_OPEN_BRACE,
  T_OPEN_BRACKET,
  T_OPEN_PAREN,
  T_OVERRIDE,
  T_PRIVATE,
  T_PRIVATE_IDENTIFIER,
  T_PROTECTED,
  T_PUBLIC,
  T_QUESTION,
  T_READONLY,
  T_RETURN,
  T_SEMICOLON,
  T_SET,
  T_SLASH,
  T_STATIC,
  T_STRING,
  T_SWITCH,
  T_THROW,
  T_TRY,
  T_TYPE,
  T_USING,
  T_VAR,
  T_WHILE,
  T_WITH,
  isIdentifierOrKeyword,
  isModifier,
} from "../token.ts";
import { firstOperandPos, isStartOfExpression } from "./expr.ts";
import { isStartOfParameter, isStartOfType, isHeritageElement } from "./ty.ts";
import { isLiteralPropertyName, isStartOfDeclaration, statement } from "./stmt.ts";

// `ListStep`: what the token at the top of the loop of a list is to the list.
const STEP_ELEMENT = 0;
const STEP_SKIPPED = 1;
const STEP_OVER = 2;

const ALL_LISTS_COUNT = 23;

/** `IsKeyword`: a keyword or a contextual word. */
function isAtKeyword(): boolean {
  return lx.token > T_PRIVATE_IDENTIFIER;
}

/** `isBindingIdentifierOrPrivateIdentifierOrPattern` */
function isBindingIdentifierOrPattern(): boolean {
  const t = lx.token;
  return t === T_OPEN_BRACE || t === T_OPEN_BRACKET || t === T_PRIVATE_IDENTIFIER || isBindingIdentifier();
}

/** The condition of the loop of `parseHeritageClauses`, which is a list only from the first clause on. */
export function isAtHeritageClause(isFirst: boolean): boolean {
  if (isFirst || !p.recovers) {
    const t = lx.token;
    return t === T_EXTENDS || t === T_IMPLEMENTS;
  }
  return skipToElement(LK_HERITAGE_CLAUSES);
}

/**
 * The condition of the loops of `parseList` and `parseDelimitedList`, before each element: whether the list of `kind` goes on,
 * after the tokens that are reported and skipped. Only recovery asks: without it, what is no element is an error where it is parsed.
 */
export function isAtElement(kind: number): boolean {
  return !p.recovers || skipToElement(kind);
}

function skipToElement(kind: number): boolean {
  const p$ = p;
  const lx$ = lx;
  if (kind === LK_SOURCE_ELEMENTS) {
    // The loop of `reparseTopLevelAwait` calls `parseStatement` whatever the token is, and goes to the next token if that has
    // consumed nothing.
    if (p$.reparsesRestOfFile) {
      if (lx$.start === p$.reparsedAt) next();
      p$.reparsedAt = lx$.start | 0;
      return lx$.token !== T_EOF;
    }
    p$.hasAwaitInStatement = false;
    p$.wasAwaitRefused = false;
  }
  for (;;) {
    const step = listStep(kind);
    if (step === STEP_ELEMENT) return true;
    if (step === STEP_OVER) return false;
  }
}

/** `recover_missing_comma`, which only recovery needs. */
export function goesOnWithoutComma(kind: number, element: number): boolean {
  return p.recovers && recoverMissingComma(kind, element);
}

/** What the token is to the list of `kind`, which the loop of the list is at the top of. */
function listStep(kind: number): number {
  if (isListElement(kind, false)) return STEP_ELEMENT;
  if (isListTerminator(kind) || abortListOrSkip(kind)) return STEP_OVER;
  return STEP_SKIPPED;
}

/**
 * The end of the loop of `parseDelimitedList`, after an element that starts at the full start `element` and that no comma follows.
 * Whether the list goes on.
 */
function recoverMissingComma(kind: number, element: number): boolean {
  if (isListTerminator(kind)) return false;
  if (kind === LK_ENUM_MEMBERS) errorAtToken(1357);
  else {
    let closer = "}";
    if (kind === LK_ARGUMENT_EXPRESSIONS || kind === LK_PARAMETERS) closer = ")";
    else if (kind === LK_ARRAY_BINDING_ELEMENTS || kind === LK_ARRAY_LITERAL_MEMBERS || kind === LK_TUPLE_ELEMENT_TYPES) closer = "]";
    else if (kind === LK_TYPE_PARAMETERS || kind === LK_TYPE_ARGUMENTS) closer = ">";
    void closer;
    expected(T_COMMA);
  }
  // `{ a; b }`
  const lx$ = lx;
  if ((kind === LK_OBJECT_LITERAL_MEMBERS || kind === LK_IMPORT_ATTRIBUTES) && lx$.token === T_SEMICOLON && !lx$.newlineBefore) next();
  // "Consume a token to advance the parser in some way and avoid an infinite loop"
  if (lx$.fullStart === element) next();
  return true;
}

/**
 * `abortParsingListOrMoveToNextToken`, at a token that neither starts an element of `kind` nor ends the list. Whether the list
 * ends, because a list around it has a use for the token.
 */
function abortListOrSkip(kind: number): boolean {
  parsingContextError(kind);
  if (isInSomeParsingContext()) return true;
  next();
  hir.pushAfterSkipped(lx.start | 0);
  return false;
}

/** `isInSomeParsingContext` */
function isInSomeParsingContext(): boolean {
  const p$ = p;
  let open = p$.lists | 0;
  // `reparseTopLevelAwait` parses a statement of the file that has an `await` again, and no list of statements is open then.
  if (lx.token === T_AWAIT && hasContext(CTX_TOP_LEVEL) && hasContext(CTX_AWAIT)) {
    p$.hasTopLevelAwait = true;
    p$.hasPlainTopLevelAwait = true;
    p$.hasAwaitInStatement = true;
    p$.hasAwaitIdentifier = true;
    p$.wasAwaitRefused = true;
  }
  if (p$.hasAwaitInStatement) open = open & ~(1 << LK_SOURCE_ELEMENTS);
  let isInSome = false;
  for (let kind = 0; kind < ALL_LISTS_COUNT; kind++) {
    if ((open & (1 << kind)) !== 0 && (isListElement(kind, true) || isListTerminator(kind))) {
      isInSome = true;
      break;
    }
  }
  // The first parse has ended its statement at this token.
  if (!isInSome && open !== (p$.lists | 0) && !p$.wasAwaitRefused && isListElement(LK_SOURCE_ELEMENTS, true)) p$.reparsesRestOfFile = true;
  return isInSome;
}

/** `parsingContextErrors` */
function parsingContextError(kind: number): void {
  let code = 0;
  switch (kind) {
    case LK_SOURCE_ELEMENTS:
      if (lx.token === T_DEFAULT) return errorAtTokenArgs(1005, ["export"]);
      code = 1128;
      break;
    case LK_BLOCK_STATEMENTS:
      code = 1128;
      break;
    case LK_SWITCH_CLAUSES:
      code = 1130;
      break;
    case LK_SWITCH_CLAUSE_STATEMENTS:
      code = 1129;
      break;
    case LK_TYPE_MEMBERS:
      code = 1131;
      break;
    case LK_CLASS_MEMBERS:
      code = 1068;
      break;
    case LK_ENUM_MEMBERS:
      code = 1132;
      break;
    case LK_HERITAGE_CLAUSE_ELEMENT:
      code = 1109;
      break;
    case LK_VARIABLE_DECLARATIONS:
      // `TokenToString`
      if (isAtKeyword()) return errorAtTokenArgs(1389, [tokenSrcText()]);
      code = 1134;
      break;
    case LK_OBJECT_BINDING_ELEMENTS:
      code = 1180;
      break;
    case LK_ARRAY_BINDING_ELEMENTS:
      code = 1181;
      break;
    case LK_ARGUMENT_EXPRESSIONS:
      code = 1135;
      break;
    case LK_OBJECT_LITERAL_MEMBERS:
      code = 1136;
      break;
    case LK_ARRAY_LITERAL_MEMBERS:
      code = 1137;
      break;
    case LK_PARAMETERS:
      if (isAtKeyword()) return errorAtTokenArgs(1390, [tokenSrcText()]);
      code = 1138;
      break;
    case LK_TYPE_PARAMETERS:
      code = 1139;
      break;
    case LK_TYPE_ARGUMENTS:
      code = 1140;
      break;
    case LK_TUPLE_ELEMENT_TYPES:
      code = 1110;
      break;
    case LK_HERITAGE_CLAUSES:
      code = 1179;
      break;
    case LK_IMPORT_OR_EXPORT_SPECIFIERS:
      if (lx.token === T_FROM) return errorAtTokenArgs(1005, ["}"]);
      code = 1003;
      break;
    case LK_IMPORT_ATTRIBUTES:
      code = 1478;
      break;
    default:
      code = 1003;
      break;
  }
  errorAtToken(code);
}

/** `isStartOfStatement` */
export function isStartOfStatement(): boolean {
  const lx$ = lx;
  switch (lx$.token) {
    case T_AT:
    case T_SEMICOLON:
    case T_OPEN_BRACE:
    case T_VAR:
    case T_LET:
    case T_USING:
    case T_FUNCTION:
    case T_CLASS:
    case T_ENUM:
    case T_IF:
    case T_DO:
    case T_WHILE:
    case T_FOR:
    case T_CONTINUE:
    case T_BREAK:
    case T_RETURN:
    case T_WITH:
    case T_SWITCH:
    case T_THROW:
    case T_TRY:
    case T_DEBUGGER:
    case T_CATCH:
    case T_FINALLY:
      return true;
    case T_IMPORT: {
      if (isStartOfDeclaration()) return true;
      const t = peek();
      return t === T_OPEN_PAREN || t === T_LESS_THAN || t === T_DOT;
    }
    case T_CONST:
    case T_EXPORT:
      return isStartOfDeclaration();
    case T_ASYNC:
    case T_DECLARE:
    case T_INTERFACE:
    case T_MODULE:
    case T_NAMESPACE:
    case T_TYPE:
    case T_GLOBAL:
    case T_DEFER:
      return true;
    case T_ACCESSOR:
    case T_PUBLIC:
    case T_PRIVATE:
    case T_PROTECTED:
    case T_STATIC:
    case T_READONLY: {
      if (isStartOfDeclaration()) return true;
      const m = lx$.mark();
      const had = lx$.refusal | 0;
      next();
      const r = isIdentifierOrKeyword(lx$.token) && !lx$.newlineBefore;
      lookAheadEnd(m, had);
      return !r;
    }
    default:
      return isStartOfExpression();
  }
}

/** `scanClassMemberStart`, in a `lookAhead`. */
function isClassMemberStart(): boolean {
  const lx$ = lx;
  if (lx$.token === T_AT) return true;
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  const r = classMemberStartAhead();
  lookAheadEnd(m, had);
  return r;
}

function classMemberStartAhead(): boolean {
  let name = -1;
  const lx$ = lx;
  while (isModifier(lx$.token)) {
    name = lx$.token | 0;
    // `IsClassMemberModifier`
    const t = lx$.token;
    if (t === T_PUBLIC || t === T_PRIVATE || t === T_PROTECTED || t === T_READONLY || t === T_OVERRIDE || t === T_STATIC || t === T_ACCESSOR) return true;
    next();
  }
  if (lx$.token === T_ASTERISK) return true;
  if (isLiteralPropertyName()) {
    name = lx$.token | 0;
    next();
  }
  if (lx$.token === T_OPEN_BRACKET) return true;
  if (name < 0) return false;
  if (name <= T_PRIVATE_IDENTIFIER || name === T_GET || name === T_SET) return true;
  const t = lx$.token;
  return t === T_OPEN_PAREN || t === T_LESS_THAN || t === T_EXCLAMATION || t === T_COLON || t === T_EQUALS || t === T_QUESTION || canParseSemicolon();
}

/** `scanTypeMemberStart`, in a `lookAhead`. */
function isTypeMemberStart(): boolean {
  const lx$ = lx;
  const t0 = lx$.token;
  if (t0 === T_OPEN_PAREN || t0 === T_LESS_THAN || t0 === T_GET || t0 === T_SET) return true;
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  const r = typeMemberStartAhead();
  lookAheadEnd(m, had);
  return r;
}

function typeMemberStartAhead(): boolean {
  let hasName = false;
  const lx$ = lx;
  while (isModifier(lx$.token)) {
    hasName = true;
    next();
  }
  if (lx$.token === T_OPEN_BRACKET) return true;
  if (isLiteralPropertyName()) {
    hasName = true;
    next();
  }
  if (!hasName) return false;
  const t = lx$.token;
  return t === T_OPEN_PAREN || t === T_LESS_THAN || t === T_QUESTION || t === T_COLON || t === T_COMMA || canParseSemicolon();
}

/** `isListElement` */
function isListElement(kind: number, isRecovering: boolean): boolean {
  const t = lx.token;
  switch (kind) {
    case LK_SOURCE_ELEMENTS:
    case LK_BLOCK_STATEMENTS:
    case LK_SWITCH_CLAUSE_STATEMENTS:
      return !(t === T_SEMICOLON && isRecovering) && isStartOfStatement();
    case LK_SWITCH_CLAUSES:
      return t === T_CASE || t === T_DEFAULT;
    case LK_TYPE_MEMBERS:
      return isTypeMemberStart();
    case LK_CLASS_MEMBERS:
      return isClassMemberStart() || (t === T_SEMICOLON && !isRecovering);
    case LK_ENUM_MEMBERS:
      return t === T_OPEN_BRACKET || isLiteralPropertyName();
    case LK_OBJECT_LITERAL_MEMBERS:
      return t === T_OPEN_BRACKET || t === T_ASTERISK || t === T_DOT_DOT_DOT || t === T_DOT || isLiteralPropertyName();
    case LK_OBJECT_BINDING_ELEMENTS:
      return t === T_OPEN_BRACKET || t === T_DOT_DOT_DOT || isLiteralPropertyName();
    case LK_IMPORT_ATTRIBUTES:
      return isIdentifierOrKeyword(t) || t === T_STRING;
    case LK_JSX_ATTRIBUTES:
      return isIdentifierOrKeyword(t) || t === T_OPEN_BRACE;
    case LK_JSX_CHILDREN:
      return true;
    case LK_HERITAGE_CLAUSE_ELEMENT:
      if (isRecovering && t !== T_OPEN_BRACE) return isIdentifier() && isHeritageElement();
      return isHeritageElement();
    case LK_VARIABLE_DECLARATIONS:
      return isBindingIdentifierOrPattern();
    case LK_ARRAY_BINDING_ELEMENTS:
      return t === T_COMMA || t === T_DOT_DOT_DOT || isBindingIdentifierOrPattern();
    case LK_TYPE_PARAMETERS:
      return t === T_IN || t === T_CONST || isIdentifier();
    case LK_ARRAY_LITERAL_MEMBERS:
      return t === T_COMMA || t === T_DOT || t === T_DOT_DOT_DOT || isStartOfExpression();
    case LK_ARGUMENT_EXPRESSIONS:
      return t === T_DOT_DOT_DOT || isStartOfExpression();
    case LK_PARAMETERS:
      return isStartOfParameter();
    case LK_TYPE_ARGUMENTS:
    case LK_TUPLE_ELEMENT_TYPES:
      return t === T_COMMA || isStartOfType(false);
    case LK_HERITAGE_CLAUSES:
      return t === T_EXTENDS || t === T_IMPLEMENTS;
    case LK_IMPORT_OR_EXPORT_SPECIFIERS:
      if (t === T_FROM && peek() === T_STRING) return false;
      return t === T_STRING || isIdentifierOrKeyword(t);
    default:
      return false;
  }
}

/** `isListTerminator` */
function isListTerminator(kind: number): boolean {
  const t = lx.token;
  if (t === T_EOF) return true;
  switch (kind) {
    case LK_SOURCE_ELEMENTS:
      return false;
    case LK_BLOCK_STATEMENTS:
    case LK_SWITCH_CLAUSES:
    case LK_TYPE_MEMBERS:
    case LK_CLASS_MEMBERS:
    case LK_ENUM_MEMBERS:
    case LK_OBJECT_LITERAL_MEMBERS:
    case LK_OBJECT_BINDING_ELEMENTS:
    case LK_IMPORT_OR_EXPORT_SPECIFIERS:
    case LK_IMPORT_ATTRIBUTES:
      return t === T_CLOSE_BRACE;
    case LK_SWITCH_CLAUSE_STATEMENTS:
      return t === T_CLOSE_BRACE || t === T_CASE || t === T_DEFAULT;
    case LK_HERITAGE_CLAUSE_ELEMENT:
      return t === T_OPEN_BRACE || t === T_EXTENDS || t === T_IMPLEMENTS;
    // "For better error recovery, if we see an '=>' then we just stop immediately."
    case LK_VARIABLE_DECLARATIONS:
      return canParseSemicolon() || t === T_IN || t === T_OF || t === T_EQUALS_GREATER_THAN;
    case LK_TYPE_PARAMETERS:
      return t === T_GREATER_THAN || t === T_OPEN_PAREN || t === T_OPEN_BRACE || t === T_EXTENDS || t === T_IMPLEMENTS;
    case LK_ARGUMENT_EXPRESSIONS:
      return t === T_CLOSE_PAREN || t === T_SEMICOLON;
    case LK_ARRAY_LITERAL_MEMBERS:
    case LK_TUPLE_ELEMENT_TYPES:
    case LK_ARRAY_BINDING_ELEMENTS:
      return t === T_CLOSE_BRACKET;
    case LK_PARAMETERS:
      return t === T_CLOSE_PAREN || t === T_CLOSE_BRACKET;
    case LK_TYPE_ARGUMENTS:
      return t !== T_COMMA;
    case LK_HERITAGE_CLAUSES:
      return t === T_OPEN_BRACE || t === T_CLOSE_BRACE;
    case LK_JSX_ATTRIBUTES:
      return t === T_GREATER_THAN || t === T_SLASH;
    case LK_JSX_CHILDREN:
      return t === T_LESS_THAN && peek() === T_SLASH;
    default:
      return false;
  }
}

/**
 * `parseToplevelStatement`. `parsePropertyName` restores `statementHasAwaitIdentifier`, so that no statement is parsed again for an
 * `await` in a name: there it is a name. For another `await` `reparseTopLevelAwait` parses all of the statement again, in the await
 * context. (oxc's first reading is not ported.)
 */
export function topLevelStatement(): number {
  const p$ = p;
  p$.hasAwaitInName = false;
  p$.hasAwaitIdentifier = false;
  const before = checkpoint();
  const stmt = statement();
  if (!(p$.hasAwaitInName && p$.hasAwaitIdentifier) || hasFailed()) return stmt;
  rollback(before);
  p$.namesAreInAwaitContext = true;
  const again = statement();
  p$.namesAreInAwaitContext = false;
  return again;
}

/**
 * The decorators among the modifiers from `base` on are those of a `MissingDeclaration` or of a `this` parameter, which
 * `checkDecorators` does not visit: see `File::stray_decorators`. Pops the modifiers. `end`: where what follows the decorators starts.
 * Without recovery: `fail`.
 */
export function noteStrayDecorators(base: number, end: number): void {
  if (!p.recovers) {
    fail();
    return;
  }
  const s$ = s;
  const hir$ = hir;
  for (let index = base; index < s$.modifiers.len; index++) {
    const m = s$.modifiers.data[index] | 0;
    if ((hir$.modifierKind[m] | 0) !== MODK_DECORATOR) continue;
    const decorator = hir$.modifierValue[m] | 0;
    const start = firstOperandPos(decorator);
    hir$.pushStrayDecorators(start, end);
    s$.strayDecorators.push(start);
    s$.strayDecorators.push(decorator);
  }
  s$.modifiers.len = base;
}

/**
 * After a statement of a list, before it is pushed on the stack of ids: pushes the decorators that `noteStrayDecorators` has saved
 * in it, which are statements before it. `base`: how many were saved when the list began.
 */
export function takeStrayDecorators(base: number): void {
  if (s.strayDecorators.len > base) takeStrayDecoratorsSlowly(base);
}

function takeStrayDecoratorsSlowly(base: number): void {
  const s$ = s;
  for (let index = base; index < s$.strayDecorators.len; index += 2) {
    const start = s$.strayDecorators.data[index] | 0;
    const decorator = s$.strayDecorators.data[index + 1] | 0;
    s$.ids.push(pushStmtExpr(start, decorator));
  }
  s$.strayDecorators.len = base;
}
