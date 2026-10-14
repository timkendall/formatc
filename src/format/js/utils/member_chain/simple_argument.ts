// Port of vendor/bun/src/format/js/utils/member_chain/simple_argument.rs: Prettier's `isSimpleCallArgument`.
//
// An argument of a call, to ask whether it is "simple": a literal, a name, or something small that is made of those. A chain of calls
// with simple arguments is more likely to stay on one line.
import { Formatter } from "../../../ir/formatter.ts";
import { stringWidth } from "../../../ir/width.ts";
import { FLAVOR_OXFMT } from "../../../options.ts";
import { I32Vec } from "../../../../base/i32vec.ts";
import {
  EXPR_ARRAY,
  EXPR_BIG_INT,
  EXPR_CALL,
  EXPR_DOT,
  EXPR_FALSE,
  EXPR_IDENT,
  EXPR_IMPORT_CALL,
  EXPR_INDEX,
  EXPR_MISSING,
  EXPR_NEW,
  EXPR_NON_NULL,
  EXPR_NULL,
  EXPR_NUMBER,
  EXPR_OBJECT,
  EXPR_PRIVATE_IDENTIFIER,
  EXPR_REGEX,
  EXPR_SPREAD,
  EXPR_STRING,
  EXPR_SUPER,
  EXPR_TEMPLATE,
  EXPR_THIS,
  EXPR_TRUE,
  EXPR_UNARY,
  PROP_INIT,
  PROP_SHORTHAND,
  SP,
  UN_BIT_NOT,
  UN_MINUS,
  UN_NOT,
  UN_PLUS,
  callArgsLen,
  callArgsStart,
  callCallee,
  exprArrayElemsLen,
  exprArrayElemsStart,
  exprCallCall,
  exprDotObj,
  exprImportCallArgsLen,
  exprImportCallArgsStart,
  exprIndexIndex,
  exprIndexObj,
  exprNewCall,
  exprNonNullExpr,
  exprObjectPropsLen,
  exprObjectPropsStart,
  exprRegexPatternSpan,
  exprTag,
  exprTemplateExprsLen,
  exprTemplateExprsStart,
  exprTemplateQuasiCount,
  exprTemplateRawSpan,
  exprUnaryOp,
  exprUnaryOperand,
  hir,
  keyIsComputed,
  listAt,
  nodeOfProp,
  propKind,
  propValue,
} from "../../../../lint/ast/index.ts";
import { unOpIsUpdate } from "../operators.ts";

const pending = new I32Vec(16);

export function isSimpleArgument(argument: number, f: Formatter): boolean {
  return isSimple(argument, 0, f.options.flavor === FLAVOR_OXFMT);
}

export function isSimpleArgumentWithDepth(argument: number, depth: number, f: Formatter): boolean {
  return isSimple(argument, depth, f.options.flavor === FLAVOR_OXFMT);
}

/** Up to five characters. oxfmt counts bytes: for it `/[“”]/` is long. */
function isShortPattern(start: number, end: number, oxfmt: boolean): boolean {
  if (oxfmt) return end - start <= 5;
  return stringWidth(hir.text, start, end) <= 5;
}

function isSimple(e0: number, depth: number, oxfmt: boolean): boolean {
  if (depth >= 2) return false;
  // What is left to look at. All of it is as deep as `e`: a chain of accesses and calls can be long, and so can `a[b[c[..]]]`.
  const pending$ = pending;
  const base = pending$.len;
  let next = e0;
  let result = true;
  const SP$ = SP;
  while (next >= 0) {
    let e = next;
    for (;;) {
      const t = exprTag(e);
      if (
        t === EXPR_NULL ||
        t === EXPR_TRUE ||
        t === EXPR_FALSE ||
        t === EXPR_STRING ||
        t === EXPR_NUMBER ||
        t === EXPR_BIG_INT ||
        t === EXPR_THIS ||
        t === EXPR_IDENT ||
        t === EXPR_PRIVATE_IDENTIFIER ||
        t === EXPR_SUPER
      ) {
        break;
      }
      if (t === EXPR_REGEX) {
        exprRegexPatternSpan(e);
        if (isShortPattern(SP$.s0 | 0, SP$.s1 | 0, oxfmt)) break;
        result = false;
        break;
      }
      if (t === EXPR_TEMPLATE) {
        if (isSimpleTemplateLiteral(e, depth + 1, oxfmt)) break;
        result = false;
        break;
      }
      if (t === EXPR_OBJECT) {
        if (areSimpleProps(e, depth, oxfmt)) break;
        result = false;
        break;
      }
      if (t === EXPR_ARRAY) {
        if (areSimpleElements(e, depth, oxfmt)) break;
        result = false;
        break;
      }
      if (t === EXPR_UNARY) {
        const op = exprUnaryOp(e);
        if (op === UN_NOT || op === UN_MINUS || op === UN_PLUS || op === UN_BIT_NOT) {
          e = exprUnaryOperand(e);
          continue;
        }
        if (unOpIsUpdate(op) && (!oxfmt || exprTag(exprUnaryOperand(e)) === EXPR_IDENT)) {
          // For oxfmt `a++` is simple and `a.b++` is not.
          e = exprUnaryOperand(e);
          continue;
        }
        result = false;
        break;
      }
      if (t === EXPR_NON_NULL) {
        e = exprNonNullExpr(e);
        continue;
      }
      if (t === EXPR_DOT) {
        e = exprDotObj(e);
        continue;
      }
      if (t === EXPR_INDEX) {
        pending$.push(exprIndexObj(e));
        e = exprIndexIndex(e);
        continue;
      }
      if (t === EXPR_NEW || t === EXPR_CALL) {
        const call = t === EXPR_NEW ? exprNewCall(e) : exprCallCall(e);
        if (areSimple(callArgsStart(call), callArgsLen(call), depth, oxfmt)) {
          e = callCallee(call);
          continue;
        }
        result = false;
        break;
      }
      if (t === EXPR_IMPORT_CALL) {
        if (areSimple(exprImportCallArgsStart(e), exprImportCallArgsLen(e), depth, oxfmt)) break;
        result = false;
        break;
      }
      result = false;
      break;
    }
    if (!result) break;
    next = pending$.len > base ? pending$.pop() : -1;
  }
  pending$.len = base;
  return result;
}

function areSimpleProps(e: number, depth: number, oxfmt: boolean): boolean {
  const start = exprObjectPropsStart(e);
  const n = exprObjectPropsLen(e);
  for (let i = 0; i < n; i++) {
    const prop = listAt(start, i);
    const kind = propKind(prop);
    if (kind === PROP_SHORTHAND) continue;
    if (kind === PROP_INIT) {
      if (keyIsComputed(nodeOfProp(prop))) return false;
      const value = propValue(prop);
      if (value < 0 || !isSimple(value, depth + 1, oxfmt)) return false;
      continue;
    }
    return false;
  }
  return true;
}

function areSimpleElements(e: number, depth: number, oxfmt: boolean): boolean {
  const start = exprArrayElemsStart(e);
  const n = exprArrayElemsLen(e);
  for (let i = 0; i < n; i++) {
    const element = listAt(start, i);
    const t = exprTag(element);
    if (t === EXPR_MISSING) continue;
    if (t === EXPR_SPREAD) return false;
    if (!isSimple(element, depth + 1, oxfmt)) return false;
  }
  return true;
}

/** The arguments of a call: the deeper it is, the fewer it may have. */
function areSimple(start: number, n: number, depth: number, oxfmt: boolean): boolean {
  if (n + depth > 2) return false;
  for (let i = 0; i < n; i++) {
    if (!isSimple(listAt(start, i), depth + 1, oxfmt)) return false;
  }
  return true;
}

/** No text of the template has a line break, and all substitutions are simple. */
function isSimpleTemplateLiteral(e: number, depth: number, oxfmt: boolean): boolean {
  const quasis = exprTemplateQuasiCount(e);
  const text = hir.text;
  const SP$ = SP;
  for (let i = 0; i < quasis; i++) {
    exprTemplateRawSpan(e, i);
    const s = SP$.s0 | 0;
    const end = SP$.s1 | 0;
    for (let k = s; k < end; k++) if ((text[k] | 0) === 10) return false;
  }
  const start = exprTemplateExprsStart(e);
  const n = exprTemplateExprsLen(e);
  for (let i = 0; i < n; i++) {
    if (!isSimple(listAt(start, i), depth, oxfmt)) return false;
  }
  return true;
}
