enum Kind { A, B, C = 10, D }
const k: Kind = Kind.C;
console.log(Kind.A, Kind.D, k, Kind[10]);
function f(x: Kind): number { switch (x) { case Kind.A: return 1; case Kind.C: return 3; default: return 0; } }
console.log(f(Kind.A), f(Kind.C), f(Kind.D));
