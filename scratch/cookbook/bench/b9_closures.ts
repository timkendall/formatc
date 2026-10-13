const REPS = 5;
const K = 20_000_000;
function apply(f: (x: number) => number, x: number): number { return f(x); }
function createPerCall(): number { let s = 0; for (let i = 0; i < K; i++) { const k = i & 7; s += apply((x: number) => x + k, i); } return s; }
function createNoCapture(): number { let s = 0; for (let i = 0; i < K; i++) { s += apply((x: number) => x * 2, i); } return s; }
function callStored(f: (x: number) => number): number { let s = 0; for (let i = 0; i < K; i++) s += f(i); return s; }
function mutCapture(): number { let c = 0; const inc = (): void => { c++; }; for (let i = 0; i < K; i++) inc(); return c; }
function arrForEach(a: number[]): number { let s = 0; a.forEach((v) => { s += v; }); return s; }
function arrMap(a: number[]): number { return a.map((v) => v * 2).length; }
function arrReduce(a: number[]): number { return a.reduce((p, v) => p + v, 0); }
function arrFilter(a: number[]): number { return a.filter((v) => v > 5).length; }
function arrSome(a: number[]): number { return a.some((v) => v < 0) ? 1 : 0; }
function bench(name: string, f: () => number, ops: number = K): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op  r=", r);
}
const na: number[] = []; for (let i = 0; i < K; i++) na.push(i);
let cap = 3;
bench("create closure+call (cap)", createPerCall);
bench("create closure+call (nocap)", createNoCapture);
bench("call stored closure", () => callStored((x: number) => x + cap));
bench("mutating capture", mutCapture);
bench("forEach", () => arrForEach(na));
bench("map", () => arrMap(na));
bench("reduce", () => arrReduce(na));
bench("filter", () => arrFilter(na));
bench("some", () => arrSome(na));
