// Port of vendor/bun/src/format/js/jsdoc/markdown.rs: descriptions, which are Markdown. They are parsed as that, and written the way
// prettier-plugin-jsdoc does.
import { Stack } from "../../../base/stack.ts";
import { FormatOptions, LINE_WRAPPING_BALANCE } from "../../options.ts";
import {
  F_ORDERED,
  K_BLOCKQUOTE,
  K_BREAK,
  K_CODE,
  K_DEFINITION,
  K_DELETE,
  K_EMPHASIS,
  K_FOOTNOTE_REFERENCE,
  K_HEADING,
  K_HTML,
  K_IMAGE,
  K_IMAGE_REFERENCE,
  K_INLINE_CODE,
  K_LINK,
  K_LINK_REFERENCE,
  K_LIST,
  K_LIST_ITEM,
  K_PARAGRAPH,
  K_ROOT,
  K_STRONG,
  K_TEXT,
  K_THEMATIC_BREAK,
  REFERENCE_COLLAPSED,
  REFERENCE_FULL,
  STR_NO,
  Tree,
} from "../../markdown/ast.ts";
import { parseContent } from "../../markdown/parse.ts";
import { decodeBytes, encodeString, isAllUnicodeWhitespace, trimUnicodeWhitespace, trimUnicodeWhitespaceStart, codePointAt, isUnicodeWhitespace, utf8Length } from "../../../base/ustr.ts";
import { formatEmbeddedJs, formatEmbeddedLanguage, isJsTsLang } from "./embedded.ts";
import { LineBuffer } from "./line_buffer.ts";
import { LM_LEGACY_ORDERED, LM_NONE, LM_ORDERED_ONE, LM_ORDERED_OTHER, LM_UNORDERED, listMarker } from "./markers.ts";
import { appendTrailingDot, capitalizeFirst } from "./normalize.ts";
import { isAsciiDigit, lines, parseIndex, spaces, trimStartMatchesCp } from "./text.ts";
import { formatTableBlock, wrapParagraph, wrapPlainParagraphs } from "./wrap.ts";

function isAsciiWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

// ───────────────────────────── is it Markdown at all ─────────────────────────────

/** Whether there is anything in `text` but paragraphs of plain text. */
function needsMarkdownParsing(text: string): boolean {
  // A hard line break.
  if (text.indexOf("  \n") >= 0) return true;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const byte = text.charCodeAt(i);
    const isLineStart = i === 0 || text.charCodeAt(i - 1) === 10;
    if (byte === 126 || byte === 92 || byte === 60) return true;
    if (byte === 42 || byte === 95) {
      const next = i + 1 < len ? text.charCodeAt(i + 1) : 32;
      const prev = i > 0 ? text.charCodeAt(i - 1) : 32;
      // With spaces on both sides it is a product, unless it starts a line: then it can start an item.
      if (!isAsciiWs(next) || !isAsciiWs(prev) || (byte === 42 && isLineStart && listMarker(text.substring(i), 0) === LM_UNORDERED)) return true;
      continue;
    }
    if (byte === 91) {
      if (i + 1 < len && text.charCodeAt(i + 1) === 94) return true;
      // `[text](url)` or `[text][ref]` on one line.
      let hasContent = false;
      for (let j = i + 1; j < len; j++) {
        const b = text.charCodeAt(j);
        if (b === 10) break;
        if (b === 93) {
          if (hasContent && j + 1 < len && (text.charCodeAt(j + 1) === 40 || text.charCodeAt(j + 1) === 91)) return true;
          break;
        }
        hasContent = hasContent || !isAsciiWs(b);
      }
      continue;
    }
    if (
      isLineStart &&
      (byte === 32 || byte === 35 || byte === 62 || byte === 45 || isAsciiDigit(byte) || byte === 124 || byte === 43)
    ) {
      // After an empty line or at the start. Only there can code start, or a list with another number than 1.
      const isBlockStart =
        i === 0 || (i >= 2 && text.charCodeAt(i - 2) === 10) || (i >= 3 && text.charCodeAt(i - 2) === 32 && text.charCodeAt(i - 3) === 10);
      let sp = 0;
      while (i + sp < len && text.charCodeAt(i + sp) === 32) sp = sp + 1;
      if (sp >= 4 && isBlockStart) return true;
      const start = i + sp;
      const at = start < len ? text.charCodeAt(start) : -1;
      if (at === 35 || at === 62) return true;
      if (at >= 48 && at <= 57) {
        const m = listMarker(text.substring(start), 0);
        if (m === LM_LEGACY_ORDERED) return true;
        if ((m === LM_ORDERED_ONE || m === LM_ORDERED_OTHER) && (isBlockStart || m === LM_ORDERED_ONE)) return true;
      } else if (at === 124) {
        // The row of a table starts and ends with a pipe.
        const nl = text.indexOf("\n", start);
        const lineEnd = nl < 0 ? len : nl;
        let line = text.substring(start + 1, lineEnd);
        let n = line.length;
        while (n > 0 && isAsciiWs(line.charCodeAt(n - 1))) n = n - 1;
        line = line.substring(0, n);
        if (line.endsWith("|")) return true;
      } else if ((at === 45 || at === 43 || at === 42) && listMarker(text.substring(start), 0) === LM_UNORDERED) return true;
      continue;
    }
    if (byte === 96 && text.startsWith("```", i)) return true;
  }
  return false;
}

// ───────────────────────────── before it is parsed ─────────────────────────────

/** What stands for a `{@link ...}` while the text is parsed starts with this. It looks like a word. */
const PLACEHOLDER_PREFIX = "\u0002JDLNK";

/** `1- foo` becomes `1. foo`. */
function normalizeLegacyOrderedListMarkers(text: string): string {
  const ls = lines(text);
  let changed = false;
  const out: string[] = [];
  for (let k = 0; k < ls.length; k++) {
    const line = ls[k];
    const trimmed = trimUnicodeWhitespaceStart(line);
    let digits = 0;
    while (digits < trimmed.length && isAsciiDigit(trimmed.charCodeAt(digits))) digits = digits + 1;
    let ok = digits > 0 && digits < 5 && digits < trimmed.length && trimmed.charCodeAt(digits) === 45;
    if (ok) {
      const after = digits + 1 < trimmed.length ? trimmed.charCodeAt(digits + 1) : -1;
      ok = after === 32 || after === 9 || after === 124;
    }
    let replaced = false;
    if (ok) {
      const rest = trimUnicodeWhitespaceStart(trimmed.substring(digits + 1));
      if (rest.length > 0) {
        out.push(line.substring(0, line.length - trimmed.length + digits) + ". " + rest);
        replaced = true;
      }
    }
    if (replaced) changed = true;
    else out.push(line);
  }
  return changed ? out.join("\n") : text;
}

/** `* ` at the start of a line becomes `- `, which cannot be emphasis. */
function convertStarListMarkers(text: string): string {
  if (text.indexOf("* ") < 0) return text;
  const ls = lines(text);
  let changed = false;
  const out: string[] = [];
  for (let k = 0; k < ls.length; k++) {
    const line = ls[k];
    const trimmed = trimUnicodeWhitespaceStart(line);
    if (trimmed.startsWith("* ")) {
      out.push(line.substring(0, line.length - trimmed.length) + "- " + trimmed.substring(2));
      changed = true;
    } else out.push(line);
  }
  return changed ? out.join("\n") : text;
}

/** The result of `protectJsdocLinks`. */
class Protected {
  text: string;
  placeholders: string[];
  constructor(text: string, placeholders: string[]) {
    this.text = text;
    this.placeholders = placeholders;
  }
}

/** Puts a placeholder of the same length in the place of each `{@link ...}`. Returns what they stand for. */
function protectJsdocLinks(text: string): Protected {
  if (text.indexOf("{@") < 0) return new Protected(text, []);
  let result = "";
  const placeholders: string[] = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    if (!text.startsWith("{@", i)) {
      result = result + text.charAt(i);
      i = i + 1;
      continue;
    }
    const start = i;
    let depth = 1;
    i = i + 2;
    while (i < len && depth > 0) {
      const c = text.charCodeAt(i);
      if (c === 123) depth = depth + 1;
      else if (c === 125) depth = depth - 1;
      i = i + 1;
    }
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63) i = i + 1;
      else break;
    }
    const original = text.substring(start, i);
    let placeholder = PLACEHOLDER_PREFIX + placeholders.length;
    // The placeholder is as long as what it stands for, in bytes.
    const want = utf8Length(original);
    while (placeholder.length < want) placeholder = placeholder + "\u0001";
    result = result + placeholder;
    placeholders.push(original);
  }
  return new Protected(result, placeholders);
}

function restorePlaceholders(text: string, placeholders: string[]): string {
  if (placeholders.length === 0 || text.indexOf(PLACEHOLDER_PREFIX) < 0) return text;
  let result = "";
  let rest = text;
  while (true) {
    const at = rest.indexOf(PLACEHOLDER_PREFIX);
    if (at < 0) break;
    const afterStart = at + PLACEHOLDER_PREFIX.length;
    let digits = 0;
    while (afterStart + digits < rest.length && isAsciiDigit(rest.charCodeAt(afterStart + digits))) digits = digits + 1;
    let index = -1;
    if (digits > 0) {
      const n = parseIndex(rest.substring(afterStart, afterStart + digits));
      if (n >= 0 && n < placeholders.length) index = n;
    }
    if (index >= 0) {
      result = result + rest.substring(0, at) + placeholders[index];
      let padding = 0;
      while (afterStart + digits + padding < rest.length && rest.charCodeAt(afterStart + digits + padding) === 1) padding = padding + 1;
      rest = rest.substring(afterStart + digits + padding);
    } else {
      result = result + rest.substring(0, at + 1);
      rest = rest.substring(at + 1);
    }
  }
  return result + rest;
}

// ───────────────────────────── the text of inline content ─────────────────────────────

/** Prettier's `getMinNotPresentContinuousCount`, for backticks. */
function minNotPresentBacktickRun(text: string): number {
  const present: boolean[] = [];
  let current = 0;
  for (let i = 0; i <= text.length; i++) {
    const byte = i < text.length ? text.charCodeAt(i) : 32;
    if (byte === 96) current = current + 1;
    else if (current > 0) {
      while (present.length <= current) present.push(false);
      present[current] = true;
      current = 0;
    }
  }
  for (let i = 1; i < present.length; i++) if (!present[i]) return i;
  return present.length > 1 ? present.length : 1;
}

function isBlockKind(kind: number): boolean {
  return (
    kind === K_PARAGRAPH ||
    kind === K_HEADING ||
    kind === K_LIST ||
    kind === K_CODE ||
    kind === K_BLOCKQUOTE ||
    kind === K_THEMATIC_BREAK ||
    kind === K_DEFINITION ||
    kind === K_HTML
  );
}

/** Whether `html` starts with a tag that has a name. */
function isInlineHtml(html: string): boolean {
  const t = trimUnicodeWhitespace(html);
  if (!t.startsWith("<")) return false;
  const rest = t.substring(1);
  const tagEnd = rest.indexOf(">");
  if (tagEnd < 0) return false;
  const name = trimStartMatchesCp(rest.substring(0, tagEnd), 47);
  if (name.length === 0) return false;
  const c = codePointAt(name, 0);
  return !(c < 128 && isAsciiWs(c)) && c !== 47;
}

class Serializer {
  tree: Tree;
  /** What has been parsed. */
  source: Uint8Array;
  maxWidth: number;
  capitalize: boolean;
  descriptionWithDot: boolean;
  preferCodeFences: boolean;
  isBalanced: boolean;
  formatOptions: FormatOptions;
  stack: Stack;

  constructor(tree: Tree, source: Uint8Array, maxWidth: number, capitalize: boolean, descriptionWithDot: boolean, preferCodeFences: boolean, isBalanced: boolean, formatOptions: FormatOptions, stack: Stack) {
    this.tree = tree;
    this.source = source;
    this.maxWidth = maxWidth;
    this.capitalize = capitalize;
    this.descriptionWithDot = descriptionWithDot;
    this.preferCodeFences = preferCodeFences;
    this.isBalanced = isBalanced;
    this.formatOptions = formatOptions;
    this.stack = stack;
  }

  kind(id: number): number {
    return id >= 0 && id < this.tree.n ? this.tree.kind[id] | 0 : -1;
  }

  str(h: number): string {
    if (h === STR_NO) return "";
    this.tree.src = this.source;
    this.tree.resolve(h);
    return decodeBytes(this.tree.rBuf, this.tree.rStart, this.tree.rEnd);
  }

  childrenOf(id: number): number[] {
    const out: number[] = [];
    let c = this.tree.firstChild[id] | 0;
    while (c >= 0) {
      out.push(c);
      c = this.tree.next[c] | 0;
    }
    return out;
  }

  collectChildren(id: number, insideLink: boolean): string {
    if (!this.stack.enter()) return "";
    let out = "";
    const cs = this.childrenOf(id);
    for (let i = 0; i < cs.length; i++) out = out + this.collectInline(cs[i], insideLink);
    this.stack.leave();
    return out;
  }

  inlineTextOfChildren(id: number): string {
    return this.collectChildren(id, false);
  }

  /** `](url "title")` */
  pushDestination(id: number): string {
    let out = "](" + this.str(this.tree.value[id] | 0);
    const second = this.tree.second[id] | 0;
    if (second !== STR_NO) out = out + ' "' + this.str(second) + '"';
    return out + ")";
  }

  /** `][label]` */
  pushReference(id: number): string {
    let out = "]";
    const rt = this.tree.referenceType[id] | 0;
    if (rt === REFERENCE_COLLAPSED) out = out + "[]";
    else out = out + "[" + this.str(this.tree.value[id] | 0) + "]";
    return out;
  }

  /** Inline content as it is to be written. */
  collectInline(id: number, insideLink: boolean): string {
    const kind = this.kind(id);
    if (kind < 0) return "";
    switch (kind) {
      case K_TEXT:
      case K_HTML:
        return this.str(this.tree.value[id] | 0);
      case K_EMPHASIS:
        return "_" + this.collectChildren(id, insideLink) + "_";
      case K_STRONG:
        return "**" + this.collectChildren(id, insideLink) + "**";
      case K_DELETE:
        return "~~" + this.collectChildren(id, insideLink) + "~~";
      case K_INLINE_CODE: {
        const value = this.str(this.tree.value[id] | 0);
        const delimiterLen = minNotPresentBacktickRun(value);
        const isBlankAt = (c: number): boolean => c === 32 || c === 10;
        let anyNonBlank = false;
        for (let i = 0; i < value.length; i++) if (!isBlankAt(value.charCodeAt(i))) anyNonBlank = true;
        const needsPadding =
          value.startsWith("`") ||
          value.endsWith("`") ||
          (value.length > 0 && isBlankAt(value.charCodeAt(0)) && isBlankAt(value.charCodeAt(value.length - 1)) && anyNonBlank);
        let ticks = "";
        for (let i = 0; i < delimiterLen; i++) ticks = ticks + "`";
        return ticks + (needsPadding ? " " : "") + value + (needsPadding ? " " : "") + ticks;
      }
      // A link in the text of a link.
      case K_LINK:
        if (insideLink) return this.collectChildren(id, true);
        return "[" + this.collectChildren(id, true) + this.pushDestination(id);
      case K_LINK_REFERENCE:
        return "[" + this.collectChildren(id, insideLink) + this.pushReference(id);
      case K_IMAGE:
        return "![" + this.str(this.tree.third[id] | 0) + this.pushDestination(id);
      case K_IMAGE_REFERENCE:
        return "![" + this.str(this.tree.third[id] | 0) + this.pushReference(id);
      case K_BREAK:
        return " ";
      case K_FOOTNOTE_REFERENCE:
        return "[^" + this.str(this.tree.value[id] | 0) + "]";
      // Of anything else: the text in it.
      default:
        return this.collectChildren(id, insideLink);
    }
  }

  // ───────────────────────────── blocks ─────────────────────────────

  /** Pushes the lines of a paragraph that has been broken into lines. */
  pushParagraphLines(paragraph: string, indent: number, out: LineBuffer): void {
    const parts = paragraph.split("\n");
    const count = parts.length;
    for (let index = 0; index < count; index++) {
      let line = parts[index];
      if (indent === 0 && this.capitalize && index === 0) line = capitalizeFirst(line);
      if (this.descriptionWithDot && index + 1 === count && !(indent > 0 && line.length === 0)) line = appendTrailingDot(line);
      out.beginLine();
      if (line.length > 0) out.append(spaces(indent));
      out.append(line);
    }
  }

  wrapAndPush(text: string, indent: number, firstLineOffset: number, out: LineBuffer): void {
    const paragraph = new LineBuffer();
    wrapParagraph(text, this.maxWidth > indent ? this.maxWidth - indent : 0, firstLineOffset, 0, paragraph);
    this.pushParagraphLines(paragraph.intoBytes(), indent, out);
  }

  /** The children of `id`, with empty lines between blocks. */
  serializeChildren(id: number, indent: number, firstParagraphOffset: number, out: LineBuffer): void {
    const children = this.childrenOf(id);
    const kind = (index: number): number => (index < children.length ? this.kind(children[index]) : -1);
    let i = 0;
    while (i < children.length) {
      // `<div>` in a sentence is taken for the start of a block of HTML. A run of paragraphs and of such HTML is one paragraph.
      if (kind(i) === K_PARAGRAPH || kind(i) === K_HTML) {
        let hasHtml = kind(i) === K_HTML;
        let runEnd = i + 1;
        while (true) {
          const k = kind(runEnd);
          if (k === K_PARAGRAPH) {
            // part of the run
          } else if (k === K_HTML && isInlineHtml(this.str(this.tree.value[children[runEnd]] | 0))) {
            hasHtml = true;
          } else break;
          runEnd = runEnd + 1;
        }
        if (hasHtml && runEnd - i > 1) {
          if (i > 0 && !out.lastIsEmpty()) out.pushEmpty();
          let merged = "";
          for (let c = i; c < runEnd; c++) {
            const child = children[c];
            if (merged.length > 0 && !merged.endsWith(" ")) merged = merged + " ";
            if (this.kind(child) === K_HTML) merged = merged + trimUnicodeWhitespace(this.str(this.tree.value[child] | 0));
            else merged = merged + trimUnicodeWhitespace(this.inlineTextOfChildren(child));
          }
          this.wrapAndPush(merged, indent, i === 0 ? firstParagraphOffset : 0, out);
          i = runEnd;
          continue;
        }
      }
      if (i > 0 && isBlockKind(kind(i)) && !out.lastIsEmpty()) out.pushEmpty();
      this.serializeNode(children[i], indent, i === 0 ? firstParagraphOffset : 0, out);
      i = i + 1;
    }
  }

  serializeNode(id: number, indent: number, firstParagraphOffset: number, out: LineBuffer): void {
    if (!this.stack.enter()) return;
    this.serializeNodeInner(id, indent, firstParagraphOffset, out);
    this.stack.leave();
  }

  serializeNodeInner(id: number, indent: number, firstParagraphOffset: number, out: LineBuffer): void {
    const kind = this.kind(id);
    if (kind < 0) return;
    switch (kind) {
      case K_ROOT:
        this.serializeChildren(id, indent, 0, out);
        return;
      case K_PARAGRAPH:
        this.serializeParagraph(id, indent, firstParagraphOffset, out);
        return;
      case K_HEADING: {
        if (!out.isEmpty() && !out.lastIsEmpty()) out.pushEmpty();
        const text = this.inlineTextOfChildren(id);
        out.beginLine();
        let hashes = "";
        const depth = this.tree.number[id] | 0;
        for (let i = 0; i < depth; i++) hashes = hashes + "#";
        out.append(hashes + " " + text);
        return;
      }
      case K_LIST:
        this.serializeList(id, indent, out);
        return;
      // Items are written with their list. A thematic break goes away.
      case K_LIST_ITEM:
      case K_THEMATIC_BREAK:
        return;
      case K_CODE:
        this.serializeCode(id, out);
        return;
      case K_BLOCKQUOTE: {
        const cs = this.childrenOf(id);
        for (let index = 0; index < cs.length; index++) {
          if (index > 0) out.pushEmpty();
          const inner = new LineBuffer();
          this.serializeNode(cs[index], 0, 0, inner);
          const ls = inner.intoBytes().split("\n");
          for (let k = 0; k < ls.length; k++) {
            out.beginLine();
            out.append(ls[k].length === 0 ? ">" : "> ");
            out.append(ls[k]);
          }
        }
        return;
      }
      case K_DEFINITION: {
        out.beginLine();
        const third = this.tree.third[id] | 0;
        out.append("[" + this.str(third) + "]: " + this.str(this.tree.value[id] | 0));
        return;
      }
      case K_HTML: {
        const ls = lines(this.str(this.tree.value[id] | 0));
        for (let i = 0; i < ls.length; i++) out.push(ls[i]);
        return;
      }
      default: {
        const text = this.collectInline(id, false);
        if (text.length > 0) out.push(text);
        return;
      }
    }
  }

  serializeParagraph(id: number, indent: number, firstLineOffset: number, out: LineBuffer): void {
    const start = this.tree.start[id] | 0;
    const end = this.tree.end[id] | 0;
    const raw = decodeBytes(this.source, start, end);
    if (this.serializePipePrefixedParagraph(raw, indent, out)) return;
    // Each part that ends with a hard line break is a line.
    const cs = this.childrenOf(id);
    let hasBreak = false;
    for (let i = 0; i < cs.length; i++) if (this.kind(cs[i]) === K_BREAK) hasBreak = true;
    if (hasBreak) {
      let segment = "";
      for (let i = 0; i < cs.length; i++) {
        const child = cs[i];
        if (this.kind(child) !== K_BREAK) {
          segment = segment + this.collectInline(child, false);
          continue;
        }
        const text = indent === 0 && this.capitalize && out.isEmpty() ? capitalizeFirst(trimUnicodeWhitespace(segment)) : trimUnicodeWhitespace(segment);
        out.beginLine();
        out.append(spaces(indent) + text + "\\");
        segment = "";
      }
      if (!isAllUnicodeWhitespace(segment)) {
        out.beginLine();
        out.append(spaces(indent) + trimUnicodeWhitespace(segment));
      }
      return;
    }
    if (this.isBalanced) {
      const effectiveWidth = this.maxWidth > indent ? this.maxWidth - indent : 0;
      const originalLines: string[] = [];
      const ls = lines(raw);
      for (let i = 0; i < ls.length; i++) {
        const t = trimUnicodeWhitespace(ls[i]);
        if (t.length > 0) originalLines.push(t);
      }
      let allFit = originalLines.length > 1;
      for (let i = 0; i < originalLines.length; i++) if (originalLines[i].length > effectiveWidth) allFit = false;
      if (allFit) {
        for (let index = 0; index < originalLines.length; index++) {
          let line = originalLines[index];
          if (index === 0 && this.capitalize) line = capitalizeFirst(line);
          if (index + 1 === originalLines.length && this.descriptionWithDot) line = appendTrailingDot(line);
          out.beginLine();
          out.append(spaces(indent) + line);
        }
        return;
      }
    }
    this.wrapAndPush(this.inlineTextOfChildren(id), indent, firstLineOffset, out);
  }

  /** A paragraph with rows of a table in it, which is not parsed as one. Returns whether `raw` is such a paragraph. */
  serializePipePrefixedParagraph(raw: string, indent: number, out: LineBuffer): boolean {
    const isRow = (line: string): boolean => {
      const trimmed = trimUnicodeWhitespaceStart(line);
      return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2;
    };
    const rawLines = lines(raw);
    let anyRow = false;
    for (let i = 0; i < rawLines.length; i++) if (isRow(rawLines[i])) anyRow = true;
    if (!anyRow) return false;
    let index = 0;
    let emittedSegment = false;
    while (true) {
      while (index < rawLines.length && isAllUnicodeWhitespace(rawLines[index])) index = index + 1;
      if (index >= rawLines.length) return true;
      if (emittedSegment && !out.lastIsEmpty()) out.pushEmpty();
      const first = rawLines[index];
      const isTable = isRow(first);
      const start = index;
      while (index < rawLines.length && isRow(rawLines[index]) === isTable) index = index + 1;
      const segment = rawLines.slice(start, index);
      if (isTable) {
        const formatted = formatTableBlock(segment);
        for (let i = 0; i < formatted.length; i++) {
          out.beginLine();
          if (formatted[i].length > 0) out.append(spaces(indent));
          out.append(formatted[i]);
        }
      } else {
        const parts: string[] = [];
        for (let i = 0; i < segment.length; i++) {
          const t = trimUnicodeWhitespace(segment[i]);
          if (t.length > 0) parts.push(t);
        }
        if (parts.length === 0) continue;
        const paragraph = new LineBuffer();
        wrapParagraph(parts.join(" "), this.maxWidth > indent ? this.maxWidth - indent : 0, 0, 0, paragraph);
        const ls = paragraph.intoBytes().split("\n");
        for (let k = 0; k < ls.length; k++) {
          out.beginLine();
          out.append(spaces(indent));
          out.append(indent === 0 && this.capitalize && k === 0 ? capitalizeFirst(ls[k]) : ls[k]);
        }
      }
      emittedSegment = true;
    }
  }

  serializeList(id: number, indent: number, out: LineBuffer): void {
    const ordered = ((this.tree.flags[id] | 0) & F_ORDERED) !== 0;
    let counter = ordered ? this.tree.number[id] | 0 : 1;
    const items = this.childrenOf(id);
    for (let it = 0; it < items.length; it++) {
      const item = items[it];
      if (this.kind(item) !== K_LIST_ITEM) continue;
      let marker = "- ";
      if (ordered) {
        marker = counter + ". ";
        counter = counter + 1;
      }
      const markerWidth = marker.length;
      const kids = this.childrenOf(item);
      for (let childIndex = 0; childIndex < kids.length; childIndex++) {
        const child = kids[childIndex];
        const kind = this.kind(child);
        if (childIndex === 0) {
          const ls = this.serializeNodeForListItem(child, markerWidth, true).split("\n");
          for (let lineIndex = 0; lineIndex < ls.length; lineIndex++) {
            const line = ls[lineIndex];
            out.beginLine();
            if (lineIndex === 0) {
              out.append(spaces(indent) + marker + (this.capitalize ? capitalizeFirst(line) : line));
            } else if (line.length > 0) {
              out.append(spaces(indent) + line);
            }
          }
          continue;
        }
        if (isBlockKind(kind) && !out.lastIsEmpty()) out.pushEmpty();
        if (kind === K_DEFINITION) this.serializeNode(child, 0, 0, out);
        // A list in an item is under what is in the item.
        else if (kind === K_LIST) {
          const nestedIndent = indent + markerWidth + (indent === 0 ? 0 : markerWidth);
          this.serializeNode(child, nestedIndent, 0, out);
        } else {
          const ls = this.serializeNodeForListItem(child, markerWidth, false).split("\n");
          for (let k = 0; k < ls.length; k++) {
            out.beginLine();
            if (ls[k].length > 0) out.append(spaces(indent + markerWidth) + ls[k]);
          }
        }
      }
    }
  }

  /** What is in an item of a list. Of the first paragraph, all lines but the first are indented by the width of the marker. */
  serializeNodeForListItem(id: number, markerWidth: number, isFirstChild: boolean): string {
    const buffer = new LineBuffer();
    if (this.kind(id) === K_PARAGRAPH) {
      const continuationIndent = isFirstChild ? markerWidth : 0;
      wrapParagraph(this.inlineTextOfChildren(id), this.maxWidth, 0, continuationIndent, buffer);
    } else this.serializeNode(id, 0, 0, buffer);
    return buffer.intoBytes();
  }

  serializeCode(id: number, out: LineBuffer): void {
    if (!out.isEmpty() && !out.lastIsEmpty()) out.pushEmpty();
    const value = this.str(this.tree.value[id] | 0);
    const second = this.tree.second[id] | 0;
    const hasLang = second !== STR_NO;
    const lang = hasLang ? this.str(second) : "";
    const width = this.maxWidth > 4 ? this.maxWidth - 4 : 0;
    let formatted: string | null = null;
    if (hasLang && !isJsTsLang(lang)) formatted = formatEmbeddedLanguage(lang, value, width, this.formatOptions);
    else formatted = formatEmbeddedJs(value, width, this.formatOptions);
    const text = formatted === null ? value : formatted;
    if (lang.length > 0 || this.preferCodeFences) {
      out.push("```" + lang);
      const ls = lines(text);
      for (let i = 0; i < ls.length; i++) out.push(ls[i]);
      out.push("```");
      return;
    }
    // Without a language it is indented by four spaces, and by no more.
    const ls = lines(text);
    let minIndent = -1;
    for (let i = 0; i < ls.length; i++) {
      if (isAllUnicodeWhitespace(ls[i])) continue;
      const ind = ls[i].length - trimUnicodeWhitespaceStart(ls[i]).length;
      if (minIndent < 0 || ind < minIndent) minIndent = ind;
    }
    if (minIndent < 0) minIndent = 0;
    for (let i = 0; i < ls.length; i++) {
      out.beginLine();
      if (ls[i].length > 0) {
        out.append("    ");
        out.append(minIndent <= ls[i].length ? ls[i].substring(minIndent) : ls[i]);
      }
    }
  }
}

/** `text` in lines of at most `maxWidth` columns, the first `tagStringLength` less. */
export function formatDescription(text: string, maxWidth: number, tagStringLength: number, capitalize: boolean, formatOptions: FormatOptions, stack: Stack): string {
  if (isAllUnicodeWhitespace(text)) return "";
  const jsdocOptions = formatOptions.jsdoc;
  const descriptionWithDot = jsdocOptions !== null && jsdocOptions.descriptionWithDot;
  const isBalanced = jsdocOptions !== null && jsdocOptions.lineWrappingStyle === LINE_WRAPPING_BALANCE;

  if (tagStringLength === 0 && !needsMarkdownParsing(text)) {
    const result = wrapPlainParagraphs(text, maxWidth, isBalanced);
    if (!capitalize && !descriptionWithDot) return result;
    // The first word of each paragraph gets the capital letter, the last line the dot.
    let out = "";
    const ls = result.split("\n");
    let atParagraphStart = true;
    for (let i = 0; i < ls.length; i++) {
      if (i > 0) out = out + "\n";
      const isLastInParagraph = i + 1 >= ls.length || ls[i + 1].length === 0;
      let line = ls[i];
      if (capitalize && atParagraphStart) line = capitalizeFirst(line);
      atParagraphStart = line.length === 0;
      if (descriptionWithDot && isLastInParagraph) line = appendTrailingDot(line);
      out = out + line;
    }
    return out;
  }

  const t1 = normalizeLegacyOrderedListMarkers(text);
  const t2 = convertStarListMarkers(t1);
  const prot = protectJsdocLinks(t2);
  const tree = new Tree();
  const bytes = encodeString(prot.text);
  const root = parseContent(bytes, tree, true);
  if (root < 0) {
    const ls = lines(t2);
    const trimmed: string[] = [];
    for (let i = 0; i < ls.length; i++) trimmed.push(trimUnicodeWhitespace(ls[i]));
    return trimmed.join("\n");
  }
  tree.src = bytes;
  const serializer = new Serializer(tree, bytes, maxWidth, capitalize, descriptionWithDot, jsdocOptions !== null && jsdocOptions.preferCodeFences, isBalanced, formatOptions, stack);
  const out = new LineBuffer();
  serializer.serializeChildren(root, 0, tagStringLength, out);
  return restorePlaceholders(out.intoBytes(), prot.placeholders);
}

void LM_NONE;
void isUnicodeWhitespace;
