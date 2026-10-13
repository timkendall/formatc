class C { private _v = 1; get v(): number { return this._v; } set v(n: number) { this._v = n * 2; } static get K(): number { return 7; } }
const c = new C(); c.v = 5; console.log(c.v, C.K);
