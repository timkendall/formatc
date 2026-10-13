// Time of the postcss parse alone (tokenizer + tree) over the style sheets of a list, compiled or node.
import * as fs from "node:fs";
import { PostcssParser, PLACEHOLDER_AT_RULE } from "../../src/format/css/postcss.ts";

const args = process.argv.slice(2);
const listText = fs.readFileSync(args[0], "utf8").split("\n");
const root = args[1];
const reps = args.length > 2 ? Number(args[2]) : 20;
const files: Uint8Array[] = [];
const syntaxes: number[] = [];
let total = 0;
for (let i = 0; i < listText.length; i++) {
  const n = listText[i];
  if (!(n.endsWith(".css") || n.endsWith(".scss") || n.endsWith(".less"))) continue;
  const b = fs.readFileSync(root + "/" + n);
  files.push(new Uint8Array(b));
  syntaxes.push(n.endsWith(".less") ? 1 : n.endsWith(".scss") ? 2 : 0);
  total += b.length;
}
const parser = new PostcssParser();
let best = 1e18;
let nodes = 0;
for (let rep = 0; rep < reps; rep++) {
  const t0 = performance.now();
  let n = 0;
  for (let i = 0; i < files.length; i++) {
    const t = parser.parseText(files[i], files[i].length, syntaxes[i], 0, false, PLACEHOLDER_AT_RULE);
    if (t !== null) n = n + t.n;
  }
  const dt = performance.now() - t0;
  if (dt < best) best = dt;
  nodes = n;
}
console.log("parse only: best", best.toFixed(2), "ms", (total / 1e6 / (best / 1000)).toFixed(1), "MB/s", "nodes", nodes);
