// Port of vendor/bun/src/format/handlebars/verify.rs: `--debug-check`: the formatted template says what the template says.
//
// Both are parsed, and each tree is written down without what the printer is free to change: how the words of a text are
// spread over lines, quotes, how a number is written, `{{else}}{{#if a}}` for `{{else if a}}`, all but the letters of a
// style sheet, the front matter. What is written down has to be the same.
//
// With `sortTailwindcss`, the classes in a text or a string of an attribute that is sorted are written down in one order,
// each once. One that touches what is before or behind the text has to stay where it is, and so has the white space there.
import { ByteBuf } from "../../base/bytebuf.ts";
import { Stack } from "../../base/stack.ts";
import {
  CHAINED,
  CLOSE_CLOSE,
  CLOSE_OPEN,
  INVERSE_CLOSE,
  INVERSE_OPEN,
  K_ATTR,
  K_BLOCK,
  K_BLOCK_STATEMENT,
  K_BOOLEAN,
  K_COMMENT,
  K_CONCAT,
  K_DOCTYPE,
  K_ELEMENT,
  K_ELEMENT_MODIFIER,
  K_HASH_PAIR,
  K_MUSTACHE,
  K_MUSTACHE_COMMENT,
  K_NULL,
  K_NUMBER,
  K_PATH,
  K_STRING,
  K_SUB_EXPRESSION,
  K_TEMPLATE,
  K_TEXT,
  K_UNDEFINED,
  NOTHING,
  OPEN_OPEN,
  Tree,
} from "./ast.ts";
import { isHtmlWhiteSpace, trimAsciiEnd, trimAsciiStart } from "./printer.ts";
import { tailwindAttributeIsSorted } from "./tailwind.ts";

// `touches`: [touches_start, touches_end] (bit 0, bit 1) of the value of an attribute whose classes are sorted; -1: none.
const NO_TOUCHES: number = -1;

function indexOfWhiteSpace(buf: Uint8Array, a: number, b: number): number {
  let i = a;
  while (i < b && !isHtmlWhiteSpace(buf[i] | 0)) i = i + 1;
  return i;
}

function eqAscii(buf: Uint8Array, a: number, b: number, lit: string): boolean {
  const n = lit.length;
  if (b - a !== n) return false;
  for (let i = 0; i < n; i++) {
    if ((buf[a + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

function eqAsciiIgnoreCase(buf: Uint8Array, a: number, b: number, lit: string): boolean {
  const n = lit.length;
  if (b - a !== n) return false;
  for (let i = 0; i < n; i++) {
    let c = buf[a + i] | 0;
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== lit.charCodeAt(i)) return false;
  }
  return true;
}

function indexOfByteIn(buf: Uint8Array, a: number, b: number, byte: number): number {
  for (let i = a; i < b; i++) {
    if ((buf[i] | 0) === byte) return i;
  }
  return -1;
}

// Whether `a` is before `b` as byte strings.
function lessBytes(buf: Uint8Array, a1: number, b1: number, a2: number, b2: number): boolean {
  const n1 = b1 - a1;
  const n2 = b2 - a2;
  const n = n1 < n2 ? n1 : n2;
  for (let i = 0; i < n; i++) {
    const x = buf[a1 + i] | 0;
    const y = buf[a2 + i] | 0;
    if (x !== y) return x < y;
  }
  return n1 < n2;
}

export class Writer {
  tree: Tree;
  source: Uint8Array;
  isWhiteSpaceSensitive: boolean;
  out: ByteBuf;
  // The texts that follow each other, as one.
  run: ByteBuf;
  // How many elements are around in which all white space counts.
  preDepth: number;
  tailwind: boolean;
  // In the value of an attribute whose classes are sorted: whether what a string becomes is right behind, and right before,
  // something that is no white space, or may be none.
  touches: number;
  stack: Stack;
  f64: Float64Array;

  constructor() {
    this.tree = new Tree();
    this.source = new Uint8Array(0);
    this.isWhiteSpaceSensitive = true;
    this.out = new ByteBuf(1024);
    this.run = new ByteBuf(256);
    this.preDepth = 0;
    this.tailwind = false;
    this.touches = NO_TOUCHES;
    this.stack = Stack.create();
    this.f64 = new Float64Array(1);
  }

  // `mark` says what comes, a NUL ends it.
  field(mark: number, buf: Uint8Array, a: number, b: number): void {
    this.out.push(mark);
    this.out.append(buf, a, b);
    this.out.push(0);
  }

  // The text `(s, l)`.
  fieldText(mark: number, s: number, l: number): void {
    const a = s;
    this.field(mark, this.tree.buf, a, a + l);
  }

  asWritten(node: number): void {
    this.field(87, this.source, this.tree.start[node] | 0, this.tree.end[node] | 0); // 'W'
  }

  names(namesStart: number, namesLen: number): void {
    const tree = this.tree;
    for (let i = 0; i < namesLen; i++) {
      this.fieldText(124, tree.nameStart[namesStart + i] | 0, tree.nameLen[namesStart + i] | 0); // '|'
    }
  }

  words(buf: Uint8Array, a: number, b: number): void {
    let rest = trimAsciiStart(buf, a, b);
    while (rest < b) {
      const len = indexOfWhiteSpace(buf, rest, b);
      this.field(119, buf, rest, len); // 'w'
      rest = trimAsciiStart(buf, len, b);
    }
  }

  // The classes in `buf[a, b)`. See the top of the file.
  classes(buf: Uint8Array, a: number, b: number, touches: number): void {
    const touchesStart = (touches & 1) !== 0;
    const touchesEnd = (touches & 2) !== 0;
    const ws: number[] = [];
    const we: number[] = [];
    let rest = trimAsciiStart(buf, a, b);
    while (rest < b) {
      const len = indexOfWhiteSpace(buf, rest, b);
      ws.push(rest);
      we.push(len);
      rest = trimAsciiStart(buf, len, b);
    }
    let from = 0;
    let to = ws.length;
    const hasBlankStart = b > a && isHtmlWhiteSpace(buf[a] | 0);
    const hasBlankEnd = b > a && isHtmlWhiteSpace(buf[b - 1] | 0);
    if (touchesStart) {
      if (!hasBlankStart && to > from) {
        this.field(70, buf, ws[from], we[from]); // 'F'
        from = from + 1;
      } else {
        this.out.push(32);
      }
    }
    let last = -1;
    if (touchesEnd && !hasBlankEnd) {
      if (to > from) {
        last = to - 1;
        to = to - 1;
      }
    }
    // Sort the words from..to.
    const idx: number[] = [];
    for (let i = from; i < to; i++) idx.push(i);
    idx.sort((x: number, y: number): number => {
      if (lessBytes(buf, ws[x], we[x], ws[y], we[y])) return -1;
      if (lessBytes(buf, ws[y], we[y], ws[x], we[x])) return 1;
      return 0;
    });
    let prev = -1;
    for (let k = 0; k < idx.length; k++) {
      const w = idx[k];
      if (prev < 0 || lessBytes(buf, ws[prev], we[prev], ws[w], we[w]) || lessBytes(buf, ws[w], we[w], ws[prev], we[prev])) {
        this.field(119, buf, ws[w], we[w]);
      }
      prev = w;
    }
    if (last >= 0) this.field(76, buf, ws[last], we[last]); // 'L'
    else if (touchesEnd) this.out.push(32);
  }

  // Whether the text or string `id` has white space at its start (`isStart`) or its end.
  hasBlankAt(id: number, isStart: boolean): boolean {
    const tree = this.tree;
    const k = tree.tag[id] | 0;
    if (k !== K_TEXT && k !== K_STRING) return false;
    const s = tree.f0[id] | 0;
    const l = tree.f1[id] | 0;
    if (l === 0) return false;
    const buf = tree.buf;
    const a = s;
    return isHtmlWhiteSpace(buf[isStart ? a : a + l - 1] | 0);
  }

  // `touches` of the one at `index` of the `count` nodes at `from` of `lists`, which follow each other in something whose
  // own is `outer`.
  touchesOf(listStart: number, listLen: number, index: number, outer: number): number {
    const lists = this.tree.lists;
    let start = (outer & 1) !== 0;
    let end = (outer & 2) !== 0;
    if (index > 0) start = !this.hasBlankAt(lists[listStart + index - 1] | 0, false);
    if (index + 1 < listLen) end = !this.hasBlankAt(lists[listStart + index + 1] | 0, true);
    return (start ? 1 : 0) | (end ? 2 : 0);
  }

  isWhiteSpaceRange(listStart: number, listLen: number): boolean {
    const tree = this.tree;
    for (let i = 0; i < listLen; i++) {
      const id = tree.lists[listStart + i] | 0;
      if (!this.isWhiteSpaceNode(id)) return false;
    }
    return true;
  }

  isWhiteSpaceNode(id: number): boolean {
    const tree = this.tree;
    if ((tree.tag[id] | 0) !== K_TEXT) return false;
    const s = tree.f0[id] | 0;
    const a = s;
    const b = a + (tree.f1[id] | 0);
    return trimAsciiStart(tree.buf, a, b) >= b;
  }

  template(template: number): void {
    const tree = this.tree;
    if ((tree.tag[template] | 0) === K_TEMPLATE) this.children(tree.f0[template] | 0, tree.f1[template] | 0, false);
  }

  // `isInStyle`: the white space between a text and what is no text counts.
  children(listStart: number, listLen: number, isInStyle: boolean): void {
    if (!this.stack.enter()) return;
    const tree = this.tree;
    let index = 0;
    while (index < listLen) {
      const id = tree.lists[listStart + index] | 0;
      if ((tree.tag[id] | 0) !== K_TEXT) {
        this.child(id);
        index = index + 1;
        continue;
      }
      const first = index;
      const run = this.run;
      run.reset();
      while (index < listLen && (tree.tag[tree.lists[listStart + index] | 0] | 0) === K_TEXT) {
        const t = tree.lists[listStart + index] | 0;
        tree.copyText(tree.f0[t] | 0, tree.f1[t] | 0, run);
        index = index + 1;
      }
      const rb = run.data;
      const rn = run.len;
      if (this.preDepth > 0) {
        this.field(116, rb, 0, rn); // 't'
      } else {
        if (isInStyle && first > 0 && trimAsciiStart(rb, 0, rn) > 0) this.out.push(32);
        this.words(rb, 0, rn);
        if (isInStyle && index < listLen && trimAsciiEnd(rb, 0, rn) < rn) this.out.push(32);
      }
    }
    this.stack.leave();
  }

  child(id: number): void {
    const tree = this.tree;
    if ((tree.written[id] | 0) !== 0) {
      this.asWritten(id);
      return;
    }
    switch (tree.tag[id] | 0) {
      case K_ELEMENT:
        this.element(id);
        break;
      case K_BLOCK_STATEMENT:
        this.block(id, false);
        break;
      case K_MUSTACHE:
        this.mustache(id);
        break;
      case K_MUSTACHE_COMMENT:
        this.mustacheComment(id, tree.f0[id] | 0, tree.f1[id] | 0);
        break;
      case K_COMMENT:
        this.fieldText(99, tree.f0[id] | 0, tree.f1[id] | 0); // 'c'
        break;
      case K_DOCTYPE:
        this.asWritten(id);
        break;
      default:
        break;
    }
  }

  mustacheComment(node: number, vs: number, vl: number): void {
    const tree = this.tree;
    const src = this.source;
    const start = tree.start[node] | 0;
    const end = tree.end[node] | 0;
    const left = start + 2 < src.length && (src[start + 2] | 0) === 126;
    const right = end >= 3 && end - 3 < src.length && (src[end - 3] | 0) === 126;
    this.out.push(left ? 1 : 0);
    this.out.push(right ? 1 : 0);
    this.fieldText(33, vs, vl); // '!'
  }

  element(id: number): void {
    const tree = this.tree;
    const ts = tree.f0[id] | 0;
    const tl = tree.f1[id] | 0;
    const attrStart = tree.f2[id] | 0;
    const attrLen = tree.f3[id] | 0;
    const bpStart = tree.f4[id] | 0;
    const bpLen = tree.f5[id] | 0;
    const childStart = tree.f6[id] | 0;
    const childLen = tree.f7[id] | 0;
    const tbuf = tree.buf;
    const ta = ts;
    const tb = ta + tl;
    this.field(60, tbuf, ta, tb); // '<'
    for (let i = 0; i < attrLen; i++) this.attribute(tree.lists[attrStart + i] | 0);
    this.names(bpStart, bpLen);
    this.out.push(62); // '>'
    const is = (name: string): boolean => eqAsciiIgnoreCase(tbuf, ta, tb, name);
    const keepsWhiteSpace =
      !this.isWhiteSpaceRange(childStart, childLen) && (is("script") || is("textarea") || (is("pre") && this.isWhiteSpaceSensitive));
    if (keepsWhiteSpace) this.preDepth = this.preDepth + 1;
    const isStyleTag = eqAscii(tbuf, ta, tb, "style");
    let done = false;
    if (isStyleTag && childLen === 1) {
      const only = tree.lists[childStart] | 0;
      if ((tree.tag[only] | 0) === K_TEXT) {
        // It may have been formatted.
        const cs = tree.f0[only] | 0;
        const buf = tree.buf;
        const a = cs;
        const b = a + (tree.f1[only] | 0);
        for (let i = a; i < b; i++) {
          const c = buf[i] | 0;
          if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 0x80) this.out.push(c >= 65 && c <= 90 ? c + 32 : c);
        }
        done = true;
      }
    }
    if (!done) this.children(childStart, childLen, isStyleTag);
    if (keepsWhiteSpace) this.preDepth = this.preDepth - 1;
    this.out.push(47); // '/'
  }

  attribute(id: number): void {
    const tree = this.tree;
    if ((tree.written[id] | 0) !== 0) {
      this.asWritten(id);
      return;
    }
    const kind = tree.tag[id] | 0;
    if (kind === K_ATTR) {
      const ns = tree.f0[id] | 0;
      const nl = tree.f1[id] | 0;
      const na = ns;
      const nbuf = tree.buf;
      this.field(64, nbuf, na, na + nl); // '@'
      const isClass = eqAsciiIgnoreCase(nbuf, na, na + nl, "class");
      const isSorted = this.tailwind && tailwindAttributeIsSorted(nbuf, na, na + nl);
      const value = tree.f2[id] | 0;
      const vk = tree.tag[value] | 0;
      if (vk === K_TEXT && (tree.f1[value] | 0) === 0 && (tree.start[value] | 0) === (tree.end[value] | 0)) {
        // No value.
      } else if (vk === K_CONCAT) {
        this.out.push(61); // '='
        const partStart = tree.f0[value] | 0;
        const partLen = tree.f1[value] | 0;
        for (let index = 0; index < partLen; index++) {
          this.touches = isSorted ? this.touchesOf(partStart, partLen, index, 0) : NO_TOUCHES;
          this.partOfValue(tree.lists[partStart + index] | 0, isClass);
        }
      } else {
        this.out.push(61);
        this.touches = isSorted ? 0 : NO_TOUCHES;
        this.partOfValue(value, isClass);
      }
      this.touches = NO_TOUCHES;
    } else if (kind === K_ELEMENT_MODIFIER) {
      this.out.push(77); // 'M'
      this.call(tree.f0[id] | 0, tree.f1[id] | 0, tree.f2[id] | 0, tree.f3[id] | 0, tree.f4[id] | 0);
    } else if (kind === K_MUSTACHE_COMMENT) {
      this.mustacheComment(id, tree.f0[id] | 0, tree.f1[id] | 0);
    }
  }

  partOfValue(node: number, isClass: boolean): void {
    const tree = this.tree;
    if ((tree.tag[node] | 0) !== K_TEXT) {
      this.mustache(node);
      return;
    }
    const cs = tree.f0[node] | 0;
    const buf = tree.buf;
    const a = cs;
    const b = a + (tree.f1[node] | 0);
    if (this.touches !== NO_TOUCHES) {
      this.classes(buf, a, b, this.touches);
      return;
    }
    if (isClass) {
      this.words(buf, a, b);
      return;
    }
    // The quote that the value is in is written as an entity.
    this.out.push(116); // 't'
    let rest = a;
    while (true) {
      const at = indexOfByteIn(buf, rest, b, 38);
      if (at < 0) break;
      this.out.append(buf, rest, at);
      rest = at;
      let character = 38;
      let len = 1;
      if (rest + 6 <= b && (buf[rest + 1] | 0) === 113 && (buf[rest + 2] | 0) === 117 && (buf[rest + 3] | 0) === 111 && (buf[rest + 4] | 0) === 116 && (buf[rest + 5] | 0) === 59) {
        character = 34;
        len = 6;
      } else if (rest + 6 <= b && (buf[rest + 1] | 0) === 97 && (buf[rest + 2] | 0) === 112 && (buf[rest + 3] | 0) === 111 && (buf[rest + 4] | 0) === 115 && (buf[rest + 5] | 0) === 59) {
        character = 39;
        len = 6;
      }
      this.out.push(character);
      rest = rest + len;
    }
    this.out.append(buf, rest, b);
    this.out.push(0);
  }

  // `is_all_of_inverse`: nothing else but white space follows the `{{else}}` of the block that it is in. Then it makes no
  // difference whether it is written `{{else if a}}` or `{{else}}{{#if a}}..{{/if}}`, and of two tags with nothing between
  // them, what the first strips on its right and the second on its left is nothing.
  block(node: number, isAllOfInverse: boolean): void {
    const tree = this.tree;
    if ((tree.tag[node] | 0) !== K_BLOCK_STATEMENT) return;
    if (!this.stack.enter()) return;
    const path = tree.f0[node] | 0;
    const program = tree.f5[node] | 0;
    const inverse = tree.f6[node] | 0;
    let strip = tree.f7[node] | 0;
    let bodyS = 0;
    let bodyL = 0;
    let bpS = 0;
    let bpL = 0;
    if ((tree.tag[program] | 0) === K_BLOCK) {
      bodyS = tree.f0[program] | 0;
      bodyL = tree.f1[program] | 0;
      bpS = tree.f2[program] | 0;
      bpL = tree.f3[program] | 0;
    }
    let invS = 0;
    let invL = 0;
    if ((tree.tag[inverse] | 0) === K_BLOCK) {
      invS = tree.f0[inverse] | 0;
      invL = tree.f1[inverse] | 0;
    }
    let counted = 0;
    let onlyNode = -1;
    for (let i = 0; i < invL; i++) {
      const id = tree.lists[invS + i] | 0;
      if (this.preDepth > 0 || !this.isWhiteSpaceNode(id)) {
        counted = counted + 1;
        if (counted === 1) onlyNode = id;
        else break;
      }
    }
    let only = -1;
    if (counted === 1 && (tree.tag[onlyNode] | 0) === K_BLOCK_STATEMENT && (tree.written[onlyNode] | 0) === 0) only = onlyNode;
    strip = strip & ~CHAINED;
    if (only >= 0) strip = strip & ~(INVERSE_CLOSE | CLOSE_OPEN);
    if (isAllOfInverse) strip = strip & ~(OPEN_OPEN | CLOSE_CLOSE);
    this.out.push(35); // '#'
    this.out.push(strip);
    this.call(path, tree.f1[node] | 0, tree.f2[node] | 0, tree.f3[node] | 0, tree.f4[node] | 0);
    this.names(bpS, bpL);
    this.out.push(62);
    this.children(bodyS, bodyL, false);
    if (inverse !== NOTHING) {
      this.out.push(94); // '^'
      if (only >= 0) this.block(only, true);
      else this.children(invS, invL, false);
    }
    this.out.push(47);
    this.stack.leave();
  }

  mustache(node: number): void {
    const tree = this.tree;
    if ((tree.written[node] | 0) !== 0) {
      this.asWritten(node);
      return;
    }
    if ((tree.tag[node] | 0) !== K_MUSTACHE) return;
    this.out.push(123); // '{'
    this.out.push(tree.f5[node] | 0);
    this.out.push(tree.f6[node] | 0);
    this.call(tree.f0[node] | 0, tree.f1[node] | 0, tree.f2[node] | 0, tree.f3[node] | 0, tree.f4[node] | 0);
  }

  call(path: number, paramsStart: number, paramsLen: number, pairsStart: number, pairsLen: number): void {
    const tree = this.tree;
    this.expression(path);
    const outer = this.touches;
    let isConcat = false;
    if ((tree.tag[path] | 0) === K_PATH && (tree.f4[path] | 0) === 0) {
      isConcat = tree.textIs(tree.f1[path] | 0, tree.f2[path] | 0, "concat");
    }
    for (let index = 0; index < paramsLen; index++) {
      this.out.push(44); // ','
      if (isConcat) this.touches = outer === NO_TOUCHES ? NO_TOUCHES : this.touchesOf(paramsStart, paramsLen, index, outer);
      this.expression(tree.lists[paramsStart + index] | 0);
    }
    this.touches = outer;
    for (let index = 0; index < pairsLen; index++) {
      const pair = tree.lists[pairsStart + index] | 0;
      if ((tree.tag[pair] | 0) === K_HASH_PAIR) {
        this.fieldText(61, tree.f0[pair] | 0, tree.f1[pair] | 0); // '='
        this.expression(tree.f2[pair] | 0);
      }
    }
    this.out.push(125); // '}'
  }

  expression(id: number): void {
    const tree = this.tree;
    if ((tree.written[id] | 0) !== 0) {
      this.asWritten(id);
      return;
    }
    switch (tree.tag[id] | 0) {
      case K_SUB_EXPRESSION:
        if (!this.stack.enter()) return;
        this.out.push(40); // '('
        this.call(tree.f0[id] | 0, tree.f1[id] | 0, tree.f2[id] | 0, tree.f3[id] | 0, tree.f4[id] | 0);
        this.stack.leave();
        break;
      case K_PATH:
        this.out.push(tree.f0[id] | 0);
        this.fieldText(112, tree.f1[id] | 0, tree.f2[id] | 0); // 'p'
        this.names(tree.f3[id] | 0, tree.f4[id] | 0);
        break;
      case K_STRING: {
        const vs = tree.f0[id] | 0;
        const vl = tree.f1[id] | 0;
        if (this.touches !== NO_TOUCHES) {
          const a = vs;
          this.classes(tree.buf, a, a + vl, this.touches);
        } else {
          this.fieldText(115, vs, vl); // 's'
        }
        break;
      }
      case K_NUMBER: {
        const ts = tree.f0[id] | 0;
        const a = ts;
        const value = Number(new TextDecoder().decode(tree.buf.subarray(a, a + (tree.f1[id] | 0))));
        // The bits of the number: `-0` is not `0`.
        const text = value === 0 && 1 / value < 0 ? "-0" : String(value);
        this.out.push(110); // 'n'
        this.out.appendAscii(text);
        this.out.push(0);
        break;
      }
      case K_BOOLEAN:
        this.out.push(98); // 'b'
        this.out.push(tree.f0[id] | 0);
        break;
      case K_UNDEFINED:
        this.out.push(117); // 'u'
        break;
      case K_NULL:
        this.out.push(48); // '0'
        break;
      default:
        break;
    }
  }
}
