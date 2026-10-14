# formatc

> [!WARNING]
> **This is an experiment, not a tool to use.** It explores how far a fleet of AI agents can take a large port (Bun's ~175k-line
> Rust formatter and everything it depends on) into TypeScript compiled by scriptc, and whether scriptc's native code can match Rust.
> Output matches `bun fmt` on the benchmark corpus; the speed does not yet, and parts are unfinished. Use `bun fmt`.

## What it took so far

Everything in this repo was written by AI agents in one session on 2026-10-13 (about 8.5 hours of wall-clock time, including
pauses on usage limits), directed by a human through a handful of prompts.

| agent | model | effort | count | role |
| ----- | ----- | ------ | ----- | ---- |
| orchestrator (the main Claude Code session) | Claude Opus 5.5 | default | 1 | planning, splitting the work, reviewing results, measuring, docs |
| `general-purpose` sub-agents | Claude Sonnet 5.5 | high | 32 | 1 research (scriptc cookbook), 25 porting, 6 performance |

| | API calls | input tokens (cache reads + cache writes + uncached) | output tokens | estimated cost |
| - | - | - | - | - |
| orchestrator | 175 | 48.7 M (45.3 M + 3.5 M + <0.01 M) | 0.19 M | ~$34 |
| sub-agents | 5,004 | 2,212 M (2,185 M + 26.9 M + 0.01 M) | 2.16 M logged, ~3.1 M estimated | ~$526–535 |
| **total** | **5,179** | **~2.26 B** | **~2.3–3.3 M** | **~$560–570** |

How these were counted:
- Token counts are summed from the Claude Code transcripts of the session and of every sub-agent. They include the work of
  agents that a usage limit cut off and that were later resumed.
- Some sub-agent transcripts did not record their final output-token count, so their output is estimated from the median
  tokens per API call of the others. That is the reason for the ranges.
- Costs use list API prices: Opus 5.5 at $4 / $20 per million input / output tokens, Sonnet 5.5 at $2 / $10, cache reads at
  $0.20, cache writes at 1.25× (5-minute TTL) or 2× (1-hour TTL) the input price.
- About 97% of all tokens are cache reads, which dominate the cost: each agent re-reads its growing context on every call.
- The session ran on a subscription plan, so what was actually billed differs.

## Swarm rounds

Each round is a set of short-lived agents with one target each, measured with `tools/perf/gate.sh` (instructions retired on
the whole corpus at 1 thread, which is stable on a busy machine; 0 byte mismatches against `bun fmt`; no Prettier conformance
regression). A change is kept only if it passes the gate and lowers the instruction count. Bun: 35.9 G instructions, 0.43 s at 8
threads.

| round | targets | agents | API calls | cache reads | est. cost | instructions, 1 thread | 8 threads | kept |
| ----- | ------- | ------ | --------- | ----------- | --------- | ---------------------- | --------- | ---- |
| 0 · baseline | the port, plus a first perf pass that a usage limit paused | 32 × Sonnet 5.5 (high) + Opus 5.5 orchestrator | 5,179 | 2.23 B | ~$560–570 | 170.6 G | 1.25 s (2.85×) | output identical to `bun fmt` |
| 1 · hot spots | `buildUnicodeEscapes`, `parents.ts fill()`, width scans, printer `DataView` | 2 × Haiku 5.5, 2 × Sonnet 5.5 (medium) | 52 | 2.8 M | ~$0.40 | 163.8 G (−4.0%) | 1.25 s¹ | 4 of 4 (one redone by the orchestrator) |
| 2 · worker-mode state | read thread-local singletons once in the lexer, IR writer/printer and tree handles; one fused byte scan | 3 × Haiku 5.5, 2 × Sonnet 5.5 (medium) | 101 | 6.8 M | ~$0.55 | 161.9 G (−1.2%) | 1.15 s (2.67×) | 1 of 5 |
| 3 · less work per node (PERFORMANCE.md §4 C) | comment lookups on the quiet path, newline queries, unchanged string literals, span accessors | 4 × Sonnet 5.5 (high) | 126 | 9.3 M | ~$2.9 | 157.8 G (−2.5%) | 1.14 s (2.59×) | 3 of 4 |
| 4 · thread-local lookups | token tables, lexer byte table, `tools/codemod/hoist-globals.mjs` (read module-level objects once per function) | 3 × Sonnet 5.5 (high) | 80 | 5.7 M | ~$2.0 | 150.2 G (−4.8%) | 1.11 s | 3 of 3 |
| 5 · more lookups, refcounts | lexer records identifier escapes, `outslots.mjs` (`SP` and 12 other out-slot arrays become objects), fewer retain/release | 4 × Sonnet 5.5 (medium/high) | 73 | 3.9 M | ~$1.4 | 145.6 G (−3.1%) | 1.08 s | 3 of 4 |
| 6 · constants in import cycles | `leaf-consts.mjs`: 578 constants of 45 cyclic modules moved to import-free leaves | 1 × Sonnet 5.5 (high) | 10 | 0.5 M | ~$0.24 | 134.2 G (−7.8%) | 1.00 s | 1 of 1 |
| 7 · lexer, printer, parse, token ids | per-identifier path, native copies, per-node parse work, literal token ids | 4 × Sonnet 5.5 (medium/high) | 72 | 4.5 M | ~$1.5 | 133.4 G (−0.6%) | 1.01 s | 2 of 4 |
| 8 · accessor-aware aliasing | inline trivial `hir` accessors into aliased callers | 1 × Sonnet 5.5 (medium) | 8 | 0.4 M | ~$0.17 | no gain | | 0 of 1 |
| orchestrator, rounds 1–8 | planning, probes, disassembly, merging, gating, profiling, docs | Opus 5.5 | ~170 | ~38 M | ~$19 | | | |
| **after round 8, idle machine** | | | | | | **132.2 G** | **0.90 s (2.09×)** | |
| S1 · scriptc patches | stack guard on a feedback vertex set (40), no `sanitize_address` outside `--sanitize` + invariant typed-array headers (30); thread-local hoisting, inline exception checks | 4 × Sonnet 5.5 (high) | 158 | 11.7 M | ~$3.6 | 123.6 G (−7.3%) | 0.88 s | 2 of 4 |
| S2 · scriptc patches | shared typed-array views inline (50), no termination polls without `terminate` (60), one TLS block for all program globals (70) | 3 × Sonnet 5.5 (high) | 84 | 5.3 M | ~$1.6 | 97.6 G (−21%) | 0.76 s | 3 of 3 |
| S3 · scriptc patches | inline `DataView`/Buffer numbers (85), inferred int32 locals (90); Darwin fast TLS | 3 × Sonnet 5.5 (high/medium) | 115 | 9.7 M | ~$2.9 | 94.5 G (−3.2%) | 0.76 s | 2 of 3 |
| orchestrator, S1–S3 | toolchain setup, ablation planning, stacking, gating | Opus 5.5 | ~55 | ~24 M | ~$14 | | | |
| **after S3, patched compiler** | | | | | | **92.9 G** | **0.73 s (1.66×)** | |
| P1 · IR building + compiler | IR writer without the per-file width pass; borrowed typed-array aliases (95); i32 call signatures and table bounds checks (96); five `\| 0` fixes that un-boxed the parameters of 8 hot functions; identifier fast path. Not kept: flat node tables, simple-argument paths | 7 × Sonnet 5.5 (medium/high) | 407 | 34.3 M | ~$9.5 | 84.6 G (−9%) | 0.64 s (1.49×) | 5 of 7 |
| P2 · processes (branch `processes`) | child processes instead of worker threads: non-worker code generation (no thread-locals) | 1 × Sonnet 5.5 (high) | 81 | 9.9 M | ~$2.5 | 77.8 G (−8%) | 0.60 s (1.40×) | on a branch |
| orchestrator, P1–P2 | profiling, merging, gating, docs | Opus 5.5 | ~50 | ~27 M | ~$20 | | | |
| C1 · 0.3.2 + ablations (2026-10-14) | compiler moved to scriptc 0.3.2 (patches 30/60 re-ported; 90 and half of 96 retired, upstream has them); ablation builds sized the remaining per-call taxes: typed-array bounds checks 7.3 G, post-call exception checks 4.3 G, stack guard 3.0 G, refcount releases ≈0 | 5 × Sonnet 5.5 (1 high, 4 medium) | 150² | | | 83.2 G (no change) | | measurements |
| C2 · compiler patches | 97: no stack guard (`SCRIPTC_NO_STACK_GUARD`; the parser's depth limit protects the build, −3.6%); 98: provable `Uint8Array` lengths don't throw; 99: runtime-raised errors abort (`SCRIPTC_TRAP_RUNTIME_ERRORS`, −3.5%); 99c: cache key. Not kept: sound bounds-check elimination (41 of 12k sites provable, no gain), trapping TDZ/published writes (no gain) | 5 × Sonnet 5.5 (3 high, 2 medium) | 213² | | | 78.2 G (−6%) | 0.62 s | 3 of 5 |
| C3 · processes merged | the hang seen once was not reproduced in ~8,000 loaded runs with fault injection; `FMT_HANGDUMP` diagnostics added; child processes become the default build, tag `workers-last` keeps the worker build | 1 × Sonnet 5.5 (high) | 93² | | | **73.2 G (−12% vs P1)** | **0.59 s (1.37×)** | merged |
| orchestrator, C1–C3 | live measurements, synthetic per-construct benchmark, merging, gating, docs, corpus restore | Claude Fable 5.1 | | | | | | |

¹ Measured while other agents were running; the idle 8-thread time after round 2 is in the table below.
² Round C lists tool calls, not API calls; its token counts and cost were not computed.

Rounds 1–8 cost about $28 in total (~$9 for 26 agents, ~$19 for the orchestrator), against ~$560 for round 0. The scriptc
rounds S1–S3 cost about $22 more (~$8 for 10 agents, ~$14 for the orchestrator).
Together they took instructions from 170.6 G to 132.2 G (−22.5%), cycles from 38.6 G to 27.9 G (−28%), and the 8-thread
time from 1.25 s to 0.90 s.

The big lesson of rounds 4–6: in a program that uses `Worker`, scriptc 0.3.0 makes every module-level binding
thread-local, and on macOS every source-level mention of one is a separate `_tlv_get_addr` call. A numeric constant is
folded, except when its module is in an import cycle; then each use is two calls (a checked "initialized" flag and the
value). Our profile script hid this until round 4: it dropped samples whose leaf frame was a back-reference in the trace,
so `_tlv_get_addr` showed 0.2% instead of 11%. Three re-runnable codemods in `tools/codemod/` remove most of it without
touching the compiler. Run them in this order after merging new code: `leaf-consts.mjs`, `outslots.mjs`, `hoist-globals.mjs`. Each agent ran in its own git worktree and stopped after one
target (after the gate passed, after two failed attempts, or at ~60 tool calls). None was resumed, so no agent re-read a long
context. Haiku agents cost $0.02–0.11 each, Sonnet agents at medium effort ~$0.18, and Sonnet agents at high effort $0.32–1.20. Per-agent numbers come from `python3 -I tools/agent-cost.py
<session-id>`. Sub-agent transcripts record only the first streaming count of output tokens, so output is estimated from the
text and tool inputs the agents wrote. Their hidden thinking is not recorded and may add a few tenths of a dollar. What failed
and why is logged in [docs/STATUS.md](docs/STATUS.md). For example, hoisting fields that are read once per call adds
instructions in worker mode, reading 4 bytes at a time does not beat a byte loop, and a per-file line-break table costs
more than the short scans it replaces. Before round 3 the orchestrator measured Prettier's refusal checks at ~1.2 G (0.8%)
by switching them off in a scratch build, so it gave that target no agent.

A TypeScript port of [Bun's formatter](https://bun.com/docs/format) (`bun fmt`, Rust), compiled to a native executable with
[scriptc](https://scriptc.dev) and parallelized with child processes (the worker-thread build with [`@scriptc/threads`](https://scriptc.dev/docs/threads) is kept at tag `workers-last`; see docs/PERFORMANCE.md §7).

The goal: the same output as `bun fmt`, byte for byte, at the same speed as Bun on its published benchmark
(`bun fmt --check` over [microsoft/vscode](https://github.com/microsoft/vscode), 8 threads).

**Status (2026-10-13): the output matches; the speed does not yet.** See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for the
measurements, where the time goes, and the ways we see to close the gap.

## Results

`--check` over bench/vscode (18,080 files, 238 MB, 193 MB of it TypeScript), Apple M5 Pro, Bun canary 1.4.4, built with the
patched scriptc 0.3.2 compiler (`tools/scriptc-dev`, patches 30–99c), after round C (2026-10-14). The default build runs child
processes (`src/driver/child.ts`); the last worker-thread build of the same source is tag `workers-last` (4.27 / 0.62 / 0.41 s).
Interleaved runs on an idle machine, min of 3 (min of 5 at 8 and 18 threads):

| threads | formatc | `bun fmt` | gap |
| ------- | ------- | --------- | --- |
| 1       | 3.96 s  | 2.40 s    | 1.65× |
| 8 (Bun's published benchmark) | 0.59 s | 0.43 s | 1.37× |
| 18      | 0.44 s  | 0.30 s    | 1.5× |

Correctness against `bun fmt` on the same tree (`bin/fmt --check --compare-to=../vscode-fmt`):

| | identical | differ |
| - | - | - |
| `.ts` / `.tsx` / `.js` / `.mjs` / `.cjs` / `.mts` / `.jsx` | 14,861 | 0 |
| `.json` / `.jsonc` / `.code-snippets` / `.code-workspace` | 1,401 | 0 |
| `.css` / `.scss` / `.less` | 516 | 0 |
| `.yaml` / `.yml` | 767 | 0 |
| `.md` | 371 | 0 |
| `.toml`, `.pac`, extensionless JS | 7 | 0 |
| `.html` | 16 | 105 (the HTML port is unfinished) |

The 36 vscode files that Bun refuses (25 JS/TS, 6 CSS, 3 YAML, 2 Handlebars) are refused here too, with the same messages and
code frames.

Prettier's own test suite (9,733 fixtures, via Bun's conformance runner, ported): 92.9% of the cases of the ported languages
pass; JSON, CSS, SCSS, Less, YAML, GraphQL, Handlebars and MDX score exactly what Bun scores; JS 1342/1357, TypeScript 747/756,
JSX 184/186, Markdown 1568/1572; Flow and HTML/Vue/Angular are unfinished. Baseline: [docs/conformance-baseline.txt](docs/conformance-baseline.txt).

## What is ported

About 183k lines of TypeScript, file for file from the Rust (`vendor/bun/src/...` → `src/...`, same names in camelCase):

| Rust (Bun) | TS | |
| - | - | - |
| `format/ir` | `src/format/ir/` | the document IR, Formatter, Tracker, printer |
| `sema/hir.rs`, `sema/parser` | `src/sema/` | Bun's TypeScript-Go-shaped parser writing a struct-of-arrays HIR; recovery, Flow, Prettier's refusals |
| `lint/ast`, `sema/bind` | `src/lint/`, `src/sema/bind/` | the handles the JS formatter reads the tree through |
| `format/js` | `src/format/js/` | the JS/TS/JSX/Flow formatter (oxc's formatter, corrected to Prettier 3.9.9) |
| `format/{json,css,yaml,markdown,graphql,handlebars,toml,html}` | `src/format/...` | the other languages |
| `parsers/{yaml,toml}.rs`, `md/` | `src/parsers/`, `src/md/` | Bun's own YAML, TOML and Markdown parsers |
| `lint/driver/fmt` | `src/driver/` | the `bun fmt` command line: files, ignore files, configs, flags, output, threads |
| `format/conformance` | `src/format/conformance/` | Prettier's and oxfmt's fixture runner |

Unfinished: HTML/Vue/Angular/LWC/MJML (ported, untested), `sortImports`, Flow printing, `jsdoc`, `sortTailwindcss`, `cursorOffset`.
Code for some of these is in the tree in a partial state.

## Setup

```sh
npm install                       # @scriptc/types, @scriptc/threads, typescript
npm install -g --allow-scripts=scriptc scriptc@0.3.0
mkdir -p vendor bench
git clone https://github.com/oven-sh/bun vendor/bun && git -C vendor/bun checkout 9bcbf1ecb684e5de0bbc0288e57a87ea9914ed3a
git clone https://github.com/vercel-labs/scriptc vendor/scriptc    # a4bb3ff, for reading the compiler/runtime
git clone --depth 1 https://github.com/microsoft/vscode bench/vscode   # 60b846ee was used for the numbers above
cp -R bench/vscode bench/vscode-fmt && (cd bench/vscode-fmt && bun fmt)   # the oracle tree (Bun canary ≥ 1.4.4)
zstd -dc vendor/bun/test/cli/format/prettier/bundle.zst > /tmp/prettier-bundle.txt
```

## Build and run

```sh
tools/scriptc-dev/setup.sh                    # once: scriptc 0.3.0 from npm with our compiler patches (tools/scriptc-dev/README.md)
node tools/scriptc-dev/scriptc.mjs build src/main.ts -o bin/fmt   # ~20 s, whole program, patched compiler (fastest)
scriptc build src/main.ts -o bin/fmt          # or the stock 0.3.0 CLI (~7% more instructions)
bin/fmt --check                               # same flags as `bun fmt`; --help --all
node src/main.ts --check                      # the same program under Node 24 (slower)

cd bench/vscode && ../../bin/fmt --check --threads=8 --compare-to=../vscode-fmt   # byte equality with bun fmt
node tools/conformance.ts prettier [--languages=js,ts] [--filter=dir] [--report=dir]  # Prettier's fixtures
```

## Docs

- [docs/PERFORMANCE.md](docs/PERFORMANCE.md): measurements, profile, findings, ways to close the gap.
- [docs/SCRIPTC_COOKBOOK.md](docs/SCRIPTC_COOKBOOK.md): what is fast and what compiles under scriptc 0.3.0, all measured.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): porting conventions, hot-path rules, compiler quirks.
- [docs/PLAN.md](docs/PLAN.md): the module map and the order of the work.
- `docs/{IR,HIR,LINT_AST,JS_FORMAT,CSS_DOC,MD,PARSERS}_API.md`: Rust → TS mappings per layer.
- [docs/STATUS.md](docs/STATUS.md): the log of every porting and performance step.

## How it was built

By an orchestrating agent (Claude Opus 5.5) and 32 Claude Sonnet 5.5 sub-agents (see "What it took so far") working in parallel,
then short-lived Haiku 5.5 and Sonnet 5.5 agents in performance rounds (see "Swarm rounds"). Each agent ported or optimized one
area against `bun fmt` as the oracle (differential tests, fuzzing, Prettier's fixtures).

## License and credits

The formatter is a port of Bun's (MIT), which is a port of [oxc](https://github.com/oxc-project/oxc)'s formatter (MIT), itself
from [Biome](https://github.com/biomejs/biome) (MIT), modelled on [Prettier](https://github.com/prettier/prettier) (MIT). The
parser follows [TypeScript-Go](https://github.com/microsoft/typescript-go)'s parser (Apache-2.0) as Bun's does.
