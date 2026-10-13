function sw(a: number[], i: number, j: number): void { [a[i], a[j]] = [a[j], a[i]]; } const a = [1, 2, 3]; sw(a, 0, 2); console.log(a);
