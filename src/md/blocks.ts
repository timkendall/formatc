// Port of vendor/bun/src/md/blocks.rs: line by line block analysis.
import * as compat from "./compat.ts";
import { isBlank, isNewline, lineIndentation } from "./helpers.ts";
import { HDR, LINE_W, appendBlockHeader, growBb } from "./state.ts";
import type { Container, Line, Parser } from "./state.ts";
import {
  BLOCK_CLOSED,
  BLOCK_CONTAINER_CLOSER,
  BLOCK_CONTAINER_OPENER,
  BLOCK_EXTENSION,
  BLOCK_FENCED_CODE,
  BLOCK_HTML_UNTIL_TEXT,
  BLOCK_REF_DEF_ONLY,
  BLOCK_SETEXT_HEADER,
  BT_CODE,
  BT_DOC,
  BT_H,
  BT_HR,
  BT_HTML,
  BT_LI,
  BT_P,
  BT_TABLE,
  L_ATXHEADER,
  L_BLANK,
  L_FENCEDCODE,
  L_HR,
  L_HTML,
  L_INDENTEDCODE,
  L_SETEXTUNDERLINE,
  L_TABLE,
  L_TABLEUNDERLINE,
  L_TEXT,
  OFF_MAX,
} from "./types.ts";
import { isListItemMark } from "./autolinks.ts";
import {
  containersUpToQuote,
  containerEnd,
  enterChildContainers,
  leaveChildContainers,
  processAllBlocks,
  pushContainer,
  pushContainerBytes,
  isContainerCompatible,
  setContainerEnds,
} from "./containers.ts";
import {
  countTableRowColumns,
  endsDirective,
  isAtxHeaderLine,
  isClosingCodeFence,
  isContainerMark,
  isHrLine,
  isHtmlBlockEndCondition,
  isHtmlBlockStartCondition,
  isOpeningCodeFence,
  isSetextUnderline,
  isTableUnderline,
  startsContainerInParagraph,
} from "./line_analysis.ts";
import { buildRefDefHashtable, normalizeLabel, parseRefDef } from "./ref_defs.ts";
import { enterBlock, leaveBlock } from "./render_blocks.ts";

export function processDoc(p: Parser): void {
  const pivot = p.pivot;
  pivot.reset();
  pivot.type = L_BLANK;
  p.line0.reset();
  p.line1.reset();
  p.lineIdx = 0;
  let off = 0;

  enterBlock(p, BT_DOC, 0, 0);

  while (off < p.size) {
    const line = p.lineIdx === 0 ? p.line0 : p.line1;
    off = analyzeLine(p, off, pivot, line);
    // process_line swaps the lines.
    processLine(p, pivot, line);
  }

  endCurrentBlock(p);
  if (p.track) p.renderer.lineStarts(p.lineStarts.data, p.lineStarts.len);

  // Build ref def hashtable
  buildRefDefHashtable(p);

  // Process all blocks
  p.lineBeg = OFF_MAX;
  leaveChildContainers(p, 0);
  processAllBlocks(p);

  leaveBlock(p, BT_DOC, 0);
}

/** Analyzes the line that starts at `offStart`. Returns where the next one starts. */
export function analyzeLine(p: Parser, offStart: number, pivotLine: Line, line: Line): number {
  const text = p.text;
  const size = p.size | 0;
  let off = offStart | 0;
  p.lineBeg = offStart;
  if (p.track) p.lineStarts.push(offStart);
  let totalIndent = 0;
  let nParents = 0;
  let nBrothers = 0;
  let nChildren = 0;
  const container = p.lineContainer;
  container.reset();
  const prevLineHasListLooseningEffect = p.lastLineHasListLooseningEffect;
  // The line before is the marker of a list item and nothing else.
  const followsEmptyItem =
    p.lastHeaderOpensListItem && p.currentBlock < 0 && !p.lastListItemStartsWithTwoBlankLines;
  const followsTaskMark = p.lastLineIsOnlyATaskMark;
  p.lastLineIsOnlyATaskMark = false;
  // Nothing is on the line but the markers of containers that were open before it.
  let isEmpty = false;
  const codeIndentOffset = p.codeIndentOffset | 0;
  const flags = p.flags;

  line.reset();
  line.enforceNewBlock = false;

  // Eat indentation and match containers
  off = lineIndentation(p, text, totalIndent, off);
  line.indent = p.liIndent;
  totalIndent = ((totalIndent | 0) + ((line.indent) | 0)) | 0;
  line.beg = off;

  // Match existing containers
  // remaining_indent tracks the indent left after subtracting each matched container's contents_indent. This ensures
  // nested containers compare against the correct relative indentation rather than the absolute column.
  let remainingIndent = totalIndent | 0;
  p.isDirectiveEnd = false;
  while (nParents < p.nContainers) {
    const c = p.containers[nParents];
    if (c.ch === 58) {
      // ':' Its end comes before anything that is open in it sees the line
      if (remainingIndent < codeIndentOffset && endsDirective(p, off, c.start)) {
        p.isDirectiveEnd = true;
        break;
      }
      remainingIndent = ((remainingIndent | 0) - ((Math.min(remainingIndent, c.contentsIndent)) | 0)) | 0;
      line.indent = remainingIndent;
      nParents = ((nParents | 0) + 1) | 0;
      continue;
    }
    if (c.ch === 62) {
      // '>' Blockquote continuation
      if (off < size && (text[off] | 0) === 62 && line.indent < codeIndentOffset) {
        off = ((off | 0) + 1) | 0;
        totalIndent = ((totalIndent | 0) + 1) | 0;
        off = lineIndentation(p, text, totalIndent, off);
        line.indent = p.liIndent;
        totalIndent = ((totalIndent | 0) + ((line.indent) | 0)) | 0;
        // The optional 1st space after '>' is part of the blockquote mark
        if (line.indent > 0) line.indent--;
        // Use local indent (after optional-space adjustment) for subsequent list container matching, matching md4c's
        // use of line->indent.
        remainingIndent = line.indent;
        line.beg = off;
        nParents = ((nParents | 0) + 1) | 0;
        continue;
      } else {
        break;
      }
    } else {
      // List continuation - check indentation against remaining indent
      if (remainingIndent >= c.contentsIndent) {
        remainingIndent = ((remainingIndent | 0) - ((c.contentsIndent) | 0)) | 0;
        line.indent = remainingIndent;
        nParents = ((nParents | 0) + 1) | 0;
        continue;
      } else {
        break;
      }
    }
  }

  p.lastLineHasListLooseningEffect = false;

  // Blank line lazy-matches list containers BEFORE the main detection loop (md4c does this outside while(TRUE) to
  // ensure n_parents is correct for fenced code and HTML block container-boundary checks)
  if (off >= size || isNewline(text[off] | 0)) {
    if (nBrothers + nChildren === 0) {
      while (nParents < p.nContainers && p.containers[nParents].ch !== 62) {
        nParents = ((nParents | 0) + 1) | 0;
        line.indent = 0;
      }
    }
  }

  // Track effective pivot type — brother/child containers reset this to .blank
  let effectivePivotType = pivotLine.type | 0;

  const interruptsForMicromark =
    compat.whatInterruptsDoesSoForTheWholeLine(flags) &&
    nParents === p.nContainers &&
    (pivotLine.type === L_TEXT || pivotLine.type === L_INDENTEDCODE);

  // Determine line type
  while (true) {
    if (p.isDirectiveEnd) {
      line.type = L_BLANK;
      p.htmlBlockType = 0;
      break;
    }

    // Check for fenced code continuation/closing (BEFORE blank line check, like md4c)
    if (effectivePivotType === L_FENCEDCODE) {
      line.beg = off;

      // Check for closing fence
      if (line.indent < codeIndentOffset && nParents === p.nContainers) {
        if (isClosingCodeFence(p, off, pivotLine.data)) {
          line.type = L_BLANK; // ending fence treated as blank
          p.lastLineHasListLooseningEffect = false;
          if (p.currentBlock >= 0) p.bb[p.currentBlock + 1] = (p.bb[p.currentBlock + 1] | BLOCK_CLOSED) | 0;
          break;
        }
      }

      // Fenced code continuation only if all containers matched (md4c: n_parents == n_containers)
      if (nParents === p.nContainers) {
        if (line.indent > p.fenceIndent) line.indent -= p.fenceIndent;
        else line.indent = 0;
        line.type = L_FENCEDCODE;
        break;
      }
      // If containers don't match, fenced code is implicitly ended. Fall through to other checks.
    }

    // Check for HTML block continuation (BEFORE blank line check, like md4c)
    if (effectivePivotType === L_HTML && p.htmlBlockType > 0) {
      if (nParents < p.nContainers) {
        // HTML block is implicitly ended when enclosing container closes
        p.htmlBlockType = 0;
      } else {
        if (
          isHtmlBlockEndCondition(p, off, p.htmlBlockType) &&
          !(line.indent > 0 && p.htmlBlockType >= 6 && compat.onlyALineWithoutBlanksEndsHtml(flags))
        ) {
          // Save type before clearing (md4c uses a local variable)
          const endedType = p.htmlBlockType | 0;
          p.htmlBlockType = 0;

          // Types 6 and 7 end conditions also serve as blank lines
          if (endedType === 6 || endedType === 7) {
            line.type = L_BLANK;
            line.indent = 0;
            isEmpty = true;
            break;
          }
          if (p.currentBlock >= 0) p.bb[p.currentBlock + 1] = (p.bb[p.currentBlock + 1] | BLOCK_CLOSED) | 0;
        }
        line.type = L_HTML;
        nParents = p.nContainers;
        break;
      }
    }

    // Check for blank line
    if (off >= size || isNewline(text[off] | 0)) {
      isEmpty = nBrothers + nChildren === 0;
      // Indented code continuation through blank lines
      if (effectivePivotType === L_INDENTEDCODE && nParents === p.nContainers) {
        line.type = L_INDENTEDCODE;
        if (line.indent > codeIndentOffset) line.indent -= codeIndentOffset;
        else line.indent = 0;
        p.lastLineHasListLooseningEffect = false;
      } else {
        line.type = L_BLANK;
        p.lastLineHasListLooseningEffect =
          nParents > 0 && nBrothers + nChildren === 0 && p.containers[nParents - 1].ch !== 62;

        // HTML block types 6 and 7 end on a blank line
        if (p.htmlBlockType >= 6) p.htmlBlockType = 0;

        // md4c issue #6: Track empty list items that start with 2+ blank lines. A list item can begin with at most one
        // blank line.
        if (
          nParents > 0 &&
          p.containers[nParents - 1].ch !== 62 &&
          !p.containers[nParents - 1].isTask &&
          nBrothers + nChildren === 0 &&
          p.currentBlock < 0 &&
          p.lastHeaderOpensListItem
        ) {
          p.lastListItemStartsWithTwoBlankLines = true;
        }
      }
      break;
    } else {
      // Non-blank line: check if we need to force-close an empty list item (second half of md4c issue #6 hack)
      if (p.lastListItemStartsWithTwoBlankLines) {
        if (
          nParents > 0 &&
          nParents === p.nContainers &&
          p.containers[nParents - 1].ch !== 62 &&
          nBrothers + nChildren === 0 &&
          p.currentBlock < 0 &&
          p.lastHeaderOpensListItem
        ) {
          nParents = ((nParents | 0) - 1) | 0;
          line.indent = totalIndent;
          if (nParents > 0) {
            line.indent -= Math.min(line.indent, p.containers[nParents - 1].contentsIndent);
          }
        }
        p.lastListItemStartsWithTwoBlankLines = false;
      }
      p.lastLineHasListLooseningEffect = false;
    }

    // Indented code continuation
    if (effectivePivotType === L_INDENTEDCODE) {
      if (line.indent >= codeIndentOffset) {
        line.type = L_INDENTEDCODE;
        line.indent -= codeIndentOffset;
        line.data = 0;
        break;
      }
    }

    // Check for Setext underline
    if (
      line.indent < codeIndentOffset &&
      effectivePivotType === L_TEXT &&
      off < size &&
      ((text[off] | 0) === 61 || (text[off] | 0) === 45) &&
      nParents === p.nContainers
    ) {
      if (isSetextUnderline(p, off) && !currentBlockIsOnlyRefDefs(p)) {
        line.type = L_SETEXTUNDERLINE;
        line.data = p.rLevel;
        break;
      }
    }

    // Check for thematic break
    if (
      line.indent < codeIndentOffset &&
      off < size &&
      ((text[off] | 0) === 45 || (text[off] | 0) === 95 || (text[off] | 0) === 42)
    ) {
      if (isHrLine(p, off)) {
        line.type = L_HR;
        break;
      }
    }

    // Check for brother container (another list item in same list)
    if (nParents < p.nContainers && nBrothers + nChildren === 0) {
      if (isContainerMark(p, line.indent, off)) {
        if (isContainerCompatible(p.containers[nParents], p.cm)) {
          effectivePivotType = L_BLANK;

          container.copyFrom(p.cm);
          container.markBeg = off;
          container.markEnd = p.cmOff;
          off = p.cmOff;

          totalIndent = ((totalIndent | 0) + ((container.contentsIndent - container.markIndent) | 0)) | 0;
          off = lineIndentation(p, text, totalIndent, off);
          line.indent = p.liIndent;
          totalIndent = ((totalIndent | 0) + ((line.indent) | 0)) | 0;
          line.beg = off;

          // Adjust whitespace belonging to mark
          if (off >= size || isNewline(text[off] | 0)) {
            container.contentsIndent++;
          } else if (line.indent <= codeIndentOffset) {
            container.contentsIndent += line.indent;
            line.indent = 0;
          } else {
            container.contentsIndent++;
            line.indent--;
          }

          const pc = p.containers[nParents];
          pc.markIndent = container.markIndent;
          pc.contentsIndent = container.contentsIndent;
          pc.markBeg = container.markBeg;
          pc.markEnd = container.markEnd;

          // HTML block ends when a new sibling container starts
          p.htmlBlockType = 0;

          nBrothers = ((nBrothers | 0) + 1) | 0;
          continue;
        }
      }
    }

    // Check for indented code
    if (line.indent >= codeIndentOffset && effectivePivotType !== L_TEXT) {
      line.type = L_INDENTEDCODE;
      line.indent -= codeIndentOffset;
      line.data = 0;
      break;
    }

    // Check for new container block
    if (line.indent < codeIndentOffset) {
      if (isContainerMark(p, line.indent, off)) {
        container.copyFrom(p.cm);
        container.markBeg = off;
        container.markEnd = p.cmOff;
        const contOff = p.cmOff | 0;

        // List mark can't interrupt paragraph unless it's > or ordered starting at 1
        let startsHere = true;
        if ((effectivePivotType === L_TEXT && nParents === p.nContainers) || interruptsForMicromark) {
          const afterMark = lineIndentation(p, text, 0, contOff);
          if (
            (afterMark >= size || isNewline(p.ch(afterMark))) &&
            container.ch !== 62 &&
            container.ch !== 94 &&
            container.ch !== 58
          ) {
            // Blank after list mark can't interrupt paragraph
            startsHere = false;
          } else if ((container.ch === 46 || container.ch === 41) && container.start !== 1) {
            // Ordered list with start != 1 can't interrupt paragraph
            startsHere = false;
          }
        }
        if (startsHere) {
          off = contOff;
          totalIndent = ((totalIndent | 0) + ((container.contentsIndent - container.markIndent) | 0)) | 0;
          off = lineIndentation(p, text, totalIndent, off);
          line.indent = p.liIndent;
          totalIndent = ((totalIndent | 0) + ((line.indent) | 0)) | 0;
          line.beg = off;
          line.data = container.ch;

          if (off >= size || isNewline(text[off] | 0)) {
            container.contentsIndent++;
          } else if (container.ch === 62) {
            // Only the 1st space after '>' is part of the mark
            line.indent = line.indent > 0 ? line.indent - 1 : 0;
          } else if (line.indent <= codeIndentOffset) {
            container.contentsIndent += line.indent;
            line.indent = 0;
          } else {
            container.contentsIndent++;
            line.indent--;
          }
          if (container.ch === 94) {
            container.contentsIndent = 4;
            line.indent = 0;
          }
          if (container.ch === 58) {
            container.contentsIndent = container.markIndent;
          }

          if (nBrothers + nChildren === 0) effectivePivotType = L_BLANK;

          if (nChildren === 0) {
            endCurrentBlock(p);
            leaveChildContainers(p, nParents + nBrothers);
          }

          nChildren = ((nChildren | 0) + 1) | 0;
          pushContainer(p, container);
          continue;
        }
      }
    }

    // Check for ATX header
    if (line.indent < codeIndentOffset && off < size && (text[off] | 0) === 35) {
      if (isAtxHeaderLine(p, off)) {
        line.type = L_ATXHEADER;
        line.data = p.rLevel;
        line.beg = p.rContentBeg;

        // Trim trailing whitespace
        while (line.end > line.beg && (isBlank(text[line.end - 1] | 0) || (text[line.end - 1] | 0) === 9)) line.end--;
        // Trim optional closing # sequence
        if (line.end > line.beg && (text[line.end - 1] | 0) === 35) {
          let tmp = line.end | 0;
          while (tmp > line.beg && (text[tmp - 1] | 0) === 35) tmp = ((tmp | 0) - 1) | 0;
          // The closing # must be preceded by space (or be the entire content)
          if (tmp === line.beg || isBlank(text[tmp - 1] | 0)) {
            line.end = tmp;
            // Trim trailing whitespace again
            while (line.end > line.beg && isBlank(text[line.end - 1] | 0)) line.end--;
          }
        }

        break;
      }
    }

    // Check for opening code fence
    if (
      line.indent < codeIndentOffset &&
      off < size &&
      ((text[off] | 0) === 96 || (text[off] | 0) === 126 || ((text[off] | 0) === 36 && flags.mathBlocks))
    ) {
      if (isOpeningCodeFence(p, off)) {
        line.type = L_FENCEDCODE;
        line.data = p.rFenceData;
        line.enforceNewBlock = true;
        break;
      }
    }

    // Check for HTML block start
    if (line.indent < codeIndentOffset && off < size && (text[off] | 0) === 60 && !flags.noHtmlBlocks) {
      p.htmlBlockType = isHtmlBlockStartCondition(p, off);

      // Type 7 can't interrupt paragraph
      if (p.htmlBlockType === 7 && effectivePivotType === L_TEXT) {
        if (nParents < p.nContainers && nBrothers + nChildren === 0 && compat.completeTagEndsLazyParagraph(flags)) {
          nParents = p.nContainers;
        } else {
          p.htmlBlockType = 0;
        }
      }
      if (
        p.htmlBlockType > 0 &&
        effectivePivotType === L_TEXT &&
        nBrothers + nChildren === 0 &&
        compat.tagDoesNotEndAList(flags) &&
        containersUpToQuote(p) <= nParents
      ) {
        nParents = p.nContainers;
      }

      if (p.htmlBlockType > 0) {
        line.data = p.htmlBlockType <= 5 ? BLOCK_HTML_UNTIL_TEXT : 0;
        if (isHtmlBlockEndCondition(p, off, p.htmlBlockType)) {
          p.htmlBlockType = 0;
          line.data |= BLOCK_CLOSED;
        }
        line.enforceNewBlock = true;
        line.type = L_HTML;
        break;
      }
    }

    // Check for a leaf block of the consumer's own
    const ext = p.extensions;
    if (ext !== null && line.indent < codeIndentOffset && off < size && (p.startsExtensionLeaf[text[off] | 0] | 0) !== 0) {
      const interruptsParagraph = effectivePivotType === L_TEXT;
      let end = ext.leaf(
        p,
        off,
        line.indent,
        interruptsParagraph && nBrothers + nChildren === 0 ? p.nContainers > 0 : nParents + nBrothers + nChildren > 0,
        interruptsParagraph,
      );
      if (end >= 0) {
        p.htmlBlockType = 0;
        line.data = BLOCK_EXTENSION | BLOCK_CLOSED;
        line.enforceNewBlock = true;
        line.type = L_HTML;
        if (end < off) end = off;
        else if (end > size) end = size;
        if (p.track) {
          for (let i = off; i < end; i++) {
            if ((text[i] | 0) === 10) p.lineStarts.push(i + 1);
          }
        }
        off = end;
        break;
      }
    }

    // Check for table continuation
    if (effectivePivotType === L_TABLE && nParents === p.nContainers) {
      line.type = L_TABLE;
      break;
    }

    // Check for table underline
    if (
      flags.tables &&
      line.indent < codeIndentOffset &&
      effectivePivotType === L_TEXT &&
      off < size &&
      ((text[off] | 0) === 124 || (text[off] | 0) === 45 || (text[off] | 0) === 58) &&
      nParents === p.nContainers
    ) {
      if (isTableUnderline(p, off) && p.currentBlock >= 0 && p.currentLinesN >= 1) {
        // GFM: validate that header row column count matches delimiter row column count.
        const hi = (p.currentLinesN - 1) * LINE_W;
        const headerBeg = p.currentLines[hi] | 0;
        const headerEnd = p.currentLines[hi + 1] | 0;
        const headerIndent = p.currentLines[hi + 2] | 0;
        const headerCols = countTableRowColumns(p, headerBeg, headerEnd);
        const isHeaderTooFarIn = headerIndent >= codeIndentOffset && compat.indentedLineIsNoTableHeader(flags);
        const interruptsParagraph = p.currentLinesN > 1 && compat.tableDoesNotInterruptAParagraph(flags);
        if (
          (headerCols === p.rColCount || compat.tableHeaderHasAnyNumberOfCells(flags)) &&
          !isHeaderTooFarIn &&
          !interruptsParagraph
        ) {
          line.data = p.rColCount;
          line.type = L_TABLEUNDERLINE;
          break;
        }
      }
    }

    // Default: normal text line
    line.type = L_TEXT;
    if (
      (effectivePivotType === L_TEXT || (followsEmptyItem && (followsTaskMark || compat.textGoesOnInAnEmptyItem(flags)))) &&
      nBrothers + nChildren === 0 &&
      (p.directivesN === 0 || (p.directives[p.directivesN - 1] | 0) < nParents)
    ) {
      // Lazy continuation
      nParents = p.nContainers;
    }

    // Check for task mark
    if (
      flags.tasklists &&
      nBrothers + nChildren > 0 &&
      p.nContainers > 0 &&
      isListItemMark(p.containers[p.nContainers - 1].ch)
    ) {
      let tmp = off | 0;
      while (tmp < size && tmp < off + 3 && isBlank(text[tmp] | 0)) tmp = ((tmp | 0) + 1) | 0;
      if (
        tmp + 2 < size &&
        (text[tmp] | 0) === 91 &&
        ((text[tmp + 1] | 0) === 120 || (text[tmp + 1] | 0) === 88 || (text[tmp + 1] | 0) === 32) &&
        (text[tmp + 2] | 0) === 93 &&
        (tmp + 3 === size || isBlank(text[tmp + 3] | 0) || isNewline(text[tmp + 3] | 0))
      ) {
        const taskContainer: Container = nChildren > 0 ? p.containers[p.nContainers - 1] : container;
        taskContainer.isTask = true;
        taskContainer.taskMarkOff = tmp + 1;
        off = tmp + 3;
        while (off < size && isBlank(text[off] | 0)) off = ((off | 0) + 1) | 0;
        line.beg = off;
        // Nothing else is on the line
        if (off >= size || isNewline(text[off] | 0)) {
          line.type = L_BLANK;
          p.lastLineIsOnlyATaskMark = true;
        }
      }
    }

    break;
  }

  // Scan for end of line (an `\r` ends it as well as an `\n`: without any `\r` that is the same as scanning for `\n`)
  while (off < size) {
    const c = text[off] | 0;
    if (c === 10 || c === 13) break;
    off = ((off | 0) + 1) | 0;
  }

  line.end = off;
  const rawEnd = off | 0;

  // Trim trailing closing marks for ATX header
  if (line.type === L_ATXHEADER) {
    let tmp = line.end | 0;
    while (tmp > line.beg && isBlank(text[tmp - 1] | 0)) tmp = ((tmp | 0) - 1) | 0;
    while (tmp > line.beg && (text[tmp - 1] | 0) === 35) tmp = ((tmp | 0) - 1) | 0;
    if (tmp === line.beg || isBlank(text[tmp - 1] | 0) || flags.permissiveAtxHeaders) {
      line.end = tmp;
    }
  }

  // Trim trailing spaces (except for code/HTML/text). Text lines keep trailing spaces for hard line break detection
  if (line.type !== L_INDENTEDCODE && line.type !== L_FENCEDCODE && line.type !== L_HTML && line.type !== L_TEXT) {
    while (line.end > line.beg && isBlank(text[line.end - 1] | 0)) line.end--;
  }

  // Eat newline
  if (off < size && (text[off] | 0) === 13) off = ((off | 0) + 1) | 0;
  if (off < size && (text[off] | 0) === 10) off = ((off | 0) + 1) | 0;

  // Loose list detection
  if (prevLineHasListLooseningEffect && line.type !== L_BLANK && nParents + nBrothers > 0) {
    const ci = nParents + nBrothers - 1;
    if (ci < p.containersLen && p.containers[ci].ch !== 62) p.containers[ci].isLoose = true;
  }

  // Flush current leaf block before any container transitions so that VerbatimLine data stays contiguous after its
  // BlockHeader.
  if ((nChildren === 0 && nParents + nBrothers < p.nContainers) || nBrothers > 0 || nChildren > 0) {
    endCurrentBlock(p);
  }

  // Leave containers we're no longer part of
  if (nChildren === 0 && nParents + nBrothers < p.nContainers) {
    leaveChildContainers(p, nParents + nBrothers);
  }
  p.isDirectiveEnd = false;

  // Enter brother containers
  if (nBrothers > 0) {
    // Close old LI, open new LI
    const old = p.containers[nParents];
    pushContainerBytes(
      p,
      BT_LI,
      old.isTask ? text[old.taskMarkOff] | 0 : 0,
      BLOCK_CONTAINER_CLOSER,
      p.lineBeg,
      containerEnd(p, nParents),
      0,
    );
    pushContainerBytes(
      p,
      BT_LI,
      container.isTask ? text[container.taskMarkOff] | 0 : 0,
      BLOCK_CONTAINER_OPENER,
      old.markBeg,
      old.markEnd,
      old.markIndent,
    );
    old.isTask = container.isTask;
    old.taskMarkOff = container.taskMarkOff;
  }

  if (nChildren > 0) enterChildContainers(p, nChildren);

  if (p.track) {
    const count = isEmpty ? containersUpToQuote(p) : p.nContainers;
    setContainerEnds(p, count, rawEnd);
  }

  return off;
}

export function processLine(p: Parser, pivotLine: Line, line: Line): void {
  // Blank line ends current leaf block. Note: blank lines inside fenced code blocks are typed .fencedcode by
  // analyzeLine, and blank lines inside HTML blocks type 1-5 are typed .html by analyzeLine. Only closing fences and
  // actual block-ending blank lines reach here as .blank.
  if (line.type === L_BLANK) {
    endCurrentBlock(p);
    pivotLine.reset();
    pivotLine.type = L_BLANK;
    return;
  }

  // Opening code fence: start block but don't include fence line as content
  if (line.type === L_FENCEDCODE && line.enforceNewBlock) {
    endCurrentBlock(p);
    startNewBlock(p, line);
    p.fenceIndent = line.indent;

    // Extract info string position and store in block data
    const cb = p.currentBlock;
    if (cb >= 0) {
      const fenceCount = line.data >>> 8;
      let infoBeg = line.beg + fenceCount;
      // Skip whitespace before info string
      while (infoBeg < line.end && isBlank(p.text[infoBeg] | 0)) infoBeg = ((infoBeg | 0) + 1) | 0;
      p.bb[cb + 2] = infoBeg | 0;
      p.bb[cb + 1] = (p.bb[cb + 1] | BLOCK_FENCED_CODE) | 0;
    }
    pivotLine.copyFrom(line);
    return;
  }

  if (line.enforceNewBlock) endCurrentBlock(p);

  // Single-line blocks
  if (line.type === L_HR || line.type === L_ATXHEADER) {
    endCurrentBlock(p);
    startNewBlock(p, line);
    addLineToCurrentBlock(p, line);
    endCurrentBlock(p);
    pivotLine.reset();
    pivotLine.type = L_BLANK;
    return;
  }

  // Setext underline changes current block to header
  if (line.type === L_SETEXTUNDERLINE) {
    const cb = p.currentBlock;
    if (cb >= 0) {
      p.bb[cb] = BT_H;
      p.bb[cb + 2] = line.data | 0;
      p.bb[cb + 1] = (p.bb[cb + 1] | BLOCK_SETEXT_HEADER) | 0;
    }
    // The underline is not a line of the block: a reference definition at the end of it does not go on with the underline.
    endCurrentBlock(p);
    pivotLine.reset();
    pivotLine.type = L_BLANK;
    return;
  }

  // Table underline
  if (line.type === L_TABLEUNDERLINE) {
    const cb = p.currentBlock;
    if (cb >= 0) {
      if (p.currentLinesN > 1) {
        // GFM: table interrupts paragraph. Split: lines 0..N-2 stay as paragraph, last line becomes table header.
        const hi = (p.currentLinesN - 1) * LINE_W;
        const lastBeg = p.currentLines[hi] | 0;
        const lastEnd = p.currentLines[hi + 1] | 0;
        const lastIndent = p.currentLines[hi + 2] | 0;
        // Remove the last line from current paragraph block
        p.currentLinesN--;
        p.bb[cb + 3] = (p.bb[cb + 3] - 1) | 0;
        // End the paragraph
        endCurrentBlock(p);
        // Start a new table block with the saved header line
        const headerAsLine = p.tmpLine;
        headerAsLine.reset();
        headerAsLine.type = L_TABLE;
        headerAsLine.beg = lastBeg;
        headerAsLine.end = lastEnd;
        headerAsLine.indent = lastIndent;
        headerAsLine.data = line.data;
        startNewBlock(p, headerAsLine);
        addLineToCurrentBlock(p, headerAsLine);
      } else {
        // Single line paragraph: convert directly to table
        p.bb[cb] = BT_TABLE;
        p.bb[cb + 2] = line.data | 0;
      }
    }
    // Change pivot to table
    pivotLine.type = L_TABLE;
    addLineToCurrentBlock(p, line);
    return;
  }

  // Different line type ends current block
  if (line.type !== pivotLine.type) endCurrentBlock(p);

  // Start new block if needed
  if (p.currentBlock < 0) {
    startNewBlock(p, line);
    pivotLine.copyFrom(line);
  }

  // Add line to current block
  addLineToCurrentBlock(p, line);

  // Ensure we alternate line buffers to avoid aliasing
  p.lineIdx ^= 1;
}

export function startNewBlock(p: Parser, line: Line): void {
  let blockType: number;
  switch (line.type) {
    case L_HR:
      blockType = BT_HR;
      break;
    case L_ATXHEADER:
      blockType = BT_H;
      break;
    case L_FENCEDCODE:
    case L_INDENTEDCODE:
      blockType = BT_CODE;
      break;
    case L_HTML:
      blockType = BT_HTML;
      break;
    case L_TABLE:
    case L_TABLEUNDERLINE:
      blockType = BT_TABLE;
      break;
    default:
      blockType = BT_P;
  }

  // Of a line of HTML, `data` are flags.
  const flags = blockType === BT_HTML ? line.data : 0;
  const data = blockType === BT_HTML ? 0 : line.data;
  const aligned = appendBlockHeader(p, blockType, flags, data);

  p.currentBlock = aligned;
  p.currentLinesN = 0;
}

export function addLineToCurrentBlock(p: Parser, line: Line): void {
  const cb = p.currentBlock;
  if (cb >= 0) {
    p.bb[cb + 3] = (p.bb[cb + 3] + 1) | 0;
    pushCurrentLine(p, line.beg, line.end, line.indent);
  }
}

function pushCurrentLine(p: Parser, beg: number, end: number, indent: number): void {
  const n = p.currentLinesN | 0;
  if ((n + 1) * LINE_W > p.currentLines.length) {
    const nl = new Int32Array(p.currentLines.length * 2);
    nl.set(p.currentLines);
    p.currentLines = nl;
  }
  const cl = p.currentLines;
  cl[n * LINE_W] = beg | 0;
  cl[n * LINE_W + 1] = end | 0;
  cl[n * LINE_W + 2] = indent | 0;
  p.currentLinesN = n + 1;
}

export function endCurrentBlock(p: Parser): void {
  const cb = p.currentBlock;
  if (cb >= 0) {
    const bb = p.bb;
    const isSetext = (bb[cb] | 0) === BT_H && ((bb[cb + 1] | 0) & BLOCK_SETEXT_HEADER) !== 0;
    const hdrNLines = bb[cb + 3] | 0;
    if (
      isSetext &&
      hdrNLines > 0 &&
      p.currentLinesN > 0 &&
      (p.currentLines[0] | 0) < p.size &&
      (p.text[p.currentLines[0] | 0] | 0) === 91
    ) {
      consumeRefDefsFromCurrentBlock(p);
    }

    // All lines consumed (`currentBlockIsOnlyRefDefs` keeps such a block from becoming a heading)
    if (isSetext && (p.bb[cb + 3] | 0) === 0) {
      p.bb[cb + 1] = (p.bb[cb + 1] | BLOCK_REF_DEF_ONLY) | 0;
    }

    // Write accumulated lines to bb
    const words = p.currentLinesN * LINE_W;
    if (p.bbLen + words > p.bb.length) growBb(p, p.bbLen + words);
    p.bb.set(p.currentLines.subarray(0, words), p.bbLen);
    p.bbLen += words;
    p.currentBlock = -1;
  }
}

/**
 * Whether nothing of the current block is left once its reference definitions are taken away: then there is nothing for
 * a line under it to make a heading of.
 */
function currentBlockIsOnlyRefDefs(p: Parser): boolean {
  if (p.currentLinesN === 0) return false;
  if (p.ch(p.currentLines[0] | 0) !== 91) return false;
  const buffer = p.buffer;
  buffer.reset();
  for (let i = 0; i < p.currentLinesN; i++) {
    if (buffer.len !== 0) buffer.push(10);
    buffer.append(p.text, p.currentLines[i * LINE_W] | 0, p.currentLines[i * LINE_W + 1] | 0);
  }
  let pos = 0;
  while (pos < buffer.len) {
    if (parseRefDef(p, buffer.data, buffer.len, pos) && normalizeLabel(p, buffer.data, p.rdLabelS, p.rdLabelE) > 0) {
      pos = p.rdEnd;
    } else {
      break;
    }
  }
  return pos >= buffer.len;
}

export function consumeRefDefsFromCurrentBlock(p: Parser): void {
  if (p.currentLinesN === 0) return;

  // Merge lines into buffer for ref def parsing
  const buffer = p.buffer;
  buffer.reset();
  for (let idx = 0; idx < p.currentLinesN; idx++) {
    const beg = p.currentLines[idx * LINE_W] | 0;
    const end = p.currentLines[idx * LINE_W + 1] | 0;
    if (beg > end || end > p.size) continue;
    if (buffer.len > 0) buffer.push(10);
    buffer.append(p.text, beg, end);
  }

  const merged = buffer.data;
  const mergedLen = buffer.len | 0;
  let pos = 0;
  let linesConsumed = 0;

  while (pos < mergedLen) {
    if (!parseRefDef(p, merged, mergedLen, pos)) break;

    const endPos = p.rdEnd | 0;
    const labelS = p.rdLabelS | 0;
    const labelE = p.rdLabelE | 0;
    const destS = p.rdDestS | 0;
    const destE = p.rdDestE | 0;
    const titleS = p.rdTitleS | 0;
    const titleE = p.rdTitleE | 0;

    const normLen = normalizeLabel(p, merged, labelS, labelE);
    if (normLen === 0) break;

    // First definition wins
    const nb = p.normBuf;
    if (!p.refDefLabels.contains(nb.data, 0, normLen)) {
      p.refDefLabels.insert(nb.data, 0, normLen);
      pushRefDef(p, merged, destS, destE, titleS, titleE);
    }

    let newlines = 0;
    for (let i = pos; i < endPos; i++) if ((merged[i] | 0) === 10) newlines = ((newlines | 0) + 1) | 0;
    if (endPos >= mergedLen && (endPos === pos || (merged[endPos - 1] | 0) !== 10)) newlines = ((newlines | 0) + 1) | 0;
    if (p.track) {
      const firstI = linesConsumed | 0;
      const lastI = Math.max(linesConsumed + newlines - 1, 0);
      if (firstI < p.currentLinesN && lastI < p.currentLinesN) {
        const d = p.definition;
        d.beg = p.currentLines[firstI * LINE_W] | 0;
        d.end = p.currentLines[lastI * LINE_W + 1] | 0;
        d.buf = merged;
        d.labelStart = labelS;
        d.labelEnd = labelE;
        d.destStart = destS;
        d.destEnd = destE;
        d.titleStart = titleS;
        d.titleEnd = titleE;
        d.lines = p.currentLines;
        d.linesFrom = linesConsumed;
        d.linesCount = newlines;
        p.renderer.definition(d);
      }
    }
    linesConsumed = ((linesConsumed | 0) + ((newlines) | 0)) | 0;
    pos = endPos;
  }

  if (linesConsumed > 0) {
    const cb = p.currentBlock;
    if (cb >= 0) {
      const hdrNLines = p.bb[cb + 3] | 0;
      if (linesConsumed >= hdrNLines) {
        // All lines consumed
        p.currentLinesN = 0;
        p.bb[cb + 3] = 0;
      } else {
        // Remove first lines_consumed lines
        const total = p.currentLinesN | 0;
        const remaining = total - linesConsumed;
        p.currentLines.copyWithin(0, linesConsumed * LINE_W, total * LINE_W);
        p.currentLinesN = remaining;
        p.bb[cb + 3] = (hdrNLines - linesConsumed) | 0;
      }
    }
  }
}

/** Stores the destination and title of a reference definition (ranges of `buf`) for the links that use it. */
export function pushRefDef(p: Parser, buf: Uint8Array, destS: number, destE: number, titleS: number, titleE: number): void {
  const n = p.refDefsN | 0;
  if ((n + 1) * 4 > p.refDefs.length) {
    const nr = new Int32Array(p.refDefs.length * 2);
    nr.set(p.refDefs);
    p.refDefs = nr;
  }
  const rb = p.refBytes;
  const ds = rb.len | 0;
  rb.append(buf, destS, destE);
  const ts = rb.len | 0;
  rb.append(buf, titleS, titleE);
  const rd = p.refDefs;
  rd[n * 4] = ds | 0;
  rd[n * 4 + 1] = ts | 0;
  rd[n * 4 + 2] = ts | 0;
  rd[n * 4 + 3] = rb.len | 0;
  p.refDefsN = n + 1;
}

export { startsContainerInParagraph };
