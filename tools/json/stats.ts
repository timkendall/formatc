// How many of the JSON files of the corpus have comments, and how many bytes they are. `node tools/json/stats.ts`.
import * as fs from "node:fs";
import { FormatOptions } from "../../src/format/options.ts";
import { kindOf, outParser, KIND_JSON } from "../../src/driver/kinds.ts";
import { Config } from "../../src/format/json/config.ts";
import { tree } from "../../src/format/json/parser.ts";

const names = fs.readFileSync("/tmp/vscode-files.txt", "utf8").split("\n");
const o = new FormatOptions();
const cfg = new Config();
let files = 0, cfiles = 0, bytes = 0, cbytes = 0, nodes = 0;
const hist: Record<string, number> = {};
for (const n of names) {
  if (!n || kindOf(n, "") !== KIND_JSON) continue;
  const parser = outParser;
  const b = fs.readFileSync("bench/vscode/" + n);
  cfg.set(parser, o, b);
  tree.parse(b, cfg);
  files++; bytes += b.length; nodes += tree.nodeCount;
  if (tree.commentCount > 0) { cfiles++; cbytes += b.length; }
  const ext = n.slice(n.lastIndexOf("."));
  hist[ext] = (hist[ext] || 0) + 1;
}
console.log({ files, cfiles, bytes, cbytes, nodes }, hist);
