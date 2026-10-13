class C { constructor(private _x: number) {} get x(): number { return this._x; } set x(v: number) { this._x = v; } } const c = new C(1); c.x = c.x + 5; console.log(c.x);
