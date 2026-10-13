// Port of vendor/bun/src/format/js/print/parameters.rs.
import { Formatter } from "../../ir/formatter.ts";
import { COMMA, EMPTY_PARENS, EQ, LPAREN, RPAREN, ELLIPSIS, QUESTION } from "../../ir/tokens.ts";
import { token } from "../../ir/element.ts";
import {
  ARROW_PARENS_AS_NEEDED,
  FLAVOR_OXFMT,
  FTC_ARGUMENTS,
  TRAILING_SEPARATOR_DISALLOWED,
  TRAILING_SEPARATOR_OMIT,
  trailingSeparator,
} from "../../options.ts";
import {
  EXPR_CALL,
  EXPR_ARRAY,
  EXPR_IDENT,
  EXPR_OBJECT,
  FLAG_OVERRIDE,
  FLAG_PRIVATE,
  FLAG_PROTECTED,
  FLAG_PUBLIC,
  FLAG_READONLY,
  FLAG_STATIC,
  FN_ARROW,
  FN_CONSTRUCTOR,
  FN_DECL,
  FN_EXPR,
  FN_GETTER,
  FN_METHOD,
  FN_SETTER,
  N_EXPR,
  PAT_ARRAY,
  PAT_IDENT,
  PAT_MISSING,
  PAT_OBJECT,
  SP,
  TYPE_KEYWORD,
  TYPE_MAPPED,
  TYPE_OBJECT,
  TYPE_REF,
  exprParent,
  exprStart as exprStartOf,
  exprTag,
  exprArrayElemsLen,
  exprObjectPropsLen,
  fileIsFlow,
  fileIsJavascript,
  funcArrowSpan,
  funcHasBody,
  funcIsArrow,
  funcKind,
  funcName,
  funcNamePos,
  funcOwner,
  funcParamsLen,
  funcParamsStart,
  funcReturnType,
  funcSpan,
  funcThisParam,
  funcTypeParamsLen,
  funcTypeParamsStart,
  identEndOf,
  listAt,
  modifierDecorator,
  modifierFlagOf,
  nodeId,
  nodeKind,
  paramDefault,
  paramFuncOf,
  paramIsOptional,
  paramIsRest,
  paramModifiersLen,
  paramModifiersStart,
  paramPat,
  paramSpan,
  paramTy,
  patTag,
  typeAnnotationSpan,
  typeParamListAngleBrackets,
  typeRefArgsLen,
  typeSpan,
  typeTag,
} from "../../../lint/ast/index.ts";
import {
  AN_FORMAL_PARAMETERS,
  AN_FUNCTION,
  AN_TS_THIS_PARAMETER,
  anSpan,
  anTag,
  funcAsAstNodes,
  mkAn,
  paramAsAstNodes,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { enterNode, extendNode } from "../../cursor_region.ts";
import {
  PK_PARENT,
  WK_PARAM,
  fmtExpr,
  fmtParam,
  fmtPat,
  fmtTypeAnnotation,
  writeTrailingCommentsIn,
} from "../format.ts";
import { JOIN_HARDLINE, JOIN_SOFT_LINE, joinNodesSeparator, writeSeparatorAfter } from "../builders.ts";
import { nodeSpanOf } from "../format.ts";
import {
  DANGLING_NONE,
  formatDanglingComments,
  formatLeadingComments,
  formatLeadingCommentsRange,
  formatTrailingCommentsRange,
} from "../trivia.ts";
import { isAngularTestWrapper, isTestCallExpressionInFlavor } from "../utils/call_expression.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { fmtDecoratorsOfParam } from "./decorators.ts";
import { isComponent, isShorthandFunctionType, writeParameterStart, writeShorthandParameter } from "./flow.ts";

export const PARAMETER_LAYOUT_NO_PARAMETERS: number = 0;
export const PARAMETER_LAYOUT_HUG: number = 1;
export const PARAMETER_LAYOUT_DEFAULT: number = 2;

const T_THIS = token("this");
const T_PUBLIC = token("public");
const T_PROTECTED = token("protected");
const T_PRIVATE = token("private");
const T_STATIC = token("static");
const T_OVERRIDE = token("override");
const T_READONLY = token("readonly");

/** `""`: a text without width, which makes the line break behind it count. */
export function writeEmptyText(f: Formatter): void {
  f.textSource(0, 0);
}

function paramHasDecorator(param: number): boolean {
  const s = paramModifiersStart(param);
  const n = paramModifiersLen(param);
  for (let i = 0; i < n; i++) if (modifierDecorator(listAt(s, i)) >= 0) return true;
  return false;
}

/** A modifier that is no decorator. */
function hasModifier(param: number): boolean {
  const s = paramModifiersStart(param);
  const n = paramModifiersLen(param);
  for (let i = 0; i < n; i++) if (modifierDecorator(listAt(s, i)) < 0) return true;
  return false;
}

function paramHasFlag(param: number, flag: number): boolean {
  const s = paramModifiersStart(param);
  const n = paramModifiersLen(param);
  for (let i = 0; i < n; i++) if (modifierFlagOf(listAt(s, i)) === flag) return true;
  return false;
}

/** The `( .. )` of a function, with the `this` parameter. */
export function fmtFormalParameters(func: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    writeFormalParameters(func, f);
    return;
  }
  anSpan(mkAn(AN_FORMAL_PARAMETERS, func));
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  // format_node_without_comments(span, || func.as_ast_nodes(), f, write)
  if (!cx.comments.isSuppressed(start)) {
    writeFormalParameters(func, f);
    return;
  }
  formatLeadingComments(start, end, f);
  enterNode(start, end, f);
  writeSuppressedNode(start, end, f);
  extendNode(start, end, f);
  writeTrailingCommentsIn(start, end, PK_PARENT, funcAsAstNodes(func), f);
}

function writeFormalParameters(func: number, f: Formatter): void {
  const cx = cxOf(f);
  const hasParameters = funcParamsLen(func) > 0 || funcThisParam(func) >= 0;
  if (cx.isQuiet) {
    if (hasParameters) writeParametersInParentheses(func, 0, 0, f);
    else f.token(EMPTY_PARENS);
    return;
  }
  anSpan(mkAn(AN_FORMAL_PARAMETERS, func));
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const cm = cx.comments;
  const n = cm.commentsBefore(start);
  if (n > 0) {
    const from = cm.from;
    const count = commentsTrailingTheName(func, hasParameters, from, cm.to, f);
    if (count > 0) {
      f.space();
      formatTrailingCommentsRange(from, from + count, f);
    }
  }
  writeParametersInParentheses(func, start, end, f);
}

/** `span`: of the parentheses. It is only looked at if there are no parameters. */
function writeParametersInParentheses(func: number, spanStart: number, spanEnd: number, f: Formatter): void {
  const cx = cxOf(f);
  if (fileIsFlow() && isShorthandFunctionType(func)) {
    writeShorthandParameter(func, f);
    return;
  }
  const parenthesesNotNeeded = funcIsArrow(func) && canAvoidParentheses(func, f);
  let hasAnyDecoratedParameter = false;
  const ps = funcParamsStart(func);
  const pn = funcParamsLen(func);
  for (let i = 0; i < pn; i++) {
    if (paramHasDecorator(listAt(ps, i))) {
      hasAnyDecoratedParameter = true;
      break;
    }
  }
  const canHug = shouldHugFunctionParameters(func, parenthesesNotNeeded, f) && !hasAnyDecoratedParameter;

  let layout: number;
  if (pn === 0 && funcThisParam(func) < 0) layout = PARAMETER_LAYOUT_NO_PARAMETERS;
  else if (canHug || isCallbackOfTest(func, f)) layout = PARAMETER_LAYOUT_HUG;
  else layout = PARAMETER_LAYOUT_DEFAULT;

  if (!parenthesesNotNeeded) f.token(LPAREN);
  if (layout === PARAMETER_LAYOUT_NO_PARAMETERS) {
    if (cx.isQuiet) {
      // nothing
    } else {
      const cm = cx.comments;
      if (!cm.hasCommentInRange(spanStart, spanEnd)) {
        // Prettier takes a comment before the `=>` for one between the parentheses, finds none there, and is left with the line breaks
        // around it. The empty text is what makes the second one count.
        if (funcArrowSpan(func)) {
          const tokenStart = SP[0] | 0;
          const rt = funcReturnType(func);
          let start = spanEnd;
          if (rt >= 0) {
            typeSpan(rt);
            start = SP[1] | 0;
          }
          if (cm.hasCommentInRange(start, tokenStart)) {
            f.startIndent();
            f.softLineBreak();
            writeEmptyText(f);
            f.endIndent();
            f.softLineBreak();
          }
        }
        // What is left of the comments before the `(` leads what follows the `)`.
      } else {
        // Prettier's `printDanglingCommentsInList`: they break along with the rest of the signature.
        const n = cm.commentsBefore(spanEnd);
        const endsWithLineComment = n > 0 && cm.isLine(cm.to - 1);
        f.startIndent();
        f.softLineBreak();
        formatDanglingComments(spanStart, spanEnd, DANGLING_NONE, f);
        f.endIndent();
        if (endsWithLineComment) f.hardLineBreak();
        else f.softLineBreak();
      }
    }
  } else if (layout === PARAMETER_LAYOUT_HUG) {
    writeParameterList(func, layout, f);
  } else {
    f.startSoftBlockIndent();
    writeParameterList(func, layout, f);
    f.endSoftBlockIndent();
  }
  if (!parenthesesNotNeeded) f.token(RPAREN);
}

/** The callback of a test. Not that of `inject`, `async`, `fakeAsync` and `waitForAsync`, whose parameters can break. */
function isCallbackOfTest(func: number, f: Formatter): boolean {
  const owner = funcOwner(func);
  if (nodeKind(owner) !== N_EXPR) return false;
  const parent = exprParent(nodeId(owner));
  if (nodeKind(parent) !== N_EXPR) return false;
  const call = nodeId(parent);
  return exprTag(call) === EXPR_CALL && isTestCallExpressionInFlavor(call, f) && !isAngularTestWrapper(call);
}

/**
 * How many of the comments `[from, to)`, which are before the `(` of `func`, trail what is before them. The others lead what follows: the
 * first parameter, the return type or the body.
 *
 * Prettier's `handleFunctionNameComments`, and what it does with any comment: on a line of its own it leads what follows, at the end of a
 * line it trails what is before.
 */
function commentsTrailingTheName(func: number, hasParameters: boolean, from: number, to: number, f: Formatter): number {
  const cm = cxOf(f).comments;
  const kind = funcKind(func);
  if ((kind === FN_DECL || kind === FN_EXPR || kind === FN_ARROW) && funcHasBody(func)) {
    if (!followsNameOrTypeParameters(func)) return 0;
    // There is no such rule for an arrow function: with nothing but a `(` between it and the first parameter, the comment leads that.
    const leadsParameter = funcIsArrow(func) && hasParameters;
    let count = 0;
    for (let i = from; i < to; i++) {
      if (cm.precededByNewline(i) || (leadsParameter && !cm.followedByNewline(i))) break;
      count = (count + 1) | 0;
    }
    return count;
  }
  if (hasParameters && anTag(funcAsAstNodes(func)) !== AN_FUNCTION) return 0;
  // Babel has no node for the function of a method: on a line of its own the comment is between the key and the first parameter, which it
  // leads. oxfmt has that node.
  if (
    (kind === FN_METHOD || kind === FN_GETTER || kind === FN_SETTER || kind === FN_CONSTRUCTOR) &&
    hasParameters &&
    fileIsJavascript() &&
    f.options.flavor !== FLAVOR_OXFMT
  ) {
    let count = 0;
    for (let i = from; i < to; i++) {
      if (cm.precededByNewline(i)) break;
      count = (count + 1) | 0;
    }
    return count;
  }
  return (to - from) | 0;
}

/**
 * Whether Prettier has a node before the `(` of `func`, in the node that the parameters are in. The function of a method with a body
 * starts at the type parameters or the `(`.
 */
export function followsNameOrTypeParameters(func: number): boolean {
  if (funcTypeParamsLen(func) > 0) return true;
  const kind = funcKind(func);
  if (kind === FN_DECL || kind === FN_EXPR) return funcName(func) >= 0;
  if (kind === FN_METHOD || kind === FN_GETTER || kind === FN_SETTER || kind === FN_CONSTRUCTOR) return !funcHasBody(func);
  return false;
}

/** The scratch of `commentsBetween`: the comments `[CB[0], CB[1])`, to be filtered with `commentIsBetween`. */
export const CB = new Int32Array(2);

/**
 * The comments in `(start, end)`, whether they are printed or not. For what is asked several times while a node is written, and has to
 * get the same answer. Sets `CB[0]`, `CB[1]`: a range of comment indices, of which those with `commentIsBetween` are the answer.
 */
export function commentsBetween(start: number, end: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  const printed = cm.printedCount;
  let p0 = printed;
  while (p0 > 0 && (cm.cs[(p0 - 1) | 0] | 0) >= start) p0 = (p0 - 1) | 0;
  CB[0] = p0;
  CB[1] = (printed + cm.countBefore(end)) | 0;
}

export function commentIsBetween(i: number, start: number, end: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  return (cm.cs[i] | 0) >= start && (cm.ce[i] | 0) <= end;
}

/** `comments_between(span).next().is_some()` */
export function hasCommentsBetween(start: number, end: number, f: Formatter): boolean {
  commentsBetween(start, end, f);
  const to = CB[1] | 0;
  for (let i = CB[0] | 0; i < to; i++) if (commentIsBetween(i, start, end, f)) return true;
  return false;
}

/** `private a?: T = 1`, `...a: T`, `this: T` */
export function writeFormalParameter(param: number, f: Formatter): void {
  const cx = cxOf(f);
  if (fileIsFlow() && writeParameterStart(param, f)) return;
  if (anTag(paramAsAstNodes(param)) === AN_TS_THIS_PARAMETER) {
    f.token(T_THIS);
    const ty = paramTy(param);
    if (ty >= 0) fmtTypeAnnotation(ty, f);
    return;
  }
  const hasDecorators = paramHasDecorator(param);
  if (paramIsRest(param)) {
    if (hasDecorators) f.startGroup();
    if (hasDecorators) fmtDecoratorsOfParam(param, f);
    f.token(ELLIPSIS);
    fmtPat(paramPat(param), f);
    const ty = paramTy(param);
    if (ty >= 0) fmtTypeAnnotation(ty, f);
    if (hasDecorators) f.endGroup();
    return;
  }

  // A group makes no difference to what has no place to break at.
  let mode = 0; // 0: the content; 1: group(content); 2: group(decorators) group(content); 3: group(decorators group(content))
  if (!(!hasDecorators && cannotBreak(param, f))) {
    const func = paramFuncOf(param);
    let isHugParameter = false;
    if (func >= 0) {
      const parenthesesNotNeeded = funcIsArrow(func) && canAvoidParentheses(func, f);
      isHugParameter = shouldHugFunctionParameters(func, parenthesesNotNeeded, f);
    }
    if (isHugParameter && !hasDecorators) mode = 0;
    else if (!hasDecorators) mode = 1;
    else if (decoratorsOfParameterAreAGroupOfTheirOwn(f)) mode = 2;
    else mode = 3;
  }

  if (mode === 1) f.startGroup();
  else if (mode === 2) {
    f.startGroup();
    fmtDecoratorsOfParam(param, f);
    f.endGroup();
    f.startGroup();
  } else if (mode === 3) {
    f.startGroup();
    fmtDecoratorsOfParam(param, f);
    f.startGroup();
  }
  void cx;
  writeParameterContent(param, f);
  if (mode === 1) f.endGroup();
  else if (mode === 2) f.endGroup();
  else if (mode === 3) {
    f.endGroup();
    f.endGroup();
  }
}

/** The modifiers, the pattern, `?`, the type and the default value. */
function writeParameterContent(param: number, f: Formatter): void {
  const cx = cxOf(f);
  const initializer = paramDefault(param);
  let leftSlot = -1;
  if (initializer >= 0) leftSlot = f.startCapture();
  // left
  if (paramModifiersLen(param) > 0) {
    if (paramHasFlag(param, FLAG_PUBLIC)) {
      f.token(T_PUBLIC);
      f.space();
    }
    if (paramHasFlag(param, FLAG_PROTECTED)) {
      f.token(T_PROTECTED);
      f.space();
    }
    if (paramHasFlag(param, FLAG_PRIVATE)) {
      f.token(T_PRIVATE);
      f.space();
    }
    if (paramHasFlag(param, FLAG_STATIC)) {
      f.token(T_STATIC);
      f.space();
    }
    if (paramHasFlag(param, FLAG_OVERRIDE)) {
      f.token(T_OVERRIDE);
      f.space();
    }
    if (paramHasFlag(param, FLAG_READONLY)) {
      f.token(T_READONLY);
      f.space();
    }
  }
  fmtPat(paramPat(param), f);
  if (paramIsOptional(param)) f.token(QUESTION);
  const ty = paramTy(param);
  if (ty >= 0) {
    if (!cx.isQuiet) {
      typeAnnotationSpan(ty);
      if (cx.comments.hasCommentBefore(SP[0] | 0)) f.space();
    }
    fmtTypeAnnotation(ty, f);
  }

  if (initializer >= 0) {
    // So that the comments in it are not taken for comments before the `=`.
    const left = f.endCapture(leftSlot);
    const cm = cx.comments;
    cm.ownLineCommentsBefore(exprStartOf(initializer));
    formatLeadingCommentsRange(cm.from, cm.to, f);
    f.startGroup();
    f.writeInterned(left);
    f.endGroup();
    f.space();
    f.token(EQ);
    f.space();
    fmtExpr(initializer, f);
  }
}

/**
 * ```ts
 * @A({ b: true })          @A({ b: true }) c:
 * c: D | undefined,          | D
 *                            | undefined,
 * ```
 *
 * Prettier on the left: what does not fit breaks after the decorators first. oxfmt on the right.
 */
function decoratorsOfParameterAreAGroupOfTheirOwn(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** Whether `param` is a name, and its type a keyword or a name. */
function cannotBreak(param: number, f: Formatter): boolean {
  if (!cxOf(f).isQuiet || paramDefault(param) >= 0 || patTag(paramPat(param)) !== PAT_IDENT) return false;
  const ty = paramTy(param);
  if (ty < 0) return true;
  const t = typeTag(ty);
  if (t === TYPE_KEYWORD) return true;
  if (t === TYPE_REF) return typeRefArgsLen(ty) === 0;
  return false;
}

/** The parameters of `func`, with the `this` parameter first, in the layout. */
function writeParameterList(func: number, layout: number, f: Formatter): void {
  const thisParam = funcThisParam(func);
  const ps = funcParamsStart(func);
  const pn = funcParamsLen(func);
  const total = pn + (thisParam >= 0 ? 1 : 0);
  if (layout === PARAMETER_LAYOUT_HUG) {
    for (let i = 0; i < total; i++) {
      if (i > 0) f.space();
      fmtParam(i === 0 && thisParam >= 0 ? thisParam : listAt(ps, thisParam >= 0 ? i - 1 : i), f);
      if (i + 1 < total) f.token(COMMA);
    }
    return;
  }
  // Nothing can follow a rest parameter, not even a comma.
  const ts =
    pn > 0 && paramIsRest(listAt(ps, pn - 1))
      ? TRAILING_SEPARATOR_DISALLOWED
      : trailingSeparator(FTC_ARGUMENTS, f.options);
  let hasModifiers = false;
  for (let i = 0; i < pn; i++) {
    if (hasModifier(listAt(ps, i))) {
      hasModifiers = true;
      break;
    }
  }
  const separator = hasModifiers ? JOIN_HARDLINE : JOIN_SOFT_LINE;
  for (let i = 0; i < total; i++) {
    const p = i === 0 && thisParam >= 0 ? thisParam : listAt(ps, thisParam >= 0 ? i - 1 : i);
    if (i > 0) {
      nodeSpanOf(WK_PARAM, p);
      joinNodesSeparator(f, separator, SP[0] | 0, SP[1] | 0);
    }
    fmtParam(p, f);
    writeSeparatorAfter(f, COMMA, i === total - 1, ts, 0);
  }
}

/** `a => a`: whether the options ask for it and the parameters allow it. */
export function canAvoidParentheses(arrow: number, f: Formatter): boolean {
  if (f.options.arrowParentheses !== ARROW_PARENS_AS_NEEDED) return false;
  if (funcParamsLen(arrow) !== 1 || funcThisParam(arrow) >= 0 || funcTypeParamsLen(arrow) > 0 || funcReturnType(arrow) >= 0) return false;
  const param = listAt(funcParamsStart(arrow), 0);
  if (paramIsRest(param) || paramTy(param) >= 0 || paramIsOptional(param) || paramDefault(param) >= 0) return false;
  if (patTag(paramPat(param)) !== PAT_IDENT) return false;
  const at = funcArrowSpan(arrow) ? SP[0] | 0 : 0;
  return !cxOf(f).comments.hasCommentBefore(at);
}

/** `{}`, `[]` or a name. */
function isHuggableExpression(e: number): boolean {
  switch (exprTag(e)) {
    case EXPR_OBJECT:
      return exprObjectPropsLen(e) === 0;
    case EXPR_ARRAY:
      return exprArrayElemsLen(e) === 0;
    case EXPR_IDENT:
      return true;
    default:
      return false;
  }
}

/** Whether there are comments around the only parameter `param` of `func`. Those before the `(` that do not trail the name lead it. */
function hasCommentsAround(func: number, param: number, f: Formatter): boolean {
  anSpan(mkAn(AN_FORMAL_PARAMETERS, func));
  const spanStart = SP[0] | 0;
  const spanEnd = SP[1] | 0;
  const kind = funcKind(func);
  let start = spanStart;
  if ((kind === FN_DECL || kind === FN_EXPR || kind === FN_ARROW) && funcHasBody(func)) {
    if (typeParamListAngleBrackets(funcTypeParamsStart(func), funcTypeParamsLen(func))) {
      start = SP[1] | 0;
    } else if (funcName(func) >= 0) {
      start = identEndOf(funcName(func), funcNamePos(func));
    } else {
      funcSpan(func);
      start = SP[0] | 0;
    }
  }
  commentsBetween(start, spanEnd, f);
  const from = CB[0] | 0;
  const to = CB[1] | 0;
  const cm = cxOf(f).comments;
  paramSpan(param);
  const paramStart = SP[0] | 0;
  const paramEnd = SP[1] | 0;
  let followsName = false;
  let computed = false;
  for (let i = from; i < to; i++) {
    if (!commentIsBetween(i, start, spanEnd, f)) continue;
    if (!computed) {
      followsName = followsNameOrTypeParameters(func);
      computed = true;
    }
    const cs = cm.cs[i] | 0;
    const ce = cm.ce[i] | 0;
    if (cs >= paramEnd) return true;
    if (ce <= paramStart) {
      // leads_parameter
      let leads: boolean;
      if (!followsName || cm.precededByNewline(i)) leads = true;
      else if (cs >= spanStart || funcIsArrow(func)) leads = !cm.followedByNewline(i);
      else leads = false;
      if (leads) return true;
    }
  }
  return false;
}

/** Prettier's `shouldHugTheOnlyFunctionParameter`. */
export function shouldHugFunctionParameters(func: number, parenthesesNotNeeded: boolean, f: Formatter): boolean {
  const n = funcParamsLen(func);
  const ps = funcParamsStart(func);
  if (n > 1 || (n > 0 && paramIsRest(listAt(ps, n - 1)))) return false;
  const thisParam = funcThisParam(func);
  if (thisParam >= 0) {
    if (n !== 0) return false;
    const ty = paramTy(thisParam);
    if (ty < 0) return false;
    const t = typeTag(ty);
    return (t === TYPE_OBJECT || t === TYPE_MAPPED) && !hasCommentsAround(func, thisParam, f);
  }
  if (n === 0) return false;
  const only = listAt(ps, 0);
  const pat = paramPat(only);
  const pt = patTag(pat);
  let isHuggable: boolean;
  if (pt === PAT_ARRAY || pt === PAT_OBJECT) {
    const d = paramDefault(only);
    isHuggable = d < 0 || isHuggableExpression(d);
  } else if (pt === PAT_IDENT || pt === PAT_MISSING) {
    let objectLike = false;
    const ty = paramTy(only);
    if (ty >= 0) {
      const t = typeTag(ty);
      objectLike = t === TYPE_OBJECT || t === TYPE_MAPPED;
    }
    isHuggable = paramDefault(only) < 0 && (parenthesesNotNeeded || objectLike);
  } else {
    isHuggable = false;
  }
  return isHuggable && !hasModifier(only) && !(fileIsFlow() && isComponent(func, f)) && !hasCommentsAround(func, only, f);
}

/** Whether all parameters are plain names, without default values. A rest parameter is not. */
export function hasOnlySimpleParameters(func: number, allowTypeAnnotations: boolean): boolean {
  const thisParam = funcThisParam(func);
  const total = funcParamsLen(func) + (thisParam >= 0 ? 1 : 0);
  const ps = funcParamsStart(func);
  const n = funcParamsLen(func);
  for (let i = 0; i < total; i++) {
    const p = i === 0 && thisParam >= 0 ? thisParam : listAt(ps, thisParam >= 0 ? i - 1 : i);
    if (paramIsRest(p) || patTag(paramPat(p)) !== PAT_IDENT || paramDefault(p) >= 0) return false;
    if (!allowTypeAnnotations && paramTy(p) >= 0) return false;
  }
  void n;
  return true;
}
