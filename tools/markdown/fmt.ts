// Formats a Markdown file with src/format/markdown: `node tools/markdown/fmt.ts a.md [--mdx] [--prose-wrap=always]`.
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { format, formatMdx } from "../../src/format/markdown/mod.ts";

const args = process.argv.slice(2);
const file = args.filter((a) => !a.startsWith("--"))[0];
const options = new FormatOptions();
for (const a of args) {
  if (a.startsWith("--") && a.includes("=")) options.set(a.slice(2).split("=")[0], a.slice(2).split("=")[1]);
}
const text = new Uint8Array(fs.readFileSync(file));
const out = new ByteBuf(text.length + 64);
const r = args.includes("--mdx") ? formatMdx(text, options, out) : format(text, options, out);
if (r !== 0) {
  console.error("failed", r);
  process.exit(1);
}
fs.writeSync(1, out.data, 0, out.len);
