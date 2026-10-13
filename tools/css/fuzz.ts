// Differential fuzzer against `bun fmt`: mutants of the style sheets of Prettier's tests and of vscode are written to a
// directory, `bun fmt <dir>` formats them in place, and every file is compared with what src/format/css makes of it. A file that
// we refuse must be one that `bun fmt` leaves as it is, and the other way round (bun prints `SyntaxError` for it).
//   node tools/css/fuzz.ts [count=3000] [seed=1] [--bundle=/tmp/prettier-bundle.txt] [--keep] [--oxfmt]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions, FLAVOR_OXFMT } from "../../src/format/options.ts";
import { format, parserForPath } from "../../src/format/css/mod.ts";
import { refusalMessage, refusalOffset, messageText } from "../../src/format/syntax_error.ts";

const root = new URL("../../", import.meta.url).pathname;
let count = 3000;
let seed = 1;
let bundle = "/tmp/prettier-bundle.txt";
let keep = false;
let numbers = 0;
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--bundle=")) bundle = a.slice(9);
  else if (a === "--keep") keep = true;
  else if (/^\d+$/.test(a)) {
    if (numbers === 0) count = Number(a);
    else seed = Number(a);
    numbers++;
  }
}
let rngState = seed | 0;
function rnd(): number {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) | 0;
  return (rngState >>> 8) / 16777216;
}
function ri(n: number): number {
  return Math.floor(rnd() * n);
}

// corpus
type Seed = { name: string; ext: string; data: Buffer };
const corpus: Seed[] = [];
{
  const buf = readFileSync(bundle);
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    const header = buf.subarray(at, nl).toString("latin1");
    const m = /^=== (.*) (\d+)$/.exec(header);
    if (!m) break;
    const len = Number(m[2]);
    const start = nl + 1;
    const path = m[1];
    const ext = path.slice(path.lastIndexOf(".") + 1);
    if (/^\/(css|less|scss)\//.test(path) && /^(css|less|scss)$/.test(ext) && !path.includes("__snapshots__")) {
      corpus.push({ name: path, ext, data: Buffer.from(buf.subarray(start, start + len)) });
    }
    at = start + len + 1;
  }
}
const vscodeList = readFileSync("/tmp/vscode-files.txt", "utf8").split("\n").filter((n) => /\.(css|scss|less)$/.test(n));
for (let i = 0; i < vscodeList.length; i += 4) {
  const data = readFileSync(root + "bench/vscode/" + vscodeList[i]);
  if (data.length < 20000) corpus.push({ name: vscodeList[i], ext: vscodeList[i].slice(vscodeList[i].lastIndexOf(".") + 1), data });
}
console.log(`corpus: ${corpus.length} files`);

const DICT = ["{", "}", ";", ":", "(", ")", "/*", "*/", "//", '"', "'", "@media ", "@import ", "!important", "\\", "#{", "${", "@", "--x:", "\n", " ", "\t", ",", "&", ">", "+", "~", "[", "]", "=", "$a:", "@a:", ".b", "#c", "url(", "calc(", "!default", "/", "*", "-", "%", "<", "@include ", "@if ", "@else", "@mixin x(", "~\"", "`"];

function mutate(data: Buffer): Buffer {
  let s = Buffer.from(data);
  const steps = 1 + ri(3);
  for (let k = 0; k < steps; k++) {
    if (s.length === 0) break;
    const op = ri(8);
    const at = ri(s.length);
    switch (op) {
      case 0: // delete a range
        s = Buffer.concat([s.subarray(0, at), s.subarray(Math.min(s.length, at + 1 + ri(12)))]);
        break;
      case 1: // insert a token
        s = Buffer.concat([s.subarray(0, at), Buffer.from(DICT[ri(DICT.length)]), s.subarray(at)]);
        break;
      case 2: { // duplicate a line
        const ls = s.lastIndexOf(10, at) + 1;
        let le = s.indexOf(10, at);
        if (le < 0) le = s.length;
        s = Buffer.concat([s.subarray(0, le), Buffer.from("\n"), s.subarray(ls, le), s.subarray(le)]);
        break;
      }
      case 3: { // delete a line
        const ls = s.lastIndexOf(10, at) + 1;
        let le = s.indexOf(10, at);
        if (le < 0) le = s.length - 1;
        s = Buffer.concat([s.subarray(0, ls), s.subarray(le + 1)]);
        break;
      }
      case 4: // replace a byte
        s[at] = DICT[ri(DICT.length)].charCodeAt(0);
        break;
      case 5: // truncate
        if (rnd() < 0.3) s = s.subarray(0, at);
        break;
      case 6: { // swap two lines
        const text = s.toString("latin1").split("\n");
        const i = ri(text.length);
        const j = ri(text.length);
        [text[i], text[j]] = [text[j], text[i]];
        s = Buffer.from(text.join("\n"), "latin1");
        break;
      }
      default: { // remove all spaces after a colon / semicolon somewhere, join lines
        const text = s.toString("latin1");
        s = Buffer.from(rnd() < 0.5 ? text.replace(/\n\s*/g, rnd() < 0.5 ? " " : "") : text.replace(/\s+/g, " "), "latin1");
        break;
      }
    }
  }
  return s;
}

const dir = "/tmp/cssfuzz";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const inputs: Buffer[] = [];
const names: string[] = [];
for (let i = 0; i < count; i++) {
  const s = corpus[ri(corpus.length)];
  const mutant = i % 5 === 0 ? Buffer.from(s.data) : mutate(s.data);
  const name = `${i}.${s.ext}`;
  inputs.push(mutant);
  names.push(name);
  writeFileSync(`${dir}/${name}`, mutant);
}
const bun = `${process.env.HOME}/.bun/bin/bun`;
const res = spawnSync(bun, ["fmt", dir], { encoding: "latin1", maxBuffer: 1 << 28 });
const errored = new Set<string>();
const bunErrors = new Map<string, string>();
{
  let message = "";
  for (const line of (res.stderr + res.stdout).split("\n")) {
    const e = /^error: (.*)$/.exec(line);
    if (e) message = e[1];
    const m = /at (?:.*\/)?(\d+\.(?:css|less|scss)):(\d+):(\d+)/.exec(line);
    if (m) {
      errored.add(m[1]);
      bunErrors.set(m[1], `${message} ${m[2]}:${m[3]}`);
    }
  }
}
const options = new FormatOptions();
let same = 0;
let sameRefused = 0;
const bad: string[] = [];
const badMessages: string[] = [];
for (let i = 0; i < count; i++) {
  const name = names[i];
  const bunOut = readFileSync(`${dir}/${name}`);
  const out = new ByteBuf(inputs[i].length * 2 + 64);
  const r = format(new Uint8Array(inputs[i]), parserForPath(name), options, out);
  if (r !== 0) {
    const bunRefused = errored.has(name) || Buffer.compare(bunOut, inputs[i]) === 0;
    if (bunRefused) {
      sameRefused++;
      if (r === 2 && bunErrors.has(name)) {
        const off = refusalOffset();
        const text = inputs[i];
        // the offset counts bytes of the text without a BOM; the line and the column (UTF-16 units) as bun prints them
        const bom = text.length >= 3 && text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf ? 3 : 0;
        const before = text.subarray(bom, bom + off).toString("utf8");
        const lines = before.split(/\r\n|\r|\n/);
        const ours = `${messageText(refusalMessage())} ${lines.length}:${lines[lines.length - 1].length + 1}`;
        if (ours !== bunErrors.get(name)) badMessages.push(`${name}: ours "${ours}" bun "${bunErrors.get(name)}"`);
      }
    }
    else bad.push(`${name}: we refuse (${r}), bun formats`);
    continue;
  }
  if (Buffer.compare(Buffer.from(out.view()), bunOut) === 0) {
    if (errored.has(name)) bad.push(`${name}: bun refuses, we format (same text)`);
    else same++;
  } else {
    bad.push(`${name}: differ${errored.has(name) ? " (bun refuses)" : ""}`);
  }
}
console.log(`${count} mutants: ${same} same, ${sameRefused} both refuse, ${bad.length} differ (bun refused ${errored.size})`);
for (const b of bad.slice(0, 15)) console.log("  " + b);
console.log(`${badMessages.length} refusals with other words or place than bun's`);
for (const b of badMessages.slice(0, 10)) console.log("  " + b);
writeFileSync("/tmp/cssfuzz-bad.txt", bad.join("\n") + "\n" + badMessages.join("\n"));
if (!keep && bad.length === 0) rmSync(dir, { recursive: true, force: true });
void execFileSync;
void readdirSync;
void FLAVOR_OXFMT;
