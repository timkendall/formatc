// `File::expr_in_tree`, `Prop::is_in_tree` (lint/ast/reach.rs): whether a row of the HIR is a node of the tree, as opposed to what the parser has
// left behind where it backtracked, or the `{ .. }` and the properties of import attributes, which are no nodes.
import { EXPR_MISSING, EXPR_OBJECT, hir } from "../../hir.ts";
import { P_NONE, bound } from "../../bind/parents.ts";
import { isImportAttributesObject } from "../../../lint/ast/index.ts";

export function exprInTree(i: number): boolean {
  if ((bound.exprParentTag[i] | 0) === P_NONE) return false;
  const t = hir.exprTag[i] | 0;
  if (t === EXPR_MISSING) return false;
  if (hir.importAttributesLen !== 0 && t === EXPR_OBJECT && isImportAttributesObject(i)) return false;
  return true;
}

export function propInTree(i: number): boolean {
  const owner = bound.propOwner[i] | 0;
  if (owner < 0) return false;
  return !(hir.importAttributesLen !== 0 && isImportAttributesObject(owner));
}
