# `src/parsers/`: Bun's YAML and TOML parsers as the formatter reads them

Ports of `vendor/bun/src/parsers/yaml.rs` (`YAML::parse_as_written`) and `vendor/bun/src/parsers/toml.rs`
(`TOML::tokens`): the two entry points that `format/yaml` and `format/toml` call. The rest of those files builds JS
values (`Bun.YAML.parse`, `Bun.TOML.parse`) and is not ported. What decides whether a text is YAML or TOML, and where it
is wrong, is ported branch for branch; `tools/parsers/*-diff.ts` checks that against Bun (numbers in
`docs/STATUS.md`).

|                  | file                  | Rust it is                                                     |
| ---------------- | --------------------- | -------------------------------------------------------------- |
| YAML             | `src/parsers/yaml.ts` | `parsers/yaml.rs`: `YAML::parse_as_written`, `ParseError`, `SourceToken`, the `Expr` it hands out |
| TOML             | `src/parsers/toml.ts` | `parsers/toml.rs`: `TOML::tokens`, `Token`, `TokenKind`        |
| (not ported)     |                       | `parsers/lib.rs`, `error.rs`: nothing in them is read by the formatter |

Conventions (docs/ARCHITECTURE.md): every function is a plain function over module state; the state is **per thread**
(one set of typed arrays, reset, never reallocated, grown by doubling) so a worker parses file after file without
allocating; no JS string is made of source text; a syntax error is a return value. **The result is valid until the next
call of the same parser on the same thread**: read it, or copy what is needed, before parsing the next text. `src/base/`
is not needed.

## YAML

```ts
import {
  yamlParseAsWritten, yamlErrorPos,
  yamlDocCount, yamlDocRoot, yamlNodeKind, yamlNodeLoc, yamlNodeCount, yamlItem, yamlPropKey, yamlPropValue,
  yamlTokenCount, yamlTokenKind, yamlTokenStart, yamlTokenEnd, yamlSetMaxDepth,
  PE_*, TK_*, NK_*, NODE_NULL, NODE_SCALAR, NODE_ALIAS, parseErrorName, tokenKindName,
} from "../../parsers/yaml.ts";
```

### Calling it

Rust (`format/yaml/mod.rs::write_document`):

```rust
let without_nul = if contains_char(text, 0) { text.iter().map(|&b| b.max(1)).collect() } else { text };
let tree = YAML::parse_as_written(&without_nul, |documents, tokens| ast::build(text, documents, tokens, &stack))
    .map_err(|(error, at)| refusal(error, at.min(text.len())))?;
```

TS:

```ts
// `text`: Uint8Array, line breaks as the caller has them (\n after crlf_as_lf), BOM already taken off, NUL already 1.
const error = yamlParseAsWritten(text, text.length);       // 0, or a PE_* (Rust `Err((error, at))`)
if (error !== 0) { const at = Math.min(yamlErrorPos(), text.length); /* refusal(error, at) */ }
else { /* ast.build: read yamlDocCount(), yamlDocRoot(i), the tree and the tokens, below */ }
```

* The closure of Rust is "the code after the call": the result is read through the accessors.
* NUL is the caller's: the parser answers `PE_UNEXPECTED_CHARACTER` at a NUL that is not the end, as Rust does; the
  formatter replaces it by 1 first (`yaml` takes it for a character).
* A byte order mark at the start is skipped by the parser too (`Parser::init`): offsets then count it. The formatter has
  taken it off.
* Positions are **byte offsets** of the text passed in (Rust `usize`/`u32`).
* `yamlSetMaxDepth(n)` (default 1000 nested nodes) is the stack: Rust asks the real stack (`StackCheck`), here a
  budget in nested `parse_node` calls (~5 frames each). Past it: `PE_STACK_OVERFLOW` at the token. Under `node` the
  native stack is smaller than under scriptc (8 MiB per thread): a native `RangeError` is caught and answered the same
  way.

### Errors: Rust `ParseError` -> `PE_*`

| Rust `ParseError`                          | TS                              | `format/yaml` `refusal` makes of it            |
| ------------------------------------------ | ------------------------------- | ---------------------------------------------- |
| `StackOverflow`                            | `PE_STACK_OVERFLOW`             | `FormatError::NestedTooDeeply`                 |
| `OutOfMemory`                              | `PE_OUT_OF_MEMORY` (never)      | `Message::TooLarge`                            |
| `UnexpectedEof`                            | `PE_UNEXPECTED_EOF` (never)     | `Message::UnexpectedEnd`                       |
| `UnexpectedCharacter`                      | `PE_UNEXPECTED_CHARACTER`       | `Message::UnexpectedCharacter` ("Unexpected character") |
| `TabIndentation`                           | `PE_TAB_INDENTATION`            | `Message::TabAsIndentation` ("Tabs cannot be used for indentation") |
| `InvalidDirective`, `MultipleYamlDirectives` | `PE_INVALID_DIRECTIVE`, `PE_MULTIPLE_YAML_DIRECTIVES` | `Message::InvalidDirective` ("Invalid directive") |
| `UnresolvedTagHandle`                      | `PE_UNRESOLVED_TAG_HANDLE`      | `Message::InvalidTag` ("This tag cannot be resolved") |
| `MultilineImplicitKey`                     | `PE_MULTILINE_IMPLICIT_KEY`     | `Message::KeyOverSeveralLines` ('A key without "?" must be on one line') |
| `MultipleAnchors`, `MultipleTags`          | `PE_MULTIPLE_ANCHORS`, `PE_MULTIPLE_TAGS` | `Message::RepeatedProperty` ("A node can have at most one anchor and one tag") |
| `UnexpectedDocumentStart`, `UnexpectedDocumentEnd` | `PE_UNEXPECTED_DOCUMENT_START`, `PE_UNEXPECTED_DOCUMENT_END` | `Message::UnclosedString` ("Unclosed string") |
| everything else (`UnexpectedToken`, ..)    | `PE_UNEXPECTED_TOKEN`           | `Message::UnexpectedToken` ("Unexpected token") |
| `UnresolvedAlias`, `ExcessiveAliasing`, `CyclicAlias`, `CyclicMerge` | (never: aliases are not resolved) | |

The messages in parentheses are what `bun fmt` printed in the differential test (the formatter's own words), for
whoever ports `syntax_error.rs`. `yamlErrorPos()` is Rust's `at`: the cursor for `UnexpectedCharacter`,
`UnresolvedTagHandle`, `UnexpectedDocumentStart`/`End`, the start of the current token for the others. The place that
`bun fmt` prints is that byte (line, column in UTF-16 code units, both from 1); the test compares them.

### The documents: Rust `&[Expr]` -> node ids

A node is an `Int32` id. Only what `parse_as_written` makes exists:

| Rust (`bun_ast::Expr` `.data`)          | TS                                   | meaning                                       |
| --------------------------------------- | ------------------------------------ | --------------------------------------------- |
| `Data::ENull(_)`                        | `yamlNodeKind(id) === NK_NULL` (`id === NODE_NULL`)    | a node that is not written                    |
| `Data::EBoolean(b) if b.value`          | `NK_SCALAR` (`NODE_SCALAR`)          | any scalar: plain, quoted, block              |
| `Data::EBoolean(_)` (false)             | `NK_ALIAS` (`NODE_ALIAS`)            | an alias (`*a`); it need not resolve          |
| `Data::EObject(o)`                      | `NK_OBJECT`                          | a mapping, block or flow, or a flow pair `[a: b]` |
| `Data::EArray(a)`                       | `NK_ARRAY`                           | a sequence, block or flow                     |
| `E::Object::properties.len()`           | `yamlNodeCount(id)`                  |                                               |
| `properties[i].key.unwrap()`            | `yamlPropKey(id, i)`                 | always there                                  |
| `properties[i].value.unwrap()`          | `yamlPropValue(id, i)`               | always there                                  |
| `E::Array::items.len()`, `items[i]`     | `yamlNodeCount(id)`, `yamlItem(id, i)` |                                             |
| `Expr::loc.start` (Rust `Loc`)          | `yamlNodeLoc(id)`                    | **only for `NK_OBJECT` and `NK_ARRAY`**       |
| `documents.len()`, `documents[i]`       | `yamlDocCount()`, `yamlDocRoot(i)`   | one document for an empty text                |

`NODE_NULL`, `NODE_SCALAR` and `NODE_ALIAS` are shared (ids 0, 1, 2): compare kinds, not identities, for leaves; a
collection has an id of its own. `loc` is where the node starts: `[` or `{` of a flow collection, the first key (or `?`,
or the `:` of an empty key) of a block mapping, the `-` of a block sequence, the `?` of a flow pair. That is all that
`ast.rs::is_in_braces` needs (`key.loc == node.loc` for a block mapping whose first key is a flow collection).

Not there, because `parse_as_written` does not look at it: what a scalar means (`true` stands for all), tags (a tag
changes nothing), anchors (not bound), merge keys (`<<` is a key like another), the escapes of quoted scalars (not
decoded; an escape can be half a surrogate pair).

### The tokens: Rust `&[SourceToken]`

`SourceToken { kind, start, end }` -> `yamlTokenKind(i)`, `yamlTokenStart(i)`, `yamlTokenEnd(i)`, `i <
yamlTokenCount()`; or the arrays (`yamlTokenKinds()`, `yamlTokenStarts()`, `yamlTokenEnds()`: `Uint8Array`,
`Int32Array`, `Int32Array`, valid for the first `yamlTokenCount()` entries, until the next parse). Sorted by `start`,
in the order of the text; what is between two tokens is white space (and, behind a `Directive` token, the rest of its
line).

| Rust `SourceTokenKind` | TS                 | the token                                                                    |
| ---------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `Comment`              | `TK_COMMENT`       | from `#` to the end of the line, not the line break                          |
| `Directive`            | `TK_DIRECTIVE`     | **the `%` only** (the rest of the line is not a token: `transform_directive` reads the text) |
| `DocumentStart`        | `TK_DOCUMENT_START`| `---`                                                                        |
| `DocumentEnd`          | `TK_DOCUMENT_END`  | `...`                                                                        |
| `SequenceEntry`        | `TK_SEQUENCE_ENTRY`| `-`                                                                          |
| `MappingKey`           | `TK_MAPPING_KEY`   | `?`                                                                          |
| `MappingValue`         | `TK_MAPPING_VALUE` | `:`                                                                          |
| `CollectEntry`         | `TK_COLLECT_ENTRY` | `,`                                                                          |
| `SequenceStart`/`End`  | `TK_SEQUENCE_START`/`TK_SEQUENCE_END` | `[`, `]`                                                  |
| `MappingStart`/`End`   | `TK_MAPPING_START`/`TK_MAPPING_END`   | `{`, `}`                                                  |
| `Anchor`, `Alias`      | `TK_ANCHOR`, `TK_ALIAS` | `&name`, `*name`                                                        |
| `Tag`                  | `TK_TAG`           | `!`, `!!str`, `!<..>`, `!e!x`: the whole tag                                 |
| `Scalar`               | `TK_SCALAR`        | with its quotes. Plain: from its first byte to **where the scanner stopped**, trailing white space and line breaks included (`ast.rs::transform_scalar` trims). Block: from `\|` / `>` to where the next token can start |

The comment on the header line of a block scalar (`key: | # c`) is listed after the scalar, though it lies inside its
range (the scalar starts at the `|`): the list is sorted by `start`. Tokens that are scanned twice (the parser goes back
for a plain scalar after a tag) are listed once.

Names for debugging: `parseErrorName(e)`, `tokenKindName(k)`.

## TOML

```ts
import {
  tomlTokens, tomlErrorMessage, tomlErrorPos,
  tomlTokenCount, tomlTokenKind, tomlTokenStart, tomlTokenEnd, tomlTokenKinds, tomlTokenStarts, tomlTokenEnds,
  TT_*,
} from "../../parsers/toml.ts";
```

Rust (`format/toml/mod.rs`):

```rust
pub fn syntax_error(text: &[u8]) -> Option<(Vec<u8>, u32)> {
    let (message, offset) = TOML::tokens(text).err()?;
    let bom = if text.starts_with(BOM) { BOM.len() } else { 0 };
    Some((message, offset.saturating_sub(bom) as u32))
}
let tokens = TOML::tokens(text).map_err(|_| FormatError::SyntaxError)?;
```

TS:

```ts
if (tomlTokens(text, text.length) !== 0) {
  const message = tomlErrorMessage();                       // Bun's words (a JS string: a diagnostic)
  const offset = Math.max(0, tomlErrorPos() - (hasBom ? 3 : 0));   // Rust `syntax_error`
}
// else: tomlTokenCount(), tomlTokenKind(i), tomlTokenStart(i), tomlTokenEnd(i)
```

* `TOML::tokens(text)` returns `Result<Vec<Token>, (Vec<u8>, usize)>`; here `tomlTokens` returns `0` or `-1`, the
  pair is `tomlErrorMessage()` / `tomlErrorPos()`, the vector is the accessors. The text is **not** stripped of its
  BOM: the scanner skips it (`init_document`) and offsets count it, as Rust.
* The text is validated as UTF-8 as a whole first (`Invalid UTF-8 byte sequence` at the first byte of the first bad
  sequence).
* What tables and keys mean is not looked at (a key can be there twice) and an integer can have any size
  (`keeps_text`): both are fine for the formatter and are what Rust's `tokens` does.

| Rust `TokenKind` | TS                    | the token                             |
| ---------------- | --------------------- | ------------------------------------- |
| `TableOpen`      | `TT_TABLE_OPEN`       | `[` of `[a]`                          |
| `TableClose`     | `TT_TABLE_CLOSE`      | `]` of `[a]`                          |
| `ArrayTableOpen` | `TT_ARRAY_TABLE_OPEN` | `[[`                                  |
| `ArrayTableClose`| `TT_ARRAY_TABLE_CLOSE`| `]]`                                  |
| `Key`            | `TT_KEY`              | one segment of a key, with its quotes |
| `Dot`            | `TT_DOT`              | `.`                                   |
| `Equals`         | `TT_EQUALS`           | `=`                                   |
| `Scalar`         | `TT_SCALAR`           | a string (all of it, quotes and delimiters), a number, a date, a time or a boolean |
| `ArrayOpen`/`Close`  | `TT_ARRAY_OPEN`/`TT_ARRAY_CLOSE`   | `[`, `]`                    |
| `InlineOpen`/`Close` | `TT_INLINE_OPEN`/`TT_INLINE_CLOSE` | `{`, `}`                    |
| `Comma`          | `TT_COMMA`            | `,`                                   |

`Token { kind, start, end }` -> `tomlTokenKind(i)`, `tomlTokenStart(i)`, `tomlTokenEnd(i)`. Comments, white space and
line breaks are not tokens (`tree.rs` finds them in the gaps). For debugging: `tomlTokenKindName(k)`.

## What is not the same as Rust

* **The stack.** Rust asks the stack pointer. YAML has the budget `yamlSetMaxDepth` (1000 by default; Bun's parser
  itself manages ~3000-6000 levels, so a text nested between the two is refused here and not there). The TOML tokenizer
  does not recurse in either.
* **`parse_as_written` of NUL.** Same as Rust (the caller replaces NUL by 1).
* **Allocation.** `yamlParseAsWritten` and `tomlTokens` allocate only to grow their tables, which stay for the next
  text.
* The error `OutOfMemory` of Rust never happens.

## Tests and tools (`tools/parsers/`)

* `selftest.ts`: runs under `node` and compiled (`scriptc build tools/parsers/selftest.ts -o selftest`); Rust has no unit
  tests for these parsers, the cases are the shapes, tokens and errors that the differential tests agreed with Bun on.
* `yaml-diff.ts`, `toml-diff.ts` (run with `bun`): the differential tests against `Bun.YAML.parse` /
  `Bun.TOML.parse` and `bun fmt` (the place of the errors). Options: `--fuzz=N` (mutants of every corpus file),
  `--soup=N` (random strings of pieces), `--gen=N` (TOML: random documents), `--seed=S`, `--no-fmt`, `--show=K`.
* `bench.ts`: throughput on the vscode corpus (`node tools/parsers/bench.ts yaml|toml [reps] [file]`, or compiled).
