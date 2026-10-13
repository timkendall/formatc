// Prints "path result refusedAt exprs stmts types diagnostics" for every file of a list (node and compiled must print the same).
//   node tools/parse-dir.ts ROOT LIST     (LIST: one relative path per line)
import * as fs from "node:fs";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { lx } from "../src/sema/parser/parser/mod.ts";
import { hir } from "../src/sema/hir.ts";

const root = process.argv[2];
const lines = fs.readFileSync(process.argv[3], "utf8").split("\n");
let out = "";
for (let i = 0; i < lines.length; i++) {
  const f = lines[i];
  if (f.length === 0) continue;
  const buf = fs.readFileSync(root + "/" + f);
  const src = new Uint8Array(buf.length + 16);
  src.set(buf);
  const ext = f.slice(f.lastIndexOf("."));
  const kinds = ext === ".mjs" || ext === ".mts" ? 1 : ext === ".cjs" || ext === ".cts" ? 2 : 3;
  let r = 1;
  if ((kinds & 1) !== 0) r = parseFile(src, buf.length, "stdin" + ext, false);
  if (r !== 0 && (kinds & 2) !== 0) r = parseFile(src, buf.length, "stdin" + ext, true);
  out += f + " " + r + " " + (r !== 0 ? lx.refusedAt : -1) + " " + hir.nExprs + " " + hir.nStmts + " " + hir.nTypes + " " + hir.diagnosticsLen + " " + hir.rareSyntax + " " + hir.idsLen + "\n";
}
process.stdout.write(out);
