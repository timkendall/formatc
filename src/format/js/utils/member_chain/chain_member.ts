// Port of vendor/bun/src/format/js/utils/member_chain/chain_member.rs.
//
// A link of a chain of member accesses and calls. Only what the link adds to its object or its callee is written for it.
// A `ChainMember` is one int: `kind << 26 | expr` (`cmMake`, `cmKind`, `cmExpr`).
import { Formatter } from "../../../ir/formatter.ts";
import { DOT, LBRACKET, QUESTION, QUESTION_DOT, RBRACKET } from "../../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../../options.ts";
import {
  EXPR_CALL,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_INDEX,
  EXPR_NUMBER,
  N_EXPR,
  callCallee,
  callIsOptional,
  exprAsCallLike,
  exprDotName,
  exprDotNamePos,
  exprIndexIndex,
  exprIsOptional,
  exprParent,
  exprSpan,
  exprEnd,
  exprStart,
  exprTag,
  nodeId,
  nodeKind,
  SP,
} from "../../../../lint/ast/index.ts";
import { exprAsChainElement } from "../../ast_nodes.ts";
import { innerOfLink } from "../../comments.ts";
import { cxOf } from "../../context.ts";
import {
  WK_EXPR,
  fmtExpr,
  fmtNonNullMarks,
  identifier,
  noCommentTrailsWhatIsBeforeAnother,
  writeTrailingCommentsOf,
} from "../../format.ts";
import { fmtArgumentsOfCall } from "../../print/call_like_expression/arguments.ts";
import { fmtCallTypeArguments } from "../../print/call_like_expression/mod.ts";
import { writeLookupWithoutComments } from "../../print/member_expression.ts";
import { formatLeadingCommentsRange, formatTrailingCommentsRange } from "../../trivia.ts";
import { writeCalleeTrailingComments } from "../call_expression.ts";
import { fmtNodeWithoutTrailingComments } from "../format_node_without_trailing_comments.ts";
import { CM_STATIC_MEMBER, CM_CALL_MIDDLE, CM_CALL_END, CM_COMPUTED_MEMBER, CM_NON_NULL, CM_NODE } from "./chain_member.consts.ts";
export { CM_STATIC_MEMBER, CM_CALL_MIDDLE, CM_CALL_END, CM_COMPUTED_MEMBER, CM_NON_NULL, CM_NODE } from "./chain_member.consts.ts";


export function cmMake(kind: number, e: number): number {
  return (kind << 26) | e;
}
export function cmKind(m: number): number {
  return m >>> 26;
}
export function cmExpr(m: number): number {
  return m & 0x3ffffff;
}
export function cmIsCall(m: number): boolean {
  const k = m >>> 26;
  return k === CM_CALL_MIDDLE || k === CM_CALL_END;
}
export function cmIsComputedExpression(m: number): boolean {
  return m >>> 26 === CM_COMPUTED_MEMBER;
}

/** Where what the link follows ends. -1 for what the chain starts with. */
export function cmInnerEnd(m: number): number {
  if (m >>> 26 === CM_NODE) return -1;
  const inner = innerOfLink(m & 0x3ffffff);
  if (inner < 0) return -1;
  return exprEnd(inner);
}

/**
 * Prettier attaches every comment between the links of a chain to one of them, which it leads or trails: see `attach_in_link`. oxfmt goes
 * by what is around a comment when it comes to it.
 */
export function commentsAreAttachedToLinks(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/** The call that `callee` is the callee of, or -1. */
export function callOfCallee(callee: number): number {
  const parent = exprParent(callee);
  if (nodeKind(parent) !== N_EXPR) return -1;
  const p = nodeId(parent);
  if (exprTag(p) !== EXPR_CALL) return -1;
  const call = exprAsCallLike(p);
  return call >= 0 && callCallee(call) === callee ? call : -1;
}

/** `a.b⏎// comment⏎.c()`: for oxfmt the comment stays on its line, before `.c`. */
function commentThatStartsLineLeadsNextLink(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT && noCommentTrailsWhatIsBeforeAnother(cxOf(f));
}

/** The comments behind a link of the chain. */
function writeTrailingCommentsOfMember(member: number, f: Formatter): void {
  const call = callOfCallee(member);
  if (call >= 0) {
    writeCalleeTrailingComments(call, exprEnd(member), f);
  } else if (commentThatStartsLineLeadsNextLink(f)) {
    // nothing
  } else {
    writeTrailingCommentsOf(exprAsChainElement(member), f);
  }
}

/** `?.`, the type arguments and the arguments of a call. */
function writeCallWithoutCallee(expression: number, f: Formatter): void {
  if (exprTag(expression) !== EXPR_CALL) return;
  const call = exprAsCallLike(expression);
  if (call < 0) return;
  if (callIsOptional(call)) f.token(QUESTION_DOT);
  fmtCallTypeArguments(expression, call, f);
  fmtArgumentsOfCall(expression, call, f);
}

/** The link `m`, with its comments. */
export function fmtChainMember(m: number, f: Formatter): void {
  if (cxOf(f).isQuiet) {
    writeChainMemberWithoutComments(m, f);
    return;
  }
  if (commentsAreAttachedToLinks(f)) writeWithAttachedComments(m, f);
  else writeWithCommentsAround(m, f);
}

/** What the link adds to what it follows. */
function writeChainMemberWithoutComments(m: number, f: Formatter): void {
  const e = m & 0x3ffffff;
  switch (m >>> 26) {
    case CM_STATIC_MEMBER:
      if (cxOf(f).isQuiet) {
        writeLookupWithoutComments(e, f);
        return;
      }
      if (exprTag(e) !== EXPR_DOT) return;
      if (exprIsOptional(e)) f.token(QUESTION);
      f.token(DOT);
      identifier(exprDotName(e), exprDotNamePos(e), exprAsChainElement(e), f);
      return;
    case CM_NON_NULL:
      fmtNonNullMarks(e, f);
      return;
    case CM_CALL_MIDDLE:
    case CM_CALL_END:
      writeCallWithoutCallee(e, f);
      return;
    case CM_COMPUTED_MEMBER:
      fmtComputedMemberExpressionWithoutObject(e, f);
      return;
    default:
      fmtNodeWithoutTrailingComments(WK_EXPR, e, f);
  }
}

/** See `commentsAreAttachedToLinks`. */
function writeWithAttachedComments(m: number, f: Formatter): void {
  // The comments around the last call are around the chain.
  if (m >>> 26 === CM_CALL_END) {
    writeChainMemberWithoutComments(m, f);
    return;
  }
  const cm = cxOf(f).comments;
  const innerEnd = cmInnerEnd(m);
  if (innerEnd >= 0) {
    cm.commentsLeadingLink(innerEnd);
    formatLeadingCommentsRange(cm.from, cm.to, f);
  }
  writeChainMemberWithoutComments(m, f);
  cm.commentsTrailingLink(exprEnd(m & 0x3ffffff));
  formatTrailingCommentsRange(cm.from, cm.to, f);
}

function writeWithCommentsAround(m: number, f: Formatter): void {
  const e = m & 0x3ffffff;
  const k = m >>> 26;
  if (k === CM_STATIC_MEMBER) {
    // Those after the `.` are before it too.
    let nameStart = -1;
    if (exprTag(e) === EXPR_DOT) nameStart = exprDotNamePos(e);
    if (nameStart < 0) {
      nameStart = exprEnd(e);
    }
    const cm = cxOf(f).comments;
    cm.commentsBefore(nameStart);
    formatLeadingCommentsRange(cm.from, cm.to, f);
  } else if (k === CM_CALL_END) {
    writeChainMemberWithoutComments(m, f);
    return;
  } else if (k === CM_NODE && callOfCallee(e) < 0) {
    fmtExpr(e, f);
    return;
  }
  writeChainMemberWithoutComments(m, f);
  writeTrailingCommentsOfMember(e, f);
}

/** oxfmt writes `a[0 /* comment *&#47;]` like `a[b /* comment *&#47;]`, with a way to break after the `[`. */
function breaksAroundANumberWithComments(member: number, f: Formatter): boolean {
  if (f.options.flavor !== FLAVOR_OXFMT) return false;
  return cxOf(f).comments.hasCommentBefore(exprEnd(member));
}

/** The `[b]` or `?.[b]` of `a[b]`. */
export function fmtComputedMemberExpressionWithoutObject(member: number, f: Formatter): void {
  if (exprTag(member) !== EXPR_INDEX) return;
  const index = exprIndexIndex(member);
  const cx = cxOf(f);
  // A comment on its own line before the `[` leads what is in the brackets, unless that is a name. For oxfmt it stays where it is.
  if (!cx.isQuiet && (exprTag(index) === EXPR_IDENT || f.options.flavor === FLAVOR_OXFMT)) {
    const cm = cx.comments;
    cm.commentsBeforeCharacter(exprStart(member), 91);
    formatLeadingCommentsRange(cm.from, cm.to, f);
  }
  const optional = exprIsOptional(member);
  if (exprTag(index) === EXPR_NUMBER && !breaksAroundANumberWithComments(member, f)) {
    if (optional) f.token(QUESTION_DOT);
    f.token(LBRACKET);
    fmtExpr(index, f);
    f.token(RBRACKET);
  } else {
    f.startGroup();
    if (optional) f.token(QUESTION_DOT);
    f.token(LBRACKET);
    f.startSoftBlockIndent();
    fmtExpr(index, f);
    f.endSoftBlockIndent();
    f.token(RBRACKET);
    f.endGroup();
  }
}
