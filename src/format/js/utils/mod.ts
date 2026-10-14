// Port of vendor/bun/src/format/js/utils/mod.rs: what several kinds of nodes are formatted with.
import { Formatter } from "../../ir/formatter.ts";
import {
  EXPR_CALL,
  N_EXPR,
  callArgsLen,
  callCallee,
  exprAsCallLike,
  exprEnd,
  exprIsChainRoot,
  exprParent,
  exprTag,
  hir,
  nodeId,
  nodeKind,
} from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";

/** `connect(a, b, c)(d)`: `call` is the callee of a call that has fewer arguments, but some. */
export function isLongCurriedCall(call: number, f: Formatter): boolean {
  const c = exprAsCallLike(call);
  if (c < 0 || callArgsLen(c) <= 1 || !mayBeFollowedByArguments(call)) return false;
  const parent = exprParent(call);
  return nodeKind(parent) === N_EXPR && exprTag(nodeId(parent)) === EXPR_CALL && isLongCurriedCallee(call, nodeId(parent), f);
}

/** Whether what is behind `callee` can be between a callee and its arguments: whitespace, a comment, a `)`, or the start of `(`, `<T>(` or `?.(`. */
function mayBeFollowedByArguments(callee: number): boolean {
  const end = exprEnd(callee);
  const hir$ = hir;
  if (end >= (hir$.sourceLen | 0)) return false;
  const next = hir$.text[end] | 0;
  return next <= 32 || next >= 128 || next === 40 || next === 41 || next === 60 || next === 63 || next === 47;
}

/** `parent`: the call that `call` is in. The whole of an optional chain is in a `ChainExpression`, unless the tree is Babel's. */
function isLongCurriedCallee(call: number, parent: number, f: Formatter): boolean {
  const thisCall = exprAsCallLike(call);
  const parentCall = exprAsCallLike(parent);
  if (thisCall < 0 || parentCall < 0) return false;
  return (
    callCallee(parentCall) === call &&
    (cxOf(f).hasTreeOfBabel || !exprIsChainRoot(call)) &&
    callArgsLen(thisCall) > callArgsLen(parentCall) &&
    callArgsLen(parentCall) > 0
  );
}

