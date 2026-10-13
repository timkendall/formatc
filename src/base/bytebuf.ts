// Growable append-only byte buffer (production version of scratch/cookbook/lib/bytebuf.ts).
//
// Rules baked in (docs/SCRIPTC_COOKBOOK.md sections 0, 3.1):
//  - class fields (`len`) stay plain doubles: `this.len = n + 1` (adding `| 0` to field math made push 3x slower);
//  - every typed-array element read that is stored is `x[i] | 0`, every value stored into a typed array too;
//  - runs shorter than 16 bytes are copied by a byte loop, longer ones with `set(subarray)`;
//  - hot loops copy `data`/`len` into locals around the loop and write back once.
//
// The backing store is a plain Uint8Array so that any `Uint8Array` (a Node Buffer, a subarray) can be appended from.
export class ByteBuf {
  data: Uint8Array;
  len: number;
  constructor(cap: number) {
    this.data = new Uint8Array(cap < 16 ? 16 : cap);
    this.len = 0;
  }
  // Makes room for `need` bytes in total (not additional).
  grow(need: number): void {
    let cap = this.data.length;
    while (cap < need) cap = cap * 2;
    const nd = new Uint8Array(cap);
    nd.set(this.data.subarray(0, this.len));
    this.data = nd;
  }
  // Makes room for `extra` more bytes.
  reserve(extra: number): void {
    if (this.len + extra > this.data.length) this.grow(this.len + extra);
  }
  push(b: number): void {
    const n = this.len;
    if (n === this.data.length) this.grow(n + 1);
    this.data[n] = b | 0;
    this.len = n + 1;
  }
  // Appends src[start, end)
  append(src: Uint8Array, start: number, end: number): void {
    const cnt = end - start;
    const n = this.len;
    if (n + cnt > this.data.length) this.grow(n + cnt);
    const d = this.data;
    if (cnt < 16) {
      for (let i = 0; i < cnt; i++) d[n + i] = src[start + i] | 0;
    } else {
      d.set(src.subarray(start, end), n);
    }
    this.len = n + cnt;
  }
  appendAll(src: Uint8Array): void {
    this.append(src, 0, src.length);
  }
  appendBuf(o: ByteBuf): void {
    this.append(o.data, 0, o.len);
  }
  // ASCII/latin1 only; for short literals ("function", ", ", ...). Not for hot paths: register a token instead.
  appendAscii(s: string): void {
    const cnt = s.length;
    const n = this.len;
    if (n + cnt > this.data.length) this.grow(n + cnt);
    const d = this.data;
    for (let i = 0; i < cnt; i++) d[n + i] = s.charCodeAt(i) | 0;
    this.len = n + cnt;
  }
  // Appends `count` copies of `b`.
  fill(b: number, count: number): void {
    const n = this.len;
    if (n + count > this.data.length) this.grow(n + count);
    this.data.fill(b, n, n + count);
    this.len = n + count;
  }
  // Appends the decimal digits of a non-negative integer.
  appendUint(v: number): void {
    if (v < 10) { this.push(48 + v); return; }
    let digits = 0;
    let t = v;
    while (t > 0) { digits = digits + 1; t = Math.floor(t / 10); }
    const n = this.len;
    if (n + digits > this.data.length) this.grow(n + digits);
    const d = this.data;
    t = v;
    for (let i = digits - 1; i >= 0; i--) {
      const q = Math.floor(t / 10);
      d[n + i] = (48 + (t - q * 10)) | 0;
      t = q;
    }
    this.len = n + digits;
  }
  // Removes trailing bytes so that `len` is `n`.
  truncate(n: number): void {
    if (n < this.len) this.len = n;
  }
  // A view of the written bytes (aliases the buffer until the next grow).
  view(): Uint8Array {
    return this.data.subarray(0, this.len);
  }
  reset(): void {
    this.len = 0;
  }
  // Slow path (diagnostics/tests): the bytes as a latin1 string.
  toLatin1(): string {
    let s = "";
    const d = this.data;
    for (let i = 0; i < this.len; i++) s += String.fromCharCode(d[i] | 0);
    return s;
  }
  // Slow path (diagnostics/tests): the bytes decoded as UTF-8.
  toUtf8(): string {
    return new TextDecoder().decode(this.data.subarray(0, this.len));
  }
}
