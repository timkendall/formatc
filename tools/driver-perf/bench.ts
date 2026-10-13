// Interleaved wall-clock benchmark of command lines (the machine is shared, so variants alternate and the minimum and the
// median are reported).
//
//   node tools/driver-perf/bench.ts [-n 12] [--cwd DIR] [--env K=V ...] -- "label=cmd args" "label2=cmd2 args"
// An `env:` prefix on a variant sets environment variables for it: "label=FMT_X=1 FMT_Y=2 /tmp/fmt --check".
import { spawnSync } from "node:child_process";

let n = 12;
let cwd = process.cwd();
const variants: { label: string; env: Record<string, string>; argv: string[] }[] = [];
const args = process.argv.slice(2);
let i = 0;
for (; i < args.length; i++) {
  if (args[i] === "-n") n = Number(args[++i]);
  else if (args[i] === "--cwd") cwd = args[++i];
  else if (args[i] === "--") {
    i++;
    break;
  }
}
for (; i < args.length; i++) {
  const eq = args[i].indexOf("=");
  const label = args[i].slice(0, eq);
  const words = args[i].slice(eq + 1).split(" ").filter((w) => w.length > 0);
  const env: Record<string, string> = {};
  while (words.length > 0 && /^[A-Z_]+=/.test(words[0])) {
    const w = words.shift() as string;
    env[w.slice(0, w.indexOf("="))] = w.slice(w.indexOf("=") + 1);
  }
  variants.push({ label, env, argv: words });
}
const times: number[][] = variants.map(() => []);
for (let r = 0; r < n + 1; r++) {
  for (let v = 0; v < variants.length; v++) {
    const t0 = performance.now();
    spawnSync(variants[v].argv[0], variants[v].argv.slice(1), { cwd, env: { ...process.env, ...variants[v].env }, stdio: ["ignore", "ignore", "ignore"], maxBuffer: 1 << 28 });
    const dt = performance.now() - t0;
    if (r > 0) times[v].push(dt);
  }
}
for (let v = 0; v < variants.length; v++) {
  const t = times[v].slice().sort((a, b) => a - b);
  console.log(variants[v].label.padEnd(28) + " min " + t[0].toFixed(0).padStart(5) + "  med " + t[t.length >> 1].toFixed(0).padStart(5) + "  max " + t[t.length - 1].toFixed(0).padStart(5) + " ms");
}
