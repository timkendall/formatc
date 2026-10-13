// Test support (not used by the formatter): a small tree description of Prettier-style documents, and `emit`, which
// writes it to a `Formatter` with the imperative API. The same description is turned into a Prettier doc by
// tools/ir-fuzz.ts so that the printer can be compared with Prettier's own `printDocToString`.
import { Formatter } from "./formatter.ts";
import { token } from "./element.ts";

export const D_TEXT = 0; // s
export const D_LINE = 1;
export const D_SOFTLINE = 2;
export const D_HARDLINE = 3;
export const D_GROUP = 4; // kids, flag = shouldBreak, id (0 none)
export const D_INDENT = 5;
export const D_ALIGN = 6; // n
export const D_DEDENT = 7;
export const D_DEDENT_ROOT = 8;
export const D_IF_BREAK = 9; // kids[0] = break contents, kids[1] = flat contents, id = group id (0 = enclosing)
export const D_INDENT_IF_BREAK = 10; // id
export const D_FILL = 11; // kids = content, separator, content, ...
export const D_LINE_SUFFIX = 12;
export const D_LINE_SUFFIX_BOUNDARY = 13;
export const D_BREAK_PARENT = 14;
export const D_BEST = 15; // kids = the variants, flattest first
export const D_SEQ = 16;
export const D_SPACE = 17; // IR space element (a space that is not at the start or end of a line)
export const D_LABEL = 18;
export const D_EMPTY_LINE = 19; // hardline, hardline-with-blank
export const D_SOFT_BLOCK_INDENT = 20; // indent([softline, kids]), softline
export const D_BLOCK_INDENT = 21; // indent([hardline, kids]), hardline
export const D_SOFT_SPACE_BLOCK_INDENT = 22; // indent([line, kids]), line
export const D_TOKEN_IF_BREAKS = 23; // s: ifBreak(s) with a token
export const D_INDENTED_LINE_GROUP = 24; // group(indent(line), {id})

export class D {
  kind: number;
  s: string;
  n: number;
  id: number;
  flag: boolean;
  kids: D[];
  constructor(kind: number, s: string, n: number, id: number, flag: boolean, kids: D[]) {
    this.kind = kind;
    this.s = s;
    this.n = n;
    this.id = id;
    this.flag = flag;
    this.kids = kids;
  }
}

const NONE: D[] = [];
export function text(s: string): D { return new D(D_TEXT, s, 0, 0, false, NONE); }
export function line(): D { return new D(D_LINE, "", 0, 0, false, NONE); }
export function softline(): D { return new D(D_SOFTLINE, "", 0, 0, false, NONE); }
export function hardline(): D { return new D(D_HARDLINE, "", 0, 0, false, NONE); }
export function space(): D { return new D(D_SPACE, "", 0, 0, false, NONE); }
export function emptyLine(): D { return new D(D_EMPTY_LINE, "", 0, 0, false, NONE); }
export function breakParent(): D { return new D(D_BREAK_PARENT, "", 0, 0, false, NONE); }
export function lineSuffixBoundary(): D { return new D(D_LINE_SUFFIX_BOUNDARY, "", 0, 0, false, NONE); }
export function seq(...kids: D[]): D { return new D(D_SEQ, "", 0, 0, false, kids); }
export function group(...kids: D[]): D { return new D(D_GROUP, "", 0, 0, false, kids); }
export function groupBreak(...kids: D[]): D { return new D(D_GROUP, "", 0, 0, true, kids); }
export function groupId(id: number, ...kids: D[]): D { return new D(D_GROUP, "", 0, id, false, kids); }
export function indent(...kids: D[]): D { return new D(D_INDENT, "", 0, 0, false, kids); }
export function align(n: number, ...kids: D[]): D { return new D(D_ALIGN, "", n, 0, false, kids); }
export function dedent(...kids: D[]): D { return new D(D_DEDENT, "", 0, 0, false, kids); }
export function dedentToRoot(...kids: D[]): D { return new D(D_DEDENT_ROOT, "", 0, 0, false, kids); }
export function ifBreak(b: D, flat: D): D { return new D(D_IF_BREAK, "", 0, 0, false, [b, flat]); }
export function ifBreakId(id: number, b: D, flat: D): D { return new D(D_IF_BREAK, "", 0, id, false, [b, flat]); }
export function indentIfBreak(id: number, ...kids: D[]): D { return new D(D_INDENT_IF_BREAK, "", 0, id, false, kids); }
export function fill(...kids: D[]): D { return new D(D_FILL, "", 0, 0, false, kids); }
export function lineSuffix(...kids: D[]): D { return new D(D_LINE_SUFFIX, "", 0, 0, false, kids); }
export function best(...kids: D[]): D { return new D(D_BEST, "", 0, 0, false, kids); }
export function label(...kids: D[]): D { return new D(D_LABEL, "", 0, 0, false, kids); }
export function softBlockIndent(...kids: D[]): D { return new D(D_SOFT_BLOCK_INDENT, "", 0, 0, false, kids); }
export function blockIndent(...kids: D[]): D { return new D(D_BLOCK_INDENT, "", 0, 0, false, kids); }
export function softSpaceBlockIndent(...kids: D[]): D { return new D(D_SOFT_SPACE_BLOCK_INDENT, "", 0, 0, false, kids); }
export function tokenIfBreaks(s: string): D { return new D(D_TOKEN_IF_BREAKS, s, 0, 0, false, NONE); }
export function indentedLineGroup(id: number): D { return new D(D_INDENTED_LINE_GROUP, "", 0, id, false, NONE); }

/** Maps test group ids (small ints) to ids from the formatter. */
export class Emitter {
  f: Formatter;
  ids: Int32Array;
  /** Write texts of at most 14 ASCII characters as tokens (`E_TOKEN`) instead of owned text. */
  tokens: boolean;
  constructor(f: Formatter) {
    this.f = f;
    this.ids = new Int32Array(1024);
    this.tokens = true;
  }
  id(testId: number): number {
    if (testId === 0) return 0;
    let r = this.ids[testId] | 0;
    if (r === 0) {
      r = this.f.groupId();
      this.ids[testId] = r;
    }
    return r;
  }
}

/** Words that are registered as tokens (tokens of 1 to 16 bytes: inline bytes, and long ones). */
export const VOCABULARY: string[] = [
  "a", "ab", "abc", "abcd", "abcde", "function", "return", "constructor", "undefined1", "typeof", "=>", "...", "(", ")", "{", "}",
  "abcdefghijkl", "abcdefghijklm", "abcdefghijklmnop", ",", ";", "x", "if", "else",
];

function isToken(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < VOCABULARY.length; i++) {
    if (VOCABULARY[i] === s) return true;
  }
  return false;
}

export function emit(e: Emitter, d: D): void {
  const f = e.f;
  switch (d.kind) {
    case D_TEXT:
      if (e.tokens && isToken(d.s)) f.token(token(d.s));
      else f.textStr(d.s);
      return;
    case D_LINE:
      f.softLineBreakOrSpace();
      return;
    case D_SOFTLINE:
      f.softLineBreak();
      return;
    case D_HARDLINE:
      f.hardLineBreak();
      return;
    case D_SPACE:
      f.space();
      return;
    case D_EMPTY_LINE:
      f.emptyLine();
      return;
    case D_BREAK_PARENT:
      f.expandParent();
      return;
    case D_LINE_SUFFIX_BOUNDARY:
      f.lineSuffixBoundary();
      return;
    case D_SEQ:
      emitKids(e, d.kids);
      return;
    case D_GROUP:
      f.startGroupWith(e.id(d.id), d.flag);
      emitKids(e, d.kids);
      f.endGroup();
      return;
    case D_INDENT:
      f.startIndent();
      emitKids(e, d.kids);
      f.endIndent();
      return;
    case D_ALIGN:
      f.startAlign(d.n);
      emitKids(e, d.kids);
      f.endAlign(d.n);
      return;
    case D_DEDENT:
      f.startDedent();
      emitKids(e, d.kids);
      f.endDedent();
      return;
    case D_DEDENT_ROOT:
      f.startDedentToRoot();
      emitKids(e, d.kids);
      f.endDedentToRoot();
      return;
    case D_IF_BREAK:
      if (d.id !== 0) f.startIfGroupBreaksId(e.id(d.id));
      else f.startIfGroupBreaks();
      emit(e, d.kids[0]);
      f.endConditional();
      if (d.id !== 0) f.startIfGroupFitsId(e.id(d.id));
      else f.startIfGroupFits();
      emit(e, d.kids[1]);
      f.endConditional();
      return;
    case D_INDENT_IF_BREAK:
      f.startIndentIfGroupBreaks(e.id(d.id));
      emitKids(e, d.kids);
      f.endIndentIfGroupBreaks(e.id(d.id));
      return;
    case D_FILL: {
      f.startFill();
      for (let i = 0; i < d.kids.length; i++) {
        f.startEntry();
        emit(e, d.kids[i]);
        f.endEntry();
      }
      f.endFill();
      return;
    }
    case D_LINE_SUFFIX:
      f.startLineSuffix();
      emitKids(e, d.kids);
      f.endLineSuffix();
      return;
    case D_BEST: {
      const vs = f.takeVec();
      for (let i = 0; i < d.kids.length; i++) {
        const slot = f.startVariant();
        emit(e, d.kids[i]);
        vs.push(f.endVariant(slot));
      }
      f.bestFittingOf(vs);
      f.recycleVec(vs);
      return;
    }
    case D_LABEL:
      f.startLabelled(1);
      emitKids(e, d.kids);
      f.endLabelled();
      return;
    case D_SOFT_BLOCK_INDENT:
      f.startSoftBlockIndent();
      emitKids(e, d.kids);
      f.endSoftBlockIndent();
      return;
    case D_BLOCK_INDENT:
      f.startBlockIndent();
      emitKids(e, d.kids);
      f.endBlockIndent();
      return;
    case D_SOFT_SPACE_BLOCK_INDENT:
      f.startSoftSpaceOrBlockIndent();
      emitKids(e, d.kids);
      f.endSoftSpaceOrBlockIndent();
      return;
    case D_TOKEN_IF_BREAKS:
      f.tokenIfBreaks(token(d.s));
      return;
    case D_INDENTED_LINE_GROUP:
      f.indentedLineGroup(e.id(d.id));
      return;
    default:
      return;
  }
}

function emitKids(e: Emitter, kids: D[]): void {
  for (let i = 0; i < kids.length; i++) emit(e, kids[i]);
}

// ───────────────────────────── random documents ─────────────────────────────
// Documents in which no two line breaks are adjacent (the printer of ir/ writes no line break on an empty line, where
// Prettier's does, so they would differ by design) and that start and end with a text.

export class Gen {
  s: number;
  nextId: number;
  /** Ids of the groups that have started. */
  avail: Int32Array;
  nAvail: number;
  wide: boolean;
  /** > 0 while writing a variant of a best-fitting: see `item`. */
  inBest: number;
  /** A document has fills or best-fittings, not both: see `item`. */
  fillMode: boolean;
  constructor(seed: number) {
    this.s = seed | 0;
    this.nextId = 1;
    this.avail = new Int32Array(64);
    this.nAvail = 0;
    this.wide = false;
    this.inBest = 0;
    this.fillMode = (seed & 1) === 0;
  }
  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
    return (t ^ (t >>> 14)) >>> 0;
  }
  rnd(n: number): number {
    return this.next() % n;
  }
  word(): D {
    // Half of them are the words of the vocabulary, which the emitter writes as tokens.
    if (this.rnd(2) === 0) return text(VOCABULARY[this.rnd(VOCABULARY.length)]);
    const n = 1 + this.rnd(8);
    let s = "";
    for (let i = 0; i < n; i++) {
      const k = this.rnd(30);
      if (this.wide && k === 0) s += "中";
      else if (this.wide && k === 1) s += "👍";
      else if (k < 26) s += String.fromCharCode(97 + k);
      else s += "(),;".charAt(k - 26);
    }
    return text(s);
  }
  sep(): D {
    const k = this.rnd(100);
    if (k < 38) return line();
    if (k < 62) return softline();
    // A space between two texts is what Prettier writes as " ".
    if (k < 80) return space();
    if (k < 85) return emptyLine();
    return hardline();
  }
  newId(): number {
    const id = this.nextId;
    this.nextId = id + 1;
    if (this.nAvail < 64) {
      this.avail[this.nAvail] = id;
      this.nAvail = this.nAvail + 1;
    }
    return id;
  }
  item(depth: number): D {
    if (depth <= 0) return this.word();
    const k = this.rnd(100);
    if (k < 28) return this.word();
    if (k < 40) return group(this.seq(depth - 1, 4));
    if (k < 44) return groupBreak(this.seq(depth - 1, 3));
    if (k < 52) {
      const id = this.newId();
      return seq(this.word(), groupId(id, text("("), softBlockIndent(this.seq(depth - 1, 4), ifBreakId(id, text(","), text(""))), text(")")));
    }
    if (k < 60) return seq(this.word(), group(text("("), softBlockIndent(this.seq(depth - 1, 4), tokenIfBreaks(",")), text(")")));
    if (k < 64) return seq(this.word(), group(text("{"), softSpaceBlockIndent(this.seq(depth - 1, 4)), text("}")));
    if (k < 67) return seq(this.word(), group(text("["), blockIndent(this.seq(depth - 1, 3)), text("]")));
    if (k < 72) return indent(this.seq(depth - 1, 4));
    if (k < 75) return align(1 + this.rnd(3), this.seq(depth - 1, 4));
    if (k < 77) return seq(this.word(), dedentToRoot(this.seq(depth - 1, 3)));
    if (k < 78) return seq(this.word(), indent(this.word(), dedent(this.seq(depth - 1, 3))));
    // A fill in a variant of a best-fitting that is printed flat because it fits up to its first forced line break is not
    // measured by ir/ (`measured_group_fits`), where Prettier's fill always is: the printers differ by design there.
    if (k < 84 && this.fillMode) {
      const n = 2 + this.rnd(6);
      const parts: D[] = [];
      for (let i = 0; i < n; i++) {
        if (i > 0) parts.push(this.rnd(4) === 0 ? softline() : line());
        parts.push(this.rnd(5) === 0 ? this.item(depth - 1) : this.word());
      }
      return fill(...parts);
    }
    if (k < 89 && !this.fillMode) {
      const n = 2 + this.rnd(2);
      const vs: D[] = [];
      // A group in a variant may not be printed: it is not there for what follows.
      const saved = this.nAvail;
      this.inBest = this.inBest + 1;
      for (let i = 0; i < n; i++) {
        vs.push(this.seq(depth - 1, 3));
        this.nAvail = saved;
      }
      this.inBest = this.inBest - 1;
      return best(...vs);
    }
    if (k < 92) return seq(this.word(), lineSuffix(text(" // c")));
    if (k < 94) return seq(this.word(), lineSuffix(text(" // c")), lineSuffixBoundary(), this.word());
    if (k < 96 && this.nAvail > 0) {
      const id = this.avail[this.rnd(this.nAvail)];
      return seq(this.word(), indent(this.word(), indentIfBreak(id, this.word(), hardline(), this.word())));
    }
    if (this.nAvail > 0) {
      const id = this.avail[this.rnd(this.nAvail)];
      const saved = this.nAvail;
      const a = this.seq(depth - 1, 2);
      this.nAvail = saved;
      const b = this.seq(depth - 1, 2);
      this.nAvail = saved;
      return ifBreakId(id, a, b);
    }
    return ifBreak(this.word(), this.word());
  }
  seq(depth: number, maxItems: number): D {
    const n = 1 + this.rnd(maxItems);
    const parts: D[] = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        if (this.rnd(15) === 0 && this.nAvail > 0) parts.push(this.indentedLine());
        else parts.push(this.sep());
      }
      parts.push(this.item(depth));
    }
    return seq(...parts);
  }
  indentedLine(): D {
    return indentedLineGroup(this.newId());
  }
}

/** A random document: see `Gen`. */
export function randomDoc(seed: number, depth: number, wide: boolean): D {
  const g = new Gen(seed);
  g.wide = wide;
  return g.seq(depth, 5);
}
