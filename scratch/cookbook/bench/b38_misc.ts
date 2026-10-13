const REPS = 3;
class P { constructor(public v: number) {} }
function sortNum(n: number): number { const a: number[] = []; let x = 12345; for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; a.push(x); } a.sort((p, q) => p - q); return a[n >> 1]; }
function sortObjs(n: number): number { const a: P[] = []; let x = 12345; for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; a.push(new P(x)); } a.sort((p, q) => p.v - q.v); return a[n >> 1].v; }
function stackObjs(n: number): number { const st: P[] = []; let s = 0; for (let i = 0; i < n; i++) { st.push(new P(i)); if ((i & 3) === 3) { s += st.pop()!.v; s += st.pop()!.v; } } return s + st.length; }
function stackReuse(n: number, st: P[], p: P): number { st.length = 0; let s = 0; for (let i = 0; i < n; i++) { st.push(p); if ((i & 3) === 3) { st.pop(); st.pop(); } } return s + st.length; }
function indexObjs(a: P[], n: number): number { let s = 0; for (let r = 0; r < n; r++) for (let i = 0; i < a.length; i++) s += a[i].v; return s; }
function bench(name: string, f: () => number, ops: number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(30), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op  r=", r);
}
bench("sort number[] 1M cmp fn", () => sortNum(1_000_000), 1_000_000);
bench("sort P[] 1M cmp fn", () => sortObjs(1_000_000), 1_000_000);
bench("stack push/pop new P", () => stackObjs(10_000_000), 10_000_000);
const st: P[] = []; const pp = new P(1);
bench("stack push/pop existing P", () => stackReuse(10_000_000, st, pp), 10_000_000);
const arr: P[] = []; for (let i = 0; i < 1_000_000; i++) arr.push(new P(i));
bench("P[] index+field read", () => indexObjs(arr, 10), 10_000_000);
