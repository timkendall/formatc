// The state of the printer (Rust `Printer`), in a module of its own: the printer, `embed`, `vue` and `angular` import each other.
import { Stack } from "../../base/stack.ts";
import { HTree } from "./ast.ts";
import { HOptions } from "./hoptions.ts";
import { Writer, CURSOR_START, CURSOR_END } from "./writer.ts";

// `Target`
export const TG_NODE: number = 0;
/** An attribute or a comment in a start tag: the span `(a, b)`. */
export const TG_IN_START_TAG: number = 1;
/** The `init` of an `@let` declaration. */
export const TG_LET_INITIALIZER: number = 2;

// `Cursor`
export const CUR_NOWHERE: number = 0;
export const CUR_IN: number = 1;
export const CUR_BETWEEN: number = 2;

export class Cursor {
  kind: number = CUR_NOWHERE;
  /** `In(node)`. */
  inKind: number = 0;
  inA: number = 0;
  inB: number = 0;
  hasBefore: boolean = false;
  beforeKind: number = 0;
  beforeA: number = 0;
  beforeB: number = 0;
  hasAfter: boolean = false;
  afterKind: number = 0;
  afterA: number = 0;
  afterB: number = 0;
}

export class Printer {
  t: HTree;
  o: HOptions;
  w: Writer;
  /** How many nodes are around the one that is being printed. */
  ancestors: number;
  stack: Stack;
  isNestedTooDeeply: boolean;
  /** `isVueSfcWithTypescriptScript`, once it has been asked: -1 not yet, else 0 or 1. */
  hasTypescriptScript: number;
  /** oxfmt's `hasTsxScriptBlock`, once it has been asked. */
  hasTsxScript: number;
  cursor: Cursor;

  constructor(t: HTree, o: HOptions, w: Writer, cursor: Cursor) {
    this.t = t;
    this.o = o;
    this.w = w;
    this.ancestors = 0;
    this.stack = Stack.create();
    this.isNestedTooDeeply = false;
    this.hasTypescriptScript = -1;
    this.hasTsxScript = -1;
    this.cursor = cursor;
  }
}

function sameTarget(k1: number, a1: number, b1: number, k2: number, a2: number, b2: number): boolean {
  if (k1 !== k2) return false;
  if (k1 === TG_IN_START_TAG) return a1 === a2 && b1 === b2;
  return a1 === a2;
}

/**
 * Before `print` of the target: writes the marks that go before. Returns the marks that go after (bit 0: region start, bit 1: region end),
 * for `cursorMarksEnd`.
 */
export function cursorMarksBegin(p: Printer, kind: number, a: number, b: number): number {
  const c = p.cursor;
  if (c.kind === CUR_NOWHERE) return 0;
  let startsBefore = false;
  let startsAfter = false;
  let endsBefore = false;
  let endsAfter = false;
  if (c.kind === CUR_IN) {
    const same = sameTarget(c.inKind, c.inA, c.inB, kind, a, b);
    startsBefore = same;
    endsAfter = same;
  } else {
    startsAfter = c.hasBefore && sameTarget(c.beforeKind, c.beforeA, c.beforeB, kind, a, b);
    endsBefore = c.hasAfter && sameTarget(c.afterKind, c.afterA, c.afterB, kind, a, b);
  }
  if (startsBefore) p.w.cursorMark(CURSOR_START);
  if (endsBefore) p.w.cursorMark(CURSOR_END);
  return (startsAfter ? 1 : 0) | (endsAfter ? 2 : 0);
}

export function cursorMarksEnd(p: Printer, after: number): void {
  if ((after & 1) !== 0) p.w.cursorMark(CURSOR_START);
  if ((after & 2) !== 0) p.w.cursorMark(CURSOR_END);
}
