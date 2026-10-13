#!/bin/sh
# The table of STATUS.md: wall time of `--check` on bench/vscode at 1/8/18 threads, without and with the stand-in load
# (FMT_FAKE_WORK=9 ns per byte), for the driver before the pipeline (legacy) and now, and Bun.
#   tools/driver-perf/table.sh [runs]     needs /tmp/fmt-legacy (tools/driver-perf/legacy/make.py) and /tmp/fmt-new (tools/driver-perf/build.sh /tmp/fmt-new)
cd "$(dirname "$0")/../.."
n=${1:-6}
for t in 1 8 18; do
  r=$n; [ $t = 1 ] && r=3
  echo "== threads $t"
  node tools/driver-perf/bench.ts -n $r --cwd bench/vscode -- \
    "legacy no-load=/tmp/fmt-legacy --check --threads=$t" \
    "new    no-load=/tmp/fmt-new --check --threads=$t" \
    "legacy load9=FMT_FAKE_WORK=9 /tmp/fmt-legacy --check --threads=$t" \
    "new    load9=FMT_FAKE_WORK=9 /tmp/fmt-new --check --threads=$t" \
    "bun (real formatting)=$HOME/.bun/bin/bun fmt --check --threads=$t"
done
