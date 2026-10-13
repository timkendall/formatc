class Reg<V> { m = new Map<string, V>(); put(k: string, v: V): void { this.m.set(k, v); } get(k: string): V | undefined { return this.m.get(k); } }
const r = new Reg<number[]>(); r.put("a", [1]); console.log(r.get("a"), r.get("b"));
