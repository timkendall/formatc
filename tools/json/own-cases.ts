// Runs the inputs of vendor/bun/test/cli/format/own/cases/{json,toml} (the snapshots of Prettier / `bun fmt` and of oxfmt).
//   node tools/json/own-cases.ts [--show=N]
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FLAVOR_OXFMT, FormatOptions } from "../../src/format/options.ts";
import * as kinds from "../../src/driver/kinds.ts";
import { formatJson } from "../../src/format/json/mod.ts";
import { formatToml } from "../../src/format/toml/mod.ts";

const ROOT = new URL("../../vendor/bun/test/cli/format/own/cases/", import.meta.url).pathname;
const showMax = Number((process.argv.find((a) => a.startsWith("--show=")) ?? "--show=6").slice(7));
let shown = 0;
let total = 0;
let ok = 0;

function parseOptions(text: string): [string, string][] {
  // `{ printWidth: 80, tabWidth: 4, trailingComma: "none" }`
  const body = text.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: [string, string][] = [];
  if (!body.trim()) return out;
  for (const part of body.split(/,(?=\s*\w+\s*:)/)) {
    const m = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(part);
    if (!m) throw new Error("options " + text);
    let v = m[2];
    if (v.startsWith('"')) v = JSON.parse(v);
    out.push([m[1], String(v)]);
  }
  return out;
}

function sections(snap: string): [string, string][] {
  const lines = snap.split("\n");
  const res: [string, string][] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^-+$/.test(lines[i]) && i + 2 < lines.length && /^-+$/.test(lines[i + 2])) {
      const opts = lines[i + 1];
      i += 3;
      const body: string[] = [];
      while (i < lines.length && !(/^-+$/.test(lines[i]) && i + 2 < lines.length && /^-+$/.test(lines[i + 2])) && !/^=+ End =+$/.test(lines[i])) body.push(lines[i++]);
      // the snapshot adds one line break
      let text = body.join("\n");
      if (text.endsWith("\n")) text = text.slice(0, -1);
      res.push([opts, text]);
    } else i++;
  }
  return res;
}

const out = new ByteBuf(1 << 16);
for (const lang of ["json", "toml", "json/rejected"]) {
  const dir = ROOT + lang + "/";
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".input")) continue;
    const name = f.slice(0, -6);
    const input = fs.readFileSync(dir + f);
    const k = kinds.kindOf(name, "");
    const parser = kinds.outParser;
    for (const suffix of [".snap", ".prettier.snap"]) {
      const p = dir + name + suffix;
      if (!fs.existsSync(p)) continue;
      for (const [opts, expected] of sections(fs.readFileSync(p, "utf8"))) {
        const o = new FormatOptions();
        if (suffix === ".snap") o.flavor = FLAVOR_OXFMT;
        for (const [n, v] of parseOptions(opts)) if (!o.set(n, v)) throw new Error("option " + n);
        if (lang === "toml") o.toml = true;
        out.reset();
        const r = lang === "toml" ? formatToml(input, input.length, o, out) : formatJson(input, input.length, parser, o, out);
        const got = r === 0 ? Buffer.from(out.view()).toString("utf8") : "<SyntaxError>";
        total++;
        if (got === expected || (r === 0 && got === expected + "\n") || (r === 0 && got.replace(/\n$/, "") === expected.replace(/\n$/, ""))) ok++;
        else if (shown++ < showMax) {
          console.log("DIFF", lang, name + suffix, opts, "status", r);
          console.log("  expected:", JSON.stringify(expected.slice(0, 300)));
          console.log("  got:     ", JSON.stringify(got.slice(0, 300)));
        }
      }
    }
  }
}
console.log(`own cases: ${ok}/${total}`);
