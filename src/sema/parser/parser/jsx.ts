// Port of vendor/bun/src/sema/parser/parser/jsx.rs: JSX.
//
// Conventions: those of mod.ts (module-level `lx`, `p`, `s`; free functions; several results via `p.outPos/outLen/outA/outB`).
// Only the non-recovering Babel/TypeScript parse is ported: the branches for oxc and recovery are `// TODO(..)` comments.
//
// The `Jsx` row is made (`hir.newJsx()`) before the children are parsed and filled as the parts are known; Rust makes it at the end.
// `jsxElement` returns the expression; whether its closing tag was that of the parent is `jsxClosesParent` (only recovery sets it).
import {
  CHAIN_NO,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_JSX,
  EXPR_MISSING,
  EXPR_STRING,
  EXPR_THIS,
  NK_JSX,
  NONE,
  PK_NAME,
  PK_NONE,
  PROP_INIT,
  PROP_SPREAD,
  hir,
  pushExprDot,
  pushExprIdent,
  pushExprJsx,
  pushExprMissing,
  pushExprSpread,
  pushExprString,
  pushExprThis,
} from "../../hir.ts";
import { A_empty, A_this, ATOM_NONE } from "../../atom.ts";
import { Bytes } from "../../vec.ts";
import {
  T_CLOSE_BRACE,
  T_COLON,
  T_DOT,
  T_DOT_DOT_DOT,
  T_EQUALS,
  T_GREATER_THAN,
  T_IDENTIFIER,
  T_JSX_TEXT,
  T_LESS_THAN,
  T_LESS_THAN_SLASH,
  T_OPEN_BRACE,
  T_PRIVATE_IDENTIFIER,
  T_SLASH,
  T_STRING,
} from "../token.ts";
import { R_REPORTED, R_UNSUPPORTED } from "../lib.ts";
import {
  LK_JSX_ATTRIBUTES,
  LK_JSX_CHILDREN,
  eat,
  enterDepth,
  enterList,
  errorAtToken,
  expect,
  expected,
  fail,
  hasFailed,
  identifierName,
  leaveDepth,
  leaveList,
  lx,
  names,
  noteIdentifier,
  p,
  peek,
  refuse,
  report,
  s,
  takeIds,
  takeList,
} from "./mod.ts";
import { isAtElement } from "./recover.ts";
import { leftHandSideExpression } from "./expr.ts";
import { unicodeEscapeAt, ESC_CP } from "../../check/spans.ts";
import { isTypeScriptIdentifierPart } from "../unicode.ts";
import { expression, expressionAllowingIn, firstOperandPos } from "./expr.ts";
import { isAtTypeArgumentsOfHeritageElement, typeArguments } from "./ty.ts";
import { error, errorArgs, errorAtTokenArgs, missingExpression, missingIdentifier, srcText, atomText, next, lookAheadEnd } from "./mod.ts";
import { T_EOF, T_PLUS_PLUS, T_MINUS_MINUS } from "../token.ts";
import { pushExprBinary, pushExprUnary } from "../../hir.ts";
import { UN_POST_INC, UN_POST_DEC, BIN_COMMA } from "../../hir.ts";

/** The element parsed last had the closing tag of its parent (recovery only). */
let jsxClosesParent = false;

/** The text of two names joined: scratch of `jsxNamespacedName`. */
const joined = new Bytes(64);

/** `parseUpdateExpression`, at a `<` that starts an element or a fragment. */
export function jsxElementOrFragment(): number {
  if (p.recovers && !isAtJsxElement()) {
    // There an element is a primary expression, and this is none.
    if (p.isEcmascript) return missingExpression(1109);
    return updateExpressionAtLessThan();
  }
  return jsxElements(false);
}

/** `nextTokenIsIdentifierOrKeywordOrGreaterThan`, at a `<`. */
function isAtJsxElement(): boolean {
  // Most often nothing is between the `<` and the name.
  const next = lx.end < lx.len ? lx.src[lx.end] | 0 : 0;
  if ((next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 62) return true;
  const t = peek();
  return t === T_GREATER_THAN || t >= T_IDENTIFIER;
}

/** `parseUpdateExpression`, at a `<` that starts no element. */
function updateExpressionAtLessThan(): number {
  if (!enterDepth()) return NONE;
  const start = lx.start | 0;
  const operand = leftHandSideExpression();
  let op = -1;
  if (lx.token === T_PLUS_PLUS && !lx.newlineBefore) op = UN_POST_INC;
  else if (lx.token === T_MINUS_MINUS && !lx.newlineBefore) op = UN_POST_DEC;
  if (op < 0) {
    leaveDepth();
    return operand;
  }
  next();
  const r = pushExprUnary(start, lx.fullStart, operand, op);
  leaveDepth();
  return r;
}

/** `parseJsxElementOrSelfClosingElementOrFragment` in an expression context. */
export function jsxElements(mustBeUnary: boolean): number {
  const element = jsxElement(true, NONE);
  if (lx.token === T_LESS_THAN && !mustBeUnary) return jsxElementsWithoutParent(element);
  return element;
}

/** The end of `parseJsxElementOrSelfClosingElementOrFragment`, at the `<` after `first`. */
function jsxElementsWithoutParent(first: number): number {
  if (!p.recovers) {
    refuse(R_UNSUPPORTED);
    return first;
  }
  const base = s.ids.len;
  s.ids.push(first);
  while (lx.token === T_LESS_THAN) {
    const element = jsxElement(true, NONE);
    s.ids.push(element);
  }
  const end = lx.fullStart | 0;
  const top = firstOperandPos(first);
  error(2657, top, top === end ? -1 : end);
  // Each is the left operand of a comma, and the rest the right one.
  let rest = NONE;
  while (s.ids.len > base) {
    s.ids.len = s.ids.len - 1;
    const left = s.ids.data[s.ids.len] | 0;
    if (rest < 0) {
      rest = left;
      continue;
    }
    const pos_ = firstOperandPos(left);
    rest = pushExprBinary(pos_, end, left, rest, BIN_COMMA);
  }
  return rest;
}

/** Consumes the `>` that ends a tag of the element with the name `tag`, which a fragment does not have. Returns the end of the tag. */
function endOfJsxTag(isInExpression: boolean, tag: number): number {
  if (lx.token !== T_GREATER_THAN) return missingEndOfJsxTag(isInExpression, tag);
  const end = lx.end;
  if (isInExpression) lx.next();
  else lx.nextJsxChild();
  return end;
}

/** `parseExpectedWithDiagnostic(KindGreaterThanToken, ..)`, at another token. */
function missingEndOfJsxTag(isInExpression: boolean, tag: number): number {
  if (tag < 0) errorAtToken(17015);
  else expected(T_GREATER_THAN);
  const end = lx.fullStart | 0;
  if (!isInExpression) rescanJsxChild();
  return end;
}

/** `ReScanJsxToken`, which `parseJsxChildren` calls before each child, at a token of an expression. */
function rescanJsxChild(): void {
  if (hasFailed()) return;
  const from = lx.fullStart | 0;
  // What was read as a comment is text.
  const comments = lx.comments;
  let kept = 0;
  const rows = (comments.len / 2) | 0;
  while (kept < rows && (comments.data[kept * 2] | 0) < from) kept = (kept + 1) | 0;
  comments.len = (kept * 2) | 0;
  lx.end = from;
  lx.nextJsxChild();
  // (`parseJsxChildren` of the native parser leaves `p.token` as it was: only for `Dialect::default()`, which is not read here.)
}

/** The text between `a` and `b`, compared with the text between `c` and `d`. */
function sameText(a: number, b: number, c: number, d: number): boolean {
  if (b - a !== d - c) return false;
  const src = lx.src;
  for (let i = 0; i < b - a; i++) {
    if ((src[(a + i) | 0] | 0) !== (src[(c + i) | 0] | 0)) return false;
  }
  return true;
}

/**
 * `parseJsxElementOrSelfClosingElementOrFragment`, at the `<`. `parent`: the name of `openingTag`, if that is an element. Returns the
 * expression; whether the closing tag is the one of `parent` is `jsxClosesParent`.
 */
function jsxElement(isInExpression: boolean, parent: number): number {
  if (!enterDepth()) {
    jsxClosesParent = false;
    return NONE;
  }
  const r = jsxElementInDoor(isInExpression, parent);
  leaveDepth();
  return r;
}

function jsxElementInDoor(isInExpression: boolean, parent: number): number {
  jsxClosesParent = false;
  const start = lx.start;
  // `nodePos()`: nothing but text is between the children.
  const fullStart = isInExpression ? lx.fullStart : start;
  lx.next();
  const jsx = hir.newJsx();
  let nameStart = 0;
  let nameEnd = 0;
  let tag = NONE;
  if (lx.token !== T_GREATER_THAN) {
    nameStart = lx.start;
    tag = jsxElementName();
    hir.jsxTag[jsx] = tag;
    nameEnd = lx.fullStart | 0;
    if (p.hasTypeArgumentsInExpressions && isAtTypeArgumentsOfHeritageElement()) {
      hir.jsxTypeArgsStart[jsx] = typeArguments();
      hir.jsxTypeArgsLen[jsx] = p.outLen | 0;
    }
    hir.jsxAttrsStart[jsx] = jsxAttributes();
    hir.jsxAttrsLen[jsx] = p.outLen | 0;
    if (lx.token !== T_GREATER_THAN) {
      // The scanner never joins a `>` with what follows it.
      if (!eat(T_SLASH)) errorAtTokenArgs(1005, ["/"]);
      const end = endOfJsxTag(isInExpression, tag);
      hir.jsxEnd[jsx] = end;
      hir.jsxOpeningEnd[jsx] = end;
      return pushExprJsx(start, end, jsx);
    }
  }
  hir.jsxOpeningEnd[jsx] = lx.end;
  lx.nextJsxChild();
  // `parseJsxChildren`
  const base = s.ids.len;
  const lists = enterList(LK_JSX_CHILDREN);
  let reachedEnd = false;
  while (!reachedEnd) {
    let child = NONE;
    switch (lx.token) {
      case T_JSX_TEXT:
        child = pushExprString(lx.start, lx.end, lx.atom);
        lx.nextJsxChild();
        break;
      case T_OPEN_BRACE:
        child = jsxExpressionChild(start);
        break;
      case T_LESS_THAN:
        // For acorn and oxc `<` and `/` are two tokens. TODO(oxc): `|| dialect.oxc`
        if (p.isEcmascript && peek() === T_SLASH) {
          reachedEnd = true;
          break;
        }
        child = jsxElement(false, tag);
        if (jsxClosesParent) {
          leaveList(lists);
          s.ids.push(child);
          return jsxElementClosedByChild(jsx, start, child, base, isInExpression);
        }
        break;
      case T_LESS_THAN_SLASH:
        reachedEnd = true;
        break;
      default:
        leaveList(lists);
        return jsxElementWithoutClosingTag(jsx, base, start, fullStart, nameStart, nameEnd, tag, parent);
    }
    if (reachedEnd) break;
    s.ids.push(child);
  }
  leaveList(lists);
  hir.jsxChildrenStart[jsx] = takeIds(base);
  hir.jsxChildrenLen[jsx] = p.outLen | 0;
  // `parseJsxClosingElement`, `parseJsxClosingFragment`
  hir.jsxClosePos[jsx] = lx.start;
  if (lx.token === T_LESS_THAN) lx.next();
  lx.next();
  if (tag >= 0) {
    const closing = lx.start;
    const closeTag = jsxElementName();
    hir.jsxCloseTag[jsx] = closeTag;
    // `tagNamesAreEquivalent`
    if (!sameText(nameStart, nameEnd, closing, lx.fullStart) && !areTagNamesEquivalent(tag, closeTag)) {
      return jsxElementWithOtherClosingTag(jsx, start, nameStart, nameEnd, parent, isInExpression);
    }
  }
  const end = endOfJsxTag(isInExpression, tag);
  hir.jsxEnd[jsx] = end;
  return pushExprJsx(start, end, jsx);
}

/**
 * What `parseJsxElementOrSelfClosingElementOrFragment` does with a last child that has the closing tag of the element: the tag is
 * moved, and the one of `child` is missing. (Reached only with recovery.)
 */
function jsxElementClosedByChild(jsx: number, start: number, child: number, base: number, isInExpression: boolean): number {
  hir.jsxChildrenStart[jsx] = takeIds(base);
  hir.jsxChildrenLen[jsx] = p.outLen | 0;
  hir.jsxEnd[jsx] = lx.fullStart;
  if (child >= 0 && (hir.exprTag[child] | 0) === EXPR_JSX) {
    const inner = hir.exprA[child] | 0;
    hir.jsxCloseTag[jsx] = hir.jsxCloseTag[inner] | 0;
    hir.jsxClosePos[jsx] = hir.jsxClosePos[inner] | 0;
    hir.jsxEnd[jsx] = hir.jsxEnd[inner] | 0;
    // `lastChild.Children().End()`
    const end = hir.jsxClosePos[inner] | 0;
    const missing = pushExprMissing(end, end);
    hir.jsxCloseTag[inner] = missing;
    hir.jsxEnd[inner] = end;
    hir.exprEnd[child] = end;
  }
  if (!isInExpression) rescanJsxChild();
  jsxClosesParent = false;
  return pushExprJsx(start, hir.jsxEnd[jsx] | 0, jsx);
}

/**
 * `parseJsxChild` at a token that is no child and no `</`, and what follows the children. The element starts at `start`, its node at
 * `fullStart`, and its name is `nameStart..nameEnd`. Without recovery it is an error.
 */
function jsxElementWithoutClosingTag(
  jsx: number,
  base: number,
  start: number,
  fullStart: number,
  nameStart: number,
  nameEnd: number,
  tag: number,
  parent: number,
): number {
  if (!p.recovers) {
    fail();
    s.ids.truncate(base);
    return NONE;
  }
  const written = srcText(nameStart, nameEnd);
  if (lx.token === T_EOF) {
    if (tag >= 0) {
      const from = nameStart < nameEnd ? nameStart : nameEnd;
      errorArgs(17008, from, from === nameEnd ? -1 : nameEnd, [written]);
    } else {
      const to = hir.jsxOpeningEnd[jsx] | 0;
      error(17014, fullStart, fullStart === to ? -1 : to);
    }
  }
  hir.jsxChildrenStart[jsx] = takeIds(base);
  hir.jsxChildrenLen[jsx] = p.outLen | 0;
  // `parseJsxClosingElement`, `parseJsxClosingFragment`: the name and the `>` are missed at the same place, where no second error is
  // reported.
  const at = lx.start | 0;
  errorAtTokenArgs(1005, ["</"]);
  // `ScanJsxToken`: `TokenFullStart()` is the start of the token, which stays.
  lx.fullStart = at;
  hir.jsxClosePos[jsx] = at;
  hir.jsxEnd[jsx] = at;
  let closesParent = false;
  if (tag >= 0) {
    const closeTag = pushExprMissing(at, at);
    hir.jsxCloseTag[jsx] = closeTag;
    closesParent = parent >= 0 && !areTagNamesEquivalent(tag, closeTag) && areTagNamesEquivalent(closeTag, parent);
    if (closesParent) {
      const from = (start + 1) | 0;
      errorArgs(17008, from, from === nameEnd ? -1 : nameEnd, [written]);
    }
  }
  const r = pushExprJsx(start, at, jsx);
  jsxClosesParent = closesParent;
  return r;
}

/** The end of `parseJsxClosingElement`, and what follows it, after a name that is not the one of the opening tag, which is `nameStart..nameEnd`. */
function jsxElementWithOtherClosingTag(jsx: number, start: number, nameStart: number, nameEnd: number, parent: number, isInExpression: boolean): number {
  if (!p.recovers) {
    refuse(R_REPORTED);
    return NONE;
  }
  const endOfName = lx.fullStart | 0;
  if (lx.token === T_GREATER_THAN) next();
  else expected(T_GREATER_THAN);
  hir.jsxEnd[jsx] = lx.fullStart | 0;
  const written = srcText(nameStart, nameEnd);
  const closesParent = parent >= 0 && areTagNamesEquivalent(hir.jsxCloseTag[jsx] | 0, parent);
  // `TagName().Loc` starts where the `<` or the `</` ends.
  if (closesParent) {
    const from = (start + 1) | 0;
    errorArgs(17008, from, from === nameEnd ? -1 : nameEnd, [written]);
  } else {
    const from = ((hir.jsxClosePos[jsx] | 0) + 2) | 0;
    errorArgs(17002, from, from === endOfName ? -1 : endOfName, [written]);
  }
  if (!closesParent && !isInExpression) rescanJsxChild();
  const r = pushExprJsx(start, hir.jsxEnd[jsx] | 0, jsx);
  jsxClosesParent = closesParent;
  return r;
}

/** `tagNamesAreEquivalent`, for names that are not written the same. */
function areTagNamesEquivalent(a0: number, b0: number): boolean {
  let a = a0;
  let b = b0;
  while (true) {
    if (a < 0 || a >= hir.nExprs || b < 0 || b >= hir.nExprs) return false;
    const ta = hir.exprTag[a] | 0;
    const tb = hir.exprTag[b] | 0;
    if (ta === EXPR_DOT && tb === EXPR_DOT) {
      if ((hir.exprB[a] | 0) !== (hir.exprB[b] | 0)) return false;
      a = hir.exprA[a] | 0;
      b = hir.exprA[b] | 0;
      continue;
    }
    if ((ta === EXPR_IDENT && tb === EXPR_IDENT) || (ta === EXPR_STRING && tb === EXPR_STRING)) return (hir.exprA[a] | 0) === (hir.exprA[b] | 0);
    if ((ta === EXPR_THIS && tb === EXPR_THIS) || (ta === EXPR_MISSING && tb === EXPR_MISSING)) return true;
    return false;
  }
}

/** `scanJsxIdentifier` */
function scanJsxIdentifier(): void {
  if (lx.token >= T_IDENTIFIER && (lx.hasEscape || (p.recovers && lx.end < lx.len && (lx.src[lx.end] | 0) === 45))) unusualJsxIdentifier();
  lx.scanJsxIdentifier();
}

function isPlainJsxByte(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c === 45;
}

/** `ScanJsxIdentifier` for a name that `Lexer::scan_jsx_identifier` does not read, and the error of `parseIdentifierNameErrorOnUnicodeEscapeSequence`. */
function unusualJsxIdentifier(): void {
  if (!p.recovers) {
    report();
    return;
  }
  const src = lx.src;
  const len = lx.len;
  const from = lx.end | 0;
  let plain = 0;
  while (from + plain < len && isPlainJsxByte(src[from + plain] | 0)) plain = (plain + 1) | 0;
  const after = from + plain < len ? src[from + plain] | 0 : -1;
  if (!lx.hasEscape && lx.token !== T_PRIVATE_IDENTIFIER && !(after === 92 || after >= 0x80)) return;
  let text = atomText(lx.atom);
  let end = from;
  for (;;) {
    if (end >= len) break;
    const b = src[end] | 0;
    let cp = 0;
    let size = 0;
    if (b === 45) {
      cp = 45;
      size = 1;
    } else if (b === 92) {
      const n = unicodeEscapeAt(src, len, end);
      if (n === 0 || !isTypeScriptIdentifierPart(ESC_CP[0] | 0)) break;
      lx.hasEscape = true;
      cp = ESC_CP[0] | 0;
      size = n;
    } else if (b < 0x80) {
      cp = b;
      size = 1;
      if (!isTypeScriptIdentifierPart(cp)) break;
    } else {
      // A UTF-8 sequence.
      const n = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      if (end + n > len) break;
      cp = n === 4 ? b & 7 : n === 3 ? b & 15 : b & 31;
      for (let k = 1; k < n; k++) cp = (cp << 6) | ((src[end + k] | 0) & 63);
      size = n;
      if (!isTypeScriptIdentifierPart(cp)) break;
    }
    text += String.fromCodePoint(cp);
    end = (end + size) | 0;
  }
  if (end > from) {
    lx.atom = names.atomOfString(text);
    lx.end = end;
  }
  lx.token = T_IDENTIFIER;
  if (lx.hasEscape) errorAtToken(17021);
}

/** `parseIdentifierNameErrorOnUnicodeEscapeSequence`, at a token that `scanJsxIdentifier` has not made an identifier of. */
function jsxIdentifierAtAnotherToken(): number {
  if (!p.recovers) {
    fail();
    return ATOM_NONE;
  }
  if (lx.token !== T_PRIVATE_IDENTIFIER) return missingIdentifier(0, 0);
  // `ScanJsxIdentifier` makes an identifier of it, whose text has the `#`.
  unusualJsxIdentifier();
  const name = lx.atom | 0;
  next();
  return name;
}

/**
 * `parseJsxTagName`, `parseJsxAttributeName`: the text of the name (an atom), which may have a namespace. Its start is in `p.outPos`,
 * `p.outA` is 1 if it is anything but an identifier.
 */
function jsxName(): number {
  const end = lx.end;
  scanJsxIdentifier();
  if (lx.token !== T_IDENTIFIER) return jsxNameAtAnotherToken();
  const name = lx.atom;
  const start = lx.start;
  // It is a name of JavaScript then, which has neither a `-` nor a `:`.
  const isAsScanned = lx.end === end;
  lx.next();
  if (isAsScanned && lx.token !== T_COLON) {
    p.outPos = start;
    p.outA = 0;
    return name;
  }
  return restOfJsxName(name, start);
}

/** `jsxName`, where no identifier is. A name that is missing is empty, and no identifier. */
function jsxNameAtAnotherToken(): number {
  const start = lx.start;
  const name = jsxIdentifierAtAnotherToken();
  if (name < 0) {
    p.outPos = start;
    p.outA = 0;
    return name;
  }
  const r = restOfJsxName(name, start);
  if (r === A_empty) p.outA = 1;
  return r;
}

/** True if the text of the atom has a `-` or a `:`. */
function hasDashOrColon(atom: number): boolean {
  const buf = names.textBuf(atom);
  const st = names.textStart(atom);
  const n = names.textLen(atom);
  for (let i = 0; i < n; i++) {
    const c = buf[(st + i) | 0] | 0;
    if (c === 45 || c === 58) return true;
  }
  return false;
}

/** `jsxName`, after the first identifier, which is `name` and starts at `start`. */
function restOfJsxName(name0: number, start: number): number {
  let name = name0;
  if (lx.token === T_COLON) {
    lx.next();
    scanJsxIdentifier();
    if (lx.token !== T_IDENTIFIER) return jsxNameWithoutLocalName(name, start);
    name = jsxNamespacedName(name, lx.atom);
    lx.next();
  }
  p.outPos = start;
  p.outA = hasDashOrColon(name) ? 1 : 0;
  return name;
}

/** The text of a `JsxNamespacedName`, which has no blanks around the colon. */
function jsxNamespacedName(namespace: number, local: number): number {
  joined.len = 0;
  joined.append(names.textBuf(namespace), names.textStart(namespace), (names.textStart(namespace) + names.textLen(namespace)) | 0);
  joined.push(58);
  joined.append(names.textBuf(local), names.textStart(local), (names.textStart(local) + names.textLen(local)) | 0);
  return names.atomOfBytes(joined.data, 0, joined.len);
}

/** `restOfJsxName`, where no identifier follows the colon after `namespace`. */
function jsxNameWithoutLocalName(namespace: number, start: number): number {
  const local = jsxIdentifierAtAnotherToken();
  if (local < 0) {
    p.outPos = start;
    p.outA = 0;
    return local;
  }
  const name = jsxNamespacedName(namespace, local);
  p.outPos = start;
  p.outA = 1;
  return name;
}

/** `parseJsxElementName` */
function jsxElementName(): number {
  const name = jsxName();
  const start = p.outPos | 0;
  const isSpecial = (p.outA | 0) !== 0;
  let expr = NONE;
  if (isSpecial) {
    // `createMissingIdentifier`
    if (name === A_empty) {
      expr = pushExprMissing(start, lx.fullStart);
    } else {
      // TODO(oxc): oxc takes `a-b.c`.
      return pushExprString(start, lx.fullStart, name);
    }
  } else if (name === A_this) {
    expr = pushExprThis(start, lx.fullStart);
  } else {
    expr = pushExprIdent(start, lx.fullStart, name);
  }
  if (lx.token === T_DOT) noteIdentifier(name, start);
  while (eat(T_DOT)) {
    let member: number;
    let memberPos: number;
    if (p.recovers) {
      member = jsxMemberName();
      memberPos = p.outPos | 0;
    } else {
      if (lx.hasEscape) report();
      member = identifierName();
      memberPos = p.outPos | 0;
    }
    expr = pushExprDot(start, lx.fullStart, expr, member, memberPos, CHAIN_NO);
  }
  return expr;
}

/** `parseRightSideOfDot(true, false, false)`: the name and, in `p.outPos`, where the node is. */
function jsxMemberName(): number {
  const token = lx.token | 0;
  let isOfNextStatement = false;
  if (token >= T_IDENTIFIER && lx.newlineBefore) {
    const m = lx.mark();
    const had = lx.refusal | 0;
    lx.next();
    isOfNextStatement = lx.token >= T_IDENTIFIER && !lx.newlineBefore;
    lookAheadEnd(m, had);
  }
  if (token === T_PRIVATE_IDENTIFIER && !isOfNextStatement) next();
  if (token === T_PRIVATE_IDENTIFIER || isOfNextStatement) {
    const at = lx.fullStart | 0;
    error(1003, at, -1);
    p.outPos = at;
    return A_empty;
  }
  if (token < T_IDENTIFIER) {
    const at = lx.fullStart | 0;
    const name = missingIdentifier(0, 0);
    p.outPos = at;
    return name;
  }
  if (lx.hasEscape) errorAtToken(17021);
  const name = lx.atom | 0;
  p.outPos = lx.start | 0;
  next();
  return name;
}

/** `parseJsxAttributes`. Returns the list start, the length is in `p.outLen`. */
function jsxAttributes(): number {
  const base = s.props.len;
  const lists = enterList(LK_JSX_ATTRIBUTES);
  while (true) {
    if (lx.token === T_OPEN_BRACE) {
      // `parseJsxSpreadAttribute`
      const start = lx.start;
      lx.next();
      expect(T_DOT_DOT_DOT);
      const value = jsxExpression();
      expect(T_CLOSE_BRACE);
      const pos = firstOperandPos(value);
      s.props.push(hir.pushProp(PROP_SPREAD, PK_NONE, NONE, NK_JSX, value, pos, start, lx.fullStart, 0, 0, 0));
      continue;
    }
    if (lx.token < T_IDENTIFIER || lx.token === T_PRIVATE_IDENTIFIER) {
      if (!p.recovers || lx.token === T_GREATER_THAN || lx.token === T_SLASH || !isAtElement(LK_JSX_ATTRIBUTES)) break;
      if (lx.token === T_OPEN_BRACE) continue;
    }
    // `parseJsxAttribute`
    const name = jsxName();
    const pos = p.outPos | 0;
    let value = NONE;
    let braces = -1;
    if (lx.token === T_EQUALS) {
      // `parseJsxAttributeValue`
      lx.scanJsxAttributeValue();
      switch (lx.token) {
        case T_STRING:
          value = pushExprString(lx.start, lx.end, lx.atom);
          lx.next();
          break;
        case T_OPEN_BRACE: {
          const open = lx.start;
          braces = open;
          lx.next();
          value = lx.token === T_CLOSE_BRACE ? emptyJsxAttributeValue(open) : jsxExpression();
          expect(T_CLOSE_BRACE);
          break;
        }
        case T_LESS_THAN:
          if (p.recovers) {
            skipBlanksAfterEquals();
            value = jsxElements(false);
          } else value = jsxElement(true, NONE);
          break;
        default:
          missingJsxAttributeValue();
          break;
      }
    }
    const end = lx.fullStart | 0;
    if (braces >= 0) hir.pushJsxExpression(value, braces, end);
    s.props.push(hir.pushProp(PROP_INIT, PK_NAME, name, NK_JSX, value, pos, pos, end, 0, 0, 0));
  }
  leaveList(lists);
  return takeList(s.props, base);
}

/** `parseJsxAttributeValue`, at a token that starts no value. */
function missingJsxAttributeValue(): void {
  if (!p.recovers) {
    fail();
    return;
  }
  errorAtToken(1145);
  skipBlanksAfterEquals();
}

/** `ScanJsxAttributeValue` leaves what is no string to `Scan`, after the blanks that follow the `=`: `TokenFullStart()` is there. */
function skipBlanksAfterEquals(): void {
  const src = lx.src;
  const len = lx.len;
  let i = lx.fullStart | 0;
  while (i < len) {
    const c = src[i] | 0;
    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 10 || c === 13) i = (i + 1) | 0;
    else if (c === 0xc2 && (src[i + 1] | 0) === 0xa0) i = (i + 2) | 0;
    else if (c === 0xe2 && (src[i + 1] | 0) === 0x80 && ((src[i + 2] | 0) === 0xa8 || (src[i + 2] | 0) === 0xa9)) i = (i + 3) | 0;
    else break;
  }
  lx.fullStart = i;
}

/** `parseJsxExpression` for `name={}`, which the checker reports. The missing expression is placed at the opening brace. */
function emptyJsxAttributeValue(open: number): number {
  if (!p.recovers) {
    refuse(R_REPORTED);
    return NONE;
  }
  return pushExprMissing(open, open);
}

/** The expression between braces. `parseJsxExpression` stays in the context of the element. */
function jsxExpression(): number {
  return p.isEcmascript ? expressionAllowingIn() : expression();
}

/** `parseJsxExpression` among the children of the element that starts at `element`. */
function jsxExpressionChild(element: number): number {
  const open = lx.start;
  lx.next();
  let e = NONE;
  if (lx.token === T_CLOSE_BRACE) {
    // The missing expression is placed at the opening brace.
    e = pushExprMissing(open, open);
  } else if (eat(T_DOT_DOT_DOT)) {
    const operand = jsxExpression();
    e = pushExprSpread(element, lx.fullStart, operand);
  } else {
    e = jsxExpression();
  }
  if (lx.token !== T_CLOSE_BRACE) {
    unclosedJsxExpressionChild(e, open);
    return e;
  }
  hir.pushJsxExpression(e, open, lx.end);
  lx.nextJsxChild();
  return e;
}

/** `parseExpectedWithoutAdvancing(KindCloseBraceToken)` after `e` and the `{` at `open`, at another token. */
function unclosedJsxExpressionChild(e: number, open: number): void {
  expected(T_CLOSE_BRACE);
  if (p.recovers) {
    hir.pushJsxExpression(e, open, lx.fullStart);
    rescanJsxChild();
  }
}
