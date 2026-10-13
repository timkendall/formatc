// Formats the JavaScript / TypeScript files of bench/vscode with the in-process formatter and compares them with the oracle
// (bench/vscode-fmt, what `bun fmt` made of them). Reports per extension how many match, and a histogram of the "shape" of the first
// line that differs, so that the people who port print/** and utils/** can pick targets. With `--file` prints a unified diff.
//
//   node --stack-size=7000 tools/js/compare.ts                       # all of them (a few minutes under node while the formatter is a skeleton)
//   node --stack-size=7000 tools/js/compare.ts --filter=src/vs/base/common --limit=500
//   node --stack-size=7000 tools/js/compare.ts --ext=ts,tsx --top=60 --samples=2
//   node --stack-size=7000 tools/js/compare.ts --file=src/vs/base/common/arrays.ts --diff     # unified diff, ours (-) against the oracle (+)
//   node --stack-size=7000 tools/js/compare.ts --file=... --write=/tmp/ours.ts                  # our output to a file
//
// Options: --root=bench/vscode  --oracle=bench/vscode-fmt  --list=/tmp/vscode-files.txt (paths relative to the root, one per line, they have spaces)
//          --filter=<substring of the path>  --ext=ts,tsx,..  --limit=N  --top=N (rows of the histogram, 40)  --samples=N (examples per row, 1)
//          --mismatches (list the paths that differ)  --context=N (lines of context of a diff, 3)
//
// The options of each file are the ones the driver resolves (`src/main.ts --dump-options`: .editorconfig, .prettierrc, package.json,
// bunfig.toml), so they are the ones `bun fmt` had. Run it with the stack of node enlarged (`--stack-size=7000`, and `ulimit -s unlimited`
// or 8 MB if the shell lets you) for deeply nested files.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { FORMAT_OK } from "../../src/format/errors.ts";
import * as pragma from "../../src/format/pragma.ts";
import { formatScript } from "../../src/format/js/script.ts";

function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length; i++) {
    if (a[i] === "--" + name && i + 1 < a.length && !a[i + 1].startsWith("--")) return a[i + 1];
    if (a[i].startsWith("--" + name + "=")) return a[i].substring(name.length + 3);
  }
  return dflt;
}
function flag(name: string): boolean {
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === "--" + name) return true;
  return false;
}

const repo = path.resolve(import.meta.dirname, "../..");
const root = path.resolve(repo, arg("root", "bench/vscode"));
const oracleRoot = path.resolve(repo, arg("oracle", "bench/vscode-fmt"));
const listFile = arg("list", "/tmp/vscode-files.txt");
const filter = arg("filter", "");
const exts = arg("ext", "ts,tsx,mts,cts,js,jsx,mjs,cjs").split(",").map((e) => "." + e);
const limit = Number(arg("limit", "0"));
const top = Number(arg("top", "40"));
const samples = Number(arg("samples", "1"));
const context = Number(arg("context", "3"));
const onlyFile = arg("file", "");
const showDiff = flag("diff");
const writeTo = arg("write", "");

function isTarget(p: string): boolean {
  for (const e of exts) if (p.endsWith(e)) return true;
  return false;
}

// ───────────────────────────── the files ─────────────────────────────

let files: string[] = [];
if (onlyFile.length > 0) files = [onlyFile];
else {
  const text = fs.readFileSync(listFile, "latin1");
  const lines = Buffer.from(text, "latin1").toString("utf8").split("\n");
  for (const l of lines) {
    if (l.length === 0 || !isTarget(l)) continue;
    if (filter.length > 0 && !l.includes(filter)) continue;
    files.push(l);
  }
  if (limit > 0 && files.length > limit) files = files.slice(0, limit);
}

// ───────────────────────────── options per file ─────────────────────────────

const optionCache = new Map<string, FormatOptions>();
const optionsOf = new Map<string, string>();

function resolveOptions(batch: string[]): void {
  const r = spawnSync("node", [path.join(repo, "src/main.ts"), "--cwd=" + root, "--dump-options", ...batch], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  const out = (r.stdout ?? "").split("\n");
  for (const line of out) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const p = line.substring(0, tab);
    optionsOf.set(p, line.substring(tab + 1));
  }
}

for (let i = 0; i < files.length; i += 1500) resolveOptions(files.slice(i, i + 1500));

function formatOptionsFor(rel: string): FormatOptions {
  const spec = optionsOf.get(rel) ?? optionsOf.get(path.join(root, rel)) ?? "";
  let o = optionCache.get(spec);
  if (o === undefined) {
    o = new FormatOptions();
    o.embeddedHtml = true;
    // "-t- filepath=/x useTabs=true printWidth=100": the first token is a marker; each other is name=value, in order.
    const words = spec.split(" ");
    for (const w of words) {
      const eq = w.indexOf("=");
      if (eq <= 0) continue;
      const name = w.substring(0, eq);
      if (name === "filepath") continue;
      o.set(name, w.substring(eq + 1));
    }
    optionCache.set(spec, o);
  }
  return o;
}

// ───────────────────────────── formatting ─────────────────────────────

const out = new ByteBuf(1 << 20);

/** Our output for `rel`, or a string with the reason it is none. */
function formatOurs(rel: string, src: Buffer): Buffer | string {
  const options = formatOptionsFor(rel);
  const abs = path.join(root, rel);
  const text = new Uint8Array(src.buffer, src.byteOffset, src.length);
  const before = pragma.beforeParsing(text, options);
  if (before === null) return Buffer.from(src);
  out.reset();
  let code = 0;
  try {
    code = formatScript(abs, abs, before, options, out);
  } catch (e) {
    return "exception: " + (e instanceof Error ? e.message : String(e));
  }
  if (code !== FORMAT_OK) return "format error " + code;
  return Buffer.from(out.data.buffer, out.data.byteOffset, out.len);
}

// ───────────────────────────── diff ─────────────────────────────

function splitLines(b: Buffer): string[] {
  const s = b.toString("utf8");
  const lines = s.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The index of the first line that differs, or -1. */
function firstDifference(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "return", "const", "let", "var", "function", "class", "export", "import", "default", "async", "await", "new",
  "throw", "try", "catch", "finally", "switch", "case", "break", "continue", "type", "interface", "enum", "extends", "implements", "from", "as",
  "public", "private", "protected", "readonly", "static", "abstract", "declare", "namespace", "module", "get", "set", "of", "in", "typeof", "void",
  "this", "super", "null", "true", "false", "yield", "delete", "instanceof", "satisfies", "keyof", "infer", "is", "unique", "override",
]);

/** The shape of a line: keywords and punctuation stay, names are `i`, strings `S`, numbers `N`: `export class i extends i {`. */
function shape(line: string): string {
  let s = line.trim();
  if (s === "") return "<blank line>";
  s = s.replace(/\/\/.*$/, "//…");
  s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "S");
  s = s.replace(/\b\d[\w.]*\b/g, "N");
  s = s.replace(/[A-Za-z_$][\w$]*/g, (w) => (KEYWORDS.has(w) ? w : "i"));
  s = s.replace(/\s+/g, " ");
  return s.length > 36 ? s.substring(0, 36) + "…" : s;
}

/** A unified diff of `a` (ours, `-`) against `b` (the oracle, `+`) by the longest common subsequence of lines. */
function unifiedDiff(a: string[], b: string[], ctx: number): string {
  // Common prefix and suffix.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  type Op = { t: " " | "-" | "+"; s: string };
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: " ", s: a[i] });
  if (n * m > 25_000_000) {
    for (const s of am) ops.push({ t: "-", s });
    for (const s of bm) ops.push({ t: "+", s });
  } else {
    const dp: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ t: " ", s: am[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ t: "-", s: am[i++] });
      } else ops.push({ t: "+", s: bm[j++] });
    }
    while (i < n) ops.push({ t: "-", s: am[i++] });
    while (j < m) ops.push({ t: "+", s: bm[j++] });
  }
  for (let k = a.length - suf; k < a.length; k++) ops.push({ t: " ", s: a[k] });
  // hunks
  const res: string[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === " ") {
      k++;
      continue;
    }
    let start = Math.max(0, k - ctx);
    let end = k;
    let lastChange = k;
    while (end < ops.length && (ops[end].t !== " " || end - lastChange <= ctx * 2)) {
      if (ops[end].t !== " ") lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + ctx + 1);
    let aLine = 1;
    let bLine = 1;
    for (let q = 0; q < start; q++) {
      if (ops[q].t !== "+") aLine++;
      if (ops[q].t !== "-") bLine++;
    }
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let q = start; q < end; q++) {
      body.push(ops[q].t + ops[q].s);
      if (ops[q].t !== "+") aCount++;
      if (ops[q].t !== "-") bCount++;
    }
    res.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    res.push(...body);
    k = end;
    void start;
  }
  return res.join("\n");
}

// ───────────────────────────── run ─────────────────────────────

if (onlyFile.length > 0) {
  const rel = onlyFile;
  const src = fs.readFileSync(path.join(root, rel));
  const ours = formatOurs(rel, src);
  if (typeof ours === "string") {
    console.log(rel + ": " + ours);
    process.exit(1);
  }
  if (writeTo.length > 0) fs.writeFileSync(writeTo, ours);
  const oraclePath = path.join(oracleRoot, rel);
  const oracle = fs.existsSync(oraclePath) ? fs.readFileSync(oraclePath) : null;
  if (oracle === null) {
    console.log(rel + ": no oracle");
    process.exit(1);
  }
  if (Buffer.compare(ours, oracle) === 0) {
    console.log(rel + ": match");
    process.exit(0);
  }
  console.log(rel + ": differs");
  if (showDiff || writeTo.length === 0) console.log(unifiedDiff(splitLines(ours), splitLines(oracle), context));
  process.exit(1);
}

const perExt = new Map<string, number[]>();
const hist = new Map<string, { count: number; samples: string[] }>();
const sizeHist = new Map<string, number>();
const listed: string[] = [];
let failures = 0;
const failureReasons = new Map<string, number>();
const t0 = Date.now();
let bytes = 0;

for (const rel of files) {
  const e = path.extname(rel);
  let row = perExt.get(e);
  if (row === undefined) {
    row = [0, 0, 0];
    perExt.set(e, row);
  }
  const abs = path.join(root, rel);
  let src: Buffer;
  try {
    src = fs.readFileSync(abs);
  } catch {
    continue;
  }
  bytes += src.length;
  const oraclePath = path.join(oracleRoot, rel);
  let oracle: Buffer;
  try {
    oracle = fs.readFileSync(oraclePath);
  } catch {
    // `bun fmt` left it as it is (generated, ignored, refused)
    oracle = src;
  }
  const ours = formatOurs(rel, src);
  if (typeof ours === "string") {
    failures++;
    row[2]++;
    failureReasons.set(ours, (failureReasons.get(ours) ?? 0) + 1);
    listed.push(rel + "\t" + ours);
    continue;
  }
  if (Buffer.compare(ours, oracle) === 0) {
    row[0]++;
    continue;
  }
  row[1]++;
  listed.push(rel);
  const a = splitLines(ours);
  const b = splitLines(oracle);
  const at = firstDifference(a, b);
  const key = at < 0 ? "<only the end of the file>" : shape(b[at] ?? "<end>");
  let h = hist.get(key);
  if (h === undefined) {
    h = { count: 0, samples: [] };
    hist.set(key, h);
  }
  h.count++;
  if (h.samples.length < samples) h.samples.push(`${rel}:${at + 1}\n      ours:   ${(a[at] ?? "<end>").slice(0, 110)}\n      oracle: ${(b[at] ?? "<end>").slice(0, 110)}`);
  const diffLines = Math.abs(a.length - b.length);
  const cls = diffLines === 0 ? "same line count" : diffLines <= 2 ? "±1-2 lines" : diffLines <= 10 ? "±3-10 lines" : "±11+ lines";
  sizeHist.set(cls, (sizeHist.get(cls) ?? 0) + 1);
}

const elapsed = (Date.now() - t0) / 1000;
let match = 0;
let mismatch = 0;
const lines: string[] = [];
const exKeys = [...perExt.keys()].sort();
for (const k of exKeys) {
  const r = perExt.get(k) as number[];
  match += r[0];
  mismatch += r[1];
  lines.push(`${k.padEnd(6)} match ${String(r[0]).padStart(6)}  mismatch ${String(r[1]).padStart(6)}  error ${String(r[2]).padStart(4)}`);
}
console.log(lines.join("\n"));
const total = match + mismatch + failures;
console.log(`total  match ${match}/${total} (${total === 0 ? 0 : ((100 * match) / total).toFixed(2)}%)  mismatch ${mismatch}  error ${failures}   ${(bytes / 1e6).toFixed(1)} MB in ${elapsed.toFixed(1)} s`);
if (failureReasons.size > 0) {
  console.log("\nerrors:");
  for (const [k, v] of [...failureReasons.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)) console.log(`  ${String(v).padStart(6)}  ${k}`);
}
console.log("\nfirst differing line, by shape of the oracle's line (what to port):");
const rows = [...hist.entries()].sort((x, y) => y[1].count - x[1].count).slice(0, top);
for (const [k, v] of rows) {
  console.log(`  ${String(v.count).padStart(6)}  ${k}`);
  for (const s of v.samples) console.log("      " + s);
}
console.log("\nsize of the difference:");
for (const [k, v] of [...sizeHist.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
if (flag("mismatches")) console.log("\n" + listed.join("\n"));
