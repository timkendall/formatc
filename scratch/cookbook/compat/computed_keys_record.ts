const r: Record<string, number> = {}; r["a"] = 1; r["b"] = 2; let s = 0; for (const k of Object.keys(r)) s += r[k]; console.log(s);
const key = "z"; const o = { [key]: 5 }; console.log(o["z"]);
