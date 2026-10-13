// Port of vendor/bun/src/lint/ast/entities.rs: the named character references of XHTML, which JSX text and attribute strings may
// contain. typescript-estree's `unescapeStringLiteralText`.
import { Bytes } from "../../sema/vec.ts";
import { JSX_ENTITY_CODES, JSX_ENTITY_NAMES } from "../../sema/parser/jsx_entities.ts";

let entityMap: Map<string, number> = new Map<string, number>();
let entityMapBuilt = false;

function lookupEntity(name: string): number {
  if (!entityMapBuilt) {
    for (let i = 0; i < JSX_ENTITY_NAMES.length; i++) entityMap.set(JSX_ENTITY_NAMES[i], JSX_ENTITY_CODES[i]);
    entityMapBuilt = true;
  }
  const v = entityMap.get(name);
  return v === undefined ? -1 : v;
}

function digitValue(c: number, radix: number): number {
  let v = -1;
  if (c >= 48 && c <= 57) v = c - 48;
  else if (c >= 97 && c <= 122) v = c - 87;
  else if (c >= 65 && c <= 90) v = c - 55;
  return v >= 0 && v < radix ? v : -1;
}

/** What `&item;` stands for: a code point, or -1. `item` is `text[start, end)`. */
function codePoint(text: Uint8Array, start: number, end: number, isEspree: boolean): number {
  const n = end - start;
  if (n >= 1 && (text[start] | 0) === 35) {
    let radix = 10;
    let from = start + 1;
    if (n >= 2 && (text[start + 1] | 0) === 120) {
      radix = 16;
      from = start + 2;
    }
    if (from >= end) return -1;
    let value = 0;
    for (let i = from; i < end; i++) {
      const d = digitValue(text[i] | 0, radix);
      if (d < 0) return -1;
      value = value * radix + d;
      if (value > 4294967295) value = 4294967295;
    }
    if (isEspree) return value % 65536;
    return value <= 0x10ffff ? value : -1;
  }
  let name = "";
  for (let i = start; i < end; i++) name += String.fromCharCode(text[i] | 0);
  return lookupEntity(name);
}

/**
 * typescript-estree's `unescapeStringLiteralText(text[start, end))`: `&name;`, `&#10;` and `&#xA;` replaced by what they stand for.
 * What is not a known reference stays as it is. `isEspree`: acorn-jsx's `jsx_readEntity`: ten characters after the `&` at most, and
 * `String.fromCharCode`. Returns false if nothing changed (`out` is untouched); else true and `out` (reset first) has the result.
 */
export function unescapeJsx(text: Uint8Array, start: number, end: number, isEspree: boolean, out: Bytes): boolean {
  let first = -1;
  for (let i = start; i < end; i++) {
    if ((text[i] | 0) === 38) {
      first = i;
      break;
    }
  }
  if (first < 0) return false;
  out.reset();
  out.append(text, start, first);
  let rest = first;
  while (rest < end) {
    // `rest` is at a `&`
    const after = (rest + 1) | 0;
    let itemEnd = after;
    while (itemEnd < end) {
      const c = text[itemEnd] | 0;
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 35) itemEnd = ((itemEnd | 0) + 1) | 0;
      else break;
    }
    let decoded = -1;
    if (itemEnd < end && (text[itemEnd] | 0) === 59 && (!isEspree || itemEnd - after < 10)) {
      decoded = codePoint(text, after, itemEnd, isEspree);
    }
    if (decoded >= 0) {
      out.pushCodepointWtf8(decoded);
      rest = (itemEnd + 1) | 0;
    } else {
      out.push(38);
      rest = after;
    }
    let next = rest;
    while (next < end && (text[next] | 0) !== 38) next = ((next | 0) + 1) | 0;
    out.append(text, rest, next);
    rest = next;
  }
  return true;
}
