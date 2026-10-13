// Port of vendor/bun/src/format/js/print/as_or_satisfies_expression.rs: `a as T`, `a as const`, `a satisfies T`.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { SPACE_TOKEN } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_SATISFIES,
  SP,
  TYPE_UNION,
  exprAsConstExpr,
  exprAsExpr,
  exprAsTy,
  exprConstKeywordSpan,
  exprIndexObj,
  exprSatisfiesExpr,
  exprSatisfiesTy,
  exprSpan,
  exprTag,
  typeStart,
  typeTag,
} from "../../../lint/ast/index.ts";
import {
  AN_COMPUTED_MEMBER_EXPRESSION,
  AN_NEW_EXPRESSION,
  AN_PRIVATE_FIELD_EXPRESSION,
  AN_STATIC_MEMBER_EXPRESSION,
  anId,
  anIsCallLikeCallee,
  anTag,
  exprAstParent,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { WK_EXPR, fmtExpr, fmtType } from "../format.ts";
import { formatLeadingCommentsRange, formatTrailingCommentsRange } from "../trivia.ts";
import { fmtNodeWithoutTrailingComments } from "../utils/format_node_without_trailing_comments.ts";

const T_AS = token("as");
const T_SATISFIES = token("satisfies");
const T_CONST = token("const");

/** Prettier 3.9 writes `new (⏎ a as T⏎)()` like `(⏎ a as T⏎)()`. oxfmt follows 3.8, in which only `T` can break. */
function breaksAroundTheCalleeOfNew(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/**
 * For oxfmt the comments around `as` and `satisfies` stay on the side of the operator that they are on, and start a line if they do in the source.
 * Prettier attaches them to the expression or to the type.
 */
function commentsStayAroundCastOperator(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** The type: `ty` (-1 for `const`), with the comments before `const` that nothing else writes. */
function writeType(ty: number, typeStartPos: number, withLeadingComments: boolean, f: Formatter): void {
  if (ty >= 0) {
    fmtType(ty, f);
    return;
  }
  if (withLeadingComments) {
    const cm = cxOf(f).comments;
    const n = cm.commentsBefore(typeStartPos);
    const from = cm.from;
    formatLeadingCommentsRange(from, (from + n) | 0, f);
  }
  f.token(T_CONST);
}

/**
 * See `commentsStayAroundCastOperator`. `[from, to)`: the comments between `expression` and the type. `isUnion`: the type is a union, which places the
 * comments before it itself.
 */
function writeWithCommentsInPlace(
  expression: number,
  operation: number,
  operator: number,
  from: number,
  to: number,
  isUnion: boolean,
  ty: number,
  typeStartPos: number,
  f: Formatter,
): void {
  const cm = cxOf(f).comments;
  // One that is about the type has to be seen by it: then all are left to the type.
  let hasSuppressionComment = false;
  for (let i = from; i < to; i++) {
    if (cm.isSuppressionComment(i)) {
      hasSuppressionComment = true;
      break;
    }
  }
  exprSpan(expression);
  let beforeOperatorCount = cm.commentsBeforeCharacter(SP[1] | 0, operator);
  if (beforeOperatorCount > to - from) beforeOperatorCount = (to - from) | 0;
  const split = (from + beforeOperatorCount) | 0;
  // No line break can be before the operator: only block comments on the line of the expression stay there. A line comment is written behind the
  // operator anyway.
  let gluedBeforeEnd = from;
  while (gluedBeforeEnd < split && !cm.precededByNewline(gluedBeforeEnd) && !cm.isMultilineBlock(gluedBeforeEnd)) gluedBeforeEnd = (gluedBeforeEnd + 1) | 0;
  // Those on the line of the operator.
  let gluedAfterEnd = split;
  if (!(isUnion || gluedBeforeEnd < split)) {
    while (gluedAfterEnd < to && !(cm.precededByNewline(gluedAfterEnd) || (cm.isMultilineBlock(gluedAfterEnd) && cm.followedByNewline(gluedAfterEnd)))) {
      gluedAfterEnd = (gluedAfterEnd + 1) | 0;
    }
  }
  let isTypeOnNextLine = false;
  for (let i = from; i < gluedBeforeEnd && !isTypeOnNextLine; i++) if (cm.isLine(i)) isTypeOnNextLine = true;
  for (let i = split; i < gluedAfterEnd && !isTypeOnNextLine; i++) if (cm.isLine(i)) isTypeOnNextLine = true;
  if (!isTypeOnNextLine && !isUnion) {
    // `moved` then `leading`
    for (let i = gluedBeforeEnd; i < split && !isTypeOnNextLine; i++) {
      if (cm.followedByNewline(i) && (cm.precededByNewline(i) || cm.isMultilineBlock(i))) isTypeOnNextLine = true;
    }
    for (let i = gluedAfterEnd; i < to && !isTypeOnNextLine; i++) {
      if (cm.followedByNewline(i) && (cm.precededByNewline(i) || cm.isMultilineBlock(i))) isTypeOnNextLine = true;
    }
  }

  fmtNodeWithoutTrailingComments(WK_EXPR, expression, f);
  if (!hasSuppressionComment) formatTrailingCommentsRange(from, gluedBeforeEnd, f);
  f.space();
  f.token(operation);
  if (!hasSuppressionComment) formatTrailingCommentsRange(split, gluedAfterEnd, f);
  if (isTypeOnNextLine) {
    f.startIndent();
    f.hardLineBreak();
    writeType(ty, typeStartPos, true, f);
    f.endIndent();
  } else {
    f.space();
    writeType(ty, typeStartPos, true, f);
  }
}

export function writeAsOrSatisfiesExpression(e: number, f: Formatter): void {
  let expression: number;
  let ty: number;
  let operation: number;
  const tag = exprTag(e);
  if (tag === EXPR_AS) {
    expression = exprAsExpr(e);
    ty = exprAsTy(e);
    operation = T_AS;
  } else if (tag === EXPR_AS_CONST) {
    expression = exprAsConstExpr(e);
    ty = -1;
    operation = T_AS;
  } else if (tag === EXPR_SATISFIES) {
    expression = exprSatisfiesExpr(e);
    ty = exprSatisfiesTy(e);
    operation = T_SATISFIES;
  } else return;
  let typeStartPos: number;
  if (ty >= 0) typeStartPos = typeStart(ty);
  else if (exprConstKeywordSpan(e)) typeStartPos = SP[0] | 0;
  else {
    exprSpan(e);
    typeStartPos = SP[1] | 0;
  }

  const parent = exprAstParent(e);
  const pt = anTag(parent);
  let isCalleeOrObject: boolean;
  if (pt === AN_STATIC_MEMBER_EXPRESSION || pt === AN_PRIVATE_FIELD_EXPRESSION) isCalleeOrObject = true;
  else if (pt === AN_COMPUTED_MEMBER_EXPRESSION) isCalleeOrObject = exprIndexObj(anId(parent)) === e;
  else if (pt === AN_NEW_EXPRESSION && !breaksAroundTheCalleeOfNew(f)) isCalleeOrObject = false;
  else isCalleeOrObject = anIsCallLikeCallee(parent, e);
  if (isCalleeOrObject) {
    f.startGroup();
    f.startSoftBlockIndent();
  }

  const cx = cxOf(f);
  const cm = cx.comments;
  let from = 0;
  let to = 0;
  if (!cx.isQuiet) {
    exprSpan(expression);
    cm.commentsIn(SP[1] | 0, typeStartPos);
    from = cm.from;
    to = cm.to;
  }
  if (to > from && commentsStayAroundCastOperator(f)) {
    const isUnion = ty >= 0 && typeTag(ty) === TYPE_UNION && !cm.isSuppressed(typeStart(ty));
    writeWithCommentsInPlace(expression, operation, operation === T_AS ? 97 : 115, from, to, isUnion, ty, typeStartPos, f);
  } else {
    // Those up to the first that spans several lines.
    let blockEnd = from;
    while (blockEnd < to && !cm.isMultilineBlock(blockEnd)) blockEnd = (blockEnd + 1) | 0;
    if (to > from && ty < 0) {
      fmtNodeWithoutTrailingComments(WK_EXPR, expression, f);
      formatTrailingCommentsRange(from, blockEnd, f);
      f.space();
      f.token(operation);
      f.space();
      f.token(T_CONST);
    } else if (blockEnd === from) {
      fmtNodeWithoutTrailingComments(WK_EXPR, expression, f);
      f.space();
      f.token(operation);
      f.space();
      writeType(ty, typeStartPos, false, f);
    } else {
      fmtExpr(expression, f);
      f.space();
      f.token(operation);
      // Prettier's space is text, which is seen before a line comment that trails the expression if the type starts on the next line:
      // `a as  // comment`.
      const last = cm.lastPrinted();
      if (last >= 0 && cm.isLine(last)) f.token(SPACE_TOKEN);
      else f.space();
      writeType(ty, typeStartPos, false, f);
    }
  }

  if (isCalleeOrObject) {
    f.endSoftBlockIndent();
    f.endGroup();
  }
}
