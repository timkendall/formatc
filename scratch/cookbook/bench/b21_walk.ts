import * as fs from "node:fs";
import * as path from "node:path";
const ROOT = "/Users/timkendall/Developer/lab/scriptc-formatter/bench/vscode";
const REPS = 3;
function walk(dir: string, out: string[]): void {
  const ents = fs.readdirSync(dir, { withFileTypes: true });
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = dir + "/" + e.name;
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}
function walkNames(dir: string, out: string[]): void {
  const names = fs.readdirSync(dir);
  for (let i = 0; i < names.length; i++) {
    const nm = names[i];
    if (nm === ".git" || nm === "node_modules") continue;
    const p = dir + "/" + nm;
    const st = fs.statSync(p);
    if (st.isDirectory()) walkNames(p, out);
    else out.push(p);
  }
}
function bench(name: string, f: () => number): void {
  let best = 1e18; let r = 0;
  for (let rep = 0; rep < REPS; rep++) { const t0 = performance.now(); r = f(); const dt = performance.now() - t0; if (dt < best) best = dt; }
  console.log(name.padEnd(30), best.toFixed(1).padStart(8), "ms  files=", r);
}
bench("walk withFileTypes", () => { const o: string[] = []; walk(ROOT, o); return o.length; });
bench("walk readdir+statSync", () => { const o: string[] = []; walkNames(ROOT, o); return o.length; });
