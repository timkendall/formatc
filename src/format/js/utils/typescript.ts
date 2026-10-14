// Port of vendor/bun/src/format/js/utils/typescript.rs.
import { Formatter } from "../../ir/formatter.ts";
import {
  KW_NULL,
  KW_VOID,
  KW_INTRINSIC,
  SP,
  TYPE_ARRAY,
  TYPE_BIG_INT_LIT,
  TYPE_BOOL_LIT,
  TYPE_INTERSECTION,
  TYPE_KEYWORD,
  TYPE_MAPPED,
  TYPE_NUMBER_LIT,
  TYPE_OBJECT,
  TYPE_REF,
  TYPE_STRING_LIT,
  TYPE_TEMPLATE,
  TYPE_UNION,
  listAt,
  typeIntersectionTypesLen,
  typeIntersectionTypesStart,
  typeKeywordKeyword,
  typeRefArgsLen,
  typeSpan,
  typeTag,
  typeUnionTypesLen,
  typeUnionTypesStart,
} from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";
import { isInterfaceType } from "../print/flow.ts";
import { BT_SPACE_TAB } from "../source_text.ts";

/** A keyword, a literal, or a name without type arguments. */
export function isSimpleType(ty: number): boolean {
  switch (typeTag(ty)) {
    case TYPE_KEYWORD:
      return typeKeywordKeyword(ty) !== KW_INTRINSIC;
    case TYPE_TEMPLATE:
    case TYPE_STRING_LIT:
    case TYPE_NUMBER_LIT:
    case TYPE_BIG_INT_LIT:
    case TYPE_BOOL_LIT:
      return true;
    case TYPE_REF:
      return typeRefArgsLen(ty) === 0;
    default:
      return false;
  }
}

/** `{ .. }`: a type literal or a mapped type. */
export function isObjectLikeType(ty: number): boolean {
  const t = typeTag(ty);
  return t === TYPE_OBJECT || t === TYPE_MAPPED;
}

/** `| A` and `& A` are a union and an intersection of one type here. Prettier's parsers have them as `A`. */
export function withoutLoneOperator(ty0: number): number {
  let ty = ty0;
  while (true) {
    const t = typeTag(ty);
    let start = 0;
    let len = 0;
    if (t === TYPE_UNION) {
      start = typeUnionTypesStart(ty);
      len = typeUnionTypesLen(ty);
    } else if (t === TYPE_INTERSECTION) {
      start = typeIntersectionTypesStart(ty);
      len = typeIntersectionTypesLen(ty);
    }
    if (len === 1 && !isInterfaceType(ty)) ty = listAt(start, 0);
    else return ty;
  }
}

/**
 * Those at the start of the comments `[from, to)` for which Prettier's `isEndOfLineComment` holds and `isOwnLineComment` does not: there is
 * code before them on their line, and none after them. Returns the new `to` (the range is `[from, result)`).
 */
export function endOfLineComments(f: Formatter, from: number, to: number): number {
  const cm = cxOf(f).comments;
  let count = 0;
  for (let i = from; i < to; i++) {
    if (cm.precededByNewline(i)) break;
    if (cm.followedByNewline(i)) count = (i - from + 1) | 0;
  }
  return from + count;
}

/**
 * The comments before the union `ty`: those that lead the union, and those that lead its first type. Returns the index where the second
 * range starts: the comments before it `[cm.from, result)` lead the union, `[result, cm.to)` lead its first type.
 *
 * Prettier's `shouldAttachToUnionTypeFirstElement`: a block comment on one line, with nothing but blanks and other comments between it and
 * the union.
 */
export function unionLeadingComments(ty: number, f: Formatter): number {
  const cx = cxOf(f);
  const cm = cx.comments;
  if (cx.isQuiet) {
    cm.from = cm.printedCount;
    cm.to = cm.printedCount;
    return cm.printedCount;
  }
  typeSpan(ty);
  const start = SP.s0 | 0;
  cm.commentsBefore(start);
  const from = cm.from;
  const to = cm.to;
  let end = start;
  let at = to;
  for (let i = to - 1; i >= from; i--) {
    const isAdjacent =
      cm.isBlock(i) && !cm.isMultilineBlock(i) && !cm.isSuppressionComment(i) && cx.src.allBytes(cm.spanEnd[i] | 0, end, BT_SPACE_TAB);
    if (!isAdjacent) break;
    end = cm.spanStart[i] | 0;
    at = i;
  }
  cm.from = from;
  cm.to = to;
  return at;
}

/** Prettier's `shouldHugUnionType` for the union `ty`: it is one object type or name, and otherwise only `null` and `void`. */
export function shouldHugType(ty: number, typesStart: number, typesLen: number, f: Formatter): boolean {
  let objectType = -1;
  for (let i = 0; i < typesLen; i++) {
    const t = listAt(typesStart, i);
    const k = typeTag(t);
    if (k === TYPE_OBJECT || k === TYPE_REF) {
      objectType = t;
      break;
    }
  }
  if (objectType < 0) return false;
  for (let i = 0; i < typesLen; i++) {
    const t = listAt(typesStart, i);
    if (t === objectType) continue;
    if (typeTag(t) !== TYPE_KEYWORD) return false;
    const kw = typeKeywordKeyword(t);
    if (kw !== KW_VOID && kw !== KW_NULL) return false;
  }
  // Not if one of the types has a comment.
  const cx = cxOf(f);
  if (cx.isQuiet) return true;
  const at = unionLeadingComments(ty, f);
  if (cx.comments.to > at) return false;
  typeSpan(ty);
  const SP$ = SP;
  let start = SP$.s0 | 0;
  for (let i = 0; i < typesLen; i++) {
    const t = listAt(typesStart, i);
    typeSpan(t);
    if (cx.comments.hasCommentInRange(start, SP$.s0 | 0)) return false;
    start = SP$.s1 | 0;
  }
  return true;
}

void TYPE_ARRAY;
