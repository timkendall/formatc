// Differential fuzz of the TOML formatter against `bun fmt` (the oracle), in batches: one directory per set of options.
// Bun's own layout (a bunfig.toml with `[fmt]`) and oxfmt's (an `.oxfmtrc.json`).
//
//   node tools/toml/fuzz.ts [--n=200] [--groups=20] [--seed=1] [--show=4] [--oxfmt|--bun] [--mutate=0.2]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FLAVOR_OXFMT, FormatOptions } from "../../src/format/options.ts";
import { formatToml, tomlSyntaxError, tomlSyntaxMessage, tomlSyntaxOffset } from "../../src/format/toml/mod.ts";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => (argv.find((x) => x.startsWith("--" + n + "=")) ?? "--" + n + "=" + d).slice(n.length + 3);
const N = Number(arg("n", "200"));
const GROUPS = Number(arg("groups", "20"));
let seed = Number(arg("seed", "1"));
const SHOW = Number(arg("show", "4"));
const MUTATE = Number(arg("mutate", "0.2"));
const ONLY_OXFMT = argv.includes("--oxfmt");
const ONLY_BUN = argv.includes("--bun");

function rnd(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (n: number): number => Math.floor(rnd() * n);
const pick = <T>(a: T[]): T => a[ri(a.length)];
const chance = (p: number): boolean => rnd() < p;

const WORDS = ["a", "b", "key", "name", "version", "dep-x", "x_y", "A1", "é", "日本", "very-long-key-name-for-width", "z"];
const BARE = ["a", "b", "key", "name", "version", "dep-x", "x_y", "A1", "very-long-key-name-for-width", "z", "k1", "k2"];
function bareKey(): string {
  return pick(BARE);
}
function keyPart(): string {
  switch (ri(8)) {
    case 0: return '"' + pick(["a b", "x.y", "é", "", "q\\\"q"]) + '"';
    case 1: return "'" + pick(["a b", "x.y", "lit\\"]) + "'";
    default: return bareKey();
  }
}
function key(): string {
  const n = chance(0.8) ? 1 : 2 + ri(2);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(keyPart());
  return parts.join(chance(0.2) ? " . " : ".");
}
function sp(): string {
  return pick(["", " ", " ", " ", "  ", "\t"]);
}
function comment(): string {
  return "# " + pick(["c", "a comment", "x".repeat(ri(60)), "", "é", "TODO: fix", "a = 1", "] ["]);
}
function scalar(): string {
  switch (ri(14)) {
    case 0: return '"' + pick(["", "a", "hello world", "x".repeat(ri(50)), "\\n\\t", "\\u00e9", "é日本", "a\\\"b", "#not a comment"]) + '"';
    case 1: return "'" + pick(["", "a", "C:\\path", "x".repeat(ri(40)), "# hash"]) + "'";
    case 2: return String(ri(100000));
    case 3: return pick(["-1", "+1", "0", "1_000", "0xDEAD_beef", "0o17", "0b101", "123456789012345678901234567890"]);
    case 4: return pick(["1.5", "-0.01", "3.14e10", "1e-5", "inf", "-inf", "nan", "+nan", "6.02E+23", "1_0.5"]);
    case 5: return pick(["true", "false"]);
    case 6: return pick(["1979-05-27", "1979-05-27T07:32:00Z", "1979-05-27 07:32:00", "07:32:00", "1979-05-27T07:32:00.123456+09:00", "1979-05-27 07:32:00.123456789123"]);
    case 7: return '"""' + pick(["a", "\nline1\nline2", "x\\\ny", "", "a\r\nb"]) + '"""';
    case 8: return "'''" + pick(["a", "\nline1\nline2", "", "q"]) + "'''";
    default: return '"' + pick(WORDS) + '"';
  }
}
function value(depth: number): string {
  if (depth > 3 || chance(0.55)) return scalar();
  return chance(0.55) ? array(depth) : inlineTable(depth);
}
function array(depth: number): string {
  const n = chance(0.12) ? 0 : 1 + ri(chance(0.3) ? 12 : 4);
  const multi = chance(0.35);
  let s = "[" + (multi ? pick(["\n", "\n\n", " # c\n", "\n  "]) : sp());
  for (let i = 0; i < n; i++) {
    s += (multi && chance(0.3) ? pick(["  ", "\t", ""]) : "") + value(depth + 1);
    if (i < n - 1 || chance(0.4)) s += ",";
    if (multi) s += (chance(0.2) ? " " + comment() : "") + pick(["\n", "\n", "\n\n", "\n  "]);
    else if (i < n - 1) s += sp() + (chance(0.05) ? "\n" : "");
    if (multi && chance(0.1)) s += comment() + "\n";
  }
  return s + (multi ? "" : sp()) + "]";
}
function inlineTable(depth: number): string {
  const n = chance(0.12) ? 0 : 1 + ri(4);
  // A table with line breaks is TOML 1.1: Bun's scanner accepts it.
  const multi = chance(0.2);
  let s = "{" + (multi ? pick(["\n", " # c\n", "\n  "]) : sp());
  for (let i = 0; i < n; i++) {
    s += key() + sp() + "=" + sp() + value(depth + 1);
    if (i < n - 1 || (multi && chance(0.5))) s += ",";
    if (multi) s += (chance(0.2) ? " " + comment() : "") + "\n";
    else if (i < n - 1) s += sp();
  }
  return s + (multi ? "" : sp()) + "}";
}
function entry(): string {
  let s = key() + sp() + "=" + sp() + value(0);
  if (chance(0.15)) s += " " + comment();
  return s;
}
function header(): string {
  const arr = chance(0.25);
  let s = (arr ? "[[" : "[") + sp() + key() + sp() + (arr ? "]]" : "]");
  if (chance(0.1)) s += " " + comment();
  return s;
}
function document(): string {
  let s = "";
  if (chance(0.05)) s += "\ufeff";
  const n = ri(14);
  for (let i = 0; i < n; i++) {
    switch (ri(10)) {
      case 0: s += header(); break;
      case 1: s += comment(); break;
      case 2: s += ""; break;
      default: s += entry();
    }
    s += pick(["\n", "\n", "\n", "\n\n", "\n\n\n", "\n\n\n\n", "\n  ", " \n"]);
  }
  if (chance(0.15)) s = s.replace(/\n/g, "\r\n");
  if (chance(0.05)) s = "";
  if (chance(0.03)) s = "  \n\n";
  return s;
}
function mutate(s: string): string {
  const chars = Array.from(s);
  const k = 1 + ri(2);
  for (let i = 0; i < k; i++) {
    const at = ri(chars.length + 1);
    switch (ri(3)) {
      case 0: chars.splice(at, 1); break;
      case 1: chars.splice(at, 0, pick(["=", "[", "]", "{", "}", ",", '"', "'", "#", "\n", ".", " ", "\\", "-", "1", "\u0000"])); break;
      default: chars[at] = pick(["=", "]", "}", ",", '"']); break;
    }
  }
  return chars.join("");
}

function randomOptions(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (chance(0.5)) o.printWidth = pick([20, 30, 40, 60, 80, 100, 120]);
  if (chance(0.4)) o.useTabs = chance(0.5);
  if (chance(0.3)) o.tabWidth = pick([1, 2, 4, 8]);
  if (chance(0.3)) o.trailingComma = pick(["all", "es5", "none"]);
  if (chance(0.2)) o.endOfLine = pick(["lf", "crlf"]);
  return o;
}

function lineCol(text: Uint8Array, offset: number): [number, number] {
  const s = Buffer.from(text.subarray(0, offset)).toString("utf8");
  let line = 1;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      line++;
      last = i + 1;
    }
  }
  return [line, s.length - last + 1];
}

const out = new ByteBuf(1 << 16);
let total = 0;
let same = 0;
let shown = 0;
let refusals = 0;
const reasons = new Map<string, number>();

function runGroup(oxfmt: boolean): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfz"));
  const opts = randomOptions();
  if (oxfmt) {
    fs.writeFileSync(dir + "/.oxfmtrc.json", JSON.stringify(opts));
  } else {
    let t = "[fmt]\n";
    for (const k of Object.keys(opts)) t += k + " = " + JSON.stringify(opts[k]) + "\n";
    fs.writeFileSync(dir + "/bunfig.toml", t);
  }
  const cases: string[] = [];
  for (let i = 0; i < N; i++) {
    let doc = document();
    if (chance(MUTATE)) doc = mutate(doc);
    cases.push(doc);
    fs.writeFileSync(`${dir}/c${i}.toml`, doc);
  }
  const r = spawnSync(process.env.HOME + "/.bun/bin/bun", ["fmt", "."], { cwd: dir, encoding: "utf8" });
  const errs = new Map<number, [string, number, number]>();
  const re = /(?:error|warn(?:ing)?): ([^\n]*)\n\s+at c(\d+)\.toml:(\d+):(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(r.stderr)) !== null) errs.set(Number(m[2]), [m[1], Number(m[3]), Number(m[4])]);
  const fo = new FormatOptions();
  if (oxfmt) {
    fo.flavor = FLAVOR_OXFMT;
    fo.set("printWidth", "100");
  }
  for (const k of Object.keys(opts)) if (!fo.set(k, String(opts[k]))) throw new Error("option " + k);
  for (let i = 0; i < N; i++) {
    total++;
    const input = Buffer.from(cases[i], "utf8");
    out.reset();
    const code = formatToml(input, input.length, fo, out);
    const theirs = fs.readFileSync(`${dir}/c${i}.toml`);
    const expectedErr = errs.get(i);
    let ok: boolean;
    let detail = "";
    if (code === 0) {
      ok = expectedErr === undefined && Buffer.compare(Buffer.from(out.view()), theirs) === 0;
      if (!ok) detail = expectedErr ? "we accept; bun: " + expectedErr[0] : "text differs";
    } else if (code === 1) {
      refusals++;
      reasons.set(tomlSyntaxError(input, input.length) ? tomlSyntaxMessage() : "?", (reasons.get(tomlSyntaxError(input, input.length) ? tomlSyntaxMessage() : "?") ?? 0) + 1);
      let msg = "?";
      let line = 0;
      let col = 0;
      if (tomlSyntaxError(input, input.length)) {
        msg = tomlSyntaxMessage();
        [line, col] = lineCol(input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf ? input.subarray(3) : input, tomlSyntaxOffset());
      }
      // oxfmt passes over a file it cannot read: unchanged, with a warning.
      const unchanged = Buffer.compare(theirs, input) === 0;
      const hasCr = cases[i].includes("\r");
      ok = unchanged && expectedErr !== undefined && expectedErr[0] === msg && (hasCr || (expectedErr[1] === line && expectedErr[2] === col));
      if (!ok) detail = `we refuse: ${msg} ${line}:${col}; bun: ` + (expectedErr ? `${expectedErr[0]} ${expectedErr[1]}:${expectedErr[2]}` : "no error") + (unchanged ? "" : " (changed)");
    } else {
      ok = false;
      detail = "status " + code;
    }
    if (ok) same++;
    else if (shown++ < SHOW) {
      console.log(`--- DIFF (${oxfmt ? "oxfmt" : "bun"} ${JSON.stringify(opts)}): ${detail}`);
      console.log("input:", JSON.stringify(cases[i].slice(0, 500)));
      if (code === 0) {
        console.log("ours: ", JSON.stringify(Buffer.from(out.view()).toString("utf8").slice(0, 500)));
        console.log("bun:  ", JSON.stringify(theirs.toString("utf8").slice(0, 500)));
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

for (let g = 0; g < GROUPS; g++) runGroup(ONLY_OXFMT ? true : ONLY_BUN ? false : chance(0.5));
if (argv.includes("--reasons")) console.log([...reasons.entries()].sort((a, b) => b[1] - a[1]));
console.log(`toml fuzz: ${same}/${total} identical (${refusals} refusals), seed ${arg("seed", "1")}`);
