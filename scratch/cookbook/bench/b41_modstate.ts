import * as fs from "node:fs";
const data: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const REPS = 5;
const IDC = new Uint8Array(256);
for (let c = 0; c < 256; c++) IDC[c] = ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || (c >= 48 && c <= 57)) ? 1 : 0;
let gpos = 0;
let gend = 0;
let gsrc: Buffer = data;
let gcount = 0;
// scan identifiers using module-level state directly
function scanGlobal(): number {
  gcount = 0;
  while (gpos < gend) {
    if ((IDC[gsrc[gpos] | 0] | 0) === 1) { gcount = ((gcount | 0) + 1) | 0; while (gpos < gend && (IDC[gsrc[gpos] | 0] | 0) === 1) gpos = ((gpos | 0) + 1) | 0; }
    else gpos = ((gpos | 0) + 1) | 0;
  }
  return gcount;
}
// same with locals loaded from module state and stored back
function scanLocalized(): number {
  const src = gsrc; const end = gend; let pos = gpos; let count = 0;
  while (pos < end) {
    if ((IDC[src[pos] | 0] | 0) === 1) { count = ((count | 0) + 1) | 0; while (pos < end && (IDC[src[pos] | 0] | 0) === 1) pos = ((pos | 0) + 1) | 0; }
    else pos = ((pos | 0) + 1) | 0;
  }
  gpos = pos;
  return count;
}
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { gpos = 0; gend = data.length; const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(28), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s r=", r);
}
bench("module-level let state", scanGlobal); bench("localized from module", scanLocalized);
