// Port of vendor/bun/src/format/js/jsdoc/line_buffer.rs: lines in one buffer, with `\n` between them.
import { LM_NONE, listMarker } from "./markers.ts";
import { trimUnicodeWhitespaceStart } from "../../../base/ustr.ts";

export class LineBuffer {
  buf: string = "";
  /** At least one line has been pushed. */
  hasContent: boolean = false;

  /** Pushes a line, or several if there are line breaks in it. */
  push(line: string): void {
    this.beginLine();
    this.buf = this.buf + line;
  }

  pushEmpty(): void {
    this.push("");
  }

  /** Starts a line. Write it with `append`. */
  beginLine(): void {
    if (this.hasContent) this.buf = this.buf + "\n";
    this.hasContent = true;
  }

  append(text: string): void {
    this.buf = this.buf + text;
  }

  lastIsEmpty(): boolean {
    return this.hasContent && (this.buf.length === 0 || this.buf.endsWith("\n"));
  }

  isEmpty(): boolean {
    return !this.hasContent;
  }

  /** The length of the buffer (a position for `lineCountSince`). */
  byteLen(): number {
    return this.buf.length;
  }

  /** The number of line breaks behind the first `fromByte` units. */
  lineCountSince(fromByte: number): number {
    let n = 0;
    for (let i = fromByte; i < this.buf.length; i++) if (this.buf.charCodeAt(i) === 10) n = n + 1;
    return n;
  }

  /** Whether the last line that is not empty ends an item of a list or a block of code. */
  lastLineIsBlockEnd(): boolean {
    let rest = this.buf;
    let last = rest;
    while (true) {
      const at = rest.lastIndexOf("\n");
      if (at < 0) {
        last = rest;
        break;
      }
      const line = rest.substring(at + 1);
      if (line.length === 0) {
        rest = rest.substring(0, at);
        continue;
      }
      last = line;
      break;
    }
    return listMarker(last, 0) !== LM_NONE || trimUnicodeWhitespaceStart(last).startsWith("```") || last.startsWith("    ");
  }

  intoBytes(): string {
    return this.buf;
  }
}
