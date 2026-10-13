// Port of vendor/bun/src/md/entity.rs: HTML named entity lookup.
import { ENTITY_CODEPOINTS, ENTITY_NAMES } from "./tables.ts";
import { decodeB36 } from "./unicode.ts";

let names: Uint8Array = new Uint8Array(0);
/** `offsets[i]..offsets[i + 1]` is name `i`. */
let offsets: Int32Array = new Int32Array(0);
let cps: Int32Array = new Int32Array(0);
let ready = false;

function init(): void {
  const s = ENTITY_NAMES;
  const n = s.length;
  names = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i) | 0;
    names[i] = c | 0;
    if (c === 59) count = ((count | 0) + 1) | 0;
  }
  offsets = new Int32Array(count + 1);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if ((names[i] | 0) === 59) {
      k = (k + 1) | 0;
      offsets[k] = (i + 1) | 0;
    }
  }
  cps = decodeB36(ENTITY_CODEPOINTS, 0, ENTITY_CODEPOINTS.length);
  ready = true;
}

/**
 * Looks up an HTML entity by name (including `&` prefix and `;` suffix): `buf[start, end)`. Binary search over the
 * sorted, concatenated names. Returns the index of the entity or -1; its codepoints are `entityCodepoint0/1`.
 */
export function lookupEntity(buf: Uint8Array, start: number, end: number): number {
  if (end <= start || (buf[start] | 0) !== 38) return -1;
  if (!ready) init();
  const ns = start + 1;
  const nlen = end - ns;
  const nm = names;
  const offs = offsets;
  let low = 0;
  let high = offs.length - 1;
  while (low < high) {
    const mid = low + ((high - low) >> 1);
    const a = offs[mid] | 0;
    const alen = (offs[mid + 1] | 0) - a;
    // entity_name(mid).cmp(name)
    const m = alen < nlen ? alen : nlen;
    let cmp = 0;
    for (let i = 0; i < m; i++) {
      const x = nm[a + i] | 0;
      const y = buf[ns + i] | 0;
      if (x !== y) {
        cmp = x < y ? -1 : 1;
        break;
      }
    }
    if (cmp === 0) cmp = alen < nlen ? -1 : alen > nlen ? 1 : 0;
    if (cmp < 0) low = mid + 1;
    else if (cmp > 0) high = mid;
    else return mid;
  }
  return -1;
}

export function entityCodepoint0(index: number): number {
  return cps[2 * index] | 0;
}

/** 0 if the entity has one codepoint only. */
export function entityCodepoint1(index: number): number {
  return cps[2 * index + 1] | 0;
}
