// Checks src/format/graphql/embed.ts without the JavaScript formatter: a file that is `<tag>`<template>`;` is "formatted"
// by writing the tag, the template (`writeTemplate`, the substitutions as their text) and `;` to a document, which is
// what `bun fmt --stdin-filepath=a.js` prints for such a statement when the template is GraphQL.
//   node tools/graphql/embed-check.ts <indir> <outdir>      (then tools/graphql/oracle-js.ts, diff -r)
//   (node tools/graphql/embed-gen.ts <outdir> <count> [seed] writes random statements)
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { FormatOptions } from "../../src/format/options.ts";
import { Formatter } from "../../src/format/ir/formatter.ts";
import { Scratch, finishAndPrint, startDocument } from "../../src/format/ir/run.ts";
import { GqlTemplate, writeTemplate } from "../../src/format/graphql/embed.ts";

class MockTemplate extends GqlTemplate {
  starts: number[] = [];
  ends: number[] = [];
  cookedTexts: (Uint8Array | null)[] = [];
  exprStarts: number[] = [];
  exprEnds: number[] = [];
  quasiCount(): number {
    return this.starts.length;
  }
  rawStart(i: number): number {
    return this.starts[i];
  }
  rawEnd(i: number): number {
    return this.ends[i];
  }
  cooked(i: number): Uint8Array | null {
    return this.cookedTexts[i];
  }
  writeExpression(i: number, f: Formatter): void {
    f.tokenStr("${");
    f.textSource(this.exprStarts[i], this.exprEnds[i]);
    f.tokenStr("}");
  }
}

// The cooked value of a raw template text, or null for an invalid escape.
function cook(raw: string): Uint8Array | null {
  let s = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\r") {
      s += "\n";
      if (raw[i + 1] === "\n") i++;
      continue;
    }
    if (c !== "\\") {
      s += c;
      continue;
    }
    i++;
    const d = raw[i];
    switch (d) {
      case "n": s += "\n"; break;
      case "t": s += "\t"; break;
      case "r": s += "\r"; break;
      case "b": s += "\b"; break;
      case "f": s += "\f"; break;
      case "v": s += "\v"; break;
      case "0": s += "\0"; break;
      case "\\": case "`": case "$": case "'": case '"': s += d; break;
      case "\n": break;
      case "u": {
        if (raw[i + 1] === "{") {
          const e = raw.indexOf("}", i);
          if (e < 0) return null;
          const code = parseInt(raw.slice(i + 2, e), 16);
          if (Number.isNaN(code) || code > 0x10ffff) return null;
          s += String.fromCodePoint(code);
          i = e;
        } else {
          const h = raw.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) return null;
          s += String.fromCharCode(parseInt(h, 16));
          i += 4;
        }
        break;
      }
      case "x": {
        const h = raw.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) return null;
        s += String.fromCharCode(parseInt(h, 16));
        i += 2;
        break;
      }
      default:
        return null;
    }
  }
  // WTF-8: a lone surrogate is three bytes (Buffer would write U+FFFD).
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return new Uint8Array(out);
}

const options = new FormatOptions();
options.filepath = "a.js";
const scratch = new Scratch(options);

function formatStatement(text: string): string {
  const source = new Uint8Array(Buffer.from(text, "utf8"));
  // The source as latin1 offsets: work on the Buffer's bytes.
  const bytes = Buffer.from(text, "utf8");
  const tick = bytes.indexOf(96);
  const tpl = new MockTemplate();
  let i = tick + 1;
  let quasiStart = i;
  while (true) {
    const b = bytes[i];
    if (b === 92) {
      i += 2;
    } else if (b === 36 && bytes[i + 1] === 123) {
      tpl.starts.push(quasiStart);
      tpl.ends.push(i);
      const e = bytes.indexOf(125, i);
      tpl.exprStarts.push(i + 2);
      tpl.exprEnds.push(e);
      i = e + 1;
      quasiStart = i;
    } else if (b === 96) {
      tpl.starts.push(quasiStart);
      tpl.ends.push(i);
      break;
    } else {
      i++;
    }
  }
  const templateEnd = i + 1;
  for (let q = 0; q < tpl.starts.length; q++) tpl.cookedTexts.push(cook(bytes.toString("utf8", tpl.starts[q], tpl.ends[q])));
  const f = startDocument(scratch, source, options, null);
  f.textSource(0, tick);
  const startLen = f.len();
  if (!writeTemplate(tpl, f)) {
    // Left as it is.
    f.textSource(tick, templateEnd);
  }
  f.tokenStr(";");
  f.hardLineBreak();
  const out = new ByteBuf(1024);
  const r = finishAndPrint(f, out);
  if (r !== 0) return "ERROR " + r + "\n";
  return out.toUtf8();
}

function main(): void {
  const indir = process.argv[2];
  const outdir = process.argv[3];
  fs.mkdirSync(outdir, { recursive: true });
  for (const name of fs.readdirSync(indir)) {
    fs.writeFileSync(outdir + "/" + name, formatStatement(fs.readFileSync(indir + "/" + name, "utf8")));
  }
}

main();
