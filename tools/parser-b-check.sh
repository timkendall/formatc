#!/bin/sh
# Parser part B (statements, modules, declarations, types, JSX): accept/refuse of the torture cases against TypeScript's parser, then
# the structural cross-checks against TypeScript over bench/vscode (positions: parser-xcheck-b.ts; fields: parser-deep-b.ts).
#   sh tools/parser-b-check.sh [limit]       (limit: files of the corpus, default 600; 20000 = all)
set -e
cd "$(dirname "$0")/.."
node tools/parser-check.ts tools/parser-cases/*
node tools/parser-deep-b.ts --js tools/parser-cases/js-stmts.js tools/parser-cases/js-script.js
node tools/parser-deep-b.ts tools/parser-cases/types.ts tools/parser-cases/stmts.ts tools/parser-cases/modules.ts tools/parser-cases/jsx.tsx
node tools/parser-xcheck-b.ts --limit "${1:-600}"
node tools/parser-deep-b.ts --limit "${1:-600}"
