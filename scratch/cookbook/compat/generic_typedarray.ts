function sumArr<T extends Uint8Array | Int32Array>(a: T): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
console.log(sumArr(new Uint8Array([1, 2, 3])), sumArr(new Int32Array([4, 5])));
