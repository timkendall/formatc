// Port of vendor/bun/src/format/html/ast.rs: the tree. What `angular-html-parser` makes, with what Prettier's `parse/ast.js`,
// `parse/postprocess.js` and `print-preprocess.js` add to it.
//
// All nodes are in one table (struct of arrays in one Int32Array, `STRIDE` fields per node). A node knows its parent, the siblings next
// to it, and its first and last child, so that taking one out and putting one in costs the same wherever it is. Attributes are in a table
// of their own, those of an element next to each other.
//
// Every string (Rust `&[u8]` / `Cow<[u8]>`) is a range `(start, end)` of `t.pool`: the text that is parsed, followed by the strings that
// were made on the way (lower case names, a text that was put together). The spans (`Span`) are ranges of the text.
import { ByteBuf } from "../../base/bytebuf.ts";
import {
  DEF_DEFAULT,
  DISPLAY_INLINE,
  defHasImplicitNamespace,
  defIgnoreFirstLf,
  eqLit,
} from "./data.ts";

export const K_ROOT: number = 0;
export const K_FRONT_MATTER: number = 1;
export const K_ELEMENT: number = 2;
export const K_TEXT: number = 3;
export const K_CDATA: number = 4;
export const K_COMMENT: number = 5;
export const K_DOC_TYPE: number = 6;
export const K_IE_CONDITIONAL_COMMENT: number = 7;
export const K_IE_CONDITIONAL_START_COMMENT: number = 8;
export const K_IE_CONDITIONAL_END_COMMENT: number = 9;
export const K_INTERPOLATION: number = 10;
export const K_ANGULAR_CONTROL_FLOW_BLOCK: number = 11;
export const K_ANGULAR_CONTROL_FLOW_BLOCK_PARAMETERS: number = 12;
export const K_ANGULAR_CONTROL_FLOW_BLOCK_PARAMETER: number = 13;
export const K_ANGULAR_LET_DECLARATION: number = 14;
export const K_ANGULAR_ICU_EXPRESSION: number = 15;
export const K_ANGULAR_ICU_CASE: number = 16;

/** In the place of an id: there is no such node. */
export const NONE: number = -1;

export const HAS_START_SPAN: number = 1;
export const HAS_END_SPAN: number = 1 << 1;
export const HAS_EXPLICIT_NAMESPACE: number = 1 << 2;
/** Of a conditional comment: what is in it could be parsed. */
export const IS_COMPLETE: number = 1 << 3;
export const HAS_LEADING_SPACES: number = 1 << 4;
export const HAS_TRAILING_SPACES: number = 1 << 5;
export const HAS_DANGLING_SPACES: number = 1 << 6;
export const IS_WHITESPACE_SENSITIVE: number = 1 << 7;
export const IS_INDENTATION_SENSITIVE: number = 1 << 8;
export const IS_LEADING_SPACE_SENSITIVE: number = 1 << 9;
export const IS_TRAILING_SPACE_SENSITIVE: number = 1 << 10;
export const IS_DANGLING_SPACE_SENSITIVE: number = 1 << 11;
export const IS_SELF_CLOSING: number = 1 << 12;
export const HAS_HTM_COMPONENT_CLOSING_TAG: number = 1 << 13;
/** Of an element: a conditional comment has been merged into its start tag. */
export const HAS_CONDITION: number = 1 << 14;
/** `shouldPreserveContent` */
export const PRESERVES_CONTENT: number = 1 << 15;

// The fields of a node.
export const STRIDE: number = 32;
export const F_KIND: number = 0;
export const F_DISPLAY: number = 1;
export const F_FLAGS: number = 2;
export const F_PARENT: number = 3;
export const F_PREV: number = 4;
export const F_NEXT: number = 5;
/** `$children`: the `children`, the `cases` of an ICU expression, the `expression` of an ICU case. */
export const F_FIRST: number = 6;
export const F_LAST: number = 7;
/** Of a block: its parameters. */
export const F_PARAMS: number = 8;
/** `sourceSpan` */
export const F_SPAN_S: number = 9;
export const F_SPAN_E: number = 10;
export const F_START_S: number = 11;
export const F_START_E: number = 12;
export const F_END_S: number = 13;
export const F_END_E: number = 14;
/** Of a declaration: of the value. */
export const F_NSP_S: number = 15;
export const F_NSP_E: number = 16;
/** A range of the attributes. */
export const F_ATTR_S: number = 17;
export const F_ATTR_E: number = 18;
/** A range of the comments in the start tag. */
export const F_TC_S: number = 19;
export const F_TC_E: number = 20;
/** Of an element and a block. Of a declaration: the `id`. Of an ICU expression: the `type`. */
export const F_NAME_S: number = 21;
export const F_NAME_E: number = 22;
/** Empty: none. */
export const F_NS_S: number = 23;
export const F_NS_E: number = 24;
/** Of an ICU expression: the `switchValue`. Of a parameter of a block: the `expression`. Of a conditional comment, and of an element that
 * one has been merged into: the `condition`. Of a text: the text. */
export const F_VAL_S: number = 25;
export const F_VAL_E: number = 26;
export const F_DEF: number = 27;

// The fields of an attribute.
export const A_STRIDE: number = 16;
export const AF_SPAN_S: number = 0;
export const AF_SPAN_E: number = 1;
export const AF_NSP_S: number = 2;
export const AF_NSP_E: number = 3;
/** With the quotes. */
export const AF_VSP_S: number = 4;
export const AF_VSP_E: number = 5;
export const AF_HAS_VSP: number = 6;
export const AF_NAME_S: number = 7;
export const AF_NAME_E: number = 8;
export const AF_NS_S: number = 9;
export const AF_NS_E: number = 10;
export const AF_EXPLICIT_NS: number = 11;
export const AF_VAL_S: number = 12;
export const AF_VAL_E: number = 13;
export const AF_HAS_VAL: number = 14;

// The fields of a comment in a start tag.
export const TC_STRIDE: number = 8;
export const TCF_SPAN_S: number = 0;
export const TCF_SPAN_E: number = 1;
export const TCF_VAL_S: number = 2;
export const TCF_VAL_E: number = 3;
/** It ends with the line. */
export const TCF_SINGLE: number = 4;

export class HTree {
  /** The text that is parsed (with blanks in the place of the front matter), then the strings that were made. */
  pool: ByteBuf;
  /** The length of the text at the start of the pool. */
  textLen: number;
  n: Int32Array;
  count: number;
  a: Int32Array;
  attrCount: number;
  c: Int32Array;
  commentCount: number;
  root: number;
  /** Literals that were appended to the pool: where each is. */
  lits: Map<string, number>;

  constructor() {
    this.pool = new ByteBuf(1024);
    this.textLen = 0;
    this.n = new Int32Array(STRIDE * 64);
    this.count = 0;
    this.a = new Int32Array(A_STRIDE * 16);
    this.attrCount = 0;
    this.c = new Int32Array(TC_STRIDE * 4);
    this.commentCount = 0;
    this.root = 0;
    this.lits = new Map<string, number>();
  }

  /** Starts a tree for `text`. */
  reset(text: Uint8Array): void {
    this.pool.reset();
    this.pool.appendAll(text);
    this.textLen = text.length;
    this.count = 0;
    this.attrCount = 0;
    this.commentCount = 0;
    this.root = 0;
    if (this.lits.size > 0) this.lits.clear();
  }
}

/** Where the ASCII literal `s` is in the pool: appended the first time it is asked for. */
export function internLit(t: HTree, s: string): number {
  const known = t.lits.get(s);
  if (known !== undefined) return known;
  const at = t.pool.len;
  t.pool.appendAscii(s);
  t.lits.set(s, at);
  return at;
}

/** The string `buf[s, e)` appended to the pool; returns where it starts. */
export function poolAppend(t: HTree, src: Uint8Array, s: number, e: number): number {
  const at = t.pool.len;
  t.pool.append(src, s, e);
  return at;
}

/** Adds a node of `kind` with the span `(s, e)`. Returns its id. */
export function addNode(t: HTree, kind: number, s: number, e: number): number {
  const id = t.count;
  const base = id * STRIDE;
  if (base + STRIDE > t.n.length) {
    const nn = new Int32Array(t.n.length * 2);
    nn.set(t.n);
    t.n = nn;
  }
  const n = t.n;
  n.fill(0, base, base + STRIDE);
  n[base + F_KIND] = kind | 0;
  n[base + F_DISPLAY] = DISPLAY_INLINE;
  n[base + F_PARENT] = -1;
  n[base + F_PREV] = -1;
  n[base + F_NEXT] = -1;
  n[base + F_FIRST] = -1;
  n[base + F_LAST] = -1;
  n[base + F_PARAMS] = -1;
  n[base + F_SPAN_S] = s | 0;
  n[base + F_SPAN_E] = e | 0;
  n[base + F_DEF] = DEF_DEFAULT;
  t.count = id + 1;
  return id;
}

/** A text node with the value `buf[vs, ve)` of the pool. */
export function addText(t: HTree, vs: number, ve: number, s: number, e: number): number {
  const id = addNode(t, K_TEXT, s, e);
  t.n[id * STRIDE + F_VAL_S] = vs | 0;
  t.n[id * STRIDE + F_VAL_E] = ve | 0;
  return id;
}

/** Adds an attribute (all fields 0); returns its index. */
export function addAttr(t: HTree): number {
  const id = t.attrCount;
  const base = id * A_STRIDE;
  if (base + A_STRIDE > t.a.length) {
    const na = new Int32Array(t.a.length * 2);
    na.set(t.a);
    t.a = na;
  }
  t.a.fill(0, base, base + A_STRIDE);
  t.attrCount = id + 1;
  return id;
}

/** Adds a comment in a start tag; returns its index. */
export function addStartTagComment(t: HTree): number {
  const id = t.commentCount;
  const base = id * TC_STRIDE;
  if (base + TC_STRIDE > t.c.length) {
    const nc = new Int32Array(t.c.length * 2);
    nc.set(t.c);
    t.c = nc;
  }
  t.c.fill(0, base, base + TC_STRIDE);
  t.commentCount = id + 1;
  return id;
}

// ───────────────────────────── reading ─────────────────────────────

export function nGet(t: HTree, id: number, field: number): number {
  return t.n[id * STRIDE + field] | 0;
}
export function nSet(t: HTree, id: number, field: number, v: number): void {
  t.n[id * STRIDE + field] = v | 0;
}
export function kindOf(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_KIND] | 0;
}
export function flagsOf(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_FLAGS] | 0;
}
/** `node.has(flags)`: all of them. */
export function has(t: HTree, id: number, flags: number): boolean {
  return ((t.n[id * STRIDE + F_FLAGS] | 0) & flags) === flags;
}
/** `node.flags.intersects(flags)` */
export function hasAny(t: HTree, id: number, flags: number): boolean {
  return ((t.n[id * STRIDE + F_FLAGS] | 0) & flags) !== 0;
}
export function setFlag(t: HTree, id: number, flag: number, on: boolean): void {
  const i = id * STRIDE + F_FLAGS;
  t.n[i] = on ? (t.n[i] | 0) | flag : (t.n[i] | 0) & ~flag;
}
export function insertFlags(t: HTree, id: number, flags: number): void {
  const i = id * STRIDE + F_FLAGS;
  t.n[i] = (t.n[i] | 0) | flags;
}
export function removeFlags(t: HTree, id: number, flags: number): void {
  const i = id * STRIDE + F_FLAGS;
  t.n[i] = (t.n[i] | 0) & ~flags;
}
export function displayOf(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_DISPLAY] | 0;
}
export function parentOf(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_PARENT] | 0;
}
export function prevOf(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_PREV] | 0;
}
export function nextOf(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_NEXT] | 0;
}
export function firstChild(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_FIRST] | 0;
}
export function lastChild(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_LAST] | 0;
}
export function parametersOf(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_PARAMS] | 0;
}
export function hasChildren(t: HTree, id: number): boolean {
  return (t.n[id * STRIDE + F_FIRST] | 0) >= 0;
}
/** The child of `id`, if there is exactly one (-1: not). */
export function onlyChild(t: HTree, id: number): number {
  const first = t.n[id * STRIDE + F_FIRST] | 0;
  return first >= 0 && first === (t.n[id * STRIDE + F_LAST] | 0) ? first : -1;
}
export function spanStart(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_SPAN_S] | 0;
}
export function spanEnd(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_SPAN_E] | 0;
}
export function nameStart(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_NAME_S] | 0;
}
export function nameEnd(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_NAME_E] | 0;
}
export function nsStart(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_NS_S] | 0;
}
export function nsEnd(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_NS_E] | 0;
}
export function valStart(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_VAL_S] | 0;
}
export function valEnd(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_VAL_E] | 0;
}
export function defOf(t: HTree, id: number): number {
  return t.n[id * STRIDE + F_DEF] | 0;
}
/** The namespace is empty. */
export function nsIsEmpty(t: HTree, id: number): boolean {
  return (t.n[id * STRIDE + F_NS_S] | 0) === (t.n[id * STRIDE + F_NS_E] | 0);
}
export function hasStartSpan(t: HTree, id: number): boolean {
  return ((t.n[id * STRIDE + F_FLAGS] | 0) & HAS_START_SPAN) !== 0;
}
export function hasEndSpan(t: HTree, id: number): boolean {
  return ((t.n[id * STRIDE + F_FLAGS] | 0) & HAS_END_SPAN) !== 0;
}
export function setStartSpan(t: HTree, id: number, s: number, e: number): void {
  const b = id * STRIDE;
  t.n[b + F_START_S] = s | 0;
  t.n[b + F_START_E] = e | 0;
  t.n[b + F_FLAGS] = (t.n[b + F_FLAGS] | 0) | HAS_START_SPAN;
}
/** `set_end_span(Some(span))` */
export function setEndSpan(t: HTree, id: number, s: number, e: number): void {
  const b = id * STRIDE;
  t.n[b + F_END_S] = s | 0;
  t.n[b + F_END_E] = e | 0;
  t.n[b + F_FLAGS] = (t.n[b + F_FLAGS] | 0) | HAS_END_SPAN;
}
/** `set_end_span(None)` */
export function clearEndSpan(t: HTree, id: number): void {
  const b = id * STRIDE;
  t.n[b + F_END_S] = 0;
  t.n[b + F_END_E] = 0;
  t.n[b + F_FLAGS] = (t.n[b + F_FLAGS] | 0) & ~HAS_END_SPAN;
}
export function setName(t: HTree, id: number, s: number, e: number): void {
  const b = id * STRIDE;
  t.n[b + F_NAME_S] = s | 0;
  t.n[b + F_NAME_E] = e | 0;
}
export function setValue(t: HTree, id: number, s: number, e: number): void {
  const b = id * STRIDE;
  t.n[b + F_VAL_S] = s | 0;
  t.n[b + F_VAL_E] = e | 0;
}
export function setNamespace(t: HTree, id: number, s: number, e: number): void {
  const b = id * STRIDE;
  t.n[b + F_NS_S] = s | 0;
  t.n[b + F_NS_E] = e | 0;
}

/** Whether there is a `children` property. */
export function hasChildrenProperty(t: HTree, id: number): boolean {
  switch (t.n[id * STRIDE + F_KIND] | 0) {
    case K_ROOT:
    case K_ELEMENT:
    case K_IE_CONDITIONAL_COMMENT:
    case K_INTERPOLATION:
    case K_ANGULAR_CONTROL_FLOW_BLOCK:
    case K_ANGULAR_CONTROL_FLOW_BLOCK_PARAMETERS:
      return true;
    default:
      return false;
  }
}

/** `fullName === name`: `ns` is `(nsS, nsE)`, the own name `(ownS, ownE)`, `name` a literal. */
export function isFullNameLit(buf: Uint8Array, nsS: number, nsE: number, ownS: number, ownE: number, name: string): boolean {
  if (nsS === nsE) return eqLit(buf, ownS, ownE, name);
  const nl = nsE - nsS;
  if (name.length !== nl + 1 + (ownE - ownS)) return false;
  for (let i = 0; i < nl; i++) {
    if ((buf[nsS + i] | 0) !== name.charCodeAt(i)) return false;
  }
  if (name.charCodeAt(nl) !== 58) return false;
  for (let i = ownS; i < ownE; i++) {
    if ((buf[i] | 0) !== name.charCodeAt(nl + 1 + i - ownS)) return false;
  }
  return true;
}

/** `node.is_full_name(name)` */
export function nodeIsFullName(t: HTree, id: number, name: string): boolean {
  const b = id * STRIDE;
  return isFullNameLit(
    t.pool.data,
    t.n[b + F_NS_S] | 0,
    t.n[b + F_NS_E] | 0,
    t.n[b + F_NAME_S] | 0,
    t.n[b + F_NAME_E] | 0,
    name,
  );
}

/** The name of the node (no namespace) is `name`. */
export function nameIs(t: HTree, id: number, name: string): boolean {
  const b = id * STRIDE;
  return eqLit(t.pool.data, t.n[b + F_NAME_S] | 0, t.n[b + F_NAME_E] | 0, name);
}

/** The name of the node is `name`, ASCII letters of the name in the text are lower case. */
export function nodeRawNameStart(t: HTree, id: number): number {
  // `rawName`: the namespace, if it is written, and the name. The namespace part: see `rawNamespaceEnd`.
  return (t.n[id * STRIDE + F_FLAGS] | 0) & HAS_EXPLICIT_NAMESPACE ? t.n[id * STRIDE + F_NS_S] | 0 : t.n[id * STRIDE + F_NAME_S] | 0;
}

export function nodeHasAttrs(t: HTree, id: number): boolean {
  return (t.n[id * STRIDE + F_ATTR_S] | 0) < (t.n[id * STRIDE + F_ATTR_E] | 0);
}
export function nodeHasStartTagComments(t: HTree, id: number): boolean {
  return (t.n[id * STRIDE + F_TC_S] | 0) < (t.n[id * STRIDE + F_TC_E] | 0);
}

// ───────────────────────────── attributes ─────────────────────────────

export function aGet(t: HTree, a: number, field: number): number {
  return t.a[a * A_STRIDE + field] | 0;
}
export function aSet(t: HTree, a: number, field: number, v: number): void {
  t.a[a * A_STRIDE + field] = v | 0;
}

/** `attr.is_full_name(name)` */
export function attrIsFullName(t: HTree, a: number, name: string): boolean {
  const b = a * A_STRIDE;
  return isFullNameLit(
    t.pool.data,
    t.a[b + AF_NS_S] | 0,
    t.a[b + AF_NS_E] | 0,
    t.a[b + AF_NAME_S] | 0,
    t.a[b + AF_NAME_E] | 0,
    name,
  );
}

/** `attrMap[name]`: the index of the last attribute of the element with that name, -1 if there is none. */
export function attribute(t: HTree, id: number, name: string): number {
  const start = t.n[id * STRIDE + F_ATTR_S] | 0;
  for (let a = (t.n[id * STRIDE + F_ATTR_E] | 0) - 1; a >= start; a--) {
    if (attrIsFullName(t, a, name)) return a;
  }
  return -1;
}

/** `attrMap[name]`, if it is a string that is not empty: the index of the attribute, else -1. */
export function attributeWithValue(t: HTree, id: number, name: string): number {
  const a = attribute(t, id, name);
  if (a < 0) return -1;
  const b = a * A_STRIDE;
  if ((t.a[b + AF_HAS_VAL] | 0) === 0 || (t.a[b + AF_VAL_S] | 0) === (t.a[b + AF_VAL_E] | 0)) return -1;
  return a;
}

/** The value of the attribute `a` is the literal `lit` (an attribute without a value is none). */
export function attrValueIs(t: HTree, a: number, lit: string): boolean {
  const b = a * A_STRIDE;
  return (t.a[b + AF_HAS_VAL] | 0) !== 0 && eqLit(t.pool.data, t.a[b + AF_VAL_S] | 0, t.a[b + AF_VAL_E] | 0, lit);
}

// ───────────────────────────── the tree ─────────────────────────────

/** Makes `child`, which is nowhere, the last child of `parent`. */
export function appendChild(t: HTree, parent: number, child: number): void {
  const n = t.n;
  const last = n[parent * STRIDE + F_LAST] | 0;
  const cb = child * STRIDE;
  n[cb + F_PARENT] = parent | 0;
  n[cb + F_PREV] = last | 0;
  n[cb + F_NEXT] = -1;
  n[parent * STRIDE + F_LAST] = child | 0;
  if (last >= 0) n[last * STRIDE + F_NEXT] = child | 0;
  else n[parent * STRIDE + F_FIRST] = child | 0;
}

/** Puts `added`, which is nowhere, before `target`. */
export function insertBefore(t: HTree, target: number, added: number): void {
  const n = t.n;
  const parent = n[target * STRIDE + F_PARENT] | 0;
  const prev = n[target * STRIDE + F_PREV] | 0;
  const ab = added * STRIDE;
  n[ab + F_PARENT] = parent | 0;
  n[ab + F_PREV] = prev | 0;
  n[ab + F_NEXT] = target | 0;
  n[target * STRIDE + F_PREV] = added | 0;
  if (prev >= 0) n[prev * STRIDE + F_NEXT] = added | 0;
  else if (parent >= 0) n[parent * STRIDE + F_FIRST] = added | 0;
}

/** Takes `child` out of its parent. */
export function removeNode(t: HTree, child: number): void {
  const n = t.n;
  const cb = child * STRIDE;
  const parent = n[cb + F_PARENT] | 0;
  const prev = n[cb + F_PREV] | 0;
  const next = n[cb + F_NEXT] | 0;
  n[cb + F_PARENT] = -1;
  n[cb + F_PREV] = -1;
  n[cb + F_NEXT] = -1;
  if (prev >= 0) n[prev * STRIDE + F_NEXT] = next | 0;
  else if (parent >= 0) n[parent * STRIDE + F_FIRST] = next | 0;
  if (next >= 0) n[next * STRIDE + F_PREV] = prev | 0;
  else if (parent >= 0) n[parent * STRIDE + F_LAST] = prev | 0;
}

/** Puts `replacement`, which is nowhere, in the place of `target`. */
export function replaceNode(t: HTree, target: number, replacement: number): void {
  insertBefore(t, target, replacement);
  removeNode(t, target);
}

/** Takes all children out of `id`. They keep each other as siblings. */
export function clearChildren(t: HTree, id: number): void {
  t.n[id * STRIDE + F_FIRST] = -1;
  t.n[id * STRIDE + F_LAST] = -1;
}

export function setParameters(t: HTree, id: number, parameters: number): void {
  t.n[id * STRIDE + F_PARAMS] = parameters | 0;
  t.n[parameters * STRIDE + F_PARENT] = id | 0;
}

/** `tree.add(node)` followed by `append_child(container, id)`. */
export function lastDescendant(t: HTree, id: number): number {
  let at = id;
  for (;;) {
    const last = t.n[at * STRIDE + F_LAST] | 0;
    if (last < 0) return at;
    at = last;
  }
}

export function tagDefinitionIgnoresFirstLf(t: HTree, id: number): boolean {
  return defIgnoreFirstLf(t.n[id * STRIDE + F_DEF] | 0);
}

/** The definition of the element has `buf[s, e)` as its implicit namespace prefix. */
export function definitionHasNamespace(t: HTree, id: number, s: number, e: number): boolean {
  return defHasImplicitNamespace(t.n[id * STRIDE + F_DEF] | 0, t.pool.data, s, e);
}

// Prettier's `parser` option (Rust `html::Parser`).
export const P_HTML: number = 0;
export const P_ANGULAR: number = 1;
export const P_VUE: number = 2;
export const P_LWC: number = 3;
export const P_MJML: number = 4;
/** `__ng_action`, `__ng_binding`, `__ng_directive`, `__ng_interpolation`: the text is an expression of Angular, with no HTML around it. */
export const P_ANGULAR_EXPRESSION: number = 5;
