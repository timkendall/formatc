// Nesting limits of the parser: parses `((((a))))`, `[[[a]]]`, `{{{}}}`, `if (a) else if` chains... N levels deep.
//   node tools/parse-deep.ts N [limit]
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { lx, p } from "../src/sema/parser/parser/mod.ts";
import { refusalName } from "../src/sema/parser/lib.ts";

const n = parseInt(process.argv[2], 10);
if (process.argv[3]) p.depthLimit = parseInt(process.argv[3], 10);
const cases: [string, string][] = [
  ["parens", "(".repeat(n) + "a" + ")".repeat(n) + ";"],
  ["arrays", "[".repeat(n) + "a" + "]".repeat(n) + ";"],
  ["blocks", "{".repeat(n) + "}".repeat(n)],
  ["else-if", "if (a) b; " + "else if (a) b; ".repeat(n)],
  ["ternary", "a" + " ? b : c".repeat(n) + ";"],
  ["ternary-right", "a ? b : ".repeat(n) + "c;"],
  ["unary", "!".repeat(n) + "a;"],
  ["new", "new ".repeat(n) + "a;"],
  ["objects", "x = " + "{a: ".repeat(n) + "1" + "}".repeat(n) + ";"],
  ["calls", "f(".repeat(n) + "a" + ")".repeat(n) + ";"],
  ["arrows", "a => ".repeat(n) + "b;"],
  ["types", "type T = " + "Array<".repeat(n) + "a" + ">".repeat(n) + ";"],
  ["fn-nesting", "function f() { ".repeat(n) + "}".repeat(n)],
  ["classes", "class A { m() { ".repeat(n) + "} }".repeat(n)],
  ["binary-long", "a" + " + a".repeat(n) + ";"],
  ["member-long", "a" + ".b".repeat(n) + ";"],
  ["pow", "a" + " ** a".repeat(n) + ";"],
];
for (const [name, text] of cases) {
  const buf = Buffer.from(text);
  const src = new Uint8Array(buf.length + 16);
  src.set(buf);
  let r = -1;
  try {
    r = parseFile(src, buf.length, "a.ts", false);
  } catch (e) {
    console.log(name.padEnd(14), "EXCEPTION", String(e).slice(0, 60));
    continue;
  }
  console.log(name.padEnd(14), r === 0 ? "ok" : "REFUSED " + refusalName(r), r === 0 ? "" : "at " + lx.refusedAt);
}
