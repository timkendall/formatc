// Phases of the YAML formatter on the vscode corpus: `node tools/yaml/bench.ts [reps]` (or compiled).
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { Elements, Printer } from "../../src/format/css/doc.ts";
import { yamlParseAsWritten } from "../../src/parsers/yaml.ts";
import { build } from "../../src/format/yaml/ast.ts";
import { printTree, setup } from "../../src/format/yaml/printer.ts";
import { formatYaml } from "../../src/format/yaml/mod.ts";

const ROOT = new URL("../../bench/vscode/", import.meta.url).pathname;
const reps = Number(process.argv[2] ?? "20");
const only = process.argv[3] ?? "";
const files = fs.readFileSync("/tmp/vscode-files.txt", "utf8").split("\n").filter((x) => x && (x.endsWith(".yml") || x.endsWith(".yaml")));
const sources: Uint8Array[] = [];
const ok: boolean[] = [];
let bytes = 0;
const options = new FormatOptions();
options.set("tabWidth", "2");
for (const f of files) {
  const b = fs.readFileSync(ROOT + f);
  sources.push(new Uint8Array(b));
  bytes += b.length;
}
const els = new Elements();
const printer = new Printer();
const out = new ByteBuf(1 << 20);

function best(name: string, fn: () => void): number {
  if (only !== "" && !name.startsWith(only + " ") && name !== only) return 0;
  let b = 1e18;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    fn();
    const dt = performance.now() - t0;
    if (dt < b) b = dt;
  }
  console.log(name.padEnd(28), b.toFixed(2).padStart(8), "ms", (bytes / 1e6 / (b / 1000)).toFixed(1).padStart(7), "MB/s");
  return b;
}

for (let i = 0; i < sources.length; i++) ok.push(yamlParseAsWritten(sources[i], sources[i].length) === 0);
best("parse", () => {
  for (let i = 0; i < sources.length; i++) yamlParseAsWritten(sources[i], sources[i].length);
});
best("build (= parse + build)", () => {
  for (let i = 0; i < sources.length; i++) {
    if (yamlParseAsWritten(sources[i], sources[i].length) === 0) build(sources[i], sources[i].length);
  }
});
best("write (= ... + write)", () => {
  for (let i = 0; i < sources.length; i++) {
    if (yamlParseAsWritten(sources[i], sources[i].length) === 0 && build(sources[i], sources[i].length) === 0) {
      els.clear();
      setup(els, sources[i], sources[i].length, 2, false, true, true, 2, false);
      printTree();
    }
  }
});
best("print (= ... + print)", () => {
  for (let i = 0; i < sources.length; i++) {
    if (yamlParseAsWritten(sources[i], sources[i].length) === 0 && build(sources[i], sources[i].length) === 0) {
      els.clear();
      setup(els, sources[i], sources[i].length, 2, false, true, true, 2, false);
      printTree();
      out.reset();
      printer.init(options, sources[i], out);
      printer.print(els, 0, 0);
    }
  }
});
best("format (formatYaml)", () => {
  for (let i = 0; i < sources.length; i++) {
    out.reset();
    formatYaml(sources[i], sources[i].length, options, out);
  }
});
