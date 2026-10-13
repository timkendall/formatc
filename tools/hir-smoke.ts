// Smoke test of src/sema/hir.ts + hir_util.ts (node and compiled): builds `a.b(c)` and a parenthesized expression by hand.
import {
  CHAIN_NO, EXPR_DOT, EXPR_CALL, FLAG_EXPORT, STMT_INTERFACE, hir, NONE,
  pushExprDot, pushExprIdent, pushExprCall, exprDotObj, exprDotName, exprDotNamePos, exprDotChain, exprTag,
  pushStmtInterface, stmtInterfaceInterface,
} from "../src/sema/hir.ts";
import { beginFile, finishHir, isParenthesized, openParenthesis, endOfExpr, startOf, isEntityNameExpression, firstIdentifier } from "../src/sema/hir_util.ts";
import { A_this, A_require } from "../src/sema/atom.ts";

function check(name: string, ok: boolean): void {
  if (!ok) {
    console.log("FAIL", name);
    process.exitCode = 1;
  } else console.log("ok  ", name);
}

const src = new Uint8Array(64);
for (let round = 0; round < 3; round++) {
  beginFile(src, 20);
  const a = pushExprIdent(0, 1, 7);
  const dot = pushExprDot(0, 3, a, 9, 2, CHAIN_NO);
  const callId = hir.newCall();
  hir.callCallee[callId] = dot;
  const call = pushExprCall(0, 6, callId);
  check("tag", exprTag(dot) === EXPR_DOT && exprTag(call) === EXPR_CALL);
  check("dot fields", exprDotObj(dot) === a && exprDotName(dot) === 9 && exprDotNamePos(dot) === 2 && exprDotChain(dot) === CHAIN_NO);
  check("call defaults", hir.callTemplate[callId] === NONE && hir.callClosePos[callId] === NONE);
  check("firstIdentifier", firstIdentifier(dot) === a);
  check("entity name", isEntityNameExpression(dot));
  // parens: out of order, finish sorts
  hir.pushParen(dot, 0, 5);
  hir.pushParen(a, 0, 2);
  hir.pushParen(a, 0, 3);
  finishHir();
  check("parens sorted", hir.parenExpr[0] === a && hir.parenExpr[2] === dot);
  check("isParenthesized", isParenthesized(a) && isParenthesized(dot) && !isParenthesized(call));
  check("openParenthesis/end", openParenthesis(a) === 0 && endOfExpr(a) === 3 && endOfExpr(call) === 6 && startOf(call) === 0);
  const iface = hir.newInterface();
  const st = pushStmtInterface(0, iface);
  check("interface back ref", hir.interfaceStmt[iface] === st && stmtInterfaceInterface(st) === iface && hir.stmtTag[st] === STMT_INTERFACE);
  check("nodes counted", hir.nExprs === 3 && hir.nCalls === 1);
  void FLAG_EXPORT;
  void A_this;
  void A_require;
}
// growth
beginFile(src, 20);
for (let i = 0; i < 100000; i++) pushExprIdent(i, i + 1, i);
check("growth", hir.nExprs === 100000 && hir.exprA[99999] === 99999 && hir.exprEnd[99999] === 100000);
const l = hir.listFrom(new Int32Array([5, 6, 7, 8]), 4, 1);
check("listFrom", hir.ids[l] === 6 && hir.ids[l + 2] === 8 && hir.idsLen === 3);
