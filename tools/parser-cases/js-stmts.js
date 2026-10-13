// JavaScript statements (module).
import a, { b as c } from "x";
import * as ns from "y" with { type: "json" };
export { a as default, c };
export * from "z";
export * as nss from "z";
export default async function () {}
export const [e1, { e2 }] = [1, {}];
var v = 1, w;
let l = 2, m;
const k = 3;
function f(a, b = 1, ...rest) { "use strict"; return a; }
function* g() { yield 1; yield* g(); }
async function h() { await 1; for await (const x of y) {} }
class A extends B { static #p = 1; #q; static { init(); } get x() { return 1; } set x(v) {} static async *m() {} constructor() { super(); } }
label: for (const x of xs) { if (x) continue label; else break label; }
outer: while (true) { inner: do { break outer; } while (false); }
for (var i = 0, j = 10; i < j; i++, j--) ;
for (const key in obj) if (key) continue;
for (let [a1, b1] of pairs) {}
for (let of of ofs) {}
for (async of => 1; ;) break;
switch (x) { case 1: case 2: f(); break; default: g(); }
try { f(); } catch { g(); } finally { h(); }
try { f(); } catch ({ message }) {}
if (a) b; else if (c) d; else { e; }
if (a) ; else ;
do x++; while (x < 5)
while (x--) ;
throw new Error("e");
x = a ? b : c;
x = y => z;
x = async y => z;
x = async (y, z) => { await y; };
x = (a, b) => a + b;
x = function* () {};
x = class {};
x = `t${a}t`;
x = /re/gi;
x = a?.b?.[c]?.(d);
x = a ?? b;
x ||= 1; x &&= 2; x ??= 3;
x = { a, b, c: 1, [d]: 2, e() {}, get f() { return 1; }, set f(v) {}, async g() {}, *h() {}, ...i };
({ a, b } = obj);
[a, b] = [b, a];
new.target;
import.meta;
import("m");
a
++b
a = b
(c)
a = 1
;[1].map(f)
var async, of, get, set, let_, yield_, await_;
let x1 = 1_000, x2 = 0xFFn, x3 = 0b11, x4 = 0o7, x5 = .5e-3;
if (a) function ff() {}
;;;
{ }
{ let blockScoped; }
debugger;
using u = f();
