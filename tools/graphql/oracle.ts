// Runs `bun fmt` on every file of a directory and writes the same files as tools/graphql/fmt.ts does:
//   node tools/graphql/oracle.ts <indir> <outdir> [--option=value ...]
// then `diff -r <outdir-of-bun> <outdir-of-ours>`.
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

const args: string[] = [];
const flags: string[] = [];
for (let i = 2; i < process.argv.length; i++) (process.argv[i].startsWith("--") ? flags : args).push(process.argv[i]);
const [indir, outdir] = args;
fs.mkdirSync(outdir, { recursive: true });
const bun = process.env.HOME + "/.bun/bin/bun";
for (const name of fs.readdirSync(indir)) {
  const input = fs.readFileSync(indir + "/" + name);
  const r = spawnSync(bun, ["fmt", "--stdin-filepath=a.graphql", ...flags], { input, maxBuffer: 1 << 28 });
  if (r.status === 0) {
    fs.writeFileSync(outdir + "/" + name, r.stdout);
  } else {
    const err = r.stderr.toString("utf8");
    const m = /error: (.*)\n\s+at a\.graphql:(\d+):(\d+)/.exec(err);
    fs.writeFileSync(outdir + "/" + name + ".err", m ? m[1] + " " + m[2] + ":" + m[3] + "\n" : "UNPARSED: " + err + "\n");
  }
}
