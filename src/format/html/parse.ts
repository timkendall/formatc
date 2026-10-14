// Port of vendor/bun/src/format/html/parse.rs: Prettier's `language-html/parse/*.js`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { Stack } from "../../base/stack.ts";
import { jsWhitespaceLen, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  AF_EXPLICIT_NS,
  AF_HAS_VAL,
  AF_HAS_VSP,
  AF_NAME_E,
  AF_NAME_S,
  AF_NSP_E,
  AF_NSP_S,
  AF_NS_E,
  AF_NS_S,
  AF_VAL_E,
  AF_VAL_S,
  AF_VSP_E,
  AF_VSP_S,
  A_STRIDE,
  F_ATTR_E,
  F_ATTR_S,
  F_DEF,
  F_FLAGS,
  F_KIND,
  F_NAME_E,
  F_NAME_S,
  F_NSP_E,
  F_NSP_S,
  F_SPAN_E,
  F_SPAN_S,
  F_START_E,
  F_START_S,
  F_END_E,
  F_END_S,
  HAS_EXPLICIT_NAMESPACE,
  HTree,
  IS_COMPLETE,
  K_ANGULAR_CONTROL_FLOW_BLOCK,
  K_COMMENT,
  K_DOC_TYPE,
  K_ELEMENT,
  K_FRONT_MATTER,
  K_IE_CONDITIONAL_COMMENT,
  K_IE_CONDITIONAL_END_COMMENT,
  K_IE_CONDITIONAL_START_COMMENT,
  K_TEXT,
  P_ANGULAR,
  P_ANGULAR_EXPRESSION,
  P_HTML,
  P_LWC,
  P_MJML,
  P_VUE,
  addNode,
  addText,
  appendChild,
  firstChild,
  insertBefore,
  kindOf,
  nGet,
  nSet,
  nameEnd,
  nameStart,
  nextOf,
  nsEnd,
  nsIsEmpty,
  nsStart,
  parentOf,
  removeNode,
  replaceNode,
  setEndSpan,
  setFlag,
  setName,
  setNamespace,
  setStartSpan,
  setValue,
  valEnd,
  valStart,
  STRIDE,
  internLit,
} from "./ast.ts";
import { DEF_DEFAULT, defHasImplicitNamespace, defIsVoid, eqLit, eqLitIgnoreCase, isAttributeOfElement, isHtmlTag } from "./data.ts";
import { EK_TEXT_BEHIND_NUL, ErrorList, E_STRIDE, errorIsOfLexer, errorMessage } from "./error.ts";
import { RAW_MJML, RAW_NONE, RAW_VUE } from "./lexer.ts";
import { ParseOptions, ParseResult, definitionOf, parse as parseTokens } from "./parser.ts";
import { isUnknownNamespace } from "./utilities.ts";

/** `parse` ends: ok. */
export const PARSE_OK: number = 0;
/** A syntax error: `PE.list` row `PE.index`. */
export const PARSE_SYNTAX: number = 1;
export const PARSE_NESTED_TOO_DEEPLY: number = 2;

/** The syntax error of the last `parse` that returned `PARSE_SYNTAX` (its `ErrorList` and the number of the row). */
export class ParseError {
  list: ErrorList = new ErrorList();
  index: number = 0;
}
export const PE = new ParseError();

function setSyntax(list: ErrorList, index: number): void {
  const PE$ = PE;
  PE$.list = list;
  PE$.index = index;
}

/** The message of the error in `PE` against the text it is of. */
export function parseErrorMessage(text: Uint8Array, out: ByteBuf): void {
  const PE$ = PE;
  errorMessage(PE$.list, PE$.index, text, out);
}
export function parseErrorAt(): number {
  const PE$ = PE;
  return PE$.list.at(PE$.index);
}

/** `ParseOptions` of Prettier for `parser`. */
export function parseOptions(parser: number): ParseOptions {
  const o = new ParseOptions();
  o.name = parser;
  if (parser === P_HTML || parser === P_MJML) {
    o.normalizeTagName = true;
    o.normalizeAttributeName = true;
    o.isTagNameCaseSensitive = false;
    o.canSelfClose = true;
    o.allowHtmComponentClosingTags = true;
    return o;
  }
  o.normalizeTagName = false;
  o.normalizeAttributeName = false;
  o.isTagNameCaseSensitive = false;
  o.canSelfClose = true;
  if (parser === P_ANGULAR) {
    o.tokenizeAngularBlocks = true;
    o.tokenizeLet = true;
    o.allowStartTagComments = true;
  } else if (parser === P_VUE) {
    o.isTagNameCaseSensitive = true;
  } else if (parser === P_LWC) {
    o.canSelfClose = false;
  }
  return o;
}

/** What `postprocess` and `parse` of Prettier work on. */
class Context {
  t: HTree;
  len: number;
  /** Whether `parseVue` is the function that parses. The options can be those of HTML all the same. */
  isVue: boolean;
  /** `parse`'s result: the options that were in the end used. */
  actual: ParseOptions;
  stack: Stack;
  constructor(t: HTree, len: number, isVue: boolean, o: ParseOptions) {
    this.t = t;
    this.len = len;
    this.isVue = isVue;
    this.actual = o;
    this.stack = Stack.forTree();
  }
}

function rawModeOf(o: ParseOptions, decidesOnRawText: boolean): number {
  if (!decidesOnRawText) return RAW_NONE;
  if (o.name === P_MJML) return RAW_MJML;
  if (o.name === P_VUE) return RAW_VUE;
  return RAW_NONE;
}

/** Returns the result, or null if the tree is nested too deeply. */
function angularHtmlParserParse(c: Context, rangeS: number, rangeE: number, o: ParseOptions, decidesOnRawText: boolean): ParseResult | null {
  const result = parseTokens(c.t, rangeE, rangeS, o, rawModeOf(o, decidesOnRawText));
  return result.isNestedTooDeeply ? null : result;
}

function sortErrorsByAt(list: ErrorList): void {
  const d = list.d;
  const n = list.count;
  const tmp = new Int32Array(E_STRIDE);
  for (let i = 1; i < n; i++) {
    let j = i;
    while (j > 0 && (d[(j - 1) * E_STRIDE] | 0) > (d[j * E_STRIDE] | 0)) {
      // Swap rows j-1 and j.
      const a = (j - 1) * E_STRIDE;
      const b = j * E_STRIDE;
      for (let k = 0; k < E_STRIDE; k++) {
        tmp[k] = d[a + k] | 0;
        d[a + k] = d[b + k] | 0;
        d[b + k] = tmp[k] | 0;
      }
      j = j - 1;
    }
  }
}

/** `parseHtml`: returns the root (>= 0), or `-1` with the status in `status`. */
let status = 0;
function parseHtml(c: Context, rangeS: number, rangeE: number, o: ParseOptions): number {
  const result = angularHtmlParserParse(c, rangeS, rangeE, o, true);
  if (result === null) {
    status = PARSE_NESTED_TOO_DEEPLY;
    return -1;
  }
  c.actual = o;
  if (result.errors.count > 0) {
    setSyntax(result.errors, 0);
    status = PARSE_SYNTAX;
    return -1;
  }
  return result.root;
}

/** `shouldParseVueRootNodeAsHtml`'s `lang` test for the element `id`. */
function isHtmlTemplate(t: HTree, id: number): boolean {
  const b = t.pool.data;
  if (!(nsIsEmpty(t, id) && eqLit(b, nameStart(t, id), nameEnd(t, id), "template"))) return false;
  const first = nGet(t, id, F_ATTR_S);
  const last = nGet(t, id, F_ATTR_E);
  for (let a = first; a < last; a++) {
    const ab = a * A_STRIDE;
    if (t.a[ab + AF_NS_S] === t.a[ab + AF_NS_E] && eqLit(b, t.a[ab + AF_NAME_S] | 0, t.a[ab + AF_NAME_E] | 0, "lang")) {
      let vs = 0;
      let ve = 0;
      if ((t.a[ab + AF_HAS_VSP] | 0) !== 0) {
        vs = t.a[ab + AF_VSP_S] | 0;
        ve = t.a[ab + AF_VSP_E] | 0;
      }
      if (ve - vs >= 2 && ((b[vs] | 0) === 34 || (b[vs] | 0) === 39)) {
        vs = vs + 1;
        ve = ve - 1;
      }
      return ve === vs || eqLit(b, vs, ve, "html");
    }
  }
  return true;
}

function parseVue(c: Context, rangeS: number, rangeE: number, o: ParseOptions): number {
  const t = c.t;
  const first = angularHtmlParserParse(c, rangeS, rangeE, o, true);
  if (first === null) {
    status = PARSE_NESTED_TOO_DEEPLY;
    return -1;
  }
  const root = first.root;
  const errors = first.errors;
  // A void element at the top makes the errors those of the second result.
  let hasErrorsOfSecond = false;
  let isHtml = false;
  for (let id = firstChild(t, root); id >= 0; id = nextOf(t, id)) {
    const k = kindOf(t, id);
    const b = t.pool.data;
    if (k === K_DOC_TYPE) {
      if (eqLit(b, valStart(t, id), valEnd(t, id), "html")) isHtml = true;
    } else if (k === K_ELEMENT) {
      if (nsIsEmpty(t, id) && eqLitIgnoreCase(b, nameStart(t, id), nameEnd(t, id), "html")) isHtml = true;
    }
    if (isHtml) break;
  }
  if (isHtml) return parseHtml(c, rangeS, rangeE, parseOptions(P_HTML));
  let second: ParseResult | null = null;
  // The first error of the second result, before they are sorted: `firstBeforeSort`.
  let hasFirstOfSecond = false;
  // The first of what the second result has at the top that does not start before the element that is looked at.
  let candidate = -1;
  let next = firstChild(t, root);
  while (next >= 0) {
    const id = next;
    next = nextOf(t, id);
    if (kindOf(t, id) !== K_ELEMENT) continue;
    const startS = nGet(t, id, F_START_S);
    const hasEnd = (nGet(t, id, F_FLAGS) & 2) !== 0;
    const endE = nGet(t, id, F_END_E);
    const isPlain = nsIsEmpty(t, id);
    const isVoid = isPlain && defIsVoid(definitionOf(t.pool.data, nameStart(t, id), nameEnd(t, id), o.isTagNameCaseSensitive));
    // `shouldParseVueRootNodeAsHtml`
    const isHtmlTemplateNode = isPlain && isHtmlTemplate(t, id);
    if (!isVoid && !isHtmlTemplateNode) continue;
    if (second === null) {
      second = angularHtmlParserParse(c, rangeS, rangeE, o, false);
      if (second === null) {
        status = PARSE_NESTED_TOO_DEEPLY;
        return -1;
      }
      if (second.errors.count > 0) {
        hasFirstOfSecond = true;
        for (let k = 0; k < E_STRIDE; k++) firstBeforeSort[k] = second.errors.d[k] | 0;
      }
      sortErrorsByAt(second.errors);
      candidate = firstChild(t, second.root);
    }
    if (isVoid) {
      hasErrorsOfSecond = true;
    } else {
      // Without an end tag, Prettier fails when it asks where that ends.
      const errs = second.errors;
      let firstIndex = 0;
      while (firstIndex < errs.count && errs.at(firstIndex) <= startS) firstIndex = firstIndex + 1;
      let endIndex = firstIndex;
      while (endIndex < errs.count && (!hasEnd || errs.at(endIndex) < endE)) endIndex = endIndex + 1;
      if (endIndex > firstIndex) {
        let pick = firstIndex;
        for (let i = firstIndex; i < endIndex; i++) {
          if (errorIsOfLexer(errs.kind(i))) {
            pick = i;
            break;
          }
        }
        setSyntax(errs, pick);
        status = PARSE_SYNTAX;
        return -1;
      }
    }
    // `getElementWithSameLocation`. Both lists are in the order of the text.
    while (candidate >= 0 && nGet(t, candidate, F_SPAN_S) < startS) candidate = nextOf(t, candidate);
    if (candidate >= 0 && kindOf(t, candidate) === K_ELEMENT && nGet(t, candidate, F_START_S) === startS) {
      const same = candidate;
      candidate = nextOf(t, same);
      removeNode(t, same);
      replaceNode(t, id, same);
    }
  }
  c.actual = o;
  if (hasErrorsOfSecond) {
    if (hasFirstOfSecond) return reportFirstBeforeSort();
    return root;
  }
  if (errors.count > 0) {
    setSyntax(errors, 0);
    status = PARSE_SYNTAX;
    return -1;
  }
  return root;
}

/** The sort has moved the first error of the second result; the one that is wanted is that which was first. */
const firstBeforeSort = new Int32Array(E_STRIDE);
function reportFirstBeforeSort(): number {
  const copy = new ErrorList();
  const f = firstBeforeSort;
  copy.push(f[0] | 0, f[1] | 0, f[2] | 0, f[3] | 0, f[4] | 0, f[5] | 0, (f[6] | 0) !== 0);
  setSyntax(copy, 0);
  status = PARSE_SYNTAX;
  return -1;
}

/** `parse`, without the front matter. Returns what has the children of the root as its children, or -1 (`status`). */
function parseRange(c: Context, rangeS: number, rangeE: number, o: ParseOptions): number {
  const root = c.isVue ? parseVue(c, rangeS, rangeE, o) : parseHtml(c, rangeS, rangeE, o);
  if (root < 0) return -1;
  if (!postprocess(c, root, c.actual)) return -1;
  return root;
}

/** `text.trim().replaceAll(/\s+/g, " ")`, appended to `out`. */
export function collapseWhiteSpace(buf: Uint8Array, s: number, e: number, out: ByteBuf): void {
  let at = trimJsWhitespaceStart(buf, s, e);
  const end = trimJsWhitespaceEnd(buf, at, e);
  let lastWasBlank = false;
  while (at < end) {
    const len = jsWhitespaceLen(buf, at, end);
    if (len > 0) {
      if (!lastWasBlank) out.push(32);
      lastWasBlank = true;
      at = at + len;
    } else {
      out.push(buf[at] | 0);
      lastWasBlank = false;
      at = at + 1;
    }
  }
}

/** `postprocess`, for everything in `root`. Returns false if it is nested too deeply (`status`). */
function postprocess(c: Context, root: number, o: ParseOptions): boolean {
  const t = c.t;
  // What is in a node comes behind it, and no node is looked at before its parent.
  let next = firstChild(t, root);
  while (next >= 0) {
    const id = next;
    if (!postprocessNode(c, id, o)) return false;
    // What is in a conditional comment has been through this.
    let fc = firstChild(t, id);
    if (kindOf(t, id) === K_IE_CONDITIONAL_COMMENT) fc = -1;
    if (fc >= 0) {
      next = fc;
      continue;
    }
    let at = id;
    next = -1;
    for (;;) {
      const nx = nextOf(t, at);
      if (nx >= 0) {
        next = nx;
        break;
      }
      const p = parentOf(t, at);
      if (p < 0 || p === root) break;
      at = p;
    }
  }
  return true;
}

function postprocessNode(c: Context, id: number, o: ParseOptions): boolean {
  const t = c.t;
  const kind = kindOf(t, id);
  if (kind === K_ELEMENT) {
    postprocessElement(c, id, o);
  } else if (kind === K_COMMENT) {
    const s = nGet(t, id, F_SPAN_S);
    const e = nGet(t, id, F_SPAN_E);
    const vs = s + 4;
    const ve = e - 3;
    if (vs <= ve) setValue(t, id, vs, ve);
    else setValue(t, id, 0, 0);
    return parseIeConditionalComment(c, id, o);
  } else if (kind === K_TEXT) {
    setValue(t, id, nGet(t, id, F_SPAN_S), nGet(t, id, F_SPAN_E));
  } else if (kind === K_ANGULAR_CONTROL_FLOW_BLOCK) {
    // `name.toLowerCase().replaceAll(/\s+/g, " ").trim()`
    const b = t.pool.data;
    const ns = nameStart(t, id);
    const ne = nameEnd(t, id);
    let isNormal = true;
    for (let i = ns; i < ne; i++) {
      const ch = b[i] | 0;
      if (!((ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 95)) {
        isNormal = false;
        break;
      }
    }
    if (!isNormal && !eqLit(b, ns, ne, "else if") && !eqLit(b, ns, ne, "default never")) {
      const lower = new ByteBuf(ne - ns);
      for (let i = ns; i < ne; i++) {
        const ch = b[i] | 0;
        lower.push(ch >= 65 && ch <= 90 ? ch + 32 : ch);
      }
      const at = t.pool.len;
      collapseWhiteSpace(lower.data, 0, lower.len, t.pool);
      setName(t, id, at, t.pool.len);
    }
  }
  return true;
}

/** `restoreName`: sets `rsS`, `rsE` to the name and `rsExplicit`. */
let rsS = 0;
let rsE = 0;
let rsExplicit = false;
function restored(buf: Uint8Array, nsS: number, nsE: number, nspS: number, nspE: number): void {
  const n = nsE - nsS;
  if (n > 0 && nspE - nspS > n && eqPrefix(buf, nspS, nspE, nsS, n) && (buf[nspS + n] | 0) === 58) {
    rsS = nspS + n + 1;
    rsE = nspE;
    rsExplicit = true;
  } else {
    rsS = nspS;
    rsE = nspE;
    rsExplicit = false;
  }
}

function eqPrefix(buf: Uint8Array, s: number, e: number, ps: number, n: number): boolean {
  if (e - s < n) return false;
  for (let i = 0; i < n; i++) {
    if ((buf[s + i] | 0) !== (buf[ps + i] | 0)) return false;
  }
  return true;
}

function hasUpper(buf: Uint8Array, s: number, e: number): boolean {
  for (let i = s; i < e; i++) {
    const b = buf[i] | 0;
    if (b >= 65 && b <= 90) return true;
  }
  return false;
}

/** The lower case copy of `buf[s, e)` appended to the pool; returns where it starts. */
function lowerToPool(t: HTree, s: number, e: number): number {
  const at = t.pool.len;
  const b = t.pool.data;
  const n = e - s;
  // `push` can move the buffer, so read through `t.pool.data` each time.
  for (let i = 0; i < n; i++) {
    const ch = t.pool.data[s + i] | 0;
    t.pool.push(ch >= 65 && ch <= 90 ? ch + 32 : ch);
  }
  void b;
  return at;
}

function postprocessElement(c: Context, id: number, o: ParseOptions): void {
  const t = c.t;
  let buf = t.pool.data;
  // `restoreName`
  const oldS = nameStart(t, id);
  const oldE = nameEnd(t, id);
  restored(buf, nsStart(t, id), nsEnd(t, id), nGet(t, id, F_NSP_S), nGet(t, id, F_NSP_E));
  let nameS = rsS;
  let nameE = rsE;
  setName(t, id, nameS, nameE);
  setFlag(t, id, HAS_EXPLICIT_NAMESPACE, rsExplicit);
  // `addTagDefinition`. Without a namespace, the parser has looked for the same name.
  let definition: number;
  if (nsIsEmpty(t, id) && rangesEqual(buf, oldS, oldE, nameS, nameE)) {
    definition = nGet(t, id, F_DEF);
  } else {
    definition = definitionOf(buf, nameS, nameE, o.isTagNameCaseSensitive);
  }
  const isPlain = nsIsEmpty(t, id) || defHasImplicitNamespace(definition, buf, nsStart(t, id), nsEnd(t, id)) || isUnknownNamespace(t, id);
  nSet(t, id, F_DEF, isPlain ? definition : DEF_DEFAULT);
  // `normalizeName`
  if (o.normalizeTagName && isPlain && hasUpper(buf, nameS, nameE)) {
    const len = nameE - nameS;
    const at = lowerToPool(t, nameS, nameE);
    buf = t.pool.data;
    if (isHtmlTag(buf, at, at + len)) {
      nameS = at;
      nameE = at + len;
    } else {
      t.pool.len = at;
    }
  }
  if (nameS !== nameStart(t, id) || nameE !== nameEnd(t, id)) setName(t, id, nameS, nameE);
  const start = nGet(t, id, F_ATTR_S);
  const end = nGet(t, id, F_ATTR_E);
  for (let a = start; a < end; a++) {
    const ab = a * A_STRIDE;
    buf = t.pool.data;
    // What Prettier takes for `:namespace:name` can be a name that starts with a colon: `::a` is `:a` without a prefix.
    if ((t.a[ab + AF_NS_S] | 0) === (t.a[ab + AF_NS_E] | 0) && (t.a[ab + AF_NAME_E] | 0) > (t.a[ab + AF_NAME_S] | 0) && (buf[t.a[ab + AF_NAME_S] | 0] | 0) === 58) {
      const rs = (t.a[ab + AF_NAME_S] | 0) + 1;
      let re = rs;
      const ne = t.a[ab + AF_NAME_E] | 0;
      while (re < ne && (buf[re] | 0) !== 58) re = re + 1;
      t.a[ab + AF_NS_S] = rs;
      t.a[ab + AF_NS_E] = re;
    }
    restored(buf, t.a[ab + AF_NS_S] | 0, t.a[ab + AF_NS_E] | 0, t.a[ab + AF_NSP_S] | 0, t.a[ab + AF_NSP_E] | 0);
    let anS = rsS;
    let anE = rsE;
    t.a[ab + AF_EXPLICIT_NS] = rsExplicit ? 1 : 0;
    if ((t.a[ab + AF_HAS_VSP] | 0) !== 0) {
      let vs = t.a[ab + AF_VSP_S] | 0;
      let ve = t.a[ab + AF_VSP_E] | 0;
      const q = vs < ve ? buf[vs] | 0 : 0;
      if (q === 34 || q === 39) {
        if (ve - vs === 1) {
          ve = vs;
        } else {
          vs = vs + 1;
          ve = ve - 1;
        }
      }
      t.a[ab + AF_HAS_VAL] = 1;
      t.a[ab + AF_VAL_S] = vs;
      t.a[ab + AF_VAL_E] = ve;
    } else {
      t.a[ab + AF_HAS_VAL] = 0;
    }
    if (o.normalizeAttributeName && (t.a[ab + AF_NS_S] | 0) === (t.a[ab + AF_NS_E] | 0) && hasUpper(buf, anS, anE)) {
      const at = lowerToPool(t, anS, anE);
      buf = t.pool.data;
      const len = anE - anS;
      if (isAttributeOfElement(buf, nameStart(t, id), nameEnd(t, id), buf, at, at + len)) {
        anS = at;
        anE = at + len;
      } else {
        t.pool.len = at;
      }
    }
    t.a[ab + AF_NAME_S] = anS;
    t.a[ab + AF_NAME_E] = anE;
  }
}

function rangesEqual(buf: Uint8Array, as: number, ae: number, bs: number, be: number): boolean {
  if (ae - as !== be - bs) return false;
  for (let i = 0; i < ae - as; i++) {
    if ((buf[as + i] | 0) !== (buf[bs + i] | 0)) return false;
  }
  return true;
}

/** `parseIeConditionalComment`: the comment becomes what it is. */
function parseIeConditionalComment(c: Context, id: number, o: ParseOptions): boolean {
  const t = c.t;
  const buf = t.pool.data;
  const spanS = nGet(t, id, F_SPAN_S);
  const spanE = nGet(t, id, F_SPAN_E);
  const vs = valStart(t, id);
  const ve = valEnd(t, id);
  // `<!\s*\[endif\]$`: what is before it.
  let beforeEnd = -1;
  if (ve - vs >= 7 && eqLit(buf, ve - 7, ve, "[endif]")) {
    const rest = trimJsWhitespaceEnd(buf, vs, ve - 7);
    if (rest - vs >= 2 && (buf[rest - 2] | 0) === 60 && (buf[rest - 1] | 0) === 33) beforeEnd = rest - 2;
  }
  if (beforeEnd === vs) {
    nSet(t, id, F_KIND, K_IE_CONDITIONAL_END_COMMENT);
    return true;
  }
  // `[if`, the condition, `]>`
  if (!(ve - vs >= 3 && eqLit(buf, vs, vs + 3, "[if"))) return true;
  const restS = vs + 3;
  let conditionEnd = -1;
  for (let i = restS; i < ve; i++) {
    if ((buf[i] | 0) === 93) {
      conditionEnd = i;
      break;
    }
  }
  if (conditionEnd < 0) return true;
  const conditionLen = conditionEnd - restS;
  if (!(conditionEnd + 1 < ve && (buf[conditionEnd + 1] | 0) === 62)) return true;
  const afterConditionS = conditionEnd + 2;
  const conditionAt = t.pool.len;
  collapseWhiteSpace(buf, restS, conditionEnd, t.pool);
  const conditionEndPool = t.pool.len;
  const openingLen = 3 + conditionLen + 2;
  const dataLen = beforeEnd >= 0 && beforeEnd - vs >= openingLen ? beforeEnd - vs - openingLen : -1;
  if (dataLen < 0) {
    if (eqLit(buf, afterConditionS, ve, "<!")) {
      nSet(t, id, F_KIND, K_IE_CONDITIONAL_START_COMMENT);
      setValue(t, id, conditionAt, conditionEndPool);
    }
    return true;
  }
  const contentStart = spanS + 4 + openingLen;
  const contentEnd = contentStart + dataLen;
  if (!c.stack.enter()) {
    status = PARSE_NESTED_TOO_DEEPLY;
    return false;
  }
  const parsed = parseRange(c, contentStart, contentEnd, o);
  c.stack.leave();
  let isComplete: boolean;
  if (parsed >= 0) {
    // Prettier parses it with blanks in the place of what is before it, so the first child is a text.
    const f = firstChild(t, parsed);
    const startsWithText = f >= 0 && kindOf(t, f) === K_TEXT && nGet(t, f, F_SPAN_S) === contentStart;
    if (!startsWithText) {
      const empty = addText(t, 0, 0, contentStart, contentStart);
      appendChild(t, id, empty);
    }
    let next = firstChild(t, parsed);
    while (next >= 0) {
      const child = next;
      next = nextOf(t, child);
      appendChild(t, id, child);
    }
    isComplete = true;
  } else {
    if (status === PARSE_NESTED_TOO_DEEPLY) return false;
    const only = addText(t, contentStart, contentEnd, contentStart, contentEnd);
    appendChild(t, id, only);
    isComplete = false;
  }
  nSet(t, id, F_KIND, K_IE_CONDITIONAL_COMMENT);
  setFlag(t, id, IS_COMPLETE, isComplete);
  setValue(t, id, conditionAt, conditionEndPool);
  setStartSpan(t, id, spanS, contentStart);
  setEndSpan(t, id, contentEnd, spanE);
  return true;
}

/**
 * Fills `t` with the syntax of its text (`t.pool` from 0 to `t.textLen`, in which there are blanks in the place of the front matter, which is
 * `frontMatterLen` long, -1: none). Returns `PARSE_OK`, `PARSE_SYNTAX` (`PE`) or `PARSE_NESTED_TOO_DEEPLY`.
 */
export function parseTree(t: HTree, frontMatterLen: number, parser: number): number {
  status = PARSE_OK;
  const o = parseOptions(parser);
  const c = new Context(t, t.textLen, parser === P_VUE, o);
  const root = parseRange(c, 0, t.textLen, o);
  if (root < 0) return status === PARSE_OK ? PARSE_SYNTAX : status;
  if (frontMatterLen >= 0) {
    const fm = addNode(t, K_FRONT_MATTER, 0, frontMatterLen);
    const first = firstChild(t, root);
    if (first >= 0) insertBefore(t, first, fm);
    else appendChild(t, root, fm);
  }
  t.root = root;
  return PARSE_OK;
}

void P_ANGULAR_EXPRESSION;
void EK_TEXT_BEHIND_NUL;
void internLit;
void STRIDE;
void F_START_E;
void F_END_S;
void F_NAME_E;
void F_NAME_S;
void F_NSP_E;
void F_NSP_S;
void K_ANGULAR_CONTROL_FLOW_BLOCK;
