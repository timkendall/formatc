const REPS = 5;
const K = 10_000_000;
const NK = 4096;
function mapNumGet(m: Map<number, number>): number { let t = 0; for (let i = 0; i < K; i++) t += m.get((i * 2654435761) % NK) ?? 0; return t; }
function mapNumHas(m: Map<number, number>): number { let t = 0; for (let i = 0; i < K; i++) if (m.has((i * 7) % (NK * 2))) t++; return t; }
function mapNumSet(): number { const m = new Map<number, number>(); for (let i = 0; i < K / 4; i++) m.set(i, i); return m.size; }
function mapNumSetSmall(): number { const m = new Map<number, number>(); for (let i = 0; i < K; i++) m.set(i & 4095, i); return m.size; }
function mapStrGet(m: Map<string, number>, keys: string[]): number { let t = 0; for (let i = 0; i < K; i++) t += m.get(keys[i & 4095]) ?? 0; return t; }
function mapStrSet(keys: string[]): number { const m = new Map<string, number>(); for (let i = 0; i < K / 4; i++) m.set(keys[i & 4095], i); return m.size; }
function setNumHas(s: Set<number>): number { let t = 0; for (let i = 0; i < K; i++) if (s.has((i * 7) % (NK * 2))) t++; return t; }
function setStrHas(s: Set<string>, keys: string[]): number { let t = 0; for (let i = 0; i < K; i++) if (s.has(keys[i & 8191])) t++; return t; }
// open addressing hash table in Int32Array: keys[] values[]
function oaGet(keys: Int32Array, vals: Int32Array, mask: number): number {
  let t = 0;
  for (let i = 0; i < K; i++) {
    const k = ((i * 7) % (NK * 2)) | 0;
    let h = Math.imul(k, -1640531535) >>> 16;
    h = h & mask;
    let v = -1;
    while (true) {
      const kk = keys[h] | 0;
      if (kk === k) { v = vals[h] | 0; break; }
      if (kk === -1) break;
      h = (h + 1) & mask;
    }
    if (v >= 0) t = ((t | 0) + 1) | 0;
  }
  return t;
}
// bit-set membership via Uint8Array table
function tblHas(tb: Uint8Array): number { let t = 0; for (let i = 0; i < K; i++) if (tb[((i * 7) % (NK * 2)) | 0] === 1) t = ((t | 0) + 1) | 0; return t; }
function bench(name: string, f: () => number, ops: number = K): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op  r=", r);
}
const mn = new Map<number, number>(); for (let i = 0; i < NK; i++) mn.set(i, i);
const keys: string[] = []; for (let i = 0; i < 8192; i++) keys.push("key_" + i + "_ident");
const ms = new Map<string, number>(); for (let i = 0; i < NK; i++) ms.set(keys[i], i);
const sn = new Set<number>(); for (let i = 0; i < NK; i++) sn.add(i);
const ss = new Set<string>(); for (let i = 0; i < NK; i++) ss.add(keys[i]);
const cap = 16384, mask = cap - 1;
const hk = new Int32Array(cap).fill(-1), hv = new Int32Array(cap);
for (let i = 0; i < NK; i++) { let h = (Math.imul(i, -1640531535) >>> 16) & mask; while (hk[h] !== -1) h = (h + 1) & mask; hk[h] = i; hv[h] = i; }
const tb = new Uint8Array(NK * 2); for (let i = 0; i < NK; i++) tb[i] = 1;
bench("Map<number> get", () => mapNumGet(mn));
bench("Map<number> has", () => mapNumHas(mn));
bench("Map<number> set grow 2.5M", mapNumSet, K / 4);
bench("Map<number> set small", mapNumSetSmall);
bench("Map<string> get", () => mapStrGet(ms, keys));
bench("Map<string> set", () => mapStrSet(keys), K / 4);
bench("Set<number> has", () => setNumHas(sn));
bench("Set<string> has", () => setStrHas(ss, keys));
bench("open-addr Int32Array get", () => oaGet(hk, hv, mask));
bench("Uint8Array table has", () => tblHas(tb));
