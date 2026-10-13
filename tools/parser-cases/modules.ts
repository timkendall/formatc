// Imports and exports.
import "side-effect";
import def from "m1";
import * as ns from "m2";
import { a, b as c, default as d, "str" as e } from "m3";
import def2, { f } from "m4";
import def3, * as ns2 from "m5";
import {} from "m6";
import { g, } from "m7";
import type T1 from "m8";
import type { T2, T3 } from "m9";
import { type T4, type T5 as T6, type, type as as2, type type, type as as as3, type as } from "m10";
import type, { x } from "m11";
import type from "m12";
import type * as ns3 from "m13";
import json from "./a.json" with { type: "json" };
import json2 from "./a.json" assert { type: "json" };
import { v } from "./b" with { "resolution-mode": "require" };
import eq = require("m14");
import eq2 = ns.sub.deep;
export import eq3 = ns.sub;
import type eq4 = require("m15");
import type eq5 = ns.x;
import defer from "m16";
import source from "m17";
export { a1 };
export { a2 as b2, c2 as default, d2 as "string name" };
export { e2, f2 } from "m18";
export { default } from "m19";
export { default as x2 } from "m20";
export * from "m21";
export * as ns4 from "m22";
export * as default from "m23";
export type { T7 } from "m24";
export type { T8 as T9 };
export { type T10, type T11 as T12 };
export default function () {}
export default function named() {}
export default class {}
export default class Named {}
export default async function () {}
export default abstract class AC {}
export default interface DI {}
export default 1 + 2;
export default (a, b) => a + b;
export default { a: 1 };
export const x1 = 1, y1 = 2;
export let z1;
export var w1;
export function f1() {}
export async function f2() {}
export function* f3() {}
export class C1 {}
export abstract class C2 {}
export interface I1 {}
export type T13 = string;
export enum E1 {}
export const enum E2 {}
export declare const d3: number;
export declare function f4(): void;
export namespace N1 {}
export module M1 {}
export = foo;
export as namespace UMD;
export { };
export { a as b } from "m25" with { type: "json" };
export * from "m26" with { type: "json" };
import {a as default_} from "m27";
