// Port of vendor/bun/src/lint/ast/node.rs: any node, and the way up from it.
//
// THE NODE ENCODING. Rust's `Node` enum (and `Packed`) unifies the handle kinds; here a `Node` is ONE Int32:
//
//     node = (kind << 26) | id          kind = node >> 26 (N_*)      id = node & NODE_ID_MASK
//
// `NODE_FILE = 0` (kind N_FILE, id 0) is `Node::File`; `NONE = -1` is `Option<Node>::None`. The kinds are the variants of the Rust
// enum, in its order. An id is a row index of its table, so a file may have up to 2^26 - 1 rows of any one kind (the parser
// refuses larger sources: `fileBegin` does not check). Equal nodes are equal numbers (`Node ==`).
//
//   Rust                                  TS
//   Node::Expr(e)                         nodeOfExpr(e)            (and nodeOfStmt, nodeOfType, ... one per kind)
//   match node { Node::Expr(e) => .. }    switch (nodeKind(n)) { case N_EXPR: { const e = nodeId(n); .. } }
//   node.as_expr()  /  .as_stmt() ..      nodeAsExpr(n) -> ExprId or -1  (nodeAsStmt, nodeAsType, nodeAsFunc)
//   node.parent()                         nodeParent(n)       (File is its own parent)
//   node.ancestors()                      for (let a = nodeParent(n); ; a = nodeParent(a)) { ..; if (a === NODE_FILE) break; }
//                                         (the iterator yields the parents up to and INCLUDING the file)
//   node.span() / node.text()             nodeSpan(n) -> SP ; the text is hir.text[SP[0] .. SP[1])
//   node.as_written()                     nodeAsWritten(n)
//   node.enclosing_function()             nodeEnclosingFunction(n) -> FnId or -1
//   node.enclosing_class()                nodeEnclosingClass(n)    -> ClassId or -1
import {
  EXPR_CALL,
  EXPR_JSX,
  EXPR_NEW,
  EXPR_TAGGED_TEMPLATE,
  EXPR_AS,
  EXPR_INSTANTIATION,
  EXPR_SATISFIES,
  STMT_BLOCK,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_EXPR,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IMPORT,
  STMT_SWITCH,
  TYPE_ARRAY,
  TYPE_COND,
  TYPE_HERITAGE,
  TYPE_IMPORT,
  TYPE_INDEXED_ACCESS,
  TYPE_INFER,
  TYPE_INTERSECTION,
  TYPE_JSDOC,
  TYPE_KEYOF,
  TYPE_MAPPED,
  TYPE_PREDICATE,
  TYPE_READONLY,
  TYPE_REF,
  TYPE_TEMPLATE,
  TYPE_TUPLE,
  TYPE_TYPEOF,
  TYPE_UNION,
  TYPE_UNIQUE,
  hir,
} from "../../sema/hir.ts";
import { isNestedNamespace } from "../../sema/hir_util.ts";
import {
  MO_CLASS,
  MO_INTERFACE,
  MO_TYPE_LITERAL,
  P_CASE,
  P_CLASS,
  P_ENUM_MEMBER,
  P_EXPR,
  P_FILE,
  P_FN_BODY,
  P_MEMBER,
  P_MODULE,
  P_NONE,
  P_PARAM,
  P_PAT_ELEM,
  P_PAT_PROP,
  P_PROP,
  P_STMT,
  P_VAR_INIT,
  PP_ELEM,
  PP_PARAM,
  PP_PROP,
  PP_VAR,
  bound,
  isTypeQueryOperand,
} from "../../sema/bind/parents.ts";
import { SP } from "../span.ts";
import { I32Vec } from "../../sema/vec.ts";
import { TP } from "./state.ts";
import { classOwner, funcOwner } from "./decl.ts";
import { paramFuncOf } from "./decl.ts";
import { memberSpan, propSpan, enumMemberSpan, classSpan, funcSpan, paramSpan, typeParamSpan, importSpecSpan, exportSpecSpan } from "./decl.ts";
import { caseSpan, varDeclSpan } from "./stmt.ts";
import { exprSpan } from "./expr.ts";
import { stmtSpan, stmtWrappedIn } from "./stmt.ts";
import { typeSpan, tupleElemSpan } from "./ty.ts";
import { patSpan, patPropSpan, patElemSpan } from "./pat.ts";
import { listAroundCase } from "./list.ts";

// `Node` kinds
export const N_FILE: number = 0;
export const N_EXPR: number = 1;
export const N_STMT: number = 2;
export const N_TYPE: number = 3;
export const N_PAT: number = 4;
export const N_PAT_PROP: number = 5;
export const N_PAT_ELEM: number = 6;
export const N_FUNC: number = 7;
export const N_PARAM: number = 8;
export const N_TYPE_PARAM: number = 9;
export const N_CLASS: number = 10;
export const N_MEMBER: number = 11;
export const N_PROP: number = 12;
export const N_VAR_DECL: number = 13;
export const N_CASE: number = 14;
export const N_ENUM_MEMBER: number = 15;
export const N_IMPORT_SPEC: number = 16;
export const N_EXPORT_SPEC: number = 17;
export const N_TUPLE_ELEM: number = 18;

export const NODE_KIND_SHIFT: number = 26;
export const NODE_ID_MASK: number = 67108863;
/** `Node::File`. */
export const NODE_FILE: number = 0;

export function nodeKind(n: number): number {
  return n >> 26;
}
export function nodeId(n: number): number {
  return n & 67108863;
}
/** `Node` of the kind `kind` and the row `id`. */
export function nodeOf(kind: number, id: number): number {
  return (kind << 26) | id;
}
export function nodeOfExpr(e: number): number { return (1 << 26) | e; }
export function nodeOfStmt(s: number): number { return (2 << 26) | s; }
export function nodeOfType(t: number): number { return (3 << 26) | t; }
export function nodeOfPat(p: number): number { return (4 << 26) | p; }
export function nodeOfPatProp(p: number): number { return (5 << 26) | p; }
export function nodeOfPatElem(p: number): number { return (6 << 26) | p; }
export function nodeOfFunc(f: number): number { return (7 << 26) | f; }
export function nodeOfParam(p: number): number { return (8 << 26) | p; }
export function nodeOfTypeParam(p: number): number { return (9 << 26) | p; }
export function nodeOfClass(c: number): number { return (10 << 26) | c; }
export function nodeOfMember(m: number): number { return (11 << 26) | m; }
export function nodeOfProp(p: number): number { return (12 << 26) | p; }
export function nodeOfVarDecl(d: number): number { return (13 << 26) | d; }
export function nodeOfCase(c: number): number { return (14 << 26) | c; }
export function nodeOfEnumMember(m: number): number { return (15 << 26) | m; }
export function nodeOfImportSpec(s: number): number { return (16 << 26) | s; }
export function nodeOfExportSpec(s: number): number { return (17 << 26) | s; }
export function nodeOfTupleElem(e: number): number { return (18 << 26) | e; }

/** The id if `n` is of kind `kind`, else -1 (`Node::as_expr`, ..). */
export function nodeAsKind(n: number, kind: number): number {
  return n >= 0 && n >> 26 === kind ? n & 67108863 : -1;
}
export function nodeAsExpr(n: number): number { return n >= 0 && n >> 26 === 1 ? n & 67108863 : -1; }
export function nodeAsStmt(n: number): number { return n >= 0 && n >> 26 === 2 ? n & 67108863 : -1; }
export function nodeAsType(n: number): number { return n >= 0 && n >> 26 === 3 ? n & 67108863 : -1; }
export function nodeAsFunc(n: number): number { return n >= 0 && n >> 26 === 7 ? n & 67108863 : -1; }
export function nodeIsExpr(n: number): boolean { return n >= 0 && n >> 26 === 1; }
export function nodeIsStmt(n: number): boolean { return n >= 0 && n >> 26 === 2; }
export function nodeIsFile(n: number): boolean { return n === 0; }

/** `Node::span` into `SP`: from its first token to the end of its last. Parentheses around an expression or a type are not part of it. */
export function nodeSpan(n: number): void {
  const id = n & 67108863;
  switch (n >> 26) {
    case N_FILE:
      SP[0] = 0;
      SP[1] = hir.sourceLen | 0;
      return;
    case N_EXPR: exprSpan(id); return;
    case N_STMT: stmtSpan(id); return;
    case N_TYPE: typeSpan(id); return;
    case N_PAT: patSpan(id); return;
    case N_PAT_PROP: patPropSpan(id); return;
    case N_PAT_ELEM: patElemSpan(id); return;
    case N_FUNC: funcSpan(id); return;
    case N_PARAM: paramSpan(id); return;
    case N_TYPE_PARAM: typeParamSpan(id); return;
    case N_CLASS: classSpan(id); return;
    case N_MEMBER: memberSpan(id); return;
    case N_PROP: propSpan(id); return;
    case N_VAR_DECL: varDeclSpan(id); return;
    case N_CASE: caseSpan(id); return;
    case N_ENUM_MEMBER: enumMemberSpan(id); return;
    case N_IMPORT_SPEC: importSpecSpan(id); return;
    case N_EXPORT_SPEC: exportSpecSpan(id); return;
    default: tupleElemSpan(id); return;
  }
}
export function nodeStart(n: number): number {
  nodeSpan(n);
  return SP[0] | 0;
}
export function nodeEnd(n: number): number {
  nodeSpan(n);
  return SP[1] | 0;
}

/** `Node::as_written`: the `Expr`, the `Stmt`, the `Member` or the `Prop` that a function or a class is written as. Any other node is itself. */
export function nodeAsWritten(n: number): number {
  const k = n >> 26;
  if (k === N_FUNC) return funcOwner(n & 67108863);
  if (k === N_CLASS) return classOwner(n & 67108863);
  return n;
}

// ───────────────────────────── parents ─────────────────────────────

/** `Node::parent`: what it is directly part of. The file is its own parent. */
export function nodeParent(n: number): number {
  const id = n & 67108863;
  switch (n >> 26) {
    case N_FILE:
      return n;
    case N_EXPR:
      return exprParent(id);
    case N_STMT:
      return stmtParent(id);
    default:
      return parentOfNeitherExprNorStmt(n >> 26, id);
  }
}

/** The node that the binder has as `parent`: `(tag, a)` of the tables of `bound`. */
function ofParent(tag: number, a: number): number {
  const hir$ = hir;
  const bound$ = bound;
  switch (tag) {
    case P_NONE:
    case P_FILE:
      return NODE_FILE;
    case P_EXPR:
      return nodeOfExpr(a);
    case P_STMT: {
      if ((hir$.stmtTag[a] | 0) === STMT_EXPR) {
        const w = stmtWrappedIn(a);
        return nodeOfStmt(w >= 0 ? w : a);
      }
      return nodeOfStmt(a);
    }
    case P_VAR_INIT:
      return nodeOfVarDecl(a);
    case P_PARAM:
      return nodeOfParam(a);
    case P_PAT_PROP:
      return nodeOfPatProp(a);
    case P_PAT_ELEM:
      return nodeOfPatElem(a);
    case P_PROP:
      if (isImportAttribute(a)) return ofImportAttribute(a);
      return nodeOfProp(a);
    case P_MEMBER:
      return nodeOfMember(a);
    case P_FN_BODY:
      return nodeOfFunc(a);
    case P_ENUM_MEMBER:
      return nodeOfEnumMember(a);
    case P_CASE:
      return nodeOfCase(a);
    case P_CLASS:
      return nodeOfClass(a);
    case P_MODULE: {
      let m = a;
      while (true) {
        if (m < 0 || m >= hir$.nModules) return NODE_FILE;
        const s = hir$.moduleStmt[m] | 0;
        // From the `C` of `namespace A.B.C` to the `A`.
        if (s >= 0 && (bound$.stmtParentTag[s] | 0) === P_MODULE && isNestedNamespace(s)) m = bound$.stmtParentA[s] | 0;
        else return s >= 0 ? nodeOfStmt(s) : NODE_FILE;
      }
    }
    default:
      return NODE_FILE;
  }
}

/** `Expr::parent`. */
export function exprParent(e: number): number {
  const b = bound;
  const tag = b.exprParentTag[e] | 0;
  const a = b.exprParentA[e] | 0;
  // The binder never has an expression as the parent of the `a.b` of the type `typeof a.b`.
  if (tag === P_EXPR) {
    if ((hir.exprTag[a] | 0) !== EXPR_TAGGED_TEMPLATE) return nodeOfExpr(a);
  }
  return exprParentInGeneral(e, tag, a);
}

/** What most expressions are part of that are not part of an expression. */
function exprParentInGeneral(e: number, tag: number, a: number): number {
  const h = hir;
  const isInNoType = bound.typeQueryOperandsLen === 0;
  switch (tag) {
    case P_VAR_INIT:
      return nodeOfVarDecl(a);
    case P_PROP:
      if (h.importAttributesLen === 0) return nodeOfProp(a);
      break;
    case P_STMT:
      if ((h.stmtTag[a] | 0) === STMT_EXPR) {
        if (isInNoType && isPlainlyNoWrapper(a)) return nodeOfStmt(a);
      } else {
        return nodeOfStmt(a);
      }
      break;
    case P_FN_BODY:
      if (isInNoType) return nodeOfFunc(a);
      break;
    case P_MEMBER:
      if (isInNoType) return nodeOfMember(a);
      break;
    default:
      break;
  }
  return exprParentInRareCases(e, tag, a);
}

function exprParentInRareCases(e: number, tag: number, a: number): number {
  // Few files have a `typeof` in a type.
  if (bound.typeQueryOperandsLen > 0 && isTypeQueryOperand(e)) {
    const ty = typeOfTypeQueryOperand(e);
    if (ty >= 0) return nodeOfType(ty);
  }
  const hir$ = hir;
  if (tag === P_EXPR) {
    // The substitutions of a tagged template are in the template.
    if ((hir$.exprTag[a] | 0) === EXPR_TAGGED_TEMPLATE) {
      const call = hir$.exprA[a] | 0;
      if (call >= 0) {
        const callee = hir$.callCallee[call] | 0;
        const template = hir$.callTemplate[call] | 0;
        if (callee !== e && template !== e) return nodeOfExpr(template);
      }
    }
    return nodeOfExpr(a);
  }
  return ofParent(tag, a);
}

/** `File::is_plainly_no_wrapper`: whether it shows from the kind of its parent that the expression statement `id` is not a wrapper. */
function isPlainlyNoWrapper(id: number): boolean {
  const bound$ = bound;
  if ((bound$.stmtParentTag[id] | 0) !== P_STMT) return true;
  const parent = bound$.stmtParentA[id] | 0;
  const hir$ = hir;
  const t = hir$.stmtTag[parent] | 0;
  if (t === STMT_FOR || t === STMT_FOR_IN || t === STMT_FOR_OF) return false;
  if (t === STMT_BLOCK) return hir$.withBodiesLen === 0;
  return true;
}

/** `Stmt::parent`. */
export function stmtParent(s: number): number {
  const bound$ = bound;
  const tag = bound$.stmtParentTag[s] | 0;
  const a = bound$.stmtParentA[s] | 0;
  if (tag === P_FN_BODY) return nodeOfFunc(a);
  const hir$ = hir;
  if (tag === P_STMT) {
    const t = hir$.stmtTag[a] | 0;
    if (t === STMT_BLOCK) return nodeOfStmt(a);
    if (t !== STMT_EXPR && t !== STMT_SWITCH) return nodeOfStmt(a);
  } else if (tag === P_FILE) {
    return NODE_FILE;
  }
  // `parent_in_rare_cases`
  const parent = ofParent(tag, a);
  if (nodeKind(parent) === N_STMT) {
    const p = nodeId(parent);
    if ((hir$.stmtTag[p] | 0) === STMT_SWITCH) {
      stmtSpan(s);
      const c = listAroundCase(hir$.stmtB[p] | 0, hir$.stmtC[p] | 0, SP[0] | 0);
      return c >= 0 ? nodeOfCase(c) : parent;
    }
  }
  return parent;
}

function stmtOrFile(s: number): number {
  return s >= 0 ? nodeOfStmt(s) : NODE_FILE;
}

function ownerOfPattern(inner: number): number {
  const bound$ = bound;
  if (inner >= 0) {
    const t = bound$.patParentTag[inner] | 0;
    if (t === PP_PROP || t === PP_ELEM) return nodeOfPat(bound$.patParentB[inner] | 0);
  }
  return NODE_FILE;
}

/** `Node::parent_of_any` for everything but an expression and a statement. */
function parentOfNeitherExprNorStmt(kind: number, id: number): number {
  const bound$ = bound;
  const hir$ = hir;
  switch (kind) {
    case N_PAT: {
      const t = bound$.patParentTag[id] | 0;
      const a = bound$.patParentA[id] | 0;
      if (t === PP_VAR) return nodeOfVarDecl(a);
      if (t === PP_PARAM) return nodeOfParam(a);
      if (t === PP_PROP) return nodeOfPatProp(a);
      if (t === PP_ELEM) return nodeOfPatElem(a);
      return parentThatTheBinderHasNot(kind, id);
    }
    case N_PAT_PROP:
      return ownerOfPattern(hir$.patPropValue[id] | 0);
    case N_PAT_ELEM:
      return ownerOfPattern(hir$.patElemPat[id] | 0);
    case N_FUNC:
      return funcOwner(id);
    case N_CLASS:
      return classOwner(id);
    case N_PARAM: {
      const f = paramFuncOf(id);
      return f >= 0 ? nodeOfFunc(f) : NODE_FILE;
    }
    case N_MEMBER:
      return memberParent(id);
    case N_PROP:
      if (hir$.importAttributesLen !== 0) return parentThatTheBinderHasNot(kind, id);
      return propOwnerNode(id);
    case N_VAR_DECL:
      return stmtOrFile(bound$.varStmt[id] | 0);
    case N_CASE:
      return stmtOrFile(bound$.caseStmt[id] | 0);
    case N_ENUM_MEMBER: {
      const en = bound$.enumMemberOwner[id] | 0;
      return en >= 0 ? stmtOrFile(hir$.enumStmt[en] | 0) : NODE_FILE;
    }
    case N_IMPORT_SPEC:
      return stmtOrFile(hir$.importStmt[hir$.importSpecImport[id] | 0] | 0);
    case N_EXPORT_SPEC:
      return stmtOrFile(hir$.exportStmt[hir$.exportSpecExport[id] | 0] | 0);
    default:
      return parentThatTheBinderHasNot(kind, id);
  }
}

function propOwnerNode(p: number): number {
  const owner = bound.propOwner[p] | 0;
  return owner >= 0 ? nodeOfExpr(owner) : NODE_FILE;
}

/** `Member::parent`: the `Class`, the `Stmt` of the interface, or the `TypeNode` of the type literal. */
export function memberParent(m: number): number {
  const bound$ = bound;
  const t = bound$.memberOwnerTag[m] | 0;
  const a = bound$.memberOwnerA[m] | 0;
  if (t === MO_CLASS) return nodeOfClass(a);
  if (t === MO_INTERFACE) return stmtOrFile(hir.interfaceStmt[a] | 0);
  if (t === MO_TYPE_LITERAL) return nodeOfType(a);
  return NODE_FILE;
}

/** The parent of type syntax, of the `this` of a `this` parameter, and of a property in a file with import attributes. */
function parentThatTheBinderHasNot(kind: number, id: number): number {
  buildTypeParents();
  switch (kind) {
    case N_TYPE:
      return TP.types[id] | 0;
    case N_TYPE_PARAM:
      return TP.typeParams[id] | 0;
    case N_TUPLE_ELEM:
      return TP.tupleElems[id] | 0;
    case N_PAT: {
      const p = ofThis(id);
      return p >= 0 ? nodeOfParam(p) : NODE_FILE;
    }
    case N_PROP:
      if (isImportAttribute(id)) return ofImportAttribute(id);
      return propOwnerNode(id);
    default:
      return NODE_FILE;
  }
}

/** The innermost function that contains it. A function does not contain itself. FnId or -1. */
export function nodeEnclosingFunction(n: number): number {
  let a = nodeParent(n);
  while (true) {
    if (nodeKind(a) === N_FUNC) return nodeId(a);
    if (a === NODE_FILE) return -1;
    a = nodeParent(a);
  }
}

/** The innermost class that contains it. ClassId or -1. */
export function nodeEnclosingClass(n: number): number {
  let a = nodeParent(n);
  while (true) {
    if (nodeKind(a) === N_CLASS) return nodeId(a);
    if (a === NODE_FILE) return -1;
    a = nodeParent(a);
  }
}

// ───────────────────────────── the parents that the binder does not record ─────────────────────────────

function growFill(a: Int32Array, n: number): Int32Array {
  let r = a;
  if (r.length < n) {
    let c = r.length < 64 ? 64 : r.length;
    while (c < n) c = c * 2;
    r = new Int32Array(c);
  }
  r.fill(0, 0, n);
  return r;
}

function oneType(child: number, parent: number): void {
  if (child >= 0) TP.types[child] = parent | 0;
}
function listTypes(start: number, len: number, parent: number): void {
  const hir$ = hir;
  for (let i = 0; i < len; i++) oneType(hir$.ids[(start + i) | 0] | 0, parent);
}
function oneTypeParam(p: number, parent: number): void {
  if (p >= 0) TP.typeParams[p] = parent | 0;
}
function listTypeParams(start: number, len: number, parent: number): void {
  const hir$ = hir;
  for (let i = 0; i < len; i++) oneTypeParam(hir$.ids[(start + i) | 0] | 0, parent);
}

function sortRows(v: I32Vec, width: number): void {
  // insertion sort of rows (key first); the rows come almost in order
  const d = v.data;
  const n = (v.len / width) | 0;
  for (let i = 1; i < n; i++) {
    const k = d[i * width] | 0;
    if ((d[(i - 1) * width] | 0) <= k) continue;
    const r1 = width > 1 ? d[i * width + 1] | 0 : 0;
    let j = i - 1;
    while (j >= 0 && (d[j * width] | 0) > k) {
      d[(j + 1) * width] = d[j * width] | 0;
      if (width > 1) d[(j + 1) * width + 1] = d[j * width + 1] | 0;
      j = j - 1;
    }
    d[(j + 1) * width] = k;
    if (width > 1) d[(j + 1) * width + 1] = r1;
  }
}

/** `Parents::new` */
export function buildTypeParents(): void {
  const TP$ = TP;
  if (TP$.built) return;
  TP$.built = true;
  const h = hir;
  const nt = h.nTypes | 0;
  TP$.types = growFill(TP$.types, nt);
  TP$.typeParams = growFill(TP$.typeParams, h.nTypeParams);
  TP$.tupleElems = growFill(TP$.tupleElems, h.nTupleElems);
  TP$.queryOperands.reset();
  TP$.thisNames.reset();
  TP$.hasErrors = false;
  const ids = h.ids;

  for (let i = 0; i < nt; i++) {
    const parent = nodeOfType(i);
    switch (h.typeTag[i] | 0) {
      case TYPE_HERITAGE:
        listTypes(h.typeB[i] | 0, h.typeC[i] | 0, parent);
        break;
      case TYPE_REF:
        listTypes(h.typeC[i] | 0, h.typeD[i] | 0, parent);
        break;
      case TYPE_IMPORT:
        listTypes(h.typeD[i] | 0, h.typeE[i] | 0, parent);
        break;
      case TYPE_TYPEOF:
        listTypes(h.typeC[i] | 0, h.typeD[i] | 0, parent);
        TP$.queryOperands.push2(h.typeE[i] | 0, i);
        break;
      case TYPE_TEMPLATE:
      case TYPE_UNION:
      case TYPE_INTERSECTION:
        listTypes(h.typeA[i] | 0, h.typeB[i] | 0, parent);
        break;
      case TYPE_ARRAY:
      case TYPE_KEYOF:
      case TYPE_READONLY:
      case TYPE_UNIQUE:
        oneType(h.typeA[i] | 0, parent);
        break;
      case TYPE_JSDOC:
        TP$.hasErrors = true;
        oneType(h.typeA[i] | 0, parent);
        break;
      case TYPE_PREDICATE:
        oneType(h.typeB[i] | 0, parent);
        break;
      case TYPE_TUPLE: {
        const start = h.typeA[i] | 0;
        const len = h.typeB[i] | 0;
        for (let k = 0; k < len; k++) {
          const e = ids[(start + k) | 0] | 0;
          if (e >= 0) TP$.tupleElems[e] = parent;
        }
        break;
      }
      case TYPE_COND:
        oneType(h.typeA[i] | 0, parent);
        oneType(h.typeB[i] | 0, parent);
        oneType(h.typeC[i] | 0, parent);
        oneType(h.typeD[i] | 0, parent);
        break;
      case TYPE_INDEXED_ACCESS:
        oneType(h.typeA[i] | 0, parent);
        oneType(h.typeB[i] | 0, parent);
        break;
      case TYPE_INFER:
        oneTypeParam(h.typeA[i] | 0, parent);
        break;
      case TYPE_MAPPED: {
        const m = h.typeA[i] | 0;
        if (m >= 0) {
          oneTypeParam(h.mappedParam[m] | 0, parent);
          oneType(h.mappedNameTy[m] | 0, parent);
          oneType(h.mappedTy[m] | 0, parent);
        }
        break;
      }
      default:
        break;
    }
  }
  for (let i = 0; i < h.nTupleElems; i++) {
    oneType(h.tupleElemTy[i] | 0, nodeOfTupleElem(i));
    oneType(h.tupleElemWritten[i] | 0, nodeOfTupleElem(i));
  }
  for (let i = 0; i < h.nTypeParams; i++) {
    oneType(h.typeParamConstraint[i] | 0, nodeOfTypeParam(i));
    oneType(h.typeParamDefault[i] | 0, nodeOfTypeParam(i));
  }
  for (let i = 0; i < h.nFns; i++) {
    oneType(h.fnRet[i] | 0, nodeOfFunc(i));
    listTypeParams(h.fnTypeParamsStart[i] | 0, h.fnTypeParamsLen[i] | 0, nodeOfFunc(i));
    const tp = h.fnThisParam[i] | 0;
    if (tp >= 0) TP$.thisNames.push2(h.paramPat[tp] | 0, tp);
  }
  sortRows(TP$.thisNames, 2);
  for (let i = 0; i < h.nParams; i++) oneType(h.paramTy[i] | 0, nodeOfParam(i));
  for (let i = 0; i < h.nVarDecls; i++) oneType(h.varDeclTy[i] | 0, nodeOfVarDecl(i));
  for (let i = 0; i < h.nMembers; i++) {
    if ((h.memberFunc[i] | 0) < 0) oneType(h.memberTy[i] | 0, nodeOfMember(i));
  }
  for (let i = 0; i < h.nClasses; i++) {
    const parent = nodeOfClass(i);
    listTypeParams(h.classTypeParamsStart[i] | 0, h.classTypeParamsLen[i] | 0, parent);
    listTypes(h.classExtendsArgsStart[i] | 0, h.classExtendsArgsLen[i] | 0, parent);
    listTypes(h.classImplementsStart[i] | 0, h.classImplementsLen[i] | 0, parent);
    listTypes(h.classOtherImplementsStart[i] | 0, h.classOtherImplementsLen[i] | 0, parent);
  }
  for (let i = 0; i < h.nInterfaces; i++) {
    const s = h.interfaceStmt[i] | 0;
    if (s < 0) continue;
    const parent = nodeOfStmt(s);
    listTypeParams(h.interfaceTypeParamsStart[i] | 0, h.interfaceTypeParamsLen[i] | 0, parent);
    listTypes(h.interfaceExtendsStart[i] | 0, h.interfaceExtendsLen[i] | 0, parent);
    listTypes(h.interfaceOtherHeritageStart[i] | 0, h.interfaceOtherHeritageLen[i] | 0, parent);
  }
  for (let i = 0; i < h.nAliases; i++) {
    const s = h.aliasStmt[i] | 0;
    if (s < 0) continue;
    const parent = nodeOfStmt(s);
    listTypeParams(h.aliasTypeParamsStart[i] | 0, h.aliasTypeParamsLen[i] | 0, parent);
    oneType(h.aliasTy[i] | 0, parent);
  }
  // Few expressions have a type in them. This goes through all of them, so what tells that from the expression alone comes first.
  const ne = h.nExprs | 0;
  const bound$ = bound;
  for (let i = 0; i < ne; i++) {
    const tag = h.exprTag[i] | 0;
    let ty = -1;
    let argsStart = 0;
    let argsLen = 0;
    if (tag === EXPR_AS || tag === EXPR_SATISFIES) {
      ty = h.exprB[i] | 0;
    } else if (tag === EXPR_INSTANTIATION) {
      argsStart = h.exprB[i] | 0;
      argsLen = h.exprC[i] | 0;
    } else if (tag === EXPR_CALL || tag === EXPR_NEW || tag === EXPR_TAGGED_TEMPLATE) {
      const c = h.exprA[i] | 0;
      if (c >= 0) {
        argsStart = h.callTypeArgsStart[c] | 0;
        argsLen = h.callTypeArgsLen[c] | 0;
      }
    } else if (tag === EXPR_JSX) {
      const j = h.exprA[i] | 0;
      if (j >= 0) {
        argsStart = h.jsxTypeArgsStart[j] | 0;
        argsLen = h.jsxTypeArgsLen[j] | 0;
      }
    } else {
      continue;
    }
    if (ty < 0 && argsLen === 0) continue;
    // What the parser has left behind can share its type arguments with a node.
    if ((bound$.exprParentTag[i] | 0) === P_NONE) continue;
    const parent = nodeOfExpr(i);
    oneType(ty, parent);
    listTypes(argsStart, argsLen, parent);
  }
  sortRows(TP$.queryOperands, 2);
  ownersOfImportAttributes();
}

/** The type whose `typeof` operand is `e` (an operand of `typeof`), or -1. */
function typeOfTypeQueryOperand(e: number): number {
  buildTypeParents();
  const TP$ = TP;
  const d = TP$.queryOperands.data;
  let lo = 0;
  let hi = (TP$.queryOperands.len / 2) | 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((d[mid * 2] | 0) < e) lo = mid + 1;
    else hi = mid;
  }
  if (lo < ((TP$.queryOperands.len / 2) | 0) && (d[lo * 2] | 0) === e) return d[lo * 2 + 1] | 0;
  return -1;
}

/** `Parents::of_this`: the parameter whose `this` pattern is `pat`, or -1. */
function ofThis(pat: number): number {
  const TP$ = TP;
  const d = TP$.thisNames.data;
  let lo = 0;
  const n = (TP$.thisNames.len / 2) | 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((d[mid * 2] | 0) < pat) lo = mid + 1;
    else hi = mid;
  }
  if (lo < n && (d[lo * 2] | 0) === pat) return d[lo * 2 + 1] | 0;
  return -1;
}

// ───────────────────────────── import attributes ─────────────────────────────

/** `File::index_of_import_attributes`: the row of `hir.importAttributes` whose `{ .. }` is `object`, or -1. */
export function importAttributesRowOfObject(object: number): number {
  const hir$ = hir;
  const n = (hir$.importAttributesLen / 2) | 0;
  if (n === 0 || object < 0) return -1;
  const start = hir$.exprPos[object] | 0;
  // partition_point(|it| it.0 < start) - 1
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((hir$.importAttributes[mid * 2] | 0) < start) lo = mid + 1;
    else hi = mid;
  }
  const row = lo - 1;
  if (row < 0) return -1;
  return (hir$.importAttributes[row * 2 + 1] | 0) === object ? row : -1;
}

/** `File::is_import_attribute`: the prop is a `key: "value"` of `with { .. }`, which is not a property of an object. */
export function isImportAttribute(prop: number): boolean {
  if (hir.importAttributesLen === 0) return false;
  const owner = bound.propOwner[prop] | 0;
  return owner >= 0 && importAttributesRowOfObject(owner) >= 0;
}

/** `File::is_import_attributes`: the object `{ .. }` of import attributes, which is not a node. */
export function isImportAttributesObject(object: number): boolean {
  return importAttributesRowOfObject(object) >= 0;
}

/** `Parents::of_import_attribute`: the import, the export or the import type that the attribute `prop` belongs to. */
function ofImportAttribute(prop: number): number {
  buildTypeParents();
  const object = bound.propOwner[prop] | 0;
  const row = object >= 0 ? importAttributesRowOfObject(object) : -1;
  if (row < 0) return NODE_FILE;
  return TP.importAttributes[row] | 0;
}

/** `ImportAttributes::index_within`: the first row whose keyword is in `[start, end)`, or -1. */
export function importAttributesIndexWithin(start: number, end: number): number {
  const hir$ = hir;
  const n = (hir$.importAttributesLen / 2) | 0;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((hir$.importAttributes[mid * 2] | 0) < start) lo = mid + 1;
    else hi = mid;
  }
  return lo < n && (hir$.importAttributes[lo * 2] | 0) < end ? lo : -1;
}

/**
 * `ImportAttributes::search_span_of_type`: where the keyword of the import type `t` may be, into `SP`, if it has options. The span starts after an
 * argument that isn't a string, which can have options of its own. Returns false for a type without options.
 */
export function importAttributesSearchSpanOfType(t: number): boolean {
  const hir$ = hir;
  if ((hir$.typeTag[t] | 0) !== TYPE_IMPORT) return false;
  if ((((hir$.typeAux[t] | 0) >> 3) & 3) === 0) return false;
  // The parser keeps the argument that is not a string in `args`.
  let argEnd = -1;
  if ((hir$.typeA[t] | 0) < 0 && (hir$.typeE[t] | 0) > 0) {
    const first = hir$.ids[hir$.typeD[t] | 0] | 0;
    if (first >= 0) argEnd = hir$.typeEnd[first] | 0;
  }
  SP[0] = argEnd >= 0 ? argEnd : hir$.typePos[t] | 0;
  SP[1] = hir$.typeEnd[t] | 0;
  return true;
}

function ownersOfImportAttributes(): void {
  const hir$ = hir;
  const n = (hir$.importAttributesLen / 2) | 0;
  const TP$ = TP;
  TP$.importAttributes = growFill(TP$.importAttributes, n);
  if (n === 0) return;
  // The first owner wins: a type in a JSDoc comment is parsed once for each node that it annotates.
  for (let i = 0; i < hir$.nTypes; i++) {
    if (importAttributesSearchSpanOfType(i)) {
      const row = importAttributesIndexWithin(SP[0] | 0, SP[1] | 0);
      if (row >= 0 && (TP$.importAttributes[row] | 0) === 0) TP$.importAttributes[row] = nodeOfType(i);
    }
  }
  for (let i = 0; i < hir$.nStmts; i++) {
    const t = hir$.stmtTag[i] | 0;
    if (t === STMT_IMPORT || t === STMT_EXPORT_NAMED || t === STMT_EXPORT_STAR) {
      const row = importAttributesIndexWithin(hir$.stmtStart[i] | 0, hir$.stmtLocEnd[i] | 0);
      if (row >= 0 && (TP$.importAttributes[row] | 0) === 0) TP$.importAttributes[row] = nodeOfStmt(i);
    }
  }
}

/** `File::is_in_type_that_is_an_error`: the type `t` is in a type that is an error with no children (`T?`). */
export function typeIsInError(t: number): boolean {
  buildTypeParents();
  const TP$ = TP;
  if (!TP$.hasErrors) return false;
  let at = t;
  const hir$ = hir;
  while (true) {
    const p = TP$.types[at] | 0;
    if (p <= 0 || nodeKind(p) !== N_TYPE) return false;
    at = nodeId(p);
    if ((hir$.typeTag[at] | 0) === TYPE_JSDOC) return true;
  }
}
