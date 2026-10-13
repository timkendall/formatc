// Differential test of the HTML renderer of the TS port against Bun's own (`Bun.markdown.html`).
//   bun tools/md/diff-html.ts [--fuzz N] [--seed S] [--only vscode|prettier|spec] [--show K]
// Each document is rendered with several sets of options.
import fs from "node:fs";
import { ByteBuf, Options, renderToHtmlWithOptions } from "../../src/md/lib.ts";
import type { Doc } from "./corpus.ts";
import { cases as stressCases } from "./stress-cases.ts";
import { isValidUtf8, mutate, prettierDocs, specDocs, vscodeDocs } from "./corpus.ts";

interface Config {
  name: string;
  bun: Record<string, unknown>;
  ours: (o: Options) => void;
}

const configs: Config[] = [
  { name: "default", bun: {}, ours: () => {} },
  { name: "autolinks", bun: { autolinks: true }, ours: (o) => { o.permissiveAutolinks = true; } },
  { name: "wiki+atx+tagfilter", bun: { wikiLinks: true, permissiveAtxHeaders: true, tagFilter: true }, ours: (o) => { o.wikiLinks = true; o.permissiveAtxHeaders = true; o.tagFilter = true; } },
  { name: "nocode+nohtml", bun: { noIndentedCodeBlocks: true, noHtmlBlocks: true, noHtmlSpans: true }, ours: (o) => { o.noIndentedCodeBlocks = true; o.noHtmlBlocks = true; o.noHtmlSpans = true; } },
  { name: "headings", bun: { headings: true }, ours: (o) => { o.headingIds = true; o.autolinkHeadings = true; } },
  { name: "headingids", bun: { headings: { ids: true } }, ours: (o) => { o.headingIds = true; } },
  { name: "nogfm", bun: { tables: false, strikethrough: false, tasklists: false }, ours: (o) => { o.tables = false; o.strikethrough = false; o.tasklists = false; } },
];

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const fuzz = Number(argOf("--fuzz", "0"));
const seed = Number(argOf("--seed", "1"));
const only = argOf("--only", "");
const show = Number(argOf("--show", "5"));

const sets: [string, Doc[]][] = [];
if (!only || only === "spec") sets.push(["spec", specDocs()]);
if (!only || only === "stress") sets.push(["stress", stressCases.map(([name, text]) => ({ name, bytes: Buffer.from(text) }))]);
if (!only || only === "vscode") sets.push(["vscode", vscodeDocs()]);
if (!only || only === "prettier") sets.push(["prettier", prettierDocs(true)]);
if (fuzz > 0) {
  const base = sets.flatMap(([, d]) => d);
  sets.push(["fuzz", mutate(base, fuzz, seed)]);
}

const out = new ByteBuf(1 << 16);
const lossy = (b: Buffer) => b.toString("utf8").replace(/\uFFFD+/g, "\uFFFD");
let total = 0;
let diffs = 0;
fs.mkdirSync("/tmp/md-diffs", { recursive: true });
for (const [setName, docs] of sets) {
  let setTotal = 0;
  let setDiffs = 0;
  for (const doc of docs) {
    const valid = isValidUtf8(doc.bytes);
    for (const cfg of configs) {
      const options = new Options();
      cfg.ours(options);
      out.reset();
      const rc = renderToHtmlWithOptions(doc.bytes, options, out);
      const mine = Buffer.from(out.view());
      let theirs: Buffer;
      try {
        theirs = Buffer.from(Bun.markdown.html(doc.bytes, cfg.bun));
      } catch (e) {
        theirs = Buffer.from("ERROR " + e);
      }
      setTotal++;
      // Invalid UTF-8 cannot be seen in a string: compare what a lossy decoder makes of both, runs of U+FFFD as one.
      const same = valid
        ? mine.equals(theirs)
        : lossy(mine) === lossy(theirs);
      if (rc !== 0 || !same) {
        setDiffs++;
        if (setDiffs <= show) {
          const base = `/tmp/md-diffs/${setName}-${cfg.name}-${setDiffs}`;
          fs.writeFileSync(base + ".md", doc.bytes);
          fs.writeFileSync(base + ".ours.html", mine);
          fs.writeFileSync(base + ".bun.html", theirs);
          console.log(`DIFF ${setName} ${doc.name} [${cfg.name}] -> ${base}.*`);
        }
      }
    }
  }
  console.log(`${setName}: ${docs.length} documents x ${configs.length} option sets = ${setTotal} renders, ${setDiffs} differ`);
  total += setTotal;
  diffs += setDiffs;
}
console.log(`total ${total} renders, ${diffs} differ`);
process.exit(diffs === 0 ? 0 : 1);
