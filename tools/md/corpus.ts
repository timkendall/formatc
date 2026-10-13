// The Markdown inputs of the tests of the md port: runs under node and bun.
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "..");

export interface Doc {
  name: string;
  bytes: Buffer;
}

/** `.md` files of bench/vscode (the list is /tmp/vscode-files.txt, relative to bench/vscode). */
export function vscodeDocs(): Doc[] {
  const list = fs.readFileSync("/tmp/vscode-files.txt", "utf8").split("\n").filter((l) => l.endsWith(".md"));
  return list.map((rel) => ({ name: "vscode/" + rel, bytes: fs.readFileSync(path.join(root, "bench/vscode", rel)) }));
}

/** The files of /tmp/prettier-bundle.txt: `=== /<path> <length>\n<bytes>\n`. */
export function prettierBundle(): Map<string, Buffer> {
  const buf = fs.readFileSync("/tmp/prettier-bundle.txt");
  const files = new Map<string, Buffer>();
  let at = 0;
  while (at < buf.length) {
    const end = buf.indexOf(10, at);
    const header = buf.toString("utf8", at + 5, end);
    const space = header.lastIndexOf(" ");
    const length = Number(header.slice(space + 1));
    files.set(header.slice(0, space), buf.subarray(end + 1, end + 1 + length));
    at = end + 1 + length + 1;
  }
  return files;
}

/** Prettier's fixtures under /markdown/ and /mdx/; with `snapshots` the snapshot files too (Markdown inside Markdown). */
export function prettierDocs(snapshots: boolean): Doc[] {
  const docs: Doc[] = [];
  for (const [name, bytes] of prettierBundle()) {
    if (!(name.startsWith("markdown/") || name.startsWith("mdx/"))) continue;
    if (name.includes("__snapshots__") && !snapshots) continue;
    docs.push({ name: "prettier/" + name, bytes });
  }
  return docs;
}

/** The examples of the CommonMark spec (spec.json) and of the GFM spec (spec.txt). */
export function specDocs(): Doc[] {
  const docs: Doc[] = [];
  const cm = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "data/commonmark-0.31.2.json"), "utf8"));
  for (const ex of cm) docs.push({ name: `commonmark/${ex.example}`, bytes: Buffer.from(ex.markdown) });
  const gfm = fs.readFileSync(path.join(import.meta.dirname, "data/gfm-0.29.txt"), "utf8").split("\n");
  let n = 0;
  for (let i = 0; i < gfm.length; i++) {
    if (gfm[i].startsWith("```````````````````````````````` example")) {
      const md: string[] = [];
      i++;
      while (i < gfm.length && gfm[i] !== "." && !gfm[i].startsWith("````````````````````````````````")) md.push(gfm[i++]);
      n++;
      docs.push({ name: `gfm/${n}`, bytes: Buffer.from(md.map((l) => l + "\n").join("").replace(/→/g, "\t")) });
    }
  }
  return docs;
}

/** A small deterministic PRNG. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
    s ^= s >>> 12;
    s = Math.imul(s, 0x5bd1e995) >>> 0;
    return (s >>> 0) / 4294967296;
  };
}

const TOKENS = [
  "> ", "- ", "* ", "1. ", "2) ", "    ", "\t", "# ", "## ", "```", "~~~", "---", "***", "___", "===", "|", "| - | - |",
  "[", "]", "](", ")", "![", "<", ">", "</", "<div>", "</div>", "<!--", "-->", "<?", "?>", "<![CDATA[", "&amp;", "&#x41;", "&bogus;",
  "\\", "`", "``", "*", "**", "_", "__", "~", "~~", "$", "$$", "[^a]", "[^a]: x", "[a]: /u 'x'", "[a]:", "<http://a.b>", "<a@b.co>",
  "www.a.com", "http://a.b/c", "a@b.co", "[[w]]", "{{x}}", "{% y %}", ":::", "::: note", "- [ ] ", "- [x] ", "  ", "\r\n", "\r", "\0",
  " ", " ", "é", "😀", "“", "。", "\n", "\n\n", "\n", "\n",
];

/** Documents made of the lines and bytes of `base` in other orders, cut, or with markers put in. */
export function mutate(base: Doc[], count: number, seed: number): Doc[] {
  const rand = rng(seed);
  const out: Doc[] = [];
  for (let k = 0; k < count; k++) {
    const doc = base[Math.floor(rand() * base.length)];
    let text = doc.bytes.toString("utf8");
    const kind = Math.floor(rand() * 8);
    if (kind === 0) {
      // lines in another order
      const lines = text.split("\n");
      const n = Math.min(lines.length, 30 + Math.floor(rand() * 60));
      const start = Math.floor(rand() * Math.max(1, lines.length - n));
      const part = lines.slice(start, start + n);
      for (let i = part.length - 1; i > 0; i--) {
        if (rand() < 0.3) {
          const j = Math.floor(rand() * (i + 1));
          [part[i], part[j]] = [part[j], part[i]];
        }
      }
      text = part.join("\n");
    } else if (kind === 1) {
      // a window of text
      const a = Math.floor(rand() * text.length);
      text = text.slice(a, a + 200 + Math.floor(rand() * 2000));
    } else if (kind === 2) {
      // tokens put in
      const parts = text.slice(0, 3000).split("\n");
      const edits = 1 + Math.floor(rand() * 8);
      for (let e = 0; e < edits; e++) {
        const i = Math.floor(rand() * parts.length);
        const t = TOKENS[Math.floor(rand() * TOKENS.length)];
        const col = Math.floor(rand() * (parts[i].length + 1));
        parts[i] = parts[i].slice(0, col) + t + parts[i].slice(col);
      }
      text = parts.join("\n");
    } else if (kind === 3) {
      // token soup
      const n = 5 + Math.floor(rand() * 60);
      const words = ["a", "b c", "foo", "x_y", "z*w", "1", "ü", ""];
      let s = "";
      for (let i = 0; i < n; i++) {
        s += TOKENS[Math.floor(rand() * TOKENS.length)];
        if (rand() < 0.6) s += words[Math.floor(rand() * words.length)];
        if (rand() < 0.25) s += rand() < 0.5 ? "\n" : " ";
      }
      text = s;
    } else if (kind === 4) {
      // lines made longer with indentation and quote markers
      const lines = text.split("\n").slice(0, 60);
      const prefixes = ["", "", "> ", "  ", "- ", "    ", "> > ", "1. ", "   - "];
      text = lines.map((l) => prefixes[Math.floor(rand() * prefixes.length)] + l).join("\n");
    } else if (kind === 5 || kind === 6) {
      text = structured(rand, kind === 6);
    } else {
      // bytes flipped
      const b = Buffer.from(text.slice(0, 1500), "utf8");
      const flips = 1 + Math.floor(rand() * 6);
      for (let f = 0; f < flips; f++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
      out.push({ name: `${doc.name}#m${k}`, bytes: b });
      continue;
    }
    out.push({ name: `${doc.name}#m${k}`, bytes: Buffer.from(text, "utf8") });
  }
  return out;
}

const strict = new TextDecoder("utf-8", { fatal: true });
/** Whether the bytes are valid UTF-8 (Bun.markdown.html's string output cannot show anything else). */
export function isValidUtf8(b: Buffer): boolean {
  try {
    strict.decode(b);
    return true;
  } catch {
    return false;
  }
}

const INLINES = [
  "a", "b c", "*", "**", "_", "__", "*a*", "**b**", "_c_", "~~d~~", "~e~", "`x`", "``y ` z``", "`", "[l](/u)", "[l](/u 'T')",
  "[l][r]", "[r]", "[r][]", "![i](/u)", "![i][r]", "![[w]]", "[[w|x]]", "[[w]](u)", "[", "]", "![", "](", ")", "<a>", "</a>",
  "<http://a.b>", "<a@b.co>", "<!-- c -->", "<!--", "<?p?>", "<![CDATA[x]]>", "&amp;", "&#35;", "&#xZ;", "&nope;", "\\*", "\\",
  "\\\n", "  \n", "www.a.com", "http://a.com/b_(c)", "a@b.co", "$x$", "$$", "$$x$$", "[^a]", "[^b]", "{{ a }}", "{% b %}",
  "{/* c */}", "😀", "é", "\u00a0", "\t", " ", "  ", "\0", "|", "\\|", "a|b",
];
const PREFIX_BLOCKS = ["> ", "- ", "* ", "+ ", "1. ", "2) ", "- [ ] ", "- [x] ", "[^a]: ", "[^b]: ", "::: note\n", "    ", "  ", "\t", ""];
const LEAVES = [
  "# h ##", "## h", "#h", "Setext\n===", "Setext\n---", "---", "***", "___", "- - -", "```js", "```", "~~~", "$$", "[r]: /u 'T'",
  "[r]: <a b> \"t\"", "[r]:\n/u\n'T'", "| a | b |\n|---|:-:|\n| 1 | 2 |", "<div>", "</div>", "<script>", "</script>", "<!-- x", "-->",
  "<b>", "<x-y z='1'>", "<A.b c>", "import x from 'y'", "export const a = 1", ":::", "",
];

/** Block structure (nested quotes, lists, footnotes, directives) with inline soup in it. */
function structured(rand: () => number, mdx: boolean): string {
  const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];
  const lines = 3 + Math.floor(rand() * 25);
  const stack: string[] = [];
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const r = rand();
    if (r < 0.25 && stack.length < 5) stack.push(pick(PREFIX_BLOCKS));
    else if (r < 0.4 && stack.length > 0) stack.pop();
    else if (r < 0.45) stack.length = 0;
    let content: string;
    if (rand() < 0.3) content = pick(LEAVES);
    else {
      content = "";
      const n = 1 + Math.floor(rand() * 6);
      for (let k = 0; k < n; k++) content += pick(INLINES) + (rand() < 0.5 ? " " : "");
    }
    const prefix = stack.map((s) => (rand() < 0.15 ? "  " : s)).join("");
    out.push(prefix + content);
    if (rand() < 0.2) out.push("");
  }
  if (mdx && rand() < 0.5) out.unshift("import a from 'b'", "");
  return out.join(rand() < 0.1 ? "\r\n" : "\n") + (rand() < 0.8 ? "\n" : "");
}
