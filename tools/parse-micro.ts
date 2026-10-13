// Micro benchmark of the parser: parses a synthetic text (a line repeated) several times; run compiled under `/usr/bin/time -l` for the
// instruction count. node tools/parse-micro.ts 'a;' 200000 5   (line, repetitions of the line, parses)
import { parseFile } from "../src/sema/parser/parser/run.ts";

const line = process.argv[2];
const n = parseInt(process.argv[3], 10);
const reps = parseInt(process.argv[4], 10);
const text = Buffer.from((line + "\n").repeat(n));
const src = new Uint8Array(text.length + 16);
src.set(text);
let best = 1e18;
let r = 0;
for (let i = 0; i < reps; i++) {
  const t0 = performance.now();
  r = parseFile(src, text.length, "a.ts", false);
  const dt = performance.now() - t0;
  if (dt < best) best = dt;
}
console.log("result", r, "bytes", text.length, "best ms", best.toFixed(2), "MB/s", (text.length / 1e6 / (best / 1000)).toFixed(0), "ns/line", ((best * 1e6) / n).toFixed(1));
