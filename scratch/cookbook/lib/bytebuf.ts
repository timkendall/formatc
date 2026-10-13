// Growable append-only byte buffer. Reference implementation for scriptc 0.3.0 (measured, see docs/SCRIPTC_COOKBOOK.md).
// Uses Buffer (a Uint8Array subclass) so Buffer.copy (~6ns fixed, no view allocation) does bulk appends.
// Measured rules baked in:
//  - class fields (len) stay plain doubles: `this.len = n + 1` (adding `| 0` to field math made push 3x slower)
//  - every typed-array element read that is stored is written `x[i] | 0`; every value stored into a typed array too
//  - copies < 8 bytes use a byte loop; >= 8 use Buffer.copy
export class ByteBuf {
  data: Buffer;
  len: number;
  constructor(cap: number) {
    this.data = Buffer.alloc(cap < 16 ? 16 : cap);
    this.len = 0;
  }
  grow(need: number): void {
    let cap = this.data.length;
    while (cap < need) cap = cap * 2;
    const nd = Buffer.alloc(cap);
    this.data.copy(nd, 0, 0, this.len);
    this.data = nd;
  }
  push(b: number): void {
    const n = this.len;
    if (n === this.data.length) this.grow(n + 1);
    this.data[n] = b | 0;
    this.len = n + 1;
  }
  // Append src[start, end)
  append(src: Buffer, start: number, end: number): void {
    const cnt = end - start;
    const n = this.len;
    if (n + cnt > this.data.length) this.grow(n + cnt);
    const d = this.data;
    if (cnt < 8) {
      for (let i = 0; i < cnt; i++) d[n + i] = src[start + i] | 0;
    } else {
      src.copy(d, n, start, end);
    }
    this.len = n + cnt;
  }
  appendBuf(o: ByteBuf): void {
    this.append(o.data, 0, o.len);
  }
  // ASCII/latin1 only; use for short literals ("function", ", ", ...)
  appendAscii(s: string): void {
    const cnt = s.length;
    const n = this.len;
    if (n + cnt > this.data.length) this.grow(n + cnt);
    const d = this.data;
    for (let i = 0; i < cnt; i++) d[n + i] = s.charCodeAt(i) | 0;
    this.len = n + cnt;
  }
  fill(b: number, count: number): void {
    const n = this.len;
    if (n + count > this.data.length) this.grow(n + count);
    this.data.fill(b, n, n + count);
    this.len = n + count;
  }
  view(): Buffer {
    return this.data.subarray(0, this.len);
  }
  reset(): void {
    this.len = 0;
  }
}
