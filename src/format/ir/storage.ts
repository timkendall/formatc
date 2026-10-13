// What elements refer to by index (Rust `Storage` in ir/formatter.rs), as a struct of arrays.
//
//  - the pool: every element of the document, in the order they are written: `tag`, `a`, `b`, `c` columns (element.ts);
//    a handle (what `capture` returns) is the index of the `E_SKIP` that stands in front of the captured elements;
//  - `variants`: what `E_BEST_FITTING` is a range of (handles of captured variants, flattest first);
//  - `text`: what `E_OWNED_TEXT` is a range of.
//
// Grow-only, per thread, reset (not reallocated) per file. A reserved prefix of 10 elements is in every pool: the printer
// queues runs of them (END_LINE_SUFFIX, the six line breaks, and the rest of an `E_INDENTED_LINE_GROUP`).
import { ByteBuf } from "../../base/bytebuf.ts";
import { I32Vec } from "../../base/i32vec.ts";
import {
  E_LINE,
  E_TOKEN,
  LM_SOFT_OR_SPACE,
  RESERVED,
  TOK_BASE,
  TOK_INLINE_MAX,
  TOK_LEN,
  TOK_OFF,
  TOK_W0,
  TOK_W1,
  TOK_W2,
  T_END_GROUP,
  T_END_INDENT,
  T_END_LINE_SUFFIX,
  T_START_INDENT_WITH_LINE,
} from "./element.ts";

export class Storage {
  tag: Uint8Array;
  a: Int32Array;
  b: Int32Array;
  c: Int32Array;
  /** The number of elements in the pool. */
  len: number;
  variants: I32Vec;
  text: ByteBuf;

  constructor(cap: number) {
    const n = cap < 64 ? 64 : cap;
    this.tag = new Uint8Array(n);
    this.a = new Int32Array(n);
    this.b = new Int32Array(n);
    this.c = new Int32Array(n);
    this.len = 0;
    this.variants = new I32Vec(16);
    this.text = new ByteBuf(256);
    this.clear();
  }

  /** Empties the storage, keeping its capacity, and writes the reserved prefix. */
  clear(): void {
    this.len = 0;
    this.variants.reset();
    this.text.reset();
    this.push(T_END_LINE_SUFFIX, 0, 0, 0);
    for (let m = 0; m < 6; m++) this.push(E_LINE, m, 0, 0);
    this.push(T_START_INDENT_WITH_LINE, LM_SOFT_OR_SPACE, 0, 0);
    this.push(T_END_INDENT, 0, 0, 0);
    this.push(T_END_GROUP, 0, 0, 0);
  }

  /** Makes room for at least `n` elements in total. */
  reserve(n: number): void {
    if (n > this.tag.length) this.grow(n);
  }

  grow(need: number): void {
    let cap = this.tag.length;
    while (cap < need) cap = cap * 2;
    const t = new Uint8Array(cap);
    t.set(this.tag);
    this.tag = t;
    const a = new Int32Array(cap);
    a.set(this.a);
    this.a = a;
    const b = new Int32Array(cap);
    b.set(this.b);
    this.b = b;
    const c = new Int32Array(cap);
    c.set(this.c);
    this.c = c;
  }

  /** Appends an element without telling any `Tracker` about it. Returns its index. */
  push(t: number, a: number, b: number, c: number): number {
    const n = this.len;
    if (n === this.tag.length) this.grow(n + 1);
    this.tag[n] = t | 0;
    this.a[n] = a | 0;
    this.b[n] = b | 0;
    this.c[n] = c | 0;
    this.len = n + 1;
    return n;
  }

  /** Appends a token (`token("...")`) without telling any `Tracker` about it. */
  pushToken(handle: number): number {
    const len = TOK_LEN[handle] | 0;
    if (len <= TOK_INLINE_MAX) return this.push(TOK_BASE + len, TOK_W0[handle] | 0, TOK_W1[handle] | 0, TOK_W2[handle] | 0);
    return this.push(E_TOKEN, TOK_OFF[handle] | 0, len, 0);
  }

  /** The start of the elements that a handle stands for. */
  static contentStart(handle: number): number {
    return handle + 1;
  }

  /** How many elements a handle stands for. */
  contentLen(handle: number): number {
    return this.a[handle] | 0;
  }
}

/** The root of a document: the elements `[start, end)` of the pool. */
export const RESERVED_END = RESERVED;
