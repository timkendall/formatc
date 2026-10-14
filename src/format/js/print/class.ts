// Port of vendor/bun/src/format/js/print/class.rs.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { COMMA, DOUBLE_QUOTE, EMPTY_BRACES, LBRACE, LBRACKET, LPAREN, QUESTION, RBRACE, RBRACKET, RPAREN, SINGLE_QUOTE, ELLIPSIS, SEMI, EQ } from "../../ir/tokens.ts";
import {
  FLAVOR_OXFMT,
  FTC_ES5,
  QUOTE_PROPS_AS_NEEDED,
  QUOTE_PROPS_CONSISTENT,
  QUOTE_PROPS_PRESERVE,
  QUOTE_SINGLE,
  SEMICOLONS_ALWAYS,
  TRAILING_SEPARATOR_DISALLOWED,
  trailingSeparator,
} from "../../options.ts";
import {
  EXPR_DOT,
  EXPR_INDEX,
  EXPR_NON_NULL,
  FLAG_ABSTRACT,
  FLAG_AMBIENT,
  FLAG_IN,
  FLAG_OPTIONAL,
  FLAG_OUT,
  FLAG_OVERRIDE,
  FLAG_PRIVATE,
  FLAG_PROTECTED,
  FLAG_PUBLIC,
  FLAG_READONLY,
  FLAG_STATIC,
  KEY_COMPUTED,
  KEY_IDENT,
  KEY_NONE,
  KEY_PRIVATE,
  MEMBER_GETTER,
  MEMBER_INDEX_SIGNATURE,
  MEMBER_METHOD,
  MEMBER_PROPERTY,
  MEMBER_SETTER,
  N_EXPR,
  SP,
  STMT_EMPTY,
  TYPE_HERITAGE,
  TYPE_REF,
  className,
  classNamePos,
  classExtends,
  classExtendsArgsLen,
  classExtendsArgsStart,
  classImplementsLen,
  classImplementsStart,
  classMembersLen,
  classMembersStart,
  classModifiersLen,
  classModifiersStart,
  classOwner,
  classBodySpan,
  classSpan,
  exprAsFn,
  exprEnd,
  exprIsChainRoot,
  exprNonNullExpr,
  exprOuterEnd,
  exprSpan,
  exprStart,
  exprTag,
  fileIsFlow,
  funcBodyKind,
  funcBodyStmtsLen,
  funcBodyStmtsStart,
  funcHasBody,
  funcIsAsync,
  funcIsGenerator,
  funcParamsLen,
  funcParamsStart,
  funcReturnType,
  funcTypeParamsLen,
  funcTypeParamsStart,
  hir,
  identSpan,
  keyIsComputed,
  keyLoad,
  keyName,
  listAt,
  memberConstructorKeyword,
  memberFlags,
  memberFunc,
  memberInit,
  memberKind,
  memberModifiersLen,
  memberModifiersStart,
  memberNamePos,
  memberParent,
  memberSpan,
  memberTy,
  modifierDecorator,
  modifierFlagOf,
  nameIs,
  nodeId,
  nodeKind,
  nodeOfClass,
  nodeOfFunc,
  nodeOfMember,
  paramDefault,
  paramIsOptional,
  paramIsRest,
  paramModifiersLen,
  paramModifiersStart,
  paramPat,
  paramTy,
  patSpan,
  stmtTag,
  typeHeritageArgsLen,
  typeHeritageExpr,
  typeParamListAngleBrackets,
  typeRefArgsLen,
  typeRefNameLen,
  typeSpan,
  typeTag,
  BODY_BLOCK,
  identEndOf as identEnd,
  classTypeParamsLen as classTypeParamsLenOf,
  classTypeParamsStart as funcTypeParamsStartOfClass,
  typeListAngleBrackets,
} from "../../../lint/ast/index.ts";
import {
  AN_ACCESSOR_PROPERTY,
  AN_ASSIGNMENT_EXPRESSION,
  AN_CLASS_BODY,
  AN_EXPORT_DEFAULT_DECLARATION,
  AN_EXPORT_NAMED_DECLARATION,
  AN_METHOD_DEFINITION,
  AN_PROPERTY_DEFINITION,
  AN_STATIC_BLOCK,
  AN_TS_INDEX_SIGNATURE,
  anParent,
  anSpan,
  anTag,
  classAsAstNodes,
  exprAstParent,
  memberAsAstNodes,
  paramAsAstNodes,
  mkAn,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { enterScope, leaveScope, fmtExpr as fmtExprLocal } from "../format.ts";
import { enterNode, extendNode } from "../../cursor_region.ts";
import {
  PK_PARENT,
  PK_NODE,
  WK_EXPR,
  WK_TYPE,
  WK_TYPE_ANNOTATION,
  fmtMember,
  fmtMemberBeforeAnother,
  fmtType,
  fmtTypeAnnotation,
  identifier,
  noCommentTrailsWhatIsBeforeAnother,
  terminatorOfWhatIsIgnoredFollowsSemi,
  writeTrailingCommentsIn,
  writeTrailingCommentsOf,
} from "../format.ts";
import { linesBefore } from "../builders.ts";
import { needsParentheses } from "../parentheses/expression.ts";
import {
  DANGLING_BLOCK,
  DANGLING_NONE,
  commentsStayBetweenHeadAndBody,
  formatDanglingComments,
  formatDanglingCommentsRange,
  formatLeadingComments,
  formatLeadingCommentsRange,
  formatTrailingCommentsRange,
  writeHeadBodySeparator,
} from "../trivia.ts";
import {
  ASSIGNMENT_LIKE_ACCESSOR_PROPERTY,
  ASSIGNMENT_LIKE_PROPERTY_DEFINITION,
  fmtAssignmentLike,
} from "../utils/assignment_like.ts";
import { fmtNodeWithoutTrailingComments } from "../utils/format_node_without_trailing_comments.ts";
import { formatComputedOrPropertyKey, keyRequiresQuotes } from "../utils/object.ts";
import { STRING_LITERAL_PARENT_KIND_EXPRESSION, fmtLiteralStringToken } from "../utils/string.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { fmtDecorators, fmtDecoratorsOfMember } from "./decorators.ts";
import { fmtCommentsBehindParenthesis, fmtFunctionBody, shouldGroupFunctionParameters } from "./function.ts";
import { writeAccessorKeyword } from "./function_type.ts";
import { writeObjectTypeMember, writeClass as writeFlowClass } from "./flow.ts";
import { fmtFormalParameters } from "./parameters.ts";
import { fmtStatements } from "./program.ts";
import { optionalSemicolon, startOfCommentsInDroppedParentheses } from "./semicolon.ts";
import { writeTsSignature } from "./ts_types.ts";
import { typeArgumentsWithoutComments, typeParameters, typeParametersWithoutComments } from "./type_parameters.ts";

const T_PUBLIC = token("public ");
const T_PROTECTED = token("protected ");
const T_PRIVATE = token("private ");
const T_STATIC_SP = token("static ");
const T_ABSTRACT_SP = token("abstract ");
const T_OVERRIDE_SP = token("override ");
const T_ASYNC = token("async ");
const T_STAR = token("*");
const T_STATIC = token("static");
const T_READONLY = token("readonly");
const T_DECLARE = token("declare");
const T_ABSTRACT = token("abstract");
const T_CLASS = token("class");
const T_EXTENDS = token("extends");
const T_IMPLEMENTS = token("implements");

function memberHasFlag(member: number, flag: number): boolean {
  const s = memberModifiersStart(member);
  const n = memberModifiersLen(member);
  for (let i = 0; i < n; i++) if (modifierFlagOf(listAt(s, i)) === flag) return true;
  return false;
}

function classHasFlag(cls: number, flag: number): boolean {
  const s = classModifiersStart(cls);
  const n = classModifiersLen(cls);
  for (let i = 0; i < n; i++) if (modifierFlagOf(listAt(s, i)) === flag) return true;
  return false;
}

function classHasDecorator(cls: number): boolean {
  const s = classModifiersStart(cls);
  const n = classModifiersLen(cls);
  for (let i = 0; i < n; i++) if (modifierDecorator(listAt(s, i)) >= 0) return true;
  return false;
}

function memberHasKey(member: number): boolean {
  return keyLoadKind(member) !== KEY_NONE;
}

function keyLoadKind(member: number): number {
  return keyLoad(nodeOfMember(member));
}

/** The `{ .. }` of a class that has members. */
function writeClassBody(cls: number, f: Formatter): void {
  const cx = cxOf(f);
  const isConsistent = f.options.quoteProperties === QUOTE_PROPS_CONSISTENT;
  const ms = classMembersStart(cls);
  const mn = classMembersLen(cls);
  if (isConsistent) {
    let quoteNeeded = false;
    for (let i = 0; i < mn; i++) {
      const member = listAt(ms, i);
      const k = memberKind(member);
      if ((k === MEMBER_PROPERTY || k === MEMBER_METHOD || k === MEMBER_GETTER || k === MEMBER_SETTER) && memberHasKey(member)) {
        if (keyRequiresQuotes(nodeOfMember(member), memberAsAstNodes(member), f)) {
          quoteNeeded = true;
          break;
        }
      }
    }
    cx.pushQuoteNeeded(quoteNeeded);
  }

  f.token(LBRACE);
  f.startBlockIndent();
  for (let i = 0; i < mn; i++) {
    const element = listAt(ms, i);
    memberSpan(element);
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    // `a = 1 ⏎ ⏎ ;[b] = 2`: the `;` is the end of the member before, which this one follows on the same line.
    const followsSemicolon = start !== 0 && cx.src.byteAt(start - 1) === 59;
    if (i > 0) {
      if (!followsSemicolon && linesBefore(start, end, f) > 1) f.emptyLine();
      else f.hardLineBreak();
    }
    writeClassElementWithSemicolon(element, i + 1 < mn ? listAt(ms, i + 1) : -1, f);
  }
  f.endBlockIndent();
  f.token(RBRACE);

  if (isConsistent) cx.popQuoteNeeded();
}

/** A member of a class, an interface or a type literal. */
export function writeMember(member: number, f: Formatter): void {
  switch (anTag(memberAsAstNodes(member))) {
    case AN_METHOD_DEFINITION:
      writeMethodDefinition(member, f);
      return;
    case AN_PROPERTY_DEFINITION:
      fmtAssignmentLike(ASSIGNMENT_LIKE_PROPERTY_DEFINITION, member, f);
      return;
    case AN_ACCESSOR_PROPERTY:
      fmtAssignmentLike(ASSIGNMENT_LIKE_ACCESSOR_PROPERTY, member, f);
      return;
    case AN_STATIC_BLOCK:
      writeStaticBlock(member, f);
      return;
    case AN_TS_INDEX_SIGNATURE:
      writeTsIndexSignature(member, f);
      return;
    default:
      writeTsSignature(member, f);
  }
}

function writeMethodDefinition(member: number, f: Formatter): void {
  const value = memberFunc(member);
  if (value < 0) return;
  const cx = cxOf(f);
  const constructorKeyword = memberConstructorKeyword(member);
  if (memberModifiersLen(member) > 0) {
    fmtDecoratorsOfMember(member, f);
    if (memberHasFlag(member, FLAG_PUBLIC)) f.token(T_PUBLIC);
    if (memberHasFlag(member, FLAG_PROTECTED)) f.token(T_PROTECTED);
    if (memberHasFlag(member, FLAG_PRIVATE)) f.token(T_PRIVATE);
    if (memberHasFlag(member, FLAG_STATIC)) f.token(T_STATIC_SP);
    if (memberHasFlag(member, FLAG_ABSTRACT)) f.token(T_ABSTRACT_SP);
    // An error, and not in typescript-estree's tree.
    const isDropped = constructorKeyword >= 0 && !constructorKeepsOverride(f);
    if (memberHasFlag(member, FLAG_OVERRIDE) && !isDropped) f.token(T_OVERRIDE_SP);
  }
  writeAccessorKeyword(memberKind(member), f);
  if (funcIsAsync(value)) f.token(T_ASYNC);
  if (funcIsGenerator(value)) f.token(T_STAR);
  const node = mkAn(AN_METHOD_DEFINITION, member);
  if (constructorKeyword >= 0) writeConstructorKeyword(constructorKeyword, memberNamePos(member), node, f);
  else if (memberHasKey(member)) formatComputedOrPropertyKey(nodeOfMember(member), node, f);
  if ((memberFlags(member) & FLAG_OPTIONAL) !== 0) f.token(QUESTION);

  formatGroupedParametersWithReturnTypeForMethod(value, f);

  if (funcHasBody(value)) {
    fmtFunctionBody(value, f);
    return;
  }
  if (!cx.isQuiet && !allCommentsBeforeSemicolonGoBehindIt(f)) {
    const cm = cx.comments;
    memberSpan(member);
    const limit = cm.startOfCommentsBeforeSemicolon(-1, SP[0] | 0, SP[1] | 0);
    cm.commentsBefore(limit);
    formatTrailingCommentsRange(cm.from, cm.to, f);
  }
  optionalSemicolon(f);
}

/**
 * `#a = 1 /* comment *&#47;;` stays as it is in JavaScript: Babel's `ClassPrivateProperty` is not in the list of Prettier's
 * `handleMethodNameComments`, so the comment trails the value.
 */
function isNoPropertyToHandleMethodNameComments(member: number, f: Formatter): boolean {
  return cxOf(f).hasTreeOfBabel && f.options.flavor !== FLAVOR_OXFMT && keyLoadKind(member) === KEY_PRIVATE;
}

/**
 * For oxfmt all comments between a member and its `;` are behind the `;`. For Prettier those that end or start their line are in the
 * member: see `Comments::start_of_comments_before_semicolon`.
 */
function allCommentsBeforeSemicolonGoBehindIt(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

function constructorKeepsOverride(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** What `writeConstructorKeyword` writes inside `format_node`. */
const CK_UNQUOTED: number = 0;
const CK_STRING: number = 1;
const CK_QUOTED: number = 2;

/** `format_node(span, || parent, f, write)` for the name of a constructor. `parent`: an `AstNodes`, the parent of the name. */
function formatConstructorName(what: number, start: number, end: number, parent: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    writeConstructorName(what, start, end, f);
    return;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) {
    enterNode(start, end, f);
    writeSuppressedNode(start, end, f);
    extendNode(start, end, f);
  } else {
    const outer = enterScope(cx, start, end);
    writeConstructorName(what, start, end, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_PARENT, parent, f);
}

function writeConstructorName(what: number, start: number, end: number, f: Formatter): void {
  if (what === CK_UNQUOTED) f.sourceText(start + 1, end - 1);
  else if (what === CK_STRING) fmtLiteralStringToken(start, end, false, STRING_LITERAL_PARENT_KIND_EXPRESSION, f);
  else {
    const quote = f.options.quoteStyle === QUOTE_SINGLE ? SINGLE_QUOTE : DOUBLE_QUOTE;
    f.token(quote);
    f.sourceText(start, end);
    f.token(quote);
  }
}

/** `constructor`, which can be written as a string, and is quoted like any other name. */
function writeConstructorKeyword(atom: number, pos: number, node: number, f: Formatter): void {
  const cx = cxOf(f);
  identSpan(atom, pos);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const text = f.source;
  const first = text[start] | 0;
  if (first === 34 || first === 39) {
    // Not `"\x63onstructor"`.
    const isName = end - start === 13 && textIs(text, start + 1, "constructor");
    let isUnquoted = false;
    if (isName) {
      const qp = f.options.quoteProperties;
      if (qp === QUOTE_PROPS_AS_NEEDED) isUnquoted = true;
      else if (qp === QUOTE_PROPS_PRESERVE) isUnquoted = false;
      else isUnquoted = !cx.isQuoteNeeded();
    }
    formatConstructorName(isUnquoted ? CK_UNQUOTED : CK_STRING, start, end, node, f);
  } else if (cx.isQuoteNeeded()) {
    formatConstructorName(CK_QUOTED, start, end, node, f);
  } else {
    identifier(atom, pos, node, f);
  }
}

function textIs(text: Uint8Array, at: number, lit: string): boolean {
  for (let i = 0; i < lit.length; i++) if ((text[(at + i) | 0] | 0) !== lit.charCodeAt(i)) return false;
  return true;
}

/** `static { ; }` is `static {}` for Prettier. oxfmt breaks the line between the braces. */
function blockOfEmptyStatementsIsEmpty(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/** `static { .. }` */
function writeStaticBlock(member: number, f: Formatter): void {
  f.token(T_STATIC);
  f.space();
  f.token(LBRACE);
  const func = memberFunc(member);
  let hasBody = false;
  if (func >= 0 && funcBodyKind(func) === BODY_BLOCK) {
    const s = funcBodyStmtsStart(func);
    const n = funcBodyStmtsLen(func);
    let isEmpty: boolean;
    if (blockOfEmptyStatementsIsEmpty(f)) {
      isEmpty = true;
      for (let i = 0; i < n; i++) {
        if (stmtTag(listAt(s, i)) !== STMT_EMPTY) {
          isEmpty = false;
          break;
        }
      }
    } else {
      isEmpty = n === 0;
    }
    if (!isEmpty) {
      hasBody = true;
      f.startBlockIndent();
      fmtStatements(s, n, f);
      f.endBlockIndent();
    }
  }
  if (!hasBody) {
    memberSpan(member);
    formatDanglingComments(SP[0] | 0, SP[1] | 0, DANGLING_BLOCK, f);
  }
  f.token(RBRACE);
}

/** `[key: string]: T` */
function writeTsIndexSignature(member: number, f: Formatter): void {
  if (fileIsFlow()) {
    writeObjectTypeMember(member, f);
    return;
  }
  const signature = memberFunc(member);
  if (signature < 0) return;
  const node = mkAn(AN_TS_INDEX_SIGNATURE, member);
  if (memberHasFlag(member, FLAG_STATIC)) {
    f.token(T_STATIC);
    f.space();
  }
  if (memberHasFlag(member, FLAG_READONLY)) {
    f.token(T_READONLY);
    f.space();
  }
  const ps = funcParamsStart(signature);
  const pn = funcParamsLen(signature);
  // With one parameter it is more like a computed name than a list: no trailing comma.
  const ts = pn > 1 ? trailingSeparator(FTC_ES5, f.options) : TRAILING_SEPARATOR_DISALLOWED;
  const isClass = anTag(anParent(node)) === AN_CLASS_BODY;
  f.token(LBRACKET);
  f.startGroup();
  f.startSoftBlockIndent();
  for (let i = 0; i < pn; i++) {
    if (i > 0) f.softLineBreakOrSpace();
    writeIndexSignatureName(listAt(ps, i), f);
    writeSeparatorAfterEntry(i === pn - 1, ts, f);
  }
  f.endSoftBlockIndent();
  f.endGroup();
  f.token(RBRACKET);
  const rt = funcReturnType(signature);
  if (rt >= 0) fmtTypeAnnotation(rt, f);
  if (isClass) optionalSemicolon(f);
}

function writeSeparatorAfterEntry(isLast: boolean, ts: number, f: Formatter): void {
  // (writeSeparatorAfter of builders.ts, inlined for the three values that can come here)
  if (!isLast) f.token(COMMA);
  else if (ts === 0) f.tokenIfBreaks(COMMA);
  else if (ts === 2) f.token(COMMA);
}

/** The `key: string` of an index signature. */
function writeIndexSignatureName(param: number, f: Formatter): void {
  const cx = cxOf(f);
  const node = paramAsAstNodes(param);
  anSpan(node);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  if (cx.isQuiet) {
    writeIndexSignatureNameBody(param, f);
    return;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) {
    enterNode(start, end, f);
    writeSuppressedNode(start, end, f);
    extendNode(start, end, f);
  } else {
    const outer = enterScope(cx, start, end);
    writeIndexSignatureNameBody(param, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_NODE, node, f);
}

function writeIndexSignatureNameBody(param: number, f: Formatter): void {
  if (paramIsRest(param)) f.token(ELLIPSIS);
  patSpan(paramPat(param));
  f.sourceText(SP[0] | 0, SP[1] | 0);
  if (paramIsOptional(param)) f.token(QUESTION);
  const ty = paramTy(param);
  if (ty >= 0) fmtTypeAnnotation(ty, f);
  // An error.
  const d = paramDefault(param);
  if (d >= 0) {
    f.space();
    f.token(EQ);
    f.space();
    fmtExprLocal(d, f);
  }
}

/** `a = class extends (⏎ b.C<D> ⏎) {}`. For Prettier the parentheses are around `b.C`, and `<D>` is behind them. */
function typeArgumentsOfSuperClassAreInItsParentheses(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** The types after `implements`, or after the `extends` of an interface. */
export function fmtClassImplements(typesStart: number, typesLen: number, f: Formatter): void {
  const lastIndex = typesLen > 0 ? typesLen - 1 : 0;
  for (let i = 0; i < typesLen; i++) {
    if (i > 0) f.softLineBreakOrSpace();
    const heritage = listAt(typesStart, i);
    // The comments after the last are written in the body.
    if (i === lastIndex) fmtNodeWithoutTrailingComments(WK_TYPE, heritage, f);
    else {
      fmtType(heritage, f);
      f.token(COMMA);
    }
  }
}

/** A class declaration or expression. */
export function writeClass(cls: number, f: Formatter): void {
  const owner = classOwner(cls);
  if (nodeKind(owner) === N_EXPR && classHasDecorator(cls) && needsParentheses(nodeId(owner), f)) {
    const e = nodeId(owner);
    if (anTag(exprAstParent(e)) === AN_EXPORT_DEFAULT_DECLARATION && decoratorsInExportStartALine(f)) {
      f.startIndent();
      f.emptyLine();
      writeClassBody0(cls, f);
      f.endIndent();
      f.softLineBreak();
    } else {
      f.startSoftBlockIndent();
      writeClassBody0(cls, f);
      f.endSoftBlockIndent();
    }
    return;
  }
  writeClassBody0(cls, f);
}

/** Prettier's `printDecorators` starts with a line break in an `export`, also behind the line break after the parenthesis of `export default (@a class {})`. */
function decoratorsInExportStartALine(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

// ───────────────────────────── the head of a class ─────────────────────────────

const GAP_ANGLE_BRACKET: number = 0;
const GAP_EXTENDS: number = 1;
const GAP_IMPLEMENTS: number = 2;

const AFTER_NAME: number = 0;
const AFTER_TYPE_PARAMETERS: number = 1;
const AFTER_SUPER_CLASS: number = 2;
const AFTER_SUPER_TYPE_ARGUMENTS: number = 3;

/** Between two parts of the head of a class: where the first ends, where the second starts, what the second is (`GAP_*`) and its flag. */
const G = new Int32Array(4);

/**
 * Fills `G` with the gap `which` (`AFTER_*`) of the head of `cls`: false if the `{` is next, or the part before it is not there. The
 * flag: for `GAP_EXTENDS`, it is an optional chain, which Prettier attaches no comments to, so what follows the comment is not the super
 * class, and `handleClassComments` has nothing to say; for `GAP_IMPLEMENTS`, what is before it is the name, the type parameters or the
 * super class, as opposed to its type arguments or what is in an optional chain.
 */
function headGap(cls: number, which: number): boolean {
  const extendsExpr = classExtends(cls);
  const isChain = extendsExpr >= 0 && exprIsChainRoot(extendsExpr);
  const implementsLen = classImplementsLen(cls);
  const hasTypeParameters = typeParamListAngleBrackets(funcTypeParamsStartOfClass(cls), classTypeParamsLenOf(cls));
  let tpStart = 0;
  let tpEnd = 0;
  if (hasTypeParameters) {
    tpStart = SP[0] | 0;
    tpEnd = SP[1] | 0;
  }
  const hasTypeArguments = typeListAngleBracketsOfClass(cls);
  let taStart = 0;
  let taEnd = 0;
  if (hasTypeArguments) {
    taStart = SP[0] | 0;
    taEnd = SP[1] | 0;
  }
  let nextStart = -1;
  let nextKind = 0;
  let nextFlag = 0;
  let prevEnd = -1;
  // implements(follows_known_part)
  let implementsStart = -1;
  if (implementsLen > 0) {
    typeSpan(listAt(classImplementsStart(cls), 0));
    implementsStart = SP[0] | 0;
  }
  let extendsStart = -1;
  if (extendsExpr >= 0) {
    extendsStart = exprStart(extendsExpr);
  }
  switch (which) {
    case AFTER_NAME: {
      const name = className(cls);
      if (name < 0) return false;
      prevEnd = identEnd(name, classNamePos(cls));
      if (hasTypeParameters) {
        nextStart = tpStart;
        nextKind = GAP_ANGLE_BRACKET;
      } else if (extendsStart >= 0) {
        nextStart = extendsStart;
        nextKind = GAP_EXTENDS;
        nextFlag = isChain ? 1 : 0;
      } else if (implementsStart >= 0) {
        nextStart = implementsStart;
        nextKind = GAP_IMPLEMENTS;
        nextFlag = 1;
      }
      break;
    }
    case AFTER_TYPE_PARAMETERS:
      if (!hasTypeParameters) return false;
      prevEnd = tpEnd;
      if (extendsStart >= 0) {
        nextStart = extendsStart;
        nextKind = GAP_EXTENDS;
        nextFlag = isChain ? 1 : 0;
      } else if (implementsStart >= 0) {
        nextStart = implementsStart;
        nextKind = GAP_IMPLEMENTS;
        nextFlag = 1;
      }
      break;
    case AFTER_SUPER_CLASS:
      if (extendsExpr < 0) return false;
      prevEnd = exprOuterEnd(extendsExpr);
      if (hasTypeArguments) {
        nextStart = taStart;
        nextKind = GAP_ANGLE_BRACKET;
      } else if (implementsStart >= 0) {
        nextStart = implementsStart;
        nextKind = GAP_IMPLEMENTS;
        nextFlag = isChain ? 0 : 1;
      }
      break;
    default:
      if (!hasTypeArguments) return false;
      prevEnd = taEnd;
      if (implementsStart >= 0) {
        nextStart = implementsStart;
        nextKind = GAP_IMPLEMENTS;
        nextFlag = 0;
      }
      break;
  }
  if (nextStart < 0) return false;
  G[0] = prevEnd;
  G[1] = nextStart;
  G[2] = nextKind;
  G[3] = nextFlag;
  return true;
}

/** `class.extends_args().angle_brackets_span()` into `SP`. */
function typeListAngleBracketsOfClass(cls: number): boolean {
  return typeListAngleBrackets(classExtendsArgsStart(cls), classExtendsArgsLen(cls));
}

/** Whether the text `[start, end)` of the source contains `keyword`. */
function sourceContains(start: number, end: number, keyword: string, f: Formatter): boolean {
  const text = f.source;
  const n = keyword.length;
  for (let i = start; i + n <= end; i++) {
    if (textIs(text, i, keyword)) return true;
  }
  return false;
}

/**
 * How many of the comments `[from, to)`, which are in the gap in `G`, trail what is before them. The others lead what follows. Prettier's
 * `handleClassComments`, and what it does with any comment.
 */
function countCommentsTrailingInHead(from: number, to: number, kind: number, flag: number, nextStart: number, f: Formatter): number {
  const cm = cxOf(f).comments;
  let count = 0;
  for (let i = from; i < to; i++) {
    const startsOrEndsLine = cm.precededByNewline(i) || cm.followedByNewline(i);
    let trailing: boolean;
    if (kind === GAP_ANGLE_BRACKET) {
      trailing = !cm.precededByNewline(i) && cm.followedByNewline(i);
    } else if (kind === GAP_EXTENDS) {
      trailing = startsOrEndsLine ? flag === 0 || !cm.precededByNewline(i) : sourceContains(cm.ce[i] | 0, nextStart, "extends", f);
    } else {
      trailing = startsOrEndsLine ? flag !== 0 : sourceContains(cm.ce[i] | 0, nextStart, "implements", f);
    }
    if (!trailing) break;
    count = (count + 1) | 0;
  }
  return count;
}

/** The comments in a gap that trail what is before them. */
function writeCommentsTrailingInHead(cls: number, which: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet || !headGap(cls, which)) return;
  const nextStart = G[1] | 0;
  const kind = G[2] | 0;
  const flag = G[3] | 0;
  const cm = cx.comments;
  cm.commentsBefore(nextStart);
  const from = cm.from;
  const count = countCommentsTrailingInHead(from, cm.to, kind, flag, nextStart, f);
  formatTrailingCommentsRange(from, from + count, f);
}

/** Prettier's `isMemberExpression(stripChainElementWrappers(e))`. */
function isMember(e0: number): boolean {
  let e = e0;
  while (exprTag(e) === EXPR_NON_NULL) e = exprNonNullExpr(e);
  const t = exprTag(e);
  return t === EXPR_DOT || t === EXPR_INDEX;
}

/** Prettier's `shouldPrintClassInGroupMode`: whether the head of the class is a group that can break before `extends` and `implements`. */
function shouldGroup(cls: number, parent: number, f: Formatter): boolean {
  const superClass = classExtends(cls);
  const implementsLen = classImplementsLen(cls);
  if ((superClass >= 0 ? 1 : 0) + implementsLen > 1) return true;

  let isMemberHeritage = false;
  if (superClass >= 0) {
    isMemberHeritage = anTag(parent) !== AN_ASSIGNMENT_EXPRESSION && classExtendsArgsLen(cls) === 0 && isMember(superClass);
  } else if (implementsLen > 0) {
    const first = listAt(classImplementsStart(cls), 0);
    const t = typeTag(first);
    if (t === TYPE_HERITAGE) isMemberHeritage = typeHeritageArgsLen(first) === 0 && isMember(typeHeritageExpr(first));
    else if (t === TYPE_REF) isMemberHeritage = typeRefArgsLen(first) === 0 && typeRefNameLen(first) > 1;
  }
  const cx = cxOf(f);
  if (isMemberHeritage || cx.isQuiet) return isMemberHeritage;

  // A comment trails the name or the type parameters, or is around the super class.
  const cm = cx.comments;
  let beforeSuperClass = 0;
  if (headGap(cls, AFTER_TYPE_PARAMETERS)) {
    if ((G[2] | 0) === GAP_EXTENDS) beforeSuperClass = gapCommentsNotTrailing(f);
  } else if (headGap(cls, AFTER_NAME)) {
    if ((G[2] | 0) === GAP_EXTENDS) beforeSuperClass = gapCommentsNotTrailing(f);
  } else if (superClass >= 0) {
    beforeSuperClass = cm.commentsBefore(exprStart(superClass));
  }
  if (gapTrailingCount(cls, AFTER_NAME, f) > 0) return true;
  if (gapTrailingCount(cls, AFTER_TYPE_PARAMETERS, f) > 0) return true;
  if (beforeSuperClass > 0) return true;
  return gapTrailingCount(cls, AFTER_SUPER_CLASS, f) > 0;
}

/** For the gap in `G`: the number of comments in it that lead what follows. */
function gapCommentsNotTrailing(f: Formatter): number {
  const cm = cxOf(f).comments;
  const prevEnd = G[0] | 0;
  const nextStart = G[1] | 0;
  const kind = G[2] | 0;
  const flag = G[3] | 0;
  const all = cm.commentsIn(prevEnd, nextStart);
  const trailing = countCommentsTrailingInHead(cm.from, cm.to, kind, flag, nextStart, f);
  return (all - trailing) | 0;
}

/** `counts(gap).1`: the number of comments in the gap that trail what is before them. */
function gapTrailingCount(cls: number, which: number, f: Formatter): number {
  if (!headGap(cls, which)) return 0;
  const cm = cxOf(f).comments;
  const prevEnd = G[0] | 0;
  const nextStart = G[1] | 0;
  const kind = G[2] | 0;
  const flag = G[3] | 0;
  cm.commentsIn(prevEnd, nextStart);
  return countCommentsTrailingInHead(cm.from, cm.to, kind, flag, nextStart, f);
}

/** `FormatNodeWithoutTrailingComments(&identifier(id, node))` */
function writeClassName(atom: number, pos: number, node: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    identifier(atom, pos, node, f);
    return;
  }
  identSpan(atom, pos);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const cm = cx.comments;
  if (cm.hasTrailingSuppressionComment(end)) {
    formatLeadingComments(start, end, f);
    writeSuppressedNode(start, end, f);
    return;
  }
  const previousLimit = cm.limitCommentsUpTo(end);
  identifier(atom, pos, node, f);
  cm.restoreViewLimit(previousLimit);
}

/** `type_arguments` of the super class, with the comments around them. */
function writeSuperTypeArguments(cls: number, f: Formatter): void {
  writeCommentsTrailingInHead(cls, AFTER_SUPER_CLASS, f);
  if (typeListAngleBracketsOfClass(cls)) {
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    formatLeadingComments(start, end, f);
    typeArgumentsWithoutComments(classExtendsArgsStart(cls), classExtendsArgsLen(cls), nodeOfClass(cls), f);
    writeCommentsTrailingInHead(cls, AFTER_SUPER_TYPE_ARGUMENTS, f);
  }
}

function writeClassBody0(cls: number, f: Formatter): void {
  if (fileIsFlow() && writeFlowClass(cls, f)) return;
  const cx = cxOf(f);
  const node = classAsAstNodes(cls);
  const parent = anParent(node);
  const isExpression = nodeKind(classOwner(cls)) === N_EXPR;
  const superClass = classExtends(cls);
  const implementsStart = classImplementsStart(cls);
  const implementsLen = classImplementsLen(cls);
  classBodySpan(cls);
  const bodyStart = SP[0] | 0;
  const membersLen = classMembersLen(cls);

  // Those of an exported class are written with the `export`, which they can be before.
  const pt = anTag(parent);
  if (isExpression || !(pt === AN_EXPORT_NAMED_DECLARATION || pt === AN_EXPORT_DEFAULT_DECLARATION)) {
    fmtDecorators(classModifiersStart(cls), classModifiersLen(cls), node, f);
  }
  if (classHasFlag(cls, FLAG_AMBIENT)) {
    f.token(T_DECLARE);
    f.space();
  }
  if (classHasFlag(cls, FLAG_ABSTRACT)) {
    f.token(T_ABSTRACT);
    f.space();
  }
  f.token(T_CLASS);

  const groupMode = shouldGroup(cls, parent, f);
  let heritageId = 0;
  if (groupMode) {
    heritageId = f.groupId();
    f.startGroupId(heritageId);
  }
  writeHead(cls, node, f);
  if (groupMode) f.startIndent();
  writeHeritageClauses(cls, parent, groupMode, f);
  if (groupMode) {
    f.endIndent();
    f.endGroup();
    // The `{` on a line of its own sets the members apart from a head that is broken.
    if (membersLen === 0) f.space();
    else {
      f.startIfGroupBreaksId(heritageId);
      f.hardLineBreak();
      f.endConditional();
      f.startIfGroupFitsId(heritageId);
      f.space();
      f.endConditional();
    }
  } else {
    f.space();
  }
  void implementsStart;
  void implementsLen;
  void superClass;

  // Prettier's `handleClassComments`: a comment before the `{` that starts or ends its line is moved into the body.
  if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f)) {
    writeHeadBodySeparator(bodyStart, f);
  } else {
    const cm = cx.comments;
    cm.commentsBefore(bodyStart);
    const from = cm.from;
    const to = cm.to;
    let count = 0;
    for (let i = from; i < to; i++) {
      if (cm.precededByNewline(i) || cm.followedByNewline(i)) break;
      count = (count + 1) | 0;
    }
    formatLeadingCommentsRange(from, from + count, f);
  }

  if (membersLen === 0) {
    f.token(LBRACE);
    classSpan(cls);
    formatDanglingComments(SP[0] | 0, SP[1] | 0, DANGLING_BLOCK, f);
    f.token(RBRACE);
  } else {
    // format_node_without_comments(body_span, || node, f, |f| write_class_body(class, f))
    classBodySpan(cls);
    const bs = SP[0] | 0;
    const be = SP[1] | 0;
    if (cx.isQuiet || !cx.comments.isSuppressed(bs)) {
      writeClassBody(cls, f);
    } else {
      formatLeadingComments(bs, be, f);
      enterNode(bs, be, f);
      writeSuppressedNode(bs, be, f);
      extendNode(bs, be, f);
      writeTrailingCommentsIn(bs, be, PK_PARENT, node, f);
    }
  }
}

/** The name and the type parameters. */
function writeHead(cls: number, node: number, f: Formatter): void {
  const name = className(cls);
  if (name >= 0) {
    f.space();
    writeClassName(name, classNamePos(cls), node, f);
    f.startIndent();
    writeCommentsTrailingInHead(cls, AFTER_NAME, f);
    f.endIndent();
  }
  if (typeParamListAngleBrackets(funcTypeParamsStartOfClass(cls), classTypeParamsLenOf(cls))) {
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    const groupId = f.groupId();
    formatLeadingComments(start, end, f);
    typeParametersWithoutComments(funcTypeParamsStartOfClass(cls), classTypeParamsLenOf(cls), nodeOfClass(cls), groupId, false, f);
    f.startIndent();
    writeCommentsTrailingInHead(cls, AFTER_TYPE_PARAMETERS, f);
    f.endIndent();
  }
}

/** `extends` and `implements`. */
function writeHeritageClauses(cls: number, parent: number, groupMode: boolean, f: Formatter): void {
  const cx = cxOf(f);
  const superClass = classExtends(cls);
  const implementsStart = classImplementsStart(cls);
  const implementsLen = classImplementsLen(cls);
  if (superClass >= 0) {
    if (groupMode) {
      f.softLineBreakOrSpace();
      f.startGroup();
    } else {
      f.space();
    }
    f.token(T_EXTENDS);
    f.space();
    // format_super
    exprSpan(superClass);
    formatLeadingComments(SP[0] | 0, SP[1] | 0, f);
    const argumentsInParentheses = typeArgumentsOfSuperClassAreInItsParentheses(f);
    // Prettier's `printSuperClass`.
    if (anTag(parent) === AN_ASSIGNMENT_EXPRESSION) {
      const slot = f.startCapture();
      fmtNodeWithoutTrailingComments(WK_EXPR, superClass, f);
      if (argumentsInParentheses) writeSuperTypeArguments(cls, f);
      const content = f.endCapture(slot);
      f.startGroup();
      f.startIfGroupBreaks();
      f.token(LPAREN);
      f.startSoftBlockIndent();
      f.writeInterned(content);
      f.endSoftBlockIndent();
      f.token(RPAREN);
      f.endConditional();
      f.startIfGroupFits();
      f.writeInterned(content);
      f.endConditional();
      f.endGroup();
    } else {
      fmtNodeWithoutTrailingComments(WK_EXPR, superClass, f);
      if (argumentsInParentheses) writeSuperTypeArguments(cls, f);
    }
    if (!argumentsInParentheses) writeSuperTypeArguments(cls, f);
    if (groupMode) f.endGroup();
  }

  if (implementsLen > 0) {
    // Those on a line with code, after the `implements`, lead the first type.
    const cm = cx.comments;
    typeSpan(listAt(implementsStart, 0));
    cm.commentsBefore(SP[0] | 0);
    const from = cm.from;
    const to = cm.to;
    let count = 0;
    for (let i = from; i < to; i++) {
      if (!(cm.precededByNewline(i) || cm.followedByNewline(i))) break;
      count = (count + 1) | 0;
    }
    const leadingEnd = from + count;

    if ((superClass >= 0 ? 1 : 0) + implementsLen > 1) {
      f.softLineBreakOrSpace();
      formatLeadingCommentsRange(from, leadingEnd, f);
      if (count > 0) f.hardLineBreak();
      f.token(T_IMPLEMENTS);
      f.startGroup();
      f.startSoftLineIndentOrSpace();
      fmtClassImplements(implementsStart, implementsLen, f);
      f.endSoftLineIndentOrSpace();
      f.endGroup();
    } else {
      const needsLineBreak = count > 0 && cm.isLine(leadingEnd - 1);
      if (groupMode) {
        f.softLineBreakOrSpace();
        f.startGroup();
      } else {
        f.space();
      }
      f.token(T_IMPLEMENTS);
      f.space();
      formatDanglingCommentsRange(from, leadingEnd, DANGLING_NONE, f);
      if (needsLineBreak) f.hardLineBreak();
      fmtClassImplements(implementsStart, implementsLen, f);
      if (groupMode) f.endGroup();
    }
  }
}

// ───────────────────────────── the members ─────────────────────────────

/**
 * Prettier's `shouldPrintSemicolonAfterClassProperty`: with `semi: false`, whether the property `element` needs a `;` all the same.
 * `next`: the member after it, or -1.
 */
function needsSemicolon(element: number, next: number): boolean {
  // `static;`, `get;`, `set;`
  if (memberInit(element) < 0 && memberTy(element) < 0) {
    const k = nodeOfMember(element);
    if (keyLoad(k) === KEY_IDENT) {
      const name = keyName(k);
      if (nameIs(name, "static") || nameIs(name, "get") || nameIs(name, "set")) return true;
    }
  }
  if (next < 0) return false;
  if (
    memberHasFlag(next, FLAG_STATIC) ||
    memberHasFlag(next, FLAG_PUBLIC) ||
    memberHasFlag(next, FLAG_PROTECTED) ||
    memberHasFlag(next, FLAG_PRIVATE) ||
    memberHasFlag(next, FLAG_READONLY)
  ) {
    return false;
  }

  // What follows would be taken for the rest of this property: `in`, `[a]`, `*a() {}`.
  const nk = nodeOfMember(next);
  const nextKeyKind = keyLoad(nk);
  const isComputed = nextKeyKind !== KEY_NONE && keyIsComputed(nk);
  if (nextKeyKind === KEY_IDENT) {
    const name = keyName(nk);
    if (nameIs(name, "in") || nameIs(name, "instanceof")) return true;
  }
  // Flow's `+a`, `-a`
  if (
    memberKind(next) === MEMBER_PROPERTY &&
    (memberHasFlag(next, FLAG_IN) || memberHasFlag(next, FLAG_OUT)) &&
    !memberHasFlag(next, FLAG_AMBIENT)
  ) {
    return true;
  }
  switch (anTag(memberAsAstNodes(next))) {
    case AN_PROPERTY_DEFINITION:
      return isComputed;
    case AN_METHOD_DEFINITION: {
      const value = memberFunc(next);
      if (value < 0) return false;
      const kind = memberKind(next);
      return !funcIsAsync(value) && kind !== MEMBER_GETTER && kind !== MEMBER_SETTER && (isComputed || funcIsGenerator(value));
    }
    case AN_TS_INDEX_SIGNATURE:
      return true;
    default:
      return false;
  }
}

/** See `terminatorOfWhatIsIgnoredFollowsSemi`. Returns whether the member is not formatted. */
function writeIgnoredWithoutTerminator(element: number, next: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  memberSpan(element);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const kind = memberKind(element);
  let hasTerminator: boolean;
  if (kind === MEMBER_PROPERTY || kind === MEMBER_INDEX_SIGNATURE) hasTerminator = true;
  else {
    const func = memberFunc(element);
    hasTerminator = func >= 0 && !funcHasBody(func);
  }
  const contentEnd = hasTerminator ? cm.withoutSemicolon(start, end) : end;
  const isSuppressed =
    cm.isSuppressed(start) ||
    cm.hasTrailingSuppressionComment(end) ||
    (contentEnd < end && cm.hasTrailingSuppressionComment(contentEnd));
  if (!isSuppressed) return false;
  const terminator = hasTerminator && (f.options.semicolons === SEMICOLONS_ALWAYS ? true : kind === MEMBER_PROPERTY && needsSemicolon(element, next));
  formatLeadingComments(start, end, f);
  writeSuppressedNode(start, contentEnd, f);
  if (terminator) f.token(SEMI);
  writeTrailingCommentsOf(memberAsAstNodes(element), f);
  return true;
}

/** A member of a class and the `;` after it. */
function writeClassElementWithSemicolon(element: number, next: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  memberSpan(element);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  if (!cx.isQuiet && terminatorOfWhatIsIgnoredFollowsSemi(f) && writeIgnoredWithoutTerminator(element, next, f)) return;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  const needsSemi =
    memberKind(element) === MEMBER_PROPERTY && (f.options.semicolons === SEMICOLONS_ALWAYS ? !isSuppressed : needsSemicolon(element, next));

  if (cx.isQuiet) {
    fmtMember(element, f);
    if (needsSemi) f.token(SEMI);
    return;
  }
  if (isSuppressed) {
    // The `;` that keeps the next member apart is written in any case.
    fmtMember(element, f);
    if (needsSemi) f.token(SEMI);
  } else if (needsSemi) {
    // The comments on the line of the `;` are written behind it. They are in the member: `a = 1 // prettier-ignore ⏎ ;` is formatted.
    const init = memberInit(element);
    let limit: number;
    if (isNoPropertyToHandleMethodNameComments(element, f)) limit = end;
    else {
      let valueEnd = -1;
      if (init >= 0) valueEnd = exprEnd(init);
      limit = cm.startOfCommentsBeforeSemicolon(valueEnd, start, end);
    }
    if (allCommentsBeforeSemicolonGoBehindIt(f)) {
      let l = -1;
      if (init >= 0) l = startOfCommentsInDroppedParentheses(init, -1, f);
      if (l < 0) l = cm.withoutSemicolon(start, end);
      limit = l < limit ? l : limit;
    }
    const previousLimit = cm.limitCommentsUpTo(limit);
    fmtMember(element, f);
    // Nothing follows them in the member.
    cm.commentsBefore(end);
    formatTrailingCommentsRange(cm.from, cm.to, f);
    cm.restoreViewLimit(previousLimit);
    f.token(SEMI);
    if (allCommentsBeforeSemicolonGoBehindIt(f)) {
      cm.commentsBefore(end);
      formatTrailingCommentsRange(cm.from, cm.to, f);
    }
    if (!(next >= 0 && noCommentTrailsWhatIsBeforeAnother(cx))) writeTrailingCommentsOf(memberAsAstNodes(element), f);
  } else {
    if (next >= 0) fmtMemberBeforeAnother(element, f);
    else fmtMember(element, f);
    // Those before the `;` of the source, which is the end of the member.
    cm.commentsBefore(end);
    formatTrailingCommentsRange(cm.from, cm.to, f);
  }
}

/** `constructor(public x: number, y: number) {}`: more than one parameter, one of which has a modifier, are each on their own line. */
function shouldBreakFunctionParameters(func: number): boolean {
  const n = funcParamsLen(func);
  if (n <= 1) return false;
  const ps = funcParamsStart(func);
  for (let i = 0; i < n; i++) {
    const p = listAt(ps, i);
    const ms = paramModifiersStart(p);
    const mn = paramModifiersLen(p);
    for (let k = 0; k < mn; k++) if (modifierDecorator(listAt(ms, k)) < 0) return true;
  }
  return false;
}

/** Prettier's `printMethodValue`: the type parameters, the parameters and the return type of a method. */
export function formatGroupedParametersWithReturnTypeForMethod(func: number, f: Formatter): void {
  typeParameters(funcTypeParamsStart(func), funcTypeParamsLen(func), nodeOfFunc(func), 0, false, f);
  fmtCommentsBehindParenthesis(func, f);

  f.startGroup();
  let slot = f.startCapture();
  fmtFormalParameters(func, f);
  const parameters = f.endCapture(slot);
  const returnType = funcReturnType(func);
  let formattedReturnType = -1;
  if (returnType >= 0) {
    // The parameters have to be formatted before the return type, which `shouldGroupFunctionParameters` may do.
    slot = f.startCapture();
    fmtNodeWithoutTrailingComments(WK_TYPE_ANNOTATION, returnType, f);
    formattedReturnType = f.endCapture(slot);
  }
  const shouldBreakParameters = shouldBreakFunctionParameters(func);
  const shouldGroupParameters = shouldBreakParameters || shouldGroupFunctionParameters(func, formattedReturnType, f);
  if (shouldGroupParameters) f.startGroupExpand(shouldBreakParameters);
  f.writeInterned(parameters);
  if (shouldGroupParameters) f.endGroup();
  f.writeInterned(formattedReturnType);
  f.endGroup();
}
