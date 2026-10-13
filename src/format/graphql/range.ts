// Port of vendor/bun/src/format/graphql/range.rs: `rangeStart` and `rangeEnd`: Prettier's `calculateRange`
// (`src/main/range.js`) for GraphQL. Also the few helpers of vendor/bun/src/format/range.rs that this language needs
// (`Offsets`, `alignment_size`, `normalized_len`, `write_with_line_ending`), kept here until `src/format/range.ts` exists.
import { ByteBuf } from "../../base/bytebuf.ts";
import { byteOffsetOfUtf16, utf16Len } from "../../base/utf8.ts";
import { LINE_ENDING_CR, LINE_ENDING_CRLF } from "../options.ts";
import { jsWhitespaceLen, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  K_DIRECTIVE_DEFINITION,
  K_ENUM_TYPE_DEFINITION,
  K_ENUM_VALUE_DEFINITION,
  K_FIELD_DEFINITION,
  K_FRAGMENT_DEFINITION,
  K_INPUT_OBJECT_TYPE_DEFINITION,
  K_INPUT_VALUE_DEFINITION,
  K_INTERFACE_TYPE_DEFINITION,
  K_OBJECT_TYPE_DEFINITION,
  K_OPERATION_DEFINITION,
  K_OPERATION_TYPE_DEFINITION,
  K_SCALAR_TYPE_DEFINITION,
  K_SCHEMA_DEFINITION,
  K_UNION_TYPE_DEFINITION,
  K_VARIABLE_DEFINITION,
  Tree,
} from "./parser.ts";

const EDGE_START = 0;
const EDGE_END = 1;

/** Prettier's `graphqlSourceElements` */
function isSourceElement(kind: number): boolean {
  return (
    kind === K_OPERATION_DEFINITION ||
    kind === K_FRAGMENT_DEFINITION ||
    kind === K_VARIABLE_DEFINITION ||
    kind === K_OBJECT_TYPE_DEFINITION ||
    kind === K_FIELD_DEFINITION ||
    kind === K_DIRECTIVE_DEFINITION ||
    kind === K_ENUM_TYPE_DEFINITION ||
    kind === K_ENUM_VALUE_DEFINITION ||
    kind === K_INPUT_VALUE_DEFINITION ||
    kind === K_INPUT_OBJECT_TYPE_DEFINITION ||
    kind === K_SCHEMA_DEFINITION ||
    kind === K_OPERATION_TYPE_DEFINITION ||
    kind === K_INTERFACE_TYPE_DEFINITION ||
    kind === K_UNION_TYPE_DEFINITION ||
    kind === K_SCALAR_TYPE_DEFINITION
  );
}

function isAtOffset(tree: Tree, node: number, offset: number, edge: number): boolean {
  const s = tree.startOf(node);
  const e = tree.endOf(node);
  return !(offset > e || offset < s || (edge === EDGE_END && offset === s) || (edge === EDGE_START && offset === e));
}

/**
 * Prettier's `findNodeAtOffset`. If there is a source element at `offset` in the root, `path` is the way to it, from the
 * outside in.
 */
function findNodeAtOffset(tree: Tree, root: number, offset: number, edge: number, path: number[]): boolean {
  path.length = 0;
  // For each node of `path`, its children that have not been looked at: the next one and the end.
  const restPos: number[] = [];
  const restEnd: number[] = [];
  if (isAtOffset(tree, root, offset, edge)) {
    path.push(root);
    restPos.push(tree.firstOf(root));
    restEnd.push((tree.firstOf(root)) + (tree.countOf(root)));
  }
  while (path.length > 0) {
    const top = restPos.length - 1;
    const node = path[path.length - 1];
    if (restPos[top] < restEnd[top]) {
      const child = tree.children[restPos[top]] | 0;
      restPos[top] = restPos[top] + 1;
      if (isAtOffset(tree, child, offset, edge)) {
        path.push(child);
        restPos.push(tree.firstOf(child));
        restEnd.push((tree.firstOf(child)) + (tree.countOf(child)));
      }
    } else if (isSourceElement(tree.kindOf(node))) {
      return true;
    } else {
      path.pop();
      restPos.pop();
      restEnd.pop();
    }
  }
  return false;
}

// The result of `findSiblingAncestors` and `calculateRange`.
let outA = 0;
let outB = 0;

/** Prettier's `findSiblingAncestors`. The paths are from the inside out. */
function findSiblingAncestors(tree: Tree, startPath: number[], endPath: number[]): boolean {
  if (startPath.length === 0 || endPath.length === 0) return false;
  let startNode = startPath[0];
  let endNode = endPath[0];
  if (startNode === endNode) {
    outA = startNode;
    outB = endNode;
    return true;
  }
  const start = tree.startOf(startNode);
  for (let i = 1; i < endPath.length; i++) {
    const ancestor = endPath[i];
    if ((tree.startOf(ancestor)) < start) break;
    endNode = ancestor;
  }
  const end = tree.endOf(endNode);
  for (let i = 1; i < startPath.length; i++) {
    const ancestor = startPath[i];
    if ((tree.endOf(ancestor)) > end) break;
    startNode = ancestor;
    if (startNode === endNode) break;
  }
  outA = startNode;
  outB = endNode;
  return true;
}

/**
 * The part of `text` that is formatted for the range from `start` to `end`: `rangeStartOf()` .. `rangeEndOf()` after a
 * call that returns true.
 */
export function calculateRange(text: Uint8Array, tree: Tree, startIn: number, endIn: number): boolean {
  let start = startIn;
  let end = endIn;
  // The range is narrowed so that it starts and ends with something.
  if (start > end || end > text.length) return false;
  const trimmed = trimJsWhitespaceStart(text, start, end);
  const isBlank = trimmed >= end;
  if (!isBlank) {
    end = trimJsWhitespaceEnd(text, trimmed, end);
    start = trimmed;
  }
  const root = tree.root();
  const startPath: number[] = [];
  if (!findNodeAtOffset(tree, root, start, EDGE_START, startPath)) return false;
  startPath.reverse();
  let endPath: number[] = startPath;
  if (!isBlank) {
    endPath = [];
    if (!findNodeAtOffset(tree, root, end, EDGE_END, endPath)) return false;
    endPath.reverse();
  }
  if (!findSiblingAncestors(tree, startPath, endPath)) return false;
  const startNode = outA;
  const endNode = outB;
  const ss = tree.startOf(startNode);
  const se = tree.endOf(startNode);
  const es = tree.startOf(endNode);
  const ee = tree.endOf(endNode);
  outA = ss < es ? ss : es;
  outB = se > ee ? se : ee;
  return true;
}

export function rangeStartOf(): number {
  return outA;
}
export function rangeEndOf(): number {
  return outB;
}

// ---------------------------------------------------------------------------------------------- vendor/bun/src/format/range.rs

/** How long `text[a, b)` is after each `\r\n` in it has become `\n`. */
export function normalizedLen(text: Uint8Array, a: number, b: number): number {
  let n = b - a;
  for (let i = a; i + 1 < b; i++) {
    if ((text[i] | 0) === 13 && (text[i + 1] | 0) === 10) n = n - 1;
  }
  return n;
}

// `rangeStart` and `rangeEnd`, as byte offsets in the text (`Offsets::new`).
let offStart = 0;
let offEnd = 0;

export function offsetsStart(): number {
  return offStart;
}
export function offsetsEnd(): number {
  return offEnd;
}

/** `None` (-1) if `text` is shorter. */
function offsetOfUtf16Index(text: Uint8Array, index: number): number {
  if (index > utf16Len(text, 0, text.length)) return -1;
  return byteOffsetOfUtf16(text, 0, text.length, index);
}

/** Prettier's `normalizeInputAndOptions`. `first`: where `text` starts after its byte order mark. Fills `offsetsStart()` and `offsetsEnd()`. */
export function computeOffsets(text: Uint8Array, first: number, rangeStart: number, rangeEnd: number): void {
  let start = -1;
  if (rangeStart >= 0) start = offsetOfUtf16Index(text, rangeStart);
  let end = -1;
  if (rangeEnd >= 0) end = offsetOfUtf16Index(text, rangeEnd);
  // After `\r\n` has become `\n`, an offset between the two is behind it.
  if (start >= 1 && start < text.length && (text[start - 1] | 0) === 13 && (text[start] | 0) === 10) start = start + 1;
  if (end >= 1 && end < text.length && (text[end - 1] | 0) === 13 && (text[end] | 0) === 10) end = end + 1;
  // An offset before the byte order mark or behind the end is as good as none.
  offStart = start >= first ? start : first;
  offEnd = end >= first ? end : text.length;
}

/** Prettier's `getAlignmentSize` of the white space that the last line of `before[0, end)` starts with. */
export function alignmentSize(before: Uint8Array, end: number, tabWidth: number): number {
  let lineStart = 0;
  for (let i = end - 1; i >= 0; i--) {
    const c = before[i] | 0;
    if (c === 10 || c === 13) {
      lineStart = i + 1;
      break;
    }
  }
  const tw = tabWidth > 1 ? tabWidth : 1;
  let size = 0;
  let at = lineStart;
  while (true) {
    const len = jsWhitespaceLen(before, at, end);
    if (len === 0) return size;
    size = (before[at] | 0) === 9 ? size + tw - (size % tw) : size + 1;
    at = at + len;
  }
}

/** Appends `text[a, b)` with each `\r\n`, `\r` and `\n` replaced by `lineEnding` (`LINE_ENDING_*`). */
export function writeWithLineEnding(text: Uint8Array, a: number, b: number, lineEnding: number, out: ByteBuf): void {
  let run = a;
  let i = a;
  while (i < b) {
    const c = text[i] | 0;
    if (c !== 10 && c !== 13) {
      i = ((i | 0) + 1) | 0;
      continue;
    }
    out.append(text, run, i);
    if (lineEnding === LINE_ENDING_CRLF) {
      out.push(13);
      out.push(10);
    } else if (lineEnding === LINE_ENDING_CR) {
      out.push(13);
    } else {
      out.push(10);
    }
    i = c === 13 && i + 1 < b && (text[i + 1] | 0) === 10 ? i + 2 : i + 1;
    run = i;
  }
  out.append(text, run, b);
}
