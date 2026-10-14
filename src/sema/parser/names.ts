// Port of vendor/bun/src/sema/parser/names.rs (+ the "own atoms" half of sema/atom.rs): from the spelling of a name to its atom
// and its token kind in one probe.
//
// Rust has two modes (a shared interner with per-thread caches, and the file's OWN atoms). The formatter only ever uses
// the file's own atoms, so this is that mode: one open-addressing hash table, dense atom numbers, per-file reset.
//
//  - Atoms 0..ATOM_FIXED-1 are the `known` atoms (atom.ts), the same in every file. The keywords that are not known atoms
//    follow, also with fixed numbers (so a keyword's atom is the same in every file). Everything else gets the next number
//    where it first occurs in the file. Rust numbers keywords per file; the numbers carry no meaning ("atoms have no order").
//  - The text of an atom is either in the SOURCE (offset = where it first occurred), or in `cooked` (the known texts, and
//    every text that is not written in the source as it is: decoded strings, names with escapes, JSX text). The offset has
//    ELSEWHERE set in the latter case. Read texts only through `textBuf/textStart/textLen`.
//  - `atomToken(a)` is the token kind of the name `a`: the keyword token for a keyword, `T_IDENTIFIER` for everything else.
//    It is a function of the text only, so the lexer gets the kind of a name from its atom, no second lookup.
//  - begin(src, len) resets the table to its seeded state in O(atoms of the previous file) without reallocating.
//  - `mentioned` (Rust's 16K-bit "which names does this file mention" filter for the linter) is not ported.
//
// Lookup without hashing bytes one at a time: a text is identified by its KEY, (k0, k1, k2, len): k0/k1 are its first eight
// bytes (little endian words, zero padded), k2 its last four bytes (zero for len <= 8). That key is EXACT for len <= 12, so
// a match needs no byte comparison; longer texts compare their middle bytes. Keys of source texts are read with
// DataView.getInt32 (a handful of loads instead of a per-byte loop), after the lexer has found the end of the name.
import { ATOM_FIXED, KNOWN_TEXTS } from "../atom.ts";
import { KEYWORDS, T_IDENTIFIER } from "./token.ts";

/** In `meta[a*8+4]` (start): the text is in `cooked`, not in the source. Sources are < 2^30 bytes (Refusal.TooLarge otherwise). */
export const ELSEWHERE = 1 << 30;

// Layout of an atom's row in `meta` (8 Int32).
const M_K0 = 0;
const M_K1 = 1;
const M_K2 = 2;
const M_LEN = 3;
const M_START = 4;
const M_TOK = 5;
const M_SLOT = 6;

const MASK_LO = new Int32Array(9);
const MASK_HI = new Int32Array(9);
for (let len = 0; len <= 8; len++) {
  MASK_LO[len] = len >= 4 ? -1 : len === 0 ? 0 : (1 << (len * 8)) - 1;
  MASK_HI[len] = len <= 4 ? 0 : len >= 8 ? -1 : (1 << ((len - 4) * 8)) - 1;
}

export class Names {
  /** The source of the file that is parsed. Atom texts that are not ELSEWHERE are in here. */
  src: Uint8Array;
  dv: DataView;
  /** 8 Int32 per atom: k0, k1, k2, len, start (| ELSEWHERE), token, table slot, (spare). */
  meta: Int32Array;
  /** Number of atoms (known + seeded keywords + the file's own). */
  count: number;
  /** Open addressing, linear probing: atom + 1, 0 = free. */
  table: Int32Array;
  mask: number;
  cooked: Uint8Array;
  cookedLen: number;
  seededCount: number;
  seededCooked: number;
  /** Scratch for keys computed byte by byte. */
  key: Int32Array;

  constructor() {
    this.src = new Uint8Array(0);
    this.dv = new DataView(this.src.buffer, 0, 0);
    this.meta = new Int32Array(8 * 1024);
    this.count = 0;
    this.table = new Int32Array(2048);
    this.mask = 2047;
    this.cooked = new Uint8Array(8192);
    this.cookedLen = 0;
    this.seededCount = 0;
    this.seededCooked = 0;
    this.key = new Int32Array(4);
    this.seed();
  }

  private seed(): void {
    // Known atoms first, in order: their numbers are constants.
    for (let i = 0; i < KNOWN_TEXTS.length; i++) this.seedText(KNOWN_TEXTS[i]);
    // Then the keywords that are not known atoms.
    for (let i = 0; i < KEYWORDS.length; i++) this.seedText(KEYWORDS[i][0]);
    // Token kinds of the keywords (a known atom that is also a keyword, like `default`, gets it too).
    for (let i = 0; i < KEYWORDS.length; i++) {
      const a = this.seedText(KEYWORDS[i][0]);
      this.meta[a * 8 + M_TOK] = KEYWORDS[i][1];
    }
    this.seededCount = this.count;
    this.seededCooked = this.cookedLen;
  }

  /** Seeds `text` (Latin-1 characters = bytes) unless it is there. Returns its atom. */
  private seedText(text: string): number {
    const n = text.length;
    const tmp = new Uint8Array(n);
    for (let i = 0; i < n; i++) tmp[i] = text.charCodeAt(i) | 0;
    return this.atomOfBytes(tmp, 0, n);
  }

  /** Before a file of `len` bytes is parsed: forgets the atoms of the previous file. */
  begin(src: Uint8Array, len: number): void {
    // Remove in reverse order of insertion: that restores the table exactly (linear probing, no tombstones).
    let c = this.count | 0;
    const keep = this.seededCount | 0;
    while (c > keep) {
      c = ((c | 0) - 1) | 0;
      this.table[this.meta[(c << 3) + M_SLOT] | 0] = 0;
    }
    this.count = keep;
    this.cookedLen = this.seededCooked;
    this.src = src;
    this.dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  }

  /** The key of `buf[start, end)` byte by byte into `this.key` (k0, k1, k2). */
  private keysFromBytes(buf: Uint8Array, start: number, end: number): void {
    const len = (end - start) | 0;
    let k0 = 0;
    let k1 = 0;
    let k2 = 0;
    const m = len < 8 ? len : 8;
    for (let i = 0; i < m; i++) {
      const c = buf[(start + i) | 0] | 0;
      if (i < 4) k0 = k0 | (c << (i << 3));
      else k1 = k1 | (c << ((i - 4) << 3));
    }
    if (len > 8) {
      for (let i = 0; i < 4; i++) k2 = k2 | ((buf[(end - 4 + i) | 0] | 0) << (i << 3));
    }
    this.key[0] = k0;
    this.key[1] = k1;
    this.key[2] = k2;
  }

  /**
   * The atom with the key (k0, k1, k2, len), or `~slot` (< 0): where it would go. `buf[start, start+len)` is the text, for the
   * comparison of the middle bytes of long texts.
   */
  private lookup(buf: Uint8Array, start: number, len: number, k0: number, k1: number, k2: number): number {
    let h = (Math.imul(k0, -1640531535) + Math.imul(k1, -2048144777) + Math.imul(k2, -1028477379) + Math.imul(len, 668265263)) | 0;
    h = h ^ (h >>> 15);
    const mask = this.mask | 0;
    let slot = h & mask;
    while (true) {
      const e = this.table[slot] | 0;
      if (e === 0) return ~slot;
      const r = ((e - 1) << 3) | 0;
      if (
        (this.meta[r + M_LEN] | 0) === len && (this.meta[r + M_K0] | 0) === k0 && (this.meta[r + M_K1] | 0) === k1 &&
        (this.meta[r + M_K2] | 0) === k2
      ) {
        if (len <= 12) return (e - 1) | 0;
        // the bytes 8..len-4 are not in the key
        const s = this.meta[r + M_START] | 0;
        let k = 8;
        const stop = (len - 4) | 0;
        if ((s & ELSEWHERE) === 0) {
          while (k < stop && (this.src[(s + k) | 0] | 0) === (buf[(start + k) | 0] | 0)) k = (k + 1) | 0;
        } else {
          const off = s & ~ELSEWHERE;
          while (k < stop && (this.cooked[(off + k) | 0] | 0) === (buf[(start + k) | 0] | 0)) k = (k + 1) | 0;
        }
        if (k >= stop) return (e - 1) | 0;
      }
      slot = (slot + 1) & mask;
    }
  }

  /** The first index in [from, stop) where `src[a + k]` and `src[b + k]` differ, or `stop`. (Its own function: the local alias is worth it only in a loop.) */
  sameBytes(a: number, b: number, from: number, stop: number): number {
    const src = this.src;
    let k = from | 0;
    for (let i = from | 0; i < stop; i++) {
      if ((src[(a + i) | 0] | 0) !== (src[(b + i) | 0] | 0)) {
        k = i;
        return k;
      }
    }
    return stop;
  }

  /**
   * The atom of the source text `src[start, start+len)` whose key (k0, k1, k2) the caller computed (see the key description above).
   * The probe of `lookup` is inlined here: this is the per-name path of the lexer.
   */
  atomOfKeys(start: number, len: number, k0: number, k1: number, k2: number): number {
    let h = (Math.imul(k0, -1640531535) + Math.imul(k1, -2048144777) + Math.imul(k2, -1028477379) + Math.imul(len, 668265263)) | 0;
    h = h ^ (h >>> 15);
    const mask = this.mask | 0;
    let slot = h & mask;
    while (true) {
      const e = this.table[slot] | 0;
      if (e === 0) break;
      const r = ((e - 1) << 3) | 0;
      if (
        (this.meta[r + M_LEN] | 0) === len && (this.meta[r + M_K0] | 0) === k0 && (this.meta[r + M_K1] | 0) === k1 &&
        (this.meta[r + M_K2] | 0) === k2
      ) {
        if (len <= 12) return (e - 1) | 0;
        // the bytes 8..len-4 are not in the key
        const s = this.meta[r + M_START] | 0;
        let k = 8;
        const stop = (len - 4) | 0;
        if ((s & ELSEWHERE) === 0) {
          k = this.sameBytes(s, start, k, stop);
        } else {
          // a known atom or a decoded value that has the same bytes
          const off = s & ~ELSEWHERE;
          while (k < stop && (this.cooked[(off + k) | 0] | 0) === (this.src[(start + k) | 0] | 0)) k = (k + 1) | 0;
        }
        if (k >= stop) return (e - 1) | 0;
      }
      slot = (slot + 1) & mask;
    }
    return this.insert(start, len, k0, k1, k2, slot);
  }

  /** The atom of the text `src[start, end)`, which is written in the source as it is. */
  atomOfSourceRange(start: number, end: number): number {
    const len = (end - start) | 0;
    let k0 = 0;
    let k1 = 0;
    let k2 = 0;
    if (start + 8 <= this.dv.byteLength && end >= 4) {
      const lm = len < 8 ? len : 8;
      k0 = this.dv.getInt32(start, true) & MASK_LO[lm];
      k1 = this.dv.getInt32((start + 4) | 0, true) & MASK_HI[lm];
      if (len > 8) k2 = this.dv.getInt32((end - 4) | 0, true);
    } else {
      this.keysFromBytes(this.src, start, end);
      k0 = this.key[0] | 0;
      k1 = this.key[1] | 0;
      k2 = this.key[2] | 0;
    }
    const r = this.lookup(this.src, start, len, k0, k1, k2);
    if (r >= 0) return r;
    return this.insert(start, len, k0, k1, k2, ~r);
  }

  /** The atom of the text `buf[start, end)` that is NOT in the source as it is (a decoded value). Copies it if it is new. */
  atomOfBytes(buf: Uint8Array, start: number, end: number): number {
    const len = (end - start) | 0;
    this.keysFromBytes(buf, start, end);
    const k0 = this.key[0] | 0;
    const k1 = this.key[1] | 0;
    const k2 = this.key[2] | 0;
    const r = this.lookup(buf, start, len, k0, k1, k2);
    if (r >= 0) return r;
    // copy to `cooked`
    const at = this.cookedLen | 0;
    if (at + len > this.cooked.length) this.growCooked(at + len);
    for (let i = 0; i < len; i++) this.cooked[(at + i) | 0] = buf[(start + i) | 0] | 0;
    this.cookedLen = (at + len) | 0;
    return this.insert(at | ELSEWHERE, len, k0, k1, k2, ~r);
  }

  /** The atom of an ASCII/Latin-1 JS string (module init, tests). Slow. */
  atomOfString(text: string): number {
    const n = text.length;
    const tmp = new Uint8Array(n);
    for (let i = 0; i < n; i++) tmp[i] = text.charCodeAt(i) | 0;
    return this.atomOfBytes(tmp, 0, n);
  }

  /** The atom of `buf[start, end)` if the file (or the known set) has it, else -1. Nothing is entered. */
  findBytes(buf: Uint8Array, start: number, end: number): number {
    this.keysFromBytes(buf, start, end);
    const r = this.lookup(buf, start, (end - start) | 0, this.key[0] | 0, this.key[1] | 0, this.key[2] | 0);
    return r >= 0 ? r : -1;
  }

  private insert(start: number, len: number, k0: number, k1: number, k2: number, slot: number): number {
    const a = this.count | 0;
    if ((a + 1) * 8 > this.meta.length) this.growAtoms();
    const r = (a << 3) | 0;
    this.meta[r + M_K0] = k0 | 0;
    this.meta[r + M_K1] = k1 | 0;
    this.meta[r + M_K2] = k2 | 0;
    this.meta[r + M_LEN] = len | 0;
    this.meta[r + M_START] = start | 0;
    this.meta[r + M_TOK] = T_IDENTIFIER;
    this.meta[r + M_SLOT] = slot | 0;
    this.table[slot] = (a + 1) | 0;
    this.count = (a + 1) | 0;
    if (((a + 1) | 0) * 2 > this.table.length) this.rehash();
    return a;
  }

  private growAtoms(): void {
    const m = new Int32Array(this.meta.length * 2);
    m.set(this.meta);
    this.meta = m;
  }

  private growCooked(need: number): void {
    let n = this.cooked.length;
    while (n < need) n = n * 2;
    const c = new Uint8Array(n);
    c.set(this.cooked);
    this.cooked = c;
  }

  private rehash(): void {
    const n = this.table.length * 2;
    const t = new Int32Array(n);
    const mask = (n - 1) | 0;
    const count = this.count | 0;
    for (let a = 0; a < count; a++) {
      const r = (a << 3) | 0;
      let h =
        (Math.imul(this.meta[r + M_K0] | 0, -1640531535) + Math.imul(this.meta[r + M_K1] | 0, -2048144777) +
          Math.imul(this.meta[r + M_K2] | 0, -1028477379) + Math.imul(this.meta[r + M_LEN] | 0, 668265263)) | 0;
      h = h ^ (h >>> 15);
      let slot = h & mask;
      while ((t[slot] | 0) !== 0) slot = (slot + 1) & mask;
      t[slot] = (a + 1) | 0;
      this.meta[r + M_SLOT] = slot | 0;
    }
    this.table = t;
    this.mask = mask;
  }

  // ───────────── reading texts (Rust: `Lexer::text_of`, `FileAtoms`) ─────────────

  /** The token kind of the name `a`: the keyword's T_*, or T_IDENTIFIER. */
  atomToken(a: number): number {
    return this.meta[((a << 3) | 0) + M_TOK] | 0;
  }
  /** The buffer that has the text of `a`: the source, or `cooked`. NONE (-1) has no text: check first. */
  textBuf(a: number): Uint8Array {
    return ((this.meta[((a << 3) | 0) + M_START] | 0) & ELSEWHERE) !== 0 ? this.cooked : this.src;
  }
  /** Offset of the text of `a` in `textBuf(a)`. */
  textStart(a: number): number {
    return (this.meta[((a << 3) | 0) + M_START] | 0) & ~ELSEWHERE;
  }
  textLen(a: number): number {
    return this.meta[((a << 3) | 0) + M_LEN] | 0;
  }
  /** Whether the text of `a` is `lit` (ASCII). */
  atomIs(a: number, lit: string): boolean {
    if (a < 0) return false;
    const n = lit.length;
    if (this.textLen(a) !== n) return false;
    const buf = this.textBuf(a);
    const off = this.textStart(a);
    for (let i = 0; i < n; i++) {
      if ((buf[(off + i) | 0] | 0) !== lit.charCodeAt(i)) return false;
    }
    return true;
  }
  /** Debug: the text of `a` as a JS string (UTF-8 decoded). Allocates. */
  atomString(a: number): string {
    if (a < 0) return "";
    const buf = this.textBuf(a);
    const off = this.textStart(a);
    return Buffer.from(buf.buffer, buf.byteOffset + off, this.textLen(a)).toString("utf8");
  }
}
