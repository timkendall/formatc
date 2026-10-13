#!/bin/sh
# Builds the driver with identity stubs for the formatters: tools/driver-perf/build.sh <output> (default /tmp/fmts)
set -e
cd "$(dirname "$0")/../.."
out=${1:-/tmp/fmts}
export SCRIPTC_CACHE_DIR=${SCRIPTC_CACHE_DIR:-/tmp/scriptc-cache-drvperf}
node tools/driver-perf/stubify.ts /tmp/drvperf-tree-$$ >/dev/null
(cd /tmp/drvperf-tree-$$ && scriptc build src/main.ts -o "$out")
rm -rf /tmp/drvperf-tree-$$
