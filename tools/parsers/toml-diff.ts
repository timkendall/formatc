// Differential test of src/parsers/toml.ts against Bun's own parser (the oracle).
//
//   bun tools/parsers/toml-diff.ts [--fuzz=N] [--soup=N] [--seed=S] [--no-fmt] [--show=K]
//
// For every .toml file of the corpus (vscode, the TOML files of this repository, Bun's own cases, hand-written
// seeds from the TOML specification) and for N mutants of each, and for N random strings of TOML pieces:
//   - accept/reject: `Bun.TOML.parse` against `tomlTokens`. Bun's parser also checks what the keys and tables mean
//     (a key twice, a table twice, an integer of any size); ours reads the syntax only, so those are expected;
//   - when both reject: the words;
//   - for what we reject: the place and the words against `bun fmt` (the line and the column it prints).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tomlTokens, tomlErrorMessage, tomlErrorPos } from "../../src/parsers/toml.ts";
import { Case, ROOT, Rng, vscodeFiles } from "./corpus.ts";
import { genDoc } from "./toml-gen.ts";

const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  for (const a of args) if (a.startsWith("--" + name + "=")) return a.slice(name.length + 3);
  return def;
}
const FUZZ = Number(opt("fuzz", "0"));
const SOUP = Number(opt("soup", "0"));
const GEN = Number(opt("gen", "0"));
const SEED = Number(opt("seed", "1"));
const SHOW = Number(opt("show", "5"));
const NOFMT = args.includes("--no-fmt");

const SEMANTIC = [/^Cannot redefine/, /^Cannot extend/, /^Integer is outside/, /^Integer cannot be losslessly/];

// ---------------------------------------------------------------------------------------------------------------

const SEEDS: string[] = [
  `# This is a TOML document.

title = "TOML Example"

[owner]
name = "Tom Preston-Werner"
dob = 1979-05-27T07:32:00-08:00

[database]
enabled = true
ports = [ 8000, 8001, 8002 ]
data = [ ["delta", "phi"], [3.14] ]
temp_targets = { cpu = 79.5, case = 72.0 }

[servers]

[servers.alpha]
ip = "10.0.0.1"
role = "frontend"

[servers.beta]
ip = "10.0.0.2"
role = "backend"
`,
  `str1 = """
Roses are red
Violets are blue"""
str4 = """Here are two quotation marks: "". Simple enough."""
str5 = """Here are three quotation marks: ""\\"."""
str7 = """"This," she said, "is just a pointless statement.\""""
winpath  = 'C:\\Users\\nodejs\\templates'
regex2 = '''I [dw]on't need \\d{2} apples'''
lines  = '''
The first newline is
trimmed in raw strings.
   All other whitespace
   is preserved.
'''
quot15 = '''Here are fifteen quotation marks: """""""""""""""'''
str = "I'm a string. \\"You can quote me\\". Name\\tJos\\u00E9\\nLocation\\tSF."
str2 = "The quick brown \\
        fox jumps over \\
        the lazy dog."
`,
  `int1 = +99
int2 = 42
int3 = 0
int4 = -17
int5 = 1_000
int6 = 5_349_221
hex1 = 0xDEADBEEF
hex2 = 0xdeadbeef
hex3 = 0xdead_beef
oct1 = 0o01234567
oct2 = 0o755
bin1 = 0b11010110
flt1 = +1.0
flt2 = 3.1415
flt3 = -0.01
flt4 = 5e+22
flt5 = 1e06
flt6 = -2E-2
flt7 = 6.626e-34
flt8 = 224_617.445_991_228
sf1 = inf
sf2 = +inf
sf3 = -inf
sf4 = nan
sf5 = +nan
sf6 = -nan
bool1 = true
bool2 = false
`,
  `odt1 = 1979-05-27T07:32:00Z
odt2 = 1979-05-27T00:32:00-07:00
odt3 = 1979-05-27T00:32:00.999999-07:00
odt4 = 1979-05-27 07:32:00Z
ldt1 = 1979-05-27T07:32:00
ldt2 = 1979-05-27T00:32:00.999999
ld1 = 1979-05-27
lt1 = 07:32:00
lt2 = 00:32:00.999999
lt3 = 07:32
`,
  `integers = [ 1, 2, 3 ]
colors = [ "red", "yellow", "green" ]
nested_arrays_of_ints = [ [ 1, 2 ], [3, 4, 5] ]
nested_mixed_array = [ [ 1, 2 ], ["a", "b", "c"] ]
string_array = [ "all", 'strings', """are the same""", '''type''' ]
numbers = [ 0.1, 0.2, 0.5, 1, 2, 5 ]
contributors = [
  "Foo Bar <foo@example.com>",
  { name = "Baz Qux", email = "bazqux@example.com", url = "https://example.com/bazqux" }
]
integers2 = [
  1, 2, 3
]
integers3 = [
  1,
  2, # this is ok
]
`,
  `[table-1]
key1 = "some string"
key2 = 123

[table-2]
key1 = "another string"
key2 = 456

[dog."tater.man"]
type.name = "pug"

[a.b.c]            # this is best practice
[ d.e.f ]          # same as [d.e.f]
[ g .  h  . i ]    # same as [g.h.i]
[ j . "ʞ" . 'l' ]  # same as [j."ʞ".'l']

[x] # defining a super-table afterward is ok
[x.y.z.w]
`,
  `name = { first = "Tom", last = "Preston-Werner" }
point = { x = 1, y = 2 }
animal = { type.name = "pug" }
multi = {
  a = 1,
  b = [
    1, 2
  ],
}
[[products]]
name = "Hammer"
sku = 738594937

[[products]]  # empty table within the array

[[products]]
name = "Nail"
sku = 284758393

color = "gray"

[[fruits]]
name = "apple"

[fruits.physical]  # subtable
color = "red"
shape = "round"

[[fruits.varieties]]  # nested array of tables
name = "red delicious"
`,
  `key = "value"
bare_key = "value"
bare-key = "value"
1234 = "value"
"127.0.0.1" = "value"
"character encoding" = "value"
"ʎǝʞ" = "value"
'key2' = "value"
'quoted "value"' = "value"
fruit.name = "banana"     # this is best practice
fruit. color = "yellow"    # same as fruit.color
fruit . flavor = "banana"   # same as fruit.flavor
3.14159 = "pi"
`,
];

// Invalid ones, in the words of the spec's tests
const BAD_SEEDS: string[] = [
  "key = # INVALID\n",
  "first = \"Tom\" last = \"Preston-Werner\" # INVALID\n",
  "= \"no key name\"  # INVALID\n",
  "[a]\nb = 1\n[a]\nc = 2\n",
  "a = 1\na = 2\n",
  "int = 0123\n",
  "int = 1__0\n",
  "int = _1\n",
  "int = 1_\n",
  "x = 0x\n",
  "x = 0b2\n",
  "x = 0o8\n",
  "x = +0x1\n",
  "f = 1.\n",
  "f = .1\n",
  "f = 1e\n",
  "d = 1979-13-01\n",
  "d = 1979-02-30\n",
  "t = 25:00:00\n",
  "s = \"abc\n",
  "s = 'abc\n",
  "s = \"\\q\"\n",
  "s = \"\\uD800\"\n",
  "s = \"\\u12\"\n",
  "s = \"\"\"abc\n",
  "s = \"\"\"\"\"\"\"\"\"\n",
  "a = [1, 2\n",
  "a = [1 2]\n",
  "a = {x = 1\n",
  "a = {x = 1 y = 2}\n",
  "a = {,}\n",
  "[a\nb = 1\n",
  "[[a]\n",
  "[a]]\n",
  "[]\n",
  "a.b.c\n",
  "a =\n",
  "a = tru\n",
  "a = truex\n",
  "a = infinity\n",
  "a = hello\n",
  "a = 1 b = 2\n",
  "a = 1\r\nb = 2\rc = 3\n",
  "a = \"\\x41\"\n",
  "# comment\x01\n",
  "a = 1 # \x7f\n",
  "\xff = 1\n",
  "a = \"\xc3\"\n",
];

// ---------------------------------------------------------------------------------------------------------------

const PIECES = [
  "a", "b", "key", "k.k2", " = ", "=", " ", "  ", "\t", "\n", "\n", "\n", "\r\n", "\r", ".", ",", ", ", "[", "]", "[[", "]]", "{", "}", "[a]", "[[a]]", "[a.b]", "{ x = 1 }",
  "\"q\"", "'q'", "\"\"\"", "'''", "\"", "'", "\"\"\"x\"\"\"", "'''x'''", "\\", "\\n", "\\\"", "\\u00e9", "\\uD800", "\\U0001F600", "\\x41", "\\e", "\\q",
  "1", "-1", "+1", "1_0", "1__0", "01", "0x1F", "0o7", "0b1", "0x", "1.5", "1.", ".5", "1e5", "1e", "1E+5", "inf", "-inf", "nan", "+nan", "infx",
  "1979-05-27", "07:32:00", "07:32", "1979-05-27T07:32:00Z", "1979-05-27 07:32:00-07:00", "1979-02-30", "25:00:00", "1979-05-27T07:32:00.123456789",
  "true", "false", "tru", "truex", "#c", "# c\n", "# \x01", "\u00e9", "\u2028", "\x01", "\x7f", "\x00",
];

function soupCase(rng: Rng): Buffer {
  const count = 1 + rng.below(14);
  let t = "";
  for (let k = 0; k < count; k++) {
    t += rng.pick(PIECES);
    if (rng.below(4) === 0) t += "\n";
  }
  return Buffer.from(t, "utf8");
}

function mutate(rng: Rng, input: Buffer): Buffer {
  let out = Array.from(input);
  const count = 1 + rng.below(3);
  const chars = ` =[]{},.#"'\n\t\\_-+:0e`.split("").map(c => c.charCodeAt(0));
  for (let m = 0; m < count; m++) {
    const kind = rng.below(6);
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
      case 3:
        out = out.slice(0, at);
        break;
      case 4:
        if (at + 1 < out.length) {
          const t = out[at];
          out[at] = out[at + 1];
          out[at + 1] = t;
        }
        break;
      default:
        out = out.slice(0, at).concat([rng.below(256)], out.slice(at));
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------------------------------------------

function lineCol(bytes: Buffer, offset: number): [number, number] {
  offset = Math.min(offset, bytes.length);
  let line = 1;
  let start = 0;
  for (let i = 0; i < offset; i++) {
    if (bytes[i] === 10) {
      line++;
      start = i + 1;
    }
  }
  return [line, Buffer.from(bytes.subarray(start, offset)).toString("utf8").length + 1];
}

const counts = new Map<string, number>();
const examples = new Map<string, string[]>();
function note(cat: string, example: string): void {
  counts.set(cat, (counts.get(cat) ?? 0) + 1);
  let e = examples.get(cat);
  if (!e) examples.set(cat, (e = []));
  if (e.length < SHOW) e.push(example);
}

type Rejected = { name: string; bytes: Buffer; message: string; pos: number };
const rejected: Rejected[] = [];

function runOne(name: string, bytes: Buffer): void {
  const r = tomlTokens(bytes, bytes.length);
  let bunErr: string | null = null;
  try {
    Bun.TOML.parse(bytes as unknown as string);
  } catch (e) {
    bunErr = String((e as Error).message ?? e).replace(/^TOML Parse error: /, "");
  }
  if (r === 0) {
    if (bunErr === null) note("both accept", name);
    else if (SEMANTIC.some(re => re.test(bunErr!))) note("mine accepts, bun: " + bunErr.replace(/ '.*$/, "") + " (meaning, expected)", name);
    else note("BUG mine accepts, bun rejects: " + bunErr, name);
    return;
  }
  const message = tomlErrorMessage();
  const pos = tomlErrorPos();
  rejected.push({ name, bytes, message, pos });
  if (bunErr === null) note("BUG mine rejects, bun accepts", `${name}: ${message} @${pos}`);
  else if (bunErr === message) note("both reject, same words", name);
  else if (SEMANTIC.some(re => re.test(bunErr!))) note("both reject (bun: meaning first, inconclusive)", name);
  else note("BUG both reject, words differ", `${name}: mine "${message}" @${pos}, bun "${bunErr}"`);
}

// ---------------------------------------------------------------------------------------------------------------

function checkAgainstFmt(): void {
  if (rejected.length === 0) return;
  const dir = "/tmp/ptest/toml-fmt";
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const todo = new Set<number>();
  for (let i = 0; i < rejected.length; i++) {
    const r = rejected[i];
    let lone = false;
    for (let k = 0; k < r.bytes.length; k++) if (r.bytes[k] === 13 && r.bytes[k + 1] !== 10) lone = true;
    // the words of the file name `x.toml` are the same whatever the bytes are
    if (lone) continue;
    writeFileSync(`${dir}/${i}.toml`, r.bytes);
    todo.add(i);
  }
  const files = readdirSync(dir);
  const out: string[] = [];
  for (let s = 0; s < files.length; s += 500) {
    const slice = files.slice(s, s + 500).map(f => `${dir}/${f}`);
    const res = Bun.spawnSync({ cmd: [process.env.HOME + "/.bun/bin/bun", "fmt", "--check", ...slice], stderr: "pipe", stdout: "pipe" });
    out.push(res.stderr.toString("utf8"), res.stdout.toString("utf8"));
  }
  const text = out.join("\n");
  const reported = new Map<number, { message: string; line: number; col: number }>();
  const re = /error: ([^\n]*)\n\s+at [^\n]*?\/(\d+)\.toml:(\d+):(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) reported.set(Number(m[2]), { message: m[1], line: Number(m[3]), col: Number(m[4]) });
  for (const i of todo) {
    const r = rejected[i];
    const got = reported.get(i);
    if (!got) {
      note("fmt: no error reported for a file we reject", `${r.name} ${r.message} @${r.pos}`);
      continue;
    }
    let bytes = r.bytes;
    let pos = r.pos;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      bytes = bytes.subarray(3);
      pos -= 3;
    }
    const [line, col] = lineCol(Buffer.from(bytes), Math.max(0, pos));
    if (got.message !== r.message) note("BUG fmt: other words", `${r.name}: mine "${r.message}", fmt "${got.message}"`);
    else if (got.line === line && got.col === col) note("fmt: same words, same place", r.name);
    else note("BUG fmt: other place", `${r.name}: mine ${line}:${col}, fmt ${got.line}:${got.col} (${got.message})`);
  }
}

// ---------------------------------------------------------------------------------------------------------------

const corpus: Case[] = [...vscodeFiles([".toml"])];
function addDir(dir: string, rel: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "target" || e.name === ".git") continue;
    if (e.isDirectory()) addDir(`${dir}/${e.name}`, `${rel}/${e.name}`);
    else if (e.name.endsWith(".toml") || e.name.endsWith(".toml.input")) corpus.push({ name: `${rel}/${e.name}`, bytes: readFileSync(`${dir}/${e.name}`) });
  }
}
addDir(ROOT + "vendor/bun", "bun");
SEEDS.forEach((s, i) => corpus.push({ name: `seed/${i}`, bytes: Buffer.from(s, "latin1") }));
BAD_SEEDS.forEach((s, i) => corpus.push({ name: `bad-seed/${i}`, bytes: Buffer.from(s, "latin1") }));
console.log(`corpus: ${corpus.length} files`);

for (const c of corpus) runOne(c.name, c.bytes);

if (FUZZ > 0) {
  const rng = new Rng(SEED);
  let n = 0;
  for (const c of corpus) {
    if (c.bytes.length > 20000) continue;
    for (let i = 0; i < FUZZ; i++) {
      runOne(`${c.name}#${SEED}.${i}`, mutate(rng, c.bytes));
      n++;
    }
  }
  console.log(`fuzz: ${n} mutants`);
}
if (SOUP > 0) {
  const rng = new Rng(SEED + 1000);
  for (let i = 0; i < SOUP; i++) {
    const b = soupCase(rng);
    runOne(`soup#${SEED}.${i} ${JSON.stringify(b.toString("latin1")).slice(0, 80)}`, b);
  }
  console.log(`soup: ${SOUP} cases`);
}

if (GEN > 0) {
  const rng = new Rng(SEED + 2000);
  for (let i = 0; i < GEN; i++) {
    const b = genDoc(rng);
    runOne(`gen#${SEED}.${i}`, b);
    runOne(`gen-mut#${SEED}.${i}`, mutate(rng, b));
  }
  console.log(`gen: ${GEN} documents, each also mutated`);
}

if (!NOFMT) checkAgainstFmt();

let bugs = 0;
for (const [cat, count] of [...counts].sort()) {
  console.log(`${String(count).padStart(7)}  ${cat}`);
  if (cat.startsWith("BUG")) {
    bugs += count;
    for (const e of examples.get(cat) ?? []) console.log("           " + e);
  }
}
console.log(bugs === 0 ? "no bugs" : `${bugs} BUGS`);
