// Small byte-level helpers measured to compile to tight loops (production version of scratch/cookbook/lib/bytes.ts).

// ASCII-literal comparison against src[start, start+lit.length). `n` is hoisted into a local (strings: `n = s.length`).
export function eqAscii(src: Uint8Array, start: number, lit: string): boolean {
  const n = lit.length;
  if (start + n > src.length) return false;
  for (let i = 0; i < n; i++) {
    if ((src[start + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

// a[aStart, aStart+len) === b[bStart, bStart+len). The caller guarantees both ranges are in bounds.
export function eqBytes(a: Uint8Array, aStart: number, b: Uint8Array, bStart: number, len: number): boolean {
  for (let i = 0; i < len; i++) {
    if ((a[aStart + i] | 0) !== (b[bStart + i] | 0)) return false;
  }
  return true;
}

// Index of the first `byte` in src[from, end), or -1.
export function indexOfByte(src: Uint8Array, from: number, end: number, byte: number): number {
  for (let i = from; i < end; i++) {
    if ((src[i] | 0) === byte) return i;
  }
  return -1;
}

// Index of the last `byte` in src[from, end), or -1.
export function lastIndexOfByte(src: Uint8Array, from: number, end: number, byte: number): number {
  for (let i = end - 1; i >= from; i--) {
    if ((src[i] | 0) === byte) return i;
  }
  return -1;
}

// Character-class table (built once at module init):
//   bit 0 = whitespace (space, tab, \n, \r, \v, \f), bit 1 = ident start (letter, _, $, >= 0x80),
//   bit 2 = ident part, bit 3 = digit, bit 4 = hex digit, bit 5 = ASCII letter, bit 6 = printable ASCII (0x20..0x7E)
export const CC_WS = 1;
export const CC_IDENT_START = 2;
export const CC_IDENT_PART = 4;
export const CC_DIGIT = 8;
export const CC_HEX = 16;
export const CC_ALPHA = 32;
export const CC_PRINTABLE = 64;

export const CC = new Uint8Array(256);
for (let c = 0; c < 256; c++) {
  let k = 0;
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) k |= CC_WS;
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c >= 128) k |= CC_IDENT_START | CC_IDENT_PART;
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) k |= CC_ALPHA;
  if (c >= 48 && c <= 57) k |= CC_IDENT_PART | CC_DIGIT | CC_HEX;
  if ((c >= 97 && c <= 102) || (c >= 65 && c <= 70)) k |= CC_HEX;
  if (c >= 0x20 && c <= 0x7e) k |= CC_PRINTABLE;
  CC[c] = k;
}

// ASCII/latin1 string to bytes (slow path: tests, option values, constant tables built at module init).
export function asciiBytes(s: string): Uint8Array {
  const n = s.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = s.charCodeAt(i) | 0;
  return out;
}

// UTF-8 encode a JS string (slow path).
export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Decode bytes as UTF-8 into a JS string (slow path: diagnostics, tests).
export function bytesToString(src: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(src.subarray(start, end));
}
