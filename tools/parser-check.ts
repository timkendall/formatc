// Accept/refuse check of the sema parser against TypeScript's parser for single files (the targeted torture cases).
//   node tools/parser-check.ts tools/parser-cases/*.ts tools/parser-cases/*.tsx
// For each file: TypeScript's `parseDiagnostics` (the syntax errors) and the refusal of ours, with line:col.
import * as fs from "node:fs";
import * as ts from "typescript";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { lx } from "../src/sema/parser/parser/mod.ts";
import { refusalName } from "../src/sema/parser/lib.ts";

function lineCol(text: string, pos: number): string {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      col = 1;
    } else col++;
  }
  return `${line}:${col}`;
}

let bad = 0;
for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file);
  const text = buf.toString("utf8");
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const diags = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  const src = new Uint8Array(buf.length + 16);
  src.set(buf);
  const r = parseFile(src, buf.length, file, false);
  const ours = r === 0 ? "ok" : `REFUSED ${refusalName(r)} at ${lineCol(buf.toString("latin1"), lx.refusedAt)}`;
  const theirs = diags.length === 0 ? "ok" : `${diags.length} errors, first ${lineCol(text, diags[0].start ?? 0)} ${ts.flattenDiagnosticMessageText(diags[0].messageText, " ")}`;
  const same = (r === 0) === (diags.length === 0);
  if (!same) bad++;
  console.log(`${same ? "  " : "!!"} ${file}: ts: ${theirs} | ours: ${ours}`);
}
process.exit(bad === 0 ? 0 : 1);
