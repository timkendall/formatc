// Formats every file of a directory with src/format/graphql (node or compiled), for comparison with `bun fmt`:
//   node tools/graphql/fmt.ts <indir> <outdir> [--option=value ...]
//   scriptc build tools/graphql/fmt.ts -o /tmp/gql-fmt && /tmp/gql-fmt <indir> <outdir>
// For every file: `<outdir>/<name>` is the formatted text, or `<outdir>/<name>.err` is `<message> <line>:<col>` (Bun's
// message and place, columns count UTF-16 code units). `--time` prints the throughput of the formatting alone.
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FORMAT_NESTED_TOO_DEEPLY, FORMAT_OK, FORMAT_SYNTAX_ERROR_AT } from "../../src/format/errors.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { messageText, refusalMessage, refusalOffset } from "../../src/format/syntax_error.ts";
import { format } from "../../src/format/graphql/mod.ts";
import { setParserDoors } from "../../src/format/graphql/parser.ts";
import { setPrinterDoors } from "../../src/format/graphql/printer.ts";

function lineCol(text: Uint8Array, offset: number): string {
  let line = 1;
  let col = 1;
  // The offset does not count a byte order mark.
  let i = text.length >= 3 && (text[0] | 0) === 0xef && (text[1] | 0) === 0xbb && (text[2] | 0) === 0xbf ? 3 : 0;
  const n = offset + i < text.length ? offset + i : text.length;
  while (i < n) {
    const b = text[i] | 0;
    if (b === 10 || b === 13) {
      if (b === 13 && i + 1 < text.length && (text[i + 1] | 0) === 10) i = i + 1;
      line = line + 1;
      col = 1;
    } else if ((b & 0xc0) !== 0x80) {
      col = col + (b >= 0xf0 ? 2 : 1);
    }
    i = i + 1;
  }
  return line + ":" + col;
}

function main(): number {
  const args: string[] = [];
  const options = new FormatOptions();
  options.filepath = "a.graphql";
  let timeIt = false;
  let reps = 1;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--time") timeIt = true;
    else if (a.startsWith("--parser-doors=")) setParserDoors(parseInt(a.slice(15)));
    else if (a.startsWith("--printer-doors=")) setPrinterDoors(parseInt(a.slice(16)));
    else if (a.startsWith("--reps=")) reps = parseInt(a.slice(7));
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      options.set(a.slice(2, eq), a.slice(eq + 1));
    } else args.push(a);
  }
  const indir = args[0];
  const outdir = args[1];
  const names = fs.readdirSync(indir);
  const texts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < names.length; i++) {
    const b = fs.readFileSync(indir + "/" + names[i]);
    texts.push(new Uint8Array(b.buffer, b.byteOffset, b.length));
    total += b.length;
  }
  const out = new ByteBuf(1 << 16);
  if (timeIt) {
    let best = 1e18;
    for (let rep = 0; rep < reps; rep++) {
      const t0 = performance.now();
      for (let i = 0; i < texts.length; i++) {
        out.reset();
        format(texts[i], options, out);
      }
      const dt = performance.now() - t0;
      if (dt < best) best = dt;
    }
    console.log(texts.length + " files, " + (total / 1e6).toFixed(2) + " MB: " + best.toFixed(1) + " ms, " + (total / 1e6 / (best / 1000)).toFixed(1) + " MB/s (input)");
    return 0;
  }
  fs.mkdirSync(outdir, { recursive: true });
  for (let i = 0; i < names.length; i++) {
    out.reset();
    const r = format(texts[i], options, out);
    if (r === FORMAT_OK) {
      fs.writeFileSync(outdir + "/" + names[i], Buffer.from(out.data.buffer, out.data.byteOffset, out.len));
    } else if (r === FORMAT_SYNTAX_ERROR_AT) {
      fs.writeFileSync(outdir + "/" + names[i] + ".err", messageText(refusalMessage()) + " " + lineCol(texts[i], refusalOffset()) + "\n");
    } else if (r === FORMAT_NESTED_TOO_DEEPLY) {
      fs.writeFileSync(outdir + "/" + names[i] + ".err", "nested too deeply\n");
    } else {
      fs.writeFileSync(outdir + "/" + names[i] + ".err", "code " + r + "\n");
    }
  }
  return 0;
}

process.exitCode = main();
