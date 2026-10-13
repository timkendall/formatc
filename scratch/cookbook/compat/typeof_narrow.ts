function f(x: unknown): string { if (typeof x === "string") return x; if (typeof x === "number") return "n" + x; return "other"; } console.log(f("a"), f(1), f(true));
