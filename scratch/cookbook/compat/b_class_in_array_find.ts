class P { constructor(public id: number) {} } const ps = [new P(1), new P(2)]; console.log(ps.find((p) => p.id === 2)?.id, ps.findIndex((p) => p.id === 5));
