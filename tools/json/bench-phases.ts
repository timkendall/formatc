// Where the time goes: parse only, parse + write. `scriptc build tools/json/bench-phases.ts -o /tmp/json-phases && /tmp/json-phases`.
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { kindOf, outParser, KIND_JSON } from "../../src/driver/kinds.ts";
import { Config } from "../../src/format/json/config.ts";
import { tree } from "../../src/format/json/parser.ts";
import { write } from "../../src/format/json/writer.ts";

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
  // only files without comments (the fast path)
  bufs.push(b);
  parsers.push(parser);
  total += b.length;
}
const o = new FormatOptions();
o.set("useTabs", "true");
const cfg = new Config();
const out = new ByteBuf(1 << 20);
let bestP = 1e18;
let bestW = 1e18;
let sum = 0;
for (let r = 0; r < reps; r++) {
  let t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < bufs.length; i++) {
    cfg.set(parsers[i], o, bufs[i]);
    acc = acc + tree.parse(bufs[i], cfg) + tree.nodeCount;
  }
  let dt = performance.now() - t0;
  if (dt < bestP) bestP = dt;
  sum = acc;
  t0 = performance.now();
  for (let i = 0; i < bufs.length; i++) {
    cfg.set(parsers[i], o, bufs[i]);
    if (tree.parse(bufs[i], cfg) < 0) continue;
    if (tree.commentCount > 0) continue;
    out.reset();
    acc = acc + write(bufs[i], tree, cfg, out) + out.len;
  }
  dt = performance.now() - t0;
  if (dt < bestW) bestW = dt;
}
console.log("parse: " + bestP.toFixed(1) + " ms = " + (total / 1e6 / (bestP / 1000)).toFixed(0) + " MB/s; parse+write (no comments files): " + bestW.toFixed(1) + " ms; " + sum);
