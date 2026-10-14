// Port of vendor/bun/src/lint/linter/syntax/order.rs: which of several errors typescript-estree comes to first.
//
// `Converter` checks a node, then converts its children in the order in which the code names them, which mostly is the alphabetical order
// of the properties of the ESTree node: the `body` of a function before its `params`, the `alternate` of an `if` before its `test`.
// Only a file with more than one error is looked at here.
import {
  EXPR_AS,
  EXPR_CALL,
  EXPR_COND,
  EXPR_INSTANTIATION,
  EXPR_JSX,
  EXPR_NEW,
  EXPR_SATISFIES,
  EXPR_TAGGED_TEMPLATE,
  FN_ARROW,
  FN_CONSTRUCTOR,
  FN_DECL,
  FN_EXPR,
  FN_GETTER,
  FN_METHOD,
  FN_SETTER,
  FN_STATIC_BLOCK,
  N_CASE,
  N_CLASS,
  N_EXPR,
  N_FILE,
  N_FUNC,
  N_MEMBER,
  N_PARAM,
  N_PAT,
  N_PROP,
  N_STMT,
  N_TYPE,
  N_TYPE_PARAM,
  N_VAR_DECL,
  NODE_FILE,
  STMT_FOR,
  STMT_FOR_IN,
  STMT_FOR_OF,
  STMT_IF,
  STMT_INTERFACE,
  STMT_SWITCH,
  STMT_TRY,
  STMT_TYPE_ALIAS,
  STMT_WHILE,
  TYPE_COND,
  TYPE_HERITAGE,
  TYPE_INDEXED_ACCESS,
  TYPE_TYPEOF,
  KEY,
  KEY_COMPUTED,
  KEY_EXPR,
  SP,
  classExtends,
  classImplementsLen,
  classImplementsStart,
  exprOuterSpan,
  funcKind,
  funcOwner,
  hir,
  jsxCloseTag,
  jsxTag,
  keyLoad,
  memberFunc,
  memberInit,
  memberIsSignature,
  nodeChildren,
  nodeId,
  nodeKind,
  nodeOfExpr,
  nodeOfMember,
  nodeOfStmt,
  nodeOfType,
  nodeSpan,
  paramDefault,
  stmtIsWith,
  stmtWithBody,
  typeOuterSpan,
} from "../../../lint/ast/index.ts";
import { I32Vec } from "../../vec.ts";
import { EXPR_FN } from "../../hir.ts";

/** `When`: when a check happens, apart from the node that it is about. */
/** Before anything of the node is converted. */
export const WHEN_FIRST: number = 0;
/** Where `convertTypeArguments` is called for the node that has the list. */
export const WHEN_TYPE_ARGUMENTS: number = 1;
/** The same for `convertTypeParameters`. */
export const WHEN_TYPE_PARAMETERS: number = 2;
/** Before anything of the `CatchClause` is converted, which here is a part of the `try`. */
export const WHEN_CATCH_CLAUSE: number = 3;

// The candidates: the node that is checked (its range; for a list of types, the place of its `<`), when, and the step that orders the
// checks of one node.
let cStart: number[] = [];
let cEnd: number[] = [];
let cWhen: number[] = [];
let cStep: number[] = [];

export function resetCandidates(): void {
  cStart = [];
  cEnd = [];
  cWhen = [];
  cStep = [];
}

export function pushCandidate(start: number, end: number, when: number, step: number): void {
  cStart.push(start);
  cEnd.push(end);
  cWhen.push(when);
  cStep.push(step);
}

export function candidateCount(): number {
  return cStart.length;
}

function outerSpanOf(node: number): void {
  const k = nodeKind(node);
  if (k === N_EXPR) {
    exprOuterSpan(nodeId(node));
  } else if (k === N_TYPE) {
    typeOuterSpan(nodeId(node));
  } else {
    nodeSpan(node);
  }
}

function contains(os: number, oe: number, is: number, ie: number): boolean {
  if (ie <= is) return os <= is && is < oe;
  return os <= is && ie <= oe;
}

/** `MethodDeclaration`, `GetAccessor`, `SetAccessor` that are not signatures. */
function isMethod(func: number): boolean {
  const k = funcKind(func);
  if (!(k === FN_METHOD || k === FN_GETTER || k === FN_SETTER)) return false;
  const owner = funcOwner(func);
  return !(nodeKind(owner) === N_MEMBER && memberIsSignature(nodeId(owner)));
}

// The ranks of the body, the parameters, the return type and the type parameters of a function.
let rBody = 0;
let rParams = 0;
let rReturn = 0;
let rTypeParams = 0;

function ranksInFunction(func: number): void {
  const k = funcKind(func);
  if (isMethod(func)) {
    rBody = 1;
    rParams = 4;
    rReturn = 2;
    rTypeParams = 3;
  } else if (k === FN_DECL || k === FN_EXPR || k === FN_ARROW || k === FN_CONSTRUCTOR || k === FN_STATIC_BLOCK) {
    rBody = 1;
    rParams = 2;
    rReturn = 3;
    rTypeParams = 4;
  } else {
    rBody = 4;
    rParams = 1;
    rReturn = 2;
    rTypeParams = 3;
  }
}

/** When `child` is converted, among the children of `parent`. From 1: the checks of `parent` itself come first. */
function rank(parent: number, child: number): number {
  const pk = nodeKind(parent);
  const pid = nodeId(parent);
  const isNode = (kind: number, id: number): boolean => id >= 0 && ((kind << 26) | id) === child;
  const ck = nodeKind(child);
  const hir$ = hir;
  switch (pk) {
    case N_STMT: {
      if (stmtIsWith(pid)) return isNode(N_STMT, stmtWithBody(pid)) ? 1 : 2;
      const tag = hir$.stmtTag[pid] | 0;
      switch (tag) {
        case STMT_IF: {
          const yes = hir$.stmtB[pid] | 0;
          const no = hir$.stmtC[pid] | 0;
          if (isNode(N_STMT, no)) return 1;
          if (isNode(N_STMT, yes)) return 2;
          return 3;
        }
        case STMT_FOR: {
          const init = hir$.stmtA[pid] | 0;
          const test = hir$.stmtB[pid] | 0;
          const body = hir$.stmtD[pid] | 0;
          if (isNode(N_STMT, body)) return 1;
          if (isNode(N_EXPR, test)) return 3;
          if (init >= 0) {
            nodeSpan(nodeOfStmt(init));
            const is_ = SP[0] | 0;
            const ie = SP[1] | 0;
            outerSpanOf(child);
            if (contains(is_, ie, SP[0] | 0, SP[1] | 0)) return 2;
          }
          return 4;
        }
        case STMT_FOR_IN:
        case STMT_FOR_OF: {
          const expr = hir$.stmtB[pid] | 0;
          const body = hir$.stmtC[pid] | 0;
          if (isNode(N_STMT, body)) return 1;
          if (isNode(N_EXPR, expr)) return 3;
          return 2;
        }
        case STMT_WHILE:
          return isNode(N_STMT, hir$.stmtB[pid] | 0) ? 1 : 2;
        case STMT_SWITCH:
          return isNode(N_EXPR, hir$.stmtA[pid] | 0) ? 2 : 1;
        case STMT_TRY: {
          const block = hir$.stmtA[pid] | 0;
          const handler = hir$.stmtC[pid] | 0;
          const finalizer = hir$.stmtD[pid] | 0;
          if (isNode(N_STMT, block)) return 1;
          if (isNode(N_STMT, finalizer)) return 2;
          if (isNode(N_STMT, handler)) return 4;
          return 5;
        }
        case STMT_INTERFACE:
          return ck === N_TYPE ? 1 : ck === N_MEMBER ? 2 : 3;
        case STMT_TYPE_ALIAS:
          return ck === N_TYPE_PARAM ? 2 : 1;
        default:
          return 1;
      }
    }
    case N_CASE:
      return isNode(N_EXPR, hir$.caseTest[pid] | 0) ? 2 : 1;
    case N_FUNC: {
      ranksInFunction(pid);
      if (ck === N_TYPE_PARAM) return rTypeParams;
      if (ck === N_PARAM) return rParams;
      if (ck === N_TYPE) return rReturn;
      return rBody;
    }
    case N_CLASS: {
      if (ck === N_MEMBER) return 1;
      if (ck === N_EXPR) {
        if (nodeOfExpr(classExtends(pid)) === child && classExtends(pid) >= 0) return 4;
        return 2;
      }
      if (ck === N_TYPE) {
        const s = classImplementsStart(pid);
        const n = classImplementsLen(pid);
        for (let i = 0; i < n; i++) if (nodeOfType(hir$.ids[(s + i) | 0] | 0) === child) return 3;
        return 6;
      }
      if (ck === N_TYPE_PARAM) return 5;
      return 6;
    }
    case N_MEMBER: {
      keyLoad(nodeOfMember(pid));
      const keyKind = KEY[0] | 0;
      const isKey = keyKind === KEY_COMPUTED && isNode(N_EXPR, KEY[KEY_EXPR] | 0);
      const f = memberFunc(pid);
      const isMeth = f >= 0 && isMethod(f);
      if (ck === N_FUNC) return isMeth ? 1 : 3;
      if (ck === N_TYPE) return 4;
      if (ck === N_EXPR) {
        const init = memberInit(pid);
        if (init >= 0 && nodeOfExpr(init) === child) return 5;
        if (isKey === isMeth) return 3;
      }
      return 2;
    }
    case N_PROP: {
      const value = hir$.propValue[pid] | 0;
      const hasFunc = (hir$.propKind[pid] | 0) !== 0 && propHasFunc(pid);
      const isValue = isNode(N_EXPR, value);
      return hasFunc ? 2 - (isValue ? 1 : 0) : 1 + (isValue ? 1 : 0);
    }
    case N_PARAM: {
      if (ck === N_PAT) return 1;
      if (ck === N_EXPR) {
        const d = paramDefault(pid);
        if (d >= 0 && nodeOfExpr(d) === child) return 2;
      }
      if (ck === N_TYPE) return 3;
      return 4;
    }
    case N_VAR_DECL:
      return ck === N_EXPR ? 1 : ck === N_PAT ? 2 : 3;
    case N_EXPR: {
      const tag = hir$.exprTag[pid] | 0;
      switch (tag) {
        case EXPR_COND: {
          const yes = hir$.exprB[pid] | 0;
          const no = hir$.exprC[pid] | 0;
          if (isNode(N_EXPR, no)) return 1;
          if (isNode(N_EXPR, yes)) return 2;
          return 3;
        }
        case EXPR_CALL: {
          const callee = hir$.callCallee[hir$.exprA[pid] | 0] | 0;
          if (ck === N_TYPE) return 3;
          return 2 - (isNode(N_EXPR, callee) ? 1 : 0);
        }
        case EXPR_NEW: {
          const callee = hir$.callCallee[hir$.exprA[pid] | 0] | 0;
          if (ck === N_TYPE) return 1;
          return 2 + (isNode(N_EXPR, callee) ? 1 : 0);
        }
        case EXPR_TAGGED_TEMPLATE: {
          const callee = hir$.callCallee[hir$.exprA[pid] | 0] | 0;
          if (ck === N_TYPE) return 3;
          return 1 + (isNode(N_EXPR, callee) ? 1 : 0);
        }
        case EXPR_AS:
        case EXPR_SATISFIES:
        case EXPR_INSTANTIATION:
          return 1 + (ck === N_TYPE ? 1 : 0);
        case EXPR_JSX: {
          if (ck === N_PROP) return 3;
          if (ck === N_TYPE) return 5;
          if (ck === N_EXPR) {
            const tag_ = jsxTag(pid);
            if (tag_ >= 0 && nodeOfExpr(tag_) === child) return 4;
            const close = jsxCloseTag(pid);
            if (close >= 0 && nodeOfExpr(close) === child) return 2;
          }
          return 1;
        }
        default:
          return 1;
      }
    }
    case N_TYPE: {
      const tag = hir$.typeTag[pid] | 0;
      if (tag === TYPE_COND) {
        const check = hir$.typeA[pid] | 0;
        const extendsTy = hir$.typeB[pid] | 0;
        const no = hir$.typeD[pid] | 0;
        if (isNode(N_TYPE, check)) return 1;
        if (isNode(N_TYPE, extendsTy)) return 2;
        if (isNode(N_TYPE, no)) return 3;
        return 4;
      }
      if (tag === TYPE_INDEXED_ACCESS) return 2 - (isNode(N_TYPE, hir$.typeB[pid] | 0) ? 1 : 0);
      if (tag === TYPE_TYPEOF || tag === TYPE_HERITAGE) return 1 + (ck === N_TYPE ? 1 : 0);
      return 1;
    }
    default:
      return 1;
  }
}

function propHasFunc(p: number): boolean {
  const hir$ = hir;
  const v = hir$.propValue[p] | 0;
  return v >= 0 && (hir$.exprTag[v] | 0) === EXPR_FN;
}

/** When a check of `node` happens that is not the first thing. */
function rankOfCheck(node: number, when: number): number {
  if (when === WHEN_FIRST) return 0;
  if (when === WHEN_CATCH_CLAUSE) return 3;
  const k = nodeKind(node);
  const id = nodeId(node);
  const hir$ = hir;
  if (when === WHEN_TYPE_PARAMETERS) {
    if (k === N_FUNC) {
      ranksInFunction(id);
      return rTypeParams;
    }
    if (k === N_CLASS) return 5;
    if (k === N_STMT) return (hir$.stmtTag[id] | 0) === STMT_INTERFACE ? 3 : 2;
    return 1;
  }
  // WHEN_TYPE_ARGUMENTS
  if (k === N_CLASS) return 6;
  if (k === N_EXPR) {
    const t = hir$.exprTag[id] | 0;
    if (t === EXPR_NEW) return 1;
    if (t === EXPR_JSX) return 5;
    if (t === EXPR_INSTANTIATION) return 2;
    return 3;
  }
  if (k === N_TYPE) {
    const t = hir$.typeTag[id] | 0;
    return t === TYPE_TYPEOF || t === TYPE_HERITAGE ? 2 : 1;
  }
  return 1;
}

const kids: I32Vec = new I32Vec(64);
let childStart: number[] = [];
let childEnd: number[] = [];

/** The index of the candidate whose check comes first. */
export function orderFirst(): number {
  const n = cStart.length;
  let inside: number[] = [];
  for (let i = 0; i < n; i++) inside.push(i);
  let at = NODE_FILE;
  const kids$ = kids;
  for (;;) {
    kids$.len = 0;
    nodeChildren(at, -1, kids$);
    const count = kids$.len | 0;
    childStart = [];
    childEnd = [];
    for (let k = 0; k < count; k++) {
      outerSpanOf(kids$.data[k] | 0);
      childStart.push(SP[0] | 0);
      childEnd.push(SP[1] | 0);
    }
    const areMany = count > 16;
    const childWith = (ns: number, ne: number): number => {
      if (areMany) {
        // The index after the last child that starts at or before the node.
        let lo = 0;
        let hi = count;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (childStart[mid] <= ns) lo = mid + 1;
          else hi = mid;
        }
        const i = lo - 1;
        return i >= 0 && contains(childStart[i], childEnd[i], ns, ne) ? i : -1;
      }
      // A method has the span of the member, with its decorators and its key.
      let best = -1;
      let bestLen = 0;
      for (let i = 0; i < count; i++) {
        if (!contains(childStart[i], childEnd[i], ns, ne)) continue;
        const len = childEnd[i] - childStart[i];
        if (best < 0 || len < bestLen) {
          best = i;
          bestLen = len;
        }
      }
      return best;
    };
    // By when it happens: the rank, the place in a list, the step. A child, or a check of `at`.
    let bestA = 0;
    let bestB = 0;
    let bestC = 0;
    let bestChild = -1;
    let bestCandidate = -1;
    for (let k = 0; k < inside.length; k++) {
      const i = inside[k];
      const child = childWith(cStart[i], cEnd[i]);
      let a: number;
      let b: number;
      let c: number;
      if (child >= 0) {
        a = rank(at, kids$.data[child] | 0);
        b = childStart[child];
        c = 0;
      } else {
        a = rankOfCheck(at, cWhen[i]);
        b = cStart[i];
        c = cStep[i];
      }
      if (bestCandidate < 0 || a < bestA || (a === bestA && (b < bestB || (b === bestB && c < bestC)))) {
        bestA = a;
        bestB = b;
        bestC = c;
        bestChild = child;
        bestCandidate = i;
      }
    }
    if (bestCandidate < 0) return -1;
    if (bestChild < 0) return bestCandidate;
    const next: number[] = [];
    for (let k = 0; k < inside.length; k++) {
      const i = inside[k];
      if (childWith(cStart[i], cEnd[i]) === bestChild) next.push(i);
    }
    inside = next;
    at = kids$.data[bestChild] | 0;
    void N_FILE;
    void STMT_FOR_IN;
  }
}
