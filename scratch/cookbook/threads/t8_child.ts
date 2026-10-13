// Child process shard: argv[2]=shard id, argv[3]=shard count. Strided partition of the file list.
import * as fs from "node:fs";
import { lexKernel } from "./lexkernel.ts";
const ROOT = "/Users/timkendall/Developer/lab/scriptc-formatter/bench/vscode/";
const id = Number(process.argv[2]);
const count = Number(process.argv[3]);
const t0 = performance.now();
const text = fs.readFileSync("/tmp/vscode-files.txt", "utf8");
const paths = text.split("\n").filter((s) => s.length > 0);
const tokOut = new Int32Array(65536 * 3 + 3);
let scratch = Buffer.alloc(1 << 20);
let totBytes = 0, totTokens = 0, nfiles = 0;
for (let idx = id; idx < paths.length; idx += count) {
  let fd = -1;
  try { fd = fs.openSync(ROOT + paths[idx], "r"); } catch (e) { continue; }
  const size = fs.fstatSync(fd).size;
  if (size > scratch.length) scratch = Buffer.alloc(size * 2);
  let got = 0;
  while (got < size) { const n = fs.readSync(fd, scratch, got, size - got, got); if (n <= 0) break; got += n; }
  fs.closeSync(fd);
  totTokens += lexKernel(scratch, got, tokOut);
  totBytes += got; nfiles++;
}
console.log(JSON.stringify({ id, bytes: totBytes, tokens: totTokens, files: nfiles, ms: performance.now() - t0 }));
