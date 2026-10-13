// The Handlebars files of the vscode tree against what `bun fmt` made of them (bench/vscode-fmt/<path>).
//   node tools/handlebars/vscode.ts
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FORMAT_OK } from "../../src/format/errors.ts";
import { format } from "../../src/format/handlebars/mod.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { messageText, refusalReason } from "../../src/format/syntax_error.ts";

const root = "/Users/timkendall/Developer/lab/scriptc-formatter/bench/";
const list = fs.readFileSync("/tmp/vscode-files.txt", "latin1").split("\n").filter((l) => l.endsWith(".hbs") || l.endsWith(".handlebars"));
let same = 0;
for (const rel of list) {
  const input = new Uint8Array(fs.readFileSync(root + "vscode/" + rel));
  const expected = fs.readFileSync(root + "vscode-fmt/" + rel);
  const out = new ByteBuf(1024);
  const r = format(input, new FormatOptions(), out);
  // A file that is refused stays as it is.
  const produced = r === FORMAT_OK ? Buffer.from(out.view()) : Buffer.from(input);
  const ok = Buffer.compare(produced, expected) === 0;
  let note = "";
  if (r !== FORMAT_OK) {
    const e = refusalReason();
    let line = 1;
    let col = 1;
    for (let i = 0; i < e.offset; i++) {
      if (input[i] === 10) {
        line++;
        col = 1;
      } else col++;
    }
    note = ", refused: " + messageText(e.message) + " at " + line + ":" + col;
  }
  if (ok) same++;
  console.log((ok ? "same      " : "DIFFERENT ") + rel + " (" + input.length + " bytes, code " + r + note + ")");
}
console.log(same + "/" + list.length);
