// Differential fuzzer: src/format/text.ts against Prettier's `util` (skipSpaces, hasNewline, isNextLineEmpty, ...).
//   node tools/text-fuzz.ts [count] [seed]
import { createRequire } from "node:module";
import * as X from "../src/format/text.ts";
import { ByteBuf } from "../src/base/bytebuf.ts";

const require = createRequire(import.meta.url);
const prettierPath = process.env.PRETTIER ?? `${process.env.HOME}/.bun/install/cache/prettier@3.9.6@@@1/index.cjs`;
const U = require(prettierPath).util;

const parts = ["a", "b", " ", "  ", "\t", "\n", "\r\n", "\r", ",", ";", "/* c */", "/*", "*/", "// c", "//", " ", " ", "x y", "é"];
let seed = Number(process.argv[3] ?? 1);
function rnd(n: number): number {
  seed = (Math.imul(seed, 1103515245) + 12345) | 0;
  return ((seed >>> 8) & 0xffffff) % n;
}
const enc = new TextEncoder();
const count = Number(process.argv[2] ?? 5000);
let bad = 0;
// A string index to its UTF-8 byte offset.
function byteOffsets(str: string): number[] {
  const out: number[] = [];
  let b = 0;
  for (let i = 0; i < str.length; i++) {
    out.push(b);
    const c = str.charCodeAt(i);
    if (c < 0x80) b += 1;
    else if (c < 0x800) b += 2;
    else if (c >= 0xd800 && c < 0xdc00) { b += 4; out.push(b); i++; }
    else b += 3;
  }
  out.push(b);
  return out;
}
function fail(name: string, text: string, i: number, want: unknown, got: unknown): void {
  bad++;
  if (bad <= 15) console.log(`MISMATCH ${name} text=${JSON.stringify(text)} at ${i}: prettier ${want}, ours ${got}`);
}
for (let n = 0; n < count; n++) {
  let text = "";
  const k = 1 + rnd(10);
  for (let i = 0; i < k; i++) text += parts[rnd(parts.length)];
  const bytes = enc.encode(text);
  const off = byteOffsets(text);
  // string index -> byte offset; only compare at character boundaries (not inside a surrogate pair: none here)
  for (let i = 0; i <= text.length; i++) {
    const bi = off[i];
    const conv = (idx: number): number => off[idx];
    // forwards
    const w1 = conv(U.skipSpaces(text, i));
    const g1 = X.skipSpaces(bytes, bi);
    if (w1 !== g1) fail("skipSpaces", text, i, w1, g1);
    const w2 = U.hasNewline(text, i);
    if (w2 !== X.hasNewline(bytes, bi)) fail("hasNewline", text, i, w2, X.hasNewline(bytes, bi));
    const w3 = U.hasNewline(text, i, { backwards: true });
    if (w3 !== X.hasNewlineBackwards(bytes, bi)) fail("hasNewlineBackwards", text, i, w3, X.hasNewlineBackwards(bytes, bi));
    const w4 = U.isNextLineEmpty(text, i);
    if (w4 !== X.isNextLineEmpty(bytes, bi)) fail("isNextLineEmpty", text, i, w4, X.isNextLineEmpty(bytes, bi));
    const w5 = U.isPreviousLineEmpty(text, i);
    if (w5 !== X.isPreviousLineEmpty(bytes, bi)) fail("isPreviousLineEmpty", text, i, w5, X.isPreviousLineEmpty(bytes, bi));
    const w6 = conv(U.skipInlineComment(text, i));
    if (w6 !== X.skipInlineComment(bytes, bi)) fail("skipInlineComment", text, i, w6, X.skipInlineComment(bytes, bi));
    const w7 = conv(U.skipTrailingComment(text, i));
    if (w7 !== X.skipTrailingComment(bytes, bi)) fail("skipTrailingComment", text, i, w7, X.skipTrailingComment(bytes, bi));
    const w8 = conv(U.skipNewline(text, i));
    if (w8 !== X.skipNewline(bytes, bi)) fail("skipNewline", text, i, w8, X.skipNewline(bytes, bi));
  }
  // makeString
  const content = "a'b\"c\\'d\\\"e\\nf\\";
  for (const q of ['"', "'"]) {
    const want = U.makeString(content, q);
    const out = new ByteBuf(32);
    const cb = enc.encode(content);
    X.makeString(cb, 0, cb.length, q.charCodeAt(0), out);
    if (n === 0 && want !== out.toUtf8()) fail("makeString", content, 0, want, out.toUtf8());
  }
}
console.log(`${bad === 0 ? "all agree" : bad + " mismatches"} with Prettier (${count} texts)`);
process.exit(bad === 0 ? 0 : 1);
