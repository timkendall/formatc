// What handlebars asks of the other languages: the front matter (YAML) and the style sheet of a `<style>` (CSS). Both
// return a `Doc` handle of `src/format/css/doc.ts`, or -1: it cannot be formatted, and is printed as it is written.
import { document as cssDocumentOf, PARSER_CSS } from "../css/mod.ts";
import type { FormatOptions } from "../options.ts";
import { yamlDocument as yamlDocumentOf } from "../yaml/mod.ts";

// `yaml::document(value, options)`: the document of the YAML in `buf[a, b)`.
export function yamlDocument(buf: Uint8Array, a: number, b: number, options: FormatOptions): number {
  const d = yamlDocumentOf(buf.subarray(a, b), b - a, options);
  return d < 0 ? -1 : d;
}

// `css::document(text, css::Parser::Css, options)`: the document of the style sheet in `buf[a, b)`.
export function cssDocument(buf: Uint8Array, a: number, b: number, options: FormatOptions): number {
  const d = cssDocumentOf(buf.subarray(a, b), PARSER_CSS, options);
  return d < 0 ? -1 : d;
}
