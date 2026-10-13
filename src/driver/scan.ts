// The walk of a directory tree, on all threads: `search` of vendor/bun/src/lint/driver/fmt/files.rs.
//
// The main thread walks the top of the tree breadth first until there are enough directories to share out; workers
// (claiming those directories atomically) walk everything below them, each directory in one piece: list it, leave out
// what is ignored, take the size of the files that are found. A worker reports the directories it has been in (with the
// entries that matter for configuration files) and the files, as plain arrays. The main thread then gives each
// directory its `Scope` (configuration files and `.editorconfig`, parents first) and each file its Target.
import { Worker } from "node:worker_threads";
import { publish, sharesPublishedGraphs } from "@scriptc/threads";
import { Configs, NAMES, Scope } from "./config.ts";
import * as fsx from "./fsx.ts";
import * as gitignore from "./gitignore.ts";
import { Glob } from "./glob.ts";
import { Ignored } from "./ignored.ts";
import * as paths from "./paths.ts";
import { Target } from "./target.ts";

// A predicate over the path relative to the working directory: `matches` (a file) or `enters` (a directory).
export class Tester {
  all: boolean;
  glob: Glob | null;
  isAbsolute: boolean;
  writtenBase0: string;
  base: string;
  cwd: string;
  isEnter: boolean;
  constructor(all: boolean, glob: Glob | null, isAbsolute: boolean, writtenBase0: string, base: string, cwd: string, isEnter: boolean) {
    this.all = all;
    this.glob = glob;
    this.isAbsolute = isAbsolute;
    this.writtenBase0 = writtenBase0;
    this.base = base;
    this.cwd = cwd;
    this.isEnter = isEnter;
  }
  test(relative: string): boolean {
    if (this.all) return true;
    let p = relative;
    if (this.isAbsolute) {
      const fromBase = paths.relative(this.base, paths.resolve(this.cwd, relative));
      p = paths.join(this.writtenBase0, fromBase);
    }
    const glob = this.glob as Glob;
    return this.isEnter ? glob.mayMatchInside(p) : glob.matches(p);
  }
}

// What a walk needs, and does not change.
export class ScanCtx {
  ignored: Ignored;
  matches: Tester;
  enters: Tester;
  cwd: string;
  // The size of the files is asked for (to sort the work by it).
  needsSizes: boolean;
  constructor(ignored: Ignored, matches: Tester, enters: Tester, cwd: string, needsSizes: boolean) {
    this.ignored = ignored;
    this.matches = matches;
    this.enters = enters;
    this.cwd = cwd;
    this.needsSizes = needsSizes;
  }
}

// What a thread found. Parallel arrays.
export class ScanOut {
  // The directories that were listed, parents first. `dirParent` is the index of the parent in this report, or -(r + 1)
  // for the directory that is the root `r` of a worker.
  dirPaths: string[] = [];
  dirParent: number[] = [];
  // The entries of a directory whose name is that of a configuration file, `.editorconfig`, `.git` or `.hg`.
  candStart: number[] = [];
  candEnd: number[] = [];
  candNames: string[] = [];
  candIsDir: number[] = [];
  filePaths: string[] = [];
  fileSizes: number[] = [];
  fileDir: number[] = [];
  hasLeftOut = false;
  ms = 0;
  buildMs = 0;
  roots = 0;
  // The directories left to go on with when a root has used up its budget: path, path from the working directory, and
  // the index of the parent in this report.
  leftPaths: string[] = [];
  leftRels: string[] = [];
  leftParents: number[] = [];
}

export interface ScanOutShape {
  dirPaths: string[];
  dirParent: number[];
  candStart: number[];
  candEnd: number[];
  candNames: string[];
  candIsDir: number[];
  filePaths: string[];
  fileSizes: number[];
  fileDir: number[];
  hasLeftOut: boolean;
  ms: number;
  buildMs: number;
  roots: number;
  leftPaths: string[];
  leftRels: string[];
  leftParents: number[];
}

let candidates: Set<string> | null = null;

function isCandidate(name: string): boolean {
  const c0 = name.charCodeAt(0);
  // '.', 'p', 'o', 'P', 'O'
  if (!(c0 === 46 || c0 === 112 || c0 === 111 || c0 === 80 || c0 === 79)) return false;
  if (candidates === null) {
    const set = new Set<string>();
    set.add(".git");
    set.add(".hg");
    set.add(".editorconfig");
    for (let i = 0; i < NAMES.length; i++) set.add(NAMES[i].toLowerCase());
    candidates = set;
  }
  return candidates.has(name.toLowerCase());
}

// Lists the directory at `path` (`rel`: from the working directory) and adds what is found to `out`. The directories
// to go on with are appended to the queue.
export function scanDirectory(ctx: ScanCtx, path: string, rel: string, parent: number, out: ScanOut, qPaths: string[], qRels: string[], qParents: number[]): void {
  const entries = fsx.list(path);
  if (entries === null) return;
  const d = out.dirPaths.length;
  out.dirPaths.push(path);
  out.dirParent.push(parent);
  out.candStart.push(out.candNames.length);
  const ignored = ctx.ignored;
  const matches = ctx.matches;
  const enters = ctx.enters;
  const cwd = ctx.cwd;
  const nonLocal = rel.startsWith("..") || rel.charCodeAt(0) === 47;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const name = entry.name;
    if (isCandidate(name)) {
      out.candNames.push(name);
      out.candIsDir.push(entry.isDirectory ? 1 : 0);
    }
    // Links are not followed, and not formatted.
    if (entry.isLink) continue;
    const full = paths.join(path, name);
    if (ignored.isNotSearched(full, name, entry.isDirectory)) continue;
    const relative = nonLocal ? paths.relative(cwd, full) : rel === "" ? name : rel + "/" + name;
    if (ignored.ignoresEntry(full, entry.isDirectory)) {
      if (entry.isDirectory ? enters.test(relative) : matches.test(relative)) out.hasLeftOut = true;
      continue;
    }
    if (entry.isDirectory) {
      if (enters.test(relative)) {
        qPaths.push(full);
        qRels.push(relative);
        qParents.push(d);
      }
    } else if (matches.test(relative)) {
      if (ctx.needsSizes) {
        const kind = fsx.linkKindAndSize(full);
        if (kind === fsx.K_LINK) continue;
        out.fileSizes.push(kind === fsx.K_NONE ? 0 : fsx.outSize);
      } else out.fileSizes.push(0);
      out.filePaths.push(full);
      out.fileDir.push(d);
    }
  }
  out.candEnd.push(out.candNames.length);
}

// ---- the worker ----

// What a worker is given: strings, numbers and flat arrays of them. (Objects with methods and arrays of objects are not
// shared between threads: a worker that reads a published array of objects through a recursive function sees
// corrupted elements, so the worker makes its own objects from this.)
export class ScanTask {
  cwd: string;
  directories: string[];
  sourceDirs: string[];
  sourceTexts: string[];
  negativeSources: string[];
  // the testers: whether all paths, the glob source, `isAbsolute`, `writtenBase0`, `base`
  testAll: boolean;
  testGlob: string;
  testIsAbsolute: boolean;
  testWrittenBase0: string;
  testBase: string;
  needsSizes: boolean;
  roots: string[];
  rels: string[];
  // How many directories a worker lists below a root before it hands the rest back.
  budget: number;
  constructor(ctx: ScanCtx, roots: string[], rels: string[], budget: number) {
    const ig = ctx.ignored;
    this.cwd = ctx.cwd;
    this.directories = ig.directories;
    this.sourceDirs = ig.sourceDirs;
    this.sourceTexts = ig.sourceTexts;
    this.negativeSources = ig.negativeSources;
    const m = ctx.matches;
    this.testAll = m.all;
    this.testGlob = m.glob === null ? "" : m.glob.source;
    this.testIsAbsolute = m.isAbsolute;
    this.testWrittenBase0 = m.writtenBase0;
    this.testBase = m.base;
    this.needsSizes = ctx.needsSizes;
    this.roots = roots;
    this.rels = rels;
    this.budget = budget;
  }
}

function buildCtx(task: ScanTask): ScanCtx {
  const ignored = Ignored.rebuild(task.directories, task.sourceDirs, task.sourceTexts, task.negativeSources, task.cwd);
  let glob: Glob | null = null;
  if (!task.testAll) glob = new Glob(task.testGlob);
  const matches = new Tester(task.testAll, glob, task.testIsAbsolute, task.testWrittenBase0, task.testBase, task.cwd, false);
  const enters = new Tester(task.testAll, glob, task.testIsAbsolute, task.testWrittenBase0, task.testBase, task.cwd, true);
  return new ScanCtx(ignored, matches, enters, task.cwd, task.needsSizes);
}

// Walks the subtrees `task.roots` that this worker claims (each for at most `task.budget` directories), and returns
// what it found and what is left.
export function runScan(task: ScanTask, ctrl: Int32Array): ScanOut {
  const out = new ScanOut();
  const tStart = performance.now();
  const ctx = buildCtx(task);
  out.buildMs = performance.now() - tStart;
  const n = task.roots.length;
  while (true) {
    const r = Atomics.add(ctrl, 0, 1);
    if (r >= n) break;
    out.roots = out.roots + 1;
    walkRoot(ctx, task.roots[r], task.rels[r], -(r + 1), task.budget, out);
  }
  out.ms = performance.now() - tStart;
  return out;
}

// The subtree of `root`: depth first, for at most `budget` directories.
function walkRoot(ctx: ScanCtx, root: string, rel: string, parent: number, budget: number, out: ScanOut): void {
  const qPaths: string[] = [root];
  const qRels: string[] = [rel];
  const qParents: number[] = [parent];
  let processed = 0;
  while (qPaths.length > 0) {
    if (processed >= budget) {
      for (let i = 0; i < qPaths.length; i++) {
        out.leftPaths.push(qPaths[i]);
        out.leftRels.push(qRels[i]);
        out.leftParents.push(qParents[i]);
      }
      return;
    }
    const path = qPaths.pop() as string;
    const r = qRels.pop() as string;
    const p = qParents.pop() as number;
    scanDirectory(ctx, path, r, p, out, qPaths, qRels, qParents);
    processed = processed + 1;
  }
}

// How the entry module starts a scan worker.
export let spawnScanWorker: ((task: ScanTask, ctrl: SharedArrayBuffer) => Worker) | null = null;

export function setSpawnScanWorker(f: (task: ScanTask, ctrl: SharedArrayBuffer) => Worker): void {
  spawnScanWorker = f;
}

export let searchError = "";

// The directories searched in one round: workers claim them one by one.
function runRound(task: ScanTask, nthreads: number): Promise<ScanOutShape[]> {
  const published = publish(task);
  const ctrl = new SharedArrayBuffer(64);
  const outs: ScanOutShape[] = [];
  return new Promise<ScanOutShape[]>((resolve) => {
    let finished = 0;
    for (let i = 0; i < nthreads; i++) {
      const worker = (spawnScanWorker as (task: ScanTask, ctrl: SharedArrayBuffer) => Worker)(published, ctrl);
      worker.on("message", (m: ScanOutShape) => {
        outs.push(m);
        finished = finished + 1;
        if (finished === nthreads) resolve(outs);
      });
    }
  });
}

// Where the scopes of the directories and the targets of the files are made.
class Merge {
  configs: Configs;
  above: Scope;
  scopes: Scope[] = [];
  // Per directory: whether `ignorePatterns` of a configuration leave out what is in it (as the search of Rust would), when the
  // directory does not start over with a configuration of its own.
  levels: boolean[] = [];
  targets: Target[] = [];
  failed = false;
  constructor(configs: Configs, above: Scope) {
    this.configs = configs;
    this.above = above;
  }

  // Adds a report. `rootParents[r]`: the global index of the parent of the root `r`, or -1 for the directory that is
  // searched. Returns the global index of the first directory of the report.
  add(o: ScanOutShape, rootParents: number[]): number {
    const base = this.scopes.length;
    for (let d = 0; d < o.dirPaths.length; d++) {
      const p = o.dirParent[d];
      let parentScope: Scope | null = null;
      if (p >= 0) parentScope = this.scopes[base + p];
      else if (rootParents[-p - 1] >= 0) parentScope = this.scopes[rootParents[-p - 1]];
      let scope: Scope;
      if (parentScope === null) {
        // the directory that is searched: its scope is that of the directory
        scope = this.above;
      } else {
        const start = o.candStart[d];
        const end = o.candEnd[d];
        if (start === end) scope = parentScope;
        else {
          const entries: fsx.Entry[] = [];
          for (let k = start; k < end; k++) entries.push(new fsx.Entry(o.candNames[k], o.candIsDir[k] === 1, false));
          const f = this.configs.forListedDirectory(o.dirPaths[d], entries, parentScope);
          if (f.scope === null) {
            searchError = f.error === null ? "" : f.error;
            this.failed = true;
            return base;
          }
          scope = f.scope;
        }
      }
      this.scopes.push(scope);
      if (this.configs.anyIgnores) {
        let flag: boolean;
        let startsOver = false;
        if (parentScope === null) flag = gitignore.isDirectoryIgnoredAnywhere(this.configs.ignoresOf(scope), o.dirPaths[d]);
        else {
          const pIndex = p >= 0 ? base + p : rootParents[-p - 1];
          flag = this.levels[pIndex] || gitignore.isIgnored(this.configs.ignoresOf(parentScope), o.dirPaths[d], true);
          startsOver = parentScope.config !== scope.config;
        }
        this.levels.push(flag && !startsOver);
      }
    }
    for (let i = 0; i < o.filePaths.length; i++) {
      const dir = base + o.fileDir[i];
      if (this.configs.anyIgnores && (this.levels[dir] || gitignore.isIgnored(this.configs.ignoresOf(this.scopes[dir]), o.filePaths[i], false))) continue;
      this.targets.push(new Target(o.filePaths[i], o.fileSizes[i], this.scopes[dir], false, false));
    }
    return base;
  }
}

// The files in `base` that `matches` says yes to. null on a fatal error (the message is in `searchError`).
export async function search(configs: Configs, ignored: Ignored, base: string, matches: Tester, enters: Tester, threads: number, needsSizes: boolean, hook: ((t: Target) => void) | null, batch: (() => void) | null): Promise<Target[] | null> {
  const above = configs.forDirectory(base);
  if (above.scope === null) {
    searchError = above.error === null ? "" : above.error;
    return null;
  }
  const cwd = ignored.cwd;
  const trace = process.env["FMT_TRACE"] !== undefined;
  const t0 = performance.now();
  // Under Node the workers get copies without methods: the walk is all here.
  if (!sharesPublishedGraphs) threads = 1;
  const ctx = new ScanCtx(ignored, matches, enters, cwd, needsSizes);
  const merge = new Merge(configs, above.scope);
  if (threads <= 1) {
    // One thread walks, directory by directory (breadth first), and every file is handed to `hook` as soon as its directory is
    // done, so that the formatting starts while the walk goes on.
    const qPaths: string[] = [base];
    const qRels: string[] = [paths.relative(cwd, base)];
    const qParents: number[] = [-1];
    let head = 0;
    let hookedHere = 0;
    while (head < qPaths.length) {
      const o = new ScanOut();
      const nPaths: string[] = [];
      const nRels: string[] = [];
      const nParents: number[] = [];
      scanDirectory(ctx, qPaths[head], qRels[head], -1, o, nPaths, nRels, nParents);
      const parentOfDir = qParents[head];
      qPaths[head] = "";
      qRels[head] = "";
      head = head + 1;
      if (o.hasLeftOut) ignored.hasLeftOut = true;
      const at = merge.add(o, [parentOfDir]);
      if (merge.failed) return null;
      for (let i = 0; i < nPaths.length; i++) {
        qPaths.push(nPaths[i]);
        qRels.push(nRels[i]);
        qParents.push(at);
      }
      if (hook !== null) {
        while (hookedHere < merge.targets.length) {
          hook(merge.targets[hookedHere]);
          hookedHere = hookedHere + 1;
        }
        if (batch !== null) batch();
      }
    }
    if (trace) process.stderr.write("scan: " + head + " dirs in one thread " + (performance.now() - t0).toFixed(1) + "ms\n");
    return merge.targets;
  }
  // the top of the tree, breadth first, here
  const prelude = new ScanOut();
  let qPaths: string[] = [base];
  let qRels: string[] = [paths.relative(cwd, base)];
  let qParents: number[] = [-1];
  const wanted = threads > 1 ? threads * 2 : 1 << 30;
  let processed = 0;
  while (qPaths.length > 0 && !(qPaths.length >= wanted || (processed >= 100 && threads > 1))) {
    const nPaths: string[] = [];
    const nRels: string[] = [];
    const nParents: number[] = [];
    for (let i = 0; i < qPaths.length; i++) {
      scanDirectory(ctx, qPaths[i], qRels[i], qParents[i], prelude, nPaths, nRels, nParents);
      processed = processed + 1;
    }
    qPaths = nPaths;
    qRels = nRels;
    qParents = nParents;
  }
  if (prelude.hasLeftOut) ignored.hasLeftOut = true;
  const preludeBase = merge.add(prelude, [-1]);
  if (merge.failed) return null;
  // the directories that are left are the roots of the first round
  let rootParents: number[] = [];
  for (let r = 0; r < qParents.length; r++) rootParents.push(preludeBase + qParents[r]);
  const t1 = performance.now();
  let rounds = 0;
  let hooked = 0;
  while (qPaths.length > 0) {
    rounds = rounds + 1;
    const nthreads = Math.min(threads, qPaths.length);
    const tr0 = performance.now();
    const task = new ScanTask(ctx, qPaths, qRels, 40);
    const pending = runRound(task, nthreads);
    // while the workers walk, the main thread has a look at the files found so far
    if (hook !== null) {
      while (hooked < merge.targets.length) {
        hook(merge.targets[hooked]);
        hooked = hooked + 1;
      }
      if (batch !== null) batch();
    }
    const outs = await pending;
    const tr1 = performance.now();
    qPaths = [];
    qRels = [];
    const nextParents: number[] = [];
    for (let w = 0; w < outs.length; w++) {
      const o = outs[w];
      if (o.hasLeftOut) ignored.hasLeftOut = true;
      const oBase = merge.add(o, rootParents);
      if (merge.failed) return null;
      for (let i = 0; i < o.leftPaths.length; i++) {
        qPaths.push(o.leftPaths[i]);
        qRels.push(o.leftRels[i]);
        nextParents.push(oBase + o.leftParents[i]);
      }
    }
    rootParents = nextParents;
    if (trace) {
      let maxMs = 0;
      let sumMs = 0;
      let buildMs = 0;
      let dirs = 0;
      let files = 0;
      for (let w = 0; w < outs.length; w++) {
        if (outs[w].ms > maxMs) maxMs = outs[w].ms;
        sumMs = sumMs + outs[w].ms;
        buildMs = buildMs + outs[w].buildMs;
        dirs = dirs + outs[w].dirPaths.length;
        files = files + outs[w].filePaths.length;
      }
      process.stderr.write("  round " + rounds + ": " + nthreads + " threads, " + dirs + " dirs " + files + " files, sum " + sumMs.toFixed(1) + "ms (build " + buildMs.toFixed(1) + "), wait " + (tr1 - tr0).toFixed(1) + "ms (slowest worker " + maxMs.toFixed(1) + "ms), merge " + (performance.now() - tr1).toFixed(1) + "ms, left " + qPaths.length + "\n");
    }
  }
  if (hook !== null) {
    while (hooked < merge.targets.length) {
      hook(merge.targets[hooked]);
      hooked = hooked + 1;
    }
    if (batch !== null) batch();
  }
  if (trace) process.stderr.write("scan: prelude " + (t1 - t0).toFixed(1) + "ms (" + processed + " dirs), " + rounds + " rounds " + (performance.now() - t1).toFixed(1) + "ms\n");
  return merge.targets;
}
