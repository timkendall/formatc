// Formats every YAML file (`.yml`, `.yaml`) of bench/vscode and compares byte for byte with bench/vscode-fmt (what `bun fmt`
// made of them; .editorconfig of vscode: 2 spaces for yml / yaml).
// `node tools/yaml/compare.ts [--show=N] [--filter=substr] [--bench=reps]`. Compiled: `scriptc build tools/yaml/compare.ts -o /tmp/yaml-compare`.
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { formatYaml } from "../../src/format/yaml/mod.ts";
import { FORMAT_OK } from "../../src/format/errors.ts";
import { messageText, refusalMessage, refusalOffset } from "../../src/format/syntax_error.ts";

const ROOT = new URL("../../bench/vscode/", import.meta.url).pathname;
const FMT = new URL("../../bench/vscode-fmt/", import.meta.url).pathname;
const args = process.argv.slice(2);
const showMax = Number((args.find((a) => a.startsWith("--show=")) ?? "--show=5").slice(7));
const filter = (args.find((a) => a.startsWith("--filter=")) ?? "").slice(9);
const reps = Number((args.find((a) => a.startsWith("--bench=")) ?? "--bench=0").slice(8));
const files = fs
  .readFileSync("/tmp/vscode-files.txt", "utf8")
  .split("\n")
  .filter((x) => x && (x.endsWith(".yml") || x.endsWith(".yaml")) && (!filter || x.includes(filter)));

// vscode's .editorconfig: 2 spaces. extensions/copilot has its own configuration in package.json ("prettier").
const options = new FormatOptions();
options.set("useTabs", "false");
options.set("tabWidth", "2");
const copilot = new FormatOptions();
copilot.set("useTabs", "true");
copilot.set("tabWidth", "4");
copilot.set("singleQuote", "true");
function optionsFor(path: string): FormatOptions {
  return path.startsWith("extensions/copilot/") ? copilot : options;
}

const sources: Uint8Array[] = [];
let total = 0;
let same = 0;
let bytes = 0;
let shown = 0;
const out = new ByteBuf(1 << 20);
for (const f of files) {
  const src = fs.readFileSync(ROOT + f);
  sources.push(src);
  const expectedPath = FMT + f;
  const expected = fs.existsSync(expectedPath) ? fs.readFileSync(expectedPath) : null;
  total++;
  bytes += src.length;
  out.reset();
  const r = formatYaml(src, src.length, optionsFor(f), out);
  let ok = false;
  if (r === FORMAT_OK && expected) ok = Buffer.compare(Buffer.from(out.view()), expected) === 0;
  else if (r !== FORMAT_OK) ok = expected === null || Buffer.compare(src, expected) === 0;
  if (ok) same++;
  else if (shown < showMax) {
    shown++;
    console.log("DIFF", f, "code", r, r === 2 ? messageText(refusalMessage()) + " at " + refusalOffset() : "");
    if (expected && r === FORMAT_OK) {
      const a = Buffer.from(out.view()).toString("utf8").split("\n");
      const b = expected.toString("utf8").split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log("  line", i + 1, "\n    ours:     ", JSON.stringify(a[i]), "\n    expected: ", JSON.stringify(b[i]));
          break;
        }
      }
    }
  }
}
console.log(`yaml files: ${same}/${total} identical to bun fmt (${(bytes / 1e6).toFixed(2)} MB)`);
if (reps > 0) {
  let best = 1e18;
  for (let rep = 0; rep < reps; rep++) {
    const t0 = performance.now();
    for (let i = 0; i < sources.length; i++) {
      out.reset();
      formatYaml(sources[i], sources[i].length, optionsFor(files[i]), out);
    }
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  console.log(`format (parse + format): best of ${reps}: ${best.toFixed(2)} ms, ${(bytes / 1e6 / (best / 1000)).toFixed(1)} MB/s`);
}
