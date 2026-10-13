// Port of vendor/bun/src/lint/ast/list.rs: lists of nodes.
//
// A Rust `List<'a, T>` is TWO numbers here: `(start, len)`, where `start` indexes `hir.ids` and the element `i` is the id
// `hir.ids[start + i]` (a Rust `List::run` / `Span` is the same thing in TS: every list goes through `hir.ids`). The accessors that
// return a list come as a pair `xxxStart(h)` / `xxxLen(h)`; the empty list is `(0, 0)`. Nothing is hidden from a list here
// (Rust leaves out the nodes synthesized from JSDoc comments, which this port never has).
//
//   for x in list.iter()      const s = fooStart(h), n = fooLen(h); for (let i = 0; i < n; i++) { const x = listAt(s, i); .. }
//   list.len() / is_empty()   n / n === 0
//   list.get(i)               i < n ? listAt(s, i) : -1
//   list.first() / last()     n > 0 ? listAt(s, 0) : -1      n > 0 ? listAt(s, n - 1) : -1
//   iter().rev()              for (let i = n - 1; i >= 0; i--)
//
// The lookups by position (`around`, `before`, `after`, `index_of_start`) are for lists whose elements are in source order and do
// not overlap; they take the KIND of the elements (`NK_*` of node.ts) because they need the span of an element.
import { hir } from "../../sema/hir.ts";
import { SP } from "../span.ts";
import { nodeOf, nodeStart, nodeEnd } from "./node.ts";
import { caseSpan } from "./stmt.ts";

/** The id of the element `i` of the list that starts at `start`. */
export function listAt(start: number, i: number): number {
  return hir.ids[(start + i) | 0] | 0;
}

/** How many elements start at or before `offset`. */
export function listCountUntil(kind: number, start: number, len: number, offset: number): number {
  let from = 0;
  let to = len;
  while (from < to) {
    const middle = from + ((to - from) >> 1);
    const s = nodeStart(nodeOf(kind, listAt(start, middle)));
    if (s <= offset) from = middle + 1;
    else to = middle;
  }
  return from;
}

/** `List::around`: the element that `offset` is in (its id), or -1. */
export function listAround(kind: number, start: number, len: number, offset: number): number {
  const c = listCountUntil(kind, start, len, offset);
  if (c === 0) return -1;
  const id = listAt(start, c - 1);
  return offset < nodeEnd(nodeOf(kind, id)) ? id : -1;
}

/** `List::around` for the cases of a `switch`. */
export function listAroundCase(start: number, len: number, offset: number): number {
  let from = 0;
  let to = len;
  while (from < to) {
    const middle = from + ((to - from) >> 1);
    const c = listAt(start, middle);
    caseSpan(c);
    if ((SP[0] | 0) <= offset) from = middle + 1;
    else to = middle;
  }
  if (from === 0) return -1;
  const id = listAt(start, from - 1);
  caseSpan(id);
  return offset < (SP[1] | 0) ? id : -1;
}

/** `List::index_of_start`: the index of the element that starts at `pos`, or -1. */
export function listIndexOfStart(kind: number, start: number, len: number, pos: number): number {
  const c = listCountUntil(kind, start, len, pos);
  if (c === 0) return -1;
  return nodeStart(nodeOf(kind, listAt(start, c - 1))) === pos ? c - 1 : -1;
}

/** `List::before`: the element before the one that starts at `pos` (its id), or -1. */
export function listBefore(kind: number, start: number, len: number, pos: number): number {
  const c = listCountUntil(kind, start, len, pos);
  return c >= 2 ? listAt(start, c - 2) : -1;
}

/** `List::after`: the element after the one that starts at `pos` (its id), or -1. */
export function listAfter(kind: number, start: number, len: number, pos: number): number {
  const c = listCountUntil(kind, start, len, pos);
  return c < len ? listAt(start, c) : -1;
}
