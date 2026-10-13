import * as fs from "node:fs";
import { Interner } from "../lib/intern.ts";
import { IntMap } from "../lib/hashtable.ts";
import { AstArena } from "../lib/ast_arena.ts";
import { eqAscii, CC } from "../lib/bytes.ts";
import { lexKernel } from "../threads/lexkernel.ts";
const REPS = 3;
const buf: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const N = buf.length;
const toks = new Int32Array(12_000_000 * 3);
const ntok = lexKernelFull(buf);
function lexKernelFull(b: Buffer): number {
  // use the ring kernel in chunks isn't possible; re-lex into big array with simple loop
  let pos = 0; let nt = 0; const n = b.length;
  while (pos < n) {
    const c = b[pos] | 0;
    const cc = CC[c] | 0;
    if ((cc & 1) !== 0) { pos = ((pos | 0) + 1) | 0; continue; }
    const start = pos;
    if ((cc & 2) !== 0) {
      pos = ((pos | 0) + 1) | 0;
      while (pos < n && ((CC[b[pos] | 0] | 0) & 4) !== 0) pos = ((pos | 0) + 1) | 0;
      toks[nt * 3] = start | 0; toks[nt * 3 + 1] = pos | 0; toks[nt * 3 + 2] = 1;
    } else { pos = ((pos | 0) + 1) | 0; toks[nt * 3] = start | 0; toks[nt * 3 + 1] = pos | 0; toks[nt * 3 + 2] = 0; }
    nt = ((nt | 0) + 1) | 0;
  }
  return nt;
}
function internAll(): number {
  const it = new Interner();
  let ids = 0;
  for (let t = 0; t < ntok; t++) {
    if ((toks[t * 3 + 2] | 0) === 1) { ids = ((ids | 0) + (it.intern(buf, toks[t * 3] | 0, toks[t * 3 + 1] | 0) & 1)) | 0; }
  }
  return it.count;
}
function mapSliceAll(): number {
  const text = buf.toString("latin1");
  const m = new Map<string, number>();
  for (let t = 0; t < ntok; t++) {
    if ((toks[t * 3 + 2] | 0) === 1) { const s = text.slice(toks[t * 3] | 0, toks[t * 3 + 1] | 0); if (!m.has(s)) m.set(s, m.size); }
  }
  return m.size;
}
function keywordEq(): number {
  let c = 0;
  for (let t = 0; t < ntok; t++) {
    if ((toks[t * 3 + 2] | 0) === 1) { const s = toks[t * 3] | 0; if (eqAscii(buf, s, "function")) c = ((c | 0) + 1) | 0; }
  }
  return c;
}
function intMapBench(): number {
  const m = new IntMap(1 << 16);
  for (let i = 0; i < 50000; i++) m.set(i * 7, i);
  let s = 0;
  for (let r = 0; r < 100; r++) for (let i = 0; i < 100000; i++) s = ((s | 0) + (m.get(i * 7, -1) | 0)) | 0;
  return s;
}
function arenaBench(): number {
  const a = new AstArena(16);
  const root = a.add(1, 0, 0, 0);
  let last = 0;
  for (let i = 0; i < 10_000_000; i++) { const n = a.add(2, i, i + 1, i); a.appendChild(root, last, n); last = n; }
  let s = 0;
  let c = a.first[root] | 0;
  while (c !== 0) { s = ((s | 0) + (a.data[c] | 0)) | 0; c = a.next[c] | 0; }
  return s;
}
class Nd { kind: number; start: number; end: number; data: number; next: Nd | null = null; constructor(k: number, s: number, e: number, d: number) { this.kind = k; this.start = s; this.end = e; this.data = d; } }
class Parent { first: Nd | null = null; last: Nd | null = null; }
function classListBench(): number {
  const p = new Parent();
  for (let i = 0; i < 10_000_000; i++) { const n = new Nd(2, i, i + 1, i); if (p.last === null) p.first = n; else p.last.next = n; p.last = n; }
  let s = 0; let c = p.first;
  while (c !== null) { s = (s + c.data) | 0; c = c.next; }
  return s;
}
function bench(name: string, f: () => number, ops: number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(30), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op  r=", r);
}
console.log("tokens:", ntok);
bench("Interner.intern (bytes)", internAll, ntok);
bench("Map<string> via slice", mapSliceAll, ntok);
bench("eqAscii(\"function\")", keywordEq, ntok);
bench("IntMap.get", intMapBench, 10_000_000);
bench("AstArena add+link+walk 10M", arenaBench, 10_000_000);
bench("class Nd list add+walk 10M", classListBench, 10_000_000);
