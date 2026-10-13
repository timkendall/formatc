// Tuned token-scanning kernel used by the thread prototypes (same shape as bench/b2b free-function lexer).
const CT = new Uint8Array(256);
for (let c = 0; c < 256; c++) {
  let k = 0;
  if (c === 32 || c === 9 || c === 10 || c === 13) k = 1;
  else if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c >= 128) k = 2;
  else if (c >= 48 && c <= 57) k = 3;
  else if (c === 34 || c === 39 || c === 96) k = 4;
  else if (c === 47) k = 5;
  CT[c] = k;
}
const IDC = new Uint8Array(256);
for (let c = 0; c < 256; c++) IDC[c] = CT[c] === 2 || CT[c] === 3 ? 1 : 0;

// Scans src[0, n); writes (start,end,kind) triples into out (ring of 65536 triples); returns token count.
export function lexKernel(src: Uint8Array, n: number, out: Int32Array): number {
  let pos = 0;
  let nt = 0;
  while (pos < n) {
    const c = src[pos] | 0;
    const k = CT[c] | 0;
    if (k === 1) { pos = ((pos | 0) + 1) | 0; continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) {
      pos = ((pos | 0) + 1) | 0;
      while (pos < n && (IDC[src[pos] | 0] | 0) === 1) pos = ((pos | 0) + 1) | 0;
      kind = 1;
    } else if (k === 3) {
      pos = ((pos | 0) + 1) | 0;
      while (pos < n && ((IDC[src[pos] | 0] | 0) === 1 || (src[pos] | 0) === 46)) pos = ((pos | 0) + 1) | 0;
      kind = 2;
    } else if (k === 4) {
      pos = ((pos | 0) + 1) | 0;
      while (pos < n && (src[pos] | 0) !== c) { if ((src[pos] | 0) === 92) pos = ((pos | 0) + 1) | 0; pos = ((pos | 0) + 1) | 0; }
      pos = ((pos | 0) + 1) | 0;
      kind = 3;
    } else if (k === 5 && pos + 1 < n && (src[pos + 1] | 0) === 47) {
      while (pos < n && (src[pos] | 0) !== 10) pos = ((pos | 0) + 1) | 0;
      kind = 4;
    } else if (k === 5 && pos + 1 < n && (src[pos + 1] | 0) === 42) {
      pos = ((pos | 0) + 2) | 0;
      while (pos + 1 < n && !((src[pos] | 0) === 42 && (src[pos + 1] | 0) === 47)) pos = ((pos | 0) + 1) | 0;
      pos = ((pos | 0) + 2) | 0;
      kind = 4;
    } else {
      pos = ((pos | 0) + 1) | 0;
      kind = 5;
    }
    const o = (nt & 65535) * 3;
    out[o] = start | 0;
    out[o + 1] = pos | 0;
    out[o + 2] = kind | 0;
    nt = ((nt | 0) + 1) | 0;
  }
  return nt;
}
