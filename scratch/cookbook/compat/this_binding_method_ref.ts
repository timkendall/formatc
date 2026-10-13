class C { v = 3; get(): number { return this.v; } } const c = new C(); const f = c.get; const g = c.get.bind(c); console.log(g());
