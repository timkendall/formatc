interface H { handle(n: number): number }
class A implements H { handle(n: number): number { return n + 1; } }
class B implements H { handle(n: number): number { return n * 2; } }
const hs: H[] = [new A(), new B()];
let s = 0;
for (const h of hs) { s = s + h.handle(5); }
console.log(s);
