// Port of vendor/bun/src/format/js/print/member_expression.rs: `a.b`, `a?.b`, `a.#b`, `a[b]`, `a?.[b]`. Prettier's `printMemberExpression`.
import { Formatter } from "../../ir/formatter.ts";
import { LABEL_MEMBER_CHAIN } from "../../ir/element.ts";
import { DOT, QUESTION_DOT } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  EXPR_ASSIGN,
  EXPR_CALL,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_INDEX,
  EXPR_NEW,
  EXPR_NON_NULL,
  N_EXPR,
  N_FUNC,
  N_PROP,
  N_STMT,
  N_VAR_DECL,
  callArgsLen,
  callCallee,
  exprCallCall,
  exprDotName,
  exprDotNamePos,
  exprDotObj,
  exprIndexObj,
  exprIsChainRoot,
  exprIsOptional,
  exprIsPrivateMember,
  exprLeft,
  exprNonNullExpr,
  exprObject,
  exprCallee,
  exprSpan,
  exprEnd,
  exprTag,
  nodeId,
  nodeKind,
  nodeParent,
  exprParent,
  SP,
} from "../../../lint/ast/index.ts";
import {
  AN_ASSIGNMENT_EXPRESSION,
  AN_CHAIN_EXPRESSION,
  AN_COMPUTED_MEMBER_EXPRESSION,
  AN_NEW_EXPRESSION,
  AN_PRIVATE_FIELD_EXPRESSION,
  AN_STATIC_MEMBER_EXPRESSION,
  AN_TS_NON_NULL_EXPRESSION,
  AN_TS_TYPE_QUERY,
  AN_VARIABLE_DECLARATOR,
  anId,
  anParent,
  anTag,
  exprAsChainElement,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { fmtExpr, identifier } from "../format.ts";
import { formatLeadingCommentsRange } from "../trivia.ts";
import { stripChainElementWrappers } from "../utils/call_expression.ts";
import { fmtComputedMemberExpressionWithoutObject } from "../utils/member_chain/chain_member.ts";
import { isCastTarget, isCastTargetThatHidesItsKind } from "../utils/typecast.ts";

/** A comment at the end of the line of the object stays there. oxfmt, like Prettier 3.8, moves it behind the member: `a // comment` and `.b` on the next line are `a.b // comment`. */
function boundaryBehindObject(f: Formatter): boolean {
  return f.options.flavor !== FLAVOR_OXFMT;
}

/** `a.b`, `a?.b`, `a.#b`, `a[b]`, `a?.[b]`. Prettier's `printMemberExpression`. */
export function writeMemberExpression(e: number, f: Formatter): void {
  const object = exprObject(e);
  if (object < 0) return;
  if (exprTag(e) === EXPR_INDEX) {
    fmtExpr(object, f);
    if (boundaryBehindObject(f)) f.lineSuffixBoundary();
    fmtComputedMemberExpressionWithoutObject(e, f);
    return;
  }
  writeStaticMemberExpression(e, object, f);
}

function writeStaticMemberExpression(e: number, object: number, f: Formatter): void {
  const cx = cxOf(f);
  const start = f.len();
  fmtExpr(object, f);
  if (boundaryBehindObject(f)) f.lineSuffixBoundary();

  if (cx.isQuiet) {
    if (shouldInline(e, object, start, f)) writeLookupWithoutComments(e, f);
    else {
      f.startGroup();
      f.startIndent();
      f.softLineBreak();
      writeLookupWithoutComments(e, f);
      f.endIndent();
      f.endGroup();
    }
    return;
  }

  const name = exprDotName(e);
  if (name < 0) return;
  const propertyStart = exprDotNamePos(e);
  const operator = exprIsOptional(e) ? QUESTION_DOT : DOT;
  const cm = cx.comments;
  const hasOwnLineComment = cm.hasLeadingOwnLineComment(propertyStart);
  const isInline = !hasOwnLineComment && shouldInline(e, object, start, f);
  const parent = exprAsChainElement(e);

  if (isInline) {
    f.token(operator);
    identifier(name, propertyStart, parent, f);
    return;
  }
  f.startGroup();
  f.startIndent();
  f.softLineBreak();
  if (hasOwnLineComment) {
    cm.commentsBefore(propertyStart);
    formatLeadingCommentsRange(cm.from, cm.to, f);
    f.softLineBreak();
  }
  f.token(operator);
  identifier(name, propertyStart, parent, f);
  f.endIndent();
  f.endGroup();
}

/** The `.b` or `?.b` of `member`, where there are no comments. */
export function writeLookupWithoutComments(member: number, f: Formatter): void {
  if (exprTag(member) !== EXPR_DOT) return;
  const nameStart = exprDotNamePos(member);
  // The member access ends with the name.
  const nameEnd = exprEnd(member);
  const text = f.source;
  const isOptional = exprIsOptional(member);
  let isBeforeName: boolean;
  if (isOptional) isBeforeName = nameStart >= 2 && (text[nameStart - 1] | 0) === 46 && (text[nameStart - 2] | 0) === 63;
  else isBeforeName = nameStart >= 1 && (text[nameStart - 1] | 0) === 46;
  // As a rule nothing is between the operator and the name, and they are one piece of the source text.
  if (isBeforeName) f.sourceText(nameStart - (isOptional ? 2 : 1), nameEnd);
  else {
    f.token(isOptional ? QUESTION_DOT : DOT);
    f.sourceText(nameStart, nameEnd);
  }
}

function isMember(node: number): boolean {
  const t = anTag(node);
  return t === AN_STATIC_MEMBER_EXPRESSION || t === AN_COMPUTED_MEMBER_EXPRESSION || t === AN_PRIVATE_FIELD_EXPRESSION;
}

/** Node::Expr(it) with a tag `Dot`, `Index` or `NonNull`. */
function isMemberOrWrapper(node: number): boolean {
  if (nodeKind(node) !== N_EXPR) return false;
  const t = exprTag(nodeId(node));
  return t === EXPR_DOT || t === EXPR_INDEX || t === EXPR_NON_NULL;
}

function isWrapper(node: number): boolean {
  return nodeKind(node) === N_EXPR && exprTag(nodeId(node)) === EXPR_NON_NULL;
}

/** With so many member accesses and `!`s around one, the way up is not gone for each of them. */
const LONG_CHAIN: number = 16;

/**
 * Whether there is no line break between the object and the `.`, however long the line.
 *
 * `objectStart`: where the elements of the object start in what is written.
 */
function shouldInline(e: number, object: number, objectStart: number, f: Formatter): boolean {
  const isPrivate = exprIsPrivateMember(e);
  if (isPrivate && neverBreaksBeforePrivateName(f)) return true;

  // What follows comes to this unless the member accesses and `!`s around `e` are in one of a few kinds of nodes.
  let outer = exprParent(e);
  while (isWrapper(outer)) outer = nodeParent(outer);
  // For Prettier `e` is in the parentheses of a type cast then.
  const isInMember = isMemberOrWrapper(outer) && !isCastTargetThatHidesItsKind(e, f);
  if (!isInMember && !isPrivate && exprTag(object) === EXPR_IDENT && !isCastTarget(object, f)) return true;
  const cx = cxOf(f);
  let steps = 0;
  while (isMemberOrWrapper(outer)) {
    outer = nodeParent(outer);
    steps = (steps + 1) | 0;
    if (steps === LONG_CHAIN) {
      const answer = answerForObject(object, f);
      if (answer >= 0) {
        cx.longMemberChainExpr = e;
        cx.longMemberChainValue = answer !== 0;
        return answer !== 0;
      }
    }
  }
  const answer = shouldInlineIn(e, object, objectStart, outer, isInMember, f);
  if (steps >= LONG_CHAIN) {
    cx.longMemberChainExpr = e;
    cx.longMemberChainValue = answer;
  }
  return answer;
}

/**
 * What `shouldInline` came to for the member access that `object` is, or is an `[..]` or a `!` of, if that is the last one in a long chain that it was asked
 * about: 0 or 1; -1 if it is not. The way up from there leads through what `object` is the object of, unless a `ChainExpression` is in between.
 */
function answerForObject(object: number, f: Formatter): number {
  const cx = cxOf(f);
  const last = cx.longMemberChainExpr;
  if (last < 0) return -1;
  let at = object;
  while (true) {
    if (exprIsChainRoot(at)) return -1;
    if (at === last) return cx.longMemberChainValue ? 1 : 0;
    const t = exprTag(at);
    if (t === EXPR_INDEX) at = exprIndexObj(at);
    else if (t === EXPR_DOT && exprIsPrivateMember(at)) at = exprDotObj(at);
    else if (t === EXPR_NON_NULL) at = exprNonNullExpr(at);
    else return -1;
    if (at < 0) return -1;
  }
}

/**
 * `outer`: the first thing around `e` that is neither a member access nor a `!`. `isInMember`: `e`, with the `!`s after it, is in a member access.
 */
function shouldInlineIn(e: number, object: number, objectStart: number, outer: number, isInMember: boolean, f: Formatter): boolean {
  const cx = cxOf(f);
  // For Prettier the parentheses of a type cast are a node, which is none of those that matter here.
  if (cx.comments.hasTypeCastComments) {
    let inner = e;
    while (true) {
      if (isCastTargetThatHidesItsKind(inner, f)) return false;
      const p = exprParent(inner);
      if (isMemberOrWrapper(p)) inner = nodeId(p);
      else break;
    }
  }
  const ok = nodeKind(outer);
  if (ok === N_EXPR) {
    const t = exprTag(nodeId(outer));
    if (t !== EXPR_ASSIGN && t !== EXPR_NEW) return false;
  } else if (ok === N_VAR_DECL) {
    if (isInMember) return false;
  } else if (ok === N_STMT || ok === N_PROP || ok === N_FUNC) return false;

  const parent = anParent(exprAsChainElement(e));

  let firstNonWrapperParent = parent;
  while (anTag(firstNonWrapperParent) === AN_TS_NON_NULL_EXPRESSION || anTag(firstNonWrapperParent) === AN_CHAIN_EXPRESSION) {
    firstNonWrapperParent = anParent(firstNonWrapperParent);
  }

  if (isMember(firstNonWrapperParent)) {
    // `a.b` of `a.b.c`
  } else {
    const t = anTag(firstNonWrapperParent);
    if (
      (t === AN_ASSIGNMENT_EXPRESSION || t === AN_VARIABLE_DECLARATOR) &&
      // The parentheses of a type cast are a node for Prettier, which is neither.
      !isCastTarget(object, f)
    ) {
      const stripped = stripChainElementWrappers(object, f);
      if (
        (exprTag(stripped) === EXPR_CALL && callArgsLen(exprCallCall(stripped)) > 0) ||
        (isMemberChainOrMemberOfOne(object, f) && f.hasLabelFrom(objectStart, LABEL_MEMBER_CHAIN))
      ) {
        return true;
      }
    }
  }

  // Babel, which reads JavaScript for Prettier, has no `ChainExpression`.
  const isJavascript = cx.hasTreeOfBabel || hasNoChainExpressionInTheWay(f);

  let firstNonMemberParent = parent;
  while (true) {
    const t = anTag(firstNonMemberParent);
    if (isMember(firstNonMemberParent) || t === AN_TS_NON_NULL_EXPRESSION || (isJavascript && t === AN_CHAIN_EXPRESSION)) {
      firstNonMemberParent = anParent(firstNonMemberParent);
    } else break;
  }
  const ft = anTag(firstNonMemberParent);
  if (ft === AN_ASSIGNMENT_EXPRESSION) {
    const left = exprLeft(anId(firstNonMemberParent));
    return !(left >= 0 && exprTag(left) === EXPR_IDENT);
  }
  // `typeof a.b.c` has a `TSQualifiedName`.
  if (ft === AN_TS_TYPE_QUERY) return true;
  // Prettier's `shouldInlineNewExpressionCallee`: it is on the left edge of the callee.
  if (ft === AN_NEW_EXPRESSION) {
    const newCallee = exprCallee(anId(firstNonMemberParent));
    let child = e;
    let ancestor = parent;
    while (true) {
      const at = anTag(ancestor);
      if (at === AN_NEW_EXPRESSION) return newCallee === child;
      else if (at === AN_CHAIN_EXPRESSION) {
        // nothing
      } else if (at === AN_TS_NON_NULL_EXPRESSION) child = anId(ancestor);
      else if (isMember(ancestor) && exprObject(anId(ancestor)) === child) child = anId(ancestor);
      else return false;
      ancestor = anParent(ancestor);
    }
  }
  return false;
}

/** oxfmt looks through a `ChainExpression` for what a member expression is in, in TypeScript as well. */
function hasNoChainExpressionInTheWay(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** oxfmt writes `a.#b` without a way to break. For Prettier it is a member expression like any other. */
function neverBreaksBeforePrivateName(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `a.b().c!.d`: for Prettier what is written for `a.b().c!` has no label. oxfmt looks at how it starts. */
function nonNullMarkKeepsLabel(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** Whether what is written for `object` has the label of what is at its left edge: it is a call of a member, which may be written as a member chain, or a member of that. */
function isMemberChainOrMemberOfOne(object: number, f: Formatter): boolean {
  while (true) {
    const t = exprTag(object);
    if (t === EXPR_DOT) object = exprDotObj(object);
    else if (t === EXPR_INDEX) object = exprIndexObj(object);
    else if (t === EXPR_NON_NULL && nonNullMarkKeepsLabel(f)) object = exprNonNullExpr(object);
    else if (t === EXPR_CALL) {
      const ct = exprTag(callCallee(exprCallCall(object)));
      return ct === EXPR_DOT || ct === EXPR_INDEX;
    } else return false;
  }
}
