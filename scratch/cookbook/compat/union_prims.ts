function f(x: number | string): string { if (typeof x === "number") return "n" + x; return "s" + x; }
console.log(f(1), f("a"));
let u: number | string = 5; console.log(u); u = "z"; console.log(u);
