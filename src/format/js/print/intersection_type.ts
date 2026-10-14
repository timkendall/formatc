// Port of vendor/bun/src/format/js/print/intersection_type.rs: `A & B`.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { FLAVOR_OXFMT, OPERATOR_POSITION_START } from "../../options.ts";
import { SP, TYPE_UNION, fileIsFlow, listAt, typeSpan, typeTag, typeUnionTypesLen } from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";
import { fmtType } from "../format.ts";
import { formatLeadingComments, formatLeadingCommentsRange } from "../trivia.ts";
import { isObjectLikeType, unionLeadingComments } from "../utils/typescript.ts";
import { isInterfaceType, writeInterfaceType } from "./flow.ts";

const AMP_SPACED = token(" & ");
const AMP_AFTER_SPACE = token(" &");
const AMP_BEFORE_SPACE = token("& ");

/** `A & B` */
export function writeTsIntersectionType(ty: number, typesStart: number, typesLen: number, f: Formatter): void {
  if (fileIsFlow() && isInterfaceType(ty)) {
    writeInterfaceType(typesStart, typesLen, f);
    return;
  }
  if (typesLen === 1) {
    if (loneTypeOfIntersectionIsAGroup(f)) {
      f.startGroup();
      fmtType(listAt(typesStart, 0), f);
      f.endGroup();
    } else {
      fmtType(listAt(typesStart, 0), f);
    }
    return;
  }
  f.startGroup();
  writeIntersectionTypes(typesStart, typesLen, f);
  f.endGroup();
}

/**
 * `& A` is an intersection for oxfmt, so a group: a block comment behind the `&` that ends its line is on the line of
 * `A` if that fits. For Prettier it is `A`.
 */
export function loneTypeOfIntersectionIsAGroup(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * With the `&` at the start of the line, oxfmt leaves a comment that is on a line of its own there, above the `&`.
 * Prettier writes it behind the `&`.
 */
function ownLineCommentsStayAboveOperator(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * ```ts
 * } & // comment      } &
 * {                     // comment
 *                       {
 * ```
 *
 * Prettier on the left: two object types are on the line of the `&` whatever is between them. oxfmt on the right.
 */
function commentAboveAnObjectTypeMovesItOffTheLine(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** The item of an intersection, with the comments before a union, which are outside of its parentheses. */
function writeItem(item: number, f: Formatter): void {
  // Not if the union is not formatted: then they are written with it.
  if (typeTag(item) === TYPE_UNION && typeUnionTypesLen(item) > 1) {
    const cm = cxOf(f).comments;
    const at = unionLeadingComments(item, f);
    const from = cm.from;
    let isSuppressed = false;
    for (let i = from; i < at; i++) {
      if (cm.isSuppressionComment(i) && !cm.precededByNewline(i)) {
        isSuppressed = true;
        break;
      }
    }
    if (!isSuppressed) formatLeadingCommentsRange(from, at, f);
  }
  fmtType(item, f);
}

/** Prettier's `printIntersectionType`: object types stay on the line of the `&`, other types go on a line of their own if it does not all fit. */
function writeIntersectionTypes(typesStart: number, typesLen: number, f: Formatter): void {
  const isOperatorAtStart = f.options.experimentalOperatorPosition === OPERATOR_POSITION_START;
  const cm = cxOf(f).comments;
  let isPrevObjectLike = false;
  let isChainIndented = false;

  const SP$ = SP;
  for (let index = 0; index < typesLen; index++) {
    const item = listAt(typesStart, index);
    const isObjectLike = isObjectLikeType(item);
    typeSpan(item);
    const itemStart = SP$.s0 | 0;
    const itemEnd = SP$.s1 | 0;

    if (index === 0) {
      writeItem(item, f);
    } else if (isPrevObjectLike && isObjectLike && !(commentAboveAnObjectTypeMovesItOffTheLine(f) && cm.hasLeadingOwnLineComment(itemStart))) {
      f.token(AMP_SPACED);
      if (isChainIndented) {
        f.startIndent();
        writeItem(item, f);
        f.endIndent();
      } else {
        writeItem(item, f);
      }
    } else if (!(isPrevObjectLike || isObjectLike) || cm.hasLeadingOwnLineComment(itemStart)) {
      f.startIndent();
      if (isOperatorAtStart) {
        f.softLineBreakOrSpace();
        if (ownLineCommentsStayAboveOperator(f) && cm.hasLeadingOwnLineComment(itemStart)) formatLeadingComments(itemStart, itemEnd, f);
        f.token(AMP_BEFORE_SPACE);
      } else {
        f.token(AMP_AFTER_SPACE);
        f.softLineBreakOrSpace();
      }
      writeItem(item, f);
      f.endIndent();
    } else if (index > 1) {
      isChainIndented = true;
      f.token(AMP_SPACED);
      f.startIndent();
      writeItem(item, f);
      f.endIndent();
    } else {
      f.token(AMP_SPACED);
      writeItem(item, f);
    }
    isPrevObjectLike = isObjectLike;
  }
}
