// Port of vendor/bun/src/format/js/print/function_type.rs: function types, and the signatures of interfaces and type literals that have
// parameters.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  FLAG_ABSTRACT,
  FLAG_OPTIONAL,
  FN_CONSTRUCTOR_TYPE,
  KEY_NONE,
  MEMBER_GETTER,
  MEMBER_SETTER,
  N_TYPE,
  SP,
  fileIsFlow,
  funcFlags,
  funcKind,
  funcOwner,
  funcParamsLen,
  funcParamsSpan,
  funcParamsStart,
  funcReturnType,
  funcThisParam,
  funcTypeParamsLen,
  funcTypeParamsStart,
  keyKind,
  memberFlags,
  memberKind,
  nodeKind,
  nodeOfFunc,
  nodeOfMember,
  paramSpan,
  typeAnnotationSpan,
  listAt,
} from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";
import { AN_TS_METHOD_SIGNATURE, mkAn } from "../ast_nodes.ts";
import { fmtReturnTypeOfFunctionType, fmtTypeAnnotation } from "../format.ts";
import { formatLeadingComments, formatTrailingCommentsRange } from "../trivia.ts";
import { formatComputedOrPropertyKey } from "../utils/object.ts";
import { endOfLineComments } from "../utils/typescript.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { writeFunctionTypeKeyword } from "./flow.ts";
import { shouldGroupFunctionParameters } from "./function.ts";
import { fmtFormalParameters } from "./parameters.ts";
import { typeParameters } from "./type_parameters.ts";

const KW_ABSTRACT = token("abstract ");
const KW_NEW = token("new");
const KW_GET = token("get");
const KW_SET = token("set");
const QUESTION = token("?");

/** `(a: A) => R`, `new (a: A) => R`, `abstract new (a: A) => R` */
export function writeTsFunctionType(ty: number, func: number, f: Formatter): void {
  if (fileIsFlow() && writeFunctionTypeKeyword(ty, func, f)) return;
  if (funcKind(func) === FN_CONSTRUCTOR_TYPE) {
    f.startGroup();
    if ((funcFlags(func) & FLAG_ABSTRACT) !== 0) f.token(KW_ABSTRACT);
    f.token(KW_NEW);
    f.space();
    writeGroupedParametersWithReturnType(func, true, f);
    f.endGroup();
  } else {
    writeGroupedParametersWithReturnType(func, true, f);
  }
}

/** `(a: A): R` */
export function writeTsCallSignatureDeclaration(func: number, f: Formatter): void {
  writeGroupedParametersWithReturnType(func, false, f);
}

/** `new (a: A): R` */
export function writeTsConstructSignatureDeclaration(func: number, f: Formatter): void {
  f.startGroup();
  f.token(KW_NEW);
  f.space();
  writeGroupedParametersWithReturnType(func, false, f);
  f.endGroup();
}

/** `get `, `set `. `kind`: a `MEMBER_*`. */
export function writeAccessorKeyword(kind: number, f: Formatter): void {
  if (kind === MEMBER_GETTER) {
    f.token(KW_GET);
    f.space();
  } else if (kind === MEMBER_SETTER) {
    f.token(KW_SET);
    f.space();
  }
}

/** `a(b: B): R`, `get a(): R`, `set a(b: B)` */
export function writeTsMethodSignature(member: number, func: number, f: Formatter): void {
  f.startGroup();
  writeAccessorKeyword(memberKind(member), f);
  const key = nodeOfMember(member);
  if (keyKind(key) !== KEY_NONE) formatComputedOrPropertyKey(key, mkAn(AN_TS_METHOD_SIGNATURE, member), f);
  if (funcTypeParamsLen(func) === 0) writeCommentsAroundParenthesis(func, f);
  if ((memberFlags(member) & FLAG_OPTIONAL) !== 0) f.token(QUESTION);

  let slot = f.startCapture();
  writeFunctionTypeParameters(func, f);
  const formatTypeParameters = f.endCapture(slot);
  slot = f.startCapture();
  fmtFormalParameters(func, f);
  const formatParameters = f.endCapture(slot);
  slot = f.startCapture();
  writeReturnType(func, f);
  const formatReturnType = f.endCapture(slot);

  if (shouldGroupFunctionParameters(func, formatReturnType, f)) {
    f.startGroup();
    f.writeInterned(formatTypeParameters);
    f.writeInterned(formatParameters);
    f.endGroup();
  } else {
    f.writeInterned(formatTypeParameters);
    f.writeInterned(formatParameters);
  }
  f.startGroup();
  f.writeInterned(formatReturnType);
  f.endGroup();
  f.endGroup();
}

/** The type parameters, the parameters and the return type of a function type or of a signature without a name. */
function writeGroupedParametersWithReturnType(func: number, isFunctionOrConstructorType: boolean, f: Formatter): void {
  f.startGroup();
  let slot = f.startCapture();
  writeFunctionTypeParameters(func, f);
  const formatTypeParameters = f.endCapture(slot);
  slot = f.startCapture();
  fmtFormalParameters(func, f);
  const formatParameters = f.endCapture(slot);
  let formatReturnType = -1;
  if (funcReturnType(func) >= 0) {
    slot = f.startCapture();
    writeReturnTypeWithoutTrailingComments(func, f);
    formatReturnType = f.endCapture(slot);
  }

  if (shouldGroupFunctionParameters(func, formatReturnType, f)) {
    f.startGroup();
    f.writeInterned(formatTypeParameters);
    f.writeInterned(formatParameters);
    f.endGroup();
  } else {
    f.writeInterned(formatTypeParameters);
    f.writeInterned(formatParameters);
  }
  if (isFunctionOrConstructorType) f.space();
  f.writeInterned(formatReturnType);
  f.endGroup();
}

/** The type parameters of a signature, with the comments after them. */
function writeFunctionTypeParameters(func: number, f: Formatter): void {
  const len = funcTypeParamsLen(func);
  if (len === 0) return;
  typeParameters(funcTypeParamsStart(func), len, nodeOfFunc(func), 0, false, f);
  writeCommentsAroundParenthesis(func, f);
}

/**
 * The comments that trail what is before the `(` of a signature: a name or type parameters.
 *
 * - If there are no parameters, those before the `(`, which there is nothing for to lead.
 * - Those after the `(` on the same line, if nothing else follows on that line.
 */
function writeCommentsAroundParenthesis(func: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) return;
  if (!funcParamsSpan(func)) return;
  const spanStart = SP[0] | 0;
  const cm = cx.comments;
  let first = funcThisParam(func);
  if (first < 0 && funcParamsLen(func) > 0) first = listAt(funcParamsStart(func), 0);
  if (first >= 0) {
    // For oxfmt the parentheses are a node, and the comments in it lead the first parameter.
    if (f.options.flavor === FLAVOR_OXFMT) return;
    paramSpan(first);
    cm.commentsBefore(SP[0] | 0);
    const from = cm.from;
    formatTrailingCommentsRange(from, endOfLineComments(f, from, cm.to), f);
  } else {
    cm.commentsBefore(spanStart);
    formatTrailingCommentsRange(cm.from, cm.to, f);
  }
}

/** `FormatNodeWithoutTrailingComments(&FormatReturnType(func))`. */
function writeReturnTypeWithoutTrailingComments(func: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    writeReturnType(func, f);
    return;
  }
  typeAnnotationSpan(funcReturnType(func));
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const cm = cx.comments;
  if (cm.hasTrailingSuppressionComment(end)) {
    formatLeadingComments(start, end, f);
    writeSuppressedNode(start, end, f);
    return;
  }
  // The comments after the node are hidden while it is written.
  const previousLimit = cm.limitCommentsUpTo(end);
  writeReturnType(func, f);
  cm.restoreViewLimit(previousLimit);
}

/**
 * `: R`, `=> R`. Prettier's `printTypeAnnotationProperty`: there is a space between the `)` and the comments before a `:`.
 */
function writeReturnType(func: number, f: Formatter): void {
  const returnType = funcReturnType(func);
  if (returnType < 0) return;
  if (!cxOf(f).isQuiet) {
    typeAnnotationSpan(returnType);
    if (cxOf(f).comments.hasCommentBefore(SP[0] | 0)) f.space();
  }
  if (nodeKind(funcOwner(func)) === N_TYPE) fmtReturnTypeOfFunctionType(returnType, f);
  else fmtTypeAnnotation(returnType, f);
}
