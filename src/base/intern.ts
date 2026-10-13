// Production version of scratch/cookbook/lib/intern.ts (plus reset()).
// Byte-slice string interner: maps src[start,end) -> dense id without creating JS strings.
// Open addressing (linear probing) over Int32Array; unique byte strings stored in one growable Uint8Array.
// Measured idioms: every typed-array read is `| 0`; hash arithmetic uses Math.imul; table index = h & mask.
export class Interner {
  // unique string bytes
  bytes: Uint8Array;
  bytesLen: number;
  // per id: start offset in `bytes`, length, full hash
  starts: Int32Array;
  lens: Int32Array;
  hashes: Int32Array;
  count: number;
  // open-addressing table of (id + 1); 0 = empty
  table: Int32Array;
  mask: number;
  constructor() {
    this.bytes = new Uint8Array(4096);
    this.bytesLen = 0;
    this.starts = new Int32Array(256);
    this.lens = new Int32Array(256);
    this.hashes = new Int32Array(256);
    this.count = 0;
    this.table = new Int32Array(1024);
    this.mask = 1023;
  }
  // Returns the id of src[start,end), inserting if new.
  intern(src: Uint8Array, start: number, end: number): number {
    let h = -2128831035; // FNV offset basis as int32
    for (let i = start; i < end; i++) {
      h = Math.imul(h ^ (src[i] | 0), 16777619);
    }
    const len = end - start;
    const table = this.table;
    const mask = this.mask;
    let slot = (h ^ (h >>> 15)) & mask;
    while (true) {
      const e = table[slot] | 0;
      if (e === 0) break;
      const id = e - 1;
      if ((this.hashes[id] | 0) === h && (this.lens[id] | 0) === len) {
        const off = this.starts[id] | 0;
        const bytes = this.bytes;
        let k = 0;
        while (k < len && (bytes[off + k] | 0) === (src[start + k] | 0)) k++;
        if (k === len) return id;
      }
      slot = (slot + 1) & mask;
    }
    return this.insertNew(src, start, len, h, slot);
  }
  insertNew(src: Uint8Array, start: number, len: number, h: number, slot: number): number {
    const id = this.count;
    if (id === this.starts.length) this.growIds();
    if (this.bytesLen + len > this.bytes.length) this.growBytes(this.bytesLen + len);
    const off = this.bytesLen;
    const bytes = this.bytes;
    for (let k = 0; k < len; k++) bytes[off + k] = src[start + k] | 0;
    this.bytesLen = off + len;
    this.starts[id] = off;
    this.lens[id] = len;
    this.hashes[id] = h;
    this.table[slot] = id + 1;
    this.count = id + 1;
    if ((this.count * 2) > this.table.length) this.rehash();
    return id;
  }
  growIds(): void {
    const n = this.starts.length * 2;
    const s = new Int32Array(n); s.set(this.starts); this.starts = s;
    const l = new Int32Array(n); l.set(this.lens); this.lens = l;
    const hh = new Int32Array(n); hh.set(this.hashes); this.hashes = hh;
  }
  growBytes(need: number): void {
    let n = this.bytes.length;
    while (n < need) n = n * 2;
    const b = new Uint8Array(n);
    b.set(this.bytes);
    this.bytes = b;
  }
  rehash(): void {
    const n = this.table.length * 2;
    const t = new Int32Array(n);
    const mask = n - 1;
    for (let id = 0; id < this.count; id++) {
      const h = this.hashes[id] | 0;
      let slot = (h ^ (h >>> 15)) & mask;
      while ((t[slot] | 0) !== 0) slot = (slot + 1) & mask;
      t[slot] = id + 1;
    }
    this.table = t;
    this.mask = mask;
  }
  // Forgets every string, keeping the capacity. Ids start again at 0.
  reset(): void {
    this.count = 0;
    this.bytesLen = 0;
    this.table.fill(0);
  }
  // Length in bytes of the string with this id.
  length(id: number): number {
    return this.lens[id] | 0;
  }
  // Materialize the string for an id (slow path: diagnostics only).
  text(id: number): string {
    const off = this.starts[id] | 0;
    const len = this.lens[id] | 0;
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.bytes[off + i] | 0);
    return s;
  }
}
