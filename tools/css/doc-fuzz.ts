// Differential fuzzer: random documents printed by src/format/css/doc.ts (Doc pool -> Elements -> Printer) and by Prettier's
// own printDocToString. Dev tool (node only, never compiled). Usage:
//   node tools/css/doc-fuzz.ts [count] [firstSeed] [depth]
// Also checks: Elements.toTree() round trip, textToDoc (= Prettier's stripTrailingHardline(cleanDoc(doc)) in effect).
import { createRequire } from "node:module";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions, INDENT_TAB } from "../../src/format/options.ts";
import * as D from "../../src/format/css/doc.ts";

const require = createRequire(import.meta.url);
const docPath = process.env.PRETTIER_DOC ?? `${process.env.HOME}/.bun/install/cache/prettier@3.9.6@@@1/doc.js`;
const prettier = require(docPath);
const dd = prettier.builders ? prettier : prettier.doc;
const b = dd.builders;
const printDocToString = dd.printer.printDocToString;

let seed = 1;
function rnd(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
  return (seed >>> 8) / 16777216;
}
function ri(n: number): number {
  return Math.floor(rnd() * n);
}

// A spec: plain objects
type Spec = { k: string; s?: string; n?: number; id?: number; flag?: boolean; kids?: Spec[]; cond?: boolean };

const WORDS = ["a", "bb", "ccc", "foo", "bar", "{", "}", "(", ")", ",", "x y", "日本", " ", "  ", "abc def", ""];
let nextId = 1;
let seenIds: number[] = [];

function gen(depth: number): Spec {
  const choices = depth <= 0 ? 5 : 21;
  switch (ri(choices)) {
    case 0: return { k: "text", s: WORDS[ri(WORDS.length)] };
    case 1: return { k: "line" };
    case 2: return { k: "softline" };
    case 3: return { k: "hardline" };
    case 4: return { k: "text", s: "word" + ri(100) };
    case 5: return { k: "array", kids: genKids(depth) };
    case 6: return { k: "array", kids: genKids(depth) };
    case 7: return { k: "group", flag: ri(5) === 0, kids: [gen(depth - 1)] };
    case 8: return { k: "group", flag: false, kids: [gen(depth - 1)] };
    case 9: { const id = nextId++; seenIds.push(id); return { k: "group", id, flag: ri(6) === 0, kids: [gen(depth - 1)] }; }
    case 10: return { k: "indent", kids: [gen(depth - 1)] };
    case 11: return { k: "align", n: ri(5), kids: [gen(depth - 1)] };
    case 12: return { k: "dedent", kids: [gen(depth - 1)] };
    case 13: return { k: "dedentToRoot", kids: [gen(depth - 1)] };
    case 14: return { k: "markAsRoot", kids: [gen(depth - 1)] };
    case 15: return { k: "fill", kids: genFill(depth) };
    case 16: {
      const id = seenIds.length > 0 && ri(2) === 0 ? seenIds[ri(seenIds.length)] : 0;
      return { k: "ifBreak", id, kids: [gen(depth - 1), gen(depth - 1)] };
    }
    case 17: return { k: "lineSuffix", kids: [gen(depth - 1)] };
    case 18: return { k: "lsb" };
    case 19: return { k: "breakParent" };
    default: return { k: "literalline" };
  }
}
function genKids(depth: number): Spec[] {
  const n = ri(5);
  const kids: Spec[] = [];
  for (let i = 0; i < n; i++) kids.push(gen(depth - 1));
  return kids;
}
function genFill(depth: number): Spec[] {
  const n = ri(6);
  const kids: Spec[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) kids.push(ri(3) === 0 ? gen(depth - 1) : { k: "text", s: WORDS[ri(WORDS.length)] });
    else kids.push(ri(4) === 0 ? { k: "hardline" } : ri(2) === 0 ? { k: "line" } : { k: "softline" });
  }
  return kids;
}

const symbols = new Map<number, symbol>();
function sym(id: number): symbol {
  let s = symbols.get(id);
  if (!s) { s = Symbol("g" + id); symbols.set(id, s); }
  return s;
}

function toPrettier(d: Spec): any {
  const kids = () => (d.kids ?? []).map(toPrettier);
  switch (d.k) {
    case "text": return d.s;
    case "line": return b.line;
    case "softline": return b.softline;
    case "hardline": return b.hardline;
    case "literalline": return b.literallineWithoutBreakParent;
    case "array": return kids();
    case "group": return b.group(kids()[0], { shouldBreak: !!d.flag, ...(d.id ? { id: sym(d.id) } : {}) });
    case "indent": return b.indent(kids()[0]);
    case "align": return b.align(d.n!, kids()[0]);
    case "dedent": return b.dedent(kids()[0]);
    case "dedentToRoot": return b.dedentToRoot(kids()[0]);
    case "markAsRoot": return b.markAsRoot(kids()[0]);
    case "fill": return b.fill(kids());
    case "ifBreak": return b.ifBreak(toPrettier(d.kids![0]), toPrettier(d.kids![1]), d.id ? { groupId: sym(d.id) } : {});
    case "lineSuffix": return b.lineSuffix(kids()[0]);
    case "lsb": return b.lineSuffixBoundary;
    case "breakParent": return b.breakParent;
  }
  throw new Error("kind " + d.k);
}

const enc = new TextEncoder();
function toDoc(d: Spec): number {
  const p = D.docPool;
  switch (d.k) {
    case "text": { const bs = enc.encode(d.s!); return D.docText(bs, 0, bs.length); }
    case "line": return D.DOC_LINE_DOC;
    case "softline": return D.DOC_SOFTLINE;
    case "hardline": return D.hardline();
    case "literalline": return D.DOC_LITERAL_LINE;
    case "array": { const m = p.begin(); for (const k of d.kids!) p.add(toDoc(k)); return p.array(m); }
    case "group": return p.groupFull(toDoc(d.kids![0]), !!d.flag, d.id ?? 0, false);
    case "indent": return p.indent(toDoc(d.kids![0]));
    case "align": return p.alignWithSpaces(d.n!, toDoc(d.kids![0]));
    case "dedent": return p.dedent(toDoc(d.kids![0]));
    case "dedentToRoot": return p.dedentToRoot(toDoc(d.kids![0]));
    case "markAsRoot": return p.markAsRoot(toDoc(d.kids![0]));
    case "fill": { const m = p.begin(); for (const k of d.kids!) p.add(toDoc(k)); return p.fill(m); }
    case "ifBreak": { const x = toDoc(d.kids![0]); const y = toDoc(d.kids![1]); return p.ifBreak(x, y, d.id ?? 0); }
    case "lineSuffix": return p.lineSuffix(toDoc(d.kids![0]));
    case "lsb": return D.DOC_LSB_DOC;
    case "breakParent": return D.DOC_BREAK_PARENT_DOC;
  }
  throw new Error("kind " + d.k);
}

function dump(d: Spec, ind = ""): string {
  let s = `${ind}${d.k}${d.s !== undefined ? " " + JSON.stringify(d.s) : ""}${d.n ? " n=" + d.n : ""}${d.id ? " id=" + d.id : ""}${d.flag ? " BREAK" : ""}\n`;
  for (const k of d.kids ?? []) s += dump(k, ind + "  ");
  return s;
}

const count = Number(process.argv[2] ?? 2000);
const first = Number(process.argv[3] ?? 1);
const maxDepth = Number(process.argv[4] ?? 4);
const dec = new TextDecoder();
let bad = 0;
let badTree = 0;
let badStrip = 0;
for (let i = 0; i < count; i++) {
  seed = (first + i) | 0;
  nextId = 1;
  seenIds = [];
  const spec = gen(maxDepth);
  const width = [10, 20, 40, 80][ri(4)];
  const useTabs = process.env.NOTABS ? false : ri(4) === 0;
  const tabWidth = [2, 4][ri(2)];
  const opts = new FormatOptions();
  opts.lineWidth = width;
  opts.indentWidth = tabWidth;
  if (useTabs) opts.indentStyle = INDENT_TAB;
  symbols.clear();
  let expected: string;
  try {
    expected = printDocToString(toPrettier(spec), { printWidth: width, tabWidth, useTabs, endOfLine: "lf", parentParser: "" }).formatted;
  } catch (e) {
    continue;
  }
  D.docReset();
  const out = new ByteBuf(64);
  const doc = toDoc(spec);
  const r = D.printDoc(doc, opts, new Uint8Array(0), out);
  const got = dec.decode(out.view());
  if (r !== 0 || got !== expected) {
    bad++;
    if (bad <= 3) {
      console.log(`--- seed ${first + i} width ${width} tabs ${useTabs} tab ${tabWidth} r=${r}`);
      console.log(dump(spec));
      console.log("expected:", JSON.stringify(expected));
      console.log("got:     ", JSON.stringify(got));
    }
    continue;
  }
  // round trip through Elements.toTree()
  {
    const el = new D.Elements();
    el.document(doc);
    const tree = el.toTree();
    const out2 = new ByteBuf(64);
    const r2 = D.printDoc(tree, opts, new Uint8Array(0), out2);
    const got2 = dec.decode(out2.view());
    if (r2 !== 0 || got2 !== expected) {
      badTree++;
      if (badTree <= 2) console.log(`TREE seed ${first + i}\n` + dump(spec) + "\nexpected:", JSON.stringify(expected), "\ngot:     ", JSON.stringify(got2));
    }
  }
  // textToDoc vs stripTrailingHardline
  {
    const t = D.textToDoc(doc);
    const out3 = new ByteBuf(64);
    D.printDoc(t, opts, new Uint8Array(0), out3);
    const got3 = dec.decode(out3.view());
    const stripped = dd.utils.stripTrailingHardline(toPrettier(spec));
    symbols.clear();
    let e3: string;
    try {
      e3 = printDocToString(dd.utils.stripTrailingHardline(toPrettier(spec)), { printWidth: width, tabWidth, useTabs, endOfLine: "lf", parentParser: "" }).formatted;
      void stripped;
    } catch (e) { continue; }
    if (got3 !== e3) {
      badStrip++;
      if (badStrip <= 2) console.log(`STRIP seed ${first + i}\n` + dump(spec) + "\nexpected:", JSON.stringify(e3), "\ngot:     ", JSON.stringify(got3));
    }
  }
}
console.log(`${count} documents: ${bad} differ, ${badTree} tree round trips differ, ${badStrip} textToDoc differ`);
