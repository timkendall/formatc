type Expr = Num | Add;
class Num { readonly kind = "num"; constructor(public v: number) {} }
class Add { readonly kind = "add"; constructor(public l: Expr, public r: Expr) {} }
function ev(e: Expr): number { if (e.kind === "num") return e.v; return ev(e.l) + ev(e.r); }
console.log(ev(new Add(new Num(1), new Add(new Num(2), new Num(3)))));
