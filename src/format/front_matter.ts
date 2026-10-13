// Port of vendor/bun/src/format/front_matter.rs: front matter, which style sheets, Markdown and HTML can start
// with: Prettier's `src/main/front-matter/parse.js`.
import { indexOfByte } from "../base/bytes.ts";
import { indexOfFrom, jsWhitespaceLen, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "./text.ts";

// `---`, a language, lines, `---`, with ranges in the text that it is at the start of.
export class FrontMatter {
  // Where it ends: behind the closing delimiter.
  end: number;
  // What is behind the opening delimiter, without the white space around it.
  languageStart: number;
  languageEnd: number;
  valueStart: number;
  valueEnd: number;
  constructor(end: number, languageStart: number, languageEnd: number, valueStart: number, valueEnd: number) {
    this.end = end;
    this.languageStart = languageStart;
    this.languageEnd = languageEnd;
    this.valueStart = valueStart;
    this.valueEnd = valueEnd;
  }
}

// Whether a line of `raw`, which is front matter (text[start, end)), has `---` behind white space. Formatted, that
// can be at the start of the line, where it ends the front matter. Prettier formats it. Here it stays as it is.
export function hasIndentedDelimiter(text: Uint8Array, start: number, end: number): boolean {
  // Cheap test first: " ---" anywhere.
  let found = false;
  for (let i = start; i + 3 < end; i++) {
    if ((text[i] | 0) === 32 && (text[i + 1] | 0) === 45 && (text[i + 2] | 0) === 45 && (text[i + 3] | 0) === 45) { found = true; break; }
  }
  if (!found) return false;
  // Every line but the first.
  let i = start;
  const firstNl = indexOfByte(text, start, end, 10);
  if (firstNl < 0) return false;
  i = firstNl + 1;
  while (i <= end) {
    let lineEnd = indexOfByte(text, i, end, 10);
    if (lineEnd < 0) lineEnd = end;
    if (i < lineEnd && (text[i] | 0) === 32) {
      const t = trimJsWhitespaceStart(text, i, lineEnd);
      if (t + 2 < lineEnd + 0 && (text[t] | 0) === 45 && (text[t + 1] | 0) === 45 && (text[t + 2] | 0) === 45) return true;
    }
    if (lineEnd >= end) break;
    i = lineEnd + 1;
  }
  return false;
}

// Parses the front matter at the start of `text`, or null.
export function parseFrontMatter(text: Uint8Array): FrontMatter | null {
  const n = text.length;
  if (n < 3) return null;
  const d = text[0] | 0;
  if (!((d === 45 || d === 43) && (text[1] | 0) === d && (text[2] | 0) === d)) return null;
  const firstLineBreak = indexOfByte(text, 3, n, 10);
  if (firstLineBreak < 0) return null;
  const languageStart = trimJsWhitespaceStart(text, 3, firstLineBreak);
  const languageEnd = trimJsWhitespaceEnd(text, languageStart, firstLineBreak);
  // "" or "yaml"
  const langLen = languageEnd - languageStart;
  const isYaml =
    d === 45 &&
    (langLen === 0 ||
      (langLen === 4 &&
        (text[languageStart] | 0) === 121 &&
        (text[languageStart + 1] | 0) === 97 &&
        (text[languageStart + 2] | 0) === 109 &&
        (text[languageStart + 3] | 0) === 108));
  // find("\n" + delimiter)
  let endDelimiter = -1;
  for (let i = firstLineBreak; i + 3 < n; i++) {
    if ((text[i] | 0) === 10 && (text[i + 1] | 0) === d && (text[i + 2] | 0) === d && (text[i + 3] | 0) === d) {
      endDelimiter = i;
      break;
    }
  }
  if (endDelimiter < 0 && isYaml) {
    endDelimiter = indexOfFrom(text, "\n...", firstLineBreak);
  }
  if (endDelimiter < 0) return null;
  const valueStart = firstLineBreak + 1 < endDelimiter ? firstLineBreak + 1 : endDelimiter;
  return new FrontMatter(endDelimiter + 4, languageStart, languageEnd, valueStart, endDelimiter);
}
