// Checks that the expectations in src/format/ir/cases.ts are what Prettier's `printDocToString` prints.
//   PRETTIER_DOC=/path/to/prettier/doc.js node tools/ir-check.ts
import { createRequire } from "node:module";
import { cases } from "../src/format/ir/cases.ts";
import * as T from "../src/format/ir/testdoc.ts";

const require = createRequire(import.meta.url);
const docPath = process.env.PRETTIER_DOC ?? `${process.env.HOME}/.bun/install/cache/prettier@3.9.6@@@1/doc.js`;
const prettier = require(docPath);
const dd = prettier.builders ? prettier : prettier.doc;
const b = dd.builders;
const symbols = new Map<number, symbol>();
const sym = (id: number) => { let s = symbols.get(id); if (!s) { s = Symbol("g" + id); symbols.set(id, s); } return s; };
function toPrettier(d: T.D): any {
  const kids = () => d.kids.map(toPrettier);
  switch (d.kind) {
    case T.D_TEXT: return d.s;
    case T.D_LINE: return b.line;
    case T.D_SOFTLINE: return b.softline;
    case T.D_HARDLINE: return b.hardline;
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
let bad = 0;
const all = cases();
for (const c of all) {
  symbols.clear();
  const got = dd.printer.printDocToString(toPrettier(c.doc), { printWidth: c.width, tabWidth: c.tabWidth, useTabs: c.useTabs, endOfLine: "lf" }).formatted;
  if (got !== c.expected) {
    bad++;
    console.log(`MISMATCH ${c.name}\n  prettier: ${JSON.stringify(got)}\n  expected: ${JSON.stringify(c.expected)}`);
  }
}
console.log(`${all.length - bad}/${all.length} expectations agree with Prettier`);
process.exit(bad === 0 ? 0 : 1);
