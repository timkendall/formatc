interface HasLen { length: number }
function len<T extends HasLen>(x: T): number { return x.length; }
console.log(len("abc"), len([1, 2]), len(new Uint8Array(4)));
