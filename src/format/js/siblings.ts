// Port of vendor/bun/src/format/js/siblings.rs: where the next sibling of a node starts.
//
// `Comments::getTrailingComments` needs it to tell the comments that trail a node from those that lead the next one. In oxc every node
// carries it around. Here it is only computed for a node that has a comment after it.
//
// The rules, which are those of oxc's generated `AstNode` accessors:
// - It is the start of the next child of the parent that is there, in the order of the fields.
// - After the last element of a list it is 0, "there is none", even if other fields follow. The lists that a rest element can follow,
//   and directives, are the exception.
// - After the last child, it is that of the parent. If the parent is a statement, a pattern or a list of parameters, it is 0.
import {
  BODY_BLOCK,
  BODY_EXPR,
  EXPR_ARRAY,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_ASSIGN,
  EXPR_BINARY,
  EXPR_COND,
  EXPR_DOT,
  EXPR_IMPORT_CALL,
  EXPR_INDEX,
  EXPR_INSTANTIATION,
  EXPR_JSX,
  EXPR_OBJECT,
  EXPR_SATISFIES,
  EXPR_TEMPLATE,
  KEY_NONE,
  MODNAME_GLOBAL,
  IET_REQUIRE,
  PAT_ARRAY,
  PAT_OBJECT,
  SP,
  STMT_BLOCK,
  STMT_DO_WHILE,
  STMT_ENUM,
  STMT_EXPR,
  STMT_EXPORT_NAMED,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IF,
  STMT_IMPORT,
  STMT_IMPORT_EQUALS,
  STMT_INTERFACE,
  STMT_LABELED,
  STMT_MODULE,
  STMT_SWITCH,
  STMT_TRY,
  STMT_TYPE_ALIAS,
  STMT_VAR,
  STMT_WHILE,
  TYPE_COND,
  TYPE_HERITAGE,
  TYPE_IMPORT,
  TYPE_INDEXED_ACCESS,
  TYPE_INTERSECTION,
  TYPE_MAPPED,
  TYPE_OBJECT,
  TYPE_PREDICATE,
  TYPE_REF,
  TYPE_TEMPLATE,
  TYPE_TUPLE,
  TYPE_TYPEOF,
  TYPE_UNION,
  TYPE_FN,
  aliasName,
  aliasNamePos,
  aliasTy,
  aliasTypeParamsLen,
  aliasTypeParamsStart,
  callArgsLen,
  callArgsStart,
  callCallee,
  callTemplate,
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
  classImplementsLen,
  classImplementsStart,
  classMembersLen,
  classMembersStart,
  className,
  classNamePos,
  classModifiersLen,
  classModifiersStart,
  classTypeParamsLen,
  classTypeParamsStart,
  enumBodySpan,
  enumMemberInit,
  enumMemberSpan,
  enumMembersLen,
  enumMembersStart,
  enumName,
  enumNamePos,
  exportItemsLen,
  exportItemsStart,
  exportSpecExported,
  exportSpecExportedPos,
  exportSpecLocal,
  exportSpecLocalPos,
  exportSpecSpan,
  exportSpecSpanOf,
  exprAsCallLike,
  exprAssignTarget,
  exprAssignValue,
  exprAsConstExpr,
  exprAsExpr,
  exprAsTy,
  exprBinaryLeft,
  exprBinaryRight,
  exprCondNo,
  exprCondTest,
  exprCondYes,
  exprConstKeywordSpan,
  exprDotName,
  exprDotNamePos,
  exprDotObj,
  exprImportCallArgsLen,
  exprImportCallArgsStart,
  exprIndexIndex,
  exprIndexObj,
  exprInstantiationExpr,
  exprInstantiationTypeArgsLen,
  exprInstantiationTypeArgsStart,
  exprIsMissing,
  exprJsxContainerSpan,
  exprObjectPropsLen,
  exprObjectPropsStart,
  exprArrayElemsLen,
  exprArrayElemsStart,
  exprSatisfiesExpr,
  exprSatisfiesTy,
  exprSequence,
  exprSpan,
  exprTag,
  exprTemplateExprsLen,
  exprTemplateExprsStart,
  fileBodyLen,
  fileBodyStart,
  fileIsFlow,
  fileIsJavascript,
  funcBodyExpr,
  funcBodyKind,
  funcBodySpan,
  funcBodyStmtsLen,
  funcBodyStmtsStart,
  funcEstreeSpan,
  funcName,
  funcNamePos,
  funcParamsLen,
  funcParamsSpan,
  funcParamsStart,
  funcReturnType,
  funcThisParam,
  funcTypeParamsLen,
  funcTypeParamsStart,
  identSpan,
  importDefault,
  importDefaultPos,
  importNamedLen,
  importNamedStart,
  importNamespaceSpan,
  importSpecImported,
  importSpecImportedPos,
  importSpecLocal,
  importSpecLocalPos,
  importSpecSpanOf,
  importSpecSpan,
  importEqualsEntityLen,
  importEqualsEntityStart,
  importEqualsName,
  importEqualsNamePos,
  importEqualsRequireSpan,
  importEqualsTargetKind,
  interfaceBodySpan,
  interfaceExtendsLen,
  interfaceExtendsStart,
  interfaceMembersLen,
  interfaceMembersStart,
  interfaceName,
  interfaceNamePos,
  interfaceTypeParamsLen,
  interfaceTypeParamsStart,
  jsxAttrsLen,
  jsxAttrsStart,
  jsxChildrenLen,
  jsxChildrenStart,
  jsxClosingSpan,
  jsxOpeningSpan,
  jsxTag,
  jsxTypeArgsLen,
  jsxTypeArgsStart,
  keyKind,
  keySpan,
  listAt,
  mappedNameTy,
  mappedParam,
  mappedTy,
  memberConstructorKeyword,
  memberFunc,
  memberInit,
  memberModifiersLen,
  memberModifiersStart,
  memberNamePos,
  memberTy,
  modifierDecorator,
  moduleBodyLen,
  moduleBodySpan,
  moduleBodyStart,
  moduleInnermost,
  moduleName,
  moduleNameKind,
  moduleNamePos,
  nodeOfEnumMember,
  nodeOfMember,
  nodeOfPatProp,
  nodeOfProp,
  paramDefault,
  paramModifiersLen,
  paramModifiersStart,
  paramPat,
  paramSpan,
  paramTy,
  patElemDefault,
  patElemPat,
  patElemSpan,
  patPropDefault,
  patPropValue,
  patSpan,
  patTag,
  patObjectPropsLen,
  patObjectPropsStart,
  patArrayElemsLen,
  patArrayElemsStart,
  propFunc,
  propSpan,
  propValue,
  spTokenIs,
  stmtCatchClauseSpan,
  stmtExportNamedExport,
  stmtForBody,
  stmtForInBody,
  stmtForInExpr,
  stmtForInLeft,
  stmtForInit,
  stmtForOfBody,
  stmtForOfExpr,
  stmtForOfLeft,
  stmtForTest,
  stmtForUpdate,
  stmtIfNo,
  stmtIfTest,
  stmtIfYes,
  stmtLabel,
  stmtLabelPos,
  stmtLabeledBody,
  stmtDoWhileBody,
  stmtDoWhileTest,
  stmtWhileBody,
  stmtWhileTest,
  stmtWithBody,
  stmtWithObject,
  stmtIsWith,
  stmtBlockStmtsLen,
  stmtBlockStmtsStart,
  stmtSwitchCasesLen,
  stmtSwitchCasesStart,
  stmtSwitchExpr,
  stmtTag,
  stmtSpan,
  stmtTryBlock,
  stmtTryFinalizer,
  stmtTryHandler,
  stmtTryParam,
  stmtVarDeclsLen,
  stmtVarDeclsStart,
  stmtExprExpr,
  stmtEnumEnum,
  stmtInterfaceInterface,
  stmtTypeAliasAlias,
  stmtModuleModule,
  stmtImportImport,
  stmtImportEqualsImportEquals,
  tupleElemName,
  tupleElemNamePos,
  tupleElemSpan,
  tupleElemTy,
  typeAnnotationSpan,
  typeCondCheck,
  typeCondExtends,
  typeCondNo,
  typeCondYes,
  typeFnFn,
  typeHeritageExpr,
  typeImportSourceSpan,
  typeIndexedAccessIndex,
  typeIndexedAccessObj,
  typeIntersectionTypesLen,
  typeIntersectionTypesStart,
  typeMappedMapped,
  typeObjectMembersLen,
  typeObjectMembersStart,
  typePredicateParamAtom,
  typePredicateParamPos,
  typePredicateTy,
  typeRefNameLen,
  typeRefNameStart,
  typeSpan,
  typeTag,
  typeTemplateTypesLen,
  typeTemplateTypesStart,
  typeTupleElemsLen,
  typeTupleElemsStart,
  typeTypeofExpr,
  typeUnionTypesLen,
  typeUnionTypesStart,
  typeParamConstraint,
  typeParamDefault,
  typeParamFlowTokenAfterName,
  typeParamListAngleBrackets,
  typeParamName,
  typeParamNamePos,
  typeParamSpan,
  typeListAngleBrackets,
  entitySpan,
  varDeclInit,
  varDeclPat,
  varDeclSpan,
  varDeclTy,
  nodeOfType,
} from "../../lint/ast/index.ts";
import { FLAVOR_OXFMT } from "../options.ts";
import {
  AN_ARRAY_ASSIGNMENT_TARGET,
  AN_ARRAY_EXPRESSION,
  AN_ARRAY_PATTERN,
  AN_ARROW_BODY_EXPRESSION_STATEMENT,
  AN_ARROW_FUNCTION_EXPRESSION,
  AN_ASSIGNMENT_EXPRESSION,
  AN_ASSIGNMENT_PATTERN_ELEM,
  AN_ASSIGNMENT_PATTERN_PROP,
  AN_ASSIGNMENT_TARGET_PROPERTY_IDENTIFIER,
  AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY,
  AN_ASSIGNMENT_TARGET_WITH_DEFAULT,
  AN_ACCESSOR_PROPERTY,
  AN_BINARY_EXPRESSION,
  AN_BINDING_PROPERTY,
  AN_BLOCK_STATEMENT,
  AN_BREAK_STATEMENT,
  AN_CALL_EXPRESSION,
  AN_CATCH_CLAUSE,
  AN_CATCH_PARAMETER,
  AN_CLASS,
  AN_CLASS_BODY,
  AN_COMPUTED_MEMBER_EXPRESSION,
  AN_CONDITIONAL_EXPRESSION,
  AN_CONTINUE_STATEMENT,
  AN_DEBUGGER_STATEMENT,
  AN_DECORATOR,
  AN_DIRECTIVE,
  AN_DO_WHILE_STATEMENT,
  AN_EMPTY_STATEMENT,
  AN_EXPORT_ALL_DECLARATION,
  AN_EXPORT_DEFAULT_DECLARATION,
  AN_EXPORT_NAMED_DECLARATION,
  AN_EXPORT_SPECIFIER,
  AN_EXPRESSION_STATEMENT,
  AN_FORMAL_PARAMETER,
  AN_FORMAL_PARAMETER_REST,
  AN_FORMAL_PARAMETERS,
  AN_FOR_IN_STATEMENT,
  AN_FOR_OF_STATEMENT,
  AN_FOR_STATEMENT,
  AN_FUNCTION,
  AN_FUNCTION_BODY,
  AN_IF_STATEMENT,
  AN_IMPORT_DECLARATION,
  AN_IMPORT_EXPRESSION,
  AN_IMPORT_SPECIFIER,
  AN_JSX_ATTRIBUTE,
  AN_JSX_ELEMENT,
  AN_JSX_FRAGMENT,
  AN_JSX_OPENING_ELEMENT,
  AN_LABELED_STATEMENT,
  AN_LOGICAL_EXPRESSION,
  AN_METHOD_DEFINITION,
  AN_NEW_EXPRESSION,
  AN_OBJECT_ASSIGNMENT_TARGET,
  AN_OBJECT_EXPRESSION,
  AN_OBJECT_PATTERN,
  AN_OBJECT_PROPERTY,
  AN_PRIVATE_FIELD_EXPRESSION,
  AN_PRIVATE_IN_EXPRESSION,
  AN_PROGRAM,
  AN_PROPERTY_DEFINITION,
  AN_RETURN_STATEMENT,
  AN_SEQUENCE_EXPRESSION,
  AN_STATIC_BLOCK,
  AN_STATIC_MEMBER_EXPRESSION,
  AN_SWITCH_CASE,
  AN_SWITCH_STATEMENT,
  AN_TAGGED_TEMPLATE_EXPRESSION,
  AN_TEMPLATE_LITERAL,
  AN_THROW_STATEMENT,
  AN_TRY_STATEMENT,
  AN_TS_AS_EXPRESSION,
  AN_TS_CALL_SIGNATURE_DECLARATION,
  AN_TS_CLASS_IMPLEMENTS,
  AN_TS_CONDITIONAL_TYPE,
  AN_TS_CONSTRUCT_SIGNATURE_DECLARATION,
  AN_TS_CONSTRUCTOR_TYPE,
  AN_TS_ENUM_BODY,
  AN_TS_ENUM_DECLARATION,
  AN_TS_ENUM_MEMBER,
  AN_TS_EXPORT_ASSIGNMENT,
  AN_TS_FUNCTION_TYPE,
  AN_TS_GLOBAL_DECLARATION,
  AN_TS_IMPORT_EQUALS_DECLARATION,
  AN_TS_IMPORT_TYPE,
  AN_TS_INDEX_SIGNATURE,
  AN_TS_INDEXED_ACCESS_TYPE,
  AN_TS_INSTANTIATION_EXPRESSION,
  AN_TS_INTERFACE_BODY,
  AN_TS_INTERFACE_DECLARATION,
  AN_TS_INTERFACE_HERITAGE,
  AN_TS_INTERSECTION_TYPE,
  AN_TS_MAPPED_TYPE,
  AN_TS_METHOD_SIGNATURE,
  AN_TS_MODULE_BLOCK,
  AN_TS_MODULE_DECLARATION,
  AN_TS_NAMED_TUPLE_MEMBER,
  AN_TS_NAMESPACE_EXPORT_DECLARATION,
  AN_TS_PROPERTY_SIGNATURE,
  AN_TS_SATISFIES_EXPRESSION,
  AN_TS_TEMPLATE_LITERAL_TYPE,
  AN_TS_THIS_PARAMETER,
  AN_TS_TUPLE_TYPE,
  AN_TS_TYPE_ALIAS_DECLARATION,
  AN_TS_TYPE_ASSERTION,
  AN_TS_TYPE_LITERAL,
  AN_TS_TYPE_PARAMETER,
  AN_TS_TYPE_PARAMETER_DECLARATION_CLASS,
  AN_TS_TYPE_PARAMETER_DECLARATION_FUNC,
  AN_TS_TYPE_PARAMETER_DECLARATION_STMT,
  AN_TS_TYPE_PARAMETER_DECLARATION_TYPE,
  AN_TS_TYPE_PARAMETER_INSTANTIATION_CLASS,
  AN_TS_TYPE_PARAMETER_INSTANTIATION_EXPR,
  AN_TS_TYPE_PARAMETER_INSTANTIATION_TYPE,
  AN_TS_TYPE_PREDICATE,
  AN_TS_TYPE_QUERY,
  AN_TS_TYPE_REFERENCE,
  AN_TS_UNION_TYPE,
  AN_TYPE_CAST_EXPRESSION,
  AN_VARIABLE_DECLARATION,
  AN_VARIABLE_DECLARATOR,
  AN_WHILE_STATEMENT,
  AN_WITH_STATEMENT,
  TL,
  anParent,
  anSpan,
  anTag,
  anId,
  anTypeParametersOwner,
  mkAn,
  funcAsAstNodes,
  typeArgumentsOf,
  typeParametersOf,
} from "./ast_nodes.ts";
import { I32Vec } from "../../sema/vec.ts";
import { finder } from "./state.ts";

// The kinds of the elements of a list, for `listOf`.
const LK_STMT: number = 0;
const LK_EXPR: number = 1;
/** An element of an array literal: a hole is no child. */
const LK_ARRAY_ELEM: number = 2;
const LK_PROP: number = 3;
/** A child of a JSX element: with the braces of `{e}`. */
const LK_JSX_CHILD: number = 4;
const LK_PAT_PROP: number = 5;
/** An element of an array pattern: a hole is no child. */
const LK_PAT_ELEM: number = 6;
const LK_CASE: number = 7;
const LK_TYPE: number = 8;
const LK_TUPLE_ELEM: number = 9;
const LK_TYPE_PARAM: number = 10;
const LK_PARAM: number = 11;
const LK_MEMBER: number = 12;
const LK_VAR_DECL: number = 13;
const LK_ENUM_MEMBER: number = 14;
const LK_IMPORT_SPEC: number = 15;
const LK_EXPORT_SPEC: number = 16;

/** The span of an element of a list into `SP`: false if it is no child (a hole). */
function elemSpan(kind: number, id: number): boolean {
  switch (kind) {
    case LK_STMT:
      stmtSpan(id);
      return true;
    case LK_EXPR:
      exprSpan(id);
      return true;
    case LK_ARRAY_ELEM:
      if (exprIsMissing(id)) return false;
      exprSpan(id);
      return true;
    case LK_PROP:
      propSpan(id);
      return true;
    case LK_JSX_CHILD:
      if (!exprJsxContainerSpan(id)) exprSpan(id);
      return true;
    case LK_PAT_PROP:
      patPropSpanOf(id);
      return true;
    case LK_PAT_ELEM:
      if (patElemPat(id) < 0) return false;
      patElemSpan(id);
      return true;
    case LK_CASE:
      caseSpan(id);
      return true;
    case LK_TYPE:
      typeSpan(id);
      return true;
    case LK_TUPLE_ELEM:
      tupleElemSpan(id);
      return true;
    case LK_TYPE_PARAM:
      typeParamSpan(id);
      return true;
    case LK_PARAM:
      paramSpan(id);
      return true;
    case LK_MEMBER:
      memberSpanOf(id);
      return true;
    case LK_VAR_DECL:
      varDeclSpan(id);
      return true;
    case LK_ENUM_MEMBER:
      enumMemberSpan(id);
      return true;
    case LK_IMPORT_SPEC:
      importSpecSpan(id);
      return true;
    default:
      exportSpecSpan(id);
      return true;
  }
}

function patPropSpanOf(id: number): void {
  anSpan(mkAn(AN_BINDING_PROPERTY, id));
}
function memberSpanOf(id: number): void {
  anSpan(mkAn(AN_METHOD_DEFINITION, id));
}

/** A list of children in source order. `isOpen`: what follows the list follows its last element. */
function list(kind: number, start: number, len: number, isOpen: boolean): void {
  listOf(kind, start, len, isOpen);
}

/** `Finder::list_of`: `kind` says where an element is, and whether it is a child. */
function listOf(kind: number, start: number, len: number, isOpen: boolean): void {
  const fd = finder;
  if (fd.following >= 0) return;
  const SP$ = SP;
  if (fd.isFound) {
    for (let i = 0; i < len; i++) {
      if (elemSpan(kind, listAt(start, i))) {
        fd.following = SP$.s0 | 0;
        return;
      }
    }
    return;
  }
  // A binary search for the first element that does not end before `me` does.
  let low = 0;
  let high = len;
  while (low < high) {
    const middle = (low + ((high - low) >> 1)) | 0;
    const id = listAt(start, middle);
    // `span_of(it).unwrap_or_else(|| it.span()).end`: a hole has the span of the element.
    if (!elemSpan(kind, id)) elemSpanAny(kind, id);
    if ((SP$.s1 | 0) < fd.meEnd) low = (middle + 1) | 0;
    else high = middle;
  }
  if (low < len && elemSpan(kind, listAt(start, low)) && fd.containsMe(SP$.s0 | 0, SP$.s1 | 0)) {
    fd.isFound = true;
    let next = -1;
    for (let at = low + 1; at < len; at++) {
      if (elemSpan(kind, listAt(start, at))) {
        next = SP$.s0 | 0;
        break;
      }
    }
    if (next >= 0) fd.following = next;
    else if (!isOpen) fd.following = 0;
  }
}

/** The span of a hole of an array or of an array pattern. */
function elemSpanAny(kind: number, id: number): void {
  if (kind === LK_ARRAY_ELEM) exprSpan(id);
  else patElemSpan(id);
}

/** `key_span(key, node)`: the key of the owner (a Node), if it has one. */
function key(owner: number): void {
  const has = keyKind(owner) !== KEY_NONE && keySpan(owner);
  const SP$ = SP;
  finder.one(has, has ? SP$.s0 | 0 : 0, has ? SP$.s1 | 0 : 0);
}

function oneSpan(has: boolean): void {
  const SP$ = SP;
  finder.one(has, has ? SP$.s0 | 0 : 0, has ? SP$.s1 | 0 : 0);
}

function oneExpr(e: number): void {
  const finder$ = finder;
  if (e < 0) {
    finder$.one(false, 0, 0);
    return;
  }
  exprSpan(e);
  const SP$ = SP;
  finder$.one(true, SP$.s0 | 0, SP$.s1 | 0);
}

function oneStmt(s: number): void {
  const finder$ = finder;
  if (s < 0) {
    finder$.one(false, 0, 0);
    return;
  }
  stmtSpan(s);
  const SP$ = SP;
  finder$.one(true, SP$.s0 | 0, SP$.s1 | 0);
}

function oneType(t: number): void {
  const finder$ = finder;
  if (t < 0) {
    finder$.one(false, 0, 0);
    return;
  }
  typeSpan(t);
  const SP$ = SP;
  finder$.one(true, SP$.s0 | 0, SP$.s1 | 0);
}

function oneTypeAnnotation(t: number): void {
  const finder$ = finder;
  if (t < 0) {
    finder$.one(false, 0, 0);
    return;
  }
  typeAnnotationSpan(t);
  const SP$ = SP;
  finder$.one(true, SP$.s0 | 0, SP$.s1 | 0);
}

function oneIdent(atom: number, pos: number): void {
  const finder$ = finder;
  if (atom < 0) {
    finder$.one(false, 0, 0);
    return;
  }
  identSpan(atom, pos);
  const SP$ = SP;
  finder$.one(true, SP$.s0 | 0, SP$.s1 | 0);
}

/** The decorators among the modifiers `(start, len)`. */
function decorators(start: number, len: number): void {
  const fd = finder;
  fd.spansBegin();
  const SP$ = SP;
  for (let i = 0; i < len; i++) {
    const d = modifierDecorator(listAt(start, i));
    if (d >= 0) {
      anSpan(mkAn(AN_DECORATOR, d));
      fd.spansItem(SP$.s0 | 0, SP$.s1 | 0);
    }
  }
  fd.spansEnd(false);
}

/** The fields of everything that has parameters: type parameters, `this`, parameters, return type and body. */
function functionFields(func: number): void {
  const fd = finder;
  const n = funcParamsLen(func);
  const firstParameter = n > 0 ? firstSpanStart(LK_PARAM, funcParamsStart(func)) : -1;
  const ts = funcTypeParamsStart(func);
  const tn = funcTypeParamsLen(func);
  oneSpan(typeParamListAngleBrackets(ts, tn));
  const thisParam = funcThisParam(func);
  const SP$ = SP;
  if (thisParam >= 0) {
    paramSpan(thisParam);
    fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
  } else fd.one(false, 0, 0);
  // `this` is in the parentheses. If it is the only parameter, nothing follows it there.
  if (fd.isFound && fd.following < 0 && thisParam >= 0) {
    paramSpan(thisParam);
    if (fd.containsMe(SP$.s0 | 0, SP$.s1 | 0)) fd.following = firstParameter >= 0 ? firstParameter : 0;
  }
  const hasParams = funcParamsSpan(func);
  fd.transparent(hasParams, hasParams ? SP$.s0 | 0 : 0, hasParams ? SP$.s1 | 0 : 0, firstParameter);
  oneTypeAnnotation(funcReturnType(func));
  switch (funcBodyKind(func)) {
    case BODY_BLOCK: {
      oneSpan(funcBodySpan(func));
      break;
    }
    case BODY_EXPR:
      oneExpr(funcBodyExpr(func));
      break;
    default:
      fd.one(false, 0, 0);
      break;
  }
}

function firstSpanStart(kind: number, start: number): number {
  elemSpan(kind, listAt(start, 0));
  return SP.s0 | 0;
}

/**
 * The function of a method, after its key. Babel, which Prettier parses JavaScript with, has no node for it: the parameters are
 * children of the method.
 */
function methodFunction(func: number): void {
  let first = -1;
  if (funcParamsLen(func) > 0 && fileIsJavascript()) first = firstSpanStart(LK_PARAM, funcParamsStart(func));
  funcEstreeSpan(func);
  const SP$ = SP;
  finder.transparent(true, SP$.s0 | 0, SP$.s1 | 0, first);
}

function memberFields(member: number): void {
  decorators(memberModifiersStart(member), memberModifiersLen(member));
  const kw = memberConstructorKeyword(member);
  const SP$ = SP;
  if (kw >= 0) {
    identSpan(kw, memberNamePos(member));
    finder.one(true, SP$.s0 | 0, SP$.s1 | 0);
  } else {
    key(nodeOfMember(member));
  }
  const func = memberFunc(member);
  if (func >= 0) {
    // The `Function` of a method of a class is one child.
    const an = funcAsAstNodesTag(func);
    if (an === AN_FUNCTION) methodFunction(func);
    else functionFields(func);
  } else {
    oneTypeAnnotation(memberTy(member));
    oneExpr(memberInit(member));
  }
}

function funcAsAstNodesTag(func: number): number {
  return anTag(funcAsAstNodes(func));
}


/**
 * Where the next sibling of the child of `parent` at `(start, end)` starts, or 0 if there is none. The child can be a name or
 * something else that there is no `AstNodes` for.
 */
export function followingSpanStartIn(start: number, end: number, parent: number, flavor: number): number {
  let s = start;
  let e = end;
  let p = parent;
  const SP$ = SP;
  while (true) {
    const following = followingSpanStartAmongSiblings(s, e, p, flavor);
    if (following >= 0) return following;
    anSpan(p);
    s = SP$.s0 | 0;
    e = SP$.s1 | 0;
    p = anParent(p);
  }
}

/** -1: the child is the last one, and what follows `parent` follows it. */
function followingSpanStartAmongSiblings(start: number, end: number, parent: number, flavor: number): number {
  const fd = finder;
  fd.begin(start, end, flavor === FLAVOR_OXFMT);
  // Whether what follows the parent follows its last child.
  let inherits = true;
  const id = anId(parent);

  const SP$ = SP;
  switch (anTag(parent)) {
    case AN_PROGRAM:
      inherits = false;
      list(LK_STMT, fileBodyStart(), fileBodyLen(), false);
      break;
    case AN_ARRAY_EXPRESSION:
    case AN_ARRAY_ASSIGNMENT_TARGET: {
      const isTarget = anTag(parent) === AN_ARRAY_ASSIGNMENT_TARGET;
      inherits = !isTarget;
      if (exprTag(id) === EXPR_ARRAY) listOf(LK_ARRAY_ELEM, exprArrayElemsStart(id), exprArrayElemsLen(id), isTarget);
      break;
    }
    case AN_OBJECT_EXPRESSION:
    case AN_OBJECT_ASSIGNMENT_TARGET: {
      const isTarget = anTag(parent) === AN_OBJECT_ASSIGNMENT_TARGET;
      inherits = !isTarget;
      if (exprTag(id) === EXPR_OBJECT) list(LK_PROP, exprObjectPropsStart(id), exprObjectPropsLen(id), isTarget);
      break;
    }
    case AN_OBJECT_PROPERTY:
    case AN_ASSIGNMENT_TARGET_PROPERTY_IDENTIFIER:
    case AN_ASSIGNMENT_TARGET_PROPERTY_PROPERTY:
    case AN_JSX_ATTRIBUTE: {
      key(nodeOfProp(id));
      const func = propFunc(id);
      if (func >= 0) methodFunction(func);
      else {
        const v = propValue(id);
        if (v >= 0) {
          if (!exprJsxContainerSpan(v)) exprSpan(v);
          fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
        } else fd.one(false, 0, 0);
      }
      break;
    }
    case AN_TEMPLATE_LITERAL:
      if (exprTag(id) === EXPR_TEMPLATE) list(LK_EXPR, exprTemplateExprsStart(id), exprTemplateExprsLen(id), false);
      break;
    case AN_TAGGED_TEMPLATE_EXPRESSION:
    case AN_CALL_EXPRESSION:
    case AN_NEW_EXPRESSION: {
      const call = exprAsCallLike(id);
      if (call >= 0) {
        oneExpr(callCallee(call));
        oneSpan(typeListAngleBrackets(callTypeArgsStart(call), callTypeArgsLen(call)));
        const template = callTemplate(call);
        oneExpr(template);
        if (template < 0) list(LK_EXPR, callArgsStart(call), callArgsLen(call), false);
      }
      break;
    }
    case AN_IMPORT_EXPRESSION:
      if (exprTag(id) === EXPR_IMPORT_CALL) list(LK_EXPR, exprImportCallArgsStart(id), exprImportCallArgsLen(id), true);
      break;
    case AN_STATIC_MEMBER_EXPRESSION:
    case AN_PRIVATE_FIELD_EXPRESSION:
    case AN_COMPUTED_MEMBER_EXPRESSION:
      if (exprTag(id) === EXPR_DOT) {
        oneExpr(exprDotObj(id));
        oneIdent(exprDotName(id), exprDotNamePos(id));
      } else if (exprTag(id) === EXPR_INDEX) {
        oneExpr(exprIndexObj(id));
        oneExpr(exprIndexIndex(id));
      }
      break;
    case AN_BINARY_EXPRESSION:
    case AN_LOGICAL_EXPRESSION:
    case AN_PRIVATE_IN_EXPRESSION:
      if (exprTag(id) === EXPR_BINARY) {
        oneExpr(exprBinaryLeft(id));
        oneExpr(exprBinaryRight(id));
      }
      break;
    case AN_SEQUENCE_EXPRESSION: {
      const out = sequenceScratch;
      const base = out.len;
      exprSequence(id, out);
      fd.spansBegin();
      for (let i = base; i < out.len; i++) {
        exprSpan(out.data[i] | 0);
        fd.spansItem(SP$.s0 | 0, SP$.s1 | 0);
      }
      out.len = base;
      fd.spansEnd(false);
      break;
    }
    case AN_ASSIGNMENT_EXPRESSION:
    case AN_ASSIGNMENT_TARGET_WITH_DEFAULT:
      if (exprTag(id) === EXPR_ASSIGN) {
        oneExpr(exprAssignTarget(id));
        oneExpr(exprAssignValue(id));
      }
      break;
    case AN_CONDITIONAL_EXPRESSION:
      if (exprTag(id) === EXPR_COND) {
        oneExpr(exprCondTest(id));
        oneExpr(exprCondYes(id));
        oneExpr(exprCondNo(id));
      }
      break;
    case AN_TS_AS_EXPRESSION:
    case AN_TS_SATISFIES_EXPRESSION:
    case AN_TYPE_CAST_EXPRESSION: {
      const t = exprTag(id);
      if (t === EXPR_AS || t === EXPR_SATISFIES) {
        oneExpr(t === EXPR_AS ? exprAsExpr(id) : exprSatisfiesExpr(id));
        const ty = t === EXPR_AS ? exprAsTy(id) : exprSatisfiesTy(id);
        // Flow's `(a: T)`: Prettier's `TypeAnnotation` starts at the `:`.
        if (anTag(parent) === AN_TYPE_CAST_EXPRESSION) oneTypeAnnotation(ty);
        else oneType(ty);
      } else if (t === EXPR_AS_CONST) {
        oneExpr(exprAsConstExpr(id));
        oneSpan(exprConstKeywordSpan(id));
      }
      break;
    }
    case AN_TS_TYPE_ASSERTION: {
      const t = exprTag(id);
      if (t === EXPR_AS) {
        oneType(exprAsTy(id));
        oneExpr(exprAsExpr(id));
      } else if (t === EXPR_AS_CONST) {
        oneSpan(exprConstKeywordSpan(id));
        oneExpr(exprAsConstExpr(id));
      }
      break;
    }
    case AN_TS_INSTANTIATION_EXPRESSION:
      if (exprTag(id) === EXPR_INSTANTIATION) {
        oneExpr(exprInstantiationExpr(id));
        oneSpan(typeListAngleBrackets(exprInstantiationTypeArgsStart(id), exprInstantiationTypeArgsLen(id)));
      }
      break;
    case AN_JSX_ELEMENT:
    case AN_JSX_FRAGMENT:
      if (exprTag(id) === EXPR_JSX) {
        jsxOpeningSpan(id);
        fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
        listOf(LK_JSX_CHILD, jsxChildrenStart(id), jsxChildrenLen(id), false);
        oneSpan(jsxClosingSpan(id));
      }
      break;
    case AN_JSX_OPENING_ELEMENT:
      if (exprTag(id) === EXPR_JSX) {
        // The `a` of `<a.b>` is followed by `b`.
        let name = jsxTag(id);
        while (name >= 0 && exprTag(name) === EXPR_DOT) {
          const obj = exprDotObj(name);
          exprSpan(obj);
          if ((SP$.s0 | 0) === start && (SP$.s1 | 0) === end) {
            identSpan(exprDotName(name), exprDotNamePos(name));
            return SP$.s0 | 0;
          }
          name = obj;
        }
        oneExpr(jsxTag(id));
        oneSpan(typeListAngleBrackets(jsxTypeArgsStart(id), jsxTypeArgsLen(id)));
        list(LK_PROP, jsxAttrsStart(id), jsxAttrsLen(id), false);
      }
      break;

    case AN_FUNCTION:
    case AN_ARROW_FUNCTION_EXPRESSION:
      oneIdent(funcName(id), funcNamePos(id));
      functionFields(id);
      break;
    case AN_FUNCTION_BODY:
      if (funcBodyKind(id) === BODY_BLOCK) list(LK_STMT, funcBodyStmtsStart(id), funcBodyStmtsLen(id), false);
      break;
    case AN_FORMAL_PARAMETERS:
      inherits = false;
      list(LK_PARAM, funcParamsStart(id), funcParamsLen(id), true);
      break;
    case AN_FORMAL_PARAMETER:
    case AN_FORMAL_PARAMETER_REST:
    case AN_TS_THIS_PARAMETER: {
      decorators(paramModifiersStart(id), paramModifiersLen(id));
      patSpan(paramPat(id));
      fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
      oneTypeAnnotation(paramTy(id));
      oneExpr(paramDefault(id));
      break;
    }
    case AN_CLASS: {
      decorators(classModifiersStart(id), classModifiersLen(id));
      oneIdent(className(id), classNamePos(id));
      oneSpan(typeParamListAngleBrackets(classTypeParamsStart(id), classTypeParamsLen(id)));
      oneExpr(classExtends(id));
      oneSpan(typeListAngleBrackets(classExtendsArgsStart(id), classExtendsArgsLen(id)));
      list(LK_TYPE, classImplementsStart(id), classImplementsLen(id), false);
      classBodySpan(id);
      fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
      break;
    }
    case AN_CLASS_BODY:
      list(LK_MEMBER, classMembersStart(id), classMembersLen(id), false);
      break;
    case AN_METHOD_DEFINITION:
    case AN_PROPERTY_DEFINITION:
    case AN_ACCESSOR_PROPERTY:
    case AN_TS_INDEX_SIGNATURE:
    case AN_TS_PROPERTY_SIGNATURE:
    case AN_TS_METHOD_SIGNATURE:
    case AN_TS_CALL_SIGNATURE_DECLARATION:
    case AN_TS_CONSTRUCT_SIGNATURE_DECLARATION:
      memberFields(id);
      break;
    case AN_STATIC_BLOCK: {
      const func = memberFunc(id);
      if (func >= 0 && funcBodyKind(func) === BODY_BLOCK) list(LK_STMT, funcBodyStmtsStart(func), funcBodyStmtsLen(func), false);
      break;
    }

    case AN_VARIABLE_DECLARATOR:
    case AN_CATCH_PARAMETER:
      patSpan(varDeclPat(id));
      fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
      oneTypeAnnotation(varDeclTy(id));
      oneExpr(varDeclInit(id));
      break;
    case AN_OBJECT_PATTERN:
    case AN_ARRAY_PATTERN:
      inherits = false;
      switch (patTag(id)) {
        case PAT_OBJECT:
          list(LK_PAT_PROP, patObjectPropsStart(id), patObjectPropsLen(id), true);
          break;
        case PAT_ARRAY:
          listOf(LK_PAT_ELEM, patArrayElemsStart(id), patArrayElemsLen(id), true);
          break;
        default:
          break;
      }
      break;
    case AN_BINDING_PROPERTY: {
      key(nodeOfPatProp(id));
      const def = patPropDefault(id);
      patSpan(patPropValue(id));
      if (def >= 0) {
        const s = SP$.s0 | 0;
        exprSpan(def);
        fd.one(true, s, SP$.s1 | 0);
      } else fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
      break;
    }
    case AN_ASSIGNMENT_PATTERN_PROP: {
      patSpan(patPropValue(id));
      fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
      oneExpr(patPropDefault(id));
      break;
    }
    case AN_ASSIGNMENT_PATTERN_ELEM: {
      const pat = patElemPat(id);
      if (pat >= 0) {
        patSpan(pat);
        fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
      } else fd.one(false, 0, 0);
      oneExpr(patElemDefault(id));
      break;
    }

    case AN_SWITCH_CASE:
      oneExpr(caseTest(id));
      list(LK_STMT, caseBodyStart(id), caseBodyLen(id), false);
      break;
    case AN_CATCH_CLAUSE:
      if (stmtTag(id) === STMT_TRY) {
        const param = stmtTryParam(id);
        if (param >= 0) {
          varDeclSpan(param);
          fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
        } else fd.one(false, 0, 0);
        oneStmt(stmtTryHandler(id));
      }
      break;
    case AN_TS_MODULE_BLOCK:
      if (stmtTag(id) === STMT_MODULE) {
        const m = stmtModuleModule(id);
        list(LK_STMT, moduleBodyStart(m), moduleBodyLen(m), false);
      }
      break;
    case AN_TS_INTERFACE_BODY:
      if (stmtTag(id) === STMT_INTERFACE) {
        const i = stmtInterfaceInterface(id);
        list(LK_MEMBER, interfaceMembersStart(i), interfaceMembersLen(i), false);
      }
      break;
    case AN_TS_ENUM_BODY:
      if (stmtTag(id) === STMT_ENUM) {
        const en = stmtEnumEnum(id);
        list(LK_ENUM_MEMBER, enumMembersStart(en), enumMembersLen(en), false);
      }
      break;
    case AN_TS_ENUM_MEMBER:
      key(nodeOfEnumMember(id));
      oneExpr(enumMemberInit(id));
      break;
    case AN_IMPORT_SPECIFIER:
      oneIdent(importSpecImported(id), importSpecImportedPos(id));
      oneIdent(importSpecLocal(id), importSpecLocalPos(id));
      break;
    case AN_EXPORT_SPECIFIER:
      oneIdent(exportSpecLocal(id), exportSpecLocalPos(id));
      oneIdent(exportSpecExported(id), exportSpecExportedPos(id));
      break;

    case AN_ARROW_BODY_EXPRESSION_STATEMENT:
      break;
    case AN_EXPRESSION_STATEMENT:
    case AN_DIRECTIVE:
      inherits = false;
      break;
    case AN_EXPORT_NAMED_DECLARATION:
    case AN_EXPORT_DEFAULT_DECLARATION:
      inherits = false;
      if (stmtTag(id) === STMT_EXPORT_NAMED) {
        const x = stmtExportNamedExport(id);
        list(LK_EXPORT_SPEC, exportItemsStart(x), exportItemsLen(x), false);
        oneSpan(exportSpecSpanOf(x));
      }
      break;
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
      inherits = false;
      statementFields(id);
      break;

    case AN_TS_CONDITIONAL_TYPE:
      if (typeTag(id) === TYPE_COND) {
        oneType(typeCondCheck(id));
        oneType(typeCondExtends(id));
        oneType(typeCondYes(id));
        oneType(typeCondNo(id));
      }
      break;
    case AN_TS_UNION_TYPE:
    case AN_TS_INTERSECTION_TYPE:
    case AN_TS_TEMPLATE_LITERAL_TYPE:
      switch (typeTag(id)) {
        case TYPE_UNION:
          list(LK_TYPE, typeUnionTypesStart(id), typeUnionTypesLen(id), false);
          break;
        case TYPE_INTERSECTION:
          list(LK_TYPE, typeIntersectionTypesStart(id), typeIntersectionTypesLen(id), false);
          break;
        case TYPE_TEMPLATE:
          list(LK_TYPE, typeTemplateTypesStart(id), typeTemplateTypesLen(id), false);
          break;
        default:
          break;
      }
      break;
    case AN_TS_TUPLE_TYPE:
      if (typeTag(id) === TYPE_TUPLE) list(LK_TUPLE_ELEM, typeTupleElemsStart(id), typeTupleElemsLen(id), false);
      break;
    case AN_TS_NAMED_TUPLE_MEMBER:
      oneIdent(tupleElemName(id), tupleElemNamePos(id));
      oneType(tupleElemTy(id));
      break;
    case AN_TS_INDEXED_ACCESS_TYPE:
      if (typeTag(id) === TYPE_INDEXED_ACCESS) {
        oneType(typeIndexedAccessObj(id));
        oneType(typeIndexedAccessIndex(id));
      }
      break;
    case AN_TS_TYPE_REFERENCE:
    case AN_TS_CLASS_IMPLEMENTS:
    case AN_TS_INTERFACE_HERITAGE:
    case AN_TS_TYPE_QUERY:
    case AN_TS_IMPORT_TYPE: {
      switch (typeTag(id)) {
        case TYPE_REF:
          entitySpan(typeRefNameStart(id), typeRefNameLen(id));
          fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
          break;
        case TYPE_HERITAGE:
          oneExpr(typeHeritageExpr(id));
          break;
        case TYPE_TYPEOF:
          oneExpr(typeTypeofExpr(id));
          break;
        case TYPE_IMPORT:
          oneSpan(typeImportSourceSpan(id));
          break;
        default:
          fd.one(false, 0, 0);
          break;
      }
      if (typeArgumentsOf(nodeOfType(id))) oneSpan(typeListAngleBrackets(TL[0] | 0, TL[1] | 0));
      else fd.one(false, 0, 0);
      break;
    }
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_EXPR:
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_TYPE:
    case AN_TS_TYPE_PARAMETER_INSTANTIATION_CLASS:
      if (typeArgumentsOf(anTypeParametersOwner(parent))) list(LK_TYPE, TL[0] | 0, TL[1] | 0, false);
      break;
    case AN_TS_TYPE_PARAMETER_DECLARATION_FUNC:
    case AN_TS_TYPE_PARAMETER_DECLARATION_CLASS:
    case AN_TS_TYPE_PARAMETER_DECLARATION_STMT:
    case AN_TS_TYPE_PARAMETER_DECLARATION_TYPE:
      if (typeParametersOf(anTypeParametersOwner(parent))) list(LK_TYPE_PARAM, TL[0] | 0, TL[1] | 0, false);
      break;
    case AN_TS_TYPE_PARAMETER: {
      // Flow's `<T: U>`: as above.
      let isAnnotation = false;
      if (fileIsFlow()) {
        typeParamFlowTokenAfterName(id);
        isAnnotation = spTokenIs(":");
      }
      oneIdent(typeParamName(id), typeParamNamePos(id));
      const c = typeParamConstraint(id);
      if (c >= 0) {
        if (isAnnotation) oneTypeAnnotation(c);
        else oneType(c);
      } else fd.one(false, 0, 0);
      oneType(typeParamDefault(id));
      break;
    }
    case AN_TS_TYPE_LITERAL:
      if (typeTag(id) === TYPE_OBJECT) list(LK_MEMBER, typeObjectMembersStart(id), typeObjectMembersLen(id), false);
      break;
    case AN_TS_FUNCTION_TYPE:
    case AN_TS_CONSTRUCTOR_TYPE:
      if (typeTag(id) === TYPE_FN) functionFields(typeFnFn(id));
      break;
    case AN_TS_MAPPED_TYPE:
      if (typeTag(id) === TYPE_MAPPED) {
        const m = typeMappedMapped(id);
        const param = mappedParam(m);
        oneIdent(typeParamName(param), typeParamNamePos(param));
        oneType(typeParamConstraint(param));
        oneType(mappedNameTy(m));
        oneType(mappedTy(m));
      }
      break;
    case AN_TS_TYPE_PREDICATE:
      if (typeTag(id) === TYPE_PREDICATE) {
        oneIdent(typePredicateParamAtom(id), typePredicateParamPos(id));
        oneTypeAnnotation(typePredicateTy(id));
      }
      break;
    // One child, or none.
    default:
      break;
  }

  if (fd.following < 0 && !inherits) return 0;
  return fd.following;
}

const sequenceScratch = new I32Vec(16);

/** The fields of a statement. */
function statementFields(s: number): void {
  const fd = finder;
  // What is in the head of a `for`: the declaration, or the expression.
  const SP$ = SP;
  switch (stmtTag(s)) {
    case STMT_BLOCK:
      if (stmtIsWith(s)) {
        oneExpr(stmtWithObject(s));
        oneStmt(stmtWithBody(s));
      } else list(LK_STMT, stmtBlockStmtsStart(s), stmtBlockStmtsLen(s), false);
      break;
    case STMT_VAR:
      list(LK_VAR_DECL, stmtVarDeclsStart(s), stmtVarDeclsLen(s), false);
      break;
    case STMT_IF:
      oneExpr(stmtIfTest(s));
      oneStmt(stmtIfYes(s));
      oneStmt(stmtIfNo(s));
      break;
    case STMT_FOR:
      oneHead(stmtForInit(s));
      oneExpr(stmtForTest(s));
      oneExpr(stmtForUpdate(s));
      oneStmt(stmtForBody(s));
      break;
    case STMT_FOR_IN:
      oneHead(stmtForInLeft(s));
      oneExpr(stmtForInExpr(s));
      oneStmt(stmtForInBody(s));
      break;
    case STMT_FOR_OF:
      oneHead(stmtForOfLeft(s));
      oneExpr(stmtForOfExpr(s));
      oneStmt(stmtForOfBody(s));
      break;
    case STMT_WHILE:
      oneExpr(stmtWhileTest(s));
      oneStmt(stmtWhileBody(s));
      break;
    case STMT_DO_WHILE:
      oneStmt(stmtDoWhileBody(s));
      oneExpr(stmtDoWhileTest(s));
      break;
    case STMT_SWITCH:
      oneExpr(stmtSwitchExpr(s));
      list(LK_CASE, stmtSwitchCasesStart(s), stmtSwitchCasesLen(s), false);
      break;
    case STMT_TRY:
      oneStmt(stmtTryBlock(s));
      oneSpan(stmtCatchClauseSpan(s));
      oneStmt(stmtTryFinalizer(s));
      break;
    case STMT_LABELED: {
      const label = stmtLabel(s);
      oneIdent(label, stmtLabelPos(s));
      oneStmt(stmtLabeledBody(s));
      break;
    }
    case STMT_IMPORT: {
      const imp = stmtImportImport(s);
      oneIdent(importDefault(imp), importDefaultPos(imp));
      oneSpan(importNamespaceSpan(imp));
      list(LK_IMPORT_SPEC, importNamedStart(imp), importNamedLen(imp), false);
      oneSpan(importSpecSpanOf(imp));
      break;
    }
    case STMT_INTERFACE: {
      const i = stmtInterfaceInterface(s);
      oneIdent(interfaceName(i), interfaceNamePos(i));
      oneSpan(typeParamListAngleBrackets(interfaceTypeParamsStart(i), interfaceTypeParamsLen(i)));
      list(LK_TYPE, interfaceExtendsStart(i), interfaceExtendsLen(i), false);
      interfaceBodySpan(i);
      fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
      break;
    }
    case STMT_TYPE_ALIAS: {
      const a = stmtTypeAliasAlias(s);
      oneIdent(aliasName(a), aliasNamePos(a));
      oneSpan(typeParamListAngleBrackets(aliasTypeParamsStart(a), aliasTypeParamsLen(a)));
      oneType(aliasTy(a));
      break;
    }
    case STMT_ENUM: {
      const en = stmtEnumEnum(s);
      oneIdent(enumName(en), enumNamePos(en));
      enumBodySpan(en);
      fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
      break;
    }
    case STMT_MODULE: {
      const m = stmtModuleModule(s);
      if (moduleNameKind(m) !== MODNAME_GLOBAL) oneIdent(moduleName(m), moduleNamePos(m));
      else fd.one(false, 0, 0);
      oneSpan(moduleBodySpan(moduleInnermost(m)));
      break;
    }
    case STMT_IMPORT_EQUALS: {
      const imp = stmtImportEqualsImportEquals(s);
      oneIdent(importEqualsName(imp), importEqualsNamePos(imp));
      if (importEqualsTargetKind(imp) === IET_REQUIRE) oneSpan(importEqualsRequireSpan(imp));
      else {
        entitySpan(importEqualsEntityStart(imp), importEqualsEntityLen(imp));
        fd.one(true, SP$.s0 | 0, SP$.s1 | 0);
      }
      break;
    }
    default:
      break;
  }
}

/** The head of a `for`: a declaration is its statement, an expression is the expression that its wrapper has. */
function oneHead(s: number): void {
  if (s < 0) {
    finder.one(false, 0, 0);
    return;
  }
  if (stmtTag(s) === STMT_EXPR) oneExpr(stmtExprExpr(s));
  else oneStmt(s);
}
