// Which files are left out: `.git`, `node_modules`, `.gitignore`, `.prettierignore`, `--ignore-path`, `--ignore-pattern`.
import * as cli from "./cli.ts";
import { Fatal } from "./config.ts";
import * as fsx from "./fsx.ts";
import * as gitignore from "./gitignore.ts";
import type { Chain } from "./gitignore.ts";
import { Glob } from "./glob.ts";
import * as paths from "./paths.ts";

export class Ignored {
  // `.git`, `node_modules`, ..
  directories: string[];
  // The arguments that start with `!`, from the working directory.
  negative: Glob[];
  // `.gitignore`, `.prettierignore`: a file is ignored if one of them says so.
  files: Chain[];
  cwd: string;
  // A search came to a file that it looks for, or a directory that it enters, which one of `files` has.
  hasLeftOut: boolean;
  // What `files` and `negative` were made from: a worker makes them again (objects are not shared between threads: see
  // scan.ts).
  sourceDirs: string[];
  sourceTexts: string[];
  negativeSources: string[];

  constructor(directories: string[], files: Chain[], cwd: string) {
    this.directories = directories;
    this.negative = [];
    this.files = files;
    this.cwd = cwd;
    this.hasLeftOut = false;
    this.sourceDirs = [];
    this.sourceTexts = [];
    this.negativeSources = [];
  }

  addNegative(glob: Glob): void {
    this.negative.push(glob);
    this.negativeSources.push(glob.source);
  }

  // The same, made from what this was made from.
  static rebuild(directories: string[], sourceDirs: string[], sourceTexts: string[], negativeSources: string[], cwd: string): Ignored {
    const files: Chain[] = [];
    for (let i = 0; i < sourceDirs.length; i++) {
      const chain = gitignore.withText(null, sourceDirs[i], sourceTexts[i]);
      if (chain !== null) files.push(chain);
    }
    const ignored = new Ignored(directories, files, cwd);
    for (let i = 0; i < negativeSources.length; i++) ignored.addNegative(new Glob(negativeSources[i]));
    ignored.sourceDirs = sourceDirs;
    ignored.sourceTexts = sourceTexts;
    return ignored;
  }

  // `DirectoryIgnorer.shouldIgnore`
  isInIgnoredDirectory(path: string): boolean {
    const parts = paths.relative(this.cwd, path).split("/");
    for (let i = 0; i < parts.length; i++) if (this.directories.indexOf(parts[i]) >= 0) return true;
    return false;
  }

  // Prettier adds the line `node_modules` to what every ignore file has, unless it is run `--with-node-modules`.
  isInNodeModules(path: string): boolean {
    if (this.directories.indexOf("node_modules") < 0) return false;
    const parts = paths.relative(this.cwd, path).split("/");
    for (let i = 0; i < parts.length; i++) if (parts[i] === "node_modules") return true;
    return false;
  }

  isNegated(path: string): boolean {
    if (this.negative.length === 0) return false;
    const relative = paths.relative(this.cwd, path);
    for (let i = 0; i < this.negative.length; i++) if (this.negative[i].matches(relative)) return true;
    return false;
  }

  // What `fast-glob` does not come to.
  isNotSearched(path: string, name: string, isDirectory: boolean): boolean {
    return (isDirectory && this.directories.indexOf(name) >= 0) || this.isNegated(path);
  }

  // Whether an ignore file has what is come to by way of its directories, none of which is ignored.
  ignoresEntry(path: string, isDirectory: boolean): boolean {
    for (let i = 0; i < this.files.length; i++) {
      if (gitignore.isIgnoredInSearch(this.files[i], path, isDirectory)) return true;
    }
    return false;
  }

  // Whether an ignore file has the directory at `path`, or one that it is in.
  ignoresDirectory(path: string): boolean {
    for (let i = 0; i < this.files.length; i++) {
      if (gitignore.isDirectoryIgnoredAnywhere(this.files[i], path)) return true;
    }
    return false;
  }

  // Prettier's `isIgnored`, for any file.
  ignoresFile(path: string, config: Chain): boolean {
    for (let i = 0; i < this.files.length; i++) {
      if (gitignore.isFileIgnoredAnywhere(this.files[i], path)) return true;
    }
    return gitignore.isFileIgnoredAnywhere(config, path);
  }
}

// Reads `.gitignore`, `.prettierignore` (or `--ignore-path`) and `--ignore-pattern`. Throws Fatal.
export function newIgnored(options: cli.Options, cwd: string, isOxfmt: boolean): Ignored {
  const directories: string[] = [".git", ".sl", ".svn", ".hg", ".jj"];
  if (!options.withNodeModules) directories.push("node_modules");
  // oxfmt reads every `.gitignore` on its way, as Git does.
  const defaults: string[] = isOxfmt ? [".prettierignore"] : [".gitignore", ".prettierignore"];
  const names = options.ignorePath !== null ? options.ignorePath : defaults;
  const files: Chain[] = [];
  const sourceDirs: string[] = [];
  const sourceTexts: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const file = paths.resolve(cwd, names[i]);
    if (isOxfmt && options.ignorePath !== null && !fsx.isFile(file)) throw new Fatal(file + ": File not found");
    const text = fsx.readText(file);
    if (text === null) {
      if (fsx.lastErrorCode === "ENOENT") continue;
      throw new Fatal("Unable to read '" + paths.relative(cwd, file) + "': " + fsx.describeError(fsx.lastErrorCode, fsx.lastErrorMessage));
    }
    const chain = gitignore.withText(null, paths.dirname(file), text, isOxfmt);
    if (chain !== null) {
      files.push(chain);
      sourceDirs.push(paths.dirname(file));
      sourceTexts.push(text);
    }
  }
  if (options.ignorePattern.length > 0) {
    const text = options.ignorePattern.join("\n");
    const chain = gitignore.withText(null, cwd, text, isOxfmt);
    if (chain !== null) {
      files.push(chain);
      sourceDirs.push(cwd);
      sourceTexts.push(text);
    }
  }
  const ignored = new Ignored(directories, files, cwd);
  ignored.sourceDirs = sourceDirs;
  ignored.sourceTexts = sourceTexts;
  return ignored;
}
