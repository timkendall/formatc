// Port of vendor/bun/src/format/css/sink.rs: what the printer for style sheets writes to: the parts of a document,
// one after the other.
//
// Most of a style sheet needs no document. Where no group is around them, lines are line breaks. And if a line
// fits as a whole with every group in it on one line, that is how Prettier prints it: a group is measured with what
// follows it up to the next possible line break. So at first everything is written straight to the output that
// way. If a line with a group in it turns out too long, or if there is something in a group that is more than its
// content on one line, `endUnit` says so. Then what has been written of the unit is taken back and it is
// written again, this time to a document, which is printed in its place.
//
// Rust -> TS: `Mark` is a set of fields of the sink (`markLen`, ... saved by `startUnit`, which returns false for
// `None`); a unit is not nested in a unit that has a mark, so one mark is enough. `Option<(usize, u32)>` of `position`
// is `position()` (-1: none) plus the field `lineBreaks` that the caller reads at the same time.
import { ByteBuf } from "../../base/bytebuf.ts";
import { stringWidth } from "../ir/width.ts";
import {
  Elements,
  IC_DEDENT,
  IC_INDENT,
  LINE_LITERAL,
  LINE_SOFT,
  LINE_SPACE,
  Printer,
  docPool,
} from "./doc.ts";
import { FORMAT_OK } from "../errors.ts";

// `Separator`: what is between two items of a `fill`.
export const SEP_LINE = 0;
export const SEP_SOFT_LINE = 1;
export const SEP_HARD_LINE = 2;
/** `dedent(line)` */
export const SEP_DEDENTED_LINE = 3;
/** `dedent(hardline)` */
export const SEP_DEDENTED_HARD_LINE = 4;

export class Sink {
  // null: all that is wanted is the document.
  printer: Printer | null;
  // The output of the printer, when there is one.
  out: ByteBuf;
  // Whether what is written goes to `elements`, not straight to the output.
  isDocument: boolean;
  elements: Elements;
  // Where what `removeLines` is applied to starts.
  withoutLines: Int32Array;
  nWithoutLines: number;

  indent: number;
  // What `indent` is set back to.
  outerIndents: Int32Array;
  nOuterIndents: number;
  // How many groups are open that are written on one line.
  flatGroups: number;
  // Where the line starts behind its indentation, or behind what the printer has written of it, and the column there.
  lineStart: number;
  lineStartColumn: number;
  // Whether a group has been written on one line in this line.
  hasGroupInLine: boolean;
  // How many times something else than a text has gone to the output.
  lineBreaks: number;
  // The unit takes a document.
  hasFailed: boolean;
  // The style sheet is in HTML, where Prettier calls `cleanDoc` with its document.
  isCleaned: boolean;
  // Whether a line break in a text is written as it is (`\n`).
  lfOnly: boolean;
  // The mark of the unit that has started last.
  markLen: number;
  markLineStart: number;
  markLineStartColumn: number;
  markIndent: number;
  markOuterIndents: number;

  constructor() {
    this.printer = null;
    this.out = new ByteBuf(16);
    this.isDocument = true;
    this.elements = new Elements();
    this.withoutLines = new Int32Array(8);
    this.nWithoutLines = 0;
    this.indent = 0;
    this.outerIndents = new Int32Array(32);
    this.nOuterIndents = 0;
    this.flatGroups = 0;
    this.lineStart = 0;
    this.lineStartColumn = 0;
    this.hasGroupInLine = false;
    this.lineBreaks = 0;
    this.hasFailed = false;
    this.isCleaned = false;
    this.lfOnly = true;
    this.markLen = 0;
    this.markLineStart = 0;
    this.markLineStartColumn = 0;
    this.markIndent = 0;
    this.markOuterIndents = 0;
  }

  private reset(): void {
    this.elements.clear();
    this.nWithoutLines = 0;
    this.indent = 0;
    this.nOuterIndents = 0;
    this.flatGroups = 0;
    this.lineStartColumn = 0;
    this.hasGroupInLine = false;
    this.lineBreaks = 0;
    this.hasFailed = false;
  }

  /** `Sink::to_output(printer, is_cleaned)` */
  toOutput(printer: Printer, isCleaned: boolean): void {
    this.reset();
    this.isCleaned = isCleaned;
    this.printer = printer;
    this.out = printer.out;
    this.lineStart = printer.out.len;
    this.isDocument = false;
    this.lfOnly = printer.literalNewLine === 0;
  }

  /** `Sink::to_document()` */
  toDocument(): void {
    this.reset();
    this.isCleaned = false;
    this.printer = null;
    this.isDocument = true;
    this.lineStart = 0;
    this.lfOnly = true;
  }

  /** Everything that has been written to `toDocument()`, as a `Doc` handle. -1: nested too deeply. */
  intoDocument(): number {
    return this.elements.toTree();
  }

  /** Not all has been written, so nothing more is printed. */
  fail(failure: number): void {
    if (this.printer !== null) this.printer.fail(failure);
  }

  /** Whether what has gone to the output is what has been written: 0 or a `FORMAT_*` code. */
  result(): number {
    return this.printer !== null ? this.printer.result() : FORMAT_OK;
  }

  // ───────────────────────────── units ─────────────────────────────

  /** Starts a unit: something that no group is around and that a line break follows. false: it is part of something that
   * is written again as a whole if need be, or that is written to a document. */
  startUnit(): boolean {
    if (this.printer === null) return false;
    if (this.isDocument || this.hasGroupInLine || this.hasFailed || this.flatGroups > 0) return false;
    this.markLen = this.out.len;
    this.markLineStart = this.lineStart;
    this.markLineStartColumn = this.lineStartColumn;
    this.markIndent = this.indent;
    this.markOuterIndents = this.nOuterIndents;
    return true;
  }

  /** Ends a unit. If it returns `false`, the unit has to be written once more, between `startDocument` and `endDocument`. */
  endUnit(): boolean {
    this.checkLine();
    this.hasGroupInLine = false;
    const failed = this.hasFailed;
    this.hasFailed = false;
    return !failed;
  }

  /** Takes back what has been written of the unit that started at the mark. What is written from now on goes to a
   * document. */
  startDocument(): void {
    if (this.printer !== null) this.out.truncate(this.markLen);
    this.lineStart = this.markLineStart;
    this.lineStartColumn = this.markLineStartColumn;
    this.indent = this.markIndent;
    this.nOuterIndents = this.markOuterIndents;
    this.flatGroups = 0;
    this.elements.clear();
    this.isDocument = true;
  }

  /** Whether a text of `len` characters fits on the line. */
  hasRoomFor(len: number): boolean {
    const printer = this.printer;
    if (printer === null) return true;
    return this.lineStartColumn + (this.out.len - this.lineStart) + len <= printer.width;
  }

  /** Prints the document that the unit has been written to. */
  endDocument(): void {
    this.isDocument = false;
    this.lineBreaks = this.lineBreaks + 1;
    const column = this.column();
    const printer = this.printer;
    if (printer !== null) {
      this.lineStartColumn = printer.print(this.elements, this.indent, column);
      this.lineStart = this.out.len;
    }
  }

  /** Writes the document `doc` (a `Doc` handle), which no group is around and which ends with a line break. */
  document(doc: number): void {
    if (this.isDocument) {
      this.elements.document(doc);
      return;
    }
    this.elements.clear();
    this.elements.document(doc);
    this.endDocument();
  }

  private column(): number {
    if (this.printer === null) return this.lineStartColumn;
    const out = this.out;
    if (this.lineStart > out.len) return this.lineStartColumn;
    // Printable ASCII is one column each.
    const data = out.data;
    const end = out.len;
    let plain = true;
    for (let i = this.lineStart; i < end; i++) {
      const c = data[i] | 0;
      if (c < 32 || c > 126) { plain = false; break; }
    }
    if (plain) return this.lineStartColumn + (end - this.lineStart);
    return this.lineStartColumn + stringWidth(out.data, this.lineStart, out.len);
  }

  // The line is complete.
  private checkLine(): void {
    if (this.hasGroupInLine && this.printer !== null && this.column() > this.printer.width) {
      this.hasFailed = true;
    }
  }

  // ───────────────────────────── what is written again ─────────────────────────────

  /** Where the output is, if that is what is written to, for `writtenSince`; -1 if not. The caller reads `lineBreaks`
   * at the same time. */
  position(): number {
    if (this.printer === null || this.isDocument || this.hasFailed) return -1;
    return this.out.len;
  }

  /** What has been written since `position` (and `lineBreaksThen` is `lineBreaks` then), if that is a part of a line: the
   * start of it in `out.data` (up to `out.len`), or -1. `hasGroupInLine` says whether there is a group in the line. */
  writtenSince(position: number, lineBreaksThen: number): number {
    if (this.printer === null || this.isDocument || this.hasFailed || this.lineBreaks !== lineBreaksThen) return -1;
    if (position > this.out.len) return -1;
    return position;
  }

  /** Writes what `writtenSince` has returned (or the memo kept). */
  writeAgain(text: Uint8Array, start: number, end: number, hasGroup: boolean): void {
    this.text(text, start, end);
    if (hasGroup) this.hasGroupInLine = true;
  }

  // ───────────────────────────── the parts of a document ─────────────────────────────

  /** A text: `text[start, end)`. It has no line break unless it is multi-line text that the printer is told about
   * (a line break in it is written as the printer's literal line break). */
  text(text: Uint8Array, start: number, end: number): void {
    if (this.isDocument) {
      this.elements.text(text, start, end);
    } else if (this.lfOnly) {
      this.out.append(text, start, end);
    } else if (this.printer !== null) {
      this.printer.writeText(text, start, end);
    }
  }

  /** A text of printable ASCII. */
  token(s: string): void {
    if (this.isDocument) {
      this.elements.token(s);
    } else if (this.printer !== null) {
      const len = s.length;
      if (len === 1) {
        this.out.push(s.charCodeAt(0) | 0);
      } else {
        const out = this.out;
        const n = out.len;
        if (n + len > out.data.length) out.grow(n + len);
        const d = out.data;
        for (let i = 0; i < len; i++) d[n + i] = s.charCodeAt(i) | 0;
        out.len = n + len;
      }
    }
  }

  /** One printable ASCII byte. */
  tokenByte(b: number): void {
    if (this.isDocument) {
      this.elements.reserveTexts(1);
      const at = this.elements.nt;
      this.elements.texts[at] = b | 0;
      this.elements.nt = at + 1;
      this.elements.addText(at, 1, 1);
    } else {
      this.out.push(b);
    }
  }

  // A line break where no group is written on one line.
  private writeLineBreak(): void {
    this.checkLine();
    this.hasGroupInLine = false;
    this.lineBreaks = this.lineBreaks + 1;
    const printer = this.printer;
    if (printer !== null) {
      this.lineStartColumn = printer.writeHardLine(this.indent);
      this.lineStart = this.out.len;
    }
  }

  line(): void {
    if (this.isDocument) {
      this.elements.line(LINE_SPACE);
    } else if (this.flatGroups > 0) {
      this.tokenByte(32);
    } else {
      this.writeLineBreak();
    }
  }

  softLine(): void {
    if (this.isDocument) {
      this.elements.line(LINE_SOFT);
    } else if (this.flatGroups === 0) {
      this.writeLineBreak();
    }
  }

  hardLine(): void {
    if (this.isDocument) {
      this.elements.hardLine();
    } else if (this.flatGroups > 0) {
      this.hasFailed = true;
    } else {
      this.writeLineBreak();
    }
  }

  /** `literallineWithoutBreakParent` */
  literalLine(): void {
    if (this.isDocument) this.elements.line(LINE_LITERAL);
    else this.hasFailed = true;
  }

  breakParent(): void {
    if (this.isDocument) {
      this.elements.breakParent();
    } else if (this.flatGroups > 0) {
      this.hasFailed = true;
    }
  }

  lineSuffixBoundary(): void {
    // Straight to the output, there is never a line suffix.
    if (this.isDocument) this.elements.lineSuffixBoundary();
  }

  /** `ifBreak(text)` */
  ifBreak(s: string): void {
    if (this.isDocument) {
      this.elements.startIfBreak(0);
      this.elements.token(s);
      this.elements.otherwise();
      this.elements.endIfBreak();
    } else if (this.flatGroups === 0) {
      this.token(s);
    }
  }

  startGroup(shouldBreak: boolean): void {
    if (this.isDocument) {
      this.elements.startGroup(shouldBreak, 0, false);
    } else if (this.flatGroups > 0) {
      if (shouldBreak) this.hasFailed = true;
      this.flatGroups = this.flatGroups + 1;
    } else if (!shouldBreak) {
      this.flatGroups = 1;
      this.hasGroupInLine = true;
    }
  }

  endGroup(): void {
    if (this.isDocument) this.elements.endGroup();
    else if (this.flatGroups > 0) this.flatGroups = this.flatGroups - 1;
  }

  private pushOuterIndent(v: number): void {
    if (this.nOuterIndents === this.outerIndents.length) {
      const n = new Int32Array(this.outerIndents.length * 2);
      n.set(this.outerIndents);
      this.outerIndents = n;
    }
    this.outerIndents[this.nOuterIndents] = v | 0;
    this.nOuterIndents = this.nOuterIndents + 1;
  }

  startIndent(): void {
    if (this.isDocument) {
      this.elements.startIndentCommand(IC_INDENT, 0, 0, 0);
    } else if (this.flatGroups === 0 && this.printer !== null) {
      this.pushOuterIndent(this.indent);
      this.indent = this.printer.indented(this.indent);
    }
  }

  startDedent(): void {
    if (this.isDocument) {
      this.elements.startIndentCommand(IC_DEDENT, 0, 0, 0);
    } else if (this.flatGroups === 0 && this.printer !== null) {
      this.pushOuterIndent(this.indent);
      this.indent = this.printer.dedented(this.indent);
    }
  }

  /** Ends an `indent` or a `dedent`. */
  endIndent(): void {
    if (this.isDocument) {
      this.elements.endIndent();
    } else if (this.flatGroups === 0) {
      if (this.nOuterIndents > 0) {
        this.nOuterIndents = this.nOuterIndents - 1;
        this.indent = this.outerIndents[this.nOuterIndents] | 0;
      } else {
        this.indent = 0;
      }
    }
  }

  /** Starts a `fill` and its first item. */
  startFill(): void {
    if (this.isDocument) {
      this.elements.startFill();
      this.elements.startItem();
    } else if (this.flatGroups === 0) {
      // How much of it fits on each line is for the printer to find out.
      this.hasFailed = true;
    }
  }

  /** Ends an item, and starts the next one behind `separator` (`SEP_*`). */
  fillSeparator(separator: number): void {
    if (!this.isDocument) {
      switch (separator) {
        case SEP_LINE:
        case SEP_DEDENTED_LINE:
          this.tokenByte(32);
          break;
        case SEP_SOFT_LINE:
          break;
        default:
          this.hasFailed = true;
          break;
      }
      return;
    }
    const elements = this.elements;
    elements.endItem();
    elements.startItem();
    const isDedented = separator === SEP_DEDENTED_LINE || separator === SEP_DEDENTED_HARD_LINE;
    if (isDedented) elements.startIndentCommand(IC_DEDENT, 0, 0, 0);
    switch (separator) {
      case SEP_LINE:
      case SEP_DEDENTED_LINE:
        elements.line(LINE_SPACE);
        break;
      case SEP_SOFT_LINE:
        elements.line(LINE_SOFT);
        break;
      default:
        elements.hardLine();
        break;
    }
    if (isDedented) elements.endIndent();
    elements.endItem();
    elements.startItem();
  }

  /** Makes a `fill` of its own of what the `fill` has so far, which starts the only item that there is then. */
  nestFill(): void {
    if (this.isDocument) this.elements.nestFill();
  }

  /** Puts an empty item and a `hardline` before the items of the `fill`. */
  startFillWithHardLine(): void {
    if (this.isDocument) this.elements.startFillWithHardLine();
  }

  endFill(): void {
    if (this.isDocument) {
      this.elements.endItem();
      if (this.isCleaned) this.elements.endCleanedFill();
      else this.elements.endFill();
    }
  }

  /** Ends a `fill` that is to be an array of its items after all. */
  endFillAsArray(): void {
    if (this.isDocument) {
      this.elements.endItem();
      this.elements.endFillAsArray();
    }
  }

  startLineSuffix(): void {
    if (this.isDocument) this.elements.startLineSuffix();
    else this.hasFailed = true;
  }

  endLineSuffix(): void {
    if (this.isDocument) this.elements.endLineSuffix();
  }

  /** Starts what `removeLines` is applied to. */
  startWithoutLines(): void {
    if (this.isDocument) {
      if (this.nWithoutLines === this.withoutLines.length) {
        const n = new Int32Array(this.withoutLines.length * 2);
        n.set(this.withoutLines);
        this.withoutLines = n;
      }
      this.withoutLines[this.nWithoutLines] = this.elements.position() | 0;
      this.nWithoutLines = this.nWithoutLines + 1;
    } else {
      this.hasFailed = true;
    }
  }

  endWithoutLines(): void {
    if (this.isDocument && this.nWithoutLines > 0) {
      this.nWithoutLines = this.nWithoutLines - 1;
      this.elements.removeLinesFrom(this.withoutLines[this.nWithoutLines] | 0);
    }
  }
}

void docPool;
