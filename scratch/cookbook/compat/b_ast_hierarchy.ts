const enum K { Num, Bin, Id }
abstract class Node { abstract readonly kind: K; start = 0; end = 0; }
class Num extends Node { readonly kind = K.Num; constructor(public v: number) { super(); } }
class Id extends Node { readonly kind = K.Id; constructor(public name: string) { super(); } }
class Bin extends Node { readonly kind = K.Bin; constructor(public op: number, public l: Node, public r: Node) { super(); } }
function ev(n: Node): number { switch (n.kind) { case K.Num: return (n as Num).v; case K.Bin: { const b = n as Bin; const l = ev(b.l), r = ev(b.r); return b.op === 0 ? l + r : l * r; } default: return 0; } }
console.log(ev(new Bin(0, new Num(2), new Bin(1, new Num(3), new Num(4)))));
