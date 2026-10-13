// Parses the files / snippets given on the command line with the sema parser and prints the refusal.
//   node tools/parse-smoke.ts [--path name.ts] [--script] 'snippet' ...     |   node tools/parse-smoke.ts file.ts ...
import * as fs from "node:fs";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { lx } from "../src/sema/parser/parser/mod.ts";
import { refusalName } from "../src/sema/parser/lib.ts";
import { hir } from "../src/sema/hir.ts";

let path = "a.ts";
let isScript = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--path") {
    path = args[++i];
    continue;
  }
  if (a === "--script") {
    isScript = true;
    continue;
  }
  const text = fs.existsSync(a) ? fs.readFileSync(a) : Buffer.from(a);
  const src = new Uint8Array(text.length + 16);
  src.set(text);
  const p = fs.existsSync(a) ? a : path;
  const r = parseFile(src, text.length, p, isScript);
  console.log(JSON.stringify(fs.existsSync(a) ? a : a.slice(0, 60)), r === 0 ? "ok" : "REFUSED " + refusalName(r) + " at " + lx.refusedAt, "exprs", hir.nExprs, "stmts", hir.nStmts, "diag", hir.diagnosticsLen / 4);
}
