// Port of vendor/bun/src/md/ref_defs.rs: link reference definitions.
import * as compat from "./compat.ts";
import { UTF8, decodeUtf8, encodeUtf8 } from "./helpers.ts";
import { HDR, LINE_W } from "./state.ts";
import type { Parser } from "./state.ts";
import { scanLinkDestination } from "./links.ts";
import { FOLD, caseFold } from "./unicode.ts";
import { BLOCK_CONTAINER_CLOSER, BLOCK_CONTAINER_OPENER, BLOCK_REF_DEF_ONLY, BT_P } from "./types.ts";
import { pushRefDef } from "./blocks.ts";

/** Maximum raw length of a link label (CommonMark: "a link label can have at most 999 characters inside the square brackets"). */
export const MAX_LINK_LABEL_LEN = 999;

const enc4 = new Uint8Array(4);

/**
 * Normalize a link label for comparison: collapse whitespace runs to single space, strip leading/trailing whitespace,
 * case-fold. `raw` is `buf[start, end)`. The result is written to `p.normBuf` (`data[0..len)`); returns its length.
 */
export function normalizeLabel(p: Parser, buf: Uint8Array, start: number, end: number): number {
  // Collapse whitespace and apply Unicode case folding (per CommonMark §6.7)
  const out = p.normBuf;
  out.reset();
  let inWs = true; // skip leading whitespace
  let i = start | 0;
  const size = end - start;
  const UTF8$ = UTF8;
  const FOLD$ = FOLD;
  while (i < end) {
    const c = buf[i] | 0;
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      if (!inWs && out.len !== 0) {
        out.push(32);
        inWs = true;
      }
      i = ((i | 0) + 1) | 0;
    } else if (c >= 0x80) {
      // Multi-byte UTF-8: decode, case fold, re-encode
      const cp = decodeUtf8(buf, start, size, i - start);
      const dlen = UTF8$.len;
      caseFold(cp);
      const n = FOLD$.n;
      for (let j = 0; j < n; j++) {
        const f = j === 0 ? FOLD$.c0 : j === 1 ? FOLD$.c1 : FOLD$.c2;
        const len = encodeUtf8(f, enc4, 0);
        if (len > 0) out.append(enc4, 0, len);
      }
      inWs = false;
      i = ((i | 0) + ((dlen) | 0)) | 0;
    } else {
      // ASCII: simple toLower
      out.push(c >= 65 && c <= 90 ? c + 32 : c);
      inWs = false;
      i = ((i | 0) + 1) | 0;
    }
  }
  // Strip trailing space
  if (out.len !== 0 && (out.data[out.len - 1] | 0) === 32) out.len--;
  return out.len;
}

/**
 * Look up a reference definition by label (case-insensitive, whitespace-normalized): `buf[start, end)`. Returns the
 * index of the definition or -1.
 */
export function lookupRefDef(p: Parser, buf: Uint8Array, start: number, end: number): number {
  if (end <= start || p.refDefsN === 0) return -1;
  // Labels longer than the spec cap can never match a stored definition (parse_ref_def enforces the same limit), so skip
  // normalizing them.
  if (end - start > MAX_LINK_LABEL_LEN) return -1;
  const len = normalizeLabel(p, buf, start, end);
  if (len === 0) return -1; // whitespace-only labels are invalid
  return p.refDefLabels.find(p.normBuf.data, 0, len);
}

/**
 * Try to parse a link reference definition from merged paragraph text `text[0, len)` at position `pos`. Returns false
 * if it is none. Else: `p.rdEnd`, `p.rdLabelS/E`, `p.rdDestS/E`, `p.rdTitleS/E` (ranges of `text`; an empty title is a
 * range with start === end).
 */
export function parseRefDef(p: Parser, text: Uint8Array, len: number, pos: number): boolean {
  let q = pos | 0;

  // Must start with [
  if (q >= len || (text[q] | 0) !== 91) return false;
  q = ((q | 0) + 1) | 0;

  // Parse label: content up to ], no unescaped [ or ]
  const labelStart = q | 0;
  let labelLen = 0;
  while (q < len && (text[q] | 0) !== 93) {
    const c = text[q] | 0;
    if (c === 91) return false; // no nested [
    if (c === 92 && q + 1 < len) {
      q = ((q | 0) + ((2) | 0)) | 0;
      labelLen = ((labelLen | 0) + ((2) | 0)) | 0;
    } else {
      q = ((q | 0) + 1) | 0;
      labelLen = ((labelLen | 0) + 1) | 0;
    }
    if (labelLen > MAX_LINK_LABEL_LEN) return false; // label too long
  }
  if (q >= len) return false; // no closing ]
  const labelEnd = q | 0;
  if (labelEnd === labelStart) return false; // empty label
  q = ((q | 0) + 1) | 0; // skip ]

  // Must be followed by :
  if (q >= len || (text[q] | 0) !== 58) return false;
  q = ((q | 0) + 1) | 0;

  // Skip optional whitespace including up to one newline
  q = skipRefDefWhitespace(text, len, q);

  // Parse destination
  if (!parseRefDefDest(p, text, len, q)) return false;
  q = p.sldEnd;
  const destS = p.sldDestS | 0;
  const destE = p.sldDestE | 0;

  // Save position before trying title (may need to backtrack)
  const posAfterDest = q | 0;

  // Skip optional whitespace including up to one newline
  const pBeforeTitleWs = q | 0;
  q = skipRefDefWhitespace(text, len, q);
  let hadNewlineBeforeTitle = false;
  for (let i = pBeforeTitleWs; i < q; i++) {
    if ((text[i] | 0) === 10) {
      hadNewlineBeforeTitle = true;
      break;
    }
  }

  // Parse optional title
  if (q < len && ((text[q] | 0) === 34 || (text[q] | 0) === 39 || (text[q] | 0) === 40)) {
    // Check that there was actual whitespace between dest and title
    const hadWhitespaceBeforeTitle = q > posAfterDest;
    if (hadWhitespaceBeforeTitle) {
      if (parseRefDefTitle(p, text, len, q)) {
        const titleS = p.rdTitleS | 0;
        const titleE = p.rdTitleE | 0;
        // Title must be followed by optional whitespace then end of line or end of text
        let afterTitle = p.sldEnd | 0;
        while (afterTitle < len && ((text[afterTitle] | 0) === 32 || (text[afterTitle] | 0) === 9)) afterTitle = ((afterTitle | 0) + 1) | 0;
        if (afterTitle >= len || (text[afterTitle] | 0) === 10) {
          q = afterTitle;
          if (q < len && (text[q] | 0) === 10) q = ((q | 0) + 1) | 0;
          p.rdEnd = q;
          p.rdLabelS = labelStart;
          p.rdLabelE = labelEnd;
          p.rdDestS = destS;
          p.rdDestE = destE;
          p.rdTitleS = titleS;
          p.rdTitleE = titleE;
          return true;
        }
        // Title present but not followed by end of line — if title was on same line as dest, invalid. If title was on
        // new line, treat as no title (title line is separate paragraph content)
        if (!hadNewlineBeforeTitle) return false; // title on same line as dest but not at end of line
      } else {
        // Invalid title syntax
        if (!hadNewlineBeforeTitle) return false;
      }
    }
  }

  // No title: backtrack to right after destination and check for end-of-line
  q = posAfterDest;
  while (q < len && ((text[q] | 0) === 32 || (text[q] | 0) === 9)) q = ((q | 0) + 1) | 0;
  if (q < len && (text[q] | 0) !== 10) return false;
  if (q < len && (text[q] | 0) === 10) q = ((q | 0) + 1) | 0;

  p.rdEnd = q;
  p.rdLabelS = labelStart;
  p.rdLabelE = labelEnd;
  p.rdDestS = destS;
  p.rdDestE = destE;
  p.rdTitleS = 0;
  p.rdTitleE = 0;
  return true;
}

export function skipRefDefWhitespace(text: Uint8Array, len: number, start: number): number {
  let q = start | 0;
  while (q < len && ((text[q] | 0) === 32 || (text[q] | 0) === 9)) q = ((q | 0) + 1) | 0;
  if (q < len && (text[q] | 0) === 10) {
    q = ((q | 0) + 1) | 0;
    while (q < len && ((text[q] | 0) === 32 || (text[q] | 0) === 9)) q = ((q | 0) + 1) | 0;
  }
  return q;
}

/** Fills `p.sldDestS/E` and `p.sldEnd`. */
export function parseRefDefDest(p: Parser, text: Uint8Array, len: number, start: number): boolean {
  if (!scanLinkDestination(p, text, 0, len, start)) return false;
  // A reference definition needs a destination: only `<>` may be empty.
  if (p.sldEnd === start) return false;
  return true;
}

/** On success `p.rdTitleS/E` is the title and `p.sldEnd` is where it ends. */
export function parseRefDefTitle(p: Parser, text: Uint8Array, len: number, start: number): boolean {
  let q = start | 0;
  if (q >= len) return false;

  const openChar = text[q] | 0;
  let closeChar: number;
  if (openChar === 34 || openChar === 39) closeChar = openChar;
  else if (openChar === 40) closeChar = 41;
  else return false;
  q = ((q | 0) + 1) | 0;
  const titleStart = q | 0;

  while (q < len && (text[q] | 0) !== closeChar) {
    const c = text[q] | 0;
    if (c === 92 && q + 1 < len) {
      q = ((q | 0) + ((2) | 0)) | 0;
    } else {
      // For () titles, nested ( is not allowed
      if (openChar === 40 && c === 40 && !compat.parenthesisCanBeInATitle(p.flags)) return false;
      q = ((q | 0) + 1) | 0;
    }
  }
  if (q >= len) return false; // no closing quote/paren
  p.rdTitleS = titleStart;
  p.rdTitleE = q;
  q = ((q | 0) + 1) | 0; // skip close
  p.sldEnd = q;
  return true;
}

export function buildRefDefHashtable(p: Parser): void {
  let off = 0;
  const bytesLen = p.bbLen | 0;
  const bb = p.bb;

  while (off < bytesLen) {
    if (off + HDR > bytesLen) break;

    const hdrOff = off | 0;
    const blockType = bb[off] | 0;
    const flags = bb[off + 1] | 0;
    off = ((off | 0) + ((HDR) | 0)) | 0;

    const nLines = bb[hdrOff + 3] | 0;
    const linesSize = nLines * LINE_W;
    if (off + linesSize > bytesLen) break;

    const linesOff = off | 0;
    off = ((off | 0) + ((linesSize) | 0)) | 0;

    // Only process paragraph blocks (not container openers/closers)
    if (blockType !== BT_P || (flags & BLOCK_CONTAINER_OPENER) !== 0 || (flags & BLOCK_CONTAINER_CLOSER) !== 0) continue;

    if (nLines === 0) continue;

    // Merge lines into buffer to parse ref defs
    const buffer = p.buffer;
    buffer.reset();
    p.defLinesN = 0;
    for (let li = 0; li < nLines; li++) {
      const beg = bb[linesOff + li * LINE_W] | 0;
      const end = bb[linesOff + li * LINE_W + 1] | 0;
      const indent = bb[linesOff + li * LINE_W + 2] | 0;
      // A reference definition starts with `[`
      if (li === 0 && p.ch(beg) !== 91) break;
      if (beg > end || end > p.size) continue;
      if (buffer.len !== 0) buffer.push(10);
      buffer.append(p.text, beg, end);
      if (p.track) {
        const n = p.defLinesN | 0;
        if ((n + 1) * LINE_W > p.defLines.length) {
          const nl = new Int32Array(p.defLines.length * 2);
          nl.set(p.defLines);
          p.defLines = nl;
        }
        p.defLines[n * LINE_W] = beg | 0;
        p.defLines[n * LINE_W + 1] = end | 0;
        p.defLines[n * LINE_W + 2] = indent | 0;
        p.defLinesN = n + 1;
      }
    }

    const merged = buffer.data;
    const mergedLen = buffer.len | 0;
    let pos = 0;
    let linesConsumed = 0;

    // Try to parse consecutive ref defs from the start
    while (pos < mergedLen) {
      if (!parseRefDef(p, merged, mergedLen, pos)) break;

      const endPos = p.rdEnd | 0;
      const labelS = p.rdLabelS | 0;
      const labelE = p.rdLabelE | 0;
      const destS = p.rdDestS | 0;
      const destE = p.rdDestE | 0;
      const titleS = p.rdTitleS | 0;
      const titleE = p.rdTitleE | 0;

      // Normalize and store the ref def (first definition wins)
      const normLen = normalizeLabel(p, merged, labelS, labelE);
      if (normLen === 0) break; // whitespace-only labels are invalid
      if (!p.refDefLabels.contains(p.normBuf.data, 0, normLen)) {
        p.refDefLabels.insert(p.normBuf.data, 0, normLen);
        pushRefDef(p, merged, destS, destE, titleS, titleE);
      }

      // Count how many newlines were consumed to track lines
      let newlines = 0;
      for (let i = pos; i < endPos; i++) if ((merged[i] | 0) === 10) newlines = ((newlines | 0) + 1) | 0;
      // If end_pos is at the end and last char wasn't \n, that's still a consumed line
      if (endPos >= mergedLen && (endPos === pos || (merged[endPos - 1] | 0) !== 10)) newlines = ((newlines | 0) + 1) | 0;
      if (p.track) {
        const firstI = linesConsumed | 0;
        const lastI = Math.max(linesConsumed + newlines - 1, 0);
        if (firstI < p.defLinesN && lastI < p.defLinesN) {
          const d = p.definition;
          d.beg = p.defLines[firstI * LINE_W] | 0;
          d.end = p.defLines[lastI * LINE_W + 1] | 0;
          d.buf = merged;
          d.labelStart = labelS;
          d.labelEnd = labelE;
          d.destStart = destS;
          d.destEnd = destE;
          d.titleStart = titleS;
          d.titleEnd = titleE;
          d.lines = p.defLines;
          d.linesFrom = linesConsumed;
          d.linesCount = newlines;
          p.renderer.definition(d);
        }
      }
      linesConsumed = ((linesConsumed | 0) + ((newlines) | 0)) | 0;
      pos = endPos;
    }

    // Update the block: mark consumed lines
    if (linesConsumed > 0) {
      if (linesConsumed >= nLines) {
        // Entire paragraph is ref defs — flag to skip during rendering
        bb[hdrOff + 1] = (flags | BLOCK_REF_DEF_ONLY) | 0;
      } else {
        // Mark consumed lines as invalid (beg > end triggers skip in processLeafBlock)
        for (let i = 0; i < linesConsumed; i++) {
          bb[linesOff + i * LINE_W] = 1;
          bb[linesOff + i * LINE_W + 1] = 0;
        }
      }
    }
  }
}
