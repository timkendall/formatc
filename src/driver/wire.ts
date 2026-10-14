// The messages between the main process and the child processes that format (pool.ts, child.ts), over the pipes of the child.
// A message is `type` (1 byte), the length of the payload (4 bytes, little endian) and the payload: 4-byte integers and
// strings (a length and UTF-8 bytes).
//
//   main -> child:  C config   S option set (its text)   J jobs (key, set, size, path each)      end of input: no more jobs
//   child -> main:  R results  the status of each job, and the reports of those that need words
import { ByteBuf } from "../base/bytebuf.ts";

export const M_CONFIG = 67; // C
export const M_SET = 83; // S
export const M_JOBS = 74; // J
export const M_RESULT = 82; // R

export class Wire {
  buf: ByteBuf = new ByteBuf(1 << 12);
  // where the message that is being written starts
  msgAt = 0;

  begin(type: number): void {
    this.msgAt = this.buf.len;
    this.buf.push(type);
    this.buf.push(0);
    this.buf.push(0);
    this.buf.push(0);
    this.buf.push(0);
  }

  u8(v: number): void {
    this.buf.push(v & 255);
  }

  u32(v: number): void {
    const b = this.buf;
    b.push(v & 255);
    b.push((v >> 8) & 255);
    b.push((v >> 16) & 255);
    b.push((v >> 24) & 255);
  }

  str(s: string): void {
    const bytes = Buffer.from(s, "utf8");
    this.u32(bytes.length);
    this.buf.append(bytes, 0, bytes.length);
  }

  // The message is complete: its length is filled in.
  end(): void {
    const n = this.buf.len - this.msgAt - 5;
    const d = this.buf.data;
    d[this.msgAt + 1] = n & 255;
    d[this.msgAt + 2] = (n >> 8) & 255;
    d[this.msgAt + 3] = (n >> 16) & 255;
    d[this.msgAt + 4] = (n >> 24) & 255;
  }

  // Everything that was written (any number of messages), and start over.
  take(): Buffer {
    const out = Buffer.from(this.buf.view());
    this.buf.reset();
    return out;
  }
}

export class Reader {
  b: Buffer;
  pos: number;
  constructor(b: Buffer, pos: number) {
    this.b = b;
    this.pos = pos;
  }

  u8(): number {
    const v = this.b[this.pos] | 0;
    this.pos = this.pos + 1;
    return v;
  }

  u32(): number {
    const b = this.b;
    const p = this.pos;
    this.pos = p + 4;
    return ((b[p] | 0) | ((b[p + 1] | 0) << 8) | ((b[p + 2] | 0) << 16) | ((b[p + 3] | 0) << 24)) | 0;
  }

  str(): string {
    const n = this.u32();
    const s = this.b.toString("utf8", this.pos, this.pos + n);
    this.pos = this.pos + n;
    return s;
  }
}

// The length of the message that starts at `at` in `b` (with `have` bytes after it), or -1 if its header is not complete.
export function frameSize(b: Buffer, at: number, have: number): number {
  if (have < 5) return -1;
  const n = ((b[at + 1] | 0) | ((b[at + 2] | 0) << 8) | ((b[at + 3] | 0) << 16) | ((b[at + 4] | 0) << 24)) | 0;
  return 5 + n;
}
