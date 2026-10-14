// Port of vendor/bun/src/sema/parser/parser/js_syntax.rs: `checkJSSyntax`: what only TypeScript has is parsed in a JavaScript file
// too, and reported (diagnostics of kind DK_JS; the formatter refuses a JavaScript file that has them). The message arguments
// (`what`) are not kept (HIR_API.md: `Diagnostic::args` is dropped).
import {
  DK_JS,
  FLAG_ACCESSOR,
  FLAG_ASYNC,
  FLAG_DEFAULT,
  FLAG_EXPORT,
  FLAG_REPARSED,
  FLAG_STATIC,
  FLAG_ABSTRACT,
  FLAG_AMBIENT,
  FLAG_CONST,
  FLAG_IN,
  FLAG_OUT,
  FLAG_OVERRIDE,
  FLAG_PRIVATE,
  FLAG_PROTECTED,
  FLAG_PUBLIC,
  FLAG_READONLY,
  MEMBER_CONSTRUCTOR,
  MEMBER_INDEX_SIGNATURE,
  MEMBER_METHOD,
  MEMBER_PROPERTY,
  MODK_DECORATOR,
  MODK_KEYWORD,
  MODNAME_IDENT,
  PROP_METHOD,
  STMT_CLASS,
  STMT_ENUM,
  STMT_EXPORT_ASSIGN,
  STMT_EXPORT_DEFAULT,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_FN,
  STMT_IMPORT,
  STMT_IMPORT_EQUALS,
  STMT_INTERFACE,
  STMT_MODULE,
  STMT_TYPE_ALIAS,
  STMT_VAR,
  EXPR_FN,
  hir,
} from "../../hir.ts";
import { endOfExpr, fnHasBodyNode, modifierText } from "../../hir_util.ts";
import { CTX_TYPE, fail, hasFailed, flag, flagArgs, p } from "./mod.ts";

/** `modifier_text(flag).len()`: the length of the keyword of a modifier. */
export function modifierTextLen(flag_: number): number {
  switch (flag_) {
    case FLAG_ABSTRACT:
      return 8;
    case FLAG_ACCESSOR:
      return 8;
    case FLAG_ASYNC:
      return 5;
    case FLAG_CONST:
      return 5;
    case FLAG_AMBIENT:
      return 7;
    case FLAG_DEFAULT:
      return 7;
    case FLAG_EXPORT:
      return 6;
    case FLAG_IN:
      return 2;
    case FLAG_OUT:
      return 3;
    case FLAG_OVERRIDE:
      return 8;
    case FLAG_PRIVATE:
      return 7;
    case FLAG_PROTECTED:
      return 9;
    case FLAG_PUBLIC:
      return 6;
    case FLAG_READONLY:
      return 8;
    case FLAG_STATIC:
      return 6;
    default:
      return 0;
  }
}

/**
 * `jsErrorAtRange`. An end of 0: the end of the token at the start (-1: an empty range). Nothing inside a type is reported.
 */
export function jsError(start: number, end: number, code: number, what: string = ""): void {
  const p$ = p;
  if (p$.isJavascript && (p$.context & CTX_TYPE) === 0 && !p$.isFlow) {
    if (what === "") flag(DK_JS, code, start, end);
    else flagArgs(DK_JS, code, start, end, [what]);
  }
}

/** `js_error` at a type. */
export function jsErrorAtType(ty: number, code: number): void {
  jsErrorAtTypes(ty, ty, code);
}

function jsErrorAtTypes(first: number, last: number, code: number): void {
  const hir$ = hir;
  if (first >= 0 && first < hir$.nTypes && last >= 0 && last < hir$.nTypes) {
    jsError(hir$.typePos[first] | 0, hir$.typeEnd[last] | 0, code);
  }
}

/** For type arguments (the list `start`, `len` of `hir.ids`). */
export function checkJsTypeArguments(start: number, len: number): void {
  const hir$ = hir;
  if (p.isJavascript && len > 0) {
    const last = hir$.ids[(start + len - 1) | 0] | 0;
    jsErrorAtTypes(hir$.ids[start] | 0, last, 8011);
  }
}

const JAVASCRIPT_MODIFIERS = FLAG_EXPORT | FLAG_STATIC | FLAG_ACCESSOR | FLAG_ASYNC | FLAG_DEFAULT | FLAG_REPARSED;

/** The modifiers (list `start`, `len`) that are not in `ModifierFlagsJavaScript`. `checkJsDecorators`, if `decorators`. */
export function checkJsModifiers(start: number, len: number, decorators: boolean): void {
  const hir$ = hir;
  for (let i = 0; i < len; i++) {
    const m = hir$.ids[(start + i) | 0] | 0;
    if ((hir$.modifierKind[m] | 0) === MODK_KEYWORD) {
      const f = hir$.modifierValue[m] | 0;
      if ((JAVASCRIPT_MODIFIERS & f) === 0) jsError(hir$.modifierPos[m] | 0, 0, 8009, modifierText(f));
    }
  }
  if (decorators) checkJsDecorators(start, len, false);
}

/**
 * `checkJSDecoratorSyntax` for a node whose modifiers are the list (`start`, `len`): a class declaration (`isClassDeclaration`),
 * or a node for which `CanHaveIllegalDecorators` is true.
 */
export function checkJsDecorators(start: number, len: number, isClassDeclaration: boolean): void {
  // Nodes can be missing.
  if (hasFailed()) return;
  let decoratorIndex = -1;
  const hir$ = hir;
  for (let i = 0; i < len; i++) {
    const m = hir$.ids[(start + i) | 0] | 0;
    if ((hir$.modifierKind[m] | 0) === MODK_DECORATOR) {
      decoratorIndex = i;
      break;
    }
  }
  if (decoratorIndex < 0) return;
  const firstStart = hir$.modifierPos[hir$.ids[(start + decoratorIndex) | 0] | 0] | 0;
  const firstEnd = endOfExpr(hir$.modifierValue[hir$.ids[(start + decoratorIndex) | 0] | 0] | 0);
  if (!isClassDeclaration) {
    // `js_error` says nothing in Flow, whose parsers refuse this too.
    if (p.isFlow) fail();
    else jsError(firstStart, firstEnd, 1206);
    return;
  }
  const exportIndex = indexOfKeyword(start, len, FLAG_EXPORT);
  if (exportIndex < 0) return;
  const defaultIndex = indexOfKeyword(start, len, FLAG_DEFAULT);
  // the first decorator after `export`
  let trailing = -1;
  for (let i = exportIndex + 1; i < len; i++) {
    const m = hir$.ids[(start + i) | 0] | 0;
    if ((hir$.modifierKind[m] | 0) === MODK_DECORATOR) {
      trailing = i;
      break;
    }
  }
  if (decoratorIndex > exportIndex) {
    if (defaultIndex >= 0 && decoratorIndex < defaultIndex) jsError(firstStart, firstEnd, 1206);
  } else if (trailing >= 0) {
    const m = hir$.ids[(start + trailing) | 0] | 0;
    // TODO: the related diagnostic (1486 at the first decorator) is not kept.
    hir$.pushDiagnostics(DK_JS, hir$.modifierPos[m] | 0, endOfExpr(hir$.modifierValue[m] | 0), 8038, -1);
  }
}

function indexOfKeyword(start: number, len: number, flag_: number): number {
  const hir$ = hir;
  for (let i = 0; i < len; i++) {
    const m = hir$.ids[(start + i) | 0] | 0;
    if ((hir$.modifierKind[m] | 0) === MODK_KEYWORD && (hir$.modifierValue[m] | 0) === flag_) return i;
  }
  return -1;
}

/** For the declaration `id`. */
export function checkJsStatement(id: number): void {
  const hir$ = hir;
  if (hasFailed() || id < 0 || id >= hir$.nStmts) return;
  const tag = hir$.stmtTag[id] | 0;
  const modStart = hir$.stmtModStart[id] | 0;
  const modLen = hir$.stmtModLen[id] | 0;
  // TODO(oxc): `module_statements.0 += 1` for an external module indicator.
  switch (tag) {
    // `parseAmbientExternalModuleDeclaration` does not perform this check.
    case STMT_MODULE:
      if ((hir$.moduleNameKind[hir$.stmtA[id] | 0] | 0) !== MODNAME_IDENT) return;
      checkJsDecorators(modStart, modLen, false);
      break;
    case STMT_CLASS:
      checkJsDecorators(modStart, modLen, true);
      break;
    case STMT_VAR:
    case STMT_FN:
    case STMT_INTERFACE:
    case STMT_TYPE_ALIAS:
    case STMT_ENUM:
    case STMT_IMPORT_EQUALS:
    case STMT_IMPORT:
    case STMT_EXPORT_NAMED:
    case STMT_EXPORT_STAR:
    case STMT_EXPORT_DEFAULT:
    case STMT_EXPORT_ASSIGN:
      checkJsDecorators(modStart, modLen, false);
      break;
    // Nor does `parseNamespaceExportDeclaration`.
    default:
      return;
  }
  if (tag === STMT_FN || tag === STMT_VAR || tag === STMT_CLASS) checkJsModifiers(modStart, modLen, false);
  errorOfJsDeclaration(id, tag);
}

/** What is said about the declaration `id` as a whole. */
function errorOfJsDeclaration(id: number, tag: number): void {
  const hir$ = hir;
  const whole = hir$.stmtStart[id] | 0;
  const wholeEnd = hir$.stmtLocEnd[id] | 0;
  const a = hir$.stmtA[id] | 0;
  switch (tag) {
    case STMT_FN:
      if (!fnHasBodyNode(a)) jsError(whole, wholeEnd, 8017);
      break;
    case STMT_IMPORT:
      if ((hir$.importTypeOnly[a] | 0) !== 0) jsError(whole, wholeEnd, 8006, "import type");
      break;
    case STMT_EXPORT_NAMED:
      if ((hir$.exportTypeOnly[a] | 0) !== 0) jsError(whole, wholeEnd, 8006, "export type");
      break;
    case STMT_EXPORT_STAR:
      if (((hir$.stmtAux[id] | 0) & 1) !== 0) jsError(whole, wholeEnd, 8006, "export type");
      break;
    case STMT_IMPORT_EQUALS:
      jsError(whole, wholeEnd, 8002);
      break;
    case STMT_EXPORT_ASSIGN:
      jsError(whole, wholeEnd, 8003);
      break;
    case STMT_INTERFACE:
      jsError(hir$.interfaceNamePos[a] | 0, 0, 8006, "interface");
      break;
    case STMT_MODULE:
      jsError(hir$.moduleNamePos[a] | 0, 0, 8006, (hir$.moduleSpecifiesModule[a] | 0) !== 0 ? "module" : "namespace");
      break;
    case STMT_ENUM:
      jsError(hir$.enumNamePos[a] | 0, 0, 8006, "enum");
      break;
    case STMT_TYPE_ALIAS:
      jsError(hir$.aliasNamePos[a] | 0, 0, 8008);
      break;
    default:
  }
}

/** For a method or an accessor in an object literal: the prop row and its modifiers (list `modStart`, `modLen`). */
export function checkJsMethodOfObject(prop: number, modStart: number, modLen: number): void {
  if (hasFailed()) return;
  const hir$ = hir;
  const postfix = hir$.propPostfixToken[prop] | 0;
  const kind = hir$.propKind[prop] | 0;
  if (kind === PROP_METHOD && postfix !== 0 && (hir$.text[postfix] | 0) === 63 /* '?' */) jsError(postfix, 0, 8009, "?");
  const value = hir$.propValue[prop] | 0;
  if (value >= 0 && value < hir$.nExprs && (hir$.exprTag[value] | 0) === EXPR_FN) {
    const f = hir$.exprA[value] | 0;
    if (!fnHasBodyNode(f)) jsError(hir$.propStart[prop] | 0, hir$.propEnd[prop] | 0, 8017);
  }
  checkJsModifiers(modStart, modLen, false);
}

/** For a class member (a `members` row). `question`: the position of the `?` after its name, or -1. */
export function checkJsMember(member: number, question: number): void {
  if (hasFailed()) return;
  const hir$ = hir;
  const kind = hir$.memberKind[member] | 0;
  if ((kind === MEMBER_PROPERTY || kind === MEMBER_METHOD) && question >= 0) jsError(question, 0, 8009, "?");
  const f = hir$.memberFunc[member] | 0;
  if (f >= 0 && f < hir$.nFns && !fnHasBodyNode(f)) {
    jsError(hir$.memberStart[member] | 0, hir$.memberLocEnd[member] | 0, 8017);
  }
  const modStart = hir$.memberModStart[member] | 0;
  const modLen = hir$.memberModLen[member] | 0;
  if (kind === MEMBER_INDEX_SIGNATURE) {
    checkJsDecorators(modStart, modLen, false);
  } else {
    // oxc takes a decorator before a constructor.
    checkJsModifiers(modStart, modLen, kind === MEMBER_CONSTRUCTOR);
  }
}

