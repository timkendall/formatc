// Mutation test of accept/refuse against `bun fmt`: writes mutants of small vscode files to a directory (node tools/parse-mutants.ts gen
// DIR N SEED), asks bun which it accepts (bun /tmp/pa/oracle-dir.ts DIR OUT.json), and compares with the sema parser
// (node tools/parse-mutants.ts cmp DIR OUT.json).
import * as fs from "node:fs";
import ts from "typescript";
import { parseFile } from "../src/sema/parser/parser/run.ts";
import { lx } from "../src/sema/parser/parser/mod.ts";
import { refusalName } from "../src/sema/parser/lib.ts";

const mode = process.argv[2];
const dir = process.argv[3];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PUNCT = ["(", ")", "{", "}", "[", "]", ",", ";", ":", "<", ">", "=", "?", ".", "@", "=>", "...", "!", "*", "|", "&", "`", "'", "/", "#", "+", "-"];

if (mode === "gen") {
  const n = parseInt(process.argv[4], 10);
  const rand = rng(parseInt(process.argv[5] ?? "1", 10));
  const root = "bench/vscode";
  const files = fs
    .readFileSync("/tmp/vscode-files.txt", "utf8")
    .split("\n")
    .filter((l) => /\.(ts|tsx|js|mts|mjs)$/.test(l));
  fs.mkdirSync(dir, { recursive: true });
  let made = 0;
  let tries = 0;
  while (made < n && tries < n * 50) {
    tries++;
    const f = files[Math.floor(rand() * files.length)];
    let buf: Buffer;
    try {
      buf = fs.readFileSync(root + "/" + f);
    } catch {
      continue;
    }
    if (buf.length > 4000 || buf.length < 50) continue;
    const text = buf.toString("utf8");
    const ext = f.slice(f.lastIndexOf("."));
    const sc = ts.createScanner(ts.ScriptTarget.Latest, true, ext === ".tsx" ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
    const toks: number[] = [];
    while (sc.scan() !== ts.SyntaxKind.EndOfFileToken) {
      toks.push(sc.getTokenStart(), sc.getTokenEnd());
      if (toks.length > 20000) break;
    }
    const nt = toks.length / 2;
    if (nt < 10) continue;
    let out = text;
    const nmut = 1 + Math.floor(rand() * 2);
    for (let m = 0; m < nmut; m++) {
      const i = Math.floor(rand() * nt);
      const s = toks[i * 2];
      const e = toks[i * 2 + 1];
      const kind = Math.floor(rand() * 4);
      // positions refer to `text`; apply to `out` only for the first mutation (offsets shift later): recompute by search
      if (m > 0) break;
      if (kind === 0) out = text.slice(0, s) + text.slice(e);
      else if (kind === 1) out = text.slice(0, e) + text.slice(s, e) + text.slice(e);
      else if (kind === 2) out = text.slice(0, s) + PUNCT[Math.floor(rand() * PUNCT.length)] + text.slice(e);
      else {
        const j = Math.floor(rand() * nt);
        out = text.slice(0, s) + text.slice(toks[j * 2], toks[j * 2 + 1]) + text.slice(e);
      }
    }
    fs.writeFileSync(`${dir}/m${made}${ext}`, out);
    made++;
  }
  console.log("generated", made);
} else {
  const oracle: Record<string, number> = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
  let agree = 0;
  let bothRefuse = 0;
  const usOnly: string[] = [];
  const bunOnly: string[] = [];
  for (const f of Object.keys(oracle).sort()) {
    const buf = fs.readFileSync(dir + "/" + f);
    const src = new Uint8Array(buf.length + 16);
    src.set(buf);
    const ext = f.slice(f.lastIndexOf("."));
    const path = "stdin" + ext;
    const kinds = ext === ".mjs" || ext === ".mts" ? 1 : ext === ".cjs" || ext === ".cts" ? 2 : 3;
    let r = 1;
    if ((kinds & 1) !== 0) r = parseFile(src, buf.length, path, false);
    if (r !== 0 && (kinds & 2) !== 0) r = parseFile(src, buf.length, path, true);
    const bunOk = oracle[f] === 0;
    if (bunOk === (r === 0)) {
      agree++;
      if (!bunOk) bothRefuse++;
    } else if (r === 0) bunOnly.push(f);
    else usOnly.push(f + " " + refusalName(r) + "@" + lx.refusedAt);
  }
  console.log("mutants", Object.keys(oracle).length, "agree", agree, "(both refuse", bothRefuse + ")", "refused by us only", usOnly.length, "refused by bun only", bunOnly.length);
  for (const s of usOnly.slice(0, 40)) console.log("  US ONLY:", s);
  console.log("  bun-only first:", bunOnly.slice(0, 10).join(" "));
}
