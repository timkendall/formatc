// Port of vendor/bun/src/format/css/embed.rs: style sheets in the templates of JavaScript (Prettier's
// `language-js/embed/index.js` and `css.js`), and the writer that puts the document of a style sheet into the document of
// another language (`write_document`: html uses it for `<style>`).
//
// Ported: the placeholders, the Doc -> IR writer (`writeDocument`, `writeDocumentWithTemplate`) and `printEmbedCss`. NOT ported
// (needs the handles of `bun_lint::ast`, which the JS formatter owns; the Rust is kept in comments): `is_embed_css`,
// `is_styled_tag`, `is_angular_component_property`, `root_name_of_tag`, `write_template`, `has_embed_label`,
// `tag_alone_decides_what_is_around_a_template`. The JS porter implements them over its handles and calls `printEmbedCss`.
//
// The substitutions of a template: `printEmbedCss` takes the `quasis` as raw texts and a hook that writes the expression with
// the number `n` (Rust `write_embedded_template_expression(template, number, f)`).
import { ByteBuf } from "../../base/bytebuf.ts";
import { Stack } from "../../base/stack.ts";
import { FormatOptions } from "../options.ts";
import { Formatter } from "../ir/formatter.ts";
import { twMultilineString, twIsMultiline, twValue } from "../ir/element.ts";
import { trimJsWhitespaceStart } from "../text.ts";
import {
  DOC_BREAK_PARENT,
  DOC_LINE,
  LINE_HARD,
  LINE_LITERAL,
  LINE_SOFT,
  LINE_SPACE,
  DOC_ALIGN,
  DOC_ARRAY,
  DOC_DEDENT,
  DOC_DEDENT_TO_ROOT,
  DOC_FILL,
  DOC_GROUP,
  DOC_IF_BREAK,
  DOC_INDENT,
  DOC_LINE_SUFFIX,
  DOC_LINE_SUFFIX_BOUNDARY,
  DOC_MARK_AS_ROOT,
  DOC_TEXT,
  docPool,
  docPop,
  docPush,
  textToDoc,
} from "./doc.ts";
import { Scratch, threadScratch } from "./mod.ts";
import { SYNTAX_SCSS } from "./syntax.ts";
import { indexOfLit } from "./misc.ts";
import { FORMAT_OK } from "../errors.ts";
import { parseAndPrintToDocument } from "./mod.ts";

const PLACEHOLDER = "@prettier-placeholder-";

// `/@prettier-placeholder-(\d+)-id/`: where the first match in `text` starts and ends, and the number. Sets
// `phStart`, `phEnd`, `phNumber`; returns whether there is one.
let phStart = 0;
let phEnd = 0;
let phNumber = 0;

function findPlaceholder(text: Uint8Array, s: number, e: number): boolean {
  let from = s;
  while (true) {
    const start = indexOfLit(text, from, e, PLACEHOLDER);
    if (start < 0) return false;
    const digitsStart = start + PLACEHOLDER.length;
    let d = digitsStart;
    while (d < e && (text[d] | 0) >= 48 && (text[d] | 0) <= 57) d = d + 1;
    if (d > digitsStart && d + 3 <= e && (text[d] | 0) === 45 && (text[d + 1] | 0) === 105 && (text[d + 2] | 0) === 100) {
      let number = 0;
      for (let i = digitsStart; i < d; i++) {
        number = number * 10 + ((text[i] | 0) - 48);
        if (number > 1e15) number = 1e15;
      }
      phStart = start;
      phEnd = d + 3;
      phNumber = number;
      return true;
    }
    from = digitsStart;
  }
}

/** How many placeholders are in the strings of `doc`, or -1 if one of them has a number that is not below `count`. */
export function countPlaceholders(doc: number, count: number): number {
  const p = docPool;
  let found = 0;
  const rest: number[] = [doc];
  while (rest.length > 0) {
    const d = rest.pop() as number;
    const tag = p.tag[d] | 0;
    switch (tag) {
      case DOC_TEXT: {
        let s = p.a[d] | 0;
        const e = s + (p.b[d] | 0);
        while (findPlaceholder(p.bytes, s, e)) {
          if (phNumber >= count) return -1;
          found = found + 1;
          s = phEnd;
        }
        break;
      }
      case DOC_ARRAY:
      case DOC_FILL: {
        const s = p.a[d] | 0;
        const n = p.b[d] | 0;
        for (let i = 0; i < n; i++) rest.push(p.kids[s + i] | 0);
        break;
      }
      case DOC_INDENT:
      case DOC_ALIGN:
      case DOC_DEDENT:
      case DOC_DEDENT_TO_ROOT:
      case DOC_MARK_AS_ROOT:
      case DOC_LINE_SUFFIX:
      case DOC_GROUP:
        rest.push(p.a[d] | 0);
        break;
      case DOC_IF_BREAK:
        rest.push(p.a[d] | 0);
        rest.push(p.b[d] | 0);
        break;
      default:
        break;
    }
  }
  return found;
}

/** Whether there is a `breakParent` in `doc` that is in no group in it. */
function hasBreakParentOutsideOfGroups(doc: number): boolean {
  const p = docPool;
  const rest: number[] = [doc];
  while (rest.length > 0) {
    const d = rest.pop() as number;
    const tag = p.tag[d] | 0;
    switch (tag) {
      case DOC_BREAK_PARENT:
        return true;
      case DOC_ARRAY:
      case DOC_FILL: {
        const s = p.a[d] | 0;
        const n = p.b[d] | 0;
        for (let i = 0; i < n; i++) rest.push(p.kids[s + i] | 0);
        break;
      }
      case DOC_INDENT:
      case DOC_ALIGN:
      case DOC_DEDENT:
      case DOC_DEDENT_TO_ROOT:
      case DOC_MARK_AS_ROOT:
        rest.push(p.a[d] | 0);
        break;
      case DOC_IF_BREAK:
        rest.push(p.a[d] | 0);
        rest.push(p.b[d] | 0);
        break;
      default:
        break;
    }
  }
  return false;
}

const NEWLINE = new Uint8Array([10]);

/** Writes the document of a style sheet as a part of the document that `f` writes. */
class Writer {
  hasPlaceholders: boolean;
  /** Writes the expression `n` of the template (null: there is no template). */
  writeExpression: ((n: number) => void) | null;
  /** What is written is in an item of a `fill`, and in no group in that. */
  isDirectlyInFill: boolean;
  isInLineSuffix: boolean;
  stack: Stack;

  constructor(hasPlaceholders: boolean, writeExpression: ((n: number) => void) | null, stack: Stack) {
    this.hasPlaceholders = hasPlaceholders;
    this.writeExpression = writeExpression;
    this.isDirectlyInFill = false;
    this.isInLineSuffix = false;
    this.stack = stack;
  }

  /** A string in which a line break is nothing but a character without a width, as it is for Prettier. */
  private writeString(f: Formatter, bytes: Uint8Array, s: number, e: number): void {
    if (e <= s) return;
    let width = f.textWidth(bytes, s, e);
    if (twIsMultiline(width)) {
      let sum = 0;
      let lineStart = s;
      while (true) {
        let lineEnd = e;
        for (let i = lineStart; i < e; i++) {
          if ((bytes[i] | 0) === 10) { lineEnd = i; break; }
        }
        sum = sum + twValue(f.textWidth(bytes, lineStart, lineEnd));
        if (lineEnd >= e) break;
        lineStart = lineEnd + 1;
      }
      width = twMultilineString(sum);
    }
    f.textBytesWithWidth(bytes, s, e, width);
  }

  /** `replaceEndOfLine(text)` */
  private writeWithLiteralLines(f: Formatter, bytes: Uint8Array, s: number, e: number): void {
    if (e <= s) return;
    f.textBytes(bytes, s, e);
    if (indexOfLit(bytes, s, e, "\n") >= 0) f.expandParent();
  }

  write(f: Formatter, doc: number): void {
    if (!this.stack.enter()) return;
    this.writeInner(f, doc);
    this.stack.leave();
  }

  private writeInner(f: Formatter, doc: number): void {
    const p = docPool;
    const tag = p.tag[doc] | 0;
    switch (tag) {
      case DOC_TEXT: {
        const s = p.a[doc] | 0;
        const e = s + (p.b[doc] | 0);
        // Only a string with a substitution in it is taken apart.
        if (!this.hasPlaceholders || !findPlaceholder(p.bytes, s, e)) {
          this.writeString(f, p.bytes, s, e);
        } else {
          let rest = s;
          while (findPlaceholder(p.bytes, rest, e)) {
            this.writeWithLiteralLines(f, p.bytes, rest, phStart);
            const number = phNumber;
            const end = phEnd;
            if (this.writeExpression !== null) this.writeExpression(number);
            rest = end;
          }
          this.writeWithLiteralLines(f, p.bytes, rest, e);
        }
        break;
      }
      case DOC_ARRAY: {
        const s = p.a[doc] | 0;
        const n = p.b[doc] | 0;
        let index = 0;
        while (index < n) {
          const part = p.kids[s + index] | 0;
          const rem = n - index;
          const t0 = p.tag[part] | 0;
          const isLine = (i: number, kind: number): boolean => {
            const x = p.kids[s + index + i] | 0;
            return (p.tag[x] | 0) === DOC_LINE && (p.a[x] | 0) === kind;
          };
          const isBreak = (i: number): boolean => (p.tag[p.kids[s + index + i] | 0] | 0) === DOC_BREAK_PARENT;
          const isSpaceOrSoft = (i: number): boolean => {
            const x = p.kids[s + index + i] | 0;
            return (p.tag[x] | 0) === DOC_LINE && ((p.a[x] | 0) === LINE_SPACE || (p.a[x] | 0) === LINE_SOFT);
          };
          // Two line breaks in a row are an empty line.
          if (rem >= 4 && isLine(0, LINE_HARD) && isBreak(1) && isLine(2, LINE_HARD) && isBreak(3)) {
            f.emptyLine();
            index = index + 4;
            continue;
          }
          // The group is broken, so this is two line breaks as well.
          if (rem >= 3 && isLine(0, LINE_HARD) && isBreak(1) && isSpaceOrSoft(2)) {
            f.emptyLine();
            index = index + 3;
            continue;
          }
          // The same the other way round: declarations in the `style` attribute of HTML with an empty line between them.
          if (rem >= 3 && isSpaceOrSoft(0) && isLine(1, LINE_HARD) && isBreak(2)) {
            f.emptyLine();
            index = index + 3;
            continue;
          }
          // `(` and `)` with nothing in between.
          if (rem >= 2 && t0 === DOC_INDENT && isLine(1, LINE_SOFT)) {
            const inner = p.a[part] | 0;
            if ((p.tag[inner] | 0) === DOC_LINE && (p.a[inner] | 0) === LINE_SOFT) {
              f.softEmptyLine();
              index = index + 2;
              continue;
            }
          }
          this.write(f, part);
          index = index + 1;
        }
        break;
      }
      case DOC_INDENT:
        f.startIndent();
        this.write(f, p.a[doc] | 0);
        f.endIndent();
        break;
      case DOC_DEDENT:
        f.startDedent();
        this.write(f, p.a[doc] | 0);
        f.endDedent();
        break;
      // Style sheets have none of these.
      case DOC_ALIGN:
      case DOC_DEDENT_TO_ROOT:
      case DOC_MARK_AS_ROOT:
        this.write(f, p.a[doc] | 0);
        break;
      case DOC_GROUP: {
        const shouldBreak = ((p.b[doc] | 0) & 1) !== 0;
        const wasDirectlyInFill = this.isDirectlyInFill;
        this.isDirectlyInFill = false;
        f.startGroupExpand(shouldBreak);
        this.write(f, p.a[doc] | 0);
        f.endGroup();
        this.isDirectlyInFill = wasDirectlyInFill;
        break;
      }
      case DOC_FILL: {
        const s = p.a[doc] | 0;
        const n = p.b[doc] | 0;
        // For Prettier, a `breakParent` is about the groups around it, and says nothing about whether an item fits.
        if (!this.isDirectlyInFill) {
          for (let i = 0; i < n; i++) {
            if (hasBreakParentOutsideOfGroups(p.kids[s + i] | 0)) {
              f.expandParent();
              break;
            }
          }
        }
        const was = this.isDirectlyInFill;
        this.isDirectlyInFill = true;
        f.startFill();
        for (let i = 0; i < n; i++) {
          f.startEntry();
          this.write(f, p.kids[s + i] | 0);
          f.endEntry();
        }
        f.endFill();
        this.isDirectlyInFill = was;
        break;
      }
      case DOC_IF_BREAK: {
        const brk = p.a[doc] | 0;
        const flat = p.b[doc] | 0;
        if (!p.isEmptyText(brk)) {
          f.startIfGroupBreaks();
          this.write(f, brk);
          f.endConditional();
        }
        if (!p.isEmptyText(flat)) {
          f.startIfGroupFits();
          this.write(f, flat);
          f.endConditional();
        }
        break;
      }
      case DOC_LINE_SUFFIX:
        // One in another comes to the same as one.
        if (this.isInLineSuffix) {
          this.write(f, p.a[doc] | 0);
        } else {
          this.isInLineSuffix = true;
          f.startLineSuffix();
          this.write(f, p.a[doc] | 0);
          f.endLineSuffix();
          this.isInLineSuffix = false;
        }
        break;
      case DOC_LINE_SUFFIX_BOUNDARY:
        f.lineSuffixBoundary();
        break;
      case DOC_BREAK_PARENT:
        if (!this.isDirectlyInFill) f.expandParent();
        break;
      default: {
        const kind = p.a[doc] | 0;
        if (kind === LINE_SPACE) f.softLineBreakOrSpace();
        else if (kind === LINE_SOFT) f.softLineBreak();
        else if (kind === LINE_HARD) f.hardLineBreak();
        else f.textBytes(NEWLINE, 0, 1);
        break;
      }
    }
  }
}

/** Writes `document` (a `Doc` handle), which is that of a style sheet, as a part of the document that `f` writes. */
export function writeDocument(document: number, f: Formatter): void {
  const writer = new Writer(false, null, Stack.create());
  writer.write(f, document);
}

/** What is done with the document of a template. */
export const ACTION_CHECK = 0;
export const ACTION_WRITE = 1;

// TODO(port): the Rust `LITERAL_LINE`s above `Doc::Line(Line::Literal)`: `f.write_text(b"\n", None)`.
void LINE_LITERAL;

/** Prettier's `printEmbedCss`. `quasis`: the raw texts of the template (a template with `n` substitutions has `n + 1`).
 * Nothing is written and `false` is returned if the text cannot be parsed as SCSS, or if not every substitution is in the
 * document exactly once. `f`: where to write (null: only whether it is possible is asked); `writeExpression(n)` writes the
 * substitution number `n`. */
export function printEmbedCss(
  quasis: Uint8Array[],
  options: FormatOptions,
  f: Formatter | null,
  writeExpression: ((n: number) => void) | null,
): boolean {
  const count = quasis.length > 0 ? quasis.length - 1 : 0;
  const text = new ByteBuf(256);
  for (let index = 0; index < quasis.length; index++) {
    if (index > 0) {
      text.appendAscii(PLACEHOLDER);
      text.appendAscii(String(index - 1));
      text.appendAscii("-id");
    }
    text.appendAll(quasis[index]);
  }
  // `crlf_as_lf`
  const raw = text.view();
  let lf = raw;
  if (indexOfLit(raw, 0, raw.length, "\r") >= 0) {
    const out = new ByteBuf(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i] | 0;
      if (c === 13) {
        out.push(10);
        if (i + 1 < raw.length && (raw[i + 1] | 0) === 10) i = i + 1;
      } else {
        out.push(c);
      }
    }
    lf = out.view();
  }
  docPush();
  const document = parseAndPrintToDocument(lf, SYNTAX_SCSS, options);
  let ok = document >= 0;
  let doc = 0;
  if (ok) {
    doc = textToDoc(document);
    ok = doc >= 0;
  }
  if (ok && (docPool.isEmptyText(doc) || (count > 0 && countPlaceholders(doc, count) !== count))) ok = false;
  if (ok && f !== null) {
    f.tokenStr("`");
    f.startIndent();
    f.hardLineBreak();
    const writer = new Writer(count > 0, writeExpression, f.stack);
    writer.write(f, doc);
    f.endIndent();
    f.softLineBreak();
    f.tokenStr("`");
  }
  docPop();
  return ok;
}

/** Whether `template` is written ` `` `: one quasi with nothing but white space. */
export function isBlank(quasis: Uint8Array[]): boolean {
  if (quasis.length !== 1) return false;
  const q = quasis[0];
  return trimJsWhitespaceStart(q, 0, q.length) >= q.length;
}

// TODO(port) (JS handles, `bun_lint::ast`; see embed.rs):
//   is_identifier, member_object, call_callee, is_styled_extend, is_styled_object, is_styled_tag (css``, css.global``,
//   styled.foo``, styled(Component)``, Component.extend``, ...), has_name, is_angular_component_styles,
//   is_angular_component_property (also used by html/in_js.rs), root_name_of_tag (also used by graphql/embed.rs),
//   is_embed_css / is_embed_css_for(flavor), is_candidate, write_template (`printEmbedCss(.., Action::Write)` when the template
//   is a candidate; a blank one is "``"), has_embed_label, tag_alone_decides_what_is_around_a_template (oxfmt flavor).

void ACTION_CHECK;
void ACTION_WRITE;
void Scratch;
void threadScratch;
void FORMAT_OK;
