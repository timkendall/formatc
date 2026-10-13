// Port of vendor/bun/src/format/graphql/comments.rs: which node a comment belongs to. Prettier's `attachComments`
// (`src/main/comments/attach.js`), which has no special cases for GraphQL.
import { sortInt32ByKey } from "../sort.ts";
import { hasNewlineBackwards } from "../text.ts";
import { F_COMMENT, Tree } from "./parser.ts";

export const PLACE_LEADING: number = 0;
export const PLACE_TRAILING: number = 1;
// In a node that has nothing else in it.
export const PLACE_DANGLING: number = 2;

/** The attached comments: parallel arrays, sorted by node, and by position for the same node. */
export class Attached {
  count: number;
  /** The node. */
  node: Int32Array;
  /** The index in `Tree.cStart` / `cEnd`. */
  comment: Int32Array;
  place: Uint8Array;
  // Scratch for the sort.
  order: Int32Array;
  unsortedNode: Int32Array;
  unsortedComment: Int32Array;
  unsortedPlace: Uint8Array;
  // The nodes that the last comment is in, from the outside in.
  path: Int32Array;

  constructor() {
    this.count = 0;
    this.node = new Int32Array(16);
    this.comment = new Int32Array(16);
    this.place = new Uint8Array(16);
    this.order = new Int32Array(16);
    this.unsortedNode = new Int32Array(16);
    this.unsortedComment = new Int32Array(16);
    this.unsortedPlace = new Uint8Array(16);
    this.path = new Int32Array(64);
  }

  clear(): void {
    this.count = 0;
  }

  reserve(n: number): void {
    if (this.node.length >= n) return;
    let cap = this.node.length;
    while (cap < n) cap = cap * 2;
    this.node = new Int32Array(cap);
    this.comment = new Int32Array(cap);
    this.place = new Uint8Array(cap);
    this.order = new Int32Array(cap);
    this.unsortedNode = new Int32Array(cap);
    this.unsortedComment = new Int32Array(cap);
    this.unsortedPlace = new Uint8Array(cap);
  }

  growPath(): void {
    const p = new Int32Array(this.path.length * 2);
    p.set(this.path);
    this.path = p;
  }
}

/** Fills `att`. */
export function attach(text: Uint8Array, tree: Tree, att: Attached): void {
  att.clear();
  const total = tree.commentCount;
  if (total === 0) return;
  att.reserve(total);
  const cStart = tree.cStart;
  const cEnd = tree.cEnd;
  const nodes = tree.nodes;
  const children = tree.children;
  const root = tree.root();
  let path = att.path;
  path[0] = root | 0;
  let depth = 1;
  const uNode = att.unsortedNode;
  const uComment = att.unsortedComment;
  const uPlace = att.unsortedPlace;
  let sorted = true;
  let previousNode = -1;
  for (let index = 0; index < total; index++) {
    const cs = cStart[index] | 0;
    const ce = cEnd[index] | 0;
    // Prettier's `decorateComment`: the innermost node that the comment is in, and its children before and after the
    // comment. The comments are in the order of the text, so the way down to one starts at the innermost of the nodes that
    // the last one was in that it is in, not at the root.
    while (depth >= 2) {
      const last = path[depth - 1] | 0;
      if ((nodes[(last << 3) + 1] | 0) <= cs && ce <= (nodes[(last << 3) + 2] | 0)) break;
      depth = depth - 1;
    }
    let enclosing = path[depth - 1] | 0;
    let preceding = -1;
    let following = -1;
    while (true) {
      preceding = -1;
      following = -1;
      const base = nodes[(enclosing << 3) + 3] | 0;
      let left = 0;
      let right = nodes[(enclosing << 3) + 4] | 0;
      let descended = false;
      while (left < right) {
        const middle = left + ((right - left) >> 1);
        const child = children[base + middle] | 0;
        const s = nodes[(child << 3) + 1] | 0;
        const e = nodes[(child << 3) + 2] | 0;
        if (s <= cs && ce <= e) {
          enclosing = child;
          if (depth === path.length) {
            att.growPath();
            path = att.path;
          }
          path[depth] = child | 0;
          depth = depth + 1;
          descended = true;
          break;
        }
        if (e <= cs) {
          preceding = child;
          left = middle + 1;
        } else {
          following = child;
          right = middle;
        }
      }
      if (!descended) break;
    }

    let node = enclosing;
    let place = PLACE_DANGLING;
    if (hasNewlineBackwards(text, cs)) {
      if (following >= 0) {
        node = following;
        place = PLACE_LEADING;
      } else if (preceding >= 0) {
        node = preceding;
        place = PLACE_TRAILING;
      }
    } else {
      if (preceding >= 0) {
        node = preceding;
        place = PLACE_TRAILING;
      } else if (following >= 0) {
        node = following;
        place = PLACE_LEADING;
      }
    }
    // The node knows that it has comments: its printer looks them up only then.
    nodes[node << 3] = ((nodes[node << 3] | 0) | (F_COMMENT << 8)) | 0;
    uNode[index] = node | 0;
    uComment[index] = index | 0;
    uPlace[index] = place | 0;
    if (node < previousNode) sorted = false;
    previousNode = node;
  }
  att.count = total;
  const aNode = att.node;
  const aComment = att.comment;
  const aPlace = att.place;
  if (sorted) {
    for (let i = 0; i < total; i++) {
      aNode[i] = uNode[i] | 0;
      aComment[i] = uComment[i] | 0;
      aPlace[i] = uPlace[i] | 0;
    }
    return;
  }
  // Sorted by node, and for the same node by comment: the sort is stable and the comments are in order.
  const order = att.order;
  for (let i = 0; i < total; i++) order[i] = i | 0;
  sortInt32ByKey(order, 0, total, uNode);
  for (let i = 0; i < total; i++) {
    const o = order[i] | 0;
    aNode[i] = uNode[o] | 0;
    aComment[i] = uComment[o] | 0;
    aPlace[i] = uPlace[o] | 0;
  }
}
