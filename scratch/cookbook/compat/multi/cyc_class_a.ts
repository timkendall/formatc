import { B } from "./cyc_class_b.ts";
export class A { b: B | null = null; v = 1; }
const a = new A(); a.b = new B(a); console.log(a.b.owner.v);
