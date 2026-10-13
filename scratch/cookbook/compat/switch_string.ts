function f(s: string): number { switch (s) { case "a": return 1; case "bb": return 2; default: return 0; } }
console.log(f("a"), f("bb"), f("c"));
