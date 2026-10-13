import * as fs from "node:fs";
const ROOT = "/Users/timkendall/Developer/lab/scriptc-formatter/bench/vscode/";
const REPS = 3;
const listText = fs.readFileSync("/tmp/vscode-files.txt", "utf8");
const files: string[] = listText.split("\n").filter((s) => s.length > 0);
console.log("files in list:", files.length);

function readAllSync(): number {
  let total = 0, bad = 0;
  for (let i = 0; i < files.length; i++) {
    try { const b = fs.readFileSync(ROOT + files[i]); total += b.length; } catch (e) { bad++; }
  }
  return total + bad * 0;
}
function readAllReuse(): number {
  let total = 0;
  let buf = Buffer.alloc(1 << 20);
  for (let i = 0; i < files.length; i++) {
    try {
      const fd = fs.openSync(ROOT + files[i], "r");
      const st = fs.fstatSync(fd);
      const size = st.size;
      if (size > buf.length) buf = Buffer.alloc(size * 2);
      let got = 0;
      while (got < size) {
        const n = fs.readSync(fd, buf, got, size - got, got);
        if (n <= 0) break;
        got += n;
      }
      fs.closeSync(fd);
      total += got;
    } catch (e) { }
  }
  return total;
}
function readAllReuseNoStat(): number {
  let total = 0;
  const buf = Buffer.alloc(8 << 20);
  for (let i = 0; i < files.length; i++) {
    try {
      const fd = fs.openSync(ROOT + files[i], "r");
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      total += n;
    } catch (e) { }
  }
  return total;
}
function readAllUtf8(): number {
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    try { const s = fs.readFileSync(ROOT + files[i], "utf8"); total += s.length; } catch (e) { }
  }
  return total;
}
function statOnly(): number {
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    try { total += fs.statSync(ROOT + files[i]).size; } catch (e) { }
  }
  return total;
}
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0; let first = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (rep === 0) first = dt; if (dt < best) best = dt; }
  console.log(name.padEnd(26), "first", first.toFixed(0).padStart(5), "ms  best", best.toFixed(0).padStart(5), "ms  ", (r / 1e6 / (best / 1000)).toFixed(0), "MB/s  bytes=", r);
}
bench("readFileSync(Buffer)", readAllSync);
bench("open+fstat+readSync reuse", readAllReuse);
bench("open+readSync(8MB) nostat", readAllReuseNoStat);
bench("readFileSync(utf8 str)", readAllUtf8);
bench("statSync only", statOnly);
