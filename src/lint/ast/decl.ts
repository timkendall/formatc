// Port of vendor/bun/src/lint/ast/decl.rs: functions, classes and the other declarations, and what they consist of.
//
// Handles (all Int32 row ids of their table; `-1` is `None`):
//   Func (fns) Param TypeParam Class Member Modifier Prop Interface Alias Enum EnumMember Module Import ImportSpec ImportEquals Export ExportSpec
// Functions are named `<handle><Method>`; the Rust `Func` is `func*` here. A list-valued method is a pair `xxxStart(h)` / `xxxLen(h)` (list.ts);
// an `Ident`-valued method is a pair `xxxName(h)` (atom) / `xxxNamePos(h)` (where it is written); `Span`-valued: into `SP`.
//
// KEYS. Rust's `Key` (the name of a member, a property, an object pattern property or an enum member) is derived from the owner on demand.
// Here the owner IS the key handle: a `Node` (node.ts) of kind N_MEMBER, N_PROP, N_PAT_PROP or N_ENUM_MEMBER (`nodeOfMember(m)`, ...).
//
//     if let Some(key) = member.key()        const k = nodeOfMember(m); const kind = keyKind(k); if (kind >= 0) { .. }
//     key.kind()                             keyKind(k) -> KEY_IDENT | KEY_STRING | KEY_NUMBER | KEY_PRIVATE | KEY_COMPUTED_STRING |
//                                                          KEY_COMPUTED_NUMBER | KEY_COMPUTED | KEY_NONE (= -1: `None`)
//     KeyKind::Ident(name) etc.              keyName(k) (an atom)         KeyKind::Computed(e)   keyExpr(k) (an ExprId)
//     key.is_computed() / is_private()       keyIsComputed(k) / keyIsPrivate(k)         key.is_jsx()   keyIsJsx(k)
//     key.span(file) / inner_span(file)      keySpan(k) / keyInnerSpan(k) into SP       key.is("x")    keyIs(k, "x")
// Each call re-derives the key from a few columns; `keyLoad(k)` does it once into the slots `KEY[KEY_KIND]`, `KEY[KEY_NAME]`, `KEY[KEY_EXPR]`,
// `KEY[KEY_START]`, `KEY[KEY_JSX]` (valid until the next `keyLoad`/`key*` call).
import {
  BODY_BLOCK,
  BODY_EXPR,
  FLAG_ASYNC,
  FLAG_COMPUTED_NAME,
  FLAG_GENERATOR,
  FLAG_LITERAL_NAME,
  FLAG_OPTIONAL,
  FLAG_PARAMETER_PROPERTY,
  FLAG_REPARSED,
  FLAG_REST,
  FLAG_STATIC,
  FLAG_STRING_NAME,
  FN_ARROW,
  FN_CONSTRUCTOR,
  FN_DECL,
  FN_EXPR,
  FN_GETTER,
  FN_INDEX_SIGNATURE,
  FN_METHOD,
  FN_SETTER,
  FN_STATIC_BLOCK,
  IET_REQUIRE,
  MEMBER_CONSTRUCTOR,
  MEMBER_GETTER,
  MEMBER_METHOD,
  MEMBER_PROPERTY,
  MEMBER_SETTER,
  MODK_DECORATOR,
  MODK_KEYWORD,
  MODNAME_GLOBAL,
  NK_COMPUTED_NUMBER,
  NK_COMPUTED_STRING,
  NK_IDENTIFIER,
  NK_JSX,
  NK_NUMERIC_LITERAL,
  NK_STRING_LITERAL,
  PK_COMPUTED,
  PK_NAME,
  PK_NONE,
  PK_PRIVATE,
  PROP_GETTER,
  PROP_METHOD,
  PROP_SETTER,
  PROP_SPREAD,
  EXPR_FN,
  FLAG_ABSTRACT,
  FLAG_ACCESSOR,
  FLAG_AMBIENT,
  FLAG_CONST,
  FLAG_DEFAULT,
  FLAG_EXPORT,
  FLAG_IN,
  FLAG_OUT,
  FLAG_OVERRIDE,
  FLAG_PRIVATE,
  FLAG_PROTECTED,
  FLAG_PUBLIC,
  FLAG_READONLY,
  STMT_MODULE,
  hir,
} from "../../sema/hir.ts";
import { isNestedNamespace } from "../../sema/hir_util.ts";
import {
  CO_EXPR,
  CO_STMT,
  FO_EXPR,
  FO_MEMBER,
  FO_STMT,
  FO_TYPE,
  MO_INTERFACE,
  MO_TYPE_LITERAL,
  bound,
} from "../../sema/bind/parents.ts";
import { SP } from "../span.ts";
import { skipTrivia, tokenEnd, whiteSpaceLen } from "../../sema/check/spans.ts";
import { BIGINT_SCRATCH, F, fileEndOfTokenBefore } from "./state.ts";
import {
  N_ENUM_MEMBER,
  N_MEMBER,
  N_PAT_PROP,
  N_PROP,
  NODE_FILE,
  isImportAttribute,
  nodeId,
  nodeKind,
  nodeOfExpr,
  nodeOfMember,
  nodeOfStmt,
  nodeOfType,
  nodeParent,
  nodeOfProp,
} from "./node.ts";
import { exprOuterEnd, exprSpan } from "./expr.ts";
import { stmtEnd, stmtSpan, stmtSpanWithoutExport, stmtModuleSpecifierSpan, stmtImportAttributes } from "./stmt.ts";
import { patSpan } from "./pat.ts";
import { typeAnnotationSpan, typeEnd, typeOuterStart, typeParamListAngleBrackets, typeListAngleBrackets } from "./ty.ts";
import { identEndOf } from "./name.ts";
import { phaseAt } from "./expr.ts";
import {
  KEY,
  KEY_COMPUTED,
  KEY_COMPUTED_NUMBER,
  KEY_COMPUTED_STRING,
  KEY_EXPR,
  KEY_IDENT,
  KEY_JSX,
  KEY_KIND,
  KEY_NAME,
  KEY_NONE,
  KEY_NUMBER,
  KEY_PRIVATE,
  KEY_START,
  KEY_STRING,
} from "./keys.ts";

// ───────────────────────────── functions ─────────────────────────────
// Anything with parameters and a return type: a function declaration or expression, an arrow function, a method, an accessor, a
// constructor, a static block, a signature, a function type. It belongs to its `funcOwner`: a Stmt, an Expr, a Member or a TypeNode.

export function funcKind(f: number): number {
  return hir.fnKind[f] | 0;
}
/** `ASYNC`, `GENERATOR`, and the modifiers of the declaration. */
export function funcFlags(f: number): number {
  return hir.fnFlags[f] | 0;
}
export function funcIsAsync(f: number): boolean {
  if (((hir.fnFlags[f] | 0) & FLAG_ASYNC) !== 0) return true;
  if ((hir.fnKind[f] | 0) !== FN_CONSTRUCTOR) return false;
  // The HIR has no flag for the `async` of `static async constructor() {}`.
  if ((bound.fnOwnerTag[f] | 0) !== FO_MEMBER) return false;
  const m = bound.fnOwnerA[f] | 0;
  const ms = hir.memberModStart[m] | 0;
  const ml = hir.memberModLen[m] | 0;
  for (let i = 0; i < ml; i++) {
    if (modifierFlagOf(hir.ids[(ms + i) | 0] | 0) === FLAG_ASYNC) return true;
  }
  return false;
}
export function funcIsGenerator(f: number): boolean {
  return ((hir.fnFlags[f] | 0) & FLAG_GENERATOR) !== 0;
}
export function funcIsArrow(f: number): boolean {
  return (hir.fnKind[f] | 0) === FN_ARROW;
}
/** `Func::name`: the atom of the name of a function declaration or expression (-1 otherwise; the name of a method is the key of its owner); `funcNamePos` is where it is written. */
export function funcName(f: number): number {
  const k = hir.fnKind[f] | 0;
  return k === FN_DECL || k === FN_EXPR ? hir.fnName[f] | 0 : -1;
}
export function funcNamePos(f: number): number {
  return hir.fnNamePos[f] | 0;
}
/** The type parameters: a list of TypeParamIds. */
export function funcTypeParamsStart(f: number): number {
  return hir.fnTypeParamsStart[f] | 0;
}
export function funcTypeParamsLen(f: number): number {
  return hir.fnTypeParamsLen[f] | 0;
}
/** The parameters, without the `this` parameter: a list of ParamIds. */
export function funcParamsStart(f: number): number {
  return hir.fnParamsStart[f] | 0;
}
export function funcParamsLen(f: number): number {
  return hir.fnParamsLen[f] | 0;
}
/** `this: T`, which is written first (ParamId or -1). `params_with_this()` is this one (if any), then the params. */
export function funcThisParam(f: number): number {
  return hir.fnThisParam[f] | 0;
}
/** The return type (TypeNodeId or -1). */
export function funcReturnType(f: number): number {
  return hir.fnRet[f] | 0;
}
/** `Func::body`: `BODY_NONE` (an overload, an ambient or abstract declaration, a signature), `BODY_BLOCK` or `BODY_EXPR`. */
export function funcBodyKind(f: number): number {
  return hir.fnBodyKind[f] | 0;
}
/** The statements of a body that is a block: a list of StmtIds (empty otherwise). */
export function funcBodyStmtsStart(f: number): number {
  return (hir.fnBodyKind[f] | 0) === BODY_BLOCK ? hir.fnBodyA[f] | 0 : 0;
}
export function funcBodyStmtsLen(f: number): number {
  return (hir.fnBodyKind[f] | 0) === BODY_BLOCK ? hir.fnBodyB[f] | 0 : 0;
}
/** The expression of an arrow function's body (ExprId or -1). */
export function funcBodyExpr(f: number): number {
  return (hir.fnBodyKind[f] | 0) === BODY_EXPR ? hir.fnBodyA[f] | 0 : -1;
}
export function funcHasBody(f: number): boolean {
  return (hir.fnBodyKind[f] | 0) !== 0;
}

function buildBodyOpen(): void {
  const n = hir.nFns | 0;
  if (F.bodyOpen.length < n) {
    let c = F.bodyOpen.length < 64 ? 64 : F.bodyOpen.length;
    while (c < n) c = c * 2;
    F.bodyOpen = new Int32Array(c);
  }
  F.bodyOpen.fill(-1, 0, n);
  for (let i = 0; i < hir.nBodyStarts; i++) {
    const f = hir.bodyStartFn[i] | 0;
    if (f >= 0 && f < n) F.bodyOpen[f] = hir.bodyStartPos[i] | 0;
  }
  F.bodyOpenBuilt = true;
}

/** `Func::body_span` into `SP`: the `{ .. }` of a body that is a block. */
export function funcBodySpan(f: number): boolean {
  if ((hir.fnBodyKind[f] | 0) !== BODY_BLOCK) return false;
  let start = 0;
  if ((hir.fnKind[f] | 0) === FN_STATIC_BLOCK) {
    start = hir.fnAnchor[f] | 0;
  } else {
    if (!F.bodyOpenBuilt) buildBodyOpen();
    start = F.bodyOpen[f] | 0;
    if (start < 0) return false;
  }
  funcSpan(f);
  SP[0] = start;
  return true;
}

/** `Func::open_paren`: the position of the `(` of the parameters. -1 for an arrow function, which may have none, and for a static block. */
export function funcOpenParen(f: number): number {
  const k = hir.fnKind[f] | 0;
  return k !== FN_ARROW && k !== FN_STATIC_BLOCK ? hir.fnAnchor[f] | 0 : -1;
}

/** `Func::arrow_span` into `SP`: the `=>` of an arrow function. */
export function funcArrowSpan(f: number): boolean {
  if ((hir.fnKind[f] | 0) !== FN_ARROW) return false;
  const at = hir.fnAnchor[f] | 0;
  SP[0] = at;
  SP[1] = (at + 2) | 0;
  return true;
}

/** `Func::owner`: what it belongs to (a Node: an Expr, a Stmt, a Member or a TypeNode; `NODE_FILE` if none). */
export function funcOwner(f: number): number {
  const a = bound.fnOwnerA[f] | 0;
  switch (bound.fnOwnerTag[f] | 0) {
    case FO_EXPR:
      return nodeOfExpr(a);
    case FO_STMT:
      return nodeOfStmt(a);
    case FO_MEMBER:
      return nodeOfMember(a);
    case FO_TYPE:
      return nodeOfType(a);
    default:
      return NODE_FILE;
  }
}

/** `Func::span` into `SP`: from its first token, which can be a modifier or a decorator, to its end. That of a method or an accessor starts with the member: see `funcSpanFromParams`. */
export function funcSpan(f: number): void {
  const start = hir.fnStart[f] | 0;
  const a = bound.fnOwnerA[f] | 0;
  let end = start;
  switch (bound.fnOwnerTag[f] | 0) {
    case FO_EXPR:
      end = exprEndOf(a);
      break;
    case FO_STMT:
      end = stmtEnd(a);
      break;
    case FO_MEMBER:
      end = hir.memberLocEnd[a] | 0;
      break;
    case FO_TYPE:
      end = typeEnd(a);
      break;
    default:
      break;
  }
  SP[0] = start;
  SP[1] = end;
}
function exprEndOf(e: number): number {
  exprSpan(e);
  return SP[1] | 0;
}
export function funcStart(f: number): number {
  return hir.fnStart[f] | 0;
}
export function funcEnd(f: number): number {
  funcSpan(f);
  return SP[1] | 0;
}

/** `Func::start_of_params`: the position of the `<` of the type parameters, or of the `(`. */
export function funcStartOfParams(f: number): number {
  const n = hir.fnTypeParamsLen[f] | 0;
  if (n > 0) {
    const first = hir.ids[hir.fnTypeParamsStart[f] | 0] | 0;
    const e = fileEndOfTokenBefore(hir.typeParamStart[first] | 0);
    return e > 0 ? (e - 1) | 0 : 0;
  }
  return hir.fnAnchor[f] | 0;
}

/** `Func::span_from_params` into `SP`: from the type parameters or the `(`. For a method or an accessor, this is what ESLint calls the `FunctionExpression` that is the `value` of the `MethodDefinition` or the `Property`. */
export function funcSpanFromParams(f: number): void {
  const start = funcStartOfParams(f);
  funcSpan(f);
  SP[0] = start;
}

/**
 * `Func::estree_span` into `SP`: the range of the node that ESLint has for it: a `FunctionDeclaration` or a `TSDeclareFunction`: the statement
 * without `export` and `export default`; a `FunctionExpression` or an `ArrowFunctionExpression`: the expression; the `FunctionExpression` or
 * `TSEmptyBodyFunctionExpression` that is the `value` of a method, an accessor or a constructor: `funcSpanFromParams`; a signature, a static
 * block or a function type: the member or the type.
 */
export function funcEstreeSpan(f: number): void {
  const k = hir.fnKind[f] | 0;
  const a = bound.fnOwnerA[f] | 0;
  const ot = bound.fnOwnerTag[f] | 0;
  if (ot === FO_STMT) {
    stmtSpanWithoutExport(a);
    return;
  }
  if (ot === FO_MEMBER && (k === FN_METHOD || k === FN_GETTER || k === FN_SETTER || k === FN_CONSTRUCTOR) && !memberIsSignature(a)) {
    funcSpanFromParams(f);
    return;
  }
  if (ot === FO_EXPR && (k === FN_METHOD || k === FN_GETTER || k === FN_SETTER)) {
    funcSpanFromParams(f);
    return;
  }
  if (ot === FO_EXPR) {
    exprSpan(a);
    return;
  }
  if (ot === FO_MEMBER) {
    memberSpan(a);
    return;
  }
  if (ot === FO_TYPE) {
    SP[0] = hir.typePos[a] | 0;
    SP[1] = hir.typeEnd[a] | 0;
    return;
  }
  SP[0] = 0;
  SP[1] = 0;
}

/** `Func::close_paren`: the position of the `)` of the parameters. -1 for an arrow function without parentheses, and for a static block. */
export function funcCloseParen(f: number): number {
  const text = hir.text;
  const len = hir.sourceLen | 0;
  const np = hir.fnParamsLen[f] | 0;
  let last = -1;
  if (np > 0) last = hir.ids[((hir.fnParamsStart[f] | 0) + np - 1) | 0] | 0;
  else last = hir.fnThisParam[f] | 0;
  const open = funcOpenParen(f);
  let at = 0;
  if (last >= 0) {
    paramSpan(last);
    at = skipTrivia(text, len, SP[1] | 0);
  } else if (open >= 0) {
    at = skipTrivia(text, len, open + 1);
  } else if ((hir.fnKind[f] | 0) === FN_ARROW) {
    // `() => ..`, `<T>() => ..`, `async () => ..`
    const ret = hir.fnRet[f] | 0;
    let before = hir.fnAnchor[f] | 0;
    if (ret >= 0) {
      typeAnnotationSpan(ret);
      before = SP[0] | 0;
    }
    const e = fileEndOfTokenBefore(before);
    return e > 0 ? (e - 1) | 0 : 0;
  } else {
    return -1;
  }
  if (at < len && (text[at] | 0) === 44) at = skipTrivia(text, len, at + 1);
  const close = (hir.fnKind[f] | 0) === FN_INDEX_SIGNATURE ? 93 : 41;
  return at < len && (text[at] | 0) === close ? at : -1;
}

/** `Func::params_span` into `SP`: from the `(` to the `)` of the parameters. For an arrow function without parentheses, the parameter. For an index signature, the brackets. */
export function funcParamsSpan(f: number): boolean {
  const close = funcCloseParen(f);
  if (close < 0) {
    if ((hir.fnParamsLen[f] | 0) > 0) {
      paramSpan(hir.ids[hir.fnParamsStart[f] | 0] | 0);
      return true;
    }
    return false;
  }
  let open = funcOpenParen(f);
  if (open < 0) {
    // the first of `params_with_this`
    let first = close;
    const tp = hir.fnThisParam[f] | 0;
    if (tp >= 0) {
      first = hir.paramPos[tp] | 0;
    } else if ((hir.fnParamsLen[f] | 0) > 0) {
      paramSpan(hir.ids[hir.fnParamsStart[f] | 0] | 0);
      first = SP[0] | 0;
    }
    const e = fileEndOfTokenBefore(first);
    open = e > 0 ? (e - 1) | 0 : 0;
  }
  SP[0] = open;
  SP[1] = (close + 1) | 0;
  return true;
}

// ───────────────────────────── Param ─────────────────────────────
// `pat: ty = default`, `...pat`, `pat?`, `private pat`

export function paramPat(p: number): number {
  return hir.paramPat[p] | 0;
}
/** The type annotation (TypeNodeId or -1). */
export function paramTy(p: number): number {
  return hir.paramTy[p] | 0;
}
/** The default (ExprId or -1). */
export function paramDefault(p: number): number {
  return hir.paramDefault[p] | 0;
}
/** `REST`, `OPTIONAL`, `PARAMETER_PROPERTY`, and the modifiers. */
export function paramFlags(p: number): number {
  return hir.paramFlags[p] | 0;
}
export function paramIsRest(p: number): boolean {
  return ((hir.paramFlags[p] | 0) & FLAG_REST) !== 0;
}
export function paramIsOptional(p: number): boolean {
  const f = hir.paramFlags[p] | 0;
  return (f & FLAG_OPTIONAL) !== 0 && (f & FLAG_REPARSED) === 0;
}
/** `constructor(private x)`: it also declares a property of the class. */
export function paramIsParameterProperty(p: number): boolean {
  return ((hir.paramFlags[p] | 0) & FLAG_PARAMETER_PROPERTY) !== 0;
}
/** Keywords and decorators, in source order: a list of ModifierIds. */
export function paramModifiersStart(p: number): number {
  return hir.paramModStart[p] | 0;
}
export function paramModifiersLen(p: number): number {
  return hir.paramModLen[p] | 0;
}
/** `Param::func`: the function it is a parameter of (FnId or -1). */
export function paramFuncOf(p: number): number {
  return bound.paramFn[p] | 0;
}

/** `Param::span` into `SP`: from its first token, which can be a decorator, a modifier or the `...`. */
export function paramSpan(p: number): void {
  const pos = hir.paramPos[p] | 0;
  const locEnd = hir.paramLocEnd[p] | 0;
  patSpan(hir.paramPat[p] | 0);
  const patEnd = SP[1] | 0;
  let end = 0;
  if (locEnd === 0) {
    end = pos;
    if (patEnd > end) end = patEnd;
    const ty = hir.paramTy[p] | 0;
    if (ty >= 0) {
      const te = typeEnd(ty);
      if (te > end) end = te;
    }
    const d = hir.paramDefault[p] | 0;
    if (d >= 0) {
      const de = exprOuterEnd(d);
      if (de > end) end = de;
    }
  } else {
    // The HIR has the end of a name that is written with an escape too early.
    end = locEnd > patEnd ? locEnd : patEnd;
  }
  SP[0] = pos;
  SP[1] = end;
}

/** `Param::binding_span` into `SP`: the pattern, the `?` and the type annotation. The range of ESLint's `Identifier`, `ObjectPattern` or `ArrayPattern` for the parameter. */
export function paramBindingSpan(p: number): void {
  patSpan(hir.paramPat[p] | 0);
  const ps = SP[0] | 0;
  const pe = SP[1] | 0;
  const ty = hir.paramTy[p] | 0;
  let end = pe;
  if (ty >= 0) end = typeOuterEndOf(ty);
  else if (paramIsOptional(p)) end = (skipTrivia(hir.text, hir.sourceLen | 0, pe) + 1) | 0;
  SP[0] = ps;
  SP[1] = end;
}
function typeOuterEndOf(t: number): number {
  typeOuterStart(t);
  return SP[1] | 0;
}

/** `Param::span_without_modifiers` into `SP`: without decorators and modifiers. The range of ESLint's node for the parameter. */
export function paramSpanWithoutModifiers(p: number): void {
  paramSpan(p);
  const ws = SP[0] | 0;
  const we = SP[1] | 0;
  const ml = hir.paramModLen[p] | 0;
  let start = ws;
  if (ml > 0) {
    const last = hir.ids[((hir.paramModStart[p] | 0) + ml - 1) | 0] | 0;
    modifierSpan(last);
    start = skipTrivia(hir.text, hir.sourceLen | 0, SP[1] | 0);
  }
  SP[0] = start;
  SP[1] = we;
}

// ───────────────────────────── TypeParam ─────────────────────────────
// `const in out T extends C = D`

/** The atom of the name; `typeParamNamePos` is where it is written. */
export function typeParamName(p: number): number {
  return hir.typeParamName[p] | 0;
}
export function typeParamNamePos(p: number): number {
  return hir.typeParamPos[p] | 0;
}
export function typeParamConstraint(p: number): number {
  return hir.typeParamConstraint[p] | 0;
}
export function typeParamDefault(p: number): number {
  return hir.typeParamDefault[p] | 0;
}
/** `CONST`, `IN`, `OUT` */
export function typeParamFlags(p: number): number {
  return hir.typeParamFlags[p] | 0;
}
export function typeParamSpan(p: number): void {
  SP[0] = hir.typeParamStart[p] | 0;
  SP[1] = hir.typeParamEnd[p] | 0;
}
/** `const`, and the variance (`+`, `-`, `in`, `out`): a list of ModifierIds. */
export function typeParamModifiersStart(p: number): number {
  return hir.typeParamModStart[p] | 0;
}
export function typeParamModifiersLen(p: number): number {
  return hir.typeParamModLen[p] | 0;
}
/** `TypeParam::parent`: a `Func`, a `Class`, the `Stmt` of an interface or a type alias, or the `TypeNode` of an `infer` or a mapped type (a Node). */
export function typeParamParent(p: number): number {
  return nodeParent((9 << 26) | p);
}

// ───────────────────────────── keys ─────────────────────────────


/**
 * `Key::new`: derives the key of the owner (`ownerKind`, `ownerId`) into `KEY`. Returns the kind (`KEY_NONE` if there is no key). The inputs: the
 * `PropKey` kind, its value, the `NameKind`, and where the name starts.
 */
function keyFrom(pkKind: number, pkVal: number, nameKind: number, start: number): number {
  const text = hir.text;
  const len = hir.sourceLen | 0;
  const c = start >= 0 && start < len ? text[start] | 0 : -1;
  KEY[KEY_NAME] = -1;
  KEY[KEY_EXPR] = -1;
  KEY[KEY_START] = start;
  KEY[KEY_JSX] = 0;
  let kind = -1;
  if (pkKind === PK_NAME && nameKind === NK_IDENTIFIER && c >= 0 && c !== 34 && c !== 39 && !(c >= 48 && c <= 57)) {
    KEY[KEY_NAME] = pkVal;
    KEY[KEY_KIND] = KEY_IDENT;
    return KEY_IDENT;
  }
  // `new_in_general`
  if (pkKind === PK_NONE) {
    if (c === 35) {
      // `#name` that is not in a class
      const e = tokenEnd(text, len, start, false);
      KEY[KEY_NAME] = F.names.atomOfBytes(text, start, e);
      kind = KEY_PRIVATE;
    } else {
      kind = keyOfBigint(start);
      if (kind < 0) {
        KEY[KEY_KIND] = KEY_NONE;
        return KEY_NONE;
      }
    }
  } else if (pkKind === PK_PRIVATE) {
    KEY[KEY_NAME] = pkVal;
    kind = KEY_PRIVATE;
  } else if (pkKind === PK_COMPUTED) {
    KEY[KEY_EXPR] = pkVal;
    kind = KEY_COMPUTED;
  } else {
    KEY[KEY_NAME] = pkVal;
    switch (nameKind) {
      case NK_IDENTIFIER:
        if (c === 34 || c === 39) {
          kind = KEY_STRING;
        } else if (c >= 48 && c <= 57) {
          const k = keyOfBigint(start);
          if (k >= 0) {
            kind = k;
          } else {
            KEY[KEY_NAME] = pkVal;
            kind = KEY_IDENT;
          }
        } else {
          kind = KEY_IDENT;
        }
        break;
      case NK_JSX:
        kind = KEY_IDENT;
        break;
      case NK_STRING_LITERAL:
        kind = KEY_STRING;
        break;
      case NK_NUMERIC_LITERAL:
        kind = KEY_NUMBER;
        break;
      case NK_COMPUTED_STRING:
        kind = KEY_COMPUTED_STRING;
        break;
      default:
        kind = KEY_COMPUTED_NUMBER;
        break;
    }
  }
  KEY[KEY_KIND] = kind;
  KEY[KEY_JSX] = nameKind === NK_JSX ? 1 : 0;
  return kind;
}

/** `KeyKind::of_bigint`: the HIR has no name for a `bigint`; the literal as it is written, in decimal. Sets `KEY[KEY_NAME]`; -1 if it is none. */
function keyOfBigint(start: number): number {
  const text = hir.text;
  const len = hir.sourceLen | 0;
  if (start >= len) return -1;
  const first = text[start] | 0;
  if (!(first >= 48 && first <= 57)) return -1;
  const end = tokenEnd(text, len, start, false);
  if (end <= start || (text[end - 1] | 0) !== 110) return -1;
  decimalDigits(text, start, end - 1);
  KEY[KEY_NAME] = F.names.atomOfBytes(BIGINT_SCRATCH.data, 0, BIGINT_SCRATCH.len);
  return KEY_NUMBER;
}

/** The value of the `bigint` literal `text[s, e)` (without the `n`) in decimal, into `BIGINT_SCRATCH`. */
function decimalDigits(text: Uint8Array, s: number, e: number): void {
  let radix = 10;
  let from = s;
  if (e - s >= 2 && (text[s] | 0) === 48) {
    const x = text[s + 1] | 0;
    if (x === 120 || x === 88) {
      radix = 16;
      from = s + 2;
    } else if (x === 111 || x === 79) {
      radix = 8;
      from = s + 2;
    } else if (x === 98 || x === 66) {
      radix = 2;
      from = s + 2;
    }
  }
  // The least significant first.
  const dec: number[] = [0];
  for (let i = from; i < e; i++) {
    const c = text[i] | 0;
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 102) d = c - 87;
    else if (c >= 65 && c <= 70) d = c - 55;
    if (d < 0 || d >= radix) continue;
    let carry = d;
    for (let k = 0; k < dec.length; k++) {
      const v = dec[k] * radix + carry;
      dec[k] = v % 10;
      carry = (v / 10) | 0;
    }
    while (carry > 0) {
      dec.push(carry % 10);
      carry = (carry / 10) | 0;
    }
  }
  while (dec.length > 1 && dec[dec.length - 1] === 0) dec.pop();
  BIGINT_SCRATCH.reset();
  for (let k = dec.length - 1; k >= 0; k--) BIGINT_SCRATCH.push(48 + dec[k]);
}

/** The `NameKind` of a member of a class, an interface or a type literal. */
function memberNameKind(m: number): number {
  const f = hir.memberFlags[m] | 0;
  const isString = (f & FLAG_STRING_NAME) !== 0;
  if ((f & FLAG_COMPUTED_NAME) !== 0) return isString ? NK_COMPUTED_STRING : NK_COMPUTED_NUMBER;
  if (isString) return NK_STRING_LITERAL;
  if ((f & FLAG_LITERAL_NAME) !== 0) return NK_NUMERIC_LITERAL;
  return NK_IDENTIFIER;
}

/** `Key::new` for the owner `k` (a Node of kind N_MEMBER, N_PROP, N_PAT_PROP or N_ENUM_MEMBER). Fills `KEY`; returns the kind (`KEY_NONE`: no key). */
export function keyLoad(k: number): number {
  const id = k & 67108863;
  switch (k >> 26) {
    case N_MEMBER: {
      const mk = hir.memberKind[id] | 0;
      if (mk !== MEMBER_PROPERTY && mk !== MEMBER_METHOD && mk !== MEMBER_GETTER && mk !== MEMBER_SETTER) {
        KEY[KEY_KIND] = KEY_NONE;
        return KEY_NONE;
      }
      return keyFrom(hir.memberKeyKind[id] | 0, hir.memberKeyVal[id] | 0, memberNameKind(id), hir.memberNamePos[id] | 0);
    }
    case N_PROP:
      if ((hir.propKind[id] | 0) === PROP_SPREAD) {
        KEY[KEY_KIND] = KEY_NONE;
        return KEY_NONE;
      }
      return keyFrom(hir.propKeyKind[id] | 0, hir.propKeyVal[id] | 0, hir.propNameKind[id] | 0, hir.propPos[id] | 0);
    case N_PAT_PROP:
      if ((hir.patPropIsRest[id] | 0) !== 0) {
        KEY[KEY_KIND] = KEY_NONE;
        return KEY_NONE;
      }
      return keyFrom(hir.patPropKeyKind[id] | 0, hir.patPropKeyVal[id] | 0, hir.patPropNameKind[id] | 0, hir.patPropKeyPos[id] | 0);
    case N_ENUM_MEMBER: {
      const computed = hir.enumMemberComputedName[id] | 0;
      if (computed >= 0) return keyFrom(PK_COMPUTED, computed, hir.enumMemberNameKind[id] | 0, hir.enumMemberPos[id] | 0);
      return keyFrom(PK_NAME, hir.enumMemberName[id] | 0, hir.enumMemberNameKind[id] | 0, hir.enumMemberPos[id] | 0);
    }
    default:
      KEY[KEY_KIND] = KEY_NONE;
      return KEY_NONE;
  }
}

/** `Key::kind()`: `KEY_*`, `KEY_NONE` for `None`. */
export function keyKind(k: number): number {
  return keyLoad(k);
}
/** The name of a key that has one (an atom): everything but `KEY_COMPUTED`. -1 otherwise. That of `#a` includes the `#`. */
export function keyName(k: number): number {
  return keyLoad(k) >= 0 ? KEY[KEY_NAME] | 0 : -1;
}
/** The `e` of a `KEY_COMPUTED` key (ExprId), else -1. */
export function keyExpr(k: number): number {
  return keyLoad(k) === KEY_COMPUTED ? KEY[KEY_EXPR] | 0 : -1;
}
/** Where the key starts (the `[` of a computed key, the quote, the name). */
export function keyStart(k: number): number {
  return keyLoad(k) >= 0 ? KEY[KEY_START] | 0 : -1;
}
/** `Key::is_computed`: it is written in brackets. */
export function keyIsComputed(k: number): boolean {
  const kind = keyLoad(k);
  return kind === KEY_COMPUTED || kind === KEY_COMPUTED_STRING || kind === KEY_COMPUTED_NUMBER;
}
export function keyIsPrivate(k: number): boolean {
  return keyLoad(k) === KEY_PRIVATE;
}
/** `Key::is_jsx`: it is the name of a JSX attribute. */
export function keyIsJsx(k: number): boolean {
  return keyLoad(k) >= 0 && (KEY[KEY_JSX] | 0) !== 0;
}
/** `Key::is(name)`: the property is named `lit` (it has a name that is the ASCII text). */
export function keyIs(k: number, lit: string): boolean {
  const kind = keyLoad(k);
  return kind >= 0 && kind !== KEY_COMPUTED && F.names.atomIs(KEY[KEY_NAME] | 0, lit);
}

/** The length of the ASCII name `text[start, ...)` if it and what follows it is ASCII without a `\`, else -1. */
function asciiNameLen(start: number): number {
  const text = hir.text;
  const len = hir.sourceLen | 0;
  if (start >= len) return -1;
  const c0 = text[start] | 0;
  const isPart0 = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95 || c0 === 36 || (c0 >= 48 && c0 <= 57);
  if (!isPart0 || (c0 >= 48 && c0 <= 57)) return -1;
  let i = start + 1;
  while (i < len) {
    const c = text[i] | 0;
    const isPart = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || (c >= 48 && c <= 57);
    if (!isPart) break;
    i = ((i | 0) + 1) | 0;
  }
  if (i < len) {
    const n = text[i] | 0;
    if (n === 92 || n >= 0x80) return -1;
  }
  return (i - start) | 0;
}

/** `jsx_identifier_end` of decl.rs (oxc's): where the identifier of JSX that starts at `at` ends. It can contain `-`. */
export function jsxIdentifierEndOxc(at: number): number {
  const text = hir.text;
  const len = hir.sourceLen | 0;
  let p = at;
  let isPastDash = false;
  while (p < len) {
    const b = text[p] | 0;
    if (b === 92 && isPastDash) break;
    const isName = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95 || b === 36 || b === 45 || b === 92;
    if (!(isName || (b >= 0x80 && whiteSpaceLen(text, len, p) === 0))) break;
    if (b === 45) isPastDash = true;
    // `\u{61}`. Only oxc takes an escape here.
    let inBraces = 0;
    if (b === 92 && p + 2 < len && (text[p + 1] | 0) === 117 && (text[p + 2] | 0) === 123) {
      for (let i = p + 1; i < len; i = ((i | 0) + 1) | 0) {
        if ((text[i] | 0) === 125) {
          inBraces = (i - p) | 0;
          break;
        }
      }
    }
    p = ((p | 0) + 1 + inBraces) | 0;
  }
  return p;
}

/** `File::jsx_namespace_and_name` into `SP[0..4]`: the `a` and the `b` of the JSX name `a:b` that starts at `start`; false if the name has no colon. */
export function jsxNamespaceAndName(start: number): boolean {
  const text = hir.text;
  const len = hir.sourceLen | 0;
  const nsEnd = jsxIdentifierEndOxc(start);
  const colon = skipTrivia(text, len, nsEnd);
  if (colon >= len || (text[colon] | 0) !== 58) return false;
  const name = skipTrivia(text, len, colon + 1);
  SP[0] = start;
  SP[1] = nsEnd;
  SP[2] = name;
  SP[3] = jsxIdentifierEndOxc(name);
  return true;
}

function keySpanGeneral(inner: boolean): void {
  const text = hir.text;
  const len = hir.sourceLen | 0;
  const kind = KEY[KEY_KIND] | 0;
  const start = KEY[KEY_START] | 0;
  if (kind === KEY_COMPUTED) {
    const e = KEY[KEY_EXPR] | 0;
    if (inner) {
      exprSpan(e);
      return;
    }
    const end = (skipTrivia(text, len, exprOuterEnd(e)) + 1) | 0;
    SP[0] = start;
    SP[1] = end;
    return;
  }
  if (kind === KEY_COMPUTED_STRING || kind === KEY_COMPUTED_NUMBER) {
    const literal = skipTrivia(text, len, start + 1);
    const litEnd = tokenEnd(text, len, literal, false);
    if (inner) {
      SP[0] = literal;
      SP[1] = litEnd;
      return;
    }
    SP[0] = start;
    SP[1] = (skipTrivia(text, len, litEnd) + 1) | 0;
    return;
  }
  let end = 0;
  if ((KEY[KEY_JSX] | 0) !== 0) {
    end = jsxIdentifierEndOxc(start);
    const colon = skipTrivia(text, len, end);
    if (colon < len && (text[colon] | 0) === 58) end = jsxIdentifierEndOxc(skipTrivia(text, len, colon + 1));
  } else {
    end = tokenEnd(text, len, start, false);
  }
  SP[0] = start;
  SP[1] = end;
}

/** `Key::span(file)` into `SP`: with the brackets or the quotes. False if there is no key. */
export function keySpan(k: number): boolean {
  const kind = keyLoad(k);
  if (kind < 0) return false;
  if (kind === KEY_IDENT && (KEY[KEY_JSX] | 0) === 0) {
    const start = KEY[KEY_START] | 0;
    const n = asciiNameLen(start);
    if (n >= 0) {
      SP[0] = start;
      SP[1] = (start + n) | 0;
      return true;
    }
  }
  keySpanGeneral(false);
  return true;
}

/** `Key::inner_span(file)` into `SP`: without the brackets: the range of ESLint's `key`. */
export function keyInnerSpan(k: number): boolean {
  const kind = keyLoad(k);
  if (kind < 0) return false;
  if (kind === KEY_IDENT && (KEY[KEY_JSX] | 0) === 0) {
    const start = KEY[KEY_START] | 0;
    const n = asciiNameLen(start);
    if (n >= 0) {
      SP[0] = start;
      SP[1] = (start + n) | 0;
      return true;
    }
  }
  keySpanGeneral(true);
  return true;
}

// ───────────────────────────── classes ─────────────────────────────
// A class declaration or expression. Like a Func, it belongs to its `classOwner`.

/** The atom of the name (-1: none); `classNamePos` is where it is written. */
export function className(c: number): number {
  return hir.className[c] | 0;
}
export function classNamePos(c: number): number {
  return hir.classNamePos[c] | 0;
}
/** `ABSTRACT`, `AMBIENT`, `EXPORT`, `DEFAULT` */
export function classFlags(c: number): number {
  return hir.classFlags[c] | 0;
}
export function classTypeParamsStart(c: number): number {
  return hir.classTypeParamsStart[c] | 0;
}
export function classTypeParamsLen(c: number): number {
  return hir.classTypeParamsLen[c] | 0;
}
/** The `B` of `extends B<Args>` (ExprId or -1). */
export function classExtends(c: number): number {
  return hir.classExtends[c] | 0;
}
/** The `Args` of `extends B<Args>`: a list of TypeNodeIds. */
export function classExtendsArgsStart(c: number): number {
  return hir.classExtendsArgsStart[c] | 0;
}
export function classExtendsArgsLen(c: number): number {
  return hir.classExtendsArgsLen[c] | 0;
}
export function classImplementsStart(c: number): number {
  return hir.classImplementsStart[c] | 0;
}
export function classImplementsLen(c: number): number {
  return hir.classImplementsLen[c] | 0;
}
export function classMembersStart(c: number): number {
  return hir.classMembersStart[c] | 0;
}
export function classMembersLen(c: number): number {
  return hir.classMembersLen[c] | 0;
}
/** Keywords and decorators, in source order: a list of ModifierIds. Decorators: the modifiers with `modifierDecorator(m) >= 0`. */
export function classModifiersStart(c: number): number {
  return hir.classModStart[c] | 0;
}
export function classModifiersLen(c: number): number {
  return hir.classModLen[c] | 0;
}
export function classStartPos(c: number): number {
  return hir.classStart[c] | 0;
}

/** `Class::owner`: the Stmt or the Expr that it is (a Node; `NODE_FILE` if none). */
export function classOwner(c: number): number {
  const a = bound.classOwnerA[c] | 0;
  switch (bound.classOwnerTag[c] | 0) {
    case CO_EXPR:
      return nodeOfExpr(a);
    case CO_STMT:
      return a >= 0 ? nodeOfStmt(a) : NODE_FILE;
    default:
      return NODE_FILE;
  }
}

/** `Class::span` into `SP`: from its first token, which can be a decorator or a modifier. */
export function classSpan(c: number): void {
  const start = hir.classStart[c] | 0;
  const a = bound.classOwnerA[c] | 0;
  let end = 0;
  switch (bound.classOwnerTag[c] | 0) {
    case CO_EXPR:
      end = a >= 0 ? hir.exprEnd[a] | 0 : 0;
      break;
    case CO_STMT:
      end = a >= 0 ? hir.stmtLocEnd[a] | 0 : 0;
      break;
    default:
      break;
  }
  SP[0] = start;
  SP[1] = end > start ? end : start;
}

/** `Class::estree_span` into `SP`: the range of ESLint's `ClassDeclaration` or `ClassExpression`: without `export` and `export default`, and without the decorators before them. */
export function classEstreeSpan(c: number): void {
  if ((bound.classOwnerTag[c] | 0) === CO_STMT && (bound.classOwnerA[c] | 0) >= 0) {
    stmtSpanWithoutExport(bound.classOwnerA[c] | 0);
    return;
  }
  classSpan(c);
}

/** `Class::keyword_span` into `SP`: the `class` keyword. */
export function classKeywordSpan(c: number): void {
  const ml = hir.classModLen[c] | 0;
  let start = hir.classStart[c] | 0;
  if (ml > 0) {
    const last = hir.ids[((hir.classModStart[c] | 0) + ml - 1) | 0] | 0;
    modifierSpan(last);
    start = skipTrivia(hir.text, hir.sourceLen | 0, SP[1] | 0);
  }
  SP[0] = start;
  SP[1] = (start + 5) | 0;
}

/** `Class::body_span` into `SP`: the `{ .. }` around the members. */
export function classBodySpan(c: number): void {
  const text = hir.text;
  const len = hir.sourceLen | 0;
  // The last thing before the `{`.
  let headEnd = -1;
  const il = hir.classImplementsLen[c] | 0;
  if (il > 0) {
    headEnd = typeEnd(hir.ids[((hir.classImplementsStart[c] | 0) + il - 1) | 0] | 0);
  } else if (typeListAngleBrackets(hir.classExtendsArgsStart[c] | 0, hir.classExtendsArgsLen[c] | 0)) {
    headEnd = SP[1] | 0;
  } else if ((hir.classExtends[c] | 0) >= 0) {
    headEnd = exprOuterEnd(hir.classExtends[c] | 0);
  } else if (typeParamListAngleBrackets(hir.classTypeParamsStart[c] | 0, hir.classTypeParamsLen[c] | 0)) {
    headEnd = SP[1] | 0;
  } else if ((hir.className[c] | 0) >= 0) {
    headEnd = identEndOf(hir.className[c] | 0, hir.classNamePos[c] | 0);
  } else {
    classKeywordSpan(c);
    headEnd = SP[1] | 0;
  }
  let start = skipTrivia(text, len, headEnd);
  // `class A extends B, {}`: TypeScript's parser takes the comma, and its checker reports it.
  if (start < len && (text[start] | 0) === 44) start = skipTrivia(text, len, start + 1);
  classSpan(c);
  SP[0] = start;
}

// ───────────────────────────── Member ─────────────────────────────
// A member of a class, an interface or a type literal. Its key: `keyKind(nodeOfMember(m))` etc.

export function memberKind(m: number): number {
  return hir.memberKind[m] | 0;
}
/** `STATIC`, `READONLY`, `OPTIONAL`, `DEFINITE`, `ABSTRACT`, `OVERRIDE`, `ACCESSOR`, `AMBIENT`, `PUBLIC`, `PROTECTED`, `PRIVATE` */
export function memberFlags(m: number): number {
  return hir.memberFlags[m] | 0;
}
export function memberIsStatic(m: number): boolean {
  return ((hir.memberFlags[m] | 0) & FLAG_STATIC) !== 0;
}
/** `Member::is_signature`: it is in an interface or a type literal, not in a class. */
export function memberIsSignature(m: number): boolean {
  const t = bound.memberOwnerTag[m] | 0;
  return t === MO_INTERFACE || t === MO_TYPE_LITERAL;
}
/** `Member::is_constructor`: ESLint's `kind === "constructor"`: a `Constructor` that is not `static`. */
export function memberIsConstructor(m: number): boolean {
  const f = hir.memberFlags[m] | 0;
  if ((f & FLAG_STATIC) !== 0) return false;
  const k = hir.memberKind[m] | 0;
  if (k === MEMBER_CONSTRUCTOR) return true;
  if (k === MEMBER_METHOD) {
    return (
      (f & FLAG_STRING_NAME) !== 0 && (f & FLAG_COMPUTED_NAME) === 0 && !memberIsSignature(m) && keyIs(nodeOfMember(m), "constructor")
    );
  }
  return false;
}
/** `Member::constructor_keyword`: the atom of the `constructor` of a constructor (-1 if it is not one); `memberNamePos` is where it is written. */
export function memberConstructorKeyword(m: number): number {
  return (hir.memberKind[m] | 0) === MEMBER_CONSTRUCTOR && (hir.memberKeyKind[m] | 0) === PK_NAME ? hir.memberKeyVal[m] | 0 : -1;
}
export function memberNamePos(m: number): number {
  return hir.memberNamePos[m] | 0;
}
/** `Member::computed_key`: the `e` of a key that is `KEY_COMPUTED` (ExprId or -1). */
export function memberComputedKey(m: number): number {
  const k = hir.memberKind[m] | 0;
  if ((k === MEMBER_PROPERTY || k === MEMBER_METHOD || k === MEMBER_GETTER || k === MEMBER_SETTER) && (hir.memberKeyKind[m] | 0) === PK_COMPUTED) {
    return hir.memberKeyVal[m] | 0;
  }
  return -1;
}
/** The type annotation of a property (TypeNodeId or -1). */
export function memberTy(m: number): number {
  return (hir.memberFunc[m] | 0) >= 0 ? -1 : hir.memberTy[m] | 0;
}
/** The initializer of a property (ExprId or -1). */
export function memberInit(m: number): number {
  return hir.memberInit[m] | 0;
}
/** The function of anything but a property (FnId or -1). */
export function memberFunc(m: number): number {
  return hir.memberFunc[m] | 0;
}
/** Keywords and decorators, in source order: a list of ModifierIds. */
export function memberModifiersStart(m: number): number {
  return hir.memberModStart[m] | 0;
}
export function memberModifiersLen(m: number): number {
  return hir.memberModLen[m] | 0;
}
/** `Member::span` into `SP`: from its first token, which can be a decorator or a modifier. Its `;` or `,` is part of it. */
export function memberSpan(m: number): void {
  SP[0] = hir.memberStart[m] | 0;
  SP[1] = hir.memberLocEnd[m] | 0;
}

// ───────────────────────────── Modifier ─────────────────────────────
// A keyword before a declaration, or a decorator.

/** `Modifier::flag`: the `FLAG_*` of a keyword. 0 for a decorator. */
export function modifierFlagOf(m: number): number {
  return (hir.modifierKind[m] | 0) === MODK_KEYWORD ? hir.modifierValue[m] | 0 : 0;
}
/** `Modifier::decorator`: the `e` of `@e` (ExprId), else -1. */
export function modifierDecorator(m: number): number {
  return (hir.modifierKind[m] | 0) === MODK_DECORATOR ? hir.modifierValue[m] | 0 : -1;
}
/** `modifier_text(flag).len()` */
export function modifierTextLen(flag: number): number {
  switch (flag) {
    case FLAG_ABSTRACT:
      return 8;
    case FLAG_ACCESSOR:
      return 8;
    case FLAG_ASYNC:
      return 5;
    case FLAG_CONST:
      return 5;
    case FLAG_AMBIENT:
      return 7;
    case FLAG_DEFAULT:
      return 7;
    case FLAG_EXPORT:
      return 6;
    case FLAG_IN:
      return 2;
    case FLAG_OUT:
      return 3;
    case FLAG_OVERRIDE:
      return 8;
    case FLAG_PRIVATE:
      return 7;
    case FLAG_PROTECTED:
      return 9;
    case FLAG_PUBLIC:
      return 6;
    case FLAG_READONLY:
      return 8;
    case FLAG_STATIC:
      return 6;
    default:
      return 0;
  }
}
/** `Modifier::span` into `SP`. */
export function modifierSpan(m: number): void {
  const start = hir.modifierPos[m] | 0;
  if ((hir.modifierKind[m] | 0) === MODK_DECORATOR) {
    SP[0] = start;
    SP[1] = exprOuterEnd(hir.modifierValue[m] | 0);
  } else {
    SP[0] = start;
    SP[1] = (start + modifierTextLen(hir.modifierValue[m] | 0)) | 0;
  }
}
export function modifierStart(m: number): number {
  return hir.modifierPos[m] | 0;
}

// ───────────────────────────── Prop ─────────────────────────────
// A property of an object literal, or an attribute of a JSX element. Its key: `keyKind(nodeOfProp(p))` etc.

export function propKind(p: number): number {
  return hir.propKind[p] | 0;
}
/** `Prop::has_computed_key` */
export function propHasComputedKey(p: number): boolean {
  return (hir.propKind[p] | 0) !== PROP_SPREAD && keyKindIsComputed(hir.propKeyKind[p] | 0, hir.propNameKind[p] | 0);
}
function keyKindIsComputed(pk: number, nameKind: number): boolean {
  if (pk === PK_COMPUTED) return true;
  if (pk === PK_NAME) return nameKind === NK_COMPUTED_STRING || nameKind === NK_COMPUTED_NUMBER;
  return false;
}
/** `Prop::computed_key`: the `e` of a key that is `KEY_COMPUTED` (ExprId or -1). */
export function propComputedKey(p: number): number {
  return (hir.propKind[p] | 0) !== PROP_SPREAD && (hir.propKeyKind[p] | 0) === PK_COMPUTED ? hir.propKeyVal[p] | 0 : -1;
}
/**
 * - `PROP_INIT`: the value. -1 for a JSX attribute without one.
 * - `PROP_SHORTHAND`: the identifier. In a destructuring assignment `{ a = 1 }` it is an `Assign` of the default to the identifier.
 * - `PROP_SPREAD`: what is spread.
 * - `PROP_METHOD`, `PROP_GETTER`, `PROP_SETTER`: an `EXPR_FN`.
 */
export function propValue(p: number): number {
  return hir.propValue[p] | 0;
}
/** `Prop::func`: the function of a method or an accessor (FnId or -1). */
export function propFunc(p: number): number {
  const k = hir.propKind[p] | 0;
  if (k === PROP_METHOD || k === PROP_GETTER || k === PROP_SETTER) {
    const v = hir.propValue[p] | 0;
    if (v >= 0 && (hir.exprTag[v] | 0) === EXPR_FN) return hir.exprA[v] | 0;
  }
  return -1;
}
/** `Prop::is_optional`: `a?() {}`, which is an error. */
export function propIsOptional(p: number): boolean {
  const at = hir.propPostfixToken[p] | 0;
  return at !== 0 && (hir.text[at] | 0) === 63;
}
export function propIsJsxAttribute(p: number): boolean {
  return (hir.propNameKind[p] | 0) === NK_JSX;
}
/** `Prop::is_import_attribute`: it is a `key: "value"` of `with { .. }`. It is not a node of the tree, its value is. */
export function propIsImportAttribute(p: number): boolean {
  return isImportAttribute(p);
}
/** `Prop::span` into `SP`: from its first token: `async`, `get`, `set`, `*`, `...`, or the name. */
export function propSpan(p: number): void {
  const end = hir.propEnd[p] | 0;
  let e = end;
  if (end === 0) {
    const v = hir.propValue[p] | 0;
    e = v >= 0 ? exprOuterEnd(v) : hir.propPos[p] | 0;
  }
  SP[0] = hir.propStart[p] | 0;
  SP[1] = e;
}
export function propModifiersStart(p: number): number {
  return hir.propModStart[p] | 0;
}
export function propModifiersLen(p: number): number {
  return hir.propModLen[p] | 0;
}
/** `Prop::parent`: the object literal or the JSX element (a Node); for an import attribute, the `Stmt` of the import or the export, or the `TypeNode` of the import type. */
export function propParent(p: number): number {
  return nodeParent(nodeOfProp(p));
}

// ───────────────────────────── type declarations ─────────────────────────────
// Interface, Alias, Enum, Module, Import, ImportEquals, Export: stored beside their statement (`stmtInterfaceInterface(s)`, ...). Their span is
// their statement's.

/** `Interface` ids: `hir.interfaceStmt[i]` is the statement. */
export function interfaceStmt(i: number): number {
  return hir.interfaceStmt[i] | 0;
}
export function interfaceName(i: number): number {
  return hir.interfaceName[i] | 0;
}
export function interfaceNamePos(i: number): number {
  return hir.interfaceNamePos[i] | 0;
}
export function interfaceFlags(i: number): number {
  return hir.interfaceFlags[i] | 0;
}
export function interfaceTypeParamsStart(i: number): number {
  return hir.interfaceTypeParamsStart[i] | 0;
}
export function interfaceTypeParamsLen(i: number): number {
  return hir.interfaceTypeParamsLen[i] | 0;
}
/** The `extends`: a list of TypeNodeIds. */
export function interfaceExtendsStart(i: number): number {
  return hir.interfaceExtendsStart[i] | 0;
}
export function interfaceExtendsLen(i: number): number {
  return hir.interfaceExtendsLen[i] | 0;
}
export function interfaceMembersStart(i: number): number {
  return hir.interfaceMembersStart[i] | 0;
}
export function interfaceMembersLen(i: number): number {
  return hir.interfaceMembersLen[i] | 0;
}
/** `Interface::body_span` into `SP`: the `{ .. }` around the members. */
export function interfaceBodySpan(i: number): void {
  const text = hir.text;
  const len = hir.sourceLen | 0;
  let headEnd = -1;
  const el = hir.interfaceExtendsLen[i] | 0;
  if (el > 0) headEnd = typeEnd(hir.ids[((hir.interfaceExtendsStart[i] | 0) + el - 1) | 0] | 0);
  else if (typeParamListAngleBrackets(hir.interfaceTypeParamsStart[i] | 0, hir.interfaceTypeParamsLen[i] | 0)) headEnd = SP[1] | 0;
  else headEnd = identEndOf(hir.interfaceName[i] | 0, hir.interfaceNamePos[i] | 0);
  const start = skipTrivia(text, len, headEnd);
  stmtSpan(hir.interfaceStmt[i] | 0);
  SP[0] = start;
}

export function aliasName(a: number): number {
  return hir.aliasName[a] | 0;
}
export function aliasNamePos(a: number): number {
  return hir.aliasNamePos[a] | 0;
}
export function aliasFlags(a: number): number {
  return hir.aliasFlags[a] | 0;
}
export function aliasTypeParamsStart(a: number): number {
  return hir.aliasTypeParamsStart[a] | 0;
}
export function aliasTypeParamsLen(a: number): number {
  return hir.aliasTypeParamsLen[a] | 0;
}
export function aliasTy(a: number): number {
  return hir.aliasTy[a] | 0;
}

export function enumName(e: number): number {
  return hir.enumName[e] | 0;
}
export function enumNamePos(e: number): number {
  return hir.enumNamePos[e] | 0;
}
/** `CONST`, `AMBIENT`, `EXPORT` */
export function enumFlags(e: number): number {
  return hir.enumFlags[e] | 0;
}
export function enumMembersStart(e: number): number {
  return hir.enumMembersStart[e] | 0;
}
export function enumMembersLen(e: number): number {
  return hir.enumMembersLen[e] | 0;
}
/** `Enum::body_span` into `SP`: the `{ .. }` around the members. */
export function enumBodySpan(e: number): void {
  const start = skipTrivia(hir.text, hir.sourceLen | 0, identEndOf(hir.enumName[e] | 0, hir.enumNamePos[e] | 0));
  stmtSpan(hir.enumStmt[e] | 0);
  SP[0] = start;
}

// EnumMember: `A = init`. Its key: `keyKind(nodeOfEnumMember(m))` etc.
/** `EnumMember::computed_key`: the `e` of a key that is `KEY_COMPUTED` (ExprId or -1). */
export function enumMemberComputedKey(m: number): number {
  return hir.enumMemberComputedName[m] | 0;
}
export function enumMemberInit(m: number): number {
  return hir.enumMemberInit[m] | 0;
}
export function enumMemberSpan(m: number): void {
  SP[0] = hir.enumMemberPos[m] | 0;
  SP[1] = hir.enumMemberLocEnd[m] | 0;
}
/** `EnumMember::parent`: the `Stmt` of the enum (a Node). */
export function enumMemberParent(m: number): number {
  return nodeParent((15 << 26) | m);
}

// Module: `namespace N { .. }`, `module N { .. }`, `declare module "m" { .. }`, `declare global { .. }`. `namespace A.B { .. }` is stored as a
// namespace `A` with the one statement `B { .. }`: `moduleNested`. That statement is not a node.

/** `ModuleName`: `MODNAME_IDENT`, `MODNAME_STRING` or `MODNAME_GLOBAL`. */
export function moduleNameKind(m: number): number {
  return hir.moduleNameKind[m] | 0;
}
/** The atom of the name of an `Ident` or `String` module name (-1 for `global`); `moduleNamePos` is where it is written. */
export function moduleName(m: number): number {
  return (hir.moduleNameKind[m] | 0) === MODNAME_GLOBAL ? -1 : hir.moduleName[m] | 0;
}
export function moduleNamePos(m: number): number {
  return hir.moduleNamePos[m] | 0;
}
export function moduleStmt(m: number): number {
  return hir.moduleStmt[m] | 0;
}
/** `Module::has_body`: `declare module "m";` has none. */
export function moduleHasBody(m: number): boolean {
  return (hir.moduleHasBody[m] | 0) !== 0;
}
/** `Module::uses_module_keyword`: it is written with the keyword `module`, not `namespace`. */
export function moduleUsesModuleKeyword(m: number): boolean {
  return (hir.moduleSpecifiesModule[m] | 0) !== 0;
}
export function moduleFlags(m: number): number {
  return hir.moduleFlags[m] | 0;
}
/** The statements stored in this module (for the `A` of `A.B`, the `B { .. }`). */
export function moduleBodyStartOf(m: number): number {
  return hir.moduleBodyStart[m] | 0;
}
export function moduleBodyLenOf(m: number): number {
  return hir.moduleBodyLen[m] | 0;
}
/** `Module::nested`: the `B` of `namespace A.B` (ModuleId or -1). */
export function moduleNested(m: number): number {
  if ((hir.moduleBodyLen[m] | 0) !== 1) return -1;
  const s = hir.ids[hir.moduleBodyStart[m] | 0] | 0;
  if (s >= 0 && (hir.stmtTag[s] | 0) === STMT_MODULE && isNestedNamespace(s)) return hir.stmtA[s] | 0;
  return -1;
}
/** `Module::innermost`: the `C` of `namespace A.B.C { .. }`. Itself, if its name has no dots. */
export function moduleInnermost(m: number): number {
  let at = m;
  while (true) {
    const n = moduleNested(at);
    if (n < 0) return at;
    at = n;
  }
}
/** `Module::outermost`: the `A` of `namespace A.B.C { .. }`, which is the node. Itself, if it is that. */
export function moduleOutermost(m: number): number {
  const s = hir.moduleStmt[m] | 0;
  if (s >= 0 && isNestedNamespace(s)) {
    const p = nodeParent(nodeOfStmt(s));
    if (nodeKind(p) === 2) {
      const ps = nodeId(p);
      if ((hir.stmtTag[ps] | 0) === STMT_MODULE) return hir.stmtA[ps] | 0;
    }
  }
  return m;
}
/** `Module::body`: the statements between the braces, for each of the names of `namespace A.B.C { .. }`: a list of StmtIds (the innermost's). */
export function moduleBodyStart(m: number): number {
  return hir.moduleBodyStart[moduleInnermost(m)] | 0;
}
export function moduleBodyLen(m: number): number {
  return hir.moduleBodyLen[moduleInnermost(m)] | 0;
}
/** `Module::name_span` into `SP`: the name, where it is written. For `declare global`, the keyword. */
export function moduleNameSpan(m: number): void {
  const pos = hir.moduleNamePos[m] | 0;
  if ((hir.moduleNameKind[m] | 0) === MODNAME_GLOBAL) {
    SP[0] = pos;
    SP[1] = (pos + 6) | 0;
    return;
  }
  SP[0] = pos;
  SP[1] = identEndOf(hir.moduleName[m] | 0, pos);
}
/** `Module::body_span` into `SP`: the `{ .. }`, for each of the names of `namespace A.B.C { .. }`. */
export function moduleBodySpan(m: number): boolean {
  const last = moduleInnermost(m);
  if (!moduleHasBody(last)) return false;
  moduleNameSpan(last);
  const start = skipTrivia(hir.text, hir.sourceLen | 0, SP[1] | 0);
  stmtSpan(hir.moduleStmt[last] | 0);
  SP[0] = start;
  return true;
}

// Import: `import default, * as namespace from "spec"`, `import default, { named } from "spec"`, `import "spec"`
/** The module specifier (an atom). */
export function importSpec(i: number): number {
  return hir.importSpec[i] | 0;
}
/** The atom of the default import (-1: none); `importDefaultPos` is where it is written. */
export function importDefault(i: number): number {
  return hir.importDefault[i] | 0;
}
export function importDefaultPos(i: number): number {
  return hir.importDefaultPos[i] | 0;
}
/** The atom of the namespace import (-1: none); `importNamespacePos` is where it is written. */
export function importNamespace(i: number): number {
  return hir.importNamespace[i] | 0;
}
export function importNamespacePos(i: number): number {
  return hir.importNamespacePos[i] | 0;
}
/** `Import::namespace_span` into `SP`: `* as namespace`. */
export function importNamespaceSpan(i: number): boolean {
  const n = hir.importNamespace[i] | 0;
  if (n < 0) return false;
  SP[0] = hir.importNamespaceStart[i] | 0;
  SP[1] = identEndOf(n, hir.importNamespacePos[i] | 0);
  return true;
}
/** The named imports: a list of ImportSpecIds. */
export function importNamedStart(i: number): number {
  return hir.importNamedStart[i] | 0;
}
export function importNamedLen(i: number): number {
  return hir.importNamedLen[i] | 0;
}
/** It has `{ }`, which can be empty. */
export function importHasNamedImports(i: number): boolean {
  return (hir.importHasNamedImports[i] | 0) !== 0;
}
/** `import type ..` */
export function importIsTypeOnly(i: number): boolean {
  return (hir.importTypeOnly[i] | 0) !== 0;
}
/** `Import::phase`: 0 for a plain import, 1 for `import defer ..`, 2 for `import source ..`. */
export function importPhase(i: number): number {
  return (hir.importIsDeferred[i] | 0) !== 0 ? phaseAt(hir.importClauseStart[i] | 0) : 0;
}
export function importIsDeferred(i: number): boolean {
  return importPhase(i) === 1;
}
/** `Import::is_side_effect`: `import "spec"` */
export function importIsSideEffect(i: number): boolean {
  return (hir.importDefault[i] | 0) < 0 && (hir.importNamespace[i] | 0) < 0 && (hir.importHasNamedImports[i] | 0) === 0;
}
/** `Import::spec_span` into `SP`: the module specifier with its quotes. */
export function importSpecSpanOf(i: number): boolean {
  return stmtModuleSpecifierSpan(hir.importStmt[i] | 0);
}
/** `Import::attributes`: the row of `hir.importAttributes` of its `with { .. }`, or -1. */
export function importAttributes(i: number): number {
  return stmtImportAttributes(hir.importStmt[i] | 0);
}
/** `Import::clause_span` into `SP`: what is between `import` and `from`. */
export function importClauseSpan(i: number): void {
  SP[0] = hir.importClauseStart[i] | 0;
  SP[1] = hir.importClauseEnd[i] | 0;
}
export function importStmt(i: number): number {
  return hir.importStmt[i] | 0;
}

// ImportSpec: `imported as local`, `local`, `type local`
/** The atom of the name in the other module (it can be written as a string); `importSpecImportedPos` is where it is written. */
export function importSpecImported(s: number): number {
  return hir.importSpecImported[s] | 0;
}
export function importSpecImportedPos(s: number): number {
  return hir.importSpecImportedPos[s] | 0;
}
export function importSpecLocal(s: number): number {
  return hir.importSpecLocal[s] | 0;
}
export function importSpecLocalPos(s: number): number {
  return hir.importSpecPos[s] | 0;
}
/** `ImportSpec::is_renamed`: it has an `as`. */
export function importSpecIsRenamed(s: number): boolean {
  return (hir.importSpecImportedPos[s] | 0) !== (hir.importSpecPos[s] | 0);
}
/** `{ type a }` */
export function importSpecIsTypeOnly(s: number): boolean {
  return (hir.importSpecTypeOnly[s] | 0) !== 0;
}
/** `ImportSpec::import`: the ImportId. */
export function importSpecImport(s: number): number {
  return hir.importSpecImport[s] | 0;
}
export function importSpecSpan(s: number): void {
  SP[0] = hir.importSpecStart[s] | 0;
  SP[1] = hir.importSpecEnd[s] | 0;
}

// ImportEquals: `import name = require("spec")`, `import name = A.B.C`
export function importEqualsName(i: number): number {
  return hir.importEqualsName[i] | 0;
}
export function importEqualsNamePos(i: number): number {
  return hir.importEqualsNamePos[i] | 0;
}
/** The end of the name. */
export function importEqualsNameEnd(i: number): number {
  return identEndOf(hir.importEqualsName[i] | 0, hir.importEqualsNamePos[i] | 0);
}
/** `ImportEqualsTarget`: `IET_REQUIRE` (`importEqualsRequireSpec(i)`, an atom or -1) or `IET_ENTITY` (the entity name `(importEqualsEntityStart(i), importEqualsEntityLen(i))`). */
export function importEqualsTargetKind(i: number): number {
  return hir.importEqualsTargetKind[i] | 0;
}
export function importEqualsRequireSpec(i: number): number {
  return (hir.importEqualsTargetKind[i] | 0) === IET_REQUIRE ? hir.importEqualsTargetA[i] | 0 : -1;
}
export function importEqualsEntityStart(i: number): number {
  return hir.importEqualsTargetA[i] | 0;
}
export function importEqualsEntityLen(i: number): number {
  return hir.importEqualsTargetB[i] | 0;
}
/** `EXPORT`, `TYPE_ONLY` */
export function importEqualsFlags(i: number): number {
  return hir.importEqualsFlags[i] | 0;
}
/** `ImportEquals::require_span` into `SP`: `require("spec")`: the range of ESLint's `TSExternalModuleReference`. */
export function importEqualsRequireSpan(i: number): boolean {
  if (!stmtModuleSpecifierSpan(hir.importEqualsStmt[i] | 0)) return false;
  const specStart = SP[0] | 0;
  const specEnd = SP[1] | 0;
  const open0 = fileEndOfTokenBefore(specStart);
  const open = open0 > 0 ? (open0 - 1) | 0 : 0;
  const keywordEnd = fileEndOfTokenBefore(open);
  SP[0] = keywordEnd > 7 ? (keywordEnd - 7) | 0 : 0;
  SP[1] = (skipTrivia(hir.text, hir.sourceLen | 0, specEnd) + 1) | 0;
  return true;
}

// Export: `export { a as b }`, `export { a as b } from "spec"`
/** The module specifier after `from` (an atom), or -1. */
export function exportSpec(x: number): number {
  return hir.exportSpec[x] | 0;
}
export function exportHasFrom(x: number): boolean {
  return (hir.exportHasModuleSpecifier[x] | 0) !== 0;
}
/** The items: a list of ExportSpecIds. */
export function exportItemsStart(x: number): number {
  return hir.exportItemsStart[x] | 0;
}
export function exportItemsLen(x: number): number {
  return hir.exportItemsLen[x] | 0;
}
/** The end of the last item. */
export function exportItemsLastEnd(x: number): number {
  const n = hir.exportItemsLen[x] | 0;
  return hir.exportSpecEnd[hir.ids[((hir.exportItemsStart[x] | 0) + n - 1) | 0] | 0] | 0;
}
/** `export type { .. }` */
export function exportIsTypeOnly(x: number): boolean {
  return (hir.exportTypeOnly[x] | 0) !== 0;
}
export function exportSpecSpanOf(x: number): boolean {
  return stmtModuleSpecifierSpan(hir.exportStmt[x] | 0);
}
/** `Export::attributes`: the row of `hir.importAttributes`, or -1. */
export function exportAttributes(x: number): number {
  return stmtImportAttributes(hir.exportStmt[x] | 0);
}
export function exportStmt(x: number): number {
  return hir.exportStmt[x] | 0;
}

// ExportSpec: `local as exported`, `local`, `type local`
export function exportSpecLocal(s: number): number {
  return hir.exportSpecLocal[s] | 0;
}
export function exportSpecLocalPos(s: number): number {
  return hir.exportSpecLocalPos[s] | 0;
}
export function exportSpecExported(s: number): number {
  return hir.exportSpecExported[s] | 0;
}
export function exportSpecExportedPos(s: number): number {
  return hir.exportSpecPos[s] | 0;
}
/** `ExportSpec::is_renamed`: it has an `as`. */
export function exportSpecIsRenamed(s: number): boolean {
  return (hir.exportSpecLocalPos[s] | 0) !== (hir.exportSpecPos[s] | 0);
}
export function exportSpecIsTypeOnly(s: number): boolean {
  return (hir.exportSpecTypeOnly[s] | 0) !== 0;
}
/** `ExportSpec::export`: the ExportId. */
export function exportSpecExport(s: number): number {
  return hir.exportSpecExport[s] | 0;
}
export function exportSpecSpan(s: number): void {
  SP[0] = hir.exportSpecStart[s] | 0;
  SP[1] = hir.exportSpecEnd[s] | 0;
}
