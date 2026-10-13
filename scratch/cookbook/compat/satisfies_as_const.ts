const KW = { a: 1, b: 2 } as const; const t = { x: 1 } satisfies { x: number }; console.log(KW.a + KW.b, t.x);
const ARR = [1, 2, 3] as const; console.log(ARR.length, ARR[1]);
