// Port of vendor/bun/src/lint/ast/walk.rs: the way down: the children of a node.
//
//   node.for_each_child(|c| ..)              nodeChildren(n, -1, out); for (let i = 0; i < out.len; i++) { const c = out.data[i] | 0; .. }
//   node.for_each_child_near(offset, |c| ..) nodeChildren(n, offset, out)
//   node.children()                          the same as for_each_child
//
// `out` is an I32Vec of Nodes (node.ts) that the caller owns; the children are APPENDED in source order (use a base index and truncate
// afterwards: `const base = out.len; nodeChildren(n, -1, out); ...; out.len = base;`). `near`: `-1` for no offset. With an offset a long list
// (more than 8 elements) gives only its last element that starts at or before `offset`: a binary search, so it takes the logarithm of the
// number of children.
//
// A Func is the only child of the expression or the statement that owns it, and a Class likewise. Left out are holes in arrays and array
// patterns, the empty `{}` of JSX, and the statements that are wrappers (what they wrap takes their place). Of `with { key: "value" }` only
// the values are nodes. The walk of Rust (`walk`, `Visitor`) is a loop over this: there is no callback API here.
import {
  BODY_BLOCK,
  BODY_EXPR,
  EXPR_ARRAY,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_ASSIGN,
  EXPR_AWAIT,
  EXPR_BINARY,
  EXPR_CALL,
  EXPR_CLASS,
  EXPR_COND,
  EXPR_DOT,
  EXPR_FN,
  EXPR_IMPORT_CALL,
  EXPR_MISSING,
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
  STMT_BLOCK,
  STMT_BREAK,
  STMT_CLASS,
  STMT_CONTINUE,
  STMT_DEBUGGER,
  STMT_DO_WHILE,
  STMT_EMPTY,
  STMT_ENUM,
  STMT_EXPORT_AS_NAMESPACE,
  STMT_EXPORT_ASSIGN,
  STMT_EXPORT_DEFAULT,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_EXPR,
  STMT_FN,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IF,
  STMT_IMPORT,
  STMT_IMPORT_EQUALS,
  STMT_INTERFACE,
  STMT_LABELED,
  STMT_MODULE,
  STMT_RETURN,
  STMT_SWITCH,
  STMT_THROW,
  STMT_TRY,
  STMT_TYPE_ALIAS,
  STMT_VAR,
  STMT_WHILE,
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
} from "../../sema/hir.ts";
import { I32Vec } from "../../sema/vec.ts";
import {
  N_CASE,
  N_ENUM_MEMBER,
  N_EXPORT_SPEC,
  N_EXPR,
  N_FUNC,
  N_IMPORT_SPEC,
  N_MEMBER,
  N_PARAM,
  N_PAT,
  N_PAT_ELEM,
  N_PAT_PROP,
  N_PROP,
  N_STMT,
  N_TUPLE_ELEM,
  N_TYPE,
  N_TYPE_PARAM,
  N_VAR_DECL,
  N_CLASS,
  nodeOf,
  nodeOfClass,
  nodeOfExpr,
  nodeOfFunc,
  nodeOfStmt,
  nodeOfType,
  nodeOfPat,
  nodeOfTypeParam,
  nodeOfParam,
  nodeOfVarDecl,
  nodeOfPatElem,
  N_FILE,
} from "./node.ts";
import { listCountUntil } from "./list.ts";
import { exprIsAngleBracketAssertion, exprIsNameOrLiteral } from "./expr.ts";
import { stmtAsExpr, stmtImportAttributes, stmtIsWith, stmtWithBody, stmtWithObject } from "./stmt.ts";
import { moduleBodyLen, moduleBodyStart } from "./decl.ts";
import { importAttributesEntriesLen, importAttributesEntriesStart, typeImportAttributes } from "./ty.ts";

/** Appends the elements of a list of kind `kind`; with `near >= 0` and a list longer than 8, only the last that starts at or before `near`. */
function pushList(out: I32Vec, kind: number, start: number, len: number, near: number): void {
  if (len <= 0) return;
  const hir$ = hir;
  if (near >= 0 && len > 8) {
    const c = listCountUntil(kind, start, len, near);
    if (c > 0) out.push(nodeOf(kind, hir$.ids[(start + c - 1) | 0] | 0));
    return;
  }
  for (let i = 0; i < len; i++) out.push(nodeOf(kind, hir$.ids[(start + i) | 0] | 0));
}

/** Like `pushList` for expressions, leaving out the `Missing` ones (holes in arrays, the empty `{}` of JSX, what is missing from `import()`). */
function pushExprListNoMissing(out: I32Vec, start: number, len: number, near: number): void {
  if (len <= 0) return;
  const hir$ = hir;
  if (near >= 0 && len > 8) {
    const c = listCountUntil(N_EXPR, start, len, near);
    if (c > 0) {
      const e = hir$.ids[(start + c - 1) | 0] | 0;
      if ((hir$.exprTag[e] | 0) === EXPR_MISSING) return;
      out.push(nodeOfExpr(e));
    }
    return;
  }
  for (let i = 0; i < len; i++) {
    const e = hir$.ids[(start + i) | 0] | 0;
    if ((hir$.exprTag[e] | 0) !== EXPR_MISSING) out.push(nodeOfExpr(e));
  }
}

function one(out: I32Vec, node: number): void {
  out.push(node);
}
function oneExpr(out: I32Vec, e: number): void {
  if (e >= 0) out.push(nodeOfExpr(e));
}
function oneStmt(out: I32Vec, s: number): void {
  if (s >= 0) out.push(nodeOfStmt(s));
}
function oneType(out: I32Vec, t: number): void {
  if (t >= 0) out.push(nodeOfType(t));
}

/** The decorators among the modifiers `(start, len)`: their expressions. */
function pushDecorators(out: I32Vec, start: number, len: number): void {
  const hir$ = hir;
  for (let i = 0; i < len; i++) {
    const m = hir$.ids[(start + i) | 0] | 0;
    if ((hir$.modifierKind[m] | 0) === MODK_DECORATOR) oneExpr(out, hir$.modifierValue[m] | 0);
  }
}

/** The strings in `with { key: "value" }`: the values of the entries of the import attributes `row`. */
function pushAttributeValues(out: I32Vec, row: number): void {
  if (row < 0) return;
  const s = importAttributesEntriesStart(row);
  const n = importAttributesEntriesLen(row);
  const hir$ = hir;
  for (let i = 0; i < n; i++) {
    const p = hir$.ids[(s + i) | 0] | 0;
    oneExpr(out, hir$.propValue[p] | 0);
  }
}

/** What is in the head of a `for`: a `Var`, or the expression in a wrapper. */
function pushHead(out: I32Vec, s: number): void {
  if (s < 0) return;
  const e = stmtAsExpr(s);
  if (e >= 0) out.push(nodeOfExpr(e));
  else out.push(nodeOfStmt(s));
}

/** `Node::for_each_child` / `for_each_child_near`: appends the children of `n` to `out`, in source order. `near`: -1 or an offset. */
export function nodeChildren(n: number, near: number, out: I32Vec): void {
  const id = n & 67108863;
  const hir$ = hir;
  switch (n >> 26) {
    case N_FILE:
      pushList(out, N_STMT, hir$.bodyStart | 0, hir$.bodyLen | 0, near);
      return;
    case N_EXPR:
      exprChildren(id, near, out);
      return;
    case N_STMT:
      stmtChildren(id, near, out);
      return;
    case N_FUNC: {
      pushList(out, N_TYPE_PARAM, hir$.fnTypeParamsStart[id] | 0, hir$.fnTypeParamsLen[id] | 0, near);
      const tp = hir$.fnThisParam[id] | 0;
      if (tp >= 0) out.push(nodeOfParam(tp));
      pushList(out, N_PARAM, hir$.fnParamsStart[id] | 0, hir$.fnParamsLen[id] | 0, near);
      oneType(out, hir$.fnRet[id] | 0);
      const bk = hir$.fnBodyKind[id] | 0;
      if (bk === BODY_BLOCK) pushList(out, N_STMT, hir$.fnBodyA[id] | 0, hir$.fnBodyB[id] | 0, near);
      else if (bk === BODY_EXPR) oneExpr(out, hir$.fnBodyA[id] | 0);
      return;
    }
    case N_PARAM:
      pushDecorators(out, hir$.paramModStart[id] | 0, hir$.paramModLen[id] | 0);
      one(out, nodeOfPat(hir$.paramPat[id] | 0));
      oneType(out, hir$.paramTy[id] | 0);
      oneExpr(out, hir$.paramDefault[id] | 0);
      return;
    case N_TYPE_PARAM:
      oneType(out, hir$.typeParamConstraint[id] | 0);
      oneType(out, hir$.typeParamDefault[id] | 0);
      return;
    case N_PAT: {
      const t = hir$.patTag[id] | 0;
      if (t === PAT_OBJECT) {
        pushList(out, N_PAT_PROP, hir$.patA[id] | 0, hir$.patB[id] | 0, near);
      } else if (t === PAT_ARRAY) {
        const s = hir$.patA[id] | 0;
        const len = hir$.patB[id] | 0;
        if (near >= 0 && len > 8) {
          const c = listCountUntil(N_PAT_ELEM, s, len, near);
          if (c > 0) {
            const el = hir$.ids[(s + c - 1) | 0] | 0;
            if (hasPat(el)) out.push(nodeOfPatElem(el));
          }
        } else {
          for (let i = 0; i < len; i++) {
            const el = hir$.ids[(s + i) | 0] | 0;
            if (hasPat(el)) out.push(nodeOfPatElem(el));
          }
        }
      }
      return;
    }
    case N_PAT_PROP:
      if ((hir$.patPropIsRest[id] | 0) === 0 && (hir$.patPropKeyKind[id] | 0) === 3) oneExpr(out, hir$.patPropKeyVal[id] | 0);
      one(out, nodeOfPat(hir$.patPropValue[id] | 0));
      oneExpr(out, hir$.patPropDefault[id] | 0);
      return;
    case N_PAT_ELEM: {
      const p = hir$.patElemPat[id] | 0;
      if (p >= 0 && (hir$.patTag[p] | 0) !== 0) out.push(nodeOfPat(p));
      oneExpr(out, hir$.patElemDefault[id] | 0);
      return;
    }
    case N_CLASS:
      pushDecorators(out, hir$.classModStart[id] | 0, hir$.classModLen[id] | 0);
      pushList(out, N_TYPE_PARAM, hir$.classTypeParamsStart[id] | 0, hir$.classTypeParamsLen[id] | 0, near);
      oneExpr(out, hir$.classExtends[id] | 0);
      pushList(out, N_TYPE, hir$.classExtendsArgsStart[id] | 0, hir$.classExtendsArgsLen[id] | 0, near);
      pushList(out, N_TYPE, hir$.classImplementsStart[id] | 0, hir$.classImplementsLen[id] | 0, near);
      pushList(out, N_MEMBER, hir$.classMembersStart[id] | 0, hir$.classMembersLen[id] | 0, near);
      return;
    case N_MEMBER: {
      pushDecorators(out, hir$.memberModStart[id] | 0, hir$.memberModLen[id] | 0);
      const mk = hir$.memberKind[id] | 0;
      if (mk >= 0 && mk <= 3 && (hir$.memberKeyKind[id] | 0) === 3) oneExpr(out, hir$.memberKeyVal[id] | 0);
      const f = hir$.memberFunc[id] | 0;
      if (f >= 0) out.push(nodeOfFunc(f));
      else oneType(out, hir$.memberTy[id] | 0);
      oneExpr(out, hir$.memberInit[id] | 0);
      return;
    }
    case N_PROP:
      if ((hir$.propKind[id] | 0) !== 2 && (hir$.propKeyKind[id] | 0) === 3) oneExpr(out, hir$.propKeyVal[id] | 0);
      oneExpr(out, hir$.propValue[id] | 0);
      return;
    case N_VAR_DECL:
      one(out, nodeOfPat(hir$.varDeclPat[id] | 0));
      oneType(out, hir$.varDeclTy[id] | 0);
      oneExpr(out, hir$.varDeclInit[id] | 0);
      return;
    case N_CASE:
      oneExpr(out, hir$.caseTest[id] | 0);
      pushList(out, N_STMT, hir$.caseBodyStart[id] | 0, hir$.caseBodyLen[id] | 0, near);
      return;
    case N_ENUM_MEMBER:
      oneExpr(out, hir$.enumMemberComputedName[id] | 0);
      oneExpr(out, hir$.enumMemberInit[id] | 0);
      return;
    case N_IMPORT_SPEC:
    case N_EXPORT_SPEC:
      return;
    case N_TUPLE_ELEM:
      oneType(out, hir$.tupleElemWritten[id] | 0);
      return;
    case N_TYPE:
      typeChildren(id, near, out);
      return;
    default:
      return;
  }
}

function hasPat(el: number): boolean {
  const hir$ = hir;
  const p = hir$.patElemPat[el] | 0;
  return p >= 0 && (hir$.patTag[p] | 0) !== 0;
}

function exprChildren(e: number, near: number, out: I32Vec): void {
  if (exprIsNameOrLiteral(e)) return;
  const hir$ = hir;
  const t = hir$.exprTag[e] | 0;
  switch (t) {
    case EXPR_TEMPLATE:
      pushList(out, N_EXPR, hir$.exprA[e] | 0, hir$.exprB[e] | 0, near);
      return;
    case EXPR_TAGGED_TEMPLATE: {
      const c = hir$.exprA[e] | 0;
      oneExpr(out, hir$.callCallee[c] | 0);
      pushList(out, N_TYPE, hir$.callTypeArgsStart[c] | 0, hir$.callTypeArgsLen[c] | 0, near);
      oneExpr(out, hir$.callTemplate[c] | 0);
      return;
    }
    case EXPR_ARRAY:
      pushExprListNoMissing(out, hir$.exprA[e] | 0, hir$.exprB[e] | 0, near);
      return;
    case EXPR_OBJECT:
      pushList(out, N_PROP, hir$.exprA[e] | 0, hir$.exprB[e] | 0, near);
      return;
    case EXPR_FN:
      out.push(nodeOfFunc(hir$.exprA[e] | 0));
      return;
    case EXPR_CLASS:
      out.push(nodeOfClass(hir$.exprA[e] | 0));
      return;
    case EXPR_DOT:
      oneExpr(out, hir$.exprA[e] | 0);
      return;
    case EXPR_INDEX:
      oneExpr(out, hir$.exprA[e] | 0);
      oneExpr(out, hir$.exprB[e] | 0);
      return;
    case EXPR_CALL:
    case EXPR_NEW: {
      const c = hir$.exprA[e] | 0;
      oneExpr(out, hir$.callCallee[c] | 0);
      pushList(out, N_TYPE, hir$.callTypeArgsStart[c] | 0, hir$.callTypeArgsLen[c] | 0, near);
      pushList(out, N_EXPR, hir$.callArgsStart[c] | 0, hir$.callArgsLen[c] | 0, near);
      return;
    }
    case EXPR_UNARY:
    case EXPR_SPREAD:
    case EXPR_AWAIT:
    case EXPR_AS_CONST:
    case EXPR_NON_NULL:
      oneExpr(out, hir$.exprA[e] | 0);
      return;
    case EXPR_BINARY:
    case EXPR_ASSIGN:
      oneExpr(out, hir$.exprA[e] | 0);
      oneExpr(out, hir$.exprB[e] | 0);
      return;
    case EXPR_COND:
      oneExpr(out, hir$.exprA[e] | 0);
      oneExpr(out, hir$.exprB[e] | 0);
      oneExpr(out, hir$.exprC[e] | 0);
      return;
    case EXPR_YIELD:
      oneExpr(out, hir$.exprA[e] | 0);
      return;
    case EXPR_AS:
      if (exprIsAngleBracketAssertion(e)) {
        oneType(out, hir$.exprB[e] | 0);
        oneExpr(out, hir$.exprA[e] | 0);
      } else {
        oneExpr(out, hir$.exprA[e] | 0);
        oneType(out, hir$.exprB[e] | 0);
      }
      return;
    case EXPR_SATISFIES:
      oneExpr(out, hir$.exprA[e] | 0);
      oneType(out, hir$.exprB[e] | 0);
      return;
    case EXPR_INSTANTIATION:
      oneExpr(out, hir$.exprA[e] | 0);
      pushList(out, N_TYPE, hir$.exprB[e] | 0, hir$.exprC[e] | 0, near);
      return;
    case EXPR_JSX: {
      const j = hir$.exprA[e] | 0;
      oneExpr(out, hir$.jsxTag[j] | 0);
      pushList(out, N_TYPE, hir$.jsxTypeArgsStart[j] | 0, hir$.jsxTypeArgsLen[j] | 0, near);
      pushList(out, N_PROP, hir$.jsxAttrsStart[j] | 0, hir$.jsxAttrsLen[j] | 0, near);
      pushExprListNoMissing(out, hir$.jsxChildrenStart[j] | 0, hir$.jsxChildrenLen[j] | 0, near);
      oneExpr(out, hir$.jsxCloseTag[j] | 0);
      return;
    }
    case EXPR_IMPORT_CALL:
      pushExprListNoMissing(out, hir$.exprA[e] | 0, hir$.exprB[e] | 0, near);
      return;
    default:
      return;
  }
}

function stmtChildren(s: number, near: number, out: I32Vec): void {
  const hir$ = hir;
  switch (hir$.stmtTag[s] | 0) {
    case STMT_EMPTY:
    case STMT_DEBUGGER:
    case STMT_BREAK:
    case STMT_CONTINUE:
    case STMT_IMPORT_EQUALS:
    case STMT_EXPORT_AS_NAMESPACE:
      return;
    case STMT_EXPORT_STAR:
      pushAttributeValues(out, stmtImportAttributes(s));
      return;
    case STMT_EXPR:
    case STMT_THROW:
    case STMT_EXPORT_DEFAULT:
    case STMT_EXPORT_ASSIGN:
    case STMT_RETURN:
      oneExpr(out, hir$.stmtA[s] | 0);
      return;
    case STMT_VAR:
      pushList(out, N_VAR_DECL, hir$.stmtA[s] | 0, hir$.stmtB[s] | 0, near);
      return;
    case STMT_FN:
      out.push(nodeOfFunc(hir$.stmtA[s] | 0));
      return;
    case STMT_CLASS:
      out.push(nodeOfClass(hir$.stmtA[s] | 0));
      return;
    case STMT_INTERFACE: {
      const i = hir$.stmtA[s] | 0;
      pushList(out, N_TYPE_PARAM, hir$.interfaceTypeParamsStart[i] | 0, hir$.interfaceTypeParamsLen[i] | 0, near);
      pushList(out, N_TYPE, hir$.interfaceExtendsStart[i] | 0, hir$.interfaceExtendsLen[i] | 0, near);
      pushList(out, N_MEMBER, hir$.interfaceMembersStart[i] | 0, hir$.interfaceMembersLen[i] | 0, near);
      return;
    }
    case STMT_TYPE_ALIAS: {
      const a = hir$.stmtA[s] | 0;
      pushList(out, N_TYPE_PARAM, hir$.aliasTypeParamsStart[a] | 0, hir$.aliasTypeParamsLen[a] | 0, near);
      oneType(out, hir$.aliasTy[a] | 0);
      return;
    }
    case STMT_ENUM: {
      const en = hir$.stmtA[s] | 0;
      pushList(out, N_ENUM_MEMBER, hir$.enumMembersStart[en] | 0, hir$.enumMembersLen[en] | 0, near);
      return;
    }
    case STMT_MODULE: {
      const m = hir$.stmtA[s] | 0;
      pushList(out, N_STMT, moduleBodyStart(m), moduleBodyLen(m), near);
      return;
    }
    case STMT_IF:
      oneExpr(out, hir$.stmtA[s] | 0);
      oneStmt(out, hir$.stmtB[s] | 0);
      oneStmt(out, hir$.stmtC[s] | 0);
      return;
    case STMT_FOR:
      pushHead(out, hir$.stmtA[s] | 0);
      oneExpr(out, hir$.stmtB[s] | 0);
      oneExpr(out, hir$.stmtC[s] | 0);
      oneStmt(out, hir$.stmtD[s] | 0);
      return;
    case STMT_FOR_IN:
    case STMT_FOR_OF:
      pushHead(out, hir$.stmtA[s] | 0);
      oneExpr(out, hir$.stmtB[s] | 0);
      oneStmt(out, hir$.stmtC[s] | 0);
      return;
    case STMT_WHILE:
      oneExpr(out, hir$.stmtA[s] | 0);
      oneStmt(out, hir$.stmtB[s] | 0);
      return;
    case STMT_DO_WHILE:
      oneStmt(out, hir$.stmtA[s] | 0);
      oneExpr(out, hir$.stmtB[s] | 0);
      return;
    case STMT_BLOCK:
      if (stmtIsWith(s)) {
        oneExpr(out, stmtWithObject(s));
        oneStmt(out, stmtWithBody(s));
      } else {
        pushList(out, N_STMT, hir$.stmtA[s] | 0, hir$.stmtB[s] | 0, near);
      }
      return;
    case STMT_SWITCH:
      oneExpr(out, hir$.stmtA[s] | 0);
      pushList(out, N_CASE, hir$.stmtB[s] | 0, hir$.stmtC[s] | 0, near);
      return;
    case STMT_TRY: {
      oneStmt(out, hir$.stmtA[s] | 0);
      const param = hir$.stmtB[s] | 0;
      if (param >= 0) out.push(nodeOfVarDecl(param));
      oneStmt(out, hir$.stmtC[s] | 0);
      oneStmt(out, hir$.stmtD[s] | 0);
      return;
    }
    case STMT_LABELED:
      oneStmt(out, hir$.stmtB[s] | 0);
      return;
    case STMT_IMPORT: {
      const i = hir$.stmtA[s] | 0;
      pushList(out, N_IMPORT_SPEC, hir$.importNamedStart[i] | 0, hir$.importNamedLen[i] | 0, near);
      pushAttributeValues(out, stmtImportAttributes(s));
      return;
    }
    case STMT_EXPORT_NAMED: {
      const x = hir$.stmtA[s] | 0;
      pushList(out, N_EXPORT_SPEC, hir$.exportItemsStart[x] | 0, hir$.exportItemsLen[x] | 0, near);
      pushAttributeValues(out, stmtImportAttributes(s));
      return;
    }
    default:
      return;
  }
}

function typeChildren(t: number, near: number, out: I32Vec): void {
  const hir$ = hir;
  switch (hir$.typeTag[t] | 0) {
    case TYPE_HERITAGE:
      oneExpr(out, hir$.typeA[t] | 0);
      pushList(out, N_TYPE, hir$.typeB[t] | 0, hir$.typeC[t] | 0, near);
      return;
    case TYPE_TYPEOF:
      oneExpr(out, hir$.typeE[t] | 0);
      pushList(out, N_TYPE, hir$.typeC[t] | 0, hir$.typeD[t] | 0, near);
      return;
    case TYPE_REF:
      pushList(out, N_TYPE, hir$.typeC[t] | 0, hir$.typeD[t] | 0, near);
      return;
    case TYPE_IMPORT:
      pushAttributeValues(out, typeImportAttributes(t));
      pushList(out, N_TYPE, hir$.typeD[t] | 0, hir$.typeE[t] | 0, near);
      return;
    case TYPE_TEMPLATE:
    case TYPE_UNION:
    case TYPE_INTERSECTION:
      pushList(out, N_TYPE, hir$.typeA[t] | 0, hir$.typeB[t] | 0, near);
      return;
    case TYPE_ARRAY:
    case TYPE_KEYOF:
    case TYPE_READONLY:
    case TYPE_UNIQUE:
      oneType(out, hir$.typeA[t] | 0);
      return;
    case TYPE_TUPLE:
      pushList(out, N_TUPLE_ELEM, hir$.typeA[t] | 0, hir$.typeB[t] | 0, near);
      return;
    case TYPE_FN:
      out.push(nodeOfFunc(hir$.typeA[t] | 0));
      return;
    case TYPE_OBJECT:
      pushList(out, N_MEMBER, hir$.typeA[t] | 0, hir$.typeB[t] | 0, near);
      return;
    case TYPE_COND:
      oneType(out, hir$.typeA[t] | 0);
      oneType(out, hir$.typeB[t] | 0);
      oneType(out, hir$.typeC[t] | 0);
      oneType(out, hir$.typeD[t] | 0);
      return;
    case TYPE_INFER:
      out.push(nodeOfTypeParam(hir$.typeA[t] | 0));
      return;
    case TYPE_MAPPED: {
      const m = hir$.typeA[t] | 0;
      out.push(nodeOfTypeParam(hir$.mappedParam[m] | 0));
      oneType(out, hir$.mappedNameTy[m] | 0);
      oneType(out, hir$.mappedTy[m] | 0);
      return;
    }
    case TYPE_INDEXED_ACCESS:
      oneType(out, hir$.typeA[t] | 0);
      oneType(out, hir$.typeB[t] | 0);
      return;
    case TYPE_PREDICATE:
      oneType(out, hir$.typeB[t] | 0);
      return;
    case TYPE_JSDOC:
    default:
      return;
  }
}
