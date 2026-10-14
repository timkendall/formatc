// The processes that format, and the queue that feeds them. The files are added while they are found. With one thread (or few
// files) the main process formats them itself, when the walk is done. With more, child processes of the same executable
// (child.ts) get the files in chunks over their pipes, a few chunks at a time each, so that a big file never holds up the others.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { ByteBuf } from "../base/bytebuf.ts";
import { CHILD_ARG } from "./child.ts";
import type { OptionSet } from "./dispatch.ts";
import * as pipe from "./pipe.ts";
import { Target } from "./target.ts";
import { LoopCfg, Report, formatOne } from "./worker.ts";
import { M_CONFIG, M_JOBS, M_RESULT, M_SET, Reader, Wire, frameSize } from "./wire.ts";

// Files of at least this many bytes go to the lane that is looked at first (and are sent one by one).
const BIG = Number(process.env["FMT_BIG"] === undefined ? "262144" : (process.env["FMT_BIG"] as string));
// A new child process while this many files wait for each of those that run.
const SPAWN_BACKLOG = Number(process.env["FMT_SPAWN"] === undefined ? "32" : (process.env["FMT_SPAWN"] as string));
// The first child process is started when this many files wait. With fewer files than that in all, the main process does it.
const FIRST = Number(process.env["FMT_FIRST"] === undefined ? "48" : (process.env["FMT_FIRST"] as string));
// The most files in a chunk, and the chunks in flight to one child.
const CHUNK = Number(process.env["FMT_CHUNK"] === undefined ? "16" : (process.env["FMT_CHUNK"] as string));
const DEPTH = Number(process.env["FMT_DEPTH"] === undefined ? "2" : (process.env["FMT_DEPTH"] as string));

class Kid {
  proc: ChildProcess;
  inflight = 0;
  setsSent = 0;
  ended = false;
  pending: Buffer = Buffer.alloc(0);
  report = new Report();
  spawnAt = 0;
  firstAt = 0;
  lastAt = 0;
  constructor(proc: ChildProcess) {
    this.proc = proc;
  }
}

function fail(why: string): void {
  try {
    fs.writeSync(2, Buffer.from("error: a worker failed: " + why + "\n"));
  } catch (e) {
    // ignore
  }
  process.exit(2);
}

export class Pool {
  // the files by lane: path, option set, size; and the status of each (0 not formatted, pipe.ST_*)
  paths0: string[] = [];
  sets0: number[] = [];
  sizes0: number[] = [];
  status0: number[] = [];
  next0 = 0;
  paths1: string[] = [];
  sets1: number[] = [];
  sizes1: number[] = [];
  status1: number[] = [];
  next1 = 0;
  // the targets by lane and index in the lane
  targets0: Target[] = [];
  targets1: Target[] = [];
  optionSets: OptionSet[] = [];
  kids: Kid[] = [];
  threads: number;
  spawned = 0;
  gate: boolean;
  closed = false;
  reports: Report[] = [];
  cfg: LoopCfg;
  wire = new Wire();
  onJoined: (() => void) | null = null;
  joined: Promise<void>;
  constructor(threads: number, cfg: LoopCfg) {
    this.threads = threads;
    this.cfg = cfg;
    // When nothing is written, the files may be formatted from the first one; otherwise they wait for `finish` (the search can still fail).
    this.gate = !cfg.writes;
    this.joined = new Promise<void>((resolve) => {
      this.onJoined = resolve;
    });
  }

  // Adds a file to format. false if there are too many.
  add(t: Target, optionSets: OptionSet[]): boolean {
    this.optionSets = optionSets;
    if (t.size >= BIG) {
      const idx = this.paths1.length;
      this.paths1.push(t.path);
      this.sets1.push(t.setId);
      this.sizes1.push(t.size);
      this.status1.push(0);
      this.targets1[idx] = t;
      t.jobKey = idx * 2 + 1;
    } else {
      const idx = this.paths0.length;
      this.paths0.push(t.path);
      this.sets0.push(t.setId);
      this.sizes0.push(t.size);
      this.status0.push(0);
      this.targets0[idx] = t;
      t.jobKey = idx * 2;
    }
    return true;
  }

  // Files added and not sent.
  backlog(): number {
    return this.paths0.length - this.next0 + this.paths1.length - this.next1;
  }

  // Starts more children if there is enough to do, and sends what can be sent.
  flush(): void {
    if (this.threads <= 1) return;
    const queued = this.backlog();
    // With little to do, few children keep the kernel (which serializes the opening of files and directories) free for the walk.
    if (this.spawned === 0 && queued >= FIRST) this.spawnOne();
    while (this.spawned > 0 && this.spawned < this.threads && queued > SPAWN_BACKLOG * this.spawned) this.spawnOne();
    this.pump();
  }

  spawnOne(): void {
    const cfg = this.cfg;
    const proc = spawn(process.execPath, [CHILD_ARG], { stdio: ["pipe", "pipe", "inherit"] });
    const kid = new Kid(proc);
    kid.spawnAt = performance.now();
    this.spawned = this.spawned + 1;
    this.kids.push(kid);
    this.reports.push(kid.report);
    (proc.stdout as NonNullable<typeof proc.stdout>).on("data", (d: Buffer): void => this.onData(kid, d));
    proc.on("exit", (code: number | null): void => {
      if (!kid.ended) fail("a child process exited with " + code);
    });
    proc.on("error", (e: Error): void => fail(e.message));
    const w = this.wire;
    w.begin(M_CONFIG);
    w.u8(cfg.writes ? 1 : 0);
    w.u8(cfg.detail ? 1 : 0);
    w.u32(cfg.chunk);
    w.str(cfg.compareTo);
    w.str(cfg.compareRoot);
    w.str(cfg.dumpTo);
    w.str(cfg.cwd);
    w.end();
    (proc.stdin as NonNullable<typeof proc.stdin>).write(w.take());
  }

  // Gives every child that has room a chunk of files.
  pump(): void {
    if (!this.gate) return;
    const kids = this.kids;
    let progress = true;
    while (progress && this.backlog() > 0) {
      progress = false;
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i];
        if (kid.inflight < DEPTH && this.backlog() > 0) {
          this.send(kid);
          progress = true;
        }
      }
    }
  }

  send(kid: Kid): void {
    const w = this.wire;
    let lane = 0;
    let first = this.next0;
    let take = 0;
    if (this.next1 < this.paths1.length) {
      lane = 1;
      first = this.next1;
      take = 1;
    } else {
      const left = this.paths0.length - this.next0;
      take = Math.floor(left / (this.kids.length * 2));
      if (take > CHUNK) take = CHUNK;
      if (take < 1) take = 1;
    }
    const setIds = lane === 1 ? this.sets1 : this.sets0;
    const paths = lane === 1 ? this.paths1 : this.paths0;
    const sizes = lane === 1 ? this.sizes1 : this.sizes0;
    let maxSet = -1;
    for (let i = 0; i < take; i++) if (setIds[first + i] > maxSet) maxSet = setIds[first + i];
    while (kid.setsSent <= maxSet) {
      const s = this.optionSets[kid.setsSent];
      w.begin(M_SET);
      w.str(pipe.encodeSet(s.resolved, s.verifies));
      w.end();
      kid.setsSent = kid.setsSent + 1;
    }
    w.begin(M_JOBS);
    w.u32(take);
    for (let i = 0; i < take; i++) {
      w.u32((first + i) * 2 + lane);
      w.u32(setIds[first + i]);
      w.u32(sizes[first + i]);
      w.str(paths[first + i]);
    }
    w.end();
    if (lane === 1) this.next1 = this.next1 + take;
    else this.next0 = this.next0 + take;
    kid.inflight = kid.inflight + 1;
    (kid.proc.stdin as NonNullable<typeof kid.proc.stdin>).write(w.take());
  }

  onData(kid: Kid, d: Buffer): void {
    kid.lastAt = performance.now();
    if (kid.firstAt === 0) kid.firstAt = kid.lastAt;
    let b = d;
    if (kid.pending.length > 0) b = Buffer.concat([kid.pending, d]);
    let at = 0;
    while (true) {
      const have = b.length - at;
      const size = frameSize(b, at, have);
      if (size < 0 || have < size) break;
      if ((b[at] | 0) === M_RESULT) this.result(kid, new Reader(b, at + 5));
      at = at + size;
    }
    kid.pending = at === b.length ? Buffer.alloc(0) : Buffer.from(b.subarray(at));
    this.pump();
    this.checkJoined();
  }

  result(kid: Kid, r: Reader): void {
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const key = r.u32();
      const mark = r.u8();
      if ((key & 1) === 1) this.status1[key >> 1] = mark;
      else this.status0[key >> 1] = mark;
    }
    const rep = kid.report;
    rep.bytes = rep.bytes + r.u32();
    rep.files = rep.files + r.u32();
    const m = r.u32();
    for (let i = 0; i < m; i++) {
      rep.idx.push(r.u32());
      rep.code.push(r.u32());
      rep.line.push(r.u32());
      rep.column.push(r.u32());
      rep.took.push(Number(r.str()));
      rep.message.push(r.str());
      rep.lineText.push(r.str());
    }
    kid.inflight = kid.inflight - 1;
  }

  checkJoined(): void {
    if (!this.closed || this.onJoined === null || this.backlog() > 0) return;
    for (let i = 0; i < this.kids.length; i++) if (this.kids[i].inflight > 0) return;
    for (let i = 0; i < this.kids.length; i++) {
      const kid = this.kids[i];
      kid.ended = true;
      (kid.proc.stdin as NonNullable<typeof kid.proc.stdin>).end();
    }
    if (process.env["FMT_TRACE"] !== undefined) {
      let line = "kids (spawn/first/last ms):";
      for (let i = 0; i < this.kids.length; i++) line += " " + this.kids[i].spawnAt.toFixed(0) + "/" + this.kids[i].firstAt.toFixed(0) + "/" + this.kids[i].lastAt.toFixed(0);
      process.stderr.write(line + " now " + performance.now().toFixed(0) + "\n");
    }
    const f = this.onJoined;
    this.onJoined = null;
    f();
  }

  // The files are found: the last ones are sent, the gate opens, and the children stop when they have what is sent.
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.gate = true;
    this.flush();
    if (this.kids.length === 0) {
      this.formatHere();
      const f = this.onJoined as () => void;
      this.onJoined = null;
      f();
      return;
    }
    this.checkJoined();
  }

  // The main process formats what was not sent (all files, when there are few or one thread).
  formatHere(): void {
    const t0 = performance.now();
    const report = new Report();
    this.reports.push(report);
    const out = new ByteBuf(1 << 20);
    const sets = this.optionSets;
    for (let lane = 1; lane >= 0; lane--) {
      const paths = lane === 1 ? this.paths1 : this.paths0;
      const setIds = lane === 1 ? this.sets1 : this.sets0;
      const sizes = lane === 1 ? this.sizes1 : this.sizes0;
      const status = lane === 1 ? this.status1 : this.status0;
      let i = lane === 1 ? this.next1 : this.next0;
      for (; i < paths.length; i++) status[i] = formatOne(this.cfg, report, out, i * 2 + lane, paths[i], sets[setIds[i]], sizes[i]);
    }
    this.next0 = this.paths0.length;
    this.next1 = this.paths1.length;
    report.ms = performance.now() - t0;
  }

  // Waits for the children.
  async join(): Promise<void> {
    await this.joined;
  }

  // The status of every file of a lane: 0 not formatted, ST_* of pipe.ts.
  statusOf(lane: number): Uint8Array {
    const s = lane === 1 ? this.status1 : this.status0;
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] | 0;
    return out;
  }

  targetsOf(lane: number): Target[] {
    return lane === 1 ? this.targets1 : this.targets0;
  }
}
