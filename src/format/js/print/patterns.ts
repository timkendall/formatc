// Port of vendor/bun/src/format/js/print/patterns.rs: binding patterns: `a`, `{ a, b: c = 1, ...d }`, `[a, , b = 1, ...c]`.
import { Formatter } from "../../ir/formatter.ts";
import { ELLIPSIS, EQ, LBRACKET, RBRACKET } from "../../ir/tokens.ts";
import {
  PAT_ARRAY,
  PAT_IDENT,
  PAT_MISSING,
  PAT_OBJECT,
  SP,
  exprSpan,
  exprEnd,
  exprStart,
  keyLoad,
  keySpan,
  KEY_NONE,
  listAt,
  nodeOfPatProp,
  patArrayElemsLen,
  patArrayElemsStart,
  patElemDefault,
  patElemIsRest,
  patElemParent,
  patElemPat,
  patElemSpan,
  patObjectPropsLen,
  patObjectPropsStart,
  patPropDefault,
  patPropIsRest,
  patPropIsShorthand,
  patPropSpan,
  patPropValue,
  patSpan,
  patStart,
  patTag,
} from "../../../lint/ast/index.ts";
import { AN_BINDING_PROPERTY, mkAn, nodeAsAstNodes } from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { PK_PARENT, WK_PAT_ELEM, enterScope, fmtExpr, fmtPat, fmtPatElem, leaveScope, writeTrailingCommentsIn } from "../format.ts";
import { DANGLING_SOFT, formatDanglingComments, formatLeadingComments, formatLeadingCommentsRange } from "../trivia.ts";
import { writeArrayNode } from "../utils/array.ts";
import { ASSIGNMENT_LIKE_BINDING_PROPERTY, commentsStayAroundOperator, fmtAssignmentLike } from "../utils/assignment_like.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { writeObjectPatternLikePattern } from "./object_pattern_like.ts";

export function writeBindingPattern(pat: number, f: Formatter): void {
  switch (patTag(pat)) {
    case PAT_MISSING:
      return;
    case PAT_IDENT:
      patSpan(pat);
      f.sourceText(SP[0] | 0, SP[1] | 0);
      return;
    case PAT_OBJECT:
      if (!f.stack.enter()) return;
      writeObjectPatternLikePattern(pat, patObjectPropsStart(pat), patObjectPropsLen(pat), f);
      f.stack.leave();
      return;
    case PAT_ARRAY:
      if (!f.stack.enter()) return;
      writeArrayPattern(pat, patArrayElemsStart(pat), patArrayElemsLen(pat), f);
      f.stack.leave();
      return;
    default:
      return;
  }
}

function writeArrayPattern(pat: number, elementsStart: number, elementsLen: number, f: Formatter): void {
  f.token(LBRACKET);
  if (elementsLen === 0) {
    patSpan(pat);
    formatDanglingComments(SP[0] | 0, SP[1] | 0, DANGLING_SOFT, f);
  } else {
    const last = listAt(elementsStart, elementsLen - 1);
    const rest = isRestElement(last) ? last : -1;
    const count = elementsLen - (rest >= 0 ? 1 : 0);
    f.startGroup();
    f.startSoftBlockIndent();
    if (count > 0) writeArrayNode(elementsLen, WK_PAT_ELEM, elementsStart, count, f);
    if (rest >= 0) fmtPatElem(rest, f);
    f.endSoftBlockIndent();
    f.endGroup();
  }
  f.token(RBRACKET);
}

/** `left = right`, ESTree's `AssignmentPattern`. */
function writeAssignmentPattern(left: number, right: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  // So that the comments in it are not taken for comments before the `=`.
  const slot = f.startCapture();
  fmtPat(left, f);
  const captured = f.endCapture(slot);
  const n = cm.ownLineCommentsBefore(exprStart(right));
  const from = cm.from;
  formatLeadingCommentsRange(from, (from + n) | 0, f);
  f.startGroup();
  f.writeInterned(captured);
  f.endGroup();
  f.space();
  f.token(EQ);
  f.space();
  fmtExpr(right, f);
}

/** `[...a = 1]` is an error, and `a = 1` in typescript-estree's tree. */
function isRestElement(element: number): boolean {
  return patElemIsRest(element) && patElemDefault(element) < 0;
}

/** `a`, `a = 1`, `...a` in an array pattern. */
export function writeArrayPatternElement(element: number, f: Formatter): void {
  const pat = patElemPat(element);
  if (pat < 0) return;
  const rest = isRestElement(element);
  const def = patElemDefault(element);
  if (!rest && def < 0) {
    fmtPat(pat, f);
    return;
  }
  const cx = cxOf(f);
  const parent = nodeAsAstNodes(patElemParent(element));
  // format_node(element.span(), parent, f, ..)
  patElemSpan(element);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  if (cx.isQuiet) {
    writeRestOrDefault(rest, pat, def, f);
    return;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    writeRestOrDefault(rest, pat, def, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_PARENT, parent, f);
}

function writeRestOrDefault(rest: boolean, pat: number, def: number, f: Formatter): void {
  if (rest) {
    f.token(ELLIPSIS);
    fmtPat(pat, f);
  } else writeAssignmentPattern(pat, def, f);
}

/** `a`, `a: b`, `a = 1`, `a: b = 1`, `...a` in an object pattern. */
export function writeBindingProperty(property: number, f: Formatter): void {
  if (patPropIsRest(property)) {
    f.token(ELLIPSIS);
    fmtPat(patPropValue(property), f);
    return;
  }
  const cx = cxOf(f);
  // Prettier's `handlePropertyComments`: a comment at the end of the line of the key leads the property.
  if (!cx.isQuiet && !commentsStayAroundOperator(f) && !patPropIsShorthand(property)) {
    const owner = nodeOfPatProp(property);
    if (keyLoad(owner) !== KEY_NONE && keySpan(owner)) {
      const keyStart = SP[0] | 0;
      const keyEnd = SP[1] | 0;
      const cm = cx.comments;
      if (!cm.hasCommentInRange(keyStart, keyEnd)) {
        const n = cm.commentsLeadingProperty(keyEnd, patStart(patPropValue(property)));
        const from = cm.from;
        for (let i = 0; i < n; i++) {
          if (cm.isSuppressionComment((from + i) | 0)) {
            patPropSpan(property);
            writeSuppressedNode(SP[0] | 0, SP[1] | 0, f);
            return;
          }
        }
        formatLeadingCommentsRange(from, (from + n) | 0, f);
      }
    }
  }
  fmtAssignmentLike(ASSIGNMENT_LIKE_BINDING_PROPERTY, property, f);
}

/** `FormatBindingPropertyValue(prop)`: `BindingProperty.value`: the `b = 1` of `a: b = 1`, the `a = 1` of `{ a = 1 }`. */
export function fmtBindingPropertyValue(property: number, f: Formatter): void {
  const value = patPropValue(property);
  const def = patPropDefault(property);
  if (def < 0) {
    fmtPat(value, f);
    return;
  }
  const cx = cxOf(f);
  // format_node(value.span().to(default.span()), || BindingProperty(property), f, ..)
  patSpan(value);
  const start = SP[0] | 0;
  const end = exprEnd(def);
  if (cx.isQuiet) {
    writeAssignmentPattern(value, def, f);
    return;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    writeAssignmentPattern(value, def, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_PARENT, mkAn(AN_BINDING_PROPERTY, property), f);
}
