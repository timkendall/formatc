import * as fs from "node:fs";
const data: Uint8Array = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const REPS = 5;
function k_cnt(buf: Uint8Array): number { let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++; return n; }
function l_cnt0(buf: Uint8Array): number { let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n = (n + 1) | 0; return n; }
function m_cnt1(buf: Uint8Array): number { let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n = ((n | 0) + 1) | 0; return n; }
function n_cntret(buf: Uint8Array): number { let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n = ((n | 0) + 1) | 0; return n | 0; }
function o_cntadd(buf: Uint8Array): number { let n = 0; for (let i = 0; i < buf.length; i++) n += buf[i] === 10 ? 1 : 0; return n; }
function p_cntbr(buf: Uint8Array): number { let n = 0; for (let i = 0; i < buf.length; i++) n = ((n | 0) + (buf[i] === 10 ? 1 : 0)) | 0; return n; }
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(16), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s  r=", r);
}
bench("n++", () => k_cnt(data));
bench("n=(n+1)|0", () => l_cnt0(data));
bench("n=((n|0)+1)|0", () => m_cnt1(data));
bench("same, ret n|0", () => n_cntret(data));
bench("n+=cond?1:0", () => o_cntadd(data));
bench("(n|0)+(cond)|0", () => p_cntbr(data));
