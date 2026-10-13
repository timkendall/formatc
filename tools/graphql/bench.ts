// Phases of the GraphQL formatter on a directory of files (compiled: scriptc build tools/graphql/bench.ts -o /tmp/gql-bench):
//   /tmp/gql-bench <dir> [reps]
import * as fs from "node:fs";
import { ByteBuf } from "../../src/base/bytebuf.ts";
import { Scratch, finishAndPrintWithLineEnding, startDocument } from "../../src/format/ir/run.ts";
import { FormatOptions, LINE_ENDING_LF } from "../../src/format/options.ts";
import { Attached, attach } from "../../src/format/graphql/comments.ts";
import { builderFor } from "../../src/format/graphql/mod.ts";
import { Tree, parse } from "../../src/format/graphql/parser.ts";

const EMPTY = new Uint8Array(0);

function main(): number {
  const dir = process.argv[2];
  const reps = process.argv.length > 3 ? parseInt(process.argv[3]) : 5;
  const names = fs.readdirSync(dir);
  const texts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < names.length; i++) {
    const b = fs.readFileSync(dir + "/" + names[i]);
    texts.push(new Uint8Array(b.buffer, b.byteOffset, b.length));
    total += b.length;
  }
  const options = new FormatOptions();
  const tree = new Tree();
  const att = new Attached();
  const scratch = new Scratch(options);
  const out = new ByteBuf(1 << 20);
  let bestParse = 1e18;
  let bestAttach = 1e18;
  let bestWrite = 1e18;
  let bestPrint = 1e18;
  let sink = 0;
  let elements = 0;
  let nodes = 0;
  const mode = process.argv.length > 4 ? process.argv[4] : "all";
  if (mode === "parse") {
    let w = 0;
    const t0 = performance.now();
    for (let k = 0; k < 10; k++) for (let i = 0; i < texts.length; i++) w += parse(texts[i], tree);
    console.log("parse only: " + (performance.now() - t0).toFixed(0) + " ms " + w);
    return 0;
  }
  if (mode === "write") {
    // Only the writing of the document, 20 times per file (for a profiler).
    let w = 0;
    const t0 = performance.now();
    for (let i = 0; i < texts.length; i++) {
      parse(texts[i], tree);
      attach(texts[i], tree, att);
      for (let k = 0; k < 20; k++) {
        const f = startDocument(scratch, EMPTY, options, null);
        f.source = texts[i];
        const b = builderFor(f, texts[i], 0, tree, att, false, LINE_ENDING_LF);
        b.print(tree.root());
        w += f.len();
      }
    }
    console.log("write only: " + (performance.now() - t0).toFixed(0) + " ms, elements " + w);
    return 0;
  }
  for (let rep = 0; rep < reps; rep++) {
    let tParse = 0;
    let tAttach = 0;
    let tWrite = 0;
    let tPrint = 0;
    for (let i = 0; i < texts.length; i++) {
      let t0 = performance.now();
      sink += parse(texts[i], tree);
      let t1 = performance.now();
      tParse += t1 - t0;
      attach(texts[i], tree, att);
      let t2 = performance.now();
      tAttach += t2 - t1;
      const f = startDocument(scratch, EMPTY, options, null);
        f.source = texts[i];
      const b = builderFor(f, texts[i], 0, tree, att, false, LINE_ENDING_LF);
      b.print(tree.root());
      let t3 = performance.now();
      tWrite += t3 - t2;
      if (rep === 0) {
        elements += f.len();
        nodes += tree.nodeCount;
      }
      out.reset();
      sink += finishAndPrintWithLineEnding(f, LINE_ENDING_LF, out);
      tPrint += performance.now() - t3;
    }
    if (tParse < bestParse) bestParse = tParse;
    if (tAttach < bestAttach) bestAttach = tAttach;
    if (tWrite < bestWrite) bestWrite = tWrite;
    if (tPrint < bestPrint) bestPrint = tPrint;
  }
  const tParse = bestParse;
  const tAttach = bestAttach;
  const tWrite = bestWrite;
  const tPrint = bestPrint;
  const tAll = tParse + tAttach + tWrite + tPrint;
  const mb = total / 1e6;
  console.log(texts.length + " files, " + mb.toFixed(2) + " MB");
  console.log("parse            " + tParse.toFixed(1) + " ms  " + (mb / (tParse / 1000)).toFixed(0) + " MB/s");
  console.log("attach           " + tAttach.toFixed(1) + " ms");
  console.log("write document   " + tWrite.toFixed(1) + " ms");
  console.log("print document   " + tPrint.toFixed(1) + " ms");
  console.log("total            " + tAll.toFixed(1) + " ms  " + (mb / (tAll / 1000)).toFixed(0) + " MB/s   (sink " + sink + ")");
  console.log("elements " + elements + ", nodes " + nodes + ", " + (tWrite * 1e6 / nodes).toFixed(0) + " ns/node written, " + (tWrite * 1e6 / elements).toFixed(1) + " ns/element");
  return 0;
}

process.exitCode = main();
// Worker mode (like the real binary): the compiler's tax on module-level state and typed arrays.
import { Worker, isMainThread } from "node:worker_threads";
if (process.argv[2] === "spawn-worker" && isMainThread) {
  new Worker(new URL(import.meta.url));
}
