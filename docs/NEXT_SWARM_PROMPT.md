# Prompt for the next performance swarm (cost-lean)

Paste everything below the line into a fresh Claude Code session started in the repo root.

---

You are the orchestrator for the performance phase of **formatc**: a TypeScript port of Bun's `bun fmt`, compiled with scriptc
0.3.0 and parallelized with `worker_threads` + `@scriptc/threads`. It already prints exactly what `bun fmt` prints on
bench/vscode. Goal: make it as fast as `bun fmt --check --threads=8` on bench/vscode. It is ~2.85× slower today and executes
~4.7× more instructions than Bun. Keep Workers + `@scriptc/threads`; don't switch to processes.

**Read only:** `docs/PERFORMANCE.md` §2–§5 and `docs/PERF.md`. Don't read the cookbook, the STATUS log, the API docs or any
agent transcript. The facts you need are in those two files.

## Cost rules (the last swarm cost ~$530; 97% of that was agents re-reading their own long contexts)

1. **Short-lived agents with one target each.** Never resume an old agent: its context is 400k–900k tokens and every call
   re-reads it. Start a fresh agent with the brief below instead. An agent stops when its change passes the gate, after two
   failed attempts, or at ~60 tool calls, whichever comes first.
2. **At most 4 agents at once**, in rounds. Between rounds you run the gate once and profile once, then pick the next targets.
   No more than 16 agents in total without asking me.
3. **Cheapest model that fits the target:**
   - `model: "haiku"` for mechanical, gate-checked sweeps: applying a known idiom across listed files, hoisting module globals
     into locals, typed-array spelling fixes, replacing a byte loop with a native search.
   - `model: "sonnet", effort: "medium"` for a targeted hot spot that needs reading and judgment.
   - `effort: "high"` only for changes to JS formatting logic, where staying byte-identical is subtle.
4. **Small contexts.** Agents (and you) use `grep -n` and line ranges, never whole files. Pipe build, profile and diff output
   through `grep`/`head`; never paste full logs. Measure only with `tools/perf/gate.sh`, which prints ~6 lines.
5. **Tiny reports.** Each agent ends with at most 8 lines: change, instructions before → after, gate result, files touched. It
   appends the same lines to `docs/STATUS.md`. Don't ask for more.

## Measuring

`tools/perf/gate.sh <name>` builds `/tmp/fmt-<name>` and prints instructions retired (1 thread, whole corpus), wall time at 8
threads, vscode byte mismatches, and conformance against `docs/conformance-baseline.txt`. A full run takes ~50 s;
`GATE_FAST=1` skips the 8-thread timing and the conformance run (~45 s, for iterating). A change is kept only if mismatches are
0, conformance has no regression, and instructions go down. Profile (you only, once per round):

```sh
cd bench/vscode && xcrun xctrace record --template 'Time Profiler' --output /tmp/r<N>.trace --launch -- /tmp/fmt-<name> --check --threads=1 >/dev/null 2>&1
cd ../.. && python3 tools/xctrace-top.py /tmp/r<N>.trace /tmp/fmt-<name> | head -30
```

## Plan (re-rank after each round's profile; stop when instructions are ≤ 2× Bun's 35.9G, or a round gains < 2%)

- **Round 0 (you, no agents):** run `tools/perf/gate.sh base` and record the baseline (~170G instructions, 1.25 s at 8 threads).
  The tree contains partial edits from the previous, interrupted perf agents. Keep them if the gate passes.
- **Round 1, known hot spots** (details in `docs/PERFORMANCE.md` §3.3):
  1. haiku: `buildUnicodeEscapes` in `src/lint/ast/mod.ts` (7.9% of time): a byte loop → native `Uint8Array.prototype.indexOf(92, i)`.
  2. haiku: per-file `.fill(` resets that clear whole tables instead of the used range (`grep -rn "\.fill(" src`).
  3. sonnet/medium: `markOddBlocks`, `isAllPrintable` and the width scans in `src/format/ir/width.ts`: scan the source once per
     file, with native searches where possible.
  4. sonnet/medium: `DataView` get/set in `src/format/ir/**` (runtime calls, not inlined) → typed-array columns.
- **Round 2, worker-mode state** (`docs/PERFORMANCE.md` §3.2 item 3). In a Worker program every module-level variable is a
  thread-local lookup, and every typed-array access checks for shared memory. One haiku agent per directory hoists module
  singletons and their typed arrays into locals at the top of the 10–15 hottest functions named by the profile:
  `src/sema/parser/**` (lexer, names), `src/format/ir/**` (Formatter push/token, Tracker, Printer), `src/lint/ast/**`
  (`exprTag`, `exprSpan`, `exprParent`, ...). Give each agent its function list from your profile.
- **Round 3, less work per node** (`docs/PERFORMANCE.md` §4 C; sonnet/high, one target per agent):
  - the `is_quiet` fast path skips all comment queries;
  - per-file precomputation of line starts and "has newline between";
  - string literals that need no change are written as source text;
  - the refusal checks in `src/sema/parser/syntax/` run only when Bun runs them.
- **Round 4+:** re-profile and take the new top items.

## Sub-agent brief (fill in the brackets; keep it this short)

> Repo: formatc (repo root). You make ONE performance change to a scriptc-compiled TypeScript port of `bun fmt`. Output must stay
> byte-identical.
> Target: [function/file + what the profile shows]. Idea: [technique]. Only edit: [files].
> scriptc rules that matter here: the table in `docs/SCRIPTC_COOKBOOK.md` §0 and its §12 (read just those, ~60 lines).
> Measure with `GATE_FAST=1 tools/perf/gate.sh [name]` before and after, then once without `GATE_FAST`. Keep the change only if
> it prints `vscode byte mismatches (excl .html): 0`, no `GATE FAILED` line, and fewer instructions; otherwise revert it.
> Use `grep -n` and line ranges, never whole files; pipe long output through `head`. Stop after the change passes, or after two
> failed attempts, or ~60 tool calls. Final message ≤ 8 lines: change, instructions before → after, gate result, files.
> Append those lines to `docs/STATUS.md`.

## After each round

If the round improved instructions and the gate passed, commit with the instruction delta in the message. At the end, report a
table of rounds × (instructions, 8-thread wall, kept changes), and update `docs/PERFORMANCE.md` §1 with the new numbers.
[Delete or keep: "Push to origin main at the end."]
