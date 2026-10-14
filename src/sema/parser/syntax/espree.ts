// Port of vendor/bun/src/lint/linter/syntax/espree.rs and espree/early.rs, for Prettier's `babel`: `refusal_of_babel`: what Babel throws on a
// JavaScript file that the parser here, in that dialect, has nothing to say about.
//
// Prettier lets Babel go on after an error, and lets pass what is only wrong in strict mode, names that are declared twice or not at all,
// `return`, `import` and `export` where they do not belong, and more. It is meant to format code that is not quite right. So only errors
// count here of which it is known that it throws (`REFUSED_BY_BABEL`): every check below is the one of `early.rs` with `is_babel`, and
// what cannot say any of these words is left out (the Rust code calls `fail` and is filtered; here it is not called).
//
// acorn throws at the first error, and it gets to them in the order of the source: `fail` keeps the error that acorn notices first.
import {
  BIN_AND,
  BIN_COMMA,
  BIN_NULLISH,
  BIN_OR,
  BODY_BLOCK,
  CHAIN_NO,
  DK_GRAMMAR,
  EXPR_ARRAY,
  EXPR_ASSIGN,
  EXPR_AWAIT,
  EXPR_BINARY,
  EXPR_CALL,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_IMPORT_CALL,
  EXPR_INDEX,
  EXPR_MISSING,
  EXPR_NEW,
  EXPR_NEW_TARGET,
  EXPR_OBJECT,
  EXPR_REGEX,
  EXPR_SPREAD,
  EXPR_SUPER,
  EXPR_TAGGED_TEMPLATE,
  EXPR_UNARY,
  EXPR_YIELD,
  FLAG_REST,
  FN_ARROW,
  FN_CONSTRUCTOR,
  FN_GETTER,
  FN_METHOD,
  FN_SETTER,
  FN_STATIC_BLOCK,
  KEY,
  KEY_IDENT,
  KEY_NAME,
  KEY_PRIVATE,
  KEY_STRING,
  MEMBER_GETTER,
  MEMBER_PROPERTY,
  MEMBER_SETTER,
  N_CASE,
  N_CLASS,
  N_EXPR,
  N_FILE,
  N_FUNC,
  N_MEMBER,
  N_PARAM,
  N_STMT,
  N_VAR_DECL,
  PAT_IDENT,
  PK_NAME,
  PROP_GETTER,
  PROP_INIT,
  PROP_METHOD,
  PROP_SETTER,
  PROP_SHORTHAND,
  PROP_SPREAD,
  SP,
  STMT_BREAK,
  STMT_CLASS,
  STMT_CONTINUE,
  STMT_DO_WHILE,
  STMT_EXPORT_DEFAULT,
  STMT_EXPORT_NAMED,
  STMT_EXPORT_STAR,
  STMT_EXPR,
  STMT_FN,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IF,
  STMT_LABELED,
  STMT_SWITCH,
  STMT_THROW,
  STMT_VAR,
  STMT_WHILE,
  UN_DELETE,
  UN_POST_DEC,
  UN_POST_INC,
  UN_PRE_DEC,
  UN_PRE_INC,
  VAR_AWAIT_USING,
  VAR_CONST,
  VAR_LET,
  VAR_USING,
  bound,
  classExtends,
  exprImportCallPhase,
  exprIsAssignmentTarget,
  exprIsInOptionalChain,
  exprIsJsxTagName,
  exprOperatorSpan,
  exprOuterSpan,
  exprParent,
  exprRegexFlagsSpan,
  fileEndOfTokenBefore,
  fileIsParenthesized,
  funcArrowSpan,
  funcBodySpan,
  funcEstreeSpan,
  funcOwner,
  funcSpan,
  funcSpanFromParams,
  hir,
  identIsString,
  identSpan,
  keyLoad,
  keySpan,
  memberConstructorKeyword,
  memberIsConstructor,
  memberIsStatic,
  nodeId,
  nodeKind,
  nodeParent,
  paramSpan,
  propIsJsxAttribute,
  propSpan,
  skipTrivia,
  stmtDirectiveSpan,
  stmtExportSpan,
  stmtIsDefaultExport,
  stmtIsExported,
  stmtIsLoop,
  stmtIsWith,
  stmtIsWrapper,
  stmtWithBody,
  tokenLen,
} from "../../../lint/ast/index.ts";
import { A_arguments, A_let } from "../../atom.ts";
import { names } from "../parser/mod.ts";
import { exprInTree, propInTree } from "./in_tree.ts";
import { atomText } from "../parser/mod.ts";
import { setCheck } from "./error.ts";
import { I32Vec } from "../../vec.ts";
import { P_NONE, FO_NONE } from "../../bind/parents.ts";
import { EXPR_FN, FN_DECL, FN_EXPR, PAT_MISSING, FLAG_ASYNC, FLAG_GENERATOR, NK_COMPUTED_STRING, NK_COMPUTED_NUMBER, STMT_IMPORT } from "../../hir.ts";
import { P_STMT } from "../../bind/parents.ts";

/** The errors, in the words of acorn, that Babel has too, that it does not recover from or Prettier does not let pass. */
const REFUSED_BY_BABEL: string[] = [
  "A string literal cannot be used as an exported binding without `from`.",
  "An export name cannot include a lone surrogate.",
  "Assigning to rvalue",
  "Async functions can only be declared at the top level or inside a block",
  "Await expression cannot be a default value",
  "Cannot use 'arguments' in class field initializer",
  "Cannot use arguments in class static initialization block",
  "Cannot use new with import",
  "Classes can't have",
  "Classes may not have a static property named prototype",
  "Comma is not permitted after the rest element",
  "Constructor can't",
  "Duplicate constructor in the same class",
  "Duplicate export 'default'",
  "Duplicate regular expression flag",
  "Identifier '#",
  "Illegal 'use strict' directive in function with non-simple parameter list",
  "Illegal newline after throw",
  "Invalid regular expression flag",
  "Label '",
  "Leading decorators must be attached to a class declaration",
  "Lexical declaration cannot appear in a single-statement context",
  "Logical expressions and coalesce expressions cannot be mixed",
  "Multiple default clauses",
  "No line break is allowed before '=>'",
  "Object pattern can't contain getter or setter",
  "Only `import defer * as x` is valid",
  "Optional chaining cannot appear in left-hand side",
  "Optional chaining cannot appear in the tag of tagged template expressions",
  "Private fields can not be deleted",
  "Private fields can't be accessed on super",
  "Redefinition of __proto__ property",
  "Rest elements cannot have a default value",
  "Sequence expressions cannot be directly nested inside JSX",
  "Setter cannot use rest params",
  "Shorthand property assignments are valid only in destructuring patterns",
  "The left-hand side of a for-of loop may not be 'async'.",
  "The only valid meta property for",
  "Unsyntactic break",
  "Unsyntactic continue",
  "Using declaration",
  "Yield expression cannot be a default value",
  "`...` is not allowed in `import()`",
  "`import()` requires exactly one or two arguments",
  "getter should have no params",
  "let is disallowed as a lexically bound name",
  "setter should have exactly one param",
  "super() call outside constructor of a subclass",
];

// The first error so far, and how far acorn has read when it throws it.
let firstNoticed = -1;
let firstAt = 0;
let firstMessage = "";
/** acorn notices what is being checked only when it has read this far. */
let noticed = 0;
/** The file is read as a script: `languageOptions.sourceType` is not "module". */
let isScriptSource = false;

function isRefused(message: string): boolean {
  for (let i = 0; i < REFUSED_BY_BABEL.length; i++) if (message.startsWith(REFUSED_BY_BABEL[i])) return true;
  return false;
}

/** Of two errors that acorn would notice at one place, the one that is found first counts. */
function fail(at: number, message: string): void {
  if (!isRefused(message)) return;
  const n = noticed > at ? noticed : at;
  if (firstNoticed < 0 || n < firstNoticed) {
    firstNoticed = n;
    firstAt = at;
    firstMessage = message;
  }
}

function byte(at: number): number {
  const hir$ = hir;
  return at >= 0 && at < (hir$.sourceLen | 0) ? hir$.text[at] | 0 : 0;
}

function sliceText(start: number, end: number): string {
  if (end <= start) return "";
  const hir$ = hir;
  return Buffer.from(hir$.text.buffer, hir$.text.byteOffset + start, end - start).toString("utf8");
}

/** The token at `at`. */
function tokenAt(at: number): string {
  const hir$ = hir;
  const rest = hir$.sourceLen - at;
  if (rest <= 0) return "";
  const c = byte(at);
  let len: number;
  if (c === 62) {
    // TypeScript's scanner stops after the first `>`.
    let same = 0;
    while (same < 3 && byte(at + same) === 62) same = (same + 1) | 0;
    len = same + (byte(at + same) === 61 ? 1 : 0);
  } else if (c === 96) {
    // The quote is a token of its own.
    len = 1;
  } else {
    len = tokenLen(hir$.text, hir$.sourceLen | 0, at);
  }
  if (len > rest) len = rest;
  return sliceText(at, at + len);
}

/** The start of the token after the one at `at`. */
function afterToken(at: number): number {
  const hir$ = hir;
  return skipTrivia(hir$.text, hir$.sourceLen | 0, (at + tokenAt(at).length) | 0);
}

function isIdentifierByte(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c >= 0x80;
}

/** The start of the token before the one at `at`: a word, or a punctuator of one character. */
function beforeToken(at: number): number {
  const end = fileEndOfTokenBefore(at);
  let start = end > 0 ? end - 1 : 0;
  while (start > 0 && isIdentifierByte(byte(start)) && isIdentifierByte(byte(start - 1))) start = (start - 1) | 0;
  return start;
}

function nextIs(after: number, c: number): number {
  const hir$ = hir;
  const at = skipTrivia(hir$.text, hir$.sourceLen | 0, after);
  return byte(at) === c ? at : -1;
}

// ───────────────────────────── the expressions to look at ─────────────────────────────

let assigns: I32Vec = new I32Vec(16);
let awaitExprs: I32Vec = new I32Vec(16);
let binaries: I32Vec = new I32Vec(16);
let dots: I32Vec = new I32Vec(16);
let argumentsIdents: I32Vec = new I32Vec(16);
let importCalls: I32Vec = new I32Vec(16);
let newTargets: I32Vec = new I32Vec(16);
let regexes: I32Vec = new I32Vec(16);
let supers: I32Vec = new I32Vec(16);
let taggedTemplates: I32Vec = new I32Vec(16);
let unaries: I32Vec = new I32Vec(16);
let yields: I32Vec = new I32Vec(16);

function findCandidates(): void {
  assigns.len = 0;
  awaitExprs.len = 0;
  binaries.len = 0;
  dots.len = 0;
  argumentsIdents.len = 0;
  importCalls.len = 0;
  newTargets.len = 0;
  regexes.len = 0;
  supers.len = 0;
  taggedTemplates.len = 0;
  unaries.len = 0;
  yields.len = 0;
  const hir$ = hir;
  const n = hir$.nExprs | 0;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  // Most files have no `??` and no `#`.
  let hasPrivateNames = false;
  let hasNullish = false;
  for (let i = 0; i < len; i++) {
    const c = text[i] | 0;
    if (c === 35) hasPrivateNames = true;
    else if (c === 63 && (text[i + 1] | 0) === 63) hasNullish = true;
  }
  for (let i = 0; i < n; i++) {
    const t = hir$.exprTag[i] | 0;
    let isCandidate = false;
    switch (t) {
      case EXPR_IDENT:
        isCandidate = (hir$.exprA[i] | 0) === A_arguments;
        if (isCandidate) {
          if (exprInTree(i) && !exprIsJsxTagName(i)) argumentsIdents.push(i);
          isCandidate = false;
        }
        break;
      case EXPR_DOT:
        isCandidate = hasPrivateNames && byte(hir$.exprC[i] | 0) === 35;
        break;
      case EXPR_BINARY: {
        const op = hir$.exprAux[i] | 0;
        isCandidate = hasNullish && (op === BIN_NULLISH || op === BIN_AND || op === BIN_OR);
        break;
      }
      case EXPR_UNARY: {
        const op = hir$.exprAux[i] | 0;
        isCandidate = op === UN_PRE_INC || op === UN_PRE_DEC || op === UN_POST_INC || op === UN_POST_DEC || op === UN_DELETE;
        break;
      }
      case EXPR_ASSIGN:
      case EXPR_AWAIT:
      case EXPR_IMPORT_CALL:
      case EXPR_NEW_TARGET:
      case EXPR_REGEX:
      case EXPR_SUPER:
      case EXPR_TAGGED_TEMPLATE:
      case EXPR_YIELD:
        isCandidate = true;
        break;
      default:
    }
    if (!isCandidate || !exprInTree(i)) continue;
    switch (t) {
      case EXPR_ASSIGN:
        assigns.push(i);
        break;
      case EXPR_AWAIT:
        awaitExprs.push(i);
        break;
      case EXPR_BINARY:
        binaries.push(i);
        break;
      case EXPR_DOT:
        dots.push(i);
        break;
      case EXPR_IMPORT_CALL:
        importCalls.push(i);
        break;
      case EXPR_NEW_TARGET:
        newTargets.push(i);
        break;
      case EXPR_REGEX:
        regexes.push(i);
        break;
      case EXPR_SUPER:
        supers.push(i);
        break;
      case EXPR_TAGGED_TEMPLATE:
        taggedTemplates.push(i);
        break;
      case EXPR_UNARY:
        unaries.push(i);
        break;
      case EXPR_YIELD:
        yields.push(i);
        break;
      default:
    }
  }
}

// ───────────────────────────── tree queries ─────────────────────────────

function exprStart(e: number): number {
  return hir.exprPos[e] | 0;
}

function exprEnd(e: number): number {
  return hir.exprEnd[e] | 0;
}

function outerStart(e: number): number {
  exprOuterSpan(e);
  return SP[0] | 0;
}

function outerEnd(e: number): number {
  exprOuterSpan(e);
  return SP[1] | 0;
}

function stmtInTree(i: number): boolean {
  if ((bound.stmtParentTag[i] | 0) === P_NONE) return false;
  if (stmtIsWrapper(i)) return false;
  // The `B` of `namespace A.B`: it starts with its name.
  return true;
}

function funcInTree(f: number): boolean {
  return (bound.fnOwnerTag[f] | 0) !== FO_NONE;
}

function classInTree(c: number): boolean {
  const bound$ = bound;
  const t = bound$.classOwnerTag[c] | 0;
  if (t === 0) return false;
  return !(t === 2 && (bound$.classOwnerA[c] | 0) < 0);
}

function strBytes(text_: string): Uint8Array {
  const b = new Uint8Array(text_.length);
  for (let i = 0; i < text_.length; i++) b[i] = text_.charCodeAt(i);
  return b;
}

// ───────────────────────────── keywords as names ─────────────────────────────

/** What `this` and `super` belong to: `currentThisScope`. -1: none. */
function thisScope(node: number): number {
  let inside = node;
  let at = nodeParent(node);
  const hir$ = hir;
  for (;;) {
    if (nodeKind(at) === N_FILE) return -1;
    if (nodeKind(at) === N_FUNC && (hir$.fnKind[nodeId(at)] | 0) !== FN_ARROW) return at;
    if (nodeKind(at) === N_MEMBER && (hir$.memberKind[nodeId(at)] | 0) === MEMBER_PROPERTY) {
      const init = hir$.memberInit[nodeId(at)] | 0;
      if (init >= 0 && ((N_EXPR << 26) | init) === inside) return at;
    }
    inside = at;
    at = nodeParent(at);
  }
}

/** `checkUnreserved` for the name `arguments`: whether an error was said. */
function isReservedArguments(node: number, at: number): boolean {
  // The name of a function expression is in the scope of the function.
  let func = -1;
  const hir$ = hir;
  if (nodeKind(node) === N_FUNC && (hir$.fnKind[nodeId(node)] | 0) === FN_EXPR) {
    func = nodeId(node);
  } else {
    let inside = node;
    let up = nodeParent(node);
    for (;;) {
      if (nodeKind(up) === N_FILE) break;
      if (nodeKind(up) === N_FUNC) {
        func = nodeId(up);
        break;
      }
      // For acorn the initializer of a field is a scope of its own, which is not that of the function around.
      if (nodeKind(up) === N_MEMBER) {
        const init = hir$.memberInit[nodeId(up)] | 0;
        if (init >= 0 && ((N_EXPR << 26) | init) === inside) {
          func = -1;
          break;
        }
      }
      inside = up;
      up = nodeParent(up);
    }
  }
  const isInStaticBlock = func >= 0 && (hir$.fnKind[func] | 0) === FN_STATIC_BLOCK;
  const scope = thisScope(node);
  if (scope >= 0 && nodeKind(scope) === N_MEMBER) {
    fail(at, "Cannot use 'arguments' in class field initializer");
    return true;
  }
  if (isInStaticBlock) {
    fail(at, "Cannot use arguments in class static initialization block");
    return true;
  }
  return false;
}

function keywordsAsNames(): void {
  for (let k = 0; k < argumentsIdents.len; k++) {
    const e = argumentsIdents.data[k] | 0;
    isReservedArguments((N_EXPR << 26) | e, exprStart(e));
  }
  const hir$ = hir;
  const np = hir$.nPats | 0;
  for (let i = 0; i < np; i++) {
    if ((hir$.patTag[i] | 0) !== PAT_IDENT) continue;
    const name = hir$.patA[i] | 0;
    if (name !== A_arguments && name !== A_let) continue;
    if (!patInTree(i)) continue;
    keywordAsBinding((4 << 26) | i, hir$.patPos[i] | 0, name);
  }
  const nf = hir$.nFns | 0;
  for (let i = 0; i < nf; i++) {
    const name = hir$.fnName[i] | 0;
    if (name !== A_arguments || !funcInTree(i)) continue;
    const kind = hir$.fnKind[i] | 0;
    // The name of a method is not a binding.
    if (kind === FN_DECL || kind === FN_EXPR) isReservedArguments((N_FUNC << 26) | i, hir$.fnNamePos[i] | 0);
  }
  const nc = hir$.nClasses | 0;
  for (let i = 0; i < nc; i++) {
    if ((hir$.className[i] | 0) !== A_arguments || !classInTree(i)) continue;
    isReservedArguments((N_CLASS << 26) | i, hir$.classNamePos[i] | 0);
  }
}

function patInTree(i: number): boolean {
  if ((hir.patTag[i] | 0) === PAT_MISSING) return false;
  return (bound.patParentTag[i] | 0) !== 0;
}

function keywordAsBinding(node: number, at: number, name: number): void {
  if (name === A_arguments) {
    isReservedArguments(node, at);
    return;
  }
  // `let`: a binding of a lexical declaration.
  let up = nodeParent(node);
  let isLexical = false;
  const hir$ = hir;
  for (;;) {
    const k = nodeKind(up);
    if (k === N_VAR_DECL) {
      isLexical = (hir$.varDeclKind[nodeId(up)] | 0) !== VAR_VAR_;
      break;
    }
    if (k === N_PARAM || k === N_FUNC) {
      isLexical = false;
      break;
    }
    if (k === N_FILE) break;
    up = nodeParent(up);
  }
  if (isLexical) fail(at, "let is disallowed as a lexically bound name");
}

const VAR_VAR_ = 0;

// ───────────────────────────── what is assigned to ─────────────────────────────

function isPlainTarget(target: number): boolean {
  const hir$ = hir;
  const t = hir$.exprTag[target] | 0;
  if (t === EXPR_IDENT) return true;
  if (t === EXPR_DOT || t === EXPR_INDEX) return (hir$.exprAux[target] | 0) === CHAIN_NO;
  return false;
}

/** `checkLValSimple` */
function checkSimpleTarget(target: number): void {
  const start = exprStart(target);
  const t = hir.exprTag[target] | 0;
  if (t === EXPR_IDENT) return;
  const inChain = exprIsInOptionalChain(target);
  if ((t === EXPR_DOT || t === EXPR_INDEX) && !inChain) return;
  if (inChain) fail(start, "Optional chaining cannot appear in left-hand side");
  else fail(start, "Assigning to rvalue");
}

function nextIsCommaAfterRest(end: number): void {
  const comma = nextIs(end, 44);
  if (comma >= 0) {
    // Babel recovers from a comma that nothing follows.
    const next = byte(afterToken(comma));
    if (!(next === 93 || next === 125 || next === 41)) fail(comma, "Comma is not permitted after the rest element");
  }
}

/** `toAssignable` */
function toAssignable(target: number, depth: number): void {
  if (depth > 5000) return;
  const hir$ = hir;
  const t = hir$.exprTag[target] | 0;
  const isSimple = t === EXPR_IDENT || t === EXPR_DOT || t === EXPR_INDEX;
  const parenthesized = fileIsParenthesized(target);
  if ((t === EXPR_OBJECT || t === EXPR_ARRAY) && parenthesized) {
    fail(outerStart(target), "Assigning to rvalue");
    return;
  }
  if (depth > 0 && !isSimple && parenthesized) {
    fail(outerStart(target), "Assigning to rvalue");
    return;
  }
  if (t === EXPR_ASSIGN && depth === 0) {
    fail(exprStart(target), "Assigning to rvalue");
    return;
  }
  if (t === EXPR_OBJECT) {
    const start = hir$.exprA[target] | 0;
    const count = hir$.exprB[target] | 0;
    for (let i = 0; i < count; i++) {
      const prop = hir$.ids[(start + i) | 0] | 0;
      const value = hir$.propValue[prop] | 0;
      if (value < 0) continue;
      const kind = hir$.propKind[prop] | 0;
      if (kind === PROP_GETTER || kind === PROP_SETTER) {
        let key: number;
        if (keySpan((12 << 26) | prop)) key = SP[0] | 0;
        else {
          propSpan(prop);
          key = SP[0] | 0;
        }
        fail(key, "Object pattern can't contain getter or setter");
      } else if (kind === PROP_METHOD) {
        const f = propFuncOf(prop);
        let at: number;
        if (f >= 0) {
          funcSpanFromParams(f);
          at = SP[0] | 0;
        } else at = exprStart(value);
        fail(at, "Assigning to rvalue");
      } else if (kind === PROP_SPREAD) {
        toAssignable(value, depth + 1);
        // (A pattern after `...` is an unexpected token: no word of Babel's.)
      } else {
        toAssignable(value, depth + 1);
      }
    }
  } else if (t === EXPR_ARRAY) {
    const start = hir$.exprA[target] | 0;
    const count = hir$.exprB[target] | 0;
    for (let i = 0; i < count; i++) {
      const element = hir$.ids[(start + i) | 0] | 0;
      if ((hir$.exprTag[element] | 0) === EXPR_MISSING) continue;
      toAssignable(element, depth + 1);
    }
  } else if (t === EXPR_SPREAD) {
    const argument = hir$.exprA[target] | 0;
    toAssignable(argument, depth + 1);
    if ((hir$.exprTag[argument] | 0) === EXPR_ASSIGN) fail(exprStart(argument), "Rest elements cannot have a default value");
    // Babel recovers from a comma after it in what it has parsed as an expression.
  } else if (t === EXPR_ASSIGN) {
    toAssignable(hir$.exprA[target] | 0, depth + 1);
  } else {
    checkSimpleTarget(target);
  }
}

function propFuncOf(prop: number): number {
  const hir$ = hir;
  const v = hir$.propValue[prop] | 0;
  return v >= 0 && (hir$.exprTag[v] | 0) === EXPR_FN ? hir$.exprA[v] | 0 : -1;
}

function assignmentTargets(): void {
  const hir$ = hir;
  for (let k = 0; k < assigns.len; k++) {
    const it = assigns.data[k] | 0;
    const target = hir$.exprA[it] | 0;
    const op = hir$.exprAux[it] | 0;
    // A default in a pattern is looked at with the pattern.
    if (isPlainTarget(target) || exprIsAssignmentTarget(it)) continue;
    const saved = noticed;
    noticed = outerEnd(target);
    // `a?.b = c` is a proposal that Prettier has Babel accept.
    if (exprIsInOptionalChain(target)) {
      // nothing
    } else if (op === 0) {
      toAssignable(target, 0);
    } else {
      checkSimpleTarget(target);
    }
    noticed = saved;
  }
  for (let k = 0; k < unaries.len; k++) {
    const it = unaries.data[k] | 0;
    const op = hir$.exprAux[it] | 0;
    if (!(op === UN_PRE_INC || op === UN_PRE_DEC || op === UN_POST_INC || op === UN_POST_DEC)) continue;
    const operand = hir$.exprA[it] | 0;
    if (isPlainTarget(operand)) continue;
    const saved = noticed;
    noticed = outerEnd(operand);
    checkSimpleTarget(operand);
    noticed = saved;
  }
  forLoops(STMT_FOR_IN);
  forLoops(STMT_FOR_OF);
}

function forLoops(tag: number): void {
  const hir$ = hir;
  const n = hir$.nStmts | 0;
  for (let i = 0; i < n; i++) {
    if ((hir$.stmtTag[i] | 0) !== tag || !stmtInTree(i)) continue;
    const left = hir$.stmtA[i] | 0;
    if (left < 0 || (hir$.stmtTag[left] | 0) !== STMT_EXPR) continue;
    const target = hir$.stmtA[left] | 0;
    const saved = noticed;
    noticed = outerEnd(target);
    toAssignable(target, 0);
    noticed = saved;
  }
}

/** `...a` in a pattern that declares, and as a parameter. */
function restElements(): void {
  const rest = (def: number, end: number): void => {
    if (def >= 0) {
      const equals = beforeToken(outerStart(def));
      fail(equals, "Rest elements cannot have a default value");
    }
    nextIsCommaAfterRest(end);
  };
  const hir$ = hir;
  const ne = hir$.nPatElems | 0;
  for (let i = 0; i < ne; i++) {
    if ((hir$.patElemIsRest[i] | 0) === 0) continue;
    const pat = hir$.patElemPat[i] | 0;
    if (pat < 0 || !patInTree(pat)) continue;
    // acorn parses the parameters of an arrow function as an expression first.
    let arrow = -1;
    let isParameter = false;
    let foundParam = false;
    let up = nodeParent((6 << 26) | i);
    // The first function above is the arrow; the first parameter or function above says whether it is a parameter.
    for (let guard = 0; guard < 100000; guard++) {
      const k = nodeKind(up);
      if (k === N_FILE) break;
      if (k === N_FUNC) {
        if (arrow < 0 && (hir$.fnKind[nodeId(up)] | 0) === FN_ARROW) arrow = nodeId(up);
        if (!foundParam) {
          foundParam = true;
          isParameter = false;
        }
        break;
      }
      if (k === N_PARAM && !foundParam) {
        foundParam = true;
        isParameter = true;
      }
      up = nodeParent(up);
    }
    const def = hir$.patElemDefault[i] | 0;
    if (arrow >= 0 && isParameter && def >= 0) {
      let noticedAt = hir$.patElemEnd[i] | 0;
      if (funcArrowSpan(arrow)) noticedAt = SP[0] | 0;
      const saved = noticed;
      noticed = noticedAt;
      fail(hir$.patPos[pat] | 0, "Rest elements cannot have a default value");
      noticed = saved;
    } else if (arrow >= 0 && isParameter) {
      // Babel recovers from what is wrong with `...` in the parameters of an arrow function.
    } else {
      rest(def, hir$.patElemEnd[i] | 0);
    }
  }
  const np = hir$.nPatProps | 0;
  for (let i = 0; i < np; i++) {
    if ((hir$.patPropIsRest[i] | 0) === 0) continue;
    const value = hir$.patPropValue[i] | 0;
    if (value < 0 || !patInTree(value)) continue;
    rest(hir$.patPropDefault[i] | 0, hir$.patPropEnd[i] | 0);
  }
  const nparam = hir$.nParams | 0;
  const bound$ = bound;
  for (let i = 0; i < nparam; i++) {
    if (((hir$.paramFlags[i] | 0) & FLAG_REST) === 0) continue;
    if ((bound$.paramFn[i] | 0) < 0) continue;
    paramSpan(i);
    rest(hir$.paramDefault[i] | 0, SP[1] | 0);
  }
}

// ───────────────────────────── declarations ─────────────────────────────

function declarations(): void {
  const hir$ = hir;
  const n = hir$.nStmts | 0;
  for (let i = 0; i < n; i++) {
    if ((hir$.stmtTag[i] | 0) !== STMT_VAR || !stmtInTree(i)) continue;
    const len = hir$.stmtB[i] | 0;
    if (len === 0) continue;
    const first = hir$.ids[hir$.stmtA[i] | 0] | 0;
    const kind = hir$.varDeclKind[first] | 0;
    if (kind === VAR_USING || kind === VAR_AWAIT_USING) usingDeclaration(i);
  }
}

/** `allowUsing`, and what `using` can declare. */
function usingDeclaration(it: number): void {
  const hir$ = hir;
  const start = hir$.stmtStart[it] | 0;
  const bound$ = bound;
  const parentTag = bound$.stmtParentTag[it] | 0;
  const parent = bound$.stmtParentA[it] | 0;
  const node = nodeParent((N_STMT << 26) | it);
  const isAtTopOfScript = nodeKind(node) === N_FILE && isScriptSource;
  if (isAtTopOfScript || nodeKind(node) === N_CASE) {
    fail(start, "Using declaration cannot appear in the top level when source type is `script` or in the bare case statement");
  }
  void parentTag;
  void parent;
  if (nodeKind(node) === N_STMT && (hir$.stmtTag[nodeId(node)] | 0) === STMT_FOR_IN && (hir$.stmtA[nodeId(node)] | 0) === it) {
    fail(skipTrivia(hir$.text, hir$.sourceLen | 0, hir$.stmtLocEnd[it] | 0), "Using declaration is not allowed in for-in loops");
  }
  const listStart = hir$.stmtA[it] | 0;
  const listLen = hir$.stmtB[it] | 0;
  for (let k = 0; k < listLen; k++) {
    const d = hir$.ids[(listStart + k) | 0] | 0;
    const pat = hir$.varDeclPat[d] | 0;
    if (pat >= 0 && (hir$.patTag[pat] | 0) !== PAT_IDENT) fail(hir$.patPos[pat] | 0, "Using declaration cannot have destructuring patterns");
  }
}

/** `parseStatement` with a `context`: what cannot be the body of an `if`, a loop, a `with` or a label. */
function statementPositions(): void {
  const hir$ = hir;
  const n = hir$.nStmts | 0;
  const bound$ = bound;
  for (let i = 0; i < n; i++) {
    const tag = hir$.stmtTag[i] | 0;
    if (tag !== STMT_VAR && tag !== STMT_FN && tag !== STMT_CLASS) continue;
    if (!stmtInTree(i)) continue;
    if ((bound$.stmtParentTag[i] | 0) !== P_STMT) continue;
    const parent = bound$.stmtParentA[i] | 0;
    if (parent < 0 || parent >= hir$.nStmts) continue;
    const pt = hir$.stmtTag[parent] | 0;
    let isBody = false;
    if (stmtIsWith(parent)) isBody = stmtWithBody(parent) === i;
    else if (pt === STMT_IF) isBody = (hir$.stmtB[parent] | 0) === i || (hir$.stmtC[parent] | 0) === i;
    else if (pt === STMT_FOR) isBody = (hir$.stmtD[parent] | 0) === i;
    else if (pt === STMT_FOR_IN || pt === STMT_FOR_OF) isBody = (hir$.stmtC[parent] | 0) === i;
    else if (pt === STMT_WHILE) isBody = (hir$.stmtB[parent] | 0) === i;
    else if (pt === STMT_DO_WHILE) isBody = (hir$.stmtA[parent] | 0) === i;
    else if (pt === STMT_LABELED) isBody = (hir$.stmtB[parent] | 0) === i;
    if (isBody) declarationAsBody(i, tag);
  }
}

function declarationAsBody(it: number, tag: number): void {
  const hir$ = hir;
  const start = hir$.stmtStart[it] | 0;
  let isLexical = false;
  if (tag === STMT_VAR) {
    if ((hir$.stmtB[it] | 0) > 0) {
      const k = hir$.varDeclKind[hir$.ids[hir$.stmtA[it] | 0] | 0] | 0;
      isLexical = k === VAR_LET || k === VAR_CONST;
    }
  } else if (tag === STMT_CLASS) isLexical = true;
  if (isLexical) {
    fail(start, "Lexical declaration cannot appear in a single-statement context");
    return;
  }
  // Where else a function cannot be is an error of strict mode for it, or one of sloppy mode.
  if (tag === STMT_FN) {
    const f = hir$.stmtA[it] | 0;
    if (f >= 0 && ((hir$.fnFlags[f] | 0) & FLAG_ASYNC) !== 0) fail(start, "Async functions can only be declared at the top level or inside a block");
  }
}

// ───────────────────────────── expressions ─────────────────────────────

/** `isPrivateFieldAccess` */
function deletedPrivateFields(): void {
  const hir$ = hir;
  for (let k = 0; k < unaries.len; k++) {
    const it = unaries.data[k] | 0;
    if ((hir$.exprAux[it] | 0) !== UN_DELETE) continue;
    const operand = hir$.exprA[it] | 0;
    if ((hir$.exprTag[operand] | 0) !== EXPR_DOT) continue;
    if (byte(hir$.exprC[operand] | 0) !== 35) continue;
    // Babel does not look into parentheses, which Prettier has it keep.
    if (fileIsParenthesized(operand)) continue;
    const saved = noticed;
    noticed = exprEnd(it);
    fail(exprStart(it), "Private fields can not be deleted");
    noticed = saved;
  }
}

/** `import.meta` and `new.target` are all that acorn knows. */
function metaProperties(): void {
  const ofImport = "The only valid meta property for import is 'import.meta'";
  const ofNew = "The only valid meta property for new is 'new.target'";
  for (let k = 0; k < importCalls.len; k++) {
    const it = importCalls.data[k] | 0;
    const name = afterToken(afterToken(exprStart(it)));
    // Proposals that Prettier has Babel accept, as they are written in the proposal.
    const t = tokenAt(name);
    if (exprImportCallPhase(it) !== 0 && t !== "defer" && t !== "source") fail(name, ofImport);
  }
  // `import defer * as a from "a"`: `defer` is the name of the default import.
  const hir$ = hir;
  const ni = hir$.nImports | 0;
  for (let i = 0; i < ni; i++) {
    if ((hir$.importIsDeferred[i] | 0) === 0) continue;
    // `import defer * as a from "a"`, `import source a from "a"`
    const hasDefault = (hir$.importDefault[i] | 0) >= 0;
    const hasNamespace = (hir$.importNamespace[i] | 0) >= 0;
    const clause = hir$.importClauseStart[i] | 0;
    const isValid = tokenAt(clause) === "source" ? hasDefault && !hasNamespace : hasNamespace && !hasDefault;
    if (!isValid || (hir$.importHasNamedImports[i] | 0) !== 0) fail(clause, "Only `import defer * as x` is valid");
  }
  const nd = hir$.diagnosticsLen | 0;
  for (let row = 0; row < nd; row += 5) {
    if ((hir$.diagnostics[row] | 0) !== DK_GRAMMAR) continue;
    const code = hir$.diagnostics[row + 3] | 0;
    const start = hir$.diagnostics[row + 1] | 0;
    let name: number;
    if (code === 17012 || code === 18061) name = start;
    else if (code === 1005) {
      const id = hir$.diagnostics[row + 4] | 0;
      if (id < 0 || hir$.diagArgs[id].length === 0 || hir$.diagArgs[id][0] !== "(") continue;
      name = beforeToken(start);
    } else continue;
    const keyword = beforeToken(beforeToken(name));
    const word = tokenAt(keyword);
    if (word === "import") fail(name, ofImport);
    else if (word === "new") fail(name, ofNew);
  }
  // `new.target`
  for (let k = 0; k < newTargets.len; k++) {
    const it = newTargets.data[k] | 0;
    // acorn throws the first of its three complaints about one `new.target`, wherever the others are.
    const name = afterToken(afterToken(exprStart(it)));
    const isTarget = atomIs(hir$.exprA[it] | 0, "target");
    if (!isTarget || tokenAt(name) !== "target") fail(name, ofNew);
  }
}

function atomIs(atom: number, text: string): boolean {
  return names.atomIs(atom, text);
}

/** `validateRegExpFlags` */
function regularExpressions(): void {
  for (let k = 0; k < regexes.len; k++) {
    const it = regexes.data[k] | 0;
    exprRegexFlagsSpan(it);
    const fs = SP[0] | 0;
    const fe = SP[1] | 0;
    const at = ((exprStart(it) | 0) + 1) | 0;
    let invalid = false;
    let duplicate = false;
    let hasU = false;
    let hasV = false;
    for (let i = fs; i < fe; i++) {
      const c = byte(i);
      // `dgimsuvy`
      if (!(c === 100 || c === 103 || c === 105 || c === 109 || c === 115 || c === 117 || c === 118 || c === 121)) invalid = true;
      if (c === 117) hasU = true;
      if (c === 118) hasV = true;
      for (let j = i + 1; j < fe; j++) if (byte(j) === c) duplicate = true;
    }
    if (invalid) fail(at, "Invalid regular expression flag");
    else if (duplicate) fail(at, "Duplicate regular expression flag");
    else if (hasU && hasV) fail(at, "Invalid regular expression flag");
  }
}

/** `??` beside `&&` or `||`, a template after an optional chain. */
function operators(): void {
  const hir$ = hir;
  for (let k = 0; k < binaries.len; k++) {
    const it = binaries.data[k] | 0;
    const op = hir$.exprAux[it] | 0;
    if (!(op === BIN_NULLISH || op === BIN_AND || op === BIN_OR)) continue;
    const left = hir$.exprA[it] | 0;
    const right = hir$.exprB[it] | 0;
    const isMixed = (operand: number): boolean => {
      const hir$ = hir;
      if ((hir$.exprTag[operand] | 0) !== EXPR_BINARY || fileIsParenthesized(operand)) return false;
      const inner = hir$.exprAux[operand] | 0;
      return (op === BIN_NULLISH) !== (inner === BIN_NULLISH) && (inner === BIN_NULLISH || inner === BIN_AND || inner === BIN_OR);
    };
    // It is noticed at the second operator.
    if (isMixed(left)) {
      if (exprOperatorSpan(it)) fail(SP[0] | 0, "Logical expressions and coalesce expressions cannot be mixed. Wrap either by parentheses");
    } else if (isMixed(right)) {
      if (exprOperatorSpan(right)) fail(SP[0] | 0, "Logical expressions and coalesce expressions cannot be mixed. Wrap either by parentheses");
    }
  }
  for (let k = 0; k < taggedTemplates.len; k++) {
    const it = taggedTemplates.data[k] | 0;
    const call = hir$.exprA[it] | 0;
    const tag = hir$.callCallee[call] | 0;
    const afterTag = skipTrivia(hir$.text, hir$.sourceLen | 0, outerEnd(tag));
    if (tokenAt(afterTag) === "?.") {
      fail(afterToken(afterTag), "Optional chaining cannot appear in the tag of tagged template expressions");
    } else if (exprIsInOptionalChain(tag) && !fileIsParenthesized(tag)) {
      fail(afterTag, "Optional chaining cannot appear in the tag of tagged template expressions");
    }
  }
}

/** `parseDynamicImport` */
function dynamicImports(): void {
  const hir$ = hir;
  for (let k = 0; k < importCalls.len; k++) {
    const it = importCalls.data[k] | 0;
    const start = exprStart(it);
    // Not after `new`, which acorn-jsx forgets.
    if (!fileIsParenthesized(it)) {
      const parent = exprParent(it);
      if (nodeKind(parent) === N_EXPR) {
        const pe = nodeId(parent);
        if ((hir$.exprTag[pe] | 0) === EXPR_NEW && (hir$.callCallee[hir$.exprA[pe] | 0] | 0) === it) fail(start, "Cannot use new with import");
      }
    }
    const argsStart = hir$.exprA[it] | 0;
    const argsLen = hir$.exprB[it] | 0;
    let written = 0;
    let firstTwoSpread = -1;
    for (let i = 0; i < argsLen; i++) {
      const a = hir$.ids[(argsStart + i) | 0] | 0;
      if ((hir$.exprTag[a] | 0) === EXPR_MISSING) continue;
      if (written < 2 && (hir$.exprTag[a] | 0) === EXPR_SPREAD && firstTwoSpread < 0) firstTwoSpread = a;
      written = (written + 1) | 0;
    }
    if (written !== 1 && written !== 2) fail(start, "`import()` requires exactly one or two arguments");
    if (firstTwoSpread >= 0) fail(exprStart(firstTwoSpread), "`...` is not allowed in `import()`");
  }
}

function switchesAndThrows(): void {
  const hir$ = hir;
  const n = hir$.nStmts | 0;
  for (let i = 0; i < n; i++) {
    const tag = hir$.stmtTag[i] | 0;
    if (tag === STMT_SWITCH) {
      if (!stmtInTree(i)) continue;
      const cases = hir$.stmtB[i] | 0;
      const count = hir$.stmtC[i] | 0;
      let defaults = 0;
      for (let k = 0; k < count; k++) {
        const c = hir$.ids[(cases + k) | 0] | 0;
        if ((hir$.caseTest[c] | 0) < 0) {
          defaults = (defaults + 1) | 0;
          if (defaults === 2) fail(hir$.casePos[c] | 0, "Multiple default clauses");
        }
      }
    } else if (tag === STMT_THROW) {
      if (!stmtInTree(i)) continue;
      const thrown = hir$.stmtA[i] | 0;
      if (thrown < 0 || thrown >= hir$.nExprs || (hir$.exprTag[thrown] | 0) === EXPR_MISSING) fail(((hir$.stmtStart[i] | 0) + 5) | 0, "Illegal newline after throw");
    }
  }
}

// ───────────────────────────── functions ─────────────────────────────

function mentions(text_: string): boolean {
  const n = text_.length;
  const hir$ = hir;
  const len = hir$.sourceLen | 0;
  const t = hir$.text;
  const first = text_.charCodeAt(0);
  outer: for (let i = 0; i + n <= len; i++) {
    if ((t[i] | 0) !== first) continue;
    for (let j = 1; j < n; j++) if ((t[(i + j) | 0] | 0) !== text_.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

function functions(mayHaveDirective: boolean): void {
  const hir$ = hir;
  const n = hir$.nFns | 0;
  for (let i = 0; i < n; i++) {
    const kind = hir$.fnKind[i] | 0;
    if (!mayHaveDirective && kind !== FN_GETTER && kind !== FN_SETTER) continue;
    if (!funcInTree(i)) continue;
    const paramsStart = hir$.fnParamsStart[i] | 0;
    const paramsLen = hir$.fnParamsLen[i] | 0;
    let wrongAt = -1;
    let wrongMessage = "";
    if (kind === FN_GETTER && paramsLen !== 0) {
      funcSpanFromParams(i);
      wrongAt = SP[0] | 0;
      wrongMessage = "getter should have no params";
    } else if (kind === FN_SETTER && paramsLen !== 1) {
      funcSpanFromParams(i);
      wrongAt = SP[0] | 0;
      wrongMessage = "setter should have exactly one param";
    } else if (kind === FN_SETTER) {
      const first = hir$.ids[paramsStart] | 0;
      if (((hir$.paramFlags[first] | 0) & FLAG_REST) !== 0) {
        paramSpan(first);
        wrongAt = SP[0] | 0;
        wrongMessage = "Setter cannot use rest params";
      }
    }
    if (wrongAt >= 0) {
      funcSpan(i);
      const saved = noticed;
      noticed = SP[1] | 0;
      fail(wrongAt, wrongMessage);
      noticed = saved;
    }
    // An error since ES2016.
    let allSimple = true;
    for (let k = 0; k < paramsLen; k++) {
      const p = hir$.ids[(paramsStart + k) | 0] | 0;
      const pat = hir$.paramPat[p] | 0;
      const isSimple = (hir$.paramDefault[p] | 0) < 0 && ((hir$.paramFlags[p] | 0) & FLAG_REST) === 0 && pat >= 0 && (hir$.patTag[pat] | 0) === PAT_IDENT;
      if (!isSimple) {
        allSimple = false;
        break;
      }
    }
    if (allSimple) continue;
    if ((hir$.fnBodyKind[i] | 0) !== BODY_BLOCK) continue;
    const bodyStart = hir$.fnBodyA[i] | 0;
    const bodyLen = hir$.fnBodyB[i] | 0;
    let hasDirective = false;
    for (let k = 0; k < bodyLen; k++) {
      const st = hir$.ids[(bodyStart + k) | 0] | 0;
      if (!stmtDirectiveSpan(st)) break;
      if (SP[1] - SP[0] === 10 && sliceText(SP[0] | 0, SP[1] | 0) === "use strict") {
        hasDirective = true;
        break;
      }
    }
    if (hasDirective) {
      // `body_span().start`: the `{`.
      const body = funcBodySpan(i) ? SP[0] | 0 : 0;
      const saved = noticed;
      noticed = body;
      funcEstreeSpan(i);
      fail(SP[0] | 0, "Illegal 'use strict' directive in function with non-simple parameter list");
      noticed = saved;
    }
  }
}

/** `checkYieldAwaitInDefaultParams` */
function defaultsThatSuspend(): void {
  for (let pass = 0; pass < 2; pass++) {
    const list = pass === 0 ? yields : awaitExprs;
    for (let k = 0; k < list.len; k++) {
      const it = list.data[k] | 0;
      // The first parameter or function above.
      let up = nodeParent((N_EXPR << 26) | it);
      let isParam = false;
      for (let guard = 0; guard < 1000000; guard++) {
        const kind = nodeKind(up);
        if (kind === N_FILE) break;
        if (kind === N_PARAM) {
          isParam = true;
          break;
        }
        if (kind === N_FUNC) break;
        up = nodeParent(up);
      }
      if (!isParam) continue;
      fail(exprStart(it), pass === 0 ? "Yield expression cannot be a default value" : "Await expression cannot be a default value");
    }
  }
}

function supersCheck(): void {
  const hir$ = hir;
  for (let k = 0; k < supers.len; k++) {
    const it = supers.data[k] | 0;
    const start = exprStart(it);
    const scope = thisScope((N_EXPR << 26) | it);
    let allowsSuper: boolean;
    if (scope < 0) allowsSuper = false;
    else if (nodeKind(scope) === N_FUNC) {
      const fk = hir$.fnKind[nodeId(scope)] | 0;
      allowsSuper = fk === FN_METHOD || fk === FN_GETTER || fk === FN_SETTER || fk === FN_CONSTRUCTOR || fk === FN_STATIC_BLOCK;
    } else allowsSuper = true;
    if (!allowsSuper) {
      // At the top level Prettier has Babel allow it.
      if (scope >= 0) fail(start, "super() call outside constructor of a subclass");
      continue;
    }
    let isCalled = false;
    const parent = exprParent((N_EXPR << 26) | it);
    void parent;
    const pn = exprParent(it);
    if (nodeKind(pn) === N_EXPR) {
      const pe = nodeId(pn);
      if ((hir$.exprTag[pe] | 0) === EXPR_CALL && (hir$.callCallee[hir$.exprA[pe] | 0] | 0) === it) isCalled = true;
    }
    let inConstructorOfSubclass = false;
    if (scope >= 0 && nodeKind(scope) === N_FUNC && (hir$.fnKind[nodeId(scope)] | 0) === FN_CONSTRUCTOR) {
      const owner = funcOwner(nodeId(scope));
      if (nodeKind(owner) === N_MEMBER) {
        const m = nodeId(owner);
        if (memberIsConstructor(m)) {
          const mp = nodeParent(owner);
          inConstructorOfSubclass = nodeKind(mp) === N_CLASS && classExtends(nodeId(mp)) >= 0;
        }
      }
    }
    if (isCalled && !inConstructorOfSubclass) fail(start, "super() call outside constructor of a subclass");
  }
}

// ───────────────────────────── classes ─────────────────────────────

/** A `#a` has to be declared by a class around it: only `super.#a` has Babel's words. */
function privateNames(): void {
  const hir$ = hir;
  for (let k = 0; k < dots.len; k++) {
    const it = dots.data[k] | 0;
    if (byte(hir$.exprC[it] | 0) !== 35) continue;
    const obj = hir$.exprA[it] | 0;
    if ((hir$.exprTag[obj] | 0) === EXPR_SUPER) fail(hir$.exprC[it] | 0, "Private fields can't be accessed on super");
  }
}

function classes(): void {
  const hir$ = hir;
  const nc = hir$.nClasses | 0;
  for (let c = 0; c < nc; c++) {
    if (!classInTree(c)) continue;
    const membersStart = hir$.classMembersStart[c] | 0;
    const membersLen = hir$.classMembersLen[c] | 0;
    if (membersLen === 0) continue;
    let hasConstructor = false;
    // The private names of the class so far, each with the accessor that another can complete.
    const privNames: string[] = [];
    const privHalf: number[] = [];
    for (let k = 0; k < membersLen; k++) {
      const m = hir$.ids[(membersStart + k) | 0] | 0;
      classElement(m);
      const f = hir$.memberFunc[m] | 0;
      const hasBody = f >= 0 && f < hir$.nFns && (hir$.fnBodyKind[f] | 0) !== 0;
      if (memberIsConstructor(m) && hasBody) {
        if (hasConstructor) fail(hir$.memberStart[m] | 0, "Duplicate constructor in the same class");
        hasConstructor = true;
      }
      const loaded = keyLoad((N_MEMBER << 26) | m);
      if (loaded !== KEY_PRIVATE) continue;
      // An overload in TypeScript: `#m(): void; #m() {}`.
      if (f >= 0 && f < hir$.nFns && (hir$.fnBodyKind[f] | 0) === 0) continue;
      const name = atomText(KEY[KEY_NAME] | 0);
      const mk = hir$.memberKind[m] | 0;
      const half = mk === MEMBER_GETTER || mk === MEMBER_SETTER ? (memberIsStatic(m) ? 2 : 0) | (mk === MEMBER_GETTER ? 4 : 8) : 0;
      let seen = -1;
      for (let j = 0; j < privNames.length; j++) {
        if (privNames[j] === name) {
          seen = j;
          break;
        }
      }
      if (seen < 0) {
        privNames.push(name);
        privHalf.push(half);
      } else {
        const a = privHalf[seen];
        const completes = a !== 0 && half !== 0 && (a & 2) === (half & 2) && (a & 12) !== (half & 12);
        privHalf[seen] = 0;
        if (!completes) {
          keySpan((N_MEMBER << 26) | m);
          fail(SP[0] | 0, "Identifier '" + name + "' has already been declared");
        }
      }
    }
  }
}

function classElement(member: number): void {
  const hir$ = hir;
  const mk = hir$.memberKind[member] | 0;
  const f = hir$.memberFunc[member] | 0;
  const loaded = keyLoad((N_MEMBER << 26) | member);
  if (loaded < 0) {
    // A constructor.
    const keyword = memberConstructorKeyword(member);
    if (keyword < 0 || f < 0) return;
    const at = hir$.memberNamePos[member] | 0;
    const flags = hir$.fnFlags[f] | 0;
    if (memberIsConstructor(member) && (flags & FLAG_GENERATOR) !== 0) fail(at, "Constructor can't be a generator");
    else if (memberIsConstructor(member) && (flags & FLAG_ASYNC) !== 0) fail(at, "Constructor can't be an async method");
    return;
  }
  keySpan((N_MEMBER << 26) | member);
  const start = SP[0] | 0;
  const keyKind = KEY[0] | 0;
  const keyName = KEY[KEY_NAME] | 0;
  const isNamed = (name: string): boolean => (keyKind === KEY_IDENT || keyKind === KEY_STRING) && names.atomIs(keyName, name);
  const isField = mk === MEMBER_PROPERTY;
  const isStatic = memberIsStatic(member);
  if (keyKind === KEY_PRIVATE && names.atomIs(keyName, "#constructor")) {
    fail(start, "Classes can't have an element named '#constructor'");
  } else if (isField && isNamed("constructor")) {
    fail(start, "Classes can't have a field named 'constructor'");
  } else if (isField && isStatic && isNamed("prototype")) {
    fail(start, "Classes can't have a static field named 'prototype'");
  } else if (!isField && isStatic && isNamed("prototype")) {
    fail(start, "Classes may not have a static property named prototype");
  } else if (isStatic || !isNamed("constructor")) {
    // Not a constructor.
  } else if (mk === MEMBER_GETTER || mk === MEMBER_SETTER) {
    fail(start, "Constructor can't have get/set modifier");
  } else if (f >= 0 && ((hir$.fnFlags[f] | 0) & FLAG_GENERATOR) !== 0) {
    fail(start, "Constructor can't be a generator");
  } else if (f >= 0 && ((hir$.fnFlags[f] | 0) & FLAG_ASYNC) !== 0) {
    fail(start, "Constructor can't be an async method");
  }
}

// ───────────────────────────── more about expressions ─────────────────────────────

/** No line break before `=>`. */
function arrows(): void {
  const hir$ = hir;
  const n = hir$.nFns | 0;
  for (let i = 0; i < n; i++) {
    if ((hir$.fnKind[i] | 0) !== FN_ARROW || !funcInTree(i)) continue;
    if (!funcArrowSpan(i)) continue;
    const arrow = SP[0] | 0;
    const before = fileEndOfTokenBefore(arrow);
    let hasBreak = false;
    for (let k = before; k < arrow; k++) {
      const c = byte(k);
      if (c === 10 || c === 13) {
        hasBreak = true;
        break;
      }
    }
    if (hasBreak) fail(arrow, "No line break is allowed before '=>'");
  }
}

function hasName(text_: string): number {
  return names.findBytes(strBytes(text_), 0, text_.length);
}

function objectLiterals(proto: number): void {
  const hir$ = hir;
  const n = hir$.nProps | 0;
  const bound$ = bound;
  for (let i = 0; i < n; i++) {
    const kind = hir$.propKind[i] | 0;
    const value = hir$.propValue[i] | 0;
    const isDefault = kind === PROP_SHORTHAND && value >= 0 && value < hir$.nExprs && (hir$.exprTag[value] | 0) === EXPR_ASSIGN;
    const mayBeProto = kind === PROP_INIT && proto >= 0 && (hir$.propKeyKind[i] | 0) === PK_NAME && (hir$.propKeyVal[i] | 0) === proto;
    if (!isDefault && !mayBeProto) continue;
    const object = bound$.propOwner[i] | 0;
    if (object < 0 || !propInTree(i) || propIsJsxAttribute(i)) continue;
    // `{ a = 1 }` is a pattern only.
    if (isDefault && !exprIsAssignmentTarget(object)) {
      const target = hir$.exprA[value] | 0;
      const equals = skipTrivia(hir$.text, hir$.sourceLen | 0, exprEnd(target));
      const saved = noticed;
      noticed = outerEnd(object);
      fail(equals, "Shorthand property assignments are valid only in destructuring patterns");
      noticed = saved;
    }
    if (proto >= 0 && isProto(i, proto) && !exprIsAssignmentTarget(object)) {
      const propsStart = hir$.exprA[object] | 0;
      const propsLen = hir$.exprB[object] | 0;
      let first = -1;
      for (let k = 0; k < propsLen; k++) {
        const q = hir$.ids[(propsStart + k) | 0] | 0;
        if (q === i) break;
        if (isProto(q, proto)) {
          first = q;
          break;
        }
      }
      if (first >= 0) {
        const saved = noticed;
        noticed = outerEnd(object);
        fail(hir$.propPos[i] | 0, "Redefinition of __proto__ property");
        noticed = saved;
      }
    }
  }
}

function isProto(prop: number, proto: number): boolean {
  const hir$ = hir;
  return (hir$.propKind[prop] | 0) === PROP_INIT && (hir$.propKeyKind[prop] | 0) === PK_NAME && (hir$.propKeyVal[prop] | 0) === proto && (hir$.propNameKind[prop] | 0) !== NK_COMPUTED_STRING && (hir$.propNameKind[prop] | 0) !== NK_COMPUTED_NUMBER;
}

/** Whether the string that is written as `written` has half of a surrogate pair. It can only be written as an escape. */
function hasLoneSurrogate(written: string): boolean {
  let at = 0;
  let isAfterHigh = false;
  while (at < written.length) {
    const c = written.charCodeAt(at);
    let unit = -1;
    let len = 1;
    if (c === 92) {
      len = 2;
      if (written.charCodeAt(at + 1) === 117) {
        let digits: string;
        let rest = written.slice(at + 2);
        if (rest.charCodeAt(0) === 123) {
          const end = rest.indexOf("}");
          if (end < 0) return false;
          digits = rest.slice(1, end);
        } else {
          if (rest.length < 4) return false;
          digits = rest.slice(0, 4);
        }
        const v = parseInt(digits, 16);
        unit = Number.isNaN(v) ? -1 : v;
        len = 2 + digits.length + (rest.charCodeAt(0) === 123 ? 2 : 0);
        void rest;
        rest = "";
      }
    }
    const isLow = unit >= 0xdc00 && unit <= 0xdfff;
    if (isAfterHigh !== isLow) return true;
    isAfterHigh = unit >= 0xd800 && unit <= 0xdbff;
    at = (at + len) | 0;
  }
  return isAfterHigh;
}

/** `parseModuleExportName`: a name of an import or an export that is written as a string. */
function namesInQuotes(): void {
  if (!mentions("\\u")) return;
  const check = (atom: number, pos_: number): void => {
    if (!identIsString(pos_)) return;
    identSpan(atom, pos_);
    if (hasLoneSurrogate(sliceText(SP[0] | 0, SP[1] | 0))) fail(pos_, "An export name cannot include a lone surrogate.");
  };
  const hir$ = hir;
  const bodyStart = hir$.bodyStart | 0;
  const bodyLen = hir$.bodyLen | 0;
  for (let k = 0; k < bodyLen; k++) {
    const st = hir$.ids[(bodyStart + k) | 0] | 0;
    const tag = hir$.stmtTag[st] | 0;
    if (tag === STMT_IMPORT) {
      const imp = hir$.stmtA[st] | 0;
      const ns = hir$.importNamedStart[imp] | 0;
      const nl = hir$.importNamedLen[imp] | 0;
      for (let i = 0; i < nl; i++) {
        const sp = hir$.ids[(ns + i) | 0] | 0;
        check(hir$.importSpecImported[sp] | 0, hir$.importSpecImportedPos[sp] | 0);
      }
    } else if (tag === STMT_EXPORT_NAMED) {
      const ex = hir$.stmtA[st] | 0;
      const is_ = hir$.exportItemsStart[ex] | 0;
      const il = hir$.exportItemsLen[ex] | 0;
      for (let i = 0; i < il; i++) {
        const sp = hir$.ids[(is_ + i) | 0] | 0;
        check(hir$.exportSpecLocal[sp] | 0, hir$.exportSpecLocalPos[sp] | 0);
        check(hir$.exportSpecExported[sp] | 0, hir$.exportSpecPos[sp] | 0);
      }
    } else if (tag === STMT_EXPORT_STAR) {
      const alias = hir$.stmtB[st] | 0;
      if (alias >= 0) check(alias, hir$.stmtD[st] | 0);
    }
  }
}

/** `for (async of a)`: it could be the start of `for (async of => {};;)`. */
function asyncBeforeOf(): void {
  const hir$ = hir;
  const n = hir$.nStmts | 0;
  for (let i = 0; i < n; i++) {
    if ((hir$.stmtTag[i] | 0) !== STMT_FOR_OF || !stmtInTree(i)) continue;
    if ((hir$.stmtAux[i] | 0) !== 0) continue;
    const left = hir$.stmtA[i] | 0;
    if (left < 0 || (hir$.stmtTag[left] | 0) !== STMT_EXPR) continue;
    const target = hir$.stmtA[left] | 0;
    if ((hir$.exprTag[target] | 0) === EXPR_IDENT && !fileIsParenthesized(target) && tokenAt(exprStart(target)) === "async") {
      fail(exprStart(target), "The left-hand side of a for-of loop may not be 'async'.");
    }
  }
}

/** `<a>{b, c}</a>`, `<a b={c, d} />`, `<a {...b, c} />`, which acorn-jsx takes. */
function sequencesInJsx(): void {
  const isSequence = (e: number): boolean => e >= 0 && (hir.exprTag[e] | 0) === EXPR_BINARY && (hir.exprAux[e] | 0) === BIN_COMMA && !fileIsParenthesized(e);
  const message = "Sequence expressions cannot be directly nested inside JSX";
  const hir$ = hir;
  const n = hir$.nJsxExpressions | 0;
  for (let i = 0; i < n; i++) {
    const e = hir$.jsxExpressionExpr[i] | 0;
    if (isSequence(e)) fail(exprStart(e), message);
  }
  if ((hir$.nJsx | 0) === 0) return;
  const np = hir$.nProps | 0;
  for (let i = 0; i < np; i++) {
    if ((hir$.propKind[i] | 0) !== PROP_SPREAD || !propIsJsxAttribute(i)) continue;
    const v = hir$.propValue[i] | 0;
    if (isSequence(v)) fail(exprStart(v), message);
  }
}

/** `export @a default class {}` */
function decoratorsBeforeDefault(): void {
  const hir$ = hir;
  const bodyStart = hir$.bodyStart | 0;
  const bodyLen = hir$.bodyLen | 0;
  for (let k = 0; k < bodyLen; k++) {
    const st = hir$.ids[(bodyStart + k) | 0] | 0;
    let exportAt = -1;
    if ((hir$.stmtTag[st] | 0) === STMT_EXPORT_DEFAULT) exportAt = hir$.stmtStart[st] | 0;
    else if (stmtIsDefaultExport(st) && stmtExportSpan(st)) exportAt = SP[0] | 0;
    if (exportAt >= 0 && tokenAt(exportAt) === "export" && tokenAt(afterToken(exportAt)).startsWith("@")) {
      fail(exportAt, "Leading decorators must be attached to a class declaration");
    }
  }
}

/** `checkExport`, `checkLocalExport`: `export default` twice, a string literal as a local name without `from`. */
function exports_(): void {
  let firstDefault = -1;
  let secondDefault = -1;
  const note = (at: number): void => {
    // The second in the order of the source is the one.
    if (firstDefault < 0) firstDefault = at;
    else {
      // keep the two smallest
      let a = firstDefault;
      let b = at;
      if (b < a) {
        const t = a;
        a = b;
        b = t;
      }
      firstDefault = a;
      if (secondDefault < 0 || b < secondDefault) secondDefault = b;
    }
  };
  const hir$ = hir;
  const bodyStart = hir$.bodyStart | 0;
  const bodyLen = hir$.bodyLen | 0;
  const names$ = names;
  for (let k = 0; k < bodyLen; k++) {
    const st = hir$.ids[(bodyStart + k) | 0] | 0;
    const tag = hir$.stmtTag[st] | 0;
    if (tag === STMT_EXPORT_DEFAULT) {
      note(afterToken(hir$.stmtStart[st] | 0));
    } else if (tag === STMT_EXPORT_STAR) {
      const alias = hir$.stmtB[st] | 0;
      if (alias >= 0 && names$.atomIs(alias, "default")) note(hir$.stmtD[st] | 0);
    } else if (tag === STMT_EXPORT_NAMED) {
      const ex = hir$.stmtA[st] | 0;
      const items = hir$.exportItemsStart[ex] | 0;
      const count = hir$.exportItemsLen[ex] | 0;
      const hasFrom = (hir$.exportHasModuleSpecifier[ex] | 0) !== 0;
      for (let i = 0; i < count; i++) {
        const sp = hir$.ids[(items + i) | 0] | 0;
        if (names$.atomIs(hir$.exportSpecExported[sp] | 0, "default")) note(hir$.exportSpecPos[sp] | 0);
        if (hasFrom) continue;
        const localPos = hir$.exportSpecLocalPos[sp] | 0;
        if (identIsString(localPos)) {
          const saved = noticed;
          noticed = hir$.stmtLocEnd[st] | 0;
          fail(localPos, "A string literal cannot be used as an exported binding without `from`.");
          noticed = saved;
        }
      }
    } else if (stmtIsExported(st) && stmtIsDefaultExport(st)) {
      stmtExportSpan(st);
      note(afterToken(SP[0] | 0));
    }
  }
  if (secondDefault >= 0) fail(secondDefault, "Duplicate export 'default'");
}

// ───────────────────────────── `break`, `continue`, labels ─────────────────────────────

/** `parseBreakContinueStatement` */
function jumps(): void {
  const hir$ = hir;
  const n = hir$.nStmts | 0;
  for (let i = 0; i < n; i++) {
    const tag = hir$.stmtTag[i] | 0;
    if (tag !== STMT_BREAK && tag !== STMT_CONTINUE) continue;
    if (!stmtInTree(i)) continue;
    const isBreak = tag === STMT_BREAK;
    const label = hir$.stmtA[i] | 0;
    let hasTarget = false;
    let up = nodeParent((N_STMT << 26) | i);
    for (let guard = 0; guard < 1000000; guard++) {
      const k = nodeKind(up);
      if (k === N_FILE || k === N_FUNC) break;
      if (k === N_STMT) {
        const st = nodeId(up);
        const stag = hir$.stmtTag[st] | 0;
        if (stag === STMT_LABELED && label >= 0 && (hir$.stmtA[st] | 0) === label) {
          // `continue` wants a loop, under this label and others.
          let body = hir$.stmtB[st] | 0;
          while (body >= 0 && (hir$.stmtTag[body] | 0) === STMT_LABELED) body = hir$.stmtB[body] | 0;
          hasTarget = isBreak || (body >= 0 && stmtIsLoop(body));
        } else if (stag === STMT_SWITCH && label < 0) {
          hasTarget = isBreak;
        } else if (label < 0) {
          hasTarget = stmtIsLoop(st);
        } else hasTarget = false;
        if (hasTarget) break;
      }
      up = nodeParent(up);
    }
    if (!hasTarget) fail(hir$.stmtStart[i] | 0, isBreak ? "Unsyntactic break" : "Unsyntactic continue");
  }
}

function labels(): void {
  const hir$ = hir;
  const n = hir$.nStmts | 0;
  for (let i = 0; i < n; i++) {
    if ((hir$.stmtTag[i] | 0) !== STMT_LABELED || !stmtInTree(i)) continue;
    const label = hir$.stmtA[i] | 0;
    let up = nodeParent((N_STMT << 26) | i);
    let isRepeated = false;
    for (let guard = 0; guard < 1000000; guard++) {
      const k = nodeKind(up);
      if (k === N_FILE || k === N_FUNC) break;
      if (k === N_STMT) {
        const st = nodeId(up);
        if ((hir$.stmtTag[st] | 0) === STMT_LABELED && (hir$.stmtA[st] | 0) === label) {
          isRepeated = true;
          break;
        }
      }
      up = nodeParent(up);
    }
    if (isRepeated) fail(hir$.stmtStart[i] | 0, "Label '" + atomText(label) + "' is already declared");
  }
}

// ───────────────────────────── the entry ─────────────────────────────

/**
 * Whether Prettier's `babel` parser throws on a JavaScript file that the parser here, in that dialect, has nothing to say about.
 * `isScript`: the file is read as a script. Sets the error (`check` of error.ts).
 */
export function refusalOfBabel(isScript: boolean): boolean {
  isScriptSource = isScript;
  firstNoticed = -1;
  firstAt = 0;
  firstMessage = "";
  noticed = 0;
  findCandidates();
  keywordsAsNames();
  // `early_errors`: the order of the checks is the order in which a tie is broken.
  assignmentTargets();
  restElements();
  declarations();
  statementPositions();
  deletedPrivateFields();
  metaProperties();
  regularExpressions();
  const mayHaveDirective = mentions("use strict");
  functions(mayHaveDirective);
  defaultsThatSuspend();
  supersCheck();
  privateNames();
  jumps();
  labels();
  classes();
  operators();
  dynamicImports();
  switchesAndThrows();
  arrows();
  objectLiterals(mentions("__proto__") ? hasName("__proto__") : -1);
  namesInQuotes();
  asyncBeforeOf();
  sequencesInJsx();
  decoratorsBeforeDefault();
  exports_();
  if (firstNoticed >= 0) {
    setCheck(firstMessage, firstAt, true);
    return true;
  }
  setCheck("", 0, false);
  return false;
}
