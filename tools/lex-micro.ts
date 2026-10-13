// ns/token of the sema lexer on synthetic inputs (pull loop: next() until EOF).   scriptc build tools/lex-micro.ts -o /tmp/lex-micro
import { Lexer } from "../src/sema/parser/lexer.ts";
import { Names } from "../src/sema/parser/names.ts";
import { T_EOF } from "../src/sema/parser/token.ts";

const names = new Names();
const lx = new Lexer(names);

function make(unit: string, reps: number): Buffer {
  const u = Buffer.from(unit, "utf8");
  const b = Buffer.alloc(u.length * reps + 16);
  for (let i = 0; i < reps; i++) u.copy(b, i * u.length);
  return b;
}
function run(label: string, unit: string, tokensPerUnit: number): void {
  const reps = 200000;
  const b = make(unit, reps);
  const len = b.length - 16;
  let best = 1e18;
  let tokens = 0;
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    lx.begin(b, len);
    lx.configure(0, false, false, false, false);
    lx.next();
    let n = 0;
    while (lx.token !== T_EOF) {
      n = ((n | 0) + 1) | 0;
      lx.next();
    }
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
    tokens = n;
  }
  console.log(label.padEnd(34), (best * 1e6 / tokens).toFixed(1).padStart(6), "ns/token", (len / 1e6 / (best / 1000)).toFixed(0).padStart(5), "MB/s  tokens", tokens, "expected", tokensPerUnit * reps);
}
run("a ; (name space punct space)", "a ; ", 2);
run("; ; ; ; (punct space)", "; ; ; ; ", 4);
run("foo bar baz (short names)", "foo bar baz ", 3);
run("someLongerIdentifier_name x", "someLongerIdentifierName x ", 2);
run("this const return (keywords)", "this const return ", 3);
run("{}()[] (punct no space)", "{}()[]", 6);
run("\\n\\t\\t\\tfoo (indented line)", "\n\t\t\tfoo", 1);
run("// comment of about 40 bytes....\\n;", "// comment of about forty bytes ok\n;", 1);
run("'string' 'other' (strings)", "'string' 'other' ", 2);
run("123 456.5 0xff (numbers)", "123 456.5 0xff ", 3);
run("a.b.c (member)", "a.b.c ", 5);
run("=== !== && (multi punct)", "=== !== && ", 3);
