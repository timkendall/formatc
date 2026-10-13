import * as fs from "node:fs";
const REPS = 5;
const data: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
const TBL = new Uint8Array(256);
function classifySwitch(c: number): number {
  switch (c) {
    case 40: case 41: return 1; case 123: case 125: return 2; case 91: case 93: return 3;
    case 59: return 4; case 44: return 5; case 46: return 6; case 58: return 7; case 61: return 8;
    case 43: case 45: return 9; case 42: case 47: case 37: return 10; case 60: case 62: return 11;
    case 33: case 63: return 12; case 38: case 124: case 94: case 126: return 13;
    case 34: case 39: case 96: return 14; case 32: case 9: case 10: case 13: return 15;
    default: return (c >= 48 && c <= 57) ? 16 : 17;
  }
}
for (let c = 0; c < 256; c++) TBL[c] = classifySwitch(c);
function viaSwitch(b: Uint8Array): number { let s = 0; for (let i = 0; i < b.length; i++) s = ((s | 0) + (classifySwitch(b[i] | 0) | 0)) | 0; return s; }
function viaTable(b: Uint8Array): number { let s = 0; for (let i = 0; i < b.length; i++) s = ((s | 0) + (TBL[b[i] | 0] | 0)) | 0; return s; }
function viaIfChain(b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i] | 0; let r = 17;
    if (c === 40 || c === 41) r = 1; else if (c === 123 || c === 125) r = 2; else if (c === 91 || c === 93) r = 3; else if (c === 59) r = 4; else if (c === 44) r = 5; else if (c === 46) r = 6;
    else if (c === 58) r = 7; else if (c === 61) r = 8; else if (c === 43 || c === 45) r = 9; else if (c === 42 || c === 47 || c === 37) r = 10; else if (c === 60 || c === 62) r = 11; else if (c === 33 || c === 63) r = 12;
    else if (c === 38 || c === 124 || c === 94 || c === 126) r = 13; else if (c === 34 || c === 39 || c === 96) r = 14; else if (c === 32 || c === 9 || c === 10 || c === 13) r = 15; else if (c >= 48 && c <= 57) r = 16;
    s = ((s | 0) + r) | 0;
  }
  return s;
}
function viaSwitchInline(b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < b.length; i++) {
    let r = 17;
    switch (b[i] | 0) {
      case 40: case 41: r = 1; break; case 123: case 125: r = 2; break; case 91: case 93: r = 3; break;
      case 59: r = 4; break; case 44: r = 5; break; case 46: r = 6; break; case 58: r = 7; break; case 61: r = 8; break;
      case 43: case 45: r = 9; break; case 42: case 47: case 37: r = 10; break; case 60: case 62: r = 11; break;
      case 33: case 63: r = 12; break; case 38: case 124: case 94: case 126: r = 13; break;
      case 34: case 39: case 96: r = 14; break; case 32: case 9: case 10: case 13: r = 15; break;
      default: r = 17;
    }
    s = ((s | 0) + r) | 0;
  }
  return s;
}
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(24), (N / 1e6 / (best / 1000)).toFixed(0).padStart(6), "MB/s r=", r);
}
bench("switch (fn)", () => viaSwitch(data)); bench("switch inline", () => viaSwitchInline(data)); bench("table lookup", () => viaTable(data)); bench("if-chain", () => viaIfChain(data));
