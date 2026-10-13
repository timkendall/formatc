import * as fs from "node:fs";
const REPS = 5;
const data: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
enum E { A = 10, B = 32, C = 47 }
const enum CE { A = 10, B = 32, C = 47 }
const K_A = 10, K_B = 32, K_C = 47;
class S { static readonly A = 10; static readonly B = 32; static readonly C = 47; }
const OBJ = { A: 10, B: 32, C: 47 } as const;
let mutA = 10;
function useEnum(b: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const c = b[i] | 0; if (c === E.A || c === E.B || c === E.C) n = ((n | 0) + 1) | 0; } return n; }
function useConstEnum(b: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const c = b[i] | 0; if (c === CE.A || c === CE.B || c === CE.C) n = ((n | 0) + 1) | 0; } return n; }
function useConst(b: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const c = b[i] | 0; if (c === K_A || c === K_B || c === K_C) n = ((n | 0) + 1) | 0; } return n; }
function useStatic(b: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const c = b[i] | 0; if (c === S.A || c === S.B || c === S.C) n = ((n | 0) + 1) | 0; } return n; }
function useObj(b: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const c = b[i] | 0; if (c === OBJ.A || c === OBJ.B || c === OBJ.C) n = ((n | 0) + 1) | 0; } return n; }
function useMutLet(b: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const c = b[i] | 0; if (c === mutA || c === K_B || c === K_C) n = ((n | 0) + 1) | 0; } return n; }
function useLiteral(b: Uint8Array): number { let n = 0; for (let i = 0; i < b.length; i++) { const c = b[i] | 0; if (c === 10 || c === 32 || c === 47) n = ((n | 0) + 1) | 0; } return n; }
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(24), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s r=", r);
}
bench("literal", () => useLiteral(data)); bench("enum", () => useEnum(data)); bench("const enum", () => useConstEnum(data)); bench("module const", () => useConst(data)); bench("static readonly", () => useStatic(data)); bench("as const object", () => useObj(data)); bench("module let (mutable)", () => useMutLet(data));
