const o = { a: 1, b: 2 }; let s = 0; for (const [k, v] of Object.entries(o)) s += v; console.log(s, Object.values(o), Array.from({ length: 3 }, (_, i) => i));
