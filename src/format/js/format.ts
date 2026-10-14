// Port of vendor/bun/src/format/js/format.rs: `Format` for the handles of the lint AST.
//
// `fmtExpr(e, f)` (Rust `write!(f, e)`) does what is the same for every node, and then calls the function in `print/` that writes this
// kind of node:
// 1. If a `// prettier-ignore` comment leads or trails the node, its source text is written.
// 2. `/** @type {T} */ (e)` keeps its parentheses.
// 3. The comments before the node.
// 4. `(`, if the node needs parentheses where it is: `parentheses/`.
// 5. The node.
// 6. `)`
// 7. The comments after the node.
//
// Most nodes have no comment anywhere near them. `cx.isQuiet` (Rust `f.is_quiet()`) says so, and then only 4 to 6 are done. It is set for
// the time that a node is written which has no comment in it and none behind it on the same line.
//
// ## Naming
//   Rust `write!(f, x)` / `x.fmt(f)` for a handle        fmtExpr(e, f), fmtStmt(s, f), fmtType(t, f), fmtPat, fmtMember, fmtProp, ...
//   Rust `FormatX(..)` structs                            fmtX(.., f)
//   Rust `write_x(..)` functions                          writeX(.., f)
//   Rust `impl Format + Spanned` passed around            a pair `(wk, h)`: `WK_*` below, `writeNode(wk, h, f)`, `nodeSpanOf(wk, h)`
//
// ## Closures
// Rust's `format_node(span, parent, f, write)` takes two closures. TS has `formatNodeInList(start, end, isBeforeAnother, pk, ph, wk, wh, f)`:
// `(wk, wh)` is what is written (`writeNodeStep5`) and `(pk, ph)` says what the parent is (`parentOfRef`), computed only if needed.
import { Formatter } from "../ir/formatter.ts";
import { LPAREN, RPAREN, BANG } from "../ir/tokens.ts";
import { token } from "../ir/element.ts";
import { FLAVOR_OXFMT, SEMICOLONS_ALWAYS } from "../options.ts";
import {
  EXPR_AS,
  EXPR_AS_CONST,
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
  EXPR_ARRAY,
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
  BIN_COMMA,
  N_STMT,
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
  exprAsCallLike,
  exprAsFn,
  exprNonNullEndsFirst,
  exprIsAngleBracketAssertion,
  exprIsAssignmentTarget,
  exprIsChainRoot,
  exprIsJsxText,
  exprJsxContainerSpan,
  exprNonNullExpr,
  exprOperand,
  exprSpan,
  exprEnd,
  exprTag,
  exprUnaryOpOf,
  exprBinaryOpOf,
  exprYieldValue,
  exprYieldStar,
  exprAwaitExpr,
  exprSpreadExpr,
  exprInstantiationExpr,
  exprInstantiationTypeArgsLen,
  exprInstantiationTypeArgsStart,
  exprImportCallArgsLen,
  exprImportCallArgsStart,
  exprInnerNonNullCount,
  exprObjectPropsLen,
  exprObjectPropsStart,
  exprArrayElemsLen,
  exprArrayElemsStart,
  fileIsFlow,
  fileIsJavascript,
  funcIsArrow,
  funcHasBody,
  funcOwner,
  hir,
  nodeId,
  nodeKind,
  nodeOfExpr,
  nodeOfType,
  classModifiersLen,
  classModifiersStart,
  modifierDecorator,
  listAt,
  stmtBlockStmtsLen,
  stmtBlockStmtsStart,
  stmtDirectiveSpan,
  stmtExprExpr,
  stmtExportDefaultExpr,
  stmtExportAssignExpr,
  stmtExportNamedExport,
  stmtIfNo,
  stmtIfTest,
  stmtIfYes,
  stmtForBody,
  stmtForInBody,
  stmtForInExpr,
  stmtForInLeft,
  stmtForInit,
  stmtForOfBody,
  stmtForOfExpr,
  stmtForOfIsAwait,
  stmtForOfLeft,
  stmtForTest,
  stmtForUpdate,
  stmtWhileBody,
  stmtWhileTest,
  stmtDoWhileBody,
  stmtDoWhileTest,
  stmtWithBody,
  stmtWithObject,
  stmtIsWith,
  stmtIsExported,
  stmtLabeledBody,
  stmtModifiersLen,
  stmtParent,
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
  stmtVarDeclsLen,
  stmtVarDeclsStart,
  stmtImportImport,
  stmtImportEqualsImportEquals,
  stmtFnFn,
  stmtClassClass,
  stmtInterfaceInterface,
  stmtTypeAliasAlias,
  stmtEnumEnum,
  stmtModuleModule,
  typeAnnotationSpan,
  typeArrayElem,
  typeFnFn,
  typeHeritageArgsLen,
  typeHeritageArgsStart,
  typeHeritageExpr,
  typeIndexedAccessIndex,
  typeIndexedAccessObj,
  typeInferParam,
  typeIntersectionTypesLen,
  typeIntersectionTypesStart,
  typeKeyofTy,
  typeMappedMapped,
  typeObjectMembersLen,
  typeObjectMembersStart,
  typeReadonlyTy,
  typeRefArgsLen,
  typeRefArgsStart,
  typeRefNameLen,
  typeRefNameStart,
  typeSpan,
  typeTag,
  typeTupleElemsLen,
  typeTupleElemsStart,
  typeTypeofArgsLen,
  typeTypeofArgsStart,
  typeTypeofExpr,
  typeUnionTypesLen,
  typeUnionTypesStart,
  typeUniqueTy,
  identSpan,
  caseSpan,
  enumMemberSpan,
  importSpecSpan,
  exportSpecSpan,
  typeParamSpan,
  patPropSpan,
  patSpan,
  patElemSpan,
  memberSpan,
  propSpan,
  varDeclSpan,
  paramSpan,
  tupleElemSpan,
  tupleElemParent,
  tupleElemName,
  tupleElemIsRest,
  tupleElemIsOptional,
  tupleElemTy,
} from "../../lint/ast/index.ts";
import {
  AN_BINARY_EXPRESSION,
  AN_BINDING_PROPERTY,
  AN_CHAIN_EXPRESSION,
  AN_EXPORT_DEFAULT_DECLARATION,
  AN_EXPORT_NAMED_DECLARATION,
  AN_EXPORT_SPECIFIER,
  AN_JSX_ELEMENT,
  AN_JSX_FRAGMENT,
  AN_LOGICAL_EXPRESSION,
  AN_SWITCH_CASE,
  AN_TS_ENUM_MEMBER,
  AN_TS_TYPE_ANNOTATION,
  AN_TS_TYPE_PARAMETER,
  AN_IMPORT_SPECIFIER,
  AN_EXPRESSION_STATEMENT,
  AN_DIRECTIVE,
  AN_IMPORT_DECLARATION,
  AN_EXPORT_ALL_DECLARATION,
  AN_RETURN_STATEMENT,
  AN_THROW_STATEMENT,
  AN_DO_WHILE_STATEMENT,
  AN_BREAK_STATEMENT,
  AN_CONTINUE_STATEMENT,
  AN_DEBUGGER_STATEMENT,
  AN_VARIABLE_DECLARATION,
  AN_VARIABLE_DECLARATOR,
  AN_PROPERTY_DEFINITION,
  AN_ACCESSOR_PROPERTY,
  AN_METHOD_DEFINITION,
  AN_IF_STATEMENT,
  AN_FOR_STATEMENT,
  AN_FOR_IN_STATEMENT,
  AN_FOR_OF_STATEMENT,
  AN_WHILE_STATEMENT,
  AN_WITH_STATEMENT,
  AN_LABELED_STATEMENT,
  AN_TS_TYPE_ALIAS_DECLARATION,
  AN_TS_IMPORT_EQUALS_DECLARATION,
  AN_FUNCTION,
  AN_PROGRAM,
  mkAn,
  anId,
  anTag,
  anParent,
  anSpan,
  exprAsChainElement,
  exprAstParent,
  stmtAsAstNodes,
  stmtAstParent,
  typeAstParent,
  patAstParent,
  memberAsAstNodes,
  propAsAstNodes,
  varDeclAsAstNodes,
  paramAsAstNodes,
  nodeAsAstNodes,
} from "./ast_nodes.ts";
import { cxOf, JsFormatContext } from "./context.ts";
import { unOpIsUpdate } from "./utils/operators.ts";
import { INF } from "./comments.ts";
import { followingSpanStartIn } from "./siblings.ts";
import {
  formatLeadingComments,
  formatLeadingCommentsRange,
  formatTrailingComments,
  formatTrailingCommentsRange,
} from "./trivia.ts";
import { needsParentheses as exprNeedsParentheses, chainExpressionNeedsParentheses } from "./parentheses/expression.ts";
import { needsParentheses as typeNeedsParentheses } from "./parentheses/ts_type.ts";
import { writeSuppressedNode } from "./utils/suppressed.ts";
import { enterNode, extendNode } from "../cursor_region.ts";
import { writeTypeCasts } from "./utils/typecast.ts";
import { endsBeforeSemicolon, writeDirective } from "./print/program.ts";
import { optionalSemicolon, startOfCommentsBehindSemicolon } from "./print/semicolon.ts";
import { writeBigIntLiteral, writeNumericLiteral, writeRegExpLiteral, writeStringLiteral } from "./print/literals.ts";
import { writeJsxElement, writeJsxSpreadChild, writeJsxText } from "./print/jsx/mod.ts";
import { writeMemberExpression } from "./print/member_expression.ts";
import { writeCallExpression, writeImportExpression, writeNewExpression } from "./print/call_like_expression/mod.ts";
import { writeArrayType, writeExpressionWithBraces, writeIndexedAccessType, writeNullableTypeOrTypeOperator, writeTypeCastExpression } from "./print/flow.ts";
import { writeCalledFunctionWithComments, writeFunction } from "./print/function.ts";
import { writeArrowFunctionExpression } from "./print/arrow_function_expression.ts";
import { writeClass, writeMember } from "./print/class.ts";
import { writeTaggedTemplateExpression, writeTemplateLiteral, writeTsTemplateLiteralType } from "./print/template.ts";
import { writeAsOrSatisfiesExpression } from "./print/as_or_satisfies_expression.ts";
import { typeArguments, writeTsTypeParameter } from "./print/type_parameters.ts";
import { spanThatCommentsLead, writeSequenceExpression } from "./print/sequence_expression.ts";
import { writeBinaryLikeExpression } from "./print/binary_like_expression.ts";
import { expressionStatementNeedsSemicolon, writeBreakStatement, writeContinueStatement, writeDoWhileStatement, writeEmptyStatement, writeExpressionStatement, writeForInStatement, writeForOfStatement, writeForStatement, writeIfStatement, writeLabeledStatement, writeWhileStatement, writeWithStatement } from "./print/statements.ts";
import { writeBlockStatement } from "./print/block_statement.ts";
import { writeVariableDeclaration, writeVariableDeclarator } from "./print/variable_declaration.ts";
import { writeReturnStatement, writeThrowStatement } from "./print/return_or_throw_statement.ts";
import { writeSwitchCase, writeSwitchStatement } from "./print/switch_statement.ts";
import { writeTryStatement } from "./print/try_statement.ts";
import { writeImportDeclaration, writeImportSpecifier } from "./print/import_declaration.ts";
import { writeExportAllDeclaration, writeExportDefaultExpression, writeExportNamedDeclaration, writeExportSpecifier, writeExportedDeclaration } from "./print/export_declarations.ts";
import { writeTsEnumDeclaration, writeTsEnumMember, writeTsExportAssignment, writeTsImportEqualsDeclaration, writeTsInterfaceDeclaration, writeTsModuleDeclaration, writeTsNamespaceExportDeclaration, writeTsTypeAliasDeclaration } from "./print/ts_declarations.ts";
import { writeTsConditionalType, writeTsImportType, writeTsLiteralType, writeTsTypeLiteral, writeTsTypePredicate, writeTsTypeQuery, writeTsTypeReference } from "./print/ts_types.ts";
import { writeTsTupleElement, writeTsTupleType } from "./print/tuple_type.ts";
import { prettierIgnoreBeforeUnionIsAboutAllOfIt, writeTsUnionType } from "./print/union_type.ts";
import { writeTsIntersectionType } from "./print/intersection_type.ts";
import { writeTsFunctionType } from "./print/function_type.ts";
import { writeTsMappedType } from "./print/mapped_type.ts";
import { writeArrayAssignmentTarget, writeAssignmentExpression, writeAwaitExpression, writeChainExpression, writeConditionalExpression, writeMetaProperty, writeObjectAssignmentTarget, writeObjectExpression, writeProperty, writeTsTypeAssertion, writeUnaryExpression, writeUpdateExpression, writeYieldExpression } from "./print/expressions.ts";
import { writeArrayExpression } from "./print/array_expression.ts";
import { writeArrayPatternElement, writeBindingPattern, writeBindingProperty } from "./print/patterns.ts";
import { writeFormalParameter } from "./print/parameters.ts";

const T_THIS = token("this");
const T_SUPER = token("super");
const T_NULL = token("null");
const T_TRUE = token("true");
const T_FALSE = token("false");
const T_DEBUGGER = token("debugger");
const T_SPREAD = token("...");
const T_INFER = token("infer");
const T_KEYOF = token("keyof");
const T_READONLY = token("readonly");
const T_UNIQUE = token("unique");
const T_SYMBOL = token("symbol");
const T_ARRAY_BRACKETS = token("[]");
const T_LBRACKET = token("[");
const T_RBRACKET = token("]");
const T_COLON_SPACE = token(": ");
const T_COLON = token(":");
const T_ARROW = token("=>");
const T_SEMICOLON = token(";");

// ───────────────────────────── ExprOptions ─────────────────────────────

/**
 * How a function or an arrow function is written where it is (Rust `ExprOptions`): one int.
 *   0                                   `ExprOptions::None`
 *   EO_FUNCTION | cacheMode << 4        `ExprOptions::Function(FormatFunctionOptions { cache_mode })`
 *   EO_ARROW | cacheMode << 4 | (assignmentLayout + 1) << 8 | (callArgumentLayout + 1) << 16
 *                                       `ExprOptions::Arrow(FormatJsArrowFunctionExpressionOptions { .. })`
 * (`assignmentLayout`, `callArgumentLayout`: -1 for `None`; `cacheMode`: `FunctionCacheMode`, 0 `NoCache`, 1 `Cache`).
 */
export const EO_NONE: number = 0;
export const EO_FUNCTION: number = 1;
export const EO_ARROW: number = 2;

export function exprOptionsFunction(cacheMode: number): number {
  return EO_FUNCTION | (cacheMode << 4);
}
export function exprOptionsArrow(assignmentLayout: number, callArgumentLayout: number, cacheMode: number): number {
  return EO_ARROW | (cacheMode << 4) | ((assignmentLayout + 1) << 8) | ((callArgumentLayout + 1) << 16);
}
export function eoKind(o: number): number {
  return o & 15;
}
export function eoCacheMode(o: number): number {
  return (o >> 4) & 15;
}
export function eoAssignmentLayout(o: number): number {
  return ((o >> 8) & 255) - 1;
}
export function eoCallArgumentLayout(o: number): number {
  return ((o >> 16) & 255) - 1;
}

// ───────────────────────────── scopes ─────────────────────────────

/** Whether there is no comment to print in `(start, end)`, or behind it on the same line. */
export function hasNoCommentsIn(cx: JsFormatContext, start: number, end: number): boolean {
  const cm = cx.comments;
  const next = cm.nextStart();
  if (next < end || cm.hasTypeCastComments) return false;
  if (next === INF) return true;
  return cx.src.hasNewlineInRange(end, next);
}

/**
 * `f.in_scope(span, write)`: call it before writing the node at `(start, end)` and `leaveScope(cx, outer)` after. If there is no comment
 * in the span, `cx.isQuiet` is set in between. Returns the value to hand to `leaveScope`.
 */
export function enterScope(cx: JsFormatContext, start: number, end: number): boolean {
  const outer = cx.isQuiet;
  const cursor = cx.cursor;
  if (cursor.isActive()) {
    // `in_scope_with_cursor`: what the region is in, and the nodes before and after it, are not quiet, so that this is called for them.
    cx.isQuiet = outer || (!cursor.overlaps(start, end) && hasNoCommentsIn(cx, start, end));
    cursor.scopes.push2(start, end);
    cursor.enter(start, end, cx.formatter as Formatter);
    return outer;
  }
  cx.isQuiet = outer || hasNoCommentsIn(cx, start, end);
  return outer;
}

/** `f.in_scope_without_comments(span, write)`: `span` is known to have no comments in it. */
export function enterScopeWithoutComments(cx: JsFormatContext, start: number, end: number): boolean {
  if (cx.cursor.isActive()) return enterScope(cx, start, end);
  const outer = cx.isQuiet;
  cx.isQuiet = true;
  return outer;
}

export function leaveScope(cx: JsFormatContext, outer: boolean): void {
  const cursor = cx.cursor;
  if (cursor.isActive() && cursor.scopes.len >= 2) {
    const n = cursor.scopes.len;
    const start = cursor.scopes.data[n - 2] | 0;
    const end = cursor.scopes.data[n - 1] | 0;
    cursor.scopes.len = n - 2;
    cursor.exit(start, end, cx.formatter as Formatter);
  }
  cx.isQuiet = outer;
}

// ───────────────────────────── spans and parents ─────────────────────────────

/**
 * The span of `node` (an `AstNodes`) into `SP`. For a statement that ends with a `;`, without it: see `Comments.withoutSemicolon`.
 */
export function spanForComments(node: number, f: Formatter): void {
  anSpan(node);
  const id = anId(node);
  switch (anTag(node)) {
    case AN_EXPRESSION_STATEMENT:
    case AN_DIRECTIVE:
    case AN_IMPORT_DECLARATION:
    case AN_EXPORT_DEFAULT_DECLARATION:
    case AN_EXPORT_NAMED_DECLARATION:
    case AN_EXPORT_ALL_DECLARATION:
    case AN_RETURN_STATEMENT:
    case AN_THROW_STATEMENT:
    case AN_DO_WHILE_STATEMENT:
    case AN_BREAK_STATEMENT:
    case AN_CONTINUE_STATEMENT:
    case AN_DEBUGGER_STATEMENT:
    case AN_VARIABLE_DECLARATION:
    case AN_PROPERTY_DEFINITION:
    case AN_ACCESSOR_PROPERTY:
    case AN_METHOD_DEFINITION:
      withoutSemicolon(f);
      return;
    // These end where their last body ends. An empty statement is its `;`.
    case AN_IF_STATEMENT:
    case AN_FOR_STATEMENT:
    case AN_FOR_IN_STATEMENT:
    case AN_FOR_OF_STATEMENT:
    case AN_WHILE_STATEMENT:
    case AN_WITH_STATEMENT:
    case AN_LABELED_STATEMENT:
      if (endsBeforeSemicolon(id)) withoutSemicolon(f);
      return;
    // What is exported ends where the `export` around it ends.
    case AN_TS_TYPE_ALIAS_DECLARATION:
    case AN_TS_IMPORT_EQUALS_DECLARATION:
      if (stmtIsExported(id)) withoutSemicolon(f);
      return;
    case AN_FUNCTION: {
      const owner = funcOwner(id);
      if (!funcHasBody(id) && nodeKind(owner) === N_STMT && stmtIsExported(nodeId(owner))) withoutSemicolon(f);
      return;
    }
    default:
      return;
  }
}

/** `SP[1] = comments.without_semicolon(SP)` */
function withoutSemicolon(f: Formatter): void {
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  SP[1] = cxOf(f).comments.withoutSemicolon(start, end);
}

// A reference to the parent of what is written (`pk`, `ph`), computed only if it is needed. `pk` is a `WK_*` (the parent of that kind of
// handle) or one of these:
/** `ph` is the parent itself (an `AstNodes`). */
export const PK_PARENT: number = 100;
/** `ph` is an `AstNodes`; the parent is its parent. */
export const PK_NODE: number = 101;
/** `ph` is a statement `s`: the parent is `s.as_ast_nodes()` (it is exported: the `export` around it is its parent). */
export const PK_STMT_OF_EXPORT: number = 102;

function parentOfRef(pk: number, ph: number): number {
  switch (pk) {
    case PK_PARENT:
      return ph;
    case PK_NODE:
      return anParent(ph);
    case PK_STMT_OF_EXPORT:
      return stmtAsAstNodes(ph);
    case WK_EXPR:
      return exprAstParent(ph);
    case WK_STMT:
    case WK_STMT_BEFORE_ANOTHER:
    case WK_DECLARATION:
      return stmtAstParent(ph);
    case WK_TYPE:
    case WK_TYPE_ANNOTATION:
    case WK_RETURN_TYPE_OF_FUNCTION_TYPE:
    case WK_TYPE_OF_PREDICATE:
      return typeAstParent(ph);
    case WK_PAT:
      return patAstParent(ph);
    case WK_PAT_PROP:
      return anParent(mkAn(AN_BINDING_PROPERTY, ph));
    case WK_MEMBER:
    case WK_MEMBER_BEFORE_ANOTHER:
      return anParent(memberAsAstNodes(ph));
    case WK_PROP:
      return anParent(propAsAstNodes(ph));
    case WK_VAR_DECL:
      return anParent(varDeclAsAstNodes(ph));
    case WK_PARAM:
      return anParent(paramAsAstNodes(ph));
    case WK_CASE:
      return anParent(mkAn(AN_SWITCH_CASE, ph));
    case WK_ENUM_MEMBER:
      return anParent(mkAn(AN_TS_ENUM_MEMBER, ph));
    case WK_IMPORT_SPEC:
      return anParent(mkAn(AN_IMPORT_SPECIFIER, ph));
    case WK_EXPORT_SPEC:
      return anParent(mkAn(AN_EXPORT_SPECIFIER, ph));
    case WK_TYPE_PARAM:
      return anParent(mkAn(AN_TS_TYPE_PARAMETER, ph));
    case WK_TUPLE_ELEM:
      return nodeAsAstNodes(tupleElemParent(ph));
    default:
      return mkAn(AN_PROGRAM, 0);
  }
}

// ───────────────────────────── what is written: Format + Spanned ─────────────────────────────

// The handles that can be written with `writeNode(wk, h, f)` and have a `nodeSpanOf(wk, h)` (Rust: `impl Format + Spanned`).
export const WK_EXPR: number = 0;
export const WK_STMT: number = 1;
/** `FormatStatementBeforeAnother` */
export const WK_STMT_BEFORE_ANOTHER: number = 2;
/** `FormatDeclaration`: the statement without its `export`. */
export const WK_DECLARATION: number = 3;
export const WK_TYPE: number = 4;
export const WK_PAT: number = 5;
export const WK_PAT_ELEM: number = 6;
export const WK_PAT_PROP: number = 7;
export const WK_MEMBER: number = 8;
/** `FormatMemberBeforeAnother` */
export const WK_MEMBER_BEFORE_ANOTHER: number = 9;
export const WK_PROP: number = 10;
export const WK_VAR_DECL: number = 11;
export const WK_PARAM: number = 12;
export const WK_CASE: number = 13;
export const WK_ENUM_MEMBER: number = 14;
export const WK_IMPORT_SPEC: number = 15;
export const WK_EXPORT_SPEC: number = 16;
export const WK_TYPE_PARAM: number = 17;
export const WK_TUPLE_ELEM: number = 18;
/** `FormatTypeAnnotation` (`: T`) */
export const WK_TYPE_ANNOTATION: number = 19;
/** `FormatReturnTypeOfFunctionType` (`=> T`) */
export const WK_RETURN_TYPE_OF_FUNCTION_TYPE: number = 20;
/** `FormatTypeOfPredicate` */
export const WK_TYPE_OF_PREDICATE: number = 21;

/** `x.fmt(f)` for the handle `h` of kind `wk`. */
export function writeNode(wk: number, h: number, f: Formatter): void {
  switch (wk) {
    case WK_EXPR:
      fmtExpr(h, f);
      return;
    case WK_STMT:
      fmtStmt(h, f);
      return;
    case WK_STMT_BEFORE_ANOTHER:
      fmtStmtBeforeAnother(h, f);
      return;
    case WK_DECLARATION:
      fmtDeclaration(h, f);
      return;
    case WK_TYPE:
      fmtType(h, f);
      return;
    case WK_PAT:
      fmtPat(h, f);
      return;
    case WK_PAT_ELEM:
      fmtPatElem(h, f);
      return;
    case WK_PAT_PROP:
      fmtPatProp(h, f);
      return;
    case WK_MEMBER:
      fmtMember(h, f);
      return;
    case WK_MEMBER_BEFORE_ANOTHER:
      fmtMemberBeforeAnother(h, f);
      return;
    case WK_PROP:
      fmtProp(h, f);
      return;
    case WK_VAR_DECL:
      fmtVarDecl(h, f);
      return;
    case WK_PARAM:
      fmtParam(h, f);
      return;
    case WK_CASE:
      fmtCase(h, f);
      return;
    case WK_ENUM_MEMBER:
      fmtEnumMember(h, f);
      return;
    case WK_IMPORT_SPEC:
      fmtImportSpec(h, f);
      return;
    case WK_EXPORT_SPEC:
      fmtExportSpec(h, f);
      return;
    case WK_TYPE_PARAM:
      fmtTypeParam(h, f);
      return;
    case WK_TUPLE_ELEM:
      fmtTupleElem(h, f);
      return;
    case WK_TYPE_ANNOTATION:
      fmtTypeAnnotation(h, f);
      return;
    case WK_RETURN_TYPE_OF_FUNCTION_TYPE:
      fmtReturnTypeOfFunctionType(h, f);
      return;
    default:
      fmtTypeOfPredicate(h, f);
      return;
  }
}

/** `x.span()` into `SP` for the handle `h` of kind `wk`. */
export function nodeSpanOf(wk: number, h: number): void {
  switch (wk) {
    case WK_EXPR:
      exprSpan(h);
      return;
    case WK_STMT:
    case WK_STMT_BEFORE_ANOTHER:
      stmtSpan(h);
      return;
    case WK_DECLARATION:
      stmtSpanWithoutExport(h);
      return;
    case WK_TYPE:
      typeSpan(h);
      return;
    case WK_PAT:
      patSpan(h);
      return;
    case WK_PAT_ELEM:
      patElemSpan(h);
      return;
    case WK_PAT_PROP:
      patPropSpan(h);
      return;
    case WK_MEMBER:
    case WK_MEMBER_BEFORE_ANOTHER:
      memberSpan(h);
      return;
    case WK_PROP:
      propSpan(h);
      return;
    case WK_VAR_DECL:
      varDeclSpan(h);
      return;
    case WK_PARAM:
      paramSpan(h);
      return;
    case WK_CASE:
      caseSpan(h);
      return;
    case WK_ENUM_MEMBER:
      enumMemberSpan(h);
      return;
    case WK_IMPORT_SPEC:
      importSpecSpan(h);
      return;
    case WK_EXPORT_SPEC:
      exportSpecSpan(h);
      return;
    case WK_TYPE_PARAM:
      typeParamSpan(h);
      return;
    case WK_TUPLE_ELEM:
      tupleElemSpan(h);
      return;
    default:
      // the three type annotations
      typeAnnotationSpan(h);
      return;
  }
}

/** The `$write(it, f)` of the macros: step 5 of a handle that has no step 4 and 6. */
function writeNodeStep5(wk: number, h: number, f: Formatter): void {
  switch (wk) {
    case WK_MEMBER:
    case WK_MEMBER_BEFORE_ANOTHER:
      writeMember(h, f);
      return;
    case WK_PROP:
      writeProperty(h, f);
      return;
    case WK_VAR_DECL:
      writeVariableDeclarator(h, f);
      return;
    case WK_PARAM:
      writeFormalParameter(h, f);
      return;
    case WK_CASE:
      writeSwitchCase(h, f);
      return;
    case WK_ENUM_MEMBER:
      writeTsEnumMember(h, f);
      return;
    case WK_IMPORT_SPEC:
      writeImportSpecifier(h, f);
      return;
    case WK_EXPORT_SPEC:
      writeExportSpecifier(h, f);
      return;
    case WK_TYPE_PARAM:
      writeTsTypeParameter(h, f);
      return;
    case WK_PAT_PROP:
      writeBindingProperty(h, f);
      return;
    case WK_PAT:
      writeBindingPattern(h, f);
      return;
    case WK_TUPLE_ELEM:
      writeTsTupleElement(h, f);
      return;
    case WK_DECLARATION:
      writeDeclaration(h, f);
      return;
    case WK_STMT:
    case WK_STMT_BEFORE_ANOTHER:
      writeStatement(h, f);
      return;
    case WK_TYPE:
      writeType(h, f);
      return;
    default:
      writeNode(wk, h, f);
      return;
  }
}

// ───────────────────────────── comments around a node ─────────────────────────────

/** The comments after the child of `parent` at `(start, end)`. */
export function writeTrailingCommentsIn(start: number, end: number, pk: number, ph: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  if (cm.nextStart() !== INF && (cxOf(f).src.byteAt(start) === 64 || !cm.firstLeadsWord())) writeTrailingCommentsOfChild(start, end, parentOfRef(pk, ph), f);
}

function writeTrailingCommentsOfChild(start: number, end: number, parent: number, f: Formatter): void {
  spanForComments(parent, f);
  const encStart = SP[0] | 0;
  const encEnd = SP[1] | 0;
  if (cxOf(f).comments.nextStart() < encEnd) {
    const following = followingSpanStartIn(start, end, parent, f.options.flavor);
    formatTrailingComments(encStart, encEnd, start, end, following, f);
  }
}

/**
 * Whether no comment trails a node that is followed by another one in the same list, because there is none, or the next one starts its
 * line: then it leads what follows. This takes no look at what the node is in.
 */
export function noCommentTrailsWhatIsBeforeAnother(cx: JsFormatContext): boolean {
  const cm = cx.comments;
  return !cm.hasUnprinted() || cm.precededByNewline(cm.printedCount);
}

/** The comments after `node` (an `AstNodes`). */
export function writeTrailingCommentsOf(node: number, f: Formatter): void {
  if (cxOf(f).comments.nextStart() === INF) return;
  spanForComments(node, f);
  const s = SP[0] | 0;
  const e = SP[1] | 0;
  writeTrailingCommentsIn(s, e, PK_NODE, node, f);
}

/**
 * Writes a node that never needs parentheses, with the comments around it: Rust `format_node(span, parent, f, write)`. `(pk, ph)`: the
 * parent; `(wk, wh)`: what is written (step 5, see `writeNodeStep5`).
 */
export function formatNode(start: number, end: number, pk: number, ph: number, wk: number, wh: number, f: Formatter): void {
  formatNodeInList(start, end, false, pk, ph, wk, wh, f);
}

/** `format_node`. `isBeforeAnother`: another node follows it in the same list. */
export function formatNodeInList(
  start: number,
  end: number,
  isBeforeAnother: boolean,
  pk: number,
  ph: number,
  wk: number,
  wh: number,
  f: Formatter,
): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    writeNodeStep5(wk, wh, f);
    return;
  }
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) {
    enterNode(start, end, f);
    writeSuppressedNode(start, end, f);
    extendNode(start, end, f);
  } else {
    const outer = enterScope(cx, start, end);
    writeNodeStep5(wk, wh, f);
    leaveScope(cx, outer);
  }
  if (!(isBeforeAnother && noCommentTrailsWhatIsBeforeAnother(cx))) writeTrailingCommentsIn(start, end, pk, ph, f);
}

/**
 * Writes a node whose comments are written by the code that writes the node itself, or its parent. Only `prettier-ignore` is dealt with.
 */
export function formatNodeWithoutComments(start: number, end: number, pk: number, ph: number, wk: number, wh: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet || !cx.comments.isSuppressed(start)) {
    writeNodeStep5(wk, wh, f);
    return;
  }
  formatLeadingComments(start, end, f);
  enterNode(start, end, f);
  writeSuppressedNode(start, end, f);
  extendNode(start, end, f);
  writeTrailingCommentsIn(start, end, pk, ph, f);
}

// ───────────────────────────── names ─────────────────────────────

/**
 * `identifier(ident, parent)`: `ident` as it is written, with the comments around it. A name that is not a node here and is one in
 * ESTree: the `b` of `a.b`, the name of a function, a label. `(atom, pos)`: the `Ident`; `parent`: the node (an `AstNodes`) that it is a
 * name in.
 */
export function identifier(atom: number, pos: number, parent: number, f: Formatter): void {
  identSpan(atom, pos);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const cx = cxOf(f);
  if (cx.isQuiet) {
    f.sourceText(start, end);
    return;
  }
  identifierWithComments(start, end, parent, f);
}

function identifierWithComments(start: number, end: number, parent: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) {
    enterNode(start, end, f);
    writeSuppressedNode(start, end, f);
    extendNode(start, end, f);
  } else {
    const outer = enterScope(cx, start, end);
    f.sourceText(start, end);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_PARENT, parent, f);
}

/** The same for a name where only its span is known (`FormatIdentifier { span, parent }`). */
export function identifierAt(start: number, end: number, parent: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    f.sourceText(start, end);
    return;
  }
  identifierWithComments(start, end, parent, f);
}

// ───────────────────────────── expressions ─────────────────────────────

function isChainTag(tag: number): boolean {
  return tag === EXPR_DOT || tag === EXPR_INDEX || tag === EXPR_CALL || tag === EXPR_NON_NULL;
}

/** `FormatExpr::with_options(e, options)`: steps 4 to 6 (parentheses) around `e`. */
function writeInParentheses(e: number, options: number, isChainExpression: boolean, f: Formatter): void {
  const needsParentheses = isChainExpression ? chainExpressionNeedsParentheses(e, f) : exprNeedsParentheses(e, f);
  if (needsParentheses) f.token(LPAREN);
  if (isChainExpression) {
    writeChainExpression(e, f);
    if (cxOf(f).comments.hasCommentsTrailingLinks) writeCommentsTrailingChainElement(e, f);
  } else {
    writeExpressionThatHasAsked(e, options, f);
  }
  if (needsParentheses) f.token(RPAREN);
}

/** `FormatExpr::with_options`: an expression with options, or without the `ChainExpression` that ESTree has around it. */
export function fmtExprWithOptions(e: number, options: number, f: Formatter): void {
  fmtExprFull(e, options, false, f);
}

/** `FormatExpr::in_chain_expression(e)`: `ChainExpression.expression`: `e` is the whole of an optional chain, and this is the member access or the call that it is. */
export function fmtChainElementExpr(e: number, f: Formatter): void {
  fmtExprFull(e, EO_NONE, true, f);
}

function fmtExprFull(e: number, options: number, isInChainExpression: boolean, f: Formatter): void {
  if (!f.stack.enter()) return;
  const isChainExpression = !isInChainExpression && isChainTag(exprTag(e)) && exprIsChainRoot(e);
  if (cxOf(f).isQuiet) writeInParentheses(e, options, isChainExpression, f);
  else fmtWithComments(e, options, isInChainExpression, isChainExpression, f);
  f.stack.leave();
}

function fmtWithComments(e: number, options: number, isInChainExpression: boolean, isChainExpression: boolean, f: Formatter): void {
  const node = isChainExpression ? mkAn(AN_CHAIN_EXPRESSION, e) : exprAsChainElement(e);
  if (isInChainExpression || !writeTypeCasts(e, node, options, isChainExpression, isInChainExpression, f)) {
    fmtInTypeCasts(e, options, isInChainExpression, isChainExpression, node, f);
  }
}

/** The expression with its comments, in the parentheses of type casts if there are any. Rust `FormatExpr::fmt_in_type_casts`. */
export function fmtInTypeCasts(
  e: number,
  options: number,
  isInChainExpression: boolean,
  isChainExpression: boolean,
  node: number,
  f: Formatter,
): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  exprSpan(e);
  const start = SP[0] | 0;
  const end = SP[1] | 0;

  // ESTree's `Expression`, as opposed to the `ChainElement` in a `ChainExpression`.
  if (!isInChainExpression && cm.hasTrailingSuppressionComment(end)) {
    // The comment trails `a && b` of `a && b // prettier-ignore ⏎ && c`, which Prettier writes without looking at its comments.
    const parent = anParent(node);
    const pt = anTag(parent);
    let trailsParentOperand = false;
    if (pt === AN_LOGICAL_EXPRESSION || pt === AN_BINARY_EXPRESSION) {
      trailsParentOperand = (exprEnd(anId(parent))) === end;
    }
    if (!trailsParentOperand) {
      formatLeadingComments(start, end, f);
      writeSuppressedExpression(e, isChainExpression, f);
      writeTrailingCommentsOf(node, f);
      return;
    }
  }

  // The comments of a JSX element are written with its parentheses.
  const nt = anTag(node);
  if (nt === AN_JSX_ELEMENT || nt === AN_JSX_FRAGMENT) {
    enterNode(start, end, f);
    writeInParentheses(e, options, false, f);
    extendNode(start, end, f);
    return;
  }

  const isSuppressed = cm.isSuppressed(start);
  if (writeCalledFunctionWithComments(e, options, f)) return;
  // Prettier's `canAttachComment`: typescript-estree's `ChainExpression` has no comments. They are those of what is in it, which is in
  // its parentheses.
  if (
    isChainExpression &&
    !isSuppressed &&
    !fileIsJavascript() &&
    !commentsStayOutsideOfParenthesesOfChain(f) &&
    chainExpressionNeedsParentheses(e, f)
  ) {
    f.token(LPAREN);
    formatLeadingComments(start, end, f);
    const outer = enterScope(cx, start, end);
    writeChainExpression(e, f);
    leaveScope(cx, outer);
    writeCommentsTrailingChainElement(e, f);
    writeTrailingCommentsOf(node, f);
    f.token(RPAREN);
    return;
  }
  // `a ? b : /** @type {T} */ (c).d ?? e`
  if (
    !isSuppressed &&
    castCommentGoesIntoAddedParentheses(f) &&
    cx.src.byteAt(start) === 40 &&
    cm.isCastParenthesis(start) &&
    cm.commentsBefore(start) > 0 &&
    (isChainExpression ? chainExpressionNeedsParentheses(e, f) : exprNeedsParentheses(e, f))
  ) {
    const from = cm.from;
    const to = cm.to;
    formatLeadingCommentsRange(from, (to - 1) | 0, f);
    f.token(LPAREN);
    formatLeadingCommentsRange((to - 1) | 0, to, f);
    const outer = enterScope(cx, start, end);
    if (isChainExpression) writeChainExpression(e, f);
    else writeExpressionThatHasAsked(e, options, f);
    leaveScope(cx, outer);
    f.token(RPAREN);
    writeTrailingCommentsOf(node, f);
    return;
  }
  spanThatCommentsLead(e, f);
  formatLeadingComments(SP[0] | 0, SP[1] | 0, f);
  if (isSuppressed) {
    writeSuppressedExpression(e, isChainExpression, f);
  } else {
    const outer = enterScope(cx, start, end);
    writeInParentheses(e, options, isChainExpression, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsOf(node, f);
}

/** `(/* comment *&#47; a?.b).c` is `/* comment *&#47; (a?.b).c` for oxfmt, in TypeScript as in JavaScript. */
function commentsStayOutsideOfParenthesesOfChain(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/**
 * `(a?.b /* comment *&#47;).c`, `(a?.b) /* comment *&#47;.c`: typescript-estree has a `ChainExpression` around `a?.b`, which Prettier attaches no
 * comment to. So the comment trails `a?.b` in it, and is written in the parentheses. Babel has no such node.
 */
function writeCommentsTrailingChainElement(e: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.hasTreeOfBabel) return;
  const end = exprEnd(e);
  const cm = cx.comments;
  // Whoever writes the comments after `e` has hidden them.
  const previousLimit = cm.showCommentsUpTo(end + 1);
  cm.commentsTrailingLink(end);
  formatTrailingCommentsRange(cm.from, cm.to, f);
  cm.restoreViewLimit(previousLimit);
}

/**
 * A type cast comment is about the parentheses right behind it. Where these are at the start of something that gets parentheses of its
 * own, oxfmt writes the comment in them, so that it is still about the same. Prettier writes it before them.
 */
function castCommentGoesIntoAddedParentheses(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** Prettier's `printIgnored` for an expression, in the parentheses that it needs. */
function writeSuppressedExpression(e: number, isChainExpression: boolean, f: Formatter): void {
  exprSpan(e);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  const needsParentheses = isChainExpression ? chainExpressionNeedsParentheses(e, f) : exprNeedsParentheses(e, f);
  // A class expression with decorators is on lines of its own.
  let isDecoratedClass = false;
  if (exprTag(e) === EXPR_CLASS) {
    // TODO(port): `class.decorators().next().is_some()`
    isDecoratedClass = classHasDecorators(e);
  }
  enterNode(start, end, f);
  if (needsParentheses) f.token(LPAREN);
  if (isDecoratedClass) {
    f.startSoftBlockIndent();
    writeSuppressedNode(start, end, f);
    f.endSoftBlockIndent();
  } else {
    writeSuppressedNode(start, end, f);
  }
  if (needsParentheses) f.token(RPAREN);
  extendNode(start, end, f);
}

function classHasDecorators(e: number): boolean {
  const cls = hir.exprA[e] | 0;
  const s = classModifiersStart(cls);
  const n = classModifiersLen(cls);
  for (let i = 0; i < n; i++) if (modifierDecorator(listAt(s, i)) >= 0) return true;
  return false;
}

/** `write!(f, e)` for an expression `e`: comments, parentheses, then the function in `print/` for the kind of expression. */
export function fmtExpr(e: number, f: Formatter): void {
  const cx = cxOf(f);
  if (!cx.isQuiet) {
    fmtExprFull(e, EO_NONE, false, f);
    return;
  }
  const tag = exprTag(e);
  // Nearly half of all expressions are names. The names that can need parentheses have 3 to 9 letters, and are longer only if they are
  // written with escapes, or stand for an expression in a template.
  if (tag === EXPR_IDENT) {
    exprSpan(e);
    const start = SP[0] | 0;
    const end = SP[1] | 0;
    const len = end - start;
    const mayNeedParentheses = len >= 3 && (len <= 9 || len >= 35 || !f.isPlainSource(start, end));
    if (mayNeedParentheses && exprNeedsParentheses(e, f)) fmtExprFull(e, EO_NONE, false, f);
    else f.sourceText(start, end);
    return;
  }
  const isChainExpression = isChainTag(tag) && exprIsChainRoot(e);
  if (isChainExpression || exprNeedsParentheses(e, f)) {
    fmtExprFull(e, EO_NONE, false, f);
    return;
  }
  if (!f.stack.enter()) return;
  writeExpressionOf(tag, e, EO_NONE, f);
  f.stack.leave();
}

/** `FormatNonNullMarks(e)`: every `!` of `x!!`, which is one expression, with the comments between them. */
export function fmtNonNullMarks(e: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  const n = exprInnerNonNullCount(e);
  if (n > 0) {
    const first = exprNonNullEndsFirst(e);
    const wholeEnd = exprEnd(e);
    for (let i = 0; i < n; i++) {
      const nextEnd = i + 1 < n ? hir.nonNullEndEnd[(first + i + 1) | 0] | 0 : wholeEnd;
      f.token(BANG);
      cm.commentsBefore(nextEnd > 0 ? nextEnd - 1 : 0);
      formatTrailingCommentsRange(cm.from, cm.to, f);
    }
  }
  f.token(BANG);
}

/**
 * Step 5 for an expression.
 *
 * This only finds out where to go on. It asks the stack, because some come here without having been through `fmtExpr`: the guard of a
 * case of Flow's `match` has.
 */
export function writeExpression(e: number, options: number, f: Formatter): void {
  if (!f.stack.enter()) return;
  writeExpressionThatHasAsked(e, options, f);
  f.stack.leave();
}

function writeExpressionThatHasAsked(e: number, options: number, f: Formatter): void {
  writeExpressionOf(exprTag(e), e, options, f);
}

/** `tag`: that of `e`. */
function writeExpressionOf(tag: number, e: number, options: number, f: Formatter): void {
  switch (tag) {
    case EXPR_MISSING:
      return;
    case EXPR_IDENT:
    case EXPR_PRIVATE_IDENTIFIER:
      exprSpan(e);
      f.sourceText(SP[0] | 0, SP[1] | 0);
      return;
    case EXPR_THIS:
      f.token(T_THIS);
      return;
    case EXPR_SUPER:
      f.token(T_SUPER);
      return;
    case EXPR_NULL:
      f.token(T_NULL);
      return;
    case EXPR_TRUE:
      f.token(T_TRUE);
      return;
    case EXPR_FALSE:
      f.token(T_FALSE);
      return;
    case EXPR_NUMBER:
      writeNumericLiteral(e, f);
      return;
    case EXPR_STRING:
      if (exprIsJsxText(e)) writeJsxText(e, f);
      else writeStringLiteral(e, f);
      return;
    case EXPR_DOT:
    case EXPR_INDEX:
      writeMemberExpression(e, f);
      return;
    case EXPR_CALL:
      writeCallOf(e, f);
      return;
    case EXPR_NEW:
      writeNewOf(e, f);
      return;
    case EXPR_FN:
      writeFunctionExpression(e, options, f);
      return;
    case EXPR_OBJECT:
      if (exprIsAssignmentTarget(e)) writeObjectAssignmentTarget(e, exprObjectPropsStart(e), exprObjectPropsLen(e), f);
      else writeObjectExpression(e, exprObjectPropsStart(e), exprObjectPropsLen(e), f);
      return;
    case EXPR_ARRAY:
      if (exprIsAssignmentTarget(e)) writeArrayAssignmentTarget(e, exprArrayElemsStart(e), exprArrayElemsLen(e), f);
      else writeArrayExpression(e, exprArrayElemsStart(e), exprArrayElemsLen(e), f);
      return;
    case EXPR_UNARY: {
      const op = exprUnaryOpOf(e);
      const operand = exprOperand(e);
      if (op < 0 || operand < 0) return;
      if (unOpIsUpdate(op)) writeUpdateExpression(op, operand, f);
      else writeUnaryExpression(e, op, operand, f);
      return;
    }
    case EXPR_BINARY:
      if (exprBinaryOpOf(e) === BIN_COMMA) writeSequenceExpression(e, f);
      else writeBinaryLikeExpression(e, f);
      return;
    case EXPR_ASSIGN:
      writeAssignmentExpression(e, f);
      return;
    case EXPR_COND:
      writeConditionalExpression(e, f);
      return;
    default:
      writeLessCommonExpression(e, f);
      return;
  }
}


function writeCallOf(e: number, f: Formatter): void {
  const call = exprAsCallLike(e);
  if (call >= 0) writeCallExpression(e, call, f);
}

function writeNewOf(e: number, f: Formatter): void {
  const call = exprAsCallLike(e);
  if (call >= 0 && !(fileIsFlow() && writeExpressionWithBraces(e, call, f))) writeNewExpression(e, call, f);
}

function writeFunctionExpression(e: number, options: number, f: Formatter): void {
  const fn = exprAsFn(e);
  if (fn < 0) return;
  if (funcIsArrow(fn)) {
    if (eoKind(options) === EO_ARROW) {
      writeArrowFunctionExpression(e, fn, eoAssignmentLayout(options), eoCallArgumentLayout(options), eoCacheMode(options), f);
    } else {
      writeArrowFunctionExpression(e, fn, -1, -1, 0, f);
    }
  } else {
    writeFunction(fn, eoKind(options) === EO_FUNCTION ? eoCacheMode(options) : 0, f);
  }
}

/** The kinds that `writeExpressionOf` does not deal with. */
function writeLessCommonExpression(e: number, f: Formatter): void {
  switch (exprTag(e)) {
    case EXPR_BIG_INT:
      writeBigIntLiteral(e, f);
      return;
    case EXPR_REGEX:
      writeRegExpLiteral(e, f);
      return;
    case EXPR_TEMPLATE:
      writeTemplateLiteral(e, f);
      return;
    case EXPR_TAGGED_TEMPLATE: {
      const call = exprAsCallLike(e);
      writeTaggedTemplateExpression(e, call, f);
      return;
    }
    case EXPR_CLASS:
      writeClass(hir.exprA[e] | 0, f);
      return;
    case EXPR_SPREAD:
      if (exprJsxContainerSpan(e)) writeJsxSpreadChild(e, f);
      else {
        f.token(T_SPREAD);
        fmtExpr(exprSpreadExpr(e), f);
      }
      return;
    case EXPR_AWAIT:
      writeAwaitExpression(e, exprAwaitExpr(e), f);
      return;
    case EXPR_YIELD:
      writeYieldExpression(exprYieldValue(e), exprYieldStar(e) !== 0, f);
      return;
    case EXPR_AS:
    case EXPR_AS_CONST:
      if (exprIsAngleBracketAssertion(e)) {
        if (fileIsFlow()) writeTypeCastExpression(e, f);
        else writeTsTypeAssertion(e, f);
      } else writeAsOrSatisfiesExpression(e, f);
      return;
    case EXPR_SATISFIES:
      writeAsOrSatisfiesExpression(e, f);
      return;
    case EXPR_NON_NULL:
      fmtExpr(exprNonNullExpr(e), f);
      fmtNonNullMarks(e, f);
      return;
    case EXPR_INSTANTIATION:
      fmtExpr(exprInstantiationExpr(e), f);
      typeArguments(exprInstantiationTypeArgsStart(e), exprInstantiationTypeArgsLen(e), nodeOfExpr(e), f);
      return;
    case EXPR_JSX:
      writeJsxElement(e, f);
      return;
    case EXPR_IMPORT_CALL:
      writeImportExpression(e, exprImportCallArgsStart(e), exprImportCallArgsLen(e), f);
      return;
    case EXPR_IMPORT_META:
    case EXPR_NEW_TARGET:
      writeMetaProperty(e, f);
      return;
    default:
      return;
  }
}

// ───────────────────────────── statements ─────────────────────────────

/** `write!(f, statement)` */
export function fmtStmt(s: number, f: Formatter): void {
  formatStatement(s, false, f);
}

/** `FormatStatementBeforeAnother`: a statement that is followed by another one, which can be empty, in the same list. */
export function fmtStmtBeforeAnother(s: number, f: Formatter): void {
  formatStatement(s, true, f);
}

function formatStatement(s: number, isBeforeAnother: boolean, f: Formatter): void {
  if (!f.stack.enter()) return;
  formatStatementInner(s, isBeforeAnother, f);
  f.stack.leave();
}

function formatStatementInner(s: number, isBeforeAnother: boolean, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    writeStatement(s, f);
    return;
  }
  stmtSpan(s);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  if (hasNoCommentsIn(cx, 0, end)) {
    // `// prettier-ignore` on a line of its own after the last statement.
    if (!isBeforeAnother && cx.comments.hasTrailingSuppressionComment(end)) {
      formatStatementWithComments(s, isBeforeAnother, f);
      return;
    }
    const outer = enterScopeWithoutComments(cx, start, end);
    writeStatement(s, f);
    leaveScope(cx, outer);
    if (isBeforeAnother && noCommentTrailsWhatIsBeforeAnother(cx)) return;
    // What the statement is in ends here, and the next comment is behind that.
    if (cx.src.nextNonWhitespaceByteIs(end, 125)) return;
    // The comments between the last statement and the end of a block trail that statement.
    writeTrailingCommentsIn(start, end, WK_STMT, s, f);
    return;
  }
  formatStatementWithComments(s, isBeforeAnother, f);
}

function formatStatementWithComments(s: number, isBeforeAnother: boolean, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const node = stmtAsAstNodes(s);
  spanForComments(node, f);
  let start = SP[0] | 0;
  let end = SP[1] | 0;
  anSpan(node);
  const nodeEnd = SP[1] | 0;
  // Prettier's `locStart`: the decorators of a class can be before its `export`.
  stmtSpan(s);
  const stmtStart = SP[0] | 0;
  if (stmtStart < start) start = stmtStart;
  // The `;` can be behind the comment: `a() // prettier-ignore ⏎ ;`
  if (cm.hasTrailingSuppressionComment(nodeEnd) || (end < nodeEnd && cm.hasTrailingSuppressionComment(end))) {
    formatLeadingComments(start, end, f);
    writeIgnoredStatement(s, start, end, f);
    writeTrailingCommentsOf(node, f);
    return;
  }
  const t = anTag(node);
  if (t === AN_EXPORT_NAMED_DECLARATION || t === AN_EXPORT_DEFAULT_DECLARATION) {
    // Decorators can be written before `export`, and comments before and after them.
    if (cm.isSuppressed(start)) {
      formatLeadingComments(start, end, f);
      writeIgnoredStatement(s, start, end, f);
      writeTrailingCommentsIn(start, end, PK_NODE, node, f);
      return;
    }
    formatNodeWithoutComments(start, end, PK_NODE, node, WK_STMT, s, f);
    return;
  }
  formatDeclarationWithComments(s, isBeforeAnother, f);
}

/**
 * `statement` without its `export`, with the comments around it. `isBeforeAnother`: it has no `export`, and another statement follows it
 * in the same list.
 */
function formatDeclarationWithComments(s: number, isBeforeAnother: boolean, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const isExported = stmtIsExported(s);
  let start = 0;
  let end = 0;
  if (isExported) {
    stmtSpanWithoutExport(s);
    start = SP[0] | 0;
    end = cm.withoutSemicolon(start, SP[1] | 0);
  } else {
    spanForComments(stmtAsAstNodes(s), f);
    start = SP[0] | 0;
    end = SP[1] | 0;
  }
  // parent: `statement.as_ast_nodes()` if exported, else `statement.ast_parent()`
  const pk = isExported ? PK_STMT_OF_EXPORT : WK_STMT;
  if (cm.isSuppressed(start)) {
    formatLeadingComments(start, end, f);
    writeIgnoredStatement(s, start, end, f);
    writeTrailingCommentsIn(start, end, pk, s, f);
    return;
  }
  // format_node_in_list(span, is_before_another, parent, f, |f| { .. })
  if (cx.isQuiet) {
    writeDeclarationWithTrailingCommentsBehindSemicolon(s, end, f);
    return;
  }
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) {
    enterNode(start, end, f);
    writeSuppressedNode(start, end, f);
    extendNode(start, end, f);
  } else {
    const outer = enterScope(cx, start, end);
    writeDeclarationWithTrailingCommentsBehindSemicolon(s, end, f);
    leaveScope(cx, outer);
  }
  if (!(isBeforeAnother && noCommentTrailsWhatIsBeforeAnother(cx))) writeTrailingCommentsIn(start, end, pk, s, f);
}

function writeDeclarationWithTrailingCommentsBehindSemicolon(s: number, end: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  const hiddenFrom = startOfCommentsBehindSemicolon(s, f);
  if (hiddenFrom < 0) {
    writeDeclaration(s, f);
    return;
  }
  const previous = cm.hideCommentsFrom(hiddenFrom);
  writeDeclaration(s, f);
  cm.restoreHiddenComments(previous);
  cm.commentsBefore(end);
  formatTrailingCommentsRange(cm.from, cm.to, f);
}

/** Prettier's `printIgnored` for a statement. `(start, end)`: of the statement, without its `;`, which is written as the options say. */
function writeIgnoredStatement(s: number, start: number, end: number, f: Formatter): void {
  if (terminatorOfWhatIsIgnoredFollowsSemi(f)) {
    writeIgnoredStatementWithoutTerminator(s, start, end, f);
    return;
  }
  stmtSpan(s);
  const stmtEnd = SP[1] | 0;
  let hasSemicolon = false;
  const tag = stmtTag(s);
  if (tag === STMT_VAR && stmtIsExported(s)) {
    stmtSpanWithoutExport(s);
    if (start < (SP[0] | 0)) hasSemicolon = end < stmtEnd;
    else hasSemicolon = true;
  } else if (tag === STMT_BREAK || tag === STMT_CONTINUE || tag === STMT_DEBUGGER || tag === STMT_VAR) {
    hasSemicolon = true;
  } else hasSemicolon = end < stmtEnd;
  if (f.options.semicolons === SEMICOLONS_ALWAYS) {
    enterNode(start, end, f);
    writeSuppressedNode(start, end, f);
    if (hasSemicolon) f.token(T_SEMICOLON);
    extendNode(start, end, f);
    return;
  }
  const needsLeadingSemicolon = tag === STMT_EXPR && expressionStatementNeedsSemicolon(s, stmtExprExpr(s), f);
  enterNode(start, end, f);
  if (needsLeadingSemicolon) f.token(T_SEMICOLON);
  writeSuppressedNode(start, end, f);
  extendNode(start, end, f);
}

/**
 * For oxfmt the `;` at the end of a statement or a member of a class is not part of what a `prettier-ignore` comment protects: it is
 * written, or not, as for any other. Prettier only adds one to a statement that has one, and writes members, type aliases and functions
 * without a body as they are.
 */
export function terminatorOfWhatIsIgnoredFollowsSemi(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** See `terminatorOfWhatIsIgnoredFollowsSemi`. */
function writeIgnoredStatementWithoutTerminator(s: number, start: number, end: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  let contentEnd = end;
  const hasTerminator = endsWithTerminator(s);
  if (hasTerminator) {
    stmtSpan(s);
    contentEnd = cm.withoutSemicolon(start, SP[1] | 0);
  }
  if (f.options.semicolons === SEMICOLONS_ALWAYS) {
    enterNode(start, contentEnd, f);
    writeSuppressedNode(start, contentEnd, f);
    if (hasTerminator) f.token(T_SEMICOLON);
    extendNode(start, contentEnd, f);
    return;
  }
  // The text can start with a parenthesis that would not be written.
  const needsLeadingSemicolon =
    stmtTag(s) === STMT_EXPR && (cxOf(f).src.byteAt(start) === 40 || expressionStatementNeedsSemicolon(s, stmtExprExpr(s), f));
  enterNode(start, contentEnd, f);
  if (needsLeadingSemicolon) f.token(T_SEMICOLON);
  writeSuppressedNode(start, contentEnd, f);
  extendNode(start, contentEnd, f);
}

/** Whether `statement` is written with a `;` at its end, if semicolons are. */
function endsWithTerminator(statement: number): boolean {
  // The `;` after the declaration in the head of a loop separates.
  const parent = stmtParent(statement);
  if (nodeKind(parent) === N_STMT) {
    const p = nodeId(parent);
    const t = stmtTag(p);
    let body = -1;
    if (t === STMT_FOR) body = stmtForBody(p);
    else if (t === STMT_FOR_IN) body = stmtForInBody(p);
    else if (t === STMT_FOR_OF) body = stmtForOfBody(p);
    if (body >= 0) {
      stmtSpan(statement);
      const end = SP[1] | 0;
      stmtSpan(body);
      if (end <= (SP[0] | 0)) return false;
    }
  }
  let last = statement;
  while (true) {
    switch (stmtTag(last)) {
      case STMT_IF: {
        const no = stmtIfNo(last);
        last = no >= 0 ? no : stmtIfYes(last);
        break;
      }
      case STMT_FOR:
        last = stmtForBody(last);
        break;
      case STMT_FOR_IN:
        last = stmtForInBody(last);
        break;
      case STMT_FOR_OF:
        last = stmtForOfBody(last);
        break;
      case STMT_WHILE:
        last = stmtWhileBody(last);
        break;
      case STMT_BLOCK:
        if (stmtIsWith(last)) {
          last = stmtWithBody(last);
          break;
        }
        return endsBeforeSemicolon(last);
      case STMT_LABELED:
        last = stmtLabeledBody(last);
        break;
      case STMT_TYPE_ALIAS:
      case STMT_IMPORT_EQUALS:
      case STMT_EXPORT_ASSIGN:
      case STMT_EXPORT_AS_NAMESPACE:
        return true;
      case STMT_FN:
        return !funcHasBody(stmtFnFn(last));
      default:
        return endsBeforeSemicolon(last);
    }
  }
}

/** `FormatDeclaration(stmt)`: `ExportNamedDeclaration.declaration`, `ExportDefaultDeclaration.declaration`: the statement without its `export`. */
export function fmtDeclaration(s: number, f: Formatter): void {
  if (cxOf(f).isQuiet) writeDeclaration(s, f);
  else formatDeclarationWithComments(s, false, f);
}

/** Step 5 for a statement. */
export function writeStatement(s: number, f: Formatter): void {
  const tag = stmtTag(s);
  const isDeclaration = tag !== STMT_EXPORT_NAMED && tag !== STMT_EXPORT_DEFAULT && tag !== STMT_EXPORT_STAR;
  if (isDeclaration && stmtModifiersLen(s) > 0 && stmtIsExported(s)) writeExportedDeclaration(s, f);
  else writeDeclaration(s, f);
}

/** Step 5 for a statement, without its `export`. */
export function writeDeclaration(s: number, f: Formatter): void {
  switch (stmtTag(s)) {
    case STMT_EMPTY:
      writeEmptyStatement(s, f);
      return;
    case STMT_DEBUGGER:
      f.token(T_DEBUGGER);
      optionalSemicolon(f);
      return;
    case STMT_EXPR: {
      const e = stmtExprExpr(s);
      if (exprTag(e) === EXPR_STRING && stmtDirectiveSpan(s)) writeDirective(s, f);
      else writeExpressionStatement(s, e, f);
      return;
    }
    case STMT_VAR:
      writeVariableDeclaration(s, stmtVarDeclsStart(s), stmtVarDeclsLen(s), f);
      return;
    case STMT_FN:
      writeFunction(stmtFnFn(s), 0, f);
      return;
    case STMT_CLASS:
      writeClass(stmtClassClass(s), f);
      return;
    case STMT_INTERFACE:
      writeTsInterfaceDeclaration(s, stmtInterfaceInterface(s), f);
      return;
    case STMT_TYPE_ALIAS:
      writeTsTypeAliasDeclaration(s, stmtTypeAliasAlias(s), f);
      return;
    case STMT_ENUM:
      writeTsEnumDeclaration(s, stmtEnumEnum(s), f);
      return;
    case STMT_MODULE:
      writeTsModuleDeclaration(s, stmtModuleModule(s), f);
      return;
    case STMT_RETURN:
      writeReturnStatement(s, stmtReturnExpr(s), f);
      return;
    case STMT_IF:
      writeIfStatement(s, stmtIfTest(s), stmtIfYes(s), stmtIfNo(s), f);
      return;
    case STMT_FOR:
      writeForStatement(s, stmtForInit(s), stmtForTest(s), stmtForUpdate(s), stmtForBody(s), f);
      return;
    case STMT_FOR_IN:
      writeForInStatement(s, stmtForInLeft(s), stmtForInExpr(s), stmtForInBody(s), f);
      return;
    case STMT_FOR_OF:
      writeForOfStatement(s, stmtForOfLeft(s), stmtForOfExpr(s), stmtForOfBody(s), stmtForOfIsAwait(s) !== 0, f);
      return;
    case STMT_WHILE:
      writeWhileStatement(s, stmtWhileTest(s), stmtWhileBody(s), f);
      return;
    case STMT_DO_WHILE:
      writeDoWhileStatement(s, stmtDoWhileBody(s), stmtDoWhileTest(s), f);
      return;
    case STMT_BLOCK:
      if (stmtIsWith(s)) writeWithStatement(s, stmtWithObject(s), stmtWithBody(s), f);
      else writeBlockStatement(s, stmtBlockStmtsStart(s), stmtBlockStmtsLen(s), f);
      return;
    case STMT_SWITCH:
      writeSwitchStatement(s, stmtSwitchExpr(s), stmtSwitchCasesStart(s), stmtSwitchCasesLen(s), f);
      return;
    case STMT_TRY:
      writeTryStatement(s, stmtTryBlock(s), stmtTryParam(s), stmtTryHandler(s), stmtTryFinalizer(s), f);
      return;
    case STMT_THROW:
      writeThrowStatement(s, stmtThrowExpr(s), f);
      return;
    case STMT_BREAK:
      writeBreakStatement(s, f);
      return;
    case STMT_CONTINUE:
      writeContinueStatement(s, f);
      return;
    case STMT_LABELED:
      writeLabeledStatement(s, stmtLabeledBody(s), f);
      return;
    case STMT_IMPORT:
      writeImportDeclaration(s, stmtImportImport(s), f);
      return;
    case STMT_IMPORT_EQUALS:
      writeTsImportEqualsDeclaration(s, stmtImportEqualsImportEquals(s), f);
      return;
    case STMT_EXPORT_NAMED:
      writeExportNamedDeclaration(s, stmtExportNamedExport(s), f);
      return;
    case STMT_EXPORT_STAR:
      writeExportAllDeclaration(s, f);
      return;
    case STMT_EXPORT_DEFAULT:
      writeExportDefaultExpression(s, stmtExportDefaultExpr(s), f);
      return;
    case STMT_EXPORT_ASSIGN:
      writeTsExportAssignment(stmtExportAssignExpr(s), f);
      return;
    case STMT_EXPORT_AS_NAMESPACE:
      writeTsNamespaceExportDeclaration(s, f);
      return;
    default:
      return;
  }
}

// ───────────────────────────── types ─────────────────────────────

/** `write!(f, ty)` */
export function fmtType(ty: number, f: Formatter): void {
  if (!f.stack.enter()) return;
  if (cxOf(f).isQuiet) writeTypeInParentheses(ty, f);
  else formatTypeWithComments(ty, f);
  f.stack.leave();
}

function writeTypeInParentheses(ty: number, f: Formatter): void {
  const tag = typeTag(ty);
  if (tag === TYPE_KEYWORD || tag === TYPE_BOOL_LIT) {
    typeSpan(ty);
    f.sourceText(SP[0] | 0, SP[1] | 0);
    return;
  }
  // No other kind of type ever needs parentheses. Flow's `renders T` writes its own.
  const needsParentheses =
    (tag === TYPE_FN ||
      tag === TYPE_INFER ||
      tag === TYPE_UNION ||
      tag === TYPE_INTERSECTION ||
      tag === TYPE_COND ||
      tag === TYPE_KEYOF ||
      tag === TYPE_READONLY ||
      tag === TYPE_UNIQUE_SYMBOL ||
      tag === TYPE_UNIQUE ||
      tag === TYPE_TYPEOF ||
      tag === TYPE_IMPORT) &&
    !(tag === TYPE_UNIQUE && fileIsFlow()) &&
    typeNeedsParentheses(ty, f);
  if (needsParentheses) f.token(LPAREN);
  writeType(ty, f);
  if (needsParentheses) f.token(RPAREN);
}

function formatTypeWithComments(ty: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  typeSpan(ty);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  // A union writes the comments before it with its first `|`, and deals with `prettier-ignore`.
  const isUnion = typeTag(ty) === TYPE_UNION;
  let isSuppressed = false;
  if (isUnion && !prettierIgnoreBeforeUnionIsAboutAllOfIt(f)) {
    // On a line of its own it is about the first type only.
    const lim = cm.limit();
    for (let i = cm.printedCount; i < lim && (cm.ce[i] | 0) <= start; i++) {
      if (cm.isSuppressionComment(i) && !cm.precededByNewline(i)) {
        isSuppressed = true;
        break;
      }
    }
  } else isSuppressed = cm.isSuppressed(start);
  if (!isUnion || isSuppressed) {
    formatLeadingComments(start, end, f);
  } else if (commentsStayOutsideOfParenthesesOfUnion(f) && typeNeedsParentheses(ty, f)) {
    // Those before a `(` of the source, and after them those that start their line.
    cm.commentsBefore(start);
    const from = cm.from;
    const to = cm.to;
    let count = 0;
    for (let index = to - 1; index >= from; index--) {
      const next = index + 1 < to ? cm.spanStart[index + 1] | 0 : start;
      if (cx.src.containsByte(cm.spanEnd[index] | 0, next, 40)) {
        count = (index - from + 1) | 0;
        break;
      }
    }
    while (from + count < to && cm.precededByNewline(from + count)) count = (count + 1) | 0;
    formatLeadingCommentsRange(from, from + count, f);
  }
  if (isSuppressed) {
    const needsParentheses = typeNeedsParentheses(ty, f);
    enterNode(start, end, f);
    if (needsParentheses) f.token(LPAREN);
    writeSuppressedNode(start, end, f);
    if (needsParentheses) f.token(RPAREN);
    extendNode(start, end, f);
  } else {
    const outer = enterScope(cx, start, end);
    writeTypeInParentheses(ty, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, WK_TYPE, ty, f);
}

/**
 * `keyof /* comment *&#47; (A | B)`: for oxfmt the comment stays on the side of the `(` that it is on. Prettier writes the comments of a union
 * in its parentheses.
 */
function commentsStayOutsideOfParenthesesOfUnion(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** Step 5 for a type. */
export function writeType(ty: number, f: Formatter): void {
  switch (typeTag(ty)) {
    case TYPE_ERROR:
    case TYPE_JSDOC:
      if (fileIsFlow() && writeNullableTypeOrTypeOperator(ty, f)) return;
      typeSpan(ty);
      writeSuppressedNode(SP[0] | 0, SP[1] | 0, f);
      return;
    case TYPE_HERITAGE:
      fmtExpr(typeHeritageExpr(ty), f);
      typeArguments(typeHeritageArgsStart(ty), typeHeritageArgsLen(ty), nodeOfType(ty), f);
      return;
    case TYPE_KEYWORD:
    case TYPE_BOOL_LIT:
      typeSpan(ty);
      f.sourceText(SP[0] | 0, SP[1] | 0);
      return;
    case TYPE_REF:
      writeTsTypeReference(ty, typeRefNameStart(ty), typeRefNameLen(ty), typeRefArgsStart(ty), typeRefArgsLen(ty), f);
      return;
    case TYPE_STRING_LIT:
    case TYPE_NUMBER_LIT:
    case TYPE_BIG_INT_LIT:
      writeTsLiteralType(ty, f);
      return;
    case TYPE_TEMPLATE:
      writeTsTemplateLiteralType(ty, f);
      return;
    case TYPE_ARRAY:
      if (fileIsFlow()) writeArrayType(ty, typeArrayElem(ty), f);
      else {
        fmtType(typeArrayElem(ty), f);
        f.token(T_ARRAY_BRACKETS);
      }
      return;
    case TYPE_TUPLE:
      writeTsTupleType(ty, typeTupleElemsStart(ty), typeTupleElemsLen(ty), f);
      return;
    case TYPE_UNION:
      writeTsUnionType(ty, typeUnionTypesStart(ty), typeUnionTypesLen(ty), f);
      return;
    case TYPE_INTERSECTION:
      writeTsIntersectionType(ty, typeIntersectionTypesStart(ty), typeIntersectionTypesLen(ty), f);
      return;
    case TYPE_FN:
      writeTsFunctionType(ty, typeFnFn(ty), f);
      return;
    case TYPE_OBJECT:
      writeTsTypeLiteral(ty, typeObjectMembersStart(ty), typeObjectMembersLen(ty), f);
      return;
    case TYPE_COND:
      writeTsConditionalType(ty, f);
      return;
    case TYPE_INFER:
      f.token(T_INFER);
      f.space();
      fmtTypeParam(typeInferParam(ty), f);
      return;
    case TYPE_MAPPED:
      writeTsMappedType(ty, typeMappedMapped(ty), f);
      return;
    case TYPE_INDEXED_ACCESS:
      if (fileIsFlow()) writeIndexedAccessType(ty, typeIndexedAccessObj(ty), typeIndexedAccessIndex(ty), f);
      else {
        fmtType(typeIndexedAccessObj(ty), f);
        f.token(T_LBRACKET);
        fmtType(typeIndexedAccessIndex(ty), f);
        f.token(T_RBRACKET);
      }
      return;
    case TYPE_KEYOF:
      f.token(T_KEYOF);
      f.space();
      fmtType(typeKeyofTy(ty), f);
      return;
    case TYPE_READONLY:
      f.token(T_READONLY);
      f.space();
      fmtType(typeReadonlyTy(ty), f);
      return;
    case TYPE_UNIQUE_SYMBOL:
      f.token(T_UNIQUE);
      f.space();
      f.token(T_SYMBOL);
      return;
    case TYPE_UNIQUE:
      if (fileIsFlow() && writeNullableTypeOrTypeOperator(ty, f)) return;
      f.token(T_UNIQUE);
      f.space();
      fmtType(typeUniqueTy(ty), f);
      return;
    case TYPE_TYPEOF:
      writeTsTypeQuery(ty, typeTypeofExpr(ty), typeTypeofArgsStart(ty), typeTypeofArgsLen(ty), f);
      return;
    case TYPE_IMPORT:
      writeTsImportType(ty, f);
      return;
    case TYPE_PREDICATE:
      writeTsTypePredicate(ty, f);
      return;
    default:
      return;
  }
}

/** ESTree's `TSTypeAnnotation` around `ty`, which is written after `mark` (a token handle, 0: none) and a space. */
function formatTypeAnnotationWith(mark: number, ty: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    // These start with text, so that the space is written in any case.
    const tag = typeTag(ty);
    const startsWithText =
      tag === TYPE_KEYWORD ||
      tag === TYPE_BOOL_LIT ||
      tag === TYPE_REF ||
      tag === TYPE_STRING_LIT ||
      tag === TYPE_NUMBER_LIT ||
      tag === TYPE_OBJECT ||
      tag === TYPE_TUPLE;
    if (mark === T_COLON && startsWithText) {
      f.token(T_COLON_SPACE);
      fmtType(ty, f);
      return;
    }
    writeMarkAndType(mark, ty, f);
    return;
  }
  // Flow has no node that starts at the `=>`: the comments before it lead the type.
  if (mark === T_ARROW && fileIsFlow()) {
    writeMarkAndType(mark, ty, f);
    return;
  }
  const node = mkAn(AN_TS_TYPE_ANNOTATION, ty);
  anSpan(node);
  const start = SP[0] | 0;
  const end = SP[1] | 0;
  if (cx.comments.hasCommentBefore(start) && !(commentSticksToNameOfVariable(f) && isVariableDeclaratorParent(node))) f.space();
  formatNodeThen(start, end, node, mark, ty, f);
}

function isVariableDeclaratorParent(node: number): boolean {
  return anTag(anParent(node)) === AN_VARIABLE_DECLARATOR;
}

function writeMarkAndType(mark: number, ty: number, f: Formatter): void {
  if (mark !== 0) {
    f.token(mark);
    f.space();
  }
  fmtType(ty, f);
}

/** `format_node(node.span(), || node.parent(), f, |f| write)` for a type annotation. */
function formatNodeThen(start: number, end: number, node: number, mark: number, ty: number, f: Formatter): void {
  const cx = cxOf(f);
  const cm = cx.comments;
  const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
  formatLeadingComments(start, end, f);
  if (isSuppressed) {
    enterNode(start, end, f);
    writeSuppressedNode(start, end, f);
    extendNode(start, end, f);
  } else {
    const outer = enterScope(cx, start, end);
    writeMarkAndType(mark, ty, f);
    leaveScope(cx, outer);
  }
  writeTrailingCommentsIn(start, end, PK_NODE, node, f);
}

/** `const a /* comment *&#47; : T = 1` is `const a/* comment *&#47; : T = 1` for oxfmt. */
function commentSticksToNameOfVariable(f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT;
}

/** `FormatTypeAnnotation(ty)`: `: T` */
export function fmtTypeAnnotation(ty: number, f: Formatter): void {
  formatTypeAnnotationWith(T_COLON, ty, f);
}
/** `FormatReturnTypeOfFunctionType(ty)`: `=> T`: the return type of a function type or a constructor type. */
export function fmtReturnTypeOfFunctionType(ty: number, f: Formatter): void {
  formatTypeAnnotationWith(T_ARROW, ty, f);
}
/** `FormatTypeOfPredicate(ty)`: the `T` of `a is T`. */
export function fmtTypeOfPredicate(ty: number, f: Formatter): void {
  formatTypeAnnotationWith(0, ty, f);
}

// ───────────────────────────── everything else ─────────────────────────────

function formatWithComments(wk: number, h: number, f: Formatter, isBeforeAnother: boolean): void {
  if (cxOf(f).isQuiet) {
    writeNodeStep5(wk, h, f);
    return;
  }
  nodeSpanOf(wk, h);
  formatNodeInList(SP[0] | 0, SP[1] | 0, isBeforeAnother, wk, h, wk, h, f);
}

export function fmtMember(m: number, f: Formatter): void {
  formatWithComments(WK_MEMBER, m, f, false);
}
/** `FormatMemberBeforeAnother`: a member that is followed by another one. */
export function fmtMemberBeforeAnother(m: number, f: Formatter): void {
  formatWithComments(WK_MEMBER_BEFORE_ANOTHER, m, f, true);
}
export function fmtProp(p: number, f: Formatter): void {
  formatWithComments(WK_PROP, p, f, false);
}
export function fmtVarDecl(d: number, f: Formatter): void {
  formatWithComments(WK_VAR_DECL, d, f, false);
}
export function fmtParam(p: number, f: Formatter): void {
  formatWithComments(WK_PARAM, p, f, false);
}
export function fmtCase(c: number, f: Formatter): void {
  formatWithComments(WK_CASE, c, f, false);
}
export function fmtEnumMember(m: number, f: Formatter): void {
  formatWithComments(WK_ENUM_MEMBER, m, f, false);
}
export function fmtImportSpec(s: number, f: Formatter): void {
  formatWithComments(WK_IMPORT_SPEC, s, f, false);
}
export function fmtExportSpec(s: number, f: Formatter): void {
  formatWithComments(WK_EXPORT_SPEC, s, f, false);
}
export function fmtTypeParam(p: number, f: Formatter): void {
  formatWithComments(WK_TYPE_PARAM, p, f, false);
}
export function fmtPatProp(p: number, f: Formatter): void {
  formatWithComments(WK_PAT_PROP, p, f, false);
}
export function fmtPat(p: number, f: Formatter): void {
  formatWithComments(WK_PAT, p, f, false);
}

/** An element of an array pattern: `a`, `a = 1`, `...a`. A hole writes nothing. */
export function fmtPatElem(el: number, f: Formatter): void {
  writeArrayPatternElement(el, f);
}

/** An element of a tuple type. */
export function fmtTupleElem(el: number, f: Formatter): void {
  // One that is only a type is that type.
  if (tupleElemName(el) < 0 && !tupleElemIsRest(el) && !tupleElemIsOptional(el)) {
    fmtType(tupleElemTy(el), f);
    return;
  }
  if (cxOf(f).isQuiet) {
    writeTsTupleElement(el, f);
    return;
  }
  tupleElemSpan(el);
  formatNodeInList(SP[0] | 0, SP[1] | 0, false, WK_TUPLE_ELEM, el, WK_TUPLE_ELEM, el, f);
}

