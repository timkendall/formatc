// Micro-benchmarks of the handle layer on the vscode corpus: per operation, ns per node.
//   node tools/ast-bench.ts [--limit N] [--reps R]        scriptc build tools/ast-bench.ts -o /tmp/ast-bench && /tmp/ast-bench
import * as fs from "node:fs";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { names } from "../src/sema/parser/parser/mod.ts";
import {
  EXPR_CALL,
  N_EXPR,
  N_STMT,
  NODE_FILE,
  SP,
  exprChain,
  exprParent,
  exprSpan,
  exprTag,
  fileBegin,
  hir,
  nodeChildren,
  nodeParent,
  nodeSpan,
  stmtParent,
  stmtSpan,
} from "../src/lint/ast/index.ts";
import { I32Vec } from "../src/sema/vec.ts";

function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length - 1; i++) if (a[i] === name) return a[i + 1];
  return dflt;
}

function f1(x: number): string {
  return String(Math.round(x * 10) / 10);
}

function main(): void {
  const root = "bench/vscode";
  const limit = parseInt(arg("--limit", "3000"), 10);
  const reps = parseInt(arg("--reps", "5"), 10);
  const lines = fs.readFileSync("/tmp/vscode-files.txt", "utf8").split("\n");
  const paths: string[] = [];
  for (let i = 0; i < lines.length && paths.length < limit; i++) {
    const l = lines[i];
    if (l.endsWith(".ts") || l.endsWith(".tsx")) paths.push(l);
  }
  let best = [1e18, 1e18, 1e18, 1e18, 1e18, 1e18, 1e18, 1e18, 1e18, 1e18];
  let nodes = 0;
  let nexprs = 0;
  let nstmts = 0;
  let sink = 0;
  for (let rep = 0; rep < reps; rep++) {
    const t = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    nodes = 0;
    nexprs = 0;
    nstmts = 0;
    for (let i = 0; i < paths.length; i++) {
      const b = fs.readFileSync(root + "/" + paths[i]);
      const src = new Uint8Array(b.length + 16);
      src.set(b);
      if (parseFile(src, b.length, paths[i], false) !== 0) continue;
      let t0 = performance.now();
      fileBegin(names, true, true);
      t[0] += performance.now() - t0;
      // collect all nodes
      const all = new I32Vec(1024);
      const kids = new I32Vec(64);
      const stack = new I32Vec(1024);
      stack.push(NODE_FILE);
      t0 = performance.now();
      while (stack.len > 0) {
        const n = stack.pop();
        all.push(n);
        kids.reset();
        nodeChildren(n, -1, kids);
        for (let k = 0; k < kids.len; k++) stack.push(kids.data[k] | 0);
      }
      t[1] += performance.now() - t0;
      nodes += all.len;
      const d = all.data;
      const n = all.len;
      t0 = performance.now();
      let acc = 0;
      for (let k = 0; k < n; k++) {
        nodeSpan(d[k] | 0);
        acc = ((acc | 0) + (SP[0] | 0)) | 0;
      }
      t[2] += performance.now() - t0;
      t0 = performance.now();
      for (let k = 0; k < n; k++) acc = ((acc | 0) + (nodeParent(d[k] | 0) | 0)) | 0;
      t[3] += performance.now() - t0;
      // expressions only
      t0 = performance.now();
      const ne = hir.nExprs | 0;
      for (let e = 0; e < ne; e++) {
        exprSpan(e);
        acc = ((acc | 0) + (SP[1] | 0)) | 0;
      }
      t[4] += performance.now() - t0;
      nexprs += ne;
      t0 = performance.now();
      for (let e = 0; e < ne; e++) {
        acc = ((acc | 0) + (exprParent(e) | 0)) | 0;
        if (exprTag(e) === EXPR_CALL) acc = ((acc | 0) + (exprChain(e) | 0)) | 0;
      }
      t[5] += performance.now() - t0;
      t0 = performance.now();
      const ns = hir.nStmts | 0;
      for (let s = 0; s < ns; s++) {
        stmtSpan(s);
        acc = ((acc | 0) + (stmtParent(s) | 0)) | 0;
      }
      t[6] += performance.now() - t0;
      nstmts += ns;
      t0 = performance.now();
      { let e = 0; while (e < ne) { acc = ((acc | 0) + (exprTag(e) | 0)) | 0; e = ((e | 0) + 1) | 0; } }
      t[7] += performance.now() - t0;
      t0 = performance.now();
      { let e = 0; while (e < ne) { acc = ((acc | 0) + (hir.exprTag[e] | 0)) | 0; e = ((e | 0) + 1) | 0; } }
      t[8] += performance.now() - t0;
      t0 = performance.now();
      { let e = 0; while (e < ne) { acc = ((acc | 0) + (exprParent(e) | 0)) | 0; e = ((e | 0) + 1) | 0; } }
      t[9] += performance.now() - t0;
      sink = (sink + acc) | 0;
    }
    for (let k = 0; k < 10; k++) if (t[k] < best[k]) best[k] = t[k];
  }
  console.log("nodes", nodes, "exprs", nexprs, "stmts", nstmts, "(sink", sink, ")");
  console.log("fileBegin     ", f1(best[0]), "ms");
  console.log("children      ", f1(best[1]), "ms", f1((best[1] * 1e6) / nodes), "ns/node");
  console.log("nodeSpan      ", f1(best[2]), "ms", f1((best[2] * 1e6) / nodes), "ns/node");
  console.log("nodeParent    ", f1(best[3]), "ms", f1((best[3] * 1e6) / nodes), "ns/node");
  console.log("exprSpan      ", f1(best[4]), "ms", f1((best[4] * 1e6) / nexprs), "ns/expr");
  console.log("exprParent+tag", f1(best[5]), "ms", f1((best[5] * 1e6) / nexprs), "ns/expr");
  console.log("stmt span+par ", f1(best[6]), "ms", f1((best[6] * 1e6) / nstmts), "ns/stmt");
  console.log("exprTag only   ", f1(best[7]), "ms", f1((best[7] * 1e6) / nexprs), "ns/expr");
  console.log("raw hir.exprTag", f1(best[8]), "ms", f1((best[8] * 1e6) / nexprs), "ns/expr");
  console.log("exprParent only", f1(best[9]), "ms", f1((best[9] * 1e6) / nexprs), "ns/expr");
  void N_EXPR;
  void N_STMT;
}

main();
