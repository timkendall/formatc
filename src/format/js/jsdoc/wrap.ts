// Port of vendor/bun/src/format/js/jsdoc/wrap.rs: breaking text into lines, and tables.
import { LineBuffer } from "./line_buffer.ts";
import { isBlockMarkerToken } from "./markers.ts";
import { lines, spaces } from "./text.ts";
import { trimUnicodeWhitespace } from "../../../base/ustr.ts";

function isAsciiWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

function withoutOuterPipes(line: string): string {
  let s = trimUnicodeWhitespace(line);
  let a = 0;
  while (a < s.length && s.charCodeAt(a) === 124) a = a + 1;
  s = s.substring(a);
  let b = s.length;
  while (b > 0 && s.charCodeAt(b - 1) === 124) b = b - 1;
  return s.substring(0, b);
}

/** `| --- | :-: |` */
function isTableSeparator(line: string): boolean {
  const inner = withoutOuterPipes(line);
  if (inner.length === 0) return false;
  const cells = inner.split("|");
  for (let k = 0; k < cells.length; k++) {
    const cell = trimUnicodeWhitespace(cells[k]);
    if (cell.length === 0) return false;
    for (let i = 0; i < cell.length; i++) {
      const c = cell.charCodeAt(i);
      if (!(c === 45 || c === 58 || c === 32)) return false;
    }
    if (cell.indexOf("-") < 0) return false;
  }
  return true;
}

function parseTableCells(line: string): string[] {
  const cells = withoutOuterPipes(line).split("|");
  const out: string[] = [];
  for (let i = 0; i < cells.length; i++) out.push(trimUnicodeWhitespace(cells[i]));
  return out;
}

/** The lines of a table, with its columns aligned if it has a row of dashes. */
export function formatTableBlock(tableLines: string[]): string[] {
  let separatorIndex = -1;
  for (let i = 0; i < tableLines.length; i++) {
    if (isTableSeparator(tableLines[i])) {
      separatorIndex = i;
      break;
    }
  }
  if (separatorIndex < 0) return tableLines.slice();
  const allCells: string[][] = [];
  for (let i = 0; i < tableLines.length; i++) if (i !== separatorIndex) allCells.push(parseTableCells(tableLines[i]));
  let columnCount = 0;
  for (let i = 0; i < allCells.length; i++) if (allCells[i].length > columnCount) columnCount = allCells[i].length;
  if (columnCount === 0) return tableLines.slice();
  const widths: number[] = [];
  for (let i = 0; i < columnCount; i++) widths.push(3);
  for (let r = 0; r < allCells.length; r++) {
    const row = allCells[r];
    for (let c = 0; c < row.length && c < columnCount; c++) if (row[c].length > widths[c]) widths[c] = row[c].length;
  }
  const separatorCells = parseTableCells(tableLines[separatorIndex]);
  let nextRow = 0;
  const result: string[] = [];
  for (let index = 0; index < tableLines.length; index++) {
    let row = "";
    let cells: string[] | null = null;
    if (index !== separatorIndex) {
      cells = nextRow < allCells.length ? allCells[nextRow] : null;
      nextRow = nextRow + 1;
    }
    for (let column = 0; column < widths.length; column++) {
      const width = widths[column];
      row = row + (column === 0 ? "| " : " | ");
      if (index === separatorIndex) {
        const cell = column < separatorCells.length ? separatorCells[column] : "---";
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left) row = row + ":";
        let dashes = width - (left ? 1 : 0) - (right ? 1 : 0);
        while (dashes > 0) {
          row = row + "-";
          dashes = dashes - 1;
        }
        if (right) row = row + ":";
      } else {
        const cell = cells !== null && column < cells.length ? cells[column] : "";
        row = row + cell + spaces(width > cell.length ? width - cell.length : 0);
      }
    }
    row = row + " |";
    result.push(row);
  }
  return result;
}

/** Where what starts with `{@` at `start` ends: behind the brace that closes it, and behind what follows that without white space in between. */
function inlineTagEnd(text: string, start: number): number {
  const len = text.length;
  let depth = 1;
  let i = start + 2;
  while (i < len && depth > 0) {
    const b = text.charCodeAt(i);
    if (b === 123) depth = depth + 1;
    else if (b === 125) depth = depth - 1;
    i = i + 1;
  }
  while (i < len && !isAsciiWs(text.charCodeAt(i))) i = i + 1;
  return i;
}

/** The last space in `text` that is not in a `{@link ...}`; -1 if none. */
function findLastBreakableSpace(text: string): number {
  let lastSpace = -1;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("{@", i)) {
      i = inlineTagEnd(text, i);
      continue;
    }
    if (text.charCodeAt(i) === 32) lastSpace = i;
    i = i + 1;
  }
  return lastSpace;
}

/** The words of `text`. A `{@link ...}` is one word. */
function tokenizeWords(text: string): string[] {
  const tokens: string[] = [];
  const len = text.length;
  let i = 0;
  while (true) {
    while (i < len && isAsciiWs(text.charCodeAt(i))) i = i + 1;
    if (i >= len) return tokens;
    const start = i;
    if (text.startsWith("{@", i)) i = inlineTagEnd(text, i);
    else while (i < len && !isAsciiWs(text.charCodeAt(i))) i = i + 1;
    tokens.push(text.substring(start, i));
  }
}

/** Whether `token` is like `{@link Foo}`, with or without something behind it. */
function isInlineTag(token: string): boolean {
  return token.length >= 3 && token.startsWith("{@") && token.indexOf(" ", 2) >= 0 && token.indexOf("}") >= 0;
}

function pushLine(out: LineBuffer, line: string, isFirstLine: boolean, continuationIndent: number): void {
  out.beginLine();
  if (!isFirstLine) out.append(spaces(continuationIndent));
  out.append(line);
}

/**
 * Breaks a paragraph into lines of at most `maxWidth` columns. The first has `firstLineOffset` columns less, the others are indented by
 * `continuationIndent`.
 */
export function wrapParagraph(text: string, maxWidth: number, firstLineOffset: number, continuationIndent: number, out: LineBuffer): void {
  const words = tokenizeWords(text);
  const firstLineMax = maxWidth > firstLineOffset ? maxWidth - firstLineOffset : 0;
  const effectiveMax = maxWidth > continuationIndent ? maxWidth - continuationIndent : 0;
  let currentLine = "";
  let currentWidth = 0;
  let isFirstLine = true;
  // A line can be one column too long for each inline tag on it.
  let currentLineTagCount = 0;
  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    const wordWidth = word.length;
    const tagCount = isInlineTag(word) ? 1 : 0;
    const capacity = isFirstLine ? firstLineMax : effectiveMax;
    if (currentLine.length === 0) {
      currentLine = word;
      currentWidth = wordWidth;
      currentLineTagCount = tagCount;
    } else if (currentWidth + 1 + wordWidth <= capacity + currentLineTagCount + tagCount || isBlockMarkerToken(word)) {
      currentLine = currentLine + " " + word;
      currentWidth = currentWidth + 1 + wordWidth;
      currentLineTagCount = currentLineTagCount + tagCount;
    } else {
      pushLine(out, currentLine, isFirstLine, continuationIndent);
      isFirstLine = false;
      currentLine = word;
      currentWidth = wordWidth;
      currentLineTagCount = tagCount;
    }
  }
  if (currentLine.length === 0) return;
  // prettier-plugin-jsdoc breaks a last line once more if it is exactly as long as a line can be.
  if (!isFirstLine && currentWidth === effectiveMax) {
    const lastSpace = findLastBreakableSpace(currentLine);
    if (lastSpace >= 0 && !isBlockMarkerToken(currentLine.substring(lastSpace + 1))) {
      pushLine(out, currentLine.substring(0, lastSpace), false, continuationIndent);
      pushLine(out, currentLine.substring(lastSpace + 1), false, continuationIndent);
      return;
    }
  }
  pushLine(out, currentLine, isFirstLine, continuationIndent);
}

function flush(paragraph: string[], maxWidth: number, isBalanced: boolean, out: LineBuffer): void {
  if (paragraph.length === 0) return;
  let allFit = paragraph.length > 1;
  if (allFit) for (let i = 0; i < paragraph.length; i++) if (paragraph[i].length > maxWidth) allFit = false;
  if (isBalanced && allFit) {
    for (let i = 0; i < paragraph.length; i++) out.push(paragraph[i]);
  } else {
    wrapParagraph(trimUnicodeWhitespace(paragraph.join(" ")), maxWidth, 0, 0, out);
  }
  paragraph.length = 0;
}

/** For text that is nothing but paragraphs with empty lines between them. `isBalanced`: a paragraph whose lines all fit keeps them. */
export function wrapPlainParagraphs(text: string, maxWidth: number, isBalanced: boolean): string {
  const out = new LineBuffer();
  const paragraph: string[] = [];
  const ls = lines(text);
  for (let i = 0; i < ls.length; i++) {
    const trimmed = trimUnicodeWhitespace(ls[i]);
    if (trimmed.length > 0) {
      paragraph.push(trimmed);
      continue;
    }
    flush(paragraph, maxWidth, isBalanced, out);
    if (!out.lastIsEmpty()) out.pushEmpty();
  }
  flush(paragraph, maxWidth, isBalanced, out);
  return out.intoBytes();
}
