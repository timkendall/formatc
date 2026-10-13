// Port of vendor/bun/src/format/json/mod.rs. JSON, the way Prettier formats it.
//
// Prettier has four parsers for it. All take what Babel's expression parser takes, as long as it is made of objects, arrays,
// literals, `NaN`, `Infinity`, `undefined`, signs and templates without substitutions.
//
// - `json`, `jsonc` and `json5` are printed by the printer for JavaScript: an object or an array is on one line if it fits,
//   comments are kept.
// - `json-stringify` is printed like `JSON.stringify(value, null, 2)` does. It has no comments.
//
//   formatJson(src, len, parser, options, out): FORMAT_* code
//
// `FORMAT_SYNTAX_ERROR_AT`: the message and the place are `refusalMessage()` / `refusalOffset()` (`syntax_error.ts`), the
// offset counting bytes of the text, not a byte order mark. The parser is chosen from the file name by `src/driver/kinds.ts`.
// The files of this directory: `core.ts` is `format_normalized`, the rest are the Rust files of the same name.
import { ByteBuf } from "../../base/bytebuf.ts";
import { FORMAT_OK, FORMAT_SYNTAX_ERROR_AT } from "../errors.ts";
import { FormatOptions } from "../options.ts";
import { hasIgnorePragma, hasPragma, insertPragma } from "../pragma.ts";
import { noteRefusal, refusalReason } from "../syntax_error.ts";
import { startsWithBom } from "../text.ts";
import { PARSER_JSON, PARSER_STRINGIFY, Config } from "./config.ts";
import { FORMAT_RETRY, formatNormalized, hasCarriageReturn as hasCr } from "./core.ts";
import { formatRange } from "./range.ts";

export { PARSER_JSON, PARSER_JSONC, PARSER_JSON5, PARSER_STRINGIFY, parserFromName } from "./config.ts";

const cfg = new Config();
/** The text with `\n` for every line break, if it has others. */
const normalized = new ByteBuf(1024);
const withPragma = new ByteBuf(1024);

/** `text` with `\n` for every `\r\n` and `\r`. Valid until the next call. */
function normalize(text: Uint8Array): Uint8Array {
  normalized.reset();
  normalized.reserve(text.length);
  let runStart = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    if ((text[i] | 0) === 13) {
      normalized.append(text, runStart, i);
      normalized.push(10);
      if (i + 1 < n && (text[i + 1] | 0) === 10) i = i + 1;
      runStart = i + 1;
    }
  }
  normalized.append(text, runStart, n);
  return normalized.view();
}

/**
 * Appends the formatted text[0, len) to `out`. `parser`: `PARSER_*`. Returns a `FORMAT_*` code (0: ok); on an error the
 * contents of `out` are not to be used.
 */
export function formatJson(src: Uint8Array, len: number, parser: number, options: FormatOptions, out: ByteBuf): number {
  const original = len === src.length ? src : src.subarray(0, len);
  cfg.set(parser, options, original);
  const hasBom = startsWithBom(original, 0);
  let text = hasBom ? original.subarray(3) : original;

  // For Prettier, every `json` document has a pragma and none has one that says to ignore it.
  if (parser !== PARSER_JSON && (options.requirePragma || options.checkIgnorePragma || options.insertPragma)) {
    if ((options.requirePragma && !hasPragma(text)) || (options.checkIgnorePragma && hasIgnorePragma(text))) {
      out.append(original, 0, original.length);
      return FORMAT_OK;
    }
    const isWhole = (options.rangeStart < 0 || options.rangeStart === 0) && options.rangeEnd < 0;
    // What writes `json-stringify` cannot write a comment.
    if (options.insertPragma && !options.requirePragma && isWhole && parser !== PARSER_STRINGIFY && !hasPragma(text)) {
      withPragma.reset();
      insertPragma(text, withPragma);
      text = withPragma.view();
    }
  }

  const hasRange = options.rangeStart >= 0 || options.rangeEnd >= 0;
  let hasCarriageReturn = false;
  let r: number;
  if (hasRange) {
    // The offsets of the range count the text as it is.
    hasCarriageReturn = hasCr(text);
    r = formatRange(original, hasCarriageReturn ? normalize(text) : text, cfg, options, out);
  } else {
    // It stays, even if nothing but white space follows, which is nothing.
    if (hasBom) {
      out.push(0xef);
      out.push(0xbb);
      out.push(0xbf);
    }
    const mark = out.len;
    r = formatNormalized(text, cfg, options, out, true);
    if (r === FORMAT_RETRY) {
      // The parser has met a `\r`: `\r\n` and `\r` are `\n`.
      hasCarriageReturn = true;
      out.len = mark;
      r = formatNormalized(normalize(text), cfg, options, out, false);
    }
  }
  if (r === FORMAT_SYNTAX_ERROR_AT && hasCarriageReturn) {
    const e = refusalReason().beforeNormalizingEndOfLine(text);
    noteRefusal(e.message, e.offset);
  }
  return r;
}
