// Port of the part of vendor/bun/src/lint/tokens/mod.rs that the handles and the formatter use.
//
// Rust: "The HIR does not store tokens. Two ways to get at them": (1) `skip_trivia`, `skip_trivia_back`, `token_len`, `next_token`
// look at the text next to a position that is known to be a token boundary; (2) the `SourceCode` methods of `File`, which scan
// the whole file once (`tokens/scan.rs`, 1,285 lines) and then binary-search.
//
// (1) is ported here. Of (2) only the comments are: the formatter asks for `file.comments()` and for the end of the token
// before a position (`File::end_of_token_before`), and both can be had from `hir.comments`, the list of comments that the lexer
// made (exact: it knows strings, regular expressions and templates). The token scanner itself (`file.tokens()`, `first_token`,
// `token_before`, ...) is NOT ported: no handle and nothing in `vendor/bun/src/format/js` calls it. What is missing for
// `file.comments()` is the HTML-like comment of a script (`<!--`, `-->`), which `hir.comments` does not list:
// `commentsNeedTokenScan()` tells.
import { hir } from "../../sema/hir.ts";
import { SP } from "../span.ts";
import {
  identEnd,
  skipTrivia as skipTriviaText,
  skipTriviaBack as skipTriviaBackText,
  tokenEnd,
} from "../../sema/check/spans.ts";

/** `TokenKind` of a comment, as `file.comments()` yields them. */
export const TK_LINE: number = 0;
export const TK_BLOCK: number = 1;
export const TK_SHEBANG: number = 2;

/**
 * `skip_trivia(text, at)`: from `at`, past whitespace and comments: the start of the next token, or the end of the text.
 * `at` has to be between tokens. `text`: `hir.text`, `len`: `hir.sourceLen`.
 */
export function skipTrivia(text: Uint8Array, len: number, at: number): number {
  return skipTriviaText(text, len, at);
}

/** `skip_trivia_back(text, at)`: from `at` back over whitespace and comments: the end of the previous token, or 0. */
export function skipTriviaBack(text: Uint8Array, len: number, at: number): number {
  return skipTriviaBackText(text, len, at);
}

/** `token_len(&text[at..])`: the length of the token that starts at `at`, which is 0 only at the end of the text. */
export function tokenLen(text: Uint8Array, len: number, at: number): number {
  return (tokenEnd(text, len, at, false) - at) | 0;
}

/** `next_token(text, at)`: the token after `at`, past whitespace and comments: `SP = (start, end)`, empty at the end of the text. */
export function nextToken(text: Uint8Array, len: number, at: number): void {
  const start = skipTriviaText(text, len, at);
  const SP$ = SP;
  SP$.s0 = start | 0;
  SP$.s1 = tokenEnd(text, len, start, false) | 0;
}

/** The end of the identifier that starts at `at` (`scanIdentifierParts`). */
export function identifierEndAt(text: Uint8Array, len: number, at: number): number {
  return identEnd(text, len, at);
}

// ───────────────────────────── comments ─────────────────────────────

/** Whether the text starts with a `#!` line (after a byte order mark) that is a comment of the file: index 0 of the comments. */
let shebangEnd: number = -1;
let shebangStart: number = 0;
let htmlComments: boolean = false;

/** Per file: finds the `#!` line. `isTypeScriptDialect`: `Dialect::of(file) == TypeScript`. `isModule`: `languageOptions.sourceType`. */
export function commentsBegin(isTypeScriptDialect: boolean, isModule: boolean): void {
  const hir$ = hir;
  const text = hir$.text;
  const len = hir$.sourceLen | 0;
  const start = len >= 3 && (text[0] | 0) === 0xef && (text[1] | 0) === 0xbb && (text[2] | 0) === 0xbf ? 3 : 0;
  shebangEnd = -1;
  shebangStart = start;
  if (start + 1 < len && (text[start] | 0) === 35 && (text[start + 1] | 0) === 33) {
    let end = (start + 2) | 0;
    while (end < len) {
      const c = text[end] | 0;
      if (c === 10 || c === 13) break;
      if (c === 0xe2 && end + 2 < len && (text[end + 1] | 0) === 0x80 && ((text[end + 2] | 0) === 0xa8 || (text[end + 2] | 0) === 0xa9)) break;
      end = ((end | 0) + 1) | 0;
    }
    // `end > start + 2 || Dialect::of(file) != TypeScript`
    if (end > start + 2 || !isTypeScriptDialect) shebangEnd = end;
  }
  // `has_html_comments(file)` and the text mentions `<!--` or `-->`
  htmlComments = false;
  if (!isTypeScriptDialect && !isModule) {
    for (let i = 0; i + 2 < len; i = ((i | 0) + 1) | 0) {
      const c = text[i] | 0;
      if (c === 60 && (text[i + 1] | 0) === 33 && (text[i + 2] | 0) === 45 && i + 3 < len && (text[i + 3] | 0) === 45) {
        htmlComments = true;
        break;
      }
      if (c === 45 && (text[i + 1] | 0) === 45 && (text[i + 2] | 0) === 62) {
        htmlComments = true;
        break;
      }
    }
  }
}

/** `true`: the file has `<!--` or `-->` in a script, which are comments for espree and are not in `hir.comments`. The list is incomplete. */
export function commentsNeedTokenScan(): boolean {
  return htmlComments;
}

/** The number of comments of `file.comments()`: a `#!` line first, then the comments of the lexer. */
export function commentsLen(): number {
  return ((hir.comments.len >> 1) + (shebangEnd >= 0 ? 1 : 0)) | 0;
}

/** Start of the comment `i` of `file.comments()`. */
export function commentStartAt(i: number): number {
  const hir$ = hir;
  if (shebangEnd >= 0) {
    if (i === 0) return shebangStart;
    return hir$.comments.data[(i - 1) * 2] | 0;
  }
  return hir$.comments.data[i * 2] | 0;
}

/** End of the comment `i`. */
export function commentEndAt(i: number): number {
  const hir$ = hir;
  if (shebangEnd >= 0) {
    if (i === 0) return shebangEnd;
    return hir$.comments.data[(i - 1) * 2 + 1] | 0;
  }
  return hir$.comments.data[i * 2 + 1] | 0;
}

/** `Token::kind` of the comment `i`: `TK_LINE`, `TK_BLOCK` or `TK_SHEBANG`. */
export function commentKindAt(i: number): number {
  if (shebangEnd >= 0 && i === 0) return TK_SHEBANG;
  const start = commentStartAt(i);
  return (hir.text[start + 1] | 0) === 42 ? TK_BLOCK : TK_LINE;
}

/**
 * `Token::comment_value_span` of the comment `i`, into `SP`: a block without `/*` and `*&#47;`, a line without `//`, a shebang without `#!`.
 */
export function commentValueSpan(i: number): void {
  const k = commentKindAt(i);
  const s = commentStartAt(i);
  const e = commentEndAt(i);
  const SP$ = SP;
  if (k === TK_BLOCK) {
    SP$.s0 = (s + 2) | 0;
    SP$.s1 = (e > 2 ? (e - 2) | 0 : 0) | 0;
  } else {
    SP$.s0 = (s + 2) | 0;
    SP$.s1 = (e) | 0;
  }
}

/** The index of the comment that ends exactly at `end`, or -1 (comments are sorted and do not overlap). */
export function commentEndingAt(end: number): number {
  let lo = 0;
  let hi = commentsLen();
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (commentEndAt(mid) < end) lo = mid + 1;
    else hi = mid;
  }
  return lo < commentsLen() && commentEndAt(lo) === end ? lo : -1;
}

/** The index of the comment that `offset` is in (`start <= offset < end`), or -1: `File::comment_around`. */
export function commentAround(offset: number): number {
  let lo = 0;
  let hi = commentsLen();
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (commentStartAt(mid) <= offset) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  return i >= 0 && offset < commentEndAt(i) ? i : -1;
}
