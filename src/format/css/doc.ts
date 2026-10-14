// Port of vendor/bun/src/format/css/doc.rs: Prettier's documents (`src/document/builders`) and `printDocToString`.
//
// The printer for CSS counts on what Prettier's printer does with its documents: two line breaks in a row are an
// empty line, `dedent` undoes the last `indent`, a `fill` measures its items the way it does. The one for YAML
// counts on `markAsRoot`, `dedentToRoot` and literal lines. So this is a printer that follows Prettier's step by
// step.
//
// What it prints is `Elements`: the parts of a document one after the other, in one list. `Doc` is a tree like
// Prettier's, for who takes documents apart and puts them together in other ways. It is written to `Elements` to be
// printed.
//
// The list is shorter than the document: texts that follow each other are one element, and a group with nothing but
// text in it is one element before its text. So whoever wants to know where an element is asks `position`.
//
// ## Rust -> TS (see docs/CSS_DOC_API.md)
// - `Doc<'a>` is an Int32 handle into the per-thread pool `docPool` (SoA: tag/a/b/c/d, children in `kids`, text bytes
//   in `bytes`: a text is COPIED into the pool). Handles are immutable: functions that Rust applies in place (`clean`,
//   `strip_trailing_hardline`) return a handle. Nodes may be shared (a DAG): `join` uses the separator many times.
// - `Vec<Doc>` being built is a mark on the pool's scratch stack: `const m = docBegin(); docAdd(x); ...; docArray(m)`.
// - `Elements` / `Printer` are classes with typed arrays; `Option<usize>` is -1, `Result<_, FormatError>` is an int
//   code (`FORMAT_*`, 0 is ok).
import { ByteBuf } from "../../base/bytebuf.ts";
import { Stack, getDefaultLimit } from "../../base/stack.ts";
import {
  FORMAT_NESTED_TOO_DEEPLY,
  FORMAT_OK,
  FORMAT_TOO_LONG,
  isTooLong,
} from "../errors.ts";
import { FormatOptions, INDENT_TAB, LINE_ENDING_CR, LINE_ENDING_CRLF, resolveLineEnding } from "../options.ts";
import { isAllPrintable, stringWidth } from "../ir/width.ts";

// ───────────────────────────── Line, Alignment, IndentCommand ─────────────────────────────

// `Line`
/** `line` */
export const LINE_SPACE = 0;
/** `softline` */
export const LINE_SOFT = 1;
/** `hardlineWithoutBreakParent` */
export const LINE_HARD = 2;
/** `literallineWithoutBreakParent` */
export const LINE_LITERAL = 3;

// `IndentCommand` (with `Alignment` flattened into it). `p`, `q`, `r` are the parameters of the command.
export const IC_INDENT = 0;
/** `align(" ".repeat(p), ..)` */
export const IC_ALIGN_SPACES = 1;
/** `align("> ", ..)`: p is the id of the text (`alignTextId`) */
export const IC_ALIGN_TEXT = 2;
/** `ifBreak(align(" ".repeat(q), x), align(" ".repeat(r), x), { groupId: p })`, with `x` in it once. */
export const IC_ALIGN_IF_BREAK = 3;
/** `align(-1, ..)` */
export const IC_DEDENT = 4;
/** `align(Number.NEGATIVE_INFINITY, ..)` */
export const IC_DEDENT_TO_ROOT = 5;
/** `align({ type: "root" }, ..)` */
export const IC_MARK_AS_ROOT = 6;

// The texts of `Alignment::Text` ("> "): per thread, registered once.
const alignTexts: Uint8Array[] = [];
const alignTextNames: string[] = [];

/** Registers the text of an `Alignment::Text` (printable ASCII) and returns its id. The same text gives the same id. */
export function alignTextId(text: string): number {
  for (let i = 0; i < alignTextNames.length; i++) {
    if (alignTextNames[i] === text) return i;
  }
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) | 0;
  alignTexts.push(bytes);
  alignTextNames.push(text);
  return alignTexts.length - 1;
}

// ───────────────────────────── Doc: the tree ─────────────────────────────

export const DOC_TEXT = 0;
export const DOC_ARRAY = 1;
export const DOC_INDENT = 2;
export const DOC_ALIGN = 3;
export const DOC_DEDENT = 4;
export const DOC_DEDENT_TO_ROOT = 5;
export const DOC_MARK_AS_ROOT = 6;
export const DOC_GROUP = 7;
export const DOC_FILL = 8;
export const DOC_IF_BREAK = 9;
export const DOC_LINE_SUFFIX = 10;
export const DOC_LINE_SUFFIX_BOUNDARY = 11;
export const DOC_BREAK_PARENT = 12;
export const DOC_LINE = 13;

// Preallocated handles (never released by `docReset`).
/** `Doc::EMPTY`: an empty text. */
export const DOC_EMPTY = 0;
/** `Doc::LINE` */
export const DOC_LINE_DOC = 1;
/** `Doc::SOFTLINE` */
export const DOC_SOFTLINE = 2;
/** `Doc::Line(Line::Hard)` */
export const DOC_HARD_LINE = 3;
/** `Doc::Line(Line::Literal)` */
export const DOC_LITERAL_LINE = 4;
/** `Doc::BreakParent` */
export const DOC_BREAK_PARENT_DOC = 5;
/** `Doc::LineSuffixBoundary` */
export const DOC_LSB_DOC = 6;
/** `hardline()`: `[Line(Hard), BreakParent]` */
export const DOC_HARDLINE = 7;
const DOC_RESERVED = 8;

// Node layout, by tag:
//   TEXT: a = start in `bytes`, b = length
//   ARRAY, FILL: a = start in `kids`, b = count
//   INDENT, DEDENT, DEDENT_TO_ROOT, MARK_AS_ROOT, LINE_SUFFIX: a = contents
//   ALIGN: a = contents, b = IC_ALIGN_* kind, c = p, d = q, (r in `e`) -> see `docAlignKind/P/Q/R`
//   GROUP: a = contents, b = flags (1 should_break, 2 is_conditional), c = id
//   IF_BREAK: a = break contents, b = flat contents, c = group_id
//   LINE: a = LINE_*
export class DocPool {
  tag: Uint8Array;
  a: Int32Array;
  b: Int32Array;
  c: Int32Array;
  d: Int32Array;
  e: Int32Array;
  n: number;
  kids: Int32Array;
  nk: number;
  bytes: Uint8Array;
  nb: number;
  // The scratch stack of the lists being built.
  stack: Int32Array;
  ns: number;
  // `docPush()` / `docPop()`
  saved: Int32Array;
  nsaved: number;

  constructor() {
    this.tag = new Uint8Array(1024);
    this.a = new Int32Array(1024);
    this.b = new Int32Array(1024);
    this.c = new Int32Array(1024);
    this.d = new Int32Array(1024);
    this.e = new Int32Array(1024);
    this.n = 0;
    this.kids = new Int32Array(1024);
    this.nk = 0;
    this.bytes = new Uint8Array(4096);
    this.nb = 0;
    this.stack = new Int32Array(256);
    this.ns = 0;
    this.saved = new Int32Array(48);
    this.nsaved = 0;
    this.reset();
  }

  reset(): void {
    this.n = 0;
    this.nk = 0;
    this.nb = 0;
    this.ns = 0;
    this.nsaved = 0;
    this.node(DOC_TEXT, 0, 0, 0, 0, 0); // DOC_EMPTY
    this.node(DOC_LINE, LINE_SPACE, 0, 0, 0, 0); // DOC_LINE_DOC
    this.node(DOC_LINE, LINE_SOFT, 0, 0, 0, 0); // DOC_SOFTLINE
    this.node(DOC_LINE, LINE_HARD, 0, 0, 0, 0); // DOC_HARD_LINE
    this.node(DOC_LINE, LINE_LITERAL, 0, 0, 0, 0); // DOC_LITERAL_LINE
    this.node(DOC_BREAK_PARENT, 0, 0, 0, 0, 0); // DOC_BREAK_PARENT_DOC
    this.node(DOC_LINE_SUFFIX_BOUNDARY, 0, 0, 0, 0, 0); // DOC_LSB_DOC
    this.node(DOC_ARRAY, 0, 2, 0, 0, 0); // DOC_HARDLINE: kids [3, 5]
    this.kids[0] = DOC_HARD_LINE;
    this.kids[1] = DOC_BREAK_PARENT_DOC;
    this.nk = 2;
  }

  growNodes(): void {
    const cap = this.tag.length * 2;
    const t = new Uint8Array(cap);
    t.set(this.tag);
    this.tag = t;
    const a = new Int32Array(cap);
    a.set(this.a);
    this.a = a;
    const b = new Int32Array(cap);
    b.set(this.b);
    this.b = b;
    const c = new Int32Array(cap);
    c.set(this.c);
    this.c = c;
    const d = new Int32Array(cap);
    d.set(this.d);
    this.d = d;
    const e = new Int32Array(cap);
    e.set(this.e);
    this.e = e;
  }

  node(tag: number, a: number, b: number, c: number, d: number, e: number): number {
    const i = this.n;
    if (i === this.tag.length) this.growNodes();
    this.tag[i] = tag | 0;
    this.a[i] = a | 0;
    this.b[i] = b | 0;
    this.c[i] = c | 0;
    this.d[i] = d | 0;
    this.e[i] = e | 0;
    this.n = i + 1;
    return i;
  }

  reserveBytes(extra: number): void {
    const need = this.nb + extra;
    if (need <= this.bytes.length) return;
    let cap = this.bytes.length;
    while (cap < need) cap = cap * 2;
    const nb = new Uint8Array(cap);
    nb.set(this.bytes.subarray(0, this.nb));
    this.bytes = nb;
  }

  reserveKids(extra: number): void {
    const need = this.nk + extra;
    if (need <= this.kids.length) return;
    let cap = this.kids.length;
    while (cap < need) cap = cap * 2;
    const nk = new Int32Array(cap);
    nk.set(this.kids.subarray(0, this.nk));
    this.kids = nk;
  }

  pushStack(v: number): void {
    if (this.ns === this.stack.length) {
      const ns = new Int32Array(this.stack.length * 2);
      ns.set(this.stack);
      this.stack = ns;
    }
    this.stack[this.ns] = v | 0;
    this.ns = this.ns + 1;
  }

  // ---- text
  /** A text: a copy of `src[start, end)`. */
  text(src: Uint8Array, start: number, end: number): number {
    const len = end - start;
    if (len <= 0) return DOC_EMPTY;
    this.reserveBytes(len);
    const nb = this.nb;
    const dst = this.bytes;
    if (len < 16) {
      for (let i = 0; i < len; i++) dst[nb + i] = src[start + i] | 0;
    } else {
      dst.set(src.subarray(start, end), nb);
    }
    this.nb = nb + len;
    return this.node(DOC_TEXT, nb, len, 0, 0, 0);
  }

  /** A text of printable ASCII (a literal). */
  ascii(s: string): number {
    const len = s.length;
    if (len === 0) return DOC_EMPTY;
    this.reserveBytes(len);
    const nb = this.nb;
    const dst = this.bytes;
    for (let i = 0; i < len; i++) dst[nb + i] = s.charCodeAt(i) | 0;
    this.nb = nb + len;
    return this.node(DOC_TEXT, nb, len, 0, 0, 0);
  }

  /** A text of `count` copies of `byte`. */
  repeated(byte: number, count: number): number {
    if (count <= 0) return DOC_EMPTY;
    this.reserveBytes(count);
    const nb = this.nb;
    this.bytes.fill(byte, nb, nb + count);
    this.nb = nb + count;
    return this.node(DOC_TEXT, nb, count, 0, 0, 0);
  }

  /** The text `doc` (a DOC_TEXT) but only its first `len` bytes. */
  textPrefix(doc: number, len: number): number {
    if (len <= 0) return DOC_EMPTY;
    return this.node(DOC_TEXT, this.a[doc] | 0, len, 0, 0, 0);
  }

  // ---- lists
  /** Starts a list: returns the mark. */
  begin(): number {
    return this.ns;
  }
  add(doc: number): void {
    this.pushStack(doc);
  }
  /** Ends the list started at `mark` as an `Array`. */
  array(mark: number): number {
    return this.list(DOC_ARRAY, mark);
  }
  /** Ends the list started at `mark` as a `Fill`. */
  fill(mark: number): number {
    return this.list(DOC_FILL, mark);
  }
  list(tag: number, mark: number): number {
    const count = this.ns - mark;
    this.reserveKids(count);
    const nk = this.nk;
    const kids = this.kids;
    const stack = this.stack;
    for (let i = 0; i < count; i++) kids[nk + i] = stack[mark + i] | 0;
    this.nk = nk + count;
    this.ns = mark;
    return this.node(tag, nk, count, 0, 0, 0);
  }
  /** Throws away the list started at `mark`. */
  abandon(mark: number): void {
    this.ns = mark;
  }
  /** The number of parts of the list being built since `mark`. */
  count(mark: number): number {
    return this.ns - mark;
  }
  /** The `i`-th part (from 0) of the list being built since `mark`. */
  part(mark: number, i: number): number {
    return this.stack[mark + i] | 0;
  }
  /** Adds the parts of the Array/Fill `doc` to the list being built. */
  addParts(doc: number): void {
    const start = this.a[doc] | 0;
    const count = this.b[doc] | 0;
    for (let i = 0; i < count; i++) this.pushStack(this.kids[start + i] | 0);
  }

  array2(x: number, y: number): number {
    const m = this.ns;
    this.pushStack(x);
    this.pushStack(y);
    return this.list(DOC_ARRAY, m);
  }
  array3(x: number, y: number, z: number): number {
    const m = this.ns;
    this.pushStack(x);
    this.pushStack(y);
    this.pushStack(z);
    return this.list(DOC_ARRAY, m);
  }
  array4(x: number, y: number, z: number, w: number): number {
    const m = this.ns;
    this.pushStack(x);
    this.pushStack(y);
    this.pushStack(z);
    this.pushStack(w);
    return this.list(DOC_ARRAY, m);
  }

  // ---- wrappers
  indent(contents: number): number {
    return this.node(DOC_INDENT, contents, 0, 0, 0, 0);
  }
  dedent(contents: number): number {
    return this.node(DOC_DEDENT, contents, 0, 0, 0, 0);
  }
  dedentToRoot(contents: number): number {
    return this.node(DOC_DEDENT_TO_ROOT, contents, 0, 0, 0, 0);
  }
  markAsRoot(contents: number): number {
    return this.node(DOC_MARK_AS_ROOT, contents, 0, 0, 0, 0);
  }
  lineSuffix(contents: number): number {
    return this.node(DOC_LINE_SUFFIX, contents, 0, 0, 0, 0);
  }
  group(contents: number): number {
    return this.node(DOC_GROUP, contents, 0, 0, 0, 0);
  }
  groupWith(contents: number, shouldBreak: boolean): number {
    return this.node(DOC_GROUP, contents, shouldBreak ? 1 : 0, 0, 0, 0);
  }
  /** A group with all its fields: `id` not 0 is what an `ifBreak` can ask about it by. */
  groupFull(contents: number, shouldBreak: boolean, id: number, isConditional: boolean): number {
    return this.node(DOC_GROUP, contents, (shouldBreak ? 1 : 0) | (isConditional ? 2 : 0), id, 0, 0);
  }
  /** `align(" ".repeat(width), contents)` */
  alignWithSpaces(width: number, contents: number): number {
    return this.node(DOC_ALIGN, contents, IC_ALIGN_SPACES, width, 0, 0);
  }
  /** `align("> ", contents)`: `textId` from `alignTextId`. */
  alignWithText(textId: number, contents: number): number {
    return this.node(DOC_ALIGN, contents, IC_ALIGN_TEXT, textId, 0, 0);
  }
  /** `Alignment::IfBreak { group_id, broken, flat }` */
  alignIfBreak(groupId: number, broken: number, flat: number, contents: number): number {
    return this.node(DOC_ALIGN, contents, IC_ALIGN_IF_BREAK, groupId, broken, flat);
  }
  ifBreak(breakContents: number, flatContents: number, groupId: number): number {
    return this.node(DOC_IF_BREAK, breakContents, flatContents, groupId, 0, 0);
  }
  line(kind: number): number {
    switch (kind) {
      case LINE_SPACE: return DOC_LINE_DOC;
      case LINE_SOFT: return DOC_SOFTLINE;
      case LINE_HARD: return DOC_HARD_LINE;
      default: return DOC_LITERAL_LINE;
    }
  }

  // ---- reading
  isEmptyText(doc: number): boolean {
    return (this.tag[doc] | 0) === DOC_TEXT && (this.b[doc] | 0) === 0;
  }
}

/** The per-thread pool. Hoist `docPool.tag` etc. into locals in loops. */
export const docPool: DocPool = new DocPool();

/** Forgets every document made so far (the preallocated handles stay). Call at the start of a format call that builds `Doc`s;
 * never in a function that can run while another document is being built (embedded code): use `docPush`/`docPop` there. */
export function docReset(): void {
  docPool.reset();
}

/** Saves the size of the pool. `docPop` throws away what has been made since: for a code that makes documents and is
 * done with them when it returns (CSS in a template). */
export function docPush(): void {
  const p = docPool;
  if (p.nsaved + 4 > p.saved.length) {
    const s = new Int32Array(p.saved.length * 2);
    s.set(p.saved);
    p.saved = s;
  }
  const i = p.nsaved;
  p.saved[i] = p.n | 0;
  p.saved[i + 1] = p.nk | 0;
  p.saved[i + 2] = p.nb | 0;
  p.saved[i + 3] = p.ns | 0;
  p.nsaved = i + 4;
}
export function docPop(): void {
  const p = docPool;
  const i = p.nsaved - 4;
  p.n = p.saved[i] | 0;
  p.nk = p.saved[i + 1] | 0;
  p.nb = p.saved[i + 2] | 0;
  p.ns = p.saved[i + 3] | 0;
  p.nsaved = i;
}

// ---- free functions with the names of Rust's builders (they work on `docPool`)
/** `Doc::from(&[u8])`: a copy of `src[start, end)`. */
export function docText(src: Uint8Array, start: number, end: number): number {
  return docPool.text(src, start, end);
}
/** `Doc::from("literal")` (printable ASCII). */
export function docAscii(s: string): number {
  return docPool.ascii(s);
}
export function docBegin(): number {
  return docPool.begin();
}
export function docAdd(doc: number): void {
  docPool.add(doc);
}
export function docArray(mark: number): number {
  return docPool.array(mark);
}
export function docFill(mark: number): number {
  return docPool.fill(mark);
}
/** `docs![x, y]` */
export function docs2(x: number, y: number): number {
  return docPool.array2(x, y);
}
export function docs3(x: number, y: number, z: number): number {
  return docPool.array3(x, y, z);
}
export function docs4(x: number, y: number, z: number, w: number): number {
  return docPool.array4(x, y, z, w);
}
/** `hardline()` */
export function hardline(): number {
  return DOC_HARDLINE;
}
export function indent(contents: number): number {
  return docPool.indent(contents);
}
export function group(contents: number): number {
  return docPool.group(contents);
}
export function groupWith(contents: number, shouldBreak: boolean): number {
  return docPool.groupWith(contents, shouldBreak);
}
export function alignWithSpaces(width: number, contents: number): number {
  return docPool.alignWithSpaces(width, contents);
}
/** `fill(parts)`: the parts are the list since `mark`. */
export function fill(mark: number): number {
  return docPool.fill(mark);
}
/** `join(separator, docs)`: the list since `mark` becomes `a, sep, b, sep, c`; returns the mark of the new list (the same mark). */
export function joinList(separator: number, mark: number): void {
  const p = docPool;
  const count = p.ns - mark;
  if (count <= 1) return;
  // Spread out from the back: item i goes to mark + 2 * i.
  const need = mark + count * 2 - 1;
  while (p.stack.length < need) {
    const ns = new Int32Array(p.stack.length * 2);
    ns.set(p.stack);
    p.stack = ns;
  }
  const st = p.stack;
  for (let i = count - 1; i >= 0; i--) st[mark + 2 * i] = st[mark + i] | 0;
  for (let i = 0; i < count - 1; i++) st[mark + 2 * i + 1] = separator | 0;
  p.ns = need;
}

// ───────────────────────────── cleaning ─────────────────────────────

/** What Prettier's `textToDoc` makes of the document of a text in another language: `stripTrailingHardline(cleanDoc(doc))`.
 * Returns -1 if the document is nested too deeply (`FormatError::NestedTooDeeply`). */
export function textToDoc(doc: number): number {
  const stack = Stack.create();
  const cleaned = clean(doc, stack);
  const stripped = stripTrailingHardline(cleaned, stack);
  if (stack.ranOut()) return -1;
  return stripped;
}

// The node `last` (a text) extended by the text `text`: a new text, or the same in place if it is the last thing
// in the pool and was made here.
function concatTexts(p: DocPool, last: number, text: number, mergedLast: boolean): number {
  const lenA = p.b[last] | 0;
  const lenB = p.b[text] | 0;
  if (mergedLast && (p.a[last] | 0) + lenA === p.nb) {
    p.reserveBytes(lenB);
    p.bytes.copyWithin(p.nb, p.a[text] | 0, (p.a[text] | 0) + lenB);
    p.nb = p.nb + lenB;
    p.b[last] = lenA + lenB;
    return last;
  }
  p.reserveBytes(lenA + lenB);
  const nb = p.nb;
  p.bytes.copyWithin(nb, p.a[last] | 0, (p.a[last] | 0) + lenA);
  p.bytes.copyWithin(nb + lenA, p.a[text] | 0, (p.a[text] | 0) + lenB);
  p.nb = nb + lenA + lenB;
  return p.node(DOC_TEXT, nb, lenA + lenB, 0, 0, 0);
}

/** Prettier's `cleanDoc`: no arrays in arrays, no empty strings, strings that follow each other are one. */
function clean(doc: number, stack: Stack): number {
  if (!stack.enter()) return doc;
  const r = cleanNode(doc, stack);
  stack.leave();
  return r;
}

function cleanNode(doc: number, stack: Stack): number {
  const p = docPool;
  const tag = p.tag[doc] | 0;
  switch (tag) {
    case DOC_FILL: {
      const start = p.a[doc] | 0;
      const count = p.b[doc] | 0;
      const mark = p.begin();
      let allEmpty = true;
      for (let i = 0; i < count; i++) {
        const part = clean(p.kids[start + i] | 0, stack);
        if (!p.isEmptyText(part)) allEmpty = false;
        p.add(part);
      }
      if (allEmpty) {
        p.abandon(mark);
        return DOC_EMPTY;
      }
      if (count === 1) {
        const only = p.part(mark, 0);
        p.abandon(mark);
        return only;
      }
      return p.fill(mark);
    }
    case DOC_GROUP: {
      const flags = p.b[doc] | 0;
      const shouldBreak = (flags & 1) !== 0;
      const isConditional = (flags & 2) !== 0;
      const id = p.c[doc] | 0;
      const contents = clean(p.a[doc] | 0, stack);
      if (p.isEmptyText(contents) && !shouldBreak && id === 0 && !isConditional) return DOC_EMPTY;
      if (
        (p.tag[contents] | 0) === DOC_GROUP && (p.c[contents] | 0) === 0 && ((p.b[contents] | 0) & 2) === 0 &&
        (((p.b[contents] | 0) & 1) !== 0) === shouldBreak && id === 0 && !isConditional
      ) {
        return contents;
      }
      return p.node(DOC_GROUP, contents, flags, id, 0, 0);
    }
    case DOC_INDENT:
    case DOC_DEDENT:
    case DOC_DEDENT_TO_ROOT:
    case DOC_MARK_AS_ROOT:
    case DOC_LINE_SUFFIX: {
      const contents = clean(p.a[doc] | 0, stack);
      if (p.isEmptyText(contents)) return DOC_EMPTY;
      return p.node(tag, contents, 0, 0, 0, 0);
    }
    case DOC_ALIGN: {
      const contents = clean(p.a[doc] | 0, stack);
      if (p.isEmptyText(contents)) return DOC_EMPTY;
      return p.node(DOC_ALIGN, contents, p.b[doc] | 0, p.c[doc] | 0, p.d[doc] | 0, p.e[doc] | 0);
    }
    case DOC_IF_BREAK: {
      const brk = clean(p.a[doc] | 0, stack);
      const flat = clean(p.b[doc] | 0, stack);
      if (p.isEmptyText(brk) && p.isEmptyText(flat)) return DOC_EMPTY;
      return p.node(DOC_IF_BREAK, brk, flat, p.c[doc] | 0, 0, 0);
    }
    case DOC_ARRAY: {
      const start = p.a[doc] | 0;
      const count = p.b[doc] | 0;
      const mark = p.begin();
      // `merged`: the last part on the list is a text made here (it can grow in place).
      let merged = false;
      for (let i = 0; i < count; i++) {
        const part = clean(p.kids[start + i] | 0, stack);
        if ((p.tag[part] | 0) === DOC_ARRAY) {
          const ps = p.a[part] | 0;
          const pc = p.b[part] | 0;
          for (let j = 0; j < pc; j++) {
            const inner = p.kids[ps + j] | 0;
            if ((p.tag[inner] | 0) === DOC_TEXT && p.ns > mark && (p.tag[p.stack[p.ns - 1] | 0] | 0) === DOC_TEXT) {
              const last = p.stack[p.ns - 1] | 0;
              const joined = concatTexts(p, last, inner, merged);
              p.stack[p.ns - 1] = joined | 0;
              merged = true;
            } else {
              p.add(inner);
              merged = false;
            }
          }
        } else if (!p.isEmptyText(part)) {
          if ((p.tag[part] | 0) === DOC_TEXT && p.ns > mark && (p.tag[p.stack[p.ns - 1] | 0] | 0) === DOC_TEXT) {
            const last = p.stack[p.ns - 1] | 0;
            const joined = concatTexts(p, last, part, merged);
            p.stack[p.ns - 1] = joined | 0;
            merged = true;
          } else {
            p.add(part);
            merged = false;
          }
        }
      }
      const n = p.ns - mark;
      if (n === 0) return DOC_EMPTY;
      if (n === 1) {
        const only = p.stack[mark] | 0;
        p.abandon(mark);
        return only;
      }
      return p.array(mark);
    }
    default:
      return doc;
  }
}

/** Prettier's `stripTrailingHardlineFromDoc`. `doc` is clean. */
function stripTrailingHardline(doc: number, stack: Stack): number {
  if (!stack.enter()) return doc;
  const r = stripNode(doc, stack);
  stack.leave();
  return r;
}

function stripNode(doc: number, stack: Stack): number {
  const p = docPool;
  const tag = p.tag[doc] | 0;
  switch (tag) {
    case DOC_INDENT:
    case DOC_LINE_SUFFIX: {
      const inner = stripTrailingHardline(p.a[doc] | 0, stack);
      return inner === (p.a[doc] | 0) ? doc : p.node(tag, inner, 0, 0, 0, 0);
    }
    case DOC_GROUP: {
      const inner = stripTrailingHardline(p.a[doc] | 0, stack);
      return inner === (p.a[doc] | 0) ? doc : p.node(DOC_GROUP, inner, p.b[doc] | 0, p.c[doc] | 0, 0, 0);
    }
    case DOC_IF_BREAK: {
      const x = stripTrailingHardline(p.a[doc] | 0, stack);
      const y = stripTrailingHardline(p.b[doc] | 0, stack);
      if (x === (p.a[doc] | 0) && y === (p.b[doc] | 0)) return doc;
      return p.node(DOC_IF_BREAK, x, y, p.c[doc] | 0, 0, 0);
    }
    case DOC_FILL:
    case DOC_ARRAY: {
      const start = p.a[doc] | 0;
      let count = p.b[doc] | 0;
      let changed = false;
      while (
        count >= 2 && (p.tag[p.kids[start + count - 1] | 0] | 0) === DOC_BREAK_PARENT &&
        (p.tag[p.kids[start + count - 2] | 0] | 0) === DOC_LINE
      ) {
        count = count - 2;
        changed = true;
      }
      if (count === 0) return changed ? p.node(tag, 0, 0, 0, 0, 0) : doc;
      const last = p.kids[start + count - 1] | 0;
      const stripped = stripTrailingHardline(last, stack);
      if (!changed && stripped === last) return doc;
      const mark = p.begin();
      for (let i = 0; i < count - 1; i++) p.add(p.kids[start + i] | 0);
      p.add(stripped);
      return p.list(tag, mark);
    }
    case DOC_TEXT: {
      const s = p.a[doc] | 0;
      let len = p.b[doc] | 0;
      while (len > 0) {
        const c = p.bytes[s + len - 1] | 0;
        if (c !== 10 && c !== 13) break;
        len = len - 1;
      }
      return len === (p.b[doc] | 0) ? doc : p.textPrefix(doc, len);
    }
    default:
      return doc;
  }
}

/** Prettier's `replaceEndOfLine(text, literallineWithoutBreakParent)` for `src[start, end)`. */
export function replaceEndOfLineWithLiteralLines(src: Uint8Array, start: number, end: number): number {
  const p = docPool;
  let first = -1;
  for (let i = start; i < end; i++) {
    if ((src[i] | 0) === 10) { first = i; break; }
  }
  if (first < 0) return p.text(src, start, end);
  const mark = p.begin();
  let lineStart = start;
  for (let i = start; i <= end; i++) {
    if (i === end || (src[i] | 0) === 10) {
      if (p.ns > mark) p.add(DOC_LITERAL_LINE);
      p.add(p.text(src, lineStart, i));
      lineStart = i + 1;
    }
  }
  return p.array(mark);
}

// ───────────────────────────── a document in one piece ─────────────────────────────

// Element tags
const E_TEXT = 0; // a = start in `texts`, b = len, c = width
const E_LINE = 1; // a = LINE_*
const E_HARD_LINE = 2;
const E_BREAK_PARENT = 3;
const E_LSB = 4;
const E_NOTHING = 5;
const E_KEEP_BLANKS = 6;
const E_TEXT_GROUP = 7;
const E_START_GROUP = 8; // a = end, b = id, c = flags (1 should_break, 2 is_conditional, 4 is_plain)
const E_START_INDENT = 9; // a = index into `indents`
const E_END = 10;
const E_START_FILL = 11;
const E_END_FILL = 12;
const E_START_ITEM = 13; // a = end
const E_END_ITEM = 14;
const E_START_IF_BREAK = 15; // a = otherwise, b = end, c = group_id
const E_ELSE = 16; // a = end
const E_START_LINE_SUFFIX = 17; // a = end

const GF_BREAK = 1;
const GF_CONDITIONAL = 2;
const GF_PLAIN = 4;

/** A document: its parts, one after the other. It is written from the first to the last. */
export class Elements {
  // The first is a `hardlineWithoutBreakParent`, for the printer.
  tag: Uint8Array;
  a: Int32Array;
  b: Int32Array;
  c: Int32Array;
  n: number;
  texts: Uint8Array;
  nt: number;
  // The `IndentCommand`s.
  icKind: Uint8Array;
  icP: Int32Array;
  icQ: Int32Array;
  icR: Int32Array;
  nIc: number;
  // Where what has been started and not ended starts.
  open: Int32Array;
  nOpen: number;
  // The same, of the groups only.
  openGroups: Int32Array;
  nOpenGroups: number;
  // How many of `openGroups`, from the first on, are known not to be plain.
  groupsWithLines: number;
  // So many of `list` stay where they are and as they are: somebody has asked where the next one goes.
  settled: number;
  // Not all of a `Doc` has been written.
  isNestedTooDeeply: boolean;

  constructor() {
    this.tag = new Uint8Array(256);
    this.a = new Int32Array(256);
    this.b = new Int32Array(256);
    this.c = new Int32Array(256);
    this.n = 0;
    this.texts = new Uint8Array(1024);
    this.nt = 0;
    this.icKind = new Uint8Array(16);
    this.icP = new Int32Array(16);
    this.icQ = new Int32Array(16);
    this.icR = new Int32Array(16);
    this.nIc = 0;
    this.open = new Int32Array(64);
    this.nOpen = 0;
    this.openGroups = new Int32Array(64);
    this.nOpenGroups = 0;
    this.groupsWithLines = 0;
    this.settled = 1;
    this.isNestedTooDeeply = false;
    this.clear();
  }

  clear(): void {
    this.n = 0;
    this.push(E_LINE, LINE_HARD, 0, 0);
    this.nt = 0;
    this.nIc = 0;
    this.nOpen = 0;
    this.nOpenGroups = 0;
    this.groupsWithLines = 0;
    this.settled = 1;
    this.isNestedTooDeeply = false;
  }

  push(tag: number, a: number, b: number, c: number): void {
    const i = this.n;
    if (i === this.tag.length) this.growList(i + 1);
    this.tag[i] = tag | 0;
    this.a[i] = a | 0;
    this.b[i] = b | 0;
    this.c[i] = c | 0;
    this.n = i + 1;
  }

  growList(need: number): void {
    let cap = this.tag.length;
    while (cap < need) cap = cap * 2;
    const t = new Uint8Array(cap);
    t.set(this.tag);
    this.tag = t;
    const a = new Int32Array(cap);
    a.set(this.a);
    this.a = a;
    const b = new Int32Array(cap);
    b.set(this.b);
    this.b = b;
    const c = new Int32Array(cap);
    c.set(this.c);
    this.c = c;
  }

  reserveTexts(extra: number): void {
    const need = this.nt + extra;
    if (need <= this.texts.length) return;
    let cap = this.texts.length;
    while (cap < need) cap = cap * 2;
    const nt = new Uint8Array(cap);
    nt.set(this.texts.subarray(0, this.nt));
    this.texts = nt;
  }

  pushOpen(v: number): void {
    if (this.nOpen === this.open.length) {
      const o = new Int32Array(this.open.length * 2);
      o.set(this.open);
      this.open = o;
    }
    this.open[this.nOpen] = v | 0;
    this.nOpen = this.nOpen + 1;
  }

  pushOpenGroup(v: number): void {
    if (this.nOpenGroups === this.openGroups.length) {
      const o = new Int32Array(this.openGroups.length * 2);
      o.set(this.openGroups);
      this.openGroups = o;
    }
    this.openGroups[this.nOpenGroups] = v | 0;
    this.nOpenGroups = this.nOpenGroups + 1;
  }

  // What is written next depends on whether the group that it is in is broken.
  markGroups(): void {
    const nog = this.nOpenGroups;
    for (let index = this.groupsWithLines; index < nog; index++) {
      const g = this.openGroups[index] | 0;
      if ((this.tag[g] | 0) === E_START_GROUP) this.c[g] = (this.c[g] | 0) & ~GF_PLAIN;
    }
    this.groupsWithLines = nog;
  }

  /** Appends the text `src[start, end)`. */
  text(src: Uint8Array, start: number, end: number): void {
    const len = end - start;
    if (len <= 0) return;
    this.reserveTexts(len);
    const at = this.nt;
    const texts = this.texts;
    if (len < 16) {
      for (let i = 0; i < len; i++) texts[at + i] = src[start + i] | 0;
    } else {
      texts.set(src.subarray(start, end), at);
    }
    this.nt = at + len;
    this.addText(at, len, stringWidth(src, start, end));
  }

  /** `text`, for what the printers write of their own: printable ASCII, so it is as wide as it is long. */
  token(s: string): void {
    const len = s.length;
    if (len === 0) return;
    this.reserveTexts(len);
    const at = this.nt;
    const texts = this.texts;
    for (let i = 0; i < len; i++) texts[at + i] = s.charCodeAt(i) | 0;
    this.nt = at + len;
    this.addText(at, len, len);
  }

  // Texts that follow each other, here and in `texts`, are one.
  addText(start: number, len: number, width: number): void {
    const n = this.n;
    if (n > this.settled) {
      const l = n - 1;
      if ((this.tag[l] | 0) === E_TEXT && (this.a[l] | 0) + (this.b[l] | 0) === start) {
        this.b[l] = (this.b[l] | 0) + len;
        this.c[l] = (this.c[l] | 0) + width;
        return;
      }
    }
    this.push(E_TEXT, start, len, width);
  }

  /** A group around the text that is written next. Where it starts in a text makes no difference, nor how many there
   * are: it comes first. */
  textGroup(): void {
    const n = this.n;
    const settled = this.settled;
    if (n > settled && (this.tag[n - 1] | 0) === E_TEXT_GROUP) return;
    if (n - settled >= 2 && (this.tag[n - 2] | 0) === E_TEXT_GROUP && (this.tag[n - 1] | 0) === E_TEXT) return;
    if (n > settled && (this.tag[n - 1] | 0) === E_TEXT) {
      // `[.., Text]` -> `[.., TextGroup, Text]`
      const l = n - 1;
      const a = this.a[l] | 0;
      const b = this.b[l] | 0;
      const c = this.c[l] | 0;
      this.tag[l] = E_TEXT_GROUP;
      this.push(E_TEXT, a, b, c);
      return;
    }
    this.push(E_TEXT_GROUP, 0, 0, 0);
  }

  line(kind: number): void {
    this.markGroups();
    this.push(E_LINE, kind, 0, 0);
  }

  /** `hardline` */
  hardLine(): void {
    this.markGroups();
    this.push(E_HARD_LINE, 0, 0, 0);
    this.breakGroups();
  }

  breakParent(): void {
    this.push(E_BREAK_PARENT, 0, 0, 0);
    this.breakGroups();
  }

  // What Prettier's `propagateBreaks` makes of a `breakParent`.
  breakGroups(): void {
    for (let i = this.nOpenGroups - 1; i >= 0; i--) {
      const g = this.openGroups[i] | 0;
      if ((this.tag[g] | 0) !== E_START_GROUP) continue;
      const flags = this.c[g] | 0;
      // So are the groups around it.
      if ((flags & GF_BREAK) !== 0) break;
      if ((flags & GF_CONDITIONAL) !== 0) break;
      this.c[g] = flags | GF_BREAK;
    }
  }

  keepBlanks(): void {
    this.push(E_KEEP_BLANKS, 0, 0, 0);
  }

  lineSuffixBoundary(): void {
    this.markGroups();
    this.push(E_LSB, 0, 0, 0);
  }

  start(tag: number, a: number, b: number, c: number): void {
    this.pushOpen(this.n);
    this.push(tag, a, b, c);
  }

  // Ends what has been started last with `last`, if that is something.
  end(last: number): void {
    if (this.nOpen === 0) return;
    this.nOpen = this.nOpen - 1;
    const start = this.open[this.nOpen] | 0;
    const at = this.n;
    switch (this.tag[start] | 0) {
      case E_START_GROUP:
      case E_START_ITEM:
      case E_ELSE:
      case E_START_LINE_SUFFIX:
        this.a[start] = at;
        break;
      case E_START_IF_BREAK:
        this.b[start] = at;
        break;
      default:
        break;
    }
    this.push(last, 0, 0, 0);
  }

  /** Starts a group. `id` not 0: what an `ifBreak` can ask about it by. `isConditional`: `conditionalGroup([contents])`. */
  startGroup(shouldBreak: boolean, id: number, isConditional: boolean): void {
    if (shouldBreak) this.breakGroups();
    // Whether it is broken depends on the groups around it, and something else on that.
    if (id !== 0) this.markGroups();
    this.pushOpenGroup(this.n);
    this.start(
      E_START_GROUP,
      0,
      id,
      (shouldBreak ? GF_BREAK : 0) | (isConditional ? GF_CONDITIONAL : 0) | (id === 0 ? GF_PLAIN : 0),
    );
  }

  /** `group(..)` with the defaults (`Group::default()`), or `should_break`. */
  startPlainGroup(shouldBreak: boolean): void {
    this.startGroup(shouldBreak, 0, false);
  }

  endGroup(): void {
    if (this.nOpenGroups > 0) this.nOpenGroups = this.nOpenGroups - 1;
    if (this.groupsWithLines > this.nOpenGroups) this.groupsWithLines = this.nOpenGroups;
    const start = this.nOpen > 0 ? this.open[this.nOpen - 1] | 0 : 0;
    if (start < this.settled) {
      this.end(E_END);
      return;
    }
    // `[StartGroup { is_plain: true, should_break: false }, contents..]`
    if ((this.tag[start] | 0) !== E_START_GROUP || ((this.c[start] | 0) & (GF_PLAIN | GF_BREAK)) !== GF_PLAIN) {
      this.end(E_END);
      return;
    }
    const count = this.n - start - 1;
    let hasText = false;
    let tStart = 0;
    let tLen = 0;
    let tWidth = 0;
    if (count === 0) {
      // nothing
    } else if (count === 1 && (this.tag[start + 1] | 0) === E_TEXT_GROUP) {
      // nothing
    } else if (count === 1 && (this.tag[start + 1] | 0) === E_TEXT) {
      hasText = true;
      tStart = this.a[start + 1] | 0;
      tLen = this.b[start + 1] | 0;
      tWidth = this.c[start + 1] | 0;
    } else if (count === 2 && (this.tag[start + 1] | 0) === E_TEXT_GROUP && (this.tag[start + 2] | 0) === E_TEXT) {
      hasText = true;
      tStart = this.a[start + 2] | 0;
      tLen = this.b[start + 2] | 0;
      tWidth = this.c[start + 2] | 0;
    } else {
      this.end(E_END);
      return;
    }
    this.nOpen = this.nOpen - 1;
    this.n = start;
    this.textGroup();
    if (hasText) this.addText(tStart, tLen, tWidth);
  }

  private findIndent(kind: number, p: number, q: number, r: number): number {
    // There is no other for the same group.
    if (kind === IC_ALIGN_IF_BREAK) return -1;
    for (let i = 0; i < this.nIc; i++) {
      if ((this.icKind[i] | 0) === kind && (this.icP[i] | 0) === p && (this.icQ[i] | 0) === q && (this.icR[i] | 0) === r) {
        return i;
      }
    }
    return -1;
  }

  /** Starts an `indent`, `align`, ...: `kind` is an `IC_*`, `p`, `q`, `r` its parameters (0 if it has none). */
  startIndentCommand(kind: number, p: number, q: number, r: number): void {
    let index = this.findIndent(kind, p, q, r);
    if (index < 0) {
      if (this.nIc === this.icKind.length) {
        const cap = this.icKind.length * 2;
        const k = new Uint8Array(cap);
        k.set(this.icKind);
        this.icKind = k;
        const pp = new Int32Array(cap);
        pp.set(this.icP);
        this.icP = pp;
        const qq = new Int32Array(cap);
        qq.set(this.icQ);
        this.icQ = qq;
        const rr = new Int32Array(cap);
        rr.set(this.icR);
        this.icR = rr;
      }
      index = this.nIc;
      this.icKind[index] = kind | 0;
      this.icP[index] = p | 0;
      this.icQ[index] = q | 0;
      this.icR[index] = r | 0;
      this.nIc = index + 1;
    }
    this.start(E_START_INDENT, index, 0, 0);
  }
  startIndent(): void {
    this.startIndentCommand(IC_INDENT, 0, 0, 0);
  }
  startDedent(): void {
    this.startIndentCommand(IC_DEDENT, 0, 0, 0);
  }
  startDedentToRoot(): void {
    this.startIndentCommand(IC_DEDENT_TO_ROOT, 0, 0, 0);
  }
  startMarkAsRoot(): void {
    this.startIndentCommand(IC_MARK_AS_ROOT, 0, 0, 0);
  }
  /** `align(" ".repeat(width), ..)` */
  startAlign(width: number): void {
    this.startIndentCommand(IC_ALIGN_SPACES, width, 0, 0);
  }
  startAlignText(textId: number): void {
    this.startIndentCommand(IC_ALIGN_TEXT, textId, 0, 0);
  }
  startAlignIfBreak(groupId: number, broken: number, flat: number): void {
    this.startIndentCommand(IC_ALIGN_IF_BREAK, groupId, broken, flat);
  }

  /** Ends an `indent`, `align`, `dedent`, ... */
  endIndent(): void {
    this.end(E_END);
  }

  startFill(): void {
    this.start(E_START_FILL, 0, 0, 0);
  }
  endFill(): void {
    this.end(E_END_FILL);
  }
  startItem(): void {
    this.start(E_START_ITEM, 0, 0, 0);
  }
  endItem(): void {
    this.end(E_END_ITEM);
  }

  /** Starts an `ifBreak`, with the contents for a broken group. `groupId` not 0: the group that it is about. */
  startIfBreak(groupId: number): void {
    this.markGroups();
    this.start(E_START_IF_BREAK, 0, 0, groupId);
  }

  /** Starts the contents for a group on one line. */
  otherwise(): void {
    const at = this.n;
    if (this.nOpen > 0) {
      const s = this.open[this.nOpen - 1] | 0;
      if ((this.tag[s] | 0) === E_START_IF_BREAK) this.a[s] = at;
    }
    this.start(E_ELSE, 0, 0, 0);
  }

  endIfBreak(): void {
    // The `Else` and the start end at the same place.
    this.end(E_NOTHING);
    this.n = this.n - 1;
    this.end(E_NOTHING);
  }

  startLineSuffix(): void {
    this.markGroups();
    this.start(E_START_LINE_SUFFIX, 0, 0, 0);
  }
  endLineSuffix(): void {
    this.end(E_NOTHING);
  }

  /** Where the next element goes, for `removeLinesFrom`. */
  position(): number {
    this.settled = this.n;
    return this.n;
  }

  /** Prettier's `removeLines` for everything from `start` on. */
  removeLinesFrom(start: number): void {
    let at = start;
    while (at < this.n) {
      const t = this.tag[at] | 0;
      if (t === E_LINE) {
        const kind = this.a[at] | 0;
        if (kind === LINE_SPACE) {
          this.reserveTexts(1);
          const s = this.nt;
          this.texts[s] = 32;
          this.nt = s + 1;
          this.tag[at] = E_TEXT;
          this.a[at] = s;
          this.b[at] = 1;
          this.c[at] = 1;
        } else if (kind === LINE_SOFT) {
          this.tag[at] = E_NOTHING;
        }
      } else if (t === E_START_IF_BREAK) {
        // Only the contents for a group on one line stay.
        const otherwise = this.a[at] | 0;
        const last = otherwise > at ? otherwise : at;
        for (let i = at; i <= last; i++) this.tag[i] = E_NOTHING;
        at = otherwise;
      }
      at = at + 1;
    }
  }

  // Puts `count` elements before the element `at`; the caller writes them in `insertedAt(at ..)`.
  private makeRoom(at: number, count: number): void {
    const n = this.n;
    // The positions that point behind `at` move.
    for (let i = 0; i < n; i++) {
      switch (this.tag[i] | 0) {
        case E_START_GROUP:
        case E_START_ITEM:
        case E_ELSE:
        case E_START_LINE_SUFFIX:
          if ((this.a[i] | 0) >= at) this.a[i] = (this.a[i] | 0) + count;
          break;
        case E_START_IF_BREAK:
          if ((this.a[i] | 0) >= at) this.a[i] = (this.a[i] | 0) + count;
          if ((this.b[i] | 0) >= at) this.b[i] = (this.b[i] | 0) + count;
          break;
        default:
          break;
      }
    }
    for (let i = 0; i < this.nOpen; i++) {
      if ((this.open[i] | 0) >= at) this.open[i] = (this.open[i] | 0) + count;
    }
    for (let i = 0; i < this.nOpenGroups; i++) {
      if ((this.openGroups[i] | 0) >= at) this.openGroups[i] = (this.openGroups[i] | 0) + count;
    }
    if (n + count > this.tag.length) this.growList(n + count);
    this.tag.copyWithin(at + count, at, n);
    this.a.copyWithin(at + count, at, n);
    this.b.copyWithin(at + count, at, n);
    this.c.copyWithin(at + count, at, n);
    this.n = n + count;
    this.settled = this.n;
  }

  private set(i: number, tag: number, a: number, b: number, c: number): void {
    this.tag[i] = tag | 0;
    this.a[i] = a | 0;
    this.b[i] = b | 0;
    this.c[i] = c | 0;
  }

  /** In an item of a `fill`: makes a `fill` of its own of what the `fill` has so far, which starts the only item that there
   * is then. */
  nestFill(): void {
    this.endItem();
    if (this.nOpen === 0) return;
    const start = this.open[this.nOpen - 1] | 0;
    this.endFill();
    this.makeRoom(start, 2);
    this.set(start, E_START_FILL, 0, 0, 0);
    this.set(start + 1, E_START_ITEM, 0, 0, 0);
    this.pushOpen(start);
    this.pushOpen(start + 1);
  }

  /** In an item of a `fill`: puts an empty item and a `hardline` before the items of the `fill`. */
  startFillWithHardLine(): void {
    if (this.nOpen < 2) return;
    const fill = this.open[this.nOpen - 2] | 0;
    const at = fill + 1;
    this.makeRoom(at, 5);
    this.set(at, E_START_ITEM, at + 1, 0, 0);
    this.set(at + 1, E_END_ITEM, 0, 0, 0);
    this.set(at + 2, E_START_ITEM, at + 4, 0, 0);
    this.set(at + 3, E_HARD_LINE, 0, 0, 0);
    this.set(at + 4, E_END_ITEM, 0, 0, 0);
    this.markGroups();
    this.breakGroups();
  }

  /** Ends a `fill` the way `cleanDoc` leaves it: with a single item, it is that item. */
  endCleanedFill(): void {
    let hasOneItem = false;
    if (this.nOpen > 0) {
      const start = this.open[this.nOpen - 1] | 0;
      if (start + 1 < this.n && (this.tag[start + 1] | 0) === E_START_ITEM && (this.a[start + 1] | 0) + 1 === this.n) {
        hasOneItem = true;
      }
    }
    if (hasOneItem) this.endFillAsArray();
    else this.endFill();
  }

  /** Ends a `fill` that is to be an array of its items after all. */
  endFillAsArray(): void {
    if (this.nOpen === 0) return;
    this.nOpen = this.nOpen - 1;
    const start = this.open[this.nOpen] | 0;
    this.tag[start] = E_NOTHING;
    let at = start + 1;
    while (at < this.n && (this.tag[at] | 0) === E_START_ITEM) {
      const end = this.a[at] | 0;
      this.tag[at] = E_NOTHING;
      this.tag[end] = E_NOTHING;
      at = end + 1;
    }
  }

  /** Writes `doc`. */
  document(doc: number): void {
    this.write(doc, 0);
  }

  private write(doc: number, depth: number): void {
    if (depth >= getDefaultLimit()) {
      this.isNestedTooDeeply = true;
      return;
    }
    const p = docPool;
    const tag = p.tag[doc] | 0;
    switch (tag) {
      case DOC_TEXT: {
        const len = p.b[doc] | 0;
        if (len > 0) this.text(p.bytes, p.a[doc] | 0, (p.a[doc] | 0) + len);
        break;
      }
      case DOC_ARRAY: {
        const start = p.a[doc] | 0;
        const count = p.b[doc] | 0;
        for (let i = 0; i < count; i++) this.write(p.kids[start + i] | 0, depth + 1);
        break;
      }
      case DOC_INDENT:
        this.startIndent();
        this.write(p.a[doc] | 0, depth + 1);
        this.endIndent();
        break;
      case DOC_ALIGN: {
        const kind = p.b[doc] | 0;
        if (kind === IC_ALIGN_SPACES && (p.c[doc] | 0) === 0) {
          this.write(p.a[doc] | 0, depth + 1);
          break;
        }
        this.startIndentCommand(kind, p.c[doc] | 0, p.d[doc] | 0, p.e[doc] | 0);
        this.write(p.a[doc] | 0, depth + 1);
        this.endIndent();
        break;
      }
      case DOC_DEDENT:
        this.startDedent();
        this.write(p.a[doc] | 0, depth + 1);
        this.endIndent();
        break;
      case DOC_DEDENT_TO_ROOT:
        this.startDedentToRoot();
        this.write(p.a[doc] | 0, depth + 1);
        this.endIndent();
        break;
      case DOC_MARK_AS_ROOT:
        this.startMarkAsRoot();
        this.write(p.a[doc] | 0, depth + 1);
        this.endIndent();
        break;
      case DOC_GROUP: {
        const flags = p.b[doc] | 0;
        this.startGroup((flags & 1) !== 0, p.c[doc] | 0, (flags & 2) !== 0);
        this.write(p.a[doc] | 0, depth + 1);
        this.endGroup();
        break;
      }
      case DOC_FILL: {
        this.startFill();
        const start = p.a[doc] | 0;
        const count = p.b[doc] | 0;
        for (let i = 0; i < count; i++) {
          this.startItem();
          this.write(p.kids[start + i] | 0, depth + 1);
          this.endItem();
        }
        this.endFill();
        break;
      }
      case DOC_IF_BREAK:
        this.startIfBreak(p.c[doc] | 0);
        this.write(p.a[doc] | 0, depth + 1);
        this.otherwise();
        this.write(p.b[doc] | 0, depth + 1);
        this.endIfBreak();
        break;
      case DOC_LINE_SUFFIX:
        this.startLineSuffix();
        this.write(p.a[doc] | 0, depth + 1);
        this.endLineSuffix();
        break;
      case DOC_LINE_SUFFIX_BOUNDARY:
        this.lineSuffixBoundary();
        break;
      case DOC_BREAK_PARENT:
        this.breakParent();
        break;
      default:
        this.line(p.a[doc] | 0);
        break;
    }
  }

  /** The document as a tree. Returns -1 if it is nested too deeply. */
  toTree(): number {
    const stack = Stack.forTree();
    const docPool$ = docPool;
    const mark = docPool$.begin();
    const at = this.treeUpTo(1, this.n, stack, mark);
    void at;
    const tree = docPool$.array(mark);
    if (this.isNestedTooDeeply || stack.ranOut()) return -1;
    return tree;
  }

  // Pushes the parts from `at` up to `end` on the pool's stack, above `mark`. Returns where it ended.
  private treeUpTo(from: number, end: number, stack: Stack, mark: number): number {
    const p = docPool;
    let at = from;
    if (!stack.enter()) return end;
    while (at < end) {
      const element = this.tag[at] | 0;
      const a = this.a[at] | 0;
      at = at + 1;
      switch (element) {
        case E_TEXT:
          p.add(p.text(this.texts, a, a + (this.b[at - 1] | 0)));
          break;
        case E_HARD_LINE:
          p.add(DOC_HARDLINE);
          break;
        case E_BREAK_PARENT:
          p.add(DOC_BREAK_PARENT_DOC);
          break;
        case E_LINE:
          p.add(p.line(a));
          break;
        case E_LSB:
          p.add(DOC_LSB_DOC);
          break;
        case E_TEXT_GROUP:
          if (at < end && (this.tag[at] | 0) === E_TEXT) {
            const s = this.a[at] | 0;
            const len = this.b[at] | 0;
            at = at + 1;
            p.add(p.group(p.text(this.texts, s, s + len)));
          } else {
            p.add(p.group(DOC_EMPTY));
          }
          break;
        case E_START_GROUP: {
          const flags = this.c[at - 1] | 0;
          const id = this.b[at - 1] | 0;
          const m = p.begin();
          this.treeUpTo(at, a, stack, m);
          const contents = p.array(m);
          at = a + 1;
          p.add(p.groupFull(contents, (flags & GF_BREAK) !== 0, id, (flags & GF_CONDITIONAL) !== 0));
          break;
        }
        case E_START_INDENT: {
          const cmd = a;
          const endOfContents = this.endOfIndent(at);
          const m = p.begin();
          this.treeUpTo(at, endOfContents, stack, m);
          const contents = p.array(m);
          at = endOfContents + 1;
          const kind = this.icKind[cmd] | 0;
          switch (kind) {
            case IC_INDENT:
              p.add(p.indent(contents));
              break;
            case IC_DEDENT:
              p.add(p.dedent(contents));
              break;
            case IC_DEDENT_TO_ROOT:
              p.add(p.dedentToRoot(contents));
              break;
            case IC_MARK_AS_ROOT:
              p.add(p.markAsRoot(contents));
              break;
            default:
              p.add(p.node(DOC_ALIGN, contents, kind, this.icP[cmd] | 0, this.icQ[cmd] | 0, this.icR[cmd] | 0));
              break;
          }
          break;
        }
        case E_START_FILL: {
          const m = p.begin();
          while (at < this.n && (this.tag[at] | 0) === E_START_ITEM) {
            const itemEnd = this.a[at] | 0;
            at = at + 1;
            const m2 = p.begin();
            this.treeUpTo(at, itemEnd, stack, m2);
            const item = p.array(m2);
            at = itemEnd + 1;
            p.add(item);
          }
          at = at + 1;
          p.add(p.fill(m));
          break;
        }
        case E_START_IF_BREAK: {
          const otherwise = a;
          const ifEnd = this.b[at - 1] | 0;
          const group = this.c[at - 1] | 0;
          const m = p.begin();
          this.treeUpTo(at, otherwise, stack, m);
          const brk = p.array(m);
          at = otherwise + 1;
          const m2 = p.begin();
          this.treeUpTo(at, ifEnd, stack, m2);
          const flat = p.array(m2);
          at = ifEnd + 1;
          p.add(p.ifBreak(brk, flat, group));
          break;
        }
        case E_START_LINE_SUFFIX: {
          const m = p.begin();
          this.treeUpTo(at, a, stack, m);
          const contents = p.array(m);
          at = a + 1;
          p.add(p.lineSuffix(contents));
          break;
        }
        default:
          break;
      }
    }
    stack.leave();
    return at;
  }

  // Where the indentation ends whose contents start at `from`.
  private endOfIndent(from: number): number {
    let depth = 0;
    let at = from;
    while (at < this.n) {
      const t = this.tag[at] | 0;
      if (t === E_START_GROUP) {
        at = this.a[at] | 0;
      } else if (t === E_START_INDENT) {
        depth = depth + 1;
      } else if (t === E_END) {
        if (depth === 0) break;
        depth = depth - 1;
      }
      at = at + 1;
    }
    return at;
  }
}

// ───────────────────────────── the printer ─────────────────────────────

const MODE_BREAK = 0;
const MODE_FLAT = 1;

// `Written`
const W_NOTHING = 0;
const W_TAB = 1;
const W_BLANKS = 2;
const W_TEXT = 3;

// Layout of `Printer.ind` (Prettier's `Indent`), IS ints per indentation:
const IS = 9;
const I_BEFORE_LAST = 0; // an indentation, or -1: there is nothing in the queue
const I_AFTER = 1; // its value is that of `after`, and then `last`: a text for each would take the square of the depth
const I_LAST_KIND = 2; // W_*
const I_LAST_PARAM = 3; // the blanks, or the id of the text
const I_BYTES = 4; // how long the value is
const I_ONLY = 5; // the byte that all of the value is, as nearly every one is; -1 if none
const I_LENGTH = 6;
const I_ROOT = 7;
const I_DERIVED = 8; // head of the list of what has been made of it, or -1
// Layout of `Printer.der`: DS ints per entry
const DS = 6;

const NL_LF = 0;
const NL_CRLF = 1;
const NL_CR = 2;

export class Printer {
  width: number;
  useTabs: boolean;
  tabWidth: number;
  newLine: number;
  // What a line break in a text and a literal line are written as. See `FormatOptions.isInMarkdown`.
  literalNewLine: number;
  out: ByteBuf;
  // Where `out` started.
  start: number;
  // The first is `ROOT_INDENT` (0).
  ind: Int32Array;
  nInd: number;
  der: Int32Array;
  nDer: number;
  // The modes of the groups that have an id and have been printed.
  gmId: Int32Array;
  gmMode: Uint8Array;
  nGm: number;
  // Frames: mode, indent, separator_mode, is_at_separator
  frames: Int32Array;
  nFrames: number;
  // Tasks (and line suffixes): start, end, mode, indent
  tasks: Int32Array;
  nTasks: number;
  suffixes: Int32Array;
  nSuffixes: number;
  // For `fits`: the modes around what it is looking at.
  outerModes: Uint8Array;
  nOuter: number;
  // Why what has been printed is of no use (a FORMAT_* code; 0: nothing). From there on nothing is indented.
  failure: number;
  // Result of `measureFill`
  fillContentsMode: number;
  fillSeparatorMode: number;

  constructor() {
    this.width = 80;
    this.useTabs = false;
    this.tabWidth = 2;
    this.newLine = NL_LF;
    this.literalNewLine = NL_LF;
    this.out = new ByteBuf(16);
    this.start = 0;
    this.ind = new Int32Array(IS * 16);
    this.nInd = 0;
    this.der = new Int32Array(DS * 16);
    this.nDer = 0;
    this.gmId = new Int32Array(16);
    this.gmMode = new Uint8Array(16);
    this.nGm = 0;
    this.frames = new Int32Array(4 * 32);
    this.nFrames = 0;
    this.tasks = new Int32Array(4 * 16);
    this.nTasks = 0;
    this.suffixes = new Int32Array(4 * 8);
    this.nSuffixes = 0;
    this.outerModes = new Uint8Array(32);
    this.nOuter = 0;
    this.failure = 0;
    this.fillContentsMode = 0;
    this.fillSeparatorMode = 0;
  }

  /** Rust `Printer::new(options, text, out)`: `text` is what is formatted, for `endOfLine: "auto"`. */
  init(options: FormatOptions, text: Uint8Array, out: ByteBuf): void {
    this.width = options.lineWidth;
    this.useTabs = options.indentStyle === INDENT_TAB;
    this.tabWidth = options.indentWidth;
    const le = resolveLineEnding(options.lineEnding, text);
    this.newLine = le === LINE_ENDING_CRLF ? NL_CRLF : le === LINE_ENDING_CR ? NL_CR : NL_LF;
    this.literalNewLine = options.isInMarkdown ? NL_CRLF : this.newLine;
    this.out = out;
    this.start = out.len;
    this.nInd = 0;
    this.nDer = 0;
    this.pushIndent(-1, 0, W_NOTHING, 0, 0, -1, 0, 0);
    this.nGm = 0;
    this.nFrames = 0;
    this.nTasks = 0;
    this.nSuffixes = 0;
    this.nOuter = 0;
    this.failure = 0;
  }

  private pushIndent(
    beforeLast: number,
    after: number,
    lastKind: number,
    lastParam: number,
    bytes: number,
    only: number,
    length: number,
    root: number,
  ): number {
    if ((this.nInd + 1) * IS > this.ind.length) {
      const ni = new Int32Array(this.ind.length * 2);
      ni.set(this.ind);
      this.ind = ni;
    }
    const i = this.nInd;
    const o = i * IS;
    const ind = this.ind;
    ind[o + I_BEFORE_LAST] = beforeLast | 0;
    ind[o + I_AFTER] = after | 0;
    ind[o + I_LAST_KIND] = lastKind | 0;
    ind[o + I_LAST_PARAM] = lastParam | 0;
    ind[o + I_BYTES] = bytes | 0;
    ind[o + I_ONLY] = only | 0;
    ind[o + I_LENGTH] = length | 0;
    ind[o + I_ROOT] = root | 0;
    ind[o + I_DERIVED] = -1;
    this.nInd = i + 1;
    return i;
  }

  /** What is printed from now on is of no use. */
  fail(failure: number): void {
    this.failure = failure;
  }

  /** Whether what has been printed is what the documents print: 0 (`FORMAT_OK`) or the `FORMAT_*` code of the failure. */
  result(): number {
    return this.failure;
  }

  /** What `indent` makes of the indentation `indent`. That of the root is 0. */
  indented(indent: number): number {
    return this.makeIndent(indent, IC_INDENT, 0, 0, 0);
  }

  /** What `dedent` makes of the indentation `indent`. */
  dedented(indent: number): number {
    return this.makeIndent(indent, IC_DEDENT, 0, 0, 0);
  }

  /** What `align(" ".repeat(width))` makes of the indentation `indent`. */
  aligned(indent: number, width: number): number {
    return this.makeIndent(indent, IC_ALIGN_SPACES, width, 0, 0);
  }

  /** What a `hardline` does. Returns the column behind the indentation. */
  writeHardLine(indent: number): number {
    this.trim();
    this.writeNewLine();
    return this.writeIndent(indent);
  }

  private writeNewLine(): void {
    const out = this.out;
    switch (this.newLine) {
      case NL_CRLF:
        out.push(13);
        out.push(10);
        break;
      case NL_CR:
        out.push(13);
        break;
      default:
        out.push(10);
        break;
    }
  }

  private writeLiteralNewLine(): void {
    const out = this.out;
    switch (this.literalNewLine) {
      case NL_CRLF:
        out.push(13);
        out.push(10);
        break;
      case NL_CR:
        out.push(13);
        break;
      default:
        out.push(10);
        break;
    }
  }

  trim(): void {
    const out = this.out;
    const start = this.start;
    let len = out.len;
    const data = out.data;
    while (len > start) {
      const c = data[len - 1] | 0;
      if (c !== 32 && c !== 9) break;
      len = len - 1;
    }
    out.len = len;
  }

  // Prettier's `makeIndent` and `makeAlign`.
  makeIndent(indent: number, kind: number, p: number, q: number, r: number): number {
    if (this.failure !== 0) return indent;
    let ind = this.ind;
    const po = indent * IS;
    const parentRoot = ind[po + I_ROOT] | 0;
    if (kind === IC_DEDENT_TO_ROOT) return parentRoot;
    // What has been made of it
    let d = ind[po + I_DERIVED] | 0;
    while (d >= 0) {
      const o = d * DS;
      if (
        (this.der[o] | 0) === kind && (this.der[o + 1] | 0) === p && (this.der[o + 2] | 0) === q &&
        (this.der[o + 3] | 0) === r
      ) {
        return this.der[o + 4] | 0;
      }
      d = this.der[o + 5] | 0;
    }
    // What is written depends on the queue alone.
    let sameQueue = indent;
    let root = parentRoot;
    if (kind === IC_DEDENT) {
      const bl = ind[po + I_BEFORE_LAST] | 0;
      sameQueue = bl >= 0 ? bl : indent;
    } else if (kind === IC_MARK_AS_ROOT) {
      root = indent;
    }
    const so = sameQueue * IS;
    let after = sameQueue;
    let lastKind = W_NOTHING;
    let lastParam = 0;
    let bytes = 0;
    let width = 0;
    switch (kind) {
      case IC_INDENT:
        if (this.useTabs) {
          lastKind = W_TAB;
          bytes = 1;
          width = this.tabWidth;
        } else {
          lastKind = W_BLANKS;
          lastParam = this.tabWidth;
          bytes = this.tabWidth;
          width = this.tabWidth;
        }
        break;
      case IC_ALIGN_SPACES:
        lastKind = W_BLANKS;
        lastParam = p;
        bytes = p;
        width = p;
        break;
      case IC_ALIGN_TEXT:
        lastKind = W_TEXT;
        lastParam = p;
        bytes = alignTexts[p].length;
        width = bytes;
        break;
      default:
        // The printer has made spaces of the first.
        after = ind[so + I_AFTER] | 0;
        lastKind = ind[so + I_LAST_KIND] | 0;
        lastParam = ind[so + I_LAST_PARAM] | 0;
        break;
    }
    const sameOnly = ind[so + I_ONLY] | 0;
    const sameBytes = ind[so + I_BYTES] | 0;
    let only = -1;
    if (bytes === 0) only = sameOnly;
    else if (lastKind === W_BLANKS && (sameBytes === 0 || sameOnly === 32)) only = 32;
    else if (lastKind === W_TAB && (sameBytes === 0 || sameOnly === 9)) only = 9;
    const totalBytes = sameBytes + bytes;
    const totalLength = (ind[so + I_LENGTH] | 0) + width;
    if (isTooLong(totalBytes)) {
      this.failure = FORMAT_TOO_LONG;
      return indent;
    }
    const beforeLast = kind === IC_INDENT || kind === IC_ALIGN_SPACES || kind === IC_ALIGN_TEXT || kind === IC_ALIGN_IF_BREAK
      ? indent
      : (ind[so + I_BEFORE_LAST] | 0);
    const id = this.pushIndent(beforeLast, after, lastKind, lastParam, totalBytes, only, totalLength, root);
    ind = this.ind;
    // Remember it
    if ((this.nDer + 1) * DS > this.der.length) {
      const nd = new Int32Array(this.der.length * 2);
      nd.set(this.der);
      this.der = nd;
    }
    const o = this.nDer * DS;
    this.der[o] = kind | 0;
    this.der[o + 1] = p | 0;
    this.der[o + 2] = q | 0;
    this.der[o + 3] = r | 0;
    this.der[o + 4] = id | 0;
    this.der[o + 5] = ind[po + I_DERIVED] | 0;
    ind[po + I_DERIVED] = this.nDer;
    this.nDer = this.nDer + 1;
    return id;
  }

  // Writes the indentation. Returns its width.
  writeIndent(indent: number): number {
    const out = this.out;
    if (isTooLong(out.len)) this.failure = FORMAT_TOO_LONG;
    if (this.failure !== 0) return 0;
    const ind = this.ind;
    const o = indent * IS;
    const bytes = ind[o + I_BYTES] | 0;
    const length = ind[o + I_LENGTH] | 0;
    const start = out.len;
    let end = start + bytes;
    if (end > out.data.length) out.grow(end);
    const data = out.data;
    // Blanks, to start with
    data.fill(32, start, end);
    out.len = end;
    let at = indent;
    while (end > start) {
      const ao = at * IS;
      const only = ind[ao + I_ONLY] | 0;
      if (only >= 0) {
        data.fill(only, start, end);
        break;
      }
      const lastKind = ind[ao + I_LAST_KIND] | 0;
      if (lastKind === W_BLANKS) {
        end = end - (ind[ao + I_LAST_PARAM] | 0);
      } else if (lastKind === W_TAB) {
        end = end - 1;
        data[end] = 9;
      } else if (lastKind === W_TEXT) {
        const t = alignTexts[ind[ao + I_LAST_PARAM] | 0];
        end = end - t.length;
        for (let i = 0; i < t.length; i++) data[end + i] = t[i] | 0;
      }
      at = ind[ao + I_AFTER] | 0;
    }
    return length;
  }

  /** Writes a text of the document. A line break in it is written as `literalNewLine`. */
  writeText(text: Uint8Array, start: number, end: number): void {
    if (this.literalNewLine === NL_LF) {
      this.out.append(text, start, end);
      return;
    }
    let from = start;
    for (let i = start; i < end; i++) {
      if ((text[i] | 0) === 10) {
        this.out.append(text, from, i);
        this.writeLiteralNewLine();
        from = i + 1;
      }
    }
    this.out.append(text, from, end);
  }

  private groupModeOf(id: number): number {
    // -1: none
    for (let i = this.nGm - 1; i >= 0; i--) {
      if ((this.gmId[i] | 0) === id) return this.gmMode[i] | 0;
    }
    return -1;
  }

  private pushGroupMode(id: number, mode: number): void {
    if (this.nGm === this.gmId.length) {
      const a = new Int32Array(this.gmId.length * 2);
      a.set(this.gmId);
      this.gmId = a;
      const m = new Uint8Array(this.gmMode.length * 2);
      m.set(this.gmMode);
      this.gmMode = m;
    }
    this.gmId[this.nGm] = id | 0;
    this.gmMode[this.nGm] = mode | 0;
    this.nGm = this.nGm + 1;
  }

  private pushFrame(mode: number, indent: number): void {
    if ((this.nFrames + 1) * 4 > this.frames.length) {
      const f = new Int32Array(this.frames.length * 2);
      f.set(this.frames);
      this.frames = f;
    }
    const o = this.nFrames * 4;
    this.frames[o] = mode | 0;
    this.frames[o + 1] = indent | 0;
    this.frames[o + 2] = MODE_BREAK;
    this.frames[o + 3] = 0;
    this.nFrames = this.nFrames + 1;
  }

  private pushTask(start: number, end: number, mode: number, indent: number): void {
    if ((this.nTasks + 1) * 4 > this.tasks.length) {
      const t = new Int32Array(this.tasks.length * 2);
      t.set(this.tasks);
      this.tasks = t;
    }
    const o = this.nTasks * 4;
    this.tasks[o] = start | 0;
    this.tasks[o + 1] = end | 0;
    this.tasks[o + 2] = mode | 0;
    this.tasks[o + 3] = indent | 0;
    this.nTasks = this.nTasks + 1;
  }

  private pushSuffix(start: number, end: number, mode: number, indent: number): void {
    if ((this.nSuffixes + 1) * 4 > this.suffixes.length) {
      const t = new Int32Array(this.suffixes.length * 2);
      t.set(this.suffixes);
      this.suffixes = t;
    }
    const o = this.nSuffixes * 4;
    this.suffixes[o] = start | 0;
    this.suffixes[o + 1] = end | 0;
    this.suffixes[o + 2] = mode | 0;
    this.suffixes[o + 3] = indent | 0;
    this.nSuffixes = this.nSuffixes + 1;
  }

  // `self.tasks.extend(self.line_suffixes.drain(..).rev())`
  private moveSuffixesToTasks(): void {
    for (let i = this.nSuffixes - 1; i >= 0; i--) {
      const o = i * 4;
      this.pushTask(this.suffixes[o] | 0, this.suffixes[o + 1] | 0, this.suffixes[o + 2] | 0, this.suffixes[o + 3] | 0);
    }
    this.nSuffixes = 0;
  }

  private pushOuter(mode: number): void {
    if (this.nOuter === this.outerModes.length) {
      const m = new Uint8Array(this.outerModes.length * 2);
      m.set(this.outerModes);
      this.outerModes = m;
    }
    this.outerModes[this.nOuter] = mode | 0;
    this.nOuter = this.nOuter + 1;
  }

  // Prettier's `fits`, for `elements[start..end]` on one line. `restStart >= 0`: what follows it, in the mode that it is
  // printed in, up to its end. Behind that come `this.tasks`. `restStart < 0`: nothing counts but the elements.
  private fits(
    elements: Elements,
    start: number,
    end0: number,
    restStart: number,
    restEnd: number,
    restMode: number,
    remainingWidth0: number,
    mustBeFlat: boolean,
  ): boolean {
    const tag = elements.tag;
    const ea = elements.a;
    const eb = elements.b;
    const ec = elements.c;
    let remainingWidth = remainingWidth0;
    let hasLineSuffix = this.nSuffixes > 0;
    let hasPendingSpace = false;
    let at = start;
    let end = end0;
    let mode = MODE_FLAT;
    let hasRest = restStart >= 0;
    // What is left of what follows: the frames that end there, and the tasks.
    let framesLeft = this.nFrames;
    let tasksLeft = hasRest ? this.nTasks : 0;
    // How the next item of the `fill` that is being printed is printed, if that has been decided (-1: not).
    let separatorMode = -1;
    this.nOuter = 0;
    while (remainingWidth >= 0) {
      if (at >= end) {
        if (hasRest) {
          at = restStart;
          end = restEnd;
          mode = restMode;
          hasRest = false;
        } else if (tasksLeft > 0) {
          tasksLeft = tasksLeft - 1;
          const o = tasksLeft * 4;
          at = this.tasks[o] | 0;
          end = this.tasks[o + 1] | 0;
          mode = this.tasks[o + 2] | 0;
        } else {
          return true;
        }
        continue;
      }
      const element = tag[at] | 0;
      const idx = at;
      at = at + 1;
      switch (element) {
        case E_TEXT:
          if (hasPendingSpace) {
            remainingWidth = remainingWidth - 1;
            hasPendingSpace = false;
          }
          remainingWidth = remainingWidth - (ec[idx] | 0);
          break;
        case E_HARD_LINE:
          return true;
        case E_LINE: {
          const line = ea[idx] | 0;
          if (mode === MODE_BREAK || line === LINE_HARD || line === LINE_LITERAL) return true;
          if (line === LINE_SPACE) hasPendingSpace = true;
          break;
        }
        case E_START_GROUP: {
          const shouldBreak = ((ec[idx] | 0) & GF_BREAK) !== 0;
          if (mustBeFlat && shouldBreak) return false;
          this.pushOuter(mode);
          if (shouldBreak) mode = MODE_BREAK;
          break;
        }
        case E_START_INDENT:
        case E_START_FILL:
          this.pushOuter(mode);
          break;
        case E_START_ITEM:
          this.pushOuter(mode);
          if (separatorMode >= 0) {
            mode = separatorMode;
            separatorMode = -1;
          }
          break;
        case E_END:
        case E_END_FILL:
        case E_END_ITEM:
          if (this.nOuter > 0) {
            this.nOuter = this.nOuter - 1;
            mode = this.outerModes[this.nOuter] | 0;
          } else {
            // It is the end of something that is being printed.
            framesLeft = framesLeft > 0 ? framesLeft - 1 : 0;
            if (framesLeft >= this.nFrames) continue;
            const fo = framesLeft * 4;
            mode = this.frames[fo] | 0;
            if (element === E_END_ITEM && framesLeft >= 1) {
              const po = (framesLeft - 1) * 4;
              if ((this.frames[po + 3] | 0) === 0) separatorMode = this.frames[po + 2] | 0;
            }
          }
          break;
        case E_START_IF_BREAK: {
          const groupId = ec[idx] | 0;
          let gm = mode;
          if (groupId !== 0) {
            gm = this.groupModeOf(groupId);
            if (gm < 0) gm = MODE_FLAT;
          }
          if (gm === MODE_FLAT) at = (ea[idx] | 0) + 1;
          break;
        }
        case E_ELSE:
          at = ea[idx] | 0;
          break;
        case E_START_LINE_SUFFIX:
          hasLineSuffix = true;
          at = ea[idx] | 0;
          break;
        case E_LSB:
          if (hasLineSuffix) return false;
          break;
        default:
          break;
      }
    }
    void eb;
    return false;
  }

  /** Prints `elements`, which are a part of a document that no group is around and that a line break follows: with the
   * indentation `indent`, from the column `position` on. Returns the column behind it.
   *
   * This is Prettier's `printDocToString`. Its stack of commands is `frames` here, for what the elements that follow
   * are in, and `tasks`, for what is not printed where it is. */
  print(elements: Elements, indent0: number, position0: number): number {
    const tag = elements.tag;
    const ea = elements.a;
    const eb = elements.b;
    const ec = elements.c;
    let at = 1;
    let end = elements.n;
    let mode = MODE_BREAK;
    let indent = indent0;
    let position = position0;
    let shouldRemeasure = false;
    if (elements.isNestedTooDeeply) this.failure = FORMAT_NESTED_TOO_DEEPLY;
    if (this.failure !== 0) return position;
    this.nFrames = 0;
    this.nTasks = 0;
    this.nSuffixes = 0;
    const texts = elements.texts;
    while (true) {
      if (at >= end) {
        if (this.nTasks === 0) this.moveSuffixesToTasks();
        if (this.nTasks === 0) break;
        this.nTasks = this.nTasks - 1;
        const o = this.nTasks * 4;
        at = this.tasks[o] | 0;
        end = this.tasks[o + 1] | 0;
        mode = this.tasks[o + 2] | 0;
        indent = this.tasks[o + 3] | 0;
        continue;
      }
      const idx = at;
      const element = tag[idx] | 0;
      at = at + 1;
      switch (element) {
        case E_TEXT: {
          const s = ea[idx] | 0;
          this.writeText(texts, s, s + (eb[idx] | 0));
          position = position + (ec[idx] | 0);
          break;
        }
        case E_TEXT_GROUP:
          shouldRemeasure = false;
          break;
        case E_START_INDENT: {
          this.pushFrame(mode, indent);
          const cmd = ea[idx] | 0;
          let kind = elements.icKind[cmd] | 0;
          let p = elements.icP[cmd] | 0;
          let q = elements.icQ[cmd] | 0;
          let r = elements.icR[cmd] | 0;
          if (kind === IC_ALIGN_IF_BREAK) {
            const gm = this.groupModeOf(p);
            const w = gm === MODE_BREAK ? q : r;
            kind = IC_ALIGN_SPACES;
            p = w;
            q = 0;
            r = 0;
          }
          indent = this.makeIndent(indent, kind, p, q, r);
          break;
        }
        case E_START_GROUP: {
          const groupEnd = ea[idx] | 0;
          const id = eb[idx] | 0;
          const flags = ec[idx] | 0;
          const shouldBreak = (flags & GF_BREAK) !== 0;
          let groupMode: number;
          if (mode === MODE_FLAT && !shouldRemeasure) {
            groupMode = shouldBreak ? MODE_BREAK : MODE_FLAT;
          } else if ((flags & GF_PLAIN) !== 0) {
            shouldRemeasure = false;
            groupMode = MODE_FLAT;
          } else {
            shouldRemeasure = false;
            const remainingWidth = this.width - position;
            groupMode = !shouldBreak && this.fits(elements, at, groupEnd, groupEnd + 1, end, mode, remainingWidth, false)
              ? MODE_FLAT
              : MODE_BREAK;
          }
          this.pushFrame(mode, indent);
          mode = groupMode;
          if (id !== 0) this.pushGroupMode(id, groupMode);
          break;
        }
        case E_START_FILL:
          this.pushFrame(mode, indent);
          break;
        case E_END:
        case E_END_FILL:
          if (this.nFrames > 0) {
            this.nFrames = this.nFrames - 1;
            const fo = this.nFrames * 4;
            mode = this.frames[fo] | 0;
            indent = this.frames[fo + 1] | 0;
          }
          break;
        case E_START_ITEM: {
          const itemEnd = ea[idx] | 0;
          let itemMode: number;
          const lastFrame = (this.nFrames - 1) * 4;
          const isSeparator = this.nFrames > 0 && (this.frames[lastFrame + 3] | 0) !== 0;
          if (isSeparator) {
            itemMode = this.frames[lastFrame + 2] | 0;
          } else {
            this.measureFill(elements, at, itemEnd, position);
            if (this.nFrames > 0) this.frames[lastFrame + 2] = this.fillSeparatorMode;
            itemMode = this.fillContentsMode;
          }
          this.pushFrame(mode, indent);
          mode = itemMode;
          break;
        }
        case E_END_ITEM:
          if (this.nFrames > 0) {
            this.nFrames = this.nFrames - 1;
            const fo = this.nFrames * 4;
            mode = this.frames[fo] | 0;
            indent = this.frames[fo + 1] | 0;
          }
          if (this.nFrames > 0) {
            const lo = (this.nFrames - 1) * 4;
            this.frames[lo + 3] = (this.frames[lo + 3] | 0) === 0 ? 1 : 0;
          }
          break;
        case E_START_IF_BREAK: {
          const groupId = ec[idx] | 0;
          const gm = groupId === 0 ? mode : this.groupModeOf(groupId);
          if (gm === MODE_BREAK) {
            // the contents for a broken group follow
          } else if (gm === MODE_FLAT) {
            at = (ea[idx] | 0) + 1;
          } else {
            at = eb[idx] | 0;
          }
          break;
        }
        case E_ELSE:
          at = ea[idx] | 0;
          break;
        case E_START_LINE_SUFFIX: {
          const suffixEnd = ea[idx] | 0;
          this.pushSuffix(at, suffixEnd, mode, indent);
          at = suffixEnd;
          break;
        }
        case E_LSB:
          if (this.nSuffixes > 0) {
            // A `hardlineWithoutBreakParent`, then what follows.
            this.pushTask(at, end, mode, indent);
            at = 0;
            end = 1;
          }
          break;
        case E_LINE:
        case E_HARD_LINE: {
          const line = element === E_LINE ? ea[idx] | 0 : LINE_HARD;
          const isHard = line === LINE_HARD || line === LINE_LITERAL;
          if (mode === MODE_FLAT && !isHard) {
            if (line === LINE_SPACE) {
              this.out.push(32);
              position = position + 1;
            }
            break;
          }
          if (mode === MODE_FLAT) {
            // The groups that follow have been measured without it.
            shouldRemeasure = true;
          }
          if (this.nSuffixes > 0) {
            // They come first, then the line once more.
            this.pushTask(at - 1, end, mode, indent);
            this.moveSuffixesToTasks();
            at = end;
          } else if (line === LINE_LITERAL) {
            this.writeLiteralNewLine();
            position = this.writeIndent(this.ind[indent * IS + I_ROOT] | 0);
          } else {
            this.trim();
            this.writeNewLine();
            position = this.writeIndent(indent);
          }
          break;
        }
        case E_KEEP_BLANKS:
          this.start = this.out.len;
          break;
        default:
          break;
      }
    }
    return position;
  }

  // What Prettier does with a `fill`: how the contents that are in `elements[start..end]` are printed, and the separator
  // behind them. The result is in `fillContentsMode` and `fillSeparatorMode`.
  private measureFill(elements: Elements, start: number, end: number, position: number): void {
    const remainingWidth = this.width - position;
    const contentsFit = this.fits(elements, start, end, -1, 0, 0, remainingWidth, true);
    const cm = contentsFit ? MODE_FLAT : MODE_BREAK;
    if (end + 1 >= elements.n || (elements.tag[end + 1] | 0) !== E_START_ITEM) {
      this.fillContentsMode = cm;
      this.fillSeparatorMode = MODE_BREAK;
      return;
    }
    const separatorEnd = elements.a[end + 1] | 0;
    if (separatorEnd + 1 >= elements.n || (elements.tag[separatorEnd + 1] | 0) !== E_START_ITEM) {
      this.fillContentsMode = cm;
      this.fillSeparatorMode = cm;
      return;
    }
    const secondEnd = elements.a[separatorEnd + 1] | 0;
    const firstAndSecondFit = this.fits(elements, start - 1, secondEnd + 1, -1, 0, 0, remainingWidth, true);
    this.fillContentsMode = firstAndSecondFit || contentsFit ? MODE_FLAT : MODE_BREAK;
    this.fillSeparatorMode = firstAndSecondFit ? MODE_FLAT : MODE_BREAK;
  }
}

// ───────────────────────────── doc::print ─────────────────────────────

let sharedElements: Elements | null = null;
let sharedElementsBusy = false;
let sharedPrinter: Printer | null = null;

/** Appends what `doc` prints to `out`. `text` is what is formatted, for `endOfLine: "auto"`. Returns 0 or a `FORMAT_*`
 * code (`Result<(), FormatError>`). */
export function printDoc(doc: number, options: FormatOptions, text: Uint8Array, out: ByteBuf): number {
  let elements: Elements;
  let own = false;
  if (sharedElements === null) sharedElements = new Elements();
  if (sharedElementsBusy) {
    elements = new Elements();
    own = true;
  } else {
    elements = sharedElements;
    sharedElementsBusy = true;
    elements.clear();
  }
  elements.document(doc);
  const printer = new Printer();
  printer.init(options, text, out);
  printer.print(elements, 0, 0);
  const r = printer.result();
  if (!own) sharedElementsBusy = false;
  void sharedPrinter;
  return r;
}

export { FORMAT_OK };
