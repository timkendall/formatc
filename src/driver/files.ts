// Finds the files to format: `expandPatterns` of Prettier's command line, and what it ignores. Port of
// vendor/bun/src/lint/driver/fmt/files.rs (the Prettier flavor).
import { Configs, Fatal, Scope } from "./config.ts";
import * as fsx from "./fsx.ts";
import { FASTGLOB, globOfPrettier } from "./glob.ts";
import { Ignored } from "./ignored.ts";
import * as kinds from "./kinds.ts";
import * as paths from "./paths.ts";
import * as scan from "./scan.ts";
import { Tester } from "./scan.ts";
import { Expanded, Target } from "./target.ts";

// What each byte weighs in `a.localeCompare(b)`, for what is ASCII: punctuation, then digits, then letters, whether
// capital or not. Above zero.
const WEIGHTS = buildWeights();

function buildWeights(): Uint16Array {
  const order = "\t\n\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789";
  const w = new Uint16Array(256);
  for (let b = 0; b < 256; b++) {
    if ((b >= 97 && b <= 122) || (b >= 65 && b <= 90)) {
      const lower = b >= 65 && b <= 90 ? b + 32 : b;
      w[b] = (100 + lower) | 0;
    } else {
      w[b] = (300 + b) | 0;
    }
  }
  for (let i = 0; i < order.length; i++) w[order.charCodeAt(i)] = (1 + i) | 0;
  return w;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}

// Compares like the bytes of `collation_key`: the weights, and then for `a` before `A` the bytes the other way around.
export function collate(a: string, b: string): number {
  if (isAscii(a) && isAscii(b)) {
    const n = a.length < b.length ? a.length : b.length;
    for (let i = 0; i < n; i++) {
      const wa = WEIGHTS[a.charCodeAt(i)] | 0;
      const wb = WEIGHTS[b.charCodeAt(i)] | 0;
      if (wa !== wb) return wa - wb;
    }
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < n; i++) {
      const ca = a.charCodeAt(i);
      const cb = b.charCodeAt(i);
      if (ca !== cb) return cb - ca;
    }
    return 0;
  }
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const n = ba.length < bb.length ? ba.length : bb.length;
  for (let i = 0; i < n; i++) {
    const wa = WEIGHTS[ba[i] | 0] | 0;
    const wb = WEIGHTS[bb[i] | 0] | 0;
    if (wa !== wb) return wa - wb;
  }
  if (ba.length !== bb.length) return ba.length - bb.length;
  for (let i = 0; i < n; i++) {
    const ca = ba[i] | 0;
    const cb = bb[i] | 0;
    if (ca !== cb) return cb - ca;
  }
  return 0;
}

class SortItem {
  key: string;
  target: Target;
  constructor(key: string, target: Target) {
    this.key = key;
    this.target = target;
  }
}

// What sorts as a string the way `collation_key` sorts as bytes: the weights, then (for `a` before `A`) the bytes
// the other way around. Built in a typed array and decoded as UTF-16.
const keyScratch = new Uint16Array(4096);

function collationKey(path: string): string {
  const n = path.length;
  if (n < 2000 && isAscii(path)) {
    const sc = keyScratch;
    for (let i = 0; i < n; i++) {
      const c = path.charCodeAt(i) | 0;
      sc[i] = (1 + (WEIGHTS[c] | 0)) | 0;
      sc[n + 1 + i] = (256 - c) | 0;
    }
    sc[n] = 0;
    return Buffer.from(sc.buffer, 0, (2 * n + 1) * 2).toString("utf16le");
  }
  const b = Buffer.from(path, "utf8");
  let key = "";
  for (let i = 0; i < b.length; i++) key += String.fromCharCode(1 + (WEIGHTS[b[i] | 0] | 0));
  key += "\u0000";
  for (let i = 0; i < b.length; i++) key += String.fromCharCode(1 + (255 - (b[i] | 0)));
  return key;
}

// `glob_parent`: the static directory a pattern starts in.
export function globParent(pattern: string): string {
  const isMagic = (seg: string): boolean => {
    for (let i = 0; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      if (c === 42 || c === 63 || c === 91 || c === 93 || c === 123 || c === 125 || c === 40 || c === 41) return true;
      if (c === 33 && i + 1 < seg.length && seg.charCodeAt(i + 1) === 40) return true;
      if (c === 92) i = i + 1;
    }
    return false;
  };
  const parts = pattern.split("/");
  let n = 0;
  // the last part is the file name part: never part of the parent
  while (n < parts.length - 1 && !isMagic(parts[n])) n = n + 1;
  if (n === 0) return pattern.startsWith("/") ? "/" : ".";
  let parent = parts.slice(0, n).join("/");
  if (parent === "") parent = "/";
  return parent.replace(/\\([*?|[\](){}])/g, "$1");
}

// Prettier's `expandPatterns`. `patterns`: the arguments. Throws Fatal.
export async function expand(configs: Configs, ignored: Ignored, patterns: string[], errorOnUnmatchedPattern: boolean, threads: number, needsSizes: boolean, hook: ((t: Target) => void) | null, batch: (() => void) | null, walked: (() => void) | null): Promise<Expanded[]> {
  const cwd = ignored.cwd;
  const expanded: Expanded[] = [];
  // kind: 0 file, 1 directory, 2 pattern
  const entryKind: number[] = [];
  const entryPath: string[] = [];
  const entrySize: number[] = [];
  const entryInput: string[] = [];
  const entryWritten: string[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const written = patterns[i];
    const pattern = written;
    const path = paths.resolve(cwd, pattern);
    if (ignored.isInIgnoredDirectory(path)) continue;
    const k = fsx.linkKindAndSize(path);
    if (k === fsx.K_LINK) {
      if (errorOnUnmatchedPattern) expanded.push(new Expanded(null, 'Explicitly specified pattern "' + written + '" is a symbolic link.'));
    } else if (k === fsx.K_FILE) {
      configs.name(paths.dirname(path));
      entryKind.push(0);
      entryPath.push(path);
      entrySize.push(fsx.outSize);
      entryInput.push(pattern);
      entryWritten.push(written);
    } else if (k === fsx.K_DIR) {
      configs.name(path);
      entryKind.push(1);
      entryPath.push(path);
      entrySize.push(0);
      entryInput.push(pattern);
      entryWritten.push(written);
    } else if (pattern.startsWith("!")) {
      const negative = pattern.substring(1);
      ignored.addNegative(globOfPrettier(negative.startsWith("./") ? negative.substring(2) : negative, FASTGLOB));
    } else {
      entryKind.push(2);
      entryPath.push("");
      entrySize.push(0);
      entryInput.push(pattern);
      entryWritten.push(written);
    }
  }
  const seen = new Set<string>();
  let isAnythingIgnored = false;
  for (let e = 0; e < entryKind.length; e++) {
    const input = entryInput[e];
    const written = entryWritten[e];
    let writtenBase0 = "";
    let writtenBase1 = cwd;
    let found: Target[] = [];
    let nothing = "";
    if (entryKind[e] === 0) {
      const path = entryPath[e];
      if (ignored.ignoresFile(path, null)) {
        isAnythingIgnored = true;
        continue;
      }
      if (!ignored.isNegated(path)) {
        const f = configs.forDirectory(paths.dirname(path));
        if (f.scope === null) throw new Fatal(f.error === null ? "" : f.error);
        found = [new Target(path, entrySize[e], f.scope, false, true)];
      }
      nothing = "Explicitly specified file was ignored due to negative glob patterns";
    } else if (entryKind[e] === 1) {
      const path = entryPath[e];
      if (ignored.ignoresDirectory(path)) {
        isAnythingIgnored = true;
        continue;
      }
      const all = new Tester(true, null, false, "", "", "", false);
      const r = await scan.search(configs, ignored, path, all, all, threads, needsSizes, hook, batch);
      if (r === null) throw new Fatal(scan.searchError);
      if (entryKind.length === 1 && walked !== null) walked();
      found = r;
      for (let i = 0; i < found.length; i++) found[i].ignoresUnknown = true;
      writtenBase0 = paths.relative(cwd, path);
      writtenBase1 = path;
      nothing = "No supported files were found in the directory";
    } else {
      const pattern = input.startsWith("./") ? input.substring(2) : input;
      const glob = globOfPrettier(pattern, FASTGLOB);
      const parent = globParent(pattern);
      const base = paths.resolve(cwd, parent);
      if (parent !== ".") {
        writtenBase0 = parent;
        writtenBase1 = base;
      }
      const isAbsolute = paths.isAbsolute(pattern) || paths.isExternal(writtenBase0);
      const k = fsx.kindAndSize(base);
      if (k === fsx.K_DIR) {
        if (ignored.ignoresDirectory(base)) {
          isAnythingIgnored = true;
          continue;
        }
        const matches = new Tester(false, glob, isAbsolute, writtenBase0, base, cwd, false);
        const enters = new Tester(false, glob, isAbsolute, writtenBase0, base, cwd, true);
        const r = await scan.search(configs, ignored, base, matches, enters, threads, needsSizes, hook, batch);
        if (r === null) throw new Fatal(scan.searchError);
        if (entryKind.length === 1 && walked !== null) walked();
        found = r;
      }
      nothing = "No files matching the pattern were found";
    }
    const hasLeftOut = ignored.hasLeftOut;
    ignored.hasLeftOut = false;
    if (found.length === 0) {
      if (hasLeftOut) isAnythingIgnored = true;
      else if (errorOnUnmatchedPattern) expanded.push(new Expanded(null, nothing + ': "' + written + '".'));
      continue;
    }
    // sort by what the paths that `fast-glob` returns start with
    const items: SortItem[] = [];
    for (let i = 0; i < found.length; i++) {
      const t = found[i];
      const rel = paths.relative(writtenBase1, t.path);
      items.push(new SortItem(collationKey(writtenBase0 === "" ? rel : paths.join(writtenBase0, rel)), t));
    }
    items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (let i = 0; i < found.length; i++) found[i] = items[i].target;
    for (let i = 0; i < found.length; i++) {
      const t = found[i];
      if (!seen.has(t.path)) {
        seen.add(t.path);
        expanded.push(new Expanded(t, null));
      }
    }
  }
  if (expanded.length === 0 && !isAnythingIgnored && errorOnUnmatchedPattern) {
    expanded.push(new Expanded(null, "No matching files. Patterns: " + patterns.join(" ")));
  }
  return expanded;
}

// What the file at `path`, which has `scope`, is to the tool that the run stands in for.
export function languageIn(configs: Configs, scope: Scope, path: string): number {
  // The `parser` option says what it is. One that Prettier does not have is that of a plugin.
  const parser = configs.parserFor(scope, path);
  if (parser !== "") {
    return kinds.kindOfParser(parser) === kinds.KIND_NONE ? kinds.LANG_OTHER : kinds.LANG_SUPPORTED;
  }
  if (configs.isOxfmtFor(scope)) return kinds.languageForOxfmt(path, configs.formatsSvelte(scope, path));
  const language = kinds.languageOf(path);
  if (language === kinds.LANG_UNKNOWN && configs.isReadByPlugin(scope, path)) return kinds.LANG_OTHER;
  if (language === kinds.LANG_SUPPORTED && configs.isReadByPlugin(scope, path)) return kinds.LANG_OTHER;
  if (language === kinds.LANG_UNKNOWN && kinds.isToml(path) && configs.isNativeIn(scope)) return kinds.LANG_SUPPORTED;
  if (language === kinds.LANG_UNKNOWN && kinds.parserByInterpreter(path) !== "") return kinds.LANG_SUPPORTED;
  return language;
}
