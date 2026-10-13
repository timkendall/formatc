// Port of vendor/bun/src/format/js/jsdoc/text.rs: what `str` does. Text is a JavaScript string here (see src/base/ustr.ts).
import { codePointAt, cpLen, codePointBefore, linesOf } from "../../../base/ustr.ts";

/** `str::trim_start_matches` with a test on the code point. */
export function trimStartMatchesCp(text: string, cp0: number): string {
  let i = 0;
  while (i < text.length && codePointAt(text, i) === cp0) i = i + cpLen(cp0);
  return i === 0 ? text : text.substring(i);
}

/** `str::trim_end_matches` of one code point. */
export function trimEndMatchesCp(text: string, cp0: number): string {
  let n = text.length;
  while (n > 0 && codePointBefore(text, n) === cp0) n = n - cpLen(cp0);
  return n === text.length ? text : text.substring(0, n);
}

/** `str::lines` */
export function lines(text: string): string[] {
  return linesOf(text);
}

/** The parts of `parts` with `separator` between them. */
export function join(parts: string[], separator: string): string {
  return parts.join(separator);
}

/** `n` spaces. */
export function spaces(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s = s + " ";
  return s;
}

/** The number that the ASCII digits `digits` are; -1 if it is too big. */
export function parseIndex(digits: string): number {
  let all = 0;
  for (let i = 0; i < digits.length; i++) {
    all = all * 10 + (digits.charCodeAt(i) - 48);
    if (all > 9007199254740991) return -1;
  }
  return all;
}

export function isAsciiDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** `u8::is_ascii_alphanumeric` */
export function isAsciiAlphanumeric(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** A stable sort of `items` by `cmp` (an insertion sort: the arrays are small). */
export function stableSort<T>(items: T[], from: number, to: number, cmp: (a: T, b: T) => number): void {
  for (let i = from + 1; i < to; i++) {
    const x = items[i];
    let j = i - 1;
    while (j >= from && cmp(items[j], x) > 0) {
      items[j + 1] = items[j];
      j = j - 1;
    }
    items[j + 1] = x;
  }
}
