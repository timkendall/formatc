// Robustness fuzz of the sema lexer: mutated corpus files, every mode (jsx / recovers / dialects), random rescans.
// Checks: it terminates (progress), never throws, positions stay in range.   node tools/lex-fuzz.ts [--iters N] [--seed S]
import * as fs from "node:fs";
import { Lexer } from "../src/sema/parser/lexer.ts";
import { Names } from "../src/sema/parser/names.ts";
import {
  T_CLOSE_BRACE, T_EOF, T_GREATER_THAN, T_IDENTIFIER, T_SLASH, T_SLASH_EQUALS, T_STRING, T_TEMPLATE_HEAD, T_LESS_THAN, T_EQUALS, T_OPEN_BRACE,
} from "../src/sema/parser/token.ts";
import { DIALECT_BABEL, DIALECT_ECMASCRIPT, DIALECT_OXC, DIALECT_SCRIPT, DIALECT_TYPESCRIPT_5 } from "../src/sema/parser/lib.ts";

function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length - 1; i++) if (a[i] === name) return a[i + 1];
  return dflt;
}
let seed = parseInt(arg("--seed", "12345"), 10) >>> 0;
function rnd(n: number): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed >>> 8) % n;
}
const iters = parseInt(arg("--iters", "3000"), 10);
const files = fs.readFileSync("/tmp/vscode-files.txt", "utf8").split("\n").filter((p) => /\.(ts|tsx|js|mts)$/.test(p));
const names = new Names();
const lx = new Lexer(names);
const dialects = [0, DIALECT_TYPESCRIPT_5, DIALECT_TYPESCRIPT_5 | DIALECT_ECMASCRIPT | DIALECT_BABEL, DIALECT_ECMASCRIPT | DIALECT_BABEL | DIALECT_SCRIPT, DIALECT_OXC | DIALECT_ECMASCRIPT | DIALECT_SCRIPT];
const interesting = [0, 10, 13, 34, 39, 47, 42, 92, 96, 36, 123, 125, 60, 62, 0xe2, 0x80, 0xa8, 0xff, 0xc3, 0x28, 35, 33, 63, 46, 48, 49, 95, 120, 110, 101];
let bad = 0;
let total = 0;
for (let it = 0; it < iters; it++) {
  const f = files[rnd(files.length)];
  const orig = fs.readFileSync("bench/vscode/" + f);
  const take = Math.min(orig.length, 200 + rnd(6000));
  const b = Buffer.alloc(take + 16);
  const from = rnd(Math.max(1, orig.length - take));
  orig.copy(b, 0, from, from + take);
  const muts = rnd(6);
  for (let m = 0; m < muts; m++) b[rnd(take)] = interesting[rnd(interesting.length)];
  const cfg = rnd(dialects.length);
  const jsx = rnd(2) === 1;
  const recovers = rnd(2) === 1;
  lx.begin(b, take);
  lx.configure(dialects[cfg], jsx, rnd(2) === 1, false, recovers);
  try {
    lx.next();
    let steps = 0;
    let depth = 0;
    const tpl: number[] = [];
    while (lx.token !== T_EOF) {
      steps++;
      if (steps > take * 4 + 100) throw new Error("no progress");
      if (lx.start < 0 || lx.end > take || lx.end < lx.start) throw new Error("bad range " + lx.start + " " + lx.end);
      const t = lx.token;
      const r = rnd(8);
      if ((t === T_SLASH || t === T_SLASH_EQUALS) && r < 5) lx.rescanSlash();
      else if (t === T_GREATER_THAN && r < 3) lx.rescanGreaterThan();
      else if (t === T_CLOSE_BRACE && tpl.length > 0 && tpl[tpl.length - 1] === depth) {
        lx.rescanTemplateContinuation();
        if (lx.token !== T_TEMPLATE_HEAD && lx.token !== 12 + 0 && lx.token !== T_TEMPLATE_HEAD) tpl.pop();
      } else if (t === T_TEMPLATE_HEAD) tpl.push(depth);
      else if (t === T_OPEN_BRACE) depth++;
      else if (t === T_CLOSE_BRACE) depth--;
      else if (jsx && t === T_LESS_THAN && r < 4) {
        lx.next();
        if (lx.token >= T_IDENTIFIER) lx.scanJsxIdentifier();
        lx.nextJsxChild();
        if (lx.token === T_OPEN_BRACE) lx.next();
        continue;
      } else if (t === T_EQUALS && jsx && r < 3) {
        lx.scanJsxAttributeValue();
        continue;
      } else if (r === 7) {
        const m = lx.mark();
        lx.next();
        lx.next();
        if (rnd(2) === 0) lx.reset(m);
        else lx.release(m);
      }
      lx.next();
    }
    if (lx.markTop !== 0) throw new Error("mark stack not empty " + lx.markTop);
    total += steps;
  } catch (e) {
    bad++;
    if (bad <= 5) console.log("FUZZ FAIL", f, take, "cfg", cfg, "jsx", jsx, "recovers", recovers, String(e));
  }
}
console.log({ iters, steps: total, failures: bad });
void T_STRING;
if (bad) process.exitCode = 1;
