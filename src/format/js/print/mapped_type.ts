// Port of vendor/bun/src/format/js/print/mapped_type.rs: `{ readonly [K in T as N]?: V }`.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { COMMA, LBRACE, LBRACKET, QUESTION, RBRACE, RBRACKET, COLON } from "../../ir/tokens.ts";
import { EXPAND_AUTO, FLAVOR_OXFMT, FTC_ES5, SEMICOLONS_ALWAYS } from "../../options.ts";
import {
  MM_ADD,
  MM_REMOVE,
  SP,
  TYPE_UNION,
  fileIsJavascript,
  mappedIsOptionalWithPlus,
  mappedIsReadonlyWithPlus,
  mappedNameTy,
  mappedOptional,
  mappedParam,
  mappedReadonly,
  mappedTy,
  typeParamConstraint,
  typeParamName,
  typeParamNamePos,
  typeSpan,
  typeTag,
} from "../../../lint/ast/index.ts";
import { AN_TS_MAPPED_TYPE, mkAn } from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { fmtType, identifier } from "../format.ts";
import { SEMI } from "../../ir/tokens.ts";
import { writeComment } from "../trivia.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";

const PLUS = token("+");
const MINUS = token("-");
const KW_READONLY = token("readonly");
const TOK_IN = token(" in ");
const TOK_IN_NO_BLANK = token(" in");
const TOK_AS = token(" as ");
const MINUS_QUESTION = token("-?");

/** `K in // comment` for oxfmt, `K in  // comment` for Prettier, before a union that has each type on a line of its own. */
function oneBlankBeforeLineCommentBehindIn(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `{ readonly [K in T as N]?: V }` */
export function writeTsMappedType(ty: number, mapped: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const param = mappedParam(mapped);
  const key = typeParamName(param);
  const keyPos = typeParamNamePos(param);
  typeSpan(ty);
  const SP$ = SP;
  const tyStart = SP$.s0 | 0;
  const tyEnd = SP$.s1 | 0;
  if (cm.isSuppressed(keyPos)) {
    writeSuppressedNode(tyStart, tyEnd, f);
    return;
  }
  // One that has a line break after its `{` in the source stays broken.
  const shouldExpand = f.options.expand === EXPAND_AUTO && cx.src.hasLineTerminatorAfterSkippingComments(tyStart + 1);

  const bracketSpacing = f.options.bracketSpacing;
  f.token(LBRACE);
  f.startGroupExpand(shouldExpand);
  f.startSoftBlockIndentWithMaybeSpace(bracketSpacing);

  if (!cx.isQuiet) {
    cm.commentsBeforeCharacter(tyStart, 91);
    writeCommentsBeforeBracket(cm.from, cm.to, f);
  }
  const readonly = mappedReadonly(mapped);
  if (readonly === MM_ADD) {
    if (mappedIsReadonlyWithPlus(mapped)) f.token(PLUS);
    f.token(KW_READONLY);
    f.space();
  } else if (readonly === MM_REMOVE) {
    f.token(MINUS);
    f.token(KW_READONLY);
    f.space();
  }

  f.startGroup();
  f.token(LBRACKET);
  f.startSoftBlockIndent();
  // The blank after `in` stays if a comment that trails the key ends up behind it.
  const constraint = typeParamConstraint(param);
  let commentBringsItsBlank = false;
  if (oneBlankBeforeLineCommentBehindIn(f) && !cx.isQuiet && constraint >= 0 && typeTag(constraint) === TYPE_UNION) {
    typeSpan(constraint);
    cm.commentsBefore(SP$.s0 | 0);
    for (let i = cm.from; i < cm.to; i++) {
      if (cm.followedByNewline(i)) {
        commentBringsItsBlank = true;
        break;
      }
    }
  }
  identifier(key, keyPos, mkAn(AN_TS_MAPPED_TYPE, ty), f);
  f.token(commentBringsItsBlank ? TOK_IN_NO_BLANK : TOK_IN);
  if (constraint >= 0) fmtType(constraint, f);
  const nameType = mappedNameTy(mapped);
  if (nameType >= 0) {
    f.token(TOK_AS);
    fmtType(nameType, f);
  }
  f.endSoftBlockIndent();
  f.token(RBRACKET);
  f.endGroup();

  const optional = mappedOptional(mapped);
  if (optional === MM_ADD) {
    if (mappedIsOptionalWithPlus(mapped)) f.token(PLUS);
    f.token(QUESTION);
  } else if (optional === MM_REMOVE) {
    f.token(MINUS_QUESTION);
  }
  const typeAnnotation = mappedTy(mapped);
  if (typeAnnotation >= 0) {
    f.token(COLON);
    f.space();
    fmtType(typeAnnotation, f);
  }
  // In Flow, whose types those in a JavaScript file are, it is a property of an object type.
  if (fileIsJavascript()) f.writeTrailingCommas(FTC_ES5, COMMA);
  else if (f.options.semicolons === SEMICOLONS_ALWAYS) f.tokenIfBreaks(SEMI);

  f.endSoftBlockIndentWithMaybeSpace(bracketSpacing);
  f.endGroup();
  f.token(RBRACE);
}

/**
 * The comments between the `{` and the `[`, each on its own line. The last one stays on the line of the `[` if it is there in the source and
 * fits.
 */
function writeCommentsBeforeBracket(from: number, to: number, f: Formatter): void {
  if (to <= from) return;
  const cm = cxOf(f).comments;
  for (let i = from; i < to - 1; i++) {
    cm.incrementPrintedCount();
    writeComment(i, f);
    f.hardLineBreak();
  }
  const last = to - 1;
  cm.incrementPrintedCount();
  if (cm.followedByNewline(last)) {
    writeComment(last, f);
    f.hardLineBreak();
  } else {
    f.startGroup();
    writeComment(last, f);
    f.softLineBreakOrSpace();
    f.endGroup();
  }
}
