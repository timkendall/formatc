import * as fs from "node:fs";
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const REPS = 5;

const CT = new Uint8Array(256); // 1 ws, 2 ident start, 3 digit, 4 quote, 5 slash, 0 punct
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

// L1: free function, local pos, writes tokens into preallocated Int32Array
function lexFree(src: Uint8Array, out: Int32Array): number {
  const n = src.length;
  let pos = 0;
  let nt = 0;
  while (pos < n) {
    const c = src[pos];
    const k = CT[c];
    if (k === 1) { pos++; continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) {
      pos++;
      while (pos < n && IDC[src[pos]] === 1) pos++;
      kind = 1;
    } else if (k === 3) {
      pos++;
      while (pos < n && (IDC[src[pos]] === 1 || src[pos] === 46)) pos++;
      kind = 2;
    } else if (k === 4) {
      pos++;
      while (pos < n && src[pos] !== c) { if (src[pos] === 92) pos++; pos++; }
      pos++;
      kind = 3;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 47) {
      while (pos < n && src[pos] !== 10) pos++;
      kind = 4;
    } else if (k === 5 && pos + 1 < n && src[pos + 1] === 42) {
      pos += 2;
      while (pos + 1 < n && !(src[pos] === 42 && src[pos + 1] === 47)) pos++;
      pos += 2;
      kind = 4;
    } else {
      pos++;
      kind = 5;
    }
    if (nt * 3 + 2 < out.length) { out[nt * 3] = start; out[nt * 3 + 1] = pos; out[nt * 3 + 2] = kind; }
    nt++;
  }
  return nt;
}

// L2: class Lexer with fields
class Lexer {
  src: Uint8Array;
  pos: number = 0;
  end: number;
  nt: number = 0;
  out: Int32Array;
  constructor(src: Uint8Array, out: Int32Array) { this.src = src; this.end = src.length; this.out = out; }
  scanIdent(): void {
    this.pos++;
    while (this.pos < this.end && IDC[this.src[this.pos]] === 1) this.pos++;
  }
  scanNumber(): void {
    this.pos++;
    while (this.pos < this.end && (IDC[this.src[this.pos]] === 1 || this.src[this.pos] === 46)) this.pos++;
  }
  scanString(q: number): void {
    this.pos++;
    while (this.pos < this.end && this.src[this.pos] !== q) { if (this.src[this.pos] === 92) this.pos++; this.pos++; }
    this.pos++;
  }
  emit(start: number, kind: number): void {
    const nt = this.nt;
    if (nt * 3 + 2 < this.out.length) { this.out[nt * 3] = start; this.out[nt * 3 + 1] = this.pos; this.out[nt * 3 + 2] = kind; }
    this.nt = nt + 1;
  }
  run(): number {
    while (this.pos < this.end) {
      const c = this.src[this.pos];
      const k = CT[c];
      if (k === 1) { this.pos++; continue; }
      const start = this.pos;
      let kind = 0;
      if (k === 2) { this.scanIdent(); kind = 1; }
      else if (k === 3) { this.scanNumber(); kind = 2; }
      else if (k === 4) { this.scanString(c); kind = 3; }
      else if (k === 5 && this.pos + 1 < this.end && this.src[this.pos + 1] === 47) {
        while (this.pos < this.end && this.src[this.pos] !== 10) this.pos++;
        kind = 4;
      } else if (k === 5 && this.pos + 1 < this.end && this.src[this.pos + 1] === 42) {
        this.pos += 2;
        while (this.pos + 1 < this.end && !(this.src[this.pos] === 42 && this.src[this.pos + 1] === 47)) this.pos++;
        this.pos += 2;
        kind = 4;
      } else { this.pos++; kind = 5; }
      this.emit(start, kind);
    }
    return this.nt;
  }
}

// L3: module-level state
let gsrc: Uint8Array = new Uint8Array(0);
let gpos = 0;
let gend = 0;
function gScanIdent(): void {
  gpos++;
  while (gpos < gend && IDC[gsrc[gpos]] === 1) gpos++;
}
function lexGlobal(src: Uint8Array, out: Int32Array): number {
  gsrc = src; gpos = 0; gend = src.length;
  let nt = 0;
  while (gpos < gend) {
    const c = gsrc[gpos];
    const k = CT[c];
    if (k === 1) { gpos++; continue; }
    const start = gpos;
    let kind = 0;
    if (k === 2) { gScanIdent(); kind = 1; }
    else if (k === 3) { gpos++; while (gpos < gend && (IDC[gsrc[gpos]] === 1 || gsrc[gpos] === 46)) gpos++; kind = 2; }
    else if (k === 4) { gpos++; while (gpos < gend && gsrc[gpos] !== c) { if (gsrc[gpos] === 92) gpos++; gpos++; } gpos++; kind = 3; }
    else if (k === 5 && gpos + 1 < gend && gsrc[gpos + 1] === 47) { while (gpos < gend && gsrc[gpos] !== 10) gpos++; kind = 4; }
    else if (k === 5 && gpos + 1 < gend && gsrc[gpos + 1] === 42) { gpos += 2; while (gpos + 1 < gend && !(gsrc[gpos] === 42 && gsrc[gpos + 1] === 47)) gpos++; gpos += 2; kind = 4; }
    else { gpos++; kind = 5; }
    if (nt * 3 + 2 < out.length) { out[nt * 3] = start; out[nt * 3 + 1] = gpos; out[nt * 3 + 2] = kind; }
    nt++;
  }
  return nt;
}

// L5: free functions with pos passed/returned (scan helper returns new pos)
function scanIdentF(src: Uint8Array, p: number, n: number): number {
  p++;
  while (p < n && IDC[src[p]] === 1) p++;
  return p;
}
function lexHelpers(src: Uint8Array, out: Int32Array): number {
  const n = src.length;
  let pos = 0; let nt = 0;
  while (pos < n) {
    const c = src[pos];
    const k = CT[c];
    if (k === 1) { pos++; continue; }
    const start = pos;
    let kind = 0;
    if (k === 2) { pos = scanIdentF(src, pos, n); kind = 1; }
    else if (k === 3) { pos++; while (pos < n && (IDC[src[pos]] === 1 || src[pos] === 46)) pos++; kind = 2; }
    else if (k === 4) { pos++; while (pos < n && src[pos] !== c) { if (src[pos] === 92) pos++; pos++; } pos++; kind = 3; }
    else if (k === 5 && pos + 1 < n && src[pos + 1] === 47) { while (pos < n && src[pos] !== 10) pos++; kind = 4; }
    else if (k === 5 && pos + 1 < n && src[pos + 1] === 42) { pos += 2; while (pos + 1 < n && !(src[pos] === 42 && src[pos + 1] === 47)) pos++; pos += 2; kind = 4; }
    else { pos++; kind = 5; }
    if (nt * 3 + 2 < out.length) { out[nt * 3] = start; out[nt * 3 + 1] = pos; out[nt * 3 + 2] = kind; }
    nt++;
  }
  return nt;
}

function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(16), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s  tokens=", r);
}
const out = new Int32Array(3 * 12_000_000);
bench("free fn", () => lexFree(data, out));
bench("class fields", () => new Lexer(data, out).run());
bench("module state", () => lexGlobal(data, out));
bench("helper fns", () => lexHelpers(data, out));
