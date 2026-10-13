// Correctness self-test for the reference libs. Output must be identical under `node --experimental-transform-types` and the compiled exe.
import { ByteBuf } from "./bytebuf.ts";
import { I32Vec } from "./i32vec.ts";
import { Interner } from "./intern.ts";
import { IntMap } from "./hashtable.ts";
import { AstArena } from "./ast_arena.ts";
import { eqAscii } from "./bytes.ts";
import { Lexer, T_IDENT, T_EOF } from "./lexer_template.ts";

// ByteBuf
const bb = new ByteBuf(4);
for (let i = 0; i < 100; i++) bb.push(i);
const src = Buffer.from("hello world, this is a longer string for bulk append testing 0123456789");
bb.append(src, 0, 5);          // short path
bb.append(src, 6, src.length); // bulk path
bb.appendAscii(" tail");
bb.fill(33, 3);
console.log("bytebuf", bb.len, bb.data[0], bb.data[99], bb.view().subarray(100, 105).toString("latin1"), bb.view().subarray(bb.len - 8).toString("latin1"));
// I32Vec
const v = new I32Vec(2);
for (let i = 0; i < 1000; i++) v.push(i * 3);
console.log("i32vec", v.len, v.get(999), v.pop(), v.len);
// Interner
const text = Buffer.from("foo bar foo baz bar foo quux");
const it = new Interner();
const ids: number[] = [];
let s = 0;
for (let i = 0; i <= text.length; i++) {
  if (i === text.length || (text[i] | 0) === 32) { ids.push(it.intern(text, s, i)); s = i + 1; }
}
console.log("interner", ids.join(","), it.count, it.text(ids[3]), it.text(ids[6]));
// grow interner
let big = 0;
for (let i = 0; i < 5000; i++) { const b = Buffer.from("id" + i); big = big + it.intern(b, 0, b.length); }
console.log("interner2", it.count, it.intern(Buffer.from("id77"), 0, 4) === it.intern(Buffer.from("id77"), 0, 4));
// IntMap
const m = new IntMap(4);
for (let i = 0; i < 1000; i++) m.set(i * 5, i);
console.log("intmap", m.size, m.get(500, -1), m.get(501, -1), m.get(4995, -1));
// AstArena
const a = new AstArena(2);
const root = a.add(1, 0, 10, 0);
let last = 0;
for (let i = 0; i < 100; i++) { const n = a.add(2, i, i + 1, i * 2); a.appendChild(root, last, n); last = n; }
let sum = 0; let c = a.first[root] | 0;
while (c !== 0) { sum += a.data[c] | 0; c = a.next[c] | 0; }
console.log("arena", a.count, sum);
// bytes helpers
console.log("eqAscii", eqAscii(src, 0, "hello"), eqAscii(src, 6, "world"), eqAscii(src, 6, "wxrld"), eqAscii(src, src.length - 2, "89"), eqAscii(src, src.length - 1, "89"));
// Lexer
const code = Buffer.from("const x = 42; // c\nfoo('a\\'b') /* z */ bar.baz");
const lx = new Lexer(code, code.length);
let nt = 0; let idents = 0; let k = lx.next(); let lastText = "";
while (k !== T_EOF) { nt++; if (k === T_IDENT) idents++; lastText = code.toString("latin1", lx.tokStart, lx.tokEnd); k = lx.next(); }
console.log("lexer", nt, idents, lastText);
