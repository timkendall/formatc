#!/bin/sh
# All tests of the md port. Needs: node, bun (~/.bun/bin/bun), the Rust oracle (tools/md/rust-oracle/build.sh),
# /tmp/vscode-files.txt, /tmp/prettier-bundle.txt. Usage: tools/md/run-tests.sh [fuzz-docs]
set -e
cd "$(dirname "$0")/../.."
FUZZ=${1:-20000}
BUN=${BUN:-$HOME/.bun/bin/bun}
echo "== tsc"; npx tsc -p . 2>&1 | grep "src/md" && exit 1 || true
echo "== unit tests (unicode.rs)"; node src/md/unicode.test.ts | tail -1
echo "== tables vs Rust"; node tools/md/diff-tables.ts
echo "== HTML vs Bun.markdown.html"; $BUN tools/md/diff-html.ts --fuzz "$FUZZ" --seed 1 | tail -5
echo "== unicode classes vs Bun"; $BUN tools/md/diff-unicode-bun.ts
echo "== re-entrancy"; node tools/md/reentrancy.ts
echo "== stress inputs vs Rust"; node tools/md/diff-stress.ts
echo "== events vs Rust (track mode, extensions, micromark, mdx, ...)"; node tools/md/diff-events.ts --fuzz "$FUZZ" --seed 1 | tail -3
