// Port of vendor/bun/src/format/toml/mod.rs. TOML, the way oxfmt formats it. Prettier has no TOML. Without an oxfmt config,
// arrays and inline tables get Bun's own layout, which `printer.ts` describes.
//
// oxfmt does it with the crate `oxc-toml` (MIT license, Ferenc Tamas, VoidZero Inc. and contributors), a fork of taplo,
// whose formatter `printer.ts` is a port of, as far as oxfmt's options reach. Keys and values are written as they are in
// the text. What changes is white space, empty lines, and whether an array is on one line.
//
//   text -- Bun's scanner of TOML (src/parsers/toml.ts) --> tokens -- tree.ts --> taplo's tree -- printer.ts --> text
//
// What Bun does not read as TOML is a syntax error. oxfmt writes such a text again around its errors, and not always in the
// same order.
//
//   formatToml(src, len, options, out): FORMAT_* code        (FORMAT_SYNTAX_ERROR: `tomlSyntaxError` says why)
import { ByteBuf } from "../../base/bytebuf.ts";
import { tomlErrorMessage, tomlErrorPos, tomlTokens } from "../../parsers/toml.ts";
import { FORMAT_OK, FORMAT_SYNTAX_ERROR } from "../errors.ts";
import { FormatOptions } from "../options.ts";
import { startsWithBom } from "../text.ts";
import { printToml } from "./printer.ts";
import { buildTree, tomlTree } from "./tree.ts";

let syntaxMessage = "";
let syntaxOffset = 0;

/**
 * Why `formatToml` takes `src` for something else than TOML: Bun's parser says (`tomlSyntaxMessage()`), and at which byte,
 * not counting a byte order mark (`tomlSyntaxOffset()`). The text is read once more for it. Returns whether there is an
 * error.
 */
export function tomlSyntaxError(src: Uint8Array, len: number): boolean {
  if (tomlTokens(src, len) === 0) return false;
  const bom = startsWithBom(src, 0) ? 3 : 0;
  const pos = tomlErrorPos();
  syntaxMessage = tomlErrorMessage();
  syntaxOffset = pos > bom ? pos - bom : 0;
  return true;
}

export function tomlSyntaxMessage(): string {
  return syntaxMessage;
}

export function tomlSyntaxOffset(): number {
  return syntaxOffset;
}

/** Appends the formatted text[0, len) to `out`. */
export function formatToml(src: Uint8Array, len: number, options: FormatOptions, out: ByteBuf): number {
  const text = len === src.length ? src : src.subarray(0, len);
  // Of a text that is nothing but white space, oxfmt makes nothing.
  let blank = true;
  for (let i = 0; i < len; i++) {
    const b = text[i] | 0;
    if (b !== 32 && b !== 9 && b !== 10 && b !== 13) {
      blank = false;
      break;
    }
  }
  if (blank) return FORMAT_OK;
  if (tomlTokens(text, len) !== 0) return FORMAT_SYNTAX_ERROR;
  const built = buildTree(text, len);
  if (built !== FORMAT_OK) return built;
  if (startsWithBom(text, 0)) {
    out.push(0xef);
    out.push(0xbb);
    out.push(0xbf);
  }
  return printToml(text, len, tomlTree.el, tomlTree.count, options, out);
}
