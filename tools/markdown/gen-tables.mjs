import fs from "node:fs";
const src = fs.readFileSync("vendor/bun/src/format/markdown/unicode_tables.rs", "utf8");
const re = /pub\(super\) const (\w+): &\[\(u32, u32\)\] = &\[([\s\S]*?)\n\];/g;
let out = "// GENERATED from vendor/bun/src/format/markdown/unicode_tables.rs by tools/markdown/gen-tables.mjs. Sorted ranges as\n// flat pairs (lo, hi, lo, hi, ...) of code points, for `isIn` (strings.ts).\n\n";
let m;
while ((m = re.exec(src))) {
  const nums = [...m[2].matchAll(/\(0x([0-9A-Fa-f]+), 0x([0-9A-Fa-f]+)\)/g)].flatMap((x) => [parseInt(x[1], 16), parseInt(x[2], 16)]);
  const doc = src.slice(0, m.index).split("\n").filter((l) => l.startsWith("///")).slice(-1)[0] ?? "";
  out += `${doc.replace("///", "//")}\nexport const ${m[1]}: Int32Array = new Int32Array([\n`;
  for (let i = 0; i < nums.length; i += 12) out += "  " + nums.slice(i, i + 12).join(", ") + ",\n";
  out += "]);\n\n";
}
fs.writeFileSync("src/format/markdown/unicode_tables.ts", out);
