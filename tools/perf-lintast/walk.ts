// Worker-mode micro-harness for the handle layer: parse every js/ts file of bench/vscode once per rep, then (depending on --phase)
// fileBegin, and a walk of every node (children + span + parent) plus the accessors the formatter calls most.
//
//   scriptc build tools/perf-lintast/walk.ts -o /tmp/plint-walk
//   cd bench/vscode && /usr/bin/time -l /tmp/plint-walk --phase parse   2>&1 | grep -E "instructions retired|cycles elapsed"
//                                           /tmp/plint-walk --phase begin   (parse + fileBegin)
//                                           /tmp/plint-walk --phase walk    (parse + fileBegin + walk)
// The cost of a phase is the difference of instructions retired between consecutive phases. The unused `Worker` import makes the
// compiler generate the code of the real binary (thread_local globals, shared checks on typed arrays).
import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { parseFile } from "../../src/sema/parser/parser/run.ts";
import { names } from "../../src/sema/parser/parser/mod.ts";
import {
  NODE_FILE,
  SP,
  fileBegin,
  hir,
  nodeChildren,
  nodeParent,
  nodeSpan,
  nodeKind,
  N_EXPR,
  exprTag,
  exprSpan,
  exprParent,
  exprChain,
  exprBinaryOpOf,
} from "../../src/lint/ast/index.ts";
import { I32Vec } from "../../src/sema/vec.ts";


function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length - 1; i++) if (a[i] === name) return a[i + 1];
  return dflt;
}

function isTarget(p: string): boolean {
  return (
    p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".mts") || p.endsWith(".cts") ||
    p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs") || p.endsWith(".cjs")
  );
}

function main(): void {
  if (process.argv.length > 1000) {
    const w = new Worker(new URL(import.meta.url));
    w.terminate();
  }
  const phase = arg("--phase", "walk");
  const level = phase === "parse" ? 0 : phase === "begin" ? 1 : phase === "walk" ? 2 : 3;
  const listPath = arg("--list", "/tmp/vscode-files.txt");
  const root = arg("--root", ".");
  const reps = parseInt(arg("--reps", "1"), 10);
  const lines = fs.readFileSync(listPath, "utf8").split("\n");
  const paths: string[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].length > 0 && isTarget(lines[i])) paths.push(lines[i]);
  const bufs: Buffer[] = [];
  for (let i = 0; i < paths.length; i++) bufs.push(fs.readFileSync(root + "/" + paths[i]));
  const kids = new I32Vec(64);
  const stack = new I32Vec(1024);
  let sink = 0;
  let nodes = 0;
  let ok = 0;
  const tStart = performance.now();
  for (let rep = 0; rep < reps; rep++) {
    for (let i = 0; i < paths.length; i++) {
      const src = bufs[i];
      const p = paths[i];
      let isScript = false;
      let r = 1;
      if (!p.endsWith(".cjs") && !p.endsWith(".cts")) r = parseFile(src, src.length, p, false);
      if (r !== 0 && !p.endsWith(".mjs") && !p.endsWith(".mts")) {
        r = parseFile(src, src.length, p, true);
        isScript = true;
      }
      if (r !== 0) continue;
      ok++;
      if (level < 1) continue;
      const isTs = p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".mts") || p.endsWith(".cts");
      fileBegin(names, isTs, !isScript);
      if (level < 2) continue;
      stack.reset();
      stack.push(NODE_FILE);
      while (stack.len > 0) {
        const n = stack.pop();
        nodes++;
        nodeSpan(n);
        sink = (sink + (SP[0] | 0)) | 0;
        sink = (sink + (nodeParent(n) | 0)) | 0;
        kids.reset();
        nodeChildren(n, -1, kids);
        for (let k = 0; k < kids.len; k++) stack.push(kids.data[k] | 0);
      }
      if (level < 3) continue;
      // the accessors the formatter calls per expression
      const ne = hir.nExprs | 0;
      for (let e = 0; e < ne; e++) {
        sink = (sink + exprTag(e)) | 0;
        exprSpan(e);
        sink = (sink + (SP[1] | 0)) | 0;
        sink = (sink + (exprParent(e) | 0)) | 0;
        sink = (sink + exprChain(e)) | 0;
        sink = (sink + exprBinaryOpOf(e)) | 0;
      }
      void nodeKind;
      void N_EXPR;
    }
  }
  console.log("phase", phase, "files", ok, "nodes", nodes, "sink", sink, "ms", (performance.now() - tStart).toFixed(0));
}

main();
