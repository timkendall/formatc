// Port of vendor/bun/src/format/ir/document.rs: what the printer has to know about a document before it prints it:
// which groups have a forced line break in them, and how wide the others are on one line.
//
// A `Tracker` finds that out from the elements in the order they are written. The `Formatter` tells it about each
// element as it writes it, so that there is nothing left to do when the document is finished. `propagateExpand` does
// the same for a document that has been written without a `Formatter` (straight into a `Storage`).
//
// State machine, as in Rust: `s*` fields are `State`, the `f*` arrays are the stack of `Frame`s, `saved` is the
// stack of `State`s saved for frames whose content is apart from what encloses it (12 ints per entry).
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
  FF_EXPANDS,
  FF_HAS_GROUP_IDS,
  FF_HAS_LINE_SUFFIX_BOUNDARY,
  FF_MEASURED,
  FF_STARTS_WITH_LINE,
  FF_STARTS_WITH_SPACE,
  GM_EXPAND,
  GM_FLAT,
  GM_PROPAGATED,
  LM_EMPTY,
  LM_HARD,
  LM_SOFT_EMPTY,
  LM_SOFT,
  LM_SOFT_OR_SPACE,
  LM_SOFT_OR_SPACE_EMPTY,
  PRINT_EXPANDED,
  T_END_COND,
  T_END_GROUP,
  T_END_INDENT_WITH_LINE,
  T_END_LINE_SUFFIX,
  T_START_COND,
  T_START_GROUP,
  T_START_INDENT_WITH_LINE,
  T_START_LINE_SUFFIX,
  TIB_BASE,
  TOK_BASE,
  TW_ONE_STRING,
  TW_VALUE_MASK,
  flatPack,
} from "./element.ts";
import { Storage } from "./storage.ts";
import { I32Vec } from "../../base/i32vec.ts";

// FrameKind
const FK_GROUP = 0;
/** The place of a start tag that may become one of a group. See `Formatter.reserveTag`. */
const FK_RESERVED = 1;
/** What an `E_SKIP` skips. */
const FK_SKIPPED = 2;
/** Content that is written if the enclosing group is flat. */
const FK_IF_FLAT = 3;
/** Content that is not there when what encloses it is flat. */
const FK_IF_EXPANDED = 4;
/** Content of which only the printer knows whether it is there, or where. */
const FK_UNKNOWN = 5;

const NO_TEXT = -1;
const STATE_SIZE = 12;

export class Tracker {
  st: Storage;

  // State: what has been seen so far of everything on one line. The fields that are an index say where something has
  // last been seen: it is in a frame if that is after the start of the frame. Index 0 is not part of any document.
  /** The columns of all texts, and of the spaces between them. It wraps around. */
  sWidth: number;
  /** A space is written before the next text. */
  sSpacePending: number;
  /** There has been an `E_SPACE` since the last text. */
  sSpaceElementPending: number;
  sInLineSuffix: number;
  /** The frames from here on have no text yet. */
  sWithoutText: number;
  /** What forces the enclosing groups to break. */
  sLastBreak: number;
  /** What `willBreak` is true for. */
  sLastWillBreak: number;
  /** What keeps the enclosing groups from being measured. */
  sLastUnknown: number;
  sLastBoundary: number;
  sLastLine: number;
  sLastSpace: number;
  sLastGroupId: number;

  // Frames
  fKind: Uint8Array;
  /** FF_STARTS_WITH_LINE | FF_STARTS_WITH_SPACE */
  fStartFlags: Uint8Array;
  /** The index of its first element: the start tag or the `E_SKIP`. */
  fStart: Int32Array;
  /** `sWidth` at the start of the first text in it. NO_TEXT as long as there is none. */
  fFirstText: Int32Array;
  nFrames: number;

  /** The state before each frame whose content is apart from what encloses it. */
  saved: Int32Array;
  nSaved: number;

  // Results of `closeFrame`, `flatOfFrame`, `endSkipped` (no allocation: module-style out slots).
  closedKind: number;
  closedStart: number;
  closedFirstText: number;
  closedStartFlags: number;
  /** A `flatPack`ed Flat. */
  outFlat: number;
  outStart: number;
  outWillBreak: number;

  constructor(st: Storage) {
    this.st = st;
    this.sWidth = 0;
    this.sSpacePending = 0;
    this.sSpaceElementPending = 0;
    this.sInLineSuffix = 0;
    this.sWithoutText = 0;
    this.sLastBreak = 0;
    this.sLastWillBreak = 0;
    this.sLastUnknown = 0;
    this.sLastBoundary = 0;
    this.sLastLine = 0;
    this.sLastSpace = 0;
    this.sLastGroupId = 0;
    this.fKind = new Uint8Array(64);
    this.fStartFlags = new Uint8Array(64);
    this.fStart = new Int32Array(64);
    this.fFirstText = new Int32Array(64);
    this.nFrames = 0;
    this.saved = new Int32Array(STATE_SIZE * 16);
    this.nSaved = 0;
    this.closedKind = 0;
    this.closedStart = 0;
    this.closedFirstText = 0;
    this.closedStartFlags = 0;
    this.outFlat = 0;
    this.outStart = 0;
    this.outWillBreak = 0;
  }

  clear(): void {
    this.resetState();
    this.nFrames = 0;
    this.nSaved = 0;
  }

  resetState(): void {
    this.sWidth = 0;
    this.sSpacePending = 0;
    this.sSpaceElementPending = 0;
    this.sInLineSuffix = 0;
    this.sWithoutText = 0;
    this.sLastBreak = 0;
    this.sLastWillBreak = 0;
    this.sLastUnknown = 0;
    this.sLastBoundary = 0;
    this.sLastLine = 0;
    this.sLastSpace = 0;
    this.sLastGroupId = 0;
  }

  /** `element` has been written at `index`. It is not an `E_SKIP`. */
  note(t: number, a: number, b: number, c: number, index: number): void {
    // A token with inline bytes: the kind says how long it is. One that is only written if the group breaks is nothing.
    if (t >= TOK_BASE) {
      if (t < TIB_BASE) this.text(t - TOK_BASE, index);
      return;
    }
    switch (t) {
      case E_TOKEN:
        this.text(b, index);
        return;
      case E_SOURCE_TEXT:
      case E_OWNED_TEXT:
        // multiline and not one string
        if (c < 0 && (c & TW_ONE_STRING) === 0) this.forcedBreak(index);
        this.text(c & TW_VALUE_MASK, index);
        return;
      case E_SPACE:
        this.sLastSpace = index;
        this.sSpacePending = 1;
        this.sSpaceElementPending = 1;
        return;
      // It is not there when what encloses it is flat.
      case E_TOKEN_IF_BREAKS:
      case E_NOP:
      case E_CURSOR:
        return;
      case E_LINE:
        this.line(a, index);
        return;
      case E_INDENTED_LINE_GROUP:
        this.line(LM_SOFT_OR_SPACE, index);
        this.sLastGroupId = index;
        return;
      case E_EXPAND_PARENT:
        this.forcedBreak(index);
        return;
      case E_LINE_SUFFIX_BOUNDARY:
        this.sLastBoundary = index;
        return;
      case E_SKIP:
        this.sLastUnknown = index;
        return;
      case E_INTERNED:
        this.interned(a, index);
        return;
      case E_BEST_FITTING:
        this.bestFitting(a, index);
        return;
      case T_START_GROUP:
        if (((b >> 24) & 3) === GM_EXPAND && this.sInLineSuffix === 0) this.sLastWillBreak = index;
        this.open(FK_GROUP, index);
        return;
      case T_END_GROUP:
        this.endGroup(index);
        return;
      case T_START_COND:
        if (a !== 0) this.openApart(FK_UNKNOWN, index);
        else if (b === PRINT_EXPANDED) this.openApart(FK_IF_EXPANDED, index);
        else this.open(FK_IF_FLAT, index);
        return;
      case T_START_LINE_SUFFIX:
        this.openApart(FK_UNKNOWN, index);
        this.sInLineSuffix = 1;
        return;
      case T_END_COND:
      case T_END_LINE_SUFFIX:
        this.endContent(index);
        return;
      case T_START_INDENT_WITH_LINE:
      case T_END_INDENT_WITH_LINE:
        this.line(a, index);
        return;
      // These change where a line starts, or nothing at all.
      default:
        return;
    }
  }

  /** An `E_SPACE` has been written at `index`. */
  space(index: number): void {
    this.sLastSpace = index;
    this.sSpacePending = 1;
    this.sSpaceElementPending = 1;
  }

  /** Whether `willBreak` is true for what has been written from `start` on. `start` is in the skipped content that is being written. */
  willBreakFrom(start: number): boolean {
    return this.sLastWillBreak >= start;
  }

  line(mode: number, index: number): void {
    if (mode === LM_SOFT || mode === LM_SOFT_EMPTY) return;
    if (mode === LM_SOFT_OR_SPACE || mode === LM_SOFT_OR_SPACE_EMPTY) {
      this.sLastLine = index;
      this.sSpacePending = 1;
      return;
    }
    // Hard, Empty
    this.sLastBreak = index;
    this.sLastWillBreak = index;
  }

  /** Something other than a line break that forces the enclosing groups to break. */
  forcedBreak(index: number): void {
    this.sLastBreak = index;
    if (this.sInLineSuffix === 0) this.sLastWillBreak = index;
  }

  open(kind: number, start: number): void {
    const n = this.nFrames;
    if (n === this.fKind.length) this.growFrames();
    this.fKind[n] = kind | 0;
    this.fStartFlags[n] = 0;
    this.fStart[n] = start | 0;
    this.fFirstText[n] = NO_TEXT;
    this.nFrames = n + 1;
  }

  growFrames(): void {
    const cap = this.fKind.length * 2;
    const k = new Uint8Array(cap);
    k.set(this.fKind);
    this.fKind = k;
    const sf = new Uint8Array(cap);
    sf.set(this.fStartFlags);
    this.fStartFlags = sf;
    const s = new Int32Array(cap);
    s.set(this.fStart);
    this.fStart = s;
    const ft = new Int32Array(cap);
    ft.set(this.fFirstText);
    this.fFirstText = ft;
  }

  pushSaved(): void {
    const base = this.nSaved * STATE_SIZE;
    if (base + STATE_SIZE > this.saved.length) {
      const ns = new Int32Array(this.saved.length * 2);
      ns.set(this.saved);
      this.saved = ns;
    }
    const s = this.saved;
    s[base] = this.sWidth | 0;
    s[base + 1] = this.sSpacePending | 0;
    s[base + 2] = this.sSpaceElementPending | 0;
    s[base + 3] = this.sInLineSuffix | 0;
    s[base + 4] = this.sWithoutText | 0;
    s[base + 5] = this.sLastBreak | 0;
    s[base + 6] = this.sLastWillBreak | 0;
    s[base + 7] = this.sLastUnknown | 0;
    s[base + 8] = this.sLastBoundary | 0;
    s[base + 9] = this.sLastLine | 0;
    s[base + 10] = this.sLastSpace | 0;
    s[base + 11] = this.sLastGroupId | 0;
    this.nSaved = this.nSaved + 1;
  }

  /** Restores the state saved last, except `lastBreak` and `lastWillBreak` when `keepBreaks`. */
  popSaved(keepBreaks: boolean): void {
    const base = (this.nSaved - 1) * STATE_SIZE;
    const s = this.saved;
    this.sWidth = s[base] | 0;
    this.sSpacePending = s[base + 1] | 0;
    this.sSpaceElementPending = s[base + 2] | 0;
    this.sInLineSuffix = s[base + 3] | 0;
    this.sWithoutText = s[base + 4] | 0;
    if (!keepBreaks) {
      this.sLastBreak = s[base + 5] | 0;
      this.sLastWillBreak = s[base + 6] | 0;
    }
    this.sLastUnknown = s[base + 7] | 0;
    this.sLastBoundary = s[base + 8] | 0;
    this.sLastLine = s[base + 9] | 0;
    this.sLastSpace = s[base + 10] | 0;
    this.sLastGroupId = s[base + 11] | 0;
    this.nSaved = this.nSaved - 1;
  }

  /** Opens a frame whose content is not part of what encloses it when that is on one line. */
  openApart(kind: number, start: number): void {
    this.pushSaved();
    this.open(kind, start);
    this.sWithoutText = this.nFrames - 1;
  }

  /**
   * Removes the innermost frame if it is of one of the kinds. Places that have been reserved in it and not been used are
   * forgotten. Returns whether a frame was removed; it is in `closed*`.
   */
  closeFrame(k1: number, k2: number, k3: number): boolean {
    while (this.nFrames > 0 && (this.fKind[this.nFrames - 1] | 0) === FK_RESERVED) this.nFrames = this.nFrames - 1;
    const n = this.nFrames;
    if (n === 0) return false;
    const kind = this.fKind[n - 1] | 0;
    if (kind !== k1 && kind !== k2 && kind !== k3) return false;
    this.closedKind = kind;
    this.closedStart = this.fStart[n - 1] | 0;
    this.closedFirstText = this.fFirstText[n - 1] | 0;
    this.closedStartFlags = this.fStartFlags[n - 1] | 0;
    this.nFrames = n - 1;
    if (this.sWithoutText > this.nFrames) this.sWithoutText = this.nFrames;
    return true;
  }

  /** The place of a start tag has been reserved at `index`. */
  reserve(index: number): void {
    this.open(FK_RESERVED, index);
  }

  /** The place that has been reserved at `start` has become the start tag of a group. */
  useReserved(start: number, mode: number): void {
    while (this.nFrames > 0 && (this.fKind[this.nFrames - 1] | 0) === FK_RESERVED && (this.fStart[this.nFrames - 1] | 0) > start) {
      this.nFrames = this.nFrames - 1;
    }
    if (this.sWithoutText > this.nFrames) this.sWithoutText = this.nFrames;
    const n = this.nFrames;
    if (n > 0 && (this.fKind[n - 1] | 0) === FK_RESERVED && (this.fStart[n - 1] | 0) === start) {
      this.fKind[n - 1] = FK_GROUP;
    }
    if (mode === GM_EXPAND && this.sInLineSuffix === 0) {
      if (start > this.sLastWillBreak) this.sLastWillBreak = start;
    }
  }

  endGroup(index: number): void {
    if (!this.closeFrame(FK_GROUP, FK_GROUP, FK_GROUP)) return;
    const start = this.closedStart;
    const st = this.st;
    if ((st.tag[start] | 0) !== T_START_GROUP) return;
    let b = st.b[start] | 0;
    let mode = (b >> 24) & 3;
    if (this.sLastBreak > start) {
      if (mode === GM_FLAT) mode = GM_PROPAGATED;
    }
    if (mode === GM_FLAT) {
      this.flatOfFrame(start, this.closedFirstText, this.closedStartFlags);
      b = (this.outFlat & 0x00ffffff) | (mode << 24);
    } else {
      b = mode << 24;
      this.sLastBreak = index;
    }
    st.b[start] = b | 0;
    st.c[start] = index | 0;
    if ((st.a[start] | 0) !== 0) this.sLastGroupId = index;
  }

  /** The end of conditional content or of a line suffix. */
  endContent(index: number): void {
    if (!this.closeFrame(FK_IF_FLAT, FK_IF_EXPANDED, FK_UNKNOWN)) return;
    const kind = this.closedKind;
    if (kind === FK_IF_EXPANDED || kind === FK_UNKNOWN) {
      if (this.nSaved > 0) {
        // A forced line break in it counts for what encloses it.
        this.popSaved(true);
        if (kind === FK_UNKNOWN) this.sLastUnknown = index;
      }
    }
  }

  /** An `E_SKIP` has been written at `index`. What follows is what it skips. */
  startSkipped(index: number): void {
    this.openApart(FK_SKIPPED, index);
    this.sInLineSuffix = 0;
  }

  /**
   * The end of what an `E_SKIP` skips. Returns whether there was one; then `outStart` is where it is, `outFlat` what the
   * content is on one line, and `outWillBreak` whether `willBreak` is true for it.
   */
  endSkipped(): boolean {
    let isBalanced = true;
    while (this.nFrames > 0 && (this.fKind[this.nFrames - 1] | 0) !== FK_SKIPPED) {
      // A start tag without its end tag, unless it is a place that has been reserved.
      this.nFrames = this.nFrames - 1;
      const kind = this.fKind[this.nFrames] | 0;
      if (kind === FK_IF_EXPANDED || kind === FK_UNKNOWN) {
        if (this.nSaved > 0) this.nSaved = this.nSaved - 1;
        isBalanced = false;
      } else if (kind === FK_RESERVED) {
        // nothing
      } else {
        isBalanced = false;
      }
    }
    if (!this.closeFrame(FK_SKIPPED, FK_SKIPPED, FK_SKIPPED)) return false;
    const start = this.closedStart;
    let flat = 0;
    if (this.sLastBreak > start) flat = flatPack(0, FF_EXPANDS);
    else if (isBalanced) {
      this.flatOfFrame(start, this.closedFirstText, this.closedStartFlags);
      flat = this.outFlat;
    }
    const willBreak = this.sLastWillBreak > start ? 1 : 0;
    if (this.nSaved === 0) return false;
    this.popSaved(false);
    this.outStart = start;
    this.outFlat = flat;
    this.outWillBreak = willBreak;
    return true;
  }

  /** A text of `width` columns at `index`. */
  text(width: number, index: number): void {
    // Whether a space after it counts depends on whether the line is empty before it.
    if (width === 0) this.sLastUnknown = index;
    const start = (this.sWidth + this.sSpacePending) | 0;
    if (this.sWithoutText < this.nFrames) this.firstText(start);
    this.sWidth = (start + width) | 0;
    this.sSpacePending = 0;
    this.sSpaceElementPending = 0;
  }

  /** A text starts at the width `start`, and it is the first of some frames. */
  firstText(start: number): void {
    const n = this.nFrames;
    let i = this.sWithoutText;
    while (i < n) {
      const fs = this.fStart[i] | 0;
      this.fFirstText[i] = start | 0;
      this.fStartFlags[i] = (this.sLastLine > fs ? FF_STARTS_WITH_LINE : 0) | (this.sLastSpace > fs ? FF_STARTS_WITH_SPACE : 0);
      i = i + 1;
    }
    this.sWithoutText = n;
  }

  interned(handle: number, index: number): void {
    const st = this.st;
    const flat = st.b[handle] | 0;
    const willBreak = (st.c[handle] | 0) !== 0;
    if (((flat >> 16) & FF_EXPANDS) !== 0) this.sLastBreak = index;
    if (willBreak && this.sInLineSuffix === 0) this.sLastWillBreak = index;
    this.content(flat, index);
  }

  /** On one line it is its flattest variant, which is at `first`. */
  bestFitting(first: number, index: number): void {
    const vs = this.st.variants;
    if (first >= vs.len) {
      this.sLastUnknown = index;
      return;
    }
    const flattest = vs.data[first] | 0;
    const flat = this.st.b[flattest] | 0;
    const willBreak = (this.st.c[flattest] | 0) !== 0;
    if (willBreak && this.sInLineSuffix === 0) this.sLastWillBreak = index;
    this.content(flat, index);
  }

  /** Content that has been measured (`flat`, packed) is written at `index`. */
  content(flat: number, index: number): void {
    const flags = (flat >> 16) & 0xff;
    if ((flags & FF_MEASURED) === 0) {
      this.sLastUnknown = index;
      return;
    }
    if ((flags & FF_HAS_LINE_SUFFIX_BOUNDARY) !== 0) this.sLastBoundary = index;
    if ((flags & FF_HAS_GROUP_IDS) !== 0) this.sLastGroupId = index;
    if ((flags & FF_STARTS_WITH_LINE) !== 0) {
      this.sLastLine = index;
      this.sSpacePending = 1;
    }
    if ((flags & FF_STARTS_WITH_SPACE) !== 0) {
      this.sLastSpace = index;
      this.sSpacePending = 1;
      this.sSpaceElementPending = 1;
    }
    const width = flat & 0xffff;
    if (width > 0) {
      this.text(width, index);
      this.sSpacePending = (flags & FF_ENDS_WITH_SPACE) !== 0 ? 1 : 0;
      this.sSpaceElementPending = (flags & FF_ENDS_WITH_SPACE_ELEMENT) !== 0 ? 1 : 0;
    }
  }

  /** What is in a frame (start, firstText, startFlags), which ends here. Sets `outFlat`. */
  flatOfFrame(start: number, firstText: number, startFlags: number): void {
    if (this.sLastUnknown > start) {
      this.outFlat = 0;
      return;
    }
    let flags = FF_MEASURED;
    if (this.sLastBoundary > start) flags = flags | FF_HAS_LINE_SUFFIX_BOUNDARY;
    if (this.sLastGroupId > start) flags = flags | FF_HAS_GROUP_IDS;
    if (firstText === NO_TEXT) {
      if (this.sLastLine > start) flags = flags | FF_STARTS_WITH_LINE;
      if (this.sLastSpace > start) flags = flags | FF_STARTS_WITH_SPACE;
      this.outFlat = flatPack(0, flags);
      return;
    }
    const w = (this.sWidth - firstText) | 0;
    if (w < 0 || w > 65535) {
      this.outFlat = 0;
      return;
    }
    flags = flags | startFlags;
    if (this.sSpacePending !== 0) flags = flags | FF_ENDS_WITH_SPACE;
    if (this.sSpaceElementPending !== 0) flags = flags | FF_ENDS_WITH_SPACE_ELEMENT;
    this.outFlat = flatPack(w, flags);
  }
}

let ends = new I32Vec(16);

/**
 * Prettier's `propagateBreaks`: marks every group that has a hard line break, a text with a line break or an
 * `E_EXPAND_PARENT` in it as expanded. The variants of an `E_BEST_FITTING` do not make what encloses them expand.
 *
 * It also measures the groups that are left, and interned content: see `Flat`.
 *
 * This is one loop over the elements `[rootStart, rootEnd)` of the pool of `tracker.st`. Interned content comes before
 * every element that stands for it, so what there is to know about it is in its `E_SKIP` by then.
 */
export function propagateExpand(rootStart: number, rootEnd: number, tracker: Tracker): void {
  tracker.clear();
  const st = tracker.st;
  ends.reset();
  let end = rootEnd < st.len ? rootEnd : st.len;
  let index = rootStart;
  while (true) {
    while (index < end) {
      const t = st.tag[index] | 0;
      if (t === E_SKIP) {
        tracker.startSkipped(index);
        ends.push(end);
        const e = index + (st.a[index] | 0) + 1;
        end = e < end ? e : end;
      } else {
        tracker.note(t, st.a[index] | 0, st.b[index] | 0, st.c[index] | 0, index);
      }
      index = index + 1;
    }
    if (ends.len === 0) return;
    end = ends.pop();
    if (tracker.endSkipped()) {
      const start = tracker.outStart;
      if ((st.tag[start] | 0) === E_SKIP) {
        st.b[start] = tracker.outFlat | 0;
        st.c[start] = tracker.outWillBreak | 0;
      }
    }
  }
}
