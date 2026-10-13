// Formats every JSON / JSONC file (and the TOML files with `--toml`) of bench/vscode and compares byte for byte with
// bench/vscode-fmt (what `bun fmt` made of them). `node tools/json/compare.ts [--toml] [--show=N] [--filter=substr]`.
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import * as kinds from "../../src/driver/kinds.ts";
import { formatJson } from "../../src/format/json/mod.ts";
import { refusalMessage, refusalOffset, messageText } from "../../src/format/syntax_error.ts";
import { FORMAT_OK } from "../../src/format/errors.ts";

const ROOT = new URL("../../bench/vscode/", import.meta.url).pathname;
const FMT = new URL("../../bench/vscode-fmt/", import.meta.url).pathname;
const args = process.argv.slice(2);
const wantToml = args.includes("--toml");
const showMax = Number((args.find((a) => a.startsWith("--show=")) ?? "--show=5").slice(7));
const filter = (args.find((a) => a.startsWith("--filter=")) ?? "").slice(9);
const files = fs.readFileSync("/tmp/vscode-files.txt", "utf8").split("\n").filter((x) => x);

const prettierKeyCache = new Map<string, Record<string, unknown> | null>();
// The `prettier` key of the nearest package.json at or above `dir` (relative to ROOT; "" is the root).
function prettierKey(dir: string): Record<string, unknown> | null {
  const hit = prettierKeyCache.get(dir);
  if (hit !== undefined) return hit;
  let r: Record<string, unknown> | null = null;
  const pj = ROOT + (dir ? dir + "/" : "") + "package.json";
  if (fs.existsSync(pj)) {
    try {
      const j = JSON.parse(fs.readFileSync(pj, "utf8"));
      if (j && typeof j.prettier === "object") r = j.prettier;
    } catch {}
  }
  if (r === null && dir !== "") r = prettierKey(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "");
  prettierKeyCache.set(dir, r);
  return r;
}

// What the driver makes of `.editorconfig` and the `prettier` key of a package.json, for bench/vscode.
export function optionsFor(path: string): FormatOptions {
  const o = new FormatOptions();
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === "package.json" || base.endsWith(".yml") || base.endsWith(".yaml")) {
    o.set("useTabs", "false");
    o.set("tabWidth", "2");
  } else {
    o.set("useTabs", "true");
  }
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const key = prettierKey(dir);
  if (key) for (const k of Object.keys(key)) o.set(k, String(key[k]));
  return o;
}

let total = 0;
let same = 0;
let bytes = 0;
let shown = 0;
const out = new ByteBuf(1 << 20);
const diffs: string[] = [];
for (const f of files) {
  if (filter && !f.includes(filter)) continue;
  const k = (wantToml ? (kinds.kindOf(f, "") === kinds.KIND_NONE && kinds.isToml(f) ? kinds.KIND_TOML : kinds.kindOf(f, "")) : kinds.kindOf(f, ""));
  if (wantToml ? k !== kinds.KIND_TOML : k !== kinds.KIND_JSON) continue;
  const parser = kinds.outParser;
  const src = fs.readFileSync(ROOT + f);
  const expectedPath = FMT + f;
  const expected = fs.existsSync(expectedPath) ? fs.readFileSync(expectedPath) : null;
  total++;
  bytes += src.length;
  out.reset();
  const opts = optionsFor(f);
  let r: number;
  if (wantToml) {
    const { formatToml } = await import("../../src/format/toml/mod.ts");
    r = formatToml(src, src.length, opts, out);
  } else {
    r = formatJson(src, src.length, parser, opts, out);
  }
  let ok = false;
  if (r === FORMAT_OK && expected) ok = Buffer.compare(Buffer.from(out.view()), expected) === 0;
  else if (r !== FORMAT_OK && expected === null) ok = true;
  if (ok) same++;
  else {
    diffs.push(f);
    if (shown < showMax) {
      shown++;
      console.log("DIFF", f, "parser", parser, "status", r, r === 2 ? messageText(refusalMessage()) + " @" + refusalOffset() : "");
      if (r === FORMAT_OK && expected) {
        const a = out.view();
        let i = 0;
        while (i < a.length && i < expected.length && a[i] === expected[i]) i++;
        const ctx = (b: Uint8Array) => JSON.stringify(Buffer.from(b.subarray(Math.max(0, i - 60), i + 60)).toString("utf8"));
        console.log("  first diff at", i, "of", a.length, "/", expected.length);
        console.log("  ours:    ", ctx(a));
        console.log("  expected:", ctx(expected));
      }
    }
  }
}
console.log(`${wantToml ? "toml" : "json"}: ${same}/${total} identical, ${bytes} bytes`);
if (diffs.length) fs.writeFileSync("/tmp/json-diffs.txt", diffs.join("\n") + "\n");
