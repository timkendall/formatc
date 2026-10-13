// Replaces `bun_collections::StringSet` for link labels: byte strings -> dense ids in insertion order, no JS strings.
// Open addressing over an Int32Array; the keys live in one growable byte array.
export class LabelSet {
  bytes: Uint8Array = new Uint8Array(1024);
  bytesLen = 0;
  starts: Int32Array = new Int32Array(64);
  lens: Int32Array = new Int32Array(64);
  hashes: Int32Array = new Int32Array(64);
  count = 0;
  // (id + 1); 0 = empty
  table: Int32Array = new Int32Array(256);
  mask = 255;

  clear(): void {
    if (this.count === 0) return;
    if (this.table.length > 4096) {
      this.table = new Int32Array(256);
      this.mask = 255;
    } else {
      this.table.fill(0);
    }
    this.count = 0;
    this.bytesLen = 0;
  }

  private static hash(src: Uint8Array, start: number, end: number): number {
    let h = -2128831035;
    for (let i = start; i < end; i++) h = Math.imul(h ^ (src[i] | 0), 16777619);
    return h | 0;
  }

  /** The id of `src[start, end)`, -1 if it is not in the set. */
  find(src: Uint8Array, start: number, end: number): number {
    if (this.count === 0) return -1;
    const h = LabelSet.hash(src, start, end);
    const len = end - start;
    const table = this.table;
    const mask = this.mask;
    let slot = (h ^ (h >>> 15)) & mask;
    while (true) {
      const e = table[slot] | 0;
      if (e === 0) return -1;
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
  }

  contains(src: Uint8Array, start: number, end: number): boolean {
    return this.find(src, start, end) >= 0;
  }

  /** Inserts `src[start, end)` if it is new. Returns its id. */
  insert(src: Uint8Array, start: number, end: number): number {
    const h = LabelSet.hash(src, start, end);
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
    const id = this.count;
    if (id === this.starts.length) this.growIds();
    if (this.bytesLen + len > this.bytes.length) this.growBytes(this.bytesLen + len);
    const off = this.bytesLen;
    const bytes = this.bytes;
    for (let k = 0; k < len; k++) bytes[off + k] = src[start + k] | 0;
    this.bytesLen = off + len;
    this.starts[id] = off | 0;
    this.lens[id] = len | 0;
    this.hashes[id] = h | 0;
    this.table[slot] = (id + 1) | 0;
    this.count = id + 1;
    if (this.count * 2 > this.table.length) this.rehash();
    return id;
  }

  private growIds(): void {
    const n = this.starts.length * 2;
    const s = new Int32Array(n);
    s.set(this.starts);
    this.starts = s;
    const l = new Int32Array(n);
    l.set(this.lens);
    this.lens = l;
    const hh = new Int32Array(n);
    hh.set(this.hashes);
    this.hashes = hh;
  }

  private growBytes(need: number): void {
    let n = this.bytes.length;
    while (n < need) n = n * 2;
    const b = new Uint8Array(n);
    b.set(this.bytes);
    this.bytes = b;
  }

  private rehash(): void {
    const n = this.table.length * 2;
    const t = new Int32Array(n);
    const mask = n - 1;
    for (let id = 0; id < this.count; id++) {
      const h = this.hashes[id] | 0;
      let slot = (h ^ (h >>> 15)) & mask;
      while ((t[slot] | 0) !== 0) slot = (slot + 1) & mask;
      t[slot] = (id + 1) | 0;
    }
    this.table = t;
    this.mask = mask;
  }
}
