// Port of vendor/bun/src/md/containers.rs.
import * as compat from "./compat.ts";
import { HDR, LINE_W, Container, appendBlockHeader } from "./state.ts";
import type { Parser } from "./state.ts";
import {
  BLOCK_CONTAINER_CLOSER,
  BLOCK_CONTAINER_OPENER,
  BLOCK_DIRECTIVE,
  BLOCK_FOOTNOTE,
  BLOCK_LOOSE_LIST,
  BLOCK_REF_DEF_ONLY,
  BT_H,
  BT_LI,
  BT_OL,
  BT_QUOTE,
  BT_UL,
  BT_P,
  BT_CODE,
  BT_HR,
  BT_HTML,
  BT_TABLE,
} from "./types.ts";
import { isListBullet } from "./autolinks.ts";
import { normalizeLabel } from "./ref_defs.ts";
import { enterBlock, leaveBlock, processCodeBlock, processHtmlBlock, processTableBlock } from "./render_blocks.ts";
import { processLeafBlock } from "./inlines.ts";

export function keepsQuotes(p: Parser): boolean {
  return p.track || compat.tagDoesNotEndAList(p.flags);
}

/** How many containers are open up to the innermost `>`, with it. */
export function containersUpToQuote(p: Parser): number {
  return p.quotesN === 0 ? 0 : (p.quotes[p.quotesN - 1] | 0) + 1;
}

// ---- container_ends: a deque of (count, end), counts fall from the front to the back ----

function ceGrow(p: Parser): void {
  const old = p.ceCount.length | 0;
  const nc = new Int32Array(old * 2);
  const ne = new Int32Array(old * 2);
  for (let i = 0; i < p.ceLen; i++) {
    const at = (p.ceHead + i) & (old - 1);
    nc[i] = p.ceCount[at] | 0;
    ne[i] = p.ceEnd[at] | 0;
  }
  p.ceCount = nc;
  p.ceEnd = ne;
  p.ceHead = 0;
}

/** A line ends at `end` that is in the first `count` of the open containers. Their counts fall from the front to the back. */
export function setContainerEnds(p: Parser, count: number, end: number): void {
  // pop_back_if(count <= count)
  while (p.ceLen > 0) {
    const at = (p.ceHead + p.ceLen - 1) & (p.ceCount.length - 1);
    if ((p.ceCount[at] | 0) <= count) p.ceLen--;
    else break;
  }
  if (count > 0) {
    if (p.ceLen === p.ceCount.length) ceGrow(p);
    const at = (p.ceHead + p.ceLen) & (p.ceCount.length - 1);
    p.ceCount[at] = count | 0;
    p.ceEnd[at] = end | 0;
    p.ceLen++;
  }
}

/** Where the last line ends that is in the container at `index`. See `Renderer.containerSource`. */
export function containerEnd(p: Parser, index: number): number {
  // iter().take_while(|it| it.count > index).last().map_or(0, end)
  let last = 0;
  for (let i = 0; i < p.ceLen; i++) {
    const at = (p.ceHead + i) & (p.ceCount.length - 1);
    if ((p.ceCount[at] | 0) > index) last = p.ceEnd[at] | 0;
    else break;
  }
  return last;
}

/** The same for the innermost container, which is left. */
function takeContainerEnd(p: Parser, index: number): number {
  let end = 0;
  let found = false;
  // pop_front_if(count > index)
  while (p.ceLen > 0) {
    const at = p.ceHead & (p.ceCount.length - 1);
    if ((p.ceCount[at] | 0) > index) {
      end = p.ceEnd[at] | 0;
      found = true;
      p.ceHead = (p.ceHead + 1) & (p.ceCount.length - 1);
      p.ceLen--;
    } else {
      break;
    }
  }
  // It still holds for those further out of which nothing later is said.
  if (found && (p.ceLen === 0 || (p.ceCount[p.ceHead & (p.ceCount.length - 1)] | 0) < index) && index > 0) {
    if (p.ceLen === p.ceCount.length) ceGrow(p);
    p.ceHead = (p.ceHead - 1) & (p.ceCount.length - 1);
    p.ceCount[p.ceHead] = index | 0;
    p.ceEnd[p.ceHead] = end | 0;
    p.ceLen++;
  }
  return found ? end : 0;
}

export function pushContainer(p: Parser, c: Container): void {
  const n = p.nContainers | 0;
  if (n >= p.containers.length) p.containers.push(new Container());
  const slot = p.containers[n];
  slot.copyFrom(c);
  if (n >= p.containersLen) p.containersLen = n + 1;

  // Record block_byte offset in the container.
  slot.blockByteOff = p.bbLen;
  if (c.ch === 58) {
    if (p.directivesN === p.directives.length) p.directives = grow32(p.directives);
    p.directives[p.directivesN++] = n | 0;
  }
  if (c.ch === 62 && keepsQuotes(p)) {
    if (p.quotesN === p.quotes.length) p.quotes = grow32(p.quotes);
    p.quotes[p.quotesN++] = n | 0;
  }

  p.nContainers = n + 1;
}

function grow32(a: Int32Array): Int32Array {
  const n = new Int32Array(a.length * 2);
  n.set(a);
  return n;
}

/** `beg, end, indent`: what `Renderer.containerSource` is told for this opener or closer. */
export function pushContainerBytes(
  p: Parser,
  blockType: number,
  data: number,
  flags: number,
  beg: number,
  end: number,
  indent: number,
): void {
  if (p.track) {
    const cs = p.containerSources;
    cs.push(beg);
    cs.push(end);
    cs.push(indent);
  }
  appendBlockHeader(p, blockType, flags, data);
}

export function enterChildContainers(p: Parser, count: number): void {
  const text = p.text;
  let i = p.nContainers - count;
  while (i < p.nContainers) {
    // Capture the container fields before calling other functions.
    const c = p.containers[i];
    const ch = c.ch | 0;
    const isTask = c.isTask;
    const taskMarkOff = c.taskMarkOff | 0;
    const start = c.start | 0;
    const markBeg = c.markBeg | 0;
    const markEnd = c.markEnd | 0;
    const markIndent = c.markIndent | 0;

    // Emit container opener blocks
    if (ch === 62) {
      pushContainerBytes(p, BT_QUOTE, 0, BLOCK_CONTAINER_OPENER, markBeg, markEnd, markIndent);
    } else if (ch === 94) {
      const len = normalizeLabel(p, text, markBeg + 2, Math.max(markEnd - 2, 0));
      p.footnoteLabels.insert(p.normBuf.data, 0, len);
      pushContainerBytes(p, BT_QUOTE, 0, BLOCK_CONTAINER_OPENER | BLOCK_FOOTNOTE, markBeg, markEnd, markIndent);
    } else if (ch === 58) {
      pushContainerBytes(p, BT_QUOTE, 0, BLOCK_CONTAINER_OPENER | BLOCK_DIRECTIVE, markBeg, markEnd, markIndent);
    } else if (ch === 45 || ch === 43 || ch === 42) {
      // Save opener position for later loose-list patching
      c.blockByteOff = p.bbLen;
      // Unordered list + list item
      pushContainerBytes(p, BT_UL, 0, BLOCK_CONTAINER_OPENER, markBeg, markEnd, markIndent);
      pushContainerBytes(
        p,
        BT_LI,
        isTask ? text[taskMarkOff] | 0 : 0,
        BLOCK_CONTAINER_OPENER,
        markBeg,
        markEnd,
        markIndent,
      );
    } else if (ch === 46 || ch === 41) {
      // Save opener position for later loose-list patching
      c.blockByteOff = p.bbLen;
      // Ordered list + list item
      pushContainerBytes(p, BT_OL, start, BLOCK_CONTAINER_OPENER, markBeg, markEnd, markIndent);
      pushContainerBytes(
        p,
        BT_LI,
        isTask ? text[taskMarkOff] | 0 : 0,
        BLOCK_CONTAINER_OPENER,
        markBeg,
        markEnd,
        markIndent,
      );
    }
    i = ((i | 0) + 1) | 0;
  }
}

export function leaveChildContainers(p: Parser, keep: number): void {
  const text = p.text;
  while (p.nContainers > keep) {
    p.nContainers--;
    const n = p.nContainers | 0;
    if (p.directivesN > 0 && (p.directives[p.directivesN - 1] | 0) === n) p.directivesN--;
    if (p.quotesN > 0 && (p.quotes[p.quotesN - 1] | 0) === n) p.quotesN--;
    const containerEnd = takeContainerEnd(p, n);
    // Capture the container fields before calling other functions.
    const c = p.containers[n];
    const ch = c.ch | 0;
    const isLoose = c.isLoose;
    const isTask = c.isTask;
    const taskMarkOff = c.taskMarkOff | 0;
    const start = c.start | 0;
    const blockByteOff = c.blockByteOff | 0;
    const looseFlag = isLoose ? BLOCK_LOOSE_LIST : 0;
    const isEndedByColons = p.isDirectiveEnd && n === keep;
    const endBeg = p.lineBeg | 0;
    const endIndent = isEndedByColons ? 1 : 0;

    // Emit container closer blocks
    if (ch === 62 || ch === 94 || ch === 58) {
      pushContainerBytes(p, BT_QUOTE, 0, BLOCK_CONTAINER_CLOSER, endBeg, containerEnd, endIndent);
    } else if (ch === 45 || ch === 43 || ch === 42) {
      // Retroactively patch the opener with loose flag
      if (isLoose && blockByteOff < p.bbLen) {
        p.bb[blockByteOff + 1] = (p.bb[blockByteOff + 1] | BLOCK_LOOSE_LIST) | 0;
      }
      pushContainerBytes(p, BT_LI, isTask ? text[taskMarkOff] | 0 : 0, BLOCK_CONTAINER_CLOSER, endBeg, containerEnd, endIndent);
      pushContainerBytes(p, BT_UL, 0, BLOCK_CONTAINER_CLOSER | looseFlag, endBeg, containerEnd, endIndent);
    } else if (ch === 46 || ch === 41) {
      // Retroactively patch the opener with loose flag
      if (isLoose && blockByteOff < p.bbLen) {
        p.bb[blockByteOff + 1] = (p.bb[blockByteOff + 1] | BLOCK_LOOSE_LIST) | 0;
      }
      pushContainerBytes(p, BT_LI, isTask ? text[taskMarkOff] | 0 : 0, BLOCK_CONTAINER_CLOSER, endBeg, containerEnd, endIndent);
      pushContainerBytes(p, BT_OL, start, BLOCK_CONTAINER_CLOSER | looseFlag, endBeg, containerEnd, endIndent);
    }
  }
}

export function isContainerCompatible(existing: Container, nw: Container): boolean {
  // Same container type
  if (existing.ch === 62 && nw.ch === 62) return true;
  // Same list marker type
  if (existing.ch === nw.ch) return existing.ch !== 94 && existing.ch !== 58;
  // Bullet lists: different bullet chars are compatible
  if (isListBullet(existing.ch) && isListBullet(nw.ch)) return false;
  return false;
}

export function processAllBlocks(p: Parser): void {
  let off = 0;
  const bytesLen = p.bbLen | 0;
  const bb = p.bb;

  // Reuse containers array for tight/loose tracking (same approach as md4c). The containers are no longer needed for
  // line analysis at this point.
  p.nContainers = 0;
  let nextContainerSource = 0;
  let blockLines = new Int32Array(LINE_W * 8);

  while (off < bytesLen) {
    if (off + HDR > bytesLen) break;

    const blockType = bb[off] | 0;
    const flags = bb[off + 1] | 0;
    const data = bb[off + 2] | 0;
    const nLines = bb[off + 3] | 0;
    off = ((off | 0) + ((HDR) | 0)) | 0;

    // Read lines after header
    const linesSize = nLines * LINE_W;
    if (off + linesSize > bytesLen) break;
    if (blockLines.length < linesSize) blockLines = new Int32Array(Math.max(linesSize, blockLines.length * 2));
    for (let i = 0; i < linesSize; i++) blockLines[i] = bb[off + i] | 0;
    off = ((off | 0) + ((linesSize) | 0)) | 0;

    if (p.track && (flags & (BLOCK_CONTAINER_OPENER | BLOCK_CONTAINER_CLOSER)) !== 0) {
      if (nextContainerSource * 3 < p.containerSources.len) {
        const cs = p.containerSources.data;
        p.renderer.containerSource(
          cs[nextContainerSource * 3] | 0,
          cs[nextContainerSource * 3 + 1] | 0,
          cs[nextContainerSource * 3 + 2] | 0,
        );
      }
      nextContainerSource = ((nextContainerSource | 0) + 1) | 0;
    }

    // Handle container openers/closers
    if ((flags & BLOCK_CONTAINER_OPENER) !== 0) {
      enterBlock(p, blockType, data, flags);
      // Track tight/loose state per container level (md4c approach)
      if (blockType === BT_UL || blockType === BT_OL) {
        if (p.nContainers < p.containersLen) {
          p.containers[p.nContainers].isLoose = (flags & BLOCK_LOOSE_LIST) !== 0;
          p.nContainers++;
        }
      } else if (blockType === BT_QUOTE) {
        // Blockquotes always act as "loose" — content inside blockquotes always gets <p> tags even when nested inside tight lists
        if (p.nContainers < p.containersLen) {
          p.containers[p.nContainers].isLoose = true;
          p.nContainers++;
        }
      }
      continue;
    }
    if ((flags & BLOCK_CONTAINER_CLOSER) !== 0) {
      if (blockType === BT_UL || blockType === BT_OL || blockType === BT_QUOTE) {
        if (p.nContainers > 0) p.nContainers--;
      }
      leaveBlock(p, blockType, data);
      continue;
    }

    // Skip paragraph blocks consumed entirely by ref defs
    if ((flags & BLOCK_REF_DEF_ONLY) !== 0) continue;

    // Determine if we're in a tight list (md4c approach: check innermost container)
    const isInTightList = !p.track && p.nContainers > 0 && !p.containers[p.nContainers - 1].isLoose;
    const isReadByConsumer = p.track && p.renderer.leafSource(blockType, blockLines, nLines);

    // Process leaf blocks — skip <p> enter/leave in tight lists
    if (!isInTightList || blockType !== BT_P) enterBlock(p, blockType, data, flags);
    if (isReadByConsumer) {
      // nothing
    } else if (blockType === BT_HR) {
      // nothing
    } else if (blockType === BT_CODE) {
      processCodeBlock(p, blockLines, nLines, data, flags);
    } else if (blockType === BT_HTML) {
      processHtmlBlock(p, blockLines, nLines);
    } else if (blockType === BT_TABLE) {
      processTableBlock(p, blockLines, nLines, data);
    } else if (blockType === BT_P) {
      processLeafBlock(p, blockLines, nLines, true);
    } else if (blockType === BT_H) {
      processLeafBlock(p, blockLines, nLines, true);
    } else {
      processLeafBlock(p, blockLines, nLines, false);
    }
    if (!isInTightList || blockType !== BT_P) leaveBlock(p, blockType, data);
  }
}
