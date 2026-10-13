function f(a: number, b = 2, ...c: number[]): number { return a + b + c.length; } console.log(f(1), f(1, 3), f(1, 3, 5, 6));
