const ops: ((a: number, b: number) => number)[] = [(a, b) => a + b, (a, b) => a * b]; console.log(ops[0](2, 3), ops[1](2, 3));
