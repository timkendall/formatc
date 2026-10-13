class R { *[Symbol.iterator](): Iterator<number> { yield 1; yield 2; } } let s = 0; for (const v of new R()) s += v; console.log(s);
