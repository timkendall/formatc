// Port of vendor/bun/src/format/js/print/try_statement.rs.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { LPAREN, RPAREN } from "../../ir/tokens.ts";
import {
  SP,
  patSpan,
  stmtBlockStmtsLen,
  stmtBlockStmtsStart,
  stmtSpan,
  varDeclPat,
  varDeclSpan,
  varDeclTy,
} from "../../../lint/ast/index.ts";
import { AN_CATCH_CLAUSE, AN_CATCH_PARAMETER, anSpan, mkAn } from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import {
  PK_NODE,
  PK_PARENT,
  WK_STMT,
  fmtPat,
  fmtTypeAnnotation,
  writeDeclaration,
  writeTrailingCommentsIn,
  writeTrailingCommentsOf,
} from "../format.ts";
import {
  DANGLING_NONE,
  commentsStayBetweenHeadAndBody,
  formatDanglingCommentsRange,
  formatLeadingComments,
  formatLeadingCommentsRange,
  formatTrailingCommentsRange,
  writeCommentsBetweenBlocks,
  writeHeadBodySeparator,
} from "../trivia.ts";
import { fmtNodeWithoutTrailingComments } from "../utils/format_node_without_trailing_comments.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { isEmptyBlock } from "./block_statement.ts";

const KW_TRY = token("try");
const KW_CATCH = token("catch");
const KW_FINALLY = token("finally");

/** Whether one of the comments `[from, to)` starts or ends its line. Prettier's `handleTryStatementComments` moves those into the next block. */
function hasCommentWithLineBreak(from: number, to: number, f: Formatter): boolean {
  const cm = cxOf(f).comments;
  for (let i = from; i < to; i++) {
    if (cm.precededByNewline(i) || cm.followedByNewline(i)) return true;
  }
  return false;
}

/** A space and a block after `try`, `catch (e)` or `finally`. The comments after it are left to the caller. */
function writeBlock(block: number, f: Formatter): void {
  const cx = cxOf(f);
  stmtSpan(block);
  const start = SP[0] | 0;
  if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f)) {
    writeHeadBodySeparator(start, f);
    fmtNodeWithoutTrailingComments(WK_STMT, block, f);
    return;
  }
  f.space();
  if (!cx.isQuiet) {
    cx.comments.commentsBefore(start);
    if (hasCommentWithLineBreak(cx.comments.from, cx.comments.to, f)) {
      // The comments before it are written in it.
      writeDeclaration(block, f);
      return;
    }
  }
  fmtNodeWithoutTrailingComments(WK_STMT, block, f);
}

export function writeTryStatement(statement: number, block: number, param: number /* -1: none */, handler: number /* -1: none */, finalizer: number /* -1: none */, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  f.token(KW_TRY);
  writeBlock(block, f);

  if (handler >= 0) {
    f.space();
    const node = mkAn(AN_CATCH_CLAUSE, statement);
    // format_node_without_comments(node.span(), || node.parent(), f, |f| write_catch_clause(node, param, handler, f))
    anSpan(node);
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    if (cx.isQuiet || !cm.isSuppressed(start)) writeCatchClause(node, param, handler, f);
    else {
      formatLeadingComments(start, end, f);
      writeSuppressedNode(start, end, f);
      writeTrailingCommentsIn(start, end, PK_NODE, node, f);
    }
  }
  if (finalizer >= 0) {
    const previousBlock = handler >= 0 ? handler : block;
    stmtSpan(previousBlock);
    const previousEnd = SP[1] | 0;
    // `} /* comment */ finally {`
    if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f)) {
      cm.commentsBeforeCharacter(previousEnd, 102 /* f */);
      writeCommentsBetweenBlocks(cm.from, cm.to, f);
    } else if (!cx.isQuiet) {
      stmtSpan(finalizer);
      cm.commentsBefore(SP[0] | 0);
      const from = cm.from;
      const to = cm.to;
      let position = previousEnd;
      let count = 0;
      const text = cx.src.text;
      for (let i = from; i < to; i++) {
        const gapEnd = cm.spanStart[i] | 0;
        let blank = true;
        for (let a = position; a < gapEnd; a++) {
          const b = text[a] | 0;
          if (!(b === 32 || b === 9 || b === 10 || b === 12 || b === 13)) {
            blank = false;
            break;
          }
        }
        position = cm.spanEnd[i] | 0;
        if (!blank) break;
        count = (count + 1) | 0;
      }
      const upTo = (from + count) | 0;
      if (!hasCommentWithLineBreak(from, upTo, f)) formatTrailingCommentsRange(from, upTo, f);
    }
    f.space();
    f.token(KW_FINALLY);
    writeBlock(finalizer, f);
  }
}

/** `node`: the `CatchClause` (an `AstNodes`). `body`: its block. */
function writeCatchClause(node: number, param: number, body: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  // ```js
  // try {
  // } // comment
  // catch {
  // }
  // ```
  // A comment with a line break next to it goes to the start of the block, where `write_block_statement` takes it from the cache. Any other
  // stays before `catch`.
  anSpan(node);
  const nodeStart = SP[0] | 0;
  const nodeEnd = SP[1] | 0;
  cm.commentsBefore(nodeStart);
  const from = cm.from;
  const to = cm.to;
  if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f)) {
    if (writeCommentsBetweenBlocks(from, to, f)) f.space();
  } else if (hasCommentWithLineBreak(from, to, f)) {
    const isEmpty = isEmptyBlock(stmtBlockStmtsStart(body), stmtBlockStmtsLen(body));
    const slot = f.startCapture();
    if (isEmpty) {
      formatDanglingCommentsRange(from, to, DANGLING_NONE, f);
      f.hardLineBreak();
    } else {
      formatLeadingCommentsRange(from, to, f);
    }
    const h = f.endCapture(slot);
    if (h >= 0) cx.cacheElement(nodeStart, nodeEnd, h);
  } else if (to > from) {
    formatTrailingCommentsRange(from, to, f);
    f.space();
  }

  f.token(KW_CATCH);
  if (param >= 0) {
    f.space();
    // format_node_without_comments(param.span(), || node, f, |f| write_catch_parameter(param, body, f))
    varDeclSpan(param);
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    if (cx.isQuiet || !cm.isSuppressed(start)) writeCatchParameter(param, body, f);
    else {
      formatLeadingComments(start, end, f);
      writeSuppressedNode(start, end, f);
      writeTrailingCommentsIn(start, end, PK_PARENT, node, f);
    }
  }
  writeBlock(body, f);
}

/** `(e)` */
function writeCatchParameter(param: number, body: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const pattern = varDeclPat(param);
  const ty = varDeclTy(param);
  f.token(LPAREN);
  if (cx.isQuiet) {
    fmtPat(pattern, f);
    if (ty >= 0) fmtTypeAnnotation(ty, f);
    f.token(RPAREN);
    return;
  }

  patSpan(pattern);
  cm.commentsBefore(SP[0] | 0);
  const leadingFrom = cm.from;
  const leadingTo = cm.to;
  let leadingCommentWithBreak = false;
  for (let i = leadingFrom; i < leadingTo; i++) {
    if (cm.isLine(i) || cm.followedByNewline(i)) {
      leadingCommentWithBreak = true;
      break;
    }
  }
  // Those before the `)`, and of those after it the ones that start or end their line.
  varDeclSpan(param);
  const paramEnd = SP[1] | 0;
  stmtSpan(body);
  const bodyStart = SP[0] | 0;
  cm.commentsIn(paramEnd, bodyStart);
  const beforeBodyFrom = cm.from;
  const beforeBodyTo = cm.to;
  const closeCount = cm.commentsBeforeCharacter(paramEnd, 41 /* ) */);
  let count = closeCount;
  if (!commentsStayBetweenHeadAndBody(f)) {
    let at = 0;
    for (let i = beforeBodyTo - 1; i >= beforeBodyFrom; i--) {
      if (cm.precededByNewline(i) || cm.followedByNewline(i)) {
        at = (i - beforeBodyFrom + 1) | 0;
        break;
      }
    }
    if (at > count) count = at;
  }
  const trailingFrom = beforeBodyFrom;
  const trailingTo = beforeBodyFrom + count < beforeBodyTo ? (beforeBodyFrom + count) | 0 : beforeBodyTo;
  let trailingCommentWithBreak = false;
  for (let i = trailingFrom; i < trailingTo; i++) {
    if (cm.isLine(i) || cm.precededByNewline(i)) {
      trailingCommentWithBreak = true;
      break;
    }
  }

  const needsIndent = leadingCommentWithBreak || trailingCommentWithBreak;
  if (needsIndent) f.startSoftBlockIndent();
  formatLeadingCommentsRange(leadingFrom, leadingTo, f);
  const previousLimit = cm.limitCommentsUpTo(paramEnd);
  fmtPat(pattern, f);
  if (ty >= 0) fmtTypeAnnotation(ty, f);
  cm.restoreViewLimit(previousLimit);
  formatTrailingCommentsRange(trailingFrom, trailingTo, f);
  if (needsIndent) f.endSoftBlockIndent();
  if (!commentsStayBetweenHeadAndBody(f)) writeTrailingCommentsOf(mkAn(AN_CATCH_PARAMETER, param), f);
  f.token(RPAREN);
}
