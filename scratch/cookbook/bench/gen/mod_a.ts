import type { NoThrow } from "@scriptc/types";
export function crossFn(c: number): number { return ((c | 0) * 7 + 3) & 255; }
export function crossFnNT(c: number): NoThrow<number> { return ((c | 0) * 7 + 3) & 255; }
