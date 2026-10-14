// Port of vendor/bun/src/format/js/print/union_type.rs: `A | B`.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  EXPR_AS,
  EXPR_SATISFIES,
  SP,
  STMT_TYPE_ALIAS,
  TYPE_COND,
  TYPE_UNION,
  aliasName,
  aliasNamePos,
  aliasTypeParamsLen,
  aliasTypeParamsStart,
  exprAsExpr,
  exprEnd,
  exprSatisfiesExpr,
  exprTag,
  fileIsFlow,
  identEndOf,
  listAt,
  stmtTag,
  stmtTypeAliasAlias,
  typeCondNo,
  typeCondYes,
  typeCondExtends,
  typeParamListAngleBrackets,
  typeSpan,
  typeTag,
  typeTupleElemsLen,
  typeUnionTypesLen,
} from "../../../lint/ast/index.ts";
import {
  AN_TS_ARRAY_TYPE,
  AN_TS_AS_EXPRESSION,
  AN_TS_CONDITIONAL_TYPE,
  AN_TS_INTERSECTION_TYPE,
  AN_TS_PROPERTY_SIGNATURE,
  AN_TS_SATISFIES_EXPRESSION,
  AN_TS_TUPLE_TYPE,
  AN_TS_TYPE_ALIAS_DECLARATION,
  AN_TS_TYPE_ANNOTATION,
  AN_TS_TYPE_ASSERTION,
  AN_TS_UNION_TYPE,
  anId,
  anIsTypeParameterInstantiation,
  anParent,
  anEnd,
  anTag,
  mkAn,
  typeAstParent,
} from "../ast_nodes.ts";
import { INF } from "../comments.ts";
import { cxOf } from "../context.ts";
import { WK_TYPE, fmtType, writeTrailingCommentsOf } from "../format.ts";
import { followingSpanStartIn } from "../siblings.ts";
import { BT_WS_OPEN_PAREN } from "../source_text.ts";
import { formatLeadingCommentsRange, formatTrailingCommentsRange } from "../trivia.ts";
import { fmtNodeWithoutTrailingComments } from "../utils/format_node_without_trailing_comments.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { endOfLineComments, shouldHugType, unionLeadingComments } from "../utils/typescript.ts";
import { effectiveParent, needsParentheses } from "../parentheses/ts_type.ts";
import { isUnionIndentedByParameters } from "./flow.ts";

const PIPE_SPACED = token(" | ");
const PIPE_AFTER = token("| ");
const LPAREN = token("(");
const RPAREN = token(")");

/** `A | B`. The comments before it are not written yet. */
export function writeTsUnionType(ty: number, typesStart: number, typesLen: number, f: Formatter): void {
  writeTsUnionTypeIn(ty, typesStart, typesLen, false, f);
}

/**
 * Prettier's `printUnionType`.
 *
 * ```ts
 * A | B | C
 *
 * | A
 * | B
 * | C
 * ```
 *
 * `isIndentedByParent`: it is the right side of a type alias, which has a line break and an indentation after the `=`.
 */
export function writeTsUnionTypeIn(ty: number, typesStart: number, typesLen: number, isIndentedByParent: boolean, f: Formatter): void {
  if (typesLen === 1) {
    fmtType(listAt(typesStart, 0), f);
    return;
  }
  const cx = cxOf(f);
  const cm = cx.comments;

  // The comments that lead the union: [leadingFrom, leadingTo)
  const leadingTo = unionLeadingComments(ty, f);
  const leadingFrom = cm.from;

  // A `prettier-ignore` comment on a line of its own is about the first type only.
  let suppression = -1;
  for (let i = leadingFrom; i < leadingTo; i++) {
    if (cm.isSuppressionComment(i)) {
      suppression = i;
      break;
    }
  }
  const aboutAll = prettierIgnoreBeforeUnionIsAboutAllOfIt(f);
  const isSuppressed = aboutAll ? !unionPrintsItself(ty, f) || followsPrintedSuppressionComment(ty, f) : suppression >= 0 && !cm.precededByNewline(suppression);
  typeSpan(ty);
  const SP$ = SP;
  const tyStart = SP$.s0 | 0;
  const tyEnd = SP$.s1 | 0;
  if (isSuppressed) {
    formatLeadingCommentsRange(leadingFrom, leadingTo, f);
    writeSuppressedNode(tyStart, tyEnd, f);
    // oxc's `write_suppressed_expression`: the comments before the `)` stay there, and a line comment has the `)` on
    // the next line.
    if (aboutAll && needsParentheses(ty, f)) {
      cm.commentsBeforeCharacter(tyEnd, 41);
      const from = cm.from;
      const to = cm.to;
      formatTrailingCommentsRange(from, to, f);
      if (to > from && cm.isLine(to - 1)) f.hardLineBreak();
    }
    return;
  }

  const parent = effectiveParent(typeAstParent(ty));
  const parentTag = anTag(parent);
  // For oxfmt a comment that ends its line is above the type of a type alias, and both are indented.
  const hasCommentAbove =
    unionBreaksOnePerLine(f) && !cx.isQuiet && parentTag === AN_TS_TYPE_ALIAS_DECLARATION && cm.hasLeadingOwnLineComment(tyStart);
  // `{ a: string } | null | void` is written like the object type alone.
  if (!hasCommentAbove && shouldHugType(ty, typesStart, typesLen, f)) {
    formatLeadingCommentsRange(leadingFrom, leadingTo, f);
    for (let i = 0; i < typesLen; i++) {
      if (i > 0) f.token(PIPE_SPACED);
      fmtType(listAt(typesStart, i), f);
    }
    return;
  }

  const isOneOfSeveralTupleElements = parentTag === AN_TS_TUPLE_TYPE && typeTupleElemsLen(anId(parent)) > 1;
  // Prettier's `shouldUnionTypePrintOwnComments`. Otherwise they are outside of the parentheses.
  const printsOwnComments = !isOneOfSeveralTupleElements && parentTag !== AN_TS_UNION_TYPE && parentTag !== AN_TS_INTERSECTION_TYPE;

  const isFirstTypeSuppressed = suppression >= 0 || followsPrintedSuppressionComment(ty, f);
  if (unionBreaksOnePerLine(f)) {
    writeUnionOnePerLine(ty, typesStart, typesLen, parent, isFirstTypeSuppressed, isOneOfSeveralTupleElements, f);
    return;
  }

  if (!printsOwnComments) formatLeadingCommentsRange(leadingFrom, leadingTo, f);

  if (needsParentheses(ty, f)) {
    f.startGroup();
    f.startIndent();
    f.softLineBreak();
    writePrinted(ty, typesStart, typesLen, parent, isFirstTypeSuppressed, printsOwnComments, leadingFrom, leadingTo, f);
    f.endIndent();
    f.softLineBreak();
    f.endGroup();
    return;
  }
  if (isOneOfSeveralTupleElements) {
    f.startGroup();
    f.startIndent();
    f.startIfGroupBreaks();
    f.token(LPAREN);
    f.softLineBreak();
    f.endConditional();
    writePrinted(ty, typesStart, typesLen, parent, isFirstTypeSuppressed, printsOwnComments, leadingFrom, leadingTo, f);
    f.endIndent();
    f.softLineBreak();
    f.tokenIfBreaks(RPAREN);
    f.endGroup();
    return;
  }
  if (isIndentedByParent || !shouldIndentUnionType(ty, parent)) {
    writePrinted(ty, typesStart, typesLen, parent, isFirstTypeSuppressed, printsOwnComments, leadingFrom, leadingTo, f);
    return;
  }
  // With `experimentalTernaries` the type after `extends` is in parentheses that start with a line break. This is a second
  // one, and Prettier writes both.
  let isAfterLineBreak = false;
  if (f.options.experimentalTernaries && parentTag === AN_TS_CONDITIONAL_TYPE) {
    typeSpan(typeCondExtends(anId(parent)));
    isAfterLineBreak = (SP$.s0 | 0) <= tyStart && tyEnd <= (SP$.s1 | 0);
  }
  f.startGroup();
  f.startIndent();
  if (isAfterLineBreak) f.softEmptyLine();
  else f.softLineBreak();
  writePrinted(ty, typesStart, typesLen, parent, isFirstTypeSuppressed, printsOwnComments, leadingFrom, leadingTo, f);
  f.endIndent();
  f.endGroup();
}

/** `printed` of `write_ts_union_type_in`: the members in a group, with the comments around the union if it prints its own. */
function writePrinted(
  ty: number,
  typesStart: number,
  typesLen: number,
  parent: number,
  isFirstTypeSuppressed: boolean,
  printsOwnComments: boolean,
  leadingFrom: number,
  leadingTo: number,
  f: Formatter,
): void {
  if (printsOwnComments) formatLeadingCommentsRange(leadingFrom, leadingTo, f);
  f.startGroup();
  f.tokenIfBreaks(PIPE_AFTER);
  writeMembers(ty, typesStart, typesLen, parent, isFirstTypeSuppressed, f);
  f.endGroup();
  if (printsOwnComments) {
    writeTrailingCommentsOf(mkAn(AN_TS_UNION_TYPE, ty), f);
    // Prettier does not attach comments to the `: T` of a property signature.
    if (cxOf(f).comments.nextStart() !== INF && anTag(parent) === AN_TS_TYPE_ANNOTATION && anTag(anParent(parent)) === AN_TS_PROPERTY_SIGNATURE) {
      writeTrailingCommentsOf(parent, f);
    }
  }
}

/**
 * For oxfmt a `prettier-ignore` comment before a union is about the union, as before anything else.
 * For Prettier one on a line of its own is about the first type.
 */
export function prettierIgnoreBeforeUnionIsAboutAllOfIt(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `A /* prettier-ignore *&#47; | B`: for oxfmt a comment behind a type is only about it if it ends the line. */
function prettierIgnoreBehindTypeEndsItsLine(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** Whether what the union `ty` is in has written a `prettier-ignore` comment that leads it, outside of its parentheses. */
function followsPrintedSuppressionComment(ty: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  if (!cm.hasSuppressionComments) return false;
  typeSpan(ty);
  let end = SP.s0 | 0;
  const src = cm.source;
  for (let i = cm.printedCount - 1; i >= 0; i--) {
    const isAdjacent = !cm.isMoved(i) && (cm.spanEnd[i] | 0) <= end && src.allBytes(cm.spanEnd[i] | 0, end, BT_WS_OPEN_PAREN);
    if (!isAdjacent) return false;
    if (cm.isSuppressionComment(i)) {
      // At the end of a line it trails what is before it.
      return cm.precededByNewline(i);
    }
    end = cm.spanStart[i] | 0;
  }
  return false;
}

/**
 * oxfmt follows Prettier 3.8: a union that does not fit where it is has each type on a line of its
 * own. 3.9 first tries all of them on one line, after a line break.
 *
 * ```ts
 * type A =              type A =
 *   | "aaaaaaaaaa"        "aaaaaaaaaa" | "bbbbbbbbbb";
 *   | "bbbbbbbbbb";
 * ```
 */
export function unionBreaksOnePerLine(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** The union `ty` is a branch of a conditional type (`parent`): it is in the `?` or the `:` part. */
function isBranchOfConditionalType(parent: number, tyStart: number, tyEnd: number): boolean {
  if (anTag(parent) !== AN_TS_CONDITIONAL_TYPE) return false;
  const cond = anId(parent);
  typeSpan(typeCondYes(cond));
  const SP$ = SP;
  if ((SP$.s0 | 0) <= tyStart && tyEnd <= (SP$.s1 | 0)) return true;
  typeSpan(typeCondNo(cond));
  return (SP$.s0 | 0) <= tyStart && tyEnd <= (SP$.s1 | 0);
}

/**
 * oxc's `TSUnionType::write`, which is `printUnionType` of Prettier 3.8, for a union that is not written like an object type.
 */
function writeUnionOnePerLine(
  ty: number,
  typesStart: number,
  typesLen: number,
  parent: number,
  isFirstTypeSuppressed: boolean,
  isOneOfSeveralTupleElements: boolean,
  f: Formatter,
): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  typeSpan(ty);
  const SP$ = SP;
  const tyStart = SP$.s0 | 0;
  const tyEnd = SP$.s1 | 0;
  let leadingFrom = 0;
  let leadingTo = 0;
  if (!cx.isQuiet) {
    cm.commentsBefore(tyStart);
    leadingFrom = cm.from;
    leadingTo = cm.to;
  }
  const parentTag = anTag(parent);
  const isInTypeAlias = parentTag === AN_TS_TYPE_ALIAS_DECLARATION;
  let hasEndOfLineComment = false;
  let hasOwnLine = false;
  let hasAfterCodeAtEndOfLineNotJsdoc = false;
  for (let i = leadingFrom; i < leadingTo; i++) {
    if (cm.followedByNewline(i)) hasEndOfLineComment = true;
    if (cm.precededByNewline(i)) hasOwnLine = true;
    if (cm.isBlock(i) && !cm.precededByNewline(i) && cm.followedByNewline(i) && !isJsdoc(i, f)) hasAfterCodeAtEndOfLineNotJsdoc = true;
  }
  // Comments go behind the `|` that is written before the first type, which writes them, wherever they are in the
  // text. Only if one of them ends its line do they all stay before it: there would be a line break between the
  // `|` and the type.
  //
  // ```ts
  // type A = /* comment */ B | C;      type A =
  //                                      | /* comment */ B
  //                                      | C;
  // ```
  const hasCommentsBeforeOperator = hasEndOfLineComment && leadingTo > leadingFrom;
  // After the `?` or `:` of a conditional type the comments are behind the operator, and what follows is in line
  // with them.
  const isBranch = isBranchOfConditionalType(parent, tyStart, tyEnd);

  let shouldIndent = true;
  switch (parentTag) {
    case AN_TS_TYPE_ASSERTION:
    case AN_TS_TUPLE_TYPE:
      shouldIndent = false;
      break;
    // The line break after the `=`, which a comment forces, comes with an indentation.
    case AN_TS_TYPE_ALIAS_DECLARATION:
      shouldIndent = !typeAliasUnionBreaksAfterOperator(anId(parent), leadingFrom, leadingTo, f);
      break;
    case AN_TS_CONDITIONAL_TYPE:
      if (isBranch) shouldIndent = !hasCommentsBeforeOperator;
      break;
    // A line comment before `as` is written behind it, with a line break and an indentation.
    case AN_TS_AS_EXPRESSION:
    case AN_TS_SATISFIES_EXPRESSION: {
      const cast = anId(parent);
      const tag = exprTag(cast);
      let hasLineComment = false;
      if (tag === EXPR_AS) hasLineComment = cm.hasPrintedLineCommentAfter(exprEnd(exprAsExpr(cast)));
      else if (tag === EXPR_SATISFIES) hasLineComment = cm.hasPrintedLineCommentAfter(exprEnd(exprSatisfiesExpr(cast)));
      shouldIndent = !hasLineComment;
      break;
    }
    default:
      if (anIsTypeParameterInstantiation(parent)) shouldIndent = false;
      break;
  }
  const needsParens = needsParentheses(ty, f);
  const startsWithLineBreak = shouldIndent && !hasCommentsBeforeOperator;

  // `| (A | B)`
  const isOnlyType = anTag(typeAstParent(ty)) === AN_TS_UNION_TYPE && parentTag !== AN_TS_UNION_TYPE;
  const hasOwnLineComment = hasOwnLine || (isInTypeAlias && hasAfterCodeAtEndOfLineNotJsdoc);
  const breaksBeforeComments = (hasOwnLineComment || (hasEndOfLineComment && isOnlyType)) && !isBranch;

  const indentsInner = shouldIndent && !needsParens;
  if (indentsInner) {
    f.startGroup();
    f.startIndent();
  } else {
    f.startGroup();
  }
  // inner
  if (breaksBeforeComments) f.softLineBreak();
  if (hasCommentsBeforeOperator) formatLeadingCommentsRange(leadingFrom, leadingTo, f);
  f.startGroup();
  // content
  if (needsParens) {
    f.startIndent();
    writeOnePerLineTypes(ty, typesStart, typesLen, parent, isFirstTypeSuppressed, startsWithLineBreak, f);
    f.endIndent();
    f.softLineBreak();
  } else if (isOneOfSeveralTupleElements) {
    f.startIndent();
    f.startIfGroupBreaks();
    f.token(LPAREN);
    f.softLineBreak();
    f.endConditional();
    writeOnePerLineTypes(ty, typesStart, typesLen, parent, isFirstTypeSuppressed, startsWithLineBreak, f);
    f.endIndent();
    f.softLineBreak();
    f.tokenIfBreaks(RPAREN);
  } else {
    writeOnePerLineTypes(ty, typesStart, typesLen, parent, isFirstTypeSuppressed, startsWithLineBreak, f);
  }
  f.endGroup();
  if (indentsInner) f.endIndent();
  f.endGroup();
}

/** `types` of `write_union_one_per_line`. */
function writeOnePerLineTypes(
  ty: number,
  typesStart: number,
  typesLen: number,
  parent: number,
  isFirstTypeSuppressed: boolean,
  startsWithLineBreak: boolean,
  f: Formatter,
): void {
  if (startsWithLineBreak) {
    f.startIfGroupBreaks();
    f.softLineBreakOrSpace();
    f.token(PIPE_AFTER);
    f.endConditional();
  } else {
    f.tokenIfBreaks(PIPE_AFTER);
  }
  writeMembers(ty, typesStart, typesLen, parent, isFirstTypeSuppressed, f);
}

function isJsdoc(i: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  const start = cm.spanStart[i] | 0;
  const text = cm.source.text;
  return (text[start] | 0) === 47 && (text[start + 1] | 0) === 42 && (text[start + 2] | 0) === 42;
}

/**
 * oxc's `alias_union_breaks_after_operator`: whether the union that is the type of the type alias `statement` leaves
 * the line break and the indentation to the `=`. `leading_comments`: those that are left before the union, `[leadingFrom, leadingTo)`.
 *
 * - A JSDoc comment behind code ends its line, or one over several lines has its stars lined up.
 * - A comment that has been written behind the left side ends the line of the `=`.
 */
export function typeAliasUnionBreaksAfterOperator(statement: number, leadingFrom: number, leadingTo: number, f: Formatter): boolean {
  if (stmtTag(statement) !== STMT_TYPE_ALIAS) return false;
  const alias = stmtTypeAliasAlias(statement);
  let leftEnd = 0;
  if (typeParamListAngleBrackets(aliasTypeParamsStart(alias), aliasTypeParamsLen(alias))) leftEnd = SP.s1 | 0;
  else leftEnd = identEndOf(aliasName(alias), aliasNamePos(alias));
  const cm = cxOf(f).comments;
  for (let i = leadingFrom; i < leadingTo; i++) {
    if (cm.isIndentableBlock(i) || (isJsdoc(i, f) && !cm.precededByNewline(i) && cm.followedByNewline(i))) return true;
  }
  const last = cm.lastPrinted();
  return last >= 0 && cm.followedByNewline(last) && (cm.spanStart[last] | 0) > leftEnd;
}

/**
 * oxc's `union_prints_itself`: a union that a `prettier-ignore` comment is about is written as it is, and what it is
 * in treats it like any other type.
 */
export function unionPrintsItself(ty: number, f: Formatter): boolean {
  if (typeTag(ty) !== TYPE_UNION) return false;
  const cx = cxOf(f);
  if (cx.isQuiet) return true;
  typeSpan(ty);
  const SP$ = SP;
  return !(cx.comments.isSuppressed(SP$.s0 | 0) || cx.comments.hasTrailingSuppressionComment(SP$.s1 | 0));
}

/** Prettier's `shouldIndentUnionType`. */
function shouldIndentUnionType(ty: number, parent: number): boolean {
  const SP$ = SP;
  switch (anTag(parent)) {
    case AN_TS_TYPE_ASSERTION:
    case AN_TS_TUPLE_TYPE:
      return false;
    case AN_TS_CONDITIONAL_TYPE: {
      typeSpan(ty);
      const tyStart = SP$.s0 | 0;
      const tyEnd = SP$.s1 | 0;
      return !isBranchOfConditionalType(parent, tyStart, tyEnd);
    }
    default:
      if (anIsTypeParameterInstantiation(parent)) return false;
      return !(fileIsFlow() && isUnionIndentedByParameters(ty));
  }
}

/** The types of a union that is not on one line with an object type, and the `|` between them (`UnionMembers::fmt`). */
function writeMembers(ty: number, typesStart: number, typesLen: number, parent: number, isFirstTypeSuppressed: boolean, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  if (cx.isQuiet && !isFirstTypeSuppressed) {
    for (let index = 0; index < typesLen; index++) {
      if (index > 0) {
        f.softLineBreakOrSpace();
        f.token(PIPE_AFTER);
      }
      f.startAlign(2);
      fmtType(listAt(typesStart, index), f);
      f.endAlign(2);
    }
    return;
  }

  let isSuppressed = isFirstTypeSuppressed;
  const oneEndsItsLine = prettierIgnoreBehindTypeEndsItsLine(f);
  const breaksOnePerLine = unionBreaksOnePerLine(f);
  const SP$ = SP;
  for (let index = 0; index < typesLen; index++) {
    const member = listAt(typesStart, index);
    const next = index + 1 < typesLen ? listAt(typesStart, index + 1) : -1;
    commentsBeforeMember(member, f);
    const leadingFrom = MB[0] | 0;
    const leadingTo = MB[1] | 0;
    // A `prettier-ignore` comment leads it, or trails it with the `|` behind it.
    let isMemberSuppressed = isSuppressed;
    if (!isMemberSuppressed) {
      for (let i = leadingFrom; i < leadingTo; i++) {
        if (cm.isSuppressionComment(i)) {
          isMemberSuppressed = true;
          break;
        }
      }
    }
    if (!isMemberSuppressed && !oneEndsItsLine && next >= 0) {
      typeSpan(member);
      const memberEnd = SP$.s1 | 0;
      typeSpan(next);
      const nextStart = SP$.s0 | 0;
      cm.commentsIn(memberEnd, nextStart);
      const from = cm.from;
      const to = cm.to;
      const trailing = to - countLeadingComments(from, to, nextStart, f);
      for (let i = from; i < trailing; i++) {
        if (cm.isSuppressionComment(i) && !cm.precededByNewline(i)) {
          isMemberSuppressed = true;
          break;
        }
      }
    }

    // The comments after a type are only aligned with it if there are comments before it. Never for oxfmt.
    if (leadingTo <= leadingFrom) {
      f.startAlign(2);
      writeMember(member, isMemberSuppressed, f);
      f.endAlign(2);
      isSuppressed = writeTrailingOfMember(ty, parent, next, f);
    } else if (breaksOnePerLine) {
      f.startAlign(2);
      formatLeadingCommentsRange(leadingFrom, leadingTo, f);
      writeMember(member, isMemberSuppressed, f);
      f.endAlign(2);
      isSuppressed = writeTrailingOfMember(ty, parent, next, f);
    } else {
      f.startAlign(2);
      formatLeadingCommentsRange(leadingFrom, leadingTo, f);
      writeMember(member, isMemberSuppressed, f);
      isSuppressed = writeTrailingOfMember(ty, parent, next, f);
      f.endAlign(2);
    }
    if (next >= 0) {
      f.softLineBreakOrSpace();
      f.token(PIPE_AFTER);
    }
  }
}

/**
 * `format_trailing_comments` of `UnionMembers::fmt`: the comments between `member` and the next type that do not lead that one. Returns the
 * new value of `is_suppressed`: the next type is the one a `prettier-ignore` comment on a line of its own is about.
 */
function writeTrailingOfMember(ty: number, parent: number, next: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  let isSuppressed = false;
  if (next >= 0) {
    commentsBeforeMember(next, f);
    const from = MB[0] | 0;
    const to = MB[1] | 0;
    const start = MB[2] | 0;
    // Prettier's `handleUnionTypeComments`: on a line of its own it is about the next type.
    for (let i = from; i < to; i++) {
      if (cm.isSuppressionComment(i) && cm.precededByNewline(i)) {
        isSuppressed = true;
        break;
      }
    }
    formatTrailingCommentsRange(from, to - countLeadingComments(from, to, start, f), f);
  } else {
    // `A | (B /* comment */)`
    typeSpan(ty);
    cm.commentsBefore(SP.s1 | 0);
    formatTrailingCommentsRange(cm.from, cm.to, f);
    const t = commentsAfterLastMember(ty, parent, f);
    formatTrailingCommentsRange(cm.from, t, f);
  }
  return isSuppressed;
}

/**
 * Prettier's `handleLastUnionElementInExpression`: a comment at the end of a line after a union in parentheses is written after its last
 * type.
 *
 * ```ts
 * type A = (
 *   | "a" // comment
 *   | "b" // comment
 * )[];
 * ```
 *
 * Sets `cm.from` and returns the end of the range.
 */
function commentsAfterLastMember(ty: number, parent: number, f: Formatter): number {
  const cm = cxOf(f).comments;
  const t = anTag(parent);
  if (t !== AN_TS_ARRAY_TYPE && t !== AN_TS_UNION_TYPE && t !== AN_TS_INTERSECTION_TYPE) {
    cm.from = cm.printedCount;
    return cm.printedCount;
  }
  // Only those that are in the parent.
  typeSpan(ty);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const spanEnd = SP$.s1 | 0;
  const parentEnd = anEnd(parent);
  const following = followingSpanStartIn(start, spanEnd, parent, f.options.flavor);
  let end = parentEnd;
  if (following !== 0) end = following < parentEnd ? following : parentEnd;
  cm.commentsIn(spanEnd, end);
  const from = cm.from;
  const to = cm.to;
  const result = endOfLineComments(f, from, to);
  cm.from = from;
  return result;
}

/**
 * The comments before `member` that are not written by `member` itself, and where the rest of them, or `member`, starts:
 * `MB[0]..MB[1]` is the range, `MB[2]` the position.
 */
const MB = new Int32Array(3);

function commentsBeforeMember(member: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  typeSpan(member);
  const start = SP.s0 | 0;
  if (typeTag(member) === TYPE_UNION && typeUnionTypesLen(member) > 1) {
    const at = unionLeadingComments(member, f);
    MB[0] = cm.from;
    MB[1] = at;
    MB[2] = at < cm.to ? cm.spanStart[at] | 0 : start;
  } else {
    cm.commentsBefore(start);
    MB[0] = cm.from;
    MB[1] = cm.to;
    MB[2] = start;
  }
}

/**
 * How many of the comments `[from, to)`, which are between two types of a union, lead the second one, which starts at `start`: those that
 * are after the `|` on the line of the type. All others trail the first type (Prettier's `handleUnionTypeComments`).
 */
function countLeadingComments(from: number, to: number, start: number, f: Formatter): number {
  const cm = cxOf(f).comments;
  let end = start;
  let count = 0;
  for (let i = to - 1; i >= from; i--) {
    const isAdjacent = !cm.followedByNewline(i) && cm.source.allBytes(cm.spanEnd[i] | 0, end, BT_WS_OPEN_PAREN);
    if (!isAdjacent) break;
    if (cm.precededByNewline(i)) return 0;
    count = (count + 1) | 0;
    end = cm.spanStart[i] | 0;
  }
  return count;
}

/** A type of a union. The comments before it are written, those after it are not. */
function writeMember(member: number, isSuppressed: boolean, f: Formatter): void {
  typeSpan(member);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  if (!isSuppressed && !cxOf(f).comments.hasTrailingSuppressionComment(end)) {
    // It takes some of the comments after it: see `commentsAfterLastMember`.
    if (typeTag(member) === TYPE_UNION && typeUnionTypesLen(member) > 1) fmtType(member, f);
    else fmtNodeWithoutTrailingComments(WK_TYPE, member, f);
    return;
  }
  const needsParens = needsParentheses(member, f);
  if (needsParens) f.token(LPAREN);
  writeSuppressedNode(start, end, f);
  if (needsParens) f.token(RPAREN);
}
