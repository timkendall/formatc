// Port of vendor/bun/src/format/json/comments.rs. Which node a comment belongs to. Prettier's `main/comments/attach.js`,
// with the two of the handlers of `language-js/comments/handle-comments.js` that have a say in JSON.
//
// `attached` is an Int32Array with 4 ints per entry: owner, comment (index), placement, (unused); sorted by owner, and for
// one owner by comment.
import { jsWhitespaceLen, hasNewline, hasNewlineBackwards } from "../text.ts";
import { sortInt32By } from "../sort.ts";
import {
  C_BLOCK,
  C_END,
  C_ENCLOSING,
  C_FOLLOWING,
  C_PRECEDING,
  C_START,
  N_START,
  OWNER_NONE,
  ownerIndex,
  ownerIsProperty,
  Tree,
} from "./parser.ts";
import { isTypeCastText } from "./util.ts";

export const P_LEADING = 0;
export const P_TRAILING = 1;
export const P_DANGLING = 2;

export const A_OWNER = 0;
export const A_COMMENT = 1;
export const A_PLACEMENT = 2;

export class Attached {
  /** 4 ints per entry. */
  data: Int32Array = new Int32Array(4 * 16);
  count: number = 0;
  /** The order of the entries by (owner, comment), after `attach`. */
  order: Int32Array = new Int32Array(16);
  sorted: Int32Array = new Int32Array(4 * 16);
  // The result of `find`.
  from: number = 0;
  to: number = 0;

  push(owner: number, comment: number, placement: number): void {
    const b = this.count << 2;
    if (b + 4 > this.data.length) {
      const nd = new Int32Array(this.data.length * 2);
      nd.set(this.data);
      this.data = nd;
    }
    this.data[b] = owner | 0;
    this.data[b + 1] = comment | 0;
    this.data[b + 2] = placement | 0;
    this.count = this.count + 1;
  }

  /** The entries of `owner` are `from .. to` of `sorted`. */
  find(owner: number): void {
    const s = this.sorted;
    const n = this.count;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((s[mid << 2] | 0) < owner) lo = mid + 1;
      else hi = mid;
    }
    this.from = lo;
    hi = n;
    let e = lo;
    while (e < hi && (s[e << 2] | 0) === owner) e = e + 1;
    this.to = e;
  }
}

/** The attachments of this thread. */
export const attached = new Attached();

let sortKeys = attached.data;
function compareAttached(x: number, y: number): number {
  const ox = sortKeys[x << 2] | 0;
  const oy = sortKeys[y << 2] | 0;
  if (ox !== oy) return ox < oy ? -1 : 1;
  const cx = sortKeys[(x << 2) + 1] | 0;
  const cy = sortKeys[(y << 2) + 1] | 0;
  return cx < cy ? -1 : cx > cy ? 1 : 0;
}

/** `/^[\s(]*$/` */
function isGap(text: Uint8Array, start: number, end: number): boolean {
  let at = start;
  while (at < end) {
    const b = text[at] | 0;
    if (b === 40) {
      at = at + 1;
      continue;
    }
    const len = jsWhitespaceLen(text, at, end);
    if (len === 0) return false;
    at = at + len;
  }
  return true;
}

/** `!/[\S\n  ]/`: white space without a line break. */
function isBlankWithoutLineBreak(text: Uint8Array, start: number, end: number): boolean {
  if (start > end) return true;
  let at = start;
  while (at < end) {
    const b = text[at] | 0;
    if (b === 40 || b === 10) return false;
    const len = jsWhitespaceLen(text, at, end);
    if (len === 0) return false;
    if (len === 3 && b === 0xe2 && (text[at + 1] | 0) === 0x80 && ((text[at + 2] | 0) === 0xa8 || (text[at + 2] | 0) === 0xa9)) return false;
    at = at + len;
  }
  return true;
}

/** A JSDoc comment with `@type` or `@satisfies`: Prettier's `isTypeCastComment`. */
function isTypeCastComment(text: Uint8Array, start: number, end: number): boolean {
  return end - start >= 3 && (text[start] | 0) === 47 && (text[start + 1] | 0) === 42 && (text[start + 2] | 0) === 42 && isTypeCastText(text, start, end);
}

// Comments with text before and after them on their line, between the same two nodes.
let tiesFirst = 0;
let tiesCount = 0;

/** Prettier's `breakTies`: those that only have white space between them and the node after them lead it, the others trail the node before them. */
function breakTies(text: Uint8Array, tree: Tree): void {
  const count = tiesCount;
  const first = tiesFirst;
  tiesCount = 0;
  if (count === 0) return;
  const cm = tree.comments;
  const nodes = tree.nodes;
  const following = cm[(first << 3) + C_FOLLOWING] | 0;
  const fi = ownerIndex(following);
  let gapEnd = fi < tree.nodeCount && following !== OWNER_NONE ? nodes[(fi << 3) + N_START] | 0 : 0;
  let leadingFrom = count;
  while (leadingFrom > 0) {
    const c = first + leadingFrom - 1;
    const cEnd = cm[(c << 3) + C_END] | 0;
    if (!isGap(text, cEnd, gapEnd)) break;
    gapEnd = cm[(c << 3) + C_START] | 0;
    leadingFrom = leadingFrom - 1;
  }
  for (let index = 0; index < count; index++) {
    const c = first + index;
    if (index < leadingFrom) attached.push(cm[(c << 3) + C_PRECEDING] | 0, c, P_TRAILING);
    else attached.push(cm[(c << 3) + C_FOLLOWING] | 0, c, P_LEADING);
  }
}

/** Fills `attached`, which ends up sorted by owner, and for one owner by position. */
export function attach(text: Uint8Array, tree: Tree): void {
  attached.count = 0;
  const cm = tree.comments;
  const total = tree.commentCount;
  tiesFirst = 0;
  tiesCount = 0;

  // Of the comments next to each other on a line that the comment at hand is one of: where the first starts, and the
  // index of the last and where it ends.
  let start = 0;
  let lastIndex = -1;
  let lastEnd = 0;
  for (let index = 0; index < total; index++) {
    const b = index << 3;
    const cStart = cm[b + C_START] | 0;
    const cEnd = cm[b + C_END] | 0;
    const isBlock = (cm[b + C_BLOCK] | 0) !== 0;
    const enclosing = cm[b + C_ENCLOSING] | 0;
    const preceding = cm[b + C_PRECEDING] | 0;
    const following = cm[b + C_FOLLOWING] | 0;

    const followsAnother =
      preceding !== OWNER_NONE &&
      index > 0 &&
      (cm[((index - 1) << 3) + C_PRECEDING] | 0) === preceding &&
      isBlankWithoutLineBreak(text, cm[((index - 1) << 3) + C_END] | 0, cStart);
    if (!followsAnother) start = cStart;
    let end: number;
    if (lastIndex >= 0 && index <= lastIndex) {
      end = lastEnd;
    } else {
      let li = index;
      end = cEnd;
      if (following !== OWNER_NONE) {
        for (let k = index + 1; k < total; k++) {
          const ob = k << 3;
          if ((cm[ob + C_FOLLOWING] | 0) !== following || !isBlankWithoutLineBreak(text, end, cm[ob + C_START] | 0)) break;
          li = li + 1;
          end = cm[ob + C_END] | 0;
        }
      }
      lastIndex = li;
      lastEnd = end;
    }

    let firstOwner: number;
    let firstPlacement: number;
    let secondOwner: number;
    let secondPlacement: number;
    if (hasNewlineBackwards(text, start)) {
      // On a line of its own
      firstOwner = following;
      firstPlacement = P_LEADING;
      secondOwner = preceding;
      secondPlacement = P_TRAILING;
    } else if (hasNewline(text, end)) {
      // At the end of a line
      if (following !== OWNER_NONE && isBlock && isTypeCastComment(text, cStart, cEnd)) {
        firstOwner = following;
        firstPlacement = P_LEADING;
        secondOwner = following;
        secondPlacement = P_LEADING;
      } else if (ownerIsProperty(enclosing)) {
        // Prettier's `handlePropertyComments`
        firstOwner = enclosing;
        firstPlacement = P_LEADING;
        secondOwner = enclosing;
        secondPlacement = P_LEADING;
      } else {
        firstOwner = preceding;
        firstPlacement = P_TRAILING;
        secondOwner = following;
        secondPlacement = P_LEADING;
      }
    } else if (preceding !== OWNER_NONE && following !== OWNER_NONE) {
      if (tiesCount > 0 && (cm[(tiesFirst << 3) + C_FOLLOWING] | 0) !== following) breakTies(text, tree);
      if (tiesCount === 0) tiesFirst = index;
      // Between two comments that are tied there can be one that is not.
      if (tiesFirst + tiesCount !== index) {
        breakTies(text, tree);
        tiesFirst = index;
      }
      tiesCount = tiesCount + 1;
      continue;
    } else {
      firstOwner = preceding;
      firstPlacement = P_TRAILING;
      secondOwner = following;
      secondPlacement = P_LEADING;
    }
    if (firstOwner !== OWNER_NONE) attached.push(firstOwner, index, firstPlacement);
    else if (secondOwner !== OWNER_NONE) attached.push(secondOwner, index, secondPlacement);
    else attached.push(enclosing, index, P_DANGLING);
  }
  breakTies(text, tree);

  // Sort by (owner, comment).
  const n = attached.count;
  if (attached.order.length < n) attached.order = new Int32Array(n * 2);
  const order = attached.order;
  for (let i = 0; i < n; i++) order[i] = i | 0;
  sortKeys = attached.data;
  sortInt32By(order, 0, n, compareAttached);
  if (attached.sorted.length < n * 4) attached.sorted = new Int32Array(n * 8);
  const sorted = attached.sorted;
  const data = attached.data;
  for (let i = 0; i < n; i++) {
    const s = (order[i] | 0) << 2;
    const d = i << 2;
    sorted[d] = data[s] | 0;
    sorted[d + 1] = data[s + 1] | 0;
    sorted[d + 2] = data[s + 2] | 0;
  }
}
