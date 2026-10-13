const o = { a: 1, b: 2 }; let ks = ""; for (const k in o) ks += k; console.log(ks);
const m = new Map<string, number>([["x", 1], ["y", 2]]); let s = 0; for (const [k, v] of m) s += v; console.log(s);
let cs = 0; for (const ch of "abc") cs += ch.charCodeAt(0); console.log(cs);
