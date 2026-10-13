// The formatters of the other languages that code blocks and front matter go to (`format_embedded` of mod.rs calls them by the
// name of Prettier's parser). Each appends the formatted code to `out` and says whether it could.
//
// HOOKS: `hookHtml` is for the formatter that is not ported yet (src/format/html/mod.ts):
// it returns false, which leaves the block as it is written, as Bun does when a formatter fails. When the module exists, call
// it in the hook (see the Rust: `crate::css::format(code, parser, &options, ..)`, `crate::html::format(b"", code, parser, ..)`).
import { ByteBuf } from "../../base/bytebuf.ts";
import { FORMAT_OK } from "../errors.ts";
import { FormatOptions } from "../options.ts";
import * as css from "../css/mod.ts";
import * as graphql from "../graphql/mod.ts";
import * as handlebars from "../handlebars/mod.ts";
import * as yaml from "../yaml/mod.ts";
import { formatJson, parserFromName } from "../json/mod.ts";

// `parser` is "css", "scss" or "less".
function formatCss(parser: string, code: Uint8Array, options: FormatOptions, out: ByteBuf): boolean {
  const p = parser === "css" ? css.PARSER_CSS : parser === "less" ? css.PARSER_LESS : css.PARSER_SCSS;
  return css.format(code, p, options, out) === FORMAT_OK;
}

// HOOK(html): `parser` is "html", "angular", "vue", "lwc" or "mjml". Only when `options.embeddedHtml`.
function hookHtml(parser: string, code: Uint8Array, options: FormatOptions, out: ByteBuf): boolean {
  return false;
}

/** Formats code[cs, ce) with the formatter for `parser`. false: there is none, or it could not. */
export function embeddedFormat(parser: string, code: Uint8Array, cs: number, ce: number, options: FormatOptions, out: ByteBuf): boolean {
  const view = cs === 0 && ce === code.length ? code : code.subarray(cs, ce);
  switch (parser) {
    case "json":
    case "jsonc":
    case "json5":
    case "json-stringify":
      return formatJson(view, view.length, parserFromName(parser), options, out) === FORMAT_OK;
    case "css":
    case "less":
    case "scss":
      return formatCss(parser, view, options, out);
    case "html":
    case "angular":
    case "vue":
    case "lwc":
    case "mjml":
      return options.embeddedHtml && hookHtml(parser, view, options, out);
    case "graphql":
      return graphql.format(view, options, out) === FORMAT_OK;
    case "glimmer":
      return handlebars.format(view, options, out) === FORMAT_OK;
    case "yaml":
      return yaml.format(view, options, out) === FORMAT_OK;
    default:
      return false;
  }
}
