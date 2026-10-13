# Porting conventions (read before writing any code)

This is a port of Bun's formatter (`vendor/bun/src/format`, Rust) and of what it depends on (the parser
`vendor/bun/src/sema/parser`, the HIR `vendor/bun/src/sema/hir.rs` + `node.rs`, the handles
`vendor/bun/src/lint/ast`, the driver `vendor/bun/src/lint/driver/fmt`). The output must be **byte for
byte** what `bun fmt` prints. Read `vendor/bun/src/format/CLAUDE.md` for how the Rust code is organized,
`docs/PLAN.md` for the module map, and `docs/SCRIPTC_COOKBOOK.md` for what is fast under scriptc.

## 1. A port, file by file

- One Rust file → one TS file at the mirrored path: `vendor/bun/src/format/js/print/class.rs` →
  `src/format/js/print/class.ts`; `vendor/bun/src/sema/parser/lexer.rs` → `src/sema/parser/lexer.ts`.
- Keep the Rust names in camelCase (`write_if_statement` → `writeIfStatement`), keep the order of
  functions, keep the comments that say what Prettier does (they are the spec). Drop comments that only
  explain Rust.
- Port the logic exactly, branch for branch. Do not "simplify" a rule you don't understand: every branch
  exists because a fixture needed it. When something can't be ported yet (a dependency is missing), leave
  `// TODO(port): <what>` and fall back to the Rust behavior for unported nodes (print the source text).
- Rust tests (`#[cfg(test)] mod tests`) are worth porting as `*.test.ts` only when they are cheap.

## 2. The language subset: TS that runs under **both** `node` and `scriptc`

- `node src/x.ts` must run the program (Node 24 type stripping) and `scriptc build src/x.ts` must
  compile it. So: **erasable syntax only** — no `enum`, no `namespace`, no constructor parameter
  properties, no decorators. Imports name the file with its `.ts` extension:
  `import { group } from "../ir/builders.ts";`.
- `import type { Int32, NoThrow } from "@scriptc/types";` for contracts (erased by node).
- Rust `enum` with no data → `export const K_FOO = 3;` integer constants (grouped in a file per enum,
  with a `kindName(k)` debug helper if useful). Rust bitflags → integer bit constants.
- Rust `enum` with data (`ExprKind::Dot { obj, name, chain }`) → **no objects**. A tag accessor plus field
  accessors over the tables: `exprTag(e) === EXPR_DOT`, `dotObject(e)`, `dotName(e)`. Never allocate an
  object to return several values on a hot path: return one, or write the others into module-level
  scratch variables (`let outA = 0, outB = 0;`), or into a caller-provided Int32Array.
- `Option<Handle>` → `-1` (`NONE`). `Option<bool>` → small int (0/1/-1). `Option<f64>` → `NaN` when
  unambiguous.
- `Result<T, E>`: return a sentinel / status code; set the error into a module-level slot. **No exceptions
  on any path that runs per file** (try/catch on the hot path is allowed only if the cookbook says it is
  free). A syntax error is a normal return value.
- `match` → `switch` on integer tags. `matches!(x, A | B)` → `x === A || x === B` or a lookup table.
- Traits → plain functions with a `switch` on the kind. Generics over a trait → one function per
  instantiation if it is hot, else a tag parameter.
- `SmallVec`/`Vec` of ints → a reusable `I32Vec` from `src/base/` (never a fresh `number[]` per node).
- `&[u8]` text → `(start, end)` offsets into a `Uint8Array` (the source, or a byte buffer). **No JS
  strings for source text.** JS strings are fine for: option names, CLI, diagnostics, file paths, and
  constant tokens registered once at module init (see the IR API).
- Closures: the Rust code uses `format_with(|f| ..)` and `Format` structs that are written later. In TS,
  **write imperatively**: the IR has start/end tags, so `group(&content)` becomes
  `f.startGroup(); writeContent(); f.endGroup();`. A `Format` struct that is created and written once
  is just a function call at the place it is written. Only where Rust really formats something more
  than once or later (`memoized`, `best_fitting!`, `intern`, `capture`) do you use the capture API of the
  IR (record an element range and reuse it). A closure allocated per node is a bug unless the cookbook
  says closures are free.
- Recursion is fine (the parser and printer recurse), but follow Bun's "How deep" rules
  (`format/CLAUDE.md`): ask the stack (`src/base/stack.ts`) before recursing into what is nested.

## 3. Data layout (tigerstyle: static allocation, zero copy, no serialization)

- **Per-thread scratch, allocated once, grow-only.** Every buffer a file needs (token arrays, HIR tables,
  IR elements, output bytes) lives in module-level state of its module and is reset — not reallocated —
  per file. Module state is per worker thread under scriptc and Node, so this is thread-safe.
- **Struct of arrays.** A table of nodes is several typed arrays indexed by node id
  (`exprTag: Uint8Array`, `exprA: Int32Array`, `exprB: Int32Array`, `exprPos: Int32Array`, ...),
  wrapped by a class that owns them and grows them by doubling. Handles are `number` (Int32) ids.
- **The source is a `Uint8Array` of UTF-8 bytes.** Positions are byte offsets, as in Rust. Output is
  written into a growable byte buffer and compared/written as bytes.
- Atoms (Rust `Atom`, interned names): an id into a per-file intern table of byte ranges.

## 3b. Hot-path rules (from `docs/SCRIPTC_COOKBOOK.md` — measured; violating one costs 5-130x)

1. **Every typed-array read that is stored, passed, pushed or assigned is `| 0`-ed**: `const c = src[i] | 0`,
   `out[n] = src[i] | 0`, `f(src[i] | 0)`. A bare `x = src[i]` goes through a boxed `number|undefined` (25x slower).
2. **Every value stored into an Int32Array/Uint8Array is `| 0`-ed**: `d[n] = i | 0` (bare is 6x slower).
3. **Int math that must stay int32**: `n = ((n | 0) + 1) | 0`, `s = ((s | 0) + (x | 0)) | 0`. Not `n++` in hot loops,
   not `(n + 1) | 0`. Plain `+=` on doubles is fine when no wrap is needed. Don't use `Int32` contracts (no gain in 0.3.0).
4. **Hoist fields and module `let` state into locals** at function entry in loops (`const src = this.src; let pos = this.pos | 0;`),
   write back once. A typed-array field read inside a loop is 6x slower than a local.
5. **Byte classification by 256-entry `Uint8Array` tables**, not switches. `switch` on small int tags is fine for dispatch.
6. **No data fields read through `interface` types (26 ns) and never `abstract readonly kind` (134 ns).** If you use classes,
   declare data fields in a concrete class; mark long-lived node classes `implements ProgramLifetime`.
7. **No closures, `forEach`/`map`/`filter`, array literals `[a, b]` or `new` of temporary objects on per-node/per-token paths.**
8. `number[]` loops: `for (let i = 0; i < a.length; i++)` literally (hoisting `a.length` is 4.7x slower for `number[]`);
   for strings/typed arrays hoist `const n = s.length`.
9. **SharedArrayBuffer views only for control words** (atomic counters, result flags). Never parse or format from a SAB-backed
   array inside the worker program (global lock per access). Share read-only data with `publish()`.
10. `try`/`catch` is free when nothing throws; `throw` is cheap (7-42 ns) — but syntax errors are still return values (rule in §2).
11. Native `Map<number,…>`/`Map<string,…>` are fine (1-2.5 ns get). Don't build strings from source bytes to use as keys:
    intern bytes (`src/base/intern.ts`).
12. Measure in the final configuration: the real binary imports `Worker`, which adds a ~20% tax to branchy loops.

Reference implementations to reuse: `src/base/` (from `scratch/cookbook/lib/`: `ByteBuf`, `I32Vec`, `Interner`, `IntMap`,
`eqAscii`, char-class tables, the lexer template).

### Compiler quirks found while porting (add yours)
- Some import cycles are rejected by scriptc even though plain cyclic function imports work (md agent had to split
  `state.ts`/`parser.ts`). If you hit it, move the shared state/types into a leaf module.
- An overriding method must repeat the base method's parameter list exactly.
- A differential oracle can be built from the vendored Rust itself with shims (see `tools/md/rust-oracle/`): useful when
  Bun doesn't expose the piece you port.

## 4. Layout of `src/`

```
src/base/          byte buffers, I32Vec, hashing, utf8 helpers, stack guard   (ours; small)
src/sema/          hir.ts (tables), node.ts, atom.ts; parser/ (lexer, parser, ...)
src/lint/ast/      the handles: accessors over the HIR that format/js uses
src/format/        options.ts, range.ts, cursor.ts, pragma.ts, ...; ir/; js/; json/; css/; yaml/; ...
src/parsers/       yaml.ts, toml.ts (Bun's own parsers that format/yaml and format/toml read)
src/md/            Bun's markdown parser (what format/markdown reads)
src/driver/        CLI, files, configs (.prettierrc, .editorconfig, bunfig.toml), ignore files, threads
src/main.ts        entry: `scriptc build src/main.ts -o bin/fmt`
tools/             dev scripts (run with node or bun, never compiled): compare-vscode.ts, ...
```

## 5. How to check your work

- Type-check: `npx tsc -p .` (must be clean for your files).
- Run under node: `node src/main.ts --stdin-filepath=a.ts < a.ts`.
- Compile: `scriptc build src/main.ts -o bin/fmt` (fix every `SC` diagnostic; they come with hints).
- Oracle for one input: `~/.bun/bin/bun fmt --stdin-filepath=a.ts < a.ts`.
- Oracle for many: `bench/vscode-fmt/<path>` is what `bun fmt` made of `bench/vscode/<path>`.
- Prettier's fixtures: `/tmp/prettier-bundle.txt` (see `vendor/bun/test/cli/format/prettier/README.md`).

### How to run the conformance tests (Prettier's 9,733 fixtures, oxfmt's 3,068 outputs)
- Once: `zstd -dc vendor/bun/test/cli/format/prettier/bundle.zst > /tmp/prettier-bundle.txt` (oxfmt: `.../oxfmt/bundle.zst > /tmp/oxfmt-bundle.txt`).
- Run: `node tools/conformance.ts prettier [--languages=json,css] [--filter=text] [--table] [--report=/tmp/r]` (or `oxfmt`); compiled:
  `scriptc build tools/conformance.ts -o /tmp/conformance`. The report is that of `vendor/bun/test/cli/format/prettier/expected.txt`
  (its `FAIL` lines are Bun's own known failures); `--report` writes `<case>.expected/.actual/.input`.
- Plug your language in at `src/format/conformance/dispatch.ts` (`run<Lang>`: uncomment the import, call your `format(...)`, which
  returns a `FORMAT_*` code). Until then its cases are "not ported" (counted apart, never failures). Directories: `json css less scss yaml
  markdown mdx graphql handlebars html vue angular lwc mjml js jsx typescript flow misc`.
- Checks of the runner itself: `--identity` (formatter = identity) and `--mock` (formatter = the snapshots); denominators equal Bun's.

## 6. Reporting

When you finish, append a short entry to `docs/STATUS.md` (module, what works, what's left, test
numbers). Keep your final message to the orchestrator under 40 lines.
- (core agent) Hoisting is for loops. In a *small* hot function that is called per element, binding a typed-array field to a
  local costs a refcount retain/release (~5 ns) — read the field directly there. Scalar locals + `DataView` stores beat
  repeated field access.
- (sema agent) Numeric constants are declared `export const X: number = n` (not literal types) so TS doesn't keep a
  comparison narrowed across a call that changes the state (`lx.token === T_X` after `lx.next()`); scriptc still folds them.
- `src/base/stack.ts` is a depth budget: bracket recursion with `enter()`/`leave()`. Under plain node use `--stack-size`.
- (parser-A) **Never read `.stack`** of an error anywhere in the program: it turns on `scr_stack_enter/leave` in every
  function (-33% parser throughput). Also: a module-level `let` inside an import cycle is rejected (SC1016) — keep state in a
  leaf module or a class instance.
- (parser-C) **Compiled behavior can differ from node**: `octalOf` using `string.slice(from)` in a loop hung forever only in the
  compiled binary. Always run your differential harness compiled too, not only under node. Avoid `toString(radix)` — use the
  `radixText` helper in the parser.
