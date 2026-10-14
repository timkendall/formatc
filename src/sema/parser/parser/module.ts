// Port of vendor/bun/src/sema/parser/parser/module.rs: import and export declarations.
//
// Conventions: those of mod.ts (module-level `lx`, `p`, `s`; free functions; several results via `p.outPos/outLen/outA/outB`).
// Only the non-recovering Babel/TypeScript parse is ported: the branches for oxc, Flow and recovery are `// TODO(..)` comments.
//
// Rust's `ExportName { text, pos, token }` / `Specifier` are module-level registers here (`mText/mPos/mTok`, `sp*`): read them right
// after the call that fills them.
import {
  EXPR_MISSING,
  EXPR_STRING,
  IET_ENTITY,
  IET_REQUIRE,
  DK_CHECKER,
  DK_GRAMMAR,
  FLAG_AMBIENT,
  FLAG_EXPORT,
  FLAG_TYPE_ONLY,
  NK_IDENTIFIER,
  NONE,
  PK_NAME,
  PROP_INIT,
  RARE_EXPORT_ASSIGNMENT,
  RM_IMPORT,
  RM_NONE,
  RM_REQUIRE,
  hir,
  pushExprObject,
  pushStmtExportAsNamespace,
  pushStmtExportAssign,
  pushStmtExportDefault,
  pushStmtExportNamed,
  pushStmtExportStar,
  pushStmtImport,
  pushStmtImportEquals,
} from "../../hir.ts";
import { A_empty, ATOM_NONE } from "../../atom.ts";
import {
  T_AS,
  T_ASSERT,
  T_ASTERISK,
  T_AWAIT,
  T_CLOSE_BRACE,
  T_CLOSE_PAREN,
  T_COLON,
  T_COMMA,
  T_DEFER,
  T_DOT,
  T_EQUALS,
  T_FROM,
  T_IDENTIFIER,
  T_LESS_THAN,
  T_NAMESPACE,
  T_OPEN_BRACE,
  T_OPEN_PAREN,
  T_PRIVATE_IDENTIFIER,
  T_REQUIRE,
  T_STRING,
  T_TYPE,
  T_TYPE_OF,
  T_WITH,
  T_YIELD,
  isReservedWord,
} from "../token.ts";
import { R_REPORTED, R_UNSUPPORTED } from "../lib.ts";
import {
  CTX_AWAIT,
  CTX_DISALLOW_IN,
  CTX_TOP_LEVEL,
  CTX_YIELD,
  LK_IMPORT_ATTRIBUTES,
  LK_IMPORT_OR_EXPORT_SPECIFIERS,
  ambient,
  eat,
  enterContext,
  enterList,
  errorAndGoOn,
  expect,
  expected,
  fail,
  failUnlessRecovering,
  flag,
  hasContext,
  hasFailed,
  isIdentifier,
  isInList,
  leaveList,
  lx,
  missingName,
  names,
  nextAfterName,
  noteIdentifier,
  p,
  peek,
  refuse,
  report,
  s,
  semicolon,
  takeList,
} from "./mod.ts";
import { isAtElement, goesOnWithoutComma } from "./recover.ts";
import { assignmentExpression, expression, isFollowedByWordOnSameLine, isParenthesized } from "./expr.ts";
import { jsError } from "./js_syntax.ts";
import { finishStmt, takeModifiers } from "./stmt.ts";
import { error } from "./mod.ts";
import { NO_WORD } from "./module.consts.ts";

/** Whether the text is read as acorn or Babel read it: what TypeScript's parser leaves to the checker is an error of their parsers. */
function isReadAsByOtherParsers(): boolean {
  const p$ = p;
  return p$.isEcmascript || p$.isBabel;
}

// ExportName register: the text (atom), the position and the token of the last `moduleExportName`.
let mText = 0;
let mPos = 0;
let mTok = 0;

// Specifier registers: `importOrExportSpecifier` leaves its result here.
let spStart = 0;
let spIsTypeOnly = false;
let spHasProp = false;
let spPropText = 0;
let spPropPos = 0;
let spPropTok = 0;
let spPropEnd = 0;
let spNameText = 0;
let spNamePos = 0;
let spNameTok = 0;
let spEnd = 0;

/**
 * `parseModuleSpecifier`, and the import attributes after it: the text (an atom), which is recorded as a reference to that module
 * (`specifier_uses` is not kept). `ATOM_NONE`: it is no string. The resolution mode (RM_*) is in `p.outA`.
 * `isTypeOnly`: after `import type` or `export type`, the only declarations whose `resolution-mode` is honored.
 */
function moduleSpecifier(isExport: boolean, isTypeOnly: boolean): number {
  const lx$ = lx;
  const p$ = p;
  if (lx$.token !== T_STRING) {
    expressionAsModuleSpecifier(isExport);
    p$.outA = RM_NONE;
    return ATOM_NONE;
  }
  const spec = lx$.atom;
  lx$.next();
  let mode = importAttributesOfDeclaration(isExport);
  if (!isTypeOnly) mode = RM_NONE;
  p$.outA = mode;
  return spec;
}

/** `parseModuleSpecifier` at a token that is no string, and the import attributes after it: "We allow arbitrary expressions here". */
function expressionAsModuleSpecifier(isExport: boolean): void {
  if (isReadAsByOtherParsers()) {
    // TODO(oxc)/TODO(recover): oxc's errors before this one count, so the file is not given up.
    refuse(R_REPORTED);
    return;
  }
  const at = lx.start;
  const hir$ = hir;
  const importsBefore = hir$.nImports;
  const exportsBefore = hir$.nExports;
  // `parseExportDeclaration` has `setAwaitContext(true)`.
  const p$ = p;
  const saved = p$.context;
  if (isExport) p$.context = p$.context | CTX_AWAIT;
  const e = expression();
  p$.context = saved;
  if (hasFailed()) return;
  stringLiteralExpected(e, at);
  hir$.pushSpecifierExpressions(e);
  afterExpressionsOfDeclaration(at, importsBefore, exportsBefore);
  importAttributesOfDeclaration(isExport);
  if (isExport) {
    // The declaration is the next statement that is added.
    hir$.pushExportsFromExpressions(hir$.nStmts, e);
  }
}

/**
 * `checkExternalImportOrExportDeclaration`, of what is from `at` on in the place of a module specifier. Whether it is there: nothing is
 * reported about a missing one.
 */
function stringLiteralExpected(e: number, at: number): boolean {
  const isMissing = e >= 0 && (hir.exprTag[e] | 0) === EXPR_MISSING && !isParenthesized(e);
  if (!isMissing) flag(DK_CHECKER, 1141, at, lx.fullStart);
  return !isMissing;
}

// TODO(recover): `forgetSpecifiersOfMisplacedDeclarations` (module.rs): after the statements of the file, takes back the 1141 flags of
// imports and exports that are no statement of the file or of a module block.

/**
 * After the expressions from `from` on that an import or export declaration has where strings belong. The file had
 * `importsBefore` imports and `exportsBefore` exports before them.
 */
function afterExpressionsOfDeclaration(from: number, importsBefore: number, exportsBefore: number): void {
  // The specifiers of the declaration hold the index that it was going to get.
  const hir$ = hir;
  const hasDeclarations = importsBefore !== hir$.nImports || exportsBefore !== hir$.nExports;
  // For an `await` that is a name, `reparseTopLevelAwait` parses the names of an import again too.
  const topLevel = CTX_TOP_LEVEL | CTX_AWAIT;
  let hasAwait = false;
  const lx$ = lx;
  if ((p.context & topLevel) === topLevel) {
    const src = lx$.src;
    const end = lx$.fullStart | 0;
    for (let i = from; i + 5 <= end; i++) {
      if (
        (src[i] | 0) === 97 &&
        (src[i + 1] | 0) === 119 &&
        (src[i + 2] | 0) === 97 &&
        (src[i + 3] | 0) === 105 &&
        (src[i + 4] | 0) === 116
      ) {
        hasAwait = true;
        break;
      }
    }
  }
  if (hasDeclarations || hasAwait) refuse(R_UNSUPPORTED);
}

/** `tryParseImportAttributes`, and what `parseExportDeclaration` has in its place. Returns the resolution mode (RM_*). */
function importAttributesOfDeclaration(isExport: boolean): number {
  // After an import, `with` can be on the next line. After an export it starts a statement there for TypeScript, and for nobody else.
  // TODO(oxc): `&& !dialect.oxc`
  const lx$ = lx;
  const p$ = p;
  const isStatement = isExport && lx$.newlineBefore && !p$.isEcmascript;
  if (lx$.token === T_WITH && !isStatement) return importAttributesAfterSpecifier(isExport);
  if (lx$.token === T_ASSERT && !lx$.newlineBefore) {
    // An error of the native parser.
    if (p$.isTypescript5) flag(DK_GRAMMAR, 2880, lx$.start, lx$.end);
    else errorAndGoOn(2880, lx$.start, lx$.start === lx$.end ? -1 : lx$.end);
    return importAttributesAfterSpecifier(isExport);
  }
  return RM_NONE;
}

/** `parseImportAttributes`, at the keyword after a module specifier. */
function importAttributesAfterSpecifier(isExport: boolean): number {
  // `parseExportDeclaration` has `setAwaitContext(true)`.
  const p$ = p;
  const saved = p$.context;
  if (isExport && !p$.isEcmascript) p$.context = p$.context | CTX_AWAIT;
  const mode = importAttributes(false);
  p$.context = saved;
  return mode;
}

/**
 * `parseImportAttributes`, at `with`: they are kept as an object literal. Returns `getResolutionModeOverride`. `isInType`: in
 * `import("a", { with: { .. } })`, where a colon follows the keyword, and where a token that is reported can be in the place of the
 * keyword.
 */
export function importAttributes(isInType: boolean): number {
  const lx$ = lx;
  const keyword = lx$.start;
  if (!isInType || lx$.token === T_WITH || lx$.token === T_ASSERT) lx$.next();
  if (isInType) expect(T_COLON);
  const open = lx$.start;
  const hir$ = hir;
  if (!expect(T_OPEN_BRACE)) {
    // `parseEmptyNodeList`
    const object = pushExprObject(open, open, 0, 0);
    hir$.pushImportAttributes(keyword, object);
    return RM_NONE;
  }
  const importsBefore = hir$.nImports;
  const exportsBefore = hir$.nExports;
  const s$ = s;
  const base = s$.props.len;
  let mode = RM_NONE;
  let hasOnlyStrings = true;
  const lists = enterList(LK_IMPORT_ATTRIBUTES);
  const names$ = names;
  while (isInList(T_CLOSE_BRACE) && isAtElement(LK_IMPORT_ATTRIBUTES)) {
    // `parseImportAttribute`
    const pos = lx$.start;
    const element = lx$.fullStart;
    const token = lx$.token;
    // `tokenIsIdentifierOrKeyword` is true of a private name.
    if (token !== T_STRING && (token < T_IDENTIFIER || (token === T_PRIVATE_IDENTIFIER && isReadAsByOtherParsers()))) {
      fail();
      break;
    }
    const key = lx$.atom;
    nextAfterName();
    expect(T_COLON);
    // The checker reports all but a string.
    const isAtString = lx$.token === T_STRING;
    const value = assignmentExpression();
    // A template without substitutions is one too.
    let text = NONE;
    if (value >= 0 && (hir$.exprTag[value] | 0) === EXPR_STRING) text = hir$.exprA[value] | 0;
    hasOnlyStrings = hasOnlyStrings && isAtString && text >= 0;
    if (token === T_STRING && names$.atomIs(key, "resolution-mode")) {
      // `IsStringLiteralLike`
      if (text >= 0 && isParenthesized(value)) text = NONE;
      if (text >= 0 && names$.atomIs(text, "import")) mode = RM_IMPORT;
      else if (text >= 0 && names$.atomIs(text, "require")) mode = RM_REQUIRE;
      else mode = RM_NONE;
    }
    s$.props.push(hir$.pushProp(PROP_INIT, PK_NAME, key, NK_IDENTIFIER, value, pos, pos, lx$.fullStart, 0, 0, 0));
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_IMPORT_ATTRIBUTES, element)) break;
  }
  leaveList(lists);
  if (!eat(T_CLOSE_BRACE)) unclosedImportAttributes(open);
  const p$ = p;
  if (!hasOnlyStrings && !hasFailed()) {
    // In a TypeScript file Prettier asks typescript-estree, which takes any expression.
    if (p$.isEcmascript) {
      // TODO(oxc): the linter has oxc's words for it.
      refuse(R_REPORTED);
    } else if (!isInType) {
      afterExpressionsOfDeclaration(open, importsBefore, exportsBefore);
    }
  }
  // Only if it is the only attribute.
  if (s$.props.len !== base + 1) mode = RM_NONE;
  const props = takeList(s$.props, base);
  const object = pushExprObject(open, lx$.fullStart, props, p$.outLen);
  hir$.pushImportAttributes(keyword, object);
  return mode;
}

/** The ends of `parseImportAttributes` and of the braces around them in `parseImportType`, at another token than the `}` for the `{` at `open`. */
export function unclosedImportAttributes(open: number): void {
  void open;
  // TODO(recover): `expected(T_CLOSE_BRACE); relateToOpenBrace(open)`
  if (!p.recovers) {
    fail();
    return;
  }
  expected(T_CLOSE_BRACE);
}

/**
 * Leaves the await context that the top level is. `statementHasAwaitIdentifier` is restored after the names that an import declares,
 * after `import a = b` and after `export as namespace a`: `reparseTopLevelAwait` parses no statement again for an `await` in them.
 * Returns the context to restore.
 */
function leaveAwaitContextOfTopLevel(): number {
  const p$ = p;
  const saved = p$.context;
  if ((saved & CTX_TOP_LEVEL) !== 0 && !p$.isEcmascript) p$.context = saved & ~CTX_AWAIT;
  return saved;
}

/** `parseIdentifier`: the name, which is not noted; the position is `p.outPos`. */
function identifierOfDeclaration(): number {
  if (!isIdentifier()) return missingName();
  const lx$ = lx;
  const atom = lx$.atom;
  p.outPos = lx$.start;
  nextAfterName();
  return atom;
}

/** `canParseModuleExportName` */
function canParseModuleExportName(): boolean {
  const lx$ = lx;
  return lx$.token >= T_IDENTIFIER || lx$.token === T_STRING;
}

/** `parseModuleExportName`: the result is in `mText`, `mPos`, `mTok`. */
function moduleExportName(): void {
  if (!canParseModuleExportName()) {
    mText = missingName();
    mPos = p.outPos | 0;
    mTok = T_IDENTIFIER;
    return;
  }
  const lx$ = lx;
  mText = lx$.atom;
  mPos = lx$.start;
  mTok = lx$.token;
  nextAfterName();
}

/** `parseImportOrExportSpecifier`, but for the error about the name. The result is in the `sp*` registers. */
function importOrExportSpecifier(): void {
  const lx$ = lx;
  spStart = lx$.start;
  let isTypeOnly = false;
  let hasProp = false;
  let propText = 0;
  let propPos = 0;
  let propTok = 0;
  let canParseAs = true;
  let propEnd = 0;
  moduleExportName();
  let nameText = mText;
  let namePos = mPos;
  let nameTok = mTok;
  if (nameTok === T_TYPE || (nameTok === T_TYPE_OF && p.isFlow)) {
    // "If the first token of an import specifier is 'type', there are a lot of possibilities"
    if (lx$.token === T_AS) {
      moduleExportName();
      const faText = mText;
      const faPos = mPos;
      const faTok = mTok;
      if (lx$.token === T_AS) {
        moduleExportName();
        const saText = mText;
        const saPos = mPos;
        const saTok = mTok;
        canParseAs = false;
        if (canParseModuleExportName()) {
          // "{ type as as something }"
          isTypeOnly = true;
          hasProp = true;
          propText = faText;
          propPos = faPos;
          propTok = faTok;
          moduleExportName();
          nameText = mText;
          namePos = mPos;
          nameTok = mTok;
        } else {
          // "{ type as as }"
          hasProp = true;
          propText = nameText;
          propPos = namePos;
          propTok = nameTok;
          nameText = saText;
          namePos = saPos;
          nameTok = saTok;
        }
      } else if (canParseModuleExportName()) {
        // "{ type as something }"
        hasProp = true;
        propText = nameText;
        propPos = namePos;
        propTok = nameTok;
        canParseAs = false;
        moduleExportName();
        nameText = mText;
        namePos = mPos;
        nameTok = mTok;
      } else {
        // "{ type as }"
        isTypeOnly = true;
        nameText = faText;
        namePos = faPos;
        nameTok = faTok;
      }
    } else if (canParseModuleExportName()) {
      // "{ type something ...? }"
      isTypeOnly = true;
      moduleExportName();
      nameText = mText;
      namePos = mPos;
      nameTok = mTok;
    }
  }
  if (canParseAs && lx$.token === T_AS) {
    hasProp = true;
    propText = nameText;
    propPos = namePos;
    propTok = nameTok;
    propEnd = lx$.fullStart;
    lx$.next();
    moduleExportName();
    nameText = mText;
    namePos = mPos;
    nameTok = mTok;
  }
  spIsTypeOnly = isTypeOnly;
  spHasProp = hasProp;
  spPropText = propText;
  spPropPos = propPos;
  spPropTok = propTok;
  spPropEnd = propEnd;
  spNameText = nameText;
  spNamePos = namePos;
  spNameTok = nameTok;
  spEnd = lx$.fullStart;
}

/**
 * The ends of `parseImportOrExportSpecifier` and of `parseImportSpecifier`, for a name that is more than an identifier. Returns the
 * text of the name in the other module (`imported`), which `text` is unless it is a string without `as`.
 */
function unusualNameOfImportSpecifier(imported: number): number {
  // "disallowKeywords && ast.IsKeyword(p.token) && !p.isIdentifier()"
  const token = spNameTok;
  let isIdent = false;
  const p$ = p;
  if (token === T_STRING) isIdent = false;
  else if (token === T_YIELD && !p$.isEcmascript) isIdent = !hasContext(CTX_YIELD);
  else if (token === T_AWAIT && !p$.isEcmascript) isIdent = !hasContext(CTX_AWAIT);
  else isIdent = !isReservedWord(token);
  if (!isIdent) errorAndGoOn(1003, spNamePos, spEnd);
  // `ImportSpec::is_name_missing`
  if (token === T_STRING && !spHasProp) return A_empty;
  return imported;
}

/**
 * For a local name of an export specifier that is more than an identifier. What is reported about it if no `from` follows the
 * specifiers is pushed on the stack of ids: its range.
 */
function unusualLocalOfExportSpecifier(): void {
  const localPos = spHasProp ? spPropPos : spNamePos;
  const localTok = spHasProp ? spPropTok : spNameTok;
  // TODO(oxc): `dialect.oxc && local.text.isKeywordIdentifier()`: a keyword identifier position.
  let isReported = false;
  if (isReadAsByOtherParsers()) {
    // It is a reference.
    isReported = localTok === T_STRING || isReservedWord(localTok);
  } else {
    // `checkModuleExportName(node.PropertyName(), hasModuleSpecifier)`
    isReported = localTok === T_STRING && spHasProp;
  }
  const s$ = s;
  if (isReported) {
    s$.ids.push(localPos);
    s$.ids.push(spPropEnd);
  }
}

/** Pops what `unusualLocalOfExportSpecifier` has pushed from `base` on, and reports it. */
function reportLocalsOfExport(base: number, hasModuleSpecifier: boolean): void {
  const s$ = s;
  if (!hasModuleSpecifier && isReadAsByOtherParsers()) {
    refuse(R_REPORTED);
  } else if (!hasModuleSpecifier) {
    for (let i = base; i + 1 < s$.ids.len; i += 2) flag(DK_GRAMMAR, 1003, s$.ids.data[i] | 0, s$.ids.data[i + 1] | 0);
  }
  s$.ids.truncate(base);
}

/** `parseImportDeclarationOrImportEqualsDeclaration` */
export function importDeclarationOrImportEquals(startPos: number, startFull: number, base: number, flags: number): number {
  const lx$ = lx;
  lx$.next();
  const saved = leaveAwaitContextOfTopLevel();
  const clauseStart = lx$.start;
  let hasId = false;
  let idAtom = 0;
  let idPos = 0;
  let idTok = 0;
  const p$ = p;
  if (isIdentifier() || (lx$.token === T_TYPE_OF && p$.isFlow)) {
    idAtom = lx$.atom;
    idPos = lx$.start;
    idTok = lx$.token;
    hasId = true;
    nextAfterName();
  }
  let typeOnly = false;
  let isDeferred = false;
  if (hasId && (idTok === T_TYPE || idTok === T_TYPE_OF)) {
    const isModifier =
      (lx$.token !== T_FROM || (isIdentifier() && (peek() === T_FROM || peek() === T_EQUALS))) &&
      (isIdentifier() || lx$.token === T_ASTERISK || lx$.token === T_OPEN_BRACE);
    if (isModifier) {
      typeOnly = true;
      hasId = false;
      if (isIdentifier()) {
        idAtom = lx$.atom;
        idPos = lx$.start;
        idTok = lx$.token;
        hasId = true;
        nextAfterName();
      }
    }
  } else if (hasId && (idTok === T_DEFER || (p$.isBabel && names.atomIs(idAtom, "source")))) {
    // For Babel and oxc `source` is a phase too. It is kept like `defer`: the text tells them apart.
    if (lx$.token === T_FROM) isDeferred = peek() !== T_STRING;
    else isDeferred = !(lx$.token === T_COMMA || lx$.token === T_EQUALS);
    if (isDeferred) {
      // Only `import source x from "a"`.
      if (idTok !== T_DEFER && !isIdentifier()) report();
      hasId = false;
      if (isIdentifier()) {
        idAtom = lx$.atom;
        idPos = lx$.start;
        idTok = lx$.token;
        hasId = true;
        nextAfterName();
      }
    }
  }
  // Without a `=` oxc goes on with the clause, and misses the `from`. TODO(oxc): `(token === T_EQUALS || !dialect.oxc)`
  if (hasId && !isDeferred && !(lx$.token === T_COMMA || lx$.token === T_FROM)) {
    const st = importEquals(startPos, startFull, base, flags, idAtom, idPos, typeOnly);
    p$.context = saved;
    return st;
  }
  // The checker reports them.
  const modStart = takeModifiers(base);
  const modLen = p$.outLen | 0;
  // `parseImportClause`
  let defaultAtom = ATOM_NONE;
  let defaultPos = 0;
  if (hasId) {
    defaultAtom = idAtom;
    defaultPos = idPos;
  }
  let namespace = ATOM_NONE;
  let namespacePos = 0;
  let namespaceStart = 0;
  const s$ = s;
  const specs = s$.importSpecs.len;
  let hasNamedImports = false;
  const hir$ = hir;
  const declaration = hir$.nImports | 0;
  const hasClause = hasId || lx$.token === T_ASTERISK || lx$.token === T_OPEN_BRACE;
  if (hasClause && (!hasId || eat(T_COMMA))) {
    // TODO(oxc): `type_only_import_of_both`
    if (lx$.token === T_ASTERISK) {
      // `parseNamespaceImport`
      namespaceStart = lx$.start;
      lx$.next();
      expect(T_AS);
      namespace = identifierOfDeclaration();
      namespacePos = p$.outPos | 0;
    } else {
      hasNamedImports = true;
      const hasList = expect(T_OPEN_BRACE);
      const lists = enterList(LK_IMPORT_OR_EXPORT_SPECIFIERS);
      while (hasList && isInList(T_CLOSE_BRACE) && isAtElement(LK_IMPORT_OR_EXPORT_SPECIFIERS)) {
        const element = lx$.fullStart;
        importOrExportSpecifier();
        let importedText = spHasProp ? spPropText : spNameText;
        const importedPos = spHasProp ? spPropPos : spNamePos;
        const nameText = spNameText;
        const namePos = spNamePos;
        const spTypeOnly = spIsTypeOnly;
        const st0 = spStart;
        const en0 = spEnd;
        if (spNameTok !== T_IDENTIFIER) importedText = unusualNameOfImportSpecifier(importedText);
        if (spTypeOnly) {
          jsError(st0, en0, 8006, "import...type");
          // TODO(oxc): `type_modifier_twice`
        }
        s$.importSpecs.push(hir$.pushImportSpec(st0, importedText, nameText, namePos, spTypeOnly ? 1 : 0, importedPos, en0, declaration));
        if (!eat(T_COMMA) && !goesOnWithoutComma(LK_IMPORT_OR_EXPORT_SPECIFIERS, element)) break;
      }
      leaveList(lists);
      if (hasList) expect(T_CLOSE_BRACE);
    }
  }
  p$.context = saved;
  // `tryParseImportClause`: without a clause there is nothing that the modifier is of.
  if (isDeferred && !hasClause) {
    if (isReadAsByOtherParsers()) report();
    else isDeferred = false;
  }
  const clauseEnd = hasClause ? lx$.fullStart : clauseStart;
  if (hasClause) expect(T_FROM);
  const spec = moduleSpecifier(false, typeOnly);
  const mode = p$.outA | 0;
  semicolon();
  // The reference notes the names in this order.
  for (let i = specs; i < s$.importSpecs.len; i++) {
    const sp = s$.importSpecs.data[i] | 0;
    noteIdentifier(hir$.importSpecLocal[sp] | 0, hir$.importSpecPos[sp] | 0);
    // TODO(oxc): `declare(local, DECLARES_IMPORT)`
  }
  if (defaultAtom >= 0) noteIdentifier(defaultAtom, defaultPos);
  if (namespace >= 0) noteIdentifier(namespace, namespacePos);
  const named = takeList(s$.importSpecs, specs);
  const namedLen = p$.outLen | 0;
  const imp = hir$.pushImport(
    spec,
    defaultAtom,
    defaultPos,
    namespace,
    namespacePos,
    clauseStart,
    clauseEnd,
    namespaceStart,
    named,
    namedLen,
    hasNamedImports ? 1 : 0,
    typeOnly ? 1 : 0,
    isDeferred ? 1 : 0,
    mode,
    NONE,
  );
  return finishStmt(pushStmtImport(startPos, imp), startFull, modStart, modLen);
}

/** `parseImportEqualsDeclaration`, at the `=`. */
function importEquals(startPos: number, startFull: number, base: number, flags0: number, name: number, namePos: number, typeOnly: boolean): number {
  expect(T_EQUALS);
  let flags = (flags0 & (FLAG_EXPORT | FLAG_AMBIENT)) | ambient();
  if (typeOnly) flags = flags | FLAG_TYPE_ONLY;
  let expr = NONE;
  let targetKind = IET_REQUIRE;
  let targetA = ATOM_NONE;
  let targetB = 0;
  // `parseModuleReference`
  const lx$ = lx;
  const s$ = s;
  const p$ = p;
  const hir$ = hir;
  if (lx$.token === T_REQUIRE && peek() === T_OPEN_PAREN) {
    // `parseExternalModuleReference`
    lx$.next();
    lx$.next();
    let spec = ATOM_NONE;
    if (lx$.token === T_STRING) {
      spec = lx$.atom;
      lx$.next();
    } else {
      expr = expressionAsRequiredModule();
    }
    expect(T_CLOSE_PAREN);
    targetKind = IET_REQUIRE;
    targetA = spec;
  } else {
    // `parseEntityName`
    const nbase = s$.names.len;
    const first = identifierOfDeclaration();
    const firstPos = p$.outPos | 0;
    noteIdentifier(first, firstPos);
    s$.names.push(hir$.pushName(first, firstPos, 0));
    while (eat(T_DOT)) {
      const part = rightSideOfDotInModuleReference();
      if (part === NO_WORD) break;
      s$.names.push(hir$.pushName(part, p$.outPos, 1));
    }
    targetA = takeList(s$.names, nbase);
    targetB = p$.outLen | 0;
    targetKind = IET_ENTITY;
  }
  semicolon();
  // TODO(oxc): `type_only_import_alias`
  noteIdentifier(name, namePos);
  // TODO(oxc): `declare(name, DECLARES_IMPORT)`
  const declaration = hir$.pushImportEquals(name, namePos, targetKind, targetA, targetB, expr, flags, NONE);
  const modStart = takeModifiers(base);
  const modLen = p$.outLen | 0;
  return finishStmt(pushStmtImportEquals(startPos, declaration), startFull, modStart, modLen);
}

/** `parseModuleSpecifier` in `parseExternalModuleReference`, at a token that is no string. NONE: it is missing. */
function expressionAsRequiredModule(): number {
  if (isReadAsByOtherParsers()) {
    refuse(R_REPORTED);
    return NONE;
  }
  const at = lx.start;
  const e = expression();
  if (hasFailed()) return NONE;
  if (stringLiteralExpected(e, at)) return e;
  // Nothing stands for it.
  const hir$ = hir;
  if (hir$.nExprs === e + 1) hir$.nExprs = e;
  return NONE;
}

/**
 * `parseRightSideOfDot` in the `parseEntityName` of `parseModuleReference`, where a reserved word is no name. `NO_WORD`: at a `<`,
 * before which `parseEntityName` ends. The position is `p.outPos`.
 */
function rightSideOfDotInModuleReference(): number {
  const lx$ = lx;
  if (!isIdentifier() || lx$.newlineBefore) return rightSideOfDotInModuleReferenceInGeneral();
  const atom = lx$.atom;
  const pos = lx$.start;
  noteIdentifier(atom, pos);
  nextAfterName();
  p.outPos = pos;
  return atom;
}

function rightSideOfDotInModuleReferenceInGeneral(): number {
  const lx$ = lx;
  const token = lx$.token;
  // "The entity is part of a JSDoc-style generic."
  if (token === T_LESS_THAN) {
    failUnlessRecovering();
    return NO_WORD;
  }
  // A name on the next line that a word follows on its line starts the next statement.
  const isNextStatement = lx$.newlineBefore && token >= T_IDENTIFIER && isFollowedByWordOnSameLine();
  if (token === T_PRIVATE_IDENTIFIER && !isNextStatement) lx$.next();
  const p$ = p;
  if (token === T_PRIVATE_IDENTIFIER || isNextStatement) {
    const at = lx$.fullStart | 0;
    error(1003, at, -1);
    p$.outPos = at;
    return A_empty;
  }
  const name = identifierOfDeclaration();
  noteIdentifier(name, p$.outPos | 0);
  return name;
}

/** `parseExportDeclaration`, after `export`. */
export function exportDeclaration(startPos: number, startFull: number, base: number): number {
  // The checker reports them. In Flow: `declare`
  const modStart = takeModifiers(base);
  const p$ = p;
  const modLen = p$.outLen | 0;
  const typeOnly = eat(T_TYPE);
  const lx$ = lx;
  if (lx$.token === T_ASTERISK) {
    const starPos = lx$.start;
    lx$.next();
    let alias = ATOM_NONE;
    let aliasPos = lx$.start;
    if (eat(T_AS)) {
      moduleExportName();
      alias = mText;
      aliasPos = mPos;
    }
    expect(T_FROM);
    const spec = moduleSpecifier(true, typeOnly);
    const mode = p$.outA | 0;
    semicolon();
    if (alias >= 0) noteIdentifier(alias, aliasPos);
    const st = pushStmtExportStar(startPos, spec, alias, starPos, aliasPos, (typeOnly ? 1 : 0) | (mode << 1));
    return finishStmt(st, startFull, modStart, modLen);
  }
  const hir$ = hir;
  const declaration = hir$.nExports | 0;
  const s$ = s;
  const specs = s$.exportSpecs.len;
  const hasList = expect(T_OPEN_BRACE);
  const unusualLocals = s$.ids.len;
  const lists = enterList(LK_IMPORT_OR_EXPORT_SPECIFIERS);
  while (hasList && isInList(T_CLOSE_BRACE) && isAtElement(LK_IMPORT_OR_EXPORT_SPECIFIERS)) {
    const element = lx$.fullStart;
    importOrExportSpecifier();
    const localText = spHasProp ? spPropText : spNameText;
    const localPos = spHasProp ? spPropPos : spNamePos;
    const localTok = spHasProp ? spPropTok : spNameTok;
    const exported = spNameText;
    const exportedPos = spNamePos;
    const isTypeOnlySpec = spIsTypeOnly;
    const st0 = spStart;
    const en0 = spEnd;
    if (localTok !== T_IDENTIFIER) unusualLocalOfExportSpecifier();
    if (isTypeOnlySpec) {
      jsError(st0, en0, 8006, "export...type");
      // TODO(oxc): `type_modifier_twice`
    }
    s$.exportSpecs.push(hir$.pushExportSpec(st0, localText, exported, exportedPos, isTypeOnlySpec ? 1 : 0, localPos, en0, declaration));
    if (!eat(T_COMMA) && !goesOnWithoutComma(LK_IMPORT_OR_EXPORT_SPECIFIERS, element)) break;
  }
  leaveList(lists);
  if (hasList) expect(T_CLOSE_BRACE);
  // "If we don't have a 'from' keyword, see if we have a string literal such that ASI won't take effect."
  const hasModuleSpecifier = lx$.token === T_FROM || (lx$.token === T_STRING && !lx$.newlineBefore);
  if (s$.ids.len !== unusualLocals) reportLocalsOfExport(unusualLocals, hasModuleSpecifier);
  let spec = ATOM_NONE;
  let mode = RM_NONE;
  if (hasModuleSpecifier) {
    expect(T_FROM);
    spec = moduleSpecifier(true, typeOnly);
    mode = p$.outA | 0;
  }
  semicolon();
  const items = takeList(s$.exportSpecs, specs);
  const itemsLen = p$.outLen | 0;
  const exp = hir$.pushExport(spec, hasModuleSpecifier ? 1 : 0, items, itemsLen, typeOnly ? 1 : 0, mode, NONE);
  return finishStmt(pushStmtExportNamed(startPos, exp), startFull, modStart, modLen);
}

/** `parseExportAssignment`, at the `default` or the `=` after `export`. */
export function exportAssignment(startPos: number, startFull: number, base: number): number {
  const modStart = takeModifiers(base);
  const p$ = p;
  const modLen = p$.outLen | 0;
  const lx$ = lx;
  const isExportEquals = lx$.token === T_EQUALS;
  lx$.next();
  // `parseExportAssignment` has `setAwaitContext(true)`.
  // TODO(oxc): for oxc only that of the file is in the await context.
  const saved = p$.isEcmascript ? enterContext(0, CTX_DISALLOW_IN) : enterContext(CTX_AWAIT, CTX_DISALLOW_IN);
  const e = assignmentExpression();
  p$.context = saved;
  semicolon();
  let st = 0;
  const hir$ = hir;
  if (isExportEquals) {
    hir$.rareSyntax = hir$.rareSyntax | RARE_EXPORT_ASSIGNMENT;
    st = pushStmtExportAssign(startPos, e);
  } else {
    st = pushStmtExportDefault(startPos, e);
  }
  return finishStmt(st, startFull, modStart, modLen);
}

/** `parseNamespaceExportDeclaration`, at the `as` after `export`. */
export function namespaceExportDeclaration(startPos: number, startFull: number, base: number): number {
  const modStart = takeModifiers(base);
  const p$ = p;
  const modLen = p$.outLen | 0;
  lx.next();
  expect(T_NAMESPACE);
  const saved = leaveAwaitContextOfTopLevel();
  const name = identifierOfDeclaration();
  p$.context = saved;
  semicolon();
  return finishStmt(pushStmtExportAsNamespace(startPos, name), startFull, modStart, modLen);
}
