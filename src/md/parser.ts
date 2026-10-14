// Port of vendor/bun/src/md/parser.rs: the entry points (`init`, `renderToHtml`, `renderWithRenderer`). The state is in state.ts.
import { ByteBuf } from "./buf.ts";
import { RenderOptions, ERR_INPUT_TOO_LARGE, ERR_NONE } from "./options.ts";
import type { Options } from "./options.ts";
import { BIG, MARK_DELIMITER, MARK_EXTENSION, MARK_HIDES, MARK_OPENER, MARK_CLOSER, MARK_OTHER, MAX_INPUT_LEN, acquireParser, releaseParser, resetInlineLines } from "./state.ts";
import type { Parser } from "./state.ts";
import { EMPTY } from "./types.ts";
import type { Extensions, Renderer } from "./types.ts";
import { HtmlRenderer } from "./html_renderer.ts";
import { processDoc } from "./blocks.ts";

let htmlRenderer: HtmlRenderer | null = null;

function init(p: Parser, text: Uint8Array, renderer: Renderer): void {
  const flags = p.flags;
  p.text = text;
  const size = text.length;
  p.size = size;
  p.renderer = renderer;
  p.track = renderer.wantsSource();
  p.imageNestingLevel = 0;
  p.linkNestingLevel = 0;
  p.codeIndentOffset = flags.noIndentedCodeBlocks ? BIG : 4;
  p.marksN = 0;
  p.marksSeen = 0;
  p.hiddenN = 0;
  p.inlineSerial = 0;
  p.nContainers = 0;
  p.bbLen = 0;
  p.buffer.reset();
  p.edTop = 0;
  p.brN = 0;
  p.lfN = 0;
  p.memoAddr = -1;
  p.memoLen = 0;
  p.memoFrom.fill(BIG);
  p.notHrFrom = 0;
  p.notHrTo = 0;
  p.directivesN = 0;
  p.quotesN = 0;
  p.ceHead = 0;
  p.ceLen = 0;
  p.currentBlock = -1;
  p.currentLinesN = 0;
  p.htmlBlockType = 0;
  p.fenceIndent = 0;
  p.tableAlignments.fill(0);
  p.refBytes.reset();
  p.refDefsN = 0;
  p.refDefLabels.clear();
  p.lastLineHasListLooseningEffect = false;
  p.lastListItemStartsWithTwoBlankLines = false;
  p.lastHeaderOpensListItem = false;
  p.lastLineIsOnlyATaskMark = false;
  p.maxRefDefOutput = 16 * Math.min(size, (1024 * 1024) / 16);
  p.containerSources.reset();
  p.lineBeg = 0;
  p.isDirectiveEnd = false;
  p.defLinesN = 0;
  p.extensions = null;
  resetInlineLines(p);
  p.startsExtensionLeaf.fill(0);
  p.lineStarts.reset();
  p.footnoteLabels.clear();
  p.containersLen = 0;
  p.liIndent = 0;
  p.normBuf.reset();
  p.cBuf = EMPTY;
  p.cOff = 0;
  p.cLen = 0;
  buildMarkCharMap(p);
}

function buildMarkCharMap(p: Parser): void {
  const flags = p.flags;
  const map = p.markCharMap;
  map.fill(0);
  // newlines always need handling (hard/soft breaks)
  map[92] = MARK_OTHER; // '\\'
  map[38] = MARK_OTHER; // '&'
  map[33] = MARK_OTHER; // '!'
  map[0] = MARK_OTHER;
  map[10] = MARK_OTHER;
  map[42] = MARK_DELIMITER; // '*'
  map[95] = MARK_DELIMITER; // '_'
  map[96] = MARK_HIDES; // '`'
  map[91] = MARK_OPENER; // '['
  map[93] = MARK_CLOSER; // ']'
  if (flags.footnotes) map[91] = map[91] | MARK_HIDES;
  if (!flags.noHtmlSpans) map[60] = MARK_HIDES; // '<'
  if (flags.strikethrough) map[126] = MARK_DELIMITER; // '~'
  if (flags.latexMath) map[36] = MARK_OTHER; // '$'
  if (flags.permissiveEmailAutolinks || flags.permissiveUrlAutolinks) map[58] = MARK_OTHER; // ':'
  if (flags.permissiveEmailAutolinks) map[64] = MARK_OTHER; // '@'
  if (flags.permissiveWwwAutolinks) map[46] = MARK_OTHER; // '.'
  if (flags.collapseWhitespace) {
    map[32] = MARK_OTHER;
    map[9] = MARK_OTHER;
    map[13] = MARK_OTHER;
  }
}

function setExtensions(p: Parser, extensions: Extensions): void {
  const sb = extensions.spanBytes;
  for (let i = 0; i < sb.length; i++) {
    const c = sb[i] | 0;
    p.markCharMap[c] = (p.markCharMap[c] | (MARK_HIDES | MARK_EXTENSION)) | 0;
  }
  const lb = extensions.leafBytes;
  for (let i = 0; i < lb.length; i++) p.startsExtensionLeaf[lb[i] | 0] = 1;
  p.extensions = extensions;
}

/** `helpers::skip_utf8_bom` */
export function skipUtf8Bom(text: Uint8Array): Uint8Array {
  if (text.length >= 3 && text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf) return text.subarray(3);
  return text;
}

const renderOptionsScratch = new RenderOptions();

/** Renders the document `text` to HTML, appended to `out`. Returns 0 or an `ERR_*`. */
export function renderToHtml(text: Uint8Array, options: Options, out: ByteBuf): number {
  // Skip UTF-8 BOM
  const input = skipUtf8Bom(text);
  if (input.length > MAX_INPUT_LEN) return ERR_INPUT_TOO_LARGE;
  const p = acquireParser();
  options.toFlags(p.flags);
  const renderOptionsScratch$ = renderOptionsScratch;
  options.toRenderOptions(renderOptionsScratch$);
  let hr = htmlRenderer;
  if (hr === null) {
    hr = new HtmlRenderer();
    htmlRenderer = hr;
  }
  hr.init(input, renderOptionsScratch$, out);
  init(p, input, hr);
  processDoc(p);
  releaseParser();
  hr.finish();
  return ERR_NONE;
}

/** Parses `text` and renders it with a custom renderer. */
export function renderWithRenderer(
  text: Uint8Array,
  options: Options,
  renderer: Renderer,
  extensions: Extensions | null,
): number {
  // Who wants to know where things are is told places in `text`.
  const input = renderer.wantsSource() ? text : skipUtf8Bom(text);
  if (input.length > MAX_INPUT_LEN) return ERR_INPUT_TOO_LARGE;
  const p = acquireParser();
  options.toFlags(p.flags);
  init(p, input, renderer);
  if (extensions !== null) setExtensions(p, extensions);
  processDoc(p);
  releaseParser();
  return ERR_NONE;
}
