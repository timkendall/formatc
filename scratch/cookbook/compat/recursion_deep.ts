function d(n: number): number { return n === 0 ? 0 : 1 + d(n - 1); } console.log(d(10000));
