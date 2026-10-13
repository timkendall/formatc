// Port of vendor/bun/src/sema/parser/parser/class.rs: classes. See mod.ts for the conventions. Not ported: oxc, Flow, JSDoc,
// recovery (TODO notes).
import {
  BODY_BLOCK,
  DECO_CLASS,
  DECO_MEMBER,
  DK_GRAMMAR,
  EXPR_INSTANTIATION,
  FLAG_ABSTRACT,
  FLAG_AMBIENT,
  FLAG_ASYNC,
  FLAG_COMPUTED_NAME,
  FLAG_CONST,
  FLAG_DEFAULT,
  FLAG_EXPORT,
  FLAG_GENERATOR,
  FLAG_LITERAL_NAME,
  FLAG_OPTIONAL,
  FLAG_STATIC,
  FLAG_STRING_NAME,
  FN_CONSTRUCTOR,
  FN_GETTER,
  FN_METHOD,
  FN_SETTER,
  FN_STATIC_BLOCK,
  MEMBER_CONSTRUCTOR,
  MEMBER_GETTER,
  MEMBER_METHOD,
  MEMBER_PROPERTY,
  MEMBER_SETTER,
  MEMBER_STATIC_BLOCK,
  MODK_DECORATOR,
  MODK_KEYWORD,
  NK_COMPUTED_STRING,
  NK_IDENTIFIER,
  NK_NUMERIC_LITERAL,
  NK_STRING_LITERAL,
  NONE,
  PK_NAME,
  PK_NONE,
  PK_PRIVATE,
  RARE_NOTABLE_CLASS_MEMBER,
  RARE_SUSPENDS_IN_STATIC_BLOCK,
  hir,
  pushExprClass,
  pushStmtClass,
} from "../../hir.ts";
import { A_constructor, A_default, A_empty, A_prototype, ATOM_NONE } from "../../atom.ts";
import {
  T_ACCESSOR,
  T_AT,
  T_ASTERISK,
  T_BIG_INT,
  T_CLASS,
  T_CLOSE_BRACE,
  T_COLON,
  T_COMMA,
  T_CONSTRUCTOR,
  T_EQUALS,
  T_EXCLAMATION,
  T_EXTENDS,
  T_GET,
  T_IMPLEMENTS,
  T_LESS_THAN,
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
  T_SEMICOLON,
  T_SET,
  T_STATIC,
  T_STRING,
  isIdentifierOrKeyword,
  isModifier,
} from "../token.ts";
import {
  CTX_AMBIENT,
  CTX_AWAIT,
  CTX_CLASS_MEMBER,
  CTX_DISALLOW_IN,
  CTX_NO_RECORD,
  CTX_TOP_LEVEL,
  CTX_TYPE,
  CTX_YIELD,
  LK_CLASS_MEMBERS,
  LK_HERITAGE_CLAUSE_ELEMENT,
  LK_HERITAGE_CLAUSES,
  MODS_CLASS_MEMBER,
  MODS_DECLARATION,
  ambient,
  canParseSemicolon,
  eat,
  enterContext,
  enterDepth,
  enterList,
  error,
  expect,
  fail,
  failUnlessRecovering,
  finishStmt,
  flag,
  hasFailed,
  isBindingIdentifier,
  isInList,
  leaveDepth,
  leaveList,
  lookAheadEnd,
  lx,
  missingSemicolonAfterProperty,
  names,
  next,
  nextAfterName,
  noteIdentifier,
  p,
  peek,
  refuse,
  report,
  s,
  takeIds,
  takeList,
} from "./mod.ts";
import { isAtElement, goesOnWithoutComma, isAtHeritageClause } from "./recover.ts";
import { R_REPORTED } from "../lib.ts";
import { canFollowAccessorKeyword, isParenthesized, leftHandSideExpression, propertyName } from "./expr.ts";
import { typeParameters, functionBlock, functionRestOr } from "./func.ts";
import { checkJsMember, checkJsTypeArguments, jsError } from "./js_syntax.ts";
import { isLiteralPropertyName, modifiers, optionalInitializer, takeModifiers } from "./stmt.ts";
import {
  heritageType,
  indexSignature,
  isAtTypeArgumentsOfHeritageElement,
  isHeritageElement,
  isIndexSignature,
  typeAnnotation,
  typeArgsErrorCode,
  typeArgsErrorEnd,
  typeArgsErrorStart,
  typeArgumentsUnchecked,
} from "./ty.ts";
import { errorAtToken } from "./mod.ts";
import { noteStrayDecorators } from "./recover.ts";
import { T_IDENTIFIER, T_MINUS, T_PLUS } from "../token.ts";
import { flowRefuseDecorators, flowVariance } from "./flow.ts";
import { pushExprMissing } from "../../hir.ts";
import { LK_SOURCE_ELEMENTS } from "./mod.ts";
import { flagArgs } from "./mod.ts";

/** What the name of a member of a class says about the member. `nameToken`: its first token. */
export function flagsOfMemberName(nameToken: number, nameKind: number, keyKind: number): number {
  if (nameToken === T_BIG_INT) return FLAG_LITERAL_NAME;
  if (nameKind === NK_STRING_LITERAL) return FLAG_STRING_NAME | FLAG_LITERAL_NAME;
  if (nameKind === NK_NUMERIC_LITERAL) return FLAG_LITERAL_NAME;
  if (nameKind === NK_COMPUTED_STRING && keyKind === PK_NAME) return FLAG_STRING_NAME | FLAG_COMPUTED_NAME;
  if (nameToken === T_OPEN_BRACKET) return FLAG_COMPUTED_NAME;
  return 0;
}

/** `IsClassMemberModifier`: "it is certain that we are starting to parse class member" */
function isClassMemberModifier(token: number): boolean {
  return (
    token === T_PUBLIC ||
    token === T_PRIVATE ||
    token === T_PROTECTED ||
    token === T_READONLY ||
    token === T_OVERRIDE ||
    token === T_STATIC ||
    token === T_ACCESSOR
  );
}

/** `parseClassDeclaration` */
export function classDeclaration(startPos: number, startFull: number, base: number, flags0: number): number {
  // Only its modifiers say that `default class {}` has `default`.
  const flags = (flags0 & FLAG_EXPORT) !== 0 ? flags0 : flags0 & ~FLAG_DEFAULT;
  const classFlags = ambient() | (flags & (FLAG_ABSTRACT | FLAG_EXPORT | FLAG_DEFAULT));
  // A default export without a name is placed at `export`.
  let unnamedAt = lx.start | 0;
  let exportPos = -1;
  for (let k = s.modifiers.len - 1; k >= base; k--) {
    const m = s.modifiers.data[k] | 0;
    if ((hir.modifierKind[m] | 0) === MODK_KEYWORD && (hir.modifierValue[m] | 0) === FLAG_EXPORT) {
      exportPos = hir.modifierPos[m] | 0;
      break;
    }
  }
  if (exportPos >= 0 && (flags & FLAG_DEFAULT) !== 0) {
    unnamedAt = exportPos;
  } else if (s.modifiers.len > base) {
    const last = s.modifiers.data[s.modifiers.len - 1] | 0;
    // Any other without a name is an error, and placed at an `abstract` before the keyword.
    if ((hir.modifierKind[last] | 0) === MODK_KEYWORD && (hir.modifierValue[last] | 0) === FLAG_ABSTRACT) unnamedAt = hir.modifierPos[last] | 0;
  }
  const cls = classBody(startPos, unnamedAt, base, classFlags);
  // (`declare` is a no-op: Declared is off.)
  if (cls >= 0) {
    // In a namespace what has no name is not exported. For acorn and Babel only a default export has none. In the list of the
    // file `checkClassDeclaration` reports it.
    const cflags = hir.classFlags[cls] | 0;
    const lacksName = (hir.className[cls] | 0) < 0 && (cflags & FLAG_DEFAULT) === 0 && (p.isEcmascript || (cflags & FLAG_EXPORT) !== 0);
    if (lacksName) {
      if (p.recovers && p.lists === 1 << LK_SOURCE_ELEMENTS) {
        // `checkClassDeclaration` reports it.
      } else if (p.recovers && !p.isEcmascript) {
        hir.classFlags[cls] = cflags & ~FLAG_EXPORT;
      } else report();
    }
  }
  const modStart = cls >= 0 ? hir.classModStart[cls] | 0 : 0;
  const modLen = cls >= 0 ? hir.classModLen[cls] | 0 : 0;
  const stmt = pushStmtClass(startPos, cls);
  return finishStmt(stmt, startFull, modStart, modLen);
}

/** `parseClassExpression` */
export function classExpression(): number {
  const start = lx.start | 0;
  const base = s.modifiers.len;
  const cls = classBody(start, start, base, 0);
  // TODO(jsdoc): `class_jsdoc(class, start)`
  return pushExprClass(start, lx.fullStart, cls);
}

/** `parseDecoratedExpression` */
export function decoratedExpression(): number {
  const start = lx.start | 0;
  const base = s.modifiers.len;
  const flags = modifiers(MODS_DECLARATION);
  if (lx.token !== T_CLASS) {
    // `missing_declaration_expression`
    if (!p.recovers) {
      fail();
      return NONE;
    }
    const end = lx.fullStart | 0;
    error(1109, end, -1);
    noteStrayDecorators(base, end);
    return pushExprMissing(start, start);
  }
  const keyword = lx.start | 0;
  const cls = classBody(start, keyword, base, flags & FLAG_ABSTRACT);
  // TODO(jsdoc): `class_jsdoc(class, start)`
  return pushExprClass(keyword, lx.fullStart, cls);
}

/** `parseTypeArguments` of an element of an `extends` clause that is not the base class, at the `<`. The tree has no place for them. */
function typeArgumentsInNoList(): void {
  if (!p.recovers) {
    refuse(R_REPORTED);
    return;
  }
  // (The nodes stay in the tables, which nobody reads: a file with a syntax error is not walked.)
  const list = typeArgumentsUnchecked();
  checkJsTypeArguments(list, p.outLen | 0);
}

/** `parseHeritageClauses` of a class, with what `checkGrammarClassDeclarationHeritageClauses` reports. Results in `h*`. */
function classHeritage(): void {
  // Locals while the clauses are parsed: a class in an expression of a clause has its own.
  let lExtends = NONE;
  let lExtendsArgsStart = 0;
  let lExtendsArgsLen = 0;
  let lImplementsStart = 0;
  let lImplementsLen = 0;
  let lHasError = false;
  const otherExtendsBase = s.otherExtends.len;
  const otherImplementsBase = s.otherImplements.len;
  let hasExtends = false;
  let hasImplements = false;
  const lists = enterList(LK_HERITAGE_CLAUSES);
  let isFirst = true;
  while (isAtHeritageClause(isFirst)) {
    isFirst = false;
    const keywordStart = lx.start | 0;
    const keywordEnd = lx.end | 0;
    const isExtends = lx.token === T_EXTENDS;
    let misplaced = 0;
    if (isExtends) {
      if (hasExtends) misplaced = 1172;
      else if (hasImplements) misplaced = 1173;
    } else if (hasImplements) {
      misplaced = 1175;
    }
    if (misplaced !== 0 && !lHasError) {
      if (p.isEcmascript) report();
      else flag(DK_GRAMMAR, misplaced, keywordStart, keywordEnd);
      lHasError = true;
    }
    next();
    // `checkGrammarExpressionWithTypeArguments`, of the first element that has an error.
    let elementErrorCode = 0;
    let elementErrorStart = 0;
    let elementErrorEnd = 0;
    const base = s.ids.len;
    let count = 0;
    let hasComma = false;
    let commaStart = 0;
    let commaEnd = 0;
    // `parseDelimitedList(PCHeritageClauseElement, ..)`
    let savedContext = 0;
    if (!isExtends) savedContext = enterContext(CTX_TYPE, 0);
    const heritageLists = enterList(LK_HERITAGE_CLAUSE_ELEMENT);
    while (isAtElement(LK_HERITAGE_CLAUSE_ELEMENT)) {
      if (!p.recovers && !isHeritageElement()) break;
      const full = lx.fullStart | 0;
      const index = count;
      if (isExtends) {
        const firstTokenStart = lx.start | 0;
        const firstTokenEnd = lx.end | 0;
        // `parseExpressionWithTypeArguments`
        const saved = enterContext(CTX_NO_RECORD, 0);
        const extended = leftHandSideExpression();
        p.context = saved;
        if (index > 0 || hasExtends) {
          // Type arguments that the expression has not taken are in no list.
          if (lx.token === T_LESS_THAN) typeArgumentsInNoList();
          s.otherExtends.push(extended);
          if (index === 1 && !lHasError) {
            if (p.isEcmascript) report();
            else flag(DK_GRAMMAR, 1174, firstTokenStart, firstTokenEnd);
            lHasError = true;
          }
        } else {
          lExtends = extended;
          if (
            extended >= 0 &&
            extended + 1 === hir.nExprs &&
            (hir.exprTag[extended] | 0) === EXPR_INSTANTIATION &&
            !isParenthesized(extended)
          ) {
            lExtends = hir.exprA[extended] | 0;
            lExtendsArgsStart = hir.exprB[extended] | 0;
            lExtendsArgsLen = hir.exprC[extended] | 0;
            hir.nExprs = hir.nExprs - 1;
          } else if (isAtTypeArgumentsOfHeritageElement()) {
            lExtendsArgsStart = typeArgumentsUnchecked();
            lExtendsArgsLen = p.outLen | 0;
            if (typeArgsErrorCode() !== 0) {
              elementErrorCode = typeArgsErrorCode();
              elementErrorStart = typeArgsErrorStart();
              elementErrorEnd = typeArgsErrorEnd();
            }
          }
          checkJsTypeArguments(lExtendsArgsStart, lExtendsArgsLen);
          // TODO(recover): `import_with_type_arguments(first_token)`
        }
      } else {
        const ty = heritageType(!hasImplements, 2500);
        s.ids.push(ty);
        // TODO(recover): `import_with_type_arguments(first_token)`
      }
      count = (count + 1) | 0;
      hasComma = lx.token === T_COMMA;
      if (hasComma) {
        commaStart = lx.start | 0;
        commaEnd = lx.end | 0;
      }
      if (hasFailed() || (!eat(T_COMMA) && !goesOnWithoutComma(LK_HERITAGE_CLAUSE_ELEMENT, full))) break;
    }
    leaveList(heritageLists);
    // `isListTerminator`
    {
      const t = lx.token | 0;
      if (!(t === T_OPEN_BRACE || t === T_EXTENDS || t === T_IMPLEMENTS)) failUnlessRecovering();
    }
    if (!isExtends) {
      p.context = savedContext;
      jsError(keywordStart, lx.fullStart, 8005);
    }
    const isRefused = p.isEcmascript;
    // `checkGrammarHeritageClause`
    if (lHasError) {
      // nothing
    } else if (hasComma) {
      if (isRefused) report();
      else flag(DK_GRAMMAR, 1009, commaStart, commaEnd);
    } else if (count === 0) {
      if (isRefused) report();
      else flagArgs(DK_GRAMMAR, 1097, keywordEnd, -1, [isExtends ? "extends" : "implements"]);
    } else if (elementErrorCode !== 0) {
      flag(DK_GRAMMAR, elementErrorCode, elementErrorStart, elementErrorEnd);
    }
    if (isExtends) {
      hasExtends = true;
    } else if (!hasImplements) {
      lImplementsStart = takeIds(base);
      lImplementsLen = p.outLen | 0;
      hasImplements = true;
    } else {
      for (let k = base; k < s.ids.len; k++) s.otherImplements.push(s.ids.data[k] | 0);
      s.ids.len = base;
    }
  }
  leaveList(lists);
  p.hExtends = lExtends;
  p.hExtendsArgsStart = lExtendsArgsStart;
  p.hExtendsArgsLen = lExtendsArgsLen;
  p.hImplementsStart = lImplementsStart;
  p.hImplementsLen = lImplementsLen;
  p.hHasError = lHasError;
  p.hOtherExtendsLen = s.otherExtends.len - otherExtendsBase;
  p.hOtherExtendsStart = hir.listFrom(s.otherExtends.data, s.otherExtends.len, otherExtendsBase);
  s.otherExtends.len = otherExtendsBase;
  p.hOtherImplementsLen = s.otherImplements.len - otherImplementsBase;
  p.hOtherImplementsStart = hir.listFrom(s.otherImplements.data, s.otherImplements.len, otherImplementsBase);
  s.otherImplements.len = otherImplementsBase;
}

/** `parseClassDeclarationOrExpression`, at `class`. Its modifiers are on the stack from `base` on. */
function classBody(start: number, unnamedAt: number, base: number, flags: number): number {
  if (!enterDepth()) return NONE;
  const r = classBodyInner(start, unnamedAt, base, flags);
  leaveDepth();
  return r;
}

function classBodyInner(start: number, unnamedAt: number, base: number, flags: number): number {
  next();
  // `GetContainingClass`: its heritage clauses are inside it too.
  p.classesAround = (p.classesAround + 1) | 0;
  // `parseNameOfClassDeclarationOrExpression`
  let name = ATOM_NONE;
  let namePos = unnamedAt;
  if (isBindingIdentifier() && !isImplementsClause()) {
    name = lx.atom | 0;
    namePos = lx.start | 0;
    noteIdentifier(name, namePos);
    nextAfterName();
  }
  const lessThan = lx.token === T_LESS_THAN ? lx.start | 0 : -1;
  const typeParamsStart = typeParameters();
  const typeParamsLen = p.outLen | 0;
  // (The name of a class expression is in one scope with its type parameters: `may_redeclare` is a no-op.)
  let emptyListStart = -1;
  let emptyListEnd = 0;
  if (lessThan >= 0 && typeParamsLen === 0) {
    emptyListStart = lessThan;
    emptyListEnd = lx.fullStart | 0;
  }
  classHeritage();
  const extendsExpr = p.hExtends;
  const extendsArgsStart = p.hExtendsArgsStart;
  const extendsArgsLen = p.hExtendsArgsLen;
  const otherExtendsStart = p.hOtherExtendsStart;
  const otherExtendsLen = p.hOtherExtendsLen;
  const implementsStart = p.hImplementsStart;
  const implementsLen = p.hImplementsLen;
  const otherImplementsStart = p.hOtherImplementsStart;
  const otherImplementsLen = p.hOtherImplementsLen;
  // `checkGrammarClassLikeDeclaration`, which looks at the clauses first. The checker finds the empty list of anything else in
  // the text.
  if (emptyListStart >= 0 && !p.hHasError) flag(DK_GRAMMAR, 1098, emptyListStart, emptyListEnd);
  // What is scanned from here to the `}` is in the class. What it extends and its decorators are not.
  const scannedPrivate = lx.privateNames.len | 0;
  const declaredPrivate = p.declaredPrivateNames.len | 0;
  const hasMembers = expect(T_OPEN_BRACE);
  const members = s.members.len;
  const decorators = s.decorators.len;
  const lists = enterList(LK_CLASS_MEMBERS);
  while (hasMembers && isInList(T_CLOSE_BRACE) && isAtElement(LK_CLASS_MEMBERS)) {
    // A `SemicolonClassElement` is not a member.
    if (eat(T_SEMICOLON)) {
      // TODO(jsdoc): semicolon_jsdoc
      continue;
    }
    classElement(members);
  }
  leaveList(lists);
  if ((lx.privateNames.len | 0) > scannedPrivate) resolvePrivateNames(scannedPrivate, declaredPrivate);
  if (hasMembers) expect(T_CLOSE_BRACE);
  p.classesAround = (p.classesAround - 1) | 0;
  // TODO(oxc): `has_odd_members`
  const membersStart = takeList(s.members, members);
  const membersLen = p.outLen | 0;
  const dec = s.decorators;
  for (let k = decorators; k < dec.len; k += 2) {
    const index = dec.data[k] | 0;
    const owner = hir.ids[(membersStart + index) | 0] | 0;
    hir.pushDecorator(DECO_MEMBER, owner, dec.data[k + 1] | 0);
  }
  dec.len = decorators;
  for (let k = base; k < s.modifiers.len; k++) {
    const m = s.modifiers.data[k] | 0;
    if ((hir.modifierKind[m] | 0) === MODK_DECORATOR) {
      hir.pushDecorator(DECO_CLASS, hir.nClasses, hir.modifierValue[m] | 0);
    }
  }
  const modStart = takeModifiers(base);
  const modLen = p.outLen | 0;
  return hir.pushClass(
    name,
    namePos,
    flags,
    typeParamsStart,
    typeParamsLen,
    extendsExpr,
    extendsArgsStart,
    extendsArgsLen,
    otherExtendsStart,
    otherExtendsLen,
    implementsStart,
    implementsLen,
    otherImplementsStart,
    otherImplementsLen,
    membersStart,
    membersLen,
    start,
    modStart,
    modLen,
  );
}

/** `isImplementsClause` */
function isImplementsClause(): boolean {
  return lx.token === T_IMPLEMENTS && isIdentifierOrKeyword(peek());
}

/**
 * `scanClassMemberStart`, at a modifier: whether the list of members goes on with the token. (Inside a lookahead.)
 */
function scanClassMemberStart(): boolean {
  let last = 0; // T_EOF
  // "Eat up all modifiers, but hold on to the last one in case it is actually an identifier."
  while (isModifier(lx.token)) {
    last = lx.token | 0;
    if (isClassMemberModifier(last)) return true;
    next();
  }
  // In Flow: the variance of a property.
  if (lx.token === T_ASTERISK || ((lx.token === T_PLUS || lx.token === T_MINUS) && p.isFlow)) return true;
  if (isLiteralPropertyName()) {
    last = lx.token | 0;
    next();
  }
  if (lx.token === T_OPEN_BRACKET) return true;
  // "If we have a non-keyword identifier, or if we have an accessor, then it's safe to parse."
  if (last <= T_PRIVATE_IDENTIFIER || last === T_GET || last === T_SET) return true;
  const t = lx.token | 0;
  return (
    t === T_OPEN_PAREN ||
    t === T_LESS_THAN ||
    t === T_EXCLAMATION ||
    t === T_COLON ||
    t === T_EQUALS ||
    t === T_QUESTION ||
    canParseSemicolon()
  );
}

/**
 * `tryParseConstructorDeclaration` takes the keyword whatever follows it. `name`: the first token of the name of a member that no
 * parameters follow.
 */
function isConstructorWithoutParameters(name: number): boolean {
  if (p.recovers) return name === T_CONSTRUCTOR;
  report();
  return false;
}

/**
 * At the `}` of a class, for `rare::ODD_PRIVATE_NAME`: the private names that were scanned in it and that it declares are
 * forgotten. The others are left to the class around it. `scanned`, `declared`: how many there were at its `{`.
 */
function resolvePrivateNames(scanned: number, declared: number): void {
  const own = p.declaredPrivateNames;
  const pn = lx.privateNames;
  let w = scanned;
  for (let r = scanned; r < pn.len; r++) {
    const a = pn.data[r] | 0;
    let found = false;
    for (let k = declared; k < own.len; k++) {
      if ((own.data[k] | 0) === a) {
        found = true;
        break;
      }
    }
    if (!found) {
      pn.data[w] = a;
      w = (w + 1) | 0;
    }
  }
  pn.len = w;
  own.len = declared;
}

/** `parseClassElement`: pushes it on the stack of members, of which the class's start at `base`. */
function classElement(base: number): void {
  const startPos = lx.start | 0;
  const startFull = lx.fullStart | 0;
  const firstModifier = s.modifiers.len;
  const token = lx.token | 0;
  if (isModifier(token) && !isClassMemberModifier(token)) {
    const m = lx.mark();
    const had = lx.refusal | 0;
    const ok = scanClassMemberStart();
    lookAheadEnd(m, had);
    if (!ok) fail();
  }
  let flags = 0;
  if (isModifier(token) || token === T_AT) flags = modifiers(MODS_CLASS_MEMBER);
  const index = s.members.len - base;
  for (let k = firstModifier; k < s.modifiers.len; k++) {
    const m = s.modifiers.data[k] | 0;
    if ((hir.modifierKind[m] | 0) === MODK_DECORATOR) {
      s.decorators.push(index);
      s.decorators.push(hir.modifierValue[m] | 0);
    }
  }
  if (lx.token === T_STATIC && peek() === T_OPEN_BRACE) {
    classStaticBlock(startPos, startFull, firstModifier);
    return;
  }
  const isParentAmbient = (p.context & CTX_AMBIENT) !== 0;
  let kind = MEMBER_PROPERTY;
  if (lx.token === T_GET || lx.token === T_SET) {
    // `parseContextualModifier`
    const accessor = lx.token | 0;
    const m = lx.mark();
    next();
    if (canFollowAccessorKeyword()) {
      lx.release(m);
      kind = accessor === T_GET ? MEMBER_GETTER : MEMBER_SETTER;
    } else {
      lx.reset(m);
    }
  }
  if (kind === MEMBER_PROPERTY && lx.token === T_OPEN_BRACKET && isIndexSignature()) {
    // It is placed after its decorators.
    let namePos = lx.start | 0;
    for (let k = firstModifier; k < s.modifiers.len; k++) {
      const m = s.modifiers.data[k] | 0;
      if ((hir.modifierKind[m] | 0) === MODK_KEYWORD) {
        namePos = hir.modifierPos[m] | 0;
        break;
      }
    }
    const modStart = takeModifiers(firstModifier);
    const modLen = p.outLen | 0;
    // TODO(oxc): `oxc::index_signature`
    const member = indexSignature(startPos, startFull, flags, modStart, modLen);
    hir.memberNamePos[member] = namePos;
    if (isParentAmbient) {
      hir.memberFlags[member] = (hir.memberFlags[member] | 0) | FLAG_AMBIENT;
      const f = hir.memberFunc[member] | 0;
      hir.fnFlags[f] = (hir.fnFlags[f] | 0) | FLAG_AMBIENT;
    }
    if (p.isJavascript) checkJsMember(member, -1);
    s.members.push(member);
    return;
  }
  const isDefault = (flags & FLAG_DEFAULT) !== 0;
  // The checker reports these, which are in the list.
  flags = flags & ~(FLAG_CONST | FLAG_EXPORT | FLAG_DEFAULT);
  // `parseClassElement`: its own `declare` makes a property or a method ambient.
  const saved = p.context | 0;
  if ((flags & FLAG_AMBIENT) !== 0 && kind === MEMBER_PROPERTY) p.context = p.context | CTX_AMBIENT;
  flags = flags | ambient();
  const isGenerator = kind === MEMBER_PROPERTY && eat(T_ASTERISK);
  if ((lx.token === T_PLUS || lx.token === T_MINUS) && p.isFlow) flowVariance();
  const nameToken = lx.token | 0;
  const nameEnd = lx.end | 0;
  // `tryParseConstructorDeclaration` leaves the keyword with `nextToken`.
  if (nameToken === T_CONSTRUCTOR && lx.hasEscape && p.recovers && kind === MEMBER_PROPERTY && !isGenerator) errorAtToken(1260);
  const hasName = kind !== MEMBER_PROPERTY || isGenerator || nameToken === T_OPEN_BRACKET || isLiteralPropertyName();
  let keyKind: number;
  let keyVal: number;
  let nameKind: number;
  let namePos: number;
  if (hasName) {
    propertyName();
    keyKind = p.keyKind | 0;
    keyVal = p.keyVal | 0;
    nameKind = p.nameKind | 0;
    namePos = p.namePos | 0;
  } else {
    // "treat this as a property declaration with a missing name."
    error(1146, lx.fullStart, -1);
    keyKind = PK_NAME;
    keyVal = A_empty;
    nameKind = NK_IDENTIFIER;
    namePos = lx.fullStart | 0;
  }
  // To oxc `static constructor` is a name like any other.
  const isKeyword = nameToken === T_CONSTRUCTOR;
  // `declared_key`: a bigint name declares nothing; `declareSymbolEx`: `isDefaultExport && parent != nil`.
  if (nameToken === T_BIG_INT) {
    keyKind = PK_NONE;
    keyVal = NONE;
  } else if (keyKind === PK_NAME && isDefault) {
    keyVal = A_default;
  }
  flags = flags | flagsOfMemberName(nameToken, nameKind, keyKind);
  // Neither `tryParseConstructorDeclaration` nor the property without a name looks for it.
  let question = -1;
  if (lx.token === T_QUESTION && hasName && !(p.recovers && isKeyword && kind === MEMBER_PROPERTY && !isGenerator)) {
    question = lx.start | 0;
    next();
    flags = flags | FLAG_OPTIONAL;
  }
  let mKind = kind;
  let mFlags = flags;
  let mTy = NONE;
  let mInit = NONE;
  let mFunc = NONE;
  // What has no name is a property, whatever follows.
  let isFunction =
    hasName && (kind !== MEMBER_PROPERTY || isGenerator || lx.token === T_OPEN_PAREN || lx.token === T_LESS_THAN);
  // The checker reports the `async` of `async a!`.
  if (!isFunction && (isKeyword || ((flags & FLAG_ASYNC) !== 0 && lx.token === T_EXCLAMATION))) {
    isFunction = isConstructorWithoutParameters(nameToken);
  }
  if (isFunction) {
    // `tryParseConstructorDeclaration`: the keyword, or a string literal with the same text. After `*` it is the name of a method.
    const keyIsConstructor = keyKind === PK_NAME && keyVal === A_constructor;
    const isConstructor =
      kind === MEMBER_PROPERTY &&
      !isGenerator &&
      keyIsConstructor &&
      (nameToken === T_CONSTRUCTOR || (nameToken === T_STRING && lx.token === T_OPEN_PAREN && question < 0));
    // The parameters follow the keyword.
    if (isConstructor && question >= 0) fail();
    let fnKind: number;
    if (kind === MEMBER_GETTER) {
      fnKind = FN_GETTER;
    } else if (kind === MEMBER_SETTER) {
      fnKind = FN_SETTER;
    } else if (isConstructor) {
      mKind = MEMBER_CONSTRUCTOR;
      fnKind = FN_CONSTRUCTOR;
    } else {
      mKind = MEMBER_METHOD;
      fnKind = FN_METHOD;
    }
    // `parseClassElement`: `declare` does not make an accessor or a constructor ambient.
    if (mKind !== MEMBER_METHOD) {
      p.context = saved;
      mFlags = isParentAmbient ? mFlags | FLAG_AMBIENT : mFlags & ~FLAG_AMBIENT;
      // Only its modifiers say that `async constructor() {}` is async.
      mFlags = mFlags & ~FLAG_ASYNC;
    }
    let fnFlags = mFlags;
    if (isGenerator) fnFlags = fnFlags | FLAG_GENERATOR;
    const fnName = keyKind === PK_NAME || keyKind === PK_PRIVATE ? keyVal : ATOM_NONE;
    // "'{' or ';' expected."
    const code = fnKind === FN_METHOD || fnKind === FN_CONSTRUCTOR ? 1144 : 1005;
    p.context = p.context | CTX_CLASS_MEMBER;
    mFunc = functionRestOr(code, fnKind, fnFlags, fnName, namePos, startPos);
  } else {
    // `parsePropertyDeclaration`
    if (lx.token === T_EXCLAMATION) {
      const isDefinite = question < 0 ? !lx.newlineBefore : false; // TODO(oxc): optional_and_definite
      if (isDefinite) {
        next();
        mFlags = mFlags | 65536; // FLAG_DEFINITE
      }
    }
    mTy = typeAnnotation();
    const cleared = CTX_YIELD | CTX_AWAIT | CTX_DISALLOW_IN | CTX_TOP_LEVEL;
    const inner = enterContext(0, cleared);
    mInit = optionalInitializer();
    p.context = inner;
    // `parseSemicolonAfterPropertyName`
    if ((lx.token === T_OPEN_PAREN && p.recovers) || (!eat(T_SEMICOLON) && !canParseSemicolon())) {
      const isName = nameToken >= T_IDENTIFIER && nameToken !== T_PRIVATE_IDENTIFIER && keyKind === PK_NAME;
      missingSemicolonAfterProperty(isName ? keyVal : ATOM_NONE, namePos, nameEnd, mTy >= 0, mInit >= 0);
    }
  }
  p.context = saved;
  const locEnd = lx.fullStart | 0;
  // TODO(jsdoc): `member_jsdoc`
  const modStart = takeModifiers(firstModifier);
  const modLen = p.outLen | 0;
  // TODO(oxc): `check_class_member_like_oxc`, `type_parameters_of_quoted_constructor`
  const member = hir.pushMember(mKind, keyKind, keyVal, mFlags, mTy, mInit, mFunc, namePos, startPos, startFull, locEnd, modStart, modLen);
  if (p.isJavascript) checkJsMember(member, question);
  let isNotable = false;
  if (mKind === MEMBER_CONSTRUCTOR) {
    if ((flags & FLAG_ASYNC) !== 0) {
      isNotable = true;
    } else {
      for (let k = base; k < s.members.len; k++) {
        if ((hir.memberKind[s.members.data[k] | 0] | 0) === MEMBER_CONSTRUCTOR) {
          isNotable = true;
          break;
        }
      }
    }
  } else if (keyKind === PK_PRIVATE) {
    p.declaredPrivateNames.push(keyVal);
    for (let k = base; k < s.members.len; k++) {
      const other = s.members.data[k] | 0;
      if ((hir.memberKeyKind[other] | 0) === PK_PRIVATE && (hir.memberKeyVal[other] | 0) === keyVal) {
        isNotable = true;
        break;
      }
    }
    if (!isNotable) isNotable = names.atomIs(keyVal, "#constructor");
  } else if (keyKind === PK_NAME) {
    isNotable = keyVal === A_constructor || keyVal === A_prototype;
  }
  if (isNotable) hir.rareSyntax = hir.rareSyntax | RARE_NOTABLE_CLASS_MEMBER;
  s.members.push(member);
}

/** `parseClassStaticBlockDeclaration`, at `static`. */
function classStaticBlock(startPos: number, startFull: number, firstModifier: number): void {
  if (p.isFlow) flowRefuseDecorators(firstModifier);
  // The checker reports them.
  const modStart = takeModifiers(firstModifier);
  const modLen = p.outLen | 0;
  next();
  const open = lx.start | 0;
  // `parseClassStaticBlockBody`
  const suspensions = p.suspensions;
  const body = functionBlock(CTX_AWAIT);
  const bodyLen = p.outLen | 0;
  if (p.suspensions !== suspensions) hir.rareSyntax = hir.rareSyntax | RARE_SUSPENDS_IN_STATIC_BLOCK;
  const func = hir.pushFn(FN_STATIC_BLOCK, FLAG_STATIC, ATOM_NONE, open, 0, 0, 0, 0, NONE, NONE, BODY_BLOCK, body, bodyLen, open, startPos);
  // TODO(jsdoc): `static_block_jsdoc(start)`
  const member = hir.pushMember(MEMBER_STATIC_BLOCK, PK_NONE, NONE, FLAG_STATIC, NONE, NONE, func, open, startPos, startFull, lx.fullStart, modStart, modLen);
  s.members.push(member);
}

