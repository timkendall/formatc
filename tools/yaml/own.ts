// Checks the YAML inputs of vendor/bun/test/cli/format/own/cases (`<name>.yaml.input`) against what Prettier prints
// (`.prettier.snap`) and what oxfmt prints (`.snap`; `.snap.todo` is not compared), at every set of options in the
// snapshot. `node tools/yaml/own.ts`.
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FLAVOR_OXFMT, FormatOptions } from "../../src/format/options.ts";
import { formatYaml } from "../../src/format/yaml/mod.ts";

const ROOT = new URL("../../vendor/bun/test/cli/format/own/cases/", import.meta.url).pathname;

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(dir + "/" + e.name, out);
    else if (/\.ya?ml\.input$/.test(e.name)) out.push(dir + "/" + e.name);
  }
}

// `{ printWidth: 80, proseWrap: "always" }` -> [["printWidth", "80"], ["proseWrap", "always"]]
function parseOptions(line: string): string[][] {
  const inner = line.trim().replace(/^\{\s*/, "").replace(/\s*\}$/, "");
  const pairs: string[][] = [];
  if (inner === "") return pairs;
  for (const part of inner.split(/,\s*/)) {
    const colon = part.indexOf(":");
    let value = part.slice(colon + 1).trim();
    if (value.startsWith('"')) value = value.slice(1, -1);
    pairs.push([part.slice(0, colon).trim(), value]);
  }
  return pairs;
}

function sections(snap: string): { options: string[][]; output: string }[] {
  const out: { options: string[][]; output: string }[] = [];
  const re = /^-+\n(\{.*\})\n-+\n/gm;
  const marks: { at: number; end: number; options: string[][] }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(snap)) !== null) marks.push({ at: m.index, end: m.index + m[0].length, options: parseOptions(m[1]) });
  const endMark = snap.indexOf("===================== End =====================");
  for (let i = 0; i < marks.length; i++) {
    const stop = i + 1 < marks.length ? marks[i + 1].at : endMark;
    let output = snap.slice(marks[i].end, stop);
    // a blank line separates it from the next
    if (output.endsWith("\n\n")) output = output.slice(0, -1);
    out.push({ options: marks[i].options, output });
  }
  return out;
}

const files: string[] = [];
walk(ROOT.slice(0, -1), files);
let total = 0;
let ok = 0;
for (const input of files.sort()) {
  const src = fs.readFileSync(input);
  const base = input.slice(0, -".input".length);
  const optionsPath = input.slice(0, input.lastIndexOf("/")) + "/options.json";
  const extra: string[][][] = [];
  if (fs.existsSync(optionsPath)) {
    // options.json: { "<name>": [ { ...options } ] }? only used for the extra sets; the snapshot says what was run
    void optionsPath;
  }
  void extra;
  for (const [suffix, oxfmt] of [[".prettier.snap", false], [".snap", true]] as [string, boolean][]) {
    if (!fs.existsSync(base + suffix)) continue;
    for (const section of sections(fs.readFileSync(base + suffix, "utf8"))) {
      const options = new FormatOptions();
      if (oxfmt) options.flavor = FLAVOR_OXFMT;
      options.set("filepath", base.slice(base.lastIndexOf("/") + 1));
      for (const [k, v] of section.options) options.set(k, v);
      const out = new ByteBuf(1024);
      const r = formatYaml(src, src.length, options, out);
      total++;
      const got = r === 0 ? Buffer.from(out.view()).toString("utf8") : "<error " + r + ">";
      if (got === section.output) ok++;
      else {
        console.log("FAIL", input.slice(ROOT.length), oxfmt ? "oxfmt" : "prettier", JSON.stringify(section.options));
        console.log("  expected:", JSON.stringify(section.output.slice(0, 300)));
        console.log("  got:     ", JSON.stringify(got.slice(0, 300)));
      }
    }
  }
}
// Regressions: a non-ASCII text (and a long one) must not recurse in `writeText`
for (const [input, expected] of [
  ["k日本eywords:   a\n", "k日本eywords: a\n"],
  ["a:   " + "é".repeat(120) + "\n", "a: " + "é".repeat(120) + "\n"],
  ["a:   " + "x".repeat(200) + "\n", "a: " + "x".repeat(200) + "\n"],
]) {
  const src = Buffer.from(input);
  const out = new ByteBuf(256);
  const r = formatYaml(src, src.length, new FormatOptions(), out);
  total++;
  if (r === 0 && Buffer.from(out.view()).toString("utf8") === expected) ok++;
  else console.log("FAIL regression", JSON.stringify(input.slice(0, 20)), r);
}
console.log(`own yaml cases: ${ok}/${total}`);
