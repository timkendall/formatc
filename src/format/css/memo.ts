// Port of vendor/bun/src/format/css/memo.rs: what declarations have been printed as.
//
// Style sheets say the same things over and over: half of the declarations of a style sheet are in it more than
// once, letter for letter, and three quarters of those of a project. What is printed for a declaration on one line
// depends on its text and on little else, so it is kept, and the next time it is neither parsed nor printed.
//
// The key has to hold everything that the printed line depends on (see css/CLAUDE.md in the Rust tree): the text of
// the declaration, all of it, and `Memo.context`'s flags and at-rule name.
//
// Per thread, up to 1 MB (`MAX_BYTES`); with more than that it starts anew. Results are returned in fields
// (`outStart`/`outEnd` index `bytes`, `hasGroup`) instead of a tuple.

// With more than that, it starts anew.
const MAX_BYTES = 1 << 20;
// size_of::<Entry>() in Rust
const ENTRY_SIZE = 32;

function hashBytes(context: number, text: Uint8Array, start: number, end: number): number {
  // Not every byte: the length and up to 12 bytes from each end. Equal hashes are compared in full.
  const len = end - start;
  let h = Math.imul((context | 0) ^ Math.imul(len, 0x85ebca6b), 0x9e3779b9) | 0;
  if (len <= 24) {
    for (let i = start; i < end; i++) h = Math.imul(((h << 5) | (h >>> 27)) ^ (text[i] | 0), 0x9e3779b9) | 0;
  } else {
    for (let i = start; i < start + 12; i++) h = Math.imul(((h << 5) | (h >>> 27)) ^ (text[i] | 0), 0x9e3779b9) | 0;
    for (let i = end - 12; i < end; i++) h = Math.imul(((h << 5) | (h >>> 27)) ^ (text[i] | 0), 0x9e3779b9) | 0;
  }
  return h | 0;
}

export class Memo {
  bytes: Uint8Array;
  nBytes: number;
  // contexts
  ctxFlags: Int32Array;
  ctxAtStart: Int32Array;
  ctxAtEnd: Int32Array;
  nContexts: number;
  // The number of the first of the contexts. No number is given twice.
  firstContext: number;
  // entries
  eHash: Int32Array;
  eContext: Int32Array;
  eTextStart: Int32Array;
  eTextEnd: Int32Array;
  eOutStart: Int32Array;
  eOutEnd: Int32Array;
  eHasGroup: Uint8Array;
  nEntries: number;
  // For each hash, by its low bits or in one of the places that follow, the index of its entry plus one. Its
  // length is a power of two (or 0).
  table: Int32Array;
  tableLen: number;
  // The result of `get`.
  outStart: number;
  outEnd: number;
  hasGroup: boolean;

  constructor() {
    this.bytes = new Uint8Array(1 << 16);
    this.nBytes = 0;
    this.ctxFlags = new Int32Array(16);
    this.ctxAtStart = new Int32Array(16);
    this.ctxAtEnd = new Int32Array(16);
    this.nContexts = 0;
    this.firstContext = 0;
    this.eHash = new Int32Array(256);
    this.eContext = new Int32Array(256);
    this.eTextStart = new Int32Array(256);
    this.eTextEnd = new Int32Array(256);
    this.eOutStart = new Int32Array(256);
    this.eOutEnd = new Int32Array(256);
    this.eHasGroup = new Uint8Array(256);
    this.nEntries = 0;
    this.table = new Int32Array(256);
    this.tableLen = 0;
    this.outStart = 0;
    this.outEnd = 0;
    this.hasGroup = false;
  }

  private addBytes(src: Uint8Array, start: number, end: number): void {
    const len = end - start;
    const need = this.nBytes + len;
    if (need > this.bytes.length) {
      let cap = this.bytes.length;
      while (cap < need) cap = cap * 2;
      const nb = new Uint8Array(cap);
      nb.set(this.bytes.subarray(0, this.nBytes));
      this.bytes = nb;
    }
    const dst = this.bytes;
    const at = this.nBytes;
    if (len < 16) {
      for (let i = 0; i < len; i++) dst[at + i] = src[start + i] | 0;
    } else {
      dst.set(src.subarray(start, end), at);
    }
    this.nBytes = need;
  }

  /** A number for all that the way a declaration is printed depends on besides its text: `flags`, and the name of the
   * at-rule that it is in (`atRule[start, end)`). */
  context(flags: number, atRule: Uint8Array, start: number, end: number): number {
    if (this.nBytes + this.nEntries * ENTRY_SIZE + this.tableLen * 4 > MAX_BYTES) {
      this.firstContext = (this.firstContext + this.nContexts) | 0;
      this.nBytes = 0;
      this.nContexts = 0;
      this.nEntries = 0;
      this.tableLen = 0;
    }
    const len = end - start;
    let known = -1;
    for (let i = 0; i < this.nContexts; i++) {
      if ((this.ctxFlags[i] | 0) !== flags) continue;
      const s = this.ctxAtStart[i] | 0;
      if (((this.ctxAtEnd[i] | 0) - s) !== len) continue;
      let eq = true;
      for (let k = 0; k < len; k++) {
        if ((this.bytes[s + k] | 0) !== (atRule[start + k] | 0)) { eq = false; break; }
      }
      if (eq) { known = i; break; }
    }
    if (known < 0) {
      if (this.nContexts === this.ctxFlags.length) {
        const cap = this.nContexts * 2;
        const f = new Int32Array(cap);
        f.set(this.ctxFlags);
        this.ctxFlags = f;
        const a = new Int32Array(cap);
        a.set(this.ctxAtStart);
        this.ctxAtStart = a;
        const b = new Int32Array(cap);
        b.set(this.ctxAtEnd);
        this.ctxAtEnd = b;
      }
      known = this.nContexts;
      this.ctxFlags[known] = flags | 0;
      this.ctxAtStart[known] = this.nBytes;
      this.addBytes(atRule, start, end);
      this.ctxAtEnd[known] = this.nBytes;
      this.nContexts = known + 1;
    }
    return (this.firstContext + known) | 0;
  }

  /** What has been printed for the declaration `text[start, end)`: true if it is there; then `outStart`/`outEnd` (ranges
   * of `bytes`) and `hasGroup` say what and whether there is a group in it. */
  get(context: number, text: Uint8Array, start: number, end: number): boolean {
    const tableLen = this.tableLen;
    if (tableLen === 0) return false;
    const mask = tableLen - 1;
    const hash = hashBytes(context, text, start, end);
    const len = end - start;
    let at = hash & mask;
    while (true) {
      const slot = this.table[at] | 0;
      if (slot === 0) return false;
      const e = slot - 1;
      if ((this.eHash[e] | 0) === hash && (this.eContext[e] | 0) === context) {
        const ts = this.eTextStart[e] | 0;
        if (((this.eTextEnd[e] | 0) - ts) === len) {
          let eq = true;
          const bytes = this.bytes;
          for (let k = 0; k < len; k++) {
            if ((bytes[ts + k] | 0) !== (text[start + k] | 0)) { eq = false; break; }
          }
          if (eq) {
            this.outStart = this.eOutStart[e] | 0;
            this.outEnd = this.eOutEnd[e] | 0;
            this.hasGroup = (this.eHasGroup[e] | 0) !== 0;
            return true;
          }
        }
      }
      at = (at + 1) & mask;
    }
  }

  /** `text` is not there yet. */
  insert(
    context: number,
    text: Uint8Array,
    start: number,
    end: number,
    output: Uint8Array,
    outStart: number,
    outEnd: number,
    hasGroup: boolean,
  ): void {
    if ((this.nEntries + 1) * 2 > this.tableLen) {
      const len = this.tableLen * 2 > 256 ? this.tableLen * 2 : 256;
      if (this.table.length < len) this.table = new Int32Array(len);
      else this.table.fill(0, 0, len);
      this.tableLen = len;
      for (let index = 0; index < this.nEntries; index++) this.place(index);
    }
    if (this.nEntries === this.eHash.length) this.growEntries();
    const i = this.nEntries;
    const textStart = this.nBytes;
    this.addBytes(text, start, end);
    const textEnd = this.nBytes;
    this.addBytes(output, outStart, outEnd);
    this.eHash[i] = hashBytes(context, text, start, end);
    this.eContext[i] = context | 0;
    this.eTextStart[i] = textStart;
    this.eTextEnd[i] = textEnd;
    this.eOutStart[i] = textEnd;
    this.eOutEnd[i] = this.nBytes;
    this.eHasGroup[i] = hasGroup ? 1 : 0;
    this.nEntries = i + 1;
    this.place(i);
  }

  private growEntries(): void {
    const cap = this.eHash.length * 2;
    const a = new Int32Array(cap);
    a.set(this.eHash);
    this.eHash = a;
    const b = new Int32Array(cap);
    b.set(this.eContext);
    this.eContext = b;
    const c = new Int32Array(cap);
    c.set(this.eTextStart);
    this.eTextStart = c;
    const d = new Int32Array(cap);
    d.set(this.eTextEnd);
    this.eTextEnd = d;
    const e = new Int32Array(cap);
    e.set(this.eOutStart);
    this.eOutStart = e;
    const f = new Int32Array(cap);
    f.set(this.eOutEnd);
    this.eOutEnd = f;
    const g = new Uint8Array(cap);
    g.set(this.eHasGroup);
    this.eHasGroup = g;
  }

  // Puts the entry `index` into the table, which has room.
  private place(index: number): void {
    const mask = this.tableLen - 1;
    let at = (this.eHash[index] | 0) & mask;
    while ((this.table[at] | 0) !== 0) at = (at + 1) & mask;
    this.table[at] = (index + 1) | 0;
  }
}
