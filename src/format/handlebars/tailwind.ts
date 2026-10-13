// Port of vendor/bun/src/format/handlebars/tailwind.rs: oxfmt's `sortTailwindcss` in Handlebars: `transformGlimmer` of
// `prettier-plugin-tailwindcss`, which changes the tree.
//
// The sorter itself (`Tailwind` of `src/format/tailwind.ts`) is not here: `setSorter` plugs it in. Without one nothing is
// sorted (it is off by default).
//
// TODO(port): call `src/format/tailwind.ts` (`Tailwind::sorted_between`, `Tailwind::attributes`) when it exists.
import { I32Vec } from "../../base/i32vec.ts";
import { jsWhitespaceLen, trimJsWhitespaceEnd } from "../text.ts";
import { K_CONCAT, K_HASH_PAIR, K_MUSTACHE, K_PATH, K_STRING, K_SUB_EXPRESSION, K_TEXT, K_ATTR, Tree } from "./ast.ts";

// What a sorter must do. `sortedBetween` returns the sorted text, or null if it is the text `buf[a, b)`.
export interface TailwindSorter {
  hasAttribute(buf: Uint8Array, a: number, b: number): boolean;
  sortedBetween(
    buf: Uint8Array,
    a: number,
    b: number,
    ignoresFirst: boolean,
    ignoresLast: boolean,
    collapsesStart: boolean,
    collapsesEnd: boolean,
  ): Uint8Array | null;
}

let sorter: TailwindSorter | null = null;

export function setSorter(s: TailwindSorter | null): void {
  sorter = s;
}

export function hasSorter(): boolean {
  return sorter !== null;
}

// Whether the attribute `name` has classes that are sorted.
export function tailwindAttributeIsSorted(buf: Uint8Array, a: number, b: number): boolean {
  if (b - a === 5 && (buf[a] | 0) === 99 && (buf[a + 1] | 0) === 108 && (buf[a + 2] | 0) === 97 && (buf[a + 3] | 0) === 115 && (buf[a + 4] | 0) === 115) {
    return true;
  }
  return sorter !== null && sorter.hasAttribute(buf, a, b);
}

// `Around`: what is around a node in the value of an attribute.
// It is a part of a `ConcatStatement`, with a part before it, and with one behind it:
const A_HAS_PREVIOUS = 1;
const A_HAS_NEXT = 2;
// It is in a `(concat ..)`.
const A_IN_CONCAT = 4;
// What a string in it becomes is right behind, or right before, something that is no white space, or may be none. The
// plugin does not ask: of `class="a{{if b "p-4 flex"}}"` it makes `"flex p-4"`, and of `{{concat "p-4 " c}}` `"p-4"`.
const A_TOUCHES_START = 8;
const A_TOUCHES_END = 16;

function hasBlankAt(tree: Tree, id: number, isStart: boolean): boolean {
  const k = tree.tag[id] | 0;
  if (k !== K_TEXT && k !== K_STRING) return false;
  const s = tree.f0[id] | 0;
  const l = tree.f1[id] | 0;
  if (l === 0) return false;
  const c = tree.buf[isStart ? s : s + l - 1] | 0;
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

// `touches` of the one at `index` of the nodes at `listStart`, which follow each other in something whose own is `outer`.
function touchesOf(tree: Tree, listStart: number, listLen: number, index: number, outer: number): number {
  let start = (outer & A_TOUCHES_START) !== 0;
  let end = (outer & A_TOUCHES_END) !== 0;
  if (index > 0) start = !hasBlankAt(tree, tree.lists[listStart + index - 1] | 0, false);
  if (index + 1 < listLen) end = !hasBlankAt(tree, tree.lists[listStart + index + 1] | 0, true);
  return (start ? A_TOUCHES_START : 0) | (end ? A_TOUCHES_END : 0);
}

function isConcat(tree: Tree, path: number): boolean {
  return (tree.tag[path] | 0) === K_PATH && (tree.f4[path] | 0) === 0 && tree.textIs(tree.f1[path] | 0, tree.f2[path] | 0, "concat");
}

function pushCall(tree: Tree, stack: I32Vec, call: number, around: number): void {
  const pathNode = tree.f0[call] | 0;
  const paramsStart = tree.f1[call] | 0;
  const paramsLen = tree.f2[call] | 0;
  const pairsStart = tree.f3[call] | 0;
  const pairsLen = tree.f4[call] | 0;
  stack.push(pathNode);
  stack.push(around);
  for (let i = 0; i < pairsLen; i++) {
    stack.push(tree.lists[pairsStart + i] | 0);
    stack.push(around);
  }
  const concat = isConcat(tree, pathNode);
  for (let i = 0; i < paramsLen; i++) {
    let a = around;
    if (concat) a = (around & ~(A_TOUCHES_START | A_TOUCHES_END)) | touchesOf(tree, paramsStart, paramsLen, i, around);
    stack.push(tree.lists[paramsStart + i] | 0);
    stack.push(a);
  }
}

const stackVec = new I32Vec(64);

// Sorts the classes in the attributes of `tree`, which is made of `source`.
export function sortClasses(tree: Tree): void {
  const tw = sorter;
  if (tw === null) return;
  const stack = stackVec;
  stack.reset();
  const n = tree.n;
  for (let id = 0; id < n; id++) {
    if ((tree.tag[id] | 0) === K_ATTR) {
      const ns = tree.f0[id] | 0;
      const na = ns;
      if (tailwindAttributeIsSorted(tree.buf, na, na + (tree.f1[id] | 0))) {
        stack.push(tree.f2[id] | 0);
        stack.push(0);
      }
    }
  }
  while (stack.len > 0) {
    const around = stack.pop();
    const id = stack.pop();
    const kind = tree.tag[id] | 0;
    let ignoresFirst = false;
    let ignoresLast = false;
    let collapsesStart = false;
    let collapsesEnd = false;
    if (kind === K_CONCAT) {
      const partStart = tree.f0[id] | 0;
      const partLen = tree.f1[id] | 0;
      for (let index = 0; index < partLen; index++) {
        const a =
          (around & A_IN_CONCAT) |
          (index > 0 ? A_HAS_PREVIOUS : 0) |
          (index + 1 < partLen ? A_HAS_NEXT : 0) |
          touchesOf(tree, partStart, partLen, index, around);
        stack.push(tree.lists[partStart + index] | 0);
        stack.push(a);
      }
      continue;
    } else if (kind === K_MUSTACHE) {
      pushCall(tree, stack, id, around);
      continue;
    } else if (kind === K_SUB_EXPRESSION) {
      const a = isConcat(tree, tree.f0[id] | 0) ? around | A_IN_CONCAT : around;
      pushCall(tree, stack, id, a);
      continue;
    } else if (kind === K_HASH_PAIR) {
      stack.push(tree.f2[id] | 0);
      stack.push(around);
      continue;
    } else if (kind === K_TEXT) {
      const s = tree.f0[id] | 0;
      const l = tree.f1[id] | 0;
      const buf = tree.buf;
      const a = s;
      const b = a + l;
      ignoresFirst = (around & A_HAS_PREVIOUS) !== 0 && !(jsWhitespaceLen(buf, a, b) > 0);
      ignoresLast = (around & A_HAS_NEXT) !== 0 && trimJsWhitespaceEnd(buf, a, b) === b;
      collapsesStart = (around & A_HAS_PREVIOUS) === 0;
      collapsesEnd = (around & A_HAS_NEXT) === 0;
    } else if (kind === K_STRING) {
      const s = tree.f0[id] | 0;
      const l = tree.f1[id] | 0;
      const buf = tree.buf;
      const a = s;
      const b = a + l;
      // `/[^\S\r\n]$/`
      const last = l > 0 ? buf[b - 1] | 0 : -1;
      const endsWithBlank = last === 32 || last === 9 || last === 11 || last === 12;
      const touchesStart = (around & A_TOUCHES_START) !== 0;
      const touchesEnd = (around & A_TOUCHES_END) !== 0;
      const first = l > 0 ? buf[a] | 0 : -1;
      const firstIsWhite = first === 32 || first === 9 || first === 10 || first === 12 || first === 13;
      ignoresFirst = touchesStart && !firstIsWhite;
      ignoresLast = ((around & A_IN_CONCAT) !== 0 || touchesEnd) && !endsWithBlank;
      collapsesStart = false;
      collapsesEnd = (around & A_IN_CONCAT) === 0 && !touchesEnd;
    } else {
      continue;
    }
    const s = tree.f0[id] | 0;
    const l = tree.f1[id] | 0;
    const a = s;
    const sorted = tw.sortedBetween(tree.buf, a, a + l, ignoresFirst, ignoresLast, collapsesStart, collapsesEnd);
    if (sorted === null) continue;
    const start = tree.startText();
    tree.write(sorted, 0, sorted.length);
    tree.endText(start);
    tree.f0[id] = tree.rs | 0;
    tree.f1[id] = tree.rl | 0;
  }
}
