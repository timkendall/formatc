// Port of vendor/bun/src/format/sort.rs: stable sorts compiled once for the whole program, not once per type and
// closure. All are stable.
//
// Rust sorts a slice of anything through a list of indices. Here the things to sort are always ints (handles,
// element indices, positions), so the sort works on an `Int32Array` range `[lo, hi)` in place, with either a
// comparison function or an int key per element. Do not use `TypedArray.prototype.sort` (unsupported by scriptc).
// Stable merge sort; insertion sort below 12 elements.

let tmp = new Int32Array(256);

// Sorts a[lo, hi) stably by `cmp(x, y)` (negative: x first, 0: keep order, positive: y first).
export function sortInt32By(a: Int32Array, lo: number, hi: number, cmp: (x: number, y: number) => number): void {
  const n = hi - lo;
  if (n < 2) return;
  if (n <= 12) {
    insertionBy(a, lo, hi, cmp);
    return;
  }
  if (tmp.length < n) tmp = new Int32Array(n * 2);
  mergeSortBy(a, lo, hi, cmp);
}

function insertionBy(a: Int32Array, lo: number, hi: number, cmp: (x: number, y: number) => number): void {
  for (let i = lo + 1; i < hi; i++) {
    const v = a[i] | 0;
    let j = i - 1;
    while (j >= lo && cmp(a[j] | 0, v) > 0) {
      a[j + 1] = a[j] | 0;
      j = j - 1;
    }
    a[j + 1] = v | 0;
  }
}

function mergeSortBy(a: Int32Array, lo: number, hi: number, cmp: (x: number, y: number) => number): void {
  const n = hi - lo;
  if (n <= 12) {
    insertionBy(a, lo, hi, cmp);
    return;
  }
  const mid = lo + (n >> 1);
  mergeSortBy(a, lo, mid, cmp);
  mergeSortBy(a, mid, hi, cmp);
  // Already in order?
  if (cmp(a[mid - 1] | 0, a[mid] | 0) <= 0) return;
  const t = tmp;
  const ln = mid - lo;
  for (let i = 0; i < ln; i++) t[i] = a[lo + i] | 0;
  let i = 0;
  let j = mid;
  let k = lo;
  while (i < ln && j < hi) {
    const x = t[i] | 0;
    const y = a[j] | 0;
    if (cmp(x, y) <= 0) {
      a[k] = x | 0;
      i = i + 1;
    } else {
      a[k] = y | 0;
      j = j + 1;
    }
    k = k + 1;
  }
  while (i < ln) {
    a[k] = t[i] | 0;
    i = i + 1;
    k = k + 1;
  }
}

// Sorts a[lo, hi) stably by `keys[a[i]]` ascending (no closure: for ints sorted by a per-element int key).
export function sortInt32ByKey(a: Int32Array, lo: number, hi: number, keys: Int32Array): void {
  const n = hi - lo;
  if (n < 2) return;
  if (tmp.length < n) tmp = new Int32Array(n * 2);
  mergeSortKey(a, lo, hi, keys);
}

function mergeSortKey(a: Int32Array, lo: number, hi: number, keys: Int32Array): void {
  const n = hi - lo;
  if (n <= 12) {
    for (let i = lo + 1; i < hi; i++) {
      const v = a[i] | 0;
      const kv = keys[v] | 0;
      let j = i - 1;
      while (j >= lo && (keys[a[j] | 0] | 0) > kv) {
        a[j + 1] = a[j] | 0;
        j = j - 1;
      }
      a[j + 1] = v | 0;
    }
    return;
  }
  const mid = lo + (n >> 1);
  mergeSortKey(a, lo, mid, keys);
  mergeSortKey(a, mid, hi, keys);
  if ((keys[a[mid - 1] | 0] | 0) <= (keys[a[mid] | 0] | 0)) return;
  const t = tmp;
  const ln = mid - lo;
  for (let i = 0; i < ln; i++) t[i] = a[lo + i] | 0;
  let i = 0;
  let j = mid;
  let k = lo;
  while (i < ln && j < hi) {
    const x = t[i] | 0;
    const y = a[j] | 0;
    if ((keys[x] | 0) <= (keys[y] | 0)) {
      a[k] = x | 0;
      i = i + 1;
    } else {
      a[k] = y | 0;
      j = j + 1;
    }
    k = k + 1;
  }
  while (i < ln) {
    a[k] = t[i] | 0;
    i = i + 1;
    k = k + 1;
  }
}
