# The IR API (`src/format/ir/`): what to write instead of `write!(f, [..])`

This is the contract for everybody who ports code that writes a document: `format/js/**`, `json`, `graphql`, `html`,
`markdown` (the parts that use `ir/`), `yaml`/`css` do not (they print with `css/doc.rs`). It is exact on purpose: follow
it literally. The implementation is `src/format/ir/*.ts` (a port of `vendor/bun/src/format/ir/`, same semantics, same
tracker, same printer); `ir.test.ts` has an example of every builder.

Read `docs/ARCHITECTURE.md` first (erasable TS, `| 0`, no closures per node). Everything below is a *method of
`Formatter`* unless it says otherwise.

```ts
import { Formatter } from "../ir/formatter.ts";
import { token } from "../ir/element.ts";           // token("...") -> handle, register at module level
import { LPAREN, RPAREN, COMMA, SEMI } from "../ir/tokens.ts";   // the common ones
```

## 1. The model in one page

- A document is a **flat pool of elements** written by the formatter in order. Nesting is `startX()` / `endX()` pairs.
  The pool is a struct of arrays (`tag: Uint8Array`, `a`, `b`, `c: Int32Array`), grow-only, per thread, reset per file.
- **Everything is imperative.** Rust's `group(&format_args!("(", soft_block_indent(&x), ")"))` is
  `f.startGroup(); f.token(LPAREN); f.startSoftBlockIndent(); ...x...; f.endSoftBlockIndent(); f.token(RPAREN); f.endGroup();`.
  Rust's `format_with(|f| ..)` / a `Format` struct that is written once is a function call at the place where it is written.
- **No object is allocated per node.** Content that Rust formats more than once or later (`memoized()`, `intern`,
  `capture`, `best_fitting!`) is *captured*: written into the pool behind a skip marker and referred to by an **int
  handle** (`-1` means "nothing was written"). `writeInterned(handle)` writes it again (that is all that writing it costs: one
  element). The elements of a capture stay where they were written.
- **A token** is a keyword or punctuator: `const SEMI = token(";")` once at module level (ASCII, no `\n \r \t`, 1-255
  bytes, spaces allowed: `" = "`), then `f.token(SEMI)`. `f.tokenStr("(")` exists for rare ones (a hash lookup).
- **Text** is a range of the source (`f.textSource(start, end)`, `f.sourceText(start, end)`) or bytes that are copied
  (`f.textBytes(bytes, start, end)`, `f.textBuf()`). Widths are measured when the text is written. No JS strings for
  source text.
- Every element goes through the **tracker**, which knows when a group ends whether something in it forces a line break
  and how wide it is on one line. Hence `f.willBreakFrom(start)` / `f.willBreak(handle)` cost nothing. **Never write into
  `f.st` yourself.**
- A **group id** is an int from `f.groupId()` (never 0). `0` always means "no id" in the API below.
- The printer is Prettier's `printDocToString`, ported from Bun's (not Prettier's: see section 11 for the places
  where they differ by design).

## 2. Lifecycle

```ts
const scratch = new Scratch(options);                           // once per thread (ir/run.ts)
// per file:
const f = startDocument(scratch, source /* Uint8Array */, options /* FormatOptions */, ctx /* FormatContext | null */);
...write the document with f...
const status = finishAndPrint(f, out /* ByteBuf */);            // 0 = FORMAT_OK, else a FORMAT_* code (errors.ts)
```

- `finishAndPrint` returns `FORMAT_NESTED_TOO_DEEPLY` if `f.stack` ran out (below) or `f.context.ranOutOfStack`;
  `FORMAT_TOO_LONG` if the text is longer than JavaScript's strings; `FORMAT_INVALID_DOCUMENT` for a malformed document
  (a bug in the writer). On an error the contents of `out` are not to be used; the file stays as it is.
- Where the cursor marks (`f.cursor(CURSOR_REGION_START / END)`) ended up in the text: `marksStart()`, `marksEnd()` (`run.ts`; -1
  if none), valid until the next print.
- `f.options` is the `FormatOptions` (`options.ts`; see section 9 for the names). `f.source` is the source bytes.
  `f.flavor`, `f.tabWidth` are cached from the options.
- `f.context` is the hook for the language: `class FormatContext { options; ranOutOfStack }` (`ir/context.ts`).
  The JS formatter declares `class JsFormatContext extends FormatContext { file; comments; ... }`, passes one to
  `startDocument`, and reads it with `f.context as JsFormatContext` (or keeps a module-level reference; module state is
  per thread). The IR never looks at it.
- `Formatter.reset` keeps every buffer: formatting the next file allocates nothing.

### The stack (Rust `f.context_mut().has_stack_left()`, `Stack::has_room`)

There is no stack pointer under scriptc, so the stack is a **depth budget** (`src/base/stack.ts`, the numbers and why are in
its header: default 1000 nested "doors"). Where Rust asks `has_stack_left()` before it recurses, TS brackets the recursion:

```ts
if (!f.stack.enter()) return;       // out of room: `f.stack.ranOut()` is now true; write nothing, return
...recurse...
f.stack.leave();                    // exactly once per successful enter(), on every path out
```

"Doors" are the same places as in Rust: the `write!(f, child)` of an expression, a statement, a type, `write_expression`,
and anything that nests in a way of its own. `finishAndPrint` answers `NestedTooDeeply`. A function that already has a depth
parameter can use `f.stack.hasRoomAt(depth)` instead. `Stack.forTree()` is the stack for what builds a tree (the parser).

## 3. Builders: Rust -> TS

Rust names in snake_case, TS in camelCase, the same order of arguments. **Group/indent/etc. pairs: the `end` call must
match the `start` call (same variant, same arguments where the table says so).**

### Lines, spaces, markers (one element each)

| Rust | TS |
| --- | --- |
| `"("` / `token("(")` / `f.write_token("(")` | `f.token(LPAREN)` (handle from `token("(")`), or `f.tokenStr("(")` |
| `soft_line_break()` | `f.softLineBreak()` |
| `soft_line_break_or_space()` | `f.softLineBreakOrSpace()` |
| `hard_line_break()` | `f.hardLineBreak()` |
| `empty_line()` | `f.emptyLine()` |
| `soft_empty_line()` | `f.softEmptyLine()` |
| `soft_empty_line_or_space()` | `f.softEmptyLineOrSpace()` |
| `Line(mode)` for a computed mode | `f.line(LM_HARD)`; modes `LM_SOFT_OR_SPACE, LM_SOFT, LM_HARD, LM_EMPTY, LM_SOFT_OR_SPACE_EMPTY, LM_SOFT_EMPTY` (`element.ts`) |
| `space()` | `f.space()` (the IR element: dropped at the start/end of a line, two in a row are one) |
| `maybe_space(cond)` | `f.maybeSpace(cond)` |
| `expand_parent()` | `f.expandParent()` |
| `line_suffix_boundary()` | `f.lineSuffixBoundary()` |
| `FormatElement::Nop` | `f.nop()` |
| `FormatElement::Cursor(mark)` | `f.cursor(CURSOR_REGION_START)` / `CURSOR_REGION_END` |
| `f.group_id("name")` | `f.groupId()` |

### Groups and indentation (`startX` ... `endX`)

| Rust | TS |
| --- | --- |
| `group(&x)` | `f.startGroup(); ..x..; f.endGroup();` |
| `group(&x).should_expand(b)` | `f.startGroupExpand(b); ..; f.endGroup();` |
| `group(&x).with_group_id(Some(id))` | `f.startGroupId(id); ..; f.endGroup();` |
| `group(&x).with_group_id(id).should_expand(b)` | `f.startGroupWith(id, b); ..; f.endGroup();` (`id` 0 = none) |
| `group(&indent(&soft_line_break_or_space())).with_group_id(Some(id))` | `f.indentedLineGroup(id)` (one element; the long form works too, but is slower) |
| `indent(&x)` | `f.startIndent(); ..; f.endIndent();` |
| `dedent(&x)` | `f.startDedent(); ..; f.endDedent();` |
| `dedent_to_root(&x)` | `f.startDedentToRoot(); ..; f.endDedentToRoot();` |
| `align(n, &x)` | `f.startAlign(n); ..; f.endAlign(n);` (**same `n` in both**; `0` writes nothing) |
| `block_indent(&x)` | `f.startBlockIndent(); ..; f.endBlockIndent();` |
| `soft_block_indent(&x)` | `f.startSoftBlockIndent(); ..; f.endSoftBlockIndent();` |
| `soft_space_or_block_indent(&x)` | `f.startSoftSpaceOrBlockIndent(); ..; f.endSoftSpaceOrBlockIndent();` |
| `soft_block_indent_with_maybe_space(&x, b)` | `f.startSoftBlockIndentWithMaybeSpace(b); ..; f.endSoftBlockIndentWithMaybeSpace(b);` (**same `b`**) |
| `soft_line_indent_or_space(&x)` | `f.startSoftLineIndentOrSpace(); ..; f.endSoftLineIndentOrSpace();` |
| `line_suffix(&x)` | `f.startLineSuffix(); ..; f.endLineSuffix();` |
| `labelled(LabelId::of(JsLabels::MemberChain), &x)` | `f.startLabelled(LABEL_MEMBER_CHAIN); ..; f.endLabelled();` |
| `indent_if_group_breaks(&x, id)` | `f.startIndentIfGroupBreaks(id); ..; f.endIndentIfGroupBreaks(id);` (**same `id`**) |

### Conditional content

| Rust | TS |
| --- | --- |
| `if_group_breaks(&",")` (a token) | `f.tokenIfBreaks(COMMA)` (one element: use it for every `if_group_breaks(&"x")`) |
| `if_group_breaks(&x)` | `f.startIfGroupBreaks(); ..; f.endConditional();` |
| `if_group_breaks(&x).with_group_id(Some(id))` | `f.startIfGroupBreaksId(id); ..; f.endConditional();` |
| `if_group_fits_on_line(&x)` | `f.startIfGroupFits(); ..; f.endConditional();` |
| `if_group_fits_on_line(&x).with_group_id(Some(id))` | `f.startIfGroupFitsId(id); ..; f.endConditional();` |
| `FormatTrailingCommas::ES5.fmt(f)` (a trailing comma if the options allow) | `f.writeTrailingCommas(FTC_ES5, COMMA)` (`FTC_ALL`, `FTC_ARGUMENTS`, `FTC_ES5`) |
| `FormatTrailingCommas::X.trailing_separator(options)` | `trailingSeparator(FTC_X, f.options)` -> `TRAILING_SEPARATOR_ALLOWED / DISALLOWED / MANDATORY / OMIT` |

A group id used by `ifBreak`/`indentIfBreak` must belong to a group that has been *printed* earlier in the document (or is
the enclosing group); the printer refuses a document that asks about a group it has not seen (`FORMAT_INVALID_DOCUMENT`).
That is Bun's rule too.

### Fill

`f.fill()` + `FillBuilder::entry(sep, item)` + `finish()`:

```ts
f.startFill();
let first = true;
for (...) {
  if (!first) { f.startEntry(); /* the separator, e.g. */ f.softLineBreakOrSpace(); f.endEntry(); }
  first = false;
  f.startEntry(); /* the item */ ...; f.endEntry();
}
f.endFill();
```

Items and separators alternate, each is one entry (`startEntry`/`endEntry`), the first item has no separator before it.
(Rust's `FillBuilder::entry` writes the separator *before* the item unless it is the first.)

### Join

`f.join_with(sep).entry(..).entries(..)`:

```ts
let first = true;
for (...) { if (!first) { ..write sep..; } first = false; ..write entry..; }
```

`f.join()` is the same with no separator. `JoinNodesBuilder` and `FormatSeparatedIter` are `js/builders.rs`: port them there.

## 4. Text

| Rust | TS |
| --- | --- |
| `source_text(span)` (an identifier, a number, a regex: no `\n`, no tab) | `f.sourceText(start, end)` |
| `text(&source[a..b])` (anything but `\r`, a range of the source) | `f.textSource(a, b)` |
| `text_without_whitespace(&source[a..b])` | `f.textSourceNoWs(a, b)` |
| `text(&owned)` (bytes that are not the source: copied) | `f.textBytes(bytes, a, b)` |
| `text_without_whitespace(&owned)` | `f.textBytesNoWs(bytes, a, b)` |
| `f.write_text(bytes, Some(width))` | `f.textSourceWithWidth(a, b, w)` / `f.textBytesWithWidth(bytes, a, b, w)` with `w = twSingle(n) / twMultiline(n) / twMultilineString(n)` (`element.ts`) |
| `f.write_built_text(\|out\| ..)` | `const buf = f.textBuf(); const at = buf.len; ..append to buf..; f.endBuiltText(at);` |
| a text from a JS string (rare, slow: UTF-8 encodes) | `f.textStr(s)` |
| `f.string_width(bytes)` | `f.stringWidth(bytes, a, b)` |
| `TextWidth::from_text(bytes, _)` | `f.textWidth(bytes, a, b)` -> packed `TextWidth`; `twValue(w)`, `twIsMultiline(w)`, `twIsOneString(w)` |
| `f.is_plain_source(span)` | `f.isPlainSource(a, b)` |

`sourceText` is the cheapest (a range of the source, width = length, if the 64-byte blocks it is in are plain ASCII) and
handles `ab`-style escapes in names by writing the name. A text that has a tab or a line break must not use it: the
`text*` forms measure the width up to the first line break; a text with a line break breaks the groups around it
(`TextWidth::multiline`), unless it is `twMultilineString` (one string to Prettier: `` `a\nb` `` in a template).

`\r` is never in a text (the text is normalized first, as in Rust).

## 5. Captured content

Rust `memoized()`, `intern`, `capture`, `speculate_will_break`, `write_into` are all one thing here:

```ts
const slot = f.startCapture();   // nothing is moved: what is written next is not part of the document yet
...write the content (any builders)...
const h = f.endCapture(slot);    // int handle, or -1 if nothing was written
```

| Rust | TS |
| --- | --- |
| `let m = content.memoized();` ... `write!(f, m)` | `const slot = f.startCapture(); ..content..; const h = f.endCapture(slot);` ... `f.writeInterned(h)` |
| `m.inspect(f).will_break()` | `f.willBreak(h)` |
| `m.inspect(f).may_directly_break(flavor)` | `f.mayDirectlyBreak(h)` |
| `m.inspect(f).has_label(label)` | `f.hasLabel(h, label)` |
| `f.intern(&content) -> Option<FormatElement>` | `endCapture` (the handle; `-1` is `None`); write it with `f.writeInterned(h)` |
| `element.will_break(f)` | `f.willBreak(h)` |
| `f.capture(&content) -> Interned` | same as `intern` |
| `f.write_into(&mut vec, &content)` / `take_vec` / `recycle_vec` | `const vec = f.takeVec();` (an `I32Vec` of handles) `vec.push(handle)` ... `f.recycleVec(vec)` |
| `f.write_element(*element)` for an interned element | `f.writeInterned(h)` |
| `f.speculate_will_break(&content)` | the JS formatter's own: save the comments cursor, capture, `f.willBreak(h)`, restore (it is in `js/builders.rs`) |
| `f.elements().len()` | `f.len()` |
| `f.elements_from(start).will_break()` | `f.willBreakFrom(start)` |
| `f.elements_from(start).may_directly_break(flavor)` | `f.mayDirectlyBreakFrom(start)` |
| `f.elements_from(start).has_label(label)` | `f.hasLabelFrom(start, label)` |
| `f.print_to_text(&content)` | `f.printToText(h, outBuf)` (capture first; returns false if it could not be printed) |

Facts to rely on:

- A capture of **one element** is written as that element by `writeInterned` (not as a nested range), exactly as Bun's
  `Memoized::fmt` does. A capture that wrote nothing is `-1`, and `writeInterned(-1)` writes nothing.
- `f.willBreak(h)` is true if the content has a hard line break, a text with a line break, an expanded group or an
  `expandParent` outside of a line suffix (Bun's `Storage::will_break`).
- Comments (the JS cursor): a capture is formatted *now*. Exactly as in Rust, anything with side effects (the comments
  cursor) that you format ahead of its turn has to be used, or you must save/restore the cursor yourself.
- Nested captures are fine (start/end must nest properly: end the inner before the outer).

### Reserved start tags (`f.reserve_tag()` / `group_from`)

```ts
const start = f.reserveTag();                    // a place for a StartGroup that is not known yet
...write the content...
const shouldExpand = f.willBreakFrom(start + 1); // Rust: f.elements_from(start + 1).will_break()
f.groupFrom(start, shouldExpand);                // makes it a group and writes the EndGroup (or does nothing if `start` is not a reserved place)
```

If you decide *not* to make it a group, simply do not call `groupFrom`: the reserved place is `Nop` and is forgotten by the
tracker. (Bun: `AssignmentLike::fmt` and the arguments of a call.)

### Best fitting (`best_fitting!(a, b, c)`)

Each variant is a capture that is an *entry*. Variants go from the flattest to the most expanded. Write each variant (the
code that writes it may be called several times, or write memoized handles), then the element:

```ts
const s0 = f.startVariant(); ..variant 0..; const v0 = f.endVariant(s0);
const s1 = f.startVariant(); ..variant 1..; const v1 = f.endVariant(s1);
f.bestFitting2(v0, v1);                         // bestFitting3(v0, v1, v2), bestFitting4(...), or bestFittingOf(vec: I32Vec) for more
```

Every variant is formatted, so what they have in common should be a captured handle written with `writeInterned` in each
variant (that is what `memoized()` is for in Rust). `Format` values that Rust passes to `best_fitting!` as closures
(`format_with`) become **a function you call once per variant**. The printer picks the first variant that fits, or the last.
A variant must be written between its `startVariant`/`endVariant` and nothing else may be written in between.
Rust's `best_fitting!` of exactly the same code twice is two calls.

### Without soft lines

```ts
const slot = f.startCapture();
..content..
f.endWithoutSoftLines(slot);       // Rust write_without_soft_lines(&content): written, with soft lines removed
f.endWithLinesRemoved(slot);       // Rust write_with_lines_removed: Prettier's removeLines (the printer still picks among variants)
```

Soft line breaks vanish (`softLineBreak`) or become spaces (`softLineBreakOrSpace`), `ifGroupBreaks` content is dropped, of
several variants the flattest is taken; `indentedLineGroup` becomes a space. (`f.stack` guards the recursion.)

## 6. Embedded text (another source in the same document)

Rust `f.write_embedded(context, source, |f| ..)`:

```ts
f.beginEmbedded(innerSource /* Uint8Array */, offset /* where innerSource starts in f.source if it is a subarray of it, else -1 */);
const outerCx = f.context; f.context = innerContext;     // yours to save/swap/restore
..write the inner document with the same f...
f.context = outerCx;
f.endEmbedded();
```

The inner `sourceText`/`textSource` offsets are relative to `innerSource`; `endEmbedded` rewrites the ranges it wrote into
ranges of the outer source (if `offset >= 0`) or copies `innerSource` into the owned text (else). Group ids and everything the
tracker knows are shared, so a hard line break in the inner text breaks the groups around it.

## 7. Raw access to the pool (html `map_strings`, `sort_imports`, `is_at_start_of_group`)

- `f.tagAt(i)`, `f.argAt(i)` (column `a`), `f.st.b[i]`, `f.st.c[i]`: the element at index `i` of the pool (`element.ts`
  documents the columns of every kind). `f.len()` is the pool length; `f.st.tag[f.len() - 1]` is the last element written.
- Captured content is the elements `[f.capturedStart(h), f.capturedEnd(h))`; skip over the `E_SKIP` elements (jump `a + 1`).
  The kinds are the constants of `element.ts` (`E_TOKEN`, `E_SOURCE_TEXT`, `T_START_GROUP`, ...). A token of up to 12 bytes has
  the kind `TOK_BASE + len` (`TIB_BASE + len` for a token that is only written if the group breaks) and its bytes in `a, b, c`;
  a longer one is `E_TOKEN` with `a` = offset into `tokenBytes()`, `b` = length.
- `f.copyElement(i)` writes a copy of the element at `i` (for `f.write_element(*element)` with an element you read from the
  pool). `f.push4(kind, a, b, c)` writes any element (for `f.write_element(FormatElement::Tag(tag))` with a computed tag).
  Both tell the tracker. Do not copy `E_SKIP`s; use captures.
- `f.st.variants.data[first + k]` are the handles of a `E_BEST_FITTING` (`a` = first, `b` = count).

## 8. Writing a document without a Formatter (JSON)

`Storage` (`ir/storage.ts`) is the pool alone: `st.clear()`, `st.push(kind, a, b, c)`, `st.pushToken(handle)`. The columns of
every kind are in the header of `ir/element.ts`; the ones you need: `E_LINE` (`a` = `LM_*`), `T_START_GROUP` (`a` = group id or
0, `b` = `shouldBreak ? GM_EXPAND << 24 : 0`, `c` = 0), `T_END_GROUP`, `T_START_INDENT` / `T_END_INDENT`,
`T_START_INDENT_WITH_LINE` / `T_END_INDENT_WITH_LINE` (`a` = `LM_*`), `T_START_ALIGN` (`a` = count) / `T_END_ALIGN`,
`T_START_COND` (`a` = group id or 0, `b` = `PRINT_FLAT` or `PRINT_EXPANDED`) / `T_END_COND`, `E_SPACE`, `E_EXPAND_PARENT`,
`E_LINE_SUFFIX_BOUNDARY`, `E_SOURCE_TEXT` / `E_OWNED_TEXT` (`a` = start, `b` = length, `c` = packed width: `twSingle(n)`,
`twMultiline(n)`). A writer that
builds the whole document by itself calls `propagateExpand(rootStart, rootEnd, new Tracker(st))` (`ir/document.ts`) once, and
`printDocument(st, rootStart, rootEnd, source, options, out)` / `printDocumentWithLineEnding(.., lineEnding, out)`
(`ir/printer.ts`; the root is the pool range, the first real element is at index `RESERVED` = 10). It is just as good to use a
`Formatter` for that (`startDocument(.., null)`), which does the tracker's work as it writes; JSON may do either.

## 9. The options (`src/format/options.ts`)

`FormatOptions` is a concrete class with oxc's field names (the Rust file's table is at the top of `options.ts`). Enums are
`SCREAMING_SNAKE` int constants of the same file; Rust methods are functions: `options.semicolons.is_as_needed()` ->
`options.semicolons === SEMICOLONS_AS_NEEDED`; `QuoteStyle::other` -> `quoteStyleOther(q)`; `Flavor::is_oxfmt` ->
`options.flavor === FLAVOR_OXFMT` (or `flavorIsOxfmt`). `set("semi", "false")` takes Prettier's names and returns false for an
invalid value. `Option<T>` fields are `-1` / `""` / `null` when absent (documented per field). `inHtml` is an immutable value:
replace the object (`options.inHtml = copy`), do not write into a shared one.

## 10. Worked example: porting an oxc-style block

Rust (`js/print/statements.rs`):

```rust
fn write_while_or_with_statement<'a>(keyword: &'static str, test: Expr<'a>, body: Stmt<'a>, f: &mut Formatter<'a>) {
    let condition = FormatCondition { test, head: Head::Before(body) };
    write!(f, group(&format_args!(keyword, space(), "(", condition, ")", FormatStatementBody::new(body))));
}

impl<'a> Format<'a> for FormatCondition<'a> {
    fn fmt(&self, f: &mut Formatter<'a>) {
        let test = self.test;
        if f.is_quiet() {
            return match is_negated_logical_expression(test) && hugs_negated_condition(f) {
                true => write!(f, test),
                false => write!(f, group(&soft_block_indent(&test))),
            };
        }
        let end = self.head.end(f);
        let has_comments = f.comments().has_comment_before(test.span().start) || f.comments().has_comment_in_range(test.span().end, end);
        let content = format_with(|f| {
            let previous_limit = f.comments_mut().limit_comments_up_to(end);
            write!(f, FormatNodeWithoutTrailingComments(&test));
            let comments = f.comments().unprinted_comments();
            write!(f, FormatTrailingComments::Comments(comments));
            f.comments_mut().restore_view_limit(previous_limit);
        });
        match !has_comments && is_negated_logical_expression(test) && hugs_negated_condition(f) {
            true => write!(f, content),
            false => write!(f, group(&soft_block_indent(&content))),
        }
    }
}
```

TypeScript:

```ts
const LPAREN = token("(");     // module level, once
const RPAREN = token(")");

function writeWhileOrWithStatement(keyword: number /* token handle */, test: Expr, body: Stmt, f: Formatter): void {
  // `FormatCondition { .. }` is a Format struct that is written once: a function call at the place where it is written.
  f.startGroup();                       // group(&format_args!(..))
  f.token(keyword);
  f.space();
  f.token(LPAREN);
  writeCondition(test, HEAD_BEFORE, body, f);
  f.token(RPAREN);
  writeStatementBody(body, f);          // FormatStatementBody::new(body)
  f.endGroup();
}

function writeCondition(test: Expr, headKind: number, headStmt: Stmt, f: Formatter): void {
  const cx = f.context as JsFormatContext;
  if (cx.isQuiet) {
    if (isNegatedLogicalExpression(test) && hugsNegatedCondition(f)) {
      writeExpr(test, f);                           // write!(f, test)
    } else {
      f.startGroup(); f.startSoftBlockIndent();     // group(&soft_block_indent(&test))
      writeExpr(test, f);
      f.endSoftBlockIndent(); f.endGroup();
    }
    return;
  }
  const end = headEnd(headKind, headStmt, f);
  const hasComments = hasCommentBefore(cx, exprStart(test)) || hasCommentInRange(cx, exprEnd(test), end);
  const hug = !hasComments && isNegatedLogicalExpression(test) && hugsNegatedCondition(f);
  // `content` is a format_with closure that is written exactly once, in one of two places: call it where it is written.
  if (!hug) { f.startGroup(); f.startSoftBlockIndent(); }
  const previousLimit = limitCommentsUpTo(cx, end);
  writeNodeWithoutTrailingComments(test, f);
  writeTrailingCommentsUnprinted(cx, f);
  restoreViewLimit(cx, previousLimit);
  if (!hug) { f.endSoftBlockIndent(); f.endGroup(); }
}
```

Rules this example shows, in the order you meet them:

1. `format_args!(a, b, c)` is just `a; b; c;` in order. `group(&format_args!(..))` is `startGroup(); ..; endGroup();`.
2. A `&'static str` that is passed around (`keyword`) is a token handle (`number`), registered at module level.
3. A `Format` struct that is created and written once is a function. A `format_with` closure that is written once is the code
   at the place. If it is written in two branches (`match .. { true => write!(f, content), false => write!(f, group(..content..)) }`),
   decide the wrapper first (`hug`), open it, run the code once, close it. Use `startCapture`/`endCapture` only if Rust
   really writes the same `content` more than once or reads it (`memoized`, `will_break`) before deciding.
4. Arguments of `write!(f, [..])` are evaluated before anything is written; in TS the order of the calls *is* the order of
   evaluation. When an argument's construction has side effects (the comments cursor), keep Rust's order.
5. `Option<impl Format>` writes nothing for `None`: `if (x !== NONE) write(x)`.
6. `&dyn Format` / generics over `Format`: make a function per instantiation, or pass a small `kind` int and `switch`.

A second example, `best_fitting!` with memoized parts (`write_ts_type_assertion` in `js/print/expressions.rs`):

```rust
let format_cast = format_cast.memoized();
let format_expression = expression.memoized();
write!(f, best_fitting![
    format_args!(format_cast, format_expression),
    format_args!(format_cast, group(&format_args!("(", block_indent(&format_expression), ")"))),
    format_args!(format_cast, format_expression)
]);
```

```ts
let slot = f.startCapture(); writeCast(e, f); const cast = f.endCapture(slot);
slot = f.startCapture(); writeExpr(expression, f); const expr = f.endCapture(slot);

let s = f.startVariant();
f.writeInterned(cast); f.writeInterned(expr);
const v0 = f.endVariant(s);

s = f.startVariant();
f.writeInterned(cast);
f.startGroup(); f.token(LPAREN); f.startBlockIndent(); f.writeInterned(expr); f.endBlockIndent(); f.token(RPAREN); f.endGroup();
const v1 = f.endVariant(s);

s = f.startVariant();
f.writeInterned(cast); f.writeInterned(expr);
const v2 = f.endVariant(s);

f.bestFitting3(v0, v1, v2);
```

## 11. Where this printer is not Prettier's (so that you do not chase it)

Bun's printer is the specification; these are by design and are in Bun too:

- **A line break on an empty line prints nothing** (`hardLineBreak(); hardLineBreak()` is one line break). Use `emptyLine()`
  (or `softEmptyLine`...) for a blank line. Prettier prints `\n\n` for two hardlines.
- **`space()`** is not a text: it is dropped at the start and the end of a line (Prettier's `" "` is kept).
- **A `fill` after a best-fitting variant that was chosen because it fits up to its first forced line break, and a fill
  inside a fill item that has a hard line break**, are not measured the way Prettier measures them
  (`print_fill_entries` trusts `measured_group_fits` while the printer is in flat mode). `tools/ir-fuzz.ts` (random
  documents against Prettier's `printDocToString`) therefore never puts a fill and a best-fitting in one document; without
  that it matches 100% of 12,000 documents (depth 2-5), and 99.97% of the ones with nested fills at depth 4. Every difference
  found was in those two classes.
- The width of an emoji sequence joined by a ZWJ that is not in `emoji-regex`'s list (`ir/width.rs` `emoji_len`) is the width
  of the whole sequence (2).
- Group ids: asking for the mode of a group that has not been printed is `FORMAT_INVALID_DOCUMENT` (Prettier assumes flat).

## 12. Performance rules for code that writes documents

- No closure, no array literal, no `new` per node: `f.startGroup()` etc. are method calls on a concrete class (inlined).
- Prefer the fused builders: `tokenIfBreaks(COMMA)` for `if_group_breaks(&",")`; `startSoftBlockIndent`/`endSoftBlockIndent` for
  `soft_block_indent`; `indentedLineGroup(id)`; `token(h)` for tokens; `sourceText(a, b)` for identifiers and numbers.
- Do not call `f.stack.enter()` per element; per door as in Rust.
- Decide from the syntax first, look at the source text or the comments last (`f.isQuiet`-style checks in the JS context).
- `f.textStr(s)` and `f.tokenStr(s)` are slow paths (UTF-8 encoding, a hash lookup).
- The IR measured on a synthetic JS-like document (`src/format/ir/bench.ts`, 1000 documents of ~3,800 elements, compiled,
  M5 Pro): writing 4-5 ns/element (the benchmark's own generator adds 2), printing
  ~5.7 ns/element = ~380 MB/s of output. `scriptc build src/format/ir/bench.ts -o /tmp/ir-bench && /tmp/ir-bench`.

## 13. Tools and tests

- `node src/format/ir/ir.test.ts` (or the compiled binary): 66 documents with their expected text, behaviours specific to `ir/`,
  and a checksum of 3000 random documents (identical under `node` and compiled).
- `PRETTIER_DOC=<prettier>/doc.js node tools/ir-fuzz.ts 3000 1 4` compares random documents with Prettier's `printDocToString`
  (`SHRINK=1 SHOW=3` minimizes a mismatch); `node tools/ir-check.ts` checks that the expectations of `cases.ts` are Prettier's;
  `node tools/width-fuzz.ts` and `node tools/text-fuzz.ts` compare string widths and the text helpers with Prettier's utilities.
- `src/format/ir/testdoc.ts` is a tree description of documents (`D`) with `emit(emitter, doc)` that writes it with the API above:
  the easiest way to write a test for your own builder.
