// Classes of print/template.ts. They are here because scriptc cannot use a class that is declared in a module of an import cycle (SC1016): this
// module imports nothing of format/js.
import { Formatter } from "../../ir/formatter.ts";
import { GqlTemplate } from "../../graphql/embed.ts";
import { SP, exprTemplateCooked, exprTemplateQuasiCount, exprTemplateRawSpan, nameBuf, nameLen, nameStart } from "../../../lint/ast/index.ts";

export class JsGqlTemplate extends GqlTemplate {
  e: number = 0;
  /** Writes `${}` number `i` of the template `e` (`writeEmbeddedTemplateExpression`). */
  write: (e: number, i: number, f: Formatter) => void;
  constructor(e: number, write: (e: number, i: number, f: Formatter) => void) {
    super();
    this.e = e;
    this.write = write;
  }
  quasiCount(): number {
    return exprTemplateQuasiCount(this.e);
  }
  rawStart(i: number): number {
    exprTemplateRawSpan(this.e, i);
    return SP.s0 | 0;
  }
  rawEnd(i: number): number {
    exprTemplateRawSpan(this.e, i);
    return SP.s1 | 0;
  }
  cooked(i: number): Uint8Array | null {
    const atom = exprTemplateCooked(this.e, i);
    if (atom < 0) return null;
    const s = nameStart(atom);
    return nameBuf(atom).subarray(s, s + nameLen(atom));
  }
  writeExpression(i: number, f: Formatter): void {
    this.write(this.e, i, f);
  }
}



export class EachCell {
  /** The text of a cell; a line break (end of a row) has `isBreak`. */
  text: Uint8Array;
  width: number;
  willBreak: boolean;
  isBreak: boolean;
  constructor(text: Uint8Array, width: number, willBreak: boolean, isBreak: boolean) {
    this.text = text;
    this.width = width;
    this.willBreak = willBreak;
    this.isBreak = isBreak;
  }
}

export class EachTable {
  /** For each row, whether it has a cell that takes more than one line. It is not aligned then. */
  rows: boolean[] = [];
  columnsWidth: number[] = [];
  elements: EachCell[] = [];
  currentRowWidths: number[] = [];
  currentRowHasLineBreakColumn: boolean = false;

  entry(cell: EachCell): void {
    if (!cell.isBreak) {
      this.currentRowHasLineBreakColumn = this.currentRowHasLineBreakColumn || cell.willBreak;
      if (!this.currentRowHasLineBreakColumn) this.currentRowWidths.push(cell.width);
    } else this.nextRow();
    this.elements.push(cell);
  }

  nextRow(): void {
    if (!this.currentRowHasLineBreakColumn) {
      for (let index = 0; index < this.currentRowWidths.length; index++) {
        const width = this.currentRowWidths[index];
        if (index < this.columnsWidth.length) {
          if (width > this.columnsWidth[index]) this.columnsWidth[index] = width;
        } else this.columnsWidth.push(width);
      }
    }
    this.rows.push(this.currentRowHasLineBreakColumn);
    this.currentRowWidths = [];
    this.currentRowHasLineBreakColumn = false;
  }
}


