// `bun fmt`: the command line of Prettier, on all threads. Port of vendor/bun/src/lint/driver/fmt/mod.rs
// (`Run`), for Prettier's flavor and Bun's native mode.
import * as os from "node:os";
import * as childProcess from "node:child_process";
import * as tty from "node:tty";
import { ByteBuf } from "../base/bytebuf.ts";
import * as cli from "./cli.ts";
import { Configs, Fatal, Scope, isBuiltInPlugin, isMissingPlugin, packageOf } from "./config.ts";
import * as dispatch from "./dispatch.ts";
import { OptionSet } from "./dispatch.ts";
import * as files from "./files.ts";
import { expandAsOxfmt } from "./oxfmt.ts";
import { Ignored, newIgnored } from "./ignored.ts";
import { Expanded, Target } from "./target.ts";
import * as fsx from "./fsx.ts";
import * as kinds from "./kinds.ts";
import { isInvalidValue, Resolved } from "./options.ts";
import * as paths from "./paths.ts";
import { Problem, printProblem, problemAt, problemOfFile } from "./problem.ts";
import { JV, parseToml, tomlError, tomlErrorLine, tomlErrorColumn } from "./jsonv.ts";
import * as w from "./worker.ts";
import * as pipe from "./pipe.ts";
import { Pool } from "./pool.ts";

// FMT_PIPELINE=0: find all the files first, as before. FMT_MAIN_WORKS=1: the main thread formats too when it is done finding files.
const PIPELINE = process.env["FMT_PIPELINE"] !== "0";
const MAIN_WORKS = process.env["FMT_MAIN_WORKS"] === "1";
// FMT_SCAN_THREADS: how many threads walk the tree while the others format (0: 1 up to 11 threads, 2 from 12).
const SCAN_THREADS = Number(process.env["FMT_SCAN_THREADS"] === undefined ? "0" : (process.env["FMT_SCAN_THREADS"] as string));
// FMT_SIZES=1: take the size of every file while walking (one more system call each), so that the big ones go first.
const SIZES = process.env["FMT_SIZES"] === "1";
const PIPE_CHUNK = Number(process.env["FMT_CHUNK"] === undefined ? "4" : (process.env["FMT_CHUNK"] as string));
const MAKE_IT_A_WARNING = "\n  Use --allow-unsupported to make this a warning.";
const NESTED_TOO_DEEPLY = "The code is nested too deeply";

// `<b>`, `<d>`, `<r>` and the colors: with `colors` as ANSI, otherwise removed.
export function pretty(s: string, colors: boolean): string {
  if (!s.includes("<")) return s;
  return s.replace(/<(\/?)(b|d|r|red|green|yellow|blue|magenta|cyan|white|black)>/g, (m: string, slash: string, tag: string) => {
    if (!colors) return "";
    switch (tag) {
      case "r":
        return "\x1b[0m";
      case "b":
        return "\x1b[1m";
      case "d":
        return "\x1b[2m";
      case "red":
        return "\x1b[31m";
      case "green":
        return "\x1b[32m";
      case "yellow":
        return "\x1b[33m";
      case "blue":
        return "\x1b[34m";
      case "magenta":
        return "\x1b[35m";
      case "cyan":
        return "\x1b[36m";
      case "white":
        return "\x1b[37m";
      default:
        return "\x1b[30m";
    }
  });
}

function elapsed(ms: number, colors: boolean): string {
  if (Math.round(ms) <= 1500) return pretty("<r><d>[<b>" + ms.toFixed(2) + "ms<r><d>]<r>", colors);
  return pretty("<r><d>[<b>" + (ms / 1000).toFixed(2) + "s<r><d>]<r>", colors);
}

function fileNoun(n: number): string {
  return n === 1 ? "file" : "files";
}

export class Outcome {
  // Raw bytes for standard output (standard input formatted): written instead of `stdout`.
  stdoutBytes: Uint8Array | null = null;
  stdout: string[] = [];
  stderr: string[] = [];
  exitCode = 0;
  out(s: string): void {
    this.stdout.push(s);
  }
  err(s: string): void {
    this.stderr.push(s);
  }
}

// `Done`
const DN_NONE = 0;
const DN_UNCHANGED = 1;
const DN_DIFFERENT = 2;
const DN_PARTLY_STAGED = 3;
const DN_FAILED = 4;
const DN_REFUSED = 5;

// The kinds of `Failure`
const F_SYNTAX = 0;
const F_BUG = 1;
const F_CHANGED = 2;
const F_UNREAD = 3;

class Done {
  tookMs = 0;
  kind = DN_NONE;
  message = "";
  failure = F_SYNTAX;
  problem: Problem | null = null;
}

export class Run {
  options: cli.Options;
  cwd: string;
  out: Outcome;
  began: number;
  isNative: boolean;
  hasLeftFiles: boolean;
  colorsErr: boolean;
  colorsOut: boolean;
  version: string;
  // The options of the files, shared by those that have the same.
  optionSets: OptionSet[];
  setByKey: Map<string, number>;
  pool: Pool | null = null;
  tooMany = false;

  constructor(options: cli.Options, cwd: string, version: string, colorsErr: boolean, colorsOut: boolean) {
    this.optionSets = [];
    this.setByKey = new Map<string, number>();
    this.options = options;
    this.cwd = cwd;
    this.out = new Outcome();
    this.began = performance.now();
    this.isNative = false;
    this.hasLeftFiles = false;
    this.colorsErr = colorsErr;
    this.colorsOut = colorsOut;
    this.version = version;
  }

  colors(): boolean {
    if (this.options.color === 1) return true;
    if (this.options.color === 2) return false;
    return this.colorsErr;
  }

  // Prettier's `logger.log`
  log(text: string): void {
    if (this.options.logLevel >= cli.LOG_LOG) this.out.out(text + "\n");
  }

  // A warning looks the same whichever config there is.
  warn(text: string): void {
    if (this.options.logLevel >= cli.LOG_WARN) this.out.err(pretty("<yellow>warn<r><d>:<r> " + text + "\n", this.colors()));
  }

  // A line of what Prettier's `--check` prints.
  listAsPrettier(line: string): void {
    if (this.options.logLevel >= cli.LOG_WARN) this.out.err(pretty("[<yellow>warn<r>] " + line + "\n", this.colors()));
  }

  // An error looks the same whichever config there is.
  error(text: string): void {
    if (this.options.logLevel >= cli.LOG_ERROR) this.out.err(pretty("<red>error<r><d>:<r> " + text + "\n", this.colors()));
    this.out.exitCode = 2;
  }

  fail(text: string): Outcome {
    this.error(text);
    return this.out;
  }

  // Whether the run is like oxfmt.
  isOxfmtRun = false;

  // The configuration, or what says which files to ignore, cannot be used.
  failToStart(text: string): Outcome {
    this.error(text);
    if (this.isOxfmtRun || isInvalidValue(text)) this.out.exitCode = 1;
    return this.out;
  }

  // Says why the file that is shown as `shown` is left as it is.
  report(shown: string, d: Done): void {
    let problem: Problem;
    let isErr = true;
    let level = cli.LOG_ERROR;
    if (d.failure === F_UNREAD) {
      problem = d.problem as Problem;
      isErr = false;
      level = cli.LOG_WARN;
    } else if (d.failure === F_SYNTAX) {
      problem = d.problem as Problem;
    } else if (d.failure === F_BUG) {
      problem = problemOfFile("The formatter failed, so this file was not formatted. This is a bug in Bun");
    } else {
      problem = problemOfFile("Not formatted, because " + d.message);
    }
    if (this.options.logLevel >= level) this.out.err(printProblem(problem, shown, isErr, this.colors()));
    if (isErr) this.out.exitCode = 2;
  }

  // `src/a.js (1ms)`: how `oxfmt --check` names a file.
  logWithTime(shown: string, tookMs: number): void {
    if (this.options.logLevel >= cli.LOG_LOG) this.out.out(pretty("<yellow>" + shown + "<r> (" + Math.floor(tookMs) + "ms)\n", this.colors()));
  }

  // What oxfmt says at the end of a run, in which so many files were not formatted, were, and could not be.
  sumUpAsOxfmt(different: number, unchanged: number, failed: number, threads: number): void {
    const options = this.options;
    const total = different + unchanged + failed;
    const saysErrors = options.logLevel >= cli.LOG_ERROR;
    if (failed > 0) {
      if (saysErrors) this.out.err("Error occurred when checking code style in the above files.\n");
      return;
    }
    if (total === 0) {
      // Why there is none has been said.
      if (this.out.exitCode !== 0) return;
      if (saysErrors) this.out.err("No files found matching the given patterns.\n");
    } else if (options.listDifferent) {
      return;
    } else if (options.check && different === 0) {
      if (!this.hasLeftFiles) this.log("All matched files use the correct format.");
    } else if (options.check) {
      this.log("");
      this.log("Format issues found in above " + different + " files. Run without `--check` to fix.");
    }
    const took = Math.floor(performance.now() - this.began);
    this.log("Finished in " + took + "ms on " + total + " files using " + threads + " threads.");
  }

  // Prints the `--check` summary (native mode).
  sumUpCheck(different: number, unchanged: number, failed: number): void {
    const colors = this.colors();
    const level = this.options.logLevel;
    if (different > 0 && level >= cli.LOG_WARN) {
      const needs = different === 1 ? "needs" : "need";
      const them = different === 1 ? "it" : "them";
      this.out.err(pretty("<b>" + different + " " + fileNoun(different) + " " + needs + " formatting.<r><d> Run <r><cyan>bun fmt<r><d> to fix " + them + ".<r>\n", colors));
    }
    if (failed > 0 && level >= cli.LOG_ERROR) this.out.err("Could not check " + failed + " " + fileNoun(failed) + ".\n");
    // If not every file is formatted, the reason has already been printed.
    const isAll = different + failed === 0 && this.out.exitCode === 0 && !this.hasLeftFiles;
    if (!isAll || level < cli.LOG_LOG) return;
    if (unchanged === 0) return;
    if (unchanged === 1) this.out.err("1 file is formatted.\n");
    else this.out.err("All " + unchanged + " files are formatted.\n");
  }

  // So many files are left alone because of plugins that are not there: `names`.
  sayLeftForPlugins(count: number, names: string[]): void {
    const noun = count === 1 ? "file was" : "files were";
    const it = count === 1 ? "it" : "them";
    this.error(count + " " + noun + " not formatted because the Prettier config uses plugins that bun fmt does not include: " + names.join(", ") + "\n  Use --allow-unsupported to format " + it + " without the plugins.");
  }

  // The packages that would have to be installed for more files to go to the project's own Prettier.
  sayNotInstalled(notInstalled: string[]): void {
    if (notInstalled.length > 0) {
      this.warn("Not installed: " + notInstalled.join(", ") + "\n  Install prettier and every plugin in your config, and bun fmt will use them for these files.");
    }
  }

  // `others`: the endings of the files in another language, and how many have each.
  saySupported(endings: string[], counts: number[], notInstalled: string[]): void {
    // sort by count descending, then by ending
    const order: number[] = [];
    for (let i = 0; i < endings.length; i++) order.push(i);
    order.sort((a, b) => (counts[b] !== counts[a] ? counts[b] - counts[a] : endings[a] < endings[b] ? -1 : endings[a] > endings[b] ? 1 : 0));
    let count = 0;
    for (let i = 0; i < counts.length; i++) count = count + counts[i];
    const noun = count === 1 ? "file was" : "files were";
    const its = count === 1 ? "its" : "their";
    const kindsText: string[] = [];
    for (let i = 0; i < order.length; i++) kindsText.push(counts[order[i]] + " " + endings[order[i]]);
    const text = count + " " + noun + " not formatted because bun fmt does not support " + its + " language yet: " + kindsText.join(", ");
    this.sayNotInstalled(notInstalled);
    if (this.options.allowUnsupported) this.warn(text);
    else this.error(text + MAKE_IT_A_WARNING);
  }

  // ---- the work ----

  async execute(): Promise<Outcome> {
    const options = this.options;
    if (options.version) {
      this.out.out(this.version + "\n");
      return this.out;
    }
    const configs = new Configs(options, this.cwd);
    this.isNative = configs.isNative();
    this.isOxfmtRun = configs.flavor === 1;
    if (!options.allowUnsupported) {
      for (let i = 0; i < options.plugins.length; i++) {
        if (isMissingPlugin(options.plugins[i])) {
          return this.fail("bun fmt does not include the plugin " + options.plugins[i] + "\n  Use --allow-unsupported to format without it.");
        }
      }
    }
    let allBuiltIn = true;
    for (let i = 0; i < options.plugins.length; i++) if (!isBuiltInPlugin(options.plugins[i])) allBuiltIn = false;
    if (!allBuiltIn) this.warn("--plugin has no effect because bun fmt does not load Prettier plugins");
    if (options.config !== null && !options.configLookup) {
      const o = this.fail("Cannot use --no-config and --config together.");
      o.exitCode = 1;
      return o;
    }
    if (options.hasOnly() && options.stdinFilepath !== null) return this.fail(options.onlyFlag() + " and --stdin-filepath cannot be used together");
    const isUnnamed = options.formatsUnnamedStdin();
    if (options.hasOnly() && isUnnamed) return this.fail(options.onlyFlag() + " and --parser without files cannot be used together");
    const isOxfmt = configs.flavor === 1;
    const refusal = options.refusalOfModes(isOxfmt);
    if (refusal !== "") {
      const o = this.fail(refusal);
      o.exitCode = 1;
      return o;
    }
    if (options.init) return this.initBunfig(configs);
    if (options.findConfigPath !== null) {
      const file = options.findConfigPath;
      const path = paths.resolve(this.cwd, file);
      configs.name(paths.dirname(path));
      const f = configs.forDirectory(paths.dirname(path));
      if (f.scope === null) return this.fail(f.error === null ? "" : f.error);
      if (f.scope.config !== null) {
        this.log(paths.relative(this.cwd, f.scope.config.path));
        return this.out;
      }
      const o = this.fail('Can not find configure file for "' + file + '".');
      o.exitCode = 1;
      return o;
    }
    const check = configs.check();
    if (check !== "") return this.failToStart(check);
    // --parser from the flags
    let fromFlag = "";
    for (let i = options.formatNames.length - 1; i >= 0; i--) {
      if (options.formatNames[i] === "parser") {
        fromFlag = options.formatValues[i];
        break;
      }
    }
    if (fromFlag !== "" && !isUnnamed && kinds.kindOfParser(fromFlag) === kinds.KIND_NONE) {
      return this.fail("Couldn't resolve parser \"" + fromFlag + '".');
    }
    if ((this.isNative || isOxfmt) && !options.doctor && !options.listFiles && fromFlag !== "") {
      for (let i = 0; i < options.patterns.length; i++) {
        const path = paths.resolve(this.cwd, options.patterns[i]);
        if (fsx.linkKindAndSize(path) === fsx.K_DIR) return this.fail(cannotForceParserOn(options.patterns[i], fromFlag));
      }
    }
    if (options.doctor) return this.fail("--doctor is not supported by this build of bun fmt yet");
    const isSaid = options.logLevel >= cli.LOG_WARN && !options.doctor;
    let result: Outcome;
    if (isUnnamed) {
      result = this.formatUnnamedStdin(configs);
    } else {
      let ignored: Ignored;
      try {
        ignored = newIgnored(options, this.cwd, isOxfmt);
      } catch (e) {
        if (e instanceof Fatal) return this.failToStart(e.message);
        throw e;
      }
      if (options.stdinFilepath !== null) result = this.formatStdin(configs, ignored, options.stdinFilepath);
      else result = await this.formatFiles(configs, ignored);
    }
    if (configs.note !== "" && isSaid) result.err(pretty("<blue>note<r><d>:<r> " + configs.note + "\n", this.colors()));
    return result;
  }

  // `--init`
  initBunfig(configs: Configs): Outcome {
    const f = configs.forDirectory(this.cwd);
    if (f.scope === null) return this.failToStart(f.error === null ? "" : f.error);
    const config = configs.configOf(f.scope);
    const body = "# printWidth = 100\n# semi = false\n";
    if (config !== null) {
      const key = paths.basename(config.path).startsWith("package.") ? "prettier in " : "";
      this.out.out("Using " + key + paths.relative(this.cwd, config.path) + ". bunfig.toml is not needed.\n");
      return this.out;
    }
    const path = paths.join(this.cwd, "bunfig.toml");
    const before = fsx.readText(path);
    const cannot = (verb: string, why: string): Outcome => {
      this.out.err(pretty("<red>error<r><d>:<r> Cannot " + verb + " bunfig.toml: " + why + "\n", this.colors()));
      this.out.exitCode = 2;
      return this.out;
    };
    if (before === null) {
      if (fsx.lastErrorCode === "ENOENT") {
        const data = Buffer.from("[fmt]\n" + body);
        const why = fsx.writeNew(path, data);
        if (why !== "") return cannot("write", why);
        this.out.out("Created bunfig.toml with a [fmt] section\n");
        return this.out;
      }
      return cannot("read", fsx.describeError(fsx.lastErrorCode, fsx.lastErrorMessage));
    }
    const parsed = parseTomlForInit(before);
    if (parsed === "error") return cannot("read", parseTomlInitMessage);
    if (parsed === "has") {
      this.out.out("bunfig.toml already has a [fmt] section\n");
      return this.out;
    }
    const nl = before.indexOf("\r\n");
    const lineBreak = nl >= 0 && before.substring(0, nl).indexOf("\n") < 0 ? "\r\n" : "\n";
    const written = before.replace(/[\s]+$/, "").length;
    const wanted = written === 0 ? 0 : 2;
    let newlines = 0;
    for (let i = written; i < before.length; i++) if (before.charCodeAt(i) === 10) newlines = newlines + 1;
    const isInALine = before.length > 0 && !before.endsWith("\n");
    const breaks = Math.max(Math.max(0, wanted - newlines), isInALine ? 1 : 0);
    const section = ("[fmt]\n" + body).replace(/\n/g, lineBreak);
    const added = lineBreak.repeat(breaks) + section;
    const data = Buffer.from(before + added);
    const why = fsx.writeFile(path, data, data.length);
    if (why !== "") return cannot("write", why);
    this.out.out("Added [fmt] to bunfig.toml\n");
    return this.out;
  }

  // Prettier's `formatStdin`
  formatStdin(configs: Configs, ignored: Ignored, name: string): Outcome {
    const options = this.options;
    const text = fsx.readStdin();
    if (text === null) return this.fail("Cannot read standard input: " + fsx.describeError(fsx.lastErrorCode, fsx.lastErrorMessage));
    const path = paths.resolve(this.cwd, name);
    const onlyLooks = options.check || options.listDifferent;
    // Prettier's `listDifferent` says `error.message` of what `check` throws, and that is all.
    const forgives = configs.flavor === 0 && onlyLooks;
    const isOfAPackage = configs.flavor === 0 && ignored.isInNodeModules(path);
    if (isOfAPackage || ignored.ignoresFile(path, null)) {
      this.out.stdoutBytes = text;
      return this.out;
    }
    configs.name(paths.dirname(path));
    const f = configs.forDirectory(paths.dirname(path));
    if (f.scope === null) return this.failToStart(f.error === null ? "" : f.error);
    const scope = f.scope;
    const language = files.languageIn(configs, scope, path);
    const isIgnored = ignored.ignoresFile(path, configs.ignoresOf(scope));
    const pluginName = configs.pluginThatReads(scope, path);
    const isOfPlugin = pluginName !== "";
    const notInstalled = language === kinds.LANG_OTHER && isOfPlugin ? this.notInstalled(configs, scope, path) : [];
    let resolved: Resolved;
    try {
      resolved = configs.optionsFor(scope, path);
    } catch (e) {
      if (e instanceof Fatal) return this.failToStart(e.message);
      throw e;
    }
    // oxfmt gives a component back that it is not to format.
    const isLeftByOxfmt = language === kinds.LANG_UNKNOWN && configs.isOxfmtFor(scope) && kinds.isSvelteForOxfmt(path);
    if (isIgnored || isLeftByOxfmt) {
      this.out.stdoutBytes = text;
      return this.out;
    }
    const allows = options.allowUnsupported;
    let plugin = "";
    if (isOfPlugin && kinds.languageOf(path) === kinds.LANG_SUPPORTED) plugin = pluginName;
    if (language === kinds.LANG_OTHER && plugin !== "") {
      this.sayNotInstalled(notInstalled);
      if (!allows) {
        this.sayLeftForPlugins(1, [plugin]);
        return this.out;
      }
    } else if (language === kinds.LANG_OTHER) {
      this.saySupported([kinds.endingOf(path)], [1], notInstalled);
      if (allows && !onlyLooks) this.out.stdoutBytes = text;
      return this.out;
    }
    const missingPlugins = configs.missingPlugins(scope, path);
    if (language === kinds.LANG_SUPPORTED && !allows && missingPlugins.length > 0) {
      this.sayLeftForPlugins(1, missingPlugins);
      return this.out;
    }
    if (kinds.kindWithOptions(path, resolved.parser, resolved.toml, resolved.isOxfmt) === kinds.KIND_NONE) {
      // `handleError` has nothing to say then. `listDifferent` has said it before.
      if (configs.flavor === 0 && options.ignoreUnknown && !onlyLooks) return this.out;
      const o = this.failToStart('No parser could be inferred for file "' + path + '".');
      if (forgives) o.exitCode = 0;
      return o;
    }
    return this.printStdin(configs, text, name, [path], resolved);
  }

  // `prettier --parser x < file`: Prettier's `formatStdin` without `--stdin-filepath`.
  formatUnnamedStdin(configs: Configs): Outcome {
    const options = this.options;
    if (isStdinTty()) {
      return this.fail("--parser without files formats standard input, and nothing is piped in\n  Pipe the code in, or name the files to format.");
    }
    const text = fsx.readStdin();
    if (text === null) return this.fail("Cannot read standard input: " + fsx.describeError(fsx.lastErrorCode, fsx.lastErrorMessage));
    const onlyLooks = options.check || options.listDifferent;
    const forgives = configs.flavor === 0 && onlyLooks;
    const f = configs.forDirectory(this.cwd);
    if (f.scope === null) return this.failToStart(f.error === null ? "" : f.error);
    let resolved: Resolved;
    try {
      resolved = configs.optionsWithoutName(f.scope);
    } catch (e) {
      if (e instanceof Fatal) return this.failToStart(e.message);
      throw e;
    }
    const parser = resolved.parser;
    if (parser === "") {
      if (options.ignoreUnknown && !onlyLooks) return this.out;
      this.error("No parser and no file path given, couldn't infer a parser.");
      if (forgives) this.out.exitCode = 0;
      return this.out;
    }
    const kind = kinds.kindOfParser(parser);
    if (kind === kinds.KIND_NONE) {
      this.error("Couldn't resolve parser \"" + parser + '".');
      this.out.exitCode = this.isNative ? 2 : forgives ? 0 : 1;
      return this.out;
    }
    const missingPlugins = configs.missingPlugins(f.scope, null);
    if (!options.allowUnsupported && missingPlugins.length > 0) {
      this.sayLeftForPlugins(1, missingPlugins);
      return this.out;
    }
    // The names to parse it as: only to tell the parser which syntax to expect.
    let names: string[];
    if ((parser === "typescript" || parser === "oxc-ts") && !isProbablyJsx(text)) names = [paths.join(this.cwd, "stdin.ts"), paths.join(this.cwd, "stdin.tsx")];
    else if (parser === "typescript" || parser === "oxc-ts" || parser === "babel-ts") names = [paths.join(this.cwd, "stdin.tsx"), paths.join(this.cwd, "stdin.ts")];
    else if (kind === kinds.KIND_SCRIPT) names = [paths.join(this.cwd, "stdin.js")];
    else names = [""];
    return this.printStdin(configs, text, "stdin", names, resolved);
  }

  // The packages that aren't installed, of those it takes to hand the file at `path` to the project's own Prettier.
  notInstalled(configs: Configs, scope: Scope, path: string): string[] {
    const missing: string[] = [];
    const p = configs.pluginsFor(scope, path);
    const list: string[] = ["prettier"];
    if (p !== null) for (let i = 0; i < p.packages.length; i++) list.push(p.packages[i]);
    for (let i = 0; i < this.options.plugins.length; i++) list.push(this.options.plugins[i]);
    for (let i = 0; i < list.length; i++) {
      if (!isInstalled(this.cwd, list[i]) && missing.indexOf(list[i]) < 0) missing.push(list[i]);
    }
    return missing;
  }

  // Formats what came from standard input, then prints the result, or what `--check` says about it.
  printStdin(configs: Configs, text: Uint8Array, name: string, pathsToTry: string[], resolved: Resolved): Outcome {
    const options = this.options;
    const onlyLooks = options.check || options.listDifferent;
    const forgives = configs.flavor === 0 && onlyLooks;
    for (let i = 0; i < configs.warnings.length; i++) this.warn(configs.warnings[i]);
    configs.warnings = [];
    const verifies = options.debugCheck && !onlyLooks;
    const set = new OptionSet(0, resolved, verifies);
    const out = new ByteBufHolder();
    let status = dispatch.ST_SYNTAX;
    let firstSyntax: Done | null = null;
    let finalDone: Done | null = null;
    const buf = Buffer.from(text);
    for (let i = 0; i < pathsToTry.length; i++) {
      out.buf.reset();
      const st = dispatch.formatFile(pathsToTry[i], buf, buf.length, set, out.buf);
      status = st;
      if (st === dispatch.ST_SYNTAX) {
        if (firstSyntax === null) firstSyntax = this.doneOfFailure(st, buf, buf.length);
        continue;
      }
      finalDone = st === dispatch.ST_OK ? null : this.doneOfFailure(st, buf, buf.length);
      firstSyntax = null;
      break;
    }
    if (firstSyntax !== null) finalDone = firstSyntax;
    if (finalDone !== null) {
      const d = finalDone;
      if (d.failure === F_UNREAD) {
        this.report(name, d);
        if (!onlyLooks) this.out.stdoutBytes = text;
      } else if (d.failure === F_SYNTAX && forgives) {
        this.report(name, d);
        this.out.exitCode = 0;
      } else this.report(name, d);
      return this.out;
    }
    if (onlyLooks) {
      if (!sameBytes(out.buf.data, out.buf.len, buf, buf.length) && !options.write) {
        this.log("(stdin)");
        this.out.exitCode = 1;
      }
      return this.out;
    }
    if (verifies) {
      const isNamed = !options.formatsUnnamedStdin();
      this.out.out(isNamed && pathsToTry.length > 0 ? pathsToTry[0] : "(stdin)\n");
      return this.out;
    }
    this.out.stdoutBytes = Buffer.from(out.buf.view());
    // As Prettier: where the cursor is now.
    if (dispatch.cursorSlot >= 0) this.out.err(dispatch.cursorSlot + "\n");
    return this.out;
  }

  doneOfFailure(st: number, src: Uint8Array, len: number): Done {
    const d = new Done();
    d.kind = DN_REFUSED;
    if (st === dispatch.ST_SYNTAX) {
      d.failure = F_SYNTAX;
      d.problem = dispatch.errOffset < 0 ? problemOfFile(dispatch.errMessage) : problemAt(src, len, dispatch.errMessage, dispatch.errOffset, dispatch.errIsJs);
    } else if (st === dispatch.ST_UNREAD) {
      d.failure = F_UNREAD;
      d.problem = problemAt(src, len, dispatch.errMessage, dispatch.errOffset, false);
    } else if (st === dispatch.ST_CHANGED) {
      d.failure = F_CHANGED;
      d.message = dispatch.errMessage;
    } else {
      d.failure = F_BUG;
    }
    return d;
  }

  // Works out what it takes to know about a file found by the search: whether it is wanted, its language, and its options.
  // Called while the search still goes on, so that the main thread has something to do while the workers walk.
  prepare(configs: Configs, ignored: Ignored, target: Target): void {
    if (target.prepared) return;
    target.prepared = true;
    if (target.isNamed) target.wanted = !ignored.ignoresFile(target.path, configs.ignoresOf(target.scope));
    else target.wanted = !(kinds.isGenerated(target.path) && configs.isNativeIn(target.scope));
    if (!target.wanted) return;
    target.language = files.languageIn(configs, target.scope, target.path);
    if (target.language !== kinds.LANG_SUPPORTED) return;
    if (!this.options.allowUnsupported && configs.missingPlugins(target.scope, target.path).length > 0) return;
    target.work = true;
    if (this.options.listFiles) return;
    this.resolveTarget(configs, target);
  }

  // Gives the pool a file that is to be formatted (the files that the search finds, as it finds them).
  offer(configs: Configs, pool: Pool, target: Target): void {
    if (!target.wanted) return;
    if (!target.work) {
      // a file that a plugin would read, with --allow-unsupported
      if (target.language !== kinds.LANG_OTHER || !this.options.allowUnsupported) return;
      if (configs.pluginThatReads(target.scope, target.path) === "" || kinds.languageOf(target.path) !== kinds.LANG_SUPPORTED) return;
      target.work = true;
    }
    this.resolveTarget(configs, target);
    if (target.setError !== "" || target.setId < 0) return;
    if (!pool.add(target, this.optionSets)) this.tooMany = true;
  }

  // The options of a file: its `setId`, or its `setError`.
  resolveTarget(configs: Configs, target: Target): void {
    if (target.setId >= 0 || target.setError !== "") return;
    let resolved: Resolved;
    try {
      resolved = configs.optionsFor(target.scope, target.path);
    } catch (e) {
      if (e instanceof Fatal) {
        target.setError = e.message;
        return;
      }
      throw e;
    }
    const key = resolved.key;
    let id = this.setByKey.get(key);
    if (id === undefined) {
      id = this.optionSets.length;
      this.optionSets.push(new OptionSet(id, resolved, this.options.debugCheck));
      this.setByKey.set(key, id);
    }
    target.setId = id;
  }

  // Prettier's `formatFiles`
  async formatFiles(configs: Configs, ignored: Ignored): Promise<Outcome> {
    const options = this.options;
    const cwd = this.cwd;
    // Files are written unless a flag says otherwise.
    const asksForDifferent = (options.check || options.listDifferent) && !options.write;
    const onlyLooks = asksForDifferent || options.debugCheck;
    let only: GitFiles | null = null;
    if (options.hasOnly()) {
      const g = new GitFiles(options, cwd);
      const why = g.read(!onlyLooks);
      if (why !== "") return this.fail(why);
      only = g;
    }
    const isOxfmt = configs.flavor === 1;
    if (options.check && !this.isNative) {
      this.log("Checking formatting...");
      if (isOxfmt) this.log("");
    }
    const threads = options.threads > 0 ? options.threads : os.availableParallelism();
    const patterns = options.patterns.length === 0 ? ["."] : options.patterns;
    const started = performance.now();
    let expanded: Expanded[];
    // The files are formatted while they are still being found: the walk is one thread (this one), the workers start with the
    // first files. Only for one argument that is a directory or a pattern, and when nothing else decides which files are formatted.
    const detail = isOxfmt || options.compareTo !== null;
    const writes = !onlyLooks;
    const cfg = new w.LoopCfg(writes, detail, PIPE_CHUNK, options.compareTo === null ? "" : options.compareTo, this.cwd + "/", options.dumpTo === null ? "" : options.dumpTo, this.cwd);
    const pipelined = PIPELINE && !isOxfmt && only === null && patterns.length === 1 && !options.listFiles && !options.dumpOptions;
    let pool: Pool | null = null;
    if (pipelined) {
      pool = new Pool(threads, cfg);
      this.pool = pool;
    }
    try {
      if (isOxfmt) expanded = expandAsOxfmt(configs, ignored, patterns, options.errorOnUnmatchedPattern);
      else if (pool !== null) {
        const p = pool;
        expanded = await files.expand(
          configs,
          ignored,
          patterns,
          options.errorOnUnmatchedPattern,
          SCAN_THREADS > 0 ? SCAN_THREADS : threads >= 12 ? 2 : 1,
          !options.listFiles && SIZES,
          (t: Target): void => {
            this.prepare(configs, ignored, t);
            this.offer(configs, p, t);
          },
          (): void => p.flush(),
          // In check mode nothing more will come when the walk is done. When files are written, nothing is formatted before the
          // search has succeeded (a configuration that cannot be read stops the run).
          (): void => {
            if (process.env["FMT_TRACE"] !== undefined) this.out.err("walk done at " + (performance.now() - this.began).toFixed(1) + "ms, " + p.spawned + " workers, backlog " + p.backlog() + "\n");
            if (!writes) p.finish();
          },
        );
      } else expanded = await files.expand(configs, ignored, patterns, options.errorOnUnmatchedPattern, threads, !options.listFiles, (t: Target): void => this.prepare(configs, ignored, t), null, null);
    } catch (e) {
      if (e instanceof Fatal) return this.failToStart(e.message);
      throw e;
    }
    if (only !== null) {
      const kept: Expanded[] = [];
      for (let i = 0; i < expanded.length; i++) {
        const x = expanded[i];
        if (x.target === null || only.has(x.target.path)) kept.push(x);
      }
      expanded = kept;
      if (expanded.length === 0) {
        if (options.logLevel >= cli.LOG_LOG) this.out.err(only.nothingLeft("format") + "\n");
        return this.out;
      }
    }
    const finding = performance.now() - started;
    const trace = process.env["FMT_TRACE"] !== undefined;
    let traceAt = performance.now();
    const tick = (what: string): void => {
      if (!trace) return;
      const now = performance.now();
      this.out.err(what + ": " + (now - traceAt).toFixed(1) + "ms\n");
      traceAt = now;
    };
    if (trace) this.out.err("expand: " + finding.toFixed(1) + "ms (since start " + (started - this.began).toFixed(1) + ")\n");

    // What is not to be formatted after all.
    const othersEnding: string[] = [];
    const othersCount: number[] = [];
    let leftForPluginsCount = 0;
    const leftForPluginsNames: string[] = [];
    const work: number[] = []; // indices into `expanded`
    const notInstalled: string[] = [];
    const done: Done[] = [];
    for (let index = 0; index < expanded.length; index++) {
      const d = new Done();
      done.push(d);
      const target = expanded[index].target;
      if (target === null) continue;
      this.prepare(configs, ignored, target);
      if (!target.wanted) continue;
      const language = target.language;
      const missingPlugins = options.allowUnsupported ? [] : configs.missingPlugins(target.scope, target.path);
      if (language === kinds.LANG_SUPPORTED && missingPlugins.length > 0) {
        leftForPluginsCount = leftForPluginsCount + 1;
        for (let i = 0; i < missingPlugins.length; i++) if (leftForPluginsNames.indexOf(missingPlugins[i]) < 0) leftForPluginsNames.push(missingPlugins[i]);
      } else if (language === kinds.LANG_SUPPORTED) {
        work.push(index);
      } else if (language === kinds.LANG_OTHER) {
        const plugin = configs.pluginThatReads(target.scope, target.path);
        if (plugin !== "") {
          const list = this.notInstalled(configs, target.scope, target.path);
          for (let i = 0; i < list.length; i++) if (notInstalled.indexOf(list[i]) < 0) notInstalled.push(list[i]);
        }
        // It is the plugin that is missing, not the language.
        if (plugin !== "" && kinds.languageOf(target.path) === kinds.LANG_SUPPORTED) {
          if (options.allowUnsupported) work.push(index);
          else {
            leftForPluginsCount = leftForPluginsCount + 1;
            if (leftForPluginsNames.indexOf(plugin) < 0) leftForPluginsNames.push(plugin);
          }
          continue;
        }
        const ending = kinds.endingOf(target.path);
        const at = othersEnding.indexOf(ending);
        if (at >= 0) othersCount[at] = othersCount[at] + 1;
        else {
          othersEnding.push(ending);
          othersCount.push(1);
        }
      } else if (target.ignoresUnknown || options.ignoreUnknown) {
        // nothing is said
      } else {
        d.kind = DN_FAILED;
        d.message = 'No parser could be inferred for file "' + target.path + '".';
      }
    }
    tick("classify");
    if (options.listFiles) {
      for (let i = 0; i < work.length; i++) this.out.out(paths.relative(cwd, (expanded[work[i]].target as Target).path) + "\n");
      return this.out;
    }
    // The options of every file: most are resolved already.
    const optionSets = this.optionSets;
    const workSet: number[] = [];
    for (let i = 0; i < work.length; i++) {
      const target = expanded[work[i]].target as Target;
      this.resolveTarget(configs, target);
      if (target.setError !== "") {
        done[work[i]].kind = DN_FAILED;
        done[work[i]].message = target.setError;
        workSet.push(-1);
      } else workSet.push(target.setId);
    }
    tick("resolve options");
    if (options.dumpOptions) {
      for (let i = 0; i < work.length; i++) {
        const target = expanded[work[i]].target as Target;
        const id = workSet[i];
        this.out.out(paths.relative(cwd, target.path) + "\t" + (id < 0 ? "ERROR " + done[work[i]].message : optionSets[id].resolved.key.replace(/\u0001/g, " ").replace(/\u0002/g, "=")) + "\n");
      }
      return this.out;
    }
    tick("sort");
    const formatStart = performance.now();
    if (this.tooMany) return this.fail("There are too many files to format at once.");
    // Whatever the search did not hand over while it went on (named files, a search that was not pipelined) is added now, in the
    // order of the arguments, and then the workers are told that there is no more.
    const pl: Pool = pool !== null ? pool : new Pool(threads, cfg);
    this.pool = pl;
    const exOf0: number[] = [];
    const exOf1: number[] = [];
    for (let i = 0; i < work.length; i++) {
      if (workSet[i] < 0) continue;
      const target = expanded[work[i]].target as Target;
      if (target.jobKey < 0 && !pl.add(target, optionSets)) return this.fail("There are too many files to format at once.");
      if ((target.jobKey & 1) === 1) exOf1[target.jobKey >> 1] = work[i];
      else exOf0[target.jobKey >> 1] = work[i];
    }
    pl.finish();
    if (MAIN_WORKS) pl.consumeHere();
    await pl.join();
    const formatting = performance.now() - formatStart;
    tick("workers");
    if (trace) {
      let line = "workers (busy ms/files):";
      for (let r = 0; r < pl.reports.length; r++) line += " " + pl.reports[r].ms.toFixed(0) + "/" + pl.reports[r].files;
      this.out.err(line + "\n");
    }
    // fold the reports into `done`
    const compare = new CompareStats();
    for (let lane = 0; lane < 2; lane++) {
      const status = pl.statusOf(lane);
      const exOf = lane === 1 ? exOf1 : exOf0;
      for (let k = 0; k < status.length; k++) {
        const st = status[k];
        if (st === pipe.ST_UNCHANGED) done[exOf[k]].kind = DN_UNCHANGED;
        else if (st === pipe.ST_DIFFERENT) {
          const ex = exOf[k];
          if (!onlyLooks && only !== null && only.isPartlyStaged((expanded[ex].target as Target).path)) done[ex].kind = DN_PARTLY_STAGED;
          else done[ex].kind = DN_DIFFERENT;
        }
      }
    }
    const reports = pl.reports;
    for (let r = 0; r < reports.length; r++) {
      const rep = reports[r];
      for (let k = 0; k < rep.idx.length; k++) {
        const key = rep.idx[k];
        const ex = (key & 1) === 1 ? exOf1[key >> 1] : exOf0[key >> 1];
        const d = done[ex];
        const code = rep.code[k];
        d.tookMs = rep.took[k];
        if (code === w.D_UNCHANGED) d.kind = DN_UNCHANGED;
        else if (code === w.D_DIFFERENT) {
          if (!onlyLooks && only !== null && only.isPartlyStaged((expanded[ex].target as Target).path)) d.kind = DN_PARTLY_STAGED;
          else d.kind = DN_DIFFERENT;
        } else if (code === w.D_FAILED) {
          d.kind = DN_FAILED;
          d.message = rep.message[k];
        } else if (code === w.D_COMPARE) {
          compare.add((expanded[ex].target as Target).path, rep.line[k], rep.message[k]);
          d.kind = DN_UNCHANGED;
        } else {
          d.kind = DN_REFUSED;
          if (code === w.D_REFUSED) {
            d.failure = F_SYNTAX;
            d.problem = new Problem(rep.message[k], rep.line[k], rep.column[k], rep.lineText[k]);
          } else if (code === w.D_UNREAD) {
            d.failure = F_UNREAD;
            d.problem = new Problem(rep.message[k], rep.line[k], rep.column[k], rep.lineText[k]);
          } else if (code === w.D_CHANGED) {
            d.failure = F_CHANGED;
            d.message = rep.message[k];
          } else d.failure = F_BUG;
        }
      }
    }
    if (options.compareTo !== null) {
      compare.print(this.out, options.compareList);
      return this.out;
    }

    let different = 0;
    let unchanged = 0;
    let failed = 0;
    const partlyStaged: string[] = [];
    const writtenFiles: string[] = [];
    for (let i = 0; i < expanded.length; i++) {
      const x = expanded[i];
      if (x.target === null) {
        this.error(x.error as string);
        continue;
      }
      const target = x.target;
      const shown = paths.relative(cwd, target.path);
      const d = done[i];
      if (d.kind === DN_NONE) continue;
      if (d.kind === DN_UNCHANGED) {
        unchanged = unchanged + 1;
        if (options.debugCheck) this.log(shown);
      } else if (d.kind === DN_REFUSED && d.failure === F_UNREAD) {
        unchanged = unchanged + 1;
        this.report(shown, d);
      } else if (d.kind === DN_REFUSED) {
        failed = failed + 1;
        this.report(shown, d);
      } else if (d.kind === DN_FAILED) {
        if (isInvalidValue(d.message)) {
          this.error(d.message);
          this.out.exitCode = 1;
          return this.out;
        }
        failed = failed + 1;
        this.error(d.message);
      } else if (d.kind === DN_PARTLY_STAGED) {
        failed = failed + 1;
        partlyStaged.push(target.path);
      } else if (d.kind === DN_DIFFERENT) {
        different = different + 1;
        if (!onlyLooks && only !== null) writtenFiles.push(target.path);
        if (isOxfmt && options.check) this.logWithTime(shown, d.tookMs);
        else if (isOxfmt && !options.listDifferent) {
          // oxfmt does not name the files that it writes.
        } else if (!isOxfmt && options.check && !this.isNative) this.listAsPrettier(shown);
        else if (!isOxfmt && options.check) {
          // The list of files is what `--check` was asked for, so it goes to stdout.
          if (options.logLevel >= cli.LOG_WARN) this.out.out(shown + "\n");
        } else if (!isOxfmt && options.debugCheck && !options.listDifferent) {
          // Every file that passes is named below.
        } else this.log(shown);
        if (options.debugCheck) this.log(shown);
      }
    }
    if (only !== null) {
      if (partlyStaged.length > 0) this.error(only.refusalToWrite(partlyStaged, "formatted"));
      const why = only.stage(writtenFiles);
      if (why !== "") this.error(why);
    }
    for (let i = 0; i < configs.warnings.length; i++) this.warn(configs.warnings[i]);
    configs.warnings = [];
    const count = (n: number): string => (n === 1 ? "the above file" : n + " files");
    this.hasLeftFiles = leftForPluginsCount > 0 || othersEnding.length > 0;
    // oxfmt has no `--debug-check`, so there it is as without a config.
    if (isOxfmt && (options.check || !options.debugCheck)) {
      this.sumUpAsOxfmt(different, unchanged, failed, threads);
    } else if (this.isNative) {
      if (options.check && onlyLooks) this.sumUpCheck(different, unchanged, failed);
    } else if (options.check) {
      if (failed > 0) this.log("Error occurred when checking code style in " + count(failed) + ".");
      else if (different === 0) {
        if (!this.hasLeftFiles) this.log("All matched files use Prettier code style!");
      } else if (onlyLooks) this.listAsPrettier("Code style issues found in " + count(different) + ". Run bun fmt to fix.");
      else this.listAsPrettier("Code style issues fixed in " + count(different) + ".");
    }
    if (asksForDifferent && different > 0 && this.out.exitCode === 0) this.out.exitCode = 1;
    const sumsUp = this.isNative ? !onlyLooks : !isOxfmt && !options.check && !options.listDifferent && !onlyLooks;
    if (options.logLevel >= cli.LOG_LOG && sumsUp) {
      const colors = this.colors();
      const took = elapsed(performance.now() - this.began, colors);
      this.out.err(pretty("Formatted " + different + " " + fileNoun(different) + "<d>, " + unchanged + " unchanged " + took + "<r>\n", colors));
    }
    if (options.timing) {
      this.out.err(
        "  wall: " + finding.toFixed(1) + "ms finding files and configs, " + formatting.toFixed(1) + "ms formatting, " + (performance.now() - this.began).toFixed(1) + "ms total, " + threads + " threads\n",
      );
    }
    if (configs.unsupportedOptions.length > 0) {
      const text = configs.unsupportedOptions.join(", ") + (configs.unsupportedOptions.length === 1 ? " is not supported yet and has no effect" : " are not supported yet and have no effect");
      if (options.allowUnsupported) this.warn(text);
      else this.error(text + MAKE_IT_A_WARNING);
    }
    if (leftForPluginsCount > 0) this.sayLeftForPlugins(leftForPluginsCount, leftForPluginsNames);
    // The tool that this stands in for would have formatted or checked them, so this comes last and is an error.
    if (othersEnding.length > 0) this.saySupported(othersEnding, othersCount, notInstalled);
    else this.sayNotInstalled(notInstalled);
    return this.out;
  }
}

class ByteBufHolder {
  buf: ByteBuf;
  constructor() {
    this.buf = new ByteBuf(1 << 16);
  }
}

function sameBytes(a: Uint8Array, alen: number, b: Uint8Array, blen: number): boolean {
  if (alen !== blen) return false;
  for (let i = 0; i < alen; i++) if ((a[i] | 0) !== (b[i] | 0)) return false;
  return true;
}

function isStdinTty(): boolean {
  return tty.isatty(0);
}

function isProbablyJsx(text: Uint8Array): boolean {
  // `bun_format::html::is_probably_jsx`: a `<` followed by a letter or `>`
  for (let i = 0; i + 1 < text.length; i++) {
    if (text[i] === 60) {
      const c = text[i + 1];
      if (c === 62 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
    }
  }
  return false;
}

export function isInstalled(directory: string, name: string): boolean {
  const dirs = paths.ancestors(directory);
  for (let i = 0; i < dirs.length; i++) {
    const pkg = paths.join(paths.join(dirs[i], "node_modules"), name);
    if (fsx.isFile(paths.join(pkg, "package.json"))) return true;
  }
  return false;
}

function cannotForceParserOn(written: string, parser: string): string {
  let extension: string;
  if (parser === "typescript" || parser === "babel-ts" || parser === "oxc-ts") extension = "ts";
  else if (parser === "markdown" || parser === "remark") extension = "md";
  else if (parser === "glimmer") extension = "hbs";
  else if (parser === "json-stringify") extension = "json";
  else if (parser === "angular" || parser === "lwc") extension = "html";
  else if (parser.startsWith("__")) extension = "";
  else if (kinds.kindOfParser(parser) === kinds.KIND_SCRIPT) extension = "js";
  else extension = parser;
  let text = "--parser " + parser + ' would read every file in "' + written + '" as ' + parser;
  if (extension === "") return text + "\n  Name the files, or use a glob.";
  let directory = written;
  if (directory.endsWith("/")) directory = directory.substring(0, directory.length - 1);
  const base = directory === "." || directory === "" ? "" : directory + "/";
  text += "\n  Name the files, or use a glob: bun fmt --parser " + parser + ' "' + base + "**/*." + extension + '"';
  return text;
}

export let parseTomlInitMessage = "";

function parseTomlForInit(text: string): string {
  const v = parseTomlLazy(text);
  if (v === null) return "error";
  return v.get("fmt") !== null ? "has" : "no";
}

function parseTomlLazy(text: string): JV | null {
  const v = parseToml(text);
  if (v === null) parseTomlInitMessage = tomlError + "\n  at bunfig.toml:" + tomlErrorLine + ":" + tomlErrorColumn;
  return v;
}

class CompareStats {
  exts: string[] = [];
  match: number[] = [];
  mismatch: number[] = [];
  missing: number[] = [];
  mismatchPaths: string[] = [];
  add(path: string, state: number, detail: string): void {
    const ext = kinds.endingOf(path);
    let i = this.exts.indexOf(ext);
    if (i < 0) {
      this.exts.push(ext);
      this.match.push(0);
      this.mismatch.push(0);
      this.missing.push(0);
      i = this.exts.length - 1;
    }
    if (state === 0) this.match[i] = this.match[i] + 1;
    else if (state === 1) {
      this.mismatch[i] = this.mismatch[i] + 1;
      this.mismatchPaths.push(path);
    } else this.missing[i] = this.missing[i] + 1;
  }
  print(out: Outcome, list: boolean): void {
    const order: number[] = [];
    for (let i = 0; i < this.exts.length; i++) order.push(i);
    order.sort((a, b) => (this.exts[a] < this.exts[b] ? -1 : this.exts[a] > this.exts[b] ? 1 : 0));
    let tm = 0;
    let tx = 0;
    let tz = 0;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      out.out(this.exts[i].padEnd(12) + " match " + String(this.match[i]).padStart(6) + "  mismatch " + String(this.mismatch[i]).padStart(6) + "  missing " + String(this.missing[i]).padStart(4) + "\n");
      tm = tm + this.match[i];
      tx = tx + this.mismatch[i];
      tz = tz + this.missing[i];
    }
    out.out("total        match " + String(tm).padStart(6) + "  mismatch " + String(tx).padStart(6) + "  missing " + String(tz).padStart(4) + "\n");
    if (list) {
      this.mismatchPaths.sort();
      for (let i = 0; i < this.mismatchPaths.length; i++) out.out("MISMATCH " + this.mismatchPaths[i] + "\n");
    }
  }
}

// ---- `--staged` and `--changed` ----

class GitFiles {
  options: cli.Options;
  cwd: string;
  top: string;
  named: Set<string>;
  partlyStaged: Set<string>;
  constructor(options: cli.Options, cwd: string) {
    this.options = options;
    this.cwd = cwd;
    this.top = "";
    this.named = new Set<string>();
    this.partlyStaged = new Set<string>();
  }

  nothingLeft(verb: string): string {
    return this.options.onlyStaged ? "No staged files to " + verb : "No changed files to " + verb;
  }

  git(args: string[], input: string): { ok: boolean; stdout: string; stderr: string; notFound: boolean; failed: string } {
    process.env["GIT_NO_LAZY_FETCH"] = "1";
    const r = childProcess.spawnSync("git", args, { encoding: "utf8" });
    if (r.error !== undefined && r.error !== null) {
      const code = (r.error as { code?: string }).code;
      if (code === "ENOENT") return { ok: false, stdout: "", stderr: "", notFound: true, failed: "" };
      return { ok: false, stdout: "", stderr: "", notFound: false, failed: String(r.error) };
    }
    return { ok: r.status === 0, stdout: r.stdout === null ? "" : r.stdout, stderr: r.stderr === null ? "" : r.stderr, notFound: false, failed: "" };
  }

  inTheWordsOfGit(first: string, stderr: string): string {
    let text = first;
    const lines = stderr.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\s+$/, "");
      if (line.length > 0) text += "\n  " + line;
    }
    return text;
  }

  // "" or an error message
  read(writes: boolean): string {
    const flag = this.options.onlyFlag();
    const found = this.git(["rev-parse", "--show-toplevel", "--show-cdup"], "");
    if (found.notFound) return "Cannot find git in PATH\n  " + flag + " asks git for the files";
    if (found.failed !== "") return "Cannot run git\n  " + found.failed;
    if (!found.ok) return this.inTheWordsOfGit(flag + " needs a git repository", found.stderr);
    const printed = found.stdout.endsWith("\n") ? found.stdout.substring(0, found.stdout.length - 1) : found.stdout;
    const nl = printed.lastIndexOf("\n");
    const up = nl < 0 ? printed : printed.substring(nl + 1);
    const top = paths.resolve(this.cwd, up);
    this.top = top;
    const DIFF = ["--no-optional-locks", "-c", "diff.relative=false", "diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=all", "--no-ext-diff", "--no-textconv"];
    const IS_THERE = "--diff-filter=AMT";
    if (this.options.onlyStaged) {
      const r = this.names(top, DIFF.concat(["--cached", IS_THERE]));
      if (typeof r === "string") return r;
      this.named = r;
      if (writes) {
        const p = this.names(top, DIFF);
        if (typeof p === "string") return p;
        this.partlyStaged = p;
      }
    } else {
      let since: string;
      if (this.options.onlyRef !== null) {
        const c = this.commit(this.options.onlyRef);
        if (c.error !== "") return c.error;
        since = c.id;
      } else {
        const c = this.defaultBranch();
        if (c.error !== "") return c.error;
        since = c.id;
      }
      const r = this.names(top, DIFF.concat([IS_THERE, since, "--"]));
      if (typeof r === "string") return r;
      this.named = r;
      const extra = this.names(top, ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", up === "" ? "." : up]);
      if (typeof extra === "string") return extra;
      extra.forEach((v) => this.named.add(v));
    }
    return "";
  }

  names(top: string, args: string[]): Set<string> | string {
    const f = this.git(args, "");
    if (f.notFound) return "Cannot find git in PATH\n  " + this.options.onlyFlag() + " asks git for the files";
    if (!f.ok) return this.inTheWordsOfGit(this.options.onlyFlag() + " cannot read the git repository", f.stderr);
    const out = new Set<string>();
    const parts = f.stdout.split("\0");
    for (let i = 0; i < parts.length; i++) if (parts[i].length > 0) out.add(paths.join(top, parts[i]));
    return out;
  }

  commit(written: string): { id: string; error: string } {
    const unknown = '"' + written + '" is not a branch, tag or commit in this repository';
    if (written.startsWith("-")) return { id: "", error: unknown };
    const f = this.git(["rev-parse", "--verify", "--quiet", written + "^{commit}"], "");
    const id = f.stdout.trim();
    if (f.ok && id.length > 0 && /^[0-9a-fA-F]+$/.test(id)) return { id: id, error: "" };
    return { id: "", error: unknown };
  }

  defaultBranch(): { id: string; error: string } {
    const branches = ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"];
    for (let i = 0; i < branches.length; i++) {
      const f = this.git(["merge-base", "HEAD", branches[i]], "");
      const id = f.stdout.trim();
      if (f.ok && id.length > 0 && /^[0-9a-fA-F]+$/.test(id)) return { id: id, error: "" };
    }
    if (this.commit("HEAD").error !== "") {
      return { id: "", error: "--changed has nothing to compare with, because this repository has no commits\n  Use --staged for the files that you have added" };
    }
    return { id: "", error: "--changed cannot find the default branch\n  It tried origin/HEAD, main and master. Name a branch or a commit with --changed=<ref>" };
  }

  asListed(path: string): string {
    if (paths.inside(this.top, path) !== null) return path;
    const dir = fsx.realPath(paths.dirname(path));
    if (dir === null) return path;
    return paths.join(dir, paths.basename(path));
  }

  has(path: string): boolean {
    return this.named.has(this.asListed(path)) && fsx.linkKindAndSize(path) === fsx.K_FILE;
  }

  isPartlyStaged(path: string): boolean {
    return this.partlyStaged.has(this.asListed(path));
  }

  refusalToWrite(list: string[], done: string): string {
    list.sort();
    const wayOut = "\n  Stage the rest with git add, or put it away with git stash --keep-index. Then run this again.";
    const said = " both staged and unstaged changes, so ";
    if (list.length === 1) return paths.relative(this.cwd, list[0]) + " has" + said + "it was not " + done + wayOut;
    let text = list.length + " files have" + said + "they were not " + done;
    for (let i = 0; i < list.length; i++) text += "\n  " + paths.relative(this.cwd, list[i]);
    return text + wayOut;
  }

  stage(written: string[]): string {
    if (!this.options.onlyStaged || written.length === 0) return "";
    for (let at = 0; at < written.length; at += 200) {
      const args: string[] = ["update-index", "--"];
      for (let i = at; i < written.length && i < at + 200; i++) args.push(paths.relative(this.cwd, this.asListed(written[i])));
      const f = this.git(args, "");
      if (!f.ok) return this.inTheWordsOfGit("Cannot stage the files that were written\n  Stage them with git add", f.stderr);
    }
    return "";
  }
}

