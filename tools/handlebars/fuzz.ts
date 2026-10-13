// Differential fuzz of src/format/handlebars against `bun fmt` (the live oracle).
//   node tools/handlebars/fuzz.ts [count=2000] [seed=1] [--keep] [--rc='{"singleQuote":true,"printWidth":40}']
// Mutants of the Handlebars inputs of Prettier's fixtures (+ vscode's) are written to /tmp/hbs-fuzz/, formatted in place
// by `bun fmt`, and compared with ours: the formatted text, or the error (message and line:column).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FORMAT_NESTED_TOO_DEEPLY, FORMAT_OK, FORMAT_SYNTAX_ERROR_AT } from "../../src/format/errors.ts";
import { format, saysTheSame } from "../../src/format/handlebars/mod.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { messageText, refusalReason } from "../../src/format/syntax_error.ts";
import { allInputs } from "./corpus.ts";

const BUN = process.env["HOME"] + "/.bun/bin/bun";
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const nums = args.filter((a) => !a.startsWith("--"));
const count = parseInt(nums[0] ?? "2000", 10);
let seed = parseInt(nums[1] ?? "1", 10);
const keep = flags.includes("--keep");
const rcFlag = flags.find((f) => f.startsWith("--rc="));
const rc: Record<string, unknown> = rcFlag === undefined ? {} : JSON.parse(rcFlag.substring(5));
const bunFlags: string[] = [];
const DIR = "/tmp/hbs-fuzz";

function rnd(): number {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick<T>(a: T[]): T {
  return a[Math.floor(rnd() * a.length)];
}
function int(n: number): number {
  return Math.floor(rnd() * n);
}

const SNIPPETS = [
  "{{", "}}", "{{{", "}}}", "{{!", "{{!--", "--}}", "{{~", "~}}", "{{#if a}}", "{{else}}", "{{else if b}}", "{{/if}}", "{{^}}",
  "{{#each xs as |x i|}}", "{{/each}}", "{{^if a}}", "{{~else~}}", "{{#unless a}}", "{{/unless}}", "{{#with a as |b|}}",
  "<div>", "</div>", "<br>", "<img/>", "<img>", "</img>", "<!--", "-->", "<!-- x -->", "<!DOCTYPE html>", '<!doctype html public "x" "y">',
  "<!DOCTYPE>", "<!", "<", ">", "/>", '"', "'", "\\", "\\\\", "\\{{", " as |x|", " as |", "|", "{{this}}", "{{@foo}}", "{{foo.bar}}",
  "{{foo/bar}}", "{{[x y]}}", "{{(a b)}}", "{{a b=c}}", "{{a (b c=d) e}}", "{{> foo}}", "{{#> foo}}{{/foo}}", "{{*foo}}", "{{{{raw}}}}",
  "{{{{/raw}}}}", "{{{a}}}", "{{&a}}", "{{a.[b c].d}}", "{{../a}}", "{{this.a}}", "{{this/a}}", "{{a.this}}", "{{@a.b}}", "{{1}}", "{{-1.50}}",
  "{{true}}", "{{null}}", "{{undefined}}", '{{"str"}}', "{{'it''s'}}", "{{a 'x\"y'}}", "{{a \"x'y\"}}", "&quot;", "&amp;", "&apos;",
  "<style>", "</style>", "<style>a{b:c}</style>", "<script>", "</script>", "<pre>", "</pre>", "<textarea>", "</textarea>", "<title>",
  "...attributes", " @arg={{x}}", ' class="a {{b}} c"', " class='a b  c'", ' class="{{if a "b c"}} d"', " {{on 'click' this.x}}",
  " {{! c }}", " {{!-- c --}}", " disabled", " a=b", " a='b'", ' a="b"', " a={{b}}", " a=\"{{b}}\"", " a='{{b}}c'", "\n", "\n\n", "  ", "\t", "\r\n", "\r",
  "é", "日本", " ", "😀", " ", "\u0000", "\u000b", "­",
  "---\nfoo: bar\n---\n", "---\n---\n", "+++\na=1\n+++\n", "<Foo @a={{b}} as |c|>", "</Foo>", "<foo.bar />", "<:named>", "</:named>",
  "<div {{foo}}>", "<div {{foo bar}} class=\"x\">", "<div ...attributes>", "<input disabled>", "<a href=x>", "<p>text</p>", "text ", " text",
  "{{#if a}}x{{else}}y{{/if}}", "{{#if a}}{{else if b}}{{else}}{{/if}}", "{{#each a}}{{@index}}{{/each}}", "{{yield}}", "{{yield (hash a=b)}}",
  "{{#let a as |b|}}", "{{outlet}}", "{{(helper)}}", "{{foo bar baz=1 qux=\"2\"}}", "{{foo.bar baz}}", "{{a-b}}", "{{a_b}}", "{{a:b}}", "{{@@a}}",
  "{{.}}", "{{..}}", "{{...}}", "{{a.#b}}", "{{#.}}", "{{else}}{{#if x}}", "{{/if}}{{/if}}",
];

function mutate(s: string): string {
  let r = s;
  const rounds = rnd() < 0.7 ? 1 : 1 + int(3);
  for (let k = 0; k < rounds; k++) {
    const kind = int(9);
    const at = int(r.length + 1);
    switch (kind) {
      case 0: {
        const len = 1 + int(5);
        r = r.slice(0, at) + r.slice(at + len);
        break;
      }
      case 1:
      case 2:
      case 3:
        r = r.slice(0, at) + pick(SNIPPETS) + r.slice(at);
        break;
      case 4: {
        // duplicate a line
        const lines = r.split("\n");
        if (lines.length > 0) {
          const i = int(lines.length);
          lines.splice(i, 0, lines[i]);
          r = lines.join("\n");
        }
        break;
      }
      case 5: {
        // swap two chars
        if (r.length > 2) {
          const i = int(r.length - 1);
          r = r.slice(0, i) + r[i + 1] + r[i] + r.slice(i + 2);
        }
        break;
      }
      case 6: {
        // replace a mustache's insides
        const i = r.indexOf("{{", at);
        if (i >= 0) {
          const j = r.indexOf("}}", i);
          if (j >= 0) r = r.slice(0, i + 2) + pick(["", " a ", "#if a", "/if", "else", "! x ", "> p", "~", "{a}", "a b=c", "'x'", "(a)", "[a]"]) + r.slice(j);
        }
        break;
      }
      case 7: {
        // delete a whole line
        const lines = r.split("\n");
        if (lines.length > 1) {
          lines.splice(int(lines.length), 1);
          r = lines.join("\n");
        }
        break;
      }
      default: {
        // replace one character
        r = r.slice(0, at) + pick(["{", "}", "<", ">", "/", "#", "!", "~", '"', "'", " ", "\n", "|", "=", "@", "."]) + r.slice(at + 1);
      }
    }
  }
  return r;
}

function lineCol(text: string, offsetBytes: number, bytes: Buffer): [number, number] {
  // The offset is a byte of the text (without a BOM); line and column count UTF-16 units; \r\n and \r end a line.
  const prefix = bytes.subarray(0, Math.min(offsetBytes, bytes.length)).toString("utf8");
  let line = 1;
  let col = 1;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix.charCodeAt(i);
    if (c === 10 || (c === 13 && prefix.charCodeAt(i + 1) !== 10)) {
      line++;
      col = 1;
    } else if (c === 13) {
      // the \r of \r\n
    } else col++;
  }
  return [line, col];
}

function ours(data: Buffer, options: FormatOptions): { ok: boolean; out: string; msg: string; line: number; col: number } {
  const out = new ByteBuf(1024);
  const text = new Uint8Array(data);
  const r = format(text, options, out);
  if (r === FORMAT_OK) return { ok: true, out: Buffer.from(out.view()).toString("latin1"), msg: "", line: 0, col: 0 };
  if (r === FORMAT_SYNTAX_ERROR_AT) {
    const e = refusalReason();
    const bom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
    const body = data.subarray(bom);
    const [line, col] = lineCol("", e.offset, body);
    return { ok: false, out: "", msg: messageText(e.message), line, col };
  }
  return { ok: false, out: "", msg: r === FORMAT_NESTED_TOO_DEEPLY ? "nested" : "code " + r, line: 0, col: 0 };
}

// Random templates that are mostly valid.
const WORDS = ["foo", "bar", "baz", "this", "title", "user.name", "@index", "../x", "a-b", "true", "42", "-1.50", "'str'", '"q"', "(h a b=c)", "a.[b c]", "@root.x", "this.y"];
const TAGS = ["div", "span", "p", "a", "ul", "li", "pre", "textarea", "script", "style", "Foo", "foo.bar", "img", "br", "input", ":named", "table", "h1"];
function genWords(): string {
  const n = 1 + int(8);
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(pick(["lorem", "ipsum", "dolor", "sit", "amet,", "consectetur", "adipiscing", "elit.", "é", "日本語", "x\\", "a&amp;b", "100%"]));
  return w.join(pick([" ", " ", "  ", "\n", "\n  ", " \t"]));
}
function genExpr(depth: number): string {
  if (depth < 2 && rnd() < 0.2) return "(" + genExpr(depth + 1) + " " + genExpr(depth + 1) + (rnd() < 0.3 ? " k=" + genExpr(depth + 1) : "") + ")";
  return pick(WORDS);
}
function genMustache(): string {
  const n = int(4);
  let s = "{{" + pick(["", "", "~", "{", "&"]);
  if (s.endsWith("{") ) { s += "x"; return s + "}}}"; }
  s += pick(["foo", "if", "yield", "t", "my-helper", "this.go"]);
  for (let i = 0; i < n; i++) s += " " + genExpr(0);
  if (rnd() < 0.3) s += " " + pick(["a", "b", "key"]) + "=" + genExpr(0);
  return s + pick(["", "~"]) + "}}";
}
function genAttrs(): string {
  const n = int(5);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += pick([" ", " ", "\n  ", "\t"]);
    s += pick([
      "class=\"a b  c\"", "class=\"a {{b}} c\"", "class='x {{if y \"z w\"}}'", "id=x", "id={{y}}", "disabled", "title=\"it's {{z}}\"",
      "data-a='say \"hi\"'", "{{on 'click' this.go}}", "{{! note }}", "{{!-- note --}}", "@arg={{foo}}", "...attributes", "href=\"/p/{{id}}#x\"",
      "value=\"{{concat 'a ' b}}\"", "class=\"{{c}}\"", "class=\"{{c}} d\"", "a=''", "a=\"&quot;\"",
    ]);
  }
  return s;
}
function genBlock(depth: number): string {
  const h = pick(["if", "each", "unless", "with", "let"]);
  const as = h === "each" ? pick(["", " as |x i|"]) : h === "let" ? " as |v|" : "";
  let s = "{{" + pick(["", "", "~"]) + "#" + h + " " + genExpr(0) + (rnd() < 0.2 ? " k=" + genExpr(0) : "") + as + pick(["", "~"]) + "}}" + genNodes(depth + 1);
  if (h === "if" && rnd() < 0.4) s += "{{else if " + genExpr(0) + "}}" + genNodes(depth + 1);
  if (rnd() < 0.5) s += "{{" + pick(["", "~"]) + "else" + pick(["", "~"]) + "}}" + genNodes(depth + 1);
  return s + "{{" + pick(["", "~"]) + "/" + h + pick(["", "~"]) + "}}";
}
function genNode(depth: number): string {
  const r = rnd();
  if (depth > 4 || r < 0.25) return genWords();
  if (r < 0.45) return genMustache();
  if (r < 0.65) {
    const t = pick(TAGS);
    if (t === "img" || t === "br" || t === "input") return "<" + t + genAttrs() + pick([">", "/>", " />"]);
    return "<" + t + genAttrs() + (rnd() < 0.15 ? " as |x y|" : "") + ">" + genNodes(depth + 1) + "</" + t + ">";
  }
  if (r < 0.85) return genBlock(depth);
  if (r < 0.9) return "{{!" + pick(["", "--"]) + " " + pick(["c", "prettier-ignore", "x }} y", "a--b"]) + " " + pick(["", "--"]) + "}}";
  if (r < 0.95) return "<!-- " + pick(["c", "{{x}}", "a - b", ""]) + " -->";
  return pick(["&nbsp;", "\\{{x}}", "{{{raw}}}", "<!DOCTYPE html>"]);
}
function genNodes(depth: number): string {
  const n = int(4);
  let s = "";
  for (let i = 0; i < n; i++) s += pick(["", "", " ", "\n", "\n\n", "\n  "]) + genNode(depth);
  return s + pick(["", "\n"]);
}
function genTemplate(): string {
  return (rnd() < 0.1 ? "---\ntitle: x\nlist: [a,  b]\n---\n" : "") + genNodes(0);
}

const inputs = allInputs();
const genMode = flags.includes("--gen");
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const mutants: Buffer[] = [];
for (let i = 0; i < count; i++) {
  if (genMode) {
    mutants.push(Buffer.from(rnd() < 0.3 ? mutate(genTemplate()) : genTemplate(), "utf8"));
    continue;
  }
  const base = inputs[i % inputs.length].data.toString("utf8");
  mutants.push(Buffer.from(i < inputs.length ? base : mutate(base), "utf8"));
}
fs.writeFileSync(DIR + "/.prettierrc", JSON.stringify(rc));
for (let i = 0; i < mutants.length; i++) fs.writeFileSync(DIR + "/" + String(i).padStart(6, "0") + ".hbs", mutants[i]);

// --debug-check first (it writes nothing): the files whose formatting would change what they mean.
const dc = spawnSync(BUN, ["fmt", "--debug-check", DIR], { cwd: DIR, encoding: "latin1", maxBuffer: 1 << 28 });
const meaning = new Set<string>();
const dcRe = /formatting would change its meaning\n\s+at ([^\n]*?(\d{6})\.hbs)/g;
let dm: RegExpExecArray | null;
while ((dm = dcRe.exec((dc.stdout ?? "") + (dc.stderr ?? ""))) !== null) meaning.add(dm[2]);
const run = spawnSync(BUN, ["fmt", ...bunFlags, DIR], { cwd: DIR, encoding: "latin1", maxBuffer: 1 << 28 });
const log = (run.stdout ?? "") + (run.stderr ?? "");
// error blocks: "error: <msg>\n    at <file>:<line>:<col>"
const errors = new Map<string, { msg: string; line: number; col: number }>();
const re = /error: ([^\n]*)\n\s+at ([^\n:]*?(\d{6})\.hbs):(\d+):(\d+)/g;
let m: RegExpExecArray | null;
while ((m = re.exec(log)) !== null) errors.set(m[3], { msg: m[1], line: parseInt(m[4], 10), col: parseInt(m[5], 10) });

const options = new FormatOptions();
for (const k of Object.keys(rc)) options.set(k, String(rc[k]));
let diffs = 0;
let rejected = 0;
let same = 0;
let embeds = 0;
const sampleDir = "/tmp/hbs-fuzz-diffs";
fs.rmSync(sampleDir, { recursive: true, force: true });
fs.mkdirSync(sampleDir, { recursive: true });
for (let i = 0; i < mutants.length; i++) {
  const id = String(i).padStart(6, "0");
  const theirs = errors.get(id);
  let mine: ReturnType<typeof ours>;
  try {
    mine = ours(mutants[i], options);
  } catch (e) {
    console.log(id + ": CRASH " + String(e).substring(0, 80));
    fs.writeFileSync(sampleDir + "/crash-" + id + ".hbs", mutants[i]);
    diffs++;
    continue;
  }
  let diff = "";
  if (theirs !== undefined) {
    rejected++;
    if (mine.ok) diff = "we accept, bun rejects: " + theirs.msg;
    else if (mine.msg !== theirs.msg && !(mine.msg === "nested" || theirs.msg.includes("nested"))) diff = "message: ours '" + mine.msg + "' bun '" + theirs.msg + "'";
    else if (mine.line !== theirs.line || mine.col !== theirs.col) diff = "place: ours " + mine.line + ":" + mine.col + " bun " + theirs.line + ":" + theirs.col + " (" + theirs.msg + ")";
  } else {
    const result = Buffer.from(fs.readFileSync(DIR + "/" + id + ".hbs")).toString("latin1");
    if (!mine.ok) diff = "we reject (" + mine.msg + " " + mine.line + ":" + mine.col + "), bun accepts";
    else if (mine.out === result && (saysTheSame(new Uint8Array(mutants[i]), new Uint8Array(Buffer.from(result, "latin1")), options) !== 1) !== meaning.has(id)) {
      diff = "--debug-check: bun says " + (meaning.has(id) ? "changed" : "same");
    }
    else if (mine.out !== result) {
      const t = mutants[i].toString("latin1");
      diff = /<style/i.test(t) || /^(---|\+\+\+)/.test(t) ? "embed" : "output";
    }
  }
  if (diff === "") same++;
  else if (diff === "embed") embeds++;
  else {
    diffs++;
    if (diffs <= 40) {
      console.log(id + ": " + diff);
      fs.writeFileSync(sampleDir + "/" + id + ".hbs", mutants[i]);
    }
  }
}
console.log(`${mutants.length} cases (${rejected} rejected by bun), ${same} same, ${embeds} differ in style/front matter (not ported yet), ${diffs} different`);
if (!keep) fs.rmSync(DIR, { recursive: true, force: true });
