// Port of vendor/bun/src/format/pragma.rs: `@format` and `@noformat` in the first comment of a file: the options
// `requirePragma`, `checkIgnorePragma` and `insertPragma`.
//
// All of it is about the text of a file **before it is parsed**: Prettier inserts the pragma into the source and
// formats the result, and a file that is left as it is does not have to be parsed. `beforeParsing` does what
// Prettier's `formatWithCursor` does with the three options.
//
// It is a port of `language-js/pragma.js` and of the functions of `jest-docblock` that it calls, which are made of
// regular expressions. Each function here names the expression that it is. The comment is rare and small, so the
// docblock logic works on JS strings (UTF-16 code units, which is also what the regular expressions see); the file
// text itself is only looked at by byte.
import { ByteBuf } from "../base/bytebuf.ts";
import { indexOfByte, eqAscii } from "../base/bytes.ts";
import { utf16Len } from "../base/utf8.ts";
import { FormatOptions } from "./options.ts";
import { jsWhitespaceLen, trimJsWhitespaceStart } from "./text.ts";

// What to do with a file: `null` is "nothing: it is not to be formatted" (Rust `LeaveAsItIs`); otherwise the text to
// parse and format, which is `text` itself (same object) if nothing was added.
export function beforeParsing(text: Uint8Array, options: FormatOptions): Uint8Array | null {
  const wholeFile =
    (options.rangeStart < 0 || options.rangeStart === 0) &&
    (options.rangeEnd < 0 || options.rangeEnd >= utf16Len(text, 0, text.length));
  return beforeParsingCss(text, 0, wholeFile, options);
}

// The same for CSS, SCSS and Less, where the comment can follow front matter: Prettier's
// `language-css/pragma.js`. `frontMatterLen`: the length of the front matter that `text` starts with, up to and
// including its last `---`. `isWholeFile`: `rangeStart` and `rangeEnd`, which count in the text before its line
// breaks were made `\n`, leave nothing out.
export function beforeParsingCss(text: Uint8Array, frontMatterLen: number, isWholeFile: boolean, options: FormatOptions): Uint8Array | null {
  const fm = frontMatterLen < text.length ? frontMatterLen : text.length;
  const content = fm === 0 ? text : text.subarray(fm);
  if ((options.requirePragma && !hasPragma(content)) || (options.checkIgnorePragma && hasIgnorePragma(content))) {
    return null;
  }
  // Not if only a part of the file is formatted.
  if (options.insertPragma && !options.requirePragma && isWholeFile && !hasPragma(content)) {
    const out = new ByteBuf(text.length + 32);
    if (fm > 0) {
      out.append(text, 0, fm);
      out.push(10);
      out.push(10);
    }
    insertPragma(content, out);
    return out.view();
  }
  return text;
}

// Whether the first comment of `text` has `@format` or `@prettier`.
export function hasPragma(text: Uint8Array): boolean {
  return hasAnyPragma(text, "format", "prettier");
}

// Whether the first comment of `text` has `@noformat` or `@noprettier`.
export function hasIgnorePragma(text: Uint8Array): boolean {
  return hasAnyPragma(text, "noformat", "noprettier");
}

function hasAnyPragma(text: Uint8Array, a: string, b: string): boolean {
  const parts = Parts.of(text);
  // Nearly every file is told by this.
  if (indexOfByte(text, parts.docStart, parts.docEnd, 64) < 0) return false;
  const docBlock = DocBlock.parse(decode(text, parts.docStart, parts.docEnd));
  const names = docBlock.names;
  for (let i = 0; i < names.length; i++) {
    if (names[i] === a || names[i] === b) return true;
  }
  return false;
}

function decode(text: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(text.subarray(start, end));
}

// Prettier's `insertPragma`: appends `text` to `out`, with `@format` in its first comment, which is added if there is
// none.
export function insertPragma(text: Uint8Array, out: ByteBuf): void {
  const parts = Parts.of(text);
  const docBlock = DocBlock.parse(decode(text, parts.docStart, parts.docEnd));
  // Prettier works on text whose line breaks are all `\n`, and puts those of the file back when it prints. So that
  // they are told as before, what is added has the line breaks of the file.
  let lineBreak = "\n";
  const cr = indexOfByte(text, 0, text.length, 13);
  if (cr >= 0) lineBreak = cr + 1 < text.length && (text[cr + 1] | 0) === 10 ? "\r\n" : "\r";

  out.append(text, parts.bomStart, parts.bomEnd);
  if (parts.shebangEnd > parts.shebangStart) {
    out.append(text, parts.shebangStart, parts.shebangEnd);
    out.appendAscii(lineBreak);
  }
  const printed = docBlock.printWithFormatPragma();
  const lines = printed.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out.appendAscii(lineBreak);
    out.appendAll(new TextEncoder().encode(lines[i]));
  }
  const restStart = parts.restStart;
  const first = restStart < text.length ? text[restStart] | 0 : -1;
  if (lineBreak === "\r" && first === 10) {
    // `\r` and the `\n` that follows would be one line break.
    out.push(10);
  } else if (first === 10 || first === 13) {
    out.appendAscii(lineBreak);
  } else {
    out.appendAscii(lineBreak);
    out.appendAscii(lineBreak);
  }
  out.append(text, restStart, text.length);
}

// A file taken apart: all of it but the white space before the first comment and the line break after the shebang.
class Parts {
  bomStart: number = 0;
  bomEnd: number = 0;
  // `#!/usr/bin/env bun`, without its line break
  shebangStart: number = 0;
  shebangEnd: number = 0;
  // The comment that the file starts with, or nothing.
  docStart: number = 0;
  docEnd: number = 0;
  // What follows the comment. Without a comment, what follows the shebang.
  restStart: number = 0;

  // Prettier's `parseDocBlock`, `extract` and `strip`.
  static of(text: Uint8Array): Parts {
    const p = new Parts();
    const n = text.length;
    let at = 0;
    if (n >= 3 && (text[0] | 0) === 0xef && (text[1] | 0) === 0xbb && (text[2] | 0) === 0xbf) {
      p.bomStart = 0;
      p.bomEnd = 3;
      at = 3;
    }
    p.shebangStart = at;
    p.shebangEnd = at;
    if (at + 1 < n && (text[at] | 0) === 35 && (text[at + 1] | 0) === 33) {
      let end = -1;
      for (let i = at; i < n; i++) {
        const b = text[i] | 0;
        if (b === 10 || b === 13) { end = i; break; }
      }
      if (end < 0) {
        p.shebangEnd = n;
        at = n;
      } else {
        p.shebangEnd = end;
        at = end + ((text[end] | 0) === 13 && end + 1 < n && (text[end + 1] | 0) === 10 ? 2 : 1);
      }
    }
    const trimmed = trimJsWhitespaceStart(text, at, n);
    const len = docBlockLen(text, trimmed, n);
    if (len >= 0) {
      p.docStart = trimmed;
      p.docEnd = trimmed + len;
      p.restStart = trimmed + len;
    } else {
      p.docStart = at;
      p.docEnd = at;
      p.restStart = at;
    }
    return p;
  }
}

// `/^\/\*\*?(.|\r?\n)*?\*\//`: the length of the comment that text[start, end) starts with, or -1.
//
// The expression finds the end of `/**/` in the next comment, and takes the code in between for a part of the
// comment, which `insertPragma` then deletes. That is not done here.
function docBlockLen(text: Uint8Array, start: number, end: number): number {
  if (!(start + 1 < end && (text[start] | 0) === 47 && (text[start + 1] | 0) === 42)) return -1;
  const cs = start + 2;
  let close = -1;
  for (let i = cs; i + 1 < end; i++) {
    if ((text[i] | 0) === 42 && (text[i + 1] | 0) === 47) { close = i; break; }
  }
  if (close < 0) return -1;
  // `.` is not U+2028 or U+2029.
  for (let i = cs; i + 2 < close; i++) {
    if ((text[i] | 0) === 0xe2 && (text[i + 1] | 0) === 0x80) {
      const b2 = text[i + 2] | 0;
      if (b2 === 0xa8 || b2 === 0xa9) return -1;
    }
  }
  return close - start + 2;
}

function isWs(code: number): boolean {
  // JS `\s`
  if (code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)) return true;
  return code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

function trimLeft(s: string, ch: string): string {
  const c = ch.charCodeAt(0);
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === c) i = i + 1;
  return s.substring(i);
}

function trimRight(s: string, ch: string): string {
  const c = ch.charCodeAt(0);
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === c) e = e - 1;
  return s.substring(0, e);
}

function trimJsStart(s: string): string {
  let i = 0;
  while (i < s.length && isWs(s.charCodeAt(i))) i = i + 1;
  return s.substring(i);
}

function trimJsEnd(s: string): string {
  let e = s.length;
  while (e > 0 && isWs(s.charCodeAt(e - 1))) e = e - 1;
  return s.substring(0, e);
}

// The value of `Object.keys` order: a canonical array index ("0", "7", no leading zeros, < 2^32-1), else -1.
function jsArrayIndex(name: string): number {
  const n = name.length;
  if (n === 0 || n > 10) return -1;
  if (n > 1 && name.charCodeAt(0) === 48) return -1;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = name.charCodeAt(i);
    if (c < 48 || c > 57) return -1;
    v = v * 10 + (c - 48);
  }
  return v < 4294967295 ? v : -1;
}

// What `parseWithComments` of `jest-docblock` makes of a comment.
class DocBlock {
  // The names and the values of `@name value`, in the order of `Object.keys`. A name that is there several times is
  // next to its first.
  names: string[] = [];
  values: string[] = [];
  // All other lines.
  comments: string = "";

  // `comment`: `/* .. */`, or nothing.
  static parse(comment: string): DocBlock {
    // `/^\/\*\*?/` and `/\*\/$/`
    let content = comment;
    if (content.startsWith("/**")) content = content.substring(3);
    else if (content.startsWith("/*")) content = content.substring(2);
    if (content.endsWith("*/")) content = content.substring(0, content.length - 2);

    // Without the `*` that the lines start with: `/(\r?\n|^) *\* ?/g`. The line breaks become `\n`.
    let text = "";
    let rest = content;
    while (true) {
      const afterSpaces = trimLeft(rest, " ");
      if (afterSpaces.startsWith("*")) {
        const afterStar = afterSpaces.substring(1);
        rest = afterStar.startsWith(" ") ? afterStar.substring(1) : afterStar;
      }
      let end = -1;
      for (let i = 0; i < rest.length; i++) {
        const c = rest.charCodeAt(i);
        if (c === 10 || c === 13) { end = i; break; }
      }
      if (end < 0) {
        text = text + rest;
        break;
      }
      text = text + rest.substring(0, end) + "\n";
      const skip = rest.charCodeAt(end) === 13 && end + 1 < rest.length && rest.charCodeAt(end + 1) === 10 ? 2 : 1;
      rest = rest.substring(end + skip);
    }

    while (true) {
      const joined = joinContinuationLines(text);
      if (joined === null) break;
      text = joined;
    }
    text = trimJsEnd(trimLeft(text, "\n"));

    const db = new DocBlock();
    let comments = "";
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      // A line that starts with `@name`: `/(?:^|\r?\n) *@(\S+) *([^\n\r]*)/`.
      const afterAt = trimLeft(line, " ");
      let name = "";
      let value = "";
      let isProperty = false;
      if (afterAt.startsWith("@")) {
        const body = afterAt.substring(1);
        let nameLen = 0;
        while (nameLen < body.length && !isWs(body.charCodeAt(nameLen))) nameLen = nameLen + 1;
        if (nameLen > 0) {
          isProperty = true;
          name = body.substring(0, nameLen);
          value = trimLeft(body.substring(nameLen), " ");
        }
      }
      if (!isProperty) {
        if (index > 0) comments = comments + "\n";
        comments = comments + line;
        continue;
      }
      // The value without `// ..`: `/(^|\s+)\/\/([^\n\r]*)/g`.
      let kept = value;
      let from = 0;
      while (true) {
        const at = value.indexOf("//", from);
        if (at < 0) break;
        const before = trimJsEnd(value.substring(0, at));
        if (at === 0 || before.length < at) { kept = before; break; }
        from = at + 1;
      }
      // A name that is there several times is next to its first (after its last).
      let last = -1;
      for (let i = db.names.length - 1; i >= 0; i--) {
        if (db.names[i] === name) { last = i; break; }
      }
      if (last >= 0) {
        db.names.splice(last + 1, 0, name);
        db.values.splice(last + 1, 0, kept);
      } else {
        db.names.push(name);
        db.values.push(kept);
      }
    }
    db.sortByKey();
    db.comments = trimJsEnd(trimLeft(comments, "\n"));
    return db;
  }

  // Stable: array-index-like names first, by number; the rest in order.
  sortByKey(): void {
    const n = this.names.length;
    const order: number[] = [];
    for (let i = 0; i < n; i++) order.push(i);
    // Insertion sort (n is tiny and it is stable).
    for (let i = 1; i < n; i++) {
      const cur = order[i];
      const curKey = jsArrayIndex(this.names[cur]);
      let j = i - 1;
      while (j >= 0) {
        const k = jsArrayIndex(this.names[order[j]]);
        // `(0, index)` < `(1, 0)`
        const greater = k < 0 ? curKey >= 0 : (curKey >= 0 && k > curKey);
        if (!greater) break;
        order[j + 1] = order[j];
        j = j - 1;
      }
      order[j + 1] = cur;
    }
    const names: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < n; i++) {
      names.push(this.names[order[i]]);
      values.push(this.values[order[i]]);
    }
    this.names = names;
    this.values = values;
  }

  // `print` of `jest-docblock`, with `{ format: "", ...pragmas }` and `comments.trimStart()`.
  printWithFormatPragma(): string {
    const comments = trimJsStart(this.comments);
    const n = this.names.length;
    let indexes = 0;
    while (indexes < n && jsArrayIndex(this.names[indexes]) >= 0) indexes = indexes + 1;
    let hasFormat = false;
    for (let i = indexes; i < n; i++) {
      if (this.names[i] === "format") hasFormat = true;
    }
    const added = hasFormat ? 0 : 1;
    // The pragmas in the order of printing: the index-like ones, `format`, the other `format`s, the rest.
    const pn: string[] = [];
    const pv: string[] = [];
    for (let i = 0; i < indexes; i++) { pn.push(this.names[i]); pv.push(this.values[i]); }
    if (added === 1) { pn.push("format"); pv.push(""); }
    for (let i = indexes; i < n; i++) {
      if (this.names[i] === "format") { pn.push(this.names[i]); pv.push(this.values[i]); }
    }
    for (let i = indexes; i < n; i++) {
      if (this.names[i] !== "format") { pn.push(this.names[i]); pv.push(this.values[i]); }
    }
    // `` `@${key} ${value}`.trim() ``
    const one = (i: number): string => {
      const v = trimJsEnd(pv[i]);
      return "@" + pn[i] + (v.length > 0 ? " " + v : "");
    };
    if (comments.length === 0 && n + added === 1) {
      let out = "/** ";
      for (let i = 0; i < pn.length; i++) out = out + one(i);
      return out + " */";
    }
    let out = "/**\n";
    if (comments.length > 0) {
      const lines = comments.split("\n");
      for (let i = 0; i < lines.length; i++) out = out + " * " + lines[i] + "\n";
      out = out + " *\n";
    }
    for (let i = 0; i < pn.length; i++) out = out + " * " + one(i) + "\n";
    return out + " */";
  }
}

// One `replaceAll` of
// `/(?:^|\r?\n) *(@[^\n\r]*?) *\r?\n *(?![^\n\r@]*\/\/[^]*)([^\s@][^\n\r@]+?) *\r?\n/g` by `"\n$1 $2\n"`: a line
// after `@name value` that goes on with the value is joined to it. `null` if nothing matches. The line breaks are
// all `\n` by now.
function joinContinuationLines(text: string): string | null {
  let out = "";
  let any = false;
  // Up to here `text` is in `out`.
  let copied = 0;
  // A line can be the first of a match if the line break before it is not the end of a match.
  let lineStart = 0;
  while (true) {
    const firstEnd = text.indexOf("\n", lineStart);
    if (firstEnd < 0) break;
    let matched = false;
    let first = "";
    let second = "";
    let endOfMatch = 0;
    {
      const f0 = trimRight(trimLeft(text.substring(lineStart, firstEnd), " "), " ");
      if (f0.startsWith("@")) {
        const secondStart = firstEnd + 1;
        const secondEndRel = text.indexOf("\n", secondStart);
        if (secondEndRel >= 0) {
          const s0 = trimLeft(text.substring(secondStart, secondEndRel), " ");
          if (!(s0.length < 2 || isWs(s0.charCodeAt(0)) || s0.indexOf("@") >= 0 || s0.indexOf("//") >= 0)) {
            // The lazy `+?` takes one character at least, even if that is a space.
            const trimmedLen = trimRight(s0, " ").length;
            second = s0.substring(0, trimmedLen > 2 ? trimmedLen : 2);
            first = f0;
            endOfMatch = secondEndRel + 1;
            matched = true;
          }
        }
      }
    }
    if (matched) {
      any = true;
      // The line break before the first line is part of the match.
      const upTo = lineStart - 1 > copied ? lineStart - 1 : copied;
      out = out + text.substring(copied, upTo) + "\n" + first + " " + second + "\n";
      copied = endOfMatch;
      // The line at `end` has no line break before it that is left to match.
      const nl = text.indexOf("\n", endOfMatch);
      if (nl < 0) break;
      lineStart = nl + 1;
    } else {
      lineStart = firstEnd + 1;
    }
    if (lineStart >= text.length) break;
  }
  if (!any) return null;
  return out + text.substring(copied);
}
