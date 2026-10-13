// The Handlebars inputs of Prettier's fixtures (from /tmp/prettier-bundle.txt) and of the vscode tree.
//   node tools/handlebars/corpus.ts [dir]   writes them to dir (default /tmp/hbs-corpus)
import * as fs from "node:fs";

export function bundleInputs(bundlePath: string): { name: string; data: Buffer }[] {
  const buf = fs.readFileSync(bundlePath);
  const out: { name: string; data: Buffer }[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (!(buf[pos] === 61 && buf[pos + 1] === 61 && buf[pos + 2] === 61 && buf[pos + 3] === 32)) {
      pos++;
      continue;
    }
    const nl = buf.indexOf(10, pos);
    const header = buf.toString("latin1", pos + 4, nl);
    const sp = header.lastIndexOf(" ");
    const name = header.substring(0, sp);
    const size = parseInt(header.substring(sp + 1), 10);
    const data = buf.subarray(nl + 1, nl + 1 + size);
    pos = nl + 1 + size;
    if (name.startsWith("/handlebars/") && !name.endsWith(".snap") && !name.endsWith(".js") && !name.endsWith(".json")) {
      out.push({ name, data: Buffer.from(data) });
    }
  }
  return out;
}

export function allInputs(): { name: string; data: Buffer }[] {
  const out = bundleInputs("/tmp/prettier-bundle.txt");
  const root = "/Users/timkendall/Developer/lab/scriptc-formatter/bench/vscode/";
  for (const rel of [
    "extensions/vscode-colorize-tests/test/colorize-fixtures/test.handlebars",
    "extensions/vscode-colorize-tests/test/colorize-fixtures/test.hbs",
  ]) {
    try {
      out.push({ name: "vscode/" + rel, data: fs.readFileSync(root + rel) });
    } catch {
      // not there
    }
  }
  return out;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("corpus.ts")) {
  const dir = process.argv[2] ?? "/tmp/hbs-corpus";
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const f of allInputs()) {
    fs.writeFileSync(dir + "/" + f.name.replace(/[^A-Za-z0-9_.-]/g, "_") + (f.name.endsWith(".hbs") || f.name.endsWith(".handlebars") ? "" : ".hbs"), f.data);
    n++;
  }
  console.log(n + " inputs in " + dir);
}
