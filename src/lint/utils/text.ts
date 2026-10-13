// The part of vendor/bun/src/lint/utils/text.rs that the JS formatter uses. The operations of JavaScript strings, on UTF-8 text (`&[u8]` is
// `(buf, start, end)`).
//
//   String(n)                      numberToString(n) -> string      or numberToStringBytes(n, out: Bytes)
//   ends_with_ignore_ascii_case    endsWithIgnoreAsciiCase(buf, start, end, "lit")   ("lit" lower case ASCII)
//   to_lower_case / to_upper_case  toLowerCaseInto(buf, start, end, out: Bytes) / toUpperCaseInto(..)
//   is_upper_case / is_lower_case  isUpperCase(buf, start, end) / isLowerCase(...)
// Not ported (nothing in vendor/bun/src/format/js calls them): spelling_suggestion, natural_compare, is_identifier_es5/6, upper_case_first,
// string_from_code_points, the `/iu` prefix matchers.
import { Bytes } from "../../sema/vec.ts";

/** `number_to_string(n)`: `String(n)`. */
export function numberToString(n: number): string {
  return String(n);
}

/** `number_to_string(n)` appended to `out` as ASCII. */
export function numberToStringBytes(n: number, out: Bytes): void {
  out.appendAscii(String(n));
}

/** Whether `buf[start, end)` ends with the ASCII `ending`, whatever the case of the ASCII letters in `buf`. */
export function endsWithIgnoreAsciiCase(buf: Uint8Array, start: number, end: number, ending: string): boolean {
  const n = ending.length;
  if (end - start < n) return false;
  const from = end - n;
  for (let i = 0; i < n; i++) {
    let c = buf[from + i] | 0;
    if (c >= 65 && c <= 90) c = c + 32;
    let d = ending.charCodeAt(i);
    if (d >= 65 && d <= 90) d = d + 32;
    if (c !== d) return false;
  }
  return true;
}

function isAscii(buf: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if ((buf[i] | 0) >= 0x80) return false;
  return true;
}

/** `text.toLowerCase()` appended to `out` (reset first). */
export function toLowerCaseInto(buf: Uint8Array, start: number, end: number, out: Bytes): void {
  out.reset();
  if (isAscii(buf, start, end)) {
    for (let i = start; i < end; i++) {
      const c = buf[i] | 0;
      out.push(c >= 65 && c <= 90 ? c + 32 : c);
    }
    return;
  }
  const s = Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString("utf8").toLowerCase();
  const b = Buffer.from(s, "utf8");
  out.append(b, 0, b.length);
}

/** `text.toUpperCase()` appended to `out` (reset first). */
export function toUpperCaseInto(buf: Uint8Array, start: number, end: number, out: Bytes): void {
  out.reset();
  if (isAscii(buf, start, end)) {
    for (let i = start; i < end; i++) {
      const c = buf[i] | 0;
      out.push(c >= 97 && c <= 122 ? c - 32 : c);
    }
    return;
  }
  const s = Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString("utf8").toUpperCase();
  const b = Buffer.from(s, "utf8");
  out.append(b, 0, b.length);
}

/** `text === text.toUpperCase()` */
export function isUpperCase(buf: Uint8Array, start: number, end: number): boolean {
  if (isAscii(buf, start, end)) {
    for (let i = start; i < end; i++) {
      const c = buf[i] | 0;
      if (c >= 97 && c <= 122) return false;
    }
    return true;
  }
  const s = Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString("utf8");
  return s === s.toUpperCase();
}

/** `text === text.toLowerCase()` */
export function isLowerCase(buf: Uint8Array, start: number, end: number): boolean {
  if (isAscii(buf, start, end)) {
    for (let i = start; i < end; i++) {
      const c = buf[i] | 0;
      if (c >= 65 && c <= 90) return false;
    }
    return true;
  }
  const s = Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString("utf8");
  return s === s.toLowerCase();
}
