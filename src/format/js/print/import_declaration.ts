// Port of vendor/bun/src/format/js/print/import_declaration.rs.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { COMMA, LBRACE, RBRACE, EMPTY_BRACES, STAR, COLON } from "../../ir/tokens.ts";
import {
  FLAVOR_OXFMT,
  FTC_ES5,
  QUOTE_PROPS_CONSISTENT,
  TRAILING_SEPARATOR_ALLOWED,
  TRAILING_SEPARATOR_MANDATORY,
  trailingSeparator,
} from "../../options.ts";
import {
  EXPR_STRING,
  KEY_STRING,
  SP,
  exprTag,
  exprSpan,
  exportSpecSpan,
  identIsString,
  identSpan,
  importAttributesBracesSpan,
  importAttributesEntriesLen,
  importAttributesEntriesStart,
  importAttributesKeywordSpan,
  importClauseSpan,
  importDefault,
  importDefaultPos,
  importHasNamedImports,
  importIsSideEffect,
  importIsTypeOnly,
  importNamedLen,
  importNamedStart,
  importNamespace,
  importNamespacePos,
  importNamespaceSpan,
  importPhase,
  importSpecImported,
  importSpecImportedPos,
  importSpecIsRenamed,
  importSpecIsTypeOnly,
  importSpecLocal,
  importSpecLocalPos,
  importSpecSpan,
  keyIs,
  keyKind,
  keySpan,
  listAt,
  nodeOfProp,
  propSpan,
  propValue,
  stmtImportAttributes,
  stmtModuleSpecifierSpan,
  stmtSpan,
} from "../../../lint/ast/index.ts";
import { AN_IMPORT_DECLARATION, AN_IMPORT_SPECIFIER, AN_OBJECT_PROPERTY, mkAn, stmtAsAstNodes } from "../ast_nodes.ts";
import { linesBefore } from "../builders.ts";
import { cxOf } from "../context.ts";
import {
  PK_PARENT,
  enterScope,
  fmtExportSpec,
  fmtExpr,
  fmtImportSpec,
  identifier,
  leaveScope,
  writeTrailingCommentsIn,
} from "../format.ts";
import { formatLeadingComments, formatLeadingCommentsRange, formatTrailingComments, formatTrailingCommentsRange } from "../trivia.ts";
import { fmtKey } from "../utils/object.ts";
import { fmtLiteralStringToken, isNameWithoutQuotes, STRING_LITERAL_PARENT_KIND_EXPRESSION, STRING_LITERAL_PARENT_KIND_IMPORT_ATTRIBUTE } from "../utils/string.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { isNextLineEmpty } from "./program.ts";
import { optionalSemicolon } from "./semicolon.ts";

const KW_IMPORT = token("import ");
const KW_DEFER = token("defer");
const KW_SOURCE = token("source");
const KW_FROM = token(" from ");
const KW_AS = token("as");
const KW_TYPE = token("type ");
const KW_TYPEOF = token("typeof ");

/** `typeof ` or `type `: how the import, or the specifier, that starts at `start` after its `import` is written. */
export function importKindToken(start: number, f: Formatter): number {
  const text = cxOf(f).src.text;
  if (
    start >= 0 &&
    start + 6 <= text.length &&
    (text[start] | 0) === 116 &&
    (text[start + 1] | 0) === 121 &&
    (text[start + 2] | 0) === 112 &&
    (text[start + 3] | 0) === 101 &&
    (text[start + 4] | 0) === 111 &&
    (text[start + 5] | 0) === 102
  ) {
    return KW_TYPEOF;
  }
  return KW_TYPE;
}

/**
 * `FormatStringLiteral { span, parent }`: a string literal that is not an expression here: a module specifier. `parent`: an `AstNodes`.
 * `format_node(span, || parent, f, |f| FormatLiteralStringToken::new(string, false, Expression))`.
 */
export function fmtStringLiteral(start: number, end: number, parent: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    fmtLiteralStringToken(start, end, false, STRING_LITERAL_PARENT_KIND_EXPRESSION, f);
    return;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    fmtLiteralStringToken(start, end, false, STRING_LITERAL_PARENT_KIND_EXPRESSION, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_PARENT, parent, f);
}

/** ESTree's `ModuleExportName`: `a`, or `"a"`. `(nameAtom, namePos)`: the `Ident`. */
export function moduleExportName(nameAtom: number, namePos: number, parent: number, f: Formatter): void {
  if (identIsString(namePos)) {
    identSpan(nameAtom, namePos);
    fmtStringLiteral(SP[0] | 0, SP[1] | 0, parent, f);
  } else identifier(nameAtom, namePos, parent, f);
}

/** `"source" with { type: "json" }` of the import or export `statement`. */
export function formatImportAndExportSourceWithClause(statement: number, f: Formatter): void {
  if (!stmtModuleSpecifierSpan(statement)) return;
  const parent = stmtAsAstNodes(statement);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const withClause = stmtImportAttributes(statement);
  if (withClause < 0) {
    fmtStringLiteral(start, end, parent, f);
    return;
  }
  const cx = cxOf(f);
  if (cx.isQuiet) {
    fmtStringLiteral(start, end, parent, f);
    writeWithClause(withClause, f);
    return;
  }
  const cm = cx.comments;
  const previousLimit = cm.limitCommentsUpTo(end);
  fmtStringLiteral(start, end, parent, f);
  cm.restoreViewLimit(previousLimit);

  // Without attributes all comments trail the source. Otherwise, of the comments before the first attribute that do not start their line,
  // those before the `{` and those that end their line. The others lead the attribute.
  importAttributesBracesSpan(withClause);
  const bracesStart = SP[0] | 0;
  const bracesEnd = SP[1] | 0;
  let from = 0;
  let to = 0;
  const entriesLen = importAttributesEntriesLen(withClause);
  if (entriesLen === 0) {
    cm.commentsBefore(bracesEnd);
    from = cm.from;
    to = cm.to;
  } else {
    const first = listAt(importAttributesEntriesStart(withClause), 0);
    propSpan(first);
    cm.commentsBefore(SP[0] | 0);
    from = cm.from;
    const n = cm.to - from;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const c = (from + i) | 0;
      if (cm.precededByNewline(c)) break;
      if ((cm.spanEnd[c] | 0) <= bracesStart || cm.followedByNewline(c)) count = (i + 1) | 0;
    }
    to = (from + count) | 0;
  }
  formatTrailingCommentsRange(from, to, f);
  writeWithClause(withClause, f);
}

export function writeImportDeclaration(statement: number, imp: number, f: Formatter): void {
  f.token(KW_IMPORT);
  const phase = importPhase(imp);
  if (phase !== 0) {
    f.token(phase === 1 ? KW_DEFER : KW_SOURCE);
    f.space();
  } else if (importIsTypeOnly(imp)) {
    importClauseSpan(imp);
    f.token(importKindToken(SP[0] | 0, f));
  }
  if (!importIsSideEffect(imp)) {
    writeImportSpecifiers(statement, imp, f);
    f.token(KW_FROM);
  }
  formatImportAndExportSourceWithClause(statement, f);
  optionalSemicolon(f);
}

/** `a, * as b`, `a, { b, c }` */
function writeImportSpecifiers(statement: number, imp: number, f: Formatter): void {
  const node = mkAn(AN_IMPORT_DECLARATION, statement);
  const namedStart = importNamedStart(imp);
  const namedLen = importNamedLen(imp);
  const defaultAtom = importDefault(imp);
  const namespaceAtom = importNamespace(imp);
  // `import a, {} from "a"` is `import a from "a"`.
  const hasBraces = importHasNamedImports(imp) && !(namedLen === 0 && (defaultAtom >= 0 || namespaceAtom >= 0));

  if (defaultAtom >= 0) {
    identifier(defaultAtom, importDefaultPos(imp), node, f);
    if (namespaceAtom < 0 && !hasBraces) return;
    f.token(COMMA);
    f.space();
  }
  if (namespaceAtom >= 0 && importNamespaceSpan(imp)) {
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    const cx = cxOf(f);
    // format_node(span, || node, f, |f| "*", space, "as", space, identifier(namespace, node))
    if (cx.isQuiet) writeNamespaceImport(namespaceAtom, importNamespacePos(imp), node, f);
    else {
      const cm = cx.comments;
      const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
      formatLeadingComments(start, end, f);
      if (isSuppressed) writeSuppressedNode(start, end, f);
      else {
        const outer = enterScope(cx, start, end);
        writeNamespaceImport(namespaceAtom, importNamespacePos(imp), node, f);
        leaveScope(cx, outer);
      }
      writeTrailingCommentsIn(start, end, PK_PARENT, node, f);
    }
    if (!hasBraces) return;
    f.token(COMMA);
    f.space();
  }

  const shouldInsertSpaceAroundBrackets = f.options.bracketSpacing;
  const isOnlySpecifier = namedLen === 1 && defaultAtom < 0 && namespaceAtom < 0;

  if (namedLen === 0) {
    f.token(EMPTY_BRACES);
    return;
  }
  const only = listAt(namedStart, 0);
  if (isOnlySpecifier) {
    importSpecSpan(only);
    if (!onlySpecifierHasComments(statement, SP[0] | 0, SP[1] | 0, f)) {
      f.token(LBRACE);
      f.maybeSpace(shouldInsertSpaceAroundBrackets);
      fmtImportSpec(only, f);
      f.maybeSpace(shouldInsertSpaceAroundBrackets);
      f.token(RBRACE);
      return;
    }
  }
  f.token(LBRACE);
  writeSpecifiers(statement, namedStart, namedLen, false, f);
  f.token(RBRACE);
}

function writeNamespaceImport(namespaceAtom: number, namespacePos: number, node: number, f: Formatter): void {
  f.token(STAR);
  f.space();
  f.token(KW_AS);
  f.space();
  identifier(namespaceAtom, namespacePos, node, f);
}

/**
 * Whether a comment belongs to `specifier`, the only one of the import or export `statement`. One inside of it does if it starts or ends its
 * line, otherwise it belongs to a name.
 */
export function onlySpecifierHasComments(statement: number, specifierStart: number, specifierEnd: number, f: Formatter): boolean {
  const cx = cxOf(f);
  if (cx.isQuiet) return false;
  const cm = cx.comments;
  stmtSpan(statement);
  cm.commentsBeforeCharacter(SP[0] | 0, 125 /* } */);
  const from = cm.from;
  const to = cm.to;
  for (let i = from; i < to; i++) {
    const inside = specifierStart <= (cm.spanStart[i] | 0) && (cm.spanEnd[i] | 0) <= specifierEnd;
    if (!inside || cm.precededByNewline(i) || cm.followedByNewline(i)) return true;
  }
  return commentsBeforeFrom(specifierEnd, statement, f) > 0;
}

function containsFrom(text: Uint8Array, start: number, end0: number): boolean {
  const end = end0 < text.length ? end0 : text.length;
  for (let i = start; i + 4 <= end; i++) {
    if ((text[i] | 0) === 102 && (text[i + 1] | 0) === 114 && (text[i + 2] | 0) === 111 && (text[i + 3] | 0) === 109) return true;
  }
  return false;
}

/**
 * `{ a } /* comment *&#47; from "a"`: of the comments that are not printed yet between `position`, where the last specifier of `statement` ends,
 * and the source, those that trail the specifier: the ones that end their line, and the ones before the `from` that do not start their line.
 * Returns their number; they are the range `[cm.from, cm.from + count)`.
 */
function commentsBeforeFrom(position0: number, statement: number, f: Formatter): number {
  const cx = cxOf(f);
  const cm = cx.comments;
  if (!stmtModuleSpecifierSpan(statement)) {
    cm.from = cm.printedCount;
    cm.to = cm.printedCount;
    return 0;
  }
  let position = position0;
  cm.commentsIn(position, SP[0] | 0);
  const from = cm.from;
  const to = cm.to;
  const text = cx.src.text;
  let isBeforeFrom = true;
  let count = 0;
  for (let i = from; i < to; i++) {
    const gapEnd = cm.spanStart[i] | 0;
    if (isBeforeFrom && containsFrom(text, position, gapEnd)) isBeforeFrom = false;
    position = cm.spanEnd[i] | 0;
    if (!(cm.followedByNewline(i) || (isBeforeFrom && !cm.precededByNewline(i)))) break;
    count = (count + 1) | 0;
  }
  cm.from = from;
  cm.to = (from + count) | 0;
  return count;
}

/**
 * The specifiers `(start, len)` between the braces of the import or export in the first field. `isExport`: they are `ExportSpec`s.
 * `FormatSpecifiers(statement, specifiers)`.
 */
export function writeSpecifiers(statement: number, start: number, len: number, isExport: boolean, f: Formatter): void {
  const trailing = trailingSeparator(FTC_ES5, f.options);
  const needsSpace = f.options.bracketSpacing;
  f.startGroup();
  f.startSoftBlockIndentWithMaybeSpace(needsSpace);
  for (let i = 0; i < len; i++) {
    if (i > 0) f.softLineBreakOrSpace();
    const specifier = listAt(start, i);
    let nextStart = -1;
    if (i + 1 < len) {
      const next = listAt(start, i + 1);
      nextStart = isExport ? exportSpecStartOf(next) : importSpecStartOf(next);
    }
    writeSpecifier(statement, specifier, isExport, nextStart, f);
    writeSeparatorAfterLocal(f, i === len - 1, trailing);
  }
  f.endSoftBlockIndentWithMaybeSpace(needsSpace);
  f.endGroup();
}

function writeSeparatorAfterLocal(f: Formatter, isLast: boolean, trailing: number): void {
  if (!isLast) {
    f.token(COMMA);
    return;
  }
  if (trailing === TRAILING_SEPARATOR_ALLOWED) f.tokenIfBreaks(COMMA);
  else if (trailing === TRAILING_SEPARATOR_MANDATORY) f.token(COMMA);
}

function importSpecStartOf(s: number): number {
  importSpecSpan(s);
  return SP[0] | 0;
}

function exportSpecStartOf(s: number): number {
  exportSpecSpan(s);
  return SP[0] | 0;
}

/** `import {⏎⏎// comment⏎a } from "b"`: oxfmt keeps the empty line, also behind the `{`. */
function emptyLineBeforeCommentsOfSpecifierStays(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `FormatSpecifier`: a specifier and the comments around it. `nextStart`: where the next specifier starts (-1: it is the last). */
function writeSpecifier(statement: number, specifier: number, isExport: boolean, nextStart: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    if (isExport) fmtExportSpec(specifier, f);
    else fmtImportSpec(specifier, f);
    return;
  }
  const cm = cx.comments;
  if (isExport) exportSpecSpan(specifier);
  else importSpecSpan(specifier);
  const specStart = SP[0] | 0;
  const end = SP[1] | 0;
  // What leads the source is hidden from the last specifier.
  let limit = -1;
  if (nextStart < 0 && stmtModuleSpecifierSpan(statement)) {
    const sourceStart = SP[0] | 0;
    cm.commentsIn(end, sourceStart);
    for (let i = cm.from; i < cm.to; i++) {
      if (cm.precededByNewline(i) && !cm.followedByNewline(i)) {
        limit = cm.spanStart[i] | 0;
        break;
      }
    }
  }
  const previousLimit = limit >= 0 ? cm.limitCommentsUpTo(limit) : -2;
  if (emptyLineBeforeCommentsOfSpecifierStays(f) && cm.hasCommentBefore(specStart) && linesBefore(specStart, end, f) > 1) f.emptyLine();
  if (isExport) fmtExportSpec(specifier, f);
  else fmtImportSpec(specifier, f);
  if (previousLimit !== -2) cm.restoreViewLimit(previousLimit);

  // Prettier's `handleModuleSpecifiersComments`: a comment after a specifier that ends its line trails the specifier, also if it is on a line
  // of its own.
  let from = 0;
  let to = 0;
  if (nextStart >= 0) {
    cm.commentsBefore(nextStart);
    from = cm.from;
    let count = 0;
    for (let i = cm.to - 1; i >= from; i--) {
      if (cm.followedByNewline(i)) {
        count = (i - from + 1) | 0;
        break;
      }
    }
    to = (from + count) | 0;
  } else {
    const count = commentsBeforeFrom(end, statement, f);
    from = cm.from;
    to = (from + count) | 0;
  }
  formatTrailingCommentsRange(from, to, f);
}

/**
 * Prettier's `handleModuleSpecifiersComments`: a comment in the specifier at this span that starts or ends its line goes before the
 * specifier. `FormatCommentsInSpecifier(span)`.
 */
export function fmtCommentsInSpecifier(spanEnd: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) return;
  const cm = cx.comments;
  cm.commentsBefore(spanEnd);
  const from = cm.from;
  const to = cm.to;
  let count = 0;
  for (let i = to - 1; i >= from; i--) {
    if (cm.precededByNewline(i) || cm.followedByNewline(i)) {
      count = (i - from + 1) | 0;
      break;
    }
  }
  formatLeadingCommentsRange(from, (from + count) | 0, f);
}

/** `a`, `a as b`, `type a` */
export function writeImportSpecifier(specifier: number, f: Formatter): void {
  const node = mkAn(AN_IMPORT_SPECIFIER, specifier);
  importSpecSpan(specifier);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  fmtCommentsInSpecifier(end, f);
  if (importSpecIsTypeOnly(specifier)) f.token(importKindToken(start, f));
  if (importSpecIsRenamed(specifier)) {
    moduleExportName(importSpecImported(specifier), importSpecImportedPos(specifier), node, f);
    f.space();
    f.token(KW_AS);
    f.space();
  }
  identifier(importSpecLocal(specifier), importSpecLocalPos(specifier), node, f);
}

/** ` with { type: "json" }` */
function writeWithClause(withClause: number, f: Formatter): void {
  const cx = cxOf(f);
  const entriesStart = importAttributesEntriesStart(withClause);
  const entriesLen = importAttributesEntriesLen(withClause);
  const isConsistent = f.options.quoteProperties === QUOTE_PROPS_CONSISTENT;
  if (isConsistent) {
    let quoteNeeded = false;
    const text = cx.src.text;
    for (let i = 0; i < entriesLen; i++) {
      const owner = nodeOfProp(listAt(entriesStart, i));
      if (keyKind(owner) === KEY_STRING && keySpan(owner)) {
        const a = (SP[0] | 0) + 1;
        const b = (SP[1] | 0) - 1;
        if (!isNameWithoutQuotes(text, a, b > a ? b : a, f.options.flavor)) {
          quoteNeeded = true;
          break;
        }
      }
    }
    cx.pushQuoteNeeded(quoteNeeded);
  }

  f.space();
  importAttributesKeywordSpan(withClause);
  f.sourceText(SP[0] | 0, SP[1] | 0);
  f.space();
  importAttributesBracesSpan(withClause);
  writeImportAttributes(entriesStart, entriesLen, SP[0] | 0, SP[1] | 0, f);

  if (isConsistent) cx.popQuoteNeeded();
}

/** Prettier's `printObject` for import attributes. `(bracesStart, bracesEnd)`: the `{ .. }`. */
function writeImportAttributes(entriesStart: number, entriesLen: number, bracesStart: number, bracesEnd: number, f: Formatter): void {
  const cx = cxOf(f);
  if (entriesLen === 0) {
    f.token(EMPTY_BRACES);
    return;
  }
  const first = listAt(entriesStart, 0);
  const needsSpace = f.options.bracketSpacing;

  // Prettier's `isSingleTypeImportAttributes`
  const firstKey = nodeOfProp(first);
  const firstValue = propValue(first);
  const isType = keyIs(firstKey, "type") && firstValue >= 0 && exprTag(firstValue) === EXPR_STRING;
  if (entriesLen === 1 && isType && !cx.comments.hasCommentBefore(bracesEnd)) {
    f.token(LBRACE);
    f.maybeSpace(needsSpace);
    writeImportAttribute(first, bracesStart, bracesEnd, 0, f);
    f.maybeSpace(needsSpace);
    f.token(RBRACE);
    return;
  }

  propSpan(first);
  f.startGroupExpand(cx.src.containsNewline(bracesStart, SP[0] | 0));
  f.token(LBRACE);
  f.startSoftBlockIndentWithMaybeSpace(needsSpace);
  const trailing = trailingSeparator(FTC_ES5, f.options);
  let previousEnd = -1;
  for (let i = 0; i < entriesLen; i++) {
    const attribute = listAt(entriesStart, i);
    if (previousEnd >= 0) {
      if (isNextLineEmpty(cx.src, previousEnd)) f.emptyLine();
      else f.softLineBreakOrSpace();
    }
    propSpan(attribute);
    previousEnd = SP[1] | 0;
    let nextStart = 0;
    if (i + 1 < entriesLen) {
      propSpan(listAt(entriesStart, i + 1));
      nextStart = SP[0] | 0;
    }
    writeImportAttribute(attribute, bracesStart, bracesEnd, nextStart, f);
    writeSeparatorAfterLocal(f, i === entriesLen - 1, trailing);
  }
  f.endSoftBlockIndentWithMaybeSpace(needsSpace);
  f.token(RBRACE);
  f.endGroup();
}

/** `type: "json"`. `(bracesStart, bracesEnd)`: the `{ .. }` that it is in. `nextStart`: where the next attribute starts, or 0. */
function writeImportAttribute(attribute: number, bracesStart: number, bracesEnd: number, nextStart: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  propSpan(attribute);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const node = mkAn(AN_OBJECT_PROPERTY, attribute);
  formatLeadingComments(start, end, f);
  const owner = nodeOfProp(attribute);
  const kind = keyKind(owner);
  if (kind === KEY_STRING) {
    keySpan(owner);
    const ks = SP[0] | 0;
    const ke = SP[1] | 0;
    // format_node(span, || node, f, |f| write!(f, format))
    if (cx.isQuiet) fmtLiteralStringToken(ks, ke, false, STRING_LITERAL_PARENT_KIND_IMPORT_ATTRIBUTE, f);
    else {
      const isSuppressed = cm.isSuppressed(ks) || cm.hasTrailingSuppressionComment(ke);
      formatLeadingComments(ks, ke, f);
      if (isSuppressed) writeSuppressedNode(ks, ke, f);
      else {
        const outer = enterScope(cx, ks, ke);
        fmtLiteralStringToken(ks, ke, false, STRING_LITERAL_PARENT_KIND_IMPORT_ATTRIBUTE, f);
        leaveScope(cx, outer);
      }
      writeTrailingCommentsIn(ks, ke, PK_PARENT, node, f);
    }
  } else if (kind >= 0) {
    fmtKey(owner, node, f);
  }
  f.token(COLON);

  const value = propValue(attribute);
  if (value >= 0) {
    exprSpan(value);
    const valueStart = SP[0] | 0;
    let breaksAfterColon = false;
    if (!cx.isQuiet) {
      const n = cm.commentsBefore(valueStart);
      const from = cm.from;
      for (let i = from; i < from + n; i++) {
        if (cm.followedByNewline(i) || cm.isIndentableBlock(i)) {
          breaksAfterColon = true;
          break;
        }
      }
    }
    const previousLimit = cm.limitCommentsUpTo(end);
    if (breaksAfterColon) {
      f.startGroup();
      f.startIndent();
      f.softLineBreakOrSpace();
      fmtExpr(value, f);
      f.endIndent();
      f.endGroup();
    } else {
      f.space();
      fmtExpr(value, f);
    }
    cm.restoreViewLimit(previousLimit);
  }
  formatTrailingComments(bracesStart, bracesEnd, start, end, nextStart, f);
}
