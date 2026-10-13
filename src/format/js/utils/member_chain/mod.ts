// Port of vendor/bun/src/format/js/utils/member_chain/mod.rs: chains of calls and member accesses: `a.b().c().d()`. Prettier's
// `printMemberChain`.
//
// The links are put in groups, `a`, `.b()`, `.c()`, `.d()`, which are written on one line if that fits and the chain is short and
// simple, and otherwise each on its own line.
//
// The links of a chain are the ints of `chain_member.ts` in the one vector `mv`, a stack: a chain that is written (or asked about) takes
// `[base, ..)`: its links (first to last), then where each group ends, then a flag per group of the tail, then what is written for each
// group. Writing a group writes the chains in its arguments, which take what is above, and give it back.
import { Formatter } from "../../../ir/formatter.ts";
import { LABEL_MEMBER_CHAIN } from "../../../ir/element.ts";
import { HTML_ROOT_NONE, HTML_ROOT_PROGRAM, HTML_ROOT_VUE_EVENT_BINDING, FLAVOR_OXFMT } from "../../../options.ts";
import { I32Vec } from "../../../../base/i32vec.ts";
import {
  CHAIN_NO,
  EXPR_CALL,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_INDEX,
  EXPR_NON_NULL,
  EXPR_NUMBER,
  EXPR_THIS,
  N_STMT,
  STMT_EXPR,
  SP,
  callArgsLen,
  callArgsStart,
  callCallee,
  exprAsCallLike,
  exprAsFn,
  exprCallee,
  exprChain,
  exprDotName,
  exprEnd,
  exprIndexIndex,
  exprIsChainRoot,
  exprIsPrivateMember,
  exprNonNullExpr,
  exprObject,
  exprParent,
  exprSpan,
  exprStart,
  exprTag,
  hir,
  listAt,
  nameBuf,
  nameLen,
  nameStart,
  nodeId,
  nodeKind,
  stmtTag,
} from "../../../../lint/ast/index.ts";
import { cxOf } from "../../context.ts";
import { expressionNeedsParentheses } from "../../parentheses/expression.ts";
import { byteTable } from "../../source_text.ts";
import { isLongCurriedCall } from "../mod.ts";
import { calleeTrailingComments, isCallExpression, isMemberExpression } from "../call_expression.ts";
import { isCastTarget } from "../typecast.ts";
import {
  CM_CALL_END,
  CM_CALL_MIDDLE,
  CM_COMPUTED_MEMBER,
  CM_NODE,
  CM_NON_NULL,
  CM_STATIC_MEMBER,
  callOfCallee,
  cmExpr,
  cmInnerEnd,
  cmIsCall,
  cmKind,
  cmMake,
  commentsAreAttachedToLinks,
  fmtChainMember,
} from "./chain_member.ts";
import { fmtMemberChainGroup, shouldInsertEmptyLineAfter } from "./groups.ts";
import { isSimpleArgument } from "./simple_argument.ts";

const mv = new I32Vec(256);

const BT_WS_CLOSE_PAREN: Uint8Array = byteTable(")", true);

/** The statement that the code is parsed as is not there for Prettier: the root is a `JsExpressionRoot` or an `NGRoot`. */
function isAllOfExpressionInHtml(f: Formatter): boolean {
  const root = f.options.inHtml.root;
  return !(root === HTML_ROOT_NONE || root === HTML_ROOT_PROGRAM || root === HTML_ROOT_VUE_EVENT_BINDING);
}

/** `a[B].c().d()`: for Prettier `B` looks like a factory, and `.c()` stays on its line. oxfmt only looks at `a.B`. */
function nameInBracketsCanBeFactory(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/**
 * A group ends before a member access that follows a call, and after a comment. Without either, a chain has at most one group after the
 * head, and no call that an empty line could follow.
 */
function isOneGroupAfterTheHead(hasInnerCall: boolean, f: Formatter): boolean {
  return !hasInnerCall && cxOf(f).isQuiet;
}

/** Writes the call `callExpression`, whose callee is a member access. */
export function writeMemberChain(callExpression: number, f: Formatter): void {
  const base = mv.len;
  const hasInnerCall = pushChainMembers(callExpression, f);
  if (!isOneGroupAfterTheHead(hasInnerCall, f)) {
    reverseFrom(base);
    fmtMemberChain(callExpression, base, f);
    mv.len = base;
    return;
  }
  const curried = isLongCurriedCall(callExpression, f);
  if (!curried) f.startGroup();
  for (let i = mv.len - 1; i >= base; i--) fmtChainMember(mv.data[i] | 0, f);
  if (!curried) f.endGroup();
  mv.len = base;
}

function reverseFrom(base: number): void {
  let i = base;
  let j = mv.len - 1;
  const d = mv.data;
  while (i < j) {
    const t = d[i] | 0;
    d[i] = d[j] | 0;
    d[j] = t | 0;
    i = i + 1;
    j = j - 1;
  }
}

// ───────────────────────────── the chain ─────────────────────────────
//
// `base`: where the links are in `mv`; `mlen`: their count; `gbase`, `gcount`: the group ends (a group `i` is `[start(i), end(i))`).

function groupStart(gbase: number, i: number): number {
  return i === 0 ? 0 : mv.data[(gbase + i - 1) | 0] | 0;
}
function groupEnd(gbase: number, gcount: number, i: number): number {
  return i < gcount ? mv.data[(gbase + i) | 0] | 0 : groupStart(gbase, i);
}

/** `a.b.c`, `Object`, `_`, `$`: a name that starts with a capital letter, or consists of `_` and `$`, is likely to be a factory. */
function isFactory(buf: Uint8Array, start: number, len: number): boolean {
  if (len === 0) return false;
  const first = buf[start] | 0;
  if (first === 95 || first === 36) {
    for (let i = 1; i < len; i++) {
      const b = buf[(start + i) | 0] | 0;
      if (b !== 95 && b !== 36) return false;
    }
    return true;
  }
  return first >= 65 && first <= 90;
}

/** Whether the first group of the tail belongs to the head. */
function shouldMergeTailWithHead(root: number, base: number, gbase: number, gcount: number, f: Formatter): boolean {
  const g1s = groupStart(gbase, 1);
  const g1e = groupEnd(gbase, gcount, 1);
  if (g1e <= g1s) return false;
  const firstMember = mv.data[(base + g1s) | 0] | 0;
  const cx = cxOf(f);
  if (!cx.isQuiet && (hasLeadingComment(firstMember, f) || hasTrailingComment(firstMember, f))) return false;
  const hasComputedProperty = cmKind(firstMember) === CM_COMPUTED_MEMBER;

  const headEnd = groupEnd(gbase, gcount, 0);
  if (headEnd === 1 && cmKind(mv.data[base | 0] | 0) === CM_NODE) {
    const node = cmExpr(mv.data[base | 0] | 0);
    const t = exprTag(node);
    if (t === EXPR_IDENT) {
      if (hasComputedProperty) return true;
      const s = exprStart(node);
      const e = exprEnd(node);
      if (isFactory(hir.text, s, e - s)) return true;
      // A name that is shorter than the indentation: the `.` would not even be to the right of it.
      if (e - s <= f.options.indentWidth) {
        const parent = exprParent(root);
        return nodeKind(parent) === N_STMT && stmtTag(nodeId(parent)) === STMT_EXPR && !isAllOfExpressionInHtml(f);
      }
      return false;
    }
    return t === EXPR_THIS;
  }
  // Prettier looks at the name in `[]` as well.
  if (headEnd === 0) return false;
  const last = mv.data[(base + headEnd - 1) | 0] | 0;
  const k = cmKind(last);
  const le = cmExpr(last);
  if (k === CM_STATIC_MEMBER && exprTag(le) === EXPR_DOT) {
    const name = exprDotName(le);
    const buf = nameBuf(name);
    const s = nameStart(name);
    const n = nameLen(name);
    if (n > 0 && (buf[s] | 0) === 35) return false; // `#`
    return hasComputedProperty || isFactory(buf, s, n);
  }
  if (k === CM_COMPUTED_MEMBER && exprTag(le) === EXPR_INDEX) {
    const index = exprIndexIndex(le);
    if (exprTag(index) === EXPR_IDENT && nameInBracketsCanBeFactory(f)) {
      const s = exprStart(index);
      const e = exprEnd(index);
      return hasComputedProperty || isFactory(hir.text, s, e - s);
    }
  }
  return false;
}

/** Whether `e` is a call that an empty line can follow, with `isCallExpression`. */
function isComputedArrayMemberAccess(m: number): boolean {
  if (cmKind(m) !== CM_COMPUTED_MEMBER) return false;
  const e = cmExpr(m);
  return exprTag(e) === EXPR_INDEX && exprTag(exprIndexIndex(e)) === EXPR_NUMBER;
}

/**
 * Where the head ends. It is the first member, the calls and `[0]`s right after it, and, unless it starts with a call, the member
 * accesses up to the last before a call: `a()()`, `a[0][1]`, `this.a.b` of `this.a.b.c()`.
 */
function getSplitIndexOfHeadAndTailGroups(base: number, mlen: number, f: Formatter): number {
  const d = mv.data;
  let nonCallOrArrayMemberAccessStart = mlen;
  for (let i = 1; i < mlen; i++) {
    const m = d[(base + i) | 0] | 0;
    const k = cmKind(m);
    let stops: boolean;
    if (k === CM_CALL_MIDDLE || k === CM_CALL_END || k === CM_NON_NULL) stops = false;
    else if (k === CM_COMPUTED_MEMBER) stops = !isComputedArrayMemberAccess(m);
    else stops = true;
    if (stops) {
      nonCallOrArrayMemberAccessStart = i;
      break;
    }
  }
  let startsWithCall = false;
  if (mlen > 0) {
    const first = d[base | 0] | 0;
    const k = cmKind(first);
    if (k === CM_CALL_MIDDLE || k === CM_CALL_END) startsWithCall = true;
    else if (k === CM_NODE) startsWithCall = isCallExpression(cmExpr(first), f);
  }
  if (startsWithCall) return nonCallOrArrayMemberAccessStart;
  // rest = members[nonCallOrArrayMemberAccessStart ..]
  const restLen = mlen - nonCallOrArrayMemberAccessStart;
  let memberEnd = restLen;
  for (let i = 0; i < restLen; i++) {
    const k = cmKind(d[(base + nonCallOrArrayMemberAccessStart + i) | 0] | 0);
    if (!(k === CM_STATIC_MEMBER || k === CM_COMPUTED_MEMBER)) {
      memberEnd = i > 0 ? i - 1 : 0;
      break;
    }
  }
  return nonCallOrArrayMemberAccessStart + memberEnd;
}

/**
 * Appends where the groups after the head end: each is some member accesses and the calls after them. `start`: where the head ends in
 * the members.
 */
function pushEndsOfRemainingGroups(base: number, mlen: number, start: number, f: Formatter): void {
  let hasSeenCallExpression = false;
  let groupStartAt = start;
  const cx = cxOf(f);
  for (let index = start; index < mlen; index++) {
    const m = mv.data[(base + index) | 0] | 0;
    const k = cmKind(m);
    if (k === CM_COMPUTED_MEMBER && isComputedArrayMemberAccess(m)) {
      // `[0]` goes with what is before it.
    } else if ((k === CM_STATIC_MEMBER || k === CM_COMPUTED_MEMBER) && hasSeenCallExpression) {
      mv.push(index);
      groupStartAt = index;
      hasSeenCallExpression = false;
    } else if (k === CM_CALL_MIDDLE || k === CM_CALL_END) {
      hasSeenCallExpression = true;
    }
    // So that the comment stays behind what it is written behind.
    if (!cx.isQuiet && (hasTrailingComment(m, f) || isBeforeCommentThatStartsLine(cmExpr(m), f))) {
      mv.push(index + 1);
      groupStartAt = index + 1;
      hasSeenCallExpression = false;
    }
  }
  if (groupStartAt < mlen) mv.push(mlen);
}

/** Whether a comment leads `member`. For oxfmt: it is on a line of its own before the `.`, or before the `[` of `[name]`. */
function hasLeadingComment(m: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  if (commentsAreAttachedToLinks(f)) {
    const end = cmInnerEnd(m);
    return end >= 0 && cm.hasCommentLeadingLink(end);
  }
  const e = cmExpr(m);
  const k = cmKind(m);
  let ch = 0;
  if (exprTag(e) === EXPR_DOT && k === CM_STATIC_MEMBER) ch = 46;
  else if (exprTag(e) === EXPR_INDEX && k === CM_COMPUTED_MEMBER && exprTag(exprIndexIndex(e)) === EXPR_IDENT) ch = 91;
  else return false;
  exprSpan(exprObject(e));
  cm.commentsBeforeCharacter(SP[1] | 0, ch);
  const to = cm.to;
  for (let i = cm.from; i < to; i++) if (cm.precededByNewline(i)) return true;
  return false;
}

/** `a["b"] // comment⏎(c)` is `a["b"](c); // comment` for oxfmt. */
function commentBehindBracketsBreaksNoChain(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** Whether a comment trails `member`, which is not the last of a chain. */
function hasTrailingComment(m: number, f: Formatter): boolean {
  const cx = cxOf(f);
  const cm = cx.comments;
  const e = cmExpr(m);
  exprSpan(e);
  const end = SP[1] | 0;
  if (commentsAreAttachedToLinks(f)) {
    // It is attached to what is in a `ChainExpression`, not to that.
    const isChainExpression = cmKind(m) === CM_NODE && exprIsChainRoot(e) && !cx.hasTreeOfBabel;
    return !isChainExpression && cm.hasCommentTrailingLink(end);
  }
  // See `commentsTrailingComputedCallee`: those behind the `(` are among them, and separate nothing.
  if (exprTag(e) === EXPR_INDEX) {
    if (cm.commentsAfter(end) === 0) return false;
    return cx.src.allBytes(end, cm.spanStart[cm.from] | 0, BT_WS_ASCII);
  }
  const call = callOfCallee(e);
  if (call >= 0) {
    // All before the `(` are among them. A block comment on its line separates nothing.
    calleeTrailingComments(call, end, f);
    const to = cm.to;
    for (let i = cm.from; i < to; i++) if (cm.precededByNewline(i) || cm.followedByNewline(i)) return true;
    return false;
  }
  // A comment on its own line leads the next member, or what is in its brackets.
  if (cm.commentsAfter(end) === 0) return false;
  const first = cm.from;
  return !cm.precededByNewline(first) && cx.src.allBytes(end, cm.spanStart[first] | 0, BT_WS_CLOSE_PAREN);
}

const BT_WS_ASCII: Uint8Array = byteTable("", true);

/** `a.b⏎// comment⏎.c()`: for oxfmt a group of the chain ends before the comment, which so stays on its line. */
function isBeforeCommentThatStartsLine(e: number, f: Formatter): boolean {
  if (f.options.flavor !== FLAVOR_OXFMT) return false;
  const cx = cxOf(f);
  const cm = cx.comments;
  exprSpan(e);
  const end = SP[1] | 0;
  if (cm.commentsAfter(end) === 0) return false;
  const first = cm.from;
  return cm.precededByNewline(first) && cx.src.allBytes(end, cm.spanStart[first] | 0, BT_WS_ASCII);
}

/** Prettier's `nodeHasComment`. */
function memberChainHasComment(base: number, mlen: number, f: Formatter): boolean {
  if (cxOf(f).isQuiet) return false;
  for (let i = 0; i < mlen; i++) {
    const m = mv.data[(base + i) | 0] | 0;
    if (hasLeadingComment(m, f)) return true;
    const k = cmKind(m);
    if (k !== CM_CALL_END && !(k === CM_COMPUTED_MEMBER && commentBehindBracketsBreaksNoChain(f)) && hasTrailingComment(m, f)) return true;
  }
  return false;
}

/**
 * Prettier's `shouldMerge`'s counterpart `shouldNotWrap`, and the tests on complexity. `fbase`: where what is written for each group is
 * (`gcount` handles).
 */
function groupsShouldBreak(base: number, mlen: number, fbase: number, gcount: number, f: Formatter): boolean {
  // The call expressions among the links; the last of them has no call after it.
  let lastCall = -1;
  for (let i = mlen - 1; i >= 0; i--) {
    if (callOfLink(mv.data[(base + i) | 0] | 0, f) >= 0) {
      lastCall = i;
      break;
    }
  }
  let callsCount = 0;
  let hasFunctionLikeArgument = false;
  let hasComplexArgs = false;
  for (let i = 0; i <= lastCall; i++) {
    const call = callOfLink(mv.data[(base + i) | 0] | 0, f);
    if (call < 0) continue;
    callsCount = (callsCount + 1) | 0;
    const as = callArgsStart(call);
    const n = callArgsLen(call);
    if (i !== lastCall) {
      if (!hasFunctionLikeArgument) {
        for (let k = 0; k < n; k++) {
          if (exprAsFn(listAt(as, k)) >= 0) {
            hasFunctionLikeArgument = true;
            break;
          }
        }
      }
    }
    if (!hasComplexArgs) {
      for (let k = 0; k < n; k++) {
        if (!isSimpleArgument(listAt(as, k), f)) {
          hasComplexArgs = true;
          break;
        }
      }
    }
    if (callsCount > 2 && hasComplexArgs) return true;
  }

  if (gcount === 0) return false;
  const d = mv.data;
  const head = d[fbase | 0] | 0;
  const last = d[(fbase + gcount - 1) | 0] | 0;
  const endsWithCall = mlen > 0 && cmIsCall(d[(base + mlen - 1) | 0] | 0);
  if (gcount > 1 && head >= 0 && f.willBreak(head)) return true;
  if (hasFunctionLikeArgument && endsWithCall && last >= 0 && f.willBreak(last)) return true;
  // tail.iter().rev().skip(1): the tail but for its last
  for (let i = 1; i < gcount - 1; i++) {
    const h = mv.data[(fbase + i) | 0] | 0;
    if (h >= 0 && f.willBreak(h)) return true;
  }
  return false;
}

/** The call of a link that is a call, or a node that is a call. -1 otherwise. */
function callOfLink(m: number, f: Formatter): number {
  const k = cmKind(m);
  const e = cmExpr(m);
  if (k === CM_CALL_MIDDLE || k === CM_CALL_END) return exprAsCallLike(e);
  if (k === CM_NODE && isCallExpression(e, f)) return exprAsCallLike(e);
  return -1;
}

/** Writes the chain whose links are `mv[base .. mv.len)`, first to last. */
function fmtMemberChain(root: number, base: number, f: Formatter): void {
  const mlen = (mv.len - base) | 0;
  const cx = cxOf(f);

  // MemberChain::new
  const gbase0 = mv.len;
  const headEnd = getSplitIndexOfHeadAndTailGroups(base, mlen, f);
  mv.push(headEnd);
  pushEndsOfRemainingGroups(base, mlen, headEnd, f);
  let gbase = gbase0;
  let gcount = (mv.len - gbase0) | 0;
  // The first group of the tail may belong to the head.
  if (gcount - 1 > 0 && shouldMergeTailWithHead(root, base, gbase, gcount, f)) {
    gbase = (gbase + 1) | 0;
    gcount = (gcount - 1) | 0;
  }
  const tailLen = gcount > 0 ? gcount - 1 : 0;

  const hasComment = memberChainHasComment(base, mlen, f);

  // find_empty_lines: a flag for each group of the tail
  const nbase = mv.len;
  let hasEmptyLineAfterCall = false;
  {
    let previous = headEnd2(gbase, gcount) > 0 ? mv.data[(base + groupEnd(gbase, gcount, 0) - 1) | 0] | 0 : -1;
    for (let index = 0; index + 1 < gcount; index++) {
      let needs = false;
      if (previous >= 0) {
        const pk = cmKind(previous);
        if (pk === CM_CALL_MIDDLE || pk === CM_CALL_END) {
          const isFollowed = shouldInsertEmptyLineAfter(cmExpr(previous), f);
          if (isFollowed) hasEmptyLineAfterCall = true;
          needs = isFollowed;
        } else if (pk === CM_NODE && isCallExpression(cmExpr(previous), f)) {
          // Not after a call that the chain starts with: `fn()\n\n.bar()` is `fn().bar()`.
          needs = false;
        } else {
          needs = index === 0 && shouldInsertEmptyLineAfter(cmExpr(previous), f);
        }
      }
      mv.push(needs ? 1 : 0);
      const ge = groupEnd(gbase, gcount, index + 1);
      const gs = groupStart(gbase, index + 1);
      previous = ge > gs ? mv.data[(base + ge - 1) | 0] | 0 : -1;
    }
  }

  if (tailLen <= 1 && !hasComment && !hasEmptyLineAfterCall) {
    const curried = isLongCurriedCall(root, f);
    if (!curried) f.startGroup();
    for (let g = 0; g < gcount; g++) {
      fmtMemberChainGroup(mv, base, groupStart(gbase, g), groupEnd(gbase, gcount, g), f);
    }
    if (!curried) f.endGroup();
    return;
  }

  // The groups are asked about, and written in two ways. They are formatted in order, for the sake of the comments.
  const fbase = mv.len;
  for (let g = 0; g < gcount; g++) {
    const slot = f.startCapture();
    fmtMemberChainGroup(mv, base, groupStart(gbase, g), groupEnd(gbase, gcount, g), f);
    const h = f.endCapture(slot);
    mv.push(h);
  }

  f.startLabelled(LABEL_MEMBER_CHAIN);
  if (hasComment || hasEmptyLineAfterCall || groupsShouldBreak(base, mlen, fbase, gcount, f)) {
    f.startGroup();
    writeExpanded(fbase, nbase, gcount, f);
    f.endGroup();
  } else {
    const hasEmptyLineBeforeTail = gcount > 1 && (mv.data[nbase | 0] | 0) === 1;
    const lastHandle = gcount > 0 ? mv.data[(fbase + gcount - 1) | 0] | 0 : -1;
    const lastGroupBreaks = lastHandle >= 0 && f.willBreak(lastHandle);
    if (hasEmptyLineBeforeTail || lastGroupBreaks) f.expandParent();
    const s0 = f.startVariant();
    for (let g = 0; g < gcount; g++) f.writeInterned(mv.data[(fbase + g) | 0] | 0);
    const v0 = f.endVariant(s0);
    const s1 = f.startVariant();
    writeExpanded(fbase, nbase, gcount, f);
    const v1 = f.endVariant(s1);
    f.bestFitting2(v0, v1);
  }
  f.endLabelled();
  void cx;
}

function headEnd2(gbase: number, gcount: number): number {
  return gcount > 0 ? groupEnd(gbase, gcount, 0) : 0;
}

/** `format_expanded`: the head, and each group of the tail on a line of its own, indented. */
function writeExpanded(fbase: number, nbase: number, gcount: number, f: Formatter): void {
  if (gcount > 0) f.writeInterned(mv.data[fbase | 0] | 0);
  f.startIndent();
  for (let g = 1; g < gcount; g++) {
    if ((mv.data[(nbase + g - 1) | 0] | 0) === 1) f.emptyLine();
    else f.hardLineBreak();
    f.writeInterned(mv.data[(fbase + g) | 0] | 0);
  }
  f.endIndent();
}

/**
 * Whether the call `expression` is written as a member chain that can break before each group: it has more than one group after the head,
 * or a comment between its links.
 */
export function isMemberCallChain(expression: number, f: Formatter): boolean {
  const base = mv.len;
  const hasInnerCall = pushChainMembers(expression, f);
  if (isOneGroupAfterTheHead(hasInnerCall, f)) {
    mv.len = base;
    return false;
  }
  reverseFrom(base);
  const mlen = (mv.len - base) | 0;
  const gbase0 = mv.len;
  const headEnd = getSplitIndexOfHeadAndTailGroups(base, mlen, f);
  mv.push(headEnd);
  pushEndsOfRemainingGroups(base, mlen, headEnd, f);
  let gbase = gbase0;
  let gcount = (mv.len - gbase0) | 0;
  if (gcount - 1 > 0 && shouldMergeTailWithHead(expression, base, gbase, gcount, f)) {
    gbase = (gbase + 1) | 0;
    gcount = (gcount - 1) | 0;
  }
  const tailLen = gcount > 0 ? gcount - 1 : 0;
  const result = tailLen > 1 || memberChainHasComment(base, mlen, f);
  mv.len = base;
  return result;
}

/** `a.#b().c()`: for oxfmt `a.#b` is no link of the chain. It, or the call of it, is what the chain starts with. */
function startsChain(member: number, f: Formatter): boolean {
  return exprIsPrivateMember(member) && f.options.flavor === FLAVOR_OXFMT;
}

/**
 * Pushes the links of the chain that ends with the call `root`, from the last to the first. Returns whether there is another call among
 * them. The chain starts where something needs parentheses.
 */
function pushChainMembers(root: number, f: Formatter): boolean {
  mv.push(cmMake(CM_CALL_END, root));
  const hasTypeCasts = cxOf(f).comments.hasTypeCastComments;
  let hasInnerCall = false;
  let next = exprCallee(root);

  while (next >= 0) {
    const expression = next;
    next = -1;
    const tag = exprTag(expression);
    const isLink = tag === EXPR_CALL || tag === EXPR_DOT || tag === EXPR_INDEX || tag === EXPR_NON_NULL;
    // A link is in a link: nothing that it would need parentheses in, unless an optional chain ends with it.
    if (
      (hasTypeCasts && isCastTarget(expression, f)) ||
      ((!isLink || ((tag === EXPR_NON_NULL || exprChain(expression) !== CHAIN_NO) && exprIsChainRoot(expression))) &&
        expressionNeedsParentheses(expression, f))
    ) {
      mv.push(cmMake(CM_NODE, expression));
      break;
    }

    if (tag === EXPR_CALL) {
      const callee = exprCallee(expression);
      if (callee >= 0 && ((isMemberExpression(callee, f) && !startsChain(callee, f)) || isCallExpression(callee, f))) {
        next = callee;
        hasInnerCall = true;
        mv.push(cmMake(CM_CALL_MIDDLE, expression));
      } else {
        mv.push(cmMake(CM_NODE, expression));
      }
    } else if (tag === EXPR_DOT && !startsChain(expression, f)) {
      next = exprObject(expression);
      mv.push(cmMake(CM_STATIC_MEMBER, expression));
    } else if (tag === EXPR_INDEX) {
      next = exprObject(expression);
      mv.push(cmMake(CM_COMPUTED_MEMBER, expression));
    } else if (tag === EXPR_NON_NULL) {
      next = exprNonNullExpr(expression);
      mv.push(cmMake(CM_NON_NULL, expression));
    } else {
      mv.push(cmMake(CM_NODE, expression));
    }
  }
  return hasInnerCall;
}

void callCallee;
