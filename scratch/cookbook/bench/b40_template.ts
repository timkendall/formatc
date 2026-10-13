import * as fs from "node:fs";
import { Lexer, T_EOF } from "../lib/lexer_template.ts";
const data: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const N = data.length;
function run(): number { const lx = new Lexer(data, data.length); let c = 0; while (lx.next() !== T_EOF) c = ((c | 0) + 1) | 0; return c; }
let best = 1e18; let r = 0;
for (let rep = 0; rep < 7; rep++) { const t0 = performance.now(); r = run(); const dt = performance.now() - t0; if (dt < best) best = dt; }
console.log("lexer_template pull lexer", (N / 1e6 / (best / 1000)).toFixed(0), "MB/s tokens=", r);
