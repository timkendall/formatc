// Port of vendor/bun/src/format/js/utils/suppressed.rs: `// prettier-ignore`.
import { ByteBuf } from "../../../base/bytebuf.ts";
import { Formatter } from "../../ir/formatter.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import { twMultilineString, twIsMultiline, twValue } from "../../ir/element.ts";
import { cxOf } from "../context.ts";

/**
 * For oxfmt a text over several lines breaks the groups around it, whatever it is. For Prettier what is not formatted is one string, which
 * breaks nothing.
 */
function textOverSeveralLinesBreaksGroups(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `FormatSuppressedNode(span)`: the source text of `(start, end)` as it is. The comments in it count as printed. */
export function writeSuppressedNode(start: number, end: number, f: Formatter): void {
  writeSource(start, end, !textOverSeveralLinesBreaksGroups(f), f);
  cxOf(f).comments.skipCommentsBefore(end);
}

/**
 * `FormatTemplateText(span)`: the source text of `(start, end)`, which is a template without substitutions. For Prettier its lines are
 * strings with a `literalline` between them, which breaks the groups around it.
 */
export function formatTemplateText(start: number, end: number, f: Formatter): void {
  writeSource(start, end, false, f);
}

const converted = new ByteBuf(1024);

function writeSource(start0: number, end0: number, isOneString: boolean, f: Formatter): void {
  const text = f.source;
  const start = start0 < text.length ? start0 : text.length;
  const end = end0 > start ? (end0 < text.length ? end0 : text.length) : start;
  if (end <= start) return;
  let hasCr = false;
  for (let i = start; i < end; i++) {
    if ((text[i] | 0) === 13) {
      hasCr = true;
      break;
    }
  }
  let buf = text;
  let a = start;
  let b = end;
  if (hasCr) {
    converted.reset();
    let rest = start;
    while (rest < end) {
      let at = rest;
      while (at < end && (text[at] | 0) !== 13) at = at + 1;
      converted.append(text, rest, at);
      if (at >= end) break;
      converted.push(10);
      rest = at + 1;
      if (rest < end && (text[rest] | 0) === 10) rest = rest + 1;
    }
    buf = converted.data;
    a = 0;
    b = converted.len;
  }
  // For Prettier it is one string, and a line break in a string has no width: whether it fits is asked of all its lines together.
  let width = f.textWidth(buf, a, b);
  if (twIsMultiline(width) && isOneString) {
    let sum = 0;
    let pos = a;
    while (true) {
      let e = pos;
      while (e < b && (buf[e] | 0) !== 10) e = e + 1;
      sum = (sum + twValue(f.textWidth(buf, pos, e))) | 0;
      if (e >= b) break;
      pos = e + 1;
    }
    width = twMultilineString(sum);
  }
  if (hasCr) f.textBytesWithWidth(buf, a, b, width);
  else f.textSourceWithWidth(a, b, width);
}
