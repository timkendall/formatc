// Differential fuzz of sortPackageJson against `bun fmt --sort-package-json`: package.json files, one directory each.
//   node tools/json/spj-fuzz.ts [--n=300] [--seed=1] [--show=4]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { formatJson } from "../../src/format/json/mod.ts";
import { sortPackageJson } from "../../src/format/json/sort_package_json.ts";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => (argv.find((x) => x.startsWith("--" + n + "=")) ?? "--" + n + "=" + d).slice(n.length + 3);
const N = Number(arg("n", "300"));
let seed = Number(arg("seed", "1"));
const SHOW = Number(arg("show", "4"));
function rnd(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (n: number): number => Math.floor(rnd() * n);
const pick = <T>(a: T[]): T => a[ri(a.length)];
const chance = (p: number): boolean => rnd() < p;

const KEYS = ["name", "version", "scripts", "dependencies", "devDependencies", "peerDependencies", "files", "keywords", "author", "bugs", "repository", "funding", "exports", "main", "type", "devEngines", "publishConfig", "engines", "bin", "directories", "browserslist", "eslintConfig", "babel", "jest", "husky", "binary", "$schema", "description", "license", "_private", "z", "a", "b", "Z", "é", "_x", "betterScripts", "wireit", "activationEvents", "libc", "bundledDependencies", "volta", "pnpm", "x-y", "overrides", "resolutions"];
const STRS = ["prettier-plugin", "a", "b", "z", "A", "1.0.0", "^1.2.3", "é", "日本", "x y", "a\\nb", "q\\\"q", "\\u00e9", "\\ud83d\\ude00", "/", "\\/", "", "dist", "lib", "src/index.js", "node", "tsc", "build", "test", "~0.1", "Z", "_a", "https://x.y/z", "\\\\"];
const NUMS = ["0", "1", "-1", "1.5", "1e5", "1E5", "1e+5", "-0", "0.1", "100", "12345678901234567890", "18446744073709551615", "18446744073709551616", "-9223372036854775808", "-9223372036854775809", "1.0", "0.000001", "1e-7", "123456789.123456789", "1e22", "1e21", "5e-324", "1.7976931348623157e308", "1e309", "0e10", "-1e-400", "3.14159"];
function str(): string {
  return '"' + pick(STRS) + '"';
}
function val(depth: number): string {
  if (depth > 3 || chance(0.4)) {
    switch (ri(5)) {
      case 0: return pick(NUMS);
      case 1: return pick(["true", "false", "null"]);
      default: return str();
    }
  }
  if (chance(0.5)) {
    const n = ri(6);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(chance(0.8) ? str() : val(depth + 1));
    return "[" + parts.join(pick([",", ", ", ",\n"])) + "]";
  }
  return obj(depth + 1);
}
function obj(depth: number): string {
  const n = ri(7);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push('"' + (chance(0.7) ? pick(KEYS) : pick(STRS)) + '":' + pick(["", " "]) + val(depth));
  return "{" + pick(["", "\n  "]) + parts.join(pick([",", ", ", ",\n  "])) + pick(["", "\n"]) + "}";
}
function doc(): string {
  let s = chance(0.05) ? "﻿" : "";
  s += pick(["", "\n", " "]) + obj(0) + pick(["", "\n"]);
  if (chance(0.1)) s = s.slice(0, ri(s.length)); // broken
  if (chance(0.03)) s = s.replace("}", ",}");
  return s;
}

const out = new ByteBuf(1 << 16);
const sorted = new ByteBuf(1 << 16);
let total = 0, same = 0, shown = 0;
// `--sort-package-json` and `sortPackageJson = true` do not sort the scripts; the table of bunfig.toml says.
for (const mode of ["flag", "bunfig-true", "bunfig-scripts", "bunfig-no-scripts"]) {
  const sortScripts = mode === "bunfig-scripts";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spj"));
  const cases: string[] = [];
  for (let i = 0; i < N; i++) {
    cases.push(doc());
    fs.mkdirSync(root + "/d" + i);
    fs.writeFileSync(root + "/d" + i + "/package.json", cases[i]);
  }
  // `--sort-package-json` and, for the other, a bunfig.toml
  if (mode === "bunfig-true") fs.writeFileSync(root + "/bunfig.toml", "[fmt]\nsortPackageJson = true\n");
  if (mode === "bunfig-scripts") fs.writeFileSync(root + "/bunfig.toml", "[fmt]\nsortPackageJson = { sortScripts = true }\n");
  if (mode === "bunfig-no-scripts") fs.writeFileSync(root + "/bunfig.toml", "[fmt]\nsortPackageJson = { sortScripts = false }\n");
  const r = spawnSync(process.env.HOME + "/.bun/bin/bun", ["fmt", ...(mode === "flag" ? ["--sort-package-json"] : []), "."], { cwd: root, encoding: "utf8" });
  console.log("bun:", r.stderr.trim().split("\n").slice(-2).join(" | "), "exit", r.status);
  for (let i = 0; i < N; i++) {
    total++;
    const input = Buffer.from(cases[i]);
    sorted.reset();
    const ok = sortPackageJson(input, input.length, sortScripts, sorted);
    out.reset();
    const text = ok ? sorted.view() : input;
    const code = formatJson(text, text.length, 3, new FormatOptions(), out);
    const theirs = fs.readFileSync(root + "/d" + i + "/package.json");
    const mine = code === 0 ? Buffer.from(out.view()) : input;
    if (Buffer.compare(mine, theirs) === 0) same++;
    else if (shown++ < SHOW) {
      console.log("DIFF mode", mode, "sorted?", ok, "code", code);
      console.log(" in:  ", JSON.stringify(cases[i].slice(0, 400)));
      console.log(" ours:", JSON.stringify(mine.toString().slice(0, 400)));
      console.log(" bun: ", JSON.stringify(theirs.toString().slice(0, 400)));
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`sortPackageJson fuzz: ${same}/${total} identical`);
