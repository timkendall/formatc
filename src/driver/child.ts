// A child process of the main process (pool.ts): reads jobs from stdin, formats the files, and writes the results to stdout.
// It runs until its stdin is closed. The main process starts it with `CHILD_ARG` as the only argument.
import * as fs from "node:fs";
import { ByteBuf } from "../base/bytebuf.ts";
import { OptionSet } from "./dispatch.ts";
import * as pipe from "./pipe.ts";
import { LoopCfg, Report, formatOne } from "./worker.ts";
import { M_CONFIG, M_JOBS, M_RESULT, M_SET, Reader, Wire, frameSize } from "./wire.ts";

export const CHILD_ARG = "--fmt-internal-child-3f9a1c";

function writeFully(fd: number, b: Buffer): void {
  let off = 0;
  while (off < b.length) {
    try {
      off = off + fs.writeSync(fd, b, off, b.length - off);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EAGAIN") continue;
      process.exit(3);
    }
  }
}

let input: Buffer = Buffer.alloc(1 << 16);
let inputLen = 0;
let inputPos = 0;

// The next message: its position in `input` (-1 at the end of the input). The message is complete, and stays valid until the next call.
function nextMessage(): number {
  while (true) {
    const have = inputLen - inputPos;
    const size = frameSize(input, inputPos, have);
    if (size >= 0 && have >= size) {
      const at = inputPos;
      inputPos = inputPos + size;
      return at;
    }
    // more input: move what is left to the start
    if (inputPos > 0) {
      input.copy(input, 0, inputPos, inputLen);
      inputLen = have;
      inputPos = 0;
    }
    if (size > input.length) {
      const bigger = Buffer.alloc(size * 2);
      input.copy(bigger, 0, 0, inputLen);
      input = bigger;
    }
    let n = 0;
    try {
      n = fs.readSync(0, input, inputLen, input.length - inputLen, null);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EAGAIN" || code === "EINTR") continue;
      return -1;
    }
    if (n <= 0) return -1;
    inputLen = inputLen + n;
  }
}

export function runChild(): void {
  let cfg: LoopCfg = new LoopCfg(false, false, 1, "", "", "", "");
  const sets: OptionSet[] = [];
  const out = new ByteBuf(1 << 20);
  const w = new Wire();
  while (true) {
    const at = nextMessage();
    if (at < 0) break;
    const type = input[at] | 0;
    const r = new Reader(input, at + 5);
    if (type === M_CONFIG) {
      const writes = r.u8() === 1;
      const detail = r.u8() === 1;
      const chunk = r.u32();
      const compareTo = r.str();
      const compareRoot = r.str();
      const dumpTo = r.str();
      const cwd = r.str();
      cfg = new LoopCfg(writes, detail, chunk, compareTo, compareRoot, dumpTo, cwd);
    } else if (type === M_SET) {
      const id = sets.length;
      const resolved = pipe.decodeSet(r.str());
      sets.push(new OptionSet(id, resolved, pipe.decodedVerifies));
    } else if (type === M_JOBS) {
      const n = r.u32();
      const report = new Report();
      const keys: number[] = [];
      const marks: number[] = [];
      for (let i = 0; i < n; i++) {
        const key = r.u32();
        const setId = r.u32();
        const size = r.u32();
        const path = r.str();
        keys.push(key);
        marks.push(formatOne(cfg, report, out, key, path, sets[setId], size));
      }
      w.begin(M_RESULT);
      w.u32(n);
      for (let i = 0; i < n; i++) {
        w.u32(keys[i]);
        w.u8(marks[i]);
      }
      w.u32(report.bytes);
      w.u32(report.files);
      w.u32(report.idx.length);
      for (let i = 0; i < report.idx.length; i++) {
        w.u32(report.idx[i]);
        w.u32(report.code[i]);
        w.u32(report.line[i]);
        w.u32(report.column[i]);
        w.str("" + report.took[i]);
        w.str(report.message[i]);
        w.str(report.lineText[i]);
      }
      w.end();
      writeFully(1, w.take());
    }
  }
}
