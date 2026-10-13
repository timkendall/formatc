// Self-test of src/base. `node src/base/base.test.ts` and the compiled binary print the same.
import { ByteBuf } from "./bytebuf.ts";
import { I32Vec } from "./i32vec.ts";
import { Interner } from "./intern.ts";
import { IntMap } from "./intmap.ts";
import { CC, CC_ALPHA, CC_DIGIT, CC_WS, asciiBytes, bytesToString, eqAscii, eqBytes, indexOfByte, lastIndexOfByte, utf8Bytes } from "./bytes.ts";
import { byteOffsetOfUtf16, decodeUtf8, decodeUtf8Back, encodeUtf8, isAscii, utf16Len, utf8Len } from "./utf8.ts";
import { Stack, getDefaultLimit, setDefaultLimit } from "./stack.ts";

let total = 0;
let failures = 0;
function check(name: string, actual: string, expected: string): void {
  total = total + 1;
  if (actual === expected) return;
  failures = failures + 1;
  console.log("FAIL " + name + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}
function checkNum(name: string, actual: number, expected: number): void {
  check(name, "" + actual, "" + expected);
}

// ByteBuf
{
  const b = new ByteBuf(4);
  for (let i = 0; i < 100; i++) b.push(i);
  const src = asciiBytes("hello world, this is a longer string for bulk append testing 0123456789");
  b.append(src, 0, 5);
  b.append(src, 6, src.length);
  b.appendAscii(" tail");
  b.fill(33, 3);
  b.appendUint(0);
  b.appendUint(7);
  b.appendUint(1234567890);
  checkNum("bytebuf len", b.len, 100 + 5 + (src.length - 6) + 5 + 3 + 1 + 1 + 10);
  checkNum("bytebuf first", b.data[0], 0);
  check("bytebuf tail", b.toLatin1().substring(b.len - 20), " tail!!!071234567890");
  b.truncate(100);
  checkNum("truncate", b.len, 100);
  b.reset();
  checkNum("reset", b.len, 0);
  b.appendAscii("abc");
  const o = new ByteBuf(2);
  o.appendBuf(b);
  check("appendBuf", o.toUtf8(), "abc");
  checkNum("view", b.view().length, 3);
}
// I32Vec
{
  const v = new I32Vec(2);
  for (let i = 0; i < 1000; i++) v.push(i * 3);
  checkNum("i32vec len", v.len, 1000);
  checkNum("i32vec get", v.get(999), 2997);
  checkNum("i32vec last", v.last(), 2997);
  checkNum("i32vec pop", v.pop(), 2997);
  v.truncate(10);
  checkNum("i32vec truncate", v.len, 10);
  v.set(3, -5);
  checkNum("i32vec set", v.get(3), -5);
}
// Interner
{
  const text = asciiBytes("foo bar foo baz bar foo quux");
  const it = new Interner();
  const ids: number[] = [];
  let s = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || (text[i] | 0) === 32) {
      ids.push(it.intern(text, s, i));
      s = i + 1;
    }
  }
  check("interner ids", ids.join(","), "0,1,0,2,1,0,3");
  checkNum("interner count", it.count, 4);
  check("interner text", it.text(ids[6]), "quux");
  for (let i = 0; i < 5000; i++) {
    const w = asciiBytes("id" + i);
    it.intern(w, 0, w.length);
  }
  checkNum("interner grown", it.count, 5004);
  const w77 = asciiBytes("id77");
  checkNum("interner same id", it.intern(w77, 0, 4), it.intern(w77, 0, 4));
  it.reset();
  checkNum("interner reset", it.intern(w77, 0, 4), 0);
}
// IntMap
{
  const m = new IntMap(4);
  for (let i = 0; i < 1000; i++) m.set(i * 5, i);
  checkNum("intmap size", m.size, 1000);
  checkNum("intmap get", m.get(500, -1), 100);
  checkNum("intmap missing", m.get(501, -1), -1);
  m.set(500, -1);
  check("intmap has -1 value", "" + m.has(500), "true");
  check("intmap has", "" + m.has(4995), "true");
  check("intmap has not", "" + m.has(4996), "false");
  m.clear();
  checkNum("intmap clear", m.size, 0);
  checkNum("intmap cleared", m.get(500, -2), -2);
}
// bytes
{
  const src = asciiBytes("hello world 123");
  check("eqAscii", eqAscii(src, 0, "hello") + "," + eqAscii(src, 6, "wxrld") + "," + eqAscii(src, 13, "23") + "," + eqAscii(src, 14, "23"), "true,false,true,false");
  check("eqBytes", "" + eqBytes(src, 0, src, 6, 0) + eqBytes(src, 0, asciiBytes("help"), 0, 3) + eqBytes(src, 0, asciiBytes("help"), 0, 4), "truetruefalse");
  checkNum("indexOfByte", indexOfByte(src, 0, src.length, 111), 4);
  checkNum("indexOfByte from", indexOfByte(src, 5, src.length, 111), 7);
  checkNum("indexOfByte none", indexOfByte(src, 0, src.length, 122), -1);
  checkNum("lastIndexOfByte", lastIndexOfByte(src, 0, src.length, 111), 7);
  check("CC", "" + ((CC[32] & CC_WS) !== 0) + ((CC[55] & CC_DIGIT) !== 0) + ((CC[97] & CC_ALPHA) !== 0) + ((CC[95] & CC_ALPHA) !== 0), "truetruetruefalse");
  check("bytesToString", bytesToString(utf8Bytes("a中b"), 0, 5), "a中b");
}
// utf8
{
  const s = utf8Bytes("aé中👍");
  checkNum("utf8 bytes", s.length, 1 + 2 + 3 + 4);
  checkNum("decode ascii", decodeUtf8(s, 0, s.length), 97);
  checkNum("decode 2", decodeUtf8(s, 1, s.length), 0xe9);
  checkNum("len 2", utf8Len(), 2);
  checkNum("decode 3", decodeUtf8(s, 3, s.length), 0x4e2d);
  checkNum("len 3", utf8Len(), 3);
  checkNum("decode 4", decodeUtf8(s, 6, s.length), 0x1f44d);
  checkNum("len 4", utf8Len(), 4);
  checkNum("decode back", decodeUtf8Back(s, 0, s.length), 0x1f44d);
  checkNum("back len", utf8Len(), 4);
  checkNum("decode back 3", decodeUtf8Back(s, 0, 6), 0x4e2d);
  const bad = new Uint8Array([0xe4, 0xb8, 0x41, 0xff, 0xc0, 0x80]);
  checkNum("invalid prefix", decodeUtf8(bad, 0, bad.length), 0xfffd);
  checkNum("invalid prefix len", utf8Len(), 2);
  checkNum("invalid byte", decodeUtf8(bad, 3, bad.length), 0xfffd);
  checkNum("invalid byte len", utf8Len(), 1);
  checkNum("overlong", decodeUtf8(bad, 4, bad.length), 0xfffd);
  checkNum("overlong len", utf8Len(), 1);
  const out = new ByteBuf(4);
  encodeUtf8(out, 0x1f44d);
  encodeUtf8(out, 0x4e2d);
  encodeUtf8(out, 0xe9);
  encodeUtf8(out, 65);
  check("encode", out.toUtf8(), "👍中éA");
  check("isAscii", "" + isAscii(asciiBytes("abc"), 0, 3) + isAscii(s, 0, s.length), "truefalse");
  checkNum("utf16Len", utf16Len(s, 0, s.length), 1 + 1 + 1 + 2);
  checkNum("byteOffsetOfUtf16", byteOffsetOfUtf16(s, 0, s.length, 3), 6);
  checkNum("byteOffsetOfUtf16 pair", byteOffsetOfUtf16(s, 0, s.length, 5), 10);
}
// Stack
{
  const st = new Stack(3);
  check("enter", "" + st.enter() + st.enter() + st.enter() + st.enter(), "truetruetruefalse");
  check("ranOut", "" + st.ranOut() + st.hasRoom(), "truefalse");
  st.reset();
  check("reset", "" + st.ranOut() + st.hasRoom(), "falsetrue");
  check("hasRoomAt", "" + st.hasRoomAt(2) + st.hasRoomAt(3), "truefalse");
  st.reset();
  st.enter();
  st.leave();
  checkNum("depth", st.depth, 0);
  const saved = getDefaultLimit();
  setDefaultLimit(8);
  checkNum("default limit", Stack.create().limit, 8);
  checkNum("tree limit", Stack.forTree().limit, 6);
  setDefaultLimit(saved);
  // A recursion guarded by the stack stops at the limit.
  const g = new Stack(50);
  checkNum("guarded recursion", guarded(g, 0), 50);
}

function guarded(st: Stack, depth: number): number {
  if (!st.enter()) return depth;
  const r = guarded(st, depth + 1);
  st.leave();
  return r;
}

console.log("checks: " + (total - failures) + "/" + total);
if (failures > 0) {
  console.log("FAILED");
  process.exit(1);
}
console.log("ok");
