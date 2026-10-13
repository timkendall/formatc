// Lexes every .ts/.tsx/.js/.mts/.mjs/.cjs file of bench/vscode to EOF with the sema lexer and reports throughput.
//
//   node tools/lex-vscode.ts [--limit N] [--reps R] [--list /tmp/vscode-files.txt] [--root bench/vscode] [--xcheck]
//   scriptc build tools/lex-vscode.ts -o /tmp/lex-vscode && /tmp/lex-vscode --reps 5
//
// No parser exists yet, so the driver makes the decisions the parser would make with the usual heuristics: a `/` or `/=` after
// a token that cannot end an expression is a regex (rescanSlash), a `}` that closes a template substitution continues the
// template (rescanTemplateContinuation); in .tsx/.jsx files `<` where an expression can start opens a JSX element (a small
// state machine over scanJsxIdentifier / scanJsxAttributeValue / nextJsxChild). `--xcheck` compares every token boundary with
// TypeScript's own scanner (node_modules/typescript) under the same decisions.
import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { Driver } from "../lexdriver.ts";
import { refusalName } from "../../src/sema/parser/lib.ts";

// ───────────────────────── corpus ─────────────────────────

function arg(name: string, dflt: string): string {
  const a = process.argv;
  for (let i = 2; i < a.length - 1; i++) {
    if (a[i] === name) return a[i + 1];
  }
  return dflt;
}

function isTarget(p: string): boolean {
  return (
    p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js") || p.endsWith(".mts") || p.endsWith(".mjs") || p.endsWith(".cjs")
  );
}

function main(): void {
  const root = arg("--root", "bench/vscode");
  const listPath = arg("--list", "/tmp/vscode-files.txt");
  const limit = parseInt(arg("--limit", "0"), 10);
  const reps = parseInt(arg("--reps", "3"), 10);
  const lines = fs.readFileSync(listPath, "utf8").split("\n");
  const paths: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 0 && isTarget(l)) paths.push(l);
    if (limit > 0 && paths.length >= limit) break;
  }
  // Read everything into one arena: the timed loop is pure lexing.
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

  const d = new Driver();
  let best = 1e18;
  let tokens = 0;
  let refused = 0;
  let comments = 0;
  let atoms = 0;
  const reasons = new Int32Array(32);
  for (let rep = 0; rep < reps; rep++) {
    const t0 = performance.now();
    tokens = 0;
    refused = 0;
    comments = 0;
    atoms = 0;
    reasons.fill(0);
    for (let i = 0; i < paths.length; i++) {
      const s = offs[i] | 0;
      const e = offs[i + 1] | 0;
      const src = arena.subarray(s, e);
      const p = paths[i];
      const jsx = p.endsWith("x");
      tokens += d.run(src, e - s, jsx);
      if (d.lx.refusal !== 0) {
        refused++;
        reasons[d.lx.refusal] = (reasons[d.lx.refusal] | 0) + 1;
      }
      comments += d.lx.comments.len >> 1;
      atoms += d.names.count;
    }
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
    console.log("rep", rep, dt.toFixed(1), "ms", (total / 1e6 / (dt / 1000)).toFixed(0), "MB/s");
  }
  console.log("best", best.toFixed(1), "ms", (total / 1e6 / (best / 1000)).toFixed(0), "MB/s");
  console.log("tokens", tokens, "comments", comments, "atoms(total, incl. seeded)", atoms, "refused files", refused);
  for (let r = 1; r < 32; r++) {
    if ((reasons[r] | 0) !== 0) console.log("  refusal", refusalName(r), reasons[r]);
  }
}

main();
