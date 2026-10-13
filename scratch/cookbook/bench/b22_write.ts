import * as fs from "node:fs";
const REPS = 3;
const data: Buffer = fs.readFileSync("/tmp/cb/corpus.bin");
const mode = process.argv[2];
const t0 = performance.now();
if (mode === "stdout_write") { for (let o = 0; o < data.length; o += 65536) process.stdout.write(data.subarray(o, Math.min(o + 65536, data.length))); }
else if (mode === "writeSync1") { for (let o = 0; o < data.length; o += 65536) fs.writeSync(1, data, o, Math.min(65536, data.length - o)); }
else if (mode === "writeSync1_big") { let o = 0; while (o < data.length) o += fs.writeSync(1, data, o, data.length - o); }
else if (mode === "stdout_write_str") { const s = data.toString("latin1"); process.stdout.write(s); }
else if (mode === "console_log_str") { const s = data.toString("latin1"); console.log(s); }
else if (mode === "files") {
  fs.mkdirSync("/tmp/cb/out_files", { recursive: true });
  const chunk = 13000;
  for (let i = 0; i < 18000; i++) fs.writeFileSync("/tmp/cb/out_files/f" + i + ".ts", data.subarray(i * 100, i * 100 + chunk));
}
else if (mode === "files_fd") {
  fs.mkdirSync("/tmp/cb/out_files", { recursive: true });
  const chunk = 13000;
  for (let i = 0; i < 18000; i++) { const fd = fs.openSync("/tmp/cb/out_files/g" + i + ".ts", "w"); fs.writeSync(fd, data, i * 100, chunk); fs.closeSync(fd); }
}
const dt = performance.now() - t0;
console.error(mode, dt.toFixed(1), "ms");
