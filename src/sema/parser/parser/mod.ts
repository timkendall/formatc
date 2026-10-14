// Port of vendor/bun/src/sema/parser/parser/mod.rs: the state of the parser, and what every part of the grammar uses: tokens,
// lookahead, speculation, names and lists. THIS FILE IS A LEAF (it imports no other parser file): `run.ts` has the entry point.
//
// ## Conventions of the TS parser (read this before porting a file of `parser/`)
//
//  - Free functions over one module-level state: `p` (the `Parser` fields: context, flags, ...), `lx` (the thread's lexer),
//    `s` (the `Stacks`). `self.foo()` of Rust is `foo()`; `self.lx.token` is `lx.token`; `self.context` is `p.context`.
//    Rust names -> camelCase exactly (`assignment_expression_or_higher` -> `assignmentExpressionOrHigher`). A Rust method of
//    `impl Parser` in file X.rs is exported from X.ts.
//  - Ids (`ExprId`, ...) are Int32 row ids of the `hir` tables, `NONE` = -1. `Option<Id>` is -1. Atoms: `ATOM_NONE` = -1.
//    Enums are integer constants (`T_*` tokens, `FLAG_*`, `CHAIN_*`, `FN_*` ...). `bool` is boolean.
//  - ONE DIFFERENCE IN THE DATA: Rust pushes rows (`Param`, `Prop`, `Member`, `Modifier`, ...) on a *stack* so that the rows of
//    a list are contiguous in the file, and then moves them (`take_span!`). The HIR of TS needs no contiguity (lists are ids in
//    `hir.ids`), so rows are pushed into `hir` directly (`hir.pushParam(...)`, `pushProp`, ...) when they are complete, and
//    the STACKS HOLD ROW IDS (`s.params`, `s.props`, `s.members`, `s.modifiers`, ...: I32Vec of ids of rows of `hir`).
//    `takeIds(base)` / `takeList(stack, base)` turn the ids of a stack from `base` on into a list of `hir.ids`.
//  - Several results: a function that returns a tuple returns the first value and writes the others to `p.outPos`, `p.outLen`,
//    `p.outA`, `p.outB` (read them IMMEDIATELY after the call: any call may overwrite them). A list result `(start, len)` is
//    returned as `start` with `p.outLen` = len. A `Start { pos, full }` parameter is passed as two numbers `(startPos, startFull)`.
//  - Closures (`look_ahead(|p| ..)`, `try_parse(|p| ..)`) are written as begin/end pairs; see `lookAheadParsingBegin`,
//    `tryParseBegin`. The simple `look_ahead` is written inline: `const m = lx.mark(); const had = lx.refusal | 0; ...;
//    lx.refusal = had; lx.reset(m);` (use `lookAheadEnd(m, had)`).
//  - Recursion guard: Rust asks the stack pointer (`is_too_deep()`); here a door brackets its recursion:
//    `if (isTooDeep()) return NONE; ... leaveDepth();` is NOT used. Use `if (!enterDepth()) return NONE; ...; leaveDepth();` on
//    every path out of the door (`enterDepth` refuses the file with R_TOO_DEEP when the budget is gone).
//  - Dialects: ONLY the formatter's are ported: Babel/TypeScript-estree (`Dialect::babel(script)`), non-recovering. The code
//    for `oxc` (`is_for_oxc()`, `reports_like_oxc()`), Flow (`is_flow()`), JSDoc (`reads_jsdoc()`) and recovery (`recovers()`)
//    is NOT ported: where Rust has a branch for it the TS has `// TODO(recover)`, `// TODO(oxc)`, `// TODO(flow)`,
//    `// TODO(jsdoc)` (the third parser agent adds recovery by making `p.recovers` live and porting recover.rs).
//    `Declared` (oxc_names scopes, `rare::MAY_REDECLARE`) is off: `declare`, `openScope`, `closeScope`, `openFunction`,
//    `noteParameters` are no-ops and are not called.
import {
  CHAIN_NO,
  DK_GRAMMAR,
  DK_PARSE,
  EXPR_DOT,
  EXPR_INDEX,
  EXPR_MISSING,
  EXPR_IDENT,
  EXPR_TAGGED_TEMPLATE,
  NONE,
  hir,
  pushExprMissing,
} from "../../hir.ts";
import { A_empty, ATOM_NONE, isKeywordIdentifier } from "../../atom.ts";
import { I32Vec } from "../../vec.ts";
import { pushDiagnosticArgs } from "../../hir_util.ts";
import { Names } from "../names.ts";
import { Lexer } from "../lexer.ts";
import { keywordSuggestion } from "../suggest.ts";
import { DIALECT_BABEL, DIALECT_ECMASCRIPT, DIALECT_FLOW, DIALECT_TYPESCRIPT_5, R_REPORTED, R_SYNTAX, R_TOO_DEEP, R_UNSUPPORTED } from "../lib.ts";
import {
  T_AT,
  T_AWAIT,
  T_CLOSE_BRACE,
  T_EOF,
  T_EQUALS,
  T_EXTENDS,
  T_IDENTIFIER,
  T_IMPLEMENTS,
  T_INVALID,
  T_NO_SUBSTITUTION_TEMPLATE,
  T_NUMBER,
  T_OPEN_BRACE,
  T_OPEN_PAREN,
  T_PRIVATE_IDENTIFIER,
  T_SEMICOLON,
  T_STRING,
  T_TEMPLATE_HEAD,
  T_WITH,
  T_YIELD,
  isIdentifierOrKeyword,
  isReservedWord,
  tokenText,
} from "../token.ts";

// ───────────────────────────── ctx bits (`ParserContext`) ─────────────────────────────

/** `NodeFlagsYieldContext` */
export const CTX_YIELD: number = 1 << 0;
/** `NodeFlagsAwaitContext` */
export const CTX_AWAIT: number = 1 << 1;
/** `NodeFlagsDisallowInContext` */
export const CTX_DISALLOW_IN: number = 1 << 2;
/** `NodeFlagsDecoratorContext` */
export const CTX_DECORATOR: number = 1 << 3;
/** `NodeFlagsDisallowConditionalTypesContext` */
export const CTX_DISALLOW_CONDITIONAL_TYPES: number = 1 << 4;
/** `NodeFlagsAmbient` */
export const CTX_AMBIENT: number = 1 << 5;
/** No function encloses the node. */
export const CTX_TOP_LEVEL: number = 1 << 6;
/** The node is in a type, in an interface or in a type alias. */
export const CTX_TYPE: number = 1 << 7;
/** In Flow: `A => B` is no type. */
export const CTX_NO_ANONYMOUS_FUNCTION_TYPE: number = 1 << 8;
/** In Flow: `A { }` is no record expression. */
export const CTX_NO_RECORD: number = 1 << 9;
/** The node is in the `extends` clause of a conditional type. */
export const CTX_CONDITIONAL_EXTENDS: number = 1 << 10;
/** The node is in the signature of a method, an accessor or the constructor of a class. */
export const CTX_CLASS_MEMBER: number = 1 << 11;
/** The node is in the body of a loop of the function around it. */
export const CTX_IN_LOOP: number = 1 << 12;
/** The node is in a `switch` of the function around it. */
export const CTX_IN_SWITCH: number = 1 << 13;
/** The node is in the body of a namespace. */
export const CTX_IN_NAMESPACE: number = 1 << 14;

// ───────────────────────────── ListKind (recover.rs) ─────────────────────────────

export const LK_SOURCE_ELEMENTS: number = 0;
export const LK_BLOCK_STATEMENTS: number = 1;
export const LK_SWITCH_CLAUSES: number = 2;
export const LK_SWITCH_CLAUSE_STATEMENTS: number = 3;
export const LK_TYPE_MEMBERS: number = 4;
export const LK_CLASS_MEMBERS: number = 5;
export const LK_ENUM_MEMBERS: number = 6;
export const LK_HERITAGE_CLAUSE_ELEMENT: number = 7;
export const LK_VARIABLE_DECLARATIONS: number = 8;
export const LK_OBJECT_BINDING_ELEMENTS: number = 9;
export const LK_ARRAY_BINDING_ELEMENTS: number = 10;
export const LK_ARGUMENT_EXPRESSIONS: number = 11;
export const LK_OBJECT_LITERAL_MEMBERS: number = 12;
export const LK_ARRAY_LITERAL_MEMBERS: number = 13;
export const LK_PARAMETERS: number = 14;
export const LK_TYPE_PARAMETERS: number = 15;
export const LK_TYPE_ARGUMENTS: number = 16;
export const LK_TUPLE_ELEMENT_TYPES: number = 17;
export const LK_HERITAGE_CLAUSES: number = 18;
export const LK_IMPORT_OR_EXPORT_SPECIFIERS: number = 19;
export const LK_IMPORT_ATTRIBUTES: number = 20;
export const LK_JSX_ATTRIBUTES: number = 21;
export const LK_JSX_CHILDREN: number = 22;

// ───────────────────────────── ModifiersOf (stmt.rs) ─────────────────────────────

/** A statement, a class expression, a parameter or a member of an object literal. Decorators are among them. */
export const MODS_DECLARATION: number = 0;
/** `const` is one. */
export const MODS_TYPE_PARAMETER: number = 1;
export const MODS_TYPE_MEMBER: number = 2;
/** Decorators are among them, `const` is one, and `static {` is none. */
export const MODS_CLASS_MEMBER: number = 3;

// ───────────────────────────── Stacks ─────────────────────────────

/**
 * The lists that are being parsed, innermost last (Rust `Stacks`). Every stack holds the ROW IDS of rows that are already in
 * `hir` (see the header), except `decorators` and `strayDecorators` (rows of 2: index in the list / start, ExprId).
 */
export class Stacks {
  ids: I32Vec = new I32Vec(512);
  varDecls: I32Vec = new I32Vec(64);
  params: I32Vec = new I32Vec(64);
  typeParams: I32Vec = new I32Vec(16);
  props: I32Vec = new I32Vec(64);
  members: I32Vec = new I32Vec(64);
  cases: I32Vec = new I32Vec(16);
  patProps: I32Vec = new I32Vec(16);
  patElems: I32Vec = new I32Vec(16);
  enumMembers: I32Vec = new I32Vec(16);
  importSpecs: I32Vec = new I32Vec(16);
  exportSpecs: I32Vec = new I32Vec(16);
  tupleElems: I32Vec = new I32Vec(16);
  /** ModifierIds. */
  modifiers: I32Vec = new I32Vec(64);
  /** NameIds. */
  names: I32Vec = new I32Vec(16);
  /** Rows of 2: (index in the params or members list, ExprId of the decorator). */
  decorators: I32Vec = new I32Vec(16);
  /** See `noteStrayDecorators`: rows of 2: (start, ExprId). */
  strayDecorators: I32Vec = new I32Vec(16);
  /** class.ts: the elements of `extends` clauses that are not the base class, and of the `implements` clauses after the first. */
  otherExtends: I32Vec = new I32Vec(16);
  otherImplements: I32Vec = new I32Vec(16);
  reset(): void {
    this.otherExtends.len = 0;
    this.otherImplements.len = 0;
    this.ids.len = 0;
    this.varDecls.len = 0;
    this.params.len = 0;
    this.typeParams.len = 0;
    this.props.len = 0;
    this.members.len = 0;
    this.cases.len = 0;
    this.patProps.len = 0;
    this.patElems.len = 0;
    this.enumMembers.len = 0;
    this.importSpecs.len = 0;
    this.exportSpecs.len = 0;
    this.tupleElems.len = 0;
    this.modifiers.len = 0;
    this.names.len = 0;
    this.decorators.len = 0;
    this.strayDecorators.len = 0;
  }
}

// ───────────────────────────── the Parser fields ─────────────────────────────

/** The fields of Rust's `Parser` that the non-recovering Babel/TypeScript parse uses. */
export class ParserState {
  // ── options (`Options` + dialect, set by `begin`) ──
  isDeclarationFile: boolean = false;
  isJsx: boolean = false;
  /** `.js`... or JSON (Rust `options.is_javascript`). */
  isJavascript: boolean = false;
  isJson: boolean = false;
  awaitIsAName: boolean = false;
  isModuleOrScript: boolean = false;
  /** `Options::recovers`: goes on after a syntax error as TypeScript's parser does, and reports it. */
  recovers: boolean = false;
  /** `Dialect::typescript_5` */
  isTypescript5: boolean = false;
  /** `Dialect::babel` */
  isBabel: boolean = false;
  /** `Dialect::ecmascript`, in a JavaScript file. */
  isEcmascript: boolean = false;
  /** A `<` after an expression can start type arguments: not in JavaScript, but in Flow. */
  hasTypeArgumentsInExpressions: boolean = false;
  /** `Parser::flow`: Flow's syntax (`Dialect::flow`, in a JavaScript file). */
  isFlow: boolean = false;
  /** Where the statement that is being parsed starts (flow: a `match` at that place is a statement). */
  flowStatementStart: number = -1;
  /** `TypeExcludesFlags` */
  clearedInTypes: number = CTX_YIELD | CTX_AWAIT;

  // ── the state ──
  /** `ctx` */
  context: number = CTX_TOP_LEVEL;
  /** How many classes enclose the node. */
  classesAround: number = 0;
  /** `parsingContexts`: a bit for each ListKind of which a list is open. */
  lists: number = 0;
  /** The start of the token at which the last error was reported, and how many have been there (recovery). */
  errorsAtPos: number = -1;
  errorsAtCount: number = 0;
  /** How many `await` and `yield` expressions have been made. */
  suspensions: number = 0;
  /** How many parameters have had a modifier, a `?` or `...`. It only grows. */
  oddParameters: number = 0;
  hasTopLevelAwait: boolean = false;
  /** One of them can be nothing else: `await a`, `for await`, `await using`. */
  hasPlainTopLevelAwait: boolean = false;
  hasAwaitInStatement: boolean = false;
  hasAwaitInName: boolean = false;
  hasAwaitIdentifier: boolean = false;
  namesAreInAwaitContext: boolean = false;
  wasAwaitRefused: boolean = false;
  reparsesRestOfFile: boolean = false;
  reparsedAt: number = -1;
  /** Where the `<` of a JSX child is for which the parser has another token. */
  jsxChildAfterOtherToken: number = -1;
  /** The `?` of the last parameter that has one. */
  questionOfParameter: number = 0;
  /** See `privateNameBeforeIn`: where the last one is. */
  privateNameBeforeIn: number = -1;
  /** How many `T?` have been parsed that are not known to be an element of a tuple. */
  unclaimedNullableTypes: number = 0;
  /** The `T` of the last one, and its end. */
  lastNullableType: number = NONE;
  lastNullableTypeEnd: number = 0;
  /** How many speculative parses are going on. */
  speculations: number = 0;
  /** `report` was called in one of them. */
  hasReported: boolean = false;
  /** The token and the position at which `fail` was called last. */
  failedTok: number = T_EOF;
  failedPos: number = 0;
  /** The last `tryParse` was abandoned because of that call (`was_abandoned_at`). */
  wasAbandoned: boolean = false;
  wasAbandonedTok: number = T_EOF;
  wasAbandonedPos: number = 0;
  /** `DeclarationScan` (stmt.rs): a range of tokens in which no declaration starts; the context and the answer. */
  declarationScanFrom: number = 1;
  declarationScanTo: number = 0;
  declarationScanContext: number = 0;
  declarationScanAnswer: boolean = false;
  /** Positions at which a speculative parse has found that no arrow function starts, sorted (`not_arrows`). */
  notArrows: I32Vec = new I32Vec(16);
  /** `function_type_starts`: rows of 3 (position, context, answer 0/1), in order. */
  functionTypeStarts: I32Vec = new I32Vec(16);
  /** `not_type_arguments`: rows of 2 (position of a `<`, context), sorted. */
  notTypeArguments: I32Vec = new I32Vec(16);
  /** The private names that the classes around the token have declared so far (atoms). */
  declaredPrivateNames: I32Vec = new I32Vec(16);
  /** class.ts: the heritage clauses of the class that was parsed last (`Heritage`). */
  hExtends: number = NONE;
  hExtendsArgsStart: number = 0;
  hExtendsArgsLen: number = 0;
  hOtherExtendsStart: number = 0;
  hOtherExtendsLen: number = 0;
  hImplementsStart: number = 0;
  hImplementsLen: number = 0;
  hOtherImplementsStart: number = 0;
  hOtherImplementsLen: number = 0;
  hHasError: boolean = false;
  /** Recursion budget (see `enterDepth`). */
  depth: number = 0;
  depthLimit: number = 3000;

  // ── results of functions that return several values ──
  outPos: number = 0;
  outLen: number = 0;
  outA: number = 0;
  outB: number = 0;
  /** `propertyName()`: the key (PK_*, atom or ExprId), the name kind (NK_*) and the position. */
  keyKind: number = 0;
  keyVal: number = NONE;
  nameKind: number = 0;
  namePos: number = 0;
}

export const names: Names = new Names();
export const lx: Lexer = new Lexer(names);
export const p: ParserState = new ParserState();
export const s: Stacks = new Stacks();

/**
 * Starts a parse (Rust `Parser::new` + the setup of `run`): resets the parser fields and the stacks and configures the lexer. Call
 * `beginFile(src, len)` (hir_util.ts) and `lx.begin(src, len)` first. `dialect`: DIALECT_* bits (lib.ts).
 */
export function beginParse(
  isDeclarationFile: boolean,
  isJsx: boolean,
  isJavascript: boolean,
  isJson: boolean,
  awaitIsAName: boolean,
  isModuleOrScript: boolean,
  dialect: number,
  recovers: boolean,
): void {
  lx.configure(dialect, isJsx, isJavascript, isJson, recovers);
  const st = p;
  st.isDeclarationFile = isDeclarationFile;
  st.isJsx = isJsx;
  st.isJavascript = isJavascript;
  st.isJson = isJson;
  st.awaitIsAName = awaitIsAName;
  st.isModuleOrScript = isModuleOrScript;
  st.recovers = recovers;
  st.isTypescript5 = (dialect & DIALECT_TYPESCRIPT_5) !== 0;
  st.isBabel = (dialect & DIALECT_BABEL) !== 0;
  const isScript = isJavascript && !isJson;
  st.isEcmascript = (dialect & DIALECT_ECMASCRIPT) !== 0 && isScript;
  st.isFlow = (dialect & DIALECT_FLOW) !== 0 && isScript;
  st.flowStatementStart = -1;
  st.hasTypeArgumentsInExpressions = st.isFlow || !isJavascript;
  st.clearedInTypes = CTX_YIELD | CTX_AWAIT;
  let context = CTX_TOP_LEVEL;
  if (isDeclarationFile) context = context | CTX_AMBIENT;
  if (!awaitIsAName && !isDeclarationFile) context = context | CTX_AWAIT;
  st.context = context;
  st.classesAround = 0;
  st.lists = 0;
  st.errorsAtPos = -1;
  st.errorsAtCount = 0;
  st.suspensions = 0;
  st.oddParameters = 0;
  st.hasTopLevelAwait = false;
  st.hasPlainTopLevelAwait = false;
  st.hasAwaitInStatement = false;
  st.hasAwaitInName = false;
  st.hasAwaitIdentifier = false;
  st.namesAreInAwaitContext = false;
  st.wasAwaitRefused = false;
  st.reparsesRestOfFile = false;
  st.reparsedAt = -1;
  st.jsxChildAfterOtherToken = -1;
  st.questionOfParameter = 0;
  st.privateNameBeforeIn = -1;
  st.unclaimedNullableTypes = 0;
  st.lastNullableType = NONE;
  st.lastNullableTypeEnd = 0;
  st.speculations = 0;
  st.hasReported = false;
  st.failedTok = T_EOF;
  st.failedPos = 0;
  st.wasAbandoned = false;
  st.wasAbandonedTok = T_EOF;
  st.wasAbandonedPos = 0;
  st.declarationScanFrom = 1;
  st.declarationScanTo = 0;
  st.declarationScanContext = 0;
  st.declarationScanAnswer = false;
  st.notArrows.len = 0;
  st.functionTypeStarts.len = 0;
  st.notTypeArguments.len = 0;
  st.declaredPrivateNames.len = 0;
  st.depth = 0;
  st.outPos = 0;
  st.outLen = 0;
  st.outA = 0;
  st.outB = 0;
  s.reset();
  cpTop = 0;
}

// ───────────────────────────── tokens ─────────────────────────────

export function token(): number {
  return lx.token;
}

export function next(): void {
  lx.next();
}

/** `nextTokenWithoutCheck`: goes on from a word that is taken as a name. */
export function nextAfterName(): void {
  const lx$ = lx;
  if (lx$.hasEscape && p.recovers) forgetEscapedKeyword();
  lx$.next();
}

/** The token, a word, is taken as a name. */
export function takeAsName(): void {
  if (lx.hasEscape && p.recovers) forgetEscapedKeyword();
}

/** The token, a word with an escape, is taken as a name: as a keyword it would be an error. */
export function forgetEscapedKeyword(): void {
  const lx$ = lx;
  const at = lx$.start | 0;
  if (!lx$.forgetEscapedKeyword()) removeDiagnostics(1260, at);
}

/** `diagnostics.retain(|it| it.code != code || it.start != start)` */
export function removeDiagnostics(code: number, start: number): void {
  const h = hir;
  let w = 0;
  const n = h.diagnosticsLen;
  for (let i = 0; i < n; i += 5) {
    if ((h.diagnostics[i + 3] | 0) === code && (h.diagnostics[i + 1] | 0) === start) continue;
    if (w !== i) for (let k = 0; k < 5; k++) h.diagnostics[w + k] = h.diagnostics[i + k] | 0;
    w = (w + 5) | 0;
  }
  h.diagnosticsLen = w;
}

/** The start of the token. */
export function pos(): number {
  return lx.start;
}

/** `nodePos()`: the end of the previous token, which is also `node.End()` of a node that ends with that token. */
export function fullStart(): number {
  return lx.fullStart;
}

/** The same, where it is read as the end of a node. */
export function prevEnd(): number {
  return lx.fullStart;
}

export function newlineBefore(): boolean {
  return lx.newlineBefore;
}

/** For tools (node only): `debug.on = true; debug.fire = () => { ... }` is called where the recovering parser gives up. Never set in the program. */
export class DebugHook {
  on: boolean = false;
  fire: () => void = noDebug;
}
function noDebug(): void {}
export const debug: DebugHook = new DebugHook();

/** A token that the grammar does not allow here. */
export function fail(): void {
  // Where going on is not written yet. A speculative parse would go on too.
  const p$ = p;
  const debug$ = debug;
  if (p$.recovers) {
    if (debug$.on) debug$.fire();
    return refuse(R_UNSUPPORTED);
  }
  const lx$ = lx;
  if (lx$.refusal === 0) {
    p$.failedTok = lx$.token;
    p$.failedPos = lx$.start;
  }
  lx$.refuse(R_SYNTAX);
}

/** Gives up on the file, in a speculative parse too. */
export function refuse(why: number): void {
  // It replaces the reason that only ends a speculation.
  const lx$ = lx;
  if (lx$.refusal === R_SYNTAX) lx$.refusal = 0;
  lx$.refuse(why);
}

/** TypeScript reports an error here and goes on. So does a speculative parse, whose errors do not count if it is abandoned. */
export function report(): void {
  const p$ = p;
  if (p$.speculations === 0) refuse(R_REPORTED);
  else p$.hasReported = true;
}

/**
 * The bit of the context in which `in` is no operator, if brackets, braces, and the parameters and the bodies of functions
 * leave that context. TypeScript's parser stays in it.
 */
export function disallowInIfBracketsEndIt(): number {
  return p.isEcmascript ? CTX_DISALLOW_IN : 0;
}

/** `TypeScript reports an error that is not about the syntax`: the tree is the same without it. `end`: 0 = the end of the token at `start`, -1 = `start` (NO_LENGTH). */
export function flag(kind: number, code: number, start: number, end: number): void {
  hir.pushDiagnostics(kind, start, end, code, -1);
}

/** `flag` with the arguments of the message. */
export function flagArgs(kind: number, code: number, start: number, end: number, args: string[]): void {
  pushDiagnosticArgs(kind, start, end, code, args);
}

/** `flag` with `DiagnosticKind::Grammar`. */
export function flagGrammar(code: number, start: number, end: number): void {
  hir.pushDiagnostics(DK_GRAMMAR, start, end, code, -1);
}

export function hasFailed(): boolean {
  return lx.refusal !== 0;
}

/** `parseOptional` */
export function eat(tok: number): boolean {
  const lx$ = lx;
  if (lx$.token === tok) {
    lx$.next();
    return true;
  }
  return false;
}

/** `parseExpected` */
export function expect(tok: number): boolean {
  const lx$ = lx;
  if (lx$.token === tok) {
    lx$.next();
    return true;
  }
  expected(tok);
  return false;
}

/** `parseExpectedMatchingBrackets`. `openAt`: where `open` is, or -1 if it is not there. */
export function expectMatching(open: number, close: number, openAt: number): void {
  const lx$ = lx;
  if (lx$.token === close) lx$.next();
  else unmatched(open, close, openAt);
}

/** `canParseSemicolon` */
export function canParseSemicolon(): boolean {
  const lx$ = lx;
  const t = lx$.token;
  return t === T_SEMICOLON || t === T_CLOSE_BRACE || t === T_EOF || lx$.newlineBefore;
}

/** `parseSemicolon` */
export function semicolon(): void {
  const lx$ = lx;
  const t = lx$.token;
  if (t === T_SEMICOLON) lx$.next();
  else if (!(t === T_CLOSE_BRACE || t === T_EOF || lx$.newlineBefore)) expected(T_SEMICOLON);
}

/** Whether a list that `close` ends goes on. */
export function isInList(close: number): boolean {
  const t = lx.token;
  return t !== close && t !== T_EOF;
}

// ───────────────────────────── recursion guard ─────────────────────────────

/**
 * Enters one door of the recursion: false (the file is refused with R_TOO_DEEP) when the budget is gone; then do NOT call
 * `leaveDepth`. Every successful `enterDepth` is paired with one `leaveDepth` on every path out.
 */
export function enterDepth(): boolean {
  const p$ = p;
  const d = p$.depth;
  if (d >= p$.depthLimit) {
    refuse(R_TOO_DEEP);
    return false;
  }
  p$.depth = (d + 1) | 0;
  return true;
}

export function leaveDepth(): void {
  const p$ = p;
  p$.depth = (p$.depth - 1) | 0;
}

// ───────────────────────────── context ─────────────────────────────

export function hasContext(flag_: number): boolean {
  return (p.context & flag_) !== 0;
}

/** Sets the bits `set` and clears the bits `clear`. Returns the context to restore (`p.context = saved`). */
export function enterContext(set: number, clear: number): number {
  const p$ = p;
  const saved = p$.context;
  p$.context = (saved & ~clear) | set;
  return saved;
}

/** `NodeFlagsAmbient`, as a flag of a declaration: FLAG_AMBIENT or 0. */
export function ambient(): number {
  return (p.context & CTX_AMBIENT) !== 0 ? 4 : 0; // FLAG_AMBIENT
}

// ───────────────────────────── lookahead ─────────────────────────────

/** The end of `lookAhead` for a test that only reads tokens: `const m = lx.mark(); const had = lx.refusal | 0; ... lookAheadEnd(m, had)`. */
export function lookAheadEnd(m: number, had: number): void {
  // What the scanner refuses ahead it refuses again when the parser gets there.
  const lx$ = lx;
  lx$.refusal = had;
  lx$.reset(m);
}

/** Whether `text` (ASCII) is written right after the token. */
export function isBefore(text: string): boolean {
  const n = text.length;
  const lx$ = lx;
  let at = lx$.end;
  if (at + n > lx$.len) return false;
  const src = lx$.src;
  for (let i = 0; i < n; i++) {
    if ((src[at] | 0) !== text.charCodeAt(i)) return false;
    at = (at + 1) | 0;
  }
  return true;
}

/** The kind of the token after this one. */
export function peek(): number {
  const lx$ = lx;
  const m = lx$.mark();
  const had = lx$.refusal | 0;
  lx$.next();
  const t = lx$.token | 0;
  lx$.refusal = had;
  lx$.reset(m);
  return t;
}

// ───────────────────────────── checkpoints (speculation) ─────────────────────────────
//
// A checkpoint remembers the lexer (a mark), the length of every table of `hir` and of every stack, and the parser fields that
// a speculation changes. Checkpoints are strictly LIFO, like the lexer marks. `checkpoint()` returns a row number; end it with
// `rollback(cp)` (go back) or `commit(cp)` (keep what was built).

const CP_LEX = 0;
const CP_CONTEXT = 1;
const CP_LISTS = 2;
const CP_CLASSES_AROUND = 3;
const CP_HAS_TOP_LEVEL_AWAIT = 4;
const CP_UNCLAIMED = 5;
const CP_HAD_REPORTED = 6;
const CP_DEPTH = 7;
const CP_PRIVATE_NAMES = 8;
// hir counts
const CP_IDS = 10;
const CP_NUMBERS = 11;
const CP_EXPRS = 12;
const CP_STMTS = 13;
const CP_TYPES = 14;
const CP_PATS = 15;
const CP_PAT_PROPS = 16;
const CP_PAT_ELEMS = 17;
const CP_FNS = 18;
const CP_PARAMS = 19;
const CP_TYPE_PARAMS = 20;
const CP_CLASSES = 21;
const CP_INTERFACES = 22;
const CP_ALIASES = 23;
const CP_ENUMS = 24;
const CP_ENUM_MEMBERS = 25;
const CP_MODULES = 26;
const CP_MEMBERS = 27;
const CP_PROPS = 28;
const CP_VAR_DECLS = 29;
const CP_CALLS = 30;
const CP_CASES = 31;
const CP_JSX = 32;
const CP_IMPORTS = 33;
const CP_IMPORT_SPECS = 34;
const CP_IMPORT_EQUALS = 35;
const CP_EXPORTS = 36;
const CP_EXPORT_SPECS = 37;
const CP_TUPLE_ELEMS = 38;
const CP_MAPPED = 39;
const CP_MODIFIERS = 40;
const CP_NAMES = 41;
const CP_PARENS = 42;
const CP_NON_NULL_ENDS = 43;
const CP_JSX_EXPRESSIONS = 44;
const CP_BODY_STARTS = 45;
const CP_DECORATORS = 46;
const CP_REFERENCES = 47;
const CP_WITH_BODIES = 48;
const CP_IMPORT_ATTRIBUTES = 49;
const CP_DEFERRED_IMPORT_CALLS = 50;
const CP_IMPORT_CALL_TYPE_ARGS = 51;
const CP_KEYWORD_IDENTIFIER_POSITIONS = 52;
const CP_DIAGNOSTICS = 53;
const CP_AFTER_SKIPPED = 54;
const CP_STRAY_DECORATORS_FILE = 55;
const CP_SPECIFIER_EXPRESSIONS = 56;
const CP_EXPORTS_FROM_EXPRESSIONS = 57;
// stacks
const CP_S_IDS = 60;
const CP_S_VAR_DECLS = 61;
const CP_S_PARAMS = 62;
const CP_S_TYPE_PARAMS = 63;
const CP_S_PROPS = 64;
const CP_S_MEMBERS = 65;
const CP_S_CASES = 66;
const CP_S_PAT_PROPS = 67;
const CP_S_PAT_ELEMS = 68;
const CP_S_ENUM_MEMBERS = 69;
const CP_S_IMPORT_SPECS = 70;
const CP_S_EXPORT_SPECS = 71;
const CP_S_TUPLE_ELEMS = 72;
const CP_S_MODIFIERS = 73;
const CP_S_NAMES = 74;
const CP_S_DECORATORS = 75;
const CP_S_STRAY_DECORATORS = 76;
const CP_STRIDE = 80;

let cps: Int32Array = new Int32Array(CP_STRIDE * 32);
let cpTop = 0;

/** Starts a speculation: returns the checkpoint (a row offset). */
export function checkpoint(): number {
  // What is taken after this would be forgotten by `rollback`, and it is not scanned again.
  const lx$ = lx;
  if (lx$.errors.len !== 0) takeErrorsOfScanner();
  const cp = cpTop;
  if (cp + CP_STRIDE > cps.length) {
    const n = new Int32Array(cps.length * 2);
    n.set(cps);
    cps = n;
  }
  const c = cps;
  c[cp + CP_LEX] = lx$.mark();
  const p$ = p;
  c[cp + CP_CONTEXT] = p$.context | 0;
  c[cp + CP_LISTS] = p$.lists | 0;
  c[cp + CP_CLASSES_AROUND] = p$.classesAround | 0;
  c[cp + CP_HAS_TOP_LEVEL_AWAIT] = p$.hasTopLevelAwait ? 1 : 0;
  c[cp + CP_UNCLAIMED] = p$.unclaimedNullableTypes | 0;
  c[cp + CP_HAD_REPORTED] = p$.hasReported ? 1 : 0;
  c[cp + CP_DEPTH] = p$.depth | 0;
  c[cp + CP_PRIVATE_NAMES] = p$.declaredPrivateNames.len | 0;
  const h = hir;
  c[cp + CP_IDS] = h.idsLen | 0;
  c[cp + CP_NUMBERS] = h.numbersLen | 0;
  c[cp + CP_EXPRS] = h.nExprs | 0;
  c[cp + CP_STMTS] = h.nStmts | 0;
  c[cp + CP_TYPES] = h.nTypes | 0;
  c[cp + CP_PATS] = h.nPats | 0;
  c[cp + CP_PAT_PROPS] = h.nPatProps | 0;
  c[cp + CP_PAT_ELEMS] = h.nPatElems | 0;
  c[cp + CP_FNS] = h.nFns | 0;
  c[cp + CP_PARAMS] = h.nParams | 0;
  c[cp + CP_TYPE_PARAMS] = h.nTypeParams | 0;
  c[cp + CP_CLASSES] = h.nClasses | 0;
  c[cp + CP_INTERFACES] = h.nInterfaces | 0;
  c[cp + CP_ALIASES] = h.nAliases | 0;
  c[cp + CP_ENUMS] = h.nEnums | 0;
  c[cp + CP_ENUM_MEMBERS] = h.nEnumMembers | 0;
  c[cp + CP_MODULES] = h.nModules | 0;
  c[cp + CP_MEMBERS] = h.nMembers | 0;
  c[cp + CP_PROPS] = h.nProps | 0;
  c[cp + CP_VAR_DECLS] = h.nVarDecls | 0;
  c[cp + CP_CALLS] = h.nCalls | 0;
  c[cp + CP_CASES] = h.nCases | 0;
  c[cp + CP_JSX] = h.nJsx | 0;
  c[cp + CP_IMPORTS] = h.nImports | 0;
  c[cp + CP_IMPORT_SPECS] = h.nImportSpecs | 0;
  c[cp + CP_IMPORT_EQUALS] = h.nImportEquals | 0;
  c[cp + CP_EXPORTS] = h.nExports | 0;
  c[cp + CP_EXPORT_SPECS] = h.nExportSpecs | 0;
  c[cp + CP_TUPLE_ELEMS] = h.nTupleElems | 0;
  c[cp + CP_MAPPED] = h.nMapped | 0;
  c[cp + CP_MODIFIERS] = h.nModifiers | 0;
  c[cp + CP_NAMES] = h.nNames | 0;
  c[cp + CP_PARENS] = h.nParens | 0;
  c[cp + CP_NON_NULL_ENDS] = h.nNonNullEnds | 0;
  c[cp + CP_JSX_EXPRESSIONS] = h.nJsxExpressions | 0;
  c[cp + CP_BODY_STARTS] = h.nBodyStarts | 0;
  c[cp + CP_DECORATORS] = h.nDecorators | 0;
  c[cp + CP_REFERENCES] = h.referencesLen | 0;
  c[cp + CP_WITH_BODIES] = h.withBodiesLen | 0;
  c[cp + CP_IMPORT_ATTRIBUTES] = h.importAttributesLen | 0;
  c[cp + CP_DEFERRED_IMPORT_CALLS] = h.deferredImportCallsLen | 0;
  c[cp + CP_IMPORT_CALL_TYPE_ARGS] = h.importCallTypeArgsLen | 0;
  c[cp + CP_KEYWORD_IDENTIFIER_POSITIONS] = h.keywordIdentifierPositionsLen | 0;
  c[cp + CP_DIAGNOSTICS] = h.diagnosticsLen | 0;
  c[cp + CP_AFTER_SKIPPED] = h.afterSkippedLen | 0;
  c[cp + CP_STRAY_DECORATORS_FILE] = h.strayDecoratorsLen | 0;
  c[cp + CP_SPECIFIER_EXPRESSIONS] = h.specifierExpressionsLen | 0;
  c[cp + CP_EXPORTS_FROM_EXPRESSIONS] = h.exportsFromExpressionsLen | 0;
  const st = s;
  c[cp + CP_S_IDS] = st.ids.len | 0;
  c[cp + CP_S_VAR_DECLS] = st.varDecls.len | 0;
  c[cp + CP_S_PARAMS] = st.params.len | 0;
  c[cp + CP_S_TYPE_PARAMS] = st.typeParams.len | 0;
  c[cp + CP_S_PROPS] = st.props.len | 0;
  c[cp + CP_S_MEMBERS] = st.members.len | 0;
  c[cp + CP_S_CASES] = st.cases.len | 0;
  c[cp + CP_S_PAT_PROPS] = st.patProps.len | 0;
  c[cp + CP_S_PAT_ELEMS] = st.patElems.len | 0;
  c[cp + CP_S_ENUM_MEMBERS] = st.enumMembers.len | 0;
  c[cp + CP_S_IMPORT_SPECS] = st.importSpecs.len | 0;
  c[cp + CP_S_EXPORT_SPECS] = st.exportSpecs.len | 0;
  c[cp + CP_S_TUPLE_ELEMS] = st.tupleElems.len | 0;
  c[cp + CP_S_MODIFIERS] = st.modifiers.len | 0;
  c[cp + CP_S_NAMES] = st.names.len | 0;
  c[cp + CP_S_DECORATORS] = st.decorators.len | 0;
  c[cp + CP_S_STRAY_DECORATORS] = st.strayDecorators.len | 0;
  cpTop = cp + CP_STRIDE;
  return cp;
}

/** Goes back to the checkpoint `cp` (and ends it): the tokens, the nodes, the stacks and the fields are as they were. */
export function rollback(cp: number): void {
  const c = cps;
  lx.reset(c[cp + CP_LEX] | 0);
  const h = hir;
  h.idsLen = c[cp + CP_IDS] | 0;
  h.numbersLen = c[cp + CP_NUMBERS] | 0;
  h.nExprs = c[cp + CP_EXPRS] | 0;
  h.nStmts = c[cp + CP_STMTS] | 0;
  h.nTypes = c[cp + CP_TYPES] | 0;
  h.nPats = c[cp + CP_PATS] | 0;
  h.nPatProps = c[cp + CP_PAT_PROPS] | 0;
  h.nPatElems = c[cp + CP_PAT_ELEMS] | 0;
  h.nFns = c[cp + CP_FNS] | 0;
  h.nParams = c[cp + CP_PARAMS] | 0;
  h.nTypeParams = c[cp + CP_TYPE_PARAMS] | 0;
  h.nClasses = c[cp + CP_CLASSES] | 0;
  h.nInterfaces = c[cp + CP_INTERFACES] | 0;
  h.nAliases = c[cp + CP_ALIASES] | 0;
  h.nEnums = c[cp + CP_ENUMS] | 0;
  h.nEnumMembers = c[cp + CP_ENUM_MEMBERS] | 0;
  h.nModules = c[cp + CP_MODULES] | 0;
  h.nMembers = c[cp + CP_MEMBERS] | 0;
  h.nProps = c[cp + CP_PROPS] | 0;
  h.nVarDecls = c[cp + CP_VAR_DECLS] | 0;
  h.nCalls = c[cp + CP_CALLS] | 0;
  h.nCases = c[cp + CP_CASES] | 0;
  h.nJsx = c[cp + CP_JSX] | 0;
  h.nImports = c[cp + CP_IMPORTS] | 0;
  h.nImportSpecs = c[cp + CP_IMPORT_SPECS] | 0;
  h.nImportEquals = c[cp + CP_IMPORT_EQUALS] | 0;
  h.nExports = c[cp + CP_EXPORTS] | 0;
  h.nExportSpecs = c[cp + CP_EXPORT_SPECS] | 0;
  h.nTupleElems = c[cp + CP_TUPLE_ELEMS] | 0;
  h.nMapped = c[cp + CP_MAPPED] | 0;
  h.nModifiers = c[cp + CP_MODIFIERS] | 0;
  h.nNames = c[cp + CP_NAMES] | 0;
  h.nParens = c[cp + CP_PARENS] | 0;
  h.nNonNullEnds = c[cp + CP_NON_NULL_ENDS] | 0;
  h.nJsxExpressions = c[cp + CP_JSX_EXPRESSIONS] | 0;
  h.nBodyStarts = c[cp + CP_BODY_STARTS] | 0;
  h.nDecorators = c[cp + CP_DECORATORS] | 0;
  h.referencesLen = c[cp + CP_REFERENCES] | 0;
  h.withBodiesLen = c[cp + CP_WITH_BODIES] | 0;
  h.importAttributesLen = c[cp + CP_IMPORT_ATTRIBUTES] | 0;
  h.deferredImportCallsLen = c[cp + CP_DEFERRED_IMPORT_CALLS] | 0;
  h.importCallTypeArgsLen = c[cp + CP_IMPORT_CALL_TYPE_ARGS] | 0;
  h.keywordIdentifierPositionsLen = c[cp + CP_KEYWORD_IDENTIFIER_POSITIONS] | 0;
  h.diagnosticsLen = c[cp + CP_DIAGNOSTICS] | 0;
  h.afterSkippedLen = c[cp + CP_AFTER_SKIPPED] | 0;
  h.strayDecoratorsLen = c[cp + CP_STRAY_DECORATORS_FILE] | 0;
  h.specifierExpressionsLen = c[cp + CP_SPECIFIER_EXPRESSIONS] | 0;
  h.exportsFromExpressionsLen = c[cp + CP_EXPORTS_FROM_EXPRESSIONS] | 0;
  const st = s;
  st.ids.len = c[cp + CP_S_IDS] | 0;
  st.varDecls.len = c[cp + CP_S_VAR_DECLS] | 0;
  st.params.len = c[cp + CP_S_PARAMS] | 0;
  st.typeParams.len = c[cp + CP_S_TYPE_PARAMS] | 0;
  st.props.len = c[cp + CP_S_PROPS] | 0;
  st.members.len = c[cp + CP_S_MEMBERS] | 0;
  st.cases.len = c[cp + CP_S_CASES] | 0;
  st.patProps.len = c[cp + CP_S_PAT_PROPS] | 0;
  st.patElems.len = c[cp + CP_S_PAT_ELEMS] | 0;
  st.enumMembers.len = c[cp + CP_S_ENUM_MEMBERS] | 0;
  st.importSpecs.len = c[cp + CP_S_IMPORT_SPECS] | 0;
  st.exportSpecs.len = c[cp + CP_S_EXPORT_SPECS] | 0;
  st.tupleElems.len = c[cp + CP_S_TUPLE_ELEMS] | 0;
  st.modifiers.len = c[cp + CP_S_MODIFIERS] | 0;
  st.names.len = c[cp + CP_S_NAMES] | 0;
  st.decorators.len = c[cp + CP_S_DECORATORS] | 0;
  st.strayDecorators.len = c[cp + CP_S_STRAY_DECORATORS] | 0;
  const p$ = p;
  p$.context = c[cp + CP_CONTEXT] | 0;
  p$.lists = c[cp + CP_LISTS] | 0;
  p$.classesAround = c[cp + CP_CLASSES_AROUND] | 0;
  p$.hasTopLevelAwait = (c[cp + CP_HAS_TOP_LEVEL_AWAIT] | 0) !== 0;
  p$.unclaimedNullableTypes = c[cp + CP_UNCLAIMED] | 0;
  p$.depth = c[cp + CP_DEPTH] | 0;
  p$.declaredPrivateNames.len = c[cp + CP_PRIVATE_NAMES] | 0;
  cpTop = cp;
}

/** Ends the checkpoint `cp` and keeps what was built since. */
export function commit(cp: number): void {
  lx.release(cps[cp + CP_LEX] | 0);
  cpTop = cp;
}

/** The checkpoint `cp` is dropped without a rollback and without releasing the lexer (the file is given up). */
function abandonCheckpoint(cp: number): void {
  lx.release(cps[cp + CP_LEX] | 0);
  cpTop = cp;
}

/**
 * `tryParse`: `const cp = tryParseBegin(); if (cp < 0) return <None>; ...parse...; if (!tryParseEnd(cp, ok)) return <None>;`.
 * `-1`: the file has failed, nothing is tried. `ok`: the parse returned `Some`. True: what `parse` built is kept (it met no
 * syntax error); false: everything is rolled back (or the file is given up).
 */
export function tryParseBegin(): number {
  if (lx.refusal !== 0) return -1;
  const cp = checkpoint();
  const p$ = p;
  p$.speculations = (p$.speculations + 1) | 0;
  return cp;
}

export function tryParseEnd(cp: number, ok: boolean): boolean {
  const p$ = p;
  p$.speculations = (p$.speculations - 1) | 0;
  const lx$ = lx;
  const r = lx$.refusal | 0;
  if (r === 0) {
    if (ok) {
      // What it reported counts.
      if (p$.hasReported && p$.speculations === 0) {
        p$.hasReported = false;
        refuse(R_REPORTED);
      }
      commit(cp);
      return true;
    }
    p$.wasAbandoned = false;
  } else if (r === R_SYNTAX) {
    lx$.refusal = 0;
    p$.wasAbandoned = true;
    p$.wasAbandonedTok = p$.failedTok;
    p$.wasAbandonedPos = p$.failedPos;
  } else {
    // The file is given up.
    abandonCheckpoint(cp);
    return false;
  }
  p$.hasReported = (cps[cp + CP_HAD_REPORTED] | 0) !== 0;
  rollback(cp);
  return false;
}

/**
 * `lookAhead` for a test that parses: nothing of what it built is kept.
 * `const cp = lookAheadParsingBegin(); if (cp < 0) return false; ...test...; return lookAheadParsingEnd(cp, result);`
 */
export function lookAheadParsingBegin(): number {
  return tryParseBegin();
}

export function lookAheadParsingEnd(cp: number, result: boolean): boolean {
  const p$ = p;
  p$.speculations = (p$.speculations - 1) | 0;
  p$.hasReported = (cps[cp + CP_HAD_REPORTED] | 0) !== 0;
  const lx$ = lx;
  const r = lx$.refusal | 0;
  if (r !== 0) {
    if (r === R_SYNTAX) {
      lx$.refusal = 0;
      result = false;
    } else {
      abandonCheckpoint(cp);
      return false;
    }
  }
  rollback(cp);
  return result;
}

// ───────────────────────────── names ─────────────────────────────

/** `atom` is the text of the `Identifier` at `pos`. */
export function noteIdentifier(atom: number, pos_: number): number {
  if (isKeywordIdentifier(atom)) hir.pushKeywordIdentifierPositions(pos_);
  return atom;
}

/** `noteIdentifier` of a name that a type refers to. */
export function noteNameInType(atom: number, pos_: number): void {
  if (isKeywordIdentifier(atom)) hir.pushKeywordIdentifierPositions(pos_);
}

/** `isIdentifier` (Babel/TypeScript: oxc's variant is not ported). */
export function isIdentifier(): boolean {
  return isIdentifierInContext();
}

/** `isIdentifier` */
export function isIdentifierInContext(): boolean {
  const t = lx.token;
  if (t === T_IDENTIFIER) return true;
  if (t <= T_WITH) return false;
  // "If we have a 'yield' keyword, and we're in the [yield] context, then 'yield' is considered a keyword and is not an
  // identifier."
  const p$ = p;
  return !((t === T_YIELD && (p$.context & CTX_YIELD) !== 0) || (t === T_AWAIT && (p$.context & CTX_AWAIT) !== 0));
}

/** `isBindingIdentifier` */
export function isBindingIdentifier(): boolean {
  const t = lx.token;
  return t === T_IDENTIFIER || t > T_WITH;
}

/** `parseIdentifier`: the name; its position is `p.outPos`. */
export function identifier(): number {
  if (!isIdentifier()) return missingIdentifier(0, 0);
  const lx$ = lx;
  const atom = lx$.atom | 0;
  const at = lx$.start | 0;
  noteIdentifier(atom, at);
  nextAfterName();
  p.outPos = at;
  return atom;
}

/** `parseIdentifierName`: any word. A private name is one for `tokenIsIdentifierOrKeyword`. The position is `p.outPos`. */
export function identifierName(): number {
  const lx$ = lx;
  const t = lx$.token;
  if (!isIdentifierOrKeyword(t)) return missingIdentifier(0, 0);
  const p$ = p;
  if (t === T_PRIVATE_IDENTIFIER && !p$.recovers) {
    fail();
    p$.outPos = lx$.start;
    return ATOM_NONE;
  }
  const atom = lx$.atom | 0;
  const at = lx$.start | 0;
  nextAfterName();
  p$.outPos = at;
  return atom;
}

/** The atom of the ASCII text `text` (slow: for rare names only). */
export function atom(text: string): number {
  return names.atomOfString(text);
}

/** `String(n)` as a name (an atom). */
export function numberName(n: number): number {
  return names.atomOfString(numberToString(n));
}

/** `bun_sema::atom::number_to_string`: JavaScript's `String(n)`. */
export function numberToString(n: number): string {
  return String(n);
}

// ───────────────────────────── lists ─────────────────────────────

/** Builds a list from the entries of the stack of ids from `base` on, and pops them. Returns the start; the length is `p.outLen`. */
export function takeIds(base: number): number {
  return takeList(s.ids, base);
}

/** The same for any stack. */
export function takeList(stack: I32Vec, base: number): number {
  const n = stack.len - base;
  const start = hir.listFrom(stack.data, stack.len, base);
  stack.len = base;
  p.outLen = n;
  return start;
}

// ───────────────────────────── errors (the leaf part of recover.rs) ─────────────────────────────
// Without `p.recovers` the first error ends the file (or the speculative parse that is going on): `fail`. With it the diagnostic is
// recorded and the parse goes on as TypeScript's does. The lists (`isAtElement`, ...) are in recover.ts.

const NO_ARGS: string[] = [];
const scannerRows: I32Vec = new I32Vec(16);

/** The text `src[start, end)` as a string (error messages only). */
export function srcText(start: number, end: number): string {
  const lx$ = lx;
  const e = end > lx$.len ? lx$.len : end;
  if (e <= start) return "";
  const src = lx$.src;
  return Buffer.from(src.buffer, src.byteOffset + start, e - start).toString("utf8");
}

/** `Lexer::text`: the text of the token as written. */
export function tokenSrcText(): string {
  const lx$ = lx;
  return srcText(lx$.start | 0, lx$.end | 0);
}

/** The text of the name `atom`. */
export function atomText(atom: number): string {
  const lx$ = lx;
  const buf = lx$.names.textBuf(atom);
  const at = lx$.names.textStart(atom);
  const n = lx$.names.textLen(atom);
  if (n === 0) return "";
  return Buffer.from(buf.buffer, buf.byteOffset + at, n).toString("utf8");
}

/** The end of `parseErrorAtRange`: no second error at the place of the last one. */
function addError(code: number, start: number, end: number, args: string[]): void {
  const h = hir;
  let i = h.diagnosticsLen - 5;
  while (i >= 0 && (h.diagnostics[i] | 0) !== DK_PARSE) i = (i - 5) | 0;
  if (i >= 0 && (h.diagnostics[i + 1] | 0) === start) return;
  let argsId = -1;
  if (args.length > 0) {
    argsId = h.diagArgs.length;
    h.diagArgs.push(args);
  }
  h.pushDiagnostics(DK_PARSE, start, end, code, argsId);
}

/** `scanError`: what the scanner has reported goes where the errors of the parser go, before the next of them. */
export function takeErrorsOfScanner(): void {
  const lx$ = lx;
  if (lx$.errors.len === 0) return;
  const rows = scannerRows;
  rows.reset();
  const n = lx$.takeErrors(rows);
  for (let i = 0; i < n; i++) {
    const code = rows.data[i * 3] | 0;
    const start = rows.data[i * 3 + 1] | 0;
    if (code === 1487 || code === 1488 || code === 1121) {
      const arg = lx$.argOf(code, start);
      addError(code, start, rows.data[i * 3 + 2] | 0, arg === "" ? NO_ARGS : [arg]);
    } else addError(code, start, rows.data[i * 3 + 2] | 0, NO_ARGS);
  }
}

/** `parseErrorAtRange`, with the arguments of the message. `end`: -1 = an empty range at `start`, 0 = the end of the token at `start`. */
export function errorArgs(code: number, start: number, end: number, args: string[]): void {
  const p$ = p;
  if (!p$.recovers) {
    fail();
    return;
  }
  // A loop that is not written for recovery yet can stay at a token for ever. What is nested and not closed reports an error at
  // one token for each level.
  const lx$ = lx;
  if (p$.errorsAtPos === lx$.start) p$.errorsAtCount = (p$.errorsAtCount + 1) | 0;
  else {
    p$.errorsAtPos = lx$.start | 0;
    p$.errorsAtCount = 0;
  }
  if (p$.errorsAtCount > 1 << 17) {
    refuse(R_UNSUPPORTED);
    return;
  }
  takeErrorsOfScanner();
  addError(code, start, end, args);
}

/** `parseErrorAtRange`. Without recovery: `fail`. */
export function error(code: number, start: number, end: number): void {
  errorArgs(code, start, end, NO_ARGS);
}

/** `parseErrorAtCurrentToken`, with the arguments of the message. */
export function errorAtTokenArgs(code: number, args: string[]): void {
  const lx$ = lx;
  errorArgs(code, lx$.start | 0, lx$.start === lx$.end ? -1 : lx$.end | 0, args);
}

/** `parseErrorAtCurrentToken` */
export function errorAtToken(code: number): void {
  const lx$ = lx;
  errorArgs(code, lx$.start | 0, lx$.start === lx$.end ? -1 : lx$.end | 0, NO_ARGS);
}

/** `parseExpected`, at another token. */
export function expected(tok: number): void {
  if (!p.recovers) {
    fail();
    return;
  }
  errorAtTokenArgs(1005, [tokenText(tok)]);
}

/** `parseExpectedMatchingBrackets`, at another token than `close`. */
export function unmatched(open: number, close: number, openAt: number): void {
  void open;
  void openAt;
  // Otherwise one of them counts for the error that is reported here.
  takeErrorsOfScanner();
  expected(close);
}

/** Where TypeScript's parser reports nothing and leaves the token to its caller. Without recovery the token is an error. */
export function failUnlessRecovering(): void {
  if (!p.recovers) fail();
}

/** `parseErrorAtRange`, about what is parsed all the same. Without recovery: `report`. */
export function errorAndGoOn(code: number, start: number, end: number): void {
  if (p.recovers) error(code, start, end);
  else report();
}

/** `errorAndGoOn` with the arguments of the message. */
export function errorAndGoOnArgs(code: number, start: number, end: number, args: string[]): void {
  if (p.recovers) errorArgs(code, start, end, args);
  else report();
}

/** `createIdentifierWithDiagnostic`, at a token that is no identifier for the caller. Without recovery: `fail`; the name is NONE. */
export function missingIdentifier(code: number, codeOfPrivateName: number): number {
  const p$ = p;
  const lx$ = lx;
  if (!p$.recovers) {
    fail();
    p$.outPos = lx$.start;
    return ATOM_NONE;
  }
  if (lx$.token === T_PRIVATE_IDENTIFIER) {
    errorAtToken(codeOfPrivateName === 0 ? 18016 : codeOfPrivateName);
    const name = lx$.atom | 0;
    const at = lx$.start | 0;
    lx$.next();
    p$.outPos = at;
    return name;
  }
  // "Only for end of file because the error gets reported incorrectly on embedded script tags."
  if (lx$.token === T_EOF) errorArgs(code === 0 ? 1003 : code, lx$.fullStart, -1, NO_ARGS);
  else if (code === 0 && isReservedWord(lx$.token)) errorAtTokenArgs(1359, [tokenSrcText()]);
  else errorAtToken(code === 0 ? 1003 : code);
  p$.outPos = lx$.start;
  return A_empty;
}

/** `parseIdentifier`, at a token that is none: the name, and where the node is (`p.outPos`). */
export function missingName(): number {
  const full = lx.fullStart | 0;
  const name = missingIdentifier(0, 0);
  if (name === A_empty) p.outPos = full;
  return name;
}

/** `parseIdentifierWithDiagnostic(code)` as an expression, at a token that is no identifier. Without recovery: NONE. */
export function missingExpression(code: number): number {
  missingIdentifier(code, 0);
  const lx$ = lx;
  if (p.recovers) return pushExprMissing(lx$.start, lx$.fullStart);
  return NONE;
}

/** `TokenValue()`. `previous`: the one of the token before, which a punctuator leaves. */
function tokenValue(previous: string): string {
  const lx$ = lx;
  const t = lx$.token;
  if (t === T_NUMBER) return numberToString(lx$.number);
  if (t === T_STRING || t === T_NO_SUBSTITUTION_TEMPLATE || t === T_TEMPLATE_HEAD) return atomText(lx$.atom);
  if (isIdentifierOrKeyword(t)) return atomText(lx$.atom);
  return previous;
}

/** `Parser::is_parenthesized`: the last parenthesis pushed is about `e`. */
function exprIsParenthesized(e: number): boolean {
  const hir$ = hir;
  const n = hir$.nParens;
  return n > 0 && (hir$.parenExpr[n - 1] | 0) === e;
}

/** `parseErrorForMissingSemicolonAfter` */
export function missingSemicolonAfter(expression: number): void {
  const hir$ = hir;
  if (expression < 0 || expression >= hir$.nExprs) {
    expected(T_SEMICOLON);
    return;
  }
  const tag = hir$.exprTag[expression] | 0;
  const pos_ = hir$.exprPos[expression] | 0;
  const end = hir$.exprEnd[expression] | 0;
  const isParenthesized = exprIsParenthesized(expression);
  if (tag === EXPR_TAGGED_TEMPLATE && !isParenthesized) {
    const call = hir$.exprA[expression] | 0;
    const template = hir$.callTemplate[call] | 0;
    const from = template >= 0 && template < hir$.nExprs ? hir$.exprPos[template] | 0 : pos_;
    error(1443, from, end);
  } else if (tag === EXPR_IDENT && !isParenthesized) {
    missingSemicolonAfterIdentifier(hir$.exprA[expression] | 0, pos_, end);
  } else {
    expected(T_SEMICOLON);
  }
}

/** `parseErrorForMissingSemicolonAfter`, of the identifier `name` from `pos` to `end`. */
function missingSemicolonAfterIdentifier(name: number, pos_: number, end: number): void {
  const word = atomText(name);
  const lx$ = lx;
  const token = lx$.token | 0;
  const hereStart = lx$.start | 0;
  const hereEnd = lx$.start === lx$.end ? -1 : lx$.end | 0;
  let suggestion: string | null = null;
  let at0 = hereStart;
  let at1 = hereEnd;
  let code = 0;
  if (word === "") {
    expected(T_SEMICOLON);
    return;
  } else if (word === "const" || word === "let" || word === "var") {
    at0 = pos_;
    at1 = end;
    code = 1440;
  } else if (word === "declare") {
    // "If a declared node failed to parse, it would have emitted a diagnostic already."
    return;
  } else if (word === "interface") {
    code = token === T_OPEN_BRACE ? 1438 : 2427;
  } else if (word === "is") {
    at0 = pos_;
    at1 = lx$.start | 0;
    code = 1228;
  } else if (word === "module" || word === "namespace") {
    code = token === T_OPEN_BRACE ? 1437 : 2819;
  } else if (word === "type") {
    code = token === T_EQUALS ? 1439 : 2457;
  } else {
    suggestion = keywordSuggestion(word);
    if (suggestion !== null) {
      at0 = pos_;
      at1 = end;
      code = 1435;
    } else if (token === T_INVALID) {
      // "Unknown tokens are handled with their own errors in the scanner"
      return;
    } else {
      at0 = pos_;
      at1 = end;
      code = 1434;
    }
  }
  if (suggestion !== null) errorArgs(code, at0, at1, [suggestion]);
  else if (code === 2427 || code === 2457 || code === 2819) errorArgs(code, at0, at1, [tokenValue(word)]);
  else errorArgs(code, at0, at1, NO_ARGS);
}

/**
 * `parseSemicolonAfterPropertyName`. `name`: the atom of the property name if it is an identifier (else -1) and its range.
 * Without recovery: `fail`.
 */
export function missingSemicolonAfterProperty(name: number, nameStart: number, nameEnd: number, hasType: boolean, hasInitializer: boolean): void {
  if (!p.recovers) {
    fail();
    return;
  }
  const lx$ = lx;
  if (lx$.token === T_AT && !lx$.newlineBefore) {
    errorAtToken(1436);
    return;
  }
  if (lx$.token === T_OPEN_PAREN) {
    errorAtToken(1441);
    lx$.next();
    return;
  }
  if (hasInitializer) expected(T_SEMICOLON);
  else if (hasType) errorAtToken(1442);
  else if (name >= 0) missingSemicolonAfterIdentifier(name, nameStart, nameEnd);
  else expected(T_SEMICOLON);
}

/** A list of `kind` is open from here on. Returns `lists` as the caller restores it after the list. */
export function enterList(kind: number): number {
  const p$ = p;
  const saved = p$.lists | 0;
  p$.lists = saved | (1 << kind);
  return saved;
}

/** After the list: `lists` is what `enterList` has returned. */
export function leaveList(lists: number): void {
  p.lists = lists;
}

/** `TokenRange()`, as the range of a diagnostic: the start; the end is `p.outLen` (NO_LENGTH = -1 for an empty token). */
export function rangeOfToken(): number {
  const lx$ = lx;
  p.outLen = lx$.start === lx$.end ? -1 : lx$.end;
  return lx$.start;
}

/**
 * `add_stmt`'s second half: sets the `loc` (`startFull`..the end of the previous token) and the modifiers of a statement row that
 * was just pushed (`pushStmtX(startPos, ...)`). Returns the id.
 */
export function finishStmt(stmt: number, startFull: number, modStart: number, modLen: number): number {
  const hir$ = hir;
  hir$.stmtLocPos[stmt] = startFull;
  hir$.stmtLocEnd[stmt] = lx.fullStart;
  hir$.stmtModStart[stmt] = modStart;
  hir$.stmtModLen[stmt] = modLen;
  return stmt;
}

// ───────────────────────────── expression rows (expr.rs helpers used everywhere) ─────────────────────────────

/** `Expr::kind == Missing` at the id. */
export function isMissingExpr(e: number): boolean {
  return e >= 0 && (hir.exprTag[e] | 0) === EXPR_MISSING;
}

/** A Missing expression (`createMissingIdentifier`-like node) at `[pos, end)`. */
export function addMissingExpr(pos_: number, end: number): number {
  return pushExprMissing(pos_, end);
}

// Small predicates on the kinds that several files ask.
export function isPlainTarget(e: number): boolean {
  if (e < 0) return false;
  const hir$ = hir;
  const t = hir$.exprTag[e] | 0;
  if (t === EXPR_IDENT) return true;
  if (t === EXPR_DOT || t === EXPR_INDEX) return (hir$.exprAux[e] | 0) === CHAIN_NO;
  return false;
}
