interface Cfg { a: number; b?: string } const p: Partial<Cfg> = {}; const r: Readonly<Cfg> = { a: 1 }; const pk: Pick<Cfg, "a"> = { a: 2 }; console.log(p.a, r.a, pk.a);
