// Port of vendor/bun/src/lint/ast/flow.rs: a file of Flow. Its HIR has the nodes of TypeScript (`flow.rs` of `bun_sema_parser` says which stand for
// what). This tells them apart, from the nodes and from the tokens at the positions that they record. Everything here is only meaningful if
// `fileIsFlow()` (mod.ts).
import { FLAG_COMPUTED_NAME, FLAG_REST, JSD_NULLABLE, PK_NAME, TYPE_JSDOC, TYPE_UNIQUE, hir } from "../../sema/hir.ts";
import { SP } from "../span.ts";
import { skipTrivia, tokenEnd } from "../../sema/check/spans.ts";
import { exprIsAngleBracketAssertion, exprOuterEnd } from "./expr.ts";
import { typeOuterEnd, typeOuterStart, typeStart } from "./ty.ts";
import { identEndOf } from "./name.ts";
import { FLOW, FLOW_LABEL_ATOM, FLOW_LABEL_POS } from "./keys.ts";
import { modifierStart } from "./decl.ts";
import { typeParamName, typeParamNamePos } from "./decl.ts";

/** `File::flow_token_span_at` into `SP`: the token that starts at `start`. */
export function flowTokenSpanAt(start: number): void {
  const SP$ = SP;
  SP$.s0 = (start) | 0;
  const hir$ = hir;
  SP$.s1 = (tokenEnd(hir$.text, hir$.sourceLen | 0, start, false)) | 0;
}

/** Whether the token `text[s, e)` is exactly `lit`. */
function tokenIs(s: number, e: number, lit: string): boolean {
  if (e - s !== lit.length) return false;
  const hir$ = hir;
  for (let i = 0; i < lit.length; i++) if ((hir$.text[s + i] | 0) !== lit.charCodeAt(i)) return false;
  return true;
}

/** `Expr::is_flow_type_cast`: `(e: T)` */
export function exprIsFlowTypeCast(e: number): boolean {
  return hir.isFlow && exprIsAngleBracketAssertion(e);
}

/** `Expr::is_before_flow_type_arguments`: whether a `<` follows: `R<> { }` has type arguments, of which there are none. */
export function exprIsBeforeFlowTypeArguments(e: number): boolean {
  const hir$ = hir;
  const start = skipTrivia(hir$.text, hir$.sourceLen | 0, exprOuterEnd(e));
  return tokenIs(start, tokenEnd(hir$.text, hir$.sourceLen | 0, start, false), "<");
}

/** `Modifier::token_span` into `SP`: the keyword or the sign as it is written: `static`, `proto`, `+`, `opaque`. */
export function modifierTokenSpan(m: number): void {
  flowTokenSpanAt(modifierStart(m));
}

/** `TypeNode::flow_nullable_operand`: the `T` of `?T` (TypeNodeId or -1). */
export function typeFlowNullableOperand(t: number): number {
  const hir$ = hir;
  if (t < 0 || t >= hir$.nTypes || (hir$.typeTag[t] | 0) !== TYPE_JSDOC) return -1;
  const aux = hir$.typeAux[t] | 0;
  if ((aux & 3) === JSD_NULLABLE && (aux & 4) === 0) return hir$.typeA[t] | 0;
  return -1;
}

/** `TypeNode::flow_type_operator_operand`: the `T` of `renders T` (TypeNodeId or -1). */
export function typeFlowTypeOperatorOperand(t: number): number {
  const hir$ = hir;
  if (t < 0 || t >= hir$.nTypes || (hir$.typeTag[t] | 0) !== TYPE_UNIQUE) return -1;
  return hir$.typeA[t] | 0;
}

/** `TypeNode::first_token` into `SP`: the first token of the type. */
export function typeFirstToken(t: number): void {
  flowTokenSpanAt(typeStart(t));
}

/** `TypeNode::is_flow_exact_object`: `{| |}` */
export function typeIsFlowExactObject(t: number): boolean {
  const s = typeStart(t);
  const hir$ = hir;
  return s + 1 < (hir$.sourceLen | 0) && (hir$.text[s] | 0) === 123 && (hir$.text[s + 1] | 0) === 124;
}

/** `TypeNode::has_flow_optional_token(obj)`: `obj?.[index]`, for an `IndexedAccess` of `obj`. */
export function typeHasFlowOptionalToken(t: number, obj: number): boolean {
  const hir$ = hir;
  const start = skipTrivia(hir$.text, hir$.sourceLen | 0, typeOuterEnd(obj));
  return tokenIs(start, tokenEnd(hir$.text, hir$.sourceLen | 0, start, false), "?.");
}

/** `TypeParam::flow_token_after_name` into `SP`: the token after the name: `:` or `extends` before a bound, `in` in a mapped type. */
export function typeParamFlowTokenAfterName(p: number): void {
  const nameEnd = identEndOf(typeParamName(p), typeParamNamePos(p));
  const hir$ = hir;
  const start = skipTrivia(hir$.text, hir$.sourceLen | 0, nameEnd);
  const SP$ = SP;
  SP$.s0 = (start) | 0;
  SP$.s1 = (tokenEnd(hir$.text, hir$.sourceLen | 0, start, false)) | 0;
}

/** Whether the token in `SP` is `lit`. */
export function spTokenIs(lit: string): boolean {
  const SP$ = SP;
  return tokenIs(SP$.s0 | 0, SP$.s1 | 0, lit);
}

/**
 * `TupleElem::flow_variance_and_label`: `[+a: T]`. Returns bits: 1: there is a variance sign, its span is in `SP`; 2: there is a label:
 * `FLOW[FLOW_LABEL_ATOM]`, `FLOW[FLOW_LABEL_POS]`. 0: neither.
 */
export function tupleElemFlowVarianceAndLabel(e: number): number {
  const hir$ = hir;
  const name = hir$.tupleElemName[e] | 0;
  if (name < 0) return 0;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  const rawStart = hir$.tupleElemStart[e] | 0;
  const hasDots = (hir$.tupleElemHasDots[e] | 0) !== 0;
  flowTokenSpanAt(rawStart);
  const SP$ = SP;
  const firstStart = SP$.s0 | 0;
  const firstEnd = SP$.s1 | 0;
  // The label is followed by the `?` or the `:`.
  const nextStart = skipTrivia(text, len, firstEnd);
  const nextEnd = tokenEnd(text, len, nextStart, false);
  const FLOW$ = FLOW;
  if (hasDots || tokenIs(nextStart, nextEnd, ":") || tokenIs(nextStart, nextEnd, "?")) {
    FLOW$.s0 = (name) | 0;
    FLOW$.s1 = (hasDots ? nextStart : firstStart) | 0;
    return 2;
  }
  FLOW$.s0 = (name) | 0;
  FLOW$.s1 = (nextStart) | 0;
  SP$.s0 = (firstStart) | 0;
  SP$.s1 = (firstEnd) | 0;
  return 3;
}

/** `TupleElem::flow_type`: the `T`. -1 for the `...` that ends an inexact tuple. */
export function tupleElemFlowType(e: number): number {
  return hir.tupleElemWritten[e] | 0;
}

/** `Param::flow_outer_name` into `SP`: in a component: the `a` of `a as b`, the `'a'` of `'a' as b` and of `'a': T`. */
export function paramFlowOuterName(p: number): boolean {
  const hir$ = hir;
  const pat = hir$.paramPat[p] | 0;
  let inner = 0;
  if (pat >= 0 && pat < hir$.nPats) {
    inner = hir$.patPos[pat] | 0;
  } else {
    const ty = hir$.paramTy[p] | 0;
    if (ty < 0) return false;
    inner = typeOuterStart(ty);
  }
  const pos = hir$.paramPos[p] | 0;
  if (((hir$.paramFlags[p] | 0) & FLAG_REST) !== 0 || !(pos < inner)) return false;
  flowTokenSpanAt(pos);
  return true;
}
/** `Member::flow_internal_slot`: the atom of the `a` of `[[a]]: T` (-1: none); the position is `memberNamePos`. */
export function memberFlowInternalSlot(m: number): number {
  const hir$ = hir;
  if ((hir$.memberKeyKind[m] | 0) === PK_NAME && ((hir$.memberFlags[m] | 0) & FLAG_COMPUTED_NAME) !== 0) return hir$.memberKeyVal[m] | 0;
  return -1;
}

/** `Member::is_flow_spread`: `...T`, or the `...` that ends an inexact object type. */
export function memberIsFlowSpread(m: number): boolean {
  return ((hir.memberFlags[m] | 0) & FLAG_REST) !== 0;
}

/** `Interface::flow_opaque_type`: of `opaque type A: B = C`: the `C` (TypeNodeId or -1). The bounds are the interface's `extends`. */
export function interfaceFlowOpaqueType(i: number): number {
  const hir$ = hir;
  return (hir$.interfaceOtherHeritageLen[i] | 0) > 0 ? hir$.ids[hir$.interfaceOtherHeritageStart[i] | 0] | 0 : -1;
}

/** `Class::flow_mixins`: of `declare class A mixins B, C`: `B` and `C`: a list of TypeNodeIds. */
export function classFlowMixinsStart(c: number): number {
  return hir.classOtherImplementsStart[c] | 0;
}
export function classFlowMixinsLen(c: number): number {
  return hir.classOtherImplementsLen[c] | 0;
}

/** `Enum::flow_explicit_type` into `SP`: the `string` of `enum A of string {}`. */
export function enumFlowExplicitType(en: number): boolean {
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  const nameEnd = identEndOf(hir$.enumName[en] | 0, hir$.enumNamePos[en] | 0);
  const ofStart = skipTrivia(text, len, nameEnd);
  const ofEnd = tokenEnd(text, len, ofStart, false);
  if (!tokenIs(ofStart, ofEnd, "of")) return false;
  const s = skipTrivia(text, len, ofEnd);
  const SP$ = SP;
  SP$.s0 = (s) | 0;
  SP$.s1 = (tokenEnd(text, len, s, false)) | 0;
  return true;
}

