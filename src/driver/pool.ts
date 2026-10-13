// The threads that format, and the queue that feeds them (pipe.ts). The files are added while they are found.
import { Worker } from "node:worker_threads";
import type { OptionSet } from "./dispatch.ts";
import * as pipe from "./pipe.ts";
import { Producer } from "./pipe.ts";
import type { PipeBufs } from "./pipe.ts";
import { Target } from "./target.ts";
import * as w from "./worker.ts";
import { LoopCfg, Report } from "./worker.ts";
import type { WorkerInit } from "./worker.ts";

// How the entry module starts a worker (which runs the entry module again).
export let spawnWorker: ((data: WorkerInit) => Worker) | null = null;

export function setSpawnWorker(f: (data: WorkerInit) => Worker): void {
  spawnWorker = f;
}

export interface WorkerMessage {
  idx: number[];
  code: number[];
  message: string[];
  line: number[];
  column: number[];
  lineText: string[];
  took: number[];
  bytes: number;
  files: number;
  ms: number;
}

// Files of at least this many bytes go to the lane that the workers look at first.
const BIG = Number(process.env["FMT_BIG"] === undefined ? "262144" : (process.env["FMT_BIG"] as string));

const SPAWN_BACKLOG = Number(process.env["FMT_SPAWN"] === undefined ? "128" : (process.env["FMT_SPAWN"] as string));

export class Pool {
  // the shared buffers (a field of an interface type with SharedArrayBuffers does not compile: a one-element array does)
  held: PipeBufs[] = [];
  producer: Producer;
  // the targets by lane and index in the lane
  targets0: Target[] = [];
  targets1: Target[] = [];
  setsAdded = 0;
  threads: number;
  spawned = 0;
  finished = 0;
  closed = false;
  reports: Report[] = [];
  cfg: LoopCfg;
  onJoined: (() => void) | null = null;
  joined: Promise<void>;
  constructor(threads: number, cfg: LoopCfg) {
    const b = pipe.newBufs();
    this.held.push(b);
    this.producer = new Producer(b);
    // When nothing is written, the workers may start with the first file; otherwise they wait for `finish` (the search can still fail).
    if (!cfg.writes) Atomics.store(new Int32Array(b.ctl), pipe.C_GATE, 1);
    this.threads = threads;
    this.cfg = cfg;
    this.joined = new Promise<void>((resolve) => {
      this.onJoined = resolve;
    });
  }

  // Adds a file to format. false if the queue is full.
  add(t: Target, optionSets: OptionSet[]): boolean {
    while (this.setsAdded <= t.setId) {
      const s = optionSets[this.setsAdded];
      this.producer.addSet(pipe.encodeSet(s.resolved, s.verifies));
      this.setsAdded = this.setsAdded + 1;
    }
    const lane = t.size >= BIG ? 1 : 0;
    const idx = this.producer.add(lane, t.path, t.setId, t.size);
    if (idx < 0) return false;
    if (lane === 1) this.targets1[idx] = t;
    else this.targets0[idx] = t;
    t.jobKey = idx * 2 + lane;
    return true;
  }

  // Makes the files that were added visible, and starts more workers if there is enough to do.
  flush(): void {
    this.producer.flush();
    // More workers while the files pile up faster than they are taken: with little to do, few workers keep the kernel (which
    // serializes the opening of files and directories) free for the walk.
    const queued = this.producer.lane0.count + this.producer.lane1.count;
    if (queued === 0) return;
    if (this.spawned === 0) this.spawnOne();
    while (this.spawned < this.threads && this.backlog() > SPAWN_BACKLOG * this.spawned) this.spawnOne();
  }

  bufsOf(): PipeBufs {
    return this.held[0];
  }

  spawnOne(): void {
    const cfg = this.cfg;
    const data: WorkerInit = {
      kind: 0,
      scan: null,
      ctrl: this.held[0].ctl,
      bufs: this.bufsOf(),
      id: this.spawned,
      cwd: cfg.cwd,
      writes: cfg.writes,
      detail: cfg.detail,
      chunk: cfg.chunk,
      compareTo: cfg.compareTo,
      compareRoot: cfg.compareRoot,
      dumpTo: cfg.dumpTo,
    };
    this.spawned = this.spawned + 1;
    const worker = (spawnWorker as (data: WorkerInit) => Worker)(data);
    worker.on("message", (m: WorkerMessage) => {
      const r = new Report();
      r.idx = m.idx;
      r.code = m.code;
      r.message = m.message;
      r.line = m.line;
      r.column = m.column;
      r.lineText = m.lineText;
      r.took = m.took;
      r.bytes = m.bytes;
      r.files = m.files;
      r.ms = m.ms;
      this.reports.push(r);
      this.finished = this.finished + 1;
      this.checkJoined();
    });
  }

  checkJoined(): void {
    if (this.closed && this.finished === this.spawned && this.onJoined !== null) {
      const f = this.onJoined;
      this.onJoined = null;
      f();
    }
  }

  // Files committed and not yet claimed (for FMT_TRACE).
  backlog(): number {
    const ctl = new Int32Array(this.held[0].ctl);
    return Atomics.load(ctl, pipe.C_COMMIT0) - Atomics.load(ctl, pipe.C_CLAIM0) + Atomics.load(ctl, pipe.C_COMMIT1) - Atomics.load(ctl, pipe.C_CLAIM1);
  }

  // The files are found: the last ones are made visible, the gate opens, and the workers stop when the queue is empty.
  finish(): void {
    if (this.closed) return;
    this.flush();
    this.producer.finish();
    this.closed = true;
    this.checkJoined();
  }

  // The calling thread takes files from the queue too, until it is empty.
  consumeHere(): void {
    this.reports.push(w.consume(this.bufsOf(), this.cfg));
  }

  // Waits for the workers, and returns the status of every file by lane: 0 not formatted, ST_* of pipe.ts.
  async join(): Promise<void> {
    await this.joined;
  }

  statusOf(lane: number): Uint8Array {
    const n = this.producer.count(lane);
    const out = new Uint8Array(n);
    if (n > 0) out.set(new Uint8Array(lane === 1 ? this.held[0].status1 : this.held[0].status0).subarray(0, n));
    return out;
  }

  targetsOf(lane: number): Target[] {
    return lane === 1 ? this.targets1 : this.targets0;
  }
}
