// Differential fuzzer: string widths of src/format/ir/width.ts against Prettier's `util.getStringWidth`.
//   node tools/width-fuzz.ts [count] [seed]
import { createRequire } from "node:module";
import { stringWidthAs } from "../src/format/ir/width.ts";

const require = createRequire(import.meta.url);
const prettierPath = process.env.PRETTIER ?? `${process.env.HOME}/.bun/install/cache/prettier@3.9.6@@@1/index.cjs`;
const getStringWidth: (s: string) => number = require(prettierPath).util.getStringWidth;

// Code points worth mixing: ASCII, latin-1, combining marks, CJK, hangul, fullwidth forms, emoji and what joins them.
const pools: number[][] = [
  [...Array(95).keys()].map((i) => 0x20 + i),
  [0xe9, 0xa0, 0xb7, 0xd7, 0xe0, 0x100, 0x3b1, 0x430, 0x5d0, 0x627, 0x644, 0x905],
  [0x300, 0x301, 0x36f, 0xfe0e, 0xfe0f, 0x200b, 0x200c, 0x20e3],
  [0x4e2d, 0x6587, 0x3042, 0x30a2, 0xac00, 0xd7a3, 0xff01, 0xff21, 0xffe0, 0x3000, 0x2e80, 0x1100],
  [0x1f600, 0x1f44d, 0x1f468, 0x1f469, 0x1f467, 0x1f466, 0x1f3fb, 0x1f3ff, 0x1f1fa, 0x1f1f8, 0x1f3f4, 0xe0067, 0xe007f, 0x2764, 0x2705, 0x231a, 0x23f0, 0x1f680, 0x2640, 0x2642, 0x26a1, 0x2b50, 0x1f9d1, 0x1f4a9],
  [0x23, 0x2a, 0x30, 0x39, 0xa9, 0xae, 0x203c, 0x2122, 0x2139, 0x2194, 0x25aa, 0x2600, 0x2702],
  [0x9, 0x1f, 0x7f, 0x80, 0x9f],
  [0x10000, 0x1d400, 0x20000, 0x2f800, 0x30000, 0xe000, 0xfffd],
];
const rgi = ["\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", "\u{1F469}\u200D\u{1F4BB}", "\u2764\uFE0F\u200D\u{1F525}", "\u{1F3F3}\uFE0F\u200D\u{1F308}", "\u{1F1FA}\u{1F1F8}", "\u{1F44D}\u{1F3FD}", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", "#\uFE0F\u20E3", "1\u20E3", "\u{1F9D1}\u{1F3FB}\u200D\u{1F91D}\u200D\u{1F9D1}\u{1F3FF}", "\u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F"];
let s = Number(process.argv[3] ?? 1);
function rnd(n: number): number {
  s = (Math.imul(s, 1103515245) + 12345) | 0;
  return ((s >>> 8) & 0xffffff) % n;
}
const count = Number(process.argv[2] ?? 20000);
let bad = 0;
const enc = new TextEncoder();
for (let i = 0; i < count; i++) {
  const n = 1 + rnd(8);
  let str = "";
  for (let k = 0; k < n; k++) {
    if (rnd(12) === 0) {
      // sequences that emoji-regex knows (the printer here also joins others: see ir/width.rs `emoji_len`)
      str += rgi[rnd(rgi.length)];
      continue;
    }
    const pool = pools[rnd(pools.length)];
    str += String.fromCodePoint(pool[rnd(pool.length)]);
  }
  if (/[\n\r\t]/.test(str)) str = str.replace(/[\n\r\t]/g, "");
  const bytes = enc.encode(str);
  const want = getStringWidth(str);
  const got = stringWidthAs(bytes, 0, bytes.length, 0);
  if (want !== got) {
    bad++;
    if (bad <= 15) console.log(`MISMATCH ${JSON.stringify(str)} ${[...str].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}: prettier ${want}, ours ${got}`);
  }
}
console.log(`${count - bad}/${count} widths agree with Prettier`);
process.exit(bad === 0 ? 0 : 1);
