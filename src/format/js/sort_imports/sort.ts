// Port of vendor/bun/src/format/js/sort_imports/sort.rs and of `array_sort_by` of vendor/bun/src/lint/utils/array.rs: `Array.prototype.sort`
// the way V8 does it (14.6: TimSort), for comparisons that are not a total order. What compares equal stays in order.
//
//   sortedPlaces(n, isBefore): Int32Array   -- `places[k]` is the index (in 0..n) of the item that is k-th
//   stableSortBy(items, compare)            -- `items` (a `number[]` of ints) sorted in place, `compare(a, b) < 0`: a is before b
//
// `isBefore(a, b)` is `compare(items[a], items[b]) < 0`, with indices into the array that is sorted.

type IsBefore = (a: number, b: number) => boolean;

const MIN_GALLOP_WINS = 7;

class Run {
  start: number;
  length: number;
  constructor(start: number, length: number) {
    this.start = start;
    this.length = length;
  }
}

/** `SortState` */
class Runs {
  work: Int32Array;
  pending: Run[];
  minGallop: number;
  isBefore: IsBefore;
  constructor(work: Int32Array, isBefore: IsBefore) {
    this.work = work;
    this.pending = [];
    this.minGallop = MIN_GALLOP_WINS;
    this.isBefore = isBefore;
  }
}

/** `BinaryInsertionSort`. `work[lo..hi)`; `work[lo..lo + sorted)` is sorted. */
function binaryInsertionSort(work: Int32Array, lo: number, hi: number, sorted: number, isBefore: IsBefore): void {
  for (let next = lo + (sorted < 1 ? 1 : sorted); next < hi; next++) {
    const pivot = work[next] | 0;
    let left = lo;
    let right = next;
    while (left < right) {
      const middle = left + ((right - left) >> 1);
      if (isBefore(pivot, work[middle] | 0)) right = middle;
      else left = middle + 1;
    }
    for (let k = next; k > left; k--) work[k] = work[k - 1] | 0;
    work[left] = pivot | 0;
  }
}

/** `CountAndMakeRun`: how many items at the start of `work[lo..hi)` ascend, or descend and are reversed. */
function countAndMakeRun(work: Int32Array, lo: number, hi: number, isBefore: IsBefore): number {
  const n = hi - lo;
  if (n < 2) return n;
  const isDescending = isBefore(work[lo + 1] | 0, work[lo] | 0);
  let length = 2;
  while (length < n && isBefore(work[lo + length] | 0, work[lo + length - 1] | 0) === isDescending) length = length + 1;
  if (isDescending) {
    let i = lo;
    let j = lo + length - 1;
    while (i < j) {
      const t = work[i] | 0;
      work[i] = work[j] | 0;
      work[j] = t | 0;
      i = i + 1;
      j = j - 1;
    }
  }
  return length;
}

/** `GallopLeft` (side 0: before what is equal to the key) and `GallopRight` (side 1: after it) on `run[off..off + len)`. */
function gallop(side: number, run: Int32Array, off: number, len: number, key: number, hint: number, isBefore: IsBefore): number {
  // is_below(at)
  let last = 0;
  let offset = 1;
  let from = 0;
  let to = 0;
  const below = side === 0 ? isBefore(run[off + hint] | 0, key) : !isBefore(key, run[off + hint] | 0);
  if (below) {
    const max = len - hint;
    while (offset < max && (side === 0 ? isBefore(run[off + hint + offset] | 0, key) : !isBefore(key, run[off + hint + offset] | 0))) {
      last = offset;
      offset = offset * 2 + 1;
    }
    from = hint + last + 1;
    to = hint + (offset < max ? offset : max);
  } else {
    const max = hint + 1;
    while (offset < max && !(side === 0 ? isBefore(run[off + hint - offset] | 0, key) : !isBefore(key, run[off + hint - offset] | 0))) {
      last = offset;
      offset = offset * 2 + 1;
    }
    from = max - (offset < max ? offset : max);
    to = hint - last;
  }
  while (from < to) {
    const middle = from + ((to - from) >> 1);
    const isBelow = side === 0 ? isBefore(run[off + middle] | 0, key) : !isBefore(key, run[off + middle] | 0);
    if (isBelow) from = middle + 1;
    else to = middle;
  }
  return to;
}

function copyWithin(work: Int32Array, target: number, start: number, end: number): void {
  // `copy_within`: like memmove
  const n = end - start;
  if (target <= start) {
    for (let i = 0; i < n; i++) work[target + i] = work[start + i] | 0;
  } else {
    for (let i = n - 1; i >= 0; i--) work[target + i] = work[start + i] | 0;
  }
}

/** `MergeLow`: from the front. `a`, `b`: how many of each run are left; they end at `end`. */
function mergeLow(r: Runs, start: number, a0: number, b0: number): void {
  const work = r.work;
  const isBefore = r.isBefore;
  let a = a0;
  let b = b0;
  let minGallop = r.minGallop;
  const end = start + a + b;
  const count = a;
  const temp = new Int32Array(count);
  for (let i = 0; i < count; i++) temp[i] = work[start + i] | 0;
  merged: {
    work[end - a - b] = work[end - b] | 0;
    b = b - 1;
    if (b === 0 || a === 1) break merged;
    while (true) {
      let winsA = 0;
      let winsB = 0;
      while (winsA < minGallop && winsB < minGallop) {
        if (isBefore(work[end - b] | 0, temp[count - a] | 0)) {
          work[end - a - b] = work[end - b] | 0;
          b = b - 1;
          winsA = 0;
          winsB = winsB + 1;
          if (b === 0) break merged;
        } else {
          work[end - a - b] = temp[count - a] | 0;
          a = a - 1;
          winsA = winsA + 1;
          winsB = 0;
          if (a === 1) break merged;
        }
      }
      minGallop = minGallop + 1;
      while (true) {
        minGallop = minGallop - 1 > 1 ? minGallop - 1 : 1;
        winsA = gallop(1, temp, count - a, a, work[end - b] | 0, 0, isBefore);
        for (let i = 0; i < winsA; i++) work[end - a - b + i] = temp[count - a + i] | 0;
        a = a - winsA;
        if (a <= 1) break merged;
        work[end - a - b] = work[end - b] | 0;
        b = b - 1;
        if (b === 0) break merged;
        winsB = gallop(0, work, end - b, b, temp[count - a] | 0, 0, isBefore);
        copyWithin(work, end - a - b, end - b, end - b + winsB);
        b = b - winsB;
        if (b === 0) break merged;
        work[end - a - b] = temp[count - a] | 0;
        a = a - 1;
        if (a === 1) break merged;
        if (winsA < MIN_GALLOP_WINS && winsB < MIN_GALLOP_WINS) break;
      }
      minGallop = minGallop + 1;
    }
  }
  r.minGallop = minGallop;
  copyWithin(work, end - a - b, end - b, end);
  for (let i = 0; i < a; i++) work[end - a + i] = temp[count - a + i] | 0;
}

/** `MergeHigh`: from the back. `a`, `b`: how many of each run are left; they start at `start`. */
function mergeHigh(r: Runs, start: number, a0: number, b0: number): void {
  const work = r.work;
  const isBefore = r.isBefore;
  let a = a0;
  let b = b0;
  let minGallop = r.minGallop;
  const temp = new Int32Array(b);
  for (let i = 0; i < b; i++) temp[i] = work[start + a + i] | 0;
  merged: {
    work[start + a + b - 1] = work[start + a - 1] | 0;
    a = a - 1;
    if (a === 0 || b === 1) break merged;
    while (true) {
      let winsA = 0;
      let winsB = 0;
      while (winsA < minGallop && winsB < minGallop) {
        if (isBefore(temp[b - 1] | 0, work[start + a - 1] | 0)) {
          work[start + a + b - 1] = work[start + a - 1] | 0;
          a = a - 1;
          winsA = winsA + 1;
          winsB = 0;
          if (a === 0) break merged;
        } else {
          work[start + a + b - 1] = temp[b - 1] | 0;
          b = b - 1;
          winsA = 0;
          winsB = winsB + 1;
          if (b === 1) break merged;
        }
      }
      minGallop = minGallop + 1;
      while (true) {
        minGallop = minGallop - 1 > 1 ? minGallop - 1 : 1;
        winsA = a - gallop(1, work, start, a, temp[b - 1] | 0, a - 1, isBefore);
        copyWithin(work, start + a - winsA + b, start + a - winsA, start + a);
        a = a - winsA;
        if (a === 0) break merged;
        work[start + a + b - 1] = temp[b - 1] | 0;
        b = b - 1;
        if (b === 1) break merged;
        const lastOfA = work[start + a - 1] | 0;
        winsB = b - gallop(0, temp, 0, b, lastOfA, b - 1, isBefore);
        for (let i = 0; i < winsB; i++) work[start + a + b - winsB + i] = temp[b - winsB + i] | 0;
        b = b - winsB;
        if (b <= 1) break merged;
        work[start + a + b - 1] = work[start + a - 1] | 0;
        a = a - 1;
        if (a === 0) break merged;
        if (winsA < MIN_GALLOP_WINS && winsB < MIN_GALLOP_WINS) break;
      }
      minGallop = minGallop + 1;
    }
  }
  r.minGallop = minGallop;
  copyWithin(work, start + b, start, start + a);
  for (let i = 0; i < b; i++) work[start + i] = temp[i] | 0;
}

/** `MergeAt` */
function mergeAt(r: Runs, at: number): void {
  const first = r.pending[at] as Run;
  const second = r.pending[at + 1] as Run;
  r.pending.splice(at + 1, 1);
  first.length = first.length + second.length;
  const work = r.work;
  const firstOfB = work[second.start] | 0;
  const lastOfA = work[second.start - 1] | 0;
  const inPlace = gallop(1, work, first.start, second.start - first.start, firstOfB, 0, r.isBefore);
  const firstLen = second.start - first.start;
  if (inPlace === firstLen) return;
  const b = gallop(0, work, second.start, second.length, lastOfA, second.length - 1, r.isBefore);
  const a = firstLen - inPlace;
  if (b === 0) return;
  if (a <= b) mergeLow(r, first.start + inPlace, a, b);
  else mergeHigh(r, first.start + inPlace, a, b);
}

function runLength(r: Runs, at: number): number {
  return (r.pending[at] as Run).length;
}

function isEstablished(r: Runs, n: number): boolean {
  return n < 2 || runLength(r, n - 2) > runLength(r, n - 1) + runLength(r, n);
}

/** `MergeCollapse` (`all` false) and `MergeForceCollapse` (`all` true). */
function mergeCollapse(r: Runs, all: boolean): void {
  while (r.pending.length > 1) {
    const n = r.pending.length - 2;
    const isForced = all || !isEstablished(r, n + 1) || !isEstablished(r, n);
    if (!isForced && runLength(r, n) > runLength(r, n + 1)) break;
    const isFirstShorter = isForced && n > 0 && runLength(r, n - 1) < runLength(r, n + 1);
    mergeAt(r, isFirstShorter ? n - 1 : n);
  }
}

/** `ArrayTimSort` on `work`. */
function sortPlaces(work: Int32Array, isBefore: IsBefore): void {
  const length = work.length;
  if (length < 8) {
    binaryInsertionSort(work, 0, length, 0, isBefore);
    return;
  }
  // `ComputeMinRunLength`
  let minRun = length;
  let carry = 0;
  while (minRun >= 64) {
    carry = carry | (minRun & 1);
    minRun = minRun >> 1;
  }
  minRun = minRun + carry;
  const runs = new Runs(work, isBefore);
  let low = 0;
  while (low < length) {
    let counted = countAndMakeRun(work, low, length, isBefore);
    if (counted < minRun) {
      const forced = minRun < length - low ? minRun : length - low;
      binaryInsertionSort(work, low, low + forced, counted, isBefore);
      counted = forced;
    }
    runs.pending.push(new Run(low, counted));
    mergeCollapse(runs, false);
    low = low + counted;
  }
  mergeCollapse(runs, true);
}

/** The order that `Array.prototype.sort` puts `0..n` in, where `isBefore(a, b)` is `compare(a, b) < 0`. */
export function sortedPlaces(n: number, isBefore: IsBefore): Int32Array {
  const places = new Int32Array(n);
  for (let i = 0; i < n; i++) places[i] = i | 0;
  sortPlaces(places, isBefore);
  return places;
}

/** `stable_sort_by`: `items` sorted in place the way V8 sorts, `compare(a, b)` is negative if `a` goes first. */
export function stableSortBy(items: number[], compare: (a: number, b: number) => number): void {
  const n = items.length;
  if (n < 2) return;
  const given: number[] = items.slice();
  const places = sortedPlaces(n, (a: number, b: number): boolean => compare(given[a] as number, given[b] as number) < 0);
  for (let i = 0; i < n; i++) items[i] = given[places[i] | 0] as number;
}

/** The same, for a sort by `compare(a, b)` of any items given by index: returns the order. */
export function stableOrder(n: number, compare: (a: number, b: number) => number): Int32Array {
  return sortedPlaces(n, (a: number, b: number): boolean => compare(a, b) < 0);
}
