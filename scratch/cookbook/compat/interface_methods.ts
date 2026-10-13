interface Visitor { visit(n: number): number; name: string; }
class V implements Visitor { name = "v"; visit(n: number): number { return n + 1; } }
function run(v: Visitor): number { return v.visit(1); }
console.log(run(new V()), new V().name);
const lit: Visitor = { name: "lit", visit(n: number): number { return n * 2; } };
console.log(run(lit));
