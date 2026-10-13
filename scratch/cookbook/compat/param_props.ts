class P { constructor(public a: number, private b: number, readonly c: number = 3) {} sum(): number { return this.a + this.b + this.c; } }
console.log(new P(1, 2).sum());
