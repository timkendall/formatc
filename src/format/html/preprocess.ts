// Port of vendor/bun/src/format/html/preprocess.rs: Prettier's `language-html/print-preprocess.js`.
//
// Prettier walks the tree ten times. Each of its steps looks at a node and its children, so here all of them are done for a node, in the
// same order, before its children have their turn. Only the last step comes after them.
import { Stack } from "../../base/stack.ts";
import { jsWhitespaceLen } from "../text.ts";
import { utf16Len } from "../../base/utf8.ts";
import {
  F_DEF,
  F_DISPLAY,
  F_FLAGS,
  F_KIND,
  F_SPAN_E,
  F_SPAN_S,
  F_START_E,
  F_START_S,
  F_END_E,
  F_END_S,
  HAS_CONDITION,
  HAS_DANGLING_SPACES,
  HAS_END_SPAN,
  HAS_HTM_COMPONENT_CLOSING_TAG,
  HAS_LEADING_SPACES,
  HAS_TRAILING_SPACES,
  HTree,
  IS_DANGLING_SPACE_SENSITIVE,
  IS_INDENTATION_SENSITIVE,
  IS_LEADING_SPACE_SENSITIVE,
  IS_SELF_CLOSING,
  IS_TRAILING_SPACE_SENSITIVE,
  IS_WHITESPACE_SENSITIVE,
  K_ANGULAR_CONTROL_FLOW_BLOCK,
  K_CDATA,
  K_COMMENT,
  K_DOC_TYPE,
  K_ELEMENT,
  K_IE_CONDITIONAL_END_COMMENT,
  K_IE_CONDITIONAL_START_COMMENT,
  K_INTERPOLATION,
  K_TEXT,
  P_HTML,
  PRESERVES_CONTENT,
  addNode,
  addText,
  appendChild,
  clearChildren,
  firstChild,
  has,
  hasAny,
  hasChildren,
  hasChildrenProperty,
  hasEndSpan,
  insertBefore,
  insertFlags,
  kindOf,
  lastChild,
  nGet,
  nSet,
  nameEnd,
  nameStart,
  nextOf,
  nodeHasAttrs,
  nodeHasStartTagComments,
  nsEnd,
  nsStart,
  onlyChild,
  prevOf,
  removeFlags,
  removeNode,
  setFlag,
  setStartSpan,
  setValue,
  spanEnd,
  spanStart,
  valEnd,
  valStart,
} from "./ast.ts";
import { defIgnoreFirstLf, defIsVoid, eqLit } from "./data.ts";
import { HOptions } from "./hoptions.ts";
import {
  cssDisplay,
  isAsciiWs,
  isDanglingSpaceSensitive,
  isLeadingSpaceSensitive,
  isPreLike,
  isScriptLikeTag,
  isTrailingSpaceSensitive,
  isWhitespaceSensitive,
  shouldPreserveContent,
  trimAsciiEnd,
  trimAsciiStart,
} from "./utilities.ts";

class Preprocessor {
  t: HTree;
  o: HOptions;
  stack: Stack;
  isNestedTooDeeply: boolean;
  constructor(t: HTree, o: HOptions) {
    this.t = t;
    this.o = o;
    this.stack = Stack.forTree();
    this.isNestedTooDeeply = false;
  }
}

/** Returns whether the tree is not nested too deeply. */
export function preprocess(t: HTree, o: HOptions): boolean {
  const root = t.root;
  nSet(t, root, F_DISPLAY, cssDisplay(t, root, false, o));
  const p = new Preprocessor(t, o);
  visit(p, root, false);
  return !p.isNestedTooDeeply;
}

/** `ParseLocation.moveBy`: where `units` UTF-16 code units of `text` end that start at `start`. */
function movedBy(text: Uint8Array, start: number, units0: number): number {
  let units = units0;
  let at = start;
  while (units > 0 && at < text.length) {
    const first = text[at] | 0;
    const len = first < 0xc0 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
    units = units - (len === 4 ? 2 : 1);
    if (units < 0) units = 0;
    at = at + len;
  }
  return at < text.length ? at : text.length;
}

function isSvgForeignObject(t: HTree, id: number): boolean {
  if (kindOf(t, id) !== K_ELEMENT) return false;
  const b = t.pool.data;
  return eqLit(b, nsStart(t, id), nsEnd(t, id), "svg") && eqLit(b, nameStart(t, id), nameEnd(t, id), "foreignObject");
}

function visit(p: Preprocessor, id: number, isInSvgForeignObject: boolean): void {
  const t = p.t;
  const o = p.o;
  if (!p.stack.enter()) {
    p.isNestedTooDeeply = true;
    return;
  }
  const hasChildrenProp = hasChildrenProperty(t, id);
  if (hasChildrenProp) {
    removeIgnorableFirstLf(p, id);
    mergeIeConditionalStartEndCommentIntoElementOpeningTag(p, id);
    mergeCdataIntoText(p, id);
    extractInterpolation(p, id);
  }
  extractWhitespaces(p, id);
  let next = firstChild(t, id);
  while (next >= 0) {
    const child = next;
    next = nextOf(t, child);
    const inSvg = isInSvgForeignObject || isSvgForeignObject(t, child);
    nSet(t, child, F_DISPLAY, cssDisplay(t, child, inSvg, o));
    addIsSelfClosing(p, child);
    addHasHtmComponentClosingTag(p, child);
  }
  if (hasChildrenProp) addIsSpaceSensitive(p, id);
  next = firstChild(t, id);
  while (next >= 0) {
    const child = next;
    next = nextOf(t, child);
    const k = kindOf(t, child);
    if (k !== K_TEXT && k !== K_COMMENT && k !== K_DOC_TYPE) {
      visit(p, child, isInSvgForeignObject || isSvgForeignObject(t, child));
    }
  }
  if (hasChildrenProp) mergeSimpleElementIntoText(p, id);
  // Prettier does this when it prints the block.
  if (kindOf(t, id) === K_ANGULAR_CONTROL_FLOW_BLOCK) {
    const first = firstChild(t, id);
    const last = lastChild(t, id);
    if (first >= 0 && last >= 0) {
      insertFlags(t, first, HAS_LEADING_SPACES);
      insertFlags(t, last, HAS_TRAILING_SPACES);
    }
  }
  // Every child without an end tag asks when it is printed.
  setFlag(t, id, PRESERVES_CONTENT, shouldPreserveContent(t, id, o));
  p.stack.leave();
}

function removeIgnorableFirstLf(p: Preprocessor, id: number): void {
  const t = p.t;
  if (kindOf(t, id) !== K_ELEMENT || !defIgnoreFirstLfOf(t, id) || has(t, id, HAS_CONDITION)) return;
  const first = firstChild(t, id);
  if (first < 0) return;
  if (kindOf(t, first) !== K_TEXT) return;
  const vs = valStart(t, first);
  const ve = valEnd(t, first);
  if (vs >= ve || (t.pool.data[vs] | 0) !== 10) return;
  if (ve - vs === 1) removeNode(t, first);
  else setValue(t, first, vs + 1, ve);
}

function defIgnoreFirstLfOf(t: HTree, id: number): boolean {
  return defIgnoreFirstLf(nGet(t, id, F_DEF));
}

/** `<!--[if ...]><!--><target><!--<![endif]-->` */
function mergeIeConditionalStartEndCommentIntoElementOpeningTag(p: Preprocessor, id: number): void {
  const t = p.t;
  let next = firstChild(t, id);
  while (next >= 0) {
    const child = next;
    next = nextOf(t, child);
    if (kindOf(t, child) !== K_ELEMENT) continue;
    const startComment = prevOf(t, child);
    const endComment = firstChild(t, child);
    if (startComment < 0 || endComment < 0) continue;
    const ss = nGet(t, child, F_START_S);
    const se = nGet(t, child, F_START_E);
    const isTarget =
      kindOf(t, startComment) === K_IE_CONDITIONAL_START_COMMENT &&
      spanEnd(t, startComment) === ss &&
      kindOf(t, endComment) === K_IE_CONDITIONAL_END_COMMENT &&
      spanStart(t, endComment) === se;
    if (!isTarget) continue;
    removeNode(t, startComment);
    removeNode(t, endComment);
    const startSpanS = spanStart(t, startComment);
    const startSpanE = spanEnd(t, endComment);
    setValue(t, child, valStart(t, startComment), valEnd(t, startComment));
    insertFlags(t, child, HAS_CONDITION);
    nSet(t, child, F_SPAN_S, startSpanS);
    setStartSpan(t, child, startSpanS, startSpanE);
  }
}

/** The value of `a`, then the value of `b`, appended to the pool as one string; returns where it starts. Also the text in between. */
function concatToPool(t: HTree, aS: number, aE: number, lit: string, bS: number, bE: number): number {
  const at = t.pool.len;
  const pool = t.pool;
  pool.append(pool.data, aS, aE);
  if (lit.length > 0) pool.appendAscii(lit);
  pool.append(pool.data, bS, bE);
  return at;
}

/** `mergeNodeIntoText`, for CDATA sections. */
function mergeCdataIntoText(p: Preprocessor, id: number): void {
  const t = p.t;
  let next = firstChild(t, id);
  while (next >= 0) {
    const child = next;
    next = nextOf(t, child);
    const k = kindOf(t, child);
    if (k === K_TEXT) {
      // nothing to change
    } else if (k === K_CDATA) {
      nSet(t, child, F_KIND, K_TEXT);
      const at = t.pool.len;
      t.pool.appendAscii("<![CDATA[");
      t.pool.append(t.pool.data, valStart(t, child), valEnd(t, child));
      t.pool.appendAscii("]]>");
      setValue(t, child, at, t.pool.len);
    } else {
      continue;
    }
    const prev = prevOf(t, child);
    if (prev < 0 || kindOf(t, prev) !== K_TEXT) continue;
    const at = concatToPool(t, valStart(t, prev), valEnd(t, prev), "", valStart(t, child), valEnd(t, child));
    setValue(t, prev, at, t.pool.len);
    nSet(t, prev, F_SPAN_E, spanEnd(t, child));
    removeNode(t, child);
  }
}

function extractInterpolation(p: Preprocessor, id: number): void {
  const t = p.t;
  // `canHaveInterpolation`
  if (p.o.parser === P_HTML || isScriptLikeTag(t, id, p.o)) return;
  let next = firstChild(t, id);
  while (next >= 0) {
    const child = next;
    next = nextOf(t, child);
    if (kindOf(t, child) !== K_TEXT) continue;
    const vs = valStart(t, child);
    const ve = valEnd(t, child);
    if (vs === ve) {
      removeNode(t, child);
      continue;
    }
    const b = t.pool.data;
    // contains `{{`?
    let hasOpen = false;
    for (let i = vs; i + 1 < ve; i++) {
      if ((b[i] | 0) === 123 && (b[i + 1] | 0) === 123) {
        hasOpen = true;
        break;
      }
    }
    if (!hasOpen) {
      // `start.moveBy(value.length)`: a text that has been put together has less in it than there is from its start to its end.
      const s = spanStart(t, child);
      if (ve - vs !== spanEnd(t, child) - s) {
        const units = utf16Len(b, vs, ve);
        nSet(t, child, F_SPAN_E, movedBy(p.o.originalText, s, units));
      }
      continue;
    }
    const base = spanStart(t, child);
    // `value.split(/\{\{(.+?)\}\}/s)`
    let from = 0;
    const len = ve - vs;
    for (;;) {
      // The next `{{` at or after `from` with a `}}` after at least one character.
      let open = -1;
      let close = -1;
      for (let i = from; i + 1 < len; i++) {
        if ((b[vs + i] | 0) === 123 && (b[vs + i + 1] | 0) === 123) {
          open = i;
          break;
        }
      }
      if (open >= 0) {
        // `value.get(open + 3..)` then the first `}}` in it.
        for (let i = open + 3; i + 1 < len; i++) {
          if ((b[vs + i] | 0) === 125 && (b[vs + i + 1] | 0) === 125) {
            close = i;
            break;
          }
        }
        // (`open + 3 + close` is the index in the value; `close` is already that.)
      }
      const found = open >= 0 && close >= 0;
      const textEnd = found ? open : len;
      if (textEnd > from) {
        const text = addText(t, vs + from, vs + textEnd, base + from, base + textEnd);
        insertBefore(t, child, text);
      }
      if (!found) break;
      const innerS = base + open + 2;
      const innerE = base + close;
      const interpolation = addNode(t, K_INTERPOLATION, innerS - 2, innerE + 2);
      const text = addText(t, vs + open + 2, vs + close, innerS, innerE);
      appendChild(t, interpolation, text);
      insertBefore(t, child, interpolation);
      from = close + 2;
    }
    removeNode(t, child);
  }
}

function extractWhitespaces(p: Preprocessor, id: number): void {
  const t = p.t;
  const first = firstChild(t, id);
  let isBlank: boolean;
  if (first < 0) {
    isBlank = true;
  } else {
    isBlank = false;
    if (nextOf(t, first) < 0 && kindOf(t, first) === K_TEXT) {
      const b = t.pool.data;
      const s = valStart(t, first);
      const e = valEnd(t, first);
      isBlank = trimAsciiStart(b, s, e) === e;
    }
  }
  if (isBlank) {
    setFlag(t, id, HAS_DANGLING_SPACES, hasChildren(t, id));
    clearChildren(t, id);
    return;
  }
  const isWs = isWhitespaceSensitive(t, id, p.o);
  const isIndentationSensitive = isPreLike(t, id);
  if (!isWs) {
    let nextChild = firstChild(t, id);
    while (nextChild >= 0) {
      const child = nextChild;
      const prev = prevOf(t, child);
      const next = nextOf(t, child);
      nextChild = next;
      if (kindOf(t, child) !== K_TEXT) continue;
      const b = t.pool.data;
      const vs = valStart(t, child);
      const ve = valEnd(t, child);
      const ns = trimAsciiStart(b, vs, ve);
      const leading = ns - vs;
      const trailing = ve - trimAsciiEnd(b, ns, ve);
      const isAllWhitespace = ns === ve;
      const isEmpty = ve === vs;
      if (isAllWhitespace) {
        removeNode(t, child);
      } else {
        setValue(t, child, vs + leading, ve - trailing);
        const s = spanStart(t, child);
        const e = spanEnd(t, child);
        nSet(t, child, F_SPAN_S, s + leading);
        nSet(t, child, F_SPAN_E, e - trailing > 0 ? e - trailing : 0);
        setFlag(t, child, HAS_LEADING_SPACES, leading > 0);
        setFlag(t, child, HAS_TRAILING_SPACES, trailing > 0);
      }
      if ((leading > 0 || (isAllWhitespace && !isEmpty)) && prev >= 0) insertFlags(t, prev, HAS_TRAILING_SPACES);
      if ((trailing > 0 || (isAllWhitespace && !isEmpty)) && next >= 0) insertFlags(t, next, HAS_LEADING_SPACES);
    }
  }
  setFlag(t, id, IS_WHITESPACE_SENSITIVE, isWs);
  setFlag(t, id, IS_INDENTATION_SENSITIVE, isIndentationSensitive);
}

function addIsSelfClosing(p: Preprocessor, id: number): void {
  const t = p.t;
  const kind = kindOf(t, id);
  let isSelfClosing = !hasChildrenProperty(t, id);
  if (!isSelfClosing && kind === K_ELEMENT) {
    isSelfClosing =
      defIsVoidOf(t, id) ||
      (has(t, id, HAS_END_SPAN) &&
        nGet(t, id, F_START_S) === nGet(t, id, F_END_S) &&
        nGet(t, id, F_START_E) === nGet(t, id, F_END_E));
  }
  setFlag(t, id, IS_SELF_CLOSING, isSelfClosing);
}

function defIsVoidOf(t: HTree, id: number): boolean {
  return defIsVoid(nGet(t, id, F_DEF));
}

function addHasHtmComponentClosingTag(p: Preprocessor, id: number): void {
  const t = p.t;
  if (kindOf(t, id) !== K_ELEMENT) return;
  let result = false;
  if (hasEndSpan(t, id)) {
    // `/^<\s*\/\s*\/\s*>$/`
    const text = p.o.originalText;
    let at = nGet(t, id, F_END_S);
    const e = nGet(t, id, F_END_E);
    if (at < e && (text[at] | 0) === 60) {
      at = at + 1;
      result = true;
      const expected = [47, 47, 62];
      for (let k = 0; k < 3; k++) {
        while (at < e) {
          const n = jsWhitespaceLen(text, at, e);
          if (n === 0) break;
          at = at + n;
        }
        if (at < e && (text[at] | 0) === expected[k]) {
          at = at + 1;
        } else {
          result = false;
          break;
        }
      }
      if (result && at !== e) result = false;
    }
  }
  setFlag(t, id, HAS_HTM_COMPONENT_CLOSING_TAG, result);
}

function addIsSpaceSensitive(p: Preprocessor, id: number): void {
  const t = p.t;
  const o = p.o;
  const first = firstChild(t, id);
  if (first < 0) {
    setFlag(t, id, IS_DANGLING_SPACE_SENSITIVE, isDanglingSpaceSensitive(t, id, o));
    return;
  }
  let next = first;
  while (next >= 0) {
    const child = next;
    next = nextOf(t, child);
    setFlag(t, child, IS_LEADING_SPACE_SENSITIVE, isLeadingSpaceSensitive(t, child, o));
    setFlag(t, child, IS_TRAILING_SPACE_SENSITIVE, isTrailingSpaceSensitive(t, child, o));
  }
  // From the first to the last: what is asked of the one before has been settled, of the one behind not yet.
  next = first;
  while (next >= 0) {
    const child = next;
    next = nextOf(t, child);
    const prev = prevOf(t, child);
    if (prev >= 0 && !has(t, prev, IS_TRAILING_SPACE_SENSITIVE)) removeFlags(t, child, IS_LEADING_SPACE_SENSITIVE);
    const nx = nextOf(t, child);
    if (nx >= 0 && !has(t, nx, IS_LEADING_SPACE_SENSITIVE)) removeFlags(t, child, IS_TRAILING_SPACE_SENSITIVE);
  }
}

function isSimpleElement(p: Preprocessor, id: number): boolean {
  const t = p.t;
  if (kindOf(t, id) !== K_ELEMENT || nodeHasAttrs(t, id) || nodeHasStartTagComments(t, id)) return false;
  const only = onlyChild(t, id);
  if (only < 0 || kindOf(t, only) !== K_TEXT) return false;
  const b = t.pool.data;
  for (let i = valStart(t, only); i < valEnd(t, only); i++) {
    if (isAsciiWs(b[i] | 0)) return false;
  }
  if (hasAny(t, only, HAS_LEADING_SPACES | HAS_TRAILING_SPACES)) return false;
  if (!has(t, id, IS_LEADING_SPACE_SENSITIVE | IS_TRAILING_SPACE_SENSITIVE)) return false;
  if (hasAny(t, id, HAS_LEADING_SPACES | HAS_TRAILING_SPACES)) return false;
  const prev = prevOf(t, id);
  const next = nextOf(t, id);
  return prev >= 0 && kindOf(t, prev) === K_TEXT && next >= 0 && kindOf(t, next) === K_TEXT;
}

function mergeSimpleElementIntoText(p: Preprocessor, id: number): void {
  const t = p.t;
  let nextChild = firstChild(t, id);
  while (nextChild >= 0) {
    const child = nextChild;
    nextChild = nextOf(t, child);
    if (!isSimpleElement(p, child)) continue;
    const prev = prevOf(t, child);
    const next = nextOf(t, child);
    const only = firstChild(t, child);
    if (prev < 0 || next < 0 || only < 0) continue;
    nextChild = nextOf(t, next);
    // value = prev.value + "<name>" + only.value + "</name>" + next.value
    const at = t.pool.len;
    const pool = t.pool;
    pool.append(pool.data, valStart(t, prev), valEnd(t, prev));
    const hasNs = (nGet(t, child, F_FLAGS) & 4) !== 0;
    for (let k = 0; k < 2; k++) {
      pool.appendAscii(k === 0 ? "<" : "</");
      if (hasNs) {
        pool.append(pool.data, nsStart(t, child), nsEnd(t, child));
        pool.push(58);
      }
      pool.append(pool.data, nameStart(t, child), nameEnd(t, child));
      pool.push(62);
      const src = k === 0 ? only : next;
      pool.append(pool.data, valStart(t, src), valEnd(t, src));
    }
    setValue(t, prev, at, pool.len);
    nSet(t, prev, F_SPAN_E, spanEnd(t, next));
    setFlag(t, prev, IS_TRAILING_SPACE_SENSITIVE, has(t, next, IS_TRAILING_SPACE_SENSITIVE));
    setFlag(t, prev, HAS_TRAILING_SPACES, has(t, next, HAS_TRAILING_SPACES));
    removeNode(t, child);
    removeNode(t, next);
  }
}

