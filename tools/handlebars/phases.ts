// Time of each phase of src/format/handlebars on one file.
//   scriptc build tools/handlebars/phases.ts -o /tmp/hbs-phases && /tmp/hbs-phases /tmp/hbsbig/big100.hbs
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { Elements, Printer as DocPrinter } from "../../src/format/css/doc.ts";
import { Tree } from "../../src/format/handlebars/ast.ts";
import { Tokens, lex } from "../../src/format/handlebars/lexer.ts";
import { Statements, parse } from "../../src/format/handlebars/parser.ts";
import { Printer } from "../../src/format/handlebars/printer.ts";
import { build } from "../../src/format/handlebars/tokenizer.ts";
import { FormatOptions } from "../../src/format/options.ts";

const data = new Uint8Array(fs.readFileSync(process.argv[2]));
const tokens = new Tokens();
const statements = new Statements();
const tree = new Tree();
const elements = new Elements();
const printer = new Printer();
const docPrinter = new DocPrinter();
const options = new FormatOptions();
const out = new ByteBuf(1 << 20);
const only = process.argv[3] !== undefined ? process.argv[3] : "";
const loops = only === "" ? 15 : 200;
let lastTpl = 0;
let tl = 1e18;
let tp = 1e18;
let tb = 1e18;
let tw = 1e18;
let td = 1e18;
for (let rep = 0; rep < loops; rep++) {
  let t0 = performance.now();
  let t1 = t0;
  let r1 = 0;
  let r2 = 0;
  let tpl = 0;
  if (only === "" || only === "lex" || rep === 0) {
    tokens.n = 0;
    tree.clear(data);
    t0 = performance.now();
    r1 = lex(data, tokens);
    t1 = performance.now();
    if (t1 - t0 < tl) tl = t1 - t0;
  }
  if (only === "" || only === "parse" || rep === 0) {
    tree.clear(data);
    t0 = performance.now();
    r2 = parse(data, tokens, tree, statements);
    t1 = performance.now();
    if (t1 - t0 < tp) tp = t1 - t0;
  }
  if (only === "" || only === "build" || rep === 0) {
    if (only === "build") {
      tree.clear(data);
      parse(data, tokens, tree, statements);
    }
    t0 = performance.now();
    tpl = build(data, statements, -1, tree);
    t1 = performance.now();
    if (t1 - t0 < tb) tb = t1 - t0;
    lastTpl = tpl;
  }
  if (only === "" || only === "write" || rep === 0) {
    t0 = performance.now();
    elements.clear();
    printer.init(tree, data, data, 0, options, elements);
    printer.template(lastTpl);
    t1 = performance.now();
    if (t1 - t0 < tw) tw = t1 - t0;
  }
  if (only === "" || only === "print" || rep === 0) {
    t0 = performance.now();
    out.reset();
    docPrinter.init(options, data, out);
    docPrinter.print(elements, 0, 0);
    t1 = performance.now();
    if (t1 - t0 < td) td = t1 - t0;
  }
  if (r1 < 0 || r2 < 0 || tpl < 0) console.log("error", r1, r2, tpl);
}
const mb = data.length / 1e6;
console.log("tokens " + tokens.n + " nodes " + tree.n + " elements " + elements.n + " out " + out.len);
console.log("lex   " + tl.toFixed(2) + " ms  " + (mb / (tl / 1000)).toFixed(0) + " MB/s");
console.log("parse " + tp.toFixed(2) + " ms  " + (mb / (tp / 1000)).toFixed(0) + " MB/s");
console.log("build " + tb.toFixed(2) + " ms  " + (mb / (tb / 1000)).toFixed(0) + " MB/s");
console.log("write " + tw.toFixed(2) + " ms  " + (mb / (tw / 1000)).toFixed(0) + " MB/s");
console.log("print " + td.toFixed(2) + " ms  " + (mb / (td / 1000)).toFixed(0) + " MB/s");
console.log("total " + (tl + tp + tb + tw + td).toFixed(2) + " ms  " + (mb / ((tl + tp + tb + tw + td) / 1000)).toFixed(0) + " MB/s");
