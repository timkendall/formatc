class A { constructor(protected x: number) {} f(): number { return this.x; } } class B extends A { constructor(x: number) { super(x + 1); } f(): number { return super.f() * 2; } }
console.log(new B(1).f());
