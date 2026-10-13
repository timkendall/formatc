const [a, b, ...rest] = [1, 2, 3, 4, 5];
const { x, y = 9 } = { x: 1 } as { x: number; y?: number };
function f({ p, q }: { p: number; q: number }): number { return p + q; }
function g([m, n]: [number, number]): number { return m * n; }
console.log(a, b, rest, x, y, f({ p: 1, q: 2 }), g([3, 4]));
let s = 1, t = 2; [s, t] = [t, s]; console.log(s, t);
