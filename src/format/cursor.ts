// Port of vendor/bun/src/format/cursor.rs: `cursorOffset`: where the cursor is in the formatted text.
//
// What Prettier does (`main/get-cursor-node.js`, `main/core.js`):
// 1. Before formatting, it finds the smallest part of the text that the cursor is in: a node without children, or what is between two
//    nodes. `locate` / `locateItems`.
// 2. While formatting, it notes where that part ends up in the output (`f.cursor(CURSOR_REGION_START / END)` marks, `marksStart()` /
//    `marksEnd()` of ir/run.ts).
// 3. It compares the part before and after, character by character, with the cursor as one more character of the text before. Where the
//    cursor is deleted is where it is now. `resolve`.
//
// Which nodes there are matters for 1. Prettier sees Babel's tree for JavaScript and typescript-estree's for TypeScript. The `Item`s say
// what their nodes are in terms of the handles: only where they start and end, what is in them, and in which order Prettier visits that.
//
// The hooks of the JavaScript formatter (what Rust calls `cursor.enter(span, f)` / `cursor.exit(span, f)` around a node): the
// `CursorRegion` is `cxOf(f).cursor`; `enterNode` / `extendNode` are for code that writes a node and has no wrapper in format.ts;
// `aroundNodeBegin` / `aroundNodeEnd` for Rust's `around_node(span, f, |f| ..)`; `aroundJsxChildrenBegin` / `aroundJsxChildrenEnd` for
// `around_jsx_children`.
import { ByteBuf } from "../base/bytebuf.ts";
import { utf16Len } from "../base/utf8.ts";
import { Formatter } from "./ir/formatter.ts";
import { CURSOR_REGION_END, CURSOR_REGION_START } from "./ir/element.ts";
import { marksEnd, marksStart } from "./ir/run.ts";
import { FormatOptions } from "./options.ts";
import { FORMAT_OK } from "./errors.ts";
import { trimJsWhitespaceStart } from "./text.ts";
import { formatDocument } from "./js/mod.ts";
import { trimInfo } from "./js/state.ts";
import { CursorRegion, Extent, NOWHERE } from "./cursor_region.ts";
export { aroundJsxChildrenBegin, aroundJsxChildrenEnd, aroundNodeBegin, aroundNodeEnd, enterNode, extendNode } from "./cursor_region.ts";
import { shouldFlatten } from "./js/print/binary_like_expression.ts";
import { withoutLoneOperator } from "./js/utils/typescript.ts";
import { isTypeCastText } from "./js/comments.ts";
import { I32Vec } from "../sema/vec.ts";
import {
  BIN_AND,
  BIN_COMMA,
  BIN_NULLISH,
  BIN_OR,
  BODY_BLOCK,
  BODY_EXPR,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_ARRAY,
  EXPR_ASSIGN,
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
  EXPR_IMPORT_CALL,
  EXPR_IMPORT_META,
  EXPR_INDEX,
  EXPR_INSTANTIATION,
  EXPR_JSX,
  EXPR_MISSING,
  EXPR_NEW,
  EXPR_NEW_TARGET,
  EXPR_NON_NULL,
  EXPR_NULL,
  EXPR_NUMBER,
  EXPR_OBJECT,
  EXPR_PRIVATE_IDENTIFIER,
  EXPR_REGEX,
  EXPR_SATISFIES,
  EXPR_SPREAD,
  EXPR_STRING,
  EXPR_SUPER,
  EXPR_TAGGED_TEMPLATE,
  EXPR_TEMPLATE,
  EXPR_THIS,
  EXPR_TRUE,
  EXPR_UNARY,
  EXPR_YIELD,
  IET_ENTITY,
  JC_EXPR,
  KEY_COMPUTED,
  KEY_NONE,
  KEY_PRIVATE,
  MEMBER_CALL_SIGNATURE,
  MEMBER_CONSTRUCT_SIGNATURE,
  MEMBER_INDEX_SIGNATURE,
  MEMBER_STATIC_BLOCK,
  PAT_ARRAY,
  PAT_IDENT,
  PAT_MISSING,
  PAT_OBJECT,
  PROP_GETTER,
  PROP_METHOD,
  PROP_SETTER,
  PROP_SPREAD,
  SP,
  STMT_BLOCK,
  STMT_BREAK,
  STMT_CLASS,
  STMT_CONTINUE,
  STMT_DEBUGGER,
  STMT_DO_WHILE,
  STMT_EMPTY,
  STMT_ENUM,
  STMT_EXPORT_AS_NAMESPACE,
  STMT_EXPORT_ASSIGN,
  STMT_EXPORT_DEFAULT,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_EXPR,
  STMT_FN,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IF,
  STMT_IMPORT,
  STMT_IMPORT_EQUALS,
  STMT_INTERFACE,
  STMT_LABELED,
  STMT_MODULE,
  STMT_RETURN,
  STMT_SWITCH,
  STMT_THROW,
  STMT_TRY,
  STMT_TYPE_ALIAS,
  STMT_VAR,
  STMT_WHILE,
  TYPE_ARRAY,
  TYPE_BIG_INT_LIT,
  TYPE_BOOL_LIT,
  TYPE_COND,
  TYPE_ERROR,
  TYPE_FN,
  TYPE_HERITAGE,
  TYPE_IMPORT,
  TYPE_INDEXED_ACCESS,
  TYPE_INFER,
  TYPE_INTERSECTION,
  TYPE_JSDOC,
  TYPE_KEYOF,
  TYPE_KEYWORD,
  TYPE_MAPPED,
  TYPE_NUMBER_LIT,
  TYPE_OBJECT,
  TYPE_PREDICATE,
  TYPE_READONLY,
  TYPE_REF,
  TYPE_STRING_LIT,
  TYPE_TEMPLATE,
  TYPE_TUPLE,
  TYPE_TYPEOF,
  TYPE_UNION,
  TYPE_UNIQUE,
  TYPE_UNIQUE_SYMBOL,
  aliasName,
  aliasNamePos,
  aliasTy,
  aliasTypeParamsLen,
  aliasTypeParamsStart,
  caseBodyLen,
  caseBodyStart,
  caseSpan,
  caseTest,
  classExtends,
  classExtendsArgsLen,
  classExtendsArgsStart,
  classImplementsLen,
  classImplementsStart,
  className,
  classMembersLen,
  classMembersStart,
  classModifiersLen,
  classModifiersStart,
  classNamePos,
  classBodySpan,
  classTypeParamsLen,
  classTypeParamsStart,
  callArgsLen,
  callArgsStart,
  callCallee,
  callTemplate,
  callTypeArgsLen,
  callTypeArgsStart,
  entityAtom,
  entityPos,
  enumBodySpan,
  enumMemberComputedKey,
  enumMemberInit,
  enumMemberSpan,
  enumMembersLen,
  enumMembersStart,
  enumName,
  enumNamePos,
  exportAttributes,
  exportItemsLen,
  exportItemsStart,
  exportSpecExported,
  exportSpecExportedPos,
  exportSpecLocal,
  exportSpecLocalPos,
  exportSpecSpan,
  exportSpecSpanOf,
  exprAsExpr,
  exprAsTy,
  exprAssignTarget,
  exprAssignValue,
  exprAwaitExpr,
  exprArrayElemsLen,
  exprArrayElemsStart,
  exprBinaryLeft,
  exprBinaryOp,
  exprBinaryRight,
  exprChain,
  exprClassClass,
  exprCondNo,
  exprCondTest,
  exprCondYes,
  exprConstKeywordSpan,
  exprDotName,
  exprDotNamePos,
  exprDotObj,
  exprFnFn,
  exprImportCallArgsLen,
  exprImportCallArgsStart,
  exprIndexIndex,
  exprIndexObj,
  exprInnerNonNullCount,
  exprInstantiationExpr,
  exprInstantiationTypeArgsLen,
  exprInstantiationTypeArgsStart,
  exprIsChainRoot,
  exprIsJsxText,
  exprIsMissing,
  exprIsParenthesized,
  exprJsxContainerSpan,
  exprMetaPropertySpans,
  exprNonNullEndsFirst,
  exprNonNullExpr,
  exprObjectPropsLen,
  exprObjectPropsStart,
  exprOuterSpan,
  exprSatisfiesExpr,
  exprSatisfiesTy,
  exprSequence,
  exprSpan,
  exprEnd,
  exprSpreadExpr,
  exprStart,
  exprTag,
  exprTaggedTemplateCall,
  exprTemplateExprsLen,
  exprTemplateExprsStart,
  exprTemplateQuasiCount,
  exprTemplateQuasiSpan,
  exprUnaryOperand,
  exprYieldValue,
  exprCallCall,
  exprNewCall,
  exprAsConstExpr,
  fileBodyLen,
  fileBodyStart,
  fileIsJavascript,
  funcBodyExpr,
  funcBodyKind,
  funcBodySpan,
  funcBodyStmtsLen,
  funcBodyStmtsStart,
  funcName,
  funcNamePos,
  funcParamsLen,
  funcParamsStart,
  funcReturnType,
  funcSpanFromParams,
  funcThisParam,
  funcTypeParamsLen,
  funcTypeParamsStart,
  hir,
  identEndOf,
  identSpan,
  importAttributes,
  importAttributesEntriesLen,
  importAttributesEntriesStart,
  importAttributesOptionsSpan,
  importDefault,
  importDefaultPos,
  importEqualsEntityLen,
  importEqualsEntityStart,
  importEqualsName,
  importEqualsNamePos,
  importEqualsRequireSpan,
  importEqualsTargetKind,
  importNamedLen,
  importNamedStart,
  importNamespace,
  importNamespacePos,
  importNamespaceSpan,
  importSpecImported,
  importSpecImportedPos,
  importSpecLocal,
  importSpecLocalPos,
  importSpecSpan,
  importSpecSpanOf,
  interfaceExtendsLen,
  interfaceExtendsStart,
  interfaceMembersLen,
  interfaceMembersStart,
  interfaceBodySpan,
  interfaceName,
  interfaceNamePos,
  interfaceTypeParamsLen,
  interfaceTypeParamsStart,
  jsxAttrsLen,
  jsxAttrsStart,
  jsxChildrenWithWhitespace,
  jsxClosingSpan,
  jsxCloseTag,
  jsxIsFragment,
  jsxNamespaceAndName,
  jsxOpeningSpan,
  jsxTag,
  jsxTypeArgsLen,
  jsxTypeArgsStart,
  keyExpr,
  keyInnerSpan,
  keyIsJsx,
  keyKind,
  listAt,
  mappedNameTy,
  mappedParam,
  mappedTy,
  memberConstructorKeyword,
  memberFunc,
  memberInit,
  memberIsSignature,
  memberKind,
  memberModifiersLen,
  memberModifiersStart,
  memberNamePos,
  memberSpan,
  memberTy,
  modifierDecorator,
  modifierSpan,
  moduleBodyLen,
  moduleBodySpan,
  moduleBodyStart,
  moduleNameSpan,
  moduleNested,
  nameBuf,
  nameStart,
  nodeOfEnumMember,
  nodeOfMember,
  nodeOfPatProp,
  nodeOfProp,
  paramBindingSpan,
  paramDefault,
  paramIsRest,
  paramModifiersLen,
  paramModifiersStart,
  paramPat,
  paramSpan,
  paramSpanWithoutModifiers,
  paramTy,
  patArrayElemsLen,
  patArrayElemsStart,
  patElemDefault,
  patElemIsRest,
  patElemPat,
  patElemSpan,
  patObjectPropsLen,
  patObjectPropsStart,
  patPropDefault,
  patPropIsRest,
  patPropSpan,
  patPropValue,
  patSpan,
  patTag,
  propFunc,
  propIsJsxAttribute,
  propKind,
  propSpan,
  propValue,
  skipTrivia,
  skipTriviaBack,
  stmtAsExpr,
  stmtBlockStmtsLen,
  stmtBlockStmtsStart,
  stmtCatchClauseSpan,
  stmtClassClass,
  stmtDoWhileBody,
  stmtDoWhileTest,
  stmtEnumEnum,
  stmtExportDefaultExpr,
  stmtExportAssignExpr,
  stmtExportNamedExport,
  stmtExportStarAlias,
  stmtExportStarAliasPos,
  stmtFnFn,
  stmtForBody,
  stmtForInit,
  stmtForInBody,
  stmtForInExpr,
  stmtForInLeft,
  stmtForOfBody,
  stmtForOfExpr,
  stmtForOfLeft,
  stmtForTest,
  stmtForUpdate,
  stmtIfNo,
  stmtIfTest,
  stmtIfYes,
  stmtImportAttributes,
  stmtImportEqualsImportEquals,
  stmtImportImport,
  stmtInterfaceInterface,
  stmtIsExported,
  stmtIsWith,
  stmtLabel,
  stmtLabelPos,
  stmtLabeledBody,
  stmtModuleModule,
  stmtModuleSpecifierSpan,
  stmtNamespaceExportName,
  stmtNamespaceExportNamePos,
  stmtReturnExpr,
  stmtSpan,
  stmtSpanWithoutExport,
  stmtSwitchCasesLen,
  stmtSwitchCasesStart,
  stmtSwitchExpr,
  stmtTag,
  stmtThrowExpr,
  stmtTryBlock,
  stmtTryFinalizer,
  stmtTryHandler,
  stmtTryParam,
  stmtTypeAliasAlias,
  stmtVarDeclsLen,
  stmtVarDeclsStart,
  stmtWhileBody,
  stmtWhileTest,
  stmtWithBody,
  stmtWithObject,
  stmtExprExpr,
  tupleElemIsOptional,
  tupleElemIsRest,
  tupleElemName,
  tupleElemNamePos,
  tupleElemSpan,
  tupleElemTy,
  typeAnnotationSpan,
  typeArrayElem,
  typeCondCheck,
  typeCondExtends,
  typeCondNo,
  typeCondYes,
  typeEnd,
  typeFnFn,
  typeHeritageArgsLen,
  typeHeritageArgsStart,
  typeHeritageExpr,
  typeImportArgsLen,
  typeImportArgsStart,
  typeImportAttributes,
  typeImportFlags,
  typeImportNameLen,
  typeImportNameStart,
  typeImportSourceSpan,
  typeImportSpan,
  typeIndexedAccessIndex,
  typeIndexedAccessObj,
  typeInferParam,
  typeIntersectionTypesLen,
  typeIntersectionTypesStart,
  typeKeyofTy,
  typeListAngleBrackets,
  typeMappedMapped,
  typeObjectMembersLen,
  typeObjectMembersStart,
  typeOuterSpan,
  typeParamConstraint,
  typeParamDefault,
  typeParamListAngleBrackets,
  typeParamName,
  typeParamNamePos,
  typeParamSpan,
  typePredicateParamAtom,
  typePredicateParamPos,
  typePredicateTy,
  typeReadonlyTy,
  typeRefArgsLen,
  typeRefArgsStart,
  typeRefNameLen,
  typeRefNameStart,
  typeSpan,
  typeStart,
  typeTag,
  typeTemplateQuasiCount,
  typeTemplateQuasiSpan,
  typeTemplateTypesLen,
  typeTemplateTypesStart,
  typeTupleElemsLen,
  typeTupleElemsStart,
  typeTypeofArgsLen,
  typeTypeofArgsStart,
  typeTypeofExpr,
  typeUnionTypesLen,
  typeUnionTypesStart,
  typeUniqueSymbolKeywordSpan,
  typeUniqueTy,
  varDeclBindingSpan,
  varDeclInit,
  varDeclPat,
  varDeclSpan,
  varDeclTy,
} from "../lint/ast/index.ts";

/** `u32::MAX`: "no position". */

// ───────────────────────────── the tree that Prettier sees ─────────────────────────────

// The kinds of `Item`. The payload (`a`, `b`, `c`, `d`) is what the variant of the Rust enum holds; `-1` for nothing.
/** A leaf. */
const K_LEAF: number = 0;
/** A leaf that Prettier does not print, so that it does not learn where it ends up: the second name of `import { a }`. */
const K_UNMARKED_LEAF: number = 1;
/** Text in the JSX element that starts at `a`. */
const K_JSX_TEXT: number = 2;
/** The name of a property or a member, which is a leaf. */
const K_NAME: number = 3;
/** Its only child is a leaf: the span `(a, b)`. */
const K_LEAF_IN: number = 4;
/** Its children are two leaves: `(a, b)` and `(c, d)`. */
const K_LEAVES: number = 5;
const K_PROGRAM: number = 6;
/** `a`: the ExprId. */
const K_EXPR: number = 7;
/** Without the `ChainExpression` around it. */
const K_CHAIN_ELEMENT: number = 8;
/** A `ParenthesizedExpression`: of those around the expression `a`, the one that is in `b` of them. */
const K_PARENTHESIZED: number = 9;
/** The `LogicalExpression` of the left side of `a` and `b` of the operands in the right side. */
const K_LOGICAL: number = 10;
/** The left side of a binary expression that is written as one list of operands with it. */
const K_FLATTENED_OPERAND: number = 11;
/** `x!!`: the `TSNonNullExpression` of `a` that has `b` others in it. */
const K_NON_NULL: number = 12;
/** With its `export`: `a` is the StmtId. */
const K_STMT: number = 13;
/** Without its `export`. */
const K_DECLARATION: number = 14;
/** The list `(a, b)` of statements. */
const K_STATEMENTS: number = 15;
const K_CATCH_CLAUSE: number = 16;
const K_CASE: number = 17;
const K_VAR_DECL: number = 18;
/** `a`: the FnId, `b`: has_name (not for a method, whose name is the key). */
const K_FUNC: number = 19;
const K_CLASS_BODY: number = 20;
const K_MEMBER: number = 21;
const K_PROP: number = 22;
const K_IMPORT_ATTRIBUTE: number = 23;
const K_DECORATOR: number = 24;
/** `TSParameterProperty` */
const K_PARAMETER_PROPERTY: number = 25;
/** `AssignmentPattern` or `RestElement` of a parameter. */
const K_PARAMETER_PATTERN: number = 26;
/** A pattern `a` with the type `b` (-1) that is part of it in ESTree, and the parameter `c` (-1) whose decorators are. */
const K_BINDING: number = 27;
/** `AssignmentPattern`: the pattern `a` and the default `b`. */
const K_PATTERN_WITH_DEFAULT: number = 28;
/** `RestElement` */
const K_REST_PATTERN: number = 29;
const K_PAT_PROP: number = 30;
const K_TYPE: number = 31;
const K_TYPE_ANNOTATION: number = 32;
/** The list `(a, b)` of type parameters. */
const K_TYPE_PARAMS: number = 33;
/** The list `(a, b)` of type arguments. */
const K_TYPE_ARGS: number = 34;
const K_TYPE_PARAM: number = 35;
/** `TSImportType`, without the `typeof` before it. */
const K_IMPORT_TYPE: number = 36;
const K_TUPLE_ELEM: number = 37;
/** `TSNamedTupleMember`, without the `...` before it. */
const K_NAMED_TUPLE_MEMBER: number = 38;
/** The first `c` names of the entity name `(a, b)` (`A.B.C`). */
const K_ENTITY_NAME: number = 39;
/** The first `b` names of `namespace A.B.C` (module `a`). */
const K_MODULE_NAME: number = 40;
const K_INTERFACE_BODY: number = 41;
const K_ENUM_BODY: number = 42;
const K_ENUM_MEMBER: number = 43;
/** `a`: the ExprId of the element. */
const K_JSX_OPENING: number = 44;
const K_JSX_CLOSING: number = 45;
const K_JSX_CONTAINER: number = 46;

/** A node of ESTree: Prettier's `locStart` and `locEnd` of it, and what tells its children. */
class Item {
  start: number;
  end: number;
  kind: number;
  a: number;
  b: number;
  c: number;
  d: number;
  constructor(start: number, end: number, kind: number, a: number, b: number, c: number, d: number) {
    this.start = start;
    this.end = end;
    this.kind = kind;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
  }
}

function leaf(start: number, end: number): Item {
  return new Item(start, end, K_LEAF, -1, -1, -1, -1);
}
function unmarkedLeaf(start: number, end: number): Item {
  return new Item(start, end, K_UNMARKED_LEAF, -1, -1, -1, -1);
}
function itemOf(start: number, end: number, kind: number, a: number, b: number, c: number): Item {
  return new Item(start, end, kind, a, b, c, -1);
}
/** The leaf at `SP`. */
function leafSp(): Item {
  const SP$ = SP;
  return leaf(SP$.s0 | 0, SP$.s1 | 0);
}
/** The leaf of the Ident `(atom, pos)`. */
function leafIdent(atom: number, pos: number): Item {
  identSpan(atom, pos);
  const SP$ = SP;
  return leaf(SP$.s0 | 0, SP$.s1 | 0);
}

/** What the walk needs to know besides the tree: whether Prettier reads the file with Babel (else with typescript-estree). */
class WalkState {
  isBabel: boolean = false;
}
const ws = new WalkState();

function textLen(): number {
  return hir.sourceLen | 0;
}

/** Prettier's `__contentEnd`: `end`, or if a `;` is before it, where what is before that ends. */
function contentEnd(end: number): number {
  const hir$ = hir;
  if (end >= 1 && end - 1 < textLen() && (hir$.text[end - 1] | 0) === 59) return skipTriviaBack(hir$.text, textLen(), end - 1);
  return end;
}

/** Prettier's `locEnd` of a statement. `isExport`: of the `export` around it. */
function statementEnd(statement0: number, isExport: boolean): number {
  let statement = statement0;
  const SP$ = SP;
  if (isExport) {
    stmtSpan(statement);
    return contentEnd(SP$.s1 | 0);
  }
  while (true) {
    stmtSpan(statement);
    const spanEnd = SP$.s1 | 0;
    switch (stmtTag(statement)) {
      case STMT_IF: {
        const no = stmtIfNo(statement);
        statement = no >= 0 ? no : stmtIfYes(statement);
        break;
      }
      case STMT_FOR:
        statement = stmtForBody(statement);
        break;
      case STMT_FOR_IN:
        statement = stmtForInBody(statement);
        break;
      case STMT_FOR_OF:
        statement = stmtForOfBody(statement);
        break;
      case STMT_WHILE:
        statement = stmtWhileBody(statement);
        break;
      case STMT_LABELED:
        statement = stmtLabeledBody(statement);
        break;
      case STMT_BLOCK:
        if (!stmtIsWith(statement)) return spanEnd;
        statement = stmtWithBody(statement);
        break;
      case STMT_EXPR:
      case STMT_IMPORT:
      case STMT_EXPORT_NAMED:
      case STMT_EXPORT_STAR:
      case STMT_EXPORT_DEFAULT:
      case STMT_RETURN:
      case STMT_THROW:
      case STMT_DO_WHILE:
      case STMT_BREAK:
      case STMT_CONTINUE:
      case STMT_DEBUGGER:
        return contentEnd(spanEnd);
      case STMT_VAR: {
        const n = stmtVarDeclsLen(statement);
        if (n === 0) return spanEnd;
        varDeclSpan(listAt(stmtVarDeclsStart(statement), n - 1));
        return SP$.s1 | 0;
      }
      default:
        return spanEnd;
    }
  }
}

function statement(s: number): Item {
  const isExport = stmtIsExported(s);
  stmtSpan(s);
  const start = SP.s0 | 0;
  return itemOf(start, statementEnd(s, isExport), K_STMT, s, -1, -1);
}

/** What is in the head of a `for`: a declaration, or an expression. */
function head(s: number): Item {
  if (stmtTag(s) === STMT_EXPR) return expr(stmtExprExpr(s));
  return statement(s);
}

function expr(e: number): Item {
  const kept = keptParentheses(e);
  if (kept.length > 0) return itemOf(kept[0], kept[1], K_PARENTHESIZED, e, 1, -1);
  exprSpan(e);
  const SP$ = SP;
  return itemOf(SP$.s0 | 0, SP$.s1 | 0, K_EXPR, e, -1, -1);
}

/**
 * The parentheses around `e` that are a `ParenthesizedExpression` for Prettier, the outermost first: those of Babel's tree that a type
 * cast comment is before. Pairs `(start, end)`.
 */
function keptParentheses(e: number): number[] {
  const kept: number[] = [];
  if (!ws.isBabel || !exprIsParenthesized(e)) return kept;
  const text = hir.text;
  const len = textLen();
  exprOuterSpan(e);
  const SP$ = SP;
  const outerStart = SP$.s0 | 0;
  exprSpan(e);
  let innerStart = SP$.s0 | 0;
  let innerEnd = SP$.s1 | 0;
  while (innerStart > outerStart) {
    const back = skipTriviaBack(text, len, innerStart);
    const open = back > 0 ? back - 1 : 0;
    const close = skipTrivia(text, len, innerEnd);
    if (open >= len || close >= len || (text[open] | 0) !== 40 || (text[close] | 0) !== 41) break;
    innerStart = open;
    innerEnd = close + 1;
    if (isAfterTypeCastComment(open)) {
      kept.push(innerStart);
      kept.push(innerEnd);
    }
  }
  // reverse the pairs
  const out: number[] = [];
  for (let i = kept.length - 2; i >= 0; i -= 2) {
    out.push(kept[i]);
    out.push(kept[i + 1]);
  }
  return out;
}

/** Whether there is a comment before `at`, with nothing but blanks between them, for which Prettier's `isTypeCastComment` holds. */
function isAfterTypeCastComment(at: number): boolean {
  const text = hir.text;
  const len = textLen();
  let rest = skipTriviaBack(text, len, at);
  const end = at;
  let lastStart = -1;
  let lastEnd = -1;
  while (rest < end) {
    const b = text[rest] | 0;
    if (b === 47 && rest + 1 < end && (text[rest + 1] | 0) === 42) {
      const after = rest + 2;
      let close = -1;
      for (let i = after; i + 1 < end; i++) {
        if ((text[i] | 0) === 42 && (text[i + 1] | 0) === 47) {
          close = i;
          break;
        }
      }
      if (close >= 0) {
        lastStart = after;
        lastEnd = close;
        rest = close + 2;
      } else {
        lastStart = -1;
        lastEnd = -1;
        rest = end;
      }
    } else if (b === 47 && rest + 1 < end && (text[rest + 1] | 0) === 47) {
      lastStart = -1;
      lastEnd = -1;
      let i = rest + 2;
      while (i < end && (text[i] | 0) !== 13 && (text[i] | 0) !== 10) i = i + 1;
      rest = i;
    } else rest = rest + 1;
  }
  if (lastStart < 0) return false;
  return lastEnd > lastStart && (text[lastStart] | 0) === 42 && isTypeCastText(text, lastStart, lastEnd);
}

/** `a && (b && c)` is `(a && b) && c` for Prettier (`rebalanceLogicalTree`). The operands that are in the right side of `e`, if that has the operator of `e`. */
function operandsInRightSide(e: number): number[] {
  const operands: number[] = [];
  if (exprTag(e) !== EXPR_BINARY) return operands;
  const op = exprBinaryOp(e);
  const right = exprBinaryRight(e);
  if (!(op === BIN_AND || op === BIN_OR || op === BIN_NULLISH) || !isSameOp(right, op)) return operands;
  const stack: number[] = [];
  stack.push(right);
  while (stack.length > 0) {
    const at = (stack.pop() as number) | 0;
    if (isSameOp(at, op)) {
      stack.push(exprBinaryRight(at));
      stack.push(exprBinaryLeft(at));
    } else operands.push(at);
  }
  return operands;
}

function isSameOp(e: number, op: number): boolean {
  return exprTag(e) === EXPR_BINARY && exprBinaryOp(e) === op;
}

/** What is in the `LogicalExpression` of the left side of `e` and the first `count` of `operands`. */
function logicalParts(e: number, operands: number[], count: number, out: Item[]): void {
  if (exprTag(e) !== EXPR_BINARY || count < 1 || count - 1 >= operands.length) return;
  const op = exprBinaryOp(e);
  const left = exprBinaryLeft(e);
  const last = operands[count - 1] | 0;
  if (count >= 2) {
    const beforeLast = operands[count - 2] | 0;
    const s = exprStart(left);
    out.push(itemOf(s, exprEnd(beforeLast), K_LOGICAL, e, count - 1, -1));
  } else out.push(leftOperand(op, left));
  out.push(expr(last));
}

/** `left`, which is the left side of a binary expression with the operator `op`. */
function leftOperand(op: number, left: number): Item {
  const item = expr(left);
  if (item.kind === K_EXPR && exprTag(left) === EXPR_BINARY) {
    const leftOp = exprBinaryOp(left);
    if (leftOp !== BIN_COMMA && shouldFlatten(op, leftOp)) return itemOf(item.start, item.end, K_FLATTENED_OPERAND, left, -1, -1);
  }
  return item;
}

function ty(t0: number): Item {
  const t = withoutLoneOperator(t0);
  typeSpan(t);
  const SP$ = SP;
  return itemOf(SP$.s0 | 0, SP$.s1 | 0, K_TYPE, t, -1, -1);
}

function typeAnnotation(t: number): Item {
  typeAnnotationSpan(t);
  const SP$ = SP;
  return itemOf(SP$.s0 | 0, SP$.s1 | 0, K_TYPE_ANNOTATION, t, -1, -1);
}

function typeParams(start: number, len: number, out: Item[]): void {
  const SP$ = SP;
  if (typeParamListAngleBrackets(start, len)) out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_TYPE_PARAMS, start, len, -1));
}

function typeArgs(start: number, len: number, out: Item[]): void {
  const SP$ = SP;
  if (typeListAngleBrackets(start, len)) out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_TYPE_ARGS, start, len, -1));
}

/** The first `count` names of the entity name `(start, len)`, or null. */
function entityName(start: number, len: number, count: number): Item | null {
  if (len <= 0 || count < 1 || count > len) return null;
  identSpan(entityAtom(start, 0), entityPos(start, 0));
  const SP$ = SP;
  const firstStart = SP$.s0 | 0;
  const firstEnd = SP$.s1 | 0;
  if (count === 1) return leaf(firstStart, firstEnd);
  identSpan(entityAtom(start, count - 1), entityPos(start, count - 1));
  return itemOf(firstStart, SP$.s1 | 0, K_ENTITY_NAME, start, len, count);
}

function pushEntityName(start: number, len: number, count: number, out: Item[]): void {
  const it = entityName(start, len, count);
  if (it !== null) out.push(it);
}

/** The module that the name at `index` of `namespace A.B.C` is the name of, or -1. */
function nestedModule(module: number, index: number): number {
  let at = module;
  for (let i = 0; i < index; i++) {
    at = moduleNested(at);
    if (at < 0) return -1;
  }
  return at;
}

function moduleName(module: number, count: number): Item | null {
  if (count < 1) return null;
  const last = nestedModule(module, count - 1);
  if (last < 0) return null;
  moduleNameSpan(module);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const e = SP$.s1 | 0;
  if (count === 1) return leaf(s, e);
  moduleNameSpan(last);
  return itemOf(s, SP$.s1 | 0, K_MODULE_NAME, module, count, -1);
}

/** The name of a property or a member (its owner `owner`, a Node). */
function key(owner: number): Item {
  const kind = keyKind(owner);
  const expr0 = kind === KEY_COMPUTED ? keyExpr(owner) : -1;
  const isJsx = keyIsJsx(owner);
  let s = 0;
  let e = 0;
  const SP$ = SP;
  if (keyInnerSpan(owner)) {
    s = SP$.s0 | 0;
    e = SP$.s1 | 0;
  }
  if (kind === KEY_COMPUTED) return expr(expr0);
  if (kind === KEY_PRIVATE) return privateName(s, e);
  if (isJsx) return jsxName(s, e);
  return itemOf(s, e, K_NAME, -1, -1, -1);
}

/** Babel has an `Identifier` in a `PrivateName`. */
function privateName(s: number, e: number): Item {
  if (ws.isBabel) return new Item(s, e, K_LEAF_IN, s + 1, e, -1, -1);
  return leaf(s, e);
}

/** `a`, `a-b`, or `a:b`, which is a `JSXNamespacedName`. */
function jsxName(s: number, e: number): Item {
  const SP$ = SP;
  if (jsxNamespaceAndName(s)) return new Item(s, e, K_LEAVES, SP$.s0 | 0, SP$.s1 | 0, SP$.s2 | 0, SP$.s3 | 0);
  return leaf(s, e);
}

function decorators(modsStart: number, modsLen: number, out: Item[]): void {
  const SP$ = SP;
  for (let i = 0; i < modsLen; i++) {
    const m = listAt(modsStart, i);
    const d = modifierDecorator(m);
    if (d >= 0) {
      modifierSpan(m);
      out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_DECORATOR, d, -1, -1));
    }
  }
}

/** Prettier's `locStart`: a node starts with its first decorator. `start`: where it starts without. */
function startWithDecorators(start: number, modsStart: number, modsLen: number): number {
  const SP$ = SP;
  for (let i = 0; i < modsLen; i++) {
    const m = listAt(modsStart, i);
    if (modifierDecorator(m) >= 0) {
      modifierSpan(m);
      const s = SP$.s0 | 0;
      return s < start ? s : start;
    }
  }
  return start;
}

function binding(pat: number, t: number, s: number, e: number): Item {
  return itemOf(s, e, K_BINDING, pat, t, -1);
}

function pattern(pat: number): Item {
  patSpan(pat);
  const SP$ = SP;
  return binding(pat, -1, SP$.s0 | 0, SP$.s1 | 0);
}

function param(p: number): Item {
  const n = paramModifiersLen(p);
  const ms = paramModifiersStart(p);
  let hasKeyword = false;
  for (let i = 0; i < n; i++) if (modifierDecorator(listAt(ms, i)) < 0) hasKeyword = true;
  const SP$ = SP;
  if (hasKeyword) {
    paramSpan(p);
    return itemOf(startWithDecorators(SP$.s0 | 0, ms, n), SP$.s1 | 0, K_PARAMETER_PROPERTY, p, -1, -1);
  }
  const inner = paramWithoutModifiers(p);
  const start = startWithDecorators(inner.start, ms, n);
  if (inner.kind === K_BINDING) return itemOf(start, inner.end, K_BINDING, inner.a, inner.b, p);
  return new Item(start, inner.end, inner.kind, inner.a, inner.b, inner.c, inner.d);
}

function paramWithoutModifiers(p: number): Item {
  const SP$ = SP;
  if (paramIsRest(p) || paramDefault(p) >= 0) {
    paramSpanWithoutModifiers(p);
    return itemOf(SP$.s0 | 0, SP$.s1 | 0, K_PARAMETER_PATTERN, p, -1, -1);
  }
  paramBindingSpan(p);
  return binding(paramPat(p), paramTy(p), SP$.s0 | 0, SP$.s1 | 0);
}

function functionParts(func: number, hasName: boolean, out: Item[]): void {
  if (hasName) {
    const name = funcName(func);
    if (name >= 0) out.push(leafIdent(name, funcNamePos(func)));
  }
  typeParams(funcTypeParamsStart(func), funcTypeParamsLen(func), out);
  const thisParam = funcThisParam(func);
  if (thisParam >= 0) out.push(param(thisParam));
  const ps = funcParamsStart(func);
  const pn = funcParamsLen(func);
  for (let i = 0; i < pn; i++) out.push(param(listAt(ps, i)));
  const ret = funcReturnType(func);
  if (ret >= 0) out.push(typeAnnotation(ret));
  const bk = funcBodyKind(func);
  const SP$ = SP;
  if (bk === BODY_EXPR) out.push(expr(funcBodyExpr(func)));
  else if (bk === BODY_BLOCK) {
    if (funcBodySpan(func)) out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_STATEMENTS, funcBodyStmtsStart(func), funcBodyStmtsLen(func), -1));
  }
}

/** The function of a method. In Babel's tree its parts are in the method itself. */
function methodValue(func: number, out: Item[]): void {
  const SP$ = SP;
  if (ws.isBabel) functionParts(func, false, out);
  else {
    funcSpanFromParams(func);
    out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_FUNC, func, 0, -1));
  }
}

function classParts(cls: number, out: Item[]): void {
  decorators(classModifiersStart(cls), classModifiersLen(cls), out);
  const name = className(cls);
  if (name >= 0) out.push(leafIdent(name, classNamePos(cls)));
  typeParams(classTypeParamsStart(cls), classTypeParamsLen(cls), out);
  const ext = classExtends(cls);
  if (ext >= 0) out.push(expr(ext));
  typeArgs(classExtendsArgsStart(cls), classExtendsArgsLen(cls), out);
  const is = classImplementsStart(cls);
  const n = classImplementsLen(cls);
  for (let i = 0; i < n; i++) out.push(ty(listAt(is, i)));
  classBodySpan(cls);
  const SP$ = SP;
  out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_CLASS_BODY, cls, -1, -1));
}

function member(m: number): Item {
  memberSpan(m);
  const SP$ = SP;
  return itemOf(startWithDecorators(SP$.s0 | 0, memberModifiersStart(m), memberModifiersLen(m)), SP$.s1 | 0, K_MEMBER, m, -1, -1);
}

function memberParts(m: number, out: Item[]): void {
  decorators(memberModifiersStart(m), memberModifiersLen(m), out);
  const owner = nodeOfMember(m);
  let k: Item | null = null;
  if (keyKind(owner) !== KEY_NONE) k = key(owner);
  else {
    const ck = memberConstructorKeyword(m);
    if (ck >= 0) k = leafIdent(ck, memberNamePos(m));
  }
  const kind = memberKind(m);
  const func = memberFunc(m);
  if (func >= 0) {
    if (kind === MEMBER_STATIC_BLOCK) {
      if (funcBodyKind(func) === BODY_BLOCK) {
        const s = funcBodyStmtsStart(func);
        const n = funcBodyStmtsLen(func);
        for (let i = 0; i < n; i++) out.push(statement(listAt(s, i)));
      }
    } else if (kind === MEMBER_INDEX_SIGNATURE || kind === MEMBER_CALL_SIGNATURE || kind === MEMBER_CONSTRUCT_SIGNATURE) {
      functionParts(func, false, out);
    } else if (memberIsSignature(m)) {
      if (k !== null) out.push(k);
      functionParts(func, false, out);
    } else {
      if (k !== null) out.push(k);
      methodValue(func, out);
    }
  } else {
    if (k !== null) out.push(k);
    const t = memberTy(m);
    if (t >= 0) out.push(typeAnnotation(t));
    const init = memberInit(m);
    if (init >= 0) out.push(expr(init));
  }
}

function propParts(p: number, out: Item[]): void {
  const owner = nodeOfProp(p);
  const hasKey = keyKind(owner) !== KEY_NONE;
  const value = propValue(p);
  if (propIsJsxAttribute(p)) {
    if (hasKey) out.push(key(owner));
    if (value >= 0) out.push(jsxChild(value));
    return;
  }
  const kind = propKind(p);
  const func = propFunc(p);
  if (kind === PROP_SPREAD) {
    if (value >= 0) out.push(expr(value));
  } else if ((kind === PROP_METHOD || kind === PROP_GETTER || kind === PROP_SETTER) && func >= 0) {
    if (hasKey) out.push(key(owner));
    methodValue(func, out);
  } else {
    if (hasKey) out.push(key(owner));
    if (value >= 0) out.push(expr(value));
  }
}

/** A child of a JSX element, or the value of an attribute: in braces it is in a `JSXExpressionContainer`. */
function jsxChild(e: number): Item {
  const SP$ = SP;
  if (exprJsxContainerSpan(e)) {
    const s = SP$.s0 | 0;
    const en = SP$.s1 | 0;
    const tag = exprTag(e);
    if (tag === EXPR_SPREAD) return itemOf(s, en, K_EXPR, e, -1, -1);
    // `{}` has a `JSXEmptyExpression` in it.
    if (tag === EXPR_MISSING) return new Item(s, en, K_LEAF_IN, s + 1, en > 1 ? en - 1 : 0, -1, -1);
    return itemOf(s, en, K_JSX_CONTAINER, e, -1, -1);
  }
  return expr(e);
}

function importSpec(spec: number): Item {
  importSpecSpan(spec);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const e = SP$.s1 | 0;
  identSpan(importSpecImported(spec), importSpecImportedPos(spec));
  const a = SP$.s0 | 0;
  const b = SP$.s1 | 0;
  identSpan(importSpecLocal(spec), importSpecLocalPos(spec));
  return new Item(s, e, K_LEAVES, a, b, SP$.s0 | 0, SP$.s1 | 0);
}

function exportSpec(spec: number): Item {
  exportSpecSpan(spec);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const e = SP$.s1 | 0;
  identSpan(exportSpecLocal(spec), exportSpecLocalPos(spec));
  const a = SP$.s0 | 0;
  const b = SP$.s1 | 0;
  identSpan(exportSpecExported(spec), exportSpecExportedPos(spec));
  return new Item(s, e, K_LEAVES, a, b, SP$.s0 | 0, SP$.s1 | 0);
}

function importAttributesOf(s: number, out: Item[]): void {
  const row = stmtImportAttributes(s);
  if (row < 0) return;
  const es = importAttributesEntriesStart(row);
  const n = importAttributesEntriesLen(row);
  const SP$ = SP;
  for (let i = 0; i < n; i++) {
    const p = listAt(es, i);
    propSpan(p);
    out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_IMPORT_ATTRIBUTE, p, -1, -1));
  }
}

function labelOf(s: number, out: Item[]): void {
  const l = stmtLabel(s);
  if (l >= 0) out.push(leafIdent(l, stmtLabelPos(s)));
}

/** The text of a template between its delimiters. `(s, e)`: with them. */
function templateElement(s: number, e: number, isLast: boolean): Item {
  const cut = isLast ? 1 : 2;
  return leaf(s + 1, e > cut ? e - cut : 0);
}

function expressionParts(e: number, out: Item[]): void {
  const SP$ = SP;
  switch (exprTag(e)) {
    case EXPR_MISSING:
    case EXPR_IDENT:
    case EXPR_THIS:
    case EXPR_SUPER:
    case EXPR_NULL:
    case EXPR_TRUE:
    case EXPR_FALSE:
    case EXPR_NUMBER:
    case EXPR_STRING:
    case EXPR_BIG_INT:
    case EXPR_REGEX:
      return;
    case EXPR_PRIVATE_IDENTIFIER: {
      exprSpan(e);
      const it = privateName(SP$.s0 | 0, SP$.s1 | 0);
      if (it.kind === K_LEAF_IN) out.push(leaf(it.a, it.b));
      return;
    }
    case EXPR_IMPORT_META:
    case EXPR_NEW_TARGET:
      if (exprMetaPropertySpans(e)) {
        out.push(leaf(SP$.s0 | 0, SP$.s1 | 0));
        out.push(leaf(SP$.s2 | 0, SP$.s3 | 0));
      }
      return;
    case EXPR_TEMPLATE: {
      const count = exprTemplateQuasiCount(e);
      for (let i = 0; i < count; i++) {
        exprTemplateQuasiSpan(e, i);
        out.push(templateElement(SP$.s0 | 0, SP$.s1 | 0, i + 1 === count));
      }
      const s = exprTemplateExprsStart(e);
      const n = exprTemplateExprsLen(e);
      for (let i = 0; i < n; i++) out.push(expr(listAt(s, i)));
      return;
    }
    case EXPR_TAGGED_TEMPLATE: {
      const call = exprTaggedTemplateCall(e);
      out.push(expr(callCallee(call)));
      typeArgs(callTypeArgsStart(call), callTypeArgsLen(call), out);
      const t = callTemplate(call);
      if (t >= 0) out.push(expr(t));
      return;
    }
    case EXPR_ARRAY: {
      const s = exprArrayElemsStart(e);
      const n = exprArrayElemsLen(e);
      for (let i = 0; i < n; i++) {
        const it = listAt(s, i);
        if (!exprIsMissing(it)) out.push(expr(it));
      }
      return;
    }
    case EXPR_OBJECT: {
      const s = exprObjectPropsStart(e);
      const n = exprObjectPropsLen(e);
      for (let i = 0; i < n; i++) {
        const p = listAt(s, i);
        propSpan(p);
        out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_PROP, p, -1, -1));
      }
      return;
    }
    case EXPR_FN:
      functionParts(exprFnFn(e), true, out);
      return;
    case EXPR_CLASS:
      classParts(exprClassClass(e), out);
      return;
    case EXPR_DOT: {
      out.push(expr(exprDotObj(e)));
      const name = exprDotName(e);
      const pos = exprDotNamePos(e);
      identSpan(name, pos);
      const s = SP$.s0 | 0;
      const en = SP$.s1 | 0;
      const buf = nameBuf(name);
      if ((buf[nameStart(name)] | 0) === 35) out.push(privateName(s, en));
      else out.push(leaf(s, en));
      return;
    }
    case EXPR_INDEX:
      out.push(expr(exprIndexObj(e)));
      out.push(expr(exprIndexIndex(e)));
      return;
    case EXPR_CALL:
    case EXPR_NEW: {
      const call = exprTag(e) === EXPR_CALL ? exprCallCall(e) : exprNewCall(e);
      out.push(expr(callCallee(call)));
      typeArgs(callTypeArgsStart(call), callTypeArgsLen(call), out);
      const s = callArgsStart(call);
      const n = callArgsLen(call);
      for (let i = 0; i < n; i++) out.push(expr(listAt(s, i)));
      return;
    }
    case EXPR_UNARY:
      out.push(expr(exprUnaryOperand(e)));
      return;
    case EXPR_SPREAD:
      out.push(expr(exprSpreadExpr(e)));
      return;
    case EXPR_AWAIT:
      out.push(expr(exprAwaitExpr(e)));
      return;
    // `const` is a `TSTypeReference` with an `Identifier` in it.
    case EXPR_AS_CONST:
      out.push(expr(exprAsConstExpr(e)));
      if (exprConstKeywordSpan(e)) out.push(new Item(SP$.s0 | 0, SP$.s1 | 0, K_LEAF_IN, SP$.s0 | 0, SP$.s1 | 0, -1, -1));
      return;
    case EXPR_NON_NULL:
      nonNullParts(e, exprInnerNonNullCount(e), out);
      return;
    case EXPR_BINARY: {
      const inRight = operandsInRightSide(e);
      if (inRight.length > 0) {
        logicalParts(e, inRight, inRight.length, out);
        return;
      }
      const ops = new I32Vec(8);
      exprSequence(e, ops);
      if (ops.len === 1) out.push(leftOperand(exprBinaryOp(e), exprBinaryLeft(e)));
      if (ops.len === 1) out.push(expr(exprBinaryRight(e)));
      else for (let i = 0; i < ops.len; i++) out.push(expr(ops.data[i] | 0));
      return;
    }
    case EXPR_ASSIGN:
      out.push(expr(exprAssignTarget(e)));
      out.push(expr(exprAssignValue(e)));
      return;
    case EXPR_COND:
      out.push(expr(exprCondTest(e)));
      out.push(expr(exprCondYes(e)));
      out.push(expr(exprCondNo(e)));
      return;
    case EXPR_YIELD: {
      const v = exprYieldValue(e);
      if (v >= 0) out.push(expr(v));
      return;
    }
    case EXPR_AS:
      out.push(expr(exprAsExpr(e)));
      out.push(ty(exprAsTy(e)));
      return;
    case EXPR_SATISFIES:
      out.push(expr(exprSatisfiesExpr(e)));
      out.push(ty(exprSatisfiesTy(e)));
      return;
    case EXPR_INSTANTIATION:
      out.push(expr(exprInstantiationExpr(e)));
      typeArgs(exprInstantiationTypeArgsStart(e), exprInstantiationTypeArgsLen(e), out);
      return;
    case EXPR_JSX:
      jsxParts(e, out);
      return;
    case EXPR_IMPORT_CALL: {
      const s = exprImportCallArgsStart(e);
      const n = exprImportCallArgsLen(e);
      for (let i = 0; i < n; i++) {
        const a = listAt(s, i);
        if (!exprIsMissing(a)) out.push(expr(a));
      }
      return;
    }
    default:
      return;
  }
}

function jsxParts(e: number, out: Item[]): void {
  const isFragment = jsxIsFragment(e);
  jsxOpeningSpan(e);
  const SP$ = SP;
  if (isFragment) out.push(leaf(SP$.s0 | 0, SP$.s1 | 0));
  else out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_JSX_OPENING, e, -1, -1));
  const elementStart = exprStart(e);
  const rows = new I32Vec(24);
  jsxChildrenWithWhitespace(e, rows);
  for (let i = 0; i + 2 < rows.len; i += 3) {
    const kind = rows.data[i] | 0;
    const x = rows.data[i + 1] | 0;
    const y = rows.data[i + 2] | 0;
    if (kind === JC_EXPR) {
      if (exprIsJsxText(x)) {
        exprSpan(x);
        out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_JSX_TEXT, elementStart, -1, -1));
      } else out.push(jsxChild(x));
    } else out.push(itemOf(x, y, K_JSX_TEXT, elementStart, -1, -1));
  }
  if (jsxClosingSpan(e)) {
    if (isFragment) out.push(leaf(SP$.s0 | 0, SP$.s1 | 0));
    else out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_JSX_CLOSING, e, -1, -1));
  }
}

/** What is in the `TSNonNullExpression` of `e` that has `inner` others in it. */
function nonNullParts(e: number, inner: number, out: Item[]): void {
  if (exprTag(e) !== EXPR_NON_NULL) return;
  if (inner >= 1) {
    const row = (exprNonNullEndsFirst(e) + inner - 1) | 0;
    out.push(itemOf(exprStart(e), hir.nonNullEndEnd[row] | 0, K_NON_NULL, e, inner - 1, -1));
  } else out.push(expr(exprNonNullExpr(e)));
}

function jsxTagItem(tag: number, out: Item[]): void {
  if (tag < 0) return;
  const SP$ = SP;
  if (exprTag(tag) === EXPR_DOT) out.push(expr(tag));
  else {
    exprSpan(tag);
    out.push(jsxName(SP$.s0 | 0, SP$.s1 | 0));
  }
}

function declarationParts(s: number, out: Item[]): void {
  const SP$ = SP;
  switch (stmtTag(s)) {
    case STMT_EMPTY:
    case STMT_DEBUGGER:
      return;
    case STMT_BREAK:
    case STMT_CONTINUE:
      labelOf(s, out);
      return;
    // Babel has a `DirectiveLiteral` in a `Directive`, which comes to the same.
    case STMT_EXPR:
      out.push(expr(stmtExprExpr(s)));
      return;
    case STMT_THROW:
      out.push(expr(stmtThrowExpr(s)));
      return;
    case STMT_EXPORT_DEFAULT:
      out.push(expr(stmtExportDefaultExpr(s)));
      return;
    case STMT_EXPORT_ASSIGN:
      out.push(expr(stmtExportAssignExpr(s)));
      return;
    case STMT_RETURN: {
      const r = stmtReturnExpr(s);
      if (r >= 0) out.push(expr(r));
      return;
    }
    case STMT_VAR: {
      const ds = stmtVarDeclsStart(s);
      const n = stmtVarDeclsLen(s);
      for (let i = 0; i < n; i++) {
        const d = listAt(ds, i);
        varDeclSpan(d);
        out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_VAR_DECL, d, -1, -1));
      }
      return;
    }
    case STMT_FN:
      functionParts(stmtFnFn(s), true, out);
      return;
    case STMT_CLASS:
      classParts(stmtClassClass(s), out);
      return;
    case STMT_INTERFACE: {
      const i = stmtInterfaceInterface(s);
      out.push(leafIdent(interfaceName(i), interfaceNamePos(i)));
      typeParams(interfaceTypeParamsStart(i), interfaceTypeParamsLen(i), out);
      const es = interfaceExtendsStart(i);
      const n = interfaceExtendsLen(i);
      for (let k = 0; k < n; k++) out.push(ty(listAt(es, k)));
      interfaceBodySpan(i);
      out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_INTERFACE_BODY, i, -1, -1));
      return;
    }
    case STMT_TYPE_ALIAS: {
      const a = stmtTypeAliasAlias(s);
      out.push(leafIdent(aliasName(a), aliasNamePos(a)));
      typeParams(aliasTypeParamsStart(a), aliasTypeParamsLen(a), out);
      out.push(ty(aliasTy(a)));
      return;
    }
    case STMT_ENUM: {
      const en = stmtEnumEnum(s);
      out.push(leafIdent(enumName(en), enumNamePos(en)));
      enumBodySpan(en);
      out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_ENUM_BODY, en, -1, -1));
      return;
    }
    case STMT_MODULE: {
      const module = stmtModuleModule(s);
      let count = 1;
      let innermost = module;
      while (moduleNested(innermost) >= 0) {
        count = count + 1;
        innermost = moduleNested(innermost);
      }
      const name = moduleName(module, count);
      if (name !== null) out.push(name);
      if (moduleBodySpan(innermost)) {
        out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_STATEMENTS, moduleBodyStart(innermost), moduleBodyLen(innermost), -1));
      }
      return;
    }
    case STMT_IF: {
      out.push(expr(stmtIfTest(s)));
      out.push(statement(stmtIfYes(s)));
      const no = stmtIfNo(s);
      if (no >= 0) out.push(statement(no));
      return;
    }
    case STMT_FOR: {
      const init = stmtForInit(s);
      if (init >= 0) out.push(head(init));
      const test = stmtForTest(s);
      if (test >= 0) out.push(expr(test));
      const update = stmtForUpdate(s);
      if (update >= 0) out.push(expr(update));
      out.push(statement(stmtForBody(s)));
      return;
    }
    case STMT_FOR_IN:
      out.push(head(stmtForInLeft(s)));
      out.push(expr(stmtForInExpr(s)));
      out.push(statement(stmtForInBody(s)));
      return;
    case STMT_FOR_OF:
      out.push(head(stmtForOfLeft(s)));
      out.push(expr(stmtForOfExpr(s)));
      out.push(statement(stmtForOfBody(s)));
      return;
    // The order of Prettier's visitor keys.
    case STMT_WHILE:
      out.push(statement(stmtWhileBody(s)));
      out.push(expr(stmtWhileTest(s)));
      return;
    case STMT_DO_WHILE:
      out.push(statement(stmtDoWhileBody(s)));
      out.push(expr(stmtDoWhileTest(s)));
      return;
    case STMT_BLOCK: {
      if (stmtIsWith(s)) {
        out.push(expr(stmtWithObject(s)));
        out.push(statement(stmtWithBody(s)));
        return;
      }
      const bs = stmtBlockStmtsStart(s);
      const n = stmtBlockStmtsLen(s);
      for (let i = 0; i < n; i++) out.push(statement(listAt(bs, i)));
      return;
    }
    case STMT_SWITCH: {
      out.push(expr(stmtSwitchExpr(s)));
      const cs = stmtSwitchCasesStart(s);
      const n = stmtSwitchCasesLen(s);
      for (let i = 0; i < n; i++) {
        const c = listAt(cs, i);
        caseSpan(c);
        out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_CASE, c, -1, -1));
      }
      return;
    }
    case STMT_TRY: {
      out.push(statement(stmtTryBlock(s)));
      if (stmtCatchClauseSpan(s)) out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_CATCH_CLAUSE, s, -1, -1));
      const fin = stmtTryFinalizer(s);
      if (fin >= 0) out.push(statement(fin));
      return;
    }
    case STMT_LABELED:
      labelOf(s, out);
      out.push(statement(stmtLabeledBody(s)));
      return;
    case STMT_IMPORT: {
      const imp = stmtImportImport(s);
      const d = importDefault(imp);
      if (d >= 0) {
        identSpan(d, importDefaultPos(imp));
        out.push(new Item(SP$.s0 | 0, SP$.s1 | 0, K_LEAF_IN, SP$.s0 | 0, SP$.s1 | 0, -1, -1));
      }
      if (importNamespaceSpan(imp) && importNamespace(imp) >= 0) {
        const ns = SP$.s0 | 0;
        const ne = SP$.s1 | 0;
        identSpan(importNamespace(imp), importNamespacePos(imp));
        out.push(new Item(ns, ne, K_LEAF_IN, SP$.s0 | 0, SP$.s1 | 0, -1, -1));
      }
      const ns2 = importNamedStart(imp);
      const nn = importNamedLen(imp);
      for (let i = 0; i < nn; i++) out.push(importSpec(listAt(ns2, i)));
      if (importSpecSpanOf(imp)) out.push(leafSp());
      importAttributesOf(s, out);
      return;
    }
    case STMT_EXPORT_NAMED: {
      const x = stmtExportNamedExport(s);
      const is = exportItemsStart(x);
      const n = exportItemsLen(x);
      for (let i = 0; i < n; i++) out.push(exportSpec(listAt(is, i)));
      if (exportSpecSpanOf(x)) out.push(leafSp());
      importAttributesOf(s, out);
      return;
    }
    case STMT_EXPORT_STAR: {
      const alias = stmtExportStarAlias(s);
      if (alias >= 0 && ws.isBabel) {
        // In Babel's tree, `* as a` is an `ExportNamespaceSpecifier`.
        stmtSpan(s);
        const star = skipTrivia(hir.text, textLen(), (SP$.s0 | 0) + 6);
        identSpan(alias, stmtExportStarAliasPos(s));
        const aliasStart = SP$.s0 | 0;
        const aliasEnd = SP$.s1 | 0;
        out.push(new Item(star, aliasEnd, K_LEAF_IN, aliasStart, aliasEnd, -1, -1));
        if (stmtModuleSpecifierSpan(s)) out.push(leafSp());
        importAttributesOf(s, out);
        return;
      }
      if (stmtModuleSpecifierSpan(s)) out.push(leafSp());
      importAttributesOf(s, out);
      if (alias >= 0) out.push(leafIdent(alias, stmtExportStarAliasPos(s)));
      return;
    }
    case STMT_IMPORT_EQUALS: {
      const imp = stmtImportEqualsImportEquals(s);
      out.push(leafIdent(importEqualsName(imp), importEqualsNamePos(imp)));
      if (importEqualsTargetKind(imp) === IET_ENTITY) {
        pushEntityName(importEqualsEntityStart(imp), importEqualsEntityLen(imp), importEqualsEntityLen(imp), out);
      } else if (importEqualsRequireSpan(imp)) {
        const rs = SP$.s0 | 0;
        const re = SP$.s1 | 0;
        if (stmtModuleSpecifierSpan(s)) out.push(new Item(rs, re, K_LEAF_IN, SP$.s0 | 0, SP$.s1 | 0, -1, -1));
      }
      return;
    }
    case STMT_EXPORT_AS_NAMESPACE: {
      const n = stmtNamespaceExportName(s);
      if (n >= 0) out.push(leafIdent(n, stmtNamespaceExportNamePos(s)));
      return;
    }
    default:
      return;
  }
}

function typeText(t: number): number {
  return hir.text[typeStart(t)] | 0;
}

function typeParts(t: number, out: Item[]): void {
  typeSpan(t);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const e = SP$.s1 | 0;
  switch (typeTag(t)) {
    case TYPE_ERROR:
    case TYPE_JSDOC:
    case TYPE_KEYWORD:
      return;
    case TYPE_STRING_LIT:
      // A `TSLiteralType` with the literal in it.
      if (typeText(t) === 96) out.push(new Item(s, e, K_LEAF_IN, s + 1, e > 1 ? e - 1 : 0, -1, -1));
      else out.push(leaf(s, e));
      return;
    case TYPE_BOOL_LIT:
      out.push(leaf(s, e));
      return;
    case TYPE_NUMBER_LIT:
    case TYPE_BIG_INT_LIT:
      if (typeText(t) === 45) {
        out.push(new Item(s, e, K_LEAF_IN, skipTrivia(hir.text, textLen(), s + 1), e, -1, -1));
      } else out.push(leaf(s, e));
      return;
    case TYPE_HERITAGE:
      out.push(expr(typeHeritageExpr(t)));
      typeArgs(typeHeritageArgsStart(t), typeHeritageArgsLen(t), out);
      return;
    case TYPE_TYPEOF:
      out.push(expr(typeTypeofExpr(t)));
      typeArgs(typeTypeofArgsStart(t), typeTypeofArgsLen(t), out);
      return;
    case TYPE_REF:
      pushEntityName(typeRefNameStart(t), typeRefNameLen(t), typeRefNameLen(t), out);
      typeArgs(typeRefArgsStart(t), typeRefArgsLen(t), out);
      return;
    case TYPE_IMPORT:
      if ((typeImportFlags(t) & 1) !== 0) {
        if (typeImportSpan(t)) out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_IMPORT_TYPE, t, -1, -1));
      } else importTypeParts(t, out);
      return;
    case TYPE_TEMPLATE: {
      const count = typeTemplateQuasiCount(t);
      for (let i = 0; i < count; i++) {
        typeTemplateQuasiSpan(t, i);
        out.push(templateElement(SP$.s0 | 0, SP$.s1 | 0, i + 1 === count));
      }
      const ts = typeTemplateTypesStart(t);
      const n = typeTemplateTypesLen(t);
      for (let i = 0; i < n; i++) out.push(ty(listAt(ts, i)));
      return;
    }
    case TYPE_UNION: {
      const ts = typeUnionTypesStart(t);
      const n = typeUnionTypesLen(t);
      for (let i = 0; i < n; i++) out.push(ty(listAt(ts, i)));
      return;
    }
    case TYPE_INTERSECTION: {
      const ts = typeIntersectionTypesStart(t);
      const n = typeIntersectionTypesLen(t);
      for (let i = 0; i < n; i++) out.push(ty(listAt(ts, i)));
      return;
    }
    case TYPE_ARRAY:
      out.push(ty(typeArrayElem(t)));
      return;
    case TYPE_KEYOF:
      out.push(ty(typeKeyofTy(t)));
      return;
    case TYPE_READONLY:
      out.push(ty(typeReadonlyTy(t)));
      return;
    case TYPE_UNIQUE:
      out.push(ty(typeUniqueTy(t)));
      return;
    case TYPE_UNIQUE_SYMBOL:
      if (typeUniqueSymbolKeywordSpan(t)) out.push(leafSp());
      return;
    case TYPE_TUPLE: {
      const ts = typeTupleElemsStart(t);
      const n = typeTupleElemsLen(t);
      for (let i = 0; i < n; i++) out.push(tupleElement(listAt(ts, i)));
      return;
    }
    case TYPE_FN:
      functionParts(typeFnFn(t), false, out);
      return;
    case TYPE_OBJECT: {
      const ms = typeObjectMembersStart(t);
      const n = typeObjectMembersLen(t);
      for (let i = 0; i < n; i++) out.push(member(listAt(ms, i)));
      return;
    }
    case TYPE_COND:
      out.push(ty(typeCondCheck(t)));
      out.push(ty(typeCondExtends(t)));
      out.push(ty(typeCondYes(t)));
      out.push(ty(typeCondNo(t)));
      return;
    case TYPE_INFER: {
      const p = typeInferParam(t);
      typeParamSpan(p);
      out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_TYPE_PARAM, p, -1, -1));
      return;
    }
    case TYPE_MAPPED: {
      const m = typeMappedMapped(t);
      const p = mappedParam(m);
      out.push(leafIdent(typeParamName(p), typeParamNamePos(p)));
      const c = typeParamConstraint(p);
      if (c >= 0) out.push(ty(c));
      const nt = mappedNameTy(m);
      if (nt >= 0) out.push(ty(nt));
      const mt = mappedTy(m);
      if (mt >= 0) out.push(ty(mt));
      return;
    }
    case TYPE_INDEXED_ACCESS:
      out.push(ty(typeIndexedAccessObj(t)));
      out.push(ty(typeIndexedAccessIndex(t)));
      return;
    case TYPE_PREDICATE: {
      const pa = typePredicateParamAtom(t);
      if (pa >= 0) out.push(leafIdent(pa, typePredicateParamPos(t)));
      // This `TSTypeAnnotation` has no `:`.
      const asserted = typePredicateTy(t);
      if (asserted >= 0) {
        typeOuterSpan(asserted);
        out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_TYPE_ANNOTATION, asserted, -1, -1));
      }
      return;
    }
    default:
      return;
  }
}

function importTypeParts(t: number, out: Item[]): void {
  if (typeTag(t) !== TYPE_IMPORT) return;
  if (typeImportSourceSpan(t)) out.push(leafSp());
  const row = typeImportAttributes(t);
  if (row >= 0) {
    importAttributesOptionsSpan(row);
    out.push(leafSp());
  }
  pushEntityName(typeImportNameStart(t), typeImportNameLen(t), typeImportNameLen(t), out);
  typeArgs(typeImportArgsStart(t), typeImportArgsLen(t), out);
}

function tupleElement(el: number): Item {
  const SP$ = SP;
  if (tupleElemName(el) >= 0 || tupleElemIsRest(el) || tupleElemIsOptional(el)) {
    tupleElemSpan(el);
    return itemOf(SP$.s0 | 0, SP$.s1 | 0, K_TUPLE_ELEM, el, -1, -1);
  }
  return ty(tupleElemTy(el));
}

/** Appends the children of `item` to `out`, in the order of Prettier's visitor keys. */
function children(item: Item, out: Item[]): void {
  const SP$ = SP;
  switch (item.kind) {
    case K_LEAF:
    case K_UNMARKED_LEAF:
    case K_JSX_TEXT:
    case K_NAME:
      return;
    case K_LEAF_IN:
      out.push(leaf(item.a, item.b));
      return;
    // Of a name that stands for two, the first is printed.
    case K_LEAVES:
      if (item.a === item.c && item.b === item.d) {
        out.push(leaf(item.a, item.b));
        out.push(unmarkedLeaf(item.c, item.d));
      } else {
        out.push(leaf(item.a, item.b));
        out.push(leaf(item.c, item.d));
      }
      return;
    case K_PROGRAM: {
      const s = fileBodyStart();
      const n = fileBodyLen();
      for (let i = 0; i < n; i++) out.push(statement(listAt(s, i)));
      return;
    }
    case K_EXPR:
      if (!ws.isBabel && exprIsChainRoot(item.a)) out.push(itemOf(item.start, item.end, K_CHAIN_ELEMENT, item.a, -1, -1));
      else expressionParts(item.a, out);
      return;
    case K_CHAIN_ELEMENT:
    case K_FLATTENED_OPERAND:
      expressionParts(item.a, out);
      return;
    case K_PARENTHESIZED: {
      const kept = keptParentheses(item.a);
      if (item.b * 2 + 1 < kept.length) out.push(itemOf(kept[item.b * 2], kept[item.b * 2 + 1], K_PARENTHESIZED, item.a, item.b + 1, -1));
      else {
        exprSpan(item.a);
        out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_EXPR, item.a, -1, -1));
      }
      return;
    }
    case K_LOGICAL:
      logicalParts(item.a, operandsInRightSide(item.a), item.b, out);
      return;
    case K_NON_NULL:
      nonNullParts(item.a, item.b, out);
      return;
    case K_STMT:
      if (stmtIsExported(item.a)) {
        stmtSpanWithoutExport(item.a);
        const s = SP$.s0 | 0;
        let start = s;
        if (stmtTag(item.a) === STMT_CLASS) {
          const cls = stmtClassClass(item.a);
          start = startWithDecorators(s, classModifiersStart(cls), classModifiersLen(cls));
        }
        // The decorators of a class can be before the `export`.
        out.push(itemOf(start, statementEnd(item.a, false), K_DECLARATION, item.a, -1, -1));
      } else declarationParts(item.a, out);
      return;
    case K_DECLARATION:
      declarationParts(item.a, out);
      return;
    case K_STATEMENTS:
      for (let i = 0; i < item.b; i++) out.push(statement(listAt(item.a, i)));
      return;
    case K_CATCH_CLAUSE: {
      const s = item.a;
      if (stmtTag(s) === STMT_TRY) {
        const p = stmtTryParam(s);
        if (p >= 0) {
          varDeclBindingSpan(p);
          out.push(binding(varDeclPat(p), varDeclTy(p), SP$.s0 | 0, SP$.s1 | 0));
        }
        const h = stmtTryHandler(s);
        if (h >= 0) out.push(statement(h));
      }
      return;
    }
    case K_CASE: {
      const c = item.a;
      const test = caseTest(c);
      if (test >= 0) out.push(expr(test));
      const bs = caseBodyStart(c);
      const n = caseBodyLen(c);
      for (let i = 0; i < n; i++) out.push(statement(listAt(bs, i)));
      return;
    }
    case K_VAR_DECL: {
      const d = item.a;
      varDeclBindingSpan(d);
      out.push(binding(varDeclPat(d), varDeclTy(d), SP$.s0 | 0, SP$.s1 | 0));
      const init = varDeclInit(d);
      if (init >= 0) out.push(expr(init));
      return;
    }
    case K_FUNC:
      functionParts(item.a, item.b !== 0, out);
      return;
    case K_CLASS_BODY: {
      const ms = classMembersStart(item.a);
      const n = classMembersLen(item.a);
      for (let i = 0; i < n; i++) out.push(member(listAt(ms, i)));
      return;
    }
    case K_MEMBER:
      memberParts(item.a, out);
      return;
    case K_PROP:
      propParts(item.a, out);
      return;
    case K_IMPORT_ATTRIBUTE: {
      const p = item.a;
      const owner = nodeOfProp(p);
      if (keyKind(owner) !== KEY_NONE) out.push(key(owner));
      const v = propValue(p);
      if (v >= 0) out.push(expr(v));
      return;
    }
    case K_DECORATOR:
      out.push(expr(item.a));
      return;
    case K_PARAMETER_PROPERTY:
      out.push(paramWithoutModifiers(item.a));
      decorators(paramModifiersStart(item.a), paramModifiersLen(item.a), out);
      return;
    case K_PARAMETER_PATTERN: {
      const p = item.a;
      const dflt = paramDefault(p);
      if (dflt >= 0) {
        paramBindingSpan(p);
        out.push(binding(paramPat(p), paramTy(p), SP$.s0 | 0, SP$.s1 | 0));
        out.push(expr(dflt));
      } else {
        out.push(pattern(paramPat(p)));
        const t = paramTy(p);
        if (t >= 0) out.push(typeAnnotation(t));
      }
      // Otherwise they are those of the `TSParameterProperty`.
      const ms = paramModifiersStart(p);
      const n = paramModifiersLen(p);
      let allDecorators = true;
      for (let i = 0; i < n; i++) if (modifierDecorator(listAt(ms, i)) < 0) allDecorators = false;
      if (allDecorators) decorators(ms, n, out);
      return;
    }
    case K_BINDING: {
      const pat = item.a;
      const t = item.b;
      const param = item.c;
      const ms = param >= 0 ? paramModifiersStart(param) : 0;
      const mn = param >= 0 ? paramModifiersLen(param) : 0;
      const pk = patTag(pat);
      if (pk === PAT_MISSING || pk === PAT_IDENT) {
        // nothing
      } else if (pk === PAT_OBJECT) {
        // The decorators of an object pattern are visited first.
        if (param >= 0) decorators(ms, mn, out);
        const ps = patObjectPropsStart(pat);
        const n = patObjectPropsLen(pat);
        for (let i = 0; i < n; i++) {
          const pp = listAt(ps, i);
          patPropSpan(pp);
          out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_PAT_PROP, pp, -1, -1));
        }
      } else if (pk === PAT_ARRAY) {
        const es = patArrayElemsStart(pat);
        const n = patArrayElemsLen(pat);
        for (let i = 0; i < n; i++) {
          const it = patternElement(listAt(es, i));
          if (it !== null) out.push(it);
        }
      }
      if (t >= 0) out.push(typeAnnotation(t));
      if (param >= 0 && pk !== PAT_OBJECT) decorators(ms, mn, out);
      return;
    }
    case K_PATTERN_WITH_DEFAULT:
      out.push(pattern(item.a));
      out.push(expr(item.b));
      return;
    case K_REST_PATTERN:
      out.push(pattern(item.a));
      return;
    case K_PAT_PROP: {
      const pp = item.a;
      if (patPropIsRest(pp)) {
        out.push(pattern(patPropValue(pp)));
        return;
      }
      const owner = nodeOfPatProp(pp);
      if (keyKind(owner) !== KEY_NONE) out.push(key(owner));
      const value = patPropValue(pp);
      const dflt = patPropDefault(pp);
      if (dflt >= 0) {
        patSpan(value);
        const vs = SP$.s0 | 0;
        patPropSpan(pp);
        out.push(itemOf(vs, SP$.s1 | 0, K_PATTERN_WITH_DEFAULT, value, dflt, -1));
      } else out.push(pattern(value));
      return;
    }
    case K_TYPE:
      typeParts(item.a, out);
      return;
    case K_TYPE_ANNOTATION:
      out.push(ty(item.a));
      return;
    case K_TYPE_PARAMS:
      for (let i = 0; i < item.b; i++) {
        const p = listAt(item.a, i);
        typeParamSpan(p);
        out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_TYPE_PARAM, p, -1, -1));
      }
      return;
    case K_TYPE_ARGS:
      for (let i = 0; i < item.b; i++) out.push(ty(listAt(item.a, i)));
      return;
    case K_TYPE_PARAM: {
      const p = item.a;
      out.push(leafIdent(typeParamName(p), typeParamNamePos(p)));
      const c = typeParamConstraint(p);
      if (c >= 0) out.push(ty(c));
      const d = typeParamDefault(p);
      if (d >= 0) out.push(ty(d));
      return;
    }
    case K_IMPORT_TYPE:
      importTypeParts(item.a, out);
      return;
    case K_TUPLE_ELEM: {
      const el = item.a;
      // `...a: T` is a `TSNamedTupleMember` in a `TSRestType`.
      if (tupleElemIsRest(el) && tupleElemName(el) >= 0) {
        identSpan(tupleElemName(el), tupleElemNamePos(el));
        out.push(itemOf(SP$.s0 | 0, item.end, K_NAMED_TUPLE_MEMBER, el, -1, -1));
        return;
      }
      tupleMemberParts(el, out);
      return;
    }
    case K_NAMED_TUPLE_MEMBER:
      tupleMemberParts(item.a, out);
      return;
    case K_ENTITY_NAME: {
      pushEntityName(item.a, item.b, item.c - 1, out);
      out.push(leafIdent(entityAtom(item.a, item.c - 1), entityPos(item.a, item.c - 1)));
      return;
    }
    case K_MODULE_NAME: {
      const prev = moduleName(item.a, item.b - 1);
      if (prev !== null) out.push(prev);
      const last = nestedModule(item.a, item.b - 1);
      if (last >= 0) {
        moduleNameSpan(last);
        out.push(leafSp());
      }
      return;
    }
    case K_INTERFACE_BODY: {
      const ms = interfaceMembersStart(item.a);
      const n = interfaceMembersLen(item.a);
      for (let i = 0; i < n; i++) out.push(member(listAt(ms, i)));
      return;
    }
    case K_ENUM_BODY: {
      const ms = enumMembersStart(item.a);
      const n = enumMembersLen(item.a);
      for (let i = 0; i < n; i++) {
        const m = listAt(ms, i);
        enumMemberSpan(m);
        out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_ENUM_MEMBER, m, -1, -1));
      }
      return;
    }
    case K_ENUM_MEMBER: {
      const owner = nodeOfEnumMember(item.a);
      if (keyKind(owner) !== KEY_NONE) out.push(key(owner));
      const init = enumMemberInit(item.a);
      if (init >= 0) out.push(expr(init));
      return;
    }
    case K_JSX_OPENING: {
      const e = item.a;
      jsxTagItem(jsxTag(e), out);
      typeArgs(jsxTypeArgsStart(e), jsxTypeArgsLen(e), out);
      const as = jsxAttrsStart(e);
      const n = jsxAttrsLen(e);
      for (let i = 0; i < n; i++) {
        const p = listAt(as, i);
        propSpan(p);
        out.push(itemOf(SP$.s0 | 0, SP$.s1 | 0, K_PROP, p, -1, -1));
      }
      return;
    }
    case K_JSX_CLOSING:
      jsxTagItem(jsxCloseTag(item.a), out);
      return;
    case K_JSX_CONTAINER:
      out.push(expr(item.a));
      return;
    default:
      return;
  }
}

function tupleMemberParts(el: number, out: Item[]): void {
  const n = tupleElemName(el);
  if (n >= 0) out.push(leafIdent(n, tupleElemNamePos(el)));
  out.push(ty(tupleElemTy(el)));
}

function patternElement(el: number): Item | null {
  const pat = patElemPat(el);
  if (pat < 0) return null;
  patElemSpan(el);
  const SP$ = SP;
  const s = SP$.s0 | 0;
  const e = SP$.s1 | 0;
  if (patElemIsRest(el)) return itemOf(s, e, K_REST_PATTERN, pat, -1, -1);
  const dflt = patElemDefault(el);
  if (dflt >= 0) return itemOf(s, e, K_PATTERN_WITH_DEFAULT, pat, dflt, -1);
  return pattern(pat);
}

// ───────────────────────────── where the cursor is ─────────────────────────────

/** The part of the text that the cursor is in. */
export class Region {
  /** A node without children (`nodeStart`, `nodeEnd`); else what is between two nodes. */
  isNode: boolean;
  nodeStart: number;
  nodeEnd: number;
  /** The span of the node before the cursor; -1: the start of the text. */
  beforeStart: number;
  beforeEnd: number;
  /** The span of the node after; -1: the end of the text. */
  afterStart: number;
  afterEnd: number;
  constructor() {
    this.isNode = false;
    this.nodeStart = -1;
    this.nodeEnd = -1;
    this.beforeStart = -1;
    this.beforeEnd = -1;
    this.afterStart = -1;
    this.afterEnd = -1;
  }
}

/** The outcome of `locateItems`: the node the cursor is in and `isNode`, or the nodes before and after it. */
class Located {
  first: Item | null;
  second: Item | null;
  isNode: boolean;
  constructor() {
    this.first = null;
    this.second = null;
    this.isNode = false;
  }
}

function regionOf(l: Located): Region {
  const r = new Region();
  const first = l.first;
  const second = l.second;
  if (first !== null && second === null && l.isNode) {
    r.isNode = true;
    r.nodeStart = first.start;
    r.nodeEnd = first.end;
    return r;
  }
  if (first !== null) {
    r.beforeStart = first.start;
    r.beforeEnd = first.end;
  }
  if (second !== null) {
    r.afterStart = second.start;
    r.afterEnd = second.end;
  }
  return r;
}

/** Prettier's `getCursorLocation`. `offset`: of the cursor in the text of the file. */
export function locate(offset: number): Region {
  return regionOf(locateItems(offset));
}

function locateItems(offset: number): Located {
  ws.isBabel = fileIsJavascript();
  const result = new Located();
  // Breadth first, like `getDescendants`: the last one is the last of those that are deepest.
  const containing: Item[] = [];
  containing.push(new Item(0, textLen(), K_PROGRAM, -1, -1, -1, -1));
  let kids: Item[] = [];
  let at = 0;
  while (at < containing.length) {
    kids = [];
    children(containing[at], kids);
    for (let i = 0; i < kids.length; i++) {
      const it = kids[i];
      if (it.start <= offset && offset <= it.end) containing.push(it);
    }
    at = at + 1;
  }

  if (containing.length > 0) {
    const last = containing[containing.length - 1];
    kids = [];
    children(last, kids);
    if (kids.length === 0) {
      result.first = last;
      result.second = null;
      result.isNode = true;
      return result;
    }
  }

  let before: Item | null = null;
  let after: Item | null = null;
  while (containing.length > 0) {
    const item = containing.pop() as Item;
    const hasBefore = before !== null;
    const hasAfter = after !== null;
    kids = [];
    children(item, kids);
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (!hasBefore && child.end <= offset && (before === null || child.end > before.end)) before = child;
      if (!hasAfter && child.start >= offset && (after === null || child.start < after.start)) after = child;
    }
    if (before !== null && after !== null) break;
  }
  result.first = before;
  result.second = after;
  result.isNode = false;
  return result;
}

// ───────────────────────────── where the region ends up ─────────────────────────────


function markedExtent(item: Item | null): Extent {
  if (item === null) return new Extent(NOWHERE, NOWHERE, NOWHERE);
  const k = item.kind;
  // The left side of a rebalanced expression has its operator.
  if (k === K_UNMARKED_LEAF || k === K_JSX_TEXT || k === K_FLATTENED_OPERAND || k === K_LOGICAL) return new Extent(NOWHERE, NOWHERE, NOWHERE);
  let endWithSemicolon = item.end;
  if (k === K_STMT || k === K_DECLARATION) {
    stmtSpan(item.a);
    endWithSemicolon = SP.s1 | 0;
  }
  return new Extent(item.start, item.end, endWithSemicolon);
}

function elementOf(item: Item | null): number {
  if (item !== null && item.kind === K_JSX_TEXT) return item.a;
  return NOWHERE;
}

/** Fills `r` for the cursor at `offset` (the nodes `l`). */
function fillRegion(r: CursorRegion, offset: number, l: Located): void {
  const first = l.first;
  const second = l.second;
  const isNode = l.isNode;
  const lo = first !== null ? (first.start < offset ? first.start : offset) : offset;
  const other = second !== null ? second : first;
  const hi = other !== null ? (other.end > offset ? other.end : offset) : offset;
  r.extentStart = lo;
  r.extentEnd = hi;
  r.node = isNode ? markedExtent(first) : new Extent(NOWHERE, NOWHERE, NOWHERE);
  r.before = isNode ? new Extent(NOWHERE, NOWHERE, NOWHERE) : markedExtent(first);
  r.after = markedExtent(second);
  r.startsWithChildrenOf = elementOf(first);
  // Prettier looks at the node after the cursor only if the one before it is no text.
  if (isNode) r.endsWithChildrenOf = elementOf(first);
  else if (elementOf(first) === NOWHERE) r.endsWithChildrenOf = elementOf(second);
  else r.endsWithChildrenOf = NOWHERE;
}


// ───────────────────────────── where the cursor is afterwards ─────────────────────────────

/** The cursor, among the UTF-16 code units. */
const CURSOR: number = -1;

/** Appends `text[start, end)` as UTF-16 code units to `out`. `normalize`: `\r\n` and `\r` are `\n`, as in the text that Prettier parses. */
function pushUnits(text: Uint8Array, start: number, end: number, normalize: boolean, out: I32Vec): void {
  let i = start;
  while (i < end) {
    const b = text[i] | 0;
    if (b < 0x80) {
      if (normalize && b === 13) {
        out.push(10);
        i = i + (i + 1 < end && (text[i + 1] | 0) === 10 ? 2 : 1);
      } else {
        out.push(b);
        i = i + 1;
      }
      continue;
    }
    let cp = 0xfffd;
    let len = 1;
    if (b >= 0xc2 && b <= 0xdf && i + 1 < end && ((text[i + 1] | 0) & 0xc0) === 0x80) {
      cp = ((b & 0x1f) << 6) | ((text[i + 1] | 0) & 0x3f);
      len = 2;
    } else if (b >= 0xe0 && b <= 0xef && i + 2 < end && ((text[i + 1] | 0) & 0xc0) === 0x80 && ((text[i + 2] | 0) & 0xc0) === 0x80) {
      cp = ((b & 0x0f) << 12) | (((text[i + 1] | 0) & 0x3f) << 6) | ((text[i + 2] | 0) & 0x3f);
      len = 3;
    } else if (b >= 0xf0 && b <= 0xf4 && i + 3 < end && ((text[i + 1] | 0) & 0xc0) === 0x80 && ((text[i + 2] | 0) & 0xc0) === 0x80 && ((text[i + 3] | 0) & 0xc0) === 0x80) {
      cp = ((b & 0x07) << 18) | (((text[i + 1] | 0) & 0x3f) << 12) | (((text[i + 2] | 0) & 0x3f) << 6) | ((text[i + 3] | 0) & 0x3f);
      len = 4;
    }
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      out.push(0xd800 + (v >> 10));
      out.push(0xdc00 + (v & 0x3ff));
    } else out.push(cp);
    i = i + len;
  }
}

/**
 * `diffArrays` of jsdiff 9, as far as it takes to tell how much of `nw` is before the place where the cursor is removed from `old`. The choices
 * between equally short ways are those of jsdiff.
 *
 * Prettier adds up the lengths of what is added or kept before the run of removals with the cursor in it. Removals do not add to that, so it is
 * what has been added or kept when the cursor goes.
 */
function unitsBeforeCursor(old: Int32Array, oldLen: number, nw: Int32Array, newLen: number): number {
  // `bestPath[diagonal]`: 0, -1, 1, -2, 2 and so on. It grows with the number of changes.
  let cap = 16;
  let bpOld = new Float64Array(cap);
  let bpUnits = new Float64Array(cap);
  let bpSet = new Uint8Array(cap);

  // `extractCommon`. Returns the last unit of the new text that is dealt with. `pathOld`: the position that is dealt with in `old` (in `EXTRACT[0]`).
  let first = -1;
  {
    let count = 0;
    while (first + 1 + count < oldLen && count < newLen && (old[first + 1 + count] | 0) === (nw[count] | 0)) count = count + 1;
    first = first + count;
  }
  if (first + 1 >= oldLen && first + 1 >= newLen) return 0;
  bpOld[0] = first;
  bpUnits[0] = 0;
  bpSet[0] = 1;

  let minDiagonal = -1e15;
  let maxDiagonal = 1e15;
  // To remove all of `old` and to add all of `new` is that many changes.
  const total = oldLen + newLen;
  for (let editLength = 1; editLength <= total; editLength++) {
    const need = 2 * (editLength + 1) + 2;
    if (need > cap) {
      let ncap = cap * 2;
      while (ncap < need) ncap = ncap * 2;
      const o2 = new Float64Array(ncap);
      const u2 = new Float64Array(ncap);
      const s2 = new Uint8Array(ncap);
      for (let i = 0; i < cap; i++) {
        o2[i] = bpOld[i];
        u2[i] = bpUnits[i];
        s2[i] = bpSet[i] | 0;
      }
      bpOld = o2;
      bpUnits = u2;
      bpSet = s2;
      cap = ncap;
    }
    let diagonal = minDiagonal > -editLength ? minDiagonal : -editLength;
    const limit = maxDiagonal < editLength ? maxDiagonal : editLength;
    while (diagonal <= limit) {
      const removeSlot = diagonal - 1 < 0 ? -2 * (diagonal - 1) - 1 : 2 * (diagonal - 1);
      const addSlot = diagonal + 1 < 0 ? -2 * (diagonal + 1) - 1 : 2 * (diagonal + 1);
      const mySlot = diagonal < 0 ? -2 * diagonal - 1 : 2 * diagonal;
      let removeOk = (bpSet[removeSlot] | 0) !== 0;
      const removeOld = bpOld[removeSlot];
      const removeUnits = bpUnits[removeSlot];
      bpSet[removeSlot] = 0;
      let addOk = (bpSet[addSlot] | 0) !== 0;
      const addOld = bpOld[addSlot];
      const addUnits = bpUnits[addSlot];
      if (addOk && !(addOld - diagonal >= 0 && addOld - diagonal < newLen)) addOk = false;
      if (removeOk && !(removeOld + 1 < oldLen)) removeOk = false;
      let baseOld = 0;
      let baseUnits = 0;
      if (!addOk && !removeOk) {
        bpSet[mySlot] = 0;
        diagonal = diagonal + 2;
        continue;
      } else if (addOk && !removeOk) {
        baseOld = addOld;
        baseUnits = addUnits;
      } else if (addOk && removeOk && removeOld < addOld) {
        baseOld = addOld;
        baseUnits = addUnits;
      } else {
        baseOld = removeOld + 1;
        baseUnits = (old[removeOld + 1] | 0) === CURSOR ? removeOld - (diagonal - 1) + 1 : removeUnits;
      }
      // extract_common(&mut base, diagonal)
      let count = 0;
      const os = baseOld + 1;
      const ns = baseOld - diagonal + 1;
      if (ns >= 0) {
        while (os + count < oldLen && ns + count < newLen && (old[os + count] | 0) === (nw[ns + count] | 0)) count = count + 1;
      }
      baseOld = baseOld + count;
      const newPos = baseOld - diagonal;
      if (baseOld + 1 >= oldLen && newPos + 1 >= newLen) return baseUnits;
      bpOld[mySlot] = baseOld;
      bpUnits[mySlot] = baseUnits;
      bpSet[mySlot] = 1;
      if (baseOld + 1 >= oldLen && diagonal - 1 < maxDiagonal) maxDiagonal = diagonal - 1;
      if (newPos + 1 >= newLen && diagonal + 1 > minDiagonal) minDiagonal = diagonal + 1;
      diagonal = diagonal + 2;
    }
  }
  return newLen;
}

/** Where the cursor is in a text. */
class Offset {
  bytes: number = 0;
  /** It is between the two UTF-16 code units of the character there. */
  isInCharacter: boolean = false;
}

/** Marks: where the start and the end of a region are in the formatted text (-1: the printer did not come by it). */
function isQuoteRel(text: Uint8Array, base: number, len: number, rel: number): boolean {
  if (rel < 0 || rel >= len) return false;
  const b = text[base + rel] | 0;
  return b === 34 || b === 39;
}

const oldUnits = new I32Vec(256);
const newUnits = new I32Vec(256);

/**
 * The end of Prettier's `coreFormat`: where the cursor is in `formatted[fStart, fEnd)`, in UTF-16 code units.
 *
 * `offset`: where it is in `source`. `region`: the part of the text that it is in. `names0`, `names1`: whether the node that `region` starts
 * with, and the one that it ends with, is the name of a property. `marks0`, `marks1`: where the start and the end of `region` are in
 * `formatted` (relative to `fStart`), if the printer came by both (else -1).
 */
function resolve(
  source: Uint8Array,
  offset: Offset,
  region: Region,
  names0: boolean,
  names1: boolean,
  formatted: Uint8Array,
  fStart: number,
  fEnd: number,
  marks0: number,
  marks1: number,
): number {
  const sourceLen = source.length;
  const formattedLen = fEnd - fStart;
  let oldStart = 0;
  let oldEnd = sourceLen;
  let newStart0 = 0;
  let newEnd0 = formattedLen;
  // An empty text counts as none.
  if (marks0 >= 0 && marks1 >= 0 && marks0 < marks1 && marks1 <= formattedLen) {
    if (region.isNode) {
      oldStart = region.nodeStart;
      oldEnd = region.nodeEnd;
    } else {
      oldStart = region.beforeStart >= 0 ? region.beforeEnd : 0;
      oldEnd = region.afterStart >= 0 ? region.afterStart : sourceLen;
    }
    newStart0 = marks0;
    newEnd0 = marks1;
  }
  // Prettier does not print the name of a property as a node if it adds or removes its quotes, so that it does not learn where it ends up.
  let isNameWithOtherQuotes = false;
  if (region.isNode) {
    isNameWithOtherQuotes = names0 && isQuoteRel(source, 0, sourceLen, oldStart) !== isQuoteRel(formatted, fStart, formattedLen, newStart0);
  } else {
    const a = names0 && isQuoteRel(source, 0, sourceLen, oldStart - 1) !== isQuoteRel(formatted, fStart, formattedLen, newStart0 - 1);
    const b = names1 && isQuoteRel(source, 0, sourceLen, oldEnd) !== isQuoteRel(formatted, fStart, formattedLen, newEnd0);
    isNameWithOtherQuotes = a || b;
  }
  if (isNameWithOtherQuotes) {
    oldStart = 0;
    oldEnd = sourceLen;
    newStart0 = 0;
    newEnd0 = formattedLen;
  }
  if (oldEnd > sourceLen) oldEnd = sourceLen;
  if (oldStart > oldEnd) oldStart = oldEnd;
  const newStart = utf16Len(formatted, fStart, fStart + newStart0);
  const oldTextLen = oldEnd - oldStart;
  let cursor = offset.bytes > oldStart ? offset.bytes - oldStart : 0;
  if (cursor > oldTextLen) cursor = oldTextLen;

  // Prettier compares with the text that it parses, in which every line break is `\n`.
  const oldUnits$ = oldUnits;
  oldUnits$.reset();
  pushUnits(source, oldStart, oldStart + cursor, true, oldUnits$);
  let unitsBefore = oldUnits$.len + (offset.isInCharacter ? 1 : 0);
  pushUnits(source, oldStart + cursor, oldEnd, true, oldUnits$);
  if (unitsBefore > oldUnits$.len) unitsBefore = oldUnits$.len;
  const newUnits$ = newUnits;
  newUnits$.reset();
  pushUnits(formatted, fStart + newStart0, fStart + newEnd0, false, newUnits$);
  if (oldUnits$.len === newUnits$.len) {
    let same = true;
    for (let i = 0; i < oldUnits$.len; i++) {
      if ((oldUnits$.data[i] | 0) !== (newUnits$.data[i] | 0)) {
        same = false;
        break;
      }
    }
    if (same) return newStart + unitsBefore;
  }
  // old_units.insert(units_before, CURSOR)
  const n = oldUnits$.len;
  const withCursor = new Int32Array(n + 1);
  for (let i = 0; i < unitsBefore; i++) withCursor[i] = oldUnits$.data[i] | 0;
  withCursor[unitsBefore] = CURSOR;
  for (let i = unitsBefore; i < n; i++) withCursor[i + 1] = oldUnits$.data[i] | 0;
  return newStart + unitsBeforeCursor(withCursor, n + 1, newUnits$.data, newUnits$.len);
}

/** The byte offset of the UTF-16 index `units` in `text`: the start of the character that it is in. */
function offsetOfUtf16Index(text: Uint8Array, units: number): number {
  let n = 0;
  let i = 0;
  const end = text.length;
  while (i < end && n < units) {
    const b = text[i] | 0;
    let len = 1;
    let w = 1;
    if (b >= 0xf0) {
      len = 4;
      w = 2;
    } else if (b >= 0xe0) len = 3;
    else if (b >= 0xc0) len = 2;
    if (n + w > units) break;
    n = n + w;
    i = i + len;
    if (i > end) i = end;
  }
  return i;
}

const OFFSET = new Offset();

/**
 * `options.cursorOffset`, which counts UTF-16 code units, as an offset in `source`. Prettier's `normalizeInputAndOptions`: false if it is not
 * in the text, of which a byte order mark is no part. Writes `OFFSET`.
 */
function offsetIn(source: Uint8Array, options: FormatOptions): boolean {
  if (options.cursorOffset < 0) return false;
  const units = options.cursorOffset;
  if (units > utf16Len(source, 0, source.length)) return false;
  if (units === 0 && source.length >= 3 && (source[0] | 0) === 0xef && (source[1] | 0) === 0xbb && (source[2] | 0) === 0xbf) return false;
  const offset = offsetOfUtf16Index(source, units);
  const OFFSET$ = OFFSET;
  OFFSET$.isInCharacter = utf16Len(source, 0, offset) < units;
  // After `\r\n` has become `\n`, an offset between the two is behind it.
  const isInLineBreak = offset > 0 && offset < source.length && (source[offset - 1] | 0) === 13 && (source[offset] | 0) === 10;
  OFFSET$.bytes = offset + (isInLineBreak ? 1 : 0);
  return true;
}

function isBlank(source: Uint8Array): boolean {
  return trimJsWhitespaceStart(source, 0, source.length) >= source.length;
}

/** What `formatWith` leaves for its caller: where the cursor is in the output, in UTF-16 code units (-1: nowhere). */
export class CursorResult {
  value: number = -1;
}
export const cursorResult = new CursorResult();

/** What `js/mod.ts` leaves when it trims the blanks of an aligned document: how much it cut from the start, and where the text ends (-1: nothing). */

/** The region that the formatter of JavaScript reads (`cxOf(f).cursor` is this object while a document is written). */
export const pendingCursor = new CursorRegion();
export const noCursor = new CursorRegion();

/**
 * Appends the formatted text of the file that was parsed last (whose text is `text`) to `out` and leaves in `cursorResult.value` where the cursor,
 * which is at `options.cursorOffset` in `text`, is in what is appended, in UTF-16 code units like the option (-1: without the option, if it is not
 * in the text, and if the text is blank). Returns a `FORMAT_*` code. Prettier's `coreFormat`.
 *
 * `alignment`: the document is indented by so many columns more (`formatDocument`).
 */
export function formatWith(text: Uint8Array, options: FormatOptions, out: ByteBuf, alignment: number): number {
  const cursorResult$ = cursorResult;
  cursorResult$.value = -1;
  const hasOffset = offsetIn(text, options) && !isBlank(text);
  if (!hasOffset) return formatDocument(text, options, out, alignment, noCursor);
  const offset = new Offset();
  const OFFSET$ = OFFSET;
  offset.bytes = OFFSET$.bytes;
  offset.isInCharacter = OFFSET$.isInCharacter;
  const items = locateItems(offset.bytes);
  const region = pendingCursor;
  fillRegion(region, offset.bytes, items);

  const start = out.len;
  const trimInfo$ = trimInfo;
  trimInfo$.leading = 0;
  trimInfo$.end = -1;
  const code = formatDocument(text, options, out, alignment, region);
  region.clear();
  if (code !== FORMAT_OK) return code;
  let first = marksStart();
  let second = marksEnd();
  // Without a node on one side, the region goes to that end of the document. (`trimInfo`: the blanks of an aligned document are already gone.)
  const aligned = alignment > 0 && trimInfo$.end >= 0;
  if (aligned) {
    const leading = trimInfo$.leading;
    const end = trimInfo$.end;
    if (first >= 0) first = (first < leading ? leading : first > end ? end : first) - leading;
    if (second >= 0) second = (second < leading ? leading : second > end ? end : second) - leading;
  }
  if (items.first === null && items.second !== null) first = 0;
  else if (items.first !== null && items.second === null && !items.isNode) second = aligned ? trimInfo$.end - trimInfo$.leading : out.len - start;
  const names0 = items.first !== null && items.first.kind === K_NAME;
  const names1 = items.second !== null && items.second.kind === K_NAME;
  let m0 = first;
  let m1 = second;
  if (m0 < 0 || m1 < 0) {
    m0 = -1;
    m1 = -1;
  }
  cursorResult$.value = resolve(text, offset, regionOf(items), names0, names1, out.data, start, out.len, m0, m1);
  return FORMAT_OK;
}

/** `options.cursorOffset` as an offset in `source`, for a language whose tree is looked at elsewhere (-1: none). */
export function cursorOffsetInBytes(source: Uint8Array, options: FormatOptions): number {
  if (!offsetIn(source, options)) return -1;
  return OFFSET.bytes;
}

/**
 * Where the cursor, which is at `offset` in `source`, is in `formatted[fStart, fEnd)`. `marks0`, `marks1`: where the start and the end of
 * `region` are in `formatted` (relative to `fStart`), if the printer came by both (else -1).
 */
export function cursorInRegion(
  source: Uint8Array,
  offset: number,
  region: Region,
  formatted: Uint8Array,
  fStart: number,
  fEnd: number,
  marks0: number,
  marks1: number,
): number {
  // HTML has a text end before the blanks at its end once it has been printed. Prettier does not ask whether the cursor is still in a node that
  // has been printed as it was.
  if (region.isNode && marks0 >= 0 && marks1 >= 0 && offset > region.nodeEnd && marks0 < marks1) {
    const oldLen = region.nodeEnd - region.nodeStart;
    if (region.nodeStart >= 0 && region.nodeEnd <= source.length && marks1 <= fEnd - fStart && marks1 - marks0 === oldLen) {
      let same = true;
      for (let i = 0; i < oldLen; i++) {
        if ((source[region.nodeStart + i] | 0) !== (formatted[fStart + marks0 + i] | 0)) {
          same = false;
          break;
        }
      }
      if (same) {
        return utf16Len(formatted, fStart, fStart + marks0) + utf16Len(source, region.nodeStart, offset > source.length ? source.length : offset);
      }
    }
  }
  const o = new Offset();
  o.bytes = offset;
  o.isInCharacter = false;
  return resolve(source, o, region, false, false, formatted, fStart, fEnd, marks0, marks1);
}

/**
 * Where the cursor, which is at `options.cursorOffset` in `source`, is in `formatted`, which is what has become of all of `source`: what
 * Prettier says if it does not learn where the part around the cursor ends up. For the languages whose trees are not looked at here.
 * -1: nowhere.
 */
export function cursorInFormattedText(source: Uint8Array, options: FormatOptions, formatted: Uint8Array): number {
  if (!offsetIn(source, options) || isBlank(source)) return -1;
  const everything = new Region();
  return resolve(source, OFFSET, everything, false, false, formatted, 0, formatted.length, -1, -1);
}
