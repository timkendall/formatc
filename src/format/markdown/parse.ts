// Port of vendor/bun/src/format/markdown/parse.rs: the syntax tree from the events of `bun_md`, Bun's Markdown parser.
//
// The parser says what the blocks are and where their lines and markers are. Where a node starts and ends in mdast is worked
// out here: micromark and mdast-util-from-markdown have their ways with line breaks and white space at the ends of
// containers.
//
// Rust -> TS: `Builder` is a `Renderer` subclass; `MdExt` is the `Extensions` subclass (`leaf` / `span` with the memos that the
// Rust closures keep in `Cell`s). A `Str` is a handle of the tree's string table (ast.ts). Vectors of structs are `I32Vec`s of
// triples/pairs. Positions are absolute indices into the whole text (`Builder.src`); `base` is where the parsed part starts.
import { ByteBuf } from "../../base/bytebuf.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { Options } from "../../md/options.ts";
import { Extensions, Renderer, SpanDetail, Definition } from "../../md/types.ts";
import type { Parser } from "../../md/state.ts";
import { startsContainerInParagraph } from "../../md/line_analysis.ts";
import { renderWithExtensions } from "../../md/root.ts";
import {
  BLOCK_CLOSED,
  BLOCK_DIRECTIVE,
  BLOCK_EXTENSION,
  BLOCK_FENCED_CODE,
  BLOCK_FOOTNOTE,
  BLOCK_HTML_UNTIL_TEXT,
  BLOCK_SETEXT_HEADER,
  BT_CODE,
  BT_DOC,
  BT_H,
  BT_HR,
  BT_HTML,
  BT_LI,
  BT_OL,
  BT_P,
  BT_QUOTE,
  BT_TABLE,
  BT_TBODY,
  BT_TD,
  BT_TH,
  BT_THEAD,
  BT_TR,
  BT_UL,
  OFF_MAX,
  REF_COLLAPSED,
  REF_FOOTNOTE,
  REF_FULL,
  REF_NONE,
  SP_A,
  SP_CODE,
  SP_DEL,
  SP_EM,
  SP_IMG,
  SP_LATEXMATH,
  SP_LATEXMATH_DISPLAY,
  SP_STRONG,
  SP_U,
  SP_WIKILINK,
  TX_BR,
  TX_CODE,
  TX_ENTITY,
  TX_HTML,
  TX_LATEXMATH,
  TX_NORMAL,
  TX_NULLCHAR,
  TX_SOFTBR,
} from "../../md/types.ts";
import { parseFrontMatter } from "../front_matter.ts";
import { jsWhitespaceLen as jsWsLen, jsWhitespaceLenBack as jsWsLenBack } from "../text.ts";
import {
  ALIGN_CENTER,
  ALIGN_LEFT,
  ALIGN_NONE,
  ALIGN_RIGHT,
  F_ORDERED,
  F_SPREAD,
  K_BLOCKQUOTE,
  K_BREAK,
  K_CODE,
  K_DEFINITION,
  K_DELETE,
  K_DIRECTIVE,
  K_EMPHASIS,
  K_ES_COMMENT,
  K_EXPORT,
  K_FOOTNOTE_DEFINITION,
  K_FOOTNOTE_REFERENCE,
  K_FRONT_MATTER,
  K_HEADING,
  K_HTML,
  K_IMAGE,
  K_IMAGE_REFERENCE,
  K_IMPORT,
  K_INLINE_CODE,
  K_INLINE_MATH,
  K_LINK,
  K_LINK_REFERENCE,
  K_LIQUID_NODE,
  K_LIST,
  K_LIST_ITEM,
  K_MATH,
  K_PARAGRAPH,
  K_ROOT,
  K_STRONG,
  K_TABLE,
  K_TABLE_CELL,
  K_TABLE_ROW,
  K_TEXT,
  K_THEMATIC_BREAK,
  K_WIKI_LINK,
  NONE,
  REFERENCE_COLLAPSED,
  REFERENCE_FULL,
  REFERENCE_SHORTCUT,
  STR_EMPTY,
  STR_NO,
  Tree,
} from "./ast.ts";
import {
  findClosingRun,
  findMathEnd,
  isGfmAtext,
  parseEmailLiteral,
  parseProtocolLiteral,
  parseWwwLiteral,
  pushTitle,
  pushWithoutNul,
} from "./spans.ts";
import {
  containsByte,
  containsStr,
  indexOfStr,
  isAsciiAlpha,
  isAsciiAlnum,
  isAsciiWs,
  isBlank,
  lineEndIn,
  unescape,
} from "./strings.ts";

export const SY_MARKDOWN = 0;
// The same with oxfmt's `:::` containers.
export const SY_WITH_DIRECTIVES = 1;
// The same, to see what two lines are: see `leavesParagraph`, which is not asked again for them.
export const SY_TWO_LINES = 2;
// See `parseContent`.
export const SY_PLAIN = 3;
// What Prettier makes of MDX, with remark-parse 8: `import` and `export`, any tag starts HTML, which is JSX.
export const SY_MDX = 4;

const EMPTY = new Uint8Array(0);
const NUL_REPLACEMENT = new Uint8Array([0xef, 0xbf, 0xbd]);
const NUL_AS_IS = new Uint8Array([0]);

// What `parse` has to say about the front matter: the text with blanks in the place of the front matter. That only makes a
// difference if something follows the front matter on its last line. Then this is the text with the blanks; else null.
export function blankFrontMatter(text: Uint8Array): Uint8Array | null {
  const fm = parseFrontMatter(text);
  if (fm === null) return null;
  const end = fm.end;
  if (end >= text.length || (text[end] | 0) === 10) return null;
  const blanked = new Uint8Array(text.length);
  blanked.set(text);
  for (let i = 0; i < end; i++) {
    if ((blanked[i] | 0) !== 10) blanked[i] = 32;
  }
  return blanked;
}

// Fills `tree` with the syntax of `text`, in which every line break is `\n`. Returns the root, or -1 if it is nested too deeply.
// `original`: the same, or the text that `text` is for `blankFrontMatter`.
export function parse(text: Uint8Array, original: Uint8Array, syntax: number, tree: Tree, nulHint: number): number {
  const fm = parseFrontMatter(original);
  if (fm === null) return parseLines(text, tree, syntax, 0, nulHint);
  const isBlanked = !(fm.end >= original.length || (original[fm.end] | 0) === 10);
  const firstLine = isBlanked ? fm.end - 3 : fm.end + 1;
  const root = parseLines(text, tree, syntax, firstLine, nulHint);
  if (root < 0) return -1;
  const node = tree.add(K_FRONT_MATTER, 0, fm.end);
  tree.prepend(root, node);
  return root;
}

// `isPlain`: CommonMark with strikethrough, footnotes and task lists, and nothing else: no tables, math, Liquid, wiki links, or
// links that are not marked as such.
export function parseContent(text: Uint8Array, tree: Tree, isPlain: boolean): number {
  return parseLines(text, tree, isPlain ? SY_PLAIN : SY_MARKDOWN, 0, -1);
}

function isSpace(b: number): boolean {
  return b === 32 || b === 9;
}

// Tags of the spans that `MdExt.span` finds.
const T_LIQUID = 0;
const T_ES_COMMENT = 1;
const T_MATH = 2;
const T_WIKI_LINK = 3;
const T_EMAIL = 4;
const T_URL = 5;
const T_WWW = 6;
const T_CHECK = 7;

const SPAN_BYTES = new Uint8Array([36, 91, 123, 64, 58, 46]); // $[{@:.
const SPAN_BYTES_PLAIN = new Uint8Array([91]);
const LEAF_BYTES_BRACE = new Uint8Array([123]);
const LEAF_BYTES_MDX = new Uint8Array([105, 101]); // ie

// Prettier's `tokenizeEsComment`: `{/* .. */}` on one line, in bytes[start, end). Returns false if it is not one; else sets
// `ecValueStart`, `ecValueEnd` (the value, trimmed) and `ecEnd` (where it ends).
let ecValueStart = 0;
let ecValueEnd = 0;
let ecEnd = 0;

function skipAsciiWs(bytes: Uint8Array, from: number, end: number): number {
  let i = from;
  while (i < end && isAsciiWs(bytes[i] | 0)) i = ((i | 0) + 1) | 0;
  return i;
}

function esComment(bytes: Uint8Array, start: number, end: number): boolean {
  const open = skipAsciiWs(bytes, start + 1, end);
  if (!(open + 1 < end && (bytes[open] | 0) === 47 && (bytes[open + 1] | 0) === 42)) return false;
  const valueStart = open + 2;
  const lineEnd = lineEndIn(bytes, valueStart, end);
  // The last `*/` on the line that `}` follows.
  let limit = lineEnd;
  while (true) {
    const rel = lastIndexOfStrBefore(bytes, valueStart, limit, "*/");
    if (rel < 0) return false;
    const close = rel;
    const brace = skipAsciiWs(bytes, close + 2, end);
    if (brace < end && (bytes[brace] | 0) === 125) {
      let vs = valueStart;
      let ve = close;
      // `trim_js_whitespace_start/end`: JS white space (ASCII and a few more)
      while (vs < ve) {
        const n = jsWsLen(bytes, vs, ve);
        if (n === 0) break;
        vs = vs + n;
      }
      while (ve > vs) {
        const n = jsWsLenBack(bytes, vs, ve);
        if (n === 0) break;
        ve = ve - n;
      }
      ecValueStart = vs;
      ecValueEnd = ve;
      ecEnd = brace + 1;
      return true;
    }
    limit = close + 1;
  }
}

function lastIndexOfStrBefore(bytes: Uint8Array, from: number, limit: number, needle: string): number {
  const n = needle.length;
  for (let i = limit - n; i >= from; i--) {
    let k = 0;
    while (k < n && (bytes[i + k] | 0) === needle.charCodeAt(k)) k = k + 1;
    if (k === n) return i;
  }
  return -1;
}

// The `Extensions` of the formatter: the syntax that is not CommonMark's. Rust: the closures `leaf` and `span` of `parse_lines`
// and the `Cell`s that they keep.
class MdExt extends Extensions {
  syntax: number;
  // `Builder::can_start_with_check`
  canStartWithCheck: boolean;
  // ---- LeafMemo: what `liquidEnd` has looked for, so that it is not looked for again from every `{{`.
  // For `}}` and for `%}`: from where it has been looked for, and where the first one is from there. -1: there is none. 0: it
  // has not been looked for.
  closingFrom0: number;
  closingFound0: number;
  closingFrom1: number;
  closingFound1: number;
  // The start of a line that starts a container, with no such line between it and `noContainerFrom`.
  container: number;
  noContainerFrom: number;
  // ---- SpanMemo
  serial: number;
  // What is from the first place to the second could be the name of an address, and is not.
  noAddress0: number;
  noAddress1: number;
  // There is no `}}`, no `%}` from the first place to the second.
  noLiquidFrom0: number;
  noLiquidUntil0: number;
  noLiquidFrom1: number;
  noLiquidUntil1: number;
  // There is no `]` and no line break from the first place to the second.
  noBracket0: number;
  noBracket1: number;

  constructor() {
    super();
    this.syntax = SY_MARKDOWN;
    this.canStartWithCheck = false;
    this.closingFrom0 = 0;
    this.closingFound0 = 0;
    this.closingFrom1 = 0;
    this.closingFound1 = 0;
    this.container = 0;
    this.noContainerFrom = 0;
    this.serial = 0;
    this.noAddress0 = 0;
    this.noAddress1 = 0;
    this.noLiquidFrom0 = 0;
    this.noLiquidUntil0 = 0;
    this.noLiquidFrom1 = 0;
    this.noLiquidUntil1 = 0;
    this.noBracket0 = 0;
    this.noBracket1 = 0;
  }

  init(syntax: number): void {
    this.syntax = syntax;
    this.canStartWithCheck = false;
    this.closingFrom0 = 0;
    this.closingFound0 = 0;
    this.closingFrom1 = 0;
    this.closingFound1 = 0;
    this.container = 0;
    this.noContainerFrom = 0;
    this.serial = 0;
    this.noAddress0 = 0;
    this.noAddress1 = 0;
    this.noLiquidFrom0 = 0;
    this.noLiquidUntil0 = 0;
    this.noLiquidFrom1 = 0;
    this.noLiquidUntil1 = 0;
    this.noBracket0 = 0;
    this.noBracket1 = 0;
    if (syntax === SY_PLAIN) {
      this.leafBytes = EMPTY;
      this.spanBytes = SPAN_BYTES_PLAIN;
    } else if (syntax === SY_MDX) {
      this.leafBytes = LEAF_BYTES_MDX;
      this.spanBytes = SPAN_BYTES;
    } else {
      this.leafBytes = LEAF_BYTES_BRACE;
      this.spanBytes = SPAN_BYTES;
    }
  }

  leaf(p: Parser, off: number, indent: number, isInContainer: boolean, interruptsParagraph: boolean): number {
    if (this.syntax === SY_MDX) return esSyntaxEnd(p.text, off, indent, isInContainer, interruptsParagraph);
    return this.liquidEnd(p, off, isInContainer);
  }

  // Where the `{{ .. }}` or `{% .. %}` ends that starts a line, if nothing follows it on its last line; -1 if it is not.
  liquidEnd(p: Parser, off: number, isInContainer: boolean): number {
    const text = p.text;
    const len = text.length;
    if (off + 1 >= len) return -1;
    let kind = 0;
    let closing = "}}";
    const c1 = text[off + 1] | 0;
    if (c1 === 123) {
      kind = 0;
    } else if (c1 === 37) {
      kind = 1;
      closing = "%}";
    } else return -1;
    let lineEnd = lineEndIn(text, off, len);
    const from = off + 2;
    let at: number;
    if (isInContainer) {
      if (from > lineEnd) return -1;
      const f = indexOfStr(text, from, lineEnd, closing);
      if (f < 0) return -1;
      at = f;
    } else {
      let sFrom = kind === 0 ? this.closingFrom0 : this.closingFrom1;
      let found = kind === 0 ? this.closingFound0 : this.closingFound1;
      if (found === 0 || from < sFrom || (found !== -1 && from > found)) {
        if (from > len) return -1;
        const f = indexOfStr(text, from, len, closing);
        sFrom = from;
        found = f;
        if (kind === 0) {
          this.closingFrom0 = sFrom;
          this.closingFound0 = found;
        } else {
          this.closingFrom1 = sFrom;
          this.closingFound1 = found;
        }
      }
      at = found;
    }
    if (at < 0) return -1;
    const end = at + 2;
    const e2 = lineEndIn(text, end, len);
    for (let i = end; i < e2; i++) {
      if (!isSpace(text[i] | 0)) return -1;
    }
    // No line in it starts a container.
    if (this.noContainerFrom <= lineEnd && lineEnd < this.container) {
      return end < this.container ? end : -1;
    }
    const firstLineEnd = lineEnd;
    while (lineEnd < end) {
      if (startsContainerInParagraph(p, lineEnd + 1)) {
        this.noContainerFrom = firstLineEnd;
        this.container = lineEnd + 1;
        return -1;
      }
      lineEnd = lineEndIn(text, lineEnd + 1, len);
    }
    return end;
  }

  span(buf: Uint8Array, off: number, len: number, pos: number, from: number, isAfterOpenBracket: boolean, serial: number): boolean {
    return this.spanAt(buf, off, len, pos, from, isAfterOpenBracket, serial);
  }

  setSpan(off: number, beg: number, end: number, tag: number): boolean {
    this.spanBeg = beg - off;
    this.spanEnd = end - off;
    this.spanTag = tag;
    return true;
  }

  // The span that a byte of `SPAN_BYTES` is in, in the text of a paragraph, a heading or a cell. Everything with absolute
  // indices into `bytes`: the content is `bytes[s, e)`, `index` is the byte, `fromAbs` where the span cannot start before.
  spanAt(bytes: Uint8Array, s: number, len: number, pos: number, from: number, isAfterOpenBracket: boolean, serial: number): boolean {
    const e = s + len;
    const index = s + pos;
    const fromAbs = s + from;
    // micromark-extension-gfm-task-list-item: `[ ]` or `[x]`, with white space and something else behind it.
    if (pos === 0 && this.canStartWithCheck && len >= 4) {
      const value = bytes[s + 1] | 0;
      const after = bytes[s + 3] | 0;
      if (
        (bytes[s] | 0) === 91 &&
        (bytes[s + 2] | 0) === 93 &&
        (value === 32 || value === 9 || value === 120 || value === 88) &&
        // remark-parse 7, which reads MDX: a blank is behind it.
        ((after === 10 && this.syntax !== SY_MDX) || (isSpace(after) && hasNonSpace(bytes, s + 3, e)))
      ) {
        return this.setSpan(s, s, s + 3, T_CHECK);
      }
    }
    if (this.syntax === SY_PLAIN) return false;
    const isMdx = this.syntax === SY_MDX;
    // Addresses (Rust: pointers) are `s + i + 1`, so that 0 is none.
    if (this.serial !== serial) {
      this.serial = serial;
      this.noAddress0 = 0;
      this.noAddress1 = 0;
      this.noLiquidFrom0 = 0;
      this.noLiquidUntil0 = 0;
      this.noLiquidFrom1 = 0;
      this.noLiquidUntil1 = 0;
      this.noBracket0 = 0;
      this.noBracket1 = 0;
    }
    const byte = bytes[index] | 0;
    if (byte === 36) {
      // Only the whole of a run. The first of it can be escaped.
      if (pos > 0 && (bytes[index - 1] | 0) === 36) {
        let backslashes = 0;
        while (index - 2 - backslashes >= s && (bytes[index - 2 - backslashes] | 0) === 92) backslashes = backslashes + 1;
        if (backslashes % 2 === 0) return false;
      }
      let size = 0;
      while (index + size < e && (bytes[index + size] | 0) === 36) size = size + 1;
      let end: number;
      if (isMdx) end = findMathEnd(bytes, index, e);
      else if (size < 2) end = -1;
      else end = findClosingRun(bytes, index + size, e, 36, size);
      if (end < 0) return false;
      return this.setSpan(s, index, end, T_MATH);
    }
    // `[[target]]`
    if (byte === 91) {
      const targetStart = index + 2;
      if (!(index + 1 < e && (bytes[index + 1] | 0) === 91)) return false;
      // `![` is the start of an image, whatever follows.
      if (pos > 0 && (bytes[index - 1] | 0) === 33) {
        let backslashes = 0;
        while (index - 2 - backslashes >= s && (bytes[index - 2 - backslashes] | 0) === 92) backslashes = backslashes + 1;
        if (backslashes % 2 === 0) return false;
      }
      const from0 = this.noBracket0;
      const until = this.noBracket1;
      const isKnown = from0 <= targetStart + 1 && targetStart + 1 <= until;
      let targetEnd: number;
      if (isKnown) {
        const u = until - 1;
        targetEnd = u < e ? u : e;
      } else {
        targetEnd = targetStart < e ? targetStart : e;
      }
      if (targetEnd < e) {
        const b = bytes[targetEnd] | 0;
        if (b !== 93 && b !== 10) {
          let k = targetEnd;
          while (k < e) {
            const c = bytes[k] | 0;
            if (c === 93 || c === 10) break;
            k = k + 1;
          }
          targetEnd = k;
        }
      }
      if (!isKnown) {
        this.noBracket0 = targetStart + 1;
        this.noBracket1 = targetEnd + 1;
      } else if (targetEnd + 1 > until) {
        this.noBracket1 = targetEnd + 1;
      }
      if (!(targetEnd + 1 < e && (bytes[targetEnd] | 0) === 93 && (bytes[targetEnd + 1] | 0) === 93)) return false;
      if (!hasNonSpace(bytes, targetStart, targetEnd)) return false;
      return this.setSpan(s, index, targetEnd + 2, T_WIKI_LINK);
    }
    if (byte === 123) {
      if (isMdx && esComment(bytes, index, e)) return this.setSpan(s, index, ecEnd, T_ES_COMMENT);
      if (index + 1 >= e) return false;
      const c1 = bytes[index + 1] | 0;
      let which = 0;
      let closing = "}}";
      if (c1 === 123) which = 0;
      else if (c1 === 37) {
        which = 1;
        closing = "%}";
      } else return false;
      const nf = which === 0 ? this.noLiquidFrom0 : this.noLiquidFrom1;
      const nu = which === 0 ? this.noLiquidUntil0 : this.noLiquidUntil1;
      if (nf !== 0 && nf <= index + 1 && e + 1 <= nu) return false;
      const f = indexOfStr(bytes, index + 2, e, closing);
      if (f < 0) {
        if (which === 0) {
          this.noLiquidFrom0 = index + 1;
          this.noLiquidUntil0 = e + 1;
        } else {
          this.noLiquidFrom1 = index + 1;
          this.noLiquidUntil1 = e + 1;
        }
        return false;
      }
      return this.setSpan(s, index, f + 2, T_LIQUID);
    }
    // No literal autolinks in what can still become the text of a link.
    if (isAfterOpenBracket) return false;
    if (byte === 64) {
      return this.emailAt(bytes, s, e, this.atextStart(bytes, fromAbs, index), index);
    }
    // `http://`, `https://`
    if (byte === 58) {
      if (!(index + 2 < e + 0 && (bytes[index + 1] | 0) === 47 && (bytes[index + 2] | 0) === 47)) return false;
      const beforeStart = fromAbs < index ? fromAbs : index;
      let len2 = 0;
      if (index - beforeStart >= 5 && matchCi(bytes, index - 5, "https")) len2 = 5;
      else if (index - beforeStart >= 4 && matchCi(bytes, index - 4, "http")) len2 = 4;
      else return false;
      const beg = index - len2;
      if (beg > s && isAsciiAlpha(bytes[beg - 1] | 0)) return false;
      const end = parseProtocolLiteral(bytes, beg, e);
      if (end < 0) return false;
      return this.setSpan(s, beg, end, T_URL);
    }
    // `www.`
    if (byte === 46) {
      const beg = index - 3;
      if (beg < fromAbs || beg < s) return false;
      if (!matchCi(bytes, beg, "www")) return false;
      // An address that it is the start of, or a part of the name of, comes first.
      if (!(this.noAddress0 <= beg + 1 && beg + 1 < this.noAddress1)) {
        const nameStart = this.atextStart(bytes, fromAbs, beg);
        let nameEnd = index;
        while (nameEnd < e && isGfmAtext(bytes[nameEnd] | 0)) nameEnd = nameEnd + 1;
        if (nameEnd < e && (bytes[nameEnd] | 0) === 64) {
          if (this.emailAt(bytes, s, e, nameStart, index)) return true;
        }
        this.noAddress0 = nameStart + 1;
        this.noAddress1 = nameEnd + 1;
      }
      if (beg > s) {
        const p = bytes[beg - 1] | 0;
        if (!(p === 40 || p === 42 || p === 95 || p === 91 || p === 93 || p === 126 || p === 32 || p === 9 || p === 10)) return false;
      }
      const end = parseWwwLiteral(bytes, beg, e);
      if (end < 0) return false;
      return this.setSpan(s, beg, end, T_WWW);
    }
    return false;
  }

  // Where what can be the name of an address starts that ends at `end`.
  atextStart(bytes: Uint8Array, fromAbs: number, end: number): number {
    const beforeStart = fromAbs < end ? fromAbs : end;
    let i = end;
    while (i > beforeStart && isGfmAtext(bytes[i - 1] | 0)) i = i - 1;
    return i;
  }

  // The address that starts at `beg`.
  emailAt(bytes: Uint8Array, s: number, e: number, beg: number, index: number): boolean {
    if (beg > s && ((bytes[beg - 1] | 0) === 47 || isGfmAtext(bytes[beg - 1] | 0))) return false;
    const end = parseEmailLiteral(bytes, beg, e);
    if (end < 0) return false;
    return this.setSpan(s, beg, end, T_EMAIL);
  }
}

function matchCi(bytes: Uint8Array, at: number, lit: string): boolean {
  for (let i = 0; i < lit.length; i++) {
    let c = bytes[at + i] | 0;
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== lit.charCodeAt(i)) return false;
  }
  return true;
}

function hasNonSpace(bytes: Uint8Array, s: number, e: number): boolean {
  for (let i = s; i < e; i++) {
    if (!isSpace(bytes[i] | 0)) return true;
  }
  return false;
}

// Prettier's `tokenizeEsSyntax`: `import` or `export` at the start of a line that is not in a container, up to the next empty
// line.
function esSyntaxEnd(text: Uint8Array, off: number, indent: number, isInContainer: boolean, interruptsParagraph: boolean): number {
  if (isInContainer || indent > 0 || interruptsParagraph) return -1;
  const len = text.length;
  if (!(startsWithAt(text, off, len, "import") || startsWithAt(text, off, len, "export"))) return -1;
  if (!(off + 6 < len && isAsciiWs(text[off + 6] | 0))) return -1;
  const at = indexOfStr(text, off, len, "\n\n");
  return at < 0 ? len : at;
}

function startsWithAt(text: Uint8Array, at: number, end: number, lit: string): boolean {
  const n = lit.length;
  if (at + n > end) return false;
  for (let i = 0; i < n; i++) {
    if ((text[at + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------- oxfmt's line shapes

// oxfmt's `is_line_shape_start`: `:::` that does not start a container, `<<<` of VitePress, the tag of a component.
function isLineShapeStart(buf: Uint8Array, s: number, e: number): boolean {
  if (startsWithAt(buf, s, e, ":::")) {
    let colons = 0;
    while (s + colons < e && (buf[s + colons] | 0) === 58) colons = colons + 1;
    let i = s + colons;
    while (i < e && isAsciiWs(buf[i] | 0)) i = i + 1;
    if (i < e) {
      const b = buf[i] | 0;
      if (isAsciiAlnum(b) || b === 95 || b === 123 || b === 91 || b >= 0x80) return false;
    }
    return true;
  }
  if (!(s < e && (buf[s] | 0) === 60)) return false;
  let t = s + 1;
  if (startsWithAt(buf, t, e, "<<")) return true;
  if (t < e && (buf[t] | 0) === 47) t = t + 1;
  let len = 0;
  let hasDash = false;
  while (t + len < e) {
    const b = buf[t + len] | 0;
    if (b === 45) hasDash = true;
    else if (!isAsciiAlnum(b)) break;
    len = len + 1;
  }
  if (len === 0) return false;
  const first = buf[t] | 0;
  return (first >= 65 && first <= 90) || (isAsciiAlpha(first) && hasDash);
}

// Whether the line may be the row under the header of a table.
function isLikeDelimiterRow(buf: Uint8Array, s: number, e: number): boolean {
  for (let i = s; i < e; i++) {
    const b = buf[i] | 0;
    if (!(b === 124 || b === 58 || b === 45 || b === 32 || b === 9)) return false;
  }
  return true;
}

// The first `len` bytes of `rest`, a line that starts with a code span, with as few backticks before it as what is in the span allows.
function withPrintedBackticks(buf: Uint8Array, s: number, e: number, len: number): Uint8Array {
  const runAt = (at: number): number => {
    let n = 0;
    while (at + n < e && (buf[at + n] | 0) === 96) n = n + 1;
    return n;
  };
  const written = runAt(s);
  const present = new Uint8Array(66);
  let at = s + written;
  while (true) {
    while (at < e && (buf[at] | 0) !== 96) at = at + 1;
    if (at >= e) break;
    const run = runAt(at);
    if (run === written) break;
    const k = (run < 1 ? 1 : run > 64 ? 64 : run) - 1;
    present[k] = 1;
    at = at + run;
  }
  let ones = 0;
  while (ones < 64 && present[ones] === 1) ones = ones + 1;
  const out = new ByteBuf(ones + 1 + len);
  out.fill(96, ones + 1);
  if (written <= len) out.append(buf, s + written, s + len);
  return out.view();
}

// Whether `line` is not a line of the paragraph any more if it starts in the first column. `above` is the line before it, which only
// the row under the header of a table looks at. Without it (`aboveStart < 0`), the header is taken to fit.
function leavesParagraph(abovePresent: boolean, aboveBuf: Uint8Array, aboveS: number, aboveE: number, line: Uint8Array, ls: number, le: number): boolean {
  let firstBuf: Uint8Array;
  let fs: number;
  let fe: number;
  if (!isLikeDelimiterRow(line, ls, le)) {
    firstBuf = new Uint8Array([97]);
    fs = 0;
    fe = 1;
  } else if (abovePresent) {
    firstBuf = aboveBuf;
    fs = aboveS;
    fe = aboveE;
  } else {
    const fitting = new Uint8Array(le - ls);
    for (let i = ls; i < le; i++) {
      const b = line[i] | 0;
      fitting[i - ls] = b === 58 || b === 45 ? 97 : b;
    }
    firstBuf = fitting;
    fs = 0;
    fe = fitting.length;
  }
  const text = new Uint8Array(fe - fs + 1 + (le - ls) + 1);
  text.set(firstBuf.subarray(fs, fe), 0);
  text[fe - fs] = 10;
  text.set(line.subarray(ls, le), fe - fs + 1);
  text[text.length - 1] = 10;
  const tree = new Tree();
  const root = parseLines(text, tree, SY_TWO_LINES, 0, -1);
  if (root < 0) return false;
  const first = tree.firstChild[root] | 0;
  return !(first >= 0 && (tree.kind[first] | 0) === K_PARAGRAPH && (tree.next[first] | 0) < 0);
}

// ---------------------------------------------------------------------------------------------- the builder

const FOLLOWER_TEXT = 0;
// HTML, Liquid, math: what is printed as it is written.
const FOLLOWER_VERBATIM = 1;
// A code span, whose backticks are counted anew.
const FOLLOWER_CODE = 2;
const FOLLOWER_OTHER = 3;

class Builder extends Renderer {
  // The whole text.
  src: Uint8Array;
  // Where what the parser is given starts in it.
  base: number;
  isMdx: boolean;
  isForOxfmt: boolean;
  hasNul: boolean;
  // What a NUL is in the tree: U+FFFD, as CommonMark says. oxfmt prints what is written.
  nul: Uint8Array;
  tree: Tree;
  ext: MdExt;
  // The containers that are open, the root first: node and the line that its last child ends on (as far as blank lines
  // between children go; 0: it has no child).
  openNode: I32Vec;
  openLastChildLine: I32Vec;
  // How many of them are block quotes.
  openBlockquotes: number;
  // What the parser has said last about a container: marker start (or where it ended), end, indent.
  srcBeg: number;
  srcEnd: number;
  srcIndent: number;
  // The lines of a leaf block: triples (beg, end, indent).
  lines: I32Vec;
  // The definitions that are not in the tree yet, by where they start.
  defStart: I32Vec;
  defNode: I32Vec;
  nextDefinition: number;
  areDefinitionsSorted: boolean;
  // Segments: triples (start, end, virtualSpaces).
  segs: I32Vec;
  unendedNode: number;
  unendedIsHtml: boolean;
  unendedFirstSegment: number;
  // The containers that have ended since the last leaf block, each with the start of the line that ended it: pairs.
  ended: I32Vec;
  // What is open goes on to the very end of the text.
  isExtendedToTheEnd: boolean;

  // The paragraph, the heading or the cell that is open, and the spans that are open in it.
  spans: I32Vec;
  // What the parser has said last about where something in a line is.
  placeBeg: number;
  placeEnd: number;
  // Where the opening marker of each of `spans` ends.
  markerEnds: I32Vec;
  // The text that is not a node yet: where it is, what it stands for, and whether that is what is written.
  textStart: number;
  textEnd: number;
  hasText: boolean;
  textValue: ByteBuf;
  isTextAsWritten: boolean;
  // The text of the image that is open.
  alt: ByteBuf;
  // Where the last part of it ends.
  altEnd: number;
  startsWithCheck: boolean;
  // For oxfmt: a line break whose fate what follows it decides.
  hasGuarded: boolean;
  gbPlaceBeg: number;
  gbPlaceEnd: number;
  gbIsHard: boolean;
  gbIsAsWritten: boolean;
  gbAboveBeg: number;
  gbAboveEnd: number;
  gbLineBeg: number;
  gbLineEnd: number;
  // For oxfmt: the line is one that it prints as it is written.
  isOnLineAsWritten: boolean;
  // scratch
  cb: ByteBuf;
  tb: ByteBuf;
  virt: number;
  // `definition` scratch
  labelBuf: ByteBuf;

  constructor() {
    super();
    this.src = EMPTY;
    this.base = 0;
    this.isMdx = false;
    this.isForOxfmt = false;
    this.hasNul = false;
    this.nul = NUL_REPLACEMENT;
    this.tree = new Tree();
    this.ext = new MdExt();
    this.openNode = new I32Vec(64);
    this.openLastChildLine = new I32Vec(64);
    this.openBlockquotes = 0;
    this.srcBeg = 0;
    this.srcEnd = 0;
    this.srcIndent = 0;
    this.lines = new I32Vec(96);
    this.defStart = new I32Vec(16);
    this.defNode = new I32Vec(16);
    this.nextDefinition = 0;
    this.areDefinitionsSorted = false;
    this.segs = new I32Vec(96);
    this.unendedNode = NONE;
    this.unendedIsHtml = false;
    this.unendedFirstSegment = 0;
    this.ended = new I32Vec(32);
    this.isExtendedToTheEnd = false;
    this.spans = new I32Vec(32);
    this.placeBeg = 0;
    this.placeEnd = 0;
    this.markerEnds = new I32Vec(32);
    this.textStart = 0;
    this.textEnd = 0;
    this.hasText = false;
    this.textValue = new ByteBuf(256);
    this.isTextAsWritten = false;
    this.alt = new ByteBuf(64);
    this.altEnd = 0;
    this.startsWithCheck = false;
    this.hasGuarded = false;
    this.gbPlaceBeg = 0;
    this.gbPlaceEnd = 0;
    this.gbIsHard = false;
    this.gbIsAsWritten = false;
    this.gbAboveBeg = 0;
    this.gbAboveEnd = 0;
    this.gbLineBeg = 0;
    this.gbLineEnd = 0;
    this.isOnLineAsWritten = false;
    this.cb = new ByteBuf(256);
    this.tb = new ByteBuf(256);
    this.virt = 0;
    this.labelBuf = new ByteBuf(64);
  }

  // `nulHint`: 1 if the text may have a NUL, 0 if it has none, -1 if it is not known.
  reset(src: Uint8Array, base: number, tree: Tree, syntax: number, root: number, nulHint: number): void {
    this.src = src;
    this.base = base;
    this.tree = tree;
    tree.src = src;
    this.isMdx = syntax === SY_MDX;
    this.isForOxfmt = syntax === SY_WITH_DIRECTIVES;
    let hasNul = nulHint !== 0;
    if (nulHint < 0) {
      hasNul = false;
      for (let i = 0; i < src.length; i++) {
        if ((src[i] | 0) === 0) {
          hasNul = true;
          break;
        }
      }
    }
    this.hasNul = hasNul;
    this.nul = syntax === SY_WITH_DIRECTIVES ? NUL_AS_IS : NUL_REPLACEMENT;
    this.ext.init(syntax);
    this.openNode.reset();
    this.openLastChildLine.reset();
    this.openNode.push(root);
    this.openLastChildLine.push(0);
    this.openBlockquotes = 0;
    this.srcBeg = 0;
    this.srcEnd = 0;
    this.srcIndent = 0;
    this.lines.reset();
    this.defStart.reset();
    this.defNode.reset();
    this.nextDefinition = 0;
    this.areDefinitionsSorted = false;
    this.segs.reset();
    this.unendedNode = NONE;
    this.unendedIsHtml = false;
    this.unendedFirstSegment = 0;
    this.ended.reset();
    this.isExtendedToTheEnd = false;
    this.spans.reset();
    this.placeBeg = 0;
    this.placeEnd = 0;
    this.markerEnds.reset();
    this.hasText = false;
    this.textStart = 0;
    this.textEnd = 0;
    this.textValue.reset();
    this.isTextAsWritten = false;
    this.alt.reset();
    this.altEnd = 0;
    this.startsWithCheck = false;
    this.hasGuarded = false;
    this.isOnLineAsWritten = false;
  }

  // ---------------------------------------------------------------------------------------------- places

  // Where the line that `offset` is on ends.
  lineEnd(offset: number): number {
    const src = this.src;
    const n = src.length;
    if (offset >= n) return offset;
    return lineEndIn(src, offset, n);
  }

  // The column of `offset`. A tab goes to the next multiple of four.
  column(offset: number): number {
    const start = this.tree.lineStart(offset);
    const src = this.src;
    if (start > offset || offset > src.length) return 0;
    let column = 0;
    for (let i = start; i < offset; i++) {
      column = (src[i] | 0) === 9 ? (((column + 4) / 4) | 0) * 4 : column + 1;
    }
    return column;
  }

  // Where the `indent` columns of white space before `beg` start. How many of them are the rest of a tab before that place is
  // in `this.virt`.
  indentationStart(beg: number, indent: number): number {
    this.virt = 0;
    if (indent === 0) return beg;
    const src = this.src;
    if (beg >= indent) {
      const start = beg - indent;
      if (beg <= src.length) {
        let allSpaces = true;
        for (let i = start; i < beg; i++) {
          if ((src[i] | 0) !== 32) {
            allSpaces = false;
            break;
          }
        }
        if (allSpaces) return start;
      }
    }
    const col = this.column(beg);
    const target = col > indent ? col - indent : 0;
    let offset = this.tree.lineStart(beg);
    let column = 0;
    while (offset < beg && column < target) {
      column = (src[offset] | 0) === 9 ? (((column + 4) / 4) | 0) * 4 : column + 1;
      offset = offset + 1;
    }
    const spaces = column - (target < column ? target : column);
    this.virt = spaces > 3 ? 3 : spaces;
    return offset;
  }

  // Pushes the segment of the line (beg, end, indent).
  pushSegment(beg: number, end: number, indent: number): void {
    const start = this.indentationStart(beg, indent);
    this.segs.push(start);
    this.segs.push(end);
    this.segs.push(this.virt);
  }

  // ---------------------------------------------------------------------------------------------- the tree

  parentNode(): number {
    const n = this.openNode.len;
    return n > 0 ? this.openNode.data[n - 1] | 0 : NONE;
  }

  setEnd(node: number, end: number): void {
    if (node >= 0 && node < this.tree.n) this.tree.end[node] = end | 0;
  }

  isInBlockquote(): boolean {
    return this.openBlockquotes > 0;
  }

  // Adds `node`, which starts at `start`, to the container that is open. A blank line before it spreads out a list or an item.
  append(node: number, start: number): void {
    const n = this.openNode.len;
    if (n === 0) return;
    const parent = this.openNode.data[n - 1] | 0;
    const lastChildLine = this.openLastChildLine.data[n - 1] | 0;
    const tree = this.tree;
    tree.append(parent, node);
    if (lastChildLine > 0 && tree.line(start) > lastChildLine + 1) {
      tree.flags[parent] = (tree.flags[parent] | 0) | F_SPREAD;
    }
  }

  // The last child of the container that is open ends at `end`.
  noteChildEnd(end: number): void {
    const n = this.openNode.len;
    if (n === 0) return;
    const node = this.openNode.data[n - 1] | 0;
    const k = this.tree.kind[node] | 0;
    if (k === K_LIST || k === K_LIST_ITEM) this.openLastChildLine.data[n - 1] = this.tree.line(end) | 0;
  }

  // The definitions that start before `offset` are children of the container that is open.
  addDefinitionsBefore(offset: number): void {
    if (!this.areDefinitionsSorted) {
      this.areDefinitionsSorted = true;
      this.sortDefinitions();
    }
    while (this.nextDefinition < this.defStart.len) {
      const start = this.defStart.data[this.nextDefinition] | 0;
      const node = this.defNode.data[this.nextDefinition] | 0;
      if (start >= offset) break;
      this.nextDefinition = this.nextDefinition + 1;
      this.endUnended(-1);
      this.ended.reset();
      this.append(node, start);
      const end = this.tree.end[node] | 0;
      this.noteChildEnd(end);
    }
  }

  // Those in front of a setext heading have come first: stable sort by start.
  sortDefinitions(): void {
    const n = this.defStart.len;
    let sorted = true;
    for (let i = 1; i < n; i++) {
      if ((this.defStart.data[i - 1] | 0) > (this.defStart.data[i] | 0)) {
        sorted = false;
        break;
      }
    }
    if (sorted) return;
    // insertion sort (stable); the unsorted ones are few
    for (let i = 1; i < n; i++) {
      const s = this.defStart.data[i] | 0;
      const nd = this.defNode.data[i] | 0;
      let j = i - 1;
      while (j >= 0 && (this.defStart.data[j] | 0) > s) {
        this.defStart.data[j + 1] = this.defStart.data[j] | 0;
        this.defNode.data[j + 1] = this.defNode.data[j] | 0;
        j = j - 1;
      }
      this.defStart.data[j + 1] = s | 0;
      this.defNode.data[j + 1] = nd | 0;
    }
  }

  addLeaf(kind: number, start: number, end: number): number {
    this.addDefinitionsBefore(start);
    this.endUnended(-1);
    this.ended.reset();
    const node = this.tree.add(kind, start, end);
    this.append(node, start);
    this.noteChildEnd(end);
    return node;
  }

  // The value of a string in which escapes and character references count. `null` if it is empty.
  stringValue(start: number, end: number): number {
    const src = this.src;
    if (!(start >= 0 && start <= end && end <= src.length)) return STR_NO;
    if (start === end) return STR_NO;
    for (let i = start; i < end; i++) {
      const b = src[i] | 0;
      if (b === 92 || b === 38 || b === 0) {
        const tree = this.tree;
        const at = tree.ownedBegin();
        unescape(src, start, end, tree.strings);
        return tree.ownedEnd(at);
      }
    }
    return this.tree.strSource(start, end);
  }

  // The lines `segs[first..]`, joined by line breaks. They are taken away.
  joinedValue(first: number): number {
    const tree = this.tree;
    const segs = this.segs;
    const count = (segs.len / 3) | 0;
    if (first >= count) return STR_EMPTY;
    const d = segs.data;
    const firstStart = d[first * 3] | 0;
    const lastEnd = d[(count - 1) * 3 + 1] | 0;
    // Nothing has been taken away from the lines: the value is in the text as it is.
    let isPlain = true;
    for (let i = first; i < count; i++) {
      if ((d[i * 3 + 2] | 0) !== 0) {
        isPlain = false;
        break;
      }
      if (i + 1 < count && (d[i * 3 + 1] | 0) + 1 !== (d[(i + 1) * 3] | 0)) {
        isPlain = false;
        break;
      }
    }
    isPlain = isPlain && firstStart <= lastEnd;
    if (isPlain && this.hasNul) {
      isPlain = !(lastEnd <= this.src.length && containsByte(this.src, firstStart, lastEnd, 0));
    }
    let value: number;
    if (isPlain) {
      value = tree.strSource(firstStart, lastEnd);
    } else {
      const at = tree.ownedBegin();
      const out = tree.strings;
      const src = this.src;
      for (let i = first; i < count; i++) {
        if (i > first) out.push(10);
        const virtualSpaces = d[i * 3 + 2] | 0;
        for (let k = 0; k < virtualSpaces; k++) out.push(32);
        const s = d[i * 3] | 0;
        const e = d[i * 3 + 1] | 0;
        if (s >= 0 && s <= e && e <= src.length) pushWithoutNul(src, s, e, this.nul, out);
      }
      value = tree.ownedEnd(at);
    }
    segs.len = first * 3;
    return value;
  }

  // ---------------------------------------------------------------------------------------------- code and HTML that nothing ends

  // micromark takes what is behind the last line break of the text for a line. Lists go on with it, block quotes do not. So code and
  // HTML that nothing has ended, and the lists they are in, have that line break.
  goesOnToTheEnd(lastLineEnd: number): boolean {
    return lastLineEnd + 1 === this.src.length && !this.isInBlockquote();
  }

  // `lineStart`: the line that starts there has the marker of a container, which ends the code or the HTML. It has taken the line
  // break before that by then. -1: none.
  endUnended(lineStart: number): void {
    const node = this.unendedNode;
    if (node < 0) return;
    const isHtml = this.unendedIsHtml;
    const firstSegment = this.unendedFirstSegment;
    this.unendedNode = NONE;
    let end = -1;
    if (lineStart >= 0) end = lineStart;
    else if (this.isExtendedToTheEnd) end = this.src.length;
    if (end >= 0) {
      this.segs.push(end);
      this.segs.push(end);
      this.segs.push(0);
      this.setEnd(node, end);
    }
    // Without a closing fence, the line break at the end is not part of the value.
    if (!isHtml) {
      const count = (this.segs.len / 3) | 0;
      if (count > firstSegment) {
        const d = this.segs.data;
        const i = (count - 1) * 3;
        if ((d[i] | 0) === (d[i + 1] | 0) && (d[i + 2] | 0) === 0) this.segs.len = i;
      }
    }
    const value = this.joinedValue(firstSegment);
    this.tree.value[node] = value;
  }

  // ---------------------------------------------------------------------------------------------- leaf blocks

  // A paragraph, or a heading of `setextDepth` (-1: none) with a line under it. Its lines are `this.lines`.
  paragraph(setextDepth: number): void {
    const n = (this.lines.len / 3) | 0;
    if (n === 0) return;
    const d = this.lines.data;
    const firstBeg = d[0] | 0;
    const lastEnd = d[(n - 1) * 3 + 1] | 0;
    const tree = this.tree;
    let node: number;
    if (setextDepth < 0) {
      const end = this.lineEnd(lastEnd);
      node = this.addLeaf(K_PARAGRAPH, firstBeg, end);
    } else {
      this.addDefinitionsBefore(firstBeg);
      // The heading starts where the definitions do that are right before it.
      let start = firstBeg;
      const parent = this.parentNode();
      let previous = parent >= 0 ? tree.lastChild[parent] | 0 : NONE;
      while (previous >= 0 && (tree.kind[previous] | 0) === K_DEFINITION && tree.line(tree.end[previous] | 0) + 1 === tree.line(start)) {
        start = tree.start[previous] | 0;
        previous = tree.previous[previous] | 0;
      }
      const end = this.lineEnd(this.lineEnd(lastEnd) + 1);
      node = this.addLeaf(K_HEADING, firstBeg, end);
      tree.start[node] = start;
      tree.number[node] = setextDepth;
    }
    this.spans.push(node);
    this.ext.canStartWithCheck = setextDepth < 0 && this.isFirstContentOfItem(node);
  }

  isFirstContentOfItem(paragraph: number): boolean {
    const tree = this.tree;
    if (tree.kindOf(this.parentNode()) !== K_LIST_ITEM) return false;
    let previous = tree.previous[paragraph] | 0;
    while (previous >= 0) {
      if ((tree.kind[previous] | 0) !== K_DEFINITION) return false;
      previous = tree.previous[previous] | 0;
    }
    return true;
  }

  // mdast-util-gfm-task-list-item: the first character of the white space behind `[x]` is not part of the paragraph.
  stripSpaceAfterCheck(paragraph: number): void {
    const tree = this.tree;
    const head = tree.firstChild[paragraph] | 0;
    if (head < 0 || (tree.kind[head] | 0) !== K_TEXT) return;
    const start = tree.start[head] | 0;
    tree.resolve(tree.value[head] | 0);
    const s = tree.rStart + 1;
    const e = tree.rEnd;
    if (s >= e) {
      tree.detach(head);
      return;
    }
    const at = tree.ownedBegin();
    tree.strings.append(tree.rBuf, s, e);
    tree.value[head] = tree.ownedEnd(at);
    tree.start[head] = start + 1;
    tree.start[paragraph] = start + 1;
  }

  atxHeading(beg: number, end0: number, depth: number): void {
    const src = this.src;
    let markerEnd = beg;
    while (markerEnd > 0 && isSpace(src[markerEnd - 1] | 0)) markerEnd = markerEnd - 1;
    const end = this.lineEnd(end0);
    const node = this.addLeaf(K_HEADING, markerEnd > depth ? markerEnd - depth : 0, end);
    this.tree.number[node] = depth;
    this.spans.push(node);
  }

  // `infoStart`: where what is behind the opening fence starts.
  fencedCode(infoStart: number, isClosed: boolean): void {
    const src = this.src;
    const tree = this.tree;
    let fenceEnd = infoStart;
    while (fenceEnd > 0 && isSpace(src[fenceEnd - 1] | 0)) fenceEnd = fenceEnd - 1;
    const marker = src[fenceEnd > 0 ? fenceEnd - 1 : 0] | 0;
    let start = fenceEnd;
    while (start > 0 && (src[start - 1] | 0) === marker) start = start - 1;
    const infoEnd = this.lineEnd(infoStart);
    const n = (this.lines.len / 3) | 0;
    const lastLineEnd = n > 0 ? this.lines.data[(n - 1) * 3 + 1] | 0 : infoEnd;
    const end = isClosed ? this.lineEnd(lastLineEnd + 1) : lastLineEnd;
    const kind = marker === 36 ? K_MATH : K_CODE;
    const node = this.addLeaf(kind, start, end);
    let langLen = 0;
    if (kind === K_CODE) {
      while (infoStart + langLen < infoEnd && !isSpace(src[infoStart + langLen] | 0)) langLen = langLen + 1;
    }
    let blanks = 0;
    while (infoStart + langLen + blanks < infoEnd && isSpace(src[infoStart + langLen + blanks] | 0)) blanks = blanks + 1;
    const lang = this.stringValue(infoStart, infoStart + langLen);
    const meta = this.stringValue(infoStart + langLen + blanks, infoEnd);
    tree.second[node] = lang;
    tree.third[node] = meta;
    const firstSegment = (this.segs.len / 3) | 0;
    for (let i = 0; i < n; i++) {
      const d = this.lines.data;
      this.pushSegment(d[i * 3] | 0, d[i * 3 + 1] | 0, d[i * 3 + 2] | 0);
    }
    if (isClosed) {
      tree.value[node] = this.joinedValue(firstSegment);
      return;
    }
    this.isExtendedToTheEnd = this.goesOnToTheEnd(lastLineEnd);
    this.unendedNode = node;
    this.unendedIsHtml = false;
    this.unendedFirstSegment = firstSegment;
  }

  // The lines `lines[from, to)` (triples) are indented code.
  indentedCode(from: number, to: number): void {
    if (from >= to) return;
    const tree = this.tree;
    const d = this.lines.data;
    const firstBeg = d[from * 3] | 0;
    const firstEnd = d[from * 3 + 1] | 0;
    const firstIndent = d[from * 3 + 2] | 0;
    // At the end of a line, micromark asks whether that line goes on without the markers of its containers, not the next: code that
    // starts on the line that ends a container ends with that line.
    const lineStart = tree.lineStart(firstBeg);
    if (to - from > 1 && !this.isForOxfmt) {
      let any = false;
      for (let i = 0; i < this.ended.len; i += 2) {
        if ((this.ended.data[i + 1] | 0) === lineStart) {
          any = true;
          break;
        }
      }
      if (any) {
        this.indentedCode(from, from + 1);
        let blank = 0;
        while (from + 1 + blank < to && (d[(from + 1 + blank) * 3] | 0) >= (d[(from + 1 + blank) * 3 + 1] | 0)) blank = blank + 1;
        this.indentedCode(from + 1 + blank, to);
        return;
      }
    }
    const start = this.indentationStart(firstBeg, firstIndent + 4);
    // A blank line that is indented enough is part of the code, even at its end.
    const col = this.column(firstBeg);
    const codeColumn = col > firstIndent ? col - firstIndent : 0;
    let count = 1;
    for (let i = to - 1; i >= from; i--) {
      const b = d[i * 3] | 0;
      const e = d[i * 3 + 1] | 0;
      if (b < e || this.column(e) >= codeColumn) {
        count = i - from + 1;
        break;
      }
    }
    const lastEnd = d[(from + count - 1) * 3 + 1] | 0;
    const node = this.addLeaf(K_CODE, start, lastEnd);
    const firstSegment = (this.segs.len / 3) | 0;
    for (let i = from; i < from + count; i++) {
      this.pushSegment(d[i * 3] | 0, d[i * 3 + 1] | 0, d[i * 3 + 2] | 0);
    }
    // A line break at the end is not part of the value.
    if (count > 1) {
      const sc = (this.segs.len / 3) | 0;
      const sd = this.segs.data;
      const i = (sc - 1) * 3;
      if ((sd[i] | 0) === (sd[i + 1] | 0) && (sd[i + 2] | 0) === 0) this.segs.len = i;
    }
    tree.value[node] = this.joinedValue(firstSegment);
    tree.number[node] = this.isForOxfmt ? 1 : 0;
    void firstEnd;
  }

  // A block that `liquidEnd` or `esSyntaxEnd` has found.
  extension(beg: number, end: number): void {
    const src = this.src;
    const first = beg < end ? src[beg] | 0 : -1;
    let kind: number;
    let len = end - beg;
    if (first === 105) kind = K_IMPORT;
    else if (first === 101) kind = K_EXPORT;
    else {
      kind = K_LIQUID_NODE;
      let trailing = 0;
      while (trailing < len && isSpace(src[end - 1 - trailing] | 0)) trailing = trailing + 1;
      len = len - trailing;
    }
    const e = beg + len;
    const node = this.addLeaf(kind, beg, e);
    this.tree.value[node] = this.tree.strSource(beg, e);
  }

  html(isUnended: boolean, isEndedByText: boolean): void {
    const n = (this.lines.len / 3) | 0;
    if (n === 0) return;
    const d = this.lines.data;
    const start = this.indentationStart(d[0] | 0, d[2] | 0);
    const lastEnd = d[(n - 1) * 3 + 1] | 0;
    const node = this.addLeaf(K_HTML, start, lastEnd);
    this.tree.number[node] = isEndedByText && this.isForOxfmt ? 1 : 0;
    const firstSegment = (this.segs.len / 3) | 0;
    for (let i = 0; i < n; i++) {
      const dd = this.lines.data;
      this.pushSegment(dd[i * 3] | 0, dd[i * 3 + 1] | 0, dd[i * 3 + 2] | 0);
    }
    if (isUnended) {
      this.isExtendedToTheEnd = this.goesOnToTheEnd(lastEnd);
      this.unendedNode = node;
      this.unendedIsHtml = true;
      this.unendedFirstSegment = firstSegment;
      return;
    }
    this.tree.value[node] = this.joinedValue(firstSegment);
  }

  table(): void {
    const n = (this.lines.len / 3) | 0;
    if (n === 0) return;
    const d = this.lines.data;
    const headBeg = d[0] | 0;
    const lastEnd = d[(n - 1) * 3 + 1] | 0;
    const end = this.lineEnd(lastEnd);
    const node = this.addLeaf(K_TABLE, headBeg, end);
    this.tree.firstAlign[node] = this.tree.nAligns;
    this.spans.push(node);
  }

  tableRow(): void {
    const start = this.placeBeg;
    const end = this.lineEnd(this.placeEnd);
    const tree = this.tree;
    const row = tree.add(K_TABLE_ROW, start, end);
    tree.append(this.lastSpan(), row);
    this.spans.push(row);
  }

  lastSpan(): number {
    const n = this.spans.len;
    return n > 0 ? this.spans.data[n - 1] | 0 : NONE;
  }

  // A cell has the pipe before it. The first has what is before it in the row, the last what is behind it. `align`: -1 for none.
  tableCell(align: number): void {
    const tree = this.tree;
    const row = this.lastSpan();
    let start: number;
    if (row >= 0 && row < tree.n && (tree.firstChild[row] | 0) < 0) start = tree.start[row] | 0;
    else start = this.placeBeg > 0 ? this.placeBeg - 1 : 0;
    const cell = tree.add(K_TABLE_CELL, start, this.placeEnd);
    tree.append(row, cell);
    this.spans.push(cell);
    if (align >= 0) {
      tree.addAlign(align);
      const table = row >= 0 ? tree.parent[row] | 0 : NONE;
      if (table >= 0) tree.number[table] = (tree.number[table] | 0) + 1;
    }
  }

  endTableRow(): void {
    const tree = this.tree;
    const row = this.spans.len > 0 ? this.spans.pop() : NONE;
    if (row < 0 || row >= tree.n) return;
    const start = tree.start[row] | 0;
    const end = tree.end[row] | 0;
    const lastChild = tree.lastChild[row] | 0;
    // A row that is nothing but a pipe has a cell.
    if (lastChild < 0) {
      const cell = tree.add(K_TABLE_CELL, start, end);
      tree.append(row, cell);
      return;
    }
    this.setEnd(lastChild, end);
  }

  // ---------------------------------------------------------------------------------------------- containers

  // Where what is in the item starts whose marker ends at `markerEnd`: behind one to four columns of white space. If there are more,
  // the rest is indented code. If nothing follows, the white space is not part of it.
  itemContentStart(markerEnd: number): number {
    const src = this.src;
    const lineEnd = this.lineEnd(markerEnd);
    let blanks = 0;
    while (markerEnd + blanks < lineEnd && isSpace(src[markerEnd + blanks] | 0)) blanks = blanks + 1;
    if (blanks === lineEnd - markerEnd) return markerEnd;
    const start = this.column(markerEnd);
    const width = this.column(markerEnd + blanks) - start;
    return width <= 4 ? markerEnd + blanks : markerEnd + 1;
  }

  // A container starts whose marker is at `marker`, behind `indent` columns of white space. `isNextItem`: it is the next item of the
  // list that is open.
  beforeContainer(marker: number, indent: number, markerEnd: number, isNextItem: boolean): void {
    this.addDefinitionsBefore(marker);
    const lineStart = this.tree.lineStart(marker);
    // `ended` is taken: what is in it stays readable until something is pushed.
    const n = this.ended.len;
    this.ended.len = 0;
    const ed = this.ended.data;
    let all = n > 0;
    for (let i = 0; i < n; i += 2) {
      if ((ed[i + 1] | 0) !== lineStart) {
        all = false;
        break;
      }
    }
    const takesLineBreak = this.unendedNode >= 0 && n > 0 && all;
    this.endUnended(takesLineBreak ? lineStart : -1);
    if (isNextItem) {
      // With no line break between them, mdast-util-from-markdown ends an item where the marker of the next ends.
      if (takesLineBreak) {
        const previousItem = n > 0 ? ed[n - 2] | 0 : NONE;
        for (let i = 0; i < n; i += 2) this.setEnd(ed[i] | 0, lineStart);
        this.setEnd(previousItem, this.itemContentStart(markerEnd));
      }
      return;
    }
    // micromark ends the containers here, and then moves their ends back over line breaks and indentation. The marker of a block quote
    // is in the way of that.
    if (takesLineBreak || this.isInBlockquote()) {
      const end = this.indentationStart(marker, indent);
      for (let i = 0; i < n; i += 2) {
        if ((ed[i + 1] | 0) !== lineStart) continue;
        const node = ed[i] | 0;
        if (takesLineBreak || this.tree.kindOf(node) !== K_LIST_ITEM) this.setEnd(node, end);
      }
    }
  }

  enterContainer(kind: number, start: number, end: number): number {
    const node = this.tree.add(kind, start, end);
    this.append(node, start);
    if (kind === K_BLOCKQUOTE) this.openBlockquotes = this.openBlockquotes + 1;
    this.openNode.push(node);
    this.openLastChildLine.push(0);
    return node;
  }

  leaveContainer(): void {
    const endedBy = this.srcBeg;
    const end = this.srcEnd;
    const isEndedByColons = this.srcIndent;
    this.addDefinitionsBefore(end);
    if (this.openNode.len === 0) return;
    const node = this.openNode.pop();
    this.openLastChildLine.pop();
    const tree = this.tree;
    const kind = tree.kind[node] | 0;
    if (kind === K_BLOCKQUOTE) this.openBlockquotes = this.openBlockquotes - 1;
    if (isEndedByColons !== 0 && kind === K_DIRECTIVE) {
      const lineEnd = this.lineEnd(endedBy);
      let colons = 0;
      while (endedBy + colons < lineEnd && (this.src[endedBy + colons] | 0) !== 58) colons = colons + 1;
      if (endedBy + colons >= lineEnd) colons = 0;
      tree.second[node] = tree.strSource(endedBy + colons, lineEnd);
      this.noteChildEnd(lineEnd);
      this.setEnd(node, lineEnd);
      return;
    }
    this.noteChildEnd(end);
    const len = this.src.length;
    let endedBy2 = endedBy;
    if (endedBy === OFF_MAX) endedBy2 = len > 0 && (this.src[len - 1] | 0) === 10 ? len : len + 1;
    let nodeEnd = end;
    // An empty line with the marker of a block quote belongs to the lists in that, but not to their items.
    if (kind !== K_LIST_ITEM && kind !== K_BLOCKQUOTE && this.isInBlockquote()) {
      nodeEnd = nodeEnd > endedBy2 - 1 ? nodeEnd : endedBy2 - 1;
    }
    if (this.isExtendedToTheEnd) nodeEnd = len;
    this.setEnd(node, nodeEnd);
    this.ended.push(node);
    this.ended.push(endedBy2);
  }

  // ---------------------------------------------------------------------------------------------- what is in the lines

  // What is written from `start` to `end` in the block that is open, without what is before its lines in the file but their
  // indentation. Appended to `out`.
  pushContentBetween(start: number, end: number, out: ByteBuf): void {
    const src = this.src;
    const n = (this.lines.len / 3) | 0;
    let from = start;
    while (true) {
      let lineEnd = from;
      if (from <= end && end <= src.length) lineEnd = lineEndIn(src, from, end);
      if (from <= lineEnd && lineEnd <= src.length) out.append(src, from, lineEnd);
      // lines.partition_point(|line| line.beg <= lineEnd)
      let lo = 0;
      let hi = n;
      const d = this.lines.data;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((d[mid * 3] | 0) <= lineEnd) lo = mid + 1;
        else hi = mid;
      }
      if (!(lo < n && lineEnd < end)) return;
      out.push(10);
      from = this.indentationStart(d[lo * 3] | 0, d[lo * 3 + 2] | 0);
    }
  }

  isOnOneLine(start: number, end: number): boolean {
    return start <= end && end <= this.src.length && !containsByte(this.src, start, end, 10);
  }

  // The string from `start` to `end` as it is.
  raw(start: number, end: number): number {
    if (this.isOnOneLine(start, end) && !(this.hasNul && containsByte(this.src, start, end, 0))) {
      return this.tree.strSource(start, end);
    }
    const bytes = this.cb;
    bytes.reset();
    this.pushContentBetween(start, end, bytes);
    const tree = this.tree;
    const at = tree.ownedBegin();
    pushWithoutNul(bytes.data, 0, bytes.len, this.nul, tree.strings);
    return tree.ownedEnd(at);
  }

  // buf[s, e) without the backslashes of escapes and with what character references stand for.
  decoded(buf: Uint8Array, s: number, e: number): number {
    const tree = this.tree;
    const at = tree.ownedBegin();
    if (!this.hasNulIn(buf, s, e)) {
      unescape(buf, s, e, tree.strings);
    } else {
      const tmp = this.tb;
      tmp.reset();
      unescape(buf, s, e, tmp);
      pushWithoutNul(tmp.data, 0, tmp.len, this.nul, tree.strings);
    }
    return tree.ownedEnd(at);
  }

  hasNulIn(buf: Uint8Array, s: number, e: number): boolean {
    // `nul` is U+FFFD (or NUL itself: nothing changes): only a NUL in the input matters, and it can come from a character
    // reference (`&#0;`). The text is checked once (`hasNul`); a reference to NUL comes out as U+FFFD, not NUL.
    return this.hasNul && this.nul !== NUL_AS_IS && containsByte(buf, s, e, 0);
  }

  title(buf: Uint8Array, s: number, e: number): number {
    const tree = this.tree;
    const at = tree.ownedBegin();
    if (!this.hasNulIn(buf, s, e)) {
      pushTitle(buf, s, e, tree.strings);
    } else {
      const tmp = this.tb;
      tmp.reset();
      pushTitle(buf, s, e, tmp);
      pushWithoutNul(tmp.data, 0, tmp.len, this.nul, tree.strings);
    }
    return tree.ownedEnd(at);
  }

  // `label` of a reference whose label is written from `start` to `end`.
  label(start: number, end: number): number {
    const bytes = this.labelBuf;
    bytes.reset();
    this.pushContentBetween(start, end, bytes);
    return this.decoded(bytes.data, 0, bytes.len);
  }

  // The value of code or math between its fences: without one space at each end, if there is one at both and something else between.
  codeValue(start0: number, end0: number): number {
    const src = this.src;
    const tree = this.tree;
    const start = start0;
    const end = end0 > start0 ? end0 : start0;
    const isOnOneLine = this.isOnOneLine(start, end);
    let bytes: Uint8Array;
    let bs: number;
    let be: number;
    if (isOnOneLine) {
      bytes = src;
      bs = start;
      be = end;
    } else {
      const joined = this.cb;
      joined.reset();
      this.pushContentBetween(start, end, joined);
      bytes = joined.data;
      bs = 0;
      be = joined.len;
    }
    let padding = 0;
    if (be - bs >= 2) {
      const a = bytes[bs] | 0;
      const z = bytes[be - 1] | 0;
      if ((a === 32 || a === 10) && (z === 32 || z === 10)) {
        for (let i = bs; i < be; i++) {
          const c = bytes[i] | 0;
          if (c !== 32 && c !== 10) {
            padding = 1;
            break;
          }
        }
      }
    }
    const cs = bs + padding;
    const ce = be - padding;
    // In a table, `\|` is a pipe.
    let isInCell = false;
    for (let i = 0; i < this.spans.len; i++) {
      if (tree.kindOf(this.spans.data[i] | 0) === K_TABLE_CELL) {
        isInCell = true;
        break;
      }
    }
    if (!this.isMdx && isInCell && containsStr(bytes, cs, ce, "\\|")) {
      const at = tree.ownedBegin();
      const out = tree.strings;
      let rest = cs;
      while (true) {
        const k = indexOfStr(bytes, rest, ce, "\\|");
        if (k < 0) break;
        out.append(bytes, rest, k);
        out.push(124);
        rest = k + 2;
      }
      out.append(bytes, rest, ce);
      return tree.ownedEnd(at);
    }
    if (isOnOneLine && !(this.hasNul && containsByte(bytes, cs, ce, 0))) {
      return tree.strSource(start + padding, end - padding);
    }
    const at = tree.ownedBegin();
    pushWithoutNul(bytes, cs, ce, this.nul, tree.strings);
    return tree.ownedEnd(at);
  }

  isInImage(): boolean {
    const n = this.spans.len;
    if (n === 0) return false;
    const k = this.tree.kindOf(this.spans.data[n - 1] | 0);
    return k === K_IMAGE || k === K_IMAGE_REFERENCE;
  }

  // Makes a node of the text that is not one yet.
  endText(): void {
    if (!this.hasText) return;
    this.hasText = false;
    const start = this.textStart;
    const end = this.textEnd;
    const tree = this.tree;
    let value: number;
    if (this.isTextAsWritten) {
      value = tree.strSource(start, end);
    } else {
      const at = tree.ownedBegin();
      tree.strings.append(this.textValue.data, 0, this.textValue.len);
      value = tree.ownedEnd(at);
    }
    this.textValue.reset();
    const node = tree.add(K_TEXT, start, end);
    tree.value[node] = value;
    tree.append(this.lastSpan(), node);
  }

  // From here on the text that is open is not what is written: `textValue` has it.
  copyText(): void {
    if (this.hasText && this.isTextAsWritten) {
      this.textValue.append(this.src, this.textStart, this.textEnd);
    }
    this.isTextAsWritten = false;
  }

  // `value` (buf[s, e)) is what is written at `place` stands for.
  addText(buf: Uint8Array, s: number, e: number, isAsWritten: boolean): void {
    const start = this.placeBeg;
    const end = this.placeEnd;
    if (this.hasText) {
      if (!(this.isTextAsWritten && isAsWritten && this.textEnd === start)) {
        this.copyText();
        this.textValue.append(buf, s, e);
      }
      this.textEnd = end;
    } else {
      this.hasText = true;
      this.textStart = start;
      this.textEnd = end;
      this.isTextAsWritten = isAsWritten;
      if (!isAsWritten) this.textValue.append(buf, s, e);
    }
  }

  // The line break at `place`, if what follows it has a say in what becomes of it. Sets `hasGuarded` and the `gb*` fields.
  guardedBreak(isHard: boolean, isAsWritten: boolean): boolean {
    if (!this.isForOxfmt) return false;
    const n = (this.lines.len / 3) | 0;
    const d = this.lines.data;
    // lines.partition_point(|line| line.beg <= place.0)
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((d[mid * 3] | 0) <= this.placeBeg) lo = mid + 1;
      else hi = mid;
    }
    const next = lo;
    if (next === 0 || next >= n) return false;
    const aboveBeg = d[(next - 1) * 3] | 0;
    const aboveEnd = d[(next - 1) * 3 + 1] | 0;
    const lineBeg = d[next * 3] | 0;
    const lineEnd = d[next * 3 + 1] | 0;
    const lineIndent = d[next * 3 + 2] | 0;
    const src = this.src;
    if (!(lineBeg <= lineEnd && lineEnd <= src.length)) return false;
    if (lineBeg === lineEnd) return false;
    // oxfmt's `may_open_block`
    const c = src[lineBeg] | 0;
    const mayStartBlock =
      c === 62 || c === 61 || c === 45 || c === 42 || c === 95 || c === 43 || (c >= 48 && c <= 57) || c === 35 || c === 96 || c === 126 ||
      c === 60 || c === 36 || c === 123 || c === 58 || c === 91 || c === 124;
    if (!mayStartBlock || (lineIndent < 4 && !isLikeDelimiterRow(src, lineBeg, lineEnd))) {
      this.isOnLineAsWritten = isLineShapeStart(src, lineBeg, lineEnd);
      return false;
    }
    this.gbPlaceBeg = this.placeBeg;
    this.gbPlaceEnd = this.placeEnd;
    this.gbIsHard = isHard;
    this.gbIsAsWritten = isAsWritten;
    this.gbAboveBeg = aboveBeg;
    this.gbAboveEnd = aboveEnd;
    this.gbLineBeg = lineBeg;
    this.gbLineEnd = lineEnd;
    return true;
  }

  // `follower` comes next: now it is known what becomes of the line break before it.
  endGuardedBreak(follower: number): void {
    if (!this.hasGuarded) return;
    this.hasGuarded = false;
    const src = this.src;
    let lineBuf = src;
    let ls = this.gbLineBeg;
    let le = this.gbLineEnd;
    if (follower === FOLLOWER_CODE) {
      lineBuf = withPrintedBackticks(src, ls, src.length, le - ls);
      ls = 0;
      le = lineBuf.length;
    }
    const isLineAsWritten =
      isLineShapeStart(lineBuf, ls, le) ||
      (follower === FOLLOWER_TEXT && (startsWithAt(lineBuf, ls, le, "```") || startsWithAt(lineBuf, ls, le, "~~~") || startsWithAt(lineBuf, ls, le, "$$")));
    const isHard = this.gbIsHard;
    const stays = isHard || this.isOnLineAsWritten || isLineAsWritten;
    this.isOnLineAsWritten = isLineAsWritten;
    // Behind a line break that stays it does not look at the line above.
    const leaves = leavesParagraph(!stays, src, this.gbAboveBeg, this.gbAboveEnd, lineBuf, ls, le);
    if (!isHard) {
      // What looks like the line under a heading is escaped.
      let me = le;
      while (me > ls && isAsciiWs(lineBuf[me - 1] | 0)) me = me - 1;
      let allEq = true;
      let allDash = true;
      for (let i = ls; i < me; i++) {
        const b = lineBuf[i] | 0;
        if (b !== 61) allEq = false;
        if (b !== 45) allDash = false;
      }
      const isUnderline = allEq || allDash;
      const saveBeg = this.placeBeg;
      const saveEnd = this.placeEnd;
      this.placeBeg = this.gbPlaceBeg;
      this.placeEnd = this.gbPlaceEnd;
      if (leaves && !stays && !isUnderline) {
        // Words are cut from the text as it is written, where there is a line break.
        this.addBlanks(" ");
      } else {
        this.addText(NEWLINE, 0, 1, this.gbIsAsWritten);
      }
      this.placeBeg = saveBeg;
      this.placeEnd = saveEnd;
    }
    if (leaves && stays && (follower === FOLLOWER_TEXT || follower === FOLLOWER_VERBATIM)) {
      const saveBeg = this.placeBeg;
      const saveEnd = this.placeEnd;
      this.placeEnd = saveBeg;
      this.addBlanks("    ");
      this.placeBeg = saveBeg;
      this.placeEnd = saveEnd;
    }
  }

  // `blanks` that are printed as they are.
  addBlanks(blanks: string): void {
    const node = this.addSpan(K_HTML);
    const tree = this.tree;
    const at = tree.ownedBegin();
    for (let i = 0; i < blanks.length; i++) tree.strings.push(blanks.charCodeAt(i));
    tree.value[node] = tree.ownedEnd(at);
  }

  addSpan(kind: number): number {
    this.endText();
    const tree = this.tree;
    const node = tree.add(kind, this.placeBeg, this.placeEnd);
    tree.append(this.lastSpan(), node);
    return node;
  }

  // A node that starts with the marker at `place`.
  enter(kind: number): number {
    const node = this.addSpan(kind);
    this.spans.push(node);
    this.markerEnds.push(this.placeEnd);
    return node;
  }

  // A link that is not marked as one, or an address.
  literalAutolink(prefix: string, buf: Uint8Array, cs: number, ce: number): void {
    if (this.isInImage()) {
      this.alt.append(buf, cs, ce);
      return;
    }
    const start = this.placeBeg;
    const end = this.placeEnd;
    const tree = this.tree;
    const node = this.addSpan(K_LINK);
    const text = tree.add(K_TEXT, start, end);
    tree.append(node, text);
    const value = this.raw(start, end);
    let url: number;
    if (prefix.length === 0) url = value;
    else {
      const at = tree.ownedBegin();
      for (let i = 0; i < prefix.length; i++) tree.strings.push(prefix.charCodeAt(i));
      pushWithoutNul(buf, cs, ce, this.nul, tree.strings);
      url = tree.ownedEnd(at);
    }
    tree.value[text] = value;
    tree.value[node] = url;
  }

  // ---------------------------------------------------------------------------------------------- RendererImpl

  wantsSource(): boolean {
    return true;
  }

  lineStarts(starts: Int32Array, n: number): void {
    const base = this.base;
    const tree = this.tree;
    for (let i = 0; i < n; i++) tree.addLineStart((starts[i] | 0) + base);
    // What is behind the last line break is a line too, an empty one.
    const len = this.src.length;
    if (len === 0 || (this.src[len - 1] | 0) === 10) tree.addLineStart(len);
  }

  containerSource(beg: number, end: number, indent: number): void {
    this.srcBeg = beg === OFF_MAX ? beg : beg + this.base;
    this.srcEnd = end + this.base;
    this.srcIndent = indent;
  }

  leafSource(blockType: number, lines: Int32Array, n: number): boolean {
    this.lines.reset();
    const base = this.base;
    for (let i = 0; i < n; i++) {
      const beg = lines[i * 3] | 0;
      const end = lines[i * 3 + 1] | 0;
      if (beg > end) continue;
      this.lines.push(beg + base);
      this.lines.push(end + base);
      this.lines.push(lines[i * 3 + 2] | 0);
    }
    return blockType === BT_CODE || blockType === BT_HTML || blockType === BT_HR;
  }

  inlineSource(beg: number, end: number): void {
    this.placeBeg = beg + this.base;
    this.placeEnd = end + this.base;
  }

  definition(d: Definition): void {
    const base = this.base;
    const start = d.beg + base;
    const end = d.end + base;
    const tree = this.tree;
    const node = tree.add(K_DEFINITION, start, end);
    // With the indentation of its further lines.
    const buf = d.buf;
    let rawBuf = buf;
    let rs = d.labelStart;
    let re = d.labelEnd;
    if (containsByte(buf, rs, re, 10)) {
      const lw = this.labelBuf;
      lw.reset();
      let index = 0;
      let from = rs;
      while (true) {
        const lineEnd = lineEndIn(buf, from, re);
        if (index > 0 && index < d.linesCount) {
          const li = (d.linesFrom + index) * 3;
          const beg = (d.lines[li] | 0) + base;
          const indentationStart = this.indentationStart(beg, d.lines[li + 2] | 0);
          lw.push(10);
          if (indentationStart <= beg && beg <= this.src.length) lw.append(this.src, indentationStart, beg);
        }
        lw.append(buf, from, lineEnd);
        if (lineEnd >= re) break;
        from = lineEnd + 1;
        index = index + 1;
      }
      rawBuf = lw.data;
      rs = 0;
      re = lw.len;
    }
    const label = this.decoded(rawBuf, rs, re);
    const url = this.decoded(buf, d.destStart, d.destEnd);
    const title = d.titleStart === d.titleEnd ? STR_NO : this.title(buf, d.titleStart, d.titleEnd);
    tree.third[node] = label;
    tree.value[node] = url;
    tree.second[node] = title;
    this.defStart.push(start);
    this.defNode.push(node);
  }

  enterBlock(blockType: number, data: number, flags: number): void {
    const marker = this.srcBeg;
    const markerEnd = this.srcEnd;
    const indent = this.srcIndent;
    const tree = this.tree;
    switch (blockType) {
      case BT_DOC:
        break;
      case BT_QUOTE:
        if ((flags & BLOCK_FOOTNOTE) !== 0) {
          this.beforeContainer(marker, indent, markerEnd, false);
          const node = this.enterContainer(K_FOOTNOTE_DEFINITION, marker, markerEnd);
          const labelStart = marker + 2;
          const labelEnd = markerEnd > 2 ? markerEnd - 2 : 0;
          const src = this.src;
          let label: number;
          if (labelStart <= labelEnd && labelEnd <= src.length) {
            let special = false;
            for (let i = labelStart; i < labelEnd; i++) {
              const b = src[i] | 0;
              if (b === 92 || b === 38) {
                special = true;
                break;
              }
            }
            if (special) {
              const at = tree.ownedBegin();
              unescape(src, labelStart, labelEnd, tree.strings);
              label = tree.ownedEnd(at);
            } else label = tree.strSource(labelStart, labelEnd);
          } else label = tree.strSource(labelStart, labelEnd);
          tree.value[node] = label;
        } else if ((flags & BLOCK_DIRECTIVE) !== 0) {
          this.beforeContainer(marker, indent, markerEnd, false);
          const node = this.enterContainer(K_DIRECTIVE, marker, markerEnd);
          tree.value[node] = tree.strSource(marker, markerEnd);
          tree.second[node] = STR_NO;
        } else {
          this.beforeContainer(marker, indent, markerEnd, false);
          this.enterContainer(K_BLOCKQUOTE, marker, marker + 1);
        }
        break;
      case BT_UL:
      case BT_OL: {
        this.beforeContainer(marker, indent, markerEnd, false);
        const node = this.enterContainer(K_LIST, marker, marker + 1);
        if (blockType === BT_OL) tree.flags[node] = (tree.flags[node] | 0) | F_ORDERED;
        tree.number[node] = data;
        break;
      }
      case BT_LI: {
        const parent = this.parentNode();
        const isNextItem = parent >= 0 && (tree.firstChild[parent] | 0) >= 0;
        if (isNextItem) this.beforeContainer(marker, indent, markerEnd, true);
        this.enterContainer(K_LIST_ITEM, marker, markerEnd);
        break;
      }
      case BT_HR:
        if (this.lines.len >= 3) {
          const beg = this.lines.data[0] | 0;
          const end = this.lineEnd(this.lines.data[1] | 0);
          this.addLeaf(K_THEMATIC_BREAK, beg, end);
        }
        break;
      case BT_H:
        if ((flags & BLOCK_SETEXT_HEADER) !== 0) this.paragraph(data);
        else if (this.lines.len >= 3) this.atxHeading(this.lines.data[0] | 0, this.lines.data[1] | 0, data);
        break;
      case BT_P:
        this.paragraph(-1);
        break;
      case BT_CODE:
        if ((flags & BLOCK_FENCED_CODE) !== 0) this.fencedCode(data + this.base, (flags & BLOCK_CLOSED) !== 0);
        else this.indentedCode(0, (this.lines.len / 3) | 0);
        break;
      case BT_HTML:
        if ((flags & BLOCK_EXTENSION) !== 0) {
          if (this.lines.len >= 3) this.extension(this.lines.data[0] | 0, this.lines.data[1] | 0);
        } else {
          this.html((flags & (BLOCK_HTML_UNTIL_TEXT | BLOCK_CLOSED)) === BLOCK_HTML_UNTIL_TEXT, (flags & BLOCK_HTML_UNTIL_TEXT) !== 0);
        }
        break;
      case BT_TABLE:
        this.table();
        break;
      case BT_THEAD:
      case BT_TBODY:
        break;
      case BT_TR:
        this.tableRow();
        break;
      case BT_TH: {
        const a = data & 3;
        this.tableCell(a === 0 ? ALIGN_NONE : a === 1 ? ALIGN_LEFT : a === 2 ? ALIGN_CENTER : ALIGN_RIGHT);
        break;
      }
      case BT_TD:
        this.tableCell(-1);
        break;
      default:
        break;
    }
  }

  leaveBlock(blockType: number, _data: number): void {
    switch (blockType) {
      case BT_QUOTE:
      case BT_UL:
      case BT_OL:
      case BT_LI:
        this.leaveContainer();
        break;
      case BT_DOC:
        this.addDefinitionsBefore(0x7fffffff);
        this.endUnended(-1);
        break;
      case BT_P:
      case BT_H:
      case BT_TABLE:
      case BT_TH:
      case BT_TD: {
        this.endGuardedBreak(FOLLOWER_OTHER);
        this.isOnLineAsWritten = false;
        this.endText();
        this.ext.canStartWithCheck = false;
        const node = this.spans.len > 0 ? this.spans.pop() : NONE;
        if (this.startsWithCheck) {
          this.startsWithCheck = false;
          if (node >= 0) this.stripSpaceAfterCheck(node);
        }
        break;
      }
      case BT_TR:
        this.endTableRow();
        break;
      default:
        break;
    }
  }

  enterSpan(spanType: number, detail: SpanDetail): void {
    if (this.isInImage()) return;
    let follower = FOLLOWER_OTHER;
    if (spanType === SP_LATEXMATH || spanType === SP_LATEXMATH_DISPLAY) follower = FOLLOWER_VERBATIM;
    else if (spanType === SP_CODE) follower = FOLLOWER_CODE;
    this.endGuardedBreakBy(follower);
    const isImage = spanType === SP_IMG;
    const reference = detail.reference;
    let kind: number;
    if (spanType === SP_EM || spanType === SP_U) kind = K_EMPHASIS;
    else if (spanType === SP_STRONG) kind = K_STRONG;
    else if (spanType === SP_DEL) kind = K_DELETE;
    else if (spanType === SP_CODE) kind = K_INLINE_CODE;
    else if (spanType === SP_LATEXMATH || spanType === SP_LATEXMATH_DISPLAY) kind = K_INLINE_MATH;
    else if (spanType === SP_WIKILINK) kind = K_WIKI_LINK;
    else if (reference === REF_FOOTNOTE) kind = K_FOOTNOTE_REFERENCE;
    else if (reference === REF_NONE) kind = isImage ? K_IMAGE : K_LINK;
    else kind = isImage ? K_IMAGE_REFERENCE : K_LINK_REFERENCE;
    const node = this.enter(kind);
    const tree = this.tree;
    if (kind === K_LINK || kind === K_IMAGE) {
      let url: number;
      if (detail.autolinkEmail) {
        const at = tree.ownedBegin();
        const out = tree.strings;
        out.push(109);
        out.push(97);
        out.push(105);
        out.push(108);
        out.push(116);
        out.push(111);
        out.push(58);
        out.append(detail.hrefBuf, detail.hrefStart, detail.hrefEnd);
        url = tree.ownedEnd(at);
      } else if (detail.autolink) {
        const at = tree.ownedBegin();
        pushWithoutNul(detail.hrefBuf, detail.hrefStart, detail.hrefEnd, this.nul, tree.strings);
        url = tree.ownedEnd(at);
      } else if (detail.hrefStart === detail.hrefEnd) {
        url = STR_EMPTY;
      } else {
        url = this.decoded(detail.hrefBuf, detail.hrefStart, detail.hrefEnd);
      }
      const title = detail.titleStart === detail.titleEnd ? STR_NO : this.title(detail.titleBuf, detail.titleStart, detail.titleEnd);
      tree.value[node] = url;
      tree.second[node] = title;
    } else if (kind === K_LINK_REFERENCE || kind === K_IMAGE_REFERENCE) {
      tree.referenceType[node] = reference === REF_FULL ? REFERENCE_FULL : reference === REF_COLLAPSED ? REFERENCE_COLLAPSED : REFERENCE_SHORTCUT;
    } else if (kind === K_FOOTNOTE_REFERENCE) {
      tree.value[node] = this.decoded(detail.hrefBuf, detail.hrefStart, detail.hrefEnd);
    }
  }

  endGuardedBreakBy(follower: number): void {
    this.endGuardedBreak(follower);
  }

  leaveSpan(spanType: number): void {
    if (this.isInImage() && spanType !== SP_IMG) return;
    this.endGuardedBreak(FOLLOWER_OTHER);
    this.endText();
    if (this.spans.len === 0 || this.markerEnds.len === 0) return;
    const node = this.spans.pop();
    const markerEnd = this.markerEnds.pop();
    const closingStart = this.placeBeg;
    const end = this.placeEnd;
    this.setEnd(node, end);
    const tree = this.tree;
    const kind = tree.kind[node] | 0;
    const referenceType = tree.referenceType[node] | 0;
    if (kind === K_IMAGE || kind === K_IMAGE_REFERENCE) {
      const alt = this.alt;
      // remark-parse 8: what is written between the brackets, whatever it is. oxfmt prints that.
      if (this.isMdx || this.isForOxfmt) {
        const written = this.cb;
        written.reset();
        this.pushContentBetween(markerEnd, closingStart, written);
        alt.reset();
        if (this.isMdx) unescape(written.data, 0, written.len, alt);
        else alt.append(written.data, 0, written.len);
      }
      const at = tree.ownedBegin();
      tree.strings.append(alt.data, 0, alt.len);
      tree.third[node] = tree.ownedEnd(at);
      alt.reset();
    }
    if (kind === K_INLINE_CODE) {
      tree.value[node] = this.codeValue(markerEnd, closingStart);
    } else if (kind === K_LINK_REFERENCE || kind === K_IMAGE_REFERENCE) {
      // `][label]`, or the text is the label.
      if (referenceType === REFERENCE_FULL) tree.value[node] = this.label(closingStart + 2, end > 1 ? end - 1 : 0);
      else tree.value[node] = this.label(markerEnd, closingStart);
    }
  }

  text(textType: number, buf: Uint8Array, start: number, end: number): void {
    if (this.isInImage()) {
      switch (textType) {
        case TX_NORMAL:
        case TX_CODE:
        case TX_HTML:
        case TX_LATEXMATH:
          this.alt.append(buf, start, end);
          break;
        case TX_NULLCHAR:
          this.alt.append(this.nul, 0, this.nul.length);
          break;
        case TX_ENTITY:
          unescape(buf, start, end, this.alt);
          break;
        case TX_SOFTBR: {
          if (this.altEnd === this.placeBeg) {
            const a = this.alt;
            let blanks = 0;
            while (blanks < a.len && isSpace(a.data[a.len - 1 - blanks] | 0)) blanks = blanks + 1;
            a.len = a.len - blanks;
          }
          this.alt.push(10);
          break;
        }
        default:
          break;
      }
      this.altEnd = this.placeEnd;
      return;
    }
    let follower = FOLLOWER_OTHER;
    if (textType === TX_NORMAL || textType === TX_NULLCHAR || textType === TX_ENTITY) follower = FOLLOWER_TEXT;
    else if (textType === TX_HTML) follower = FOLLOWER_VERBATIM;
    this.endGuardedBreak(follower);
    switch (textType) {
      // In an autolink.
      case TX_NORMAL:
        if (this.hasNul && containsByte(buf, start, end, 0)) {
          const tmp = this.tb;
          tmp.reset();
          pushWithoutNul(buf, start, end, this.nul, tmp);
          this.addText(tmp.data, 0, tmp.len, false);
        } else {
          const isAsWritten = this.placeEnd - this.placeBeg === end - start;
          this.addText(buf, start, end, isAsWritten);
        }
        break;
      // The value of code is cut from the text when it ends.
      case TX_CODE:
      case TX_LATEXMATH:
        break;
      case TX_NULLCHAR:
        this.addText(this.nul, 0, this.nul.length, false);
        break;
      case TX_ENTITY:
        this.addText(EMPTY, 0, 0, false);
        unescape(buf, start, end, this.textValue);
        break;
      // The white space before it is not part of the text.
      case TX_SOFTBR: {
        let blanks = 0;
        if (this.hasText && this.isTextAsWritten) {
          while (blanks < this.textEnd - this.textStart && isSpace(this.src[this.textEnd - 1 - blanks] | 0)) blanks = blanks + 1;
        } else {
          const tv = this.textValue;
          while (blanks < tv.len && isSpace(tv.data[tv.len - 1 - blanks] | 0)) blanks = blanks + 1;
        }
        if (blanks > 0) {
          this.copyText();
          this.textValue.len = this.textValue.len - blanks;
          if (this.textValue.len === 0) this.hasText = false;
        }
        this.hasGuarded = this.guardedBreak(false, blanks === 0);
        if (!this.hasGuarded) this.addText(NEWLINE, 0, 1, blanks === 0);
        break;
      }
      case TX_BR:
        this.addSpan(K_BREAK);
        this.hasGuarded = this.guardedBreak(true, false);
        break;
      case TX_HTML: {
        const node = this.addSpan(K_HTML);
        this.tree.value[node] = this.raw(this.placeBeg, this.placeEnd);
        break;
      }
      default:
        break;
    }
  }

  extensionSpan(tag: number, buf: Uint8Array, start: number, end: number): void {
    this.endGuardedBreak(tag === T_LIQUID || tag === T_MATH ? FOLLOWER_VERBATIM : FOLLOWER_OTHER);
    const ps = this.placeBeg;
    const pe = this.placeEnd;
    const tree = this.tree;
    let kind: number;
    let value: number;
    if (tag === T_CHECK) {
      const item = this.parentNode();
      if (item >= 0) {
        const c = end - start > 1 ? buf[start + 1] | 0 : -1;
        tree.checked[item] = c === 120 || c === 88 ? 2 : 1;
      }
      this.startsWithCheck = true;
      return;
    }
    if (tag === T_EMAIL) {
      this.literalAutolink("mailto:", buf, start, end);
      return;
    }
    if (tag === T_URL) {
      this.literalAutolink("", buf, start, end);
      return;
    }
    if (tag === T_WWW) {
      this.literalAutolink("http://", buf, start, end);
      return;
    }
    if (tag === T_LIQUID) {
      kind = K_LIQUID_NODE;
      value = this.raw(ps, pe);
    } else if (tag === T_WIKI_LINK) {
      kind = K_WIKI_LINK;
      value = this.raw(ps + 2, pe > 2 ? pe - 2 : 0);
    } else if (tag === T_MATH) {
      let size = 0;
      while (start + size < end && (buf[start + size] | 0) === 36) size = size + 1;
      kind = K_INLINE_MATH;
      value = this.codeValue(ps + size, pe > size ? pe - size : 0);
    } else {
      let from = 0;
      let to = 0;
      if (esComment(buf, start, end)) {
        from = ecValueStart;
        to = ecValueEnd;
      }
      kind = K_ES_COMMENT;
      const at = tree.ownedBegin();
      tree.strings.append(buf, from, to);
      value = tree.ownedEnd(at);
    }
    if (this.isInImage()) {
      if (kind !== K_ES_COMMENT) {
        tree.resolve(value);
        this.alt.append(tree.rBuf, tree.rStart, tree.rEnd);
      }
      return;
    }
    const node = this.addSpan(kind);
    tree.value[node] = value;
  }
}

const NEWLINE = new Uint8Array([10]);

// ---------------------------------------------------------------------------------------------- entry

let builders: Builder[] = [];
let depth = 0;

// Fills `tree` with the syntax of `text`, in which every line break is `\n`, from `firstLine` on, which is where a line starts.
// Returns the root, or -1.
function parseLines(text: Uint8Array, tree: Tree, syntax: number, firstLine0: number, nulHint: number): number {
  tree.clear();
  tree.src = text;
  if (text.length >= 1 << 30) return -1;
  const root = tree.add(K_ROOT, 0, text.length);
  // The parser says where the lines start that it is given.
  const firstLine = firstLine0 < text.length ? firstLine0 : text.length;
  let from = 0;
  while (from < firstLine) {
    tree.addLineStart(from);
    let at = from;
    while (at < firstLine && (text[at] | 0) !== 10) at = at + 1;
    from = at >= firstLine ? firstLine : at + 1;
  }
  const isPlain = syntax === SY_PLAIN;
  const isMdx = syntax === SY_MDX;
  const options = parseOptions(isPlain, isMdx, syntax);
  while (builders.length <= depth) builders.push(new Builder());
  const builder = builders[depth];
  builder.reset(text, firstLine, tree, syntax, root, nulHint);
  depth = depth + 1;
  const sub = firstLine === 0 ? text : text.subarray(firstLine);
  renderWithExtensions(sub, options, builder, builder.ext);
  depth = depth - 1;
  return root;
}

const optionsCache: Options[] = [];

function parseOptions(isPlain: boolean, isMdx: boolean, syntax: number): Options {
  const key = syntax;
  let o = optionsCache[key];
  if (o === undefined) {
    o = new Options();
    o.tables = !isPlain;
    o.mathBlocks = !isPlain;
    o.footnotes = true;
    o.noSingleTilde = true;
    const isAsOxfmtReads = syntax === SY_WITH_DIRECTIVES || syntax === SY_TWO_LINES;
    o.directives = isAsOxfmtReads;
    // See `T_CHECK`.
    o.tasklists = false;
    o.micromark = true;
    o.mdx = isMdx;
    o.micromarkToTheLetter = !isAsOxfmtReads;
    optionsCache[key] = o;
  }
  return o;
}

export { Builder };
