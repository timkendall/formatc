// Small byte-level helpers measured to compile to tight loops.
// ASCII-literal comparison against src[start, start+lit.length). Hoist lit.length into a local (strings: `n = s.length`).
export function eqAscii(src: Uint8Array, start: number, lit: string): boolean {
  const n = lit.length;
  if (start + n > src.length) return false;
  for (let i = 0; i < n; i++) {
    if ((src[start + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}
// Character-class table (build once at module init): bit 0 = whitespace, bit 1 = ident start, bit 2 = ident part, bit 3 = digit
export const CC = new Uint8Array(256);
for (let c = 0; c < 256; c++) {
  let k = 0;
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) k |= 1;
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c >= 128) k |= 2 | 4;
  if (c >= 48 && c <= 57) k |= 4 | 8;
  CC[c] = k;
}
