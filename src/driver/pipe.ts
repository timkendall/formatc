// The queue between the thread that finds files (the producer: the main thread, while it walks the tree) and the threads
// that format them (the consumers). Everything is in SharedArrayBuffers that are used the way the cookbook allows: the
// control words with `Atomics`, and bulk copies (`Buffer.copy`, `set(subarray)`) for the rest, never a loop over a
// shared typed array.
//
//   lane 0: the files; lane 1: the big ones (workers look there first, so that the largest files start early).
//   per lane: `meta` (4 ints per file: offset and length of the path in `arena`, the option set, the size), `arena` (the
//   UTF-8 bytes of the paths), `status` (one byte per file, written by the worker that formats it).
//   the option sets are texts in `setArena` (`setMeta`: offset, length).
//
// The producer writes a batch of files and then commits it (`Atomics.store` of the number of files, which is also the release).
// A consumer claims files with a compare-exchange on the claim counter, up to what is committed.
import { Resolved } from "./options.ts";

// Control words, 16 ints (a cache line each) apart.
export const C_EVENT = 0; // changes with every commit: consumers wait on it
export const C_COMMIT0 = 16;
export const C_CLAIM0 = 32;
export const C_COMMIT1 = 48;
export const C_CLAIM1 = 64;
export const C_DONE = 80; // the producer has nothing more to add
export const C_GATE = 96; // consumers may start (not before, when the files are written)
export const C_SETS = 112; // the number of option sets that are written
export const C_WORKING = 128; // consumers that are still running
export const C_WAITERS = 144; // consumers that sleep in `Atomics.wait` on C_EVENT
export const CTL_BYTES = 256 * 4;

export const CAP_ITEMS0 = 1 << 23;
export const CAP_ITEMS1 = 1 << 20;
export const ARENA_BYTES0 = 1 << 30;
export const ARENA_BYTES1 = 1 << 27;
export const CAP_SETS = 1 << 16;
export const SET_ARENA_BYTES = 1 << 25;

// The buffers, which a worker is given. An interface: a plain object is what crosses the thread boundary.
export interface PipeBufs {
  // (an interface of nothing but SharedArrayBuffers does not compile as a field type)
  version: number;
  ctl: SharedArrayBuffer;
  meta0: SharedArrayBuffer;
  arena0: SharedArrayBuffer;
  status0: SharedArrayBuffer;
  meta1: SharedArrayBuffer;
  arena1: SharedArrayBuffer;
  status1: SharedArrayBuffer;
  setMeta: SharedArrayBuffer;
  setArena: SharedArrayBuffer;
}

export function newBufs(): PipeBufs {
  return {
    version: 1,
    ctl: new SharedArrayBuffer(CTL_BYTES),
    meta0: new SharedArrayBuffer(CAP_ITEMS0 * 16),
    arena0: new SharedArrayBuffer(ARENA_BYTES0),
    status0: new SharedArrayBuffer(CAP_ITEMS0),
    meta1: new SharedArrayBuffer(CAP_ITEMS1 * 16),
    arena1: new SharedArrayBuffer(ARENA_BYTES1),
    status1: new SharedArrayBuffer(CAP_ITEMS1),
    setMeta: new SharedArrayBuffer(CAP_SETS * 8),
    setArena: new SharedArrayBuffer(SET_ARENA_BYTES),
  };
}

export const ST_NONE = 0;
export const ST_UNCHANGED = 1;
export const ST_DIFFERENT = 2;
// anything else: the report of the worker has the details
export const ST_OTHER = 3;

// ---- the text of an option set ----

function esc(s: string): string {
  if (s.indexOf("%") < 0 && s.indexOf("\u0001") < 0 && s.indexOf("\u0002") < 0) return s;
  return s.split("%").join("%25").split("\u0001").join("%01").split("\u0002").join("%02");
}

function unesc(s: string): string {
  if (s.indexOf("%") < 0) return s;
  return s.split("%01").join("\u0001").split("%02").join("\u0002").split("%25").join("%");
}

// `verifies` + the flags + "\u0001name\u0002value" for each option.
export function encodeSet(r: Resolved, verifies: boolean): string {
  let t = verifies ? "v" : "-";
  t += r.omitsFinalNewline ? "n" : "-";
  t += r.toml ? "t" : "-";
  t += r.isOxfmt ? "o" : "-";
  for (let i = 0; i < r.names.length; i++) t += "\u0001" + esc(r.names[i]) + "\u0002" + esc(r.values[i]);
  // The options about sorting imports (`Resolved.sortNames`): their names start with U+0004.
  for (let i = 0; i < r.sortNames.length; i++) t += "\u0001\u0004" + esc(r.sortNames[i]) + "\u0002" + esc(r.sortValues[i]);
  return t;
}

export let decodedVerifies = false;

export function decodeSet(t: string): Resolved {
  decodedVerifies = t.charCodeAt(0) === 118;
  const r = new Resolved();
  r.omitsFinalNewline = t.charCodeAt(1) === 110;
  r.toml = t.charCodeAt(2) === 116;
  r.isOxfmt = t.charCodeAt(3) === 111;
  const parts = t.split("\u0001");
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const at = p.indexOf("\u0002");
    if (p.charCodeAt(0) === 4) {
      r.sortNames.push(unesc(p.substring(1, at)));
      r.sortValues.push(unesc(p.substring(at + 1)));
    } else r.set(unesc(p.substring(0, at)), unesc(p.substring(at + 1)));
  }
  r.finish();
  return r;
}

// ---- the producer ----

class Lane {
  meta: Int32Array;
  arena: Buffer;
  capItems: number;
  capBytes: number;
  // committed
  count = 0;
  bytes = 0;
  // staged, not yet visible
  stage: Buffer;
  stageMeta: Int32Array;
  stagedCount = 0;
  stagedBytes = 0;
  commitIdx: number;
  constructor(meta: SharedArrayBuffer, arena: SharedArrayBuffer, capItems: number, capBytes: number, commitIdx: number) {
    this.meta = new Int32Array(meta);
    this.arena = Buffer.from(arena);
    this.capItems = capItems;
    this.capBytes = capBytes;
    this.stage = Buffer.alloc(1 << 18);
    this.stageMeta = new Int32Array(4 * 2048);
    this.commitIdx = commitIdx;
  }
}

export class Producer {
  ctl: Int32Array;
  lane0: Lane;
  lane1: Lane;
  setMeta: Int32Array;
  setArena: Buffer;
  sets = 0;
  setBytes = 0;
  // set when a lane is full: the caller reports "too many files"
  full = false;
  constructor(b: PipeBufs) {
    this.ctl = new Int32Array(b.ctl);
    this.lane0 = new Lane(b.meta0, b.arena0, CAP_ITEMS0, ARENA_BYTES0, C_COMMIT0);
    this.lane1 = new Lane(b.meta1, b.arena1, CAP_ITEMS1, ARENA_BYTES1, C_COMMIT1);
    this.setMeta = new Int32Array(b.setMeta);
    this.setArena = Buffer.from(b.setArena);
  }

  // Adds an option set (the next id). It is visible before any file that names it.
  addSet(text: string): number {
    const id = this.sets;
    const len = this.setArena.write(text, this.setBytes, "utf8");
    this.setMeta[id * 2] = this.setBytes;
    this.setMeta[id * 2 + 1] = len;
    this.setBytes = this.setBytes + len;
    this.sets = id + 1;
    Atomics.store(this.ctl, C_SETS, this.sets);
    return id;
  }

  // Adds a file to lane 0 or 1: its index in the lane. Not visible before `flush`.
  add(lane: number, path: string, setId: number, size: number): number {
    const l = lane === 1 ? this.lane1 : this.lane0;
    const maxLen = path.length * 3;
    if (l.stagedBytes + maxLen > l.stage.length || l.stagedCount === 2048) this.flushLane(l);
    if (maxLen > l.stage.length) {
      // a path of more than 64 KB: not on any file system
      this.full = true;
      return -1;
    }
    if (l.count + l.stagedCount >= l.capItems || l.bytes + l.stagedBytes + maxLen > l.capBytes) {
      this.full = true;
      return -1;
    }
    const len = l.stage.write(path, l.stagedBytes, "utf8");
    const row = l.stagedCount * 4;
    const sm = l.stageMeta;
    sm[row] = (l.bytes + l.stagedBytes) | 0;
    sm[row + 1] = len | 0;
    sm[row + 2] = setId | 0;
    sm[row + 3] = size > 2147483647 ? 2147483647 : size | 0;
    l.stagedBytes = l.stagedBytes + len;
    l.stagedCount = l.stagedCount + 1;
    return l.count + l.stagedCount - 1;
  }

  private flushLane(l: Lane): void {
    const k = l.stagedCount;
    if (k === 0) return;
    l.stage.copy(l.arena, l.bytes, 0, l.stagedBytes);
    l.meta.set(l.stageMeta.subarray(0, k * 4), l.count * 4);
    l.count = l.count + k;
    l.bytes = l.bytes + l.stagedBytes;
    l.stagedCount = 0;
    l.stagedBytes = 0;
    Atomics.store(this.ctl, l.commitIdx, l.count);
    this.bump();
  }

  // Makes what was added visible to the consumers.
  flush(): void {
    this.flushLane(this.lane1);
    this.flushLane(this.lane0);
  }

  bump(): void {
    Atomics.add(this.ctl, C_EVENT, 1);
    if (Atomics.load(this.ctl, C_WAITERS) > 0) Atomics.notify(this.ctl, C_EVENT);
  }

  openGate(): void {
    Atomics.store(this.ctl, C_GATE, 1);
    this.bump();
  }

  // Nothing more will be added.
  finish(): void {
    this.flush();
    Atomics.store(this.ctl, C_DONE, 1);
    Atomics.store(this.ctl, C_GATE, 1);
    this.bump();
  }

  count(lane: number): number {
    return lane === 1 ? this.lane1.count + this.lane1.stagedCount : this.lane0.count + this.lane0.stagedCount;
  }
}
