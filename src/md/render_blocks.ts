// Port of vendor/bun/src/md/render_blocks.rs: the events of leaf blocks (code, HTML, tables).
import { isBlank } from "./helpers.ts";
import type { Parser } from "./state.ts";
import { LINE_W, resetInlineLines } from "./state.ts";
import { isTableUnderline } from "./line_analysis.ts";
import { processInlineContent } from "./inlines.ts";
import {
  BLOCK_FENCED_CODE,
  BT_TBODY,
  BT_TD,
  BT_THEAD,
  BT_TH,
  BT_TR,
  TABLE_MAXCOLCOUNT,
  TX_HTML,
  TX_NORMAL,
} from "./types.ts";

const SPACE = new Uint8Array([32]);
const NEWLINE = new Uint8Array([10]);

export function enterBlock(p: Parser, blockType: number, data: number, flags: number): void {
  if (p.imageNestingLevel > 0) return;
  p.renderer.enterBlock(blockType, data, flags);
}

export function leaveBlock(p: Parser, blockType: number, data: number): void {
  if (p.imageNestingLevel > 0) return;
  p.renderer.leaveBlock(blockType, data);
}

export function processCodeBlock(p: Parser, lines: Int32Array, n: number, _data: number, flags: number): void {
  let count = n | 0;

  // Trim trailing blank lines from indented code blocks (not fenced)
  if ((flags & BLOCK_FENCED_CODE) === 0) {
    while (count > 0 && (lines[(count - 1) * LINE_W] | 0) >= (lines[(count - 1) * LINE_W + 1] | 0)) count = ((count | 0) - 1) | 0;
  }

  const r = p.renderer;
  for (let k = 0; k < count; k++) {
    const beg = lines[k * LINE_W] | 0;
    const end = lines[k * LINE_W + 1] | 0;
    const indent = lines[k * LINE_W + 2] | 0;
    // Output indented content
    for (let j = 0; j < indent; j++) r.text(TX_NORMAL, SPACE, 0, 1);
    r.text(TX_NORMAL, p.text, beg, end);
    r.text(TX_NORMAL, NEWLINE, 0, 1);
  }
}

export function processHtmlBlock(p: Parser, lines: Int32Array, n: number): void {
  const r = p.renderer;
  for (let k = 0; k < n; k++) {
    if (k > 0) r.text(TX_HTML, NEWLINE, 0, 1);
    const indent = lines[k * LINE_W + 2] | 0;
    for (let j = 0; j < indent; j++) r.text(TX_HTML, SPACE, 0, 1);
    r.text(TX_HTML, p.text, lines[k * LINE_W] | 0, lines[k * LINE_W + 1] | 0);
  }
  r.text(TX_HTML, NEWLINE, 0, 1);
}

export function processTableBlock(p: Parser, lines: Int32Array, n: number, colCount: number): void {
  if (n < 2) return;

  // The alignments are those of the table that was analyzed last.
  isTableUnderline(p, lines[LINE_W] | 0);

  // First line is header, second is underline, rest are body
  enterBlock(p, BT_THEAD, 0, 0);
  tellSource(p, lines[0] | 0, lines[1] | 0);
  enterBlock(p, BT_TR, 0, 0);
  processTableRow(p, lines[0] | 0, lines[1] | 0, true, colCount);
  leaveBlock(p, BT_TR, 0);
  leaveBlock(p, BT_THEAD, 0);

  if (n > 2) {
    enterBlock(p, BT_TBODY, 0, 0);
    for (let k = 2; k < n; k++) {
      tellSource(p, lines[k * LINE_W] | 0, lines[k * LINE_W + 1] | 0);
      enterBlock(p, BT_TR, 0, 0);
      processTableRow(p, lines[k * LINE_W] | 0, lines[k * LINE_W + 1] | 0, false, colCount);
      leaveBlock(p, BT_TR, 0);
    }
    leaveBlock(p, BT_TBODY, 0);
  }
}

function tellSource(p: Parser, beg: number, end: number): void {
  if (p.track) p.renderer.inlineSource(beg, end);
}

export function processTableRow(p: Parser, vbeg: number, vend: number, isHeader: boolean, colCountIn: number): void {
  const text = p.text;
  let rowEnd = vend | 0;
  while (rowEnd > vbeg && isBlank(text[rowEnd - 1] | 0)) rowEnd = ((rowEnd | 0) - 1) | 0;
  const rowLen = rowEnd - vbeg;
  // Who wants to know what is written gets the cells that are written.
  const colCount = p.track ? 0x7fffffff : colCountIn;
  let start = 0;
  let cellIndex = 0;

  // Skip leading pipe
  if (start < rowLen && (text[vbeg + start] | 0) === 124) start = ((start | 0) + 1) | 0;

  const cellType = isHeader ? BT_TH : BT_TD;
  while (start < rowLen && cellIndex < colCount) {
    // Find cell end, skipping escaped chars and code spans
    let end = start | 0;
    while (end < rowLen && (text[vbeg + end] | 0) !== 124) {
      if ((text[vbeg + end] | 0) === 92 && end + 1 < rowLen) end = ((end | 0) + ((2) | 0)) | 0;
      else end = ((end | 0) + 1) | 0;
    }

    // Skip trailing pipe cell
    if (end === rowLen && start === end) break;

    // Trim cell content
    let cellBeg = start | 0;
    let cellEnd = end | 0;
    if (cellEnd > rowLen) cellEnd = rowLen;
    while (cellBeg < cellEnd && isBlank(text[vbeg + cellBeg] | 0)) cellBeg = ((cellBeg | 0) + 1) | 0;
    while (cellEnd > cellBeg && isBlank(text[vbeg + cellEnd - 1] | 0)) cellEnd = ((cellEnd | 0) - 1) | 0;

    const alignData = cellIndex < TABLE_MAXCOLCOUNT ? p.tableAlignments[cellIndex] | 0 : 0;
    tellSource(p, vbeg + start, vbeg + end);
    enterBlock(p, cellType, alignData, 0);
    if (cellBeg < cellEnd) {
      if (p.track) {
        resetInlineLines(p);
        p.inlineLines.push(0);
        p.inlineLines.push(vbeg + cellBeg);
      }
      // GFM: \| in table cells should be consumed at the table level, replacing \| with | before inline processing.
      // This matters for code spans where backslash escapes don't apply.
      let hasEscapedPipe = false;
      if (!p.track) {
        for (let k = vbeg + cellBeg; k + 1 < vbeg + cellEnd; k++) {
          if ((text[k] | 0) === 92 && (text[k + 1] | 0) === 124) {
            hasEscapedPipe = true;
            break;
          }
        }
      }
      if (hasEscapedPipe) {
        const buf = p.cellBuf;
        buf.reset();
        let ci = vbeg + cellBeg;
        const ce = vbeg + cellEnd;
        while (ci < ce) {
          if ((text[ci] | 0) === 92 && ci + 1 < ce && (text[ci + 1] | 0) === 124) {
            buf.push(124);
            ci = ((ci | 0) + ((2) | 0)) | 0;
          } else {
            buf.push(text[ci] | 0);
            ci = ((ci | 0) + 1) | 0;
          }
        }
        processInlineContent(p, buf.data, 0, buf.len);
      } else {
        processInlineContent(p, text, vbeg + cellBeg, cellEnd - cellBeg);
      }
    }
    leaveBlock(p, cellType, 0);
    cellIndex = ((cellIndex | 0) + 1) | 0;

    if (end < rowLen) {
      start = end + 1; // skip |
    } else {
      break;
    }
  }

  // Pad short rows with empty cells
  while (!p.track && cellIndex < colCount) {
    const alignData = cellIndex < TABLE_MAXCOLCOUNT ? p.tableAlignments[cellIndex] | 0 : 0;
    enterBlock(p, cellType, alignData, 0);
    leaveBlock(p, cellType, 0);
    cellIndex = ((cellIndex | 0) + 1) | 0;
  }
}
