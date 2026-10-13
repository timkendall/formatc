// Port of vendor/bun/src/format/handlebars/ast.rs: the tree that `@glimmer/syntax` makes of a template, in flat lists.
//
// Rust `Kind` is an enum with data: here `tag[id]` is the kind (`K_*`) and its fields are the columns `f0`..`f8` of the
// node (layout below). A `Text` (bytes of the template, or of `owned`) is two ints, `(start, len)`: a negative `start`
// is `~start` of a text in `owned` (Rust: the `1 << 31` bit). A `Range` (of `lists` or `names`) is `(start, len)` too.
// A `Call` (`path`, `params`, `pairs`) is five ints: path, params start, params len, pairs start, pairs len.
//
// Layout of the columns (all `Int32`):
//   K_TEMPLATE          f0,f1 body (range of lists)
//   K_BLOCK             f0,f1 body, f2,f3 blockParams (range of names)
//   K_ELEMENT           f0,f1 tag (text), f2,f3 attributes, f4,f5 blockParams (names), f6,f7 children, f8 isSelfClosing
//   K_BLOCK_STATEMENT   f0..f4 call, f5 program, f6 inverse (NOTHING: none), f7 strip
//   K_MUSTACHE          f0..f4 call, f5 isTrusting, f6 strip
//   K_ELEMENT_MODIFIER  f0..f4 call
//   K_SUB_EXPRESSION    f0..f4 call
//   K_ATTR              f0,f1 name (text), f2 value
//   K_CONCAT            f0,f1 parts
//   K_HASH_PAIR         f0,f1 key (text), f2 value
//   K_TEXT              f0,f1 chars (text)
//   K_MUSTACHE_COMMENT  f0,f1 value (text)
//   K_COMMENT           f0,f1 value (text)
//   K_PATH              f0 head (H_*), f1,f2 name (text), f3,f4 tail (range of names)
//   K_STRING            f0,f1 value (text)
//   K_NUMBER            f0,f1 token (text)
//   K_BOOLEAN           f0 value (0/1)
// The others have no data.
import { ByteBuf } from "../../base/bytebuf.ts";

export const K_NOTHING: number = 0;
export const K_FRONT_MATTER: number = 1;
export const K_TEMPLATE: number = 2;
export const K_BLOCK: number = 3;
export const K_ELEMENT: number = 4;
export const K_BLOCK_STATEMENT: number = 5;
export const K_MUSTACHE: number = 6;
export const K_ELEMENT_MODIFIER: number = 7;
export const K_SUB_EXPRESSION: number = 8;
export const K_ATTR: number = 9;
export const K_CONCAT: number = 10;
export const K_HASH_PAIR: number = 11;
export const K_TEXT: number = 12;
export const K_MUSTACHE_COMMENT: number = 13;
export const K_COMMENT: number = 14;
// `<!DOCTYPE html>`, which `@glimmer/syntax` has no node for.
export const K_DOCTYPE: number = 15;
export const K_PATH: number = 16;
export const K_STRING: number = 17;
export const K_NUMBER: number = 18;
export const K_BOOLEAN: number = 19;
export const K_UNDEFINED: number = 20;
export const K_NULL: number = 21;

// `Head` (verify.rs writes the number).
export const H_THIS: number = 0;
export const H_AT: number = 1;
export const H_VAR: number = 2;

// `strip.open` of a mustache, `openStrip.open` of a block.
export const OPEN_OPEN: number = 1;
export const OPEN_CLOSE: number = 1 << 1;
export const INVERSE_OPEN: number = 1 << 2;
export const INVERSE_CLOSE: number = 1 << 3;
export const CLOSE_OPEN: number = 1 << 4;
export const CLOSE_CLOSE: number = 1 << 5;
// Of a block: it is written `{{else a}}`.
export const CHAINED: number = 1 << 6;

// The node that stands for `undefined`. It prints nothing.
export const NOTHING: number = 0;

export class Tree {
  tag: Uint8Array;
  start: Int32Array;
  end: Int32Array;
  // `Node::is_as_written`: `kind` is not all that the template says from `start` to `end`: the parsers have dropped or
  // changed something. So that text is printed, as for `prettier-ignore`.
  written: Uint8Array;
  f0: Int32Array;
  f1: Int32Array;
  f2: Int32Array;
  f3: Int32Array;
  f4: Int32Array;
  f5: Int32Array;
  f6: Int32Array;
  f7: Int32Array;
  f8: Int32Array;
  n: number;
  lists: Int32Array;
  nLists: number;
  // The tails of paths, and block parameters.
  nameStart: Int32Array;
  nameLen: Int32Array;
  nNames: number;
  // The template (`srcLen` bytes), and behind it the texts that are written to the tree: up to `nBuf`.
  buf: Uint8Array;
  srcLen: number;
  nBuf: number;
  // The parsers have dropped something that is in no node. So the template is printed as it is written, all of it.
  hasLostText: boolean;
  // Results of the functions that return a text (`appendSource`, `append`, `endText`).
  rs: number;
  rl: number;

  constructor() {
    this.tag = new Uint8Array(64);
    this.start = new Int32Array(64);
    this.end = new Int32Array(64);
    this.written = new Uint8Array(64);
    this.f0 = new Int32Array(64);
    this.f1 = new Int32Array(64);
    this.f2 = new Int32Array(64);
    this.f3 = new Int32Array(64);
    this.f4 = new Int32Array(64);
    this.f5 = new Int32Array(64);
    this.f6 = new Int32Array(64);
    this.f7 = new Int32Array(64);
    this.f8 = new Int32Array(64);
    this.n = 0;
    this.lists = new Int32Array(64);
    this.nLists = 0;
    this.nameStart = new Int32Array(16);
    this.nameLen = new Int32Array(16);
    this.nNames = 0;
    this.buf = new Uint8Array(64);
    this.srcLen = 0;
    this.nBuf = 0;
    this.hasLostText = false;
    this.rs = 0;
    this.rl = 0;
    this.clear(new Uint8Array(0));
  }

  // Empties the tree; `source` is the template, which is copied.
  clear(source: Uint8Array): void {
    const len = source.length;
    if (len + 256 > this.buf.length) this.buf = new Uint8Array(len + (len >> 3) + 256);
    this.buf.set(source);
    this.srcLen = len;
    this.nBuf = len;
    this.n = 0;
    this.nLists = 0;
    this.nNames = 0;
    this.hasLostText = false;
    // The node 0 is NOTHING.
    this.add(K_NOTHING, 0, 0);
  }

  growNodes(): void {
    const cap = this.tag.length * 2;
    let t = new Uint8Array(cap);
    t.set(this.tag);
    this.tag = t;
    t = new Uint8Array(cap);
    t.set(this.written);
    this.written = t;
    let a = new Int32Array(cap);
    a.set(this.start);
    this.start = a;
    a = new Int32Array(cap);
    a.set(this.end);
    this.end = a;
    a = new Int32Array(cap);
    a.set(this.f0);
    this.f0 = a;
    a = new Int32Array(cap);
    a.set(this.f1);
    this.f1 = a;
    a = new Int32Array(cap);
    a.set(this.f2);
    this.f2 = a;
    a = new Int32Array(cap);
    a.set(this.f3);
    this.f3 = a;
    a = new Int32Array(cap);
    a.set(this.f4);
    this.f4 = a;
    a = new Int32Array(cap);
    a.set(this.f5);
    this.f5 = a;
    a = new Int32Array(cap);
    a.set(this.f6);
    this.f6 = a;
    a = new Int32Array(cap);
    a.set(this.f7);
    this.f7 = a;
    a = new Int32Array(cap);
    a.set(this.f8);
    this.f8 = a;
  }

  // Adds a node of kind `kind`. The fields (`f0`..) are the caller's to set: those of its kind, and no others are read. Returns
  // its id.
  add(kind: number, start: number, end: number): number {
    const i = this.n;
    if (i === this.tag.length) this.growNodes();
    this.tag[i] = kind | 0;
    this.start[i] = start | 0;
    this.end[i] = end | 0;
    this.written[i] = 0;
    this.n = i + 1;
    return i;
  }

  // A node with two fields.
  add2(kind: number, start: number, end: number, a: number, b: number): number {
    const i = this.add(kind, start, end);
    this.f0[i] = a | 0;
    this.f1[i] = b | 0;
    return i;
  }

  // A node with three fields.
  add3(kind: number, start: number, end: number, a: number, b: number, c: number): number {
    const i = this.add(kind, start, end);
    this.f0[i] = a | 0;
    this.f1[i] = b | 0;
    this.f2[i] = c | 0;
    return i;
  }

  // See `Node::is_as_written`.
  keepAsWritten(id: number): void {
    if (id >= 0 && id < this.n) this.written[id] = 1;
  }

  // `kind(id)`: K_NOTHING for an id that is none.
  kind(id: number): number {
    return id >= 0 && id < this.n ? this.tag[id] | 0 : K_NOTHING;
  }

  // Adds the `count` ids `lists[from..]` ... see `addList`: adds the ids that the caller has written with `pushList`.
  // Rust `add_list(&[NodeId])` for a slice of an I32Vec: `data[from, from+len)`. Returns the start; the length is `len`.
  addListFrom(data: Int32Array, from: number, len: number): number {
    const start = this.nLists;
    if (start + len > this.lists.length) {
      let cap = this.lists.length;
      while (cap < start + len) cap = cap * 2;
      const l = new Int32Array(cap);
      l.set(this.lists.subarray(0, start));
      this.lists = l;
    }
    const lists = this.lists;
    for (let i = 0; i < len; i++) lists[start + i] = data[from + i] | 0;
    this.nLists = start + len;
    return start;
  }

  addNamesFrom(starts: Int32Array, lens: Int32Array, from: number, len: number): number {
    const start = this.nNames;
    if (start + len > this.nameStart.length) {
      let cap = this.nameStart.length;
      while (cap < start + len) cap = cap * 2;
      const s = new Int32Array(cap);
      s.set(this.nameStart.subarray(0, start));
      this.nameStart = s;
      const l = new Int32Array(cap);
      l.set(this.nameLen.subarray(0, start));
      this.nameLen = l;
    }
    const ns = this.nameStart;
    const nl = this.nameLen;
    for (let i = 0; i < len; i++) {
      ns[start + i] = starts[from + i] | 0;
      nl[start + i] = lens[from + i] | 0;
    }
    this.nNames = start + len;
    return start;
  }

  // Adds the `count` names that are `(start, len)` pairs in `pairs`. Returns the start of the range.
  addNamePairs(pairs: Int32Array, count: number): number {
    const start = this.nNames;
    if (start + count > this.nameStart.length) {
      let cap = this.nameStart.length;
      while (cap < start + count) cap = cap * 2;
      const s = new Int32Array(cap);
      s.set(this.nameStart.subarray(0, start));
      this.nameStart = s;
      const l = new Int32Array(cap);
      l.set(this.nameLen.subarray(0, start));
      this.nameLen = l;
    }
    const ns = this.nameStart;
    const nl = this.nameLen;
    for (let i = 0; i < count; i++) {
      ns[start + i] = pairs[2 * i] | 0;
      nl[start + i] = pairs[2 * i + 1] | 0;
    }
    this.nNames = start + count;
    return start;
  }

  // ------------------------------------------------------------------------------------------ texts

  // Makes sure that `buf` has room for `extra` more bytes.
  reserveBuf(extra: number): void {
    const need = this.nBuf + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < need) cap = cap * 2;
    const o = new Uint8Array(cap);
    o.set(this.buf.subarray(0, this.nBuf));
    this.buf = o;
  }

  // Where a text that is written to `buf` starts.
  startText(): number {
    return this.nBuf;
  }

  writeByte(b: number): void {
    this.reserveBuf(1);
    this.buf[this.nBuf] = b | 0;
    this.nBuf = this.nBuf + 1;
  }

  // Appends `from[a, b)` to `buf`.
  write(from: Uint8Array, a: number, b: number): void {
    const len = b - a;
    if (len <= 0) return;
    this.reserveBuf(len);
    const n = this.nBuf;
    if (len < 16) {
      const o = this.buf;
      for (let i = 0; i < len; i++) o[n + i] = from[a + i] | 0;
    } else {
      this.buf.set(from.subarray(a, b), n);
    }
    this.nBuf = n + len;
  }

  writeAscii(s: string): void {
    const len = s.length;
    this.reserveBuf(len);
    const o = this.buf;
    const n = this.nBuf;
    for (let i = 0; i < len; i++) o[n + i] = s.charCodeAt(i) | 0;
    this.nBuf = n + len;
  }

  // Appends the text `(s, l)` to `buf`.
  writeText(s: number, l: number): void {
    if (l <= 0) return;
    this.reserveBuf(l);
    this.buf.copyWithin(this.nBuf, s, s + l);
    this.nBuf = this.nBuf + l;
  }

  // What has been written since `startText` returned `start`: the text is in `rs`, `rl`.
  endText(start: number): void {
    this.rs = start;
    this.rl = this.nBuf - start;
  }

  // `text += source[start..end]`. Nothing is copied as long as `text` is one piece of the template. The result is in
  // `rs`, `rl`.
  appendSource(s: number, l: number, start: number, end: number): void {
    if (l === 0) {
      this.rs = start;
      this.rl = end > start ? end - start : 0;
    } else if (s + l === start) {
      this.rs = s;
      this.rl = l + (end - start);
    } else {
      this.appendBytes(s, l, this.buf, start, end);
    }
  }

  // `text += from[a..b)`. The result is in `rs`, `rl`.
  appendBytes(s: number, l: number, from: Uint8Array, a: number, b: number): void {
    // `own`: make `text` end where the written texts end, so that it can grow.
    let ts = s;
    if (!(s >= this.srcLen && s + l === this.nBuf)) {
      const start = this.nBuf;
      this.writeText(s, l);
      ts = start;
    }
    this.write(from, a, b);
    this.rs = ts;
    this.rl = l + (b - a);
  }

  // ------------------------------------------------------------------------------------------ text queries

  // Whether the text `(s, l)` is `lit` (printable ASCII).
  textIs(s: number, l: number, lit: string): boolean {
    if (l !== lit.length) return false;
    const buf = this.buf;
    for (let i = 0; i < l; i++) {
      if ((buf[s + i] | 0) !== lit.charCodeAt(i)) return false;
    }
    return true;
  }

  // Whether the two texts have the same bytes.
  textEq(s: number, l: number, s2: number, l2: number): boolean {
    if (l !== l2) return false;
    const buf = this.buf;
    for (let i = 0; i < l; i++) {
      if ((buf[s + i] | 0) !== (buf[s2 + i] | 0)) return false;
    }
    return true;
  }

  // The text ends with the byte.
  textEndsWithByte(s: number, l: number, byte: number): boolean {
    if (l <= 0) return false;
    return (this.buf[s + l - 1] | 0) === byte;
  }

  // The text contains the byte.
  textHasByte(s: number, l: number, byte: number): boolean {
    const buf = this.buf;
    for (let i = 0; i < l; i++) {
      if ((buf[s + i] | 0) === byte) return true;
    }
    return false;
  }

  // Copies the text to the end of `out`.
  copyText(s: number, l: number, out: ByteBuf): void {
    out.append(this.buf, s, s + l);
  }
}
