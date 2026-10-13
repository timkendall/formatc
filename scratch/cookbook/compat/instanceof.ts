class A { } class B extends A { } class C extends A { }
const xs: A[] = [new A(), new B(), new C()];
let nb = 0, nc = 0; for (const x of xs) { if (x instanceof B) nb++; else if (x instanceof C) nc++; }
console.log(nb, nc, xs[1] instanceof A);
