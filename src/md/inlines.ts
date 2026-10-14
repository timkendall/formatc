// Port of vendor/bun/src/md/inlines.rs: inline content (emphasis, code spans, HTML, entities, links, ...).
//
// The inline content that is processed is `cb[co0, co0 + cl0)` (Rust: `content`). A slice of it (the label of a link) is
// `cb[co0 + base, ...)`; the functions below that take `(cb, co, cl)` are given such a slice, and the offsets they take
// and return are relative to `co`.
import * as compat from "./compat.ts";
import {
  UTF8,
  decodeUtf8,
  decodeUtf8Backward,
  findEntity,
  isAlpha,
  isAlphaNum,
  isAsciiPunctuation,
  isUnicodePunctuation,
  isUnicodeWhitespace,
  isWhitespace,
  trimBlankEnd,
} from "./helpers.ts";
import {
  BIG,
  resetInlineLines,
  ED_ACTIVE,
  ED_CAN_CLOSE,
  ED_CAN_OPEN,
  ED_CHAR,
  ED_CLOSE_COUNT,
  ED_CLOSE_NUM,
  ED_CLOSE_SIZES,
  ED_COUNT,
  ED_OPEN_COUNT,
  ED_OPEN_NUM,
  ED_OPEN_SIZES,
  ED_POS,
  ED_REMAINING,
  ED_W,
  HK_AUTOLINK,
  HK_BACKTICKS,
  HK_CODE,
  HK_EXTENSION,
  HK_FOOTNOTE_REFERENCE,
  HK_HTML,
  LF_W,
  LINE_W,
  MARK_DELIMITER,
  MARK_EXTENSION,
  MARK_HIDES,
  MAX_EMPH_MATCHES,
} from "./state.ts";
import type { Parser } from "./state.ts";
import {
  LL_ALT_TEXT,
  LL_IMAGE,
  LL_LINK,
  LL_WIKILINK,
  bracketLink,
  computeBracketMatches,
  findAutolink,
  footnoteReferenceEnd,
  matchWikiLink,
  processLink,
  processWikiLink,
  renderAutolink,
  renderFootnoteReference,
} from "./links.ts";
import { findPermissiveAutolink, isEmphBoundaryResolved } from "./autolinks.ts";
import {
  SP_A,
  SP_CODE,
  SP_DEL,
  SP_EM,
  SP_IMG,
  SP_STRONG,
  SP_WIKILINK,
  TX_BR,
  TX_CODE,
  TX_ENTITY,
  TX_HTML,
  TX_NORMAL,
  TX_NULLCHAR,
  TX_SOFTBR,
} from "./types.ts";
import { HSK_COMMENT, HSK_PROCESSING_INSTRUCTION, HSK_DECLARATION, HSK_CDATA, N_WHITESPACE, N_PUNCTUATION, N_OTHER } from "./inlines.consts.ts";


/**
 * Merge all lines into buffer with \n between them (unmodified), then process inlines on the merged text. Hard/soft
 * breaks are detected during inline processing when \n is encountered. `lines` are `n` triples (beg, end, indent).
 */
export function processLeafBlock(p: Parser, lines: Int32Array, n: number, trimTrailing: boolean): void {
  if (n === 0) return;

  resetInlineLines(p);
  // One line is not copied
  if (n === 1) {
    const beg = lines[0] | 0;
    const end = lines[1] | 0;
    if (beg <= end && end <= p.size) {
      if (p.track) {
        p.inlineLines.push(0);
        p.inlineLines.push(beg);
      }
      let len = end - beg;
      if (trimTrailing) len = trimBlankEnd(p.text, beg, len);
      processInlineContent(p, p.text, beg, len);
      return;
    }
  }

  const buffer = p.buffer;
  buffer.reset();
  for (let k = 0; k < n; k++) {
    const beg = lines[k * LINE_W] | 0;
    const end = lines[k * LINE_W + 1] | 0;
    if (beg > end || end > p.size) continue;

    if (buffer.len !== 0) buffer.push(10);
    if (p.track) {
      p.inlineLines.push(buffer.len);
      p.inlineLines.push(beg);
    }
    buffer.append(p.text, beg, end);
  }

  // For headings, trim trailing whitespace
  let mergedLen = buffer.len | 0;
  if (trimTrailing) {
    while (mergedLen > 0) {
      const c = buffer.data[mergedLen - 1] | 0;
      if (c === 32 || c === 9) mergedLen = ((mergedLen | 0) - 1) | 0;
      else break;
    }
  }
  processInlineContent(p, buffer.data, 0, mergedLen);
}

function growMarks(p: Parser, need: number): void {
  let n = p.marks.length | 0;
  while (n < need) n = n * 2;
  p.marks = new Int32Array(n);
}

function flushText(p: Parser, cb: Uint8Array, cco: number, base: number, textStart: number, end: number): void {
  if (end > textStart) {
    at(p, base + textStart, base + end);
    p.renderer.text(TX_NORMAL, cb, cco + textStart, cco + end);
  }
}

export function processInlineContent(p: Parser, cb: Uint8Array, co0: number, cl0: number): void {
  // Failed HTML terminator searches recorded for another slice must not leak into this one.
  p.memoAddr = -1;
  p.memoLen = 0;
  p.memoFrom.fill(BIG);

  p.inlineSerial = (p.inlineSerial + 1) | 0;

  // Fast path: no character has a special meaning
  findMarks(p, cb, co0, cl0);
  if (p.marksN === 0) {
    if (cl0 > 0) {
      at(p, 0, cl0);
      p.renderer.text(TX_NORMAL, cb, co0, co0 + cl0);
    }
    return;
  }

  // Bracket-pair map for the whole slice: link processing looks up the ']' matching a '[' here instead of rescanning
  // the rest of the slice for every opener. Label frames share this map (with their offset as `base`).
  computeBracketMatches(p, cb, co0, cl0);

  // A link/image/wikilink label is rendered as inline content of its own: emphasis pairs within the label, and nested
  // constructs inside it are rendered recursively. That recursion is driven iteratively with this frame stack so nesting
  // depth is bounded by the heap, not the native stack.
  p.lfN = 0;
  p.edTop = 0;

  // Walk state for the current (innermost) slice. `base` is the slice's offset within `content`, which the brackets
  // were built for (`cur` is always `content[base..base + curLen]`).
  let base = 0;
  let curLen = cl0 | 0;
  let cco = co0 | 0;
  // The cursors of the walk over the marks and over the hidden table (they only move forward).
  const marks = p.marks;
  const markN = p.marksN | 0;
  const hBeg = p.hBeg;
  const hEnd = p.hEnd;
  const hiddenN = p.hiddenN | 0;
  let wMark = 0;
  let wHidden = 0;

  // Phase 1: Collect and resolve emphasis delimiters
  let rs = p.edTop | 0;
  collectEmphasisDelimiters(p, cb, cco, curLen, base, 0, 0, false);
  let re = p.edTop | 0;
  resolveEmphasisDelimiters(p, rs, re);

  // Phase 2: Emit content using resolved emphasis info
  let i = 0;
  let textStart = 0;
  let delimCursor = 0;
  const flags = p.flags;
  const markCharMap = p.markCharMap;

  while (true) {
    while (i < curLen) {
      // Fast path: characters without a special meaning, skip them
      const here = (base + i) | 0;
      // (Also what `here` is in the middle of: the scan has taken its start for something else.)
      while (wHidden < hiddenN && (hBeg[wHidden] | 0) < here) wHidden = ((wHidden | 0) + 1) | 0;
      while (wMark < markN && (marks[wMark] | 0) < here) wMark = ((wMark | 0) + 1) | 0;
      if (wMark >= markN) break;
      const mark = marks[wMark] | 0;
      if (mark >= base + curLen) break;
      i = (mark - base) | 0;
      const c = cb[cco + i] | 0;

      // Newline from merged lines — check for hard break
      if (c === 10) {
        let emitEnd = i | 0;
        let isHard = false;
        if (emitEnd > textStart && (cb[cco + emitEnd - 1] | 0) === 92) {
          emitEnd = ((emitEnd | 0) - 1) | 0;
          isHard = true;
        } else {
          let sp = emitEnd | 0;
          while (sp > textStart && (cb[cco + sp - 1] | 0) === 32) sp = ((sp | 0) - 1) | 0;
          if (emitEnd - sp >= 2) {
            // Also strip any trailing tabs/spaces before the space run
            const spaces = sp | 0;
            while (sp > textStart) {
              const d = cb[cco + sp - 1] | 0;
              if (d === 32 || d === 9) sp = ((sp | 0) - 1) | 0;
              else break;
            }
            isHard = sp === spaces || !compat.tabBeforeTheBlanksIsNoHardBreak(flags);
            if (isHard) emitEnd = sp;
          }
        }
        flushText(p, cb, cco, base, textStart, emitEnd);
        if (isHard) {
          at(p, base + emitEnd, base + i + 1);
          p.renderer.text(TX_BR, cb, 0, 0);
        } else {
          at(p, base + i, base + i + 1);
          p.renderer.text(TX_SOFTBR, cb, 0, 0);
        }
        i = ((i | 0) + 1) | 0;
        textStart = i;
        continue;
      }

      // Check for backslash escape
      if (c === 92 && i + 1 < curLen && isAsciiPunctuation(cb[cco + i + 1] | 0)) {
        flushText(p, cb, cco, base, textStart, i);
        at(p, base + i, base + i + 2);
        i = ((i | 0) + 1) | 0;
        p.renderer.text(TX_NORMAL, cb, cco + i, cco + i + 1);
        i = ((i | 0) + 1) | 0;
        textStart = i;
        continue;
      }

      // Code spans, HTML tags, autolinks
      if (
        wHidden < hiddenN &&
        (hBeg[wHidden] | 0) <= base + i &&
        (hEnd[wHidden] | 0) <= base + curLen &&
        (hBeg[wHidden] | 0) >= base
      ) {
        const beg = ((hBeg[wHidden] | 0) - base) | 0;
        const end = ((hEnd[wHidden] | 0) - base) | 0;
        const kind = p.hKind[wHidden] | 0;
        const aux = p.hAux[wHidden] | 0;
        flushText(p, cb, cco, base, textStart, beg);
        if (kind === HK_CODE) {
          const ticks = aux | 0;
          at(p, base + beg, base + beg + ticks);
          enterSpan(p, SP_CODE);
          // normalize_code_span_content(content[beg + ticks..end - ticks])
          let ws = beg + ticks;
          let we = end - ticks;
          const wholeLen = we - ws;
          if (wholeLen >= 2) {
            const f = cb[cco + ws] | 0;
            const l = cb[cco + we - 1] | 0;
            if ((f === 32 || f === 10) && (l === 32 || l === 10)) {
              let anyOther = false;
              for (let k = ws; k < we; k++) {
                const d = cb[cco + k] | 0;
                if (d !== 32 && d !== 10) {
                  anyOther = true;
                  break;
                }
              }
              if (anyOther) {
                ws = ((ws | 0) + 1) | 0;
                we = ((we | 0) - 1) | 0;
              }
            }
          }
          const codeBeg = base + beg + ticks + ((wholeLen - (we - ws)) >> 1);
          at(p, codeBeg, codeBeg + (we - ws));
          p.renderer.text(TX_CODE, cb, cco + ws, cco + we);
          at(p, base + end - ticks, base + end);
          leaveSpan(p, SP_CODE);
        } else if (kind === HK_BACKTICKS) {
          at(p, base + beg, base + end);
          p.renderer.text(TX_NORMAL, cb, cco + beg, cco + end);
        } else if (kind === HK_HTML) {
          at(p, base + beg, base + end);
          p.renderer.text(TX_HTML, cb, cco + beg, cco + end);
        } else if (kind === HK_AUTOLINK) {
          renderAutolink(p, cb, cco + beg + 1, cco + end - 1, aux !== 0, base + beg);
        } else if (kind === HK_FOOTNOTE_REFERENCE) {
          renderFootnoteReference(p, cb, cco + beg + 2, cco + end - 1, base + beg);
        } else {
          // HK_EXTENSION
          at(p, base + beg, base + end);
          p.renderer.extensionSpan(aux, cb, cco + beg, cco + end);
        }
        i = end;
        textStart = i;
        continue;
      }
      // It could only have hidden something.
      if (((markCharMap[c] | 0) & ~(MARK_HIDES | MARK_EXTENSION)) === 0) {
        i = ((i | 0) + 1) | 0;
        continue;
      }

      // Emphasis/strikethrough with * or _ or ~ — use resolved delimiters
      if (c === 42 || c === 95 || (c === 126 && flags.strikethrough)) {
        // Find the corresponding resolved delimiter
        while (delimCursor < re - rs && (p.ed[(rs + delimCursor) * ED_W + ED_POS] | 0) < i) delimCursor = ((delimCursor | 0) + 1) | 0;

        if (delimCursor < re - rs && (p.ed[(rs + delimCursor) * ED_W + ED_POS] | 0) === i) {
          flushText(p, cb, cco, base, textStart, i);

          const di = (rs + delimCursor) * ED_W;
          const ed = p.ed;
          const dPos = ed[di + ED_POS] | 0;
          const dCount = ed[di + ED_COUNT] | 0;
          const dChar = ed[di + ED_CHAR] | 0;
          const dOpenCount = ed[di + ED_OPEN_COUNT] | 0;
          const dCloseCount = ed[di + ED_CLOSE_COUNT] | 0;
          const runEnd = dPos + dCount;
          // Where the next marker of the run is.
          let marker = base + i;

          // Emit closing tags first (innermost to outermost)
          if (dChar === 126) {
            if (dCloseCount > 0) {
              at(p, marker, marker + dCloseCount);
              leaveSpan(p, SP_DEL);
              marker = ((marker | 0) + ((dCloseCount) | 0)) | 0;
            }
          } else {
            marker = emitEmphCloseTags(p, di, marker);
          }

          // Emit remaining delimiter chars as text
          const textChars = Math.max(dCount - (dOpenCount + dCloseCount), 0);
          if (textChars > 0) {
            at(p, marker, marker + textChars);
            p.renderer.text(TX_NORMAL, cb, cco + i, cco + i + textChars);
            marker = ((marker | 0) + ((textChars) | 0)) | 0;
          }

          // Emit opening tags (outermost to innermost)
          if (dChar === 126) {
            if (dOpenCount > 0) {
              at(p, marker, marker + dOpenCount);
              enterSpan(p, SP_DEL);
            }
          } else {
            marker = emitEmphOpenTags(p, di, marker);
          }

          delimCursor = ((delimCursor | 0) + 1) | 0;
          i = runEnd;
          textStart = i;
          continue;
        }
        // No resolved delimiter found, just advance
        i = ((i | 0) + 1) | 0;
        continue;
      }

      // HTML entity
      if (c === 38) {
        const endPos = findEntity(cb, cco, curLen, i);
        if (endPos >= 0) {
          flushText(p, cb, cco, base, textStart, i);
          at(p, base + i, base + endPos);
          p.renderer.text(TX_ENTITY, cb, cco + i, cco + endPos);
          i = endPos;
          textStart = i;
          continue;
        }
      }

      // Wiki links: [[destination]] or [[destination|label]]
      if (c === 91 && flags.wikiLinks && i + 1 < curLen && (cb[cco + i + 1] | 0) === 91) {
        flushText(p, cb, cco, base, textStart, i);
        if (processWikiLink(p, cb, cco, curLen, i, base)) {
          // enter_label!
          const ls = enterLabel(p, cb, co0, base, curLen, rs, re, delimCursor, wMark, wHidden);
          base = ls.base;
          curLen = ls.curLen;
          cco = ls.cco;
          rs = ls.rs;
          re = ls.re;
          i = ls.i;
          textStart = ls.textStart;
          delimCursor = ls.delimCursor;
          continue;
        }
        // No wikilink matched: restore text_start so preceding text isn't double-emitted by the next span branch.
        textStart = i;
      }

      // Links: [text](url) or [text][ref]
      if (c === 91) {
        flushText(p, cb, cco, base, textStart, i);
        if (processLink(p, cb, cco, curLen, i, false, base)) {
          const ls = enterLabel(p, cb, co0, base, curLen, rs, re, delimCursor, wMark, wHidden);
          base = ls.base;
          curLen = ls.curLen;
          cco = ls.cco;
          rs = ls.rs;
          re = ls.re;
          i = ls.i;
          textStart = ls.textStart;
          delimCursor = ls.delimCursor;
        } else {
          at(p, base + i, base + i + 1);
          p.renderer.text(TX_NORMAL, cb, cco + i, cco + i + 1);
          i = ((i | 0) + 1) | 0;
          textStart = i;
        }
        continue;
      }

      // Images: ![text](url)
      if (c === 33 && i + 1 < curLen && (cb[cco + i + 1] | 0) === 91) {
        flushText(p, cb, cco, base, textStart, i);
        if (processLink(p, cb, cco, curLen, i + 1, true, base)) {
          const ls = enterLabel(p, cb, co0, base, curLen, rs, re, delimCursor, wMark, wHidden);
          base = ls.base;
          curLen = ls.curLen;
          cco = ls.cco;
          rs = ls.rs;
          re = ls.re;
          i = ls.i;
          textStart = ls.textStart;
          delimCursor = ls.delimCursor;
        } else {
          at(p, base + i, base + i + 1);
          p.renderer.text(TX_NORMAL, cb, cco + i, cco + i + 1);
          i = ((i | 0) + 1) | 0;
          textStart = i;
        }
        continue;
      }

      // Permissive autolinks: detect URL, email, and WWW autolinks. Suppress inside explicit links to avoid
      // double-wrapping (md4c issue #152)
      if (
        p.linkNestingLevel === 0 &&
        ((c === 58 && flags.permissiveUrlAutolinks) ||
          (c === 64 && flags.permissiveEmailAutolinks) ||
          (c === 46 && flags.permissiveWwwAutolinks))
      ) {
        // First try with strict boundaries, then with relaxed (emphasis-aware)
        let found = findPermissiveAutolink(p, cb, cco, curLen, i, false);
        if (!found) {
          found = findPermissiveAutolink(p, cb, cco, curLen, i, true);
          if (found && !isEmphBoundaryResolved(p, cb, cco, curLen, p.paBeg, p.paEnd, rs, re)) found = false;
        }
        if (found) {
          const aBeg = p.paBeg | 0;
          const aEnd = p.paEnd | 0;
          flushText(p, cb, cco, base, textStart, aBeg);

          // Determine URL prefix and render through the renderer
          at(p, base + aBeg, base + aBeg);
          const d = p.detail;
          d.reset();
          d.hrefBuf = cb;
          d.hrefStart = cco + aBeg;
          d.hrefEnd = cco + aEnd;
          d.permissiveAutolink = true;
          d.autolinkEmail = c === 64;
          d.autolinkWww = c === 46;
          p.renderer.enterSpan(SP_A, d);
          at(p, base + aBeg, base + aEnd);
          p.renderer.text(TX_NORMAL, cb, cco + aBeg, cco + aEnd);
          at(p, base + aEnd, base + aEnd);
          p.renderer.leaveSpan(SP_A);
          i = aEnd;
          textStart = i;
          continue;
        }
      }

      // Null character
      if (c === 0) {
        flushText(p, cb, cco, base, textStart, i);
        at(p, base + i, base + i + 1);
        p.renderer.text(TX_NULLCHAR, cb, 0, 0);
        i = ((i | 0) + 1) | 0;
        textStart = i;
        continue;
      }

      i = ((i | 0) + 1) | 0;
    }

    // Current slice fully walked: flush its trailing text, then either close the finished label and resume its
    // enclosing slice, or, for the outermost slice, finish.
    if (textStart < curLen) {
      at(p, base + textStart, base + curLen);
      p.renderer.text(TX_NORMAL, cb, cco + textStart, cco + curLen);
    }
    if (p.lfN === 0) break;
    p.lfN--;
    const lf = p.lf;
    const fi = p.lfN * LF_W;
    at(p, lf[fi + 8] | 0, lf[fi + 9] | 0);
    const leave = lf[fi + 7] | 0;
    if (leave === LL_ALT_TEXT) {
      // nothing
    } else if (leave === LL_IMAGE) {
      p.imageNestingLevel--;
      p.renderer.leaveSpan(SP_IMG);
    } else if (leave === LL_LINK) {
      p.linkNestingLevel--;
      p.renderer.leaveSpan(SP_A);
    } else if (leave === LL_WIKILINK) {
      p.renderer.leaveSpan(SP_WIKILINK);
    }
    base = lf[fi] | 0;
    curLen = (lf[fi + 1] | 0) - base;
    cco = co0 + base;
    i = lf[fi + 2] | 0;
    textStart = lf[fi + 3] | 0;
    // The storage of the label's delimiters is for the next label.
    p.edTop = rs;
    rs = lf[fi + 4] | 0;
    re = lf[fi + 5] | 0;
    delimCursor = lf[fi + 6] | 0;
  }

  p.edTop = 0;
}

/** Result of `enterLabel` (a tuple in Rust's macro): the walk state for the label. */
class LabelState {
  base = 0;
  curLen = 0;
  cco = 0;
  rs = 0;
  re = 0;
  i = 0;
  textStart = 0;
  delimCursor = 0;
}
const labelState = new LabelState();

/**
 * Enter the label of a just-parsed link/image/wikilink: snapshot the current walk state and restart the walk on the
 * label slice. Uses `p.lp*`.
 */
function enterLabel(
  p: Parser,
  cb: Uint8Array,
  co0: number,
  base: number,
  curLen: number,
  rs: number,
  re: number,
  delimCursor: number,
  walkMark: number,
  walkHidden: number,
): LabelState {
  if ((p.lfN + 1) * LF_W > p.lf.length) {
    const nl = new Int32Array(p.lf.length * 2);
    nl.set(p.lf);
    p.lf = nl;
  }
  const lf = p.lf;
  const fi = p.lfN * LF_W;
  const linkEnd = p.lpLinkEnd | 0;
  lf[fi] = base | 0;
  lf[fi + 1] = (base + curLen) | 0;
  lf[fi + 2] = linkEnd | 0;
  lf[fi + 3] = linkEnd | 0;
  lf[fi + 4] = rs | 0;
  lf[fi + 5] = re | 0;
  lf[fi + 6] = delimCursor | 0;
  lf[fi + 7] = p.lpLeave | 0;
  lf[fi + 8] = (base + p.lpLabelEnd) | 0;
  lf[fi + 9] = (base + linkEnd) | 0;
  p.lfN++;
  const nbase = base + p.lpLabelStart;
  const ncurLen = p.lpLabelEnd - p.lpLabelStart;
  const ncco = co0 + nbase;
  const nrs = p.edTop | 0;
  collectEmphasisDelimiters(p, cb, ncco, ncurLen, nbase, walkMark, walkHidden, true);
  const nre = p.edTop | 0;
  resolveEmphasisDelimiters(p, nrs, nre);
  const s = labelState;
  s.base = nbase;
  s.curLen = ncurLen;
  s.cco = ncco;
  s.rs = nrs;
  s.re = nre;
  s.i = 0;
  s.textStart = 0;
  s.delimCursor = 0;
  return s;
}

export function enterSpan(p: Parser, spanType: number): void {
  if (p.imageNestingLevel > 0) return;
  p.detail.reset();
  p.renderer.enterSpan(spanType, p.detail);
}

export function leaveSpan(p: Parser, spanType: number): void {
  if (p.imageNestingLevel > 0) return;
  p.renderer.leaveSpan(spanType);
}

export function emitText(p: Parser, textType: number, buf: Uint8Array, start: number, end: number): void {
  p.renderer.text(textType, buf, start, end);
}

/** Fills `marks` for `cb[co, co + cl)`. */
function findMarks(p: Parser, cb: Uint8Array, co: number, cl: number): void {
  if (cl > p.marks.length) growMarks(p, cl);
  const marks = p.marks;
  const map = p.markCharMap;
  let n = 0;
  let seen = 0;
  for (let index = 0; index < cl; index++) {
    const meaning = map[cb[co + index] | 0] | 0;
    if (meaning !== 0) {
      seen |= meaning;
      marks[n] = index | 0;
      n = (n + 1) | 0;
    }
  }
  p.marksN = n;
  p.marksSeen = seen;
}

export function pushHidden(p: Parser, beg: number, end: number, kind: number, aux: number): void {
  const n = p.hiddenN | 0;
  if (n === p.hBeg.length) {
    const m = n * 2;
    const a = new Int32Array(m);
    a.set(p.hBeg);
    p.hBeg = a;
    const b = new Int32Array(m);
    b.set(p.hEnd);
    p.hEnd = b;
    const c = new Int32Array(m);
    c.set(p.hKind);
    p.hKind = c;
    const d = new Int32Array(m);
    d.set(p.hAux);
    p.hAux = d;
  }
  p.hBeg[n] = beg | 0;
  p.hEnd[n] = end | 0;
  p.hKind[n] = kind | 0;
  p.hAux[n] = aux | 0;
  p.hiddenN = n + 1;
}

/** Tells a consumer that wants to know where `beg..end` of the block's inline content is in the document. */
export function at(p: Parser, beg: number, end: number): void {
  if (p.track) tellInlineSource(p, beg, end);
}

function tellInlineSource(p: Parser, beg: number, end: number): void {
  const b = inDocument(p, beg);
  const e = end === 0 ? inDocument(p, 0) : inDocument(p, end - 1) + 1;
  p.renderer.inlineSource(b, e);
}

/** Where the byte at `index` of the block's inline content is in the document. */
function inDocument(p: Parser, index: number): number {
  // The line of the last answer: where it starts, where the next one starts, where it starts in the document.
  if (index >= p.ilBeg && index < p.ilNext) return (p.ilDoc + (index - p.ilBeg)) | 0;
  return inDocumentSlow(p, index);
}

function inDocumentSlow(p: Parser, index: number): number {
  const lines = p.inlineLines.data;
  const count = p.inlineLines.len >> 1;
  // The last line that starts at or before `index`.
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid * 2] | 0) <= index) lo = mid + 1;
    else hi = mid;
  }
  const k = lo > 0 ? lo - 1 : 0;
  p.inlineLine = k;
  if (k < count) {
    p.ilBeg = lines[k * 2] | 0;
    p.ilDoc = lines[k * 2 + 1] | 0;
    p.ilNext = k + 1 < count ? lines[(k + 1) * 2] | 0 : BIG;
    return (p.ilDoc + (index - p.ilBeg)) | 0;
  }
  return 0;
}

/**
 * What the byte at `pos` of the content `cb[co, co + cl)` is in that hides the markers in it. It does not start before
 * `from`. Only the scan that fills the hidden table asks. Returns false if nothing; else `p.haBeg/haEnd/haKind/haAux`.
 */
export function hiddenAt(
  p: Parser,
  cb: Uint8Array,
  co: number,
  cl: number,
  pos: number,
  from: number,
  isAfterOpenBracket: boolean,
): boolean {
  const c = cb[co + pos] | 0;
  const meaning = p.markCharMap[c] | 0;
  if ((meaning & MARK_HIDES) === 0) return false;
  const ext = p.extensions;
  if (
    (meaning & MARK_EXTENSION) !== 0 &&
    ext !== null &&
    ext.span(cb, co, cl, pos, from, isAfterOpenBracket, p.inlineSerial) &&
    from <= ext.spanBeg &&
    ext.spanBeg <= pos &&
    ext.spanBeg < ext.spanEnd &&
    ext.spanEnd <= cl
  ) {
    p.haBeg = ext.spanBeg;
    p.haEnd = ext.spanEnd;
    p.haKind = HK_EXTENSION;
    p.haAux = ext.spanTag;
    return true;
  }
  let end: number;
  let kind: number;
  let aux = 0;
  if (c === 96) {
    const ticks = countBackticks(cb, co, cl, pos);
    const close = findCodeSpanEnd(cb, co, cl, pos + ticks, ticks);
    if (close >= 0) {
      end = close + ticks;
      kind = HK_CODE;
      aux = ticks;
    } else {
      end = pos + ticks;
      kind = HK_BACKTICKS;
    }
  } else if (c === 60 && !p.flags.noHtmlSpans) {
    const htmlEnd = findHtmlTag(p, cb, co, cl, pos);
    if (htmlEnd >= 0) {
      end = htmlEnd;
      kind = HK_HTML;
    } else {
      if (!findAutolink(p, cb, co, cl, pos)) return false;
      end = p.alEnd;
      kind = HK_AUTOLINK;
      aux = p.alIsEmail ? 1 : 0;
    }
  } else if (c === 91 && p.flags.footnotes) {
    const e = footnoteReferenceEnd(p, cb, co, cl, pos);
    if (e < 0) return false;
    end = e;
    kind = HK_FOOTNOTE_REFERENCE;
  } else {
    return false;
  }
  p.haBeg = pos;
  p.haEnd = end;
  p.haKind = kind;
  p.haAux = aux;
  return true;
}

/**
 * Emit emphasis opening tags (outermost to innermost) of the delimiter at `ed[di]`. `marker`: where the first of their
 * markers is. Returns it moved behind the last.
 */
function emitEmphOpenTags(p: Parser, di: number, markerIn: number): number {
  let marker = markerIn | 0;
  const num = p.ed[di + ED_OPEN_NUM] | 0;
  // First match = innermost, so emit in reverse (outermost first in HTML)
  for (let k = num - 1; k >= 0; k--) {
    const size = p.ed[di + ED_OPEN_SIZES + k] | 0;
    at(p, marker, marker + size);
    marker = ((marker | 0) + ((size) | 0)) | 0;
    if (size === 2) enterSpan(p, SP_STRONG);
    else enterSpan(p, SP_EM);
  }
  return marker;
}

/**
 * Emit emphasis closing tags (innermost to outermost). First entry in sizes was matched first (innermost), emit in
 * forward order.
 */
function emitEmphCloseTags(p: Parser, di: number, markerIn: number): number {
  let marker = markerIn | 0;
  const num = p.ed[di + ED_CLOSE_NUM] | 0;
  for (let k = 0; k < num; k++) {
    const size = p.ed[di + ED_CLOSE_SIZES + k] | 0;
    at(p, marker, marker + size);
    marker = ((marker | 0) + ((size) | 0)) | 0;
    if (size === 2) leaveSpan(p, SP_STRONG);
    else leaveSpan(p, SP_EM);
  }
  return marker;
}

/** Find the matching closing backtick run. Returns the end of content (before the closing ticks), or -1 if none. */
function findCodeSpanEnd(cb: Uint8Array, co: number, cl: number, start: number, count: number): number {
  let pos = start | 0;
  while (true) {
    // index_of_char_pos(content, '`', pos)
    let bt = pos | 0;
    while (bt < cl && (cb[co + bt] | 0) !== 96) bt = ((bt | 0) + 1) | 0;
    if (bt >= cl) return -1;
    pos = bt + 1;
    while (pos < cl && (cb[co + pos] | 0) === 96) pos = ((pos | 0) + 1) | 0;
    if (pos - bt === count) return bt;
  }
}

/** Count consecutive backticks starting at `start`. */
export function countBackticks(cb: Uint8Array, co: number, cl: number, start: number): number {
  let pos = start | 0;
  while (pos < cl && (cb[co + pos] | 0) === 96) pos = ((pos | 0) + 1) | 0;
  return pos - start;
}


function neighbor(p: Parser, codepoint: number): number {
  if (codepoint > 0xffff && compat.astralIsALetter(p.flags)) return N_OTHER;
  if (isUnicodeWhitespace(codepoint)) return N_WHITESPACE;
  if (isUnicodePunctuation(codepoint)) return N_PUNCTUATION;
  return N_OTHER;
}

// The results of `flanking`.
let flLeft = false;
let flRight = false;
let flBefore = N_OTHER;
let flAfter = N_OTHER;

function flankingOf(before: number, after: number): void {
  flBefore = before;
  flAfter = after;
  // Not followed by whitespace, and not followed by punctuation OR preceded by whitespace/punctuation
  flLeft = after !== N_WHITESPACE && (after !== N_PUNCTUATION || before !== N_OTHER);
  // Not preceded by whitespace, and not preceded by punctuation OR followed by whitespace/punctuation
  flRight = before !== N_WHITESPACE && (before !== N_PUNCTUATION || after !== N_OTHER);
}

/**
 * What the delimiter run from `runStart` to `runEnd` of the content has on its two sides. Around a label there are
 * brackets. Sets `flLeft`, `flRight`, `flBefore`, `flAfter`.
 */
function flanking(p: Parser, cb: Uint8Array, co: number, cl: number, runStart: number, runEnd: number, isLabel: boolean): void {
  if (runStart < cl && (cb[co + runStart] | 0) === 42 && compat.asterisksDoNotLookAround(p.flags)) {
    flLeft = true;
    flRight = true;
    flBefore = N_PUNCTUATION;
    flAfter = N_PUNCTUATION;
    return;
  }
  const edge = isLabel ? N_PUNCTUATION : N_WHITESPACE;
  const before = runStart === 0 ? edge : neighbor(p, decodeUtf8Backward(cb, co, cl, runStart));
  const after = runEnd < cl ? neighbor(p, decodeUtf8(cb, co, cl, runEnd)) : edge;
  flankingOf(before, after);
}

function canOpen(emphChar: number): boolean {
  // _ requires: left-flanking AND (not right-flanking OR preceded by punctuation)
  return flLeft && (emphChar !== 95 || !flRight || flBefore === N_PUNCTUATION);
}

function canClose(emphChar: number): boolean {
  // _ requires: right-flanking AND (not left-flanking OR followed by punctuation)
  return flRight && (emphChar !== 95 || !flLeft || flAfter === N_PUNCTUATION);
}

function pushDelim(p: Parser, pos: number, count: number, emphChar: number, open: boolean, close: boolean): void {
  const n = p.edTop | 0;
  if ((n + 1) * ED_W > p.ed.length) {
    const ne = new Int32Array(p.ed.length * 2);
    ne.set(p.ed);
    p.ed = ne;
  }
  const ed = p.ed;
  const di = n * ED_W;
  ed[di + ED_POS] = pos | 0;
  ed[di + ED_COUNT] = count | 0;
  ed[di + ED_CHAR] = emphChar | 0;
  ed[di + ED_CAN_OPEN] = open ? 1 : 0;
  ed[di + ED_CAN_CLOSE] = close ? 1 : 0;
  ed[di + ED_REMAINING] = count | 0;
  ed[di + ED_OPEN_COUNT] = 0;
  ed[di + ED_CLOSE_COUNT] = 0;
  ed[di + ED_OPEN_NUM] = 0;
  ed[di + ED_CLOSE_NUM] = 0;
  ed[di + ED_ACTIVE] = 1;
  p.edTop = n + 1;
}

/**
 * Collect emphasis delimiter runs from the slice `cb[co, co + cl)`, skipping code spans and HTML tags, appending to
 * the delimiter table at `p.edTop`. `base` is the offset of the slice within the content the brackets were built for.
 * `walkMark`/`walkHidden`: where the scan that asks is: not behind the start of the slice. `isLabel`: the slice is between
 * brackets.
 */
function collectEmphasisDelimiters(
  p: Parser,
  cb: Uint8Array,
  co: number,
  cl: number,
  base: number,
  walkMark: number,
  walkHidden: number,
  isLabel: boolean,
): void {
  if ((p.marksSeen & MARK_DELIMITER) === 0) return;
  const marks = p.marks;
  const markN = p.marksN | 0;
  const hBeg = p.hBeg;
  const hEnd = p.hEnd;
  const hiddenN = p.hiddenN | 0;
  let wMark = walkMark | 0;
  let wHidden = walkHidden | 0;
  const flags = p.flags;
  let i = 0;
  while (true) {
    const here = (base + i) | 0;
    while (wHidden < hiddenN && (hBeg[wHidden] | 0) < here) wHidden = ((wHidden | 0) + 1) | 0;
    while (wMark < markN && (marks[wMark] | 0) < here) wMark = ((wMark | 0) + 1) | 0;
    if (wMark >= markN) break;
    const mark = marks[wMark] | 0;
    if (mark >= base + cl) break;
    i = (mark - base) | 0;
    const c = cb[co + i] | 0;
    // Skip backslash escapes
    if (c === 92 && i + 1 < cl && isAsciiPunctuation(cb[co + i + 1] | 0)) {
      i = ((i | 0) + ((2) | 0)) | 0;
      continue;
    }
    // Skip code spans, HTML tags and autolinks
    if (
      wHidden < hiddenN &&
      (hBeg[wHidden] | 0) <= base + i &&
      (hEnd[wHidden] | 0) <= base + cl &&
      (hBeg[wHidden] | 0) >= base
    ) {
      i = ((hEnd[wHidden] | 0) - base) | 0;
      continue;
    }
    // Skip wiki links — like regular links they resolve before emphasis; the label gets its own collection pass.
    if (c === 91 && flags.wikiLinks && i + 1 < cl && (cb[co + i + 1] | 0) === 91) {
      if (matchWikiLink(p, cb, co, cl, i)) {
        i = p.wlInnerEnd + 2;
        continue;
      }
    }
    // Skip link/image constructs — links take precedence over emphasis (CommonMark §6.3)
    if (c === 91 || (c === 33 && i + 1 < cl && (cb[co + i + 1] | 0) === 91)) {
      const isImg = c === 33;
      const bracketStart = isImg ? i + 1 : i;
      if (bracketLink(p, base + bracketStart, isImg)) {
        const linkEnd = p.lkEnd - base;
        if (linkEnd >= 0 && linkEnd <= cl) {
          i = linkEnd;
          continue;
        }
      }
    }
    // Emphasis delimiter
    if (c === 42 || c === 95) {
      const runStart = i | 0;
      while (i < cl && (cb[co + i] | 0) === c) i = ((i | 0) + 1) | 0;
      const count = i - runStart;
      flanking(p, cb, co, cl, runStart, i, isLabel);
      if (compat.markerNextToMarkerFlanks(flags)) {
        const nx = i < cl ? cb[co + i] | 0 : 0;
        if (i < cl && (nx === 42 || nx === 95 || nx === 126)) flLeft = true;
        if (runStart > 0) {
          const pv = cb[co + runStart - 1] | 0;
          if (pv === 42 || pv === 95 || pv === 126) flRight = true;
        }
      }
      pushDelim(p, runStart, count, c, canOpen(c), canClose(c));
      continue;
    }
    // Strikethrough delimiter (1 or 2 tildes only)
    if (c === 126 && flags.strikethrough) {
      const runStart = i | 0;
      while (i < cl && (cb[co + i] | 0) === 126) i = ((i | 0) + 1) | 0;
      const count = i - runStart;
      if ((count === 1 && !flags.noSingleTilde) || count === 2) {
        flanking(p, cb, co, cl, runStart, i, isLabel);
        pushDelim(p, runStart, count, 126, canOpen(126), canClose(126));
      }
      continue;
    }
    i = ((i | 0) + 1) | 0;
  }
}

function openerBottomKey(ed: Int32Array, di: number): number {
  const ch = ed[di + ED_CHAR] | 0;
  const charIdx = ch === 42 ? 0 : ch === 95 ? 1 : ch === 126 ? 2 : 0;
  return (charIdx * 3 + ((ed[di + ED_COUNT] | 0) % 3)) * 2 + (ed[di + ED_CAN_OPEN] | 0);
}

const openersBottom = new Int32Array(18);

/** Resolve the emphasis delimiters `ed[rs, re)` using the CommonMark algorithm. */
function resolveEmphasisDelimiters(p: Parser, rs: number, re: number): void {
  const len = re - rs;
  if (len === 0) return;
  const ed = p.ed;
  openersBottom.fill(0);
  if (p.prevCandidate.length < len) p.prevCandidate = new Int32Array(Math.max(len, p.prevCandidate.length * 2));
  const prevCandidate = p.prevCandidate;
  for (let k = 0; k < len; k++) prevCandidate[k] = (k - 1) | 0;

  // Process potential closers from left to right
  let closerIdx = 0;
  while (closerIdx < len) {
    const ci = (rs + closerIdx) * ED_W;
    if ((ed[ci + ED_CAN_CLOSE] | 0) === 0 || (ed[ci + ED_REMAINING] | 0) === 0) {
      closerIdx = ((closerIdx | 0) + 1) | 0;
      continue;
    }

    // Look backward for a matching opener
    const key = openerBottomKey(ed, ci);
    const openerBottom = openersBottom[key] | 0;
    let foundMatch = false;
    if (closerIdx > openerBottom) {
      let from = closerIdx | 0;
      let oi = prevCandidate[closerIdx] | 0;
      while (oi !== -1 && oi >= openerBottom) {
        const oj = (rs + oi) * ED_W;
        if ((ed[oj + ED_CAN_OPEN] | 0) === 0 || (ed[oj + ED_REMAINING] | 0) === 0 || (ed[oj + ED_ACTIVE] | 0) === 0) {
          const next = prevCandidate[oi] | 0;
          prevCandidate[from] = next;
          oi = next;
          continue;
        }
        if ((ed[oj + ED_CHAR] | 0) !== (ed[ci + ED_CHAR] | 0)) {
          from = oi;
          oi = prevCandidate[oi] | 0;
          continue;
        }

        // Strikethrough: exact count match required
        if ((ed[oj + ED_CHAR] | 0) === 126 && (ed[oj + ED_COUNT] | 0) !== (ed[ci + ED_COUNT] | 0)) {
          from = oi;
          oi = prevCandidate[oi] | 0;
          continue;
        }

        // Rule of three: if closer can also open OR opener can also close, and the sum is a multiple of 3, and neither
        // is individually a multiple of 3, skip
        const oCount = ed[oj + ED_COUNT] | 0;
        const cCount = ed[ci + ED_COUNT] | 0;
        if (
          (ed[oj + ED_CHAR] | 0) !== 126 &&
          ((ed[oj + ED_CAN_CLOSE] | 0) !== 0 || (ed[ci + ED_CAN_OPEN] | 0) !== 0) &&
          (oCount + cCount) % 3 === 0 &&
          oCount % 3 !== 0 &&
          cCount % 3 !== 0
        ) {
          from = oi;
          oi = prevCandidate[oi] | 0;
          continue;
        }

        // Match found! Determine how many chars to use. For strikethrough (~): consume entire run at once
        let use: number;
        if ((ed[oj + ED_CHAR] | 0) === 126) use = ed[oj + ED_REMAINING] | 0;
        else if ((ed[oj + ED_REMAINING] | 0) >= 2 && (ed[ci + ED_REMAINING] | 0) >= 2) use = 2;
        else use = 1;

        ed[oj + ED_REMAINING] = ((ed[oj + ED_REMAINING] | 0) - use) | 0;
        ed[oj + ED_OPEN_COUNT] = ((ed[oj + ED_OPEN_COUNT] | 0) + use) | 0;
        if ((ed[oj + ED_OPEN_NUM] | 0) < MAX_EMPH_MATCHES) {
          const n = ed[oj + ED_OPEN_NUM] | 0;
          ed[oj + ED_OPEN_SIZES + n] = use | 0;
          ed[oj + ED_OPEN_NUM] = (n + 1) | 0;
        }
        ed[ci + ED_REMAINING] = ((ed[ci + ED_REMAINING] | 0) - use) | 0;
        ed[ci + ED_CLOSE_COUNT] = ((ed[ci + ED_CLOSE_COUNT] | 0) + use) | 0;
        if ((ed[ci + ED_CLOSE_NUM] | 0) < MAX_EMPH_MATCHES) {
          const n = ed[ci + ED_CLOSE_NUM] | 0;
          ed[ci + ED_CLOSE_SIZES + n] = use | 0;
          ed[ci + ED_CLOSE_NUM] = (n + 1) | 0;
        }

        // Remove all delimiters between opener and closer (CommonMark §6.4)
        let k = prevCandidate[closerIdx] | 0;
        while (k !== -1 && k > oi) {
          ed[(rs + k) * ED_W + ED_ACTIVE] = 0;
          k = prevCandidate[k] | 0;
        }
        prevCandidate[closerIdx] = oi | 0;

        foundMatch = true;

        // If closer still has remaining, re-process it (don't increment closer_idx)
        if ((ed[ci + ED_REMAINING] | 0) > 0 && (ed[ci + ED_CAN_CLOSE] | 0) !== 0) {
          // Decrement so the loop's increment brings us back to this same index, allowing another matching attempt
          // with the remaining delimiter characters
          closerIdx = ((closerIdx | 0) - 1) | 0;
        }
        break;
      }
    }

    // If no match, avoid rescanning the same failed prefix for this closer class.
    if (!foundMatch) {
      openersBottom[openerBottomKey(ed, ci)] = closerIdx | 0;
      if ((ed[ci + ED_CAN_OPEN] | 0) === 0) ed[ci + ED_ACTIVE] = 0;
    }

    closerIdx = ((closerIdx | 0) + 1) | 0;
  }
}

// ---- HTML tags ----

/**
 * True if a previous scan already proved there is no `kind` terminator at or after `scanStart` of the slice — either
 * recorded for the slice itself or for an enclosing slice that contains it.
 */
function htmlScanKnownUnterminated(p: Parser, co: number, cl: number, kind: number, scanStart: number): boolean {
  // offset_within
  if (!(p.memoAddr <= co && co + cl <= p.memoAddr + p.memoLen)) return false;
  const offset = co - p.memoAddr;
  return offset + scanStart >= (p.memoFrom[kind] | 0);
}

/** Record that the search for `kind`'s terminator starting at `scanStart` reached the end of the slice without a match. */
function noteUnterminatedHtmlScan(p: Parser, co: number, cl: number, kind: number, scanStart: number): void {
  if (!(p.memoAddr === co && p.memoLen === cl)) {
    if (p.memoAddr <= co && co + cl <= p.memoAddr + p.memoLen) {
      // A sub-slice scan stops at the sub-slice's end, so it proves nothing about the rest of the enclosing slice; keep
      // the enclosing entry (it already answers the sub-slice's later queries via offset_within).
      return;
    }
    p.memoFrom.fill(BIG);
    p.memoAddr = co;
    p.memoLen = cl;
  }
  if (scanStart < (p.memoFrom[kind] | 0)) p.memoFrom[kind] = scanStart | 0;
}

/** The end of the HTML tag at `start` of the slice (`<`), -1 if there is none. */
export function findHtmlTag(p: Parser, cb: Uint8Array, co: number, cl: number, start: number): number {
  if (start + 1 >= cl) return -1;

  let pos = start + 1;
  const c = cb[co + pos] | 0;

  // Closing tag: </tagname whitespace? >
  if (c === 47) {
    pos = ((pos | 0) + 1) | 0;
    if (pos >= cl || !isAlpha(cb[co + pos] | 0)) return -1;
    while (pos < cl) {
      const d = cb[co + pos] | 0;
      if (isAlphaNum(d) || d === 45) pos = ((pos | 0) + 1) | 0;
      else break;
    }
    // Skip whitespace (including newlines)
    while (pos < cl && isWhitespace(cb[co + pos] | 0)) pos = ((pos | 0) + 1) | 0;
    if (pos < cl && (cb[co + pos] | 0) === 62) return pos + 1;
    return -1;
  }

  // Comment: <!-- ... -->
  // Per CommonMark: text after <!-- must not start with > or ->
  if (c === 33 && pos + 1 < cl && (cb[co + pos + 1] | 0) === 45 && pos + 2 < cl && (cb[co + pos + 2] | 0) === 45) {
    pos = ((pos | 0) + ((3) | 0)) | 0;
    // Minimal comments: <!--> and <!--->
    if (pos < cl && (cb[co + pos] | 0) === 62) return pos + 1;
    if (pos + 1 < cl && (cb[co + pos] | 0) === 45 && (cb[co + pos + 1] | 0) === 62) return pos + 2;
    if (htmlScanKnownUnterminated(p, co, cl, HSK_COMMENT, pos)) return -1;
    const scanStart = pos | 0;
    while (pos + 2 < cl) {
      if ((cb[co + pos] | 0) === 45 && (cb[co + pos + 1] | 0) === 45 && (cb[co + pos + 2] | 0) === 62) return pos + 3;
      pos = ((pos | 0) + 1) | 0;
    }
    noteUnterminatedHtmlScan(p, co, cl, HSK_COMMENT, scanStart);
    return -1;
  }

  // HTML declaration: <! followed by a letter, ended by >
  if (c === 33 && pos + 1 < cl && isAlpha(cb[co + pos + 1] | 0)) {
    pos = ((pos | 0) + ((2) | 0)) | 0;
    if (htmlScanKnownUnterminated(p, co, cl, HSK_DECLARATION, pos)) return -1;
    const scanStart = pos | 0;
    while (pos < cl && (cb[co + pos] | 0) !== 62) pos = ((pos | 0) + 1) | 0;
    if (pos < cl) return pos + 1;
    noteUnterminatedHtmlScan(p, co, cl, HSK_DECLARATION, scanStart);
    return -1;
  }

  // CDATA section: <![CDATA[ ... ]]>
  if (
    c === 33 &&
    pos + 7 < cl &&
    (cb[co + pos + 1] | 0) === 91 &&
    (cb[co + pos + 2] | 0) === 67 &&
    (cb[co + pos + 3] | 0) === 68 &&
    (cb[co + pos + 4] | 0) === 65 &&
    (cb[co + pos + 5] | 0) === 84 &&
    (cb[co + pos + 6] | 0) === 65 &&
    (cb[co + pos + 7] | 0) === 91
  ) {
    pos = ((pos | 0) + ((8) | 0)) | 0;
    if (htmlScanKnownUnterminated(p, co, cl, HSK_CDATA, pos)) return -1;
    const scanStart = pos | 0;
    while (pos + 2 < cl) {
      if ((cb[co + pos] | 0) === 93 && (cb[co + pos + 1] | 0) === 93 && (cb[co + pos + 2] | 0) === 62) return pos + 3;
      pos = ((pos | 0) + 1) | 0;
    }
    noteUnterminatedHtmlScan(p, co, cl, HSK_CDATA, scanStart);
    return -1;
  }

  // Processing instruction: <? ... ?>
  if (c === 63) {
    pos = ((pos | 0) + 1) | 0;
    if (htmlScanKnownUnterminated(p, co, cl, HSK_PROCESSING_INSTRUCTION, pos)) return -1;
    const scanStart = pos | 0;
    while (pos + 1 < cl) {
      if ((cb[co + pos] | 0) === 63 && (cb[co + pos + 1] | 0) === 62) return pos + 2;
      pos = ((pos | 0) + 1) | 0;
    }
    noteUnterminatedHtmlScan(p, co, cl, HSK_PROCESSING_INSTRUCTION, scanStart);
    return -1;
  }

  // Opening tag: <tagname ...>
  if (isAlpha(c)) {
    while (pos < cl) {
      const d = cb[co + pos] | 0;
      if (isAlphaNum(d) || d === 45) pos = ((pos | 0) + 1) | 0;
      else break;
    }

    // Attributes (whitespace includes newlines for multi-line tags)
    while (pos < cl) {
      // Skip whitespace (spaces, tabs, newlines)
      let hadWs = false;
      while (pos < cl && isWhitespace(cb[co + pos] | 0)) {
        hadWs = true;
        pos = ((pos | 0) + 1) | 0;
      }

      if (pos >= cl) break;
      if ((cb[co + pos] | 0) === 62) return pos + 1;
      if ((cb[co + pos] | 0) === 47 && pos + 1 < cl && (cb[co + pos + 1] | 0) === 62) return pos + 2;

      if (!hadWs) return -1;

      // Attribute name
      const a0 = cb[co + pos] | 0;
      if (!isAlpha(a0) && a0 !== 95 && a0 !== 58) return -1;
      while (pos < cl) {
        const d = cb[co + pos] | 0;
        if (isAlphaNum(d) || d === 95 || d === 58 || d === 46 || d === 45) pos = ((pos | 0) + 1) | 0;
        else break;
      }

      // Attribute value (optional). Skip whitespace (save position in case = not found)
      const beforeEqWs = pos | 0;
      while (pos < cl && isWhitespace(cb[co + pos] | 0)) pos = ((pos | 0) + 1) | 0;
      if (pos < cl && (cb[co + pos] | 0) === 61) {
        pos = ((pos | 0) + 1) | 0;
        while (pos < cl && isWhitespace(cb[co + pos] | 0)) pos = ((pos | 0) + 1) | 0;
        if (pos >= cl) return -1;

        const q = cb[co + pos] | 0;
        if (q === 34) {
          pos = ((pos | 0) + 1) | 0;
          while (pos < cl && (cb[co + pos] | 0) !== 34) pos = ((pos | 0) + 1) | 0;
          if (pos >= cl) return -1;
          pos = ((pos | 0) + 1) | 0;
        } else if (q === 39) {
          pos = ((pos | 0) + 1) | 0;
          while (pos < cl && (cb[co + pos] | 0) !== 39) pos = ((pos | 0) + 1) | 0;
          if (pos >= cl) return -1;
          pos = ((pos | 0) + 1) | 0;
        } else {
          // Unquoted value: no whitespace, quotes, =, <, >, or backtick
          while (pos < cl) {
            const d = cb[co + pos] | 0;
            if (isWhitespace(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
            pos = ((pos | 0) + 1) | 0;
          }
        }
      } else {
        // No '=' found, restore position so whitespace is available for the next attribute's had_ws check
        pos = beforeEqWs;
      }
    }
  }

  return -1;
}

export { UTF8 };
