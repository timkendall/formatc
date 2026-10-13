# scriptc-formatter: plan

A TypeScript port of Bun's formatter (`bun fmt`, Rust, `vendor/bun/src/format`), compiled to a native
executable with scriptc and parallelized with `node:worker_threads` + `@scriptc/threads`.

Goal: the same output as `bun fmt`, byte for byte, and at least as fast as it on Bun's published benchmark
(`bun fmt --check` over microsoft/vscode, 8 threads).

## Baseline (Apple M5 Pro, 18 cores; Bun canary 1.4.4, `~/.bun/bin/bun`)

| run (`bench/vscode`, 18,080 files, 238 MB, 193 MB of it TS) | wall |
| ----------------------------------------------------------- | ---- |
| `bun fmt --check --threads=1`                               | 2.27 s (~105 MB/s/core) |
| `bun fmt --check --threads=8`                               | 0.43 s |
| `bun fmt --check` (18 threads)                              | 0.29 s |

`bench/vscode-fmt` is `bench/vscode` after `bun fmt`: the oracle for byte equality.

## Source map: what is ported where

| Rust (vendor/bun/src)                          | lines | TS (src/)                    |
| ---------------------------------------------- | ----- | ---------------------------- |
| `format/ir` (IR, Formatter, printer)           | 6.0k  | `src/format/ir/`             |
| `format/*.rs` (options, range, cursor, pragma) | 5.1k  | `src/format/`                |
| `sema/hir.rs`, `sema/node.rs`, `sema/atom.rs`  | ~7k   | `src/sema/`                  |
| `sema/parser` (TS-Go-shaped parser)            | 26k   | `src/sema/parser/`           |
| `lint/ast` (handles over the HIR)              | 9k    | `src/lint/ast/`              |
| `format/js` (JS/TS/JSX/Flow formatter)         | 42k   | `src/format/js/`             |
| `format/json` + `parsers/json`                 | 3.8k  | `src/format/json/`           |
| `format/css`                                   | 11.4k | `src/format/css/`            |
| `format/yaml` + `parsers/yaml.rs`              | 9.8k  | `src/format/yaml/`, `src/parsers/yaml.ts` |
| `format/markdown` + `md/`                      | ~15k  | `src/format/markdown/`, `src/md/` |
| `format/graphql`                               | 2.8k  | `src/format/graphql/`        |
| `format/html`                                  | 12.9k | `src/format/html/`           |
| `format/handlebars`                            | 5.2k  | `src/format/handlebars/`     |
| `format/toml` + `parsers/toml.rs`              | 3.1k  | `src/format/toml/`, `src/parsers/toml.ts` |
| `format/verify*` (`--debug-check`)             | 2.8k  | `src/format/verify/`         |
| `format/conformance` (Prettier test runner)    | 1.1k  | `src/format/conformance/`    |
| `lint/driver/fmt` + discover/gitignore/configs | ~12k  | `src/driver/`                |

## Phases

1. **Foundation** — scriptc cookbook (`docs/SCRIPTC_COOKBOOK.md`), porting conventions
   (`docs/ARCHITECTURE.md`), base library (`src/base/`), IR + printer, HIR storage, driver with threads.
2. **JS/TS** — parser → HIR → lint handles → `format/js`. This is 90%+ of the benchmark's bytes.
3. **The other languages** — JSON, CSS/SCSS/Less, YAML, Markdown, GraphQL, HTML/Vue/Angular, Handlebars, TOML.
4. **Speed** — profile and iterate until `--threads=8` on vscode is ≤ Bun's time.

## How correctness is measured

- `tools/compare-vscode.ts`: formats every file of `bench/vscode` and compares with `bench/vscode-fmt`. Per-language match rates.
- `src/format/conformance` port: Prettier's 9,733 fixtures (`/tmp/prettier-bundle.txt` from
  `vendor/bun/test/cli/format/prettier/bundle.zst`), Bun's score is in `vendor/bun/test/cli/format/prettier/expected.txt`.
- Single file: `~/.bun/bin/bun fmt --stdin-filepath=a.ts < a.ts` is the oracle.

## Waves (who ports what, in dependency order)

| wave | agent | scope | needs |
| ---- | ----- | ----- | ----- |
| 1 | core | `src/base`, `src/format/{options,text,stack,syntax_error,pragma,front_matter}`, `src/format/ir/*`, `docs/IR_API.md` | — |
| 1 | sema | `src/sema/{hir,node,atom}`, `src/sema/parser/{token,lexer,names,pragmas,lib}`, `docs/HIR_API.md` | — |
| 1 | driver | `src/driver/*`, `src/main.ts`, threads, `--compare-to` | — |
| 1 | parsers | `src/parsers/{yaml,toml}.ts`, `docs/PARSERS_API.md` | — |
| 1 | md | `src/md/*` (bun_md), `docs/MD_API.md` | — |
| 2 | parser-A | `sema/parser/parser/{mod,expr,pattern,func,class,js_syntax,json}` | sema |
| 2 | parser-B | `sema/parser/parser/{stmt,module,declared,ty,jsx}` | sema |
| 2 | lint-ast | `src/lint/ast/*` (+ `language`, `span`, `tokens`, `goes_to_flow`) | sema |
| 2 | css | `format/css/*` incl. `doc.rs`/`sink.rs` (the "other printer" YAML/MD/HBS use) | core |
| 2 | json | `format/json/*` | core |
| 3 | parser-C | `sema/parser/{summarize}`, `parser/{recover,flow,oxc,reparse,jsdoc}` | parser-A/B |
| 3 | js-core | `format/js/{format,ast_nodes,fields,siblings,comments,trivia,context,builders,source_text,mod}`, `parentheses/*`, `format/{range,cursor}` | core, lint-ast |
| 3 | yaml, markdown, graphql+toml, handlebars | `format/{yaml,markdown,graphql,toml,handlebars}` | css (doc), parsers, md |
| 4 | js-print-1..4, js-utils | `format/js/print/*`, `format/js/utils/*` split by file | js-core |
| 4 | js-extras | `format/js/{sort_imports,jsdoc}`, tailwind | js-core |
| 5 | html | `format/html/*` | js, css |
| 5 | verify, conformance | `format/verify*`, `format/conformance` | all |
| 6 | perf | profile + iterate on vscode `--check --threads=8` | all |

### JS formatter split (`vendor/bun/src/format/js`, 41.7k lines)
| agent | files (Rust, under format/js unless noted) | ~lines |
| ----- | ------------------------------------------ | ------ |
| js-core | format, ast_nodes, fields, siblings, comments, trivia, context, builders, source_text, mod, parentheses/*, format/range.rs | 7.5k |
| js-stmt | print/{statements, program, block_statement, switch_statement, try_statement, return_or_throw_statement, semicolon, variable_declaration, export_declarations, import_declaration, decorators}, utils/{statement_body, suppressed, format_node_without_trailing_comments} | 3.4k |
| js-expr | print/{expressions, literals, member_expression, sequence_expression, array_expression, array_element_list, object_like, object_pattern_like, patterns, as_or_satisfies_expression, template}, utils/{string, number, object, array, expression, operators, typecast, es5_identifier_tables} | 4.0k |
| js-call | print/{function, arrow_function_expression, parameters, call_like_expression/*, class}, utils/{call_expression, member_chain/*} | 5.3k |
| js-binary | print/binary_like_expression, utils/{assignment_like, conditional, experimental_ternary} | 3.2k |
| js-types | print/{ts_types, ts_declarations, type_parameters, union_type, intersection_type, tuple_type, mapped_type, function_type, jsx/*}, utils/{typescript, jsx} | 4.5k |
| js-extras-1 | print/flow, utils/tailwindcss, jsdoc/*, format/cursor.rs | 8.4k |
| js-extras-2 | sort_imports/* | 7k |
