// Port of vendor/bun/src/format/js/utils/assignment_like.rs: everything that has a left side, an operator and a right side: `a = b`,
// `const a = b`, `a: b`. Prettier's `printAssignment`.
//
// `AssignmentLike::X(h)` is `(kind, h)` with `kind` one of `ASSIGNMENT_LIKE_*` below: `fmtAssignmentLike(kind, h, f)`.
import { Formatter } from "../../ir/formatter.ts";
import { token } from "../../ir/element.ts";
import {
  E_OWNED_TEXT,
  E_SOURCE_TEXT,
  E_SPACE,
  E_TOKEN,
  TOK_BASE,
  TOK_INLINE_MAX,
  twIsMultiline,
} from "../../ir/element.ts";
import { I32Vec } from "../../../base/i32vec.ts";
import { utf16Len } from "../../../base/utf8.ts";
import { FLAVOR_OXFMT, QUOTE_PROPS_CONSISTENT } from "../../options.ts";
import {
  A_require,
  EXPR_ASSIGN,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_AWAIT,
  EXPR_BIG_INT,
  EXPR_BINARY,
  EXPR_CALL,
  EXPR_CLASS,
  EXPR_COND,
  EXPR_DOT,
  EXPR_FALSE,
  EXPR_FN,
  EXPR_IDENT,
  EXPR_IMPORT_META,
  EXPR_INDEX,
  EXPR_INSTANTIATION,
  EXPR_JSX,
  EXPR_NEW_TARGET,
  EXPR_NON_NULL,
  EXPR_NULL,
  EXPR_NUMBER,
  EXPR_OBJECT,
  EXPR_REGEX,
  EXPR_SATISFIES,
  EXPR_SPREAD,
  EXPR_STRING,
  EXPR_TAGGED_TEMPLATE,
  EXPR_TEMPLATE,
  EXPR_THIS,
  EXPR_TRUE,
  EXPR_UNARY,
  EXPR_YIELD,
  BIN_AND,
  BIN_COMMA,
  BIN_NULLISH,
  BIN_OR,
  BODY_EXPR,
  FLAG_ABSTRACT,
  FLAG_ACCESSOR,
  FLAG_AMBIENT,
  FLAG_DEFINITE,
  FLAG_IN,
  FLAG_OPTIONAL,
  FLAG_OUT,
  FLAG_OVERRIDE,
  FLAG_PRIVATE,
  FLAG_PROTECTED,
  FLAG_PUBLIC,
  FLAG_READONLY,
  FLAG_STATIC,
  KEY_COMPUTED,
  KEY_IDENT,
  PAT_IDENT,
  PAT_OBJECT,
  PROP_SHORTHAND,
  PROP_SPREAD,
  SP,
  TYPE_ARRAY,
  TYPE_BIG_INT_LIT,
  TYPE_BOOL_LIT,
  TYPE_COND,
  TYPE_IMPORT,
  TYPE_INDEXED_ACCESS,
  TYPE_INTERSECTION,
  TYPE_KEYOF,
  TYPE_KEYWORD,
  TYPE_NUMBER_LIT,
  TYPE_OBJECT,
  TYPE_READONLY,
  TYPE_REF,
  TYPE_STRING_LIT,
  TYPE_TYPEOF,
  TYPE_UNION,
  TYPE_UNIQUE_SYMBOL,
  assignOpText,
  callArgsLen,
  callArgsStart,
  callCallee,
  callTypeArgsLen,
  callTypeArgsStart,
  classModifiersLen,
  classModifiersStart,
  exprAsCall,
  exprAsCallLike,
  exprAsClass,
  exprAsIdent,
  exprAssignOpOf,
  exprBinaryOpOf,
  exprCallee,
  exprCondNo,
  exprCondTest,
  exprAsTy,
  exprSatisfiesTy,
  exprInstantiationTypeArgsStart,
  exprInstantiationTypeArgsLen,
  exprOuterStart,
  exprOuterEnd,
  keyIsComputed,
  exprCondYes,
  exprEnd,
  exprIsAngleBracketAssertion,
  exprIsAssignmentTarget,
  exprIsChainRoot,
  exprIsOptional,
  exprIsParenthesized,
  exprLeft,
  exprNonNullCount,
  exprObject,
  exprObjectPropsLen,
  exprObjectPropsStart,
  exprOperand,
  exprRegexPatternSpan,
  exprRight,
  exprSpan,
  exprStart,
  exprTag,
  exprTemplateQuasiCount,
  exprTemplateRawSpan,
  exprUnaryOpOf,
  exprParent,
  funcBodyExpr,
  funcBodyKind,
  hir,
  keyExpr,
  keyInnerSpan,
  keyKind,
  keySpan,
  listAt,
  memberFlags,
  memberInit,
  memberModifiersLen,
  memberModifiersStart,
  memberTy,
  modifierDecorator,
  modifierFlagOf,
  N_EXPR,
  N_VAR_DECL,
  nodeId,
  nodeKind,
  nodeOfExpr,
  nodeOfMember,
  nodeOfPatProp,
  nodeOfProp,
  patObjectPropsLen,
  patObjectPropsStart,
  patPropDefault,
  patPropIsRest,
  patPropIsShorthand,
  patPropValue,
  patSpan,
  patStart,
  patEnd,
  patTag,
  propKind,
  propValue,
  typeAnnotationSpan,
  typeArrayElem,
  typeCondYes,
  typeEnd,
  typeIndexedAccessIndex,
  typeIndexedAccessObj,
  typeKeyofTy,
  typeImportArgsLen,
  typeImportArgsStart,
  typeListAngleBrackets,
  typeReadonlyTy,
  typeRefArgsLen,
  typeRefArgsStart,
  typeSpan,
  typeStart,
  typeTag,
  typeTypeofArgsLen,
  typeTypeofArgsStart,
  unOpTextLen,
  varDeclInit,
  varDeclIsDefinite,
  varDeclPat,
  varDeclTy,
  typeCondNo,
} from "../../../lint/ast/index.ts";
import {
  AN_ASSIGNMENT_EXPRESSION,
  AN_VARIABLE_DECLARATOR,
  AN_IDENTIFIER_REFERENCE,
  AN_REG_EXP_LITERAL,
  AN_STRING_LITERAL,
  AN_TEMPLATE_LITERAL,
  AN_THIS_EXPRESSION,
  AN_NULL_LITERAL,
  AN_BIG_INT_LITERAL,
  AN_BOOLEAN_LITERAL,
  AN_NUMERIC_LITERAL,
  AN_BINDING_PROPERTY,
  AN_CALL_EXPRESSION,
  AN_COMPUTED_MEMBER_EXPRESSION,
  AN_EXPRESSION_STATEMENT,
  AN_PRIVATE_FIELD_EXPRESSION,
  AN_STATIC_MEMBER_EXPRESSION,
  AN_UNARY_EXPRESSION,
  anParent,
  anTag,
  exprAsAstNodes,
  exprAstParent,
  memberAsAstNodes,
  mkAn,
  propAsAstNodes,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { exprArgument, exprArrowFunction, exprExpression } from "../fields.ts";
import {
  EO_NONE,
  WK_EXPR,
  WK_PAT,
  WK_TYPE_ANNOTATION,
  exprOptionsArrow,
  fmtExpr,
  fmtExprWithOptions,
  fmtPat,
  fmtTypeAnnotation,
} from "../format.ts";
import { formatLeadingComments, formatTrailingCommentsRange } from "../trivia.ts";
import { writeSuppressedNode } from "./suppressed.ts";
import { fmtNodeWithoutTrailingComments } from "./format_node_without_trailing_comments.ts";
import { isCastTarget } from "./typecast.ts";
import { fmtKey, formatComputedOrPropertyKey, writeMemberName } from "./object.ts";
import { isMemberCallChain } from "./member_chain/mod.ts";
import { expressionNeedsParentheses } from "../parentheses/expression.ts";
import { shouldBreak as experimentalTernaryShouldBreak } from "./experimental_ternary.ts";
import { fmtDecoratorsOfMember } from "../print/decorators.ts";
import { fmtBindingPropertyValue } from "../print/patterns.ts";
import { writeCommentsBeforeClosingParenthesis } from "../print/sequence_expression.ts";
import { unaryArgumentHasComments } from "../print/expressions.ts";
import { ignoredJsxGetsNoParentheses } from "../print/jsx/element.ts";
import { typeArguments } from "../print/type_parameters.ts";
import { writeVarianceSign } from "../print/flow.ts";
import { shouldInlineLogicalExpression } from "../print/binary_like_expression.ts";
import { fmtLiteralStringToken, STRING_LITERAL_PARENT_KIND_EXPRESSION } from "./string.ts";

export const ASSIGNMENT_LIKE_LAYOUT_FLUID: number = 0;
export const ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR: number = 1;
export const ASSIGNMENT_LIKE_LAYOUT_NEVER_BREAK_AFTER_OPERATOR: number = 2;
export const ASSIGNMENT_LIKE_LAYOUT_CHAIN: number = 3;
export const ASSIGNMENT_LIKE_LAYOUT_CHAIN_TAIL: number = 4;
export const ASSIGNMENT_LIKE_LAYOUT_BREAK_LEFT_HAND_SIDE: number = 5;
export const ASSIGNMENT_LIKE_LAYOUT_CHAIN_TAIL_ARROW_FUNCTION: number = 6;
export const ASSIGNMENT_LIKE_VARIABLE_DECLARATOR: number = 0; // h: VarDecl
export const ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION: number = 1; // h: Expr
export const ASSIGNMENT_LIKE_OBJECT_PROPERTY: number = 2; // h: Prop
export const ASSIGNMENT_LIKE_BINDING_PROPERTY: number = 3; // h: PatProp
export const ASSIGNMENT_LIKE_PROPERTY_DEFINITION: number = 4; // h: Member
export const ASSIGNMENT_LIKE_ACCESSOR_PROPERTY: number = 5; // h: Member

const T_EQ_WITH_SPACE = token(" =");
const T_COLON = token(":");
const T_QUESTION = token("?");
const T_BANG = token("!");
const T_LBRACKET = token("[");
const T_RBRACKET = token("]");
const KW_DECLARE = token("declare ");
const KW_PUBLIC = token("public ");
const KW_PROTECTED = token("protected ");
const KW_PRIVATE = token("private ");
const KW_STATIC = token("static ");
const KW_ABSTRACT = token("abstract ");
const KW_OVERRIDE = token("override ");
const KW_READONLY = token("readonly ");
const KW_ACCESSOR = token("accessor ");

/** `+=`, ... for each encoded assignment operator (1 + `BIN_*`). */
const ASSIGN_OPERATOR: Int32Array = makeAssignOperatorTokens();

function makeAssignOperatorTokens(): Int32Array {
  const out = new Int32Array(BIN_COMMA + 2);
  for (let i = 0; i < out.length; i++) out[i] = token(assignOpText(i));
  return out;
}

/** What `nameOnTheLeft` found: `NAME[0]`: 1 `At(span)` (`NAME[1]..NAME[2]`) or 2 `Target(expr)` (`NAME[1]`); `NAME[3]`: the name is short. */
const NAME = new Int32Array(4);
/** What `sidesWithCommentsBetween` found: the end of the left side, the start of the right side, the end of the operator. */
const SIDES = new Int32Array(3);
/** A name is short if it is less than this much wider than the indentation: breaking after the operator would gain next to nothing. */
const MIN_OVERLAP_FOR_BREAK: number = 3;

const callExpressions = new I32Vec(16);
const typeStack = new I32Vec(16);

/**
 * The comments between the left side, which is written and ends at `start`, and `right` that trail the left side.
 */
function formatLeftTrailingComments(start: number, right: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) return;
  if (commentsStayAroundOperator(f)) {
    writeCommentsBeforeOperator(start, f);
  } else {
    const cm = cx.comments;
    cm.commentsTrailingLeftSide(exprStart(right));
    formatTrailingCommentsRange(cm.from, cm.to, f);
  }
}

/**
 * See `commentsStayAroundOperator`: the comments after the left side, which ends at `start`, that trail it. Those behind the operator are
 * hidden.
 */
export function writeCommentsBeforeOperator(start: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  let n = cm.endOfLineCommentsAfter(start);
  if (n === 0) {
    n = cm.commentsBeforeCharacter(start, 61);
    for (let i = cm.from; i < cm.to; i++) {
      if (cm.precededByNewline(i)) {
        n = 0;
        break;
      }
    }
  } else if (cm.isMultilineBlock((cm.to - 1) | 0)) {
    n = 0;
  }
  if (n > 0) formatTrailingCommentsRange(cm.from, cm.to, f);
}

/**
 * For oxfmt a comment stays on the side of the `=` or the `:` that it is on, and a line comment on the line of the operator stays there,
 * with what follows on the next line. Prettier attaches it to one of the two sides, and writes it where the line ends that this side
 * ends on.
 *
 *     const a = // comment      const a = 1; // comment
 *       1;
 */
export function commentsStayAroundOperator(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * The comments behind the operator, which ends at `operatorEnd`, up to a line comment that ends its line. Sets `cm.from`/`cm.to`; the
 * count is 0 if a comment from before the operator is left (then all lead the right side).
 */
function operatorLineRun(operatorEnd: number, f: Formatter): number {
  const cm = cxOf(f).comments;
  if (cm.hasCommentBefore(operatorEnd)) return 0;
  const n = cm.endOfLineCommentsAfter(operatorEnd);
  if (n > 0 && cm.isLine((cm.to - 1) | 0)) return n;
  return 0;
}

function isBlank(text: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const b = text[i] | 0;
    if (!(b === 32 || b === 9 || b === 10 || b === 12 || b === 13)) return false;
  }
  return true;
}

/**
 * The width of what is written for the computed key `owner`, with its brackets, if that is one piece of text: there is no group in it and
 * nothing that can break. Only such a key can be short. Prettier asks whether `cleanDoc(keyDoc)` is a string. -1 if it is not.
 *
 * oxfmt takes what is written in the brackets, whatever it is, without the comments around it.
 */
function computedKeyWidth(owner: number, f: Formatter): number {
  const cx = cxOf(f);
  if (f.options.flavor === FLAVOR_OXFMT) {
    keyInnerSpan(owner);
    return (cx.src.spanWidth(SP[0] | 0, SP[1] | 0) + 2) | 0;
  }
  keySpan(owner);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const text = cx.src.text;
  if (keyKind(owner) === KEY_COMPUTED) {
    const e = keyExpr(owner);
    // A comment in the brackets is a piece of its own.
    const innerStart = exprOuterStart(e);
    const innerEnd = exprOuterEnd(e);
    const a = (start + 1) | 0;
    const b = end > 0 ? (end - 1) | 0 : 0;
    const blankBefore = isBlank(text, a < innerStart ? a : innerStart, innerStart);
    const blankAfter = isBlank(text, innerEnd < b ? innerEnd : b, b);
    if (!(blankBefore && blankAfter)) return -1;
    const w = plainExpressionWidth(e, f);
    return w < 0 ? -1 : (w + 2) | 0;
  }
  // A template is written with a `lineSuffixBoundary`.
  let at = (start + 1) | 0;
  while (at < end) {
    const b = text[at] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) at = (at + 1) | 0;
    else break;
  }
  if (at < end && (text[at] | 0) === 96) return -1;
  return cx.src.spanWidth(start, end);
}

/**
 * See `computedKeyWidth`: `a`, `1`, `-1`, `!a`, `typeof a`, `a++`, `a!`, `await a`, `a as T`, `a<T>`. Not `a.b`, `a()`, `` `a` ``, `[]`.
 * -1 if it is not.
 */
function plainExpressionWidth(e: number, f: Formatter): number {
  const src = cxOf(f).src;
  let width = 0;
  let current = e;
  for (;;) {
    if (current !== e && expressionNeedsParentheses(current, f)) width = (width + 2) | 0;
    switch (exprTag(current)) {
      case EXPR_IDENT:
      case EXPR_THIS:
      case EXPR_NULL:
      case EXPR_TRUE:
      case EXPR_FALSE:
      case EXPR_NUMBER:
      case EXPR_STRING:
      case EXPR_BIG_INT:
      case EXPR_REGEX:
        return (width + src.spanWidth(exprStart(current), exprEnd(current))) | 0;
      case EXPR_IMPORT_META:
        return (width + 11) | 0;
      case EXPR_NEW_TARGET:
        return (width + 10) | 0;
      case EXPR_UNARY: {
        const operand = exprOperand(current);
        // An operand with comments is in a group.
        if (unaryArgumentHasComments(current, operand, f)) return -1;
        const op = exprUnaryOpOf(current);
        width = (width + unOpTextLen(op) + (op >= 4 && op <= 6 ? 1 : 0)) | 0;
        current = operand;
        break;
      }
      case EXPR_NON_NULL:
        width = (width + exprNonNullCount(current)) | 0;
        current = exprOperand(current);
        break;
      case EXPR_AWAIT:
        width = (width + 6) | 0;
        current = exprOperand(current);
        break;
      case EXPR_AS_CONST:
        if (exprIsAngleBracketAssertion(current)) return -1;
        width = (width + 9) | 0;
        current = exprOperand(current);
        break;
      case EXPR_AS: {
        if (exprIsAngleBracketAssertion(current)) return -1;
        const w = plainTypeWidth(exprAsTy(current), f);
        if (w < 0) return -1;
        width = (width + 4 + w) | 0;
        current = exprOperand(current);
        break;
      }
      case EXPR_SATISFIES: {
        const w = plainTypeWidth(exprSatisfiesTy(current), f);
        if (w < 0) return -1;
        width = (width + 11 + w) | 0;
        current = exprOperand(current);
        break;
      }
      case EXPR_INSTANTIATION: {
        const w = plainTypeArgumentsWidth(exprInstantiationTypeArgsStart(current), exprInstantiationTypeArgsLen(current), f);
        if (w < 0) return -1;
        width = (width + w) | 0;
        current = exprOperand(current);
        break;
      }
      default:
        return -1;
    }
  }
}

/**
 * See `computedKeyWidth`: `any`, `"a"`, `A.B`, `A<B>`, `A[]`, `A[B]`, `keyof A`, `typeof a`. Not `A | B`, `[A]`, `{}`, `` `a` ``. The width
 * is that of the type as it is written. -1 if it is not.
 */
function plainTypeWidth(ty: number, f: Formatter): number {
  const typeStack$ = typeStack;
  const base = typeStack$.len;
  typeStack$.push(ty);
  let ok = true;
  while (typeStack$.len > base) {
    const current = typeStack$.pop();
    switch (typeTag(current)) {
      case TYPE_ARRAY:
        typeStack$.push(typeArrayElem(current));
        break;
      case TYPE_KEYOF:
        typeStack$.push(typeKeyofTy(current));
        break;
      case TYPE_READONLY:
        typeStack$.push(typeReadonlyTy(current));
        break;
      case TYPE_INDEXED_ACCESS:
        typeStack$.push(typeIndexedAccessObj(current));
        typeStack$.push(typeIndexedAccessIndex(current));
        break;
      case TYPE_UNIQUE_SYMBOL:
        break;
      case TYPE_REF:
        if (typeRefArgsLen(current) > 0) {
          if (plainTypeArgumentsWidth(typeRefArgsStart(current), typeRefArgsLen(current), f) < 0) ok = false;
        } else if (nameOrLiteralTypeWidth(current, f) < 0) ok = false;
        break;
      case TYPE_TYPEOF:
        if (typeTypeofArgsLen(current) > 0 && plainTypeArgumentsWidth(typeTypeofArgsStart(current), typeTypeofArgsLen(current), f) < 0) ok = false;
        break;
      case TYPE_IMPORT:
        if (typeImportArgsLen(current) > 0 && plainTypeArgumentsWidth(typeImportArgsStart(current), typeImportArgsLen(current), f) < 0) ok = false;
        break;
      default:
        if (nameOrLiteralTypeWidth(current, f) < 0) ok = false;
        break;
    }
    if (!ok) break;
  }
  typeStack$.len = base;
  if (!ok) return -1;
  return cxOf(f).src.spanWidth(typeStart(ty), typeEnd(ty));
}

/** `<A>`: one type argument that is a name, a keyword or a literal is written without a group. -1 if it is not. */
function plainTypeArgumentsWidth(start: number, len: number, f: Formatter): number {
  if (len !== 1) return -1;
  const w = nameOrLiteralTypeWidth(listAt(start, 0), f);
  return w < 0 ? -1 : (w + 2) | 0;
}

function nameOrLiteralTypeWidth(ty: number, f: Formatter): number {
  let isNameOrLiteral: boolean;
  switch (typeTag(ty)) {
    case TYPE_KEYWORD:
    case TYPE_NUMBER_LIT:
    case TYPE_BIG_INT_LIT:
    case TYPE_BOOL_LIT:
      isNameOrLiteral = true;
      break;
    case TYPE_STRING_LIT:
      isNameOrLiteral = (hir.text[typeStart(ty)] | 0) !== 96;
      break;
    case TYPE_REF:
      isNameOrLiteral = typeRefArgsLen(ty) === 0;
      break;
    default:
      isNameOrLiteral = false;
      break;
  }
  return isNameOrLiteral ? cxOf(f).src.spanWidth(typeStart(ty), typeEnd(ty)) : -1;
}

/** The decorators, the modifiers, the name, `?`, `!` and the type of a property of a class. */
function writePropertyDefinitionLeft(member: number, f: Formatter): void {
  const modsStart = memberModifiersStart(member);
  const modsLen = memberModifiersLen(member);
  if (modsLen > 0) {
    fmtDecoratorsOfMember(member, f);
    let written = 0;
    for (let i = 0; i < modsLen; i++) written = written | (modifierFlagOf(listAt(modsStart, i)) | 0);
    if ((written & FLAG_AMBIENT) !== 0) f.token(KW_DECLARE);
    if ((written & FLAG_PUBLIC) !== 0) f.token(KW_PUBLIC);
    if ((written & FLAG_PROTECTED) !== 0) f.token(KW_PROTECTED);
    if ((written & FLAG_PRIVATE) !== 0) f.token(KW_PRIVATE);
    if ((written & FLAG_STATIC) !== 0) f.token(KW_STATIC);
    if ((written & FLAG_ABSTRACT) !== 0) f.token(KW_ABSTRACT);
    if ((written & FLAG_OVERRIDE) !== 0) f.token(KW_OVERRIDE);
    if ((written & FLAG_READONLY) !== 0) f.token(KW_READONLY);
    if ((written & FLAG_ACCESSOR) !== 0) f.token(KW_ACCESSOR);
    if ((written & (FLAG_IN | FLAG_OUT)) !== 0) writeVarianceSign(modsStart, modsLen, f);
  }
  const owner = nodeOfMember(member);
  const kind = keyKind(owner);
  if (kind >= 0) {
    if (keyIsComputed(owner)) {
      formatComputedOrPropertyKey(owner, memberAsAstNodes(member), f);
    } else {
      writeMemberName(owner, memberAsAstNodes(member), f);
    }
  }
  const flags = memberFlags(member);
  if ((flags & FLAG_OPTIONAL) !== 0) f.token(T_QUESTION);
  if ((flags & FLAG_DEFINITE) !== 0) f.token(T_BANG);
  const ty = memberTy(member);
  if (ty >= 0) fmtTypeAnnotation(ty, f);
}

/**
 * Whether the left side of `(kind, h)` is a name without comments, and can be told without writing it: `NAME` is set. See
 * `writeLeft`, which writes and returns the same.
 */
function nameOnTheLeft(kind: number, h: number, f: Formatter): boolean {
  if (!cxOf(f).isQuiet) return false;
  let owner: number;
  switch (kind) {
    case ASSIGNMENT_LIKE_VARIABLE_DECLARATOR: {
      const id = varDeclPat(h);
      if (patTag(id) !== PAT_IDENT || varDeclTy(h) >= 0 || varDeclIsDefinite(h)) return false;
      patSpan(id);
      NAME[0] = 1;
      NAME[1] = SP[0] | 0;
      NAME[2] = SP[1] | 0;
      NAME[3] = 0;
      return true;
    }
    case ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION: {
      const target = exprLeft(h);
      if (target < 0 || exprTag(target) !== EXPR_IDENT) return false;
      NAME[0] = 2;
      NAME[1] = target;
      NAME[3] = 0;
      return true;
    }
    case ASSIGNMENT_LIKE_OBJECT_PROPERTY:
      owner = nodeOfProp(h);
      break;
    case ASSIGNMENT_LIKE_BINDING_PROPERTY:
      owner = nodeOfPatProp(h);
      break;
    default:
      return false;
  }
  if (keyKind(owner) !== KEY_IDENT || f.options.quoteProperties === QUOTE_PROPS_CONSISTENT) return false;
  keySpan(owner);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const textWidthForBreak = (f.options.indentWidth + MIN_OVERLAP_FOR_BREAK) | 0;
  // No text is wider than it is long.
  const isShort = end - start < textWidthForBreak || f.stringWidth(f.source, start, end) < textWidthForBreak;
  NAME[0] = 1;
  NAME[1] = start;
  NAME[2] = end;
  NAME[3] = isShort ? 1 : 0;
  return true;
}

/** Writes the left side. Returns whether it is a short name. */
function writeLeft(kind: number, h: number, f: Formatter): boolean {
  const textWidthForBreak = (f.options.indentWidth + MIN_OVERLAP_FOR_BREAK) | 0;
  switch (kind) {
    case ASSIGNMENT_LIKE_VARIABLE_DECLARATOR: {
      const id = varDeclPat(h);
      const ty = varDeclTy(h);
      const definite = varDeclIsDefinite(h);
      const init = varDeclInit(h);
      if (init < 0) {
        fmtPat(id, f);
        if (definite) f.token(T_BANG);
        if (ty >= 0) fmtTypeAnnotation(ty, f);
        return false;
      }
      const cx = cxOf(f);
      if (ty >= 0 && !cx.isQuiet && cx.comments.hasTrailingSuppressionComment(typeEnd(ty))) {
        // `a: T = // prettier-ignore`: the comment trails the name, which the type is part of.
        const start = patStart(id);
        const end = typeEnd(ty);
        formatLeadingComments(start, end, f);
        writeSuppressedNode(start, end, f);
      } else if (ty >= 0) {
        fmtNodeWithoutTrailingComments(WK_PAT, id, f);
        if (definite) f.token(T_BANG);
        fmtNodeWithoutTrailingComments(WK_TYPE_ANNOTATION, ty, f);
      } else {
        fmtNodeWithoutTrailingComments(WK_PAT, id, f);
        if (definite) f.token(T_BANG);
      }
      formatLeftTrailingComments(patEnd(id), init, f);
      return false;
    }
    case ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION: {
      const target = exprLeft(h);
      const value = exprRight(h);
      if (target < 0 || value < 0) return false;
      fmtNodeWithoutTrailingComments(WK_EXPR, target, f);
      formatLeftTrailingComments(exprEnd(target), value, f);
      return false;
    }
    case ASSIGNMENT_LIKE_OBJECT_PROPERTY: {
      if (propKind(h) === PROP_SHORTHAND) {
        fmtExpr(propValue(h), f);
        return false;
      }
      const owner = nodeOfProp(h);
      const kindOfKey = keyKind(owner);
      if (kindOfKey < 0) return false;
      if (keyIsComputed(owner)) {
        f.token(T_LBRACKET);
        fmtKey(owner, propAsAstNodes(h), f);
        f.token(T_RBRACKET);
        const w = computedKeyWidth(owner, f);
        return w >= 0 && w < textWidthForBreak;
      }
      return writeMemberName(owner, propAsAstNodes(h), f) < textWidthForBreak;
    }
    case ASSIGNMENT_LIKE_BINDING_PROPERTY: {
      const node = mkAn(AN_BINDING_PROPERTY, h);
      if (patPropIsShorthand(h)) {
        fmtBindingPropertyValue(h, f);
        return false;
      }
      const owner = nodeOfPatProp(h);
      const kindOfKey = keyKind(owner);
      if (kindOfKey < 0) return false;
      if (keyIsComputed(owner)) {
        f.token(T_LBRACKET);
        fmtKey(owner, node, f);
        f.token(T_RBRACKET);
        const w = computedKeyWidth(owner, f);
        return w >= 0 && w < textWidthForBreak;
      }
      return writeMemberName(owner, node, f) < textWidthForBreak;
    }
    default:
      writePropertyDefinitionLeft(h, f);
      return false;
  }
}

function writeOperator(kind: number, h: number, f: Formatter): void {
  switch (kind) {
    case ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION: {
      const op = exprAssignOpOf(h);
      if (op === 0) f.token(T_EQ_WITH_SPACE);
      else if (op > 0) {
        f.space();
        f.token(ASSIGN_OPERATOR[op] | 0);
      }
      return;
    }
    case ASSIGNMENT_LIKE_OBJECT_PROPERTY:
    case ASSIGNMENT_LIKE_BINDING_PROPERTY:
      f.token(T_COLON);
      return;
    default:
      f.token(T_EQ_WITH_SPACE);
      return;
  }
}

/**
 * `right`: `getRightExpression`. `fluidGroupId`: in the fluid layout, of the group with the line break after the operator (0: none).
 */
function writeRight(kind: number, h: number, right: number, f: Formatter, layout: number, fluidGroupId: number): void {
  if (kind === ASSIGNMENT_LIKE_BINDING_PROPERTY) {
    fmtBindingPropertyValue(h, f);
    return;
  }
  if (right >= 0) {
    // Prettier's `isOnSameLineAsAssignment`.
    if (
      f.options.experimentalTernaries &&
      exprTag(right) === EXPR_COND &&
      layout !== ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR &&
      kind !== ASSIGNMENT_LIKE_ACCESSOR_PROPERTY &&
      !isCastTarget(right, f)
    ) {
      if (experimentalTernaryShouldBreak(right, f)) {
        f.startIndent();
        fmtExpr(right, f);
        f.endIndent();
      } else {
        f.startGroup();
        f.startIndent();
        // Behind the line break after the operator, Prettier's `softline` is a second one.
        if (fluidGroupId !== 0) {
          f.startIfGroupBreaksId(fluidGroupId);
          f.softEmptyLine();
          f.endConditional();
          f.startIfGroupFitsId(fluidGroupId);
          f.softLineBreak();
          f.endConditional();
        } else if (layout === ASSIGNMENT_LIKE_LAYOUT_CHAIN_TAIL) {
          // The chain is broken if this group is.
          f.softEmptyLine();
        } else {
          f.softLineBreak();
        }
        fmtExpr(right, f);
        f.endIndent();
        f.endGroup();
      }
    } else if (exprTag(right) === EXPR_FN && !isCastTarget(right, f)) {
      fmtExprWithAssignmentLayout(right, layout, f);
    } else {
      fmtExpr(right, f);
    }
  }
  if (kind === ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION) writeCommentsBeforeClosingParenthesis(h, f);
}

// What the comments before the right side of an assignment mean for its layout.
const LC_NONE: number = 0;
/** One ends its line, or is a block whose lines all start with `*`: the right side starts on its own line. */
const LC_BREAK: number = 1;
/** `/** @type {T} *\/ (e)`: the right side is in parentheses. */
const LC_TYPE_CAST: number = 2;
/** `/** @type {T} *\/ (a).b`, `/** @type {T} *\/ (a) || b`: what the right side starts with is. */
const LC_TYPE_CAST_OF_LEFT_EDGE: number = 3;

/** `a = /** @type {T} *\/ (⏎/**⏎ * comment⏎ *\/⏎b)`: oxfmt looks at all comments before `b`. */
function blockCommentInParenthesesOfCastBreaks(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * `a =⏎// comment⏎b?.c` is `a = // comment⏎b?.c` in TypeScript: typescript-estree has a `ChainExpression` around `b?.c`, which Prettier
 * attaches no comment to. The comment leads what is in it, and the right side has none.
 */
function commentsLeadWhatIsInChainExpression(e: number, f: Formatter): boolean {
  return exprIsChainRoot(e) && !cxOf(f).hasTreeOfBabel && f.options.flavor !== FLAVOR_OXFMT;
}

function leadingCommentsOfRightSide(right: number, f: Formatter): number {
  const cx = cxOf(f);
  if (cx.isQuiet || commentsLeadWhatIsInChainExpression(right, f)) return LC_NONE;
  const cm = cx.comments;
  exprSpan(right);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  if (exprTag(right) === EXPR_JSX) {
    return cm.isSuppressed(start) && ignoredJsxGetsNoParentheses(f) ? LC_BREAK : LC_NONE;
  }
  if (cm.nextStart() >= start) return LC_NONE;
  if (blockCommentInParenthesesOfCastBreaks(f)) {
    cm.commentsBefore(start);
    for (let i = cm.from; i < cm.to; i++) if (cm.isIndentableBlock(i)) return LC_BREAK;
  }
  cm.commentsBefore(start);
  const from = cm.from;
  const to = cm.to;
  for (let i = from; i < to; i++) {
    if (cm.leadsLeftEdgeOf(i, end)) continue;
    if (cm.followedByNewline(i) || cm.isIndentableBlock(i)) return LC_BREAK;
    // `/** @type {T} */ a.b()` casts nothing.
    if (cm.isTypeCastComment(i) && cx.src.nextNonWhitespaceByteIs(cm.ce[i] | 0, 40)) {
      return exprIsParenthesized(right) ? LC_TYPE_CAST : LC_TYPE_CAST_OF_LEFT_EDGE;
    }
  }
  return LC_NONE;
}

/** 0: it is neither a binary nor a logical expression, 1: it breaks after the operator, 2: it does not. */
function breaksAsBinaryExpression(e: number, f: Formatter): number {
  const op = exprBinaryOpOf(e);
  if (op < 0 || op === BIN_COMMA) return 0;
  if (op === BIN_AND || op === BIN_OR || op === BIN_NULLISH) return shouldInlineLogicalExpression(e, f) ? 2 : 1;
  return 1;
}

/** Prettier's `shouldBreakAfterOperator`. */
function shouldBreakAfterOperator(right: number, isLeftShort: boolean, startsWithTypeCast: boolean, f: Formatter): boolean {
  switch (exprTag(right)) {
    case EXPR_BINARY:
      return breaksAsBinaryExpression(right, f) !== 2;
    case EXPR_COND: {
      if (f.options.experimentalTernaries) {
        return exprTag(exprCondYes(right)) === EXPR_COND || exprTag(exprCondNo(right)) === EXPR_COND;
      }
      const test = exprCondTest(right);
      // `/** @type {T} */ (a || b) ? c : d`: the test is in parentheses.
      if (startsWithTypeCast && isCastTarget(test, f)) return false;
      return breaksAsBinaryExpression(test, f) === 1;
    }
    case EXPR_CLASS: {
      const cls = exprAsClass(right);
      if (cls < 0) return false;
      const s = classModifiersStart(cls);
      const n = classModifiersLen(cls);
      for (let i = 0; i < n; i++) if (modifierDecorator(listAt(s, i)) >= 0) return true;
      return false;
    }
    default: {
      if (isLeftShort) return false;
      const inner = getInnermostExpression(right, f);
      return (
        (exprTag(inner) === EXPR_STRING && !isCastTarget(inner, f)) ||
        (!startsWithTypeCast && isPoorlyBreakableMemberOrCallChain(inner, f))
      );
    }
  }
}

/** The `a()` of `void !!(await a())`. */
function getInnermostExpression(e: number, f: Formatter): number {
  let current = e;
  for (;;) {
    if (isCastTarget(current, f)) return current;
    let inner = -1;
    switch (exprTag(current)) {
      case EXPR_UNARY: {
        const op = exprUnaryOpOf(current);
        // `++`, `--`
        if (op >= 7) return current;
        inner = exprArgument(current);
        break;
      }
      case EXPR_AWAIT:
      case EXPR_YIELD:
        inner = exprArgument(current);
        break;
      // All of `a?.b!` is a `ChainExpression`.
      case EXPR_NON_NULL:
        if (!exprIsChainRoot(current)) inner = exprExpression(current);
        break;
      default:
        break;
    }
    if (inner < 0) return current;
    current = inner;
  }
}

/** Whether `(kind, h)` has no operator and no right side: `let a`, `{ a }`. */
function hasOnlyLeftHandSide(kind: number, h: number): boolean {
  switch (kind) {
    case ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION:
      return false;
    case ASSIGNMENT_LIKE_VARIABLE_DECLARATOR:
      return varDeclInit(h) < 0;
    case ASSIGNMENT_LIKE_PROPERTY_DEFINITION:
    case ASSIGNMENT_LIKE_ACCESSOR_PROPERTY:
      return memberInit(h) < 0;
    // The value of `{ a = 1 }` includes the name.
    case ASSIGNMENT_LIKE_BINDING_PROPERTY:
      return patPropIsShorthand(h);
    default:
      return propKind(h) === PROP_SHORTHAND;
  }
}

function getRightExpression(kind: number, h: number): number {
  switch (kind) {
    case ASSIGNMENT_LIKE_VARIABLE_DECLARATOR:
      return varDeclInit(h);
    case ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION:
      return exprRight(h);
    case ASSIGNMENT_LIKE_OBJECT_PROPERTY:
      return propValue(h);
    case ASSIGNMENT_LIKE_BINDING_PROPERTY:
      return -1;
    default:
      return memberInit(h);
  }
}

/** Prettier's `isAssignment` chains: `a = b = c`. -1 if it is not one. `isTypeCast`: whether `rightExpression` is in the parentheses of a type cast. */
function chainFormattingLayout(kind: number, h: number, rightExpression: number, isTypeCast: boolean, f: Formatter): number {
  if (kind !== ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION) return -1;
  if (isCastTarget(h, f)) return -1;
  // Anything else is in neither a declarator nor an assignment.
  const parentNode = exprParent(h);
  const pk = nodeKind(parentNode);
  if (pk === N_VAR_DECL) {
    // fine
  } else if (!(pk === N_EXPR && exprTag(nodeId(parentNode)) === EXPR_ASSIGN)) {
    return -1;
  }
  const rightIsTail = isTypeCast || exprTag(rightExpression) !== EXPR_ASSIGN;
  const parent = exprAstParent(h);
  let upperChainIsEligible: boolean;
  const pt = anTag(parent);
  if (pt === AN_VARIABLE_DECLARATOR) {
    upperChainIsEligible = !rightIsTail;
  } else if (pt === AN_ASSIGNMENT_EXPRESSION) {
    upperChainIsEligible = !rightIsTail || anTag(anParent(parent)) !== AN_EXPRESSION_STATEMENT;
  } else {
    upperChainIsEligible = false;
  }
  if (!upperChainIsEligible) return -1;
  if (!rightIsTail) return ASSIGNMENT_LIKE_LAYOUT_CHAIN;
  let isArrowChain = false;
  if (!isTypeCast) {
    const arrow = exprArrowFunction(rightExpression);
    if (arrow >= 0 && funcBodyKind(arrow) === BODY_EXPR) {
      const body = funcBodyExpr(arrow);
      isArrowChain = exprArrowFunction(body) >= 0 && !isCastTarget(body, f);
    }
  }
  return isArrowChain ? ASSIGNMENT_LIKE_LAYOUT_CHAIN_TAIL_ARROW_FUNCTION : ASSIGNMENT_LIKE_LAYOUT_CHAIN_TAIL;
}

/** `require("a")` */
function isRequireCall(e: number): boolean {
  if (exprTag(e) !== EXPR_CALL || anTag(exprAsAstNodes(e)) !== AN_CALL_EXPRESSION) return false;
  const callee = exprCallee(e);
  return callee >= 0 && exprAsIdent(callee) === A_require;
}

/** Prettier's `chooseLayout`. `rightExpression`: `getRightExpression`. */
function chooseLayout(kind: number, h: number, rightExpression: number, isLeftShort: boolean, leftMayBreak: boolean, f: Formatter): number {
  // For Prettier the right side is a `ParenthesizedExpression` then, whatever is in it.
  const isTypeCast = rightExpression >= 0 && isCastTarget(rightExpression, f);
  let startsWithTypeCast = false;
  if (rightExpression >= 0) {
    const e = rightExpression;
    const chain = chainFormattingLayout(kind, h, e, isTypeCast, f);
    if (chain >= 0) return chain;
    // `a = b = c = d`
    if (exprTag(e) === EXPR_ASSIGN && !isTypeCast && anTag(exprAsAstNodes(e)) === AN_ASSIGNMENT_EXPRESSION) {
      const value = exprRight(e);
      if (value >= 0 && exprTag(value) === EXPR_ASSIGN && !isCastTarget(value, f)) return ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR;
    }
    const lc = leadingCommentsOfRightSide(e, f);
    if (lc === LC_BREAK) return ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR;
    if (lc === LC_TYPE_CAST_OF_LEFT_EDGE) startsWithTypeCast = true;
    if (!isTypeCast && isRequireCall(e)) return ASSIGNMENT_LIKE_LAYOUT_NEVER_BREAK_AFTER_OPERATOR;
  }
  // The right side of a property of a pattern is not an expression.
  if (kind === ASSIGNMENT_LIKE_BINDING_PROPERTY) {
    const cx = cxOf(f);
    if (!cx.isQuiet) {
      const cm = cx.comments;
      cm.commentsBefore(patStart(patPropValue(h)));
      for (let i = cm.from; i < cm.to; i++) {
        if (cm.followedByNewline(i) || cm.isIndentableBlock(i)) return ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR;
      }
    }
  }

  if (shouldBreakLeftHandSide(kind, h, leftMayBreak && !isTypeCast)) return ASSIGNMENT_LIKE_LAYOUT_BREAK_LEFT_HAND_SIDE;
  if (!isTypeCast && rightExpression >= 0 && shouldBreakAfterOperator(rightExpression, isLeftShort, startsWithTypeCast, f)) {
    return ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR;
  }
  if (!leftMayBreak) {
    if (isLeftShort) return ASSIGNMENT_LIKE_LAYOUT_NEVER_BREAK_AFTER_OPERATOR;
    if (rightExpression >= 0 && !isTypeCast) {
      switch (exprTag(rightExpression)) {
        case EXPR_CLASS:
        case EXPR_TEMPLATE:
        case EXPR_TAGGED_TEMPLATE:
        case EXPR_TRUE:
        case EXPR_FALSE:
        case EXPR_NUMBER:
          return ASSIGNMENT_LIKE_LAYOUT_NEVER_BREAK_AFTER_OPERATOR;
        default:
          break;
      }
    }
  }
  return ASSIGNMENT_LIKE_LAYOUT_FLUID;
}

function shouldBreakLeftHandSide(kind: number, h: number, leftMayBreak: boolean): boolean {
  if (isComplexDestructuring(kind, h)) return true;
  if (kind !== ASSIGNMENT_LIKE_VARIABLE_DECLARATOR) return false;
  const ty = varDeclTy(h);
  return (ty >= 0 && isComplexTypeAnnotation(ty)) || (leftMayBreak && varDeclInit(h) >= 0 && exprArrowFunction(varDeclInit(h)) >= 0);
}

/** Prettier's `isComplexDestructuringTarget`: an object pattern with more than two properties, one of which has a value or a default. */
function isComplexDestructuring(kind: number, h: number): boolean {
  if (kind === ASSIGNMENT_LIKE_VARIABLE_DECLARATOR) {
    const pat = varDeclPat(h);
    if (patTag(pat) !== PAT_OBJECT) return false;
    const n = patObjectPropsLen(pat);
    if (n <= 2) return false;
    const s = patObjectPropsStart(pat);
    for (let i = 0; i < n; i++) {
      const p = listAt(s, i);
      if (!patPropIsRest(p) && (!patPropIsShorthand(p) || patPropDefault(p) >= 0)) return true;
    }
    return false;
  }
  if (kind === ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION) {
    const left = exprLeft(h);
    if (left < 0 || exprTag(left) !== EXPR_OBJECT || !exprIsAssignmentTarget(left)) return false;
    const n = exprObjectPropsLen(left);
    if (n <= 2) return false;
    const s = exprObjectPropsStart(left);
    for (let i = 0; i < n; i++) {
      const p = listAt(s, i);
      const k = propKind(p);
      if (k === PROP_SPREAD) continue;
      if (k === PROP_SHORTHAND) {
        const value = propValue(p);
        if (value >= 0 && exprTag(value) === EXPR_ASSIGN) return true;
        continue;
      }
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Whether `(kind, h)`'s left side is nothing but text on one line: at most 12 elements written since `from`, all tokens, spaces or
 * texts without a line break.
 */
function isTextOnOneLine(from: number, f: Formatter): boolean {
  const st = f.st;
  const n = st.len;
  if (n - from > 12) return false;
  for (let i = from; i < n; i++) {
    const t = st.tag[i] | 0;
    if (t === E_SPACE || t === E_TOKEN) continue;
    if (t > TOK_BASE && t <= TOK_BASE + TOK_INLINE_MAX) continue;
    if ((t === E_SOURCE_TEXT || t === E_OWNED_TEXT) && !twIsMultiline(st.c[i] | 0)) continue;
    return false;
  }
  return true;
}

/** Whether there is a group around the assignment. `isLeftText`: the left side is nothing but text on one line. */
function layoutHasGroupAroundIt(layout: number, isLeftText: boolean): boolean {
  switch (layout) {
    case ASSIGNMENT_LIKE_LAYOUT_CHAIN:
    case ASSIGNMENT_LIKE_LAYOUT_CHAIN_TAIL:
    case ASSIGNMENT_LIKE_LAYOUT_CHAIN_TAIL_ARROW_FUNCTION:
      return false;
    // All that can break is in the group after the operator, which fits if and only if a group around text and it fits.
    case ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR:
      return !isLeftText;
    default:
      return true;
  }
}

/** `AssignmentLike::X(h).fmt(f)` */
export function fmtAssignmentLike(kind: number, h: number, f: Formatter): void {
  if (hasOnlyLeftHandSide(kind, h)) {
    writeLeft(kind, h, f);
    return;
  }
  const rightExpression = getRightExpression(kind, h);
  if (nameOnTheLeft(kind, h, f)) {
    const nameKind = NAME[0] | 0;
    const nameA = NAME[1] | 0;
    const nameB = NAME[2] | 0;
    const layout = chooseLayout(kind, h, rightExpression, (NAME[3] | 0) !== 0, false, f);
    const grouped = layoutHasGroupAroundIt(layout, true);
    if (grouped) f.startGroup();
    if (nameKind === 1) f.sourceText(nameA, nameB);
    else fmtExpr(nameA, f);
    writeOperator(kind, h, f);
    writeAfterOperator(kind, h, rightExpression, layout, f);
    if (grouped) f.endGroup();
    return;
  }

  const cx = cxOf(f);
  // Whether there is a group around it all, and one around the left side, depends on the layout, which depends on what is written for the
  // left side.
  const outerGroup = f.reserveTag();
  const leftGroup = f.reserveTag();
  // See `commentsStayAroundOperator`. Where the left side ends, the right side starts and the operator ends.
  let hasSides = false;
  let leftEnd = 0;
  let rightStart = 0;
  let operatorEnd = 0;
  if (!cx.isQuiet && commentsStayAroundOperator(f) && sidesWithCommentsBetween(kind, h, rightExpression, f)) {
    hasSides = true;
    leftEnd = SIDES[0] | 0;
    rightStart = SIDES[1] | 0;
    operatorEnd = SIDES[2] | 0;
  }
  const cm = cx.comments;
  const previousLimit = hasSides ? cm.limitCommentsUpTo(operatorEnd) : 0;
  const isLeftShort = writeLeft(kind, h, f);
  if (hasSides) cm.restoreViewLimit(previousLimit);
  let runFrom = 0;
  let runTo = 0;
  if (hasSides) {
    const runLen = operatorLineRun(operatorEnd, f);
    if (runLen > 0) {
      runFrom = cm.from;
      runTo = cm.to;
    }
  }
  const hasRun = runTo > runFrom;
  const hasLineCommentOnOperatorLine = hasRun || (hasSides && cm.hasPrintedLineCommentAfter(leftEnd));
  const leftFrom = (leftGroup + 1) | 0;
  const isLeftText = isTextOnOneLine(leftFrom, f);
  const leftMayBreak = !isLeftText && f.mayDirectlyBreakFrom(leftFrom);
  let layout = chooseLayout(kind, h, rightExpression, isLeftShort, leftMayBreak, f);
  if (
    (layout === ASSIGNMENT_LIKE_LAYOUT_FLUID || layout === ASSIGNMENT_LIKE_LAYOUT_NEVER_BREAK_AFTER_OPERATOR) &&
    hasLineCommentOnOperatorLine &&
    !(rightExpression >= 0 && isRequireCall(rightExpression))
  ) {
    layout = ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR;
  }
  // A group of text at the start of a group makes no difference: `isAtStartOfGroup`.
  if (layout !== ASSIGNMENT_LIKE_LAYOUT_BREAK_LEFT_HAND_SIDE && !(isLeftText && layoutHasGroupAroundIt(layout, false))) {
    f.groupFrom(leftGroup, false);
  }

  writeOperator(kind, h, f);
  if (hasSides && hasRun) {
    formatTrailingCommentsRange(runFrom, runTo, f);
    let anySuppression = false;
    for (let i = runFrom; i < runTo; i++) {
      if (cm.isSuppressionComment(i)) {
        anySuppression = true;
        break;
      }
    }
    if (anySuppression) cm.markSuppressedAfterOperator(rightStart);
  }
  // Without a group of its own the line break follows the group around it all, which the line comment breaks.
  const followsLineComment = hasLineCommentOnOperatorLine && layout === ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR;
  if (followsLineComment) {
    f.startSoftLineIndentOrSpace();
    writeRight(kind, h, rightExpression, f, layout, 0);
    f.endSoftLineIndentOrSpace();
  } else {
    writeAfterOperator(kind, h, rightExpression, layout, f);
  }

  if (followsLineComment || layoutHasGroupAroundIt(layout, isLeftText)) f.groupFrom(outerGroup, false);
}

/**
 * Where the left side ends, where the right side starts and where the operator between them ends, if there is a comment between the two
 * sides: into `SIDES`, and true.
 *
 * `rightExpression`: `getRightExpression`.
 */
function sidesWithCommentsBetween(kind: number, h: number, rightExpression: number, f: Formatter): boolean {
  const rightStartOfExpression = rightExpression >= 0 ? exprStart(rightExpression) : -1;
  let leftEnd: number;
  let rightStart: number;
  let operator: number;
  switch (kind) {
    case ASSIGNMENT_LIKE_VARIABLE_DECLARATOR: {
      const ty = varDeclTy(h);
      leftEnd = ty >= 0 ? typeEnd(ty) : patEnd(varDeclPat(h));
      if (rightStartOfExpression < 0) return false;
      rightStart = rightStartOfExpression;
      operator = 61;
      break;
    }
    case ASSIGNMENT_LIKE_ASSIGNMENT_EXPRESSION: {
      const left = exprLeft(h);
      if (left < 0 || rightStartOfExpression < 0) return false;
      leftEnd = exprEnd(left);
      rightStart = rightStartOfExpression;
      operator = 61;
      break;
    }
    case ASSIGNMENT_LIKE_OBJECT_PROPERTY: {
      const owner = nodeOfProp(h);
      if (keyKind(owner) < 0 || rightStartOfExpression < 0) return false;
      keySpan(owner);
      leftEnd = SP[1] | 0;
      rightStart = rightStartOfExpression;
      operator = 58;
      break;
    }
    case ASSIGNMENT_LIKE_BINDING_PROPERTY: {
      const owner = nodeOfPatProp(h);
      if (keyKind(owner) < 0) return false;
      keySpan(owner);
      leftEnd = SP[1] | 0;
      rightStart = patStart(patPropValue(h));
      operator = 58;
      break;
    }
    default: {
      const owner = nodeOfMember(h);
      const ty = memberTy(h);
      if (ty >= 0) leftEnd = typeEnd(ty);
      else if (keyKind(owner) >= 0) {
        keySpan(owner);
        leftEnd = SP[1] | 0;
      } else return false;
      if (rightStartOfExpression < 0) return false;
      rightStart = rightStartOfExpression;
      operator = 61;
      break;
    }
  }
  const cm = cxOf(f).comments;
  if (!cm.hasAnyCommentIn(leftEnd, rightStart)) return false;
  SIDES[0] = leftEnd;
  SIDES[1] = rightStart;
  SIDES[2] = cm.positionAfterCharacter(leftEnd, operator);
  return true;
}

/** `rightExpression`: `getRightExpression`. */
function writeAfterOperator(kind: number, h: number, rightExpression: number, layout: number, f: Formatter): void {
  switch (layout) {
    case ASSIGNMENT_LIKE_LAYOUT_FLUID: {
      const groupId = f.groupId();
      f.indentedLineGroup(groupId);
      f.lineSuffixBoundary();
      f.startIndentIfGroupBreaks(groupId);
      writeRight(kind, h, rightExpression, f, layout, groupId);
      f.endIndentIfGroupBreaks(groupId);
      return;
    }
    case ASSIGNMENT_LIKE_LAYOUT_BREAK_AFTER_OPERATOR:
      f.startGroup();
      f.startSoftLineIndentOrSpace();
      writeRight(kind, h, rightExpression, f, layout, 0);
      f.endSoftLineIndentOrSpace();
      f.endGroup();
      return;
    case ASSIGNMENT_LIKE_LAYOUT_NEVER_BREAK_AFTER_OPERATOR:
      f.space();
      writeRight(kind, h, rightExpression, f, layout, 0);
      return;
    // The chain starts with a line break.
    case ASSIGNMENT_LIKE_LAYOUT_CHAIN_TAIL_ARROW_FUNCTION:
      writeRight(kind, h, rightExpression, f, layout, 0);
      return;
    case ASSIGNMENT_LIKE_LAYOUT_BREAK_LEFT_HAND_SIDE:
      f.space();
      f.startGroup();
      writeRight(kind, h, rightExpression, f, layout, 0);
      f.endGroup();
      return;
    case ASSIGNMENT_LIKE_LAYOUT_CHAIN:
      f.softLineBreakOrSpace();
      writeRight(kind, h, rightExpression, f, layout, 0);
      return;
    default:
      f.startSoftLineIndentOrSpace();
      writeRight(kind, h, rightExpression, f, layout, 0);
      f.endSoftLineIndentOrSpace();
      return;
  }
}

/** `with_assignment_layout(expression, layout)`: `expression`, which is told about the layout if it is an arrow function. `layout`: -1 for none. */
export function fmtExprWithAssignmentLayout(expression: number, layout: number, f: Formatter): void {
  fmtExprWithOptions(expression, exprArrowFunction(expression) >= 0 ? exprOptionsArrow(layout, -1, 0) : EO_NONE, f);
}

/**
 * Prettier's `isPoorlyBreakableMemberOrCallChain`: a chain that starts with a name or `this`, and has no calls, or only calls with no
 * argument or one short argument.
 */
function isPoorlyBreakableMemberOrCallChain(expression: number, f: Formatter): boolean {
  switch (exprTag(expression)) {
    case EXPR_CALL:
    case EXPR_DOT:
    case EXPR_INDEX:
    case EXPR_NON_NULL:
      break;
    default:
      return false;
  }
  const threshold = (f.options.lineWidth / 4) >>> 0;
  let isChain = false;
  const callExpressions$ = callExpressions;
  const base = callExpressions$.len;
  let current = expression;
  let ok = true;
  for (;;) {
    let next = -1;
    let stop = false;
    switch (exprTag(current)) {
      case EXPR_NON_NULL:
        next = exprOperand(current);
        break;
      case EXPR_CALL: {
        // One call that can break is all it takes, and most can.
        const call = exprAsCall(current);
        if (call >= 0) {
          const n = callArgsLen(call);
          if (n === 1) {
            const only = listAt(callArgsStart(call), 0);
            if (!(exprTag(only) !== EXPR_SPREAD && isShortArgument(only, threshold, f))) ok = false;
          } else if (n !== 0) {
            ok = false;
          }
        }
        if (!ok) break;
        isChain = true;
        callExpressions$.push(current);
        next = exprCallee(current);
        break;
      }
      case EXPR_DOT:
      case EXPR_INDEX:
        isChain = true;
        next = exprObject(current);
        break;
      case EXPR_IDENT:
      case EXPR_THIS:
        stop = true;
        break;
      default:
        break;
    }
    if (stop) break;
    if (!ok || next < 0) {
      ok = false;
      break;
    }
    current = next;
  }
  const count = (callExpressions$.len - base) | 0;
  let result = false;
  if (ok && isChain) {
    result = chainHasNoMemberChain(base, count, f);
  }
  callExpressions$.len = base;
  return result;
}

/** The last part of `isPoorlyBreakableMemberOrCallChain`: the calls are `callExpressions[base .. base + count)`. */
function chainHasNoMemberChain(base: number, count: number, f: Formatter): boolean {
  if (count === 0) return true;
  const cx = cxOf(f);
  const cm = cx.comments;
  const isOxfmt = f.options.flavor === FLAVOR_OXFMT;
  const callExpressions$ = callExpressions;
  const firstCall = callExpressions$.data[base] | 0;
  if (isOxfmt && cm.hasCommentInRange(exprStart(firstCall), exprEnd(firstCall))) return false;
  for (let i = 0; i < count; i++) {
    const callExpression = callExpressions$.data[base + i] | 0;
    const call = exprAsCallLike(callExpression);
    if (call < 0) continue;
    const hasCommentAroundArgument =
      callArgsLen(call) > 0 && cm.hasCommentInRange(exprEnd(callCallee(call)), exprEnd(callExpression));
    if (hasCommentAroundArgument || isComplexTypeArguments(callExpression, callTypeArgsStart(call), callTypeArgsLen(call), f)) return false;
  }
  // Prettier's `printCallExpression`: only the call of a member can be a member chain. It is asked of every call: in `a.b().c()()` of the
  // second from the right.
  const asked = isOxfmt ? 1 : count;
  for (let i = 0; i < asked; i++) {
    const callExpression = callExpressions$.data[base + i] | 0;
    const callee = exprCallee(callExpression);
    if (callee < 0) continue;
    const t = anTag(exprAsAstNodes(callee));
    const isMemberCallee =
      t === AN_STATIC_MEMBER_EXPRESSION ||
      t === AN_COMPUTED_MEMBER_EXPRESSION ||
      t === AN_PRIVATE_FIELD_EXPRESSION ||
      (t === AN_CALL_EXPRESSION && isOxfmt);
    if (isMemberCallee && isMemberCallChain(callExpression, f)) return false;
  }
  return true;
}

/** Prettier's `isShortCallArgument`/`isLoneShortArgument`. */
export function isShortArgument(argument0: number, threshold: number, f: Formatter): boolean {
  let argument = argument0;
  let node = exprAsAstNodes(argument);
  while (anTag(node) === AN_UNARY_EXPRESSION) {
    const operand = exprArgument(argument);
    if (operand < 0) return false;
    argument = operand;
    node = exprAsAstNodes(argument);
  }
  // Prettier asks for the `length` of a string of JavaScript, oxfmt for that of one of Rust.
  const isOxfmt = f.options.flavor === FLAVOR_OXFMT;
  const text = hir.text;
  const nt = anTag(node);
  switch (nt) {
    case AN_IDENTIFIER_REFERENCE:
      return textLength(text, exprStart(argument), exprEnd(argument), isOxfmt) <= threshold;
    case AN_REG_EXP_LITERAL:
      exprRegexPatternSpan(argument);
      return textLength(text, SP[0] | 0, SP[1] | 0, isOxfmt) <= threshold;
    case AN_STRING_LITERAL:
      return stringLiteralLength(argument, isOxfmt, f) <= threshold;
    case AN_TEMPLATE_LITERAL: {
      if (exprTag(argument) !== EXPR_TEMPLATE || exprTemplateQuasiCount(argument) !== 1) return false;
      exprTemplateRawSpan(argument, 0);
      const a = SP[0] | 0;
      const b = SP[1] | 0;
      if (textLength(text, a, b, isOxfmt) > threshold) return false;
      for (let i = a; i < b; i++) {
        const c = text[i] | 0;
        if (c === 10 || c === 13) return false;
      }
      return true;
    }
    case AN_CALL_EXPRESSION: {
      const call = exprAsCallLike(argument);
      if (call < 0 || callArgsLen(call) !== 0) return false;
      const callee = callCallee(call);
      if (exprTag(callee) !== EXPR_IDENT) return false;
      return textLength(text, exprStart(callee), exprEnd(callee), isOxfmt) <= (threshold > 2 ? (threshold - 2) | 0 : 0);
    }
    case AN_THIS_EXPRESSION:
    case AN_NULL_LITERAL:
    case AN_BIG_INT_LITERAL:
    case AN_BOOLEAN_LITERAL:
    case AN_NUMERIC_LITERAL:
      return true;
    default:
      return false;
  }
}

/** The `length` of `text[start, end)` as JavaScript counts it (UTF-16 units), or as Rust (bytes) for oxfmt. */
function textLength(text: Uint8Array, start: number, end: number, isOxfmt: boolean): number {
  return isOxfmt ? (end - start) | 0 : utf16Len(text, start, end);
}

/** The length of what is written for the string literal `e`: the quotes of the options and the escapes they need. */
function stringLiteralLength(e: number, isOxfmt: boolean, f: Formatter): number {
  const text = hir.text;
  const start = exprStart(e);
  const end = exprEnd(e);
  // Most strings: nothing in them that a quote could change.
  let plain = true;
  for (let i = (start + 1) | 0; i < end - 1; i++) {
    const c = text[i] | 0;
    if (c === 92 || c === 34 || c === 39 || c === 13) {
      plain = false;
      break;
    }
  }
  if (plain) return isOxfmt ? f.stringWidth(text, start, end) : utf16Len(text, start, end);
  const slot = f.startCapture();
  fmtLiteralStringToken(start, end, false, STRING_LITERAL_PARENT_KIND_EXPRESSION, f);
  const handle = f.endCapture(slot);
  let length = 0;
  if (handle >= 0) {
    const st = f.st;
    const i = f.capturedStart(handle);
    const t = st.tag[i] | 0;
    const a = st.a[i] | 0;
    const b = st.b[i] | 0;
    if (t === E_OWNED_TEXT) length = isOxfmt ? f.stringWidth(st.text.data, a, (a + b) | 0) : utf16Len(st.text.data, a, (a + b) | 0);
    else if (t === E_SOURCE_TEXT) length = isOxfmt ? f.stringWidth(f.source, a, (a + b) | 0) : utf16Len(f.source, a, (a + b) | 0);
    else length = (end - start) | 0;
  }
  return length;
}

/** Prettier's `isComplexTypeArguments`, for the type arguments of the call `owner`. */
function isComplexTypeArguments(owner: number, paramsStart: number, paramsLen: number, f: Formatter): boolean {
  if (!typeListAngleBrackets(paramsStart, paramsLen)) return false;
  const spanStart = SP[0] | 0;
  if (paramsLen > 1) return true;
  const first = listAt(paramsStart, 0);
  const t = typeTag(first);
  if (t === TYPE_UNION || t === TYPE_INTERSECTION || t === TYPE_OBJECT) return true;
  // `f.speculate_will_break(&WithSpan(type_arguments(params, Node::Expr(owner)), span))`
  const cm = cxOf(f).comments;
  const printed = cm.snapshotPrinted();
  const limit = cm.snapshotLimit();
  cm.skipCommentsBefore(spanStart);
  const slot = f.startCapture();
  typeArguments(paramsStart, paramsLen, nodeOfExpr(owner), f);
  const handle = f.endCapture(slot);
  const willBreak = handle >= 0 && f.willBreak(handle);
  cm.restore(printed, limit);
  return willBreak;
}

/** Prettier's `isComplexTypeAnnotation`: `A<B<C>, D>`. */
export function isComplexTypeAnnotation(ty: number): boolean {
  if (typeTag(ty) !== TYPE_REF) return false;
  const n = typeRefArgsLen(ty);
  if (n <= 1) return false;
  const s = typeRefArgsStart(ty);
  for (let i = 0; i < n; i++) {
    const arg = listAt(s, i);
    const t = typeTag(arg);
    if (t === TYPE_COND) return true;
    if (t === TYPE_REF && typeRefArgsLen(arg) > 0) return true;
  }
  return false;
}
