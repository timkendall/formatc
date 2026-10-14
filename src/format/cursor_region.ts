// Port of the part of vendor/bun/src/format/cursor.rs that the JavaScript formatter calls while it writes a document (`CursorRegion` and
// `enter_node` & co.). It is a leaf of the import graph on purpose (src/format/cursor.ts imports the formatter, which imports this).
import { Formatter } from "./ir/formatter.ts";
import { CURSOR_REGION_END, CURSOR_REGION_START } from "./ir/element.ts";
import { cxOf } from "./js/context.ts";
import { I32Vec } from "../sema/vec.ts";
import { NOWHERE } from "./cursor_region.consts.ts";
export { NOWHERE } from "./cursor_region.consts.ts";

/** Where a node is. */
export class Extent {
  start: number;
  end: number;
  /** Prettier has most statements end before their `;`. Here they are also written as what ends after it. */
  endWithSemicolon: number;
  constructor(start: number, end: number, endWithSemicolon: number) {
    this.start = start;
    this.end = end;
    this.endWithSemicolon = endWithSemicolon;
  }
  endsAt(end: number): boolean {
    return end === this.end || end === this.endWithSemicolon;
  }
}

/**
 * What tells, while the document is written, where the ends of the region are in it. Prettier's `callPluginPrintFunction` puts `cursor`
 * around what is printed for a node, within its comments.
 *
 * The nodes here are not those of ESTree, so what is compared is where they start and end. Of several that qualify, the printer takes
 * the innermost.
 */
export class CursorRegion {
  /** Everything that overlaps this is written on the paths that call `enter` and `exit`. */
  extentStart: number;
  extentEnd: number;
  /** The cursor is in this node. */
  node: Extent;
  /** The region starts where this node ends. */
  before: Extent;
  /** The region ends where this node starts. */
  after: Extent;
  /** The region starts where the children of the JSX element that starts there do. */
  startsWithChildrenOf: number;
  /** The region ends where the children of the JSX element that starts there do. */
  endsWithChildrenOf: number;
  /** The scopes (`enterScope` .. `leaveScope`) that are open while a region is active: pairs `(start, end)`. */
  scopes: I32Vec;

  constructor() {
    this.scopes = new I32Vec(16);
    this.extentStart = NOWHERE;
    this.extentEnd = NOWHERE;
    this.node = new Extent(NOWHERE, NOWHERE, NOWHERE);
    this.before = new Extent(NOWHERE, NOWHERE, NOWHERE);
    this.after = new Extent(NOWHERE, NOWHERE, NOWHERE);
    this.startsWithChildrenOf = NOWHERE;
    this.endsWithChildrenOf = NOWHERE;
  }

  /** No region. */
  clear(): void {
    this.scopes.len = 0;
    this.extentStart = NOWHERE;
    this.extentEnd = NOWHERE;
    this.node = new Extent(NOWHERE, NOWHERE, NOWHERE);
    this.before = new Extent(NOWHERE, NOWHERE, NOWHERE);
    this.after = new Extent(NOWHERE, NOWHERE, NOWHERE);
    this.startsWithChildrenOf = NOWHERE;
    this.endsWithChildrenOf = NOWHERE;
  }

  isActive(): boolean {
    return this.extentStart !== NOWHERE;
  }

  overlaps(start: number, end: number): boolean {
    return start <= this.extentEnd && this.extentStart <= end;
  }

  /** Before what is at `(start, end)` is written, after the comments that lead it. */
  enter(start: number, end: number, f: Formatter): void {
    if (start === this.node.start && this.node.endsAt(end)) f.cursor(CURSOR_REGION_START);
    if (start === this.after.start && end <= this.after.endWithSemicolon) f.cursor(CURSOR_REGION_END);
  }

  /** After what is at `(start, end)` is written, before the comments that trail it. */
  exit(start: number, end: number, f: Formatter): void {
    if (start === this.node.start && this.node.endsAt(end)) f.cursor(CURSOR_REGION_END);
    if (this.before.endsAt(end) && start >= this.before.start) f.cursor(CURSOR_REGION_START);
  }
}

/** What the writer needs from a node that writes a node of ESTree itself (Rust's `enter_node(span, f)`): call it before. */
export function enterNode(start: number, end: number, f: Formatter): void {
  const c = cxOf(f).cursor;
  if (c.isActive()) c.enter(start, end, f);
}

/** What has been written since the node at `(start, end)` is part of what Prettier prints for that node: the `;` after a member (Rust's `extend_node`). */
export function extendNode(start: number, end: number, f: Formatter): void {
  const c = cxOf(f).cursor;
  if (c.isActive()) c.exit(start, end, f);
}

/**
 * Rust's `around_node(span, f, |f| write)`: `aroundNodeBegin(start, end, f); write; aroundNodeEnd(start, end, f);`. For a node that is not written
 * by the `impl Format` of a handle: the body of an interface, the text of a template.
 */
export function aroundNodeBegin(start: number, end: number, f: Formatter): void {
  enterNode(start, end, f);
}
export function aroundNodeEnd(start: number, end: number, f: Formatter): void {
  extendNode(start, end, f);
}

/**
 * Rust's `around_jsx_children(element, in_group, f, |f| write)`: `aroundJsxChildrenBegin(element, inGroup, f); write; aroundJsxChildrenEnd(..)`.
 * `write` writes the children of the JSX element that starts at `element` on lines of their own. `inGroup`: they are only on lines of their
 * own if the group that this is in breaks.
 */
export function aroundJsxChildrenBegin(element: number, inGroup: boolean, f: Formatter): void {
  const c = cxOf(f).cursor;
  if (c.isActive() && c.startsWithChildrenOf === element) markJsx(CURSOR_REGION_START, inGroup, f);
}
export function aroundJsxChildrenEnd(element: number, inGroup: boolean, f: Formatter): void {
  const c = cxOf(f).cursor;
  if (c.isActive() && c.endsWithChildrenOf === element) markJsx(CURSOR_REGION_END, inGroup, f);
}
function markJsx(mark: number, inGroup: boolean, f: Formatter): void {
  if (inGroup) {
    f.startIfGroupBreaks();
    f.cursor(mark);
    f.endConditional();
  } else f.cursor(mark);
}
