class A { f(): number { return 1; } }
function g(a: A | null): number | undefined { return a?.f(); }
console.log(g(new A()), g(null));
