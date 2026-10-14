// Port of vendor/bun/src/format/js/print/flow.rs: what only Flow has. Prettier's `print/flow.js`, and what the printers that it shares with TypeScript
// do for the nodes of Flow.
//
// The tree has the nodes of TypeScript (`sema/parser/parser/flow.ts` has the table), so most of a file of Flow is written by the functions for those.
// They call these where `fileIsFlow()`. (`goes_to_babel`, `may_have_comment_types` and `uncommented` of flow.rs are in `sema/parser/script.ts`.)
import { Formatter } from "../../ir/formatter.ts";
import { COMMA, ELLIPSIS, LBRACE, LBRACKET, LPAREN, RBRACE, RBRACKET, RPAREN, QUESTION, DOT } from "../../ir/tokens.ts";
import { token } from "../../ir/element.ts";
import { ARROW_PARENS_AS_NEEDED, EXPAND_AUTO, QUOTE_PROPS_CONSISTENT, TRAILING_SEPARATOR_DISALLOWED } from "../../options.ts";
import { I32Vec } from "../../../sema/vec.ts";
import {
  BIN_AND,
  BIN_BIT_OR,
  EXPR_ARRAY,
  EXPR_BINARY,
  EXPR_BIG_INT,
  EXPR_DOT,
  EXPR_FALSE,
  EXPR_FN,
  EXPR_IDENT,
  EXPR_NEW,
  EXPR_NULL,
  EXPR_NUMBER,
  EXPR_OBJECT,
  EXPR_SPREAD,
  EXPR_STRING,
  EXPR_TRUE,
  EXPR_UNARY,
  EXPR_AS,
  FLAG_AMBIENT,
  FLAG_IN,
  FLAG_OPTIONAL,
  FLAG_OUT,
  FN_FUNCTION_TYPE,
  KEY_IDENT,
  KEY_NONE,
  KEY_STRING,
  KEY_COMPUTED,
  MEMBER_CALL_SIGNATURE,
  MEMBER_INDEX_SIGNATURE,
  MEMBER_PROPERTY,
  MM_ADD,
  MM_REMOVE,
  N_EXPR,
  N_FUNC,
  N_MEMBER,
  N_PARAM,
  N_STMT,
  N_TYPE,
  N_TYPE_PARAM,
  N_VAR_DECL,
  PAT_MISSING,
  PROP_SPREAD,
  SP,
  STMT_TYPE_ALIAS,
  TYPE_ARRAY,
  TYPE_COND,
  TYPE_FN,
  TYPE_INDEXED_ACCESS,
  TYPE_INFER,
  TYPE_INTERSECTION,
  TYPE_JSDOC,
  TYPE_KEYOF,
  TYPE_MAPPED,
  TYPE_OBJECT,
  TYPE_PREDICATE,
  TYPE_REF,
  TYPE_TYPEOF,
  TYPE_UNION,
  TYPE_UNIQUE,
  UN_VOID,
  callArgsLen,
  callArgsStart,
  callCallee,
  callTypeArgsLen,
  callTypeArgsStart,
  caseBodyLen,
  caseBodyStart,
  caseSpan,
  caseTest,
  classBodySpan,
  classExtends,
  classExtendsArgsLen,
  classExtendsArgsStart,
  classFlags,
  classFlowMixinsLen,
  classFlowMixinsStart,
  classImplementsLen,
  classImplementsStart,
  className,
  classMembersLen,
  classMembersStart,
  classModifiersLen,
  classModifiersStart,
  classNamePos,
  classOwner,
  classSpan,
  classTypeParamsLen,
  classTypeParamsStart,
  enumFlowExplicitType,
  exprAsCall,
  exprAsExpr,
  exprAsTy,
  exprBinaryLeft,
  exprBinaryOp,
  exprBinaryRight,
  exprDotName,
  exprDotNamePos,
  exprDotObj,
  exprEnd,
  exprIsBeforeFlowTypeArguments,
  exprIsFlowTypeCast,
  exprNewCall,
  exprObjectPropsLen,
  exprObjectPropsStart,
  exprArrayElemsLen,
  exprArrayElemsStart,
  exprSpan,
  exprSpreadExpr,
  exprStart,
  exprTag,
  exprUnaryOpOf,
  exprUnaryOperand,
  fileEndOfTokenBefore,
  fileIsFlow,
  funcHasBody,
  funcIsArrow,
  funcIsAsync,
  funcKind,
  funcName,
  funcNamePos,
  funcOpenParen,
  funcOwner,
  funcParamsLen,
  funcParamsStart,
  funcReturnType,
  funcThisParam,
  funcTypeParamsLen,
  funcTypeParamsStart,
  hir,
  interfaceExtendsLen,
  interfaceExtendsStart,
  interfaceFlowOpaqueType,
  interfaceName,
  interfaceNamePos,
  interfaceTypeParamsLen,
  interfaceTypeParamsStart,
  keyExpr,
  keyKind,
  keyName,
  keySpan,
  listAt,
  mappedIsOptionalWithPlus,
  mappedOptional,
  mappedParam,
  mappedTy,
  memberFlags,
  memberFlowInternalSlot,
  memberFunc,
  memberInit,
  memberIsFlowSpread,
  memberIsStatic,
  memberKind,
  memberModifiersLen,
  memberModifiersStart,
  memberNamePos,
  memberSpan,
  memberTy,
  modifierDecorator,
  modifierFlagOf,
  modifierTokenSpan,
  nameBuf,
  nameIs,
  nameLen,
  nameStart,
  nodeChildren,
  nodeId,
  nodeKind,
  nodeOfClass,
  nodeOfFunc,
  nodeOfMember,
  nodeOfProp,
  nodeOfStmt,
  nodeOfType,
  paramFlowOuterName,
  paramFuncOf,
  paramIsOptional,
  paramIsRest,
  paramModifiersLen,
  paramModifiersStart,
  paramPat,
  paramTy,
  patTag,
  propKind,
  propSpan,
  propValue,
  skipTrivia,
  spTokenIs,
  stmtIsDefaultExport,
  stmtModifiersLen,
  stmtModifiersStart,
  stmtSemicolon,
  stmtSpan,
  stmtTag,
  tupleElemFlowType,
  tupleElemFlowVarianceAndLabel,
  tupleElemIsOptional,
  tupleElemIsRest,
  typeAnnotationSpan,
  typeArrayElem,
  typeCondCheck,
  typeCondExtends,
  typeEnd,
  typeFirstToken,
  typeFlowNullableOperand,
  typeFlowTypeOperatorOperand,
  typeFnFn,
  typeHasFlowOptionalToken,
  typeIndexedAccessIndex,
  typeIndexedAccessObj,
  typeInferParam,
  typeIsFlowExactObject,
  typeIsParenthesized,
  typeOuterStart,
  typeParamConstraint,
  typeParamFlowTokenAfterName,
  typeParamModifiersLen,
  typeParamModifiersStart,
  typeParamName,
  typeParamNamePos,
  typeParent,
  typePredicateParamAtom,
  typePredicateTy,
  typeRefArgsLen,
  typeRefNameLen,
  typeSpan,
  typeStart,
  typeTag,
  aliasName,
  aliasTy,
  enumNamePos,
  patBindings,
  FLOW,
  FLOW_LABEL_ATOM,
  FLOW_LABEL_POS,
} from "../../../lint/ast/index.ts";
import {
  AN_CLASS,
  AN_EXPORT_DEFAULT_DECLARATION,
  AN_EXPORT_NAMED_DECLARATION,
  AN_FUNCTION,
  AN_OBJECT_EXPRESSION,
  AN_OBJECT_PROPERTY,
  AN_PROGRAM,
  AN_SWITCH_STATEMENT,
  AN_TS_INTERFACE_DECLARATION,
  AN_TS_NAMED_TUPLE_MEMBER,
  AN_TS_TYPE_PARAMETER,
  AN_TS_TYPE_PARAMETER_DECLARATION_CLASS,
  AN_TS_TYPE_PARAMETER_DECLARATION_FUNC,
  AN_TS_TYPE_PARAMETER_DECLARATION_STMT,
  AN_TS_TYPE_PARAMETER_DECLARATION_TYPE,
  anId,
  anParent,
  anTag,
  exprAstParent,
  memberAsAstNodes,
  mkAn,
  paramAsAstNodes,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import { JOIN_HARDLINE, joinNodesSeparator, writeSeparatorAfter } from "../builders.ts";
import {
  EO_NONE,
  PK_NODE,
  PK_PARENT,
  enterScope,
  fmtExpr,
  fmtMember,
  fmtParam,
  fmtPat,
  fmtType,
  fmtTypeAnnotation,
  identifier,
  leaveScope,
  writeExpression,
  writeTrailingCommentsIn,
} from "../format.ts";
import { fmtFormalParameters } from "./parameters.ts";
import { fmtFunctionBody } from "./function.ts";
import { optionalSemicolon } from "./semicolon.ts";
import { fmtClassImplements } from "./class.ts";
import { writeTsCallSignatureDeclaration, writeTsMethodSignature } from "./function_type.ts";
import { commentsAfterPropertyName, writeTsInterfaceSignatures, writeTsSignatures } from "./ts_types.ts";
import { typeArguments, typeParameters } from "./type_parameters.ts";
import { objectLikeTsTypeLiteralShouldHug } from "./object_like.ts";
import { formatComputedOrPropertyKey, keyRequiresQuotes } from "../utils/object.ts";
import { isSimpleType } from "../utils/typescript.ts";
import { DANGLING_BLOCK, DANGLING_NONE, DANGLING_SOFT, formatDanglingComments, formatLeadingComments, formatLeadingCommentsRange, formatTrailingCommentsRange } from "../trivia.ts";
import { writeSuppressedNode } from "../utils/suppressed.ts";
import { goesToBabel as parserGoesToBabel } from "../../../sema/parser/script.ts";
import { filepathOf } from "../state.ts";
import { fmtStringLiteral } from "./import_declaration.ts";
import { FormatOptions } from "../../options.ts";

// ───────────────────────────── tokens ─────────────────────────────

const T_AS = token(" as ");
const T_COLON_SPACE = token(": ");
const T_LBRACE_PIPE = token("{|");
const T_RBRACE_PIPE = token("|}");
const T_INTERFACE = token("interface");
const T_EXTENDS_SPACES = token(" extends ");
const T_EXTENDS = token("extends");
const T_HOOK_SPACE = token("hook ");
const T_COMPONENT = token("component");
const T_COMPONENT_SPACE = token("component ");
const T_HOOK = token("hook");
const T_FUNCTION = token("function");
const T_CLASS = token("class");
const T_RECORD = token("record");
const T_MIXINS = token("mixins");
const T_IMPLEMENTS = token("implements");
const T_DECLARE_SPACE = token("declare ");
const T_ASYNC_SPACE = token("async ");
const T_STATIC_SPACE = token("static ");
const T_OPAQUE_TYPE = token("opaque type ");
const T_DOUBLE_LBRACKET = token("[[");
const T_DOUBLE_RBRACKET = token("]]");
const T_RBRACKET_COLON = token("]: ");
const T_IN = token(" in ");
const T_OPT_PLUS = token("+?");
const T_OPT_MINUS = token("-?");
const T_MODULE_EXPORTS = token("declare module.exports");
const T_PERCENT_CHECKS = token("%checks");
const T_PERCENT_CHECKS_OPEN = token("%checks(");
const T_PERCENT_CHECKS_OPEN_SP = token(" %checks(");
const T_EQ_SPACES = token(" = ");
const T_OF_SPACE = token("of ");
const T_RENDERS = token("renders");
const T_RENDERS_QUESTION = token("renders?");
const T_RENDERS_STAR = token("renders*");
const T_ARROW_SPACES = token(" => ");
const T_ARROW_EMPTY = token(" => {}");
const T_ARROW = token(" =>");
const T_MATCH_OPEN = token("match (");
const T_MATCH_BRACE = token(" {");
const T_IF_OPEN = token("if (");
const T_PIPE_SPACE = token("| ");
const T_PIPE_SPACES = token(" | ");
const T_CONST = token("const ");
const T_LET = token("let ");
const T_VAR = token("var ");
const T_EMPTY_ANGLE = token("<>");
const T_EXTENDS_KW = token("extends ");
const T_SUPER_KW = token("super ");
const T_EMPTY_BRACKETS = token("[]");
const T_QUESTION_DOT = token("?.");
const T_COLON = token(":");
const T_DASH = token("-");

// ───────────────────────────── modifiers ─────────────────────────────

/** `static`, `proto`, `readonly`, `+`: as they are written, in the order of the source. */
function writeModifiers(modsStart: number, modsLen: number, f: Formatter): void {
  const SP$ = SP;
  for (let i = 0; i < modsLen; i++) {
    modifierTokenSpan(listAt(modsStart, i));
    const s = SP$.s0 | 0;
    const e = SP$.s1 | 0;
    f.sourceText(s, e);
    if (e - s > 1) f.space();
  }
}

/** The `+` or `-` of a property of a class. */
export function writeVarianceSign(modifiersStart: number, modifiersLen: number, f: Formatter): void {
  const SP$ = SP;
  for (let i = 0; i < modifiersLen; i++) {
    const m = listAt(modifiersStart, i);
    if ((modifierFlagOf(m) & (FLAG_IN | FLAG_OUT)) !== 0) {
      modifierTokenSpan(m);
      f.sourceText(SP$.s0 | 0, SP$.s1 | 0);
    }
  }
}

function tokenSpanIs(m: number, word: string): boolean {
  modifierTokenSpan(m);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const e = SP$.s1 | 0;
  if (e - s !== word.length) return false;
  const hir$ = hir;
  for (let i = 0; i < word.length; i++) if ((hir$.text[s + i] | 0) !== word.charCodeAt(i)) return false;
  return true;
}

/** Whether the word `word`, which TypeScript has no flag for, is among the modifiers. */
function hasWordIn(modsStart: number, modsLen: number, word: string): boolean {
  for (let i = 0; i < modsLen; i++) {
    const m = listAt(modsStart, i);
    if (modifierDecorator(m) < 0 && modifierFlagOf(m) === 0 && tokenSpanIs(m, word)) return true;
  }
  return false;
}

function stmtHasWord(statement: number, word: string): boolean {
  return hasWordIn(stmtModifiersStart(statement), stmtModifiersLen(statement), word);
}

function isDeclared(modsStart: number, modsLen: number): boolean {
  for (let i = 0; i < modsLen; i++) if (modifierFlagOf(listAt(modsStart, i)) === FLAG_AMBIENT) return true;
  return false;
}

/** `declare export`: the `declare` has no flag, so that what is exported is written without it. */
export function isDeclareExport(statement: number, f: Formatter): boolean {
  void f;
  return stmtHasWord(statement, "declare");
}

/** The same, for a statement of any file. */
export function isFlowDeclareExport(statement: number): boolean {
  return fileIsFlow() && stmtHasWord(statement, "declare");
}

/** What Prettier's `isJsSourceElement` leaves out: the type parameters of Flow, and what is in `declare export`. `node`: an `AstNodes`. */
export function isNoSourceElement(node: number): boolean {
  switch (anTag(node)) {
    case AN_TS_TYPE_PARAMETER_DECLARATION_FUNC:
    case AN_TS_TYPE_PARAMETER_DECLARATION_CLASS:
    case AN_TS_TYPE_PARAMETER_DECLARATION_STMT:
    case AN_TS_TYPE_PARAMETER_DECLARATION_TYPE:
      return fileIsFlow();
    case AN_EXPORT_NAMED_DECLARATION:
    case AN_EXPORT_DEFAULT_DECLARATION:
    case AN_PROGRAM:
      return false;
    default: {
      if (!fileIsFlow()) return false;
      const parent = anParent(node);
      const t = anTag(parent);
      return (t === AN_EXPORT_NAMED_DECLARATION || t === AN_EXPORT_DEFAULT_DECLARATION) && isFlowDeclareExport(anId(parent));
    }
  }
}

// ───────────────────────────── expressions ─────────────────────────────

/** `(e: T)` */
export function writeTypeCastExpression(e: number, f: Formatter): void {
  if (exprTag(e) === EXPR_AS) {
    f.token(LPAREN);
    fmtExpr(exprAsExpr(e), f);
    fmtTypeAnnotation(exprAsTy(e), f);
    f.token(RPAREN);
  }
}

// ───────────────────────────── parentheses ─────────────────────────────

/** `interface { }` as a type, which is an intersection in the tree. */
export function isInterfaceType(ty: number): boolean {
  if (typeTag(ty) !== TYPE_INTERSECTION) return false;
  typeFirstToken(ty);
  return spTokenIs("interface");
}

/** `hook` or `component`, if the function type `ty` starts with the word: 1: hook, 2: component, 0: none. */
function keywordOfFunctionType(ty: number, func: number): number {
  // In `hook => void` it is the type of the parameter.
  typeSpan(ty);
  if (funcOpenParen(func) === (SP.s0 | 0)) return 0;
  typeFirstToken(ty);
  if (spTokenIs("hook")) return 1;
  if (spTokenIs("component")) return 2;
  return 0;
}

/** Whether `ty` is an `OptionalIndexedAccessType`: `A?.[B]`, or the `A?.[B][C]` around it. */
function isOptionalIndexedAccess(ty0: number): boolean {
  let ty = ty0;
  while (typeTag(ty) === TYPE_INDEXED_ACCESS) {
    const obj = typeIndexedAccessObj(ty);
    if (typeHasFlowOptionalToken(ty, obj)) return true;
    if (typeIsParenthesized(obj)) return false;
    ty = obj;
  }
  return false;
}

/** A parameter of a function type, of a signature or of a function that is declared: Flow's `FunctionTypeParam`, as opposed to a pattern with a type annotation. */
function isFunctionTypeParam(param: number): boolean {
  const func = paramFuncOf(param);
  return func >= 0 && !funcHasBody(func) && !funcIsArrow(func);
}

const stackNodes = new I32Vec(32);
const stackFlags = new I32Vec(32);
const childScratch = new I32Vec(32);

/** Prettier's `includesFunctionTypeInObjectType`. `isInObjectType`: `node` is. */
function includesFunctionTypeInObjectType(node: number, isInObjectType: boolean): boolean {
  // What is in it and has not been looked at.
  const stackNodes$ = stackNodes;
  const baseN = stackNodes$.len;
  stackNodes$.push(node);
  const stackFlags$ = stackFlags;
  stackFlags$.push(isInObjectType ? 1 : 0);
  let result = false;
  const childScratch$ = childScratch;
  while (stackNodes$.len > baseN) {
    const n = stackNodes$.pop();
    const inObject = stackFlags$.pop() !== 0;
    let isFunctionType = false;
    let isObjectType = false;
    let operand = -1;
    const kind = nodeKind(n);
    if (kind === N_TYPE) {
      const t = nodeId(n);
      isFunctionType = typeTag(t) === TYPE_FN;
      isObjectType = typeTag(t) === TYPE_OBJECT;
      operand = typeFlowNullableOperand(t);
    } else if (kind === N_FUNC) isFunctionType = true;
    if (isFunctionType && inObject) {
      result = true;
      break;
    }
    const now = inObject || isObjectType;
    if (operand >= 0) {
      stackNodes$.push(nodeOfType(operand));
      stackFlags$.push(now ? 1 : 0);
    } else {
      const base = childScratch$.len;
      nodeChildren(n, -1, childScratch$);
      for (let i = base; i < childScratch$.len; i++) {
        stackNodes$.push(childScratch$.data[i] | 0);
        stackFlags$.push(now ? 1 : 0);
      }
      childScratch$.len = base;
    }
  }
  stackNodes$.len = baseN;
  stackFlags$.len = baseN;
  return result;
}

/** Prettier's `needsParentheses` for the types of Flow. */
export function needsParentheses(ty: number): boolean {
  const p = typeParent(ty);
  let parent = -1;
  if (nodeKind(p) === N_TYPE) parent = nodeId(p);
  else if (nodeKind(p) === N_FUNC) {
    // The `=>` of a function type in an object type would be taken for that of the arrow function.
    const owner = nodeId(p);
    if (funcIsArrow(owner) && funcReturnType(owner) === ty) {
      const operand = typeFlowNullableOperand(ty);
      if (!(operand >= 0 && needsParentheses(operand)) && includesFunctionTypeInObjectType(nodeOfType(ty), false)) return true;
    }
  }
  const parentTag = parent >= 0 ? typeTag(parent) : -1;
  const isObjectType = parent >= 0 && typeTag(parent) === TYPE_INDEXED_ACCESS && typeIndexedAccessObj(parent) === ty;
  switch (typeTag(ty)) {
    case TYPE_UNIQUE:
      return isObjectType || parentTag === TYPE_ARRAY || parentTag === TYPE_JSDOC || parentTag === TYPE_UNIQUE;
    case TYPE_TYPEOF:
    case TYPE_KEYOF:
      return isObjectType || parentTag === TYPE_ARRAY;
    case TYPE_ARRAY:
      return parentTag === TYPE_JSDOC;
    case TYPE_INTERSECTION:
      if (isInterfaceType(ty)) return false;
      return isObjectType || isUnionLikeParent(parentTag);
    case TYPE_UNION:
      return isObjectType || isUnionLikeParent(parentTag);
    case TYPE_INFER:
    case TYPE_JSDOC:
      return isObjectType || parentTag === TYPE_ARRAY;
    case TYPE_COND: {
      const pn = typeParent(ty);
      if (nodeKind(pn) === N_TYPE) {
        const pt = nodeId(pn);
        const tag = typeTag(pt);
        if (tag === TYPE_COND) return typeCondCheck(pt) === ty || typeCondExtends(pt) === ty;
        return tag === TYPE_UNION || tag === TYPE_INTERSECTION;
      }
      if (nodeKind(pn) === N_TYPE_PARAM) {
        const param = nodeId(pn);
        if (typeParamConstraint(param) !== ty) return false;
        typeParamFlowTokenAfterName(param);
        return spTokenIs("extends");
      }
      return false;
    }
    case TYPE_FN:
      return functionTypeNeedsParentheses(ty, typeFnFn(ty));
    // `(A?.[B])[C]`
    case TYPE_INDEXED_ACCESS:
      return isObjectType && typeIsParenthesized(ty) && isOptionalIndexedAccess(ty) && !(parent >= 0 && typeHasFlowOptionalToken(parent, ty));
    default:
      return false;
  }
}

function isUnionLikeParent(tag: number): boolean {
  return tag === TYPE_UNIQUE || tag === TYPE_KEYOF || tag === TYPE_ARRAY || tag === TYPE_JSDOC || tag === TYPE_INTERSECTION || tag === TYPE_UNION;
}

function isReturnTypeOfArrow(it: number): boolean {
  const p = typeParent(it);
  if (nodeKind(p) !== N_FUNC) return false;
  const owner = nodeId(p);
  return funcIsArrow(owner) && funcReturnType(owner) === it;
}

function functionTypeNeedsParentheses(ty: number, func: number): boolean {
  const keyword = keywordOfFunctionType(ty, func);
  if (keyword === 1) return false;
  if (keyword !== 0 && funcReturnType(func) < 0) return false;
  if (isReturnTypeOfArrow(ty)) return true;
  const parent = typeParent(ty);
  let ancestor = parent;
  if (nodeKind(parent) === N_TYPE) {
    const pt = nodeId(parent);
    const ptag = typeTag(pt);
    // The inner `=>` would be taken for that of the arrow function.
    if ((ptag === TYPE_JSDOC || ptag === TYPE_PREDICATE) && isReturnTypeOfArrow(pt)) return true;
    if (ptag === TYPE_INDEXED_ACCESS && typeIndexedAccessObj(pt) === ty) return true;
    if (ptag === TYPE_COND && typeCondCheck(pt) === ty) return true;
    if (ptag === TYPE_COND && typeCondExtends(pt) === ty) {
      const ret = funcReturnType(func);
      return ret >= 0 && typeTag(ret) === TYPE_INFER && typeParamConstraint(typeInferParam(ret)) >= 0;
    }
    if (ptag === TYPE_JSDOC) ancestor = typeParent(pt);
  }
  if (nodeKind(ancestor) === N_TYPE && !isInterfaceType(nodeId(ancestor))) {
    const tag = typeTag(nodeId(ancestor));
    return tag === TYPE_UNION || tag === TYPE_INTERSECTION || tag === TYPE_ARRAY || tag === TYPE_JSDOC;
  }
  if (nodeKind(parent) === N_PARAM) {
    const param = nodeId(parent);
    if (patTag(paramPat(param)) === PAT_MISSING && isFunctionTypeParam(param)) {
      const thisParam = funcThisParam(func);
      if (thisParam >= 0 && paramTy(thisParam) >= 0 && typeTag(paramTy(thisParam)) === TYPE_JSDOC) return true;
      const n = funcParamsLen(func);
      const s = funcParamsStart(func);
      for (let i = 0; i < n; i++) {
        const t = paramTy(listAt(s, i));
        if (t >= 0 && typeTag(t) === TYPE_JSDOC) return true;
      }
    }
  }
  return false;
}

// ───────────────────────────── types ─────────────────────────────

/** `?T`, `renders T`. Returns whether `ty` is one of them. */
export function writeNullableTypeOrTypeOperator(ty: number, f: Formatter): boolean {
  const nullable = typeFlowNullableOperand(ty);
  if (nullable >= 0) {
    const p = needsParentheses(ty);
    if (p) f.token(LPAREN);
    f.token(QUESTION);
    fmtType(nullable, f);
    if (p) f.token(RPAREN);
    return true;
  }
  const operand = typeFlowTypeOperatorOperand(ty);
  if (operand < 0) return false;
  // `renders T`, `renders? T`, `renders* T`
  const c = (hir.text[typeStart(ty) + 7] | 0) as number;
  const operator = c === 63 ? T_RENDERS_QUESTION : c === 42 ? T_RENDERS_STAR : T_RENDERS;
  const p = needsParentheses(ty);
  if (p) f.token(LPAREN);
  f.token(operator);
  f.space();
  fmtType(operand, f);
  if (p) f.token(RPAREN);
  return true;
}

/** `T[]` */
export function writeArrayType(ty: number, element: number, f: Formatter): void {
  const p = needsParentheses(ty);
  if (p) f.token(LPAREN);
  fmtType(element, f);
  f.token(T_EMPTY_BRACKETS);
  if (p) f.token(RPAREN);
}

/** `T[K]`, `T?.[K]` */
export function writeIndexedAccessType(ty: number, obj: number, index: number, f: Formatter): void {
  const p = needsParentheses(ty);
  if (p) f.token(LPAREN);
  fmtType(obj, f);
  if (typeHasFlowOptionalToken(ty, obj)) f.token(T_QUESTION_DOT);
  f.token(LBRACKET);
  fmtType(index, f);
  f.token(RBRACKET);
  if (p) f.token(RPAREN);
}

/** `: T %checks` as a return type. Returns whether the predicate `ty` is that. */
export function writeChecksPredicate(ty: number, f: Formatter): boolean {
  if (typeTag(ty) !== TYPE_PREDICATE) return false;
  const param = typePredicateParamAtom(ty);
  if (param < 0 || !nameIs(param, "%checks")) return false;
  const inner = typePredicateTy(ty);
  if (inner >= 0) {
    fmtType(inner, f);
    f.space();
  }
  f.token(T_PERCENT_CHECKS);
  return true;
}

/** `implies`, if the predicate `ty` starts with it, in place of `asserts`. */
export function predicatePrefix(ty: number): string {
  typeFirstToken(ty);
  return spTokenIs("implies") ? "implies " : "asserts ";
}

/**
 * `: T %checks(e)` as a return type. Returns whether the type query `ty` is that. Of a function that is only declared, the `T` is written: the rest
 * is not part of the signature.
 */
export function writeDeclaredPredicate(ty: number, expr: number, argsStart: number, argsLen: number, f: Formatter): boolean {
  typeFirstToken(ty);
  if (spTokenIs("typeof")) return false;
  if (argsLen > 0) fmtType(listAt(argsStart, 0), f);
  const parent = typeParent(ty);
  const isOfDeclaredFunction = nodeKind(parent) === N_FUNC && !funcHasBody(nodeId(parent)) && nodeKind(funcOwner(nodeId(parent))) === N_STMT;
  if (!isOfDeclaredFunction) {
    if (argsLen > 0) f.space();
    f.token(T_PERCENT_CHECKS_OPEN);
    fmtExpr(expr, f);
    f.token(RPAREN);
  }
  return true;
}

/** `interface { }`, `interface extends A, B { }`. `parts`: `A`, `B` and the object type. */
export function writeInterfaceType(partsStart: number, partsLen: number, f: Formatter): void {
  const count = partsLen > 0 ? partsLen - 1 : 0;
  f.token(T_INTERFACE);
  if (count === 1) {
    f.token(T_EXTENDS_SPACES);
    writeInterfaceExtends(partsStart, count, f);
  } else if (count > 1) {
    f.startGroup();
    f.startIndent();
    f.softLineBreakOrSpace();
    f.token(T_EXTENDS);
    f.startGroup();
    f.startIndent();
    f.softLineBreakOrSpace();
    writeInterfaceExtends(partsStart, count, f);
    f.endIndent();
    f.endGroup();
    f.endIndent();
    f.endGroup();
  }
  f.space();
  if (partsLen > 0) fmtType(listAt(partsStart, partsLen - 1), f);
}

function writeInterfaceExtends(partsStart: number, count: number, f: Formatter): void {
  for (let i = 0; i < count; i++) {
    if (i > 0) f.softLineBreakOrSpace();
    fmtType(listAt(partsStart, i), f);
    writeSeparatorAfter(f, COMMA, i === count - 1, TRAILING_SEPARATOR_DISALLOWED, 0);
  }
}

/**
 * `hook (A) => B` starts with the word. `component(a: A) renders B` is written here: returns whether `ty` is one.
 */
export function writeFunctionTypeKeyword(ty: number, func: number, f: Formatter): boolean {
  const keyword = keywordOfFunctionType(ty, func);
  if (keyword === 1) {
    // Those between the word and the `(` lead the type.
    const cx = cxOf(f);
    if (!cx.isQuiet) {
      const open = funcOpenParen(func);
      if (open >= 0) {
        cx.comments.commentsBefore(open);
        formatLeadingCommentsRange(cx.comments.from, cx.comments.to, f);
      }
    }
    f.token(T_HOOK_SPACE);
    return false;
  }
  if (keyword === 2) {
    f.token(T_COMPONENT);
    typeParameters(funcTypeParamsStart(func), funcTypeParamsLen(func), nodeOfFunc(func), 0, false, f);
    writeComponentParametersAndRenders(func, f);
    return true;
  }
  return false;
}

function writeComponentParametersAndRenders(func: number, f: Formatter): void {
  const renders = funcReturnType(func);
  f.startGroup();
  fmtFormalParameters(func, f);
  if (renders >= 0) {
    f.space();
    fmtType(renders, f);
  }
  f.endGroup();
}

// ───────────────────────────── parameters ─────────────────────────────

export function isComponent(func: number, f: Formatter): boolean {
  void f;
  const owner = funcOwner(func);
  if (nodeKind(owner) === N_STMT) return stmtHasWord(nodeId(owner), "component");
  if (nodeKind(owner) === N_TYPE) return keywordOfFunctionType(nodeId(owner), func) === 2;
  return false;
}

/**
 * Writes a parameter without a name, which is a type, and returns true. Of any other parameter it writes what only Flow has before it: the `a as`
 * of a component.
 */
export function writeParameterStart(param: number, f: Formatter): boolean {
  const isUnnamed = patTag(paramPat(param)) === PAT_MISSING;
  const SP$ = SP;
  if (paramModifiersLen(param) === 0 && paramFlowOuterName(param)) {
    const s = SP$.s0 | 0;
    const e = SP$.s1 | 0;
    const func = paramFuncOf(param);
    if (func >= 0 && isComponent(func, f)) {
      const first = hir.text[s] | 0;
      if (first === 34 || first === 39) fmtStringLiteral(s, e, paramAsAstNodes(param), f);
      else f.sourceText(s, e);
      if (isUnnamed) {
        if (paramIsOptional(param)) f.token(QUESTION);
        f.token(T_COLON_SPACE);
      } else f.token(T_AS);
    }
  }
  if (isUnnamed) {
    if (paramIsRest(param)) f.token(ELLIPSIS);
    const ty = paramTy(param);
    if (ty >= 0) fmtType(ty, f);
    return true;
  }
  // `...a?: T`
  if (paramIsRest(param) && paramIsOptional(param)) {
    f.token(ELLIPSIS);
    fmtPat(paramPat(param), f);
    f.token(QUESTION);
    const ty = paramTy(param);
    if (ty >= 0) fmtTypeAnnotation(ty, f);
    return true;
  }
  return false;
}

/**
 * Prettier has no node between the last parameter of a function type and the type behind the `=>`: a comment before the `=>` trails the parameter.
 * Where the `=>` is, if `func` is such a type; else -1.
 */
export function arrowBehindParameters(func: number): number {
  if (!(fileIsFlow() && funcKind(func) === FN_FUNCTION_TYPE && funcParamsLen(func) > 0)) return -1;
  const owner = funcOwner(func);
  if (!(nodeKind(owner) === N_TYPE && keywordOfFunctionType(nodeId(owner), func) !== 2)) return -1;
  const ret = funcReturnType(func);
  if (ret < 0) return -1;
  typeAnnotationSpan(ret);
  return SP.s0 | 0;
}

/** Prettier's `isFlowShorthandWithOneArg`: `A => B`, where it is written without a place to break at, and with parentheses only if arrow functions have them. */
export function isShorthandFunctionType(func: number): boolean {
  const owner = funcOwner(func);
  if (nodeKind(owner) !== N_TYPE || funcParamsLen(func) < 1) return false;
  const ty = nodeId(owner);
  const only = listAt(funcParamsStart(func), 0);
  if (
    funcParamsLen(func) !== 1 ||
    funcThisParam(func) >= 0 ||
    funcTypeParamsLen(func) !== 0 ||
    paramIsRest(only) ||
    patTag(paramPat(only)) !== PAT_MISSING ||
    paramFlowOuterName(only) ||
    !(paramTy(only) >= 0 && isSimpleType(paramTy(only)))
  ) {
    return false;
  }
  const isFunctionType = keywordOfFunctionType(ty, func) === 0;
  const parent = typeParent(ty);
  const id = nodeId(parent);
  switch (nodeKind(parent)) {
    case N_MEMBER:
      return isFunctionType && !memberIsStatic(id);
    case N_PARAM:
      return isFunctionType && !isFunctionTypeParam(id);
    case N_VAR_DECL:
      return isFunctionType;
    case N_FUNC:
      return isFunctionType || nodeKind(funcOwner(id)) === N_TYPE;
    case N_STMT:
      return stmtTag(id) === STMT_TYPE_ALIAS && !isDeclared(stmtModifiersStart(id), stmtModifiersLen(id));
    case N_TYPE: {
      const tag = typeTag(id);
      return tag === TYPE_UNION || tag === TYPE_INTERSECTION;
    }
    case N_EXPR:
      return isFunctionType && exprIsFlowTypeCast(id);
    default:
      return false;
  }
}

/** Prettier's `shouldIndentUnionType`, what it says about the parameters of function types: whether the union `ty` is written without an indentation of its own. */
export function isUnionIndentedByParameters(ty: number): boolean {
  const parent = typeParent(ty);
  if (nodeKind(parent) !== N_PARAM) return false;
  const param = nodeId(parent);
  const func = paramFuncOf(param);
  if (func < 0 || !isFunctionTypeParam(param)) return false;
  if (funcThisParam(func) === param) return false;
  if (patTag(paramPat(param)) === PAT_MISSING) return true;
  // The function type is the type of a property.
  if (paramIsRest(param)) return false;
  const owner = funcOwner(func);
  if (nodeKind(owner) !== N_TYPE) return false;
  const ot = nodeId(owner);
  if (keywordOfFunctionType(ot, func) !== 0) return false;
  const op = typeParent(ot);
  return nodeKind(op) === N_MEMBER && !memberIsStatic(nodeId(op));
}

/** The parameter of a function type for which `isShorthandFunctionType` holds. */
export function writeShorthandParameter(func: number, f: Formatter): void {
  const owner = funcOwner(func);
  const isHook = nodeKind(owner) === N_TYPE && keywordOfFunctionType(nodeId(owner), func) !== 0;
  const hasParentheses = isHook || f.options.arrowParentheses !== ARROW_PARENS_AS_NEEDED;
  if (hasParentheses) f.token(LPAREN);
  fmtParam(listAt(funcParamsStart(func), 0), f);
  if (hasParentheses) f.token(RPAREN);
}

/** The modifiers of a type parameter: `const`, `+`, `in`. */
export function writeTypeParameterModifiers(param: number, f: Formatter): void {
  writeModifiers(typeParamModifiersStart(param), typeParamModifiersLen(param), f);
}

/** `: Bound`, ` extends Bound`. Babel's tree does not say which it is: `T extends A` is `T: A` for `babel-flow`. */
export function writeTypeParameterBound(param: number, bound: number, f: Formatter): void {
  typeParamFlowTokenAfterName(param);
  if (spTokenIs(":") || parserGoesToBabel(f.options.parser, filepathOf(f.options.filepath))) fmtTypeAnnotation(bound, f);
  else {
    f.token(T_EXTENDS_SPACES);
    fmtType(bound, f);
  }
}

/** `+a?: T`, `...a: T`, `...T`, `...` */
export function writeTupleElement(element: number, f: Formatter): void {
  const bits = tupleElemFlowVarianceAndLabel(element);
  const SP$ = SP;
  const vs = SP$.s0 | 0;
  const ve = SP$.s1 | 0;
  const FLOW$ = FLOW;
  const labelAtom = FLOW$.s0 | 0;
  const labelPos = FLOW$.s1 | 0;
  if (tupleElemIsRest(element)) f.token(ELLIPSIS);
  if ((bits & 1) !== 0) {
    f.sourceText(vs, ve);
    if (ve - vs > 1) f.space();
  }
  if ((bits & 2) !== 0) {
    identifier(labelAtom, labelPos, mkAn(AN_TS_NAMED_TUPLE_MEMBER, element), f);
    if (tupleElemIsOptional(element)) f.token(QUESTION);
    f.token(T_COLON_SPACE);
  }
  const ty = tupleElemFlowType(element);
  if (ty >= 0) fmtType(ty, f);
}

/** `[...]`: the comments in it dangle, and are written behind the dots. Returns whether `ty` is that. */
export function writeTupleOfUnknownElements(ty: number, elementsStart: number, elementsLen: number, f: Formatter): boolean {
  if (elementsLen !== 1 || !isInexactTuple(elementsStart, elementsLen)) return false;
  const cm = cxOf(f).comments;
  typeSpan(ty);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const e = SP$.s1 | 0;
  const n = cm.commentsBefore(e);
  const from = cm.from;
  let hasLineComment = false;
  for (let i = 0; i < n; i++) if (cm.isLine(from + i)) hasLineComment = true;
  f.startGroupExpand(hasLineComment);
  f.token(LBRACKET);
  f.startSoftBlockIndent();
  f.token(ELLIPSIS);
  formatDanglingComments(s, e, DANGLING_NONE, f);
  f.endSoftBlockIndent();
  f.token(RBRACKET);
  f.endGroup();
  return true;
}

/** The `...` that ends an inexact tuple type, after which there is no comma. */
export function isInexactTuple(elementsStart: number, elementsLen: number): boolean {
  return elementsLen > 0 && tupleElemFlowType(listAt(elementsStart, elementsLen - 1)) < 0;
}

// ───────────────────────────── object types ─────────────────────────────

/** The `...` that ends an inexact object type, after which there is no comma. */
export function isInexactMark(member: number): boolean {
  return memberIsFlowSpread(member) && memberTy(member) < 0;
}

/** `{ a: A }`, `{| a: A |}`, `{ a: A, ... }`. Prettier's `printClassBody` for an object type that is not the body of an interface or a class. */
export function writeObjectType(ty: number, membersStart: number, membersLen: number, f: Formatter): void {
  const exact = typeIsFlowExactObject(ty);
  const parens = needsParentheses(ty);
  if (parens) f.token(LPAREN);
  f.token(exact ? T_LBRACE_PIPE : LBRACE);
  typeSpan(ty);
  const SP$ = SP;
  const tyStart = SP$.s0 | 0;
  const tyEnd = SP$.s1 | 0;
  const cx = cxOf(f);
  if (membersLen === 0) {
    formatDanglingComments(tyStart, tyEnd, DANGLING_SOFT, f);
  } else {
    const first = listAt(membersStart, 0);
    memberSpan(first);
    const firstStart = SP$.s0 | 0;
    if (isInexactMark(first) && cx.comments.hasCommentBefore(firstStart)) {
      // Prettier has no node for the `...`: the comments dangle.
      const cm = cx.comments;
      const n = cm.commentsBefore(firstStart);
      const from = cm.from;
      let hasLineComment = false;
      for (let i = 0; i < n; i++) if (cm.isLine(from + i)) hasLineComment = true;
      const endsLine = n > 0 && cm.followedByNewline(from + n - 1);
      f.startGroupExpand(hasLineComment);
      f.startSoftBlockIndentWithMaybeSpace(f.options.bracketSpacing);
      formatDanglingCommentsRangeNone(from, from + n, f);
      if (hasLineComment || endsLine) f.hardLineBreak();
      else f.softLineBreakOrSpace();
      f.token(ELLIPSIS);
      f.endSoftBlockIndentWithMaybeSpace(f.options.bracketSpacing);
      f.endGroup();
    } else {
      const shouldExpand = f.options.expand === EXPAND_AUTO && !isInexactMark(first) && cx.src.containsNewline(tyStart, firstStart);
      if (objectLikeTsTypeLiteralShouldHug(ty, f)) {
        f.startSoftBlockIndentWithMaybeSpace(f.options.bracketSpacing);
        writeTsSignatures(membersStart, membersLen, f);
        f.endSoftBlockIndentWithMaybeSpace(f.options.bracketSpacing);
      } else {
        f.startGroupExpand(shouldExpand);
        f.startSoftBlockIndentWithMaybeSpace(f.options.bracketSpacing);
        writeTsSignatures(membersStart, membersLen, f);
        f.endSoftBlockIndentWithMaybeSpace(f.options.bracketSpacing);
        f.endGroup();
      }
    }
  }
  f.token(exact ? T_RBRACE_PIPE : RBRACE);
  if (parens) f.token(RPAREN);
}

import { formatDanglingCommentsRange, DANGLING_NONE as DANGLING_NONE_MODE } from "../trivia.ts";
function formatDanglingCommentsRangeNone(from: number, to: number, f: Formatter): void {
  formatDanglingCommentsRange(from, to, DANGLING_NONE_MODE, f);
}

/** A member of an object type, of an interface or of a class that is declared, without the separator after it. */
export function writeObjectTypeMember(member: number, f: Formatter): void {
  if (memberIsFlowSpread(member)) {
    f.token(ELLIPSIS);
    const t = memberTy(member);
    if (t >= 0) fmtType(t, f);
    return;
  }
  const node = memberAsAstNodes(member);
  writeModifiers(memberModifiersStart(member), memberModifiersLen(member), f);
  const optional = (memberFlags(member) & FLAG_OPTIONAL) !== 0;
  const kind = memberKind(member);
  const func = memberFunc(member);
  const owner = nodeOfMember(member);
  if (kind === MEMBER_INDEX_SIGNATURE && func >= 0) {
    f.token(LBRACKET);
    if (funcParamsLen(func) > 0) fmtParam(listAt(funcParamsStart(func), 0), f);
    f.token(T_RBRACKET_COLON);
    const ret = funcReturnType(func);
    if (ret >= 0) fmtType(ret, f);
    return;
  }
  if (kind === MEMBER_CALL_SIGNATURE && func >= 0) {
    writeTsCallSignatureDeclaration(func, f);
    return;
  }
  const slot = memberFlowInternalSlot(member);
  const hasKey = keyKind(owner) !== KEY_NONE;
  if (func >= 0) {
    if (slot >= 0) {
      f.token(T_DOUBLE_LBRACKET);
      identifier(slot, memberNamePos(member), node, f);
      f.token(T_DOUBLE_RBRACKET);
      writeTsCallSignatureDeclaration(func, f);
    } else if (hasKey && keyKind(owner) === KEY_IDENT && startsWithAtAt(keyName(owner))) {
      const name = keyName(owner);
      f.textBytes(nameBuf(name), nameStart(name), nameStart(name) + nameLen(name));
      writeTsCallSignatureDeclaration(func, f);
    } else writeTsMethodSignature(member, func, f);
    return;
  }
  const ty = memberTy(member);
  if (ty >= 0 && typeTag(ty) === TYPE_MAPPED) {
    writeMappedTypeProperty(typeMappedOf(ty), f);
    return;
  }
  if (slot >= 0) {
    f.token(T_DOUBLE_LBRACKET);
    identifier(slot, memberNamePos(member), node, f);
    f.token(T_DOUBLE_RBRACKET);
  } else if (hasKey) {
    if (keyKind(owner) === KEY_IDENT && startsWithAtAt(keyName(owner))) {
      const name = keyName(owner);
      f.textBytes(nameBuf(name), nameStart(name), nameStart(name) + nameLen(name));
    } else formatComputedOrPropertyKey(owner, node, f);
  }
  const cx = cxOf(f);
  if (!cx.isQuiet && ty >= 0) {
    const n = commentsAfterPropertyName(ty, f);
    formatTrailingCommentsRange(cx.comments.from, (cx.comments.from + n) | 0, f);
  }
  if (optional) f.token(QUESTION);
  f.token(T_COLON_SPACE);
  if (ty >= 0) fmtType(ty, f);
}

function startsWithAtAt(name: number): boolean {
  const buf = nameBuf(name);
  const s = nameStart(name);
  return nameLen(name) >= 2 && (buf[s] | 0) === 64 && (buf[s + 1] | 0) === 64;
}

import { typeMappedMapped } from "../../../lint/ast/index.ts";
function typeMappedOf(ty: number): number {
  return typeMappedMapped(ty);
}

/** `[K in T]?: V`. Prettier's `printFlowMappedTypeProperty`. */
function writeMappedTypeProperty(mapped: number, f: Formatter): void {
  const param = mappedParam(mapped);
  f.startGroup();
  f.startGroup();
  f.token(LBRACKET);
  f.startSoftBlockIndent();
  identifier(typeParamName(param), typeParamNamePos(param), mkAn(AN_TS_TYPE_PARAMETER, param), f);
  f.token(T_IN);
  const c = typeParamConstraint(param);
  if (c >= 0) fmtType(c, f);
  f.endSoftBlockIndent();
  f.token(RBRACKET);
  f.endGroup();
  const opt = mappedOptional(mapped);
  if (opt === MM_ADD) f.token(mappedIsOptionalWithPlus(mapped) ? T_OPT_PLUS : QUESTION);
  else if (opt === MM_REMOVE) f.token(T_OPT_MINUS);
  f.token(T_COLON_SPACE);
  const t = mappedTy(mapped);
  if (t >= 0) fmtType(t, f);
  f.endGroup();
}

// ───────────────────────────── declarations ─────────────────────────────

/** Whether the interface `statement` stands for `opaque type A = B`. */
export function isOpaqueType(statement: number, f: Formatter): boolean {
  void f;
  return stmtHasWord(statement, "opaque");
}

/** Whether the token that is the last before `bound` ends with `word`. */
function boundFollows(bound: number, word: string): boolean {
  const end = fileEndOfTokenBefore(typeOuterStart(bound));
  if (end < word.length) return false;
  const hir$ = hir;
  for (let i = 0; i < word.length; i++) if ((hir$.text[end - word.length + i] | 0) !== word.charCodeAt(i)) return false;
  return true;
}

/** `opaque type A<T>: B = C`, `opaque type A super B extends C = D` */
export function writeOpaqueType(statement: number, iface: number, f: Formatter): void {
  const node = mkAn(AN_TS_INTERFACE_DECLARATION, statement);
  const ms = stmtModifiersStart(statement);
  const mn = stmtModifiersLen(statement);
  if (isDeclared(ms, mn)) f.token(T_DECLARE_SPACE);
  f.token(T_OPAQUE_TYPE);
  identifier(interfaceName(iface), interfaceNamePos(iface), node, f);
  typeParameters(interfaceTypeParamsStart(iface), interfaceTypeParamsLen(iface), nodeOfStmt(statement), 0, true, f);
  const bs = interfaceExtendsStart(iface);
  const bn = interfaceExtendsLen(iface);
  if (bn > 0) {
    const supertype = listAt(bs, 0);
    if (boundFollows(supertype, ":")) {
      f.token(T_COLON_SPACE);
      fmtType(supertype, f);
    } else {
      f.startGroup();
      for (let i = 0; i < bn; i++) {
        const bound = listAt(bs, i);
        f.startIndent();
        f.softLineBreakOrSpace();
        f.token(boundFollows(bound, "super") ? T_SUPER_KW : T_EXTENDS_KW);
        fmtType(bound, f);
        f.endIndent();
      }
      f.endGroup();
    }
  }
  const t = interfaceFlowOpaqueType(iface);
  if (t >= 0) {
    f.token(T_EQ_SPACES);
    fmtType(t, f);
  }
  optionalSemicolon(f);
}

/** `declare module.exports: T`, and the `T` of `declare export default T`. Returns whether the type alias stands for one of them. */
export function writeWhatIsNoTypeAlias(statement: number, alias: number, f: Formatter): boolean {
  if (nameIs(aliasName(alias), "module.exports")) {
    f.token(T_MODULE_EXPORTS);
    fmtTypeAnnotation(aliasTy(alias), f);
    optionalSemicolon(f);
    return true;
  }
  if (stmtIsDefaultExport(statement)) {
    fmtType(aliasTy(alias), f);
    optionalSemicolon(f);
    return true;
  }
  return false;
}

/** Whether `class` is `declare class`, whose members are those of an object type. */
export function isDeclaredClass(cls: number): boolean {
  return (classFlags(cls) & FLAG_AMBIENT) !== 0 && fileIsFlow();
}

/** Writes `declare class` and `record`. Returns whether `class` is one of them. */
export function writeClass(cls: number, f: Formatter): boolean {
  const record = isRecord(cls);
  if (record || isDeclaredClass(cls)) {
    writeDeclaredClassOrRecord(cls, record, f);
    return true;
  }
  return false;
}

/** The first is `A.B` without type arguments. */
function isQualified(ty: number): boolean {
  return typeTag(ty) === TYPE_REF && typeRefNameLen(ty) > 1 && typeRefArgsLen(ty) === 0;
}

/** `declare class A<T> extends B<T> mixins C implements D { }`, `record A<T> implements B { }`. Prettier's `printClass`. */
function writeDeclaredClassOrRecord(cls: number, isRecordClass: boolean, f: Formatter): void {
  const node = mkAn(AN_CLASS, cls);
  const mixinsStart = classFlowMixinsStart(cls);
  const mixinsLen = classFlowMixinsLen(cls);
  const implStart = classImplementsStart(cls);
  const implLen = classImplementsLen(cls);
  const ext = classExtends(cls);
  const count = (ext >= 0 ? 1 : 0) + mixinsLen + implLen;
  const hasMultipleHeritage = count > 1;
  let groupMode = hasMultipleHeritage;
  if (!groupMode) {
    if (ext >= 0) groupMode = exprTag(ext) === EXPR_DOT && classExtendsArgsLen(cls) === 0;
    else if (mixinsLen > 0) groupMode = isQualified(listAt(mixinsStart, 0));
  }
  // Where what is after `extends`, `mixins` and `implements` starts.
  const startExtends = ext >= 0 ? exprStart(ext) : -1;
  const startMixins = mixinsLen > 0 ? typeStart(listAt(mixinsStart, 0)) : -1;
  const startImplements = implLen > 0 ? typeStart(listAt(implStart, 0)) : -1;
  const cx = cxOf(f);
  // A comment trails the name or the type parameters.
  if (!groupMode && !cx.isQuiet) {
    const first = startExtends >= 0 ? startExtends : startMixins >= 0 ? startMixins : startImplements;
    if (first >= 0 && cx.comments.hasCommentBefore(first)) groupMode = true;
  }

  const modsStart = classModifiersStart(cls);
  const modsLen = classModifiersLen(cls);
  if (isDeclared(modsStart, modsLen)) f.token(T_DECLARE_SPACE);
  f.token(isRecordClass ? T_RECORD : T_CLASS);
  if (groupMode) {
    const heritageId = f.groupId();
    f.startGroupId(heritageId);
    writeClassHead(cls, node, f);
    f.startIndent();
    writeClassClauses(cls, node, hasMultipleHeritage, groupMode, startExtends, startMixins, startImplements, f);
    f.endIndent();
    f.endGroup();
    if (classMembersLen(cls) === 0) f.space();
    else {
      f.startIfGroupBreaksId(heritageId);
      f.hardLineBreak();
      f.endConditional();
      f.startIfGroupFitsId(heritageId);
      f.space();
      f.endConditional();
    }
  } else {
    writeClassHead(cls, node, f);
    writeClassClauses(cls, node, hasMultipleHeritage, groupMode, startExtends, startMixins, startImplements, f);
    f.space();
  }
  // `Class::body_span` knows nothing of `mixins`.
  let bodyStart = 0;
  let bodyEnd = 0;
  const hir$ = hir;
  const SP$ = SP;
  if (mixinsLen > 0 && implLen === 0) {
    typeSpan(listAt(mixinsStart, mixinsLen - 1));
    bodyStart = skipTrivia(hir$.text, hir$.sourceLen | 0, SP$.s1 | 0);
    classSpan(cls);
    bodyEnd = SP$.s1 | 0;
  } else {
    classBodySpan(cls);
    bodyStart = SP$.s0 | 0;
    bodyEnd = SP$.s1 | 0;
  }
  if (classMembersLen(cls) === 0) {
    f.token(LBRACE);
    formatDanglingComments(bodyStart, bodyEnd, DANGLING_BLOCK, f);
    f.token(RBRACE);
  } else if (isRecordClass) writeRecordBody(cls, f);
  else {
    f.token(LBRACE);
    f.startBlockIndent();
    writeTsInterfaceSignatures(classMembersStart(cls), classMembersLen(cls), f);
    f.endBlockIndent();
    f.token(RBRACE);
  }
  // Prettier's `shouldOmitSemicolon` does not know records.
  if (isRecordClass) {
    const owner = classOwner(cls);
    if (nodeKind(owner) === N_STMT && stmtIsDefaultExport(nodeId(owner))) optionalSemicolon(f);
  }
}

function writeClassHead(cls: number, node: number, f: Formatter): void {
  f.space();
  const name = className(cls);
  if (name >= 0) identifier(name, classNamePos(cls), node, f);
  typeParameters(classTypeParamsStart(cls), classTypeParamsLen(cls), nodeOfClass(cls), 0, false, f);
}

function writeClassExtends(cls: number, node: number, f: Formatter): void {
  const names = new I32Vec(8);
  let leftmost = classExtends(cls);
  while (leftmost >= 0 && exprTag(leftmost) === EXPR_DOT) {
    names.push(exprDotName(leftmost));
    names.push(exprDotNamePos(leftmost));
    leftmost = exprDotObj(leftmost);
  }
  if (leftmost >= 0) fmtExpr(leftmost, f);
  for (let i = names.len - 2; i >= 0; i -= 2) {
    f.token(DOT);
    identifier(names.data[i] | 0, names.data[i + 1] | 0, node, f);
  }
  typeArguments(classExtendsArgsStart(cls), classExtendsArgsLen(cls), nodeOfClass(cls), f);
}

function writeClassClauses(
  cls: number,
  node: number,
  hasMultipleHeritage: boolean,
  groupMode: boolean,
  startExtends: number,
  startMixins: number,
  startImplements: number,
  f: Formatter,
): void {
  const cx = cxOf(f);
  for (let which = 0; which < 3; which++) {
    const start = which === 0 ? startExtends : which === 1 ? startMixins : startImplements;
    if (start < 0) continue;
    const keyword = which === 0 ? T_EXTENDS : which === 1 ? T_MIXINS : T_IMPLEMENTS;
    // The comments before a keyword trail what is before it.
    if (!cx.isQuiet) {
      const n = cx.comments.commentsBefore(start);
      formatTrailingCommentsRange(cx.comments.from, (cx.comments.from + n) | 0, f);
    }
    if (hasMultipleHeritage) {
      f.softLineBreakOrSpace();
      f.token(keyword);
      f.startGroup();
      f.startSoftLineIndentOrSpace();
      writeClause(cls, node, which, f);
      f.endSoftLineIndentOrSpace();
      f.endGroup();
    } else if (groupMode) {
      f.softLineBreakOrSpace();
      f.startGroup();
      f.token(keyword);
      f.space();
      writeClause(cls, node, which, f);
      f.endGroup();
    } else {
      f.space();
      f.token(keyword);
      f.space();
      writeClause(cls, node, which, f);
    }
  }
}

function writeClause(cls: number, node: number, which: number, f: Formatter): void {
  if (which === 0) writeClassExtends(cls, node, f);
  else if (which === 1) fmtClassImplements(classFlowMixinsStart(cls), classFlowMixinsLen(cls), f);
  else fmtClassImplements(classImplementsStart(cls), classImplementsLen(cls), f);
}

/** `hook` or `function`: what the declaration of `func` starts with. A component, and a function that is only declared, which is written like a function type, are written here: then it is `""`. */
export function writeComponentOrKeyword(func: number, f: Formatter): string {
  const owner = funcOwner(func);
  if (nodeKind(owner) !== N_STMT) return "function";
  const statement = nodeId(owner);
  const ms = stmtModifiersStart(statement);
  const mn = stmtModifiersLen(statement);
  const cx = cxOf(f);
  if (!hasWordIn(ms, mn, "component")) {
    const keyword = hasWordIn(ms, mn, "hook") ? "hook" : "function";
    if (funcHasBody(func)) return keyword;
    if (isDeclared(ms, mn)) f.token(T_DECLARE_SPACE);
    f.token(keyword === "hook" ? T_HOOK : T_FUNCTION);
    f.space();
    const name = funcName(func);
    if (name >= 0) identifier(name, funcNamePos(func), mkAn(AN_FUNCTION, func), f);
    writeTsCallSignatureDeclaration(func, f);
    const ret = funcReturnType(func);
    if (ret >= 0 && typeTag(ret) === TYPE_TYPEOF) {
      typeFirstToken(ret);
      if (!spTokenIs("typeof")) {
        f.token(T_PERCENT_CHECKS_OPEN_SP);
        fmtExpr(typeTypeofExprOf(ret), f);
        f.token(RPAREN);
      }
    }
    // Those before the `;` trail the return type.
    if (!cx.isQuiet && stmtSemicolon(statement)) {
      const n = cx.comments.commentsBefore(SP.s0 | 0);
      formatTrailingCommentsRange(cx.comments.from, (cx.comments.from + n) | 0, f);
    }
    optionalSemicolon(f);
    return "";
  }
  if (isDeclared(ms, mn)) f.token(T_DECLARE_SPACE);
  if (funcIsAsync(func)) f.token(T_ASYNC_SPACE);
  f.token(T_COMPONENT_SPACE);
  const name = funcName(func);
  if (name >= 0) identifier(name, funcNamePos(func), mkAn(AN_FUNCTION, func), f);
  typeParameters(funcTypeParamsStart(func), funcTypeParamsLen(func), nodeOfFunc(func), 0, false, f);
  writeComponentParametersAndRenders(func, f);
  if (funcHasBody(func)) fmtFunctionBody(func, f);
  else optionalSemicolon(f);
  return "";
}

import { typeTypeofExpr } from "../../../lint/ast/index.ts";
function typeTypeofExprOf(ty: number): number {
  return typeTypeofExpr(ty);
}

/** `of string `, after the name of an enum. */
export function writeExplicitTypeOfEnum(declaration: number, f: Formatter): void {
  const SP$ = SP;
  if (enumFlowExplicitType(declaration)) {
    f.token(T_OF_SPACE);
    f.sourceText(SP$.s0 | 0, SP$.s1 | 0);
    f.space();
  }
}

/** The `...` that ends an enum with unknown members, after which there is no comma. */
export function isUnknownMembersMark(member: number): boolean {
  // `member.text() == b"..."`
  const s = enumMemberStartOf(member);
  const hir$ = hir;
  return (hir$.text[s] | 0) === 46 && (hir$.text[s + 1] | 0) === 46 && (hir$.text[s + 2] | 0) === 46 && enumMemberEndOf(member) - s === 3;
}

import { enumMemberSpan } from "../../../lint/ast/index.ts";
function enumMemberStartOf(member: number): number {
  enumMemberSpan(member);
  return SP.s0 | 0;
}
function enumMemberEndOf(member: number): number {
  enumMemberSpan(member);
  return SP.s1 | 0;
}

/** `typeof ` or `type `: how the import, or the specifier, that starts at `start` after its `import` is written. */
export function importKind(start: number, f: Formatter): string {
  void f;
  const t = "typeof";
  const hir$ = hir;
  for (let i = 0; i < t.length; i++) if ((hir$.text[start + i] | 0) !== t.charCodeAt(i)) return "type ";
  return "typeof ";
}

// ───────────────────────────── match ─────────────────────────────



function writeBody(bk: number, bh: number, bp: number, bc: number, f: Formatter): void {
  switch (bk) {
    case BK_MATCH_EXPR_CASE:
      writeMatchExpressionCase(bh, f);
      return;
    case BK_MATCH_STMT_CASE:
      writeMatchStatementCase(bh, f);
      return;
    case BK_GUARD:
      writeExpression(bh, EO_NONE, f);
      return;
    case BK_PATTERN_PARTS:
      writeMatchPatternThatHasParts(bh, bp, bc, f);
      return;
    case BK_OBJECT_PATTERN_PROPERTY:
      writeMatchObjectPatternProperty(bh, f);
      return;
    case BK_RECORD_PROPERTY:
      writeRecordProperty(bh, f);
      return;
    default:
      return;
  }
}

/** `format_node(span, parent, f, |f| body)` for a body of this file. */
function formatNodeWith(start: number, end: number, pk: number, ph: number, bk: number, bh: number, bp: number, bc: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    writeBody(bk, bh, bp, bc, f);
    return;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) writeSuppressedNode(start, end, f);
  else {
    const outer = enterScope(cx, start, end);
    writeBody(bk, bh, bp, bc, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, pk, ph, f);
}

/** `match (a) { }` and `R { a: 1 }` are `new` expressions in the tree, which do not start with `new`. Returns whether `e` is one of them, which is written. */
export function writeExpressionWithBraces(e: number, call: number, f: Formatter): boolean {
  if (callArgsLen(call) === 0) return false;
  const head = callCallee(call);
  const braces = listAt(callArgsStart(call), 0);
  if (exprStart(head) !== exprStart(e)) return false;
  const headCall = exprAsCall(head);
  if (headCall >= 0 && exprTag(braces) === EXPR_OBJECT) {
    writeMatch(headCall, exprStart(braces), exprObjectPropsLen(braces) === 0, 1, braces, 0, f);
    return true;
  }
  const typeArgsLen = callTypeArgsLen(call);
  fmtExpr(head, f);
  if (typeArgsLen === 0 && exprIsBeforeFlowTypeArguments(head)) f.token(T_EMPTY_ANGLE);
  typeArguments(callTypeArgsStart(call), typeArgsLen, hirNodeOfExpr(e), f);
  f.space();
  fmtExpr(braces, f);
  return true;
}

import { nodeOfExpr } from "../../../lint/ast/index.ts";
function hirNodeOfExpr(e: number): number {
  return nodeOfExpr(e);
}

/** A match statement is a `switch` statement in the tree, which does not start with `switch`. Returns whether `statement` is one, which is written. */
export function writeMatchStatement(statement: number, head: number, casesStart: number, casesLen: number, f: Formatter): boolean {
  const headCall = exprAsCall(head);
  stmtSpan(statement);
  const stmtStart = SP.s0 | 0;
  if (headCall < 0 || exprStart(head) !== stmtStart) return false;
  const headEnd = exprEnd(head);
  const hir$ = hir;
  const openBrace = skipTrivia(hir$.text, hir$.sourceLen | 0, headEnd);
  writeMatch(headCall, openBrace, casesLen === 0, 2, statement, casesStart, f, casesLen);
  return true;
}

/** Writes the cases of a match. `mode` 1: the properties of the object `a`; 2: the cases `b ..` (`c`) of the statement `a`. */
function writeMatchCases(mode: number, a: number, b: number, c: number, f: Formatter): void {
  let has = false;
  const SP$ = SP;
  if (mode === 1) {
    const s = exprObjectPropsStart(a);
    const n = exprObjectPropsLen(a);
    for (let i = 0; i < n; i++) {
      const prop = listAt(s, i);
      propSpan(prop);
      const ps = SP$.s0 | 0;
      const pe = SP$.s1 | 0;
      if (has) joinNodesSeparator(f, JOIN_HARDLINE, ps, pe);
      has = true;
      formatNodeWith(ps, pe, PK_PARENT, mkAn(AN_OBJECT_EXPRESSION, a), BK_MATCH_EXPR_CASE, prop, 0, 0, f);
    }
  } else {
    for (let i = 0; i < c; i++) {
      const cs = listAt(b, i);
      caseSpan(cs);
      const s = SP$.s0 | 0;
      const e = SP$.s1 | 0;
      if (has) joinNodesSeparator(f, JOIN_HARDLINE, s, e);
      has = true;
      formatNodeWith(s, e, PK_PARENT, mkAn(AN_SWITCH_STATEMENT, a), BK_MATCH_STMT_CASE, cs, 0, 0, f);
    }
  }
}

/** Prettier's `printMatch`. `head`: the `match (a)` (a call). `openBrace`: where the `{` is. */
function writeMatch(head: number, openBrace: number, isEmpty: boolean, mode: number, a: number, b: number, f: Formatter, c: number = 0): void {
  f.startGroup();
  f.token(T_MATCH_OPEN);
  f.startSoftBlockIndent();
  if (callArgsLen(head) > 0) fmtExpr(listAt(callArgsStart(head), 0), f);
  // What is behind the `{` on its line trails the argument.
  const cx = cxOf(f);
  if (!cx.isQuiet) {
    const n = cx.comments.endOfLineCommentsAfter(openBrace + 1);
    formatTrailingCommentsRange(cx.comments.from, (cx.comments.from + n) | 0, f);
  }
  f.endSoftBlockIndent();
  f.token(RPAREN);
  f.endGroup();
  f.token(T_MATCH_BRACE);
  if (isEmpty) f.hardLineBreak();
  else {
    f.startBlockIndent();
    writeMatchCases(mode, a, b, c, f);
    f.endBlockIndent();
  }
  f.token(RBRACE);
}

/** One case of a match statement: `pattern if (guard) => body`. */
function writeMatchStatementCase(cs: number, f: Formatter): void {
  writeMatchPatternAndGuard(caseTest(cs), f);
  const n = caseBodyLen(cs);
  let isEmpty = false;
  let body = -1;
  const SP$ = SP;
  if (n > 0) {
    body = listAt(caseBodyStart(cs), 0);
    stmtSpan(body);
    const bs = SP$.s0 | 0;
    const be = SP$.s1 | 0;
    isEmpty = stmtTag(body) === STMT_BLOCK_TAG && !stmtIsWithBlock(body) && blockLen(body) === 0 && !cxOf(f).comments.hasCommentInRange(bs, be);
  }
  if (isEmpty) f.token(T_ARROW_EMPTY);
  else {
    f.token(T_ARROW_SPACES);
    if (body >= 0) fmtStmtForMatch(body, f);
  }
}

import { STMT_BLOCK, stmtBlockStmtsLen, stmtIsWith } from "../../../lint/ast/index.ts";
import { fmtStmt } from "../format.ts";
const STMT_BLOCK_TAG: number = STMT_BLOCK;
function stmtIsWithBlock(s: number): boolean {
  return stmtIsWith(s);
}
function blockLen(s: number): number {
  return stmtBlockStmtsLen(s);
}
function fmtStmtForMatch(s: number, f: Formatter): void {
  fmtStmt(s, f);
}

/** `pattern`, `pattern if (guard)`, which is a `&&` in the tree. */
function writeMatchPatternAndGuard(pattern: number, f: Formatter): void {
  if (pattern < 0) return;
  const SP$ = SP;
  if (exprTag(pattern) === EXPR_BINARY && exprBinaryOp(pattern) === BIN_AND) {
    const left = exprBinaryLeft(pattern);
    const right = exprBinaryRight(pattern);
    writeMatchPattern(left, PP_CASE, 0, f);
    // It is in no `&&`.
    f.startGroup();
    f.startIndent();
    f.softLineBreakOrSpace();
    f.token(T_IF_OPEN);
    exprSpan(right);
    formatNodeWith(SP$.s0 | 0, SP$.s1 | 0, PK_PARENT, exprAstParent(right), BK_GUARD, right, 0, 0, f);
    f.token(RPAREN);
    f.endIndent();
    f.endGroup();
  } else writeMatchPattern(pattern, PP_CASE, 0, f);
}

/** Prettier's `printMatchCase` for a case of a match expression, which is a property with a computed name in the tree. */
function writeMatchExpressionCase(cs: number, f: Formatter): void {
  const owner = nodeOfProp(cs);
  const pattern = keyKind(owner) === KEY_COMPUTED ? keyExpr(owner) : -1;
  writeMatchPatternAndGuard(pattern, f);
  const body = propValue(cs);
  // Prettier's `needsParentheses`.
  const isArrow = body >= 0 && exprTag(body) === EXPR_FN && funcIsArrow(exprFnFnOf(body));
  f.startGroup();
  f.token(T_ARROW);
  f.startIndent();
  f.softLineBreakOrSpace();
  if (isArrow) f.token(LPAREN);
  if (body >= 0) fmtExpr(body, f);
  if (isArrow) f.token(RPAREN);
  f.token(COMMA);
  f.endIndent();
  f.endGroup();
}

import { exprFnFn } from "../../../lint/ast/index.ts";
import { BK_MATCH_EXPR_CASE, BK_MATCH_STMT_CASE, BK_GUARD, BK_PATTERN_PARTS, BK_OBJECT_PATTERN_PROPERTY, BK_RECORD_PROPERTY, PP_CASE, PP_ARRAY, PP_PROPERTY, PP_AS, PP_OTHER } from "./flow.consts.ts";
function exprFnFnOf(e: number): number {
  return exprFnFn(e);
}

/** `a | b | c`, from left to right. */
function alternatives(pattern: number, out: I32Vec): void {
  const base = out.len;
  let rest = pattern;
  while (exprTag(rest) === EXPR_BINARY && exprBinaryOp(rest) === BIN_BIT_OR) {
    out.push(exprBinaryRight(rest));
    rest = exprBinaryLeft(rest);
  }
  out.push(rest);
  // reverse out[base ..)
  let i = base;
  let j = out.len - 1;
  while (i < j) {
    const x = out.data[i] | 0;
    out.data[i] = out.data[j] | 0;
    out.data[j] = x;
    i = i + 1;
    j = j - 1;
  }
}

/** Prettier's `printMatchPattern`. A pattern is an expression in the tree. `count`: of `PP_ARRAY`. */
function writeMatchPattern(pattern: number, parent: number, count: number, f: Formatter): void {
  if (!f.stack.enter()) return;
  const tag = exprTag(pattern);
  const isLeaf = !(
    tag === EXPR_BINARY ||
    tag === EXPR_OBJECT ||
    tag === EXPR_ARRAY ||
    tag === EXPR_NEW ||
    tag === EXPR_SPREAD ||
    (tag === EXPR_UNARY && exprUnaryOpOf(pattern) === UN_VOID)
  );
  const SP$ = SP;
  if (isLeaf) fmtExpr(pattern, f);
  else {
    exprSpan(pattern);
    formatNodeWith(SP$.s0 | 0, SP$.s1 | 0, PK_PARENT, exprAstParent(pattern), BK_PATTERN_PARTS, pattern, parent, count, f);
  }
  f.stack.leave();
}

function writeMatchPatternThatHasParts(pattern: number, parent: number, count: number, f: Formatter): void {
  const tag = exprTag(pattern);
  const SP$ = SP;
  if (tag === EXPR_BINARY && exprBinaryOp(pattern) === BIN_BIT_OR) {
    writeMatchOrPattern(pattern, parent, count, f);
  } else if (tag === EXPR_BINARY) {
    writeMatchPattern(exprBinaryLeft(pattern), PP_AS, 0, f);
    f.token(T_AS);
    writeMatchPattern(exprBinaryRight(pattern), PP_OTHER, 0, f);
  } else if (tag === EXPR_UNARY) {
    // `const a`
    const c = hir.text[exprStart(pattern)] | 0;
    f.token(c === 99 ? T_CONST : c === 108 ? T_LET : T_VAR);
    fmtExpr(exprUnaryOperand(pattern), f);
  } else if (tag === EXPR_SPREAD) {
    f.token(ELLIPSIS);
    writeMatchPattern(exprSpreadExpr(pattern), PP_OTHER, 0, f);
  } else if (tag === EXPR_NEW) {
    const call = exprNewCall(pattern);
    f.startGroup();
    fmtExpr(callCallee(call), f);
    f.space();
    if (callArgsLen(call) > 0) writeMatchPattern(listAt(callArgsStart(call), 0), PP_OTHER, 0, f);
    f.endGroup();
  } else if (tag === EXPR_ARRAY) {
    const s = exprArrayElemsStart(pattern);
    const n = exprArrayElemsLen(pattern);
    const hasRest = n > 0 && exprTag(listAt(s, n - 1)) === EXPR_SPREAD;
    const total = n - (hasRest ? 1 : 0);
    f.startGroup();
    f.token(LBRACKET);
    f.startSoftBlockIndent();
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        f.token(COMMA);
        f.softLineBreakOrSpace();
      }
      writeMatchPattern(listAt(s, i), PP_ARRAY, total, f);
    }
    if (!hasRest) f.tokenIfBreaks(COMMA);
    f.endSoftBlockIndent();
    f.token(RBRACKET);
    f.endGroup();
  } else if (tag === EXPR_OBJECT) {
    const s = exprObjectPropsStart(pattern);
    const n = exprObjectPropsLen(pattern);
    const hasRest = n > 0 && propKind(listAt(s, n - 1)) === PROP_SPREAD;
    f.startGroup();
    f.token(LBRACE);
    f.startSoftBlockIndent();
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        f.token(COMMA);
        f.softLineBreakOrSpace();
      }
      const prop = listAt(s, i);
      propSpan(prop);
      formatNodeWith(SP$.s0 | 0, SP$.s1 | 0, PK_PARENT, mkAn(AN_OBJECT_EXPRESSION, pattern), BK_OBJECT_PATTERN_PROPERTY, prop, 0, 0, f);
    }
    if (!hasRest) f.tokenIfBreaks(COMMA);
    f.endSoftBlockIndent();
    f.token(RBRACE);
    f.endGroup();
  }
}

/** `a: pattern`, `const a`, `...const a`, `...` */
function writeMatchObjectPatternProperty(property: number, f: Formatter): void {
  const value = propValue(property);
  if (value < 0) return;
  const owner = nodeOfProp(property);
  let hasKey = keyKind(owner) !== KEY_NONE;
  if (propKind(property) === PROP_SPREAD) {
    f.token(ELLIPSIS);
    hasKey = false;
  }
  if (!hasKey) {
    writeMatchPattern(value, PP_OTHER, 0, f);
    return;
  }
  keySpan(owner);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const e = SP$.s1 | 0;
  f.startGroup();
  if (keyKind(owner) === KEY_STRING) fmtStringLiteral(s, e, mkAn(AN_OBJECT_PROPERTY, property), f);
  else f.sourceText(s, e);
  f.token(T_COLON);
  f.startIndent();
  f.softLineBreakOrSpace();
  writeMatchPattern(value, PP_PROPERTY, 0, f);
  f.endIndent();
  f.endGroup();
}

/** Prettier's `isSimpleMatchPattern`. */
function isSimpleMatchPattern(pattern: number): boolean {
  switch (exprTag(pattern)) {
    case EXPR_IDENT:
    case EXPR_NULL:
    case EXPR_TRUE:
    case EXPR_FALSE:
    case EXPR_NUMBER:
    case EXPR_BIG_INT:
    case EXPR_STRING:
      return true;
    case EXPR_UNARY:
      return exprUnaryOpOf(pattern) !== UN_VOID;
    default:
      return false;
  }
}

const alternativesScratch = new I32Vec(16);

/** Prettier's `printMatchOrPattern`. */
function writeMatchOrPattern(pattern: number, parent: number, count: number, f: Formatter): void {
  const alternativesScratch$ = alternativesScratch;
  const base = alternativesScratch$.len;
  alternatives(pattern, alternativesScratch$);
  const end = alternativesScratch$.len;
  const cx = cxOf(f);
  exprSpan(pattern);
  const SP$ = SP;
  const ps = SP$.s0 | 0;
  const pe = SP$.s1 | 0;
  // Prettier's `shouldHugMatchOrPattern`: one object pattern among simple ones.
  let objects = 0;
  let allSimple = true;
  for (let i = base; i < end; i++) {
    const it = alternativesScratch$.data[i] | 0;
    if (exprTag(it) === EXPR_OBJECT) objects = objects + 1;
    else if (!isSimpleMatchPattern(it)) allSimple = false;
  }
  const shouldHug = objects === 1 && allSimple && !cx.comments.hasCommentInRange(ps, pe);
  if (shouldHug) {
    for (let i = base; i < end; i++) {
      if (i > base) f.token(T_PIPE_SPACES);
      writeMatchPattern(alternativesScratch$.data[i] | 0, PP_OTHER, 0, f);
    }
    alternativesScratch$.len = base;
    return;
  }
  const shouldIndent = !(parent === PP_CASE || parent === PP_ARRAY || parent === PP_PROPERTY) && !cx.comments.hasLeadingOwnLineComment(ps);
  if (parent === PP_AS) {
    f.token(LPAREN);
    f.startGroup();
    f.startIndent();
    f.startIfGroupBreaks();
    f.softLineBreak();
    f.endConditional();
    writeAlternatives(base, end, f);
    f.endIndent();
    f.softLineBreak();
    f.endGroup();
    f.token(RPAREN);
  } else if (parent === PP_ARRAY && count > 1) {
    f.startGroup();
    f.startIndent();
    f.startIfGroupBreaks();
    f.token(LPAREN);
    f.softLineBreak();
    f.endConditional();
    writeAlternatives(base, end, f);
    f.endIndent();
    f.softLineBreak();
    f.startIfGroupBreaks();
    f.token(RPAREN);
    f.endConditional();
    f.endGroup();
  } else if (shouldIndent) {
    f.startGroup();
    f.startIndent();
    writeAlternatives(base, end, f);
    f.endIndent();
    f.endGroup();
  } else {
    f.startGroup();
    writeAlternatives(base, end, f);
    f.endGroup();
  }
  alternativesScratch$.len = base;
}

function writeAlternatives(base: number, end: number, f: Formatter): void {
  // The scratch can grow while the patterns are written (they are nested): the alternatives are copied first.
  const n = end - base;
  const copy: number[] = [];
  const alternativesScratch$ = alternativesScratch;
  for (let i = 0; i < n; i++) copy.push(alternativesScratch$.data[base + i] | 0);
  f.startIfGroupBreaks();
  f.token(T_PIPE_SPACE);
  f.endConditional();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      f.softLineBreakOrSpace();
      f.token(T_PIPE_SPACE);
    }
    f.startAlign(2);
    writeMatchPattern(copy[i] | 0, PP_OTHER, 0, f);
    f.endAlign(2);
  }
}

// ───────────────────────────── records ─────────────────────────────

/** Whether `class` is `record A { }`. */
function isRecord(cls: number): boolean {
  return hasWordIn(classModifiersStart(cls), classModifiersLen(cls), "record");
}

/** The `{ }` of a record that has members. Prettier's `printClassBody`. */
function writeRecordBody(cls: number, f: Formatter): void {
  const s = classMembersStart(cls);
  const n = classMembersLen(cls);
  const cx = cxOf(f);
  const isConsistent = f.options.quoteProperties === QUOTE_PROPS_CONSISTENT;
  if (isConsistent) {
    let quoteNeeded = false;
    for (let i = 0; i < n; i++) {
      const m = listAt(s, i);
      const owner = nodeOfMember(m);
      if (keyKind(owner) !== KEY_NONE && keyRequiresQuotes(owner, memberAsAstNodes(m), f)) quoteNeeded = true;
    }
    cx.pushQuoteNeeded(quoteNeeded);
  }
  f.token(LBRACE);
  f.startBlockIndent();
  let has = false;
  const SP$ = SP;
  for (let i = 0; i < n; i++) {
    const m = listAt(s, i);
    memberSpan(m);
    const ms = SP$.s0 | 0;
    const me = SP$.s1 | 0;
    if (has) joinNodesSeparator(f, JOIN_HARDLINE, ms, me);
    has = true;
    if (memberKind(m) === MEMBER_PROPERTY) {
      formatNodeWith(ms, me, PK_NODE, memberAsAstNodes(m), BK_RECORD_PROPERTY, m, 0, 0, f);
      f.token(COMMA);
    } else fmtMember(m, f);
  }
  f.endBlockIndent();
  f.token(RBRACE);
  if (isConsistent) cx.popQuoteNeeded();
}

/** `a: T = b`, `static a: T = b` */
function writeRecordProperty(member: number, f: Formatter): void {
  const node = memberAsAstNodes(member);
  if (memberIsStatic(member)) f.token(T_STATIC_SPACE);
  const owner = nodeOfMember(member);
  if (keyKind(owner) !== KEY_NONE) formatComputedOrPropertyKey(owner, node, f);
  const ty = memberTy(member);
  if (ty >= 0) fmtTypeAnnotation(ty, f);
  const init = memberInit(member);
  if (init >= 0) {
    f.token(T_EQ_SPACES);
    fmtExpr(init, f);
  }
}

void T_DASH;
void T_COMPONENT;
void T_RBRACE_PIPE;
void keyName;
void typeEnd;
void FLAG_OPTIONAL;
void N_PARAM;
void keyKind;
