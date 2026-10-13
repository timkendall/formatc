// Statements.
;
{}
{ let a = 1; { const b = 2; } }
var v1 = 1, v2, v3 = 3;
let l1, l2 = 2;
const c1 = 1, c2 = 2;
using u1 = foo();
using u2 = foo(), u3 = bar();
async function af() { await using u4 = foo(); for await (const x of y) {} await using u5 = a, u6 = b; }
function fd(a, b = 1, ...c) { return a; }
function* gen() { yield 1; yield* other(); }
async function* agen() { for await (const x of y) yield x; }
class C { constructor() {} }
if (a) b; else c;
if (a) { b } else if (c) { d } else { e }
if (a) function f() {}
for (;;) {}
for (let i = 0; i < 10; i++) {}
for (var i = 0, j = 1; i < j; i++, j--) {}
for (i = 0; ; ) break;
for (const k in obj) {}
for (var k2 in obj) continue;
for (const [a, b] of pairs) {}
for (const { a, b } of objs) {}
for (x of xs) {}
for (x.y of xs) {}
for (let of of xs) {}
for (async of => 1; ; ) break;
for (let in obj) {}
for (const x of (a, b)) {}
for (const x of a ? b : c) {}
while (a) b;
while (a) { break; }
do x(); while (y);
do { x(); } while (y)
lbl: for (;;) { continue lbl; }
lbl2: { break lbl2; }
a: b: c: d;
switch (x) { case 1: case 2: a(); break; default: b(); }
switch (x) {}
switch (x) { default: }
switch (x) { case 1: { let y; } case 2: let z = 1; }
try { a } catch (e) { b }
try { a } catch { b }
try { a } finally { c }
try { a } catch (e) { b } finally { c }
try { a } catch ({ message }) { b }
try { a } catch (e: unknown) { b }
throw new Error("x");
debugger;
with (obj) { x }
return1: ;
label: function lf() {}
x = 1;
x
++y
a
;[1, 2].forEach(f)
let async;
async
function nf() {}
let yield_ = 1;
let of = 1, get = 2, set = 3, type = 4, declare = 5, module = 6, namespace = 7, abstract = 8, readonly = 9, from = 10, as = 11, is = 12, asserts = 13;
type
Foo = 1;
declare
const dd = 1;
abstract
class AB {}
enum E { A, B = 2, C = "c", D = A | B, "quoted" = 1, [computed] = 2, 'single' = 3, F = `t`, G = 1n }
const enum CE { A = 1 }
export enum EE { A }
namespace NS1 { export const x = 1; }
namespace NS2.A.B { }
module MM { }
module "mod" { }
declare module "mod2" { }
namespace ND { export namespace Inner { export function f() {} } }
export namespace EN {}
@dec class DC {}
@dec() @dec2(1) class DC2 {}
@dec export class DC3 {}
export @dec class DC4 {}
@dec export default class {}
export default @dec class DC5 {}
class Members { @dec m() {} @dec() p = 1; @dec static s = 2; @dec accessor a = 3; constructor(@dec x: number) {} m2(@dec a, @dec() b) {} }
if (a) label3: b;
if (a) for (;;) ;
for (;;) if (a) break; else continue;
if (1) ; else ;
x = function () {};
x = async () => {};
(function () {})();
(() => {})();
!function () {}();
new (class {})();
a = b ? c : d;
a ||= b; a &&= c; a ??= d; a **= 2;
a?.b?.[c]?.(d);
a = `t${b}t`;
a = /re/g.test(b) ? 1 : 2;
if (a) /re/.test(b);
x = y / z / w;
let tagged = tag`a${b}c`;
let { a1, b1: { c1 }, ...rest1 } = obj;
let [a2, , b2 = 1, ...rest2] = arr;
({ a, b } = obj);
[a, b] = [b, a];
let big = 123n + 0x1fn;
let n = 1_000_000 + 0b1010 + 0o17 + .5 + 5. + 1e-3;
let s = 'a' + "b" + 'c\n';
let o = { a, b: 1, [c]: 2, d() {}, get e() { return 1; }, set e(v) {}, async f() {}, *g() {}, async *h() {}, ...spread, 'q': 1, 2: 3, [`t`]: 4 };
class K extends Base { static { init(); } static x = 1; #p = 2; get #g() { return 1; } static async *#m() {} 'quoted'() {} 123() {} [computed]() {} declare z; accessor w = 1; }
new.target;
import.meta.url;
import("./x");
import("./x", { with: { type: "json" } });
export {};
// More: contextual keywords, ASI hazards, using.
async function usingLoops() {
  for (using x of y) {}
  for (await using x of y) {}
  for (using of = 1; ; ) break;
  for (using in obj) {}
  await using y = z;
}
let
x2 = 1;
const
y2 = 2;
type = 5;
type
Foo2 = 1;
namespace
module
class AC2 {}
async
function af2() {}
var declare, abstract, interface_;
declare.x = 1;
abstract.y = 2;
module.exports = 1;
namespace.x = 1;
global.y = 2;
type.z = 3;
export declare abstract class DAC {}
export declare namespace DN { const x: number }
export default interface DI2 {}
export abstract class AC3 {}
enum ConstLike { const_ = 1, type = 2, interface = 3, async = 4 }
class Mods { public static readonly override async *[Symbol.iterator]() {} private declare x: number; protected abstract y: number; static accessor z = 1; public constructor(private readonly a: number, public b?: string, protected c = 1) {} }
class Idx { [k: string]: any; static [k: number]: string; readonly [k: symbol]: number }
function f3<const T extends readonly unknown[]>(x: T): T { return x; }
let v3 = <const T,>(x: T) => x;
let o3 = { async *[Symbol.asyncIterator]() {}, get [a]() { return 1; } };
switch (x) { case 1: { break; } case 2: let q; break; default: function fd() {} }
a: { b: { c: { break a; } } }
if (a) { } else if (b) { } else { }
try { } catch (e) { } finally { }
for (;;) { break; continue; }
do ; while (false)
while (false) ;
with (a) b;
x = y ? z : w ? v : u;
x = (a, b, c);
if (x) return1: y;
