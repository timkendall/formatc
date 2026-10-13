const m = new Map<string, number[]>(); m.set("a", [1]); m.get("a")!.push(2); console.log(m.get("a"), m.size);
