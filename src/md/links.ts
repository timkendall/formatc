// Port of vendor/bun/src/md/links.rs: links, images, wiki links, autolinks and footnote references.
//
// Inline content is `cb[co, co + cl)`; the offsets the functions take and return are relative to `co`.
import * as compat from "./compat.ts";
import { isAlpha, isAlphaNum, isAsciiPunctuation, isBlank, isWhitespace } from "./helpers.ts";
import { BIG, MARK_CLOSER, MARK_HIDES, MARK_OPENER } from "./state.ts";
import type { Parser } from "./state.ts";
import { MAX_LINK_LABEL_LEN, lookupRefDef, normalizeLabel } from "./ref_defs.ts";
import { chargeRefDefOutput } from "./state.ts";
import { REF_FOOTNOTE, REF_NONE, SP_A, SP_IMG, SP_WIKILINK, TX_NORMAL } from "./types.ts";
import { at, emitText, hiddenAt, pushHidden } from "./inlines.ts";
import { MAX_LINK_DEST_PAREN_DEPTH, MAX_WIKI_BRACKET_DEPTH, LL_ALT_TEXT, LL_IMAGE, LL_LINK, LL_WIKILINK, UNMATCHED } from "./links.consts.ts";
export { LL_ALT_TEXT, LL_IMAGE, LL_LINK, LL_WIKILINK } from "./links.consts.ts";


/**
 * CommonMark §6.3 link destination, shared by inline links, the link lookahead and reference definitions. In
 * `buf[off, off + len)` from `start`. Returns false if there is none. Else `p.sldDestS/E` is the destination, without
 * the `<` `>` of the angle-bracket form, and `p.sldEnd` is just past it (past the `>` of the angle-bracket form).
 */
export function scanLinkDestination(p: Parser, buf: Uint8Array, off: number, len: number, start: number): boolean {
  let q = start | 0;

  if (q < len && (buf[off + q] | 0) === 60) {
    q = ((q | 0) + 1) | 0;
    const destStart = q | 0;
    while (q < len) {
      const c = buf[off + q] | 0;
      if (c === 62) {
        p.sldDestS = destStart;
        p.sldDestE = q;
        p.sldEnd = q + 1;
        return true;
      }
      if (c === 60 || c === 10 || c === 13) return false;
      if (c === 92 && q + 1 < len && isAsciiPunctuation(buf[off + q + 1] | 0)) q = ((q | 0) + ((2) | 0)) | 0;
      else q = ((q | 0) + 1) | 0;
    }
    return false;
  }

  let parenDepth = 0;
  while (q < len && !isWhitespace(buf[off + q] | 0)) {
    const c = buf[off + q] | 0;
    if (c === 92 && q + 1 < len && isAsciiPunctuation(buf[off + q + 1] | 0)) {
      q = ((q | 0) + ((2) | 0)) | 0;
      continue;
    } else if (c === 40) {
      parenDepth = ((parenDepth | 0) + 1) | 0;
      if (parenDepth > MAX_LINK_DEST_PAREN_DEPTH) return false;
    } else if (c === 41) {
      if (parenDepth === 0) break;
      parenDepth = ((parenDepth | 0) - 1) | 0;
    } else if (c < 32 || c === 127) {
      return false;
    }
    q = ((q | 0) + 1) | 0;
  }
  if (parenDepth !== 0) return false;
  p.sldDestS = start;
  p.sldDestE = q;
  p.sldEnd = q;
  return true;
}

// ---- brackets: p.br, stride BR_W (open, close, linkEnd, isImage) ----

/**
 * Of the link, or the image, that the `[` at `open` starts: where its label ends (`p.lkClose`) and where it ends
 * (`p.lkEnd`). Returns false if it starts none.
 */
export function bracketLink(p: Parser, open: number, isImage: boolean): boolean {
  const br = p.br;
  let lo = 0;
  let hi = p.brN - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const o = br[mid * 4] | 0;
    if (o < open) lo = mid + 1;
    else if (o > open) hi = mid - 1;
    else {
      const linkEnd = br[mid * 4 + 2] | 0;
      const img = (br[mid * 4 + 3] | 0) !== 0;
      if (linkEnd !== 0 && img === isImage) {
        p.lkClose = br[mid * 4 + 1] | 0;
        p.lkEnd = linkEnd;
        return true;
      }
      return false;
    }
  }
  return false;
}

/** Nothing closes the brackets that are open, of which `top` is the last. */
function leaveOpen(p: Parser, topIn: number): void {
  let top = topIn | 0;
  const br = p.br;
  while (top !== UNMATCHED) {
    const index = top | 0;
    top = br[index * 4 + 1] | 0;
    br[index * 4 + 1] = UNMATCHED;
  }
}

function pushBracket(p: Parser, open: number, close: number, isImage: boolean): number {
  const n = p.brN | 0;
  if ((n + 1) * 4 > p.br.length) {
    const nb = new Int32Array(p.br.length * 2);
    nb.set(p.br);
    p.br = nb;
  }
  const br = p.br;
  br[n * 4] = open | 0;
  br[n * 4 + 1] = close | 0;
  br[n * 4 + 2] = 0;
  br[n * 4 + 3] = isImage ? 1 : 0;
  p.brN = n + 1;
  return n;
}

/**
 * Pair the brackets of `content`, whose marks have been found, and tell which of them are links, in a single pass (code
 * spans, HTML tags, autolinks and backslash escapes hide brackets). Fill the hidden table with what hides them.
 */
export function computeBracketMatches(p: Parser, cb: Uint8Array, co: number, cl: number): void {
  p.brN = 0;
  p.hiddenN = 0;

  // Without a '[' and a ']' there is no link.
  const hasPairs = (p.marksSeen & MARK_OPENER) !== 0 && (p.marksSeen & MARK_CLOSER) !== 0;
  if ((p.marksSeen & MARK_HIDES) === 0 && !hasPairs) return;

  // While an opener is still unmatched, its `close` slot holds the index of the previous unmatched opener — a stack
  // threaded through the table itself.
  let top = UNMATCHED;
  // The openers before this index that are still unmatched have a link in them: links cannot contain other links
  // (CommonMark §6.7)
  let inactiveBelow = 0;
  // Where the last backslash escape ends.
  let escapeEnd = 0;
  // Of the wiki links whose label `pos` is in: where what is around the label ends, and the opener that was the last before it.
  let wikiN = 0;
  // A label is content of its own.
  let end = cl | 0;
  // The marks are walked in order: the next one at or after `pos` (positions only grow). No need for the walk over the
  // hidden table here: this scan fills it.
  const marks = p.marks;
  const markN = p.marksN | 0;
  const markCharMap = p.markCharMap;
  let mi = 0;
  let pos = 0;
  // Up to where `content` is taken by what comes before brackets.
  let taken = 0;
  const flags = p.flags;
  while (true) {
    while (mi < markN && (marks[mi] | 0) < pos) mi = ((mi | 0) + 1) | 0;
    pos = mi < markN ? marks[mi] | 0 : BIG;
    if (pos >= end) {
      if (wikiN === 0) break;
      wikiN = ((wikiN | 0) - 1) | 0;
      const outerEnd = p.wikiStack[wikiN * 2] | 0;
      const outerTop = p.wikiStack[wikiN * 2 + 1] | 0;
      leaveOpen(p, top);
      pos = end + 2;
      taken = pos;
      end = outerEnd;
      top = outerTop;
      continue;
    }
    // content = content[..end]
    const c = cb[co + pos] | 0;
    if (c === 92) {
      pos = ((pos | 0) + 1) | 0;
      if (pos < end && isAsciiPunctuation(cb[co + pos] | 0)) {
        pos = ((pos | 0) + 1) | 0;
        escapeEnd = pos;
        taken = pos;
      }
      continue;
    }
    // Code spans, HTML tags and autolinks take precedence over brackets (CommonMark §6.3)
    if (((markCharMap[c] | 0) & MARK_HIDES) !== 0 && hiddenAt(p, cb, co, end, pos, taken, top !== UNMATCHED)) {
      pushHidden(p, p.haBeg, p.haEnd, p.haKind, p.haAux);
      pos = p.haEnd;
      taken = pos;
      continue;
    }
    if (c === 91) {
      const isImage = pos > 0 && (cb[co + pos - 1] | 0) === 33 && escapeEnd !== pos;
      if (
        flags.wikiLinks &&
        pos + 1 < end &&
        (cb[co + pos + 1] | 0) === 91 &&
        matchWikiLink(p, cb, co, end, pos) &&
        !(isImage && isImageAroundBrackets(p, cb, co, end, pos))
      ) {
        if ((wikiN + 1) * 2 > p.wikiStack.length) {
          const ns = new Int32Array(p.wikiStack.length * 2);
          ns.set(p.wikiStack);
          p.wikiStack = ns;
        }
        p.wikiStack[wikiN * 2] = end | 0;
        p.wikiStack[wikiN * 2 + 1] = top | 0;
        wikiN = ((wikiN | 0) + 1) | 0;
        end = p.wlInnerEnd;
        top = UNMATCHED;
        pos = p.wlPipePos >= 0 ? p.wlPipePos + 1 : p.wlInnerStart;
        taken = pos;
        continue;
      }
      top = pushBracket(p, pos, top, isImage);
    } else if (c === 93 && top !== UNMATCHED) {
      const index = top | 0;
      const open = p.br[index * 4] | 0;
      const isImage = (p.br[index * 4 + 3] | 0) !== 0;
      top = p.br[index * 4 + 1] | 0;
      p.br[index * 4 + 1] = pos | 0;
      if (isImage || index >= inactiveBelow) {
        const linkEnd = linkEndBehind(p, cb, co, end, open, pos);
        if (linkEnd >= 0) {
          p.br[index * 4 + 2] = linkEnd | 0;
          if (!isImage) inactiveBelow = index;
          pos = linkEnd;
          taken = pos;
          continue;
        }
      }
    }
    pos = ((pos | 0) + 1) | 0;
  }
  leaveOpen(p, top);
}

/**
 * Emit the opening span for a link/image whose label is about to be rendered, and return the matching close action for
 * the caller to run once the label content has been emitted. The destination and the title are ranges of `dbuf`/`tbuf`.
 */
function enterLabelSpan(
  p: Parser,
  dbuf: Uint8Array,
  destS: number,
  destE: number,
  tbuf: Uint8Array,
  titleS: number,
  titleE: number,
  isImage: boolean,
  reference: number,
  // Where the `[` is in the block's inline content.
  bracket: number,
): number {
  if (p.imageNestingLevel > 0) {
    // Inside image alt text: emit only text, no HTML tags
    return LL_ALT_TEXT;
  }
  const d = p.detail;
  d.reset();
  d.hrefBuf = dbuf;
  d.hrefStart = destS;
  d.hrefEnd = destE;
  d.titleBuf = tbuf;
  d.titleStart = titleS;
  d.titleEnd = titleE;
  d.reference = reference;
  if (isImage) {
    at(p, bracket - 1, bracket + 1);
    p.renderer.enterSpan(SP_IMG, d);
    p.imageNestingLevel++;
    return LL_IMAGE;
  }
  at(p, bracket, bracket + 1);
  p.renderer.enterSpan(SP_A, d);
  p.linkNestingLevel++;
  return LL_LINK;
}

/**
 * Parses the link or image whose `[` is at `start` of `cb[co, co + cl)` (`base`: where that is in the block's inline
 * content) and opens its span. Returns false if there is none. Else `p.lpLabelStart/End` is the label, to be rendered
 * as inline content, `p.lpLinkEnd` where to resume, and `p.lpLeave` the action to close it.
 */
export function processLink(
  p: Parser,
  cb: Uint8Array,
  co: number,
  cl: number,
  start: number,
  isImage: boolean,
  base: number,
): boolean {
  // start points at '['
  if (!bracketLink(p, base + start, isImage)) return false;
  const labelEnd = p.lkClose - base;
  if (!(labelEnd >= 0 && start < labelEnd && labelEnd < cl)) return false;
  const flags = p.flags;
  const labelS = start + 1;
  let q = labelEnd + 1; // skip ']'

  // Inline link: [text](url "title")
  if (q < cl && (cb[co + q] | 0) === 40) {
    q = ((q | 0) + 1) | 0;
    // Skip whitespace (including newlines from merged paragraph lines)
    while (q < cl) {
      const c = cb[co + q] | 0;
      if (isBlank(c) || c === 10 || c === 13) q = ((q | 0) + 1) | 0;
      else break;
    }

    let destS = 0;
    let destE = 0;
    if (scanLinkDestination(p, cb, co, cl, q)) {
      destS = p.sldDestS;
      destE = p.sldDestE;
      q = p.sldEnd;
    } else {
      // Not an inline link: skip the title and ')' checks, keep the reference/shortcut fallback.
      q = cl;
    }

    // Skip whitespace (including newlines)
    const destEnd = q | 0;
    while (q < cl) {
      const c = cb[co + q] | 0;
      if (isBlank(c) || c === 10 || c === 13) q = ((q | 0) + 1) | 0;
      else break;
    }

    // Optional title, with whitespace before it
    let titleS = 0;
    let titleE = 0;
    if (q < cl && q > destEnd) {
      const tc = cb[co + q] | 0;
      if (tc === 34 || tc === 39 || tc === 40) {
        const closeChar = tc === 40 ? 41 : tc;
        const titleOpen = q | 0;
        q = ((q | 0) + 1) | 0;
        const titleStart = q | 0;
        let titleValid = true;
        while (q < cl && (cb[co + q] | 0) !== closeChar) {
          const c = cb[co + q] | 0;
          if (c === 92 && q + 1 < cl) {
            q = ((q | 0) + ((2) | 0)) | 0;
            continue;
          }
          // A ()-delimited title may not contain an unescaped '('
          if (closeChar === 41 && c === 40 && !compat.parenthesisCanBeInATitle(flags)) {
            titleValid = false;
            break;
          }
          q = ((q | 0) + 1) | 0;
        }
        if (titleValid) {
          titleS = titleStart;
          titleE = q;
          if (q < cl) q = ((q | 0) + 1) | 0; // skip closing quote
        } else {
          q = titleOpen;
        }
      }
    }

    // Skip whitespace (including newlines)
    while (q < cl) {
      const c = cb[co + q] | 0;
      if (isBlank(c) || c === 10 || c === 13) q = ((q | 0) + 1) | 0;
      else break;
    }

    // Must end with ')'
    if (q < cl && (cb[co + q] | 0) === 41) {
      q = ((q | 0) + 1) | 0;
      const leave = enterLabelSpan(p, cb, co + destS, co + destE, cb, co + titleS, co + titleE, isImage, REF_NONE, base + start);
      p.lpLabelStart = labelS;
      p.lpLabelEnd = labelEnd;
      p.lpLinkEnd = q;
      p.lpLeave = leave;
      return true;
    }
  }

  // Reference link: [text][ref] or [text][] or shortcut [text]. A reference label must start immediately after the
  // closing ']'; a failed inline-link parse above may have advanced `pos` onto a later '[' (e.g. "[foo](bar [ref])"),
  // which must not be read as the reference (link_end_behind checks the byte after ']' too).
  q = labelEnd + 1;
  if (q < cl && (cb[co + q] | 0) === 91) {
    q = ((q | 0) + 1) | 0;
    const refStart = q | 0;
    while (q < cl && (cb[co + q] | 0) !== 93) {
      const c = cb[co + q] | 0;
      if (c === 91) break; // nested [ not allowed in ref
      if (c === 92 && q + 1 < cl) q = ((q | 0) + ((2) | 0)) | 0;
      else q = ((q | 0) + 1) | 0;
    }
    if (q < cl && (cb[co + q] | 0) === 93) {
      let rs: number;
      let re: number;
      let reference: number;
      if (q > refStart) {
        rs = refStart;
        re = q;
        reference = 1; // Full
      } else {
        rs = labelS;
        re = labelEnd;
        reference = 2; // Collapsed
      }
      q = ((q | 0) + 1) | 0;
      const idx = lookupRefDef(p, cb, co + rs, co + re);
      if (idx >= 0) {
        if (!chargeRefDefOutput(p, refDestLen(p, idx), refTitleLen(p, idx))) return false;
        const leave = enterRefLabelSpan(p, idx, isImage, reference, base + start);
        p.lpLabelStart = labelS;
        p.lpLabelEnd = labelEnd;
        p.lpLinkEnd = q;
        p.lpLeave = leave;
        return true;
      }
    }
  }

  // Shortcut reference link: [text] (no following [). Per CommonMark spec, shortcut refs must NOT be followed by [.
  // Note: if followed by ( and inline link parsing failed above, still try shortcut
  const charAfterLabel = labelEnd + 1 < cl ? cb[co + labelEnd + 1] | 0 : 0;
  if (charAfterLabel !== 91) {
    const idx = lookupRefDef(p, cb, co + labelS, co + labelEnd);
    if (idx >= 0) {
      if (!chargeRefDefOutput(p, refDestLen(p, idx), refTitleLen(p, idx))) return false;
      const leave = enterRefLabelSpan(p, idx, isImage, 3 /* Shortcut */, base + start);
      p.lpLabelStart = labelS;
      p.lpLabelEnd = labelEnd;
      p.lpLinkEnd = labelEnd + 1;
      p.lpLeave = leave;
      return true;
    }
  }

  return false;
}

function refDestLen(p: Parser, idx: number): number {
  return (p.refDefs[idx * 4 + 1] | 0) - (p.refDefs[idx * 4] | 0);
}

function refTitleLen(p: Parser, idx: number): number {
  return (p.refDefs[idx * 4 + 3] | 0) - (p.refDefs[idx * 4 + 2] | 0);
}

function enterRefLabelSpan(p: Parser, idx: number, isImage: boolean, reference: number, bracket: number): number {
  const rb = p.refBytes.data;
  const rd = p.refDefs;
  return enterLabelSpan(
    p,
    rb,
    rd[idx * 4] | 0,
    rd[idx * 4 + 1] | 0,
    rb,
    rd[idx * 4 + 2] | 0,
    rd[idx * 4 + 3] | 0,
    isImage,
    reference,
    bracket,
  );
}

/**
 * Where the link or the image ends whose label is between the `[` at `start` and the `]` at `labelEnd`, if what is behind
 * the label makes it one. -1 if it is none.
 */
function linkEndBehind(p: Parser, cb: Uint8Array, co: number, cl: number, start: number, labelEnd: number): number {
  const flags = p.flags;
  const pos = labelEnd + 1; // skip ]

  if (pos >= cl) {
    // Shortcut reference check
    return lookupRefDef(p, cb, co + start + 1, co + labelEnd) >= 0 ? labelEnd + 1 : -1;
  }

  // Inline link: ](...)
  if ((cb[co + pos] | 0) === 40) {
    let q = pos + 1;
    // Skip whitespace
    while (q < cl) {
      const c = cb[co + q] | 0;
      if (isBlank(c) || c === 10 || c === 13) q = ((q | 0) + 1) | 0;
      else break;
    }
    // Must agree with process_link, or emphasis collection desyncs from rendering.
    q = scanLinkDestination(p, cb, co, cl, q) ? p.sldEnd : cl;
    // Skip whitespace
    const destEnd = q | 0;
    while (q < cl) {
      const c = cb[co + q] | 0;
      if (isBlank(c) || c === 10 || c === 13) q = ((q | 0) + 1) | 0;
      else break;
    }
    // Optional title, with whitespace before it
    if (q < cl && q > destEnd) {
      const tc = cb[co + q] | 0;
      if (tc === 34 || tc === 39 || tc === 40) {
        const closeCh = tc === 40 ? 41 : tc;
        const titleOpen = q | 0;
        q = ((q | 0) + 1) | 0;
        let titleValid = true;
        while (q < cl && (cb[co + q] | 0) !== closeCh) {
          const c = cb[co + q] | 0;
          if (c === 92 && q + 1 < cl) {
            q = ((q | 0) + ((2) | 0)) | 0;
            continue;
          }
          // A ()-delimited title may not contain an unescaped '('
          if (closeCh === 41 && c === 40 && !compat.parenthesisCanBeInATitle(flags)) {
            titleValid = false;
            break;
          }
          q = ((q | 0) + 1) | 0;
        }
        if (titleValid) {
          if (q < cl) q = ((q | 0) + 1) | 0;
        } else {
          q = titleOpen;
        }
      }
    }
    // Skip whitespace
    while (q < cl) {
      const c = cb[co + q] | 0;
      if (isBlank(c) || c === 10 || c === 13) q = ((q | 0) + 1) | 0;
      else break;
    }
    if (q < cl && (cb[co + q] | 0) === 41) return q + 1;
  }

  // Reference link: ][...]
  if ((cb[co + pos] | 0) === 91) {
    let q = pos + 1;
    while (q < cl && (cb[co + q] | 0) !== 93) {
      const c = cb[co + q] | 0;
      if (c === 91) break;
      if (c === 92 && q + 1 < cl) q = ((q | 0) + ((2) | 0)) | 0;
      else q = ((q | 0) + 1) | 0;
    }
    if (q < cl && (cb[co + q] | 0) === 93) {
      const found = q > pos + 1 ? lookupRefDef(p, cb, co + pos + 1, co + q) : lookupRefDef(p, cb, co + start + 1, co + labelEnd);
      if (found >= 0) return q + 1;
    }
  }

  // Shortcut reference: like process_link, a shortcut must not be followed by '[' (the lookahead and the parser must
  // agree on what is a link)
  if (!(labelEnd + 1 < cl && (cb[co + labelEnd + 1] | 0) === 91)) {
    if (lookupRefDef(p, cb, co + start + 1, co + labelEnd) >= 0) return labelEnd + 1;
  }

  return -1;
}

/** `![[a]](b)` is an image. Whether the `[` at `open` is closed as one by the second `]` of the wiki link in `p.wl*`, which starts there. */
function isImageAroundBrackets(p: Parser, cb: Uint8Array, co: number, cl: number, open: number): boolean {
  const innerStart = p.wlInnerStart | 0;
  const innerEnd = p.wlInnerEnd | 0;
  let pos = innerStart | 0;
  let depth = 0;
  let taken = pos | 0;
  while (pos < innerEnd) {
    if ((cb[co + pos] | 0) === 92) {
      pos = ((pos | 0) + 1) | 0;
      if (pos < cl && isAsciiPunctuation(cb[co + pos] | 0)) {
        pos = ((pos | 0) + 1) | 0;
        taken = pos;
      }
      continue;
    }
    if (hiddenAt(p, cb, co, cl, pos, taken, true)) {
      pos = p.haEnd;
      taken = pos;
      continue;
    }
    const c = cb[co + pos] | 0;
    if (c === 91) depth = ((depth | 0) + 1) | 0;
    else if (c === 93 && depth === 0) return false;
    else if (c === 93) depth = ((depth | 0) - 1) | 0;
    pos = ((pos | 0) + 1) | 0;
  }
  return pos === innerEnd && depth === 0 && linkEndBehind(p, cb, co, cl, open, innerEnd + 1) >= 0;
}

/**
 * Lookahead-only match of `[[destination]]` / `[[destination|label]]`, shared by rendering and emphasis collection so they
 * agree. Fills `p.wlInnerStart`, `p.wlPipePos` (-1: none) and `p.wlInnerEnd`.
 */
export function matchWikiLink(p: Parser, cb: Uint8Array, co: number, cl: number, start: number): boolean {
  // start points at first '[', next char is also '['
  let q = start + 2;

  // Find closing ']]', checking for constraints
  const innerStart = q | 0;
  let pipePos = -1;
  let bracketDepth = 0;

  while (q < cl) {
    const c = cb[co + q] | 0;
    if (c === 10 || c === 13) return false;
    if (c === 91) {
      bracketDepth = ((bracketDepth | 0) + 1) | 0;
      if (bracketDepth > MAX_WIKI_BRACKET_DEPTH) return false;
    } else if (c === 93) {
      if (bracketDepth > 0) {
        bracketDepth = ((bracketDepth | 0) - 1) | 0;
      } else if (q + 1 < cl && (cb[co + q + 1] | 0) === 93) {
        break;
      } else {
        // Single ] without matching [, not a valid close
        return false;
      }
    } else if (c === 124 && pipePos < 0 && bracketDepth === 0) {
      pipePos = q;
    }
    q = ((q | 0) + 1) | 0;
  }

  // Must end with ]]
  if (q >= cl || (cb[co + q] | 0) !== 93) return false;

  const innerEnd = q | 0;

  // Target must not exceed 100 characters
  const targetEnd = pipePos >= 0 ? pipePos : innerEnd;
  if (targetEnd - innerStart > 100) return false;

  p.wlInnerStart = innerStart;
  p.wlPipePos = pipePos;
  p.wlInnerEnd = innerEnd;
  return true;
}

/** Process wiki link: [[destination]] or [[destination|label]]. Returns false if there is none; else see `processLink`. */
export function processWikiLink(p: Parser, cb: Uint8Array, co: number, cl: number, start: number, base: number): boolean {
  if (!matchWikiLink(p, cb, co, cl, start)) return false;
  const innerStart = p.wlInnerStart | 0;
  const pipePos = p.wlPipePos | 0;
  const innerEnd = p.wlInnerEnd | 0;

  // Render the wikilink
  at(p, base + start, base + start + 2);
  const d = p.detail;
  d.reset();
  d.hrefBuf = cb;
  d.hrefStart = co + innerStart;
  d.hrefEnd = co + (pipePos >= 0 ? pipePos : innerEnd);
  p.renderer.enterSpan(SP_WIKILINK, d);
  p.lpLabelStart = pipePos >= 0 ? pipePos + 1 : innerStart;
  p.lpLabelEnd = innerEnd;
  p.lpLinkEnd = innerEnd + 2; // skip both ']'
  p.lpLeave = LL_WIKILINK;
  return true;
}

/** `<...>` autolink at `start`: returns false if there is none; else `p.alEnd` and `p.alIsEmail`. */
export function findAutolink(p: Parser, cb: Uint8Array, co: number, cl: number, start: number): boolean {
  if (start + 1 >= cl) return false;

  const pos = start + 1;

  // Check for URI autolink: scheme://...
  if (isAlpha(cb[co + pos] | 0)) {
    let schemeEnd = pos | 0;
    while (schemeEnd < cl) {
      const c = cb[co + schemeEnd] | 0;
      if (isAlphaNum(c) || c === 43 || c === 45 || c === 46) schemeEnd = ((schemeEnd | 0) + 1) | 0;
      else break;
    }
    const schemeLen = schemeEnd - pos;
    if (schemeLen >= 2 && schemeLen <= 32 && schemeEnd < cl && (cb[co + schemeEnd] | 0) === 58) {
      // URI autolink
      let uriEnd = schemeEnd + 1;
      while (uriEnd < cl) {
        const c = cb[co + uriEnd] | 0;
        if (c === 62 || c === 60 || isWhitespace(c)) break;
        uriEnd = ((uriEnd | 0) + 1) | 0;
      }
      if (uriEnd < cl && (cb[co + uriEnd] | 0) === 62) {
        p.alEnd = uriEnd + 1;
        p.alIsEmail = false;
        return true;
      }
    }
  }

  // Check for email autolink
  let emailPos = pos | 0;
  // username part
  while (emailPos < cl) {
    const c = cb[co + emailPos] | 0;
    if (isAlphaNum(c) || isEmailLocalChar(c)) emailPos = ((emailPos | 0) + 1) | 0;
    else break;
  }
  if (emailPos < cl && (cb[co + emailPos] | 0) === 64 && emailPos > pos) {
    emailPos = ((emailPos | 0) + 1) | 0;
    // domain part: labels separated by '.', each 1-63 chars, alphanumeric or hyphen, which is neither the first nor the last of them
    let labelLen = 0;
    let validDomain = true;
    while (emailPos < cl) {
      const c = cb[co + emailPos] | 0;
      if (!(isAlphaNum(c) || c === 46 || c === 45)) break;
      if (c === 46) {
        if (labelLen === 0 || (cb[co + emailPos - 1] | 0) === 45) {
          validDomain = false;
          break;
        }
        labelLen = 0;
      } else {
        if (labelLen === 0 && c === 45) {
          validDomain = false;
          break;
        }
        labelLen = ((labelLen | 0) + 1) | 0;
        if (labelLen > 63) {
          validDomain = false;
          break;
        }
      }
      emailPos = ((emailPos | 0) + 1) | 0;
    }
    if (
      validDomain &&
      emailPos < cl &&
      (cb[co + emailPos] | 0) === 62 &&
      labelLen > 0 &&
      isAlphaNum(cb[co + emailPos - 1] | 0)
    ) {
      p.alEnd = emailPos + 1;
      p.alIsEmail = true;
      return true;
    }
  }

  return false;
}

/** b".!#$%&'*+/=?^_`{|}~-" */
function isEmailLocalChar(c: number): boolean {
  switch (c) {
    case 46: case 33: case 35: case 36: case 37: case 38: case 39: case 42: case 43: case 47: case 61: case 63:
    case 94: case 95: case 96: case 123: case 124: case 125: case 126: case 45:
      return true;
    default:
      return false;
  }
}

export function renderAutolink(
  p: Parser,
  cb: Uint8Array,
  urlS: number,
  urlE: number,
  isEmail: boolean,
  // Where the `<` is in the block's inline content.
  beg: number,
): void {
  at(p, beg, beg + 1);
  const d = p.detail;
  d.reset();
  d.hrefBuf = cb;
  d.hrefStart = urlS;
  d.hrefEnd = urlE;
  d.autolink = true;
  d.autolinkEmail = isEmail;
  p.renderer.enterSpan(SP_A, d);
  const n = urlE - urlS;
  at(p, beg + 1, beg + 1 + n);
  emitText(p, TX_NORMAL, cb, urlS, urlE);
  at(p, beg + 1 + n, beg + 2 + n);
  p.renderer.leaveSpan(SP_A);
}

/** Where the `[^label]` at `pos` ends, if a footnote of that name is defined. -1 if none. */
export function footnoteReferenceEnd(p: Parser, cb: Uint8Array, co: number, cl: number, pos: number): number {
  if (pos + 1 >= cl || (cb[co + pos + 1] | 0) !== 94) return -1;
  const labelBeg = pos + 2;
  let end = labelBeg | 0;
  while (true) {
    if (end >= cl) return -1;
    const c = cb[co + end] | 0;
    if (c === 93) break;
    if (c === 91 || c === 32 || c === 9 || c === 10 || c === 13) return -1;
    if (c === 92 && end + 1 < cl) {
      const n = cb[co + end + 1] | 0;
      if (n === 91 || n === 92 || n === 93) end = ((end | 0) + ((2) | 0)) | 0;
      else end = ((end | 0) + 1) | 0;
    } else {
      end = ((end | 0) + 1) | 0;
    }
    if (end - labelBeg > MAX_LINK_LABEL_LEN) return -1;
  }
  const len = normalizeLabel(p, cb, co + labelBeg, co + end);
  return len !== 0 && p.footnoteLabels.contains(p.normBuf.data, 0, len) ? end + 1 : -1;
}

export function renderFootnoteReference(
  p: Parser,
  cb: Uint8Array,
  labelS: number,
  labelE: number,
  // Where the `[` is in the block's inline content.
  beg: number,
): void {
  if (p.imageNestingLevel > 0) return;
  at(p, beg, beg + 2);
  const d = p.detail;
  d.reset();
  d.hrefBuf = cb;
  d.hrefStart = labelS;
  d.hrefEnd = labelE;
  d.reference = REF_FOOTNOTE;
  p.renderer.enterSpan(SP_A, d);
  const n = labelE - labelS;
  at(p, beg + 2 + n, beg + 3 + n);
  p.renderer.leaveSpan(SP_A);
}

