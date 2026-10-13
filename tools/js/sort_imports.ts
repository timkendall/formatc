// Checks the preprocessors of src/format/js/sort_imports (trivago, ianvs, organize, native) against the fixtures of Bun
// (vendor/bun/test/cli/format/sort-imports/*.json) by a proxy: our `sortedText` is written to a file and `bun fmt` WITHOUT the plugin
// formats it; that has to be what Prettier with the plugin printed. (The formatter of this repo is not in the loop.)
//
//   node --stack-size=7000 tools/js/sort_imports.ts trivago|ianvs|organize [--filter=substring] [--limit=N] [--show=N] [--bun=~/.bun/bin/bun]
//   node --stack-size=7000 tools/js/sort_imports.ts oxfmt|trivago|ianvs|organize --e2e [--ours="node --stack-size=7000 src/main.ts"] ...
//        (runs our command line on the files like the test of Bun does and compares the whole output: needs the other printers)
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { STMT_IMPORT, fileBegin, fileBodyLen, fileBodyStart, listAt, stmtTag } from "../../src/lint/ast/index.ts";
import { parseFile } from "../../src/sema/parser/parser/run.ts";
import { names } from "../../src/sema/parser/parser/mod.ts";
import { Settings, sortedText } from "../../src/format/js/sort_imports/mod.ts";

function arg(name: string, dflt: string): string {
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--" + name + "=")) return process.argv[i].substring(name.length + 3);
  }
  return dflt;
}
const repo = path.resolve(import.meta.dirname, "../..");
const bun = arg("bun", path.join(os.homedir(), ".bun/bin/bun"));
const tool = process.argv[2];
const filter = arg("filter", "");
const limit = Number(arg("limit", "100000"));
const show = Number(arg("show", "3"));
const e2e = process.argv.includes("--e2e");
const ours = arg("ours", "node --stack-size=7000 " + path.resolve(import.meta.dirname, "../../src/main.ts")).split(" ");

interface Case {
  name: string;
  filename: string;
  options: Record<string, unknown>;
  input: string;
  output: string;
}

function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(v);
}

/** Whether every statement of the file is an import (so that the printers of other statements do not matter). */
function onlyImports(filename: string, input: string): boolean {
  const bytes = new TextEncoder().encode(input);
  for (const isScript of [false, true]) {
    if (parseFile(bytes, bytes.length, filename, isScript) !== 0) continue;
    fileBegin(names, isTs(filename), !isScript);
    for (let i = 0; i < fileBodyLen(); i++) if (stmtTag(listAt(fileBodyStart(), i)) !== STMT_IMPORT) return false;
    return true;
  }
  return false;
}

function isTs(p: string): boolean {
  return /\.[cm]?tsx?$/.test(p);
}

function sorted(settings: Settings, filename: string, input: string): { text: string; error: string } {
  const how = settings.compile();
  if (how === null) return { text: input, error: settings.error };
  const bytes = new TextEncoder().encode(input);
  for (const isScript of [false, true]) {
    if (parseFile(bytes, bytes.length, filename, isScript) !== 0) continue;
    fileBegin(names, isTs(filename), !isScript);
    const out = sortedText(filename, how);
    return { text: out === null ? input : new TextDecoder().decode(out), error: "" };
  }
  return { text: input, error: "parse" };
}

const CONSUMED = (k: string) => k === "plugins" || k.startsWith("importOrder") || k.startsWith("organizeImports") || k.startsWith("tsconfig.") || k === "sortImports";

function main() {
  const cases: Case[] = JSON.parse(fs.readFileSync(path.join(repo, "vendor/bun/test/cli/format/sort-imports", tool + ".json"), "utf8"));
  const groups = new Map<string, Case[]>();
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    if (process.argv.includes("--only-imports") && !onlyImports(c.filename, c.input)) continue;
    const k = JSON.stringify(c.options);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  const configFile = tool === "oxfmt" ? ".oxfmtrc.json" : ".prettierrc.json";
  const plugin = tool === "trivago" ? "@trivago/prettier-plugin-sort-imports" : tool === "ianvs" ? "@ianvs/prettier-plugin-sort-imports" : "prettier-plugin-organize-imports";
  let pass = 0, fail = 0, skipped = 0, shown = 0, n = 0;
  for (const [key, group] of groups) {
    const options = JSON.parse(key) as Record<string, unknown>;
    if (e2e) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sortimports-"));
      const config = tool === "oxfmt" ? options : { plugins: [plugin], ...options };
      fs.writeFileSync(path.join(dir, configFile), JSON.stringify(config));
      const todo: { c: Case; file: string }[] = [];
      group.forEach((c, i) => {
        if (n++ >= limit) return;
        const file = `${i}-${c.filename}`;
        fs.writeFileSync(path.join(dir, file), c.input);
        todo.push({ c, file });
      });
      spawnSync(ours[0], [...ours.slice(1), "--log-level=silent", "."], { cwd: dir });
      for (const { c, file } of todo) {
        const got = fs.readFileSync(path.join(dir, file), "utf8");
        if (got === c.output) pass++;
        else {
          fail++;
          if (shown++ < show) {
            console.log(`--- FAIL ${c.name} (${JSON.stringify(c.options).slice(0, 200)})`);
            console.log("input:\n" + c.input);
            console.log("expected:\n" + c.output);
            console.log("got:\n" + got);
          }
        }
      }
      fs.rmSync(dir, { recursive: true });
      continue;
    }
    const settings = () => {
      const s = new Settings();
      s.set("plugins", JSON.stringify([plugin]));
      for (const [k, v] of Object.entries(options)) if (CONSUMED(k)) s.set(k, valueText(v));
      return s;
    };
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(options)) if (!CONSUMED(k)) rest[k] = v;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sortimports-"));
    fs.writeFileSync(path.join(dir, ".prettierrc.json"), JSON.stringify(rest));
    const todo: { c: Case; file: string }[] = [];
    const errors = new Map<Case, string>();
    group.forEach((c, i) => {
      if (n++ >= limit) return;
      const r = sorted(settings(), c.filename, c.input);
      if (r.error) errors.set(c, r.error);
      const file = `${i}-${c.filename}`;
      fs.writeFileSync(path.join(dir, file), r.text);
      todo.push({ c, file });
    });
    spawnSync(bun, ["fmt", "--log-level=silent", "."], { cwd: dir });
    for (const { c, file } of todo) {
      const got = fs.readFileSync(path.join(dir, file), "utf8");
      if (errors.has(c) && errors.get(c) === "parse") { skipped++; continue; }
      if (got === c.output) pass++;
      else {
        fail++;
        if (shown++ < show) {
          console.log(`--- FAIL ${c.name} (${JSON.stringify(c.options).slice(0, 200)})`);
          console.log("input:\n" + c.input);
          console.log("expected:\n" + c.output);
          console.log("got:\n" + got);
          if (errors.has(c)) console.log("error: " + errors.get(c));
        }
      }
    }
    fs.rmSync(dir, { recursive: true });
  }
  console.log(`${tool}: ${pass} pass, ${fail} fail, ${skipped} skipped (unparsed)`);
}
main();
