function f(n: number): number { let r = 0; switch (n) { case 1: r += 1; case 2: r += 2; break; case 3: r = 9; break; default: r = -1; } return r; }
console.log(f(1), f(2), f(3), f(4));
