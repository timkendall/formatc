// Throughput of the YAML and TOML parsers on the vscode corpus.
//   node tools/parsers/bench.ts yaml|toml [reps] [file]
//   scriptc build tools/parsers/bench.ts -o bench && ./bench yaml
// Reads /tmp/vscode-files.txt (relative paths, one per line, spaces possible) and bench/vscode/.
import * as fs from "node:fs";
import { yamlParseAsWritten, yamlTokenCount } from "../../src/parsers/yaml.ts";
import { tomlTokens, tomlTokenCount } from "../../src/parsers/toml.ts";

const mode = process.argv[2] === "toml" ? "toml" : "yaml";
const reps = process.argv[3] ? parseInt(process.argv[3], 10) : 20;
const root = new URL("../../bench/vscode/", import.meta.url).pathname;

// A fourth argument: one file instead of the corpus
const one = process.argv[4];
const list = one ? [] : fs.readFileSync("/tmp/vscode-files.txt", "utf8").split("\n");
const files: Uint8Array[] = [];
let total = 0;
for (let i = 0; i < list.length; i++) {
  const rel = list[i];
  const ok = mode === "yaml" ? rel.endsWith(".yml") || rel.endsWith(".yaml") : rel.endsWith(".toml");
  if (!ok) continue;
  const b = fs.readFileSync(root + rel);
  files.push(b);
  total = total + b.length;
}

if (one) {
  const b = fs.readFileSync(one);
  files.push(b);
  total = total + b.length;
}

let best = 1e18;
let sink = 0;
let errors = 0;
for (let rep = 0; rep < reps; rep++) {
  const t0 = performance.now();
  errors = 0;
  for (let i = 0; i < files.length; i++) {
    const b = files[i];
    if (mode === "yaml") {
      if (yamlParseAsWritten(b, b.length) !== 0) errors = errors + 1;
      sink = sink + yamlTokenCount();
    } else {
      if (tomlTokens(b, b.length) !== 0) errors = errors + 1;
      sink = sink + tomlTokenCount();
    }
  }
  const dt = performance.now() - t0;
  if (dt < best) best = dt;
}
console.log(
  mode + ": " + files.length + " files, " + total + " bytes, best of " + reps + ": " + best.toFixed(2) + " ms, " +
  (total / 1e6 / (best / 1000)).toFixed(0) + " MB/s, " + errors + " rejected, tokens " + sink,
);
