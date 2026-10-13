// Formats every .css/.scss/.less file of bench/vscode (list: /tmp/vscode-files.txt) and compares byte for byte with
// bench/vscode-fmt/<path> (what `bun fmt` made of it, with the .editorconfig of vscode: tabs). A file that we refuse must be
// one that `bun fmt` leaves as it is (its output equals its input). Dev tool (node):
//   node tools/css/compare.ts [--list=/tmp/vscode-files.txt] [--filter=text] [--show=N] [--stop]
import { readFileSync, existsSync } from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions, INDENT_TAB, QUOTE_SINGLE } from "../../src/format/options.ts";
import { format, parserForPath } from "../../src/format/css/mod.ts";
import { refusalMessage, refusalOffset, messageText } from "../../src/format/syntax_error.ts";

const root = new URL("../../", import.meta.url).pathname;
let list = "/tmp/vscode-files.txt";
let filter = "";
let show = 5;
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--list=")) list = a.slice(7);
  else if (a.startsWith("--filter=")) filter = a.slice(9);
  else if (a.startsWith("--show=")) show = Number(a.slice(7));
}
const names = readFileSync(list, "utf8").split("\n").filter((n) => /\.(css|scss|less)$/i.test(n) && n.includes(filter));
const options = new FormatOptions();
options.indentStyle = INDENT_TAB;
// extensions/copilot/package.json has "prettier": { "useTabs": true, "tabWidth": 4, "singleQuote": true }
const copilot = new FormatOptions();
copilot.indentStyle = INDENT_TAB;
copilot.indentWidth = 4;
copilot.quoteStyle = QUOTE_SINGLE;
let ok = 0;
let refusedOk = 0;
const diffs: string[] = [];
const wrongRefusals: string[] = [];
let bytes = 0;
const t0 = performance.now();
for (const name of names) {
  const src = new Uint8Array(readFileSync(root + "bench/vscode/" + name));
  const oracleFile = root + "bench/vscode-fmt/" + name;
  const oracle = existsSync(oracleFile) ? new Uint8Array(readFileSync(oracleFile)) : null;
  bytes += src.length;
  const out = new ByteBuf(src.length * 2 + 64);
  const parser = parserForPath(name);
  const r = format(src, parser, name.startsWith("extensions/copilot/") ? copilot : options, out);
  if (r !== 0) {
    const same = oracle !== null && Buffer.compare(Buffer.from(oracle), Buffer.from(src)) === 0;
    if (same) refusedOk++;
    else wrongRefusals.push(`${name}: refused (${r} ${r === 2 ? messageText(refusalMessage()) + " at " + refusalOffset() : ""}), bun formatted it`);
    continue;
  }
  const got = Buffer.from(out.view());
  if (oracle !== null && Buffer.compare(got, Buffer.from(oracle)) === 0) ok++;
  else diffs.push(name);
}
const dt = performance.now() - t0;
console.log(`${names.length} files, ${(bytes / 1e6).toFixed(2)} MB: ${ok} identical, ${refusedOk} refused as bun, ${diffs.length} differ, ${wrongRefusals.length} refused wrongly (${dt.toFixed(0)} ms)`);
for (const d of diffs.slice(0, show)) console.log("DIFF " + d);
for (const d of wrongRefusals.slice(0, show)) console.log("REFUSED " + d);
if (diffs.length > show) console.log(`... ${diffs.length - show} more differ`);
