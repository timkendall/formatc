class Vec<A extends Uint8Array | Int32Array> { constructor(public a: A) {} at(i: number): number { return this.a[i]; } }
console.log(new Vec(new Uint8Array([9, 8])).at(1), new Vec(new Int32Array([7, 6])).at(0));
