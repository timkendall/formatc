const m = new Map<string, number>(); m.set("a", 1); const v = m.get("a")!; const w = m.get("b") as number | undefined; console.log(v, w);
