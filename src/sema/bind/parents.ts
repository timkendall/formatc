// Port of vendor/bun/src/sema/bind/parents.rs (`try_bind_for_format_in` / `fill_in`): what each node of a file is part of, in one
// pass over the HIR tables, without scopes. The output is the `Bound` side tables that `lint/ast/node.rs` reads for `parent()`.
//
// Differences from Rust (all are merges of cases that every reader treats alike, or things that only the linter or the checker
// read; see docs/LINT_AST_API.md section "Parents"):
//   * `Parent` is a tag column + one id column. `PropKey(_, p)` and `MethodKey(p)` are `P_PROP` (the parent is the property);
//     `MemberKey(m)` and `MemberInit(m)` are `P_MEMBER`; `PatKey(p)` and `PatPropDefault(p)` are `P_PAT_PROP`;
//     `ParamDefault(p)` and `Decorator(_, Param(p))` are `P_PARAM`; `ClassExtends(c)` and `Decorator(_, Class(c))` are `P_CLASS`;
//     `Decorator(_, Member(m))` is `P_MEMBER`; `EnumInit(m)` is `P_ENUM_MEMBER`.
//   * No scopes (`class_scope`, `type_scope`, `type_param_scope` are only a "reached" byte, for `is_all_part_of_something`),
//     no `FnInfo` but its owner, no LINT counters, no `returns`/`yields`/`enclosing`.
//   * The fallback to the full binder (`leave_to_binder`, `binder.rs`, 5,392 lines) is not ported: `fillParents()` returns false
//     where Rust would have handed the file to it (a node nothing is part of: what the parser left behind where it backtracked),
//     and the tables are what the pass made of the rest. `bound.complete` says which.
import {
  BODY_BLOCK,
  BODY_EXPR,
  EXPR_ARRAY,
  EXPR_AS,
  EXPR_ASSIGN,
  EXPR_AS_CONST,
  EXPR_AWAIT,
  EXPR_BINARY,
  EXPR_CALL,
  EXPR_CLASS,
  EXPR_COND,
  EXPR_DOT,
  EXPR_FN,
  EXPR_IMPORT_CALL,
  EXPR_INDEX,
  EXPR_INSTANTIATION,
  EXPR_JSX,
  EXPR_NEW,
  EXPR_NON_NULL,
  EXPR_OBJECT,
  EXPR_SATISFIES,
  EXPR_SPREAD,
  EXPR_TAGGED_TEMPLATE,
  EXPR_TEMPLATE,
  EXPR_UNARY,
  EXPR_YIELD,
  MODK_DECORATOR,
  PAT_ARRAY,
  PAT_OBJECT,
  PK_COMPUTED,
  STMT_BLOCK,
  STMT_CLASS,
  STMT_DO_WHILE,
  STMT_EXPORT_ASSIGN,
  STMT_EXPORT_DEFAULT,
  STMT_EXPR,
  STMT_FN,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IF,
  STMT_IMPORT_EQUALS,
  STMT_LABELED,
  STMT_RETURN,
  STMT_SWITCH,
  STMT_THROW,
  STMT_TRY,
  STMT_VAR,
  STMT_WHILE,
  TM_OPTIONAL,
  TYPE_ARRAY,
  TYPE_COND,
  TYPE_FN,
  TYPE_HERITAGE,
  TYPE_IMPORT,
  TYPE_INDEXED_ACCESS,
  TYPE_INFER,
  TYPE_INTERSECTION,
  TYPE_JSDOC,
  TYPE_KEYOF,
  TYPE_MAPPED,
  TYPE_OBJECT,
  TYPE_PREDICATE,
  TYPE_READONLY,
  TYPE_REF,
  TYPE_TEMPLATE,
  TYPE_TUPLE,
  TYPE_TYPEOF,
  TYPE_UNION,
  TYPE_UNIQUE,
  hir,
} from "../hir.ts";
import { importCallTypeArgsRow } from "../hir_util.ts";
import { Slots1 } from "../../base/slots.ts";

// `Parent`
export const P_NONE: number = 0;
export const P_FILE: number = 1;
export const P_EXPR: number = 2;
export const P_STMT: number = 3;
/** The initializer of a `VarDecl`. */
export const P_VAR_INIT: number = 4;
/** A `Param`: its default, or a decorator of it. */
export const P_PARAM: number = 5;
/** A `PatProp`: its default or its computed key. */
export const P_PAT_PROP: number = 6;
/** A `PatElem`: its default. */
export const P_PAT_ELEM: number = 7;
/** A `Prop`: its value, or its computed key. */
export const P_PROP: number = 8;
/** A `Member`: its computed key, its initializer, or a decorator of it. */
export const P_MEMBER: number = 9;
/** The `Func` whose body it is (an expression body, a statement of the body). */
export const P_FN_BODY: number = 10;
/** An `EnumMember`: its computed name or its initializer. */
export const P_ENUM_MEMBER: number = 11;
export const P_CASE: number = 12;
/** A `Class`: its `extends`, or a decorator of it. */
export const P_CLASS: number = 13;
export const P_MODULE: number = 14;

// `PatParent`
export const PP_NONE: number = 0;
export const PP_VAR: number = 1;
export const PP_PARAM: number = 2;
export const PP_PROP: number = 3;
export const PP_ELEM: number = 4;

// `MemberOwner`
export const MO_NONE: number = 0;
export const MO_CLASS: number = 1;
export const MO_INTERFACE: number = 2;
export const MO_TYPE_LITERAL: number = 3;

// `ClassOwner` (CO_NONE: `Stmt(NONE)`, what nothing has claimed)
export const CO_NONE: number = 0;
export const CO_EXPR: number = 1;
export const CO_STMT: number = 2;

// `FnOwner`
export const FO_NONE: number = 0;
export const FO_EXPR: number = 1;
export const FO_STMT: number = 2;
export const FO_MEMBER: number = 3;
export const FO_TYPE: number = 4;

function growU8(a: Uint8Array, n: number): Uint8Array {
  if (a.length >= n) return a;
  let c = a.length < 256 ? 256 : a.length;
  while (c < n) c = c * 2;
  return new Uint8Array(c);
}
function growI32(a: Int32Array, n: number): Int32Array {
  if (a.length >= n) return a;
  let c = a.length < 256 ? 256 : a.length;
  while (c < n) c = c * 2;
  return new Int32Array(c);
}

export class Bound {
  exprParentTag: Uint8Array = new Uint8Array(256);
  exprParentA: Int32Array = new Int32Array(256);
  stmtParentTag: Uint8Array = new Uint8Array(256);
  stmtParentA: Int32Array = new Int32Array(256);
  patParentTag: Uint8Array = new Uint8Array(256);
  /** `PatProp` / `PatElem` / `VarDecl` / `Param` */
  patParentA: Int32Array = new Int32Array(256);
  /** The pattern that has the property or the element. */
  patParentB: Int32Array = new Int32Array(256);
  /** ExprId of the object literal that has the property (NONE: none). */
  propOwner: Int32Array = new Int32Array(256);
  memberOwnerTag: Uint8Array = new Uint8Array(256);
  memberOwnerA: Int32Array = new Int32Array(256);
  paramFn: Int32Array = new Int32Array(256);
  varStmt: Int32Array = new Int32Array(256);
  caseStmt: Int32Array = new Int32Array(256);
  classOwnerTag: Uint8Array = new Uint8Array(256);
  classOwnerA: Int32Array = new Int32Array(256);
  enumMemberOwner: Int32Array = new Int32Array(256);
  fnOwnerTag: Uint8Array = new Uint8Array(256);
  fnOwnerA: Int32Array = new Int32Array(256);
  /** 1: reached from a node (for `is_all_part_of_something`). */
  classReached: Uint8Array = new Uint8Array(256);
  typeReached: Uint8Array = new Uint8Array(256);
  typeParamReached: Uint8Array = new Uint8Array(256);
  /** The operands of `typeof a.b.c` (each of `a.b.c`, `a.b`, `a`), sorted, without duplicates: `typeQueryOperandsLen` of them. */
  typeQueryOperands: Int32Array = new Int32Array(64);
  typeQueryOperandsLen: number = 0;
  /** `fillParents` found every node to be part of something. */
  complete: boolean = false;
}

export const bound = new Bound();

const SAVED = new Slots1();

/** Makes the tables as long as the HIR's and empties them. */
function refill(): void {
  const b = bound;
  const hir$ = hir;
  const ne = hir$.nExprs | 0;
  const ns = hir$.nStmts | 0;
  const np = hir$.nPats | 0;
  const nm = hir$.nMembers | 0;
  b.exprParentTag = growU8(b.exprParentTag, ne);
  b.exprParentA = growI32(b.exprParentA, ne);
  b.stmtParentTag = growU8(b.stmtParentTag, ns);
  b.stmtParentA = growI32(b.stmtParentA, ns);
  b.patParentTag = growU8(b.patParentTag, np);
  b.patParentA = growI32(b.patParentA, np);
  b.patParentB = growI32(b.patParentB, np);
  b.propOwner = growI32(b.propOwner, hir$.nProps);
  b.memberOwnerTag = growU8(b.memberOwnerTag, nm);
  b.memberOwnerA = growI32(b.memberOwnerA, nm);
  b.paramFn = growI32(b.paramFn, hir$.nParams);
  b.varStmt = growI32(b.varStmt, hir$.nVarDecls);
  b.caseStmt = growI32(b.caseStmt, hir$.nCases);
  b.classOwnerTag = growU8(b.classOwnerTag, hir$.nClasses);
  b.classOwnerA = growI32(b.classOwnerA, hir$.nClasses);
  b.enumMemberOwner = growI32(b.enumMemberOwner, hir$.nEnumMembers);
  b.fnOwnerTag = growU8(b.fnOwnerTag, hir$.nFns);
  b.fnOwnerA = growI32(b.fnOwnerA, hir$.nFns);
  b.classReached = growU8(b.classReached, hir$.nClasses);
  b.typeReached = growU8(b.typeReached, hir$.nTypes);
  b.typeParamReached = growU8(b.typeParamReached, hir$.nTypeParams);
  b.exprParentTag.fill(0, 0, ne);
  b.exprParentA.fill(-1, 0, ne);
  b.stmtParentTag.fill(0, 0, ns);
  b.stmtParentA.fill(-1, 0, ns);
  b.patParentTag.fill(0, 0, np);
  b.patParentA.fill(-1, 0, np);
  b.patParentB.fill(-1, 0, np);
  b.propOwner.fill(-1, 0, hir$.nProps);
  b.memberOwnerTag.fill(0, 0, nm);
  b.memberOwnerA.fill(-1, 0, nm);
  b.paramFn.fill(-1, 0, hir$.nParams);
  b.varStmt.fill(-1, 0, hir$.nVarDecls);
  b.caseStmt.fill(-1, 0, hir$.nCases);
  b.classOwnerTag.fill(0, 0, hir$.nClasses);
  b.classOwnerA.fill(-1, 0, hir$.nClasses);
  b.enumMemberOwner.fill(-1, 0, hir$.nEnumMembers);
  b.fnOwnerTag.fill(0, 0, hir$.nFns);
  b.fnOwnerA.fill(-1, 0, hir$.nFns);
  b.classReached.fill(0, 0, hir$.nClasses);
  b.typeReached.fill(0, 0, hir$.nTypes);
  b.typeParamReached.fill(0, 0, hir$.nTypeParams);
  b.typeQueryOperandsLen = 0;
  SAVED.s0 = 0;
}

// ───────────── small setters (`set!`): an id that is NONE is the index of nothing ─────────────

function setExprParent(e: number, tag: number, a: number): void {
  const bound$ = bound;
  if (e >= 0) {
    bound$.exprParentTag[e] = tag;
    bound$.exprParentA[e] = a | 0;
  }
}
function setStmtParent(s: number, tag: number, a: number): void {
  const bound$ = bound;
  if (s >= 0) {
    bound$.stmtParentTag[s] = tag;
    bound$.stmtParentA[s] = a | 0;
  }
}
function setType(t: number): void {
  if (t >= 0) bound.typeReached[t] = 1;
}
// `setTypes`, `setTypeParams`, `setList` and `setProps` inline `setType` / `setExprParent` on hoisted columns (same stores,
// same `>= 0` guards), so that the `bound` and `hir` lookups are not repeated on every iteration.
function setTypes(start: number, len: number): void {
  const hir$ = hir;
  const bound$ = bound;
  for (let i = 0; i < len; i++) {
    const t = hir$.ids[(start + i) | 0] | 0;
    if (t >= 0) bound$.typeReached[t] = 1;
  }
}
function setTypeParams(start: number, len: number): void {
  const hir$ = hir;
  const ids = hir$.ids;
  const bound$ = bound;
  const typeParamReached = bound$.typeParamReached;
  const typeReached = bound$.typeReached;
  const typeParamConstraint = hir$.typeParamConstraint;
  const typeParamDefault = hir$.typeParamDefault;
  for (let i = 0; i < len; i++) {
    const p = ids[(start + i) | 0] | 0;
    if (p < 0) continue;
    typeParamReached[p] = 1;
    const c = typeParamConstraint[p] | 0;
    if (c >= 0) typeReached[c] = 1;
    const d = typeParamDefault[p] | 0;
    if (d >= 0) typeReached[d] = 1;
  }
}
/** `decorators!`: every decorator among the modifiers `(start, len)` gets the parent `(tag, a)`. */
function setDecorators(start: number, len: number, tag: number, a: number): void {
  const hir$ = hir;
  const bound$ = bound;
  for (let i = 0; i < len; i++) {
    const m = hir$.ids[(start + i) | 0] | 0;
    if ((hir$.modifierKind[m] | 0) === MODK_DECORATOR) {
      const e = hir$.modifierValue[m] | 0;
      if (e >= 0) {
        bound$.exprParentTag[e] = tag;
        bound$.exprParentA[e] = a | 0;
      }
    }
  }
}
function setList(start: number, len: number, tag: number, a: number): void {
  const hir$ = hir;
  const bound$ = bound;
  for (let i = 0; i < len; i++) {
    const e = hir$.ids[(start + i) | 0] | 0;
    if (e >= 0) {
      bound$.exprParentTag[e] = tag;
      bound$.exprParentA[e] = a | 0;
    }
  }
}
/** `props!` of an object literal `id` or the attributes of a JSX element. */
function setProps(start: number, len: number, id: number): void {
  const hir$ = hir;
  const bound$ = bound;
  for (let i = 0; i < len; i++) {
    const p = hir$.ids[(start + i) | 0] | 0;
    if (p < 0) continue;
    bound$.propOwner[p] = id;
    const v = hir$.propValue[p] | 0;
    if (v >= 0) {
      bound$.exprParentTag[v] = P_PROP;
      bound$.exprParentA[v] = p | 0;
    }
    if ((hir$.propKeyKind[p] | 0) === PK_COMPUTED) {
      const k = hir$.propKeyVal[p] | 0;
      if (k >= 0) {
        bound$.exprParentTag[k] = P_PROP;
        bound$.exprParentA[k] = p | 0;
      }
    }
  }
}

function pushTypeQueryOperand(e: number): void {
  const b = bound;
  if (b.typeQueryOperandsLen >= b.typeQueryOperands.length) {
    const n = new Int32Array(b.typeQueryOperands.length * 2);
    n.set(b.typeQueryOperands);
    b.typeQueryOperands = n;
  }
  b.typeQueryOperands[b.typeQueryOperandsLen] = e | 0;
  b.typeQueryOperandsLen = ((b.typeQueryOperandsLen | 0) + 1) | 0;
}

/** Sorts and deduplicates `typeQueryOperands` (an insertion sort: they come almost in order). */
function sortTypeQueryOperands(): void {
  const bound$ = bound;
  const a = bound$.typeQueryOperands;
  const n = bound$.typeQueryOperandsLen | 0;
  for (let i = 1; i < n; i++) {
    const v = a[i] | 0;
    let j = i - 1;
    while (j >= 0 && (a[j] | 0) > v) {
      a[j + 1] = a[j] | 0;
      j = j - 1;
    }
    a[j + 1] = v;
  }
  let w = 0;
  for (let i = 0; i < n; i++) {
    const v = a[i] | 0;
    if (w === 0 || (a[w - 1] | 0) !== v) {
      a[w] = v;
      w = ((w | 0) + 1) | 0;
    }
  }
  bound$.typeQueryOperandsLen = w;
}

/** Whether `e` is the operand of a `typeof` in a type: binary search of `typeQueryOperands`. */
export function isTypeQueryOperand(e: number): boolean {
  const bound$ = bound;
  const a = bound$.typeQueryOperands;
  let lo = 0;
  let hi = bound$.typeQueryOperandsLen | 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = a[mid] | 0;
    if (v < e) lo = mid + 1;
    else if (v > e) hi = mid;
    else return true;
  }
  return false;
}

/**
 * `try_bind_for_format_in`: fills `bound` from the HIR (which must be finished: `finishHir()`). Returns false where Rust would
 * leave the file to the binder; `bound.complete` is the same.
 */
export function fillParents(): boolean {
  refill();
  const ok = fill();
  const done = ok && isAllPartOfSomething();
  bound.complete = done;
  return done;
}

function fill(): boolean {
  const hir$ = hir;
  const ids = hir$.ids;
  // The HIR and `bound` columns that the loops below read or write, read once here: in worker mode a module-level
  // `hir` / `bound` is a thread-local lookup, and `hir.col[i]` in a loop repeats it on every iteration. None of them is
  // reallocated in here: only `refill()` grows the `bound` columns (`typeQueryOperands` is not hoisted).
  const aliasTy = hir$.aliasTy;
  const aliasTypeParamsLen = hir$.aliasTypeParamsLen;
  const aliasTypeParamsStart = hir$.aliasTypeParamsStart;
  const callArgsLen = hir$.callArgsLen;
  const callArgsStart = hir$.callArgsStart;
  const callCallee = hir$.callCallee;
  const callTemplate = hir$.callTemplate;
  const callTypeArgsLen = hir$.callTypeArgsLen;
  const callTypeArgsStart = hir$.callTypeArgsStart;
  const caseBodyLen = hir$.caseBodyLen;
  const caseBodyStart = hir$.caseBodyStart;
  const caseTest = hir$.caseTest;
  const classExtends = hir$.classExtends;
  const classExtendsArgsLen = hir$.classExtendsArgsLen;
  const classExtendsArgsStart = hir$.classExtendsArgsStart;
  const classImplementsLen = hir$.classImplementsLen;
  const classImplementsStart = hir$.classImplementsStart;
  const classMembersLen = hir$.classMembersLen;
  const classMembersStart = hir$.classMembersStart;
  const classModLen = hir$.classModLen;
  const classModStart = hir$.classModStart;
  const classOtherExtendsLen = hir$.classOtherExtendsLen;
  const classOtherExtendsStart = hir$.classOtherExtendsStart;
  const classOtherImplementsLen = hir$.classOtherImplementsLen;
  const classOtherImplementsStart = hir$.classOtherImplementsStart;
  const classTypeParamsLen = hir$.classTypeParamsLen;
  const classTypeParamsStart = hir$.classTypeParamsStart;
  const enumMemberComputedName = hir$.enumMemberComputedName;
  const enumMemberInit = hir$.enumMemberInit;
  const enumMembersLen = hir$.enumMembersLen;
  const enumMembersStart = hir$.enumMembersStart;
  const exprA = hir$.exprA;
  const exprB = hir$.exprB;
  const exprC = hir$.exprC;
  const exprTag = hir$.exprTag;
  const fnBodyA = hir$.fnBodyA;
  const fnBodyB = hir$.fnBodyB;
  const fnBodyKind = hir$.fnBodyKind;
  const fnParamsLen = hir$.fnParamsLen;
  const fnParamsStart = hir$.fnParamsStart;
  const fnRet = hir$.fnRet;
  const fnThisParam = hir$.fnThisParam;
  const fnTypeParamsLen = hir$.fnTypeParamsLen;
  const fnTypeParamsStart = hir$.fnTypeParamsStart;
  const importAttributes = hir$.importAttributes;
  const importCallTypeArgs = hir$.importCallTypeArgs;
  const importEqualsExpression = hir$.importEqualsExpression;
  const interfaceExtendsLen = hir$.interfaceExtendsLen;
  const interfaceExtendsStart = hir$.interfaceExtendsStart;
  const interfaceMembersLen = hir$.interfaceMembersLen;
  const interfaceMembersStart = hir$.interfaceMembersStart;
  const interfaceOtherHeritageLen = hir$.interfaceOtherHeritageLen;
  const interfaceOtherHeritageStart = hir$.interfaceOtherHeritageStart;
  const interfaceTypeParamsLen = hir$.interfaceTypeParamsLen;
  const interfaceTypeParamsStart = hir$.interfaceTypeParamsStart;
  const jsxAttrsLen = hir$.jsxAttrsLen;
  const jsxAttrsStart = hir$.jsxAttrsStart;
  const jsxChildrenLen = hir$.jsxChildrenLen;
  const jsxChildrenStart = hir$.jsxChildrenStart;
  const jsxCloseTag = hir$.jsxCloseTag;
  const jsxTag = hir$.jsxTag;
  const jsxTypeArgsLen = hir$.jsxTypeArgsLen;
  const jsxTypeArgsStart = hir$.jsxTypeArgsStart;
  const mappedMembersLen = hir$.mappedMembersLen;
  const mappedMembersStart = hir$.mappedMembersStart;
  const mappedNameTy = hir$.mappedNameTy;
  const mappedParam = hir$.mappedParam;
  const mappedTy = hir$.mappedTy;
  const memberFunc = hir$.memberFunc;
  const memberInit = hir$.memberInit;
  const memberKeyKind = hir$.memberKeyKind;
  const memberKeyVal = hir$.memberKeyVal;
  const memberModLen = hir$.memberModLen;
  const memberModStart = hir$.memberModStart;
  const memberTy = hir$.memberTy;
  const moduleBodyLen = hir$.moduleBodyLen;
  const moduleBodyStart = hir$.moduleBodyStart;
  const paramDefault = hir$.paramDefault;
  const paramModLen = hir$.paramModLen;
  const paramModStart = hir$.paramModStart;
  const paramPat = hir$.paramPat;
  const paramTy = hir$.paramTy;
  const patA = hir$.patA;
  const patB = hir$.patB;
  const patElemDefault = hir$.patElemDefault;
  const patElemPat = hir$.patElemPat;
  const patPropDefault = hir$.patPropDefault;
  const patPropKeyKind = hir$.patPropKeyKind;
  const patPropKeyVal = hir$.patPropKeyVal;
  const patPropValue = hir$.patPropValue;
  const patTag = hir$.patTag;
  const specifierExpressions = hir$.specifierExpressions;
  const stmtA = hir$.stmtA;
  const stmtB = hir$.stmtB;
  const stmtC = hir$.stmtC;
  const stmtD = hir$.stmtD;
  const stmtModLen = hir$.stmtModLen;
  const stmtModStart = hir$.stmtModStart;
  const stmtTag = hir$.stmtTag;
  const tupleElemMemberType = hir$.tupleElemMemberType;
  const tupleElemTy = hir$.tupleElemTy;
  const tupleElemWritten = hir$.tupleElemWritten;
  const typeA = hir$.typeA;
  const typeB = hir$.typeB;
  const typeC = hir$.typeC;
  const typeD = hir$.typeD;
  const typeE = hir$.typeE;
  const typeParamConstraint = hir$.typeParamConstraint;
  const typeParamDefault = hir$.typeParamDefault;
  const typeTag = hir$.typeTag;
  const varDeclInit = hir$.varDeclInit;
  const varDeclPat = hir$.varDeclPat;
  const varDeclTy = hir$.varDeclTy;
  const bound$ = bound;
  const caseStmt = bound$.caseStmt;
  const classOwnerA = bound$.classOwnerA;
  const classOwnerTag = bound$.classOwnerTag;
  const classReached = bound$.classReached;
  const enumMemberOwner = bound$.enumMemberOwner;
  const fnOwnerA = bound$.fnOwnerA;
  const fnOwnerTag = bound$.fnOwnerTag;
  const memberOwnerA = bound$.memberOwnerA;
  const memberOwnerTag = bound$.memberOwnerTag;
  const paramFn = bound$.paramFn;
  const patParentA = bound$.patParentA;
  const patParentB = bound$.patParentB;
  const patParentTag = bound$.patParentTag;
  const typeParamReached = bound$.typeParamReached;
  const varStmt = bound$.varStmt;

  // The expressions come first. What the parser has left behind are expressions, like the `A<T>` of `extends A<T>` and the
  // `a = 1` of `({ a = 1 }) => 0`, whose operands are part of something that is not an expression. Of two expressions, the one
  // that is made later is the one that is kept.
  const ne = hir$.nExprs | 0;
  for (let id = 0; id < ne; id++) {
    const tag = exprTag[id] | 0;
    switch (tag) {
      case EXPR_DOT:
        setExprParent(exprA[id] | 0, P_EXPR, id);
        break;
      case EXPR_INDEX:
        setExprParent(exprA[id] | 0, P_EXPR, id);
        setExprParent(exprB[id] | 0, P_EXPR, id);
        break;
      case EXPR_CALL:
      case EXPR_NEW:
      case EXPR_TAGGED_TEMPLATE: {
        const c = exprA[id] | 0;
        if (c >= 0) {
          setExprParent(callCallee[c] | 0, P_EXPR, id);
          setExprParent(callTemplate[c] | 0, P_EXPR, id);
          setList(callArgsStart[c] | 0, callArgsLen[c] | 0, P_EXPR, id);
          setTypes(callTypeArgsStart[c] | 0, callTypeArgsLen[c] | 0);
        }
        break;
      }
      case EXPR_TEMPLATE:
      case EXPR_ARRAY:
        setList(exprA[id] | 0, exprB[id] | 0, P_EXPR, id);
        break;
      case EXPR_IMPORT_CALL: {
        const start = exprA[id] | 0;
        const len = exprB[id] | 0;
        setList(start, len, P_EXPR, id);
        if (hir$.importCallTypeArgsLen > 0 && len > 0) {
          const row = importCallTypeArgsRow(ids[start] | 0);
          if (row >= 0) setTypes(importCallTypeArgs[row + 1] | 0, importCallTypeArgs[row + 2] | 0);
        }
        break;
      }
      case EXPR_OBJECT:
        setProps(exprA[id] | 0, exprB[id] | 0, id);
        break;
      case EXPR_FN: {
        const f = exprA[id] | 0;
        if (f >= 0) {
          fnOwnerTag[f] = FO_EXPR;
          fnOwnerA[f] = id;
        }
        break;
      }
      case EXPR_CLASS: {
        const c = exprA[id] | 0;
        if (c >= 0) {
          classOwnerTag[c] = CO_EXPR;
          classOwnerA[c] = id;
          classReached[c] = 1;
        }
        break;
      }
      case EXPR_BINARY:
      case EXPR_ASSIGN:
        setExprParent(exprA[id] | 0, P_EXPR, id);
        setExprParent(exprB[id] | 0, P_EXPR, id);
        break;
      case EXPR_COND:
        setExprParent(exprA[id] | 0, P_EXPR, id);
        setExprParent(exprB[id] | 0, P_EXPR, id);
        setExprParent(exprC[id] | 0, P_EXPR, id);
        break;
      case EXPR_UNARY:
      case EXPR_SPREAD:
      case EXPR_AWAIT:
      case EXPR_AS_CONST:
      case EXPR_NON_NULL:
      case EXPR_YIELD:
        setExprParent(exprA[id] | 0, P_EXPR, id);
        break;
      case EXPR_AS:
      case EXPR_SATISFIES:
        setExprParent(exprA[id] | 0, P_EXPR, id);
        setType(exprB[id] | 0);
        break;
      case EXPR_INSTANTIATION:
        setExprParent(exprA[id] | 0, P_EXPR, id);
        setTypes(exprB[id] | 0, exprC[id] | 0);
        break;
      case EXPR_JSX: {
        const j = exprA[id] | 0;
        if (j >= 0) {
          setExprParent(jsxTag[j] | 0, P_EXPR, id);
          setExprParent(jsxCloseTag[j] | 0, P_EXPR, id);
          setTypes(jsxTypeArgsStart[j] | 0, jsxTypeArgsLen[j] | 0);
          setProps(jsxAttrsStart[j] | 0, jsxAttrsLen[j] | 0, id);
          setList(jsxChildrenStart[j] | 0, jsxChildrenLen[j] | 0, P_EXPR, id);
        }
        break;
      }
      default:
        break;
    }
  }

  const nt = hir$.nTypes | 0;
  for (let id = 0; id < nt; id++) {
    const tag = typeTag[id] | 0;
    switch (tag) {
      // An error (typescript-estree refuses the file), which Rust hands to the binder: its expression is part of what the type is in.
      case TYPE_HERITAGE:
        setExprParent(typeA[id] | 0, P_FILE, -1);
        setTypes(typeB[id] | 0, typeC[id] | 0);
        break;
      case TYPE_TYPEOF: {
        setTypes(typeC[id] | 0, typeD[id] | 0);
        const expr = typeE[id] | 0;
        setExprParent(expr, P_FILE, -1);
        let at = expr;
        while (at >= 0 && at < ne) {
          pushTypeQueryOperand(at);
          if ((exprTag[at] | 0) !== EXPR_DOT) break;
          at = exprA[at] | 0;
        }
        break;
      }
      case TYPE_FN: {
        const f = typeA[id] | 0;
        if (f >= 0) {
          fnOwnerTag[f] = FO_TYPE;
          fnOwnerA[f] = id;
        }
        break;
      }
      case TYPE_OBJECT: {
        const start = typeA[id] | 0;
        const len = typeB[id] | 0;
        for (let i = 0; i < len; i++) {
          const m = ids[(start + i) | 0] | 0;
          if (m >= 0) {
            memberOwnerTag[m] = MO_TYPE_LITERAL;
            memberOwnerA[m] = id;
          }
        }
        break;
      }
      case TYPE_MAPPED: {
        const mp = typeA[id] | 0;
        if (mp >= 0) {
          const param = mappedParam[mp] | 0;
          if (param >= 0) {
            typeParamReached[param] = 1;
            setType(typeParamConstraint[param] | 0);
            setType(typeParamDefault[param] | 0);
          }
          setType(mappedNameTy[mp] | 0);
          setType(mappedTy[mp] | 0);
          const start = mappedMembersStart[mp] | 0;
          const len = mappedMembersLen[mp] | 0;
          for (let i = 0; i < len; i++) {
            const m = ids[(start + i) | 0] | 0;
            if (m >= 0) {
              memberOwnerTag[m] = MO_TYPE_LITERAL;
              memberOwnerA[m] = id;
            }
          }
        }
        break;
      }
      case TYPE_REF:
        setTypes(typeC[id] | 0, typeD[id] | 0);
        break;
      case TYPE_IMPORT:
        setTypes(typeD[id] | 0, typeE[id] | 0);
        break;
      case TYPE_TEMPLATE:
      case TYPE_UNION:
      case TYPE_INTERSECTION:
        setTypes(typeA[id] | 0, typeB[id] | 0);
        break;
      case TYPE_ARRAY:
      case TYPE_KEYOF:
      case TYPE_READONLY:
      case TYPE_UNIQUE:
      case TYPE_JSDOC:
        setType(typeA[id] | 0);
        break;
      case TYPE_PREDICATE:
        setType(typeB[id] | 0);
        break;
      case TYPE_TUPLE: {
        const start = typeA[id] | 0;
        const len = typeB[id] | 0;
        for (let i = 0; i < len; i++) {
          const e = ids[(start + i) | 0] | 0;
          if (e < 0) continue;
          // Of `ty` and `written`, the one that contains the other.
          if ((tupleElemMemberType[e] | 0) === TM_OPTIONAL) setType(tupleElemTy[e] | 0);
          else setType(tupleElemWritten[e] | 0);
        }
        break;
      }
      case TYPE_COND:
        setType(typeA[id] | 0);
        setType(typeB[id] | 0);
        setType(typeC[id] | 0);
        setType(typeD[id] | 0);
        break;
      case TYPE_INDEXED_ACCESS:
        setType(typeA[id] | 0);
        setType(typeB[id] | 0);
        break;
      // Not its default.
      case TYPE_INFER: {
        const p = typeA[id] | 0;
        if (p >= 0) {
          typeParamReached[p] = 1;
          setType(typeParamConstraint[p] | 0);
        }
        break;
      }
      default:
        break;
    }
  }

  const na = hir$.nAliases | 0;
  for (let i = 0; i < na; i++) {
    setTypeParams(aliasTypeParamsStart[i] | 0, aliasTypeParamsLen[i] | 0);
    setType(aliasTy[i] | 0);
  }
  const ni = hir$.nInterfaces | 0;
  for (let i = 0; i < ni; i++) {
    setTypeParams(interfaceTypeParamsStart[i] | 0, interfaceTypeParamsLen[i] | 0);
    setTypes(interfaceExtendsStart[i] | 0, interfaceExtendsLen[i] | 0);
    setTypes(interfaceOtherHeritageStart[i] | 0, interfaceOtherHeritageLen[i] | 0);
    const start = interfaceMembersStart[i] | 0;
    const len = interfaceMembersLen[i] | 0;
    for (let k = 0; k < len; k++) {
      const m = ids[(start + k) | 0] | 0;
      if (m >= 0) {
        memberOwnerTag[m] = MO_INTERFACE;
        memberOwnerA[m] = i;
      }
    }
  }
  const nc = hir$.nClasses | 0;
  for (let id = 0; id < nc; id++) {
    setDecorators(classModStart[id] | 0, classModLen[id] | 0, P_CLASS, id);
    setExprParent(classExtends[id] | 0, P_CLASS, id);
    setList(classOtherExtendsStart[id] | 0, classOtherExtendsLen[id] | 0, P_CLASS, id);
    setTypeParams(classTypeParamsStart[id] | 0, classTypeParamsLen[id] | 0);
    setTypes(classExtendsArgsStart[id] | 0, classExtendsArgsLen[id] | 0);
    setTypes(classImplementsStart[id] | 0, classImplementsLen[id] | 0);
    setTypes(classOtherImplementsStart[id] | 0, classOtherImplementsLen[id] | 0);
    const start = classMembersStart[id] | 0;
    const len = classMembersLen[id] | 0;
    for (let k = 0; k < len; k++) {
      const m = ids[(start + k) | 0] | 0;
      if (m >= 0) {
        memberOwnerTag[m] = MO_CLASS;
        memberOwnerA[m] = id;
      }
    }
  }
  const nm = hir$.nMembers | 0;
  for (let id = 0; id < nm; id++) {
    if ((memberOwnerTag[id] | 0) === MO_CLASS) {
      setDecorators(memberModStart[id] | 0, memberModLen[id] | 0, P_MEMBER, id);
    }
    if ((memberKeyKind[id] | 0) === PK_COMPUTED) setExprParent(memberKeyVal[id] | 0, P_MEMBER, id);
    const f = memberFunc[id] | 0;
    if (f >= 0) {
      fnOwnerTag[f] = FO_MEMBER;
      fnOwnerA[f] = id;
    }
    setExprParent(memberInit[id] | 0, P_MEMBER, id);
    setType(memberTy[id] | 0);
  }

  const ns = hir$.nStmts | 0;
  for (let id = 0; id < ns; id++) {
    const tag = stmtTag[id] | 0;
    if ((stmtModLen[id] | 0) !== 0 && tag !== STMT_CLASS) {
      setDecorators(stmtModStart[id] | 0, stmtModLen[id] | 0, P_STMT, id);
    }
    switch (tag) {
      case STMT_RETURN:
      case STMT_EXPR:
      case STMT_THROW:
      case STMT_EXPORT_DEFAULT:
      case STMT_EXPORT_ASSIGN:
        setExprParent(stmtA[id] | 0, P_STMT, id);
        break;
      case STMT_VAR: {
        const start = stmtA[id] | 0;
        const len = stmtB[id] | 0;
        for (let i = 0; i < len; i++) {
          const d = ids[(start + i) | 0] | 0;
          if (d >= 0) varStmt[d] = id;
        }
        break;
      }
      case STMT_FN: {
        const f = stmtA[id] | 0;
        if (f >= 0) {
          fnOwnerTag[f] = FO_STMT;
          fnOwnerA[f] = id;
        }
        break;
      }
      case STMT_CLASS: {
        const c = stmtA[id] | 0;
        if (c >= 0) {
          classOwnerTag[c] = CO_STMT;
          classOwnerA[c] = id;
          classReached[c] = 1;
        }
        break;
      }
      case STMT_IF:
        setExprParent(stmtA[id] | 0, P_STMT, id);
        setStmtParent(stmtB[id] | 0, P_STMT, id);
        setStmtParent(stmtC[id] | 0, P_STMT, id);
        break;
      case STMT_WHILE:
        setExprParent(stmtA[id] | 0, P_STMT, id);
        setStmtParent(stmtB[id] | 0, P_STMT, id);
        break;
      case STMT_DO_WHILE:
        setExprParent(stmtB[id] | 0, P_STMT, id);
        setStmtParent(stmtA[id] | 0, P_STMT, id);
        break;
      case STMT_FOR:
        setExprParent(stmtB[id] | 0, P_STMT, id);
        setExprParent(stmtC[id] | 0, P_STMT, id);
        setStmtParent(stmtA[id] | 0, P_STMT, id);
        setStmtParent(stmtD[id] | 0, P_STMT, id);
        break;
      case STMT_FOR_IN:
      case STMT_FOR_OF:
        setExprParent(stmtB[id] | 0, P_STMT, id);
        setStmtParent(stmtA[id] | 0, P_STMT, id);
        setStmtParent(stmtC[id] | 0, P_STMT, id);
        break;
      case STMT_BLOCK: {
        const start = stmtA[id] | 0;
        const len = stmtB[id] | 0;
        for (let i = 0; i < len; i++) setStmtParent(ids[(start + i) | 0] | 0, P_STMT, id);
        break;
      }
      case STMT_SWITCH: {
        setExprParent(stmtA[id] | 0, P_STMT, id);
        const start = stmtB[id] | 0;
        const len = stmtC[id] | 0;
        for (let i = 0; i < len; i++) {
          const c = ids[(start + i) | 0] | 0;
          if (c < 0) continue;
          caseStmt[c] = id;
          setExprParent(caseTest[c] | 0, P_CASE, c);
          const bs = caseBodyStart[c] | 0;
          const bl = caseBodyLen[c] | 0;
          for (let k = 0; k < bl; k++) setStmtParent(ids[(bs + k) | 0] | 0, P_STMT, id);
        }
        break;
      }
      case STMT_TRY: {
        const param = stmtB[id] | 0;
        if (param >= 0) varStmt[param] = id;
        setStmtParent(stmtA[id] | 0, P_STMT, id);
        setStmtParent(stmtC[id] | 0, P_STMT, id);
        setStmtParent(stmtD[id] | 0, P_STMT, id);
        break;
      }
      case STMT_LABELED:
        setStmtParent(stmtB[id] | 0, P_STMT, id);
        break;
      case STMT_IMPORT_EQUALS: {
        const ie = stmtA[id] | 0;
        if (ie >= 0) setExprParent(importEqualsExpression[ie] | 0, P_STMT, id);
        break;
      }
      default:
        break;
    }
  }

  const nf = hir$.nFns | 0;
  for (let id = 0; id < nf; id++) {
    const thisParam = fnThisParam[id] | 0;
    if (thisParam >= 0) paramFn[thisParam] = id;
    setTypeParams(fnTypeParamsStart[id] | 0, fnTypeParamsLen[id] | 0);
    setType(fnRet[id] | 0);
    if (thisParam >= 0) setType(paramTy[thisParam] | 0);
    // The decorators of a parameter of a member of a class are evaluated with the class.
    let hasClass = false;
    if ((fnOwnerTag[id] | 0) === FO_MEMBER) {
      const m = fnOwnerA[id] | 0;
      if (m >= 0 && m < nm && (memberOwnerTag[m] | 0) === MO_CLASS) hasClass = true;
    }
    const ps = fnParamsStart[id] | 0;
    const pl = fnParamsLen[id] | 0;
    for (let i = 0; i < pl; i++) {
      const p = ids[(ps + i) | 0] | 0;
      if (p < 0) continue;
      paramFn[p] = id;
      const pat = paramPat[p] | 0;
      if (pat >= 0) {
        patParentTag[pat] = PP_PARAM;
        patParentA[pat] = p;
      }
      setType(paramTy[p] | 0);
      setExprParent(paramDefault[p] | 0, P_PARAM, p);
      if (hasClass) setDecorators(paramModStart[p] | 0, paramModLen[p] | 0, P_PARAM, p);
      else setDecorators(paramModStart[p] | 0, paramModLen[p] | 0, P_FN_BODY, id);
    }
    const bk = fnBodyKind[id] | 0;
    if (bk === BODY_EXPR) {
      setExprParent(fnBodyA[id] | 0, P_FN_BODY, id);
    } else if (bk === BODY_BLOCK) {
      const bs = fnBodyA[id] | 0;
      const bl = fnBodyB[id] | 0;
      for (let i = 0; i < bl; i++) setStmtParent(ids[(bs + i) | 0] | 0, P_FN_BODY, id);
    }
  }

  // `fill_of_var_decls`
  const nv = hir$.nVarDecls | 0;
  for (let id = 0; id < nv; id++) {
    const pat = varDeclPat[id] | 0;
    if (pat >= 0) {
      patParentTag[pat] = PP_VAR;
      patParentA[pat] = id;
    }
    setExprParent(varDeclInit[id] | 0, P_VAR_INIT, id);
    setType(varDeclTy[id] | 0);
  }

  const np = hir$.nPats | 0;
  for (let id = 0; id < np; id++) {
    const tag = patTag[id] | 0;
    if (tag === PAT_OBJECT) {
      const start = patA[id] | 0;
      const len = patB[id] | 0;
      for (let i = 0; i < len; i++) {
        const p = ids[(start + i) | 0] | 0;
        if (p < 0) continue;
        if ((patPropKeyKind[p] | 0) === PK_COMPUTED) setExprParent(patPropKeyVal[p] | 0, P_PAT_PROP, p);
        setExprParent(patPropDefault[p] | 0, P_PAT_PROP, p);
        const v = patPropValue[p] | 0;
        if (v >= 0) {
          patParentTag[v] = PP_PROP;
          patParentA[v] = p;
          patParentB[v] = id;
        }
      }
    } else if (tag === PAT_ARRAY) {
      const start = patA[id] | 0;
      const len = patB[id] | 0;
      for (let i = 0; i < len; i++) {
        const e = ids[(start + i) | 0] | 0;
        if (e < 0) continue;
        setExprParent(patElemDefault[e] | 0, P_PAT_ELEM, e);
        const pat = patElemPat[e] | 0;
        if (pat >= 0) {
          patParentTag[pat] = PP_ELEM;
          patParentA[pat] = e;
          patParentB[pat] = id;
        }
      }
    }
  }
  const nen = hir$.nEnums | 0;
  for (let i = 0; i < nen; i++) {
    const start = enumMembersStart[i] | 0;
    const len = enumMembersLen[i] | 0;
    for (let k = 0; k < len; k++) {
      const m = ids[(start + k) | 0] | 0;
      if (m < 0) continue;
      enumMemberOwner[m] = i;
      setExprParent(enumMemberComputedName[m] | 0, P_ENUM_MEMBER, m);
      setExprParent(enumMemberInit[m] | 0, P_ENUM_MEMBER, m);
    }
  }
  const nmod = hir$.nModules | 0;
  for (let i = 0; i < nmod; i++) {
    const start = moduleBodyStart[i] | 0;
    const len = moduleBodyLen[i] | 0;
    for (let k = 0; k < len; k++) setStmtParent(ids[(start + k) | 0] | 0, P_MODULE, i);
  }
  {
    const start = hir$.bodyStart | 0;
    const len = hir$.bodyLen | 0;
    for (let k = 0; k < len; k++) setStmtParent(ids[(start + k) | 0] | 0, P_FILE, -1);
  }
  for (let i = 0; i < hir$.importAttributesLen; i += 2) setExprParent(importAttributes[i + 1] | 0, P_FILE, -1);
  for (let i = 0; i < hir$.specifierExpressionsLen; i++) setExprParent(specifierExpressions[i] | 0, P_FILE, -1);
  return true;
}

/**
 * What nothing says to be a part of anything is what the parser has left behind, and what is in it has entries that `bind` does not
 * have. That is rare enough to leave it to the binder (Rust); here `bound.complete` is false for such a file.
 */
function isAllPartOfSomething(): boolean {
  sortTypeQueryOperands();
  const b = bound;
  let orphan = 0;
  const hir$ = hir;
  const ne = hir$.nExprs | 0;
  for (let i = 0; i < ne; i++) orphan = orphan | (((b.exprParentTag[i] | 0) === P_NONE) ? 1 : 0);
  const ns = hir$.nStmts | 0;
  for (let i = 0; i < ns; i++) orphan = orphan | (((b.stmtParentTag[i] | 0) === P_NONE) ? 1 : 0);
  if (orphan !== 0) return false;
  const nf = hir$.nFns | 0;
  for (let i = 0; i < nf; i++) if ((b.fnOwnerTag[i] | 0) === FO_NONE) return false;
  const nc = hir$.nClasses | 0;
  for (let i = 0; i < nc; i++) if ((b.classOwnerTag[i] | 0) === CO_NONE) return false;
  const nt = hir$.nTypes | 0;
  for (let i = 0; i < nt; i++) if ((b.typeReached[i] | 0) === 0) return false;
  const ntp = hir$.nTypeParams | 0;
  for (let i = 0; i < ntp; i++) if ((b.typeParamReached[i] | 0) === 0) return false;
  return true;
}
