// Port of vendor/bun/src/md/html_renderer.rs (and the HTML output sink of output.rs).
import { ByteBuf } from "./buf.ts";
import {
  HeadingIdTracker,
  ciEqLit,
  decodeEntityToUtf8,
  findEntity,
  isAsciiPunctuation,
  isBlank,
  isNewline,
  isWhitespace,
} from "./helpers.ts";
import type { RenderOptions } from "./options.ts";
import {
  BLOCK_FENCED_CODE,
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
  EMPTY,
  Renderer,
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
  TX_NULLCHAR,
  TX_SOFTBR,
  alignmentFromData,
  isTaskChecked,
  taskMarkFromData,
} from "./types.ts";
import type { SpanDetail } from "./types.ts";

// The bytes of a URL that are written as they are.
const URL_SAFE = new Uint8Array(256);
{
  const safe = "-._~:/?#@!$()*+,;=%";
  for (let i = 0; i < safe.length; i++) URL_SAFE[safe.charCodeAt(i)] = 1;
  for (let c = 65; c <= 90; c++) URL_SAFE[c] = 1;
  for (let c = 97; c <= 122; c++) URL_SAFE[c] = 1;
  for (let c = 48; c <= 57; c++) URL_SAFE[c] = 1;
}
const HEX = "0123456789ABCDEF";

const DISALLOWED_TAGS: string[] = [
  "title", "textarea", "style", "xmp", "iframe", "noembed", "noframes", "script", "plaintext",
];

const H_OPEN: string[] = ["<h1>", "<h1>", "<h2>", "<h3>", "<h4>", "<h5>", "<h6>"];
const H_OPEN_ID: string[] = ["<h6", "<h1", "<h2", "<h3", "<h4", "<h5", "<h6"];
const H_CLOSE: string[] = ["</h6>\n", "</h1>\n", "</h2>\n", "</h3>\n", "</h4>\n", "</h5>\n", "</h6>\n"];

export class HtmlRenderer extends Renderer {
  out: ByteBuf = new ByteBuf(1 << 16);
  srcText: Uint8Array = EMPTY;
  imageNestingLevel = 0;
  savedImgBuf: Uint8Array = EMPTY;
  savedImgStart = 0;
  savedImgEnd = 0;
  tagFilter = false;
  autolinkHeadings = false;
  headingBuf: ByteBuf = new ByteBuf(256);
  headingTracker: HeadingIdTracker = new HeadingIdTracker();
  private decoded: Uint8Array = new Uint8Array(8);
  private savedTitle: ByteBuf = new ByteBuf(64);

  /** Starts a document: HTML is appended to `out`. */
  init(srcText: Uint8Array, renderOpts: RenderOptions, out: ByteBuf): void {
    this.out = out;
    this.srcText = srcText;
    this.imageNestingLevel = 0;
    this.savedTitle.reset();
    this.tagFilter = renderOpts.tagFilter;
    this.autolinkHeadings = renderOpts.autolinkHeadings;
    this.headingBuf.reset();
    this.headingTracker.init(renderOpts.headingIds);
  }

  finish(): void {}

  // ---- Block rendering ----

  enterBlock(blockType: number, data: number, flags: number): void {
    switch (blockType) {
      case BT_DOC:
        break;
      case BT_QUOTE:
        this.ensureNewline();
        this.writeStr("<blockquote>\n");
        break;
      case BT_UL:
        this.ensureNewline();
        this.writeStr("<ul>\n");
        break;
      case BT_OL:
        this.ensureNewline();
        if (data === 1) {
          this.writeStr("<ol>\n");
        } else {
          this.writeStr('<ol start="');
          this.writeDecimal(data);
          this.writeStr('">\n');
        }
        break;
      case BT_LI: {
        const taskMark = taskMarkFromData(data);
        if (taskMark !== 0) {
          this.writeStr('<li class="task-list-item">');
          if (isTaskChecked(taskMark)) {
            this.writeStr('<input type="checkbox" class="task-list-item-checkbox" disabled checked>');
          } else {
            this.writeStr('<input type="checkbox" class="task-list-item-checkbox" disabled>');
          }
        } else {
          this.writeStr("<li>");
        }
        break;
      }
      case BT_HR:
        this.ensureNewline();
        this.writeStr("<hr />\n");
        break;
      case BT_H:
        this.ensureNewline();
        if (this.headingTracker.enabled) {
          this.headingTracker.enterHeading();
        } else {
          this.writeStr(H_OPEN[data < 1 || data > 6 ? 6 : data]);
        }
        break;
      case BT_CODE: {
        this.ensureNewline();
        this.writeStr("<pre><code");
        if ((flags & BLOCK_FENCED_CODE) !== 0) {
          const infoBeg = data;
          const src = this.srcText;
          // Find end of language token (first word of info string)
          let langEnd = infoBeg;
          while (langEnd < src.length && !isBlank(src[langEnd] | 0) && !isNewline(src[langEnd] | 0)) langEnd = ((langEnd | 0) + 1) | 0;
          if (langEnd > infoBeg) {
            this.writeStr(' class="language-');
            this.writeWithEntityDecoding(src, infoBeg, langEnd);
            this.writeStr('"');
          }
        }
        this.writeStr(">");
        break;
      }
      case BT_HTML:
        this.ensureNewline();
        break;
      case BT_P:
        this.ensureNewline();
        this.writeStr("<p>");
        break;
      case BT_TABLE:
        this.ensureNewline();
        this.writeStr("<table>\n");
        break;
      case BT_THEAD:
        this.writeStr("<thead>\n");
        break;
      case BT_TBODY:
        this.writeStr("<tbody>\n");
        break;
      case BT_TR:
        this.writeStr("<tr>");
        break;
      case BT_TH:
      case BT_TD: {
        this.writeStr(blockType === BT_TH ? "<th" : "<td");
        const alignment = alignmentFromData(data);
        if (alignment !== 0) {
          this.writeStr(' align="');
          this.writeStr(alignment === 1 ? "left" : alignment === 2 ? "center" : "right");
          this.writeStr('"');
        }
        this.writeStr(">");
        break;
      }
      default:
        break;
    }
  }

  leaveBlock(blockType: number, data: number): void {
    switch (blockType) {
      case BT_DOC:
        break;
      case BT_QUOTE:
        this.writeStr("</blockquote>\n");
        break;
      case BT_UL:
        this.writeStr("</ul>\n");
        break;
      case BT_OL:
        this.writeStr("</ol>\n");
        break;
      case BT_LI:
        this.writeStr("</li>\n");
        break;
      case BT_HR:
        break;
      case BT_H: {
        const slug = this.headingTracker.leaveHeading();
        const lvl = data < 1 || data > 6 ? 0 : data;
        if (slug !== null) {
          // Write opening tag with id
          const out = this.out;
          out.appendAscii(H_OPEN_ID[lvl]);
          out.appendAscii(' id="');
          out.appendAscii(slug);
          out.appendAscii('">');
          if (this.autolinkHeadings) {
            out.appendAscii('<a href="#');
            out.appendAscii(slug);
            out.appendAscii('">');
          }
          // Flush buffered heading content
          out.append(this.headingBuf.data, 0, this.headingBuf.len);
          if (this.autolinkHeadings) out.appendAscii("</a>");
          out.appendAscii(H_CLOSE[lvl]);
          this.headingBuf.reset();
          this.headingTracker.clearAfterHeading();
        } else {
          this.writeStr(H_CLOSE[lvl]);
        }
        break;
      }
      case BT_CODE:
        this.writeStr("</code></pre>\n");
        break;
      case BT_HTML:
        break;
      case BT_P:
        this.writeStr("</p>\n");
        break;
      case BT_TABLE:
        this.writeStr("</table>\n");
        break;
      case BT_THEAD:
        this.writeStr("</thead>\n");
        break;
      case BT_TBODY:
        this.writeStr("</tbody>\n");
        break;
      case BT_TR:
        this.writeStr("</tr>\n");
        break;
      case BT_TH:
        this.writeStr("</th>");
        break;
      case BT_TD:
        this.writeStr("</td>");
        break;
      default:
        break;
    }
  }

  // ---- Span rendering ----

  enterSpan(spanType: number, d: SpanDetail): void {
    if (this.imageNestingLevel > 0) {
      if (spanType === SP_IMG) this.imageNestingLevel++;
      return;
    }

    switch (spanType) {
      case SP_EM:
        this.writeStr("<em>");
        break;
      case SP_STRONG:
        this.writeStr("<strong>");
        break;
      case SP_U:
        this.writeStr("<u>");
        break;
      case SP_CODE:
        this.writeStr("<code>");
        break;
      case SP_DEL:
        this.writeStr("<del>");
        break;
      case SP_LATEXMATH:
        this.writeStr("<x-equation>");
        break;
      case SP_LATEXMATH_DISPLAY:
        this.writeStr('<x-equation type="display">');
        break;
      case SP_A:
        this.writeStr('<a href="');
        if (d.permissiveAutolink) {
          // Permissive autolinks use HTML-escaping for href
          if (d.autolinkEmail) this.writeStr("mailto:");
          if (d.autolinkWww) this.writeStr("http://");
          this.writeHtmlEscaped(d.hrefBuf, d.hrefStart, d.hrefEnd);
        } else if (d.autolink) {
          // Standard autolinks: percent-encode only, no entity/escape processing
          if (d.autolinkEmail) this.writeStr("mailto:");
          this.writeUrlEscaped(d.hrefBuf, d.hrefStart, d.hrefEnd);
        } else {
          // Regular links: full entity/escape processing
          if (d.autolinkEmail) this.writeStr("mailto:");
          this.writeUrlWithEscapes(d.hrefBuf, d.hrefStart, d.hrefEnd);
        }
        this.writeStr('"');
        if (d.titleEnd > d.titleStart) {
          this.writeStr(' title="');
          this.writeTitleWithEscapes(d.titleBuf, d.titleStart, d.titleEnd);
          this.writeStr('"');
        }
        this.writeStr(">");
        break;
      case SP_IMG:
        this.savedTitle.reset();
        this.savedTitle.append(d.titleBuf, d.titleStart, d.titleEnd);
        this.writeStr('<img src="');
        this.writeUrlWithEscapes(d.hrefBuf, d.hrefStart, d.hrefEnd);
        this.writeStr('" alt="');
        this.imageNestingLevel++;
        break;
      case SP_WIKILINK:
        this.writeStr('<x-wikilink data-target="');
        this.writeHtmlEscaped(d.hrefBuf, d.hrefStart, d.hrefEnd);
        this.writeStr('">');
        break;
      default:
        break;
    }
  }

  leaveSpan(spanType: number): void {
    if (this.imageNestingLevel > 0) {
      if (spanType === SP_IMG) {
        this.imageNestingLevel--;
        if (this.imageNestingLevel === 0) {
          this.writeStr('"');
          if (this.savedTitle.len !== 0) {
            this.writeStr(' title="');
            const t = this.savedTitle;
            this.writeTitleWithEscapes(t.data, 0, t.len);
            this.writeStr('"');
          }
          this.writeStr(" />");
          this.savedTitle.reset();
        }
      }
      return;
    }

    switch (spanType) {
      case SP_EM:
        this.writeStr("</em>");
        break;
      case SP_STRONG:
        this.writeStr("</strong>");
        break;
      case SP_U:
        this.writeStr("</u>");
        break;
      case SP_A:
        this.writeStr("</a>");
        break;
      case SP_CODE:
        this.writeStr("</code>");
        break;
      case SP_DEL:
        this.writeStr("</del>");
        break;
      case SP_LATEXMATH:
      case SP_LATEXMATH_DISPLAY:
        this.writeStr("</x-equation>");
        break;
      case SP_WIKILINK:
        this.writeStr("</x-wikilink>");
        break;
      default:
        break; // Img handled above
    }
  }

  // ---- Text rendering ----

  text(textType: number, buf: Uint8Array, start: number, end: number): void {
    const inImage = this.imageNestingLevel > 0;

    // Track plain text for slug generation when inside a heading
    this.headingTracker.trackText(textType, buf, start, end);

    switch (textType) {
      case TX_NULLCHAR:
        this.writeBytes3(0xef, 0xbf, 0xbd);
        break;
      case TX_BR:
        if (inImage) this.writeStr(" ");
        else this.writeStr("<br />\n");
        break;
      case TX_SOFTBR:
        if (inImage) this.writeStr(" ");
        else this.writeStr("\n");
        break;
      case TX_HTML:
        if (this.tagFilter) this.writeHtmlWithTagFilter(buf, start, end);
        else this.write(buf, start, end);
        break;
      case TX_ENTITY:
        this.writeEntity(buf, start, end);
        break;
      case TX_CODE: {
        // In code spans, newlines become spaces
        let s = start;
        for (let j = start; j < end; j++) {
          if ((buf[j] | 0) === 10) {
            if (j > s) this.writeHtmlEscaped(buf, s, j);
            this.writeStr(" ");
            s = j + 1;
          }
        }
        if (s < end) this.writeHtmlEscaped(buf, s, end);
        break;
      }
      default:
        this.writeHtmlEscaped(buf, start, end);
        break;
    }
  }

  // ---- HTML writing utilities ----

  private target(): ByteBuf {
    return this.headingTracker.inHeading ? this.headingBuf : this.out;
  }

  private write(buf: Uint8Array, start: number, end: number): void {
    this.target().append(buf, start, end);
  }

  private writeStr(s: string): void {
    this.target().appendAscii(s);
  }

  private writeByte(b: number): void {
    this.target().push(b);
  }

  private writeBytes3(a: number, b: number, c: number): void {
    const t = this.target();
    t.push(a);
    t.push(b);
    t.push(c);
  }

  /** Write HTML content with GFM tag filter applied. Scans for disallowed tags and replaces their leading `<` with `&lt;`. */
  private writeHtmlWithTagFilter(buf: Uint8Array, start: number, end: number): void {
    let s = start;
    for (let i = start; i < end; i++) {
      if ((buf[i] | 0) === 60 && isDisallowedTag(buf, i, end)) {
        // Write everything before this '<'
        if (i > s) this.write(buf, s, i);
        this.writeStr("&lt;");
        s = i + 1;
      }
    }
    if (s < end) this.write(buf, s, end);
  }

  private ensureNewline(): void {
    const t = this.target();
    if (t.len !== 0 && (t.data[t.len - 1] | 0) !== 10) t.push(10);
  }

  private writeHtmlEscaped(txt: Uint8Array, start: number, end: number): void {
    const t = this.target();
    let s = start;
    for (let i = start; i < end; i++) {
      const c = txt[i] | 0;
      if (c === 38 || c === 60 || c === 62 || c === 34) {
        if (i > s) t.append(txt, s, i);
        t.appendAscii(c === 38 ? "&amp;" : c === 60 ? "&lt;" : c === 62 ? "&gt;" : "&quot;");
        s = i + 1;
      }
    }
    if (s < end) t.append(txt, s, end);
  }

  private writeUrlEscaped(txt: Uint8Array, start: number, end: number): void {
    let i = start;
    while (i < end) {
      i = ((i | 0) + ((this.writeUrlSafeRun(txt, i, end)) | 0)) | 0;
      if (i < end) {
        this.writeUrlByte(txt[i] | 0);
        i = ((i | 0) + 1) | 0;
      }
    }
  }

  /** Writes the bytes at the start of `txt[from, end)` that are written as they are. Returns how many there are. */
  private writeUrlSafeRun(txt: Uint8Array, from: number, end: number): number {
    let len = 0;
    while (from + len < end && (URL_SAFE[txt[from + len] | 0] | 0) !== 0) len = ((len | 0) + 1) | 0;
    if (len > 0) this.write(txt, from, from + len);
    return len;
  }

  private writeUrlByte(byte: number): void {
    if (byte === 38) {
      this.writeStr("&amp;");
    } else if (byte === 39) {
      this.writeStr("&#x27;");
    } else if ((URL_SAFE[byte] | 0) !== 0) {
      this.writeByte(byte);
    } else {
      const t = this.target();
      t.push(37);
      t.push(HEX.charCodeAt(byte >> 4));
      t.push(HEX.charCodeAt(byte & 15));
    }
  }

  /** Write URL with backslash escape and entity processing. */
  private writeUrlWithEscapes(txt: Uint8Array, start: number, end: number): void {
    const len = end - start;
    let i = 0;
    while (i < len) {
      i = ((i | 0) + ((this.writeUrlSafeRun(txt, start + i, end)) | 0)) | 0;
      if (i === len) break;
      const c = txt[start + i] | 0;
      if (c === 92 && i + 1 < len && isAsciiPunctuation(txt[start + i + 1] | 0)) {
        this.writeUrlByte(txt[start + i + 1] | 0);
        i = ((i | 0) + ((2) | 0)) | 0;
      } else if (c === 38) {
        const endPos = findEntity(txt, start, len, i);
        if (endPos >= 0) {
          this.writeEntityToUrl(txt, start + i, start + endPos);
          i = endPos;
        } else {
          this.writeStr("&amp;");
          i = ((i | 0) + 1) | 0;
        }
      } else {
        this.writeUrlByte(c);
        i = ((i | 0) + 1) | 0;
      }
    }
  }

  /** Write title attribute with backslash escape and entity processing (HTML-escaped). */
  private writeTitleWithEscapes(txt: Uint8Array, start: number, end: number): void {
    const len = end - start;
    let i = 0;
    while (i < len) {
      const c = txt[start + i] | 0;
      if (c === 92 && i + 1 < len && isAsciiPunctuation(txt[start + i + 1] | 0)) {
        this.writeHtmlEscaped(txt, start + i + 1, start + i + 2);
        i = ((i | 0) + ((2) | 0)) | 0;
      } else if (c === 38) {
        const endPos = findEntity(txt, start, len, i);
        if (endPos >= 0) {
          this.writeEntity(txt, start + i, start + endPos);
          i = endPos;
        } else {
          this.writeStr("&amp;");
          i = ((i | 0) + 1) | 0;
        }
      } else {
        this.writeHtmlEscaped(txt, start + i, start + i + 1);
        i = ((i | 0) + 1) | 0;
      }
    }
  }

  /** Write text with entity and backslash escape decoding, then HTML-escape the result. Used for code fence info strings. */
  private writeWithEntityDecoding(txt: Uint8Array, start: number, end: number): void {
    const len = end - start;
    let i = 0;
    while (i < len) {
      const c = txt[start + i] | 0;
      if (c === 38) {
        const endPos = findEntity(txt, start, len, i);
        if (endPos >= 0) {
          this.writeEntity(txt, start + i, start + endPos);
          i = endPos;
          continue;
        }
      } else if (c === 92 && i + 1 < len && isAsciiPunctuation(txt[start + i + 1] | 0)) {
        this.writeHtmlEscaped(txt, start + i + 1, start + i + 2);
        i = ((i | 0) + ((2) | 0)) | 0;
        continue;
      }
      this.writeHtmlEscaped(txt, start + i, start + i + 1);
      i = ((i | 0) + 1) | 0;
    }
  }

  private writeEntity(buf: Uint8Array, start: number, end: number): void {
    const n = decodeEntityToUtf8(buf, start, end, this.decoded);
    if (n >= 0) this.writeHtmlEscaped(this.decoded, 0, n);
    else this.write(buf, start, end);
  }

  /** Decode an entity and write its UTF-8 bytes as percent-encoded URL bytes. */
  private writeEntityToUrl(buf: Uint8Array, start: number, end: number): void {
    const n = decodeEntityToUtf8(buf, start, end, this.decoded);
    if (n >= 0) {
      for (let k = 0; k < n; k++) this.writeUrlByte(this.decoded[k] | 0);
    } else {
      this.writeUrlEscaped(buf, start, end);
    }
  }

  private writeDecimal(value: number): void {
    this.writeStr(String(value));
  }
}

/**
 * GFM 6.11: Check if HTML content `buf[at, end)` starts with a disallowed tag. Disallowed tags have their leading `<`
 * replaced with `&lt;`.
 */
function isDisallowedTag(buf: Uint8Array, at: number, end: number): boolean {
  // Must start with '<', optionally followed by '/'
  if (end - at < 2 || (buf[at] | 0) !== 60) return false;
  const afterLt = (buf[at + 1] | 0) === 47 ? 2 : 1;
  if (afterLt >= end - at) return false;
  for (let i = 0; i < DISALLOWED_TAGS.length; i++) {
    if (matchTagNameCi(buf, at + afterLt, end, DISALLOWED_TAGS[i])) return true;
  }
  return false;
}

/** Case-insensitive match of tag name at `pos`. After the name, the next char must be '>', '/', whitespace, or the end. */
function matchTagNameCi(buf: Uint8Array, pos: number, end: number, tag: string): boolean {
  if (pos + tag.length > end) return false;
  if (!ciEqLit(buf, pos, tag)) return false;
  const e = pos + tag.length;
  if (e >= end) return true;
  const c = buf[e] | 0;
  return c === 62 || c === 47 || isWhitespace(c);
}
