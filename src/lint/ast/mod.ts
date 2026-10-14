// Port of vendor/bun/src/lint/ast/mod.rs: the `File` of the handles, and what is derived from the HIR once per file.
//
// A Rust handle is `(&File, id)`. Here a handle is the `id` alone (an Int32 row index of a table of `hir`, `NONE = -1` for
// `Option::None`), and there is one file per thread: the `hir` (src/sema/hir.ts), the binder's parent tables
// (src/sema/bind/parents.ts) and the state below. A parsed file is valid until the next `beginFile`.
//
// Per file, after parsing (`beginFile`, `lx.begin`, parse, `finishHir`), call
//
//     fileBegin(names, parserIsTypeScript, isModule);
//
// once. It fills the parent tables (`fillParents`), the bit per parenthesized expression, the `\u` escapes of the text and the
// comments. Everything else that Rust computes lazily (`Lazy`) is a lazily filled per-thread array with a `built` flag that
// `fileBegin` clears: `jsx_tags_with_dots`, the parents of types (`node.ts`), the `{` of each function body.
//
// What is NOT here (see docs/LINT_AST_API.md "Not ported"): the hidden JSDoc casts (`hides_casts`, `has_synthetic_nodes`,
// `jsdoc_comments`: the parser here never reads JSDoc), types/modules/linter state of `File` (`types`, `sink`, `modules`, ..),
// `extension`, `language().settings`.
import { hir, FK_DECLARATION } from "../../sema/hir.ts";
import { F, TP } from "./state.ts";
import { bound, fillParents } from "../../sema/bind/parents.ts";
import { Names } from "../../sema/parser/names.ts";
import { parenFirst } from "../../sema/hir_util.ts";
import { commentsBegin } from "../tokens/mod.ts";
import { skipTrivia } from "../../sema/check/spans.ts";
import { decodeUtf8Back, utf8Len } from "../../base/utf8.ts";
import { SP } from "../span.ts";

/**
 * Starts the handles for the file that was just parsed (the HIR is finished). `names`: the parser's atom table. `parserIsTypeScript`:
 * `languageOptions.parser == TypeScript` (the file is `.ts`, `.tsx`, `.mts`, `.cts`), otherwise espree. `isModule`: the
 * source type is "module" (`!is_script`).
 */
export function fileBegin(names: Names, parserIsTypeScript: boolean, isModule: boolean): void {
  F.names = names;
  F.isEspree = !parserIsTypeScript;
  F.isModuleSource = isModule;
  F.parentsComplete = fillParents();
  buildParenthesized();
  F.unicodeEscapes.reset();
  F.unicodeFirst = 0;
  F.unicodeLast = 0x7fffffff;
  buildUnicodeEscapes();
  F.jsxDotTags.reset();
  F.jsxDotTagsBuilt = false;
  F.bodyOpenBuilt = false;
  F.paramsFn = -1;
  F.directivesKnown = false;
  F.jsdocBuilt = false;
  TP.built = false;
  // `Dialect::of(file)`: espree for JavaScript unless the parser is TypeScript's.
  commentsBegin(!(hir.isJs && !parserIsTypeScript), isModule);
}

function buildParenthesized(): void {
  const words = ((hir.nExprs >> 5) + 1) | 0;
  if (F.parenBits.length < words) {
    let c = F.parenBits.length;
    while (c < words) c = c * 2;
    F.parenBits = new Int32Array(c);
  }
  F.parenBits.fill(0, 0, words);
  const bits = F.parenBits;
  const n = hir.nParens | 0;
  for (let i = 0; i < n; i++) {
    const e = hir.parenExpr[i] | 0;
    bits[e >> 5] = (bits[e >> 5] | 0) | (1 << (e & 31));
  }
}

function buildUnicodeEscapes(): void {
  const text = hir.text;
  const n = hir.sourceLen | 0;
  const v = F.unicodeEscapes;
  const last = (n - 1) | 0;
  for (let i = 0; i < last; i++) {
    if ((text[i] | 0) === 92 && (text[i + 1] | 0) === 117) v.push(i);
  }
  if (v.len > 0) {
    F.unicodeFirst = v.data[0] | 0;
    F.unicodeLast = v.data[v.len - 1] | 0;
  } else {
    F.unicodeFirst = 0x7fffffff;
    F.unicodeLast = 0;
  }
}

/** `File::program_span` into `SP`: from the first token, after a `#!` line and comments, to the end of the text. */
export function fileProgramSpan(): void {
  SP[0] = skipTrivia(hir.text, hir.sourceLen | 0, 0);
  SP[1] = hir.sourceLen | 0;
}

/** `File::span` into `SP`: the whole text. */
export function fileSpan(): void {
  SP[0] = 0;
  SP[1] = hir.sourceLen | 0;
}

/** `.js`, `.jsx`, `.mjs`, `.cjs` */
export function fileIsJavascript(): boolean {
  return hir.isJs;
}

/** The file is parsed as Flow. */
export function fileIsFlow(): boolean {
  return hir.isFlow;
}

/** `.d.ts`, `.d.mts`, `.d.cts` */
export function fileIsDeclarationFile(): boolean {
  return (hir.kind | 0) === FK_DECLARATION;
}

/** `languageOptions.sourceType` is "module". */
export function fileIsModule(): boolean {
  return F.isModuleSource;
}

/** The parser reported an error (`hir.has_errors || hir.has_parse_diagnostics`). */
export function fileHasParseErrors(): boolean {
  return hir.hasErrors || hir.hasParseDiagnostics;
}

/** The statements at the top level: a list `(fileBodyStart(), fileBodyLen())` of StmtIds in `hir.ids`. */
export function fileBodyStart(): number {
  return hir.bodyStart | 0;
}
export function fileBodyLen(): number {
  return hir.bodyLen | 0;
}

/** `File::has_bom`: the text starts with a byte order mark. */
export function fileHasBom(): boolean {
  const t = hir.text;
  return hir.sourceLen >= 3 && (t[0] | 0) === 0xef && (t[1] | 0) === 0xbb && (t[2] | 0) === 0xbf;
}

/** `File::slice` is `hir.text.subarray(start, end)`; the formatter works on `(hir.text, start, end)`. */
export function fileTextLen(): number {
  return hir.sourceLen | 0;
}

/** `File::has_with_statements` */
export function fileHasWithStatements(): boolean {
  return hir.withBodiesLen > 0;
}

/** Whether the parentheses table has a row for `e` (kept for `parens()` loops). */
export function fileParenFirst(e: number): number {
  return parenFirst(e);
}

/** The binder's tables, for the modules of this directory. */
export const B = bound;

/** `File::may_bind_a_parameter_twice` */
export function fileMayBindAParameterTwice(): boolean {
  return hir.mayBindAParameterTwice;
}

/** `File::has_rare_syntax`: whether `hir.rareSyntax` has one of the bits `RARE_*`. */
export function fileHasRareSyntax(bit: number): boolean {
  return ((hir.rareSyntax | 0) & bit) !== 0;
}

/** Decodes the character that ends at `end`, for the callers that need to look behind a position (UTF-8). */
export function charBefore(end: number): number {
  return decodeUtf8Back(hir.text, 0, end);
}
export function charBeforeLen(): number {
  return utf8Len();
}
