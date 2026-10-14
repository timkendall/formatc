// Port of vendor/bun/src/lint/ast/ty.rs: type syntax (`TypeNode`), `TupleElem`, `Mapped`, `ImportAttributes`.
//
//     match t.kind() { TypeKind::Ref { name, args } => .. }
//  -> switch (typeTag(t)) { case TYPE_REF: { const nameStart = typeRefNameStart(t), nameLen = typeRefNameLen(t); const argsStart = typeRefArgsStart(t), argsLen = typeRefArgsLen(t); .. } }
//
// `TypeKind::Error` and `TypeKind::JSDoc` (`T?`, `T!`, `...T`: an error with no children) are one kind in Rust; here `typeTag` is the HIR's
// (`TYPE_ERROR`, `TYPE_JSDOC`): treat both as an error. The payload accessors are the generated ones of src/sema/hir.ts (HIR_API.md section 9),
// except the ones defined here.
//
// An `EntityName` (`A.B.C`) is a list `(start, len)` of NameIds: read the parts with `entityAtom(start, i)` / `entityPos(start, i)` (name.ts).
import {
  EXPR_OBJECT,
  TYPE_ERROR,
  TYPE_KEYWORD,
  TYPE_IMPORT,
  TYPE_NUMBER_LIT,
  TYPE_PREDICATE,
  TYPE_UNIQUE_SYMBOL,
  hir,
} from "../../sema/hir.ts";
import { SP } from "../span.ts";
import { skipTrivia, tokenEnd } from "../../sema/check/spans.ts";
import { fileEndOfTokenBefore } from "./state.ts";
import {
  importAttributesIndexWithin,
  importAttributesSearchSpanOfType,
  nodeOfTupleElem,
  nodeOfType,
  nodeParent,
} from "./node.ts";
import { exprSpan, templateTextEnd } from "./expr.ts";
import { typeParamSpan } from "./decl.ts";

function inRange(t: number): boolean {
  return t >= 0 && t < hir.nTypes;
}

/** `TypeNode::tag`: the kind without what it holds (`TYPE_*`); `TYPE_ERROR` for an id that is not a type. */
export function typeTag(t: number): number {
  return inRange(t) ? hir.typeTag[t] | 0 : TYPE_ERROR;
}

/** `TypeNode::span` into `SP`: without the parentheses around it. */
export function typeSpan(t: number): void {
  const SP$ = SP;
  if (!inRange(t)) {
    SP$.s0 = 0;
    SP$.s1 = 0;
    return;
  }
  const hir$ = hir;
  SP$.s0 = hir$.typePos[t] | 0;
  SP$.s1 = hir$.typeEnd[t] | 0;
}
export function typeStart(t: number): number {
  return inRange(t) ? hir.typePos[t] | 0 : 0;
}
export function typeEnd(t: number): number {
  return inRange(t) ? hir.typeEnd[t] | 0 : 0;
}

/**
 * `TypeNode::outer_span` into `SP`: with all the parentheses around it. The HIR does not record them: they are found in the text next to
 * the type.
 */
export function typeOuterSpan(t: number): void {
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  let start = typeStart(t);
  let end = typeEnd(t);
  while (true) {
    const before = fileEndOfTokenBefore(start);
    if (before === 0 || (text[before - 1] | 0) !== 40) break;
    const after = skipTrivia(text, len, end);
    if (after >= len || (text[after] | 0) !== 41) break;
    start = (before - 1) | 0;
    end = (after + 1) | 0;
  }
  const SP$ = SP;
  SP$.s0 = (start) | 0;
  SP$.s1 = (end) | 0;
}
export function typeOuterStart(t: number): number {
  typeOuterSpan(t);
  return SP.s0 | 0;
}
export function typeOuterEnd(t: number): number {
  typeOuterSpan(t);
  return SP.s1 | 0;
}

/** `TypeNode::is_parenthesized` */
export function typeIsParenthesized(t: number): boolean {
  typeOuterSpan(t);
  const SP$ = SP;
  return (SP$.s0 | 0) !== typeStart(t) || (SP$.s1 | 0) !== typeEnd(t);
}

/**
 * `TypeNode::annotation_span` into `SP`: the range of ESLint's `TSTypeAnnotation` around it, if it is the type of a variable, a parameter or a
 * property, or a return type: from the `:`, or the `=>` of a function type, to the end of the type and its parentheses.
 */
export function typeAnnotationSpan(t: number): void {
  typeOuterSpan(t);
  const SP$ = SP;
  const os = SP$.s0 | 0;
  const oe = SP$.s1 | 0;
  const before = fileEndOfTokenBefore(os);
  const text = hir.text;
  const isArrow = before >= 2 && (text[before - 2] | 0) === 61 && (text[before - 1] | 0) === 62;
  const back = isArrow ? 2 : 1;
  SP$.s0 = (before > back ? (before - back) | 0 : 0) | 0;
  SP$.s1 = (oe) | 0;
}

/** `TypeNode::parent` (a Node). */
export function typeParent(t: number): number {
  return nodeParent(nodeOfType(t));
}

/** `TypeNode::is_keyword(keyword)` */
export function typeIsKeyword(t: number, keyword: number): boolean {
  return typeTag(t) === TYPE_KEYWORD && (hir.typeA[t] | 0) === keyword;
}

/** The value of a `TYPE_NUMBER_LIT` (`file.hir.numbers`). */
export function typeNumberLitValue(t: number): number {
  if (typeTag(t) !== TYPE_NUMBER_LIT) return NaN;
  const hir$ = hir;
  const at = hir$.typeA[t] | 0;
  return at >= 0 && at < hir$.numbersLen ? hir$.numbers[at] : NaN;
}

/** `TypeNode::predicate_param`: the atom of the `x` of the `Predicate` `x is T` or `asserts x` (-1 if it is not one); `typePredicateParamPos` is where it is written. */
export function typePredicateParamAtom(t: number): number {
  return typeTag(t) === TYPE_PREDICATE ? hir.typeA[t] | 0 : -1;
}
export function typePredicateParamPos(t: number): number {
  const start = typeStart(t);
  const hir$ = hir;
  if ((hir$.typeAux[t] | 0) !== 0) return skipTrivia(hir$.text, hir$.sourceLen | 0, start + 7);
  return start;
}

/** `TypeNode::unique_symbol_keyword_span` into `SP`: the `symbol` of `unique symbol`. */
export function typeUniqueSymbolKeywordSpan(t: number): boolean {
  if (typeTag(t) !== TYPE_UNIQUE_SYMBOL) return false;
  const end = typeEnd(t);
  const SP$ = SP;
  SP$.s0 = (end > 6 ? (end - 6) | 0 : 0) | 0;
  SP$.s1 = (end) | 0;
  return true;
}

/** `TypeNode::import_span` into `SP`: of an `Import`: from the `import`, without a `typeof` before it. */
export function typeImportSpan(t: number): boolean {
  if (typeTag(t) !== TYPE_IMPORT) return false;
  const hir$ = hir;
  const isTypeof = ((hir$.typeAux[t] | 0) & 1) !== 0;
  const ws = typeStart(t);
  const we = typeEnd(t);
  const SP$ = SP;
  if (isTypeof) {
    SP$.s0 = (skipTrivia(hir$.text, hir$.sourceLen | 0, ws + 6)) | 0;
    SP$.s1 = (we) | 0;
  } else {
    SP$.s0 = (ws) | 0;
    SP$.s1 = (we) | 0;
  }
  return true;
}

/** `TypeNode::import_source_span` into `SP`: of an `Import`: the module specifier with its quotes. */
export function typeImportSourceSpan(t: number): boolean {
  if (!typeImportSpan(t)) return false;
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  const SP$ = SP;
  const open = skipTrivia(text, len, (SP$.s0 | 0) + 6);
  const start = skipTrivia(text, len, open + 1);
  SP$.s0 = (start) | 0;
  SP$.s1 = (tokenEnd(text, len, start, false)) | 0;
  return true;
}

/** `TypeNode::import_attributes`: of an `Import`: the `with: { .. }` of `import("m", { with: { .. } })`: its row in `hir.importAttributes`, or -1. */
export function typeImportAttributes(t: number): number {
  if (!importAttributesSearchSpanOfType(t)) return -1;
  const SP$ = SP;
  return importAttributesIndexWithin(SP$.s0 | 0, SP$.s1 | 0);
}

// ───────────────────────────── template types ─────────────────────────────
// `` `text${T}text` `` in a type: `TYPE_TEMPLATE`, the substitutions are the list `(typeTemplateTypesStart(t), typeTemplateTypesLen(t))`.

/** `TypeTemplate::quasi_count` */
export function typeTemplateQuasiCount(t: number): number {
  return ((hir.typeB[t] | 0) + 1) | 0;
}

/** `TypeTemplate::cooked(i)`: the atom of the value of the piece of text at `i`, or -1. */
export function typeTemplateCooked(t: number, i: number): number {
  const hir$ = hir;
  const n = hir$.typeD[t] | 0;
  if (i >= n) return -1;
  const at = ((hir$.typeC[t] | 0) + i) | 0;
  return at >= 0 && at < hir$.idsLen ? hir$.ids[at] | 0 : -1;
}

/** `TypeTemplate::quasi_span(i)` into `SP`: the piece of text at `i` with its delimiters. */
export function typeTemplateQuasiSpan(t: number, i: number): void {
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  const n = hir$.typeB[t] | 0;
  let start = typeStart(t);
  if (i >= 1 && i - 1 < n) {
    const before = hir$.ids[((hir$.typeA[t] | 0) + i - 1) | 0] | 0;
    start = skipTrivia(text, len, typeOuterEnd(before));
  }
  const end = i < n ? templateTextEnd(text, len, start + 1) : typeEnd(t);
  const SP$ = SP;
  SP$.s0 = (start) | 0;
  SP$.s1 = (end) | 0;
}

/** `TypeTemplate::raw(i)` into `SP`: the piece of text as it is written, without its delimiters. */
export function typeTemplateRawSpan(t: number, i: number): void {
  const isLast = i + 1 === typeTemplateQuasiCount(t);
  typeTemplateQuasiSpan(t, i);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const e = SP$.s1 | 0;
  const cut = isLast ? 1 : 2;
  SP$.s0 = (s + 1) | 0;
  SP$.s1 = (e > cut ? (e - cut) | 0 : 0) | 0;
}

// ───────────────────────────── angle brackets ─────────────────────────────

function angleBrackets(start: number, end: number): void {
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  let close = skipTrivia(text, len, end);
  if (close < len && (text[close] | 0) === 44) close = skipTrivia(text, len, close + 1);
  const before = fileEndOfTokenBefore(start);
  const SP$ = SP;
  SP$.s0 = (before > 0 ? (before - 1) | 0 : 0) | 0;
  SP$.s1 = (close + 1) | 0;
}

/**
 * `List<TypeNode>::angle_brackets_span` into `SP`: the `<..>` around type arguments (the list `(start, len)`): the range of ESLint's
 * `TSTypeParameterInstantiation`. False if the list is empty.
 */
export function typeListAngleBrackets(start: number, len: number): boolean {
  if (len <= 0) return false;
  const hir$ = hir;
  const first = hir$.ids[start] | 0;
  const last = hir$.ids[(start + len - 1) | 0] | 0;
  const s = typeOuterStart(first);
  const e = typeOuterEnd(last);
  angleBrackets(s, e);
  return true;
}

/** `List<TypeParam>::angle_brackets_span` into `SP`: the `<..>` around type parameters: the range of ESLint's `TSTypeParameterDeclaration`. False if the list is empty. */
export function typeParamListAngleBrackets(start: number, len: number): boolean {
  if (len <= 0) return false;
  const hir$ = hir;
  const first = hir$.ids[start] | 0;
  const last = hir$.ids[(start + len - 1) | 0] | 0;
  typeParamSpan(first);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  typeParamSpan(last);
  const e = SP$.s1 | 0;
  angleBrackets(s, e);
  return true;
}

// ───────────────────────────── ImportAttributes ─────────────────────────────
// `with { type: "json" }` after the module specifier of an import or an export, and the `with: { .. }` in the second argument of an import type.
// The handle is the ROW of `hir.importAttributes` (rows of 2: the keyword position, the ExprId of the `{ .. }`), or -1 for `None`.

/** The position of the keyword (`with`, `assert`). */
export function importAttributesKeyword(row: number): number {
  return hir.importAttributes[row * 2] | 0;
}
/** The `{ .. }`: an `EXPR_OBJECT` that is not a node. */
export function importAttributesObject(row: number): number {
  return hir.importAttributes[row * 2 + 1] | 0;
}
/** `ImportAttributes::keyword_span` into `SP`: `with`, or the deprecated `assert`. */
export function importAttributesKeywordSpan(row: number): void {
  const k = importAttributesKeyword(row);
  const SP$ = SP;
  SP$.s0 = (k) | 0;
  const hir$ = hir;
  SP$.s1 = (tokenEnd(hir$.text, hir$.sourceLen | 0, k, false)) | 0;
}
/** `ImportAttributes::braces_span` into `SP`: the `{ .. }`. */
export function importAttributesBracesSpan(row: number): void {
  exprSpan(importAttributesObject(row));
}
/** `ImportAttributes::options_span` into `SP`: in an import type: the `{ with: { .. } }` that is the second argument. */
export function importAttributesOptionsSpan(row: number): void {
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  exprSpan(importAttributesObject(row));
  const SP$ = SP;
  let close = skipTrivia(text, len, SP$.s1 | 0);
  if (close < len && (text[close] | 0) === 44) close = skipTrivia(text, len, close + 1);
  const before = fileEndOfTokenBefore(importAttributesKeyword(row));
  SP$.s0 = (before > 0 ? (before - 1) | 0 : 0) | 0;
  SP$.s1 = (close + 1) | 0;
}
/** `ImportAttributes::entries`: `key: "value"`: a list of PropIds. The key is a name or a string. */
export function importAttributesEntriesStart(row: number): number {
  const o = importAttributesObject(row);
  const hir$ = hir;
  return (hir$.exprTag[o] | 0) === EXPR_OBJECT ? hir$.exprA[o] | 0 : 0;
}
export function importAttributesEntriesLen(row: number): number {
  const o = importAttributesObject(row);
  const hir$ = hir;
  return (hir$.exprTag[o] | 0) === EXPR_OBJECT ? hir$.exprB[o] | 0 : 0;
}

// ───────────────────────────── TupleElem ─────────────────────────────
// `T`, `T?`, `...T`, `name: T`, `name?: T`, `...name: T` in a tuple type.

/** The `T` (a TypeNodeId). */
export function tupleElemTy(e: number): number {
  return hir.tupleElemWritten[e] | 0;
}
/** `TupleElem::name`: the atom of the name, or -1; `tupleElemNamePos` is where it is written. */
export function tupleElemName(e: number): number {
  return hir.tupleElemName[e] | 0;
}
export function tupleElemNamePos(e: number): number {
  const hir$ = hir;
  const start = hir$.tupleElemStart[e] | 0;
  if ((hir$.tupleElemHasDots[e] | 0) !== 0) return skipTrivia(hir$.text, hir$.sourceLen | 0, start + 3);
  return start;
}
export function tupleElemIsOptional(e: number): boolean {
  return (hir.tupleElemOptional[e] | 0) !== 0;
}
export function tupleElemIsRest(e: number): boolean {
  return (hir.tupleElemHasDots[e] | 0) !== 0;
}
export function tupleElemSpan(e: number): void {
  const hir$ = hir;
  const SP$ = SP;
  SP$.s0 = hir$.tupleElemStart[e] | 0;
  SP$.s1 = hir$.tupleElemEnd[e] | 0;
}
/** `TupleElem::parent`: the tuple type (a Node). */
export function tupleElemParent(e: number): number {
  return nodeParent(nodeOfTupleElem(e));
}

// ───────────────────────────── Mapped ─────────────────────────────
// `{ readonly [K in C as N]?: T }`: the payload of `TYPE_MAPPED` is the MappedId `typeMappedMapped(t)`.

/** The `K in C`: a TypeParamId (`C` is its constraint). */
export function mappedParam(m: number): number {
  return hir.mappedParam[m] | 0;
}
/** The `N` (TypeNodeId or -1). */
export function mappedNameTy(m: number): number {
  return hir.mappedNameTy[m] | 0;
}
/** The `T` (TypeNodeId or -1). */
export function mappedTy(m: number): number {
  return hir.mappedTy[m] | 0;
}
/** `MM_NONE`, `MM_ADD`, `MM_REMOVE` */
export function mappedReadonly(m: number): number {
  return hir.mappedReadonly[m] | 0;
}
export function mappedOptional(m: number): number {
  return hir.mappedOptional[m] | 0;
}
/** `+readonly`, as opposed to `readonly`. */
export function mappedIsReadonlyWithPlus(m: number): boolean {
  return (hir.mappedIsReadonlyWithPlus[m] | 0) !== 0;
}
/** `+?`, as opposed to `?`. */
export function mappedIsOptionalWithPlus(m: number): boolean {
  return (hir.mappedIsOptionalWithPlus[m] | 0) !== 0;
}
