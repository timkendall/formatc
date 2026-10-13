interface O { a: number; b?: number } function f(o: O): number { return o.a + (o.b ?? 10); } console.log(f({ a: 1 }), f({ a: 1, b: 2 }));
