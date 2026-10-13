class A { f(): number { return 1; } } const a: A | null = new A(); console.log(a?.f(), (null as A | null)?.f());
