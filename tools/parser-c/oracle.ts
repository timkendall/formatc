// The oracle: what `bun fmt` says of each file of a directory. Run with bun:
//   bun tools/parser-c/oracle.ts <dir> <out.json> [--parser=flow] [--ext=js,ts,...] [--list=file-with-relative-paths]
// out.json: { "<relative path>": [exitCode, message, line, col] }  (exitCode 0: accepted; message/line/col from stderr)
import { Glob } from "bun";
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const dir = args[0];
const out = args[1];
const parser = flags.find((f) => f.startsWith("--parser="));
const listFlag = flags.find((f) => f.startsWith("--list="));
const files: string[] = [];
if (listFlag) {
  const text = await Bun.file(listFlag.slice(7)).text();
  for (const l of text.split("\n")) if (l.length > 0) files.push(l);
} else {
  for await (const f of new Glob("**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}").scan({ cwd: dir })) files.push(f);
  files.sort();
}
const result: Record<string, [number, string, number, number]> = {};
let next = 0;
async function worker() {
  while (true) {
    const i = next++;
    if (i >= files.length) return;
    const f = files[i];
    const base = f.slice(f.lastIndexOf("/") + 1);
    const cmd = ["bun", "fmt", "--stdin-filepath=" + base];
    if (parser) cmd.push("--parser=" + parser.slice(9));
    const proc = Bun.spawn(cmd, { stdin: Bun.file(dir + "/" + f), stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    let msg = "";
    let line = 0;
    let col = 0;
    if (proc.exitCode !== 0) {
      const m = /^error: (.*)$/m.exec(err);
      if (m) msg = m[1];
      const a = /^    at .*:(\d+):(\d+)$/m.exec(err);
      if (a) {
        line = parseInt(a[1], 10);
        col = parseInt(a[2], 10);
      } else if (!m) msg = err.trim().split("\n")[0] ?? "";
    }
    result[f] = [proc.exitCode ?? -1, msg, line, col];
  }
}
await Promise.all(Array.from({ length: 14 }, worker));
const sorted: Record<string, [number, string, number, number]> = {};
for (const k of Object.keys(result).sort()) sorted[k] = result[k];
await Bun.write(out, JSON.stringify(sorted));
console.log("files", files.length, "rejected", Object.values(sorted).filter((v) => v[0] !== 0).length);
