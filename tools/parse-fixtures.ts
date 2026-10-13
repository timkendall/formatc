// Accept/refuse agreement of the sema parser with `bun fmt` on a set of files (Prettier's fixtures, ...).
//   bun /tmp/pa/oracle.ts <dir> /tmp/pa/oracle.json          (what bun accepts: exit code 0 of `bun fmt --stdin-filepath`)
//   node tools/parse-fixtures.ts <dir> /tmp/pa/oracle.json [--show N]
import * as fs from "node:fs";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { lx } from "../src/sema/parser/parser/mod.ts";
import { refusalName } from "../src/sema/parser/lib.ts";

const dir = process.argv[2];
const oracle: Record<string, number> = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
let show = 30;
const si = process.argv.indexOf("--show");
if (si > 0) show = parseInt(process.argv[si + 1], 10);
let ok = 0;
let both = 0;
let onlyOurs = 0;
let onlyBun = 0;
const shownOurs: string[] = [];
const shownBun: string[] = [];
for (const f of Object.keys(oracle).sort()) {
  const buf = fs.readFileSync(dir + "/" + f);
  const src = new Uint8Array(buf.length + 16);
  src.set(buf);
  const ext = f.slice(f.lastIndexOf("."));
  const path = "stdin" + ext;
  const kinds = ext === ".mjs" || ext === ".mts" ? 1 : ext === ".cjs" || ext === ".cts" ? 2 : 3;
  let r = 1;
  if ((kinds & 1) !== 0) r = parseFile(src, buf.length, path, false);
  if (r !== 0 && (kinds & 2) !== 0) r = parseFile(src, buf.length, path, true);
  const bunOk = oracle[f] === 0;
  const ourOk = r === 0;
  if (bunOk === ourOk) {
    ok++;
    if (!ourOk) both++;
  } else if (ourOk) {
    onlyBun++;
    if (shownBun.length < show) shownBun.push(f);
  } else {
    onlyOurs++;
    if (shownOurs.length < show) shownOurs.push(f + "  " + refusalName(r) + " at " + lx.refusedAt);
  }
}
console.log("files", Object.keys(oracle).length, "agree", ok, "(both refuse:", both + ")", "refused by us only", onlyOurs, "refused by bun only", onlyBun);
for (const s of shownOurs) console.log("  US ONLY:", s);
for (const s of shownBun) console.log("  BUN ONLY:", s);
