// The conformance runner every language porter uses: Bun's `bun fmt --run-prettier-tests` / `--run-oxfmt-tests`
// (vendor/bun/src/format/conformance) on our formatter. Runs under node and compiles with scriptc.
//
//   zstd -dc vendor/bun/test/cli/format/prettier/bundle.zst > /tmp/prettier-bundle.txt
//   zstd -dc vendor/bun/test/cli/format/oxfmt/bundle.zst > /tmp/oxfmt-bundle.txt
//   node tools/conformance.ts prettier [bundle] [--languages=json,css] [--filter=text] [--table] [--report=dir]
//   node tools/conformance.ts oxfmt [bundle] [--filter=text] [--report=dir]
//
// `--run-prettier-tests <bundle>` / `--run-oxfmt-tests <bundle>` are accepted as in Bun. Without a bundle the files
// above are read. The report is that of vendor/bun/test/cli/format/prettier/expected.txt (and oxfmt/expected.txt):
// `FAIL <check> <case> <options>` per failing check, a line per language, the totals, and what is not run. A case
// whose language nobody has plugged in (src/format/conformance/dispatch.ts) is "not ported": it is counted apart.
//
// Checks of the runner itself (not of a formatter): `--identity` (every text is its own formatted text: the
// denominators of `format` and `rejected` are Bun's) and `--mock` (the formatted text is what the snapshot says).
//
// scriptc build tools/conformance.ts -o /tmp/conformance   (SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-conf)
import { MODE_IDENTITY, MODE_MOCK, flushOutput, outputLine, parseBundle, parseFlags, readFile, setFormatMode } from "../src/format/conformance/lib.ts";
import * as oxfmt from "../src/format/conformance/oxfmt.ts";
import * as prettier from "../src/format/conformance/prettier.ts";

function usage(): void {
  outputLine("usage: conformance.ts prettier|oxfmt [bundle] [--languages=js,css,..] [--filter=text] [--table] [--report=dir]");
  outputLine("                      [--every=n --first=i] [--identity | --mock]");
  outputLine("  zstd -dc vendor/bun/test/cli/format/prettier/bundle.zst > /tmp/prettier-bundle.txt");
  outputLine("  zstd -dc vendor/bun/test/cli/format/oxfmt/bundle.zst > /tmp/oxfmt-bundle.txt");
}

function main(): number {
  const argv = process.argv;
  const args: string[] = [];
  for (let i = 2; i < argv.length; i++) args.push(argv[i]);
  let which = "";
  let bundlePath = "";
  const flagArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "prettier" || a === "--run-prettier-tests") which = "prettier";
    else if (a === "oxfmt" || a === "--run-oxfmt-tests") which = "oxfmt";
    else if (a === "--identity") setFormatMode(MODE_IDENTITY);
    else if (a === "--mock") setFormatMode(MODE_MOCK);
    else if (a.startsWith("--")) flagArgs.push(a);
    else if (bundlePath.length === 0) bundlePath = a;
  }
  if (which.length === 0) {
    usage();
    flushOutput();
    return 2;
  }
  if (bundlePath.length === 0) bundlePath = which === "prettier" ? "/tmp/prettier-bundle.txt" : "/tmp/oxfmt-bundle.txt";
  const bytes = readFile(bundlePath);
  if (bytes === null) {
    outputLine("cannot read the bundle " + bundlePath);
    usage();
    flushOutput();
    return 1;
  }
  const bundle = parseBundle(bytes);
  if (bundle === null) {
    outputLine("the bundle is malformed");
    flushOutput();
    return 1;
  }
  const flags = parseFlags(flagArgs);
  if (which === "prettier") prettier.run(bundle, flags);
  else oxfmt.run(bundle, flags);
  flushOutput();
  return 0;
}

const code = main();
if (code !== 0) process.exit(code);
