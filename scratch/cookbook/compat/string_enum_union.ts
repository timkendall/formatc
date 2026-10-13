type K = "a" | "b"; function f(k: K): number { return k === "a" ? 1 : 2; } console.log(f("b"));
