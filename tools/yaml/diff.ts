// Differential test of the YAML formatter against `bun fmt` (the oracle): corpus files and mutants of them, under several
// sets of options. Run with node: `node tools/yaml/diff.ts [--fuzz=N] [--seed=S] [--show=K] [--sets=a,b]`.
//
// The cases of a set of options are files of a directory with a `.prettierrc.json`; `bun fmt <dir>` rewrites them (in
// parallel) and the result is compared with ours. A file that Bun refuses stays as it is: ours has to refuse it too
// (the text is compared, not the message).
import * as cp from "node:child_process";
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { formatYaml } from "../../src/format/yaml/mod.ts";
import { Rng, prettierFiles, vscodeFiles } from "../parsers/corpus.ts";
import type { Case } from "../parsers/corpus.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const args = process.argv.slice(2);
function arg(name: string, def: string): string {
  const a = args.find((x) => x.startsWith("--" + name + "="));
  return a === undefined ? def : a.slice(name.length + 3);
}
const FUZZ = Number(arg("fuzz", "3"));
const SEED = Number(arg("seed", "1"));
const SHOW = Number(arg("show", "8"));
const SETS = arg("sets", "").split(",").filter((x) => x);
const BUN = process.env.HOME + "/.bun/bin/bun";

// A set whose name starts with `oxfmt` has an `.oxfmtrc.json` (Bun's oxfmt flavor).
const SET_OPTIONS: Record<string, Record<string, string | number | boolean>> = {
  default: {},
  pragma: { insertPragma: true },
  require: { requirePragma: true },
  range: { rangeStart: 20, rangeEnd: 80 },
  crlf: { endOfLine: "crlf" },
  oxfmt: {},
  oxfmtwrap: { proseWrap: "always", printWidth: 30 },
  oxfmtquotes: { singleQuote: true, bracketSpacing: false, tabWidth: 4, trailingComma: "none" },
  wrap: { proseWrap: "always", printWidth: 30 },
  never: { proseWrap: "never", printWidth: 40 },
  quotes: { singleQuote: true, bracketSpacing: false, tabWidth: 4, trailingComma: "none" },
  tabs: { useTabs: true, tabWidth: 3, printWidth: 50 },
  wide: { printWidth: 200, proseWrap: "always" },
  narrow: { printWidth: 10 },
};

function ownCases(dir: string, out: Case[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) ownCases(`${dir}/${e.name}`, out);
    else if (/\.ya?ml\.input$/.test(e.name)) out.push({ name: `own/${e.name}`, bytes: fs.readFileSync(`${dir}/${e.name}`) });
  }
}

function mutate(rng: Rng, input: Buffer): Buffer {
  let out = Array.from(input);
  const count = 1 + rng.below(3);
  const chars = ": -?[]{},#&*!|>'\"%\n\t.\\@".split("").map((c) => c.charCodeAt(0));
  const words = ["# note", "key: value", "- item", "? q", "&a x", "*a", "!!str s", "|", ">-", "---", "...", "{a: 1}", "[1, 2]", "'q'", '"d"'];
  for (let m = 0; m < count; m++) {
    const kind = rng.below(10);
    const at = out.length === 0 ? 0 : rng.below(out.length);
    switch (kind) {
      case 0:
        out = out.slice(0, at).concat([rng.pick(chars)], out.slice(at));
        break;
      case 1:
        out = out.slice(0, at).concat(out.slice(at + 1));
        break;
      case 2: {
        let s = at;
        while (s > 0 && out[s - 1] !== 10) s--;
        let e = at;
        while (e < out.length && out[e] !== 10) e++;
        out = out.slice(0, s).concat(out.slice(e + 1));
        break;
      }
      case 3: {
        let s = at;
        while (s > 0 && out[s - 1] !== 10) s--;
        let e = at;
        while (e < out.length && out[e] !== 10) e++;
        out = out.slice(0, e + 1).concat(out.slice(s, e + 1), out.slice(e + 1));
        break;
      }
      case 4: {
        let s = at;
        while (s > 0 && out[s - 1] !== 10) s--;
        if (rng.below(2) === 0 || out[s] !== 32) out = out.slice(0, s).concat(new Array(1 + rng.below(3)).fill(32), out.slice(s));
        else out = out.slice(0, s).concat(out.slice(s + 1));
        break;
      }
      case 5:
        out = out.slice(0, at);
        break;
      case 6: {
        // a word at the end of a line
        let e = at;
        while (e < out.length && out[e] !== 10) e++;
        out = out.slice(0, e).concat([32], Array.from(Buffer.from(rng.pick(words))), out.slice(e));
        break;
      }
      case 7: {
        // a whole line of a word, at the indentation of the line
        let s = at;
        while (s > 0 && out[s - 1] !== 10) s--;
        let ind = 0;
        while (out[s + ind] === 32) ind++;
        out = out.slice(0, s).concat(new Array(ind).fill(32), Array.from(Buffer.from(rng.pick(words))), [10], out.slice(s));
        break;
      }
      case 8: {
        // blank lines
        let e = at;
        while (e < out.length && out[e] !== 10) e++;
        out = out.slice(0, e + 1).concat(new Array(1 + rng.below(2)).fill(10), out.slice(e + 1));
        break;
      }
      default:
        if (at + 1 < out.length) {
          const t = out[at];
          out[at] = out[at + 1];
          out[at + 1] = t;
        }
    }
  }
  return Buffer.from(out);
}

const corpus: Case[] = [];
ownCases(ROOT + "vendor/bun/test/cli/format/own/cases", corpus);
corpus.push(...vscodeFiles([".yml", ".yaml"]).filter((c) => c.bytes.length < 30000));
corpus.push(...prettierFiles("/yaml/", (p) => p.includes("__snapshots__") || p.endsWith(".js") || p.endsWith(".md")));

const rng = new Rng(SEED);
const cases: Case[] = [];
for (const c of corpus) {
  cases.push(c);
  if (c.bytes.length > 12000) continue;
  for (let i = 0; i < FUZZ; i++) cases.push({ name: `${c.name}#${SEED}.${i}`, bytes: mutate(rng, c.bytes) });
}
console.log(`${corpus.length} corpus files, ${cases.length} cases`);

let bad = 0;
let shown = 0;
let total = 0;
for (const [setName, opts] of Object.entries(SET_OPTIONS)) {
  if (SETS.length > 0 && !SETS.includes(setName)) continue;
  const dir = `/tmp/yaml-diff-${setName}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const isOxfmt = setName.startsWith("oxfmt");
  fs.writeFileSync(dir + (isOxfmt ? "/.oxfmtrc.json" : "/.prettierrc.json"), JSON.stringify(opts));
  for (let i = 0; i < cases.length; i++) fs.writeFileSync(`${dir}/c${i}.yaml`, cases[i].bytes);
  cp.spawnSync(BUN, ["fmt", dir], { stdio: "ignore", maxBuffer: 1 << 28 });
  const options = new FormatOptions();
  for (const [k, v] of Object.entries(opts)) options.set(k, String(v));
  options.set("filepath", "c.yaml");
  if (isOxfmt) {
    options.set("flavor", "oxfmt");
    // oxfmt's default width is 100
    if (!("printWidth" in opts)) options.set("printWidth", "100");
  }
  const out = new ByteBuf(1 << 16);
  let setBad = 0;
  for (let i = 0; i < cases.length; i++) {
    const src = cases[i].bytes;
    out.reset();
    const r = formatYaml(src, src.length, options, out);
    const ours = r === 0 ? Buffer.from(out.view()) : src;
    const theirs = fs.readFileSync(`${dir}/c${i}.yaml`);
    total++;
    if (Buffer.compare(ours, theirs) !== 0) {
      bad++;
      setBad++;
      if (shown < SHOW) {
        shown++;
        console.log(`\nDIFF [${setName}] ${cases[i].name} (code ${r})`);
        fs.mkdirSync("/tmp/yaml-diff-fails", { recursive: true });
        const base = `/tmp/yaml-diff-fails/${setName}-${shown}`;
        fs.writeFileSync(base + ".input", src);
        fs.writeFileSync(base + ".ours", ours);
        fs.writeFileSync(base + ".bun", theirs);
        const a = ours.toString("utf8").split("\n");
        const b = theirs.toString("utf8").split("\n");
        for (let k = 0; k < Math.max(a.length, b.length); k++) {
          if (a[k] !== b[k]) {
            console.log(`  line ${k + 1}\n    ours: ${JSON.stringify(a[k])}\n    bun:  ${JSON.stringify(b[k])}\n  files: ${base}.{input,ours,bun}`);
            break;
          }
        }
      }
    }
  }
  console.log(`set ${setName}: ${cases.length - setBad}/${cases.length} identical to bun fmt`);
}
console.log(`total: ${total - bad}/${total}`);
process.exit(bad === 0 ? 0 : 1);
