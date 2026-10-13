// Port of vendor/bun/src/format/html/utilities.rs: Prettier's `language-html/utilities/index.js` and `utilities/html-whitespace.js`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import { HTML_WS_IGNORE, HTML_WS_STRICT } from "../options.ts";
import {
  DISPLAY_BLOCK,
  DISPLAY_INLINE,
  DISPLAY_INLINE_BLOCK,
  DISPLAY_NONE,
  DISPLAY_TABLE,
  cssDisplayOfTag,
  defIgnoreFirstLf,
  displayFromName,
  displayIsBlockLike,
  eqLit,
  eqLitIgnoreCase,
  isPreTag,
} from "./data.ts";
import {
  AF_HAS_VAL,
  AF_VAL_E,
  AF_VAL_S,
  AF_VSP_E,
  AF_VSP_S,
  AF_HAS_VSP,
  F_DISPLAY,
  F_FLAGS,
  HAS_END_SPAN,
  HAS_EXPLICIT_NAMESPACE,
  HAS_LEADING_SPACES,
  HAS_TRAILING_SPACES,
  HTree,
  IS_COMPLETE,
  IS_SELF_CLOSING,
  IS_LEADING_SPACE_SENSITIVE,
  IS_TRAILING_SPACE_SENSITIVE,
  K_COMMENT,
  K_ELEMENT,
  K_FRONT_MATTER,
  K_ANGULAR_CONTROL_FLOW_BLOCK,
  K_IE_CONDITIONAL_COMMENT,
  K_INTERPOLATION,
  K_ROOT,
  K_TEXT,
  P_HTML,
  P_LWC,
  P_MJML,
  P_VUE,
  F_DEF,
  F_NAME_E,
  F_NAME_S,
  F_NS_E,
  F_NS_S,
  F_SPAN_E,
  F_SPAN_S,
  attribute,
  attributeWithValue,
  aGet,
  displayOf,
  firstChild,
  flagsOf,
  has,
  hasAny,
  hasChildren,
  hasChildrenProperty,
  hasEndSpan,
  hasStartSpan,
  kindOf,
  lastChild,
  nGet,
  nameEnd,
  nameStart,
  nextOf,
  nodeIsFullName,
  nsEnd,
  nsIsEmpty,
  nsStart,
  onlyChild,
  parentOf,
  prevOf,
  valEnd,
  valStart,
  nSet,
  STRIDE,
  F_START_E,
  F_START_S,
  F_END_E,
  F_END_S,
} from "./ast.ts";
import { HOptions } from "./hoptions.ts";

export function isAsciiWs(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 12 || b === 13;
}

/** The end of `buf[s, e)` without the ASCII white space at its end (`trim_ascii_end`). */
export function trimAsciiEnd(buf: Uint8Array, s: number, e: number): number {
  let end = e;
  while (end > s && isAsciiWs(buf[end - 1] | 0)) end = end - 1;
  return end;
}

/** The start of `buf[s, e)` without the ASCII white space at its start (`trim_ascii_start`). */
export function trimAsciiStart(buf: Uint8Array, s: number, e: number): number {
  let start = s;
  while (start < e && isAsciiWs(buf[start] | 0)) start = start + 1;
  return start;
}

// ───────────────────────────── `htmlWhitespace` ─────────────────────────────

/** `htmlWhitespace.dedentString(text)`: by how much every line is to be shortened at its start. */
export function minIndentation(buf: Uint8Array, s: number, e: number): number {
  let min = -1;
  let ls = s;
  for (;;) {
    let le = ls;
    while (le < e && (buf[le] | 0) !== 10) le = le + 1;
    if (le > ls) {
      const indentation = trimAsciiStart(buf, ls, le) - ls;
      if (indentation === 0) return 0;
      if (le - ls !== indentation) {
        if (min < 0 || indentation < min) min = indentation;
      }
    }
    if (le >= e) break;
    ls = le + 1;
  }
  return min < 0 ? 0 : min;
}

/**
 * `htmlWhitespace.dedentString(text)`: appends the dedented text to `out`. Returns false (and appends nothing) if it is the same.
 */
export function dedentString(buf: Uint8Array, s: number, e: number, out: ByteBuf): boolean {
  const min = minIndentation(buf, s, e);
  if (min === 0) return false;
  let ls = s;
  let first = true;
  for (;;) {
    let le = ls;
    while (le < e && (buf[le] | 0) !== 10) le = le + 1;
    if (!first) out.push(10);
    first = false;
    if (le - ls > min) out.append(buf, ls + min, le);
    if (le >= e) break;
    ls = le + 1;
  }
  return true;
}

/** The range that `htmlTrimPreserveIndentation` makes of `buf[s, e)`: `TRIM[0]`, `TRIM[1]`. */
export const TRIM = new Int32Array(2);

/** `htmlTrimPreserveIndentation` */
export function htmlTrimPreserveIndentation(buf: Uint8Array, s: number, e: number): void {
  // `.replaceAll(/^[\t\f\r ]*\n/g, "")`: without the `m` flag, it is one line at most.
  const end = trimAsciiEnd(buf, s, e);
  let at = s;
  while (at < end) {
    const b = buf[at] | 0;
    if (b === 9 || b === 12 || b === 13 || b === 32) at = at + 1;
    else break;
  }
  if (at < end && (buf[at] | 0) === 10) {
    TRIM[0] = at + 1;
  } else {
    TRIM[0] = s;
  }
  TRIM[1] = end;
}

// ───────────────────────────── nodes ─────────────────────────────

/** `isUnknownNamespace` */
export function isUnknownNamespace(t: HTree, id: number): boolean {
  if (kindOf(t, id) !== K_ELEMENT || has(t, id, HAS_EXPLICIT_NAMESPACE)) return false;
  const b = t.pool.data;
  const s = nsStart(t, id);
  const e = nsEnd(t, id);
  return !(eqLit(b, s, e, "html") || eqLit(b, s, e, "svg"));
}

/** `isTextLikeNode` */
export function isTextLike(t: HTree, id: number): boolean {
  const k = kindOf(t, id);
  return k === K_TEXT || k === K_COMMENT;
}

/** `isPreLikeNode` and `isIndentationSensitiveNode` */
export function isPreLike(t: HTree, id: number): boolean {
  return (
    kindOf(t, id) === K_ELEMENT &&
    (nsIsEmpty(t, id) || isUnknownNamespace(t, id)) &&
    isPreTag(t.pool.data, nameStart(t, id), nameEnd(t, id))
  );
}

/** `isScriptLikeTag` */
export function isScriptLikeTag(t: HTree, id: number, o: HOptions): boolean {
  if (kindOf(t, id) !== K_ELEMENT) return false;
  const b = t.pool.data;
  const ns = nameStart(t, id);
  const ne = nameEnd(t, id);
  if (eqLit(b, ns, ne, "script") || eqLit(b, ns, ne, "style")) {
    return nsIsEmpty(t, id) || eqLit(b, nsStart(t, id), nsEnd(t, id), "svg") || isUnknownNamespace(t, id);
  }
  if (eqLit(b, ns, ne, "mj-style")) return nsIsEmpty(t, id) && o.parser === P_MJML;
  return false;
}

/** `isPrettierIgnore` */
function isPrettierIgnore(t: HTree, id: number): boolean {
  if (kindOf(t, id) !== K_COMMENT) return false;
  const b = t.pool.data;
  const s = trimJsWhitespaceStart(b, valStart(t, id), valEnd(t, id));
  const e = trimJsWhitespaceEnd(b, s, valEnd(t, id));
  return eqLit(b, s, e, "prettier-ignore");
}

/** `unescapeQuoteEntities`: the result is `UQ.buf[UQ.s, UQ.e)`. */
export class Unescaped {
  buf: Uint8Array = new Uint8Array(0);
  s: number = 0;
  e: number = 0;
}
export const UQ = new Unescaped();
export function unescapeQuoteEntities(buf: Uint8Array, s: number, e: number): void {
  // Is there an `&apos;` or `&quot;`?
  let found = false;
  for (let i = s; i + 5 < e; i++) {
    if ((buf[i] | 0) === 38 && (isEntityAt(buf, i, e, "&apos;") || isEntityAt(buf, i, e, "&quot;"))) {
      found = true;
      break;
    }
  }
  if (!found) {
    UQ.buf = buf;
    UQ.s = s;
    UQ.e = e;
    return;
  }
  const out = new ByteBuf(e - s);
  let i = s;
  while (i < e) {
    const b = buf[i] | 0;
    if (b === 38) {
      if (isEntityAt(buf, i, e, "&apos;")) {
        out.push(39);
        i = i + 6;
        continue;
      }
      if (isEntityAt(buf, i, e, "&quot;")) {
        out.push(34);
        i = i + 6;
        continue;
      }
    }
    out.push(b);
    i = i + 1;
  }
  UQ.buf = out.data;
  UQ.s = 0;
  UQ.e = out.len;
}

function isEntityAt(buf: Uint8Array, at: number, e: number, lit: string): boolean {
  if (at + lit.length > e) return false;
  for (let i = 0; i < lit.length; i++) {
    if ((buf[at + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** `/^PRETTIER_HTML_PLACEHOLDER_\d+_\d+_IN_JS$/.test(value)` */
export function isPlaceholderInJs(buf: Uint8Array, s: number, e: number): boolean {
  const prefix = "PRETTIER_HTML_PLACEHOLDER_";
  if (!isEntityAt(buf, s, e, prefix)) return false;
  let at = s + prefix.length;
  let d = at;
  while (d < e && (buf[d] | 0) >= 48 && (buf[d] | 0) <= 57) d = d + 1;
  if (d === at) return false;
  at = d;
  if (at >= e || (buf[at] | 0) !== 95) return false;
  at = at + 1;
  d = at;
  while (d < e && (buf[d] | 0) >= 48 && (buf[d] | 0) <= 57) d = d + 1;
  if (d === at) return false;
  return eqLit(buf, d, e, "_IN_JS");
}

/** `shouldUnquoteAttributeValue` of the attribute `a`. */
export function shouldUnquoteAttributeValue(t: HTree, a: number, o: HOptions): boolean {
  if (aGet(t, a, AF_HAS_VSP) === 0 || aGet(t, a, AF_HAS_VAL) === 0) return false;
  const vs = aGet(t, a, AF_VAL_S);
  const ve = aGet(t, a, AF_VAL_E);
  // `isAttributeValueQuoted`
  if (aGet(t, a, AF_VSP_E) - aGet(t, a, AF_VSP_S) === ve - vs + 2) return false;
  const b = t.pool.data;
  if (isPlaceholderInJs(b, vs, ve)) return true;
  return o.parser === P_LWC && ve > vs && (b[vs] | 0) === 123 && (b[ve - 1] | 0) === 125;
}

/** `preferHardlineAsSurroundingSpaces` */
function preferHardlineAsSurroundingSpaces(t: HTree, id: number): boolean {
  const k = kindOf(t, id);
  if (k === K_IE_CONDITIONAL_COMMENT || k === K_COMMENT) return true;
  if (k === K_ELEMENT) {
    const b = t.pool.data;
    return eqLit(b, nameStart(t, id), nameEnd(t, id), "script") || eqLit(b, nameStart(t, id), nameEnd(t, id), "select");
  }
  return false;
}

function isTextOrInterpolation(t: HTree, id: number): boolean {
  const k = kindOf(t, id);
  return k === K_TEXT || k === K_INTERPOLATION;
}

/** By how many lines the start of `second` is below the end of `first`, up to two. */
function linesBetween(o: HOptions, firstEnd: number, secondStart: number): number {
  const text = o.originalText;
  if (firstEnd > secondStart || secondStart > text.length) return 0;
  let i = firstEnd;
  while (i < secondStart && (text[i] | 0) !== 10) i = i + 1;
  if (i >= secondStart) return 0;
  i = i + 1;
  while (i < secondStart && (text[i] | 0) !== 10) i = i + 1;
  return i < secondStart ? 2 : 1;
}

/** `hasPrettierIgnore` */
export function hasPrettierIgnore(t: HTree, id: number): boolean {
  const p = prevOf(t, id);
  return p >= 0 && isPrettierIgnore(t, p);
}

/** `isVueSfcBlock` */
export function isVueSfcBlock(t: HTree, id: number, o: HOptions): boolean {
  if (o.parser !== P_VUE || kindOf(t, id) !== K_ELEMENT) return false;
  const p = parentOf(t, id);
  if (p < 0 || kindOf(t, p) !== K_ROOT) return false;
  return !(nsIsEmpty(t, id) && eqLitIgnoreCase(t.pool.data, nameStart(t, id), nameEnd(t, id), "html"));
}

/** `isVueCustomBlock` */
export function isVueCustomBlock(t: HTree, id: number, o: HOptions): boolean {
  if (!isVueSfcBlock(t, id, o)) return false;
  if (!nsIsEmpty(t, id)) return true;
  const b = t.pool.data;
  const s = nameStart(t, id);
  const e = nameEnd(t, id);
  return !(eqLit(b, s, e, "template") || eqLit(b, s, e, "style") || eqLit(b, s, e, "script"));
}

/** `isVueNonHtmlBlock` */
export function isVueNonHtmlBlock(t: HTree, id: number, o: HOptions): boolean {
  if (!isVueSfcBlock(t, id, o)) return false;
  if (isVueCustomBlock(t, id, o)) return true;
  const a = attributeWithValue(t, id, "lang");
  return a >= 0 && !eqLit(t.pool.data, aGet(t, a, AF_VAL_S), aGet(t, a, AF_VAL_E), "html");
}

/** `isVueScriptTag` */
export function isVueScriptTag(t: HTree, id: number, o: HOptions): boolean {
  return isVueSfcBlock(t, id, o) && eqLit(t.pool.data, nameStart(t, id), nameEnd(t, id), "script");
}

/** `shouldPreserveContent`, once nothing in `id` changes any more. It looks at all children. */
export function shouldPreserveContent(t: HTree, id: number, o: HOptions): boolean {
  if (kindOf(t, id) === K_IE_CONDITIONAL_COMMENT) {
    // An element that is not closed in the comment, or something that cannot be parsed.
    const last = lastChild(t, id);
    if (last >= 0 && !has(t, last, IS_SELF_CLOSING) && !has(t, last, HAS_END_SPAN)) return true;
    if (!has(t, id, IS_COMPLETE)) return true;
  }
  if (isPreLike(t, id)) {
    for (let c = firstChild(t, id); c >= 0; c = nextOf(t, c)) {
      if (!isTextOrInterpolation(t, c)) return true;
    }
  }
  return isVueNonHtmlBlock(t, id, o) && !isScriptLikeTag(t, id, o);
}

/** `isWhitespaceSensitiveNode` */
export function isWhitespaceSensitive(t: HTree, id: number, o: HOptions): boolean {
  return isScriptLikeTag(t, id, o) || kindOf(t, id) === K_INTERPOLATION || isPreLike(t, id);
}

/** What `isLeadingSpaceSensitiveNode` and `isTrailingSpaceSensitiveNode` have in common. `neighbor`: the sibling on the side in question. */
function isSpaceSensitive(t: HTree, id: number, neighbor: number, o: HOptions): boolean {
  const kind = kindOf(t, id);
  if (kind === K_FRONT_MATTER || kind === K_ANGULAR_CONTROL_FLOW_BLOCK) return false;
  if (isTextOrInterpolation(t, id) && neighbor >= 0 && isTextOrInterpolation(t, neighbor)) return true;
  const parent = parentOf(t, id);
  if (parent < 0) return false;
  const pd = displayOf(t, parent);
  if (pd === DISPLAY_NONE) return false;
  if (isPreLike(t, parent)) return true;
  if (neighbor < 0) {
    return !(
      kindOf(t, parent) === K_ROOT ||
      isPreLike(t, id) ||
      isScriptLikeTag(t, parent, o) ||
      isVueCustomBlock(t, parent, o) ||
      displayIsBlockLike(pd) ||
      pd === DISPLAY_INLINE_BLOCK
    );
  }
  return !displayIsBlockLike(displayOf(t, neighbor));
}

/** `isLeadingSpaceSensitiveNode` */
export function isLeadingSpaceSensitive(t: HTree, id: number, o: HOptions): boolean {
  const prev = prevOf(t, id);
  const isSensitive = isSpaceSensitive(t, id, prev, o);
  if (isSensitive && prev < 0) {
    const parent = parentOf(t, id);
    if (parent >= 0 && kindOf(t, parent) === K_ELEMENT && tagIgnoresFirstLf(t, parent)) {
      return kindOf(t, id) === K_INTERPOLATION;
    }
  }
  return isSensitive;
}

function tagIgnoresFirstLf(t: HTree, id: number): boolean {
  return defIgnoreFirstLf(nGet(t, id, F_DEF));
}


/** `isTrailingSpaceSensitiveNode` */
export function isTrailingSpaceSensitive(t: HTree, id: number, o: HOptions): boolean {
  return isSpaceSensitive(t, id, nextOf(t, id), o);
}

/** `isDanglingSpaceSensitiveNode` */
export function isDanglingSpaceSensitive(t: HTree, id: number, o: HOptions): boolean {
  const d = displayOf(t, id);
  return !displayIsBlockLike(d) && d !== DISPLAY_INLINE_BLOCK && !isScriptLikeTag(t, id, o);
}

/** `forceNextEmptyLine` */
export function forceNextEmptyLine(t: HTree, id: number, o: HOptions): boolean {
  if (kindOf(t, id) === K_FRONT_MATTER) return true;
  const next = nextOf(t, id);
  return next >= 0 && linesBetween(o, nGet(t, id, F_SPAN_E), nGet(t, next, F_SPAN_S)) > 1;
}

/** `hasNonTextChild` */
function hasNonTextChild(t: HTree, id: number): boolean {
  if (!hasChildrenProperty(t, id)) return false;
  for (let c = firstChild(t, id); c >= 0; c = nextOf(t, c)) {
    if (kindOf(t, c) !== K_TEXT) return true;
  }
  return false;
}

/** `forceBreakContent` */
export function forceBreakContent(t: HTree, id: number, o: HOptions): boolean {
  if (forceBreakChildren(t, id)) return true;
  if (kindOf(t, id) === K_ELEMENT && hasChildren(t, id)) {
    const b = t.pool.data;
    const s = nameStart(t, id);
    const e = nameEnd(t, id);
    if (eqLit(b, s, e, "body") || eqLit(b, s, e, "script") || eqLit(b, s, e, "style")) return true;
    for (let c = firstChild(t, id); c >= 0; c = nextOf(t, c)) {
      if (hasNonTextChild(t, c)) return true;
    }
  }
  const only = onlyChild(t, id);
  if (only >= 0) {
    return (
      kindOf(t, only) !== K_TEXT &&
      hasLeadingLineBreak(t, only, o) &&
      (!has(t, only, IS_TRAILING_SPACE_SENSITIVE) || hasTrailingLineBreak(t, only, o))
    );
  }
  return false;
}

/** `forceBreakChildren` */
export function forceBreakChildren(t: HTree, id: number): boolean {
  if (kindOf(t, id) !== K_ELEMENT || !hasChildren(t, id)) return false;
  const b = t.pool.data;
  const s = nameStart(t, id);
  const e = nameEnd(t, id);
  switch (e - s) {
    case 2:
      if (eqLit(b, s, e, "ul") || eqLit(b, s, e, "ol")) return true;
      break;
    case 4:
      if (eqLit(b, s, e, "html") || eqLit(b, s, e, "head")) return true;
      break;
    case 6:
      if (eqLit(b, s, e, "select")) return true;
      break;
    default:
      break;
  }
  return displayOf(t, id) === DISPLAY_TABLE;
}

/** `preferHardlineAsLeadingSpaces` */
export function preferHardlineAsLeadingSpaces(t: HTree, id: number, o: HOptions): boolean {
  if (preferHardlineAsSurroundingSpaces(t, id)) return true;
  const prev = prevOf(t, id);
  if (prev >= 0 && preferHardlineAsTrailingSpaces(t, prev, o)) return true;
  return hasSurroundingLineBreak(t, id, o);
}

function preferHardlineAsTrailingSpaces(t: HTree, id: number, o: HOptions): boolean {
  return (
    preferHardlineAsSurroundingSpaces(t, id) ||
    (kindOf(t, id) === K_ELEMENT && nodeIsFullName(t, id, "br")) ||
    hasSurroundingLineBreak(t, id, o)
  );
}

function hasSurroundingLineBreak(t: HTree, id: number, o: HOptions): boolean {
  return hasLeadingLineBreak(t, id, o) && hasTrailingLineBreak(t, id, o);
}

function hasLeadingLineBreak(t: HTree, id: number, o: HOptions): boolean {
  if (!has(t, id, HAS_LEADING_SPACES)) return false;
  const prev = prevOf(t, id);
  const parent = parentOf(t, id);
  if (prev >= 0) return linesBetween(o, nGet(t, prev, F_SPAN_E), nGet(t, id, F_SPAN_S)) > 0;
  if (parent >= 0) {
    if (kindOf(t, parent) === K_ROOT) return true;
    if (hasStartSpan(t, parent)) return linesBetween(o, nGet(t, parent, F_START_E), nGet(t, id, F_SPAN_S)) > 0;
    return false;
  }
  return false;
}

function hasTrailingLineBreak(t: HTree, id: number, o: HOptions): boolean {
  if (!has(t, id, HAS_TRAILING_SPACES)) return false;
  const next = nextOf(t, id);
  const parent = parentOf(t, id);
  if (next >= 0) return linesBetween(o, nGet(t, id, F_SPAN_E), nGet(t, next, F_SPAN_S)) > 0;
  if (parent >= 0) {
    if (kindOf(t, parent) === K_ROOT) return true;
    if (hasEndSpan(t, parent)) return linesBetween(o, nGet(t, id, F_SPAN_E), nGet(t, parent, F_END_S)) > 0;
    return false;
  }
  return false;
}

/** `getNodeCssStyleDisplay`. `isInSvgForeignObject`: the node or something around it is one. */
export function cssDisplay(t: HTree, id: number, isInSvgForeignObject: boolean, o: HOptions): number {
  if (isVueSfcBlock(t, id, o)) return DISPLAY_BLOCK;
  const b = t.pool.data;
  // `<!-- display: block -->`: `/^\s*display:\s*([a-z]+)\s*$/`
  const prev = prevOf(t, id);
  if (prev >= 0 && kindOf(t, prev) === K_COMMENT) {
    const s = trimJsWhitespaceStart(b, valStart(t, prev), valEnd(t, prev));
    const e = trimJsWhitespaceEnd(b, s, valEnd(t, prev));
    if (e - s >= 8 && eqLit(b, s, s + 8, "display:")) {
      const vs = trimJsWhitespaceStart(b, s + 8, e);
      if (vs < e) {
        let allLower = true;
        for (let i = vs; i < e; i++) {
          const c = b[i] | 0;
          if (c < 97 || c > 122) {
            allLower = false;
            break;
          }
        }
        if (allLower) return displayFromName(b, vs, e);
      }
    }
  }
  const isElement = kindOf(t, id) === K_ELEMENT;
  const isSvg = isElement && eqLit(b, nsStart(t, id), nsEnd(t, id), "svg");
  if (isSvg && !isInSvgForeignObject) {
    return eqLit(b, nameStart(t, id), nameEnd(t, id), "svg") ? DISPLAY_INLINE_BLOCK : DISPLAY_BLOCK;
  }
  const sensitivity = o.format.htmlWhitespaceSensitivity;
  if (sensitivity === HTML_WS_STRICT) return DISPLAY_INLINE;
  if (sensitivity === HTML_WS_IGNORE) return DISPLAY_BLOCK;
  const isHtml = isElement && (nsIsEmpty(t, id) || isSvg || isUnknownNamespace(t, id));
  if (isHtml) {
    const d = cssDisplayOfTag(b, nameStart(t, id), nameEnd(t, id));
    if (d >= 0) return d;
  }
  return DISPLAY_INLINE;
}

void attribute;
void hasAny;
void flagsOf;
void nSet;
void STRIDE;
void F_FLAGS;
void F_DISPLAY;
void F_NAME_E;
void F_NAME_S;
void F_NS_E;
void F_NS_S;
void F_START_S;
void F_END_E;
void IS_LEADING_SPACE_SENSITIVE;
void HAS_TRAILING_SPACES;
void P_HTML;
void DISPLAY_INLINE_BLOCK;
