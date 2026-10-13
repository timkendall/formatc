// Port of vendor/bun/src/format/js/jsdoc/markers.rs: what starts an item of a list, for all who have to know.
import { isAsciiDigit } from "./text.ts";

/** `ListMarker`: none, `- `, `* `, `+ `; `1. `, `1) ` that starts at one; the same that starts at another number; `1- `, which becomes `1. `. */
export const LM_NONE: number = 0;
export const LM_UNORDERED: number = 1;
export const LM_ORDERED_ONE: number = 2;
export const LM_ORDERED_OTHER: number = 3;
export const LM_LEGACY_ORDERED: number = 4;

/** The marker that `line` (from `from`) starts with, after spaces and tabs. */
export function listMarker(line: string, from: number): number {
  let i = from;
  const n = line.length;
  while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i = i + 1;
  if (i >= n) return LM_NONE;
  const first = line.charCodeAt(i);
  if (first === 45 || first === 42 || first === 43) {
    return i + 1 < n && line.charCodeAt(i + 1) === 32 ? LM_UNORDERED : LM_NONE;
  }
  if (isAsciiDigit(first)) {
    let digits = 0;
    while (i + digits < n && isAsciiDigit(line.charCodeAt(i + digits))) digits = digits + 1;
    if (!(i + digits + 1 < n && line.charCodeAt(i + digits + 1) === 32)) return LM_NONE;
    const c = line.charCodeAt(i + digits);
    if (c === 46 || c === 41) return digits === 1 && first === 49 ? LM_ORDERED_ONE : LM_ORDERED_OTHER;
    if (c === 45) return LM_LEGACY_ORDERED;
    return LM_NONE;
  }
  return LM_NONE;
}

/**
 * Whether `word` at the start of a line would start a list, a heading or a quote. No line is broken before it:
 * `/^>|^(?:[*+-]|#{1,6}|\d+[).])$/` of Prettier's printer for Markdown, and `1-`.
 */
export function isBlockMarkerToken(word: string): boolean {
  const n = word.length;
  if (n === 0) return false;
  const c = word.charCodeAt(0);
  if (n === 1 && (c === 45 || c === 43 || c === 42)) return true;
  if (c === 62) return true;
  if (c === 35) {
    if (n > 6) return false;
    for (let i = 0; i < n; i++) if (word.charCodeAt(i) !== 35) return false;
    return true;
  }
  const last = word.charCodeAt(n - 1);
  if (n >= 2 && (last === 46 || last === 41 || last === 45)) {
    for (let i = 0; i < n - 1; i++) if (!isAsciiDigit(word.charCodeAt(i))) return false;
    return true;
  }
  return false;
}
