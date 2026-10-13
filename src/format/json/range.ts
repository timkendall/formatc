// Port of vendor/bun/src/format/json/range.rs. `rangeStart` and `rangeEnd`: Prettier's `formatRange` and `calculateRange`,
// for JSON.
//
// What is formatted is the smallest value that both ends of the range are in. It is formatted as a document of its own,
// indented like the line that it starts on.
import { ByteBuf } from "../../base/bytebuf.ts";
import { byteOffsetOfUtf16, decodeUtf8, utf16Len, utf8Len } from "../../base/utf8.ts";
import { FORMAT_OK, FORMAT_SYNTAX_ERROR_AT } from "../errors.ts";
import { FormatOptions } from "../options.ts";
import { jsWhitespaceLen, startsWithBom, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import { LE_LF, PARSER_STRINGIFY, Config } from "./config.ts";
import { formatNormalized } from "./core.ts";
import { K_HOLE, K_IDENTIFIER, K_OBJECT, N_END, N_KIND, N_NEXT, N_START, tree } from "./parser.ts";
import { pushLineEnding } from "./util.ts";

const END_START = 0;
const END_END = 1;

// Steps of a path: the document (STEP_ROOT), a node (index * 2) or a property, which is not a node of the tree, told by
// its name (index * 2 + 1).
const STEP_ROOT = -1;

function stepNode(index: number): number {
  return index * 2;
}
function stepProperty(index: number): number {
  return index * 2 + 1;
}

function contains(offset: number, start: number, nodeEnd: number, end: number): boolean {
  return offset >= start && offset <= nodeEnd && !(end === END_END && offset === start) && !(end === END_START && offset === nodeEnd);
}

function isSource(text: Uint8Array, s: number, e: number, lit: string): boolean {
  if (e - s !== lit.length) return false;
  for (let i = 0; i < lit.length; i++) if ((text[s + i] | 0) !== lit.charCodeAt(i)) return false;
  return true;
}

/**
 * Prettier's `findNodeAtOffset`: the document, and then each time what the offset is in, down to the innermost thing that
 * can be formatted by itself. Empty if there is none.
 */
function findNodeAtOffset(text: Uint8Array, offset: number, end: number, path: number[]): void {
  path.length = 0;
  const nodes = tree.nodes;
  const nodeCount = tree.nodeCount;
  if (!contains(offset, 0, text.length, end)) return;
  path.push(STEP_ROOT);
  // The nodes among which the next step is looked for.
  let index = 0;
  let limit = nodeCount;
  let isInObject = false;
  while (index < limit) {
    const b = index << 3;
    if (isInObject) {
      // `node` is a name.
      if (index + 1 >= nodeCount) break;
      const vb = (index + 1) << 3;
      if (!contains(offset, nodes[b + N_START] | 0, nodes[vb + N_END] | 0, end)) {
        index = nodes[vb + N_NEXT] | 0;
        continue;
      }
      path.push(stepProperty(index));
      limit = nodes[vb + N_NEXT] | 0;
      isInObject = false;
      continue;
    }
    const kind = nodes[b + N_KIND] | 0;
    if (kind === K_HOLE || !contains(offset, nodes[b + N_START] | 0, nodes[b + N_END] | 0, end)) {
      index = nodes[b + N_NEXT] | 0;
      continue;
    }
    path.push(stepNode(index));
    limit = nodes[b + N_NEXT] | 0;
    isInObject = kind === K_OBJECT;
    index = index + 1;
  }
  // Neither a property nor an identifier can be formatted by itself. `null`, `true` and `false` are identifiers where they
  // are names.
  while (path.length >= 2) {
    const last = path[path.length - 1];
    const before = path[path.length - 2];
    let isSourceElement: boolean;
    if (last === STEP_ROOT) {
      isSourceElement = true;
    } else if (last % 2 === 1) {
      isSourceElement = false;
    } else {
      const index2 = last / 2;
      const b = index2 << 3;
      const s = nodes[b + N_START] | 0;
      const e = nodes[b + N_END] | 0;
      isSourceElement =
        (nodes[b + N_KIND] | 0) !== K_IDENTIFIER ||
        (before !== stepProperty(index2) && (isSource(text, s, e, "null") || isSource(text, s, e, "true") || isSource(text, s, e, "false")));
    }
    if (isSourceElement) break;
    path.pop();
  }
}

let rangeA = 0;
let rangeB = 0;

/** Prettier's `calculateRange`. `start` and `end` are offsets in bytes. Returns whether there is a range: `rangeA`, `rangeB`. */
function calculateRange(text: Uint8Array, startIn: number, endIn: number): boolean {
  let start = startIn;
  let end = endIn;
  if (start > end || end > text.length) return false;
  // Without the white space at its ends.
  const trimmedStart = trimJsWhitespaceStart(text, start, end);
  const trimmedEnd = trimJsWhitespaceEnd(text, trimmedStart, end);
  const isAllWhitespace = trimmedEnd <= trimmedStart;
  if (!isAllWhitespace) {
    start = trimmedStart;
    end = trimmedEnd;
  }
  const startPath: number[] = [];
  const endPath: number[] = [];
  findNodeAtOffset(text, start, END_START, startPath);
  if (isAllWhitespace) {
    for (let i = 0; i < startPath.length; i++) endPath.push(startPath[i]);
  } else {
    findNodeAtOffset(text, end, END_END, endPath);
  }
  if (startPath.length === 0 || endPath.length === 0) return false;
  // Prettier's `findCommonAncestor`
  for (let i = startPath.length - 1; i >= 0; i--) {
    const step = startPath[i];
    if (step !== STEP_ROOT && step % 2 === 1) continue;
    let found = false;
    for (let k = 0; k < endPath.length; k++) {
      if (endPath[k] === step) {
        found = true;
        break;
      }
    }
    if (!found) continue;
    if (step === STEP_ROOT) {
      rangeA = 0;
      rangeB = text.length;
    } else {
      const b = (step / 2) << 3;
      rangeA = tree.nodes[b + N_START] | 0;
      rangeB = tree.nodes[b + N_END] | 0;
    }
    return true;
  }
  return false;
}

/** `offset` (UTF-16 code units of the original, or -1) as a byte of `text`, or -1. */
function toByte(body: Uint8Array, hasBom: boolean, originalLen: number, offsetIn: number): number {
  if (offsetIn < 0 || offsetIn > originalLen) return -1;
  let offset = offsetIn;
  if (hasBom) {
    if (offset === 0) return -1;
    offset = offset - 1;
  }
  const before = byteOffsetOfUtf16(body, 0, body.length, offset);
  // A `\r\n` is one byte of `text`.
  let pairs = 0;
  for (let i = 0; i + 1 < before; i++) {
    if ((body[i] | 0) === 13 && (body[i + 1] | 0) === 10) {
      pairs = pairs + 1;
      i = i + 1;
    }
  }
  return before - pairs;
}

/**
 * `original`: the text as it was given. `text`: without a byte order mark and with `\n` for every line break. `cfg` is
 * changed.
 */
export function formatRange(original: Uint8Array, text: Uint8Array, cfg: Config, options: FormatOptions, out: ByteBuf): number {
  const hasBom = startsWithBom(original, 0);
  // The offsets count UTF-16 code units of the original. One that is not in the text does not count.
  const originalLen = utf16Len(original, 0, original.length);
  const body = hasBom ? original.subarray(3) : original;
  const startB = toByte(body, hasBom, originalLen, options.rangeStart);
  const endB = toByte(body, hasBom, originalLen, options.rangeEnd);
  let start = startB < 0 ? 0 : startB;
  let end = endB < 0 ? text.length : endB;
  if (start >= end && text.length > 0) {
    out.append(original, 0, original.length);
    return FORMAT_OK;
  }
  const lineEnding = cfg.lineEnding;
  cfg.lineEnding = LE_LF;
  if (hasBom) {
    out.push(0xef);
    out.push(0xbb);
    out.push(0xbf);
  }
  if (start === 0 && end >= text.length) {
    cfg.lineEnding = lineEnding;
    return formatNormalized(text, cfg, options, out, false);
  }

  if (tree.parse(text, cfg) < 0) return FORMAT_SYNTAX_ERROR_AT;
  if (cfg.parser === PARSER_STRINGIFY) {
    // What writes `json-stringify` does not say what is in a node, so the document is all there is.
    start = 0;
    end = text.length;
  } else if (calculateRange(text, start, end)) {
    start = rangeA;
    end = rangeB;
  } else {
    start = 0;
    end = 0;
  }

  // The indentation of the line that it starts on.
  let lineStart = 0;
  for (let i = start - 1; i >= 0; i--) {
    if ((text[i] | 0) === 10) {
      lineStart = i + 1;
      break;
    }
  }
  let indentationLen = 0;
  while (lineStart + indentationLen < start) {
    const at = lineStart + indentationLen;
    const len = jsWhitespaceLen(text, at, start);
    if (len === 0) break;
    indentationLen = indentationLen + len;
  }
  // Prettier's `getAlignmentSize`
  const tabWidth = cfg.indentWidth > 1 ? cfg.indentWidth : 1;
  let size = 0;
  {
    let at = lineStart;
    const stop = lineStart + indentationLen;
    while (at < stop) {
      const b = text[at] | 0;
      if (b === 9) {
        size = size + tabWidth - (size % tabWidth);
        at = at + 1;
      } else {
        size = size + 1;
        if (b < 0x80) {
          at = at + 1;
        } else {
          decodeUtf8(text, at, stop);
          at = at + utf8Len();
        }
      }
    }
  }
  cfg.alignment = size;

  const formatted = new ByteBuf(end - start + 64);
  const r = formatNormalized(text.subarray(start, end), cfg, options, formatted, false);
  if (r !== FORMAT_OK) return r;
  const trimStart = trimJsWhitespaceStart(formatted.data, 0, formatted.len);
  const trimEnd = trimJsWhitespaceEnd(formatted.data, trimStart, formatted.len);
  const result = new ByteBuf(text.length + formatted.len + 16);
  result.append(text, 0, start);
  result.append(formatted.data, trimStart, trimEnd);
  result.append(text, end, text.length);
  // Each line break is the one of `lineEnding`.
  const d = result.data;
  let runStart = 0;
  for (let i = 0; i < result.len; i++) {
    if ((d[i] | 0) === 10) {
      out.append(d, runStart, i);
      pushLineEnding(out, lineEnding);
      runStart = i + 1;
    }
  }
  out.append(d, runStart, result.len);
  return FORMAT_OK;
}
