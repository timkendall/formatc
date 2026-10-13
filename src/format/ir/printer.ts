// Port of vendor/bun/src/format/ir/printer/{mod,measure,output}.rs: turns a document into text.
//
// This is an implementation of Prettier's `printDocToString` for a flat document, which started as the printer of Biome
// and oxc.
//
// - `printElements` goes through the elements and decides for each group whether it is printed on one line.
// - The `Tracker` (document.ts) has measured most groups: see `Flat` in element.ts. For those, the decision takes the
//   width of the group and a look at what follows it up to the next possible line break (`fits`), and a group that fits
//   is printed by `printFlat`, which has nothing to decide.
// - A group that has not been measured is measured here, element by element.
//
// All state of a run is in the fields of one `Printer` per thread, which keeps its arrays from one file to the next
// (grow-only). Rust's `Result<_, PrintError>` is an int: >= 0 is a value, < 0 is a `PE_*` error.
//
// `Measure` (a look ahead that does not change the printer's queue and frames) is a set of `m*` fields: there is one
// measurement at a time, as in Rust.
import { ByteBuf } from "../../base/bytebuf.ts";
import { Stack } from "../../base/stack.ts";
import { isTooLong } from "../errors.ts";
import { FormatOptions, INDENT_TAB, FLAVOR_OXFMT, LINE_ENDING_CR, LINE_ENDING_CRLF, resolveLineEnding } from "../options.ts";
import {
  E_BEST_FITTING,
  E_CURSOR,
  E_EXPAND_PARENT,
  E_INDENTED_LINE_GROUP,
  E_INTERNED,
  E_LINE,
  E_LINE_SUFFIX_BOUNDARY,
  E_NOP,
  E_OWNED_TEXT,
  E_SKIP,
  E_SOURCE_TEXT,
  E_SPACE,
  E_TOKEN,
  E_TOKEN_IF_BREAKS,
  FF_ENDS_WITH_SPACE,
  FF_ENDS_WITH_SPACE_ELEMENT,
  FF_HAS_GROUP_IDS,
  FF_HAS_LINE_SUFFIX_BOUNDARY,
  FF_MEASURED,
  FF_STARTS_WITH_LINE,
  FF_STARTS_WITH_SPACE,
  CURSOR_REGION_END,
  GM_FLAT,
  LM_EMPTY,
  LM_HARD,
  LM_SOFT,
  LM_SOFT_EMPTY,
  LM_SOFT_OR_SPACE,
  LM_SOFT_OR_SPACE_EMPTY,
  END_LINE_SUFFIX_AT,
  LINE_BREAK_AT,
  PRINT_EXPANDED,
  PRINT_FLAT,
  REST_OF_INDENTED_LINE_GROUP_AT,
  T_END_ALIGN,
  T_END_COND,
  T_END_DEDENT,
  T_END_DEDENT_ROOT,
  T_END_ENTRY,
  T_END_FILL,
  T_END_GROUP,
  T_END_INDENT,
  T_END_INDENT_IF_GROUP_BREAKS,
  T_END_INDENT_WITH_LINE,
  T_END_LABELLED,
  T_END_LINE_SUFFIX,
  T_START_ALIGN,
  T_START_COND,
  T_START_DEDENT,
  T_START_DEDENT_ROOT,
  T_START_ENTRY,
  T_START_FILL,
  T_START_GROUP,
  T_START_INDENT,
  T_START_INDENT_IF_GROUP_BREAKS,
  T_START_INDENT_WITH_LINE,
  T_START_LABELLED,
  T_START_LINE_SUFFIX,
  TIB_BASE,
  TOK_BASE,
  TW_ONE_STRING,
  TW_VALUE_MASK,
  tokenBytes,
} from "./element.ts";
import { Storage } from "./storage.ts";
import { textWidth } from "./width.ts";

// PrintError
export const PE_INVALID_DOCUMENT = -1;
/** What is being measured depends on a group that was passed over by its `Flat`. It has to be measured again, element by element. This does not leave the printer. */
export const PE_MEASURE_AGAIN = -2;
/** Fills or variants are in each other so deeply that printing them would overflow the stack. */
export const PE_NESTED_TOO_DEEPLY = -3;
/** See `isTooLong`. */
export const PE_TOO_LONG = -4;

// FrameKind
const FK_ROOT = 0;
const FK_GROUP = 1;
const FK_FILL = 2;
/** There is no such tag. See `printFillItem`. */
const FK_FILL_SEPARATOR = 3;
const FK_ENTRY = 4;
const FK_LINE_SUFFIX = 5;

// FillPairLayout
/** The item, the separator and the next item fit. */
const FPL_FLAT = 0;
/** The item fits. The separator or the next item does not. */
const FPL_ITEM_FLAT_SEPARATOR_EXPANDED = 1;
/** The item does not fit. */
const FPL_EXPANDED = 2;

// Fits
const FITS_NO = 0;
const FITS_YES = 1;
/** It depends on what follows. */
const FITS_MAYBE = 2;

export class Printer {
  // The document.
  tag: Uint8Array;
  a: Int32Array;
  b: Int32Array;
  c: Int32Array;
  poolLen: number;
  variants: Int32Array;
  source: Uint8Array;
  text: Uint8Array;
  tok: Uint8Array;

  // Options
  indentWidth: number;
  printWidth: number;
  useTabs: boolean;
  oxfmt: boolean;
  marksLineBreaksInTexts: boolean;
  /** 0 `\n`, 1 `\r\n`, 2 `\r` */
  lineEnding: number;
  flavor: number;
  tabWidth: number;

  // Output
  out: Uint8Array;
  /** The same bytes as `out`, for stores of 32 bits. */
  ov: DataView;
  /** `source` as a view, for loads of 32 bits. */
  sv: DataView;
  srcLen: number;
  outLen: number;
  outStart: number;
  tooLong: boolean;

  // State
  pendingLevel: number;
  pendingAlign: number;
  pendingCount: number;
  pendingSpace: boolean;
  /** `pendingLevel !== 0 || pendingCount !== 0`: indentation is due before the next text. */
  pendingIndent: boolean;
  /** `markPending0 || markPending1` */
  anyMarkPending: boolean;
  /** An enclosing group has been found to fit, so what is in it does not have to be measured. */
  measuredGroupFits: boolean;
  hasEmptyLine: boolean;
  lineWidth: number;
  /** What is being printed: the elements `[ePos, eEnd)`. */
  ePos: number;
  eEnd: number;
  /** That of the last frame. */
  mode: number;
  /** Where the `E_CURSOR`s of the last document are in its text (-1 is none). */
  marks0: number;
  marks1: number;
  /** `marks[i]` is after the pending indentation and space, if those are printed. */
  markPending0: boolean;
  markPending1: boolean;

  // What is to be printed after the current run. The last comes first.
  queueAt: Int32Array;
  queueEnd: Int32Array;
  qLen: number;
  frameKind: Uint8Array;
  frameMode: Uint8Array;
  fLen: number;
  /** The indentation of every enclosing indent and align. A dedent moves the top to `history` and its end moves it back. */
  indLevel: Int32Array;
  indAlign: Int32Array;
  indCount: Int32Array;
  indLen: number;
  histLevel: Int32Array;
  histAlign: Int32Array;
  histCount: Int32Array;
  histLen: number;
  /** The indentation at each pending line suffix. */
  sufLevel: Int32Array;
  sufAlign: Int32Array;
  sufCount: Int32Array;
  sufLen: number;
  /** Pending line suffixes: the run of the content and the mode. */
  lsAt: Int32Array;
  lsEnd: Int32Array;
  lsMode: Uint8Array;
  lsLen: number;
  /** By group id: 0 not seen, 1 flat, 2 expanded. */
  groupModes: Uint8Array;
  groupModesMax: number;
  /** What a measure puts on top of `queue` and `frames`, which it leaves as they are. */
  mqAt: Int32Array;
  mqEnd: Int32Array;
  mqLen: number;
  mfKind: Uint8Array;
  mfMode: Uint8Array;
  mfLen: number;
  // For printFlat and firstOf: stacks of runs.
  rsAt: Int32Array;
  rsEnd: Int32Array;

  // Measure
  mLineWidth: number;
  /** The width of the indentation that is due before the next text. */
  mPendingIndent: number;
  mPendingSpace: boolean;
  /** It is pending because of an `E_SPACE`, which is a text to Prettier: it counts even if no text follows it on the line. */
  mIsSpaceElementPending: boolean;
  mHasLineSuffix: boolean;
  mMustBeFlat: boolean;
  /** Groups that are measured are passed over. */
  mUsesFlat: boolean;
  /** Something with a group that has an id in it has been passed over, so the mode of that group has not been noted. */
  mHasPassedGroupIds: boolean;
  mePos: number;
  meEnd: number;
  /** The number of runs that are left of the queue of the printer. */
  mQueueLen: number;
  /** The number of frames that are left of those of the printer. */
  mFramesLen: number;
  mMode: number;
  // SingleEntryPredicate
  spDepth: number;
  spDone: boolean;
  // measureFill results
  fillPairs: number;
  fillLayout: number;

  stack: Stack;

  constructor() {
    this.tag = new Uint8Array(0);
    this.a = new Int32Array(0);
    this.b = new Int32Array(0);
    this.c = new Int32Array(0);
    this.poolLen = 0;
    this.variants = new Int32Array(0);
    this.source = new Uint8Array(0);
    this.text = new Uint8Array(0);
    this.tok = new Uint8Array(0);
    this.indentWidth = 2;
    this.printWidth = 80;
    this.useTabs = false;
    this.oxfmt = false;
    this.marksLineBreaksInTexts = false;
    this.lineEnding = 0;
    this.flavor = 0;
    this.tabWidth = 0;
    this.out = new Uint8Array(0);
    this.ov = new DataView(new ArrayBuffer(0));
    this.sv = new DataView(new ArrayBuffer(0));
    this.srcLen = 0;
    this.outLen = 0;
    this.outStart = 0;
    this.tooLong = false;
    this.pendingLevel = 0;
    this.pendingAlign = 0;
    this.pendingCount = 0;
    this.pendingSpace = false;
    this.pendingIndent = false;
    this.anyMarkPending = false;
    this.measuredGroupFits = true;
    this.hasEmptyLine = false;
    this.lineWidth = 0;
    this.ePos = 0;
    this.eEnd = 0;
    this.mode = PRINT_EXPANDED;
    this.marks0 = -1;
    this.marks1 = -1;
    this.markPending0 = false;
    this.markPending1 = false;
    this.queueAt = new Int32Array(64);
    this.queueEnd = new Int32Array(64);
    this.qLen = 0;
    this.frameKind = new Uint8Array(64);
    this.frameMode = new Uint8Array(64);
    this.fLen = 0;
    this.indLevel = new Int32Array(64);
    this.indAlign = new Int32Array(64);
    this.indCount = new Int32Array(64);
    this.indLen = 0;
    this.histLevel = new Int32Array(16);
    this.histAlign = new Int32Array(16);
    this.histCount = new Int32Array(16);
    this.histLen = 0;
    this.sufLevel = new Int32Array(16);
    this.sufAlign = new Int32Array(16);
    this.sufCount = new Int32Array(16);
    this.sufLen = 0;
    this.lsAt = new Int32Array(16);
    this.lsEnd = new Int32Array(16);
    this.lsMode = new Uint8Array(16);
    this.lsLen = 0;
    this.groupModes = new Uint8Array(256);
    this.groupModesMax = 0;
    this.mqAt = new Int32Array(64);
    this.mqEnd = new Int32Array(64);
    this.mqLen = 0;
    this.mfKind = new Uint8Array(64);
    this.mfMode = new Uint8Array(64);
    this.mfLen = 0;
    this.rsAt = new Int32Array(64);
    this.rsEnd = new Int32Array(64);
    this.mLineWidth = 0;
    this.mPendingIndent = 0;
    this.mPendingSpace = false;
    this.mIsSpaceElementPending = false;
    this.mHasLineSuffix = false;
    this.mMustBeFlat = false;
    this.mUsesFlat = false;
    this.mHasPassedGroupIds = false;
    this.mePos = 0;
    this.meEnd = 0;
    this.mQueueLen = 0;
    this.mFramesLen = 0;
    this.mMode = PRINT_EXPANDED;
    this.spDepth = 0;
    this.spDone = false;
    this.fillPairs = 0;
    this.fillLayout = 0;
    this.stack = Stack.create();
  }

  // ───────────────────────────── entry ─────────────────────────────

  /**
   * Appends the text of the document `[rootStart, rootEnd)` of `st` to `out`. `lineEnding`: an `LINE_ENDING_*` (resolved:
   * not AUTO). Returns 0, or a `PE_*` error.
   */
  print(st: Storage, rootStart: number, rootEnd: number, source: Uint8Array, options: FormatOptions, lineEnding: number, marksLineBreaks: boolean, out: ByteBuf): number {
    this.tag = st.tag;
    this.a = st.a;
    this.b = st.b;
    this.c = st.c;
    this.poolLen = st.len;
    this.variants = st.variants.data;
    this.source = source;
    this.text = st.text.data;
    this.tok = tokenBytes();
    this.indentWidth = options.indentWidth;
    this.printWidth = options.lineWidth;
    this.useTabs = options.indentStyle === INDENT_TAB;
    this.oxfmt = options.flavor === FLAVOR_OXFMT;
    this.flavor = options.flavor;
    this.tabWidth = this.oxfmt ? options.indentWidth : 0;
    this.marksLineBreaksInTexts = marksLineBreaks;
    this.lineEnding = lineEnding === LINE_ENDING_CRLF ? 1 : lineEnding === LINE_ENDING_CR ? 2 : 0;

    this.qLen = 0;
    this.fLen = 0;
    this.frameKind[0] = FK_ROOT;
    this.frameMode[0] = PRINT_EXPANDED;
    this.fLen = 1;
    this.indLevel[0] = 0;
    this.indAlign[0] = 0;
    this.indCount[0] = 0;
    this.indLen = 1;
    this.histLen = 0;
    this.sufLen = 0;
    this.lsLen = 0;
    if (this.groupModesMax > 0) this.groupModes.fill(0, 0, this.groupModesMax);
    this.groupModesMax = 0;
    this.marks0 = -1;
    this.marks1 = -1;
    this.markPending0 = false;
    this.markPending1 = false;
    this.pendingLevel = 0;
    this.pendingAlign = 0;
    this.pendingCount = 0;
    this.pendingSpace = false;
    this.pendingIndent = false;
    this.anyMarkPending = false;
    this.measuredGroupFits = true;
    this.hasEmptyLine = false;
    this.lineWidth = 0;
    this.mode = PRINT_EXPANDED;
    this.stack.reset();

    // A document can be a small part of what is made of a large file.
    this.out = out.data;
    this.ov = new DataView(this.out.buffer, this.out.byteOffset, this.out.length);
    this.sv = new DataView(source.buffer, source.byteOffset, source.length);
    this.srcLen = source.length;
    this.outLen = out.len;
    this.outStart = out.len;
    this.tooLong = false;
    const expected = (source.length + (source.length >> 3) < (rootEnd - rootStart) * 16 ? source.length + (source.length >> 3) : (rootEnd - rootStart) * 16) + 64;
    this.reserveOut(expected);

    this.setElements(rootStart, rootEnd);
    const result = this.printAll();
    this.pullMarksBack();
    out.data = this.out;
    out.len = this.outLen;
    if (this.tooLong || isTooLong(this.outLen)) return PE_TOO_LONG;
    return result;
  }

  setElements(at: number, end: number): void {
    // Elements::new: a range outside of the pool is empty.
    if (end > this.poolLen || at > end) {
      this.ePos = at;
      this.eEnd = at;
    } else {
      this.ePos = at;
      this.eEnd = end;
    }
  }

  printAll(): number {
    while (true) {
      const r = this.printElements(false, PRINT_EXPANDED);
      if (r < 0) return r;
      if (this.lsLen === 0) return 0;
      this.flushLineSuffixes(-1);
    }
  }

  // ───────────────────────────── output ─────────────────────────────

  /** Makes room for `extra` more bytes, and 16 more that a store of words can write past the end of a text. */
  reserveOut(extra: number): void {
    if (this.outLen + extra + 16 > this.out.length) this.growOut(extra + 16);
  }

  growOut(additional: number): void {
    if (isTooLong(this.outLen + additional)) {
      this.tooLong = true;
      this.outLen = this.outStart;
      if (this.out.length - this.outLen >= additional) return;
    }
    let n = this.out.length * 2;
    const need = this.outLen + additional + 4096;
    if (n < need) n = need;
    const nd = new Uint8Array(n);
    nd.set(this.out.subarray(0, this.outLen));
    this.out = nd;
    this.ov = new DataView(nd.buffer, nd.byteOffset, nd.length);
  }

  putWord(p: number, w: number): void {
    const out = this.out;
    out[p] = w & 255;
    out[(p + 1) | 0] = (w >>> 8) & 255;
    out[(p + 2) | 0] = (w >>> 16) & 255;
    out[(p + 3) | 0] = (w >>> 24) & 255;
  }

  /** A token with inline bytes (kind `TOK_BASE + len`): `a`, `b`, `c` of the element at `idx` are its bytes. */
  outInlineToken(idx: number, len: number): void {
    if (this.outLen + 32 > this.out.length) this.growOut(32);
    const p = this.outLen | 0;
    this.putWord(p, this.a[idx] | 0);
    if (len > 4) {
      this.putWord((p + 4) | 0, this.b[idx] | 0);
      if (len > 8) this.putWord((p + 8) | 0, this.c[idx] | 0);
    }
    this.outLen = (p + len) | 0;
  }

  /** A token that has more than 12 bytes (`E_TOKEN`): `a` is the offset in `tokenBytes()`, `b` the length. */
  outLongToken(idx: number): void {
    this.outPart(this.tok, this.a[idx] | 0, this.b[idx] | 0);
  }

  outByte(byte: number): void {
    if (this.outLen + 32 > this.out.length) this.growOut(32);
    this.out[this.outLen] = byte | 0;
    this.outLen = this.outLen + 1;
  }

  /** Writes src[start, start + len). */
  outPart(src: Uint8Array, start: number, len: number): void {
    if (this.outLen + len + 32 > this.out.length) this.growOut(len + 32);
    const p = this.outLen | 0;
    if (len < 16) {
      for (let i = 0; i < len; i++) this.out[(p + i) | 0] = src[(start + i) | 0] | 0;
    } else {
      this.out.set(src.subarray(start, start + len), p);
    }
    this.outLen = (p + len) | 0;
  }

  /** Writes source[start, start + len): words at a time while the source has the bytes for it. */
  outSource(start: number, len: number): void {
    if (this.outLen + len + 32 > this.out.length) this.growOut(len + 32);
    const p = this.outLen | 0;
    if (len <= 64) {
      const out = this.out;
      const src = this.source;
      for (let k = 0; k < len; k++) out[(p + k) | 0] = src[(start + k) | 0] | 0;
    } else {
      this.out.set(this.source.subarray(start, start + len), p);
    }
    this.outLen = (p + len) | 0;
  }

  outRepeat(byte: number, count: number): void {
    if (count <= 32) {
      const p = this.outLen;
      if (p + count > this.out.length) this.growOut(count);
      const o = this.out;
      for (let i = 0; i < count; i++) o[p + i] = byte | 0;
      this.outLen = p + count;
      return;
    }
    // It is the indentation that makes a text too long. Without it, what is left to print is soon printed.
    if (this.tooLong || isTooLong(this.outLen + count)) {
      this.tooLong = true;
      return;
    }
    if (this.outLen + count > this.out.length) this.growOut(count);
    this.out.fill(byte, this.outLen, this.outLen + count);
    this.outLen = this.outLen + count;
  }

  outTrimTrailingWhitespace(): void {
    const o = this.out;
    let n = this.outLen;
    while (n > this.outStart) {
      const ch = o[n - 1] | 0;
      if (ch !== 32 && ch !== 9) break;
      n = n - 1;
    }
    this.outLen = n;
  }

  // ───────────────────────────── the queue ─────────────────────────────

  /** Puts `[at, end)` before everything that is in the queue. */
  printNext(at: number, end: number): void {
    if (this.ePos < this.eEnd) {
      const n = this.qLen;
      if (n === this.queueAt.length) this.growQueue();
      this.queueAt[n] = this.ePos | 0;
      this.queueEnd[n] = this.eEnd | 0;
      this.qLen = n + 1;
    }
    this.setElements(at, end);
  }

  growQueue(): void {
    const n = this.queueAt.length * 2;
    const qa = new Int32Array(n);
    qa.set(this.queueAt);
    this.queueAt = qa;
    const qe = new Int32Array(n);
    qe.set(this.queueEnd);
    this.queueEnd = qe;
  }

  /** The element at `ePos` .. is the next of the queue; returns its index or -1 when everything is printed. */
  nextElement(): number {
    while (true) {
      const p = this.ePos;
      if (p < this.eEnd) {
        this.ePos = p + 1;
        return p;
      }
      const n = this.qLen;
      if (n === 0) return -1;
      this.qLen = n - 1;
      this.setElements(this.queueAt[n - 1] | 0, this.queueEnd[n - 1] | 0);
    }
  }

  /**
   * The index of the first element of the run `[pos, end)` that stands for itself (not a `Nop`, a `Cursor`, the content of
   * a `Skip`, an `Interned` is looked into), or -1.
   */
  firstOf(pos0: number, end0: number): number {
    let pos = pos0;
    let end = end0;
    let sp = 0;
    if (end > this.poolLen || pos > end) return -1;
    while (true) {
      while (pos < end) {
        const t = this.tag[pos] | 0;
        if (t === E_NOP || t === E_CURSOR) {
          pos = pos + 1;
        } else if (t === E_SKIP) {
          pos = pos + 1 + (this.a[pos] | 0);
          if (pos > end) pos = end;
        } else if (t === E_INTERNED) {
          if (sp === this.rsAt.length) this.growRs();
          this.rsAt[sp] = (pos + 1) | 0;
          this.rsEnd[sp] = end | 0;
          sp = sp + 1;
          const h = this.a[pos] | 0;
          pos = h + 1;
          end = h + 1 + (this.a[h] | 0);
        } else {
          return pos;
        }
      }
      if (sp === 0) return -1;
      sp = sp - 1;
      pos = this.rsAt[sp] | 0;
      end = this.rsEnd[sp] | 0;
    }
  }

  growRs(): void {
    const n = this.rsAt.length * 2;
    const ra = new Int32Array(n);
    ra.set(this.rsAt);
    this.rsAt = ra;
    const re = new Int32Array(n);
    re.set(this.rsEnd);
    this.rsEnd = re;
  }

  /** The next element that stands for itself, as an index (or -1). */
  peek(): number {
    const first = this.firstOf(this.ePos, this.eEnd);
    if (first >= 0) return first;
    for (let i = this.qLen - 1; i >= 0; i--) {
      const f = this.firstOf(this.queueAt[i] | 0, this.queueEnd[i] | 0);
      if (f >= 0) return f;
    }
    return -1;
  }

  isAtStartEntry(): boolean {
    const p = this.peek();
    return p >= 0 && (this.tag[p] | 0) === T_START_ENTRY;
  }

  // ───────────────────────────── modes ─────────────────────────────

  pushFrame(kind: number, mode: number): void {
    const n = this.fLen;
    if (n === this.frameKind.length) this.growFrames();
    this.frameKind[n] = kind | 0;
    this.frameMode[n] = mode | 0;
    this.fLen = n + 1;
    this.mode = mode;
  }

  growFrames(): void {
    const n = this.frameKind.length * 2;
    const k = new Uint8Array(n);
    k.set(this.frameKind);
    this.frameKind = k;
    const m = new Uint8Array(n);
    m.set(this.frameMode);
    this.frameMode = m;
  }

  /** Fails unless the innermost frame is of `kind`. */
  popFrame(kind: number): number {
    const n = this.fLen;
    if (n >= 2 && (this.frameKind[n - 1] | 0) === kind) {
      this.fLen = n - 1;
      this.mode = this.frameMode[n - 2] | 0;
      return 0;
    }
    return PE_INVALID_DOCUMENT;
  }

  insertGroupMode(id: number, mode: number): void {
    if (id >= this.groupModes.length) {
      let n = this.groupModes.length * 2;
      if (n < id + 1) n = id + 1;
      if (n < 64) n = 64;
      const g = new Uint8Array(n);
      g.set(this.groupModes);
      this.groupModes = g;
    }
    this.groupModes[id] = (mode + 1) | 0;
    if (id >= this.groupModesMax) this.groupModesMax = id + 1;
  }

  /** The mode the group `id` was printed in: `PRINT_*`, or -1 if it has not been seen. */
  groupMode(id: number): number {
    if (id >= this.groupModes.length) return -1;
    return (this.groupModes[id] | 0) - 1;
  }

  /** Whether `printFlat` can print content that is `flat` (packed). */
  canPrintFlat(flat: number): boolean {
    const flags = (flat >> 16) & 0xff;
    return (flags & FF_MEASURED) !== 0 && ((flags & FF_HAS_LINE_SUFFIX_BOUNDARY) === 0 || this.lsLen === 0);
  }

  // ───────────────────────────── indentation ─────────────────────────────

  growIndentions(): void {
    const n = this.indLevel.length * 2;
    const l = new Int32Array(n);
    l.set(this.indLevel);
    this.indLevel = l;
    const al = new Int32Array(n);
    al.set(this.indAlign);
    this.indAlign = al;
    const c = new Int32Array(n);
    c.set(this.indCount);
    this.indCount = c;
  }

  pushIndention(level: number, align: number, count: number): void {
    const n = this.indLen;
    if (n === this.indLevel.length) this.growIndentions();
    this.indLevel[n] = level | 0;
    this.indAlign[n] = align | 0;
    this.indCount[n] = count | 0;
    this.indLen = n + 1;
  }

  popIndention(): void {
    if (this.indLen > 0) this.indLen = this.indLen - 1;
  }

  /** One more level. With tabs, every align becomes a level too. */
  indent(): void {
    const n = this.indLen;
    let level = 0;
    let align = 0;
    let count = 0;
    if (n > 0) {
      level = this.indLevel[n - 1] | 0;
      align = this.indAlign[n - 1] | 0;
      count = this.indCount[n - 1] | 0;
    }
    if (count === 0) this.pushIndention(level + 1, 0, 0);
    else if (this.useTabs) this.pushIndention(level + count + 1, 0, 0);
    else this.pushIndention(level + 1, align, count);
  }

  /** `count` more spaces. */
  pushAlign(count: number): void {
    const n = this.indLen;
    let level = 0;
    let align = 0;
    let cnt = 0;
    if (n > 0) {
      level = this.indLevel[n - 1] | 0;
      align = this.indAlign[n - 1] | 0;
      cnt = this.indCount[n - 1] | 0;
    }
    if (cnt === 0) this.pushIndention(level, count, 1);
    else this.pushIndention(level, align + count, cnt + 1);
  }

  /** The pending indentation becomes the innermost one. */
  setPendingToCurrent(): void {
    const n = this.indLen;
    if (n > 0) {
      this.pendingLevel = this.indLevel[n - 1] | 0;
      this.pendingAlign = this.indAlign[n - 1] | 0;
      this.pendingCount = this.indCount[n - 1] | 0;
    } else {
      this.pendingLevel = 0;
      this.pendingAlign = 0;
      this.pendingCount = 0;
    }
    this.pendingIndent = this.pendingLevel !== 0 || this.pendingCount !== 0;
  }

  // ───────────────────────────── printing ─────────────────────────────

  /**
   * Prints what is in the queue.
   * `entry`: only from the `T_START_ENTRY` that is next in the queue to its `T_END_ENTRY`, in `entryMode`.
   *
   * The hot loop: tokens, source texts and spaces, and the tags that only change the indentation and the frames, are
   * done here, with the cursor and the state of the output in locals (docs/SCRIPTC_COOKBOOK.md rule 5; fields would be
   * written and read for every element). Anything else is `printOther`, which gets the state in the fields, and the
   * locals are read again after it.
   */
  printElements(entry: boolean, entryMode: number): number {
    let depth = 0;
    let pos = this.ePos | 0;
    let end = this.eEnd | 0;
    let outLen = this.outLen | 0;
    let lineWidth = this.lineWidth | 0;
    let pendingSpace = this.pendingSpace;
    let hasEmptyLine = this.hasEmptyLine;
    while (true) {
      if (pos >= end) {
        // The next run of the queue.
        this.ePos = pos;
        const n = this.qLen;
        if (n === 0) {
          this.outLen = outLen;
          this.lineWidth = lineWidth;
          this.pendingSpace = pendingSpace;
          this.hasEmptyLine = hasEmptyLine;
          return entry ? PE_INVALID_DOCUMENT : 0;
        }
        this.qLen = n - 1;
        this.setElements(this.queueAt[n - 1] | 0, this.queueEnd[n - 1] | 0);
        pos = this.ePos | 0;
        end = this.eEnd | 0;
        continue;
      }
      const idx = pos | 0;
      pos = ((pos | 0) + 1) | 0;
      const t = this.tag[idx] | 0;
      if (t >= TOK_BASE) {
        // A token with inline bytes: the kind says how long it is.
        let len = t - TOK_BASE;
        if (t >= TIB_BASE) {
          if (this.mode === PRINT_FLAT) continue;
          len = t - TIB_BASE;
        }
        if (this.pendingIndent) {
          this.outLen = outLen;
          this.lineWidth = lineWidth;
          this.pendingSpace = pendingSpace;
          this.printPendingIndent();
          outLen = this.outLen | 0;
          lineWidth = this.lineWidth | 0;
          pendingSpace = this.pendingSpace;
        }
        if (outLen + 32 > this.out.length) {
          this.outLen = outLen;
          this.growOut(32);
          outLen = this.outLen | 0;
        }
        if (pendingSpace) {
          this.out[outLen] = 32;
          outLen = ((outLen | 0) + 1) | 0;
          pendingSpace = false;
          lineWidth = ((lineWidth | 0) + 1) | 0;
          if (this.anyMarkPending) {
            this.outLen = outLen;
            this.movePendingMarks();
          }
        }
        this.putWord(outLen, this.a[idx] | 0);
        if (len > 4) {
          this.putWord((outLen + 4) | 0, this.b[idx] | 0);
          if (len > 8) this.putWord((outLen + 8) | 0, this.c[idx] | 0);
        }
        outLen = ((outLen | 0) + (len | 0)) | 0;
        lineWidth = ((lineWidth | 0) + (len | 0)) | 0;
        hasEmptyLine = false;
        continue;
      }
      switch (t) {
        case E_SOURCE_TEXT: {
          const w = this.c[idx] | 0;
          if (w >= 0) {
            if (this.pendingIndent) {
              this.outLen = outLen;
              this.lineWidth = lineWidth;
              this.pendingSpace = pendingSpace;
              this.printPendingIndent();
              outLen = this.outLen | 0;
              lineWidth = this.lineWidth | 0;
              pendingSpace = this.pendingSpace;
            }
            if (pendingSpace) {
              this.outLen = outLen;
              this.outByte(32);
              outLen = this.outLen | 0;
              pendingSpace = false;
              lineWidth = ((lineWidth | 0) + 1) | 0;
              if (this.anyMarkPending) this.movePendingMarks();
            }
            this.outLen = outLen;
            this.outSource(this.a[idx] | 0, this.b[idx] | 0);
            outLen = this.outLen | 0;
            lineWidth = ((lineWidth | 0) + (w & TW_VALUE_MASK)) | 0;
            hasEmptyLine = false;
            break;
          }
          this.ePos = pos;
          this.outLen = outLen;
          this.lineWidth = lineWidth;
          this.pendingSpace = pendingSpace;
          this.printSourceText(this.a[idx] | 0, this.b[idx] | 0, w);
          outLen = this.outLen | 0;
          lineWidth = this.lineWidth | 0;
          pendingSpace = this.pendingSpace;
          hasEmptyLine = false;
          break;
        }
        case E_SPACE:
          if (lineWidth > 0) {
            pendingSpace = true;
          } else {
            this.outLen = outLen;
            if (this.hasTextWithoutWidth()) pendingSpace = true;
          }
          break;
        case E_NOP:
          break;
        case E_SKIP: {
          const p = ((pos | 0) + (this.a[idx] | 0)) | 0;
          pos = p < end ? p : end;
          break;
        }
        case T_START_ENTRY:
          if (entry) {
            depth = depth + 1;
            if (depth === 1) {
              this.pushFrame(FK_ENTRY, entryMode);
              break;
            }
          }
          this.pushFrame(FK_ENTRY, this.mode);
          break;
        case T_END_ENTRY: {
          const r = this.popFrame(FK_ENTRY);
          if (r < 0) return r;
          if (entry) {
            depth = depth > 0 ? depth - 1 : 0;
            if (depth === 0) {
              this.ePos = pos;
              this.outLen = outLen;
              this.lineWidth = lineWidth;
              this.pendingSpace = pendingSpace;
              this.hasEmptyLine = hasEmptyLine;
              return 0;
            }
          }
          break;
        }
        case T_END_GROUP: {
          const r = this.popFrame(FK_GROUP);
          if (r < 0) return r;
          break;
        }
        case T_START_INDENT:
          this.indent();
          break;
        case T_END_INDENT:
        case T_END_ALIGN:
        case T_END_DEDENT_ROOT:
          this.popIndention();
          break;
        default: {
          this.ePos = pos;
          this.eEnd = end;
          this.outLen = outLen;
          this.lineWidth = lineWidth;
          this.pendingSpace = pendingSpace;
          this.hasEmptyLine = hasEmptyLine;
          const r = this.printOther(idx, t);
          if (r < 0) return r;
          pos = this.ePos | 0;
          end = this.eEnd | 0;
          outLen = this.outLen | 0;
          lineWidth = this.lineWidth | 0;
          pendingSpace = this.pendingSpace;
          hasEmptyLine = this.hasEmptyLine;
          break;
        }
      }
    }
  }

  /** Prints one element that is not done in the hot loop of `printElements`. 0, or a `PE_*` error. */
  printOther(idx: number, t: number): number {
    switch (t) {
        case E_TOKEN:
          this.printPending();
          this.outLongToken(idx);
          this.lineWidth = this.lineWidth + (this.b[idx] | 0);
          this.hasEmptyLine = false;
          break;
        case E_TOKEN_IF_BREAKS:
          if (this.mode !== PRINT_FLAT) {
            this.printPending();
            this.outLongToken(idx);
            this.lineWidth = this.lineWidth + (this.b[idx] | 0);
            this.hasEmptyLine = false;
          }
          break;
        case E_CURSOR:
          this.noteMark(this.a[idx] | 0);
          break;
        case E_OWNED_TEXT:
          this.printText(this.text, this.a[idx] | 0, this.b[idx] | 0, this.c[idx] | 0);
          break;
        case E_LINE:
          this.printLine(this.a[idx] | 0);
          break;
        case E_INDENTED_LINE_GROUP: {
          const id = this.a[idx] | 0;
          let fits = 1;
          if (this.mode === PRINT_FLAT && this.measuredGroupFits) {
            fits = 1;
          } else {
            this.measuredGroupFits = true;
            this.insertGroupMode(id, PRINT_FLAT);
            fits = this.indentedLineGroupFits();
            if (fits < 0) return fits;
          }
          if (fits === 1) {
            this.insertGroupMode(id, PRINT_FLAT);
            if (this.isInLine()) this.pendingSpace = true;
          } else {
            this.insertGroupMode(id, PRINT_EXPANDED);
            this.pushFrame(FK_GROUP, PRINT_EXPANDED);
            this.printNext(REST_OF_INDENTED_LINE_GROUP_AT, REST_OF_INDENTED_LINE_GROUP_AT + 3);
          }
          break;
        }
        // `propagateExpand` has taken care of it.
        case E_EXPAND_PARENT:
          break;
        case E_LINE_SUFFIX_BOUNDARY:
          this.flushLineSuffixes(LINE_BREAK_AT + LM_HARD);
          break;
        case E_BEST_FITTING: {
          const r = this.printBestFitting(this.a[idx] | 0, this.b[idx] | 0);
          if (r < 0) return r;
          break;
        }
        case E_INTERNED: {
          const h = this.a[idx] | 0;
          this.printNext(h + 1, h + 1 + (this.a[h] | 0));
          break;
        }
        case T_START_GROUP: {
          const gb = this.b[idx] | 0;
          const gmode = (gb >> 24) & 3;
          const id = this.a[idx] | 0;
          let groupMode = PRINT_EXPANDED;
          if (gmode !== GM_FLAT) {
            this.measuredGroupFits = true;
            groupMode = PRINT_EXPANDED;
          } else if (this.mode === PRINT_FLAT && this.measuredGroupFits) {
            // An enclosing group fits, so this one does.
            groupMode = PRINT_FLAT;
          } else {
            this.measuredGroupFits = true;
            if (id !== 0) this.insertGroupMode(id, PRINT_FLAT);
            const fits = this.groupFits(idx);
            if (fits < 0) return fits;
            groupMode = fits === 1 ? PRINT_FLAT : PRINT_EXPANDED;
          }
          if (id !== 0) this.insertGroupMode(id, groupMode);
          const gend = this.c[idx] | 0;
          if (groupMode === PRINT_FLAT && this.canPrintFlat(gb >> 0) && gend < this.eEnd) {
            const at = this.ePos;
            this.moveTo(gend + 1);
            const r = this.printFlat(at, gend);
            if (r < 0) return r;
          } else {
            this.pushFrame(FK_GROUP, groupMode);
          }
          break;
        }
        case T_START_FILL: {
          const r = this.printFillEntries();
          if (r < 0) return r;
          break;
        }
        case T_END_FILL: {
          const r = this.popFrame(FK_FILL);
          if (r < 0) return r;
          break;
        }
        case T_START_INDENT_WITH_LINE:
          this.indent();
          this.printLine(this.a[idx] | 0);
          break;
        case T_END_INDENT_WITH_LINE:
          this.popIndention();
          this.printLine(this.a[idx] | 0);
          break;
        case T_START_DEDENT: {
          if (this.indLen > 0) {
            const k = this.indLen - 1;
            const hn = this.histLen;
            if (hn === this.histLevel.length) this.growHistory();
            this.histLevel[hn] = this.indLevel[k] | 0;
            this.histAlign[hn] = this.indAlign[k] | 0;
            this.histCount[hn] = this.indCount[k] | 0;
            this.histLen = hn + 1;
            this.indLen = k;
          }
          break;
        }
        case T_START_DEDENT_ROOT:
          this.pushIndention(0, 0, 0);
          break;
        case T_START_ALIGN:
          this.pushAlign(this.a[idx] | 0);
          break;
        case T_START_COND: {
          const gid = this.a[idx] | 0;
          let groupMode = this.mode;
          if (gid !== 0) {
            groupMode = this.groupMode(gid);
            if (groupMode < 0) return PE_INVALID_DOCUMENT;
          }
          if (groupMode !== (this.b[idx] | 0)) {
            const e = this.skipCondEnd(this.ePos, this.eEnd);
            if (e < 0) return PE_INVALID_DOCUMENT;
            this.ePos = e;
          }
          break;
        }
        case T_START_INDENT_IF_GROUP_BREAKS: {
          const gm = this.groupMode(this.a[idx] | 0);
          if (gm < 0) return PE_INVALID_DOCUMENT;
          if (gm === PRINT_EXPANDED) this.indent();
          break;
        }
        case T_END_INDENT_IF_GROUP_BREAKS:
          if (this.groupMode(this.a[idx] | 0) === PRINT_EXPANDED) this.popIndention();
          break;
        case T_START_LINE_SUFFIX: {
          const sn = this.sufLen;
          if (sn === this.sufLevel.length) this.growSuffix();
          const k = this.indLen - 1;
          this.sufLevel[sn] = k >= 0 ? this.indLevel[k] | 0 : 0;
          this.sufAlign[sn] = k >= 0 ? this.indAlign[k] | 0 : 0;
          this.sufCount[sn] = k >= 0 ? this.indCount[k] | 0 : 0;
          this.sufLen = sn + 1;
          const contentEnd = this.lineSuffixEnd(this.ePos, this.eEnd);
          if (contentEnd < 0) return PE_INVALID_DOCUMENT;
          const ln = this.lsLen;
          if (ln === this.lsAt.length) this.growLineSuffixes();
          this.lsAt[ln] = this.ePos | 0;
          this.lsEnd[ln] = contentEnd | 0;
          this.lsMode[ln] = this.mode | 0;
          this.lsLen = ln + 1;
          this.ePos = contentEnd + 1;
          break;
        }
        case T_END_LINE_SUFFIX: {
          const r = this.popFrame(FK_LINE_SUFFIX);
          if (r < 0) return r;
          this.popIndention();
          break;
        }
        case T_END_DEDENT:
          if (this.histLen > 0) {
            const hk = this.histLen - 1;
            this.pushIndention(this.histLevel[hk] | 0, this.histAlign[hk] | 0, this.histCount[hk] | 0);
            this.histLen = hk;
          }
          break;
        default:
          // T_START_LABELLED, T_END_LABELLED, T_END_COND
          break;
      }
    return 0;
  }

  growHistory(): void {
    const n = this.histLevel.length * 2;
    const l = new Int32Array(n);
    l.set(this.histLevel);
    this.histLevel = l;
    const al = new Int32Array(n);
    al.set(this.histAlign);
    this.histAlign = al;
    const c = new Int32Array(n);
    c.set(this.histCount);
    this.histCount = c;
  }

  growSuffix(): void {
    const n = this.sufLevel.length * 2;
    const l = new Int32Array(n);
    l.set(this.sufLevel);
    this.sufLevel = l;
    const al = new Int32Array(n);
    al.set(this.sufAlign);
    this.sufAlign = al;
    const c = new Int32Array(n);
    c.set(this.sufCount);
    this.sufCount = c;
  }

  growLineSuffixes(): void {
    const n = this.lsAt.length * 2;
    const a = new Int32Array(n);
    a.set(this.lsAt);
    this.lsAt = a;
    const e = new Int32Array(n);
    e.set(this.lsEnd);
    this.lsEnd = e;
    const m = new Uint8Array(n);
    m.set(this.lsMode);
    this.lsMode = m;
  }

  /** The element at `index`, which is not behind, is the next. */
  moveTo(index: number): void {
    if (index > this.ePos) this.ePos = index < this.eEnd ? index : this.eEnd;
  }

  printLine(lineMode: number): void {
    if (this.mode === PRINT_FLAT) {
      if (lineMode === LM_SOFT || lineMode === LM_SOFT_EMPTY) return;
      if (lineMode === LM_SOFT_OR_SPACE || lineMode === LM_SOFT_OR_SPACE_EMPTY) {
        if (this.isInLine()) this.pendingSpace = true;
        return;
      }
      // Hard, Empty
      this.measuredGroupFits = false;
    }

    // They come first, and then this again.
    if (this.lsLen > 0) {
      this.flushLineSuffixes(LINE_BREAK_AT + lineMode);
      return;
    }

    // Not if there is nothing on the line.
    if (this.isInLine()) {
      this.outTrimTrailingWhitespace();
      this.pullMarksBack();
      this.printLineBreak();
      this.hasEmptyLine = false;
    }
    const isEmptyLine = lineMode === LM_EMPTY || lineMode === LM_SOFT_OR_SPACE_EMPTY || lineMode === LM_SOFT_EMPTY;
    if (isEmptyLine && !this.hasEmptyLine) {
      this.printLineBreak();
      this.hasEmptyLine = true;
    }
    this.pendingSpace = false;
    this.setPendingToCurrent();
  }

  printLineBreak(): void {
    const le = this.lineEnding;
    if (le === 0) this.outByte(10);
    else if (le === 1) {
      this.outByte(13);
      this.outByte(10);
    } else this.outByte(13);
    this.lineWidth = 0;
  }

  /** Something has been printed on this line. Its width says so, unless all of it is text without a width: control characters, combining marks. */
  isInLine(): boolean {
    return this.lineWidth > 0 || this.hasTextWithoutWidth();
  }

  /** The byte order mark is not on the first line: Prettier takes it off before it formats. */
  hasTextWithoutWidth(): boolean {
    const n = this.outLen - this.outStart;
    if (n === 0) return false;
    const last = this.out[this.outLen - 1] | 0;
    if (last === 10 || last === 13) return false;
    if (
      n === 3 &&
      (this.out[this.outStart] | 0) === 0xef &&
      (this.out[this.outStart + 1] | 0) === 0xbb &&
      (this.out[this.outStart + 2] | 0) === 0xbf
    ) {
      return false;
    }
    return true;
  }

  /** The indentation and the space that are due before the next text. */
  printPending(): void {
    if (this.pendingIndent) this.printPendingIndent();
    if (this.pendingSpace) {
      this.outByte(32);
      this.pendingSpace = false;
      this.lineWidth = this.lineWidth + 1;
      if (this.anyMarkPending) this.movePendingMarks();
    }
  }

  printPendingIndent(): void {
    const level = this.pendingLevel;
    const align = this.pendingAlign;
    this.pendingLevel = 0;
    this.pendingAlign = 0;
    this.pendingCount = 0;
    this.pendingIndent = false;
    const width = level * this.indentWidth;
    if (this.useTabs) this.outRepeat(9, level);
    else this.outRepeat(32, width);
    if (align > 0) this.outRepeat(32, align);
    this.lineWidth = this.lineWidth + width + align;
    if (!this.pendingSpace) this.movePendingMarks();
  }

  /** Prints src[start, start + len) of width `w` (packed). */
  printText(src: Uint8Array, start: number, len: number, w: number): void {
    this.printPending();
    this.hasEmptyLine = false;
    if (w < 0) {
      this.printTextBody(src, start, len, w);
      return;
    }
    this.outPart(src, start, len);
    this.lineWidth = this.lineWidth + (w & TW_VALUE_MASK);
  }

  /** A source text: `len` bytes from `start`, of width `w` (packed). */
  printSourceText(start: number, len: number, w: number): void {
    this.printPending();
    this.hasEmptyLine = false;
    if (w < 0) {
      this.printTextBody(this.source, start, len, w);
      return;
    }
    this.outSource(start, len);
    this.lineWidth = this.lineWidth + (w & TW_VALUE_MASK);
  }

  /** The text has a line break (its width is negative). The pending indentation and space have been printed. */
  printTextBody(src: Uint8Array, start: number, len: number, w: number): void {
    const lw = this.lineWidth + (w & TW_VALUE_MASK);
    this.printLines(src, start, len);
    // Prettier adds the width of the string, in which a line break is a character like another.
    if ((w & TW_ONE_STRING) !== 0) this.lineWidth = lw;
  }

  printLines(src: Uint8Array, start: number, len: number): void {
    const end = start + len;
    let lineStart = start;
    let i = start;
    // The first line.
    while (i < end && (src[i] | 0) !== 10) i = i + 1;
    this.outPart(src, lineStart, i - lineStart);
    let lastStart = -1;
    let lastEnd = -1;
    while (i < end) {
      // src[i] is a line feed
      i = i + 1;
      lineStart = i;
      while (i < end && (src[i] | 0) !== 10) i = i + 1;
      if (this.marksLineBreaksInTexts) this.outByte(13);
      this.printLineBreak();
      this.outPart(src, lineStart, i - lineStart);
      lastStart = lineStart;
      lastEnd = i;
    }
    if (lastStart >= 0) {
      this.lineWidth = textWidth(src, lastStart, lastEnd, this.flavor, this.tabWidth) & TW_VALUE_MASK;
    }
  }

  // ───────────────────────────── cursor marks ─────────────────────────────

  position(): number {
    return this.outLen - this.outStart;
  }

  noteMark(mark: number): void {
    let index = 0;
    if (mark === CURSOR_REGION_END) {
      if (this.marks1 >= 0) return;
      index = 1;
    }
    const pending = this.pendingSpace || this.pendingIndent;
    if (index === 0) {
      this.marks0 = this.position();
      this.markPending0 = pending;
    } else {
      this.marks1 = this.position();
      this.markPending1 = pending;
    }
    this.anyMarkPending = this.markPending0 || this.markPending1;
  }

  /** What was pending has been printed. */
  movePendingMarks(): void {
    this.anyMarkPending = false;
    if (this.markPending0) {
      this.markPending0 = false;
      this.marks0 = this.position();
    }
    if (this.markPending1) {
      this.markPending1 = false;
      this.marks1 = this.position();
    }
  }

  /** Prettier's `trim`: what was pending or at the end of the line is not printed after all. */
  pullMarksBack(): void {
    if (this.marks0 >= 0 || this.marks1 >= 0) {
      const end = this.position();
      if (this.marks0 > end) this.marks0 = end;
      if (this.marks1 > end) this.marks1 = end;
      this.markPending0 = false;
      this.markPending1 = false;
      this.anyMarkPending = false;
    }
  }

  // ───────────────────────────── conditional content and line suffixes ─────────────────────────────

  /**
   * Passes over what is left of conditional content, whose start tag has just been taken from the run `[pos, end)`, and
   * its end tag. Returns the index after the end tag, or -1.
   */
  skipCondEnd(pos: number, end: number): number {
    let depth = 1;
    let i = pos;
    while (i < end) {
      const t = this.tag[i] | 0;
      i = i + 1;
      if (t === E_SKIP) {
        i = i + (this.a[i - 1] | 0);
        if (i > end) i = end;
      } else if (t === T_START_COND) depth = depth + 1;
      else if (t === T_END_COND) {
        depth = depth - 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** The same for a `T_START_LINE_SUFFIX`: returns the index of its end tag (the content is `[pos, result)`), or -1. */
  lineSuffixEnd(pos: number, end: number): number {
    let depth = 1;
    let i = pos;
    while (i < end) {
      const t = this.tag[i] | 0;
      if (t === T_START_LINE_SUFFIX) depth = depth + 1;
      else if (t === T_END_LINE_SUFFIX) {
        depth = depth - 1;
        if (depth === 0) return i;
      }
      i = i + 1;
    }
    return -1;
  }

  /** Puts the pending line suffixes in the queue, and after them the one-element run at `lineBreakAt` (-1: none). */
  flushLineSuffixes(lineBreakAt: number): void {
    if (this.lsLen === 0) return;
    if (lineBreakAt >= 0) this.printNext(lineBreakAt, lineBreakAt + 1);
    for (let i = this.sufLen - 1; i >= 0; i--) {
      this.pushIndention(this.sufLevel[i] | 0, this.sufAlign[i] | 0, this.sufCount[i] | 0);
    }
    this.sufLen = 0;
    while (this.lsLen > 0) {
      const k = this.lsLen - 1;
      this.lsLen = k;
      this.pushFrame(FK_LINE_SUFFIX, this.lsMode[k] | 0);
      this.printNext(END_LINE_SUFFIX_AT, END_LINE_SUFFIX_AT + 1);
      this.printNext(this.lsAt[k] | 0, this.lsEnd[k] | 0);
    }
  }

  // ───────────────────────────── flat ─────────────────────────────

  /**
   * Prints content `[at, end)` on one line that is `FF_MEASURED`: there is nothing in it that could break the line, and
   * nothing that depends on anything outside of it. Most of the elements of a document are printed here.
   */
  printFlat(at: number, end: number): number {
    let sp = 0;
    let pos = at | 0;
    let e = end | 0;
    while (true) {
      while (pos < e) {
        const idx = pos | 0;
        pos = ((pos | 0) + 1) | 0;
        const t = this.tag[idx] | 0;
        if (t >= TOK_BASE) {
          if (t < TIB_BASE) {
            this.printPending();
            this.outInlineToken(idx, t - TOK_BASE);
            this.lineWidth = this.lineWidth + (t - TOK_BASE);
          }
          continue;
        }
        switch (t) {
          case E_SOURCE_TEXT:
            this.printSourceText(this.a[idx] | 0, this.b[idx] | 0, this.c[idx] | 0);
            break;
          case E_SPACE:
            if (this.isInLine()) this.pendingSpace = true;
            break;
          case E_TOKEN:
            this.printPending();
            this.outLongToken(idx);
            this.lineWidth = this.lineWidth + (this.b[idx] | 0);
            break;
          case E_OWNED_TEXT:
            this.printText(this.text, this.a[idx] | 0, this.b[idx] | 0, this.c[idx] | 0);
            break;
          case E_LINE: {
            const m = this.a[idx] | 0;
            if (m === LM_SOFT_OR_SPACE || m === LM_SOFT_OR_SPACE_EMPTY) {
              if (this.isInLine()) this.pendingSpace = true;
            } else if (m === LM_HARD || m === LM_EMPTY) {
              return PE_INVALID_DOCUMENT;
            }
            break;
          }
          case T_START_INDENT_WITH_LINE:
          case T_END_INDENT_WITH_LINE: {
            const m = this.a[idx] | 0;
            if (m === LM_SOFT_OR_SPACE || m === LM_SOFT_OR_SPACE_EMPTY) {
              if (this.isInLine()) this.pendingSpace = true;
            } else if (m === LM_HARD || m === LM_EMPTY) {
              return PE_INVALID_DOCUMENT;
            }
            break;
          }
          case E_INDENTED_LINE_GROUP:
            this.insertGroupMode(this.a[idx] | 0, PRINT_FLAT);
            if (this.isInLine()) this.pendingSpace = true;
            break;
          case E_SKIP:
            pos = ((pos | 0) + (this.a[idx] | 0)) | 0;
            if (pos > e) pos = e;
            break;
          case E_INTERNED: {
            if (sp === this.rsAt.length) this.growRs();
            this.rsAt[sp] = pos | 0;
            this.rsEnd[sp] = e | 0;
            sp = sp + 1;
            const h = this.a[idx] | 0;
            pos = (h + 1) | 0;
            e = (h + 1 + (this.a[h] | 0)) | 0;
            break;
          }
          case E_BEST_FITTING: {
            const first = this.a[idx] | 0;
            if ((this.b[idx] | 0) < 1) return PE_INVALID_DOCUMENT;
            const flattest = this.variants[first] | 0;
            if (sp === this.rsAt.length) this.growRs();
            this.rsAt[sp] = pos | 0;
            this.rsEnd[sp] = e | 0;
            sp = sp + 1;
            pos = (flattest + 1) | 0;
            e = (flattest + 1 + (this.a[flattest] | 0)) | 0;
            break;
          }
          case T_START_GROUP: {
            const id = this.a[idx] | 0;
            if (id !== 0) this.insertGroupMode(id, PRINT_FLAT);
            break;
          }
          case T_START_COND:
            if ((this.b[idx] | 0) !== PRINT_FLAT) {
              const x = this.skipCondEnd(pos, e);
              if (x < 0) return PE_INVALID_DOCUMENT;
              pos = x;
            }
            break;
          case T_START_LINE_SUFFIX:
            return PE_INVALID_DOCUMENT;
          case E_CURSOR:
            this.noteMark(this.a[idx] | 0);
            break;
          default:
            break;
        }
      }
      if (sp === 0) break;
      sp = sp - 1;
      pos = this.rsAt[sp] | 0;
      e = this.rsEnd[sp] | 0;
    }
    this.hasEmptyLine = this.hasEmptyLine && this.lineWidth === 0;
    return 0;
  }

  // ───────────────────────────── best fitting ─────────────────────────────

  printBestFitting(first: number, count: number): number {
    const mode = this.mode;
    if (count < 1) return PE_INVALID_DOCUMENT;
    const mostExpanded = this.variants[first + count - 1] | 0;
    if (mode === PRINT_FLAT && this.measuredGroupFits) {
      return this.printVariant(count > 1 ? this.variants[first] | 0 : mostExpanded, mode);
    }
    this.measuredGroupFits = true;
    for (let k = 0; k < count - 1; k++) {
      const variant = this.variants[first + k] | 0;
      if ((this.tag[variant + 1] | 0) !== T_START_ENTRY) return PE_INVALID_DOCUMENT;
      const fits = this.variantFits(variant);
      if (fits < 0) return fits;
      if (fits === 1) return this.printVariant(variant, PRINT_FLAT);
    }
    return this.printVariant(mostExpanded, PRINT_EXPANDED);
  }

  printVariant(variant: number, mode: number): number {
    if (mode === PRINT_FLAT && this.canPrintFlat(this.b[variant] | 0)) {
      return this.printFlat(variant + 1, variant + 1 + (this.a[variant] | 0));
    }
    this.printNext(variant + 1, variant + 1 + (this.a[variant] | 0));
    return this.printEntry(mode);
  }

  /** Prints everything from the `T_START_ENTRY` that is next in the queue to its `T_END_ENTRY`, in `mode`. */
  printEntry(mode: number): number {
    if (!this.stack.enter()) return PE_NESTED_TOO_DEEPLY;
    let r = PE_INVALID_DOCUMENT;
    if (this.isAtStartEntry()) r = this.printElements(true, mode);
    this.stack.leave();
    return r;
  }

  // ───────────────────────────── fill ─────────────────────────────

  /**
   * Puts as many items of a fill on each line as fit.
   *
   * For each item, its separator and the next item:
   * - All three fit: the item and the separator are printed flat.
   * - The item fits, the separator or the next item does not: the item is printed flat and the separator expanded.
   * - The item does not fit: both are printed expanded.
   */
  printFillEntries(): number {
    const mode = this.mode;

    if (this.measuredGroupFits && mode === PRINT_FLAT) {
      this.pushFrame(FK_FILL, PRINT_FLAT);
      return 0;
    }

    this.pushFrame(FK_FILL, mode);

    while (this.isAtStartEntry()) {
      let r = this.measureFill(true);
      if (r === PE_MEASURE_AGAIN) r = this.measureFill(false);
      if (r < 0) return r;
      const flatPairs = this.fillPairs;
      const layout = this.fillLayout;

      let again = false;
      for (let k = 0; k < flatPairs; k++) {
        // A group in the item is measured again and may break. Then what has been measured from here on does not
        // hold. For oxfmt it holds all the same.
        const mayBreak = !this.measuredGroupFits && !this.oxfmt;
        r = this.printFillItem(PRINT_FLAT, PRINT_FLAT);
        if (r < 0) return r;
        r = this.printEntry(PRINT_FLAT);
        if (r < 0) return r;
        if (mayBreak) {
          again = true;
          break;
        }
      }
      if (again) continue;

      let itemMode = PRINT_EXPANDED;
      let separatorMode = PRINT_EXPANDED;
      if (layout === FPL_FLAT) {
        itemMode = PRINT_FLAT;
        separatorMode = PRINT_FLAT;
      } else if (layout === FPL_ITEM_FLAT_SEPARATOR_EXPANDED) {
        itemMode = PRINT_FLAT;
        separatorMode = PRINT_EXPANDED;
      }
      r = this.printFillItem(itemMode, separatorMode);
      if (r < 0) return r;

      if (this.isAtStartEntry()) {
        // A group in an expanded separator is measured with what follows it flat.
        this.pushFrame(FK_FILL, PRINT_FLAT);
        r = this.printEntry(separatorMode);
        if (r < 0) return r;
        r = this.popFrame(FK_FILL);
        if (r < 0) return r;
      }
    }

    const p = this.peek();
    return p >= 0 && (this.tag[p] | 0) === T_END_FILL ? 0 : PE_INVALID_DOCUMENT;
  }

  /** The number of pairs of an item and a separator that fit on the line (`fillPairs`), and how the pair after them is printed (`fillLayout`). */
  measureFill(usesFlat: boolean): number {
    this.newMeasure(usesFlat);
    this.mMustBeFlat = true;
    let flatPairs = 0;
    let r = this.fillEntryFits();
    if (r < 0) return r;
    if (r === 0) {
      this.fillPairs = 0;
      this.fillLayout = FPL_EXPANDED;
      return 0;
    }
    // Goes on to the first item or separator that does not fit, so that no item is measured twice.
    while (true) {
      if (!this.isMeasureAtStartEntry()) {
        this.fillPairs = flatPairs;
        this.fillLayout = FPL_FLAT;
        return 0;
      }
      r = this.fillEntryFits();
      if (r < 0) return r;
      if (r === 0) {
        this.fillPairs = flatPairs;
        this.fillLayout = FPL_ITEM_FLAT_SEPARATOR_EXPANDED;
        return 0;
      }
      if (!this.isMeasureAtStartEntry()) {
        this.fillPairs = flatPairs;
        this.fillLayout = FPL_FLAT;
        return 0;
      }
      r = this.fillEntryFits();
      if (r < 0) return r;
      if (r === 0) {
        this.fillPairs = flatPairs;
        this.fillLayout = FPL_ITEM_FLAT_SEPARATOR_EXPANDED;
        return 0;
      }
      flatPairs = flatPairs + 1;
    }
  }

  /** Prints an item of a fill. Meanwhile, whoever measures past its end finds the mode that has been decided for the separator after it on the stack. */
  printFillItem(mode: number, separatorMode: number): number {
    this.pushFrame(FK_FILL_SEPARATOR, separatorMode);
    const r = this.printEntry(mode);
    if (r < 0) return r;
    return this.popFrame(FK_FILL_SEPARATOR);
  }

  // ───────────────────────────── measuring ─────────────────────────────

  /** Starts where the printer is. */
  newMeasure(usesFlat: boolean): void {
    this.mqLen = 0;
    this.mfLen = 0;
    this.mLineWidth = this.lineWidth;
    this.mPendingIndent = this.pendingLevel * this.indentWidth + this.pendingAlign;
    this.mPendingSpace = this.pendingSpace;
    this.mIsSpaceElementPending = this.pendingSpace;
    this.mHasLineSuffix = this.lsLen > 0;
    this.mMustBeFlat = false;
    this.mUsesFlat = usesFlat;
    this.mHasPassedGroupIds = false;
    this.mePos = this.ePos;
    this.meEnd = this.eEnd;
    this.mQueueLen = this.qLen;
    this.mFramesLen = this.fLen;
    this.mMode = this.mode;
  }

  /**
   * Whether the group at `gi` (a `T_START_GROUP`, just taken from the queue) fits on the line with what follows it up to
   * the next possible line break. 1 yes, 0 no, or an error.
   */
  groupFits(gi: number): number {
    const gb = this.b[gi] | 0;
    const gend = this.c[gi] | 0;
    if (((gb >> 16) & FF_MEASURED) !== 0 && gend < this.eEnd) {
      this.newMeasure(true);
      if (this.flatFits(gb & 0xffff, (gb >> 16) & 0xff) === FITS_NO) return 0;
      this.measureMoveTo(gend + 1);
      const r = this.fits(false);
      if (r !== PE_MEASURE_AGAIN) return r;
      return this.groupFitsByElements(false);
    }
    const r = this.groupFitsByElements(true);
    if (r === PE_MEASURE_AGAIN) return this.groupFitsByElements(false);
    return r;
  }

  /** The same for an `E_INDENTED_LINE_GROUP`. */
  indentedLineGroupFits(): number {
    this.newMeasure(true);
    this.mPendingSpace = true;
    const r = this.fits(false);
    if (r !== PE_MEASURE_AGAIN) return r;
    this.newMeasure(false);
    this.mPendingSpace = true;
    return this.fits(false);
  }

  groupFitsByElements(usesFlat: boolean): number {
    this.newMeasure(usesFlat);
    this.measurePush(FK_GROUP, PRINT_FLAT);
    return this.fits(false);
  }

  /** Whether `variant` of an `E_BEST_FITTING` fits in place of it. */
  variantFits(variant: number): number {
    const flat = this.b[variant] | 0;
    if (((flat >> 16) & FF_MEASURED) !== 0) {
      this.newMeasure(true);
      if (this.flatFits(flat & 0xffff, (flat >> 16) & 0xff) === FITS_NO) return 0;
      const r = this.fits(false);
      if (r !== PE_MEASURE_AGAIN) return r;
      return this.variantFitsByElements(variant, false);
    }
    const r = this.variantFitsByElements(variant, true);
    if (r === PE_MEASURE_AGAIN) return this.variantFitsByElements(variant, false);
    return r;
  }

  variantFitsByElements(variant: number, usesFlat: boolean): number {
    this.newMeasure(usesFlat);
    this.mQueueLen = this.mQueueLen + 1;
    // Without the start tag: the frame for it has the mode.
    this.mePos = variant + 2;
    this.meEnd = variant + 1 + (this.a[variant] | 0);
    if (this.meEnd > this.poolLen) this.meEnd = this.mePos;
    this.measurePush(FK_ENTRY, PRINT_FLAT);
    return this.fits(false);
  }

  /** Whether the item or the separator of a fill that is next fits on the line. */
  fillEntryFits(): number {
    if (!this.isMeasureAtStartEntry()) return PE_INVALID_DOCUMENT;
    this.measurePush(FK_FILL, PRINT_FLAT);
    this.spDepth = 0;
    this.spDone = false;
    const r = this.fits(true);
    if (r < 0) return r;
    if (this.spDone) {
      const p = this.measurePop(FK_FILL);
      if (p < 0) return p;
    }
    return r;
  }

  isMeasureAtStartEntry(): boolean {
    let f = this.firstOf(this.mePos, this.meEnd);
    if (f < 0) {
      for (let i = this.mqLen - 1; i >= 0; i--) {
        f = this.firstOf(this.mqAt[i] | 0, this.mqEnd[i] | 0);
        if (f >= 0) break;
      }
    }
    if (f < 0) {
      for (let at = this.mQueueLen - 1; at >= 0; at--) {
        if (at < this.qLen) f = this.firstOf(this.queueAt[at] | 0, this.queueEnd[at] | 0);
        else f = this.firstOf(this.ePos, this.eEnd);
        if (f >= 0) break;
      }
    }
    return f >= 0 && (this.tag[f] | 0) === T_START_ENTRY;
  }

  measureMoveTo(index: number): void {
    if (index > this.mePos) this.mePos = index < this.meEnd ? index : this.meEnd;
  }

  /** The next element to measure, as an index, or -1. */
  measureNext(): number {
    while (true) {
      const p = this.mePos;
      if (p < this.meEnd) {
        this.mePos = p + 1;
        return p;
      }
      let at: number;
      let end: number;
      if (this.mqLen > 0) {
        this.mqLen = this.mqLen - 1;
        at = this.mqAt[this.mqLen] | 0;
        end = this.mqEnd[this.mqLen] | 0;
      } else {
        if (this.mQueueLen === 0) return -1;
        this.mQueueLen = this.mQueueLen - 1;
        if (this.mQueueLen < this.qLen) {
          at = this.queueAt[this.mQueueLen] | 0;
          end = this.queueEnd[this.mQueueLen] | 0;
        } else {
          at = this.ePos;
          end = this.eEnd;
        }
      }
      if (end > this.poolLen || at > end) end = at;
      this.mePos = at;
      this.meEnd = end;
    }
  }

  /** Measure puts the rest of its run on its queue and goes on with `[at, end)`. */
  measureContent(at: number, end: number): void {
    if (this.mePos < this.meEnd) {
      const n = this.mqLen;
      if (n === this.mqAt.length) this.growMq();
      this.mqAt[n] = this.mePos | 0;
      this.mqEnd[n] = this.meEnd | 0;
      this.mqLen = n + 1;
    }
    this.mePos = at;
    this.meEnd = end > this.poolLen || at > end ? at : end;
  }

  growMq(): void {
    const n = this.mqAt.length * 2;
    const a = new Int32Array(n);
    a.set(this.mqAt);
    this.mqAt = a;
    const e = new Int32Array(n);
    e.set(this.mqEnd);
    this.mqEnd = e;
  }

  measurePush(kind: number, mode: number): void {
    const n = this.mfLen;
    if (n === this.mfKind.length) {
      const k = new Uint8Array(n * 2);
      k.set(this.mfKind);
      this.mfKind = k;
      const m = new Uint8Array(n * 2);
      m.set(this.mfMode);
      this.mfMode = m;
    }
    this.mfKind[n] = kind | 0;
    this.mfMode[n] = mode | 0;
    this.mfLen = n + 1;
    this.mMode = mode;
  }

  /** Fails, and changes nothing, unless the innermost frame is of `kind`. */
  measurePop(kind: number): number {
    if (this.mfLen > 0) {
      if ((this.mfKind[this.mfLen - 1] | 0) !== kind) return PE_INVALID_DOCUMENT;
      this.mfLen = this.mfLen - 1;
    } else if (this.mFramesLen > 1 && (this.frameKind[this.mFramesLen - 1] | 0) === kind) {
      this.mFramesLen = this.mFramesLen - 1;
    } else {
      return PE_INVALID_DOCUMENT;
    }
    if (this.mfLen > 0) this.mMode = this.mfMode[this.mfLen - 1] | 0;
    else if (this.mFramesLen > 0 && this.mFramesLen - 1 < this.fLen) this.mMode = this.frameMode[this.mFramesLen - 1] | 0;
    else this.mMode = PRINT_EXPANDED;
    return 0;
  }

  /**
   * Whether what comes next fits on the line, up to the first line break, the end of the document, or where the
   * predicate (`single`: a single entry, else none) says. 1 yes, 0 no, or an error.
   */
  fits(single: boolean): number {
    while (true) {
      const idx = this.measureNext();
      if (idx < 0) break;
      const r = this.fitsElement(idx);
      if (r < 0) return r;
      if (r === FITS_YES) return 1;
      if (r === FITS_NO) return 0;
      if (single) {
        const e = this.singleEntryIsEnd(idx);
        if (e < 0) return e;
        if (e === 1) break;
      }
    }
    return 1;
  }

  /** `SingleEntryPredicate.is_end`: 1 if the entry is done, 0 if not, or an error. */
  singleEntryIsEnd(idx: number): number {
    if (this.spDone) return 1;
    const t = this.tag[idx] | 0;
    if (t === T_START_ENTRY) {
      this.spDepth = this.spDepth + 1;
    } else if (t === T_END_ENTRY) {
      if (this.spDepth === 0) return PE_INVALID_DOCUMENT;
      this.spDepth = this.spDepth - 1;
      this.spDone = this.spDepth === 0;
    } else if (t === E_INTERNED || t === E_SKIP || t === E_NOP || t === E_CURSOR) {
      // nothing
    } else if (this.spDepth === 0) {
      return PE_INVALID_DOCUMENT;
    }
    return this.spDone ? 1 : 0;
  }

  fitsElement(idx: number): number {
    const mode = this.mMode;
    const t = this.tag[idx] | 0;
    // A token with inline bytes: the kind says how long it is.
    if (t >= TOK_BASE) {
      if (t < TIB_BASE) return this.fitsText(t - TOK_BASE, false);
      if (mode !== PRINT_FLAT) return this.fitsText(t - TIB_BASE, false);
      return FITS_MAYBE;
    }
    switch (t) {
      case E_NOP:
      case E_CURSOR:
        break;
      case E_SKIP: {
        const p = this.mePos + (this.a[idx] | 0);
        this.mePos = p < this.meEnd ? p : this.meEnd;
        break;
      }
      case E_SPACE:
        if (this.mLineWidth > 0) {
          this.mPendingSpace = true;
          this.mIsSpaceElementPending = true;
        }
        break;
      case E_LINE:
      case T_START_INDENT_WITH_LINE:
      case T_END_INDENT_WITH_LINE: {
        const lm = this.a[idx] | 0;
        if (mode === PRINT_FLAT) {
          if (lm === LM_SOFT_OR_SPACE || lm === LM_SOFT_OR_SPACE_EMPTY) this.mPendingSpace = true;
          else if (lm === LM_HARD || lm === LM_EMPTY) {
            // The break is there in any mode, and everything up to it fits. In a fill, an item that has a comment on a
            // line of its own before it does not have to be alone on its line because of that. If the content is in a
            // group, the group is known to break and this is not asked.
            return FITS_YES;
          }
        } else {
          // This is past the end of what is measured, in content that is expanded.
          const width = this.mLineWidth + (this.mIsSpaceElementPending ? 1 : 0);
          return width > this.printWidth ? FITS_NO : FITS_YES;
        }
        break;
      }
      case E_INDENTED_LINE_GROUP:
        if (mode !== PRINT_FLAT) {
          const width = this.mLineWidth + (this.mIsSpaceElementPending ? 1 : 0);
          return width > this.printWidth ? FITS_NO : FITS_YES;
        }
        this.mPendingSpace = true;
        break;
      case E_TOKEN_IF_BREAKS:
        if (mode !== PRINT_FLAT) return this.fitsText(this.b[idx] | 0, false);
        break;
      case E_TOKEN:
        return this.fitsText(this.b[idx] | 0, false);
      case E_SOURCE_TEXT:
      case E_OWNED_TEXT:
        return this.fitsTextW(this.c[idx] | 0);
      case E_LINE_SUFFIX_BOUNDARY:
        if (this.mHasLineSuffix) return FITS_NO;
        break;
      case E_EXPAND_PARENT:
        if (this.mMustBeFlat) return FITS_NO;
        break;
      case E_BEST_FITTING: {
        const first = this.a[idx] | 0;
        const count = this.b[idx] | 0;
        if (count < 1) return PE_INVALID_DOCUMENT;
        const variant = mode === PRINT_FLAT ? this.variants[first] | 0 : this.variants[first + count - 1] | 0;
        this.measureContent(variant + 1, variant + 1 + (this.a[variant] | 0));
        break;
      }
      case E_INTERNED: {
        const h = this.a[idx] | 0;
        this.measureContent(h + 1, h + 1 + (this.a[h] | 0));
        break;
      }
      case T_START_GROUP: {
        const gb = this.b[idx] | 0;
        const gflat = ((gb >> 24) & 3) === GM_FLAT;
        if (this.mMustBeFlat && !gflat) return FITS_NO;
        const groupMode = gflat ? mode : PRINT_EXPANDED;
        const gend = this.c[idx] | 0;
        if (this.mUsesFlat && groupMode === PRINT_FLAT && ((gb >> 16) & FF_MEASURED) !== 0 && gend < this.meEnd) {
          this.measureMoveTo(gend + 1);
          return this.flatFits(gb & 0xffff, (gb >> 16) & 0xff);
        }
        this.measurePush(FK_GROUP, groupMode);
        break;
      }
      case T_END_GROUP: {
        const r = this.measurePop(FK_GROUP);
        if (r < 0) return r;
        break;
      }
      case T_START_COND: {
        const gid = this.a[idx] | 0;
        let groupMode = mode;
        if (gid !== 0) {
          if (this.mHasPassedGroupIds) return PE_MEASURE_AGAIN;
          // As in Prettier, it is the mode that the group has been printed in. One that has only been measured counts as
          // being on one line.
          const gm = this.groupMode(gid);
          groupMode = gm < 0 ? PRINT_FLAT : gm;
        }
        if (groupMode !== (this.b[idx] | 0)) {
          const e = this.skipCondEnd(this.mePos, this.meEnd);
          if (e < 0) return PE_INVALID_DOCUMENT;
          this.mePos = e;
        }
        break;
      }
      case T_START_LINE_SUFFIX: {
        const e = this.lineSuffixEnd(this.mePos, this.meEnd);
        if (e < 0) return PE_INVALID_DOCUMENT;
        this.mePos = e + 1;
        this.mHasLineSuffix = true;
        break;
      }
      // Of a line suffix that is being printed.
      case T_END_LINE_SUFFIX: {
        const r = this.measurePop(FK_LINE_SUFFIX);
        if (r < 0) return r;
        break;
      }
      case T_START_FILL:
        this.measurePush(FK_FILL, mode);
        break;
      case T_START_ENTRY:
        // After an item that is being printed, `mode` is that of the separator.
        this.measurePop(FK_FILL_SEPARATOR);
        this.measurePush(FK_ENTRY, mode);
        break;
      case T_END_ENTRY: {
        const r = this.measurePop(FK_ENTRY);
        if (r < 0) return r;
        break;
      }
      case T_END_FILL: {
        this.measurePop(FK_FILL_SEPARATOR);
        const r = this.measurePop(FK_FILL);
        if (r < 0) return r;
        break;
      }
      // Where the next line starts does not matter: measuring ends there.
      default:
        break;
    }
    return FITS_MAYBE;
  }

  /** A token or a text of the given width (packed width for texts). */
  fitsText(width: number, isMultiline: boolean): number {
    // To Prettier, a text that is empty is not there.
    if (width === 0 && !isMultiline) return FITS_MAYBE;
    this.mLineWidth = this.mLineWidth + this.mPendingIndent + (this.mPendingSpace ? 1 : 0) + width;
    this.mPendingIndent = 0;
    if (this.mLineWidth > this.printWidth) return FITS_NO;
    this.mPendingSpace = false;
    this.mIsSpaceElementPending = false;
    return FITS_MAYBE;
  }

  fitsTextW(w: number): number {
    // To Prettier, a text that is empty is not there: `width == TextWidth::single(0)`.
    if (w === 0) return FITS_MAYBE;
    const value = w & TW_VALUE_MASK;
    this.mLineWidth = this.mLineWidth + this.mPendingIndent + (this.mPendingSpace ? 1 : 0) + value;
    this.mPendingIndent = 0;
    // The line break is there in any mode. What counts is what is before it.
    if (w < 0 && (w & TW_ONE_STRING) === 0) {
      return this.mLineWidth > this.printWidth ? FITS_NO : FITS_YES;
    }
    if (this.mLineWidth > this.printWidth) return FITS_NO;
    this.mPendingSpace = false;
    this.mIsSpaceElementPending = false;
    return FITS_MAYBE;
  }

  /** The same for content that is measured, in flat mode. */
  flatFits(width: number, flags: number): number {
    if ((flags & FF_HAS_LINE_SUFFIX_BOUNDARY) !== 0 && this.mHasLineSuffix) return FITS_NO;
    if ((flags & FF_HAS_GROUP_IDS) !== 0) this.mHasPassedGroupIds = true;
    const startsWithSpace = (flags & FF_STARTS_WITH_SPACE) !== 0 && this.mLineWidth > 0;
    if (startsWithSpace || (flags & FF_STARTS_WITH_LINE) !== 0) this.mPendingSpace = true;
    if (startsWithSpace) this.mIsSpaceElementPending = true;
    if (width === 0) return FITS_MAYBE;
    this.mLineWidth = this.mLineWidth + this.mPendingIndent + (this.mPendingSpace ? 1 : 0) + width;
    this.mPendingIndent = 0;
    if (this.mLineWidth > this.printWidth) return FITS_NO;
    this.mPendingSpace = (flags & FF_ENDS_WITH_SPACE) !== 0;
    this.mIsSpaceElementPending = (flags & FF_ENDS_WITH_SPACE_ELEMENT) !== 0;
    return FITS_MAYBE;
  }
}

// One printer per thread, which keeps its arrays from one file to the next.
const printer = new Printer();

/** The printer of this thread. After `printDocument`, `marks()` say where the cursor marks were in what was printed. */
export function getPrinter(): Printer {
  return printer;
}

/**
 * Appends the text of the document `[rootStart, rootEnd)` of `st` to `out`. `source` is what `E_SOURCE_TEXT` is a range
 * of. Returns 0 or a `PE_*` error.
 */
export function printDocument(st: Storage, rootStart: number, rootEnd: number, source: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  return printer.print(st, rootStart, rootEnd, source, options, resolveLineEnding(options.lineEnding, source), options.isInMarkdown, out);
}

/** The same with the line ending decided by the caller (`LINE_ENDING_LF`, `_CRLF` or `_CR`; JSON takes it from its text). */
export function printDocumentWithLineEnding(st: Storage, rootStart: number, rootEnd: number, source: Uint8Array, options: FormatOptions, lineEnding: number, out: ByteBuf): number {
  return printer.print(st, rootStart, rootEnd, source, options, lineEnding, options.isInMarkdown, out);
}

/**
 * Rust `Formatter::print_to_text`: the text that the captured content `handle` is printed as by itself, at the start of
 * a line without indentation, where a line break is `\n` whatever the file gets. For the rare case that how something is
 * laid out depends on the text of its parts. The result is appended to `out`; returns 0 or a `PE_*` error (then `out`
 * is left as it was).
 */
export function printCaptureToText(st: Storage, handle: number, source: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  if (handle < 0) return 0;
  const start = out.len;
  // It is written to the document again, where a line break is `\n` whatever the file gets, and where the printer
  // marks the line breaks of texts for Markdown. Prettier: `printDocToString(.., { endOfLine: "lf" })`.
  const saved = printer.stack;
  const r = printer.print(st, handle + 1, handle + 1 + (st.a[handle] | 0), source, options, 0, false, out);
  printer.stack = saved;
  if (r < 0) out.len = start;
  return r;
}
