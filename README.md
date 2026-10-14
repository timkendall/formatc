# formatc

A TypeScript port of [Bun's formatter](https://bun.com/docs/format) (`bun fmt`, Rust), compiled to a native executable with
[scriptc](https://scriptc.dev) and parallelized with `node:worker_threads` + [`@scriptc/threads`](https://scriptc.dev/docs/threads).

**77 agents. One day. ~$640–650. Matches `bun fmt`, at 1.49× its time.**

On 2026-10-13 one orchestrator and 76 sub-agents wrote this repository. The port took about 8.5 hours of wall-clock time,
including pauses on usage limits; the performance rounds ran the same day. List-price API cost is about $640–650 (the session
ran on a subscription, so the bill was different). `--check` over [microsoft/vscode](https://github.com/microsoft/vscode)
matches `bun fmt` on every finished language and takes 0.64 s at 8 threads against Bun's 0.43 s.

The goal is that same output, byte for byte, at Bun's speed on its published benchmark (`bun fmt --check` over vscode, 8
threads). The output matches; the speed does not yet. Measurements, the profile, and ways to close the gap are in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).

> [!WARNING]
> **This is an experiment, not a tool to use.** It explores how far a fleet of AI agents can take a large port (Bun's ~175k-line
> Rust formatter and everything it depends on) into TypeScript compiled by scriptc, and whether scriptc's native code can match Rust.
> Output matches `bun fmt` on the finished languages; the speed does not yet, and parts are unfinished. Use `bun fmt`.

## Contents

- [Results](#results)
- [What is ported](#what-is-ported)
- [What it took](#what-it-took)
- [Setup](#setup)
- [Build and run](#build-and-run)
- [Docs](#docs)
- [License and credits](#license-and-credits)

## Results

`--check` over bench/vscode (18,080 files, 238 MB, 193 MB of it TypeScript), Apple M5 Pro, Bun canary 1.4.4, built with the
patched scriptc compiler (`tools/scriptc-dev`), after swarm round P1. Interleaved runs, min of 3 (min of 5 at 8 and 18
threads). The `processes` branch, which uses child processes instead of worker threads, gives 3.94 / 0.60 / 0.41 s:

| threads | formatc | `bun fmt` | gap |
| ------- | ------- | --------- | --- |
| 1       | 4.19 s  | 2.30 s    | 1.8× |
| 8 (Bun's published benchmark) | 0.64 s | 0.43 s | 1.49× |
| 18      | 0.42 s  | 0.28 s    | 1.5× |

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
pass. JSON, CSS, SCSS, Less, YAML, GraphQL, Handlebars and MDX score exactly what Bun scores. JS 1342/1357, TypeScript 747/756,
JSX 184/186, Markdown 1568/1572. Flow and HTML/Vue/Angular are unfinished. Baseline:
[docs/conformance-baseline.txt](docs/conformance-baseline.txt).

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

## What it took

A human directed the agents through a handful of prompts. Sub-agents each worked one area against `bun fmt` as the oracle
(differential tests, fuzzing, Prettier's fixtures). Perf agents ran once, in their own git worktrees, and stopped after the gate passed,
after two failed attempts, or at about 60 tool calls. Some port agents were resumed after a usage limit cut them off.

| agent | model | effort | count | role |
| ----- | ----- | ------ | ----- | ---- |
| orchestrator | Claude Opus 5.5 | default | 1 | planning, splitting the work, reviewing results, measuring, merging, docs |
| port sub-agents | Claude Sonnet 5.5 | high | 32 | 1 research (scriptc cookbook), 25 porting, 6 performance |
| perf sub-agents | Claude Haiku 5.5 and Sonnet 5.5 | medium or high | 44 | 5 Haiku, 39 Sonnet; one target each |

A change is kept only when it passes `tools/perf/gate.sh` and lowers the instruction count. Bun, same machine: 35.9 G
instructions, 0.43 s at 8 threads. The 0.90 s, 0.73 s, and 0.64 s figures are idle-machine measurements. Round 1's wall time
was taken while other agents were running; that note is in [docs/SWARM.md](docs/SWARM.md).

| phase | sub-agents | est. cost | instructions, 1 thread | 8 threads | kept |
| ----- | ---------- | --------- | ---------------------- | --------- | ---- |
| Port (round 0) | 32 | ~$560–570 | 170.6 G | 1.25 s (2.85×) | output identical to `bun fmt` |
| Formatter (rounds 1–8) | 26 | ~$28 | 132.2 G | 0.90 s (2.09×) | 17 of 26 |
| Compiler patches (S1–S3) | 10 | ~$22 | 92.9 G | 0.73 s (1.66×) | 7 of 10 |
| IR and processes (P1–P2) | 8 | ~$32 | 84.6 G (77.8 G on `processes`) | 0.64 s (0.60 s on `processes`) | 5 of 7, plus the `processes` branch |
| **Total** | **76** | **~$640–650** | **84.6 G** | **0.64 s (1.49×)** | |

The orchestrator is one agent across every phase. Its cost is inside the phase totals: about $34 of the port, $19 of rounds
1–8, $14 of S1–S3, and $20 of P1–P2. Adding those estimates gives about $640–650 ($560–570 + $28 + $22 + $32). Rounds 1–8 took
instructions from 170.6 G to 132.2 G (−22.5%) and the 8-thread time from 1.25 s to 0.90 s. The compiler patches then reached
92.9 G and 0.73 s, and P1 reached 84.6 G and 0.64 s on this tree.

Targets, token counts, and what was rejected: [docs/SWARM.md](docs/SWARM.md).

The largest saving in rounds 4–6 was thread-local lookups. In a program that uses `Worker`, scriptc 0.3.0 makes every
module-level binding thread-local, and on macOS every source-level mention of one is a separate `_tlv_get_addr` call. A numeric
constant is folded, except when its module is in an import cycle; then each use is two calls. The profile script hid this until
round 4: `_tlv_get_addr` showed 0.2% instead of 11%. Three re-runnable codemods in `tools/codemod/` remove most of it. Run them
in this order after merging new code: `leaf-consts.mjs`, `outslots.mjs`, `hoist-globals.mjs`. Haiku agents cost $0.02–0.11 each,
Sonnet at medium effort about $0.18, and Sonnet at high effort $0.32–1.20.

### Port session

Round 0 is the only part with a full token count, summed from the Claude Code transcripts of that session, including agents
that a usage limit cut off and that were later resumed.

| | API calls | input tokens (cache reads + cache writes + uncached) | output tokens | estimated cost |
| - | - | - | - | - |
| orchestrator | 175 | 48.7 M (45.3 M + 3.5 M + <0.01 M) | 0.19 M | ~$34 |
| sub-agents | 5,004 | 2,212 M (2,185 M + 26.9 M + 0.01 M) | 2.16 M logged, ~3.1 M estimated | ~$526–535 |
| **total** | **5,179** | **~2.26 B** | **~2.3–3.3 M** | **~$560–570** |

How these were counted:

- Some sub-agent transcripts did not record their final output-token count, so their output is estimated from the median
  tokens per API call of the others. That is the reason for the ranges.
- Costs use list API prices: Opus 5.5 at $4 / $20 per million input / output tokens, Sonnet 5.5 at $2 / $10, cache reads at
  $0.20, cache writes at 1.25× (5-minute TTL) or 2× (1-hour TTL) the input price.
- About 97% of all tokens are cache reads, which dominate the cost: each agent re-reads its growing context on every call.

Later rounds are costed with `python3 -I tools/agent-cost.py <session-id>`. Those transcripts record only the first streaming
count of output tokens, so output is estimated from the text and tool inputs the agents wrote. Hidden thinking is not recorded
and may add a few tenths of a dollar.

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

- [docs/SWARM.md](docs/SWARM.md): every performance round, what was kept, and what it cost.
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md): measurements, profile, findings, ways to close the gap.
- [docs/SCRIPTC_COOKBOOK.md](docs/SCRIPTC_COOKBOOK.md): what is fast and what compiles under scriptc 0.3.0, all measured.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): porting conventions, hot-path rules, compiler quirks.
- [docs/PLAN.md](docs/PLAN.md): the module map and the order of the work.
- `docs/{IR,HIR,LINT_AST,JS_FORMAT,CSS_DOC,MD,PARSERS}_API.md`: Rust → TS mappings per layer.
- [docs/STATUS.md](docs/STATUS.md): the log of every porting and performance step.

## License and credits

The formatter is a port of Bun's (MIT), which is a port of [oxc](https://github.com/oxc-project/oxc)'s formatter (MIT), itself
from [Biome](https://github.com/biomejs/biome) (MIT), modelled on [Prettier](https://github.com/prettier/prettier) (MIT). The
parser follows [TypeScript-Go](https://github.com/microsoft/typescript-go)'s parser (Apache-2.0) as Bun's does.
