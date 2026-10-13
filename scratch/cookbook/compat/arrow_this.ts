class C { v = 3; run(): number { const f = () => this.v; return f(); } } console.log(new C().run());
