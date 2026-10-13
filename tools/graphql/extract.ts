// Extracts the GraphQL inputs of a conformance bundle to a directory (for fuzzing against `bun fmt`):
//   node tools/graphql/extract.ts /tmp/prettier-bundle.txt /tmp/gql-fixtures
import * as fs from "node:fs";

const bundle = fs.readFileSync(process.argv[2]);
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });
let pos = 0;
let n = 0;
while (pos < bundle.length) {
  if (bundle.toString("latin1", pos, pos + 4) !== "=== ") break;
  const nl = bundle.indexOf(10, pos);
  const header = bundle.toString("latin1", pos + 4, nl);
  const sp = header.lastIndexOf(" ");
  const path = header.slice(0, sp);
  const size = parseInt(header.slice(sp + 1));
  const body = bundle.subarray(nl + 1, nl + 1 + size);
  pos = nl + 1 + size;
  // one blank line between entries
  while (pos < bundle.length && bundle[pos] === 10) pos++;
  if (/\.(graphql|gql|graphqls)$/.test(path)) {
    fs.writeFileSync(outDir + "/" + path.slice(1).replace(/\//g, "__"), body);
    n++;
  }
}
console.log(n + " files");
