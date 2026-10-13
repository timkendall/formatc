// Port of vendor/bun/src/format/css/media_query.rs: `postcss-media-query-parser` 0.2.3 (`dist/parsers.js`), and
// Prettier's `parse/parse-media-query.js`.
//
// The result is a tree in the arena `MediaTree`: a node has a kind, its text `[vs, ve)` (a range of the text that was
// parsed) and, if it is a container (`nodes: Some`), a list of children (`first`, `next`).
import { jsWhitespaceLen, startsWithWhiteSpace, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import { eqLit, startsWithLitIgnoreCase } from "./misc.ts";

export const MK_QUERY_LIST = 0;
export const MK_QUERY = 1;
export const MK_TYPE = 2;
export const MK_FEATURE_EXPRESSION = 3;
export const MK_FEATURE = 4;
export const MK_COLON = 5;
export const MK_VALUE = 6;
export const MK_KEYWORD = 7;
export const MK_URL = 8;
/** It has no type, which Prettier calls `media-unknown`. */
export const MK_UNKNOWN = 9;

export class MediaTree {
  kind: Uint8Array;
  vs: Int32Array;
  ve: Int32Array;
  first: Int32Array;
  last: Int32Array;
  next: Int32Array;
  // 1: it is a container (`nodes: Some`)
  isContainer: Uint8Array;
  // The kind of the node before the kinds are all decided; -1: none yet.
  pending: Int32Array;
  n: number;
  childCount: Int32Array;

  constructor() {
    this.kind = new Uint8Array(32);
    this.vs = new Int32Array(32);
    this.ve = new Int32Array(32);
    this.first = new Int32Array(32);
    this.last = new Int32Array(32);
    this.next = new Int32Array(32);
    this.isContainer = new Uint8Array(32);
    this.pending = new Int32Array(32);
    this.childCount = new Int32Array(32);
    this.n = 1; // 0: none
  }

  clear(): void {
    this.n = 1;
  }

  private grow(): void {
    const cap = this.kind.length * 2;
    const k = new Uint8Array(cap);
    k.set(this.kind);
    this.kind = k;
    const vs = new Int32Array(cap);
    vs.set(this.vs);
    this.vs = vs;
    const ve = new Int32Array(cap);
    ve.set(this.ve);
    this.ve = ve;
    const f = new Int32Array(cap);
    f.set(this.first);
    this.first = f;
    const l = new Int32Array(cap);
    l.set(this.last);
    this.last = l;
    const nx = new Int32Array(cap);
    nx.set(this.next);
    this.next = nx;
    const c = new Uint8Array(cap);
    c.set(this.isContainer);
    this.isContainer = c;
    const p = new Int32Array(cap);
    p.set(this.pending);
    this.pending = p;
    const cc = new Int32Array(cap);
    cc.set(this.childCount);
    this.childCount = cc;
  }

  newNode(kind: number, vs: number, ve: number, container: boolean): number {
    if (this.n === this.kind.length) this.grow();
    const id = this.n;
    this.n = id + 1;
    this.kind[id] = kind | 0;
    this.vs[id] = vs | 0;
    this.ve[id] = ve | 0;
    this.first[id] = 0;
    this.last[id] = 0;
    this.next[id] = 0;
    this.isContainer[id] = container ? 1 : 0;
    this.pending[id] = -1;
    this.childCount[id] = 0;
    return id;
  }

  append(parent: number, child: number): void {
    const last = this.last[parent] | 0;
    if (last === 0) this.first[parent] = child;
    else this.next[last] = child;
    this.last[parent] = child;
    this.childCount[parent] = (this.childCount[parent] | 0) + 1;
  }
}

export const mediaTree: MediaTree = new MediaTree();

// Modes of `parse_media_feature`
const MODE_NORMAL = 0;
const MODE_INTERPOLATION = 1;
// 2 + quote: a string

let modes = new Int32Array(16);
let nModes = 0;
function pushMode(m: number): void {
  if (nModes === modes.length) {
    const n = new Int32Array(nModes * 2);
    n.set(modes);
    modes = n;
  }
  modes[nModes] = m | 0;
  nModes = nModes + 1;
}

// Appends the nodes of the feature `string[s, e)` to `parent`. Returns false on error.
function parseMediaFeature(t: MediaTree, text: Uint8Array, s: number, e: number, parent: number): boolean {
  nModes = 0;
  pushMode(MODE_NORMAL);
  let ns = s;
  let ne = e;
  // `[b'(', inner @ .., b')']`
  if (e - s >= 2 && (text[s] | 0) === 40 && (text[e - 1] | 0) === 41) {
    ns = s + 1;
    ne = e - 1;
  }
  let featureEnd = ne;
  let hasValue = false;
  let valueStart = 0;
  for (let i = ns; i < ne; i++) {
    const character = text[i] | 0;
    if (character === 39 || character === 34) {
      if (nModes === 0) return false;
      const top = modes[nModes - 1] | 0;
      if (top === MODE_INTERPOLATION) {
        pushMode(2 + character);
      } else if (top >= 2 && top - 2 === character && (i === ns || (text[i - 1] | 0) !== 92)) {
        nModes = nModes - 1;
      }
    }
    if (character === 123) {
      pushMode(MODE_INTERPOLATION);
    } else if (character === 125) {
      if (nModes > 0) nModes = nModes - 1;
    }
    if (nModes === 0) return false;
    if ((modes[nModes - 1] | 0) === MODE_NORMAL && character === 58) {
      featureEnd = i;
      hasValue = true;
      valueStart = i + 1;
      break;
    }
  }
  // the feature
  const fs = trimJsWhitespaceStart(text, ns, featureEnd);
  const fe = trimJsWhitespaceEnd(text, fs, featureEnd);
  t.append(parent, t.newNode(MK_FEATURE, fs, fe, false));
  if (hasValue) {
    t.append(parent, t.newNode(MK_COLON, 0, 0, false));
    const vs = trimJsWhitespaceStart(text, valueStart, ne);
    const ve = trimJsWhitespaceEnd(text, vs, ne);
    t.append(parent, t.newNode(MK_VALUE, vs, ve, false));
  }
  return true;
}

const COLON_TEXT = 58;

// Appends the nodes of the query `string[s, e)` to `parent`. Returns false on error.
function parseMediaQuery(t: MediaTree, text: Uint8Array, s: number, e: number, parent: number): boolean {
  let localLevel = 0;
  let elementStart = -1;
  let elementIsExpression = false;
  const firstNode = t.n;
  let skip = 0;
  for (let i = s; i < e; i++) {
    const character = text[i] | 0;
    if (skip > 0) {
      skip = skip - 1;
      continue;
    }
    if (elementStart < 0) {
      const len = jsWhitespaceLen(text, i, e);
      if (len >= 1) {
        skip = len - 1;
        continue;
      }
      if (character === 40) localLevel = localLevel + 1;
      elementStart = i;
      elementIsExpression = character === 40;
    } else {
      if (character === 123 || character === 40) localLevel = localLevel + 1;
      if (character === 41 || character === 125) localLevel = localLevel - 1;
    }
    if (
      elementStart >= 0 && localLevel === 0 &&
      (character === 41 || i + 1 === e || startsWithWhiteSpace(text, i + 1, e))
    ) {
      const vs = elementStart;
      const ve = i + 1;
      let kind = elementIsExpression ? MK_FEATURE_EXPRESSION : -1;
      if (eqLit(text, vs, ve, "not") || eqLit(text, vs, ve, "only") || eqLit(text, vs, ve, "and")) kind = MK_KEYWORD;
      const isContainer = kind === MK_FEATURE_EXPRESSION;
      const node = t.newNode(MK_UNKNOWN, vs, ve, isContainer);
      t.pending[node] = kind;
      if (isContainer) {
        if (!parseMediaFeature(t, text, vs, ve, node)) return false;
      }
      t.append(parent, node);
      elementStart = -1;
    }
  }
  // The kinds of what has none yet. The nodes are the children of `parent`, from `firstOfQuery`.
  const count = t.childCount[parent] | 0;
  if (count > 0) {
    // collect the ids of the query nodes in order
    const ids: number[] = [];
    let c = t.first[parent] | 0;
    while (c !== 0) {
      ids.push(c);
      c = t.next[c] | 0;
    }
    void firstNode;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] | 0;
      if ((t.pending[id] | 0) >= 0) continue;
      if (i > 0) {
        const prev = ids[i - 1] | 0;
        const previousKind = t.pending[prev] | 0;
        const pvs = t.vs[prev] | 0;
        const pve = t.ve[prev] | 0;
        if (previousKind === MK_FEATURE_EXPRESSION) {
          t.pending[id] = MK_KEYWORD;
        } else if (eqLit(text, pvs, pve, "not") || eqLit(text, pvs, pve, "only")) {
          t.pending[id] = MK_TYPE;
        } else if (eqLit(text, pvs, pve, "and")) {
          t.pending[id] = MK_FEATURE_EXPRESSION;
        } else if (previousKind === MK_TYPE) {
          if (i + 1 >= ids.length) t.pending[id] = MK_FEATURE_EXPRESSION;
          else if ((t.pending[ids[i + 1] | 0] | 0) === MK_FEATURE_EXPRESSION) t.pending[id] = MK_KEYWORD;
          else t.pending[id] = MK_FEATURE_EXPRESSION;
        }
        continue;
      }
      const k1 = ids.length > 1 ? t.pending[ids[1] | 0] | 0 : -1;
      const k2 = ids.length > 2 ? t.pending[ids[2] | 0] | 0 : -1;
      const k3 = ids.length > 3 ? t.pending[ids[3] | 0] | 0 : -1;
      if (ids.length === 1 || k1 === MK_FEATURE_EXPRESSION || k1 === MK_KEYWORD) {
        t.pending[ids[0] | 0] = MK_TYPE;
      } else if (k2 === MK_FEATURE_EXPRESSION) {
        t.pending[ids[0] | 0] = MK_TYPE;
        t.pending[ids[1] | 0] = MK_KEYWORD;
      } else if (k2 === MK_KEYWORD) {
        t.pending[ids[0] | 0] = MK_KEYWORD;
        t.pending[ids[1] | 0] = MK_TYPE;
      } else if (k3 === MK_FEATURE_EXPRESSION) {
        t.pending[ids[0] | 0] = MK_KEYWORD;
        t.pending[ids[1] | 0] = MK_TYPE;
        t.pending[ids[2] | 0] = MK_KEYWORD;
      }
    }
    for (let i = 0; i < ids.length; i++) {
      const p = t.pending[ids[i] | 0] | 0;
      t.kind[ids[i] | 0] = p >= 0 ? p : MK_UNKNOWN;
    }
  }
  return true;
}

function mediaQuery(t: MediaTree, text: Uint8Array, s: number, e: number): number {
  const ts = trimJsWhitespaceStart(text, s, e);
  const te = trimJsWhitespaceEnd(text, ts, e);
  const node = t.newNode(MK_QUERY, ts, te, true);
  if (!parseMediaQuery(t, text, s, e, node)) return -1;
  return node;
}

/** Prettier's `parseMediaQuery` for `text[s, e)`: the id of the root in `mediaTree`, or -1 (an error stands for
 * `{ type: "selector-unknown", value: params }`). */
export function parseMedia(text: Uint8Array, s: number, e: number): number {
  const t = mediaTree;
  t.clear();
  const root = t.newNode(MK_QUERY_LIST, 0, 0, true);
  let interimIndex = s;
  let level = 0;

  // `/^(\s*)url\s*\(/`
  const afterSpaces = trimJsWhitespaceStart(text, s, e);
  if (startsWithLitIgnoreCase(text, afterSpaces, e, "url") && eqLit(text, afterSpaces, afterSpaces + 3, "url")) {
    const rest = trimJsWhitespaceStart(text, afterSpaces + 3, e);
    if (rest < e && (text[rest] | 0) === 40) {
      let i = rest + 1;
      let parentheses = 1;
      while (parentheses > 0) {
        if (i >= e) return -1;
        const c = text[i] | 0;
        if (c === 40) parentheses = parentheses + 1;
        else if (c === 41) parentheses = parentheses - 1;
        i = i + 1;
      }
      const us = trimJsWhitespaceStart(text, s, i);
      const ue = trimJsWhitespaceEnd(text, us, i);
      t.append(root, t.newNode(MK_URL, us, ue, false));
      interimIndex = i;
    }
  }

  for (let i = interimIndex; i < e; i++) {
    const character = text[i] | 0;
    if (character === 40) {
      level = level + 1;
    } else if (character === 41) {
      level = level - 1;
    } else if (character === 44 && level === 0) {
      const q = mediaQuery(t, text, interimIndex, i);
      if (q < 0) return -1;
      t.append(root, q);
      interimIndex = i + 1;
    }
  }
  const q = mediaQuery(t, text, interimIndex, e);
  if (q < 0) return -1;
  t.append(root, q);
  const rs = trimJsWhitespaceStart(text, s, e);
  t.vs[root] = rs;
  t.ve[root] = trimJsWhitespaceEnd(text, rs, e);
  return root;
}

void COLON_TEXT;
