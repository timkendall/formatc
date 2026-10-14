// Port of vendor/bun/src/format/js/print/call_like_expression/mod.rs: `callee(args)`, `new callee(args)`, `import(args)`. Prettier's
// `printCallExpression`.
import { Formatter } from "../../../ir/formatter.ts";
import { token } from "../../../ir/element.ts";
import { DOT, QUESTION_DOT } from "../../../ir/tokens.ts";
import { FLAVOR_OXFMT } from "../../../options.ts";
import {
  CHAIN_NO,
  EXPR_ARRAY,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_IMPORT_META,
  EXPR_INDEX,
  EXPR_STRING,
  EXPR_TAGGED_TEMPLATE,
  EXPR_TEMPLATE,
  SP,
  callArgsLen,
  callArgsStart,
  callCallee,
  callChain,
  callCloseParen,
  callIsOptional,
  callTypeArgsLen,
  callTypeArgsStart,
  exprDotName,
  exprDotObj,
  exprEnd,
  exprIdentName,
  exprImportCallPhase,
  exprIsChainRoot,
  exprObject,
  exprSpan,
  exprStart,
  exprTag,
  listAt,
  nameIs,
} from "../../../../lint/ast/index.ts";
import {
  AN_EXPRESSION_STATEMENT,
  anParent,
  anSpan,
  anTag,
  exprAsChainElement,
  mkAn,
  mkTypeArgumentsAn,
  AN_IMPORT_EXPRESSION,
} from "../../ast_nodes.ts";
import { cxOf } from "../../context.ts";
import { WK_EXPR, fmtExpr } from "../../format.ts";
import { chainExpressionNeedsParentheses } from "../../parentheses/expression.ts";
import { formatLeadingComments, formatLeadingCommentsRange, formatTrailingCommentsRange } from "../../trivia.ts";
import {
  isCallExpression,
  isTestCallExpressionInFlavor,
  typeArgumentsTrailingComments,
  writeCalleeTrailingComments,
} from "../../utils/call_expression.ts";
import { fmtNodeWithoutTrailingComments } from "../../utils/format_node_without_trailing_comments.ts";
import { writeMemberChain } from "../../utils/member_chain/mod.ts";
import { contextOfFunction } from "../../utils/tailwindcss.ts";
import { isCastTarget } from "../../utils/typecast.ts";
import { nodeOfExpr } from "../../../../lint/ast/index.ts";
import {
  fmtArguments,
  fmtArgumentsOfCall,
  isTemplateOnItsOwnLineOnlyArgument,
  writeArgumentsOnOneLine,
} from "./arguments.ts";
import { typeArguments, typeArgumentsWithoutComments } from "../type_parameters.ts";

const T_NEW = token("new");
const T_IMPORT = token("import");
const T_DEFER = token("defer");
const T_SOURCE = token("source");

export function writeCallExpression(e: number, call: number, f: Formatter): void {
  const cx = cxOf(f);
  const context = contextOfFunction(callCallee(call), f);
  // Among classes, the strings in a call of another function are not classes: `cn(a.includes("b c") && "d e")`.
  let wasDisabled = -1;
  if (context < 0) wasDisabled = cx.disableTailwindContext(true);
  writeCall(e, call, context, f);
  if (wasDisabled >= 0) cx.disableTailwindContext(wasDisabled !== 0);
}

/** `context`: for the arguments, a packed `TailwindContext` or -1. As in oxfmt, they do not get it in a chain of member accesses. */
function writeCall(e: number, call: number, context: number, f: Formatter): void {
  const cx = cxOf(f);
  const callee = callCallee(call);
  const argsStart = callArgsStart(call);
  const argsLen = callArgsLen(call);

  if (keepsArgumentsOnOneLine(e, call, f)) {
    // This is no member chain, so what leads `a.b` is written before the `a`, if it is the next comment.
    if (!cx.isQuiet) {
      const object = exprObject(callee);
      if (object >= 0) {
        exprSpan(object);
        const cm = cx.comments;
        cm.commentsLeadingLink(SP.s1 | 0);
        formatLeadingCommentsRange(cm.from, cm.to, f);
      }
    }
    writeHead(e, call, f);
    if (context >= 0) cx.pushTailwindContext(context);
    writeArgumentsOnOneLine(argsStart, argsLen, f);
    if (context >= 0) cx.popTailwindContext();
    return;
  }

  // A member access needs no parentheses as a callee, unless an optional chain ends with it. Then it is a member access only in
  // JavaScript: see `isMemberExpression`.
  const calleeTag = exprTag(callee);
  if (
    (calleeTag === EXPR_DOT || calleeTag === EXPR_INDEX) &&
    (!exprIsChainRoot(callee) || (cx.hasTreeOfBabel && !chainExpressionNeedsParentheses(callee, f)))
  ) {
    writeMemberChain(e, f);
    return;
  }

  const grouped = isCallExpression(callee, f);
  if (grouped) f.startGroup();
  writeHead(e, call, f);
  if (context >= 0) cx.pushTailwindContext(context);
  fmtArgumentsOfCall(e, call, f);
  if (context >= 0) cx.popTailwindContext();
  if (grouped) f.endGroup();
}

/** The callee, `?.`, the type arguments, and the boundary behind them if there are type arguments. */
function writeHead(e: number, call: number, f: Formatter): void {
  fmtCallee(call, f);
  if (callIsOptional(call)) f.token(QUESTION_DOT);
  fmtCallTypeArguments(e, call, f);
  if (callTypeArgsLen(call) > 0) boundaryBehindCallee(f);
}

const REQUIRE_LIKE_NAMES: readonly string[] = [
  "require",
  "define",
  "async",
  "inject",
  "fakeAsync",
  "waitForAsync",
  "beforeEach",
  "beforeAll",
  "afterEach",
  "afterAll",
];

function keepsArgumentsOnOneLine(e: number, call: number, f: Formatter): boolean {
  // Each of these takes one of a few names as the callee, or a string or a template as the first argument.
  const n = callArgsLen(call);
  if (n === 0) return false;
  const as = callArgsStart(call);
  const first = listAt(as, 0);
  const callee = callCallee(call);
  const ft = exprTag(first);
  if (!(ft === EXPR_STRING || ft === EXPR_TEMPLATE || ft === EXPR_TAGGED_TEMPLATE)) {
    if (exprTag(callee) !== EXPR_IDENT) return false;
    const name = exprIdentName(callee);
    let known = false;
    for (let i = 0; i < REQUIRE_LIKE_NAMES.length; i++) {
      if (nameIs(name, REQUIRE_LIKE_NAMES[i])) {
        known = true;
        break;
      }
    }
    if (!known) return false;
  }
  if (isTemplateOnItsOwnLineOnlyArgument(as, n, f)) return true;
  if (isSimpleModuleImport(e, call, f)) return true;
  if (isCommonjsOrAmdModuleDefinition(e, call, f)) return true;
  if (isTestCallExpressionInFlavor(e, f)) {
    for (let i = 0; i < n; i++) if (isCastTarget(listAt(as, i), f)) return false;
    return true;
  }
  return false;
}

/**
 * ```js
 * new A( // comment      new A(b); // comment
 *   b
 * );
 * ```
 *
 * For oxfmt it trails `A`, like any comment that ends the line after it.
 */
function commentBehindParenthesisOfNewTrailsClass(call: number, f: Formatter): boolean {
  return f.options.flavor === FLAVOR_OXFMT && callTypeArgsLen(call) === 0;
}

export function writeNewExpression(e: number, call: number, f: Formatter): void {
  const argsStart = callArgsStart(call);
  const argsLen = callArgsLen(call);
  const callee = callCallee(call);
  if (isTemplateOnItsOwnLineOnlyArgument(argsStart, argsLen, f)) {
    writeNewHeadOf(e, call, callee, f);
    writeArgumentsOnOneLine(argsStart, argsLen, f);
    return;
  }
  const grouped = isCallExpression(callee, f);
  if (grouped) f.startGroup();
  writeNewHeadOf(e, call, callee, f);
  fmtArgumentsOfCall(e, call, f);
  if (grouped) f.endGroup();
}

function writeNewHeadOf(e: number, call: number, callee: number, f: Formatter): void {
  f.token(T_NEW);
  f.space();
  if (commentBehindParenthesisOfNewTrailsClass(call, f)) fmtExpr(callee, f);
  else fmtCallee(call, f);
  fmtCallTypeArguments(e, call, f);
  if (callTypeArgsLen(call) > 0) boundaryBehindCallee(f);
}

export function writeImportExpression(e: number, argsStart: number, argsLen: number, f: Formatter): void {
  const phase = exprImportCallPhase(e);
  if (isTemplateOnItsOwnLineOnlyArgument(argsStart, argsLen, f) || isLoneStringWithoutComments(e, argsStart, argsLen, f)) {
    writeImportHead(phase, f);
    writeArgumentsOnOneLine(argsStart, argsLen, f);
    return;
  }
  f.startGroup();
  writeImportHead(phase, f);
  fmtArguments(argsStart, argsLen, mkAn(AN_IMPORT_EXPRESSION, e), f);
  f.endGroup();
}

function writeImportHead(phase: number, f: Formatter): void {
  f.token(T_IMPORT);
  if (phase > 0) {
    f.token(DOT);
    f.token(phase === 1 ? T_DEFER : T_SOURCE);
  }
}

/**
 * What is called, with the comments between it and the `?.`, the `<` or the `(`. A comment that ends the line stays there, and the rest
 * of the call goes on the next line.
 */
function fmtCallee(call: number, f: Formatter): void {
  const callee = callCallee(call);
  // `new A` has no `(` to look for.
  if (cxOf(f).isQuiet || callCloseParen(call) < 0) {
    fmtExpr(callee, f);
    boundaryBehindCallee(f);
    return;
  }
  fmtNodeWithoutTrailingComments(WK_EXPR, callee, f);
  writeCalleeTrailingCommentsOf(call, callee, f);
  boundaryBehindCallee(f);
}

function writeCalleeTrailingCommentsOf(call: number, callee: number, f: Formatter): void {
  writeCalleeTrailingComments(call, exprEnd(callee), f);
}

/**
 * A comment at the end of the line of the callee stays there. oxfmt, like Prettier 3.8, moves it behind the call:
 * `call // comment\n()` is `call(); // comment`.
 */
function boundaryBehindCallee(f: Formatter): void {
  if (f.options.flavor !== FLAVOR_OXFMT) f.lineSuffixBoundary();
}

/** The `<T>` of `a<T>()`, with the comments around it. */
export function fmtCallTypeArguments(e: number, call: number, f: Formatter): void {
  const start = callTypeArgsStart(call);
  const len = callTypeArgsLen(call);
  if (len === 0) return;
  const owner = nodeOfExpr(e);
  if (cxOf(f).isQuiet || callCloseParen(call) < 0) {
    typeArguments(start, len, owner, f);
    return;
  }
  anSpan(mkTypeArgumentsAn(owner));
  const SP$ = SP;
  const spanStart = SP$.s0 | 0;
  const spanEnd = SP$.s1 | 0;
  formatLeadingComments(spanStart, spanEnd, f);
  typeArgumentsWithoutComments(start, len, owner, f);
  typeArgumentsTrailingComments(call, spanEnd, f);
  const cm = cxOf(f).comments;
  formatTrailingCommentsRange(cm.from, cm.to, f);
}

/** Whether the only argument of `e` is a string, and there are no comments around it. */
function isLoneStringWithoutComments(e: number, argsStart: number, argsLen: number, f: Formatter): boolean {
  if (argsLen !== 1 || exprTag(listAt(argsStart, 0)) !== EXPR_STRING) return false;
  const cx = cxOf(f);
  return cx.isQuiet || !cx.comments.hasCommentBefore(exprEnd(e));
}

function isIdentifier(e: number, name: string): boolean {
  return exprTag(e) === EXPR_IDENT && nameIs(exprIdentName(e), name);
}

/**
 * Prettier's `isSimpleModuleImport` for a call: `require("a")`, `require.resolve("a")`, `require.resolve.paths("a")`,
 * `import.meta.resolve("a")`. A long name of a module is no reason to break.
 */
function isSimpleModuleImport(e: number, call: number, f: Formatter): boolean {
  const argsStart = callArgsStart(call);
  const argsLen = callArgsLen(call);
  if (argsLen !== 1 || callChain(call) !== CHAIN_NO || exprTag(listAt(argsStart, 0)) !== EXPR_STRING) return false;
  const callee = callCallee(call);
  let isModuleFunction = false;
  const t = exprTag(callee);
  if (t === EXPR_IDENT) {
    isModuleFunction = nameIs(exprIdentName(callee), "require");
  } else if (t === EXPR_DOT) {
    const obj = exprDotObj(callee);
    const name = exprDotName(callee);
    if (nameIs(name, "resolve")) {
      isModuleFunction = isIdentifier(obj, "require") || exprTag(obj) === EXPR_IMPORT_META;
    } else if (nameIs(name, "paths")) {
      isModuleFunction = exprTag(obj) === EXPR_DOT && isIdentifier(exprDotObj(obj), "require") && nameIs(exprDotName(obj), "resolve");
    }
  }
  return isModuleFunction && isLoneStringWithoutComments(e, argsStart, argsLen, f);
}

/** Prettier's `isCommonsJsOrAmdModuleDefinition`: `require("a", b)`, and `define` of AMD. */
function isCommonjsOrAmdModuleDefinition(e: number, call: number, f: Formatter): boolean {
  const callee = callCallee(call);
  if (exprTag(callee) !== EXPR_IDENT || callIsOptional(call)) return false;
  const argsStart = callArgsStart(call);
  const n = callArgsLen(call);
  const name = exprIdentName(callee);
  if (nameIs(name, "require")) {
    // `require(path.join(__dirname, "a"))` can break.
    if (!(n > 1 || (n === 1 && exprTag(listAt(argsStart, 0)) === EXPR_STRING))) return false;
    return !(n > 0 && cxOf(f).comments.hasCommentBefore(exprStart(listAt(argsStart, 0))));
  }
  if (nameIs(name, "define")) {
    if (anTag(anParent(exprAsChainElement(e))) !== AN_EXPRESSION_STATEMENT) return false;
    if (n === 1) return true;
    if (n === 2) return exprTag(listAt(argsStart, 0)) === EXPR_ARRAY;
    if (n === 3) return exprTag(listAt(argsStart, 0)) === EXPR_STRING && exprTag(listAt(argsStart, 1)) === EXPR_ARRAY;
    return false;
  }
  return false;
}
