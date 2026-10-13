// Port of vendor/bun/src/format/html/in_js.rs: HTML in the templates of JavaScript: Prettier's `language-js/embed/html.js`.
//
// The text that is formatted has a placeholder in the place of every substitution. Its document is captured, and written once more with the
// substitutions in the place of the placeholders.
//
// The entry points for `src/format/js/print/template.ts` (the Rust `parser_of` / `has_html_tag` / `is_angular_component_template` look at the
// JavaScript tree, so the caller decides what the template is and passes the parser):
//
//   htmlLabel(quasis, parser, f)  -> LABEL_NONE / LABEL_EMBED / LABEL_EMBED_WITHOUT_HUG    (Rust `label`)
//   writeTemplate(quasis, parser, f, indentLevelInSource, writeSubstitution(n)) -> boolean (Rust `write_template`; false: nothing written)
//
// `quasis`: the cooked text of each part of the template (`n + 1` parts for `n` substitutions); a template with a part that has no cooked
// text is not HTML (the caller checks). `f`: the formatter of the JavaScript file, whose `f.options` are the options of the file.
// `writeSubstitution(n)`: writes the substitution number `n` as `write_embedded_template_expression` does.
import { ByteBuf } from "../../base/bytebuf.ts";
import { I32Vec } from "../../base/i32vec.ts";
import { FormatContext } from "../ir/context.ts";
import { Formatter } from "../ir/formatter.ts";
import { LM_HARD, LM_SOFT_OR_SPACE, token } from "../ir/element.ts";
import { FORMAT_OK } from "../errors.ts";
import { HTML_WS_IGNORE, FormatOptions, FLAVOR_OXFMT, HTML_ROOT_NONE } from "../options.ts";
import { startsWithWhiteSpace, trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import {
  F_FLAGS,
  F_NAME_E,
  F_NAME_S,
  HAS_END_SPAN,
  HTree,
  IS_SELF_CLOSING,
  K_ELEMENT,
  P_HTML,
  STRIDE,
} from "./ast.ts";
import { StringMapper, writeMapped } from "./map_strings.ts";
import { canBeParsed, optionsOfHost, topLevelCount, writeDocument } from "./mod.ts";
import { writeString } from "./writer.ts";

export const PLACEHOLDER_START = "PRETTIER_HTML_PLACEHOLDER_";
const PLACEHOLDER_END = "_IN_JS";

/** What the label of the document of a template says. */
export const LABEL_NONE: number = -1;
/** `{ embed: true }` */
export const LABEL_EMBED: number = 0;
/** `{ embed: true, hug: false }` */
export const LABEL_EMBED_WITHOUT_HUG: number = 1;

const TK_BACKTICK = token("`");
const TK_SPACE = token(" ");
const TK_EMPTY_TEMPLATE = token("``");

/** The text of the template, with placeholders. `counter`: what tells them from those of a template that this one is in the text of. */
function textWithPlaceholders(quasis: Uint8Array[], counter: number): Uint8Array {
  const text = new ByteBuf(256);
  for (let index = 0; index < quasis.length; index++) {
    if (index > 0) {
      text.appendAscii(PLACEHOLDER_START);
      text.appendAscii(String(index - 1));
      text.push(95);
      text.appendAscii(String(counter));
      text.appendAscii(PLACEHOLDER_END);
    }
    text.appendAll(quasis[index]);
  }
  const d = text.data;
  const n = text.len;
  // Half of a surrogate pair, which an escape can stand for, is U+FFFD once what Prettier prints is written as UTF-8.
  for (let at = 0; at + 2 < n; at++) {
    if ((d[at] | 0) === 0xed && (d[at + 1] | 0) >= 0xa0) {
      d[at] = 0xef;
      d[at + 1] = 0xbf;
      d[at + 2] = 0xbd;
    }
  }
  let hasCr = false;
  for (let i = 0; i < n; i++) {
    if ((d[i] | 0) === 13) {
      hasCr = true;
      break;
    }
  }
  if (!hasCr) return text.view();
  const out = new ByteBuf(n);
  for (let i = 0; i < n; i++) {
    const c = d[i] | 0;
    if (c === 13) {
      out.push(10);
      if (i + 1 < n && (d[i + 1] | 0) === 10) i = i + 1;
    } else {
      out.push(c);
    }
  }
  return out.view();
}

/** The line break between the backticks and the text: an `LM_*`, -1: there is none. */
function lineAround(text: Uint8Array, options: FormatOptions): number {
  if (options.htmlWhitespaceSensitivity === HTML_WS_IGNORE) return LM_HARD;
  if (startsWithWhiteSpace(text, 0, text.length) && trimJsWhitespaceEnd(text, 0, text.length) < text.length) return LM_SOFT_OR_SPACE;
  return -1;
}

/** The label of the document of a template that `embed` takes for HTML (`parser`: `P_HTML` or `P_ANGULAR`) and that is more than ` `` `. */
export function htmlLabel(quasis: Uint8Array[], parser: number, f: Formatter): number {
  const text = textWithPlaceholders(quasis, f.options.htmlTemplateDepth);
  if (!canBeParsed(text, parser)) return LABEL_NONE;
  return lineAround(text, f.options) >= 0 ? LABEL_EMBED : LABEL_EMBED_WITHOUT_HUG;
}

/** Whether an element of `t` with a substitution in its name has no end tag. It would get one: Prettier makes `<${a}>b</${a}>` of `<${a}>b`, which
 * evaluates `a` twice. Such a template stays as it is. */
export function wouldRepeatSubstitution(t: HTree): boolean {
  const lit = PLACEHOLDER_START.toLowerCase();
  for (let id = 0; id < t.count; id++) {
    const b = id * STRIDE;
    if ((t.n[b] | 0) !== K_ELEMENT) continue;
    if (((t.n[b + F_FLAGS] | 0) & (IS_SELF_CLOSING | HAS_END_SPAN)) !== 0) continue;
    const ns = t.n[b + F_NAME_S] | 0;
    const ne = t.n[b + F_NAME_E] | 0;
    if (ne - ns <= lit.length) continue;
    const d = t.pool.data;
    for (let i = ns; i + lit.length <= ne; i++) {
      let same = true;
      for (let k = 0; k < lit.length; k++) {
        let c = d[i + k] | 0;
        if (c >= 65 && c <= 90) c = c + 32;
        if (c !== lit.charCodeAt(k)) {
          same = false;
          break;
        }
      }
      if (same) return true;
    }
  }
  return false;
}

/** `/^<\/(?=script\b)/i.test(text)` at `at` */
function startsWithEndOfScript(b: Uint8Array, at: number, e: number): boolean {
  if (at + 8 > e || (b[at] | 0) !== 60 || (b[at + 1] | 0) !== 47) return false;
  const name = "script";
  for (let i = 0; i < 6; i++) {
    let c = b[at + 2 + i] | 0;
    if (c >= 65 && c <= 90) c = c + 32;
    if (c !== name.charCodeAt(i)) return false;
  }
  if (at + 8 < e) {
    const c = b[at + 8] | 0;
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) return false;
  }
  return true;
}

/** The callback of the `mapDoc` in `printEmbedHtmlLike`. */
class Substitutions extends StringMapper {
  /** The documents of the substitutions: handles. */
  expressions: I32Vec;
  /** `_`, the counter and the end of a placeholder. */
  placeholderEnd: string;
  /** `__embeddedInHtml`: the end tag of a script would end the script that the template is in. */
  isInHtml: boolean;

  constructor(expressions: I32Vec, placeholderEnd: string, isInHtml: boolean) {
    super();
    this.expressions = expressions;
    this.placeholderEnd = placeholderEnd;
    this.isInHtml = isInHtml;
  }

  /** Where the first placeholder in `b[from, e)` starts and ends, and its number: into `fpS`, `fpE`, `fpN`; false if there is none. */
  fpS: number = 0;
  fpE: number = 0;
  fpN: number = 0;
  findPlaceholder(b: Uint8Array, from: number, e: number): boolean {
    const lit = PLACEHOLDER_START;
    let f = from;
    for (;;) {
      let start = -1;
      for (let i = f; i + lit.length <= e; i++) {
        if ((b[i] | 0) === 80 && matchesAt(b, i, e, lit)) {
          start = i;
          break;
        }
      }
      if (start < 0) return false;
      const digitsStart = start + lit.length;
      let end = digitsStart;
      while (end < e && (b[end] | 0) >= 48 && (b[end] | 0) <= 57) end = end + 1;
      if (end > digitsStart && matchesAt(b, end, e, this.placeholderEnd)) {
        let number = 0;
        for (let i = digitsStart; i < end; i++) {
          number = number * 10 + ((b[i] | 0) - 48);
          if (number > 1e15) number = 1e15;
        }
        this.fpS = start;
        this.fpE = end + this.placeholderEnd.length;
        this.fpN = number;
        return true;
      }
      f = digitsStart;
    }
  }

  needsEscapes(b: Uint8Array, s: number, e: number): boolean {
    for (let i = s; i < e; i++) {
      const c = b[i] | 0;
      if (c === 92 || c === 96 || c === 36) return true;
      if (this.isInHtml && c === 60) return true;
    }
    return false;
  }

  /** Writes `b[s, e)`, which is between placeholders: `uncookTemplateElementValue`. */
  writeText(b: Uint8Array, s: number, e: number, isOneString: boolean, f: Formatter): void {
    if (s >= e) return;
    let buf = b;
    let bs = s;
    let be = e;
    if (this.needsEscapes(b, s, e)) {
      const out = new ByteBuf(e - s + 8);
      for (let i = s; i < e; i++) {
        const c = b[i] | 0;
        if (c === 92 || c === 96) out.push(92);
        else if (c === 36 && i + 1 < e && (b[i + 1] | 0) === 123) out.push(92);
        else if (c === 47 && this.isInHtml && i > s && startsWithEndOfScript(b, i - 1, e)) out.push(92);
        out.push(c);
      }
      buf = out.data;
      bs = 0;
      be = out.len;
    }
    if (isOneString) writeString(f, buf, bs, be);
    else f.textBytes(buf, bs, be);
  }

  changes(buf: Uint8Array, s: number, e: number): boolean {
    if (this.needsEscapes(buf, s, e)) return true;
    for (let i = s; i + PLACEHOLDER_START.length <= e; i++) {
      if ((buf[i] | 0) === 80 && matchesAt(buf, i, e, PLACEHOLDER_START)) return true;
    }
    return false;
  }

  write(buf: Uint8Array, s: number, e: number, isOneString: boolean, f: Formatter): void {
    let rest = s;
    while (this.findPlaceholder(buf, rest, e)) {
      const start = this.fpS;
      const end = this.fpE;
      const number = this.fpN;
      this.writeText(buf, rest, start, isOneString, f);
      if (number < this.expressions.len) f.writeInterned(this.expressions.data[number] | 0);
      rest = end;
    }
    this.writeText(buf, rest, e, isOneString, f);
  }
}

function matchesAt(b: Uint8Array, at: number, e: number, lit: string): boolean {
  if (at + lit.length > e) return false;
  for (let i = 0; i < lit.length; i++) {
    if ((b[at + i] | 0) !== lit.charCodeAt(i)) return false;
  }
  return true;
}

/** Whether `document`, which is what has become of `text`, has as many substitutions. oxfmt leaves a template that has not as it is. */
function hasAsManySubstitutions(text: Uint8Array, document: number, f: Formatter): boolean {
  const printed = new ByteBuf(text.length + 64);
  if (!f.printToText(document, printed)) return false;
  const count = (b: Uint8Array, n: number): number => {
    let c = 0;
    for (let i = 0; i + PLACEHOLDER_START.length <= n; i++) {
      if ((b[i] | 0) === 80 && matchesAt(b, i, n, PLACEHOLDER_START)) c = c + 1;
    }
    return c;
  };
  return count(text, text.length) === count(printed.data, printed.len);
}

/**
 * Writes a template as HTML, if that is what Prettier takes it for: `printEmbedHtmlLike`. `parser`: `P_HTML` or `P_ANGULAR`. `quasis`: see the
 * header. A blank template is `` ` ` ``. `indentLevelInSource`: how many `indent`s are around the line that the template starts on, if the file
 * is indented the way it is going to be. Returns whether it has been written. If the text cannot be parsed, it has not.
 */
export function writeTemplate(
  quasis: Uint8Array[],
  parser: number,
  f: Formatter,
  indentLevelInSource: number,
  writeSubstitution: (n: number) => void,
): boolean {
  if (quasis.length === 1 && trimJsWhitespaceStart(quasis[0], 0, quasis[0].length) >= quasis[0].length) {
    f.token(TK_EMPTY_TEMPLATE);
    return true;
  }
  const counter = f.options.htmlTemplateDepth;
  const text = textWithPlaceholders(quasis, counter);
  // (TODO(port): `tailwind::with_sorted_classes` for oxfmt's `sortTailwindcss`.)
  const outer = f.options;
  const options = optionsOfHost(outer, parser);
  options.htmlTemplateDepth = counter + 1;
  options.parser = "";
  options.filepath = outer.filepath;
  options.rangeStart = -1;
  options.rangeEnd = -1;
  options.cursorOffset = -1;
  const line = lineAround(text, options);
  // Where the lines start is up to the printer. What is printed by itself (JSON, YAML, ..) has to be told how much room there is: as much as
  // there is if the file has been formatted before.
  const indentLevel = indentLevelInSource + (line >= 0 ? 1 : 0);
  const slot = f.startCapture();
  // The code in the text is written with the options of the formatter.
  const outerContext = f.context;
  const outerOptions = f.options;
  const outerFlavor = f.flavor;
  const outerTabWidth = f.tabWidth;
  f.beginEmbedded(text, -1);
  f.context = new FormatContext(options);
  f.options = options;
  f.flavor = options.flavor;
  f.tabWidth = options.flavor === FLAVOR_OXFMT ? options.indentWidth : 0;
  // Of the name of the file, no more than this is asked.
  const status = writeDocument(f, text, parser, options.isInHtmlFile ? ".html" : null, options, true, indentLevel, -1, options.flavor);
  const count = topLevelCount();
  const ranOut = f.context.ranOutOfStack;
  f.context = outerContext;
  f.options = outerOptions;
  f.flavor = outerFlavor;
  f.tabWidth = outerTabWidth;
  if (ranOut) outerContext.ranOutOfStack = true;
  f.endEmbedded();
  const document = f.endCapture(slot);
  if (status !== FORMAT_OK) return false;
  // The options of the HTML are Prettier's for either tool.
  if (outer.flavor === FLAVOR_OXFMT && !hasAsManySubstitutions(text, document, f)) return false;
  // In the order of the source, whatever the order of the placeholders: that of the comments.
  const expressions = new I32Vec(quasis.length);
  for (let index = 0; index + 1 < quasis.length; index++) {
    const s = f.startCapture();
    writeSubstitution(index);
    expressions.push(f.endCapture(s));
  }
  const substitutions = new Substitutions(expressions, "_" + String(counter) + PLACEHOLDER_END, outer.inHtml.root !== HTML_ROOT_NONE);

  const isIndented = line >= 0 || count > 1;
  f.startGroup();
  f.token(TK_BACKTICK);
  if (line < 0 && startsWithWhiteSpace(text, 0, text.length)) f.token(TK_SPACE);
  if (isIndented) f.startIndent();
  if (line >= 0) f.line(line);
  f.startGroup();
  writeMapped(f, document, substitutions);
  f.endGroup();
  if (isIndented) f.endIndent();
  if (line >= 0) f.line(line);
  else if (trimJsWhitespaceEnd(text, 0, text.length) < text.length) f.token(TK_SPACE);
  f.token(TK_BACKTICK);
  f.endGroup();
  return true;
}

void P_HTML;
