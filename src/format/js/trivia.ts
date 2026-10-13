// Port of vendor/bun/src/format/js/trivia.rs: how comments are written.
//
// `Comments` (comments.ts) tells which comments belong where. This writes them, with the spaces and line breaks around them, and marks them
// as printed.
//
// A Rust `Span` is `(start, end)` and a `&[Comment]` is a range `[from, to)` of indices (see comments.ts):
//
//   format_leading_comments(span).fmt(f)              formatLeadingComments(start, end, f)
//   FormatLeadingComments::Comments(c).fmt(f)         formatLeadingCommentsRange(from, to, f)
//   format_trailing_comments(enc, prec, following)    formatTrailingComments(encStart, encEnd, precStart, precEnd, followingStart, f)
//   FormatTrailingComments::Comments(c).fmt(f)        formatTrailingCommentsRange(from, to, f)
//   format_dangling_comments(span)[.with_block_indent()]   formatDanglingComments(start, end, DANGLING_NONE | DANGLING_BLOCK | DANGLING_SOFT, f)
//   FormatDanglingComments::Comments{..}              formatDanglingCommentsRange(from, to, mode, f)
//   write!(f, comment)                                writeComment(i, f)
import { Formatter } from "../ir/formatter.ts";
import { SPACE_TOKEN } from "../ir/tokens.ts";
import { FLAVOR_OXFMT, HTML_ROOT_NONE } from "../options.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart, jsLineBreakLenBack } from "../text.ts";
import { INF, Comments } from "./comments.ts";
import { cxOf } from "./context.ts";
import { BT_WS_SEMI, LINE, lineEndAt } from "./source_text.ts";
import { writeComment as writeJsdocComment } from "./jsdoc/mod.ts";

/** Without the blanks at the end of text[0, end) and the line break before them, if there is one: the new end, or -1. */
function withoutLastLine(text: Uint8Array, end0: number): number {
  let end = end0;
  while (end > 0) {
    const b = text[end - 1] | 0;
    if (b === 32 || b === 9) end = end - 1;
    else break;
  }
  const len = jsLineBreakLenBack(text, end);
  return len === 0 ? -1 : end - len;
}

/**
 * 0 if something is before comment `i` on its line, 1 if nothing is, 2 if the line before is empty as well: Prettier's
 * `hasNewline(.., { backwards: true })` and `isPreviousLineEmpty`.
 */
export function linesBeforeComment(i: number, cm: Comments): number {
  const text = cm.source.text;
  const before = withoutLastLine(text, cm.spanStart[i] | 0);
  if (before < 0) return 0;
  return withoutLastLine(text, before) >= 0 ? 2 : 1;
}

/**
 * `a ⏎ /* comment *&#47;; ⏎ b`: the `;`, which is that of `a`, is written before the comment. For oxfmt the comment stays on a line of its
 * own, so the line breaks after it are counted from behind the `;`. For Prettier it is on the line of `b`.
 */
export function commentBeforeSemicolonKeepsItsLine(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** Where comment `i`, which leads something, ends. See `commentBeforeSemicolonKeepsItsLine`. */
function endWithSemicolonOfStatementBefore(i: number, cm: Comments, f: Formatter): number {
  const end = cm.spanEnd[i] | 0;
  if (!cm.precededByNewline(i) || !commentBeforeSemicolonKeepsItsLine(f)) return end;
  const text = cm.source.text;
  let at = end;
  while (at < text.length) {
    const b = text[at] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) at = at + 1;
    else break;
  }
  return cm.source.byteAt(at) === 59 ? at + 1 : end;
}

/** The comments before the node at `(start, end)`. */
export function formatLeadingComments(start: number, end: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  if (cm.nextStart() > start) return;
  cm.commentsLeadingNode(start, end);
  writeLeadingComments(cm.from, cm.to, start, f);
}

/** `FormatLeadingComments::Comments`: the comments `[from, to)`. */
export function formatLeadingCommentsRange(from: number, to: number, f: Formatter): void {
  writeLeadingComments(from, to, INF, f);
}

/** `nodeStart`: where the node starts that they lead (INF: none). */
function writeLeadingComments(from: number, to: number, nodeStart: number, f: Formatter): void {
  if (from >= to) return;
  const cm = cxOf(f).comments;
  // A comment that has been moved out of a node that is written as it is in the source is in that text.
  let isIgnored = false;
  for (let i = from; i < to; i++) {
    if (cm.isMoved(i) && cm.isSuppressionComment(i)) {
      isIgnored = true;
      break;
    }
  }
  for (let i = from; i < to; i++) {
    cm.incrementPrintedCount();
    if (isIgnored && cm.isMoved(i) && (cm.spanStart[i] | 0) >= nodeStart) continue;
    writeComment(i, f);

    const a = cm.source.linesAfter(cm.spanEnd[i] | 0);
    const b = cm.source.linesAfter(endWithSemicolonOfStatementBefore(i, cm, f));
    const linesAfter = a > b ? a : b;
    if (cm.isLine(i)) {
      if (linesAfter <= 1) f.hardLineBreak();
      else f.emptyLine();
    } else if (linesAfter === 0) {
      f.space();
    } else if (linesAfter === 1) {
      if (linesBeforeComment(i, cm) === 0) f.softLineBreakOrSpace();
      else f.hardLineBreak();
    } else {
      f.emptyLine();
    }
  }
}

/**
 * The comments after the node at `(precedingStart, precedingEnd)`, whose parent is at `(enclosingStart, enclosingEnd)` and whose next
 * sibling starts at `followingStart`, which is 0 if there is none.
 */
export function formatTrailingComments(
  enclosingStart: number,
  enclosingEnd: number,
  precedingStart: number,
  precedingEnd: number,
  followingStart: number,
  f: Formatter,
): void {
  const cm = cxOf(f).comments;
  if (cm.nextStart() >= enclosingEnd) return;
  const n = cm.getTrailingComments(enclosingEnd, precedingEnd, followingStart);
  if (n > 0) writeTrailingComments(cm.from, cm.to, f);
}

/** `FormatTrailingComments::Comments`: the comments `[from, to)`. */
export function formatTrailingCommentsRange(from: number, to: number, f: Formatter): void {
  if (from < to) writeTrailingComments(from, to, f);
}

function writeTrailingComments(from: number, to: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  const text = cm.source.text;
  let totalLinesBefore = 0;
  // `a; // b` and `; // c` on the next line: the one before the empty statement has been written by itself.
  let previousComment = -1;
  const lastPrinted = cm.lastPrinted();
  if (lastPrinted >= 0 && (cm.spanStart[from] | 0) >= (cm.spanEnd[lastPrinted] | 0)) {
    const isOnlyEmptyStatements = cm.source.allBytes(cm.spanEnd[lastPrinted] | 0, cm.spanStart[from] | 0, BT_WS_SEMI);
    if (cm.isLine(lastPrinted) && isOnlyEmptyStatements) previousComment = lastPrinted;
  }

  for (let i = from; i < to; i++) {
    cm.incrementPrintedCount();

    const linesBefore = linesBeforeComment(i, cm);
    totalLinesBefore = (totalLinesBefore + linesBefore) | 0;

    const isAfterLineComment = previousComment >= 0 && cm.isLine(previousComment);

    // A comment on a line of its own at the end of a block or an object is a trailing comment of what is before it, and stays on its
    // own line:
    //
    //     {
    //       x: 1,
    //       y: 2
    //       // A comment
    //     }
    if (totalLinesBefore > 0 || isAfterLineComment) {
      f.startLineSuffix();
      if (linesBefore === 0) {
        if (isAfterLineComment) f.hardLineBreak();
        else f.space();
      } else if (linesBefore === 1) f.hardLineBreak();
      else f.emptyLine();
      writeComment(i, f);
      f.endLineSuffix();
      f.expandParent();
    } else {
      // Nothing but a byte order mark is before it.
      const start = cm.spanStart[i] | 0;
      const isFirstInFile = start === 3 && (text[0] | 0) === 0xef && (text[1] | 0) === 0xbb && (text[2] | 0) === 0xbf;
      if (cm.isLine(i)) {
        f.startLineSuffix();
        f.maybeSpace(!isFirstInFile);
        writeComment(i, f);
        f.endLineSuffix();
        f.expandParent();
      } else {
        f.maybeSpace(!isFirstInFile);
        writeComment(i, f);
      }
    }
    previousComment = i;
  }
}

export const DANGLING_NONE: number = 0;
/** On lines of their own, indented. */
export const DANGLING_BLOCK: number = 1;
/** On lines of their own, indented, unless it is a single block comment that fits. */
export const DANGLING_SOFT: number = 2;

/**
 * The comments that are left in the node at `(start, end)`, which has nothing else in it: `{ /* a *&#47; }`. `mode`: `DANGLING_*`
 * (`.with_block_indent()` is `DANGLING_BLOCK`, `.with_soft_block_indent()` is `DANGLING_SOFT`).
 */
export function formatDanglingComments(start: number, end: number, mode: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  if (cm.nextStart() >= end) return;
  const n = cm.commentsBeforeEndOf(end);
  if (n > 0) writeDanglingComments(cm.from, cm.to, mode, f);
}

/** `FormatDanglingComments::Comments`: the comments `[from, to)`. */
export function formatDanglingCommentsRange(from: number, to: number, mode: number, f: Formatter): void {
  if (from < to) writeDanglingComments(from, to, mode, f);
}

function writeDanglingComments(from: number, to: number, mode: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  if (mode === DANGLING_BLOCK) f.startBlockIndent();
  else if (mode === DANGLING_SOFT) {
    f.startGroup();
    f.startSoftBlockIndent();
  }
  let previous = -1;
  for (let i = from; i < to; i++) {
    cm.incrementPrintedCount();
    if (previous >= 0) f.hardLineBreak();
    writeComment(i, f);
    previous = i;
  }
  if (mode === DANGLING_SOFT && previous >= 0 && cm.isLine(previous)) f.hardLineBreak();
  if (mode === DANGLING_BLOCK) f.endBlockIndent();
  else if (mode === DANGLING_SOFT) {
    f.endSoftBlockIndent();
    f.endGroup();
  }
}

/**
 * For oxfmt the comments between the head of something and its body, between a `}` and the keyword after it, and between what is called
 * and the `(` stay where they are. Prettier attaches each to a node, which can be in the body, or in the parentheses.
 *
 * ```js
 * function a() // comment      function a() {
 * {}                             // comment
 *                              }
 * ```
 */
export function commentsStayBetweenHeadAndBody(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * See `commentsStayBetweenHeadAndBody`: what is between a head and its body, which starts at `bodyStart`: a space, or a line break if a
 * comment starts the next line, and the comments.
 */
export function writeHeadBodySeparator(bodyStart: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  cm.commentsBefore(bodyStart);
  const from = cm.from;
  const to = cm.to;
  if (from < to && cm.precededByNewline(from)) f.hardLineBreak();
  else f.space();
  formatLeadingCommentsRange(from, to, f);
}

/**
 * See `commentsStayBetweenHeadAndBody`: the comments `[from, to)` are between a `}` and a keyword, or between what is called and the `(`.
 * Those on the line of what is before them trail it, the others keep their lines. Returns whether what separates the two if there are no
 * comments is still to be written.
 */
export function writeCommentsBetweenBlocks(from: number, to: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  let sameLineEnd = from;
  while (sameLineEnd < to && !cm.precededByNewline(sameLineEnd)) sameLineEnd = (sameLineEnd + 1) | 0;
  formatTrailingCommentsRange(from, sameLineEnd, f);
  if (sameLineEnd < to) {
    if (linesBeforeComment(sameLineEnd, cm) > 1) f.emptyLine();
    else f.hardLineBreak();
    formatLeadingCommentsRange(sameLineEnd, to, f);
    return false;
  }
  if (sameLineEnd > from && cm.isLine((sameLineEnd - 1) | 0)) {
    f.hardLineBreak();
    return false;
  }
  return true;
}

/**
 * See `commentsStayBetweenHeadAndBody`: writes the comments after `start` that are before `character`, which the caller writes next.
 * Returns whether a line break has to follow that, because a line comment is waiting for the end of the line.
 */
export function writeTrailingCommentsBefore(start: number, character: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  cm.commentsBeforeCharacter(start, character);
  const from = cm.from;
  const to = cm.to;
  let sameLineEnd = from;
  while (sameLineEnd < to && !cm.precededByNewline(sameLineEnd)) sameLineEnd = (sameLineEnd + 1) | 0;
  formatTrailingCommentsRange(from, sameLineEnd, f);
  for (let i = sameLineEnd; i < to; i++) {
    if (linesBeforeComment(i, cm) > 1) f.emptyLine();
    else f.hardLineBreak();
    cm.incrementPrintedCount();
    writeComment(i, f);
    if (cm.isLine(i)) f.hardLineBreak();
  }
  return sameLineEnd === to && sameLineEnd > from && cm.isLine((sameLineEnd - 1) | 0);
}

/**
 * oxfmt hands its document for a script of a Vue file to Prettier, whose printer takes away the blanks before a line break.
 */
function isPrintedByPrettierForOxfmt(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT && f.options.inHtml.root !== HTML_ROOT_NONE;
}

const TWO_SPACES_AND_NEWLINE = new Uint8Array([32, 32, 10]);

/** Prettier's `printComment`. */
export function writeComment(i: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  const text = cm.source.text;
  const start = cm.spanStart[i] | 0;
  const end = cm.spanEnd[i] | 0;
  if (cm.isLine(i)) {
    f.textSource(start, trimJsWhitespaceEnd(text, start, end));
    return;
  }
  if (writeJsdocComment(i, f)) return;
  if (cm.isIndentableBlock(i)) {
    // In Markdown, two spaces at the end of a line are a line break.
    const isJsdoc =
      end - start >= 3 &&
      (text[start] | 0) === 47 &&
      (text[start + 1] | 0) === 42 &&
      (text[start + 2] | 0) === 42 &&
      (!(start + 3 < end && (text[start + 3] | 0) === 42) || f.options.flavor === FLAVOR_OXFMT) &&
      !isPrintedByPrettierForOxfmt(f);
    lineEndAt(text, start, end);
    let lineEnd = LINE[0] | 0;
    let brk = LINE[1] | 0;
    f.textSource(start, trimJsWhitespaceEnd(text, start, lineEnd));
    let pos = lineEnd + brk;
    while (brk !== 0) {
      lineEndAt(text, pos, end);
      lineEnd = LINE[0] | 0;
      const nextBrk = LINE[1] | 0;
      const trimmedStart = trimJsWhitespaceStart(text, pos, lineEnd);
      const trimmedEnd = trimJsWhitespaceEnd(text, trimmedStart, lineEnd);
      f.hardLineBreak();
      f.token(SPACE_TOKEN);
      f.textSource(trimmedStart, trimmedEnd);
      const isStar = trimmedEnd - trimmedStart === 1 && (text[trimmedStart] | 0) === 42;
      if (isJsdoc && !isStar && lineEnd - pos >= 2 && (text[lineEnd - 1] | 0) === 32 && (text[lineEnd - 2] | 0) === 32 && nextBrk !== 0) {
        // A line break in a text keeps the spaces before it. The one that follows only indents.
        f.textBytes(TWO_SPACES_AND_NEWLINE, 0, 3);
      }
      brk = nextBrk;
      pos = lineEnd + brk;
    }
    return;
  }
  let hasCr = false;
  for (let j = start; j < end; j++) {
    if ((text[j] | 0) === 13) {
      hasCr = true;
      break;
    }
  }
  if (!hasCr) {
    f.textSource(start, end);
    return;
  }
  const buf = f.textBuf();
  const at = buf.len;
  let pos = start;
  let index = 0;
  while (true) {
    lineEndAt(text, pos, end);
    const lineEnd = LINE[0] | 0;
    const brk = LINE[1] | 0;
    if (index > 0) buf.push(10);
    buf.append(text, pos, lineEnd);
    if (brk === 0) break;
    pos = lineEnd + brk;
    index = (index + 1) | 0;
  }
  f.endBuiltText(at);
}
