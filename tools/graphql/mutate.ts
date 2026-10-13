// Mutants of the GraphQL inputs of a directory, for tools/graphql/fmt.ts vs oracle.ts:
//   node tools/graphql/mutate.ts <indir> <outdir> <count> [seed] [parts]
// The mutants are written to <outdir>/p<k>/m<i>.graphql (`parts` directories, so that the oracle can run in parallel).
import * as fs from "node:fs";

let state = parseInt(process.argv[5] ?? "1") >>> 0;
function rnd(n: number): number {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return (state >>> 8) % n;
}
const dict = [
  "{", "}", "(", ")", "[", "]", ":", "=", "@", "$", "!", "&", "|", "...", ",", " ", "  ", "\n", "\n\n", "\n\n\n", "\r\n", "\r", "\t", "#", "# c", "# prettier-ignore\n",
  "#", "\"", "\"\"\"", "\"\"\" a \"\"\"", "\\", "\\n", "\\u00e9", "\\u{1F600}", "\\uD83D\\uDE00", "\\uD83D", "\\x", "\\\"",
  "query", "mutation", "subscription", "fragment", "on", "type", "interface", "union", "enum", "input", "scalar", "schema", "directive", "extend", "implements", "repeatable",
  "true", "false", "null", "0", "-1", "1.5", "1e10", "01", "1.", "1a", "-", "x", "A", "_", "é", "日本", "😀", " ", "﻿", " ", "\0",
  "QUERY", "FIELD", "INPUT_FIELD_DEFINITION", "__typename", "{ a }", "(a: 1)", "@a", "@a(b: [1,2])", "[1, 2, 3]", "{a: 1, b: [x]}", "$a: Int = 1", "String!", "[A!]!",
];
const indir = process.argv[2];
const outdir = process.argv[3];
const count = parseInt(process.argv[4]);
const parts = parseInt(process.argv[6] ?? "8");
const names = fs.readdirSync(indir);
const seeds = names.map((n) => fs.readFileSync(indir + "/" + n).toString("utf8"));
for (let k = 0; k < parts; k++) fs.mkdirSync(outdir + "/p" + k, { recursive: true });
for (let i = 0; i < count; i++) {
  let s = seeds[rnd(seeds.length)];
  const rounds = process.env.GENTLE ? 1 + rnd(2) : 1 + rnd(4);
  for (let r = 0; r < rounds; r++) {
    const at = rnd(s.length + 1);
    switch (process.env.GENTLE ? [4, 5, 6, 7, 8, 8, 1, 0][rnd(8)] : rnd(9)) {
      case 0: // insert a token
        s = s.slice(0, at) + dict[rnd(dict.length)] + s.slice(at);
        break;
      case 1: // delete a range
        s = s.slice(0, at) + s.slice(at + rnd(12));
        break;
      case 2: // replace a range
        s = s.slice(0, at) + dict[rnd(dict.length)] + s.slice(at + rnd(6));
        break;
      case 3: // truncate
        s = s.slice(0, at);
        break;
      case 4: { // duplicate a line
        const lines = s.split("\n");
        const l = rnd(lines.length);
        lines.splice(l, 0, lines[l]);
        s = lines.join("\n");
        break;
      }
      case 5: { // move a line
        const lines = s.split("\n");
        const l = rnd(lines.length);
        const [line] = lines.splice(l, 1);
        lines.splice(rnd(lines.length + 1), 0, line);
        s = lines.join("\n");
        break;
      }
      case 6: // line endings
        s = s.replace(/\n/g, ["\r\n", "\r", "\n\n", "\n"][rnd(4)]);
        break;
      case 7: // comment out or in a line
        {
          const lines = s.split("\n");
          const l = rnd(lines.length);
          lines[l] = lines[l].startsWith("#") ? lines[l].slice(1) : "# " + lines[l];
          s = lines.join("\n");
        }
        break;
      default: // insert a comment somewhere
        s = s.slice(0, at) + (rnd(2) === 0 ? " # c\n" : "\n# c\n") + s.slice(at);
        break;
    }
  }
  fs.writeFileSync(outdir + "/p" + (i % parts) + "/m" + i + ".graphql", s);
}
