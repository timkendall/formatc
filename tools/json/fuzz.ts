// Differential fuzz of the JSON formatter against `bun fmt` (the oracle), in batches: one directory per set of options,
// all the cases as files in it, one `bun fmt .`.
//
//   node tools/json/fuzz.ts [--n=300] [--groups=40] [--seed=1] [--show=5] [--mutate=0.3] [--oxfmt]
//
// A case is compared on: accepted or refused, the formatted text, and for a refusal the words and the line:column.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FLAVOR_OXFMT, FormatOptions } from "../../src/format/options.ts";
import { formatJson } from "../../src/format/json/mod.ts";
import { refusalMessage, refusalOffset, messageText } from "../../src/format/syntax_error.ts";

const argv = process.argv.slice(2);
function arg(name: string, def: string): string {
  const a = argv.find((x) => x.startsWith("--" + name + "="));
  return a ? a.slice(name.length + 3) : def;
}
const N = Number(arg("n", "300"));
const GROUPS = Number(arg("groups", "40"));
let seed = Number(arg("seed", "1"));
const SHOW = Number(arg("show", "5"));
const MUTATE = Number(arg("mutate", "0.3"));
const BUN = os.homedir() + "/.bun/bin/bun";
const ONLY_OXFMT = argv.includes("--oxfmt");
const ONLY_PRETTIER = argv.includes("--prettier");

// ---- random
function rnd(): number {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function ri(n: number): number {
  return Math.floor(rnd() * n);
}
function pick<T>(a: T[]): T {
  return a[ri(a.length)];
}
function chance(p: number): boolean {
  return rnd() < p;
}

// ---- generator
const WS = [" ", " ", " ", "", "", "\n", "\n", "\t", "\n\n", "\n  ", "\n\t", "  ", "\n\n\n", " \n ", " ", "﻿", " ", " ", "\v", "\f", "　"];
function ws(p = 0.5): string {
  if (!chance(p)) return "";
  return pick(WS);
}
function comment(): string {
  switch (ri(8)) {
    case 0: return "/* c */";
    case 1: return "// c\n";
    case 2: return "/*\n * a\n * b\n */";
    case 3: return "/**\n * @type {x}\n */";
    case 4: return "/* a\n   b */";
    case 5: return "// prettier-ignore\n";
    case 6: return "/**   x  \n * y  \n */";
    default: return "// " + "x".repeat(ri(100)) + "\n";
  }
}
function trivia(commentP: number): string {
  let s = ws(0.6);
  if (chance(commentP)) {
    s += comment();
    if (chance(0.3)) s += ws(0.7);
    if (chance(0.15)) s += comment();
  }
  return s;
}
const STR_PARTS = ["a", "b", "key", "hello world", "x-y", "1", "0", "é", "日本語", "😀", "\\n", "\\t", "\\\"", "\\\\", "\\u00e9", "\\x41", "\\u{1F600}", "\\/", "'", "\"", "\t", "  ", "\\\n", "\\0", "\\q", "http://x", " ", "ab́", "​", "\\ud83d\\ude00", "$", "_", "a b c d e f g", "\\'"];
function stringBody(): string {
  let s = "";
  const n = ri(6);
  for (let i = 0; i < n; i++) s += pick(STR_PARTS);
  if (chance(0.1)) s += "x".repeat(ri(90));
  return s;
}
function str(): string {
  const body = stringBody();
  const q = chance(0.75) ? '"' : "'";
  return q + body.split(q).join("\\" + q) + q;
}
const NUMS = ["0", "1", "-1", "+1", "10", "1.5", "1.50", "1.0", "1.", ".5", "-.5", "0.5e10", "1e5", "1E5", "1e+05", "1e-05", "1e0", "0e0", "0XAB", "0xab", "0b101", "0o17", "010", "089", "1_000", "1_0.0_1e1_0", "123456789012345678901234567890", "0.1", "00", "5e-7", "2.5E+10", "-0", "-Infinity", "+Infinity", "NaN", "-NaN", "Infinity", "1.50e10", "1.e5", "0.000", "100", "1e100"];
function num(): string {
  if (chance(0.5)) return String(ri(1000));
  return pick(NUMS);
}
const IDENTS = ["a", "b", "key", "$x", "_y", "ab1", "é", "null", "true", "undefined", "NaN", "Infinity", "class", "a-b" /* invalid */];
function keyText(): string {
  switch (ri(10)) {
    case 0: return pick(IDENTS.slice(0, 13));
    case 1: return num();
    case 2: return String(ri(100));
    case 3: return str();
    case 4: return "'" + pick(["a", "b c", "1", "é", "a-b", "x'y"]).replace(/'/g, "\\'") + "'";
    default: return '"' + pick(["a", "b", "key", "name", "version", "a-b", "1", "10", "1.5", "é", "日本", "a b", "$x", "class", "x".repeat(ri(20)), "_", "0", "01", "1e3", ""]) + '"';
  }
}
function scalar(): string {
  switch (ri(12)) {
    case 0: case 1: case 2: case 3: return str();
    case 4: case 5: case 6: return num();
    case 7: return pick(["true", "false", "null"]);
    case 8: return pick(["NaN", "Infinity", "-Infinity", "+NaN", "undefined"]);
    case 9: return "`" + pick(["a", "a\\nb", "line1\nline2", "x\\u0041", "q\\x41", "plain", "a${", "back\\`tick", "\\0", "\\\n"]) + "`";
    case 10: return "-" + pick(["1", "1.5", "Infinity", ".5"]);
    default: return str();
  }
}
let commentP = 0.1;
function value(depth: number): string {
  if (depth > 5 || chance(0.35)) return scalar();
  if (chance(0.5)) return object(depth);
  return array(depth);
}
function object(depth: number): string {
  const n = chance(0.15) ? 0 : 1 + ri(chance(0.2) ? 8 : 4);
  let s = "{" + trivia(commentP);
  for (let i = 0; i < n; i++) {
    s += keyText() + trivia(commentP) + ":" + trivia(commentP) + value(depth + 1) + trivia(commentP);
    if (i < n - 1 || chance(0.25)) s += ",";
    s += trivia(commentP) + (chance(0.08) ? "\n\n" : "");
  }
  return s + "}";
}
function array(depth: number): string {
  const n = chance(0.15) ? 0 : 1 + ri(chance(0.3) ? 20 : 4);
  let s = "[" + trivia(commentP);
  const numeric = chance(0.3);
  const matrix = chance(0.1);
  for (let i = 0; i < n; i++) {
    if (chance(0.05)) {
      s += ","; // a hole
      continue;
    }
    s += (numeric ? (chance(0.8) ? num() : "-" + ri(100)) : matrix ? pick(["[1,2]", "{a:1,b:2}", "[3,4,5]", "{}"]) : value(depth + 1)) + trivia(commentP);
    if (i < n - 1 || chance(0.25)) s += ",";
    s += trivia(commentP) + (chance(0.08) ? "\n\n" : "");
  }
  return s + "]";
}
function document(): string {
  commentP = chance(0.5) ? 0 : chance(0.5) ? 0.1 : 0.4;
  let s = trivia(commentP * 0.5);
  if (chance(0.02)) s = "";
  else s += value(0);
  s += trivia(commentP * 0.5);
  if (chance(0.5)) s += "\n";
  return s;
}
function mutate(s: string): string {
  const chars = Array.from(s);
  const k = 1 + ri(3);
  for (let i = 0; i < k; i++) {
    const at = ri(chars.length + 1);
    switch (ri(4)) {
      case 0: chars.splice(at, 1); break;
      case 1: chars.splice(at, 0, pick([",", ":", "{", "}", "[", "]", '"', "'", "/", "*", "\\", "`", "\n", " ", "-", "+", ".", "e", "_", "0", "x", "$", "\u0000"])); break;
      case 2: chars[at] = pick([",", ":", "}", "]", '"', "'"]); break;
      default: chars.splice(at, 0, ...Array.from(pick(["/*", "*/", "//", "\\u", "\\x", "\\u{", "${", "0x", "1e", "1_", ".."]))); break;
    }
  }
  return chars.join("");
}

// ---- option sets
const PARSERS = [".json", ".json", ".jsonc", ".json5", ".importmap"];
function randomOptions(oxfmt: boolean): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  // oxfmt refuses a width above 320: its whole configuration is then left out.
  if (chance(0.5)) o.printWidth = pick(oxfmt ? [20, 40, 60, 80, 100, 120, 320] : [20, 40, 60, 80, 100, 120, 10000]);
  if (chance(0.4)) o.useTabs = chance(0.5);
  if (chance(0.3)) o.tabWidth = pick([1, 2, 3, 4, 8]);
  if (chance(0.3)) o.singleQuote = chance(0.5);
  if (chance(0.3)) o.quoteProps = pick(["as-needed", "consistent", "preserve"]);
  if (chance(0.3)) o.trailingComma = pick(["all", "es5", "none"]);
  if (chance(0.3)) o.bracketSpacing = chance(0.5);
  if (chance(0.15)) o.endOfLine = pick(["lf", "crlf", "cr", "auto"]);
  if (chance(0.3)) o.objectWrap = pick(["preserve", "collapse"]);
  return o;
}

// ---- compare
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

function runGroup(oxfmt: boolean): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jfz"));
  const opts = randomOptions(oxfmt);
  const ext = pick(PARSERS);
  fs.writeFileSync(dir + (oxfmt ? "/.oxfmtrc.json" : "/.prettierrc"), JSON.stringify(opts));
  // These are flags, not options of a configuration file.
  const flags: string[] = [];
  const fo0: Record<string, unknown> = {};
  if (!oxfmt) {
    if (chance(0.15)) { flags.push("--insert-pragma"); fo0.insertPragma = true; }
    if (chance(0.1)) { flags.push("--require-pragma"); fo0.requirePragma = true; }
    if (chance(0.08)) { flags.push("--check-ignore-pragma"); fo0.checkIgnorePragma = true; }
    if (chance(0.15)) { const v = ri(150); flags.push("--range-start=" + v); fo0.rangeStart = v; }
    if (chance(0.15)) { const v = ri(400); flags.push("--range-end=" + v); fo0.rangeEnd = v; }
  }
  const cases: string[] = [];
  for (let i = 0; i < N; i++) {
    let doc = document();
    if (chance(MUTATE)) doc = mutate(doc);
    if (chance(0.12)) doc = doc.replace(/\n/g, pick(["\r\n", "\r"]));
    cases.push(doc);
    fs.writeFileSync(`${dir}/c${i}${ext}`, doc);
  }
  const r = spawnSync(BUN, ["fmt", ...flags, "."], { cwd: dir, encoding: "utf8" });
  // errors: "error: <message>\n    at c12.json:1:6"
  const errs = new Map<number, [string, number, number]>();
  const re = /error: ([^\n]*)\n\s+at c(\d+)\.[a-z0-9]+:(\d+):(\d+)/g;
  let m: RegExpExecArray | null;
  const stderr = r.stderr;
  while ((m = re.exec(stderr)) !== null) errs.set(Number(m[2]), [m[1], Number(m[3]), Number(m[4])]);
  const fo = new FormatOptions();
  // oxfmt's default width is 100.
  if (oxfmt) {
    fo.flavor = FLAVOR_OXFMT;
    fo.set("printWidth", "100");
  }
  for (const k of Object.keys(opts)) if (!fo.set(k, String(opts[k]))) throw new Error("option " + k);
  for (const k of Object.keys(fo0)) if (!fo.set(k, String(fo0[k]))) throw new Error("option " + k);
  const parser = ext === ".json" ? 0 : ext === ".jsonc" ? 1 : ext === ".json5" ? 2 : 3;
  for (let i = 0; i < N; i++) {
    total++;
    const input = Buffer.from(cases[i], "utf8");
    out.reset();
    const code = formatJson(input, input.length, parser, fo, out);
    const expectedErr = errs.get(i);
    const theirs = fs.readFileSync(`${dir}/c${i}${ext}`);
    let ok: boolean;
    let detail = "";
    if (code === 0) {
      ok = expectedErr === undefined && Buffer.compare(Buffer.from(out.view()), theirs) === 0;
      if (!ok) detail = expectedErr ? "we accept, bun: " + expectedErr[0] + " " + expectedErr[1] + ":" + expectedErr[2] : "text differs";
    } else if (code === 2) {
      refusals++;
      const body = input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf ? input.subarray(3) : input;
      const [line, col] = lineCol(body, refusalOffset());
      const msg = messageText(refusalMessage());
      const hasCr = cases[i].includes("\r");
      ok = expectedErr !== undefined && (hasCr || (expectedErr[1] === line && expectedErr[2] === col)) && expectedErr[0] === msg;
      if (!ok) detail = `we refuse: ${msg} ${line}:${col}; bun: ` + (expectedErr ? `${expectedErr[0]} ${expectedErr[1]}:${expectedErr[2]}` : "accepts");
    } else {
      ok = false;
      detail = "status " + code;
    }
    if (ok) same++;
    else if (shown++ < SHOW) {
      console.log(`--- DIFF (${oxfmt ? "oxfmt" : "prettier"} ${ext} ${JSON.stringify(opts)} ${flags.join(" ")}): ${detail}`);
      console.log("input:   ", JSON.stringify(cases[i].length > 600 ? cases[i].slice(0, 600) + "…" : cases[i]));
      if (code === 0) {
        console.log("ours:    ", JSON.stringify(Buffer.from(out.view()).toString("utf8").slice(0, 600)));
        console.log("bun:     ", JSON.stringify(theirs.toString("utf8").slice(0, 600)));
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

for (let g = 0; g < GROUPS; g++) {
  const oxfmt = ONLY_OXFMT ? true : ONLY_PRETTIER ? false : chance(0.4);
  runGroup(oxfmt);
}
console.log(`json fuzz: ${same}/${total} identical (${refusals} refusals), seed ${arg("seed", "1")}`);
