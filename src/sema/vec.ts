// Growable Int32 / byte vectors for the sema tables. Copied from scratch/cookbook/lib (i32vec.ts, bytebuf.ts) so that
// src/sema does not wait for src/base; TODO(dedupe): replace with src/base/I32Vec and ByteBuf once those land.
// Idioms (docs/SCRIPTC_COOKBOOK.md): plain-double `len` fields, `| 0` on every typed-array read that is stored and on every store.

export class I32Vec {
  data: Int32Array;
  len: number;
  constructor(cap: number) {
    this.data = new Int32Array(cap < 8 ? 8 : cap);
    this.len = 0;
  }
  grow(): void {
    const nd = new Int32Array(this.data.length * 2);
    nd.set(this.data);
    this.data = nd;
  }
  push(v: number): number {
    const n = this.len;
    if (n === this.data.length) this.grow();
    this.data[n] = v | 0;
    this.len = n + 1;
    return n;
  }
  /** Appends two values (an (a, b) pair row). */
  push2(a: number, b: number): void {
    const n = this.len;
    if (n + 2 > this.data.length) this.grow();
    const d = this.data;
    d[n] = a | 0;
    d[n + 1] = b | 0;
    this.len = n + 2;
  }
  /** Appends three values (a triple row). */
  push3(a: number, b: number, c: number): void {
    const n = this.len;
    if (n + 3 > this.data.length) this.grow();
    const d = this.data;
    d[n] = a | 0;
    d[n + 1] = b | 0;
    d[n + 2] = c | 0;
    this.len = n + 3;
  }
  pop(): number {
    const n = this.len - 1;
    this.len = n;
    return this.data[n] | 0;
  }
  get(i: number): number {
    return this.data[i] | 0;
  }
  set(i: number, v: number): void {
    this.data[i] = v | 0;
  }
  last(): number {
    return this.data[this.len - 1] | 0;
  }
  reset(): void {
    this.len = 0;
  }
  truncate(n: number): void {
    if (n < this.len) this.len = n;
  }
}

/** Growable byte buffer for decoded values (strings, templates, names with escapes). */
export class Bytes {
  data: Uint8Array;
  len: number;
  constructor(cap: number) {
    this.data = new Uint8Array(cap < 16 ? 16 : cap);
    this.len = 0;
  }
  grow(need: number): void {
    let cap = this.data.length;
    while (cap < need) cap = cap * 2;
    const nd = new Uint8Array(cap);
    nd.set(this.data);
    this.data = nd;
  }
  push(b: number): void {
    const n = this.len;
    if (n === this.data.length) this.grow(n + 1);
    this.data[n] = b | 0;
    this.len = n + 1;
  }
  /** Appends src[start, end). */
  append(src: Uint8Array, start: number, end: number): void {
    const cnt = end - start;
    const n = this.len;
    if (n + cnt > this.data.length) this.grow(n + cnt);
    const d = this.data;
    for (let i = 0; i < cnt; i++) d[n + i] = src[start + i] | 0;
    this.len = n + cnt;
  }
  /** Appends an ASCII/Latin-1 JS string. */
  appendAscii(s: string): void {
    const cnt = s.length;
    const n = this.len;
    if (n + cnt > this.data.length) this.grow(n + cnt);
    const d = this.data;
    for (let i = 0; i < cnt; i++) d[n + i] = s.charCodeAt(i) | 0;
    this.len = n + cnt;
  }
  reset(): void {
    this.len = 0;
  }
  /**
   * `push_codepoint_wtf8_joined`: appends code point `c` (0..=0x10FFFF, surrogates allowed) as WTF-8. A low surrogate
   * that directly follows an encoded high surrogate joins it into the 4-byte encoding of the pair.
   */
  pushCodepointWtf8(c: number): void {
    if (c < 0x80) {
      this.push(c);
    } else if (c < 0x800) {
      this.push(0xc0 | (c >> 6));
      this.push(0x80 | (c & 0x3f));
    } else if (c >= 0xdc00 && c <= 0xdfff && this.endsInHighSurrogate()) {
      const n = this.len;
      const d = this.data;
      const hi = 0xd800 | ((((d[n - 3] | 0) & 0x0f) << 6) | ((d[n - 2] | 0) & 0x3f));
      this.len = n - 3;
      const cp = 0x10000 + (((hi - 0xd800) << 10) | (c - 0xdc00));
      this.push(0xf0 | (cp >> 18));
      this.push(0x80 | ((cp >> 12) & 0x3f));
      this.push(0x80 | ((cp >> 6) & 0x3f));
      this.push(0x80 | (cp & 0x3f));
    } else if (c < 0x10000) {
      this.push(0xe0 | (c >> 12));
      this.push(0x80 | ((c >> 6) & 0x3f));
      this.push(0x80 | (c & 0x3f));
    } else {
      this.push(0xf0 | (c >> 18));
      this.push(0x80 | ((c >> 12) & 0x3f));
      this.push(0x80 | ((c >> 6) & 0x3f));
      this.push(0x80 | (c & 0x3f));
    }
  }
  private endsInHighSurrogate(): boolean {
    const n = this.len;
    if (n < 3) return false;
    const d = this.data;
    // 0xED 0xA0..0xAF 0x80..0xBF encodes U+D800..U+DBFF
    return (d[n - 3] | 0) === 0xed && ((d[n - 2] | 0) & 0xf0) === 0xa0;
  }
}
