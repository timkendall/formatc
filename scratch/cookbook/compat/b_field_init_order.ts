class C { a = 1; b = this.a + 1; c: number; constructor() { this.c = this.b + 1; } } console.log(new C().c);
