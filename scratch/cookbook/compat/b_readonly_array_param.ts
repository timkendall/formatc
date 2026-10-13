function s(a: readonly number[]): number { let t = 0; for (const x of a) t += x; return t; } console.log(s([1, 2, 3]));
