// Port of vendor/bun/src/format/handlebars/printer.rs: Prettier's `language-handlebars/printer-glimmer.js`. It writes the
// parts of the document one after the other (to the `Elements` of `css/doc.ts`).
//
// Where what Prettier prints is read as something else than the template, a comment says what Prettier does.
//
// A `&[NodeId]` is `(start, len)` in `tree.lists`; a `&[u8]` is `(buf, a, b)`.
import { Stack } from "../../base/stack.ts";
import { Elements, LINE_LITERAL, LINE_SOFT, LINE_SPACE } from "../css/doc.ts";
import { DOC_EMPTY, docPool, docPop, docPush, textToDoc } from "../css/doc.ts";
import { hasIndentedDelimiter, parseFrontMatter } from "../front_matter.ts";
import { EMBEDDED_OFF, FormatOptions, HTML_WS_IGNORE, QUOTE_SINGLE } from "../options.ts";
import { jsWhitespaceLen, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  CHAINED,
  CLOSE_CLOSE,
  CLOSE_OPEN,
  H_AT,
  H_THIS,
  H_VAR,
  INVERSE_CLOSE,
  INVERSE_OPEN,
  K_ATTR,
  K_BLOCK,
  K_BLOCK_STATEMENT,
  K_BOOLEAN,
  K_COMMENT,
  K_CONCAT,
  K_DOCTYPE,
  K_ELEMENT,
  K_ELEMENT_MODIFIER,
  K_FRONT_MATTER,
  K_HASH_PAIR,
  K_MUSTACHE,
  K_MUSTACHE_COMMENT,
  K_NOTHING,
  K_NULL,
  K_NUMBER,
  K_PATH,
  K_STRING,
  K_SUB_EXPRESSION,
  K_TEMPLATE,
  K_TEXT,
  K_UNDEFINED,
  NOTHING,
  OPEN_CLOSE,
  OPEN_OPEN,
  Tree,
} from "./ast.ts";
import { cssDocument, yamlDocument } from "./embed.ts";
import { idLen } from "./lexer.ts";
import { isVoidTag } from "./tokenizer.ts";

// `Parent`: what a text is in.
const P_TEMPLATE: number = 0;
const P_BLOCK: number = 1;
const P_ELEMENT: number = 2;
const P_STYLE: number = 3;

// `Escapes`: what of a text is not written as the tree has it.
const ESC_NOTHING: number = 0;
// `{{`: a mustache in a text has been escaped.
const ESC_MUSTACHES: number = 1;
// And the quote that the text is in.
const ESC_MUSTACHES_AND_QUOTE: number = 2;

export function isHtmlWhiteSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13 && c !== 11);
}

// The start of `buf[a, b)` without its ASCII white space.
export function trimAsciiStart(buf: Uint8Array, a: number, b: number): number {
  let i = a | 0;
  const e = b | 0;
  while (i < e) {
    const c = buf[i] | 0;
    if (!(c === 32 || (c >= 9 && c <= 13 && c !== 11))) break;
    i = ((i | 0) + 1) | 0;
  }
  return i;
}

// The end of `buf[a, b)` without its ASCII white space.
export function trimAsciiEnd(buf: Uint8Array, a: number, b: number): number {
  let i = b | 0;
  const e = a | 0;
  while (i > e) {
    const c = buf[(i - 1) | 0] | 0;
    if (!(c === 32 || (c >= 9 && c <= 13 && c !== 11))) break;
    i = ((i | 0) - 1) | 0;
  }
  return i;
}

// The index of the first ASCII white space of `buf[a, b)`, or `b`.
function indexOfWhiteSpace(buf: Uint8Array, a: number, b: number): number {
  let i = a | 0;
  const e = b | 0;
  while (i < e) {
    const c = buf[i] | 0;
    if (c === 32 || (c >= 9 && c <= 13 && c !== 11)) break;
    i = ((i | 0) + 1) | 0;
  }
  return i;
}

function countByte(buf: Uint8Array, a: number, b: number, byte: number): number {
  let n = 0;
  const e = b | 0;
  const x = byte | 0;
  for (let i = a | 0; i < e; i++) {
    if ((buf[i] | 0) === x) n = ((n | 0) + 1) | 0;
  }
  return n;
}

function indexOfByteIn(buf: Uint8Array, a: number, b: number, byte: number): number {
  const e = b | 0;
  const x = byte | 0;
  for (let i = a | 0; i < e; i++) {
    if ((buf[i] | 0) === x) return i;
  }
  return -1;
}

// `buf[at..]` starts with the printable-ASCII `lit`, before `b`.
function startsWithAscii(buf: Uint8Array, at: number, b: number, lit: string): boolean {
  const n = lit.length;
  if (at + n > b) return false;
  for (let i = 0; i < n; i++) {
    if ((buf[at + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

// The first `lit` in `buf[a, b)`, or -1.
function indexOfAscii(buf: Uint8Array, a: number, b: number, lit: string): number {
  const n = lit.length;
  const first = lit.charCodeAt(0) | 0;
  const last = (b - n) | 0;
  for (let i = a | 0; i <= last; i++) {
    if ((buf[i] | 0) === first && startsWithAscii(buf, i, b, lit)) return i;
  }
  return -1;
}

function eqAscii(buf: Uint8Array, a: number, b: number, lit: string): boolean {
  return b - a === lit.length && startsWithAscii(buf, a, b, lit);
}

// `string.toUpperCase() === string`, for the first UTF-16 code unit of the name of a tag.
function startsWithUpperCase(buf: Uint8Array, a: number, b: number): boolean {
  if (a >= b) return true;
  const c = buf[a] | 0;
  return !(c >= 97 && c <= 122);
}

// `-1`, which is a name only in brackets.
function isNegativeNumber(buf: Uint8Array, a: number, b: number): boolean {
  if (b - a < 2 || (buf[a] | 0) !== 45) return false;
  for (let i = a + 1; i < b; i++) {
    const c = buf[i] | 0;
    if (c < 48 || c > 57) return false;
  }
  return true;
}

const PF_BRACKETS: number = 1;
const PF_READABLE: number = 2;

// `isPathExpressionPartNeedBrackets` (PF_BRACKETS) and whether the part is read as printed (PF_READABLE) of the part
// `buf[a, b)` of a path, with one look at it.
function partFlags(buf: Uint8Array, a: number, b: number, isFirst: boolean): number {
  const len = (b - a) | 0;
  const c0 = len > 0 ? buf[a] | 0 : 0;
  if (isFirst && c0 === 64) {
    // The rest is a name.
    return len > 1 && idLen(buf, a + 1, b) === len - 1 ? PF_READABLE : 0;
  }
  const full = idLen(buf, a, b) === len;
  let brackets = !full || (c0 >= 48 && c0 <= 57);
  if (!isFirst && !brackets && len >= 4 && len <= 9 && (c0 === 116 || c0 === 102 || c0 === 110 || c0 === 117)) {
    brackets = eqAscii(buf, a, b, "true") || eqAscii(buf, a, b, "false") || eqAscii(buf, a, b, "null") || eqAscii(buf, a, b, "undefined");
  }
  if (brackets) {
    for (let i = a | 0; i < b; i++) {
      const c = buf[i] | 0;
      if (c === 93 || c === 92 || c === 10 || c === 13) return PF_BRACKETS;
      if (c === 0xe2 && i + 2 < b && (buf[i + 1] | 0) === 0x80) {
        const d = buf[i + 2] | 0;
        if (d === 0xa8 || d === 0xa9) return PF_BRACKETS;
      }
    }
    return PF_BRACKETS | PF_READABLE;
  }
  if (isFirst) return len > 0 ? PF_READABLE : 0;
  return len > 0 && !(len === 4 && eqAscii(buf, a, b, "this")) && !(c0 === 45 && isNegativeNumber(buf, a, b)) ? PF_READABLE : 0;
}

// `getPreferredQuote`, for a text that has so many quotes.
function preferredQuote(double: number, single: number, prefersSingle: boolean): string {
  const isSingle = prefersSingle ? single <= double : double > single;
  return isSingle ? "'" : '"';
}

const BACKSLASH = new Uint8Array(1);
BACKSLASH[0] = 92;

export class Printer {
  tree: Tree;
  // `options.originalText`, with blanks in the place of the front matter.
  source: Uint8Array;
  // The text, the front matter is `frontMatterBuf[0, frontMatterEnd)`.
  frontMatterBuf: Uint8Array;
  frontMatterEnd: number;
  options: FormatOptions;
  // `options.htmlWhitespaceSensitivity !== "ignore"`
  isWhiteSpaceSensitive: boolean;
  singleQuote: boolean;
  out: Elements;
  // How many elements are around what is being printed in which all white space counts.
  preDepth: number;
  stack: Stack;
  // The result of `headName`.
  hnS: number;
  hnL: number
  // The result of `bodyOf`.
  bodyS: number;
  bodyL: number;
  bodyBpS: number;
  bodyBpL: number;
  // The result of `isReadAsPrinted`: flags of the first part of a path, of its other parts.
  pfFirst: number;
  pfBrk: Uint8Array;

  constructor() {
    this.tree = new Tree();
    this.source = new Uint8Array(0);
    this.frontMatterBuf = new Uint8Array(0);
    this.frontMatterEnd = 0;
    this.options = new FormatOptions();
    this.isWhiteSpaceSensitive = true;
    this.singleQuote = false;
    this.out = new Elements();
    this.preDepth = 0;
    this.stack = Stack.forTree();
    this.hnS = 0;
    this.hnL = 0;
    this.bodyS = 0;
    this.bodyL = 0;
    this.bodyBpS = 0;
    this.bodyBpL = 0;
    this.pfFirst = 0;
    this.pfBrk = new Uint8Array(16);
  }

  // Sets the printer up for a template.
  init(
    tree: Tree,
    source: Uint8Array,
    frontMatterBuf: Uint8Array,
    frontMatterEnd: number,
    options: FormatOptions,
    out: Elements,
  ): void {
    this.tree = tree;
    this.source = source;
    this.frontMatterBuf = frontMatterBuf;
    this.frontMatterEnd = frontMatterEnd;
    this.options = options;
    this.isWhiteSpaceSensitive = options.htmlWhitespaceSensitivity !== HTML_WS_IGNORE;
    this.singleQuote = options.quoteStyle === QUOTE_SINGLE;
    this.out = out;
    this.preDepth = 0;
    this.stack = Stack.forTree();
  }

  token(text: string): void {
    this.out.token(text);
  }

  startGroup(): void {
    this.out.startPlainGroup(false);
  }

  startIndent(): void {
    this.out.startIndent();
  }

  // `generateHardlines`
  hardLines(count: number): void {
    const n = count < 2 ? count : 2;
    for (let i = 0; i < n; i++) this.out.hardLine();
  }

  // A `line`, or as many `hardline`s as `whiteSpace` has line breaks, two at most. `isDedented`: each in a `dedent`.
  breaks(buf: Uint8Array, a: number, b: number, isDedented: boolean): void {
    const newLines = countByte(buf, a, b, 10);
    const times = newLines < 1 ? 1 : newLines > 2 ? 2 : newLines;
    for (let i = 0; i < times; i++) {
      if (isDedented) this.out.startDedent();
      if (newLines === 0) this.out.line(LINE_SPACE);
      else this.out.hardLine();
      if (isDedented) this.out.endIndent();
    }
  }

  // A text that can have line breaks in it. For a block of code in Markdown, Prettier makes `literalline`s of them.
  verbatim(buf: Uint8Array, a: number, b: number): void {
    if (this.options.isInMarkdown) this.withLiteralLines(buf, a, b, ESC_NOTHING, 0);
    else this.out.text(buf, a, b);
  }

  // `replaceEndOfLine(text)`
  withLiteralLines(buf: Uint8Array, a: number, b: number, escapes: number, quote: number): void {
    let lineStart = a;
    let first = true;
    while (true) {
      let nl = indexOfByteIn(buf, lineStart, b, 10);
      const lineEnd = nl < 0 ? b : nl;
      if (!first) {
        this.out.line(LINE_LITERAL);
        this.out.breakParent();
      }
      first = false;
      this.withEscapes(buf, lineStart, lineEnd, escapes, quote);
      if (nl < 0) break;
      lineStart = nl + 1;
    }
  }

  withEscapes(buf: Uint8Array, a: number, b: number, escapes: number, quote: number): void {
    if (escapes === ESC_NOTHING) {
      this.out.text(buf, a, b);
    } else if (escapes === ESC_MUSTACHES) {
      this.escaped(buf, a, b);
    } else {
      // Prettier writes the quote.
      let from = a;
      while (true) {
        const at = indexOfByteIn(buf, from, b, quote);
        if (at < 0) break;
        this.escaped(buf, from, at);
        this.token(quote === 34 ? "&quot;" : "&apos;");
        from = at + 1;
      }
      this.escaped(buf, from, b);
    }
  }

  // `text.replaceAll("{{", "\\{{")`: a mustache in a text has been escaped.
  escaped(buf: Uint8Array, a: number, b: number): void {
    let from = a;
    while (true) {
      const at = indexOfAscii(buf, from, b, "{{");
      if (at < 0) break;
      this.out.text(buf, from, at);
      this.token("\\{{");
      from = at + 2;
    }
    this.out.text(buf, from, b);
  }

  fillSeparator(): void {
    this.out.startItem();
    this.out.line(LINE_SPACE);
    this.out.endItem();
  }

  fillEmpty(): void {
    this.out.startItem();
    this.out.endItem();
  }

  // `fill(getTextValueParts(text))`, where `text` is `words` with `blanks` around it.
  fill(buf: Uint8Array, a: number, b: number, blankBefore: boolean, blankBehind: boolean): void {
    this.out.startFill();
    if (blankBefore) {
      this.fillEmpty();
      this.fillSeparator();
    }
    const noBrace = indexOfByteIn(buf, a, b, 123) < 0;
    let rest = a;
    while (true) {
      const stop = indexOfWhiteSpace(buf, rest, b);
      this.out.startItem();
      if (noBrace) this.out.text(buf, rest, stop);
      else this.escaped(buf, rest, stop);
      this.out.endItem();
      rest = stop;
      if (rest >= b) break;
      this.fillSeparator();
      rest = trimAsciiStart(buf, rest, b);
    }
    if (blankBehind) {
      this.fillSeparator();
      this.fillEmpty();
    }
    this.out.endFill();
  }

  // ----------------------------------------------------------------------------------------- utilities.js

  // `isWhitespaceNode`. For Prettier it is what is white space in JavaScript: a no-break space too, which is none in
  // HTML.
  isWhiteSpaceNode(node: number): boolean {
    const tree = this.tree;
    if ((tree.tag[node] | 0) !== K_TEXT) return false;
    const s = tree.f0[node] | 0;
    const l = tree.f1[node] | 0;
    const buf = tree.buf;
    const a = s;
    return trimAsciiStart(buf, a, a + l) >= a + l;
  }

  areWhiteSpace(listStart: number, listLen: number): boolean {
    const lists = this.tree.lists;
    for (let i = 0; i < listLen; i++) {
      if (!this.isWhiteSpaceNode(lists[listStart + i] | 0)) return false;
    }
    return true;
  }

  // `isVoidElement`. For Prettier `<imG>` is `<img>`, whatever is in it.
  isVoidElement(buf: Uint8Array, a: number, b: number, childStart: number, childLen: number, isSelfClosing: boolean): boolean {
    if (isSelfClosing) return true;
    let isVoid = false;
    // `isVoidTag(tag.toLowerCase()) && !startsWithUpperCase(tag)`: it starts with a lower case letter.
    const c0 = a < b ? buf[a] | 0 : 0;
    if (c0 >= 97 && c0 <= 122) isVoid = isVoidTagIgnoreCase(buf, a, b);
    if (!isVoid) {
      isVoid = !(c0 === 58 && b > a) && (startsWithUpperCase(buf, a, b) || indexOfByteIn(buf, a, b, 46) >= 0);
    }
    return isVoid && this.areWhiteSpace(childStart, childLen);
  }

  // `isPrettierIgnoreNode`
  isPrettierIgnore(node: number): boolean {
    const tree = this.tree;
    if ((tree.tag[node] | 0) !== K_MUSTACHE_COMMENT) return false;
    const s = tree.f0[node] | 0;
    const l = tree.f1[node] | 0;
    const buf = tree.buf;
    const a = s;
    const b = a + l;
    const from = trimJsWhitespaceStart(buf, a, b);
    const to = trimJsWhitespaceEnd(buf, from, b);
    return eqAscii(buf, from, to, "prettier-ignore");
  }

  // What is ignored is printed as it is written.
  ignored(node: number): void {
    const tree = this.tree;
    this.verbatim(this.source, tree.start[node] | 0, tree.end[node] | 0);
  }

  // ----------------------------------------------------------------------------------------- statements

  template(template: number): void {
    const tree = this.tree;
    if ((tree.tag[template] | 0) === K_TEMPLATE) {
      this.startGroup();
      this.children(tree.f0[template] | 0, tree.f1[template] | 0, P_TEMPLATE, -1, 0);
      this.out.endGroup();
    }
  }

  // `path.map(print, "body")` or `"children"`. `outerPath` (-1: none), `outerStrip`: `nodes` are what follows `{{else}}` in
  // that block.
  children(listStart: number, listLen: number, parent: number, outerPath: number, outerStrip: number): void {
    if (!this.stack.enter()) return;
    const tree = this.tree;
    const lists = tree.lists;
    for (let index = 0; index < listLen; index++) {
      const id = lists[listStart + index] | 0;
      const kind = tree.tag[id] | 0;
      const isAsWritten =
        (tree.written[id] | 0) !== 0 ||
        this.isPrettierIgnore(id) ||
        (index >= 2 && this.isPrettierIgnore(lists[listStart + index - 2] | 0));
      if (kind === K_TEXT) {
        const cs = tree.f0[id] | 0;
        const cl = tree.f1[id] | 0;
        let buf = tree.buf;
        let a = cs;
        let b = a + cl;
        // One more backslash, or the last would escape the `{{` that is printed right behind it. Before a mustache the
        // tree has it: Prettier's `addBackslash`.
        if (cl > 0 && (buf[b - 1] | 0) === 92) {
          let extra = false;
          if (index + 1 < listLen) {
            const nk = tree.tag[lists[listStart + index + 1] | 0] | 0;
            if (nk === K_MUSTACHE_COMMENT) {
              extra = true;
            } else if (nk === K_BLOCK_STATEMENT) {
              // Where white space does not count, the text puts it on the next line.
              extra = this.isWhiteSpaceSensitive || this.preDepth > 0 || isAsWritten;
            }
          } else {
            extra = parent === P_BLOCK && this.isWhiteSpaceSensitive;
          }
          if (extra) {
            const tmp = new Uint8Array(cl + 1);
            tmp.set(buf.subarray(a, b));
            tmp[cl] = 92;
            buf = tmp;
            a = 0;
            b = cl + 1;
          }
        }
        if (isAsWritten) {
          // The backslash that escapes a mustache is before the text, so Prettier does not print it.
          if (this.options.isInMarkdown) this.withLiteralLines(buf, a, b, ESC_MUSTACHES, 0);
          else this.escaped(buf, a, b);
        } else {
          this.textNode(buf, a, b, listStart, listLen, index, parent);
        }
        continue;
      }
      if (isAsWritten) {
        this.ignored(id);
        continue;
      }
      switch (kind) {
        case K_ELEMENT: {
          const followsElement = index > 0 && (tree.tag[lists[listStart + index - 1] | 0] | 0) === K_ELEMENT;
          this.element(id, followsElement);
          break;
        }
        case K_BLOCK_STATEMENT: {
          let elseIfOf = -1;
          if (outerPath >= 0 && listLen === 1 && this.isElseIf(id, outerPath, outerStrip)) elseIfOf = outerStrip;
          this.blockStatement(id, elseIfOf);
          break;
        }
        case K_MUSTACHE:
          this.mustacheNode(id, false);
          break;
        case K_MUSTACHE_COMMENT:
          this.mustacheComment(id, tree.f0[id] | 0, tree.f1[id] | 0);
          break;
        case K_COMMENT: {
          this.token("<!--");
          const s = tree.f0[id] | 0;
          const a = s;
          this.verbatim(tree.buf, a, a + (tree.f1[id] | 0));
          this.token("-->");
          break;
        }
        case K_DOCTYPE:
          this.ignored(id);
          break;
        case K_FRONT_MATTER:
          this.printFrontMatter();
          break;
        default:
          break;
      }
    }
    this.stack.leave();
  }

  mustacheComment(node: number, vs: number, vl: number): void {
    const tree = this.tree;
    const src = this.source;
    const start = tree.start[node] | 0;
    const end = tree.end[node] | 0;
    const stripsLeft = start + 2 < src.length && (src[start + 2] | 0) === 126;
    const stripsRight = end >= 3 && end - 3 < src.length && (src[end - 3] | 0) === 126;
    const buf = tree.buf;
    const a = vs;
    const b = a + vl;
    // Prettier only looks for the first. Without dashes, the others are read as a comment that ends at `--}}`, and as one
    // that strips what follows it.
    const needsDashes =
      indexOfAscii(buf, a, b, "}}") >= 0 ||
      startsWithAscii(buf, a, b, "--") ||
      (vl > 0 && (buf[b - 1] | 0) === 126 && !stripsRight);
    const dashes = needsDashes ? "--" : "";
    this.token(stripsLeft ? "{{~!" : "{{!");
    this.token(dashes);
    this.verbatim(buf, a, b);
    this.token(dashes);
    this.token(stripsRight ? "~}}" : "}}");
  }

  // Prettier's `printEmbedFrontMatter`, or `printFrontMatter` where that does not apply.
  printFrontMatter(): void {
    const raw = this.frontMatterBuf.subarray(0, this.frontMatterEnd);
    const fm = parseFrontMatter(raw);
    let value = -1;
    let ok = false;
    let ls = 0;
    let le = 0;
    if (fm !== null && !hasIndentedDelimiter(raw, 0, raw.length) && this.options.embeddedLanguageFormatting !== EMBEDDED_OFF) {
      ls = fm.languageStart;
      le = fm.languageEnd;
      const isToml = eqAscii(raw, ls, le, "toml") || (le === ls && startsWithAscii(raw, 0, raw.length, "+++"));
      const isYaml = eqAscii(raw, ls, le, "yaml") || (le === ls && !isToml);
      const vs = trimJsWhitespaceStart(raw, fm.valueStart, fm.valueEnd);
      const ve = trimJsWhitespaceEnd(raw, vs, fm.valueEnd);
      if (ve === vs && (isYaml || isToml)) {
        value = DOC_EMPTY;
        ok = true;
      } else if (isYaml) {
        const d = yamlDocument(raw, vs, ve, this.options);
        if (d >= 0) {
          value = textToDoc(d);
          ok = value >= 0;
        }
      }
    }
    if (!ok) {
      this.verbatim(raw, 0, raw.length);
      return;
    }
    this.out.startMarkAsRoot();
    this.out.text(raw, 0, 3);
    this.out.text(raw, ls, le);
    this.out.hardLine();
    if (!docPool.isEmptyText(value)) {
      this.out.document(value);
      this.out.hardLine();
    }
    this.out.text(raw, raw.length - 3, raw.length);
    this.out.endIndent();
  }

  // ----------------------------------------------------------------------------------------- elements

  // `embed`: the style sheet that is all that a `<style>` has. The document, or -1. It is made in the pool above `docPush`.
  embeddedStyleSheet(attrStart: number, attrLen: number, childStart: number, childLen: number): number {
    if (childLen !== 1) return -1;
    const tree = this.tree;
    const lists = tree.lists;
    const child = lists[childStart] | 0;
    if ((tree.tag[child] | 0) !== K_TEXT) return -1;
    if (this.options.embeddedLanguageFormatting === EMBEDDED_OFF) return -1;
    for (let i = 0; i < attrLen; i++) {
      const attribute = lists[attrStart + i] | 0;
      if ((tree.tag[attribute] | 0) === K_ATTR && tree.textIs(tree.f0[attribute] | 0, tree.f1[attribute] | 0, "lang")) {
        const value = tree.f2[attribute] | 0;
        if ((tree.tag[value] | 0) !== K_TEXT) return -1;
        const vs = tree.f0[value] | 0;
        const vl = tree.f1[value] | 0;
        if (!(vl === 0 || tree.textIs(vs, vl, "css"))) return -1;
        break;
      }
    }
    const cs = tree.f0[child] | 0;
    const a = cs;
    const d = cssDocument(tree.buf, a, a + (tree.f1[child] | 0), this.options);
    if (d < 0 || docPool.isEmptyText(d)) return -1;
    return d;
  }

  element(id: number, followsElement: boolean): void {
    const tree = this.tree;
    const ts = tree.f0[id] | 0;
    const tl = tree.f1[id] | 0;
    const attrStart = tree.f2[id] | 0;
    const attrLen = tree.f3[id] | 0;
    const bpStart = tree.f4[id] | 0;
    const bpLen = tree.f5[id] | 0;
    const childStart = tree.f6[id] | 0;
    const childLen = tree.f7[id] | 0;
    const isSelfClosing = (tree.f8[id] | 0) !== 0;
    const tbuf = tree.buf;
    const ta = ts;
    const tb = ta + tl;
    const isVoid = this.isVoidElement(tbuf, ta, tb, childStart, childLen, isSelfClosing);

    if (!this.isWhiteSpaceSensitive && followsElement) this.out.line(LINE_SOFT);
    // `printStartingTag`
    this.startGroup();
    this.token("<");
    this.out.text(tbuf, ta, tb);
    this.startIndent();
    const lists = tree.lists;
    for (let i = 0; i < attrLen; i++) {
      this.out.line(LINE_SPACE);
      this.attribute(lists[attrStart + i] | 0);
    }
    if (bpLen > 0) {
      this.out.line(LINE_SPACE);
      this.blockParams(bpStart, bpLen);
    }
    this.out.endIndent();
    this.out.startIfBreak(0);
    this.out.line(LINE_SOFT);
    this.token(isVoid ? "/>" : ">");
    this.out.otherwise();
    if (isVoid) {
      this.token(" />");
      this.out.line(LINE_SOFT);
    } else {
      this.token(">");
    }
    this.out.endIfBreak();
    this.out.endGroup();
    if (isVoid) return;

    // Prettier wraps the text of the first two like any other, which joins the lines.
    const isStyleTag = eqAscii(tbuf, ta, tb, "style");
    let isRawText = false;
    if (isStyleTag) {
      isRawText = this.hasMustacheThatCountsInStyle(childStart, childLen);
    } else {
      isRawText = (asciiEqIgnoreCase(tbuf, ta, tb, "script") || asciiEqIgnoreCase(tbuf, ta, tb, "textarea")) && !this.areWhiteSpace(childStart, childLen);
    }
    const isStyle = isStyleTag && !isRawText;
    const keepsWhiteSpace = isRawText || asciiEqIgnoreCase(tbuf, ta, tb, "pre");
    const wasWhiteSpaceSensitive = this.isWhiteSpaceSensitive;
    this.isWhiteSpaceSensitive = this.isWhiteSpaceSensitive || isRawText;
    if (keepsWhiteSpace) this.preDepth = this.preDepth + 1;
    const isEmpty = childLen === 0 || ((!this.isWhiteSpaceSensitive || isStyle) && this.areWhiteSpace(childStart, childLen));
    if (isEmpty) {
      // Nothing.
    } else if (isStyle || !this.isWhiteSpaceSensitive) {
      this.startIndent();
      this.out.line(LINE_SOFT);
      let printed = false;
      if (isStyle) {
        docPush();
        const sheet = this.embeddedStyleSheet(attrStart, attrLen, childStart, childLen);
        if (sheet >= 0) {
          this.out.document(sheet);
          printed = true;
        }
        docPop();
      }
      if (!printed) this.children(childStart, childLen, isStyle ? P_STYLE : P_ELEMENT, -1, 0);
      this.out.endIndent();
      this.out.line(LINE_SOFT);
    } else {
      this.startIndent();
      this.startGroup();
      this.children(childStart, childLen, P_ELEMENT, -1, 0);
      this.out.endGroup();
      this.out.endIndent();
    }
    if (keepsWhiteSpace) this.preDepth = this.preDepth - 1;
    this.isWhiteSpaceSensitive = wasWhiteSpaceSensitive;
    this.token("</");
    this.out.text(tbuf, ta, tb);
    this.token(">");
  }

  // Whether `children`, of a `<style>`, have an escaped mustache, which Prettier prints without its backslash, or white
  // space next to a mustache, which it does not print.
  hasMustacheThatCountsInStyle(listStart: number, listLen: number): boolean {
    const tree = this.tree;
    const lists = tree.lists;
    for (let index = 0; index < listLen; index++) {
      const child = lists[listStart + index] | 0;
      if ((tree.tag[child] | 0) !== K_TEXT) continue;
      const cs = tree.f0[child] | 0;
      const cl = tree.f1[child] | 0;
      const buf = tree.buf;
      const a = cs;
      const b = a + cl;
      if (indexOfAscii(buf, a, b, "{{") >= 0) return true;
      if (index > 0 && trimAsciiStart(buf, a, b) > a) return true;
      if (index + 1 < listLen && trimAsciiEnd(buf, a, b) < b) return true;
    }
    return false;
  }

  // An attribute, a modifier or a comment in a tag.
  attribute(id: number): void {
    const tree = this.tree;
    const kind = tree.tag[id] | 0;
    if ((tree.written[id] | 0) !== 0) {
      this.ignored(id);
    } else if (kind === K_ATTR) {
      const ns = tree.f0[id] | 0;
      const na = ns;
      this.attrNode(tree.buf, na, na + (tree.f1[id] | 0), tree.f2[id] | 0);
    } else if (kind === K_ELEMENT_MODIFIER) {
      this.startGroup();
      this.token("{{");
      this.pathAndParams(tree.f0[id] | 0, tree.f1[id] | 0, tree.f2[id] | 0, tree.f3[id] | 0, tree.f4[id] | 0, false);
      this.token("}}");
      this.out.endGroup();
    } else if (kind === K_MUSTACHE_COMMENT) {
      if (this.isPrettierIgnore(id)) this.ignored(id);
      else this.mustacheComment(id, tree.f0[id] | 0, tree.f1[id] | 0);
    }
  }

  // `getPreferredQuote`, for the texts in the `count` nodes at `from` of `lists`: counts of `"` and `'`.
  preferredQuoteOf(listStart: number, listLen: number): string {
    const tree = this.tree;
    const lists = tree.lists;
    let double = 0;
    let single = 0;
    for (let i = 0; i < listLen; i++) {
      const node = lists[listStart + i] | 0;
      if ((tree.tag[node] | 0) === K_TEXT) {
        const cs = tree.f0[node] | 0;
        const buf = tree.buf;
        const a = cs;
        const b = a + (tree.f1[node] | 0);
        double = double + countByte(buf, a, b, 34);
        single = single + countByte(buf, a, b, 39);
      }
    }
    return preferredQuote(double, single, this.singleQuote);
  }

  attrNode(nbuf: Uint8Array, na: number, nb: number, value: number): void {
    const tree = this.tree;
    const kind = tree.tag[value] | 0;
    const isClass = asciiEqIgnoreCase(nbuf, na, nb, "class");
    let quote = "";
    if (kind === K_TEXT) {
      // There is no value.
      if ((tree.f1[value] | 0) === 0 && (tree.start[value] | 0) === (tree.end[value] | 0)) {
        this.out.text(nbuf, na, nb);
        return;
      }
      quote = this.preferredQuoteOfText(value);
    } else if (kind === K_CONCAT) {
      quote = this.preferredQuoteOf(tree.f0[value] | 0, tree.f1[value] | 0);
    }
    const escapes = quote.length > 0 ? ESC_MUSTACHES_AND_QUOTE : ESC_MUSTACHES;
    const quoteByte = quote.length > 0 ? quote.charCodeAt(0) : 0;
    this.out.text(nbuf, na, nb);
    this.token("=");
    this.token(quote);
    const isGrouped = eqAscii(nbuf, na, nb, "class") && quote.length > 0;
    if (isGrouped) {
      this.startGroup();
      this.startIndent();
    }
    if (kind === K_TEXT) {
      this.textInAttribute(tree.f0[value] | 0, tree.f1[value] | 0, isClass, false, false, escapes, quoteByte);
    } else if (kind === K_CONCAT) {
      const partStart = tree.f0[value] | 0;
      const partLen = tree.f1[value] | 0;
      const lists = tree.lists;
      for (let index = 0; index < partLen; index++) {
        const part = lists[partStart + index] | 0;
        const pk = tree.tag[part] | 0;
        if (pk === K_TEXT) {
          const followsMustache = index > 0 && (tree.tag[lists[partStart + index - 1] | 0] | 0) === K_MUSTACHE;
          const precedesMustache = index + 1 < partLen && (tree.tag[lists[partStart + index + 1] | 0] | 0) === K_MUSTACHE;
          this.textInAttribute(tree.f0[part] | 0, tree.f1[part] | 0, isClass, followsMustache, precedesMustache, escapes, quoteByte);
        } else if (pk === K_MUSTACHE) {
          this.mustacheNode(part, true);
        }
      }
    } else if (kind === K_MUSTACHE) {
      this.mustacheNode(value, false);
    }
    if (isGrouped) {
      this.out.endIndent();
      this.out.endGroup();
    }
    this.token(quote);
  }

  preferredQuoteOfText(node: number): string {
    const tree = this.tree;
    const cs = tree.f0[node] | 0;
    const buf = tree.buf;
    const a = cs;
    const b = a + (tree.f1[node] | 0);
    return preferredQuote(countByte(buf, a, b, 34), countByte(buf, a, b, 39), this.singleQuote);
  }

  textInAttribute(
    cs: number,
    cl: number,
    isClass: boolean,
    followsMustache: boolean,
    precedesMustache: boolean,
    escapes: number,
    quote: number,
  ): void {
    const tree = this.tree;
    const buf = tree.buf;
    const a = cs;
    const b = a + cl;
    // One more, or it would escape the mustache. Prettier only does that for the text in an element.
    const needsBackslash = precedesMustache && cl > 0 && (buf[b - 1] | 0) === 92;
    if (!isClass) {
      this.withLiteralLines(buf, a, b, escapes, quote);
      if (needsBackslash) this.token("\\");
      return;
    }
    // Prettier goes by what JavaScript takes for white space, some of which can be in the name of a class.
    let from = trimAsciiStart(buf, a, b);
    const to = trimAsciiEnd(buf, from, b);
    if (followsMustache && from > a) this.out.line(LINE_SPACE);
    const hasClasses = to > from;
    // `.replaceAll(/\s+/g, " ")`
    while (from < to) {
      const stop = indexOfWhiteSpace(buf, from, to);
      this.withEscapes(buf, from, stop, escapes, quote);
      from = stop;
      if (from < to) {
        this.token(" ");
        from = trimAsciiStart(buf, from, to);
      }
    }
    if (needsBackslash) this.token("\\");
    if (precedesMustache && hasClasses && trimAsciiEnd(buf, a, b) < b) this.out.line(LINE_SPACE);
  }

  // ----------------------------------------------------------------------------------------- text

  // A text `chars = buf[a, b)`, which is the child `index` of the `siblings` (`listStart`, `listLen`).
  textNode(buf: Uint8Array, a: number, b: number, listStart: number, listLen: number, index: number, parent: number): void {
    if (parent === P_STYLE) {
      this.textInStyle(buf, a, b);
      return;
    }
    // Prettier only keeps what is right in a `<pre>` as it is, and prints an escaped mustache without its backslash.
    if (this.preDepth > 0) {
      this.withLiteralLines(buf, a, b, ESC_MUSTACHES, 0);
      return;
    }
    const isFirst = index === 0;
    const isLast = index + 1 === listLen;
    const withoutLeading = trimAsciiStart(buf, a, b);
    const isWhiteSpaceOnly = withoutLeading >= b;

    if (this.isWhiteSpaceSensitive) {
      const trimsLeading = isFirst && parent === P_TEMPLATE;
      const trimsTrailing = isLast && parent === P_TEMPLATE;
      if (isWhiteSpaceOnly) {
        if (!trimsLeading && !trimsTrailing) this.breaks(buf, a, b, isLast);
        return;
      }
      const wordsEnd = trimAsciiEnd(buf, withoutLeading, b);
      if (withoutLeading > a) this.breaks(buf, a, withoutLeading, false);
      this.fill(buf, withoutLeading, wordsEnd, false, false);
      if (wordsEnd < b && !trimsTrailing) this.breaks(buf, wordsEnd, b, isLast);
      return;
    }

    if ((isFirst || isLast) && isWhiteSpaceOnly) return;
    const tree = this.tree;
    const lists = tree.lists;
    const previous = index > 0 ? tree.tag[lists[listStart + index - 1] | 0] | 0 : K_NOTHING;
    const next = index + 1 < listLen ? tree.tag[lists[listStart + index + 1] | 0] | 0 : K_NOTHING;
    const isBlockOrElement = (k: number): boolean => k === K_BLOCK_STATEMENT || k === K_ELEMENT;
    // A text next to a text is an escaped mustache. Prettier joins the two.
    const isMustache = (k: number): boolean => k === K_MUSTACHE || k === K_TEXT;

    const lineBreaks = countByte(buf, a, b, 10);
    // `countLeadingNewLines`, `countTrailingNewLines`
    const jsStart = trimJsWhitespaceStart(buf, a, b);
    const jsEnd = trimJsWhitespaceEnd(buf, a, b);
    let leadingLineBreaks = countByte(buf, a, jsStart, 10);
    let trailingLineBreaks = jsEnd < b ? countByte(buf, jsEnd, b, 10) : 0;
    if (isWhiteSpaceOnly && lineBreaks > 0) {
      leadingLineBreaks = lineBreaks < 2 ? lineBreaks : 2;
      trailingLineBreaks = 0;
    } else {
      if (isBlockOrElement(next)) trailingLineBreaks = trailingLineBreaks > 1 ? trailingLineBreaks : 1;
      if (isBlockOrElement(previous)) leadingLineBreaks = leadingLineBreaks > 1 ? leadingLineBreaks : 1;
    }
    let trailingSpace = trailingLineBreaks === 0 && isMustache(next);
    let leadingSpace = leadingLineBreaks === 0 && isMustache(previous);
    if (isFirst) {
      leadingLineBreaks = 0;
      leadingSpace = false;
    }
    if (isLast) {
      trailingLineBreaks = 0;
      trailingSpace = false;
    }

    const wordsStart = withoutLeading;
    const wordsEnd = trimAsciiEnd(buf, withoutLeading, b);
    this.hardLines(leadingLineBreaks);
    if (wordsStart >= wordsEnd) {
      // The blank before it is taken for one behind it.
      const before = leadingSpace && trailingSpace;
      this.fill(buf, a, a, before, false);
    } else {
      const hasLeading = b > a && isHtmlWhiteSpace(buf[a] | 0);
      const hasTrailing = b > a && isHtmlWhiteSpace(buf[b - 1] | 0);
      this.fill(buf, wordsStart, wordsEnd, hasLeading && leadingSpace, hasTrailing && trailingSpace);
    }
    this.hardLines(trailingLineBreaks);
  }

  // A text in `<style>` that is not formatted as a style sheet.
  textInStyle(buf: Uint8Array, a: number, b: number): void {
    let from = a;
    while (from < b && (buf[from] | 0) === 10) from = from + 1;
    const to = trimAsciiEnd(buf, from, b);
    // `htmlWhitespace.dedentString(text)`
    let minIndentation = -1;
    let lineStart = from;
    while (true) {
      let nl = indexOfByteIn(buf, lineStart, to, 10);
      const lineEnd = nl < 0 ? to : nl;
      const indentation = trimAsciiStart(buf, lineStart, lineEnd) - lineStart;
      const len = lineEnd - lineStart;
      if (!(len === 0 || (indentation === len && indentation > 0))) {
        if (minIndentation < 0 || indentation < minIndentation) minIndentation = indentation;
        if (indentation === 0) break;
      }
      if (nl < 0) break;
      lineStart = nl + 1;
    }
    if (minIndentation < 0) minIndentation = 0;
    lineStart = from;
    let first = true;
    while (true) {
      let nl = indexOfByteIn(buf, lineStart, to, 10);
      const lineEnd = nl < 0 ? to : nl;
      if (!first) this.out.hardLine();
      first = false;
      const s = lineStart + minIndentation;
      this.out.text(buf, s < lineEnd ? s : lineEnd, lineEnd);
      if (nl < 0) break;
      lineStart = nl + 1;
    }
  }

  // ----------------------------------------------------------------------------------------- blocks

  // The name of the helper, if it is a variable: `hnS`, `hnL`.
  headName(path: number): boolean {
    const tree = this.tree;
    if ((tree.tag[path] | 0) === K_PATH && (tree.f0[path] | 0) === H_VAR) {
      this.hnS = tree.f1[path] | 0;
      this.hnL = tree.f2[path] | 0;
      return true;
    }
    return false;
  }

  // `isElseIfBlock`, for a node that is all that follows `{{else}}` in the block whose helper is `outerPath` and whose
  // strip is `outerStrip`.
  isElseIf(id: number, outerPath: number, outerStrip: number): boolean {
    const tree = this.tree;
    if ((tree.tag[id] | 0) !== K_BLOCK_STATEMENT) return false;
    const path = tree.f0[id] | 0;
    const inverse = tree.f6[id] | 0;
    const strip = tree.f7[id] | 0;
    // Of `{{else}}{{~#if a}}..{{/if}}`, what the inner tags strip would be lost. Prettier makes `{{else if a}}` of it.
    let strips = (strip & ~INVERSE_OPEN & ~INVERSE_CLOSE) | (outerStrip & (INVERSE_CLOSE | CLOSE_OPEN));
    // Handlebars takes the `~` of `{{~else if b}}` in a block that is written `{{else if a}}` for one of `{{~/if}}` too.
    this.bodyOf(inverse);
    if (this.bodyL === 1) {
      const only = tree.lists[this.bodyS] | 0;
      if ((tree.tag[only] | 0) === K_BLOCK_STATEMENT && ((tree.f7[only] | 0) & CHAINED) !== 0) strips = strips | (strip & INVERSE_OPEN);
    }
    if ((tree.written[id] | 0) !== 0 || ((strip & CHAINED) === 0 && strips !== 0)) return false;
    if (!this.headName(path)) return false;
    const ns = this.hnS;
    const nl = this.hnL;
    if (tree.textIs(ns, nl, "if")) return true;
    if (!this.headName(outerPath)) return false;
    return tree.textEq(ns, nl, this.hnS, this.hnL);
  }

  // `bodyS`, `bodyL`, `bodyBpS`, `bodyBpL`
  bodyOf(block: number): void {
    const tree = this.tree;
    if ((tree.tag[block] | 0) === K_BLOCK) {
      this.bodyS = tree.f0[block] | 0;
      this.bodyL = tree.f1[block] | 0;
      this.bodyBpS = tree.f2[block] | 0;
      this.bodyBpL = tree.f3[block] | 0;
    } else {
      this.bodyS = 0;
      this.bodyL = 0;
      this.bodyBpS = 0;
      this.bodyBpL = 0;
    }
  }

  blockParams(namesStart: number, namesLen: number): void {
    const tree = this.tree;
    this.token("as |");
    for (let index = 0; index < namesLen; index++) {
      if (index > 0) this.token(" ");
      const s = tree.nameStart[namesStart + index] | 0;
      const a = s;
      this.verbatim(tree.buf, a, a + (tree.nameLen[namesStart + index] | 0));
    }
    this.token("|");
  }

  openMustache(strips: boolean, mark: string): void {
    this.token(strips ? "{{~" : "{{");
    this.token(mark);
  }

  closeMustache(strips: boolean): void {
    this.token(strips ? "~}}" : "}}");
  }

  // `elseIfOf` (-1: none): it is printed as `{{else if ..}}`, of a block with that `strip`.
  blockStatement(node: number, elseIfOf: number): void {
    const tree = this.tree;
    const path = tree.f0[node] | 0;
    const paramsStart = tree.f1[node] | 0;
    const paramsLen = tree.f2[node] | 0;
    const pairsStart = tree.f3[node] | 0;
    const pairsLen = tree.f4[node] | 0;
    const program = tree.f5[node] | 0;
    const inverse = tree.f6[node] | 0;
    const strip = tree.f7[node] | 0;
    this.bodyOf(program);
    const bodyS = this.bodyS;
    const bodyL = this.bodyL;
    const bpS = this.bodyBpS;
    const bpL = this.bodyBpL;
    const hasParams = paramsLen > 0 || pairsLen > 0;
    const isIgnoringWhiteSpace = !this.isWhiteSpaceSensitive;

    this.startGroup();
    if (elseIfOf >= 0) {
      // `printElseIfBlock`
      this.openMustache((elseIfOf & INVERSE_OPEN) !== 0, "else ");
      // Prettier prints the first name of it, as the tree has it.
      this.expression(path, false);
      this.startIndent();
      this.out.line(LINE_SPACE);
      this.startGroup();
      this.params(paramsStart, paramsLen, pairsStart, pairsLen, false);
      this.out.endGroup();
      if (bpL > 0) {
        this.out.line(LINE_SPACE);
        this.blockParams(bpS, bpL);
      }
      this.out.endIndent();
      this.out.line(LINE_SOFT);
      this.closeMustache((elseIfOf & INVERSE_CLOSE) !== 0);
    } else {
      // `printOpenBlock`
      this.openMustache((strip & OPEN_OPEN) !== 0, "#");
      this.expression(path, false);
      if (hasParams || bpL > 0) {
        this.startIndent();
        this.out.line(LINE_SPACE);
        if (hasParams) {
          this.startGroup();
          this.params(paramsStart, paramsLen, pairsStart, pairsLen, false);
          this.out.endGroup();
        }
        if (bpL > 0) {
          if (hasParams) this.out.line(LINE_SPACE);
          this.blockParams(bpS, bpL);
        }
        this.out.endIndent();
      }
      this.out.line(LINE_SOFT);
      this.closeMustache((strip & OPEN_CLOSE) !== 0);
    }
    this.out.endGroup();

    if (elseIfOf < 0) this.startGroup();
    // `printProgram`
    // Prettier leaves white space out wherever it is.
    const isBlank = this.areWhiteSpace(bodyS, bodyL) && (this.preDepth === 0 || bodyL === 0);
    if (!isBlank) {
      this.startIndent();
      if (isIgnoringWhiteSpace) this.out.hardLine();
      this.startGroup();
      this.children(bodyS, bodyL, P_BLOCK, -1, 0);
      this.out.endGroup();
      this.out.endIndent();
    }
    // `printInverse`
    if (inverse !== NOTHING) {
      this.bodyOf(inverse);
      const iS = this.bodyS;
      const iL = this.bodyL;
      let isChained = false;
      if (iL === 1) isChained = this.isElseIf(tree.lists[iS] | 0, path, strip);
      if (!isChained) {
        // `printElseBlock`
        if (isIgnoringWhiteSpace) this.out.hardLine();
        this.openMustache((strip & INVERSE_OPEN) !== 0, "else");
        this.closeMustache((strip & INVERSE_CLOSE) !== 0);
        this.startIndent();
      }
      if (isIgnoringWhiteSpace) this.out.hardLine();
      this.startGroup();
      this.children(iS, iL, P_BLOCK, path, strip);
      this.out.endGroup();
      if (!isChained) this.out.endIndent();
    }
    if (elseIfOf >= 0) return;
    // `printCloseBlock`
    if (isIgnoringWhiteSpace) {
      if (isBlank) this.out.line(LINE_SOFT);
      else this.out.hardLine();
    }
    this.openMustache((strip & CLOSE_OPEN) !== 0, "/");
    this.expression(path, false);
    this.closeMustache((strip & CLOSE_CLOSE) !== 0);
    this.out.endGroup();
  }

  // ----------------------------------------------------------------------------------------- expressions

  // `isInQuotes`: it is a part of the value of an attribute, which is in quotes.
  mustacheNode(node: number, isInQuotes: boolean): void {
    const tree = this.tree;
    if ((tree.tag[node] | 0) !== K_MUSTACHE) return;
    if ((tree.written[node] | 0) !== 0) {
      this.ignored(node);
      return;
    }
    const isTrusting = (tree.f5[node] | 0) !== 0;
    const strip = tree.f6[node] | 0;
    this.startGroup();
    // Prettier prints `{{{~a~}}}`, which cannot be read.
    const stripOpen = (strip & OPEN_OPEN) !== 0;
    const stripClose = (strip & OPEN_CLOSE) !== 0;
    if (isTrusting) this.token(stripOpen ? "{{~{" : "{{{");
    else this.token(stripOpen ? "{{~" : "{{");
    this.pathAndParams(tree.f0[node] | 0, tree.f1[node] | 0, tree.f2[node] | 0, tree.f3[node] | 0, tree.f4[node] | 0, isInQuotes);
    if (isTrusting) this.token(stripClose ? "}~}}" : "}}}");
    else this.token(stripClose ? "~}}" : "}}");
    this.out.endGroup();
  }

  // `printPathAndParams`
  pathAndParams(path: number, paramsStart: number, paramsLen: number, pairsStart: number, pairsLen: number, isInQuotes: boolean): void {
    if (paramsLen === 0 && pairsLen === 0) {
      this.expression(path, isInQuotes);
      return;
    }
    this.startIndent();
    this.expression(path, isInQuotes);
    this.out.line(LINE_SPACE);
    this.params(paramsStart, paramsLen, pairsStart, pairsLen, isInQuotes);
    this.out.endIndent();
    this.out.line(LINE_SOFT);
  }

  // `printParams`
  params(paramsStart: number, paramsLen: number, pairsStart: number, pairsLen: number, isInQuotes: boolean): void {
    const tree = this.tree;
    const lists = tree.lists;
    for (let index = 0; index < paramsLen; index++) {
      if (index > 0) this.out.line(LINE_SPACE);
      this.expression(lists[paramsStart + index] | 0, isInQuotes);
    }
    for (let index = 0; index < pairsLen; index++) {
      if (index > 0 || paramsLen > 0) this.out.line(LINE_SPACE);
      const pair = lists[pairsStart + index] | 0;
      if ((tree.tag[pair] | 0) === K_HASH_PAIR) {
        const ks = tree.f0[pair] | 0;
        const ka = ks;
        this.verbatim(tree.buf, ka, ka + (tree.f1[pair] | 0));
        this.token("=");
        this.expression(tree.f2[pair] | 0, false);
      }
    }
  }

  // `needsOppositeQuote`: Prettier's `needsOppositeQuote`, if it is a string.
  expression(id: number, needsOppositeQuote: boolean): void {
    const tree = this.tree;
    const kind = tree.tag[id] | 0;
    if ((tree.written[id] | 0) !== 0) {
      this.ignored(id);
      return;
    }
    switch (kind) {
      case K_SUB_EXPRESSION: {
        if (!this.stack.enter()) return;
        const path = tree.f0[id] | 0;
        const paramsStart = tree.f1[id] | 0;
        const paramsLen = tree.f2[id] | 0;
        const pairsStart = tree.f3[id] | 0;
        const pairsLen = tree.f4[id] | 0;
        this.startGroup();
        this.token("(");
        if (paramsLen === 0 && pairsLen === 0) {
          this.expression(path, needsOppositeQuote);
        } else {
          this.startIndent();
          this.expression(path, needsOppositeQuote);
          this.out.line(LINE_SPACE);
          this.startGroup();
          this.params(paramsStart, paramsLen, pairsStart, pairsLen, needsOppositeQuote);
          this.out.endGroup();
          this.out.endIndent();
        }
        this.out.line(LINE_SOFT);
        this.token(")");
        this.out.endGroup();
        this.stack.leave();
        break;
      }
      case K_PATH: {
        const head = tree.f0[id] | 0;
        const tailStart = tree.f3[id] | 0;
        const tailLen = tree.f4[id] | 0;
        let buf = tree.buf;
        let a = 0;
        let b = 0;
        if (head === H_THIS) {
          buf = THIS_BYTES;
          a = 0;
          b = 4;
        } else {
          const ns = tree.f1[id] | 0;
          buf = tree.buf;
          a = ns;
          b = a + (tree.f2[id] | 0);
        }
        if (this.isReadAsPrinted(head, buf, a, b, tailStart, tailLen)) this.path(buf, a, b, tailStart, tailLen);
        else this.ignored(id);
        break;
      }
      case K_STRING: {
        const vs = tree.f0[id] | 0;
        const vl = tree.f1[id] | 0;
        const buf = tree.buf;
        const a = vs;
        let b = a + vl;
        // The backslash would escape the quote.
        if (vl > 0 && (buf[b - 1] | 0) === 92) {
          this.ignored(id);
          break;
        }
        const double = countByte(buf, a, b, 34);
        const single = countByte(buf, a, b, 39);
        const quote = preferredQuote(double, single, this.singleQuote !== needsOppositeQuote);
        const q = quote.charCodeAt(0);
        this.token(quote);
        let from = a;
        while (true) {
          const at = indexOfByteIn(buf, from, b, q);
          if (at < 0) break;
          this.verbatim(buf, from, at);
          this.token("\\");
          this.token(quote);
          from = at + 1;
        }
        this.verbatim(buf, from, b);
        this.token(quote);
        break;
      }
      case K_NUMBER: {
        const ts = tree.f0[id] | 0;
        const a = ts;
        this.number(tree.buf, a, a + (tree.f1[id] | 0));
        break;
      }
      case K_BOOLEAN:
        this.token((tree.f0[id] | 0) !== 0 ? "true" : "false");
        break;
      case K_UNDEFINED:
        this.token("undefined");
        break;
      case K_NULL:
        this.token("null");
        break;
      default:
        break;
    }
  }

  // `String(Number(token))`
  number(buf: Uint8Array, a: number, b: number): void {
    const len = b - a;
    let isAsPrinted = len <= 15 && (len === 1 || (buf[a] | 0) !== 48);
    if (isAsPrinted) {
      for (let i = a; i < b; i++) {
        const c = buf[i] | 0;
        if (c < 48 || c > 57) {
          isAsPrinted = false;
          break;
        }
      }
    }
    if (isAsPrinted) {
      this.out.text(buf, a, b);
      return;
    }
    const value = Number(new TextDecoder().decode(buf.subarray(a, b)));
    const printed = String(value);
    // The lexer knows neither exponents nor `Infinity`, which Prettier prints.
    let isNumber = true;
    for (let i = 0; i < printed.length; i++) {
      const c = printed.charCodeAt(i);
      if (!((c >= 48 && c <= 57) || c === 45 || c === 46)) {
        isNumber = false;
        break;
      }
    }
    if (isNumber) this.token(printed);
    else this.out.text(buf, a, b);
  }

  // Whether what `path` prints is read as the same path. What was in brackets need not be: `[this]`, `[@a]`, `[true]`,
  // `[-1]`, `[else]`, `[a]b]`. It leaves what `path` needs in `pfFirst` and `pfBrk`.
  isReadAsPrinted(kind: number, buf: Uint8Array, a: number, b: number, tailStart: number, tailLen: number): boolean {
    const tree = this.tree;
    const len = (b - a) | 0;
    const c0 = len > 0 ? buf[a] | 0 : 0;
    if (kind === H_VAR && (c0 === 64 || (len === 4 && c0 === 116 && eqAscii(buf, a, b, "this")))) return false;
    if (tailLen === 0 && indexOfByteIn(buf, a, b, 47) >= 0) {
      let from = c0 === 64 ? a + 1 : a;
      while (true) {
        const nl = indexOfByteIn(buf, from, b, 47);
        const end = nl < 0 ? b : nl;
        if (!(end > from && idLen(buf, from, end) === end - from && !eqAscii(buf, from, end, "this"))) return false;
        if (nl < 0) break;
        from = nl + 1;
      }
      return true;
    }
    if (len >= 4 && len <= 9 && c0 !== 0) {
      if (len === 4 && c0 === 101 && eqAscii(buf, a, b, "else")) return false;
      if (tailLen === 0 && (eqAscii(buf, a, b, "true") || eqAscii(buf, a, b, "false") || eqAscii(buf, a, b, "null") || eqAscii(buf, a, b, "undefined"))) {
        return false;
      }
    }
    if (tailLen === 0 && c0 === 45 && isNegativeNumber(buf, a, b)) return false;
    const first = partFlags(buf, a, b, true);
    if ((first & PF_READABLE) === 0) return false;
    this.pfFirst = first;
    if (tailLen > this.pfBrk.length) this.pfBrk = new Uint8Array(tailLen * 2);
    for (let i = 0; i < tailLen; i++) {
      const pa = tree.nameStart[tailStart + i] | 0;
      const f = partFlags(tree.buf, pa, pa + (tree.nameLen[tailStart + i] | 0), false);
      if ((f & PF_READABLE) === 0) return false;
      this.pfBrk[i] = f & PF_BRACKETS;
    }
    return true;
  }

  // `printPathExpression`
  path(buf: Uint8Array, a: number, b: number, tailStart: number, tailLen: number): void {
    const tree = this.tree;
    if (tailLen === 0 && indexOfByteIn(buf, a, b, 47) >= 0) {
      this.verbatim(buf, a, b);
      return;
    }
    this.pathPart(buf, a, b, (this.pfFirst & PF_BRACKETS) !== 0);
    for (let i = 0; i < tailLen; i++) {
      this.token(".");
      const pa = tree.nameStart[tailStart + i] | 0;
      this.pathPart(tree.buf, pa, pa + (tree.nameLen[tailStart + i] | 0), (this.pfBrk[i] | 0) !== 0);
    }
  }

  pathPart(buf: Uint8Array, a: number, b: number, brackets: boolean): void {
    if (brackets) this.token("[");
    this.verbatim(buf, a, b);
    if (brackets) this.token("]");
  }
}

// `isVoidTag(tag.toLowerCase())`
function isVoidTagIgnoreCase(buf: Uint8Array, a: number, b: number): boolean {
  for (let i = a; i < b; i++) {
    if ((buf[i] | 0) >= 0x80) {
      // Some letters of other scripts have an ASCII lower case (the Kelvin sign).
      const lower = new TextEncoder().encode(new TextDecoder().decode(buf.subarray(a, b)).toLowerCase());
      return isVoidTag(lower, 0, lower.length);
    }
  }
  switch (b - a) {
    case 2:
      return asciiEqIgnoreCase(buf, a, b, "br") || asciiEqIgnoreCase(buf, a, b, "hr");
    case 3:
      return asciiEqIgnoreCase(buf, a, b, "col") || asciiEqIgnoreCase(buf, a, b, "img") || asciiEqIgnoreCase(buf, a, b, "wbr");
    case 4:
      return (
        asciiEqIgnoreCase(buf, a, b, "area") ||
        asciiEqIgnoreCase(buf, a, b, "base") ||
        asciiEqIgnoreCase(buf, a, b, "link") ||
        asciiEqIgnoreCase(buf, a, b, "meta")
      );
    case 5:
      return (
        asciiEqIgnoreCase(buf, a, b, "embed") ||
        asciiEqIgnoreCase(buf, a, b, "input") ||
        asciiEqIgnoreCase(buf, a, b, "param") ||
        asciiEqIgnoreCase(buf, a, b, "track")
      );
    case 6:
      return asciiEqIgnoreCase(buf, a, b, "keygen") || asciiEqIgnoreCase(buf, a, b, "source");
    case 7:
      return asciiEqIgnoreCase(buf, a, b, "command");
    default:
      return false;
  }
}

function asciiEqIgnoreCase(buf: Uint8Array, a: number, b: number, lit: string): boolean {
  const n = lit.length;
  if (b - a !== n) return false;
  for (let i = 0; i < n; i++) {
    let c = buf[a + i] | 0;
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== lit.charCodeAt(i)) return false;
  }
  return true;
}

const THIS_BYTES = new Uint8Array(4);
THIS_BYTES[0] = 116;
THIS_BYTES[1] = 104;
THIS_BYTES[2] = 105;
THIS_BYTES[3] = 115;
