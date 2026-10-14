// Port of vendor/bun/src/format/js/print/switch_statement.rs.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { COLON, LBRACE, LPAREN, RBRACE, RPAREN } from "../../ir/tokens.ts";
import {
  SP,
  STMT_EMPTY,
  caseBodyLen,
  caseBodyStart,
  caseSpan,
  caseTest,
  exprEnd,
  listAt,
  stmtIsBlock,
  stmtSpan,
  stmtTag,
} from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";
import { fmtCase, fmtExpr, WK_EXPR, writeDeclaration } from "../format.ts";
import {
  DANGLING_BLOCK,
  DANGLING_NONE,
  commentsStayBetweenHeadAndBody,
  formatDanglingComments,
  formatDanglingCommentsRange,
  writeTrailingCommentsBefore,
} from "../trivia.ts";
import { fmtNodeWithoutTrailingComments } from "../utils/format_node_without_trailing_comments.ts";
import { fmtStatementBody } from "../utils/statement_body.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { fmtStatements, isNextLineEmpty } from "./program.ts";

const KW_SWITCH = token("switch");
const KW_CASE = token("case");
const KW_DEFAULT = token("default");

export function writeSwitchStatement(statement: number, discriminant: number, casesStart: number, casesLen: number, f: Formatter): void {
  // TODO(port): flow: `match` (print/flow.ts `write_match_statement`)
  const cx = cxOf(f);
  f.token(KW_SWITCH);
  f.space();
  f.token(LPAREN);
  f.startGroup();
  f.startSoftBlockIndent();
  fmtExpr(discriminant, f);
  f.endSoftBlockIndent();
  f.endGroup();
  f.token(RPAREN);
  f.space();
  f.token(LBRACE);
  const SP$ = SP;
  if (casesLen === 0) {
    stmtSpan(statement);
    const start = SP$.s0 | 0;
    const end = SP$.s1 | 0;
    if (cx.comments.hasCommentBefore(end)) formatDanglingComments(start, end, DANGLING_BLOCK, f);
    else f.hardLineBreak();
    f.token(RBRACE);
    return;
  }
  f.startBlockIndent();
  let previous = -1;
  for (let i = 0; i < casesLen; i++) {
    const c = listAt(casesStart, i);
    if (previous >= 0) {
      caseSpan(previous);
      if (isNextLineEmpty(cx.src, SP$.s1 | 0)) f.emptyLine();
      else f.hardLineBreak();
    }
    fmtCase(c, f);
    previous = c;
  }
  f.endBlockIndent();
  f.token(RBRACE);
}

/** `case a: ..`, `default: ..` */
export function writeSwitchCase(cs: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  caseSpan(cs);
  const SP$ = SP;
  const caseStart = SP$.s0 | 0;
  const caseEnd = SP$.s1 | 0;
  // `case 1: a(); // prettier-ignore`: the comment is not in the `case`, so it trails all of it.
  if (!cx.isQuiet && cm.hasTrailingSuppressionComment(caseEnd)) {
    writeSuppressedNode(caseStart, caseEnd, f);
    return;
  }
  const bodyStart = caseBodyStart(cs);
  const bodyLen = caseBodyLen(cs);
  // The statements that are not empty: the first, and whether there is another one.
  let first = -1;
  let hasSecond = false;
  for (let i = 0; i < bodyLen; i++) {
    const s = listAt(bodyStart, i);
    if (stmtTag(s) === STMT_EMPTY) continue;
    if (first < 0) first = s;
    else {
      hasSecond = true;
      break;
    }
  }
  const test = caseTest(cs);
  if (!cx.isQuiet && commentsStayBetweenHeadAndBody(f) && first >= 0 && !hasSecond && stmtIsBlock(first)) {
    if (test >= 0) {
      f.token(KW_CASE);
      f.space();
      fmtNodeWithoutTrailingComments(WK_EXPR, test, f);
      const followsLineComment = writeTrailingCommentsBefore(exprEnd(test), 58, f);
      f.token(COLON);
      if (followsLineComment) f.hardLineBreak();
    } else {
      f.token(KW_DEFAULT);
      f.token(COLON);
    }
    fmtStatementBody(first, false, f);
    return;
  }
  if (test >= 0) {
    f.token(KW_CASE);
    f.space();
    fmtExpr(test, f);
    f.token(COLON);
  } else {
    f.token(KW_DEFAULT);
    f.token(COLON);
  }

  if (first < 0) {
    // `default /* comment */:`
    if (test < 0 && cm.hasCommentBefore(caseEnd)) {
      f.space();
      formatDanglingComments(caseStart, caseEnd, DANGLING_NONE, f);
    }
    return;
  }
  // The `{` of a block that is all there is goes on the line of the `case`.
  const isSingleBlockStatement = stmtIsBlock(first) && !hasSecond;

  // Prettier's `handleSwitchDefaultCaseComments`: the comments on the line of `default:` stay there, but for a line comment before a block,
  // which is written in the block.
  if (test < 0 && !cx.isQuiet && listAt(bodyStart, 0) === first) {
    let n = cm.endOfLineCommentsAfter(caseStart + 7);
    const from = cm.from;
    let to = cm.to;
    let isCommentInBlock = false;
    if (n > 0 && cm.isLine((to - 1) | 0) && stmtIsBlock(first)) {
      to = (to - 1) | 0;
      n = (n - 1) | 0;
      isCommentInBlock = true;
    }
    if (n > 0) {
      f.space();
      formatDanglingCommentsRange(from, to, DANGLING_NONE, f);
    }
    if (isCommentInBlock && isSingleBlockStatement) {
      f.space();
      writeDeclaration(first, f);
      return;
    }
  }

  if (isSingleBlockStatement) {
    f.space();
    fmtStatements(bodyStart, bodyLen, f);
  } else {
    f.startIndent();
    f.hardLineBreak();
    fmtStatements(bodyStart, bodyLen, f);
    f.endIndent();
  }
}
