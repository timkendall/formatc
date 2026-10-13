// Throughput of src/format/markdown over a list of files (vscode's Markdown, tabs as vscode's .editorconfig says).
//   node tools/markdown/bench.ts LIST ROOT [REPS]        or compiled: scriptc build tools/markdown/bench.ts -o /tmp/mdfmtbench
// LIST: paths relative to ROOT, one per line (only those ending in .md are used).
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions, INDENT_TAB } from "../../src/format/options.ts";
import { format } from "../../src/format/markdown/mod.ts";

const args = process.argv.slice(2);
const list = fs.readFileSync(args[0], "utf8").split("\n").filter((l) => l.endsWith(".md"));
const root = args[1];
const reps = args.length > 2 ? Number(args[2]) : 5;
const files: Uint8Array[] = [];
let total = 0;
for (let i = 0; i < list.length; i++) {
  const b = fs.readFileSync(root + "/" + list[i]);
  files.push(new Uint8Array(b));
  total += b.length;
}
console.log("files", files.length, "bytes", total);

const options = new FormatOptions();
options.indentStyle = INDENT_TAB;
const out = new ByteBuf(1 << 20);
let best = 1e18;
let sink = 0;
for (let rep = 0; rep < reps; rep++) {
  const t0 = performance.now();
  for (let i = 0; i < files.length; i++) {
    out.reset();
    sink = sink + format(files[i], options, out) + out.len;
  }
  const dt = performance.now() - t0;
  if (dt < best) best = dt;
}
console.log("best", best.toFixed(2), "ms;", (total / 1e6 / (best / 1000)).toFixed(1), "MB/s; sink", sink);
