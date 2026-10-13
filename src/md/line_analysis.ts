// Port of vendor/bun/src/md/line_analysis.rs: what a line is. The `is*` checks that return a struct in Rust return a
// boolean here and leave the rest in `p.r*` (see parser.ts).
import * as compat from "./compat.ts";
import {
  ciEqLit,
  decodeUtf8,
  isAlpha,
  isAlphaNum,
  isBlank,
  isDigit,
  isNewline,
  isUnicodeAlphanumeric,
  lineIndentation,
} from "./helpers.ts";
import { MAX_LOOKAHEAD } from "./state.ts";
import type { Container, Parser } from "./state.ts";
import { AL_CENTER, AL_DEFAULT, AL_LEFT, AL_RIGHT, TABLE_MAXCOLCOUNT } from "./types.ts";
import { MAX_LINK_LABEL_LEN } from "./ref_defs.ts";

/** `<![CDATA[` without the `<` the caller already matched. */
const CDATA_OPEN = "![CDATA[";

export function isSetextUnderline(p: Parser, off: number): boolean {
  const text = p.text;
  const size = p.size | 0;
  const c = text[off] | 0;
  if (c !== 61 && c !== 45) return false;

  let pos = off | 0;
  while (pos < size && (text[pos] | 0) === c) pos = ((pos | 0) + 1) | 0;

  // Skip trailing spaces
  while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;

  if (pos >= size || isNewline(text[pos] | 0)) {
    p.rLevel = c === 61 ? 1 : 2;
    return true;
  }
  return false;
}

export function isHrLine(p: Parser, off: number): boolean {
  const text = p.text;
  const size = p.size | 0;
  const c = text[off] | 0;
  if (c !== 45 && c !== 95 && c !== 42) return false;
  // `- - - a`: what has kept the first marker from being one keeps the others too. Looking for it from each of them is quadratic.
  if (p.notHrFrom <= off && off < p.notHrTo) return false;

  let pos = off | 0;
  let count = 0;
  while (pos < size) {
    const d = text[pos] | 0;
    if (d === 10 || d === 13) break;
    if (d === c) {
      count = ((count | 0) + 1) | 0;
    } else if (d !== 32 && d !== 9) {
      p.notHrFrom = off;
      p.notHrTo = pos;
      return false;
    }
    pos = ((pos | 0) + 1) | 0;
  }
  return count >= 3;
}

export function isAtxHeaderLine(p: Parser, off: number): boolean {
  const text = p.text;
  const size = p.size | 0;
  let pos = off | 0;
  let level = 0;

  while (pos < size && (text[pos] | 0) === 35) {
    level = ((level | 0) + 1) | 0;
    pos = ((pos | 0) + 1) | 0;
  }

  if (level === 0 || level > 6) return false;

  // Must be followed by space or end of line
  if (pos < size && !isBlank(text[pos] | 0) && !isNewline(text[pos] | 0)) {
    if (!p.flags.permissiveAtxHeaders) return false;
  }

  // Skip spaces after #
  while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;

  p.rLevel = level;
  p.rContentBeg = pos;
  return true;
}

export function isOpeningCodeFence(p: Parser, off: number): boolean {
  const text = p.text;
  const size = p.size | 0;
  if (off >= size) return false;
  const fenceChar = text[off] | 0;
  let pos = off | 0;
  let count = 0;

  while (pos < size && (text[pos] | 0) === fenceChar) {
    count = ((count | 0) + 1) | 0;
    pos = ((pos | 0) + 1) | 0;
  }

  if (count < (fenceChar === 36 ? 2 : 3)) return false;

  // Backtick fences can't have backticks in info string
  if (fenceChar !== 126) {
    let check = pos | 0;
    while (check < size && !isNewline(text[check] | 0)) {
      if ((text[check] | 0) === fenceChar) return false;
      check = ((check | 0) + 1) | 0;
    }
  }

  // Encode: fence_char in low byte, count in next bytes
  p.rFenceData = fenceChar | (count << 8);
  return true;
}

export function isClosingCodeFence(p: Parser, off: number, fenceData: number): boolean {
  const text = p.text;
  const size = p.size | 0;
  const fenceChar = fenceData & 255;
  const fenceCount = fenceData >>> 8;

  let pos = off | 0;
  let count = 0;
  while (pos < size && (text[pos] | 0) === fenceChar) {
    count = ((count | 0) + 1) | 0;
    pos = ((pos | 0) + 1) | 0;
  }

  if (count < fenceCount) return false;

  // Rest of line must be blank
  while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;

  return pos >= size || isNewline(text[pos] | 0);
}

export function isHtmlBlockStartCondition(p: Parser, off: number): number {
  const text = p.text;
  const size = p.size | 0;
  if (off + 1 >= size) return 0;

  if (compat.everyTagStartsHtml(p.flags)) {
    const t = jsxBlockType(p, off);
    if (t !== 0) return t;
  }

  // Type 1: <script, <pre, <style, <textarea (case insensitive)
  // Only opening tags start type 1 blocks. Closing tags like </pre> are only END conditions for type 1, not start conditions.
  if (
    (text[off + 1] | 0) !== 47 &&
    (matchHtmlTag(p, off, "script") ||
      matchHtmlTag(p, off, "pre") ||
      matchHtmlTag(p, off, "style") ||
      matchHtmlTag(p, off, "textarea"))
  ) {
    return 1;
  }

  // Type 2: <!-- (comment)
  if (off + 3 < size && (text[off + 1] | 0) === 33 && (text[off + 2] | 0) === 45 && (text[off + 3] | 0) === 45) {
    return 2;
  }

  // Type 3: <? (processing instruction)
  if ((text[off + 1] | 0) === 63) return 3;

  // Type 4: <! followed by a letter (declaration)
  if ((text[off + 1] | 0) === 33 && off + 2 < size && isAlpha(text[off + 2] | 0)) return 4;

  // Type 5: <![CDATA[. This is the longest fixed lookahead in the parser.
  if (off + MAX_LOOKAHEAD <= size) {
    let same = true;
    for (let i = 0; i < CDATA_OPEN.length; i++) {
      if ((text[off + 1 + i] | 0) !== (CDATA_OPEN.charCodeAt(i) | 0)) {
        same = false;
        break;
      }
    }
    if (same) return 5;
  }

  // Type 6: block-level tags
  if (isBlockLevelHtmlTag(p, off)) return 6;

  // Type 7: any complete open or closing tag (not interrupting paragraph)
  if (isCompleteHtmlTag(p, off)) return 7;

  return 0;
}

/** See `compat.everyTagStartsHtml`. Returns 1 or 6, 0 for none. */
function jsxBlockType(p: Parser, off: number): number {
  const text = p.text;
  const isClosing = p.ch(off + 1) === 47;
  const nameBeg = off + (isClosing ? 2 : 1);
  let pos = nameBeg | 0;
  while (isAlpha(p.ch(pos))) {
    while (isAlphaNum(p.ch(pos))) pos = ((pos | 0) + 1) | 0;
    if (p.ch(pos) === 46 && isAlpha(p.ch(pos + 1))) {
      pos = ((pos | 0) + 1) | 0;
    } else {
      break;
    }
  }
  const nameLen = pos - nameBeg;
  let isRaw = false;
  if (!isClosing) {
    if (nameLen === 3) isRaw = ciEqLit(text, nameBeg, "pre");
    else if (nameLen === 6) isRaw = ciEqLit(text, nameBeg, "script") || ciEqLit(text, nameBeg, "style");
    else if (nameLen === 5) isRaw = ciEqLit(text, nameBeg, "style");
  }
  const c = p.ch(pos);
  if (c === 32 || c === 9 || c === 62 || c === 10 || c === 13) return isRaw ? 1 : 6;
  if (c === 0 && pos >= p.size) return isRaw ? 1 : 6;
  if (c === 47 && p.ch(pos + 1) === 62) return 6;
  return 0;
}

export function isHtmlBlockEndCondition(p: Parser, off: number, blockType: number): boolean {
  const text = p.text;
  const size = p.size | 0;
  // Types 6 and 7: end condition is a blank line
  if (blockType >= 6) return off >= size || isNewline(text[off] | 0);

  // Types 1-5: search from off to end of line for specific end patterns
  let pos = off | 0;
  while (pos < size && !isNewline(text[pos] | 0)) {
    const c = text[pos] | 0;
    switch (blockType) {
      case 1:
        // Type 1: </script>, </pre>, </style>, </textarea> (case insensitive)
        if (c === 60 && pos + 1 < size && (text[pos + 1] | 0) === 47) {
          const r = pos + 2;
          const restLen = size - r;
          if (
            (restLen > 6 && (text[r + 6] | 0) === 62 && ciEqLit(text, r, "script")) ||
            (restLen > 3 && (text[r + 3] | 0) === 62 && ciEqLit(text, r, "pre")) ||
            (restLen > 5 && (text[r + 5] | 0) === 62 && ciEqLit(text, r, "style")) ||
            (restLen > 8 && (text[r + 8] | 0) === 62 && ciEqLit(text, r, "textarea"))
          ) {
            return true;
          }
        }
        break;
      case 2:
        // Type 2: -->
        if (c === 45 && pos + 2 < size && (text[pos + 1] | 0) === 45 && (text[pos + 2] | 0) === 62) return true;
        break;
      case 3:
        // Type 3: ?>
        if (c === 63 && pos + 1 < size && (text[pos + 1] | 0) === 62) return true;
        break;
      case 4:
        // Type 4: >
        if (c === 62) return true;
        break;
      case 5:
        // Type 5: ]]>
        if (c === 93 && pos + 2 < size && (text[pos + 1] | 0) === 93 && (text[pos + 2] | 0) === 62) return true;
        break;
      default:
        return false;
    }
    pos = ((pos | 0) + 1) | 0;
  }
  return false;
}

export function matchHtmlTag(p: Parser, off: number, tag: string): boolean {
  const text = p.text;
  const size = p.size | 0;
  const tlen = tag.length | 0;
  if (off + 1 + tlen >= size) return false;
  const start = off + 1;
  // Allow optional / for closing tags
  let pos = start | 0;
  if (pos < size && (text[pos] | 0) === 47) pos = ((pos | 0) + 1) | 0;
  if (pos + tlen > size) return false;
  if (!ciEqLit(text, pos, tag)) return false;
  pos = ((pos | 0) + ((tlen) | 0)) | 0;
  if (pos >= size) return true;
  const after = text[pos] | 0;
  return after === 62 || after === 47 || isBlank(after) || isNewline(after);
}

const BLOCK_TAGS: string[] = [
  "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col", "colgroup",
  "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "frame",
  "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "iframe", "legend", "li", "link",
  "main", "menu", "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p", "param", "search", "section",
  "summary", "table", "tbody", "td", "tfoot", "th", "thead", "title", "tr", "track", "ul",
];

// Open addressing table over the FNV hash of the lowercase tag: entry = index + 1.
const TAG_TABLE = new Int32Array(256);
const TAG_HASH = new Int32Array(BLOCK_TAGS.length);
for (let i = 0; i < BLOCK_TAGS.length; i++) {
  const t = BLOCK_TAGS[i];
  let h = -2128831035;
  for (let k = 0; k < t.length; k++) h = Math.imul(h ^ (t.charCodeAt(k) | 0), 16777619);
  TAG_HASH[i] = h | 0;
  let slot = (h ^ (h >>> 15)) & 255;
  while ((TAG_TABLE[slot] | 0) !== 0) slot = (slot + 1) & 255;
  TAG_TABLE[slot] = (i + 1) | 0;
}

/**
 * The block-level tags of type 6: the word after `<` or `</` ends at `>`, `/`, a blank, a line break or the end, and is
 * one of `BLOCK_TAGS`, ignoring case.
 */
export function isBlockLevelHtmlTag(p: Parser, off: number): boolean {
  const text = p.text;
  const size = p.size | 0;
  let pos = off + 1;
  if (pos < size && (text[pos] | 0) === 47) pos = ((pos | 0) + 1) | 0;
  const start = pos | 0;
  let h = -2128831035;
  while (pos < size) {
    const c = text[pos] | 0;
    if (c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13) break;
    h = Math.imul(h ^ (c >= 65 && c <= 90 ? c + 32 : c), 16777619);
    pos = ((pos | 0) + 1) | 0;
  }
  const len = pos - start;
  if (len === 0 || len > 10) return false;
  // match_html_tag: the name must be followed by something within the text.
  if (off + 1 + len >= size) return false;
  let slot = (h ^ (h >>> 15)) & 255;
  while (true) {
    const e = TAG_TABLE[slot] | 0;
    if (e === 0) return false;
    const i = e - 1;
    if ((TAG_HASH[i] | 0) === (h | 0)) {
      const t = BLOCK_TAGS[i];
      if (t.length === len && ciEqLit(text, start, t)) return true;
    }
    slot = (slot + 1) & 255;
  }
}

export function isCompleteHtmlTag(p: Parser, off: number): boolean {
  const text = p.text;
  const size = p.size | 0;
  if (off + 1 >= size) return false;
  let pos = off + 1;

  // Closing tag
  if (pos < size && (text[pos] | 0) === 47) {
    pos = ((pos | 0) + 1) | 0;
    if (pos >= size || !isAlpha(text[pos] | 0)) return false;
    while (pos < size && (isAlphaNum(text[pos] | 0) || (text[pos] | 0) === 45)) pos = ((pos | 0) + 1) | 0;
    while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;
    if (pos >= size || (text[pos] | 0) !== 62) return false;
    pos = ((pos | 0) + 1) | 0;
    // Rest of line must be whitespace only
    while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;
    return pos >= size || isNewline(text[pos] | 0);
  }

  // Opening tag: <tagname (attributes)* optional-/ >
  if (!isAlpha(text[pos] | 0)) return false;
  while (pos < size && (isAlphaNum(text[pos] | 0) || (text[pos] | 0) === 45)) pos = ((pos | 0) + 1) | 0;

  // Parse attributes
  while (true) {
    const wsStart = pos | 0;
    while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;
    if (pos >= size || isNewline(text[pos] | 0)) return false;

    // Check for end of tag
    if ((text[pos] | 0) === 62) {
      pos = ((pos | 0) + 1) | 0;
      break;
    }
    if ((text[pos] | 0) === 47 && pos + 1 < size && (text[pos + 1] | 0) === 62) {
      pos = ((pos | 0) + ((2) | 0)) | 0;
      break;
    }

    // Attributes must be preceded by whitespace
    if (pos === wsStart) return false;

    // Attribute name: [a-zA-Z_:][a-zA-Z0-9_.:-]*
    const a0 = text[pos] | 0;
    if (!isAlpha(a0) && a0 !== 95 && a0 !== 58) return false;
    pos = ((pos | 0) + 1) | 0;
    while (pos < size) {
      const c = text[pos] | 0;
      if (isAlphaNum(c) || c === 95 || c === 46 || c === 58 || c === 45) pos = ((pos | 0) + 1) | 0;
      else break;
    }

    // Optional attribute value
    let wsPos = pos | 0;
    while (wsPos < size && isBlank(text[wsPos] | 0)) wsPos = ((wsPos | 0) + 1) | 0;
    if (wsPos < size && (text[wsPos] | 0) === 61) {
      pos = wsPos + 1;
      while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;
      if (pos >= size || isNewline(text[pos] | 0)) return false;

      const q = text[pos] | 0;
      if (q === 34) {
        pos = ((pos | 0) + 1) | 0;
        while (pos < size && (text[pos] | 0) !== 34 && !isNewline(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;
        if (pos >= size || (text[pos] | 0) !== 34) return false;
        pos = ((pos | 0) + 1) | 0;
      } else if (q === 39) {
        pos = ((pos | 0) + 1) | 0;
        while (pos < size && (text[pos] | 0) !== 39 && !isNewline(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;
        if (pos >= size || (text[pos] | 0) !== 39) return false;
        pos = ((pos | 0) + 1) | 0;
      } else {
        // Unquoted value
        while (pos < size) {
          const c = text[pos] | 0;
          if (isBlank(c) || isNewline(c) || c === 34 || c === 39 || c === 61 || c === 60 || c === 62 || c === 96) break;
          pos = ((pos | 0) + 1) | 0;
        }
      }
    }
  }

  // Rest of line must be whitespace only
  while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;
  return pos >= size || isNewline(text[pos] | 0);
}

/** Checks the delimiter row at `off`; fills `p.tableAlignments`, and `p.rColCount`. */
export function isTableUnderline(p: Parser, off: number): boolean {
  const text = p.text;
  const size = p.size | 0;
  let pos = off | 0;
  let colCount = 0;
  let hadPipe = false;
  let hadColon = false;

  // Skip leading pipe
  if (pos < size && (text[pos] | 0) === 124) {
    hadPipe = true;
    pos = ((pos | 0) + 1) | 0;
    while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;
  }

  while (pos < size && !isNewline(text[pos] | 0)) {
    // Expect optional ':' then dashes then optional ':'
    const hasLeftColon = pos < size && (text[pos] | 0) === 58;
    if (hasLeftColon) pos = ((pos | 0) + 1) | 0;

    let dashCount = 0;
    while (pos < size && (text[pos] | 0) === 45) {
      dashCount = ((dashCount | 0) + 1) | 0;
      pos = ((pos | 0) + 1) | 0;
    }

    if (dashCount === 0) return false;

    const hasRightColon = pos < size && (text[pos] | 0) === 58;
    if (hasRightColon) pos = ((pos | 0) + 1) | 0;

    hadColon = hadColon || hasLeftColon || hasRightColon;

    // Determine alignment
    if (colCount < TABLE_MAXCOLCOUNT) {
      p.tableAlignments[colCount] =
        hasLeftColon && hasRightColon ? AL_CENTER : hasLeftColon ? AL_LEFT : hasRightColon ? AL_RIGHT : AL_DEFAULT;
    }

    colCount = ((colCount | 0) + 1) | 0;
    if (colCount > TABLE_MAXCOLCOUNT) return false;

    // Skip whitespace
    while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;

    // Pipe separator or end
    if (pos < size && (text[pos] | 0) === 124) {
      hadPipe = true;
      pos = ((pos | 0) + 1) | 0;
      while (pos < size && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;
      if (pos >= size || isNewline(text[pos] | 0)) break;
    } else if (pos >= size || isNewline(text[pos] | 0)) {
      break;
    } else {
      return false;
    }
  }

  if (colCount === 0 || (!hadPipe && !hadColon && colCount < 2)) return false;

  p.rColCount = colCount;
  return true;
}

/**
 * Count the number of pipe-delimited columns in a table row. Used to validate that header and delimiter row column counts
 * match (GFM requirement).
 */
export function countTableRowColumns(p: Parser, beg: number, end: number): number {
  const text = p.text;
  // trim_ascii_end: ASCII whitespace (space, \t, \n, \x0C, \r)
  let rowEnd = end | 0;
  while (rowEnd > beg) {
    const c = text[rowEnd - 1] | 0;
    if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) rowEnd = ((rowEnd | 0) - 1) | 0;
    else break;
  }
  let colCount = 0;
  let pos = beg | 0;

  // Skip leading whitespace
  while (pos < rowEnd && isBlank(text[pos] | 0)) pos = ((pos | 0) + 1) | 0;

  // Skip leading pipe
  if (pos < rowEnd && (text[pos] | 0) === 124) pos = ((pos | 0) + 1) | 0;

  // Count cells between pipes
  let inCell = false;
  while (pos < rowEnd) {
    const c = text[pos] | 0;
    if (c === 124) {
      colCount = ((colCount | 0) + 1) | 0;
      inCell = false;
      pos = ((pos | 0) + 1) | 0;
    } else if (c === 92 && pos + 1 < rowEnd) {
      inCell = true;
      pos = ((pos | 0) + ((2) | 0)) | 0;
    } else if (isNewline(c)) {
      break;
    } else {
      inCell = true;
      pos = ((pos | 0) + 1) | 0;
    }
  }
  // If there's content after the last pipe (no trailing pipe), count it as a column
  if (inCell) colCount = ((colCount | 0) + 1) | 0;
  return colCount;
}

/** Where the `[^label]:` at `off` ends, -1 if there is none. The label has no white space and no `[` in it. */
function footnoteDefinitionMarkEnd(p: Parser, off: number): number {
  if (p.ch(off + 1) !== 94) return -1;
  const labelBeg = off + 2;
  let pos = labelBeg | 0;
  while (true) {
    const c = p.ch(pos);
    if (c === 93) break;
    if (c === 91 || c === 32 || c === 9 || c === 10 || c === 13) return -1;
    if (c === 0 && pos >= p.size) return -1;
    if (c === 92) {
      const n = p.ch(pos + 1);
      if (n === 91 || n === 92 || n === 93) pos = ((pos | 0) + ((2) | 0)) | 0;
      else pos = ((pos | 0) + 1) | 0;
    } else {
      pos = ((pos | 0) + 1) | 0;
    }
    if (pos - labelBeg > MAX_LINK_LABEL_LEN) return -1;
  }
  return pos > labelBeg && p.ch(pos + 1) === 58 ? pos + 2 : -1;
}

/** Whether the line that starts at `lineBeg` would end a paragraph by starting a container. */
export function startsContainerInParagraph(p: Parser, lineBeg: number): boolean {
  const text = p.text;
  const off = lineIndentation(p, text, 0, lineBeg);
  const indent = p.liIndent | 0;
  if (off >= p.size || isHrLine(p, off)) return false;
  if (!isContainerMark(p, indent, off)) return false;
  const ch = p.cm.ch | 0;
  if (ch === 62 || ch === 94) return true;
  const afterMark = lineIndentation(p, text, 0, p.cmOff);
  const isEmpty = afterMark >= p.size || isNewline(p.ch(afterMark));
  const isOrdered = ch === 46 || ch === 41;
  return !isEmpty && (!isOrdered || p.cm.start === 1);
}

/** Where the colons at `off` end. */
function directiveRunEnd(p: Parser, off: number): number {
  let end = off | 0;
  while (end < p.size && (p.text[end] | 0) === 58) end = ((end | 0) + 1) | 0;
  return end;
}

/** Whether the line is, from `off` on, `fenceLen` colons or more and nothing else. */
export function endsDirective(p: Parser, off: number, fenceLen: number): boolean {
  const text = p.text;
  const runEnd = directiveRunEnd(p, off);
  const after = lineIndentation(p, text, 0, runEnd);
  return runEnd - off >= fenceLen && (after >= p.size || isNewline(p.text[after] | 0));
}

/**
 * Whether there is a container mark at `off` (with `indent` columns of white space before it): then the container is
 * `p.cm`, and `p.cmOff` is where the mark ends. Otherwise `p.cm` is the default container and `p.cmOff` is `off`.
 */
export function isContainerMark(p: Parser, indent: number, off: number): boolean {
  const text = p.text;
  const size = p.size | 0;
  const cm = p.cm;
  p.cmOff = off;
  if (off >= size) return false;

  // md4c: indent >= code_indent_offset means this is indented code, not a container
  if (indent >= p.codeIndentOffset) return false;

  const c = text[off] | 0;

  // Blockquote. Note: off points just past '>' — the optional space and remaining indent are handled by the caller via
  // lineIndentation + the whitespace adjustment logic, matching md4c's behavior.
  if (c === 62) {
    setMark(cm, 62, 0, indent, indent + 1);
    p.cmOff = off + 1;
    return true;
  }

  // The definition of a footnote: [^label]:
  if (c === 91 && p.flags.footnotes) {
    const markEnd = footnoteDefinitionMarkEnd(p, off);
    if (markEnd >= 0) {
      setMark(cm, 94, 0, indent, indent + (markEnd - off));
      p.cmOff = markEnd;
      return true;
    }
  }

  // `:::name`, `::: name title`, `::: {.class}`: the whole line is the mark
  if (c === 58 && p.flags.directives) {
    let name = directiveRunEnd(p, off);
    const fenceLen = name - off;
    name = lineIndentation(p, text, 0, name);
    let startsName = false;
    if (name < size) {
      const n0 = text[name] | 0;
      startsName = n0 === 95 || n0 === 123 || n0 === 91 || isUnicodeAlphanumeric(decodeUtf8(text, 0, size, name));
    }
    // Every line is asked about each of them, however short it is
    if (fenceLen >= 3 && startsName && p.directivesN < 32) {
      let end = name | 0;
      while (end < size) {
        const d = text[end] | 0;
        if (d === 13 || d === 10) break;
        end = ((end | 0) + 1) | 0;
      }
      setMark(cm, 58, fenceLen, indent, indent);
      p.cmOff = end;
      return true;
    }
  }

  // Unordered list: -, +, *. off points just past the marker (before the mandatory space). The space is included in the
  // lineIndentation computation by the caller.
  if ((c === 45 || c === 43 || c === 42) && off + 1 < size && isBlank(text[off + 1] | 0)) {
    setMark(cm, c, 0, indent, indent + 1);
    p.cmOff = off + 1;
    return true;
  }
  // Empty unordered list item: marker followed by newline or EOF
  if ((c === 45 || c === 43 || c === 42) && (off + 1 >= size || isNewline(text[off + 1] | 0))) {
    setMark(cm, c, 0, indent, indent + 1);
    p.cmOff = off + 1;
    return true;
  }

  // Ordered list: digits followed by . or )
  if (isDigit(c)) {
    let pos = off | 0;
    let num = 0;
    while (pos < size && isDigit(text[pos] | 0) && pos - off < 9) {
      num = num * 10 + ((text[pos] | 0) - 48);
      pos = ((pos | 0) + 1) | 0;
    }
    if (pos < size && ((text[pos] | 0) === 46 || (text[pos] | 0) === 41)) {
      const delim = text[pos] | 0;
      pos = ((pos | 0) + 1) | 0; // Past delimiter
      if (pos < size && isBlank(text[pos] | 0)) {
        // contents_indent = indent + marker_width (digits + delimiter)
        setMark(cm, delim, num, indent, indent + (pos - off));
        p.cmOff = pos;
        return true;
      }
      // Empty list item
      if (pos >= size || isNewline(text[pos] | 0)) {
        setMark(cm, delim, num, indent, indent + (pos - off));
        p.cmOff = pos;
        return true;
      }
    }
  }

  return false;
}

/** A container the way `isContainerMark` finds it: everything but these is the default. */
function setMark(cm: Container, ch: number, start: number, markIndent: number, contentsIndent: number): void {
  cm.reset();
  cm.ch = ch;
  cm.start = start;
  cm.markIndent = markIndent;
  cm.contentsIndent = contentsIndent;
}
