function f(x: number): number; function f(x: string): string; function f(x: number | string): number | string { return typeof x === "number" ? x + 1 : x + "!"; }
console.log(f(1), f("a"));
