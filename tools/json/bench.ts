// Throughput of the JSON formatter on the JSON files of the vscode corpus: `scriptc build tools/json/bench.ts -o /tmp/json-bench &&
// /tmp/json-bench /tmp/vscode-files.txt bench/vscode [reps]` (or `node tools/json/bench.ts ...`).
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { kindOf, outParser, KIND_JSON } from "../../src/driver/kinds.ts";
import { formatJson } from "../../src/format/json/mod.ts";

const listPath = process.argv[2] ?? "/tmp/vscode-files.txt";
const root = (process.argv[3] ?? "bench/vscode").replace(/\/$/, "") + "/";
const reps = Number(process.argv[4] ?? "20");
const names = fs.readFileSync(listPath, "utf8").split("\n");
const bufs: Uint8Array[] = [];
const parsers: number[] = [];
let total = 0;
for (let i = 0; i < names.length; i++) {
  const n = names[i];
  if (n.length === 0) continue;
  if (kindOf(n, "") !== KIND_JSON) continue;
  const parser = outParser;
  const b = fs.readFileSync(root + n);
  bufs.push(b);
  parsers.push(parser);
  total += b.length;
}
const o = new FormatOptions();
o.set("useTabs", "true");
const out = new ByteBuf(1 << 20);
let best = 1e18;
let sum = 0;
for (let r = 0; r < reps; r++) {
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < bufs.length; i++) {
    out.reset();
    const st = formatJson(bufs[i], bufs[i].length, parsers[i], o, out);
    acc = acc + st + out.len;
  }
  const dt = performance.now() - t0;
  sum = acc;
  if (dt < best) best = dt;
}
console.log(bufs.length + " files, " + (total / 1e6).toFixed(2) + " MB; best " + best.toFixed(1) + " ms = " + (total / 1e6 / (best / 1000)).toFixed(0) + " MB/s (checksum " + sum + ")");
