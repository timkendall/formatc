interface H { handle(n: number): number }
class A implements H { handle(n: number): number { return n + 1; } }
class B implements H { handle(n: number): number { return n * 2; } }
const hs: H[] = [new A(), new B()];
let s = 0;
for (let i = 0; i < hs.length; i++) s += hs[i].handle(5);
console.log(s);
