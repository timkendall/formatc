// Differential fuzzer: random documents printed by src/format/ir and by Prettier's own printDocToString.
// Dev tool (node only, never compiled). Usage:
//   PRETTIER_DOC=/path/to/prettier/doc.js node tools/ir-fuzz.ts [count] [firstSeed] [depth] [wide]
// Prettier 3.9.x `doc.js` (e.g. ~/.bun/install/cache/prettier@3.9.6@@@1/doc.js).
import { createRequire } from "node:module";
import { ByteBuf } from "../src/base/bytebuf.ts";
import { FormatOptions, INDENT_TAB } from "../src/format/options.ts";
import { Scratch, startDocument, finishAndPrint } from "../src/format/ir/run.ts";
import * as T from "../src/format/ir/testdoc.ts";

const require = createRequire(import.meta.url);
const docPath = process.env.PRETTIER_DOC ?? `${process.env.HOME}/.bun/install/cache/prettier@3.9.6@@@1/doc.js`;
const prettier = require(docPath);
const dd = prettier.builders ? prettier : prettier.doc;
const b = dd.builders;
const printDocToString = dd.printer.printDocToString;

const symbols = new Map<number, symbol>();
function sym(id: number): symbol {
  let s = symbols.get(id);
  if (!s) { s = Symbol("g" + id); symbols.set(id, s); }
  return s;
}

function toPrettier(d: T.D): any {
  const kids = () => d.kids.map(toPrettier);
  switch (d.kind) {
    case T.D_TEXT: return d.s;
    case T.D_LINE: return b.line;
    case T.D_SOFTLINE: return b.softline;
    case T.D_HARDLINE: return b.hardline;
    case T.D_EMPTY_LINE: return [b.hardline, b.hardline];
    case T.D_SPACE: return " ";
    case T.D_BREAK_PARENT: return b.breakParent;
    case T.D_LINE_SUFFIX_BOUNDARY: return b.lineSuffixBoundary;
    case T.D_SEQ: return kids();
    case T.D_GROUP: return b.group(kids(), { shouldBreak: d.flag, ...(d.id ? { id: sym(d.id) } : {}) });
    case T.D_INDENT: return b.indent(kids());
    case T.D_ALIGN: return b.align(d.n, kids());
    case T.D_DEDENT: return b.dedent(kids());
    case T.D_DEDENT_ROOT: return b.dedentToRoot(kids());
    case T.D_IF_BREAK: return b.ifBreak(toPrettier(d.kids[0]), toPrettier(d.kids[1]), d.id ? { groupId: sym(d.id) } : {});
    case T.D_INDENT_IF_BREAK: return b.indentIfBreak(kids(), { groupId: sym(d.id) });
    case T.D_FILL: return b.fill(kids());
    case T.D_LINE_SUFFIX: return b.lineSuffix(kids());
    case T.D_BEST: return b.conditionalGroup(kids());
    case T.D_LABEL: return kids();
    case T.D_SOFT_BLOCK_INDENT: return [b.indent([b.softline, kids()]), b.softline];
    case T.D_BLOCK_INDENT: return [b.indent([b.hardline, kids()]), b.hardline];
    case T.D_SOFT_SPACE_BLOCK_INDENT: return [b.indent([b.line, kids()]), b.line];
    case T.D_TOKEN_IF_BREAKS: return b.ifBreak(d.s);
    case T.D_INDENTED_LINE_GROUP: return b.group(b.indent(b.line), { id: sym(d.id) });
  }
  throw new Error("kind " + d.kind);
}

function dump(d: T.D, ind = ""): string {
  const names = ["text", "line", "softline", "hardline", "group", "indent", "align", "dedent", "dedentToRoot", "ifBreak", "indentIfBreak", "fill", "lineSuffix", "lineSuffixBoundary", "breakParent", "best", "seq", "space", "label", "emptyLine", "softBlockIndent", "blockIndent", "softSpaceBlockIndent", "tokenIfBreaks", "indentedLineGroup"];
  let s = `${ind}${names[d.kind]}${d.kind === 0 ? " " + JSON.stringify(d.s) : ""}${d.n ? " n=" + d.n : ""}${d.id ? " id=" + d.id : ""}${d.flag ? " BREAK" : ""}\n`;
  for (const k of d.kids) s += dump(k, ind + "  ");
  return s;
}

function runBoth(rnd: T.D, widthPick: number, tabWidth: number, useTabs: boolean): [string, string] {
  const opts = new FormatOptions();
  opts.lineWidth = widthPick;
  opts.indentWidth = tabWidth;
  if (useTabs) opts.indentStyle = INDENT_TAB;
  symbols.clear();
  let expected: string;
  try {
    expected = printDocToString(toPrettier(rnd), { printWidth: widthPick, tabWidth, useTabs, endOfLine: "lf" }).formatted;
  } catch (e) {
    expected = "<prettier error>";
  }
  const f = startDocument(scratch, new Uint8Array(0), opts, null);
  T.emit(new T.Emitter(f), rnd);
  const out = new ByteBuf(256);
  const r = finishAndPrint(f, out);
  return [expected, r === 0 ? out.toUtf8() : `<error ${r}>`];
}

// Candidate simplifications of a document that keep it valid (an item is text-bounded, items and separators alternate):
// replace an item by a word, replace a wrapper by its content, drop an item and a separator from a sequence.
function isSep(d: T.D): boolean {
  return d.kind === T.D_SPACE || d.kind === T.D_EMPTY_LINE || d.kind === T.D_LINE || d.kind === T.D_SOFTLINE || d.kind === T.D_HARDLINE || d.kind === T.D_INDENTED_LINE_GROUP;
}
function* shrinks(d: T.D): Generator<T.D> {
  if (d.kind === T.D_SEQ) {
    // drop item i and a neighbouring separator
    for (let i = 0; i < d.kids.length; i++) {
      if (isSep(d.kids[i]) || d.kids.length < 3) continue;
      const kids = d.kids.slice();
      if (i + 1 < kids.length) kids.splice(i, 2);
      else kids.splice(i - 1, 2);
      yield new T.D(d.kind, d.s, d.n, d.id, d.flag, kids);
    }
  }
  for (let i = 0; i < d.kids.length; i++) {
    const k = d.kids[i];
    if (!isSep(k) && k.kind !== T.D_TEXT && d.kind !== T.D_IF_BREAK) {
      const kids = d.kids.slice();
      kids[i] = T.text("x");
      yield new T.D(d.kind, d.s, d.n, d.id, d.flag, kids);
    }
    for (const sub of shrinks(k)) {
      const kids = d.kids.slice();
      kids[i] = sub;
      yield new T.D(d.kind, d.s, d.n, d.id, d.flag, kids);
    }
  }
  if (d.kids.length === 1 && d.kids[0].kind === T.D_SEQ &&
      (d.kind === T.D_GROUP || d.kind === T.D_INDENT || d.kind === T.D_ALIGN || d.kind === T.D_DEDENT || d.kind === T.D_DEDENT_ROOT || d.kind === T.D_LABEL)) {
    yield d.kids[0];
  }
  if (d.kind === T.D_BEST && d.kids.length > 2) {
    for (let i = 0; i < d.kids.length; i++) {
      const kids = d.kids.slice();
      kids.splice(i, 1);
      yield new T.D(d.kind, d.s, d.n, d.id, d.flag, kids);
    }
  }
  if (d.kind === T.D_TEXT && d.s.length > 1) yield T.text(d.s.slice(0, d.s.length - 1));
  if (d.kind === T.D_GROUP && d.flag) yield new T.D(d.kind, d.s, d.n, d.id, false, d.kids);
}

function shrink(d: T.D, w: number, tw: number, tabs: boolean): T.D {
  let cur = d;
  let progress = true;
  while (progress) {
    progress = false;
    for (const cand of shrinks(cur)) {
      let res: [string, string];
      try { res = runBoth(cand, w, tw, tabs); } catch (e) { continue; }
      const e = res[0];
      // Candidates with adjacent line breaks differ by design (Prettier prints an empty line).
      const sane = !e.includes("\n\n") && !e.startsWith("\n") && !e.endsWith("\n") && !/[ \t]\n/.test(e) && /^\S/.test(e) && /\S$/.test(e);
      if (sane && res[0] !== res[1] && !res[1].startsWith("<error") && res[0] !== "<prettier error>") {
        cur = cand;
        progress = true;
        break;
      }
    }
  }
  return cur;
}

const count = Number(process.argv[2] ?? 1000);
const first = Number(process.argv[3] ?? 1);
const depth = Number(process.argv[4] ?? 4);
const wide = process.argv[5] === "wide";
let bad = 0;
let shown = 0;
const scratch = new Scratch(new FormatOptions());
for (let seed = first; seed < first + count; seed++) {
  const rnd = T.randomDoc(seed, depth, wide);
  const widthPick = [10, 16, 20, 30, 40, 80][seed % 6];
  const useTabs = seed % 5 === 0;
  const tabWidth = seed % 3 === 0 ? 4 : 2;
  const opts = new FormatOptions();
  opts.lineWidth = widthPick;
  opts.indentWidth = tabWidth;
  if (useTabs) opts.indentStyle = INDENT_TAB;
  symbols.clear();
  const expected: string = printDocToString(toPrettier(rnd), { printWidth: widthPick, tabWidth, useTabs, endOfLine: "lf" }).formatted;
  const f = startDocument(scratch, new Uint8Array(0), opts, null);
  T.emit(new T.Emitter(f), rnd);
  const out = new ByteBuf(256);
  const r = finishAndPrint(f, out);
  const actual = r === 0 ? out.toUtf8() : `<error ${r}>`;
  if (actual !== expected) {
    bad++;
    if (shown < Number(process.env.SHOW ?? 3)) {
      shown++;
      console.log(`--- MISMATCH seed=${seed} width=${widthPick} tabs=${useTabs} tabWidth=${tabWidth}`);
      const small = process.env.SHRINK ? shrink(rnd, widthPick, tabWidth, useTabs) : rnd;
      const [e2, a2] = runBoth(small, widthPick, tabWidth, useTabs);
      console.log(dump(small));
      console.log("expected (prettier):\n" + JSON.stringify(e2) + "\n" + e2);
      console.log("actual (ir):\n" + JSON.stringify(a2) + "\n" + a2);
    }
  }
}
console.log(`${count - bad}/${count} match`);
process.exit(bad === 0 ? 0 : 1);
