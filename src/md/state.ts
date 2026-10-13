// Port of vendor/bun/src/md/parser.rs: the parser state (the entry points are in parser.ts, which depends on everything).
//
// Rust's `impl Parser` blocks of the other files are free functions here that take the parser first
// (`analyzeLine(p, ..)`), in the file that has the Rust `impl` block.
//
// Layout (docs/ARCHITECTURE.md §3): the parsers are reusable objects per thread (`acquireParser()`, one per level of nesting); every buffer is
// grow-only and reset per document. Positions are byte offsets into `text`, the `Uint8Array` that is parsed.
import { ByteBuf, I32Vec } from "./buf.ts";
import { LabelSet } from "./labels.ts";
import { Flags } from "./options.ts";
import { EMPTY, TABLE_MAXCOLCOUNT, BT_LI, BLOCK_CONTAINER_OPENER, Definition, Renderer, SpanDetail } from "./types.ts";
import type { Extensions } from "./types.ts";

// What a byte can mean in inline content: `MARK_*`. 0: nothing, and the scans in inlines.ts and links.ts do not look at it.
/** `[` */
export const MARK_OPENER = 1 << 0;
/** `]` */
export const MARK_CLOSER = 1 << 1;
/** `*`, `_`, `~` */
export const MARK_DELIMITER = 1 << 2;
/** `hiddenAt` can find something at it. */
export const MARK_HIDES = 1 << 3;
/** One of `Extensions.spanBytes`. */
export const MARK_EXTENSION = 1 << 4;
export const MARK_OTHER = 1 << 5;

/** Words of a block header in `Parser.bb`: block type, flags, data, n_lines. */
export const HDR = 4;
/** Words of a line (`VerbatimLine`) in `Parser.bb`: beg, end, indent. */
export const LINE_W = 3;

/** u32::MAX of Rust for sizes/limits that are compared with, not stored: the largest positive Int32. */
export const BIG = 0x7fffffff;

/** The longest `OFF`-typed fixed lookahead the parser performs from an in-bounds offset. */
export const MAX_LOOKAHEAD = 9;
/** The largest input accepted (the offsets of the parser are u32 in the original). */
export const MAX_INPUT_LEN = 0x7fffffff - MAX_LOOKAHEAD;

/** Container types: blockquote or list item (`types::Container`). */
export class Container {
  ch = 0;
  isLoose = false;
  isTask = false;
  taskMarkOff = 0;
  start = 0;
  markIndent = 0;
  contentsIndent = 0;
  blockByteOff = 0;
  /** Where the marker of the container (of the current item of a list) is. */
  markBeg = 0;
  markEnd = 0;

  reset(): void {
    this.ch = 0;
    this.isLoose = false;
    this.isTask = false;
    this.taskMarkOff = 0;
    this.start = 0;
    this.markIndent = 0;
    this.contentsIndent = 0;
    this.blockByteOff = 0;
    this.markBeg = 0;
    this.markEnd = 0;
  }

  copyFrom(o: Container): void {
    this.ch = o.ch;
    this.isLoose = o.isLoose;
    this.isTask = o.isTask;
    this.taskMarkOff = o.taskMarkOff;
    this.start = o.start;
    this.markIndent = o.markIndent;
    this.contentsIndent = o.contentsIndent;
    this.blockByteOff = o.blockByteOff;
    this.markBeg = o.markBeg;
    this.markEnd = o.markEnd;
  }
}

/** A line analysis result (`types::Line`). */
export class Line {
  type = 0;
  beg = 0;
  end = 0;
  indent = 0;
  data = 0;
  enforceNewBlock = false;

  reset(): void {
    this.type = 0;
    this.beg = 0;
    this.end = 0;
    this.indent = 0;
    this.data = 0;
    this.enforceNewBlock = false;
  }

  copyFrom(o: Line): void {
    this.type = o.type;
    this.beg = o.beg;
    this.end = o.end;
    this.indent = o.indent;
    this.data = o.data;
    this.enforceNewBlock = o.enforceNewBlock;
  }
}

// Fields of one emphasis delimiter in `Parser.ed` (stride ED_W).
export const ED_W = 24;
export const ED_POS = 0;
export const ED_COUNT = 1;
export const ED_CHAR = 2;
export const ED_CAN_OPEN = 3;
export const ED_CAN_CLOSE = 4;
export const ED_REMAINING = 5;
export const ED_OPEN_COUNT = 6;
export const ED_CLOSE_COUNT = 7;
export const ED_OPEN_NUM = 8;
export const ED_CLOSE_NUM = 9;
export const ED_ACTIVE = 10;
export const ED_OPEN_SIZES = 11;
export const ED_CLOSE_SIZES = 17;
export const MAX_EMPH_MATCHES = 6;

// What hides the markers in the inline content (`Hidden`).
export const HK_CODE = 0;
export const HK_BACKTICKS = 1;
export const HK_HTML = 2;
export const HK_AUTOLINK = 3;
export const HK_FOOTNOTE_REFERENCE = 4;
export const HK_EXTENSION = 5;

// Bracket entries in `Parser.br` (stride BR_W).
export const BR_W = 4;
export const BR_OPEN = 0;
export const BR_CLOSE = 1;
export const BR_LINK_END = 2;
export const BR_IS_IMAGE = 3;

// Label-frame entries in `Parser.lf` (stride LF_W): base, end, i, textStart, resolved start, resolved end, delimCursor,
// leave, closeBeg, closeEnd.
export const LF_W = 10;

/** Parser context holding all state during parsing. */
export class Parser {
  text: Uint8Array = EMPTY;
  size = 0;
  flags: Flags = new Flags();

  // Output
  renderer: Renderer = new Renderer();
  imageNestingLevel = 0;
  linkNestingLevel = 0;

  /** 4 normally, BIG if no_indented_code_blocks */
  codeIndentOffset = 4;

  /** The characters that need special handling: `MARK_*`. */
  markCharMap: Uint8Array = new Uint8Array(256);
  /** Where the bytes of the inline content that is being processed are that `markCharMap` has. */
  marks: Int32Array = new Int32Array(256);
  marksN = 0;
  marksSeen = 0;
  /** What hides markers in that content, in its order. */
  hBeg: Int32Array = new Int32Array(64);
  hEnd: Int32Array = new Int32Array(64);
  hKind: Int32Array = new Int32Array(64);
  /** `ticks` of a code span, 1 for the autolink of an email, the tag of an extension span. */
  hAux: Int32Array = new Int32Array(64);
  hiddenN = 0;
  /** How many times inline content has been processed. */
  inlineSerial = 0;

  // The block currently processed: content `contentBuf[contentOff, contentOff + contentLen)` (R in the notes).
  containers: Container[] = [];
  /** Block headers, containers and lines: Int32 words (`HDR` per header, `LINE_W` per line). */
  bb: Int32Array = new Int32Array(1024);
  bbLen = 0;
  buffer: ByteBuf = new ByteBuf(1024);

  // Emphasis delimiters, in segments (one for the slice being processed, below it those of the enclosing slices).
  ed: Int32Array = new Int32Array(ED_W * 16);
  /** Delimiters in `ed`, all segments. */
  edTop = 0;
  prevCandidate: Int32Array = new Int32Array(16);
  /** Pairs of brackets of the content: stride `BR_W`. */
  br: Int32Array = new Int32Array(BR_W * 16);
  brN = 0;
  /** Label frames stack: stride `LF_W`. */
  lf: Int32Array = new Int32Array(LF_W * 8);
  lfN = 0;

  // Memo of failed closing-delimiter searches in find_html_tag: the slice (start in the content buffer, length) it is
  // for, and per kind of terminator the place from which there is none.
  memoAddr = -1;
  memoLen = 0;
  memoFrom: Int32Array = new Int32Array(4);
  /** No thematic break starts between these two places. See `isHrLine`. */
  notHrFrom = 0;
  notHrTo = 0;

  /** Number of active containers */
  nContainers = 0;
  /** Where in `containers` the open `:::` are, the innermost last */
  directives: Int32Array = new Int32Array(32);
  directivesN = 0;
  /** The same for `>`. Only kept if `keepsQuotes` */
  quotes: Int32Array = new Int32Array(32);
  quotesN = 0;
  /** `set_container_ends`: a deque of (count, end), as a ring buffer. Only kept if `track` */
  ceCount: Int32Array = new Int32Array(16);
  ceEnd: Int32Array = new Int32Array(16);
  ceHead = 0;
  ceLen = 0;

  // Current block being built
  currentBlock = -1;
  currentLines: Int32Array = new Int32Array(LINE_W * 16);
  currentLinesN = 0;

  // HTML block tracking
  htmlBlockType = 0;
  /** Fenced code block indent */
  fenceIndent = 0;

  /** Table column alignments */
  tableAlignments: Uint8Array = new Uint8Array(TABLE_MAXCOLCOUNT);

  // Ref defs: bytes of dest and title in `refBytes`, per definition (destStart, destEnd, titleStart, titleEnd).
  refBytes: ByteBuf = new ByteBuf(256);
  refDefs: Int32Array = new Int32Array(64);
  refDefsN = 0;
  refDefLabels: LabelSet = new LabelSet();

  // State
  lastLineHasListLooseningEffect = false;
  lastListItemStartsWithTwoBlankLines = false;
  /** The last header in `bb` is the opener of a list item. */
  lastHeaderOpensListItem = false;
  /** Nothing is on the last line behind the `[ ]` of its list item */
  lastLineIsOnlyATaskMark = false;
  maxRefDefOutput = 0;

  /** `RendererImpl::wants_source` */
  track = false;
  /** What `containerSource` is told, for each container opener and closer in `bb`, in their order: triples. */
  containerSources: I32Vec = new I32Vec(96);
  /** Where the line that is being analyzed starts. */
  lineBeg = 0;
  /** That line is the `:::` that ends the outermost of the containers that it ends. */
  isDirectiveEnd = false;
  /** The lines of the paragraph whose reference definitions are being read (triples). */
  defLines: Int32Array = new Int32Array(LINE_W * 16);
  defLinesN = 0;
  extensions: Extensions | null = null;
  /** Where each line of the inline content that is being processed starts in it, and in the document: pairs. */
  inlineLines: I32Vec = new I32Vec(32);
  /** The index of the one of them that was asked about last. */
  inlineLine = 0;
  /** The line that was asked about last: where it starts in the inline content, where the next one starts, and where it
   * starts in the document. An empty range when there is none. */
  ilBeg = BIG;
  ilNext = 0;
  ilDoc = 0;
  /** `Extensions.leafBytes` */
  startsExtensionLeaf: Uint8Array = new Uint8Array(256);
  /** Where the lines of the document start. */
  lineStarts: I32Vec = new I32Vec(256);
  /** The labels of the footnotes that are defined, normalized. */
  footnoteLabels: LabelSet = new LabelSet();

  // ---- scratch: results of functions that return more than one value ----
  /** `helpers.lineIndentation` */
  liIndent = 0;
  /** `normalizeLabel` writes the normalized label here. */
  normBuf: ByteBuf = new ByteBuf(64);

  // The inline content that is being processed, `cBuf[cOff, cOff + cLen)`; slices of it are triples (buf, off, len).
  cBuf: Uint8Array = EMPTY;
  cOff = 0;
  cLen = 0;

  /** Containers of the line analysis (`isContainerMark` results, and the `container` of `analyzeLine`). */
  cm: Container = new Container();
  cmOff = 0;
  lineContainer: Container = new Container();
  /** `containers.len()` of Rust: how many have been used. */
  containersLen = 0;
  pivot: Line = new Line();
  line0: Line = new Line();
  line1: Line = new Line();
  tmpLine: Line = new Line();
  lineIdx = 0;
  // results of the checks of line_analysis.ts
  rLevel = 0;
  rContentBeg = 0;
  rFenceData = 0;
  rColCount = 0;
  // parse_ref_def results: ranges of `buffer`
  rdEnd = 0;
  rdLabelS = 0;
  rdLabelE = 0;
  rdDestS = 0;
  rdDestE = 0;
  rdTitleS = 0;
  rdTitleE = 0;
  // scan_link_destination results
  sldDestS = 0;
  sldDestE = 0;
  sldEnd = 0;
  // hiddenAt result
  haBeg = 0;
  haEnd = 0;
  haKind = 0;
  haAux = 0;
  // BracketMatches.link result
  lkClose = 0;
  lkEnd = 0;
  // process_link / process_wiki_link result (LabelParse)
  lpLabelStart = 0;
  lpLabelEnd = 0;
  lpLinkEnd = 0;
  lpLeave = 0;
  // match_wiki_link result
  wlInnerStart = 0;
  /** -1: none */
  wlPipePos = -1;
  wlInnerEnd = 0;
  // find_autolink result
  alEnd = 0;
  alIsEmail = false;
  // find_permissive_autolink result
  paBeg = 0;
  paEnd = 0;
  /** Stack of (end, top) while the labels of wiki links are walked. */
  wikiStack: Int32Array = new Int32Array(32);
  /** Scratch for the cells of a table with `\|` in them. */
  cellBuf: ByteBuf = new ByteBuf(64);
  definition: Definition = new Definition();
  detail: SpanDetail = new SpanDetail();


  /** The byte at `off`, 0 at and after the end of the text. */
  ch(off: number): number {
    if (off >= this.size) return 0;
    return this.text[off] | 0;
  }
}

// Parsers are reused. A parse can start inside a callback of another one (the formatter asks "what are these two lines?"
// from `Renderer.text`), so there is one parser per level of nesting.
const parsers: Parser[] = [];
let depth = 0;

/** The parser of this nesting level of this thread. Pair with `releaseParser()`. */
export function acquireParser(): Parser {
  if (depth === parsers.length) parsers.push(new Parser());
  const p = parsers[depth];
  depth = depth + 1;
  return p;
}

export function releaseParser(): void {
  depth = depth - 1;
}

/**
 * Appends one `BlockHeader` to `bb`. Returns its word offset. This is the only way a header is added.
 */
export function appendBlockHeader(p: Parser, blockType: number, flags: number, data: number): number {
  const at = p.bbLen;
  if (at + HDR > p.bb.length) growBb(p, at + HDR);
  p.lastHeaderOpensListItem = blockType === BT_LI && (flags & BLOCK_CONTAINER_OPENER) !== 0;
  const bb = p.bb;
  bb[at] = blockType | 0;
  bb[at + 1] = flags | 0;
  bb[at + 2] = data | 0;
  bb[at + 3] = 0;
  p.bbLen = at + HDR;
  return at;
}

export function growBb(p: Parser, need: number): void {
  let n = p.bb.length;
  while (n < need) n = n * 2;
  const nb = new Int32Array(n);
  nb.set(p.bb.subarray(0, p.bbLen));
  p.bb = nb;
}

/** The inline content has other lines: forget the line that was asked about last. */
export function resetInlineLines(p: Parser): void {
  p.inlineLines.reset();
  p.inlineLine = 0;
  p.ilBeg = BIG;
  p.ilNext = 0;
}

/** Charge one resolved reference link/image against the reference-definition output budget. */
export function chargeRefDefOutput(p: Parser, destLen: number, titleLen: number): boolean {
  const n = destLen + titleLen;
  if (n < p.maxRefDefOutput) {
    p.maxRefDefOutput -= n;
    return true;
  }
  p.maxRefDefOutput = 0;
  return false;
}

