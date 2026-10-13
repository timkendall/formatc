interface I { readonly v: number } class C implements I { get v(): number { return 4; } } const i: I = new C(); console.log(i.v);
