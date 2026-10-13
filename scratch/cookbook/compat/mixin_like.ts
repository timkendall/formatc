type Ctor<T> = new (...a: any[]) => T; function Mix<TB extends Ctor<{}>>(Base: TB) { return class extends Base { m = 1; }; } class X {} const Y = Mix(X); console.log(new Y().m);
