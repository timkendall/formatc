// Port of vendor/bun/src/format/js/ast_nodes.rs: the syntax tree as oxc and Prettier see it, for questions about what is around a node.
//
// Rust's `AstNodes<'a>` is an enum with one field per variant (the handle). Here it is ONE Int32:
//
//     an = (tag << 23) | id          tag = anTag(an) (AN_*, < 256)      id = anId(an) (< 2^23)
//
// `id` is the row of the handle in its table (an ExprId for `AN_CALL_EXPRESSION`, a StmtId for `AN_IF_STATEMENT`, a FnId for
// `AN_FUNCTION`, ...). A file with 2^23 (8M) or more rows in a table is refused by `formatFile` (mod.ts). `NONE` (-1) is `Option::None`.
// Equal values are equal nodes (`==` on `AstNodes`).
//
// Variants whose Rust field is a `Node` or an enum get one tag per kind of payload:
//   SpreadElement(Node::Expr | Node::Prop)          AN_SPREAD_ELEMENT_EXPR / AN_SPREAD_ELEMENT_PROP         (`anIsSpreadElement`)
//   ExpressionStatement(Stmt | ArrowBody(Func))     AN_EXPRESSION_STATEMENT (StmtId) / AN_ARROW_BODY_EXPRESSION_STATEMENT (FnId)
//                                                                                                           (`anIsExpressionStatement`)
//   AssignmentPattern(Node::PatProp | PatElem)      AN_ASSIGNMENT_PATTERN_PROP / AN_ASSIGNMENT_PATTERN_ELEM  (`anIsAssignmentPattern`)
//   BindingRestElement(Node::PatProp | PatElem)     AN_BINDING_REST_ELEMENT_PROP / AN_BINDING_REST_ELEMENT_ELEM (`anIsBindingRestElement`)
//   TSTypeParameterInstantiation(owner)             AN_TS_TYPE_PARAMETER_INSTANTIATION_{EXPR,TYPE,CLASS}   (`anIsTypeParameterInstantiation`)
//   TSTypeParameterDeclaration(owner)               AN_TS_TYPE_PARAMETER_DECLARATION_{FUNC,CLASS,STMT,TYPE} (`anIsTypeParameterDeclaration`)
//
// Rust                                         TS
//   e.as_ast_nodes()                           exprAsAstNodes(e)         (stmtAsAstNodes, typeAsAstNodes, funcAsAstNodes, ...)
//   e.ast_parent()                             exprAstParent(e)          (stmtAstParent, typeAstParent, patAstParent, ...)
//   e.as_chain_element()                       exprAsChainElement(e)
//   node.parent()                              anParent(an)
//   node.span()                                anSpan(an)  -> SP         (anStart(an), anEnd(an))
//   node.ancestors()                           for (let a = an; ; a = anParent(a)) { ..; if (anTag(a) === AN_PROGRAM) break; }
//   node.without_chain_expression()            anWithoutChainExpression(an)
//   node.is_call_like_callee(e)                anIsCallLikeCallee(an, e)
//   matches!(n, AstNodes::X(_))                anTag(n) === AN_X
//   matches!(n, AstNodes::X(h) if ..)          anTag(n) === AN_X && ..(anId(n))
import {
  BIN_AND,
  BIN_COMMA,
  BIN_IN,
  BIN_NULLISH,
  BIN_OR,
  BODY_EXPR,
  EXPR_ARRAY,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_BIG_INT,
  EXPR_BINARY,
  EXPR_ASSIGN,
  EXPR_CALL,
  EXPR_CLASS,
  EXPR_COND,
  EXPR_AWAIT,
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
  FLAG_ACCESSOR,
  FLAG_DEFAULT,
  FLAG_EXPORT,
  FN_ARROW,
  FN_CONSTRUCTOR_TYPE,
  FN_INDEX_SIGNATURE,
  FN_STATIC_BLOCK,
  KW_THIS,
  MEMBER_CALL_SIGNATURE,
  MEMBER_CONSTRUCT_SIGNATURE,
  MEMBER_INDEX_SIGNATURE,
  MEMBER_PROPERTY,
  MEMBER_STATIC_BLOCK,
  MODNAME_GLOBAL,
  N_CASE,
  N_CLASS,
  N_ENUM_MEMBER,
  N_EXPORT_SPEC,
  N_EXPR,
  N_FILE,
  N_FUNC,
  N_IMPORT_SPEC,
  N_MEMBER,
  N_PARAM,
  N_PAT,
  N_PAT_ELEM,
  N_PAT_PROP,
  N_PROP,
  N_STMT,
  N_TUPLE_ELEM,
  N_TYPE,
  N_TYPE_PARAM,
  N_VAR_DECL,
  NODE_FILE,
  PAT_ARRAY,
  PAT_OBJECT,
  PROP_SHORTHAND,
  PROP_SPREAD,
  SP,
  STMT_BLOCK,
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
  STMT_CLASS,
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
  STMT_BREAK,
  STMT_CONTINUE,
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
  UN_POST_DEC,
  UN_POST_INC,
  UN_PRE_DEC,
  UN_PRE_INC,
  aliasTypeParamsLen,
  aliasTypeParamsStart,
  callTypeArgsLen,
  callTypeArgsStart,
  caseParent,
  caseSpan,
  classEstreeSpan,
  classExtends,
  classExtendsArgsLen,
  classExtendsArgsStart,
  classImplementsLen,
  classImplementsStart,
  classOwner,
  classTypeParamsLen,
  classTypeParamsStart,
  classBodySpan,
  enumBodySpan,
  enumMemberParent,
  enumMemberSpan,
  exportSpecExport,
  exportSpecSpan,
  exportStmt,
  exprAsCallLike,
  exprAsClass,
  exprAsFn,
  exprAssignOpOf,
  exprBinaryOpOf,
  exprCallee,
  exprIsAngleBracketAssertion,
  exprIsAssignmentTarget,
  exprIsChainRoot,
  exprIsJsxText,
  exprIsParenthesized,
  exprIsPrivateMember,
  exprJsxContainerSpan,
  exprLeft,
  exprOuterSpan,
  exprParent,
  exprSpan,
  exprStart,
  exprEnd,
  exprTag,
  exprUnaryOpOf,
  exprInstantiationTypeArgsLen,
  exprInstantiationTypeArgsStart,
  funcBodyExpr,
  funcBodyKind,
  funcBodySpan,
  funcEstreeSpan,
  funcKind,
  funcOwner,
  funcParamsSpan,
  funcSpan,
  funcThisParam,
  funcTypeParamsLen,
  funcTypeParamsStart,
  importSpecImport,
  importSpecSpan,
  importStmt,
  interfaceBodySpan,
  interfaceTypeParamsLen,
  interfaceTypeParamsStart,
  jsxIsFragment,
  jsxOpeningSpan,
  jsxTypeArgsLen,
  jsxTypeArgsStart,
  listAt,
  memberFlags,
  memberKind,
  memberModifiersLen,
  memberModifiersStart,
  memberParent,
  memberSpan,
  modifierDecorator,
  moduleBodySpan,
  moduleInnermost,
  moduleNameKind,
  nodeId,
  nodeKind,
  nodeOf,
  paramDefault,
  paramFuncOf,
  paramIsRest,
  paramSpan,
  patPropDefault,
  patPropIsRest,
  patPropParent,
  patPropSpan,
  patPropValue,
  patElemDefault,
  patElemIsRest,
  patElemParent,
  patElemPat,
  patElemSpan,
  patParent,
  patSpan,
  patTag,
  propIsJsxAttribute,
  propKind,
  propParent,
  propSpan,
  propValue,
  skipTriviaBack,
  typeTag,
  stmtDirectiveSpan,
  stmtIsWith,
  stmtExportSpan,
  stmtFlags,
  stmtCatchClauseSpan,
  stmtModuleModule,
  stmtExprExpr,
  stmtFnFn,
  stmtClassClass,
  stmtInterfaceInterface,
  stmtTypeAliasAlias,
  stmtEnumEnum,
  nodeSpan,
  stmtParent,
  stmtSpan,
  stmtSpanWithoutExport,
  stmtTag,
  stmtTryHandler,
  tupleElemIsOptional,
  tupleElemIsRest,
  tupleElemName,
  tupleElemParent,
  tupleElemSpan,
  typeAnnotationSpan,
  typeFnFn,
  typeImportArgsLen,
  typeImportArgsStart,
  typeImportFlags,
  typeKeywordKeyword,
  typeListAngleBrackets,
  typeParamListAngleBrackets,
  typeParamParent,
  typeParamSpan,
  typeParent,
  typeRefArgsLen,
  typeRefArgsStart,
  typeHeritageArgsLen,
  typeHeritageArgsStart,
  typeSpan,
  typeTypeofArgsLen,
  typeTypeofArgsStart,
  varDeclParent,
  varDeclSpan,
  hir,
  fileIsFlow,
} from "../../lint/ast/index.ts";
import { arrowBehindParameters, isDeclaredClass, isFlowDeclareExport } from "./print/flow.ts";
import { jsState } from "./state.ts";

// program
export const AN_PROGRAM: number = 0;
// expr
export const AN_IDENTIFIER_REFERENCE: number = 1;
export const AN_BOOLEAN_LITERAL: number = 2;
export const AN_NULL_LITERAL: number = 3;
export const AN_NUMERIC_LITERAL: number = 4;
export const AN_BIG_INT_LITERAL: number = 5;
export const AN_REG_EXP_LITERAL: number = 6;
export const AN_STRING_LITERAL: number = 7;
export const AN_TEMPLATE_LITERAL: number = 8;
export const AN_THIS_EXPRESSION: number = 9;
export const AN_SUPER: number = 10;
export const AN_ARRAY_EXPRESSION: number = 11;
export const AN_OBJECT_EXPRESSION: number = 12;
export const AN_STATIC_MEMBER_EXPRESSION: number = 13;
export const AN_COMPUTED_MEMBER_EXPRESSION: number = 14;
export const AN_PRIVATE_FIELD_EXPRESSION: number = 15;
export const AN_CALL_EXPRESSION: number = 16;
export const AN_NEW_EXPRESSION: number = 17;
export const AN_IMPORT_EXPRESSION: number = 18;
export const AN_META_PROPERTY: number = 19;
export const AN_TAGGED_TEMPLATE_EXPRESSION: number = 20;
export const AN_UNARY_EXPRESSION: number = 21;
export const AN_UPDATE_EXPRESSION: number = 22;
export const AN_BINARY_EXPRESSION: number = 23;
export const AN_LOGICAL_EXPRESSION: number = 24;
export const AN_PRIVATE_IN_EXPRESSION: number = 25;
export const AN_ASSIGNMENT_EXPRESSION: number = 26;
export const AN_CONDITIONAL_EXPRESSION: number = 27;
export const AN_AWAIT_EXPRESSION: number = 28;
export const AN_YIELD_EXPRESSION: number = 29;
export const AN_TS_AS_EXPRESSION: number = 30;
export const AN_TS_SATISFIES_EXPRESSION: number = 31;
export const AN_TS_TYPE_ASSERTION: number = 32;
export const AN_TS_NON_NULL_EXPRESSION: number = 33;
export const AN_TS_INSTANTIATION_EXPRESSION: number = 34;
export const AN_TYPE_CAST_EXPRESSION: number = 35;
export const AN_JSX_ELEMENT: number = 36;
export const AN_JSX_FRAGMENT: number = 37;
export const AN_JSX_TEXT: number = 38;
export const AN_JSX_EMPTY_EXPRESSION: number = 39;
export const AN_ELISION: number = 40;
export const AN_PRIVATE_IDENTIFIER: number = 41;
export const AN_SEQUENCE_EXPRESSION: number = 42;
export const AN_CHAIN_EXPRESSION: number = 43;
export const AN_JSX_EXPRESSION_CONTAINER: number = 44;
export const AN_JSX_SPREAD_CHILD: number = 45;
export const AN_JSX_OPENING_ELEMENT: number = 46;
export const AN_DECORATOR: number = 47;
export const AN_ARRAY_ASSIGNMENT_TARGET: number = 48;
export const AN_OBJECT_ASSIGNMENT_TARGET: number = 49;
export const AN_ASSIGNMENT_TARGET_WITH_DEFAULT: number = 50;
export const AN_ASSIGNMENT_TARGET_REST: number = 51;
// spread
export const AN_SPREAD_ELEMENT_EXPR: number = 52;
export const AN_SPREAD_ELEMENT_PROP: number = 53;
// exprstmt
export const AN_EXPRESSION_STATEMENT: number = 54;
export const AN_ARROW_BODY_EXPRESSION_STATEMENT: number = 55;
// func
export const AN_FUNCTION: number = 56;
export const AN_ARROW_FUNCTION_EXPRESSION: number = 57;
export const AN_FUNCTION_BODY: number = 58;
export const AN_FORMAL_PARAMETERS: number = 59;
// class
export const AN_CLASS: number = 60;
export const AN_CLASS_BODY: number = 61;
// param
export const AN_FORMAL_PARAMETER: number = 62;
export const AN_FORMAL_PARAMETER_REST: number = 63;
export const AN_TS_THIS_PARAMETER: number = 64;
// member
export const AN_METHOD_DEFINITION: number = 65;
export const AN_PROPERTY_DEFINITION: number = 66;
export const AN_ACCESSOR_PROPERTY: number = 67;
export const AN_STATIC_BLOCK: number = 68;
export const AN_TS_INDEX_SIGNATURE: number = 69;
export const AN_TS_PROPERTY_SIGNATURE: number = 70;
export const AN_TS_METHOD_SIGNATURE: number = 71;
export const AN_TS_CALL_SIGNATURE_DECLARATION: number = 72;
export const AN_TS_CONSTRUCT_SIGNATURE_DECLARATION: number = 73;
// prop
export const AN_OBJECT_PROPERTY: number = 74;
export const AN_JSX_ATTRIBUTE: number = 75;
export const AN_JSX_SPREAD_ATTRIBUTE: number = 76;
export const AN_ASSIGNMENT_TARGET_PROPERTY_IDENTIFIER: number = 77;
export const AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY: number = 78;
// vardecl
export const AN_VARIABLE_DECLARATOR: number = 79;
export const AN_CATCH_PARAMETER: number = 80;
// stmt
export const AN_DIRECTIVE: number = 81;
export const AN_BLOCK_STATEMENT: number = 82;
export const AN_EMPTY_STATEMENT: number = 83;
export const AN_DEBUGGER_STATEMENT: number = 84;
export const AN_VARIABLE_DECLARATION: number = 85;
export const AN_RETURN_STATEMENT: number = 86;
export const AN_IF_STATEMENT: number = 87;
export const AN_FOR_STATEMENT: number = 88;
export const AN_FOR_IN_STATEMENT: number = 89;
export const AN_FOR_OF_STATEMENT: number = 90;
export const AN_WHILE_STATEMENT: number = 91;
export const AN_DO_WHILE_STATEMENT: number = 92;
export const AN_WITH_STATEMENT: number = 93;
export const AN_SWITCH_STATEMENT: number = 94;
export const AN_TRY_STATEMENT: number = 95;
export const AN_THROW_STATEMENT: number = 96;
export const AN_BREAK_STATEMENT: number = 97;
export const AN_CONTINUE_STATEMENT: number = 98;
export const AN_LABELED_STATEMENT: number = 99;
export const AN_IMPORT_DECLARATION: number = 100;
export const AN_EXPORT_ALL_DECLARATION: number = 101;
export const AN_TS_INTERFACE_DECLARATION: number = 102;
export const AN_TS_TYPE_ALIAS_DECLARATION: number = 103;
export const AN_TS_ENUM_DECLARATION: number = 104;
export const AN_TS_MODULE_DECLARATION: number = 105;
export const AN_TS_GLOBAL_DECLARATION: number = 106;
export const AN_TS_IMPORT_EQUALS_DECLARATION: number = 107;
export const AN_TS_EXPORT_ASSIGNMENT: number = 108;
export const AN_TS_NAMESPACE_EXPORT_DECLARATION: number = 109;
export const AN_EXPORT_NAMED_DECLARATION: number = 110;
export const AN_EXPORT_DEFAULT_DECLARATION: number = 111;
export const AN_CATCH_CLAUSE: number = 112;
export const AN_TS_INTERFACE_BODY: number = 113;
export const AN_TS_ENUM_BODY: number = 114;
export const AN_TS_MODULE_BLOCK: number = 115;
// case
export const AN_SWITCH_CASE: number = 116;
// enummember
export const AN_TS_ENUM_MEMBER: number = 117;
// importspec
export const AN_IMPORT_SPECIFIER: number = 118;
// exportspec
export const AN_EXPORT_SPECIFIER: number = 119;
// pat
export const AN_BINDING_IDENTIFIER: number = 120;
export const AN_OBJECT_PATTERN: number = 121;
export const AN_ARRAY_PATTERN: number = 122;
// patprop
export const AN_BINDING_PROPERTY: number = 123;
// patnode
export const AN_ASSIGNMENT_PATTERN_PROP: number = 124;
export const AN_ASSIGNMENT_PATTERN_ELEM: number = 125;
export const AN_BINDING_REST_ELEMENT_PROP: number = 126;
export const AN_BINDING_REST_ELEMENT_ELEM: number = 127;
// type
export const AN_TS_KEYWORD_TYPE: number = 128;
export const AN_TS_THIS_TYPE: number = 129;
export const AN_TS_TYPE_REFERENCE: number = 130;
export const AN_TS_LITERAL_TYPE: number = 131;
export const AN_TS_TEMPLATE_LITERAL_TYPE: number = 132;
export const AN_TS_ARRAY_TYPE: number = 133;
export const AN_TS_TUPLE_TYPE: number = 134;
export const AN_TS_UNION_TYPE: number = 135;
export const AN_TS_INTERSECTION_TYPE: number = 136;
export const AN_TS_FUNCTION_TYPE: number = 137;
export const AN_TS_CONSTRUCTOR_TYPE: number = 138;
export const AN_TS_TYPE_LITERAL: number = 139;
export const AN_TS_CONDITIONAL_TYPE: number = 140;
export const AN_TS_INFER_TYPE: number = 141;
export const AN_TS_MAPPED_TYPE: number = 142;
export const AN_TS_INDEXED_ACCESS_TYPE: number = 143;
export const AN_TS_TYPE_OPERATOR: number = 144;
export const AN_TS_TYPE_QUERY: number = 145;
export const AN_TS_IMPORT_TYPE: number = 146;
export const AN_TS_TYPE_PREDICATE: number = 147;
export const AN_TS_CLASS_IMPLEMENTS: number = 148;
export const AN_TS_INTERFACE_HERITAGE: number = 149;
export const AN_TS_TYPE_ANNOTATION: number = 150;
// tupleelem
export const AN_TS_NAMED_TUPLE_MEMBER: number = 151;
export const AN_TS_OPTIONAL_TYPE: number = 152;
export const AN_TS_REST_TYPE: number = 153;
// typeparam
export const AN_TS_TYPE_PARAMETER: number = 154;
// typeargs
export const AN_TS_TYPE_PARAMETER_INSTANTIATION_EXPR: number = 155;
export const AN_TS_TYPE_PARAMETER_INSTANTIATION_TYPE: number = 156;
export const AN_TS_TYPE_PARAMETER_INSTANTIATION_CLASS: number = 157;
export const AN_TS_TYPE_PARAMETER_DECLARATION_FUNC: number = 158;
export const AN_TS_TYPE_PARAMETER_DECLARATION_CLASS: number = 159;
export const AN_TS_TYPE_PARAMETER_DECLARATION_STMT: number = 160;
export const AN_TS_TYPE_PARAMETER_DECLARATION_TYPE: number = 161;

export const NONE_AN: number = -1;
const AN_SHIFT: number = 23;
const AN_ID_MASK: number = 0x7fffff;
/** The largest number of rows of a table that `AstNodes` can name. */
export const AN_MAX_ROWS: number = 0x800000;

export function mkAn(tag: number, id: number): number {
  return (tag << 23) | id;
}
export function anTag(an: number): number {
  return an >> 23;
}
export function anId(an: number): number {
  return an & 0x7fffff;
}

// Ranges of tags that have the same kind of payload (the group in the list above).
export function anIsExprPayload(an: number): boolean {
  const t = an >> 23;
  return t >= AN_IDENTIFIER_REFERENCE && t <= AN_ASSIGNMENT_TARGET_REST;
}
export function anIsSpreadElement(an: number): boolean {
  const t = an >> 23;
  return t === AN_SPREAD_ELEMENT_EXPR || t === AN_SPREAD_ELEMENT_PROP;
}
/** `AstNodes::ExpressionStatement(_)`: a statement, or the expression body of an arrow function. */
export function anIsExpressionStatement(an: number): boolean {
  const t = an >> 23;
  return t === AN_EXPRESSION_STATEMENT || t === AN_ARROW_BODY_EXPRESSION_STATEMENT;
}
/** `ExpressionStatement::is_arrow_function_body()` */
export function anIsArrowFunctionBody(an: number): boolean {
  return (an >> 23) === AN_ARROW_BODY_EXPRESSION_STATEMENT;
}
/** `ExpressionStatement::expression()` of an `AN_*EXPRESSION_STATEMENT`: the ExprId, or -1. */
export function anExpressionStatementExpression(an: number): number {
  const id = an & 0x7fffff;
  if ((an >> 23) === AN_EXPRESSION_STATEMENT) {
    return stmtTag(id) === STMT_EXPR ? stmtExprOf(id) : -1;
  }
  return funcBodyKind(id) === BODY_EXPR ? funcBodyExpr(id) : -1;
}
function stmtExprOf(s: number): number {
  return stmtExprExpr(s);
}
export function anIsAssignmentPattern(an: number): boolean {
  const t = an >> 23;
  return t === AN_ASSIGNMENT_PATTERN_PROP || t === AN_ASSIGNMENT_PATTERN_ELEM;
}
export function anIsBindingRestElement(an: number): boolean {
  const t = an >> 23;
  return t === AN_BINDING_REST_ELEMENT_PROP || t === AN_BINDING_REST_ELEMENT_ELEM;
}
export function anIsTypeParameterInstantiation(an: number): boolean {
  const t = an >> 23;
  return t >= AN_TS_TYPE_PARAMETER_INSTANTIATION_EXPR && t <= AN_TS_TYPE_PARAMETER_INSTANTIATION_CLASS;
}
export function anIsTypeParameterDeclaration(an: number): boolean {
  const t = an >> 23;
  return t >= AN_TS_TYPE_PARAMETER_DECLARATION_FUNC && t <= AN_TS_TYPE_PARAMETER_DECLARATION_TYPE;
}
/** The `Node` that owns the `<..>` of an `AN_TS_TYPE_PARAMETER_{INSTANTIATION,DECLARATION}_*`. */
export function anTypeParametersOwner(an: number): number {
  const id = an & 0x7fffff;
  switch (an >> 23) {
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_EXPR:
      return nodeOf(N_EXPR, id);
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_TYPE:
    case AN_TS_TYPE_PARAMETER_DECLARATION_TYPE:
      return nodeOf(N_TYPE, id);
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_CLASS:
    case AN_TS_TYPE_PARAMETER_DECLARATION_CLASS:
      return nodeOf(N_CLASS, id);
    case AN_TS_TYPE_PARAMETER_DECLARATION_FUNC:
      return nodeOf(N_FUNC, id);
    default:
      return nodeOf(N_STMT, id);
  }
}
/** `AstNodes::TSTypeParameterInstantiation(owner)` for a `Node`. */
export function mkTypeArgumentsAn(owner: number): number {
  const id = nodeId(owner);
  switch (nodeKind(owner)) {
    case N_EXPR:
      return mkAn(AN_TS_TYPE_PARAMETER_INSTANTIATION_EXPR, id);
    case N_CLASS:
      return mkAn(AN_TS_TYPE_PARAMETER_INSTANTIATION_CLASS, id);
    default:
      return mkAn(AN_TS_TYPE_PARAMETER_INSTANTIATION_TYPE, id);
  }
}
/** `AstNodes::TSTypeParameterDeclaration(owner)` for a `Node`. */
export function mkTypeParametersAn(owner: number): number {
  const id = nodeId(owner);
  switch (nodeKind(owner)) {
    case N_FUNC:
      return mkAn(AN_TS_TYPE_PARAMETER_DECLARATION_FUNC, id);
    case N_CLASS:
      return mkAn(AN_TS_TYPE_PARAMETER_DECLARATION_CLASS, id);
    case N_STMT:
      return mkAn(AN_TS_TYPE_PARAMETER_DECLARATION_STMT, id);
    default:
      return mkAn(AN_TS_TYPE_PARAMETER_DECLARATION_TYPE, id);
  }
}

// How far up the nodes that oxc has around an expression and the HIR has not.
const L_ITSELF: number = 0;
const L_CHAIN: number = 1;
const L_JSX_CONTAINER: number = 2;

function isComma(e: number): boolean {
  return exprBinaryOpOf(e) === BIN_COMMA;
}

/** Whether `e` is the `a, b` of `a, b, c`, which is not a node of its own in ESTree. */
function isInnerComma(e: number): boolean {
  if (!isComma(e) || exprIsParenthesized(e)) return false;
  const parent = exprParent(e);
  return nodeKind(parent) === N_EXPR && isComma(nodeId(parent)) && exprLeft(nodeId(parent)) === e;
}

/** `ExprTag::Dot` that is a private member (`a.#b`). */
// What a handle is, and what it is in.

/**
 * ESTree's `Expression`: for the whole of an optional chain, the `ChainExpression`. See `exprAsChainElement`.
 */
export function exprAsAstNodes(e: number): number {
  if (exprIsChainRoot(e)) return mkAn(AN_CHAIN_EXPRESSION, e);
  return exprAsChainElement(e);
}

/** What is around the `ChainExpression`, if there is one. */
export function exprAstParent(e: number): number {
  return parentOfExpr(e, L_CHAIN);
}

/**
 * The member access, the call or the `!` itself, even if it is the whole of an optional chain. Its parent is the `ChainExpression`
 * then. For any other expression this is the same as `exprAsAstNodes`.
 */
export function exprAsChainElement(e: number): number {
  switch (exprTag(e)) {
    case EXPR_IDENT:
      return mkAn(AN_IDENTIFIER_REFERENCE, e);
    case EXPR_THIS:
      return mkAn(AN_THIS_EXPRESSION, e);
    case EXPR_CALL:
      return mkAn(AN_CALL_EXPRESSION, e);
    case EXPR_DOT:
      return exprIsPrivateMember(e) ? mkAn(AN_PRIVATE_FIELD_EXPRESSION, e) : mkAn(AN_STATIC_MEMBER_EXPRESSION, e);
    case EXPR_NUMBER:
      return mkAn(AN_NUMERIC_LITERAL, e);
    default:
      return chainElementInGeneral(e);
  }
}

function chainElementInGeneral(e: number): number {
  switch (exprTag(e)) {
    case EXPR_MISSING:
      return exprJsxContainerSpan(e) ? mkAn(AN_JSX_EMPTY_EXPRESSION, e) : mkAn(AN_ELISION, e);
    case EXPR_IDENT:
      return mkAn(AN_IDENTIFIER_REFERENCE, e);
    case EXPR_PRIVATE_IDENTIFIER:
      return mkAn(AN_PRIVATE_IDENTIFIER, e);
    case EXPR_THIS:
      return mkAn(AN_THIS_EXPRESSION, e);
    case EXPR_SUPER:
      return mkAn(AN_SUPER, e);
    case EXPR_NULL:
      return mkAn(AN_NULL_LITERAL, e);
    case EXPR_TRUE:
    case EXPR_FALSE:
      return mkAn(AN_BOOLEAN_LITERAL, e);
    case EXPR_NUMBER:
      return mkAn(AN_NUMERIC_LITERAL, e);
    case EXPR_STRING:
      return exprIsJsxText(e) ? mkAn(AN_JSX_TEXT, e) : mkAn(AN_STRING_LITERAL, e);
    case EXPR_BIG_INT:
      return mkAn(AN_BIG_INT_LITERAL, e);
    case EXPR_REGEX:
      return mkAn(AN_REG_EXP_LITERAL, e);
    case EXPR_TEMPLATE:
      return mkAn(AN_TEMPLATE_LITERAL, e);
    case EXPR_TAGGED_TEMPLATE:
      return mkAn(AN_TAGGED_TEMPLATE_EXPRESSION, e);
    case EXPR_ARRAY:
      return exprIsAssignmentTarget(e) ? mkAn(AN_ARRAY_ASSIGNMENT_TARGET, e) : mkAn(AN_ARRAY_EXPRESSION, e);
    case EXPR_OBJECT:
      return exprIsAssignmentTarget(e) ? mkAn(AN_OBJECT_ASSIGNMENT_TARGET, e) : mkAn(AN_OBJECT_EXPRESSION, e);
    case EXPR_FN: {
      const func = exprAsFn(e);
      return func < 0 ? mkAn(AN_ELISION, e) : funcAsAstNodes(func);
    }
    case EXPR_CLASS: {
      const cls = exprAsClass(e);
      return cls < 0 ? mkAn(AN_ELISION, e) : mkAn(AN_CLASS, cls);
    }
    case EXPR_DOT:
      return exprIsPrivateMember(e) ? mkAn(AN_PRIVATE_FIELD_EXPRESSION, e) : mkAn(AN_STATIC_MEMBER_EXPRESSION, e);
    case EXPR_INDEX:
      return mkAn(AN_COMPUTED_MEMBER_EXPRESSION, e);
    case EXPR_CALL:
      return mkAn(AN_CALL_EXPRESSION, e);
    case EXPR_NEW:
      return mkAn(AN_NEW_EXPRESSION, e);
    case EXPR_UNARY: {
      const op = exprUnaryOpOf(e);
      if (op === UN_PRE_INC || op === UN_PRE_DEC || op === UN_POST_INC || op === UN_POST_DEC) return mkAn(AN_UPDATE_EXPRESSION, e);
      return mkAn(AN_UNARY_EXPRESSION, e);
    }
    case EXPR_BINARY: {
      const op = exprBinaryOpOf(e);
      if (op === BIN_AND || op === BIN_OR || op === BIN_NULLISH) return mkAn(AN_LOGICAL_EXPRESSION, e);
      if (op === BIN_COMMA) return mkAn(AN_SEQUENCE_EXPRESSION, e);
      if (op === BIN_IN) {
        const left = exprLeft(e);
        if (left >= 0 && exprTag(left) === EXPR_PRIVATE_IDENTIFIER) return mkAn(AN_PRIVATE_IN_EXPRESSION, e);
      }
      return mkAn(AN_BINARY_EXPRESSION, e);
    }
    case EXPR_ASSIGN:
      if (exprAssignOpOf(e) === 0 && isDefaultInAssignmentTarget(e)) return mkAn(AN_ASSIGNMENT_TARGET_WITH_DEFAULT, e);
      return mkAn(AN_ASSIGNMENT_EXPRESSION, e);
    case EXPR_COND:
      return mkAn(AN_CONDITIONAL_EXPRESSION, e);
    case EXPR_SPREAD:
      if (exprJsxContainerSpan(e)) return mkAn(AN_JSX_SPREAD_CHILD, e);
      if (exprIsAssignmentTarget(e)) return mkAn(AN_ASSIGNMENT_TARGET_REST, e);
      return mkAn(AN_SPREAD_ELEMENT_EXPR, e);
    case EXPR_AWAIT:
      return mkAn(AN_AWAIT_EXPRESSION, e);
    case EXPR_YIELD:
      return mkAn(AN_YIELD_EXPRESSION, e);
    case EXPR_AS:
    case EXPR_AS_CONST:
      if (exprIsAngleBracketAssertion(e)) return fileIsFlow() ? mkAn(AN_TYPE_CAST_EXPRESSION, e) : mkAn(AN_TS_TYPE_ASSERTION, e);
      return mkAn(AN_TS_AS_EXPRESSION, e);
    case EXPR_SATISFIES:
      return mkAn(AN_TS_SATISFIES_EXPRESSION, e);
    case EXPR_NON_NULL:
      return mkAn(AN_TS_NON_NULL_EXPRESSION, e);
    case EXPR_INSTANTIATION:
      return mkAn(AN_TS_INSTANTIATION_EXPRESSION, e);
    case EXPR_JSX:
      return jsxIsFragment(e) ? mkAn(AN_JSX_FRAGMENT, e) : mkAn(AN_JSX_ELEMENT, e);
    case EXPR_IMPORT_CALL:
      return mkAn(AN_IMPORT_EXPRESSION, e);
    case EXPR_IMPORT_META:
    case EXPR_NEW_TARGET:
      return mkAn(AN_META_PROPERTY, e);
    default:
      return mkAn(AN_ELISION, e);
  }
}

/**
 * Whether `e`, an `=` assignment, is the `a = 1` of `[a = 1] = b` or `({ a = 1 } = b)`. Also of `b = { a = 1 }`, which is an error.
 */
function isDefaultInAssignmentTarget(e: number): boolean {
  const parent = exprParent(e);
  let isElement = false;
  switch (nodeKind(parent)) {
    case N_EXPR: {
      const t = exprTag(nodeId(parent));
      // `[...a = 1] = b` is an error.
      isElement = t === EXPR_ARRAY || t === EXPR_SPREAD;
      break;
    }
    case N_PROP: {
      const prop = nodeId(parent);
      if (propKind(prop) === PROP_SHORTHAND) return propValue(prop) === e;
      isElement = propValue(prop) === e && !propIsJsxAttribute(prop);
      break;
    }
    default:
      break;
  }
  return isElement && exprIsAssignmentTarget(e);
}

/**
 * Whether `statement` is in the place of Prettier's `JsExpressionRoot`: the text of the file is `(`, an expression that is in HTML,
 * and `)`. The name of such a file starts with a NUL. The parent of the expression is the file then.
 */
function isExpressionRoot(statement: number): boolean {
  return jsState.expressionRootFile && stmtParent(statement) === NODE_FILE;
}

function parentOfExpr(e: number, above: number): number {
  if (above < L_CHAIN && exprIsChainRoot(e)) return mkAn(AN_CHAIN_EXPRESSION, e);
  const parent = exprParent(e);
  const pk = nodeKind(parent);
  // Braces are around a child of an element or the value of an attribute. `{...e}` and `{}` are the container themselves.
  if (above < L_JSX_CONTAINER) {
    const inElement = pk === N_EXPR ? exprTag(nodeId(parent)) === EXPR_JSX : pk === N_PROP;
    if (inElement && exprTag(e) !== EXPR_SPREAD && exprJsxContainerSpan(e)) return mkAn(AN_JSX_EXPRESSION_CONTAINER, e);
  }
  const pid = nodeId(parent);
  switch (pk) {
    case N_FILE:
      return mkAn(AN_PROGRAM, 0);
    case N_EXPR: {
      if (isComma(pid)) {
        let root = pid;
        while (isInnerComma(root)) {
          const outer = exprParent(root);
          if (nodeKind(outer) !== N_EXPR) break;
          root = nodeId(outer);
        }
        return mkAn(AN_SEQUENCE_EXPRESSION, root);
      }
      return exprAsChainElement(pid);
    }
    case N_STMT: {
      if (stmtTag(pid) === STMT_EXPR) {
        if (exprTag(e) === EXPR_STRING && stmtDirectiveSpan(pid)) return mkAn(AN_DIRECTIVE, pid);
        if (isExpressionRoot(pid)) return mkAn(AN_PROGRAM, 0);
        return mkAn(AN_EXPRESSION_STATEMENT, pid);
      }
      return innerOfStmt(pid);
    }
    case N_VAR_DECL:
      return varDeclAsAstNodes(pid);
    case N_PARAM:
      return paramDefault(pid) === e ? paramAsAstNodes(pid) : mkAn(AN_DECORATOR, e);
    case N_PAT_PROP:
      return patPropDefault(pid) === e ? mkAn(AN_ASSIGNMENT_PATTERN_PROP, pid) : mkAn(AN_BINDING_PROPERTY, pid);
    case N_PAT_ELEM:
      return mkAn(AN_ASSIGNMENT_PATTERN_ELEM, pid);
    case N_PROP:
      return propAsAstNodes(pid);
    case N_MEMBER:
      return memberHasDecorator(pid, e) ? mkAn(AN_DECORATOR, e) : memberAsAstNodes(pid);
    case N_FUNC:
      return mkAn(AN_ARROW_BODY_EXPRESSION_STATEMENT, pid);
    case N_ENUM_MEMBER:
      return mkAn(AN_TS_ENUM_MEMBER, pid);
    case N_CASE:
      return mkAn(AN_SWITCH_CASE, pid);
    case N_CLASS:
      return classExtends(pid) === e ? mkAn(AN_CLASS, pid) : mkAn(AN_DECORATOR, e);
    case N_TYPE:
      return typeAsAstNodes(pid);
    default:
      return nodeAsAstNodes(parent);
  }
}

/** Whether `member` has the decorator `e`. */
function memberHasDecorator(member: number, e: number): boolean {
  const s = memberModifiersStart(member);
  const n = memberModifiersLen(member);
  for (let i = 0; i < n; i++) {
    if (modifierDecorator(listAt(s, i)) === e) return true;
  }
  return false;
}

/** For a signature or a function type, which oxc has no `Function` in, the member or the type. */
export function funcAsAstNodes(func: number): number {
  const kind = funcKind(func);
  if (kind === FN_ARROW) return mkAn(AN_ARROW_FUNCTION_EXPRESSION, func);
  const owner = funcOwner(func);
  const ok = nodeKind(owner);
  if (ok === N_TYPE) return typeAsAstNodes(nodeId(owner));
  if (ok === N_MEMBER) {
    const member = nodeId(owner);
    if (kind === FN_STATIC_BLOCK) return mkAn(AN_STATIC_BLOCK, member);
    const mp = memberParent(member);
    const inUndeclaredClass = nodeKind(mp) === N_CLASS && !isDeclaredClass(nodeId(mp));
    if (!inUndeclaredClass) return memberAsAstNodes(member);
    if (kind === FN_INDEX_SIGNATURE) return mkAn(AN_TS_INDEX_SIGNATURE, member);
  }
  return mkAn(AN_FUNCTION, func);
}

export function classAsAstNodes(cls: number): number {
  return mkAn(AN_CLASS, cls);
}

export function paramAsAstNodes(param: number): number {
  const func = paramFuncOf(param);
  if (func >= 0 && funcThisParam(func) === param) return mkAn(AN_TS_THIS_PARAMETER, param);
  if (paramIsRest(param)) return mkAn(AN_FORMAL_PARAMETER_REST, param);
  return mkAn(AN_FORMAL_PARAMETER, param);
}

export function memberAsAstNodes(member: number): number {
  const mp = memberParent(member);
  const isInClass = nodeKind(mp) === N_CLASS && !isDeclaredClass(nodeId(mp));
  switch (memberKind(member)) {
    case MEMBER_INDEX_SIGNATURE:
      return mkAn(AN_TS_INDEX_SIGNATURE, member);
    case MEMBER_STATIC_BLOCK:
      return mkAn(AN_STATIC_BLOCK, member);
    case MEMBER_CALL_SIGNATURE:
      return mkAn(AN_TS_CALL_SIGNATURE_DECLARATION, member);
    case MEMBER_CONSTRUCT_SIGNATURE:
      return mkAn(AN_TS_CONSTRUCT_SIGNATURE_DECLARATION, member);
    case MEMBER_PROPERTY:
      if (!isInClass) return mkAn(AN_TS_PROPERTY_SIGNATURE, member);
      if ((memberFlags(member) & FLAG_ACCESSOR) !== 0) return mkAn(AN_ACCESSOR_PROPERTY, member);
      return mkAn(AN_PROPERTY_DEFINITION, member);
    default:
      return isInClass ? mkAn(AN_METHOD_DEFINITION, member) : mkAn(AN_TS_METHOD_SIGNATURE, member);
  }
}

export function propAsAstNodes(prop: number): number {
  const isSpread = propKind(prop) === PROP_SPREAD;
  const owner = propParent(prop);
  if (propIsJsxAttribute(prop) || (nodeKind(owner) === N_EXPR && exprTag(nodeId(owner)) === EXPR_JSX)) {
    return isSpread ? mkAn(AN_JSX_SPREAD_ATTRIBUTE, prop) : mkAn(AN_JSX_ATTRIBUTE, prop);
  }
  const isTarget = nodeKind(owner) === N_EXPR && exprIsAssignmentTarget(nodeId(owner));
  if (!isTarget) return isSpread ? mkAn(AN_SPREAD_ELEMENT_PROP, prop) : mkAn(AN_OBJECT_PROPERTY, prop);
  if (isSpread) {
    const value = propValue(prop);
    return value >= 0 ? mkAn(AN_ASSIGNMENT_TARGET_REST, value) : mkAn(AN_OBJECT_PROPERTY, prop);
  }
  return propKind(prop) === PROP_SHORTHAND
    ? mkAn(AN_ASSIGNMENT_TARGET_PROPERTY_IDENTIFIER, prop)
    : mkAn(AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY, prop);
}

export function varDeclAsAstNodes(d: number): number {
  const parent = varDeclParent(d);
  if (nodeKind(parent) === N_STMT && stmtTag(nodeId(parent)) === STMT_TRY) return mkAn(AN_CATCH_PARAMETER, d);
  return mkAn(AN_VARIABLE_DECLARATOR, d);
}

/** The statement without the `export` around it. */
function innerOfStmt(s: number): number {
  switch (stmtTag(s)) {
    case STMT_VAR:
      return mkAn(AN_VARIABLE_DECLARATION, s);
    case STMT_RETURN:
      return mkAn(AN_RETURN_STATEMENT, s);
    case STMT_IF:
      return mkAn(AN_IF_STATEMENT, s);
    case STMT_THROW:
      return mkAn(AN_THROW_STATEMENT, s);
    case STMT_FOR:
      return mkAn(AN_FOR_STATEMENT, s);
    case STMT_FOR_IN:
      return mkAn(AN_FOR_IN_STATEMENT, s);
    case STMT_FOR_OF:
      return mkAn(AN_FOR_OF_STATEMENT, s);
    case STMT_WHILE:
      return mkAn(AN_WHILE_STATEMENT, s);
    case STMT_SWITCH:
      return mkAn(AN_SWITCH_STATEMENT, s);
    case STMT_TRY:
      return mkAn(AN_TRY_STATEMENT, s);
    case STMT_EXPORT_DEFAULT:
      return mkAn(AN_EXPORT_DEFAULT_DECLARATION, s);
    default:
      return innerOfStmtInGeneral(s);
  }
}

function innerOfStmtInGeneral(s: number): number {
  switch (stmtTag(s)) {
    case STMT_EMPTY:
      return mkAn(AN_EMPTY_STATEMENT, s);
    case STMT_DEBUGGER:
      return mkAn(AN_DEBUGGER_STATEMENT, s);
    case STMT_EXPR:
      return stmtDirectiveSpan(s) ? mkAn(AN_DIRECTIVE, s) : mkAn(AN_EXPRESSION_STATEMENT, s);
    case STMT_FN:
      return mkAn(AN_FUNCTION, stmtFnFn(s));
    case STMT_CLASS:
      return mkAn(AN_CLASS, stmtClassClass(s));
    case STMT_INTERFACE:
      return mkAn(AN_TS_INTERFACE_DECLARATION, s);
    case STMT_TYPE_ALIAS:
      return mkAn(AN_TS_TYPE_ALIAS_DECLARATION, s);
    case STMT_ENUM:
      return mkAn(AN_TS_ENUM_DECLARATION, s);
    case STMT_MODULE:
      return moduleNameKind(stmtModuleModule(s)) === MODNAME_GLOBAL ? mkAn(AN_TS_GLOBAL_DECLARATION, s) : mkAn(AN_TS_MODULE_DECLARATION, s);
    case STMT_DO_WHILE:
      return mkAn(AN_DO_WHILE_STATEMENT, s);
    case STMT_BLOCK:
      return stmtIsWith(s) ? mkAn(AN_WITH_STATEMENT, s) : mkAn(AN_BLOCK_STATEMENT, s);
    case STMT_BREAK:
      return mkAn(AN_BREAK_STATEMENT, s);
    case STMT_CONTINUE:
      return mkAn(AN_CONTINUE_STATEMENT, s);
    case STMT_LABELED:
      return mkAn(AN_LABELED_STATEMENT, s);
    case STMT_IMPORT:
      return mkAn(AN_IMPORT_DECLARATION, s);
    case STMT_IMPORT_EQUALS:
      return mkAn(AN_TS_IMPORT_EQUALS_DECLARATION, s);
    case STMT_EXPORT_NAMED:
      return mkAn(AN_EXPORT_NAMED_DECLARATION, s);
    case STMT_EXPORT_STAR:
      return mkAn(AN_EXPORT_ALL_DECLARATION, s);
    case STMT_EXPORT_DEFAULT:
      return mkAn(AN_EXPORT_DEFAULT_DECLARATION, s);
    case STMT_EXPORT_ASSIGN:
      return mkAn(AN_TS_EXPORT_ASSIGNMENT, s);
    case STMT_EXPORT_AS_NAMESPACE:
      return mkAn(AN_TS_NAMESPACE_EXPORT_DECLARATION, s);
    default:
      return mkAn(AN_EMPTY_STATEMENT, s);
  }
}

/** `export` or `export default` is written before `statement`, which is a declaration: the node for it, or -1. */
function exportAround(s: number): number {
  const tag = stmtTag(s);
  if (tag === STMT_EXPORT_NAMED || tag === STMT_EXPORT_DEFAULT || tag === STMT_EXPORT_STAR) return -1;
  const flags = stmtFlags(s);
  if ((flags & FLAG_EXPORT) === 0) return -1;
  return (flags & FLAG_DEFAULT) !== 0 ? mkAn(AN_EXPORT_DEFAULT_DECLARATION, s) : mkAn(AN_EXPORT_NAMED_DECLARATION, s);
}

/** With the `export` around a declaration. */
export function stmtAsAstNodes(s: number): number {
  const ex = exportAround(s);
  return ex >= 0 ? ex : innerOfStmt(s);
}

/** What `statement`, with its `export`, is in. */
function parentOfStmt(s: number): number {
  const parent = stmtParent(s);
  const pid = nodeId(parent);
  switch (nodeKind(parent)) {
    case N_FILE:
      return mkAn(AN_PROGRAM, 0);
    case N_FUNC:
      if (funcKind(pid) === FN_STATIC_BLOCK) return funcAsAstNodes(pid);
      return mkAn(AN_FUNCTION_BODY, pid);
    case N_CASE:
      return mkAn(AN_SWITCH_CASE, pid);
    case N_STMT: {
      const t = stmtTag(pid);
      if (t === STMT_TRY && stmtTryHandler(pid) === s) return mkAn(AN_CATCH_CLAUSE, pid);
      // `namespace A.B { .. }` is one node, and what is between the braces is in it.
      if (t === STMT_MODULE) return mkAn(AN_TS_MODULE_BLOCK, pid);
      return innerOfStmt(pid);
    }
    default:
      return nodeAsAstNodes(parent);
  }
}

export function stmtAstParent(s: number): number {
  return anParent(stmtAsAstNodes(s));
}

export function typeAsAstNodes(t: number): number {
  switch (typeTag(t)) {
    case TYPE_REF:
    case TYPE_HERITAGE: {
      const parent = typeParent(t);
      const pid = nodeId(parent);
      if (nodeKind(parent) === N_CLASS) {
        const s = classImplementsStart(pid);
        const n = classImplementsLen(pid);
        for (let i = 0; i < n; i++) if (listAt(s, i) === t) return mkAn(AN_TS_CLASS_IMPLEMENTS, t);
      } else if (nodeKind(parent) === N_STMT && stmtTag(pid) === STMT_INTERFACE) {
        return mkAn(AN_TS_INTERFACE_HERITAGE, t);
      }
      return mkAn(AN_TS_TYPE_REFERENCE, t);
    }
    case TYPE_ERROR:
    case TYPE_JSDOC:
      return mkAn(AN_TS_KEYWORD_TYPE, t);
    case TYPE_KEYWORD:
      return typeKeywordKeyword(t) === KW_THIS ? mkAn(AN_TS_THIS_TYPE, t) : mkAn(AN_TS_KEYWORD_TYPE, t);
    case TYPE_STRING_LIT:
    case TYPE_NUMBER_LIT:
    case TYPE_BIG_INT_LIT:
    case TYPE_BOOL_LIT:
      return mkAn(AN_TS_LITERAL_TYPE, t);
    case TYPE_TEMPLATE:
      return mkAn(AN_TS_TEMPLATE_LITERAL_TYPE, t);
    case TYPE_ARRAY:
      return mkAn(AN_TS_ARRAY_TYPE, t);
    case TYPE_TUPLE:
      return mkAn(AN_TS_TUPLE_TYPE, t);
    case TYPE_UNION:
      return mkAn(AN_TS_UNION_TYPE, t);
    case TYPE_INTERSECTION:
      return mkAn(AN_TS_INTERSECTION_TYPE, t);
    case TYPE_FN:
      return funcKind(typeFnFn(t)) === FN_CONSTRUCTOR_TYPE ? mkAn(AN_TS_CONSTRUCTOR_TYPE, t) : mkAn(AN_TS_FUNCTION_TYPE, t);
    case TYPE_OBJECT:
      return mkAn(AN_TS_TYPE_LITERAL, t);
    case TYPE_COND:
      return mkAn(AN_TS_CONDITIONAL_TYPE, t);
    case TYPE_INFER:
      return mkAn(AN_TS_INFER_TYPE, t);
    case TYPE_MAPPED:
      return mkAn(AN_TS_MAPPED_TYPE, t);
    case TYPE_INDEXED_ACCESS:
      return mkAn(AN_TS_INDEXED_ACCESS_TYPE, t);
    case TYPE_KEYOF:
    case TYPE_READONLY:
    case TYPE_UNIQUE_SYMBOL:
    case TYPE_UNIQUE:
      return mkAn(AN_TS_TYPE_OPERATOR, t);
    case TYPE_TYPEOF:
      return mkAn(AN_TS_TYPE_QUERY, t);
    case TYPE_IMPORT:
      return (typeImportFlags(t) & 1) !== 0 ? mkAn(AN_TS_TYPE_QUERY, t) : mkAn(AN_TS_IMPORT_TYPE, t);
    case TYPE_PREDICATE:
      return mkAn(AN_TS_TYPE_PREDICATE, t);
    default:
      return mkAn(AN_TS_KEYWORD_TYPE, t);
  }
}

export function typeAstParent(t: number): number {
  const parent = typeParent(t);
  const pid = nodeId(parent);
  switch (nodeKind(parent)) {
    case N_TYPE: {
      switch (typeTag(pid)) {
        case TYPE_REF:
        case TYPE_HERITAGE:
        case TYPE_TYPEOF:
        case TYPE_IMPORT:
          return mkTypeArgumentsAn(parent);
        default:
          return typeAsAstNodes(pid);
      }
    }
    case N_TUPLE_ELEM:
      return tupleElemAsAstNodes(pid);
    case N_TYPE_PARAM: {
      const owner = typeParamParent(pid);
      // The `C` of `[K in C]` is directly in the mapped type.
      if (nodeKind(owner) === N_TYPE && typeTag(nodeId(owner)) === TYPE_MAPPED) return typeAsAstNodes(nodeId(owner));
      return mkAn(AN_TS_TYPE_PARAMETER, pid);
    }
    case N_FUNC:
    case N_PARAM:
    case N_VAR_DECL:
    case N_MEMBER:
      return mkAn(AN_TS_TYPE_ANNOTATION, t);
    case N_CLASS: {
      const s = classImplementsStart(pid);
      const n = classImplementsLen(pid);
      for (let i = 0; i < n; i++) if (listAt(s, i) === t) return mkAn(AN_CLASS, pid);
      return mkTypeArgumentsAn(parent);
    }
    case N_STMT:
      return innerOfStmt(pid);
    case N_EXPR: {
      const tag = exprTag(pid);
      if (tag === EXPR_AS || tag === EXPR_SATISFIES) return exprAsChainElement(pid);
      return mkTypeArgumentsAn(parent);
    }
    default:
      return nodeAsAstNodes(parent);
  }
}

/** For an element that is only a type, the tuple type. */
export function tupleElemAsAstNodes(el: number): number {
  if (tupleElemName(el) >= 0) return mkAn(AN_TS_NAMED_TUPLE_MEMBER, el);
  if (tupleElemIsRest(el)) return mkAn(AN_TS_REST_TYPE, el);
  if (tupleElemIsOptional(el)) return mkAn(AN_TS_OPTIONAL_TYPE, el);
  return nodeAsAstNodes(tupleElemParent(el));
}

export function patAsAstNodes(p: number): number {
  switch (patTag(p)) {
    case PAT_OBJECT:
      return mkAn(AN_OBJECT_PATTERN, p);
    case PAT_ARRAY:
      return mkAn(AN_ARRAY_PATTERN, p);
    default:
      return mkAn(AN_BINDING_IDENTIFIER, p);
  }
}

export function patAstParent(p: number): number {
  const parent = patParent(p);
  const pid = nodeId(parent);
  switch (nodeKind(parent)) {
    case N_PAT_PROP:
      if (patPropIsRest(pid)) return mkAn(AN_BINDING_REST_ELEMENT_PROP, pid);
      if (patPropDefault(pid) >= 0) return mkAn(AN_ASSIGNMENT_PATTERN_PROP, pid);
      return nodeAsAstNodes(parent);
    case N_PAT_ELEM:
      if (patElemIsRest(pid)) return mkAn(AN_BINDING_REST_ELEMENT_ELEM, pid);
      if (patElemDefault(pid) >= 0) return mkAn(AN_ASSIGNMENT_PATTERN_ELEM, pid);
      return nodeAsAstNodes(patElemParent(pid));
    default:
      return nodeAsAstNodes(parent);
  }
}

/** What a node of the lint handles is. A statement is with its `export`. */
export function nodeAsAstNodes(node: number): number {
  const id = nodeId(node);
  switch (nodeKind(node)) {
    case N_FILE:
      return mkAn(AN_PROGRAM, 0);
    case N_EXPR:
      return exprAsChainElement(id);
    case N_STMT:
      return stmtAsAstNodes(id);
    case N_TYPE:
      return typeAsAstNodes(id);
    case N_PAT:
      return patAsAstNodes(id);
    case N_PAT_PROP:
      return mkAn(AN_BINDING_PROPERTY, id);
    case N_PAT_ELEM: {
      const pat = patElemPat(id);
      return pat >= 0 ? patAsAstNodes(pat) : nodeAsAstNodes(patElemParent(id));
    }
    case N_FUNC:
      return funcAsAstNodes(id);
    case N_PARAM:
      return paramAsAstNodes(id);
    case N_TYPE_PARAM:
      return mkAn(AN_TS_TYPE_PARAMETER, id);
    case N_CLASS:
      return mkAn(AN_CLASS, id);
    case N_MEMBER:
      return memberAsAstNodes(id);
    case N_PROP:
      return propAsAstNodes(id);
    case N_VAR_DECL:
      return varDeclAsAstNodes(id);
    case N_CASE:
      return mkAn(AN_SWITCH_CASE, id);
    case N_ENUM_MEMBER:
      return mkAn(AN_TS_ENUM_MEMBER, id);
    case N_IMPORT_SPEC:
      return mkAn(AN_IMPORT_SPECIFIER, id);
    case N_EXPORT_SPEC:
      return mkAn(AN_EXPORT_SPECIFIER, id);
    default:
      return tupleElemAsAstNodes(id);
  }
}

/** What the function or the class that `owner` is, is in. */
function parentOfOwner(owner: number): number {
  const id = nodeId(owner);
  switch (nodeKind(owner)) {
    case N_EXPR:
      return parentOfExpr(id, L_ITSELF);
    case N_STMT: {
      const ex = exportAround(id);
      return ex >= 0 ? ex : parentOfStmt(id);
    }
    case N_MEMBER:
      return memberAsAstNodes(id);
    case N_TYPE:
      return typeAstParent(id);
    default:
      return nodeAsAstNodes(owner);
  }
}

/** What it is directly in. `Program` is in itself. */
export function anParent(an: number): number {
  const id = an & 0x7fffff;
  switch (an >> 23) {
    case AN_PROGRAM:
      return an;
    case AN_CHAIN_EXPRESSION:
      return parentOfExpr(id, L_CHAIN);
    case AN_JSX_EXPRESSION_CONTAINER:
      return parentOfExpr(id, L_JSX_CONTAINER);
    case AN_JSX_OPENING_ELEMENT:
      return exprAsChainElement(id);
    case AN_DECORATOR: {
      const p = exprParent(id);
      return nodeKind(p) === N_CLASS ? mkAn(AN_CLASS, nodeId(p)) : nodeAsAstNodes(p);
    }
    case AN_ASSIGNMENT_TARGET_REST: {
      if (exprTag(id) === EXPR_SPREAD) return parentOfExpr(id, L_ITSELF);
      // What `...` is written before in an object.
      const p = exprParent(id);
      return nodeKind(p) === N_PROP ? nodeAsAstNodes(propParent(nodeId(p))) : nodeAsAstNodes(p);
    }
    case AN_IDENTIFIER_REFERENCE:
    case AN_BOOLEAN_LITERAL:
    case AN_NULL_LITERAL:
    case AN_NUMERIC_LITERAL:
    case AN_BIG_INT_LITERAL:
    case AN_REG_EXP_LITERAL:
    case AN_STRING_LITERAL:
    case AN_TEMPLATE_LITERAL:
    case AN_THIS_EXPRESSION:
    case AN_SUPER:
    case AN_ARRAY_EXPRESSION:
    case AN_OBJECT_EXPRESSION:
    case AN_STATIC_MEMBER_EXPRESSION:
    case AN_COMPUTED_MEMBER_EXPRESSION:
    case AN_PRIVATE_FIELD_EXPRESSION:
    case AN_CALL_EXPRESSION:
    case AN_NEW_EXPRESSION:
    case AN_IMPORT_EXPRESSION:
    case AN_META_PROPERTY:
    case AN_TAGGED_TEMPLATE_EXPRESSION:
    case AN_UNARY_EXPRESSION:
    case AN_UPDATE_EXPRESSION:
    case AN_BINARY_EXPRESSION:
    case AN_LOGICAL_EXPRESSION:
    case AN_PRIVATE_IN_EXPRESSION:
    case AN_ASSIGNMENT_EXPRESSION:
    case AN_CONDITIONAL_EXPRESSION:
    case AN_AWAIT_EXPRESSION:
    case AN_YIELD_EXPRESSION:
    case AN_TS_AS_EXPRESSION:
    case AN_TS_SATISFIES_EXPRESSION:
    case AN_TS_TYPE_ASSERTION:
    case AN_TS_NON_NULL_EXPRESSION:
    case AN_TS_INSTANTIATION_EXPRESSION:
    case AN_JSX_ELEMENT:
    case AN_JSX_FRAGMENT:
    case AN_JSX_TEXT:
    case AN_JSX_EMPTY_EXPRESSION:
    case AN_ELISION:
    case AN_PRIVATE_IDENTIFIER:
    case AN_SEQUENCE_EXPRESSION:
    case AN_JSX_SPREAD_CHILD:
    case AN_ARRAY_ASSIGNMENT_TARGET:
    case AN_OBJECT_ASSIGNMENT_TARGET:
    case AN_ASSIGNMENT_TARGET_WITH_DEFAULT:
    case AN_TYPE_CAST_EXPRESSION:
    case AN_SPREAD_ELEMENT_EXPR:
      return parentOfExpr(id, L_ITSELF);
    case AN_SPREAD_ELEMENT_PROP:
      return nodeAsAstNodes(propParent(id));
    case AN_EXPRESSION_STATEMENT:
      return parentOfStmt(id);
    case AN_ARROW_BODY_EXPRESSION_STATEMENT:
      return mkAn(AN_FUNCTION_BODY, id);
    case AN_FUNCTION:
    case AN_ARROW_FUNCTION_EXPRESSION:
      return parentOfOwner(funcOwner(id));
    case AN_FUNCTION_BODY:
    case AN_FORMAL_PARAMETERS:
      return funcAsAstNodes(id);
    case AN_CLASS:
      return parentOfOwner(classOwner(id));
    case AN_CLASS_BODY:
      return mkAn(AN_CLASS, id);
    case AN_FORMAL_PARAMETER:
    case AN_FORMAL_PARAMETER_REST: {
      const func = paramFuncOf(id);
      if (func < 0) return mkAn(AN_PROGRAM, 0);
      if (funcKind(func) === FN_INDEX_SIGNATURE) return funcAsAstNodes(func);
      return mkAn(AN_FORMAL_PARAMETERS, func);
    }
    case AN_TS_THIS_PARAMETER: {
      const func = paramFuncOf(id);
      return func < 0 ? mkAn(AN_PROGRAM, 0) : funcAsAstNodes(func);
    }
    case AN_METHOD_DEFINITION:
    case AN_PROPERTY_DEFINITION:
    case AN_ACCESSOR_PROPERTY:
    case AN_STATIC_BLOCK:
    case AN_TS_INDEX_SIGNATURE:
    case AN_TS_PROPERTY_SIGNATURE:
    case AN_TS_METHOD_SIGNATURE:
    case AN_TS_CALL_SIGNATURE_DECLARATION:
    case AN_TS_CONSTRUCT_SIGNATURE_DECLARATION: {
      const p = memberParent(id);
      if (nodeKind(p) === N_CLASS) return mkAn(AN_CLASS_BODY, nodeId(p));
      if (nodeKind(p) === N_STMT) return mkAn(AN_TS_INTERFACE_BODY, nodeId(p));
      return nodeAsAstNodes(p);
    }
    case AN_JSX_ATTRIBUTE:
    case AN_JSX_SPREAD_ATTRIBUTE: {
      const p = propParent(id);
      return nodeKind(p) === N_EXPR ? mkAn(AN_JSX_OPENING_ELEMENT, nodeId(p)) : nodeAsAstNodes(p);
    }
    case AN_OBJECT_PROPERTY:
    case AN_ASSIGNMENT_TARGET_PROPERTY_IDENTIFIER:
    case AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY:
      return nodeAsAstNodes(propParent(id));
    case AN_VARIABLE_DECLARATOR: {
      const p = varDeclParent(id);
      return nodeKind(p) === N_STMT ? mkAn(AN_VARIABLE_DECLARATION, nodeId(p)) : nodeAsAstNodes(p);
    }
    case AN_CATCH_PARAMETER: {
      const p = varDeclParent(id);
      return nodeKind(p) === N_STMT ? mkAn(AN_CATCH_CLAUSE, nodeId(p)) : nodeAsAstNodes(p);
    }
    case AN_EXPORT_NAMED_DECLARATION:
    case AN_EXPORT_DEFAULT_DECLARATION:
      return parentOfStmt(id);
    case AN_CATCH_CLAUSE:
      return mkAn(AN_TRY_STATEMENT, id);
    case AN_TS_INTERFACE_BODY:
      return mkAn(AN_TS_INTERFACE_DECLARATION, id);
    case AN_TS_ENUM_BODY:
      return mkAn(AN_TS_ENUM_DECLARATION, id);
    case AN_TS_MODULE_BLOCK:
      return innerOfStmt(id);
    case AN_DIRECTIVE:
    case AN_BLOCK_STATEMENT:
    case AN_EMPTY_STATEMENT:
    case AN_DEBUGGER_STATEMENT:
    case AN_VARIABLE_DECLARATION:
    case AN_RETURN_STATEMENT:
    case AN_IF_STATEMENT:
    case AN_FOR_STATEMENT:
    case AN_FOR_IN_STATEMENT:
    case AN_FOR_OF_STATEMENT:
    case AN_WHILE_STATEMENT:
    case AN_DO_WHILE_STATEMENT:
    case AN_WITH_STATEMENT:
    case AN_SWITCH_STATEMENT:
    case AN_TRY_STATEMENT:
    case AN_THROW_STATEMENT:
    case AN_BREAK_STATEMENT:
    case AN_CONTINUE_STATEMENT:
    case AN_LABELED_STATEMENT:
    case AN_IMPORT_DECLARATION:
    case AN_EXPORT_ALL_DECLARATION:
    case AN_TS_INTERFACE_DECLARATION:
    case AN_TS_TYPE_ALIAS_DECLARATION:
    case AN_TS_ENUM_DECLARATION:
    case AN_TS_MODULE_DECLARATION:
    case AN_TS_GLOBAL_DECLARATION:
    case AN_TS_IMPORT_EQUALS_DECLARATION:
    case AN_TS_EXPORT_ASSIGNMENT:
    case AN_TS_NAMESPACE_EXPORT_DECLARATION: {
      const ex = exportAround(id);
      return ex >= 0 ? ex : parentOfStmt(id);
    }
    case AN_SWITCH_CASE: {
      const p = caseParent(id);
      return nodeKind(p) === N_STMT ? mkAn(AN_SWITCH_STATEMENT, nodeId(p)) : nodeAsAstNodes(p);
    }
    case AN_TS_ENUM_MEMBER: {
      const p = enumMemberParent(id);
      return nodeKind(p) === N_STMT ? mkAn(AN_TS_ENUM_BODY, nodeId(p)) : nodeAsAstNodes(p);
    }
    case AN_IMPORT_SPECIFIER:
      return mkAn(AN_IMPORT_DECLARATION, importStmt(importSpecImport(id)));
    case AN_EXPORT_SPECIFIER:
      return mkAn(AN_EXPORT_NAMED_DECLARATION, exportStmt(exportSpecExport(id)));
    case AN_BINDING_IDENTIFIER:
    case AN_OBJECT_PATTERN:
    case AN_ARRAY_PATTERN:
      return patAstParent(id);
    case AN_BINDING_PROPERTY:
      return nodeAsAstNodes(patPropParent(id));
    case AN_ASSIGNMENT_PATTERN_PROP:
      return mkAn(AN_BINDING_PROPERTY, id);
    case AN_ASSIGNMENT_PATTERN_ELEM:
    case AN_BINDING_REST_ELEMENT_ELEM:
      return nodeAsAstNodes(patElemParent(id));
    case AN_BINDING_REST_ELEMENT_PROP:
      return nodeAsAstNodes(patPropParent(id));
    case AN_TS_TYPE_ANNOTATION:
      return nodeAsAstNodes(typeParent(id));
    case AN_TS_KEYWORD_TYPE:
    case AN_TS_THIS_TYPE:
    case AN_TS_TYPE_REFERENCE:
    case AN_TS_LITERAL_TYPE:
    case AN_TS_TEMPLATE_LITERAL_TYPE:
    case AN_TS_ARRAY_TYPE:
    case AN_TS_TUPLE_TYPE:
    case AN_TS_UNION_TYPE:
    case AN_TS_INTERSECTION_TYPE:
    case AN_TS_FUNCTION_TYPE:
    case AN_TS_CONSTRUCTOR_TYPE:
    case AN_TS_TYPE_LITERAL:
    case AN_TS_CONDITIONAL_TYPE:
    case AN_TS_INFER_TYPE:
    case AN_TS_MAPPED_TYPE:
    case AN_TS_INDEXED_ACCESS_TYPE:
    case AN_TS_TYPE_OPERATOR:
    case AN_TS_TYPE_QUERY:
    case AN_TS_IMPORT_TYPE:
    case AN_TS_TYPE_PREDICATE:
    case AN_TS_CLASS_IMPLEMENTS:
    case AN_TS_INTERFACE_HERITAGE:
      return typeAstParent(id);
    case AN_TS_NAMED_TUPLE_MEMBER:
    case AN_TS_OPTIONAL_TYPE:
    case AN_TS_REST_TYPE:
      return nodeAsAstNodes(tupleElemParent(id));
    case AN_TS_TYPE_PARAMETER: {
      const p = typeParamParent(id);
      return nodeKind(p) === N_TYPE ? typeAsAstNodes(nodeId(p)) : mkTypeParametersAn(p);
    }
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_EXPR:
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_TYPE:
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_CLASS:
    case AN_TS_TYPE_PARAMETER_DECLARATION_FUNC:
    case AN_TS_TYPE_PARAMETER_DECLARATION_CLASS:
    case AN_TS_TYPE_PARAMETER_DECLARATION_STMT:
    case AN_TS_TYPE_PARAMETER_DECLARATION_TYPE: {
      const owner = anTypeParametersOwner(an);
      const ok = nodeKind(owner);
      if (ok === N_STMT) return innerOfStmt(id);
      if (ok === N_EXPR && exprTag(id) === EXPR_JSX) return mkAn(AN_JSX_OPENING_ELEMENT, id);
      return nodeAsAstNodes(owner);
    }
    default:
      return an;
  }
}

/** The parent of a `ChainExpression`, anything else itself. */
export function anWithoutChainExpression(an: number): number {
  let a = an;
  while ((a >> 23) === AN_CHAIN_EXPRESSION) a = anParent(a);
  return a;
}

/** Whether it is a call or a `new` expression whose callee is `e`. */
export function anIsCallLikeCallee(an: number, e: number): boolean {
  const t = an >> 23;
  return (t === AN_CALL_EXPRESSION || t === AN_NEW_EXPRESSION) && exprCallee(an & 0x7fffff) === e;
}

/** Writes the range that the node has in oxc into `SP`. */
export function anSpan(an: number): void {
  const id = an & 0x7fffff;
  const tag = an >> 23;
  // Every kind from the identifier up to the chain expression has the span of its expression.
  if (tag >= 1 && tag <= 43) {
    exprSpan(id);
    return;
  }
  const hir$ = hir;
  const SP$ = SP;
  switch (tag) {
    case AN_PROGRAM:
      SP$.s0 = 0;
      SP$.s1 = hir$.sourceLen | 0;
      return;
    case AN_JSX_EXPRESSION_CONTAINER:
    case AN_JSX_SPREAD_CHILD:
      if (!exprJsxContainerSpan(id)) exprSpan(id);
      return;
    case AN_JSX_OPENING_ELEMENT:
      if (exprTag(id) === EXPR_JSX) jsxOpeningSpan(id);
      else exprSpan(id);
      return;
    case AN_DECORATOR: {
      exprOuterSpan(id);
      const outerStart = SP$.s0 | 0;
      const outerEnd = SP$.s1 | 0;
      const back = skipTriviaBack(hir$.text, hir$.sourceLen | 0, outerStart);
      SP$.s0 = (back > 0 ? back - 1 : 0) | 0;
      SP$.s1 = (outerEnd) | 0;
      return;
    }
    case AN_ASSIGNMENT_TARGET_REST: {
      if (exprTag(id) === EXPR_SPREAD) {
        exprSpan(id);
        return;
      }
      const p = exprParent(id);
      if (nodeKind(p) === N_PROP) propSpan(nodeId(p));
      else exprSpan(id);
      return;
    }
    case AN_IDENTIFIER_REFERENCE:
    case AN_BOOLEAN_LITERAL:
    case AN_NULL_LITERAL:
    case AN_NUMERIC_LITERAL:
    case AN_BIG_INT_LITERAL:
    case AN_REG_EXP_LITERAL:
    case AN_STRING_LITERAL:
    case AN_TEMPLATE_LITERAL:
    case AN_THIS_EXPRESSION:
    case AN_SUPER:
    case AN_ARRAY_EXPRESSION:
    case AN_OBJECT_EXPRESSION:
    case AN_STATIC_MEMBER_EXPRESSION:
    case AN_COMPUTED_MEMBER_EXPRESSION:
    case AN_PRIVATE_FIELD_EXPRESSION:
    case AN_CALL_EXPRESSION:
    case AN_NEW_EXPRESSION:
    case AN_IMPORT_EXPRESSION:
    case AN_META_PROPERTY:
    case AN_TAGGED_TEMPLATE_EXPRESSION:
    case AN_UNARY_EXPRESSION:
    case AN_UPDATE_EXPRESSION:
    case AN_BINARY_EXPRESSION:
    case AN_LOGICAL_EXPRESSION:
    case AN_PRIVATE_IN_EXPRESSION:
    case AN_ASSIGNMENT_EXPRESSION:
    case AN_CONDITIONAL_EXPRESSION:
    case AN_AWAIT_EXPRESSION:
    case AN_YIELD_EXPRESSION:
    case AN_TS_AS_EXPRESSION:
    case AN_TS_SATISFIES_EXPRESSION:
    case AN_TS_TYPE_ASSERTION:
    case AN_TS_NON_NULL_EXPRESSION:
    case AN_TS_INSTANTIATION_EXPRESSION:
    case AN_JSX_ELEMENT:
    case AN_JSX_FRAGMENT:
    case AN_JSX_TEXT:
    case AN_JSX_EMPTY_EXPRESSION:
    case AN_ELISION:
    case AN_PRIVATE_IDENTIFIER:
    case AN_SEQUENCE_EXPRESSION:
    case AN_CHAIN_EXPRESSION:
    case AN_ARRAY_ASSIGNMENT_TARGET:
    case AN_OBJECT_ASSIGNMENT_TARGET:
    case AN_ASSIGNMENT_TARGET_WITH_DEFAULT:
    case AN_TYPE_CAST_EXPRESSION:
    case AN_SPREAD_ELEMENT_EXPR:
      exprSpan(id);
      return;
    case AN_ASSIGNMENT_PATTERN_PROP: {
      const d = patPropDefault(id);
      if (d >= 0) {
        patSpan(patPropValue(id));
        const s = SP$.s0 | 0;
        exprSpan(d);
        SP$.s0 = (s) | 0;
      } else {
        patPropSpan(id);
      }
      return;
    }
    case AN_SPREAD_ELEMENT_PROP:
      propSpan(id);
      return;
    case AN_ASSIGNMENT_PATTERN_ELEM:
    case AN_BINDING_REST_ELEMENT_ELEM:
      patElemSpan(id);
      return;
    case AN_BINDING_REST_ELEMENT_PROP:
      patPropSpan(id);
      return;
    case AN_EXPRESSION_STATEMENT:
      stmtSpan(id);
      return;
    case AN_ARROW_BODY_EXPRESSION_STATEMENT: {
      const e = funcBodyKind(id) === BODY_EXPR ? funcBodyExpr(id) : -1;
      if (e >= 0) exprSpan(e);
      else {
        SP$.s0 = 0;
        SP$.s1 = 0;
      }
      return;
    }
    case AN_FUNCTION:
    case AN_ARROW_FUNCTION_EXPRESSION:
      funcEstreeSpan(id);
      return;
    case AN_FUNCTION_BODY: {
      if (funcBodyKind(id) === BODY_EXPR) {
        exprSpan(funcBodyExpr(id));
        return;
      }
      if (!funcBodySpan(id)) {
        funcSpan(id);
        const end = SP$.s1 | 0;
        SP$.s0 = (end) | 0;
        SP$.s1 = (end) | 0;
      }
      return;
    }
    case AN_FORMAL_PARAMETERS: {
      if (!funcParamsSpan(id)) funcSpan(id);
      const start = SP$.s0 | 0;
      let end = SP$.s1 | 0;
      const behind = arrowBehindParameters(id);
      if (behind >= 0) end = behind;
      SP$.s0 = (start) | 0;
      SP$.s1 = (end) | 0;
      return;
    }
    case AN_CLASS:
      classEstreeSpan(id);
      return;
    case AN_CLASS_BODY:
      classBodySpan(id);
      return;
    case AN_FORMAL_PARAMETER:
    case AN_FORMAL_PARAMETER_REST:
    case AN_TS_THIS_PARAMETER:
      paramSpan(id);
      return;
    case AN_METHOD_DEFINITION:
    case AN_PROPERTY_DEFINITION:
    case AN_ACCESSOR_PROPERTY:
    case AN_STATIC_BLOCK:
    case AN_TS_INDEX_SIGNATURE:
    case AN_TS_PROPERTY_SIGNATURE:
    case AN_TS_METHOD_SIGNATURE:
    case AN_TS_CALL_SIGNATURE_DECLARATION:
    case AN_TS_CONSTRUCT_SIGNATURE_DECLARATION:
      memberSpan(id);
      return;
    case AN_OBJECT_PROPERTY:
    case AN_JSX_ATTRIBUTE:
    case AN_JSX_SPREAD_ATTRIBUTE:
    case AN_ASSIGNMENT_TARGET_PROPERTY_IDENTIFIER:
    case AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY:
      propSpan(id);
      return;
    case AN_VARIABLE_DECLARATOR:
    case AN_CATCH_PARAMETER:
      varDeclSpan(id);
      return;
    case AN_EXPORT_NAMED_DECLARATION:
    case AN_EXPORT_DEFAULT_DECLARATION:
      if (isFlowDeclareExport(id)) stmtSpan(id);
      else if (!stmtExportSpan(id)) stmtSpan(id);
      return;
    case AN_CATCH_CLAUSE:
      if (!stmtCatchClauseSpan(id)) stmtSpan(id);
      return;
    case AN_TS_INTERFACE_BODY:
      if (stmtTag(id) === STMT_INTERFACE) interfaceBodySpan(stmtInterfaceInterface(id));
      else stmtSpan(id);
      return;
    case AN_TS_ENUM_BODY:
      if (stmtTag(id) === STMT_ENUM) enumBodySpan(stmtEnumEnum(id));
      else stmtSpan(id);
      return;
    case AN_TS_MODULE_BLOCK:
      if (stmtTag(id) === STMT_MODULE) {
        if (!moduleBodySpan(moduleInnermost(stmtModuleModule(id)))) stmtSpan(id);
      } else stmtSpan(id);
      return;
    case AN_DIRECTIVE:
    case AN_BLOCK_STATEMENT:
    case AN_EMPTY_STATEMENT:
    case AN_DEBUGGER_STATEMENT:
    case AN_VARIABLE_DECLARATION:
    case AN_RETURN_STATEMENT:
    case AN_IF_STATEMENT:
    case AN_FOR_STATEMENT:
    case AN_FOR_IN_STATEMENT:
    case AN_FOR_OF_STATEMENT:
    case AN_WHILE_STATEMENT:
    case AN_DO_WHILE_STATEMENT:
    case AN_WITH_STATEMENT:
    case AN_SWITCH_STATEMENT:
    case AN_TRY_STATEMENT:
    case AN_THROW_STATEMENT:
    case AN_BREAK_STATEMENT:
    case AN_CONTINUE_STATEMENT:
    case AN_LABELED_STATEMENT:
    case AN_IMPORT_DECLARATION:
    case AN_EXPORT_ALL_DECLARATION:
    case AN_TS_INTERFACE_DECLARATION:
    case AN_TS_TYPE_ALIAS_DECLARATION:
    case AN_TS_ENUM_DECLARATION:
    case AN_TS_MODULE_DECLARATION:
    case AN_TS_GLOBAL_DECLARATION:
    case AN_TS_IMPORT_EQUALS_DECLARATION:
    case AN_TS_EXPORT_ASSIGNMENT:
    case AN_TS_NAMESPACE_EXPORT_DECLARATION:
      stmtSpanWithoutExport(id);
      return;
    case AN_SWITCH_CASE:
      caseSpan(id);
      return;
    case AN_TS_ENUM_MEMBER:
      enumMemberSpan(id);
      return;
    case AN_IMPORT_SPECIFIER:
      importSpecSpan(id);
      return;
    case AN_EXPORT_SPECIFIER:
      exportSpecSpan(id);
      return;
    case AN_BINDING_IDENTIFIER:
    case AN_OBJECT_PATTERN:
    case AN_ARRAY_PATTERN:
      patSpan(id);
      return;
    case AN_BINDING_PROPERTY:
      patPropSpan(id);
      return;
    case AN_TS_TYPE_ANNOTATION:
      typeAnnotationSpan(id);
      return;
    case AN_TS_KEYWORD_TYPE:
    case AN_TS_THIS_TYPE:
    case AN_TS_TYPE_REFERENCE:
    case AN_TS_LITERAL_TYPE:
    case AN_TS_TEMPLATE_LITERAL_TYPE:
    case AN_TS_ARRAY_TYPE:
    case AN_TS_TUPLE_TYPE:
    case AN_TS_UNION_TYPE:
    case AN_TS_INTERSECTION_TYPE:
    case AN_TS_FUNCTION_TYPE:
    case AN_TS_CONSTRUCTOR_TYPE:
    case AN_TS_TYPE_LITERAL:
    case AN_TS_CONDITIONAL_TYPE:
    case AN_TS_INFER_TYPE:
    case AN_TS_MAPPED_TYPE:
    case AN_TS_INDEXED_ACCESS_TYPE:
    case AN_TS_TYPE_OPERATOR:
    case AN_TS_TYPE_QUERY:
    case AN_TS_IMPORT_TYPE:
    case AN_TS_TYPE_PREDICATE:
    case AN_TS_CLASS_IMPLEMENTS:
    case AN_TS_INTERFACE_HERITAGE:
      typeSpan(id);
      return;
    case AN_TS_NAMED_TUPLE_MEMBER:
    case AN_TS_OPTIONAL_TYPE:
    case AN_TS_REST_TYPE:
      tupleElemSpan(id);
      return;
    case AN_TS_TYPE_PARAMETER:
      typeParamSpan(id);
      return;
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_EXPR:
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_TYPE:
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_CLASS: {
      const owner = anTypeParametersOwner(an);
      if (typeArgumentsOf(owner) && typeListAngleBrackets(TL[0] | 0, TL[1] | 0)) return;
      nodeSpanOfNode(owner);
      return;
    }
    default: {
      // AN_TS_TYPE_PARAMETER_DECLARATION_*
      const owner = anTypeParametersOwner(an);
      if (typeParametersOf(owner) && typeParamListAngleBrackets(TL[0] | 0, TL[1] | 0)) return;
      nodeSpanOfNode(owner);
      return;
    }
  }
}

function nodeSpanOfNode(node: number): void {
  // `Node::span()`: the generic walk lives in the handle layer.
  nodeSpan(node);
}

export function anStart(an: number): number {
  const tag = an >> 23;
  if (tag >= 1 && tag <= 43) return exprStart(an & 0x7fffff);
  anSpan(an);
  return SP.s0 | 0;
}
export function anEnd(an: number): number {
  const tag = an >> 23;
  if (tag >= 1 && tag <= 43) return exprEnd(an & 0x7fffff);
  anSpan(an);
  return SP.s1 | 0;
}

/** The list `(start, len)` that `typeArgumentsOf` / `typeParametersOf` found. */
export const TL = new Int32Array(2);

/** The type arguments that `owner` (a `Node`) has: false if it has none (the list is in `TL`). */
export function typeArgumentsOf(owner: number): boolean {
  const id = nodeId(owner);
  switch (nodeKind(owner)) {
    case N_EXPR:
      switch (exprTag(id)) {
        case EXPR_CALL:
        case EXPR_NEW:
        case EXPR_TAGGED_TEMPLATE: {
          const call = exprAsCallLike(id);
          TL[0] = callTypeArgsStart(call);
          TL[1] = callTypeArgsLen(call);
          return true;
        }
        case EXPR_INSTANTIATION:
          TL[0] = exprInstantiationTypeArgsStart(id);
          TL[1] = exprInstantiationTypeArgsLen(id);
          return true;
        case EXPR_JSX:
          TL[0] = jsxTypeArgsStart(id);
          TL[1] = jsxTypeArgsLen(id);
          return true;
        default:
          return false;
      }
    case N_TYPE:
      switch (typeTag(id)) {
        case TYPE_REF:
          TL[0] = typeRefArgsStart(id);
          TL[1] = typeRefArgsLen(id);
          return true;
        case TYPE_HERITAGE:
          TL[0] = typeHeritageArgsStart(id);
          TL[1] = typeHeritageArgsLen(id);
          return true;
        case TYPE_TYPEOF:
          TL[0] = typeTypeofArgsStart(id);
          TL[1] = typeTypeofArgsLen(id);
          return true;
        case TYPE_IMPORT:
          TL[0] = typeImportArgsStart(id);
          TL[1] = typeImportArgsLen(id);
          return true;
        default:
          return false;
      }
    case N_CLASS:
      TL[0] = classExtendsArgsStart(id);
      TL[1] = classExtendsArgsLen(id);
      return true;
    default:
      return false;
  }
}

/** The type parameters that `owner` (a `Node`) declares: false if it has none to declare (the list is in `TL`). */
export function typeParametersOf(owner: number): boolean {
  const id = nodeId(owner);
  switch (nodeKind(owner)) {
    case N_FUNC:
      TL[0] = funcTypeParamsStart(id);
      TL[1] = funcTypeParamsLen(id);
      return true;
    case N_CLASS:
      TL[0] = classTypeParamsStart(id);
      TL[1] = classTypeParamsLen(id);
      return true;
    case N_STMT:
      switch (stmtTag(id)) {
        case STMT_INTERFACE: {
          const i = stmtInterfaceInterface(id);
          TL[0] = interfaceTypeParamsStart(i);
          TL[1] = interfaceTypeParamsLen(i);
          return true;
        }
        case STMT_TYPE_ALIAS: {
          const a = stmtTypeAliasAlias(id);
          TL[0] = aliasTypeParamsStart(a);
          TL[1] = aliasTypeParamsLen(a);
          return true;
        }
        default:
          return false;
      }
    default:
      return false;
  }
}
