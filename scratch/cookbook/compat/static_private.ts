class C { static count = 0; #secret = 5; private pv = 6; static inc(): number { return ++C.count; } getS(): number { return this.#secret + this.pv; } static { C.count = 10; } }
console.log(C.inc(), new C().getS());
