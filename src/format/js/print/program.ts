// Port of vendor/bun/src/format/js/print/program.rs: the file, its `#!` line, directives, and lists of statements.
import { Formatter } from "../../ir/formatter.ts";
import { SEMI } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT, SEMICOLONS_AS_NEEDED } from "../../options.ts";
import {
  EXPR_STRING,
  N_FUNC,
  SP,
  STMT_BREAK,
  STMT_CONTINUE,
  STMT_DEBUGGER,
  STMT_DO_WHILE,
  STMT_EMPTY,
  STMT_EXPORT_DEFAULT,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_EXPR,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IF,
  STMT_IMPORT,
  STMT_LABELED,
  STMT_RETURN,
  STMT_THROW,
  STMT_VAR,
  STMT_WHILE,
  fileBodyLen,
  fileBodyStart,
  exprEnd,
  exprStart,
  exprTag,
  listAt,
  nodeKind,
  stmtDirectiveSpan,
  stmtExprExpr,
  stmtForBody,
  stmtForInBody,
  stmtForOfBody,
  stmtIfNo,
  stmtIfYes,
  stmtIsExported,
  stmtIsWith,
  stmtLabeledBody,
  stmtParent,
  stmtSpan,
  stmtTag,
  stmtWhileBody,
  stmtWithBody,
  STMT_BLOCK,
} from "../../../lint/ast/index.ts";
import { isNextLineEmpty as isNextLineEmptyText } from "../../text.ts";
import { anEnd, stmtAstParent } from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { fmtStmt, fmtStmtBeforeAnother } from "../format.ts";
import {
  commentBeforeSemicolonKeepsItsLine,
  formatDanglingCommentsRange,
  formatLeadingCommentsRange,
  formatTrailingCommentsRange,
  writeComment,
  DANGLING_NONE,
} from "../trivia.ts";
import { linesBefore } from "../builders.ts";
import { SourceText } from "../source_text.ts";
import { importRunBegin, importRunBeforeSeparator, importRunBeforeStatement, importRunFinish } from "../sort_imports/oxfmt/run.ts";
import { optionalSemicolon } from "./semicolon.ts";
import { fmtLiteralStringToken, STRING_LITERAL_PARENT_KIND_DIRECTIVE } from "../utils/string.ts";
import {
  PLACEMENTS,
  commentPlacementLeads,
  commentPlacements,
  expressionStatementNeedsSemicolon,
  followsTypeCastComment,
} from "./statements.ts";

export function writeProgram(f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const source = cx.src.text;
  const hasBom = source.length >= 3 && (source[0] | 0) === 0xef && (source[1] | 0) === 0xbb && (source[2] | 0) === 0xbf;
  if (hasBom) {
    // Prettier takes it off before it formats: it has no width.
    f.textSourceWithWidth(0, 3, 0);
  }
  writeHashbang(false, f);
  const start = fileBodyStart();
  const len = fileBodyLen();
  // Nothing that a comment could belong to: they are all Prettier's dangling comments of the program, which have no empty lines between them.
  if (len > 0) {
    let allEmpty = true;
    for (let i = 0; i < len; i++) {
      if (stmtTag(listAt(start, i)) !== STMT_EMPTY) {
        allEmpty = false;
        break;
      }
    }
    if (allEmpty) {
      cm.unprinted();
      formatDanglingCommentsRange(cm.from, cm.to, DANGLING_NONE, f);
      f.hardLineBreak();
      return;
    }
  }
  fmtStatements(start, len, f);
  cm.unprinted();
  let from = cm.from;
  const to = cm.to;
  // The empty lines before the first thing in a file go.
  if (from < to) {
    let blank = true;
    const firstStart = cm.spanStart[from] | 0;
    for (let i = hasBom ? 3 : 0; i < firstStart; i++) {
      const b = source[i] | 0;
      if (b !== 32 && b !== 9 && b !== 10 && b !== 12 && b !== 13) {
        blank = false;
        break;
      }
    }
    if (blank) {
      formatDanglingCommentsRange(from, from + 1, DANGLING_NONE, f);
      from = (from + 1) | 0;
    }
  }
  // Behind the comments, if that is all there is in the file.
  let endsWithEmptyLine = false;
  if (len > 0) {
    const last = listAt(start, len - 1);
    if (isDirectiveBeforeEmptyLine(last, f)) {
      stmtSpan(last);
      let hasBehind = false;
      for (let i = SP[1] | 0; i < source.length; i++) {
        const b = source[i] | 0;
        if (b !== 32 && b !== 9 && b !== 10 && b !== 12 && b !== 13) {
          hasBehind = true;
          break;
        }
      }
      endsWithEmptyLine = hasBehind;
    }
  }
  formatTrailingCommentsRange(from, to, f);
  if (endsWithEmptyLine) f.emptyLine();
  else f.hardLineBreak();
}

/** `#!/usr/bin/env bun`. `isLast`: nothing is written behind it, not even a line break. */
export function writeHashbang(isLast: boolean, f: Formatter): void {
  const cx = cxOf(f);
  const source = cx.src.text;
  const start = source.length >= 3 && (source[0] | 0) === 0xef && (source[1] | 0) === 0xbb && (source[2] | 0) === 0xbf ? 3 : 0;
  if (!(start + 1 < source.length && (source[start] | 0) === 35 && (source[start + 1] | 0) === 33)) return;
  let len = 0;
  const n = source.length - start;
  while (len < n) {
    const b = source[start + len] | 0;
    if (b === 10 || b === 13) break;
    // U+2028 and U+2029 end the line too.
    if (b === 0xe2 && len + 2 < n && (source[start + len + 1] | 0) === 0x80 && ((source[start + len + 2] | 0) === 0xa8 || (source[start + len + 2] | 0) === 0xa9)) break;
    len = len + 1;
  }
  let end = start + len;
  while (end > start) {
    const b = source[end - 1] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) end = end - 1;
    else break;
  }
  f.textSource(start, end);
  if (isLast) return;
  if (cx.src.linesAfter(start + len) > 1) f.emptyLine();
  else f.hardLineBreak();
}

/** Prettier's `isNextLineEmpty` */
export function isNextLineEmpty(source: SourceText, position: number): boolean {
  return isNextLineEmptyText(source.text, position);
}

/** Whether Prettier's `locEnd` of `statement` is before the `;` at its end. */
export function endsBeforeSemicolon(statement: number): boolean {
  let s = statement;
  while (true) {
    switch (stmtTag(s)) {
      case STMT_IF: {
        const no = stmtIfNo(s);
        s = no >= 0 ? no : stmtIfYes(s);
        break;
      }
      case STMT_FOR:
        s = stmtForBody(s);
        break;
      case STMT_FOR_IN:
        s = stmtForInBody(s);
        break;
      case STMT_FOR_OF:
        s = stmtForOfBody(s);
        break;
      case STMT_WHILE:
        s = stmtWhileBody(s);
        break;
      case STMT_LABELED:
        s = stmtLabeledBody(s);
        break;
      case STMT_BLOCK:
        if (stmtIsWith(s)) {
          s = stmtWithBody(s);
          break;
        }
        return false;
      case STMT_EXPR:
      case STMT_IMPORT:
      case STMT_EXPORT_NAMED:
      case STMT_EXPORT_STAR:
      case STMT_EXPORT_DEFAULT:
      case STMT_RETURN:
      case STMT_THROW:
      case STMT_DO_WHILE:
      case STMT_BREAK:
      case STMT_CONTINUE:
      case STMT_DEBUGGER:
      case STMT_VAR:
        return true;
      default:
        return false;
    }
  }
}

/** Whether there is an empty line after `statement`. */
function isNextLineEmptyAfter(statement: number, f: Formatter): boolean {
  const cx = cxOf(f);
  const source = cx.src;
  stmtSpan(statement);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  if (isNextLineEmpty(source, end)) return true;
  // `a // comment\n\n;`
  if (end - start < 2 || source.byteAt(end - 1) !== 59) return false;
  const before = source.byteAt(end - 2);
  if (!(before === 10 || before === 13 || before === 32 || before === 9 || before === 47 || before === 0xa8 || before === 0xa9)) return false;
  return (
    (endsBeforeSemicolon(statement) || stmtIsExported(statement) || emptyLineBeforeSemicolonIsAfterAnyStatement(f)) &&
    isNextLineEmpty(source, cx.comments.withoutSemicolon(start, end))
  );
}

/** `type A = 1⏎⏎;(b)`: the `;` is that of the type alias. oxfmt keeps the empty line all the same. */
function emptyLineBeforeSemicolonIsAfterAnyStatement(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * Prettier's `printStatementSequence`: the statements `(start, len)` of a file, a block or a function body, each on its own line. An empty line
 * after a statement is kept. Empty statements are left out. `FormatStatements(list)`.
 */
export function fmtStatements(start: number, len: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  let previous = -1;
  const lastIndex = len > 0 ? len - 1 : 0;
  importRunBegin(f);
  const PLACEMENTS$ = PLACEMENTS;
  for (let index = 0; index < len; index++) {
    const statement = listAt(start, index);
    if (stmtTag(statement) === STMT_EMPTY) continue;
    const previousStatement = previous;
    previous = statement;
    if (previousStatement < 0) {
      importRunBeforeStatement(statement, f);
      writeSemicolonBeforeTypeCastComment(statement, f);
      if (index === lastIndex) fmtStmt(statement, f);
      else fmtStmtBeforeAnother(statement, f);
      continue;
    }
    // Nearly always, what is left between two statements starts its line.
    let from = 0;
    let to = 0;
    if (!cx.isQuiet) {
      stmtSpan(statement);
      cm.commentsBefore(SP[0] | 0);
      from = cm.from;
      to = cm.to;
    }
    let allStartLine = true;
    for (let i = from; i < to; i++) {
      if (!(cm.precededByNewline(i) || isBehindEmptyStatementsThatStartLine(previousStatement, i, f))) {
        allStartLine = false;
        break;
      }
    }
    // `PLACEMENTS` has what the comments do, if it is not the usual.
    const hasPlacements = allStartLine ? false : writeMoreTrailingComments(previousStatement, from, to, statement, f);
    importRunBeforeSeparator(statement, !hasPlacements, f);
    // `a ⏎ /* comment */; ⏎ b`
    let nextLineEmpty = false;
    if (from < to && cm.precededByNewline(from) && (cm.spanStart[from] | 0) < stmtEndOf(previousStatement) && commentBeforeSemicolonKeepsItsLine(f)) {
      nextLineEmpty = linesBefore(cm.spanStart[from] | 0, cm.spanEnd[from] | 0, f) > 1;
    } else if (from >= to && isBehindSemicolonAndBlanks(statement, f)) {
      nextLineEmpty = false;
    } else {
      nextLineEmpty = isNextLineEmptyAfter(previousStatement, f);
    }
    if (nextLineEmpty) f.emptyLine();
    else f.hardLineBreak();
    importRunBeforeStatement(statement, f);
    if (hasPlacements) {
      for (let k = 0; k < to - from; k++) {
        if (commentPlacementLeads(PLACEMENTS$.data[k] | 0)) formatLeadingCommentsRange((from + k) | 0, (from + k + 1) | 0, f);
      }
    }
    writeSemicolonBeforeTypeCastComment(statement, f);
    if (index === lastIndex) fmtStmt(statement, f);
    else fmtStmtBeforeAnother(statement, f);
  }

  // `a; // comment\n;`: the comments around an empty statement at the end trail `a`.
  if (previous >= 0 && !cx.isQuiet && len > 0) {
    const last = listAt(start, len - 1);
    if (stmtTag(last) === STMT_EMPTY) {
      cm.commentsBefore(anEnd(stmtAstParent(last)));
      formatTrailingCommentsRange(cm.from, cm.to, f);
    }
  }
  // `return // a⏎/* b */;`: what `return` has left for the next statement, and there is none.
  if (previous >= 0 && !cx.isQuiet && f.options.flavor === FLAVOR_OXFMT) {
    cm.commentsBefore(stmtEndOf(previous));
    formatTrailingCommentsRange(cm.from, cm.to, f);
  }
  importRunFinish(f);
  if (previous >= 0 && isDirectiveBeforeEmptyLine(previous, f) && nodeKind(stmtParent(previous)) === N_FUNC) f.emptyLine();
}

function stmtEndOf(s: number): number {
  stmtSpan(s);
  return SP[1] | 0;
}

/** `a()⏎⏎; [b].c()`: oxfmt looks for an empty line before a statement, and over a `;` only if that is right before it. */
function isBehindSemicolonAndBlanks(statement: number, f: Formatter): boolean {
  if (f.options.flavor !== FLAVOR_OXFMT) return false;
  const text = cxOf(f).src.text;
  stmtSpan(statement);
  const before = SP[0] | 0;
  let code = before;
  while (code > 0) {
    const b = text[code - 1] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) code = code - 1;
    else break;
  }
  if (!(code < before && code > 0 && (text[code - 1] | 0) === 59)) return false;
  for (let i = code; i < before; i++) {
    const b = text[i] | 0;
    if (b === 10 || b === 13) return false;
  }
  return true;
}

/** `function a() { "use strict";⏎⏎}`: oxfmt keeps the empty line after the last directive, whatever follows, be it nothing. */
function isDirectiveBeforeEmptyLine(last: number, f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT && stmtDirectiveSpan(last) && isNextLineEmptyAfter(last, f);
}

/**
 * `a;⏎;// comment⏎b;`, as bundlers write it: with the empty statement gone the comment starts its line, and for oxfmt it leads `b`. For
 * Prettier it trails `a`. `comment`: an index.
 */
function isBehindEmptyStatementsThatStartLine(previous: number, comment: number, f: Formatter): boolean {
  if (f.options.flavor !== FLAVOR_OXFMT) return false;
  const cm = cxOf(f).comments;
  stmtSpan(previous);
  const previousEnd = SP[1] | 0;
  const commentStart = cm.spanStart[comment] | 0;
  if (!(previousEnd <= commentStart)) return false;
  const text = cxOf(f).src.text;
  // The last byte between the two that is not a blank or a `;`.
  for (let i = commentStart - 1; i >= previousEnd; i--) {
    const b = text[i] | 0;
    if (b === 32 || b === 9 || b === 59) continue;
    return b === 10 || b === 13;
  }
  return false;
}

/**
 * Of the comments `[from, to)`, which are what is left between `previous` and `next`, writes those that trail `previous`: there is a `;` of
 * `previous`, or an empty statement, between them and what is around them.
 *
 *     a
 *     // leads b
 *     ; // trails a
 *     ; // trails a
 *     b;
 *
 * Returns whether the comments that lead `next` have to be written by the caller because one of them is before one that trails; where the
 * comments are is `PLACEMENTS[0 .. to - from)` then.
 */
function writeMoreTrailingComments(previous: number, from: number, to: number, next: number, f: Formatter): boolean {
  const cx = cxOf(f);
  const cm = cx.comments;
  stmtSpan(next);
  commentPlacements(from, to, SP[0] | 0, f);
  const n = to - from;
  stmtSpan(previous);
  const previousStart = SP[0] | 0;
  const end = SP[1] | 0;
  // Prettier's `printTrailingComment`
  let isAfterLineComment = false;
  const lastPrinted = cm.lastPrinted();
  if (lastPrinted >= 0) {
    // It trails `previous`, and is not in it, as in `{ // comment⏎};`: nothing is between it and the end of `previous` but the `;` and other
    // comments.
    let at = cm.ce[lastPrinted] | 0;
    let ok = cm.isLine(lastPrinted) && (cm.spanStart[lastPrinted] | 0) >= previousStart;
    for (let k = 0; ok && k < n; k++) {
      const i = (from + k) | 0;
      if ((cm.cs[i] | 0) >= end) break;
      if (!isBlankOrSemicolon(cx.src.text, at, cm.cs[i] | 0)) ok = false;
      at = cm.ce[i] | 0;
    }
    if (ok) ok = isBlankOrSemicolon(cx.src.text, at, end > at ? end : at);
    isAfterLineComment = ok;
  }
  let hasLineSuffix = isAfterLineComment;
  const PLACEMENTS$ = PLACEMENTS;
  for (let k = 0; k < n; k++) {
    if (commentPlacementLeads(PLACEMENTS$.data[k] | 0)) continue;
    const i = (from + k) | 0;
    cm.incrementPrintedCount();
    if (isAfterLineComment) {
      f.startLineSuffix();
      f.hardLineBreak();
      writeComment(i, f);
      f.endLineSuffix();
    } else if (cm.isLine(i) || hasLineSuffix) {
      f.startLineSuffix();
      f.space();
      writeComment(i, f);
      f.endLineSuffix();
      f.expandParent();
    } else {
      f.space();
      writeComment(i, f);
    }
    hasLineSuffix = hasLineSuffix || cm.isLine(i) || isAfterLineComment;
    isAfterLineComment = cm.isLine(i);
  }

  let trailingCount = 0;
  while (trailingCount < n && !commentPlacementLeads(PLACEMENTS$.data[trailingCount] | 0)) trailingCount = (trailingCount + 1) | 0;
  for (let k = trailingCount; k < n; k++) {
    if (!commentPlacementLeads(PLACEMENTS$.data[k] | 0)) return true;
  }
  return false;
}

/** Whether text[a, b) (a range that is empty if `b <= a`) is white space and `;` only. */
function isBlankOrSemicolon(text: Uint8Array, a0: number, b: number): boolean {
  const a = a0 < b ? a0 : b;
  for (let i = a; i < b; i++) {
    const c = text[i] | 0;
    if (!(c === 32 || c === 9 || c === 10 || c === 12 || c === 13 || c === 59)) return false;
  }
  return true;
}

/**
 * Prettier's `shouldExpressionStatementPrintOwnComments`: without semicolons, the `;` that a statement has to start with goes before a type cast
 * comment, which has to stay next to its `(`.
 */
function writeSemicolonBeforeTypeCastComment(statement: number, f: Formatter): void {
  const cx = cxOf(f);
  if (!cx.isQuiet && cx.comments.hasTypeCastComments && f.options.semicolons === SEMICOLONS_AS_NEEDED) {
    writeSemicolonBeforeTypeCastCommentOf(statement, f);
  }
}

function writeSemicolonBeforeTypeCastCommentOf(statement: number, f: Formatter): void {
  if (stmtTag(statement) !== STMT_EXPR) return;
  const expression = stmtExprExpr(statement);
  const cm = cxOf(f).comments;
  stmtSpan(statement);
  const start = SP[0] | 0;
  const n = cm.commentsBefore(start);
  const from = cm.from;
  if (
    n > 0 &&
    followsTypeCastComment(start, f) &&
    (!cm.isSuppressed(start) || semicolonIsBeforeCastCommentOfIgnoredStatement(f)) &&
    expressionStatementNeedsSemicolon(statement, expression, f)
  ) {
    // All but the last.
    formatLeadingCommentsRange(from, (from + n - 1) | 0, f);
    f.token(SEMI);
  }
}

/** Prettier writes the `;` of a statement that is not formatted right before its text. oxfmt keeps the comment next to its `(`. */
function semicolonIsBeforeCastCommentOfIgnoredStatement(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `"use strict";` */
export function writeDirective(statement: number, f: Formatter): void {
  if (stmtTag(statement) !== STMT_EXPR) return;
  const e = stmtExprExpr(statement);
  if (exprTag(e) !== EXPR_STRING) return;
  // TODO(port): FormatLiteralStringToken keeps the quotes of a directive unless it has none in it.
  fmtLiteralStringToken(exprStart(e), exprEnd(e), false, STRING_LITERAL_PARENT_KIND_DIRECTIVE, f);
  optionalSemicolon(f);
}
