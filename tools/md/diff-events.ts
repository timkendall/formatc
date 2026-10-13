// Differential test of the event stream of the TS port against the Rust parser (tools/md/rust-oracle, build it with
// tools/md/rust-oracle/build.sh): the same documents, the same options, every callback (also those of `track` mode and
// of the extensions) must be called with the same arguments in the same order.
//   node tools/md/diff-events.ts [--fuzz N] [--seed S] [--only spec|vscode|prettier] [--show K] [--config NAME]
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Doc } from "./corpus.ts";
import { mutate, prettierDocs, specDocs, vscodeDocs } from "./corpus.ts";
import { dump, parseSettings } from "./events.ts";

const oracle = path.join(import.meta.dirname, "rust-oracle/target/release/mdoracle");

const FORMATTER = "+tables +math_blocks +footnotes +no_single_tilde +micromark +micromark_to_the_letter -tasklists";
const configs: [string, string][] = [
  ["bare", ""],
  ["formatter", `--track --hooks --read-leaves ${FORMATTER}`],
  ["formatter-noread", `--track --hooks ${FORMATTER}`],
  ["oxfmt", "--track --hooks --read-leaves +tables +math_blocks +footnotes +no_single_tilde +directives +micromark -tasklists"],
  ["mdx", `--track --hooks --read-leaves ${FORMATTER} +mdx`],
  ["plain", "--track --hooks +footnotes +no_single_tilde +micromark +micromark_to_the_letter -tasklists -tables"],
  ["notrack-all", "+latex_math +wiki_links +underline +permissive_autolinks +collapse_whitespace +permissive_atx_headers +hard_soft_breaks +footnotes +math_blocks +directives"],
  ["track-all", "--track --hooks +latex_math +wiki_links +permissive_autolinks +collapse_whitespace +footnotes +math_blocks +directives +micromark"],
  ["nocode-nohtml", "--track +no_indented_code_blocks +no_html_blocks +no_html_spans"],
  ["notrack-hooks", `--hooks ${FORMATTER}`],
  ["mdx-notrack", `--hooks ${FORMATTER} +mdx`],
  ["gfm-off", "--bare"],
];

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const fuzz = Number(argOf("--fuzz", "0"));
const seed = Number(argOf("--seed", "1"));
const only = argOf("--only", "");
const show = Number(argOf("--show", "3"));
const onlyConfig = argOf("--config", "");

const sets: [string, Doc[]][] = [];
if (!only || only === "spec") sets.push(["spec", specDocs()]);
if (!only || only === "vscode") sets.push(["vscode", vscodeDocs()]);
if (!only || only === "prettier") sets.push(["prettier", prettierDocs(true)]);
if (fuzz > 0) sets.push(["fuzz", mutate(sets.flatMap(([, d]) => d), fuzz, seed)]);

fs.mkdirSync("/tmp/md-diffs", { recursive: true });
let total = 0;
let diffs = 0;
for (const [setName, docs] of sets) {
  const pack = Buffer.concat(docs.flatMap((d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(d.bytes.length);
    return [len, d.bytes];
  }));
  const packFile = `/tmp/md-pack-${setName}.bin`;
  fs.writeFileSync(packFile, pack);
  for (const [cfgName, cfg] of configs) {
    if (onlyConfig && onlyConfig !== cfgName) continue;
    const flags = cfg.split(/\s+/).filter(Boolean);
    const settings = parseSettings(flags);
    const res = cp.spawnSync(oracle, ["--pack", ...flags, packFile], { maxBuffer: 1 << 30 });
    if (res.status !== 0) throw new Error("oracle failed: " + res.stderr);
    const theirs = res.stdout.toString("latin1").split(/^#### \d+\n/m);
    theirs.shift();
    let n = 0;
    let d = 0;
    for (let i = 0; i < docs.length; i++) {
      const mine = Buffer.from(dump(docs[i].bytes, settings), "utf8").toString("latin1");
      n++;
      if (mine !== theirs[i]) {
        d++;
        if (d <= show) {
          const base = `/tmp/md-diffs/ev-${setName}-${cfgName}-${d}`;
          fs.writeFileSync(base + ".md", docs[i].bytes);
          fs.writeFileSync(base + ".ours", mine, "latin1");
          fs.writeFileSync(base + ".rust", theirs[i] ?? "", "latin1");
          console.log(`DIFF ${setName} ${docs[i].name} [${cfgName}] -> ${base}.*  (flags: ${cfg})`);
        }
      }
    }
    console.log(`${setName} / ${cfgName}: ${n} documents, ${d} differ`);
    total += n;
    diffs += d;
  }
}
console.log(`total ${total}, ${diffs} differ`);
process.exit(diffs === 0 ? 0 : 1);
