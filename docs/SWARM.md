# Swarm rounds

Each round is a set of short-lived agents with one target each, measured with [`tools/perf/gate.sh`](../tools/perf/gate.sh)
(instructions retired on the whole corpus at 1 thread, which is stable on a busy machine; 0 byte mismatches against `bun fmt`;
no Prettier conformance regression). A change is kept only if it passes the gate and lowers the instruction count. Bun: 35.9 G
instructions, 0.43 s at 8 threads.

The phase summary is in the [README](../README.md#what-it-took).

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

¹ Measured while other agents were running. The idle 8-thread time after round 2 is the 1.15 s (2.67×) on the round 2 row.

## Cost

Rounds 1–8 cost about $28 in total (~$9 for 26 agents, ~$19 for the orchestrator), against ~$560 for round 0. The scriptc
rounds S1–S3 cost about $22 more (~$8 for 10 agents, ~$14 for the orchestrator). P1–P2 add about $32 (~$12 for 8 agents, ~$20
for the orchestrator). Together with the port, that is about $640–650 of list-price API cost.

Rounds 1–8 took instructions from 170.6 G to 132.2 G (−22.5%), cycles from 38.6 G to 27.9 G (−28%), and the 8-thread time from
1.25 s to 0.90 s. S1–S3 then reached 92.9 G and 0.73 s, and P1 reached 84.6 G and 0.64 s.

## What the rounds found

The big lesson of rounds 4–6: in a program that uses `Worker`, scriptc 0.3.0 makes every module-level binding thread-local,
and on macOS every source-level mention of one is a separate `_tlv_get_addr` call. A numeric constant is folded, except when
its module is in an import cycle; then each use is two calls (a checked "initialized" flag and the value). Our profile script
hid this until round 4: it dropped samples whose leaf frame was a back-reference in the trace, so `_tlv_get_addr` showed 0.2%
instead of 11%. Three re-runnable codemods in `tools/codemod/` remove most of it without touching the compiler. Run them in
this order after merging new code: `leaf-consts.mjs`, `outslots.mjs`, `hoist-globals.mjs`.

Each agent ran in its own git worktree and stopped after one target (after the gate passed, after two failed attempts, or at
~60 tool calls). None was resumed, so no agent re-read a long context. Haiku agents cost $0.02–0.11 each, Sonnet agents at
medium effort ~$0.18, and Sonnet agents at high effort $0.32–1.20. Per-agent numbers come from `python3 -I tools/agent-cost.py
<session-id>`. Sub-agent transcripts record only the first streaming count of output tokens, so output is estimated from the
text and tool inputs the agents wrote. Their hidden thinking is not recorded and may add a few tenths of a dollar.

What failed and why is logged in [STATUS.md](STATUS.md). For example, hoisting fields that are read once per call adds
instructions in worker mode, reading 4 bytes at a time does not beat a byte loop, and a per-file line-break table costs more
than the short scans it replaces. Before round 3 the orchestrator measured Prettier's refusal checks at ~1.2 G (0.8%) by
switching them off in a scratch build, so it gave that target no agent.

The benchmark table on this tree is in the [README](../README.md#results). Where the remaining time goes is in
[PERFORMANCE.md](PERFORMANCE.md).
