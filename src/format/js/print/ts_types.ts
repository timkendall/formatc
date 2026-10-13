// Port of vendor/bun/src/format/js/print/ts_types.rs: the types that take only a few lines each, and the members of interfaces and type
// literals.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { ByteBuf } from "../../../base/bytebuf.ts";
import { I32Vec } from "../../../base/i32vec.ts";
import { COMMA, DOT, LBRACE, LPAREN, MINUS, RBRACE, RPAREN, SEMI } from "../../ir/tokens.ts";
import {
  EXPAND_AUTO,
  FLAVOR_OXFMT,
  FTC_ES5,
  QUOTE_PROPS_CONSISTENT,
  SEMICOLONS_ALWAYS,
  SEMICOLONS_AS_NEEDED,
  trailingSeparator,
} from "../../options.ts";
import {
  EXPR_DOT,
  FLAG_OPTIONAL,
  FLAG_READONLY,
  KEY_IDENT,
  KEY_NONE,
  SP,
  TYPE_STRING_LIT,
  TYPE_UNION,
  TYPE_INTERSECTION,
  fileIsFlow,
  fileIsJavascript,
  funcReturnType,
  entityAtom,
  entityIs,
  entityPos,
  entitySpan,
  exprDotName,
  exprDotNamePos,
  exprDotObj,
  exprTag,
  identEndOf,
  identSpan,
  importAttributesBracesSpan,
  importAttributesEntriesLen,
  importAttributesEntriesStart,
  importAttributesKeywordSpan,
  importAttributesOptionsSpan,
  keyIs,
  keyKind,
  listAt,
  memberFlags,
  memberFunc,
  memberSpan,
  memberTy,
  nodeOfMember,
  nodeOfType,
  propSpan,
  typeAnnotationSpan,
  typeImportArgsLen,
  typeImportArgsStart,
  typeImportAttributes,
  typeImportFlags,
  typeImportNameLen,
  typeImportNameStart,
  typeImportSourceSpan,
  typeListAngleBrackets,
  typeOuterSpan,
  typePredicateAsserts,
  typePredicateParamAtom,
  typePredicateParamPos,
  typePredicateTy,
  typeSpan,
  typeStart,
  typeTag,
  typeUnionTypesLen,
} from "../../../lint/ast/index.ts";
import {
  AN_TS_ARRAY_TYPE,
  AN_TS_CALL_SIGNATURE_DECLARATION,
  AN_TS_CLASS_IMPLEMENTS,
  AN_TS_CONDITIONAL_TYPE,
  AN_TS_CONSTRUCT_SIGNATURE_DECLARATION,
  AN_TS_IMPORT_TYPE,
  AN_TS_INTERFACE_HERITAGE,
  AN_TS_INTERSECTION_TYPE,
  AN_TS_METHOD_SIGNATURE,
  AN_TS_PROPERTY_SIGNATURE,
  AN_TS_TYPE_ALIAS_DECLARATION,
  AN_TS_TYPE_ANNOTATION,
  AN_TS_TYPE_PREDICATE,
  AN_TS_TYPE_QUERY,
  AN_TS_UNION_TYPE,
  anId,
  anParent,
  anTag,
  memberAsAstNodes,
  mkAn,
  typeAsAstNodes,
  typeAstParent,
} from "../ast_nodes.ts";
import { JOIN_SOFT_LINE, joinNodesSeparator, writeSeparatorAfter } from "../builders.ts";
import { cxOf } from "../context.ts";
import {
  PK_PARENT,
  enterScope,
  fmtExpr,
  fmtMember,
  fmtProp,
  fmtType,
  fmtTypeOfPredicate,
  identifier,
  leaveScope,
  noCommentTrailsWhatIsBeforeAnother,
  writeTrailingCommentsIn,
  writeTrailingCommentsOf,
} from "../format.ts";
import {
  DANGLING_BLOCK,
  DANGLING_NONE,
  DANGLING_SOFT,
  formatDanglingComments,
  formatLeadingComments,
  formatLeadingCommentsRange,
  formatTrailingComments,
  formatTrailingCommentsRange,
} from "../trivia.ts";
import { writeObjectLikeTsTypeLiteral } from "./object_like.ts";
import { CONDITIONAL_LIKE_TS_CONDITIONAL_TYPE, fmtConditionalLike } from "../utils/conditional.ts";
import { writeNumberToken } from "../utils/number.ts";
import { keyRequiresQuotes, formatComputedOrPropertyKey } from "../utils/object.ts";
import { STRING_LITERAL_PARENT_KIND_EXPRESSION, fmtLiteralStringToken } from "../utils/string.ts";
import { formatTemplateText, writeSuppressedNode } from "../utils/suppressed.ts";
import { endOfLineComments, withoutLoneOperator } from "../utils/typescript.ts";
import {
  isInexactMark,
  predicatePrefix,
  writeChecksPredicate,
  writeDeclaredPredicate,
  writeObjectType,
  writeObjectTypeMember,
} from "./flow.ts";
import { writeTsCallSignatureDeclaration, writeTsConstructSignatureDeclaration, writeTsMethodSignature } from "./function_type.ts";
import { typeArguments } from "./type_parameters.ts";

const KW_TYPEOF_SPACE = token("typeof ");
const KW_TYPEOF = token("typeof ");
const KW_IMPORT = token("import");
const KW_IMPORT_PAREN = token("import(");
const KW_IS = token("is");
const KW_ASSERTS = token("asserts ");
const KW_IMPLIES = token("implies ");
const KW_BOOLEAN = token("boolean");
const KW_READONLY_SPACE = token("readonly ");
const TOK_LESS = token("<");
const TOK_GREATER = token(">");
const QUESTION = token("?");
const COLON = token(":");

const lb = new ByteBuf(64);
const qnames = new I32Vec(16);

/** `A.B.C`. `parent`: an `AstNodes`: what it is a name in. */
export function entityName(nameStart: number, nameLen: number, parent: number, f: Formatter): void {
  if (cxOf(f).isQuiet) {
    for (let i = 0; i < nameLen; i++) {
      if (i > 0) f.token(DOT);
      identifier(entityAtom(nameStart, i), entityPos(nameStart, i), parent, f);
    }
    return;
  }
  // The next name is what follows a name, which `parent` does not tell.
  for (let i = 0; i < nameLen; i++) {
    const atom = entityAtom(nameStart, i);
    const pos = entityPos(nameStart, i);
    if (i === nameLen - 1) {
      identifier(atom, pos, parent, f);
      return;
    }
    identSpan(atom, pos);
    const partStart = SP[0] | 0;
    const partEnd = SP[1] | 0;
    const nextStart = entityPos(nameStart, i + 1);
    writeIdentifierWithoutTrailingComments(atom, pos, partStart, partEnd, parent, f);
    entitySpan(nameStart, nameLen);
    formatTrailingComments(SP[0] | 0, SP[1] | 0, partStart, partEnd, nextStart, f);
    f.token(DOT);
  }
}

/** `FormatNodeWithoutTrailingComments(&identifier(ident, parent))` */
export function writeIdentifierWithoutTrailingComments(atom: number, pos: number, start: number, end: number, parent: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    identifier(atom, pos, parent, f);
    return;
  }
  const cm = cx.comments;
  if (cm.hasTrailingSuppressionComment(end)) {
    formatLeadingComments(start, end, f);
    writeSuppressedNode(start, end, f);
    return;
  }
  const previousLimit = cm.limitCommentsUpTo(end);
  identifier(atom, pos, parent, f);
  cm.restoreViewLimit(previousLimit);
}

/**
 * `FormatStringLiteral { span, parent }`: a string literal that is not an expression here: a module specifier. `parent`: an `AstNodes`.
 */
export function fmtStringLiteralOf(start: number, end: number, parent: number, f: Formatter): void {
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

/** `A.B<C>` */
export function writeTsTypeReference(ty: number, nameStart: number, nameLen: number, argsStart: number, argsLen: number, f: Formatter): void {
  const cx = cxOf(f);
  const isJavascript = fileIsJavascript();
  // What it is only matters for a long name, and for comments.
  if (cx.isQuiet && nameLen <= 2 && !isJavascript && !keepsParenthesesOfIntrinsic(f)) {
    for (let i = 0; i < nameLen; i++) {
      if (i > 0) f.token(DOT);
      identSpan(entityAtom(nameStart, i), entityPos(nameStart, i));
      f.sourceText(SP[0] | 0, SP[1] | 0);
    }
    typeArguments(argsStart, argsLen, nodeOfType(ty), f);
    return;
  }
  const node = typeAsAstNodes(ty);
  if (nameLen > 2 && heritageNameBreaksBeforeItsDots(f)) {
    const t = anTag(node);
    if (t === AN_TS_INTERFACE_HERITAGE || t === AN_TS_CLASS_IMPLEMENTS) {
      writeHeritageName(nameStart, nameLen, node, f);
      typeArguments(argsStart, argsLen, nodeOfType(ty), f);
      return;
    }
  }
  if (argsLen === 0 && isJavascript) {
    typeSpan(ty);
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    const text = f.source;
    // Flow's other name for it.
    if (nameLen === 1 && end - start === 4 && (text[start] | 0) === 98 && (text[start + 1] | 0) === 111 && (text[start + 2] | 0) === 111 && (text[start + 3] | 0) === 108) {
      f.token(KW_BOOLEAN);
      return;
    }
    // `A<>`
    if (nameLen >= 1 && end > start && (text[end - 1] | 0) === 62) {
      const last = nameLen - 1;
      const lastEnd = identEndOf(entityAtom(nameStart, last), entityPos(nameStart, last));
      cx.comments.commentsIn(lastEnd, end);
      let hasLineComment = false;
      for (let i = cx.comments.from; i < cx.comments.to; i++) {
        if (cx.comments.isLine(i)) {
          hasLineComment = true;
          break;
        }
      }
      if (nameLen === 1) {
        identSpan(entityAtom(nameStart, last), entityPos(nameStart, last));
        writeIdentifierWithoutTrailingComments(entityAtom(nameStart, last), entityPos(nameStart, last), SP[0] | 0, SP[1] | 0, node, f);
      } else {
        entityName(nameStart, nameLen, node, f);
      }
      f.token(TOK_LESS);
      formatDanglingComments(lastEnd, end, hasLineComment ? DANGLING_BLOCK : DANGLING_NONE, f);
      f.token(TOK_GREATER);
      return;
    }
  }
  const wrap = keepsParenthesesOfIntrinsic(f) && isLeftmostIntrinsicInTypeAlias(ty, nameStart, nameLen, argsLen);
  if (wrap) f.token(LPAREN);
  entityName(nameStart, nameLen, node, f);
  typeArguments(argsStart, argsLen, nodeOfType(ty), f);
  if (wrap) f.token(RPAREN);
}

/** For oxfmt `A.B.C` after `extends` or `implements` is a name like any other, on one line. */
function heritageNameBreaksBeforeItsDots(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/**
 * `A.B.C` after `extends` or `implements`. There it is a member expression in ESTree, which can break before its dots (Prettier's
 * `printMemberExpression`).
 */
function writeHeritageName(nameStart: number, nameLen: number, parent: number, f: Formatter): void {
  for (let index = 0; index < nameLen; index++) {
    const atom = entityAtom(nameStart, index);
    const pos = entityPos(nameStart, index);
    if (index === 0) {
      identifier(atom, pos, parent, f);
    } else {
      f.lineSuffixBoundary();
      f.startGroup();
      f.startIndent();
      f.softLineBreak();
      f.token(DOT);
      identifier(atom, pos, parent, f);
      f.endIndent();
      f.endGroup();
    }
  }
}

/** oxfmt keeps the parentheses of `type A = (intrinsic)`. Prettier drops them, which changes what it means. */
function keepsParenthesesOfIntrinsic(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `type A = (intrinsic)` is a reference to a type of that name. Without the parentheses it is the keyword. */
function isLeftmostIntrinsicInTypeAlias(ty: number, nameStart: number, nameLen: number, argsLen: number): boolean {
  if (!entityIs(nameStart, nameLen, "intrinsic") || argsLen !== 0) return false;
  typeOuterSpan(ty);
  const start = SP[0] | 0;
  let parent = typeAstParent(ty);
  while (true) {
    const t = anTag(parent);
    if (t === AN_TS_TYPE_ALIAS_DECLARATION) return true;
    if (t === AN_TS_UNION_TYPE || t === AN_TS_INTERSECTION_TYPE || t === AN_TS_CONDITIONAL_TYPE || t === AN_TS_ARRAY_TYPE) {
      if (typeStart(anId(parent)) === start) {
        parent = anParent(parent);
        continue;
      }
    }
    return false;
  }
}

/** `"a"`, `1`, `-1`, `1n` */
export function writeTsLiteralType(ty: number, f: Formatter): void {
  typeSpan(ty);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const text = f.source;
  const tag = typeTag(ty);
  if (tag === TYPE_STRING_LIT) {
    // A template without substitutions.
    if ((text[start] | 0) === 96) {
      f.lineSuffixBoundary();
      formatTemplateText(start, end, f);
    } else {
      fmtLiteralStringToken(start, end, false, STRING_LITERAL_PARENT_KIND_EXPRESSION, f);
    }
    return;
  }
  if ((text[start] | 0) !== 45) {
    writeDigits(start, end, f);
    return;
  }
  // `- /* comment */ 1`: like a unary expression whose operand has a comment.
  const cm = cxOf(f).comments;
  cm.commentsBefore(end);
  const from = cm.from;
  const to = cm.to;
  if (to <= from) {
    f.token(MINUS);
    writeDigits(trimAsciiStart(text, start + 1, end), end, f);
    return;
  }
  const last = to - 1;
  const digitsStart = trimAsciiStart(text, cm.spanEnd[last] | 0, end);
  f.token(MINUS);
  f.startGroup();
  f.token(LPAREN);
  f.startSoftBlockIndent();
  formatLeadingCommentsRange(from, to, f);
  writeDigits(digitsStart, end, f);
  f.endSoftBlockIndent();
  f.token(RPAREN);
  f.endGroup();
}

function trimAsciiStart(text: Uint8Array, start: number, end: number): number {
  let i = start;
  while (i < end) {
    const b = text[i] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) i = i + 1;
    else break;
  }
  return i;
}

/** `format_digits`: a number, or a bigint, which is written in lowercase. */
function writeDigits(start: number, end: number, f: Formatter): void {
  const text = f.source;
  if (end > start && (text[end - 1] | 0) === 110) {
    lb.reset();
    for (let i = start; i < end; i++) {
      const c = text[i] | 0;
      lb.push(c >= 65 && c <= 90 ? c + 32 : c);
    }
    f.textBytesNoWs(lb.data, 0, lb.len);
  } else {
    writeNumberToken(start, end, f);
  }
}

/** `{ a: A }` */
export function writeTsTypeLiteral(ty: number, membersStart: number, membersLen: number, f: Formatter): void {
  if (fileIsFlow()) {
    writeObjectType(ty, membersStart, membersLen, f);
    return;
  }
  writeObjectLikeTsTypeLiteral(ty, membersStart, membersLen, f);
}

/** The members of a type literal, with their separators. */
export function writeTsSignatures(membersStart: number, membersLen: number, f: Formatter): void {
  writeSignatures(membersStart, membersLen, false, f);
}

/** The members of an interface, with their separators. */
export function writeTsInterfaceSignatures(membersStart: number, membersLen: number, f: Formatter): void {
  writeSignatures(membersStart, membersLen, true, f);
}

function writeSignatures(membersStart: number, membersLen: number, isInterface: boolean, f: Formatter): void {
  const cx = cxOf(f);
  const isConsistent = f.options.quoteProperties === QUOTE_PROPS_CONSISTENT;
  if (isConsistent) {
    let quoteNeeded = false;
    for (let i = 0; i < membersLen; i++) {
      const signature = listAt(membersStart, i);
      const node = memberAsAstNodes(signature);
      const t = anTag(node);
      if (t !== AN_TS_PROPERTY_SIGNATURE && t !== AN_TS_METHOD_SIGNATURE) continue;
      const key = nodeOfMember(signature);
      if (keyKind(key) !== KEY_NONE && keyRequiresQuotes(key, node, f)) {
        quoteNeeded = true;
        break;
      }
    }
    cx.pushQuoteNeeded(quoteNeeded);
  }

  let hasElements = false;
  for (let index = 0; index < membersLen; index++) {
    const signature = listAt(membersStart, index);
    const next = index + 1 < membersLen ? listAt(membersStart, index + 1) : -1;
    memberSpan(signature);
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    // Prettier has no node for the `...`.
    if (isInexactMark(signature) && !cx.comments.hasCommentBefore(start)) {
      if (hasElements) f.softLineBreakOrSpace();
    } else if (hasElements) {
      joinNodesSeparator(f, JOIN_SOFT_LINE, start, end);
    }
    hasElements = true;
    writeSignature(signature, next, isInterface, f);
  }

  if (isConsistent) cx.popQuoteNeeded();
}

/** `a: string; /* comment *&#47;` is `a: string /* comment *&#47;;` for oxfmt. */
function separatorIsBehindComments(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** A member and the `;` after it (`FormatTSSignature::fmt`). `next`: the next member, or -1. */
function writeSignature(signature: number, next: number, isInterface: boolean, f: Formatter): void {
  const cx = cxOf(f);
  memberSpan(signature);
  const start = SP[0] | 0;
  let end = SP[1] | 0;
  if (!cx.isQuiet) {
    const cm = cx.comments;
    if (cm.isSuppressed(start)) {
      fmtMember(signature, f);
      // It is not part of a member of Flow's.
      if (fileIsFlow()) writeSeparator(signature, next, isInterface, f);
      return;
    }
    if (cm.hasTrailingSuppressionComment(end)) {
      formatLeadingComments(start, end, f);
      writeSuppressedNode(start, end, f);
      writeTrailingCommentsOf(memberAsAstNodes(signature), f);
      return;
    }
    // Prettier's `handleTSFunctionTrailingComments`: `a() /* comment *&#47;;`
    if (anTag(memberAsAstNodes(signature)) === AN_TS_METHOD_SIGNATURE) {
      const func = memberFunc(signature);
      if (func >= 0 && funcReturnType(func) < 0) end = cm.withoutSemicolon(start, end);
    }
    // The `,` of Flow's is behind the comments that trail the member.
    if ((fileIsFlow() && !isInterface) || separatorIsBehindComments(f)) {
      fmtMember(signature, f);
      writeSeparator(signature, next, isInterface, f);
      return;
    }
  }

  // The separator is not part of the member. The comments after the member are behind it.
  writeMemberWithoutTrailingComments(signature, start, end, f);
  writeSeparator(signature, next, isInterface, f);
  if (!cx.isQuiet && !(next >= 0 && noCommentTrailsWhatIsBeforeAnother(cx))) {
    writeTrailingCommentsOf(memberAsAstNodes(signature), f);
  }
}

/** `FormatNodeWithoutTrailingComments(&FormatMemberIn(signature, span))` */
function writeMemberWithoutTrailingComments(signature: number, start: number, end: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    fmtMember(signature, f);
    return;
  }
  const cm = cx.comments;
  if (cm.hasTrailingSuppressionComment(end)) {
    formatLeadingComments(start, end, f);
    writeSuppressedNode(start, end, f);
    return;
  }
  const previousLimit = cm.limitCommentsUpTo(end);
  fmtMember(signature, f);
  cm.restoreViewLimit(previousLimit);
}

function writeSeparator(signature: number, next: number, isInterface: boolean, f: Formatter): void {
  // The types in a JavaScript file are Flow's.
  if (fileIsJavascript()) {
    if (isInterface) f.token(SEMI);
    else if (next < 0 && isInexactMark(signature)) return;
    else if (next >= 0) f.token(COMMA);
    else f.writeTrailingCommas(FTC_ES5, COMMA);
    return;
  }
  const semicolons = f.options.semicolons;
  if (semicolons === SEMICOLONS_ALWAYS) {
    if (next >= 0) f.token(SEMI);
    else f.tokenIfBreaks(SEMI);
  } else if (semicolons === SEMICOLONS_AS_NEEDED) {
    if (next < 0 && !isInterface) return;
    if (needsSemicolon(signature, next)) f.token(SEMI);
    else if (next >= 0) {
      f.startIfGroupFits();
      f.token(SEMI);
      f.endConditional();
    }
  }
}

/** Prettier's `shouldPrintSemicolonAfterInterfaceProperty`: what follows would be taken for the rest of the property. */
function needsSemicolon(signature: number, next: number): boolean {
  if (anTag(memberAsAstNodes(signature)) !== AN_TS_PROPERTY_SIGNATURE || memberTy(signature) >= 0) return false;
  // `get; a(): void`, `a; (): void`
  const key = nodeOfMember(signature);
  if (keyKind(key) === KEY_IDENT && (keyIs(key, "static") || keyIs(key, "get") || keyIs(key, "set"))) return true;
  return next >= 0 && anTag(memberAsAstNodes(next)) === AN_TS_CALL_SIGNATURE_DECLARATION;
}

/** A member of an interface or a type literal that is not an index signature. */
export function writeTsSignature(member: number, f: Formatter): void {
  if (fileIsFlow()) {
    writeObjectTypeMember(member, f);
    return;
  }
  const node = memberAsAstNodes(member);
  const func = memberFunc(member);
  const tag = anTag(node);
  if (tag === AN_TS_CALL_SIGNATURE_DECLARATION && func >= 0) {
    writeTsCallSignatureDeclaration(func, f);
  } else if (tag === AN_TS_CONSTRUCT_SIGNATURE_DECLARATION && func >= 0) {
    writeTsConstructSignatureDeclaration(func, f);
  } else if (tag === AN_TS_METHOD_SIGNATURE && func >= 0) {
    writeTsMethodSignature(member, func, f);
  } else {
    const flags = memberFlags(member);
    if ((flags & FLAG_READONLY) !== 0) f.token(KW_READONLY_SPACE);
    const key = nodeOfMember(member);
    if (keyKind(key) !== KEY_NONE) formatComputedOrPropertyKey(key, node, f);
    const ty = memberTy(member);
    if (ty < 0) {
      if ((flags & FLAG_OPTIONAL) !== 0) f.token(QUESTION);
      return;
    }
    // Prettier does not attach comments to the `: T` of a property signature, only to the name and the type.
    if (!cxOf(f).isQuiet) {
      const cm = cxOf(f).comments;
      commentsAfterPropertyName(ty, f);
      formatTrailingCommentsRange(cm.from, cm.to, f);
    }
    if ((flags & FLAG_OPTIONAL) !== 0) f.token(QUESTION);
    f.token(COLON);
    f.space();
    fmtType(ty, f);
    writeTrailingCommentsOf(mkAn(AN_TS_TYPE_ANNOTATION, ty), f);
  }
}

/** `a: // comment ⏎ B;` stays as it is for oxfmt. For Prettier it is `a: B; // comment`. */
function commentsBehindColonOfPropertySignatureStay(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * Of the comments between the name of a property signature and its type `ty`, those that trail the name: those on its line that are before
 * the `:`, or at the end of the line, unless a union or an intersection follows (Prettier's `handlePropertySignatureComments`). Returns the
 * count; the range is `[cm.from, cm.to)`.
 */
export function commentsAfterPropertyName(ty: number, f: Formatter): number {
  const cm = cxOf(f).comments;
  typeSpan(ty);
  cm.commentsBefore(SP[0] | 0);
  const from = cm.from;
  const to = cm.to;
  typeAnnotationSpan(ty);
  const colon = SP[0] | 0;
  let beforeColon = 0;
  while (from + beforeColon < to && (cm.spanStart[from + beforeColon] | 0) < colon && !cm.precededByNewline(from + beforeColon)) beforeColon = (beforeColon + 1) | 0;
  let takesComments = commentsBehindColonOfPropertySignatureStay(f);
  if (!takesComments) {
    const tag = typeTag(withoutLoneOperator(ty));
    takesComments = tag === TYPE_UNION || tag === TYPE_INTERSECTION;
  }
  let count = beforeColon;
  if (!takesComments) count = beforeColon + (endOfLineComments(f, from + beforeColon, to) - (from + beforeColon));
  cm.from = from;
  cm.to = from + count;
  return count;
}

/** `A extends B ? C : D` */
export function writeTsConditionalType(ty: number, f: Formatter): void {
  fmtConditionalLike(CONDITIONAL_LIKE_TS_CONDITIONAL_TYPE, ty, f);
}

/** `typeof a.b<T>` */
export function writeTsTypeQuery(ty: number, expr: number, argsStart: number, argsLen: number, f: Formatter): void {
  if (fileIsFlow() && writeDeclaredPredicate(ty, expr, argsStart, argsLen, f)) return;
  // The name is ESTree's `TSQualifiedName`, which does not break like a member expression.
  const base = qnames.len;
  let leftmost = expr;
  while (exprTag(leftmost) === EXPR_DOT) {
    qnames.push(exprDotName(leftmost));
    qnames.push(exprDotNamePos(leftmost));
    leftmost = exprDotObj(leftmost);
  }
  const top = qnames.len;
  f.token(KW_TYPEOF_SPACE);
  fmtExpr(leftmost, f);
  const node = mkAn(AN_TS_TYPE_QUERY, ty);
  for (let i = top - 2; i >= base; i = i - 2) {
    f.token(DOT);
    identifier(qnames.data[i] | 0, qnames.data[i + 1] | 0, node, f);
  }
  qnames.len = base;
  typeArguments(argsStart, argsLen, nodeOfType(ty), f);
}

/** `import("a").B<C>`, `typeof import("a")` */
export function writeTsImportType(ty: number, f: Formatter): void {
  const nameStart = typeImportNameStart(ty);
  const nameLen = typeImportNameLen(ty);
  const argsStart = typeImportArgsStart(ty);
  const argsLen = typeImportArgsLen(ty);
  const isTypeof = (typeImportFlags(ty) & 1) !== 0;
  typeSpan(ty);
  const tyStart = SP[0] | 0;
  const tyEnd = SP[1] | 0;
  if (!typeImportSourceSpan(ty)) {
    writeSuppressedNode(tyStart, tyEnd, f);
    return;
  }
  const sourceStart = SP[0] | 0;
  const sourceEnd = SP[1] | 0;
  const node = mkAn(AN_TS_IMPORT_TYPE, ty);
  const cx = cxOf(f);

  // Up to what follows the `)`, they lead or trail the module specifier.
  let hasComment = false;
  if (!cx.isQuiet) {
    let following = tyEnd;
    if (nameLen > 0) {
      identSpan(entityAtom(nameStart, 0), entityPos(nameStart, 0));
      following = SP[0] | 0;
    } else if (typeListAngleBrackets(argsStart, argsLen)) {
      following = SP[0] | 0;
    }
    hasComment = cx.comments.hasCommentInRange(tyStart, following);
  }

  if (isTypeof) f.token(KW_TYPEOF);
  const options = typeImportAttributes(ty);
  if (options >= 0) {
    f.startGroup();
    f.token(KW_IMPORT);
    writeImportTypeArguments(ty, sourceStart, sourceEnd, options, f);
    f.endGroup();
  } else if (!hasComment) {
    // A long module name does not break.
    f.token(KW_IMPORT_PAREN);
    fmtStringLiteralOf(sourceStart, sourceEnd, node, f);
    f.token(RPAREN);
  } else {
    f.startGroup();
    f.token(KW_IMPORT_PAREN);
    f.startSoftBlockIndent();
    fmtStringLiteralOf(sourceStart, sourceEnd, node, f);
    f.endSoftBlockIndent();
    f.token(RPAREN);
    f.endGroup();
  }

  if (nameLen > 0) {
    f.token(DOT);
    entityName(nameStart, nameLen, node, f);
  }
  typeArguments(argsStart, argsLen, nodeOfType(ty), f);
}

/**
 * The module specifier in `import("a")` or `require("a")`: `FormatModuleSpecifier { span, parent, call_span }`. Only the comments before the
 * `)` trail it. `(callStart, callEnd)`: from `import` or `require` to the `)`. `parent`: an `AstNodes`.
 */
export function fmtModuleSpecifier(start: number, end: number, parent: number, callStart: number, callEnd: number, f: Formatter): void {
  // FormatNodeWithoutTrailingComments(&FormatModuleSpecifierWithoutComments(span, parent))
  const cx = cxOf(f);
  if (cx.isQuiet) {
    fmtStringLiteralOf(start, end, parent, f);
  } else {
    writeStringLiteralWithoutTrailingComments(start, end, parent, f);
  }
  formatTrailingComments(callStart, callEnd, start, end, 0, f);
}

function writeStringLiteralWithoutTrailingComments(start: number, end: number, parent: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  if (cm.hasTrailingSuppressionComment(end)) {
    formatLeadingComments(start, end, f);
    writeSuppressedNode(start, end, f);
    return;
  }
  const previousLimit = cm.limitCommentsUpTo(end);
  fmtStringLiteralOf(start, end, parent, f);
  cm.restoreViewLimit(previousLimit);
}

/**
 * ```ts
 * import("a", {          import(
 *   with: { b: "c" },      "a",
 * })                       { with: { b: "c" } }
 *                        )
 * ```
 *
 * Prettier on the left: they are the last argument of a call. oxfmt on the right.
 */
function optionsOfImportTypeAreOnALineOfTheirOwn(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `all_broken_out(should_expand)`: `(`, the source, the options, `)`; each on a line of its own. */
function writeAllBrokenOut(hSource: number, hOptions: number, shouldExpand: boolean, f: Formatter): void {
  f.startGroupExpand(shouldExpand);
  f.token(LPAREN);
  f.startSoftBlockIndent();
  writeHead(hSource, f);
  f.writeInterned(hOptions);
  f.endSoftBlockIndent();
  f.token(RPAREN);
  f.endGroup();
}

/** `head`: the source and the `,`. */
function writeHead(hSource: number, f: Formatter): void {
  f.writeInterned(hSource);
  f.token(COMMA);
  f.softLineBreakOrSpace();
}

/** `("a", { with: { type: "json" } })`. Prettier's `printCallArguments` for a string and an object. */
function writeImportTypeArguments(ty: number, sourceStart: number, sourceEnd: number, options: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  importAttributesOptionsSpan(options);
  const spanStart = SP[0] | 0;
  const spanEnd = SP[1] | 0;
  typeSpan(ty);
  const tyStart = SP[0] | 0;
  const tyEnd = SP[1] | 0;
  const node = mkAn(AN_TS_IMPORT_TYPE, ty);

  let slot = f.startCapture();
  writeStringLiteralWithoutTrailingCommentsQuietAware(sourceStart, sourceEnd, node, f);
  formatTrailingComments(tyStart, tyEnd, sourceStart, sourceEnd, spanStart, f);
  const hSource = f.endCapture(slot);
  const doesSourceBreak = f.willBreak(hSource);

  let hasComments = cm.hasCommentBefore(spanStart);
  slot = f.startCapture();
  formatLeadingComments(spanStart, spanEnd, f);
  writeImportTypeOptions(options, f);
  cm.commentsBeforeCharacter(spanEnd, 41);
  const from = cm.from;
  const to = cm.to;
  if (to > from) hasComments = true;
  formatTrailingCommentsRange(from, to, f);
  const hOptions = f.endCapture(slot);
  const doOptionsBreak = f.willBreak(hOptions);

  if (hasComments) {
    writeAllBrokenOut(hSource, hOptions, doesSourceBreak || doOptionsBreak, f);
    return;
  }
  if (doesSourceBreak) {
    writeAllBrokenOut(hSource, hOptions, true, f);
    return;
  }
  if (!doOptionsBreak && optionsOfImportTypeAreOnALineOfTheirOwn(f)) {
    let s = f.startVariant();
    f.token(LPAREN);
    writeHead(hSource, f);
    f.writeInterned(hOptions);
    f.token(RPAREN);
    const v0 = f.endVariant(s);
    s = f.startVariant();
    writeAllBrokenOut(hSource, hOptions, true, f);
    const v1 = f.endVariant(s);
    f.bestFitting2(v0, v1);
    return;
  }
  if (doOptionsBreak) {
    f.expandParent();
    let s = f.startVariant();
    writeExpandedOptions(hSource, hOptions, f);
    const v0 = f.endVariant(s);
    s = f.startVariant();
    writeAllBrokenOut(hSource, hOptions, true, f);
    const v1 = f.endVariant(s);
    f.bestFitting2(v0, v1);
  } else {
    let s = f.startVariant();
    f.token(LPAREN);
    writeHead(hSource, f);
    f.writeInterned(hOptions);
    f.token(RPAREN);
    const v0 = f.endVariant(s);
    s = f.startVariant();
    writeExpandedOptions(hSource, hOptions, f);
    const v1 = f.endVariant(s);
    s = f.startVariant();
    writeAllBrokenOut(hSource, hOptions, true, f);
    const v2 = f.endVariant(s);
    f.bestFitting3(v0, v1, v2);
  }
}

/** `expanded_options`: `(`, the head, the options in a group that breaks, `)`. */
function writeExpandedOptions(hSource: number, hOptions: number, f: Formatter): void {
  f.token(LPAREN);
  writeHead(hSource, f);
  f.startGroupExpand(true);
  f.writeInterned(hOptions);
  f.endGroup();
  f.token(RPAREN);
}

/** `FormatNodeWithoutTrailingComments(&source)`, which is quiet-aware. */
function writeStringLiteralWithoutTrailingCommentsQuietAware(start: number, end: number, parent: number, f: Formatter): void {
  if (cxOf(f).isQuiet) fmtStringLiteralOf(start, end, parent, f);
  else writeStringLiteralWithoutTrailingComments(start, end, parent, f);
}

/** `{ with: { type: "json" } }`. It is an object literal, of which the HIR has only the properties of the inner one. */
function writeImportTypeOptions(options: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  importAttributesOptionsSpan(options);
  const outerStart = SP[0] | 0;
  const outerEnd = SP[1] | 0;
  importAttributesKeywordSpan(options);
  const keywordStart = SP[0] | 0;
  const keywordEnd = SP[1] | 0;
  importAttributesBracesSpan(options);
  const innerStart = SP[0] | 0;
  const innerEnd = SP[1] | 0;
  const entriesStart = importAttributesEntriesStart(options);
  const entriesLen = importAttributesEntriesLen(options);
  const hasSpace = f.options.bracketSpacing;
  const isAuto = f.options.expand === EXPAND_AUTO;

  const expandOuter = isAuto && cx.src.containsNewline(outerStart, keywordStart);
  f.startGroupExpand(expandOuter);
  f.token(LBRACE);
  f.startSoftBlockIndentWithMaybeSpace(hasSpace);

  // format_property
  formatLeadingComments(keywordStart, keywordEnd, f);
  f.sourceText(keywordStart, keywordEnd);
  f.token(COLON);
  f.space();
  // format_inner
  formatLeadingComments(innerStart, innerEnd, f);
  if (entriesLen === 0) {
    f.token(LBRACE);
    formatDanglingComments(innerStart, innerEnd, DANGLING_SOFT, f);
    f.token(RBRACE);
  } else {
    propSpan(listAt(entriesStart, 0));
    const expandInner = isAuto && cx.src.containsNewline(innerStart, SP[0] | 0);
    f.startGroupExpand(expandInner);
    f.token(LBRACE);
    f.startSoftBlockIndentWithMaybeSpace(hasSpace);
    const separator = trailingSeparator(FTC_ES5, f.options);
    for (let i = 0; i < entriesLen; i++) {
      const entry = listAt(entriesStart, i);
      if (i > 0) {
        propSpan(entry);
        joinNodesSeparator(f, JOIN_SOFT_LINE, SP[0] | 0, SP[1] | 0);
      }
      fmtProp(entry, f);
      writeSeparatorAfter(f, COMMA, i === entriesLen - 1, separator, 0);
    }
    f.endSoftBlockIndentWithMaybeSpace(hasSpace);
    f.token(RBRACE);
    f.endGroup();
  }
  cm.commentsBefore(outerEnd > 0 ? outerEnd - 1 : 0);
  formatTrailingCommentsRange(cm.from, cm.to, f);
  f.writeTrailingCommas(FTC_ES5, COMMA);

  f.endSoftBlockIndentWithMaybeSpace(hasSpace);
  f.token(RBRACE);
  f.endGroup();
}

/** `a is T`, `asserts a`, `asserts a is T` */
export function writeTsTypePredicate(ty: number, f: Formatter): void {
  const annotation = typePredicateTy(ty);
  const asserts = typePredicateAsserts(ty);
  if (fileIsFlow() && writeChecksPredicate(ty, f)) return;
  const atom = typePredicateParamAtom(ty);
  const pos = typePredicateParamPos(ty);
  const node = mkAn(AN_TS_TYPE_PREDICATE, ty);
  if (asserts) f.token(predicatePrefix(ty) === "implies " ? KW_IMPLIES : KW_ASSERTS);
  if (annotation < 0) {
    if (atom >= 0) identifier(atom, pos, node, f);
    return;
  }
  if (atom >= 0) {
    identSpan(atom, pos);
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    writeIdentifierWithoutTrailingComments(atom, pos, start, end, node, f);
    typeSpan(ty);
    const tyStart = SP[0] | 0;
    const tyEnd = SP[1] | 0;
    typeSpan(annotation);
    formatTrailingComments(tyStart, tyEnd, start, end, SP[0] | 0, f);
  }
  f.space();
  f.token(KW_IS);
  f.space();
  fmtTypeOfPredicate(annotation, f);
}
