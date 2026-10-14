import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { publish } from "@scriptc/threads";
class Tok { kind: number; lit: string; constructor(k: number) { this.kind = k; this.lit = ""; } }
class Seg { toks: Tok[]; isLiteral: boolean; lit: string;
  constructor() { this.toks = []; this.isLiteral = false; this.lit = ""; } }
class Holder { g: Seg[][]; constructor(g: Seg[][]) { this.g = g; } }
function matchToks(toks: Tok[], ti: number, s: string, si: number, end: number): boolean {
  while (ti < toks.length) {
    const t = toks[ti];
    if (t.kind === 0) {
      if (!s.startsWith(t.lit, si)) return false;
      si += t.lit.length; ti++;
    } else {
      for (let j = si; j <= end; j++) if (matchToks(toks, ti + 1, s, j, end)) return true;
      return false;
    }
  }
  return si === end;
}
function matchSegs(segs: Seg[], k: number, path: string, pos: number): boolean {
  const nsegs = segs.length;
  while (true) {
    if (k === nsegs) return false;
    const seg = segs[k];
    let end = path.indexOf("/", pos);
    if (end < 0) end = path.length;
    if (seg.isLiteral) {
      if (end - pos !== seg.lit.length) return false;
      if (!path.startsWith(seg.lit, pos)) return false;
    } else if (!matchToks(seg.toks, 0, path, pos, end)) return false;
    if (end === path.length) { k = k + 1; return k === nsegs; }
    k = k + 1; pos = end + 1;
  }
}
function mk(): Seg[] {
  const s1 = new Seg(); s1.isLiteral = true; s1.lit = "src";
  const s2 = new Seg(); const t1 = new Tok(1); const t2 = new Tok(0); t2.lit = ".ts"; s2.toks.push(t1); s2.toks.push(t2);
  return [s1, s2];
}
if (isMainThread) {
  const h = publish(new Holder([mk(), mk()]));
  for (let k = 0; k < Number(process.argv[2] || "4"); k++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { h, k } });
    w.on("message", (m: string) => { console.log(m); });
    w.on("error", (e: Error) => { console.log("err", e.message); });
  }
} else {
  const d = workerData as { h: Holder; k: number };
  let s = 0;
  const paths = ["src/a.ts", "src/b.js", "x/y"];
  for (let it = 0; it < 500000; it++) {
    if (matchSegs(d.h.g[it % 2], 0, paths[it % 3], 0)) s++;
  }
  parentPort!.postMessage("worker " + d.k + " matches " + s);
}
