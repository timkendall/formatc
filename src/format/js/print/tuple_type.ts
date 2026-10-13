// Port of vendor/bun/src/format/js/print/tuple_type.rs: `[A, B]`.
import { Formatter } from "../../ir/formatter.ts";
import { COLON, COMMA, LBRACKET, LPAREN, QUESTION, RBRACKET, RPAREN, ELLIPSIS } from "../../ir/tokens.ts";
import { FTC_ES5, TRAILING_SEPARATOR_DISALLOWED, trailingSeparator } from "../../options.ts";
import {
  SP,
  fileIsFlow,
  listAt,
  tupleElemIsOptional,
  tupleElemIsRest,
  tupleElemName,
  tupleElemNamePos,
  tupleElemSpan,
  tupleElemTy,
  typeSpan,
} from "../../../lint/ast/index.ts";
import { AN_TS_NAMED_TUPLE_MEMBER, mkAn } from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { fmtTupleElem, fmtType, identifier } from "../format.ts";
import { JOIN_SOFT_LINE, joinNodesSeparator, writeSeparatorAfter } from "../builders.ts";
import { DANGLING_SOFT, formatDanglingComments } from "../trivia.ts";
import { isInexactTuple, needsParentheses as flowNeedsParentheses, writeTupleElement, writeTupleOfUnknownElements } from "./flow.ts";

/** `[A, B]` */
export function writeTsTupleType(ty: number, elementsStart: number, elementsLen: number, f: Formatter): void {
  const isFlow = fileIsFlow();
  if (isFlow && writeTupleOfUnknownElements(ty, elementsStart, elementsLen, f)) return;
  const needsParentheses = isFlow && flowNeedsParentheses(ty);
  if (needsParentheses) f.token(LPAREN);
  f.token(LBRACKET);
  if (elementsLen === 0) {
    typeSpan(ty);
    formatDanglingComments(SP[0] | 0, SP[1] | 0, DANGLING_SOFT, f);
  } else {
    const separator = isFlow && isInexactTuple(elementsStart, elementsLen) ? TRAILING_SEPARATOR_DISALLOWED : trailingSeparator(FTC_ES5, f.options);
    const isQuiet = cxOf(f).isQuiet;
    f.startGroup();
    f.startSoftBlockIndent();
    for (let i = 0; i < elementsLen; i++) {
      const element = listAt(elementsStart, i);
      if (i > 0) {
        tupleElemSpan(element);
        joinNodesSeparator(f, JOIN_SOFT_LINE, SP[0] | 0, SP[1] | 0);
      }
      // An element and the comments around it are a group, as in Prettier's `printArrayElements`: a comment that ends its line in the
      // source stays before the element if they fit on a line.
      if (isQuiet) {
        fmtTupleElem(element, f);
      } else {
        f.startGroup();
        fmtTupleElem(element, f);
        f.endGroup();
      }
      writeSeparatorAfter(f, COMMA, i === elementsLen - 1, separator, 0);
    }
    f.endSoftBlockIndent();
    f.endGroup();
  }
  f.token(RBRACKET);
  if (needsParentheses) f.token(RPAREN);
}

/** `a: T`, `a?: T`, `T?`, `...T`, `...a: T` */
export function writeTsTupleElement(element: number, f: Formatter): void {
  if (fileIsFlow()) {
    writeTupleElement(element, f);
    return;
  }
  if (tupleElemIsRest(element)) f.token(ELLIPSIS);
  const label = tupleElemName(element);
  if (label >= 0) {
    identifier(label, tupleElemNamePos(element), mkAn(AN_TS_NAMED_TUPLE_MEMBER, element), f);
    if (tupleElemIsOptional(element)) f.token(QUESTION);
    f.token(COLON);
    f.space();
    fmtType(tupleElemTy(element), f);
  } else {
    fmtType(tupleElemTy(element), f);
    if (tupleElemIsOptional(element)) f.token(QUESTION);
  }
}

