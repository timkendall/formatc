// (tools/parser-c copy of parse-vscode.ts that goes through parseScript: parse, recover, refusal checks, fileBegin.)
// Parses every .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs file of bench/vscode with the sema parser (a module first, and a script if that
// is refused, as the formatter's driver does: `kinds(path)` in lint/driver/fmt/mod.rs) and reports accept/refuse counts and MB/s.
//
//   node tools/parse-vscode.ts [--limit N] [--reps R] [--list /tmp/vscode-files.txt] [--root bench/vscode]
//                              [--bun /tmp/pa/bun_errors.txt] [--out refused.txt] [--only substring]
//   scriptc build tools/parse-vscode.ts -o /tmp/parse-vscode && /tmp/parse-vscode --reps 5
//
// `--bun FILE`: the paths `bun fmt --check` cannot check (one per line); the output lists the disagreements.
import * as fs from "node:fs";
import { parseScript, scriptError, PS_OK } from "../../src/sema/parser/script.ts";
import { hir } from "../../src/sema/hir.ts";

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

/** `kinds(path)` of the driver: 1 = module only, 2 = script only, 3 = module then script. */
function kindsOf(p: string): number {
  if (p.endsWith(".mjs") || p.endsWith(".mts")) return 1;
  if (p.endsWith(".cjs") || p.endsWith(".cts")) return 2;
  return 3;
}

function main(): void {
  const root = arg("--root", "bench/vscode");
  const listPath = arg("--list", "/tmp/vscode-files.txt");
  const limit = parseInt(arg("--limit", "0"), 10);
  const reps = parseInt(arg("--reps", "1"), 10);
  const only = arg("--only", "");
  const bunPath = arg("--bun", "");
  // --flow flow|babel-flow: every file is parsed as that parser reads it.
  const flowMode = arg("--flow", "");
  const outPath = arg("--out", "");
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

  const refusedIdx = new Int32Array(paths.length);
  const refusedWhy = new Int32Array(paths.length);
  const refusedAt = new Int32Array(paths.length);
  let nRefused = 0;
  let best = 1e18;
  let accepted = 0;
  for (let rep = 0; rep < reps; rep++) {
    const t0 = performance.now();
    nRefused = 0;
    accepted = 0;
    for (let i = 0; i < paths.length; i++) {
      const s = offs[i] | 0;
      const e = offs[i + 1] | 0;
      const src = arena.subarray(s, e);
      const p = paths[i];
      const base = p.slice(p.lastIndexOf("/") + 1);
      const r = parseScript(src, e - s, base, base, flowMode !== "", flowMode === "babel-flow", flowMode !== "");
      if (r === PS_OK) {
        accepted++;
      } else {
        refusedIdx[nRefused] = i;
        refusedWhy[nRefused] = r;
        refusedAt[nRefused] = scriptError.at;
        nRefused++;
      }
    }
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
    console.log("rep", rep, dt.toFixed(1), "ms", (total / 1e6 / (dt / 1000)).toFixed(0), "MB/s");
  }
  console.log("best", best.toFixed(1), "ms", (total / 1e6 / (best / 1000)).toFixed(0), "MB/s");
  console.log("accepted", accepted, "refused", nRefused);
  const reasons = new Map<string, number>();
  let outText = "";
  for (let k = 0; k < nRefused; k++) {
    const why = "refused";
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
    outText += paths[refusedIdx[k]] + "\t" + why + "\t" + refusedAt[k] + "\n";
  }
  for (const [k, v] of reasons) console.log("  refusal", k, v);
  if (outPath !== "") fs.writeFileSync(outPath, outText);
  if (bunPath !== "") {
    const bun = new Set(fs.readFileSync(bunPath, "utf8").split("\n").filter((l) => l.length > 0 && isTarget(l)));
    const ours = new Set<string>();
    for (let k = 0; k < nRefused; k++) ours.add(paths[refusedIdx[k]]);
    let onlyOurs = 0;
    let onlyBun = 0;
    for (const o of ours) {
      if (!bun.has(o)) {
        onlyOurs++;
        if (onlyOurs <= 40) console.log("  REFUSED BY US ONLY:", o, outText.split("\n").find((l) => l.startsWith(o + "\t"))?.slice(o.length));
      }
    }
    for (const b of bun) {
      if (!ours.has(b) && (only === "" || b.indexOf(only) >= 0)) {
        onlyBun++;
        if (onlyBun <= 40) console.log("  REFUSED BY BUN ONLY:", b);
      }
    }
    console.log("agreement: refused by us only", onlyOurs, ", by bun only", onlyBun, ", both", ours.size - onlyOurs);
  }
  void hir;
}

main();
