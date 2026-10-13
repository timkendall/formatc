#!/bin/sh
# Builds and runs the throughput benchmark in the configuration of the real binary (a program that imports Worker).
#   sh tools/css/perf.sh [reps]
set -e
cd "$(dirname "$0")/../.."
export SCRIPTC_CACHE_DIR=${SCRIPTC_CACHE_DIR:-/tmp/scriptc-cache-css}
scriptc build tools/css/bench-w.ts -o /tmp/cssbench-w
/tmp/cssbench-w /tmp/vscode-files.txt bench/vscode ${1:-30}
