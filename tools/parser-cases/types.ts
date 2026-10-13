// Every type syntax.
type A1 = string | number | boolean | bigint | symbol | object | undefined | null | void | never | unknown | any;
type A2 = "str" | 'single' | `tpl` | 1 | -1 | 1n | -1n | true | false | 0x10 | 1e3;
type A3 = `a${string}b${number}c` | `${A1}` | `${"x" | "y"}-${A2}` | ``;
type A4 = string[] | Array<number> | readonly string[] | ReadonlyArray<number> | string[][] | (string | number)[];
type A5 = [] | [a: string] | [a?: string] | [...rest: number[]] | [string, ...number[], boolean] | [x: string, y?: number, ...z: boolean[]] | readonly [number, string?];
type A6 = typeof x | typeof x.y.z | typeof import("m") | typeof x<string>;
type A7 = keyof T | keyof typeof x | unique symbol | readonly string[];
type A8 = T[K] | T["a"]["b"] | T[number] | T[keyof T] | (typeof arr)[number];
type A9 = T extends U ? X : Y;
type A10 = T extends (infer U)[] ? U : never;
type A11 = T extends [infer H, ...infer R] ? H : never;
type A12 = T extends infer U extends string ? U : never;
type A13 = T extends U ? (V extends W ? 1 : 2) : 3;
type A14 = { a: string; b?: number; readonly c: boolean; [k: string]: any; [k: number]: string; (x: number): string; new (x: number): A; m(): void; m2?<T>(x: T): T; get g(): number; set s(v: number); readonly [i: number]: string };
type A15 = { [K in keyof T]: T[K] } | { readonly [K in keyof T]?: T[K] } | { -readonly [K in keyof T]-?: T[K] } | { +readonly [K in keyof T]+?: T[K] } | { [K in keyof T as `get${Capitalize<K & string>}`]: () => T[K] };
type A16 = (x: number) => string;
type A17 = new (x: number) => Foo;
type A18 = abstract new () => Foo;
type A19 = <T>(x: T) => T;
type A20 = (this: Window, ...args: any[]) => void;
type A21 = (x: number, y?: string, ...z: boolean[]) => asserts x is number;
type A22 = (x: unknown) => x is string;
type A23 = (x: unknown) => asserts x;
type A24 = (this: Foo) => this is Bar;
type A25 = import("./a").B | import("./a").B.C<string> | import("./a", { with: { "resolution-mode": "import" } }).D;
type A26 = A.B.C<D.E> | A<B<C<D>>>;
type A27 = | A | B;
type A28 = & A & B;
type A29 = (A | B) & (C | D);
type A30 = ((x: number) => void) | (() => void);
type A31 = { a: 1 } & { b: 2 };
type A32 = this;
type A33 = Array<typeof x>;
type A34 = intrinsic;
type A35<T extends string = "a", const U = 1, in out V = 2> = T;
type A36 = Foo<string, number>[];
type A37 = [first: string, second?: number];
type A38 = (new () => X)[];
type A39 = typeof this.x;
type A40 = Record<string, (typeof arr)[number]>;
type A41 = { a: 1; b: 2, c: 3 };
type A42 = { f(): void, g(): void };
type A43 = (() => void)[];
type A44 = ((a: string) => void) extends (b: infer P) => void ? P : never;
type A45 = T extends (...args: infer A) => infer R ? [A, R] : never;
type A46 = asserts;
type A47 = { asserts: 1; is: 2; infer: 3; keyof: 4; readonly: 5; unique: 6; type: 7; declare: 8; abstract: 9; };
type A48 = typeof import("x", { with: { type: "json" } });
type A49 = { new <T>(x: T): T; <T>(x: T): T; readonly a?: number };
type A50<T> = T extends string ? "s" : T extends number ? "n" : T extends boolean ? "b" : never;
declare function f1(x: number): void;
declare function f1(x: string): void;
declare const c1: unique symbol;
declare let l1: { a: number };
declare var v1: string, v2: number;
declare class C1<T> extends B<T> implements I1, I2 { private x; protected y?: number; public static readonly z: string; abstract m(): void; constructor(a: string); get a(): number; set a(v: number); [k: string]: any; static [k: number]: string; }
declare enum E1 { A, B }
declare const enum E2 { A = 1 }
declare namespace N1 { const x: number; function f(): void; namespace Inner { type T = 1 } }
declare module "m" { export default function f(): void; export = x; }
declare module "m2";
declare global { interface Window { x: number } }
declare module Foo.Bar { }
interface I3<T = any> extends I1, I2<T> { a: number; b(): void; }
interface I4 { <T>(x: T): T; new <T>(x: T): I4; readonly [k: string]: any; method?(): void; }
interface I5 extends Array<number>, Foo.Bar<string> {}
abstract class AC1 { abstract x: number; abstract m(): void; abstract get g(): number; protected abstract readonly y: string; }
function overloaded(x: number): number;
function overloaded(x: string): string;
function overloaded(x: any): any { return x; }
class Overloads { m(x: number): void; m(x: string): void; m(x: any): void {} constructor(); constructor(x?: number) {} }
let fnType: (a: number, b: string) => void = (a, b) => {};
let obj: { a: number; b: string } = { a: 1, b: "" };
let tup: [number, string] = [1, ""];
let un: string | undefined;
let nn = a!.b!.c!;
let as1 = x as unknown as string;
let as2 = <any>x;
let sat = x satisfies Foo;
let ac = x as const;
function gen<T extends { a: number }, U = T>(x: T, y: U): asserts x is T & U {}
function assertsThis(this: Foo): asserts this is Bar {}
function isStr(x: unknown): x is string { return typeof x === "string"; }
class Cls<in T, out U> { x!: number; y?: string; declare z: number; static #p = 1; accessor a = 1; override m() {} readonly r = 1; }
export type { A1 };
export type { A2 } from "./a";
import type { A3 } from "./a";
import type B3 from "./b";
import type * as NS from "./c";
export * as ns from "./d";
export type * from "./e";
export type * as ns2 from "./f";
