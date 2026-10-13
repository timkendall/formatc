const N = 16 << 20;
const REPS = 3;
function sum(a: Uint8Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = ((s | 0) + (a[i] | 0)) | 0; return s; }
function sumI32(a: Int32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s = ((s | 0) + (a[i] | 0)) | 0; return s; }
function writeLoop(a: Uint8Array): number { for (let i = 0; i < a.length; i++) a[i] = i & 255; return a[5] | 0; }
function bench(name: string, f: () => number, bytes: number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(34), (bytes / 1e6 / (best / 1000)).toFixed(0).padStart(7), "MB/s  r=", r);
}
const priv = new Uint8Array(N);
const sab = new SharedArrayBuffer(N);
const shared = new Uint8Array(sab);
const sharedI32 = new Int32Array(sab);
const privI32 = new Int32Array(N >> 2);
for (let i = 0; i < N; i++) { priv[i] = (i * 7) & 255; shared[i] = (i * 7) & 255; }
bench("sum private Uint8Array", () => sum(priv), N);
bench("sum SAB Uint8Array", () => sum(shared), N);
bench("sum private Int32Array", () => sumI32(privI32), N);
bench("sum SAB Int32Array", () => sumI32(sharedI32), N);
bench("write loop private", () => writeLoop(priv), N);
bench("write loop SAB", () => writeLoop(shared), N);
bench("priv.set(shared) memcpy", () => { priv.set(shared); return priv[3] | 0; }, N);
bench("shared.set(priv) memcpy", () => { shared.set(priv); return shared[3] | 0; }, N);
bench("Buffer.from(sab) copy?", () => { const b = Buffer.from(sab); return b.length; }, N);
bench("Atomics.load loop (Int32)", () => { let s = 0; for (let i = 0; i < sharedI32.length; i++) s = ((s | 0) + (Atomics.load(sharedI32, i) | 0)) | 0; return s; }, N);
