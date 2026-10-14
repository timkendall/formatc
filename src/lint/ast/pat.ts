// Port of vendor/bun/src/lint/ast/pat.rs: binding patterns: what `var`, `let`, `const`, a parameter or a `catch` clause declares.
//
// The target of a destructuring *assignment* is not a pattern: it is an array or an object literal, as parsed (an `Expr`).
//
//     match p.kind() { PatKind::Object(props) => .. }   ->   switch (patTag(p)) { case PAT_OBJECT: { const s = patObjectPropsStart(p), n = patObjectPropsLen(p); .. } }
// (`PAT_MISSING` is a hole in an array pattern; `PAT_IDENT`: `patIdentName(p)`; `PAT_ARRAY`: `patArrayElemsStart/Len(p)`.)
import { PAT_ARRAY, PAT_IDENT, PAT_MISSING, PAT_OBJECT, PK_COMPUTED, hir } from "../../sema/hir.ts";
import { PP_ELEM, PP_PROP, bound } from "../../sema/bind/parents.ts";
import { SP } from "../span.ts";
import { I32Vec } from "../../sema/vec.ts";
import { fileEndOfIdentifier } from "./state.ts";
import { nodeOfPat, nodeParent } from "./node.ts";

function inRange(p: number): boolean {
  return p >= 0 && p < hir.nPats;
}

/** `Pat::tag`: `PAT_*`; `PAT_MISSING` for an id that is not a pattern. */
export function patTag(p: number): number {
  return inRange(p) ? hir.patTag[p] | 0 : PAT_MISSING;
}

/** `Pat::span` into `SP`: without a type annotation or a default value, which belong to what contains the pattern. */
export function patSpan(p: number): void {
  const SP$ = SP;
  if (!inRange(p)) {
    SP$.s0 = 0;
    SP$.s1 = 0;
    return;
  }
  const hir$ = hir;
  const pos = hir$.patPos[p] | 0;
  const end = hir$.patEnd[p] | 0;
  SP$.s0 = (pos) | 0;
  SP$.s1 = ((hir$.patTag[p] | 0) === PAT_IDENT ? fileEndOfIdentifier(pos, end) : end) | 0;
}
export function patStart(p: number): number {
  return inRange(p) ? hir.patPos[p] | 0 : 0;
}
export function patEnd(p: number): number {
  patSpan(p);
  return SP.s1 | 0;
}

/** `Pat::as_ident`: the atom of the name if it is an identifier, else -1. */
export function patAsIdent(p: number): number {
  const hir$ = hir;
  return inRange(p) && (hir$.patTag[p] | 0) === PAT_IDENT ? hir$.patA[p] | 0 : -1;
}

/** `Pat::parent`: a `VarDecl`, a `Param`, a `PatProp` or a `PatElem` (a Node). */
export function patParent(p: number): number {
  return nodeParent(nodeOfPat(p));
}

/** `Pat::for_each_binding`: appends to `out` every identifier pattern that the pattern binds, in source order (PatIds). */
export function patBindings(p: number, out: I32Vec): void {
  if (patTag(p) === PAT_IDENT) {
    out.push(p);
    return;
  }
  // The next is the last. Not by recursion, which a pattern can be too deep for.
  const pending = new I32Vec(16);
  pending.push(p);
  const hir$ = hir;
  while (pending.len > 0) {
    const pat = pending.pop();
    const t = patTag(pat);
    if (t === PAT_IDENT) {
      out.push(pat);
    } else if (t === PAT_OBJECT) {
      const s = hir$.patA[pat] | 0;
      const n = hir$.patB[pat] | 0;
      for (let i = n - 1; i >= 0; i--) pending.push(hir$.patPropValue[hir$.ids[(s + i) | 0] | 0] | 0);
    } else if (t === PAT_ARRAY) {
      const s = hir$.patA[pat] | 0;
      const n = hir$.patB[pat] | 0;
      for (let i = n - 1; i >= 0; i--) {
        const inner = hir$.patElemPat[hir$.ids[(s + i) | 0] | 0] | 0;
        if (patTag(inner) !== PAT_MISSING && inner >= 0) pending.push(inner);
      }
    }
  }
}

// ───────────────────────────── PatProp ─────────────────────────────
// `key: value = default`, `value = default`, `...value` in an object pattern. Its key: `keyKind(nodeOfPatProp(p))` etc. (decl.ts).

/** `PatProp::has_computed_key` */
export function patPropHasComputedKey(p: number): boolean {
  const hir$ = hir;
  if ((hir$.patPropIsRest[p] | 0) !== 0) return false;
  const k = hir$.patPropKeyKind[p] | 0;
  if (k === PK_COMPUTED) return true;
  const nk = hir$.patPropNameKind[p] | 0;
  return k === 1 && (nk === 3 || nk === 4);
}
/** `PatProp::computed_key`: the `e` of a key that is `KEY_COMPUTED` (ExprId or -1). */
export function patPropComputedKey(p: number): number {
  const hir$ = hir;
  return (hir$.patPropIsRest[p] | 0) === 0 && (hir$.patPropKeyKind[p] | 0) === PK_COMPUTED ? hir$.patPropKeyVal[p] | 0 : -1;
}
/** The bound pattern (PatId). */
export function patPropValue(p: number): number {
  return hir.patPropValue[p] | 0;
}
/** The default (ExprId or -1). */
export function patPropDefault(p: number): number {
  return hir.patPropDefault[p] | 0;
}
export function patPropIsRest(p: number): boolean {
  return (hir.patPropIsRest[p] | 0) !== 0;
}
/** `PatProp::is_shorthand`: `{ a }`, `{ a = 1 }`: the name is both the key and what is bound. */
export function patPropIsShorthand(p: number): boolean {
  const hir$ = hir;
  if ((hir$.patPropIsRest[p] | 0) !== 0) return false;
  return (hir$.patPropKeyPos[p] | 0) === patStart(hir$.patPropValue[p] | 0);
}
export function patPropSpan(p: number): void {
  // The HIR has the end of a name that is written with an escape too early.
  const hir$ = hir;
  const end = hir$.patPropEnd[p] | 0;
  const ve = patEnd(hir$.patPropValue[p] | 0);
  const SP$ = SP;
  SP$.s0 = hir$.patPropPos[p] | 0;
  SP$.s1 = (end > ve ? end : ve) | 0;
}
/** `PatProp::parent`: the object pattern (a Node). */
export function patPropParent(p: number): number {
  return ownerPattern(hir.patPropValue[p] | 0);
}

function ownerPattern(inner: number): number {
  const bound$ = bound;
  if (inner >= 0) {
    const t = bound$.patParentTag[inner] | 0;
    if (t === PP_PROP || t === PP_ELEM) return nodeOfPat(bound$.patParentB[inner] | 0);
  }
  return 0;
}

// ───────────────────────────── PatElem ─────────────────────────────
// `pat = default`, `...pat`, or a hole, in an array pattern.

/** The pattern (PatId); -1 for a hole. */
export function patElemPat(e: number): number {
  const p = hir.patElemPat[e] | 0;
  return p >= 0 && patTag(p) !== PAT_MISSING ? p : -1;
}
export function patElemDefault(e: number): number {
  return hir.patElemDefault[e] | 0;
}
export function patElemIsRest(e: number): boolean {
  return (hir.patElemIsRest[e] | 0) !== 0;
}
export function patElemSpan(e: number): void {
  const hir$ = hir;
  const SP$ = SP;
  SP$.s0 = hir$.patElemStart[e] | 0;
  SP$.s1 = hir$.patElemEnd[e] | 0;
}
/** `PatElem::parent`: the array pattern (a Node). */
export function patElemParent(e: number): number {
  return ownerPattern(hir.patElemPat[e] | 0);
}


