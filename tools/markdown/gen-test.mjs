import { cases } from "./gen-test-cases.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const bun = process.env.HOME + "/.bun/bin/bun";
let out = `// Self-test of src/format/markdown: texts and what \`bun fmt\` makes of them. \`node src/format/markdown/markdown.test.ts\`; compiled it prints
// the same. (Generated once with \`tools/markdown/gen-test.mjs\`; the expectations are Bun's output.)
import { ByteBuf } from "../../base/bytebuf.ts";
import { utf8Bytes } from "../../base/bytes.ts";
import { FormatOptions } from "../options.ts";
import { format, formatMdx } from "./mod.ts";

let total = 0;
let failures = 0;

function run(name: string, input: string, isMdx: boolean, flags: string[][], expected: string): void {
  total = total + 1;
  const options = new FormatOptions();
  for (let i = 0; i < flags.length; i++) options.set(flags[i][0], flags[i][1]);
  const out = new ByteBuf(256);
  const text = utf8Bytes(input);
  const r = isMdx ? formatMdx(text, options, out) : format(text, options, out);
  const actual = r === 0 ? out.toLatin1() : "(error " + r + ")";
  const want = new ByteBuf(expected.length + 8);
  want.appendAll(utf8Bytes(expected));
  if (actual !== want.toLatin1()) {
    failures = failures + 1;
    console.log("FAIL " + name + ": expected " + JSON.stringify(want.toUtf8()) + ", got " + JSON.stringify(r === 0 ? out.toUtf8() : actual));
  }
}

`;
for (const [name, input, flags, optionPairs, file] of cases) {
  const args = [];
  for (const [k, v] of optionPairs) {
    // bun fmt takes prettier options from a .prettierrc: use a temp dir
  }
  const dir = fs.mkdtempSync("/tmp/md-gen-test-");
  const fname = file || "a.md";
  if (optionPairs.length) {
    const rc = {};
    for (const [k, v] of optionPairs) rc[k] = v === "true" ? true : v === "false" ? false : /^\d+$/.test(v) ? Number(v) : v;
    fs.writeFileSync(dir + "/.prettierrc", JSON.stringify(rc));
  }
  fs.writeFileSync(dir + "/" + fname, Buffer.from(input, "utf8"));
  let expected;
  try {
    execFileSync(bun, ["fmt", fname], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    expected = fs.readFileSync(dir + "/" + fname).toString("utf8");
  } catch (e) {
    console.error("bun failed for", name, String(e.stderr));
    continue;
  }
  const isMdx = fname.endsWith(".mdx");
  out += `run(${JSON.stringify(name)}, ${JSON.stringify(input)}, ${isMdx}, ${JSON.stringify(optionPairs)}, ${JSON.stringify(expected)});\n`;
}
out += `
console.log(total - failures + "/" + total + " markdown checks passed");
if (failures > 0) process.exit(1);
`;
fs.writeFileSync("/Users/timkendall/Developer/lab/scriptc-formatter/src/format/markdown/markdown.test.ts", out);
