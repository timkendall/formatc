// Runs the cases of selftest-cases.ts (what `bun fmt` made of them) through the JSON and TOML formatters. Identical under
// node and compiled: `scriptc build tools/json/selftest.ts -o /tmp/json-selftest && /tmp/json-selftest`.
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { formatJson } from "../../src/format/json/mod.ts";
import { sortPackageJson } from "../../src/format/json/sort_package_json.ts";
import { formatToml } from "../../src/format/toml/mod.ts";
import { SELFTEST_CASES } from "./selftest-cases.ts";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function sameBytes(a: Uint8Array, len: number, b: Uint8Array): boolean {
  if (len !== b.length) return false;
  for (let i = 0; i < len; i++) if ((a[i] | 0) !== (b[i] | 0)) return false;
  return true;
}

function main(): number {
  let ok = 0;
  const out = new ByteBuf(1024);
  for (let i = 0; i < SELFTEST_CASES.length; i++) {
    const c = SELFTEST_CASES[i];
    const name = c[0];
    const ext = c[1];
    const input = utf8(c[2]);
    const o = new FormatOptions();
    if (c[3].length > 0) {
      const parts = c[3].split(";");
      for (let k = 0; k < parts.length; k++) {
        const eq = parts[k].indexOf("=");
        o.set(parts[k].slice(0, eq), parts[k].slice(eq + 1));
      }
    }
    out.reset();
    let r: number;
    if (ext === ".toml") {
      r = formatToml(input, input.length, o, out);
    } else {
      const parser = ext === ".json" ? 0 : ext === ".jsonc" ? 1 : ext === ".json5" ? 2 : 3;
      r = formatJson(input, input.length, parser, o, out);
    }
    const want = utf8(c[4]);
    const same = r === 0 ? sameBytes(out.data, out.len, want) : c[4] === "<error>";
    if (same) ok = ok + 1;
    else console.log("FAIL", name, r, JSON.stringify(out.toUtf8()), JSON.stringify(c[4]));
  }
  // sortPackageJson
  const pj = utf8('{"scripts":{"b":1,"a":2},"name":"x","dependencies":{"z":"1","a":"2"},"version":"1.0.0","files":["b","a","b"],"keywords":["y","x","y"]}');
  out.reset();
  const done = sortPackageJson(pj, pj.length, false, out);
  const sorted = '{"name":"x","version":"1.0.0","keywords":["x","y"],"files":["b","a"],"scripts":{"b":1,"a":2},"dependencies":{"a":"2","z":"1"}}';
  let total = SELFTEST_CASES.length + 1;
  if (done && out.toUtf8() === sorted) ok = ok + 1;
  else console.log("FAIL sortPackageJson", out.toUtf8());
  // rangeStart / rangeEnd
  const rangeText = utf8('{"a":   [1,2,    3],\n  "b":     {"c":    1,   "d": [4,   5,\n 6]},\n\n\n  "e":  "x"}\n');
  const ranges = ["25:50", "9:19"];
  const rangeWant = ['{\n  "a": [1, 2, 3],\n  "b": { "c": 1, "d": [4, 5, 6] },\n\n  "e": "x",\n}\n', '{"a":   [1, 2, 3],\n  "b":     {"c":    1,   "d": [4,   5,\n 6]},\n\n\n  "e":  "x"}\n'];
  for (let i = 0; i < ranges.length; i++) {
    const o = new FormatOptions();
    const colon = ranges[i].indexOf(":");
    o.set("rangeStart", ranges[i].slice(0, colon));
    o.set("rangeEnd", ranges[i].slice(colon + 1));
    out.reset();
    const r = formatJson(rangeText, rangeText.length, 1, o, out);
    total = total + 1;
    if (r === 0 && out.toUtf8() === rangeWant[i]) ok = ok + 1;
    else console.log("FAIL range", ranges[i], r, JSON.stringify(out.toUtf8()));
  }
  console.log("json/toml selftest: " + ok + "/" + total);
  return ok === total ? 0 : 1;
}

const code = main();
if (code !== 0) process.exit(code);
