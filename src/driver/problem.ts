// What is wrong with the text of a file, and where: `Problem` in vendor/bun/src/lint/driver/fmt/mod.rs.

export class Problem {
  message: string;
  // From 1; -1 if it is about the whole file.
  line: number;
  // From 1, in UTF-16 code units, as everywhere in Bun.
  column: number;
  lineText: string;
  constructor(message: string, line: number, column: number, lineText: string) {
    this.message = message;
    this.line = line;
    this.column = column;
    this.lineText = lineText;
  }
}

// How many UTF-16 code units the UTF-8 bytes src[from, to) stand for.
function utf16Len(src: Uint8Array, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    const b = src[i] | 0;
    if (b < 0x80) n = n + 1;
    else if (b >= 0xc0) {
      // a lead byte: 4-byte sequences are two units
      n = n + (b >= 0xf0 ? 2 : 1);
    }
  }
  return n;
}

function decode(src: Uint8Array, from: number, to: number): string {
  return Buffer.from(src.buffer, src.byteOffset + from, to - from).toString("utf8");
}

// A problem about the whole file.
export function problemOfFile(message: string): Problem {
  return new Problem(message, -1, -1, "");
}

// Where the line terminators are: `\n`, `\r`, `\r\n`, and for JavaScript U+2028 and U+2029 (E2 80 A8 / E2 80 A9).
function terminatorLen(src: Uint8Array, i: number, len: number, isJs: boolean): number {
  const b = src[i] | 0;
  if (b === 10) return 1;
  if (b === 13) return i + 1 < len && (src[i + 1] | 0) === 10 ? 2 : 1;
  if (isJs && b === 0xe2 && i + 2 < len && (src[i + 1] | 0) === 0x80 && ((src[i + 2] | 0) === 0xa8 || (src[i + 2] | 0) === 0xa9)) return 3;
  return 0;
}

// A problem at byte `offset` of `src[0..len)`. `isJs`: in JavaScript or TypeScript, where U+2028 ends a line too.
export function problemAt(src: Uint8Array, len: number, message: string, offset: number, isJs: boolean): Problem {
  let start = 0;
  if (len >= 3 && (src[0] | 0) === 0xef && (src[1] | 0) === 0xbb && (src[2] | 0) === 0xbf) start = 3;
  const before = Math.min(len, start + Math.max(0, offset));
  let line = 1;
  let lineStart = start;
  let i = start;
  while (i < before) {
    const t = terminatorLen(src, i, len, isJs);
    if (t > 0) {
      i = i + t;
      // a `\r\n` that straddles `before` ends the line only once its `\n` is seen
      if (i <= before || t !== 2) {
        line = line + 1;
        lineStart = i;
      }
    } else {
      i = i + 1;
    }
  }
  let end = lineStart;
  while (end < len && terminatorLen(src, end, len, isJs) === 0) end = end + 1;
  const column = utf16Len(src, lineStart, before) + 1;
  return new Problem(message, line, column, decode(src, lineStart, end));
}

// `Problem::print`: as Bun prints every other error: the line, a caret, the message, and where it is.
// `isError`: `error` or `warn`.
export function printProblem(p: Problem, shown: string, isError: boolean, colors: boolean): string {
  const label = isError ? "error" : "warn";
  let out = "";
  // `Data::write_format`: the line is shown without the blanks at its end (and none if nothing is left); a line that is empty has no frame.
  let shownLine = p.lineText;
  let cut = shownLine.length;
  while (cut > 0) {
    const c = shownLine.charCodeAt(cut - 1);
    if (c === 32 || c === 13 || c === 10 || c === 9) cut = cut - 1;
    else break;
  }
  if (cut < shownLine.length) shownLine = shownLine.slice(0, cut);
  if (p.line >= 0 && p.column > 0 && shownLine.length > 0) {
    const gutter = p.line + " | ";
    const caret = " ".repeat(gutter.length + Math.max(0, p.column - 1));
    if (colors) {
      out += "\x1b[1m" + gutter + "\x1b[0m" + shownLine + "\n";
      out += caret + "\x1b[1m\x1b[31m\x1b[1m^\x1b[0m\n";
    } else {
      out += gutter + shownLine + "\n" + caret + "^\n";
    }
  }
  const colorOfLabel = isError ? "\x1b[31m" : "\x1b[33m";
  if (colors) {
    out += colorOfLabel + label + "\x1b[0m\x1b[2m: \x1b[0m\x1b[1m" + p.message + "\x1b[0m\n";
    out += "    \x1b[2mat \x1b[0m\x1b[36m" + shown + "\x1b[0m";
    if (p.line >= 0) out += "\x1b[2m:\x1b[0m\x1b[33m" + p.line + "\x1b[0m\x1b[2m:\x1b[0m\x1b[33m" + p.column + "\x1b[0m";
    out += "\n";
  } else {
    out += label + ": " + p.message + "\n    at " + shown;
    if (p.line >= 0) out += ":" + p.line + ":" + p.column;
    out += "\n";
  }
  return out + "\n";
}
