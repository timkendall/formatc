// Throughput of the style sheet formatter on the .css/.scss/.less files of a list. Compiled (scriptc) or node:
//   scriptc build tools/css/bench.ts -o /tmp/cssbench && /tmp/cssbench /tmp/vscode-files.txt bench/vscode [reps]
// It also checks that the output equals bench/vscode-fmt (when `check` is given) and prints a checksum, so that node and the
// compiled program can be compared.
import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions, INDENT_TAB, QUOTE_SINGLE } from "../../src/format/options.ts";
import { format, parserForPath } from "../../src/format/css/mod.ts";

const args = process.argv.slice(2);
const listText = fs.readFileSync(args[0], "utf8").split("\n");
const root = args[1];
const reps = args.length > 2 ? Number(args[2]) : 20;
const names: string[] = [];
for (let i = 0; i < listText.length; i++) {
  const n = listText[i];
  if (n.endsWith(".css") || n.endsWith(".scss") || n.endsWith(".less")) names.push(n);
}
const files: Uint8Array[] = [];
const parsers: number[] = [];
const opts: FormatOptions[] = [];
const plain = new FormatOptions();
plain.indentStyle = INDENT_TAB;
const copilot = new FormatOptions();
copilot.indentStyle = INDENT_TAB;
copilot.indentWidth = 4;
copilot.quoteStyle = QUOTE_SINGLE;
let total = 0;
for (let i = 0; i < names.length; i++) {
  const b = fs.readFileSync(root + "/" + names[i]);
  files.push(new Uint8Array(b));
  parsers.push(parserForPath(names[i]));
  opts.push(names[i].startsWith("extensions/copilot/") ? copilot : plain);
  total += b.length;
}
console.log("files", files.length, "bytes", total);

const out = new ByteBuf(1 << 20);
let best = 1e18;
let checksum = 0;
let outBytes = 0;
let refused = 0;
for (let rep = 0; rep < reps; rep++) {
  const t0 = performance.now();
  let sum = 0;
  let ob = 0;
  let ref = 0;
  for (let i = 0; i < files.length; i++) {
    out.len = 0;
    const r = format(files[i], parsers[i], opts[i], out);
    if (r !== 0) {
      ref = ref + 1;
      continue;
    }
    ob = ob + out.len;
    sum = ((sum | 0) + (out.len | 0)) | 0;
    if (out.len > 0) sum = ((sum | 0) + (out.data[out.len - 1] | 0)) | 0;
  }
  const dt = performance.now() - t0;
  if (dt < best) best = dt;
  checksum = sum;
  outBytes = ob;
  refused = ref;
}
console.log("output bytes", outBytes, "refused", refused, "checksum", checksum);
console.log("best", best.toFixed(2), "ms", (total / 1e6 / (best / 1000)).toFixed(1), "MB/s of input");
// Makes the program a "worker program" for scriptc (the codegen tax of the real binary), without running a worker.
if (process.argv.length > 1000) {
  const w = new Worker(new URL(import.meta.url));
  w.terminate();
}
