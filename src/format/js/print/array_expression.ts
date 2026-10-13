// Port of vendor/bun/src/format/js/print/array_expression.rs: `[a, b]`.
import { Formatter } from "../../ir/formatter.ts";
import { LBRACKET, RBRACKET } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  EXPR_ARRAY,
  EXPR_MISSING,
  EXPR_OBJECT,
  SP,
  exprArrayElemsLen,
  exprArrayElemsStart,
  exprObjectPropsLen,
  exprSpan,
  exprTag,
  listAt,
} from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";
import { DANGLING_NONE, DANGLING_SOFT, formatDanglingComments } from "../trivia.ts";
import { fmtArrayElementList } from "./array_element_list.ts";

/** `[1, , /* comment *&#47;]`: Prettier attaches the comment to the `1`. oxfmt leaves it where it is. */
function commentsStayBehindHoles(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `[a, b]` */
export function writeArrayExpression(e: number, elementsStart: number, elementsLen: number, f: Formatter): void {
  f.token(LBRACKET);
  exprSpan(e);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  if (elementsLen === 0) {
    formatDanglingComments(start, end, DANGLING_SOFT, f);
  } else {
    const cx = cxOf(f);
    const cm = cx.comments;
    const groupId = f.groupId();
    // `[, , /* comment */]`: there is no element that the comment could belong to.
    let hasLineComment = false;
    if (!cx.isQuiet) {
      let allMissing = true;
      for (let i = 0; i < elementsLen; i++) {
        if (exprTag(listAt(elementsStart, i)) !== EXPR_MISSING) {
          allMissing = false;
          break;
        }
      }
      if (allMissing) {
        const n = cm.commentsIn(start, end);
        const from = cm.from;
        for (let i = 0; i < n; i++) {
          if (cm.isLine((from + i) | 0)) {
            hasLineComment = true;
            break;
          }
        }
      }
    }
    // Where the comma ends that follows the last element that is no hole, if holes follow it.
    let holesStart = -1;
    if (!cx.isQuiet && commentsStayBehindHoles(f) && exprTag(listAt(elementsStart, elementsLen - 1)) === EXPR_MISSING) {
      for (let i = elementsLen - 1; i >= 0; i--) {
        const element = listAt(elementsStart, i);
        if (exprTag(element) !== EXPR_MISSING) {
          exprSpan(element);
          holesStart = cm.positionAfterCharacter(SP[1] | 0, 44);
          break;
        }
      }
    }
    f.startGroupWith(groupId, hasLineComment || shouldBreak(elementsStart, elementsLen));
    f.startSoftBlockIndent();
    const previousLimit = holesStart >= 0 ? cm.limitCommentsUpTo(holesStart) : 0;
    fmtArrayElementList(e, elementsStart, elementsLen, groupId, f);
    if (holesStart >= 0) cm.restoreViewLimit(previousLimit);
    formatDanglingComments(start, end, DANGLING_NONE, f);
    f.endSoftBlockIndent();
    f.endGroup();
  }
  f.token(RBRACKET);
}

/**
 * Prettier's `isConciselyPrintedArray`'s opposite `shouldBreak`: there are at least two elements, all are arrays or all are objects, and each has at
 * least two elements.
 */
function shouldBreak(start: number, len: number): boolean {
  if (len < 2) return false;
  for (let i = 0; i < len; i++) {
    const element = listAt(start, i);
    const t = exprTag(element);
    const next = i + 1 < len ? exprTag(listAt(start, i + 1)) : -1;
    let isUniform = false;
    if (t === EXPR_ARRAY) isUniform = exprArrayElemsLen(element) >= 2 && (next < 0 || next === EXPR_ARRAY);
    else if (t === EXPR_OBJECT) isUniform = exprObjectPropsLen(element) >= 2 && (next < 0 || next === EXPR_OBJECT);
    if (!isUniform) return false;
  }
  return true;
}
