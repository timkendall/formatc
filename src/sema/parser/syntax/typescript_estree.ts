// Port of vendor/bun/src/lint/linter/syntax/typescript_estree.rs: the errors of typescript-estree: `checkSyntaxError`, `checkModifiers`, and
// what `Converter` throws itself.
//
// TypeScript's parser accepts `interface I { private a }` and leaves the error to the type checker. typescript-estree has no type checker
// to leave it to, and repeats a part of those checks as it converts a node.
//
// No tree is walked here. Each check goes through the table of the HIR that has the nodes it is about, and tests what is cheapest first.
// Where the HIR has dropped what is wrong, the parser has left a diagnostic, which is translated.
//
// It throws at the first node that fails, in the order in which it converts, which is not the order of the source: see `order.ts`.
// The result is in `check` (error.ts); `firstError` returns whether there is one.
import {
  BIN_IN,
  CHAIN_NO,
  DK_GRAMMAR,
  DK_JS,
  DK_PARSE,
  EXPR_ARRAY,
  EXPR_AS,
  EXPR_AS_CONST,
  EXPR_ASSIGN,
  EXPR_BINARY,
  EXPR_CALL,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_IMPORT_CALL,
  EXPR_INDEX,
  EXPR_INSTANTIATION,
  EXPR_MISSING,
  EXPR_NON_NULL,
  EXPR_OBJECT,
  EXPR_PRIVATE_IDENTIFIER,
  EXPR_SATISFIES,
  EXPR_TAGGED_TEMPLATE,
  EXPR_UNARY,
  FLAG_ABSTRACT,
  FLAG_ACCESSOR,
  FLAG_AMBIENT,
  FLAG_ASYNC,
  FLAG_COMPUTED_NAME,
  FLAG_CONST,
  FLAG_DEFAULT,
  FLAG_DEFINITE,
  FLAG_EXPORT,
  FLAG_GENERATOR,
  FLAG_IN,
  FLAG_MISSING_BODY,
  FLAG_OUT,
  FLAG_OVERRIDE,
  FLAG_PRIVATE,
  FLAG_PROTECTED,
  FLAG_PUBLIC,
  FLAG_READONLY,
  FLAG_REPARSED,
  FLAG_REST,
  FLAG_STATIC,
  FLAG_STRING_NAME,
  FLAG_TYPE_ONLY,
  FN_ARROW,
  FN_CONSTRUCTOR,
  FN_GETTER,
  FN_INDEX_SIGNATURE,
  FN_METHOD,
  FN_SETTER,
  FN_STATIC_BLOCK,
  BODY_NONE,
  IET_ENTITY,
  MEMBER_CALL_SIGNATURE,
  MEMBER_CONSTRUCT_SIGNATURE,
  MEMBER_CONSTRUCTOR,
  MEMBER_GETTER,
  MEMBER_INDEX_SIGNATURE,
  MEMBER_METHOD,
  MEMBER_PROPERTY,
  MEMBER_SETTER,
  MEMBER_STATIC_BLOCK,
  MODK_DECORATOR,
  MODK_KEYWORD,
  NK_COMPUTED_NUMBER,
  NK_COMPUTED_STRING,
  NK_NUMERIC_LITERAL,
  NONE,
  PAT_ARRAY,
  PAT_IDENT,
  PAT_OBJECT,
  PROP_GETTER,
  PROP_INIT,
  PROP_METHOD,
  PROP_SETTER,
  PROP_SHORTHAND,
  STMT_CLASS,
  STMT_EXPR,
  STMT_FN,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IMPORT_EQUALS,
  STMT_INTERFACE,
  STMT_SWITCH,
  STMT_THROW,
  STMT_TRY,
  STMT_TYPE_ALIAS,
  STMT_VAR,
  TYPE_HERITAGE,
  TYPE_MAPPED,
  UN_POST_DEC,
  UN_POST_INC,
  UN_PRE_DEC,
  UN_PRE_INC,
  VAR_AWAIT_USING,
  VAR_CONST,
  VAR_LET,
  VAR_USING,
  VAR_VAR,
  hir,
} from "../../hir.ts";
import { endOfExpr, isParenthesized as exprHasParens, modifierText } from "../../hir_util.ts";
import { A_this } from "../../atom.ts";
import { skipTrivia } from "../../check/spans.ts";
import { tokenLen } from "../../../lint/tokens/mod.ts";
import { SP } from "../../../lint/span.ts";
import {
  CO_NONE,
  CO_STMT,
  MO_CLASS,
  MO_NONE,
  FO_MEMBER,
  FO_NONE,
  P_FILE,
  P_MODULE,
  P_NONE,
  P_STMT,
  bound,
} from "../../bind/parents.ts";
import {
  classSpan,
  exprIsAssignmentTarget,
  exprOuterSpan,
  fileEndOfTokenBefore,
  fileIsParenthesized,
  exprImportCallPhase,
  exprParent,
  interfaceBodySpan,
  isImportAttributesObject,
  keyIs,
  keySpan,
  nodeOfMember,
  paramSpan,
  propSpan,
  stmtCatchClauseSpan,
  stmtSpan,
  typeParamParent,
  nodeKind,
  nodeId,
  N_CLASS,
  N_EXPR,
  N_STMT,
} from "../../../lint/ast/index.ts";
import {
  WHEN_CATCH_CLAUSE,
  WHEN_FIRST,
  WHEN_TYPE_ARGUMENTS,
  WHEN_TYPE_PARAMETERS,
  orderFirst,
  pushCandidate,
  resetCandidates,
} from "./order.ts";
import { setCheck } from "./error.ts";
import { EXPR_FN } from "../../hir.ts";

// `Kind`: `ts.SyntaxKind` of a node with modifiers, as far as `checkModifiers` tells them apart.
const K_FUNCTION_DECLARATION = 0;
const K_CLASS_DECLARATION = 1;
const K_CLASS_EXPRESSION = 2;
const K_PROPERTY_DECLARATION = 3;
const K_PROPERTY_SIGNATURE = 4;
const K_METHOD_DECLARATION = 5;
const K_METHOD_SIGNATURE = 6;
const K_ACCESSOR = 7;
const K_INDEX_SIGNATURE = 8;
const K_TYPE_PARAMETER = 9;
const K_PARAMETER = 10;
const K_PROPERTY_ASSIGNMENT = 11;
const K_OTHER = 12;

// `Place`: `node.parent`, likewise.
const PL_CLASS = 0;
const PL_INTERFACE_OR_TYPE_ALIAS = 1;
const PL_MODULE_OR_FILE = 2;
const PL_OBJECT_LITERAL = 3;
const PL_OTHER = 4;

// `Decorated`: `nodeCanBeDecorated`
const D_VALIDLY = 0;
const D_OVERLOAD = 1;
const D_INVALIDLY = 2;

const ACCESSIBILITY = FLAG_PUBLIC | FLAG_PRIVATE | FLAG_PROTECTED;

const NO_SOURCE = "'source' is not a valid meta-property for keyword 'import'.";

// The errors that fail, and for each its error. (The order among them is decided by `order.ts`.)
let errAt: number[] = [];
let errMessage: string[] = [];
let isOfPrettier = false;

function text(): Uint8Array {
  return hir.text;
}

function byte(at: number): number {
  const hir$ = hir;
  return at >= 0 && at < (hir$.sourceLen | 0) ? hir$.text[at] | 0 : 0;
}

/** The token at `at`. */
function tokenAt(at: number): string {
  const hir$ = hir;
  const n = tokenLen(hir$.text, hir$.sourceLen | 0, at);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(hir$.text[(at + i) | 0] | 0);
  return s;
}

function sliceText(start: number, end: number): string {
  const hir$ = hir;
  return Buffer.from(hir$.text.buffer, hir$.text.byteOffset + start, end - start).toString("utf8");
}

/** Whether the token at `at` is a `StringLiteral`. */
function isStringLiteral(at: number): boolean {
  const c = byte(at);
  return c === 34 || c === 39;
}

/** `node.getStart()` of an expression, which can be a parenthesis. */
function startOf(e: number): number {
  exprOuterSpan(e);
  return SP.s0 | 0;
}

// ───────────────────────────── the errors ─────────────────────────────

/** `throw createError(at, message)` while the node `nodeStart..nodeEnd` is checked. */
function fail(nodeStart: number, nodeEnd: number, at: number, message: string): void {
  failAtStep(nodeStart, nodeEnd, 0, at, message);
}

/** The same for a check that comes after those of `fail`, in the order of `step`. */
function failAtStep(nodeStart: number, nodeEnd: number, step: number, at: number, message: string): void {
  failWhen(WHEN_FIRST, nodeStart, nodeEnd, step, at, message);
}

function failWhen(when: number, nodeStart: number, nodeEnd: number, step: number, at: number, message: string): void {
  pushCandidate(nodeStart, nodeEnd, when, step);
  errAt.push(at);
  errMessage.push(message);
}

/** `<>` at `at`. */
function failForEmptyList(when: number, at: number): void {
  const message = when === WHEN_TYPE_PARAMETERS ? "Type parameter list cannot be empty." : "Type argument list cannot be empty.";
  failWhen(when, at, at, 0, at, message);
}

function hasKeyword(modStart: number, modLen: number, keyword: number): boolean {
  const hir$ = hir;
  for (let i = 0; i < modLen; i++) {
    const m = hir$.ids[(modStart + i) | 0] | 0;
    if ((hir$.modifierKind[m] | 0) === MODK_KEYWORD && (hir$.modifierValue[m] | 0) === keyword) return true;
  }
  return false;
}

function varKindText(kind: number): string {
  switch (kind) {
    case VAR_VAR:
      return "var";
    case VAR_LET:
      return "let";
    case VAR_CONST:
      return "const";
    case VAR_USING:
      return "using";
    default:
      return "await using";
  }
}

function on(text_: string, modifier: number): string {
  return "'" + modifierText(modifier) + "' modifier " + text_;
}

// ───────────────────────────── modifiers ─────────────────────────────

/**
 * `checkModifiers`. `decorated`: `nodeCanBeDecorated(node)`, asked if there is a decorator. `otherFlags`/`otherMessage`: what is wrong with
 * the node if it has one of these modifiers (0: nothing).
 */
function checkModifiers(
  kind: number,
  place: number,
  nodeStart: number,
  nodeEnd: number,
  modStart: number,
  modLen: number,
  decorated: number,
  otherFlags: number,
  otherMessage: string,
): void {
  const hir$ = hir;
  if (kind === K_PROPERTY_ASSIGNMENT) {
    for (let i = 0; i < modLen; i++) {
      const m = hir$.ids[(modStart + i) | 0] | 0;
      if ((hir$.modifierKind[m] | 0) === MODK_KEYWORD) {
        fail(nodeStart, nodeEnd, hir$.modifierPos[m] | 0, on("cannot be used here.", hir$.modifierValue[m] | 0));
        return;
      }
    }
    return;
  }
  for (let i = 0; i < modLen; i++) {
    const m = hir$.ids[(modStart + i) | 0] | 0;
    if ((hir$.modifierKind[m] | 0) === MODK_DECORATOR) {
      let message = "";
      if (decorated === D_OVERLOAD) message = "A decorator can only decorate a method implementation, not an overload.";
      else if (decorated === D_INVALIDLY) message = "Decorators are not valid here.";
      if (message !== "") {
        fail(nodeStart, nodeEnd, hir$.modifierPos[m] | 0, message);
        return;
      }
      break;
    }
  }
  for (let i = 0; i < modLen; i++) {
    const m = hir$.ids[(modStart + i) | 0] | 0;
    if ((hir$.modifierKind[m] | 0) !== MODK_KEYWORD) continue;
    const modifier = hir$.modifierValue[m] | 0;
    const pos_ = hir$.modifierPos[m] | 0;
    const isAny = (flags: number): boolean => (flags & modifier) !== 0;
    let message: string;
    if (modifier !== FLAG_READONLY && (kind === K_PROPERTY_SIGNATURE || kind === K_METHOD_SIGNATURE)) {
      message = on("cannot appear on a type member", modifier);
    } else if (modifier !== FLAG_READONLY && kind === K_INDEX_SIGNATURE && (modifier !== FLAG_STATIC || place !== PL_CLASS)) {
      message = on("cannot appear on an index signature", modifier);
    } else if (kind === K_TYPE_PARAMETER && !isAny(FLAG_IN | FLAG_OUT | FLAG_CONST)) {
      message = on("cannot appear on a type parameter", modifier);
    } else if (isAny(FLAG_IN | FLAG_OUT) && (kind !== K_TYPE_PARAMETER || !(place === PL_CLASS || place === PL_INTERFACE_OR_TYPE_ALIAS))) {
      message = on("can only appear on a type parameter of a class, interface or type alias", modifier);
    } else if (
      modifier === FLAG_READONLY &&
      !(kind === K_PROPERTY_DECLARATION || kind === K_PROPERTY_SIGNATURE || kind === K_INDEX_SIGNATURE || kind === K_PARAMETER)
    ) {
      message = on("can only appear on a property declaration or index signature.", modifier);
    } else if (modifier === FLAG_AMBIENT && place === PL_CLASS && kind !== K_PROPERTY_DECLARATION) {
      message = on("cannot appear on class elements of this kind.", modifier);
    } else if (
      modifier === FLAG_ABSTRACT &&
      !(kind === K_CLASS_DECLARATION || kind === K_METHOD_DECLARATION || kind === K_PROPERTY_DECLARATION || kind === K_ACCESSOR)
    ) {
      message = on("can only appear on a class, method, or property declaration.", modifier);
    } else if (isAny(FLAG_STATIC | ACCESSIBILITY) && place === PL_MODULE_OR_FILE) {
      message = on("cannot appear on a module or namespace element.", modifier);
    } else if (modifier === FLAG_ACCESSOR && kind !== K_PROPERTY_DECLARATION) {
      message = on("can only appear on a property declaration.", modifier);
    } else if (modifier === FLAG_ASYNC && !(kind === K_METHOD_DECLARATION || kind === K_FUNCTION_DECLARATION)) {
      message = on("cannot be used here.", modifier);
    } else if (kind === K_PARAMETER && isAny(FLAG_STATIC | FLAG_EXPORT | FLAG_AMBIENT | FLAG_ASYNC)) {
      message = on("cannot appear on a parameter.", modifier);
    } else {
      let other = -1;
      if (isAny(ACCESSIBILITY)) {
        for (let k = 0; k < modLen; k++) {
          const o = hir$.ids[(modStart + k) | 0] | 0;
          if ((hir$.modifierKind[o] | 0) !== MODK_KEYWORD) continue;
          if ((hir$.modifierPos[o] | 0) !== pos_ && ((ACCESSIBILITY & (hir$.modifierValue[o] | 0)) !== 0)) {
            other = o;
            break;
          }
        }
      }
      if (other >= 0) {
        fail(nodeStart, nodeEnd, hir$.modifierPos[other] | 0, "Accessibility modifier already seen.");
        return;
      } else if (otherFlags !== 0 && isAny(otherFlags)) {
        message = otherMessage;
      } else if (place === PL_OBJECT_LITERAL && (modifier !== FLAG_ASYNC || kind !== K_METHOD_DECLARATION)) {
        message = on("cannot be used here.", modifier);
      } else {
        continue;
      }
    }
    fail(nodeStart, nodeEnd, pos_, message);
    return;
  }
}

function placeOfStatement(id: number): number {
  const t = bound.stmtParentTag[id] | 0;
  return t === P_FILE || t === P_MODULE ? PL_MODULE_OR_FILE : PL_OTHER;
}

// ───────────────────────────── statements ─────────────────────────────

/** The statement in whose head the list of declarations `statement` is: its tag (a `for`, a `for-in` or a `for-of`), else -1. */
export function loopWithHead(statement: number): number {
  const bound$ = bound;
  if ((bound$.stmtParentTag[statement] | 0) !== P_STMT) return -1;
  const parent = bound$.stmtParentA[statement] | 0;
  const hir$ = hir;
  if (parent < 0 || parent >= hir$.nStmts) return -1;
  const tag = hir$.stmtTag[parent] | 0;
  let head: number;
  if (tag === STMT_FOR) head = hir$.stmtA[parent] | 0;
  else if (tag === STMT_FOR_IN || tag === STMT_FOR_OF) head = hir$.stmtA[parent] | 0;
  else return -1;
  return head === statement ? tag : -1;
}

function statements(): void {
  const hir$ = hir;
  const n = hir$.nStmts | 0;
  const bound$ = bound;
  const SP$ = SP;
  for (let i = 0; i < n; i++) {
    const tag = hir$.stmtTag[i] | 0;
    const modStart = hir$.stmtModStart[i] | 0;
    const modLen = hir$.stmtModLen[i] | 0;
    const hasCheck =
      modLen > 0 ||
      tag === STMT_SWITCH ||
      tag === STMT_THROW ||
      tag === STMT_TRY ||
      tag === STMT_FN ||
      tag === STMT_FOR_IN ||
      tag === STMT_FOR_OF ||
      tag === STMT_IMPORT_EQUALS ||
      (tag === STMT_VAR && (hir$.stmtB[i] | 0) === 0);
    if (!hasCheck || (bound$.stmtParentTag[i] | 0) === P_NONE) continue;
    const nodeStart = hir$.stmtStart[i] | 0;
    const nodeEnd = hir$.stmtLocEnd[i] | 0;
    // Those of a class are checked with the class.
    if (modLen > 0 && tag !== STMT_CLASS) {
      const kind = tag === STMT_FN ? K_FUNCTION_DECLARATION : K_OTHER;
      let using_ = "";
      if (tag === STMT_VAR) {
        const first = hir$.stmtA[i] | 0;
        if ((hir$.stmtB[i] | 0) > 0) {
          const k = hir$.varDeclKind[hir$.ids[first] | 0] | 0;
          if (k === VAR_USING) using_ = "'declare' modifier cannot appear on a 'using' declaration.";
          else if (k === VAR_AWAIT_USING) using_ = "'declare' modifier cannot appear on a 'await using' declaration.";
        }
      }
      checkModifiers(kind, placeOfStatement(i), nodeStart, nodeEnd, modStart, modLen, D_INVALIDLY, using_ === "" ? 0 : FLAG_AMBIENT, using_);
    }
    switch (tag) {
      case STMT_SWITCH: {
        const cases = hir$.stmtB[i] | 0;
        const count = hir$.stmtC[i] | 0;
        let defaults = 0;
        for (let k = 0; k < count; k++) if ((hir$.caseTest[hir$.ids[(cases + k) | 0] | 0] | 0) < 0) defaults = (defaults + 1) | 0;
        if (defaults > 1) fail(nodeStart, nodeEnd, nodeStart, "A 'default' clause cannot appear more than once in a 'switch' statement.");
        break;
      }
      case STMT_THROW: {
        const thrown = hir$.stmtA[i] | 0;
        if (thrown < 0 || thrown >= hir$.nExprs || (hir$.exprPos[thrown] | 0) === (hir$.exprEnd[thrown] | 0)) {
          fail(nodeStart, nodeEnd, nodeStart, "A throw statement must throw an expression.");
        }
        break;
      }
      case STMT_TRY: {
        const param = hir$.stmtB[i] | 0;
        if (param >= 0 && param < hir$.nVarDecls) {
          const init = hir$.varDeclInit[param] | 0;
          if (init >= 0) {
            let cs = nodeStart;
            let ce = nodeEnd;
            if (stmtCatchClauseSpan(i)) {
              cs = SP$.s0 | 0;
              ce = SP$.s1 | 0;
            }
            failWhen(WHEN_CATCH_CLAUSE, cs, ce, 0, startOf(init), "Catch clause variable cannot have an initializer.");
          }
        }
        break;
      }
      case STMT_FN: {
        const f = hir$.stmtA[i] | 0;
        if (f < 0 || f >= hir$.nFns) break;
        const hasBody = (hir$.fnBodyKind[f] | 0) !== BODY_NONE;
        const isGenerator = ((hir$.fnFlags[f] | 0) & FLAG_GENERATOR) !== 0;
        let message: string;
        if (hasKeyword(modStart, modLen, FLAG_AMBIENT)) {
          if (hasBody) message = "An implementation cannot be declared in ambient contexts.";
          else if (hasKeyword(modStart, modLen, FLAG_ASYNC)) message = "'async' modifier cannot be used in an ambient context.";
          else if (isGenerator) message = "Generators are not allowed in an ambient context.";
          else break;
        } else if (!hasBody && isGenerator) {
          message = "A function signature cannot be declared as a generator.";
        } else break;
        fail(nodeStart, nodeEnd, nodeStart, message);
        break;
      }
      case STMT_VAR: {
        const listStart = hir$.stmtA[i] | 0;
        const listLen = hir$.stmtB[i] | 0;
        const isStatement = loopWithHead(i) < 0;
        if (listLen === 0 && isStatement) {
          fail(nodeStart, nodeEnd, nodeStart, "A variable declaration list must have at least one variable declarator.");
        }
        if (hasKeyword(modStart, modLen, FLAG_AMBIENT)) {
          for (let k = 0; k < listLen; k++) variableDeclaration(hir$.ids[(listStart + k) | 0] | 0);
        }
        break;
      }
      case STMT_FOR_IN:
        checkForStatementDeclaration(nodeStart, nodeEnd, hir$.stmtA[i] | 0, "for...in");
        break;
      case STMT_FOR_OF:
        checkForStatementDeclaration(nodeStart, nodeEnd, hir$.stmtA[i] | 0, "for...of");
        break;
      case STMT_IMPORT_EQUALS: {
        const ie = hir$.stmtA[i] | 0;
        if (ie >= 0 && ie < hir$.nImportEquals) {
          const isAlias = ((hir$.importEqualsFlags[ie] | 0) & FLAG_TYPE_ONLY) !== 0 && (hir$.importEqualsTargetKind[ie] | 0) === IET_ENTITY;
          if (isAlias) fail(nodeStart, nodeEnd, nodeStart, "An import alias cannot use 'import type'");
        }
        break;
      }
      default:
    }
  }
}

/** `checkForStatementDeclaration` */
function checkForStatementDeclaration(nodeStart: number, nodeEnd: number, left: number, name: string): void {
  const hir$ = hir;
  if (left < 0 || left >= hir$.nStmts) return;
  const tag = hir$.stmtTag[left] | 0;
  if (tag === STMT_VAR) {
    const listStart = hir$.stmtA[left] | 0;
    const listLen = hir$.stmtB[left] | 0;
    if (listLen !== 1) {
      fail(nodeStart, nodeEnd, hir$.stmtStart[left] | 0, "Only a single variable declaration is allowed in a '" + name + "' statement.");
      return;
    }
    const d = hir$.ids[listStart] | 0;
    const pat = hir$.varDeclPat[d] | 0;
    const start = pat >= 0 && pat < hir$.nPats ? hir$.patPos[pat] | 0 : hir$.stmtStart[left] | 0;
    if ((hir$.varDeclInit[d] | 0) >= 0) {
      fail(nodeStart, nodeEnd, start, "The variable declaration of a '" + name + "' statement cannot have an initializer.");
    } else if ((hir$.varDeclTy[d] | 0) >= 0) {
      fail(nodeStart, nodeEnd, start, "The variable declaration of a '" + name + "' statement cannot have a type annotation.");
    }
  } else if (tag === STMT_EXPR) {
    const target = hir$.stmtA[left] | 0;
    const t = target >= 0 && target < hir$.nExprs ? hir$.exprTag[target] | 0 : -1;
    const isPattern = (t === EXPR_OBJECT || t === EXPR_ARRAY) && !fileIsParenthesized(target);
    if (!isPattern && !isValidAssignmentTarget(target)) {
      fail(nodeStart, nodeEnd, startOf(target), "The left-hand side of a '" + name + "' statement must be a variable or a property access.");
    }
  }
}

/** `isValidAssignmentTarget` */
function isValidAssignmentTarget(id0: number): boolean {
  let id = id0;
  const hir$ = hir;
  for (;;) {
    if (id < 0 || id >= hir$.nExprs) return false;
    const t = hir$.exprTag[id] | 0;
    if (t === EXPR_IDENT) return true;
    if (t === EXPR_DOT || t === EXPR_INDEX) return (hir$.exprAux[id] | 0) === CHAIN_NO;
    if (t === EXPR_AS || t === EXPR_SATISFIES || t === EXPR_INSTANTIATION || t === EXPR_AS_CONST || t === EXPR_NON_NULL) {
      id = hir$.exprA[id] | 0;
      continue;
    }
    return false;
  }
}

// ───────────────────────────── declarations of variables ─────────────────────────────

function variableDeclarations(): void {
  const hir$ = hir;
  const n = hir$.nVarDecls | 0;
  for (let i = 0; i < n; i++) {
    const kind = hir$.varDeclKind[i] | 0;
    if (((hir$.varDeclFlags[i] | 0) & FLAG_DEFINITE) !== 0 || kind === VAR_USING || kind === VAR_AWAIT_USING) variableDeclaration(i);
  }
}

/** `VariableDeclaration` */
function variableDeclaration(id: number): void {
  const hir$ = hir;
  if (id < 0 || id >= hir$.nVarDecls) return;
  const list = bound.varStmt[id] | 0;
  const pat = hir$.varDeclPat[id] | 0;
  if (list < 0 || list >= hir$.nStmts || pat < 0 || pat >= hir$.nPats) return;
  const nodeStart = hir$.patPos[pat] | 0;
  const nodeEnd = hir$.varDeclLocEnd[id] | 0;
  const flags = hir$.varDeclFlags[id] | 0;
  const kindOfVar = hir$.varDeclKind[id] | 0;
  const init = hir$.varDeclInit[id] | 0;
  const isDefinite = (flags & FLAG_DEFINITE) !== 0;
  const isIdentifier = (hir$.patTag[pat] | 0) === PAT_IDENT;
  if (isDefinite && init >= 0) {
    fail(nodeStart, nodeEnd, nodeStart, "Declarations with initializers cannot also have definite assignment assertions.");
    return;
  }
  if (isDefinite && (!isIdentifier || (hir$.varDeclTy[id] | 0) < 0)) {
    fail(nodeStart, nodeEnd, nodeStart, "Declarations with definite assignment assertions must also have type annotations.");
    return;
  }
  // The parameter of a `catch` is not in a list.
  if ((hir$.stmtTag[list] | 0) !== STMT_VAR) return;
  const headOf = loopWithHead(list);
  const kind = varKindText(kindOfVar);
  const statementStart = hir$.stmtStart[list] | 0;
  if (kindOfVar === VAR_USING || kindOfVar === VAR_AWAIT_USING) {
    if (headOf === STMT_FOR_IN) {
      fail(nodeStart, nodeEnd, statementStart, "The left-hand side of a 'for...in' statement cannot be a '" + kind + "' declaration.");
      return;
    } else if (headOf === STMT_FOR_OF) {
      // nothing
    } else if (init < 0) {
      fail(nodeStart, nodeEnd, nodeStart, "'" + kind + "' declarations must be initialized.");
      return;
    } else if (!isIdentifier) {
      fail(nodeStart, nodeEnd, nodeStart, "'" + kind + "' declarations may not have binding patterns.");
      return;
    }
  }
  if (headOf >= 0) return;
  const isDeclared = hasKeyword(hir$.stmtModStart[list] | 0, hir$.stmtModLen[list] | 0, FLAG_AMBIENT);
  const isAssignable = kindOfVar === VAR_LET || kindOfVar === VAR_VAR;
  if (isDefinite && (isDeclared || !isAssignable)) {
    fail(nodeStart, nodeEnd, nodeStart, "A definite assignment assertion '!' is not permitted in this context.");
    return;
  }
  if (isDeclared && init >= 0 && (isAssignable || (hir$.varDeclTy[id] | 0) >= 0)) {
    fail(nodeStart, nodeEnd, nodeStart, "Initializers are not permitted in ambient contexts.");
  }
}

// ───────────────────────────── classes and interfaces ─────────────────────────────

function classes(): void {
  const hir$ = hir;
  const n = hir$.nClasses | 0;
  const bound$ = bound;
  const SP$ = SP;
  for (let i = 0; i < n; i++) {
    const modLen = hir$.classModLen[i] | 0;
    const implementsLen = hir$.classImplementsLen[i] | 0;
    const name = hir$.className[i] | 0;
    const hasCheck = modLen > 0 || name < 0 || implementsLen > 0;
    if (!hasCheck || (bound$.classReached[i] | 0) === 0) continue;
    const ownerTag = bound$.classOwnerTag[i] | 0;
    if (ownerTag === CO_NONE) continue;
    classSpan(i);
    const nodeStart = SP$.s0 | 0;
    const nodeEnd = SP$.s1 | 0;
    const modStart = hir$.classModStart[i] | 0;
    let kind: number;
    let place: number;
    if (ownerTag === CO_STMT) {
      kind = K_CLASS_DECLARATION;
      place = placeOfStatement(bound$.classOwnerA[i] | 0);
    } else {
      kind = K_CLASS_EXPRESSION;
      place = PL_OTHER;
    }
    checkModifiers(kind, place, nodeStart, nodeEnd, modStart, modLen, D_VALIDLY, 0, "");
    const isDefaultExport = hasKeyword(modStart, modLen, FLAG_EXPORT) && hasKeyword(modStart, modLen, FLAG_DEFAULT);
    if (kind === K_CLASS_DECLARATION && name < 0 && !isDefaultExport) {
      fail(nodeStart, nodeEnd, nodeStart, "A class declaration without the 'default' modifier must have a name.");
    }
    heritage(nodeStart, nodeEnd, hir$.classImplementsStart[i] | 0, implementsLen, "A class can only implement an identifier/qualified-name with optional type arguments.");
  }
  const ni = hir$.nInterfaces | 0;
  for (let i = 0; i < ni; i++) {
    const st = hir$.interfaceStmt[i] | 0;
    if (st < 0 || st >= hir$.nStmts) continue;
    const nodeStart = hir$.stmtStart[st] | 0;
    const nodeEnd = hir$.stmtLocEnd[st] | 0;
    heritage(nodeStart, nodeEnd, hir$.interfaceExtendsStart[i] | 0, hir$.interfaceExtendsLen[i] | 0, "Interface declaration can only extend an identifier/qualified name with optional type arguments.");
    // An `implements` without elements leaves nothing in the HIR.
    const afterHead = interfaceBodyStart(i);
    if (afterHead >= 0 && tokenAt(afterHead) === "implements") {
      failInHeritage(nodeStart, nodeEnd, afterHead, 0, "Interface declaration cannot have 'implements' clause.");
    }
    // The elements of the clauses after the first `extends`. An `extends` among them has a diagnostic.
    const others = hir$.interfaceOtherHeritageStart[i] | 0;
    const otherLen = hir$.interfaceOtherHeritageLen[i] | 0;
    for (let k = 0; k < otherLen; k++) {
      const t = hir$.ids[(others + k) | 0] | 0;
      if (t < 0 || t >= hir$.nTypes) continue;
      const keyword = fileEndOfTokenBefore(hir$.typePos[t] | 0);
      if (keyword >= 10 && sliceText(keyword - 10, keyword) === "implements") {
        failInHeritage(nodeStart, nodeEnd, keyword - 10, 0, "Interface declaration cannot have 'implements' clause.");
      }
    }
  }
}

/** `Interface::body_span().start`: the `{` of the interface (or what is in its place). */
function interfaceBodyStart(i: number): number {
  interfaceBodySpan(i);
  return SP.s0 | 0;
}

/** The parent of the expression `e` if that is an expression, else -1. */
function fileExprParent(e: number): number {
  const pn = exprParent(e);
  return nodeKind(pn) === N_EXPR ? nodeId(pn) : -1;
}

function isImportAttributesObjectOf(e: number): boolean {
  return isImportAttributesObject(e);
}

/** The elements of a heritage clause have to be entity names. */
function heritage(nodeStart: number, nodeEnd: number, elements: number, count: number, message: string): void {
  const hir$ = hir;
  for (let k = 0; k < count; k++) {
    const t = hir$.ids[(elements + k) | 0] | 0;
    if (t < 0 || t >= hir$.nTypes) continue;
    if ((hir$.typeTag[t] | 0) === TYPE_HERITAGE) failInHeritage(nodeStart, nodeEnd, hir$.typePos[t] | 0, 1, message);
  }
}

/**
 * A check of the heritage clauses of the node fails at `at`. They are checked after everything else about the node, in their order.
 * `rank`: the order of the checks that fail at the same place.
 */
function failInHeritage(nodeStart: number, nodeEnd: number, at: number, rank: number, message: string): void {
  const d = at > nodeStart ? at - nodeStart : 0;
  const step = d * 2 + 1 + rank;
  failAtStep(nodeStart, nodeEnd, step, at, message);
}

// ───────────────────────────── members ─────────────────────────────

function members(): void {
  const hir$ = hir;
  const n = hir$.nMembers | 0;
  const flagsOfInterest = FLAG_ABSTRACT | FLAG_DEFINITE | FLAG_STRING_NAME;
  const bound$ = bound;
  for (let i = 0; i < n; i++) {
    const flags = hir$.memberFlags[i] | 0;
    const modStart = hir$.memberModStart[i] | 0;
    const modLen = hir$.memberModLen[i] | 0;
    const init = hir$.memberInit[i] | 0;
    if (modLen === 0 && (flags & flagsOfInterest) === 0 && init < 0) continue;
    const ownerTag = bound$.memberOwnerTag[i] | 0;
    if (ownerTag === MO_NONE) continue;
    const cls = ownerTag === MO_CLASS ? bound$.memberOwnerA[i] | 0 : -1;
    const nodeStart = hir$.memberStart[i] | 0;
    const nodeEnd = hir$.memberLocEnd[i] | 0;
    const f = hir$.memberFunc[i] | 0;
    const hasBody = f >= 0 && f < hir$.nFns && (hir$.fnBodyKind[f] | 0) !== BODY_NONE;
    const mk = hir$.memberKind[i] | 0;
    let kind: number;
    switch (mk) {
      case MEMBER_PROPERTY:
        kind = cls >= 0 ? K_PROPERTY_DECLARATION : K_PROPERTY_SIGNATURE;
        break;
      case MEMBER_METHOD:
        kind = cls >= 0 ? K_METHOD_DECLARATION : K_METHOD_SIGNATURE;
        break;
      case MEMBER_GETTER:
      case MEMBER_SETTER:
        kind = K_ACCESSOR;
        break;
      case MEMBER_INDEX_SIGNATURE:
        kind = K_INDEX_SIGNATURE;
        break;
      case MEMBER_CONSTRUCTOR:
        kind = K_OTHER;
        break;
      default:
        // Not among `ts.canHaveModifiers`.
        continue;
    }
    const place = cls >= 0 ? PL_CLASS : PL_OTHER;
    const isAbstract = (flags & FLAG_ABSTRACT) !== 0;
    let decorated = D_INVALIDLY;
    if (kind === K_PROPERTY_DECLARATION) {
      const isDeclaration = cls >= 0 && (bound$.classOwnerTag[cls] | 0) === CO_STMT;
      decorated = isDeclaration || !isAbstract ? D_VALIDLY : D_INVALIDLY;
    } else if ((kind === K_METHOD_DECLARATION || kind === K_ACCESSOR) && hasBody && cls >= 0) {
      decorated = D_VALIDLY;
    } else if (kind === K_METHOD_DECLARATION) {
      decorated = D_OVERLOAD;
    }
    checkModifiers(kind, place, nodeStart, nodeEnd, modStart, modLen, decorated, 0, "");
    const namePos = hir$.memberNamePos[i] | 0;
    if (kind === K_PROPERTY_DECLARATION) {
      const isDefinite = (flags & FLAG_DEFINITE) !== 0;
      if (isAbstract && init >= 0) {
        fail(nodeStart, nodeEnd, startOf(init), "Abstract property cannot have an initializer.");
      } else if (isDefinite && isAbstract) {
        const nameEnd = memberNameEnd(i);
        fail(nodeStart, nodeEnd, skipTrivia(hir$.text, hir$.sourceLen | 0, nameEnd), "A definite assignment assertion '!' is not permitted in this context.");
      } else if (isDefinite && (hir$.memberTy[i] | 0) < 0) {
        fail(nodeStart, nodeEnd, nodeStart, "Declarations with definite assignment assertions must also have type annotations.");
      } else if (isDefinite && init >= 0) {
        fail(nodeStart, nodeEnd, nodeStart, "Declarations with initializers cannot also have definite assignment assertions.");
      } else if ((flags & FLAG_STRING_NAME) !== 0 && (flags & FLAG_COMPUTED_NAME) === 0 && memberKeyIs(i, "constructor")) {
        fail(nodeStart, nodeEnd, namePos, "Classes may not have a field named 'constructor'.");
      }
    } else if (kind === K_PROPERTY_SIGNATURE && init >= 0) {
      fail(nodeStart, nodeEnd, startOf(init), "A property signature cannot have an initializer.");
    } else if (kind === K_ACCESSOR && cls >= 0 && isAbstract && hasBody) {
      fail(nodeStart, nodeEnd, namePos, "An abstract accessor cannot have an implementation.");
    } else if (kind === K_METHOD_DECLARATION && isAbstract && hasBody) {
      // `declarationNameToString`: with the comments before the name.
      const from = fileEndOfTokenBefore(namePos);
      const nameEnd = memberNameEnd(i);
      let a = from;
      // `trim_js_whitespace_start`
      while (a < nameEnd) {
        const c = byte(a);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) a = (a + 1) | 0;
        else break;
      }
      fail(nodeStart, nodeEnd, namePos, "Method '" + sliceText(a, nameEnd) + "' cannot have an implementation because it is marked abstract.");
    }
  }
}

/** The end of the key of the member `i`, or its name position when it has none. */
function memberNameEnd(i: number): number {
  if (keySpan(nodeOfMember(i))) return SP.s1 | 0;
  return hir.memberNamePos[i] | 0;
}

function memberKeyIs(i: number, name: string): boolean {
  return keyIs(nodeOfMember(i), name);
}

// ───────────────────────────── parameters ─────────────────────────────

function parameters(): void {
  const hir$ = hir;
  const n = hir$.nParams | 0;
  const bound$ = bound;
  const SP$ = SP;
  for (let i = 0; i < n; i++) {
    const modLen = hir$.paramModLen[i] | 0;
    if (modLen === 0) continue;
    const func = bound$.paramFn[i] | 0;
    if (func < 0 || func >= hir$.nFns) continue;
    paramSpan(i);
    const nodeStart = SP$.s0 | 0;
    const nodeEnd = SP$.s1 | 0;
    const modStart = hir$.paramModStart[i] | 0;
    const flags = hir$.paramFlags[i] | 0;
    const fnKind = hir$.fnKind[func] | 0;
    const hasBody = (hir$.fnBodyKind[func] | 0) !== BODY_NONE;
    const pat = hir$.paramPat[i] | 0;
    const pt = pat >= 0 && pat < hir$.nPats ? hir$.patTag[pat] | 0 : -1;
    const isPattern = pt === PAT_OBJECT || pt === PAT_ARRAY;
    // `checkParameter`
    let asProperty = "";
    if (fnKind !== FN_CONSTRUCTOR || !hasBody) asProperty = "A parameter property is only allowed in a constructor implementation.";
    else if ((flags & FLAG_REST) !== 0) asProperty = "A parameter property cannot be a rest parameter.";
    else if (isPattern) asProperty = "A parameter property may not be declared using a binding pattern.";
    // `decorated`
    let isInClassDeclaration = false;
    if ((bound$.fnOwnerTag[func] | 0) === FO_MEMBER) {
      const member = bound$.fnOwnerA[func] | 0;
      if ((bound$.memberOwnerTag[member] | 0) === MO_CLASS) {
        const cls = bound$.memberOwnerA[member] | 0;
        isInClassDeclaration = (bound$.classOwnerTag[cls] | 0) === CO_STMT;
      }
    }
    const takesDecorators = fnKind === FN_CONSTRUCTOR || fnKind === FN_METHOD || fnKind === FN_SETTER;
    const decorated = hasBody && takesDecorators && isInClassDeclaration ? D_VALIDLY : D_INVALIDLY;
    const ofProperty = ACCESSIBILITY | FLAG_READONLY | FLAG_OVERRIDE;
    checkModifiers(K_PARAMETER, PL_OTHER, nodeStart, nodeEnd, modStart, modLen, decorated, asProperty === "" ? 0 : ofProperty, asProperty);
  }
}

function typeParameters(): void {
  const hir$ = hir;
  const n = hir$.nTypeParams | 0;
  const bound$ = bound;
  for (let i = 0; i < n; i++) {
    const modLen = hir$.typeParamModLen[i] | 0;
    if (modLen === 0 || (bound$.typeParamReached[i] | 0) === 0) continue;
    const parent = typeParamParent(i);
    let place = PL_OTHER;
    if (nodeKind(parent) === N_CLASS) place = PL_CLASS;
    else if (nodeKind(parent) === N_STMT) {
      const t = hir$.stmtTag[nodeId(parent)] | 0;
      if (t === STMT_INTERFACE || t === STMT_TYPE_ALIAS) place = PL_INTERFACE_OR_TYPE_ALIAS;
    }
    checkModifiers(K_TYPE_PARAMETER, place, hir$.typeParamStart[i] | 0, hir$.typeParamEnd[i] | 0, hir$.typeParamModStart[i] | 0, modLen, D_INVALIDLY, 0, "");
  }
}

// ───────────────────────────── `<>` ─────────────────────────────

/** `<>` from `open`, where a list of type parameters can start. */
function emptyTypeParametersAt(open: number): void {
  const hir$ = hir;
  if (byte(open) === 60 && byte(skipTrivia(hir$.text, hir$.sourceLen | 0, (open + 1) | 0)) === 62) failForEmptyList(WHEN_TYPE_PARAMETERS, open);
}

/** `convertTypeParameters`. The HIR does not tell a list that is empty from none. For a class there is a diagnostic. */
function functions(): void {
  const hir$ = hir;
  const t = hir$.text;
  const len = hir$.sourceLen | 0;
  const n = hir$.nFns | 0;
  const bound$ = bound;
  for (let i = 0; i < n; i++) {
    const kind = hir$.fnKind[i] | 0;
    const hasList = !(kind === FN_ARROW || kind === FN_STATIC_BLOCK || kind === FN_INDEX_SIGNATURE);
    const anchor = hir$.fnAnchor[i] | 0;
    if (!hasList || (hir$.fnTypeParamsLen[i] | 0) !== 0 || anchor === 0) continue;
    // Before the `(`: a `>`, or something to look behind.
    const before = byte(anchor - 1);
    if (!(before === 62 || before === 32 || before === 9 || before === 10 || before === 13 || before === 47)) continue;
    if (((hir$.fnFlags[i] | 0) & FLAG_REPARSED) !== 0 || (bound$.fnOwnerTag[i] | 0) === FO_NONE) continue;
    const close = fileEndOfTokenBefore(anchor);
    if (close < 2 || byte(close - 1) !== 62) continue;
    const open = fileEndOfTokenBefore(close - 1);
    if (open > 0 && byte(open - 1) === 60) failForEmptyList(WHEN_TYPE_PARAMETERS, open - 1);
  }
  void t;
  void len;
  const afterName = (at: number): number => skipTrivia(hir.text, hir.sourceLen | 0, (at + tokenLen(hir.text, hir.sourceLen | 0, at)) | 0);
  const ni = hir$.nInterfaces | 0;
  for (let i = 0; i < ni; i++) {
    if ((hir$.interfaceTypeParamsLen[i] | 0) === 0) emptyTypeParametersAt(afterName(hir$.interfaceNamePos[i] | 0));
  }
  const na = hir$.nAliases | 0;
  for (let i = 0; i < na; i++) {
    if ((hir$.aliasTypeParamsLen[i] | 0) === 0 && ((hir$.aliasFlags[i] | 0) & FLAG_REPARSED) === 0) emptyTypeParametersAt(afterName(hir$.aliasNamePos[i] | 0));
  }
}

// ───────────────────────────── object literals ─────────────────────────────

function properties(): void {
  const hir$ = hir;
  const n = hir$.nProps | 0;
  // `modifiers_of_props`
  const SP$ = SP;
  for (let id = 0; id < n; id++) {
    const modLen = hir$.propModLen[id] | 0;
    if (modLen === 0) continue;
    if (!propIsInTree(id)) continue;
    const pk = hir$.propKind[id] | 0;
    let kind: number;
    if (pk === PROP_METHOD) kind = K_METHOD_DECLARATION;
    else if (pk === PROP_GETTER || pk === PROP_SETTER) kind = K_ACCESSOR;
    else kind = K_PROPERTY_ASSIGNMENT;
    propSpan(id);
    checkModifiers(kind, PL_OBJECT_LITERAL, SP$.s0 | 0, SP$.s1 | 0, hir$.propModStart[id] | 0, modLen, D_INVALIDLY, 0, "");
  }
  const bound$ = bound;
  for (let i = 0; i < n; i++) {
    const pk = hir$.propKind[i] | 0;
    const isMethod = pk === PROP_METHOD || pk === PROP_GETTER || pk === PROP_SETTER;
    const postfix = hir$.propPostfixToken[i] | 0;
    if (!isMethod && postfix === 0) continue;
    if (isMethod) {
      let hasBody = true;
      const value = hir$.propValue[i] | 0;
      if (value >= 0 && value < hir$.nExprs && (hir$.exprTag[value] | 0) === EXPR_FN) {
        const f = hir$.exprA[value] | 0;
        hasBody = f < 0 || f >= hir$.nFns || (hir$.fnBodyKind[f] | 0) !== BODY_NONE;
      }
      const object = bound$.propOwner[i] | 0;
      if (object < 0 || hasBody || !propIsInTree(i)) continue;
      // A check of the `ObjectLiteralExpression`, unless it is converted as a pattern.
      if (!exprIsAssignmentTarget(object)) {
        exprOuterSpan(object);
        // `object.span()` is the span of the node without its parentheses.
        const os = hir$.exprPos[object] | 0;
        const oe = hir$.exprEnd[object] | 0;
        propSpan(i);
        failAtStep(os, oe, i, (SP$.s1 | 0) > 0 ? (SP$.s1 | 0) - 1 : 0, "'{' expected.");
      }
      continue;
    }
    if (!propIsInTree(i)) continue;
    let of: string;
    if (pk === PROP_INIT) of = "A property assignment";
    else if (pk === PROP_SHORTHAND) of = "A shorthand property assignment";
    else continue;
    const token = byte(postfix) === 63 ? " cannot have a question token." : " cannot have an exclamation token.";
    propSpan(i);
    fail(SP$.s0 | 0, SP$.s1 | 0, postfix, of + token);
  }
}

/** `Prop::is_in_tree` */
function propIsInTree(i: number): boolean {
  const owner = bound.propOwner[i] | 0;
  if (owner < 0) return false;
  return !(hir.importAttributesLen !== 0 && isImportAttributesObjectOf(owner));
}

// ───────────────────────────── expressions ─────────────────────────────

function expressions(): void {
  const hir$ = hir;
  const n = hir$.nExprs | 0;
  for (let i = 0; i < n; i++) {
    const t = hir$.exprTag[i] | 0;
    if (!(t === EXPR_TAGGED_TEMPLATE || t === EXPR_PRIVATE_IDENTIFIER || t === EXPR_UNARY || t === EXPR_IMPORT_CALL)) continue;
    if (!exprInTree(i)) continue;
    expression(i);
  }
}

/** `File::expr_in_tree` */
function exprInTree(i: number): boolean {
  if ((bound.exprParentTag[i] | 0) === P_NONE) return false;
  const hir$ = hir;
  const t = hir$.exprTag[i] | 0;
  if (t === EXPR_MISSING) return false;
  if (hir$.importAttributesLen !== 0 && t === EXPR_OBJECT && isImportAttributesObjectOf(i)) return false;
  return true;
}

function expression(it: number): void {
  const hir$ = hir;
  const t = hir$.exprTag[it] | 0;
  const itStart = hir$.exprPos[it] | 0;
  const itEnd = hir$.exprEnd[it] | 0;
  if (t === EXPR_TAGGED_TEMPLATE) {
    const call = hir$.exprA[it] | 0;
    const tag = hir$.callCallee[call] | 0;
    // `node.tag.flags & ts.NodeFlags.OptionalChain`
    const tt = tag >= 0 ? hir$.exprTag[tag] | 0 : -1;
    const isChain = (tt === EXPR_DOT || tt === EXPR_INDEX) ? (hir$.exprAux[tag] | 0) !== CHAIN_NO : tt === EXPR_CALL ? (hir$.callChain[hir$.exprA[tag] | 0] | 0) !== CHAIN_NO : false;
    if (isChain && !fileIsParenthesized(tag)) {
      fail(itStart, itEnd, itStart, "Tagged template expressions are not permitted in an optional chain.");
    }
  } else if (t === EXPR_PRIVATE_IDENTIFIER) {
    const parentNode = fileExprParent(it);
    if (parentNode < 0) return;
    const pt = hir$.exprTag[parentNode] | 0;
    let isIn = false;
    let left: number;
    let right: number;
    if (pt === EXPR_BINARY) {
      isIn = (hir$.exprAux[parentNode] | 0) === BIN_IN;
      left = hir$.exprA[parentNode] | 0;
      right = hir$.exprB[parentNode] | 0;
    } else if (pt === EXPR_ASSIGN) {
      left = hir$.exprA[parentNode] | 0;
      right = hir$.exprB[parentNode] | 0;
    } else return;
    const isPrivate = (id: number): boolean => id >= 0 && id < hir.nExprs && (hir.exprTag[id] | 0) === EXPR_PRIVATE_IDENTIFIER;
    const ps = hir$.exprPos[parentNode] | 0;
    const pe = hir$.exprEnd[parentNode] | 0;
    if (left === it && !isIn) {
      fail(ps, pe, itStart, "Private identifiers cannot appear on the right-hand-side of an 'in' expression.");
    } else if (right === it && (isIn || !isPrivate(left))) {
      fail(ps, pe, itStart, "Private identifiers are only allowed on the left-hand-side of an 'in' expression.");
    }
  } else if (t === EXPR_UNARY) {
    const op = hir$.exprAux[it] | 0;
    const operand = hir$.exprA[it] | 0;
    const isUpdate = op === UN_PRE_INC || op === UN_PRE_DEC || op === UN_POST_INC || op === UN_POST_DEC;
    if (isUpdate && !isValidAssignmentTarget(operand)) {
      fail(itStart, itEnd, startOf(operand), "Invalid left-hand side expression in unary operation");
    }
  } else if (t === EXPR_IMPORT_CALL) {
    const argsStart = hir$.exprA[it] | 0;
    const argsLen = hir$.exprB[it] | 0;
    // `import.source()`: the dialect of Babel, in which `bun fmt` has every file parsed, has it.
    if (isOfPrettier && importCallPhase(it) >= 0) {
      const dot = skipTrivia(hir$.text, hir$.sourceLen | 0, (itStart + 6) | 0);
      // It is `defer` or `source`, or the parser had not taken it. The first letter can be `s` or `\u{73}`.
      const at = skipTrivia(hir$.text, hir$.sourceLen | 0, (dot + 1) | 0);
      let isSource = false;
      const c = byte(at);
      if (c === 115) isSource = true;
      else if (c === 92 && byte(at + 1) === 117) {
        let k = (at + 2) | 0;
        if (byte(k) === 123) k = (k + 1) | 0;
        while (byte(k) === 48) k = (k + 1) | 0;
        isSource = byte(k) === 55 && byte(k + 1) === 51;
      }
      if (isSource) fail(itStart, itEnd, itStart, NO_SOURCE);
    }
    const isMissing = (id: number): boolean => id >= 0 && id < hir.nExprs && (hir.exprTag[id] | 0) === EXPR_MISSING;
    const first = argsLen > 0 ? hir$.ids[argsStart] | 0 : -1;
    const hasNone = argsLen === 1 && isMissing(first);
    let isDeferred = false;
    for (let k = 0; k < (hir$.deferredImportCallsLen | 0); k += 2) {
      if ((hir$.deferredImportCalls[k] | 0) === first) {
        isDeferred = true;
        break;
      }
    }
    if ((hasNone || argsLen > 2) && !isDeferred) {
      const at = argsLen > 2 ? startOf(hir$.ids[(argsStart + 2) | 0] | 0) : itStart;
      fail(itStart, itEnd, at, "Dynamic import requires exactly one or two arguments.");
    }
  }
}

/** `Expr::import_call_phase`: the phase of `import.source()` / `import.defer()`, or -1. */
function importCallPhase(e: number): number {
  return exprImportCallPhase(e) !== 0 ? 1 : -1;
}

// ───────────────────────────── what there is little of ─────────────────────────────

function theRest(): void {
  const hir$ = hir;
  const ne = hir$.nEnumMembers | 0;
  for (let i = 0; i < ne; i++) {
    const pos_ = hir$.enumMemberPos[i] | 0;
    const nodeEnd = hir$.enumMemberLocEnd[i] | 0;
    const nameKind = hir$.enumMemberNameKind[i] | 0;
    const isComputed = (hir$.enumMemberComputedName[i] | 0) >= 0 || nameKind === NK_COMPUTED_STRING || nameKind === NK_COMPUTED_NUMBER;
    if (isComputed) {
      fail(pos_, nodeEnd, pos_, "Computed property names are not allowed in enums.");
    } else if (nameKind === NK_NUMERIC_LITERAL || (byte(pos_) >= 48 && byte(pos_) <= 57)) {
      fail(pos_, nodeEnd, pos_, "An enum member cannot have a numeric name.");
    }
  }
  const nm = hir$.nMapped | 0;
  for (let i = 0; i < nm; i++) {
    const membersStart = hir$.mappedMembersStart[i] | 0;
    const membersLen = hir$.mappedMembersLen[i] | 0;
    if (membersLen === 0) continue;
    const member = hir$.ids[membersStart] | 0;
    const memberStart = hir$.memberStart[member] | 0;
    let nodeStart = memberStart;
    let nodeEnd = memberStart;
    const nt = hir$.nTypes | 0;
    for (let k = 0; k < nt; k++) {
      if ((hir$.typeTag[k] | 0) === TYPE_MAPPED && (hir$.typeA[k] | 0) === i) {
        nodeStart = hir$.typePos[k] | 0;
        nodeEnd = hir$.typeEnd[k] | 0;
        break;
      }
    }
    fail(nodeStart, nodeEnd, memberStart, "A mapped type may not declare properties or methods.");
  }
  const nim = hir$.nImports | 0;
  for (let i = 0; i < nim; i++) {
    const st = hir$.importStmt[i] | 0;
    if (st < 0 || st >= hir$.nStmts) continue;
    const hasBindings = (hir$.importNamespace[i] | 0) >= 0 || (hir$.importHasNamedImports[i] | 0) !== 0;
    const hasDefault = (hir$.importDefault[i] | 0) >= 0;
    const typeOnly = (hir$.importTypeOnly[i] | 0) !== 0;
    const deferred = (hir$.importIsDeferred[i] | 0) !== 0;
    let message: string;
    if (typeOnly && hasDefault && hasBindings) message = "A type-only import can specify a default import or named bindings, but not both.";
    else if (deferred && (hir$.importHasNamedImports[i] | 0) !== 0) message = "Named imports are not allowed in a deferred import.";
    else if (deferred && hasDefault) message = "Default imports are not allowed in a deferred import.";
    else continue;
    fail(hir$.stmtStart[st] | 0, hir$.stmtLocEnd[st] | 0, hir$.importClauseStart[i] | 0, message);
  }
  const nes = hir$.nExportSpecs | 0;
  for (let i = 0; i < nes; i++) {
    const ex = hir$.exportSpecExport[i] | 0;
    const hasSource = ex < 0 || ex >= hir$.nExports || (hir$.exportHasModuleSpecifier[ex] | 0) !== 0;
    const localPos = hir$.exportSpecLocalPos[i] | 0;
    if (!hasSource && isStringLiteral(localPos)) {
      fail(hir$.exportSpecStart[i] | 0, hir$.exportSpecEnd[i] | 0, localPos, "A string literal cannot be used as a local exported binding without `from`.");
    }
  }
}

// ───────────────────────────── what the HIR has dropped ─────────────────────────────

let declStart = 0;
let declEnd = 0;

/** The class or the interface whose head `at` is in, and whether it is an interface. 0: none, 1: a class, 2: an interface. */
function declarationWithHead(at: number): number {
  let best = 0;
  let bestStart = -1;
  const hir$ = hir;
  const nc = hir$.nClasses | 0;
  const bound$ = bound;
  const SP$ = SP;
  for (let i = 0; i < nc; i++) {
    if ((bound$.classOwnerTag[i] | 0) === CO_NONE) continue;
    classSpan(i);
    const s0 = SP$.s0 | 0;
    const e0 = SP$.s1 | 0;
    const first = (hir$.classMembersLen[i] | 0) > 0 ? hir$.memberStart[hir$.ids[hir$.classMembersStart[i] | 0] | 0] | 0 : e0;
    if (s0 <= at && at <= first && s0 >= bestStart) {
      bestStart = s0;
      declStart = s0;
      declEnd = e0;
      best = 1;
    }
  }
  const ni = hir$.nInterfaces | 0;
  for (let i = 0; i < ni; i++) {
    const st = hir$.interfaceStmt[i] | 0;
    if (st < 0 || st >= hir$.nStmts) continue;
    const s0 = hir$.stmtStart[st] | 0;
    const e0 = hir$.stmtLocEnd[st] | 0;
    const first = (hir$.interfaceMembersLen[i] | 0) > 0 ? hir$.memberStart[hir$.ids[hir$.interfaceMembersStart[i] | 0] | 0] | 0 : e0;
    if (s0 <= at && at <= first && s0 >= bestStart) {
      bestStart = s0;
      declStart = s0;
      declEnd = e0;
      best = 2;
    }
  }
  return best;
}

/** The start of the `import` of the meta property whose name starts at `name`, or -1. */
function importBefore(name: number): number {
  const dot = fileEndOfTokenBefore(name);
  if (dot < 1) return -1;
  const keyword = fileEndOfTokenBefore(dot - 1);
  const isImport = byte(dot - 1) === 46 && keyword >= 6 && sliceText(keyword - 6, keyword) === "import";
  return isImport ? keyword - 6 : -1;
}

function diagnostics(): void {
  const n = hir.diagnosticsLen | 0;
  for (let i = 0; i < n; i += 5) diagnostic(i);
}

function argOf(row: number, index: number): string {
  const hir$ = hir;
  const id = hir$.diagnostics[row + 4] | 0;
  if (id < 0) return "";
  const args = hir$.diagArgs[id];
  return index < args.length ? args[index] : "";
}

function hasArg(row: number): boolean {
  return (hir.diagnostics[row + 4] | 0) >= 0;
}

function inHeritage(at: number, rank: number, message: string): void {
  const kind = declarationWithHead(at);
  if (kind === 0) return;
  const nodeStart = declStart;
  const nodeEnd = declEnd;
  // That a clause is empty is checked first, and the parser reports one thing about a clause.
  const keyword = tokenAt(at);
  const isClause = keyword === "extends" || keyword === "implements";
  const hir$ = hir;
  if (isClause && byte(skipTrivia(hir$.text, hir$.sourceLen | 0, (at + keyword.length) | 0)) === 123) {
    failInHeritage(nodeStart, nodeEnd, at, 0, "'" + keyword + "' list cannot be empty.");
    return;
  }
  failInHeritage(nodeStart, nodeEnd, at, rank, message);
}

function diagnostic(row: number): void {
  const hir$ = hir;
  const at = hir$.diagnostics[row + 1] | 0;
  const code = hir$.diagnostics[row + 3] | 0;
  switch (code) {
    case 1098:
      failForEmptyList(WHEN_TYPE_PARAMETERS, at);
      break;
    case 1099:
      failForEmptyList(WHEN_TYPE_ARGUMENTS, at);
      break;
    // At the end of the keyword.
    case 1097: {
      const keyword = argOf(row, 0);
      let end: number;
      if (at >= keyword.length && sliceText(at - keyword.length, at) === keyword) end = at;
      else end = fileEndOfTokenBefore(at);
      const start = end > keyword.length ? end - keyword.length : 0;
      const kind = declarationWithHead(start);
      if (kind === 0) return;
      if (kind === 2 && keyword === "implements") {
        failInHeritage(declStart, declEnd, start, 0, "Interface declaration cannot have 'implements' clause.");
        return;
      }
      failInHeritage(declStart, declEnd, start, 0, "'" + keyword + "' list cannot be empty.");
      break;
    }
    case 1172:
      inHeritage(at, 1, "'extends' clause already seen.");
      break;
    case 1173:
      inHeritage(at, 1, "'extends' clause must precede 'implements' clause.");
      break;
    case 1174:
      inHeritage(at, 1, "Classes can only extend a single class.");
      break;
    case 1175:
      inHeritage(at, 1, "'implements' clause already seen.");
      break;
    // `a?.b` as an element of a clause.
    case 2499:
      inHeritage(at, 1, "Interface declaration can only extend an identifier/qualified name with optional type arguments.");
      break;
    case 2500:
      inHeritage(at, 1, "A class can only implement an identifier/qualified-name with optional type arguments.");
      break;
    // The specifier of a module that is not a string.
    case 1141: {
      let isRequire = false;
      const nie = hir$.nImportEquals | 0;
      for (let k = 0; k < nie; k++) {
        const e = hir$.importEqualsExpression[k] | 0;
        if (e >= 0 && e < hir$.nExprs && (hir$.exprPos[e] | 0) === at) {
          isRequire = true;
          break;
        }
      }
      fail(at, at, at, isRequire ? "String literal expected." : "Module specifier must be a string literal.");
      break;
    }
    // `import.a`
    case 17012:
    case 18061: {
      const start = importBefore(at);
      if (start < 0) return;
      // Not as it is written: `import.a`
      const name = hasArg(row) ? argOf(row, 0) : tokenAt(at);
      fail(start, at, start, "'" + name + "' is not a valid meta-property for keyword 'import'.");
      break;
    }
    // `import.defer` that is not called: the `(` is missing.
    case 1005:
      if (hasArg(row) && argOf(row, 0) === "(") {
        const end = fileEndOfTokenBefore(at);
        // In the dialect of Babel.
        if (end >= 6 && sliceText(end - 6, end) === "source") {
          const start = importBefore(end - 6);
          if (start >= 0) fail(start, end, start, NO_SOURCE);
        }
        if (end < 5) return;
        if (sliceText(end - 5, end) === "defer") {
          const start = importBefore(end - 5);
          if (start >= 0) {
            // `node.parent.kind !== SyntaxKind.CallExpression`, which an argument passes too.
            let isInCall = false;
            const nex = hir$.nExprs | 0;
            for (let k = 0; k < nex; k++) {
              if ((hir$.exprTag[k] | 0) === EXPR_DOT && (hir$.exprPos[k] | 0) === start && !fileIsParenthesized(k)) {
                const parent = fileExprParent(k);
                isInCall = parent >= 0 && (hir$.exprTag[parent] | 0) === EXPR_CALL;
                break;
              }
            }
            const message = isInCall
              ? "'defer' is not a valid meta-property for keyword 'import'."
              : "'import.defer' is only valid when called. Use 'import.defer()' instead.";
            fail(start, end, start, message);
          }
        }
      }
      break;
    default:
  }
}

// ───────────────────────────── the entry ─────────────────────────────

/** `is_of_prettier`: the version that Prettier 3.9 has, which does not look at the values of import attributes. */
export function firstError(ofPrettier: boolean): boolean {
  isOfPrettier = ofPrettier;
  errAt = [];
  errMessage = [];
  resetCandidates();
  statements();
  variableDeclarations();
  classes();
  members();
  parameters();
  typeParameters();
  functions();
  properties();
  expressions();
  theRest();
  diagnostics();
  const count = errAt.length;
  let first = 0;
  if (count > 1) first = orderFirst();
  if (first < 0 || first >= count) first = 0;
  if (first < count && count > 0) {
    setCheck(errMessage[first], errAt[first], true);
    return true;
  }
  setCheck("", 0, false);
  return false;
}
