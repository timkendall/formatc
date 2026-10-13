// oxfmt's way of finding files: `expand_as_oxfmt` and the `ScopedWalker` (the `search` of files.rs with `OfGit`). Port of
// vendor/bun/src/lint/driver/fmt/files.rs (the oxfmt half). The walk is one thread: oxfmt's flavor reads the files of Git
// as it goes, and the workers of scan.ts rebuild their state from strings only.
import { Configs, Fatal, Scope } from "./config.ts";
import * as fsx from "./fsx.ts";
import * as gitignore from "./gitignore.ts";
import { OfGit } from "./gitignore.ts";
import type { Chain } from "./gitignore.ts";
import { IgnoreRules, V_IGNORED } from "./ignore.ts";
import { Ignored } from "./ignored.ts";
import * as kinds from "./kinds.ts";
import * as paths from "./paths.ts";
import { Expanded, Target } from "./target.ts";

// An element of oxc's `GlobSet`: a pattern as a line of an ignore file (the crate `ignore` reads it as its `Override`s do),
// matched against a path relative to the working directory.
export class OxcGlob {
  rules: IgnoreRules;
  source: string;
  constructor(pattern: string) {
    this.source = pattern;
    this.rules = IgnoreRules.fromLines([pattern], true);
  }
  matches(path: string): boolean {
    return this.rules.verdict(path, false) === V_IGNORED;
  }
}

// What oxlint and oxfmt refuse the pattern `written` with. "" : they take it.
export function globRefusal(written: string): string {
  let at = 0;
  const braces: number[] = [];
  while (at < written.length) {
    const c = written.charCodeAt(at);
    if (c === 92) {
      if (at + 1 >= written.length) {
        return "Invalid glob pattern `" + written + "`: trailing backslash at byte " + at + " has no character to escape (to match a literal '\\', use '\\\\')";
      }
      at = at + 2;
      continue;
    }
    if (c === 91) {
      // a class: `]` right after the `[` (or `[!`) is a member
      let i = at + 1;
      if (written.charCodeAt(i) === 33 || written.charCodeAt(i) === 94) i = i + 1;
      if (written.charCodeAt(i) === 93) i = i + 1;
      while (i < written.length && written.charCodeAt(i) !== 93) i = i + 1;
      if (i >= written.length) {
        return "Invalid glob pattern `" + written + "`: unclosed character class at byte " + at + "; missing ']' (to match a literal '[', escape it as '\\[' or '[[]')";
      }
      at = i + 1;
      continue;
    }
    if (c === 123) braces.push(at);
    else if (c === 125 && braces.length > 0) braces.pop();
    at = at + 1;
  }
  if (braces.length > 0) {
    return "Invalid glob pattern `" + written + "`: unclosed brace expansion at byte " + braces[0] + "; missing '}' (to match a literal '{', escape it as '\\{' or '[{]')";
  }
  return "";
}

function hasGlobChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 42 || c === 63 || c === 91 || c === 123) return true;
  }
  return false;
}

function bytewiseLess(a: string, b: string): number {
  // sort by bytes: for ASCII the code units; otherwise UTF-8
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return Buffer.compare(ba, bb);
}

class Walked {
  path: string;
  above: Scope;
  isFirst: boolean;
  git: OfGit;
  isIgnoredByConfiguration: boolean;
  constructor(path: string, above: Scope, isFirst: boolean, git: OfGit, isIgnoredByConfiguration: boolean) {
    this.path = path;
    this.above = above;
    this.isFirst = isFirst;
    this.git = git;
    this.isIgnoredByConfiguration = isIgnoredByConfiguration;
  }
}

export let searchError = "";

// The files in `base` that `matches` says yes to, given the path from the working directory. null on a fatal error (the message
// is in `searchError`).
function searchOxfmt(configs: Configs, ignored: Ignored, base: string, matches: (relative: string) => boolean, allInRepositories: () => boolean): Target[] | null {
  const found: Target[] = [];
  const git0 = OfGit.forSearch(base, allInRepositories);
  if (git0 === null) return found;
  const above = configs.forDirectory(base);
  if (above.scope === null) {
    searchError = above.error === null ? "" : above.error;
    return null;
  }
  const cwd = ignored.cwd;
  const stack: Walked[] = [new Walked(base, above.scope, true, git0, gitignore.isDirectoryIgnoredAnywhere(configs.ignoresOf(above.scope), base))];
  while (stack.length > 0) {
    const directory = stack.pop() as Walked;
    const entries = fsx.list(directory.path);
    if (entries === null) continue;
    let scope: Scope;
    if (directory.isFirst) scope = directory.above;
    else {
      const f = configs.forListedDirectory(directory.path, entries, directory.above);
      if (f.scope === null) {
        searchError = f.error === null ? "" : f.error;
        return null;
      }
      scope = f.scope;
    }
    const ofConfig: Chain = configs.ignoresOf(scope);
    const startsOver = !directory.isFirst && directory.above.config !== scope.config;
    const isIgnoredByConfigurationOfDirectory = directory.isIgnoredByConfiguration && !startsOver;
    let git = directory.git;
    if (!directory.isFirst) {
      const names = new Set<string>();
      for (let i = 0; i < entries.length; i++) names.add(entries[i].name);
      git = git.andIn(directory.path, names, false);
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.isLink) continue;
      const path = paths.join(directory.path, entry.name);
      if (ignored.isNotSearched(path, entry.name, entry.isDirectory)) continue;
      const relative = paths.relative(cwd, path);
      if (ignored.ignoresEntry(path, entry.isDirectory)) {
        if (entry.isDirectory || matches(relative)) ignored.hasLeftOut = true;
        continue;
      }
      if (git.isIgnored(path, entry.isDirectory)) continue;
      const isIgnoredByConfiguration = isIgnoredByConfigurationOfDirectory || gitignore.isIgnored(ofConfig, path, entry.isDirectory);
      if (entry.isDirectory) {
        stack.push(new Walked(path, scope, false, git, isIgnoredByConfiguration));
      } else if (!isIgnoredByConfiguration && matches(relative)) {
        const kind = fsx.linkKindAndSize(path);
        if (kind === fsx.K_LINK) continue;
        found.push(new Target(path, kind === fsx.K_NONE ? 0 : fsx.outSize, scope, false, false));
      }
    }
  }
  return found;
}

class Resolved1 {
  path: string;
  kind: number;
  size: number;
  constructor(path: string, kind: number, size: number) {
    this.path = path;
    this.kind = kind;
    this.size = size;
  }
}

// oxfmt's `ScopedWalker`. `patterns`: the arguments. Throws Fatal.
export function expandAsOxfmt(configs: Configs, ignored: Ignored, patterns: string[], errorOnUnmatchedPattern: boolean): Expanded[] {
  const cwd = ignored.cwd;
  let targets: string[] = [];
  const globs: OxcGlob[] = [];
  const excluded: string[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    if (pattern.startsWith("!")) {
      excluded.push(pattern.substring(1));
      continue;
    }
    let normalized = pattern;
    if (normalized.startsWith("./")) {
      normalized = normalized.substring(2);
      while (normalized.startsWith("/")) normalized = normalized.substring(1);
    }
    const path = paths.resolve(cwd, normalized);
    if (hasGlobChar(normalized) && !fsx.exists(path)) {
      const refusal = globRefusal(normalized);
      if (refusal !== "") throw new Fatal(refusal);
      globs.push(new OxcGlob(normalized));
    } else targets.push(path);
  }
  // In the format of `.gitignore`, unlike Prettier's.
  const excludedChain = gitignore.withLines(null, cwd, excluded);
  if (excludedChain !== null) ignored.files.push(excludedChain);
  if (globs.length > 0 || targets.length === 0) targets.push(cwd);
  targets.sort((a, b) => bytewiseLess(a, b));
  const uniq: string[] = [];
  for (let i = 0; i < targets.length; i++) if (i === 0 || targets[i] !== targets[i - 1]) uniq.push(targets[i]);
  targets = uniq;
  const isIgnoredIn = (chain: Chain, path: string, kind: number): boolean => (kind === fsx.K_DIR ? gitignore.isDirectoryIgnoredAnywhere(chain, path) : gitignore.isFileIgnoredAnywhere(chain, path));
  const kept: Resolved1[] = [];
  for (let i = 0; i < targets.length; i++) {
    const kind = fsx.kindAndSize(targets[i]);
    if (kind === fsx.K_NONE) continue;
    const size = fsx.outSize;
    let any = false;
    for (let f = 0; f < ignored.files.length; f++) if (isIgnoredIn(ignored.files[f], targets[i], kind)) any = true;
    if (!any) kept.push(new Resolved1(targets[i], kind, size));
  }
  let allKnown = -1;
  const allInRepositories = (): boolean => {
    if (allKnown < 0) {
      const dirs: string[] = [];
      for (let i = 0; i < kept.length; i++) if (kept[i].kind === fsx.K_DIR) dirs.push(kept[i].path);
      allKnown = dirs.length === 1 || gitignore.areAllInRepositories(dirs) ? 1 : 0;
    }
    return allKnown === 1;
  };
  for (let i = 0; i < kept.length; i++) configs.name(kept[i].kind === fsx.K_DIR ? kept[i].path : paths.dirname(kept[i].path));
  let found: Target[] = [];
  for (let i = 0; i < kept.length; i++) {
    const t = kept[i];
    if (t.kind === fsx.K_DIR) {
      const matches = (relative: string): boolean => {
        if (globs.length === 0) return true;
        for (let g = 0; g < globs.length; g++) if (globs[g].matches(relative)) return true;
        return false;
      };
      const r = searchOxfmt(configs, ignored, t.path, matches, allInRepositories);
      if (r === null) throw new Fatal(searchError);
      found = found.concat(r);
      continue;
    }
    const f = configs.forDirectory(paths.dirname(t.path));
    if (f.scope === null) throw new Fatal(f.error === null ? "" : f.error);
    if (!isIgnoredIn(configs.ignoresOf(f.scope), t.path, t.kind)) found.push(new Target(t.path, t.size, f.scope, true, false));
  }
  // Nothing is said about a file that there is no parser for, and it does not count.
  const wanted: Target[] = [];
  for (let i = 0; i < found.length; i++) {
    if (kinds.languageForOxfmt(found[i].path, configs.formatsSvelte(found[i].scope, found[i].path)) !== kinds.LANG_UNKNOWN) wanted.push(found[i]);
  }
  wanted.sort((a, b) => bytewiseLess(a.path, b.path));
  const out: Expanded[] = [];
  for (let i = 0; i < wanted.length; i++) {
    if (i > 0 && wanted[i].path === wanted[i - 1].path) continue;
    out.push(new Expanded(wanted[i], null));
  }
  if (out.length === 0 && errorOnUnmatchedPattern) {
    return [new Expanded(null, "Expected at least one target file. All matched files may have been excluded by ignore rules.")];
  }
  return out;
}
