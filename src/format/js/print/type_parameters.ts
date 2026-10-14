// Port of vendor/bun/src/format/js/print/type_parameters.rs: `<T, U>`: type parameters and type arguments.
import { Formatter } from "../../ir/formatter.ts";
import { filepathOf } from "../state.ts";
import { token } from "../../ir/element.ts";
import { COMMA, EQ, LANGLE, RANGLE } from "../../ir/tokens.ts";
import { FLAVOR_OXFMT, FTC_ES5, TRAILING_SEPARATOR_MANDATORY, trailingSeparator, TRAILING_SEPARATOR_DISALLOWED, TRAILING_SEPARATOR_OMIT } from "../../options.ts";
import {
  FLAG_CONST,
  FLAG_IN,
  FLAG_OUT,
  N_FUNC,
  N_TYPE,
  N_VAR_DECL,
  SP,
  TYPE_JSDOC,
  TYPE_UNION,
  fileIsFlow,
  fileIsJavascript,
  funcIsArrow,
  listAt,
  nodeId,
  nodeKind,
  typeParamConstraint,
  typeParamDefault,
  typeParamFlags,
  typeParamName,
  typeParamNamePos,
  typeParamSpan,
  typeParent,
  typeSpan,
  typeTag,
  typeUnionTypesLen,
  typeUnionTypesStart,
  varDeclInit,
} from "../../../lint/ast/index.ts";
import { cxOf } from "../context.ts";
import {
  AN_CALL_EXPRESSION,
  AN_TS_TYPE_ANNOTATION,
  AN_TS_TYPE_PARAMETER,
  AN_VARIABLE_DECLARATOR,
  anId,
  anParent,
  anSpan,
  anTag,
  mkAn,
  mkTypeArgumentsAn,
  mkTypeParametersAn,
} from "../ast_nodes.ts";
import { exprArrowFunction } from "../fields.ts";
import { enterScope, fmtType, fmtTypeParam, identifier, leaveScope, PK_NODE, writeTrailingCommentsIn } from "../format.ts";
import { JOIN_SOFT_LINE, JOIN_SPACE, joinNodesSeparator, writeJoinSeparator, writeSeparatorAfter } from "../builders.ts";
import { DANGLING_SOFT, formatDanglingComments, formatLeadingComments } from "../trivia.ts";
import { isTestCallExpressionInFlavor } from "../utils/call_expression.ts";
import { isObjectLikeType, isSimpleType, shouldHugType } from "../utils/typescript.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { writeTypeParameterBound as writeFlowTypeParameterBound, writeTypeParameterModifiers } from "./flow.ts";

const KW_CONST = token("const");
const KW_IN = token("in");
const KW_OUT = token("out");
const KW_EXTENDS = token("extends");
const EMPTY_ANGLES = token("<>");

/** `const in out T extends C = D` */
export function writeTsTypeParameter(param: number, f: Formatter): void {
  const flags = typeParamFlags(param);
  const isFlow = fileIsFlow();
  if (isFlow) {
    writeTypeParameterModifiers(param, f);
  } else if (flags !== 0) {
    if ((flags & FLAG_CONST) !== 0) {
      f.token(KW_CONST);
      f.space();
    }
    if ((flags & FLAG_IN) !== 0) {
      f.token(KW_IN);
      f.space();
    }
    if ((flags & FLAG_OUT) !== 0) {
      f.token(KW_OUT);
      f.space();
    }
  }
  identifier(typeParamName(param), typeParamNamePos(param), mkAn(AN_TS_TYPE_PARAMETER, param), f);

  const constraint = typeParamConstraint(param);
  if (constraint >= 0) {
    if (isFlow) writeFlowTypeParameterBound(param, constraint, f);
    else writeTypeParameterBound(KW_EXTENDS, constraint, f);
  }
  const def = typeParamDefault(param);
  if (def >= 0) writeTypeParameterBound(EQ, def, f);
}

/** ` extends T`, ` = T` */
function writeTypeParameterBound(operator: number, ty: number, f: Formatter): void {
  const groupId = f.groupId();
  // A union that breaks starts with a line break. If there is one after the operator as well,
  // Prettier writes both. The empty text is what makes the second one count.
  const isUnion = typeTag(ty) === TYPE_UNION && typeUnionTypesLen(ty) > 1;
  f.space();
  f.token(operator);
  f.indentedLineGroup(groupId);
  f.lineSuffixBoundary();
  f.startIndentIfGroupBreaks(groupId);
  if (isUnion) f.textSourceNoWs(0, 0);
  fmtType(ty, f);
  f.endIndentIfGroupBreaks(groupId);
}

/**
 * Prettier's `shouldForceTrailingComma`: `<T,>() => {}` in a `.tsx` file, where `<T>` would be
 * the start of an element.
 */
function shouldForceTrailingCommaForArrowFunction(paramsStart: number, paramsLen: number, owner: number, f: Formatter): boolean {
  if (paramsLen !== 1) return false;
  if (nodeKind(owner) !== N_FUNC || !funcIsArrow(nodeId(owner))) return false;
  if (typeParamConstraint(listAt(paramsStart, 0)) >= 0) return false;
  if (fileIsFlow()) return false;
  return !filepathOf(f.options.filepath).endsWith(".ts");
}

/**
 * ESTree's `TSTypeParameterDeclaration`: `type_parameters(params, owner).with_options({ group_id, is_type_or_interface_decl })`.
 * `owner`: a Node, a `Func`, a `Class`, or the `Stmt` of an interface or a type alias. `groupId`: 0 is none. Nothing is written if there are no
 * type parameters.
 */
export function typeParameters(paramsStart: number, paramsLen: number, owner: number, groupId: number, isTypeOrInterfaceDecl: boolean, f: Formatter): void {
  if (paramsLen === 0) return;
  const cx = cxOf(f);
  if (cx.isQuiet) {
    typeParametersWithoutComments(paramsStart, paramsLen, owner, groupId, isTypeOrInterfaceDecl, f);
    return;
  }
  // format_node(node.span(), || node.parent(), f, |f| self.write_without_comments(f))
  const node = mkTypeParametersAn(owner);
  anSpan(node);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    typeParametersWithoutComments(paramsStart, paramsLen, owner, groupId, isTypeOrInterfaceDecl, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_NODE, node, f);
}

/** Without the comments around the `<..>`. */
export function typeParametersWithoutComments(paramsStart: number, paramsLen: number, owner: number, groupId: number, isTypeOrInterfaceDecl: boolean, f: Formatter): void {
  if (paramsLen === 0 && isTypeOrInterfaceDecl) {
    f.token(EMPTY_ANGLES);
    return;
  }
  const node = mkTypeParametersAn(owner);
  f.startGroupWith(groupId, false);
  f.token(LANGLE);
  const grandParent = anParent(anParent(node));
  const SP$ = SP;
  if (anTag(grandParent) === AN_CALL_EXPRESSION && isTestCallExpressionInFlavor(anId(grandParent), f)) {
    for (let i = 0; i < paramsLen; i++) {
      const param = listAt(paramsStart, i);
      if (i > 0) {
        typeParamSpan(param);
        joinNodesSeparator(f, JOIN_SPACE, SP$.s0 | 0, SP$.s1 | 0);
      }
      fmtTypeParam(param, f);
      writeSeparatorAfter(f, COMMA, i === paramsLen - 1, TRAILING_SEPARATOR_OMIT, 0);
    }
  } else {
    const separator = shouldForceTrailingCommaForArrowFunction(paramsStart, paramsLen, owner, f)
      ? TRAILING_SEPARATOR_MANDATORY
      : trailingSeparator(FTC_ES5, f.options);
    f.startSoftBlockIndent();
    for (let i = 0; i < paramsLen; i++) {
      if (i > 0) f.softLineBreakOrSpace();
      fmtTypeParam(listAt(paramsStart, i), f);
      writeSeparatorAfter(f, COMMA, i === paramsLen - 1, separator, 0);
    }
    f.endSoftBlockIndent();
  }
  if (!cxOf(f).isQuiet) {
    anSpan(node);
    formatDanglingComments(SP$.s0 | 0, SP$.s1 | 0, DANGLING_SOFT, f);
  }
  f.token(RANGLE);
  f.endGroup();
}

/**
 * ```ts
 * a<                 a<// comment
 *   // comment       { b: c }>();
 *   { b: c }
 * >();
 * ```
 *
 * Prettier on the left, oxfmt on the right.
 */
function onlyCommentBehindTypeArgumentCounts(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * ESTree's `TSTypeParameterInstantiation`: `type_arguments(params, owner)`. `owner`: a Node, an `Expr`, a `TypeNode`, or the `Class` whose
 * `extends` clause has them. Nothing is written if there are no type arguments.
 */
export function typeArguments(paramsStart: number, paramsLen: number, owner: number, f: Formatter): void {
  if (paramsLen === 0) return;
  const cx = cxOf(f);
  if (cx.isQuiet) {
    typeArgumentsWithoutComments(paramsStart, paramsLen, owner, f);
    return;
  }
  const node = mkTypeArgumentsAn(owner);
  anSpan(node);
  const SP$ = SP;
  const start = SP$.s0 | 0;
  const end = SP$.s1 | 0;
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    typeArgumentsWithoutComments(paramsStart, paramsLen, owner, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_NODE, node, f);
}

/** Without the comments around the `<..>`. */
export function typeArgumentsWithoutComments(paramsStart: number, paramsLen: number, owner: number, f: Formatter): void {
  let shouldInline = false;
  if (paramsLen === 1) {
    const first = listAt(paramsStart, 0);
    shouldInline = shouldHugSingleType(first, f) && !hasCommentOnOwnLine(owner, first, f) && !isArrowFunctionVariableTypeArgument(paramsStart, paramsLen, owner);
  }

  // TypeScript has no `,` after the last type argument. Flow, whose types those in a JavaScript
  // file are, has.
  const separator = fileIsJavascript() && !shouldInline ? trailingSeparator(FTC_ES5, f.options) : TRAILING_SEPARATOR_DISALLOWED;

  if (shouldInline) {
    f.token(LANGLE);
  } else {
    f.startGroup();
    f.token(LANGLE);
    f.startSoftBlockIndent();
  }
  for (let i = 0; i < paramsLen; i++) {
    if (i > 0) writeJoinSeparator(f, JOIN_SOFT_LINE);
    fmtType(listAt(paramsStart, i), f);
    writeSeparatorAfter(f, COMMA, i === paramsLen - 1, separator, 0);
  }
  if (shouldInline) {
    f.token(RANGLE);
  } else {
    f.endSoftBlockIndent();
    f.token(RANGLE);
    f.endGroup();
  }
}

/** Whether a comment around `only`, the only type argument, is a line comment, or the last one ends its line. */
function hasCommentOnOwnLine(owner: number, only: number, f: Formatter): boolean {
  const cx = cxOf(f);
  if (cx.isQuiet) return false;
  const cm = cx.comments;
  anSpan(mkTypeArgumentsAn(owner));
  const SP$ = SP;
  const outerStart = SP$.s0 | 0;
  const outerEnd = SP$.s1 | 0;
  typeSpan(only);
  const innerStart = SP$.s0 | 0;
  const innerEnd = SP$.s1 | 0;
  cm.commentsIn(outerStart, innerStart);
  const beforeFrom = cm.from;
  const beforeTo = cm.to;
  cm.commentsIn(innerEnd, outerEnd);
  const afterFrom = cm.from;
  const afterTo = cm.to;
  if (onlyCommentBehindTypeArgumentCounts(f)) return afterTo > afterFrom;
  for (let i = beforeFrom; i < beforeTo; i++) if (cm.isLine(i)) return true;
  for (let i = afterFrom; i < afterTo; i++) if (cm.isLine(i)) return true;
  if (afterTo > afterFrom) return cm.followedByNewline(afterTo - 1);
  if (beforeTo > beforeFrom) return cm.followedByNewline(beforeTo - 1);
  return false;
}

function shouldHugSingleType(ty: number, f: Formatter): boolean {
  if (isSimpleType(ty) || isObjectLikeType(ty)) return true;
  // `A<B | null | undefined>`
  if (typeTag(ty) === TYPE_UNION && shouldHugType(ty, typeUnionTypesStart(ty), typeUnionTypesLen(ty), f)) return true;
  // Flow's `?T`
  return typeTag(ty) === TYPE_JSDOC && fileIsFlow();
}

/** `const foo: A<B, C> = () => {};` */
function isArrowFunctionVariableTypeArgument(paramsStart: number, paramsLen: number, owner: number): boolean {
  if (paramsLen === 1 && isObjectLikeType(listAt(paramsStart, 0))) return false;
  if (nodeKind(owner) !== N_TYPE || nodeKind(typeParent(nodeId(owner))) !== N_VAR_DECL) return false;
  // The parent is the `TSTypeReference`.
  const grandParent = anParent(anParent(mkTypeArgumentsAn(owner)));
  if (anTag(grandParent) !== AN_TS_TYPE_ANNOTATION) return false;
  const declarator = anParent(grandParent);
  if (anTag(declarator) !== AN_VARIABLE_DECLARATOR) return false;
  const init = varDeclInit(anId(declarator));
  return init >= 0 && exprArrowFunction(init) >= 0;
}
