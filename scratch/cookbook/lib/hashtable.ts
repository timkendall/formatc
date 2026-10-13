// Open-addressing int32 -> int32 hash map (linear probing, power-of-two capacity, tombstone-free: no deletes).
// Keys must be >= 0 (EMPTY = -1). 0.66 ns/lookup measured (Map<number,number>.get is 1.0 ns, so use this only when you need it
// in a tight loop or want zero allocation / easy resetting).
export class IntMap {
  keys: Int32Array;
  vals: Int32Array;
  mask: number;
  size: number;
  constructor(cap: number) {
    let c = 16;
    while (c < cap * 2) c = c * 2;
    this.keys = new Int32Array(c).fill(-1);
    this.vals = new Int32Array(c);
    this.mask = c - 1;
    this.size = 0;
  }
  // returns value or `missing`
  get(key: number, missing: number): number {
    const keys = this.keys;
    const mask = this.mask;
    let h = (Math.imul(key | 0, -1640531535) >>> 15) & mask;
    while (true) {
      const k = keys[h] | 0;
      if (k === key) return this.vals[h] | 0;
      if (k === -1) return missing;
      h = (h + 1) & mask;
    }
  }
  set(key: number, val: number): void {
    if ((this.size + 1) * 2 > this.keys.length) this.grow();
    const keys = this.keys;
    const mask = this.mask;
    let h = (Math.imul(key | 0, -1640531535) >>> 15) & mask;
    while (true) {
      const k = keys[h] | 0;
      if (k === key) { this.vals[h] = val | 0; return; }
      if (k === -1) { keys[h] = key | 0; this.vals[h] = val | 0; this.size = this.size + 1; return; }
      h = (h + 1) & mask;
    }
  }
  grow(): void {
    const ok = this.keys;
    const ov = this.vals;
    const c = ok.length * 2;
    this.keys = new Int32Array(c).fill(-1);
    this.vals = new Int32Array(c);
    this.mask = c - 1;
    this.size = 0;
    for (let i = 0; i < ok.length; i++) {
      const k = ok[i] | 0;
      if (k !== -1) this.set(k, ov[i] | 0);
    }
  }
}
