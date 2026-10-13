// Port of vendor/bun/src/format/js/print/variable_declaration.rs.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { COMMA } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  FLAG_AMBIENT,
  N_STMT,
  SP,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  VAR_AWAIT_USING,
  VAR_CONST,
  VAR_LET,
  VAR_USING,
  listAt,
  modifierFlagOf,
  nodeId,
  nodeKind,
  stmtForInit,
  stmtForInLeft,
  stmtForOfLeft,
  stmtIsDefaultExport,
  stmtIsExported,
  stmtModifiersLen,
  stmtModifiersStart,
  stmtParent,
  stmtSpan,
  stmtTag,
  varDeclInit,
  varDeclKind,
  varDeclSpan,
} from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";
import { fmtVarDecl } from "../format.ts";
import { fmtAssignmentLike, ASSIGNMENT_LIKE_VARIABLE_DECLARATOR } from "../utils/assignment_like.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { optionalSemicolon } from "./semicolon.ts";

const KW_DECLARE = token("declare");
const KW_VAR = token("var ");
const KW_LET = token("let ");
const KW_CONST = token("const ");
const KW_USING = token("using ");
const KW_AWAIT_USING = token("await using ");

/** The keyword and the space after it. */
function varKindToken(kind: number): number {
  switch (kind) {
    case VAR_LET:
      return KW_LET;
    case VAR_CONST:
      return KW_CONST;
    case VAR_USING:
      return KW_USING;
    case VAR_AWAIT_USING:
      return KW_AWAIT_USING;
    default:
      return KW_VAR;
  }
}

/** `for (;;) var a = 1, b = 2;`: oxfmt does not give each variable a line of its own. */
function bodyOfForLoopIsWrittenLikeItsHead(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `const a = 1, b = 2;` */
export function writeVariableDeclaration(statement: number, declarationsStart: number, declarationsLen: number, f: Formatter): void {
  // The keyword is a property of what is declared.
  if (declarationsLen === 0) {
    stmtSpan(statement);
    writeSuppressedNode(SP[0] | 0, SP[1] | 0, f);
    return;
  }
  const cx = cxOf(f);
  const kind = varDeclKind(listAt(declarationsStart, 0));
  // Whether it ends with a `;`, which it does not in the head of a loop, and whether it is in a loop.
  let semicolon = true;
  let isInForLoop = false;
  const modifiersLen = stmtModifiersLen(statement);
  if (modifiersLen > 0 && stmtIsExported(statement)) {
    semicolon = stmtIsDefaultExport(statement);
  } else {
    const parent = stmtParent(statement);
    if (nodeKind(parent) === N_STMT) {
      const p = nodeId(parent);
      switch (stmtTag(p)) {
        case STMT_FOR:
          semicolon = stmtForInit(p) !== statement;
          isInForLoop = true;
          break;
        case STMT_FOR_IN:
          semicolon = stmtForInLeft(p) !== statement;
          isInForLoop = true;
          break;
        case STMT_FOR_OF:
          semicolon = stmtForOfLeft(p) !== statement;
          isInForLoop = true;
          break;
        default:
          break;
      }
    }
  }
  const isParentForLoop = isInForLoop && (!semicolon || bodyOfForLoopIsWrittenLikeItsHead(f));

  if (modifiersLen > 0) {
    const ms = stmtModifiersStart(statement);
    for (let i = 0; i < modifiersLen; i++) {
      if (modifierFlagOf(listAt(ms, i)) === FLAG_AMBIENT) {
        f.token(KW_DECLARE);
        f.space();
        break;
      }
    }
  }

  // All that can break in `const a = b;` is in the group of the declarator, which fits if and only if a group around this fits.
  const noGroup = cx.isQuiet && declarationsLen === 1 && varDeclInit(listAt(declarationsStart, 0)) >= 0;
  if (!noGroup) f.startGroup();
  f.token(varKindToken(kind));
  writeVariableDeclarators(declarationsStart, declarationsLen, isParentForLoop, f);
  if (semicolon) optionalSemicolon(f);
  if (!noGroup) f.endGroup();
}

function writeVariableDeclarators(start: number, length: number, isParentForLoop: boolean, f: Formatter): void {
  const cx = cxOf(f);
  if (length === 1 && cx.isQuiet) {
    fmtVarDecl(listAt(start, 0), f);
    return;
  }
  let hasAnyInitializer = false;
  for (let i = 0; i < length; i++) {
    if (varDeclInit(listAt(start, i)) >= 0) {
      hasAnyInitializer = true;
      break;
    }
  }
  const hardSeparator = !isParentForLoop && hasAnyInitializer;
  if (length === 0) return;

  const first = listAt(start, 0);
  if (length === 1) {
    varDeclSpan(first);
    if (!cx.comments.hasCommentBefore(SP[0] | 0)) {
      fmtVarDecl(first, f);
      return;
    }
  }

  f.startIndent();
  for (let i = 0; i < length; i++) {
    fmtVarDecl(listAt(start, i), f);
    if (i + 1 < length) {
      f.token(COMMA);
      if (hardSeparator) f.hardLineBreak();
      else f.softLineBreakOrSpace();
    }
  }
  f.endIndent();
}

/** `a = 1` */
export function writeVariableDeclarator(declarator: number, f: Formatter): void {
  fmtAssignmentLike(ASSIGNMENT_LIKE_VARIABLE_DECLARATOR, declarator, f);
}
