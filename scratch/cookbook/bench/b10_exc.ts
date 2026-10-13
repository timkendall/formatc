const REPS = 5;
const K = 20_000_000;
function mayThrow(x: number): number { if (x < 0) throw new Error("neg"); return x + 1; }
function noThrowLoop(): number { let s = 0; for (let i = 0; i < K; i++) s = ((s | 0) + (mayThrow(i) | 0)) | 0; return s; }
function tryLoop(): number { let s = 0; for (let i = 0; i < K; i++) { try { s = ((s | 0) + (mayThrow(i) | 0)) | 0; } catch (e) { s = 0; } } return s; }
function tryOutside(): number { let s = 0; try { for (let i = 0; i < K; i++) s = ((s | 0) + (mayThrow(i) | 0)) | 0; } catch (e) { s = -1; } return s; }
function tryFinally(): number { let s = 0; for (let i = 0; i < K; i++) { try { s = ((s | 0) + (mayThrow(i) | 0)) | 0; } finally { s = (s + 1) | 0; } } return s; }
function throwCatch(n: number): number { let s = 0; for (let i = 0; i < n; i++) { try { s = ((s | 0) + (mayThrow(-1) | 0)) | 0; } catch (e) { s = (s + 1) | 0; } } return s; }
function throwStr(n: number): number { let s = 0; for (let i = 0; i < n; i++) { try { throw 5; } catch (e) { s = (s + 1) | 0; } } return s; }
class ParseError { pos: number; constructor(p: number) { this.pos = p; } }
function throwCustom(n: number): number { let s = 0; for (let i = 0; i < n; i++) { try { throw new ParseError(i); } catch (e) { s = (s + 1) | 0; } } return s; }
function deepThrow(d: number): number { if (d === 0) throw new Error("x"); return deepThrow(d - 1) + 1; }
function throwDeep(n: number): number { let s = 0; for (let i = 0; i < n; i++) { try { s += deepThrow(50); } catch (e) { s++; } } return s; }
function bench(name: string, f: () => number, ops: number = K): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(26), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op  r=", r);
}
bench("no try (may-throw fn)", noThrowLoop);
bench("try/catch inside loop", tryLoop);
bench("try/catch outside loop", tryOutside);
bench("try/finally inside loop", tryFinally);
bench("throw Error+catch", () => throwCatch(1_000_000), 1_000_000);
bench("throw number+catch", () => throwStr(1_000_000), 1_000_000);
bench("throw class+catch", () => throwCustom(1_000_000), 1_000_000);
bench("throw depth 50", () => throwDeep(200_000), 200_000);
