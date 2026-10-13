// Throughput of src/format/handlebars on the fixture inputs.
//   node tools/handlebars/bench.ts [dir=/tmp/hbs-corpus] [reps=2000]
//   scriptc build tools/handlebars/bench.ts -o /tmp/hbs-bench && /tmp/hbs-bench
// Only the inputs that are accepted count (those of the `_errors_` directory are left out).
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FORMAT_OK } from "../../src/format/errors.ts";
import { format } from "../../src/format/handlebars/mod.ts";
import { FormatOptions } from "../../src/format/options.ts";

const dir = process.argv[2] !== undefined ? process.argv[2] : "/tmp/hbs-corpus";
const reps = process.argv[3] !== undefined ? parseInt(process.argv[3], 10) : 2000;
const names = fs.readdirSync(dir);
const options = new FormatOptions();
const out = new ByteBuf(1 << 20);
const files: Uint8Array[] = [];
let bytes = 0;
let outBytes = 0;
for (let i = 0; i < names.length; i++) {
  const data = new Uint8Array(fs.readFileSync(dir + "/" + names[i]));
  out.reset();
  if (format(data, options, out) === FORMAT_OK) {
    files.push(data);
    bytes += data.length;
    outBytes += out.len;
  }
}
console.log(files.length + " files, " + bytes + " bytes in, " + outBytes + " bytes out");
let best = 1e18;
let sum = 0;
for (let rep = 0; rep < 10; rep++) {
  const t0 = performance.now();
  for (let k = 0; k < reps / 10; k++) {
    for (let i = 0; i < files.length; i++) {
      out.reset();
      sum += format(files[i], options, out);
    }
  }
  const dt = performance.now() - t0;
  if (dt < best) best = dt;
}
const total = (bytes * reps) / 10;
console.log("best of 10: " + (best / 1000).toFixed(4) + " s for " + (total / 1e6).toFixed(1) + " MB: " + (total / 1e6 / (best / 1000)).toFixed(1) + " MB/s (" + sum + ")");
