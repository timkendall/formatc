// Port of vendor/bun/src/format/js/print/export_declarations.rs.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { EMPTY_BRACES, LBRACE, RBRACE, SPACE_TOKEN, STAR } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  FLAG_AMBIENT,
  FLAG_EXPORT,
  SP,
  STMT_CLASS,
  STMT_EXPORT_ASSIGN,
  STMT_EXPORT_STAR,
  STMT_IMPORT,
  STMT_VAR,
  classModifiersLen,
  classModifiersStart,
  exportHasFrom,
  exportIsTypeOnly,
  exportItemsLen,
  exportItemsStart,
  exportSpecExported,
  exportSpecExportedPos,
  exportSpecIsRenamed,
  exportSpecIsTypeOnly,
  exportSpecLocal,
  exportSpecLocalPos,
  exportSpecSpan,
  exprOuterEnd,
  fileIsFlow,
  fileIsJavascript,
  identEndOf,
  listAt,
  modifierDecorator,
  modifierFlagOf,
  stmtClassClass,
  stmtExportStarAlias,
  stmtExportStarAliasPos,
  stmtExportStarFlags,
  stmtIsDefaultExport,
  stmtModifiersLen,
  stmtModifiersStart,
  stmtModuleSpecifierSpan,
  stmtSpan,
  stmtTag,
} from "../../../lint/ast/index.ts";
import {
  AN_DECORATOR,
  AN_EXPORT_ALL_DECLARATION,
  AN_EXPORT_DEFAULT_DECLARATION,
  AN_EXPORT_NAMED_DECLARATION,
  AN_EXPORT_SPECIFIER,
  anSpan,
  mkAn,
  stmtAsAstNodes,
} from "../ast_nodes.ts";
import { enterNode, extendNode } from "../../cursor_region.ts";
import { cxOf } from "../context.ts";
import { fmtDeclaration, fmtExpr, writeTrailingCommentsOf, fmtExportSpec } from "../format.ts";
import {
  DANGLING_NONE,
  formatDanglingCommentsRange,
  formatLeadingComments,
  formatLeadingCommentsRange,
  formatTrailingComments,
  formatTrailingCommentsRange,
} from "../trivia.ts";
import { fmtDecorators } from "./decorators.ts";
import { isDeclareExport } from "./flow.ts";
import {
  formatImportAndExportSourceWithClause,
  fmtCommentsInSpecifier,
  moduleExportName,
  onlySpecifierHasComments,
  writeSpecifiers,
} from "./import_declaration.ts";
import { optionalSemicolon, startOfCommentsInDroppedParentheses } from "./semicolon.ts";

const KW_EXPORT = token("export");
const KW_EXPORT_DEFAULT = token("export default");
const KW_DECLARE_EXPORT = token("declare export");
const KW_DECLARE_EXPORT_DEFAULT = token("declare export default");
const KW_DECLARE_SPACE = token("declare ");
const KW_TYPE_SPACE = token("type ");
const KW_FROM = token("from");
const KW_AS = token("as");

/**
 * `export` or `export default`, and the decorators of the class after it. They can be before the `export` or after it, and stay where they
 * are. `keyword` is a token, or -1 if it is not written. `node`: an `AstNodes`.
 */
function formatExportKeywordWithClassDecorators(node: number, keyword: number, cls: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  anSpan(node);
  const start = SP[0] | 0;
  const end = SP[1] | 0;

  let firstDecorator = -1;
  let modsStart = 0;
  let modsLen = 0;
  if (cls >= 0) {
    modsStart = classModifiersStart(cls);
    modsLen = classModifiersLen(cls);
    for (let i = 0; i < modsLen; i++) {
      const d = modifierDecorator(listAt(modsStart, i));
      if (d >= 0) {
        firstDecorator = d;
        break;
      }
    }
  }

  if (firstDecorator >= 0) {
    anSpan(mkAn(AN_DECORATOR, firstDecorator));
    const decoratorStart = SP[0] | 0;
    const decoratorEnd = SP[1] | 0;
    if (decoratorEnd < start) {
      enterNode(start, end, f);
      fmtDecorators(modsStart, modsLen, node, f);
      f.hardLineBreak();
      cm.commentsBefore(start);
      formatLeadingCommentsRange(cm.from, cm.to, f);
      if (keyword >= 0) {
        f.token(keyword);
        f.space();
      }
    } else if (ignoredClassStaysBehindExport(f) && cm.isSuppressed(decoratorStart)) {
      // The class is written as it is, with its decorators.
      cm.commentsBefore(start);
      formatLeadingCommentsRange(cm.from, cm.to, f);
      enterNode(start, end, f);
      if (keyword >= 0) {
        f.token(keyword);
        f.space();
      }
    } else {
      cm.commentsBefore(start);
      formatLeadingCommentsRange(cm.from, cm.to, f);
      enterNode(start, end, f);
      if (keyword >= 0) f.token(keyword);
      f.hardLineBreak();
      fmtDecorators(modsStart, modsLen, node, f);
      f.hardLineBreak();
    }
  } else {
    cm.commentsBefore(start);
    formatLeadingCommentsRange(cm.from, cm.to, f);
    enterNode(start, end, f);
    if (keyword >= 0) {
      f.token(keyword);
      f.space();
    }
  }
}

/**
 * Prettier writes a class that is not formatted behind `export `, with the comment in between. For oxfmt the decorators start a line as they
 * always do after `export`.
 */
function ignoredClassStaysBehindExport(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/** `export` or `export default` and the declaration `statement`. */
export function writeExportedDeclaration(statement: number, f: Formatter): void {
  const node = stmtAsAstNodes(statement);
  const tag = stmtTag(statement);
  const cls = tag === STMT_CLASS ? stmtClassClass(statement) : -1;
  // The first modifier that is not a decorator.
  let firstModifierFlag = -1;
  const ms = stmtModifiersStart(statement);
  const ml = stmtModifiersLen(statement);
  for (let i = 0; i < ml; i++) {
    const m = listAt(ms, i);
    if (modifierDecorator(m) < 0) {
      firstModifierFlag = modifierFlagOf(m);
      break;
    }
  }
  let keyword = KW_EXPORT;
  // Errors, where the `export` is not in typescript-estree's tree: `export import a from "b"`, `export export = a`, `declare export const a`.
  if (tag === STMT_IMPORT || tag === STMT_EXPORT_ASSIGN) keyword = -1;
  else if (fileIsFlow() && isDeclareExport(statement, f)) keyword = stmtIsDefaultExport(statement) ? KW_DECLARE_EXPORT_DEFAULT : KW_DECLARE_EXPORT;
  else if (firstModifierFlag >= 0 && firstModifierFlag !== FLAG_EXPORT) keyword = -1;
  else if (stmtIsDefaultExport(statement)) keyword = KW_EXPORT_DEFAULT;
  formatExportKeywordWithClassDecorators(node, keyword, cls, f);
  fmtDeclaration(statement, f);
  if (tag === STMT_VAR) optionalSemicolon(f);
  anSpan(node);
  extendNode(SP[0] | 0, SP[1] | 0, f);
  writeTrailingCommentsOf(node, f);
}

/**
 * `export default a /* comment *&#47;;` is `export default a; /* comment *&#47;` for oxfmt, as after any other statement. Prettier leaves it.
 */
function commentsBeforeSemicolonOfDefaultExportGoBehindIt(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `export default e` */
export function writeExportDefaultExpression(statement: number, expression: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const node = mkAn(AN_EXPORT_DEFAULT_DECLARATION, statement);
  formatExportKeywordWithClassDecorators(node, KW_EXPORT_DEFAULT, -1, f);
  if (commentsBeforeSemicolonOfDefaultExportGoBehindIt(f) && !cx.isQuiet) {
    let hiddenFrom = startOfCommentsInDroppedParentheses(expression, 0, f);
    if (hiddenFrom < 0) hiddenFrom = exprOuterEnd(expression);
    const previous = cm.hideCommentsFrom(hiddenFrom);
    fmtExpr(expression, f);
    optionalSemicolon(f);
    cm.restoreHiddenComments(previous);
    // One on a line of its own leads the next statement.
    stmtSpan(statement);
    cm.commentsBefore(SP[1] | 0);
    const from = cm.from;
    const to = cm.to;
    let count = 0;
    while (from + count < to && !cm.precededByNewline((from + count) | 0)) count = (count + 1) | 0;
    formatTrailingCommentsRange(from, (from + count) | 0, f);
  } else {
    fmtExpr(expression, f);
    optionalSemicolon(f);
  }
  anSpan(node);
  extendNode(SP[0] | 0, SP[1] | 0, f);
  writeTrailingCommentsOf(node, f);
}

/** Flow's `declare export { a }`. Not `export export { a }`, of which TypeScript's parser makes `export { a }`. */
function isDeclared(statement: number): boolean {
  const ms = stmtModifiersStart(statement);
  const ml = stmtModifiersLen(statement);
  for (let i = 0; i < ml; i++) {
    if (modifierFlagOf(listAt(ms, i)) === FLAG_AMBIENT) return true;
  }
  return false;
}

/** `export * from "a"`, `export * as a from "a"` */
export function writeExportAllDeclaration(statement: number, f: Formatter): void {
  if (stmtTag(statement) !== STMT_EXPORT_STAR) return;
  const cx = cxOf(f);
  const cm = cx.comments;
  const alias = stmtExportStarAlias(statement);
  const typeOnly = (stmtExportStarFlags(statement) & 1) !== 0;
  if (isDeclared(statement)) f.token(KW_DECLARE_SPACE);
  f.token(KW_EXPORT);
  f.space();
  if (typeOnly) f.token(KW_TYPE_SPACE);
  if (alias < 0) {
    f.token(STAR);
    f.space();
    f.token(KW_FROM);
    f.space();
    formatImportAndExportSourceWithClause(statement, f);
    optionalSemicolon(f);
    return;
  }
  const aliasPos = stmtExportStarAliasPos(statement);
  const parent = mkAn(AN_EXPORT_ALL_DECLARATION, statement);
  if (cx.isQuiet) {
    f.token(STAR);
    f.space();
    f.token(KW_AS);
    f.space();
    moduleExportName(alias, aliasPos, parent, f);
    f.space();
  } else {
    stmtSpan(statement);
    const statementStart = SP[0] | 0;
    const statementEnd = SP[1] | 0;
    // To Babel `* as a` is a specifier, which the comments before it lead. To TypeScript there is only the name.
    if (fileIsJavascript()) {
      cm.commentsBeforeCharacter(statementStart, 42 /* * */);
      formatLeadingCommentsRange(cm.from, cm.to, f);
    }
    f.token(STAR);
    f.space();
    f.token(KW_AS);
    f.space();
    const nameStart = aliasPos;
    const nameEnd = identEndOf(alias, aliasPos);
    const previousLimit = cm.limitCommentsUpTo(nameEnd);
    moduleExportName(alias, aliasPos, parent, f);
    cm.restoreViewLimit(previousLimit);
    const sourceStart = stmtModuleSpecifierSpan(statement) ? SP[0] | 0 : 0;
    formatTrailingComments(statementStart, statementEnd, nameStart, nameEnd, sourceStart, f);
    f.space();
  }
  f.token(KW_FROM);
  f.space();
  formatImportAndExportSourceWithClause(statement, f);
  optionalSemicolon(f);
}

/** `export { a, b as c }`, `export { a } from "a"` */
export function writeExportNamedDeclaration(statement: number, exp: number, f: Formatter): void {
  const cx = cxOf(f);
  stmtSpan(statement);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const itemsStart = exportItemsStart(exp);
  const itemsLen = exportItemsLen(exp);
  const typeOnly = exportIsTypeOnly(exp);

  formatLeadingComments(start, end, f);
  if (isDeclared(statement)) f.token(KW_DECLARE_SPACE);
  f.token(KW_EXPORT);
  f.space();

  const needsSpace = f.options.bracketSpacing;
  if (itemsLen === 0) {
    // The comments in an export of nothing go after the keyword.
    if (!exportHasFrom(exp) && !cx.isQuiet) {
      const cm = cx.comments;
      const n = cm.commentsBeforeCharacter(start, 125 /* } */);
      if (n > 0) {
        const from = cm.from;
        const to = cm.to;
        formatDanglingCommentsRange(from, to, DANGLING_NONE, f);
        if (cm.isLine((to - 1) | 0)) f.hardLineBreak();
        f.token(SPACE_TOKEN);
      }
    }
    if (typeOnly) f.token(KW_TYPE_SPACE);
    f.token(EMPTY_BRACES);
    writeExportSource(statement, exp, f);
    return;
  }
  const first = listAt(itemsStart, 0);
  let single = false;
  if (itemsLen === 1) {
    exportSpecSpan(first);
    single = !onlySpecifierHasComments(statement, SP[0] | 0, SP[1] | 0, f);
  }
  if (typeOnly) f.token(KW_TYPE_SPACE);
  if (single) {
    f.token(LBRACE);
    f.maybeSpace(needsSpace);
    fmtExportSpec(first, f);
    f.maybeSpace(needsSpace);
    f.token(RBRACE);
  } else {
    f.token(LBRACE);
    writeSpecifiers(statement, itemsStart, itemsLen, true, f);
    f.token(RBRACE);
  }
  writeExportSource(statement, exp, f);
}

/** What is after the `}` of `export {}`. */
function writeExportSource(statement: number, exp: number, f: Formatter): void {
  if (exportHasFrom(exp)) {
    f.space();
    f.token(KW_FROM);
    f.space();
    formatImportAndExportSourceWithClause(statement, f);
  }
  optionalSemicolon(f);
  writeTrailingCommentsOf(mkAn(AN_EXPORT_NAMED_DECLARATION, statement), f);
}

/** `a`, `a as b`, `type a` */
export function writeExportSpecifier(specifier: number, f: Formatter): void {
  const node = mkAn(AN_EXPORT_SPECIFIER, specifier);
  exportSpecSpan(specifier);
  fmtCommentsInSpecifier(SP[1] | 0, f);
  if (exportSpecIsTypeOnly(specifier)) f.token(KW_TYPE_SPACE);
  if (exportSpecIsRenamed(specifier)) {
    moduleExportName(exportSpecLocal(specifier), exportSpecLocalPos(specifier), node, f);
    f.space();
    f.token(KW_AS);
    f.space();
  }
  moduleExportName(exportSpecExported(specifier), exportSpecExportedPos(specifier), node, f);
}
