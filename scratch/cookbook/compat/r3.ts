class A { f(): number { return 1; } }
console.log((null as A | null)?.f());
