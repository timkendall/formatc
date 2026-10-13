// Port of vendor/bun/src/format/ir/element.rs: the intermediate representation: what the syntax is turned into, and
// what the printer turns into text.
//
// A document is a flat sequence of elements. Nesting is expressed by pairs of start and end tags. Rust's
// `FormatElement` is a 16-byte `Copy` enum; here the pool is a struct of arrays (`storage.ts`): `tag: Uint8Array`
// plus three `Int32Array` payload columns `a`, `b`, `c` (13 bytes per element). Nothing ever owns anything: text
// is a range of the source or of the formatter's own text buffer, tokens are small ints, and a sub-document that is
// written in more than one place is a handle (the index of its `E_SKIP`).
//
// Payload per kind (columns a / b / c; unused columns are 0):
//
//   E_NOP                    -            -                        -
//   E_SKIP                   len          flat(width|flags<<16)    willBreak(0/1)
//   E_SPACE                  -            -                        -
//   E_LINE                   LM_*         -                        -
//   E_INDENTED_LINE_GROUP    group id     -                        -
//   E_EXPAND_PARENT          -            -                        -
//   E_TOKEN (long token)     offset       length                   -      (a token of <= 12 bytes: kind TOK_BASE + len, a/b/c = bytes)
//   E_TOKEN_IF_BREAKS (long) offset       length                   -      (<= 12 bytes: kind TIB_BASE + len)
//   E_SOURCE_TEXT            start        len                      text width (see TW_*)
//   E_OWNED_TEXT             start        len                      text width
//   E_LINE_SUFFIX_BOUNDARY   -            -                        -
//   E_INTERNED               handle       -                        -
//   E_BEST_FITTING           first        count                    -      (a range of Storage.variants)
//   E_CURSOR                 CURSOR_*     -                        -
//   T_START_INDENT_WITH_LINE LM_*
//   T_END_INDENT_WITH_LINE   LM_*
//   T_START_ALIGN            count
//   T_START_GROUP            id (0=none)  width|flags<<16|mode<<24 end index of the group (once measured)
//   T_START_COND             group id     PRINT_FLAT/PRINT_EXPANDED
//   T_START_INDENT_IF_GROUP_BREAKS / T_END_..: group id
//   T_START_LABELLED         label
//
// Everything is int32; every read of a column that is stored or passed is `| 0`-ed by the code that reads it.

// ---------------------------------------------------------------------------------------------- element kinds

/** Nothing: the place of a start tag that turned out not to be needed. See `Formatter.reserveTag`. */
export const E_NOP = 0;
/** The next `a` elements are not part of what this is in. They are what a handle is a range of, left where they were written. */
export const E_SKIP = 1;
/** A space, unless it would end up at the start or at the end of a line. */
export const E_SPACE = 2;
export const E_LINE = 3;
/** The same as a group with this id, and in it an indent, and in that a `LM_SOFT_OR_SPACE`. */
export const E_INDENTED_LINE_GROUP = 4;
/** Forces the enclosing groups to break. */
export const E_EXPAND_PARENT = 5;
/** A keyword or a punctuator: ASCII, without line breaks or tabs. */
export const E_TOKEN = 6;
/** One that is only written if the enclosing group breaks. */
export const E_TOKEN_IF_BREAKS = 7;
/** A range of the source text. */
export const E_SOURCE_TEXT = 8;
/** A range of the formatter's text buffer. */
export const E_OWNED_TEXT = 9;
/** Line suffixes do not move past this. */
export const E_LINE_SUFFIX_BOUNDARY = 10;
/** Content that is stored once and can be written any number of times. */
export const E_INTERNED = 11;
/** Several ways to write the same thing. The printer picks the first that fits. */
export const E_BEST_FITTING = 12;
/** Prettier's `cursor`: the printer notes where in the text this is. */
export const E_CURSOR = 13;

export const T_START_INDENT = 16;
export const T_END_INDENT = 17;
export const T_START_INDENT_WITH_LINE = 18;
export const T_END_INDENT_WITH_LINE = 19;
export const T_START_ALIGN = 20;
export const T_END_ALIGN = 21;
export const T_START_DEDENT = 22;
export const T_END_DEDENT = 23;
export const T_START_DEDENT_ROOT = 24;
export const T_END_DEDENT_ROOT = 25;
export const T_START_GROUP = 26;
export const T_END_GROUP = 27;
export const T_START_COND = 28;
export const T_END_COND = 29;
export const T_START_INDENT_IF_GROUP_BREAKS = 30;
export const T_END_INDENT_IF_GROUP_BREAKS = 31;
export const T_START_FILL = 32;
export const T_END_FILL = 33;
export const T_START_ENTRY = 34;
export const T_END_ENTRY = 35;
export const T_START_LINE_SUFFIX = 36;
export const T_END_LINE_SUFFIX = 37;
export const T_START_LABELLED = 38;
export const T_END_LABELLED = 39;

/** Name of an element kind (debugging, tests). */
export function elementName(t: number): string {
  switch (t) {
    case E_NOP: return "Nop";
    case E_SKIP: return "Skip";
    case E_SPACE: return "Space";
    case E_LINE: return "Line";
    case E_INDENTED_LINE_GROUP: return "IndentedLineGroup";
    case E_EXPAND_PARENT: return "ExpandParent";
    case E_TOKEN: return "Token";
    case E_TOKEN_IF_BREAKS: return "TokenIfBreaks";
    case E_SOURCE_TEXT: return "SourceText";
    case E_OWNED_TEXT: return "OwnedText";
    case E_LINE_SUFFIX_BOUNDARY: return "LineSuffixBoundary";
    case E_INTERNED: return "Interned";
    case E_BEST_FITTING: return "BestFitting";
    case E_CURSOR: return "Cursor";
    case T_START_INDENT: return "StartIndent";
    case T_END_INDENT: return "EndIndent";
    case T_START_INDENT_WITH_LINE: return "StartIndentWithLine";
    case T_END_INDENT_WITH_LINE: return "EndIndentWithLine";
    case T_START_ALIGN: return "StartAlign";
    case T_END_ALIGN: return "EndAlign";
    case T_START_DEDENT: return "StartDedent";
    case T_END_DEDENT: return "EndDedent";
    case T_START_DEDENT_ROOT: return "StartDedentRoot";
    case T_END_DEDENT_ROOT: return "EndDedentRoot";
    case T_START_GROUP: return "StartGroup";
    case T_END_GROUP: return "EndGroup";
    case T_START_COND: return "StartConditionalContent";
    case T_END_COND: return "EndConditionalContent";
    case T_START_INDENT_IF_GROUP_BREAKS: return "StartIndentIfGroupBreaks";
    case T_END_INDENT_IF_GROUP_BREAKS: return "EndIndentIfGroupBreaks";
    case T_START_FILL: return "StartFill";
    case T_END_FILL: return "EndFill";
    case T_START_ENTRY: return "StartEntry";
    case T_END_ENTRY: return "EndEntry";
    case T_START_LINE_SUFFIX: return "StartLineSuffix";
    case T_END_LINE_SUFFIX: return "EndLineSuffix";
    case T_START_LABELLED: return "StartLabelled";
    case T_END_LABELLED: return "EndLabelled";
    default: return "?";
  }
}

// ---------------------------------------------------------------------------------------------- line modes

/** A space if the enclosing group fits on a line, otherwise a line break. */
export const LM_SOFT_OR_SPACE = 0;
/** Nothing if the enclosing group fits on a line, otherwise a line break. */
export const LM_SOFT = 1;
/** A line break. */
export const LM_HARD = 2;
/** A line break and an empty line. */
export const LM_EMPTY = 3;
/** A space if the enclosing group fits on a line, otherwise a line break and an empty line. */
export const LM_SOFT_OR_SPACE_EMPTY = 4;
/** Nothing if the enclosing group fits on a line, otherwise a line break and an empty line. */
export const LM_SOFT_EMPTY = 5;

export function lineModeWillBreak(mode: number): boolean {
  return mode === LM_HARD || mode === LM_EMPTY;
}

/** `PrintMode`. */
export const PRINT_FLAT = 0;
export const PRINT_EXPANDED = 1;

/** `GroupMode`. */
export const GM_FLAT = 0;
/** It is written to break. */
export const GM_EXPAND = 1;
/** It breaks because something in it does. */
export const GM_PROPAGATED = 2;

/** `CursorMark`. Of several that are printed, the last `RegionStart` counts and the first `RegionEnd`. */
export const CURSOR_REGION_START = 0;
export const CURSOR_REGION_END = 1;

// ---------------------------------------------------------------------------------------------- Flat

// What `propagateExpand` finds out about the content of a group, or about interned content: all that the printer has
// to know to tell whether it fits on the rest of a line. A space is pending until a text follows it, and two in a row
// are one. So the spaces before the first text and after the last are not part of the width.
// Stored as one int: `width | flags << 16`. `width` is the number of columns from the start of the first text to the
// end of the last (0 if there is no text: content with a text that has no width is not measured).

/** The rest is known, and printing the content flat is only a matter of writing its texts. */
export const FF_MEASURED = 1;
/** An `E_SPACE` comes after the last text. */
export const FF_ENDS_WITH_SPACE_ELEMENT = 2;
/** A line break that is a space on one line comes before the first text. */
export const FF_STARTS_WITH_LINE = 4;
/** An `E_SPACE` comes before the first text. It counts unless the line is empty. */
export const FF_STARTS_WITH_SPACE = 8;
/** A space is pending after the last text, be it for a line break or an `E_SPACE`. */
export const FF_ENDS_WITH_SPACE = 16;
export const FF_HAS_LINE_SUFFIX_BOUNDARY = 32;
/** There is a group with an id in it. */
export const FF_HAS_GROUP_IDS = 64;
/** There is a forced line break in it. Of interned content only: a group has its mode. */
export const FF_EXPANDS = 128;

/** Packs a width (< 65536) and flags (< 256). */
export function flatPack(width: number, flags: number): number {
  return (width | 0) | ((flags | 0) << 16);
}
export function flatWidth(packed: number): number {
  return packed & 0xffff;
}
export function flatFlags(packed: number): number {
  return (packed >> 16) & 0xff;
}

// ---------------------------------------------------------------------------------------------- text widths

// The number of columns that a text takes up to its first line break, and whether it has one, packed in an int32:
//   bits 0-29: the width; bit 30: ONE_STRING; bit 31 (the sign): MULTILINE.
export const TW_MULTILINE = -2147483648; // 1 << 31
export const TW_ONE_STRING = 1073741824; // 1 << 30
export const TW_VALUE_MASK = 1073741823; // (1 << 30) - 1

export function twSingle(width: number): number {
  return width & TW_VALUE_MASK;
}
/** `width`: up to the first line break. To Prettier the lines are strings with a `literalline` between them. */
export function twMultiline(width: number): number {
  return (width & TW_VALUE_MASK) | TW_MULTILINE;
}
/**
 * `width`: of all the lines together. To Prettier it is one string, in which a line break is a character without width
 * like another: whether it fits is asked of all of it and of what follows it.
 */
export function twMultilineString(width: number): number {
  return (width & TW_VALUE_MASK) | TW_MULTILINE | TW_ONE_STRING;
}
export function twValue(w: number): number {
  return w & TW_VALUE_MASK;
}
export function twIsMultiline(w: number): boolean {
  return w < 0;
}
export function twIsOneString(w: number): boolean {
  return (w & TW_ONE_STRING) !== 0;
}

// ---------------------------------------------------------------------------------------------- labels

/** `JsLabels`: what `labelled` says about the content. */
export const LABEL_MEMBER_CHAIN = 1;

// ---------------------------------------------------------------------------------------------- tokens

// A token is a keyword or a punctuator: ASCII, without line breaks or tabs, at most 255 bytes. It is registered once
// (at module init) with `token("...")`, which returns an opaque int handle. Registering the same text twice gives the
// same handle. Module state is per thread, and module init runs identically in every thread, so handles are the same
// in every thread (they never cross threads anyway).
//
// In the document a token of up to 12 bytes is an element whose **kind says its length** and whose columns `a`, `b`, `c`
// are its bytes (little-endian words): `TOK_BASE + len` for a token, `TIB_BASE + len` for one that is only written if
// the group breaks (`E_TOKEN_IF_BREAKS` with inline bytes). The printer writes it with one to three 32-bit stores and no
// table lookup. A longer token is `E_TOKEN` / `E_TOKEN_IF_BREAKS` with `a` = offset into `tokenBytes()` and `b` = length.

/** The kinds `TOK_BASE + 1 .. TOK_BASE + 12` are tokens with inline bytes. */
export const TOK_BASE = 64;
/** The kinds `TIB_BASE + 1 .. TIB_BASE + 12` are tokens that are only written if the group breaks. */
export const TIB_BASE = 80;
export const TOK_INLINE_MAX = 12;
/** The most tokens that can be registered. */
export const MAX_TOKENS = 4096;

// By handle. Constant arrays (not reallocated), so that the writer reads them without a call.
export const TOK_W0 = new Int32Array(MAX_TOKENS);
export const TOK_W1 = new Int32Array(MAX_TOKENS);
export const TOK_W2 = new Int32Array(MAX_TOKENS);
export const TOK_LEN = new Int32Array(MAX_TOKENS);
export const TOK_OFF = new Int32Array(MAX_TOKENS);

let tokenPool = new Uint8Array(2048);
let tokenPoolLen = 0;
const tokenIndex = new Map<string, number>();
let tokenCount = 1;

export function token(text: string): number {
  const known = tokenIndex.get(text);
  if (known !== undefined) return known;
  const n = text.length;
  if (n > 255 || n === 0) throw new Error("a token has 1 to 255 bytes");
  if (tokenCount >= MAX_TOKENS) throw new Error("too many tokens");
  if (tokenPoolLen + n > tokenPool.length) {
    const np = new Uint8Array(tokenPool.length * 2);
    np.set(tokenPool);
    tokenPool = np;
  }
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128 || c === 10 || c === 13 || c === 9) throw new Error("a token is ASCII without line breaks or tabs");
    tokenPool[tokenPoolLen + i] = c;
  }
  const h = tokenCount;
  tokenCount = h + 1;
  TOK_LEN[h] = n;
  TOK_OFF[h] = tokenPoolLen;
  let w0 = 0;
  let w1 = 0;
  let w2 = 0;
  for (let i = 0; i < n && i < TOK_INLINE_MAX; i++) {
    const c = text.charCodeAt(i);
    if (i < 4) w0 = w0 | (c << (8 * i));
    else if (i < 8) w1 = w1 | (c << (8 * (i - 4)));
    else w2 = w2 | (c << (8 * (i - 8)));
  }
  TOK_W0[h] = w0;
  TOK_W1[h] = w1;
  TOK_W2[h] = w2;
  tokenPoolLen = tokenPoolLen + n;
  tokenIndex.set(text, h);
  return h;
}
export function tokenLen(handle: number): number {
  return TOK_LEN[handle] | 0;
}
/** The bytes that long tokens (`E_TOKEN`, `E_TOKEN_IF_BREAKS`: `a` = offset, `b` = length) point into (valid until the next `token()` call). */
export function tokenBytes(): Uint8Array {
  return tokenPool;
}
/** The text of a token (slow path: debugging, tests). */
export function tokenText(handle: number): string {
  let s = "";
  const off = TOK_OFF[handle] | 0;
  const n = TOK_LEN[handle] | 0;
  for (let i = 0; i < n; i++) s += String.fromCharCode(tokenPool[off + i] | 0);
  return s;
}

// ---------------------------------------------------------------------------------------------- reserved pool prefix

// The first elements of every pool, which the printer needs to be somewhere (as runs it can queue).
//   [0]      EndLineSuffix                      (END_LINE_SUFFIX: run [0, 1))
//   [1..7)   Line(mode) for each mode           (line_break(mode): run [1 + mode, 2 + mode))
//   [7..10)  StartIndentWithLine(SoftOrSpace), EndIndent, EndGroup   (REST_OF_INDENTED_LINE_GROUP: run [7, 10))
export const END_LINE_SUFFIX_AT = 0;
export const LINE_BREAK_AT = 1;
export const REST_OF_INDENTED_LINE_GROUP_AT = 7;
export const RESERVED = 10;
