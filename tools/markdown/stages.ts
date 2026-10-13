// Time spent in each stage of src/format/markdown over a list of files: md parse (events only), tree, preprocess, print (document),
// printDoc (layout). `node tools/markdown/stages.ts LIST ROOT [REPS]` or compiled.
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions, INDENT_TAB } from "../../src/format/options.ts";
import { Tree } from "../../src/format/markdown/ast.ts";
import { parse, SY_MARKDOWN } from "../../src/format/markdown/parse.ts";
import { Preprocessor } from "../../src/format/markdown/preprocess.ts";
import { EmbedHook, Printer, printDocument } from "../../src/format/markdown/printer.ts";
import { docPop, docPush } from "../../src/format/css/doc.ts";

const args = process.argv.slice(2);
const list = fs.readFileSync(args[0], "utf8").split("\n").filter((l) => l.endsWith(".md"));
const root = args[1];
const reps = args.length > 2 ? Number(args[2]) : 5;
const files: Uint8Array[] = [];
let total = 0;
for (let i = 0; i < list.length; i++) {
  const b = fs.readFileSync(root + "/" + list[i]);
  files.push(new Uint8Array(b));
  total += b.length;
}
const options = new FormatOptions();
options.indentStyle = INDENT_TAB;
const tree = new Tree();
const out = new ByteBuf(1 << 20);
const hook = new EmbedHook();
let tParse = 1e18;
let tPre = 1e18;
let tPrint = 1e18;
let tLayout = 1e18;
let sink = 0;
for (let rep = 0; rep < reps; rep++) {
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  for (let i = 0; i < files.length; i++) {
    const text = files[i];
    const t0 = performance.now();
    const root = parse(text, text, SY_MARKDOWN, tree, -1);
    const t1 = performance.now();
    const pre = new Preprocessor(text, text, false, false, false, tree, 2, true);
    pre.run(root);
    const t2 = performance.now();
    docPush();
    const printer = new Printer(text, text, tree, options, hook, false, false);
    const doc = printer.print(root);
    const t3 = performance.now();
    out.reset();
    sink = sink + printDocument(doc, options, text, out);
    const t4 = performance.now();
    docPop();
    a = a + (t1 - t0);
    b = b + (t2 - t1);
    c = c + (t3 - t2);
    d = d + (t4 - t3);
  }
  if (a < tParse) tParse = a;
  if (b < tPre) tPre = b;
  if (c < tPrint) tPrint = c;
  if (d < tLayout) tLayout = d;
}
console.log(`parse ${tParse.toFixed(1)} ms, preprocess ${tPre.toFixed(1)} ms, print ${tPrint.toFixed(1)} ms, layout ${tLayout.toFixed(1)} ms; ${(total / 1e6).toFixed(2)} MB; sink ${sink}`);
