// Port of vendor/bun/src/format/json/document.rs. Tree to document, for a text with comments.
//
// With comments, where a line ends depends on more than widths, so this writes the document that Prettier's printer for
// JavaScript writes (`print/object.js`, `print/array.js`, `print/assignment.js`, `main/comments/print.js`), and leaves the
// rest to the document printer. There is no recursion: a container that is being written is a frame.
//
// It writes straight into a `Storage` (IR_API section 8) and the caller runs `propagateExpand` over it.
import { ByteBuf } from "../../base/bytebuf.ts";
import {
  E_EXPAND_PARENT,
  E_LINE,
  E_LINE_SUFFIX_BOUNDARY,
  E_OWNED_TEXT,
  E_SOURCE_TEXT,
  E_SPACE,
  GM_EXPAND,
  LM_EMPTY,
  LM_HARD,
  LM_SOFT,
  LM_SOFT_OR_SPACE,
  LM_SOFT_OR_SPACE_EMPTY,
  PRINT_EXPANDED,
  T_END_ALIGN,
  T_END_COND,
  T_END_ENTRY,
  T_END_FILL,
  T_END_GROUP,
  T_END_INDENT,
  T_END_LINE_SUFFIX,
  T_START_ALIGN,
  T_START_COND,
  T_START_ENTRY,
  T_START_FILL,
  T_START_GROUP,
  T_START_INDENT,
  T_START_LINE_SUFFIX,
  token,
  twMultiline,
  twSingle,
} from "../ir/element.ts";
import { Storage } from "../ir/storage.ts";
import { stringWidth, textWidth } from "../ir/width.ts";
import { hasNewline, hasNewlineBackwards, isFollowedByEmptyLine, isPreviousLineEmpty, makeString, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import { Config, LE_CRLF, LE_CR } from "./config.ts";
import {
  A_COMMENT,
  A_PLACEMENT,
  P_DANGLING,
  P_LEADING,
  P_TRAILING,
  attached,
} from "./comments.ts";
import {
  BLANK_AFTER,
  BREAK_AFTER_OPEN,
  CONCISE,
  C_BLOCK,
  C_END,
  C_START,
  K_ARRAY,
  K_HOLE,
  K_NUMBER,
  K_OBJECT,
  K_STRING,
  K_TEMPLATE,
  K_UNARY,
  MATRIX,
  N_COUNT,
  N_END,
  N_FLAGS,
  N_KIND,
  N_NEXT,
  N_START,
  OWNER_NONE,
  QUOTED,
  REWRITTEN,
  UNQUOTED,
  Tree,
  ownerNode,
  ownerProperty,
} from "./parser.ts";
import { numBuf, trimmedNumber } from "./util.ts";

const T_COMMA = token(",");
const T_COLON = token(":");
const T_LBRACE = token("{");
const T_RBRACE = token("}");
const T_LBRACKET = token("[");
const T_RBRACKET = token("]");
const T_LPAREN = token("(");
const T_RPAREN = token(")");
const T_SPACE_TOKEN = token(" ");
const T_DQUOTE = token("\"");
const T_SQUOTE = token("'");

// Parent
const PARENT_ROOT = 0;
const PARENT_PROPERTY = 1;
const PARENT_ELEMENT = 2;

// Frame: 8 ints.
const FR_NODE = 0;
const FR_PARENT = 1;
const FR_NAME = 2;
const FR_BREAKS_AFTER_COLON = 3;
const FR_IS_FIRST = 4;
/** The last element or the value of the last property, unless it is a hole (-1). */
const FR_PREVIOUS = 5;

// Comment tests.
const M_ANY = 0;
const M_DANGLING = 1;
const M_DANGLING_LINE = 2;
const M_LEADING_BREAKS_AFTER_COLON = 3;
const M_TRAILING_LINE_SAME_LINE = 4;
const M_LEADING_LINE = 5;
const M_IGNORE = 6;

let frames = new Int32Array(8 * 32);

export class Builder {
  text: Uint8Array = new Uint8Array(0);
  nodes: Int32Array = new Int32Array(0);
  nodeCount: number = 0;
  comments: Int32Array = new Int32Array(0);
  cfg: Config = new Config();
  st: Storage = new Storage(64);
  groupCount: number = 0;

  // ───────────────────────────── elements ─────────────────────────────

  token(handle: number): void {
    this.st.pushToken(handle);
  }

  line(mode: number): void {
    this.st.push(E_LINE, mode, 0, 0);
  }

  tag(kind: number): void {
    this.st.push(kind, 0, 0, 0);
  }

  startGroup(shouldBreak: boolean, id: number): void {
    this.st.push(T_START_GROUP, id, shouldBreak ? GM_EXPAND << 24 : 0, 0);
  }

  /** `,` if the group breaks. `id` 0: the enclosing one. */
  commaIfGroupBreaks(id: number): void {
    this.st.push(T_START_COND, id, PRINT_EXPANDED, 0);
    this.st.pushToken(T_COMMA);
    this.st.push(T_END_COND, 0, 0, 0);
  }

  /** A part of the source. Its line breaks are written as they are, without indentation. */
  source(start: number, end: number): void {
    const len = end > start ? end - start : 0;
    const width = textWidth(this.text, start, start + len, 0, 0);
    this.st.push(E_SOURCE_TEXT, start, len, width);
  }

  /** What is in `st.text` from `start` on, which is on one line. */
  builtFrom(start: number): void {
    const t = this.st.text;
    const len = t.len - start;
    this.st.push(E_OWNED_TEXT, start, len, twSingle(stringWidth(t.data, start, t.len)));
  }

  /**
   * What has a `prettier-ignore` comment, as it is in the source. For Prettier that is a string like any other: its line
   * breaks do not break the groups around it, and all of it counts as being on the line.
   */
  ignored(start: number, end: number): void {
    const t = this.st.text;
    const at = t.len;
    const text = this.text;
    let runStart = start;
    for (let i = start; i < end; i++) {
      if ((text[i] | 0) === 10) {
        t.append(text, runStart, i);
        this.pushLineEnding(t);
        runStart = i + 1;
      }
    }
    t.append(text, runStart, end);
    this.builtFrom(at);
  }

  pushLineEnding(t: ByteBuf): void {
    const le = this.cfg.lineEnding;
    if (le === LE_CRLF) {
      t.push(13);
      t.push(10);
    } else if (le === LE_CR) {
      t.push(13);
    } else {
      t.push(10);
    }
  }

  // ───────────────────────────── comments ─────────────────────────────

  /** Whether every line of a block comment over several lines starts with a `*`. Its lines are indented like the code then. */
  isIndentable(c: number): boolean {
    const text = this.text;
    const cm = this.comments;
    const b = c << 3;
    if ((cm[b + C_BLOCK] | 0) === 0) return false;
    const start = cm[b + C_START] | 0;
    const end = cm[b + C_END] | 0;
    let first = true;
    let sawBreak = false;
    let lineStart = start;
    for (let i = start; i <= end; i++) {
      if (i === end || (text[i] | 0) === 10) {
        if (!first) {
          // line.trim_ascii_start().starts_with("*")
          let k = lineStart;
          while (k < i && isAsciiWs(text[k] | 0)) k = k + 1;
          if (!(k < i && (text[k] | 0) === 42)) return false;
        }
        if (i < end) sawBreak = true;
        first = false;
        lineStart = i + 1;
      }
    }
    return sawBreak;
  }

  /** Prettier's `printComment` */
  writeComment(c: number): void {
    const text = this.text;
    const cm = this.comments;
    const b = c << 3;
    const start = cm[b + C_START] | 0;
    const end = cm[b + C_END] | 0;
    const isBlock = (cm[b + C_BLOCK] | 0) !== 0;
    if (!isBlock) {
      this.source(start, trimAsciiEnd(text, start, end));
      return;
    }
    if (!this.isIndentable(c)) {
      // oxfmt's `write_comment_text`: the first line ends without blanks.
      if (this.cfg.isOxfmt) {
        let nl = -1;
        for (let i = start; i < end; i++) {
          if ((text[i] | 0) === 10) {
            nl = i;
            break;
          }
        }
        if (nl >= 0) {
          this.source(start, trimAsciiEnd(text, start, nl));
          this.source(nl, end);
          return;
        }
      }
      this.source(start, end);
      return;
    }
    const isJsdoc = end - start >= 4 && (text[start] | 0) === 47 && (text[start + 1] | 0) === 42 && (text[start + 2] | 0) === 42 && (text[start + 3] | 0) !== 42;
    let at = start;
    let isFirst = true;
    while (at <= end) {
      // line = text[at, lineEnd)
      let lineEnd = at;
      while (lineEnd < end && (text[lineEnd] | 0) !== 10) lineEnd = lineEnd + 1;
      const lineStart = at;
      const hasMore = lineEnd < end;
      at = lineEnd + 1;
      let blanks = lineStart;
      while (blanks < lineEnd && isAsciiWs(text[blanks] | 0)) blanks = blanks + 1;
      const trimmedEnd = trimAsciiEnd(text, lineStart, lineEnd);
      if (isFirst) {
        isFirst = false;
        this.source(lineStart, trimmedEnd);
      } else {
        this.line(LM_HARD);
        this.token(T_SPACE_TOKEN);
        // trimmed = line.trim_ascii()
        const tStart = blanks;
        const tEnd = trimmedEnd > tStart ? trimmedEnd : tStart;
        this.source(tStart, tEnd);
        // In Markdown, two spaces at the end of a line are a line break. A line break in a text keeps the spaces before
        // it, and the one that follows only indents.
        const isStar = tEnd - tStart === 1 && (text[tStart] | 0) === 42;
        if (
          isJsdoc &&
          !isStar &&
          lineEnd - lineStart >= 2 &&
          (text[lineEnd - 1] | 0) === 32 &&
          (text[lineEnd - 2] | 0) === 32 &&
          hasMore
        ) {
          const ts = this.st.text;
          const s = ts.len;
          ts.push(32);
          ts.push(32);
          ts.push(10);
          this.st.push(E_OWNED_TEXT, s, 3, twMultiline(2));
        }
      }
      if (!hasMore) break;
    }
  }

  /** Whether a comment of `owner` passes `mode`. */
  hasComment(owner: number, mode: number): boolean {
    attached.find(owner);
    const s = attached.sorted;
    const cm = this.comments;
    const text = this.text;
    for (let i = attached.from; i < attached.to; i++) {
      const placement = s[(i << 2) + A_PLACEMENT] | 0;
      const c = s[(i << 2) + A_COMMENT] | 0;
      const b = c << 3;
      const isBlock = (cm[b + C_BLOCK] | 0) !== 0;
      const cStart = cm[b + C_START] | 0;
      const cEnd = cm[b + C_END] | 0;
      switch (mode) {
        case M_ANY:
          return true;
        case M_DANGLING:
          if (placement === P_DANGLING) return true;
          break;
        case M_DANGLING_LINE:
          if (placement === P_DANGLING && !isBlock) return true;
          break;
        case M_LEADING_BREAKS_AFTER_COLON:
          // Prettier's `hasLeadingOwnLineComment`, and a comment whose lines are indented
          if (placement === P_LEADING && (hasNewline(text, cEnd) || this.isIndentable(c))) return true;
          break;
        case M_TRAILING_LINE_SAME_LINE:
          if (placement === P_TRAILING && !isBlock && !hasNewlineBackwards(text, cStart)) return true;
          break;
        case M_LEADING_LINE:
          if (placement === P_LEADING && !isBlock) return true;
          break;
        default: {
          // Prettier's `hasNodeIgnoreComment`
          const e = isBlock ? cEnd - 2 : cEnd;
          const a = trimJsWhitespaceStart(text, cStart + 2, e);
          const z = trimJsWhitespaceEnd(text, a, e);
          if (this.isIgnoreText(a, z)) return true;
        }
      }
    }
    return false;
  }

  isIgnoreText(a: number, z: number): boolean {
    const text = this.text;
    if (z - a === 15 && eqLit(text, a, "prettier-ignore")) return true;
    return this.cfg.isOxfmt && z - a === 12 && eqLit(text, a, "oxfmt-ignore");
  }

  /** Prettier's `hasNodeIgnoreComment` */
  isIgnored(owner: number): boolean {
    return this.hasComment(owner, M_IGNORE);
  }

  /** Prettier's `printLeadingComments`. `ignStart`, `ignEnd`: the span of the owner if it is written as it is in the source (-1: not). */
  leading(owner: number, ignStart: number, ignEnd: number): void {
    attached.find(owner);
    const s = attached.sorted;
    const cm = this.comments;
    const text = this.text;
    for (let i = attached.from; i < attached.to; i++) {
      if ((s[(i << 2) + A_PLACEMENT] | 0) !== P_LEADING) continue;
      const c = s[(i << 2) + A_COMMENT] | 0;
      const b = c << 3;
      const start = cm[b + C_START] | 0;
      const end = cm[b + C_END] | 0;
      if (ignStart >= 0 && start >= ignStart && end <= ignEnd) continue;
      this.writeComment(c);
      if (isFollowedByEmptyLine(text, end)) this.line(LM_EMPTY);
      else if ((cm[b + C_BLOCK] | 0) === 0) this.line(LM_HARD);
      else if (!hasNewline(text, end)) this.st.push(E_SPACE, 0, 0, 0);
      else if (hasNewlineBackwards(text, start)) this.line(LM_HARD);
      else this.line(LM_SOFT_OR_SPACE);
    }
  }

  /** Prettier's `printTrailingComments` */
  trailing(owner: number, ignStart: number, ignEnd: number): void {
    attached.find(owner);
    const s = attached.sorted;
    const cm = this.comments;
    const text = this.text;
    // Of the previous one: whether it is at the end of the line, and whether it is a block. -1: none.
    let hasPrevious = false;
    let prevLineSuffix = false;
    let prevBlock = false;
    const to = attached.to;
    for (let i = attached.from; i < to; i++) {
      if ((s[(i << 2) + A_PLACEMENT] | 0) !== P_TRAILING) continue;
      const c = s[(i << 2) + A_COMMENT] | 0;
      const b = c << 3;
      const start = cm[b + C_START] | 0;
      const end = cm[b + C_END] | 0;
      const isBlock = (cm[b + C_BLOCK] | 0) !== 0;
      const isPrinted = ignStart >= 0 && start >= ignStart && end <= ignEnd;
      const isAfterLineSuffix = hasPrevious && prevLineSuffix;
      const isAfterLineComment = hasPrevious && prevLineSuffix && !prevBlock;

      if (isAfterLineComment || hasNewlineBackwards(text, start)) {
        // On a line of its own, after what it belongs to.
        hasPrevious = true;
        prevLineSuffix = true;
        prevBlock = isBlock;
        if (!isPrinted) {
          this.tag(T_START_LINE_SUFFIX);
          this.line(isPreviousLineEmpty(text, start) ? LM_EMPTY : LM_HARD);
          this.writeComment(c);
          this.tag(T_END_LINE_SUFFIX);
        }
      } else if (!isBlock || isAfterLineSuffix) {
        hasPrevious = true;
        prevLineSuffix = true;
        prevBlock = isBlock;
        if (!isPrinted) {
          this.tag(T_START_LINE_SUFFIX);
          this.st.push(E_SPACE, 0, 0, 0);
          this.writeComment(c);
          this.tag(T_END_LINE_SUFFIX);
          this.st.push(E_EXPAND_PARENT, 0, 0, 0);
        }
      } else {
        hasPrevious = true;
        prevLineSuffix = false;
        prevBlock = true;
        if (!isPrinted) {
          this.st.push(E_SPACE, 0, 0, 0);
          this.writeComment(c);
        }
      }
    }
  }

  /** Prettier's `printDanglingComments` */
  dangling(owner: number): void {
    attached.find(owner);
    const s = attached.sorted;
    let isFirst = true;
    for (let i = attached.from; i < attached.to; i++) {
      if ((s[(i << 2) + A_PLACEMENT] | 0) !== P_DANGLING) continue;
      if (!isFirst) this.line(LM_HARD);
      isFirst = false;
      this.writeComment(s[(i << 2) + A_COMMENT] | 0);
    }
  }

  /** Prettier's `printDanglingCommentsInList` */
  danglingInList(owner: number): void {
    if (!this.hasComment(owner, M_DANGLING)) return;
    this.tag(T_START_INDENT);
    this.line(LM_SOFT);
    this.dangling(owner);
    this.tag(T_END_INDENT);
    this.line(this.hasComment(owner, M_DANGLING_LINE) ? LM_HARD : LM_SOFT);
  }

  // ───────────────────────────── nodes ─────────────────────────────

  /** Anything but an object, an array and a sign, without its comments. */
  scalar(index: number): void {
    const text = this.text;
    const nodes = this.nodes;
    const b = index << 3;
    const kind = nodes[b + N_KIND] | 0;
    const flags = nodes[b + N_FLAGS] | 0;
    const start = nodes[b + N_START] | 0;
    const end = nodes[b + N_END] | 0;
    if (kind === K_STRING && (flags & REWRITTEN) !== 0) {
      const quote = (text[start] | 0) === 34 ? 39 : 34;
      const ts = this.st.text;
      const at = ts.len;
      makeString(text, start + 1, end > start + 1 ? end - 1 : start + 1, quote, ts);
      const len = ts.len - at;
      this.st.push(E_OWNED_TEXT, at, len, textWidth(ts.data, at, ts.len, 0, 0));
    } else if (kind === K_NUMBER && (flags & REWRITTEN) !== 0) {
      const ts = this.st.text;
      const at = ts.len;
      const r = trimmedNumber(text, start, end);
      if (r < 0) ts.append(text, start, end);
      else ts.append(numBuf(), 0, r);
      this.builtFrom(at);
    } else if (kind === K_TEMPLATE) {
      this.st.push(E_LINE_SUFFIX_BOUNDARY, 0, 0, 0);
      this.source(start, end);
    } else {
      this.source(start, end);
    }
  }

  /** Prettier's `printKey` */
  name(index: number): void {
    const nodes = this.nodes;
    const b = index << 3;
    const owner = ownerNode(index);
    const flags = nodes[b + N_FLAGS] | 0;
    if ((flags & UNQUOTED) !== 0) {
      this.leading(owner, -1, -1);
      this.source((nodes[b + N_START] | 0) + 1, (nodes[b + N_END] | 0) - 1);
      this.trailing(owner, -1, -1);
    } else if ((flags & QUOTED) !== 0) {
      this.leading(owner, -1, -1);
      const q = this.cfg.nameQuote === 0 ? T_DQUOTE : T_SQUOTE;
      this.token(q);
      this.scalar(index);
      this.token(q);
      this.trailing(owner, -1, -1);
    } else {
      this.scalarWithComments(index);
    }
  }

  scalarWithComments(index: number): void {
    const nodes = this.nodes;
    const b = index << 3;
    const owner = ownerNode(index);
    const isIgnored = this.isIgnored(owner);
    const start = nodes[b + N_START] | 0;
    const end = nodes[b + N_END] | 0;
    const ignStart = isIgnored ? start : -1;
    const ignEnd = isIgnored ? end : -1;
    this.leading(owner, ignStart, ignEnd);
    if (isIgnored) this.ignored(start, end);
    else this.scalar(index);
    this.trailing(owner, ignStart, ignEnd);
  }

  /** What is written after the value at `index`, and after what is around it. */
  finishValue(index: number, parent: number, name: number, breaksAfterColon: boolean, ignStart: number, ignEnd: number): void {
    this.trailing(ownerNode(index), ignStart, ignEnd);
    this.finishParent(parent, name, breaksAfterColon);
  }

  /** Prettier's `isConciselyPrintedArray`, for an array of numbers. */
  isConcise(array: number, first: number): boolean {
    const nodes = this.nodes;
    const arrayNext = nodes[(array << 3) + N_NEXT] | 0;
    let index = first;
    while (index < arrayNext) {
      if (index >= this.nodeCount) break;
      const b = index << 3;
      const hasCommentOnOperand = (nodes[b + N_KIND] | 0) === K_UNARY && this.hasComment(ownerNode(index + 1), M_ANY);
      const hasLineCommentBehind = this.hasComment(ownerNode(index), M_TRAILING_LINE_SAME_LINE);
      if (hasCommentOnOperand || hasLineCommentBehind) return false;
      index = nodes[b + N_NEXT] | 0;
    }
    return true;
  }

  /** An array of numbers: as many on each line as fit. `index`: of the array. */
  conciseArray(index: number, id: number): void {
    const nodes = this.nodes;
    const arrayNext = nodes[(index << 3) + N_NEXT] | 0;
    this.tag(T_START_FILL);
    let elementIndex = index + 1;
    while (elementIndex < arrayNext && elementIndex < this.nodeCount) {
      const eb = elementIndex << 3;
      const elementNext = nodes[eb + N_NEXT] | 0;
      const isLast = elementNext === arrayNext;
      this.tag(T_START_ENTRY);
      this.signOrScalar(elementIndex);
      if (!isLast) this.token(T_COMMA);
      else if (this.cfg.trailingComma) this.commaIfGroupBreaks(id);
      this.tag(T_END_ENTRY);
      if (!isLast) {
        const hasLeadingLineComment = this.hasComment(ownerNode(elementNext), M_LEADING_LINE);
        this.tag(T_START_ENTRY);
        const blank = ((nodes[eb + N_FLAGS] | 0) & BLANK_AFTER) !== 0;
        this.line(blank ? LM_EMPTY : hasLeadingLineComment ? LM_HARD : LM_SOFT_OR_SPACE);
        this.tag(T_END_ENTRY);
      }
      elementIndex = elementNext;
    }
    this.tag(T_END_FILL);
  }

  /** Anything but an object and an array, with its comments. */
  signOrScalar(index: number): void {
    const nodes = this.nodes;
    const b = index << 3;
    if ((nodes[b + N_KIND] | 0) !== K_UNARY) {
      this.scalarWithComments(index);
      return;
    }
    const owner = ownerNode(index);
    const start = nodes[b + N_START] | 0;
    const end = nodes[b + N_END] | 0;
    const isIgnored = this.isIgnored(owner);
    const ignStart = isIgnored ? start : -1;
    const ignEnd = isIgnored ? end : -1;
    this.leading(owner, ignStart, ignEnd);
    if (isIgnored) {
      this.ignored(start, end);
    } else {
      this.source(start, start + 1);
      // Prettier puts an operand with a comment in parentheses.
      const hasComment = this.hasComment(ownerNode(index + 1), M_ANY);
      if (hasComment) {
        this.startGroup(false, 0);
        this.token(T_LPAREN);
        this.tag(T_START_INDENT);
        this.line(LM_SOFT);
      }
      this.scalarWithComments(index + 1);
      if (hasComment) {
        this.tag(T_END_INDENT);
        this.line(LM_SOFT);
        this.token(T_RPAREN);
        this.tag(T_END_GROUP);
      }
    }
    this.trailing(owner, ignStart, ignEnd);
  }

  closeFrame(fi: number): void {
    const f = frames;
    const nodeIndex = f[fi + FR_NODE] | 0;
    const b = nodeIndex << 3;
    const kind = this.nodes[b + N_KIND] | 0;
    if (kind === K_OBJECT) {
      this.tag(T_END_INDENT);
      if (this.cfg.trailingComma) this.commaIfGroupBreaks(0);
      this.line(this.cfg.bracketSpacing ? LM_SOFT_OR_SPACE : LM_SOFT);
      this.token(T_RBRACE);
    } else {
      if ((f[fi + FR_PREVIOUS] | 0) < 0) {
        // The comma after a hole is what makes it an element.
        this.token(T_COMMA);
      } else if (this.cfg.trailingComma) {
        this.commaIfGroupBreaks(0);
      }
      this.dangling(ownerNode(nodeIndex));
      this.tag(T_END_INDENT);
      this.line(LM_SOFT);
      this.token(T_RBRACKET);
    }
    this.tag(T_END_GROUP);
    this.finishValue(nodeIndex, f[fi + FR_PARENT] | 0, f[fi + FR_NAME] | 0, (f[fi + FR_BREAKS_AFTER_COLON] | 0) !== 0, -1, -1);
  }

  /** All the nodes. */
  values(): void {
    const nodes = this.nodes;
    const nodeCount = this.nodeCount;
    const cfg = this.cfg;
    let depth = 0;
    let index = 0;
    while (true) {
      while (depth > 0) {
        const fi = (depth - 1) << 3;
        const fnode = frames[fi + FR_NODE] | 0;
        if ((nodes[(fnode << 3) + N_NEXT] | 0) !== index) break;
        this.closeFrame(fi);
        depth = depth - 1;
      }
      if (index >= nodeCount) return;

      // What is before the value.
      let parent = PARENT_ROOT;
      let parentName = 0;
      let breaksAfterColon = false;
      if (depth > 0) {
        const fi = (depth - 1) << 3;
        const fnode = frames[fi + FR_NODE] | 0;
        const isObject = (nodes[(fnode << 3) + N_KIND] | 0) === K_OBJECT;
        const previous = frames[fi + FR_PREVIOUS] | 0;
        const isAfterBlank = previous >= 0 && ((nodes[(previous << 3) + N_FLAGS] | 0) & BLANK_AFTER) !== 0;
        if ((frames[fi + FR_IS_FIRST] | 0) === 0) {
          this.token(T_COMMA);
          if (!isAfterBlank) this.line(LM_SOFT_OR_SPACE);
          else if (isObject) this.line(LM_EMPTY);
          else this.line(LM_SOFT_OR_SPACE_EMPTY);
        }
        frames[fi + FR_IS_FIRST] = 0;
        if (!isObject) {
          const isHole = (nodes[(index << 3) + N_KIND] | 0) === K_HOLE;
          frames[fi + FR_PREVIOUS] = isHole ? -1 : index;
          if (isHole) {
            index = index + 1;
            continue;
          }
          parent = PARENT_ELEMENT;
          this.startGroup(false, 0);
        } else {
          const name = index;
          index = index + 1;
          frames[fi + FR_PREVIOUS] = index;
          if (index >= nodeCount) return;
          const property = ownerProperty(name);
          if (this.isIgnored(property)) {
            const span0 = nodes[(name << 3) + N_START] | 0;
            const span1 = nodes[(index << 3) + N_END] | 0;
            this.leading(property, span0, span1);
            this.ignored(span0, span1);
            this.trailing(property, span0, span1);
            index = nodes[(index << 3) + N_NEXT] | 0;
            continue;
          }
          this.leading(property, -1, -1);
          this.startGroup(false, 0);
          this.startGroup(false, 0);
          this.name(name);
          this.tag(T_END_GROUP);
          this.token(T_COLON);
          // Prettier's `hasLeadingOwnLineComment`, and a comment whose lines are indented
          breaksAfterColon = this.hasComment(ownerNode(index), M_LEADING_BREAKS_AFTER_COLON);
          if (breaksAfterColon) {
            this.startGroup(false, 0);
            this.tag(T_START_INDENT);
            this.line(LM_SOFT_OR_SPACE);
          } else {
            this.st.push(E_SPACE, 0, 0, 0);
          }
          parent = PARENT_PROPERTY;
          parentName = name;
        }
      }

      const b = index << 3;
      const kind = nodes[b + N_KIND] | 0;
      const owner = ownerNode(index);
      if (kind !== K_OBJECT && kind !== K_ARRAY) {
        // Its own comments are written with it.
        this.signOrScalar(index);
        this.finishParent(parent, parentName, breaksAfterColon);
        index = nodes[b + N_NEXT] | 0;
        continue;
      }
      if (this.isIgnored(owner)) {
        const span0 = nodes[b + N_START] | 0;
        const span1 = nodes[b + N_END] | 0;
        this.leading(owner, span0, span1);
        this.ignored(span0, span1);
        this.finishValue(index, parent, parentName, breaksAfterColon, span0, span1);
        index = nodes[b + N_NEXT] | 0;
        continue;
      }
      this.leading(owner, -1, -1);
      const isObject = kind === K_OBJECT;
      if ((nodes[b + N_COUNT] | 0) === 0) {
        this.startGroup(false, 0);
        this.token(isObject ? T_LBRACE : T_LBRACKET);
        this.danglingInList(owner);
        this.token(isObject ? T_RBRACE : T_RBRACKET);
        this.tag(T_END_GROUP);
        this.finishValue(index, parent, parentName, breaksAfterColon, -1, -1);
        index = index + 1;
        continue;
      }
      const nflags = nodes[b + N_FLAGS] | 0;
      if (isObject) {
        this.startGroup(cfg.preservesWrap && (nflags & BREAK_AFTER_OPEN) !== 0, 0);
        this.token(T_LBRACE);
        this.tag(T_START_INDENT);
        this.line(cfg.bracketSpacing ? LM_SOFT_OR_SPACE : LM_SOFT);
      } else {
        this.groupCount = this.groupCount + 1;
        const id = this.groupCount;
        this.startGroup((nflags & MATRIX) !== 0 || this.hasComment(owner, M_DANGLING_LINE), id);
        this.token(T_LBRACKET);
        this.tag(T_START_INDENT);
        this.line(LM_SOFT);
        if ((nflags & CONCISE) !== 0 && this.isConcise(index, index + 1)) {
          this.conciseArray(index, id);
          this.dangling(owner);
          this.tag(T_END_INDENT);
          this.line(LM_SOFT);
          this.token(T_RBRACKET);
          this.tag(T_END_GROUP);
          this.finishValue(index, parent, parentName, breaksAfterColon, -1, -1);
          index = nodes[b + N_NEXT] | 0;
          continue;
        }
      }
      if ((depth << 3) + 8 > frames.length) {
        const nf = new Int32Array(frames.length * 2);
        nf.set(frames);
        frames = nf;
      }
      const nfi = depth << 3;
      frames[nfi + FR_NODE] = index | 0;
      frames[nfi + FR_PARENT] = parent | 0;
      frames[nfi + FR_NAME] = parentName | 0;
      frames[nfi + FR_BREAKS_AFTER_COLON] = breaksAfterColon ? 1 : 0;
      frames[nfi + FR_IS_FIRST] = 1;
      frames[nfi + FR_PREVIOUS] = -1;
      depth = depth + 1;
      index = index + 1;
    }
  }

  /** The end of what is around a value. */
  finishParent(parent: number, name: number, breaksAfterColon: boolean): void {
    if (parent === PARENT_ROOT) return;
    if (parent === PARENT_ELEMENT) {
      this.tag(T_END_GROUP);
      return;
    }
    if (breaksAfterColon) {
      this.tag(T_END_INDENT);
      this.tag(T_END_GROUP);
    }
    this.tag(T_END_GROUP);
    this.trailing(ownerProperty(name), -1, -1);
  }
}

function isAsciiWs(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 13 || b === 12;
}

/** The end of text[start, end) without the ASCII white space at its end. */
function trimAsciiEnd(text: Uint8Array, start: number, end: number): number {
  let e = end;
  while (e > start && isAsciiWs(text[e - 1] | 0)) e = e - 1;
  return e;
}

function eqLit(text: Uint8Array, at: number, lit: string): boolean {
  const n = lit.length;
  for (let i = 0; i < n; i++) if ((text[at + i] | 0) !== lit.charCodeAt(i)) return false;
  return true;
}

/** The builder of this thread. */
export const builder = new Builder();

/**
 * Writes the document of `tree` to `st` (cleared first). Returns the end of the root: the document is the elements
 * `[RESERVED, end)`.
 */
export function build(text: Uint8Array, tree: Tree, cfg: Config, st: Storage): number {
  st.clear();
  const bd = builder;
  bd.text = text;
  bd.nodes = tree.nodes;
  bd.nodeCount = tree.nodeCount;
  bd.comments = tree.comments;
  bd.cfg.copyFrom(cfg);
  bd.st = st;
  bd.groupCount = 0;
  // Prettier's `addAlignmentToDoc`. The line break makes the indentation take effect.
  const iw = cfg.indentWidth > 1 ? cfg.indentWidth : 1;
  const levels = (cfg.alignment / iw) | 0;
  const spaces = cfg.alignment % iw;
  if (spaces > 0) st.push(T_START_ALIGN, spaces, 0, 0);
  for (let i = 0; i < levels; i++) bd.tag(T_START_INDENT);
  if (cfg.alignment > 0) bd.line(LM_HARD);
  bd.dangling(OWNER_NONE);
  bd.values();
  bd.line(LM_HARD);
  for (let i = 0; i < levels; i++) bd.tag(T_END_INDENT);
  if (spaces > 0) st.push(T_END_ALIGN, 0, 0, 0);
  return st.len;
}
