// Renders Markdown files to HTML with the TS port: node tools/md/html.ts [+opt|-opt]... FILE   (options: camelCase names)
import fs from "node:fs";
import { ByteBuf, Options, renderToHtmlWithOptions } from "../../src/md/lib.ts";

const args = process.argv.slice(2);
const file = args.pop() as string;
const options = new Options();
for (const a of args) {
  if (a === "--bare") { options.clearAll(); continue; }
  if (!options.setByName(a.slice(1), a[0] === "+")) throw new Error("unknown option " + a);
}
const out = new ByteBuf(1 << 16);
const rc = renderToHtmlWithOptions(fs.readFileSync(file), options, out);
if (rc !== 0) throw new Error("error " + rc);
process.stdout.write(out.view());
