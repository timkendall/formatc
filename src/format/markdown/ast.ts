// Port of vendor/bun/src/format/markdown/ast.rs: the syntax tree of a Markdown text: mdast as mdast-util-from-markdown builds
// it, with the nodes that Prettier's extensions add.
//
// The tree is flat (struct of arrays): a node is an index. A string (`Str` in Rust) is a handle `h` into the string table
// (`strStart`, `strLen`, `strOwned`): a range of the text, or of `strings` if it is not written the way it is meant.
// `STR_NO` (0) is `null`, `STR_EMPTY` (1) is the empty string. After `tree.resolve(h)`, the string is
// `tree.rBuf[tree.rStart, tree.rEnd)`. Rust's `Option<NodeId>` and `NodeId::MAX` are `NONE` (-1).
import { ByteBuf } from "../../base/bytebuf.ts";

export const K_ROOT = 0;
export const K_FRONT_MATTER = 1;
export const K_PARAGRAPH = 2;
export const K_HEADING = 3;
export const K_THEMATIC_BREAK = 4;
export const K_BLOCKQUOTE = 5;
export const K_LIST = 6;
export const K_LIST_ITEM = 7;
export const K_HTML = 8;
export const K_CODE = 9;
export const K_DEFINITION = 10;
export const K_FOOTNOTE_DEFINITION = 11;
// For oxfmt: what is between `:::name`, which is its `value`, and `:::`, which is `second`.
export const K_DIRECTIVE = 12;
export const K_TABLE = 13;
export const K_TABLE_ROW = 14;
export const K_TABLE_CELL = 15;
export const K_MATH = 16;
export const K_LIQUID_NODE = 17;
export const K_TEXT = 18;
export const K_EMPHASIS = 19;
export const K_STRONG = 20;
export const K_DELETE = 21;
export const K_INLINE_CODE = 22;
export const K_BREAK = 23;
export const K_LINK = 24;
export const K_IMAGE = 25;
export const K_LINK_REFERENCE = 26;
export const K_IMAGE_REFERENCE = 27;
export const K_FOOTNOTE_REFERENCE = 28;
export const K_INLINE_MATH = 29;
export const K_WIKI_LINK = 30;
// MDX: `import ..`, `export ..`, HTML that is not a comment, `{/* .. */}`.
export const K_IMPORT = 31;
export const K_EXPORT = 32;
export const K_JSX = 33;
export const K_ES_COMMENT = 34;
// What Prettier's `splitText` makes of a `Text`: words and white space, which are not nodes here.
export const K_SENTENCE = 35;

export const NONE = -1;

export const STR_NO = 0;
export const STR_EMPTY = 1;

// ReferenceType
export const REFERENCE_SHORTCUT = 0;
export const REFERENCE_COLLAPSED = 1;
export const REFERENCE_FULL = 2;

// Align
export const ALIGN_NONE = 0;
export const ALIGN_LEFT = 1;
export const ALIGN_CENTER = 2;
export const ALIGN_RIGHT = 3;

// `flags` of a node
export const F_SPREAD = 1;
export const F_ORDERED = 2;
export const F_ALIGNED = 4;

// Token kinds (preprocess.rs `TokenKind`)
export const TK_NO_SPACE = 0;
export const TK_SPACE = 1;
export const TK_NEWLINE = 2;
export const TK_NON_CJK = 3;
export const TK_CJ_LETTER = 4;
export const TK_K_LETTER = 5;
export const TK_CJK_PUNCTUATION = 6;
// `tkFlags`
export const TF_LEADING_PUNCT = 1;
export const TF_TRAILING_PUNCT = 2;
// The token's text is in `strings`, not in the text.
export const TF_OWNED = 4;

// Prettier's `INLINE_NODE_TYPES`.
export function isInline(kind: number): boolean {
  switch (kind) {
    case K_LIQUID_NODE:
    case K_INLINE_CODE:
    case K_EMPHASIS:
    case K_ES_COMMENT:
    case K_STRONG:
    case K_DELETE:
    case K_WIKI_LINK:
    case K_LINK:
    case K_LINK_REFERENCE:
    case K_IMAGE:
    case K_IMAGE_REFERENCE:
    case K_FOOTNOTE_REFERENCE:
    case K_SENTENCE:
    case K_BREAK:
    case K_INLINE_MATH:
      return true;
    default:
      return false;
  }
}

export function isInlineWrapper(kind: number): boolean {
  return isInline(kind) || kind === K_TABLE_CELL || kind === K_PARAGRAPH || kind === K_HEADING;
}

const EMPTY = new Uint8Array(0);

export class Tree {
  // ---- nodes
  n: number;
  kind: Uint8Array;
  // F_SPREAD: `spread` of a list and an item; F_ORDERED: `ordered` of a list; F_ALIGNED: `isAligned` of a list (and, of a
  // sentence that has not been split into words, that it is in emphasis).
  flags: Uint8Array;
  // `checked` of an item: 0 is `null`, 1 `false`, 2 `true`.
  checked: Uint8Array;
  referenceType: Uint8Array;
  // For oxfmt: 1 for HTML that a certain text ends (`-->`, `</script>` ..), 1 for indented code.
  // `depth` of a heading, `start` of an ordered list, the number of columns of a table, which are at
  // `aligns[firstAlign..]`, the number of tokens of a sentence, which are at `tokens[firstAlign..]`. Of a list: how many
  // lists of its kind are right before it.
  number: Int32Array;
  firstAlign: Int32Array;
  start: Int32Array;
  end: Int32Array;
  parent: Int32Array;
  previous: Int32Array;
  next: Int32Array;
  firstChild: Int32Array;
  lastChild: Int32Array;
  // `value`, `url`, or `label` of a reference.
  value: Int32Array;
  // `lang`, `title`, or `label` of a definition.
  second: Int32Array;
  // `meta`, `alt`, or `url` of a definition...
  third: Int32Array;

  // ---- strings
  ns: number;
  strStart: Int32Array;
  strLen: Int32Array;
  strOwned: Uint8Array;
  strings: ByteBuf;

  // ---- table alignments
  aligns: Uint8Array;
  nAligns: number;

  // ---- tokens: the words and the white space of all sentences
  tkKind: Uint8Array;
  tkFlags: Uint8Array;
  tkStart: Int32Array;
  tkLen: Int32Array;
  nTokens: number;

  // ---- where each line of the text starts
  lineStarts: Int32Array;
  nLines: number;

  // The text that the tree is the syntax of (what `Str`s that are not owned are ranges of).
  src: Uint8Array;
  // Result of `resolve`.
  rBuf: Uint8Array;
  rStart: number;
  rEnd: number;

  constructor() {
    const cap = 256;
    this.n = 0;
    this.kind = new Uint8Array(cap);
    this.flags = new Uint8Array(cap);
    this.checked = new Uint8Array(cap);
    this.referenceType = new Uint8Array(cap);
    this.number = new Int32Array(cap);
    this.firstAlign = new Int32Array(cap);
    this.start = new Int32Array(cap);
    this.end = new Int32Array(cap);
    this.parent = new Int32Array(cap);
    this.previous = new Int32Array(cap);
    this.next = new Int32Array(cap);
    this.firstChild = new Int32Array(cap);
    this.lastChild = new Int32Array(cap);
    this.value = new Int32Array(cap);
    this.second = new Int32Array(cap);
    this.third = new Int32Array(cap);
    this.ns = 0;
    this.strStart = new Int32Array(cap);
    this.strLen = new Int32Array(cap);
    this.strOwned = new Uint8Array(cap);
    this.strings = new ByteBuf(1024);
    this.aligns = new Uint8Array(64);
    this.nAligns = 0;
    this.tkKind = new Uint8Array(cap);
    this.tkFlags = new Uint8Array(cap);
    this.tkStart = new Int32Array(cap);
    this.tkLen = new Int32Array(cap);
    this.nTokens = 0;
    this.lineStarts = new Int32Array(cap);
    this.nLines = 0;
    this.src = EMPTY;
    this.rBuf = EMPTY;
    this.rStart = 0;
    this.rEnd = 0;
    this.clear();
  }

  clear(): void {
    this.n = 0;
    this.ns = 2;
    this.strStart[0] = 0;
    this.strLen[0] = 0;
    this.strOwned[0] = 0;
    this.strStart[1] = 0;
    this.strLen[1] = 0;
    this.strOwned[1] = 0;
    this.strings.reset();
    this.nAligns = 0;
    this.nTokens = 0;
    this.nLines = 0;
  }

  // ---- growth

  growNodes(): void {
    const cap = this.kind.length * 2;
    this.kind = growU8(this.kind, cap);
    this.flags = growU8(this.flags, cap);
    this.checked = growU8(this.checked, cap);
    this.referenceType = growU8(this.referenceType, cap);
    this.number = growI32(this.number, cap);
    this.firstAlign = growI32(this.firstAlign, cap);
    this.start = growI32(this.start, cap);
    this.end = growI32(this.end, cap);
    this.parent = growI32(this.parent, cap);
    this.previous = growI32(this.previous, cap);
    this.next = growI32(this.next, cap);
    this.firstChild = growI32(this.firstChild, cap);
    this.lastChild = growI32(this.lastChild, cap);
    this.value = growI32(this.value, cap);
    this.second = growI32(this.second, cap);
    this.third = growI32(this.third, cap);
  }

  growStrs(): void {
    const cap = this.strStart.length * 2;
    this.strStart = growI32(this.strStart, cap);
    this.strLen = growI32(this.strLen, cap);
    this.strOwned = growU8(this.strOwned, cap);
  }

  growTokens(): void {
    const cap = this.tkKind.length * 2;
    this.tkKind = growU8(this.tkKind, cap);
    this.tkFlags = growU8(this.tkFlags, cap);
    this.tkStart = growI32(this.tkStart, cap);
    this.tkLen = growI32(this.tkLen, cap);
  }

  // ---- nodes

  // Adds a node that is not in anything yet.
  add(kind: number, start: number, end: number): number {
    const i = this.n;
    if (i === this.kind.length) this.growNodes();
    this.kind[i] = kind | 0;
    this.flags[i] = 0;
    this.checked[i] = 0;
    this.referenceType[i] = REFERENCE_SHORTCUT;
    this.number[i] = 0;
    this.firstAlign[i] = 0;
    this.start[i] = start | 0;
    this.end[i] = end | 0;
    this.parent[i] = NONE;
    this.previous[i] = NONE;
    this.next[i] = NONE;
    this.firstChild[i] = NONE;
    this.lastChild[i] = NONE;
    this.value[i] = STR_NO;
    this.second[i] = STR_NO;
    this.third[i] = STR_NO;
    this.n = i + 1;
    return i;
  }

  kindOf(id: number): number {
    return id >= 0 && id < this.n ? this.kind[id] | 0 : -1;
  }

  // Makes `child` the last child of `parent`.
  append(parent: number, child: number): void {
    if (parent < 0 || parent >= this.n) return;
    const last = this.lastChild[parent] | 0;
    this.parent[child] = parent;
    this.previous[child] = last;
    this.next[child] = NONE;
    if (last >= 0) this.next[last] = child;
    else this.firstChild[parent] = child;
    this.lastChild[parent] = child;
  }

  // Makes `child` the first child of `parent`.
  prepend(parent: number, child: number): void {
    if (parent < 0 || parent >= this.n) return;
    const first = this.firstChild[parent] | 0;
    this.parent[child] = parent;
    this.previous[child] = NONE;
    this.next[child] = first;
    if (first >= 0) this.previous[first] = child;
    else this.lastChild[parent] = child;
    this.firstChild[parent] = child;
  }

  // Takes `child` out of its parent.
  detach(child: number): void {
    if (child < 0 || child >= this.n) return;
    const parent = this.parent[child] | 0;
    const previous = this.previous[child] | 0;
    const next = this.next[child] | 0;
    if (previous >= 0) this.next[previous] = next;
    else if (parent >= 0) this.firstChild[parent] = next;
    if (next >= 0) this.previous[next] = previous;
    else if (parent >= 0) this.lastChild[parent] = previous;
    this.parent[child] = NONE;
    this.previous[child] = NONE;
    this.next[child] = NONE;
  }

  // ---- strings

  // The text from `start` to `end`.
  strSource(start: number, end: number): number {
    const h = this.ns;
    if (h === this.strStart.length) this.growStrs();
    this.strStart[h] = start | 0;
    this.strLen[h] = end > start ? (end - start) | 0 : 0;
    this.strOwned[h] = 0;
    this.ns = h + 1;
    return h;
  }

  // A string that is not written in the text the way it is meant: the bytes appended to `strings` since `at`, where `at`
  // is `ownedBegin()`.
  ownedBegin(): number {
    return this.strings.len;
  }
  ownedEnd(at: number): number {
    const h = this.ns;
    if (h === this.strStart.length) this.growStrs();
    this.strStart[h] = at | 0;
    this.strLen[h] = (this.strings.len - at) | 0;
    this.strOwned[h] = 1;
    this.ns = h + 1;
    return h;
  }

  // `str(text, string)`: after it the string is `rBuf[rStart, rEnd)`. A string that is `null` is empty.
  resolve(h: number): void {
    if (h === STR_NO) {
      this.rBuf = EMPTY;
      this.rStart = 0;
      this.rEnd = 0;
      return;
    }
    const s = this.strStart[h] | 0;
    this.rBuf = (this.strOwned[h] | 0) !== 0 ? this.strings.data : this.src;
    this.rStart = s;
    this.rEnd = s + (this.strLen[h] | 0);
  }

  strLength(h: number): number {
    return h === STR_NO ? 0 : this.strLen[h] | 0;
  }

  // ---- tokens

  // Adds a token. `start`: absolute index into the text or into `strings`.
  addToken(kind: number, flags: number, start: number, len: number): void {
    const i = this.nTokens;
    if (i === this.tkKind.length) this.growTokens();
    this.tkKind[i] = kind | 0;
    this.tkFlags[i] = flags | 0;
    this.tkStart[i] = start | 0;
    this.tkLen[i] = len | 0;
    this.nTokens = i + 1;
  }

  // ---- aligns

  addAlign(align: number): void {
    const i = this.nAligns;
    if (i === this.aligns.length) this.aligns = growU8(this.aligns, i * 2);
    this.aligns[i] = align | 0;
    this.nAligns = i + 1;
  }

  // ---- lines

  addLineStart(offset: number): void {
    const i = this.nLines;
    if (i === this.lineStarts.length) this.lineStarts = growI32(this.lineStarts, i * 2);
    this.lineStarts[i] = offset | 0;
    this.nLines = i + 1;
  }

  // The number of the line that `offset` is on. The first is 1.
  line(offset: number): number {
    // partition_point(|start| start <= offset).max(1)
    const starts = this.lineStarts;
    let lo = 0;
    let hi = this.nLines;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] | 0) <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo < 1 ? 1 : lo;
  }

  // Where the line that `offset` is on starts.
  lineStart(offset: number): number {
    const l = this.line(offset);
    return l - 1 < this.nLines ? this.lineStarts[l - 1] | 0 : 0;
  }
}

function growU8(a: Uint8Array, cap: number): Uint8Array {
  const b = new Uint8Array(cap);
  b.set(a);
  return b;
}

function growI32(a: Int32Array, cap: number): Int32Array {
  const b = new Int32Array(cap);
  b.set(a);
  return b;
}
