// Port of vendor/bun/src/format/js/print/jsx/opening_element.rs: `<a b="c">`, `<a b="c" />`.
import { Formatter } from "../../../ir/formatter.ts";
import { token } from "../../../ir/element.ts";
import { ATTRIBUTE_POSITION_MULTILINE } from "../../../options.ts";
import {
  EXPR_STRING,
  PROP_SPREAD,
  SP,
  exprJsxContainerSpan,
  exprSpan,
  exprTag,
  jsxAttrsLen,
  jsxAttrsStart,
  jsxIsSelfClosing,
  jsxOpeningSpan,
  jsxTag,
  jsxTypeArgsLen,
  jsxTypeArgsStart,
  listAt,
  nodeOfExpr,
  propKind,
  propSpan,
  propValue,
  typeListAngleBrackets,
} from "../../../../lint/ast/index.ts";
import { AN_JSX_OPENING_ELEMENT, mkAn } from "../../ast_nodes.ts";
import { cxOf } from "../../context.ts";
import { fmtProp } from "../../format.ts";
import { formatTrailingCommentsRange } from "../../trivia.ts";
import { losesLineBreaks } from "../../utils/tailwindcss.ts";
import { isNextLineEmpty } from "../program.ts";
import { typeArguments } from "../type_parameters.ts";
import { fmtJsxName } from "./mod.ts";

const LANGLE = token("<");
const SLASH = token("/");
const RANGLE = token(">");

// OpeningElementLayout
const LAYOUT_INLINE: number = 0;
const LAYOUT_SINGLE_STRING_ATTRIBUTE: number = 1;
const LAYOUT_INDENT_ATTRIBUTES: number = 2;

/** The value of `a="b"`, or -1. */
function asStringLiteralAttributeValue(attribute: number): number {
  const value = propValue(attribute);
  if (value < 0) return -1;
  if (propKind(attribute) === PROP_SPREAD || exprJsxContainerSpan(value) || exprTag(value) !== EXPR_STRING) return -1;
  return value;
}

function hasLineBreak(string: number, f: Formatter): boolean {
  exprSpan(string);
  const text = f.source;
  const end = SP[1] | 0;
  let found = false;
  for (let i = SP[0] | 0; i < end; i++) {
    const b = text[i] | 0;
    if (b === 10 || b === 13) {
      found = true;
      break;
    }
  }
  return found && !losesLineBreaks(string, f);
}

/** `<a b="c">`, `<a b="c" />`. `e`: the element. */
export function writeOpeningElement(e: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const isSelfClosing = jsxIsSelfClosing(e);
  const attrsStart = jsxAttrsStart(e);
  const attrsLen = jsxAttrsLen(e);
  const tag = jsxTag(e);
  const typeArgsStart = jsxTypeArgsStart(e);
  const typeArgsLen = jsxTypeArgsLen(e);
  const parent = mkAn(AN_JSX_OPENING_ELEMENT, e);

  // compute_layout
  jsxOpeningSpan(e);
  const spanStart = SP[0] | 0;
  const spanEnd = SP[1] | 0;
  let lastAttributeHasComment = false;
  if (attrsLen > 0) {
    propSpan(listAt(attrsStart, attrsLen - 1));
    lastAttributeHasComment = cm.hasCommentInRange(SP[1] | 0, spanEnd);
  }
  let typeArgumentsOrNameEnd = spanStart;
  if (typeListAngleBrackets(typeArgsStart, typeArgsLen)) typeArgumentsOrNameEnd = SP[1] | 0;
  else if (tag >= 0) {
    exprSpan(tag);
    typeArgumentsOrNameEnd = SP[1] | 0;
  }
  let firstAttributeStartOrElementEnd = spanEnd;
  if (attrsLen > 0) {
    propSpan(listAt(attrsStart, 0));
    firstAttributeStartOrElementEnd = SP[0] | 0;
  }
  const nameHasComment = cm.hasCommentInRange(typeArgumentsOrNameEnd, firstAttributeStartOrElementEnd);

  let layout = LAYOUT_INDENT_ATTRIBUTES;
  if (isSelfClosing && attrsLen === 0 && !nameHasComment) layout = LAYOUT_INLINE;
  else if (attrsLen === 1 && !nameHasComment && !lastAttributeHasComment) {
    const value = asStringLiteralAttributeValue(listAt(attrsStart, 0));
    if (value >= 0 && !hasLineBreak(value, f)) layout = LAYOUT_SINGLE_STRING_ATTRIBUTE;
  }

  if (layout === LAYOUT_INLINE) {
    writeOpen(e, tag, parent, typeArgsStart, typeArgsLen, f);
    f.space();
    writeClose(isSelfClosing, f);
    return;
  }
  if (layout === LAYOUT_SINGLE_STRING_ATTRIBUTE) {
    // Nothing in the group breaks. After a line break in a fill, it is the group that is measured.
    f.startGroup();
    writeOpen(e, tag, parent, typeArgsStart, typeArgsLen, f);
    f.space();
    writeAttributes(attrsStart, attrsLen, f);
    if (isSelfClosing) f.space();
    writeClose(isSelfClosing, f);
    f.endGroup();
    return;
  }

  let hasMultilineStringAttribute = false;
  for (let i = 0; i < attrsLen; i++) {
    const value = asStringLiteralAttributeValue(listAt(attrsStart, i));
    if (value >= 0 && hasLineBreak(value, f)) {
      hasMultilineStringAttribute = true;
      break;
    }
  }
  f.startGroupExpand(hasMultilineStringAttribute);
  writeOpen(e, tag, parent, typeArgsStart, typeArgsLen, f);
  if (attrsLen > 0) {
    f.startSoftLineIndentOrSpace();
    writeAttributes(attrsStart, attrsLen, f);
    f.endSoftLineIndentOrSpace();
  }
  cm.commentsBefore(spanEnd);
  formatTrailingCommentsRange(cm.from, cm.to, f);

  const forceBracketSameLine = f.options.bracketSameLine;
  const wantsBracketSameLine = attrsLen === 0 && !nameHasComment;
  if (isSelfClosing) {
    f.softLineBreakOrSpace();
    writeClose(isSelfClosing, f);
  } else if (lastAttributeHasComment) {
    f.softLineBreak();
    writeClose(isSelfClosing, f);
  } else if ((forceBracketSameLine && attrsLen > 0) || wantsBracketSameLine) {
    writeClose(isSelfClosing, f);
  } else {
    f.softLineBreak();
    writeClose(isSelfClosing, f);
  }
  f.endGroup();
}

/** `format_open`: `<`, the name, the type arguments. */
function writeOpen(e: number, tag: number, parent: number, typeArgsStart: number, typeArgsLen: number, f: Formatter): void {
  f.token(LANGLE);
  if (tag >= 0) fmtJsxName(tag, parent, f);
  typeArgumentsOf(e, typeArgsStart, typeArgsLen, f);
}

function typeArgumentsOf(e: number, start: number, len: number, f: Formatter): void {
  typeArguments(start, len, nodeOfExpr(e), f);
}

/** `format_close`: `/>` or `>`. */
function writeClose(isSelfClosing: boolean, f: Formatter): void {
  if (isSelfClosing) f.token(SLASH);
  f.token(RANGLE);
}

/** `format_attributes` */
function writeAttributes(attrsStart: number, attrsLen: number, f: Formatter): void {
  const multiline = f.options.attributePosition === ATTRIBUTE_POSITION_MULTILINE && attrsLen > 1;
  const src = cxOf(f).src;
  let previous = -1;
  for (let i = 0; i < attrsLen; i++) {
    const attribute = listAt(attrsStart, i);
    // An empty line between two attributes is kept.
    if (previous >= 0) {
      propSpan(previous);
      if (isNextLineEmpty(src, SP[1] | 0)) f.emptyLine();
      else if (multiline) f.hardLineBreak();
      else f.softLineBreakOrSpace();
    }
    previous = attribute;
    fmtProp(attribute, f);
  }
}
