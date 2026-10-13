S = {}
S["b_array_new_fill"] = '''const a = new Array<number>(3).fill(0); a[1] = 4; const g: number[][] = []; for (let i = 0; i < 2; i++) g.push(new Array<number>(2).fill(i)); console.log(a, g, g[1][1]);'''
S["b_ast_hierarchy"] = '''const enum K { Num, Bin, Id }
abstract class Node { abstract readonly kind: K; start = 0; end = 0; }
class Num extends Node { readonly kind = K.Num; constructor(public v: number) { super(); } }
class Id extends Node { readonly kind = K.Id; constructor(public name: string) { super(); } }
class Bin extends Node { readonly kind = K.Bin; constructor(public op: number, public l: Node, public r: Node) { super(); } }
function ev(n: Node): number { switch (n.kind) { case K.Num: return (n as Num).v; case K.Bin: { const b = n as Bin; const l = ev(b.l), r = ev(b.r); return b.op === 0 ? l + r : l * r; } default: return 0; } }
console.log(ev(new Bin(0, new Num(2), new Bin(1, new Num(3), new Num(4)))));'''
S["b_ast_union_kind"] = '''type Expr = Num | Add;
class Num { readonly kind = "num"; constructor(public v: number) {} }
class Add { readonly kind = "add"; constructor(public l: Expr, public r: Expr) {} }
function ev(e: Expr): number { if (e.kind === "num") return e.v; return ev(e.l) + ev(e.r); }
console.log(ev(new Add(new Num(1), new Add(new Num(2), new Num(3)))));'''
S["b_func_table"] = '''const ops: ((a: number, b: number) => number)[] = [(a, b) => a + b, (a, b) => a * b]; console.log(ops[0](2, 3), ops[1](2, 3));'''
S["b_method_table_iface"] = '''interface H { handle(n: number): number } class A implements H { handle(n: number): number { return n + 1; } } class B implements H { handle(n: number): number { return n * 2; } }
const hs: H[] = [new A(), new B()]; let s = 0; for (const h of hs) s += h.handle(5); console.log(s);'''
S["b_optional_method_call"] = '''class A { f(): number { return 1; } } const a: A | null = new A(); console.log(a?.f(), (null as A | null)?.f());'''
S["b_static_readonly"] = '''class C { static readonly MAX = 5; static readonly NAMES = ["a", "b"]; } console.log(C.MAX, C.NAMES[1]);'''
S["b_field_init_order"] = '''class C { a = 1; b = this.a + 1; c: number; constructor() { this.c = this.b + 1; } } console.log(new C().c);'''
S["b_try_finally_return"] = '''function f(): number { try { return 1; } finally { console.log("fin"); } } console.log(f());'''
S["b_delete_prop"] = '''const o: { a?: number; b: number } = { a: 1, b: 2 }; delete o.a; console.log(o.a, o.b);'''
S["b_for_of_entries"] = '''const o = { a: 1, b: 2 }; for (const [k, v] of Object.entries(o)) console.log(k, v);'''
S["b_array_grow_write"] = '''const a: number[] = []; a[a.length] = 1; a[a.length] = 2; a.length = 5; console.log(a, a.length);'''
S["b_fromcharcode_spread"] = '''const codes = [104, 105]; console.log(String.fromCharCode(...codes), String.fromCharCode(65, 66));'''
S["b_unknown_cast"] = '''const x: unknown = 5; const n = x as number; const y = (3 as unknown) as string; console.log(n);'''
S["b_for_comma"] = '''let s = 0; for (let i = 0, n = 5; i < n; i++, s++) {} console.log(s);'''
S["b_getset_interface_class"] = '''class C { constructor(private _x: number) {} get x(): number { return this._x; } set x(v: number) { this._x = v; } } const c = new C(1); c.x = c.x + 5; console.log(c.x);'''
S["b_nested_class_generic_map"] = '''class Reg<V> { m = new Map<string, V>(); put(k: string, v: V): void { this.m.set(k, v); } get(k: string): V | undefined { return this.m.get(k); } }
const r = new Reg<number[]>(); r.put("a", [1]); console.log(r.get("a"), r.get("b"));'''
S["b_const_obj_flags"] = '''const FLAGS = { A: 1, B: 2, C: 4 } as const; let f = 0; f |= FLAGS.A; f |= FLAGS.C; console.log(f, (f & FLAGS.B) === 0);'''
S["b_class_static_instances"] = '''class Tok { static readonly EOF = new Tok(0); static readonly ID = new Tok(1); private constructor(public readonly id: number) {} } console.log(Tok.EOF.id, Tok.ID.id);'''
S["b_string_builder_join"] = '''const parts: string[] = []; for (let i = 0; i < 3; i++) parts.push("x" + i); console.log(parts.join(","));'''
S["b_string_compare"] = '''console.log("a" < "b", "abc" === "ab" + "c", "b".localeCompare("a"), ["b", "a", "c"].sort());'''
S["b_number_to_string_pad"] = '''console.log((5).toString().padStart(3, "0"), String(12), `${1 + 1}`, (0.5).toString(), (1e21).toString());'''
S["b_interface_generic"] = '''interface Box<T> { v: T } function unbox<T>(b: Box<T>): T { return b.v; } console.log(unbox({ v: 5 }), unbox({ v: "s" }));'''
S["b_readonly_array_param"] = '''function s(a: readonly number[]): number { let t = 0; for (const x of a) t += x; return t; } console.log(s([1, 2, 3]));'''
S["b_enum_in_record"] = '''enum E { A, B } const names: Record<number, string> = { [E.A]: "a", [E.B]: "b" }; console.log(names[E.B]);'''
S["b_typed_array_in_class_generic_free"] = '''class Bits { constructor(public d: Uint8Array) {} get(i: number): boolean { return (this.d[i >> 3] & (1 << (i & 7))) !== 0; } } const b = new Bits(new Uint8Array([5])); console.log(b.get(0), b.get(1), b.get(2));'''
S["b_uint32_ops"] = '''const x = 0xdeadbeef; console.log(x >>> 0, x | 0, (x >>> 16) & 0xff, Math.imul(x, 31) >>> 0, x ^ 0xff);'''
S["b_labeled_block"] = '''blk: { if (1 > 0) break blk; console.log("no"); } console.log("yes");'''
S["b_switch_large_range"] = '''function f(c: number): number { switch (c) { case 0x20: case 0x09: case 0x0a: return 1; case 0x2b: return 2; case 0x7b: case 0x7d: return 3; default: return 0; } } console.log(f(32), f(43), f(125), f(1));'''
S["b_conditional_types_absent"] = '''type A<T> = T extends string ? number : boolean; const x: A<string> = 5; console.log(x);'''
S["b_class_generic_default_static"] = '''class Q<T> { static of<U>(v: U): Q<U> { return new Q<U>(v); } constructor(public v: T) {} } console.log(Q.of(3).v);'''
S["b_set_of_strings_for"] = '''const s = new Set<string>(["a", "b"]); let n = 0; for (const x of s) n += x.length; console.log(n);'''
S["b_array_destructure_swap_in_fn"] = '''function sw(a: number[], i: number, j: number): void { [a[i], a[j]] = [a[j], a[i]]; } const a = [1, 2, 3]; sw(a, 0, 2); console.log(a);'''
S["b_exceptions_rethrow"] = '''function f(): void { try { throw new Error("a"); } catch (e) { throw new Error("b: " + (e as Error).message); } } try { f(); } catch (e) { console.log((e as Error).message); }'''
S["b_object_literal_method_this"] = '''const o = { n: 2, f() { return this.n * 2; } }; console.log(o.f());'''
S["b_class_in_array_find"] = '''class P { constructor(public id: number) {} } const ps = [new P(1), new P(2)]; console.log(ps.find((p) => p.id === 2)?.id, ps.findIndex((p) => p.id === 5));'''
S["b_char_class_regex_unicode"] = '''console.log(/\\p{L}+/u.test("é"), "aXb".split(/x/i));'''
S["b_string_raw_template"] = '''console.log(String.raw`a\\nb`, `l1
l2`.length);'''
S["b_iife"] = '''const v = (() => { const t = 5; return t * 2; })(); console.log(v);'''
S["b_closure_counter"] = '''function mk(): () => number { let c = 0; return () => ++c; } const f = mk(); f(); console.log(f());'''
S["b_number_isnan_inf"] = '''console.log(Number.isNaN(NaN), isFinite(1 / 0), Number.MAX_SAFE_INTEGER, Number.EPSILON > 0, -0 === 0, Object.is(-0, 0));'''
for name, src in S.items():
    open(name + ".ts", "w").write(src + "\n")
print(len(S))
