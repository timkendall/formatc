import * as fs from "node:fs";
import { PostcssParser } from "../../src/format/css/postcss.ts";
const listText = fs.readFileSync("/tmp/vscode-files.txt", "utf8").split("\n");
const files: Uint8Array[] = [];
let total = 0;
for (const n of listText) {
  if (!(n.endsWith(".css"))) continue;
  const b = fs.readFileSync("bench/vscode/" + n);
  files.push(new Uint8Array(b));
  total += b.length;
}
const parser = new PostcssParser();
let best = 1e18;
let tokens = 0;
for (let rep = 0; rep < 50; rep++) {
  const t0 = performance.now();
  let n = 0;
  for (let i = 0; i < files.length; i++) {
    n = n + parser.tokenizeOnly(files[i], files[i].length);
  }
  const dt = performance.now() - t0;
  if (dt < best) best = dt;
  tokens = n;
}
console.log("tokenize only: best", best.toFixed(2), "ms", (total / 1e6 / (best / 1000)).toFixed(1), "MB/s", "tokens", tokens, "css bytes", total);
