const REPS = 5;
const K = 20_000_000;
function sumA(a: number[]): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function sumB(a: number[]): number { let s = 0; const n = a.length; for (let i = 0; i < n; i++) s += a[i]; return s; }
function sumC(a: number[]): number { let s = 0; const n = a.length | 0; for (let i = 0; i < n; i++) s += a[i]; return s; }
function sumD(a: number[]): number { let s = 0; for (let i = 0, n = a.length; i < n; i++) s += a[i]; return s; }
function sumE(a: Int32Array): number { let s = 0; const n = a.length; for (let i = 0; i < n; i++) s += a[i]; return s; }
function sumF(a: Int32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function sumG(a: Int32Array, lo: number, hi: number): number { let s = 0; for (let i = lo; i < hi; i++) s += a[i]; return s; }
function sumH(a: Int32Array, lo: number, hi: number): number { let s = 0; for (let i = lo | 0; i < (hi | 0); i++) s += a[i]; return s; }
function sumI(a: Int32Array): number { let s = 0; let i = 0; while (i < a.length) { s += a[i]; i++; } return s; }
function sumJ(a: Int32Array): number { let s = 0; for (let i = a.length - 1; i >= 0; i--) s += a[i]; return s; }
function sumK(a: Int32Array): number { let s = 0; for (let i = 0; i < a.length; i += 2) s += a[i]; return s; }
function bench(name: string, f: () => number, ops: number = K): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(24), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op  r=", r);
}
const na: number[] = []; for (let i = 0; i < K; i++) na.push(i);
const ia = new Int32Array(K); for (let i = 0; i < K; i++) ia[i] = i;
bench("arr i<a.length", () => sumA(na));
bench("arr n=a.length", () => sumB(na));
bench("arr n=a.length|0", () => sumC(na));
bench("arr for(i,n=len)", () => sumD(na));
bench("i32 n=a.length", () => sumE(ia));
bench("i32 i<a.length", () => sumF(ia));
bench("i32 lo..hi", () => sumG(ia, 0, K));
bench("i32 lo|0..hi|0", () => sumH(ia, 0, K));
bench("i32 while", () => sumI(ia));
bench("i32 reverse", () => sumJ(ia));
bench("i32 step2", () => sumK(ia), K / 2);
