const a = [1, 2]; const b = [...a, 3, ...a];
function sum(...xs: number[]): number { let s = 0; for (const x of xs) s += x; return s; }
console.log(b, sum(...b), Math.max(...b));
const o1 = { p: 1, q: 2 }; const o2 = { ...o1, q: 3 }; console.log(o2.p, o2.q);
