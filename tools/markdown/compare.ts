// Formats every `.md` of bench/vscode with src/format/markdown (vscode's .editorconfig: tabs) and compares it with what
// `bun fmt` made of it (bench/vscode-fmt/<same path>).
//
//   node tools/markdown/compare.ts [--list=/tmp/vscode-files.txt] [--show=N] [--out=/tmp/mdcmp]
//
// Prints the match rate and the files that differ. `--out` writes <n>.ours / <n>.theirs / <n>.input for each difference.
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions, INDENT_TAB, QUOTE_SINGLE } from "../../src/format/options.ts";
import { format } from "../../src/format/markdown/mod.ts";

const root = new URL("../../bench/", import.meta.url).pathname;
const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const a = args.find((x) => x.startsWith("--" + name + "="));
  return a === undefined ? dflt : a.slice(name.length + 3);
};
const list = fs.readFileSync(opt("list", "/tmp/vscode-files.txt"), "utf8").split("\n").filter((l) => l.endsWith(".md"));
const outDir = opt("out", "");
const show = Number(opt("show", "20"));
const options = new FormatOptions();
options.indentStyle = INDENT_TAB;
// extensions/copilot/package.json: "prettier": { "useTabs": true, "tabWidth": 4, "singleQuote": true }
const copilot = new FormatOptions();
copilot.indentStyle = INDENT_TAB;
copilot.indentWidth = 4;
copilot.quoteStyle = QUOTE_SINGLE;

let same = 0;
let bytes = 0;
const diffs: string[] = [];
const t0 = performance.now();
let n = 0;
for (const rel of list) {
  const input = new Uint8Array(fs.readFileSync(root + "vscode/" + rel));
  const theirs = fs.readFileSync(root + "vscode-fmt/" + rel);
  const out = new ByteBuf(input.length + 64);
  const r = format(input, rel.startsWith("extensions/copilot/") ? copilot : options, out);
  bytes += input.length;
  const ours = Buffer.from(out.data.buffer, out.data.byteOffset, out.len);
  if (r === 0 && ours.equals(theirs)) same++;
  else {
    diffs.push(rel);
    if (outDir !== "") {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(`${outDir}/${diffs.length}.ours`, ours);
      fs.writeFileSync(`${outDir}/${diffs.length}.theirs`, theirs);
      fs.writeFileSync(`${outDir}/${diffs.length}.input`, input);
      fs.writeFileSync(`${outDir}/${diffs.length}.name`, rel);
    }
  }
  n++;
}
const ms = performance.now() - t0;
console.log(`${same}/${list.length} files equal (${((100 * same) / list.length).toFixed(2)}%), ${(bytes / 1e6).toFixed(2)} MB in ${ms.toFixed(0)} ms (node, cold)`);
for (let i = 0; i < Math.min(show, diffs.length); i++) console.log("DIFF", i + 1, diffs[i]);
