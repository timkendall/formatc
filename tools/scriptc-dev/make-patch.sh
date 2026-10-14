#!/bin/sh
# Writes the difference between a patched compiler copy and the pristine npm package as one patch file.
#   tools/scriptc-dev/make-patch.sh <patched-compiler-dir> <patches/NN-name.patch> [base-dir]
# <patched-compiler-dir> is a node_modules/@scriptc/compiler directory; the base defaults to the pristine package with the
# patches that sort before this one already applied (so patches stack). Pass an explicit base when other patches with lower
# numbers appeared after your copy was made (a stale copy would otherwise revert them).
set -e
D=$(cd "$(dirname "$0")" && pwd)
NEW=$(cd "$1" && pwd); OUT=$2; BASE=$3
if [ -z "$BASE" ]; then
  BASE=$(mktemp -d)/package
  (cd "$(dirname "$BASE")" && npm pack @scriptc/compiler@0.3.0 --silent > /dev/null && tar -xzf scriptc-compiler-0.3.0.tgz)
  for p in "$D"/patches/*.patch; do
    [ -e "$p" ] || continue
    [ "$D/$OUT" = "$p" ] && continue
    [ "$(basename "$p")" \< "$(basename "$OUT")" ] && patch -p1 -d "$BASE" -s -f < "$p"
  done
fi
cd "$BASE/.." && rm -rf a b && cp -R "$BASE" a && cp -R "$NEW" b
diff -ruN -x '*.map' -x '*.d.ts' -x '*.test.js' a b > "$D/$OUT" || true
echo "$(grep -c '^+++' "$D/$OUT") files -> $OUT"
