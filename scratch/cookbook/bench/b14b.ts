const REPS = 5;
const K = 20_000_000;
const big = new Int32Array(K);
function g1(d: Int32Array): number { let n = 0; for (let i = 0; i < K; i++) { d[n] = i; n = ((n | 0) + 1) | 0; } return n; }
function g2(d: Int32Array): number { let n = 0; for (let i = 0; i < K; i++) { d[n] = i | 0; n = ((n | 0) + 1) | 0; } return n; }
function g3(d: Int32Array): number { for (let i = 0; i < K; i++) d[i] = i | 0; return d[7] | 0; }
function g4(): number { const d = new Int32Array(K); for (let i = 0; i < K; i++) d[i] = i | 0; return d[7] | 0; }
function g5(): number { const d = new Int32Array(K); return d.length; }
function g6(): number { const d = new Int32Array(K); d.fill(1); return d.length; }
function bench(name: string, f: () => number, ops: number = K): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op  r=", r);
}
bench("d[n]=i (prealloc'd)", () => g1(big)); bench("d[n]=i|0", () => g2(big)); bench("d[i]=i|0", () => g3(big));
bench("new+d[i]=i|0 (fresh)", g4); bench("new Int32Array(20M) only", g5); bench("new + fill", g6);
