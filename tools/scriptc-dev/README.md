# scriptc-dev: the scriptc 0.3.2 compiler with local patches

The released `scriptc` CLI is a self-hosted native binary, so it cannot be patched in place. The same compiler is published
on npm as JavaScript (`@scriptc/compiler@0.3.2`, with its LLVM and runtime packs as optional dependencies). This directory
installs that package, applies our patches to its `dist/` files, and runs its CLI under Node with `scriptc.mjs`. A build
with the unpatched package gives the same executable as the native CLI (same size, same instruction count).

```sh
tools/scriptc-dev/setup.sh                                   # npm install + apply patches/*.patch (idempotent)
node tools/scriptc-dev/scriptc.mjs build src/main.ts -o /tmp/fmt
SCRIPTC="node tools/scriptc-dev/scriptc.mjs" tools/perf/gate.sh <name>
```

Patches are plain unified diffs against the npm package (`patch -p1` inside `node_modules/@scriptc/compiler`), numbered
in the order they apply. To make one: copy this directory (`cp -c -R`), edit the copy's
`node_modules/@scriptc/compiler/dist/**`, then run `make-patch.sh <copy>/node_modules/@scriptc/compiler patches/NN-name.patch`.

They target worker-mode code generation, which every program that imports `Worker` gets (see `docs/PERFORMANCE.md` §3.2).
They are validated only against this program: `tools/perf/gate.sh` (byte-identical output on bench/vscode and Prettier
conformance). scriptc's own test suite is not run.
