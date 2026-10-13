// The process: arguments, the working directory, bunfig.toml, colors, and the output. `src/main.ts` calls `main`.
import * as fs from "node:fs";
import * as tty from "node:tty";
import { readBunfig, bunfigProblem } from "./bunfig.ts";
import * as cli from "./cli.ts";
import { HELP_ALL, HELP_COMMON } from "./help.ts";
import { Configs } from "./config.ts";
import { Outcome, Run } from "./run.ts";

export const VERSION = "1.4.4";

// Writes all of `data` to the file descriptor (a pipe may take only part of it at a time).
export function writeAll(fd: number, data: Uint8Array): void {
  let off = 0;
  let spins = 0;
  while (off < data.length) {
    try {
      off = off + fs.writeSync(fd, data, off, data.length - off);
      spins = 0;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EAGAIN") {
        spins = spins + 1;
        if (spins > 1000000) return;
        continue;
      }
      return;
    }
  }
}

function writeString(fd: number, parts: string[]): void {
  if (parts.length === 0) return;
  const s = parts.length === 1 ? parts[0] : parts.join("");
  if (s.length === 0) return;
  writeAll(fd, Buffer.from(s));
}

function envNonEmpty(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v.length > 0;
}

function stderrColors(): boolean {
  if (envNonEmpty("NO_COLOR")) return false;
  const force = process.env["FORCE_COLOR"];
  if (force !== undefined && force.length > 0 && force !== "0") return true;
  return tty.isatty(2);
}

function stdoutColors(): boolean {
  if (envNonEmpty("NO_COLOR")) return false;
  const force = process.env["FORCE_COLOR"];
  if (force !== undefined && force.length > 0 && force !== "0") return true;
  return tty.isatty(1);
}

function finish(out: Outcome): void {
  if (out.stdoutBytes !== null) writeAll(1, out.stdoutBytes);
  else writeString(1, out.stdout);
  writeString(2, out.stderr);
  process.exit(out.exitCode);
}

// Prints an error that is a usage error: the exit code is 2.
function usage(message: string): void {
  const colors = stderrColors();
  let text = colors ? "\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m " + message + "\n" : "error: " + message + "\n";
  text += colors ? "\x1b[34mnote\x1b[0m\x1b[2m:\x1b[0m run 'bun fmt --help' for more information\n" : "note: run 'bun fmt --help' for more information\n";
  writeAll(2, Buffer.from(text));
  process.exit(2);
}

export async function main(args: string[]): Promise<void> {
  // `--cwd` is applied before anything is read.
  let cwdArg: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    if (args[i].startsWith("--cwd=")) cwdArg = args[i].substring(6);
    else if (args[i] === "--cwd" && i + 1 < args.length) {
      cwdArg = args[i + 1];
      i = i + 1;
    }
  }
  if (cwdArg !== null) {
    try {
      process.chdir(cwdArg);
    } catch (e) {
      const code = (e as { code?: string }).code;
      const why = code === "ENOTDIR" ? "ENOTDIR: Not a directory" : code === "EACCES" ? "EACCES: Permission denied" : "ENOENT: No such file or directory";
      writeAll(2, Buffer.from(why + ': Could not change directory to "' + cwdArg + '" (chdir)\n'));
      process.exit(1);
    }
  }
  const cwd = process.cwd();
  const colorsErr = stderrColors();
  const defaults = readBunfig(cwd, colorsErr);
  if (bunfigProblem !== "") {
    writeAll(2, Buffer.from(bunfigProblem));
    process.exit(2);
  }
  let options: cli.Options | null;
  if (defaults !== null) options = cli.Options.parseOver(defaults, args);
  else options = cli.Options.parse(args);
  if (options === null) {
    usage(cli.usageError);
    return;
  }
  if (options.help) {
    writeAll(1, Buffer.from(options.all ? HELP_ALL : HELP_COMMON));
    process.exit(0);
  }
  // oxfmt reads `-c <path>` as `--config <path>`
  const asOxfmt = options.asOxfmtReadsIt();
  if (asOxfmt !== null && new Configs(options, cwd).flavor === 1) options = asOxfmt;
  const repeat = process.env["FMT_REPEAT"];
  if (repeat !== undefined) {
    // a dev aid for profiling: run the whole thing several times in this process
    const n = Number(repeat);
    for (let i = 1; i < n; i++) await new Run(options, cwd, VERSION, colorsErr, stdoutColors()).execute();
  }
  const run = new Run(options, cwd, VERSION, colorsErr, stdoutColors());
  const out = await run.execute();
  finish(out);
}
