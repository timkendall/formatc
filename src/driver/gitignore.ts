// `.gitignore` and other files in its format. Port of vendor/bun/src/lint/driver/gitignore.rs.
//
// Prettier only reads the ones in the working directory (as the npm package `ignore` reads them); oxfmt reads every
// `.gitignore` on its way, as Git does, with the crate `ignore`. This module finds the files and tracks which directory
// each file's lines belong to; `ignore.ts` decides what a line matches.
import * as fsx from "./fsx.ts";
import { IgnoreRules, V_IGNORED, V_KEPT } from "./ignore.ts";
import * as paths from "./paths.ts";

// The ignore files that count in a directory: those in it, and those above it.
export class Ignores {
  // What the lines are relative to.
  directory: string;
  rules: IgnoreRules;
  // As Prettier reads them (the npm package `ignore`), not as oxfmt does.
  isOfPrettier: boolean;
  above: Ignores | null;
  constructor(directory: string, rules: IgnoreRules, isOfPrettier: boolean, above: Ignores | null) {
    this.directory = directory;
    this.rules = rules;
    this.isOfPrettier = isOfPrettier;
    this.above = above;
  }

  // Whether one of the `..` that `path` starts with is ignored. To the package `ignore` they are directories like any other:
  // `.*` has them, and so all that is not in the directory of the file.
  ignoresAWayUp(path: string): boolean {
    const parts = path.split("/");
    let ups = 0;
    while (ups < parts.length && parts[ups] === "..") ups = ups + 1;
    for (let up = 1; up <= ups; up++) {
      const end = 3 * up - 1;
      if (end > path.length) break;
      if (this.rules.verdict(path.substring(0, end), true) === V_IGNORED) return true;
    }
    return false;
  }
}

export type Chain = Ignores | null;

function withRules(chain: Chain, directory: string, rules: IgnoreRules, isForOxc: boolean): Chain {
  if (rules.isEmpty()) return chain;
  return new Ignores(directory, rules, !isForOxc, chain);
}

// `chain` and the lines of `text`, which is what a file has. They are relative to `directory`. `isForOxc`: as oxlint and
// oxfmt read them. Otherwise as Prettier does.
export function withText(chain: Chain, directory: string, text: string, isForOxc: boolean = false): Chain {
  return withRules(chain, directory, IgnoreRules.fromText(text, isForOxc), isForOxc);
}

// `chain` and `lines`, which are arguments of oxfmt, or the elements of an array in a configuration file of theirs.
export function withLines(chain: Chain, directory: string, lines: string[]): Chain {
  return withRules(chain, directory, IgnoreRules.fromLines(lines, true), true);
}

// The first of `lines` that oxfmt does not take, or "".
export function refusedLine(lines: string[]): string {
  const rules = IgnoreRules.fromLines(lines, true);
  return rules.refused.length > 0 ? rules.refused[0] : "";
}

// `chain` and `file`, whose lines are relative to `directory`.
export function withFile(chain: Chain, directory: string, file: string, isForOxc: boolean): Chain {
  const text = fsx.readText(file);
  if (text === null) return chain;
  return withText(chain, directory, text, isForOxc);
}

function isAtOrAbove(above: string, below: string): boolean {
  return above === below || paths.inside(above, below) !== null;
}

// 0: no file says anything about it, 1: ignored, 2: kept. The nearest file that says anything about it decides, and in
// that file the last line.
function decide(chain: Chain, path: string, isDirectory: boolean, isInSearch: boolean): number {
  let next = chain;
  while (next !== null) {
    const directory = next.directory;
    let inside = paths.inside(directory, path);
    if (inside === null) {
      if (isAtOrAbove(path, directory)) {
        // No pattern is about the directory of the file, or about one that it is in.
        inside = null;
      } else if (next.isOfPrettier) {
        // Prettier asks the package `ignore` about `../src/a.js`, in which a pattern without a `/` finds the name.
        const fromOutside = paths.relative(directory, path);
        if (next.ignoresAWayUp(fromOutside)) return 1;
        inside = fromOutside;
      } else if (isInSearch) {
        inside = path;
      }
    }
    if (inside !== null && inside.length > 0) {
      const v = next.rules.verdict(inside, isDirectory);
      if (v === V_IGNORED) return 1;
      if (v === V_KEPT) return 2;
    }
    next = next.above;
  }
  return 0;
}

// Whether `path` is ignored, if the directory that it is in is not.
export function isIgnored(chain: Chain, path: string, isDirectory: boolean): boolean {
  if (chain === null) return false;
  return decide(chain, path, isDirectory, false) === 1;
}

// The same for what a search of `bun fmt` comes to. There oxfmt hands the crate `ignore` a path that is not in the directory
// of the file as it is: a pattern without a `/` finds the name.
export function isIgnoredInSearch(chain: Chain, path: string, isDirectory: boolean): boolean {
  if (chain === null) return false;
  return decide(chain, path, isDirectory, true) === 1;
}

// Whether the directory at `path` is ignored, or one that it is in.
export function isDirectoryIgnoredAnywhere(chain: Chain, path: string): boolean {
  if (chain === null) return false;
  const dirs = paths.ancestors(path);
  for (let i = dirs.length - 1; i >= 0; i--) {
    if (isIgnored(chain, dirs[i], true)) return true;
  }
  return false;
}

// Whether the file at `path` is ignored, or a directory that it is in.
export function isFileIgnoredAnywhere(chain: Chain, path: string): boolean {
  if (chain === null) return false;
  return isDirectoryIgnoredAnywhere(chain, paths.dirname(path)) || isIgnored(chain, path, false);
}

// ---- Git, as the crate `ignore` reads it ----

// True if `directory` is the top of a Git or Jujutsu repository.
export function isRoot(directory: string): boolean {
  return fsx.exists(paths.join(directory, ".git")) || fsx.exists(paths.join(directory, ".jj"));
}

function firstLine(file: string): string | null {
  const text = fsx.readText(file);
  if (text === null) return null;
  let end = text.indexOf("\n");
  if (end < 0) end = text.length;
  let line = text.substring(0, end);
  if (line.endsWith("\r")) line = line.substring(0, line.length - 1);
  return line;
}

// Where the repository with the `.git` at `dotGit` has `info/exclude`, as the crate `ignore` finds it. In a working tree of
// `git worktree add`, `.git` is a file. That of a submodule names a directory without `commondir`, and nothing is read. null:
// nowhere.
function commonDirectory(dotGit: string, kind: number): string | null {
  if (kind === fsx.K_DIR) return dotGit;
  const pointer = firstLine(dotGit);
  if (pointer === null || !pointer.startsWith("gitdir: ")) return null;
  const gitDirectory = pointer.substring(8);
  const common = firstLine(paths.join(gitDirectory, "commondir"));
  if (common === null) return null;
  return common.startsWith(".") ? paths.join(gitDirectory, common) : common;
}

// oxc's `all_paths_have_vcs_boundary`. `searched`: where the searches of a run start. One that is ignored is not searched, and
// does not count.
export function areAllInRepositories(searched: string[]): boolean {
  const known = new Set<string>();
  for (let s = 0; s < searched.length; s++) {
    const directory = searched[s];
    const dirs = paths.ancestors(directory);
    let rootAt = -1;
    for (let i = 0; i < dirs.length; i++) {
      if (known.has(dirs[i]) || isRoot(dirs[i])) {
        rootAt = i;
        break;
      }
    }
    const shortest = rootAt < 0 ? 1 << 30 : dirs[rootAt].length;
    for (let i = 0; i < dirs.length && dirs[i].length >= shortest; i++) known.add(dirs[i]);
    if (rootAt >= 0) continue;
    if (!OfGit.aboveAndIn(directory, true).isDirectoryIgnoredAnywhere(directory)) return false;
  }
  return true;
}

// `.gitignore` and `info/exclude` for a search of oxfmt, as the crate `ignore` reads them.
export class OfGit {
  ignores: Chain;
  // `info/exclude`. Every `.gitignore` comes first.
  excludes: Chain;
  // What is above the root of a repository does not count in it.
  stopsAtRoots: boolean;
  constructor(ignores: Chain, excludes: Chain, stopsAtRoots: boolean) {
    this.ignores = ignores;
    this.excludes = excludes;
    this.stopsAtRoots = stopsAtRoots;
  }

  // For a search that starts in `directory`. null: they have it, or a directory that it is in, so it is not searched.
  // With one search of the run that is in no repository, no root stops any of them. `allInRepositories` is asked lazily.
  static forSearch(directory: string, allInRepositories: () => boolean): OfGit | null {
    const own = OfGit.aboveAndIn(directory, true);
    if (own.isDirectoryIgnoredAnywhere(directory)) return null;
    if (own.stopsAtRoots && !allInRepositories()) return OfGit.aboveAndIn(directory, false);
    return own;
  }

  // The files in `directory` and above it, up to the root of the repository. Outside of one, all the way up.
  static aboveAndIn(directory: string, stopsAtRoots: boolean): OfGit {
    let dirs = paths.ancestors(directory);
    let nearest = -1;
    for (let i = 0; i < dirs.length; i++) {
      if (isRoot(dirs[i])) {
        nearest = i;
        break;
      }
    }
    const stops = stopsAtRoots && nearest >= 0;
    if (stops) dirs = dirs.slice(0, nearest + 1);
    let files = new OfGit(null, null, stops);
    for (let index = dirs.length - 1; index >= 0; index--) {
      const canBeRoot = nearest >= 0 && nearest <= index;
      files = files.andIn(dirs[index], null, canBeRoot);
    }
    return files;
  }

  // The same with the files in `directory`, which the search has come to. `names`: the names of its entries (null: the
  // ones that can be called so: `canBe`, or just `.gitignore`).
  andIn(directory: string, names: Set<string> | null, canBe: boolean): OfGit {
    const has = (name: string): boolean => (names === null ? canBe || name === ".gitignore" : names.has(name));
    let ignores = this.ignores;
    let excludes = this.excludes;
    let dotGit = "";
    let kind = fsx.K_NONE;
    if (has(".git")) {
      dotGit = paths.join(directory, ".git");
      // Where no root stops it, the crate does not look at what `.git` is.
      kind = this.stopsAtRoots ? fsx.kindAndSize(dotGit) : fsx.K_DIR;
    }
    const hasJj = (): boolean => has(".jj") && fsx.exists(paths.join(directory, ".jj"));
    if (this.stopsAtRoots && (kind !== fsx.K_NONE || hasJj())) {
      ignores = null;
      excludes = null;
    }
    if (dotGit !== "" && kind !== fsx.K_NONE) {
      const common = commonDirectory(dotGit, kind);
      if (common !== null) excludes = withFile(excludes, directory, paths.join(common, "info/exclude"), true);
    }
    if (has(".gitignore")) ignores = withFile(ignores, directory, paths.join(directory, ".gitignore"), true);
    return new OfGit(ignores, excludes, this.stopsAtRoots);
  }

  private decideIn(path: string, isDirectory: boolean): number {
    const a = decide(this.ignores, path, isDirectory, false);
    if (a !== 0) return a;
    return decide(this.excludes, path, isDirectory, false);
  }

  // Whether `path` is ignored, if the directory that it is in is not.
  isIgnored(path: string, isDirectory: boolean): boolean {
    return this.decideIn(path, isDirectory) === 1;
  }

  // Whether the directory at `path` is ignored, or one that it is in.
  isDirectoryIgnoredAnywhere(path: string): boolean {
    const dirs = paths.ancestors(path);
    for (let i = 0; i < dirs.length; i++) if (this.isIgnored(dirs[i], true)) return true;
    return false;
  }
}
