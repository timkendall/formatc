import { fA } from "./cyc_a.ts";
export function fB(n: number): number { return n <= 0 ? 0 : 1 + fA(n - 1); }
