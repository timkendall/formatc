// Copies src/ to a scratch directory and replaces the language formatters of src/driver/dispatch.ts by identity stubs, so that
// the driver can be measured on its own whatever formatters the other agents have wired in.
//
//   node tools/driver-perf/stubify.ts <outdir>        # outdir/src is the copy; build with: scriptc build <outdir>/src/main.ts
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.resolve(process.argv[2] || "/tmp/drvperf-tree");
fs.rmSync(out + "/src", { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(root + "/src", out + "/src", { recursive: true });
for (const f of ["package.json", "tsconfig.json"]) fs.copyFileSync(root + "/" + f, out + "/" + f);
if (!fs.existsSync(out + "/node_modules")) fs.symlinkSync(root + "/node_modules", out + "/node_modules");

const file = out + "/src/driver/dispatch.ts";
let t = fs.readFileSync(file, "utf8");
// formatters from other modules go
t = t.replace(/^import \{[^}]*\} from "\.\.\/format\/(?!options)[^"]*";\n/gm, "");
t = t.replace(/^import \* as \w+ from "\.\.\/format\/(?!options)[^"]*";\n/gm, "");
// every `xxxFormat(...)` but scriptFormat: identity
t = t.replace(/^function (\w+Format)\(([^)]*)\): number \{\n([\s\S]*?)^\}\n/gm, (m: string, name: string, args: string, body: string) => {
  if (name === "scriptFormat") return m;
  return `function ${name}(${args}): number {\n  out.append(src, 0, len);\n  return R_OK;\n}\n`;
});
fs.writeFileSync(file, t);
console.log("wrote " + out + "/src");
