// Port of vendor/bun/src/format/ir/formatter.rs and ir/builders.rs: the `Formatter` that a document is written to.
//
// Rust writes `write!(f, [a, b, group(&x)])` with `Format` values and closures. Here **every builder is a method that
// writes its elements right now** (see docs/IR_API.md for the table): `group(&x)` is
// `f.startGroup(); ...x...; f.endGroup();`, `format_with(|f| ..)` is a function call at the place it is written, and
// content that Rust formats more than once or later (`memoized`, `intern`, `capture`, `best_fitting!`) is *captured*
// into a handle (an int) with `startCapture()/endCapture(slot)` and written with `writeInterned(handle)`.
//
// There is no pass over a finished document. Every element goes through `push4`, which tells the `Tracker` about it,
// so that when a group ends, what the printer has to know about it (does something in it force a line break, how wide
// is it on one line) is written into its start tag, and when a capture ends, into its `E_SKIP`. So
// `willBreakFrom(start)` / `willBreak(handle)` cost nothing. **Never write into `f.st` directly** (JSON writes its
// own document into a bare `Storage` and then calls `propagateExpand`).
import { ByteBuf } from "../../base/bytebuf.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { Stack } from "../../base/stack.ts";
import { encodeUtf8 } from "../../base/utf8.ts";
import {
  FormatOptions,
  FLAVOR_OXFMT,
  TRAILING_SEPARATOR_ALLOWED,
  trailingSeparator,
} from "../options.ts";
import { FormatContext } from "./context.ts";
import { Tracker } from "./document.ts";
import {
  E_BEST_FITTING,
  E_CURSOR,
  E_EXPAND_PARENT,
  E_INDENTED_LINE_GROUP,
  E_INTERNED,
  E_LINE,
  E_LINE_SUFFIX_BOUNDARY,
  E_NOP,
  E_OWNED_TEXT,
  E_SKIP,
  E_SOURCE_TEXT,
  E_SPACE,
  E_TOKEN,
  E_TOKEN_IF_BREAKS,
  GM_EXPAND,
  GM_FLAT,
  LM_EMPTY,
  LM_HARD,
  LM_SOFT,
  LM_SOFT_EMPTY,
  LM_SOFT_OR_SPACE,
  LM_SOFT_OR_SPACE_EMPTY,
  PRINT_EXPANDED,
  PRINT_FLAT,
  RESERVED,
  T_END_ALIGN,
  T_END_COND,
  T_END_DEDENT,
  T_END_DEDENT_ROOT,
  T_END_ENTRY,
  T_END_FILL,
  T_END_GROUP,
  T_END_INDENT,
  T_END_INDENT_IF_GROUP_BREAKS,
  T_END_INDENT_WITH_LINE,
  T_END_LABELLED,
  T_END_LINE_SUFFIX,
  T_START_ALIGN,
  T_START_COND,
  T_START_DEDENT,
  T_START_DEDENT_ROOT,
  T_START_ENTRY,
  T_START_FILL,
  T_START_GROUP,
  T_START_INDENT,
  T_START_INDENT_IF_GROUP_BREAKS,
  T_START_INDENT_WITH_LINE,
  T_START_LABELLED,
  T_START_LINE_SUFFIX,
  TW_ONE_STRING,
  TW_VALUE_MASK,
  lineModeWillBreak,
  TIB_BASE,
  TOK_BASE,
  token as tokenOf,
  TOK_INLINE_MAX,
  TOK_OFF,
  TOK_TAB,
  twSingle,
} from "./element.ts";
import { Storage } from "./storage.ts";
import { oddTable, stringWidthAs, textWidth } from "./width.ts";
import { printCaptureToText } from "./printer.ts";

/** `Variants`: which of the variants of a best-fitting are left when soft line breaks are removed. */
const VARIANTS_FLATTEST = 0;
const VARIANTS_ALL = 1;

export class Formatter {
  /** `st` is the document so far (the pool), the variants of best-fitting elements and the owned text. */
  st: Storage;
  /** It is told about every element that is written. */
  tracker: Tracker;
  /** What `E_SOURCE_TEXT` is a range of. */
  source: Uint8Array;
  /** `ODD_TAB`, by field: 1 for the bytes that make a text "odd" (see `isPlainSource`). */
  oddTab: Uint8Array;
  /** `TOK_TAB`, by field: a module-level global is a thread-local lookup in each access. */
  tokTab: Int32Array;
  nextGroupId: number;
  options: FormatOptions;
  /** The hook for what is language specific (JsFormatContext extends FormatContext). */
  context: FormatContext;
  /** How deep something can be nested; shared by everything that writes this document. */
  stack: Stack;
  /** Cached from `options`. */
  flavor: number;
  tabWidth: number;
  /** Interned content, and the same without soft line breaks. */
  cleaned: Map<number, number>;
  conditions: I32Vec;
  /** Vectors of handles for whoever needs one for a while: `takeVec` / `recycleVec`. */
  spare: I32Vec[];
  // Embedded formatters (`beginEmbedded`)
  embedSources: Uint8Array[];
  embedState: I32Vec;

  constructor(options: FormatOptions) {
    this.st = new Storage(4096);
    this.tracker = new Tracker(this.st);
    this.source = new Uint8Array(0);
    this.oddTab = oddTable();
    this.tokTab = TOK_TAB;
    this.nextGroupId = 1;
    this.options = options;
    this.context = new FormatContext(options);
    this.stack = Stack.create();
    this.flavor = options.flavor;
    this.tabWidth = 0;
    this.cleaned = new Map<number, number>();
    this.conditions = new I32Vec(16);
    this.spare = [];
    this.embedSources = [];
    this.embedState = new I32Vec(8);
  }

  /**
   * Starts a document for `source` (what `E_SOURCE_TEXT` is a range of). Everything that was allocated for the last file is
   * kept. `context` may be null for a document that is not written for JavaScript.
   */
  reset(source: Uint8Array, options: FormatOptions, context: FormatContext | null): void {
    this.options = options;
    this.context = context === null ? new FormatContext(options) : context;
    this.flavor = options.flavor;
    this.tabWidth = options.flavor === FLAVOR_OXFMT ? options.indentWidth : 0;
    this.st.clear();
    this.tracker.clear();
    this.setSource(source);
    this.cleaned.clear();
    this.nextGroupId = 1;
    this.stack.reset();
    this.embedSources.length = 0;
    this.embedState.reset();
    // Measured by oxc on the sources of VS Code: the median is 0.19 elements per byte, and 95% of the files are below 0.4.
    this.st.reserve(RESERVED + ((source.length * 2) / 5 | 0) + 16);
  }

  setSource(source: Uint8Array): void {
    this.source = source;
  }

  /** Where the document is: `[RESERVED, len)`. Use `rootStart()`/`rootEnd()`. */
  rootStart(): number {
    return RESERVED;
  }
  rootEnd(): number {
    return this.st.len;
  }

  // ───────────────────────────── ids ─────────────────────────────

  /** A new group id (Rust `group_id("debug name")`). Ids are small positive ints; 0 means "no id". */
  groupId(): number {
    const id = this.nextGroupId;
    this.nextGroupId = id + 1;
    return id;
  }

  // ───────────────────────────── writing elements ─────────────────────────────

  /** The one place where elements are written: pushes `(t, a, b, c)` and tells the tracker. Returns its index. */
  push4(t: number, a: number, b: number, c: number): number {
    const st = this.st;
    const i = st.len;
    if (i === st.tag.length) st.grow(i + 1);
    st.tag[i] = t | 0;
    st.a[i] = a | 0;
    st.b[i] = b | 0;
    st.c[i] = c | 0;
    st.len = i + 1;
    this.tracker.note(t, a | 0, b | 0, c | 0, i);
    return i;
  }

  /** `push4` for E_SOURCE_TEXT / E_OWNED_TEXT: the tracker's `note` for a text, without the dispatch. */
  pushText(t: number, a: number, b: number, w: number): void {
    const st = this.st;
    const i = st.len;
    if (i === st.tag.length) st.grow(i + 1);
    st.tag[i] = t | 0;
    st.a[i] = a | 0;
    st.b[i] = b | 0;
    st.c[i] = w | 0;
    st.len = i + 1;
    const wi = w | 0;
    // multiline and not one string
    if (wi < 0 && (wi & TW_ONE_STRING) === 0) this.tracker.forcedBreak(i);
    this.tracker.text(wi & TW_VALUE_MASK, i);
  }

  /** An element that the tracker has nothing to learn from (indentation, entries of a fill, labels, a token that is only written if the group breaks). */
  pushPlain(t: number, a: number, b: number, c: number): void {
    const st = this.st;
    const i = st.len;
    if (i === st.tag.length) st.grow(i + 1);
    st.tag[i] = t | 0;
    st.a[i] = a | 0;
    st.b[i] = b | 0;
    st.c[i] = c | 0;
    st.len = i + 1;
  }

  /** Number of elements written so far. Remember it to look at what is written from then on (`willBreakFrom(start)`). */
  len(): number {
    return this.st.len;
  }

  /** A keyword or a punctuator, registered with `token("...")` in element.ts. */
  token(handle: number): void {
    const h4 = handle * 4;
    const len = this.tokTab[h4] | 0;
    if (len <= TOK_INLINE_MAX) {
      const st = this.st;
      const i = st.len;
      if (i === st.tag.length) st.grow(i + 1);
      st.tag[i] = (TOK_BASE + len) | 0;
      st.a[i] = this.tokTab[h4 + 1] | 0;
      st.b[i] = this.tokTab[h4 + 2] | 0;
      st.c[i] = this.tokTab[h4 + 3] | 0;
      st.len = i + 1;
      this.tracker.text(len, i);
    } else {
      this.push4(E_TOKEN, TOK_OFF[handle] | 0, len, 0);
    }
  }

  /**
   * `f.write_token("(")` with the text at hand: looks the token up in the table (a hash of the string). Fine for rare
   * tokens; for the others register a constant at module level (`const LPAREN = token("(")`, ir/tokens.ts) and call `token`.
   */
  tokenStr(text: string): void {
    this.token(tokenOf(text));
  }

  /** Rust `if_group_breaks(&"..")`: a token that is only written if the enclosing group breaks. */
  tokenIfBreaks(handle: number): void {
    const h4 = handle * 4;
    const len = this.tokTab[h4] | 0;
    if (len <= TOK_INLINE_MAX) this.pushPlain(TIB_BASE + len, this.tokTab[h4 + 1] | 0, this.tokTab[h4 + 2] | 0, this.tokTab[h4 + 3] | 0);
    else this.pushPlain(E_TOKEN_IF_BREAKS, TOK_OFF[handle] | 0, len, 0);
  }

  space(): void {
    const i = this.st.len;
    this.pushPlain(E_SPACE, 0, 0, 0);
    this.tracker.space(i);
  }

  /** `maybe_space(should_insert)` */
  maybeSpace(shouldInsert: boolean): void {
    if (shouldInsert) this.push4(E_SPACE, 0, 0, 0);
  }

  /** Nothing if the enclosing group fits on a line, otherwise a line break. */
  softLineBreak(): void {
    const i = this.st.len;
    this.pushPlain(E_LINE, LM_SOFT, 0, 0);
  }
  /** Nothing if the enclosing group fits on a line, otherwise a line break and an empty line. */
  softEmptyLine(): void {
    const i = this.st.len;
    this.pushPlain(E_LINE, LM_SOFT_EMPTY, 0, 0);
  }
  /** A line break, which also makes the enclosing groups break. */
  hardLineBreak(): void {
    const i = this.st.len;
    this.pushPlain(E_LINE, LM_HARD, 0, 0);
    this.tracker.line(LM_HARD, i);
  }
  /** A line break and an empty line. */
  emptyLine(): void {
    const i = this.st.len;
    this.pushPlain(E_LINE, LM_EMPTY, 0, 0);
    this.tracker.line(LM_EMPTY, i);
  }
  /** A space if the enclosing group fits on a line, otherwise a line break. */
  softLineBreakOrSpace(): void {
    const i = this.st.len;
    this.pushPlain(E_LINE, LM_SOFT_OR_SPACE, 0, 0);
    this.tracker.line(LM_SOFT_OR_SPACE, i);
  }
  /** A space if the enclosing group fits on a line, otherwise a line break and an empty line. */
  softEmptyLineOrSpace(): void {
    const i = this.st.len;
    this.pushPlain(E_LINE, LM_SOFT_OR_SPACE_EMPTY, 0, 0);
    this.tracker.line(LM_SOFT_OR_SPACE_EMPTY, i);
  }
  /** A line of the given `LM_*` mode. */
  line(mode: number): void {
    this.push4(E_LINE, mode, 0, 0);
  }

  /** Makes the enclosing groups break. */
  expandParent(): void {
    this.push4(E_EXPAND_PARENT, 0, 0, 0);
  }

  /** `f.write_element(FormatElement::Nop)`: an element that prints nothing (a marker that something was written). */
  nop(): void {
    this.push4(E_NOP, 0, 0, 0);
  }

  /** Pending line suffixes are printed here at the latest, followed by a line break. */
  lineSuffixBoundary(): void {
    this.push4(E_LINE_SUFFIX_BOUNDARY, 0, 0, 0);
  }

  /** Prettier's `cursor`: `CURSOR_REGION_START` or `CURSOR_REGION_END`. */
  cursor(mark: number): void {
    this.push4(E_CURSOR, mark, 0, 0);
  }

  // ───────────────────────────── text ─────────────────────────────

  /** The number of columns that `text[start, end)`, which has no line break, takes. */
  stringWidth(text: Uint8Array, start: number, end: number): number {
    return stringWidthAs(text, start, end, this.flavor);
  }

  /** The `TextWidth` (packed) of a text that can have tabs, `\n` and anything else. */
  textWidth(text: Uint8Array, start: number, end: number): number {
    return textWidth(text, start, end, this.flavor, this.tabWidth);
  }

  /**
   * Whether the source text `[start, end)`, which has no line break and no tab, is as wide as it is long and has no
   * backslash. It can be so without this saying so.
   */
  isPlainSource(start: number, end: number): boolean {
    const src = this.source;
    const tab = this.oddTab;
    const e = end | 0;
    let bad = 0;
    let i = start | 0;
    for (; (i + 4) <= e; i = (i + 4) | 0) {
      bad = bad | (tab[src[i] | 0] | 0) | (tab[src[(i + 1) | 0] | 0] | 0) | (tab[src[(i + 2) | 0] | 0] | 0) | (tab[src[(i + 3) | 0] | 0] | 0);
    }
    for (; i < e; i = (i + 1) | 0) bad = bad | (tab[src[i] | 0] | 0);
    return bad === 0;
  }

  /**
   * Rust `source_text(span)`: writes the source text `[start, end)`, which is a single token without a line break or a
   * tab: an identifier, a number, a regular expression. This is the cheapest way to write text.
   */
  sourceText(start: number, end: number): void {
    const s0 = start | 0;
    const e = end | 0;
    const src = this.source;
    const tab = this.oddTab;
    let bad = 0;
    let k = s0;
    for (; (k + 4) <= e; k = (k + 4) | 0) {
      bad = bad | (tab[src[k] | 0] | 0) | (tab[src[(k + 1) | 0] | 0] | 0) | (tab[src[(k + 2) | 0] | 0] | 0) | (tab[src[(k + 3) | 0] | 0] | 0);
    }
    for (; k < e; k = (k + 1) | 0) bad = bad | (tab[src[k] | 0] | 0);
    if (bad !== 0) {
      this.writeOddSourceToken(s0, e);
      return;
    }
    // push4 and Tracker.note, for a single-line text of known width.
    const st = this.st;
    const i = st.len | 0;
    if (i === st.tag.length) st.grow(i + 1);
    const w = (e - s0) | 0;
    st.tag[i] = E_SOURCE_TEXT;
    st.a[i] = s0;
    st.b[i] = w;
    st.c[i] = w;
    st.len = (i + 1) | 0;
    this.tracker.text(w, i);
  }

  writeOddSourceToken(start: number, end: number): void {
    const src = this.source;
    let hasBackslash = false;
    for (let i = start; i < end; i++) {
      if ((src[i] | 0) === 92) { hasBackslash = true; break; }
    }
    if (hasBackslash && this.writeNameWithoutEscapes(start, end)) return;
    this.pushText(E_SOURCE_TEXT, start, end - start, twSingle(this.stringWidth(src, start, end)));
  }

  /**
   * `ab` is written `ab`: Prettier prints the name of an identifier, not its text. Returns whether the text is a
   * name, with or without the `.` or `?.` before it.
   */
  writeNameWithoutEscapes(start: number, end: number): boolean {
    if (start >= end) return false;
    const b = this.source[start] | 0;
    const ok =
      b === 92 || b === 35 || b === 46 || b === 63 || b === 36 || b === 95 ||
      (b >= 97 && b <= 122) || (b >= 65 && b <= 90) || b >= 0x80;
    if (!ok) return false;
    const text = this.st.text;
    const at = text.len;
    withoutUnicodeEscapes(this.source, start, end, text);
    this.endBuiltText(at);
    return true;
  }

  /**
   * Rust `text(&source[range])`: writes `source[start, end)`, which can be anything but has no `\r`. It is not copied:
   * the element is a range of the source.
   */
  textSource(start: number, end: number): void {
    this.pushText(E_SOURCE_TEXT, start, end - start, this.textWidth(this.source, start, end));
  }

  /**
   * Rust `write_text(&source[range], Some(width))`: a range of the source with a width of the caller's (a packed
   * `TextWidth`: `twSingle(n)`, `twMultiline(n)`, `twMultilineString(n)` from element.ts).
   */
  textSourceWithWidth(start: number, end: number, width: number): void {
    this.pushText(E_SOURCE_TEXT, start, end - start, width);
  }

  /** Rust `write_text(&owned, Some(width))`: `bytes[start, end)` is copied. */
  textBytesWithWidth(bytes: Uint8Array, start: number, end: number, width: number): void {
    const text = this.st.text;
    const at = text.len;
    text.append(bytes, start, end);
    this.pushText(E_OWNED_TEXT, at, end - start, width);
  }

  /** Rust `text_without_whitespace(&source[range])`: the text has no tab and no line break. */
  textSourceNoWs(start: number, end: number): void {
    this.pushText(E_SOURCE_TEXT, start, end - start, twSingle(this.stringWidth(this.source, start, end)));
  }

  /** Rust `text(&owned)`: writes `bytes[start, end)`, which can be anything but has no `\r`. It is copied. */
  textBytes(bytes: Uint8Array, start: number, end: number): void {
    const text = this.st.text;
    const at = text.len;
    text.append(bytes, start, end);
    this.pushText(E_OWNED_TEXT, at, end - start, this.textWidth(this.st.text.data, at, at + (end - start)));
  }

  /** Rust `text_without_whitespace(&owned)`. */
  textBytesNoWs(bytes: Uint8Array, start: number, end: number): void {
    const text = this.st.text;
    const at = text.len;
    text.append(bytes, start, end);
    this.pushText(E_OWNED_TEXT, at, end - start, twSingle(this.stringWidth(this.st.text.data, at, at + (end - start))));
  }

  /** Writes a JS string (UTF-8 encoded; slow path: for text that is built at run time and is rare). */
  textStr(s: string): void {
    const text = this.st.text;
    const at = text.len;
    text.appendAll(new TextEncoder().encode(s));
    this.endBuiltText(at);
  }

  /** The buffer that `E_OWNED_TEXT` is a range of: append to it and call `endBuiltText(start)` (Rust `write_built_text`). */
  textBuf(): ByteBuf {
    return this.st.text;
  }

  /** Writes what has been appended to `textBuf()` from `start` on as one text (Rust `write_owned_text_from`). */
  endBuiltText(start: number): void {
    const text = this.st.text;
    const len = text.len - start;
    const w = this.textWidth(text.data, start, text.len);
    this.pushText(E_OWNED_TEXT, start, len, w);
  }

  // ───────────────────────────── tags ─────────────────────────────

  /** Line breaks in the content are followed by one more level of indentation. */
  startIndent(): void {
    this.pushPlain(T_START_INDENT, 0, 0, 0);
  }
  endIndent(): void {
    this.pushPlain(T_END_INDENT, 0, 0, 0);
  }
  /** Undoes one level of indentation. */
  startDedent(): void {
    this.pushPlain(T_START_DEDENT, 0, 0, 0);
  }
  endDedent(): void {
    this.pushPlain(T_END_DEDENT, 0, 0, 0);
  }
  /** Line breaks in the content are followed by no indentation at all. */
  startDedentToRoot(): void {
    this.pushPlain(T_START_DEDENT_ROOT, 0, 0, 0);
  }
  endDedentToRoot(): void {
    this.pushPlain(T_END_DEDENT_ROOT, 0, 0, 0);
  }
  /** Content that is printed at the end of the line, before the next line break: a comment. */
  startLineSuffix(): void {
    this.push4(T_START_LINE_SUFFIX, 0, 0, 0);
  }
  endLineSuffix(): void {
    this.push4(T_END_LINE_SUFFIX, 0, 0, 0);
  }
  /** Marks the content, for whoever writes the parent: `hasLabelFrom(start, label)`. */
  startLabelled(label: number): void {
    this.pushPlain(T_START_LABELLED, label, 0, 0);
  }
  endLabelled(): void {
    this.pushPlain(T_END_LABELLED, 0, 0, 0);
  }
  /**
   * Line breaks in the content are followed by `count` more spaces. Nothing special happens if `count` is 0: call
   * `endAlign(count)` with the same count.
   */
  startAlign(count: number): void {
    if (count !== 0) this.pushPlain(T_START_ALIGN, count, 0, 0);
  }
  endAlign(count: number): void {
    if (count !== 0) this.pushPlain(T_END_ALIGN, 0, 0, 0);
  }

  /** `block_indent`: the content on lines of its own, indented. */
  startBlockIndent(): void {
    const i = this.st.len;
    this.pushPlain(T_START_INDENT_WITH_LINE, LM_HARD, 0, 0);
    this.tracker.line(LM_HARD, i);
  }
  endBlockIndent(): void {
    const i = this.st.len;
    this.pushPlain(T_END_INDENT_WITH_LINE, LM_HARD, 0, 0);
    this.tracker.line(LM_HARD, i);
  }
  /** `soft_block_indent`: if the enclosing group breaks, the content on lines of its own, indented. */
  startSoftBlockIndent(): void {
    this.pushPlain(T_START_INDENT_WITH_LINE, LM_SOFT, 0, 0);
  }
  endSoftBlockIndent(): void {
    this.pushPlain(T_END_INDENT_WITH_LINE, LM_SOFT, 0, 0);
  }
  /** `soft_space_or_block_indent`: if the enclosing group breaks, the content on lines of its own, indented. Otherwise the content between spaces. */
  startSoftSpaceOrBlockIndent(): void {
    const i = this.st.len;
    this.pushPlain(T_START_INDENT_WITH_LINE, LM_SOFT_OR_SPACE, 0, 0);
    this.tracker.line(LM_SOFT_OR_SPACE, i);
  }
  endSoftSpaceOrBlockIndent(): void {
    const i = this.st.len;
    this.pushPlain(T_END_INDENT_WITH_LINE, LM_SOFT_OR_SPACE, 0, 0);
    this.tracker.line(LM_SOFT_OR_SPACE, i);
  }
  /** `soft_block_indent_with_maybe_space(content, should_add_space)`: call `endSoftBlockIndentWithMaybeSpace` with the same flag. */
  startSoftBlockIndentWithMaybeSpace(shouldAddSpace: boolean): void {
    this.push4(T_START_INDENT_WITH_LINE, shouldAddSpace ? LM_SOFT_OR_SPACE : LM_SOFT, 0, 0);
  }
  endSoftBlockIndentWithMaybeSpace(shouldAddSpace: boolean): void {
    this.push4(T_END_INDENT_WITH_LINE, shouldAddSpace ? LM_SOFT_OR_SPACE : LM_SOFT, 0, 0);
  }
  /** `soft_line_indent_or_space`: if the enclosing group breaks, the content on the next line, indented. Otherwise a space and the content. */
  startSoftLineIndentOrSpace(): void {
    const i = this.st.len;
    this.pushPlain(T_START_INDENT_WITH_LINE, LM_SOFT_OR_SPACE, 0, 0);
    this.tracker.line(LM_SOFT_OR_SPACE, i);
  }
  endSoftLineIndentOrSpace(): void {
    this.pushPlain(T_END_INDENT, 0, 0, 0);
  }

  /** Content that is written on one line if it fits, and otherwise with all the line breaks that are directly in it. */
  startGroup(): void {
    const i = this.st.len;
    this.pushPlain(T_START_GROUP, 0, 0, 0);
    this.tracker.open(0, i);
  }
  /** `group(..).with_group_id(id)` (id from `groupId()`). */
  startGroupId(id: number): void {
    this.push4(T_START_GROUP, id, 0, 0);
  }
  /** `group(..).should_expand(shouldExpand)`: whether it breaks even if it fits. */
  startGroupExpand(shouldExpand: boolean): void {
    this.push4(T_START_GROUP, 0, shouldExpand ? GM_EXPAND << 24 : 0, 0);
  }
  /** `group(..).with_group_id(id).should_expand(shouldExpand)`; `id` 0 is none. */
  startGroupWith(id: number, shouldExpand: boolean): void {
    this.push4(T_START_GROUP, id, shouldExpand ? GM_EXPAND << 24 : 0, 0);
  }
  endGroup(): void {
    const i = this.st.len;
    this.pushPlain(T_END_GROUP, 0, 0, 0);
    this.tracker.endGroup(i);
  }
  /**
   * `group(&indent(&soft_line_break_or_space())).with_group_id(id)`: one element. A group, in it an indent, and in that a
   * `soft_line_break_or_space()`: a line break that is taken, with one more level of indentation after it, if what
   * follows it does not fit on the line.
   */
  indentedLineGroup(id: number): void {
    this.push4(E_INDENTED_LINE_GROUP, id, 0, 0);
  }

  /** `if_group_breaks(..)`: content that is only written if the enclosing group breaks. Close with `endConditional()`. */
  startIfGroupBreaks(): void {
    this.push4(T_START_COND, 0, PRINT_EXPANDED, 0);
  }
  /** `if_group_breaks(..).with_group_id(id)`: the group `id` has to come before this in the document. */
  startIfGroupBreaksId(id: number): void {
    this.push4(T_START_COND, id, PRINT_EXPANDED, 0);
  }
  /** `if_group_fits_on_line(..)`: content that is only written if the group fits on a line. */
  startIfGroupFits(): void {
    this.push4(T_START_COND, 0, PRINT_FLAT, 0);
  }
  /** `if_group_fits_on_line(..).with_group_id(id)`. */
  startIfGroupFitsId(id: number): void {
    this.push4(T_START_COND, id, PRINT_FLAT, 0);
  }
  /** The end of `startIfGroupBreaks*`/`startIfGroupFits*`. */
  endConditional(): void {
    this.push4(T_END_COND, 0, 0, 0);
  }
  /** Indents the content if the group `id` breaks, which has to come before this in the document. */
  startIndentIfGroupBreaks(id: number): void {
    this.pushPlain(T_START_INDENT_IF_GROUP_BREAKS, id, 0, 0);
  }
  endIndentIfGroupBreaks(id: number): void {
    this.pushPlain(T_END_INDENT_IF_GROUP_BREAKS, id, 0, 0);
  }

  /** Rust `f.fill()`: alternating items and separators, each an entry. As many as fit are written on each line. */
  startFill(): void {
    this.pushPlain(T_START_FILL, 0, 0, 0);
  }
  endFill(): void {
    this.pushPlain(T_END_FILL, 0, 0, 0);
  }
  /** An item or a separator of a fill (and the variants of a best-fitting are entries too). */
  startEntry(): void {
    this.pushPlain(T_START_ENTRY, 0, 0, 0);
  }
  endEntry(): void {
    this.pushPlain(T_END_ENTRY, 0, 0, 0);
  }

  /** `FormatTrailingCommas.fmt`: `if_group_breaks(",")` unless the options leave it out. `comma` is `token(",")`. */
  writeTrailingCommas(kind: number, comma: number): void {
    if (trailingSeparator(kind, this.options) === TRAILING_SEPARATOR_ALLOWED) this.tokenIfBreaks(comma);
  }

  // ───────────────────────────── looking at what is written ─────────────────────────────

  /** `f.elements_from(start).will_break()`: whether the printer is certain to print what is written since `len()` was `start` over several lines. */
  willBreakFrom(start: number): boolean {
    return this.tracker.willBreakFrom(start);
  }

  /** `memoized.inspect(f).will_break()` / `element.will_break(f)` for a handle from `endCapture`. -1 (nothing) is false. */
  willBreak(handle: number): boolean {
    return handle >= 0 && (this.st.c[handle] | 0) !== 0;
  }

  /** `f.elements_from(start).may_directly_break(flavor)`: whether there is any `E_LINE` in it. */
  mayDirectlyBreakFrom(start: number): boolean {
    return this.mayDirectlyBreakRange(start, this.st.len);
  }

  /** The same for captured content. */
  mayDirectlyBreak(handle: number): boolean {
    if (handle < 0) return false;
    return this.mayDirectlyBreakRange(handle + 1, handle + 1 + (this.st.a[handle] | 0));
  }

  mayDirectlyBreakRange(from: number, to: number): boolean {
    const st = this.st;
    const rest = this.scratchRanges;
    rest.reset();
    rest.push(from);
    rest.push(to);
    const oxfmt = this.flavor === FLAVOR_OXFMT;
    while (rest.len > 0) {
      let end = rest.pop();
      let i = rest.pop();
      let ignoreDepth = 0;
      while (i < end) {
        const t = st.tag[i] | 0;
        if (t === E_SKIP) {
          i = i + (st.a[i] | 0) + 1;
          continue;
        }
        if (t === T_START_LINE_SUFFIX) ignoreDepth = ignoreDepth + 1;
        else if (t === T_END_LINE_SUFFIX) ignoreDepth = ignoreDepth > 0 ? ignoreDepth - 1 : 0;
        else if (ignoreDepth !== 0) {
          // nothing
        } else if (t === E_LINE || t === E_INDENTED_LINE_GROUP || t === T_START_INDENT_WITH_LINE || t === T_END_INDENT_WITH_LINE) {
          return true;
        } else if (t === E_INTERNED) {
          const h = st.a[i] | 0;
          rest.push(h + 1);
          rest.push(h + 1 + (st.a[h] | 0));
        } else if (t === E_BEST_FITTING && !oxfmt) {
          // oxfmt does not look into it.
          const first = st.variants.data[st.a[i] | 0] | 0;
          rest.push(first + 1);
          rest.push(first + 1 + (st.a[first] | 0));
        }
        i = i + 1;
      }
    }
    return false;
  }

  scratchRanges: I32Vec = new I32Vec(32);

  /** `f.elements_from(start).has_label(label)`: whether what is written from `start` on starts with the label. */
  hasLabelFrom(start: number, label: number): boolean {
    return this.hasLabelRange(start, this.st.len, label);
  }

  /** The same for captured content. */
  hasLabel(handle: number, label: number): boolean {
    if (handle < 0) return false;
    return this.hasLabelRange(handle + 1, handle + 1 + (this.st.a[handle] | 0), label);
  }

  hasLabelRange(from: number, to: number, label: number): boolean {
    const st = this.st;
    let i = from;
    let end = to;
    while (i < end) {
      const t = st.tag[i] | 0;
      if (t === E_SKIP) {
        i = i + (st.a[i] | 0) + 1;
      } else if (t === E_NOP || t === E_CURSOR) {
        i = i + 1;
      } else if (t === T_START_LABELLED) {
        return (st.a[i] | 0) === label;
      } else if (t === E_INTERNED) {
        const h = st.a[i] | 0;
        i = h + 1;
        end = h + 1 + (st.a[h] | 0);
      } else {
        return false;
      }
    }
    return false;
  }

  /**
   * Writes a copy of the element at `index` of the pool (Rust `f.write_element(*element)` for an element that was read
   * from the pool: html/map_strings.rs, sort_imports). Not for an `E_SKIP`.
   */
  copyElement(index: number): void {
    const st = this.st;
    this.push4(st.tag[index] | 0, st.a[index] | 0, st.b[index] | 0, st.c[index] | 0);
  }

  /** The index of the first element of captured content (`handle` from `endCapture`; the elements are `[capturedStart, capturedEnd)`). */
  capturedStart(handle: number): number {
    return handle + 1;
  }
  capturedEnd(handle: number): number {
    return handle + 1 + (this.st.a[handle] | 0);
  }

  /** The kind (`E_*`/`T_*`) of the element at `index` (for the rare code that peeks at what it wrote last). */
  tagAt(index: number): number {
    return this.st.tag[index] | 0;
  }
  /** The `a` column of the element at `index` (the line mode of an `E_LINE`, ...). */
  argAt(index: number): number {
    return this.st.a[index] | 0;
  }

  // ───────────────────────────── capturing ─────────────────────────────

  /**
   * Starts content that is not part of what is being written (Rust `start_capture`, `intern`, `capture`, `memoized`).
   * Nothing is moved: it stays where it is written, behind an `E_SKIP` that tells whoever reads the pool to skip it.
   * Returns the slot to pass to `endCapture`.
   */
  startCapture(): number {
    const slot = this.st.len;
    this.st.push(E_SKIP, 0, 0, 0);
    this.tracker.startSkipped(slot);
    return slot;
  }

  /**
   * Ends the content that `slot` started. Returns its **handle** (an int; write it any number of times with
   * `writeInterned(handle)`), or -1 if nothing was written.
   */
  endCapture(slot: number): number {
    const st = this.st;
    const len = st.len - slot - 1;
    const tr = this.tracker;
    let flat = 0;
    let willBreak = 0;
    if (tr.endSkipped()) {
      flat = tr.outFlat;
      willBreak = tr.outWillBreak;
    }
    if (len > 0) {
      st.a[slot] = len | 0;
      st.b[slot] = flat | 0;
      st.c[slot] = willBreak | 0;
      return slot;
    }
    st.len = slot;
    return -1;
  }

  /**
   * Writes captured content (Rust `Memoized::fmt`, writing an `Interned`). A capture of a single element is written as
   * that element. A handle of -1 writes nothing.
   */
  writeInterned(handle: number): void {
    if (handle < 0) return;
    const st = this.st;
    const len = st.a[handle] | 0;
    if (len === 1) {
      const i = handle + 1;
      this.push4(st.tag[i] | 0, st.a[i] | 0, st.b[i] | 0, st.c[i] | 0);
    } else {
      this.push4(E_INTERNED, handle, 0, 0);
    }
  }

  /** The number of elements in captured content (for the rare code that needs to know whether it is a single one). */
  capturedLen(handle: number): number {
    return handle < 0 ? 0 : (this.st.a[handle] | 0);
  }

  // ───────────────────────────── best fitting ─────────────────────────────

  /**
   * Starts a variant of a best-fitting (Rust `best_fitting!(a, b, ..)`): a capture that is an entry. Write the variant
   * (calling the same code as for any other content), then `endVariant(slot)` which gives the handle. Variants go from
   * the flattest to the most expanded. Then write `bestFitting2/3/4` or `bestFittingOf(vec)`.
   */
  startVariant(): number {
    const slot = this.startCapture();
    this.push4(T_START_ENTRY, 0, 0, 0);
    return slot;
  }
  endVariant(slot: number): number {
    this.push4(T_END_ENTRY, 0, 0, 0);
    return this.endCapture(slot);
  }

  /** Writes a best-fitting element of the given variants (handles from `endVariant`; at least two). */
  bestFitting2(v0: number, v1: number): void {
    const vs = this.st.variants;
    const first = vs.len;
    vs.push(v0);
    vs.push(v1);
    this.push4(E_BEST_FITTING, first, 2, 0);
  }
  bestFitting3(v0: number, v1: number, v2: number): void {
    const vs = this.st.variants;
    const first = vs.len;
    vs.push(v0);
    vs.push(v1);
    vs.push(v2);
    this.push4(E_BEST_FITTING, first, 3, 0);
  }
  bestFitting4(v0: number, v1: number, v2: number, v3: number): void {
    const vs = this.st.variants;
    const first = vs.len;
    vs.push(v0);
    vs.push(v1);
    vs.push(v2);
    vs.push(v3);
    this.push4(E_BEST_FITTING, first, 4, 0);
  }
  /** Any number (>= 2) of variants, from an I32Vec of handles. */
  bestFittingOf(variants: I32Vec): void {
    const vs = this.st.variants;
    const first = vs.len;
    for (let i = 0; i < variants.len; i++) vs.push(variants.data[i] | 0);
    this.push4(E_BEST_FITTING, first, variants.len, 0);
  }

  // ───────────────────────────── reserved start tags ─────────────────────────────

  /**
   * Keeps a place for a start tag of which it is not known yet whether it is needed, or what it says: that depends on the
   * content, which is written first. Returns what to pass to `groupFrom`. The content starts at the index after it
   * (`slot + 1`, which is what `willBreakFrom` wants).
   */
  reserveTag(): number {
    const reserved = this.st.len;
    this.st.push(E_NOP, 0, 0, 0);
    this.tracker.reserve(reserved);
    return reserved;
  }

  /** Makes what has been written since `reserved` was reserved a group (or leaves it as it is if it is not a reserved place). */
  groupFrom(reserved: number, shouldExpand: boolean): void {
    const st = this.st;
    if ((st.tag[reserved] | 0) === E_NOP) {
      const mode = shouldExpand ? GM_EXPAND : GM_FLAT;
      st.tag[reserved] = T_START_GROUP;
      st.a[reserved] = 0;
      st.b[reserved] = mode << 24;
      st.c[reserved] = 0;
      this.tracker.useReserved(reserved, mode);
      this.push4(T_END_GROUP, 0, 0, 0);
    }
  }

  // ───────────────────────────── vectors ─────────────────────────────

  /** An empty vector of handles, which may have some capacity. Give it back with `recycleVec`. */
  takeVec(): I32Vec {
    const n = this.spare.length;
    if (n > 0) {
      const v = this.spare[n - 1];
      this.spare.length = n - 1;
      return v;
    }
    return new I32Vec(8);
  }
  recycleVec(v: I32Vec): void {
    v.reset();
    this.spare.push(v);
  }

  // ───────────────────────────── without soft line breaks ─────────────────────────────

  /**
   * `write_without_soft_lines(content)`: start with `const slot = f.startCapture()`, write the content, then call this
   * with the slot. It is written as it would be printed if the line were infinitely long: soft line breaks are removed or
   * replaced by spaces, what is written only if a group breaks is removed, and of several variants the flattest is taken.
   */
  endWithoutSoftLines(slot: number): void {
    const written = this.endCapture(slot);
    if (written < 0) return;
    this.conditions.reset();
    this.removeSoftLines(written, VARIANTS_FLATTEST);
  }

  /**
   * `write_with_lines_removed(content)` (Prettier's `removeLines`): the same, but the printer still chooses among the
   * variants, and takes the most expanded one if none fits.
   */
  endWithLinesRemoved(slot: number): void {
    const written = this.endCapture(slot);
    if (written < 0) return;
    this.conditions.reset();
    this.removeSoftLines(written, VARIANTS_ALL);
  }

  /** Writes the elements of the capture `handle` without their soft line breaks. */
  removeSoftLines(handle: number, variants: number): void {
    if (!this.stack.enter()) return;
    const conditions = this.conditions;
    let i = handle + 1;
    const end = i + (this.st.a[handle] | 0);
    while (i < end) {
      const st = this.st;
      const idx = i;
      i = i + 1;
      const t = st.tag[idx] | 0;
      const a = st.a[idx] | 0;
      const b = st.b[idx] | 0;
      const c = st.c[idx] | 0;
      if (t === E_SKIP) {
        i = i + a;
        continue;
      }
      if (t === T_START_COND) {
        conditions.push(b);
        continue;
      }
      if (t === T_END_COND) {
        if (conditions.len > 0) conditions.pop();
        continue;
      }
      if (conditions.len > 0 && conditions.last() === PRINT_EXPANDED) continue;
      if (t === E_TOKEN_IF_BREAKS || t >= TIB_BASE) continue;
      if (t === E_INDENTED_LINE_GROUP) {
        this.push4(T_START_GROUP, a, 0, 0);
        this.push4(T_START_INDENT, 0, 0, 0);
        this.push4(E_SPACE, 0, 0, 0);
        this.push4(T_END_INDENT, 0, 0, 0);
        this.push4(T_END_GROUP, 0, 0, 0);
        continue;
      }
      if ((t === T_START_INDENT_WITH_LINE || t === T_END_INDENT_WITH_LINE) && !lineModeWillBreak(a)) {
        this.push4(t === T_START_INDENT_WITH_LINE ? T_START_INDENT : T_END_INDENT, 0, 0, 0);
        if (a === LM_SOFT_OR_SPACE || a === LM_SOFT_OR_SPACE_EMPTY) this.push4(E_SPACE, 0, 0, 0);
        continue;
      }
      if (t === E_LINE && (a === LM_SOFT || a === LM_SOFT_EMPTY)) continue;
      if (t === E_LINE && (a === LM_SOFT_OR_SPACE || a === LM_SOFT_OR_SPACE_EMPTY)) {
        this.push4(E_SPACE, 0, 0, 0);
        continue;
      }
      if (t === E_INTERNED) {
        const cleaned = this.cleanInterned(a, variants);
        if (cleaned >= 0) this.push4(E_INTERNED, cleaned, 0, 0);
        continue;
      }
      if (t === E_BEST_FITTING && variants === VARIANTS_ALL) {
        const cleanedVariants = this.takeVec();
        for (let k = 0; k < b; k++) {
          const variant = this.st.variants.data[a + k] | 0;
          const slot = this.startCapture();
          this.removeSoftLines(variant, variants);
          cleanedVariants.push(this.endCapture(slot));
        }
        this.bestFittingOf(cleanedVariants);
        this.recycleVec(cleanedVariants);
        continue;
      }
      if (t === E_BEST_FITTING) {
        const flattest = st.variants.data[a] | 0;
        this.removeSoftLines(flattest, variants);
        continue;
      }
      this.push4(t, a, b, c);
    }
    this.stack.leave();
  }

  cleanInterned(handle: number, variants: number): number {
    // What is kept is what has been cleaned the usual way.
    if (variants === VARIANTS_ALL) {
      const slot = this.startCapture();
      this.removeSoftLines(handle, variants);
      return this.endCapture(slot);
    }
    const known = this.cleaned.get(handle);
    if (known !== undefined) return known;
    const st = this.st;
    let needsCleaning = false;
    const from = handle + 1;
    const to = from + (st.a[handle] | 0);
    for (let i = from; i < to; i++) {
      const t = st.tag[i] | 0;
      if (t === E_LINE) {
        const m = st.a[i] | 0;
        if (m === LM_SOFT || m === LM_SOFT_OR_SPACE || m === LM_SOFT_OR_SPACE_EMPTY || m === LM_SOFT_EMPTY) { needsCleaning = true; break; }
      } else if (
        t === E_TOKEN_IF_BREAKS || t >= TIB_BASE || t === E_INDENTED_LINE_GROUP || t === T_START_COND || t === T_END_COND ||
        t === T_START_INDENT_WITH_LINE || t === T_END_INDENT_WITH_LINE || t === E_BEST_FITTING || t === E_INTERNED
      ) {
        needsCleaning = true;
        break;
      }
    }
    let cleaned = handle;
    if (needsCleaning) {
      const slot = this.startCapture();
      this.removeSoftLines(handle, variants);
      cleaned = this.endCapture(slot);
    }
    this.cleaned.set(handle, cleaned);
    // What has been cleaned stays as it is.
    if (cleaned >= 0) this.cleaned.set(cleaned, cleaned);
    return cleaned;
  }

  // ───────────────────────────── embedded formatters ─────────────────────────────

  /**
   * Rust `write_embedded`: starts writing the formatted text of `source`, another text (a script in HTML), to this
   * document. It keeps the elements, the ids of groups and what is known about the groups that are open, so that a
   * forced line break in what is written breaks them. Ranges of the pool stay what they are. `offset`: where `source`
   * starts in the *current* source if it is a part of that (a subarray), else -1. Returns nothing; end with
   * `endEmbedded()`. The language context (`f.context`) is the caller's to save, set and restore.
   */
  beginEmbedded(source: Uint8Array, offset: number): void {
    this.embedSources.push(this.source);
    this.embedState.push(this.st.len);
    this.embedState.push(offset);
    this.source = source;
  }

  /** Ends `beginEmbedded`: the ranges of the inner source that were written become ranges of the outer one. */
  endEmbedded(): void {
    const innerSource = this.source;
    const offset = this.embedState.pop();
    const first = this.embedState.pop();
    this.source = this.embedSources.pop() as Uint8Array;
    const st = this.st;
    let copyAt = -1;
    for (let i = first; i < st.len; i++) {
      if ((st.tag[i] | 0) === E_SOURCE_TEXT) {
        if (offset >= 0) {
          st.a[i] = ((st.a[i] | 0) + offset) | 0;
        } else {
          if (copyAt < 0) {
            copyAt = st.text.len;
            st.text.appendAll(innerSource);
          }
          st.a[i] = ((st.a[i] | 0) + copyAt) | 0;
          st.tag[i] = E_OWNED_TEXT;
        }
      }
    }
  }

  // ───────────────────────────── printing a part ─────────────────────────────

  /**
   * Rust `print_to_text`: appends to `out` the text that the captured content is printed as by itself, at the start of
   * a line without indentation (a line break is `\n`). For the rare case that how something is laid out depends on the text
   * of its parts. Returns false (and appends nothing) if it could not be printed.
   */
  printToText(handle: number, out: ByteBuf): boolean {
    return printCaptureToText(this.st, handle, this.source, this.options, out) >= 0;
  }
}

/**
 * `name` (source[start, end)) with the characters that `a` and `\u{61}` in it stand for, appended to `out`.
 */
export function withoutUnicodeEscapes(src: Uint8Array, start: number, end: number, out: ByteBuf): void {
  let i = start;
  while (i < end) {
    const byte = src[i] | 0;
    i = i + 1;
    if (!(byte === 92 && i < end && (src[i] | 0) === 117)) {
      out.push(byte);
      continue;
    }
    // after the `u`
    i = i + 1;
    let digitsStart: number;
    let digitsEnd: number;
    if (i < end && (src[i] | 0) === 123) {
      digitsStart = i + 1;
      digitsEnd = digitsStart;
      while (digitsEnd < end && (src[digitsEnd] | 0) !== 125) digitsEnd = digitsEnd + 1;
      i = digitsEnd < end ? digitsEnd + 1 : end;
    } else {
      digitsStart = i;
      digitsEnd = i + 4 < end ? i + 4 : end;
      i = digitsEnd;
    }
    let cp = 0;
    let valid = true;
    for (let k = digitsStart; k < digitsEnd; k++) {
      const d = src[k] | 0;
      let v = -1;
      if (d >= 48 && d <= 57) v = d - 48;
      else if (d >= 97 && d <= 102) v = d - 87;
      else if (d >= 65 && d <= 70) v = d - 55;
      if (v < 0) { valid = false; break; }
      cp = cp * 16 + v;
      if (cp > 4294967295) { valid = false; break; }
    }
    if (!valid || cp > 0x10ffff) cp = 0xfffd;
    encodeUtf8(out, cp);
  }
}
