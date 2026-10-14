// Port of vendor/bun/src/format/js/print/literals.rs.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { decodeUtf8, utf8Len } from "../../../base/utf8.ts";
import { Formatter } from "../../ir/formatter.ts";
import {
  N_PROP,
  SP,
  exprRegexFlagsSpan,
  exprSpan,
  exprParent,
  nodeId,
  nodeKind,
  propIsJsxAttribute,
} from "../../../lint/ast/index.ts";
import { AN_JSX_ATTRIBUTE, anTag, exprAstParent } from "../ast_nodes.ts";
import { STRING_LITERAL_PARENT_KIND_EXPRESSION, fmtLiteralStringToken } from "../utils/string.ts";
import { writeNumberToken } from "../utils/number.ts";

const KB = new ByteBuf(64);

export function writeNumericLiteral(e: number, f: Formatter): void {
  exprSpan(e);
  writeNumberToken(SP[0] | 0, SP[1] | 0, f);
}

export function writeStringLiteral(e: number, f: Formatter): void {
  const parent = exprParent(e);
  const isJsx = nodeKind(parent) === N_PROP && propIsJsxAttribute(nodeId(parent)) && anTag(exprAstParent(e)) === AN_JSX_ATTRIBUTE;
  exprSpan(e);
  // TODO(port): tailwind (`context_of_string`, `sorted_string_literal`): the option is refused by the driver.
  fmtLiteralStringToken(SP[0] | 0, SP[1] | 0, isJsx, STRING_LITERAL_PARENT_KIND_EXPRESSION, f);
}

export function writeBigIntLiteral(e: number, f: Formatter): void {
  exprSpan(e);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const text = f.source;
  let hasUpper = false;
  for (let i = start; i < end; i++) {
    const c = text[i] | 0;
    if (c >= 65 && c <= 90) {
      hasUpper = true;
      break;
    }
  }
  if (!hasUpper) {
    f.sourceText(start, end);
    return;
  }
  const KB$ = KB;
  KB$.reset();
  for (let i = start; i < end; i++) {
    const c = text[i] | 0;
    KB$.push(c >= 65 && c <= 90 ? c + 32 : c);
  }
  f.textBytesNoWs(KB$.data, 0, KB$.len);
}

/** An error: `/a/é`. The characters are sorted as JavaScript sorts strings, by UTF-16 code units. */
function writeRegExpLiteralWithUnknownFlags(start: number, flagsStart: number, end: number, f: Formatter): void {
  const text = f.source;
  // The code points of the flags.
  const cps: number[] = [];
  let i = flagsStart;
  while (i < end) {
    cps.push(decodeUtf8(text, i, end));
    i = i + utf8Len();
  }
  cps.sort((a: number, b: number): number => {
    const a1 = a > 0xffff ? 0xd800 + ((a - 0x10000) >> 10) : a;
    const b1 = b > 0xffff ? 0xd800 + ((b - 0x10000) >> 10) : b;
    if (a1 !== b1) return a1 - b1;
    const a2 = a > 0xffff ? 0xdc00 + ((a - 0x10000) & 0x3ff) : -1;
    const b2 = b > 0xffff ? 0xdc00 + ((b - 0x10000) & 0x3ff) : -1;
    return a2 - b2;
  });
  const buf = f.textBuf();
  const at = buf.len;
  buf.append(text, start, flagsStart);
  for (let k = 0; k < cps.length; k++) {
    const cp = cps[k] | 0;
    if (cp < 0x80) buf.push(cp);
    else if (cp < 0x800) {
      buf.push(0xc0 | (cp >> 6));
      buf.push(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      buf.push(0xe0 | (cp >> 12));
      buf.push(0x80 | ((cp >> 6) & 0x3f));
      buf.push(0x80 | (cp & 0x3f));
    } else {
      buf.push(0xf0 | (cp >> 18));
      buf.push(0x80 | ((cp >> 12) & 0x3f));
      buf.push(0x80 | ((cp >> 6) & 0x3f));
      buf.push(0x80 | (cp & 0x3f));
    }
  }
  f.endBuiltText(at);
}

/** The flags are sorted. */
export function writeRegExpLiteral(e: number, f: Formatter): void {
  exprSpan(e);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  exprRegexFlagsSpan(e);
  const flagsStart = SP[0] | 0;
  const flagsEnd = SP[1] | 0;
  const text = f.source;
  let isSorted = true;
  let isAscii = true;
  for (let i = flagsStart; i < flagsEnd; i++) {
    const c = text[i] | 0;
    if (c >= 128) isAscii = false;
    if (i > flagsStart && c < (text[i - 1] | 0)) isSorted = false;
  }
  if (isSorted) {
    f.textSource(start, end);
    return;
  }
  if (!isAscii) {
    writeRegExpLiteralWithUnknownFlags(start, flagsStart, flagsEnd, f);
    return;
  }
  const buf = f.textBuf();
  const at = buf.len;
  buf.append(text, start, end);
  // Insertion sort of the flags: there are a handful.
  const d = buf.data;
  const from = at + (flagsStart - start);
  const to = at + (flagsEnd - start);
  for (let i = from + 1; i < to; i++) {
    const c = d[i] | 0;
    let j = i - 1;
    while (j >= from && (d[j] | 0) > c) {
      d[j + 1] = d[j] | 0;
      j = j - 1;
    }
    d[j + 1] = c | 0;
  }
  f.endBuiltText(at);
}
