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

Patch 97 (`97-no-stack-guard.patch`): setting `SCRIPTC_NO_STACK_GUARD=1` omits the stack-overflow guard entirely (default keeps it); the parser and dispatcher already bound nesting, and the guard cost 3.7% of instructions even after patch 40.

Patch 99 (`99-trap-runtime-errors.patch`): setting `SCRIPTC_TRAP_RUNTIME_ERRORS=1` makes errors the runtime raises for an operation (typed-array length/bounds/DataView/`set`, `with`, and the compiler-inserted Node TypeErrors of `x!`, union narrowing and class casts) abort with the uncaught-error report instead of being catchable, so functions whose only throws are those are not may-throw and their callers emit no pending check; explicit `throw` stays catchable (default unchanged).

Patch 99c keys the executable cache on `SCRIPTC_NO_STACK_GUARD`, `SCRIPTC_TRAP_RUNTIME_ERRORS` and `SCRIPTC_NO_PROG_TLS`, so one `SCRIPTC_CACHE_DIR` can hold builds with different settings.
