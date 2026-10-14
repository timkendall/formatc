#!/bin/sh
# Installs scriptc 0.3.2's compiler package and applies our patches to it, always from a pristine copy, in order.
#   tools/scriptc-dev/setup.sh            then build with: node tools/scriptc-dev/scriptc.mjs build ...
#   SCRIPTC="node tools/scriptc-dev/scriptc.mjs" tools/perf/gate.sh <name>
# Fails if any hunk does not apply cleanly (a fuzzy or partial application would leave a different compiler).
set -e
D=$(cd "$(dirname "$0")" && pwd)
cd "$D"
V=$(node -e 'console.log(require("./package.json").dependencies["@scriptc/compiler"])')
I=$(node -e 'try{console.log(require("./node_modules/@scriptc/compiler/package.json").version)}catch{console.log("none")}')
if [ "$I" != "$V" ]; then rm -rf node_modules; npm install --silent; fi   # the runtime/LLVM packs must match the compiler version
C=node_modules/@scriptc/compiler
P=node_modules/.scriptc-compiler-pristine-0.3.2
if [ ! -d "$P" ]; then
  T=$(mktemp -d)
  (cd "$T" && npm pack @scriptc/compiler@0.3.2 --silent > /dev/null && tar -xzf scriptc-compiler-0.3.2.tgz)
  mv "$T/package" "$P"
fi
rm -rf "$C/dist" && cp -R "$P/dist" "$C/dist"
for p in patches/*.patch; do
  [ -e "$p" ] || continue
  if ! patch -p1 -d "$C" -s -N -F0 --no-backup-if-mismatch -r - < "$p"; then echo "FAILED: $p"; exit 1; fi
  echo "applied: $p"
done
