function* gen(n: number): Generator<number> { for (let i = 0; i < n; i++) yield i * 2; }
let s = 0; for (const v of gen(4)) s += v; console.log(s, [...gen(3)]);
