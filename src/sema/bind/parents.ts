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

const SAVED = new Int32Array(1);

/** Makes the tables as long as the HIR's and empties them. */
function refill(): void {
  const b = bound;
  const ne = hir.nExprs | 0;
  const ns = hir.nStmts | 0;
  const np = hir.nPats | 0;
  const nm = hir.nMembers | 0;
  b.exprParentTag = growU8(b.exprParentTag, ne);
  b.exprParentA = growI32(b.exprParentA, ne);
  b.stmtParentTag = growU8(b.stmtParentTag, ns);
  b.stmtParentA = growI32(b.stmtParentA, ns);
  b.patParentTag = growU8(b.patParentTag, np);
  b.patParentA = growI32(b.patParentA, np);
  b.patParentB = growI32(b.patParentB, np);
  b.propOwner = growI32(b.propOwner, hir.nProps);
  b.memberOwnerTag = growU8(b.memberOwnerTag, nm);
  b.memberOwnerA = growI32(b.memberOwnerA, nm);
  b.paramFn = growI32(b.paramFn, hir.nParams);
  b.varStmt = growI32(b.varStmt, hir.nVarDecls);
  b.caseStmt = growI32(b.caseStmt, hir.nCases);
  b.classOwnerTag = growU8(b.classOwnerTag, hir.nClasses);
  b.classOwnerA = growI32(b.classOwnerA, hir.nClasses);
  b.enumMemberOwner = growI32(b.enumMemberOwner, hir.nEnumMembers);
  b.fnOwnerTag = growU8(b.fnOwnerTag, hir.nFns);
  b.fnOwnerA = growI32(b.fnOwnerA, hir.nFns);
  b.classReached = growU8(b.classReached, hir.nClasses);
  b.typeReached = growU8(b.typeReached, hir.nTypes);
  b.typeParamReached = growU8(b.typeParamReached, hir.nTypeParams);
  b.exprParentTag.fill(0, 0, ne);
  b.exprParentA.fill(-1, 0, ne);
  b.stmtParentTag.fill(0, 0, ns);
  b.stmtParentA.fill(-1, 0, ns);
  b.patParentTag.fill(0, 0, np);
  b.patParentA.fill(-1, 0, np);
  b.patParentB.fill(-1, 0, np);
  b.propOwner.fill(-1, 0, hir.nProps);
  b.memberOwnerTag.fill(0, 0, nm);
  b.memberOwnerA.fill(-1, 0, nm);
  b.paramFn.fill(-1, 0, hir.nParams);
  b.varStmt.fill(-1, 0, hir.nVarDecls);
  b.caseStmt.fill(-1, 0, hir.nCases);
  b.classOwnerTag.fill(0, 0, hir.nClasses);
  b.classOwnerA.fill(-1, 0, hir.nClasses);
  b.enumMemberOwner.fill(-1, 0, hir.nEnumMembers);
  b.fnOwnerTag.fill(0, 0, hir.nFns);
  b.fnOwnerA.fill(-1, 0, hir.nFns);
  b.classReached.fill(0, 0, hir.nClasses);
  b.typeReached.fill(0, 0, hir.nTypes);
  b.typeParamReached.fill(0, 0, hir.nTypeParams);
  b.typeQueryOperandsLen = 0;
  SAVED[0] = 0;
}

// ───────────── small setters (`set!`): an id that is NONE is the index of nothing ─────────────

function setExprParent(e: number, tag: number, a: number): void {
  if (e >= 0) {
    bound.exprParentTag[e] = tag;
    bound.exprParentA[e] = a | 0;
  }
}
function setStmtParent(s: number, tag: number, a: number): void {
  if (s >= 0) {
    bound.stmtParentTag[s] = tag;
    bound.stmtParentA[s] = a | 0;
  }
}
function setType(t: number): void {
  if (t >= 0) bound.typeReached[t] = 1;
}
function setTypes(start: number, len: number): void {
  const ids = hir.ids;
  for (let i = 0; i < len; i++) setType(ids[(start + i) | 0] | 0);
}
function setTypeParams(start: number, len: number): void {
  const ids = hir.ids;
  for (let i = 0; i < len; i++) {
    const p = ids[(start + i) | 0] | 0;
    if (p < 0) continue;
    bound.typeParamReached[p] = 1;
    setType(hir.typeParamConstraint[p] | 0);
    setType(hir.typeParamDefault[p] | 0);
  }
}
/** `decorators!`: every decorator among the modifiers `(start, len)` gets the parent `(tag, a)`. */
function setDecorators(start: number, len: number, tag: number, a: number): void {
  const ids = hir.ids;
  for (let i = 0; i < len; i++) {
    const m = ids[(start + i) | 0] | 0;
    if ((hir.modifierKind[m] | 0) === MODK_DECORATOR) setExprParent(hir.modifierValue[m] | 0, tag, a);
  }
}
function setList(start: number, len: number, tag: number, a: number): void {
  const ids = hir.ids;
  for (let i = 0; i < len; i++) setExprParent(ids[(start + i) | 0] | 0, tag, a);
}
/** `props!` of an object literal `id` or the attributes of a JSX element. */
function setProps(start: number, len: number, id: number): void {
  const ids = hir.ids;
  for (let i = 0; i < len; i++) {
    const p = ids[(start + i) | 0] | 0;
    if (p < 0) continue;
    bound.propOwner[p] = id;
    setExprParent(hir.propValue[p] | 0, P_PROP, p);
    if ((hir.propKeyKind[p] | 0) === PK_COMPUTED) setExprParent(hir.propKeyVal[p] | 0, P_PROP, p);
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
  const a = bound.typeQueryOperands;
  const n = bound.typeQueryOperandsLen | 0;
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
  bound.typeQueryOperandsLen = w;
}

/** Whether `e` is the operand of a `typeof` in a type: binary search of `typeQueryOperands`. */
export function isTypeQueryOperand(e: number): boolean {
  const a = bound.typeQueryOperands;
  let lo = 0;
  let hi = bound.typeQueryOperandsLen | 0;
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
  const b = bound;
  const ids = hir.ids;

  // The expressions come first. What the parser has left behind are expressions, like the `A<T>` of `extends A<T>` and the
  // `a = 1` of `({ a = 1 }) => 0`, whose operands are part of something that is not an expression. Of two expressions, the one
  // that is made later is the one that is kept.
  const ne = hir.nExprs | 0;
  for (let id = 0; id < ne; id++) {
    const tag = hir.exprTag[id] | 0;
    switch (tag) {
      case EXPR_DOT:
        setExprParent(hir.exprA[id] | 0, P_EXPR, id);
        break;
      case EXPR_INDEX:
        setExprParent(hir.exprA[id] | 0, P_EXPR, id);
        setExprParent(hir.exprB[id] | 0, P_EXPR, id);
        break;
      case EXPR_CALL:
      case EXPR_NEW:
      case EXPR_TAGGED_TEMPLATE: {
        const c = hir.exprA[id] | 0;
        if (c >= 0) {
          setExprParent(hir.callCallee[c] | 0, P_EXPR, id);
          setExprParent(hir.callTemplate[c] | 0, P_EXPR, id);
          setList(hir.callArgsStart[c] | 0, hir.callArgsLen[c] | 0, P_EXPR, id);
          setTypes(hir.callTypeArgsStart[c] | 0, hir.callTypeArgsLen[c] | 0);
        }
        break;
      }
      case EXPR_TEMPLATE:
      case EXPR_ARRAY:
        setList(hir.exprA[id] | 0, hir.exprB[id] | 0, P_EXPR, id);
        break;
      case EXPR_IMPORT_CALL: {
        const start = hir.exprA[id] | 0;
        const len = hir.exprB[id] | 0;
        setList(start, len, P_EXPR, id);
        if (hir.importCallTypeArgsLen > 0 && len > 0) {
          const row = importCallTypeArgsRow(ids[start] | 0);
          if (row >= 0) setTypes(hir.importCallTypeArgs[row + 1] | 0, hir.importCallTypeArgs[row + 2] | 0);
        }
        break;
      }
      case EXPR_OBJECT:
        setProps(hir.exprA[id] | 0, hir.exprB[id] | 0, id);
        break;
      case EXPR_FN: {
        const f = hir.exprA[id] | 0;
        if (f >= 0) {
          b.fnOwnerTag[f] = FO_EXPR;
          b.fnOwnerA[f] = id;
        }
        break;
      }
      case EXPR_CLASS: {
        const c = hir.exprA[id] | 0;
        if (c >= 0) {
          b.classOwnerTag[c] = CO_EXPR;
          b.classOwnerA[c] = id;
          b.classReached[c] = 1;
        }
        break;
      }
      case EXPR_BINARY:
      case EXPR_ASSIGN:
        setExprParent(hir.exprA[id] | 0, P_EXPR, id);
        setExprParent(hir.exprB[id] | 0, P_EXPR, id);
        break;
      case EXPR_COND:
        setExprParent(hir.exprA[id] | 0, P_EXPR, id);
        setExprParent(hir.exprB[id] | 0, P_EXPR, id);
        setExprParent(hir.exprC[id] | 0, P_EXPR, id);
        break;
      case EXPR_UNARY:
      case EXPR_SPREAD:
      case EXPR_AWAIT:
      case EXPR_AS_CONST:
      case EXPR_NON_NULL:
      case EXPR_YIELD:
        setExprParent(hir.exprA[id] | 0, P_EXPR, id);
        break;
      case EXPR_AS:
      case EXPR_SATISFIES:
        setExprParent(hir.exprA[id] | 0, P_EXPR, id);
        setType(hir.exprB[id] | 0);
        break;
      case EXPR_INSTANTIATION:
        setExprParent(hir.exprA[id] | 0, P_EXPR, id);
        setTypes(hir.exprB[id] | 0, hir.exprC[id] | 0);
        break;
      case EXPR_JSX: {
        const j = hir.exprA[id] | 0;
        if (j >= 0) {
          setExprParent(hir.jsxTag[j] | 0, P_EXPR, id);
          setExprParent(hir.jsxCloseTag[j] | 0, P_EXPR, id);
          setTypes(hir.jsxTypeArgsStart[j] | 0, hir.jsxTypeArgsLen[j] | 0);
          setProps(hir.jsxAttrsStart[j] | 0, hir.jsxAttrsLen[j] | 0, id);
          setList(hir.jsxChildrenStart[j] | 0, hir.jsxChildrenLen[j] | 0, P_EXPR, id);
        }
        break;
      }
      default:
        break;
    }
  }

  const nt = hir.nTypes | 0;
  for (let id = 0; id < nt; id++) {
    const tag = hir.typeTag[id] | 0;
    switch (tag) {
      // An error (typescript-estree refuses the file), which Rust hands to the binder: its expression is part of what the type is in.
      case TYPE_HERITAGE:
        setExprParent(hir.typeA[id] | 0, P_FILE, -1);
        setTypes(hir.typeB[id] | 0, hir.typeC[id] | 0);
        break;
      case TYPE_TYPEOF: {
        setTypes(hir.typeC[id] | 0, hir.typeD[id] | 0);
        const expr = hir.typeE[id] | 0;
        setExprParent(expr, P_FILE, -1);
        let at = expr;
        while (at >= 0 && at < ne) {
          pushTypeQueryOperand(at);
          if ((hir.exprTag[at] | 0) !== EXPR_DOT) break;
          at = hir.exprA[at] | 0;
        }
        break;
      }
      case TYPE_FN: {
        const f = hir.typeA[id] | 0;
        if (f >= 0) {
          b.fnOwnerTag[f] = FO_TYPE;
          b.fnOwnerA[f] = id;
        }
        break;
      }
      case TYPE_OBJECT: {
        const start = hir.typeA[id] | 0;
        const len = hir.typeB[id] | 0;
        for (let i = 0; i < len; i++) {
          const m = ids[(start + i) | 0] | 0;
          if (m >= 0) {
            b.memberOwnerTag[m] = MO_TYPE_LITERAL;
            b.memberOwnerA[m] = id;
          }
        }
        break;
      }
      case TYPE_MAPPED: {
        const mp = hir.typeA[id] | 0;
        if (mp >= 0) {
          const param = hir.mappedParam[mp] | 0;
          if (param >= 0) {
            b.typeParamReached[param] = 1;
            setType(hir.typeParamConstraint[param] | 0);
            setType(hir.typeParamDefault[param] | 0);
          }
          setType(hir.mappedNameTy[mp] | 0);
          setType(hir.mappedTy[mp] | 0);
          const start = hir.mappedMembersStart[mp] | 0;
          const len = hir.mappedMembersLen[mp] | 0;
          for (let i = 0; i < len; i++) {
            const m = ids[(start + i) | 0] | 0;
            if (m >= 0) {
              b.memberOwnerTag[m] = MO_TYPE_LITERAL;
              b.memberOwnerA[m] = id;
            }
          }
        }
        break;
      }
      case TYPE_REF:
        setTypes(hir.typeC[id] | 0, hir.typeD[id] | 0);
        break;
      case TYPE_IMPORT:
        setTypes(hir.typeD[id] | 0, hir.typeE[id] | 0);
        break;
      case TYPE_TEMPLATE:
      case TYPE_UNION:
      case TYPE_INTERSECTION:
        setTypes(hir.typeA[id] | 0, hir.typeB[id] | 0);
        break;
      case TYPE_ARRAY:
      case TYPE_KEYOF:
      case TYPE_READONLY:
      case TYPE_UNIQUE:
      case TYPE_JSDOC:
        setType(hir.typeA[id] | 0);
        break;
      case TYPE_PREDICATE:
        setType(hir.typeB[id] | 0);
        break;
      case TYPE_TUPLE: {
        const start = hir.typeA[id] | 0;
        const len = hir.typeB[id] | 0;
        for (let i = 0; i < len; i++) {
          const e = ids[(start + i) | 0] | 0;
          if (e < 0) continue;
          // Of `ty` and `written`, the one that contains the other.
          if ((hir.tupleElemMemberType[e] | 0) === TM_OPTIONAL) setType(hir.tupleElemTy[e] | 0);
          else setType(hir.tupleElemWritten[e] | 0);
        }
        break;
      }
      case TYPE_COND:
        setType(hir.typeA[id] | 0);
        setType(hir.typeB[id] | 0);
        setType(hir.typeC[id] | 0);
        setType(hir.typeD[id] | 0);
        break;
      case TYPE_INDEXED_ACCESS:
        setType(hir.typeA[id] | 0);
        setType(hir.typeB[id] | 0);
        break;
      // Not its default.
      case TYPE_INFER: {
        const p = hir.typeA[id] | 0;
        if (p >= 0) {
          b.typeParamReached[p] = 1;
          setType(hir.typeParamConstraint[p] | 0);
        }
        break;
      }
      default:
        break;
    }
  }

  const na = hir.nAliases | 0;
  for (let i = 0; i < na; i++) {
    setTypeParams(hir.aliasTypeParamsStart[i] | 0, hir.aliasTypeParamsLen[i] | 0);
    setType(hir.aliasTy[i] | 0);
  }
  const ni = hir.nInterfaces | 0;
  for (let i = 0; i < ni; i++) {
    setTypeParams(hir.interfaceTypeParamsStart[i] | 0, hir.interfaceTypeParamsLen[i] | 0);
    setTypes(hir.interfaceExtendsStart[i] | 0, hir.interfaceExtendsLen[i] | 0);
    setTypes(hir.interfaceOtherHeritageStart[i] | 0, hir.interfaceOtherHeritageLen[i] | 0);
    const start = hir.interfaceMembersStart[i] | 0;
    const len = hir.interfaceMembersLen[i] | 0;
    for (let k = 0; k < len; k++) {
      const m = ids[(start + k) | 0] | 0;
      if (m >= 0) {
        b.memberOwnerTag[m] = MO_INTERFACE;
        b.memberOwnerA[m] = i;
      }
    }
  }
  const nc = hir.nClasses | 0;
  for (let id = 0; id < nc; id++) {
    setDecorators(hir.classModStart[id] | 0, hir.classModLen[id] | 0, P_CLASS, id);
    setExprParent(hir.classExtends[id] | 0, P_CLASS, id);
    setList(hir.classOtherExtendsStart[id] | 0, hir.classOtherExtendsLen[id] | 0, P_CLASS, id);
    setTypeParams(hir.classTypeParamsStart[id] | 0, hir.classTypeParamsLen[id] | 0);
    setTypes(hir.classExtendsArgsStart[id] | 0, hir.classExtendsArgsLen[id] | 0);
    setTypes(hir.classImplementsStart[id] | 0, hir.classImplementsLen[id] | 0);
    setTypes(hir.classOtherImplementsStart[id] | 0, hir.classOtherImplementsLen[id] | 0);
    const start = hir.classMembersStart[id] | 0;
    const len = hir.classMembersLen[id] | 0;
    for (let k = 0; k < len; k++) {
      const m = ids[(start + k) | 0] | 0;
      if (m >= 0) {
        b.memberOwnerTag[m] = MO_CLASS;
        b.memberOwnerA[m] = id;
      }
    }
  }
  const nm = hir.nMembers | 0;
  for (let id = 0; id < nm; id++) {
    if ((b.memberOwnerTag[id] | 0) === MO_CLASS) {
      setDecorators(hir.memberModStart[id] | 0, hir.memberModLen[id] | 0, P_MEMBER, id);
    }
    if ((hir.memberKeyKind[id] | 0) === PK_COMPUTED) setExprParent(hir.memberKeyVal[id] | 0, P_MEMBER, id);
    const f = hir.memberFunc[id] | 0;
    if (f >= 0) {
      b.fnOwnerTag[f] = FO_MEMBER;
      b.fnOwnerA[f] = id;
    }
    setExprParent(hir.memberInit[id] | 0, P_MEMBER, id);
    setType(hir.memberTy[id] | 0);
  }

  const ns = hir.nStmts | 0;
  for (let id = 0; id < ns; id++) {
    const tag = hir.stmtTag[id] | 0;
    if ((hir.stmtModLen[id] | 0) !== 0 && tag !== STMT_CLASS) {
      setDecorators(hir.stmtModStart[id] | 0, hir.stmtModLen[id] | 0, P_STMT, id);
    }
    switch (tag) {
      case STMT_RETURN:
      case STMT_EXPR:
      case STMT_THROW:
      case STMT_EXPORT_DEFAULT:
      case STMT_EXPORT_ASSIGN:
        setExprParent(hir.stmtA[id] | 0, P_STMT, id);
        break;
      case STMT_VAR: {
        const start = hir.stmtA[id] | 0;
        const len = hir.stmtB[id] | 0;
        for (let i = 0; i < len; i++) {
          const d = ids[(start + i) | 0] | 0;
          if (d >= 0) b.varStmt[d] = id;
        }
        break;
      }
      case STMT_FN: {
        const f = hir.stmtA[id] | 0;
        if (f >= 0) {
          b.fnOwnerTag[f] = FO_STMT;
          b.fnOwnerA[f] = id;
        }
        break;
      }
      case STMT_CLASS: {
        const c = hir.stmtA[id] | 0;
        if (c >= 0) {
          b.classOwnerTag[c] = CO_STMT;
          b.classOwnerA[c] = id;
          b.classReached[c] = 1;
        }
        break;
      }
      case STMT_IF:
        setExprParent(hir.stmtA[id] | 0, P_STMT, id);
        setStmtParent(hir.stmtB[id] | 0, P_STMT, id);
        setStmtParent(hir.stmtC[id] | 0, P_STMT, id);
        break;
      case STMT_WHILE:
        setExprParent(hir.stmtA[id] | 0, P_STMT, id);
        setStmtParent(hir.stmtB[id] | 0, P_STMT, id);
        break;
      case STMT_DO_WHILE:
        setExprParent(hir.stmtB[id] | 0, P_STMT, id);
        setStmtParent(hir.stmtA[id] | 0, P_STMT, id);
        break;
      case STMT_FOR:
        setExprParent(hir.stmtB[id] | 0, P_STMT, id);
        setExprParent(hir.stmtC[id] | 0, P_STMT, id);
        setStmtParent(hir.stmtA[id] | 0, P_STMT, id);
        setStmtParent(hir.stmtD[id] | 0, P_STMT, id);
        break;
      case STMT_FOR_IN:
      case STMT_FOR_OF:
        setExprParent(hir.stmtB[id] | 0, P_STMT, id);
        setStmtParent(hir.stmtA[id] | 0, P_STMT, id);
        setStmtParent(hir.stmtC[id] | 0, P_STMT, id);
        break;
      case STMT_BLOCK: {
        const start = hir.stmtA[id] | 0;
        const len = hir.stmtB[id] | 0;
        for (let i = 0; i < len; i++) setStmtParent(ids[(start + i) | 0] | 0, P_STMT, id);
        break;
      }
      case STMT_SWITCH: {
        setExprParent(hir.stmtA[id] | 0, P_STMT, id);
        const start = hir.stmtB[id] | 0;
        const len = hir.stmtC[id] | 0;
        for (let i = 0; i < len; i++) {
          const c = ids[(start + i) | 0] | 0;
          if (c < 0) continue;
          b.caseStmt[c] = id;
          setExprParent(hir.caseTest[c] | 0, P_CASE, c);
          const bs = hir.caseBodyStart[c] | 0;
          const bl = hir.caseBodyLen[c] | 0;
          for (let k = 0; k < bl; k++) setStmtParent(ids[(bs + k) | 0] | 0, P_STMT, id);
        }
        break;
      }
      case STMT_TRY: {
        const param = hir.stmtB[id] | 0;
        if (param >= 0) b.varStmt[param] = id;
        setStmtParent(hir.stmtA[id] | 0, P_STMT, id);
        setStmtParent(hir.stmtC[id] | 0, P_STMT, id);
        setStmtParent(hir.stmtD[id] | 0, P_STMT, id);
        break;
      }
      case STMT_LABELED:
        setStmtParent(hir.stmtB[id] | 0, P_STMT, id);
        break;
      case STMT_IMPORT_EQUALS: {
        const ie = hir.stmtA[id] | 0;
        if (ie >= 0) setExprParent(hir.importEqualsExpression[ie] | 0, P_STMT, id);
        break;
      }
      default:
        break;
    }
  }

  const nf = hir.nFns | 0;
  for (let id = 0; id < nf; id++) {
    const thisParam = hir.fnThisParam[id] | 0;
    if (thisParam >= 0) b.paramFn[thisParam] = id;
    setTypeParams(hir.fnTypeParamsStart[id] | 0, hir.fnTypeParamsLen[id] | 0);
    setType(hir.fnRet[id] | 0);
    if (thisParam >= 0) setType(hir.paramTy[thisParam] | 0);
    // The decorators of a parameter of a member of a class are evaluated with the class.
    let hasClass = false;
    if ((b.fnOwnerTag[id] | 0) === FO_MEMBER) {
      const m = b.fnOwnerA[id] | 0;
      if (m >= 0 && m < nm && (b.memberOwnerTag[m] | 0) === MO_CLASS) hasClass = true;
    }
    const ps = hir.fnParamsStart[id] | 0;
    const pl = hir.fnParamsLen[id] | 0;
    for (let i = 0; i < pl; i++) {
      const p = ids[(ps + i) | 0] | 0;
      if (p < 0) continue;
      b.paramFn[p] = id;
      const pat = hir.paramPat[p] | 0;
      if (pat >= 0) {
        b.patParentTag[pat] = PP_PARAM;
        b.patParentA[pat] = p;
      }
      setType(hir.paramTy[p] | 0);
      setExprParent(hir.paramDefault[p] | 0, P_PARAM, p);
      if (hasClass) setDecorators(hir.paramModStart[p] | 0, hir.paramModLen[p] | 0, P_PARAM, p);
      else setDecorators(hir.paramModStart[p] | 0, hir.paramModLen[p] | 0, P_FN_BODY, id);
    }
    const bk = hir.fnBodyKind[id] | 0;
    if (bk === BODY_EXPR) {
      setExprParent(hir.fnBodyA[id] | 0, P_FN_BODY, id);
    } else if (bk === BODY_BLOCK) {
      const bs = hir.fnBodyA[id] | 0;
      const bl = hir.fnBodyB[id] | 0;
      for (let i = 0; i < bl; i++) setStmtParent(ids[(bs + i) | 0] | 0, P_FN_BODY, id);
    }
  }

  // `fill_of_var_decls`
  const nv = hir.nVarDecls | 0;
  for (let id = 0; id < nv; id++) {
    const pat = hir.varDeclPat[id] | 0;
    if (pat >= 0) {
      b.patParentTag[pat] = PP_VAR;
      b.patParentA[pat] = id;
    }
    setExprParent(hir.varDeclInit[id] | 0, P_VAR_INIT, id);
    setType(hir.varDeclTy[id] | 0);
  }

  const np = hir.nPats | 0;
  for (let id = 0; id < np; id++) {
    const tag = hir.patTag[id] | 0;
    if (tag === PAT_OBJECT) {
      const start = hir.patA[id] | 0;
      const len = hir.patB[id] | 0;
      for (let i = 0; i < len; i++) {
        const p = ids[(start + i) | 0] | 0;
        if (p < 0) continue;
        if ((hir.patPropKeyKind[p] | 0) === PK_COMPUTED) setExprParent(hir.patPropKeyVal[p] | 0, P_PAT_PROP, p);
        setExprParent(hir.patPropDefault[p] | 0, P_PAT_PROP, p);
        const v = hir.patPropValue[p] | 0;
        if (v >= 0) {
          b.patParentTag[v] = PP_PROP;
          b.patParentA[v] = p;
          b.patParentB[v] = id;
        }
      }
    } else if (tag === PAT_ARRAY) {
      const start = hir.patA[id] | 0;
      const len = hir.patB[id] | 0;
      for (let i = 0; i < len; i++) {
        const e = ids[(start + i) | 0] | 0;
        if (e < 0) continue;
        setExprParent(hir.patElemDefault[e] | 0, P_PAT_ELEM, e);
        const pat = hir.patElemPat[e] | 0;
        if (pat >= 0) {
          b.patParentTag[pat] = PP_ELEM;
          b.patParentA[pat] = e;
          b.patParentB[pat] = id;
        }
      }
    }
  }
  const nen = hir.nEnums | 0;
  for (let i = 0; i < nen; i++) {
    const start = hir.enumMembersStart[i] | 0;
    const len = hir.enumMembersLen[i] | 0;
    for (let k = 0; k < len; k++) {
      const m = ids[(start + k) | 0] | 0;
      if (m < 0) continue;
      b.enumMemberOwner[m] = i;
      setExprParent(hir.enumMemberComputedName[m] | 0, P_ENUM_MEMBER, m);
      setExprParent(hir.enumMemberInit[m] | 0, P_ENUM_MEMBER, m);
    }
  }
  const nmod = hir.nModules | 0;
  for (let i = 0; i < nmod; i++) {
    const start = hir.moduleBodyStart[i] | 0;
    const len = hir.moduleBodyLen[i] | 0;
    for (let k = 0; k < len; k++) setStmtParent(ids[(start + k) | 0] | 0, P_MODULE, i);
  }
  {
    const start = hir.bodyStart | 0;
    const len = hir.bodyLen | 0;
    for (let k = 0; k < len; k++) setStmtParent(ids[(start + k) | 0] | 0, P_FILE, -1);
  }
  for (let i = 0; i < hir.importAttributesLen; i += 2) setExprParent(hir.importAttributes[i + 1] | 0, P_FILE, -1);
  for (let i = 0; i < hir.specifierExpressionsLen; i++) setExprParent(hir.specifierExpressions[i] | 0, P_FILE, -1);
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
  const ne = hir.nExprs | 0;
  for (let i = 0; i < ne; i++) orphan = orphan | (((b.exprParentTag[i] | 0) === P_NONE) ? 1 : 0);
  const ns = hir.nStmts | 0;
  for (let i = 0; i < ns; i++) orphan = orphan | (((b.stmtParentTag[i] | 0) === P_NONE) ? 1 : 0);
  if (orphan !== 0) return false;
  const nf = hir.nFns | 0;
  for (let i = 0; i < nf; i++) if ((b.fnOwnerTag[i] | 0) === FO_NONE) return false;
  const nc = hir.nClasses | 0;
  for (let i = 0; i < nc; i++) if ((b.classOwnerTag[i] | 0) === CO_NONE) return false;
  const nt = hir.nTypes | 0;
  for (let i = 0; i < nt; i++) if ((b.typeReached[i] | 0) === 0) return false;
  const ntp = hir.nTypeParams | 0;
  for (let i = 0; i < ntp; i++) if ((b.typeParamReached[i] | 0) === 0) return false;
  return true;
}
