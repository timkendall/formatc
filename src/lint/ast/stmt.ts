// Port of vendor/bun/src/lint/ast/stmt.rs: statements, `VarDecl` and `Case`.
//
//     match s.kind() { StmtKind::If { test, yes, no } => .. }
//  -> switch (stmtTag(s)) { case STMT_IF: { const test = stmtIfTest(s), yes = stmtIfYes(s), no = stmtIfNo(s) /* -1: none */; .. } }
//
// The payload accessors are the generated ones of src/sema/hir.ts (`stmtIfTest`, `stmtForInit`, `stmtTryParam`, `stmtVarDeclsStart/Len`, ...;
// HIR_API.md section 9). `Option<_>` is -1. `StmtKind::With` has the tag `STMT_BLOCK` (as in Rust): `stmtIsWith(s)` tells.
import {
  BODY_BLOCK,
  FLAG_DEFAULT,
  FLAG_DEFINITE,
  FLAG_EXPORT,
  FN_STATIC_BLOCK,
  STMT_BLOCK,
  STMT_BREAK,
  STMT_CONTINUE,
  STMT_DEBUGGER,
  STMT_DO_WHILE,
  STMT_EMPTY,
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
  STMT_IMPORT,
  STMT_IMPORT_EQUALS,
  STMT_LABELED,
  STMT_MODULE,
  STMT_RETURN,
  STMT_THROW,
  STMT_TRY,
  STMT_TYPE_ALIAS,
  STMT_VAR,
  STMT_WHILE,
  hir,
} from "../../sema/hir.ts";
import { modifiersToFlags } from "../../sema/hir_util.ts";
import { P_STMT, bound } from "../../sema/bind/parents.ts";
import { SP } from "../span.ts";
import { skipTrivia, tokenEnd } from "../../sema/check/spans.ts";
import { F } from "./state.ts";
import { N_FUNC, N_STMT, importAttributesIndexWithin, nodeId, nodeKind, nodeOfCase, nodeOfStmt, nodeOfVarDecl, nodeParent } from "./node.ts";
import { exprAsString, exprIsParenthesized, exprSpan } from "./expr.ts";
import {
  exportItemsLastEnd,
  importEqualsNameEnd,
  modifierFlagOf,
  modifierSpan,
  moduleBodyLenOf,
  moduleBodyStartOf,
  moduleInnermost,
} from "./decl.ts";
import { identEndOf } from "./name.ts";
import { patSpan } from "./pat.ts";
import { typeOuterSpan } from "./ty.ts";

function stmtInRange(s: number): boolean {
  return s >= 0 && s < hir.nStmts;
}

/** `Stmt::tag`: the kind without what it holds (`STMT_*`). A `with` statement has the tag `STMT_BLOCK`. */
export function stmtTag(s: number): number {
  return stmtInRange(s) ? hir.stmtTag[s] | 0 : STMT_EMPTY;
}

/** `Stmt::span` into `SP`: from its first token, which can be a decorator or a modifier such as `export`, to the end of its last, which can be a `;`. */
export function stmtSpan(s: number): void {
  const h = hir;
  const sp = SP;
  if (!(s >= 0 && s < h.nStmts)) {
    sp[0] = 0;
    sp[1] = 0;
    return;
  }
  const start = h.stmtStart[s] | 0;
  // The HIR positions the block after `finally` at the keyword.
  if ((h.stmtTag[s] | 0) === STMT_BLOCK && (h.text[start] | 0) === 102) {
    sp[0] = skipTrivia(h.text, h.sourceLen | 0, h.stmtLocPos[s] | 0);
    sp[1] = h.stmtLocEnd[s] | 0;
    return;
  }
  sp[0] = start;
  sp[1] = h.stmtLocEnd[s] | 0;
}
export function stmtStart(s: number): number {
  const h = hir;
  if (!(s >= 0 && s < h.nStmts)) return 0;
  const start = h.stmtStart[s] | 0;
  if ((h.stmtTag[s] | 0) === STMT_BLOCK && (h.text[start] | 0) === 102) {
    stmtSpan(s);
    return SP[0] | 0;
  }
  return start;
}
export function stmtEnd(s: number): number {
  return stmtInRange(s) ? hir.stmtLocEnd[s] | 0 : 0;
}

/** `Stmt::modifiers`: `export`, `default`, `declare`, `async`, `abstract`, `const`, and decorators, in source order: a list of ModifierIds. */
export function stmtModifiersStart(s: number): number {
  return stmtInRange(s) ? hir.stmtModStart[s] | 0 : 0;
}
export function stmtModifiersLen(s: number): number {
  return stmtInRange(s) ? hir.stmtModLen[s] | 0 : 0;
}

/** `Stmt::flags`: the modifiers as flags (`FLAG_*`). */
export function stmtFlags(s: number): number {
  return modifiersToFlags(stmtModifiersStart(s), stmtModifiersLen(s));
}

/** `Stmt::is_exported`: it starts with `export`. */
export function stmtIsExported(s: number): boolean {
  return (stmtFlags(s) & FLAG_EXPORT) !== 0;
}

/** `Stmt::is_default_export`: `export default` before a function, a class or an interface. */
export function stmtIsDefaultExport(s: number): boolean {
  return (stmtFlags(s) & (FLAG_EXPORT | FLAG_DEFAULT)) === (FLAG_EXPORT | FLAG_DEFAULT);
}

/** `Stmt::span_without_export` into `SP`: the declaration without `export` and `export default`. */
export function stmtSpanWithoutExport(s: number): void {
  stmtSpan(s);
  let start = SP[0] | 0;
  const end = SP[1] | 0;
  const ms = stmtModifiersStart(s);
  const ml = stmtModifiersLen(s);
  const hir$ = hir;
  for (let i = 0; i < ml; i++) {
    const m = hir$.ids[(ms + i) | 0] | 0;
    if ((modifierFlagOf(m) & (FLAG_EXPORT | FLAG_DEFAULT)) !== 0) {
      modifierSpan(m);
      start = skipTrivia(hir$.text, hir$.sourceLen | 0, SP[1] | 0);
    }
  }
  SP[0] = start;
  SP[1] = end;
}

/** `Stmt::export_span` into `SP`: the range of ESLint's `ExportNamedDeclaration` or `ExportDefaultDeclaration` around a declaration, from the `export`. False if there is none. */
export function stmtExportSpan(s: number): boolean {
  const ms = stmtModifiersStart(s);
  const ml = stmtModifiersLen(s);
  const hir$ = hir;
  for (let i = 0; i < ml; i++) {
    const m = hir$.ids[(ms + i) | 0] | 0;
    if (modifierFlagOf(m) === FLAG_EXPORT) {
      modifierSpan(m);
      const start = SP[0] | 0;
      stmtSpan(s);
      SP[0] = start;
      return true;
    }
  }
  return false;
}

/** `Stmt::semicolon` into `SP`: the `;` that ends it, if it has one. */
export function stmtSemicolon(s: number): boolean {
  const end = stmtEnd(s);
  let isTerminated = false;
  switch (stmtTag(s)) {
    case STMT_EMPTY:
    case STMT_DEBUGGER:
    case STMT_EXPR:
    case STMT_VAR:
    case STMT_RETURN:
    case STMT_DO_WHILE:
    case STMT_THROW:
    case STMT_BREAK:
    case STMT_CONTINUE:
    case STMT_TYPE_ALIAS:
    case STMT_IMPORT:
    case STMT_IMPORT_EQUALS:
    case STMT_EXPORT_NAMED:
    case STMT_EXPORT_STAR:
    case STMT_EXPORT_DEFAULT:
    case STMT_EXPORT_ASSIGN:
    case STMT_EXPORT_AS_NAMESPACE:
    // An overload or an ambient function, `declare module "m";`
    case STMT_FN:
    case STMT_MODULE:
      isTerminated = true;
      break;
    default:
      break;
  }
  if (isTerminated && end >= 1 && (hir.text[end - 1] | 0) === 59) {
    SP[0] = (end - 1) | 0;
    SP[1] = end;
    return true;
  }
  return false;
}

/** `Stmt::catch_clause_span` into `SP`: of a `Try` with a `catch`: from the `catch` to the end of its block. */
export function stmtCatchClauseSpan(s: number): boolean {
  if (stmtTag(s) !== STMT_TRY) return false;
  const hir$ = hir;
  const handler = hir$.stmtC[s] | 0;
  if (handler < 0) return false;
  const block = hir$.stmtA[s] | 0;
  stmtSpan(block);
  const start = skipTrivia(hir$.text, hir$.sourceLen | 0, SP[1] | 0);
  SP[0] = start;
  SP[1] = stmtEnd(handler);
  return true;
}

function isAt(text: Uint8Array, len: number, at: number, token: string): boolean {
  const n = token.length;
  if (at < 0 || at + n > len) return false;
  for (let i = 0; i < n; i++) if ((text[at + i] | 0) !== token.charCodeAt(i)) return false;
  return true;
}

/** Past `token`, if it is at `at` (else -1). */
function past(text: Uint8Array, len: number, at: number, token: string): number {
  if (at < 0 || !isAt(text, len, at, token)) return -1;
  return skipTrivia(text, len, (at + token.length) | 0);
}

/**
 * `Stmt::module_specifier_span` into `SP`: the module specifier with its quotes: of an `Import`, of an `ExportNamed` or an `ExportStar` after
 * `from`, of an `ImportEquals` in `require(..)`. False if there is none.
 */
export function stmtModuleSpecifierSpan(s: number): boolean {
  if (!stmtInRange(s)) return false;
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  let start = -1;
  switch (hir$.stmtTag[s] | 0) {
    case STMT_IMPORT: {
      const imp = hir$.stmtA[s] | 0;
      if (imp < 0 || imp >= hir$.nImports) return false;
      const cs = hir$.importClauseStart[imp] | 0;
      if (isAt(text, len, cs, "\"") || isAt(text, len, cs, "'")) start = cs;
      else start = past(text, len, skipTrivia(text, len, hir$.importClauseEnd[imp] | 0), "from");
      break;
    }
    case STMT_EXPORT_STAR: {
      const alias = hir$.stmtB[s] | 0;
      let before = 0;
      if (alias >= 0) before = identEndOf(alias, hir$.stmtD[s] | 0);
      else before = ((hir$.stmtC[s] | 0) + 1) | 0;
      start = past(text, len, skipTrivia(text, len, before), "from");
      break;
    }
    case STMT_EXPORT_NAMED: {
      const x = hir$.stmtA[s] | 0;
      if (x < 0) return false;
      let close = -1;
      if ((hir$.exportItemsLen[x] | 0) > 0) {
        const after = skipTrivia(text, len, exportItemsLastEnd(x));
        const comma = past(text, len, after, ",");
        close = comma >= 0 ? comma : after;
      } else {
        // Flow's `declare export {}`
        const st = stmtStart(s);
        const afterDeclare = past(text, len, st, "declare");
        const base = afterDeclare >= 0 ? afterDeclare : st;
        const afterExport = past(text, len, base, "export");
        if (afterExport < 0) return false;
        const afterType = past(text, len, afterExport, "type");
        close = past(text, len, afterType >= 0 ? afterType : afterExport, "{");
        if (close < 0) return false;
      }
      const closeBrace = past(text, len, close, "}");
      start = closeBrace < 0 ? -1 : past(text, len, closeBrace, "from");
      break;
    }
    case STMT_IMPORT_EQUALS: {
      const ie = hir$.stmtA[s] | 0;
      if (ie < 0) return false;
      const equals = skipTrivia(text, len, importEqualsNameEnd(ie));
      const a = past(text, len, equals, "=");
      const b = a < 0 ? -1 : past(text, len, a, "require");
      start = b < 0 ? -1 : past(text, len, b, "(");
      break;
    }
    default:
      return false;
  }
  if (start < 0 || start >= len) return false;
  const quote = text[start] | 0;
  if (quote !== 34 && quote !== 39) return false;
  // Nearly all are a path without an escape, on one line.
  let found = -1;
  for (let i = (start + 1) | 0; i < len; i = ((i | 0) + 1) | 0) {
    const c = text[i] | 0;
    if (c === quote || c === 92 || c === 10 || c === 13) {
      found = i;
      break;
    }
  }
  let end = 0;
  if (found >= 0 && (text[found] | 0) === quote) end = (found + 1) | 0;
  else end = tokenEnd(text, len, start, false);
  SP[0] = start;
  SP[1] = end;
  return true;
}

/**
 * `Stmt::import_attributes`: the `with { type: "json" }` of an `Import`, an `ExportNamed` or an `ExportStar`: its row in
 * `hir.importAttributes` (the `importAttributes*` functions of ty.ts take it), or -1.
 */
export function stmtImportAttributes(s: number): number {
  if (hir.importAttributesLen === 0) return -1;
  const t = stmtTag(s);
  if (t !== STMT_IMPORT && t !== STMT_EXPORT_NAMED && t !== STMT_EXPORT_STAR) return -1;
  stmtSpan(s);
  return importAttributesIndexWithin(SP[0] | 0, SP[1] | 0);
}

/** `Stmt::namespace_export_name`: the atom of the `N` of `export as namespace N`, or -1; `stmtNamespaceExportNamePos` is where it is written. */
export function stmtNamespaceExportName(s: number): number {
  return stmtTag(s) === STMT_EXPORT_AS_NAMESPACE ? hir.stmtA[s] | 0 : -1;
}
export function stmtNamespaceExportNamePos(s: number): number {
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  let at = stmtStart(s);
  at = skipTrivia(text, len, at + 6);
  at = skipTrivia(text, len, at + 2);
  at = skipTrivia(text, len, at + 9);
  return at;
}

/** `Stmt::wrapped_in`: the `for` or `with` statement that the expression statement `id` is a wrapper in, or -1. */
export function stmtWrappedIn(id: number): number {
  const hir$ = hir;
  if (!stmtInRange(id) || (hir$.stmtTag[id] | 0) !== STMT_EXPR) return -1;
  const bound$ = bound;
  if ((bound$.stmtParentTag[id] | 0) !== P_STMT) return -1;
  const parent = bound$.stmtParentA[id] | 0;
  if (!stmtInRange(parent)) return -1;
  switch (hir$.stmtTag[parent] | 0) {
    case STMT_FOR:
    case STMT_FOR_IN:
    case STMT_FOR_OF:
      return (hir$.stmtA[parent] | 0) === id ? parent : -1;
    case STMT_BLOCK:
      return stmtIsWithRaw(parent) && (hir$.ids[hir$.stmtA[parent] | 0] | 0) === id ? parent : -1;
    default:
      return -1;
  }
}

/**
 * `Stmt::is_wrapper`: it wraps the expression in the head of a `for`, or the object of a `with`. The HIR has a statement there and the
 * source has none: it is nobody's parent and no listener is called with it.
 */
export function stmtIsWrapper(s: number): boolean {
  return stmtWrappedIn(s) >= 0;
}

/** `File::is_with(raw)`: the HIR stores `with (object) body` as a block of the two, positioned at the keyword. */
function stmtIsWithRaw(s: number): boolean {
  const hir$ = hir;
  if (hir$.withBodiesLen === 0 || (hir$.stmtTag[s] | 0) !== STMT_BLOCK || (hir$.stmtB[s] | 0) !== 2) return false;
  return isAt(hir$.text, hir$.sourceLen | 0, hir$.stmtStart[s] | 0, "with");
}

/** `Stmt::is_with`: it is a `With` (its tag is `STMT_BLOCK`). Its `object` is `stmtWithObject(s)`, its `body` `stmtWithBody(s)`. */
export function stmtIsWith(s: number): boolean {
  return stmtInRange(s) && stmtIsWithRaw(s);
}
/** The `object` of a `With`: an ExprId. */
export function stmtWithObject(s: number): number {
  const hir$ = hir;
  return stmtAsExpr(hir$.ids[hir$.stmtA[s] | 0] | 0);
}
/** The `body` of a `With`: a StmtId. */
export function stmtWithBody(s: number): number {
  const hir$ = hir;
  return hir$.ids[((hir$.stmtA[s] | 0) + 1) | 0] | 0;
}

/** `Stmt::as_block`: whether it is a `Block` (and not a `With`); the statements are the list `(stmtBlockStmtsStart(s), stmtBlockStmtsLen(s))`. */
export function stmtIsBlock(s: number): boolean {
  return stmtInRange(s) && (hir.stmtTag[s] | 0) === STMT_BLOCK && !stmtIsWithRaw(s);
}

/** `Stmt::as_expr`: the expression of an `Expr` statement, or -1. */
export function stmtAsExpr(s: number): number {
  const hir$ = hir;
  return stmtInRange(s) && (hir$.stmtTag[s] | 0) === STMT_EXPR ? hir$.stmtA[s] | 0 : -1;
}

/** `Stmt::is_loop`: `for`, `for`-`in`, `for`-`of`, `while`, `do`-`while` */
export function stmtIsLoop(s: number): boolean {
  const t = stmtTag(s);
  return t === STMT_FOR || t === STMT_FOR_IN || t === STMT_FOR_OF || t === STMT_WHILE || t === STMT_DO_WHILE;
}

/** `Stmt::label`: the atom of the label of a `Labeled`, a `Break` or a `Continue` (-1: none); `stmtLabelPos` is where it is written. */
export function stmtLabel(s: number): number {
  switch (stmtTag(s)) {
    case STMT_LABELED:
    case STMT_BREAK:
    case STMT_CONTINUE:
      return hir.stmtA[s] | 0;
    default:
      return -1;
  }
}
export function stmtLabelPos(s: number): number {
  const t = stmtTag(s);
  const start = stmtStart(s);
  if (t === STMT_LABELED) return start;
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  if (t === STMT_BREAK) return skipTrivia(text, len, start + 5);
  if (t === STMT_CONTINUE) return skipTrivia(text, len, start + 8);
  return -1;
}

/**
 * `Stmt::directive` into `SP`: `"use strict"` and the like: the text between the quotes, if this is an expression statement that consists
 * of an unparenthesized string literal and is among the first statements of a function, of a namespace or of the file.
 */
export function stmtDirectiveSpan(s: number): boolean {
  const e = stmtAsExpr(s);
  if (e < 0 || exprAsString(e) < 0 || exprIsParenthesized(e)) return false;
  const p = nodeParent(nodeOfStmt(s));
  let listStart = 0;
  let listLen = 0;
  const hir$ = hir;
  if (p === 0) {
    listStart = hir$.bodyStart | 0;
    listLen = hir$.bodyLen | 0;
  } else if (nodeKind(p) === N_FUNC) {
    const f = nodeId(p);
    if ((hir$.fnKind[f] | 0) === FN_STATIC_BLOCK || (hir$.fnBodyKind[f] | 0) !== BODY_BLOCK) return false;
    listStart = hir$.fnBodyA[f] | 0;
    listLen = hir$.fnBodyB[f] | 0;
  } else if (nodeKind(p) === N_STMT) {
    const ps = nodeId(p);
    if ((hir$.stmtTag[ps] | 0) !== STMT_MODULE) return false;
    const inner = moduleInnermost(hir$.stmtA[ps] | 0);
    listStart = moduleBodyStartOf(inner);
    listLen = moduleBodyLenOf(inner);
  } else {
    return false;
  }
  if (listLen === 0) return false;
  // Where the statements start, and where the strings that they start with end. The next question is about the same ones
  // if there are many strings.
  const start = stmtStart(hir$.ids[listStart] | 0);
  let end = 0;
  const F$ = F;
  if (F$.directivesKnown && F$.directivesStart === start) {
    end = F$.directivesEnd;
  } else {
    end = start;
    for (let i = 0; i < listLen; i++) {
      const it = hir$.ids[(listStart + i) | 0] | 0;
      const ie = stmtAsExpr(it);
      if (ie < 0 || exprAsString(ie) < 0 || exprIsParenthesized(ie)) break;
      end = stmtEnd(it);
    }
    F$.directivesStart = start;
    F$.directivesEnd = end;
    F$.directivesKnown = true;
  }
  if (!(stmtStart(s) < end)) return false;
  exprSpan(e);
  const es = SP[0] | 0;
  const ee = SP[1] | 0;
  SP[0] = (es + 1) | 0;
  SP[1] = ee > 1 ? (ee - 1) | 0 : 0;
  return true;
}

// ───────────────────────────── VarDecl ─────────────────────────────
// `pat: ty = init` in a `var`, `let`, `const` or `using` statement. Also the `e` of `catch (e)`.

export function varDeclPat(d: number): number {
  return hir.varDeclPat[d] | 0;
}
/** The type annotation (TypeNodeId or -1). */
export function varDeclTy(d: number): number {
  return hir.varDeclTy[d] | 0;
}
export function varDeclInit(d: number): number {
  return hir.varDeclInit[d] | 0;
}
/** `VarDecl::var_kind`: `VAR_*` */
export function varDeclKind(d: number): number {
  return hir.varDeclKind[d] | 0;
}
/** `Flags::DEFINITE` for `x!: T`, and the flags of the statement. */
export function varDeclFlags(d: number): number {
  return hir.varDeclFlags[d] | 0;
}
/** `VarDecl::is_definite`: `x!: T` */
export function varDeclIsDefinite(d: number): boolean {
  return ((hir.varDeclFlags[d] | 0) & FLAG_DEFINITE) !== 0;
}
/** `VarDecl::span` into `SP`: from the pattern to the end of the initializer. */
export function varDeclSpan(d: number): void {
  const hir$ = hir;
  patSpan(hir$.varDeclPat[d] | 0);
  SP[1] = hir$.varDeclLocEnd[d] | 0;
}
/** `VarDecl::binding_span` into `SP`: the pattern and its type annotation, which is the range of ESLint's `id`. */
export function varDeclBindingSpan(d: number): void {
  const hir$ = hir;
  patSpan(hir$.varDeclPat[d] | 0);
  const s = SP[0] | 0;
  const e = SP[1] | 0;
  const ty = hir$.varDeclTy[d] | 0;
  if (ty >= 0) {
    typeOuterSpan(ty);
    SP[0] = s;
  } else {
    SP[0] = s;
    SP[1] = e;
  }
}
/** `VarDecl::parent`: the `Var` statement, or the `Try` statement of a `catch` parameter (a Node). */
export function varDeclParent(d: number): number {
  return nodeParent(nodeOfVarDecl(d));
}

// ───────────────────────────── Case ─────────────────────────────
// `case test: body`, `default: body`

/** The `test` (ExprId), -1 for `default`. */
export function caseTest(c: number): number {
  return hir.caseTest[c] | 0;
}
export function caseIsDefault(c: number): boolean {
  return (hir.caseTest[c] | 0) < 0;
}
/** The body: a list of StmtIds. */
export function caseBodyStart(c: number): number {
  return hir.caseBodyStart[c] | 0;
}
export function caseBodyLen(c: number): number {
  return hir.caseBodyLen[c] | 0;
}
export function caseSpan(c: number): void {
  const hir$ = hir;
  SP[0] = hir$.casePos[c] | 0;
  SP[1] = hir$.caseEnd[c] | 0;
}
/** `Case::parent`: the `Switch` statement (a Node). */
export function caseParent(c: number): number {
  return nodeParent(nodeOfCase(c));
}
