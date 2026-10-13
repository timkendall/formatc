// Formats the given files (or stdin) with src/format/css and prints the result. Dev tool (node).
//   node tools/css/run.ts [--tabs] [--width=N] file.css ...
import { readFileSync } from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions, INDENT_TAB } from "../../src/format/options.ts";
import { format, parserForPath, PARSER_CSS } from "../../src/format/css/mod.ts";
import { refusalMessage, refusalOffset, messageText } from "../../src/format/syntax_error.ts";

const args = process.argv.slice(2);
const options = new FormatOptions();
const files: string[] = [];
for (const a of args) {
  if (a === "--tabs") options.indentStyle = INDENT_TAB;
  else if (a.startsWith("--width=")) options.lineWidth = Number(a.slice(8));
  else if (a.startsWith("--set=")) {
    const [k, v] = a.slice(6).split("=");
    options.set(k, v);
  } else files.push(a);
}
for (const f of files) {
  const src = new Uint8Array(readFileSync(f));
  const out = new ByteBuf(src.length * 2 + 16);
  let parser = parserForPath(f);
  if (parser < 0) parser = PARSER_CSS;
  const r = format(src, parser, options, out);
  if (r !== 0) {
    console.error(`${f}: error ${r} ${r === 2 ? messageText(refusalMessage()) + " at " + refusalOffset() : ""}`);
    continue;
  }
  process.stdout.write(out.view());
}
