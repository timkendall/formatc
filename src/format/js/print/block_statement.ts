// Port of vendor/bun/src/format/js/print/block_statement.rs.
import { Formatter } from "../../ir/formatter.ts";
import { LBRACE, RBRACE } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import { N_STMT, SP, STMT_EMPTY, STMT_TRY, listAt, nodeId, nodeKind, stmtParent, stmtSpan, stmtTag } from "../../../lint/ast/index.ts";
import {
  AN_CATCH_CLAUSE,
  AN_DO_WHILE_STATEMENT,
  AN_FOR_STATEMENT,
  AN_FUNCTION_BODY,
  AN_TS_GLOBAL_DECLARATION,
  AN_TS_MODULE_DECLARATION,
  AN_WHILE_STATEMENT,
  anId,
  anSpan,
  anTag,
  stmtAstParent,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { stmtFinalizer } from "../fields.ts";
import { DANGLING_NONE, formatDanglingComments } from "../trivia.ts";
import { fmtStatements } from "./program.ts";

/** `{ .. }` */
export function writeBlockStatement(statement: number, bodyStart: number, bodyLen: number, f: Formatter): void {
  const cx = cxOf(f);
  f.token(LBRACE);

  // See `write_catch_clause`.
  let commentsBeforeCatchClause = -1;
  const SP$ = SP;
  if (cx.hasCachedElements()) {
    const parent = stmtParent(statement);
    if (nodeKind(parent) === N_STMT && stmtTag(nodeId(parent)) === STMT_TRY) {
      const an = stmtAstParent(statement);
      if (anTag(an) === AN_CATCH_CLAUSE) {
        anSpan(an);
        commentsBeforeCatchClause = cx.getCachedElement(SP$.s0 | 0, SP$.s1 | 0);
      }
    }
  }

  if (isEmptyBlock(bodyStart, bodyLen)) {
    stmtSpan(statement);
    const start = SP$.s0 | 0;
    const end = SP$.s1 | 0;
    // `try // comment\n{}`: the comments before the block that are not written yet are written in it.
    if (commentsBeforeCatchClause >= 0 || cx.comments.hasCommentBefore(end)) {
      f.startBlockIndent();
      if (commentsBeforeCatchClause >= 0) f.writeInterned(commentsBeforeCatchClause);
      formatDanglingComments(start, end, DANGLING_NONE, f);
      f.endBlockIndent();
    } else if (isNonCollapsible(stmtAstParent(statement), f)) {
      f.hardLineBreak();
    }
  } else {
    f.startBlockIndent();
    if (commentsBeforeCatchClause >= 0) f.writeInterned(commentsBeforeCatchClause);
    fmtStatements(bodyStart, bodyLen, f);
    f.endBlockIndent();
  }
  f.token(RBRACE);
}

/** There is nothing in it but empty statements. */
export function isEmptyBlock(blockStart: number, blockLen: number): boolean {
  for (let i = 0; i < blockLen; i++) {
    if (stmtTag(listAt(blockStart, i)) !== STMT_EMPTY) return false;
  }
  return true;
}

/** Whether an empty block in `parent` (an `AstNodes`) is written `{\n}` and not `{}`. */
function isNonCollapsible(parent: number, f: Formatter): boolean {
  switch (anTag(parent)) {
    // `function a() { {} }`: a statement in the body, not the body.
    case AN_FUNCTION_BODY:
      return !emptyBlockInFunctionBodyCollapses(f);
    case AN_FOR_STATEMENT:
    case AN_WHILE_STATEMENT:
    case AN_DO_WHILE_STATEMENT:
    case AN_TS_MODULE_DECLARATION:
    case AN_TS_GLOBAL_DECLARATION:
      return false;
    case AN_CATCH_CLAUSE:
      return stmtFinalizer(anId(parent)) >= 0;
    default:
      return true;
  }
}

function emptyBlockInFunctionBodyCollapses(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}
