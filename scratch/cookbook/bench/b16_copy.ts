import * as fs from "node:fs";
const REPS = 5;
const buf: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const N = buf.length;
const out = Buffer.alloc(N + 4096);
const u8: Uint8Array = buf;
const uout: Uint8Array = out;
function viaCopy(run: number): number { const lim = N - run; let n = 0; for (let i = 0; i < lim; i += run) { buf.copy(out, n, i, i + run); n += run; } return n; }
function viaSet(run: number): number { const lim = N - run; let n = 0; for (let i = 0; i < lim; i += run) { uout.set(u8.subarray(i, i + run), n); n += run; } return n; }
function viaCopyWithin(run: number): number { const lim = N - run; let n = 8; for (let i = 0; i < lim; i += run) { uout.copyWithin(n, i, i + run); n += run; } return n; }
function viaFill(run: number): number { const lim = N - run; let n = 0; for (let i = 0; i < lim; i += run) { uout.fill(65, n, n + run); n += run; } return n; }
function viaLoop(run: number): number { const lim = N - run; let n = 0; for (let i = 0; i < lim; i += run) { for (let j = 0; j < run; j++) uout[n + j] = u8[i + j] | 0; n += run; } return n; }
function bench(name: string, f: () => number, ops: number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op ", (N / 1e6 / (best / 1000)).toFixed(0).padStart(7), "MB/s r=", r);
}
for (const run of [4, 16, 64, 1024]) {
  bench("Buffer.copy run=" + run, () => viaCopy(run), N / run);
  bench("set(subarray) run=" + run, () => viaSet(run), N / run);
  bench("copyWithin run=" + run, () => viaCopyWithin(run), N / run);
  bench("fill run=" + run, () => viaFill(run), N / run);
  bench("loop run=" + run, () => viaLoop(run), N / run);
}
