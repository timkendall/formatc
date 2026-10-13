// Port of vendor/bun/src/format/toml/printer.rs. Tree to text: `formatter/mod.rs` of oxc-toml, with the options that oxfmt
// leaves as they are taken for granted: nothing is aligned, sorted or indented, an array that fits on the line and has no
// comment is on one line, one that does not fit has an element on each line. One thing is not as in oxc-toml: an inline
// table with a comment has one entry per line. oxc-toml joins the lines, which comments out the rest of the table.
//
// Without an oxfmt config, Bun uses its own layout for arrays and inline tables (see `flat`):
//
// - Each array decides for itself whether it fits on the line. oxc-toml breaks every array of an entry that is too long.
// - An inline table with a line break after its `{` keeps one entry per line.
// - An inline table never gets line breaks it didn't have, because TOML 1.0 parsers reject them. If it's too long, only an
//   array in its last entry breaks: `{ version = "1", features = [` .. `] }`.
// - No empty lines right inside the brackets.
// - `["warn", {` .. `}]`: an array hugs a multi-line table in last position, like Prettier hugs a last-argument object.
//
// A "span" of the Rust code (a range of the text of a comment) is the index of the comment's element here; -1 is `None`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { Stack } from "../../base/stack.ts";
import {
  FORMAT_INVALID_DOCUMENT,
  FORMAT_NESTED_TOO_DEEPLY,
  FORMAT_OK,
  FORMAT_TOO_LONG,
  MAX_STRING_LENGTH,
} from "../errors.ts";
import { FLAVOR_OXFMT, INDENT_TAB, LINE_ENDING_CRLF, TRAILING_COMMAS_NONE, FormatOptions } from "../options.ts";
import {
  K_ARRAY,
  K_CLOSE,
  K_COMMA,
  K_COMMENT,
  K_ENTRY,
  K_HEADER,
  K_INLINE_TABLE,
  K_KEY,
  K_LINE_BREAKS,
  K_OPEN,
  K_TEXT,
  K_VALUE,
} from "./tree.ts";

/** `allowed_blank_lines` */
const MAX_EMPTY_LINES = 2;

/** `flat` of something that can't be on one line. */
const NOT_FLAT = 0x3fffffff;

function satAdd(a: number, b: number): number {
  const s = a + b;
  return s > NOT_FLAT ? NOT_FLAT : s;
}

class Ctx {
  indentLevel: number;
  forceMultiline: boolean;
  /** Width of what comes before the value on its first line but isn't in the output buffer: `key = `. */
  before: number;
  /** Width of what follows the value on its last line, like a comma. */
  after: number;
  /** More entries follow on this line, so an array that could break stays on it even if it's too long. */
  keepsFlat: boolean;
  constructor(indentLevel: number, forceMultiline: boolean, before: number, after: number, keepsFlat: boolean) {
    this.indentLevel = indentLevel;
    this.forceMultiline = forceMultiline;
    this.before = before;
    this.after = after;
    this.keepsFlat = keepsFlat;
  }
}

/** `str::chars().count()` of data[start, end) */
function chars(data: Uint8Array, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) if (((data[i] | 0) & 0xc0) !== 0x80) n = n + 1;
  return n;
}

function endsWithBytes(data: Uint8Array, len: number, a: number, b: number): boolean {
  return len >= 2 && (data[len - 2] | 0) === a && (data[len - 1] | 0) === b;
}

export class TomlPrinter {
  text: Uint8Array = new Uint8Array(0);
  el: Int32Array = new Int32Array(0);
  elCount: number = 0;
  columnWidth: number = 80;
  isTab: boolean = false;
  indentWidth: number = 2;
  crlf: boolean = false;
  arrayTrailingComma: boolean = true;
  /** For each element, how many of those before it are line breaks, and how many are comments. */
  breaksBefore: Int32Array = new Int32Array(0);
  commentsBefore: Int32Array = new Int32Array(0);
  /** Bun's own layout: the width of each element when it's printed on one line, or `NOT_FLAT`. Empty with an oxfmt config. */
  flat: Int32Array = new Int32Array(0);
  hasFlat: boolean = false;
  /** How many comments have been written. */
  writtenComments: number = 0;
  stack: Stack = Stack.create();
  /** Why what has been written is of no use (a `FORMAT_*` code), 0 if nothing is. */
  failure: number = 0;

  // The entries that are written when it is known what follows them.
  pk: ByteBuf = new ByteBuf(256);
  pv: ByteBuf = new ByteBuf(256);
  eKeyEnd: Int32Array = new Int32Array(16);
  eValEnd: Int32Array = new Int32Array(16);
  eValueNode: Int32Array = new Int32Array(16);
  eComment: Int32Array = new Int32Array(16);
  ne: number = 0;
  tmp: ByteBuf = new ByteBuf(256);
  tmp2: ByteBuf = new ByteBuf(256);
  pendingComments: Int32Array = new Int32Array(16);
  nc: number = 0;

  textOf(e: number): number {
    return e;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  elKind(i: number): number {
    return this.el[i << 2] | 0;
  }
  elStart(i: number): number {
    return this.el[(i << 2) + 1] | 0;
  }
  elEnd(i: number): number {
    return this.el[(i << 2) + 2] | 0;
  }
  elNext(i: number): number {
    return this.el[(i << 2) + 3] | 0;
  }

  appendElement(i: number, out: ByteBuf): void {
    out.append(this.text, this.elStart(i), this.elEnd(i));
  }

  /** `starts_on_new_line`: the first thing after the `{` of the inline table at `node` is a line break. */
  startsOnNewLine(node: number): boolean {
    // `node + 1` is the `{`.
    return node + 2 < this.elCount && this.elKind(node + 2) === K_LINE_BREAKS;
  }

  /** Computes `flat`. Children come after their parent, so going backwards visits them first. */
  measure(): void {
    const n = this.elCount;
    if (this.flat.length < n) this.flat = new Int32Array(n * 2);
    const flat = this.flat;
    const t = this.text;
    for (let index = n - 1; index >= 0; index--) {
      const kind = this.elKind(index);
      const next = this.elNext(index);
      let sum = 0;
      let items = 0;
      // The sum of the children's, and the number of items among them.
      if (kind === K_KEY || kind === K_VALUE || kind === K_ENTRY || kind === K_ARRAY || kind === K_INLINE_TABLE) {
        for (let c = index + 1; c < next; c = this.elNext(c)) {
          sum = satAdd(sum, flat[c] | 0);
          const ck = this.elKind(c);
          if (ck === K_VALUE || ck === K_ENTRY) items = items + 1;
        }
      }
      let w: number;
      switch (kind) {
        case K_COMMENT:
          w = NOT_FLAT;
          break;
        case K_LINE_BREAKS:
        case K_COMMA:
        case K_HEADER:
          w = 0;
          break;
        case K_TEXT:
        case K_OPEN:
        case K_CLOSE: {
          const s = this.elStart(index);
          const e = this.elEnd(index);
          let hasNewline = false;
          for (let i = s; i < e; i++) {
            if ((t[i] | 0) === 10) {
              hasNewline = true;
              break;
            }
          }
          w = hasNewline ? NOT_FLAT : chars(t, s, e);
          break;
        }
        case K_KEY:
        case K_VALUE:
          w = sum;
          break;
        // ` = `
        case K_ENTRY:
          w = satAdd(sum, 3);
          break;
        // `, ` between the items.
        case K_ARRAY:
          w = satAdd(sum, 2 * (items > 0 ? items - 1 : 0));
          break;
        default:
          // An inline table
          if (items === 0) w = sum;
          else if (this.startsOnNewLine(index)) w = NOT_FLAT;
          // And a blank inside each brace.
          else w = satAdd(sum, 2 * items);
      }
      flat[index] = w | 0;
    }
  }

  /** Whether there are both line breaks and comments in `node`. */
  hasLineBreaksAndComments(node: number): boolean {
    const f = node + 1;
    const to = this.elNext(node);
    return (this.breaksBefore[f] | 0) < (this.breaksBefore[to] | 0) && (this.commentsBefore[f] | 0) < (this.commentsBefore[to] | 0);
  }

  hasChild(node: number, kind: number): boolean {
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) if (this.elKind(c) === kind) return true;
    return false;
  }

  /** The inline table or array that is the value at `node`, if it is one (its index), else -1. */
  containerIn(node: number): number {
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) {
      const k = this.elKind(c);
      if (k === K_ARRAY || k === K_INLINE_TABLE) return c;
    }
    return -1;
  }

  /** The column that the next byte of `out` is written at. */
  column(ctx: Ctx, out: ByteBuf): number {
    const d = out.data;
    for (let i = out.len - 1; i >= 0; i--) {
      if ((d[i] | 0) === 10) return chars(d, i + 1, out.len);
    }
    return ctx.before + chars(d, 0, out.len);
  }

  /** Bun's layout: returns true if `node` fits on the rest of the line. */
  fits(node: number, ctx: Ctx, out: ByteBuf): boolean {
    const flat = this.hasFlat ? this.flat[node] | 0 : NOT_FLAT;
    return flat !== NOT_FLAT && this.column(ctx, out) + flat + ctx.after <= this.columnWidth;
  }

  isCommentedValue(index: number): boolean {
    return this.elKind(index) === K_VALUE && this.hasChild(index, K_COMMENT);
  }

  /** Returns true if a comment belongs to the array or inline table at `node` itself, not to something nested in it. */
  hasOwnComment(node: number): boolean {
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) {
      const k = this.elKind(c);
      if (k === K_COMMENT) return true;
      if (k === K_ENTRY) {
        const en = this.elNext(c);
        for (let d = c + 1; d < en; d = this.elNext(d)) if (this.isCommentedValue(d)) return true;
      } else if (this.isCommentedValue(c)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Bun's layout: returns true if the inline table at `node` gets one entry per line. It needs a line break of its own for
   * that, which means the file already requires a TOML 1.1 parser.
   */
  expands(node: number, ctx: Ctx, out: ByteBuf): boolean {
    return (
      this.hasFlat &&
      this.hasChild(node, K_LINE_BREAKS) &&
      (this.startsOnNewLine(node) || this.hasOwnComment(node) || !this.fits(node, ctx, out))
    );
  }

  /**
   * Bun's layout: returns true if the array at `node`, which doesn't fit on the line, hugs its last value, a multi-line
   * table: `["warn", {` .. `}]`. The values before it have to be plain and fit on the first line.
   */
  hugsLastValue(node: number, ctx: Ctx, out: ByteBuf): boolean {
    if (!this.hasFlat) return false;
    let last = -1;
    let head = 0;
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) {
      const k = this.elKind(c);
      if (k === K_COMMENT) return false;
      if (k === K_VALUE) {
        if (last >= 0) {
          if ((this.flat[last] | 0) === NOT_FLAT || this.containerIn(last) >= 0) return false;
          head = head + (this.flat[last] | 0) + 2;
        }
        last = c;
      }
    }
    if (last < 0) return false;
    const container = this.containerIn(last);
    if (container < 0) return false;
    if (!(this.elKind(container) === K_INLINE_TABLE && this.hasChild(container, K_LINE_BREAKS))) return false;
    // `[` and `{`
    return this.column(ctx, out) + head + 2 <= this.columnWidth;
  }

  lineBreaks(e: number): number {
    let n = 0;
    const s = this.elStart(e);
    const en = this.elEnd(e);
    for (let i = s; i < en; i++) if ((this.text[i] | 0) === 10) n = n + 1;
    return n;
  }

  pushNewline(out: ByteBuf): void {
    if (this.crlf) {
      out.push(13);
      out.push(10);
    } else {
      out.push(10);
    }
  }

  /** `Options::newlines` */
  writeNewlines(count: number, out: ByteBuf): void {
    const k = count < MAX_EMPTY_LINES + 1 ? count : MAX_EMPTY_LINES + 1;
    for (let i = 0; i < k; i++) this.pushNewline(out);
  }

  writeIndent(ctx: Ctx, out: ByteBuf): void {
    if (out.len > MAX_STRING_LENGTH) this.failure = FORMAT_TOO_LONG;
    if (this.failure !== 0) return;
    for (let i = 0; i < ctx.indentLevel; i++) {
      if (this.isTab) out.push(9);
      else out.fill(32, this.indentWidth);
    }
  }

  writeComment(e: number, out: ByteBuf): void {
    this.appendElement(e, out);
    this.writtenComments = this.writtenComments + 1;
  }

  // ───────────────────────────── root ─────────────────────────────

  /** `format_root` */
  root(out: ByteBuf): void {
    const ctx = new Ctx(0, false, 0, 0, false);
    // Entries and comments are written when it is known what follows them. The line break behind each is passed over, or it
    // would be before them.
    this.ne = 0;
    this.pk.reset();
    this.pv.reset();
    this.nc = 0;
    let skipNewlines = 0;
    const n = this.elCount;
    for (let index = 0; index < n; index = this.elNext(index)) {
      const kind = this.elKind(index);
      if (kind === K_HEADER) {
        if (this.addEntries(out)) {
          this.pushNewline(out);
          skipNewlines = 0;
        }
        if (this.addComments(out)) {
          this.pushNewline(out);
          skipNewlines = 0;
        }
        const comment = this.tableHeader(index, out);
        if (comment >= 0) {
          out.push(32);
          this.writeComment(comment, out);
        }
      } else if (kind === K_ENTRY) {
        if (this.addComments(out)) {
          this.pushNewline(out);
          skipNewlines = 0;
        }
        this.entry(index, ctx);
        skipNewlines = skipNewlines + 1;
      } else if (kind === K_LINE_BREAKS) {
        const count = this.lineBreaks(index);
        if (count > 1) {
          this.addComments(out);
          this.addEntries(out);
          skipNewlines = 0;
        }
        this.writeNewlines(count > skipNewlines ? count - skipNewlines : 0, out);
      } else if (kind === K_COMMENT) {
        if (this.addEntries(out)) {
          this.pushNewline(out);
          skipNewlines = 0;
        }
        this.pushComment(index);
        skipNewlines = skipNewlines + 1;
      }
    }
    this.addComments(out);
    this.addEntries(out);
  }

  pushComment(e: number): void {
    if (this.nc === this.pendingComments.length) {
      const np = new Int32Array(this.nc * 2);
      np.set(this.pendingComments);
      this.pendingComments = np;
    }
    this.pendingComments[this.nc] = e | 0;
    this.nc = this.nc + 1;
  }

  /** Returns whether there were any. */
  addComments(out: ByteBuf): boolean {
    for (let i = 0; i < this.nc; i++) {
      if (i !== 0) this.pushNewline(out);
      this.writeComment(this.pendingComments[i] | 0, out);
    }
    const were = this.nc > 0;
    this.nc = 0;
    return were;
  }

  /** Whether a line of entry `i` is longer than the lines are to be. `value`: the bytes of its value. */
  isTooLong(i: number, value: Uint8Array, vs: number, ve: number): boolean {
    const ks = i === 0 ? 0 : this.eKeyEnd[i - 1] | 0;
    const ke = this.eKeyEnd[i] | 0;
    // With the blank before it.
    const c = this.eComment[i] | 0;
    const comment = c < 0 ? 0 : chars(this.text, this.elStart(c), this.elEnd(c)) + 1;
    let last = 0;
    for (let k = vs; k < ve; k++) if ((value[k] | 0) === 10) last = last + 1;
    let lineStart = vs;
    let index = 0;
    while (true) {
      let lineEnd = lineStart;
      while (lineEnd < ve && (value[lineEnd] | 0) !== 10) lineEnd = lineEnd + 1;
      const before = index === 0 ? chars(this.pk.data, ks, ke) + 3 : 0;
      const after = index === last ? comment : 0;
      if (before + chars(value, lineStart, lineEnd) + after > this.columnWidth) return true;
      if (lineEnd >= ve) break;
      lineStart = lineEnd + 1;
      index = index + 1;
    }
    return false;
  }

  /** Returns whether there were any. */
  addEntries(out: ByteBuf): boolean {
    const were = this.ne > 0;
    for (let i = 0; i < this.ne; i++) {
      const vs = i === 0 ? 0 : this.eValEnd[i - 1] | 0;
      const ve = this.eValEnd[i] | 0;
      let valueData = this.pv.data;
      let valueStart = vs;
      let valueEnd = ve;
      let comment = this.eComment[i] | 0;
      // In Bun's layout every array has already decided for itself.
      if (!this.hasFlat && this.isTooLong(i, valueData, vs, ve)) {
        const ctx = new Ctx(0, true, 0, 0, false);
        this.tmp2.reset();
        const c = this.value(this.eValueNode[i] | 0, ctx, this.tmp2);
        if (c >= 0) comment = c;
        valueData = this.tmp2.data;
        valueStart = 0;
        valueEnd = this.tmp2.len;
      }
      if (i !== 0) this.pushNewline(out);
      // write_entry
      out.append(this.pk.data, i === 0 ? 0 : this.eKeyEnd[i - 1] | 0, this.eKeyEnd[i] | 0);
      out.push(32);
      out.push(61);
      out.push(32);
      out.append(valueData, valueStart, valueEnd);
      if (comment >= 0) {
        out.push(32);
        this.writeComment(comment, out);
      }
    }
    this.ne = 0;
    this.pk.reset();
    this.pv.reset();
    return were;
  }

  /** `format_entry` */
  entry(node: number, ctx: Ctx): void {
    const i = this.ne;
    if (i === this.eKeyEnd.length) {
      this.eKeyEnd = grow(this.eKeyEnd);
      this.eValEnd = grow(this.eValEnd);
      this.eValueNode = grow(this.eValueNode);
      this.eComment = grow(this.eComment);
    }
    let valueNode = node;
    let comment = -1;
    const keyStart = this.pk.len;
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) {
      const k = this.elKind(c);
      let cm = -1;
      if (k === K_KEY) {
        this.key(c, this.pk);
      } else if (k === K_VALUE) {
        valueNode = c;
        const ctx2 = new Ctx(ctx.indentLevel, ctx.forceMultiline, chars(this.pk.data, keyStart, this.pk.len) + 3, ctx.after, ctx.keepsFlat);
        this.tmp.reset();
        cm = this.value(c, ctx2, this.tmp);
        this.pv.append(this.tmp.data, 0, this.tmp.len);
      } else if (k === K_COMMENT) {
        cm = c;
      }
      // Only the first.
      if (comment < 0) comment = cm;
    }
    this.eKeyEnd[i] = this.pk.len;
    this.eValEnd[i] = this.pv.len;
    this.eValueNode[i] = valueNode;
    this.eComment[i] = comment;
    this.ne = i + 1;
  }

  /** What `write_entry` writes for the `entry` of `node`, which is in an inline table. */
  entryInPlace(node: number, ctx: Ctx, out: ByteBuf): void {
    const comment = this.entryWithoutComment(node, ctx, out);
    if (comment >= 0) {
      out.push(32);
      this.writeComment(comment, out);
    }
  }

  /** Writes `key = value` of the entry at `node`. Returns the comment behind it. */
  entryWithoutComment(node: number, ctx: Ctx, out: ByteBuf): number {
    let first = -1;
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) {
      const k = this.elKind(c);
      let cm = -1;
      if (k === K_KEY) {
        this.key(c, out);
        out.push(32);
        out.push(61);
        out.push(32);
      } else if (k === K_VALUE) {
        cm = this.value(c, ctx, out);
      } else if (k === K_COMMENT) {
        cm = c;
      }
      if (first < 0) first = cm;
    }
    return first;
  }

  /** `format_key`: names and periods without white space. */
  key(node: number, out: ByteBuf): void {
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) this.appendElement(c, out);
  }

  /** `format_value`. Returns the comment behind the value. */
  value(node: number, ctx: Ctx, out: ByteBuf): number {
    if (!this.stack.enter()) this.failure = FORMAT_NESTED_TOO_DEEPLY;
    else this.stack.leave();
    if (this.failure !== 0) return -1;
    let comment = -1;
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) {
      const k = this.elKind(c);
      if (k === K_ARRAY) {
        if (this.stack.enter()) {
          this.array(c, ctx, out);
          this.stack.leave();
        } else {
          this.failure = FORMAT_NESTED_TOO_DEEPLY;
        }
      } else if (k === K_INLINE_TABLE) {
        if (this.stack.enter()) {
          this.inlineTable(c, ctx, out);
          this.stack.leave();
        } else {
          this.failure = FORMAT_NESTED_TOO_DEEPLY;
        }
      } else if (k === K_COMMENT) {
        comment = c;
      } else {
        this.appendElement(c, out);
      }
    }
    return comment;
  }

  /** `format_inline_table` */
  inlineTable(node: number, ctx: Ctx, out: ByteBuf): void {
    const expands = this.hasFlat ? this.expands(node, ctx, out) : this.hasOwnComment(node);
    if (expands && (this.hasChild(node, K_ENTRY) || this.hasChild(node, K_COMMENT))) {
      this.list(node, ctx, true, out);
      return;
    }
    if (!this.hasChild(node, K_ENTRY)) {
      out.push(123);
      out.push(125);
      return;
    }
    // ` }`
    const base = new Ctx(ctx.indentLevel, ctx.forceMultiline, ctx.before, ctx.after + 2, ctx.keepsFlat);
    let lastEntry = -1;
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) if (this.elKind(c) === K_ENTRY) lastEntry = c;
    let isFirst = true;
    let isAfterComment = false;
    for (let c = node + 1; c < next; c = this.elNext(c)) {
      const k = this.elKind(c);
      if (k === K_ENTRY) {
        if (!isFirst) {
          out.push(44);
          out.push(32);
        } else if (isAfterComment) {
          out.push(32);
        }
        const ctx2 = new Ctx(base.indentLevel, base.forceMultiline, base.before, base.after, base.keepsFlat || c !== lastEntry);
        this.entryInPlace(c, ctx2, out);
        isFirst = false;
        isAfterComment = false;
      } else if (k === K_OPEN) {
        out.push(123);
        out.push(32);
      } else if (k === K_CLOSE) {
        out.push(32);
        out.push(125);
      } else if (k === K_COMMENT) {
        const l = out.len > 0 ? out.data[out.len - 1] | 0 : -1;
        if (l !== 32 && l !== 123) out.push(32);
        this.writeComment(c, out);
        isAfterComment = true;
      }
    }
  }

  array(node: number, ctx: Ctx, out: ByteBuf): void {
    let isMultiline: boolean;
    if (this.hasFlat) {
      // Breaking doesn't help a line that is too long before the array starts.
      const stays = (this.flat[node] | 0) !== NOT_FLAT && (ctx.keepsFlat || this.column(ctx, out) >= this.columnWidth);
      isMultiline = !stays && !this.fits(node, ctx, out) && !this.hugsLastValue(node, ctx, out);
    } else {
      isMultiline = ctx.forceMultiline || this.hasLineBreaksAndComments(node);
    }
    this.list(node, ctx, isMultiline, out);
  }

  /** Writes the comment behind the last value (`comment`, an element) if the list is on several lines. */
  flushComment(comment: number, isMultiline: boolean, out: ByteBuf): void {
    if (comment >= 0 && isMultiline) {
      out.push(32);
      this.writeComment(comment, out);
    }
  }

  /** `format_array`. Also for an inline table with one entry per line. */
  list(node: number, ctx: Ctx, isMultiline: boolean, out: ByteBuf): void {
    const isTable = this.elKind(node) === K_INLINE_TABLE;
    const open = isTable ? 123 : 91;
    const close = isTable ? 125 : 93;
    // The context of the values: inner if on several lines.
    const inner = isMultiline ? new Ctx(ctx.indentLevel + 1, ctx.forceMultiline, ctx.before, 1, false) : null;
    // On one line, the `]` follows the last value.
    const ofValues = inner !== null ? inner : new Ctx(ctx.indentLevel, ctx.forceMultiline, ctx.before, ctx.after + 1, ctx.keepsFlat);
    let valueCount = 0;
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) {
      const k = this.elKind(c);
      if (k === K_VALUE || k === K_ENTRY) valueCount = valueCount + 1;
    }

    // oxc-toml keeps the values as `root` keeps the entries, and adds them when it is known what follows them. Here a value is
    // written at once, or what is in `n` arrays would be copied `n` times. Only the comment behind the last value depends on
    // what follows. `values`: how many oxc-toml would be keeping.
    let values = 0;
    let commentBehindLast = -1;
    let skipNewlines = 0;
    let valueIndex = 0;
    let previous = K_OPEN;
    for (let index = node + 1; index < next; index = this.elNext(index)) {
      const kind = this.elKind(index);
      if (kind === K_VALUE || kind === K_ENTRY) {
        if (isMultiline && out.len > 0 && (out.data[out.len - 1] | 0) === open) this.pushNewline(out);
        this.flushComment(commentBehindLast, isMultiline, out);
        commentBehindLast = -1;
        if (inner === null) {
          // On one line.
          if (values !== 0) out.push(32);
        } else {
          if (values !== 0) this.pushNewline(out);
          this.writeIndent(inner, out);
        }
        commentBehindLast = kind === K_ENTRY ? this.entryWithoutComment(index, ofValues, out) : this.value(index, ofValues, out);
        valueIndex = valueIndex + 1;
        if (valueIndex < valueCount || (isMultiline && this.arrayTrailingComma)) out.push(44);
        values = values + 1;
        skipNewlines = skipNewlines + 1;
      } else if (kind === K_OPEN) {
        out.push(open);
      } else if (kind === K_CLOSE) {
        this.flushComment(commentBehindLast, isMultiline, out);
        commentBehindLast = -1;
        values = 0;
        if (isMultiline) {
          if (out.len === 0 || (out.data[out.len - 1] | 0) !== 10) this.pushNewline(out);
          // Bun's layout has no empty lines before the closing bracket.
          while (this.hasFlat && this.endsWithEmptyLine(out)) out.len = out.len - (this.crlf ? 2 : 1);
          this.writeIndent(ctx, out);
        }
        out.push(close);
      } else if (kind === K_LINE_BREAKS && this.hasFlat && previous === K_OPEN) {
        // Bun's layout has no empty lines after the opening bracket.
        if (isMultiline) this.pushNewline(out);
      } else if (kind === K_LINE_BREAKS && isMultiline) {
        const count = this.lineBreaks(index);
        if (count > 1) {
          this.flushComment(commentBehindLast, isMultiline, out);
          commentBehindLast = -1;
          values = 0;
          skipNewlines = 0;
        }
        this.writeNewlines(count > skipNewlines ? count - skipNewlines : 0, out);
      } else if (kind === K_COMMENT) {
        // It is behind the last value, on its line.
        if (values !== 0 && previous !== K_LINE_BREAKS) {
          commentBehindLast = index;
        } else {
          this.flushComment(commentBehindLast, isMultiline, out);
          commentBehindLast = -1;
          const had = values !== 0;
          values = 0;
          if (had) {
            this.pushNewline(out);
            skipNewlines = 0;
          }
          if (out.len > 0 && (out.data[out.len - 1] | 0) === open) out.push(32);
          else this.writeIndent(ofValues, out);
          this.writeComment(index, out);
        }
      }
      previous = kind;
    }
  }

  /** `out.ends_with(newline + newline)` */
  endsWithEmptyLine(out: ByteBuf): boolean {
    const d = out.data;
    const l = out.len;
    if (this.crlf) return l >= 4 && endsWithBytes(d, l, 13, 10) && endsWithBytes(d, l - 2, 13, 10);
    return l >= 2 && (d[l - 1] | 0) === 10 && (d[l - 2] | 0) === 10;
  }

  /** `format_table_header`. Returns the comment behind it. */
  tableHeader(node: number, out: ByteBuf): number {
    let comment = -1;
    const next = this.elNext(node);
    for (let c = node + 1; c < next; c = this.elNext(c)) {
      const k = this.elKind(c);
      if (k === K_KEY) this.key(c, out);
      else if (k === K_COMMENT) comment = c;
      else this.appendElement(c, out);
    }
    return comment;
  }
}

function grow(a: Int32Array): Int32Array {
  const b = new Int32Array(a.length * 2);
  b.set(a);
  return b;
}

const printer = new TomlPrinter();

/**
 * Appends the document to `out`. `el`, `count`: the tree. Returns `FORMAT_OK` or a `FORMAT_*` error (then `out` is as it
 * was).
 */
export function printToml(text: Uint8Array, len: number, el: Int32Array, count: number, options: FormatOptions, out: ByteBuf): number {
  const p = printer;
  p.text = text;
  p.el = el;
  p.elCount = count;
  // For each element, how many of those before it are line breaks, and how many are comments.
  if (p.breaksBefore.length < count + 1) {
    p.breaksBefore = new Int32Array((count + 1) * 2);
    p.commentsBefore = new Int32Array((count + 1) * 2);
  }
  let breaks = 0;
  let comments = 0;
  p.breaksBefore[0] = 0;
  p.commentsBefore[0] = 0;
  for (let i = 0; i < count; i++) {
    const k = el[i << 2] | 0;
    if (k === K_LINE_BREAKS) breaks = breaks + 1;
    if (k === K_COMMENT) comments = comments + 1;
    p.breaksBefore[i + 1] = breaks;
    p.commentsBefore[i + 1] = comments;
  }
  p.columnWidth = options.lineWidth;
  p.isTab = options.indentStyle === INDENT_TAB;
  p.indentWidth = options.indentWidth;
  p.crlf = options.lineEnding === LINE_ENDING_CRLF;
  p.arrayTrailingComma = options.trailingCommas !== TRAILING_COMMAS_NONE;
  p.hasFlat = options.flavor !== FLAVOR_OXFMT;
  p.writtenComments = 0;
  p.stack.reset();
  p.failure = 0;
  if (p.hasFlat) p.measure();
  const start = out.len;
  out.reserve(len);
  p.root(out);
  if (p.failure !== 0) {
    out.len = start;
    return p.failure;
  }
  // Losing a comment doesn't change the parsed value, so the caller's check wouldn't notice.
  if (p.hasFlat && p.writtenComments !== comments) {
    out.len = start;
    return FORMAT_INVALID_DOCUMENT;
  }
  const d = out.data;
  if (out.len - start >= 2 && (d[out.len - 2] | 0) === 13 && (d[out.len - 1] | 0) === 10) out.len = out.len - 2;
  else if (out.len - start >= 1 && (d[out.len - 1] | 0) === 10) out.len = out.len - 1;
  p.pushNewline(out);
  return FORMAT_OK;
}
