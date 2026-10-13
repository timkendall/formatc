// Hot-loop template: a pull-style byte lexer with every measured scriptc 0.3.0 idiom applied.
// 609 MB/s compiled vs 811 MB/s Node vs ~744 MB/s for the same algorithm in C -O2 on the vscode corpus
// (a naive port of the same code, with `this.` fields in the loop and `pos++`, runs 345 MB/s).
//
// Idioms used (see docs/SCRIPTC_COOKBOOK.md section 2):
//  1. copy fields into locals at method entry, write back once at exit
//  2. cursor arithmetic is `p = ((p | 0) + k) | 0` (all operands int32-typed => real i32 math)
//  3. every typed-array read is `x[i] | 0`; table lookups index with an int32-typed value
//  4. dispatch through a 256-entry Uint8Array class table, not a big switch
//  5. no strings, no closures, no allocation in the loop
import { CC } from "./bytes.ts";

export const T_EOF = 0;
export const T_IDENT = 1;
export const T_NUMBER = 2;
export const T_STRING = 3;
export const T_COMMENT = 4;
export const T_PUNCT = 5;

const CT = new Uint8Array(256); // 1 ws, 2 ident start, 3 digit, 4 quote, 5 slash, 0 other
for (let c = 0; c < 256; c++) {
  const k = CC[c] | 0;
  let t = 0;
  if ((k & 1) !== 0) t = 1;
  else if ((k & 2) !== 0) t = 2;
  else if ((k & 8) !== 0) t = 3;
  else if (c === 34 || c === 39 || c === 96) t = 4;
  else if (c === 47) t = 5;
  CT[c] = t;
}

export class Lexer {
  src: Buffer;
  end: number;
  pos: number = 0;
  tokStart: number = 0;
  tokEnd: number = 0;
  constructor(src: Buffer, len: number) {
    this.src = src;
    this.end = len | 0;
  }
  next(): number {
    const src = this.src;
    const n = this.end;
    let pos = this.pos | 0;
    while (pos < n) {
      const c = src[pos] | 0;
      const k = CT[c] | 0;
      if (k === 1) {
        pos = ((pos | 0) + 1) | 0;
        continue;
      }
      const start = pos;
      let kind = T_PUNCT;
      if (k === 2) {
        pos = ((pos | 0) + 1) | 0;
        while (pos < n && ((CC[src[pos] | 0] | 0) & 4) !== 0) pos = ((pos | 0) + 1) | 0;
        kind = T_IDENT;
      } else if (k === 3) {
        pos = ((pos | 0) + 1) | 0;
        while (pos < n && (((CC[src[pos] | 0] | 0) & 4) !== 0 || (src[pos] | 0) === 46)) pos = ((pos | 0) + 1) | 0;
        kind = T_NUMBER;
      } else if (k === 4) {
        pos = ((pos | 0) + 1) | 0;
        while (pos < n && (src[pos] | 0) !== c) {
          if ((src[pos] | 0) === 92) pos = ((pos | 0) + 1) | 0;
          pos = ((pos | 0) + 1) | 0;
        }
        pos = ((pos | 0) + 1) | 0;
        kind = T_STRING;
      } else if (k === 5 && pos + 1 < n && (src[pos + 1] | 0) === 47) {
        while (pos < n && (src[pos] | 0) !== 10) pos = ((pos | 0) + 1) | 0;
        kind = T_COMMENT;
      } else if (k === 5 && pos + 1 < n && (src[pos + 1] | 0) === 42) {
        pos = ((pos | 0) + 2) | 0;
        while (pos + 1 < n && !((src[pos] | 0) === 42 && (src[pos + 1] | 0) === 47)) pos = ((pos | 0) + 1) | 0;
        pos = ((pos | 0) + 2) | 0;
        kind = T_COMMENT;
      } else {
        pos = ((pos | 0) + 1) | 0;
      }
      this.tokStart = start;
      this.tokEnd = pos;
      this.pos = pos;
      return kind;
    }
    this.pos = pos;
    return T_EOF;
  }
}
