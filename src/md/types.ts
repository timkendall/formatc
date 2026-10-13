import type { Parser } from "./state.ts";

// Port of vendor/bun/src/md/types.rs.
//
// Rust enums without data are integer constants (see docs/ARCHITECTURE.md). Positions (`OFF`) are byte offsets into the
// `Uint8Array` that is parsed; `OFF_MAX` (Rust: `u32::MAX`) is -1.

export const EMPTY = new Uint8Array(0);

/** `OFF::MAX` of Rust: "none" / "end of the document" in `containerSource`. */
export const OFF_MAX = -1;

// ---- BlockType ----
export const BT_DOC = 0;
export const BT_QUOTE = 1;
export const BT_UL = 2;
export const BT_OL = 3;
export const BT_LI = 4;
export const BT_HR = 5;
export const BT_H = 6;
export const BT_CODE = 7;
export const BT_HTML = 8;
export const BT_P = 9;
export const BT_TABLE = 10;
export const BT_THEAD = 11;
export const BT_TBODY = 12;
export const BT_TR = 13;
export const BT_TH = 14;
export const BT_TD = 15;

// ---- SpanType ----
export const SP_EM = 0;
export const SP_STRONG = 1;
export const SP_A = 2;
export const SP_IMG = 3;
export const SP_CODE = 4;
export const SP_DEL = 5;
export const SP_LATEXMATH = 6;
export const SP_LATEXMATH_DISPLAY = 7;
export const SP_WIKILINK = 8;
export const SP_U = 9;

// ---- TextType ----
export const TX_NORMAL = 0;
export const TX_NULLCHAR = 1;
export const TX_BR = 2;
export const TX_SOFTBR = 3;
export const TX_ENTITY = 4;
export const TX_CODE = 5;
export const TX_HTML = 6;
export const TX_LATEXMATH = 7;

// ---- Align ----
export const AL_DEFAULT = 0;
export const AL_LEFT = 1;
export const AL_CENTER = 2;
export const AL_RIGHT = 3;

// ---- Reference: how a link or an image says where it goes ----
/** `[text](href)`, or an autolink. */
export const REF_NONE = 0;
/** `[text][label]` */
export const REF_FULL = 1;
/** `[label][]` */
export const REF_COLLAPSED = 2;
/** `[label]` */
export const REF_SHORTCUT = 3;
/** `[^label]`, with `Options.footnotes`. `href` is the label. */
export const REF_FOOTNOTE = 4;

// ---- LineType (internal) ----
export const L_BLANK = 0;
export const L_HR = 1;
export const L_ATXHEADER = 2;
export const L_SETEXTUNDERLINE = 3;
export const L_INDENTEDCODE = 4;
export const L_FENCEDCODE = 5;
export const L_HTML = 6;
export const L_TEXT = 7;
export const L_TABLE = 8;
export const L_TABLEUNDERLINE = 9;

// ---- Block flags ----
export const BLOCK_CONTAINER_CLOSER = 0x01;
export const BLOCK_CONTAINER_OPENER = 0x02;
export const BLOCK_LOOSE_LIST = 0x04;
export const BLOCK_SETEXT_HEADER = 0x08;
export const BLOCK_FENCED_CODE = 0x10;
export const BLOCK_REF_DEF_ONLY = 0x20;
/** Fenced code with its closing fence, HTML with what ends it. */
export const BLOCK_CLOSED = 0x40;
/** HTML that only a certain text ends (`-->`, `</script>` ..), not an empty line. */
export const BLOCK_HTML_UNTIL_TEXT = 0x80;
/** Reported as `BT_HTML`: a leaf block of the consumer's own. See `Extensions`. */
export const BLOCK_EXTENSION = 0x100;
/** Reported as `BT_QUOTE`: the definition of a footnote, `[^label]:`. */
export const BLOCK_FOOTNOTE = 0x200;
/** Reported as `BT_QUOTE`: what is between `:::name` and `:::`. */
export const BLOCK_DIRECTIVE = 0x400;

export const TABLE_MAXCOLCOUNT = 128;

/** Detail data for span events (links, images, wikilinks). One instance is reused for every event: read it inside `enterSpan`. */
export class SpanDetail {
  /** `href`: bytes `hrefBuf[hrefStart, hrefEnd)`. */
  hrefBuf: Uint8Array = EMPTY;
  hrefStart = 0;
  hrefEnd = 0;
  titleBuf: Uint8Array = EMPTY;
  titleStart = 0;
  titleEnd = 0;
  /** Standard autolink (angle-bracket): use writeUrlEscaped (no entity/escape processing) */
  autolink = false;
  /** Standard autolink is an email: prepend "mailto:" to href */
  autolinkEmail = false;
  /** Permissive autolink: use HTML-escaping for href (not URL-escaping) */
  permissiveAutolink = false;
  /** Permissive www autolink: prepend "http://" to href */
  autolinkWww = false;
  /** `REF_*` */
  reference = REF_NONE;

  reset(): void {
    this.hrefBuf = EMPTY;
    this.hrefStart = 0;
    this.hrefEnd = 0;
    this.titleBuf = EMPTY;
    this.titleStart = 0;
    this.titleEnd = 0;
    this.autolink = false;
    this.autolinkEmail = false;
    this.permissiveAutolink = false;
    this.autolinkWww = false;
    this.reference = REF_NONE;
  }
}

/**
 * `[label]: dest "title"`, as written: escapes and entities are not resolved. Reused for every definition.
 * `label`, `dest`, `title` are ranges of `buf`. `lines` are `linesCount` triples (beg, end, indent) of the Int32Array
 * `lines` starting at triple `linesFrom`.
 */
export class Definition {
  /** Where the `[` is. */
  beg = 0;
  /** Where its last line ends. */
  end = 0;
  buf: Uint8Array = EMPTY;
  labelStart = 0;
  labelEnd = 0;
  destStart = 0;
  destEnd = 0;
  titleStart = 0;
  titleEnd = 0;
  lines: Int32Array = new Int32Array(0);
  linesFrom = 0;
  linesCount = 0;
}

/**
 * Renderer interface. The parser calls these methods to produce output. Subclass it and override what you need
 * (Rust: trait `RendererImpl`). Byte ranges are `(buf, start, end)`.
 */
export class Renderer {
  enterBlock(_blockType: number, _data: number, _flags: number): void {}
  leaveBlock(_blockType: number, _data: number): void {}
  enterSpan(_spanType: number, _detail: SpanDetail): void {}
  leaveSpan(_spanType: number): void {}
  text(_textType: number, _buf: Uint8Array, _start: number, _end: number): void {}

  /**
   * Whether this consumer wants to know where things are written in the document. Asked once, before parsing. None of
   * the methods below is called, and nothing is recorded for them, unless it does. It is then also told about the
   * paragraphs of tight lists.
   */
  wantsSource(): boolean {
    return false;
  }
  /** Where the lines of the document start. Right after `enterBlock` of the document: `starts[0..n)`. */
  lineStarts(_starts: Int32Array, _n: number): void {}
  /**
   * Before `enterBlock` of a container: `beg..end` is its marker (of a list: that of its first item), with `indent`
   * columns of white space of its own before it. Before its `leaveBlock`: `end` is the end of the last line that
   * belongs to it: one with something on it, or an empty one with the `>` of a block quote in or around it. `beg` is
   * the start of the line that it does not go on with, `OFF_MAX` (-1) at the end of the document. `indent` is 1 if that
   * line is the `:::` that ends it.
   */
  containerSource(_beg: number, _end: number, _indent: number): void {}
  /**
   * Before `enterBlock` of a leaf block: its lines, `n` triples (beg, end, indent) of `lines`. A line with `beg > end`
   * has been used up by reference definitions. Returns whether the consumer reads the lines by itself: then there are
   * no events for what is in the block.
   */
  leafSource(_blockType: number, _lines: Int32Array, _n: number): boolean {
    return false;
  }
  /**
   * Before `enterSpan`: where its opening marker is. Before `leaveSpan`: its closing marker. Before `text` in a line:
   * where that is written. Before `enterBlock` of a row of a table: the row. Of a cell: what is between its pipes.
   */
  inlineSource(_beg: number, _end: number): void {}
  /** A span of the consumer's own, with the tag that `Extensions.span` gave it. */
  extensionSpan(_tag: number, _buf: Uint8Array, _start: number, _end: number): void {}
  /** A link reference definition. These come right after `enterBlock` of the document, those in front of a setext heading first. */
  definition(_d: Definition): void {}
}

/**
 * Syntax of the consumer's own (Rust: `Extensions`). Subclass and override `leaf` / `span`, set `leafBytes` / `spanBytes`.
 */
export class Extensions {
  /** The bytes that a leaf block of its own can start with. */
  leafBytes: Uint8Array = EMPTY;
  /** The bytes by which a span of its own is told in the text of a paragraph, a heading or a cell. */
  spanBytes: Uint8Array = EMPTY;
  /** Set by `span` when it returns true: `SpanStart::beg`, `end` and the `tag` that `Renderer.extensionSpan` is told. */
  spanBeg = 0;
  spanEnd = 0;
  spanTag = 0;

  /**
   * Where the leaf block ends that starts at `off`, or -1 if none does. Nothing but blanks may follow on that line.
   * It is reported as `BT_HTML` with `BLOCK_EXTENSION`, in one piece. `indent`: the columns of white space before it.
   * `interruptsParagraph`: the line before is one of a paragraph. `startsContainerInParagraph(parser, off)` (line_analysis.ts)
   * says whether the line that starts at `off` would end a paragraph by starting a container.
   */
  leaf(_parser: Parser, _off: number, _indent: number, _isInContainer: boolean, _interruptsParagraph: boolean): number {
    return -1;
  }
  /**
   * The span that the byte at `pos` of the content `buf[off, off+len)` is in, if it is in one: then it sets
   * `spanBeg`, `spanEnd`, `spanTag` (relative to `off`, like `pos`) and returns true. Nothing in it is looked at. It
   * comes before everything else that could start there, but for a backslash. `from`: what is before this place is
   * taken: the span does not start before it. `isAfterOpenBracket`: there is a `[` before it that no `]` has followed
   * yet. `serial`: another number for every text (`content` can be a part of the text).
   */
  span(
    _buf: Uint8Array,
    _off: number,
    _len: number,
    _pos: number,
    _from: number,
    _isAfterOpenBracket: boolean,
    _serial: number,
  ): boolean {
    return false;
  }
}

/** Table cell alignment from block data. */
export function alignmentFromData(data: number): number {
  return data & 3;
}

/** Task list item mark from block data. Returns 0 for non-task items. */
export function taskMarkFromData(data: number): number {
  return data & 255;
}

/** A task mark that is a checked box. */
export function isTaskChecked(taskMark: number): boolean {
  return taskMark !== 0 && taskMark !== 32;
}
