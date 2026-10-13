// Exhaustive comparison of the tables and the small helpers of the TS port with the Rust ones (tools/md/rust-oracle):
// case folding, Unicode punctuation / white space / alphanumerics, entities, UTF-8 decoding.
//   node tools/md/diff-tables.ts
import cp from "node:child_process";
import path from "node:path";
import {
  UTF8,
  caseFold,
  FOLD,
  decodeEntityToUtf8,
  decodeUtf8,
  decodeUtf8Backward,
  findEntity,
  isUnicodePunctuation,
  isUnicodeWhitespace,
} from "../../src/md/lib.ts";
import { isUnicodeAlphanumeric } from "../../src/md/helpers.ts";
import { ENTITY_NAMES } from "../../src/md/tables.ts";
import { rng } from "./corpus.ts";

const oracle = path.join(import.meta.dirname, "rust-oracle/target/release/mdoracle");
function run(kind: string, input: Buffer | string): string {
  const r = cp.spawnSync(oracle, ["--table=" + kind], { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`oracle ${kind}: ${r.stderr}`);
  return r.stdout.toString("latin1");
}

let failures = 0;
function report(what: string, n: number, bad: number, first: string[]): void {
  console.log(`${what}: ${n} checked, ${bad} differ${first.length ? "\n  " + first.join("\n  ") : ""}`);
  failures += bad;
}

// ---- case folding: every codepoint ----
{
  const lines = run("fold", "").split("\n");
  let bad = 0;
  const first: string[] = [];
  let n = 0;
  for (let c = 0; c <= 0x10ffff; c++) {
    caseFold(c);
    const mine = `${c.toString(16)} ${FOLD.n} ${FOLD.c0.toString(16)} ${FOLD.c1.toString(16)} ${FOLD.c2.toString(16)}`;
    n++;
    if (mine !== lines[c]) {
      bad++;
      if (first.length < 5) first.push(`${mine} != ${lines[c]}`);
    }
  }
  report("case_fold", n, bad, first);
}

// ---- punctuation, white space, alphanumerics: every codepoint ----
{
  const lines = run("punct", "").split("\n");
  let bad = 0;
  const first: string[] = [];
  let n = 0;
  for (let c = 0; c <= 0x10ffff; c++) {
    const mine = `${c.toString(16)} ${+isUnicodePunctuation(c)} ${+isUnicodeWhitespace(c)} ${+isUnicodeAlphanumeric(c)}`;
    n++;
    if (mine !== lines[c]) {
      bad++;
      if (first.length < 5) first.push(`${mine} != ${lines[c]}`);
    }
  }
  report("punctuation/whitespace/alphanumeric", n, bad, first);
}

// ---- entities ----
{
  const names = ENTITY_NAMES.split(";").slice(0, -1);
  const cases: string[] = [];
  for (const nm of names) {
    cases.push(`&${nm};`, `&${nm}`, `&${nm.toLowerCase()};`, `&${nm}x;`, `&${nm.slice(0, -1)};`);
  }
  const rand = rng(7);
  for (let i = 0; i < 20000; i++) {
    const v = Math.floor(rand() * 0x120000);
    const k = Math.floor(rand() * 6);
    cases.push(k === 0 ? `&#${v};` : k === 1 ? `&#x${v.toString(16)};` : k === 2 ? `&#X${v.toString(16).toUpperCase()};` : k === 3 ? `&#${v}` : k === 4 ? `&#x${v.toString(16)}zz;` : `&#${"9".repeat(1 + Math.floor(rand() * 9))};`);
  }
  cases.push("&", "&;", "&#;", "&#x;", "&a;", "&#0;", "&#xD800;", "&#x110000;", "&#12345678;", "&#1234567;");
  const lines = run("entity", cases.join("\n")).split("\n");
  let bad = 0;
  const first: string[] = [];
  const out = new Uint8Array(8);
  cases.forEach((c, i) => {
    const b = Buffer.from(c);
    const n = decodeEntityToUtf8(b, 0, b.length, out);
    const mineDecoded = n < 0 ? "-" : Buffer.from(out.subarray(0, n)).toString("hex");
    const e = findEntity(b, 0, b.length, 0);
    const mine = mineDecoded + "|" + (e < 0 ? "-" : e);
    const theirs = lines[2 * i] + "|" + lines[2 * i + 1];
    if (mine !== theirs) {
      bad++;
      if (first.length < 5) first.push(`${JSON.stringify(c)}: ${mine} != ${theirs}`);
    }
  });
  report("entities", cases.length, bad, first);
}

// ---- UTF-8 decoding of random bytes ----
{
  const rand = rng(9);
  const recs: Buffer[] = [];
  for (let i = 0; i < 20000; i++) {
    const len = 1 + Math.floor(rand() * 12);
    const b = Buffer.alloc(len);
    for (let k = 0; k < len; k++) {
      const r = rand();
      b[k] = r < 0.3 ? Math.floor(rand() * 128) : r < 0.5 ? 0x80 + Math.floor(rand() * 64) : r < 0.9 ? 0xc0 + Math.floor(rand() * 64) : Math.floor(rand() * 256);
    }
    recs.push(b);
  }
  const input = Buffer.concat(recs.flatMap((r) => { const l = Buffer.alloc(4); l.writeUInt32LE(r.length); return [l, r]; }));
  const lines = run("utf8", input).split("\n");
  let at = 0;
  let bad = 0;
  let n = 0;
  const first: string[] = [];
  for (const r of recs) {
    for (let off = 0; off <= r.length + 1; off++) {
      const a = decodeUtf8(r, 0, r.length, off);
      const al = UTF8.len;
      const b = decodeUtf8Backward(r, 0, r.length, off);
      const bl = UTF8.len;
      const mine = `${a.toString(16)} ${al} ${b.toString(16)} ${bl}`;
      n++;
      if (mine !== lines[at]) {
        bad++;
        if (first.length < 5) first.push(`${r.toString("hex")}@${off}: ${mine} != ${lines[at]}`);
      }
      at++;
    }
    at++; // --
  }
  report("utf8", n, bad, first);
}

process.exit(failures === 0 ? 0 : 1);
