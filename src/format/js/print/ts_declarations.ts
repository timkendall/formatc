// Port of vendor/bun/src/format/js/print/ts_declarations.rs: the declarations of TypeScript.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { COMMA, DOT, EQ, LBRACE, LBRACKET, RBRACE, RBRACKET, RPAREN } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT, FTC_ES5, QUOTE_PROPS_CONSISTENT, TRAILING_SEPARATOR_DISALLOWED, trailingSeparator } from "../../options.ts";
import {
  EXPR_DOT,
  EXPR_INDEX,
  FLAG_AMBIENT,
  FLAG_CONST,
  FLAG_TYPE_ONLY,
  IET_ENTITY,
  KEY_NONE,
  MODNAME_GLOBAL,
  MODNAME_IDENT,
  MODNAME_STRING,
  SP,
  TYPE_COND,
  TYPE_FN,
  TYPE_HERITAGE,
  TYPE_INTERSECTION,
  TYPE_OBJECT,
  TYPE_REF,
  TYPE_STRING_LIT,
  TYPE_UNION,
  aliasName,
  aliasNamePos,
  aliasTy,
  aliasTypeParamsLen,
  aliasTypeParamsStart,
  enumBodySpan,
  enumMemberSpan,
  enumMemberInit,
  enumMembersLen,
  enumMembersStart,
  enumName,
  enumNamePos,
  exprTag,
  fileIsFlow,
  fileIsJavascript,
  FN_FUNCTION_TYPE,
  funcKind,
  funcTypeParamsLen,
  identEndOf,
  identSpan,
  importEqualsEntityLen,
  importEqualsEntityStart,
  importEqualsFlags,
  importEqualsName,
  importEqualsNamePos,
  importEqualsRequireSpan,
  importEqualsTargetKind,
  interfaceBodySpan,
  interfaceExtendsLen,
  interfaceExtendsStart,
  interfaceMembersLen,
  interfaceMembersStart,
  interfaceName,
  interfaceNamePos,
  interfaceTypeParamsLen,
  interfaceTypeParamsStart,
  keyInnerSpan,
  keyIsComputed,
  keyKind,
  listAt,
  moduleBodyLen,
  moduleBodySpan,
  moduleBodyStart,
  moduleInnermost,
  moduleName,
  moduleNameKind,
  moduleNamePos,
  moduleNameSpan,
  moduleNested,
  moduleUsesModuleKeyword,
  modifierFlagOf,
  nodeOfEnumMember,
  nodeOfStmt,
  stmtModifiersLen,
  stmtModifiersStart,
  stmtModuleSpecifierSpan,
  stmtNamespaceExportName,
  stmtNamespaceExportNamePos,
  stmtSpan,
  typeCondCheck,
  typeCondExtends,
  typeFnFn,
  typeHeritageArgsLen,
  typeHeritageExpr,
  typeParamConstraint,
  typeParamDefault,
  typeParamListAngleBrackets,
  typeRefArgsLen,
  typeRefNameLen,
  typeSpan,
  typeTag,
  typeUnionTypesLen,
  typeUnionTypesStart,
} from "../../../lint/ast/index.ts";
import {
  AN_EXPORT_NAMED_DECLARATION,
  AN_TS_ENUM_DECLARATION,
  AN_TS_ENUM_MEMBER,
  AN_TS_IMPORT_EQUALS_DECLARATION,
  AN_TS_INTERFACE_DECLARATION,
  AN_TS_NAMESPACE_EXPORT_DECLARATION,
  AN_TS_TYPE_ALIAS_DECLARATION,
  anSpan,
  anTag,
  mkAn,
  mkTypeParametersAn,
  stmtAsAstNodes,
  typeAsAstNodes,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import {
  PK_PARENT,
  enterScope,
  fmtEnumMember,
  fmtExpr,
  fmtType,
  identifier,
  leaveScope,
  writeTrailingCommentsIn,
  writeTrailingCommentsOf,
} from "../format.ts";
import {
  DANGLING_BLOCK,
  DANGLING_SOFT,
  commentsStayBetweenHeadAndBody,
  formatDanglingComments,
  formatLeadingComments,
  formatLeadingCommentsRange,
  formatTrailingComments,
  formatTrailingCommentsRange,
  writeHeadBodySeparator,
} from "../trivia.ts";
import { JOIN_SOFT_LINE, joinNodesSeparator, writeSeparatorAfter } from "../builders.ts";
import { BT_ASCII_WS } from "../source_text.ts";
import {
  ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR,
  ASSIGNMENT_LIKE_LAYOUT_BREAK_LEFT_HAND_SIDE,
  ASSIGNMENT_LIKE_LAYOUT_FLUID,
  ASSIGNMENT_LIKE_LAYOUT_NEVER_BREAK_AFTER_OPERATOR,
  writeCommentsBeforeOperator,
} from "../utils/assignment_like.ts";
import { keyRequiresQuotes, fmtKey } from "../utils/object.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { shouldHugType, withoutLoneOperator } from "../utils/typescript.ts";
import { isEmptyBlock } from "./block_statement.ts";
import { fmtClassImplements } from "./class.ts";
import { isOpaqueType, isUnknownMembersMark, writeExplicitTypeOfEnum, writeOpaqueType, writeWhatIsNoTypeAlias } from "./flow.ts";
import { loneTypeOfIntersectionIsAGroup } from "./intersection_type.ts";
import { fmtStatements } from "./program.ts";
import { optionalSemicolon } from "./semicolon.ts";
import { fmtModuleSpecifier, fmtStringLiteralOf, writeIdentifierWithoutTrailingComments, entityName, writeTsInterfaceSignatures } from "./ts_types.ts";
import { typeParameters, typeParametersWithoutComments } from "./type_parameters.ts";
import { typeAliasUnionBreaksAfterOperator, unionBreaksOnePerLine, unionPrintsItself, writeTsUnionTypeIn } from "./union_type.ts";

const KW_DECLARE = token("declare ");
const KW_INTERFACE = token("interface");
const KW_EXTENDS = token("extends");
const KW_TYPE = token("type ");
const KW_CONST = token("const ");
const KW_ENUM = token("enum");
const KW_GLOBAL = token("global");
const KW_MODULE = token("module");
const KW_NAMESPACE = token("namespace");
const KW_IMPORT = token("import");
const KW_TYPE_SPACE = token("type ");
const KW_REQUIRE_PAREN = token("require(");
const KW_EXPORT_ASSIGN = token("export = ");
const KW_EXPORT_AS_NAMESPACE = token("export as namespace ");
const ELLIPSIS = token("...");

function isDeclared(statement: number): boolean {
  const start = stmtModifiersStart(statement);
  const len = stmtModifiersLen(statement);
  for (let i = 0; i < len; i++) if (modifierFlagOf(listAt(start, i)) === FLAG_AMBIENT) return true;
  return false;
}

function isAsciiWhitespaceBetween(start: number, end: number, f: Formatter): boolean {
  return cxOf(f).src.allBytes(start, end, BT_ASCII_WS);
}

/** `interface A<T> extends B { .. }` */
export function writeTsInterfaceDeclaration(statement: number, iface: number, f: Formatter): void {
  if (fileIsFlow() && isOpaqueType(statement, f)) {
    writeOpaqueType(statement, iface, f);
    return;
  }
  const cx = cxOf(f);
  const cm = cx.comments;
  const node = mkAn(AN_TS_INTERFACE_DECLARATION, statement);
  const owner = nodeOfStmt(statement);
  const name = interfaceName(iface);
  const namePos = interfaceNamePos(iface);
  const tpStart = interfaceTypeParamsStart(iface);
  const tpLen = interfaceTypeParamsLen(iface);
  const extStart = interfaceExtendsStart(iface);
  const extLen = interfaceExtendsLen(iface);
  interfaceBodySpan(iface);
  const SP$ = SP;
  const bodyStart = SP$.s0 | 0;
  const bodyEnd = SP$.s1 | 0;
  const hasAngleBrackets = typeParamListAngleBrackets(tpStart, tpLen);
  const bracketsEnd = hasAngleBrackets ? SP$.s1 | 0 : 0;

  // Whether the head is a group that can break before `extends`: there are several types, or one that is `A.B` without type arguments, or
  // a comment trails the name or the type parameters.
  let groupMode = extLen > 1;
  if (!groupMode && extLen === 1) {
    const first = listAt(extStart, 0);
    let isMember = false;
    const tag = typeTag(first);
    if (tag === TYPE_REF) isMember = typeRefNameLen(first) > 1 && typeRefArgsLen(first) === 0;
    else if (tag === TYPE_HERITAGE) {
      const et = exprTag(typeHeritageExpr(first));
      isMember = (et === EXPR_DOT || et === EXPR_INDEX) && typeHeritageArgsLen(first) === 0;
    }
    groupMode = isMember;
    // A comment after `extends` on its line leads the type. All others trail what is before.
    if (!groupMode) {
      const previousEnd = hasAngleBrackets ? bracketsEnd : identEndOf(name, namePos);
      typeSpan(first);
      cm.commentsIn(previousEnd, SP$.s0 | 0);
      const from = cm.from;
      const to = cm.to;
      for (let i = from; i < to; i++) {
        if (cm.precededByNewline(i) || cm.followedByNewline(i)) {
          groupMode = true;
          break;
        }
      }
      if (!groupMode && to > from && isAsciiWhitespaceBetween(previousEnd, cm.spanStart[from] | 0, f)) groupMode = true;
    }
  }

  f.startGroup();
  if (isDeclared(statement)) f.token(KW_DECLARE);
  f.token(KW_INTERFACE);
  f.space();

  if (extLen > 0 && groupMode) {
    f.startGroup();
    writeInterfaceId(statement, owner, node, name, namePos, tpStart, tpLen, hasAngleBrackets, extLen, f);
    f.startIndent();
    writeInterfaceExtends(extStart, extLen, groupMode, f);
    f.endIndent();
    f.endGroup();
  } else {
    writeInterfaceId(statement, owner, node, name, namePos, tpStart, tpLen, hasAngleBrackets, extLen, f);
    writeInterfaceExtends(extStart, extLen, groupMode, f);
  }

  // The comments on the line of the `{` stay before it. All others are in the body.
  if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f)) {
    writeHeadBodySeparator(bodyStart, f);
  } else if (!cx.isQuiet) {
    cm.commentsBefore(bodyStart);
    const from = cm.from;
    const to = cm.to;
    let anyOwnLine = false;
    for (let i = from; i < to; i++) {
      if (cm.precededByNewline(i) || cm.followedByNewline(i)) {
        anyOwnLine = true;
        break;
      }
    }
    if (!anyOwnLine) {
      f.space();
      formatLeadingCommentsRange(from, to, f);
    }
  }
  f.space();
  f.token(LBRACE);
  const membersLen = interfaceMembersLen(iface);
  if (membersLen === 0) {
    formatDanglingComments(bodyStart, bodyEnd, DANGLING_BLOCK, f);
  } else {
    f.startBlockIndent();
    writeTsInterfaceSignatures(interfaceMembersStart(iface), membersLen, f);
    f.endBlockIndent();
  }
  f.token(RBRACE);
  f.endGroup();
}

/** `format_id` of an interface. */
function writeInterfaceId(
  statement: number,
  owner: number,
  node: number,
  name: number,
  namePos: number,
  tpStart: number,
  tpLen: number,
  hasAngleBrackets: boolean,
  extLen: number,
  f: Formatter,
): void {
  const SP$ = SP;
  if (tpLen === 0 && extLen === 0) {
    identSpan(name, namePos);
    writeIdentifierWithoutTrailingComments(name, namePos, SP$.s0 | 0, SP$.s1 | 0, node, f);
  } else {
    identifier(name, namePos, node, f);
  }
  if (hasAngleBrackets) {
    typeParametersWithoutComments(tpStart, tpLen, owner, 0, true, f);
    if (extLen > 0) writeTrailingCommentsOf(mkTypeParametersAn(owner), f);
  }
  void statement;
}

/** `format_extends` of an interface. */
function writeInterfaceExtends(extStart: number, extLen: number, groupMode: boolean, f: Formatter): void {
  if (extLen === 0) return;
  const cm = cxOf(f).comments;
  typeSpan(listAt(extStart, 0));
  const firstStart = SP.s0 | 0;
  if (cm.hasLeadingOwnLineComment(firstStart)) {
    cm.commentsBefore(firstStart);
    formatTrailingCommentsRange(cm.from, cm.to, f);
  }
  if (extLen > 1) {
    f.softLineBreakOrSpace();
    f.token(KW_EXTENDS);
    f.startGroup();
    f.startSoftLineIndentOrSpace();
    fmtClassImplements(extStart, extLen, f);
    f.endSoftLineIndentOrSpace();
    f.endGroup();
  } else if (groupMode) {
    f.softLineBreakOrSpace();
    f.startGroup();
    f.token(KW_EXTENDS);
    f.space();
    fmtClassImplements(extStart, extLen, f);
    f.endGroup();
  } else {
    f.space();
    f.token(KW_EXTENDS);
    f.space();
    fmtClassImplements(extStart, extLen, f);
  }
}

/** `type A = B /* comment *&#47;;` is `type A = B; /* comment *&#47;` for oxfmt, as after any other statement. Prettier does that only if the type is exported. */
function commentsBeforeSemicolonOfTypeAliasGoBehindIt(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `type A = B`. Prettier's `printTypeAlias`, with what its `printAssignment` does if the right side is a type. */
export function writeTsTypeAliasDeclaration(statement: number, alias: number, f: Formatter): void {
  if (fileIsFlow() && writeWhatIsNoTypeAlias(statement, alias, f)) return;
  const cx = cxOf(f);
  const cm = cx.comments;
  const node = mkAn(AN_TS_TYPE_ALIAS_DECLARATION, statement);
  const owner = nodeOfStmt(statement);
  const aliasType = aliasTy(alias);
  const ty = withoutLoneOperator(aliasType);
  typeSpan(ty);
  const SP$ = SP;
  const tyStart = SP$.s0 | 0;
  const tyEnd = SP$.s1 | 0;
  const isOxfmt = commentsBeforeSemicolonOfTypeAliasGoBehindIt(f);

  // The comments before the `;` of an export are behind it: see `Comments::withoutSemicolon`.
  const isExported = !cx.isQuiet && (isOxfmt || anTag(stmtAsAstNodes(statement)) === AN_EXPORT_NAMED_DECLARATION);
  let viewLimit = -1;
  if (isExported) {
    let end = 0;
    if (isOxfmt) end = tyEnd;
    else {
      stmtSpan(statement);
      end = cm.withoutSemicolon(SP$.s0 | 0, SP$.s1 | 0);
    }
    viewLimit = cm.limitCommentsUpTo(end);
  }

  // Whether the left side is a group depends on the layout, which depends on the comments that are left after the left side is written.
  const outerGroup = f.reserveTag();
  const leftGroup = f.reserveTag();
  if (isDeclared(statement)) f.token(KW_DECLARE);
  f.token(KW_TYPE);
  const name = aliasName(alias);
  const namePos = aliasNamePos(alias);
  const tpStart = aliasTypeParamsStart(alias);
  const tpLen = aliasTypeParamsLen(alias);
  const hasAngleBrackets = typeParamListAngleBrackets(tpStart, tpLen);
  const leftEnd = hasAngleBrackets ? SP$.s1 | 0 : identEndOf(name, namePos);
  if (hasAngleBrackets) {
    identifier(name, namePos, node, f);
    writeTypeParametersWithoutTrailingComments(tpStart, tpLen, owner, f);
  } else {
    identSpan(name, namePos);
    writeIdentifierWithoutTrailingComments(name, namePos, SP$.s0 | 0, SP$.s1 | 0, node, f);
  }
  // What oxfmt writes behind the `=`, and whether a line comment is on the line of the `=`.
  let runFrom = 0;
  let runTo = 0;
  let hasLineCommentOnOperatorLine = false;
  if (!cx.isQuiet) {
    if (typeAliasCommentsStayBehindOperator(f)) {
      if (writeCommentsAfterTypeAliasLeftSide(alias, leftEnd, f)) {
        runFrom = cm.from;
        runTo = cm.to;
        hasLineCommentOnOperatorLine = true;
      } else {
        hasLineCommentOnOperatorLine = LEFT_SIDE_LINE_COMMENT[0] !== 0;
      }
    } else {
      commentsBeforeTypeAliasOperator(identEndOf(name, namePos), ty, f);
      formatTrailingCommentsRange(cm.from, cm.to, f);
    }
  }

  let layout = typeAliasLayout(statement, alias, ty, tyStart, tyEnd, f);
  if ((layout === ASSIGNMENT_LIKE_LAYOUT_FLUID || layout === ASSIGNMENT_LIKE_LAYOUT_NEVER_BREAK_AFTER_OPERATOR) && hasLineCommentOnOperatorLine) {
    layout = ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR;
  }
  if (layout !== ASSIGNMENT_LIKE_LAYOUT_BREAK_LEFT_HAND_SIDE) f.groupFrom(leftGroup, false);
  f.space();
  f.token(EQ);
  if (runTo > runFrom) {
    formatTrailingCommentsRange(runFrom, runTo, f);
    for (let i = runFrom; i < runTo; i++) {
      if (cm.isSuppressionComment(i)) {
        cm.markSuppressedAfterOperator(tyStart);
        break;
      }
    }
  }

  const staysBehind = typeAliasCommentsStayBehindOperator(f);
  if (layout === ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR) {
    // A line comment that has been written after the `=` stays there.
    if (staysBehind && (hasLineCommentOnOperatorLine || typeTag(ty) !== TYPE_COND)) {
      f.startSoftLineIndentOrSpace();
      writeRight(ty, aliasType, layout, f);
      f.endSoftLineIndentOrSpace();
    } else {
      f.startGroup();
      f.startSoftLineIndentOrSpace();
      writeRight(ty, aliasType, layout, f);
      f.endSoftLineIndentOrSpace();
      f.endGroup();
    }
  } else if (layout === ASSIGNMENT_LIKE_LAYOUT_BREAK_LEFT_HAND_SIDE) {
    f.space();
    f.startGroup();
    writeRight(ty, aliasType, layout, f);
    f.endGroup();
  } else if (layout === ASSIGNMENT_LIKE_LAYOUT_NEVER_BREAK_AFTER_OPERATOR) {
    f.space();
    writeRight(ty, aliasType, layout, f);
  } else {
    const groupId = f.groupId();
    f.indentedLineGroup(groupId);
    f.lineSuffixBoundary();
    f.startIndentIfGroupBreaks(groupId);
    writeRight(ty, aliasType, layout, f);
    f.endIndentIfGroupBreaks(groupId);
  }
  f.groupFrom(outerGroup, false);
  optionalSemicolon(f);
  if (isExported) cm.restoreViewLimit(viewLimit);
}

/** `FormatNodeWithoutTrailingComments(&type_parameters(params, Node::Stmt(statement)))` */
function writeTypeParametersWithoutTrailingComments(tpStart: number, tpLen: number, owner: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    typeParameters(tpStart, tpLen, owner, 0, false, f);
    return;
  }
  const cm = cx.comments;
  const node = mkTypeParametersAn(owner);
  anSpan(node);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  if (cm.hasTrailingSuppressionComment(end)) {
    formatLeadingComments(start, end, f);
    writeSuppressedNode(start, end, f);
    return;
  }
  const previousLimit = cm.limitCommentsUpTo(end);
  typeParameters(tpStart, tpLen, owner, 0, false, f);
  cm.restoreViewLimit(previousLimit);
}

/** `right` of a type alias. */
function writeRight(ty: number, aliasType: number, layout: number, f: Formatter): void {
  if (typeTag(ty) === TYPE_UNION) {
    const isIndented = layout === ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR;
    // The comments before a union are written with it.
    writeTsUnionTypeIn(ty, typeUnionTypesStart(ty), typeUnionTypesLen(ty), isIndented, f);
    writeTrailingCommentsOf(typeAsAstNodes(ty), f);
  } else if (ty !== aliasType && typeTag(aliasType) === TYPE_INTERSECTION && loneTypeOfIntersectionIsAGroup(f)) {
    f.startGroup();
    fmtType(ty, f);
    f.endGroup();
  } else {
    fmtType(ty, f);
  }
  if (ty !== aliasType) writeTrailingCommentsOf(typeAsAstNodes(aliasType), f);
}

/**
 * oxfmt follows Prettier 3.8: a line comment behind the `=` of a type alias trails the left side. For 3.9 every comment after the `=` leads
 * the type.
 *
 * ```ts
 * type A = // comment      type A =
 *   B;                       // comment
 *                            B;
 * ```
 */
function typeAliasCommentsStayBehindOperator(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** The second result of `writeCommentsAfterTypeAliasLeftSide`: whether a line comment is on the line of the `=`. */
const LEFT_SIDE_LINE_COMMENT = new Int32Array(1);

/**
 * What oxc's `AssignmentLike::fmt` does with the comments between the two sides of a type alias: it writes those that trail the left side.
 * Returns whether there are comments to write behind the `=` (the range `[cm.from, cm.to)`); `LEFT_SIDE_LINE_COMMENT[0]` is set to whether a
 * line comment is on the line of the `=`.
 */
function writeCommentsAfterTypeAliasLeftSide(alias: number, leftEnd: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  LEFT_SIDE_LINE_COMMENT[0] = 0;
  typeSpan(aliasTy(alias));
  if (!cm.hasAnyCommentIn(leftEnd, SP.s0 | 0)) return false;
  const operatorEnd = cm.positionAfterCharacter(leftEnd, 61);
  const previousLimit = cm.limitCommentsUpTo(operatorEnd);
  writeCommentsBeforeOperator(leftEnd, f);
  cm.restoreViewLimit(previousLimit);
  const hasRun = operatorLineRun(operatorEnd, f);
  LEFT_SIDE_LINE_COMMENT[0] = hasRun || cm.hasPrintedLineCommentAfter(leftEnd) ? 1 : 0;
  return hasRun;
}

/**
 * `operator_line_run`: the comments behind the operator, which ends at `operatorEnd`, up to a line comment that ends its line. None if a
 * comment from before the operator is left: then all lead the right side. Returns whether there are any; the range is `[cm.from, cm.to)`.
 */
function operatorLineRun(operatorEnd: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  if (cm.hasCommentBefore(operatorEnd)) return false;
  const n = cm.endOfLineCommentsAfter(operatorEnd);
  if (n > 0 && cm.isLine(cm.to - 1)) return true;
  return false;
}

/**
 * Of the comments that are left between the name of a type alias, which ends at `start`, and the first `=` after it, those that trail the
 * left side. All others lead the type (Prettier's `handleAssignmentLikeComments`, for which the `=` of a default type is as good as any).
 * The range is `[cm.from, cm.to)`.
 */
function commentsBeforeTypeAliasOperator(start: number, ty: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  cm.commentsBeforeCharacter(start, 61);
  const from = cm.from;
  const to = cm.to;
  const isObject = typeTag(ty) === TYPE_OBJECT;
  let count = 0;
  while (from + count < to) {
    const i = from + count;
    if (cm.precededByNewline(i) || (cm.followedByNewline(i) && (isObject || cm.isBlock(i)))) break;
    count = (count + 1) | 0;
  }
  cm.from = from;
  cm.to = from + count;
}

function isGeneric(ty: number): boolean {
  switch (typeTag(ty)) {
    case TYPE_FN: {
      const func = typeFnFn(ty);
      return funcKind(func) === FN_FUNCTION_TYPE && funcTypeParamsLen(func) > 0;
    }
    case TYPE_REF:
      return typeRefArgsLen(ty) > 0;
    default:
      return false;
  }
}

/** Prettier's `chooseLayout` for the type alias `alias`, whose type is `ty`. */
function typeAliasLayout(statement: number, alias: number, ty: number, tyStart: number, tyEnd: number, f: Formatter): number {
  const cx = cxOf(f);
  const cm = cx.comments;
  const isOxfmt = typeAliasCommentsStayBehindOperator(f);
  const tag = typeTag(ty);
  let shouldBreakAfterOperator = false;
  if (tag === TYPE_UNION && !unionBreaksOnePerLine(f) && !shouldHugType(ty, typeUnionTypesStart(ty), typeUnionTypesLen(ty), f)) {
    shouldBreakAfterOperator = true;
  } else if (isOxfmt && !cx.isQuiet && anyCommentBefore(tyStart, true, false, f)) {
    shouldBreakAfterOperator = true;
  } else if (tag === TYPE_UNION && isOxfmt && unionPrintsItself(ty, f)) {
    if (cx.isQuiet) shouldBreakAfterOperator = false;
    else {
      cm.commentsBefore(tyStart);
      shouldBreakAfterOperator = typeAliasUnionBreaksAfterOperator(statement, cm.from, cm.to, f);
    }
  } else if (isOxfmt && cm.hasLeadingOwnLineComment(tyStart)) {
    shouldBreakAfterOperator = true;
  } else if (tag === TYPE_COND && (f.options.experimentalTernaries || isGeneric(typeCondCheck(ty)) || isGeneric(typeCondExtends(ty)))) {
    shouldBreakAfterOperator = true;
  } else if (tag === TYPE_STRING_LIT && fileIsJavascript()) {
    // Flow's `StringLiteralTypeAnnotation`
    shouldBreakAfterOperator = true;
  } else {
    shouldBreakAfterOperator = !cx.isQuiet && anyCommentBefore(tyStart, false, true, f);
  }
  void tyEnd;
  if (shouldBreakAfterOperator) return ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR;
  // Prettier's `isComplexTypeAliasParams`.
  const tpStart = aliasTypeParamsStart(alias);
  const tpLen = aliasTypeParamsLen(alias);
  if (tpLen > 1) {
    for (let i = 0; i < tpLen; i++) {
      const param = listAt(tpStart, i);
      if (typeParamConstraint(param) >= 0 || typeParamDefault(param) >= 0) return ASSIGNMENT_LIKE_LAYOUT_BREAK_LEFT_HAND_SIDE;
    }
  }
  // It is up to the union where it breaks, also if it has nowhere to.
  if (unionBreaksOnePerLine(f) && unionPrintsItself(ty, f)) return ASSIGNMENT_LIKE_LAYOUT_NEVER_BREAK_AFTER_OPERATOR;
  return ASSIGNMENT_LIKE_LAYOUT_FLUID;
}

/** Whether one of the comments before `pos` is an indentable block (`indentable`), or ends its line / is an indentable block (`endsLine`). */
function anyCommentBefore(pos: number, indentable: boolean, endsLine: boolean, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  cm.commentsBefore(pos);
  for (let i = cm.from; i < cm.to; i++) {
    if (indentable && cm.isIndentableBlock(i)) return true;
    if (endsLine && (cm.followedByNewline(i) || cm.isIndentableBlock(i))) return true;
  }
  return false;
}

/** `enum A { B, C = 1 }` */
export function writeTsEnumDeclaration(statement: number, declaration: number, f: Formatter): void {
  const cx = cxOf(f);
  const node = mkAn(AN_TS_ENUM_DECLARATION, statement);
  let isConst = false;
  const mStart = stmtModifiersStart(statement);
  const mLen = stmtModifiersLen(statement);
  for (let i = 0; i < mLen; i++) if (modifierFlagOf(listAt(mStart, i)) === FLAG_CONST) isConst = true;
  if (isDeclared(statement)) f.token(KW_DECLARE);
  if (isConst) f.token(KW_CONST);
  f.token(KW_ENUM);
  f.space();
  const name = enumName(declaration);
  const namePos = enumNamePos(declaration);
  enumBodySpan(declaration);
  const SP$ = SP;
  const bodyStart = SP$.s0 | 0;
  const bodyEnd = SP$.s1 | 0;
  if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f)) {
    identSpan(name, namePos);
    writeIdentifierWithoutTrailingComments(name, namePos, SP$.s0 | 0, SP$.s1 | 0, node, f);
    writeHeadBodySeparator(bodyStart, f);
  } else {
    identifier(name, namePos, node, f);
    f.space();
    formatLeadingComments(bodyStart, bodyEnd, f);
  }
  if (fileIsFlow()) writeExplicitTypeOfEnum(declaration, f);
  writeTsEnumBody(declaration, bodyStart, bodyEnd, f);
}

function writeTsEnumBody(declaration: number, bodyStart: number, bodyEnd: number, f: Formatter): void {
  f.token(LBRACE);
  const membersStart = enumMembersStart(declaration);
  const membersLen = enumMembersLen(declaration);
  const SP$ = SP;
  if (membersLen === 0) {
    // Prettier's `printObject`: the group of an enum breaks, with nothing in it as well.
    formatDanglingComments(bodyStart, bodyEnd, DANGLING_SOFT, f);
    f.expandParent();
  } else {
    const cx = cxOf(f);
    const isConsistent = f.options.quoteProperties === QUOTE_PROPS_CONSISTENT;
    if (isConsistent) {
      let quoteNeeded = false;
      for (let i = 0; i < membersLen; i++) {
        const member = listAt(membersStart, i);
        const key = nodeOfEnumMember(member);
        if (keyKind(key) !== KEY_NONE && keyRequiresQuotes(key, mkAn(AN_TS_ENUM_MEMBER, member), f)) {
          quoteNeeded = true;
          break;
        }
      }
      cx.pushQuoteNeeded(quoteNeeded);
    }
    f.startBlockIndent();
    const separator = isUnknownMembersMark(listAt(membersStart, membersLen - 1)) ? TRAILING_SEPARATOR_DISALLOWED : trailingSeparator(FTC_ES5, f.options);
    for (let i = 0; i < membersLen; i++) {
      const member = listAt(membersStart, i);
      if (i > 0) {
        enumMemberSpan(member);
        joinNodesSeparator(f, JOIN_SOFT_LINE, SP$.s0 | 0, SP$.s1 | 0);
      }
      fmtEnumMember(member, f);
      writeSeparatorAfter(f, COMMA, i === membersLen - 1, separator, 0);
    }
    f.endBlockIndent();
    if (isConsistent) cx.popQuoteNeeded();
  }
  f.token(RBRACE);
}

/** `A`, `A = 1`, `"a" = 1` */
export function writeTsEnumMember(member: number, f: Formatter): void {
  if (isUnknownMembersMark(member)) {
    f.token(ELLIPSIS);
    return;
  }
  const key = nodeOfEnumMember(member);
  if (keyKind(key) !== KEY_NONE) {
    // `["a"]` is `"a"`. Only a template keeps its brackets.
    let isComputed = false;
    if (keyIsComputed(key) && keyInnerSpan(key)) isComputed = (cxOf(f).src.byteAt(SP.s0 | 0) | 0) === 96;
    if (isComputed) f.token(LBRACKET);
    fmtKey(key, mkAn(AN_TS_ENUM_MEMBER, member), f);
    if (isComputed) f.token(RBRACKET);
  }
  const init = enumMemberInit(member);
  if (init >= 0) {
    f.space();
    f.token(EQ);
    f.space();
    fmtExpr(init, f);
  }
}

/** `namespace A.B { .. }`, `declare module "a" { .. }`, `declare global { .. }` */
export function writeTsModuleDeclaration(statement: number, module: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const node = stmtAsAstNodes(statement);
  const innermost = moduleInnermost(module);
  const hasBody = moduleBodySpan(innermost);
  const SP$ = SP;
  const bodyStart = SP$.s0 | 0;
  const bodyEnd = SP$.s1 | 0;
  if (isDeclared(statement)) f.token(KW_DECLARE);

  // Which of the comments after the name trail it depends on the body.
  moduleNameSpan(innermost);
  const nameEnd = SP$.s1 | 0;
  const hasLimit = !cx.isQuiet;
  const viewLimit = hasLimit ? cm.limitCommentsUpTo(nameEnd) : -1;
  const kind = moduleNameKind(module);
  if (kind === MODNAME_GLOBAL) {
    moduleNameSpan(module);
    cm.commentsBefore(SP$.s0 | 0);
    formatLeadingCommentsRange(cm.from, cm.to, f);
    f.token(KW_GLOBAL);
  } else if (kind === MODNAME_STRING) {
    f.token(KW_MODULE);
    f.space();
    identSpan(moduleName(module), moduleNamePos(module));
    fmtStringLiteralOf(SP$.s0 | 0, SP$.s1 | 0, node, f);
  } else if (kind === MODNAME_IDENT) {
    f.token(moduleUsesModuleKeyword(module) ? KW_MODULE : KW_NAMESPACE);
    f.space();
    identifier(moduleName(module), moduleNamePos(module), node, f);
  }
  let current = module;
  while (true) {
    const nested = moduleNested(current);
    if (nested < 0) break;
    if (moduleNameKind(nested) === MODNAME_IDENT) {
      f.token(DOT);
      identifier(moduleName(nested), moduleNamePos(nested), node, f);
    }
    current = nested;
  }
  if (hasLimit) {
    cm.restoreViewLimit(viewLimit);
    if (!(hasBody && commentsStayBetweenHeadAndBody(f))) {
      stmtSpan(statement);
      const sStart = SP$.s0 | 0;
      const sEnd = SP$.s1 | 0;
      moduleNameSpan(innermost);
      formatTrailingComments(sStart, sEnd, SP$.s0 | 0, SP$.s1 | 0, hasBody ? bodyStart : 0, f);
    }
  }

  if (!hasBody) {
    optionalSemicolon(f);
    return;
  }
  if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f)) writeHeadBodySeparator(bodyStart, f);
  else f.space();
  // format_node(span, || node, f, |f| ..)
  if (cx.isQuiet) {
    writeModuleBody(module, innermost, bodyStart, bodyEnd, f);
    return;
  }
  const isSuppressed = cm.isSuppressed(bodyStart) || cm.hasTrailingSuppressionComment(bodyEnd);
  formatLeadingComments(bodyStart, bodyEnd, f);
  if (isSuppressed) writeSuppressedNode(bodyStart, bodyEnd, f);
  else {
    const outer = enterScope(cx, bodyStart, bodyEnd);
    writeModuleBody(module, innermost, bodyStart, bodyEnd, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(bodyStart, bodyEnd, PK_PARENT, node, f);
}

function writeModuleBody(module: number, innermost: number, bodyStart: number, bodyEnd: number, f: Formatter): void {
  f.token(LBRACE);
  const start = moduleBodyStart(innermost);
  const len = moduleBodyLen(innermost);
  if (isEmptyBlock(start, len)) {
    // Prettier's `printBlock` does not know Flow's `declare namespace`.
    if (fileIsFlow() && !moduleUsesModuleKeyword(module) && !cxOf(f).comments.hasCommentInRange(bodyStart, bodyEnd)) {
      f.hardLineBreak();
    } else {
      formatDanglingComments(bodyStart, bodyEnd, DANGLING_BLOCK, f);
    }
  } else {
    f.startBlockIndent();
    fmtStatements(start, len, f);
    f.endBlockIndent();
  }
  f.token(RBRACE);
}

/** `require(/* comment *&#47; "a")` is on three lines for oxfmt, whatever the comment is. */
function requireWithCommentBreaks(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `import a = require("a")`, `import a = b.c` */
export function writeTsImportEqualsDeclaration(statement: number, imp: number, f: Formatter): void {
  const cx = cxOf(f);
  const node = mkAn(AN_TS_IMPORT_EQUALS_DECLARATION, statement);
  f.token(KW_IMPORT);
  f.space();
  if ((importEqualsFlags(imp) & FLAG_TYPE_ONLY) !== 0) f.token(KW_TYPE_SPACE);
  identifier(importEqualsName(imp), importEqualsNamePos(imp), node, f);
  f.space();
  f.token(EQ);
  f.space();
  const SP$ = SP;
  if (importEqualsTargetKind(imp) === IET_ENTITY) {
    entityName(importEqualsEntityStart(imp), importEqualsEntityLen(imp), node, f);
  } else if (importEqualsRequireSpan(imp)) {
    const requireStart = SP$.s0 | 0;
    const requireEnd = SP$.s1 | 0;
    if (stmtModuleSpecifierSpan(statement)) {
      const specStart = SP$.s0 | 0;
      const specEnd = SP$.s1 | 0;
      // format_node(require_span, || node, f, |f| ..)
      const cm = cx.comments;
      if (cx.isQuiet) {
        writeRequire(specStart, specEnd, node, requireStart, requireEnd, f);
      } else {
        const isSuppressed = cm.isSuppressed(requireStart) || cm.hasTrailingSuppressionComment(requireEnd);
        formatLeadingComments(requireStart, requireEnd, f);
        if (isSuppressed) writeSuppressedNode(requireStart, requireEnd, f);
        else {
          const outer = enterScope(cx, requireStart, requireEnd);
          writeRequire(specStart, specEnd, node, requireStart, requireEnd, f);
          leaveScope(cx, outer);
        }
        writeTrailingCommentsIn(requireStart, requireEnd, PK_PARENT, node, f);
      }
    }
  }
  optionalSemicolon(f);
}

function writeRequire(specStart: number, specEnd: number, node: number, requireStart: number, requireEnd: number, f: Formatter): void {
  const hasComment = cxOf(f).comments.hasCommentInRange(requireStart, requireEnd);
  if (hasComment && requireWithCommentBreaks(f)) {
    f.token(KW_REQUIRE_PAREN);
    f.startBlockIndent();
    fmtModuleSpecifier(specStart, specEnd, node, requireStart, requireEnd, f);
    f.endBlockIndent();
    f.token(RPAREN);
  } else if (hasComment) {
    f.startGroup();
    f.token(KW_REQUIRE_PAREN);
    f.startSoftBlockIndent();
    fmtModuleSpecifier(specStart, specEnd, node, requireStart, requireEnd, f);
    f.endSoftBlockIndent();
    f.token(RPAREN);
    f.endGroup();
  } else {
    f.token(KW_REQUIRE_PAREN);
    fmtModuleSpecifier(specStart, specEnd, node, requireStart, requireEnd, f);
    f.token(RPAREN);
  }
}

/** `export = a` */
export function writeTsExportAssignment(expression: number, f: Formatter): void {
  f.token(KW_EXPORT_ASSIGN);
  fmtExpr(expression, f);
  optionalSemicolon(f);
}

/** `export as namespace a` */
export function writeTsNamespaceExportDeclaration(statement: number, f: Formatter): void {
  f.token(KW_EXPORT_AS_NAMESPACE);
  const atom = stmtNamespaceExportName(statement);
  if (atom >= 0) identifier(atom, stmtNamespaceExportNamePos(statement), mkAn(AN_TS_NAMESPACE_EXPORT_DECLARATION, statement), f);
  optionalSemicolon(f);
}
