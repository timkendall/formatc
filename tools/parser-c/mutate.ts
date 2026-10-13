// Makes mutants of source files for the differential tests of the error output.
//   node tools/parser-c/mutate.ts <srcdir> <outdir> <count> [--seed N] [--exclude text] [--per N] [--ext js,ts,...]
// A mutant: a token deleted, a token of a list inserted, two neighbouring tokens swapped, a token duplicated, the text cut,
// a random byte replaced. Names are m<i>.<ext of the original>.
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const flag = (name: string, d: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : d;
};
const [srcDir, outDir, countS] = args;
const count = parseInt(countS, 10);
let seed = parseInt(flag("--seed", "1"), 10);
const exclude = flag("--exclude", "");
const per = parseInt(flag("--per", "3"), 10);
const exts = flag("--ext", "js,jsx,ts,tsx,mjs,cjs,mts,cts").split(",");

function rnd(): number {
  // xorshift32
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
}
function pick<T>(a: T[]): T {
  return a[Math.floor(rnd() * a.length)];
}

const files: string[] = [];
function walk(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (exts.some((x) => e.name.endsWith("." + x)) && (exclude === "" || !p.includes(exclude))) files.push(p);
  }
}
walk(srcDir);
files.sort();

const TOKENS = [
  "(", ")", "{", "}", "[", "]", ";", ",", ":", "=", "=>", "<", ">", "?", "!", "...", ".", "?.", "@", "#", "*", "&", "|", "`", "'", '"', "/",
  "async", "await", "yield", "class", "function", "return", "if", "else", "for", "of", "in", "new", "import", "export", "default", "const", "let", "var",
  "type", "interface", "enum", "declare", "abstract", "readonly", "static", "public", "private", "extends", "implements", "as", "satisfies", "keyof", "typeof",
  "infer", "is", "asserts", "namespace", "module", "global", "get", "set", "super", "this", "null", "<T>", "<>", "</", "/>", "x", "1", "0x", "\\u", "01", "1_",
];

// A rough tokenizer: ranges of words, numbers, strings, punctuation.
function tokens(text: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /[A-Za-z_$][\w$]*|\d[\w.]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|=>|\.\.\.|\?\.|[^\sA-Za-z_$\d]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  return out;
}

fs.mkdirSync(outDir, { recursive: true });
let made = 0;
let attempt = 0;
while (made < count && attempt < count * 20) {
  attempt++;
  const f = files[Math.floor(rnd() * files.length)];
  let text = fs.readFileSync(f, "utf8");
  if (text.length > 20000 || text.length < 5) continue;
  const toks = tokens(text);
  if (toks.length < 3) continue;
  for (let k = 0; k < per && made < count; k++) {
    const n = 1 + (rnd() < 0.2 ? 1 : 0);
    let t = text;
    for (let j = 0; j < n; j++) {
      const ts = tokens(t);
      if (ts.length < 3) break;
      const i = Math.floor(rnd() * ts.length);
      const [a, b] = ts[i];
      const kind = Math.floor(rnd() * 7);
      if (kind === 0) t = t.slice(0, a) + t.slice(b);
      else if (kind === 1) t = t.slice(0, a) + pick(TOKENS) + " " + t.slice(a);
      else if (kind === 2) t = t.slice(0, a) + pick(TOKENS) + t.slice(b);
      else if (kind === 3 && i + 1 < ts.length) {
        const [c, d] = ts[i + 1];
        t = t.slice(0, a) + t.slice(c, d) + t.slice(b, c) + t.slice(a, b) + t.slice(d);
      } else if (kind === 4) t = t.slice(0, b) + " " + t.slice(a, b) + t.slice(b);
      else if (kind === 5) t = t.slice(0, a + Math.floor(rnd() * (t.length - a)));
      else t = t.slice(0, a) + String.fromCharCode(33 + Math.floor(rnd() * 90)) + t.slice(b);
    }
    const ext = f.slice(f.lastIndexOf(".") + 1);
    fs.writeFileSync(path.join(outDir, "m" + made + "." + ext), t);
    made++;
  }
}
console.log("made", made, "from", files.length, "files");
