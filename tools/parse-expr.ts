// Parses each argument as one expression with the sema parser (no statements needed) and prints a compact S-expression.
//   node tools/parse-expr.ts [--ts|--tsx|--js] 'a + b * c' ...
import { beginFile, finishHir } from "../src/sema/hir_util.ts";
import { beginParse, lx, next, p } from "../src/sema/parser/parser/mod.ts";
import { expression } from "../src/sema/parser/parser/expr.ts";
import { dialectBabel, refusalName } from "../src/sema/parser/lib.ts";
import { hir } from "../src/sema/hir.ts";
import { names } from "../src/sema/parser/parser/mod.ts";
import { dumpExpr } from "./hir-dump.ts";

let mode = "ts";
for (const a of process.argv.slice(2)) {
  if (a === "--ts" || a === "--tsx" || a === "--js") {
    mode = a.slice(2);
    continue;
  }
  const text = Buffer.from(a);
  const src = new Uint8Array(text.length + 16);
  src.set(text);
  beginFile(src, text.length);
  lx.begin(src, text.length);
  const isJs = mode === "js";
  beginParse(false, mode !== "ts", isJs, false, false, false, dialectBabel(false), false);
  next();
  const e = expression();
  finishHir();
  const rest = lx.token;
  if (lx.refusal !== 0) console.log(JSON.stringify(a), "REFUSED", refusalName(lx.refusal), "at", lx.refusedAt);
  else console.log(JSON.stringify(a), rest === 0 ? "" : "(TRAILING TOKEN " + rest + " at " + lx.start + ")", dumpExpr(e));
  void p;
  void hir;
  void names;
}
