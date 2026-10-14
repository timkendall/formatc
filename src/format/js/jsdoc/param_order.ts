// Port of vendor/bun/src/format/js/jsdoc/param_order.rs: `@param` tags are put in the order of the parameters of the function behind the comment.
import { I32Vec } from "../../../sema/vec.ts";
import {
  EXPR_ASSIGN,
  EXPR_FN,
  EXPR_IDENT,
  FLAG_ASYNC,
  FLAG_DEFAULT,
  FLAG_EXPORT,
  FLAG_OPTIONAL,
  FN_EXPR,
  KEY_IDENT,
  KEY_NONE,
  MEMBER_CONSTRUCT_SIGNATURE,
  MEMBER_CONSTRUCTOR,
  MEMBER_METHOD,
  MEMBER_PROPERTY,
  N_EXPR,
  N_MEMBER,
  N_PROP,
  N_STMT,
  NODE_FILE,
  PROP_METHOD,
  SP,
  STMT_FN,
  STMT_RETURN,
  STMT_VAR,
  exprAsFn,
  exprAssignOpOf,
  exprAssignTarget,
  exprAssignValue,
  exprIdentName,
  exprIsParenthesized,
  exprTag,
  funcIsArrow,
  funcIsAsync,
  funcIsGenerator,
  funcKind,
  funcParamsLen,
  funcParamsStart,
  funcThisParam,
  funcTypeParamsLen,
  hir,
  keyKind,
  keyName,
  listAt,
  memberFlags,
  memberFunc,
  memberInit,
  memberKind,
  memberModifiersLen,
  memberModifiersStart,
  memberTy,
  modifierFlagOf,
  nameBuf,
  nameLen,
  nameStart,
  nodeChildren,
  nodeId,
  nodeKind,
  nodeSpan,
  nodeOfMember,
  nodeOfProp,
  paramSpan,
  propFunc,
  propKind,
  propModifiersLen,
  stmtModifiersLen,
  stmtModifiersStart,
  stmtFnFn,
  stmtReturnExpr,
  stmtTag,
  stmtVarDeclsLen,
  stmtVarDeclsStart,
  varDeclInit,
  varDeclPat,
  varDeclTy,
  patAsIdent,
} from "../../../lint/ast/index.ts";
import { decodeBytes, isUnicodeWhitespace } from "../../../base/ustr.ts";
import { stableSort } from "./text.ts";
import { tagHasName, tagHasType, tagNameParsed } from "../../../lint/ast/jsdoc.ts";

const kids = new I32Vec(32);

/** A tag with the name that stands for its kind. */
export class EffTag {
  row: number;
  kind: string;
  constructor(row: number, kind: string) {
    this.row = row;
    this.kind = kind;
  }
}

/**
 * `commentEnd`: where the comment ends in the file. Only if every `@param` has a type and a name, and the names are those of the
 * parameters.
 */
export function reorderParamTags(tags: EffTag[], commentEnd: number): void {
  let paramStart = -1;
  for (let i = 0; i < tags.length; i++) {
    if (tags[i].kind === "param") {
      paramStart = i;
      break;
    }
  }
  if (paramStart < 0) return;
  let paramEnd = tags.length;
  for (let i = paramStart; i < tags.length; i++) {
    if (tags[i].kind !== "param") {
      paramEnd = i;
      break;
    }
  }
  if (paramEnd - paramStart < 2) return;
  const names: string[] = [];
  for (let i = paramStart; i < paramEnd; i++) {
    const row = tags[i].row;
    if (tagHasType(row) && tagHasName(row)) names.push(tagNameParsed(row));
    else return;
  }
  const func = functionBehind(commentEnd);
  const functionParams = func >= 0 ? parameterNames(func) : [];
  if (functionParams.length !== names.length) return;
  let same = true;
  for (let i = 0; i < names.length; i++) if (names[i] !== functionParams[i]) same = false;
  if (same) return;
  for (let i = 0; i < names.length; i++) if (functionParams.indexOf(names[i]) < 0) return;
  stableSort(tags, paramStart, paramEnd, compareByParamPosition(functionParams));
}

function compareByParamPosition(functionParams: string[]): (a: EffTag, b: EffTag) => number {
  return (a: EffTag, b: EffTag): number => {
    const x = positionOf(functionParams, a);
    const y = positionOf(functionParams, b);
    return x === y ? 0 : x < y ? -1 : 1;
  };
}

function positionOf(functionParams: string[], tag: EffTag): number {
  const name = tagHasName(tag.row) ? tagNameParsed(tag.row) : "";
  const at = functionParams.indexOf(name);
  return at < 0 ? 0x7fffffff : at;
}

/** The function whose head starts with what follows the comment that ends at `commentEnd`; -1 if there is none. */
function functionBehind(commentEnd: number): number {
  const hir$ = hir;
  const len = hir$.sourceLen | 0;
  if (commentEnd > len) return -1;
  let start = commentEnd;
  while (start < len) {
    const b = hir$.text[start] | 0;
    if (b < 0x80) {
      if (b === 32 || (b >= 9 && b <= 13)) {
        start = start + 1;
        continue;
      }
      break;
    }
    // A non-ASCII white space.
    let cp = 0;
    let size = 1;
    if (b >= 0xc2 && b <= 0xdf && start + 1 < len) {
      cp = ((b & 0x1f) << 6) | ((hir$.text[start + 1] | 0) & 0x3f);
      size = 2;
    } else if (b >= 0xe0 && b <= 0xef && start + 2 < len) {
      cp = ((b & 0x0f) << 12) | (((hir$.text[start + 1] | 0) & 0x3f) << 6) | ((hir$.text[start + 2] | 0) & 0x3f);
      size = 3;
    }
    if (cp !== 0 && isUnicodeWhitespace(cp)) {
      start = start + size;
      continue;
    }
    break;
  }
  let node = NODE_FILE;
  const kids$ = kids;
  while (true) {
    let child = -1;
    const base = kids$.len;
    nodeChildren(node, start, kids$);
    for (let i = base; i < kids$.len; i++) {
      const c = kids$.data[i] | 0;
      nodeSpan(c);
      if (child < 0 && (SP[0] | 0) <= start && start < (SP[1] | 0)) child = c;
    }
    kids$.len = base;
    if (child < 0) return -1;
    node = child;
    nodeSpan(node);
    if ((SP[0] | 0) === start) {
      const func = functionWithKnownHead(node);
      if (func >= 0) return func;
    }
  }
}

function isIdentifierByte(b: number): boolean {
  return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95 || b === 36;
}

/** It is in ASCII, and none of the words that are passed over. */
function isPlainName(name: number): boolean {
  const buf = nameBuf(name);
  const s = nameStart(name);
  const n = nameLen(name);
  for (let i = 0; i < n; i++) if (!isIdentifierByte(buf[s + i] | 0)) return false;
  const text = decodeBytes(buf, s, s + n);
  return text !== "export" && text !== "default" && text !== "async";
}

function isPlainKey(owner: number): boolean {
  return keyKind(owner) === KEY_IDENT && isPlainName(keyName(owner));
}

/** Whether there is nothing but `export`, `default` and `async`. */
function arePassedOver(modsStart: number, modsLen: number): boolean {
  for (let i = 0; i < modsLen; i++) if ((modifierFlagOf(listAt(modsStart, i)) & (FLAG_EXPORT | FLAG_DEFAULT | FLAG_ASYNC)) === 0) return false;
  return true;
}

/** `(a, b) => {}` that is not in parentheses and has no type parameters: its function, else -1. */
function arrowFunction(e: number): number {
  const f = exprAsFn(e);
  if (f >= 0 && funcIsArrow(f) && funcTypeParamsLen(f) === 0 && !exprIsParenthesized(e)) return f;
  return -1;
}

/** The function that `node` is or declares. oxfmt looks for the `(` of the parameters in the text behind the comment, and finds it behind these heads only. */
function functionWithKnownHead(node: number): number {
  const id = nodeId(node);
  switch (nodeKind(node)) {
    case N_STMT: {
      if (!arePassedOver(stmtModifiersStart(id), stmtModifiersLen(id))) return -1;
      switch (stmtTag(id)) {
        case STMT_FN:
          return stmtFnFn(id);
        // `const f = (a, b) => {}`
        case STMT_VAR: {
          if (stmtVarDeclsLen(id) === 0) return -1;
          const first = listAt(stmtVarDeclsStart(id), 0);
          const init = varDeclInit(first);
          if (init < 0) return -1;
          const ident = patAsIdent(varDeclPat(first));
          const hasPlainName = ident >= 0 && isPlainName(ident);
          const arrow = arrowFunction(init);
          return hasPlainName && varDeclTy(first) < 0 ? arrow : -1;
        }
        // `return (a, b) => {}`
        case STMT_RETURN: {
          const value = stmtReturnExpr(id);
          if (value < 0) return -1;
          const arrow = arrowFunction(value);
          return arrow >= 0 && !funcIsAsync(arrow) ? arrow : -1;
        }
        default:
          return -1;
      }
    }
    case N_EXPR: {
      const tag = exprTag(id);
      if (tag === EXPR_FN) {
        const f = exprAsFn(id);
        return f >= 0 && funcKind(f) === FN_EXPR ? f : -1;
      }
      // `f = (a, b) => {}`
      if (tag === EXPR_ASSIGN && exprAssignOpOf(id) === 0) {
        const target = exprAssignTarget(id);
        if (exprTag(target) === EXPR_IDENT && isPlainName(exprIdentName(target))) return arrowFunction(exprAssignValue(id));
      }
      return -1;
    }
    case N_MEMBER: {
      if (!arePassedOver(memberModifiersStart(id), memberModifiersLen(id)) || (memberFlags(id) & FLAG_OPTIONAL) !== 0) return -1;
      const kind = memberKind(id);
      if (kind === MEMBER_CONSTRUCTOR || kind === MEMBER_CONSTRUCT_SIGNATURE) return memberFunc(id);
      if (kind === MEMBER_METHOD && isPlainKey(nodeOfMember(id))) {
        const f = memberFunc(id);
        return f >= 0 && !funcIsGenerator(f) ? f : -1;
      }
      // `f = (a, b) => {}`
      if (kind === MEMBER_PROPERTY && isPlainKey(nodeOfMember(id)) && memberTy(id) < 0) {
        const init = memberInit(id);
        return init >= 0 ? arrowFunction(init) : -1;
      }
      return -1;
    }
    case N_PROP: {
      if (propKind(id) === PROP_METHOD && isPlainKey(nodeOfProp(id))) {
        const f = propFunc(id);
        return f >= 0 && !funcIsGenerator(f) ? f : -1;
      }
      return -1;
    }
    default:
      return -1;
  }
}

/**
 * What oxfmt takes for the names of the parameters: the word that each starts with, behind `...`. That is a modifier if it has one. A
 * pattern has none.
 */
function parameterNames(func: number): string[] {
  const out: string[] = [];
  const thisParam = funcThisParam(func);
  const n = funcParamsLen(func);
  const s = funcParamsStart(func);
  const hir$ = hir;
  for (let i = -1; i < n; i++) {
    const p = i < 0 ? thisParam : listAt(s, i);
    if (p < 0) continue;
    paramSpan(p);
    let from = SP[0] | 0;
    const to = SP[1] | 0;
    if (to - from >= 3 && (hir$.text[from] | 0) === 46 && (hir$.text[from + 1] | 0) === 46 && (hir$.text[from + 2] | 0) === 46) from = from + 3;
    let e = from;
    while (e < to && isIdentifierByte(hir$.text[e] | 0)) e = e + 1;
    if (e > from) out.push(decodeBytes(hir$.text, from, e));
  }
  return out;
}

void propModifiersLen;
