// Port of vendor/bun/src/format/js/comments.rs: the comments of a file, and which of them have been printed.
//
// Prettier attaches every comment to a node before it prints anything. This does what oxc does instead: nothing is attached. The
// comments are kept in source order with a cursor, `printedCount`. Whoever prints a node asks for the comments that are not printed yet
// and are before, after or inside it, by position. Printing a comment moves the cursor.
//
// This only works if comments are printed in source order, and every comment is printed. Most nodes have no comment near them, and find
// that out by one comparison: `Comments.nextStart()`.
//
// Where Prettier attaches a comment to a node that it is not next to, so that it is printed somewhere else, the comment is moved before
// anything is printed: see `Comments.cs`.
//
// ## Representation
//
// A Rust `Comment` is an index `i` into the columns of the `Comments` table (struct of arrays):
//   spanStart[i], spanEnd[i]   where its text is (`comment.span`)
//   cs[i], ce[i]               `comment.start()` / `comment.end()`: where it counts as being (moved comments have no width)
//   kind[i]                    CK_LINE, CK_SINGLE_LINE_BLOCK, CK_MULTI_LINE_BLOCK
//   flags[i]                   CF_* bits; `movedTo[i]` (-1: not moved); `leadsUntil[i]`
// A Rust `&[Comment]` is a range `[from, to)` of indices. Every query that returns one writes `cm.from` and `cm.to` and returns the count
// (`to - from`): read them right after the call, before the next query. The functions of trivia.ts that write comments take `(from, to)`.
// "No position" (`u32::MAX`) is `INF` (0x7fffffff).
import { sortInt32By } from "../sort.ts";
import { FLAVOR_OXFMT } from "../options.ts";
import { I32Vec } from "../../sema/vec.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  BIN_COMMA,
  EXPR_ASSIGN,
  EXPR_BINARY,
  EXPR_CALL,
  EXPR_DOT,
  EXPR_IDENT,
  EXPR_INDEX,
  EXPR_NEW,
  EXPR_NON_NULL,
  EXPR_OBJECT,
  EXPR_ARRAY,
  EXPR_TEMPLATE,
  EXPR_TAGGED_TEMPLATE,
  EXPR_JSX,
  BODY_NONE,
  N_EXPR,
  N_FUNC,
  N_MEMBER,
  N_PARAM,
  N_PAT_ELEM,
  N_PAT_PROP,
  N_PROP,
  N_STMT,
  N_TYPE,
  N_VAR_DECL,
  NODE_FILE,
  PROP_INIT,
  SP,
  STMT_FN,
  TK_BLOCK,
  TK_LINE,
  TYPE_FN,
  callArgsLen,
  callArgsStart,
  callTypeArgsLen,
  callTypeArgsStart,
  commentEndAt,
  commentKindAt,
  commentStartAt,
  commentValueSpan,
  commentsLen,
  exprAsCallLike,
  exprAssignTarget,
  exprAssignValue,
  exprBinaryLeft,
  exprBinaryOp,
  exprBinaryRight,
  exprCallee,
  exprDotNamePos,
  exprDotObj,
  exprIndexIndex,
  exprIndexObj,
  exprIsAssignmentTarget,
  exprIsChainRoot,
  exprIsOptional,
  exprIsParenthesized,
  exprIsPrivateMember,
  exprNonNullExpr,
  exprParent,
  exprParenCount,
  exprParenFirst,
  exprSpan,
  exprEnd,
  exprStart,
  exprTag,
  fileIsJavascript,
  funcBodyKind,
  funcCloseParen,
  funcOpenParen,
  funcOwner,
  funcReturnType,
  funcThisParam,
  funcTypeParamsLen,
  funcParamsLen,
  hir,
  listAt,
  memberFunc,
  memberIsSignature,
  keyKind,
  KEY_NONE,
  nodeChildren,
  nodeId,
  nodeKind,
  nodeSpan,
  paramDefault,
  paramPat,
  patElemDefault,
  patElemPat,
  patPropDefault,
  patPropValue,
  patSpan,
  propKind,
  propParent,
  propSpan,
  propValue,
  stmtTag,
  typeListAngleBrackets,
  typeSpan,
  typeTag,
  typeFnFn,
  varDeclInit,
  varDeclPat,
  varDeclTy,
} from "../../lint/ast/index.ts";
import {
  BT_ASCII_WS,
  BT_BLANK_VT_FF,
  BT_END_OF_LINE_BETWEEN,
  BT_SPACE_TAB,
  BT_SPACE_TAB_CLOSE_PAREN_SEMI,
  BT_WS_CLOSE_PAREN_COMMA_SEMI,
  BT_WS_COMMA_SEMI,
  BT_WS_OPEN_PAREN,
  LINE,
  SourceText,
  lineEndAt,
} from "./source_text.ts";

export const INF: number = 0x7fffffff;

export const CK_LINE: number = 0;
export const CK_SINGLE_LINE_BLOCK: number = 1;
export const CK_MULTI_LINE_BLOCK: number = 2;

export const NOT_MOVED: number = -1;

export const CF_PRECEDED_BY_NEWLINE: number = 1 << 0;
export const CF_FOLLOWED_BY_NEWLINE: number = 1 << 1;
export const CF_INDENTABLE: number = 1 << 2;
export const CF_TYPE_CAST: number = 1 << 3;
/** Prettier's `isTypeCastComment`, which is asked of the comment alone. */
export const CF_LOOKS_LIKE_TYPE_CAST: number = 1 << 4;
/** See `flavorIsIgnoreComment`. */
export const CF_SUPPRESSION: number = 1 << 5;
/** It is between the two sides of a declarator or an assignment and trails the left one. */
export const CF_TRAILS_LEFT_SIDE: number = 1 << 6;
/** It trails the object of a member access, what is called or what a `!` follows, and has been moved to the end of that. */
export const CF_TRAILS_LINK: number = 1 << 7;
/** It leads a link of a member chain: it is written before the `.b`, `[b]`, `(..)` or `!`, and has been moved to the end of what that follows. */
export const CF_LEADS_LINK: number = 1 << 8;

/** `/@(?:type|satisfies)\b/` in text[start, end) (Prettier's `isTypeCastComment` is on the comment value). */
export function isTypeCastText(text: Uint8Array, start: number, end: number): boolean {
  let rest = start;
  while (rest < end) {
    let at = -1;
    for (let i = rest; i < end; i++) {
      if ((text[i] | 0) === 64) {
        at = i;
        break;
      }
    }
    if (at < 0) return false;
    rest = at + 1;
    if (matchesTag(text, rest, end, "type") || matchesTag(text, rest, end, "satisfies")) return true;
  }
  return false;
}

function matchesTag(text: Uint8Array, at: number, end: number, tag: string): boolean {
  const n = tag.length;
  if (at + n > end) return false;
  for (let i = 0; i < n; i++) if ((text[at + i] | 0) !== tag.charCodeAt(i)) return false;
  if (at + n < end) {
    const b = text[at + n] | 0;
    // `\b`: the next byte is not a word byte
    if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95) return false;
  }
  return true;
}

/** `content`: what is between `/*` and `*&#47;`. */
function isIndentableText(text: Uint8Array, start: number, end: number): boolean {
  // lines = split_crlf_lines(content).skip(1).peekable()
  lineEndAt(text, start, end);
  let pos = start;
  const LINE$ = LINE;
  let lineEnd = LINE$.s0 | 0;
  let brk = LINE$.s1 | 0;
  if (brk === 0) return false;
  pos = lineEnd + brk;
  while (true) {
    lineEndAt(text, pos, end);
    lineEnd = LINE$.s0 | 0;
    brk = LINE$.s1 | 0;
    const isLast = brk === 0;
    const first = trimJsWhitespaceStart(text, pos, lineEnd);
    // The last line goes on with the `*` of `*/`.
    if ((first >= lineEnd || (text[first] | 0) !== 42) && !(first >= lineEnd && isLast)) return false;
    if (isLast) return true;
    pos = lineEnd + brk;
  }
}

/** `starts_with_assignment_operator(text[at..])`: `=`, `+=`, `>>>=`, `??=`. Also `<=` and `>=`. */
function startsWithAssignmentOperator(text: Uint8Array, at: number): boolean {
  const n = text.length;
  let i = at;
  let taken = 0;
  while (i < n && taken < 4) {
    const b = text[i] | 0;
    // + - * / % < > & | ^ ?
    if (b === 43 || b === 45 || b === 42 || b === 47 || b === 37 || b === 60 || b === 62 || b === 38 || b === 124 || b === 94 || b === 63) {
      i = i + 1;
      taken = taken + 1;
    } else break;
  }
  if (i + 1 < n && (text[i] | 0) === 61) {
    const after = text[i + 1] | 0;
    return after !== 61 && after !== 62;
  }
  return false;
}

function isOperatorByte(b: number): boolean {
  return (
    b === 43 || b === 45 || b === 42 || b === 47 || b === 37 || b === 60 || b === 62 || b === 38 || b === 124 || b === 94 || b === 63 || b === 61 || b === 33
  );
}

/** Only Babel, which Prettier parses JavaScript with, tells it about the parentheses after `/** @type {T} *&#47;`. In TypeScript they are parentheses like any other. oxfmt keeps them there too. */
function typeCastsAreKeptInTypescript(flavor: number): boolean {
  return flavor === FLAVOR_OXFMT;
}

/** oxfmt writes no comment before one that it follows in the source. Which side of an operator a comment belongs to is decided where the operator is written. */
function commentsKeepTheirOrder(flavor: number): boolean {
  return flavor === FLAVOR_OXFMT;
}

/** oxfmt has no `handleMemberExpressionComments`: `a ⏎ // comment ⏎ .b` stays as it is. */
function commentsStayInMemberExpressions(flavor: number): boolean {
  return flavor === FLAVOR_OXFMT;
}

// ───────────────────────────── the table and the cursor ─────────────────────────────

/** How many of the comments in `[from, to)` end before `pos`: the ends ascend as the starts do. */
function countThatEndBefore(ce: Int32Array, from: number, to: number, pos: number): number {
  const NEAR = 4;
  let near = 0;
  while (near < NEAR && from + near < to && (ce[from + near] | 0) < pos) near = near + 1;
  if (near < NEAR || from + near >= to) return near;
  // partition_point over the rest
  let lo = from + NEAR;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + ((hi - lo) >> 1)) | 0;
    if ((ce[mid] | 0) < pos) lo = (mid + 1) | 0;
    else hi = mid;
  }
  return (lo - from) | 0;
}

export class Comments {
  source: SourceText;
  /** The number of comments. */
  n: number = 0;
  spanStart: Int32Array = new Int32Array(64);
  spanEnd: Int32Array = new Int32Array(64);
  /** `Comment::start()` / `end()`: where it counts as being. */
  cs: Int32Array = new Int32Array(64);
  ce: Int32Array = new Int32Array(64);
  movedTo: Int32Array = new Int32Array(64);
  /** Where the member access ends that it leads, if it has been moved to the start of that. Otherwise 0. */
  leadsUntil: Int32Array = new Int32Array(64);
  kind: Uint8Array = new Uint8Array(64);
  flags: Int32Array = new Int32Array(64);

  /** `inner[..printedCount]` are printed. */
  printedCount: number = 0;
  /** The comments from this index on are hidden. -1: none. */
  viewLimit: number = -1;
  /** Some comment is a type cast: `/** @type {T} *&#47; (e)`. */
  hasTypeCastComments: boolean = false;
  hasSuppressionComments: boolean = false;
  hasCommentsTrailingLinks: boolean = false;
  /** See `markSuppressedAfterOperator`. */
  suppressedAfterOperator: number = INF;
  /** See `hideCommentsFrom`. */
  hiddenFrom: number = INF;

  /** The range that the last query returned. */
  from: number = 0;
  to: number = 0;

  constructor() {
    this.source = new SourceText(new Uint8Array(0));
  }

  /** Makes room for `count` comments. */
  reserve(count: number): void {
    if (this.spanStart.length >= count) return;
    let c = this.spanStart.length;
    while (c < count) c = c * 2;
    this.spanStart = new Int32Array(c);
    this.spanEnd = new Int32Array(c);
    this.cs = new Int32Array(c);
    this.ce = new Int32Array(c);
    this.movedTo = new Int32Array(c);
    this.leadsUntil = new Int32Array(c);
    this.kind = new Uint8Array(c);
    this.flags = new Int32Array(c);
  }

  /** `Comments::new`: after the table is filled (`n` set). */
  begin(source: SourceText): void {
    this.source = source;
    this.printedCount = 0;
    this.viewLimit = -1;
    this.suppressedAfterOperator = INF;
    this.hiddenFrom = INF;
    this.from = 0;
    this.to = 0;
  }

  /** Computes the flags of the file from the table. */
  summarize(): void {
    let fl = 0;
    const n = this.n;
    for (let i = 0; i < n; i++) fl = fl | (this.flags[i] | 0);
    this.hasTypeCastComments = (fl & CF_TYPE_CAST) !== 0;
    this.hasSuppressionComments = (fl & CF_SUPPRESSION) !== 0;
    this.hasCommentsTrailingLinks = (fl & CF_TRAILS_LINK) !== 0;
  }

  // ───── accessors of a comment (Rust methods of `Comment`) ─────

  isLine(i: number): boolean {
    return (this.kind[i] | 0) === CK_LINE;
  }
  isBlock(i: number): boolean {
    return (this.kind[i] | 0) !== CK_LINE;
  }
  isMultilineBlock(i: number): boolean {
    return (this.kind[i] | 0) === CK_MULTI_LINE_BLOCK;
  }
  isMoved(i: number): boolean {
    return (this.movedTo[i] | 0) !== NOT_MOVED;
  }
  precededByNewline(i: number): boolean {
    return ((this.flags[i] | 0) & CF_PRECEDED_BY_NEWLINE) !== 0;
  }
  /**
   * Whether the first comment that is not printed is on a line of its own and has not been moved, and a word (a keyword, a name) follows
   * it. Then it is not a trailing comment of anything before it: a node follows it in the same parent, so it leads that one.
   */
  firstLeadsWord(): boolean {
    const p = this.printedCount;
    if (((this.flags[p] | 0) & CF_PRECEDED_BY_NEWLINE) === 0 || (this.movedTo[p] | 0) !== NOT_MOVED) return false;
    const text = this.source.text;
    const n = text.length;
    let i = this.ce[p] | 0;
    while (i < n) {
      const b = text[i] | 0;
      if (b === 32 || b === 10 || b === 9 || b === 13) i = (i + 1) | 0;
      else return (b >= 97 && b <= 122) || (b >= 65 && b <= 90) || b === 95 || b === 36;
    }
    return false;
  }
  followedByNewline(i: number): boolean {
    return ((this.flags[i] | 0) & CF_FOLLOWED_BY_NEWLINE) !== 0;
  }
  isIndentableBlock(i: number): boolean {
    return ((this.flags[i] | 0) & CF_INDENTABLE) !== 0;
  }
  /** `a⏎// comment⏎.b.c`: whether it, which is before the node that ends at `spanEnd`, leads a member access that the node starts with. */
  leadsLeftEdgeOf(i: number, spanEnd: number): boolean {
    const l = this.leadsUntil[i] | 0;
    return l !== 0 && l < spanEnd;
  }
  /** Without the delimiters: writes `SP`. */
  contentSpan(i: number): void {
    const s = this.spanStart[i] | 0;
    const e = this.spanEnd[i] | 0;
    const SP$ = SP;
    if ((this.kind[i] | 0) === CK_LINE) {
      SP$.s0 = (s + 2) | 0;
      SP$.s1 = (e) | 0;
    } else {
      SP$.s0 = (s + 2) | 0;
      SP$.s1 = (e >= 2 ? (e - 2) | 0 : 0) | 0;
    }
  }

  // ───── the cursor ─────

  /** The end of the unprinted comments that can be seen (exclusive index). */
  limit(): number {
    const v = this.viewLimit;
    let end = v < 0 ? this.n : v;
    if (this.hiddenFrom < end) end = this.hiddenFrom;
    return end;
  }

  /** The unprinted comments: `[printedCount, limit)`. Sets `from`/`to`, returns the count. */
  unprinted(): number {
    const from = this.printedCount;
    let to = this.limit();
    if (to < from) to = from;
    this.from = from;
    this.to = to;
    return (to - from) | 0;
  }

  /**
   * Where the first comment that is not printed starts. `INF` if there is none. Nothing before this position has to think about
   * comments.
   */
  nextStart(): number {
    const p = this.printedCount;
    if (p >= this.limit()) return INF;
    return this.cs[p] | 0;
  }

  /** Whether there is a comment that is not printed (and not hidden). */
  hasUnprinted(): boolean {
    return this.printedCount < this.limit();
  }

  /** The span of the first unprinted comment into `SP`: false if there is none. */
  firstUnprintedSpan(): boolean {
    const p = this.printedCount;
    if (p >= this.limit()) return false;
    const SP$ = SP;
    SP$.s0 = this.spanStart[p] | 0;
    SP$.s1 = this.spanEnd[p] | 0;
    return true;
  }

  /** `printed_comments().last()`: the index, or -1. */
  lastPrinted(): number {
    return this.printedCount > 0 ? (this.printedCount - 1) | 0 : -1;
  }

  /** Has to be called for each comment that is printed. */
  incrementPrintedCount(): void {
    this.printedCount = (this.printedCount + 1) | 0;
  }

  /** Marks the comments that end at or before `pos` as printed. */
  skipCommentsBefore(pos: number): void {
    this.printedCount = (this.printedCount + this.countBefore(pos)) | 0;
  }

  /** The number of unprinted comments that end at or before `pos`. */
  countBefore(pos: number): number {
    const lim = this.limit();
    const ce = this.ce;
    let i = this.printedCount;
    while (i < lim && (ce[i] | 0) <= pos) i = (i + 1) | 0;
    return (i - this.printedCount) | 0;
  }

  // ───── state ─────

  snapshotPrinted(): number {
    return this.printedCount;
  }
  snapshotLimit(): number {
    return this.viewLimit;
  }
  restore(printedCount: number, viewLimit: number): void {
    this.printedCount = printedCount;
    this.viewLimit = viewLimit;
  }

  /** Shows the comments that start before `endPos`, hidden or not, and hides the others. Returns what to pass to `restoreViewLimit`. */
  showCommentsUpTo(endPos: number): number {
    const limit = this.partitionPointStartBefore(this.printedCount, this.n, endPos);
    const previous = this.viewLimit;
    this.viewLimit = limit;
    return previous;
  }

  /** Hides the comments that start at or after `endPos`. Returns what to pass to `restoreViewLimit`. */
  limitCommentsUpTo(endPos: number): number {
    const original = this.viewLimit;
    const limit = this.partitionPointStartBefore(this.printedCount, this.n, endPos);
    if (limit < this.n) this.viewLimit = limit;
    return original;
  }

  restoreViewLimit(limit: number): void {
    this.viewLimit = limit;
  }

  /** Hides the comments that start at or after `position`, whatever is shown or hidden with the other functions in the meantime. */
  hideCommentsFrom(position: number): number {
    const first = this.partitionPointStartBefore(0, this.n, position);
    const previous = this.hiddenFrom;
    this.hiddenFrom = first < previous ? first : previous;
    return previous;
  }

  restoreHiddenComments(hiddenFrom: number): void {
    this.hiddenFrom = hiddenFrom;
  }

  /** `a = // prettier-ignore ⏎ b`, as oxfmt has it: the comment is written behind the operator, and is about what starts at `start` all the same. */
  markSuppressedAfterOperator(start: number): void {
    this.suppressedAfterOperator = start;
  }

  /** The first index in `[from, to)` whose comment does not start before `pos` (`partition_point(|c| c.start() < pos)`). */
  partitionPointStartBefore(from: number, to: number, pos: number): number {
    let lo = from;
    let hi = to;
    const cs = this.cs;
    while (lo < hi) {
      const mid = (lo + ((hi - lo) >> 1)) | 0;
      if ((cs[mid] | 0) < pos) lo = (mid + 1) | 0;
      else hi = mid;
    }
    return lo;
  }

  /** The first index in `[from, to)` whose comment does not end before `pos` (`partition_point(|c| c.end() < pos)`). */
  partitionPointEndBefore(from: number, to: number, pos: number): number {
    let lo = from;
    let hi = to;
    const ce = this.ce;
    while (lo < hi) {
      const mid = (lo + ((hi - lo) >> 1)) | 0;
      if ((ce[mid] | 0) < pos) lo = (mid + 1) | 0;
      else hi = mid;
    }
    return lo;
  }

  // ───── queries ─────

  /**
   * Prettier's `__contentEnd`: the end of a statement that ends at `end` and starts at `start`, without the `;` at its end and the
   * comments before that. They are not in the statement but behind it: `a() /* comment *&#47;;` is `a(); /* comment *&#47;`.
   */
  withoutSemicolon(start: number, end: number): number {
    if (end <= start || this.source.byteAt(end - 1) !== 59) return end;
    let e = end - 1;
    while (true) {
      while (e > start) {
        const b = this.source.byteAt(e - 1);
        if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) e = e - 1;
        else break;
      }
      const at = this.partitionPointEndBefore(0, this.n, e);
      if (at < this.n && (this.ce[at] | 0) === e && (this.cs[at] | 0) >= start && (this.cs[at] | 0) < e) {
        e = this.cs[at] | 0;
      } else {
        return e;
      }
    }
  }

  /**
   * Prettier's `handleMethodNameComments` for the comments at the end of a member of a class, which is at `(spanStart, spanEnd)`:
   * those with code behind them on their line, a `)` or the `;`, trail the member, unless they start the line. Where they start. The
   * others are in the member.
   *
   * `valueEnd`: where the value of the member ends, without parentheses (-1: none).
   */
  startOfCommentsBeforeSemicolon(valueEnd: number, spanStart: number, spanEnd: number): number {
    const contentEnd = this.withoutSemicolon(spanStart, spanEnd);
    this.commentsIn(valueEnd >= 0 ? valueEnd : contentEnd, spanEnd);
    const from = this.from;
    const to = this.to;
    let first = to;
    while (first > from) {
      const nextStart = first < to ? this.cs[first] | 0 : spanEnd;
      if (this.source.allBytes(this.ce[first - 1] | 0, nextStart, BT_SPACE_TAB_CLOSE_PAREN_SEMI)) first = (first - 1) | 0;
      else break;
    }
    if (first < to && !this.precededByNewline(first) && to > from && (this.ce[to - 1] | 0) < spanEnd) {
      // At the very end it has no code behind it.
      return this.cs[first] | 0;
    }
    return spanEnd;
  }

  /** The comments that end at or before `pos`. Sets `from`/`to`. */
  commentsBefore(pos: number): number {
    const c = this.countBefore(pos);
    this.from = this.printedCount;
    this.to = (this.printedCount + c) | 0;
    return c;
  }

  /**
   * The comments that lead the node that starts at `spanStart` and ends at `spanEnd`: those before it, but for what leads something that
   * it starts with. For Prettier that is part of what is written for the node, and breaks the groups in it.
   */
  commentsLeadingNode(spanStart: number, spanEnd: number): number {
    const lim = this.limit();
    let i = this.printedCount;
    while (i < lim && (this.ce[i] | 0) <= spanStart && !this.leadsLeftEdgeOf(i, spanEnd)) i = (i + 1) | 0;
    this.from = this.printedCount;
    this.to = i;
    return (i - this.printedCount) | 0;
  }

  /** The comments up to the end of the node that ends at `spanEnd`. One that has been moved to where the node ends is behind it. */
  commentsBeforeEndOf(spanEnd: number): number {
    const lim = this.limit();
    let i = this.printedCount;
    while (i < lim && (this.ce[i] | 0) <= spanEnd && (!this.isMoved(i) || (this.ce[i] | 0) < spanEnd)) i = (i + 1) | 0;
    this.from = this.printedCount;
    this.to = i;
    return (i - this.printedCount) | 0;
  }

  /** Of the comments that end at or before `pos`, the first ones that start their line. */
  ownLineCommentsBefore(pos: number): number {
    const lim = this.limit();
    let i = this.printedCount;
    while (i < lim && (this.ce[i] | 0) <= pos && this.precededByNewline(i)) i = (i + 1) | 0;
    this.from = this.printedCount;
    this.to = i;
    return (i - this.printedCount) | 0;
  }

  /** The comments after `pos` up to one that ends its line, if nothing but blanks, `=`, `:` and `,` is in between. */
  endOfLineCommentsAfter(pos: number): number {
    return this.endOfLineCommentsAfterBytes(pos, BT_END_OF_LINE_BETWEEN);
  }

  /** The comments that trail the left side of a declarator or an assignment whose right side starts at `rightStart`. The left side is written. */
  commentsTrailingLeftSide(rightStart: number): number {
    const lim = this.limit();
    let i = this.printedCount;
    while (i < lim && ((this.flags[i] | 0) & CF_TRAILS_LEFT_SIDE) !== 0 && (this.cs[i] | 0) < rightStart) i = (i + 1) | 0;
    this.from = this.printedCount;
    this.to = i;
    return (i - this.printedCount) | 0;
  }

  /**
   * The next comments, as far as they trail what ends at `end` and is written: the object of a member access, what is called or what a
   * `!` follows. Those in it that nothing has written are among them.
   */
  commentsTrailingLink(end: number): number {
    const lim = this.limit();
    let i = this.printedCount;
    while (i < lim && ((this.ce[i] | 0) < end || ((this.movedTo[i] | 0) === end && ((this.flags[i] | 0) & CF_TRAILS_LINK) !== 0))) i = (i + 1) | 0;
    this.from = this.printedCount;
    this.to = i;
    return (i - this.printedCount) | 0;
  }

  /** The next comments, as far as they lead the link of a member chain that follows what ends at `innerEnd`. */
  commentsLeadingLink(innerEnd: number): number {
    const lim = this.limit();
    let i = this.printedCount;
    while (i < lim && (this.movedTo[i] | 0) === innerEnd && ((this.flags[i] | 0) & CF_LEADS_LINK) !== 0) i = (i + 1) | 0;
    this.from = this.printedCount;
    this.to = i;
    return (i - this.printedCount) | 0;
  }

  /** Whether there are `commentsTrailingLink`, whatever is to be written before them. */
  hasCommentTrailingLink(end: number): boolean {
    return this.hasCommentMovedTo(end, CF_TRAILS_LINK);
  }

  /** Whether there are `commentsLeadingLink`, whatever is to be written before them. */
  hasCommentLeadingLink(innerEnd: number): boolean {
    return this.hasCommentMovedTo(innerEnd, CF_LEADS_LINK);
  }

  private hasCommentMovedTo(position: number, flag: number): boolean {
    this.commentsAfter(position);
    for (let i = this.from; i < this.to; i++) {
      if ((this.cs[i] | 0) !== position) return false;
      if (((this.flags[i] | 0) & flag) !== 0) return true;
    }
    return false;
  }

  /**
   * Prettier's `handlePropertyComments`: the comments between the key of a property, which ends at `keyEnd`, and its value, which starts
   * at `valueStart`, that lead the property: those that end their line. None if one before them does not.
   */
  commentsLeadingProperty(keyEnd: number, valueStart: number): number {
    this.commentsIn(keyEnd, valueStart);
    const from = this.from;
    let to = this.to;
    // One that starts its line leads the value, and so does a type comment: Prettier's `handleClosureTypeCastComments` comes first.
    let count = 0;
    while (from + count < to && !this.precededByNewline(from + count) && !this.looksLikeTypeCastComment(from + count)) count = (count + 1) | 0;
    to = from + count;
    let last = -1;
    for (let i = to - 1; i >= from; i--) {
      if (this.followedByNewline(i)) {
        last = i;
        break;
      }
    }
    to = last >= 0 ? (last + 1) | 0 : from;
    for (let i = from; i < to; i++) {
      const endsLine =
        !this.isMoved(i) &&
        (this.followedByNewline(i) || (i + 1 < to && this.source.allBytes(this.ce[i] | 0, this.cs[i + 1] | 0, BT_SPACE_TAB)));
      if (!endsLine) {
        this.to = from;
        this.from = from;
        return 0;
      }
    }
    this.from = from;
    this.to = to;
    return (to - from) | 0;
  }

  private endOfLineCommentsAfterBytes(pos0: number, table: Uint8Array): number {
    let pos = pos0;
    this.commentsAfter(pos);
    const from = this.from;
    const to = this.to;
    for (let i = from; i < to; i++) {
      if (!this.source.allBytes(pos, this.cs[i] | 0, table)) break;
      if (this.isLine(i) || this.followedByNewline(i)) {
        this.from = from;
        this.to = (i + 1) | 0;
        return (i + 1 - from) | 0;
      }
      pos = this.ce[i] | 0;
    }
    this.from = from;
    this.to = from;
    return 0;
  }

  /** The comments that end at or after `pos`. */
  commentsAfter(pos: number): number {
    this.unprinted();
    const from = this.from;
    const to = this.to;
    const c = countThatEndBefore(this.ce, from, to, pos);
    this.from = (from + c) | 0;
    return (to - this.from) | 0;
  }

  /** The comments in `(start, end)`. */
  commentsIn(start: number, end: number): number {
    this.commentsAfter(start);
    const from = this.from;
    const to = this.to;
    const bound = end === INF ? INF : (end + 1) | 0;
    const c = countThatEndBefore(this.ce, from, to, bound);
    this.to = (from + c) | 0;
    return c;
  }

  /** The comments after `start` that are before the first `character` outside of a comment. */
  commentsBeforeCharacter(start0: number, character: number): number {
    let start = start0;
    this.commentsAfter(start);
    const from = this.from;
    const to = this.to;
    // Nor in a comment that is printed.
    let first = this.printedCount;
    while (first > 0 && (this.spanStart[first - 1] | 0) >= start) first = (first - 1) | 0;
    // One that has been moved is printed ahead of its turn.
    for (let i = first; i < this.printedCount; i++) {
      if (this.isMoved(i)) continue;
      if (this.source.containsByte(start, this.spanStart[i] | 0, character)) {
        this.from = from;
        this.to = from;
        return 0;
      }
      start = this.spanEnd[i] | 0;
    }
    for (let i = from; i < to; i++) {
      if (this.source.containsByte(start, this.cs[i] | 0, character)) {
        this.from = from;
        this.to = i;
        return (i - from) | 0;
      }
      start = this.ce[i] | 0;
    }
    this.from = from;
    this.to = to;
    return (to - from) | 0;
  }

  hasCommentInRange(start: number, end: number): boolean {
    if (this.nextStart() >= end) return false;
    const lim = this.limit();
    for (let i = this.printedCount; i < lim && (this.ce[i] | 0) <= end; i++) {
      if ((this.ce[i] | 0) > start) return true;
    }
    return false;
  }

  hasCommentBefore(start: number): boolean {
    const p = this.printedCount;
    return p < this.limit() && (this.ce[p] | 0) <= start;
  }

  /** Whether a comment before `start` ends its line. */
  hasLeadingOwnLineComment(start: number): boolean {
    const lim = this.limit();
    for (let i = this.printedCount; i < lim && (this.ce[i] | 0) <= start; i++) {
      if (this.followedByNewline(i)) return true;
    }
    return false;
  }

  /**
   * The comments to print after the node that ends at `precedingEnd`. `enclosingEnd`: where its parent ends. `followingStart`: where
   * the next sibling starts, or 0. Sets `from`/`to`.
   */
  getTrailingComments(enclosingEnd: number, precedingEnd: number, followingStart: number): number {
    const lim = this.limit();
    const first = this.printedCount;
    this.from = first;
    this.to = first;
    if (first >= lim) return 0;
    const source = this.source;
    const flags = this.flags;
    const ce = this.ce;
    const cs = this.cs;

    if (followingStart === 0) {
      // What is left at the end of the parent.
      this.commentsBefore(enclosingEnd);
      const to = this.to;
      let start = precedingEnd;
      for (let i = first; i < to; i++) {
        // It is attached to a link of a member chain that is not the node.
        if (this.isOfOtherLink(i, precedingEnd)) {
          this.to = i;
          return (i - first) | 0;
        }
        // It is inside the node.
        if (start > (cs[i] | 0)) continue;
        if (!source.allBytes(start, cs[i] | 0, BT_WS_CLOSE_PAREN_COMMA_SEMI)) {
          this.to = i;
          return (i - first) | 0;
        }
        start = ce[i] | 0;
      }
      return (to - first) | 0;
    }

    let commentIndex = first;
    // So many trail the node whatever follows them: the last of them ends its line.
    let trailingEnd = first;
    let typeCastComment = -1;
    while (commentIndex < lim) {
      const ci = commentIndex;
      if ((ce[ci] | 0) > followingStart || (ce[ci] | 0) > enclosingEnd || this.isOfOtherLink(ci, precedingEnd)) break;
      if (this.isMoved(ci) && ((flags[ci] | 0) & (CF_TRAILS_LEFT_SIDE | CF_TRAILS_LINK)) !== 0) {
        // It has been moved to here because it does.
        trailingEnd = (ci + 1) | 0;
      } else if (followingStart > enclosingEnd && (ce[ci] | 0) <= enclosingEnd) {
        // The next sibling is outside of the parent and the comment is inside.
      } else if (((flags[ci] | 0) & CF_LOOKS_LIKE_TYPE_CAST) !== 0) {
        // Prettier's `handleClosureTypeCastComments`. `a || /** @type {T} *&#47; (b)`: it leads the next sibling.
        typeCastComment = ci;
        break;
      } else if (this.precededByNewline(ci) || this.isMoved(ci)) {
        // On a line of its own, or moved to where it is: it leads the next sibling.
        break;
      } else if (this.followedByNewline(ci)) {
        trailingEnd = (ci + 1) | 0;
      }
      commentIndex = (commentIndex + 1) | 0;
    }

    // From the end, those that have nothing but blanks and `(` between them and the next sibling lead it.
    let gapEnd = typeCastComment >= 0 ? cs[typeCastComment] | 0 : followingStart;
    for (let i = (commentIndex - 1) | 0; i >= trailingEnd; i--) {
      if (!source.allBytes(ce[i] | 0, gapEnd, BT_WS_OPEN_PAREN)) {
        this.to = (i + 1) | 0;
        return (i + 1 - first) | 0;
      }
      gapEnd = cs[i] | 0;
    }
    this.to = trailingEnd;
    return (trailingEnd - first) | 0;
  }

  private isOfOtherLink(i: number, precedingEnd: number): boolean {
    const f = this.flags[i] | 0;
    return (f & CF_LEADS_LINK) !== 0 || ((f & CF_TRAILS_LINK) !== 0 && (this.movedTo[i] | 0) !== precedingEnd);
  }

  /** Whether a `prettier-ignore` comment leads the node that starts at `start`. */
  isSuppressed(start: number): boolean {
    if (!this.hasSuppressionComments) return false;
    if (this.suppressedAfterOperator === start) return true;
    const lim = this.limit();
    for (let i = this.printedCount; i < lim && (this.ce[i] | 0) <= start; i++) {
      if (((this.flags[i] | 0) & CF_SUPPRESSION) !== 0) return true;
    }
    return false;
  }

  /** Whether the comment that was written last is a line comment that starts after `pos`. */
  hasPrintedLineCommentAfter(pos: number): boolean {
    const l = this.lastPrinted();
    return l >= 0 && this.isLine(l) && (this.spanStart[l] | 0) > pos;
  }

  /** Whether there is a comment in `(start, end)`, written or not. */
  hasAnyCommentIn(start: number, end: number): boolean {
    const first = this.partitionPointEndBefore(0, this.n, start);
    return first < this.n && (this.ce[first] | 0) <= end;
  }

  /** The position behind the first `character` after `start` that is not in a comment. `start` if there is none. */
  positionAfterCharacter(start: number, character: number): number {
    // partition_point(|c| c.end() <= start)
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + ((hi - lo) >> 1)) | 0;
      if ((this.ce[mid] | 0) <= start) lo = (mid + 1) | 0;
      else hi = mid;
    }
    let from = start;
    const len = this.source.text.length;
    for (let i = lo; i <= this.n; i++) {
      if (i < this.n && this.isMoved(i)) continue;
      const toStart = i < this.n ? this.spanStart[i] | 0 : INF;
      const toEnd = i < this.n ? this.spanEnd[i] | 0 : INF;
      const gapEnd = toStart < len ? toStart : len;
      if (from < gapEnd) {
        for (let j = from; j < gapEnd; j++) {
          if ((this.source.text[j] | 0) === character) return (j + 1) | 0;
        }
      }
      if (toEnd > from) from = toEnd;
    }
    return start;
  }

  /**
   * Whether a `prettier-ignore` comment trails the node that ends at `pos`: Prettier goes by any comment of a node.
   * `statement(); // prettier-ignore`, and on a line of its own if nothing follows in what the node is in.
   */
  hasTrailingSuppressionComment(pos: number): boolean {
    return this.hasSuppressionComments && this.findTrailingSuppressionComment(pos);
  }

  private findTrailingSuppressionComment(pos: number): boolean {
    this.endOfLineCommentsAfter(pos);
    for (let i = this.from; i < this.to; i++) {
      if (((this.flags[i] | 0) & CF_SUPPRESSION) !== 0) return true;
    }
    let reached = pos;
    let isSuppressed = false;
    this.commentsAfter(pos);
    const from = this.from;
    const to = this.to;
    for (let i = from; i < to; i++) {
      if (!this.source.allBytes(reached, this.cs[i] | 0, BT_WS_COMMA_SEMI)) break;
      if (((this.flags[i] | 0) & CF_SUPPRESSION) !== 0) isSuppressed = true;
      reached = this.ce[i] | 0;
    }
    if (!isSuppressed) return false;
    // matches!(text[reached..].trim_ascii_start().first(), None | Some(b'}' | b']' | b')'))
    const text = this.source.text;
    let at = reached < text.length ? reached : text.length;
    while (at < text.length) {
      const b = text[at] | 0;
      if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) at = at + 1;
      else break;
    }
    if (at >= text.length) return true;
    const b = text[at] | 0;
    return b === 125 || b === 93 || b === 41;
  }

  isSuppressionComment(i: number): boolean {
    return ((this.flags[i] | 0) & CF_SUPPRESSION) !== 0;
  }

  /** Prettier's `isTypeCastComment`: a JSDoc comment with `@type` or `@satisfies`, whatever follows it. */
  looksLikeTypeCastComment(i: number): boolean {
    return ((this.flags[i] | 0) & CF_LOOKS_LIKE_TYPE_CAST) !== 0;
  }

  /** A JSDoc comment with `@type` or `@satisfies`, in a file where the parentheses after it stay. */
  isTypeCastComment(i: number): boolean {
    return ((this.flags[i] | 0) & CF_TYPE_CAST) !== 0;
  }

  /** Among the comments before `spanStart`, the index (counted from the first unprinted one) of the first type cast comment that is followed by a `(`, or -1. */
  getTypeCastCommentIndex(spanStart: number): number {
    const lim = this.limit();
    for (let i = this.printedCount; i < lim && (this.ce[i] | 0) <= spanStart; i++) {
      if (this.isTypeCastComment(i) && this.source.nextNonWhitespaceByteIs(this.ce[i] | 0, 40)) return (i - this.printedCount) | 0;
    }
    return -1;
  }

  /**
   * Whether the `(` at `open` follows a type cast comment with nothing but white space in between. If it is around an expression,
   * Prettier keeps the `ParenthesizedExpression`.
   */
  isCastParenthesis(open: number): boolean {
    const before = this.partitionPointStartBefore(0, this.n, open);
    // The text of a moved comment is somewhere else.
    for (let i = before - 1; i >= 0; i--) {
      if (this.isMoved(i)) continue;
      return this.isTypeCastComment(i) && this.source.allBytes(this.spanEnd[i] | 0, open, BT_ASCII_WS);
    }
    return false;
  }

}

// ───────────────────────────── collecting the comments ─────────────────────────────

let startsLineScratch = new Uint8Array(64);

/** Finds nodes by position. */
class NodeFinder {
  flavor: number = 0;
  /** Babel has no `ChainExpression`: all of an optional chain is a member expression or a call like any other. */
  hasTreeOfBabel: boolean = false;
  isTypescript: boolean = false;
  /** The nodes that the last position was in, from the statement of the file inwards. */
  path: I32Vec = new I32Vec(32);
  /** Where the `(` are that follow a type cast comment (sorted). */
  castParentheses: I32Vec = new I32Vec(8);
  kids: I32Vec = new I32Vec(32);
  source: SourceText;
  cm: Comments;

  constructor(cm: Comments) {
    this.cm = cm;
    this.source = cm.source;
  }

  hasCastParen(pos: number): boolean {
    const v = this.castParentheses;
    let lo = 0;
    let hi = v.len;
    while (lo < hi) {
      const mid = (lo + ((hi - lo) >> 1)) | 0;
      const x = v.data[mid] | 0;
      if (x < pos) lo = (mid + 1) | 0;
      else if (x > pos) hi = mid;
      else return true;
    }
    return false;
  }

  /** The child of `node` that `offset` is in (the first one), or -1. */
  childAt(node: number, offset: number): number {
    const out = this.kids;
    const base = out.len;
    nodeChildren(node, offset, out);
    let found = -1;
    const SP$ = SP;
    for (let i = base; i < out.len; i++) {
      const child = out.data[i] | 0;
      nodeSpan(child);
      if (found < 0 && (SP$.s0 | 0) <= offset && offset < (SP$.s1 | 0)) found = child;
    }
    out.len = base;
    return found;
  }

  /** The innermost node that `offset` is in. */
  innermostNodeAt(offset: number): number {
    const path = this.path;
    const SP$ = SP;
    while (path.len > 0) {
      nodeSpan(path.last());
      if ((SP$.s0 | 0) <= offset && offset < (SP$.s1 | 0)) break;
      path.pop();
    }
    let node = path.len > 0 ? path.last() : NODE_FILE;
    while (true) {
      const child = this.childAt(node, offset);
      if (child < 0) break;
      path.push(child);
      node = child;
    }
    return node;
  }

  /** Whether `comment` is in parentheses around `e` that follow a type cast comment. For Prettier they are a node, which the comment is in. */
  isInCastParenthesesOf(e: number, commentEnd: number): boolean {
    if (this.castParentheses.len === 0 || !exprIsParenthesized(e)) return false;
    const first = exprParenFirst(e);
    const n = exprParenCount(e);
    const hir$ = hir;
    for (let i = 0; i < n; i++) {
      const row = (first + i) | 0;
      if ((hir$.parenEnd[row] | 0) >= commentEnd && this.hasCastParen(hir$.parenStart[row] | 0)) return true;
    }
    return false;
  }

  /** Whether `e` is in parentheses that follow a type cast comment. */
  isCastTarget(e: number): boolean {
    if (this.castParentheses.len === 0 || !exprIsParenthesized(e)) return false;
    const first = exprParenFirst(e);
    const n = exprParenCount(e);
    const hir$ = hir;
    for (let i = 0; i < n; i++) {
      if (this.hasCastParen(hir$.parenStart[(first + i) | 0] | 0)) return true;
    }
    return false;
  }

  /** Where `e` starts, with the parentheses around it that follow a type cast comment. */
  startWithCastParentheses(e: number): number {
    const hir$ = hir;
    if (this.castParentheses.len > 0 && exprIsParenthesized(e)) {
      // `e.parens().rev().find(..)`: the outermost first
      const first = exprParenFirst(e);
      const n = exprParenCount(e);
      for (let i = n - 1; i >= 0; i--) {
        const row = (first + i) | 0;
        if (this.hasCastParen(hir$.parenStart[row] | 0)) return hir$.parenStart[row] | 0;
      }
    }
    return exprStart(e);
  }

  /** Whether `e`, which is in a link, is written in parentheses: a chain starts with it. */
  staysInParentheses(e: number): boolean {
    if (this.isCastTarget(e)) return true;
    if (!exprIsChainRoot(e)) return false;
    const parent = exprParent(e);
    if (nodeKind(parent) !== N_EXPR) return false;
    const p = nodeId(parent);
    return exprTag(p) === EXPR_NON_NULL ? true : !exprIsOptional(p);
  }

  /** Whether the call `e` is written as a member chain, unless it is a link of one itself. */
  endsMemberChain(e: number): boolean {
    if (exprTag(e) !== EXPR_CALL) return false;
    const callee = exprCallee(e);
    const t = exprTag(callee);
    return (t === EXPR_DOT || t === EXPR_INDEX) && (!exprIsChainRoot(callee) || (this.hasTreeOfBabel && !this.staysInParentheses(callee)));
  }

  /** Whether `e` is a link of a member chain, and neither what the chain starts with nor the call that it ends with. */
  isLinkOfMemberChain(e: number): boolean {
    let link = e;
    while (true) {
      let canBeLink = false;
      switch (exprTag(link)) {
        case EXPR_DOT:
        case EXPR_INDEX:
        case EXPR_NON_NULL:
          canBeLink = true;
          break;
        case EXPR_CALL: {
          const callee = exprCallee(link);
          const t = exprTag(callee);
          canBeLink = (t === EXPR_DOT || t === EXPR_INDEX || t === EXPR_CALL) && (this.hasTreeOfBabel || !exprIsChainRoot(callee));
          break;
        }
        default:
          break;
      }
      if (!canBeLink || this.staysInParentheses(link)) return false;
      const parent = exprParent(link);
      if (nodeKind(parent) === N_EXPR && innerOfLink(nodeId(parent)) === link) {
        if (this.endsMemberChain(nodeId(parent))) return true;
        link = nodeId(parent);
      } else return false;
    }
  }
}

/** The object of a member access, what a call or a `new` calls, what a `!` follows. -1 if `link` is none of these. */
export function innerOfLink(link: number): number {
  switch (exprTag(link)) {
    case EXPR_DOT:
      return exprDotObj(link);
    case EXPR_INDEX:
      return exprIndexObj(link);
    case EXPR_CALL:
    case EXPR_NEW:
      return exprCallee(link);
    case EXPR_NON_NULL:
      return exprNonNullExpr(link);
    default:
      return -1;
  }
}

/** `<a.b />` */
function isNameOfJsxElement(member0: number): boolean {
  let member = member0;
  while (true) {
    const parent = exprParent(member);
    if (nodeKind(parent) !== N_EXPR) return false;
    const p = nodeId(parent);
    const t = exprTag(p);
    if (t === EXPR_DOT && exprDotObj(p) === member) member = p;
    else if (t === EXPR_JSX) return true;
    else return false;
  }
}

// What a comment in a link, and in nothing in it, is attached to.
const AT_PRECEDING: number = 0;
const AT_FOLLOWING: number = 1;
const AT_LINK: number = 2;

function ensureStartsLine(n: number): Uint8Array {
  if (startsLineScratch.length < n) startsLineScratch = new Uint8Array(n * 2);
  return startsLineScratch;
}

/**
 * Where the comments belong that are in a member access, a call, a `new` or an `a!`, before the property or the first argument, if
 * comment `index` is one of them. Returns the index of the first comment after them, or -1.
 *
 * Prettier's `attachComments`, for which parentheses are nothing: `(a /* here *&#47;).b` is in `a.b`, after `a`. A comment that starts its
 * line leads what follows it, one that ends its line trails what is before it, one with code on both sides leads what follows it if only
 * blanks and `(` are in between. With `handleMemberExpressionComments`: one that starts its line before a name, be it the object or the
 * property, leads the member access. And with `handleCallExpressionComments`: one that ends its line behind the `(` leads the first
 * argument.
 *
 * Prettier writes what leads a node before all of it. In a member chain all that is written for a link is the `.b`, so what leads `a.b`
 * is between the `a` and the `.b`, wherever it is in the source: `(/* here *&#47; a.b)()`.
 */
function attachInLink(nodes: NodeFinder, cm: Comments, index: number): number {
  if (commentsStayInMemberExpressions(nodes.flavor)) return -1;
  if (index >= cm.n) return -1;
  const firstStart = cm.spanStart[index] | 0;
  const firstEnd = cm.spanEnd[index] | 0;
  const node = nodes.innermostNodeAt(firstStart);
  if (nodeKind(node) !== N_EXPR) return -1;
  const link = nodeId(node);
  const inner = innerOfLink(link);
  if (inner < 0 || nodes.isCastTarget(inner)) return -1;
  if (isNameOfJsxElement(link)) return -1;
  const linkTag = exprTag(link);
  const isMember = linkTag === EXPR_DOT || linkTag === EXPR_INDEX;
  exprSpan(inner);
  const SP$ = SP;
  const innerStart = SP$.s0 | 0;
  const innerEnd = SP$.s1 | 0;
  exprSpan(link);
  const linkStart = SP$.s0 | 0;
  const linkEnd = SP$.s1 | 0;

  // What follows the comments, if anything does: where it starts, and whether it is a name. If nothing does, the token that they are before.
  const hasPreceding = innerEnd <= firstStart;
  let start = 0;
  let hasFollowing = false;
  let followingStart = 0;
  let followingIsName = false;
  let opener = -1;
  if (!hasPreceding) {
    start = linkStart;
    hasFollowing = true;
    followingStart = innerStart;
    followingIsName = exprTag(inner) === EXPR_IDENT && !nodes.isCastTarget(inner);
  } else if (linkTag === EXPR_DOT) {
    start = innerEnd;
    hasFollowing = true;
    followingStart = exprDotNamePos(link);
    followingIsName = !exprIsPrivateMember(link);
  } else if (linkTag === EXPR_INDEX) {
    start = innerEnd;
    hasFollowing = true;
    const index2 = exprIndexIndex(link);
    followingStart = nodes.startWithCastParentheses(index2);
    followingIsName = exprTag(index2) === EXPR_IDENT && !nodes.isCastTarget(index2);
    // a computed key is not a name here
  } else if (linkTag === EXPR_CALL || linkTag === EXPR_NEW) {
    start = innerEnd;
    const call = exprAsCallLike(link);
    opener = 40;
    if (typeListAngleBrackets(callTypeArgsStart(call), callTypeArgsLen(call))) {
      hasFollowing = true;
      followingStart = SP$.s0 | 0;
    } else if (callArgsLen(call) > 0) {
      hasFollowing = true;
      followingStart = nodes.startWithCastParentheses(listAt(callArgsStart(call), 0));
    }
    followingIsName = false;
  } else {
    start = innerEnd;
    opener = 33;
  }
  const end = hasFollowing ? followingStart : linkEnd;
  if (firstStart < start || end < firstEnd) return -1;
  let from = index;
  while (from > 0 && (cm.spanStart[from - 1] | 0) >= start) from = (from - 1) | 0;
  let count = 0;
  while (from + count < cm.n && (cm.spanEnd[from + count] | 0) <= end) count = (count + 1) | 0;
  const source = cm.source;

  // How many are before the `(` or the `!`.
  let beforeOpener = count;
  if (opener >= 0) {
    let position = start;
    beforeOpener = 0;
    while (beforeOpener < count) {
      const i = (from + beforeOpener) | 0;
      const isBefore = !source.containsByte(position, cm.spanStart[i] | 0, opener);
      position = cm.spanEnd[i] | 0;
      if (!isBefore) break;
      beforeOpener = (beforeOpener + 1) | 0;
    }
  }
  // In `()` and behind the `!` they are not between two things.
  if (!hasFollowing) count = beforeOpener;
  if (from + count > cm.n) return -1;
  if (index >= from + count) return -1;
  for (let i = from; i < from + count; i++) if (cm.isMoved(i)) return -1;

  // Whether it starts its line, or follows one that does on the same line.
  const startsLine = ensureStartsLine(count);
  for (let at = 0; at < count; at++) {
    const i = (from + at) | 0;
    const followsOneThatDoes =
      hasPreceding && at > 0 && (startsLine[at - 1] | 0) === 1 && source.allBytes(cm.spanEnd[i - 1] | 0, cm.spanStart[i] | 0, BT_BLANK_VT_FF);
    startsLine[at] = cm.precededByNewline(i) || followsOneThatDoes ? 1 : 0;
  }

  const isLinkOfChain = nodes.isLinkOfMemberChain(link);
  const isInChain = isLinkOfChain || nodes.endsMemberChain(link);
  // Where what is written for `inner` starts in a chain, if that is not all of it.
  let innerLinkStart = -1;
  if (!hasPreceding && isInChain && nodes.isLinkOfMemberChain(inner)) {
    const innerInner = innerOfLink(inner);
    if (innerInner >= 0) {
      innerLinkStart = exprEnd(innerInner);
    }
  }

  // From the end: whether it ends its line, and how far what leads the next thing reaches back.
  let endsLine = false;
  let leadingStart = end;
  for (let at = count - 1; at >= 0; at--) {
    const i = (from + at) | 0;
    endsLine =
      cm.followedByNewline(i) ||
      (endsLine && hasFollowing && at + 1 < count && source.allBytes(cm.spanEnd[i] | 0, cm.spanStart[i + 1] | 0, BT_BLANK_VT_FF));
    let attachedTo = AT_PRECEDING;
    if (!hasFollowing) attachedTo = AT_PRECEDING;
    else if (followingIsName && isMember && (startsLine[at] | 0) === 1) attachedTo = AT_LINK;
    else if (!hasPreceding || (startsLine[at] | 0) === 1) attachedTo = AT_FOLLOWING;
    else if (endsLine) {
      attachedTo = ((cm.flags[i] | 0) & CF_LOOKS_LIKE_TYPE_CAST) !== 0 || at >= beforeOpener ? AT_FOLLOWING : AT_PRECEDING;
    } else {
      const isAdjacent = source.allBytes(cm.spanEnd[i] | 0, leadingStart, BT_WS_OPEN_PAREN);
      if (isAdjacent) {
        leadingStart = cm.spanStart[i] | 0;
        attachedTo = AT_FOLLOWING;
      } else attachedTo = AT_PRECEDING;
    }
    let movedTo = 0;
    let flag = 0;
    if (attachedTo === AT_PRECEDING) {
      movedTo = innerEnd;
      flag = CF_TRAILS_LINK;
    } else if (attachedTo === AT_LINK) {
      if (isLinkOfChain) {
        movedTo = innerEnd;
        flag = CF_LEADS_LINK;
      } else {
        cm.leadsUntil[i] = linkEnd;
        movedTo = linkStart;
        flag = 0;
      }
    } else {
      if (innerLinkStart < 0) continue;
      movedTo = innerLinkStart;
      flag = CF_LEADS_LINK;
    }
    cm.movedTo[i] = movedTo;
    cm.cs[i] = movedTo;
    cm.ce[i] = movedTo;
    cm.flags[i] = (cm.flags[i] | 0) | flag;
  }
  return (from + count) | 0;
}

/**
 * Where the comments between the two sides of a declarator, an assignment or a binary expression belong, if comment `index0` is one of
 * them. Returns the index of the first comment after them, or -1.
 *
 * Prettier's `attachComments` with `handleAssignmentLikeComments`: a comment that starts its line leads the right side. So does one that
 * ends its line, if it is a block or the right side is an object, an array or a template. Otherwise it trails the left side. One with code
 * on both sides leads the right side if only blanks and `(` are in between. Those that trail the left side are written first:
 * `a = /* b *&#47; // c ⏎ d` is `a = // c ⏎ /* b *&#47; d`.
 *
 * In a binary expression any comment that ends its line trails the left side, and only those that are written before a comment that they
 * follow are dealt with here.
 */
function attachBetweenSidesOfAssignment(nodes: NodeFinder, cm: Comments, index0: number): number {
  if (commentsKeepTheirOrder(nodes.flavor)) return -1;
  let index = index0;
  if (index >= cm.n) return -1;
  const firstStart = cm.spanStart[index] | 0;
  const firstEnd = cm.spanEnd[index] | 0;
  const node = nodes.innermostNodeAt(firstStart);
  let leftEnd = 0;
  let right = -1;
  let isAssignment = false;
  const id = nodeId(node);
  switch (nodeKind(node)) {
    case N_VAR_DECL: {
      const init = varDeclInit(id);
      if (init < 0) return -1;
      const ty = varDeclTy(id);
      if (ty >= 0) {
        typeSpan(ty);
        leftEnd = SP.s1 | 0;
      } else {
        patSpan(varDeclPat(id));
        leftEnd = SP.s1 | 0;
      }
      right = init;
      isAssignment = true;
      break;
    }
    case N_EXPR: {
      const t = exprTag(id);
      if (t === EXPR_ASSIGN && !exprIsAssignmentTarget(id)) {
        leftEnd = exprEnd(exprAssignTarget(id));
        right = exprAssignValue(id);
        isAssignment = true;
      } else if (t === EXPR_BINARY && exprBinaryOp(id) !== BIN_COMMA) {
        leftEnd = exprEnd(exprBinaryLeft(id));
        right = exprBinaryRight(id);
        isAssignment = false;
      } else return -1;
      break;
    }
    default:
      return -1;
  }
  while (index > 0 && (cm.spanStart[index - 1] | 0) >= leftEnd) index = (index - 1) | 0;
  const rightStart = nodes.startWithCastParentheses(right);
  if (firstStart < leftEnd || rightStart < firstEnd) return -1;
  const source = cm.source;
  let count = 0;
  while (index + count < cm.n && (cm.spanEnd[index + count] | 0) <= rightStart) count = (count + 1) | 0;
  if (index + count > cm.n) return -1;
  for (let i = index; i < index + count; i++) if (cm.isMoved(i)) return -1;
  const rightSpanStart = exprStart(right);
  const rt = exprTag(right);
  const isRightComplex =
    isAssignment && (rt === EXPR_OBJECT || rt === EXPR_ARRAY || rt === EXPR_TEMPLATE || rt === EXPR_TAGGED_TEMPLATE) && rightStart === rightSpanStart;

  // Whether it starts its line, or follows one that does on the same line.
  const startsLine = ensureStartsLine(count);
  for (let at = 0; at < count; at++) {
    const i = (index + at) | 0;
    const followsOneThatDoes =
      at > 0 && (startsLine[at - 1] | 0) === 1 && source.allBytes(cm.spanEnd[i - 1] | 0, cm.spanStart[i] | 0, BT_BLANK_VT_FF);
    startsLine[at] = cm.precededByNewline(i) || followsOneThatDoes ? 1 : 0;
  }

  // From the end: whether it ends its line, and how far what leads the right side reaches back.
  let endsLine = false;
  let leadingStart = rightStart;
  let isTieBroken = false;
  for (let at = count - 1; at >= 0; at--) {
    const i = (index + at) | 0;
    endsLine =
      cm.followedByNewline(i) ||
      (endsLine && at + 1 < count && source.allBytes(cm.spanEnd[i] | 0, cm.spanStart[i + 1] | 0, BT_BLANK_VT_FF));
    let trailsLeftSide = false;
    if ((startsLine[at] | 0) === 1) trailsLeftSide = false;
    else if (endsLine) {
      trailsLeftSide = isAssignment ? cm.isLine(i) && !isRightComplex : ((cm.flags[i] | 0) & CF_LOOKS_LIKE_TYPE_CAST) === 0;
    } else {
      isTieBroken = isTieBroken || !source.allBytes(cm.spanEnd[i] | 0, leadingStart, BT_WS_OPEN_PAREN);
      if (!isTieBroken) leadingStart = cm.spanStart[i] | 0;
      trailsLeftSide = isTieBroken;
    }
    if (trailsLeftSide) cm.flags[i] = (cm.flags[i] | 0) | CF_TRAILS_LEFT_SIDE;
  }
  let firstLeading = -1;
  for (let i = index; i < index + count; i++) {
    if (((cm.flags[i] | 0) & CF_TRAILS_LEFT_SIDE) === 0) {
      firstLeading = cm.spanStart[i] | 0;
      break;
    }
  }
  if (firstLeading >= 0) {
    for (let i = index; i < index + count; i++) {
      if (((cm.flags[i] | 0) & CF_TRAILS_LEFT_SIDE) !== 0 && (cm.spanStart[i] | 0) > firstLeading) {
        cm.movedTo[i] = firstLeading;
        cm.cs[i] = firstLeading;
        cm.ce[i] = firstLeading;
      }
    }
  }
  if (isAssignment) return (index + count) | 0;
  let anyMoved = false;
  for (let i = index; i < index + count; i++) {
    if (!cm.isMoved(i)) cm.flags[i] = (cm.flags[i] | 0) & ~CF_TRAILS_LEFT_SIDE;
    else anyMoved = true;
  }
  return anyMoved ? (index + count) | 0 : -1;
}

/**
 * Prettier's `handleAssignmentPatternComments`: a comment on a line of its own between the two sides of the `a = 1` of a pattern leads
 * it. Returns where it is moved to, or -1.
 */
function movedOutOfAssignmentPattern(nodes: NodeFinder, commentStart: number, commentEnd: number): number {
  const node = nodes.innermostNodeAt(commentStart);
  const id = nodeId(node);
  let leftStart = 0;
  let leftEnd = 0;
  let defaultE = -1;
  const SP$ = SP;
  switch (nodeKind(node)) {
    case N_PAT_PROP: {
      defaultE = patPropDefault(id);
      if (defaultE < 0) return -1;
      patSpan(patPropValue(id));
      leftStart = SP$.s0 | 0;
      leftEnd = SP$.s1 | 0;
      break;
    }
    case N_PAT_ELEM: {
      defaultE = patElemDefault(id);
      const pat = patElemPat(id);
      if (defaultE < 0 || pat < 0) return -1;
      patSpan(pat);
      leftStart = SP$.s0 | 0;
      leftEnd = SP$.s1 | 0;
      break;
    }
    case N_PARAM: {
      defaultE = paramDefault(id);
      if (defaultE < 0) return -1;
      patSpan(paramPat(id));
      leftStart = SP$.s0 | 0;
      leftEnd = SP$.s1 | 0;
      break;
    }
    case N_EXPR: {
      if (exprTag(id) !== EXPR_ASSIGN || !exprIsAssignmentTarget(id)) return -1;
      exprSpan(exprAssignTarget(id));
      leftStart = SP$.s0 | 0;
      leftEnd = SP$.s1 | 0;
      defaultE = exprAssignValue(id);
      break;
    }
    default:
      return -1;
  }
  const defaultStart = exprStart(defaultE);
  return leftEnd <= commentStart && commentEnd <= defaultStart ? leftStart : -1;
}

/**
 * Prettier's `handlePropertyComments`: a comment at the end of a line that is in a property of an object and in nothing in it leads the
 * property. This is for one after the value, which is in parentheses then. Returns where it is moved to, or -1.
 */
function movedOutOfProperty(nodes: NodeFinder, commentStart: number, commentEnd: number): number {
  const node = nodes.innermostNodeAt(commentStart);
  if (nodeKind(node) !== N_PROP) return -1;
  const property = nodeId(node);
  const owner = propParent(property);
  const isInObject = nodeKind(owner) === N_EXPR && exprTag(nodeId(owner)) === EXPR_OBJECT;
  const value = propValue(property);
  if (value < 0) return -1;
  const valueEnd = exprEnd(value);
  if (isInObject && propKind(property) === PROP_INIT && valueEnd <= commentStart && !nodes.isInCastParenthesesOf(value, commentEnd)) {
    propSpan(property);
    return SP.s0 | 0;
  }
  return -1;
}

/**
 * A comment before the `(` of the parameters at `openParen`. Returns where it is moved to, or -1.
 *
 * For a function with a body Prettier has `handleFunctionNameComments`: it trails the name. For anything else there is no rule, and no
 * node for the parentheses. So the comment is between what is before the parameters and the first parameter, which it leads, the `(`
 * counting for nothing. Without parameters it leads the return type, if nothing is before it that it can trail.
 */
function movedOverParenthesis(nodes: NodeFinder, commentStart: number, commentFollowedByNewline: boolean, openParen: number): number {
  const node = nodes.innermostNodeAt(commentStart);
  const id = nodeId(node);
  let func = -1;
  let hasName = false;
  switch (nodeKind(node)) {
    case N_MEMBER: {
      if (!memberIsSignature(id)) return -1;
      func = memberFunc(id);
      if (func < 0) return -1;
      hasName = keyKind(node) !== KEY_NONE;
      break;
    }
    case N_TYPE: {
      if (typeTag(id) !== TYPE_FN) return -1;
      func = typeFnFn(id);
      hasName = false;
      break;
    }
    case N_FUNC: {
      if (funcBodyKind(id) !== BODY_NONE) return -1;
      const owner = funcOwner(id);
      const ok = nodeKind(owner);
      if (ok === N_MEMBER && memberIsSignature(nodeId(owner))) {
        func = id;
        hasName = keyKind(owner) !== KEY_NONE;
      } else if (ok === N_TYPE) {
        func = id;
        hasName = false;
      } else if (ok === N_STMT && stmtTag(nodeId(owner)) === STMT_FN) {
        func = id;
        hasName = true;
      } else return -1;
      break;
    }
    default:
      return -1;
  }
  if (funcOpenParen(func) !== openParen) return -1;
  const followsSomething = hasName || funcTypeParamsLen(func) > 0;
  if (funcParamsLen(func) > 0 || funcThisParam(func) >= 0) {
    // At the end of a line it trails what is before it.
    return !followsSomething || !commentFollowedByNewline ? (openParen + 1) | 0 : -1;
  }
  if (followsSomething || funcReturnType(func) < 0) return -1;
  const close = funcCloseParen(func);
  return close >= 0 ? (close + 1) | 0 : -1;
}

/**
 * Sets `cs`/`ce` (`Comment::start`) for the comments that Prettier prints somewhere else than where they are.
 *
 * What is around a comment tells that this is not one, for nearly all of them. The tree is only looked at for the rest. Apart from that it
 * is linear in the number of comments.
 */
function moveComments(cm: Comments, flavor: number, hasTreeOfBabel: boolean): void {
  const text = cm.source.text;
  const len = text.length;
  const isTypescript = !fileIsJavascript();
  const nodes = new NodeFinder(cm);
  nodes.flavor = flavor;
  nodes.hasTreeOfBabel = hasTreeOfBabel;
  nodes.isTypescript = isTypescript;
  const n = cm.n;
  for (let i = 0; i < n; i++) {
    if (((cm.flags[i] | 0) & CF_TYPE_CAST) === 0) continue;
    // `text[comment.end..].trim_ascii_start()`
    let at = cm.spanEnd[i] | 0;
    while (at < len) {
      const b = text[at] | 0;
      if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) at = at + 1;
      else break;
    }
    if (at < len && (text[at] | 0) === 40) nodes.castParentheses.push(at);
  }
  // `is_blank(start, end)`
  let hasMoved = false;
  // The comment before is on a line of its own, or follows one that is on the same line.
  let isAfterOwnLineComment = false;
  // Where the comments start that lead up to this one with nothing in between.
  let runStart = 0;
  // The index of the last comment that follows this one with nothing in between.
  let runLast = 0;
  // The comments before this index are dealt with.
  let attachedUntil = 0;

  for (let index = 0; index < n; index++) {
    const commentStart = cm.spanStart[index] | 0;
    const commentEnd = cm.spanEnd[index] | 0;
    const commentFlags = cm.flags[index] | 0;
    const hasPrevious = index > 0;
    const prevEnd = hasPrevious ? cm.spanEnd[index - 1] | 0 : 0;
    if (!(hasPrevious && trimJsWhitespaceStart(text, prevEnd, commentStart) >= commentStart)) runStart = commentStart;
    let isOwnLine = (commentFlags & CF_PRECEDED_BY_NEWLINE) !== 0;
    if (!isOwnLine && isAfterOwnLineComment && hasPrevious) {
      isOwnLine = true;
      for (let j = prevEnd; j < commentStart; j++) {
        const b = text[j] | 0;
        if (b !== 32 && b !== 9) {
          isOwnLine = false;
          break;
        }
      }
    }
    isAfterOwnLineComment = isOwnLine;
    if (index < attachedUntil) continue;

    if (runLast < index) runLast = index;
    while (runLast + 1 < n && trimJsWhitespaceStart(text, cm.spanEnd[runLast] | 0, cm.spanStart[runLast + 1] | 0) >= (cm.spanStart[runLast + 1] | 0)) {
      runLast = (runLast + 1) | 0;
    }
    const lastEnd = runLast < n ? cm.spanEnd[runLast] | 0 : 0;
    const afterAt = trimJsWhitespaceStart(text, lastEnd, len);

    // The first of its run, after `=`, `= (` or before an assignment operator, or with nothing but an operator between it and the comment before.
    const beforeRunEnd = trimJsWhitespaceEnd(text, 0, runStart);
    let beforeEnd = beforeRunEnd;
    while (beforeEnd > 0 && (text[beforeEnd - 1] | 0) === 40) beforeEnd = trimJsWhitespaceEnd(text, 0, beforeEnd - 1);
    const isAtAssignmentOperator = startsWithAssignmentOperator(text, afterAt) || (beforeEnd > 0 && (text[beforeEnd - 1] | 0) === 61);
    let onlyOperatorBetween = false;
    if (hasPrevious) {
      // before.get(previous.span.end..) is empty if the end is past the end of `before`
      if (prevEnd > beforeEnd) onlyOperatorBetween = true;
      else {
        onlyOperatorBetween = true;
        for (let j = trimJsWhitespaceStart(text, prevEnd, beforeEnd); j < beforeEnd; j++) {
          if (!isOperatorByte(text[j] | 0)) {
            onlyOperatorBetween = false;
            break;
          }
        }
      }
    }
    if (runStart === commentStart && (isAtAssignmentOperator || (!isOwnLine && hasPrevious && onlyOperatorBetween))) {
      const end = attachBetweenSidesOfAssignment(nodes, cm, index);
      if (end >= 0) {
        if (!hasMoved) {
          for (let j = end - 1; j >= 0 && (cm.spanStart[j] | 0) >= runStart; j--) {
            if (cm.isMoved(j)) {
              hasMoved = true;
              break;
            }
          }
        }
        attachedUntil = end;
        continue;
      }
    }
    const a0 = afterAt < len ? text[afterAt] | 0 : -1;
    const a1 = afterAt + 1 < len ? text[afterAt + 1] | 0 : -1;
    let isNextToLink = false;
    if (a0 === 46 && a1 === 46) isNextToLink = false;
    else if (a0 === 46 || a0 === 91 || a0 === 40 || a0 === 41 || (a0 === 63 && a1 === 46)) isNextToLink = true;
    else if (a0 === 33 || a0 === 60) isNextToLink = isTypescript;
    if (!isNextToLink) {
      const b0 = beforeRunEnd > 0 ? text[beforeRunEnd - 1] | 0 : -1;
      const b1 = beforeRunEnd > 1 ? text[beforeRunEnd - 2] | 0 : -1;
      if (b0 === 46 && b1 === 46) isNextToLink = false;
      else if (b0 === 46 || b0 === 91 || b0 === 40) isNextToLink = true;
    }
    if (isNextToLink) {
      const end = attachInLink(nodes, cm, index);
      if (end >= 0) {
        if (!hasMoved) {
          for (let j = end - 1; j >= 0 && (cm.spanStart[j] | 0) >= runStart; j--) {
            if (cm.isMoved(j)) {
              hasMoved = true;
              break;
            }
          }
        }
        attachedUntil = end;
        continue;
      }
    }
    // A comment before the parentheses of a type cast stays there.
    let isTypeCast = false;
    if ((commentFlags & CF_TYPE_CAST) !== 0) {
      const at = trimJsWhitespaceStart(text, commentEnd, len);
      isTypeCast = at < len && (text[at] | 0) === 40;
    }
    const followedByNewline = (commentFlags & CF_FOLLOWED_BY_NEWLINE) !== 0;
    if ((!isOwnLine && !isTypescript && !followedByNewline) || isTypeCast) continue;
    if (isOwnLine && isAtAssignmentOperator) {
      const movedTo = movedOutOfAssignmentPattern(nodes, commentStart, commentEnd);
      if (movedTo >= 0) {
        cm.movedTo[index] = movedTo;
        cm.cs[index] = movedTo;
        cm.ce[index] = movedTo;
        hasMoved = true;
        continue;
      }
    }

    let movedTo = -1;
    if (a0 === 40 && isTypescript) {
      movedTo = movedOverParenthesis(nodes, commentStart, followedByNewline, afterAt);
    } else if (a0 === 41 && !isOwnLine) {
      // `a: (b // comment ⏎ ),`
      let j = afterAt;
      while (j < len) {
        const b = text[j] | 0;
        if (b !== 41 && b !== 32 && b !== 9 && b !== 10 && b !== 12 && b !== 13) break;
        j = j + 1;
      }
      const afterParentheses = j < len ? text[j] | 0 : -1;
      if (followedByNewline && (afterParentheses === 44 || afterParentheses === 125)) movedTo = movedOutOfProperty(nodes, commentStart, commentEnd);
    }
    if (movedTo >= 0) {
      cm.movedTo[index] = movedTo;
      cm.cs[index] = movedTo;
      cm.ce[index] = movedTo;
      hasMoved = true;
    }
  }
  if (hasMoved) sortMoved(cm);
}

let sortKeyStart: Int32Array = new Int32Array(64);
let sortKeyRank: Int32Array = new Int32Array(64);
let sortKeyLead: Int32Array = new Int32Array(64);
let sortOrder: Int32Array = new Int32Array(64);

function compareMoved(a: number, b: number): number {
  const sa = sortKeyStart[a] | 0;
  const sb = sortKeyStart[b] | 0;
  if (sa !== sb) return sa < sb ? -1 : 1;
  const ra = sortKeyRank[a] | 0;
  const rb = sortKeyRank[b] | 0;
  if (ra !== rb) return ra < rb ? -1 : 1;
  // std::cmp::Reverse(leads_until)
  const la = sortKeyLead[a] | 0;
  const lb = sortKeyLead[b] | 0;
  if (la !== lb) return la > lb ? -1 : 1;
  return 0;
}

/**
 * A moved comment comes before one that starts where it is, what trails a link before what leads the next, and what leads `a.b.c`
 * before what leads the `a.b` in it.
 */
function sortMoved(cm: Comments): void {
  const n = cm.n;
  if (sortOrder.length < n) {
    const c = n * 2;
    sortKeyStart = new Int32Array(c);
    sortKeyRank = new Int32Array(c);
    sortKeyLead = new Int32Array(c);
    sortOrder = new Int32Array(c);
  }
  for (let i = 0; i < n; i++) {
    sortOrder[i] = i;
    sortKeyStart[i] = cm.cs[i] | 0;
    const moved = cm.isMoved(i);
    const trails = ((cm.flags[i] | 0) & CF_TRAILS_LINK) !== 0;
    sortKeyRank[i] = moved ? (trails ? 0 : 1) : 2;
    sortKeyLead[i] = cm.leadsUntil[i] | 0;
  }
  sortInt32By(sortOrder, 0, n, compareMoved);
  permute(cm.spanStart, sortOrder, n);
  permute(cm.spanEnd, sortOrder, n);
  permute(cm.cs, sortOrder, n);
  permute(cm.ce, sortOrder, n);
  permute(cm.movedTo, sortOrder, n);
  permute(cm.leadsUntil, sortOrder, n);
  permute(cm.flags, sortOrder, n);
  permuteBytes(cm.kind, sortOrder, n);
}

let permTmp: Int32Array = new Int32Array(64);
let permTmpBytes: Uint8Array = new Uint8Array(64);
function permute(a: Int32Array, order: Int32Array, n: number): void {
  if (permTmp.length < n) permTmp = new Int32Array(n * 2);
  const t = permTmp;
  for (let i = 0; i < n; i++) t[i] = a[order[i] | 0] | 0;
  for (let i = 0; i < n; i++) a[i] = t[i] | 0;
}
function permuteBytes(a: Uint8Array, order: Int32Array, n: number): void {
  if (permTmpBytes.length < n) permTmpBytes = new Uint8Array(n * 2);
  const t = permTmpBytes;
  for (let i = 0; i < n; i++) t[i] = a[order[i] | 0] | 0;
  for (let i = 0; i < n; i++) a[i] = t[i] | 0;
}

/** Whether the content text[start, end) is `prettier-ignore` (or `oxfmt-ignore` for oxfmt), once trimmed of ASCII white space. */
function isIgnoreComment(text: Uint8Array, start0: number, end0: number, flavor: number): boolean {
  let start = start0;
  let end = end0;
  while (start < end) {
    const b = text[start] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) start = start + 1;
    else break;
  }
  while (end > start) {
    const b = text[end - 1] | 0;
    if (b === 32 || b === 9 || b === 10 || b === 12 || b === 13) end = end - 1;
    else break;
  }
  if (matchesWord(text, start, end, "prettier-ignore")) return true;
  return flavor === FLAVOR_OXFMT && matchesWord(text, start, end, "oxfmt-ignore");
}

function matchesWord(text: Uint8Array, start: number, end: number, word: string): boolean {
  if (end - start !== word.length) return false;
  for (let i = 0; i < word.length; i++) if ((text[start + i] | 0) !== word.charCodeAt(i)) return false;
  return true;
}

/**
 * Fills `cm` with the comments of the file (the handles of `lint/ast`, after `fileBegin`). `text`: the source (exactly). `flavor`:
 * `options.flavor`. `hasTreeOfBabel`: see `JsFormatContext.hasTreeOfBabel`. Rust `comments::collect` + `Comments::new`.
 */
export function collectComments(cm: Comments, text: Uint8Array, flavor: number, hasTreeOfBabel: boolean): void {
  const source = new SourceText(text);
  const total = commentsLen();
  cm.reserve(total + 1);
  cm.begin(source);
  const hasTypeCasts = fileIsJavascript() || typeCastsAreKeptInTypescript(flavor);
  let n = 0;
  // A BOM is not part of the first line.
  const bomLen = text.length >= 3 && (text[0] | 0) === 0xef && (text[1] | 0) === 0xbb && (text[2] | 0) === 0xbf ? 3 : 0;
  const SP$ = SP;
  for (let c = 0; c < total; c++) {
    const tk = commentKindAt(c);
    if (tk !== TK_LINE && tk !== TK_BLOCK) continue;
    const start = commentStartAt(c);
    const end = commentEndAt(c);
    commentValueSpan(c);
    const contentStart = SP$.s0 | 0;
    const contentEnd = SP$.s1 | 0;
    let kind = CK_LINE;
    if (tk === TK_BLOCK) kind = source.containsNewline(start, end) ? CK_MULTI_LINE_BLOCK : CK_SINGLE_LINE_BLOCK;
    let flags = 0;
    // before = text[..start] without the BOM: only ASCII white space is in it
    let isFirst = true;
    for (let j = bomLen; j < start; j++) {
      const b = text[j] | 0;
      if (b !== 32 && b !== 9 && b !== 10 && b !== 12 && b !== 13) {
        isFirst = false;
        break;
      }
    }
    if (isFirst || source.hasLineTerminatorBefore(start)) flags = flags | CF_PRECEDED_BY_NEWLINE;
    if (kind === CK_LINE || source.hasLineTerminatorAfter(end)) flags = flags | CF_FOLLOWED_BY_NEWLINE;
    if (kind === CK_MULTI_LINE_BLOCK && isIndentableText(text, contentStart, contentEnd)) flags = flags | CF_INDENTABLE;
    if (kind !== CK_LINE && contentEnd > contentStart && (text[contentStart] | 0) === 42 && isTypeCastText(text, contentStart, contentEnd)) {
      flags = flags | (hasTypeCasts ? CF_LOOKS_LIKE_TYPE_CAST | CF_TYPE_CAST : CF_LOOKS_LIKE_TYPE_CAST);
    }
    if (isIgnoreComment(text, contentStart, contentEnd, flavor)) flags = flags | CF_SUPPRESSION;
    // Prettier's `mergeNestledJsdocComments`. JSDoc has a form in which several `/** .. */` directly follow each other, for the
    // overloads of a function. They are one comment.
    if ((flags & CF_INDENTABLE) !== 0 && n > 0 && (cm.spanEnd[n - 1] | 0) === start && ((cm.flags[n - 1] | 0) & CF_INDENTABLE) !== 0) {
      cm.spanEnd[n - 1] = end;
      cm.ce[n - 1] = end;
      cm.flags[n - 1] = ((cm.flags[n - 1] | 0) & ~CF_FOLLOWED_BY_NEWLINE) | (flags & ~CF_PRECEDED_BY_NEWLINE);
      continue;
    }
    cm.spanStart[n] = start;
    cm.spanEnd[n] = end;
    cm.cs[n] = start;
    cm.ce[n] = end;
    cm.movedTo[n] = NOT_MOVED;
    cm.leadsUntil[n] = 0;
    cm.kind[n] = kind;
    cm.flags[n] = flags;
    n = (n + 1) | 0;
  }
  cm.n = n;
  moveComments(cm, flavor, hasTreeOfBabel);
  cm.summarize();
}

