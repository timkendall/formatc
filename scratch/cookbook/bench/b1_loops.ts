import type { Int32, NoThrow } from "@scriptc/types";
import * as fs from "node:fs";

const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const REPS = 5;

// Table: 0 other, 1 space, 2 ident, 3 digit, 4 punct
const TBL = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let k = 4;
  if (i === 32 || i === 9 || i === 10 || i === 13) k = 1;
  else if ((i >= 97 && i <= 122) || (i >= 65 && i <= 90) || i === 95 || i === 36) k = 2;
  else if (i >= 48 && i <= 57) k = 3;
  TBL[i] = k;
}

// A: plain number, no contracts
function kernelPlain(buf: Uint8Array): number {
  let tokens = 0;
  let prev = 0;
  for (let i = 0; i < buf.length; i++) {
    const k = TBL[buf[i]];
    if (k !== prev) tokens++;
    prev = k;
  }
  return tokens;
}

// B: Int32 contract everywhere with |0
function kernelInt32(buf: Uint8Array): Int32 {
  let tokens: Int32 = 0;
  let prev: Int32 = 0;
  const n: Int32 = buf.length | 0;
  for (let i: Int32 = 0; i < n; i++) {
    const k: Int32 = TBL[buf[i] | 0] | 0;
    if (k !== prev) tokens = (tokens + 1) | 0;
    prev = k;
  }
  return tokens;
}

// C: plain number but with |0 idioms, no contracts
function kernelOr0(buf: Uint8Array): number {
  let tokens = 0;
  let prev = 0;
  const n = buf.length | 0;
  for (let i = 0; i < n; i = (i + 1) | 0) {
    const k = TBL[buf[i]] | 0;
    if (k !== prev) tokens = (tokens + 1) | 0;
    prev = k;
  }
  return tokens;
}

// D: no table; branches only, Int32
function kernelBranch(buf: Uint8Array): Int32 {
  let tokens: Int32 = 0;
  let prev: Int32 = 0;
  const n: Int32 = buf.length | 0;
  for (let i: Int32 = 0; i < n; i++) {
    const c: Int32 = buf[i] | 0;
    let k: Int32 = 4;
    if (c === 32 || c === 9 || c === 10 || c === 13) k = 1;
    else if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36) k = 2;
    else if (c >= 48 && c <= 57) k = 3;
    if (k !== prev) tokens = (tokens + 1) | 0;
    prev = k;
  }
  return tokens;
}

// E: just sum bytes (floor)
function kernelSum(buf: Uint8Array): Int32 {
  let s: Int32 = 0;
  const n: Int32 = buf.length | 0;
  for (let i: Int32 = 0; i < n; i++) s = (s + (buf[i] | 0)) | 0;
  return s;
}

function bench(name: string, f: (b: Uint8Array) => number): void {
  let best = 1e18;
  let r = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const t0 = performance.now();
    r = f(data);
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  console.log(name.padEnd(12), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s  r=", r);
}

bench("plain", kernelPlain);
bench("int32", kernelInt32);
bench("or0", kernelOr0);
bench("branch", kernelBranch);
bench("sum", kernelSum);
