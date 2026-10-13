// Port of vendor/bun/src/format/yaml/ast.rs. `yaml-unist-parser` 3.2: the tree that Prettier prints, from what Bun's
// parser reads: the documents say what is in what, the tokens where it is written.
//
// The tree is a struct of arrays (`T`), indexed by node id (Int32, -1 is none); per thread, grow-only, reset by `build`.
// A list (children, leading comments, ...) is a (first, last, len) triple of columns and each node is in one list at
// most, so `next` is one column. A text is a range (`vStart`, `vEnd`) of the text that was parsed. Positions are three
// columns for each end: byte offset, line (from 1), column (from 1, UTF-16 code units).
//
// The properties of a node (the comments, tags and anchors in front of it) are token indices on a stack (`propTok`):
// a `Props` of Rust is (base, count) and lives on the stack at `base..base+count`; a function that makes a node of
// them hands the same (base, count) down and the caller gives the stack back (`propTop = mark`).
import { I32Vec } from "../../base/i32vec.ts";
import { Stack } from "../../base/stack.ts";
import {
  NK_ALIAS,
  NK_ARRAY,
  NK_NULL,
  NK_OBJECT,
  NK_SCALAR,
  TK_ALIAS,
  TK_ANCHOR,
  TK_COLLECT_ENTRY,
  TK_COMMENT,
  TK_DIRECTIVE,
  TK_DOCUMENT_END,
  TK_DOCUMENT_START,
  TK_MAPPING_END,
  TK_MAPPING_KEY,
  TK_MAPPING_START,
  TK_MAPPING_VALUE,
  TK_SCALAR,
  TK_SEQUENCE_END,
  TK_SEQUENCE_ENTRY,
  TK_SEQUENCE_START,
  TK_TAG,
  yamlDocCount,
  yamlDocRoot,
  yamlItem,
  yamlNodeCount,
  yamlNodeKind,
  yamlNodeLoc,
  yamlPropKey,
  yamlPropValue,
  yamlTokenCount,
  yamlTokenEnds,
  yamlTokenKinds,
  yamlTokenStarts,
} from "../../parsers/yaml.ts";
import { sortInt32ByKey } from "../sort.ts";
import {
  MSG_CANNOT_BE_FORMATTED,
  MSG_MISPLACED_COMMENT,
  noteRefusal,
} from "../syntax_error.ts";
import { trimJsWhitespaceEnd } from "../text.ts";

// `Kind`
export const K_ROOT = 0;
export const K_DOCUMENT = 1;
export const K_DOCUMENT_HEAD = 2;
export const K_DOCUMENT_BODY = 3;
export const K_DIRECTIVE = 4;
export const K_COMMENT = 5;
export const K_ALIAS = 6;
export const K_TAG = 7;
export const K_ANCHOR = 8;
export const K_BLOCK_FOLDED = 9;
export const K_BLOCK_LITERAL = 10;
export const K_PLAIN = 11;
export const K_QUOTE_DOUBLE = 12;
export const K_QUOTE_SINGLE = 13;
export const K_FLOW_MAPPING = 14;
export const K_FLOW_SEQUENCE = 15;
export const K_FLOW_MAPPING_ITEM = 16;
export const K_FLOW_SEQUENCE_ITEM = 17;
export const K_MAPPING = 18;
export const K_MAPPING_ITEM = 19;
export const K_MAPPING_KEY = 20;
export const K_MAPPING_VALUE = 21;
export const K_SEQUENCE = 22;
export const K_SEQUENCE_ITEM = 23;

// `Chomping`
export const CH_CLIP = 0;
export const CH_KEEP = 1;
export const CH_STRIP = 2;

// `flags`
export const F_SET_TAG = 1;
export const F_DIRECTIVES_END_MARKER = 8;
export const F_DOCUMENT_END_MARKER = 16;
// There is a leading, middle, end, trailing or indicator comment
export const F_HAS_COMMENTS = 32;
// There is a tag or an anchor
export const F_HAS_PROPS = 64;
// bits 1..2: chomping

const NONE = -1;
const MAX = 0x7fffffff;

// `"leadingComments" in node` and `"trailingComment" in node`, by kind
const HAS_LEADING = new Uint8Array(24);
const HAS_TRAILING = new Uint8Array(24);
// Kinds without a `children` field in `yaml-unist-parser`
const NO_CHILDREN_FIELD = new Uint8Array(24);
{
  const leading = [
    K_ALIAS, K_BLOCK_FOLDED, K_BLOCK_LITERAL, K_DIRECTIVE, K_FLOW_MAPPING, K_FLOW_SEQUENCE, K_FLOW_MAPPING_ITEM,
    K_MAPPING_ITEM, K_MAPPING_VALUE, K_MAPPING, K_PLAIN, K_QUOTE_DOUBLE, K_QUOTE_SINGLE, K_SEQUENCE_ITEM, K_SEQUENCE,
  ];
  for (let i = 0; i < leading.length; i++) HAS_LEADING[leading[i] | 0] = 1;
  const trailing = [
    K_ALIAS, K_DIRECTIVE, K_DOCUMENT_HEAD, K_DOCUMENT, K_FLOW_MAPPING, K_FLOW_SEQUENCE, K_MAPPING_KEY,
    K_MAPPING_VALUE, K_PLAIN, K_QUOTE_DOUBLE, K_QUOTE_SINGLE, K_SEQUENCE_ITEM,
  ];
  for (let i = 0; i < trailing.length; i++) HAS_TRAILING[trailing[i] | 0] = 1;
  const none = [
    K_DIRECTIVE, K_COMMENT, K_ALIAS, K_TAG, K_ANCHOR, K_BLOCK_FOLDED, K_BLOCK_LITERAL, K_PLAIN, K_QUOTE_DOUBLE,
    K_QUOTE_SINGLE,
  ];
  for (let i = 0; i < none.length; i++) NO_CHILDREN_FIELD[none[i] | 0] = 1;
}

// A node is a record of `STRIDE` ints in `T.d`, at `id << 5`: the field `F_*` is at `(id << 5) + F_*`.
export const F_KIND = 0;
export const F_PARENT = 1;
export const F_NEXT = 2;
export const F_CH_FIRST = 3;
export const F_CH_LAST = 4;
export const F_CH_LEN = 5;
export const F_LD_FIRST = 6;
export const F_LD_LAST = 7;
export const F_LD_LEN = 8;
export const F_MD_FIRST = 9;
export const F_MD_LAST = 10;
export const F_MD_LEN = 11;
export const F_EN_FIRST = 12;
export const F_EN_LAST = 13;
export const F_EN_LEN = 14;
export const F_TRAILING = 15;
export const F_INDICATOR = 16;
export const F_TAG = 17;
export const F_ANCHOR = 18;
export const F_S_OFF = 19;
export const F_S_LINE = 20;
export const F_E_OFF = 21;
export const F_E_LINE = 22;
export const F_V_START = 23;
export const F_V_END = 24;
export const F_INDENT = 25;
export const F_FLAGS = 26;

/** The nodes of a tree. */
export class Tree {
  cap: number;
  n: number;
  root: number;
  d: Int32Array;

  constructor() {
    this.cap = 64;
    this.n = 0;
    this.root = NONE;
    this.d = new Int32Array(64 << 5);
  }

  /** Makes room for at least `need` nodes in total. */
  ensure(need: number): void {
    if (need <= this.cap) return;
    let cap = this.cap;
    while (cap < need) cap = cap * 2;
    this.cap = cap;
    const nd = new Int32Array(cap << 5);
    nd.set(this.d.subarray(0, this.n << 5));
    this.d = nd;
  }
}

/** The tree of the file that is being formatted (valid until the next `build`). */
export const T: Tree = new Tree();

// ---------------------------------------------------------------------------------------------- state of the builder

let text: Uint8Array = new Uint8Array(0);
let textLen = 0;
let tkKind: Uint8Array = new Uint8Array(0);
let tkStart: Int32Array = new Int32Array(0);
let tkEnd: Int32Array = new Int32Array(0);
let tkCount = 0;
// How many tokens have been looked at.
let at = 0;
// The `%TAG` directives of the document: handles and prefixes (4 ints each). The last with a handle counts.
let tags: Int32Array = new Int32Array(16);
let tagsLen = 0;
let isAscii = true;
// Where the lines start.
let lineStarts: Int32Array = new Int32Array(64);
// Whether a line has a byte that is not ASCII
let lineNonAscii: Uint8Array = new Uint8Array(64);
let nLineStarts = 0;
// The line that has been asked for last: its number, where it starts, and where the next one does.
let lastLine = 0;
let lastLineStart = 0;
let lastLineNext = 0;
// A place in that line, and how many UTF-16 code units are before it in the line.
let lastPlace = 0;
let lastPlaceCol = 0;
const comments = new I32Vec(64);
// The nodes whose parents are not made yet.
const pending = new I32Vec(64);
let hasProperties = false;
const stack = new Stack(4000);
// The line that `columnOf` has been asked about last
let colLine = 0;

// The properties: token indices
let propTok: Int32Array = new Int32Array(64);
let propTop = 0;

/** The stack of the builder and of the printer (one budget for both, as in Rust). */
export const treeStack: Stack = stack;

function pushProp(tok: number): void {
  if (propTop === propTok.length) {
    const n = new Int32Array(propTok.length * 2);
    n.set(propTok);
    propTok = n;
  }
  propTok[propTop] = tok | 0;
  propTop = ((propTop | 0) + 1) | 0;
}

// ---------------------------------------------------------------------------------------------- nodes

function newNode(kind: number): number {
  const id = T.n;
  if (id === T.cap) T.ensure(id + 1);
  T.n = id + 1;
  const b = id << 5;
  // The first and the last of a list, the range of a text and the indentation are only read where they are written.
  // (No local for `T.d`: in a small function a local costs a retain and a release.)
  T.d[b + F_KIND] = kind | 0;
  T.d[b + F_PARENT] = -1;
  T.d[b + F_NEXT] = -1;
  T.d[b + F_CH_LEN] = 0;
  T.d[b + F_LD_LEN] = 0;
  T.d[b + F_MD_LEN] = 0;
  T.d[b + F_EN_LEN] = 0;
  T.d[b + F_TRAILING] = -1;
  T.d[b + F_INDICATOR] = -1;
  T.d[b + F_TAG] = -1;
  T.d[b + F_ANCHOR] = -1;
  T.d[b + F_FLAGS] = 0;
  return id;
}

function setStart(id: number, offset: number): void {
  const b = id << 5;
  T.d[b + F_S_OFF] = offset | 0;
  T.d[b + F_S_LINE] = lineOf(offset) | 0;
}

function setEnd(id: number, offset: number): void {
  const b = id << 5;
  T.d[b + F_E_OFF] = offset | 0;
  T.d[b + F_E_LINE] = lineOf(offset) | 0;
}

function copyStart(id: number, from: number): void {
  const b = id << 5;
  const f = from << 5;
  T.d[b + F_S_OFF] = T.d[f + F_S_OFF] | 0;
  T.d[b + F_S_LINE] = T.d[f + F_S_LINE] | 0;
}

function copyEnd(id: number, from: number): void {
  const b = id << 5;
  const f = from << 5;
  T.d[b + F_E_OFF] = T.d[f + F_E_OFF] | 0;
  T.d[b + F_E_LINE] = T.d[f + F_E_LINE] | 0;
}

function newNodeAt(kind: number, start: number, end: number): number {
  const id = newNode(kind);
  setStart(id, start);
  setEnd(id, end);
  return id;
}

/** `transformOffset`: the line (from 1) of `offset`. */
function lineOf(offset: number): number {
  // Most of the time it is the same line as the last time.
  if (offset >= lastLineStart && offset < lastLineNext) return lastLine;
  return lineOfOtherLine(offset);
}

function lineOfOtherLine(offset: number): number {
  // The line is near the one asked for last: a search that starts there and doubles its steps.
  const n = nLineStarts;
  const idx = lastLine - 1 < 0 ? 0 : lastLine - 1;
  let lo = 0;
  let hi = n;
  if (idx < n && offset >= (lineStarts[idx] | 0)) {
    // forward: the answer is in [lo, hi)
    lo = idx;
    let step = 1;
    hi = idx + 1;
    while (hi < n && (lineStarts[hi] | 0) <= offset) {
      lo = hi;
      step = step * 2;
      hi = lo + step;
    }
    if (hi > n) hi = n;
  } else if (idx < n) {
    // backward
    hi = idx;
    let step = 1;
    lo = idx - 1;
    while (lo > 0 && (lineStarts[lo] | 0) > offset) {
      hi = lo;
      step = step * 2;
      lo = hi - step;
    }
    if (lo < 0) lo = 0;
  }
  // The last start that is <= offset in [lo, hi)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((lineStarts[mid] | 0) <= offset) lo = mid;
    else hi = mid;
  }
  const line = lo + 1;
  lastLine = line;
  lastLineStart = startOfLine(line);
  lastLineNext = startOfLine(line + 1);
  return line;
}

/** The column (from 1, UTF-16 code units) of `offset`, which is in line `line`. */
function columnOf(offset: number, line: number): number {
  const start = startOfLine(line);
  if (isAscii || (lineNonAscii[line - 1] | 0) === 0) return (offset > start ? offset - start : 0) + 1;
  if (colLine !== line) {
    colLine = line;
    lastPlace = start;
    lastPlaceCol = 0;
  }
  // Columns count UTF-16 code units.
  let column = 0;
  if (offset - start <= 64) {
    column = unitsBetween(start, offset);
  } else {
    if (offset >= lastPlace) column = lastPlaceCol + unitsBetween(lastPlace, offset);
    else {
      const back = unitsBetween(offset, lastPlace);
      column = lastPlaceCol > back ? lastPlaceCol - back : 0;
    }
    lastPlace = offset;
    lastPlaceCol = column;
  }
  return column + 1;
}

function startOfLine(line: number): number {
  return line - 1 < nLineStarts ? lineStarts[line - 1] | 0 : MAX;
}

function unitsBetween(from: number, to: number): number {
  if (from < 0 || to > textLen || from > to) return 0;
  let count = 0;
  const t = text;
  for (let i = from; i < to; i++) {
    const b = t[i] | 0;
    if ((b & 0xc0) !== 0x80) count = count + 1;
    if (b >= 0xf0) count = count + 1;
  }
  return count;
}

/** `item` is the only child of `owner`, which has none yet. */
function setOnlyChild(owner: number, item: number): void {
  const ob = owner << 5;
  T.d[ob + F_CH_FIRST] = item | 0;
  T.d[ob + F_CH_LAST] = item | 0;
  T.d[ob + F_CH_LEN] = 1;
  T.d[(item << 5) + F_PARENT] = owner | 0;
}

/** `first` and `second` are the children of `owner`, which has none yet. */
function setTwoChildren(owner: number, first: number, second: number): void {
  const ob = owner << 5;
  T.d[ob + F_CH_FIRST] = first | 0;
  T.d[ob + F_CH_LAST] = second | 0;
  T.d[ob + F_CH_LEN] = 2;
  T.d[(first << 5) + F_PARENT] = owner | 0;
  T.d[(second << 5) + F_PARENT] = owner | 0;
  T.d[(first << 5) + F_NEXT] = second | 0;
}

function appendChild(owner: number, item: number): void {
  const len = T.d[(owner << 5) + F_CH_LEN] | 0;
  if (len === 0) T.d[(owner << 5) + F_CH_FIRST] = item;
  else T.d[((T.d[(owner << 5) + F_CH_LAST] | 0) << 5) + F_NEXT] = item;
  T.d[(owner << 5) + F_CH_LAST] = item;
  T.d[(owner << 5) + F_CH_LEN] = len + 1;
  T.d[(item << 5) + F_PARENT] = owner;
}

function appendLeading(owner: number, item: number): void {
  const len = T.d[(owner << 5) + F_LD_LEN] | 0;
  if (len === 0) T.d[(owner << 5) + F_LD_FIRST] = item;
  else T.d[((T.d[(owner << 5) + F_LD_LAST] | 0) << 5) + F_NEXT] = item;
  T.d[(owner << 5) + F_LD_LAST] = item;
  T.d[(owner << 5) + F_LD_LEN] = len + 1;
  T.d[(owner << 5) + F_FLAGS] = (T.d[(owner << 5) + F_FLAGS] | 0) | F_HAS_COMMENTS;
  T.d[(item << 5) + F_PARENT] = owner;
}

function appendMiddle(owner: number, item: number): void {
  const len = T.d[(owner << 5) + F_MD_LEN] | 0;
  if (len === 0) T.d[(owner << 5) + F_MD_FIRST] = item;
  else T.d[((T.d[(owner << 5) + F_MD_LAST] | 0) << 5) + F_NEXT] = item;
  T.d[(owner << 5) + F_MD_LAST] = item;
  T.d[(owner << 5) + F_MD_LEN] = len + 1;
  T.d[(owner << 5) + F_FLAGS] = (T.d[(owner << 5) + F_FLAGS] | 0) | F_HAS_COMMENTS;
  T.d[(item << 5) + F_PARENT] = owner;
}

function appendEnd(owner: number, item: number): void {
  const len = T.d[(owner << 5) + F_EN_LEN] | 0;
  if (len === 0) T.d[(owner << 5) + F_EN_FIRST] = item;
  else T.d[((T.d[(owner << 5) + F_EN_LAST] | 0) << 5) + F_NEXT] = item;
  T.d[(owner << 5) + F_EN_LAST] = item;
  T.d[(owner << 5) + F_EN_LEN] = len + 1;
  T.d[(owner << 5) + F_FLAGS] = (T.d[(owner << 5) + F_FLAGS] | 0) | F_HAS_COMMENTS;
  T.d[(item << 5) + F_PARENT] = owner;
}

/** Makes `pending[from..]` the children of `parent`. */
function addPendingChildren(parent: number, from: number): void {
  const n = pending.len;
  for (let i = from; i < n; i++) appendChild(parent, pending.data[i] | 0);
  pending.truncate(from);
}

/** `related` belongs to `owner`. */
function own(owner: number, related: number): number {
  T.d[(related << 5) + F_PARENT] = owner;
  return related;
}

function transformComment(start: number, end: number): number {
  const id = newNodeAt(K_COMMENT, start, end);
  T.d[(id << 5) + F_V_START] = start + 1;
  T.d[(id << 5) + F_V_END] = end > start + 1 ? end : start + 1;
  comments.push(id);
  return id;
}

// ---------------------------------------------------------------------------------------------- tokens

function peekKind(): number {
  return at < tkCount ? tkKind[at] | 0 : -1;
}

/** The next token, if it is of `kind`: its index, else -1. */
function take(kind: number): number {
  if (at < tkCount && (tkKind[at] | 0) === kind) {
    const i = at;
    at = at + 1;
    return i;
  }
  return -1;
}

/** `maybeContentPropertyToken` */
function isContentPropertyKind(kind: number): boolean {
  return kind === TK_COMMENT || kind === TK_TAG || kind === TK_ANCHOR;
}

/** `isEmptyNode`: `node` is null and the properties are all comments. */
function isEmptyNode(node: number, pb: number, pn: number): boolean {
  if ((yamlNodeKind(node) | 0) !== NK_NULL) return false;
  for (let i = pb; i < pb + pn; i++) {
    if ((tkKind[propTok[i] | 0] | 0) !== TK_COMMENT) return false;
  }
  return true;
}

/** Adds the comments, tags and anchors that follow to the properties on top of the stack. */
function takeProps(): void {
  while (at < tkCount && isContentPropertyKind(tkKind[at] | 0)) {
    pushProp(at);
    at = at + 1;
  }
}

/** Adds the properties of `node` to the stack, which is written behind the indicator that starts at `indicatorStart`, in a
 * block collection. Of a node that is not written otherwise, they are on the line of the indicator, or further to the right
 * than `entry`, where what the indicator belongs to starts: anything else belongs to what follows. */
function takePropsBehind(indicatorStart: number, entry: number, node: number): void {
  if ((yamlNodeKind(node) | 0) !== NK_NULL) {
    takeProps();
    return;
  }
  while (at < tkCount && isContentPropertyKind(tkKind[at] | 0)) {
    if ((tkKind[at] | 0) !== TK_COMMENT) {
      const placeOffset = tkStart[at] | 0;
      const placeLine = lineOf(placeOffset);
      if (placeLine !== lineOf(indicatorStart)) {
        const placeCol = columnOf(placeOffset, placeLine);
        if (placeCol <= columnOf(entry, lineOf(entry))) break;
      }
    }
    pushProp(at);
    at = at + 1;
  }
}

function takeComments(): void {
  while (at < tkCount && (tkKind[at] | 0) === TK_COMMENT) {
    transformComment(tkStart[at] | 0, tkEnd[at] | 0);
    at = at + 1;
  }
}

/** `extractComments` */
function extractComments(pb: number, pn: number): void {
  for (let i = pb; i < pb + pn; i++) {
    const tok = propTok[i] | 0;
    if ((tkKind[tok] | 0) === TK_COMMENT) transformComment(tkStart[tok] | 0, tkEnd[tok] | 0);
  }
}

const SET_TAG = "tag:yaml.org,2002:set";
const YAML_TAG_PREFIX = "tag:yaml.org,2002:";

function textEqualsAscii(start: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (end - start !== n) return false;
  for (let i = 0; i < n; i++) {
    if ((text[start + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

function rangesEqual(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  if (aEnd - aStart !== bEnd - bStart) return false;
  for (let i = 0; i < aEnd - aStart; i++) {
    if ((text[aStart + i] | 0) !== (text[bStart + i] | 0)) return false;
  }
  return true;
}

/** Whether `SET` is the prefix text[ps, pe) and then text[ss, se). */
function setIsPrefixThen(ps: number, pe: number, ss: number, se: number): boolean {
  const plen = pe - ps;
  if (plen > SET_TAG.length) return false;
  for (let i = 0; i < plen; i++) {
    if ((text[ps + i] | 0) !== SET_TAG.charCodeAt(i)) return false;
  }
  return textEqualsAscii(ss, se, SET_TAG.substring(plen));
}

/** Whether the tag that is written text[start, end) is `tag:yaml.org,2002:set`. */
function isSetTag(start: number, end: number): boolean {
  if (end - start >= 2 && (text[start] | 0) === 33 && (text[start + 1] | 0) === 60) {
    // `!<..>`
    if (end - start >= 3 && (text[end - 1] | 0) === 62) return textEqualsAscii(start + 2, end - 1, SET_TAG);
    return false;
  }
  let handleEnd = start;
  for (let i = end - 1; i >= start; i--) {
    if ((text[i] | 0) === 33) {
      handleEnd = i + 1;
      break;
    }
  }
  // The last `%TAG` with that handle
  for (let i = tagsLen - 4; i >= 0; i -= 4) {
    if (rangesEqual(tags[i] | 0, tags[i + 1] | 0, start, handleEnd)) {
      return setIsPrefixThen(tags[i + 2] | 0, tags[i + 3] | 0, handleEnd, end);
    }
  }
  if (handleEnd - start === 2 && (text[start] | 0) === 33 && (text[start + 1] | 0) === 33) {
    // `!!`
    const plen = YAML_TAG_PREFIX.length;
    if (SET_TAG.length - plen !== end - handleEnd) return false;
    return textEqualsAscii(handleEnd, end, SET_TAG.substring(plen));
  }
  return false;
}

function pushTag(handleStart: number, handleEnd: number, prefixStart: number, prefixEnd: number): void {
  if (tagsLen + 4 > tags.length) {
    const n = new Int32Array(tags.length * 2);
    n.set(tags);
    tags = n;
  }
  tags[tagsLen] = handleStart | 0;
  tags[tagsLen + 1] = handleEnd | 0;
  tags[tagsLen + 2] = prefixStart | 0;
  tags[tagsLen + 3] = prefixEnd | 0;
  tagsLen = tagsLen + 4;
}

/** `transformContentProperties`, for the node `id`, whose content starts at `start`; the properties are on the stack. */
function transformContentProperties(id: number, start: number, pb: number, pn: number): void {
  let firstTagOrAnchorStart = -1;
  if (pn > 0) hasProperties = true;
  for (let i = pb; i < pb + pn; i++) {
    const tok = propTok[i] | 0;
    const tokKind = tkKind[tok] | 0;
    const tokStart = tkStart[tok] | 0;
    const tokEnd = tkEnd[tok] | 0;
    if (tokKind === TK_TAG) {
      if (firstTagOrAnchorStart < 0) firstTagOrAnchorStart = tokStart;
      const tag = newNodeAt(K_TAG, tokStart, tokEnd);
      const kind = T.d[(id << 5) + F_KIND] | 0;
      if ((kind === K_MAPPING || kind === K_FLOW_MAPPING) && isSetTag(tokStart, tokEnd)) {
        T.d[(tag << 5) + F_FLAGS] = (T.d[(tag << 5) + F_FLAGS] | 0) | F_SET_TAG;
      }
      T.d[(id << 5) + F_TAG] = own(id, tag);
      T.d[(id << 5) + F_FLAGS] = (T.d[(id << 5) + F_FLAGS] | 0) | F_HAS_PROPS;
    } else if (tokKind === TK_ANCHOR) {
      if (firstTagOrAnchorStart < 0) firstTagOrAnchorStart = tokStart;
      const anchor = newNodeAt(K_ANCHOR, tokStart, tokEnd);
      T.d[(anchor << 5) + F_V_START] = tokStart + 1;
      T.d[(anchor << 5) + F_V_END] = tokEnd > tokStart + 1 ? tokEnd : tokStart + 1;
      T.d[(id << 5) + F_ANCHOR] = own(id, anchor);
      T.d[(id << 5) + F_FLAGS] = (T.d[(id << 5) + F_FLAGS] | 0) | F_HAS_PROPS;
    } else {
      const comment = transformComment(tokStart, tokEnd);
      if (firstTagOrAnchorStart >= 0 && firstTagOrAnchorStart <= tokStart && tokEnd <= start) {
        appendMiddle(id, comment);
      }
    }
  }
}

/** Whether what starts at the next token is `mapping` in braces, and not a mapping without, whose first key is in
 * brackets or braces: that starts where its key does. */
function isInBraces(node: number, mapping: number): boolean {
  if (peekKind() !== TK_MAPPING_START) return false;
  if ((yamlNodeCount(mapping) | 0) > 0) {
    const key = yamlPropKey(mapping, 0);
    const keyKind = yamlNodeKind(key) | 0;
    if ((keyKind === NK_OBJECT || keyKind === NK_ARRAY) && (yamlNodeLoc(key) | 0) === (yamlNodeLoc(node) | 0)) return false;
  }
  return true;
}

/** `transformNode`. `node` is written at the next token, behind the properties. Returns the node, or -1 (`Unexpected`). */
function transformNode(node: number, pb: number, pn: number): number {
  if (!stack.enter()) return -1;
  const top = propTop;
  let result = -1;
  const nk = yamlNodeKind(node) | 0;
  if (nk === NK_SCALAR) {
    result = transformScalar(pb, pn);
  } else if (nk === NK_ALIAS) {
    const tok = take(TK_ALIAS);
    if (tok >= 0) {
      const start = tkStart[tok] | 0;
      const end = tkEnd[tok] | 0;
      const id = newNodeAt(K_ALIAS, start, end);
      if (pn > 0) transformContentProperties(id, start, pb, pn);
      T.d[(id << 5) + F_V_START] = start + 1;
      T.d[(id << 5) + F_V_END] = end > start + 1 ? end : start + 1;
      result = id;
    }
  } else if (nk === NK_OBJECT) {
    if (isInBraces(node, node)) result = transformFlowMap(node, pb, pn);
    else result = transformMap(node, pb, pn);
  } else if (nk === NK_ARRAY) {
    if (peekKind() === TK_SEQUENCE_START) result = transformFlowSeq(node, pb, pn);
    else result = transformSeq(node, pb, pn);
  } else {
    result = transformEmptyNode(pb, pn);
  }
  propTop = top;
  stack.leave();
  return result;
}

/** A node of which nothing is written but a tag or an anchor. */
function transformEmptyNode(pb: number, pn: number): number {
  let end = -1;
  for (let i = pb + pn - 1; i >= pb; i--) {
    const tok = propTok[i] | 0;
    if ((tkKind[tok] | 0) !== TK_COMMENT) {
      end = tkEnd[tok] | 0;
      break;
    }
  }
  if (end < 0) return -1;
  const id = newNodeAt(K_PLAIN, end, end);
  transformContentProperties(id, end, pb, pn);
  return id;
}

function transformScalar(pb: number, pn: number): number {
  const tok = take(TK_SCALAR);
  if (tok < 0) return -1;
  const start = tkStart[tok] | 0;
  const tend = tkEnd[tok] | 0;
  const first = start < textLen ? text[start] | 0 : -1;
  let kind = K_PLAIN;
  let end = tend;
  if (first === 124) return transformBlockScalar(K_BLOCK_LITERAL, tok, pb, pn);
  if (first === 62) return transformBlockScalar(K_BLOCK_FOLDED, tok, pb, pn);
  if (first === 34) {
    kind = K_QUOTE_DOUBLE;
  } else if (first === 39) {
    kind = K_QUOTE_SINGLE;
  } else if (first === 44) {
    // Which Bun's parser takes outside of brackets.
    return -1;
  } else {
    let len = 0;
    for (let i = tend - 1; i >= start; i--) {
      const b = text[i] | 0;
      if (b !== 32 && b !== 9 && b !== 10) {
        len = i - start + 1;
        break;
      }
    }
    end = start + len;
  }
  const id = newNodeAt(kind, start, end);
  if (pn > 0) transformContentProperties(id, start, pb, pn);
  return id;
}

/** Where `yaml` has the block scalar end whose lines start at `body`, and which something at `next` follows. Lines at the end
 * with nothing in them, and not indented further than the first, are only part of it with `+`. */
function endOfBlockScalar(body: number, next: number, isKept: boolean): number {
  let afterLineBreak: number;
  if (next >= textLen && !(textLen > 0 && (text[textLen - 1] | 0) === 10)) {
    afterLineBreak = textLen + 1;
  } else {
    afterLineBreak = body;
    const lim = next < textLen ? next : textLen;
    for (let i = lim - 1; i >= 0; i--) {
      if ((text[i] | 0) === 10) {
        afterLineBreak = i + 1;
        break;
      }
    }
  }
  let indent = 0;
  for (let i = body; i < textLen; i++) {
    const b = text[i] | 0;
    if (b === 32) indent = indent + 1;
    else if (b === 10) indent = 0;
    else break;
  }
  while (!isKept && afterLineBreak >= 2) {
    const last = afterLineBreak - 2;
    let blanks = 0;
    // The blanks before text[..=last], backwards
    let j = last < textLen ? last : -1;
    while (j >= 0 && (text[j] | 0) === 32) {
      blanks = blanks + 1;
      j = j - 1;
    }
    const pos = last - blanks;
    if (pos >= 0 && pos >= body && pos < textLen && (text[pos] | 0) === 10 && pos + 1 + indent > last) {
      afterLineBreak = pos + 1;
    } else {
      break;
    }
  }
  if (afterLineBreak < body) return body;
  return afterLineBreak > textLen ? textLen : afterLineBreak;
}

function transformBlockScalar(kind: number, tok: number, pb: number, pn: number): number {
  const start = tkStart[tok] | 0;
  const tend = tkEnd[tok] | 0;
  // The header: up to the first blank or line break
  let headerEnd = start;
  while (headerEnd < textLen) {
    const b = text[headerEnd] | 0;
    if (b === 32 || b === 9 || b === 10) break;
    headerEnd = headerEnd + 1;
  }
  let indicatorComment = -1;
  if (at < tkCount && (tkKind[at] | 0) === TK_COMMENT && (tkStart[at] | 0) < tend) {
    indicatorComment = transformComment(tkStart[at] | 0, tkEnd[at] | 0);
    at = at + 1;
  }
  // `/([+-]?)(\d*)([+-]?)$/`
  let beforeLastSign = headerEnd;
  let lastSign = -1;
  if (headerEnd > start) {
    const b = text[headerEnd - 1] | 0;
    if (b === 43 || b === 45) {
      lastSign = b;
      beforeLastSign = headerEnd - 1;
    }
  }
  let digitsStart = beforeLastSign;
  while (digitsStart > start) {
    const b = text[digitsStart - 1] | 0;
    if (b >= 48 && b <= 57) digitsStart = digitsStart - 1;
    else break;
  }
  let firstSign = -1;
  if (digitsStart > start) {
    const b = text[digitsStart - 1] | 0;
    if (b === 43 || b === 45) firstSign = b;
  }
  const sign = lastSign >= 0 ? lastSign : firstSign;
  let chomping = CH_CLIP;
  if (sign === 43) chomping = CH_KEEP;
  else if (sign >= 0) chomping = CH_STRIP;
  let body = textLen;
  for (let i = start; i < textLen; i++) {
    if ((text[i] | 0) === 10) {
      body = i + 1;
      break;
    }
  }
  const end = endOfBlockScalar(body, tend, chomping === CH_KEEP);
  const id = newNodeAt(kind, start, end);
  if (pn > 0) transformContentProperties(id, start, pb, pn);
  T.d[(id << 5) + F_INDENT] = -1;
  if (digitsStart < beforeLastSign) {
    let all = 0;
    for (let i = digitsStart; i < beforeLastSign; i++) {
      all = all * 10;
      if (all > 4294967295) all = 4294967295;
      all = (all + ((text[i] | 0) - 48)) % 4294967296;
    }
    T.d[(id << 5) + F_INDENT] = all;
  }
  T.d[(id << 5) + F_FLAGS] = (T.d[(id << 5) + F_FLAGS] | 0) | (chomping << 1);
  T.d[(id << 5) + F_INDICATOR] = indicatorComment;
  if (indicatorComment >= 0) T.d[(id << 5) + F_FLAGS] = (T.d[(id << 5) + F_FLAGS] | 0) | F_HAS_COMMENTS;
  if (indicatorComment >= 0) own(id, indicatorComment);
  return id;
}

/** The comments and commas before the end of a flow collection, and the end. `children`: where its items start in
 * `pending`. */
function finishFlowCollection(kind: number, endKind: number, startTok: number, children: number, pb: number, pn: number): number {
  takeComments();
  while (take(TK_COLLECT_ENTRY) >= 0) takeComments();
  const close = take(endKind);
  if (close < 0) return -1;
  const id = newNodeAt(kind, tkStart[startTok] | 0, tkEnd[close] | 0);
  if (pn > 0) transformContentProperties(id, tkStart[startTok] | 0, pb, pn);
  addPendingChildren(id, children);
  return id;
}

function transformFlowMap(mapping: number, pb: number, pn: number): number {
  const start = take(TK_MAPPING_START);
  if (start < 0) return -1;
  const children = pending.len;
  const count = yamlNodeCount(mapping) | 0;
  for (let i = 0; i < count; i++) {
    const mark = propTop;
    const child = transformPair(yamlPropKey(mapping, i), yamlPropValue(mapping, i), K_FLOW_MAPPING_ITEM, propTop, 0);
    propTop = mark;
    if (child < 0) return -1;
    pending.push(child);
  }
  return finishFlowCollection(K_FLOW_MAPPING, TK_MAPPING_END, start, children, pb, pn);
}

function transformFlowSeq(sequence: number, pb: number, pn: number): number {
  const start = take(TK_SEQUENCE_START);
  if (start < 0) return -1;
  const children = pending.len;
  const count = yamlNodeCount(sequence) | 0;
  for (let i = 0; i < count; i++) {
    const item = yamlItem(sequence, i);
    const mark = propTop;
    takeProps();
    while (take(TK_COLLECT_ENTRY) >= 0) takeProps();
    const itemCount = propTop - mark;
    let child = -1;
    // `[ key: value ]`
    if ((yamlNodeKind(item) | 0) === NK_OBJECT && !isInBraces(item, item)) {
      if ((yamlNodeCount(item) | 0) === 0) return -1;
      child = transformPair(yamlPropKey(item, 0), yamlPropValue(item, 0), K_FLOW_MAPPING_ITEM, mark, itemCount);
    } else {
      const content = transformNode(item, mark, itemCount);
      if (content < 0) return -1;
      child = newNode(K_FLOW_SEQUENCE_ITEM);
      copyStart(child, content);
      copyEnd(child, content);
      setOnlyChild(child, content);
    }
    propTop = mark;
    if (child < 0) return -1;
    pending.push(child);
  }
  return finishFlowCollection(K_FLOW_SEQUENCE, TK_SEQUENCE_END, start, children, pb, pn);
}

/** A node of `kind` from the first to the last of `pending[children..]`, which are in it. */
function finishBlockCollection(kind: number, start: number, children: number, pb: number, pn: number): number {
  if (pending.len <= children) return -1;
  const first = pending.data[children] | 0;
  const last = pending.data[pending.len - 1] | 0;
  const id = newNode(kind);
  copyStart(id, first);
  copyEnd(id, last);
  if (pn > 0) transformContentProperties(id, start, pb, pn);
  addPendingChildren(id, children);
  return id;
}

function transformMap(mapping: number, pb: number, pn: number): number {
  if (at >= tkCount) return -1;
  const start = tkStart[at] | 0;
  // `getFirstKeyStartProps`: what is on the line of the first key belongs to that.
  let lineStart = 0;
  for (let i = start - 1; i >= 0; i--) {
    if ((text[i] | 0) === 10) {
      lineStart = i + 1;
      break;
    }
  }
  let ownCount = 0;
  while (ownCount < pn && (tkStart[propTok[pb + ownCount] | 0] | 0) < lineStart) ownCount = ownCount + 1;
  // The rest are the properties of the first key
  const keyBase = pb + ownCount;
  let keyCount = pn - ownCount;
  const children = pending.len;
  const count = yamlNodeCount(mapping) | 0;
  for (let i = 0; i < count; i++) {
    if (pending.len > children && isAtKeyThatYamlRefuses()) return -1;
    propTop = keyBase + keyCount;
    const child = transformPair(yamlPropKey(mapping, i), yamlPropValue(mapping, i), K_MAPPING_ITEM, keyBase, keyCount);
    keyCount = 0;
    propTop = keyBase;
    if (child < 0) return -1;
    pending.push(child);
  }
  return finishBlockCollection(K_MAPPING, start, children, pb, ownCount);
}

/** `yaml` 2.9 cannot read a key in brackets or braces without a `?` if anything is written, be it blanks, between it and the
 * line that the value above it ends on. That value is in the last of `pending`. */
function isAtKeyThatYamlRefuses(): boolean {
  let firstTok = -1;
  let keyTok = -1;
  for (let i = at; i < tkCount; i++) {
    const k = tkKind[i] | 0;
    if (k === TK_COMMENT) continue;
    if (firstTok < 0) firstTok = i;
    if (!isContentPropertyKind(k)) {
      keyTok = i;
      break;
    }
  }
  if (firstTok < 0 || keyTok < 0) return false;
  const kk = tkKind[keyTok] | 0;
  if (kk !== TK_SEQUENCE_START && kk !== TK_MAPPING_START) return false;
  if (pending.len === 0) return false;
  const item = pending.data[pending.len - 1] | 0;
  const valueNode = T.d[(item << 5) + F_CH_LEN] > 0 ? T.d[(item << 5) + F_CH_LAST] | 0 : -1;
  if (valueNode < 0) return false;
  const content = T.d[(valueNode << 5) + F_CH_LEN] > 0 ? T.d[(valueNode << 5) + F_CH_FIRST] | 0 : -1;
  if (content < 0) return false;
  const end = T.d[(content << 5) + F_E_OFF] | 0;
  const firstStart = tkStart[firstTok] | 0;
  const vk = T.d[(content << 5) + F_KIND] | 0;
  // between = text[end..firstStart]
  let hasBetween = end <= firstStart && firstStart <= textLen;
  let newlines = 0;
  let endsWithNewline = false;
  if (hasBetween) {
    for (let i = end; i < firstStart; i++) {
      if ((text[i] | 0) === 10) newlines = newlines + 1;
    }
    endsWithNewline = firstStart > end && (text[firstStart - 1] | 0) === 10;
  }
  if (vk === K_BLOCK_FOLDED || vk === K_BLOCK_LITERAL) return newlines > 0;
  if (vk === K_PLAIN && (T.d[(content << 5) + F_S_OFF] | 0) === end) return false;
  return !endsWithNewline || newlines !== 1;
}

function transformSeq(sequence: number, pb: number, pn: number): number {
  if (at >= tkCount) return -1;
  const start = tkStart[at] | 0;
  const children = pending.len;
  const count = yamlNodeCount(sequence) | 0;
  for (let i = 0; i < count; i++) {
    const item = yamlItem(sequence, i);
    takeComments();
    const indicator = take(TK_SEQUENCE_ENTRY);
    if (indicator < 0) return -1;
    const mark = propTop;
    const indicatorStart = tkStart[indicator] | 0;
    takePropsBehind(indicatorStart, indicatorStart, item);
    const itemCount = propTop - mark;
    // `transformItemValue`
    let content = -1;
    if (isEmptyNode(item, mark, itemCount)) {
      extractComments(mark, itemCount);
    } else {
      content = transformNode(item, mark, itemCount);
      if (content < 0) return -1;
    }
    propTop = mark;
    const id = newNode(K_SEQUENCE_ITEM);
    setStart(id, indicatorStart);
    if (content >= 0) copyEnd(id, content);
    else setEnd(id, tkEnd[indicator] | 0);
    if (content >= 0) setOnlyChild(id, content);
    pending.push(id);
  }
  return finishBlockCollection(K_SEQUENCE, start, children, pb, pn);
}

/** `transformPair`. `kind`: of the item. (`keyBase`, `keyCount`): what has been seen of the properties of the key; they are
 * on top of the stack. */
function transformPair(key: number, value: number, kind: number, keyBase: number, keyCountIn: number): number {
  const isFlow = kind === K_FLOW_MAPPING_ITEM;
  let explicitKeyInd = -1;
  for (;;) {
    if (explicitKeyInd >= 0 && !isFlow) {
      takePropsBehind(tkStart[explicitKeyInd] | 0, tkStart[explicitKeyInd] | 0, key);
    } else {
      takeProps();
    }
    const k = peekKind();
    if (k === TK_MAPPING_KEY && explicitKeyInd < 0) {
      explicitKeyInd = take(TK_MAPPING_KEY);
    } else if (k === TK_COLLECT_ENTRY && isFlow) {
      at = at + 1;
    } else {
      break;
    }
  }
  const keyCount = propTop - keyBase;
  void keyCountIn;
  // `entry`
  let entryTok = -1;
  for (let i = keyBase; i < keyBase + keyCount; i++) {
    if ((tkKind[propTok[i] | 0] | 0) !== TK_COMMENT) {
      entryTok = propTok[i] | 0;
      break;
    }
  }
  if (entryTok < 0) entryTok = explicitKeyInd;
  if (entryTok < 0 && at < tkCount) entryTok = at;
  let entry = 0;
  if (entryTok >= 0) {
    entry = tkStart[entryTok] | 0;
    if (explicitKeyInd >= 0 && (tkStart[explicitKeyInd] | 0) < entry) entry = tkStart[explicitKeyInd] | 0;
  }
  const keyToken = (yamlNodeKind(key) | 0) !== NK_NULL && at < tkCount ? at : -1;

  // `transformAstPair`
  let keyContent = -1;
  if (isEmptyNode(key, keyBase, keyCount)) {
    extractComments(keyBase, keyCount);
  } else {
    keyContent = transformNode(key, keyBase, keyCount);
    if (keyContent < 0) return -1;
  }
  takeComments();
  // Further to the left than its `?`, it is that of a mapping around.
  let mapValueInd = -1;
  if (at < tkCount && (tkKind[at] | 0) === TK_MAPPING_VALUE) {
    let ok = isFlow || explicitKeyInd < 0;
    if (!ok) {
      const keyOffset = tkStart[explicitKeyInd] | 0;
      const colonOffset = tkStart[at] | 0;
      const keyLine = lineOf(keyOffset);
      const colonLine = lineOf(colonOffset);
      ok = keyLine === colonLine || columnOf(keyOffset, keyLine) <= columnOf(colonOffset, colonLine);
    }
    if (ok) mapValueInd = at;
  }
  const valueBase = propTop;
  if (mapValueInd >= 0) {
    at = at + 1;
    if (isFlow) takeProps();
    else takePropsBehind(tkStart[mapValueInd] | 0, entry, value);
  }
  const valueCount = propTop - valueBase;
  let valueContent = -1;
  if (isEmptyNode(value, valueBase, valueCount)) {
    extractComments(valueBase, valueCount);
  } else {
    valueContent = transformNode(value, valueBase, valueCount);
    if (valueContent < 0) return -1;
  }

  let keyStartTok = explicitKeyInd;
  if (keyStartTok < 0) keyStartTok = keyToken;
  if (keyStartTok < 0) keyStartTok = mapValueInd;
  if (keyStartTok < 0) return -1;
  const keyStart = tkStart[keyStartTok] | 0;
  const mappingKey = newNode(K_MAPPING_KEY);
  if (keyContent >= 0) {
    if ((T.d[(keyContent << 5) + F_S_OFF] | 0) === keyStart) copyStart(mappingKey, keyContent);
    else setStart(mappingKey, keyStart);
    copyEnd(mappingKey, keyContent);
    setOnlyChild(mappingKey, keyContent);
  } else {
    setStart(mappingKey, keyStart);
    setEnd(mappingKey, explicitKeyInd >= 0 ? tkEnd[explicitKeyInd] | 0 : keyStart);
  }
  const mappingValue = newNode(K_MAPPING_VALUE);
  if (mapValueInd >= 0 && valueContent >= 0) {
    setStart(mappingValue, tkStart[mapValueInd] | 0);
    copyEnd(mappingValue, valueContent);
  } else if (mapValueInd >= 0) {
    setStart(mappingValue, tkStart[mapValueInd] | 0);
    setEnd(mappingValue, (tkStart[mapValueInd] | 0) + 1);
  } else if (valueContent >= 0) {
    copyStart(mappingValue, valueContent);
    copyEnd(mappingValue, valueContent);
  } else {
    // the end of the key, for both
    copyEnd(mappingValue, mappingKey);
    T.d[(mappingValue << 5) + F_S_OFF] = T.d[(mappingKey << 5) + F_E_OFF] | 0;
    T.d[(mappingValue << 5) + F_S_LINE] = T.d[(mappingKey << 5) + F_E_LINE] | 0;
  }
  if (valueContent >= 0) setOnlyChild(mappingValue, valueContent);
  const id = newNode(kind);
  copyStart(id, mappingKey);
  copyEnd(id, mappingValue);
  setTwoChildren(id, mappingKey, mappingValue);
  return id;
}

// The comment behind a directive, when it is one that no token says
let dirCommentStart = -1;
let dirCommentEnd = -1;

/** The directive whose `%` is `token`; the comment behind it is in `dirCommentStart`/`dirCommentEnd` (-1: none). */
function transformDirective(tok: number): number {
  const start = tkStart[tok] | 0;
  let lineEnd = start;
  while (lineEnd < textLen && (text[lineEnd] | 0) !== 10) lineEnd = lineEnd + 1;
  // The comment: `#` behind a blank
  dirCommentStart = -1;
  dirCommentEnd = -1;
  let contentEnd = lineEnd;
  for (let i = start + 1; i < lineEnd; i++) {
    if ((text[i] | 0) === 35) {
      const p = text[i - 1] | 0;
      if (p === 32 || p === 9) {
        dirCommentStart = i;
        dirCommentEnd = lineEnd;
        contentEnd = i;
        break;
      }
    }
  }
  while (contentEnd > start) {
    const b = text[contentEnd - 1] | 0;
    if (b === 32 || b === 9) contentEnd = contentEnd - 1;
    else break;
  }
  const directive = newNodeAt(K_DIRECTIVE, start, contentEnd);
  T.d[(directive << 5) + F_V_START] = start;
  T.d[(directive << 5) + F_V_END] = contentEnd;
  // `%TAG handle prefix`
  let i = start;
  let nPart = 0;
  let name0 = 0;
  let name1 = 0;
  let h0 = 0;
  let h1 = 0;
  let p0 = 0;
  let p1 = 0;
  while (i < contentEnd && nPart < 3) {
    while (i < contentEnd && ((text[i] | 0) === 32 || (text[i] | 0) === 9)) i = i + 1;
    if (i >= contentEnd) break;
    const s = i;
    while (i < contentEnd && (text[i] | 0) !== 32 && (text[i] | 0) !== 9) i = i + 1;
    if (nPart === 0) {
      name0 = s;
      name1 = i;
    } else if (nPart === 1) {
      h0 = s;
      h1 = i;
    } else {
      p0 = s;
      p1 = i;
    }
    nPart = nPart + 1;
  }
  if (nPart === 3 && textEqualsAscii(name0, name1, "%TAG")) pushTag(h0, h1, p0, p1);
  return directive;
}

const endCommentsVec = new I32Vec(16);
const directivesVec = new I32Vec(8);
const candidatesVec = new I32Vec(8);

/** The comments behind `content`, which is all that is in a document, as far as they are in the document for `yaml`.
 * Takes them (into `endCommentsVec`) that it has at the end of the document, and in nothing that is in it. */
function takeEndComments(content: number): void {
  endCommentsVec.reset();
  if (content < 0) return;
  const ckind = T.d[(content << 5) + F_KIND] | 0;
  const isBlock = ckind === K_MAPPING || ckind === K_SEQUENCE;
  // What is behind an item without a value is in that item.
  let isOpen = false;
  if (isBlock) {
    if ((T.d[(content << 5) + F_CH_LEN] | 0) === 0) {
      isOpen = true;
    } else {
      const item = T.d[(content << 5) + F_CH_LAST] | 0;
      let it = item;
      let none = false;
      if ((T.d[(item << 5) + F_KIND] | 0) === K_MAPPING_ITEM) {
        if ((T.d[(item << 5) + F_CH_LEN] | 0) === 0) none = true;
        else it = T.d[(item << 5) + F_CH_LAST] | 0;
      }
      isOpen = none || (T.d[(it << 5) + F_CH_LEN] | 0) === 0;
    }
  }
  let isBlockScalar = false;
  if (at >= 1) {
    const s = tkStart[at - 1] | 0;
    if (s < textLen) {
      const b = text[s] | 0;
      isBlockScalar = b === 124 || b === 62;
    }
  }
  let end = T.d[(content << 5) + F_E_OFF] | 0;
  if (!isBlockScalar && at < tkCount) {
    end = trimJsWhitespaceEnd(text, 0, tkStart[at] | 0);
  }
  const lastLineOfContent = lineOf(end > 0 ? end - 1 : 0);
  while (at < tkCount && (tkKind[at] | 0) === TK_COMMENT) {
    const ts = tkStart[at] | 0;
    const te = tkEnd[at] | 0;
    const placeLine = lineOf(ts);
    // A document whose content is no block collection ends with the line after that.
    if (!isBlock && placeLine > lastLineOfContent + 1) break;
    at = at + 1;
    const comment = transformComment(ts, te);
    if (placeLine > lastLineOfContent && !isOpen && (!isBlock || columnOf(ts, placeLine) === 1 || endCommentsVec.len > 0)) {
      endCommentsVec.push(comment);
    }
  }
}

/** The kind of the first token from `at` that is no comment, or -1. */
function nextNonCommentKind(): number {
  for (let i = at; i < tkCount; i++) {
    const k = tkKind[i] | 0;
    if (k !== TK_COMMENT) return k;
  }
  return -1;
}

/** `transformDocument`. `root`: what is in it, or -1. */
function transformDocument(rootIn: number): number {
  const root = rootIn >= 0 && (yamlNodeKind(rootIn) | 0) !== NK_NULL ? rootIn : -1;
  // `transformDocumentHead`
  tagsLen = 0;
  directivesVec.reset();
  candidatesVec.reset();
  // Bun's parser takes it for a part of a directive that it does not know.
  let cdStart = -1;
  let cdEnd = -1;
  for (;;) {
    let haveComment = false;
    let cs = 0;
    let ce = 0;
    if (cdStart >= 0) {
      haveComment = true;
      cs = cdStart;
      ce = cdEnd;
      cdStart = -1;
      cdEnd = -1;
    } else if (at < tkCount && (tkKind[at] | 0) === TK_COMMENT) {
      haveComment = true;
      cs = tkStart[at] | 0;
      ce = tkEnd[at] | 0;
      at = at + 1;
    }
    if (haveComment) {
      const comment = transformComment(cs, ce);
      const nd = directivesVec.len;
      let attached = false;
      if (nd > 0) {
        const last = directivesVec.data[nd - 1] | 0;
        if ((T.d[(last << 5) + F_E_LINE] | 0) === (T.d[(comment << 5) + F_S_LINE] | 0) && (T.d[(last << 5) + F_TRAILING] | 0) < 0) {
          T.d[(last << 5) + F_TRAILING] = comment;
          T.d[(last << 5) + F_FLAGS] = (T.d[(last << 5) + F_FLAGS] | 0) | F_HAS_COMMENTS;
          copyEnd(last, comment);
          own(last, comment);
          attached = true;
        }
      }
      if (!attached) candidatesVec.push(comment);
    } else if (at < tkCount && (tkKind[at] | 0) === TK_DIRECTIVE) {
      const tok = at;
      at = at + 1;
      const directive = transformDirective(tok);
      directivesVec.push(directive);
      cdStart = dirCommentStart;
      cdEnd = dirCommentEnd;
      // Unless the next token is that comment
      if (cdStart >= 0 && at < tkCount && (tkKind[at] | 0) === TK_COMMENT && (tkStart[at] | 0) === cdStart && (tkEnd[at] | 0) === cdEnd) {
        cdStart = -1;
        cdEnd = -1;
      }
      candidatesVec.reset();
    } else {
      break;
    }
  }
  const docStart = take(TK_DOCUMENT_START);
  const mark = propTop;
  takeProps();
  let pb = mark;
  let pn = propTop - mark;
  let hasProps = false;
  for (let i = pb; i < pb + pn; i++) {
    if ((tkKind[propTok[i] | 0] | 0) !== TK_COMMENT) {
      hasProps = true;
      break;
    }
  }
  let contentsStart = 0;
  if (root < 0) {
    for (let i = pb + pn - 1; i >= pb; i--) {
      const tok = propTok[i] | 0;
      if ((tkKind[tok] | 0) !== TK_COMMENT) {
        contentsStart = tkEnd[tok] | 0;
        break;
      }
    }
  } else {
    if (at >= tkCount) return -1;
    contentsStart = tkStart[at] | 0;
  }
  let headStart = contentsStart;
  let headEnd = contentsStart;
  if (docStart >= 0) {
    headStart = tkStart[docStart] | 0;
    headEnd = tkEnd[docStart] | 0;
  }
  if (directivesVec.len > 0) headStart = T.d[((directivesVec.data[0] | 0) << 5) + F_S_OFF] | 0;
  const head = newNodeAt(K_DOCUMENT_HEAD, headStart, headEnd);
  const headEndLine = T.d[(head << 5) + F_E_LINE] | 0;
  let headTrailingComment = -1;
  if (docStart >= 0 && pn > 0 && (tkKind[propTok[pb] | 0] | 0) === TK_COMMENT) {
    const first = propTok[pb] | 0;
    if (lineOf(tkStart[first] | 0) === headEndLine) {
      headTrailingComment = transformComment(tkStart[first] | 0, tkEnd[first] | 0);
      pb = pb + 1;
      pn = pn - 1;
    }
  }
  const nDirectives = directivesVec.len;
  for (let i = 0; i < nDirectives; i++) appendChild(head, directivesVec.data[i] | 0);
  if (docStart >= 0) {
    const nc = candidatesVec.len;
    for (let i = 0; i < nc; i++) appendEnd(head, candidatesVec.data[i] | 0);
  }
  T.d[(head << 5) + F_TRAILING] = headTrailingComment;
  if (headTrailingComment >= 0) T.d[(head << 5) + F_FLAGS] = (T.d[(head << 5) + F_FLAGS] | 0) | F_HAS_COMMENTS;
  if (headTrailingComment >= 0) own(head, headTrailingComment);

  // `transformDocumentBody`
  let content = -1;
  if (root >= 0) {
    content = transformNode(root, pb, pn);
    if (content < 0) return -1;
  } else if (hasProps) {
    content = transformEmptyNode(pb, pn);
    if (content < 0) return -1;
  } else {
    extractComments(pb, pn);
  }
  propTop = mark;
  takeEndComments(content);
  if (nextNonCommentKind() === TK_DOCUMENT_END) takeComments();
  const docEnd = take(TK_DOCUMENT_END);
  let documentTrailingComment = -1;
  if (docEnd >= 0) {
    const line = lineOf(tkStart[docEnd] | 0);
    if (at < tkCount && (tkKind[at] | 0) === TK_COMMENT) {
      if (lineOf(tkStart[at] | 0) === line) {
        documentTrailingComment = transformComment(tkStart[at] | 0, tkEnd[at] | 0);
        at = at + 1;
      }
    }
  }
  let bodyEnd = textLen;
  if (docEnd >= 0) {
    const s = tkStart[docEnd] | 0;
    bodyEnd = s > 0 ? s - 1 : 0;
  } else if (at < tkCount) {
    bodyEnd = tkStart[at] | 0;
  }
  let bodyStart = content >= 0 ? T.d[(content << 5) + F_S_OFF] | 0 : bodyEnd;
  if (docStart >= 0) {
    const docStartEnd = (tkEnd[docStart] | 0) + 1;
    if (bodyStart < docStartEnd && docStartEnd <= bodyEnd) bodyStart = docStartEnd;
  }
  const body = newNodeAt(K_DOCUMENT_BODY, bodyStart, bodyEnd);
  if (content >= 0) setOnlyChild(body, content);
  const nEnd = endCommentsVec.len;
  for (let i = 0; i < nEnd; i++) appendEnd(body, endCommentsVec.data[i] | 0);
  const document = newNode(K_DOCUMENT);
  // The start of the head as it was made
  copyStart(document, head);
  if (docEnd >= 0) setEnd(document, tkEnd[docEnd] | 0);
  else copyEnd(document, body);
  T.d[(document << 5) + F_TRAILING] = documentTrailingComment;
  if (documentTrailingComment >= 0) T.d[(document << 5) + F_FLAGS] = (T.d[(document << 5) + F_FLAGS] | 0) | F_HAS_COMMENTS;
  let flags = 0;
  if (docStart >= 0) flags = flags | F_DIRECTIVES_END_MARKER;
  if (docEnd >= 0) flags = flags | F_DOCUMENT_END_MARKER;
  T.d[(document << 5) + F_FLAGS] = (T.d[(document << 5) + F_FLAGS] | 0) | flags;
  if (documentTrailingComment >= 0) own(document, documentTrailingComment);
  setTwoChildren(document, head, body);
  return document;
}

const documentChildren = new I32Vec(8);
let sortKeys: Int32Array = new Int32Array(64);

/** `transformDocuments`. For `yaml`, every `...` ends a document of its own. Returns false on `Unexpected`. */
function transformDocuments(nDocuments: number): boolean {
  let nextRoot = 0;
  documentChildren.reset();
  for (;;) {
    const nextKind = nextNonCommentKind();
    let root = -1;
    if (nextKind === -1 && documentChildren.len > 0) break;
    if (nextKind === TK_DOCUMENT_END && documentChildren.len > 0) {
      root = -1;
    } else {
      if (nextRoot >= nDocuments) return false;
      root = yamlDocRoot(nextRoot);
      nextRoot = nextRoot + 1;
    }
    const doc = transformDocument(root);
    if (doc < 0) return false;
    documentChildren.push(doc);
  }
  takeComments();
  return true;
}

// ---------------------------------------------------------------------------------------------- `attach.ts`

// The per-line table: `comment`, `leadingAttachableNode`, `trailingAttachableNode`, `trailingNode`
let tabComment: Int32Array = new Int32Array(64);
let tabLeading: Int32Array = new Int32Array(64);
let tabTrailing: Int32Array = new Int32Array(64);
let tabNode: Int32Array = new Int32Array(64);
// The columns of what is in the table (the start of a leading node, the end of the others)
let tabLeadingCol: Int32Array = new Int32Array(64);
let tabTrailingCol: Int32Array = new Int32Array(64);
let tabNodeCol: Int32Array = new Int32Array(64);
let nextLeading: Int32Array = new Int32Array(64);
let tabLen = 0;

function columnOfStart(id: number): number {
  const b = id << 5;
  return columnOf(T.d[b + F_S_OFF] | 0, T.d[b + F_S_LINE] | 0);
}

function columnOfEnd(id: number): number {
  const b = id << 5;
  return columnOf(T.d[b + F_E_OFF] | 0, T.d[b + F_E_LINE] | 0);
}

function initNodeTable(id: number): void {
  if (!stack.enter()) return;
  const b = id << 5;
  const sOff = T.d[b + F_S_OFF] | 0;
  const eOff = T.d[b + F_E_OFF] | 0;
  if (sOff === eOff) {
    stack.leave();
    return;
  }
  const kind = T.d[b + F_KIND] | 0;
  const startLine = (T.d[b + F_S_LINE] | 0) - 1;
  const endLine = (T.d[b + F_E_LINE] | 0) - 1;
  if ((HAS_LEADING[kind] | 0) !== 0 && startLine >= 0 && startLine < tabLen) {
    const it = tabLeading[startLine] | 0;
    const col = columnOfStart(id);
    if (it < 0 || col < (tabLeadingCol[startLine] | 0)) {
      tabLeading[startLine] = id;
      tabLeadingCol[startLine] = col;
    }
  }
  let endCol = 0;
  if ((HAS_TRAILING[kind] | 0) !== 0 && kind !== K_DOCUMENT && kind !== K_DOCUMENT_HEAD && endLine >= 0 && endLine < tabLen) {
    endCol = columnOfEnd(id);
    if (endCol > 1) {
      const it = tabTrailing[endLine] | 0;
      if (it < 0 || endCol >= (tabTrailingCol[endLine] | 0)) {
        tabTrailing[endLine] = id;
        tabTrailingCol[endLine] = endCol;
      }
    }
  }
  if (kind !== K_ROOT && kind !== K_DOCUMENT && kind !== K_DOCUMENT_HEAD && kind !== K_DOCUMENT_BODY) {
    if (endCol === 0) endCol = columnOfEnd(id);
    if (endLine >= 0 && endLine < tabLen) {
      const it = tabNode[endLine] | 0;
      if (it < 0 || endCol >= (tabNodeCol[endLine] | 0)) {
        tabNode[endLine] = id;
        tabNodeCol[endLine] = endCol;
      }
    }
    if (startLine !== endLine && startLine >= 0 && startLine < tabLen) {
      const it = tabNode[startLine] | 0;
      if (it < 0 || endCol >= (tabNodeCol[startLine] | 0)) {
        tabNode[startLine] = id;
        tabNodeCol[startLine] = endCol;
      }
    }
  }
  for (let c = T.d[b + F_CH_FIRST] | 0, n = T.d[b + F_CH_LEN] | 0; n > 0; n = n - 1) {
    initNodeTable(c);
    c = T.d[(c << 5) + F_NEXT] | 0;
  }
  stack.leave();
}

/** `isExplicitMappingKey` */
function isExplicitMappingKey(id: number): boolean {
  if ((T.d[(id << 5) + F_CH_LEN] | 0) === 0) return true;
  return (T.d[(id << 5) + F_S_OFF] | 0) !== (T.d[((T.d[(id << 5) + F_CH_FIRST] | 0) << 5) + F_S_OFF] | 0);
}

function shouldOwnEndComment(id: number, cSOff: number, cEOff: number, cSLine: number, cSCol: number): boolean {
  const kind = T.d[(id << 5) + F_KIND] | 0;
  if ((T.d[(id << 5) + F_S_OFF] | 0) < cSOff && (T.d[(id << 5) + F_E_OFF] | 0) > cEOff && (kind === K_FLOW_MAPPING || kind === K_FLOW_SEQUENCE)) {
    if ((T.d[(id << 5) + F_CH_LEN] | 0) === 0) return true;
    return cSLine > (T.d[((T.d[(id << 5) + F_CH_LAST] | 0) << 5) + F_E_LINE] | 0);
  }
  if (cEOff < (T.d[(id << 5) + F_E_OFF] | 0)) return false;
  if (kind === K_SEQUENCE_ITEM) return cSCol > columnOfStart(id);
  if (kind === K_MAPPING_KEY || kind === K_MAPPING_VALUE) {
    const parent = T.d[(id << 5) + F_PARENT] | 0;
    const parentColumn = parent >= 0 ? columnOfStart(parent) : 0;
    if (!(cSCol > parentColumn)) return false;
    const len = T.d[(id << 5) + F_CH_LEN] | 0;
    if (len > 1) return false;
    if (len === 1) {
      const ck = T.d[((T.d[(id << 5) + F_CH_FIRST] | 0) << 5) + F_KIND] | 0;
      if (ck === K_BLOCK_FOLDED || ck === K_BLOCK_LITERAL) return false;
    }
    return kind === K_MAPPING_VALUE || isExplicitMappingKey(id);
  }
  return false;
}

/** Returns false on `Unexpected`. `next_leading[line]`: the first line from the one with the index `line` on that has a
 * `leadingAttachableNode`. */
function attachComment(comment: number, document: number): boolean {
  const cSOff = T.d[(comment << 5) + F_S_OFF] | 0;
  const cEOff = T.d[(comment << 5) + F_E_OFF] | 0;
  const cSLine = T.d[(comment << 5) + F_S_LINE] | 0;
  const cSCol = columnOfStart(comment);
  const commentLine = cSLine;
  if (commentLine - 1 >= 0 && commentLine - 1 < tabLen) {
    const node = tabTrailing[commentLine - 1] | 0;
    if (node >= 0) {
      const had = T.d[(node << 5) + F_TRAILING] | 0;
      T.d[(node << 5) + F_TRAILING] = comment;
      T.d[(node << 5) + F_FLAGS] = (T.d[(node << 5) + F_FLAGS] | 0) | F_HAS_COMMENTS;
      if (had >= 0) return false;
      T.d[(comment << 5) + F_PARENT] = node;
      return true;
    }
  }
  const docStartLine = T.d[(document << 5) + F_S_LINE] | 0;
  let line = commentLine;
  while (line >= docStartLine && line > 0) {
    const idx = line - 1;
    let current = idx < tabLen ? tabNode[idx] | 0 : -1;
    if (current < 0) {
      const other = line !== commentLine && idx < tabLen ? tabComment[idx] | 0 : -1;
      if (other >= 0) {
        current = T.d[(other << 5) + F_PARENT] | 0;
        if (current < 0) return false;
      } else {
        line = line - 1;
        continue;
      }
    }
    const ck = T.d[(current << 5) + F_KIND] | 0;
    if (ck === K_SEQUENCE || ck === K_MAPPING) {
      if ((T.d[(current << 5) + F_CH_LEN] | 0) === 0) return false;
      current = T.d[(current << 5) + F_CH_FIRST] | 0;
    }
    if ((T.d[(current << 5) + F_KIND] | 0) === K_MAPPING_ITEM) {
      if ((T.d[(current << 5) + F_CH_LEN] | 0) !== 2) return false;
      const key = T.d[(current << 5) + F_CH_FIRST] | 0;
      const value = T.d[(current << 5) + F_CH_LAST] | 0;
      current = isExplicitMappingKey(key) ? key : value;
    }
    for (;;) {
      if (shouldOwnEndComment(current, cSOff, cEOff, cSLine, cSCol)) {
        appendEnd(current, comment);
        return true;
      }
      const parent = T.d[(current << 5) + F_PARENT] | 0;
      if (parent < 0) break;
      current = parent;
    }
    break;
  }
  // The first line after that of the comment, in the document.
  if (commentLine < tabLen) {
    const index = nextLeading[commentLine] | 0;
    if (index < (T.d[(document << 5) + F_E_LINE] | 0) && index < tabLen) {
      const node = tabLeading[index] | 0;
      if (node >= 0) {
        appendLeading(node, comment);
        return true;
      }
    }
  }
  if ((T.d[(document << 5) + F_CH_LEN] | 0) <= 1) return false;
  appendEnd(T.d[(document << 5) + F_CH_LAST] | 0, comment);
  return true;
}

/** `updatePositions`. `hasProps`: there are comments, tags or anchors. Without them, everything in the body of a document is
 * where it is said to be from the start. */
function updatePositions(id: number, hasProps: boolean): void {
  if (!stack.enter()) return;
  const kind = T.d[(id << 5) + F_KIND] | 0;
  if ((NO_CHILDREN_FIELD[kind] | 0) !== 0) {
    stack.leave();
    return;
  }
  const nChildren = T.d[(id << 5) + F_CH_LEN] | 0;
  if (nChildren > 0 && (hasProps || kind !== K_DOCUMENT_BODY)) {
    let child = T.d[(id << 5) + F_CH_FIRST] | 0;
    while (child >= 0) {
      updatePositions(child, hasProps);
      child = T.d[(child << 5) + F_NEXT] | 0;
    }
  }
  if (kind === K_DOCUMENT && nChildren === 2) {
    const head = T.d[(id << 5) + F_CH_FIRST] | 0;
    const body = T.d[(id << 5) + F_CH_LAST] | 0;
    if ((T.d[(head << 5) + F_S_OFF] | 0) === (T.d[(head << 5) + F_E_OFF] | 0)) {
      copyStart(head, body);
      T.d[(head << 5) + F_E_OFF] = T.d[(body << 5) + F_S_OFF] | 0;
      T.d[(head << 5) + F_E_LINE] = T.d[(body << 5) + F_S_LINE] | 0;

    } else if ((T.d[(body << 5) + F_S_OFF] | 0) === (T.d[(body << 5) + F_E_OFF] | 0)) {
      T.d[(body << 5) + F_S_OFF] = T.d[(head << 5) + F_E_OFF] | 0;
      T.d[(body << 5) + F_S_LINE] = T.d[(head << 5) + F_E_LINE] | 0;

      copyEnd(body, head);
    }
  }
  // start
  if ((T.d[(id << 5) + F_EN_LEN] | 0) > 0) updateStartFrom(id, T.d[(id << 5) + F_EN_FIRST] | 0);
  if (nChildren > 0) {
    const firstChild = T.d[(id << 5) + F_CH_FIRST] | 0;
    updateStartFrom(id, firstChild);
    if ((T.d[(firstChild << 5) + F_LD_LEN] | 0) > 0) updateStartFrom(id, T.d[(firstChild << 5) + F_LD_FIRST] | 0);
    if ((T.d[(firstChild << 5) + F_TAG] | 0) >= 0) updateStartFrom(id, T.d[(firstChild << 5) + F_TAG] | 0);
    if ((T.d[(firstChild << 5) + F_ANCHOR] | 0) >= 0) updateStartFrom(id, T.d[(firstChild << 5) + F_ANCHOR] | 0);
  }
  // end
  if ((T.d[(id << 5) + F_EN_LEN] | 0) > 0) updateEndFrom(id, T.d[(id << 5) + F_EN_LAST] | 0);
  if (nChildren > 0) {
    const last = T.d[(id << 5) + F_CH_LAST] | 0;
    updateEndFrom(id, last);
    const trailing = T.d[(last << 5) + F_TRAILING] | 0;
    if (trailing >= 0) updateEndFrom(id, trailing);
  }
  stack.leave();
}

function updateStartFrom(id: number, from: number): void {
  if ((T.d[(from << 5) + F_S_OFF] | 0) < (T.d[(id << 5) + F_S_OFF] | 0)) copyStart(id, from);
}

function updateEndFrom(id: number, from: number): void {
  if ((T.d[(from << 5) + F_E_OFF] | 0) > (T.d[(id << 5) + F_E_OFF] | 0)) copyEnd(id, from);
}

// ---------------------------------------------------------------------------------------------- `parse`

function growTable(need: number): void {
  if (need <= tabComment.length) return;
  let cap = tabComment.length;
  while (cap < need) cap = cap * 2;
  tabComment = new Int32Array(cap);
  tabLeading = new Int32Array(cap);
  tabTrailing = new Int32Array(cap);
  tabNode = new Int32Array(cap);
  tabLeadingCol = new Int32Array(cap);
  tabTrailingCol = new Int32Array(cap);
  tabNodeCol = new Int32Array(cap);
  nextLeading = new Int32Array(cap);
}

/** `parse` of `yaml-unist-parser`: makes the tree `T` (root `T.root`) of `src` (the text as it is) from the documents and
 * the tokens that `yamlParseAsWritten` has made. Returns 0, or -1 with the refusal noted (`MSG_CANNOT_BE_FORMATTED` or
 * `MSG_MISPLACED_COMMENT`). */
export function build(src: Uint8Array, len: number): number {
  text = src;
  textLen = len;
  tkKind = yamlTokenKinds();
  tkStart = yamlTokenStarts();
  tkEnd = yamlTokenEnds();
  const nTokens = yamlTokenCount();
  const nDocuments = yamlDocCount();
  tkCount = nTokens;
  at = 0;
  tagsLen = 0;
  // Where the lines start.
  if (lineStarts.length < len + 2) {
    lineStarts = new Int32Array(len + 64);
    lineNonAscii = new Uint8Array(len + 64);
  }
  let nLines = 1;
  lineStarts[0] = 0;
  let ascii = 0;
  let lineAcc = 0;
  for (let i = 0; i < len; i++) {
    const b = src[i] | 0;
    lineAcc = lineAcc | b;
    if (b === 10) {
      lineStarts[nLines] = (i + 1) | 0;
      lineNonAscii[nLines - 1] = (lineAcc >> 7) & 1;
      ascii = ascii | lineAcc;
      lineAcc = 0;
      nLines = nLines + 1;
    }
  }
  lineNonAscii[nLines - 1] = (lineAcc >> 7) & 1;
  ascii = ascii | lineAcc;
  nLineStarts = nLines;
  isAscii = (ascii & 0x80) === 0;
  lastLine = 0;
  lastLineStart = 0;
  lastLineNext = 0;
  lastPlace = 0;
  lastPlaceCol = 0;
  colLine = 0;
  comments.reset();
  pending.reset();
  hasProperties = false;
  propTop = 0;
  stack.reset();
  T.n = 0;
  T.root = -1;
  // A key, its `:` and its value are three tokens and five nodes.
  T.ensure(nTokens * 2 + 16);

  if (!transformDocuments(nDocuments)) {
    // What has been made last is next to what cannot be.
    const lastNode = T.n - 1;
    return noteRefusal(MSG_CANNOT_BE_FORMATTED, lastNode >= 0 ? T.d[(lastNode << 5) + F_S_OFF] | 0 : 0);
  }
  const root = newNodeAt(K_ROOT, 0, len);
  T.root = root;
  const nDocs = documentChildren.len;
  for (let i = 0; i < nDocs; i++) appendChild(root, documentChildren.data[i] | 0);
  const nComments = comments.len;
  if (sortKeys.length < T.n) sortKeys = new Int32Array(T.n + 64);
  for (let i = 0; i < nComments; i++) {
    const c = comments.data[i] | 0;
    sortKeys[c] = T.d[(c << 5) + F_S_OFF] | 0;
  }
  sortInt32ByKey(comments.data, 0, nComments, sortKeys);

  // `attachComments`, if there are comments to attach.
  let allAttached = true;
  for (let i = 0; i < nComments; i++) {
    if ((T.d[((comments.data[i] | 0) << 5) + F_PARENT] | 0) < 0) {
      allAttached = false;
      break;
    }
  }
  if (allAttached) {
    updatePositions(root, hasProperties || nComments > 0);
    return 0;
  }
  const lines = T.d[(root << 5) + F_E_LINE] | 0;
  growTable(lines + 2);
  tabLen = lines;
  for (let i = 0; i < lines; i++) {
    tabComment[i] = -1;
    tabLeading[i] = -1;
    tabTrailing[i] = -1;
    tabNode[i] = -1;
  }
  for (let i = 0; i < nComments; i++) {
    const comment = comments.data[i] | 0;
    const l = (T.d[(comment << 5) + F_S_LINE] | 0) - 1;
    if (l >= 0 && l < lines) tabComment[l] = comment;
  }
  initNodeTable(root);
  for (let index = lines - 1; index >= 0; index--) {
    if ((tabLeading[index] | 0) >= 0) nextLeading[index] = index;
    else nextLeading[index] = index + 1 < lines ? nextLeading[index + 1] | 0 : MAX;
  }
  let restDocuments = 0;
  for (let i = 0; i < nComments; i++) {
    const comment = comments.data[i] | 0;
    if ((T.d[(comment << 5) + F_PARENT] | 0) >= 0) continue;
    while (restDocuments + 1 < nDocs && (T.d[(comment << 5) + F_S_LINE] | 0) > (T.d[((documentChildren.data[restDocuments] | 0) << 5) + F_E_LINE] | 0)) {
      restDocuments = restDocuments + 1;
    }
    if (restDocuments >= nDocs || !attachComment(comment, documentChildren.data[restDocuments] | 0)) {
      return noteRefusal(MSG_MISPLACED_COMMENT, T.d[(comment << 5) + F_S_OFF] | 0);
    }
  }
  updatePositions(root, true);
  return 0;
}

/** Whether the text of the tree is all ASCII. */
export function treeIsAscii(): boolean {
  return isAscii;
}

/** Whether the tree was refused because the stack ran out. */
export function treeRanOut(): boolean {
  return stack.ranOut();
}

