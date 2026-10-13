# LINT_AST_API: the handles the JS formatter reads (`src/lint/ast/`)

The contract for the engineers who port `vendor/bun/src/format/js/**`. It maps every method of every handle of
`vendor/bun/src/lint/ast/*.rs` (`File`, `Expr`, `Stmt`, `TypeNode`, `Pat`, `Func`, `Class`, `Member`, `Prop`, `Name`, `Ident`, `List`,
`Node`, ...) and the text scanners under them (`lint/tokens`, `sema/check/spans.rs`, `sema/bind/parents.rs`) to TypeScript functions, and says
how the Rust idioms (`match e.kind()`, `Option<Handle>`, iterators, `Node`, `Span`) become code with no allocation. Read
`docs/HIR_API.md` first (the tables these functions read), and `docs/ARCHITECTURE.md` (hot-path rules).

| Rust | TS |
| ---- | -- |
| `vendor/bun/src/lint/ast/mod.rs` (`File`, `Lazy`) | `src/lint/ast/mod.ts` (`fileBegin`, file queries), `src/lint/ast/state.ts` (the per-file state `F`, `TP`, scratch) |
| `lint/ast/{expr,stmt,ty,pat,decl,flow,name,list,node,walk,entities}.rs` | `src/lint/ast/{expr,stmt,ty,pat,decl,flow,name,list,node,walk,entities}.ts` (+ `keys.ts`: the constants of keys) |
| `lint/span.rs` | `src/lint/span.ts` (`SP`) |
| `lint/tokens/mod.rs` (`skip_trivia`, `token_len`, `next_token`, `file.comments()`) | `src/lint/tokens/mod.ts` |
| `sema/check/spans.rs` (the text scanners) | `src/sema/check/spans.ts` |
| `sema/bind/parents.rs` (`try_bind_for_format_in`) | `src/sema/bind/parents.ts` (`fillParents`, `bound`) |
| `lint/linter/syntax/mod.rs::goes_to_flow` | `src/lint/linter/syntax/mod.ts` (`goesToFlow`) |
| `lint/utils/{text,node}.rs`, `lint/paths.rs` (the parts the formatter calls) | `src/lint/utils/{text,node}.ts`, `src/lint/paths.ts` |
| (the barrel the formatter imports) | `src/lint/ast/index.ts` |

**Import everything from `src/lint/ast/index.ts`** (`import { exprTag, EXPR_DOT, exprDotObj, SP, ... } from "../../lint/ast/index.ts"`). It re-exports
the HIR (`hir`, all `EXPR_*`/`STMT_*`/`TYPE_*`/`PAT_*`/`FLAG_*`/enum constants, the generated payload accessors, `hir_util.ts`), the atoms (`A_*`), the span
slot, and every module below. Where a name exists in both the HIR and here (`exprTag`, `stmtTag`, `typeTag`, `patTag`, `exprEnd`, `stmtStart`, `typeEnd`,
`patEnd`, `exprStringValue`, `exprTemplateExprsStart/Len`), this layer's one is exported: it knows what the Rust handle knows (a backtick string is a
template; a name written with an escape ends later; ...).

## 1. Life of a file

```ts
import { names } from "../sema/parser/parser/mod.ts";          // the parser's atom table
import { parseFile } from "../sema/parser/parser/run.ts";      // beginFile, lex, parse, finishHir
import { fileBegin } from "../lint/ast/index.ts";

const refusal = parseFile(src, len, path, isScript);           // 0: parsed
if (refusal === 0) {
  fileBegin(names, parserIsTypeScript, !isScript);             // ONCE per file, before any handle is read
  ... write_program ...
}
```

`fileBegin(names, parserIsTypeScript, isModule)` (mod.ts):

* `parserIsTypeScript`: Rust `LanguageOptions.parser == Parser::TypeScript`, i.e. the extension is `.ts .tsx .mts .cts` (the driver sets `Parser::Espree` for
  everything else). It only decides JSX text unescaping (espree/acorn-jsx vs typescript-estree) and the comment list of a script.
* `isModule`: `languageOptions.sourceType == "module"` (`!is_script`).
* It fills the parent tables (`fillParents`: one pass over the HIR, `bound.complete` tells that every node is part of something), the bit per parenthesized
  expression, the positions of every `\u` in the text, and finds the `#!` line. Everything else Rust computes lazily is built on first use (the parents of types,
  `<a.b>` tags of JSX, the `{` of each function body). A file is valid until the next `parseFile`/`fileBegin` on the thread.
* The handles are about ONE file per thread (module state: `hir`, `bound`, `F`, `TP`): like the HIR itself they are per worker thread under node and scriptc.

## 2. Representation

### Ids, `Option`, flags

A handle is an **Int32 row index** of a table of `hir` (an `ExprId` is a row of `hir.exprs`, ...). `Option<Handle>` is **`-1`** (`NONE`). `Option<Name>` /
`Option<Atom>` is `-1` too. `bool`s are `boolean`. `Flags` are `FLAG_*` bits: `f.contains(FLAGS_X)` is `(f & FLAG_X) !== 0` (or `=== FLAG_X` for several
bits), `f.intersects(A | B)` is `(f & (FLAG_A | FLAG_B)) !== 0`. `Option<BinOp>` of an assignment is the HIR's encoding: `0` = plain `=`, else `BIN_x + 1`.
Reads of typed arrays that are stored or passed are `| 0`-ed (the functions here do it; do it in your own code).

### `Name`, `Ident`

* `Name` (the text of an identifier, a key, a string) **is its atom**: an Int32 of the file's atom table (`names`), interned, so `a == b` is `a === b`.
  `ExprKind::Ident(name)`, `Name::bytes()`: `nameBuf(a)`, `nameStart(a)`, `nameLen(a)` (the bytes are `nameBuf(a)[nameStart(a) .. nameStart(a) + nameLen(a))`),
  `name.is("x")`: `nameIs(a, "x")` (ASCII; compares bytes), or `a === A_x` for a known atom (`A_default`, `A_constructor`, ... in `sema/atom.ts`: use these on hot
  paths). `name.atom()` is `a`. Names are resolved: the value of `a` is `a`.
* `Ident` (a name where it is written) is **TWO numbers `(atom, start)`**: every accessor that returns an `Ident` has a pair `xxxName(h)` / `xxxNamePos(h)`
  (`funcName`/`funcNamePos`, `importSpecLocal`/`importSpecLocalPos`, `exprDotName`/`exprDotNamePos`, ...), and every function that takes one takes both.
  `ident.span()`: `identSpan(atom, start)` into `SP`, or `identEndOf(atom, start)` for the end only. `ident.is_string()`: `identIsString(start)`.
* `EntityName` (`A.B.C` in a type) is a list `(start, len)` of NameIds: part `i` is the Ident `(entityAtom(start, i), entityPos(start, i))`;
  `entitySpan(start, len)` into `SP`; `entityIs(start, len, "x")`.

### Spans: `SP`

A Rust `Span { start, end }` is **never an object**. `SP` is a module-level `Int32Array`: a function that returns a `Span` writes `SP[0] = start`,
`SP[1] = end` and returns nothing; `Option<Span>` returns a `boolean` (false: `None`, `SP` untouched) and writes `SP` when true. **Read both ends right
after the call**: `exprSpan(e); const start = SP[0] | 0, end = SP[1] | 0;` (any other call that returns a span overwrites `SP`). A function that takes a `Span`
takes `(start, end)`. Where one end is all you need there are cheaper `exprStart(e)`, `exprEnd(e)`, `stmtStart/End`, `typeStart/End`, `patStart/End`,
`funcStart/End`, `exprOuterStart/OuterEnd`, `typeOuterStart/OuterEnd`, and for any handle `nodeStart(n)` / `nodeEnd(n)` (n = `nodeOfX(h)`, below).

`Span` arithmetic is inline (see the header of `src/lint/span.ts`): `len` `end - start`; `is_empty` `end <= start`; `to(o)` `(start, o.end)`; `between(o)` `(end, o.start)`;
`contains(o)` `start <= o.start && o.end <= end`; `shrink(a, b)` `(start + a, max(0, end - b))` (`shrinkSpan(start, end, a, b)` writes it to `SP`).
`handle.text()` / `file.slice(span)`: the bytes `hir.text[start .. end)` (`hir.text` is the scratch buffer of the file and may be longer than the source: the
source ends at `hir.sourceLen`; text scanners take `(text, len, ...)` with `len = hir.sourceLen`).

### Lists

A Rust `List<'a, T>` (and `Span<T>`/`IdList<T>`) is **two numbers `(start, len)`**; element `i` is the id `hir.ids[start + i]` = `listAt(start, i)`. A method that returns a
list is a pair: `callArgsStart(c)` / `callArgsLen(c)`. Nothing is hidden from a list (Rust leaves out nodes synthesized from JSDoc comments; this port never has
those).

```ts
const s = callArgsStart(c), n = callArgsLen(c);
for (let i = 0; i < n; i++) { const arg = listAt(s, i); ... }          // list.iter()
n === 0                                                                  // list.is_empty()
n > 0 ? listAt(s, 0) : -1                                                // list.first()   (last: n - 1)
for (let i = n - 1; i >= 0; i--)                                         // list.iter().rev()
```
`List::around(offset)`, `before(start)`, `after(start)`, `index_of_start(start)` take the node kind of the elements: `listAround(N_STMT, s, n, offset)`, `listBefore`,
`listAfter`, `listIndexOfStart` (return the element id / index or -1). `Template::exprs()`, `Jsx::children()` etc. are the same pair pattern.

### `Node`: one Int32 (kind in the high bits)

Rust's `Node` enum (and `Packed`) is **`node = (kind << 26) | id`**, `kind` one of `N_FILE=0, N_EXPR, N_STMT, N_TYPE, N_PAT, N_PAT_PROP, N_PAT_ELEM, N_FUNC, N_PARAM,
N_TYPE_PARAM, N_CLASS, N_MEMBER, N_PROP, N_VAR_DECL, N_CASE, N_ENUM_MEMBER, N_IMPORT_SPEC, N_EXPORT_SPEC, N_TUPLE_ELEM` (the variants in the order of the Rust enum).
`NODE_FILE = 0` is `Node::File`, `-1` is `Option<Node>::None`. A file may have up to 2^26 - 1 rows of one kind. Equal nodes are equal numbers.

| Rust | TS |
| ---- | -- |
| `Node::Expr(e)`, `Stmt(s)`, `Type(t)`, `Pat(p)`, ... | `nodeOfExpr(e)`, `nodeOfStmt(s)`, `nodeOfType(t)`, `nodeOfPat(p)`, `nodeOfPatProp`, `nodeOfPatElem`, `nodeOfFunc`, `nodeOfParam`, `nodeOfTypeParam`, `nodeOfClass`, `nodeOfMember`, `nodeOfProp`, `nodeOfVarDecl`, `nodeOfCase`, `nodeOfEnumMember`, `nodeOfImportSpec`, `nodeOfExportSpec`, `nodeOfTupleElem`; generic `nodeOf(kind, id)` |
| `match node { Node::Expr(e) => .., Node::Stmt(s) => .. }` | `switch (nodeKind(n)) { case N_EXPR: { const e = nodeId(n); .. } case N_STMT: { const s = nodeId(n); .. } }` |
| `node.as_expr()` / `as_stmt()` / `as_type()` / `as_func()` | `nodeAsExpr(n)`, `nodeAsStmt(n)`, `nodeAsType(n)`, `nodeAsFunc(n)` -> id or `-1`; `nodeAsKind(n, kind)`; `nodeIsExpr(n)`, `nodeIsStmt(n)`, `nodeIsFile(n)` |
| `matches!(node, Node::Expr(e) if ..)` | `nodeIsExpr(n) && ..(nodeId(n))` |
| `node.parent()` | `nodeParent(n)` (the file is its own parent) |
| `node.ancestors()` (the parents up to **and including** the file) | `for (let a = nodeParent(n); ; a = nodeParent(a)) { ..; if (a === NODE_FILE) break; }` |
| `node.enclosing_function()`, `enclosing_class()` | `nodeEnclosingFunction(n)` / `nodeEnclosingClass(n)` -> FnId / ClassId or -1 |
| `node.as_written()` | `nodeAsWritten(n)` (a Func or Class -> its owner) |
| `node.span()`, `node.text()` | `nodeSpan(n)` into `SP`; `nodeStart(n)`, `nodeEnd(n)`; text = `hir.text[SP[0] .. SP[1])` |
| `node.file()` | the file is global |
| `Packed` | the same number (`nodeKind`/`nodeId`) |
| `node.for_each_child(f)`, `for_each_child_near(offset, f)`, `children()` | `nodeChildren(n, near, out)`: appends Nodes to the `I32Vec out` in source order (`near = -1`: all; else an offset). `const base = out.len; nodeChildren(n, -1, out); for (let i = base; i < out.len; i++) { const c = out.data[i] | 0; .. } out.len = base;` |

The `AstNodes` view of `format/js/ast_nodes.rs` is yours to write on top of this: `e.ast_parent()` is `nodeParent(nodeOfExpr(e))` and a `switch` on the kind and tag.

### Results that are several values

No function allocates to return several values. The patterns used: the pair `(atom, pos)` for idents, `(start, len)` for lists, `SP` for spans, `KEY[..]` for
keys (below), `I32Vec`s that the caller owns for variable-length results (`exprSequence(e, out)`, `jsxChildrenWithWhitespace(e, out)`, `patBindings(p, out)`,
`nodeChildren(n, near, out)`: they APPEND to `out`; keep `const base = out.len` and reset `out.len = base` when done), and 1-4 fixed `SP` slots (`SP[0..4]`
for the two-span results `exprMetaPropertySpans` and `jsxNamespaceAndName`).

## 3. Patterns: how the Rust code reads

### `match e.kind()` -> `switch (exprTag(e))`

```rust
match e.kind() {
    ExprKind::Dot { obj, name, chain } => f(obj, name, chain),
    ExprKind::Call(call) => g(call.callee(), call.args()),
    ExprKind::String(name) => h(name),
    _ => {}
}
```
```ts
switch (exprTag(e)) {
  case EXPR_DOT: { const obj = exprDotObj(e), name = exprDotName(e), namePos = exprDotNamePos(e), chain = exprDotChain(e); f(..); break; }
  case EXPR_CALL: { const call = exprCallCall(e); const callee = callCallee(call); const as = callArgsStart(call), an = callArgsLen(call); g(..); break; }
  case EXPR_STRING: { const name = exprStringValue(e); h(name); break; }
}
```
The payload of a tag is read with the generated accessor `expr<Variant><Field>(e)` (`exprDotObj`, `exprIndexIndex`, `exprBinaryOp`, `exprCondYes`, `exprCallCall`, ...,
see section 6 for the table) or, where this layer differs from the HIR (a string/number/template, a JSX element), with the function named in section 6.
`ExprKind::Missing` is `EXPR_MISSING` (also returned for an id that is not an expression). Do the same for `stmtTag`/`typeTag`/`patTag`.

Where Rust uses `as_*()` to test one kind (`e.as_call()`, `e.as_dot()`, `s.as_expr()`), test the tag and read the payload, or use the shortcuts: `exprAsCall(e)` /
`exprAsNew` / `exprAsTaggedTemplate` / `exprAsCallOrNew` / `exprAsCallLike` (a CallId or -1), `exprAsFn(e)` (FnId), `exprAsClass(e)`, `exprAsIdent(e)` (atom),
`exprAsString(e)` (atom), `exprAsPrivateIdentifier`, `exprAsBigint`, `stmtAsExpr(s)` (ExprId), `patAsIdent(p)` (atom), `exprCallee(e)`, `exprObject(e)`,
`exprLeft(e)`, `exprRight(e)`, `exprOperand(e)`, `exprIsIdent(e, "x")`.

Optional chains (`format/CLAUDE.md`): `e.is_chain_root()` is `exprIsChainRoot(e)`, `e.is_in_optional_chain()` `exprIsInOptionalChain(e)`, `e.chain()` `exprChain(e)`
(`CHAIN_NO/START/CONTINUE`), `e.is_optional()` `exprIsOptional(e)`.

### Enums that were `kind()` of something that is not a node

`FnBody`: `funcBodyKind(f)` (`BODY_NONE`, `BODY_BLOCK` with the list `(funcBodyStmtsStart(f), funcBodyStmtsLen(f))`, `BODY_EXPR` with `funcBodyExpr(f)`).
`KeyKind`: `keyKind(owner)` (section 5). `ModuleName`: `moduleNameKind(m)`. `ImportEqualsTarget`: `importEqualsTargetKind(i)`. `JsxChild`: rows from
`jsxChildrenWithWhitespace`. `Chain`, `UnOp`, `BinOp`, `PropKind`, `MemberKind`, `FnKind`, `VarKind`, `Keyword`, `MappedModifier`: the `CHAIN_*`, `UN_*`, `BIN_*`,
`PROP_*`, `MEMBER_*`, `FN_*`, `VAR_*`, `KW_*`, `MM_*` constants.

### Cost model (scriptc 0.3.0, M5 Pro, `tools/ast-bench.ts`)

`exprSpan` ~6 ns, `nodeParent` ~7 ns, `nodeChildren` ~16 ns per node, `fileBegin` ~750 MB/s of source (the parse is ~130 MB/s). Rules: do not call a
span function twice for the same node in a loop (keep `SP[0]`/`SP[1]` in locals); `exprTag(e)` is a load (plus a byte test for strings); `nodeParent` of a type is a
load after the first one in a file (the table is built on first use); prefer `exprTag`+payload to `exprAsX` chains. **The program must not read `Error.stack`
anywhere**: scriptc then emits a frame push/pop in every function of the program (see the STATUS entry).

## 4. `File` (mod.ts, state.ts)

| Rust | TS |
| ---- | -- |
| `File::new`, `with_text` | `fileBegin(names, parserIsTypeScript, isModule)` after `parseFile`. `file.text()`: `hir.text` (valid `hir.sourceLen` bytes) |
| `file.text()`, `file.slice(span)` | `hir.text`, `hir.sourceLen`; the slice is `(hir.text, start, end)` |
| `file.path()` | the driver's string |
| `file.span()` | `fileSpan()` into `SP` ((0, source length)) |
| `file.program_span()` | `fileProgramSpan()` into `SP` (from the first token, after a `#!` line and comments) |
| `file.body()` | the list `(fileBodyStart(), fileBodyLen())` of StmtIds |
| `file.is_javascript()` | `fileIsJavascript()` (`.js .jsx .mjs .cjs`) |
| `file.is_flow()` | `fileIsFlow()` |
| `file.is_declaration_file()` | `fileIsDeclarationFile()` |
| `file.is_module()` | `fileIsModule()` |
| `file.has_parse_errors()` | `fileHasParseErrors()` |
| `file.has_bom()` | `fileHasBom()` |
| `file.has_with_statements()` | `fileHasWithStatements()` |
| `file.has_rare_syntax(bit)`, `may_bind_a_parameter_twice()` | `fileHasRareSyntax(RARE_X)`, `fileMayBindAParameterTwice()` |
| `file.end_of_token_before(at)` | `fileEndOfTokenBefore(at)` |
| `file.end_of_identifier(pos, end)`, `has_no_unicode_escape_in` | `fileEndOfIdentifier(pos, end)`, `fileHasNoUnicodeEscapeIn(pos, end)` |
| `file.is_parenthesized(e)` | `fileIsParenthesized(e)` (= `exprIsParenthesized`) |
| `file.comments()` (the comment tokens, in order; the `#!` line first) | `commentsLen()`, then for `i` in `0 .. commentsLen()`: `commentStartAt(i)`, `commentEndAt(i)`, `commentKindAt(i)` (`TK_LINE`, `TK_BLOCK`, `TK_SHEBANG`), `commentValueSpan(i)` (`Token::comment_value`, into `SP`), `commentEndingAt(end)`, `commentAround(offset)` (the index or -1). `commentsNeedTokenScan()` is true for a script with `<!--` / `-->`: those are comments for espree and are not listed (see "Not ported") |
| `file.language()`, `file.settings()` | `F.isEspree`, `F.isModuleSource` (the two fields of `LanguageOptions` the handles read) |
| `file.jsdoc()` | NOT PORTED (section 9) |
| `file.extension()`, `is_later_script`, `types`, `sink`, `modules`, `formatter`, `package_module`, `inferred_*` | not ported (lint/typescript state) |
| `file.backslashes()` | not ported (the formatter does not call it) |
| `file.intern(text)` | `nameIntern(buf, start, end)` |
| `file.name(atom)` | the atom |
| `File::jsx_namespace_and_name(start)` | `jsxNamespaceAndName(start)`: false if no colon; else `SP[0..2]` = namespace, `SP[2..4]` = name |
| `goes_to_flow(text, path)` | `goesToFlow(text, len, path)` (`src/lint/linter/syntax/mod.ts`) |
| `lint::paths::file_name(path)` | `fileName(path)` (`src/lint/paths.ts`, strings) |
| `utils::node::is_builtin_module(s)` | `isBuiltinModule(buf, start, end)` (`src/lint/utils/node.ts`) |
| `utils::text::{number_to_string, ends_with_ignore_ascii_case, to_lower_case, to_upper_case, is_upper_case, is_lower_case}` | `numberToString(n)`, `numberToStringBytes(n, out)`, `endsWithIgnoreAsciiCase(buf, start, end, "lit")`, `toLowerCaseInto(buf, start, end, out)`, `toUpperCaseInto`, `isUpperCase`, `isLowerCase` (`src/lint/utils/text.ts`) |

Text scanners (`tokens::skip_trivia(text, at)`, `skip_trivia_back`, `token_len(rest)`, `next_token(text, at)`), all with `text = hir.text`, `len = hir.sourceLen`:
`skipTrivia(text, len, at)`, `skipTriviaBack(text, len, at)`, `tokenLen(text, len, at)` (the length of the token that starts at `at`), `nextToken(text, len, at)`
(into `SP`). They are the same functions as Rust's and have the same limits (`at` must be between tokens; `skipTriviaBack` can be fooled by a `//` in a regex on
the line before; `tokenLen` never reads a `/` as a regex nor a `}` as a template continuation). `fileEndOfTokenBefore` does not have the second limit.
The other scanners of `sema/check/spans.ts` (`identEnd`, `identifierEnd`, `stringEnd`, `numberEnd`, `regexEnd`, `templateText`, `jsxIdentifierEnd`, `jsxNameEnd`,
`tokenEnd(text, len, at, isJsx)`, `lineEnd`, `lineBreakLen`, `whiteSpaceLen`, ...) are exported for the comment code.

## 5. Handles

Names: `<handle><Method>`; the Rust `Func` is `func*`. Unless said, a method that returns a handle returns `-1` for `None`; a `Span` is into `SP`; a `List` is a pair;
an `Ident` is a pair `(xxxName, xxxNamePos)`.

### Expr (expr.ts) — `Expr`, `ExprKind`, `ExprTag`

| Rust | TS |
| ---- | -- |
| `e.kind()` | `switch (exprTag(e))`, payload accessors in section 6 |
| `e.tag()` | `exprTag(e)` |
| `e.span()`, `outer_span()` | `exprSpan(e)`, `exprOuterSpan(e)` into `SP`; `exprStart/exprEnd`, `exprOuterStart/exprOuterEnd` |
| `e.text()` | `hir.text[exprStart(e) .. exprEnd(e))` |
| `e.parens()` (innermost first) | the rows `exprParenFirst(e) ..` of `hir.parens` while `hir.parenExpr[row] === e`: `(hir.parenStart[row], hir.parenEnd[row])`; the count is `exprParenCount(e)` |
| `e.is_parenthesized()` | `exprIsParenthesized(e)` |
| `e.is_missing()`, `is_name_or_literal()` | `exprIsMissing(e)`, `exprIsNameOrLiteral(e)` |
| `e.parent()` | `exprParent(e)` (a Node) |
| `e.as_ident()`, `is_ident("x")` | `exprAsIdent(e)` (atom), `exprIsIdent(e, "x")` |
| `e.as_string()` | `exprAsString(e)` / `exprStringValue(e)` (atom; -1 for a template and for a non-string) |
| `e.as_call()`, `as_new()`, `as_tagged_template()`, `as_call_or_new()`, `as_call_like()` | `exprAsCall(e)`, `exprAsNew`, `exprAsTaggedTemplate`, `exprAsCallOrNew`, `exprAsCallLike` -> CallId or -1 |
| `e.as_fn()`, `as_class()` | `exprAsFn(e)` (FnId), `exprAsClass(e)` (ClassId) |
| `e.as_dot()` / `as_index()` / `as_unary()` / `as_binary()` / `as_assign()` / `as_cond()` / `as_array()` / `as_object()` / `as_import_call()` / `as_spread()` / `as_satisfies()` / `as_yield()` | test `exprTag(e)` and read the payload (section 6) |
| `e.as_template()` | `exprTag(e) === EXPR_TEMPLATE`, then `exprTemplate*` below |
| `e.as_number()` | `exprTag(e) === EXPR_NUMBER`, `exprNumberValue(e)` (f64) |
| `e.as_regex()` | `exprTag(e) === EXPR_REGEX`, `exprRegexPatternSpan(e)`, `exprRegexFlagsSpan(e)` into `SP` |
| `e.as_private_identifier()`, `as_bigint()` | `exprAsPrivateIdentifier(e)` (atom with the `#`), `exprAsBigint(e)` (atom of the decimal digits) |
| `e.callee()` | `exprCallee(e)` (Call/New only; -1 else) |
| `e.object()` | `exprObject(e)` (Dot/Index) |
| `e.index()` | `exprIndexIndex(e)` |
| `e.member_name()`, `member_name_start()` | `exprDotName(e)`, `exprDotNamePos(e)` (= `exprMemberNameStart`) |
| `e.is_private_member()` | `exprIsPrivateMember(e)` |
| `e.binary_op()`, `unary_op()`, `assign_op()` | `exprBinaryOpOf(e)` (BIN_* or -1), `exprUnaryOpOf(e)`, `exprAssignOpOf(e)` (-2: not an Assign; 0: `=`; else `BIN_x + 1`) |
| `e.left()`, `right()`, `operand()` | `exprLeft(e)`, `exprRight(e)`, `exprOperand(e)` |
| `bin_op_text(op)`, `un_op_text(op)`, `assign_op_text(op)` | `binOpText(op)`, `unOpText(op)`, `assignOpText(opEncoded)` (strings); `binOpTextLen`, `unOpTextLen` |
| `e.is_angle_bracket_assertion()` | `exprIsAngleBracketAssertion(e)` |
| `e.operator_span()` | `exprOperatorSpan(e)` (boolean + `SP`) |
| `e.jsx_container_span()` | `exprJsxContainerSpan(e)` (boolean + `SP`) |
| `e.is_in_optional_chain()`, `is_chain_root()`, `is_optional()`, `chain()` | `exprIsInOptionalChain`, `exprIsChainRoot`, `exprIsOptional`, `exprChain` |
| `e.is_assignment_target()` | `exprIsAssignmentTarget(e)` |
| `e.is_in_type_query()` | `exprIsInTypeQuery(e)` |
| `e.inner_non_null_spans()`, `non_null_count()` | the rows `exprNonNullEndsFirst(e) ..` of `hir.nonNullEnds` while `hir.nonNullEndExpr[row] === e`: the span is `(exprStart(e), hir.nonNullEndEnd[row])`; `exprInnerNonNullCount(e)`; `exprNonNullCount(e)` (the `!`s: 0 if not a NonNull) |
| `e.skip_type_wrappers()` | `exprSkipTypeWrappers(e)` |
| `e.const_keyword_span()` | `exprConstKeywordSpan(e)` (boolean + `SP`) |
| `e.meta_property_spans()` | `exprMetaPropertySpans(e)`: `SP[0..2]` meta, `SP[2..4]` property |
| `e.is_deferred_import_call()`, `import_call_phase()` | `exprIsDeferredImportCall(e)`, `exprImportCallPhase(e)` (0 none, 1 `defer`, 2 `source`) |
| `e.sequence()` | `exprSequence(e, out)` appends the operands to the `I32Vec out` |
| `e.is_jsx_text()`, `is_jsx_attribute_string()`, `is_jsx_tag_name()` | `exprIsJsxText(e)`, `exprIsJsxAttributeString(e)`, `exprIsJsxTagName(e)` |
| `e.jsx_text_value()` | `exprJsxTextValue(e, out: Bytes)`: false if not JSX text; else the value is `out.data[0 .. out.len)` |
| `e.is_flow_type_cast()`, `is_before_flow_type_arguments()` | `exprIsFlowTypeCast(e)`, `exprIsBeforeFlowTypeArguments(e)` (flow.ts) |

**Template** (`ExprKind::Template`, also `` `a` ``): with `exprTag(e) === EXPR_TEMPLATE`: the substitutions are the list `(exprTemplateExprsStart(e), exprTemplateExprsLen(e))`;
`quasi_count()` `exprTemplateQuasiCount(e)`; `cooked(i)` `exprTemplateCooked(e, i)` (atom or -1 for an invalid escape); `quasi_span(i)` `exprTemplateQuasiSpan(e, i)`;
`raw(i)` `exprTemplateRawSpan(e, i)`; `text_of_scanner(i)` `exprTemplateTextOfScanner(e, i)`; `as_static()` `exprTemplateAsStatic(e)`.

**Call** (`ExprKind::Call(call)` / `New` / `TaggedTemplate`; CallId from `exprCallCall(e)` / `exprNewCall(e)` / `exprTaggedTemplateCall(e)` / `exprAsCallLike(e)`):
`callCallee(c)`, `callArgsStart(c)`/`callArgsLen(c)`, `callTypeArgsStart(c)`/`callTypeArgsLen(c)`, `callChain(c)`, `callIsOptional(c)`, `callCloseParen(c)` (position or -1),
`callTemplate(c)` (ExprId or -1).

**Jsx** (`ExprKind::Jsx(jsx)`; every function takes the ExprId of the element): `jsxTag(e)` (-1: fragment), `jsxCloseTag(e)`, `jsxIsFragment(e)`, `jsxIsSelfClosing(e)`,
`jsxAttrsStart/Len(e)` (PropIds), `jsxChildrenStart/Len(e)` (ExprIds), `jsxTypeArgsStart/Len(e)`, `jsxOpeningSpan(e)` (`SP`), `jsxClosingSpan(e)` (boolean + `SP`),
`children_with_whitespace()`: `jsxChildrenWithWhitespace(e, out)` appends rows of 3 to the `I32Vec`: `(JC_EXPR, ExprId, 0)` or `(JC_WHITESPACE, start, end)`.

### Stmt (stmt.ts) — `Stmt`, `StmtKind`, `StmtTag`, `VarDecl`, `Case`

| Rust | TS |
| ---- | -- |
| `s.kind()` / `s.tag()` | `switch (stmtTag(s))`, payload accessors in section 6. `StmtKind::With` has the tag `STMT_BLOCK`: `stmtIsWith(s)`, `stmtWithObject(s)` (ExprId), `stmtWithBody(s)`; `stmtIsBlock(s)` is a block that is not a `with` |
| `s.span()`, `span_without_export()`, `export_span()` | `stmtSpan(s)`, `stmtSpanWithoutExport(s)`, `stmtExportSpan(s)` (boolean + `SP`); `stmtStart/stmtEnd` |
| `s.modifiers()` | the list `(stmtModifiersStart(s), stmtModifiersLen(s))` of ModifierIds |
| `s.flags()`, `is_exported()`, `is_default_export()` | `stmtFlags(s)`, `stmtIsExported(s)`, `stmtIsDefaultExport(s)` |
| `s.semicolon()` | `stmtSemicolon(s)` (boolean + `SP`) |
| `s.catch_clause_span()` | `stmtCatchClauseSpan(s)` (boolean + `SP`) |
| `s.module_specifier_span()` | `stmtModuleSpecifierSpan(s)` (boolean + `SP`) |
| `s.import_attributes()` | `stmtImportAttributes(s)` -> a row (or -1); functions on rows below (`importAttributes*`) |
| `s.namespace_export_name()` | `stmtNamespaceExportName(s)` (atom), `stmtNamespaceExportNamePos(s)` |
| `s.is_wrapper()`, `wrapped_in()` | `stmtIsWrapper(s)`, `stmtWrappedIn(s)` (StmtId of the `for`/`with` or -1) |
| `s.label()` | `stmtLabel(s)` (atom or -1), `stmtLabelPos(s)` |
| `s.as_expr()` / `as_block()` / `as_var()` / `as_fn()` / `as_if()` / `as_for()` / ... | the tag + payload; `stmtAsExpr(s)` (ExprId), `stmtIsBlock(s)` |
| `s.is_loop()` | `stmtIsLoop(s)` |
| `s.directive()` | `stmtDirectiveSpan(s)` (boolean + `SP`: the text between the quotes) |
| `s.parent()` | `stmtParent(s)` (a Node) |
| `VarDecl::pat/ty/init/var_kind/flags/is_definite` | `varDeclPat(d)`, `varDeclTy(d)`, `varDeclInit(d)`, `varDeclKind(d)`, `varDeclFlags(d)`, `varDeclIsDefinite(d)` |
| `VarDecl::span()`, `binding_span()` | `varDeclSpan(d)`, `varDeclBindingSpan(d)` |
| `VarDecl::parent()` | `varDeclParent(d)` |
| `Case::test/is_default/body/span/parent` | `caseTest(c)`, `caseIsDefault(c)`, `caseBodyStart(c)`/`caseBodyLen(c)`, `caseSpan(c)`, `caseParent(c)` |

### TypeNode (ty.ts) — `TypeNode`, `TypeKind`, `TypeTag`, `TupleElem`, `Mapped`, `ImportAttributes`, `EntityName`

| Rust | TS |
| ---- | -- |
| `t.kind()` / `t.tag()` | `switch (typeTag(t))` (`TYPE_ERROR` and `TYPE_JSDOC` are both `TypeKind::Error`), payload in section 6 |
| `t.span()`, `outer_span()`, `is_parenthesized()` | `typeSpan(t)`, `typeOuterSpan(t)` into `SP`; `typeStart/typeEnd`, `typeOuterStart/typeOuterEnd`; `typeIsParenthesized(t)` |
| `t.annotation_span()` | `typeAnnotationSpan(t)` into `SP` |
| `t.parent()` | `typeParent(t)` (a Node) |
| `t.is_keyword(k)`, `as_keyword()` | `typeIsKeyword(t, KW_X)`; `typeTag(t) === TYPE_KEYWORD` and `typeKeywordKeyword(t)` |
| `t.as_ref()` | `typeTag(t) === TYPE_REF`: the entity name `(typeRefNameStart(t), typeRefNameLen(t))`, the args `(typeRefArgsStart(t), typeRefArgsLen(t))` |
| `t.as_template()` | `TYPE_TEMPLATE`: `types()` `(typeTemplateTypesStart(t), typeTemplateTypesLen(t))`, `typeTemplateQuasiCount(t)`, `typeTemplateCooked(t, i)`, `typeTemplateQuasiSpan(t, i)`, `typeTemplateRawSpan(t, i)` |
| number literal | `typeNumberLitValue(t)` |
| `t.predicate_param()` | `typePredicateParamAtom(t)`, `typePredicateParamPos(t)` |
| `t.unique_symbol_keyword_span()` | `typeUniqueSymbolKeywordSpan(t)` (boolean + `SP`) |
| `t.import_span()`, `import_source_span()`, `import_attributes()` | `typeImportSpan(t)`, `typeImportSourceSpan(t)` (boolean + `SP`), `typeImportAttributes(t)` (row or -1) |
| `List<TypeNode>::angle_brackets_span()` | `typeListAngleBrackets(start, len)` (boolean + `SP`) |
| `List<TypeParam>::angle_brackets_span()` | `typeParamListAngleBrackets(start, len)` (boolean + `SP`) |
| `ImportAttributes` (the handle is its ROW of `hir.importAttributes`) | `importAttributesKeyword(row)` (position), `importAttributesObject(row)` (ExprId), `importAttributesKeywordSpan(row)`, `importAttributesBracesSpan(row)`, `importAttributesOptionsSpan(row)` into `SP`, `importAttributesEntriesStart(row)`/`importAttributesEntriesLen(row)` (PropIds; the value of an entry is `hir.propValue[p]`, its key `keyKind(nodeOfProp(p))`) |
| `TupleElem::ty/name/is_optional/is_rest/span/parent` | `tupleElemTy(e)`, `tupleElemName(e)`/`tupleElemNamePos(e)`, `tupleElemIsOptional(e)`, `tupleElemIsRest(e)`, `tupleElemSpan(e)`, `tupleElemParent(e)` |
| `Mapped::param/name_type/ty/readonly/optional/is_readonly_with_plus/is_optional_with_plus` | (MappedId = `typeMappedMapped(t)`) `mappedParam(m)` (TypeParamId), `mappedNameTy(m)`, `mappedTy(m)`, `mappedReadonly(m)` (`MM_*`), `mappedOptional(m)`, `mappedIsReadonlyWithPlus(m)`, `mappedIsOptionalWithPlus(m)`. `mappedReadonlyText(m)` / `mappedQuestionText(m)` (hir_util) give `+readonly `, `-?`, ... |
| `EntityName::parts/get/len/first/last/as_ident/is/span` | `entityAtom(start, i)`/`entityPos(start, i)`, `len` is the second of the pair, `entitySpan(start, len)`, `entityIs(start, len, "x")` |

### Pat (pat.ts) — `Pat`, `PatKind`, `PatProp`, `PatElem`

| Rust | TS |
| ---- | -- |
| `p.kind()` / `tag()` | `switch (patTag(p))`: `PAT_MISSING` (hole), `PAT_IDENT` (`patIdentName(p)`), `PAT_OBJECT` (`patObjectPropsStart/Len(p)`), `PAT_ARRAY` (`patArrayElemsStart/Len(p)`) |
| `p.span()` | `patSpan(p)` into `SP`; `patStart/patEnd` |
| `p.as_ident()` | `patAsIdent(p)` (atom or -1) |
| `p.parent()` | `patParent(p)` |
| `p.for_each_binding(f)` | `patBindings(p, out)` appends the PatIds of the identifiers in source order |
| `PatProp::key()` | `keyKind(nodeOfPatProp(p))`, ... (keys below) |
| `PatProp::has_computed_key/computed_key/is_shorthand/value/default/is_rest/span/parent` | `patPropHasComputedKey(p)`, `patPropComputedKey(p)`, `patPropIsShorthand(p)`, `patPropValue(p)`, `patPropDefault(p)`, `patPropIsRest(p)`, `patPropSpan(p)`, `patPropParent(p)` |
| `PatElem::pat/default/is_rest/span/parent` | `patElemPat(e)` (-1 for a hole), `patElemDefault(e)`, `patElemIsRest(e)`, `patElemSpan(e)`, `patElemParent(e)` |

### Func, Param, TypeParam (decl.ts)

| Rust | TS |
| ---- | -- |
| `Func::kind/flags/is_async/is_generator/is_arrow` | `funcKind(f)` (`FN_*`), `funcFlags(f)`, `funcIsAsync(f)`, `funcIsGenerator(f)`, `funcIsArrow(f)` |
| `Func::name()` | `funcName(f)` (atom or -1; only decl/expr), `funcNamePos(f)` |
| `Func::type_params/params` | `funcTypeParamsStart/Len(f)` (TypeParamIds), `funcParamsStart/Len(f)` (ParamIds; without `this`) |
| `Func::this_param()` | `funcThisParam(f)` (ParamId or -1); `params_with_this()` is that one (if any) then the params |
| `Func::return_type()` | `funcReturnType(f)` (TypeNodeId or -1) |
| `Func::body()` / `has_body()` / `body_statements()` | `funcBodyKind(f)`, `funcBodyStmtsStart/Len(f)`, `funcBodyExpr(f)`, `funcHasBody(f)` |
| `Func::body_span()` | `funcBodySpan(f)` (boolean + `SP`) |
| `Func::open_paren()`, `close_paren()` | `funcOpenParen(f)` (position or -1), `funcCloseParen(f)` (position or -1) |
| `Func::arrow_span()`, `params_span()` | `funcArrowSpan(f)`, `funcParamsSpan(f)` (boolean + `SP`) |
| `Func::owner()` | `funcOwner(f)` (a Node: Expr/Stmt/Member/Type) |
| `Func::span()`, `span_from_params()`, `estree_span()` | `funcSpan(f)`, `funcSpanFromParams(f)`, `funcEstreeSpan(f)` into `SP`; `funcStart(f)`, `funcEnd(f)`, `funcStartOfParams(f)` |
| `Func::enclosing()`, `returns()`, `yields()` | NOT PORTED (binder-only; nothing in the formatter calls them) |
| `Param::pat/ty/default/flags/is_rest/is_optional/is_parameter_property` | `paramPat(p)`, `paramTy(p)`, `paramDefault(p)`, `paramFlags(p)`, `paramIsRest(p)`, `paramIsOptional(p)`, `paramIsParameterProperty(p)` |
| `Param::modifiers()`, `decorators()` | `paramModifiersStart/Len(p)` (ModifierIds); decorators are the modifiers with `modifierDecorator(m) >= 0` |
| `Param::span/binding_span/span_without_modifiers` | `paramSpan(p)`, `paramBindingSpan(p)`, `paramSpanWithoutModifiers(p)` into `SP` |
| `Param::func()` | `paramFuncOf(p)` (FnId or -1) |
| `TypeParam::name/constraint/default/flags/span/modifiers/parent` | `typeParamName(p)`/`typeParamNamePos(p)`, `typeParamConstraint(p)`, `typeParamDefault(p)`, `typeParamFlags(p)`, `typeParamSpan(p)`, `typeParamModifiersStart/Len(p)`, `typeParamParent(p)` |

### Keys (decl.ts, keys.ts) — `Key`, `KeyKind`

A `Key` is derived from its owner: pass the owner as a Node (`nodeOfMember(m)`, `nodeOfProp(p)`, `nodeOfPatProp(p)`, `nodeOfEnumMember(m)`).

| Rust | TS |
| ---- | -- |
| `member.key()`, `prop.key()`, `pat_prop.key()`, `enum_member.key()` (`Option<Key>`) | `const k = nodeOfMember(m); keyKind(k)` is `KEY_NONE` (-1) for `None` |
| `key.kind()` | `keyKind(k)`: `KEY_IDENT`, `KEY_STRING`, `KEY_NUMBER`, `KEY_PRIVATE`, `KEY_COMPUTED_STRING`, `KEY_COMPUTED_NUMBER`, `KEY_COMPUTED` |
| `KeyKind::X(name)` / `Computed(e)` | `keyName(k)` (atom; -1 for computed), `keyExpr(k)` (ExprId, only `KEY_COMPUTED`) |
| `key.name()` | `keyName(k)` |
| `key.is_computed()/is_private()/is_jsx()` | `keyIsComputed(k)`, `keyIsPrivate(k)`, `keyIsJsx(k)` |
| `key.is("x")` | `keyIs(k, "x")` |
| `key.span(file)`, `inner_span(file)` | `keySpan(k)`, `keyInnerSpan(k)` (boolean + `SP`) |
| (position of the key) | `keyStart(k)` |
| (all at once) | `keyLoad(k)` returns the kind and fills `KEY[KEY_KIND]`, `KEY[KEY_NAME]`, `KEY[KEY_EXPR]`, `KEY[KEY_START]`, `KEY[KEY_JSX]` (valid until the next `key*` call) |
| `prop.has_computed_key()`, `prop.computed_key()`, `member.computed_key()`, `enum_member.computed_key()` | `propHasComputedKey(p)`, `propComputedKey(p)`, `memberComputedKey(m)`, `enumMemberComputedKey(m)` (ExprIds or -1) |

### Class, Member, Modifier, Prop (decl.ts)

| Rust | TS |
| ---- | -- |
| `Class::name/flags` | `className(c)`/`classNamePos(c)`, `classFlags(c)` |
| `Class::type_params/extends_args/implements/members/modifiers` | `classTypeParamsStart/Len(c)`, `classExtendsArgsStart/Len(c)`, `classImplementsStart/Len(c)`, `classMembersStart/Len(c)`, `classModifiersStart/Len(c)` |
| `Class::extends()` | `classExtends(c)` (ExprId or -1) |
| `Class::decorators()` | the modifiers with `modifierDecorator(m) >= 0` |
| `Class::owner()` | `classOwner(c)` (a Node: Stmt or Expr) |
| `Class::span/estree_span/keyword_span/body_span` | `classSpan(c)`, `classEstreeSpan(c)`, `classKeywordSpan(c)`, `classBodySpan(c)` into `SP`; `classStartPos(c)` |
| `Member::kind/flags/is_static/is_signature/is_constructor` | `memberKind(m)` (`MEMBER_*`), `memberFlags(m)`, `memberIsStatic(m)`, `memberIsSignature(m)`, `memberIsConstructor(m)` |
| `Member::ty/init/func` | `memberTy(m)`, `memberInit(m)`, `memberFunc(m)` |
| `Member::constructor_keyword()` | `memberConstructorKeyword(m)` (atom or -1), `memberNamePos(m)` |
| `Member::modifiers/decorators` | `memberModifiersStart/Len(m)`; decorators: the modifiers with `modifierDecorator(m) >= 0` |
| `Member::span/parent` | `memberSpan(m)`, `memberParent(m)` (a Node) |
| `Modifier::flag/decorator/span` | `modifierFlagOf(m)` (0 for a decorator), `modifierDecorator(m)` (ExprId or -1), `modifierSpan(m)`; `modifierStart(m)` |
| `Modifier::token_span()` (Flow) | `modifierTokenSpan(m)` |
| `Prop::kind/value/func/is_optional/is_jsx_attribute/is_import_attribute` | `propKind(p)` (`PROP_*`), `propValue(p)` (ExprId or -1), `propFunc(p)` (FnId or -1), `propIsOptional(p)`, `propIsJsxAttribute(p)`, `propIsImportAttribute(p)` |
| `Prop::span/parent` | `propSpan(p)`, `propParent(p)`; `propModifiersStart/Len(p)` |

### Interface, Alias, Enum, EnumMember, Module, Import, ImportSpec, ImportEquals, Export, ExportSpec (decl.ts)

The ids are the payloads of the statements (`stmtInterfaceInterface(s)`, `stmtTypeAliasAlias(s)`, `stmtEnumEnum(s)`, `stmtModuleModule(s)`, `stmtImportImport(s)`,
`stmtImportEqualsImportEquals(s)`, `stmtExportNamedExport(s)`); their `stmt()` is `interfaceStmt(i)` / `hir.aliasStmt[a]` / `hir.enumStmt[e]` / `moduleStmt(m)` /
`importStmt(i)` / `hir.importEqualsStmt[i]` / `exportStmt(x)`; their `span()` is that statement's.

| Rust | TS |
| ---- | -- |
| `Interface::name/flags/type_params/extends/members/body_span` | `interfaceName(i)`/`interfaceNamePos(i)`, `interfaceFlags(i)`, `interfaceTypeParamsStart/Len(i)`, `interfaceExtendsStart/Len(i)`, `interfaceMembersStart/Len(i)`, `interfaceBodySpan(i)` |
| `Alias::name/flags/type_params/ty` | `aliasName(a)`/`aliasNamePos(a)`, `aliasFlags(a)`, `aliasTypeParamsStart/Len(a)`, `aliasTy(a)` |
| `Enum::name/flags/members/body_span` | `enumName(e)`/`enumNamePos(e)`, `enumFlags(e)`, `enumMembersStart/Len(e)`, `enumBodySpan(e)` |
| `EnumMember::key/computed_key/init/span/parent` | keys: `nodeOfEnumMember(m)`; `enumMemberComputedKey(m)`, `enumMemberInit(m)`, `enumMemberSpan(m)`, `enumMemberParent(m)` |
| `Module::name()` | `moduleNameKind(m)` (`MODNAME_*`), `moduleName(m)` (atom, -1 for `global`), `moduleNamePos(m)` |
| `Module::body/has_body/uses_module_keyword/name_span/body_span` | `moduleBodyStart(m)`/`moduleBodyLen(m)` (of the innermost), `moduleHasBody(m)`, `moduleUsesModuleKeyword(m)`, `moduleNameSpan(m)`, `moduleBodySpan(m)` (boolean + `SP`) |
| `Module::innermost/outermost/nested` | `moduleInnermost(m)`, `moduleOutermost(m)`, `moduleNested(m)` (ModuleIds; -1 for none) |
| `Import::spec/default/namespace/namespace_span/named` | `importSpec(i)` (atom), `importDefault(i)`/`importDefaultPos(i)`, `importNamespace(i)`/`importNamespacePos(i)`, `importNamespaceSpan(i)` (boolean + `SP`), `importNamedStart/Len(i)` |
| `Import::has_named_imports/is_type_only/is_deferred/phase/is_side_effect/clause_span` | `importHasNamedImports(i)`, `importIsTypeOnly(i)`, `importIsDeferred(i)`, `importPhase(i)` (0, 1 `defer`, 2 `source`), `importIsSideEffect(i)`, `importClauseSpan(i)` |
| `Import::spec_span/attributes` | `importSpecSpanOf(i)` (boolean + `SP`), `importAttributes(i)` (row or -1) |
| `ImportSpec::imported/local/is_renamed/is_type_only/import/span` | `importSpecImported(s)`/`importSpecImportedPos(s)`, `importSpecLocal(s)`/`importSpecLocalPos(s)`, `importSpecIsRenamed(s)`, `importSpecIsTypeOnly(s)`, `importSpecImport(s)`, `importSpecSpan(s)` |
| `ImportEquals::name/target/flags/require_span` | `importEqualsName(i)`/`importEqualsNamePos(i)`, `importEqualsTargetKind(i)` (`IET_*`) with `importEqualsRequireSpec(i)` (atom or -1) or the entity `(importEqualsEntityStart(i), importEqualsEntityLen(i))`, `importEqualsFlags(i)`, `importEqualsRequireSpan(i)` (boolean + `SP`) |
| `Export::spec/has_from/items/is_type_only/spec_span/attributes` | `exportSpec(x)` (atom), `exportHasFrom(x)`, `exportItemsStart/Len(x)`, `exportIsTypeOnly(x)`, `exportSpecSpanOf(x)` (boolean + `SP`), `exportAttributes(x)` (row or -1) |
| `ExportSpec::local/exported/is_renamed/is_type_only/export/span` | `exportSpecLocal(s)`/`exportSpecLocalPos(s)`, `exportSpecExported(s)`/`exportSpecExportedPos(s)`, `exportSpecIsRenamed(s)`, `exportSpecIsTypeOnly(s)`, `exportSpecExport(s)`, `exportSpecSpan(s)` |

### Flow (flow.ts) — only meaningful if `fileIsFlow()`

`TypeNode::flow_nullable_operand` `typeFlowNullableOperand(t)`; `flow_type_operator_operand` `typeFlowTypeOperatorOperand(t)`; `first_token` `typeFirstToken(t)` (`SP`; compare with
`spTokenIs("x")`); `is_flow_exact_object` `typeIsFlowExactObject(t)`; `has_flow_optional_token(obj)` `typeHasFlowOptionalToken(t, obj)`;
`TypeParam::flow_token_after_name` `typeParamFlowTokenAfterName(p)` (`SP`; `spTokenIs`); `TupleElem::flow_variance_and_label` `tupleElemFlowVarianceAndLabel(e)` (bit 1:
variance span in `SP`; bit 2: label `FLOW[FLOW_LABEL_ATOM]`, `FLOW[FLOW_LABEL_POS]`); `flow_type` `tupleElemFlowType(e)`; `Param::flow_outer_name` `paramFlowOuterName(p)` (`SP`);
`Member::flow_internal_slot` `memberFlowInternalSlot(m)` (atom, position `memberNamePos(m)`); `is_flow_spread` `memberIsFlowSpread(m)`; `Interface::flow_opaque_type`
`interfaceFlowOpaqueType(i)`; `Class::flow_mixins` `classFlowMixinsStart/Len(c)`; `Enum::flow_explicit_type` `enumFlowExplicitType(e)` (boolean + `SP`); `flowTokenSpanAt(start)`.

## 6. Match-arm cheat sheets (the payload accessors)

`E` = the ExprId. Generated accessors are in `src/sema/hir.ts` (HIR_API.md section 9 has the columns); a name in **bold** is defined by this layer.

**ExprKind** (`switch (exprTag(e))`):

| Tag | Rust payload | TS |
| --- | ------------ | -- |
| `EXPR_MISSING` | | |
| `EXPR_IDENT` | `Ident(name)` | `exprIdentName(E)` (atom) |
| `EXPR_PRIVATE_IDENTIFIER` | `PrivateIdentifier(name)` | `exprPrivateIdentifierName(E)` |
| `EXPR_THIS/SUPER/NULL/TRUE/FALSE/IMPORT_META` | | |
| `EXPR_NUMBER` | `Number(f64)` | **`exprNumberValue(E)`** |
| `EXPR_STRING` | `String(name)` | **`exprStringValue(E)`** (atom; the value for JSX) |
| `EXPR_BIG_INT` | `BigInt(name)` | `exprBigIntDigits(E)` |
| `EXPR_REGEX` | `Regex` | **`exprRegexPatternSpan(E)`**, **`exprRegexFlagsSpan(E)`** |
| `EXPR_TEMPLATE` | `Template` | **`exprTemplateExprsStart/Len(E)`**, **`exprTemplateCooked(E, i)`**, ... (above) |
| `EXPR_TAGGED_TEMPLATE` | `TaggedTemplate(call)` | `exprTaggedTemplateCall(E)` (CallId) |
| `EXPR_ARRAY` | `Array(list)` | `exprArrayElemsStart/Len(E)` |
| `EXPR_OBJECT` | `Object(list)` | `exprObjectPropsStart/Len(E)` |
| `EXPR_FN` | `Fn(func)` | `exprFnFn(E)` |
| `EXPR_CLASS` | `Class(class)` | `exprClassClass(E)` |
| `EXPR_DOT` | `Dot { obj, name, chain }` | `exprDotObj(E)`, `exprDotName(E)` (atom), `exprDotNamePos(E)`, `exprDotChain(E)` |
| `EXPR_INDEX` | `Index { obj, index, chain }` | `exprIndexObj(E)`, `exprIndexIndex(E)`, `exprIndexChain(E)` |
| `EXPR_CALL` / `EXPR_NEW` | `Call(call)` / `New(call)` | `exprCallCall(E)` / `exprNewCall(E)` (CallId) |
| `EXPR_UNARY` | `Unary { op, operand }` | `exprUnaryOp(E)`, `exprUnaryOperand(E)` |
| `EXPR_BINARY` | `Binary { op, left, right }` | `exprBinaryOp(E)`, `exprBinaryLeft(E)`, `exprBinaryRight(E)` |
| `EXPR_ASSIGN` | `Assign { op, target, value }` | `exprAssignOp(E)` (0 = `=`, else `BIN_x + 1`), `exprAssignTarget(E)`, `exprAssignValue(E)` |
| `EXPR_COND` | `Cond { test, yes, no }` | `exprCondTest(E)`, `exprCondYes(E)`, `exprCondNo(E)` |
| `EXPR_SPREAD` / `EXPR_AWAIT` / `EXPR_AS_CONST` / `EXPR_NON_NULL` | `Spread(e)` ... | `exprSpreadExpr(E)`, `exprAwaitExpr(E)`, `exprAsConstExpr(E)`, `exprNonNullExpr(E)` |
| `EXPR_YIELD` | `Yield { value, star }` | `exprYieldValue(E)` (-1: none), `exprYieldStar(E)` (0/1) |
| `EXPR_AS` / `EXPR_SATISFIES` | `As { expr, ty }` | `exprAsExpr(E)`, `exprAsTy(E)` / `exprSatisfiesExpr(E)`, `exprSatisfiesTy(E)` |
| `EXPR_INSTANTIATION` | `Instantiation { expr, type_args }` | `exprInstantiationExpr(E)`, `exprInstantiationTypeArgsStart/Len(E)` |
| `EXPR_JSX` | `Jsx(jsx)` | the `jsx*` functions taking `E` |
| `EXPR_IMPORT_CALL` | `ImportCall { args }` | `exprImportCallArgsStart/Len(E)` |
| `EXPR_NEW_TARGET` | `NewTarget` | |

**StmtKind** (`switch (stmtTag(s))`, `S` = the StmtId): `STMT_EXPR/THROW/EXPORT_DEFAULT/EXPORT_ASSIGN` `stmtExprExpr(S)`, `stmtThrowExpr(S)`, `stmtExportDefaultExpr(S)`,
`stmtExportAssignExpr(S)`; `STMT_RETURN` `stmtReturnExpr(S)` (-1: none); `STMT_VAR` `stmtVarDeclsStart/Len(S)`; `STMT_FN` `stmtFnFn(S)`; `STMT_CLASS` `stmtClassClass(S)`;
`STMT_INTERFACE` `stmtInterfaceInterface(S)`; `STMT_TYPE_ALIAS` `stmtTypeAliasAlias(S)`; `STMT_ENUM` `stmtEnumEnum(S)`; `STMT_MODULE` `stmtModuleModule(S)`; `STMT_IF`
`stmtIfTest/Yes/No(S)`; `STMT_FOR` `stmtForInit/Test/Update/Body(S)`; `STMT_FOR_IN` `stmtForInLeft/Expr/Body(S)`; `STMT_FOR_OF` `stmtForOfLeft/Expr/Body/IsAwait(S)`;
`STMT_WHILE` `stmtWhileTest/Body(S)`; `STMT_DO_WHILE` `stmtDoWhileBody/Test(S)`; `STMT_BLOCK` `stmtBlockStmtsStart/Len(S)` (a `with` if `stmtIsWith(S)`); `STMT_SWITCH`
`stmtSwitchExpr(S)`, `stmtSwitchCasesStart/Len(S)`; `STMT_TRY` `stmtTryBlock/Param/Handler/Finalizer(S)` (`Param` is a VarDeclId); `STMT_BREAK/CONTINUE` **`stmtLabel(S)`**,
**`stmtLabelPos(S)`** (atom, -1: none); `STMT_LABELED` `stmtLabeledLabel(S)`, `stmtLabeledBody(S)`; `STMT_IMPORT` `stmtImportImport(S)`; `STMT_IMPORT_EQUALS`
`stmtImportEqualsImportEquals(S)`; `STMT_EXPORT_NAMED` `stmtExportNamedExport(S)`; `STMT_EXPORT_STAR` `stmtExportStarSpec(S)` (atom or -1), `stmtExportStarAlias(S)` (atom or -1),
`stmtExportStarAliasPos(S)`, `stmtExportStarFlags(S) & 1` is `type_only`; `STMT_EXPORT_AS_NAMESPACE` **`stmtNamespaceExportName(S)`**.

**TypeKind** (`switch (typeTag(t))`, `T` = the TypeNodeId): `TYPE_ERROR`/`TYPE_JSDOC` (both `TypeKind::Error`); `TYPE_HERITAGE` `typeHeritageExpr(T)`, `typeHeritageArgsStart/Len(T)`;
`TYPE_KEYWORD` `typeKeywordKeyword(T)` (`KW_*`); `TYPE_REF` `typeRefNameStart/Len(T)`, `typeRefArgsStart/Len(T)`; `TYPE_STRING_LIT` `typeStringLitValue(T)`; `TYPE_NUMBER_LIT`
**`typeNumberLitValue(T)`**; `TYPE_BIG_INT_LIT` `typeBigIntLitText(T)`, `typeBigIntLitNegative(T)`; `TYPE_BOOL_LIT` `typeBoolLitValue(T)`; `TYPE_TEMPLATE` `typeTemplateTypesStart/Len(T)`;
`TYPE_ARRAY` `typeArrayElem(T)`; `TYPE_TUPLE` `typeTupleElemsStart/Len(T)` (TupleElemIds); `TYPE_UNION` `typeUnionTypesStart/Len(T)`; `TYPE_INTERSECTION`
`typeIntersectionTypesStart/Len(T)`; `TYPE_FN` `typeFnFn(T)`; `TYPE_OBJECT` `typeObjectMembersStart/Len(T)`; `TYPE_COND` `typeCondCheck/Extends/Yes/No(T)`; `TYPE_INFER` `typeInferParam(T)`
(TypeParamId); `TYPE_MAPPED` `typeMappedMapped(T)` (MappedId); `TYPE_INDEXED_ACCESS` `typeIndexedAccessObj/Index(T)`; `TYPE_KEYOF` `typeKeyofTy(T)`; `TYPE_READONLY` `typeReadonlyTy(T)`;
`TYPE_UNIQUE_SYMBOL`; `TYPE_UNIQUE` `typeUniqueTy(T)`; `TYPE_TYPEOF` `typeTypeofExpr(T)` (ExprId), `typeTypeofArgsStart/Len(T)`; `TYPE_IMPORT` `typeImportSpec(T)` (atom or -1),
`typeImportNameStart/Len(T)`, `typeImportArgsStart/Len(T)`, `typeImportFlags(T) & 1` is `is_typeof`; `TYPE_PREDICATE` **`typePredicateParamAtom(T)`**, `typePredicateTy(T)` (-1: none),
`typePredicateAsserts(T)`.

**PatKind**: see the Pat table. **FnBody**, **ModuleName**: see section 3.

## 7. Parents: what `nodeParent` knows

`fileBegin` runs `fillParents()` (`sema/bind/parents.ts`, the port of `try_bind_for_format_in`): `bound.exprParentTag/A`, `stmtParentTag/A`, `patParentTag/A/B`,
`propOwner`, `memberOwnerTag/A`, `paramFn`, `varStmt`, `caseStmt`, `classOwnerTag/A`, `enumMemberOwner`, `fnOwnerTag/A`, `typeQueryOperands`. Differences from Rust's `Parent`: the
variants are merged into the 13 that `Node::of_parent` distinguishes (`P_EXPR`, `P_STMT`, `P_VAR_INIT`, `P_PARAM`, `P_PAT_PROP`, `P_PAT_ELEM`, `P_PROP`, `P_MEMBER`, `P_FN_BODY`, `P_ENUM_MEMBER`,
`P_CASE`, `P_CLASS`, `P_MODULE`, plus `P_FILE`/`P_NONE`); there are no scopes. The parents of types, type parameters, tuple elements, a `this` parameter and the entries of `with { .. }`
(`Parents` of node.rs) are built on the first question about one (`buildTypeParents`). `bound.complete` is false if some node is part of nothing (what the parser left behind where it
backtracked): in Rust such a file goes to the full binder (`binder.rs`, not ported). **On the vscode corpus (14,861 files that parse) it is true for every file.**

`nodeParent` equals Rust's `Node::parent` including: a statement in a function body has the parent `N_FUNC`, whose parent is its owner (the `Expr`/`Stmt`/`Member`/`TypeNode` that owns it);
the wrapper statement of a `for` head is not a parent (the `for` is); the substitutions of a tagged template have the template as parent; the `B` of `namespace A.B` is not a node.

## 8. What differs from Rust (and why)

* **No JSDoc casts/synthetic nodes.** Rust's `hides_casts`, `has_synthetic_nodes`, `is_synthetic`, `written_expr`, `written_flags`, `jsdoc_cast_*`, `is_in_jsdoc`: the parser here never
  reads JSDoc (`reads_jsdoc = false` for the formatter), so there are none. `Expr::new` is the identity.
* **`Span`/`Ident`/`List`/`Node` are numbers** (above). `Iterator`s are loops; closures (`for_each_child`, `for_each_binding`, `sequence`) append to a caller-owned `I32Vec`.
* **`end_of_token_before` uses the comments of the lexer** instead of the token scanner (`tokens/scan.rs`, not ported); it is exact where the scanner is.
* **Packed parents** (section 7).
* `Key` is derived from its owner (section 5). `Template` and `Jsx` are the `Expr`; `Call` is a CallId.
* `Expr::kind()` for a string that starts with a backtick is `EXPR_TEMPLATE`; a JSX attribute string has its entities decoded (`exprStringValue` interns the decoded text); JSX text is `EXPR_STRING`
  with `exprIsJsxText(e)`.
* `Handle::id()` / `file()` / `text()`: the id is the handle; the file is global; `text()` is `hir.text[start .. end)`.

## 9. Not ported (nothing in `vendor/bun/src/format/js` that is on by default calls them)

* `File::jsdoc()` (`lint/ast/jsdoc.rs` + `sema/check/jsdoc.rs::Outline`, 2,700 lines): used only by `format/js/jsdoc/**`, oxfmt's `jsdoc` option (off unless `.oxfmtrc.json` or `[fmt]` sets it).
* The token store (`file.tokens()`, `first_token`, `token_before`, ... `lint/tokens/scan.rs`, 1,285 lines): no handle calls it; `file.comments()` is provided from `hir.comments` (a script with HTML-like comments:
  `commentsNeedTokenScan()`).
* `Func::enclosing/returns/yields`, `reach.rs` (`is_in_tree`, `*_tags_in_tree`), `File::backslashes`, the binder's scopes/symbols/references, `File::extension`, `Parent` of `with_bodies` casts.
* `lint::regex`, `lint::glob::Minimatch`, `lint::json`, `lint::options::Json`, `utils::array_sort_by`, the rest of `utils::text`: used by sort_imports / tailwind / config code, not by the handles.
* `refused_by_prettier*` and the syntax-error tables of `lint/linter/syntax/*` (the driver's).

## 10. Testing

* `node tools/ast-walk.ts [--limit N] [--only substr]` (also `scriptc build tools/ast-walk.ts`): parses `bench/vscode`, walks every node through the handles and checks: `nodeParent(child) === parent` for every child, the span
  of a child is inside its parent's, children are in source order, `outer_span` contains `span`; reports `bound.complete` and the throughput (`fileBegin`, the walk).
* `node tools/ast-bench.ts` (compiled: `scriptc build tools/ast-bench.ts`): ns per operation.
* `node tools/ast-unit.ts` (also compiled): hand-checked values of the scanners and the span functions on small inputs.
* `node tools/ast-xcheck-ts.ts`: compares spans that this layer computes from the text (`funcCloseParen`, `typeListAngleBrackets`, `classBodySpan`, template quasis, `stmtModuleSpecifierSpan`,
  `typeOuterSpan`, `keySpan`, JSX tag spans) with the positions TypeScript's own parser gives for the same nodes (`typescript` from `node_modules`), over the corpus.
