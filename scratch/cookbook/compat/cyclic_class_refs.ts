class A { b: B | null = null; } class B { a: A | null = null; } const a = new A(); const b = new B(); a.b = b; b.a = a; console.log(a.b.a === a);
