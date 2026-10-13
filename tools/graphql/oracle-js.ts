// `bun fmt --stdin-filepath=a.js` on every file of a directory, to a directory (for embed-check.ts):
//   node tools/graphql/oracle-js.ts <indir> <outdir>
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

const [indir, outdir] = process.argv.slice(2);
fs.mkdirSync(outdir, { recursive: true });
const bun = process.env.HOME + "/.bun/bin/bun";
for (const name of fs.readdirSync(indir)) {
  const r = spawnSync(bun, ["fmt", "--stdin-filepath=a.js"], { input: fs.readFileSync(indir + "/" + name), maxBuffer: 1 << 28 });
  fs.writeFileSync(outdir + "/" + name, r.status === 0 ? r.stdout : "SYNTAX ERROR\n");
}
