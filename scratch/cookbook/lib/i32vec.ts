// Growable Int32 vector. Reference implementation for scriptc 0.3.0.
// Plain-double `len` field (see bytebuf.ts note); values stored into the Int32Array are `| 0`.
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
  reset(): void {
    this.len = 0;
  }
}
