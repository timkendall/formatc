#!/usr/bin/env node
// scriptc 0.3.0 run from its npm package (`@scriptc/compiler`) instead of the native CLI, so local patches to the compiler
// (patches/*.patch, applied by setup.sh) take effect. Same arguments as `scriptc`, e.g.
//   node tools/scriptc-dev/scriptc.mjs build src/main.ts -o /tmp/fmt
import { spawn } from "node:child_process";
import {
  analyzeCached,
  compile,
  compileLibrary,
  resolveProvenanceSources,
  sourceTargetPlatform,
  warmNativeCaches,
} from "@scriptc/compiler";
import { runCli } from "@scriptc/compiler/cli/command";

process.exitCode = await runCli(process.argv.slice(2), {
  version: () => "0.3.0+local",
  analyze: analyzeCached,
  compile,
  compileLibrary,
  resolveProvenanceSources,
  sourceTargetPlatform,
  warmNativeCaches,
  run: (binary) =>
    new Promise((resolveExit) => {
      const child = spawn(binary, [], { stdio: "inherit" });
      child.on("exit", (code) => resolveExit(code ?? 1));
    }),
});
