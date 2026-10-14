// Leaf state of the handle layer (no imports of the other modules of this directory, so that its globals are plain loads):
// the per-file state `F`, the lazily built parents of types `TP`, scratch buffers, and the queries on the file that every
// handle uses. Rust: the non-HIR fields of `File` and `Lazy` (lint/ast/mod.rs) and `Parents` (lint/ast/node.rs).
import { hir } from "../../sema/hir.ts";
import { Names } from "../../sema/parser/names.ts";
import { I32Vec, Bytes } from "../../sema/vec.ts";
import { commentEndingAt, commentStartAt } from "../tokens/mod.ts";
import { tokenEnd, whiteSpaceLen } from "../../sema/check/spans.ts";

/** Per-thread state of the file the handles read (Rust: the non-HIR fields of `File` and `Lazy`). */
export class FileState {
  /** The atom table of the parser (the file's own atoms). Set by `fileBegin`. */
  names: Names = new Names();
  /** `languageOptions.parser == Parser::Espree` (JavaScript files); false: typescript-estree. */
  isEspree: boolean = false;
  /** `languageOptions.sourceType == "module"`. */
  isModuleSource: boolean = false;
  /** `bun_sema` could not tell that every node is part of something (see `bound.complete`). */
  parentsComplete: boolean = false;
  /** A bit per expression: it is in parentheses (`Lazy::parenthesized`, eager here). */
  parenBits: Int32Array = new Int32Array(64);
  /** `Lazy::unicode_escapes`: the position of each `\u` in the text, in order. */
  unicodeEscapes: I32Vec = new I32Vec(16);
  /** The first and the last of them; (0, MAX) until `buildUnicodeEscapes` has run. */
  unicodeFirst: number = 0;
  unicodeLast: number = 0x7fffffff;
  /** `Lazy::jsx_tags_with_dots`: rows (start, end) sorted by start; built on first use. */
  jsxDotTags: I32Vec = new I32Vec(16);
  jsxDotTagsBuilt: boolean = false;
  /** The `{` of each function whose body is a block, by FnId (-1: none); built on first use. */
  bodyOpen: Int32Array = new Int32Array(64);
  bodyOpenBuilt: boolean = false;
  /** `Lazy::directives`: where the statements of the last body asked about start, and where their leading strings end. */
  directivesKnown: boolean = false;
  directivesStart: number = 0;
  directivesEnd: number = 0;
  /** `Lazy::jsdoc`: the outline of the JSDoc comments has been read (lint/ast/jsdoc.ts). */
  jsdocBuilt: boolean = false;
  /** The last `funcParamsSpan` that found a span (a function and the span); -1: none. */
  paramsFn: number = -1;
  paramsStart: number = 0;
  paramsEnd: number = 0;
}

export const F = new FileState();


/**
 * `Parents` (lint/ast/node.rs): the parents of types, type parameters and tuple elements, and of the `this` of a `this` parameter. One pass
 * over the vectors of the HIR (node.ts `buildTypeParents`), the first time one is asked for. Each entry is a packed Node.
 */
export class TypeParents {
  built: boolean = false;
  types: Int32Array = new Int32Array(64);
  typeParams: Int32Array = new Int32Array(64);
  tupleElems: Int32Array = new Int32Array(64);
  /** Rows (ExprId of the operand of `typeof`, TypeNodeId of the type), sorted by the operand. */
  queryOperands: I32Vec = new I32Vec(16);
  /** Rows (PatId of a `this`, ParamId), sorted by the pattern. */
  thisNames: I32Vec = new I32Vec(16);
  /** For each row of `hir.importAttributes`: the owner, packed (0 = NODE_FILE if none). */
  importAttributes: Int32Array = new Int32Array(16);
  /** Whether the file has a JSDoc type (`T?`), which is an error with no children. */
  hasErrors: boolean = false;
}

export const TP = new TypeParents();

/** Scratch of `exprStringValue` / `exprJsxTextValue`. */
export const JSX_SCRATCH = new Bytes(64);
/** Scratch of the key of a `bigint` literal (decl.ts). */
export const BIGINT_SCRATCH = new Bytes(64);

/** `Expr::is_parenthesized` (`File::is_parenthesized`): the expression `e` is in parentheses. */
export function fileIsParenthesized(e: number): boolean {
  if (hir.nParens === 0 || e < 0) return false;
  return (((F.parenBits[e >> 5] | 0) >> (e & 31)) & 1) !== 0;
}

/** `File::has_no_unicode_escape_in`: it is known that the text has no `\u` from `pos` to `end`. */
export function fileHasNoUnicodeEscapeIn(pos: number, end: number): boolean {
  const F$ = F;
  return end <= F$.unicodeFirst || F$.unicodeLast < pos;
}

/**
 * `File::end_of_identifier`: where the identifier at `pos` ends. The HIR says `end`, which for some identifiers that are written
 * with an escape is `pos` and the length of the name. That is past the first escape.
 */
export function fileEndOfIdentifier(pos: number, end: number): number {
  const F$ = F;
  if (end <= F$.unicodeFirst || F$.unicodeLast < pos) return end;
  // the first `\u` at or after `pos`
  const v = F$.unicodeEscapes;
  let lo = 0;
  let hi = v.len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((v.data[mid] | 0) < pos) lo = mid + 1;
    else hi = mid;
  }
  const hir$ = hir;
  if (lo < v.len && (v.data[lo] | 0) < end) {
    // `end.max(pos + token_len(text[pos..]))`
    const e2 = tokenEnd(hir$.text, hir$.sourceLen | 0, pos, false);
    return e2 > end ? e2 : end;
  }
  return end;
}

/**
 * `File::end_of_token_before`: the end of the token before the one that starts at `at`, over whitespace and comments. 0 if there is
 * none. Rust asks the token scanner where a line comment or a `*&#47;` may be in the way; here the list of comments that the lexer
 * made (`hir.comments`, and a `#!` line) says where they are, which is also exact for a regular expression like `/a*&#47;`.
 */
export function fileEndOfTokenBefore(at: number): number {
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  let end = at < len ? at : len;
  // A comment can end here if this is where we start, after a line break (a line comment ends before it), or after a `/`.
  let check = true;
  while (true) {
    if (end <= 0) return 0;
    const c = text[end - 1] | 0;
    if (check || c === 47) {
      const k = commentEndingAt(end);
      if (k >= 0) {
        end = commentStartAt(k);
        check = false;
        continue;
      }
    }
    check = false;
    if (c === 10 || c === 13) {
      end = ((end | 0) - 1) | 0;
      check = true;
    } else if (c === 32 || c === 9 || c === 0x0b || c === 0x0c) {
      end = ((end | 0) - 1) | 0;
    } else if (c >= 0x80) {
      let w = 0;
      if (end >= 2 && whiteSpaceLen(text, len, end - 2) === 2) w = 2;
      else if (end >= 3 && whiteSpaceLen(text, len, end - 3) === 3) w = 3;
      if (w === 0) return end;
      // U+2028 and U+2029 end a line comment, as a line break does
      check = w === 3 && (text[end - 1] | 0) >= 0xa8;
      end = ((end | 0) - w) | 0;
    } else {
      return end;
    }
  }
}
