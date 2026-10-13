const REPS = 5;
const K = 20_000_000;
function pushNum(): number { const a: number[] = []; for (let i = 0; i < K; i++) a.push(i); return a.length; }
function pushIdxNum(): number { const a: number[] = []; for (let i = 0; i < K; i++) a.push(i); let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function sumNumArr(a: number[]): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function sumNumArrOf(a: number[]): number { let s = 0; for (const v of a) s += v; return s; }
function sumNumArrLocalN(a: number[]): number { let s = 0; const n = a.length; for (let i = 0; i < n; i++) s += a[i]; return s; }
function writeNumArr(a: number[]): number { for (let i = 0; i < a.length; i++) a[i] = i * 2; return a[5]; }
function sumI32(a: Int32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function writeI32(a: Int32Array): number { for (let i = 0; i < a.length; i++) a[i] = i * 2; return a[5]; }
function pushI32Manual(): number {
  let a = new Int32Array(16); let n = 0;
  for (let i = 0; i < K; i++) {
    if (n === a.length) { const b = new Int32Array(a.length * 2); b.set(a); a = b; }
    a[n] = i; n++;
  }
  return n;
}
function pushPop(): number { const a: number[] = []; let s = 0; for (let i = 0; i < K; i++) { a.push(i); a.push(i + 1); s += a.pop()!; s += a.pop()!; } return s; }
function arrOfArr(): number { let s = 0; for (let i = 0; i < K / 10; i++) { const a = [i, i + 1, i + 2]; s += a[1]; } return s; }
function strArrPush(): number { const a: string[] = []; for (let i = 0; i < K / 10; i++) a.push("x"); return a.length; }
function numArrIndexOf(a: number[]): number { let s = 0; for (let i = 0; i < 2000; i++) s += a.indexOf(a.length - 1 - i); return s; }
function sliceCopy(a: number[]): number { let s = 0; for (let i = 0; i < 200; i++) s += a.slice(0).length; return s; }
function bench(name: string, f: () => number, ops: number = K): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(24), (best * 1e6 / ops).toFixed(2).padStart(8), "ns/op  r=", r);
}
const na: number[] = []; for (let i = 0; i < K; i++) na.push(i);
const ia = new Int32Array(K); for (let i = 0; i < K; i++) ia[i] = i;
bench("number[] push", pushNum);
bench("number[] push+sum", pushIdxNum);
bench("number[] sum idx", () => sumNumArr(na));
bench("number[] sum for-of", () => sumNumArrOf(na));
bench("number[] sum n-local", () => sumNumArrLocalN(na));
bench("number[] write", () => writeNumArr(na));
bench("Int32Array sum", () => sumI32(ia));
bench("Int32Array write", () => writeI32(ia));
bench("Int32Array manual grow", pushI32Manual);
bench("number[] push/pop", pushPop, K * 4);
bench("array literal [a,b,c]", arrOfArr, K / 10);
bench("string[] push", strArrPush, K / 10);
bench("indexOf (200k scan)", () => numArrIndexOf(na.slice(0, 200000)), 2000 * 100000);
bench("slice copy 20M", () => sliceCopy(na.slice(0, 1000000)), 200 * 1000000);
