import * as fs from "node:fs";
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const REPS = 5;
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

// Pull-style lexer: next() sets start/end/kind fields, returns kind (0 = EOF).
class Lexer {
  src: Uint8Array;
  end: number;
  pos: number = 0;
  tokStart: number = 0;
  tokEnd: number = 0;
  constructor(src: Uint8Array) { this.src = src; this.end = src.length | 0; }
  next(): number {
    const src = this.src;
    const n = this.end;
    let pos = this.pos | 0;
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
      } else { pos = ((pos | 0) + 1) | 0; kind = 5; }
      this.tokStart = start; this.tokEnd = pos; this.pos = pos;
      return kind;
    }
    this.pos = pos;
    return 0;
  }
}
function pull(src: Uint8Array): number { const lx = new Lexer(src); let cnt = 0; let sum = 0; while (true) { const k = lx.next(); if (k === 0) break; cnt = ((cnt | 0) + 1) | 0; sum = ((sum | 0) + ((lx.tokEnd | 0) - (lx.tokStart | 0))) | 0; } return cnt + sum * 0; }
// Same but fields not hoisted (naive port)
class LexerNaive {
  src: Uint8Array; end: number; pos: number = 0; tokStart: number = 0; tokEnd: number = 0;
  constructor(src: Uint8Array) { this.src = src; this.end = src.length; }
  isIdent(): boolean { return IDC[this.src[this.pos]] === 1; }
  next(): number {
    while (this.pos < this.end) {
      const c = this.src[this.pos];
      const k = CT[c];
      if (k === 1) { this.pos++; continue; }
      const start = this.pos;
      let kind = 0;
      if (k === 2) { this.pos++; while (this.pos < this.end && this.isIdent()) this.pos++; kind = 1; }
      else if (k === 3) { this.pos++; while (this.pos < this.end && (this.isIdent() || this.src[this.pos] === 46)) this.pos++; kind = 2; }
      else if (k === 4) { this.pos++; while (this.pos < this.end && this.src[this.pos] !== c) { if (this.src[this.pos] === 92) this.pos++; this.pos++; } this.pos++; kind = 3; }
      else if (k === 5 && this.pos + 1 < this.end && this.src[this.pos + 1] === 47) { while (this.pos < this.end && this.src[this.pos] !== 10) this.pos++; kind = 4; }
      else if (k === 5 && this.pos + 1 < this.end && this.src[this.pos + 1] === 42) { this.pos += 2; while (this.pos + 1 < this.end && !(this.src[this.pos] === 42 && this.src[this.pos + 1] === 47)) this.pos++; this.pos += 2; kind = 4; }
      else { this.pos++; kind = 5; }
      this.tokStart = start; this.tokEnd = this.pos;
      return kind;
    }
    return 0;
  }
}
function pullNaive(src: Uint8Array): number { const lx = new LexerNaive(src); let cnt = 0; while (true) { const k = lx.next(); if (k === 0) break; cnt++; } return cnt; }
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s  tokens=", r);
}
bench("pull lexer (tuned)", () => pull(data));
bench("pull lexer (naive port)", () => pullNaive(data));
