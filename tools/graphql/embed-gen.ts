// Random statements `<tag>`<template>`;` for embed-check.ts (node only):
//   node tools/graphql/embed-gen.ts <outdir> <count> [seed]
import * as fs from "node:fs";

const outdir = process.argv[2];
const count = parseInt(process.argv[3]);
let state = parseInt(process.argv[4] ?? "1") >>> 0;
const rnd = (n: number): number => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return (state >>> 8) % n;
};
const pick = <T>(a: T[]): T => a[rnd(a.length)];
const pieces = [
  "query { a }", "query Q($a: Int = 1) { a(b: $a) { c d } }", "fragment F on T { a b }", "{ a b c }", "type A { b: C }", "# a comment", "# other comment\n",
  "mutation { a(b: \"str\") }", "\"\"\"\n  desc\n\"\"\"\ntype A { b: Int }", "query { a(b: \"with \\\\\\\\ backslash\") }", "query { a(b: \"\\\\u00e9\") }",
  "", "  ", "\n", "\n\n", "\n\n\n", "# c1\n\n# c2", "query { a } # trailing", "{ a(b: [1, 2, {c: 3}]) @d }", "enum E { A B }", "\\`", "\\${", "{ a(b: \"\\`\") }",
  "query { a(b: \"very long string value that makes the line long enough to break the arguments\", c: 1, d: 2) }",
];
const subs = ["${a}", "${frag}", "${a.b}", "${x}"];
const tags = ["gql", "graphql", "gql"];
for (let k = 0; k < count; k++) {
  let s = pick(tags) + "`";
  const n = 1 + rnd(4);
  for (let j = 0; j < n; j++) {
    s += pick(["", "\n", "\n  ", "\n\n", "\n\n\n  "]) + pick(pieces) + pick(["", "\n", "\n\n", " ", "\n  "]);
    if (j + 1 < n) s += pick(subs);
  }
  s += pick(["", "\n"]) + "`;\n";
  fs.writeFileSync(outdir + "/e" + k + ".js", s);
}
