// `format_normalized` of vendor/bun/src/format/json/mod.rs (Prettier's `coreFormat`), in a module of its own so that
// `range.ts` and `mod.ts` can both use it. `text` has no byte order mark and no `\r`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { FORMAT_OK, FORMAT_SYNTAX_ERROR_AT } from "../errors.ts";
import { LINE_ENDING_CR, LINE_ENDING_CRLF, LINE_ENDING_LF, FormatOptions } from "../options.ts";
import { Tracker, propagateExpand } from "../ir/document.ts";
import { RESERVED } from "../ir/element.ts";
import { formatErrorOfPrintError } from "../ir/run.ts";
import { printDocumentWithLineEnding } from "../ir/printer.ts";
import { Storage } from "../ir/storage.ts";
import { MSG_UNEXPECTED_END, MSG_UNEXPECTED_TOKEN, noteRefusal } from "../syntax_error.ts";
import { attach } from "./comments.ts";
import { LE_CR, LE_CRLF, PARSER_JSONC, PARSER_STRINGIFY, Config } from "./config.ts";
import { build } from "./document.ts";
import { C_START, tree } from "./parser.ts";
import { write } from "./writer.ts";

export function hasCarriageReturn(text: Uint8Array): boolean {
  for (let i = 0; i < text.length; i++) if ((text[i] | 0) === 13) return true;
  return false;
}

const storage = new Storage(1024);
const tracker = new Tracker(storage);

/** `formatNormalized` found a `\r` that has to be made `\n` first: nothing has been written. */
export const FORMAT_RETRY = -1;

/**
 * Prettier's `coreFormat`. Returns a `FORMAT_*` code; `FORMAT_SYNTAX_ERROR_AT` has its place in the refusal slots.
 * `mayHaveCr`: `text` has not been made to have `\n` for every line break. If the parser meets a `\r`, or refuses the text and
 * there is one in it, the answer is `FORMAT_RETRY`.
 */
export function formatNormalized(text: Uint8Array, cfg: Config, options: FormatOptions, out: ByteBuf, mayHaveCr: boolean): number {
  const refused = tree.parse(text, cfg) < 0;
  if (mayHaveCr && (tree.sawCr || (refused && hasCarriageReturn(text)))) return FORMAT_RETRY;
  if (refused) return FORMAT_SYNTAX_ERROR_AT;
  // The writer does not mark a line break in a string. See `FormatOptions::is_in_markdown`.
  let hasMarks = false;
  if (options.isInMarkdown) {
    for (let i = 0; i + 1 < text.length; i++) {
      if ((text[i] | 0) === 92 && (text[i + 1] | 0) === 10) {
        hasMarks = true;
        break;
      }
    }
  }
  if (tree.commentCount === 0 && !hasMarks) {
    if (tree.nodeCount > 0) return write(text, tree, cfg, out);
    return FORMAT_OK;
  }
  // Only `jsonc` takes a document that is nothing but comments.
  if (tree.commentCount > 0 && (cfg.parser === PARSER_STRINGIFY || (tree.nodeCount === 0 && cfg.parser !== PARSER_JSONC))) {
    if (cfg.parser === PARSER_STRINGIFY) noteRefusal(MSG_UNEXPECTED_TOKEN, tree.comments[C_START] | 0);
    else noteRefusal(MSG_UNEXPECTED_END, text.length);
    return FORMAT_SYNTAX_ERROR_AT;
  }
  attach(text, tree);
  const rootEnd = build(text, tree, cfg, storage);
  propagateExpand(RESERVED, rootEnd, tracker);
  // The line breaks of `cfg`: those of the options, or of the text if they leave it to that.
  const le = cfg.lineEnding === LE_CRLF ? LINE_ENDING_CRLF : cfg.lineEnding === LE_CR ? LINE_ENDING_CR : LINE_ENDING_LF;
  const r = printDocumentWithLineEnding(storage, RESERVED, rootEnd, text, options, le, out);
  return formatErrorOfPrintError(r);
}
