import { Slots4 } from "../base/slots.ts";
// Port of vendor/bun/src/lint/span.rs. A Rust `Span { start, end }` is NEVER an object here: it is a pair of Int32.
//
//   * A function that takes a `Span` takes `(start, end)`.
//   * A function that returns a `Span` returns nothing (or a boolean for `Option<Span>`) and writes `SP[0] = start`, `SP[1] = end`
//     (`SP_START`, `SP_END` are the indices). Read both right after the call, before calling anything else that returns a span:
//     `exprSpan(e); const s = SP[0] | 0, en = SP[1] | 0;`. Where only one end is needed, the handle modules also have
//     `<handle>Start(h)` / `<handle>End(h)`, which cost less.
//   * `Option<Span>`: `if (stmtSemicolon(s)) { SP[0], SP[1] }`; the boolean says whether there is one.
//
// The methods of `Span` are the arithmetic below, written out at the call sites (they are one operation each):
//   len()          end - start (never negative: use spanLen)     is_empty()   end <= start
//   to(other)      (start, other.end)                           between(o)   (end, o.start)
//   after(p, end)  (p.end, end)                                 before(s,n)  (s, n.start)
//   contains(o)    start <= o.start && o.end <= end             contains_offset(x)   start <= x && x < end
//   shrink(a, b)   (start + a, max(0, end - b))                 range()      start .. max(end, start)
export const SP = new Slots4();
export const SP_START: number = 0;
export const SP_END: number = 1;

/** `Span::len`: `end.saturating_sub(start)` */
export function spanLen(start: number, end: number): number {
  return end > start ? (end - start) | 0 : 0;
}

/** `Span::is_empty` */
export function spanIsEmpty(start: number, end: number): boolean {
  return end <= start;
}

/** Writes `(start, end)` into `SP`. */
export function setSpan(start: number, end: number): void {
  const SP$ = SP;
  SP$.s0 = start | 0;
  SP$.s1 = end | 0;
}

/** Writes `Span::shrink(start, end, a, b)` into `SP`. */
export function shrinkSpan(start: number, end: number, a: number, b: number): void {
  const SP$ = SP;
  SP$.s0 = (start + a) | 0;
  SP$.s1 = (end > b ? (end - b) | 0 : 0) | 0;
}

/** `Span::sort_key` is not ported: sorts of nodes by span are written where they are needed. */

/** `Position`: a line (from 1) and a column (from 0, UTF-16 code units). Computed by `fileLineAndColumn` in `lint/source.ts`. */
