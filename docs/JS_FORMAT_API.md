# JS_FORMAT_API: how a Rust `format/js` function is ported here

For whoever ports `vendor/bun/src/format/js/print/**` and `utils/**` (and the rest of `format/js`). Read `docs/ARCHITECTURE.md`,
`docs/IR_API.md` (every builder), `docs/LINT_AST_API.md` (every handle) first; this document is the glue between them: the JS `Formatter`
context, comments, `AstNodes`, the `Format` trait, and what each Rust idiom of `format/js` becomes. The core is done and runs end to end
(`src/format/js/{ast_nodes,fields,siblings,source_text,comments,trivia,builders,context,format,mod,script}.ts`,
`parentheses/*.ts`, `utils/{operators,suppressed,typecast,format_node_without_trailing_comments}.ts`, `src/format/range.ts`). Every file of
`print/**` and `utils/**` exists as a **skeleton**: the signatures are the agreement between files, the bodies write the node as it is in the
source (`// TODO(port)`). Replace the body of the function you own; keep its signature unless you must (then `grep` the callers and fix them).

## 0. Run it

```
node --stack-size=7000 src/main.ts --stdin-filepath=a.ts < a.ts        # one file, under node (deep input needs the big stack)
node tools/js/compare.ts [--filter=text] [--file=path] [--diff]       # bench/vscode against bench/vscode-fmt (see the head of that file)
node --stack-size=7000 tools/conformance.ts prettier --languages=js,jsx,typescript [--filter=js/arrow] [--report=/tmp/r]
node --stack-size=7000 tools/js/core-check.ts [--limit=N]              # AstNodes chains, siblings, comments sorted, every comment printed once (17M nodes, 0 problems with the skeleton)
npx tsc -p .                                                           # must be clean
SCRIPTC_CACHE_DIR=/tmp/scriptc-cache-<you> scriptc build src/main.ts -o /tmp/fmt-<you>      # compiles; cyclic imports: see section 9
cd bench/vscode && /tmp/fmt-<you> --check --compare-to=../vscode-fmt --compare-list
```

## 1. Naming

| Rust | TS |
| --- | --- |
| `write_x(..)` (a function) | `writeX(.., f)` |
| `write!(f, expr)`, `expr.fmt(f)` for a handle | `fmtExpr(e, f)`, `fmtStmt(s, f)`, `fmtType(t, f)`, `fmtPat`, `fmtPatElem`, `fmtPatProp`, `fmtMember`, `fmtProp`, `fmtVarDecl`, `fmtParam`, `fmtCase`, `fmtEnumMember`, `fmtImportSpec`, `fmtExportSpec`, `fmtTypeParam`, `fmtTupleElem` (all in `format.ts`) |
| `FormatX(..)` / `FormatX::new(..)` (a `Format` struct) | `fmtX(.., f)`: `fmtDeclaration(s, f)`, `fmtTypeAnnotation(ty, f)`, `fmtReturnTypeOfFunctionType`, `fmtTypeOfPredicate`, `fmtNonNullMarks(e, f)`, `fmtKey(owner, parent, f)`, `fmtStatements(start, len, f)`, `fmtStatementBody(body, forcedSpace, f)`, `fmtFormalParameters(func, f)`, `fmtFunctionBody(func, f)`, `fmtArguments(..)`, `fmtDecorators(..)`, `fmtLiteralStringToken(..)`, `fmtAssignmentLike(kind, h, f)` ... |
| `OptionalSemicolon` | `optionalSemicolon(f)` |
| `identifier(ident, parent)` | `identifier(atom, pos, parentAn, f)` |
| `type_arguments(list, owner)`, `type_parameters(list, owner)` | `typeArguments(start, len, ownerNode, f)`, `typeParameters(start, len, ownerNode, groupId, isTypeOrInterfaceDecl, f)` |
| `format_leading_comments(span).fmt(f)` | `formatLeadingComments(start, end, f)` |
| `write_trailing_comments_of(node, f)` | `writeTrailingCommentsOf(an, f)` |
| `f.is_quiet()` | `cxOf(f).isQuiet` |
| `snake_case` fn/method | `camelCase` |
| `const X: T` / unit enum `E::Variant` | `export const X: number = n` / `E_VARIANT` (the full name of the enum in SCREAMING_SNAKE: `ASSIGNMENT_LIKE_LAYOUT_FLUID`) |

Rule of thumb: **`fmtX` is `write!(f, X)` (comments, parentheses, prettier-ignore are the wrapper's job), `writeX` is a `write_x` function
(step 5: the node itself), a plain name is a plain function.** Never call a `writeX` for a node that the Rust code `write!`s as a handle:
the comments and the parentheses would be missing.

## 2. Types are numbers

Every handle is an Int32 (`number`): `Expr`, `Stmt`, `TypeNode` (`ty`), `Pat`, `PatProp`, `PatElem`, `Func`, `Param`, `TypeParam`, `Class`,
`Member`, `Prop`, `VarDecl`, `Case`, `EnumMember`, `ImportSpec`, `ExportSpec`, `TupleElem`, `Call` (CallId), `Interface`, `Alias`, `Enum`,
`Module`, `Import`, `ImportEquals`, `Export`, `Mapped`. `Option<Handle>` is `-1`. A parameter that is a handle is documented by its name.
`Node` (any handle with its kind) is `nodeOfExpr(e)` .. (`LINT_AST_API.md` section 2). Everything else:

| Rust | TS |
| --- | --- |
| `Span` | two numbers `(start, end)`; a function that returns one writes `SP[0]`, `SP[1]` and returns nothing (`Option<Span>`: a `boolean`). Read both right away. |
| `List<'a, T>` | two numbers `(start, len)`, element `i` is `listAt(start, i)` |
| `Ident` | `(atom, pos)` |
| `EntityName` | `(start, len)` |
| `Key` | the **owner** Node: `nodeOfMember(m)`, `nodeOfProp(p)`, `nodeOfPatProp(p)`, `nodeOfEnumMember(m)`; `keyKind(owner)`, `keyName(owner)`, `keyExpr(owner)`, `keySpan(owner)`, `keyInnerSpan(owner)` |
| `AstNodes<'a>` | one Int32 `an`, see section 4 |
| `BinOp`, `UnOp` | `BIN_*`, `UN_*` (and `binOpPrecedence(op)` .. in `utils/operators.ts`) |
| `Option<number>` | `-1` |
| `&[u8]` of the source | `(start, end)` into `cx.src.text` / `f.source`; a slice of something else: `(bytes, start, end)` |
| `&[Comment]` | a range of comment indices `[cm.from, cm.to)`, see section 5 |
| `SmallVec` / `Vec` of ints | a reusable `I32Vec` that is module-level (`const scratch = new I32Vec(16)`, append, truncate to the base you saw: `const base = v.len; ..; v.len = base;`) |
| `Option<bool>` | `0`, `1`, `-1` |
| `String`, `Cow` | avoid: write into `f.textBuf()` (see IR_API.md), or use a module-level `ByteBuf` |

No allocation per node: no `[a, b]`, no closures, no `new`, no `.map`, in anything that runs per node (ARCHITECTURE.md section 3b).

## 3. The context: `Formatter` + `JsFormatContext`

`f: Formatter` is the IR formatter (IR_API.md). The JavaScript part is `const cx = cxOf(f)` (`context.ts`; a checked cast: **once per function**):

| Rust | TS |
| --- | --- |
| `f.file()` | nothing: the file is global. `fileIsFlow()`, `fileIsJavascript()`, `fileIsDeclarationFile()`, `fileBodyStart()/fileBodyLen()` .. (`LINT_AST_API.md` section 4); `!f.file().is_javascript()` is `!fileIsJavascript()` |
| `f.options()` | `f.options` (`FormatOptions`; `f.options.flavor === FLAVOR_OXFMT`, `f.options.semicolons === SEMICOLONS_ALWAYS`, `f.options.lineWidth` ...) |
| `f.comments()` / `f.comments_mut()` | `cx.comments` (a `Comments`, section 5) |
| `f.source_text()` | `cx.src` (a `SourceText`, `source_text.ts`: `byteAt`, `containsByte`, `allBytes(start, end, TABLE)`, `containsNewline`, `hasNewlineInRange`, `linesAfter`, `hasLineTerminatorBefore/After`, ...). The bytes: `cx.src.text` (== `f.source`). |
| `f.is_quiet()` | `cx.isQuiet` |
| `f.context().has_tree_of_babel()` | `cx.hasTreeOfBabel` |
| `f.context_mut().has_stack_left()` | `if (!f.stack.enter()) return; ...; f.stack.leave();` (exactly one `leave()` per successful `enter()`, on every path). The doors (`fmtExpr`, `fmtStmt`, `fmtType`, `writeExpression`, `fmtStatements`' statements, ...) do it; code that recurses in a way of its own does too, with a comment. |
| `f.lines_before(span)` | `linesBefore(start, end, f)` (`builders.ts`) |
| `f.is_at_start_of_group()` | `isAtStartOfGroup(f)` |
| `f.speculate_will_break(&content)` | `speculateWillBreak(wk, h, f)` (`wk`: section 6) |
| `f.context().long_member_chain` | `cx.longMemberChainExpr` / `cx.longMemberChainValue`; `line_start` -> `cx.lineStartOffset` / `cx.lineStartValue`; `is_vue_filter_sequence` -> `cx.isVueFilterSequence` |
| `f.context().push_quote_needed(b)` .. | `cx.pushQuoteNeeded(b)`, `popQuoteNeeded()`, `isQuoteNeeded()` |
| `f.context().cached_element(span)` | `cx.getCachedElement(start, end)` (a capture handle or -1), `cx.cacheElement(start, end, handle)` |
| `tailwind_context` | `cx.pushTailwindContext(packed)` .. (`TWC_*` bits in `context.ts`; oxfmt's `sortTailwindcss` is off, the stubs answer "no context") |

`f.elements().len()` is `f.len()`; `f.elements().last()` is `f.st.tag[f.len() - 1]`; the other IR rules are in IR_API.md.

## 4. `AstNodes`: what a node is in

`ast_nodes.ts`. An `AstNodes` is an Int32 `an = (tag << 23) | id`: `anTag(an)` is one of `AN_*` (the oxc variant names in SCREAMING_SNAKE:
`AN_STATIC_MEMBER_EXPRESSION`, `AN_TS_AS_EXPRESSION`, `AN_JSX_ELEMENT`, ...), `anId(an)` is the handle (an ExprId for an expression variant, a StmtId
for a statement variant, a FnId for `AN_FUNCTION`, ...). The variants whose Rust field is a `Node` or an enum have one tag per payload:

| Rust variant | TS |
| --- | --- |
| `SpreadElement(Node::Expr / Node::Prop)` | `AN_SPREAD_ELEMENT_EXPR` / `AN_SPREAD_ELEMENT_PROP` (`anIsSpreadElement(an)`) |
| `ExpressionStatement(Stmt / ArrowBody(Func))` | `AN_EXPRESSION_STATEMENT` (StmtId) / `AN_ARROW_BODY_EXPRESSION_STATEMENT` (FnId): `anIsExpressionStatement(an)`, `anIsArrowFunctionBody(an)`, `anExpressionStatementExpression(an)` |
| `AssignmentPattern(Node)`, `BindingRestElement(Node)` | `AN_ASSIGNMENT_PATTERN_{PROP,ELEM}`, `AN_BINDING_REST_ELEMENT_{PROP,ELEM}` |
| `TSTypeParameterInstantiation(owner)`, `TSTypeParameterDeclaration(owner)` | `AN_TS_TYPE_PARAMETER_INSTANTIATION_{EXPR,TYPE,CLASS}`, `AN_TS_TYPE_PARAMETER_DECLARATION_{FUNC,CLASS,STMT,TYPE}`: `anTypeParametersOwner(an)` is the Node; `mkTypeArgumentsAn(owner)`, `mkTypeParametersAn(owner)` |

| Rust | TS |
| --- | --- |
| `e.as_ast_nodes()` | `exprAsAstNodes(e)` (the whole of an optional chain is `AN_CHAIN_EXPRESSION`); `stmtAsAstNodes(s)` (with its `export`), `typeAsAstNodes`, `funcAsAstNodes`, `classAsAstNodes`, `paramAsAstNodes`, `memberAsAstNodes`, `propAsAstNodes`, `varDeclAsAstNodes`, `tupleElemAsAstNodes`, `patAsAstNodes`, `nodeAsAstNodes(node)` |
| `e.as_chain_element()` | `exprAsChainElement(e)` |
| `e.ast_parent()` | `exprAstParent(e)`; `stmtAstParent(s)`, `typeAstParent(t)`, `patAstParent(p)`; for the others `anParent(xAsAstNodes(h))` |
| `node.parent()` | `anParent(an)` |
| `node.span()` | `anSpan(an)` into `SP`; `anStart(an)`, `anEnd(an)` |
| `node.ancestors()` | `for (let a = an; ; a = anParent(a)) { ..; if (anTag(a) === AN_PROGRAM) break; }` (self first; `e.ast_ancestors()` starts at the parent) |
| `matches!(p, AstNodes::IfStatement(_))` | `anTag(p) === AN_IF_STATEMENT` |
| `matches!(p, AstNodes::IfStatement(s) if f(s))` | `anTag(p) === AN_IF_STATEMENT && f(anId(p))` |
| `matches!(p, A(_) \| B(_))` | `const t = anTag(p); t === AN_A \|\| t === AN_B` (or `switch`) |
| `parent.is_call_like_callee(e)` | `anIsCallLikeCallee(parent, e)` |
| `node.without_chain_expression()` | `anWithoutChainExpression(an)` |
| `ExprFields::test/alternate/argument/expression/...` | `exprTest(e)`, `exprAlternate`, `exprArgument`, `exprExpression`, `exprTypeAnnotation`, `exprArrowFunction`, `exprTagExpression` (`fields.ts`); `stmtForLeft`, `stmtForInitOf`, `stmtConsequent`, `stmtAlternate`, `stmtFinalizer`, `stmtIsForAwait` |
| `x == y` (handles) | `x === y` |
| `type_arguments_of(owner)`, `type_parameters_of(owner)` | `typeArgumentsOf(node)` / `typeParametersOf(node)`: a boolean, the list is `TL[0]`, `TL[1]` |

`AstNodes` is created per question (a table lookup and a `switch`). Ask once, keep it in a `const`.

## 5. Comments

`comments.ts`. The algorithm is oxc's: a cursor over the sorted comments. A Rust `Comment` is an index `i` into the columns of `cx.comments`:
`cm.spanStart[i]`, `cm.spanEnd[i]` (`comment.span`), `cm.cs[i]`, `cm.ce[i]` (`comment.start()` / `end()`: where it counts as being), and
`cm.isLine(i)`, `isBlock`, `isMultilineBlock`, `isMoved`, `precededByNewline`, `followedByNewline`, `isIndentableBlock`, `isSuppressionComment`,
`looksLikeTypeCastComment`, `isTypeCastComment`. "No position" (`u32::MAX`) is `INF` (0x7fffffff).

A Rust `&[Comment]` is a range. **Every query that returns one writes `cm.from` and `cm.to` and returns the count; read them right after the call**
(the next query overwrites them) and pass them to the functions that write comments:

```ts
const cm = cxOf(f).comments;
cm.commentsBefore(testStart);                        // Rust: let comments = f.comments().comments_before(start);
formatTrailingCommentsRange(cm.from, cm.to, f);      // Rust: write!(f, FormatTrailingComments::Comments(comments))
for (let i = cm.from; i < cm.to; i++) { if (cm.isLine(i)) ... }   // Rust: comments.iter()
```

| Rust (`Comments`) | TS (`cm = cx.comments`) |
| --- | --- |
| `next_start()` | `cm.nextStart()` |
| `unprinted_comments()` | `cm.unprinted()` (count; `from`/`to`); `cm.hasUnprinted()` |
| `printed_comments().last()` | `cm.lastPrinted()` (index or -1) |
| `comments_before(pos)` / `comments_before_iter` | `cm.commentsBefore(pos)` / `cm.countBefore(pos)` |
| `comments_leading_node`, `comments_before_end_of`, `own_line_comments_before`, `end_of_line_comments_after`, `comments_trailing_left_side`, `comments_trailing_link`, `comments_leading_link`, `comments_leading_property`, `comments_after`, `comments_in(span)`, `comments_before_character` | `cm.commentsLeadingNode(start, end)`, `commentsBeforeEndOf(end)`, `ownLineCommentsBefore(pos)`, `endOfLineCommentsAfter(pos)`, `commentsTrailingLeftSide(rightStart)`, `commentsTrailingLink(end)`, `commentsLeadingLink(innerEnd)`, `commentsLeadingProperty(keyEnd, valueStart)`, `commentsAfter(pos)`, `commentsIn(start, end)`, `commentsBeforeCharacter(start, byte)` |
| `get_trailing_comments(enclosing, preceding, following)` | `cm.getTrailingComments(enclosingEnd, precedingEnd, followingStart)` |
| `has_comment_before(pos)`, `has_comment_in_range(a, b)`, `has_comment_in_span`, `has_leading_own_line_comment(pos)`, `has_any_comment_in(span)`, `has_comment_trailing_link(end)`, `has_comment_leading_link(end)` | `cm.hasCommentBefore(pos)`, `hasCommentInRange(a, b)`, `hasLeadingOwnLineComment(pos)`, `hasAnyCommentIn(a, b)`, `hasCommentTrailingLink(end)`, `hasCommentLeadingLink(end)` |
| `is_suppressed(start)`, `has_trailing_suppression_comment(end)`, `mark_suppressed_after_operator(start)` | `cm.isSuppressed(start)`, `hasTrailingSuppressionComment(end)`, `markSuppressedAfterOperator(start)` |
| `without_semicolon(span)` (returns a Span; the start is unchanged) | `cm.withoutSemicolon(start, end)` -> the new end |
| `position_after_character(start, b)` | `cm.positionAfterCharacter(start, byte)` |
| `increment_printed_count()` | `cm.incrementPrintedCount()` |
| `skip_comments_before(pos)` | `cm.skipCommentsBefore(pos)` |
| `snapshot()` / `restore(s)` | `const p = cm.snapshotPrinted(), l = cm.snapshotLimit(); ..; cm.restore(p, l);` |
| `limit_comments_up_to(end)` / `show_comments_up_to(end)` / `restore_view_limit(x)` | `const prev = cm.limitCommentsUpTo(end)` / `cm.showCommentsUpTo(end)` / `cm.restoreViewLimit(prev)` (`prev`: -1 for `None`) |
| `hide_comments_from(pos)` / `restore_hidden_comments(x)` | `cm.hideCommentsFrom(pos)` / `cm.restoreHiddenComments(prev)` |
| `has_type_cast_comments()`, `has_comments_trailing_links()` | the fields `cm.hasTypeCastComments`, `cm.hasCommentsTrailingLinks` |
| `is_cast_parenthesis(open)`, `get_type_cast_comment_index(span)` | `cm.isCastParenthesis(open)`, `cm.getTypeCastCommentIndex(start)` (index from the first unprinted one) |
| `Comment::content_span()` | `cm.contentSpan(i)` into `SP` |

Writing them (`trivia.ts`; a Span is `(start, end)`):

| Rust | TS |
| --- | --- |
| `format_leading_comments(span).fmt(f)` | `formatLeadingComments(start, end, f)` |
| `FormatLeadingComments::Comments(c).fmt(f)` | `formatLeadingCommentsRange(from, to, f)` |
| `format_trailing_comments(enc, prec, following).fmt(f)` | `formatTrailingComments(encStart, encEnd, precStart, precEnd, followingStart, f)` |
| `FormatTrailingComments::Comments(c).fmt(f)` | `formatTrailingCommentsRange(from, to, f)` |
| `format_dangling_comments(span)` `[.with_block_indent()` `/ .with_soft_block_indent()]` | `formatDanglingComments(start, end, DANGLING_NONE / DANGLING_BLOCK / DANGLING_SOFT, f)` |
| `FormatDanglingComments::Comments { comments, indent }` | `formatDanglingCommentsRange(from, to, mode, f)` |
| `write!(f, comment)` | `writeComment(i, f)` |
| `write_head_body_separator(body_start, f)`, `write_comments_between_blocks(c, f)`, `write_trailing_comments_before(start, b, f)`, `comments_stay_between_head_and_body(f)` | the same in camelCase; `writeCommentsBetweenBlocks(from, to, f)` |
| `FormatNodeWithoutTrailingComments(&x)` | `fmtNodeWithoutTrailingComments(wk, h, f)` (`utils/format_node_without_trailing_comments.ts`) |
| `FormatSuppressedNode(span)` | `writeSuppressedNode(start, end, f)` (`utils/suppressed.ts`) |
| `format_node(span, parent, f, write)` | `formatNode(start, end, pk, ph, wk, wh, f)`, see section 6 |

**Order.** Nodes are formatted in source order; a comment that nobody asks for is printed by the next node as a leading comment. Anything you
format ahead of its turn (`startCapture`/`endCapture`, `speculateWillBreak`) must either be used or be undone with the cursor snapshot.
`f.is_quiet()` (`cx.isQuiet`) is true while a node is written that has no comment in it and none behind it on its line: skip all comment work
then (`if (!cx.isQuiet) { ... }`). Calling the `Comments` queries without the check is always correct.

## 6. Writing nodes: the `Format` trait

Rust passes things that are `Format + Spanned` around (`FormatNodeWithoutTrailingComments(&x)`, `join_nodes_with_hardline().entries(list)`, `AssignmentLike`).
Here a node that can be written is a pair `(wk, h)`: `WK_EXPR`, `WK_STMT`, `WK_STMT_BEFORE_ANOTHER` (`FormatStatementBeforeAnother`), `WK_DECLARATION`,
`WK_TYPE`, `WK_PAT`, `WK_PAT_ELEM`, `WK_PAT_PROP`, `WK_MEMBER`, `WK_MEMBER_BEFORE_ANOTHER`, `WK_PROP`, `WK_VAR_DECL`, `WK_PARAM`, `WK_CASE`, `WK_ENUM_MEMBER`,
`WK_IMPORT_SPEC`, `WK_EXPORT_SPEC`, `WK_TYPE_PARAM`, `WK_TUPLE_ELEM`, `WK_TYPE_ANNOTATION`, `WK_RETURN_TYPE_OF_FUNCTION_TYPE`, `WK_TYPE_OF_PREDICATE`
(`format.ts`). `writeNode(wk, h, f)` is `x.fmt(f)` and `nodeSpanOf(wk, h)` (into `SP`) is `x.span()`. A loop over a list:

```ts
// Rust: f.join_nodes_with_hardline().entries(list.iter().map(|it| it))  (needs `Format + Spanned`)
let has = false;
for (let i = 0; i < n; i++) {
  const h = listAt(start, i);
  nodeSpanOf(WK_PROP, h);                                  // (SP[0], SP[1]) = span
  if (has) joinNodesSeparator(f, JOIN_HARDLINE, SP[0] | 0, SP[1] | 0);   // an empty line where the source has one, else the separator
  has = true;
  fmtProp(h, f);
}
// entries_with_trailing_separator(entries, ",", trailing_separator) (FormatSeparatedIter): the separator after an entry
//   writeSeparatorAfter(f, COMMA, i === n - 1, trailingSeparator, groupId /* 0: the enclosing group */)
```

`ExprOptions` (how a function or an arrow function is written where it is) is one int: `EO_NONE`, `exprOptionsFunction(cacheMode)`,
`exprOptionsArrow(assignmentLayout, callArgumentLayout, cacheMode)` (-1 for `None`); read with `eoKind`, `eoCacheMode`, `eoAssignmentLayout`,
`eoCallArgumentLayout`. `FormatExpr::with_options(e, o)` is `fmtExprWithOptions(e, o, f)`; `FormatExpr::in_chain_expression(e)` is
`fmtChainElementExpr(e, f)`; `write_expression(e, options, f)` (step 5 of an expression) is `writeExpression(e, options, f)`.

`format_node(span, parent, f, |f| write)` (a node that never needs parentheses, with comments around it): the two closures become
`(pk, ph)`, what the parent is, and `(wk, wh)`, what is written, so that nothing is allocated:
`formatNode(start, end, pk, ph, wk, wh, f)` / `formatNodeInList(start, end, isBeforeAnother, pk, ph, wk, wh, f)` / `formatNodeWithoutComments(...)`.
`pk` is a `WK_*` (the parent is that handle's `ast_parent`), `PK_PARENT` (`ph` *is* the parent, an `AstNodes`) or `PK_NODE` (`ph` is an `AstNodes`; the parent is
its parent). `wk` is what `writeNodeStep5` knows (the kinds with a step 5); for anything else write the comments yourself.
Where you would write `format_node(span, || node.parent(), f, |f| body)` inline, write:

```ts
const cx = cxOf(f);
if (cx.isQuiet) { body; return; }
const cm = cx.comments;
const isSuppressed = cm.isSuppressed(start) || cm.hasTrailingSuppressionComment(end);
formatLeadingComments(start, end, f);
if (isSuppressed) writeSuppressedNode(start, end, f);
else { const outer = enterScope(cx, start, end); body; leaveScope(cx, outer); }       // f.in_scope(span, |f| body)
writeTrailingCommentsIn(start, end, PK_NODE, node, f);                                 // write_trailing_comments_in(span, || node.parent(), f)
```

Other things from `format.rs` you call: `identifier(atom, pos, parentAn, f)`, `identifierAt(start, end, parentAn, f)`, `writeTrailingCommentsOf(an, f)`,
`noCommentTrailsWhatIsBeforeAnother(cx)`, `spanForComments(an, f)` (into `SP`), `terminatorOfWhatIsIgnoredFollowsSemi(f)`, `hasNoCommentsIn(cx, start, end)`.

Parentheses: `needsParentheses(e, f)` and `chainExpressionNeedsParentheses(e, f)` (`parentheses/expression.ts`), `expressionNeedsParentheses(e, f)`,
`leftEdgeEnd(e, an)` (the expression is returned, what it is in is `LEFT_EDGE[1]`), `hasOwnLineCommentBetween(start, end, f)`;
`needsParentheses(ty, f)` of `parentheses/ts_type.ts`. Type casts: `isCastTarget(e, f)`, `isCastTargetThatHidesItsKind(e, f)` (`utils/typecast.ts`).

## 7. Tokens, text, builders

`write!(f, "(")` is `f.token(LPAREN)` with `LPAREN` from `ir/tokens.ts` or `const X = token("...")` at module level (a token has no `\n`, tab or non-ASCII);
`f.tokenStr(s)` for a rare one. `text(&source[a..b])` is `f.textSource(a, b)`, `source_text(span)` is `f.sourceText(a, b)` (no tab, no line break), the rest of
the text builders is IR_API.md section 4. `if_group_breaks(&",")` is `f.tokenIfBreaks(COMMA)`, `FormatTrailingCommas::ES5` is `f.writeTrailingCommas(FTC_ES5, COMMA)`,
`soft_block_indent(&x)` is `f.startSoftBlockIndent(); ..; f.endSoftBlockIndent();`. `memoized()` / `intern` / `capture` / `best_fitting!` are captures
(IR_API.md section 5). **`format_args!(a, b)` is `a; b;`.** `write!(f, cond.then_some(x))` is `if (cond) x`.

## 8. Worked examples

### 8.1 `write_while_or_with_statement` (print/statements.rs)

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

```ts
const LPAREN = token("(");            // module level
const RPAREN = token(")");
const KW_WHILE = token("while");
const KW_WITH = token("with");

function writeWhileOrWithStatement(keyword: number, test: number, body: number, f: Formatter): void {
  f.startGroup();                                        // group(&format_args!(..))
  f.token(keyword);
  f.space();
  f.token(LPAREN);
  writeCondition(test, HEAD_BEFORE, body, f);            // FormatCondition { test, head }: a Format struct written once = a call
  f.token(RPAREN);
  fmtStatementBody(body, false, f);                      // FormatStatementBody::new(body)
  f.endGroup();
}

function writeCondition(test: number, headKind: number, headStmt: number, f: Formatter): void {
  const cx = cxOf(f);
  if (cx.isQuiet) {
    if (isNegatedLogicalExpression(test) && hugsNegatedCondition(f)) fmtExpr(test, f);
    else { f.startGroup(); f.startSoftBlockIndent(); fmtExpr(test, f); f.endSoftBlockIndent(); f.endGroup(); }
    return;
  }
  const cm = cx.comments;
  const end = headEnd(headKind, headStmt, f);
  exprSpan(test);
  const testStart = SP[0] | 0, testEnd = SP[1] | 0;
  const hasComments = cm.hasCommentBefore(testStart) || cm.hasCommentInRange(testEnd, end);
  // `content` is written in one place in one of two wrappers: decide the wrapper, open it, write once, close it.
  const hug = !hasComments && isNegatedLogicalExpression(test) && hugsNegatedCondition(f);
  if (!hug) { f.startGroup(); f.startSoftBlockIndent(); }
  const previousLimit = cm.limitCommentsUpTo(end);
  fmtNodeWithoutTrailingComments(WK_EXPR, test, f);      // FormatNodeWithoutTrailingComments(&test)
  cm.unprinted();                                         // let comments = f.comments().unprinted_comments();
  formatTrailingCommentsRange(cm.from, cm.to, f);         // write!(f, FormatTrailingComments::Comments(comments))
  cm.restoreViewLimit(previousLimit);
  if (!hug) { f.endSoftBlockIndent(); f.endGroup(); }
}
```

### 8.2 `print/member_expression.rs`

```ts
const QUESTION_DOT = token("?.");  const DOT = token(".");

/** `a.b`, `a?.b`, `a.#b`, `a[b]`, `a?.[b]`. Prettier's `printMemberExpression`. */
export function writeMemberExpression(e: number, f: Formatter): void {
  const object = exprObject(e);                         // e.object(): -1 if e is not a member access
  if (object < 0) return;
  if (exprTag(e) === EXPR_INDEX) {
    fmtExpr(object, f);                                  // write!(f, [object, boundary_behind_object(f), ..])
    if (f.options.flavor !== FLAVOR_OXFMT) f.lineSuffixBoundary();
    fmtComputedMemberExpressionWithoutObject(e, f);      // FormatComputedMemberExpressionWithoutObject(e)
    return;
  }
  writeStaticMemberExpression(e, object, f);
}

function writeStaticMemberExpression(e: number, object: number, f: Formatter): void {
  const cx = cxOf(f);
  const start = f.len();                                 // let start = f.elements().len();
  fmtExpr(object, f);
  if (f.options.flavor !== FLAVOR_OXFMT) f.lineSuffixBoundary();
  if (cx.isQuiet) {
    if (shouldInline(e, object, start, f)) writeLookupWithoutComments(e, f);
    else { f.startGroup(); f.startIndent(); f.softLineBreak(); writeLookupWithoutComments(e, f); f.endIndent(); f.endGroup(); }
    return;
  }
  const propertyStart = exprDotNamePos(e);               // property.start()
  const operator = exprIsOptional(e) ? QUESTION_DOT : DOT;
  const hasOwnLineComment = cx.comments.hasLeadingOwnLineComment(propertyStart);
  const isInline = !hasOwnLineComment && shouldInline(e, object, start, f);
  const parent = exprAsChainElement(e);                  // e.as_chain_element()
  if (isInline) {
    f.token(operator);
    identifier(exprDotName(e), propertyStart, parent, f);
    return;
  }
  f.startGroup(); f.startIndent();
  f.softLineBreak();
  if (hasOwnLineComment) {                               // the format_with closure: written once, in place
    cx.comments.commentsBefore(propertyStart);
    formatLeadingCommentsRange(cx.comments.from, cx.comments.to, f);
    f.softLineBreak();
  }
  f.token(operator);
  identifier(exprDotName(e), propertyStart, parent, f);
  f.endIndent(); f.endGroup();
}
```

(`Option<impl Format>` such as `boundary_behind_object(f)` is an `if`. `e.member_name()` is `exprDotName(e)` / `exprDotNamePos(e)`.)

### 8.3 `best_fitting!` with memoized parts: IR_API.md section 10.

## 9. Pitfalls (scriptc)

- **No `import * as ns` and no module-level `let` in a module that is part of an import cycle** (SC1016). The print files import `format.ts`, `format.ts` imports
  the print files: that is a cycle. Use named imports; state that must be mutable lives in a class instance (`const state = new State()`), or in a leaf module
  (`state.ts` has no imports).
- Constants are `export const X: number = n` (not literal types).
- Typed-array reads that are stored or passed: `| 0`. Stores: `| 0`. Int accumulators: `n = ((n | 0) + 1) | 0`. Loops: `for (let i = 0; i < n; i++)`.
- No closures per node, no `[a, b]`, no `forEach`/`map`. A closure that is created once per file (not per node) is fine.
- The comments cursor `from`/`to` are overwritten by the next query.
- `SP` is overwritten by the next function that returns a span: read both ends into locals.
- `f.sourceText(a, b)` needs a range without `\t`, `\n`, `\r`; `f.textSource` handles anything but `\r`.
- Do not read `Error.stack`.

## 10. Skeleton agreement (signatures)

The skeleton of `print/**` and `utils/**` was generated with these rules (so a function you port has the signature the callers already use):
parameters keep the Rust names in camelCase; handles are numbers; `List` -> `xStart, xLen`; `Span` -> `xStart, xEnd`; `Ident` -> `xAtom, xPos`;
`EntityName` -> `xStart, xLen`; `Key` -> the owner Node; `AstNodes` -> an `an`; `f` is last; an `Option` is `-1`; a `&[Comment]` result is the count with the range in
`cx.comments.from/to`; the `jsx`/`template`/`regex` handle of a function that takes an expression *and* its payload (`write_template_literal(e, template, f)`)
is just `e`. `utils/*` functions that Rust makes methods of a `Format` struct (`FormatKey::new`, `FormatDecorators::of_param`) are `fmtKey`, `fmtDecoratorsOfParam`.
Enums are `PREFIX_VARIANT` ints in the file of the enum. If you must change a signature, change it in your file and fix the callers (`grep -rn "fnName(" src/format/js`).
