import os, json
S = {}
S["enum_regular"] = '''enum Kind { A, B, C = 10, D }
const k: Kind = Kind.C;
console.log(Kind.A, Kind.D, k, Kind[10]);
function f(x: Kind): number { switch (x) { case Kind.A: return 1; case Kind.C: return 3; default: return 0; } }
console.log(f(Kind.A), f(Kind.C), f(Kind.D));'''
S["enum_const"] = '''const enum T { X = 1, Y = 2 }
console.log(T.X + T.Y);'''
S["enum_string"] = '''enum E { A = "a", B = "b" }
const e: E = E.B; console.log(e, E.A === "a");'''
S["optional_chain"] = '''class A { b: A | null = null; v: number = 5; }
const a = new A(); a.b = new A();
console.log(a.b?.v, a.b?.b?.v, a?.v);
const arr: number[] | undefined = [1,2]; console.log(arr?.[1], arr?.length);
const u: number | undefined = undefined; console.log(u ?? 7, (u as number | undefined)?.toFixed);'''
S["destructure"] = '''const [a, b, ...rest] = [1, 2, 3, 4, 5];
const { x, y = 9 } = { x: 1 } as { x: number; y?: number };
function f({ p, q }: { p: number; q: number }): number { return p + q; }
function g([m, n]: [number, number]): number { return m * n; }
console.log(a, b, rest, x, y, f({ p: 1, q: 2 }), g([3, 4]));
let s = 1, t = 2; [s, t] = [t, s]; console.log(s, t);'''
S["spread"] = '''const a = [1, 2]; const b = [...a, 3, ...a];
function sum(...xs: number[]): number { let s = 0; for (const x of xs) s += x; return s; }
console.log(b, sum(...b), Math.max(...b));
const o1 = { p: 1, q: 2 }; const o2 = { ...o1, q: 3 }; console.log(o2.p, o2.q);'''
S["getters_setters"] = '''class C { private _v = 1; get v(): number { return this._v; } set v(n: number) { this._v = n * 2; } static get K(): number { return 7; } }
const c = new C(); c.v = 5; console.log(c.v, C.K);'''
S["abstract_class"] = '''abstract class Shape { abstract area(): number; describe(): string { return "area=" + this.area(); } }
class Sq extends Shape { constructor(private s: number) { super(); } area(): number { return this.s * this.s; } }
class Rect extends Shape { constructor(public w: number, public h: number) { super(); } area(): number { return this.w * this.h; } }
const shapes: Shape[] = [new Sq(2), new Rect(2, 3)];
for (const s of shapes) console.log(s.describe());'''
S["interface_methods"] = '''interface Visitor { visit(n: number): number; name: string; }
class V implements Visitor { name = "v"; visit(n: number): number { return n + 1; } }
function run(v: Visitor): number { return v.visit(1); }
console.log(run(new V()), new V().name);
const lit: Visitor = { name: "lit", visit(n: number): number { return n * 2; } };
console.log(run(lit));'''
S["instanceof"] = '''class A { } class B extends A { } class C extends A { }
const xs: A[] = [new A(), new B(), new C()];
let nb = 0, nc = 0; for (const x of xs) { if (x instanceof B) nb++; else if (x instanceof C) nc++; }
console.log(nb, nc, xs[1] instanceof A);'''
S["labels"] = '''let n = 0;
outer: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (j === 3) continue outer; if (i === 3) break outer; n++; } }
console.log(n);'''
S["bigint"] = '''const a = 2n ** 64n; console.log(a, a + 1n, BigInt(5) * 3n, Number(a));'''
S["regexp"] = '''const re = /(\\d+)-(\\w+)/; const m = re.exec("abc 12-xy"); console.log(m ? m[1] + m[2] : "none", /^a+$/.test("aaa"), "a1b22".replace(/\\d+/g, "#"));'''
S["generic_fn"] = '''function id<T>(x: T): T { return x; }
function first<T>(a: T[]): T { return a[0]; }
function mapArr<T, U>(a: T[], f: (x: T) => U): U[] { const r: U[] = []; for (const x of a) r.push(f(x)); return r; }
console.log(id(3), id("s"), first([4, 5]), mapArr([1, 2], (x) => x * 2));'''
S["generic_class"] = '''class Stack<T> { items: T[] = []; push(x: T): void { this.items.push(x); } pop(): T | undefined { return this.items.pop(); } get size(): number { return this.items.length; } }
const s = new Stack<number>(); s.push(1); s.push(2); const t = new Stack<string>(); t.push("a");
console.log(s.pop(), s.size, t.pop(), t.size);'''
S["generic_constraint"] = '''interface HasLen { length: number }
function len<T extends HasLen>(x: T): number { return x.length; }
console.log(len("abc"), len([1, 2]), len(new Uint8Array(4)));'''
S["generic_typedarray"] = '''function sumArr<T extends Uint8Array | Int32Array>(a: T): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
console.log(sumArr(new Uint8Array([1, 2, 3])), sumArr(new Int32Array([4, 5])));'''
S["generic_class_typedarray"] = '''class Vec<A extends Uint8Array | Int32Array> { constructor(public a: A) {} at(i: number): number { return this.a[i]; } }
console.log(new Vec(new Uint8Array([9, 8])).at(1), new Vec(new Int32Array([7, 6])).at(0));'''
S["union_prims"] = '''function f(x: number | string): string { if (typeof x === "number") return "n" + x; return "s" + x; }
console.log(f(1), f("a"));
let u: number | string = 5; console.log(u); u = "z"; console.log(u);'''
S["union_disc"] = '''type Sh = { kind: "c"; r: number } | { kind: "s"; w: number };
function area(s: Sh): number { switch (s.kind) { case "c": return 3 * s.r * s.r; case "s": return s.w * s.w; } }
console.log(area({ kind: "c", r: 2 }), area({ kind: "s", w: 3 }));'''
S["union_classes"] = '''class A { x = 1; } class B { y = 2; }
function f(v: A | B): number { return v instanceof A ? v.x : v.y; }
console.log(f(new A()), f(new B()));'''
S["union_null"] = '''class N { v = 1; next: N | null = null; }
const a = new N(); a.next = new N(); a.next.v = 5;
let p: N | null = a; let s = 0; while (p !== null) { s += p.v; p = p.next; } console.log(s);'''
S["tuples"] = '''const t: [number, string] = [1, "a"]; const [n, s] = t; console.log(n, s, t[0]);
function mm(): [number, number] { return [1, 2]; } const [p, q] = mm(); console.log(p + q);'''
S["static_private"] = '''class C { static count = 0; #secret = 5; private pv = 6; static inc(): number { return ++C.count; } getS(): number { return this.#secret + this.pv; } static { C.count = 10; } }
console.log(C.inc(), new C().getS());'''
S["param_props"] = '''class P { constructor(public a: number, private b: number, readonly c: number = 3) {} sum(): number { return this.a + this.b + this.c; } }
console.log(new P(1, 2).sum());'''
S["namespace"] = '''namespace NS { export const x = 5; export function f(): number { return x + 1; } }
console.log(NS.f());'''
S["switch_string"] = '''function f(s: string): number { switch (s) { case "a": return 1; case "bb": return 2; default: return 0; } }
console.log(f("a"), f("bb"), f("c"));'''
S["switch_fallthrough"] = '''function f(n: number): number { let r = 0; switch (n) { case 1: r += 1; case 2: r += 2; break; case 3: r = 9; break; default: r = -1; } return r; }
console.log(f(1), f(2), f(3), f(4));'''
S["for_in_of"] = '''const o = { a: 1, b: 2 }; let ks = ""; for (const k in o) ks += k; console.log(ks);
const m = new Map<string, number>([["x", 1], ["y", 2]]); let s = 0; for (const [k, v] of m) s += v; console.log(s);
let cs = 0; for (const ch of "abc") cs += ch.charCodeAt(0); console.log(cs);'''
S["generators"] = '''function* gen(n: number): Generator<number> { for (let i = 0; i < n; i++) yield i * 2; }
let s = 0; for (const v of gen(4)) s += v; console.log(s, [...gen(3)]);'''
S["async_await"] = '''async function f(x: number): Promise<number> { return x + 1; }
async function main(): Promise<void> { const v = await f(1); console.log(v); }
main();'''
S["closures_loop"] = '''const fs: (() => number)[] = []; for (let i = 0; i < 3; i++) fs.push(() => i); console.log(fs.map((f) => f()));'''
S["default_rest_params"] = '''function f(a: number, b = 2, ...c: number[]): number { return a + b + c.length; } console.log(f(1), f(1, 3), f(1, 3, 5, 6));'''
S["satisfies_as_const"] = '''const KW = { a: 1, b: 2 } as const; const t = { x: 1 } satisfies { x: number }; console.log(KW.a + KW.b, t.x);
const ARR = [1, 2, 3] as const; console.log(ARR.length, ARR[1]);'''
S["tagged_template"] = '''function tag(s: TemplateStringsArray, ...v: number[]): string { return s.join("|") + v.join(","); } console.log(tag`a${1}b${2}c`);'''
S["computed_keys_record"] = '''const r: Record<string, number> = {}; r["a"] = 1; r["b"] = 2; let s = 0; for (const k of Object.keys(r)) s += r[k]; console.log(s);
const key = "z"; const o = { [key]: 5 }; console.log(o["z"]);'''
S["index_signature"] = '''interface D { [k: string]: number } const d: D = { a: 1 }; d["b"] = 2; console.log(d["a"] + d["b"]);'''
S["object_entries"] = '''const o = { a: 1, b: 2 }; let s = 0; for (const [k, v] of Object.entries(o)) s += v; console.log(s, Object.values(o), Array.from({ length: 3 }, (_, i) => i));'''
S["inherit_super"] = '''class A { constructor(protected x: number) {} f(): number { return this.x; } } class B extends A { constructor(x: number) { super(x + 1); } f(): number { return super.f() * 2; } }
console.log(new B(1).f());'''
S["overloads"] = '''function f(x: number): number; function f(x: string): string; function f(x: number | string): number | string { return typeof x === "number" ? x + 1 : x + "!"; }
console.log(f(1), f("a"));'''
S["hoisting_mutual"] = '''function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1); } function isOdd(n: number): boolean { return n === 0 ? false : isEven(n - 1); } console.log(isEven(10), isOdd(7));'''
S["string_methods"] = '''const s = "  Hello, World  "; console.log(s.trim(), s.includes("World"), "ab".padStart(4, "-"), "x".repeat(3), "a,b,c".split(","), s.indexOf("o"), s.toUpperCase().trim(), "abc".slice(-2), "abc".substring(1), "abc".at(-1));'''
S["json"] = '''console.log(JSON.stringify({ a: 1, b: [1, 2], c: "x" })); const o = JSON.parse('{"a":1}') as { a: number }; console.log(o.a);'''
S["array_2d"] = '''const g: number[][] = []; for (let i = 0; i < 3; i++) { g.push(new Array(3).fill(0)); } g[1][1] = 5; console.log(g[1][1], g.length, g.flat().length);'''
S["typedarray_from"] = '''const a = Uint8Array.from([1, 2, 3]); const b = new Uint8Array([4, 5]); const c = new Uint8Array(5); c.set(a); c.set(b, 3); console.log(c, a.subarray(1).length, Array.from(c).join());'''
S["typeof_narrow"] = '''function f(x: unknown): string { if (typeof x === "string") return x; if (typeof x === "number") return "n" + x; return "other"; } console.log(f("a"), f(1), f(true));'''
S["nonnull_cast"] = '''const m = new Map<string, number>(); m.set("a", 1); const v = m.get("a")!; const w = m.get("b") as number | undefined; console.log(v, w);'''
S["object_freeze"] = '''const o = Object.freeze({ a: 1 }); console.log(o.a, Object.isFrozen(o));'''
S["process_api"] = '''console.log(process.argv.length >= 1, typeof process.exit); process.stdout.write("hi\\n");'''
S["import_meta"] = '''console.log(typeof import.meta.url);'''
S["toplevel_await"] = '''const v = await Promise.resolve(5); console.log(v);'''
S["custom_error"] = '''class PErr extends Error { constructor(public pos: number, msg: string) { super(msg); this.name = "PErr"; } }
try { throw new PErr(3, "bad"); } catch (e) { if (e instanceof PErr) console.log(e.pos, e.message, e.name); }'''
S["utility_types"] = '''interface Cfg { a: number; b?: string } const p: Partial<Cfg> = {}; const r: Readonly<Cfg> = { a: 1 }; const pk: Pick<Cfg, "a"> = { a: 2 }; console.log(p.a, r.a, pk.a);'''
S["nested_map"] = '''const m = new Map<string, number[]>(); m.set("a", [1]); m.get("a")!.push(2); console.log(m.get("a"), m.size);'''
S["optional_fields"] = '''interface O { a: number; b?: number } function f(o: O): number { return o.a + (o.b ?? 10); } console.log(f({ a: 1 }), f({ a: 1, b: 2 }));'''
S["string_index"] = '''const s = "abc"; console.log(s[1], s.charAt(2), s.length);'''
S["error_catch_unknown"] = '''try { null!.x; } catch (e) { console.log(e instanceof TypeError); }
try { JSON.parse("{"); } catch (e) { console.log((e as Error).name); }'''
S["arguments_obj"] = '''function f() { return arguments.length; } console.log(f());'''
S["function_props"] = '''function f(): number { return 1; } (f as any).x = 5; console.log(f());'''
S["with_eval"] = '''console.log(eval("1+1"));'''
S["any_type"] = '''let a: any = 5; a = "s"; console.log(a);'''
S["array_methods"] = '''const a = [3, 1, 2]; a.sort((x, y) => x - y); console.log(a, a.map((x) => x * 2).filter((x) => x > 2), a.reduce((p, c) => p + c, 0), a.indexOf(2), a.includes(5), a.slice(1), a.concat([9]), a.reverse(), a.join("-"), a.some((x) => x > 2), a.find((x) => x > 1));'''
S["array_splice_shift"] = '''const a = [1, 2, 3, 4]; a.splice(1, 2); a.unshift(0); const s = a.shift(); console.log(a, s);'''
S["math_funcs"] = '''console.log(Math.floor(2.5), Math.ceil(2.1), Math.min(1, 2), Math.abs(-3), Math.imul(3, 4), Math.clz32(1), Math.trunc(-2.7), Math.sign(-3), Math.hypot(3, 4), Math.round(2.5), 7 % 3, -7 % 3, 2 ** 10);'''
S["number_ops"] = '''console.log(0.1 + 0.2, (255).toString(16), parseInt("ff", 16), parseFloat("1.5"), Number("12"), (1234.5678).toFixed(2), 1 / 0, Number.isInteger(5), 5 >>> 1, -1 >>> 0, 1 << 31, ~5);'''
S["date_now"] = '''console.log(typeof Date.now(), typeof performance.now());'''
S["symbol_iter"] = '''class R { *[Symbol.iterator](): Iterator<number> { yield 1; yield 2; } } let s = 0; for (const v of new R()) s += v; console.log(s);'''
S["set_ops"] = '''const s = new Set<number>([1, 2, 2, 3]); s.add(4); s.delete(1); console.log(s.size, s.has(2), [...s]);'''
S["weakmap"] = '''const w = new WeakMap<object, number>(); const k = {}; w.set(k, 1); console.log(w.get(k));'''
S["class_expr_static_inherit"] = '''class A { static make(): A { return new this(); } name(): string { return "A"; } } class B extends A { name(): string { return "B"; } } console.log(B.make().name());'''
S["mixin_like"] = '''type Ctor<T> = new (...a: any[]) => T; function Mix<TB extends Ctor<{}>>(Base: TB) { return class extends Base { m = 1; }; } class X {} const Y = Mix(X); console.log(new Y().m);'''
S["decorators_absent"] = '''const o = { toString() { return "O"; } }; console.log(`${o}`);'''
S["proxy"] = '''const p = new Proxy({}, { get: () => 5 }); console.log((p as any).x);'''
S["this_binding_method_ref"] = '''class C { v = 3; get(): number { return this.v; } } const c = new C(); const f = c.get; const g = c.get.bind(c); console.log(g());'''
S["arrow_this"] = '''class C { v = 3; run(): number { const f = () => this.v; return f(); } } console.log(new C().run());'''
S["const_assert_obj_lookup"] = '''const TABLE: Record<number, string> = { 1: "a", 2: "b" }; console.log(TABLE[2]);'''
S["string_enum_union"] = '''type K = "a" | "b"; function f(k: K): number { return k === "a" ? 1 : 2; } console.log(f("b"));'''
S["number_literal_union_switch"] = '''type Tk = 0 | 1 | 2; function f(t: Tk): string { switch (t) { case 0: return "z"; case 1: return "o"; case 2: return "t"; } } console.log(f(1));'''
S["bit_flags_enum"] = '''enum F { None = 0, A = 1 << 0, B = 1 << 1, C = 1 << 2 } let f: number = F.A | F.C; console.log((f & F.B) !== 0, (f & F.C) !== 0, f);'''
S["void_undefined"] = '''function f(): void { return; } console.log(f() === undefined, void 0);'''
S["comma_ternary_chain"] = '''const x = 5; const y = x > 3 ? (x > 4 ? "a" : "b") : "c"; console.log(y);'''
S["do_while_break"] = '''let i = 0; do { i++; if (i > 5) break; } while (true); console.log(i);'''
S["getter_in_interface"] = '''interface I { readonly v: number } class C implements I { get v(): number { return 4; } } const i: I = new C(); console.log(i.v);'''
S["static_method_generic"] = '''class U { static pick<T>(a: T, b: T, first: boolean): T { return first ? a : b; } } console.log(U.pick(1, 2, false), U.pick("a", "b", true));'''
S["unicode_string"] = '''const s = "héllo wörld ✓"; console.log(s.length, s.charCodeAt(1), s.codePointAt(12), [...s].length, s.toUpperCase());'''
S["textencoder"] = '''const e = new TextEncoder().encode("hé"); console.log(e.length, new TextDecoder().decode(e));'''
S["buffer_api"] = '''const b = Buffer.from("abc"); console.log(b.length, b[1], b.toString("hex"), b.subarray(1).toString());'''
S["recursion_deep"] = '''function d(n: number): number { return n === 0 ? 0 : 1 + d(n - 1); } console.log(d(10000));'''
S["stack_overflow_catch"] = '''function d(n: number): number { return 1 + d(n + 1); } try { d(0); } catch (e) { console.log(e instanceof RangeError); }'''
S["cyclic_class_refs"] = '''class A { b: B | null = null; } class B { a: A | null = null; } const a = new A(); const b = new B(); a.b = b; b.a = a; console.log(a.b.a === a);'''
S["exports_mix"] = '''export const X = 1; export function f(): number { return X + 1; } export default class Q { v = 2; } console.log(f());'''
for name, src in S.items():
    open(name + ".ts", "w").write(src + "\n")
print(len(S))
