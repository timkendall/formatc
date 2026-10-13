// Pathological inputs (deep nesting, quadratic traps): the port must agree with the Rust parser, and finish.
//   node tools/md/diff-stress.ts
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dump, parseSettings } from "./events.ts";
import { cases } from "./stress-cases.ts";

const oracle = path.join(import.meta.dirname, "rust-oracle/target/release/mdoracle");
const configs = [
  "--track --hooks --read-leaves +tables +math_blocks +footnotes +no_single_tilde +micromark +micromark_to_the_letter -tasklists",
  "--track --hooks +latex_math +wiki_links +permissive_autolinks +footnotes +math_blocks +directives +micromark +mdx",
  "--track +wiki_links +permissive_autolinks +footnotes +directives +micromark_to_the_letter -tasklists",
  "+footnotes +directives +micromark +micromark_to_the_letter +latex_math +collapse_whitespace",
  "+wiki_links +permissive_autolinks +latex_math +footnotes +directives",
];
let bad = 0;
fs.mkdirSync("/tmp/md-diffs", { recursive: true });
for (const cfg of configs) {
  const flags = cfg.split(/\s+/);
  const settings = parseSettings(flags);
  for (const [name, text] of cases) {
    const bytes = Buffer.from(text);
    const f = `/tmp/md-diffs/stress.md`;
    fs.writeFileSync(f, bytes);
    const t0 = performance.now();
    const mine = dump(bytes, settings);
    const t1 = performance.now();
    const r = cp.spawnSync(oracle, [...flags, f], { maxBuffer: 1 << 30 });
    const t2 = performance.now();
    const theirs = r.stdout.toString("utf8");
    const ok = r.status === 0 && mine === theirs;
    if (!ok) bad++;
    if (!ok || t1 - t0 > 500) console.log(`${ok ? "ok  " : "DIFF"} ${name}: ours ${(t1 - t0).toFixed(0)} ms, rust ${(t2 - t1).toFixed(0)} ms ${r.status !== 0 ? "rust status " + r.status + " " + r.stderr.toString().slice(0, 200) : ""}`);
  }
}
console.log(`${configs.length * cases.length} stress runs, ${bad} differ`);
process.exit(bad === 0 ? 0 : 1);
