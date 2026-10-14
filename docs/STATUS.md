# Status log (append-only; newest last)

## src/parsers: Bun's YAML and TOML parsers (done)

- **What**: `src/parsers/yaml.ts` (`YAML::parse_as_written`: documents as a tree of null / scalar / alias / object / array
  node ids with `loc`, the `SourceToken`s as typed arrays, `ParseError` + offset) and `src/parsers/toml.ts`
  (`TOML::tokens`: `Token`s, Bun's error words + offset). The value-building half of both Rust files (scalar values,
  anchors, merge keys, tags, `Parser` of TOML) is not ported; everything that decides acceptance and error places is,
  branch for branch. API and Rust -> TS mapping: `docs/PARSERS_API.md`. No dependency on `src/base/`.
- **Tests** (`tools/parsers/`; Rust has no unit tests for these two files):
  - `selftest.ts`: 59 checks, runs under node and compiled by scriptc (both pass).
  - `yaml-diff.ts` (run with bun): vscode `.yml/.yaml` (770) + Prettier `yaml/` (362) + Bun's own cases + mutants and
    token soups against `Bun.YAML.parse` (accept/reject, error message, tree shape) and `bun fmt` (line:col of every error),
    plus token invariants (sorted, form of each kind, only white space between, every simple string of Bun's value is
    the text of a token). Last runs: 2,268 corpus cases + 112,900 mutants + 300,000 soups (and other seeds,
    ~800k cases in all, one with NULs kept): **0 diffs**; 237,284 error places equal to `bun fmt`; 241,172 rejections
    with Bun's message; the only differences are the expected ones (alias errors that need values: ours does not resolve;
    JS objects with a key twice have fewer members than the tree).
  - `toml-diff.ts`: vscode + all `.toml` of this repo + spec seeds + 31,200 mutants + 300,000 soups + 100,000 generated
    documents (each also mutated) against `Bun.TOML.parse` and `bun fmt`: **0 diffs** (same words, same place for
    368,093 rejections); expected differences: Bun's parse also checks meaning (key twice, table twice, integer range).
  - Residual: nesting limit is a budget (`yamlSetMaxDepth`, default 1000), Bun's is the real stack (~3000-6000 levels).
- **Throughput** (compiled, scriptc 0.3.0, M5 Pro, best of 100, whole vscode YAML corpus: 770 files, 1.83 MB, 127 k
  tokens/run): **~410 MB/s** (4.4 ms; node 320-340 MB/s). TOML: 3.5 MB document, ~400-425 MB/s (node ~470).
  `scriptc build tools/parsers/bench.ts -o bench && ./bench yaml`.
- Compiled with `SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-parsers`. scriptc note: `table[arr[i]] = v` needs `arr[i] | 0`
  (SC1090 otherwise); keeping the cursor and the scalar state in locals inside the scanners gave +15-20% (module `let`s
  are slow, as the cookbook says).

## src/md: Bun's Markdown parser `bun_md` (done)

- **What**: all of `vendor/bun/src/md/*.rs` but `ansi_renderer.rs`, file by file in `src/md/` (`lib.ts` is the entry,
  `docs/MD_API.md` has the Rust -> TS mapping of everything `format/markdown` uses): the block parser, containers
  (quotes, lists, tasks, footnotes `[^a]:`, `:::` directives), tables, reference definitions, inlines (emphasis with the
  micromark / remark-8 variants of `compat.rs`, code, HTML, entities, links, images, wiki links, autolinks, math), the whole
  event interface including the "track" side (`wantsSource`: line starts, container / leaf / inline sources,
  definitions) and the consumer's own syntax (`Extensions.leaf` / `span`), and `html_renderer.ts` (for tests).
  Big tables (351 punctuation ranges, case folding, 2,125 entities, `is_alphanumeric`) are generated into compact strings
  (`tools/md/gen-tables.mjs` -> `src/md/tables.ts`) and decoded on first use. Data layout: byte ranges into the source
  `Uint8Array`, typed-array tables (SoA), one reusable `Parser` per nesting level (a parse may start inside a callback:
  `format/markdown/parse.rs` does that in `leaves_paragraph`), `ByteBuf`/`I32Vec` from `src/base/`.
- **Differences from Rust**: no `Result` (only `ERR_INPUT_TOO_LARGE`; `StackOverflow`/`TooManyBlocks` do not exist: the
  parser is iterative); `OFF::MAX` is -1; `(buf, start, end)` for every `&[u8]`; the document is exactly the `Uint8Array`
  (`text.subarray(firstLine)` where Rust slices). Overrides of `Renderer`/`Extensions` methods must repeat the parameter
  list exactly (scriptc).
- **Tests** (`tools/md/run-tests.sh`; the oracle is the unmodified Rust parser built with shims, `tools/md/rust-oracle/build.sh`):
  - HTML vs `Bun.markdown.html` (`diff-html.ts`, bun): 371 vscode `.md` + 366 Prettier `markdown/`+`mdx/` fixtures and
    snapshots + 1,324 CommonMark 0.31.2 / GFM examples + mutants/structured fuzz, 7 option sets: **0 diffs** in
    ~3.5 M renders (seeds 1-4, 31, 32 with 100k docs each; invalid UTF-8 compared lossily).
  - Event stream vs the Rust parser (`diff-events.ts`): every callback and argument, 12 option sets (formatter's
    options with `micromark`, `micromark_to_the_letter`, `footnotes`, `math_blocks`, `no_single_tilde`; oxfmt's
    `directives`; `mdx`; plain; wiki / autolinks / math / collapse; track on and off; extension hooks): **0 diffs** in
    ~3 M doc x option runs (corpora + 60k-doc fuzz x 3 seeds); `diff-stress.ts` (deep nesting, quadratic traps): 99 runs,
    0 diffs; `reentrancy.ts`: nested parses in callbacks do not disturb the outer one.
  - Tables: `case_fold`, punctuation / white space / alphanumeric for all 1,114,112 codepoints, 30k entity texts, UTF-8
    decoding vs Rust: 0 diffs; all codepoints next to emphasis markers and as reference labels vs `Bun.markdown.html`
    (6.7 M documents): 0 diffs. The 14 tests of `unicode.rs`: `src/md/unicode.test.ts`.
  - `compiled-check.ts`: scriptc build and node print the same hash over 32k documents.
  - Not reachable from `Bun.markdown` (covered by the Rust oracle only): `footnotes`, `mathBlocks`, `directives`,
    `noSingleTilde`, `micromark*`, `mdx`, `latexMath`, `underline`.
- **Throughput** (compiled, scriptc 0.3.0, M5 Pro, vscode `.md` corpus: 371 files, 5.98 MB, best of 20):
  event stream as the formatter reads it (track mode, footnotes + math + micromark options): **~335 MB/s** (17.8 ms; node
  ~290); HTML renderer: **~228 MB/s** (node ~140). For reference, the Rust parser itself (same machine, this oracle):
  events 591 MB/s, HTML 282 MB/s; `Bun.markdown.html` 317 MB/s. Per document overhead 0.07 us (empty) / 0.26 us (a line).
  `scriptc build tools/md/bench.ts -o /tmp/mdbench && /tmp/mdbench /tmp/vscode-files.txt bench/vscode 20`.
  What was learnt (scriptc): `x++`/`x += y` on a local make the index a double: `x = ((x | 0) + 1) | 0` gave +15-20%; a
  byte-by-byte scan of 74-byte lines beats `Buffer.indexOf` (2.9 GB/s vs 0.6 GB/s; `Uint8Array.indexOf` does not compile).
- Residual: the `char::is_alphanumeric` table (for `:::name`) is that of the Rust nightly pinned in `rust-toolchain.toml`;
  `is_unicode_space_separator` / `decode_wtf8_rune_t` of `bun_core` (not vendored) are re-implemented (checked against
  Bun's output for every codepoint / invalid bytes in `diff-html.ts`, `diff-unicode-bun.ts`).
- Compiled with `SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-md` (bench: 2.4 s cold).

## src/sema: HIR tables, atoms, lexer (done; the parser and the binder are not)

- **What**: `src/sema/hir.ts` (GENERATED by `node tools/gen-hir.ts` from the schema in that file: ~30 struct-of-arrays tables,
  tags, enums, flags, per-variant `push*` builders and `<table><Variant><Field>` accessors), `hir_util.ts` (parenthesis
  queries, entity-name predicates, modifiers, `beginFile`, `finishHir`), `atom.ts` (the 170 `known` atoms with Rust's numbers),
  `node.ts` (tsgo `Kind`, handle encoding, node index space; NOT the tsgo tree walkers), `parser/{token,names,lexer,pragmas,lib}.ts`
  + generated `unicode_tables.ts`, `jsx_entities.ts`. Contract for the parser/handles porters: **`docs/HIR_API.md`**.
- **Design**: ids are Int32, `NONE = -1`; a Rust `Span<T>` and `IdList<T>` are both (start, len) into `hir.ids` (no contiguity: the
  parser pushes rows as it goes and collects ids on a stack, `hir.listFrom`); enums with payload = `tag` + `a,b,c,d,e` + `aux`
  columns; one `hir` per thread, grow-only, `beginFile` resets. Atoms are always the file's own (dense, per file, known atoms fixed);
  texts live in the source or in `names.cooked`; `names.atomToken(a)` gives the keyword token from the atom in the same probe.
  **Lazy bodies**: the parser has none (the `hir.rs` header is stale): bodies are parsed eagerly (`fnBodyKind/A/B`). What is lazy in
  Bun is derived data (`LazyCells`: tsgo parents/owners; `lint::ast::Lazy`: lines, tokens, parents, ...): TS equivalent = a
  per-thread array + `built` flag that `beginFile` resets (HIR_API.md section 3).
- **Lexer**: faithful port of `lexer.rs` (all rescans, JSX, templates, comments/directives/leading comments into `hir.comments`,
  refusal and recovering modes, marks as a LIFO stack slot). Tests (`tools/`): `lex-xcheck.ts --tsx` = every token boundary of
  14,885 vscode files (29.7 M tokens) vs `ts.createScanner` (5.9.3): **0 mismatches**; `lex-unit.ts` 238 checks (node and
  compiled); `lex-fuzz.ts` 20k mutated inputs (node and compiled); `hir-smoke.ts`. `tsc -p tools` clean.
- **Throughput** (`tools/lex-vscode.ts`, 198 MB, 29.7 M tokens, single thread, includes interning every name): compiled
  **345-357 MB/s** (node 285-316): the 400 MB/s target is NOT reached (Rust uses SIMD stops). A program that also imports
  `Worker` runs the same lexer at **241 MB/s** (-30%): use processes, or accept it. Details/what was tried: HIR_API.md section 11.
- **Gaps / next**: (1) `sema/bind/parents.rs` (`try_bind_for_format_in`: the `Bound` parent tables the handles need) is unported
  and has no owner; (2) `sema/parser/summarize.rs` (extension -> options, script/module retry) belongs to the driver/parser porters;
  (3) `lint/tokens` + `sema/check/spans.rs` (text scanners of the handles) are unported; (4) recovering mode of the lexer is
  untested and keeps no diagnostic arguments; (5) `src/sema/vec.ts` (`I32Vec` with `push2/push3`, `Bytes`) duplicates `src/base/`:
  dedupe when convenient; (6) identifier/whitespace classes above U+007F come from node's Unicode tables, not Bun's.
- Compiled with `SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-sema`: `scriptc build tools/lex-vscode.ts -o /tmp/lex-vscode` (1.4 s cold).

## src/base + src/format top level + src/format/ir: the foundation (done)

- **What**: `src/base/` (`ByteBuf`, `I32Vec`, `Interner`, `IntMap`, `bytes.ts` with `eqAscii`/char classes, `utf8.ts`, `stack.ts`: the
  recursion-depth budget that replaces `StackCheck`, default 1000 doors, numbers justified in its header). `src/format/`:
  `options.ts` (`FormatOptions` with oxc field names, `set("semi","false")`, flavors, trailing commas), `text.ts`,
  `syntax_error.ts` (`MSG_*`, refusal slot), `pragma.ts`, `front_matter.ts`, `sort.ts` (stable `Int32Array` sorts), `errors.ts`
  (`FormatError` codes, `isTooLong`). `src/format/ir/`: the whole of Bun's `ir/` (elements, tracker = `document.rs`, formatter +
  builders, printer with measure/fill/best-fitting/line suffixes/indent-if-break, widths + tables, `Scratch`/`run.ts`).
  Not ported (per assignment): `range.rs`, `cursor.rs`, `verify*`, `tailwind.rs`, the JS parts of `lib.rs`.
- **API for the other porters: `docs/IR_API.md`** (Rust -> TS for every builder/macro/method used in js/json/css/graphql/html/markdown, worked
  examples of `write!(f, [group(..)])` and `best_fitting!`). In short: everything is imperative (`f.startGroup(); ...; f.endGroup()`),
  captured content (memoized/intern/capture) is an int handle (`startCapture/endCapture/writeInterned`), tokens are registered
  constants (`token(";")`, `ir/tokens.ts`), text is a range of the source or copied, `f.willBreakFrom(start)` is free (tracker).
- **Data layout**: the document is one SoA pool (`tag: Uint8Array`, `a/b/c: Int32Array`, 13 bytes/element), grow-only per thread; tokens
  up to 12 bytes live in the element (kind = `TOK_BASE + len`, bytes in a/b/c) and print with 1-3 `DataView.setUint32`.
- **Tests** (all identical under node and compiled): `src/format/ir/ir.test.ts` (148 checks: 66 Prettier cases of `cases.ts`, IR
  behaviours, checksum of 3000 random documents), `src/base/base.test.ts` (65), `src/format/format.test.ts` (149).
  Against Prettier 3.9.6 (dev tools, node only, `PRETTIER_DOC=.../doc.js`): `tools/ir-fuzz.ts` (random documents vs `printDocToString`,
  with shrinking): 4000/4000 at depth 2, 3 and 5, 3999/4000 at depth 4, 4000/4000 with CJK/emoji text; `tools/ir-check.ts` (the 66
  expectations are Prettier's); `tools/width-fuzz.ts` (string widths: 99.96%, the rest is the ZWJ/skin-tone joins that Bun's `emoji_len`
  deliberately accepts); `tools/text-fuzz.ts` (skipSpaces/hasNewline/isNextLineEmpty/... : all agree). `insertPragma` expectations are
  `bun fmt --insert-pragma` output.
- **Throughput** (compiled, M5 Pro, `src/format/ir/bench.ts`, 1000 JS-like documents of 3.8k elements): printing ~5.7 ns/element =
  **~380 MB/s of output**; writing 4-5 ns/element (a loop that writes only tokens/spaces/lines: 3.8; groups 4.4). Node: print 8.8,
  write 15. The printer is bound by the dispatch (indirect branch per element): `xctrace`+`tools/xctrace-top.py` shows the stall at the
  load of the kind byte.
- **Known gaps / differences**: (1) by design as in Bun, not Prettier: a line break on an empty line prints nothing, `fill` in a
  flat variant after a hard line break is not re-measured, ZWJ joins (IR_API section 11); (2) `Stack` is a depth counter (callers call
  `enter()`/`leave()`, `IR_API` section 2), under node the default stack overflows before 1000 doors on deep input (use
  `node --stack-size`); (3) `f.willBreak` of an `intern` that is a single element is the flag of the capture, equivalent;
  (4) `FormatOptions.sortImports/tailwind` are int handles (-1 = none) and `parseJavascript` is not there: the owners of
  `js/sort_imports`, `tailwind.rs` and `html` add what they need by subclassing/extending; (5) nothing checks that every `startX` has its
  `endX`: a malformed document is `FORMAT_INVALID_DOCUMENT` at print time.
- **scriptc learnings** (add to the cookbook): every `let` number is a double with an optional i32 "view"; `const a = this.arr`
  of a typed array costs a retain+release pair (~5 ns): do not bind arrays to locals in small functions, read `this.arr[i]`;
  scalars (cursor, output length, widths) in locals gave -40%; `DataView.setUint32/getUint32(…, true)` copies a short text in
  1-3 stores (byte loop: 1.5 ns/byte for runs of 4-12); `s[i] === "x"` on a string does not compile (SC1090: use `charCodeAt`);
  `Uint8Array.set(subarray)` 12 ns vs `Buffer.copy` 6 ns fixed cost.
- Compiled with `SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-core` (ir.test: 2.5 s cold).

## src/format/conformance + tools/conformance.ts: the conformance runner (done)

- **What**: port of `vendor/bun/src/format/conformance/{lib,prettier,oxfmt}.rs` -> `src/format/conformance/{lib,prettier,oxfmt}.ts` and
  `tools/conformance.ts` (`node tools/conformance.ts prettier|oxfmt [bundle] [--languages= --filter= --table --report=dir --every= --first=]`;
  also `--run-prettier-tests` / `--run-oxfmt-tests` as in Bun; compiles with scriptc: `scriptc build tools/conformance.ts -o /tmp/conformance`).
  Snapshot parsing, option handling, the six checks (format, rejected, second format, CRLF, CR, BOM), `EXCLUDED`, `UNSTABLE`, cursor / range
  placeholders, `--report` file names and the report format are Bun's, line for line. All text is a latin1 "byte string" (nothing is decoded).
- **Plug-in point**: `src/format/conformance/dispatch.ts` = `format_for_tests` (kind by `options.parser` / name -> one `run<Lang>` function per
  language, each `return NOT_PORTED` until the porter uncomments the import and calls its module; `formatBlock` = `options.formatJavascript`).
  A case whose language is not ported is counted apart ("not run: N: not ported yet (css 162, ...)" and `not ported N` on the language line),
  never as a failure. Shared with the driver? `src/driver/dispatch.ts` has its own stubs (identity, different signature); make both call the same
  `src/format/<lang>/mod.ts`. Open hooks (TODO(port) in dispatch.ts): JS path (`runScript`: flow, module-then-script, sort imports, range),
  `cursorInFormattedText` (cursor.rs), HTML `parse_javascript`, `sort_package_json`, `sortImports` for embedded code.
- **Checks of the runner** (no formatter needed): with nothing plugged in every case is "not ported" (10,543 of Prettier's); `--identity` (formatter
  = identity): `format` denominators per language = Bun's `expected.txt` exactly (angular 109, css 162, flow 1505, graphql 104, handlebars 128, html 272,
  js 1357, json 785, jsx 186, less 238, lwc 5, markdown 1572, mdx 32, misc 565, mjml 9, scss 136, typescript 756, vue 189, yaml 1623 = 9,733) and
  `rejected` denominators too; the 5 "not run" reasons are 3 / 2 / 4 / 13 / 66 as in Bun; oxfmt 1570 + 1498 as in Bun. `--mock` (formatter = what the
  snapshot says, no cursor / range / endOfLine placement): 9,687/9,733, the per-language lines equal `expected.txt` wherever Bun itself passes everything (denominators of all six checks), the 46
  failing checks are the cases the mock cannot place (cursor, range, `endOfLine`, inputs with a BOM); `--table` / `--filter` / `--languages` / `--every` / `--first` output equals `bun fmt
  --run-prettier-tests` byte for byte on the languages the mock passes. Node and compiled output are identical; a full run takes 0.2 s without a formatter.
- Compiled with `SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-conf` (1.4 s cold). Learnt: `Buffer.from(s, "latin1")` / `.toString("latin1")` round-trip bytes
  in scriptc; `str.split(sep).join(x)`, `Map<string,T>`, `arr.sort(cmp)` on `string[]` compile.

## src/driver + src/main.ts + tools/{difftest,optiontest}.ts: the `bun fmt` command line, minus the formatters (done; Prettier flavor)

- **What**: port of `vendor/bun/src/lint/driver/fmt/{mod,cli,files,config,editorconfig}.rs` + `args.rs`, `gitignore.rs`, `fs.rs`, `git.rs`,
  `init.rs`, the `[fmt]` half of `bunfig.rs`, `lint/{ignore,glob,paths}.rs`. `scriptc build src/main.ts -o bin/fmt` (also `node src/main.ts`, which scans in the
  main thread only because `publish` clones under node). Files: `cli.ts` (flags, usage errors, `--help` text in `help.ts`), `entry.ts` (process, `--cwd`, bunfig,
  colors, output), `run.ts` (`Run`: stdin, files, summaries, `--init`, `--find-config-path`, `--staged/--changed` via `git`), `config.ts` (Prettier's
  `resolveConfig`: `.prettierrc*` as JSON/YAML/JSON5/TOML, `package.json`/`package.yaml`, a JS/TS config that is one object literal, overrides, plugins,
  `.editorconfig` through `editorconfig.ts`, flags, bunfig `overrides`), `bunfig.ts` (`[fmt]`, errors with place), `files.ts` + `scan.ts` + `ignored.ts` +
  `target.ts` (arguments, globs, `.gitignore`/`.prettierignore`, the parallel walk), `glob.ts` (own glob engine: `* ? [] ** {a,b} {1..3} @(|) !()` + the picomatch conversions of
  `lint/glob.rs`), `ignore.ts` (the npm `ignore` package, with its regex fallback), `kinds.ts` (language by name, `Kind::of`, shebang), `jsonv.ts` (JSON/YAML-subset/TOML
  readers), `worker.ts` (read, format, compare, write), `problem.ts` (the `error:` excerpt print), `dispatch.ts` (the plug-in point).
- **Dispatch API** (`src/driver/dispatch.ts`): `formatFile(path, src: Uint8Array, len, set: OptionSet, out: ByteBuf): ST_*` (ST_OK / ST_SYNTAX / ST_BUG / ST_CHANGED / ST_UNREAD;
  details of a failure in the slots `errMessage`, `errOffset` (byte offset, -1 = whole file), `errIsJs`). The body mirrors `format()` of mod.rs: UTF-16 check, `Kind::with_options`,
  `finish()` (R_* codes of the language formatters -> "This is not valid X" / syntax error at offset / nested too deeply / too long / bug, `insertFinalNewline: false`), one
  `TODO(port)` function per language (`jsonFormat`, `cssFormat`, `yamlFormat`, `markdownFormat`, `graphqlFormat`, `tomlFormat`, `handlebarsFormat`, `htmlFormat`, `scriptFormat`),
  each a copy of its input now. `formatOptionsOf(set)` builds the thread's `FormatOptions` from the resolved names/values (`FormatOptions.set` in order, `filepath` first).
  The driver compares `out` with `src` itself. `FMT_STUB_REWRITE=1` makes every script "change" (to test writing).
- **Checked against Bun** (`node tools/difftest.ts`: 380 scenarios (+81 oxfmt-flavor ones in the same run; `node tools/difftest.ts --oxfmt` also runs Bun's own oxfmt test cases, formatter-dependent ones differ until the formatters are plugged in), stdout + stderr + exit code, ignore files / globs / sequences / nested configs / bunfig / flags / usage errors /
  stdin / git; `OURS=bin/fmt-node` for node): 0 differences. Not compared: a few scenarios that depend on what the formatters do (stubs) are listed in `STUB_DEPENDENT`.
  `node tools/optiontest.ts` (620 checks): formats a probe through `bun fmt --stdin-filepath` and reads the options off the output, and compares with the options ours
  resolves (`--dump-options`): editorconfig (sections, nesting, root, ranges), every `.prettierrc` form, overrides, flags, `--config-precedence`, bunfig + overrides: all equal.
  `bin/fmt --list-files` in bench/vscode is identical to Bun's (18,080 lines). `--compare-to=<dir> [--compare-list]` (dev flag) compares our output per extension with an oracle tree.
- **Timing** (`bench/vscode`, `--check`, stub formatters = our floor; best of 6-8, Apple M5 Pro, other jobs running): ours 1 thread 545 ms, 8 threads 293 ms, 18 threads 276 ms;
  Bun 2602 / 464 / 311 ms (Bun with real formatting). `--list-files`: ours 75 ms, Bun 52 ms. Phases (8 threads): walk+classify+options ~75-100 ms (the main thread resolves options
  while the workers walk), read/compare ~170 ms (18 threads: 135 ms; syscall-bound: `open` of 238 MB in 18k files, the same floor as the cookbook's 116 ms).
- **scriptc learnings** (add to the cookbook): (1) **do not share object graphs with `publish` unless the workers only read fields in loops**: a published `Tok[]`/`Seg[]` read inside
  a *recursive function that takes the array as a parameter* gives `undefined` elements as soon as two workers run it (repro in /tmp/probe/g13.ts: 50 lines). Workers here get
  strings / numbers / flat arrays and rebuild their own objects (`ScanTask`, `Ignored.rebuild`); published `Job` arrays of strings/numbers are fine. (2) `fs`: `openSync(path, flags, mode)`,
  `Stats.mode`, `spawnSync` options `cwd/input/env`, `process.chdir(non-string)`, `Stats.nlink` OK, `copyFileSync`/`fchmodSync` OK are the gaps hit; `Buffer.compare(target, ts, te, ss, se)` OK;
  `Buffer.from(u16.buffer,0,n).toString("utf16le")` builds a string 4x faster than `String.fromCharCode` + `+=`. (3) `import { X }` of an interface/type alias needs `import type`
  under node (not for scriptc). (4) a class-typed `message` handler param rejects a plain object (`expected m18.WorkerMessage got object`): use an interface. (5) Kernel contention: 8+ threads
  walking directories get 3x slower per directory (open/getdirentries/lstat), so the walk is done in rounds of at most 40 directories per claimed root (balance) by fresh workers.
  (6) a worker that throws leaves the main thread waiting for ever: `worker.on("error")` must exit.
- **Known gaps**: the oxfmt flavor is ported (`.oxfmtrc.json(c)`, `oxfmt` in package.json, `--flavor oxfmt`, OfGit ignore reading, `ignorePatterns`, oxfmt editorconfig, summaries); JS/TS config files are only read when they are one object literal
  (`module.exports = {..}`, `export default {..}`, `const c = {..}; export default c`), no `require`/imports; `package.json` `"prettier": "<module>"` not loaded; the project's own Prettier bridge
  (`prettier-plugin-*` files) is "not installed"/"left alone" as in Bun without Prettier; `--doctor`, `sortTailwindcss`, `sortImports` option objects are passed through unchecked
  (tailwind is refused); error excerpts have no syntax colors under `--color`; TOML/YAML parse error texts for config files are generic ("Unexpected token"); global `~/.bunfig.toml` is not read
  (Bun does not read it for `[fmt]` either); changed files are written in place (Prettier's way, 2x faster than Bun's temp file + rename; `FMT_ATOMIC_WRITES=1` for rename).

## css/doc ready (src/format/css/{doc,sink,memo}.ts) -- API: docs/CSS_DOC_API.md

- `Doc` = Int32 handle into a per-thread pool (`docPool`, `docReset`/`docPush`/`docPop`); `Elements`, `Printer`, `printDoc`,
  `textToDoc`, `replaceEndOfLineWithLiteralLines`, `toTree` are the ports of `css/doc.rs`; `sink.ts` and `memo.ts` of the CSS
  sink/memo. Tests: `node src/format/css/doc.test.ts` (also compiled), `node tools/css/doc-fuzz.ts` (50k random documents vs
  Prettier 3.9.6 `printDocToString`: identical but for the documented differences of Rust itself). The rest of CSS follows.

## src/sema/parser/parser part B: stmt, module, declared, ty, jsx (done for the non-recovering Babel/TypeScript parse)

- **What**: `stmt.ts` (statements, declarations, modifiers, decorators, variable lists, enums, namespaces/modules, `for`/`switch`/`try`...),
  `module.ts` (imports, exports, import attributes, `import x = require`, `export =`, `export as namespace`), `ty.ts` (all type syntax: unions,
  conditional/infer/mapped/template/tuple/import/typeof/predicate types, signatures and members, interfaces, type aliases, heritage clauses,
  type arguments), `jsx.ts` (elements, fragments, namespaced/member names, attributes, spread, children, entities through the lexer),
  `declared.ts` (oxc's redeclaration tracking: `Declared` + `declare/openScope/closeScope/...`; **off** and not called by the formatter's
  dialects: `p.isOxc`-style wiring is `TODO(oxc)`). Rust names -> camelCase, branch for branch, in the conventions of `mod.ts` (module
  singletons `lx`/`p`/`s`, rows pushed into `hir`, stacks hold row ids, tuples through `p.outPos/outLen/outA`). A `Start {pos, full}` is
  `(startPos, startFull)`; `add_stmt` is `pushStmt<Kind>(startPos, ..)` + `finishStmt(stmt, startFull, modStart, modLen)`.
- **API others call** (parser-A's `class.ts`/`expr.ts`/`func.ts` already use it): `ty`, `typeAnnotation`, `typeOrTypePredicate`, `isStartOfType`,
  `isStartOfParameter`, `negativeLiteralType`, `typeQuery`, `typeArguments` / `typeArgumentsUnchecked` / `typeArgumentList` (+ the error of
  `checkGrammarTypeArguments` in `typeArgsErrorCode/Start/End()`), `isAtTypeArgumentsOfHeritageElement`, `isHeritageElement`,
  `heritageElements(element: (index) => void)` (+ `heritageListHasComma/CommaStart/CommaEnd()`), `heritageType`, `importWithTypeArguments`,
  `isIndexSignature`, `indexSignature`, `objectTypeMembers`, `interfaceDeclaration`, `typeAliasDeclaration`; `statement`, `embeddedStatement`,
  `block`, `statementsUntilCloseBrace`, `equalsAfterBlock`, `modifiers(MODS_*)`, `takeModifiers`, `modifierFlag`, `finishStmt`, `initializer`,
  `optionalInitializer`, `isStartOfDeclaration`, `isLiteralPropertyName`, `variableDeclarationList`; `importAttributes`, `unclosedImportAttributes`,
  `importDeclarationOrImportEquals`, `exportDeclaration`, `exportAssignment`, `namespaceExportDeclaration`; `jsxElements`, `jsxElementOrFragment`.
  `src/sema/parser/parser/_stubs_a.ts` now re-exports `jsx.ts`: parser-A, repoint `expr.ts` to `./jsx.ts` and delete it.
- **Hooks left** (comments `TODO(oxc|recover|flow|jsdoc)` naming the Rust function; 97 / 40 / 23 / 7 sites): the third agent wires them (`p.recovers`,
  `isFlow()`, `reportsLikeOxc()`, ... do not exist yet in `mod.ts`). Rare bits (`hir.rareSyntax`) and the grammar diagnostics (`flag(..)`)
  that the non-recovering path sets are ported (the linter's `refusal_of_prettier` reads the bits as filters).
- **Tests** (all `node`; compiled with `SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-parserB`, no diagnostics):
  - `sh tools/parser-b-check.sh [N]` runs everything below. `tools/parser-cases/*` is the torture set (every type syntax, statements, modules,
    declarations, decorators, `using`, ASI hazards, JSX forms, JS in module and script form): `tools/parser-check.ts` = accept/refuse equals
    TypeScript's `parseDiagnostics` (6 files: equal).
  - `tools/parser-xcheck-b.ts`: positions and counts of statements, types, members, enum members, import/export specifiers, variable declarations,
    type parameters, cases, JSX elements/attributes/expressions against TypeScript's tree; `tools/parser-deep-b.ts`: a signature of the FIELDS of each
    statement kind / type kind / member / type parameter / JSX element (ranges of children, names, modifier flags, counts, kinds of variables,
    mapped-type modifiers, tuple element flags, import/export clauses...) against TypeScript's tree. bench/vscode (14,459 of 14,731 TS files that TS
    itself parses without error): **1,972,189 statements, 1,010,156 types, 301,977 members, 6,393 type parameters, 9,895 JSX elements: 0 mismatches**
    (the rest are tool artifacts, filtered); the 997 Prettier TypeScript fixtures, 57 JSX, 904 JS fixtures: only the expected differences (decorators
    TypeScript does not keep, `1n`/`[1]` enum names, a decorated class expression starts at `class` in the HIR but at `@` in TS: parser-A's `class.ts`).
  - Accept/refuse against `bun fmt` on Prettier's 2,294 ts/js/jsx fixtures: ours never refuses what Bun accepts; every file TypeScript rejects and
    we accept is accepted by Bun too; the 354 files Bun refuses and we accept are errors of Bun's syntax linter (`typescript_estree`/`espree` checks:
    'async' modifier cannot be used here, ...), not of the parser. `tools/parse-vscode.ts` (parser-A): 14,861 accepted, 25 refused (all fixtures with
    invalid characters / ellipses), compiled **~220 MB/s** whole parser (node ~160); my files are ~8% of the samples (`sample`), the rest is the
    lexer and `scr_stack_enter/leave` (the compiler's stack guard on every non-inlined function of the recursive parser: ~19%).
  - `node tools/declared-unit.ts`: 20 checks of `declared.ts` (needs the oxc wiring to matter).
- **Gaps / notes**: (1) the oxc/recovery/Flow/JSDoc branches above; (2) `forgetSpecifiersOfMisplacedDeclarations` (recovery) and the `SpecifierUse` /
  `specifier_uses` lists are not kept (the HIR has no table for them); (3) `entityName`s and tuple elements are pushed as rows when parsed, so a
  speculation that is rolled back leaves no garbage (tables are truncated by `checkpoint`/`rollback`), but `argumentInPlaceOfTypeArguments`
  (`import(A<B>)`) forgets nodes with its own snapshot of the table lengths (`forgetNodesBegin/End` in `ty.ts`) because `mod.ts` has no `forgetNodes`;
  (4) scriptc: `lookAheadEnd(mark, had)` pairs everywhere are inlined; the only closure is the `heritageElements` callback (once per heritage clause).

## src/sema/parser/parser part A: mod, expr, pattern, func, class, js_syntax, json + the parse entry (done for the non-recovering Babel/TypeScript parse)

- **What**: `mod.ts` (a LEAF: ctx bits, `ListKind` and `ModifiersOf` constants, `Stacks`, the parser fields `p`, the lexer `lx`, the atoms `names`, tokens,
  `fail/refuse/report`, `eat/expect/semicolon`, context, lookahead, **speculation** `checkpoint/rollback/commit` + `tryParseBegin/End` +
  `lookAheadParsingBegin/End`, names, `takeIds/takeList`, `finishStmt`, `enterDepth/leaveDepth`, `beginParse`, and the non-recovering forms of the entry
  points of `recover.rs`: `expected`, `unmatched`, `missingIdentifier`, `enterList`, ...), `expr.ts` (all of expr.rs: operators with the `as/satisfies`
  and `??` rules, arrows via `func.ts`, calls, `new`, optional chains, `import()/import.meta`, templates, object/array literals, `parsePropertyName`,
  type arguments in expressions with the memo tables of expr.rs), `pattern.ts`, `func.ts` (functions, parameters, arrow-function disambiguation
  `isParenthesizedArrowFunction` + `parenthesizedArrowFunction` with the `not_arrows` memo), `class.ts`, `js_syntax.ts` (`checkJSSyntax`: DK_JS
  diagnostics), `json.ts`, and the entry `run.ts`: **`parseFile(src, len, path, isScript): number`** = `file_read_as` of summarize.rs for
  `Dialect::babel(isScript)` (path -> ts/js/jsx/tsx/json/declaration, the second parse with `awaitIsAName` when a top-level `await` was read in a file
  that has no module syntax); 0 = parsed, else `R_*` (`lx.refusedAt`). `parseSource(...)` = `parser::run` with explicit options. The formatter's driver
  does `kinds(path)`: `parseFile(.., false)` then `parseFile(.., true)` if refused (`.mjs/.mts` module only, `.cjs/.cts` script only). Also `src/sema/ecmascript.ts`
  (`report_syntax_of_typescript`, the DK_JS diagnostics of a JavaScript file that has TypeScript-only syntax).
- **Conventions** (see the header of `mod.ts`; parser-B uses the same): free functions over module singletons; ids are row ids; stacks hold ids; tuples through
  `p.outPos/outLen/outA/outB`; `Start{pos,full}` = `(startPos, startFull)`; closures are begin/end pairs; **recursion guard** is a depth budget (`p.depthLimit = 3000`
  doors, then `R_TOO_DEEP`), not the stack pointer: the compiled binary's 8 MiB handles ~5000 levels of `(((` and ~5000 `class{m(){` levels (2 doors each); Bun's limit is the real stack.
- **Not ported** (each site is a `// TODO(recover|oxc|flow|jsdoc)` naming the Rust function): the recovering parser (`recover.rs` entry points are the non-recovering
  forms: `expected` = `fail`), oxc, Flow, JSDoc, `Declared` (oxc_names only, off), `specifier_uses` (no HIR table), the message arguments of diagnostics (HIR drops them).
  Cases where the strict parser refuses and Bun's recovering parser accepts (`import<T>("m")`, ...) need the third agent: on bench/vscode there is none.
- **Tests** (tools/, all `node`; `parse-vscode`, `parse-micro`, `parse-deep`, `parse-dir` also compiled, `SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-parserA`):
  - `tools/parse-vscode.ts [--bun /tmp/pa/bun_errors.txt]`: every ts/tsx/mts/cts/js/jsx/mjs/cjs file of bench/vscode (14,886; module then script as the driver does).
    **14,861 accepted, 25 refused: exactly the 25 files `bun fmt --check` cannot check** (fixtures with `…`/invalid characters; `grep '^    at ' stderr`). 0 disagreements.
  - `tools/parse-xcheck.ts` (structural oracle = `ts.createSourceFile`): every row of exprs, stmts, types, patterns, binding elements, params, type params, members, props,
    var decls, cases, import/export specifiers, enum members, tuple elements has a TS node of the matching kind at the same (getStart, end), operators of binary/assign/unary
    rows equal TS's, and the reverse for the main expression and statement kinds (UTF-8 -> UTF-16 positions converted). Whole corpus (14,861 files): **25,960,729 rows compared, 0 mismatches** (~5.5 min under node); the
    classes that are not compared are the ones where HIR differs from TS **by design in Rust** (counted in the output): `typeof a.b` entity names (exprs in HIR), `with {..}` import
    attributes, `for (init;..)` expression statements, `finally` blocks that start at the keyword, `{...x}` JSX children, array-pattern holes (pos > end), object-literal methods (Fn starts at `(`).
  - `tools/parse-fixtures.ts` + `tools/parse-mutants.ts` (+ `bun /tmp/pa/oracle*.ts` that asks `bun fmt --stdin-filepath`): Prettier's 2,248 js/jsx/ts fixtures and 18,000 mutants of
    vscode files: **we never refuse what Bun accepts, except 3 mutants** that need the recovering parser (`import<T>('x')`, ...); every file we accept and Bun refuses is
    an error of Bun's syntax linter (checker-level grammar errors: modifiers, `Type argument list cannot be empty`, `Classes may not have a field named 'constructor'`, ...), not of the parser.
  - node and the compiled binary print identical results (refusal, position, table sizes, rare bits) on 17,248 fixtures/mutants (`tools/parse-dir.ts`).
- **Throughput** (`tools/parse-vscode.ts`, 198 MB, single thread, compiled scriptc 0.3.0): **~207-213 MB/s** (node ~150); the lexer alone is 325-363 MB/s on this machine (load varies), so the parser adds 8.8 G instructions
  (44 per byte, ~300 per token) on top of the lexer's 8.9 G. Profile: 55% lexer + atom table, 6% HIR pushes (a 7-column `pushExpr` is ~76 instructions, a 11-column `pushStmt` ~108: every
  `number` argument is converted from a double), the rest is spread over ~40 small parser functions.
- **scriptc findings**: (1) **reading `Error.stack` anywhere in the program (e.g. `e.stack` in `src/main.ts`) switches on a frame list (`scr_stack_enter/leave`) in EVERY function: -33% on the parser.
  Never touch `.stack` in a program that is compiled** (a `new Error(..).stack` I had in `fail()` cost 33%; it is gone). (2) A module-level `let` read inside an import cycle is rejected (SC1016: "circular imports ...
  resolved from its type rather than its storage"): keep state in a class instance (`p`) or in a leaf module. (3) `Int32` annotations on class fields (`lx.start`) and push parameters were tried: -3% instructions at best,
  because every id returned by a function is a `number` (double); not applied. (4) `x | 0` on a double is a 10-instruction sequence: store the int once (`const start = lx.start | 0`).
- **Depth guard**: parser-B suggests dropping `enterDepth()` because scriptc has its own stack guard. Kept: scriptc's guard throws `RangeError` (state left half-built, no refusal), whereas `enterDepth` gives the
  clean `R_TOO_DEEP` refusal of Rust's `is_too_deep()` and costs ~1% (the 19% B saw was the `.stack` frame list, see above). The driver should still `try/catch` around `parseFile`.
- **Hooks for parser-C**: `p.recovers` exists (always false); `expected/unmatched/error/missingIdentifier/isAtElement/goesOnWithoutComma/enterList/takeErrorsOfScanner` in `mod.ts` are the places to make live; `isFlow()`, oxc predicates
  do not exist (branches dropped with a TODO naming the Rust function). Tools to reuse: `parse-xcheck.ts`, `parse-mutants.ts` + `/tmp/pa/oracle-dir.ts` (accept/refuse vs `bun fmt`).

## src/lint/ast: the handle layer the JS formatter reads (done; contract: docs/LINT_AST_API.md)

- **What**: `src/lint/ast/*` (port of `vendor/bun/src/lint/ast/*.rs`: `File`, `Expr` (+`Template`, `Call`, `Jsx`, `Regex`), `Stmt`, `VarDecl`, `Case`, `TypeNode` (+`TupleElem`, `Mapped`,
  `ImportAttributes`, `EntityName`), `Pat`/`PatProp`/`PatElem`, `Func`, `Param`, `TypeParam`, `Class`, `Member`, `Modifier`, `Prop`, `Key`, the type declarations, imports and exports, `Name`/`Ident`, lists,
  `Node` and the parents, flow helpers, `for_each_child`), `src/sema/bind/parents.ts` (`try_bind_for_format_in`), `src/sema/check/spans.ts` (the text scanners: `skip_trivia`, `skip_trivia_back`, `token_end`,
  numbers, regex, templates, JSX names), `src/lint/tokens/mod.ts` (`skip_trivia`, `token_len`, `next_token`, `file.comments()` from the lexer's list), `src/lint/span.ts`, and the small utilities the formatter
  calls (`goes_to_flow`, `file_name`, `is_builtin_module`, `number_to_string`, `ends_with_ignore_ascii_case`, `to_lower_case`). The formatter imports **`src/lint/ast/index.ts`**.
- **Representation** (details and every Rust method -> TS in docs/LINT_AST_API.md): handles are Int32 row ids (`-1` = `None`); `Node` is `(kind << 26) | id`; `Name` is an atom, `Ident` the pair `(atom, start)`;
  `Span` is never an object: functions that return one write `SP[0]`, `SP[1]` (a `boolean` for `Option<Span>`); `List` is `(start, len)` into `hir.ids`; `match e.kind()` is `switch (exprTag(e))` plus the generated
  payload accessors; iterators are index loops; closures (`for_each_child`, `sequence`, ...) append to a caller-owned `I32Vec`; a `Key` is derived from its owner node (`keyKind(nodeOfMember(m))`).
  Zero allocation per node. No hidden JSDoc casts / synthetic nodes (this parser never reads JSDoc), no binder fallback.
- **Tests**: `node tools/ast-walk.ts` (also compiled): whole vscode corpus, 14,861 files that parse, 10.2 M expressions + 2.0 M statements + 1.0 M types ...: **0 parent/child mismatches** (`nodeParent(c) === n`
  for every child `nodeChildren` yields), `fillParents` complete (`bound.complete`) in **every** file, spans nested/ordered except the two Rust-identical exceptions (a method's `Func` starts at its modifiers, a generator's `*`
  precedes its computed key). `node tools/ast-xcheck-ts.ts`: **128 M span/token comparisons (expression, type and pattern spans too) against TypeScript's own parser** (14,856 files, non-ASCII ones too): function `(`/`)`/params/body spans, type-parameter
  `<..>`, class/interface/enum/module bodies, template quasis, module specifiers, `;`, parenthesized types (both directions), keys (members, props, enum members), parameter / variable / member / property / case /
  specifier / enum-member / statement spans, JSX opening/closing, `fileEndOfTokenBefore`, `skipTrivia`, `tokenLen`: 0 mismatches except the limits that Rust documents for the same scanners (`skipTriviaBack` fooled by a `//` in a regex on the line before: 404 of 28 M; `tokenLen` of a JSX name `a-b`:
  7 of 12 M). `node tools/ast-unit.ts` (also compiled, identical): 110 hand-checked values. `node tools/lintast-doccheck.ts`: every function named in the doc is exported.
- **Throughput** (compiled, scriptc 0.3.0, M5 Pro): `fileBegin` (parents + parenthesized bits + `\u` positions + comments) **~770 MB/s** of source (the parser runs at ~140 MB/s); walking every node
  (children + span + parent) 364 MB/s = ~35 ns/node; point queries (`tools/ast-bench.ts`): `exprTag` 1.4 ns, `exprSpan` ~6 ns, `exprParent` ~4.4 ns, `nodeParent` ~6.6 ns, `nodeChildren` ~16 ns/node.
- **scriptc learnings** (add to the cookbook): (1) **reading `Error.stack` anywhere in a program (`src/main.ts` line 13 does: `e.stack`) makes the compiler push/pop a stack-trace frame
  (`scr_stack_enter/leave`) in EVERY function, inlined ones too** (`emitter.ts: this.stackTraces`): the whole binary gets slower; drop `e.stack` (use `e.message`). (2) `SC1016` "circular imports ... resolved from its
  type rather than its storage": a `const X = 1` (literal type) that is declared in a module of an import cycle and used as `arr[X]` fails; annotate `: number` and/or declare such constants and module-level
  objects (state, scratch buffers) in a **leaf module** (no imports): their globals are then plain loads (a cyclic module's `const obj = new C()` costs an `initialized` check and a retain per access). Cycles of
  functions are fine (the 10 modules of this layer import each other). `export * from` and explicit `export { x } from` shadowing work. (3) `acc = (acc + (a[i] | 0)) | 0` is 6x slower than
  `acc = ((acc | 0) + (a[i] | 0)) | 0` (a benchmark loop with the first form measured 3 ns per element instead of 0.3); `for (let i = 0; i < n; i++)` around a call that is not inlined carries the index through
  a double (`scvtf`/`fcvtzs`, ~3 ns): `i = ((i | 0) + 1) | 0` in a `while`. (4) `x.toFixed()` on a number inside an array element expression is `SC2012`.
- **Gaps / next**: (1) **`file.jsdoc()`** (`lint/ast/jsdoc.rs` + the reader `sema/check/jsdoc.rs`, ~2,700 lines, `Flavor::Oxc` path only needs `Reader` with `syntax = None`): not ported; used only by
  `format/js/jsdoc/**` (oxfmt's `jsdoc` option, off by default). (2) `lint/tokens/scan.rs` (the full token store): not ported; `file.comments()` is exact except in a script with `<!--`/`-->`
  (`commentsNeedTokenScan()`). (3) The full binder as the fallback of `try_bind_for_format_in`: never needed on the corpus (`bound.complete` everywhere); `fillParents()` returns false instead.
  (4) `Func::enclosing/returns/yields`, `reach.rs`, `File::backslashes`: lint-only, not ported. (5) `lint::{regex, glob, json, options::Json}`, `utils::{array_sort_by, text::*}` beyond the six functions
  above: for sort_imports / tailwind / config code; whoever ports those files ports them. (6) `refused_by_prettier*` (7,000 lines of `lint/linter/syntax/*`) is the driver's.

## src/format/json + src/format/toml (done)

- **What**: `src/format/json/` is `vendor/bun/src/format/json/` file by file (`mod`, `parser`, `writer`, `document`, `comments`, `range`, `sort_package_json`; `config.ts` = `Config`/`Parser`, `core.ts` = `format_normalized`, `util.ts` = the few `format/js/utils` functions JSON uses: `printNumber`, `isEs5IdentifierName` (+ generated `es5_tables.ts`), `isSimpleNumber`, `isLineAfterElementEmpty`, `jsonStringify`; TODO(port): dedupe when `format/js/utils` exists). No hook into the JS formatter is needed (nothing of `crate::js` is more than those helpers). `src/format/toml/` is `mod`, `tree`, `printer` on `src/parsers/toml.ts`, both layouts (Bun's own, oxfmt's). Entry points: `formatJson(src, len, parser, options, out)`, `sortPackageJson(src, len, sortScripts, out)`, `formatToml(src, len, options, out)`, `tomlSyntaxError/Message/Offset`. Wired into `src/driver/dispatch.ts` (`jsonFormat`, `tomlFormat`) and `src/format/conformance/dispatch.ts` (`runJson`, `runToml`).
- **Design**: tree = one `Int32Array`, 8 ints per node (start, end, next, count, width, kind, flags); the no-comment path is parse (one monolithic state machine, 8-byte SWAR string scan) -> writer straight to bytes; comments go through `document.ts` -> IR `Storage` + `propagateExpand` + printer. A `\r` is handled lazily (the parser flags it, `formatJson` normalizes and retries) so there is no extra pass over the text. No exceptions, no per-node allocation.
- **Tests**: `tools/json/compare.ts` (vscode: **1401/1401 json/jsonc files identical**, 4/4 toml; options as the driver resolves them: `.editorconfig` + the `prettier` key of package.json), Prettier fixtures `node tools/conformance.ts prettier --languages=json`: **785/785**, all 4023 checks (rejected 191/191, second format, CRLF, CR, BOM) = Bun's numbers; oxfmt fixtures for json 118/118 + 122/122; `tools/json/own-cases.ts` (own/cases json+toml, both flavors) 90/90; `tools/toml/cases.ts` (toml-layout.test.ts + toml.test.ts) 47/47; differential fuzz vs `bun fmt` (`tools/json/fuzz.ts`, `tools/toml/fuzz.ts`, `tools/json/spj-fuzz.ts`: grammar + mutants, random options, comments, CR, BOM, pragmas, ranges, error words and line:col): ~200k JSON cases (prettier and oxfmt flavors), 72k TOML cases (both layouts), 4.8k sortPackageJson cases: **0 diffs**. `tools/json/selftest.ts` (31 cases made from `bun fmt`) is identical under node and compiled.
- **Throughput** (compiled, scriptc 0.3.0, M5 Pro under load, 1401 JSON files of vscode = 28.6 MB, in memory, best of 20): see the line below; parse ~950 MB/s, write ~1.2-1.5 GB/s; the comment path (82 files, 380 KB) is a few ms. Bun's Rust does the same corpus in roughly 35-40 ms inside a 57 ms process (reading the files is ~20 ms of it), so we are about 1.4x slower on this part. `scriptc build tools/json/bench.ts -o /tmp/json-bench && /tmp/json-bench /tmp/vscode-files.txt bench/vscode`.
- **scriptc learnings**: (1) a class method that binds `const t = this.text` pays a retain/release (~5 ns) per call: pass arrays as parameters, read `this.arr[i]` directly; (2) a call to a big non-inlined function costs ~10 ns (prologue saves 10 registers): one monolithic loop for the hot path took parse from 735 to 1250 MB/s; (3) every assignment to an index local needs `| 0` or it becomes a double (`scvtf`/`fcvtzs` per byte); (4) `DataView.getInt32` SWAR (8 bytes per step, exact first-flag with `Math.clz32`) works but only pays when the scan is inlined; (5) benchmarks on a loaded machine move +-15%: compare two binaries alternately.
- **Left / differences**: `--debug-check` for TOML (`is_same_toml` needs a parser of TOML values); nesting is a depth budget (`Stack`, 1000 doors; Bun's is the real stack) in TOML only (JSON has no recursion); `isEs5IdentifierName` uses the sema lexer's Unicode tables (node 24's) where Bun has its own; the speed gap above.

## src/format/graphql: GraphQL (done; embed.ts is ported as far as it goes without the JS formatter)

- **What**: `vendor/bun/src/format/graphql/*` -> `src/format/graphql/{parser,comments,printer,range,mod,embed}.ts`. `format(text, options, out): FORMAT_*`
  (`mod.ts`; errors: `refusalMessage()`/`refusalOffset()`, offset not counting a BOM). Tree = struct of arrays (`Tree.nodes`, stride 8, +
  `children`), lexer/parser are int-returning (no exceptions), the printer writes the IR imperatively. Wired in `conformance/dispatch.ts` (`runGraphql`)
  and `driver/dispatch.ts` (`graphqlFormat`). Range formatting, `insertPragma`/`requirePragma`/`checkIgnorePragma`, CR/CRLF/BOM are ported (the
  helpers of `format/range.rs` that GraphQL needs are in `graphql/range.ts` until a shared `src/format/range.ts` exists).
- **Tests**: `node tools/conformance.ts prettier --languages=graphql`: format 104/104, rejected 2/2, second format 87/87, CRLF/CR/BOM 104/104 (= Bun).
  `oxfmt --languages=graphql`: the same 6 FAIL lines as Bun's `expected.txt`. Differential vs `~/.bun/bin/bun fmt --stdin-filepath` (message + line:col
  of errors included), `tools/graphql/{extract,mutate,gen,fmt,oracle}.ts`: ~250k mutants/generated documents (node and compiled), options printWidth, tabWidth,
  useTabs, bracketSpacing, endOfLine lf/crlf/cr/auto, insert/require/checkIgnore pragma, rangeStart/rangeEnd: **0 differences** (one harness-only column
  difference on an offset that lands inside an emoji after `insertPragma`).
  Embedded: `tools/graphql/embed-{gen,check}.ts` + `oracle-js.ts` (a mock template over a `gql\`..\`;` statement vs `bun fmt a.js`): 1,500 random statements, 0 diffs, node and compiled.
- **JS-facing entry (`embed.ts`, for the porter of `js/print/template.ts`)**: subclass `GqlTemplate` (`quasiCount`, `rawStart/rawEnd` = ranges of `f.source`, `cooked(i)`:
  bytes or null, `writeExpression(i, f)` = `write_embedded_template_expression`), then `if (isEmbedGraphql(e, f) && writeTemplate(tpl, f)) return;` else print the template
  as it is. `hasEmbedLabel(tpl, f, tagAloneDecides)` is `has_embed_label` minus the tag test. **Not ported** (needs JS handles/comments, TODO(port) in the header of
  `embed.ts`): `isEmbedGraphql`, `hasLanguageComment` and its helpers.
- **Depth**: parser 16,000 nested doors, printer 8,000 (`setParserDoors`/`setPrinterDoors`; measured scriptc, 8 MiB main or worker thread: overflow at ~13,000 printer doors, lists
  30,000+ in the parser). Beyond: `FORMAT_NESTED_TOO_DEEPLY`, never a crash. Bun's own limit is the real stack (selection sets ~8,000-12,000 deep).
- **Throughput** (compiled, worker-enabled build, one thread, M5 Pro under load ~6-10; `tools/graphql/bench.ts`): formatted-style input (40 MB, 4.8 M nodes, 15.6 M elements)
  ~75 MB/s in-process (parse 180 ms, write 190, IR print 172 per 40 MB); comment-heavy random input ~45 MB/s. Whole binary, `--check --threads=1`: ours ~750-790 ms vs
  `bun fmt` 290-385 ms on the same 40 MB (about 2x slower); 18 threads 77 ms vs 27 ms. Not at parity.
- **Where the time is / for the IR owner**: (1) `markOddBlocks` (`ir/width.ts`) reads the module-level table `ODD` per byte: in a worker-enabled program that is a TLS call per byte
  (20% of writing a document). GraphQL avoids it (`startDocument(scratch, EMPTY, ..); f.source = text`, names written with `textSourceWithWidth`), but every other language pays; hoist
  the table into a local. (2) `Formatter.token` reads four module-level tables (TLS in worker mode): 9.6 ns/element vs 5.5 without workers (`/tmp` probe). (3) the printer is
  ~11 ns/element in worker mode. Done on our side: `F_COMMENT` bit per node (no binary search per node), depth counter instead of `stack.enter/leave`, token handles as fields
  of the builder, a plain field (no name) writes no group.
- **scriptc learnings**: a `switch` on bytes plus arithmetic classes beats 256-entry tables in worker mode (tables are TLS); `Int32Array` records of stride 8 gave no measurable gain over
  parallel arrays here; `rm -f *` after a `cd` in a tool call is blocked by the harness.

## src/format/markdown: Markdown and MDX (done, but for the code blocks of languages that are not ported)

- **What**: `vendor/bun/src/format/markdown/*` -> `src/format/markdown/`: `mod.ts` (`format`, `formatMdx`, `formatInTemplate`, `templateDocument`, pragmas, ranges,
  `inferParser`/`parserOfOxfmt`, code-block dispatch), `parse.ts` (the mdast tree from the events of `src/md`; `Builder extends Renderer`, `MdExt extends
  Extensions`; nested parses by level), `ast.ts` (struct-of-arrays tree, strings as handles), `preprocess.ts`, `printer.ts` (documents of `css/doc.ts` built on the
  pool's stack; `FillParts`), `spans.ts`, `strings.ts`, `unicode_tables.ts` (generated: `tools/markdown/gen-tables.mjs`), `embed.ts` (Markdown in JS templates, over the IR:
  `writeMarkdownTemplate(f, raw, start, end, options)`; the JS porter decides `is_candidate`/blank and calls it), `embedded.ts` (the formatters code blocks go to). oxfmt's flavor
  is ported too. The Rust `FormatBlock` closure is not needed: JS/TS blocks use `options.formatJavascript`.
- **Conformance** (`node tools/conformance.ts prettier --languages=markdown,mdx`, node and compiled identical): markdown **1552/1572** (second 930/930, CRLF 1548/1548, CR 1548/1548,
  BOM 1552/1552), mdx **17/32**. Bun: 1572/1572 and 32/32. **All 35 failures need JavaScript/TypeScript/HTML** (code blocks `js`/`ts`/`jsx`/`angular-html`/`lwc`, MDX
  `import`/`export`/JSX through babel, and one cursor case): the diffs, after the fenced blocks are masked, are empty for all markdown cases (`/tmp/classify.mjs` idea: mask fences, compare).
  oxfmt corpus (`conformance.ts oxfmt`): the same failing set as Bun's `expected.txt` (we fail no case that Bun passes except the Prettier-flavor ones with JS blocks).
- **vscode** (`node tools/markdown/compare.ts`; tabs from `.editorconfig`; `extensions/copilot` has `tabWidth 4, singleQuote` in its package.json): 315/371 `.md` equal (84.9%). The 56 that
  differ differ only inside code blocks (`js` 6, `ts`/`typescript` 133, `javascript` 19, `tsx` 3): 0 files with a diff outside a fence.
- **Hooks (unported languages)**: JS/TS (`options.formatJavascript`, set by the driver/dispatch owner: `src/driver/dispatch.ts formatOptionsOf` still has the TODO), HTML/Vue/Angular/LWC/MJML
  (`hookHtml` in `embedded.ts`, only when `options.embeddedHtml`), TOML front matter (Bun leaves it as written too). Called already: JSON (`formatJson`), CSS/SCSS/Less, GraphQL, YAML (front matter
  and blocks), Handlebars, Markdown (nested, own `Tree` per depth). `src/driver/dispatch.ts` `markdownFormat` and the conformance `runMarkdown` are wired.
- **Throughput** (compiled, scriptc 0.3.0, M5 Pro, vscode's 371 `.md`, 5.98 MB, best of 20, includes JSON/CSS/YAML/GraphQL blocks, not JS): **~75 MB/s** (80 ms; node warm ~46 MB/s).
  Stages (before CSS was wired): md parse+tree 30 ms (18 of it `src/md`), preprocess 6, print (document) 24, layout (`css/doc.ts` Elements+Printer) 15. `bun fmt --check --threads=1` on the same files:
  50 ms wall all-in (reads, walk, JS blocks formatted): we are ~1.5x slower per byte than Bun on this corpus; the biggest remaining costs are in the doc pool/`Elements.text` width
  measure (~15%), per-line docs of paragraphs (`printPlainSentence`), and `Tree.add`. What was done: one fused pre-scan (CR/NUL/`[[`), single-pass sentence/inline-code/code scans,
  shared `Elements`/`Printer` (`printDocument`), no per-file allocations of Preprocessor-only buffers. `scriptc build tools/markdown/bench.ts -o /tmp/mdfmtbench`
  (`SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-mdfmt`); `tools/markdown/stages.ts` times the stages.
- **Tests**: `src/format/markdown/markdown.test.ts` (44 checks, expected = `bun fmt` output, generated by `tools/markdown/gen-test.mjs`; passes under node and compiled),
  `tools/markdown/embed-test.ts` (templates through the IR vs `bun fmt` of a .js file: equal but where the template falls back / JS is needed), `tools/markdown/compare.ts`.
- **Known differences / notes**: nesting limit: `css/doc.ts` refuses documents deeper than 1000 (~330 nested quotes, ~100 nested lists) with "nested too deeply"; Bun's is the real stack
  (refuses `> ` x 3000). 1,000,000-deep quotes/lists are refused cleanly (Bun's test row). `identifier` of references/definitions is not computed (the printer never reads it).
  Other agents' bugs seen: `src/format/yaml/printer.ts writeText` calls itself when `!asciiFile || len > 96` (infinite recursion under node on vscode's md; the compiled build did not hit it);
  `src/format/conformance/dispatch.ts` called `kindWithOptions` with 3 arguments (fixed: 4th `false`).

## src/format/handlebars: Handlebars (done; speed ~half of Bun's)

- **What**: all of `vendor/bun/src/format/handlebars/` file by file in `src/format/handlebars/` (`mod.ts` entry `format(text, options, out): FORMAT_*` and
  `saysTheSame` = `--debug-check`; `lexer`, `parser`, `tokenizer`, `ast`, `printer`, `verify`, `tailwind`, `embed`). Same branches as Rust, including
  `is_as_written` (`Tree.written`) and `has_lost_text`. Tree = SoA (`tag`, `start`, `end`, `f0..f8` columns, layout in `ast.ts`); one byte buffer
  `Tree.buf` holds the template and, behind it, the texts the parsers build (Rust `owned`); a Text is `(start, len)`. Errors are ints (-1 syntax with
  `noteRefusal`, -2 nested), the parser's Expression/Header/Inverse are `ex*`/pooled slots. Wired in `src/driver/dispatch.ts` (`handlebarsFormat`) and
  `conformance/dispatch.ts` (`runHandlebars`). Front matter and `<style>` use `yaml/mod.ts` `yamlDocument` and `css/mod.ts` `document` (`embed.ts`).
  Tailwind: `tailwind.ts` has the walker, `setSorter(...)` is the hook (no `src/format/tailwind.ts` yet; off by default).
- **Tests**: `node tools/conformance.ts prettier --languages=handlebars` (node and compiled): format 128/128, rejected 33/33, second 114/114, CRLF 122/122,
  CR 122/122, BOM 128/128 = Bun's. vscode's 2 files (`node tools/handlebars/vscode.ts`): both refused by Bun (partials), same message and place.
  `tools/handlebars/fuzz.ts [count] [seed] [--gen] [--rc='{json}']`: mutants of the fixtures and random generated templates against `bun fmt` (output,
  error message, line:column, and `--debug-check`), with option sets: ~100k cases, 0 differences (except the crash below).
- **Throughput** (compiled, M5 Pro, loaded machine; `tools/handlebars/bench.ts`, `phases.ts`): 83 fixtures 40 MB/s; 2.9 MB synthetic template 40 MB/s
  (lex 12.5 ms, parse 4, build 9, write 24, doc print 18). Bun measures ~75 MB/s for the same file (`bun fmt --check`). The gap is per-token/per-element
  overhead (306k tokens, 1.9M Elements for 2.9 MB). Done: int loops (`| 0` inits), one text buffer, no per-node allocation, path fast path, flags in one pass.
  Leads: fuse lexer+parser (no token arrays), fewer Elements calls per word (6 per fill word).
- **scriptc learnings**: `for (let i = this.field; ...)` / params as loop start give double induction (fcvtzs/scvtf per byte): start with `x | 0`; SWAR
  `DataView.getUint32` scan does not help when `{` is dense; xctrace sample counts are relative only; `/tmp/prof.sh` collides with other agents (use unique names).
- **Found in other modules**: `yaml/printer.ts writeText` recurses for ever (RangeError) on front matter with a non-ASCII key, e.g.
  `---\nk日本eywords: a\n---\n<p>` (tools/handlebars/fuzz.ts seed 54, 6 cases of 6000).

## src/format/yaml: YAML (`mod`, `ast`, `printer`, `scalar`) (done)

- **What**: ports of `vendor/bun/src/format/yaml/{mod,ast,printer,scalar}.rs`. `mod.ts`: `formatYaml(src, len, options, out)` / `format(text, options, out)`
  (FORMAT_* code; a syntax error is in `refusalMessage()/refusalOffset()`), `yamlDocument(src, len, options)` (the `Doc` handle for the front matter of
  CSS / Markdown / Handlebars, or `-FORMAT_*`), `isYamlPath`. `ast.ts`: the tree of `yaml-unist-parser` from `src/parsers/yaml.ts` (one `Int32Array`,
  32 ints per node, `T.d[(id << 5) + F_*]`; properties of a node are a (base, count) on a token stack; comments attached as `attach.ts`). `printer.ts`
  writes to the `Elements` of `css/doc.ts`. `.prettierrc`/`.stylelintrc`/`.lintstagedrc` go through `json/mod.ts` first, as in Rust. oxfmt flavor included.
  Wired: `src/format/conformance/dispatch.ts` (`runYaml`) and the `yamlFormat` hook of `src/driver/dispatch.ts`.
- **Tests**: `node tools/conformance.ts prettier --languages=yaml`: format 1623/1623, rejected 3/3, second format 1118/1118, CRLF 1616/1616, CR 1616/1616,
  BOM 1622/1622 (Bun's numbers); oxfmt `--filter=yaml/`: 84/84 and 80/80. `tools/yaml/own.ts`: Bun's own cases (`test/cli/format/own`) 16/16.
  `tools/yaml/compare.ts`: vscode's 770 `.yml/.yaml` identical to `bench/vscode-fmt` (extensions/copilot with its package.json config; the 3 files Bun refuses
  stay as they are). `tools/yaml/diff.ts` (node, `bun fmt` as oracle, mutants of corpus + Prettier fixtures + vscode): 12 option sets (width, proseWrap, quotes,
  tabs, bracketSpacing, trailingComma, insertPragma, requirePragma, range, CRLF, oxfmt flavor x3): ~650k cases, 0 differences.
- **Throughput** (compiled, scriptc 0.3.0, M5 Pro under load, best of 100, vscode's 770 YAML files, 1.83 MB, parse + format, single thread):
  **~80 MB/s (22.9 ms)**; node ~48 MB/s. Phases (`tools/yaml/bench.ts`): parse 4.5 ms, tree 7.4, printer writes 8.1, `doc.ts` printer 3.9. For reference
  `bun fmt --check --threads=1` on the same files costs ~18 ms user CPU per pass including walking and reading, so we are about 1.3x slower than Bun, not equal.
  What was learnt: a node as one 32-int record (not 27 arrays) halved the tree build; a typed array bound to a local in a *small* function costs a retain +
  release (`newNode`, `setStart`, ...: use `T.d[..]` directly); `newNode` stores only what is read (lists have a length); flags `F_HAS_COMMENTS/F_HAS_PROPS`
  make `isBare` one load; columns are computed on demand (`columnOf`), lines by a galloping search from the last one. Left: `Elements`/`Printer` of `css/doc.ts`
  are ~25% of the time and not ours; the parse is 20%.
- **Residual**: nesting past ~1000 (the parser's budget `yamlSetMaxDepth`) is "nested too deeply" here, Bun formats up to ~5000; the driver prints the excerpt
  `2 | ` for an error at the end of the file where Bun prints none (driver, not yaml). Fixed on the way: `writeText` fell back to `out.text` (a bulk
  rewrite made it call itself; now it does not).

## src/format/css: CSS, SCSS, Less (done, correct; speed below Bun's)

- **What**: all of `vendor/bun/src/format/css/` in `src/format/css/`, file for file: `doc.ts` + `sink.ts` + `memo.ts` (API for the other formatters: `docs/CSS_DOC_API.md`),
  `postcss.ts` (tokenizer + parser of postcss / postcss-scss / postcss-less), `selector_parser.ts`, `value_parser.ts`, `media_query.ts`, `parse.ts` (`convert`),
  `printer.ts`, `value_groups.ts`, `misc.ts`, `mod.ts` (`format(text, parser, options, out)`, `formatWith(.., scratch, out)`, `document(text, parser, options)` = Prettier's
  `textToDoc` returning a `Doc` handle or `-FORMAT_*`, `parserForPath`), `embed.ts` (placeholders, the Doc -> IR writer `writeDocument` for html, `printEmbedCss`;
  the JS-handle half -- `is_embed_css`, `is_styled_tag`, `write_template`, `has_embed_label`, ... -- is TODO for the JS formatter), `src/format/tailwind.ts` (STUB: `@apply`
  classes are left as they are; needs the class orders from the driver). Wired into `src/driver/dispatch.ts` (`cssFormat`) and `src/format/conformance/dispatch.ts` (`runCss`).
- **Data layout**: text ranges in one `ByteBuf` (style sheet, `postcss-less` extra strings, and above them an arena that `convert` cuts back); postcss nodes SoA in `Tree.f`
  (49 Int32 per node); selectors / values as SoA arenas reused per node; tokens as Int32 records; units (`startUnit/endUnit`) written out instead of closures; the
  scope of Rust's `Scope`/`Statement` is a depth index.
- **Tests**: `tools/css/compare.ts`: vscode 522 files vs `bench/vscode-fmt`: 516 identical + 6 refused exactly as bun (0 differ). Prettier fixtures
  (`node tools/conformance.ts prettier --languages=css,less,scss`): css 161/162 (the one is the cursor case, `cursorInFormattedText` of the driver hook), less 238/238, scss 136/136,
  CRLF/CR/BOM all pass; oxfmt flavor: the 88 failing css/less/scss checks are exactly those of `oxfmt/expected.txt`. `tools/css/fuzz.ts`: ~30k mutants of the fixtures and
  vscode against `bun fmt` (output, refusal, and the words and line:col of every refusal): 0 differences. `tools/css/doc-fuzz.ts`: 50k random documents of `doc.ts` vs Prettier's
  `printDocToString`: only Rust's own deviations (listed in CSS_DOC_API.md). `src/format/css/doc.test.ts` (22 checks, node and compiled).
- **Throughput** (scriptc 0.3.0, M5 Pro under load from other agents, so +-10 %; vscode .css/.scss/.less: 522 files, 3.11 MB, best of 100, `tools/css/perf.sh`): compiled
  **~67 MB/s** (46 ms), in a program that imports `Worker` (the real binary) **~50 MB/s** (62 ms); node 52 MB/s. `bun fmt --check --threads=1` on the same files takes ~0.03 s of CPU, i.e.
  >100 MB/s: **the target is not reached** (about 2x short). Parse alone (postcss) is 13 ms, tokenizer alone 5.8 ms (534 MB/s). Profile (`sample`, self time): runtime
  retain/release/TLV ~15 %, `postcss` 25 %, misc/text helpers 12 %, selectors 10 %, css printer 9 %, memo 4.5 %, doc printer 4 %. Done: no tables or closures on hot paths
  (bit-mask predicates in `charsets.ts`), cheaper memo hash, fewer allocations. Ideas not done: shrink `Tree.f` (aliasing columns per node kind), memoize rule heads like
  declarations, avoid typed-array arguments in small helpers (retain/release), `Buffer`-based copies in `ByteBuf.append`.
- **scriptc learnt**: `Int8Array` is not supported (SC1090 on indexing: use Int32Array); `ids[i]` of a `number[]` must be `| 0` before it is used as a key; `void Worker` does not
  compile (use it in a dead branch to emulate the worker codegen tax, `tools/css/bench-w.ts`: -20 %); a `*/` inside a `/** */` comment ends it (regex in comments!).
- Compiled with `SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-css` (bench: ~10 s cold).

## src/driver floor: pipeline walk -> format, `FMT_FAKE_WORK`, tools/driver-perf (done)

- **What changed.** Before: walk everything (rounds of scan workers), sort by size, spawn workers, format, print. Now (one directory/pattern argument, no
  `--staged/--changed`, not oxfmt): the main thread walks (breadth first, `scan.ts` `threads <= 1` branch, or 2 walkers from `--threads=12`) and hands every
  file to the format workers *as its directory is done*. Queue = `src/driver/pipe.ts`: SharedArrayBuffers used the way the cookbook allows (control words with
  `Atomics`; path bytes, 4-int meta rows and one status byte per file moved only with bulk `Buffer.copy` / `set(subarray)`); the producer commits batches, workers
  claim with compare-exchange (big lane first, then the normal lane), sleep in `Atomics.wait` on an event word (notified only when someone sleeps). Option sets are
  sent as text (`encodeSet`/`decodeSet`, escaped) before the first file that names them. `pool.ts` spawns workers while the backlog grows (a worker per
  `FMT_SPAWN`=128 queued files; with little to do few workers keep the kernel free for the walk). Workers report only the files that need words (errors,
  syntax problems); unchanged/different is one byte in the shared status array; `run.ts` folds both back into Bun's order (`expanded`), so output is unchanged.
  Not pipelined (legacy order, same workers): named files, several arguments, `--staged/--changed`, oxfmt, `--list-files`, `--dump-options`. Files are written (no
  `--check`) only once the search has succeeded (gate), so a configuration error found mid-walk still stops everything before any write.
  `worker.ts`: `open + one read + close` (no `fstat`, no second read: a short read is the end), scratch reused; `FMT_FAKE_WORK=<ns/byte>` runs a calibrated
  imul/xor chain over the file before the formatter (the stand-in load; 9 = Bun's ~110 MB/s per core). Also: `FMT_PIPELINE=0` (old order), `FMT_SIZES=1` (lstat
  every file while walking so that files >= `FMT_BIG`=256 KB go first; off by default: it costs ~40 ms of the walker and the biggest file here starts early anyway),
  `FMT_SCAN_THREADS`, `FMT_SPAWN`, `FMT_CHUNK`, `FMT_MAIN_WORKS=1` (main thread formats after the walk: no gain), `FMT_TRACE=1` (walk end, backlog, per-worker busy).
- **Checked**: `node tools/difftest.ts` 380/0 and `node tools/optiontest.ts` 620/0 (compiled stub build and node), outputs of legacy vs new identical on `--check`,
  `-l`, `--write` (+ resulting files), `--debug-check`, unreadable file, bad config mid-walk (nothing written), `--compare-to`; with the real formatters wired the
  vscode `--check` output is byte-identical at 1/8/18 threads and with `FMT_PIPELINE=0`.
- **Measured** (`tools/driver-perf/table.sh`; M5 Pro 18 cores, shared with other agents, min of 8 runs, `--check`, bench/vscode, identity formatters via
  `tools/driver-perf/build.sh`; legacy = `tools/driver-perf/legacy/make.py`; "load9" = `FMT_FAKE_WORK=9`):

  | threads | legacy no-load | new no-load | legacy load9 | new load9 | Bun (real formatting) |
  |---|---|---|---|---|---|
  | 1 | 537 | 312 (walker + 1 worker = 2 threads) | 2750 | 2366 | 2387 |
  | 8 | 287 | 255 | 514 | 398 | 436 |
  | 18 | 275 | 285 | 363 | 318 | 312 |

  Phases at 8 threads, load9 (`FMT_TRACE`): legacy = ~105 ms find + ~410 ms format; new = walk ends at ~300-340 ms with 2-6k files still queued, workers busy ~100%
  all along, 50-80 ms to drain. At 18 threads: walk ends ~200-230 ms, drain ~75 ms.
- **What remains (profile, `tools/driver-perf/xctrace-threads.py`).** Kernel `open`: opening a file costs ~8 us even for the same file again and ~11 us for new ones
  (lstat 1.7 us, access 1 us), and throughput saturates at ~100k opens/s from ~4 threads on (1 thread 280-350 ms for the 18k files, 8 threads 170, 18 threads 150), in
  node as well: a per-open serialization in the kernel (security hooks?), the same for Bun. So the corpus has a floor of (18,080 file opens + 4,604 directory opens) /
  ~100k/s = ~230 ms whatever the thread count; Bun sits on it too (find 47 + format 238 at 18 threads). Per worker at 8 threads/load9: 65% formatting stand-in, 30% `open`
  (threads spin in it while the others hold the lock), 2% `pread`; the walker: 55% `open` of directories (36 us each while workers open files, 12 us alone), 8% `getdirentries`,
  the rest is ours (glob/ignore tests, option sets, queue) ~10%. Tried without gain: limiting concurrent opens with a semaphore (worse, sleeping threads are not replaced),
  decoupled reader threads feeding formatter threads (node model: 5-10% at 18 threads, not worth the copy + ring), `O_NOFOLLOW`/`O_EVTONLY`/`O_NONBLOCK`, relative instead
  of absolute paths, shuffled file order, the main thread formatting too, fewer/more claim chunks. The no-load case at 18 threads is slightly worse than before (walk
  slowed by the workers' opens; `FMT_SCAN_THREADS=1` gives 253): with real formatters the stand-in load is the case that matters.
- **scriptc learnings** (add to the cookbook): (1) a class field of type `SharedArrayBuffer` is "an 'unknown'-typed class field" (SC1090); an *interface* that has only
  SharedArrayBuffer fields is too, as a field or array element type; adding one `number` field (`version`) makes `PipeBufs[]` work. (2) `Buffer.from(sab)`, `buf.write(str, off)`,
  `stage.copy(sabBuf, off, a, b)`, `sabInt32.set(priv.subarray(..), off)`, `priv.set(sabInt32.subarray(..))`, `sabBuf.toString("utf8", a, b)`, `Atomics.compareExchange/wait(timeout)/notify`
  all compile and work in workers and on the main thread; a 1.3 GB lazily committed SAB set costs 1.2 ms. (3) A shared status byte per file written with `set(subarray)` per claimed chunk
  is cheap; the profile shows `__psynch_mutexwait` only from the scriptc runtime lock around the first shared accesses. (4) `import type` for interfaces from other modules.
- Tools: `tools/driver-perf/{stubify.ts,build.sh,bench.ts,table.sh,xctrace-threads.py,legacy/}`. `bench.ts` alternates variants (the machine is shared; min and median).

## js-core skeleton ready (src/format/js core + skeleton of print/** and utils/**; contract: docs/JS_FORMAT_API.md)

- **The JS/TS formatter runs end to end** under node and compiled (`SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-jscore scriptc build src/main.ts -o /tmp/fmt-jscore`, 22 s cold).
  Today every node that a `print/` or `utils/` function writes is written **as it is in the source** (`// TODO(port)` in the body), so
  the output is the input with `program.ts`'s line structure; the comment machinery, parentheses, `prettier-ignore`, type casts, siblings, the
  `AstNodes` view and range formatting are the real ports. Replace the body of the function you own; the signatures are the agreement.
- **Docs**: `docs/JS_FORMAT_API.md` (naming `fmtX` / `writeX`, `AstNodes` as an Int32 `AN_*`, comments as ranges `[cm.from, cm.to)`, `(wk, h)` for
  `Format + Spanned`, `formatNode(.., pk, ph, wk, wh, f)` for the closures of `format_node`, worked examples, scriptc pitfalls: **no `import * as` and no
  module-level `let` in modules of an import cycle**, named imports only).
- **Test it**:
  - one file: `node --stack-size=7000 src/main.ts --stdin-filepath=a.ts < a.ts` (the compiled `bin/fmt` the same);
  - conformance: `node --stack-size=7000 tools/conformance.ts prettier --languages=js,jsx,typescript [--filter=js/arrow] [--report=/tmp/r]`
    (skeleton: js 250/1357, jsx 14/186, typescript 131/756 `format`; all checks 44.6%, the identity-ish baseline);
  - vscode: `node --stack-size=7000 tools/js/compare.ts [--filter=src/vs/base] [--limit=500] [--top=60] [--samples=2]` (per extension counts + a
    histogram of the shape of the first differing line; `--file=<rel> --diff` prints a unified diff, ours `-`, the oracle `+`; options per file are
    the driver's, via `--dump-options`);
  - core invariants over all 14,886 parsed files of vscode (17 M nodes, 215 k comments): `node --stack-size=7000 tools/js/core-check.ts` (the parent chain of every
    `AstNodes` ends at `Program`, spans inside the file, `followingSpanStartIn` sane, comments sorted, **every comment printed exactly once**): 0 problems;
  - vscode, compiled, all files: `cd bench/vscode && /tmp/fmt-jscore --check --compare-to=../vscode-fmt [--compare-list]`
    (skeleton: .ts 519/14,359, .tsx 4/270, .js 23/133; 1 s for all of it).
- **Hooks left for others** (all marked `TODO(port)`): `src/format/cursor.ts` (stub: no cursor), `sort_imports::sorted_text` and `refusal_of_prettier`
  in `src/format/js/script.ts`, flow (`print/flow.ts` answers "not flow"), `jsdoc/mod.ts` (oxfmt option, returns false), tailwind (stubs answer "no
  context"), `print/program.ts` (`ImportRun`, `write_more_trailing_comments`), HTML `parse_javascript`. A JS code block inside a Markdown or HTML template
  inside a JS template re-enters the formatter while it formats (the HIR is global): not handled.

- (js-core, later) **Core status**: `comments.rs` (collect, `move_comments` with `attach_in_link` / `attach_between_sides_of_assignment` / `moved_over_parenthesis`,
  the whole `Comments` cursor), `trivia.rs`, `format.rs` (statements, expressions with type casts and `prettier-ignore`, types, annotations, the `WK_*` pairs),
  `ast_nodes.rs` (162 `AN_*` variants as Int32), `siblings.rs`, `fields.rs`, `builders.rs`, `context.rs`, `parentheses/*`, `utils/{operators,suppressed,typecast,expression,
  format_node_without_trailing_comments,typescript,mod,es5_identifier_tables}`, `range.rs` (range formatting; selects the same statements as Prettier on `js/range`) are
  ported; not yet exercised by real printers beyond statements as written (the six print agents will): report core bugs to js-core. Not ported: `cursor.rs` (stub),
  `jsdoc/**`, `sort_imports/**`, `tailwindcss.rs` bodies, `print/program.rs` `ImportRun`. The stack budget is 1000 doors; the deepest file of vscode needs 103.
  Compiled build: 22 s cold, skeleton throughput 1 s for all of bench/vscode (16 threads), identical output under node.

## parser part C: recovery, summarize, Flow, and the syntax checks of `bun fmt` (done)

What decides whether `bun fmt` takes a script file, and what it says when it does not, is ported and agrees with `~/.bun/bin/bun fmt` on accept/reject, message and line:col.

- **Entry point for the formatter** (`src/sema/parser/script.ts`): `parseScript(src, len, path, name, isFlow, goesToBabel, typesTolerated)` is `with_file` over
  `kinds(name)` plus the refusal at the head of `print` (`refusal_of_prettier`). `PS_OK`: the file is in `hir` **and bound** (`fileBegin` was called inside:
  do not call it again). `PS_SYNTAX`: `scriptError.message` at `scriptError.at` (a byte offset **in `scriptText.src[0, scriptText.len)`**, -1: whole file).
  For a formatter that tries format() per kind (as `formatScript` in `src/format/js/script.ts` does) use the pieces: `prepareScriptText(..)` once, then
  `parseAttempt(isScript, path, isFlow, goesToBabel, typesTolerated)` per attempt, `scriptKinds(name)` (1 module, 2 script), and format `scriptText` (not the
  input: for `babel-flow` it is `flow::uncommented` of it). `goesToFlow` is in `src/lint/linter/syntax/mod.ts` (lint-ast agent); `goesToBabel(parser, name)`,
  `mayHaveCommentTypes`, `uncommented` (private) are in script.ts. **js-core: `src/format/js/script.ts` still calls `parseFile`; swap it for `parseAttempt`
  (the message for the driver is `scriptError.message`, not "Unexpected token") and take `is_flow` from `goesToFlow(text, name) || --parser flow|babel-flow
  || .js.flow`.** Range formatting's `reparse` needs the same dialect.
- **Pieces**: `src/sema/parser/summarize.ts` (`readFile`: strict parse, recovering parse for what is refused except Flow, `error_before_refusal`, fallback
  1128 at the refusal), `parser/recover.ts` (+ the leaf entry points in `parser/mod.ts`: lists, `isAtElement`, diagnostics with message arguments),
  `src/sema/parser/syntax/{mod,error,in_tree,typescript_estree,order,espree}.ts` (`refusal_of_prettier`: typescript-estree checks, then babel/espree checks with
  the `REFUSED_BY_BABEL` filter and acorn's "noticed" positions), `parser/flow.ts` (all of flow.rs: types, declarations, components, hooks, records, `match`,
  comment-type handling excepted) and the `p.isFlow` branches at the 35 `TODO(flow)` sites (all gone). HIR change: a diagnostic row has a 5th column `argsId`
  into `hir.diagArgs: string[][]` (`pushDiagnosticArgs`), messages are formatted by `src/sema/messages.ts` (`diagnosticMessage(code, args)`, generated by
  `tools/gen-messages.ts`).
- **Not ported**: `jsdoc.rs`/`reparse.rs` (the fmt path needs neither), `oxc.rs`/`declared.rs` (oxfmt flavor only; `TODO(oxc)`/`TODO(jsdoc)` comments stay), and
  14 `TODO(recover)` sites that only matter for messages of rare recovery paths (`grep -rn "TODO(recover)" src/sema`): all fixtures and mutants agree without them.
- **Tests** (`tools/parser-c/`): `oracle.ts` (bun: `bun tools/parser-c/oracle.ts <dir> out.json [--parser=flow|babel-flow]`), `errors.ts`
  (`node tools/parser-c/errors.ts <dir> out.json [--parser flow|babel-flow] [--show N] [--summary]`: accept/reject, message, line:col), `mutate.ts` (token-level
  mutants), `vscode.ts` (compiled; `--bun FILE` agreement on the refused vscode files, `--flow flow|babel-flow` to parse a list as Flow).
  Results, all **0 disagreements**: Prettier fixtures 3,763 files (1,269 rejected, same message and line:col); the same corpora as `--parser=flow` and
  `babel-flow` (flow 1,469, js 1,162, jsx 85, typescript 1,001, misc 46); mutants: js 6,000, jsx 1,500, ts 6,000, vscode 8,000, flow 20,000 (flow and
  babel-flow) + 6,000 (default dialect); the 25 files of vscode that bun refuses (and 14,861 accepted). The compiled build agrees with bun on accept/reject on
  the same mutant sets (`/tmp/pc-cmp.sh` style: `vscode.ts --out`).
- **Speed** (compiled, bench/vscode 198 MB, 14,886 files, machine loaded): parser only (`tools/parse-vscode.ts`) 217 MB/s now vs 219 before parser-C; through
  `parseScript` (strict parse + refusal checks + `fileBegin`) 160-166 MB/s. The Flow branches cost one boolean load.
- **Found on the way**: (1) compiled scriptc hung in `octalOf` (`string.slice(from)` inside a loop over a flagged `01` / `"\1"`); rewritten with indexes — compiled-only
  bugs do not show under node, so run the compiled harness too. (2) `src/driver/problem.ts` `problemAt`: parser offsets include a BOM, `File::position` does
  not: pass `at - 3` for a file that starts with EF BB BF (the harness does).

## js-stmt: print/{statements, program, block_statement, switch_statement, try_statement, return_or_throw_statement, semicolon, variable_declaration, export_declarations, import_declaration, decorators}, utils/{statement_body, suppressed, format_node_without_trailing_comments}

- **Ported, exactly (branch for branch, Prettier and oxfmt flavours)**: every statement (`if`/`else` with comments, `for`/`for-in`/`for-of`/`while`/`do`/`with` with `FormatCondition`/`Head`/`FormatInHead`, labels, `break`/`continue`),
  `FormatStatements` (`write_more_trailing_comments`, `comment_placements`, `;` before a type cast comment, `ImportRun` hooks of `sort_imports/oxfmt/run.ts`), blocks (the catch-clause comment cache), `switch`/`case`,
  `try`/`catch`/`finally`, `return`/`throw` (`FormatAdjacentArgument`, `has_argument_leading_comments`, the oxfmt `;`-behind comments), variable declarations, import/export (specifiers with their comments,
  `with { type: "json" }`, `export *`, `export default`, decorators before/after `export`), decorators, `FormatStatementBody`. `semicolon.ts`' oxfmt functions (`start_of_comments_*`) are ported too.
  `suppressed.ts` and `format_node_without_trailing_comments.ts` were already right (js-core); `enter_node`/`extend_node` are wired in `export_declarations.ts`.
- **Numbers (node, main tree, `--languages=js,jsx,typescript`, `format`)**: js/if 12/12, switch 6/6, try 3/3, label 3/3, empty-statement 2/2, directives 44/44, export 69/69, export-default 51/51, import 48/48,
  import-assertions 13/13, import-attributes 17/17, decorators 20/20, decorators-export 2/2, for 14/14, while 1/1, return 3/3, throw_statement 3/3, no-semi 34/36, comments 151/152;
  typescript/decorators 20/21, export 8/8, import 14/14, import-type 9/9, declare 13/13. vscode (`tools/js/compare.ts`): 14,858/14,886 match, the 3 mismatches and 25 errors are not statements.
  The 2 `no-semi` failures are the js-core issue below; the others left are an html-like comment (`<!--`), the Angular template embed, and `tools/js/compare.ts` errors (FORMAT_NESTED_TOO_DEEPLY under node).
- Oracle checks beyond the fixtures: ~250 lines of statements/comments/import/export snippets (`bun fmt` against ours, both Prettier flavour and `.oxfmtrc.json`) are byte-identical.
- **Hooks**: nothing per node allocates: placements of comments are a module-level `I32Vec` (`PLACEMENTS` in statements.ts), decorators are walked by index over the modifier list.

### js-core issues
- `ast_nodes.ts` `innerOfStmt`: `case STMT_BLOCK` returns `AN_BLOCK_STATEMENT` for a `with` statement too. It must be
  `return stmtIsWith(s) ? mkAn(AN_WITH_STATEMENT, s) : mkAn(AN_BLOCK_STATEMENT, s);`. Without it `spanForComments` never takes the `AN_WITH_STATEMENT` arm (the `;` of the body is not stripped), so
  `js/no-semi/with-statement.js` (2 fixtures: with `semi=false` and default) fail (`with (1)⏎  foo` and a comment before the `;` indented). Checked by patching a copy: both pass. I worked around the
  parts that are mine (`isHeadOfStatement` in statements.ts also takes a `with` as `AN_BLOCK_STATEMENT`).

### signature issues
- Flow `match (x) {}` (`print/flow.rs::write_match_statement`) is not called from `writeSwitchStatement` (flow.ts has no such function): a `TODO(port)` there. `import_kind` (`type `/`typeof `) is implemented in import_declaration.ts as `importKindToken`, because flow.ts' `importKind` returns a string.
- `import_declaration.ts` also exports `writeSpecifiers(statement, start, len, isExport, f)` and `fmtCommentsInSpecifier(spanEnd, f)`, `statements.ts` exports `commentPlacements(from, to, followingStart, f)` (result in `PLACEMENTS`) and `commentPlacementLeads`.

### Open
- `options.sortImports` is not set by the driver yet (`driver/dispatch.ts` TODO), so `ImportRun` could not be tested end to end; the hooks are called exactly where Rust calls them.
- scriptc: my files had no SC diagnostics in the last build. Importing `sort_imports/oxfmt/run.ts` (needed by `FormatStatements`) puts its classes (`Orphan`, `Unit`, `Line`, `Written`) into the import cycle: SC1016 on them (js-sort's file), like `JsFormatContext`, `cursor.ts`' classes, template.ts, experimental_ternary.ts, string.ts' `INFO_*`.

## js-core: parser-C integrated (`src/format/js/script.ts`)

- `formatScript` now does `prepareScriptText` once and `parseAttempt` per kind of `scriptKinds(name)` (PS_OK = already bound, no second `fileBegin`), formats `scriptText`
  (the uncommented text for `babel-flow`). `is_flow` = `--parser flow|babel-flow`, or (`babel`/no parser, not oxfmt) `goesToFlow(text, name)` or `.js.flow`; `goesToBabel(parser, path)`;
  `typesTolerated` = parser in flow/babel-flow/typescript/babel-ts. The error is `scriptErrorMessage()` / `scriptErrorOffset()` (offset without a BOM, as `Problem::at` counts);
  after a FORMAT syntax error of the printer the first diagnostic's message and start are used (`syntax_error(file, first_error)`). Range `reparse` reads the slice with the same dialect
  (no refusal, like `with_file`).
- `src/driver/dispatch.ts`: `failSyntax(scriptErrorMessage(), scriptErrorOffset(), true)`. `src/driver/problem.ts` `printProblem`: like `Data::write_format` the shown line loses its
  trailing ` \r\n\t` and a line that is then empty has no code frame (the `at file:line:col` line stays) -- this was the only difference left on the vscode files.
- Verified (node): the 25 refused vscode files print byte-identical to `~/.bun/bin/bun fmt --check` (stdout+stderr), and two BOM files with a syntax error (`.ts`, `.js`) too.
  `node tools/conformance.ts prettier --languages=js,jsx,typescript,flow`: rejected js 165/165, jsx 19/19, typescript 355/355, flow 19/22 (= Bun); format 3169/3804, all checks 96.08%.
- **Compiled build is red right now** (not from this change): SC1016 in `src/format/cursor.ts` (classes Item/Region/Located/Extent/Offset: cursor.ts is in an import cycle through
  format.ts -> cursor.ts -> print/binary_like_expression.ts), `print/template.ts` (EachTable, EachCell, JsGqlTemplate classes) and `utils/experimental_ternary.ts` (OC_* consts).
  Fixed on my side: `js/context.ts` no longer imports cursor.ts (`newContext(options, noCursor)`, `reset(options, text, cursor)`), `TrimInfo` moved to `js/state.ts`.
  Rule: a class or `const` that a module in a cycle declares must not be used by that module's functions -- put it in a leaf module with no imports of print/ or format.ts.

- (js-types) **TS types, TS declarations, type parameters/arguments, JSX: ported** (`print/{ts_types,ts_declarations,type_parameters,union_type,intersection_type,tuple_type,mapped_type,function_type}.ts`,
  `print/jsx/{mod,element,opening_element,child_list}.ts`, `utils/jsx.ts`; `utils/typescript.ts` was already the real port). Branch for branch, both flavors (Prettier and oxfmt).
  - Numbers (node, with the other agents' state at the time): prettier `typescript` format **747/756** (all checks 99%), `jsx` **184/186**, `js` 1339/1357; vscode `tools/js/compare.ts`: **14858/14886 files**
    (3 mismatches, 25 syntax-error files that the oracle refuses too). Left in typescript: 6 HTML-in-template (`html/embed`), `as/as-const-embedded` (embed), `tsx/comma` snippet without a name (see js-core issues).
    Left in jsx: `cursor/before-first-jsx-text` (cursor.rs stub), `jsx-test-suite/snippet: 0006` (`<!--` comment, core). The scriptc build stops only at `utils/experimental_ternary.ts` (SC1016, js-binary); nothing from these files.
  - Design notes: JSX children (`child_list.ts`) are formatted once, in source order, into captures (pass 1); the fill/entries of the multiline layout and the flat layout are written from the parts afterwards
    (pass 2) as two captures; the result is in `childrenResult` (copy at once: nested elements overwrite it). `ITEMS`/`PARTS` are module vectors with a base per call (nested elements). The union (`union_type.ts`) has
    `MB` for `comments_before_member`; `ts_types.ts` has `qnames` (`typeof a.b.c`). `type_parameters.ts`: `typeParameters(.., groupId, isTypeOrInterfaceDecl)` + `typeParametersWithoutComments`.
  - New exports others may use: `ts_types.ts`: `fmtStringLiteralOf(start, end, parent, f)` (`FormatStringLiteral`), `fmtModuleSpecifier(start, end, parent, callStart, callEnd, f)` (signature changed: no caller),
    `writeIdentifierWithoutTrailingComments(atom, pos, start, end, parent, f)`, `commentsAfterPropertyName(ty, f)` (count; range `cm.from/to`); `jsx/mod.ts`: `fmtJsxName`, `writeJsxClosingElement`, `writeJsxFragmentTag`.
  - Not ported on purpose: `around_node`/`extend_node`/`around_jsx_children` (cursor.rs is a stub: add where `// cursor` would go), tailwind in `jsx/mod.ts` uses `contextOfAttribute` (stub answers -1).
  ### js-core issues
  - `f.filepath()` (options.filepath, else the path the file was parsed under) has no TS equivalent: `shouldForceTrailingCommaForArrowFunction` (`<T,>() => {}` unless the path ends in `.ts`) uses `options.filepath` and, if it is empty,
    `hir.kind === FK_TSX` (so `.mts`/`.cts` without `options.filepath` and the unnamed snippet of `typescript/tsx/comma` differ). A `jsState.path` set by `formatScript` would fix it.
  - A comment inside a function body whose parameter list is one parameter with a type annotation (`function f(a: string) { // c ⏎ return 1 }`) leaves the comment cursor in a state where later nodes of the file see an
    unprinted comment behind them (`hasCommentBefore` true): the next `function g(ctor: { new(): T })` does not hug its object parameter (3 vscode mismatches: `editorExtensions.ts:533`, `editorFeatures.ts:26`,
    `localTranscriptionService.ts:94`). Not in the files above; minimal repro: `function f(a: string) {⏎ // c⏎ return 1;⏎}⏎export function g<T>(ctor: { new(): T }): T {}`.
  ### signature issues
  - `print/flow.ts`: `predicatePrefix(ty)` returns a string; ts_types.ts maps `"implies "` to its own token and everything else to `"asserts "`.

## js-call: functions, arrows, parameters, calls, arguments, classes, member chains (done)

- **Ported (branch for branch, flavor-aware incl. oxfmt arms)**: `print/{function, arrow_function_expression, parameters, class, call_like_expression/{mod, arguments}}.ts`,
  `utils/{call_expression, member_chain/{mod, chain_member, groups, simple_argument}}.ts`. Captures: `arguments` (formatted-ahead arguments in the `av` stack,
  `startVariant`/`bestFitting2/3`, `removeSoftLinesOfCachedElement`), `member_chain` (links = ints `kind << 26 | expr` in the `mv` stack, groups captured then
  `bestFitting2`, `LABEL_MEMBER_CHAIN`), `FormatContentWithCacheMode` = `cacheBegin/cacheEnd` (function.ts) over `cx.getCachedElement/cacheElement`.
- **Results**: conformance (js,jsx,typescript, all of it) 2265/2299 `format`, 11365/11399 all checks; my directories: js/arrows 51/51, arrow-call 6/6, functional-composition 13/13,
  function* 24/24, method-chain 35/35, break-calls 4/4, call* 13/13, classes* 43/43 + class-* 8/8, async 10/10, generator 3/3, new-expression 4/4, preserve-line 4/4,
  test-declarations 16/16, last-argument-expansion 17/18 (embed), typescript/class* 25/25, method* 15/15, arrow 15/19 (the 4: `<T,>` see below).
  vscode: `tools/js/compare.ts` 14861/14886 match, 0 mismatches (the 25 are syntax-error files); compiled (`/tmp/fmt-jscall`): every .ts/.js/.tsx file matches (only the 105 .html differ), ~1.3 s for the corpus.
- **Not ported / hooks**: `css|graphql|markdown::embed::has_embed_label` and `html::in_js::label` are stubs in `call_like_expression/arguments.ts` (`hasEmbedLabelOfOtherThanHtml`, `htmlInJsLabel`,
  both answer "no": the failing `last-argument-expansion/embed.js`, `template-literals/expression-break.js`, `multiparser-*` cases need them; the embed owner replaces the two bodies).
  `isMultilineTemplateStartingOnSameLine(expression, f)` got an `f` parameter (only `arguments.ts` calls it). `shouldGroupFunctionParameters(func, retHandle, f)` takes the capture of the return type
  (callers capture it before). `commentsBetween/commentIsBetween/hasCommentsBetween` (parameters.ts) are `comments_between(span)`.
- ### js-core issues
  - conformance runner: the `filepath` option is not `.ts` for typescript fixtures, so `shouldForceTrailingCommaForArrowFunction` (type_parameters.ts) prints `<T,>() =>` (typescript/arrow/16067.ts,
    arrows/type_params.ts, compiler/contextualSignatureInstantiation2.ts, type-parameters-arguments/const.ts); via the CLI (`--stdin-filepath=a.ts`) it is right.
  - scriptc: a `const X: number = 0` used as an index of a typed array (`G[X] = ..`) in a module of an import cycle is SC1016 ("resolved from its type"): use literals (class.ts), or
    the same error appears in `utils/experimental_ternary.ts` (`OC_*`, js-binary) and `utils/string.ts` (`INFO_*`), `cursor.ts`, `context.ts`, `print/template.ts` at the time of writing.

## js-core: `filepath` accessor, vscode status

- `filepathOf(f.options.filepath)` in `src/format/js/state.ts` = Rust `f.filepath()` (options' filepath, else the path the file was parsed under: `jsState.path`, set by `formatScript`).
  `print/type_parameters.ts` `shouldForceTrailingCommaForArrowFunction` uses it (`!endsWith(".ts")`): `<T,>` for `.mts`/`.cts`/`.tsx`/unnamed now equals `bun fmt --stdin-filepath`.
- The 3 vscode mismatches (`editorExtensions.ts`, `editorFeatures.ts`, `localTranscriptionService.ts`) and the minimal repro no longer reproduce on the current tree:
  `node tools/js/compare.ts` = 14,861/14,886 match, 0 mismatch, 25 refused files (the 25 `bun fmt --check` refuses too; they print identically). Nothing to apply for js-call.

## js-binary: print/binary_like_expression, utils/{assignment_like, conditional, experimental_ternary} (full ports)

- **Ported**: all four files, branch for branch (Prettier flavor and oxfmt flavor branches, Angular pipe / Vue filter, JSX tail of a logical chain, type-cast
  parentheses, `experimentalOperatorPosition`, `experimentalTernaries`, JSX conditional chains). `BinaryLikeExpression` is the ExprId; the operands of a chain
  are pairs on a module-level `I32Vec` (`parts`), no allocation per node. `AssignmentLike::X(h)` is `fmtAssignmentLike(ASSIGNMENT_LIKE_*, h, f)`, all layouts
  (fluid, break-after-operator, never-break, chain, chain-tail(-arrow), break-lhs), `isShortArgument`, `isComplexTypeAnnotation`, `isPoorlyBreakableMemberOrCallChain`,
  computed-key widths. `ConditionalLike::X(h)` is `fmtConditionalLike(CONDITIONAL_LIKE_*, h, f)`; `writeTernary` / `shouldBreak` are the experimental ones.
- **Exports added** (for others): `shouldInlineLogicalExpression(e, f)` (binary_like_expression.ts), `shouldExtraIndent(e)` and `operandIsConditional` (conditional.ts).
- **Numbers** (Prettier fixtures, all of js/jsx/typescript with Bun's options): js/binary* 42/42, js/logical 7/7, js/nullish 1/1, js/assignment* 38/38, js/ternaries 66/66,
  js/conditional 13/14 (the failure is a JSX attribute in new-ternary-spec, not mine), typescript/assignment 14/14, typescript/ternaries 1/1, typescript/conditional-types 12/12,
  js/break-calls/reduce 100%. Whole js/jsx/ts run: 2265/2299 format; none of the 34 failures is in these files (embeds, `<T,>` arrow type params, with-statement, cursor).
  oxfmt fixtures: every FAIL in js/ts that is not jsdoc/embed/tailwind/sort-imports is also in Bun's own expected.txt (except js/unicode/katakana-middle-dot, not mine).
- **vscode** (node, tools/js/compare.ts): 14,763/14,886 (99.17%); the 98 mismatches seen are `<T,>` vs `<T>` on arrow type parameters and two function-signature breaks (js-call/js-types).
  Compiled `/tmp/fmt-jsbin` builds and gives the same output as node on my test files; `--check` of bench/vscode runs in 1.1 s.
- **scriptc**: in modules of an import cycle a module-level numeric constant that is used from a function must not be a plain `const X = 3` (SC1016 "resolved from its type");
  `OC_*` offsets in experimental_ternary.ts are literals now.
- ### js-core issues / signature issues
  - `string.ts` has no `cleanText` helper: `isShortArgument` for a string literal measures `fmtLiteralStringToken` through a capture when the literal has a quote, a
    backslash or a `\r` (fast path: the raw length). A `cleanTextWidth(start, end, f)` in utils/string.ts would be cheaper.

## js-expr: print/{expressions, literals, member_expression, sequence_expression, array_expression, array_element_list, object_like, object_pattern_like, patterns, as_or_satisfies_expression, template} + utils/{string, number, object, array} (done)

- **What**: full ports of the Rust (`utils/{operators,typecast,expression,es5_identifier_tables}.ts` were already exact from js-core). `utils/string.ts`: `fmtLiteralStringToken`,
  `cleanStringLiteralText(start, end, jsx, parentKind, f)` (false: the text is the literal as written; else it is `CLEAN.data[0..CLEAN.len)`; `cleanedStringLiteralWidth`),
  `isEs5IdentifierName`, `isNameWithoutQuotes`, `isSimpleNumber`, `isCanonicalSimpleNumber`. `utils/number.ts`: `trimmedNumber`/`numBuf`, `formatTrimmedNumber(.., out)`, `writeNumberToken(start, end, f)`.
  `utils/object.ts`: `fmtKey`, `formatComputedOrPropertyKey`, `writeMemberName`, `keyRequiresQuotes`, `shouldPreserveQuote`. `utils/array.ts`: `writeArrayNode(len, wk, start, n, f)` (holes are found by `wk`: `WK_EXPR` / `WK_PAT_ELEM`).
  `print/template.ts` has the JS side of the embeds: CSS (`isEmbedCss`, `isStyledTag`, Angular `styles`, `<style jsx>`, `css=`), GraphQL (`isEmbedGraphql`, `/* GraphQL */` comments, `JsGqlTemplate` in `template_types.ts`), Markdown (`md`/`markdown` tags),
  `describe.each` tables, tagged templates, template literal types. HTML in templates is NOT ported (`html/in_js.rs`): the template is written as it is.
  The JS-handle halves are in `template.ts`, not in `css/embed.ts` / `graphql/embed.ts` (a cycle with `format.ts` there would break scriptc); those files are unchanged.
- **JSON**: `json/util.ts` re-exports `trimmedNumber`/`numBuf`/`numLen` from `js/utils/number.ts` (dedupe of printNumber); its string helpers stay (they work, 785/785).
- **Tests** (`node --stack-size=7000 tools/conformance.ts prettier --languages=js,jsx,typescript --filter=...`, with the other agents' ports of the day): js/strings 10/10, quotes 7/7, literal 2/2, numeric 1/1, big-int 1/1, objects 7/7,
  object-prop 11/11, quote-props 20/20, arrays 18/18, member 3/3, sequence 10/10, spread 1/1, destructuring 12/12, unary 4/4, new-expression 4/4, optional-chaining 8/8, regex 5/5, yield 4/4, async 10/10,
  comments-closure-typecast 23/23, typescript/satisfies 32/32, non-null 4/4, cast 7/7, quote-props 15/15; js/template* 20/21 and typescript/as 30/31 (the failures need HTML in templates); js/multiparser* 33/42
  (html 8, and one markdown code block that contains a JS template that contains markdown: re-entering the formatter). JSON still 785/785. vscode (`bench/vscode`, compiled): .ts 14359/14359, .tsx 270/270, .js 133/133.
  Differential snippets against `bun fmt` (strings, numbers, keys, arrays/fill, patterns, sequences, as/satisfies/`<T>`, templates, gql/css/md embeds, describe.each, member chains with comments): 0 differences, node and compiled.
- **scriptc**: classes declared in a module of the import cycle cannot be used (SC1016): `EachCell`, `EachTable`, `JsGqlTemplate` live in `print/template_types.ts`, which imports nothing of format/js. No module-level `let` in my files.
- **Not ported**: tailwind (`sorted_string_literal`, `sorted_template_text`; the option is refused by the driver, contexts answer "none"), cursor (`around_node_at`), HTML templates.
### signature issues
- `print/object_like.ts` exports `writeObjectLikeExpression`, `writeObjectLikeTsTypeLiteral(ty, membersStart, membersLen, f)` and `objectLikeTsTypeLiteralShouldHug(ty, f)` (Rust `ObjectLike::TSTypeLiteral(..)`); js-types should call them from `writeTsTypeLiteral`.
- `print/expressions.ts`: `fmtObjectMember(property, f)` (was `(wk, member, f)`). `print/template.ts` exports `hasEmbedLabelCssGraphqlMarkdown(e, f)` = the css/graphql/markdown `has_embed_label`; js-call must call it from `hasEmbedLabelOfOtherThanHtml` (`call_like_expression/arguments.ts`, still `return false`) and the arrow chain code.
- `utils/string.ts` `cleanStringLiteralText` is what `assignment_like`'s `is_short_argument` needs (`StringLiteral` case): `cleanedStringLiteralWidth(start, end, isSource, f)`.
### js-core issues
- Seen once and gone after others' commits: `export function f<T>(ctor: { new(): T }): T` was not hugged when a `//#region` comment and an interface precede it (parameters.ts). Fine now in the vscode corpus.

### perf R1 dview
- Replaced DataView setUint32/getUint32 (unaligned byte-buffer word copies, not records) with a `putWord` byte-store helper and a byte copy loop in outSource (len<=64).
- Instructions 170.5G -> 164.5G (1 thread); gate: 0 vscode byte mismatches, no GATE FAILED, conformance ok.
- Files: src/format/ir/printer.ts (ov/sv fields now unused).

### perf R1 width
- Unrolled by 4 the byte loops in isAllPrintable and stringWidthAs (src/format/ir/width.ts); fewer back-edges/worker checks.
- Instructions 170.5G -> 170.0G (-0.3%); gate: 0 mismatches, no GATE FAILED, conformance ok.
- Tried and reverted: unroll-8 of markOddBlocks (170.7G, worse).

### perf R1 fill
- Change: fill() hoists 113 hir + 15 bound typed-array columns into const locals (drops `const b = bound`); setTypes/setTypeParams/setList/setProps inline setType/setExprParent on hoisted columns; setDecorators hoists its 2 columns. typeQueryOperands not hoisted (the one column reallocated outside refill).
- Instructions (1 thread, vscode corpus): 170.5G -> 169.6G.
- Gate: GATE_FAST and full both print `vscode byte mismatches (excl .html): 0`, no GATE FAILED, conformance no regression. 8-thread 1.35s (no baseline for this tree; not a gate criterion).
- Files: src/sema/bind/parents.ts (uncommitted); docs/STATUS.md appended.

### perf R1 uesc
- Not kept (reverted). Tried jumping between backslashes with `indexOf(92, i)` in `buildUnicodeEscapes` (src/lint/ast/mod.ts).
- `Uint8Array.indexOf` fails the build (SC2020, no scriptc 0.3.0 lowering). `(text as Buffer).indexOf` builds; runtime is a byte-by-byte memcmp loop (scr_bytes.c:2572), not memchr.
- Buffer.indexOf attempt: 0 byte mismatches, 170.5G -> 172.2G instructions (regression). Gate run with GATE_FAST=1 only; full gate not run.
- Files: src/lint/ast/mod.ts reverted (git checkout -- src); docs/STATUS.md appended.
- Retry by orchestrator: the real cost was the loop counter `i = ((i | 0) + 1) | 0`, kept as a double (fcvtzs/add/scvtf chain per byte). Rewritten as `for (let i = 0; i < last; i++)`: 170.5G → 169.3G instructions, cycles 38.1G → 36.3G; 0 mismatches. File: src/lint/ast/mod.ts.

### perf R2 ast
- Change: hoisted `hir`/`bound`/`F`/`SP`/`KEY` singletons into locals in exprSpan, exprChain, exprBinaryOpOf, exprIsInOptionalChain, exprParent (+exprParentInGeneral takes the already-read `a`), stmtSpan, keyFrom (`K = KEY`), buildTypeParents (`h = hir`), and an integer counter in asciiNameLen; anSpan/anParent untouched (hir reads only in rare cases).
- Instructions: 163.8G -> 162.0G (-1.1%); 1-thread cycles 34.9G -> 39.1G in this run (busy machine, not gated).
- Gate (full): vscode byte mismatches (excl .html): 0; no GATE FAILED; conformance: no language below baseline.
- Files: src/lint/ast/expr.ts, src/lint/ast/node.ts, src/lint/ast/stmt.ts, src/lint/ast/decl.ts (uncommitted).

### perf R2 lex
- Tried (reverted): hoisted `this.src` and module tables (FIRST, NAME_BYTE, BC_STOP, STR_STOP) into locals in Lexer.name/scan/scanAfterLineFeed/blockComment/string; table/meta/src/cooked into locals in Names.lookup/atomOfKeys.
- Also tried and reverted: `| 0` integer forms in Hir.listFrom/pushExpr/pushStmt (+0.7G: 164.0G vs 163.3G in the same session).
- Instructions: lexer/names hoist A/B, 3 runs each: HEAD avg 162.5G, change avg 163.1G (run-to-run noise about +/-0.8G on the same binary); no measurable gain.
- Gate: 0 byte mismatches, no GATE FAILED, conformance OK for the change variant (fast gate only for HEAD); not kept, so tree is back to HEAD.
- Files: src/sema/parser/lexer.ts, src/sema/parser/names.ts, src/sema/hir.ts (all reverted).

### perf R2 ir
- Tried outSource (printer.ts:503) copy variants for len<=64; both reverted, no change kept.
- DataView word copy (sv.getUint32 -> ov.setUint32, bytewise tail): 168.2G instructions vs 163.8G baseline (worse).
- Bytewise copy unrolled 4x with a single offset: 164.3G vs 163.8G (worse, no gain).
- Gate (GATE_FAST) mismatches 0 in both; src restored to baseline.
### perf R2 ir-hoist
- Tried: hoist pool arrays (tag/a/b/c/variants) and this.x typed-array fields into locals in Printer.printElements/printFlat/printOther/fitsElement, Tracker.closeFrame/firstText/pushSaved, Formatter.isPlainSource, Printer.outRepeat. All reverted; nothing kept.
- Instructions (1 thread, GATE_FAST): baseline 163.8G; all hunks 167.1G; without printOther+fitsElement 164.9G; printElements+printFlat only 164.1G; document.ts hunks alone +0.9G; outRepeat+isPlainSource alone 163.8G (neutral).
- Gate: 0 byte mismatches in every variant; no variant beat baseline, so no full gate run.
- Lesson: entry-time hoisting in per-element printer functions (printOther, fitsElement) added instructions; the reads they replaced were single reads per call.

### perf R2 scan
- Tried (1) Uint32Array SWAR pre-check in markOddBlocks: 164.1G (worse than 163.8G); (2) share odd blocks between buildUnicodeEscapes and Formatter.setSource via cache: 165.4G (worse). Both reverted.
- Result: no change kept; baseline 163.8G unchanged. Gate (fast) mismatches 0 in both attempts. Files: none changed.

### perf R3 str
- Change: string literals scanned once (quote counts, backslash, CR, non-ASCII) in fmtLiteralStringToken and cleanStringLiteralText; unchanged -> plain source token with known width, quote-swap-only -> direct copy with known width, rest falls back to normalizeStringLiteral.
- Instructions: 161.9G -> ~159.7G (runs: 159.4, 160.3, 159.7, 158.8).
- Gate: vscode byte mismatches (excl .html): 0, no GATE FAILED, conformance ok.
- Files: src/format/js/utils/string.ts

### perf R3 span
- Change: number-returning span accessors (exprStart/exprEnd/stmtStart read HIR columns directly, anStart/anEnd and anSpan fast path for expression kinds), ~75 single-end `exprSpan`/`anSpan` + `SP[k]` sites switched to them; one-entry cache for `funcParamsSpan` (FORMAL_PARAMETERS span was re-scanned ~5x per function; reset per file in lint/ast/mod.ts).
- Instructions: 161.9G -> 160.0G (1 thread); cycles 34.5G -> 33.7G; 8 threads 1.15s (noisy).
- Gate: 0 vscode byte mismatches, no GATE FAILED, conformance no regression.
- Files: src/format/js/ast_nodes.ts, src/lint/ast/{expr,stmt,decl,state,mod}.ts, call sites in src/format/js/** and src/format/cursor.ts. Not committed.

### perf R3 quiet
Change: measured first. Quiet already covers most nodes (1.3M of 2.0M statements, 198k of 378k non-leaf expressions); the non-quiet cost was in trailing-comment lookup: 465k calls past the `INF` check, only 13k print anything, 155k computed parent span + `followingSpanStartIn` for nothing. New `Comments.firstLeadsWord()` (own-line, unmoved comment followed by a word) lets `writeTrailingCommentsIn` return before `parentOfRef`/`spanForComments`/`followingSpanStartIn`; not applied to decorators (child starts with `@`: conformance regressed without that).
Instructions: 161.9G -> 160.1G (-1.8G, 1 thread). 8 threads 1.17s (noise).
Gate: vscode byte mismatches 0, conformance no language below baseline (full gate, no GATE_FAST).
Files: src/format/js/format.ts (writeTrailingCommentsIn), src/format/js/comments.ts (firstLeadsWord).

### perf R3 nl
- Tried: memoized "first line break at/after X" scan in `SourceText.hasNewlineInRange` and `containsNewline` (source_text.ts); a full per-file break table rejected (a byte pass over every file costs more than the scans it replaces; only 2 callers of hasNewlineInRange, short ranges for containsNewline; lineEndAt scans each comment byte once so a table cannot help).
- Instructions 161.9G -> 162.1G (hasNewlineInRange only), 160.9G / 161.6G (both; same binary, two runs): within noise (+-0.8G). Gate: 0 mismatches, conformance ok.
- Reverted (no gain beyond noise). Files: none changed.
### perf R4 printer
Counted (15,132 files): 71M elements, 199M output bytes; push4 21M, pushPlain 30M, token 17M, text() 29M, isPlainSource 9.5M (avg 11 bytes), printElements 36M + printFlat 29M visits, fitsElement 15M in 3.8M fits (3.9 each; group measure shortcut already hits 99%). No redundant pass found; the cost was `Formatter.token`/`tokenIfBreaks` reading 4 module-level token tables = 4 thread-local `_tlv_get_addr` calls per token (17M tokens).
Change: one interleaved `TOK_TAB` (len, w0, w1, w2) in element.ts, read through a Formatter field (`tokTab`); `sourceText` writes its element and calls `tracker.text` directly (no push4 -> note switch); `isPlainSource` single-block fast path; dropped the dead `fStartFlags[n] = 0` store in `Tracker.open`.
Instructions 157.8G -> 153.6G (second run of the same binary: 155.1G, noise), gate: 0 mismatches, conformance ok, 1.20s @8 threads (noisy). Files: src/format/ir/{element,formatter,document}.ts.
### perf R4 lexer
- Change: no module-level table reads on the identifier path. `Lexer.name` tests name bytes with arithmetic ranges instead of `NAME_BYTE[]` (a `_tlv_get_addr` call per byte in worker mode) and uses a local `src`; `Lexer.scan` recognizes identifier starts arithmetically before the `FIRST[]` read.
- Instructions: 157.8G -> 155.6G (1 thread; same-code builds varied 154.6-155.7G). Cycles 34.3G.
- Gate (full): vscode byte mismatches 0, no GATE FAILED, conformance ok.
- Tried and dropped: DataView key reads in `name` (158.7G, worse); same fast path in `scanAfterLineFeed` and a space shortcut in `scan` (no gain).
- Files: src/sema/parser/lexer.ts

### perf R4 tls
tools/codemod/hoist-globals.mjs (TypeChecker-based, idempotent, position edits, `node tools/codemod/hoist-globals.mjs src`): per function body, module-level `const` class/object singletons (hir, lx, p, T, s, bound...) whose costliest path has >=2 mentions (branches=max, loop bodies x2) get `const x$ = x;` right before the first statement that mentions them; existing `x$` aliases are reused.
Rewrote 7724 references in 1083 functions (122 files); hand fixes: none. Phase 2 (`--accessors`, inline trivial `hir` column accessors, 1615 calls) is opt-in: 0 instruction gain (153.8G both), so not applied.
Instructions 157.8G -> 153.6G (-2.7%, one thread). Gate: 0 vscode byte mismatches, no GATE FAILED, conformance ok; 8 threads 1.46s (machine busy, noisy).
Changes are uncommitted in /tmp/wt-tls (diff of src/**; re-run the codemod after merging lexer/parser/names/ir changes).

### perf R5 bytes
- Lexer records the `\` of every escape in a name (`Lexer.idEscapes`, from `nameSlowly`/`endOfIdentifierParts`); `fileBegin` uses it as `F.unicodeEscapes` (sorted if a re-scan made it unsorted) and `buildUnicodeEscapes` no longer scans the text. Same results: only a name can have an escape inside the span `fileEndOfIdentifier` looks at.
- `markOddBlocks` kept as is: the comment/line scans skip non-ASCII, backslash and control bytes without a per-byte check, so a lexer flag would need a table lookup per comment byte (the same cost as the pass it replaces).
- 150.2G -> 148.0G (fast gate), 147.4G (full gate) instructions; 0 byte mismatches, conformance ok, 8 threads 1.27s (noisy).
- Files: src/sema/parser/lexer.ts, src/lint/ast/mod.ts.
### perf R5 rc
Printer (src/format/ir/printer.ts): dropped typed-array local aliases in putWord, outSource, outRepeat, outTrimTrailingWhitespace (index via this.out/this.source).
Instructions 150.2G -> 149.6G (small, near noise; repeated builds 149.6-149.7). Gate: 0 mismatches, conformance ok, 8 threads 1.24s (noisy).
Tried and reverted: hir.listFrom (this.ids), identEndOf/keyFrom (hir$.text instead of local alias): no gain (149.6-149.7G).
Files: src/format/ir/printer.ts only.
### perf R5 tables
`node tools/codemod/hoist-globals.mjs src --tables [--strings] [--dry]` (separate phase, off by default): aliases module-level const typed arrays (own/imported, TypeChecker) mentioned in loops as `const T$ = T;` before the outermost loop; idempotent, position-based.
Applied: 235 aliases / 384 mentions / 76 files (mostly SP, DEC, BT_*, NAME_BYTE). Instructions 150.29G (same-tree baseline) -> 150.22G (-0.04%, noise): does not pay (retain/release offsets the saved TLV calls). Gate: 0 mismatches.
src reverted (not applied); patch in /tmp/tables-src.patch. Not tried: strings, outside-loop >=3 mentions. File: tools/codemod/hoist-globals.mjs

### perf R5 outslots
tools/codemod/outslots.mjs (idempotent; run then hoist-globals.mjs): module-level `new Int32Array/Float64Array(n<=8)` used only as `X[const]` (also via local `const sp = SP` aliases) become `SlotsN` objects (src/base/slots.ts); reads -> X.sk, stores -> `X.sk = (e) | 0`, compound/++ likewise; arrays in import cycles are skipped by default (scriptc SC1016 with HAS_DASH; `--cycles`, `--skip=A,B` available).
Converted 13 arrays (SP DEC KEY FLOW LINE FOUND OPTIONAL_TYPE SAVED LEFT_SIDE OFFSETS RANGE TRIM NODE_CONTENT), 1535 mentions, 99 files. Skipped: used as values/non-const index (NAMES, argFrom, ESC_CP...) or in cycles.
Instructions 150.2G -> 149.2G. Full gate: 0 byte mismatches, 8 threads 1.06s, conformance ok.

### perf R6 consts
- tools/codemod/leaf-consts.mjs (`node tools/codemod/leaf-consts.mjs src [--strings --bools]`, idempotent, position-based): Tarjan SCCs over src imports/re-exports; in cyclic modules moves constant-initialized module-level `const`s (numeric/bitwise/arith over literals and other moved consts; string/bool with the flags) with their doc comments into import-free `<file>.consts.ts`, original gets `import {..}` + `export {..} from` for exported ones.
- Moved 578 constants out of 45 modules (ast_nodes 169, md/types 66, md/state 38, format.ts 28, lexer 27, parser/lib 26, ...). `_x25_initialized` symbols 698 -> 350 (remaining: `token("..")`/`KW_*`/`T_*` call initializers ~250, `new Int32Array`/array/object buffers; they need imports so cannot live in a leaf).
- 1 thread: 145.6G -> 134.3G instructions; 8 threads 1.01s; 0 byte mismatches; conformance ok; no SC1016. Not committed.

### perf R7 lex2
- Lexer.name: no `src` alias (drops scr_bytes_retain/release), bytes 1..7 unrolled as nested ifs (no loop poll/shift counter; the byte after the name is reused for the escape/non-ASCII test), first table probe inlined (hit on name <=12 bytes reads token from the same meta row, skips the atomOfKeys call); Names.sameBytes loop for long-name verification.
- Instructions 134.2G -> 133.1G (-0.8%); cycles unchanged (~28.7G). Counts (vscode): ~13M names, avg 9 bytes, 21% longer than 12, 28% keyword/non-identifier tokens, 28% miss the inline probe.
- Gate (full): 0 byte mismatches, conformance ok. Tried and worse: DataView getInt32 for k2/verify (+0.8G).
- Files: src/sema/parser/lexer.ts, src/sema/parser/names.ts.
### perf R7 parse
- Change: parents.ts setList/setProps/setTypes/setDecorators index through `hir$`/`bound$` instead of per-call typed-array aliases (drops 3+ retain/release pairs per call).
- Instructions 134.2G -> 134.0G (within noise; fill's own per-node loop has no runtime calls, pushExpr/listFrom/buildTypeParents left alone).
- Gate: 0 byte mismatches, no GATE FAILED, conformance ok. Files: src/sema/bind/parents.ts

### perf R7 toks
tools/codemod/token-ids.mjs: collects module-level `const X = token("<literal>")`, assigns fixed ids (existing ids in tokens.gen.ts kept, new texts appended, first run sorted by text), generates src/format/ir/tokens.gen.ts (fixedTokenTexts()), element.ts registers them in id order at init (registerFixedTokens, before any other token()), and rewrites declarations to `const X = <id>; // token("<text>")`. Handle values are only used by identity (TOK_BASE/TIB_BASE are element kinds, not handle ranges).
214 distinct texts fixed (401 declarations rewritten, 47 files); then leaf-consts moved 291 constants into *.consts.ts leaves.
x25_initialized globals: 350 -> 103. Instructions 134.2G -> 133.9G (1 thread; cycles noisy). Gate: 0 byte mismatches, no GATE FAILED, conformance ok.
Files: tools/codemod/token-ids.mjs, src/format/ir/tokens.gen.ts, element.ts, 46 rewritten src files + new *.consts.ts.

### perf R7 pbuf
Tried Buffer.copy (srcBuf.copy(outBuf,...), no subarray alloc) in Printer.outSource, thresholds 4/8/16 for the byte-loop fallback.
Instructions 134.2G -> 133.5G / 133.9G / 133.6G: all within the +-1G noise, 0 mismatches. Reverted (no measurable win).
Combined src+out buffer with copyWithin not tried (out is shared across embedded documents, many this.out reads/growth paths).
No files kept.
- Orchestrator: token-ids codemod not merged (−0.3G, within noise; not worth a generated token table).

### perf R8 acc
hoist-globals.mjs phase 2 (--accessors) already counts accessor calls as mentions and adds alias+import when absent (no tool change needed; no accessor shapes left to extend: hir.ts/lint accessors are all `return hir.<col>[p] | 0`).
Dry run/real: 294 functions, 1615 accessor calls inlined, 9 refs hoisted, 63 files (imports of `hir` added, build ok, no SC1016).
Instructions 133.4G -> 133.3G (within +-1G noise), 0 mismatches. Not worth it (LLVM likely already hoists TLV after inlining): reverted src, tool default unchanged.

### scriptc compiler patches (S1): tools/scriptc-dev
- The released CLI is a native binary; `@scriptc/compiler@0.3.0` on npm is the same compiler in JS. tools/scriptc-dev installs it, applies patches/*.patch, runs its CLI under Node (scriptc.mjs). Unpatched build = native CLI build (same size, same instructions).
- 40-loop-poll-stack-guard.patch (may-throw.js): stack-overflow checks only on a feedback vertex set of the call graph (self-recursive functions + one hub per remaining SCC) instead of every function on a cycle; every cycle still passes a check; mutual recursion still raises a catchable RangeError. 133.3G → 125.6G.
- 30-bytes-shared-split.patch (emitter.js, expr-bytes.js): `sanitize_address` was on every emitted function even without --sanitize (blocks LLVM load hoisting); now only with --sanitize. ScrBytes header loads (shared/len/data) get !invariant.load (the runtime never changes them after creation); non-null bytes params are dereferenceable(56). −1.9G more.
- Combined: 133.3G → 123.6G instructions, 26.7G cycles, 0.88s @8 threads; full gate clean.
- Measured, not kept: one threadlocal.address per global per function (+2%: spills; our codemods already removed repeats); inline exception checks (already inline in 0.3.0: a process-wide alert word, scr_exc_pending only on the cold path).
- Ablations (prizes left): loop cancellation budget ~6G (no safe design yet: the cost is the per-iteration decrement); typed-array shared split ~12.8G total (only ~1.9G recovered: receivers that are not params are not known dereferenceable).
### scriptc compiler patches (S2)
- 50-shared-bytes-inline.patch (expr-bytes.js): the shared-view path of typed-array get/set was a runtime call that took one global mutex around a plain memcpy; shared views have the same stable data pointer, fixed length, no detach. Non-Atomics SAB accesses are plain racy accesses in the JS memory model, so both paths now use the inline access (Atomics.* still go through the runtime). 123.6G → 110.0G alone.
- 60-no-termination-polls.patch (lowerer.js, may-throw.js, emitter.js): when no source file mentions `terminate` or `unref`, nothing can stop a running worker from outside, so no loop cancellation budgets and no entry polls (per-call exception checks unchanged). A worker spinning in `while(true)` that main terminates still exits (that program keeps the polls). Edge: if main dies of an uncaught error while a ref'd worker spins forever, exit now waits. 123.6G → 117.7G alone.
- 70-one-tls-block.patch (emitter.js): the program's 4,788 thread-locals live in one `@scr_program_tls` struct addressed by `llvm.threadlocal.address` at each use, so LLVM CSEs one TLV call per function instead of one per distinct global (static TLV calls 22,989 → 6,035). `SCRIPTC_NO_PROG_TLS=1` disables. 123.6G → 117.9G alone.
- Stacked 30+40+50+60+70: 97.6G instructions, 22.6G cycles, 0.76s @8 threads; full gate clean.
### scriptc compiler patches (S3)
- 85-inline-dataview.patch (byte-numbers.js): the existing inline DataView/Buffer number path was disabled in worker programs (`if (host.mod.workers) return fallback()`); after patch 50 shared and local views share the access path, so the guard is removed. Out-of-range/non-integer offsets and BigInt accessors still take the runtime path. 97.6G → 94.8G.
- 90-int32-locals.patch (new int32-locals.js, emitter.js, expr-primitives.js): non-captured locals whose every write the existing contract range prover shows to be int32 get an `alloca i32` (~11,100 of ~26,000 locals). 97.6G → 96.5G. The least certain patch (new codegen path); drop it first if anything misbehaves.
- Not kept: a pthread-TSD fast path for TLS on Darwin (all three designs neutral or worse; LLVM already sinks the TLV calls; the remaining ones are in the prebuilt runtime).
- Stacked 30–90: 92.9–94.5G instructions, 21.8–22.3G cycles; interleaved vs Bun: 4.86/0.73/0.46 s at 1/8/18 threads (Bun 2.42/0.44/0.29). Full gate clean.

### perf P1 irw
Change: dropped the per-file `markOddBlocks` pass (2.2G: the whole source classified byte by byte); `sourceText` now checks only the token's own bytes (int indices, 4-way unrolled, inlined) and `isPlainSource` does the same; `isAllPrintable`/`stringWidthAs`/`textWidth` scan with int indices; text elements (`textSource*`, `textBytes*`, `endBuiltText`) go through `pushText` (tracker.text directly, no `note` dispatch).
Counters (71.35M elements: 17.4M tokens, 9.8M source text, 14.8M group tags, 6.2M indent tags, 5.0M lines, 3.0M spaces): unchanged, merging adjacent text/space/token pairs is at most ~4M (6%) and a leading-space merge is not safe at line starts; the costs were per byte, not per element.
Instructions (min of 5, interleaved, 1 thread; run-to-run noise is +-1G, so compare binaries only interleaved): 93.2G -> 91.8G (-1.4%); full gate: 0 mismatches, 0.83s @8 threads (noisy), conformance ok.
Tried and not better: Int32-local rewrites of `token`/`pushPlain`; field-direct (no local alias) `isPlainSource` loop (+0.7G vs aliased); Uint8Array.indexOf/isAscii natives (indexOf unsupported on Uint8Array, scalar 600 MB/s on Buffer).
Files: src/format/ir/formatter.ts, src/format/ir/width.ts.

### perf P1 flat
- Result: NOT KEPT (no code change). Baseline re-measured 93.7G instr (the 94.3G was noise); no design beat it.
- Query counts (vscode corpus, 10.2M exprs): exprParent 12.7M calls / 5.9M distinct, exprSpan 7.6M / 5.4M, exprEnd 7.0M, exprStart 3.1M, exprChain 9.5M, exprIsInOptionalChain 5.9M, keyLoad 3.4M, asciiNameLen 1.1M, fileEndOfTokenBefore 0.7M, anParent 0.67M, parentOfExpr 1.6M, anSpan 2.5M; buildTypeParents 11.4K builds.
- Design 1 (lazy flat columns xS/xE/xP in FileState, reset per file, exprParent/exprSpan/exprStart/exprEnd read them): 95.4G (+1.7G). The accessors are already ~1 TLV + 2-3 loads; a column hit costs the same, a miss costs more, plus 3 fills per file.
- Design 2 (fused exprIsInOptionalChain, tag-table filter in the buildTypeParents expression loop): 93.6G vs 93.7G, within noise; reverted. Remaining cost there is branch mispredicts over all exprs, not accessor layers.
- Files touched then reverted: src/lint/ast/{state,expr,node,mod}.ts. 0 mismatches in both builds.
### scriptc compiler patches (P1)
- 95-borrow-aliases.patch (emitter.js, borrowed-receivers.js, expr-bytes.js): scriptc's existing borrow analysis (`unwrittenAlias`, effect summaries) now covers typed arrays: local aliases of fields, module-level tables read through the TDZ check, and projections passed to bytes intrinsics. Static `scr_bytes_retain_v` 2437 → 1178. Checked with --sanitize: retains when a write (grow(), field store) can intervene. −1.6G.
- 96-bounds-i32-calls.patch (emitter.js, expr-calls.js, bytes-bounds.js, integer-ranges.js): internal functions whose params/returns are proven int32 at every call site get an i32 signature (double-ABI adapter kept for closures/vtables/runtime); bounds checks elided for fixed-length module tables with proven index ranges. Ablation: all integer-index bounds checks ≈ 5G (most hot reads are `this.src[pos]`, not provable without a `len <= src.length` invariant). −3.2G.
- setup.sh now restores the pristine compiler and applies every patch in order with no fuzz (the old "already applied" check re-applied a patch and left a .rej).
- With the IR-writer change (no per-file markOddBlocks pass; tokens check their own bytes): 88.7G instructions, 20.5G cycles, 0.73s @8 threads; full gate clean.

### perf P1 unions
- No source-level `number | undefined` / `x?: number` / `Map.get` unions exist in the target functions (grep of src/format/js + lexer: none); no edits made.
- The 428 `scr_union_new_f64` sites are call-site boxing of native numbers into functions whose `number` params compile to a union ABI (`sc_bf__*.i(ptr ...)`, e.g. exprTag, exprAsFn, exprNonNullExpr, parentOfExpr, mkAn id, fmtExpr, shouldWrapFunctionForExportDefault) beside a `_nativeNumber` clone; root cause (which call site makes the param `f64|undefined`) not found in IR; likely a compiler-side inference issue.
- instructions: unchanged (no change made); gate not run.

### perf P1 widen
Cause: `arr[i] as number` / `stack.pop() as number` / bare `arr[i]` call args are treated as possibly-undefined; the optional-binding fixpoint then spreads `number|undefined` through locals (`let current = e`), returns (`fullStartOf`, `leftEdgeEnd`) and params, giving exprTag/exprAsFn/exprNonNullExpr/mkAn/fmtExpr... a union ABI.
Fix (source only, `| 0`): cursor.ts operandsInRightSide (`stack.pop()`, `operands[count-1/-2]`), print/flow.ts:1978 `copy[i]`, sort_imports/organize.ts:1045 fullStartOf, sort_imports/generator.ts:340.
`scr_union_new_f64` sites 429 -> 121 (rest are cold driver/string params); instructions 88.7G -> 85.0G; full gate: 0 vscode mismatches, no GATE FAILED.

### perf P1 jsfast
- Counts (8.4M fmtExpr calls, vscode): idents 2.9M (2.4M reached the parens check, 3.3k needed them); calls 1.3M, member 0.9M, strings 0.83M; mayNeedParentheses true for non-idents is rare (<1%). keepsArgumentsOnOneLine 1.3M calls: 0.62M callee not a name, 0.24M name not require-like (ran 10 nameIs each), 0.25M string/template first arg. fmtArguments 1.4M: 0.95M plain layout, 0.30M can-be-grouped. fmtStatements 1.66M statements, 1.17M isNextLineEmptyAfter; those paths were already fast.
- Kept: identifier fast path in fmtExpr (skips needsParentheses/mayNeedParentheses/exprParent for names that cannot need parens; exact same predicate via identMayNeedParentheses), byte-compare isNameThatMayNeedParentheses, length/first-letter filter before the 10 nameIs in keepsArgumentsOnOneLine. Other candidates (exprParent shortcuts, fmtArguments simple path) measured at <0.1% each by count: not done.
- Instructions (1 thread, min of 4 alternating runs; run-to-run noise ~0.7G): 88.6G -> 88.4G median-ish gain ~0.3G (0.3%); gate run 89.9G. Full gate: 0 vscode mismatches, no GATE FAILED, conformance ok, 0.75s @8.
- Files: src/format/js/format.ts, src/format/js/parentheses/expression.ts, src/format/js/print/call_like_expression/mod.ts.

### scriptc 0.3.2
- tools/scriptc-dev now runs @scriptc/compiler 0.3.2 (setup.sh packs 0.3.2 into node_modules/.scriptc-compiler-pristine-0.3.2). Patches 30 and 60 re-ported by hand (same changes, new context: usesCoroutines, int32Abi params, programMayRequestTermination in lowerer); 40/50/70/85/95 apply unchanged.
- Patch 90 (int32 locals) dropped: 0.3.1 ships the same analysis as backend/llvm/int32-locals.js (94 lines, same findInt32Locals shape), so there is nothing left to port.
- Patch 96 cut to its bounds half (const typed-array globals in findBytesBounds, NaN-read ranges for bitwise ops); the i32-signature half is dropped because 0.3.1's findInt32Abis/emitInt32AbiWrapper covers the same params/results (plus scalar-union results).
- Instructions/cycles, 1 thread, vscode --check, min of 3 interleaved (machine load avg ~65, so cycles are noisy): stock 0.3.0 125.8G/27.2G, stock 0.3.2 122.5G/25.8G, patched 0.3.0 (main) 83.25G/29.1G, patched 0.3.2 (30,40,50,60,70,85,95,96-bounds) 83.21G/28.5G. Net: parity with main; the upstream int32 work replaces two of our patches.
- Gate: vscode byte mismatches (excl .html): 0, no GATE FAILED, conformance at baseline. 8 threads: 3.4-3.5s vs 3.3-3.6s for main, both inflated by machine load; no difference measurable.
- make-patch.sh now passes --no-backup-if-mismatch when stacking the base (fuzz left .orig files that leaked into regenerated patches).
### ablation bounds
Measurement only (patches in scratch/ablations/bounds-V1.patch, bounds-V2.patch (cumulative)); base 83.2 G instr, cycles noisy (~29-31 G, machine loaded).
- V1: expr-bytes.js:71 `if (integer)` (drop compare-and-branch for every integer-index typed-array get/set). `^bytes.index.invalid` blocks in IR 12090 -> 5689 (rest are non-integer indices). 83.2 -> 75.9 G (-7.3 G, 8.8%); cycles within noise (~-1 G, 29.0-30.5 vs 28.3-29.5). Output identical (0 mismatches), no crashes.
- V2: V1 + string-reads.js `sc_str_char_code_at_int` without length compare (the double-index helper keeps its check). 75.9 -> 75.9 G (no further gain, within noise); 0 mismatches.
- V3 not done.
### ablation stack
- V1 (no stack guard; `return` at top of emitStackCheck, dist/backend/llvm/emitter.js:3211; scratch/ablations/stack-V1.patch, applies on top of the patch stack): sites 283 guard_get + 283 overflow -> 0 + 0.
- vscode --check --threads=1, min of 3 interleaved: 83.25 G -> 80.21 G instructions (-3.7%, 3.0 G); cycles 28.7 G -> 27.9 G (machine loaded, noisy; indicative only). Output mismatches: 0.
- V2 static counts (IR): 16223 internal sc_f__/sc_bf__ functions (9351 + 6872); 3583 have an int-return ".i" clone beside the double base; 2810 have i32 params, 1279 return i32, 9076 have double params.
- Call sites to sc_f__/sc_bf__: 48485; 21391 go to ".i" clones; 2024 go to a double base that has an ".i" twin; 23279 pass a double argument.
### ablation exc
Post-call exception checks, measured with `--check --threads=1` on the vscode corpus minus the 36 syntax-error files (copy; /tmp/fmt-main measured on the same copy: 81.7 G instr / 27.2 G cycles, cycles noisy under load). Edit: `emitPendingCheck` in dist/backend/llvm/emitter.js (~line 3108); patches in scratch/ablations/.
- V1 (exc-V1.patch): no post-call checks except lexically inside try regions (a fully check-free binary hangs in `fsx.readText`, whose catch needs them). `scr_exc_pending` call sites 25,145 -> 532 (alert loads 72). 77.3 G instr (-4.4 G, -5.4%), 26.3 G cycles (min of 3, -3%). 0 mismatches vs ../vscode-fmt.
- V2 (exc-V2.patch): no checks after `sc_f__*`/`sc_bf__*` calls (found by scanning the last emitted call), runtime checks kept. Sites 2,746 (alert loads 2,286). 77.5 G instr (-4.2 G, -5.1%), 25.4 G cycles (min of 3). 0 mismatches.
- Conclusion: ~4.3 G instructions (~5%) is the ceiling for removing exception checks; almost all of it is recoverable by a precise "user function cannot throw" analysis (V2 ~ V1). Cycle gain is within noise, ~0-3%.

### perf C stack
- Patch 97 `SCRIPTC_NO_STACK_GUARD=1` disables stackChecks at the decision point in the emitter (no marked functions, no init call, no RangeError edges); gate.sh exports it.
- IR (grep -c) guard_get/overflow/stacksave/guard_init: with var 0/0/0/0; default 284/284/284/2 (default unchanged).
- bench/vscode --check 1 thread, min of 3: instructions 83.19 G (main032) -> 80.16 G (-3.6%); cycles noisy (20.8-25.6 G cstack vs 21.4-22.3 G main032, other agents loading the machine).
- Gate: 0 byte mismatches, conformance ok, no GATE FAILED.
- Deep nesting: 2,000 parens gives identical output/exit 1 in both; 20,000 and 200,000 give "The code is nested too deeply", exit 2 in both. The parser limit protects the guardless build.
### perf C exc
Diagnosis of `computeMayThrow` on 0.3.2+patches (7,820 fns, 4,604 may throw, `indirect` true). The suspected over-conservative rules are NOT the cause: ignoring stack-check seeds frees 4 fns, TDZ reads 1, worker `handlersCatchAll` 9 (patch 60 already makes handlers discharge), `writesPublished` 36. The seeds are real: `new Uint8Array(n)` with a non-literal f64 length (RangeError) and `bytes.set(src)` (RangeError) in the buffer-grow idiom (`Storage.grow`, `Printer.growOut`, `I32Vec.grow`, ...), DataView reads (`Names.atomOfSourceRange`), `throw` statements, `x!`/union-narrow TypeErrors, `cxOf` class casts. `Formatter.token`, `Printer.printElements` and `Lexer.scan` reach only grow-idiom seeds (bytesNew + setFrom; Lexer.scan also bigint/dv), so one interprocedural length/capacity proof for the grow idiom would free the hot path; local rules cannot (`while (cap < need) cap *= 2` depends on callers' `need`).
Patch 98 (sound): a size-form `bytesNew` whose length is provably in [0, 2^53) (literal, `.length`, `+ * >>> &` of bounded values, single-definition locals) no longer seeds. `scr_exc_pending` sites 24,651 (25,145 in the 0.3.0 ablation); instructions 82.8 G vs 82.8 G (main032), i.e. no measurable gain; output identical (0 mismatches outside .html on the corpus copy, try/catch test equal to node).
Next: make the grow idiom provable (source: clamp `need`/cap with `Math.min`, or a compiler rule for `new T(n); t.set(old)` with n >= old.length), or accept unsound-but-trapping RangeErrors as in patch 97's approach.
