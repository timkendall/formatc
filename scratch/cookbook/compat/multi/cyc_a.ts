import { fB } from "./cyc_b.ts";
export function fA(n: number): number { return n <= 0 ? 0 : 1 + fB(n - 1); }
console.log(fA(5));
