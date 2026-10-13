// Markdown in a template of JavaScript (src/format/markdown/embed.ts) through the IR, against what `bun fmt` makes of the same
// file: `node tools/markdown/embed-test.ts`. The JavaScript around the template is written by hand: `const x = md` + the template.
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { Scratch, startDocument, finishAndPrint } from "../../src/format/ir/run.ts";
import { writeMarkdownTemplate } from "../../src/format/markdown/embed.ts";

const cases: string[] = [
  "# Title\n\nSome *text* here\n\n- a\n- b\n",
  "\n    # Indented\n\n    Para with \\`code\\` and a [link](http://x.y).\n\n    \\`\\`\\`json\n    {\"a\":1}\n    \\`\\`\\`\n",
  "- a\n- b\n  - c\n\n  para\n\n\nend *x* __y__\n",
  "text with \\` backtick and \\`code\\`\n\n\n\nafter\n",
  "> quote\n> more\n\n1. one\n2. two\n",
  "| a | b |\n|--|--|\n| 1 | 2 |\n",
];
const options = new FormatOptions();
const scratch = new Scratch(options);
let ok = 0;
for (const body of cases) {
  const raw = new TextEncoder().encode(body);
  const f = startDocument(scratch, new Uint8Array(0), options, null);
  f.tokenStr("const x = md");
  const wrote = writeMarkdownTemplate(f, raw, 0, raw.length, options);
  f.tokenStr(";");
  f.hardLineBreak();
  const out = new ByteBuf(256);
  const r = finishAndPrint(f, out);
  const ours = wrote && r === 0 ? out.toUtf8() : "(not written)";
  const src = "const x = md`" + body + "`;\n";
  fs.writeFileSync("/tmp/embed-case.js", src);
  let theirs = "(error)";
  try {
    theirs = execFileSync(process.env.HOME + "/.bun/bin/bun", ["fmt", "--stdin-filepath=a.js"], { input: src, stdio: ["pipe", "pipe", "ignore"] }).toString();
  } catch {
    // keep "(error)"
  }
  if (ours === theirs) ok++;
  else console.log("DIFF for", JSON.stringify(body), "\n--- ours\n" + ours + "--- theirs\n" + theirs);
}
console.log(`${ok}/${cases.length} equal`);
