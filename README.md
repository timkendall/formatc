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

A TypeScript port of [Bun's formatter](https://bun.com/docs/format) (`bun fmt`, Rust), compiled to a native executable with
[scriptc](https://scriptc.dev) and parallelized with `node:worker_threads` + [`@scriptc/threads`](https://scriptc.dev/docs/threads).

The goal: the same output as `bun fmt`, byte for byte, at the same speed as Bun on its published benchmark
(`bun fmt --check` over [microsoft/vscode](https://github.com/microsoft/vscode), 8 threads).

**Status (2026-10-13): the output matches; the speed does not yet.** See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for the
measurements, where the time goes, and the ways we see to close the gap.

## Results

`--check` over bench/vscode (18,080 files, 238 MB, 193 MB of it TypeScript), Apple M5 Pro, idle machine, Bun canary 1.4.4:

| threads | formatc | `bun fmt` | gap |
| ------- | ------- | --------- | --- |
| 1       | 8.42 s  | 2.41 s    | 3.5× |
| 8 (Bun's published benchmark) | 1.25 s | 0.44 s | 2.85× |
| 18      | 0.75 s  | 0.30 s    | 2.5× |

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
scriptc build src/main.ts -o bin/fmt          # ~25 s, whole program
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

By an orchestrating agent (Claude Opus 5.5) and 32 Claude Sonnet 5.5 sub-agents (see "What it took so far") working in parallel, each porting or optimizing
one area against `bun fmt` as the oracle (differential tests, fuzzing, Prettier's fixtures).

## License and credits

The formatter is a port of Bun's (MIT), which is a port of [oxc](https://github.com/oxc-project/oxc)'s formatter (MIT), itself
from [Biome](https://github.com/biomejs/biome) (MIT), modelled on [Prettier](https://github.com/prettier/prettier) (MIT). The
parser follows [TypeScript-Go](https://github.com/microsoft/typescript-go)'s parser (Apache-2.0) as Bun's does.
