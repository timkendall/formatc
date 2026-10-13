// Debug printer of the HIR as S-expressions (expressions in full; statements, patterns, types by their tags and children).
import * as H from "../src/sema/hir.ts";
import { hir } from "../src/sema/hir.ts";
import { names } from "../src/sema/parser/parser/mod.ts";

function tagNames(prefix: string): string[] {
  const out: string[] = [];
  for (const k of Object.keys(H)) {
    if (k.startsWith(prefix)) out[(H as any)[k] as number] = k.slice(prefix.length);
  }
  return out;
}
const EXPR = tagNames("EXPR_");
const STMT = tagNames("STMT_");
const TYPE = tagNames("TYPE_");
const PAT = tagNames("PAT_");

function atom(a: number): string {
  return a < 0 ? "<none>" : JSON.stringify(names.atomString(a));
}

function list(start: number, len: number, f: (id: number) => string): string {
  const out: string[] = [];
  for (let i = 0; i < len; i++) out.push(f(hir.ids[start + i]));
  return "[" + out.join(" ") + "]";
}

export function dumpExpr(e: number): string {
  if (e < 0) return "-";
  const tag = hir.exprTag[e];
  const a = hir.exprA[e];
  const b = hir.exprB[e];
  const c = hir.exprC[e];
  const aux = hir.exprAux[e];
  const name = EXPR[tag];
  const at = "@" + hir.exprPos[e] + "-" + hir.exprEnd[e];
  switch (tag) {
    case H.EXPR_IDENT:
    case H.EXPR_STRING:
    case H.EXPR_BIG_INT:
    case H.EXPR_PRIVATE_IDENTIFIER:
      return `(${name} ${atom(a)}${at})`;
    case H.EXPR_NUMBER:
      return `(Num ${hir.numbers[a]}${at})`;
    case H.EXPR_DOT:
      return `(Dot${aux ? "?" + aux : ""} ${dumpExpr(a)} ${atom(b)}${at})`;
    case H.EXPR_INDEX:
      return `(Index${aux ? "?" + aux : ""} ${dumpExpr(a)} ${dumpExpr(b)}${at})`;
    case H.EXPR_CALL:
    case H.EXPR_NEW: {
      const call = a;
      return `(${name}${hir.callChain[call] ? "?" + hir.callChain[call] : ""} ${dumpExpr(hir.callCallee[call])} ${list(hir.callArgsStart[call], hir.callArgsLen[call], dumpExpr)}${hir.callTypeArgsLen[call] ? " <" + hir.callTypeArgsLen[call] + ">" : ""}${at})`;
    }
    case H.EXPR_TAGGED_TEMPLATE: {
      const call = a;
      return `(Tagged ${dumpExpr(hir.callCallee[call])} ${dumpExpr(hir.callTemplate[call])}${at})`;
    }
    case H.EXPR_TEMPLATE:
      return `(Template ${list(a, b, dumpExpr)} texts=${list(a + b, b + 1, (t) => atom(t))}${at})`;
    case H.EXPR_UNARY:
      return `(Unary${aux} ${dumpExpr(a)}${at})`;
    case H.EXPR_BINARY:
      return `(Bin${aux} ${dumpExpr(a)} ${dumpExpr(b)}${at})`;
    case H.EXPR_ASSIGN:
      return `(Assign${aux} ${dumpExpr(a)} ${dumpExpr(b)}${at})`;
    case H.EXPR_COND:
      return `(Cond ${dumpExpr(a)} ${dumpExpr(b)} ${dumpExpr(c)}${at})`;
    case H.EXPR_SPREAD:
    case H.EXPR_AWAIT:
    case H.EXPR_NON_NULL:
    case H.EXPR_AS_CONST:
      return `(${name} ${dumpExpr(a)}${at})`;
    case H.EXPR_YIELD:
      return `(Yield${aux ? "*" : ""} ${dumpExpr(a)}${at})`;
    case H.EXPR_AS:
    case H.EXPR_SATISFIES:
      return `(${name} ${dumpExpr(a)} ty#${b}${at})`;
    case H.EXPR_INSTANTIATION:
      return `(Inst ${dumpExpr(a)} <${c}>${at})`;
    case H.EXPR_ARRAY:
      return `(Array ${list(a, b, dumpExpr)}${at})`;
    case H.EXPR_OBJECT:
      return `(Object ${list(a, b, dumpProp)}${at})`;
    case H.EXPR_FN:
      return `(Fn#${a} ${dumpFn(a)}${at})`;
    case H.EXPR_CLASS:
      return `(Class#${a} ${dumpClass(a)}${at})`;
    case H.EXPR_IMPORT_CALL:
      return `(ImportCall ${list(a, b, dumpExpr)}${at})`;
    case H.EXPR_NEW_TARGET:
      return `(NewTarget ${atom(a)}${at})`;
    default:
      return `(${name}${at})`;
  }
}

function dumpProp(pr: number): string {
  const kind = hir.propKind[pr];
  const kv = hir.propKeyVal[pr];
  let key = "-";
  switch (hir.propKeyKind[pr]) {
    case H.PK_NAME:
    case H.PK_PRIVATE:
      key = atom(kv);
      break;
    case H.PK_COMPUTED:
      key = "[" + dumpExpr(kv) + "]";
  }
  return `{p${kind} ${key} nk${hir.propNameKind[pr]} ${dumpExpr(hir.propValue[pr])}${hir.propModLen[pr] ? " mods" + hir.propModLen[pr] : ""}${hir.propPostfixToken[pr] ? " postfix" : ""}}`;
}

export function dumpFn(f: number): string {
  const body =
    hir.fnBodyKind[f] === H.BODY_BLOCK
      ? "{" + list(hir.fnBodyA[f], hir.fnBodyB[f], dumpStmt) + "}"
      : hir.fnBodyKind[f] === H.BODY_EXPR
        ? dumpExpr(hir.fnBodyA[f])
        : ";";
  const params = list(hir.fnParamsStart[f], hir.fnParamsLen[f], dumpParam);
  return `fn${hir.fnKind[f]}${hir.fnFlags[f] ? "/f" + hir.fnFlags[f] : ""} ${hir.fnName[f] >= 0 ? atom(hir.fnName[f]) : ""}${hir.fnTypeParamsLen[f] ? " <tp" + hir.fnTypeParamsLen[f] + ">" : ""} ${hir.fnThisParam[f] >= 0 ? "this " : ""}${params}${hir.fnRet[f] >= 0 ? " ret#" + hir.fnRet[f] : ""} ${body}`;
}

export function dumpParam(pa: number): string {
  return `(param ${dumpPat(hir.paramPat[pa])}${hir.paramTy[pa] >= 0 ? " :ty#" + hir.paramTy[pa] : ""}${hir.paramDefault[pa] >= 0 ? " =" + dumpExpr(hir.paramDefault[pa]) : ""}${hir.paramFlags[pa] ? "/f" + hir.paramFlags[pa] : ""}${hir.paramModLen[pa] ? " mods" + hir.paramModLen[pa] : ""})`;
}

export function dumpPat(pt: number): string {
  if (pt < 0) return "-";
  const tag = hir.patTag[pt];
  const a = hir.patA[pt];
  const b = hir.patB[pt];
  const at = "@" + hir.patPos[pt] + "-" + hir.patEnd[pt];
  switch (tag) {
    case H.PAT_IDENT:
      return `(P ${atom(a)}${at})`;
    case H.PAT_ARRAY:
      return `(PArray ${list(a, b, (e) => `<${hir.patElemIsRest[e] ? "..." : ""}${dumpPat(hir.patElemPat[e])}${hir.patElemDefault[e] >= 0 ? "=" + dumpExpr(hir.patElemDefault[e]) : ""}>`)}${at})`;
    case H.PAT_OBJECT:
      return `(PObject ${list(a, b, (e) => `<${hir.patPropIsRest[e] ? "..." : ""}${hir.patPropKeyKind[e]}:${hir.patPropKeyKind[e] === H.PK_COMPUTED ? dumpExpr(hir.patPropKeyVal[e]) : atom(hir.patPropKeyVal[e])} ${dumpPat(hir.patPropValue[e])}${hir.patPropDefault[e] >= 0 ? "=" + dumpExpr(hir.patPropDefault[e]) : ""}>`)}${at})`;
    default:
      return `(${PAT[tag]}${at})`;
  }
}

export function dumpClass(c: number): string {
  const members = list(hir.classMembersStart[c], hir.classMembersLen[c], (m) => {
    const kv = hir.memberKeyVal[m];
    const key = hir.memberKeyKind[m] === H.PK_COMPUTED ? "[" + dumpExpr(kv) + "]" : hir.memberKeyKind[m] === H.PK_NONE ? "-" : atom(kv);
    return `{m${hir.memberKind[m]} ${key}/f${hir.memberFlags[m]}${hir.memberFunc[m] >= 0 ? " " + dumpFn(hir.memberFunc[m]) : ""}${hir.memberInit[m] >= 0 ? " =" + dumpExpr(hir.memberInit[m]) : ""}${hir.memberTy[m] >= 0 ? " :ty#" + hir.memberTy[m] : ""}${hir.memberModLen[m] ? " mods" + hir.memberModLen[m] : ""}}`;
  });
  return `class ${hir.className[c] >= 0 ? atom(hir.className[c]) : ""}${hir.classExtends[c] >= 0 ? " extends " + dumpExpr(hir.classExtends[c]) : ""}${hir.classImplementsLen[c] ? " implements" + hir.classImplementsLen[c] : ""} ${members}`;
}

export function dumpStmt(s: number): string {
  if (s < 0) return "-";
  const tag = hir.stmtTag[s];
  const a = hir.stmtA[s];
  const b = hir.stmtB[s];
  const c = hir.stmtC[s];
  const d = hir.stmtD[s];
  const name = STMT[tag];
  switch (tag) {
    case H.STMT_EXPR:
      return `(Expr ${dumpExpr(a)})`;
    case H.STMT_RETURN:
    case H.STMT_THROW:
      return `(${name} ${dumpExpr(a)})`;
    case H.STMT_VAR:
      return `(Var${hir.varDeclKind[hir.ids[a]]} ${list(a, b, (v) => dumpPat(hir.varDeclPat[v]) + (hir.varDeclInit[v] >= 0 ? "=" + dumpExpr(hir.varDeclInit[v]) : ""))})`;
    case H.STMT_FN:
      return `(FnDecl ${dumpFn(a)})`;
    case H.STMT_CLASS:
      return `(ClassDecl ${dumpClass(a)})`;
    case H.STMT_BLOCK:
      return `(Block ${list(a, b, dumpStmt)})`;
    case H.STMT_IF:
      return `(If ${dumpExpr(a)} ${dumpStmt(b)} ${dumpStmt(c)})`;
    case H.STMT_FOR:
      return `(For ${dumpStmt(a)} ${dumpExpr(b)} ${dumpExpr(c)} ${dumpStmt(d)})`;
    default:
      return `(${name})`;
  }
}

export function dumpFile(): string {
  return list(hir.bodyStart, hir.bodyLen, dumpStmt);
}
void TYPE;
