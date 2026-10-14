function hot(n: number): number { return (n * 2) | 0; }
export function cold(xs: number[]): number { let s = 0; for (let i = 0; i < xs.length; i++) s = (s + hot(xs[i] as number)) | 0; return s; }
export function main(): number { let t = 0; for (let i = 0; i < 1000; i++) t = (t + hot(i)) | 0; return t; }
console.log(cold([1, 2, 3]) + main());
