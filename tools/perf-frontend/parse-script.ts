// Worker-mode harness for the JS/TS front end. Parses every ts/js file of bench/vscode the way the formatter does and reports MB/s.
//   mode "parse": parseFile only (module, then script if refused).  mode "full": prepareScriptText + parseAttempt (parse, fileBegin, refusal).
//   scriptc build tools/perf-frontend/parse-script.ts -o /tmp/ps-pfront && cd bench/vscode && /usr/bin/time -l /tmp/ps-pfront --mode full
//   [--limit N] [--reps R] [--list FILE] [--root DIR]
import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { parseFile } from "../../src/sema/parser/parser/run.ts";
import { PS_OK, parseAttempt, prepareScriptText, scriptKinds } from "../../src/sema/parser/script.ts";

function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length - 1; i++) {
    if (a[i] === name) return a[i + 1];
  }
  return dflt;
}

function isTarget(p: string): boolean {
  return (
    p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".mts") || p.endsWith(".cts") ||
    p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs") || p.endsWith(".cjs")
  );
}

function main(): void {
  const root = arg("--root", "bench/vscode");
  const listPath = arg("--list", "/tmp/vscode-files.txt");
  const limit = parseInt(arg("--limit", "0"), 10);
  const reps = parseInt(arg("--reps", "1"), 10);
  const mode = arg("--mode", "full");
  const lines = fs.readFileSync(listPath, "utf8").split("\n");
  const paths: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 0 && isTarget(l)) paths.push(l);
    if (limit > 0 && paths.length >= limit) break;
  }
  const bufs: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < paths.length; i++) {
    const b = fs.readFileSync(root + "/" + paths[i]);
    bufs.push(b);
    total += b.length;
  }
  console.log("files", paths.length, "bytes", total, "mode", mode);
  let best = 1e18;
  let accepted = 0;
  for (let rep = 0; rep < reps; rep++) {
    const t0 = performance.now();
    accepted = 0;
    for (let i = 0; i < paths.length; i++) {
      const src = bufs[i];
      const len = src.length;
      const p = paths[i];
      const ks = scriptKinds(p);
      if (mode === "parse") {
        let r = 1;
        if ((ks & 1) !== 0) r = parseFile(src, len, p, false);
        if (r !== 0 && (ks & 2) !== 0) r = parseFile(src, len, p, true);
        if (r === 0) accepted++;
      } else {
        prepareScriptText(src, len, p, false, true);
        let r = 1;
        if ((ks & 1) !== 0) r = parseAttempt(false, p, false, true, false);
        if (r !== PS_OK && (ks & 2) !== 0) r = parseAttempt(true, p, false, true, false);
        if (r === PS_OK) accepted++;
      }
    }
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
    console.log("rep", rep, dt.toFixed(1), "ms", (total / 1e6 / (dt / 1000)).toFixed(0), "MB/s");
  }
  console.log("best", best.toFixed(1), "ms", (total / 1e6 / (best / 1000)).toFixed(0), "MB/s", "accepted", accepted);
}

main();
