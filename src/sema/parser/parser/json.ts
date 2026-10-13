// Port of vendor/bun/src/sema/parser/parser/json.rs: a JSON file as a source file: `parseJSONText`.
import {
  BIN_COMMA,
  NONE,
  UN_MINUS,
  hir,
  pushExprArray,
  pushExprObject,
  pushExprUnary,
  pushStmtExportAssign,
} from "../../hir.ts";
import {
  T_CLOSE_BRACE,
  T_COLON,
  T_EOF,
  T_FALSE,
  T_MINUS,
  T_NULL,
  T_NUMBER,
  T_OPEN_BRACKET,
  T_STRING,
  T_TRUE,
} from "../token.ts";
import { errorAtToken, lookAheadEnd, lx, next, p, pos, s, takeIds, hasFailed } from "./mod.ts";
import { leftHandSideExpression, objectLiteral, primaryExpression } from "./expr.ts";

/** After a token that may be a name: whether the next token is no `:` (inside a lookahead). */
function isNoName(): boolean {
  next();
  return lx.token !== T_COLON;
}

/**
 * `parseJSONText`, at the first token: the value of the file. `bindSourceFileIfExternalModule`: the file is an `export =` of it.
 * What is no JSON is left to `bun_sema::json::validate_json`. Returns the StmtId.
 */
export function jsonText(): number {
  const start = lx.start | 0;
  const base = s.ids.len;
  // No list of statements is open.
  p.lists = 0;
  while (lx.token !== T_EOF) {
    let isValue = false;
    const t = lx.token | 0;
    if (t === T_OPEN_BRACKET || t === T_TRUE || t === T_FALSE || t === T_NULL) {
      isValue = true;
    } else if (t === T_MINUS) {
      const m = lx.mark();
      const had = lx.refusal | 0;
      next();
      isValue = lx.token === T_NUMBER && isNoName();
      lookAheadEnd(m, had);
    } else if (t === T_NUMBER || t === T_STRING) {
      const m = lx.mark();
      const had = lx.refusal | 0;
      isValue = isNoName();
      lookAheadEnd(m, had);
    }
    let expr: number;
    if (t === T_MINUS && isValue) {
      const minus = pos();
      next();
      const operand = leftHandSideExpression();
      expr = pushExprUnary(minus, lx.fullStart, operand, UN_MINUS);
    } else if (isValue) {
      expr = primaryExpression();
    } else {
      expr = objectLiteral();
    }
    if (hasFailed()) break;
    s.ids.push(expr);
    // "Error recovery: collect multiple top-level expressions"
    if (s.ids.len === base + 1 && lx.token !== T_EOF) errorAtToken(1012);
  }
  const count = s.ids.len - base;
  let value: number;
  if (count === 1) {
    value = s.ids.data[base] | 0;
    s.ids.len = base;
  } else if (count === 0) {
    value = pushExprObject(start, start, 0, 0);
  } else {
    const elements = takeIds(base);
    value = pushExprArray(start, lx.fullStart, elements, p.outLen);
  }
  // It is written nowhere.
  const id = pushStmtExportAssign(0, value);
  void BIN_COMMA;
  void NONE;
  void hir;
  void T_CLOSE_BRACE;
  return id;
}
