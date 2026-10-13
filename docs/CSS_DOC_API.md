# `css/doc` API: Rust -> TS (`src/format/css/doc.ts`, `sink.ts`, `memo.ts`)

For the ports of `yaml`, `markdown`, `handlebars`, `graphql`, `html` (and `css`, the owner): everything of
`vendor/bun/src/format/css/doc.rs` that those use, in TS. Read `docs/ARCHITECTURE.md` first. The implementation passes a
differential fuzz against Prettier 3.9.6's own `printDocToString` (`node tools/css/doc-fuzz.ts [count] [seed] [depth]`:
50,000 random documents with every builder; the only differences are Rust's own, see "Known differences" at the end).

```ts
import {
  docPool, docReset, docPush, docPop,                      // the pool of Doc trees
  DOC_EMPTY, DOC_LINE_DOC, DOC_SOFTLINE, DOC_HARD_LINE, DOC_LITERAL_LINE, DOC_BREAK_PARENT_DOC, DOC_LSB_DOC, DOC_HARDLINE,
  docText, docAscii, docBegin, docAdd, docArray, docFill, docs2, docs3, docs4, joinList,
  hardline, indent, group, groupWith, alignWithSpaces, alignTextId, textToDoc, replaceEndOfLineWithLiteralLines,
  Elements, Printer, printDoc,
  LINE_SPACE, LINE_SOFT, LINE_HARD, LINE_LITERAL,
  IC_INDENT, IC_ALIGN_SPACES, IC_ALIGN_TEXT, IC_ALIGN_IF_BREAK, IC_DEDENT, IC_DEDENT_TO_ROOT, IC_MARK_AS_ROOT,
  DOC_TEXT, DOC_ARRAY, DOC_INDENT, DOC_ALIGN, DOC_DEDENT, DOC_DEDENT_TO_ROOT, DOC_MARK_AS_ROOT, DOC_GROUP, DOC_FILL,
  DOC_IF_BREAK, DOC_LINE_SUFFIX, DOC_LINE_SUFFIX_BOUNDARY, DOC_BREAK_PARENT, DOC_LINE,
} from "../css/doc.ts";
```

Conventions of the port: `Doc` is an `Int32` **handle** (a node of the per-thread pool `docPool`), `Option<usize>` is `-1`,
`Result<_, FormatError>` is an `Int32` code (`0` = ok, else `FORMAT_*` of `src/format/errors.ts`), `&[u8]` is
`(bytes: Uint8Array, start, end)`, `&'static str` / `&str` literals are JS strings of **printable ASCII** (they are
copied byte by byte; for anything else use bytes), `Vec<Doc>` is a list under construction on the pool's stack.

## 1. `Doc` (the tree) and its pool

A `Doc` is a handle. Nodes are **immutable** and may be shared (a DAG): `join` uses one separator many times, a node can be in
two parents. Texts are **copied** into the pool (`docText(src, start, end)`), so the source buffer may change afterwards.
There are no `Cow`/`Drop`/`take()`: functions that Rust applies in place (`clean`, `strip_trailing_hardline`) return a
handle (the same one when nothing changed).

**Lifetime of the pool** (per thread, grow-only):
- `docReset()` forgets every document made so far. Call it **once at the start of a format call that builds `Doc`s**
  (`markdown::format`, `yaml::document`'s caller, ...), never inside a function that can run while a document of an outer
  format is being built (embedded code: markdown -> css/yaml, handlebars -> css). Those wrap their work in `docPush()` ...
  `docPop()` (a stack): `docPop` forgets what was made since the matching `docPush`, so only call it when the handles made
  in between are dead (e.g. after printing them with `printDoc`, or after copying their text out). A document that is
  *returned* to the caller (Rust `css::document(..) -> Doc<'static>`, `yaml::document`) must not be popped: it is made in the
  caller's pool epoch and lives until the caller's next `docReset`.
- Preallocated handles (valid always, never reset): `DOC_EMPTY` (`Doc::EMPTY`), `DOC_LINE_DOC` (`Doc::LINE`),
  `DOC_SOFTLINE` (`Doc::SOFTLINE`), `DOC_HARD_LINE` (`Doc::Line(Line::Hard)`), `DOC_LITERAL_LINE` (`Doc::Line(Line::Literal)`),
  `DOC_BREAK_PARENT_DOC` (`Doc::BreakParent`), `DOC_LSB_DOC` (`Doc::LineSuffixBoundary`), `DOC_HARDLINE`
  (`hardline()` = `[Line(Hard), BreakParent]`).

### Building

| Rust | TS |
|---|---|
| `Doc::from(text: &[u8])` / `Doc::from(Vec<u8>)` / `Cow` | `docText(src, start, end)` (copies); `Doc::from(vec)` is `docText(vec.data, 0, vec.len)` |
| `Doc::from("literal")` | `docAscii("literal")` |
| `Doc::EMPTY`, `Doc::LINE`, `Doc::SOFTLINE` | `DOC_EMPTY`, `DOC_LINE_DOC`, `DOC_SOFTLINE` |
| `Doc::Line(Line::Hard)`, `Doc::Line(Line::Literal)`, `Doc::BreakParent`, `Doc::LineSuffixBoundary` | `DOC_HARD_LINE`, `DOC_LITERAL_LINE`, `DOC_BREAK_PARENT_DOC`, `DOC_LSB_DOC` |
| `Doc::Line(l)` | `docPool.line(l)` (`l` is `LINE_SPACE`/`LINE_SOFT`/`LINE_HARD`/`LINE_LITERAL`) |
| `hardline()` | `hardline()` (= `DOC_HARDLINE`) |
| `docs![a, b, c]` | `docs3(a, b, c)`; also `docs2`, `docs4`; more parts: a list (below) |
| `Doc::Array(vec)` | `const m = docBegin(); docAdd(x); docAdd(y); ...; const d = docArray(m);` |
| `Doc::Fill(vec)` / `fill(vec)` | the same with `docFill(m)` |
| `vec.push(x)` / `parts.extend([a, b])` | `docAdd(x)` / `docAdd(a); docAdd(b)` |
| `vec.len()`, `vec[i]`, `vec.pop()` | `docPool.count(m)`, `docPool.part(m, i)`, (no pop: build in order) |
| `vec.extend(parts_of(array))` | `docPool.addParts(arrayDoc)` |
| dropping a half-built list | `docPool.abandon(m)` |
| `join(&separator, docs)` | add the docs to a list, then `joinList(separator, m)` (spreads the separator in place), then `docArray(m)` |
| `indent(x)` | `indent(x)` |
| `group(x)` / `group_with(x, should_break)` | `group(x)` / `groupWith(x, shouldBreak)` |
| `Doc::Group { contents, should_break, id, is_conditional }` | `docPool.groupFull(contents, shouldBreak, id, isConditional)` |
| `align_with_spaces(w, x)` | `alignWithSpaces(w, x)` |
| `Doc::Align(Alignment::Text("> "), x)` | `docPool.alignWithText(alignTextId("> "), x)` (register the text once at module init: `const QUOTE = alignTextId("> ")`) |
| `Doc::Align(Alignment::IfBreak { group_id, broken, flat }, x)` | `docPool.alignIfBreak(groupId, broken, flat, x)` |
| `Doc::Dedent(x)`, `DedentToRoot`, `MarkAsRoot`, `LineSuffix` | `docPool.dedent(x)`, `.dedentToRoot(x)`, `.markAsRoot(x)`, `.lineSuffix(x)` |
| `Doc::IfBreak { break_contents, flat_contents, group_id }` | `docPool.ifBreak(breakContents, flatContents, groupId)` (`groupId` 0: the group it is in) |
| `Doc::Text(Cow::Owned(vec![b' '; n]))` | `docPool.repeated(32, n)` |

A list under construction is a mark on the pool's scratch stack (`docBegin()` returns it). Lists nest like a stack: you may
build a list inside the construction of another one as long as the inner one is finished (`docArray(m2)`) or abandoned before
you add to the outer. A `docArray(m)` with the parts of the list since `m` removes them from the stack.

### Taking apart (Rust `match doc { Doc::Array(parts) => .. }`)

```ts
const p = docPool;                      // hoist: p.tag, p.a, p.b, p.c, p.d, p.e, p.kids, p.bytes
const tag = p.tag[d] | 0;               // DOC_TEXT, DOC_ARRAY, ...
```
| Tag | fields |
|---|---|
| `DOC_TEXT` | bytes `p.bytes[p.a[d] .. p.a[d] + p.b[d])` (`p.a` start, `p.b` length; length 0 is an empty text: `p.isEmptyText(d)`) |
| `DOC_ARRAY`, `DOC_FILL` | `p.b[d]` parts; part `i` is `p.kids[p.a[d] + i]` |
| `DOC_INDENT`, `DOC_DEDENT`, `DOC_DEDENT_TO_ROOT`, `DOC_MARK_AS_ROOT`, `DOC_LINE_SUFFIX` | contents `p.a[d]` |
| `DOC_ALIGN` | contents `p.a[d]`; alignment kind `p.b[d]` (`IC_ALIGN_SPACES` -> width `p.c[d]`; `IC_ALIGN_TEXT` -> text id `p.c[d]`; `IC_ALIGN_IF_BREAK` -> group id `p.c[d]`, broken `p.d[d]`, flat `p.e[d]`) |
| `DOC_GROUP` | contents `p.a[d]`; `should_break = (p.b[d] & 1) != 0`, `is_conditional = (p.b[d] & 2) != 0`, `id = p.c[d]` |
| `DOC_IF_BREAK` | break contents `p.a[d]`, flat contents `p.b[d]`, group id `p.c[d]` |
| `DOC_LINE` | `p.a[d]` is `LINE_*` |
| `DOC_LINE_SUFFIX_BOUNDARY`, `DOC_BREAK_PARENT` | nothing |

To "modify" (Rust `take()` + rebuild): build a new node from the parts. `Doc::is_empty_text()` is `docPool.isEmptyText(d)`.

### Functions on whole documents

| Rust | TS |
|---|---|
| `doc::text_to_doc(doc) -> Result<Doc, FormatError>` | `textToDoc(doc): number` -> the handle, or `-1` for `NestedTooDeeply` |
| `doc::replace_end_of_line_with_literal_lines(Cow<[u8]>) -> Doc` | `replaceEndOfLineWithLiteralLines(src, start, end)` |
| `doc::print(doc, options, text, &mut out) -> Result<(), FormatError>` | `printDoc(doc, options, text, out: ByteBuf): number` (0 or `FORMAT_*`); `text` is only read for `endOfLine: "auto"` |
| `elements.document(&doc)` | `elements.document(doc)` |

## 2. `Elements` (a document in one piece) and `Printer`

`Elements::default()` is `new Elements()`; keep one per thread in your scratch and call `elements.clear()` per file (this is
what `Scratch.elements` does in Rust). `Elements` is written from the first to the last part, exactly as in Rust (the
element list is shorter than the document: adjacent texts merge, a group of only text is one element -- ask `position()`).

Every method of Rust's `Elements` that other formatters use:

| Rust | TS (`elements.`) |
|---|---|
| `clear()` | `clear()` |
| `text(&[u8])` | `text(src, start, end)` (copied; width = `string_width`) |
| `token("..")` (printable ASCII) | `token("..")` |
| `text_group()` | `textGroup()` |
| `line(Line::Space/Soft/Hard/Literal)` | `line(LINE_SPACE / LINE_SOFT / LINE_HARD / LINE_LITERAL)` |
| `hard_line()` | `hardLine()` (a `hardline` = the line + `breakParent`) |
| `break_parent()` | `breakParent()` |
| `keep_blanks()` | `keepBlanks()` |
| `line_suffix_boundary()` | `lineSuffixBoundary()` |
| `start_group(Group { should_break, id, is_conditional })` / `Group::default()` | `startGroup(shouldBreak, id, isConditional)` / `startPlainGroup(shouldBreak)`; `id` 0 = none |
| `end_group()` | `endGroup()` |
| `start_indent(IndentCommand::Indent)` | `startIndent()` |
| `... ::Dedent`, `DedentToRoot`, `MarkAsRoot` | `startDedent()`, `startDedentToRoot()`, `startMarkAsRoot()` |
| `... ::Align(Alignment::Spaces(w))` | `startAlign(w)` |
| `... ::Align(Alignment::Text("> "))` | `startAlignText(alignTextId("> "))` |
| `... ::Align(Alignment::IfBreak { group_id, broken, flat })` | `startAlignIfBreak(groupId, broken, flat)` |
| `end_indent()` | `endIndent()` (also ends align/dedent/...) |
| `start_fill()`, `end_fill()`, `start_item()`, `end_item()` | `startFill()`, `endFill()`, `startItem()`, `endItem()` |
| `start_if_break(group_id)`, `otherwise()`, `end_if_break()` | `startIfBreak(groupId)`, `otherwise()`, `endIfBreak()` |
| `start_line_suffix()`, `end_line_suffix()` | `startLineSuffix()`, `endLineSuffix()` |
| `position()`, `remove_lines_from(start)` | `position()`, `removeLinesFrom(start)` |
| `nest_fill()`, `start_fill_with_hard_line()`, `end_cleaned_fill()`, `end_fill_as_array()` | the same names in camelCase |
| `document(&doc)` | `document(doc)` |
| `to_tree() -> Result<Doc<'static>, FormatError>` | `toTree(): number` -> handle, `-1` = `NestedTooDeeply` |

`Printer`:
```ts
const printer = new Printer();                 // keep one in your scratch and call init() again
printer.init(options, original /* Uint8Array: the text, for endOfLine "auto" */, out /* ByteBuf */);
printer.print(elements, 0, 0);                 // indent id 0 (the root), column 0; returns the column behind it
const r = printer.result();                    // 0 or a FORMAT_* code (TooLong, NestedTooDeeply)
```
`Printer::new(options, text, out)` = `new Printer()` + `init(options, text, out)`. `out` is the `ByteBuf` the output is
appended to (it can already hold text; `trim`s never go before where it was at `init`). The other `Printer` methods used by the
CSS sink: `indented(indent)`, `dedented(indent)`, `aligned(indent, width)` (indent ids are `Int32`, 0 is the root),
`writeHardLine(indent): column`, `writeText(bytes, start, end)`, `fail(code)`.

## 3. `Sink` (`sink.ts`): only `css` uses it

Nobody outside `src/format/css/` uses `Sink` (the other formatters write `Elements` directly); it is documented in the header
of `sink.ts`. It is a class (`new Sink()`, `toOutput(printer, isCleaned)` / `toDocument()`, `startUnit()`/`endUnit()`/
`startDocument()`/`endDocument()`, the parts of a document as methods, `SEP_*` for `fillSeparator`). `Mark` is kept inside
the sink (one unit at a time). `intoDocument()` returns a `Doc` handle (-1 on error).

## 4. `Memo` (`memo.ts`)

Per thread (one in the css `Scratch`), 1 MB. `memo.context(flags, atRuleBytes, start, end): number`,
`memo.get(context, text, start, end): boolean` (hit: `memo.outStart/outEnd` index `memo.bytes`, `memo.hasGroup`),
`memo.insert(context, text, start, end, output, outStart, outEnd, hasGroup)`. The key rules are those of
`vendor/bun/src/format/CLAUDE.md` ("`css/memo.rs` keeps ...").

## 5. Known differences (all are Rust's, which we follow, not Prettier's)

- A `numberAlign` followed by an `indent` with `useTabs` prints blanks then a tab (Prettier: two tabs). Rust:
  `Written::Blanks` for every `Align`. Prettier's printer also does not add the width of the last text to `position` when no
  command follows (`commands.length > 0`); Rust does. A group of a nested `lineSuffix` that follows can therefore differ.
- An `ifBreak` that asks about a group that has not been printed prints neither contents (Prettier: the flat contents).
- Output of `Elements::to_tree`/`Doc` for `Alignment::IfBreak` exists once (a document of Prettier may share it).
