// Port of vendor/bun/src/format/html/cursor.rs: `cursorOffset`: Prettier's `main/get-cursor-node.js` on the tree of HTML, and the marks that
// `main/ast-to-doc.js` puts around what the nodes next to the cursor are printed as.
import { I32Vec } from "../../base/i32vec.ts";
import { Region } from "../cursor.ts";
import {
  A_STRIDE,
  AF_SPAN_E,
  AF_SPAN_S,
  F_ATTR_E,
  F_ATTR_S,
  F_NSP_E,
  F_NSP_S,
  F_SPAN_E,
  F_SPAN_S,
  F_TC_E,
  F_TC_S,
  HTree,
  K_ANGULAR_LET_DECLARATION,
  K_ELEMENT,
  TC_STRIDE,
  TCF_SPAN_E,
  TCF_SPAN_S,
  firstChild,
  kindOf,
  nGet,
  nextOf,
  parametersOf,
} from "./ast.ts";
import { CUR_BETWEEN, CUR_IN, Cursor, TG_IN_START_TAG, TG_LET_INITIALIZER, TG_NODE } from "./pstate.ts";

/** The span of the target `(kind, a, b)`: `SPAN_S`, `SPAN_E`. */
let spanS = 0;
let spanE = 0;
function spanOf(t: HTree, kind: number, a: number, b: number): void {
  if (kind === TG_NODE) {
    spanS = nGet(t, a, F_SPAN_S);
    spanE = nGet(t, a, F_SPAN_E);
  } else if (kind === TG_IN_START_TAG) {
    spanS = a;
    spanE = b;
  } else {
    spanS = nGet(t, a, F_NSP_S);
    spanE = nGet(t, a, F_NSP_E);
  }
}

/** `getChildren`, in the order of the visitor keys: pushes the targets (kind, a, b) of the children of the target onto `out`. */
function childrenOf(t: HTree, kind: number, a: number, out: I32Vec): void {
  out.reset();
  if (kind !== TG_NODE) return;
  const k = kindOf(t, a);
  if (k === K_ELEMENT) {
    for (let at = nGet(t, a, F_ATTR_S); at < nGet(t, a, F_ATTR_E); at++) {
      out.push(TG_IN_START_TAG);
      out.push(t.a[at * A_STRIDE + AF_SPAN_S] | 0);
      out.push(t.a[at * A_STRIDE + AF_SPAN_E] | 0);
    }
    for (let c = nGet(t, a, F_TC_S); c < nGet(t, a, F_TC_E); c++) {
      out.push(TG_IN_START_TAG);
      out.push(t.c[c * TC_STRIDE + TCF_SPAN_S] | 0);
      out.push(t.c[c * TC_STRIDE + TCF_SPAN_E] | 0);
    }
  } else if (k === K_ANGULAR_LET_DECLARATION) {
    out.push(TG_LET_INITIALIZER);
    out.push(a);
    out.push(0);
  }
  for (let c = firstChild(t, a); c >= 0; c = nextOf(t, c)) {
    out.push(TG_NODE);
    out.push(c);
    out.push(0);
  }
  const p = parametersOf(t, a);
  if (p >= 0) {
    out.push(TG_NODE);
    out.push(p);
    out.push(0);
  }
}

/** `getCursorLocation`. `t`: as it has been parsed. */
export function locate(t: HTree, offset: number): Cursor {
  const containing = new I32Vec(32);
  containing.push(TG_NODE);
  containing.push(t.root);
  containing.push(0);
  const kids = new I32Vec(32);
  let index = 0;
  while (index * 3 < containing.len) {
    childrenOf(t, containing.data[index * 3] | 0, containing.data[index * 3 + 1] | 0, kids);
    for (let i = 0; i < kids.len; i += 3) {
      spanOf(t, kids.data[i] | 0, kids.data[i + 1] | 0, kids.data[i + 2] | 0);
      if (spanS <= offset && offset <= spanE) {
        containing.push(kids.data[i] | 0);
        containing.push(kids.data[i + 1] | 0);
        containing.push(kids.data[i + 2] | 0);
      }
    }
    index = index + 1;
  }
  const cursor = new Cursor();
  if (containing.len > 0) {
    const k = containing.data[containing.len - 3] | 0;
    const a = containing.data[containing.len - 2] | 0;
    const b = containing.data[containing.len - 1] | 0;
    childrenOf(t, k, a, kids);
    if (kids.len === 0) {
      cursor.kind = CUR_IN;
      cursor.inKind = k;
      cursor.inA = a;
      cursor.inB = b;
      return cursor;
    }
  }
  cursor.kind = CUR_BETWEEN;
  let beforeS = 0;
  let beforeE = 0;
  let afterS = 0;
  let afterE = 0;
  while (containing.len > 0 && (!cursor.hasBefore || !cursor.hasAfter)) {
    const b = containing.pop();
    const a = containing.pop();
    const k = containing.pop();
    const hasBefore = cursor.hasBefore;
    const hasAfter = cursor.hasAfter;
    childrenOf(t, k, a, kids);
    for (let i = 0; i < kids.len; i += 3) {
      const ck = kids.data[i] | 0;
      const ca = kids.data[i + 1] | 0;
      const cb = kids.data[i + 2] | 0;
      spanOf(t, ck, ca, cb);
      const s = spanS;
      const e = spanE;
      if (!hasBefore && e <= offset && (!cursor.hasBefore || e > beforeE)) {
        cursor.hasBefore = true;
        cursor.beforeKind = ck;
        cursor.beforeA = ca;
        cursor.beforeB = cb;
        beforeS = s;
        beforeE = e;
      }
      if (!hasAfter && s >= offset && (!cursor.hasAfter || s < afterS)) {
        cursor.hasAfter = true;
        cursor.afterKind = ck;
        cursor.afterA = ca;
        cursor.afterB = cb;
        afterS = s;
        afterE = e;
      }
    }
  }
  void beforeS;
  void afterE;
  return cursor;
}

/** The part of the text that the marks are around. `t`: as it has been printed, since Prettier asks the nodes then. null: there is none. */
export function regionOf(t: HTree, c: Cursor): Region | null {
  if (c.kind === CUR_IN) {
    spanOf(t, c.inKind, c.inA, c.inB);
    const r = new Region();
    r.isNode = true;
    r.nodeStart = spanS;
    r.nodeEnd = spanE;
    return r;
  }
  if (c.kind !== CUR_BETWEEN) return null;
  const r = new Region();
  if (c.hasBefore) {
    spanOf(t, c.beforeKind, c.beforeA, c.beforeB);
    r.beforeStart = spanS;
    r.beforeEnd = spanE;
  }
  if (c.hasAfter) {
    spanOf(t, c.afterKind, c.afterA, c.afterB);
    r.afterStart = spanS;
    r.afterEnd = spanE;
  }
  return r;
}
