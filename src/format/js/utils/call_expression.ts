// Port of vendor/bun/src/format/js/utils/call_expression.rs: calls that are written in a special way because of what they call:
// `it("..", () => {})`.
// The comments (a range, see `Comments`) between the callee, which ends at `calleeEnd`, and the `(`: returns the count.
import { Formatter } from "../../ir/formatter.ts";
import { FLAVOR_OXFMT } from "../../options.ts";
import {
  BODY_BLOCK,
  EXPR_CALL,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_INDEX,
  EXPR_NON_NULL,
  EXPR_NUMBER,
  EXPR_STRING,
  EXPR_TEMPLATE,
  callArgsLen,
  callArgsStart,
  callCallee,
  callIsOptional,
  callTypeArgsLen,
  callTypeArgsStart,
  exprAsCallLike,
  exprAsFn,
  exprCallee,
  exprDotName,
  exprDotObj,
  exprIdentName,
  exprNonNullExpr,
  exprEnd,
  exprSpan,
  exprStart,
  exprTag,
  exprIsChainRoot,
  funcBodyKind,
  funcParamsLen,
  funcThisParam,
  listAt,
  nameIs,
  SP,
  typeListAngleBrackets,
} from "../../../lint/ast/index.ts";
import {
  AN_CALL_EXPRESSION,
  AN_IDENTIFIER_REFERENCE,
  AN_STATIC_MEMBER_EXPRESSION,
  anId,
  anParent,
  anEnd,
  anTag,
  exprAsAstNodes,
  exprAsChainElement,
  exprAstParent,
} from "../ast_nodes.ts";
import { cxOf } from "../context.ts";
import {
  commentsStayBetweenHeadAndBody,
  formatTrailingCommentsRange,
  writeCommentsBetweenBlocks,
} from "../trivia.ts";

/** Prettier's `isCallExpression`. For `(a?.b())`, the whole of an optional chain, Babel has an `OptionalCallExpression` and typescript-estree a `ChainExpression`. */
export function isCallExpression(e: number, f: Formatter): boolean {
  return exprTag(e) === EXPR_CALL && (cxOf(f).hasTreeOfBabel || !exprIsChainRoot(e));
}

/** Prettier's `isMemberExpression`. See `isCallExpression`. */
export function isMemberExpression(e: number, f: Formatter): boolean {
  const t = exprTag(e);
  return (t === EXPR_DOT || t === EXPR_INDEX) && (cxOf(f).hasTreeOfBabel || !exprIsChainRoot(e));
}

/** Prettier's `stripChainElementWrappers`: `e` without the `!`s after it. The `ChainExpression` is not a node here. */
export function stripChainElementWrappers(e: number, f: Formatter): number {
  void f;
  while (exprTag(e) === EXPR_NON_NULL) e = exprNonNullExpr(e);
  return e;
}

/**
 * `a["b"]( // comment⏎c)` is `a["b"](c); // comment` for oxfmt: to a callee like `a[b]` the `(` is nothing, and what is between it and
 * the first argument is its own or the argument's as between any two nodes. True if applicable, with the range in `cm.from`/`cm.to`.
 */
function commentsTrailingComputedCallee(call: number, f: Formatter): boolean {
  if (f.options.flavor !== FLAVOR_OXFMT) return false;
  const callee = callCallee(call);
  if (exprTag(callee) !== EXPR_INDEX) return false;
  const parentAn = exprAstParent(callee);
  if (anTag(parentAn) !== AN_CALL_EXPRESSION) return false;
  let followingStart = 0;
  if (typeListAngleBrackets(callTypeArgsStart(call), callTypeArgsLen(call))) {
    followingStart = SP.s0 | 0;
  } else if (callArgsLen(call) > 0) {
    followingStart = exprStart(listAt(callArgsStart(call), 0));
  } else {
    return false;
  }
  const parentEnd = anEnd(parentAn);
  const calleeEnd = exprEnd(callee);
  cxOf(f).comments.getTrailingComments(parentEnd, calleeEnd, followingStart);
  return true;
}

/**
 * Of the comments between the callee of `call`, which ends at `calleeEnd` and is written, and the `<` or the `(`, those that trail the
 * callee. `call` has a `(`. Returns the count; the range is `cm.from`/`cm.to`.
 */
export function calleeTrailingComments(call: number, calleeEnd: number, f: Formatter): number {
  const cm = cxOf(f).comments;
  if (commentsTrailingComputedCallee(call, f)) return (cm.to - cm.from) | 0;
  if (commentsStayBetweenHeadAndBody(f)) {
    const opener = callIsOptional(call) ? 63 : callTypeArgsLen(call) > 0 ? 60 : 40; // ? < (
    return cm.commentsBeforeCharacter(calleeEnd, opener);
  }
  return cm.commentsTrailingLink(calleeEnd);
}

/** Writes `calleeTrailingComments`. */
export function writeCalleeTrailingComments(call: number, calleeEnd: number, f: Formatter): void {
  const cm = cxOf(f).comments;
  if (commentsTrailingComputedCallee(call, f)) {
    formatTrailingCommentsRange(cm.from, cm.to, f);
    return;
  }
  calleeTrailingComments(call, calleeEnd, f);
  if (commentsStayBetweenHeadAndBody(f)) writeCommentsBetweenBlocks(cm.from, cm.to, f);
  else formatTrailingCommentsRange(cm.from, cm.to, f);
}

/**
 * The comments that trail the type arguments of `call`, which end at `end`. One behind the `(` at the end of the line is among them:
 * Prettier's `handleCallExpressionComments` only gives it to the first argument if what is before it is the callee. Returns the count;
 * the range is `cm.from`/`cm.to`.
 */
export function typeArgumentsTrailingComments(call: number, end: number, f: Formatter): number {
  const cx = cxOf(f);
  const cm = cx.comments;
  if (callArgsLen(call) > 0) {
    cm.commentsIn(end, exprStart(listAt(callArgsStart(call), 0)));
    // trailing_prefix
    const from = cm.from;
    const to = cm.to;
    const src = cx.src;
    let count = 0;
    for (let i = to - 1; i >= from; i--) {
      if (
        !cm.precededByNewline(i) &&
        (cm.followedByNewline(i) ||
          src.nextNonWhitespaceByteIs(cm.spanEnd[i] | 0, 63) ||
          src.nextNonWhitespaceByteIs(cm.spanEnd[i] | 0, 41))
      ) {
        count = (i - from + 1) | 0;
        break;
      }
    }
    cm.from = from;
    cm.to = (from + count) | 0;
    return count;
  }
  return cm.commentsBeforeCharacter(end, 40);
}

/** The callees that `isTestCall` takes. 0: Prettier's `testCallCalleePatterns`; 1: oxfmt's, which are more. */
const TEST_CALLEES_PRETTIER: number = 0;
const TEST_CALLEES_OXFMT: number = 1;

/**
 * Prettier's `isTestCall`. `e` is a call.
 *
 * - `it("name", () => {})`, `test.only("name", async function () {}, 1000)`: the callee is one of the names of a test framework, the
 *   first argument is a string or a template, the second a function with at most one parameter, the third, if any, a number.
 * - `beforeEach(inject(() => {}))`
 */
export function isTestCallExpression(e: number): boolean {
  return isTestCall(e, TEST_CALLEES_PRETTIER);
}

/** The same, with the callees that the flavor knows. */
export function isTestCallExpressionInFlavor(e: number, f: Formatter): boolean {
  if (f.options.flavor === FLAVOR_OXFMT) {
    return isTestCall(e, TEST_CALLEES_OXFMT) && !hasCommentsAroundArguments(e, f);
  }
  return isTestCall(e, TEST_CALLEES_PRETTIER);
}

/**
 * Whether there is a comment before, between or after the arguments of the call `e`. Prettier writes the arguments of a call of a test
 * on one line all the same, and the comments come out in another order. To oxfmt it is a call like any other then.
 */
function hasCommentsAroundArguments(e: number, f: Formatter): boolean {
  const call = exprAsCallLike(e);
  if (call < 0) return false;
  const cm = cxOf(f).comments;
  let start = exprEnd(callCallee(call));
  const as = callArgsStart(call);
  const n = callArgsLen(call);
  const SP$ = SP;
  for (let i = 0; i < n; i++) {
    exprSpan(listAt(as, i));
    const argStart = SP$.s0 | 0;
    const argEnd = SP$.s1 | 0;
    if (cm.hasAnyCommentIn(start, argStart)) return true;
    start = argEnd;
  }
  return cm.hasAnyCommentIn(start, exprEnd(e));
}

function isTestCall(e: number, callees: number): boolean {
  if (exprTag(e) !== EXPR_CALL) return false;
  const call = exprAsCallLike(e);
  if (call < 0 || callIsOptional(call)) return false;
  const callee = callCallee(call);
  const n = callArgsLen(call);
  const as = callArgsStart(call);

  if (n === 1) {
    const argument = listAt(as, 0);
    if (isAngularTestWrapper(e)) {
      // A wrapper with nothing but a wrapper in it is none: what is in it is no function.
      const parentAn = anParent(exprAsChainElement(e));
      if (anTag(parentAn) === AN_CALL_EXPRESSION) {
        const parent = anId(parentAn);
        const parentCall = exprAsCallLike(parent);
        const wrapperOfWrapper = isAngularTestWrapper(parent) && parentCall >= 0 && callArgsLen(parentCall) === 1;
        if (!wrapperOfWrapper && isTestCall(parent, callees)) return exprAsFn(argument) >= 0;
      }
    }
    return isUnitTestSetUpCallee(callee) && isAngularTestWrapperExpression(argument);
  }
  if (n >= 2 && n <= 3) {
    const first = listAt(as, 0);
    const firstTag = exprTag(first);
    if ((firstTag === EXPR_STRING || firstTag === EXPR_TEMPLATE) && containsATestPattern(callee, callees)) {
      if (n === 3 && exprTag(listAt(as, 2)) !== EXPR_NUMBER) return false;
      const second = listAt(as, 1);
      if (isAngularTestWrapperExpression(second)) return true;
      const func = exprAsFn(second);
      if (func < 0) return false;
      const hasBlockBody = funcBodyKind(func) === BODY_BLOCK;
      return n === 2 || (funcParamsLen(func) + (funcThisParam(func) >= 0 ? 1 : 0) <= 1 && hasBlockBody);
    }
  }
  return false;
}

function isAngularTestWrapperExpression(e: number): boolean {
  return anTag(exprAsAstNodes(e)) === AN_CALL_EXPRESSION && isAngularTestWrapper(e);
}

/** `inject(..)` of AngularJS, `async(..)`, `fakeAsync(..)` and `waitForAsync(..)` of Angular. `e` is a call. */
export function isAngularTestWrapper(e: number): boolean {
  const callee = exprCallee(e);
  if (callee < 0 || exprTag(callee) !== EXPR_IDENT) return false;
  const name = exprIdentName(callee);
  return nameIs(name, "async") || nameIs(name, "inject") || nameIs(name, "fakeAsync") || nameIs(name, "waitForAsync");
}

function isUnitTestSetUpCallee(callee: number): boolean {
  if (exprTag(callee) !== EXPR_IDENT) return false;
  const name = exprIdentName(callee);
  return nameIs(name, "beforeEach") || nameIs(name, "beforeAll") || nameIs(name, "afterEach") || nameIs(name, "afterAll");
}

/** The names of `a.b.c`, from the left, as atoms in `NAMES[0 .. count)`. */
const NAMES = new Int32Array(5);
const NAMES_RTL = new Int32Array(5);

/** `calleeNameIterator`: the count of names of `a.b.c` (in `NAMES`, from the left), or -1 if there are more than five or it is anything but names and dots. */
export function calleeNames(e: number): number {
  let current = e;
  for (let i = 0; i < 5; i++) {
    const an = exprAsAstNodes(current);
    const t = anTag(an);
    if (t === AN_IDENTIFIER_REFERENCE) {
      NAMES_RTL[i] = exprIdentName(current) | 0;
      const count = (i + 1) | 0;
      for (let k = 0; k < count; k++) NAMES[k] = NAMES_RTL[(count - 1 - k) | 0] | 0;
      return count;
    }
    if (t === AN_STATIC_MEMBER_EXPRESSION) {
      NAMES_RTL[i] = exprDotName(current) | 0;
      current = exprDotObj(current);
    } else {
      return -1;
    }
  }
  return -1;
}

/** `name` is `NAMES[i]` and one of `list` (a `|`-separated ASCII list). */
function nameOneOf(i: number, a: string, b: string, c: string, d: string): boolean {
  const name = NAMES[i] | 0;
  return nameIs(name, a) || (b !== "" && nameIs(name, b)) || (c !== "" && nameIs(name, c)) || (d !== "" && nameIs(name, d));
}

/** oxfmt's `contains_a_test_pattern`: Prettier's `testCallCalleePatterns` and some more. */
function containsATestPatternOfOxfmt(e: number): boolean {
  if (containsATestPatternOfPrettier(e)) return true;
  const n = calleeNames(e);
  if (n < 0) return false;
  if (n > 2) return false;
  const second = n === 2;
  if (nameIs(NAMES[0] | 0, "it")) {
    return second && (nameOneOf(1, "skipIf", "runIf", "concurrent", "sequential") || nameOneOf(1, "todo", "fails", "", ""));
  }
  if (nameIs(NAMES[0] | 0, "describe")) {
    return second && (nameOneOf(1, "skipIf", "runIf", "concurrent", "sequential") || nameOneOf(1, "shuffle", "todo", "", ""));
  }
  if (nameIs(NAMES[0] | 0, "test")) {
    return (
      second &&
      (nameOneOf(1, "skipIf", "runIf", "concurrent", "sequential") || nameOneOf(1, "todo", "fails", "extend", ""))
    );
  }
  if (nameIs(NAMES[0] | 0, "bench")) {
    return !second || nameOneOf(1, "only", "skip", "todo", "");
  }
  if (nameIs(NAMES[0] | 0, "Deno")) return second && nameIs(NAMES[1] | 0, "test");
  return false;
}

function containsATestPattern(e: number, callees: number): boolean {
  return callees === TEST_CALLEES_OXFMT ? containsATestPatternOfOxfmt(e) : containsATestPatternOfPrettier(e);
}

/**
 * Prettier's `testCallCalleePatterns`: whether `e` is a function of a test framework that takes a name and a callback.
 *
 * ```text
 * ├─ it[.only|skip]
 * ├─ describe[.only|skip]
 * ├─ test
 * │  ├─ [.only|skip|fixme|step]
 * │  └─ .describe
 * │     ├─ [.only|skip|fixme]
 * │     ├─ .parallel[.only]
 * │     └─ .serial[.only]
 * └─ skip|xit|xdescribe|xtest|fit|fdescribe|ftest
 * ```
 */
function containsATestPatternOfPrettier(e: number): boolean {
  const n = calleeNames(e);
  if (n < 0) return false;
  const first = NAMES[0] | 0;
  if (nameIs(first, "it") || nameIs(first, "describe")) {
    if (n === 1) return true;
    return nameOneOf(1, "only", "skip", "", "") && n === 2;
  }
  if (nameIs(first, "test")) {
    if (n === 1) return true;
    if (nameOneOf(1, "only", "skip", "fixme", "step")) return n === 2;
    if (nameIs(NAMES[1] | 0, "describe")) {
      if (n === 2) return true;
      if (nameOneOf(2, "only", "skip", "fixme", "")) return n === 3;
      if (nameOneOf(2, "parallel", "serial", "", "")) {
        if (n === 3) return true;
        return nameIs(NAMES[3] | 0, "only") && n === 4;
      }
      return false;
    }
    return false;
  }
  if (
    nameIs(first, "skip") ||
    nameIs(first, "xit") ||
    nameIs(first, "xdescribe") ||
    nameIs(first, "xtest") ||
    nameIs(first, "fit") ||
    nameIs(first, "fdescribe") ||
    nameIs(first, "ftest")
  ) {
    return n === 1;
  }
  return false;
}

/** `` describe.each`table` ``, `` test.only.each`table` ``, .. */
export function isTestEachPattern(e: number): boolean {
  const n = calleeNames(e);
  if (n < 0) return false;
  const first = NAMES[0] | 0;
  const second = n > 1 ? NAMES[1] | 0 : -1;
  const third = n > 2 ? NAMES[2] | 0 : -1;
  if (nameIs(first, "describe") || nameIs(first, "xdescribe") || nameIs(first, "fdescribe")) {
    if (n < 2) return false;
    if (nameIs(second, "each")) return n === 2;
    if (nameIs(second, "skip") || nameIs(second, "only")) return n === 3 && nameIs(third, "each");
    return false;
  }
  if (
    nameIs(first, "test") ||
    nameIs(first, "xtest") ||
    nameIs(first, "ftest") ||
    nameIs(first, "it") ||
    nameIs(first, "xit") ||
    nameIs(first, "fit")
  ) {
    if (n < 2) return false;
    if (nameIs(second, "each")) return n === 2;
    if (nameIs(second, "skip") || nameIs(second, "only") || nameIs(second, "failing")) return n === 3 && nameIs(third, "each");
    if (nameIs(second, "concurrent")) {
      if (n < 3) return false;
      if (nameIs(third, "each")) return n === 3;
      if (nameIs(third, "only") || nameIs(third, "skip")) return n === 4 && nameIs(NAMES[3] | 0, "each");
      return false;
    }
    return false;
  }
  return false;
}
