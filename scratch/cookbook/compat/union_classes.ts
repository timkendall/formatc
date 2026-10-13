class A { x = 1; } class B { y = 2; }
function f(v: A | B): number { return v instanceof A ? v.x : v.y; }
console.log(f(new A()), f(new B()));
