// Port of vendor/bun/src/format/js/context.rs: what the code that formats a file can see besides the node it is formatting.
//
// `JsFormatContext extends FormatContext` (src/format/ir/context.ts) is the object that `Formatter.context` holds for a JavaScript
// document. There is ONE per thread, reused for every file (`reset`). Get it with `cxOf(f)` (a checked class cast; do it once per
// function, not per use):
//
//     const cx = cxOf(f);
//     if (cx.isQuiet) ...            // Rust f.is_quiet()
//     cx.comments.nextStart()        // Rust f.comments().next_start()
//     cx.src.byteAt(i)               // Rust f.source_text().byte_at(i)
//     cx.options.flavor              // Rust f.options().flavor
//
// The stack (Rust `f.context_mut().has_stack_left()`) is `f.stack`: `if (!f.stack.enter()) return; ...; f.stack.leave();`.
import { FormatContext } from "../ir/context.ts";
import { Formatter } from "../ir/formatter.ts";
import { FormatOptions, HTML_ROOT_NONE, HTML_ROOT_PROGRAM } from "../options.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { fileIsJavascript } from "../../lint/ast/index.ts";
import { Comments } from "./comments.ts";
import { SourceText } from "./source_text.ts";
import type { CursorRegion } from "../cursor_region.ts";

// `TailwindContext` (utils/tailwindcss.rs) as a packed int, for the stack of contexts. The porter of tailwindcss.ts owns the meaning of
// the bits; they are here so that `JsFormatContext` can keep the stack.
export const TWC_PRESERVES_WHITESPACE: number = 1 << 0;
export const TWC_IS_IN_TEMPLATE_EXPRESSION: number = 1 << 1;
export const TWC_HAS_WHITESPACE_BEFORE: number = 1 << 2;
export const TWC_HAS_WHITESPACE_BEHIND: number = 1 << 3;
export const TWC_AROUND_TEMPLATE_START: number = 1 << 4;
export const TWC_AROUND_TEMPLATE_END: number = 1 << 5;
export const TWC_IS_DISABLED: number = 1 << 6;
export const TWC_FOLLOWS_PLUGIN: number = 1 << 7;
export const TWC_SORTS_TEMPLATE: number = 1 << 8;

/** The cursor of `cursorOffset` (cursor.rs). TODO(port): not ported; a region is never active. */
export const CURSOR_NONE_ACTIVE: boolean = false;

export class JsFormatContext extends FormatContext {
  /**
   * Whether Prettier reads the code with a parser that has no `ChainExpression` around an optional chain: Babel, which reads JavaScript
   * and every expression in HTML, in TypeScript too, or `angular-estree-parser`.
   */
  hasTreeOfBabel: boolean;
  comments: Comments;
  /** The text of the file (exactly the source), and questions about it. */
  src: SourceText;
  /** See `isQuietOf`. */
  isQuiet: boolean;
  /** The region of `cursorOffset` (cursor.ts); `cursor.isActive()` is false without one. */
  cursor: CursorRegion;
  /** The formatter that writes the document (set by `formatDocument`): `enterScope` writes the marks of the cursor to it. */
  formatter: Formatter | null;
  /**
   * What has been formatted ahead of its turn, by the span of the node: an argument that was formatted to decide on the layout of the
   * call. A node whose span is here is not formatted again, which would print its comments twice. Key: `cacheKey(start, end)`;
   * value: an IR capture handle.
   */
  cachedElements: Map<number, number>;
  /** With `quoteProps: "consistent"`, whether the properties of the enclosing objects are quoted. */
  quoteNeededStack: I32Vec;
  /** See `utils/tailwindcss.rs`. The last is the one that counts. Packed ints (`TWC_*`). */
  tailwindContexts: I32Vec;
  /** The last member access with many member accesses around it (an ExprId, -1: none), and whether it stays on the line of its object. */
  longMemberChainExpr: number;
  longMemberChainValue: boolean;
  /** An offset, and where its line starts. */
  lineStartOffset: number;
  lineStartValue: number;
  /** Whether the `a | b` that is being written is a value and a filter of Vue. */
  isVueFilterSequence: boolean;

  constructor(options: FormatOptions, noCursor: CursorRegion) {
    super(options);
    this.hasTreeOfBabel = false;
    this.comments = new Comments();
    this.src = new SourceText(new Uint8Array(0));
    this.isQuiet = false;
    this.cursor = noCursor;
    this.formatter = null;
    this.cachedElements = new Map<number, number>();
    this.quoteNeededStack = new I32Vec(8);
    this.tailwindContexts = new I32Vec(8);
    this.longMemberChainExpr = -1;
    this.longMemberChainValue = false;
    this.lineStartOffset = 0;
    this.lineStartValue = 0;
    this.isVueFilterSequence = false;
  }

  /**
   * Starts a file: `text` is the source (exactly), `comments` has been filled (collectComments). Rust `JsFormatContext::new` with a
   * file.
   */
  reset(options: FormatOptions, text: Uint8Array, cursor: CursorRegion): void {
    this.options = options;
    this.ranOutOfStack = false;
    const root = options.inHtml.root;
    this.hasTreeOfBabel = fileIsJavascript() || (root !== HTML_ROOT_NONE && root !== HTML_ROOT_PROGRAM);
    this.src = new SourceText(text);
    this.isQuiet = false;
    this.cursor = cursor;
    if (this.cachedElements.size > 0) this.cachedElements.clear();
    this.quoteNeededStack.reset();
    this.tailwindContexts.reset();
    this.longMemberChainExpr = -1;
    this.longMemberChainValue = false;
    this.lineStartOffset = 0;
    this.lineStartValue = 0;
    this.isVueFilterSequence = false;
  }

  hasCachedElements(): boolean {
    return this.cachedElements.size > 0;
  }

  /** The capture handle of what was formatted ahead of its turn for the node at `(start, end)`, or -1. */
  getCachedElement(start: number, end: number): number {
    const v = this.cachedElements.get(start * 134217728 + end);
    return v === undefined ? -1 : v;
  }

  cacheElement(start: number, end: number, handle: number): void {
    this.cachedElements.set(start * 134217728 + end, handle);
  }

  pushQuoteNeeded(needed: boolean): void {
    this.quoteNeededStack.push(needed ? 1 : 0);
  }
  popQuoteNeeded(): void {
    if (this.quoteNeededStack.len > 0) this.quoteNeededStack.pop();
  }
  isQuoteNeeded(): boolean {
    return this.quoteNeededStack.len > 0 && this.quoteNeededStack.last() !== 0;
  }

  pushTailwindContext(packed: number): void {
    this.tailwindContexts.push(packed);
  }
  popTailwindContext(): void {
    if (this.tailwindContexts.len > 0) this.tailwindContexts.pop();
  }
  /** The packed `TailwindContext` at the top, or -1. */
  tailwindContext(): number {
    return this.tailwindContexts.len > 0 ? this.tailwindContexts.last() : -1;
  }

  /**
   * Says whether what is written is in a call of a function that does not take classes. Returns what was said before (0 or 1), if there is
   * a context that does not follow the plugin; else -1.
   */
  disableTailwindContext(isDisabled: boolean): number {
    const n = this.tailwindContexts.len;
    if (n === 0) return -1;
    const c = this.tailwindContexts.data[n - 1] | 0;
    if ((c & TWC_FOLLOWS_PLUGIN) !== 0) return -1;
    this.tailwindContexts.data[n - 1] = isDisabled ? c | TWC_IS_DISABLED : c & ~TWC_IS_DISABLED;
    return (c & TWC_IS_DISABLED) !== 0 ? 1 : 0;
  }
}

/** `f.context` as the JavaScript context. Once per function. */
export function cxOf(f: Formatter): JsFormatContext {
  return f.context as JsFormatContext;
}

/** `JsFormatContext::new(options)`: a function, so that a module in an import cycle need not name the class. */
export function newContext(options: FormatOptions, noCursor: CursorRegion): JsFormatContext {
  return new JsFormatContext(options, noCursor);
}
