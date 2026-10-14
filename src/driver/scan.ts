// The walk of a directory tree: `search` of vendor/bun/src/lint/driver/fmt/files.rs.
//
// The main thread walks the top of the tree breadth first until there are enough directories to share out; workers
// (claiming those directories atomically) walk everything below them, each directory in one piece: list it, leave out
// what is ignored, take the size of the files that are found. A worker reports the directories it has been in (with the
// entries that matter for configuration files) and the files, as plain arrays. The main thread then gives each
// directory its `Scope` (configuration files and `.editorconfig`, parents first) and each file its Target.
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

export let searchError = "";

// Whether the walk gives the event loop a turn now and then (when child processes format the files while it goes on).
let yieldTurns = false;
const YIELD_EVERY = Number(process.env["FMT_YIELD"] === undefined ? "8" : (process.env["FMT_YIELD"] as string));

export function setYieldTurns(on: boolean): void {
  yieldTurns = on;
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
  const ctx = new ScanCtx(ignored, matches, enters, cwd, needsSizes);
  const merge = new Merge(configs, above.scope);
  {
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
      // let the event loop deliver what the child processes have reported
      if (yieldTurns && head % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (trace) process.stderr.write("scan: " + head + " dirs in one thread " + (performance.now() - t0).toFixed(1) + "ms\n");
    return merge.targets;
  }
}
