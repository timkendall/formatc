// Port of vendor/bun/src/md/unicode.rs: Unicode case folding (md4c's tables), decoded lazily from tables.ts.
import { FOLD_MAP_1, FOLD_MAP_2, FOLD_MAP_3 } from "./tables.ts";

/** The result of `caseFold`: `n` codepoints in `c0..c2`. */
export class FoldInfo {
  n = 1;
  c0 = 0;
  c1 = 0;
  c2 = 0;
}
export const FOLD = new FoldInfo();

const K_SINGLE = 0;
const K_RANGE_START = 1;
const K_RANGE_END = 2;

class FoldMap {
  kind: Uint8Array = new Uint8Array(0);
  cp: Int32Array = new Int32Array(0);
  data: Int32Array = new Int32Array(0);
  n = 1;
}

let map1: FoldMap | null = null;
let map2: FoldMap | null = null;
let map3: FoldMap | null = null;

function decodeFoldMap(src: string, n: number): FoldMap {
  const bar = src.indexOf("|");
  const m = new FoldMap();
  m.n = n;
  const a = decodeB36(src, 0, bar);
  const d = decodeB36(src, bar + 1, src.length);
  const count = (a.length / 2) | 0;
  m.kind = new Uint8Array(count);
  m.cp = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    m.kind[i] = a[2 * i] | 0;
    m.cp[i] = a[2 * i + 1] | 0;
  }
  m.data = d;
  return m;
}

/** Decodes the comma separated base-36 numbers of `s[from, to)`. */
export function decodeB36(s: string, from: number, to: number): Int32Array {
  let count = 1;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 44) count = ((count | 0) + 1) | 0;
  if (to === from) return new Int32Array(0);
  const out = new Int32Array(count);
  let k = 0;
  let v = 0;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i) | 0;
    if (c === 44) {
      out[k] = v | 0;
      k = (k + 1) | 0;
      v = 0;
    } else {
      v = v * 36 + (c <= 57 ? c - 48 : c - 87);
    }
  }
  out[k] = v | 0;
  return out;
}

/**
 * Binary search over a sorted map of codepoints, supporting both single values and ranges. Returns the physical index of
 * the found record (for ranges, the index of the range-start entry), or -1. A direct port of md4c's
 * `md_unicode_bsearch__`.
 */
function unicodeBsearch(codepoint: number, m: FoldMap): number {
  const kind = m.kind;
  const cps = m.cp;
  const len = cps.length;
  if (len === 0) return -1;
  let beg = 0;
  let end = len - 1;
  while (beg <= end) {
    let pivotBeg = (beg + end) >> 1;
    let pivotEnd = pivotBeg;
    // If pivot points at a range-start entry, the range-end is the next entry.
    if ((kind[pivotEnd] | 0) === K_RANGE_START) pivotEnd = ((pivotEnd | 0) + 1) | 0;
    // If pivot points at a range-end entry, the range-start is the previous entry.
    if ((kind[pivotBeg] | 0) === K_RANGE_END) {
      if (pivotBeg === 0) return -1;
      pivotBeg = ((pivotBeg | 0) - 1) | 0;
    }
    const lo = cps[pivotBeg] | 0;
    const hi = cps[pivotEnd] | 0;
    if (codepoint < lo) {
      if (pivotBeg === 0) return -1;
      end = pivotBeg - 1;
    } else if (codepoint > hi) {
      beg = pivotEnd + 1;
    } else {
      return pivotBeg;
    }
  }
  return -1;
}

function caseFoldFromMap(m: FoldMap, codepoint: number): boolean {
  const index = unicodeBsearch(codepoint, m);
  if (index < 0) return false;
  const n = m.n;
  const off = index * n;
  const data = m.data;
  let c0 = data[off] | 0;
  const c1 = n > 1 ? data[off + 1] | 0 : 0;
  const c2 = n > 2 ? data[off + 2] | 0 : 0;
  // If the codepoint doesn't exactly match the map entry, we are inside a range and need to adjust the first output codepoint.
  const mapCp = m.cp[index] | 0;
  if (mapCp !== codepoint) {
    if (mapCp + 1 === c0) {
      // Alternating type of the range. e.g. 0x0100->0x0101, 0x0101->0x0101, 0x0102->0x0103, ...
      c0 = codepoint + ((codepoint & 1) === (mapCp & 1) ? 1 : 0);
    } else {
      // Range-to-range mapping: offset from range start.
      c0 = c0 + (codepoint - mapCp);
    }
  }
  const FOLD$ = FOLD;
  FOLD$.n = n;
  FOLD$.c0 = c0;
  FOLD$.c1 = c1;
  FOLD$.c2 = c2;
  return true;
}

/**
 * The Unicode case-folded version of a codepoint, written to `FOLD`. If no folding is needed it is the codepoint itself.
 * A direct port of md4c's `md_get_unicode_fold_info`.
 */
export function caseFold(codepoint: number): void {
  const FOLD$ = FOLD;
  FOLD$.c1 = 0;
  FOLD$.c2 = 0;
  // Fast path for ASCII characters.
  if (codepoint <= 0x7f) {
    FOLD$.n = 1;
    FOLD$.c0 = codepoint >= 65 && codepoint <= 90 ? codepoint + 32 : codepoint;
    return;
  }
  if (map1 === null) {
    map1 = decodeFoldMap(FOLD_MAP_1, 1);
    map2 = decodeFoldMap(FOLD_MAP_2, 2);
    map3 = decodeFoldMap(FOLD_MAP_3, 3);
  }
  if (caseFoldFromMap(map1, codepoint)) return;
  if (caseFoldFromMap(map2 as FoldMap, codepoint)) return;
  if (caseFoldFromMap(map3 as FoldMap, codepoint)) return;
  // No mapping found -- map the codepoint to itself.
  FOLD$.n = 1;
  FOLD$.c0 = codepoint;
}
