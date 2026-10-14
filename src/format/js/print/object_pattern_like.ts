// Port of vendor/bun/src/format/js/print/object_pattern_like.rs: `{ a, b: c }` that is destructured into: a pattern, or the target of an assignment.
//
// `ObjectPatternLike::ObjectPattern(pat, props)` is `writeObjectPatternLikePattern(pat, propsStart, propsLen, f)`,
// `ObjectPatternLike::ObjectAssignmentTarget(e, props)` is `writeObjectPatternLikeAssignmentTarget(e, propsStart, propsLen, f)`.
import { Formatter } from "../../ir/formatter.ts";
import { COMMA, LBRACE, RBRACE } from "../../ir/tokens.ts";
import { FTC_ES5, TRAILING_SEPARATOR_DISALLOWED, trailingSeparator } from "../../options.ts";
import {
  EXPR_ARRAY,
  EXPR_OBJECT,
  PAT_ARRAY,
  PAT_OBJECT,
  PROP_INIT,
  PROP_SPREAD,
  SP,
  exprIsAssignmentTarget,
  exprSpan,
  exprTag,
  funcHasBody,
  listAt,
  paramDefault,
  paramFuncOf,
  patPropDefault,
  patPropIsRest,
  patPropSpan,
  patPropValue,
  patSpan,
  patTag,
  propKind,
  propSpan,
  propValue,
} from "../../../lint/ast/index.ts";
import {
  AN_ASSIGNMENT_EXPRESSION,
  AN_CATCH_PARAMETER,
  AN_FORMAL_PARAMETER,
  AN_VARIABLE_DECLARATOR,
  anId,
  anIsAssignmentPattern,
  anParent,
  anTag,
  exprAstParent,
  patAstParent,
} from "../ast_nodes.ts";
import { JOIN_SOFT_LINE, joinNodesSeparator, writeSeparatorAfter } from "../builders.ts";
import { fmtPatProp, fmtProp } from "../format.ts";
import { DANGLING_SOFT, formatDanglingComments } from "../trivia.ts";
import { shouldHugFunctionParameters } from "./parameters.ts";

const LAYOUT_GROUP: number = 0;
const LAYOUT_EMPTY: number = 1;
const LAYOUT_INLINE: number = 2;

/** `kind`: 0 a pattern (`h`: the Pat, the list is PatProps), 1 the target of an assignment (`h`: the Expr, the list is Props). */
function parentOf(kind: number, h: number): number {
  return kind === 0 ? patAstParent(h) : exprAstParent(h);
}

function isInline(kind: number, h: number): boolean {
  if (kind !== 0) return false;
  const parent = parentOf(kind, h);
  if (anTag(parent) === AN_FORMAL_PARAMETER) return true;
  return anIsAssignmentPattern(parent) && anTag(anParent(parent)) === AN_FORMAL_PARAMETER;
}

/** It is the only parameter of a function, and breaks instead of the parentheses. */
function isHuggedParameter(kind: number, h: number, f: Formatter): boolean {
  const parent = parentOf(kind, h);
  if (anTag(parent) !== AN_FORMAL_PARAMETER) return false;
  const func = paramFuncOf(anId(parent));
  return func >= 0 && shouldHugFunctionParameters(func, false, f);
}

/** Prettier's `shouldBreak` for patterns: a property has a pattern as its value. Not in a parameter of a function, unless that is only a signature. */
function shouldBreakProperties(kind: number, h: number, listStart: number, listLen: number): boolean {
  if (kind === 0) {
    const parent = parentOf(kind, h);
    const pt = anTag(parent);
    let isExempt = false;
    if (pt === AN_CATCH_PARAMETER || anIsAssignmentPattern(parent)) isExempt = true;
    else if (pt === AN_FORMAL_PARAMETER) {
      const param = anId(parent);
      if (paramDefault(param) >= 0) isExempt = true;
      else {
        const func = paramFuncOf(param);
        isExempt = func < 0 || funcHasBody(func);
      }
    }
    if (isExempt) return false;
    for (let i = 0; i < listLen; i++) {
      const property = listAt(listStart, i);
      if (patPropIsRest(property) || patPropDefault(property) >= 0) continue;
      const t = patTag(patPropValue(property));
      if (t === PAT_OBJECT || t === PAT_ARRAY) return true;
    }
    return false;
  }
  for (let i = 0; i < listLen; i++) {
    const property = listAt(listStart, i);
    if (propKind(property) !== PROP_INIT) continue;
    const value = propValue(property);
    if (value < 0) continue;
    const t = exprTag(value);
    if ((t === EXPR_OBJECT || t === EXPR_ARRAY) && exprIsAssignmentTarget(value)) return true;
  }
  return false;
}

function isInAssignmentLike(kind: number, h: number): boolean {
  const t = anTag(parentOf(kind, h));
  if (kind === 0) return t === AN_VARIABLE_DECLARATOR;
  return t === AN_ASSIGNMENT_EXPRESSION || t === AN_VARIABLE_DECLARATOR;
}

function writeObjectPatternLike(kind: number, h: number, listStart: number, listLen: number, f: Formatter): void {
  if (kind === 0) patSpan(h);
  else exprSpan(h);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  let layout: number;
  let expand = false;
  if (listLen === 0) layout = LAYOUT_EMPTY;
  else if (shouldBreakProperties(kind, h, listStart, listLen)) {
    if (isHuggedParameter(kind, h, f)) layout = LAYOUT_INLINE;
    else {
      layout = LAYOUT_GROUP;
      expand = true;
    }
  } else if (isInline(kind, h) || isInAssignmentLike(kind, h)) layout = LAYOUT_INLINE;
  else layout = LAYOUT_GROUP;

  f.token(LBRACE);
  if (layout === LAYOUT_EMPTY) {
    formatDanglingComments(start, end, DANGLING_SOFT, f);
  } else {
    if (layout === LAYOUT_GROUP) f.startGroupExpand(expand);
    f.startSoftBlockIndentWithMaybeSpace(f.options.bracketSpacing);
    // Nothing can follow a rest element, not even a comma.
    const last = listAt(listStart, listLen - 1);
    const hasTrailingRest = kind === 0 ? patPropIsRest(last) : propKind(last) === PROP_SPREAD;
    const separator = hasTrailingRest ? TRAILING_SEPARATOR_DISALLOWED : trailingSeparator(FTC_ES5, f.options);
    for (let i = 0; i < listLen; i++) {
      const p = listAt(listStart, i);
      if (i > 0) {
        if (kind === 0) patPropSpan(p);
        else propSpan(p);
        joinNodesSeparator(f, JOIN_SOFT_LINE, SP$.s0 | 0, SP$.s1 | 0);
      }
      if (kind === 0) fmtPatProp(p, f);
      else fmtProp(p, f);
      writeSeparatorAfter(f, COMMA, i === listLen - 1, separator, 0);
    }
    f.endSoftBlockIndentWithMaybeSpace(f.options.bracketSpacing);
    if (layout === LAYOUT_GROUP) f.endGroup();
  }
  f.token(RBRACE);
}

/** `ObjectPatternLike::ObjectPattern(pat, props).fmt(f)` */
export function writeObjectPatternLikePattern(pat: number, propsStart: number, propsLen: number, f: Formatter): void {
  writeObjectPatternLike(0, pat, propsStart, propsLen, f);
}

/** `ObjectPatternLike::ObjectAssignmentTarget(e, props).fmt(f)` */
export function writeObjectPatternLikeAssignmentTarget(e: number, propsStart: number, propsLen: number, f: Formatter): void {
  writeObjectPatternLike(1, e, propsStart, propsLen, f);
}
