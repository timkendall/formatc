// Port of vendor/bun/src/md/root.rs (the parts that are not the ANSI renderer): the entry points.
import { renderToHtml as parserRenderToHtml, renderWithRenderer } from "./parser.ts";
import type { Extensions, Renderer } from "./types.ts";
import type { ByteBuf } from "./buf.ts";
import type { Options } from "./options.ts";

export { Flags, Options, RenderOptions, ERR_NONE, ERR_INPUT_TOO_LARGE } from "./options.ts";

/**
 * Renders `text` (the whole document; skip a BOM first with `skipUtf8Bom`) to HTML, appending to `out`. Returns 0 or an
 * `ERR_*`.
 */
export function renderToHtmlWithOptions(text: Uint8Array, options: Options, out: ByteBuf): number {
  return parserRenderToHtml(text, options, out);
}

/**
 * Parses `text` and tells `renderer` about it, with syntax of the consumer's own if `extensions` is not null. `text` is
 * the document: all offsets that the renderer is told are indices into it. A BOM is not skipped when the renderer wants
 * the source (`wantsSource()`), and is when it does not. Returns 0 or an `ERR_*`.
 */
export function renderWithExtensions(
  text: Uint8Array,
  options: Options,
  renderer: Renderer,
  extensions: Extensions | null,
): number {
  return renderWithRenderer(text, options, renderer, extensions);
}
