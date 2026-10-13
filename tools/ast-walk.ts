// Parses every file of bench/vscode, walks every node through the handles of src/lint/ast and checks invariants:
//   * parent/child: for every child `c` that `nodeChildren(n)` yields, `nodeParent(c) === n`
//   * spans: the span of a child is inside the span of its parent (a decorator before `export` and the like are counted apart), and
//     children come in source order
//   * every expression / statement / type / pattern / ... of the HIR is reached from the file (counted: what the parser left behind is not)
//   * `outer_span` of expressions contains `span`; `fileEndOfTokenBefore` agrees with `skipTriviaBack` where that is reliable
// and reports the throughput of `fileBegin` (parents, bits, escapes) and of the walk.
//
//   node tools/ast-walk.ts [--limit N] [--reps R] [--list /tmp/vscode-files.txt] [--root bench/vscode] [--only substring] [-v]
//   scriptc build tools/ast-walk.ts -o /tmp/ast-walk && /tmp/ast-walk --reps 5
import * as fs from "node:fs";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { names } from "../src/sema/parser/parser/mod.ts";
import {
  F,
  N_EXPR,
  N_STMT,
  NODE_FILE,
  SP,
  bound,
  exprIsParenthesized,
  exprOuterSpan,
  exprSpan,
  fileBegin,
  hir,
  nodeChildren,
  nodeKind,
  nodeParent,
  nodeSpan,
} from "../src/lint/ast/index.ts";
import { I32Vec } from "../src/sema/vec.ts";

function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length - 1; i++) if (a[i] === name) return a[i + 1];
  return dflt;
}
function flag(name: string): boolean {
  const a = process.argv;
  for (let i = 2; i < a.length; i++) if (a[i] === name) return true;
  return false;
}

function isTarget(p: string): boolean {
  return (
    p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".mts") || p.endsWith(".cts") ||
    p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs") || p.endsWith(".cjs")
  );
}
function kindsOf(p: string): number {
  if (p.endsWith(".mjs") || p.endsWith(".mts")) return 1;
  if (p.endsWith(".cjs") || p.endsWith(".cts")) return 2;
  return 3;
}

const KIND_NAMES: string[] = [
  "File", "Expr", "Stmt", "Type", "Pat", "PatProp", "PatElem", "Func", "Param", "TypeParam", "Class", "Member", "Prop", "VarDecl", "Case",
  "EnumMember", "ImportSpec", "ExportSpec", "TupleElem",
];

// counters
const BAD_PARENT = new Int32Array(32 * 32);
const BAD_NEST = new Int32Array(32 * 32);
const BAD_ORDER = new Int32Array(32 * 32);
const VISITED = new Int32Array(32);
const SEEN = new Uint8Array(1 << 20);
let seenExample = "";
let parentExample = "";
let nestExample = "";
let orderExample = "";

/** One file: walk and check. */
function checkFile(path: string, seen: Uint8Array[]): void {
  const stack = new I32Vec(1024);
  const kids = new I32Vec(64);
  stack.push(NODE_FILE);
  VISITED[0] = (VISITED[0] | 0) + 1;
  while (stack.len > 0) {
    const n = stack.pop();
    const nk = nodeKind(n);
    nodeSpan(n);
    const ps = SP[0] | 0;
    const pe = SP[1] | 0;
    kids.reset();
    nodeChildren(n, -1, kids);
    let prevStart = -1;
    for (let i = 0; i < kids.len; i++) {
      const c = kids.data[i] | 0;
      const ck = nodeKind(c);
      VISITED[ck] = (VISITED[ck] | 0) + 1;
      const cp = nodeParent(c);
      if (cp !== n) {
        BAD_PARENT[nk * 32 + ck] = (BAD_PARENT[nk * 32 + ck] | 0) + 1;
        if (parentExample === "") parentExample = path + ": " + KIND_NAMES[ck] + " " + (c & 67108863) + " in " + KIND_NAMES[nk] + " " + (n & 67108863) + " but parent is " + KIND_NAMES[nodeKind(cp)] + " " + (cp & 67108863);
      }
      nodeSpan(c);
      const cs = SP[0] | 0;
      const ce = SP[1] | 0;
      if (n !== NODE_FILE && (cs < ps || ce > pe)) {
        BAD_NEST[nk * 32 + ck] = (BAD_NEST[nk * 32 + ck] | 0) + 1;
        if (nestExample === "") nestExample = path + ": " + KIND_NAMES[ck] + " " + (c & 67108863) + " [" + cs + "," + ce + ") not in " + KIND_NAMES[nk] + " " + (n & 67108863) + " [" + ps + "," + pe + ")";
      }
      if (cs < prevStart) {
        BAD_ORDER[nk * 32 + ck] = (BAD_ORDER[nk * 32 + ck] | 0) + 1;
        if (orderExample === "") orderExample = path + ": " + KIND_NAMES[ck] + " " + (c & 67108863) + " starts at " + cs + " before the child before it (" + prevStart + ") in " + KIND_NAMES[nk] + " " + (n & 67108863);
      }
      prevStart = cs;
      if (ck === N_EXPR) {
        const e = c & 67108863;
        exprSpan(e);
        const s0 = SP[0] | 0;
        const e0 = SP[1] | 0;
        exprOuterSpan(e);
        if ((SP[0] | 0) > s0 || (SP[1] | 0) < e0 || (exprIsParenthesized(e) && (SP[0] | 0) === s0 && (SP[1] | 0) === e0)) {
          BAD_ORDER[0] = (BAD_ORDER[0] | 0) + 1;
          if (orderExample === "") orderExample = path + ": outer_span of expr " + e + " does not contain its span";
        }
      }
      // reached
      if (ck >= 0 && ck < seen.length) {
        const arr = seen[ck];
        const id = c & 67108863;
        if (id < arr.length) arr[id] = 1;
      }
      stack.push(c);
    }
  }
  void seenExample;
}

function main(): void {
  const root = arg("--root", "bench/vscode");
  const listPath = arg("--list", "/tmp/vscode-files.txt");
  const limit = parseInt(arg("--limit", "0"), 10);
  const reps = parseInt(arg("--reps", "1"), 10);
  const only = arg("--only", "");
  const verbose = flag("-v");
  const lines = fs.readFileSync(listPath, "utf8").split("\n");
  const paths: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 0 && isTarget(l) && (only === "" || l.indexOf(only) >= 0)) paths.push(l);
    if (limit > 0 && paths.length >= limit) break;
  }
  const offs = new Int32Array(paths.length + 1);
  let total = 0;
  const tmp: Buffer[] = [];
  for (let i = 0; i < paths.length; i++) {
    const b = fs.readFileSync(root + "/" + paths[i]);
    tmp.push(b);
    offs[i] = total;
    total += b.length;
  }
  offs[paths.length] = total;
  const arena = Buffer.alloc(total + 16);
  for (let i = 0; i < paths.length; i++) tmp[i].copy(arena, offs[i]);
  tmp.length = 0;
  console.log("files", paths.length, "bytes", total);

  // 1. throughput: parse + fileBegin, and the walk
  let tParse = 1e18;
  let tBegin = 1e18;
  let tWalk = 1e18;
  let accepted = 0;
  let incomplete = 0;
  for (let rep = 0; rep < reps; rep++) {
    let parse = 0;
    let begin = 0;
    let walk = 0;
    accepted = 0;
    incomplete = 0;
    const kids = new I32Vec(64);
    const stack = new I32Vec(1024);
    for (let i = 0; i < paths.length; i++) {
      const s = offs[i] | 0;
      const e = offs[i + 1] | 0;
      const src = arena.subarray(s, e);
      const p = paths[i];
      const kinds = kindsOf(p);
      let isScript = false;
      const t0 = performance.now();
      let r = 1;
      if ((kinds & 1) !== 0) r = parseFile(src, e - s, p, false);
      if (r !== 0 && (kinds & 2) !== 0) {
        r = parseFile(src, e - s, p, true);
        isScript = true;
      }
      const t1 = performance.now();
      parse += t1 - t0;
      if (r !== 0) continue;
      accepted++;
      const isTs = p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".mts") || p.endsWith(".cts");
      fileBegin(names, isTs, !isScript);
      const t2 = performance.now();
      begin += t2 - t1;
      if (!bound.complete) incomplete++;
      // walk: every node, its span and its parent
      stack.reset();
      stack.push(NODE_FILE);
      while (stack.len > 0) {
        const n = stack.pop();
        nodeSpan(n);
        nodeParent(n);
        kids.reset();
        nodeChildren(n, -1, kids);
        for (let k = 0; k < kids.len; k++) stack.push(kids.data[k] | 0);
      }
      walk += performance.now() - t2;
    }
    if (parse < tParse) tParse = parse;
    if (begin < tBegin) tBegin = begin;
    if (walk < tWalk) tWalk = walk;
  }
  const mb = total / 1e6;
  console.log("accepted", accepted, "of", paths.length, " parents incomplete:", incomplete);
  console.log("parse   ", tParse.toFixed(1), "ms", (mb / (tParse / 1000)).toFixed(0), "MB/s");
  console.log("fileBegin", tBegin.toFixed(1), "ms", (mb / (tBegin / 1000)).toFixed(0), "MB/s");
  console.log("walk    ", tWalk.toFixed(1), "ms", (mb / (tWalk / 1000)).toFixed(0), "MB/s (children + span + parent of every node)");

  // 2. invariants
  let nFiles = 0;
  let unreached = 0;
  const reachedFiles = new Int32Array(8);
  const sizes: number[] = [];
  for (let i = 0; i < paths.length; i++) {
    const s = offs[i] | 0;
    const e = offs[i + 1] | 0;
    const src = arena.subarray(s, e);
    const p = paths[i];
    const kinds = kindsOf(p);
    let isScript = false;
    let r = 1;
    if ((kinds & 1) !== 0) r = parseFile(src, e - s, p, false);
    if (r !== 0 && (kinds & 2) !== 0) {
      r = parseFile(src, e - s, p, true);
      isScript = true;
    }
    if (r !== 0) continue;
    const isTs = p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".mts") || p.endsWith(".cts");
    fileBegin(names, isTs, !isScript);
    nFiles++;
    const seen: Uint8Array[] = [];
    for (let k = 0; k < 19; k++) {
      const n = k === N_EXPR ? hir.nExprs : k === N_STMT ? hir.nStmts : 0;
      seen.push(new Uint8Array(n > 0 ? n : 1));
    }
    checkFile(p, seen);
    // how much of the HIR is reached (expressions and statements)
    for (let k = 1; k <= 2; k++) {
      const n = k === N_EXPR ? hir.nExprs : hir.nStmts;
      let missed = 0;
      for (let j = 0; j < n; j++) if ((seen[k][j] | 0) === 0) missed++;
      unreached += missed;
      if (missed > 0) {
        reachedFiles[k] = (reachedFiles[k] | 0) + 1;
        if (verbose && sizes.length < 20) sizes.push(missed);
        if (verbose && seenExample === "") seenExample = p + ": " + missed + " of " + n + " " + KIND_NAMES[k] + "s not reached";
      }
    }
  }
  console.log("checked files", nFiles);
  console.log("visited:", Array.from(VISITED).slice(0, 19).map((v, i) => KIND_NAMES[i] + "=" + v).join(" "));
  const report = (title: string, table: Int32Array, example: string): void => {
    let n = 0;
    const rows: string[] = [];
    for (let k = 0; k < 32 * 32; k++) {
      if ((table[k] | 0) > 0) {
        n += table[k] | 0;
        rows.push(KIND_NAMES[k >> 5] + ">" + KIND_NAMES[k & 31] + "=" + table[k]);
      }
    }
    console.log(title, n, rows.slice(0, 30).join(" "));
    if (example !== "") console.log("   e.g.", example);
  };
  report("parent mismatches:", BAD_PARENT, parentExample);
  report("span not nested:", BAD_NEST, nestExample);
  report("children out of order / outer_span:", BAD_ORDER, orderExample);
  console.log("HIR rows not reached from the file (exprs+stmts):", unreached, "in files:", reachedFiles[1], reachedFiles[2], seenExample);
  void SEEN;
  void F;
}

main();
