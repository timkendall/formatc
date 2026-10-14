#!/bin/sh
# Installs scriptc 0.3.0's compiler package and applies our patches to it (idempotent).
#   tools/scriptc-dev/setup.sh            then build with: node tools/scriptc-dev/scriptc.mjs build ...
#   SCRIPTC="node tools/scriptc-dev/scriptc.mjs" tools/perf/gate.sh <name>
set -e
D=$(cd "$(dirname "$0")" && pwd)
cd "$D"
[ -d node_modules/@scriptc/compiler ] || npm install --silent
C=node_modules/@scriptc/compiler
for p in patches/*.patch; do
  [ -e "$p" ] || continue
  if patch -p1 -d "$C" --dry-run -R -s -f < "$p" > /dev/null 2>&1; then echo "already applied: $p"
  else patch -p1 -d "$C" -s -f < "$p" && echo "applied: $p"; fi
done
