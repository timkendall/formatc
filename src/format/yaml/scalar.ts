// Port of vendor/bun/src/format/yaml/scalar.rs. `yaml` 2.9: `compose/resolve-flow-scalar.js`: what a scalar that is not a
// block says.
//
// Rust returns a `Cow`: borrowed if nothing changes. Here the value is written to `scalarOut` (reset by the caller of
// `scalarSource`); the temporary of a single-quoted value is `scalarTmp`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { encodeUtf8 } from "../../base/utf8.ts";
import { K_QUOTE_DOUBLE, K_QUOTE_SINGLE } from "./ast.ts";

/** The value of the last `scalarSource`. */
export const scalarOut: ByteBuf = new ByteBuf(256);
const scalarTmp: ByteBuf = new ByteBuf(256);

/** `foldLines` of src[start, end), appended to `out`. */
function foldLines(src: Uint8Array, start: number, end: number, out: ByteBuf): void {
  let firstNewline = -1;
  for (let i = start; i < end; i++) {
    if ((src[i] | 0) === 10) {
      firstNewline = i;
      break;
    }
  }
  if (firstNewline < 0) {
    out.append(src, start, end);
    return;
  }
  // result = first line without the white space at its end
  let e = firstNewline;
  while (e > start) {
    const b = src[e - 1] | 0;
    if (b === 32 || b === 9) e = e - 1;
    else break;
  }
  out.append(src, start, e);
  // false: a space, true: a line break
  let sepIsLineBreak = false;
  let rest = firstNewline + 1;
  for (;;) {
    let newline = -1;
    for (let i = rest; i < end; i++) {
      if ((src[i] | 0) === 10) {
        newline = i;
        break;
      }
    }
    if (newline < 0) break;
    let ls = rest;
    let le = newline;
    while (ls < le) {
      const b = src[ls] | 0;
      if (b === 32 || b === 9) ls = ls + 1;
      else break;
    }
    while (le > ls) {
      const b = src[le - 1] | 0;
      if (b === 32 || b === 9) le = le - 1;
      else break;
    }
    if (le === ls) {
      if (sepIsLineBreak) out.push(10);
      else sepIsLineBreak = true;
    } else {
      out.push(sepIsLineBreak ? 10 : 32);
      out.append(src, ls, le);
      sepIsLineBreak = false;
    }
    rest = newline + 1;
  }
  out.push(sepIsLineBreak ? 10 : 32);
  let rs = rest;
  while (rs < end) {
    const b = src[rs] | 0;
    if (b === 32 || b === 9) rs = rs + 1;
    else break;
  }
  out.append(src, rs, end);
}

/** `scalar.source`, for a scalar of `kind` that is written src[start, end): written to `scalarOut`, which is reset. */
export function scalarSource(kind: number, src: Uint8Array, start: number, end: number): void {
  const scalarOut$ = scalarOut;
  scalarOut$.reset();
  if (kind === K_QUOTE_SINGLE) singleQuotedValue(src, start, end);
  else if (kind === K_QUOTE_DOUBLE) doubleQuotedValue(src, start, end);
  else foldLines(src, start, end, scalarOut$);
}

function singleQuotedValue(src: Uint8Array, start: number, end: number): void {
  const scalarTmp$ = scalarTmp;
  scalarTmp$.reset();
  const inner0 = start + 1;
  const inner1 = end > start + 1 ? end - 1 : end;
  if (inner0 <= inner1) foldLines(src, inner0, inner1, scalarTmp$);
  const n = scalarTmp$.len;
  const d = scalarTmp$.data;
  let i = 0;
  const scalarOut$ = scalarOut;
  while (i < n) {
    const b = d[i] | 0;
    scalarOut$.push(b);
    i = i + (b === 39 && i + 1 < n && (d[i + 1] | 0) === 39 ? 2 : 1);
  }
}

function isBlank(b: number): boolean {
  return b === 32 || b === 9;
}

function hexValue(b: number): number {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 87;
  if (b >= 65 && b <= 70) return b - 55;
  return -1;
}

function pushEscape(next: number): boolean {
  const out = scalarOut;
  switch (next) {
    case 48: out.push(0); return true;
    case 97: out.push(7); return true;
    case 98: out.push(8); return true;
    case 101: out.push(0x1b); return true;
    case 102: out.push(0x0c); return true;
    case 110: out.push(10); return true;
    case 114: out.push(13); return true;
    case 116: out.push(9); return true;
    case 118: out.push(0x0b); return true;
    case 78: out.push(0xc2); out.push(0x85); return true;
    case 95: out.push(0xc2); out.push(0xa0); return true;
    case 76: out.push(0xe2); out.push(0x80); out.push(0xa8); return true;
    case 80: out.push(0xe2); out.push(0x80); out.push(0xa9); return true;
    case 32: out.push(32); return true;
    case 34: out.push(34); return true;
    case 47: out.push(47); return true;
    case 92: out.push(92); return true;
    case 9: out.push(9); return true;
    default: return false;
  }
}

function doubleQuotedValue(src: Uint8Array, start: number, endIn: number): void {
  const out = scalarOut;
  const len = endIn;
  const end = len > start + 1 ? len - 1 : len;
  const innerStart = start + 1;
  // Nothing to do: no backslash and no line break
  let plain = true;
  for (let i = innerStart; i < end; i++) {
    const b = src[i] | 0;
    if (b === 92 || b === 10) {
      plain = false;
      break;
    }
  }
  if (plain) {
    if (innerStart < end) out.append(src, innerStart, end);
    return;
  }
  let i = innerStart;
  while (i < end) {
    const ch = src[i] | 0;
    if (ch === 10) {
      // `foldNewline`
      let fold = 0;
      for (;;) {
        const nx = i + 1 < len ? src[i + 1] | 0 : -1;
        if (nx !== 32 && nx !== 9 && nx !== 10) break;
        if (nx === 10) fold = fold + 1;
        i = i + 1;
      }
      if (fold === 0) out.push(32);
      else out.fill(10, fold);
    } else if (ch === 92) {
      i = i + 1;
      const next = i < len ? src[i] | 0 : 0;
      if (pushEscape(next)) {
        // done
      } else if (next === 10) {
        // An escaped line break is nothing, and neither is the indentation of the next line.
        for (;;) {
          const nx = i + 1 < len ? src[i + 1] | 0 : -1;
          if (!isBlank(nx)) break;
          i = i + 1;
        }
      } else if (next === 120 || next === 117 || next === 85) {
        const length = next === 120 ? 2 : next === 117 ? 4 : 8;
        // `parseCharCode`
        let code = 0;
        let ok = i + 1 + length <= len;
        if (ok) {
          for (let k = 0; k < length; k++) {
            const h = hexValue(src[i + 1 + k] | 0);
            if (h < 0) {
              ok = false;
              break;
            }
            code = code * 16 + h;
          }
        }
        if (ok && code <= 0x10ffff) {
          // `char::from_u32`: a lone surrogate is U+FFFD
          encodeUtf8(out, code >= 0xd800 && code <= 0xdfff ? 0xfffd : code);
        } else {
          const e2 = i + 1 + length < len ? i + 1 + length : len;
          out.append(src, i - 1, e2);
        }
        i = i + length;
      } else {
        out.push(92);
        out.push(next);
      }
    } else if (ch === 32 || ch === 9) {
      // White space at the end of a line is nothing.
      const s = i;
      for (;;) {
        const nx = i + 1 < len ? src[i + 1] | 0 : -1;
        if (!isBlank(nx)) break;
        i = i + 1;
      }
      const after = i + 1 < len ? src[i + 1] | 0 : -1;
      if (after !== 10) out.append(src, s, i + 1);
    } else {
      out.push(ch);
    }
    i = i + 1;
  }
}
