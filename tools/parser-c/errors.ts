// Differential harness for the parse/refuse part: what `bun fmt --stdin-filepath=<name>` says of each file (from tools/parser-c/oracle.ts) against
// `parseScript` (src/sema/parser/script.ts).
//   bun tools/parser-c/oracle.ts <dir> /tmp/oracle.json           (once)
//   node tools/parser-c/errors.ts <dir> /tmp/oracle.json [--show N] [--filter text] [--flow] [--only-accept]
// Prints: accept/reject agreement and, for the files both reject, whether message and line:col are equal.
import * as fs from "node:fs";
import { parseScript, scriptError, scriptText, goesToBabel, PS_OK } from "../../src/sema/parser/script.ts";
import { problemAt } from "../../src/driver/problem.ts";
import { debug, lx } from "../../src/sema/parser/parser/mod.ts";
import { goesToFlow } from "../../src/lint/linter/syntax/mod.ts";

const args = process.argv.slice(2);
const dir = args[0];
const oracle: Record<string, [number, string, number, number]> = JSON.parse(fs.readFileSync(args[1], "utf8"));
function flag(name: string, dflt: string): string {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
const show = parseInt(flag("--show", "30"), 10);
const filter = flag("--filter", "");
const parserOpt = flag("--parser", "");
const exclude = flag("--exclude", "");

// --sites: where the recovering parser gives up (R_UNSUPPORTED), with the call chain (the first frames outside mod.ts).
const sites: Record<string, number> = {};
let lastSite = "";
if (args.includes("--sites")) {
  debug.on = true;
  debug.fire = () => {
    const st = new Error().stack as string;
    const lines = st.split("\n").slice(2, 8).map((l) => l.trim().replace(/^at /, "").replace(/\(?file:\/\/\/.*\/src\//, "(").replace(/\)$/, ""));
    lastSite = lines.filter((l) => !l.includes("mod.ts")).slice(0, 3).join(" < ");
  };
}
void lx;
let total = 0;
let agree = 0;
let acceptDisagree = 0;
let bothReject = 0;
let sameMessage = 0;
let samePlace = 0;
const shownAccept: string[] = [];
const shownMessage: string[] = [];
const shownPlace: string[] = [];
const byMessage: Record<string, number> = {};

for (const f of Object.keys(oracle).sort()) {
  if (filter !== "" && !f.includes(filter)) continue;
  if (exclude !== "" && f.includes(exclude)) continue;
  total++;
  const buf = fs.readFileSync(dir + "/" + f);
  const len = buf.length;
  const src = new Uint8Array(len + 16);
  src.set(buf);
  const base = f.slice(f.lastIndexOf("/") + 1);
  const isFlow = parserOpt === "flow" || parserOpt === "babel-flow" || ((parserOpt === "" || parserOpt === "babel") && goesToFlow(src, len, base));
  const tolerated = parserOpt === "flow" || parserOpt === "babel-flow" || parserOpt === "typescript" || parserOpt === "babel-ts";
  lastSite = "";
  const status = parseScript(src, len, base, base, isFlow, goesToBabel(parserOpt, base), tolerated);
  if (args.includes("--sites") && lastSite !== "" ) {
    sites[lastSite] = (sites[lastSite] || 0) + 1;
    lastSite = "";
  }
  const [code, msg, line, col] = oracle[f];
  const bunOk = code === 0;
  const ourOk = status === PS_OK;
  if (bunOk !== ourOk) {
    acceptDisagree++;
    if (shownAccept.length < show) shownAccept.push((ourOk ? "US ACCEPT " : "US REJECT ") + f + "   bun: " + (bunOk ? "ok" : msg + " " + line + ":" + col) + "   ours: " + (ourOk ? "ok" : scriptError.message + " @" + scriptError.at));
    continue;
  }
  agree++;
  if (bunOk) continue;
  bothReject++;
  let ourLine = 0;
  let ourCol = 0;
  if (scriptError.at >= 0) {
    // The offsets of the parser count a byte order mark; `problemAt` takes them without it (NOTE for the driver: for a script they include it).
    // Offsets are in the text that was parsed: for `babel-flow` the text that `uncommented` made.
    const text = scriptText.src;
    const tlen = scriptText.len;
    const bom = tlen >= 3 && text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf ? 3 : 0;
    const pr = problemAt(text, tlen, scriptError.message, Math.max(0, scriptError.at - bom), true);
    ourLine = pr.line;
    ourCol = pr.column;
  }
  const messageOk = scriptError.message === msg;
  const placeOk = ourLine === line && ourCol === col;
  if (messageOk) sameMessage++;
  else {
    byMessage[msg + "  =>  " + scriptError.message] = (byMessage[msg + "  =>  " + scriptError.message] || 0) + 1;
    if (shownMessage.length < show) shownMessage.push(f + "   bun: " + msg + " " + line + ":" + col + "   ours: " + scriptError.message + " " + ourLine + ":" + ourCol);
  }
  if (placeOk) samePlace++;
  else if (messageOk && shownPlace.length < show) shownPlace.push(f + "   " + msg + "   bun " + line + ":" + col + "   ours " + ourLine + ":" + ourCol);
}
console.log("files", total, "accept/reject agree", agree, "disagree", acceptDisagree, "| both reject", bothReject, "same message", sameMessage, "same line:col", samePlace);
for (const s of shownAccept) console.log("  ACCEPT-DIFF:", s);
for (const s of shownMessage) console.log("  MESSAGE-DIFF:", s);
for (const s of shownPlace) console.log("  PLACE-DIFF:", s);
if (args.includes("--sites")) {
  for (const [k, v] of Object.entries(sites).sort((a, b) => b[1] - a[1]).slice(0, 80)) console.log(String(v).padStart(5), k);
}
if (args.includes("--summary")) {
  const top = Object.entries(byMessage).sort((a, b) => b[1] - a[1]).slice(0, 60);
  for (const [k, v] of top) console.log(String(v).padStart(5), k);
}
