const REPS = 5;
const K = 20_000_000;
// 1. abstract readonly kind (declared in base abstract, defined in subclasses)
abstract class A1 { abstract readonly kind: number; }
class A1a extends A1 { readonly kind = 0; v = 1; }
class A1b extends A1 { readonly kind = 1; w = 2; }
// 2. base field assigned by subclass constructors
class A2 { kind: number; constructor(k: number) { this.kind = k; } }
class A2a extends A2 { v = 1; constructor() { super(0); } }
class A2b extends A2 { w = 2; constructor() { super(1); } }
// 3. abstract getter
abstract class A3 { abstract get kind(): number; }
class A3a extends A3 { get kind(): number { return 0; } }
class A3b extends A3 { get kind(): number { return 1; } }
// 4. interface-typed
interface I4 { kind: number }
class A4a implements I4 { kind = 0; }
class A4b implements I4 { kind = 1; }
// 5. base declares field with initializer; subclasses redeclare with `override`
class A5 { kind: number = -1; }
class A5a extends A5 { override kind = 0; }
class A5b extends A5 { override kind = 1; }
// 6. union of unrelated classes sharing literal kind
class U6a { readonly kind = 0; v = 1; }
class U6b { readonly kind = 1; w = 2; }
// 7. abstract method kind()
abstract class A7 { abstract kind(): number; }
class A7a extends A7 { kind(): number { return 0; } }
class A7b extends A7 { kind(): number { return 1; } }
// 8. record / object literal type
interface R8 { kind: number; v: number }
function f1(xs: A1[]): number { let s = 0; for (let i = 0; i < K; i++) s += xs[i & 1].kind; return s; }
function f2(xs: A2[]): number { let s = 0; for (let i = 0; i < K; i++) s += xs[i & 1].kind; return s; }
function f3(xs: A3[]): number { let s = 0; for (let i = 0; i < K; i++) s += xs[i & 1].kind; return s; }
function f4(xs: I4[]): number { let s = 0; for (let i = 0; i < K; i++) s += xs[i & 1].kind; return s; }
function f5(xs: A5[]): number { let s = 0; for (let i = 0; i < K; i++) s += xs[i & 1].kind; return s; }
function f6(xs: (U6a | U6b)[]): number { let s = 0; for (let i = 0; i < K; i++) s += xs[i & 1].kind; return s; }
function f7(xs: A7[]): number { let s = 0; for (let i = 0; i < K; i++) s += xs[i & 1].kind(); return s; }
function f8(xs: R8[]): number { let s = 0; for (let i = 0; i < K; i++) s += xs[i & 1].kind; return s; }
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(46), (best * 1e6 / K).toFixed(2).padStart(8), "ns/op  r=", r);
}
bench("1 abstract readonly kind (subclass fields)", () => f1([new A1a(), new A1b()]));
bench("2 base field set via super(k)", () => f2([new A2a(), new A2b()]));
bench("3 abstract getter", () => f3([new A3a(), new A3b()]));
bench("4 interface-typed field", () => f4([new A4a(), new A4b()]));
bench("5 base field + override in subclasses", () => f5([new A5a(), new A5b()]));
bench("6 union of unrelated classes w/ literal kind", () => f6([new U6a(), new U6b()]));
bench("7 abstract method kind()", () => f7([new A7a(), new A7b()]));
bench("8 interface-typed object literals", () => f8([{ kind: 0, v: 1 }, { kind: 1, v: 2 }]));
