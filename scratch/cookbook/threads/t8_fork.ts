import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
const CHILD = fileURLToPath(new URL("./t8_child.ts", import.meta.url));
interface R { id: number; bytes: number; tokens: number; files: number; ms: number }
const nproc = Number(process.argv[2] || "1");
const t0 = performance.now();
let done = 0, bytes = 0, tokens = 0, files = 0, maxMs = 0;
for (let i = 0; i < nproc; i++) {
  const c = fork(CHILD, [String(i), String(nproc)], { silent: true });
  let out = "";
  c.stdout!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
  c.on("exit", () => {
    const m = JSON.parse(out) as R;
    bytes += m.bytes; tokens += m.tokens; files += m.files; if (m.ms > maxMs) maxMs = m.ms;
    done++;
    if (done === nproc) {
      const dt = performance.now() - t0;
      console.log(`procs=${nproc} files=${files} bytes=${bytes} tokens=${tokens} slowestChild=${maxMs.toFixed(1)}ms total=${dt.toFixed(1)}ms => ${(bytes / 1e6 / (dt / 1000)).toFixed(0)} MB/s`);
    }
  });
}
