import * as fs from "node:fs";
import { spawn } from "node:child_process";

if (process.argv[2] === "--child") {
  const buf = Buffer.alloc(65536);
  let total = 0;
  while (true) {
    const n = fs.readSync(0, buf, 0, buf.length, null);
    if (n <= 0) break;
    total += n;
    fs.writeSync(1, Buffer.from("got " + n + "\n"));
  }
  fs.writeSync(1, Buffer.from("done " + total + "\n"));
} else {
  console.log("execPath=" + process.execPath + " argv0=" + process.argv[0] + " argv1=" + process.argv[1]);
  const c = spawn(process.execPath, ["--child"], { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  (c.stdout as NodeJS.ReadableStream).on("data", (d: Buffer) => { out += d.toString("utf8"); console.log("data:" + d.length); });
  c.on("exit", (code: number | null) => { console.log("exit " + code + " out=" + out.length); });
  (c.stdin as NonNullable<typeof c.stdin>).write(Buffer.from("hello"));
  const t0 = performance.now();
  // busy for 50ms then yield
  while (performance.now() - t0 < 50) {}
  console.log("yielding");
  await new Promise<void>((r) => setTimeout(r, 0));
  console.log("after yield");
  await new Promise<void>((r) => setImmediate(r));
  console.log("after immediate");
  (c.stdin as NonNullable<typeof c.stdin>).write(Buffer.from("world!"));
  (c.stdin as NonNullable<typeof c.stdin>).end();
}
