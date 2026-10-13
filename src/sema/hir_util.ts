// Hand-written helpers over the generated tables of hir.ts: the free functions and `impl` blocks at the end of
// vendor/bun/src/sema/hir.rs (parenthesis queries, entity-name predicates, modifier helpers, `this` parameter splitting, ...).
// Names are the Rust names in camelCase. Anything that returns more than one value writes the extra values to the
// module-level scratch `out0/out1` (read them with `getOut0()/getOut1()`) instead of allocating.
import {
  BIN_COMMA,
  BODY_NONE,
  EXPR_ASSIGN,
  EXPR_AS_CONST,
  EXPR_AS,
  EXPR_AWAIT,
  EXPR_BINARY,
  EXPR_CLASS,
  EXPR_COND,
  EXPR_DOT,
  EXPR_FN,
  EXPR_IDENT,
  EXPR_IMPORT_META,
  EXPR_INDEX,
  EXPR_MISSING,
  EXPR_NEW_TARGET,
  EXPR_NON_NULL,
  EXPR_NUMBER,
  EXPR_SATISFIES,
  EXPR_SPREAD,
  EXPR_STRING,
  EXPR_SUPER,
  EXPR_TEMPLATE,
  EXPR_THIS,
  EXPR_UNARY,
  EXPR_YIELD,
  FLAG_MISSING_BODY,
  FN_ARROW,
  FN_GETTER,
  KW_ANY,
  KW_BIG_INT,
  KW_BOOLEAN,
  KW_INTRINSIC,
  KW_NEVER,
  KW_NULL,
  KW_NUMBER,
  KW_OBJECT,
  KW_STRING,
  KW_SYMBOL,
  KW_THIS,
  KW_UNDEFINED,
  KW_UNKNOWN,
  KW_VOID,
  MM_ADD,
  MM_REMOVE,
  MODK_KEYWORD,
  NONE,
  PAT_IDENT,
  PAT_OBJECT,
  PAT_ARRAY,
  STMT_EXPORT_ASSIGN,
  STMT_EXPORT_DEFAULT,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_MODULE,
  TYPE_IMPORT,
  UN_MINUS,
  UN_PLUS,
  DK_GRAMMAR,
  DK_PARSE,
  hir,
} from "./hir.ts";
import { A_this } from "./atom.ts";
import { I32Vec } from "./vec.ts";
import { FLAG_ABSTRACT, FLAG_ACCESSOR, FLAG_ASYNC, FLAG_CONST, FLAG_AMBIENT, FLAG_DEFAULT, FLAG_EXPORT, FLAG_IN, FLAG_OUT, FLAG_OVERRIDE, FLAG_PRIVATE, FLAG_PROTECTED, FLAG_PUBLIC, FLAG_READONLY, FLAG_STATIC } from "./hir.ts";

let out0 = 0;
let out1 = 0;
/** Second and third results of the helpers that return several values. */
export function getOut0(): number {
  return out0;
}
export function getOut1(): number {
  return out1;
}

// ───────────────────────────── lifecycle ─────────────────────────────

/** Starts a file: forgets the previous one, remembers the source (`src[0, len)`, positions are byte offsets into it). */
export function beginFile(src: Uint8Array, len: number): void {
  hir.reset();
  hir.text = src;
  hir.sourceLen = len | 0;
  hir.reserveFor(len);
}

/**
 * The end of parsing (Rust: `FileBuilder::finish_nodes` + the sortedness the readers rely on): sorts the side tables whose rows
 * the readers binary-search: `parens`, `jsxExpressions`, `nonNullEnds` by expression id (stable), `bodyStarts` by position.
 * The parser produces them almost sorted, so this is an insertion sort.
 */
export function finishHir(): void {
  sortRows3(hir.parenExpr, hir.parenStart, hir.parenEnd, hir.nParens);
  sortRows3(hir.jsxExpressionExpr, hir.jsxExpressionStart, hir.jsxExpressionEnd, hir.nJsxExpressions);
  sortRows2(hir.nonNullEndExpr, hir.nonNullEndEnd, hir.nNonNullEnds);
  sortRows2(hir.bodyStartPos, hir.bodyStartFn, hir.nBodyStarts);
}

function sortRows3(k: Int32Array, b: Int32Array, c: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const ki = k[i] | 0;
    if ((k[i - 1] | 0) <= ki) continue;
    const bi = b[i] | 0;
    const ci = c[i] | 0;
    let j = i - 1;
    while (j >= 0 && (k[j] | 0) > ki) {
      k[j + 1] = k[j] | 0;
      b[j + 1] = b[j] | 0;
      c[j + 1] = c[j] | 0;
      j = j - 1;
    }
    k[j + 1] = ki;
    b[j + 1] = bi;
    c[j + 1] = ci;
  }
}
function sortRows2(k: Int32Array, b: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const ki = k[i] | 0;
    if ((k[i - 1] | 0) <= ki) continue;
    const bi = b[i] | 0;
    let j = i - 1;
    while (j >= 0 && (k[j] | 0) > ki) {
      k[j + 1] = k[j] | 0;
      b[j + 1] = b[j] | 0;
      j = j - 1;
    }
    k[j + 1] = ki;
    b[j + 1] = bi;
  }
}

// ───────────────────────────── id lists ─────────────────────────────

/** `File::id_at`: the `i`-th id of the list starting at `start`. */
export function idAt(start: number, i: number): number {
  return hir.ids[(start + i) | 0] | 0;
}

/** `File::template_texts`: the Atoms of the texts of a template whose substitutions are the list (`start`, `len`) start at `start + len` and there are `len + 1` of them. */
export function templateTextsStart(exprsStart: number, exprsLen: number): number {
  return (exprsStart + exprsLen) | 0;
}

// ───────────────────────────── functions / parameters ─────────────────────────────

/** `Func::this_ty`: the type annotation of the `this` parameter, or NONE. */
export function fnThisTy(f: number): number {
  const p = hir.fnThisParam[f] | 0;
  return p < 0 ? NONE : hir.paramTy[p] | 0;
}

/** `Func::accessor_this_parameter`: the `this` parameter of an accessor that has, with it, as many parameters as its kind takes. */
export function fnAccessorThisParameter(f: number): number {
  const want = (hir.fnKind[f] | 0) !== FN_GETTER ? 1 : 0;
  return (hir.fnParamsLen[f] | 0) === want ? hir.fnThisParam[f] | 0 : NONE;
}

/** `Func::set_accessor_value_parameter`: the first parameter, which can be the `this` parameter. NONE: there is no parameter. */
export function fnSetAccessorValueParameter(f: number): number {
  const len = hir.fnParamsLen[f] | 0;
  const thisParam = hir.fnThisParam[f] | 0;
  if (len > 0 && (thisParam < 0 || len === 1)) return hir.ids[hir.fnParamsStart[f] | 0] | 0;
  return thisParam;
}

/** `Func::effective_set_accessor_type_annotation_node` */
export function fnEffectiveSetAccessorTypeAnnotationNode(f: number): number {
  const v = fnSetAccessorValueParameter(f);
  return v < 0 ? NONE : hir.paramTy[v] | 0;
}

/**
 * `File::split_this_parameter`: if the first of the parameters (list `start`, `len` in ids) is named `this`, returns its ParamId and
 * `getOut0()/getOut1()` are the rest of the list (start + 1, len - 1); otherwise returns NONE and the rest is the whole list.
 */
export function splitThisParameter(start: number, len: number): number {
  if (len > 0) {
    const first = hir.ids[start] | 0;
    const pat = hir.paramPat[first] | 0;
    if (pat >= 0 && (hir.patTag[pat] | 0) === PAT_IDENT && (hir.patA[pat] | 0) === A_this) {
      out0 = (start + 1) | 0;
      out1 = (len - 1) | 0;
      return first;
    }
  }
  out0 = start;
  out1 = len;
  return NONE;
}

/** `hir::has_body`: `NodeIsPresent(node.Body())` */
export function fnHasBody(f: number): boolean {
  return (hir.fnBodyKind[f] | 0) !== BODY_NONE;
}
/** `hir::has_body_node`: a block whose `{` is missing is a body node, though not a present one. */
export function fnHasBodyNode(f: number): boolean {
  return fnHasBody(f) || ((hir.fnFlags[f] | 0) & FLAG_MISSING_BODY) !== 0;
}

// ───────────────────────────── modifiers ─────────────────────────────

/** `File::modifiers_to_flags`: the FLAG_* bits of the keyword modifiers in the list (`start`, `len`). */
export function modifiersToFlags(start: number, len: number): number {
  let flags = 0;
  for (let i = 0; i < len; i++) {
    const m = hir.ids[(start + i) | 0] | 0;
    if ((hir.modifierKind[m] | 0) === MODK_KEYWORD) flags = flags | (hir.modifierValue[m] | 0);
  }
  return flags | 0;
}

/** `File::find_modifier`: the position of the first keyword modifier `flag` in the list, or -1. */
export function findModifier(start: number, len: number, flag: number): number {
  for (let i = 0; i < len; i++) {
    const m = hir.ids[(start + i) | 0] | 0;
    if ((hir.modifierKind[m] | 0) === MODK_KEYWORD && (hir.modifierValue[m] | 0) === flag) return hir.modifierPos[m] | 0;
  }
  return -1;
}

// ───────────────────────────── diagnostics ─────────────────────────────

/** `File::has_parse_or_grammar_diagnostics` */
export function hasParseOrGrammarDiagnostics(): boolean {
  const n = hir.diagnosticsLen;
  for (let i = 0; i < n; i += 5) {
    const k = hir.diagnostics[i] | 0;
    if (k === DK_PARSE || k === DK_GRAMMAR) return true;
  }
  return false;
}
/** `File::has_diagnostic` */
export function hasDiagnostic(start: number, code: number): boolean {
  const n = hir.diagnosticsLen;
  for (let i = 0; i < n; i += 5) {
    if ((hir.diagnostics[i + 1] | 0) === start && (hir.diagnostics[i + 3] | 0) === code) return true;
  }
  return false;
}

// ───────────────────────────── side-table queries ─────────────────────────────

/** `File::is_in_with`: the node at `pos` is in the statement of a `with`. */
export function isInWith(pos: number): boolean {
  const n = hir.withBodiesLen;
  for (let i = 0; i < n; i += 2) {
    if (pos >= (hir.withBodies[i] | 0) && pos < (hir.withBodies[i + 1] | 0)) return true;
  }
  return false;
}

/** First row of `parens` whose expression is `e` (the table is sorted by expression), or `nParens` if none. */
export function parenFirst(e: number): number {
  let lo = 0;
  let hi = hir.nParens;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((hir.parenExpr[mid] | 0) < e) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** Number of parentheses around `e`. The rows `parenFirst(e) ..` are those, innermost first. */
export function parenCount(e: number): number {
  const first = parenFirst(e);
  let n = 0;
  while (first + n < hir.nParens && (hir.parenExpr[(first + n) | 0] | 0) === e) n = (n + 1) | 0;
  return n;
}
/** `hir::open_parenthesis`: the start of the outermost parentheses around `e`, or -1. */
export function openParenthesis(e: number): number {
  const first = parenFirst(e);
  let last = -1;
  let i = first;
  while (i < hir.nParens && (hir.parenExpr[i] | 0) === e) {
    last = i;
    i = (i + 1) | 0;
  }
  return last < 0 ? -1 : hir.parenStart[last] | 0;
}
/** `hir::is_parenthesized`: `IsParenthesizedExpression` for the immediate parent of `e`. */
export function isParenthesized(e: number): boolean {
  const first = parenFirst(e);
  return first < hir.nParens && (hir.parenExpr[first] | 0) === e;
}
/** `hir::end_of_expr`: `node.End()` of `e`, including enclosing parentheses. */
export function endOfExpr(e: number): number {
  const first = parenFirst(e);
  let last = -1;
  let i = first;
  while (i < hir.nParens && (hir.parenExpr[i] | 0) === e) {
    last = i;
    i = (i + 1) | 0;
  }
  return last < 0 ? hir.exprEnd[e] | 0 : hir.parenEnd[last] | 0;
}
/** `hir::start_inside_parentheses` (`GetTokenPosOfNode`): the start of `e`, excluding parentheses around the whole of it. */
export function startInsideParentheses(e: number): number {
  if ((hir.exprTag[e] | 0) === EXPR_CLASS) return hir.classStart[hir.exprA[e] | 0] | 0;
  return hir.exprPos[e] | 0;
}
/** `hir::start_of`: the start of `e`, including enclosing parentheses. */
export function startOf(e: number): number {
  const p = openParenthesis(e);
  return p >= 0 ? p : startInsideParentheses(e);
}
/** `non_null_ends_in`: first row of `nonNullEnds` for `e` (sorted by expr), or `nNonNullEnds`. Rows follow while the expr is `e`. */
export function nonNullEndsFirst(e: number): number {
  let lo = 0;
  let hi = hir.nNonNullEnds;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((hir.nonNullEndExpr[mid] | 0) < e) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** `jsx_expression_around`: the row of `jsxExpressions` whose entire content is `e`, or -1. */
export function jsxExpressionAround(e: number): number {
  let lo = 0;
  let hi = hir.nJsxExpressions;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((hir.jsxExpressionExpr[mid] | 0) < e) lo = mid + 1;
    else hi = mid;
  }
  return lo < hir.nJsxExpressions && (hir.jsxExpressionExpr[lo] | 0) === e ? lo : -1;
}

/** `File::type_args_of_import_call`: the row of `importCallTypeArgs` for the import call whose first argument (the specifier) is `spec`, or -1. */
export function importCallTypeArgsRow(spec: number): number {
  const n = hir.importCallTypeArgsLen;
  for (let i = 0; i < n; i += 3) {
    if ((hir.importCallTypeArgs[i] | 0) === spec) return i;
  }
  return -1;
}

/**
 * `File::attributes_of_import_type`: `Attributes` of the `ImportTypeNode` `t`, an Object expression; the first one in `importAttributes`
 * after its argument. NONE if it has none.
 */
export function attributesOfImportType(t: number): number {
  if ((hir.typeTag[t] | 0) !== TYPE_IMPORT) return NONE;
  const attributes = ((hir.typeAux[t] | 0) >> 3) & 3;
  if (attributes === 0) return NONE;
  const spec = hir.typeA[t] | 0;
  const argsStart = hir.typeD[t] | 0;
  const argsLen = hir.typeE[t] | 0;
  let argumentEnd = hir.typePos[t] | 0;
  if (spec < 0 && argsLen > 0) argumentEnd = hir.exprEnd[hir.ids[argsStart] | 0] | 0;
  const n = hir.importAttributesLen;
  for (let i = 0; i < n; i += 2) {
    if ((hir.importAttributes[i] | 0) > argumentEnd) return hir.importAttributes[i + 1] | 0;
  }
  return NONE;
}

// ───────────────────────────── expression predicates ─────────────────────────────

/** `hir::is_private_name_at`: `IsPrivateIdentifier` for the name at `pos`. */
export function isPrivateNameAt(pos: number): boolean {
  return pos < hir.sourceLen && (hir.text[pos] | 0) === 35;
}

/** `hir::is_bigint_literal_at`: `IsBigIntLiteral` for the token at `pos`: a number that ends in `n`. */
export function isBigintLiteralAt(pos: number): boolean {
  const t = hir.text;
  const n = hir.sourceLen;
  if (pos >= n) return false;
  const c0 = t[pos] | 0;
  if (c0 < 48 || c0 > 57) return false;
  let end = pos;
  while (end < n) {
    const c = t[end] | 0;
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    if (!alnum) break;
    end = (end + 1) | 0;
  }
  return end > pos && (t[end - 1] | 0) === 110;
}

/** `hir::first_identifier`: `a` of `a.b.c`. */
export function firstIdentifier(e0: number): number {
  let e = e0;
  while ((hir.exprTag[e] | 0) === EXPR_DOT) e = hir.exprA[e] | 0;
  return e;
}

/** `hir::is_entity_name_expression`: `a`, `a.b.c`. A missing expression is an Identifier with empty text. */
export function isEntityNameExpression(e: number): boolean {
  if (isParenthesized(e)) return false;
  const tag = hir.exprTag[e] | 0;
  return tag === EXPR_IDENT || tag === EXPR_MISSING || isPropertyAccessEntityNameExpression(e);
}
/** `hir::is_property_access_entity_name_expression` for `e` itself, ignoring enclosing parentheses. */
export function isPropertyAccessEntityNameExpression(e: number): boolean {
  if ((hir.exprTag[e] | 0) !== EXPR_DOT) return false;
  return !isPrivateNameAt(hir.exprC[e] | 0) && isEntityNameExpression(hir.exprA[e] | 0);
}
/** `hir::expression_is_alias` */
export function expressionIsAlias(e: number): boolean {
  return isEntityNameExpression(e) || ((hir.exprTag[e] | 0) === EXPR_CLASS && !isParenthesized(e));
}
/** `hir::is_string_literal_like` */
export function isStringLiteralLike(e: number): boolean {
  if (isParenthesized(e)) return false;
  const tag = hir.exprTag[e] | 0;
  return tag === EXPR_STRING || (tag === EXPR_TEMPLATE && (hir.exprB[e] | 0) === 0);
}
/** `hir::is_string_or_numeric_literal_like_in_parentheses`: `IsStringOrNumericLiteralLike(SkipParentheses(e))` */
export function isStringOrNumericLiteralLikeInParentheses(e: number): boolean {
  const tag = hir.exprTag[e] | 0;
  return tag === EXPR_STRING || tag === EXPR_NUMBER || (tag === EXPR_TEMPLATE && (hir.exprB[e] | 0) === 0);
}
/** `hir::is_string_or_numeric_literal_like` */
export function isStringOrNumericLiteralLike(e: number): boolean {
  return !isParenthesized(e) && isStringOrNumericLiteralLikeInParentheses(e);
}
/** `hir::is_signed_numeric_literal` */
export function isSignedNumericLiteral(e: number): boolean {
  if (isParenthesized(e) || (hir.exprTag[e] | 0) !== EXPR_UNARY) return false;
  const op = hir.exprAux[e] | 0;
  if (op !== UN_PLUS && op !== UN_MINUS) return false;
  const operand = hir.exprA[e] | 0;
  return (hir.exprTag[operand] | 0) === EXPR_NUMBER && !isParenthesized(operand);
}
/** `hir::is_dynamic_name` for the name `[e]` */
export function isDynamicName(e: number): boolean {
  return !isStringOrNumericLiteralLike(e) && !isSignedNumericLiteral(e);
}
/** `hir::is_dotted_name` */
export function isDottedName(e: number): boolean {
  const tag = hir.exprTag[e] | 0;
  if (tag === EXPR_IDENT || tag === EXPR_THIS || tag === EXPR_SUPER || tag === EXPR_NEW_TARGET || tag === EXPR_IMPORT_META) return true;
  if (tag === EXPR_DOT) return isDottedName(hir.exprA[e] | 0);
  return false;
}
/** `hir::is_left_hand_side_expression` */
export function isLeftHandSideExpression(e: number): boolean {
  if (isParenthesized(e)) return true;
  const tag = hir.exprTag[e] | 0;
  if (tag === EXPR_FN) return (hir.fnKind[hir.exprA[e] | 0] | 0) !== FN_ARROW;
  switch (tag) {
    case EXPR_UNARY:
    case EXPR_BINARY:
    case EXPR_ASSIGN:
    case EXPR_COND:
    case EXPR_SPREAD:
    case EXPR_AWAIT:
    case EXPR_YIELD:
    case EXPR_AS:
    case EXPR_SATISFIES:
    case EXPR_AS_CONST:
      return false;
    default:
      return true;
  }
}
/** `hir::is_narrowable_reference` (`isNarrowableReference`) */
export function isNarrowableReference(e0: number): boolean {
  let e = e0;
  while (true) {
    const tag = hir.exprTag[e] | 0;
    if (tag === EXPR_IDENT || tag === EXPR_THIS || tag === EXPR_SUPER || tag === EXPR_NEW_TARGET || tag === EXPR_IMPORT_META) return true;
    if (tag === EXPR_DOT) {
      e = hir.exprA[e] | 0;
      continue;
    }
    if (tag === EXPR_NON_NULL) {
      e = hir.exprA[e] | 0;
      continue;
    }
    if (tag === EXPR_INDEX) {
      const index = hir.exprB[e] | 0;
      // With a literal key the object is not checked.
      if (isStringOrNumericLiteralLike(index)) return true;
      if (isEntityNameExpression(index)) {
        e = hir.exprA[e] | 0;
        continue;
      }
      return false;
    }
    if (tag === EXPR_BINARY && (hir.exprAux[e] | 0) === BIN_COMMA) {
      e = hir.exprB[e] | 0;
      continue;
    }
    if (tag === EXPR_ASSIGN) return isLeftHandSideExpression(hir.exprA[e] | 0);
    return false;
  }
}

/** `hir::has_export_declarations`: whether the statement list (`start`, `len` in ids) has an export declaration. */
export function hasExportDeclarations(start: number, len: number): boolean {
  for (let i = 0; i < len; i++) {
    const s = hir.ids[(start + i) | 0] | 0;
    const t = hir.stmtTag[s] | 0;
    if (t === STMT_EXPORT_NAMED || t === STMT_EXPORT_STAR || t === STMT_EXPORT_ASSIGN || t === STMT_EXPORT_DEFAULT) return true;
  }
  return false;
}

/** `hir::names_bound_by`: appends (atom, PatId) pairs of the names `pat` binds to `into` (2 ints per name). */
export function namesBoundBy(pat: number, into: I32Vec): void {
  const tag = hir.patTag[pat] | 0;
  if (tag === PAT_IDENT) {
    into.push2(hir.patA[pat] | 0, pat);
  } else if (tag === PAT_OBJECT) {
    const start = hir.patA[pat] | 0;
    const len = hir.patB[pat] | 0;
    for (let i = 0; i < len; i++) namesBoundBy(hir.patPropValue[hir.ids[(start + i) | 0] | 0] | 0, into);
  } else if (tag === PAT_ARRAY) {
    const start = hir.patA[pat] | 0;
    const len = hir.patB[pat] | 0;
    for (let i = 0; i < len; i++) namesBoundBy(hir.patElemPat[hir.ids[(start + i) | 0] | 0] | 0, into);
  }
}

/** `hir::is_nested_namespace`: the statement `s` is the `B` of `namespace A.B`. It starts with its name. */
export function isNestedNamespace(s: number): boolean {
  if ((hir.stmtTag[s] | 0) !== STMT_MODULE) return false;
  const m = hir.stmtA[s] | 0;
  return (hir.stmtStart[s] | 0) === (hir.moduleNamePos[m] | 0);
}

/** `hir::is_intrinsic_jsx_name` for the bytes `buf[start, end)` (a JSX tag name): starts with a lowercase letter or has a `-`. */
export function isIntrinsicJsxName(buf: Uint8Array, start: number, end: number): boolean {
  if (end <= start) return false;
  const c = buf[start] | 0;
  if (c >= 97 && c <= 122) return true;
  for (let i = start; i < end; i++) if ((buf[i] | 0) === 45) return true;
  return false;
}

// ───────────────────────────── text of small enums ─────────────────────────────

/** `Keyword::text` (ASCII). */
export function keywordText(k: number): string {
  switch (k) {
    case KW_ANY: return "any";
    case KW_UNKNOWN: return "unknown";
    case KW_NEVER: return "never";
    case KW_VOID: return "void";
    case KW_UNDEFINED: return "undefined";
    case KW_NULL: return "null";
    case KW_STRING: return "string";
    case KW_NUMBER: return "number";
    case KW_BOOLEAN: return "boolean";
    case KW_BIG_INT: return "bigint";
    case KW_SYMBOL: return "symbol";
    case KW_OBJECT: return "object";
    case KW_THIS: return "this";
    case KW_INTRINSIC: return "intrinsic";
    default: return "";
  }
}

/** `Mapped::readonly_text` for the mapped type `m`. */
export function mappedReadonlyText(m: number): string {
  const r = hir.mappedReadonly[m] | 0;
  if (r === MM_ADD) return (hir.mappedIsReadonlyWithPlus[m] | 0) !== 0 ? "+readonly " : "readonly ";
  if (r === MM_REMOVE) return "-readonly ";
  return "";
}
/** `Mapped::question_text` for the mapped type `m`. */
export function mappedQuestionText(m: number): string {
  const r = hir.mappedOptional[m] | 0;
  if (r === MM_ADD) return (hir.mappedIsOptionalWithPlus[m] | 0) !== 0 ? "+?" : "?";
  if (r === MM_REMOVE) return "-?";
  return "";
}

/** `hir::modifier_text`: `scanner.TokenToString(modifier.Kind)`. */
export function modifierText(modifier: number): string {
  switch (modifier) {
    case FLAG_ABSTRACT:
      return "abstract";
    case FLAG_ACCESSOR:
      return "accessor";
    case FLAG_ASYNC:
      return "async";
    case FLAG_CONST:
      return "const";
    case FLAG_AMBIENT:
      return "declare";
    case FLAG_DEFAULT:
      return "default";
    case FLAG_EXPORT:
      return "export";
    case FLAG_IN:
      return "in";
    case FLAG_OUT:
      return "out";
    case FLAG_OVERRIDE:
      return "override";
    case FLAG_PRIVATE:
      return "private";
    case FLAG_PROTECTED:
      return "protected";
    case FLAG_PUBLIC:
      return "public";
    case FLAG_READONLY:
      return "readonly";
    case FLAG_STATIC:
      return "static";
    default:
      return "";
  }
}

/** A diagnostic with the arguments of its message (`{0}`, `{1}`, ...). */
export function pushDiagnosticArgs(kind: number, start: number, end: number, code: number, args: string[]): void {
  let id = -1;
  if (args.length > 0) {
    id = hir.diagArgs.length;
    hir.diagArgs.push(args);
  }
  hir.pushDiagnostics(kind, start, end, code, id);
}
