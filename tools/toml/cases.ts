// The cases of vendor/bun/test/cli/format/toml-layout.test.ts (Bun's own layout), and some of toml.test.ts (oxfmt).
//   node tools/toml/cases.ts
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FLAVOR_OXFMT, FormatOptions } from "../../src/format/options.ts";
import { formatToml } from "../../src/format/toml/mod.ts";

const dir = new URL("../../vendor/bun/test/cli/format/", import.meta.url).pathname;
const src = fs.readFileSync(dir + "toml-layout.test.ts", "utf8");
const a = src.indexOf("const cases: [name: string, input: string, output: string][] = [");
const b = src.indexOf("\n];\n", a);
const literal = src.slice(src.indexOf("= [", a) + 2, b + 3);
const cases: [string, string, string][] = new Function("return " + literal)();

const out = new ByteBuf(1 << 16);
function fmt(text: string, o: FormatOptions): [number, string] {
  const bytes = Buffer.from(text, "utf8");
  out.reset();
  const r = formatToml(bytes, bytes.length, o, out);
  return [r, Buffer.from(out.view()).toString("utf8")];
}

let ok = 0;
let total = 0;
for (const [name, input, expected] of cases) {
  total++;
  const [r, got] = fmt(input, new FormatOptions());
  const [r2, again] = fmt(got, new FormatOptions());
  if (r === 0 && got === expected && again === expected) ok++;
  else {
    console.log("DIFF layout:", name, "status", r, r2);
    console.log("  expected:", JSON.stringify(expected));
    console.log("  got:     ", JSON.stringify(got));
    if (again !== got) console.log("  again:   ", JSON.stringify(again));
  }
}

function check(name: string, text: string, expected: string, setup: (o: FormatOptions) => void): void {
  total++;
  const o = new FormatOptions();
  setup(o);
  const [r, got] = fmt(text, o);
  if (r === 0 && got === expected) ok++;
  else {
    console.log("DIFF", name, "status", r);
    console.log("  expected:", JSON.stringify(expected));
    console.log("  got:     ", JSON.stringify(got));
  }
}

const oxfmt = (o: FormatOptions) => {
  o.flavor = FLAVOR_OXFMT;
};
check("printWidth, useTabs, trailingComma and endOfLine", 'a = ["aaaaaaaa", "bbbbbbbb"]\n', 'a = [\r\n\t"aaaaaaaa",\r\n\t"bbbbbbbb"\r\n]\r\n', (o) => {
  oxfmt(o);
  o.set("printWidth", "20");
  o.set("useTabs", "true");
  o.set("trailingComma", "none");
  o.set("endOfLine", "crlf");
});
const crtext = 'a = 1\r\n\r\n\r\n\r\n\r\nb   = [\r\n 1, # c\r\n 2\r\n]\r\ns = """\r\nx\r\n"""\r\n';
check("crlf as lf", crtext, 'a = 1\n\n\nb = [\n  1, # c\n  2,\n]\ns = """\r\nx\r\n"""\n', oxfmt);
check("crlf as crlf", crtext, 'a = 1\r\n\r\n\r\nb = [\r\n  1, # c\r\n  2,\r\n]\r\ns = """\r\nx\r\n"""\r\n', (o) => {
  oxfmt(o);
  o.set("endOfLine", "crlf");
});
check(
  "numbers, dates, strings and keys",
  'big   = 123456789012345678901234567890\nhex=0xDEAD_beef\n"a b" . \'c\'=1979-05-27 07:32:00.123456789123\ns = "\\u00e9\\t"\n',
  'big = 123456789012345678901234567890\nhex = 0xDEAD_beef\n"a b".\'c\' = 1979-05-27 07:32:00.123456789123\ns = "\\u00e9\\t"\n',
  oxfmt,
);
check("128 deep", `a   = ${"[".repeat(128)}${"]".repeat(128)}\n`, `a = ${"[".repeat(128)}${"]".repeat(128)}\n`, (o) => {
  oxfmt(o);
  o.set("printWidth", "320");
});
const commented = `a = ["x", {\n  b = 1, # c\n  d = 2,\n}]\n`;
const expanded = `a = [\n  "x",\n  {\n    b = 1, # c\n    d = 2,\n  },\n]\n`;
check("table with comment, oxfmt", commented, expanded, oxfmt);
check("table with comment, oxfmt (b)", expanded, expanded, oxfmt);
check("table with comment, bun", commented, commented, () => {});
for (const [before, after] of [
  ["a = { # c\n b = 1 }\n", "a = { # c\n  b = 1,\n}\n"],
  ["a = { b = 1 # c\n, d = 2 }\n", "a = {\n  b = 1, # c\n  d = 2,\n}\n"],
  ["a = { b = 1,\n # c\n d = 2 }\n", "a = {\n  b = 1,\n  # c\n  d = 2,\n}\n"],
  ["a = { b = 1, d = 2 # c\n }\n", "a = {\n  b = 1,\n  d = 2, # c\n}\n"],
]) {
  check("wherever the comment is " + JSON.stringify(before), before, after, oxfmt);
  check("wherever the comment is (b) " + JSON.stringify(after), after, after, oxfmt);
}
check("trailingComma none, tabs, crlf in a multi-line table (bun)", `a = ["x", {\n  b = 1, # c\n  d = 2,\n}]\n`, `a = ["x", {\r\n\tb = 1, # c\r\n\td = 2\r\n}]\r\n`, (o) => {
  o.set("trailingComma", "none");
  o.set("useTabs", "true");
  o.set("endOfLine", "crlf");
});
// Nested too deeply
{
  const text = `a   = ${"[".repeat(200_000)}${"]".repeat(200_000)}\n`;
  const [r] = fmt(text, (() => { const o = new FormatOptions(); oxfmt(o); o.set("printWidth", "320"); return o; })());
  total++;
  if (r === 3) ok++;
  else console.log("DIFF deep: status", r, "(want 3)");
}
console.log(`toml cases: ${ok}/${total}`);
