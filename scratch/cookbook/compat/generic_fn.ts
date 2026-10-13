function id<T>(x: T): T { return x; }
function first<T>(a: T[]): T { return a[0]; }
function mapArr<T, U>(a: T[], f: (x: T) => U): U[] { const r: U[] = []; for (const x of a) r.push(f(x)); return r; }
console.log(id(3), id("s"), first([4, 5]), mapArr([1, 2], (x) => x * 2));
