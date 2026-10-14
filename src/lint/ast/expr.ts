// Port of vendor/bun/src/lint/ast/expr.rs: expressions.
//
// `Expr::kind()` (a Rust enum with fields) is `exprTag(e)` plus the field accessors of the tag. `exprTag` is the tag of the HIR except
// that a string that is written with backticks is `EXPR_TEMPLATE` (Rust: `ExprKind::Template`; the HIR has a string there).
//
//     match e.kind() { ExprKind::Dot { obj, name, chain } => .. }
//  -> switch (exprTag(e)) { case EXPR_DOT: { const obj = exprDotObj(e), name = exprDotName(e), namePos = exprDotNamePos(e), chain = exprDotChain(e); .. } }
//
// The field accessors that are the same as the HIR's are the generated ones of src/sema/hir.ts (`exprDotObj`, `exprIndexIndex`, `exprBinaryOp`,
// `exprCondTest`, ...: HIR_API.md section 9); this module defines the ones that differ (templates, strings, numbers) and the methods.
// A parenthesis is not a node: `exprIsParenthesized`, `exprOuterSpan`.
import {
  BIN_COMMA,
  CHAIN_NO,
  CHAIN_START,
  EXPR_ARRAY,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_ASSIGN,
  EXPR_AWAIT,
  EXPR_BIG_INT,
  EXPR_BINARY,
  EXPR_CALL,
  EXPR_CLASS,
  EXPR_DOT,
  EXPR_FALSE,
  EXPR_FN,
  EXPR_IDENT,
  EXPR_IMPORT_CALL,
  EXPR_IMPORT_META,
  EXPR_INDEX,
  EXPR_INSTANTIATION,
  EXPR_JSX,
  EXPR_MISSING,
  EXPR_NEW,
  EXPR_NEW_TARGET,
  EXPR_NON_NULL,
  EXPR_NULL,
  EXPR_NUMBER,
  EXPR_PRIVATE_IDENTIFIER,
  EXPR_REGEX,
  EXPR_SATISFIES,
  EXPR_SPREAD,
  EXPR_STRING,
  EXPR_SUPER,
  EXPR_TAGGED_TEMPLATE,
  EXPR_TEMPLATE,
  EXPR_THIS,
  EXPR_TRUE,
  EXPR_UNARY,
  NK_JSX,
  PROP_SPREAD,
  STMT_FOR_IN,
  STMT_FOR_OF,
  UN_POST_DEC,
  UN_POST_INC,
  hir,
} from "../../sema/hir.ts";
import { jsxExpressionAround, nonNullEndsFirst, parenFirst } from "../../sema/hir_util.ts";
import { bound, isTypeQueryOperand, P_EXPR, P_PROP } from "../../sema/bind/parents.ts";
import { SP } from "../span.ts";
import { Bytes, I32Vec } from "../../sema/vec.ts";
import { skipTrivia } from "../../sema/check/spans.ts";
import { F, JSX_SCRATCH, fileEndOfIdentifier, fileIsParenthesized } from "./state.ts";
import { N_EXPR, N_PROP, N_STMT, nodeAsExpr, nodeKind, nodeId, nodeOfExpr, exprParent, isImportAttributesObject } from "./node.ts";
import { classStartPos, funcStartOfParams } from "./decl.ts";
import { unescapeJsx } from "./entities.ts";
import { stmtAsExpr } from "./stmt.ts";
import { JC_EXPR, JC_WHITESPACE } from "./expr.consts.ts";
export { JC_EXPR, JC_WHITESPACE } from "./expr.consts.ts";


/** The raw expression `e` is in range. */
function inRange(e: number): boolean {
  return e >= 0 && e < hir.nExprs;
}

// ───────────────────────────── tags ─────────────────────────────

/** Whether `e`, a string in the HIR, is a template without substitutions. */
function isBacktickString(e: number): boolean {
  const hir$ = hir;
  return (hir$.text[hir$.exprPos[e] | 0] | 0) === 96 && !exprIsJsxText(e);
}

/**
 * `Expr::tag`: the kind without what it holds. `EXPR_MISSING` for an id that is not an expression (-1). A string that is written with backticks
 * is `EXPR_TEMPLATE`.
 */
export function exprTag(e: number): number {
  const t = hir.exprTag[e] | 0;
  return t === EXPR_STRING ? exprStringTag(e) : t;
}

function exprStringTag(e: number): number {
  return isBacktickString(e) ? EXPR_TEMPLATE : EXPR_STRING;
}

/** `Expr::is_missing` */
export function exprIsMissing(e: number): boolean {
  return exprTag(e) === EXPR_MISSING;
}

/** `Expr::is_name_or_literal`: it is of a kind that has no children. */
export function exprIsNameOrLiteral(e: number): boolean {
  if (!inRange(e)) return true;
  switch (hir.exprTag[e] | 0) {
    case EXPR_MISSING:
    case EXPR_IDENT:
    case EXPR_PRIVATE_IDENTIFIER:
    case EXPR_THIS:
    case EXPR_SUPER:
    case EXPR_NULL:
    case EXPR_TRUE:
    case EXPR_FALSE:
    case EXPR_NUMBER:
    case EXPR_STRING:
    case EXPR_BIG_INT:
    case EXPR_REGEX:
    case EXPR_IMPORT_META:
    case EXPR_NEW_TARGET:
      return true;
    default:
      return false;
  }
}

// ───────────────────────────── JSX text, strings ─────────────────────────────

/**
 * `Expr::is_jsx_text`: it is text between the tags of a JSX element: ESLint's `JSXText`. Its tag is `EXPR_STRING`, with the value that the
 * text has at run time (the atom `exprStringValue`). The text as it is written is the span.
 */
export function exprIsJsxText(e: number): boolean {
  const hir$ = hir;
  if (hir$.nJsx === 0 || !inRange(e) || (hir$.exprTag[e] | 0) !== EXPR_STRING) return false;
  const bound$ = bound;
  if ((bound$.exprParentTag[e] | 0) !== P_EXPR) return false;
  const parent = bound$.exprParentA[e] | 0;
  if (!inRange(parent) || (hir$.exprTag[parent] | 0) !== EXPR_JSX) return false;
  const j = hir$.exprA[parent] | 0;
  if (j < 0 || j >= hir$.nJsx) return false;
  const isName = (hir$.jsxTag[j] | 0) === e || (hir$.jsxCloseTag[j] | 0) === e;
  return !isName && jsxExpressionAround(e) < 0;
}

/** `File::is_jsx_attribute_string`: the string `e` is the value of a JSX attribute, without braces. */
export function exprIsJsxAttributeString(e: number): boolean {
  const hir$ = hir;
  if (hir$.nJsx === 0 || !inRange(e) || (hir$.exprTag[e] | 0) !== EXPR_STRING) return false;
  const bound$ = bound;
  if ((bound$.exprParentTag[e] | 0) !== P_PROP) return false;
  const p = bound$.exprParentA[e] | 0;
  if (p < 0 || p >= hir$.nProps) return false;
  return (hir$.propNameKind[p] | 0) === NK_JSX && (hir$.propKind[p] | 0) !== PROP_SPREAD && jsxExpressionAround(e) < 0;
}

/**
 * The value of a string: `ExprKind::String(name)`'s name (an atom). In JSX it is the value of an attribute with what `&amp;` and
 * the like stand for, the text between elements, or a tag name such as `a-b`. -1 if `e` is not a string (a template, ..).
 */
export function exprStringValue(e: number): number {
  const hir$ = hir;
  if (!inRange(e) || (hir$.exprTag[e] | 0) !== EXPR_STRING) return -1;
  const text = hir$.exprA[e] | 0;
  const c = hir$.text[hir$.exprPos[e] | 0] | 0;
  if ((c === 34 || c === 39) && hir$.nJsx === 0) return text;
  if (c === 96 && !exprIsJsxText(e)) return -1; // a template
  if (!exprIsJsxAttributeString(e)) return text;
  const F$ = F;
  if (F$.names.textLen(text) === 0) return text;
  const buf = F$.names.textBuf(text);
  const start = F$.names.textStart(text);
  const len = F$.names.textLen(text);
  const JSX_SCRATCH$ = JSX_SCRATCH;
  JSX_SCRATCH$.reset();
  if (!unescapeJsx(buf, start, start + len, F$.isEspree, JSX_SCRATCH$)) return text;
  return F$.names.atomOfBytes(JSX_SCRATCH$.data, 0, JSX_SCRATCH$.len);
}

/** `Expr::as_string`: the value of a string literal (an atom), or -1. Same as `exprStringValue`. */
export function exprAsString(e: number): number {
  return exprStringValue(e);
}

/** `Expr::as_ident`: the name if it is an identifier, else -1. */
export function exprAsIdent(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_IDENT ? hir$.exprA[e] | 0 : -1;
}

/** `Expr::is_ident(name)` */
export function exprIsIdent(e: number, lit: string): boolean {
  const a = exprAsIdent(e);
  return a >= 0 && F.names.atomIs(a, lit);
}

/** `Expr::as_private_identifier`: the name of a `#x in a` with the `#`, or -1. */
export function exprAsPrivateIdentifier(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_PRIVATE_IDENTIFIER ? hir$.exprA[e] | 0 : -1;
}

/** `Expr::as_bigint`: the digits (an atom), or -1. */
export function exprAsBigint(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_BIG_INT ? hir$.exprA[e] | 0 : -1;
}

/** The value of an `EXPR_NUMBER` (`File::number`). */
export function exprNumberValue(e: number): number {
  const hir$ = hir;
  if (!inRange(e) || (hir$.exprTag[e] | 0) !== EXPR_NUMBER) return NaN;
  const at = hir$.exprA[e] | 0;
  return at >= 0 && at < hir$.numbersLen ? hir$.numbers[at] : NaN;
}

/**
 * `Expr::jsx_text_value`: ESLint's `value` of a `JSXText`: the text as it is written, all whitespace included, with what `&amp;` and the
 * like stand for. espree has `\n` for each `\r\n` in it. Returns false if `e` is not JSX text; else the value is `out.data[0 .. out.len)`
 * (`out` is reset).
 */
export function exprJsxTextValue(e: number, out: Bytes): boolean {
  if (!exprIsJsxText(e)) return false;
  exprSpan(e);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const en = SP$.s1 | 0;
  const text = hir.text;
  let hasCrlf = false;
  const F$ = F;
  if (F$.isEspree) {
    for (let i = s; i + 1 < en; i++) {
      if ((text[i] | 0) === 13 && (text[i + 1] | 0) === 10) {
        hasCrlf = true;
        break;
      }
    }
  }
  if (!hasCrlf) {
    if (!unescapeJsx(text, s, en, F$.isEspree, out)) {
      out.reset();
      out.append(text, s, en);
    }
    return true;
  }
  const JSX_SCRATCH$ = JSX_SCRATCH;
  JSX_SCRATCH$.reset();
  for (let i = s; i < en; i++) {
    const c = text[i] | 0;
    if (c === 13 && i + 1 < en && (text[i + 1] | 0) === 10) continue;
    JSX_SCRATCH$.push(c);
  }
  if (!unescapeJsx(JSX_SCRATCH$.data, 0, JSX_SCRATCH$.len, F$.isEspree, out)) {
    out.reset();
    out.append(JSX_SCRATCH$.data, 0, JSX_SCRATCH$.len);
  }
  return true;
}

/**
 * `Expr::is_jsx_tag_name`: it is the name in a tag of a JSX element, or a part of it: the `a`, the `a.b` and the `a.b.c` of `<a.b.c>`.
 * ESLint has a `JSXIdentifier`, a `JSXMemberExpression` or a `JSXNamespacedName` there, not an `Identifier` or a `MemberExpression`.
 */
export function exprIsJsxTagName(e: number): boolean {
  const hir$ = hir;
  if (hir$.nJsx === 0) return false;
  const p = exprParent(e);
  if (nodeKind(p) !== N_EXPR) return false;
  const pe = nodeId(p);
  const pt = hir$.exprTag[pe] | 0;
  if (pt === EXPR_DOT) {
    if (!inRange(e)) return false;
    return isInJsxTagWithDots(hir$.exprPos[e] | 0);
  }
  if (pt === EXPR_JSX) {
    const j = hir$.exprA[pe] | 0;
    return (hir$.jsxTag[j] | 0) === e || (hir$.jsxCloseTag[j] | 0) === e;
  }
  return false;
}

/** `File::is_in_jsx_tag_with_dots`: whether `pos` is in the name of a tag of a JSX element that is written with dots: `<a.b.c>`. */
function isInJsxTagWithDots(pos: number): boolean {
  const F$ = F;
  const hir$ = hir;
  const bound$ = bound;
  if (!F$.jsxDotTagsBuilt) {
    F$.jsxDotTagsBuilt = true;
    const v = F$.jsxDotTags;
    v.reset();
    for (let j = 0; j < hir$.nJsx; j++) {
      for (let k = 0; k < 2; k++) {
        const t = k === 0 ? hir$.jsxTag[j] | 0 : hir$.jsxCloseTag[j] | 0;
        if (!inRange(t)) continue;
        if ((bound$.exprParentTag[t] | 0) !== P_EXPR) continue;
        const parent = bound$.exprParentA[t] | 0;
        if (!inRange(parent) || (hir$.exprTag[parent] | 0) !== EXPR_JSX) continue;
        if ((hir$.exprTag[t] | 0) !== EXPR_DOT) continue;
        v.push2(hir$.exprPos[t] | 0, hir$.exprEnd[t] | 0);
      }
    }
    // sort rows by start (insertion sort)
    const d = v.data;
    const n = v.len >> 1;
    for (let i = 1; i < n; i++) {
      const s = d[i * 2] | 0;
      const en = d[i * 2 + 1] | 0;
      let j = i - 1;
      while (j >= 0 && ((d[j * 2] | 0) > s || ((d[j * 2] | 0) === s && (d[j * 2 + 1] | 0) > en))) {
        d[(j + 1) * 2] = d[j * 2] | 0;
        d[(j + 1) * 2 + 1] = d[j * 2 + 1] | 0;
        j = j - 1;
      }
      d[(j + 1) * 2] = s;
      d[(j + 1) * 2 + 1] = en;
    }
  }
  const v = F$.jsxDotTags;
  const n = v.len >> 1;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((v.data[mid * 2] | 0) <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && pos < (v.data[(lo - 1) * 2 + 1] | 0);
}

// ───────────────────────────── spans ─────────────────────────────

/** `Expr::span` into `SP`: without the parentheses around it. */
export function exprSpan(e: number): void {
  const h = hir;
  const sp = SP;
  if (!(e >= 0 && e < h.nExprs)) {
    sp.s0 = 0;
    sp.s1 = 0;
    return;
  }
  const t = h.exprTag[e] | 0;
  const pos = h.exprPos[e] | 0;
  const end = h.exprEnd[e] | 0;
  const f = F;
  let plain = false;
  if (t === EXPR_IDENT || t === EXPR_DOT) plain = end <= f.unicodeFirst || f.unicodeLast < pos;
  else if (t === EXPR_SPREAD || t === EXPR_STRING) plain = h.nJsx === 0;
  else plain = t !== EXPR_CLASS && t !== EXPR_FN;
  if (plain) {
    sp.s0 = (pos) | 0;
    sp.s1 = (end) | 0;
    return;
  }
  spanThatTheHirMayNotHave(e, t, pos, end);
}

function spanThatTheHirMayNotHave(e: number, t: number, pos: number, end: number): void {
  const hir$ = hir;
  const text = hir$.text;
  const SP$ = SP;
  if (t === EXPR_SPREAD && (text[pos] | 0) !== 46) {
    // The HIR does not position the `...e` of the child `{...e}` of a JSX element.
    let start = pos;
    if (exprJsxContainerSpan(e)) start = skipTrivia(text, hir$.sourceLen | 0, (SP$.s0 | 0) + 1);
    SP$.s0 = (start) | 0;
    SP$.s1 = (end) | 0;
  } else if (t === EXPR_IDENT) {
    SP$.s0 = (pos) | 0;
    SP$.s1 = (fileEndOfIdentifier(pos, end)) | 0;
  } else if (t === EXPR_DOT) {
    SP$.s0 = (pos) | 0;
    SP$.s1 = (fileEndOfIdentifier(hir$.exprC[e] | 0, end)) | 0;
  } else if (t === EXPR_CLASS) {
    // Its decorators are part of it.
    SP$.s0 = (classStartPos(hir$.exprA[e] | 0)) | 0;
    SP$.s1 = (end) | 0;
  } else if (t === EXPR_FN) {
    // The function of a method starts with its type parameters. The HIR has it start at the `(`.
    const f = hir$.exprA[e] | 0;
    if (f >= 0 && (hir$.fnTypeParamsLen[f] | 0) !== 0 && (hir$.fnAnchor[f] | 0) === pos) {
      SP$.s0 = (funcStartOfParams(f)) | 0;
      SP$.s1 = (end) | 0;
    } else {
      SP$.s0 = (pos) | 0;
      SP$.s1 = (end) | 0;
    }
  } else if (t === EXPR_STRING && hir$.nJsx !== 0 && (text[pos] | 0) !== 34 && (text[pos] | 0) !== 39 && exprIsJsxAttributeString(e)) {
    // The HIR takes the `\"` at the end of the value of a JSX attribute for an escape.
    let quote = end > 0 ? text[end - 1] | 0 : 34;
    if (end <= 0) quote = 34;
    let start = pos;
    for (let i = pos - 1; i >= 0; i = ((i | 0) - 1) | 0) {
      if ((text[i] | 0) === quote) {
        start = i;
        break;
      }
    }
    SP$.s0 = (start) | 0;
    SP$.s1 = (end) | 0;
  } else {
    SP$.s0 = (pos) | 0;
    SP$.s1 = (end) | 0;
  }
}

export function exprStart(e: number): number {
  const h = hir;
  if (!(e >= 0 && e < h.nExprs)) return 0;
  const t = h.exprTag[e] | 0;
  // The start is the position of the HIR except for these (see `spanThatTheHirMayNotHave`).
  if (t === EXPR_CLASS || t === EXPR_FN || (t === EXPR_SPREAD && h.nJsx !== 0) || (t === EXPR_STRING && h.nJsx !== 0)) {
    exprSpan(e);
    return SP.s0 | 0;
  }
  return h.exprPos[e] | 0;
}
export function exprEnd(e: number): number {
  const h = hir;
  if (!(e >= 0 && e < h.nExprs)) return 0;
  const t = h.exprTag[e] | 0;
  const end = h.exprEnd[e] | 0;
  if (t === EXPR_IDENT || t === EXPR_DOT) {
    const f = F;
    if (end <= f.unicodeFirst || f.unicodeLast < (h.exprPos[e] | 0)) return end;
    exprSpan(e);
    return SP.s1 | 0;
  }
  return end;
}

/** `Expr::is_parenthesized` */
export function exprIsParenthesized(e: number): boolean {
  return fileIsParenthesized(e);
}

/**
 * `Expr::parens`: the parentheses around it, the innermost first, are the rows `exprParenFirst(e) ..` of `hir.parens` while
 * `hir.parenExpr[row] === e`: `(hir.parenStart[row], hir.parenEnd[row])`.
 */
export function exprParenFirst(e: number): number {
  return parenFirst(e);
}

/** The number of parentheses around `e`. */
export function exprParenCount(e: number): number {
  const hir$ = hir;
  if (hir$.nParens === 0) return 0;
  const first = parenFirst(e);
  let n = 0;
  while (first + n < hir$.nParens && (hir$.parenExpr[(first + n) | 0] | 0) === e) n = (n + 1) | 0;
  return n;
}

/** `Expr::outer_span` into `SP`: with all the parentheses around it. */
export function exprOuterSpan(e: number): void {
  const hir$ = hir;
  const SP$ = SP;
  if (fileIsParenthesized(e)) {
    const first = parenFirst(e);
    let last = first;
    while (last + 1 < hir$.nParens && (hir$.parenExpr[(last + 1) | 0] | 0) === e) last = (last + 1) | 0;
    SP$.s0 = hir$.parenStart[last] | 0;
    SP$.s1 = hir$.parenEnd[last] | 0;
    return;
  }
  exprSpan(e);
}
export function exprOuterStart(e: number): number {
  exprOuterSpan(e);
  return SP.s0 | 0;
}
export function exprOuterEnd(e: number): number {
  exprOuterSpan(e);
  return SP.s1 | 0;
}

// ───────────────────────────── accessors ─────────────────────────────

/** `Expr::callee`: what is called by a `Call` or a `New`, else -1. */
export function exprCallee(e: number): number {
  const hir$ = hir;
  const t = inRange(e) ? hir$.exprTag[e] | 0 : EXPR_MISSING;
  if (t === EXPR_CALL || t === EXPR_NEW) return hir$.callCallee[hir$.exprA[e] | 0] | 0;
  return -1;
}

/** `Expr::object`: the `obj` of a `Dot` or an `Index`, else -1. */
export function exprObject(e: number): number {
  const hir$ = hir;
  const t = inRange(e) ? hir$.exprTag[e] | 0 : EXPR_MISSING;
  if (t === EXPR_DOT || t === EXPR_INDEX) return hir$.exprA[e] | 0;
  return -1;
}

/** `Expr::left`: the `left` of a `Binary`, the `target` of an `Assign`, else -1. */
export function exprLeft(e: number): number {
  const hir$ = hir;
  const t = inRange(e) ? hir$.exprTag[e] | 0 : EXPR_MISSING;
  if (t === EXPR_BINARY || t === EXPR_ASSIGN) return hir$.exprA[e] | 0;
  return -1;
}

/** `Expr::right`: the `right` of a `Binary`, the `value` of an `Assign`, else -1. */
export function exprRight(e: number): number {
  const hir$ = hir;
  const t = inRange(e) ? hir$.exprTag[e] | 0 : EXPR_MISSING;
  if (t === EXPR_BINARY || t === EXPR_ASSIGN) return hir$.exprB[e] | 0;
  return -1;
}

/** `Expr::operand`: the one expression in a `Unary`, an `Await`, a `Spread`, a `NonNull`, an `As`, an `AsConst`, a `Satisfies` or an `Instantiation`, else -1. */
export function exprOperand(e: number): number {
  const hir$ = hir;
  const t = inRange(e) ? hir$.exprTag[e] | 0 : EXPR_MISSING;
  switch (t) {
    case EXPR_UNARY:
    case EXPR_AWAIT:
    case EXPR_SPREAD:
    case EXPR_NON_NULL:
    case EXPR_AS_CONST:
    case EXPR_AS:
    case EXPR_SATISFIES:
    case EXPR_INSTANTIATION:
      return hir$.exprA[e] | 0;
    default:
      return -1;
  }
}

/** `Expr::as_call`: the CallId of a `Call`, else -1. */
export function exprAsCall(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_CALL ? hir$.exprA[e] | 0 : -1;
}
/** `Expr::as_new`: the CallId of a `New`, else -1. */
export function exprAsNew(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_NEW ? hir$.exprA[e] | 0 : -1;
}
/** `Expr::as_tagged_template`: the CallId of a `TaggedTemplate`, else -1. */
export function exprAsTaggedTemplate(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_TAGGED_TEMPLATE ? hir$.exprA[e] | 0 : -1;
}
/** `Expr::as_call_or_new` */
export function exprAsCallOrNew(e: number): number {
  const hir$ = hir;
  const t = inRange(e) ? hir$.exprTag[e] | 0 : EXPR_MISSING;
  return t === EXPR_CALL || t === EXPR_NEW ? hir$.exprA[e] | 0 : -1;
}
/** `Expr::as_call_like`: the CallId of a `Call`, a `New` or a `TaggedTemplate`, else -1. */
export function exprAsCallLike(e: number): number {
  const hir$ = hir;
  const t = inRange(e) ? hir$.exprTag[e] | 0 : EXPR_MISSING;
  return t === EXPR_CALL || t === EXPR_NEW || t === EXPR_TAGGED_TEMPLATE ? hir$.exprA[e] | 0 : -1;
}
/** `Expr::as_fn`: the FnId of a function expression, else -1. */
export function exprAsFn(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_FN ? hir$.exprA[e] | 0 : -1;
}
/** `Expr::as_class`: the ClassId of a class expression, else -1. */
export function exprAsClass(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_CLASS ? hir$.exprA[e] | 0 : -1;
}

/** `Expr::is_private_member`: `obj.#name` */
export function exprIsPrivateMember(e: number): boolean {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_DOT && (hir$.text[hir$.exprC[e] | 0] | 0) === 35;
}

/** `Expr::member_name_start`: where the `name` of a `Dot` starts, else -1. */
export function exprMemberNameStart(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_DOT ? hir$.exprC[e] | 0 : -1;
}

/** `Expr::chain`: its place in an optional chain (`CHAIN_NO`, `CHAIN_START`, `CHAIN_CONTINUE`). */
export function exprChain(e: number): number {
  const h = hir;
  if (!(e >= 0 && e < h.nExprs)) return CHAIN_NO;
  const t = h.exprTag[e] | 0;
  if (t === EXPR_DOT || t === EXPR_INDEX) return h.exprAux[e] | 0;
  if (t === EXPR_CALL) return h.callChain[h.exprA[e] | 0] | 0;
  return CHAIN_NO;
}

/** `Expr::is_optional`: `a?.b`, `a?.[b]`, `a?.()`: the `?.` is in this expression itself. */
export function exprIsOptional(e: number): boolean {
  return exprChain(e) === CHAIN_START;
}

/** `Expr::binary_op`: the `BIN_*` of a `Binary`, else -1. */
export function exprBinaryOpOf(e: number): number {
  const h = hir;
  return e >= 0 && e < h.nExprs && (h.exprTag[e] | 0) === EXPR_BINARY ? h.exprAux[e] | 0 : -1;
}
/** `Expr::unary_op`: the `UN_*` of a `Unary`, else -1. */
export function exprUnaryOpOf(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_UNARY ? hir$.exprAux[e] | 0 : -1;
}
/** `Expr::assign_op`: -2 if it is not an `Assign`; 0 for plain `=`, else `BIN_x + 1` (the HIR's encoding of `Option<BinOp>`). */
export function exprAssignOpOf(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_ASSIGN ? hir$.exprAux[e] | 0 : -2;
}

/** `Expr::is_angle_bracket_assertion`: `<T>e` or `<const>e`, as opposed to `e as T`. */
export function exprIsAngleBracketAssertion(e: number): boolean {
  if (!inRange(e)) return false;
  const hir$ = hir;
  const t = hir$.exprTag[e] | 0;
  if (t !== EXPR_AS && t !== EXPR_AS_CONST) return false;
  const operand = hir$.exprA[e] | 0;
  const start = exprStart(e);
  return start < exprOuterStart(operand);
}

/** `Expr::operator_span` into `SP`: the operator of a `Unary`, a `Binary` or an `Assign`, where it is written. False for anything else. */
export function exprOperatorSpan(e: number): boolean {
  const t = exprTag(e);
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  const SP$ = SP;
  if (t === EXPR_UNARY) {
    const op = hir$.exprAux[e] | 0;
    if (op === UN_POST_INC || op === UN_POST_DEC) {
      const start = skipTrivia(text, len, exprOuterEnd(hir$.exprA[e] | 0));
      SP$.s0 = (start) | 0;
      SP$.s1 = (start + 2) | 0;
    } else {
      const start = exprStart(e);
      SP$.s0 = (start) | 0;
      SP$.s1 = (start + unOpTextLen(op)) | 0;
    }
    return true;
  }
  if (t === EXPR_BINARY) {
    const start = skipTrivia(text, len, exprOuterEnd(hir$.exprA[e] | 0));
    SP$.s0 = (start) | 0;
    SP$.s1 = (start + binOpTextLen(hir$.exprAux[e] | 0)) | 0;
    return true;
  }
  if (t === EXPR_ASSIGN) {
    const start = skipTrivia(text, len, exprOuterEnd(hir$.exprA[e] | 0));
    const op = hir$.exprAux[e] | 0;
    SP$.s0 = (start) | 0;
    SP$.s1 = (start + (op === 0 ? 0 : binOpTextLen(op - 1)) + 1) | 0;
    return true;
  }
  return false;
}

/** `Expr::jsx_container_span` into `SP`: the braces of the `{e}` in JSX whose entire content it is. Those of `{...e}` belong to the `Spread`, those of `{}` to the `Missing`. */
export function exprJsxContainerSpan(e: number): boolean {
  const row = jsxExpressionAround(e);
  if (row < 0) return false;
  const hir$ = hir;
  const SP$ = SP;
  SP$.s0 = hir$.jsxExpressionStart[row] | 0;
  SP$.s1 = hir$.jsxExpressionEnd[row] | 0;
  return true;
}

/**
 * `Expr::is_in_optional_chain`: it is part of an optional chain: it is not evaluated if a `?.` to its left, or its own, finds `null` or
 * `undefined`. In `a?.b.c!` that is `a?.b`, `a?.b.c` and `a?.b.c!`. In `(a?.b).c` it is only `a?.b`: parentheses end a chain.
 */
export function exprIsInOptionalChain(e: number): boolean {
  const h = hir;
  let at = e;
  while (at >= 0 && at < h.nExprs && (h.exprTag[at] | 0) === EXPR_NON_NULL) {
    at = h.exprA[at] | 0;
    if (fileIsParenthesized(at)) return false;
  }
  return exprChain(at) !== CHAIN_NO;
}

/** `Expr::is_chain_root`: it is the whole of an optional chain: where ESLint has a `ChainExpression`, with the same range, around the member, the call or the `!`. */
export function exprIsChainRoot(e: number): boolean {
  return exprIsInOptionalChain(e) && endsOptionalChain(e);
}

/** Whether the optional chain that it is part of goes no further. */
function endsOptionalChain(e: number): boolean {
  const p = exprParent(e);
  if (nodeKind(p) !== N_EXPR) return true;
  const pe = nodeId(p);
  const hir$ = hir;
  const t = hir$.exprTag[pe] | 0;
  let continues = false;
  if (t === EXPR_DOT || t === EXPR_INDEX) continues = (hir$.exprA[pe] | 0) === e;
  else if (t === EXPR_CALL) continues = exprCallee(pe) === e;
  else if (t === EXPR_NON_NULL) continues = true;
  return !continues || fileIsParenthesized(e);
}

/**
 * `Expr::is_assignment_target`: it is assigned to by destructuring, or is part of what is: the `[a, b]` of `[a, b] = c`, the `{ a }` of
 * `for ({ a } of b)`, and in these the `a = 1` that is a default and the `...a`. Parentheses make what is in them an ordinary expression.
 */
export function exprIsAssignmentTarget(e: number): boolean {
  let at = e;
  const hir$ = hir;
  const bound$ = bound;
  while (true) {
    if (fileIsParenthesized(at)) return false;
    const p = exprParent(at);
    const k = nodeKind(p);
    const id = nodeId(p);
    if (k === N_EXPR) {
      const t = hir$.exprTag[id] | 0;
      if (t === EXPR_ASSIGN) return (hir$.exprA[id] | 0) === at;
      if (t === EXPR_ARRAY || t === EXPR_SPREAD) at = id;
      else return false;
    } else if (k === N_PROP) {
      if ((hir$.propValue[id] | 0) !== at || (hir$.propNameKind[id] | 0) === NK_JSX) return false;
      const owner = bound$.propOwner[id] | 0;
      // `Prop::parent()` is the object literal (not for an import attribute)
      if (owner < 0 || hir$.importAttributesLen !== 0 && isImportAttributesObject(owner)) return false;
      at = owner;
    } else if (k === N_STMT) {
      const t = hir$.stmtTag[id] | 0;
      if (t === STMT_FOR_IN || t === STMT_FOR_OF) return stmtAsExpr(hir$.stmtA[id] | 0) === at;
      return false;
    } else {
      return false;
    }
  }
}

/** `Expr::is_in_type_query`: it is the `a.b.c` of the type `typeof a.b.c`, or a part of it. ESLint has a `TSQualifiedName` there, not a `MemberExpression`. */
export function exprIsInTypeQuery(e: number): boolean {
  return bound.typeQueryOperandsLen !== 0 && isTypeQueryOperand(e);
}

/**
 * `Expr::inner_non_null_spans`: `x!!!` is one `NonNull` of `x`. ESLint has a `TSNonNullExpression` for each `!`, one in the other. These
 * are the ranges of those in this one, the innermost first: `x!`, `x!!`: the rows `nonNullEndsFirst(e) ..` of `hir.nonNullEnds` while
 * `hir.nonNullEndExpr[row] === e`; the range of a row is `(exprStart(e), hir.nonNullEndEnd[row])`.
 */
export function exprNonNullEndsFirst(e: number): number {
  return nonNullEndsFirst(e);
}

/** The number of inner `!` of a `NonNull` (0 for `x!`). */
export function exprInnerNonNullCount(e: number): number {
  let n = 0;
  const hir$ = hir;
  if (hir$.nNonNullEnds === 0) return 0;
  const first = nonNullEndsFirst(e);
  while (first + n < hir$.nNonNullEnds && (hir$.nonNullEndExpr[(first + n) | 0] | 0) === e) n = (n + 1) | 0;
  return n;
}

/** `Expr::non_null_count`: the number of `!` of a `NonNull`: 2 for `x!!`. 0 for anything else. */
export function exprNonNullCount(e: number): number {
  return inRange(e) && (hir.exprTag[e] | 0) === EXPR_NON_NULL ? (exprInnerNonNullCount(e) + 1) | 0 : 0;
}

/** `Expr::skip_type_wrappers`: without the syntax around it that only concerns types: `e as T`, `<T>e`, `e as const`, `e satisfies T`, `e!`. */
export function exprSkipTypeWrappers(e: number): number {
  let at = e;
  const hir$ = hir;
  while (inRange(at)) {
    const t = hir$.exprTag[at] | 0;
    if (t === EXPR_AS || t === EXPR_SATISFIES || t === EXPR_AS_CONST || t === EXPR_NON_NULL) at = hir$.exprA[at] | 0;
    else break;
  }
  return at;
}

/** `Expr::const_keyword_span` into `SP`: the `const` of `e as const` or `<const>e`, which ESLint has as a `TSTypeReference`. False if `e` is not an `AsConst`. */
export function exprConstKeywordSpan(e: number): boolean {
  const hir$ = hir;
  if (!inRange(e) || (hir$.exprTag[e] | 0) !== EXPR_AS_CONST) return false;
  exprSpan(e);
  const SP$ = SP;
  const whole0 = SP$.s0 | 0;
  const whole1 = SP$.s1 | 0;
  if (exprIsAngleBracketAssertion(e)) {
    const start = skipTrivia(hir$.text, hir$.sourceLen | 0, whole0 + 1);
    SP$.s0 = (start) | 0;
    SP$.s1 = (start + 5) | 0;
  } else {
    SP$.s0 = (whole1 > 5 ? (whole1 - 5) | 0 : 0) | 0;
    SP$.s1 = (whole1) | 0;
  }
  return true;
}

/** `Expr::meta_property_spans`: the two names of `import.meta` or `new.target` (ESLint's `meta` and `property`). Writes `SP[0..2]` = meta, `SP[2..4]` = property. */
export function exprMetaPropertySpans(e: number): boolean {
  const t = exprTag(e);
  let keyword = 0;
  if (t === EXPR_IMPORT_META) keyword = 6;
  else if (t === EXPR_NEW_TARGET) keyword = 3;
  else return false;
  exprSpan(e);
  const SP$ = SP;
  const ws = SP$.s0 | 0;
  const we = SP$.s1 | 0;
  const metaEnd = (ws + keyword) | 0;
  const hir$ = hir;
  const dot = skipTrivia(hir$.text, hir$.sourceLen | 0, metaEnd);
  SP$.s0 = (ws) | 0;
  SP$.s1 = (metaEnd) | 0;
  SP$.s2 = (skipTrivia(hir$.text, hir$.sourceLen | 0, dot + 1)) | 0;
  SP$.s3 = (we) | 0;
  return true;
}

/** `Expr::import_call_phase`: 0 for `import(..)`, 1 for `import.defer(..)`, 2 for `import.source(..)`. */
export function exprImportCallPhase(e: number): number {
  const hir$ = hir;
  if (hir$.deferredImportCallsLen === 0) return 0;
  if (!inRange(e) || (hir$.exprTag[e] | 0) !== EXPR_IMPORT_CALL) return 0;
  const len = hir$.exprB[e] | 0;
  if (len === 0) return 0;
  const first = hir$.ids[hir$.exprA[e] | 0] | 0;
  let deferred = false;
  for (let i = 0; i < hir$.deferredImportCallsLen; i += 2) {
    if ((hir$.deferredImportCalls[i] | 0) === first) {
      deferred = true;
      break;
    }
  }
  if (!deferred) return 0;
  const text = hir$.text;
  const sl = hir$.sourceLen | 0;
  const dot = skipTrivia(text, sl, (exprStart(e)) + 6);
  return phaseAt(skipTrivia(text, sl, dot + 1));
}

/** `File::phase_at`: the word at `pos` is `source` (2) or else `defer` (1). */
export function phaseAt(pos: number): number {
  const hir$ = hir;
  const text = hir$.text;
  const sl = hir$.sourceLen | 0;
  const word = "source";
  if (pos + 6 > sl) return 1;
  for (let i = 0; i < 6; i++) if ((text[pos + i] | 0) !== word.charCodeAt(i)) return 1;
  // the token must end there
  const c = pos + 6 < sl ? text[pos + 6] | 0 : 0;
  const isName = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c >= 0x80;
  return isName ? 1 : 2;
}

/** `Expr::is_deferred_import_call` */
export function exprIsDeferredImportCall(e: number): boolean {
  return exprImportCallPhase(e) === 1;
}

/**
 * `Expr::sequence`: the operands of the comma operators: `a`, `b` and `c` of `a, b, c`, which ESLint has as the `expressions` of one
 * `SequenceExpression`. `(a, b), c` is `(a, b)` and `c`. Anything else is itself. Appends the ids to `out`, in source order.
 */
export function exprSequence(e: number, out: I32Vec): void {
  const base = out.len;
  let at = e;
  const hir$ = hir;
  while (inRange(at) && (hir$.exprTag[at] | 0) === EXPR_BINARY && (hir$.exprAux[at] | 0) === BIN_COMMA && (at === e || !fileIsParenthesized(at))) {
    out.push(hir$.exprB[at] | 0);
    at = hir$.exprA[at] | 0;
  }
  out.push(at);
  // reverse out[base ..)
  let i = base;
  let j = (out.len - 1) | 0;
  while (i < j) {
    const x = out.data[i] | 0;
    out.data[i] = out.data[j] | 0;
    out.data[j] = x;
    i = ((i | 0) + 1) | 0;
    j = ((j | 0) - 1) | 0;
  }
}

// ───────────────────────────── operator texts ─────────────────────────────

const BIN_OP_TEXTS: string[] = [
  "+", "-", "*", "/", "%", "**", "<<", ">>", ">>>", "&", "|", "^", "<", "<=", ">", ">=", "==", "!=", "===", "!==", "in", "instanceof",
  "&&", "||", "??", ",",
];
const UN_OP_TEXTS: string[] = ["+", "-", "~", "!", "typeof", "void", "delete", "++", "--", "++", "--"];
const ASSIGN_OP_TEXTS: string[] = [
  "=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "=", "=", "=", "=", "=", "=", "=", "=", "=", "=",
  "&&=", "||=", "??=", "=",
];

/** `bin_op_text`: the operator as it is written (a constant string; for a byte-exact path use `binOpTextLen`). */
export function binOpText(op: number): string {
  return BIN_OP_TEXTS[op];
}
export function binOpTextLen(op: number): number {
  return BIN_OP_TEXTS[op].length;
}
/** `un_op_text` */
export function unOpText(op: number): string {
  return UN_OP_TEXTS[op];
}
export function unOpTextLen(op: number): number {
  return UN_OP_TEXTS[op].length;
}
/** `assign_op_text(Option<BinOp>)`; `op` is the HIR's encoding (`exprAssignOpOf`): 0 for `=`, else `BIN_x + 1`. */
export function assignOpText(op: number): string {
  return op >= 0 && op < ASSIGN_OP_TEXTS.length ? ASSIGN_OP_TEXTS[op] : "=";
}

// ───────────────────────────── regex ─────────────────────────────

function regexLastSlash(e: number): number {
  exprSpan(e);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const en = SP$.s1 | 0;
  const hir$ = hir;
  for (let i = en - 1; i >= s; i = ((i | 0) - 1) | 0) if ((hir$.text[i] | 0) === 47) return i;
  return s;
}

/** `Regex::pattern` into `SP`: as it is written between the slashes. */
export function exprRegexPatternSpan(e: number): void {
  const slash = regexLastSlash(e);
  exprSpan(e);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  SP$.s0 = (s + 1) | 0;
  SP$.s1 = (slash > s + 1 ? slash : (s + 1) | 0) | 0;
}

/** `Regex::flags` into `SP`. */
export function exprRegexFlagsSpan(e: number): void {
  const slash = regexLastSlash(e);
  exprSpan(e);
  const SP$ = SP;
  const en = SP$.s1 | 0;
  SP$.s0 = (slash + 1) | 0;
  SP$.s1 = (en) | 0;
}

// ───────────────────────────── templates ─────────────────────────────
// `Template { exprs, only_text }`: `` `text${expr}text` ``. A template without substitutions is a string in the HIR; the functions below
// take the expression `e` with `exprTag(e) === EXPR_TEMPLATE` and work for both.

/** The substitutions: a list `(exprTemplateExprsStart(e), exprTemplateExprsLen(e))` of ExprIds. */
export function exprTemplateExprsStart(e: number): number {
  const hir$ = hir;
  return (hir$.exprTag[e] | 0) === EXPR_TEMPLATE ? hir$.exprA[e] | 0 : 0;
}
export function exprTemplateExprsLen(e: number): number {
  const hir$ = hir;
  return (hir$.exprTag[e] | 0) === EXPR_TEMPLATE ? hir$.exprB[e] | 0 : 0;
}

/** `Template::quasi_count`: the number of pieces of text: one more than there are substitutions. */
export function exprTemplateQuasiCount(e: number): number {
  return (exprTemplateExprsLen(e) + 1) | 0;
}

/** `Template::text_of_scanner(i)`: the atom of the piece of text `i` (as TypeScript's scanner has it), or -1. */
export function exprTemplateTextOfScanner(e: number, i: number): number {
  if (i >= exprTemplateQuasiCount(e)) return -1;
  const hir$ = hir;
  if ((hir$.exprTag[e] | 0) !== EXPR_TEMPLATE) return hir$.exprA[e] | 0;
  const at = ((hir$.exprA[e] | 0) + (hir$.exprB[e] | 0) + i) | 0;
  return at >= 0 && at < hir$.idsLen ? hir$.ids[at] | 0 : -1;
}

/** `Template::cooked(i)`: the value of the piece of text at `i` (an atom). -1 if it has an invalid escape, which a tagged template allows. */
export function exprTemplateCooked(e: number, i: number): number {
  const a = exprTemplateTextOfScanner(e, i);
  if (a < 0) return -1;
  exprTemplateRawSpan(e, i);
  const SP$ = SP;
  return hasInvalidEscape(SP$.s0 | 0, SP$.s1 | 0) ? -1 : a;
}

/** From `at`, which is inside the text of a template: the position after the next `${`. */
export function templateTextEnd(text: Uint8Array, len: number, at0: number): number {
  let at = at0 | 0;
  while (true) {
    let found = -1;
    for (let i = at; i < len; i = ((i | 0) + 1) | 0) {
      const c = text[i] | 0;
      if (c === 92 || c === 36 || c === 96) {
        found = i;
        break;
      }
    }
    if (found < 0) return len;
    at = found;
    const c = text[at] | 0;
    if (c === 92) at = ((at | 0) + 2) | 0;
    else if (c === 36 && at + 1 < len && (text[at + 1] | 0) === 123) return (at + 2) | 0;
    else if (c === 36) at = ((at | 0) + 1) | 0;
    else return (at + 1) | 0;
  }
}

/** `Template::quasi_span(i)` into `SP`: the piece of text at `i` with its delimiters: `` `a${ ``, `}b${`, `` }c` ``. */
export function exprTemplateQuasiSpan(e: number, i: number): void {
  exprSpan(e);
  const SP$ = SP;
  const whole0 = SP$.s0 | 0;
  const whole1 = SP$.s1 | 0;
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  const n = exprTemplateExprsLen(e);
  let start = whole0;
  if (i >= 1 && i - 1 < n) {
    const before = hir$.ids[((hir$.exprA[e] | 0) + i - 1) | 0] | 0;
    start = skipTrivia(text, len, exprOuterEnd(before));
  }
  const end = i < n ? templateTextEnd(text, len, start + 1) : whole1;
  SP$.s0 = (start) | 0;
  SP$.s1 = (end) | 0;
}

/** `Template::raw(i)` into `SP`: the piece of text at `i` as it is written, without its delimiters. */
export function exprTemplateRawSpan(e: number, i: number): void {
  const isLast = i + 1 === exprTemplateQuasiCount(e);
  exprTemplateQuasiSpan(e, i);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const en = SP$.s1 | 0;
  SP$.s0 = (s + 1) | 0;
  const cut = isLast ? 1 : 2;
  SP$.s1 = (en > cut ? (en - cut) | 0 : 0) | 0;
}

/** `Template::as_static`: the value, if there are no substitutions: an atom, else -1. */
export function exprTemplateAsStatic(e: number): number {
  return exprTemplateExprsLen(e) === 0 ? exprTemplateCooked(e, 0) : -1;
}

/**
 * Whether the text `text[s, e)` of a template has an escape that is not one: `\u` and `\x` without their digits, `\1` to `\9`, `\0` before a digit.
 */
function hasInvalidEscape(s: number, e: number): boolean {
  const text = hir.text;
  let rest = s;
  while (rest < e) {
    let at = -1;
    for (let i = rest; i < e; i = ((i | 0) + 1) | 0) {
      if ((text[i] | 0) === 92) {
        at = i;
        break;
      }
    }
    if (at < 0) return false;
    const after = (at + 2) | 0;
    const c = at + 1 < e ? text[at + 1] | 0 : -1;
    let isValid = true;
    if (c === 120) {
      isValid = isHexRun(text, after, e, 2, 2);
    } else if (c === 117) {
      if (after < e && (text[after] | 0) === 123) {
        let close = -1;
        for (let i = after; i < e; i = ((i | 0) + 1) | 0) {
          if ((text[i] | 0) === 125) {
            close = i;
            break;
          }
        }
        if (close < 0 || !isHexRun(text, after + 1, close, 1, 1000000)) {
          isValid = false;
        } else {
          let k = after + 1;
          while (k < close && (text[k] | 0) === 48) k = ((k | 0) + 1) | 0;
          const digits = (close - k) | 0;
          isValid = digits < 6 || (digits === 6 && (text[k] | 0) === 49 && (text[k + 1] | 0) === 48);
        }
      } else {
        isValid = isHexRun(text, after, e, 4, 4);
      }
    } else if (c === 48) {
      const d = after < e ? text[after] | 0 : -1;
      isValid = !(d >= 48 && d <= 57);
    } else if (c >= 49 && c <= 57) {
      isValid = false;
    }
    if (!isValid) return true;
    rest = after;
  }
  return false;
}

/** `text[from, from + n)` for the first `min` up to `max` hex digits: all of `text[from, min(from+n, to))` are hex digits, with at least `min` of them. */
function isHexRun(text: Uint8Array, from: number, to: number, min: number, max: number): boolean {
  if (min === max) {
    if (from + min > to) return false;
    for (let i = 0; i < min; i++) if (!isHex(text[from + i] | 0)) return false;
    return true;
  }
  // `{..}`: from..to is the whole run
  if (to <= from) return false;
  for (let i = from; i < to; i++) if (!isHex(text[i] | 0)) return false;
  return true;
}

function isHex(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

// ───────────────────────────── Call ─────────────────────────────
// `Call { callee, args, type_args, chain, close_paren, template }`: `callee(args)`, `new callee(args)`, `` tag`template` ``. A CallId
// is the payload `exprCallCall(e)` / `exprNewCall(e)` / `exprTaggedTemplateCall(e)` (all `hir.exprA[e]`), or `exprAsCallLike(e)`.

export function callCallee(c: number): number {
  const hir$ = hir;
  return c >= 0 && c < hir$.nCalls ? hir$.callCallee[c] | 0 : -1;
}
/** The arguments: a list of ExprIds. */
export function callArgsStart(c: number): number {
  const hir$ = hir;
  return c >= 0 && c < hir$.nCalls ? hir$.callArgsStart[c] | 0 : 0;
}
export function callArgsLen(c: number): number {
  const hir$ = hir;
  return c >= 0 && c < hir$.nCalls ? hir$.callArgsLen[c] | 0 : 0;
}
/** The type arguments: a list of TypeNodeIds. */
export function callTypeArgsStart(c: number): number {
  const hir$ = hir;
  return c >= 0 && c < hir$.nCalls ? hir$.callTypeArgsStart[c] | 0 : 0;
}
export function callTypeArgsLen(c: number): number {
  const hir$ = hir;
  return c >= 0 && c < hir$.nCalls ? hir$.callTypeArgsLen[c] | 0 : 0;
}
export function callChain(c: number): number {
  const hir$ = hir;
  return c >= 0 && c < hir$.nCalls ? hir$.callChain[c] | 0 : CHAIN_NO;
}
/** `callee?.(args)` */
export function callIsOptional(c: number): boolean {
  return callChain(c) === CHAIN_START;
}
/** The position of the `)`, or -1 (`new C`, a tagged template). */
export function callCloseParen(c: number): number {
  const hir$ = hir;
  if (c < 0 || c >= hir$.nCalls) return -1;
  const p = hir$.callClosePos[c] | 0;
  return p >= 0 ? p : -1;
}
/** The template of a tagged template (ExprId), or -1. */
export function callTemplate(c: number): number {
  const hir$ = hir;
  return c >= 0 && c < hir$.nCalls ? hir$.callTemplate[c] | 0 : -1;
}

// ───────────────────────────── Jsx ─────────────────────────────
// `Jsx { tag, close_tag, attrs, children, type_args }`: `<tag attrs>children</tag>`, `<tag attrs />`, `<>children</>`. It is an expression:
// every function takes the ExprId `e` with `exprTag(e) === EXPR_JSX` (Rust keeps the JsxId and the Expr together).

function jsxOf(e: number): number {
  const hir$ = hir;
  return inRange(e) && (hir$.exprTag[e] | 0) === EXPR_JSX ? hir$.exprA[e] | 0 : -1;
}
/** The name in the opening tag: an `Ident`, a `Dot`, `This`, or a `String` for `a-b` and `a:b`. -1 for a fragment. */
export function jsxTag(e: number): number {
  const j = jsxOf(e);
  return j >= 0 ? hir.jsxTag[j] | 0 : -1;
}
/** The name in the closing tag, or -1. */
export function jsxCloseTag(e: number): number {
  const j = jsxOf(e);
  return j >= 0 ? hir.jsxCloseTag[j] | 0 : -1;
}
export function jsxIsFragment(e: number): boolean {
  return jsxTag(e) < 0;
}
export function jsxIsSelfClosing(e: number): boolean {
  const j = jsxOf(e);
  return j >= 0 && (hir.jsxClosePos[j] | 0) < 0;
}
/** `name="value"`, `name={value}`, `name`, `{...value}`: a list of PropIds. */
export function jsxAttrsStart(e: number): number {
  const j = jsxOf(e);
  return j >= 0 ? hir.jsxAttrsStart[j] | 0 : 0;
}
export function jsxAttrsLen(e: number): number {
  const j = jsxOf(e);
  return j >= 0 ? hir.jsxAttrsLen[j] | 0 : 0;
}
/** The children: a list of ExprIds. Text is a `String` (`exprIsJsxText`). What is in braces has an `exprJsxContainerSpan`: `{}` is `Missing`, `{...e}` is a `Spread`. Whitespace with a line break in it means nothing and is left out: see `jsxChildrenWithWhitespace`. */
export function jsxChildrenStart(e: number): number {
  const j = jsxOf(e);
  return j >= 0 ? hir.jsxChildrenStart[j] | 0 : 0;
}
export function jsxChildrenLen(e: number): number {
  const j = jsxOf(e);
  return j >= 0 ? hir.jsxChildrenLen[j] | 0 : 0;
}
/** A list of TypeNodeIds. */
export function jsxTypeArgsStart(e: number): number {
  const j = jsxOf(e);
  return j >= 0 ? hir.jsxTypeArgsStart[j] | 0 : 0;
}
export function jsxTypeArgsLen(e: number): number {
  const j = jsxOf(e);
  return j >= 0 ? hir.jsxTypeArgsLen[j] | 0 : 0;
}
/** `Jsx::opening_span` into `SP`: `<tag attrs>`, `<tag attrs />`, `<>`. */
export function jsxOpeningSpan(e: number): void {
  const j = jsxOf(e);
  const end = j >= 0 ? hir.jsxOpeningEnd[j] | 0 : 0;
  const SP$ = SP;
  SP$.s0 = (exprStart(e)) | 0;
  SP$.s1 = (end) | 0;
}
/** `Jsx::closing_span` into `SP`: `</tag>`, `</>`. False for a self-closing element. */
export function jsxClosingSpan(e: number): boolean {
  const j = jsxOf(e);
  if (j < 0) return false;
  const hir$ = hir;
  const p = hir$.jsxClosePos[j] | 0;
  if (p < 0) return false;
  const SP$ = SP;
  SP$.s0 = (p) | 0;
  SP$.s1 = hir$.jsxEnd[j] | 0;
  return true;
}


/**
 * `Jsx::children_with_whitespace`: the children, and the whitespace between them that is not among `jsxChildren`: all that ESLint has
 * as `children`. Appends rows of 3 to `out`: `(JC_EXPR, ExprId, 0)` or `(JC_WHITESPACE, start, end)`.
 */
export function jsxChildrenWithWhitespace(e: number, out: I32Vec): void {
  jsxOpeningSpan(e);
  const SP$ = SP;
  let at = SP$.s1 | 0;
  let end = at;
  if (jsxClosingSpan(e)) end = SP$.s0 | 0;
  const s = jsxChildrenStart(e);
  const n = jsxChildrenLen(e);
  const hir$ = hir;
  for (let i = 0; i < n; i++) {
    const child = hir$.ids[(s + i) | 0] | 0;
    let cs = 0;
    let ce = 0;
    if (exprJsxContainerSpan(child)) {
      cs = SP$.s0 | 0;
      ce = SP$.s1 | 0;
    } else {
      exprSpan(child);
      cs = SP$.s0 | 0;
      ce = SP$.s1 | 0;
    }
    if (cs > at) out.push3(JC_WHITESPACE, at, cs);
    at = ce;
    out.push3(JC_EXPR, child, 0);
  }
  if (end > at) out.push3(JC_WHITESPACE, at, end);
}

export { nodeOfExpr, nodeAsExpr };
