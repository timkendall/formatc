#!/bin/sh
# One command for every perf change: build, measure, check correctness. Prints ~6 lines.
#   tools/perf/gate.sh <name>        builds /tmp/fmt-<name> with its own scriptc cache
#   GATE_FAST=1 tools/perf/gate.sh <name>   skips the 8-thread timing and the conformance run
#   SCRIPTC="node tools/scriptc-dev/scriptc.mjs" tools/perf/gate.sh <name>   builds with the locally patched compiler
# Metric: instructions retired, whole bench/vscode corpus, 1 thread (stable on a busy machine).
# Gates: 0 byte mismatches vs bench/vscode-fmt (except .html, unfinished); no Prettier conformance language below baseline.
N=${1:-gate}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BIN=/tmp/fmt-$N
T=/tmp/gate-$N
cd "$ROOT" || exit 2
start=$(date +%s)
if ! SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-$N ${SCRIPTC:-scriptc} build src/main.ts -o "$BIN" > "$T-build.txt" 2>&1; then
  echo "BUILD FAILED"; grep -m5 "error SC" "$T-build.txt" | sed "s|$ROOT/||" | cut -c1-200; exit 1
fi
echo "build ok ($(( $(date +%s) - start )) s): $BIN"
cd bench/vscode || exit 2
/usr/bin/time -l "$BIN" --check --threads=1 > /dev/null 2> "$T-t1.txt"
awk '/instructions retired/{i=$1} /cycles elapsed/{c=$1} / real /{r=$1} END{printf "1 thread: %.1fG instructions, %.1fG cycles, %.2fs   (bun: 35.9G, 10.8G, 2.41s)\n", i/1e9, c/1e9, r}' "$T-t1.txt"
mm=$("$BIN" --check --threads=18 --compare-to=../vscode-fmt 2>&1 | awk '$2=="match" && $1!=".html" && $1!="total" {s+=$5} END{print s+0}')
echo "vscode byte mismatches (excl .html): $mm"
[ "$mm" = "0" ] || echo "GATE FAILED: output differs from bun fmt (run: $BIN --check --compare-to=../vscode-fmt --compare-list)"
[ -n "$GATE_FAST" ] && exit 0
best=99
for k in 1 2 3; do
  /usr/bin/time -p -o "$T-t8.txt" "$BIN" --check --threads=8 > /dev/null 2>&1
  w=$(awk '/^real/{print $2}' "$T-t8.txt"); best=$(echo "$w $best" | awk '{print ($1<$2)?$1:$2}')
done
echo "8 threads: ${best}s min of 3   (bun: 0.44s idle; wall time is noisy when other agents run)"
cd "$ROOT"
node tools/conformance.ts prettier 2>/dev/null | grep -E "^[a-z]+: format" > "$T-conf.txt"
reg=$(awk -F'[ /]' 'NR==FNR {b[$1]=$3; next} ($1 in b) && ($3+0 < b[$1]+0) {printf "%s %s<%s ", $1, $3, b[$1]}' docs/conformance-baseline.txt "$T-conf.txt")
if [ -n "$reg" ]; then echo "GATE FAILED: conformance below baseline: $reg"; else echo "conformance: no language below docs/conformance-baseline.txt"; fi
