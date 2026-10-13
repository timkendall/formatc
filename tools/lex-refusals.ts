// Lists the files the sema lexer refuses, with the position and the text around it.  node tools/lex-refusals.ts [--limit N]
import * as fs from "node:fs";
import { Driver } from "./lexdriver.ts";
import { refusalName } from "../src/sema/parser/lib.ts";
const lines = fs.readFileSync("/tmp/vscode-files.txt", "utf8").split("\n");
const limit = parseInt(process.argv[3] || "0", 10);
const d = new Driver();
let n = 0;
for (const p of lines) {
  if (!(p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js") || p.endsWith(".mts") || p.endsWith(".mjs") || p.endsWith(".cjs"))) continue;
  if (limit && n++ >= limit) break;
  const b = fs.readFileSync("bench/vscode/" + p);
  d.run(b, b.length, p.endsWith("x"));
  if (d.lx.refusal !== 0) {
    const at = d.lx.refusedAt;
    const text = b.toString("utf8", Math.max(0, at - 30), at + 30).replace(/\n/g, "\\n");
    console.log(refusalName(d.lx.refusal), p, "@", at, JSON.stringify(text));
  }
}
