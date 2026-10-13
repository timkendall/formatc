// Port of vendor/bun/src/format/graphql/mod.rs. GraphQL: `.graphql` files, and the templates in JavaScript that are GraphQL.
//
// The specification is Prettier's `src/language-graphql`, which parses with graphql-js.
//
//   text ─ parser.parse ─→ Tree ─ comments.attach ─→ Attached ─ printer.Builder ─→ the document of `src/format/ir`
//
//   format(text, options, out): FORMAT_* code
//
// `FORMAT_SYNTAX_ERROR_AT`: the message and the place are `refusalMessage()` / `refusalOffset()` (`syntax_error.ts`), the
// offset counting bytes of the text as the file has it, not a byte order mark.
// The files of this directory are the Rust files of the same name (`embed.ts`: GraphQL in the templates of JavaScript).
import { ByteBuf } from "../../base/bytebuf.ts";
import {
  FORMAT_NESTED_TOO_DEEPLY,
  FORMAT_OK,
  FORMAT_SYNTAX_ERROR_AT,
} from "../errors.ts";
import { Scratch, finishAndPrintWithLineEnding, startDocument } from "../ir/run.ts";
import { Formatter } from "../ir/formatter.ts";
import {
  FormatOptions,
  LINE_ENDING_LF,
  resolveLineEnding,
} from "../options.ts";
import { MSG_NESTED_TOO_DEEPLY, noteRefusal, refusalMessage, refusalReason } from "../syntax_error.ts";
import {
  hasPragmaInHashComment,
  startsWithBom,
  trimJsWhitespaceEnd,
  trimJsWhitespaceStart,
} from "../text.ts";
import { Attached, attach } from "./comments.ts";
import { Tree, parse } from "./parser.ts";
import { Builder } from "./printer.ts";
import {
  alignmentSize,
  calculateRange,
  computeOffsets,
  normalizedLen,
  offsetsEnd,
  offsetsStart,
  rangeEndOf,
  rangeStartOf,
  writeWithLineEnding,
} from "./range.ts";

export { MSG_NESTED_TOO_DEEPLY };

/** Everything that is allocated to format a text. It is reused for the next one. */
const tree = new Tree();
const attached = new Attached();
let scratchSlot: Scratch | null = null;
let builderSlot: Builder | null = null;
/** The text with `\n` for every line break, if it has others. */
const normalized = new ByteBuf(1024);
const withPragma = new ByteBuf(1024);
const formatted = new ByteBuf(1024);
const EMPTY = new Uint8Array(0);

/** The builder, set up for the document that `f` writes. `srcOff`: where `text` is in `f.source`, or -1. */
export function builderFor(f: Formatter, text: Uint8Array, srcOff: number, t: Tree, att: Attached, isInTemplate: boolean, lineEnding: number): Builder {
  if (builderSlot === null) builderSlot = new Builder(f, text, t, att);
  const b = builderSlot as Builder;
  b.setUp(f, text, srcOff, t, att, isInTemplate, lineEnding);
  return b;
}

/**
 * Appends the formatted `text` to `out`: Prettier's `formatWithCursor`, without the cursor. Returns a `FORMAT_*` code (0: ok).
 */
export function format(text: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  const original = text;
  const first = startsWithBom(original, 0) ? 3 : 0;
  let start = first;
  let end = original.length;
  if (options.rangeStart >= 0 || options.rangeEnd >= 0) {
    computeOffsets(original, first, options.rangeStart, options.rangeEnd);
    start = offsetsStart();
    end = offsetsEnd();
  }
  const body = first === 0 ? original : original.subarray(first);
  const lineEnding = resolveLineEnding(options.lineEnding, body);
  // The offsets after `\r\n` has become `\n`.
  start = normalizedLen(original, first, start < first ? first : start > original.length ? original.length : start);
  end = normalizedLen(original, first, end < first ? first : end > original.length ? original.length : end);
  let t = body;
  let hasCr = false;
  for (let i = 0; i < t.length; i++) {
    if ((t[i] | 0) === 13) {
      hasCr = true;
      break;
    }
  }
  if (hasCr) {
    normalized.reset();
    normalized.reserve(t.length);
    writeWithLineEnding(t, 0, t.length, LINE_ENDING_LF, normalized);
    t = normalized.view();
  }

  if (
    (start >= end && t.length > 0) ||
    (options.requirePragma && !hasPragmaInHashComment(t, "format", "prettier")) ||
    (options.checkIgnorePragma && hasPragmaInHashComment(t, "noformat", "noprettier"))
  ) {
    out.append(original, 0, original.length);
    return FORMAT_OK;
  }
  out.append(original, 0, first);
  let r: number;
  if (start > 0 || end < t.length) {
    r = formatRange(t, start, end, lineEnding, options, out);
  } else {
    if (options.insertPragma && !options.requirePragma && !hasPragmaInHashComment(t, "format", "prettier")) {
      withPragma.reset();
      withPragma.reserve(t.length + 12);
      withPragma.appendAscii("# @format\n\n");
      withPragma.append(t, 0, t.length);
      t = withPragma.view();
    }
    r = formatNormalized(t, 0, lineEnding, options, out);
  }
  if (r === FORMAT_SYNTAX_ERROR_AT && hasCr) {
    const e = refusalReason().beforeNormalizingEndOfLine(body);
    noteRefusal(e.message, e.offset);
  }
  return r;
}

/** Why the parser has refused the text. */
function because(): number {
  return refusalMessage() === MSG_NESTED_TOO_DEEPLY ? FORMAT_NESTED_TOO_DEEPLY : FORMAT_SYNTAX_ERROR_AT;
}

/** Prettier's `formatRange` */
function formatRange(text: Uint8Array, start: number, end: number, lineEnding: number, options: FormatOptions, out: ByteBuf): number {
  if (parse(text, tree) < 0) return because();
  let rs = 0;
  let re = 0;
  if (calculateRange(text, tree, start, end)) {
    rs = rangeStartOf();
    re = rangeEndOf();
  }
  const n = text.length;
  const beforeEnd = rs < n ? rs : n;
  const sliceEnd = beforeEnd + (re - rs < n - beforeEnd ? re - rs : n - beforeEnd);
  const slice = text.subarray(beforeEnd, sliceEnd);
  const alignment = alignmentSize(text, beforeEnd, options.indentWidth);

  formatted.reset();
  const r = formatNormalized(slice, alignment, LINE_ENDING_LF, options, formatted);
  if (r !== FORMAT_OK) return r;

  writeWithLineEnding(text, 0, beforeEnd, lineEnding, out);
  const fv = formatted.data;
  const fs = trimJsWhitespaceStart(fv, 0, formatted.len);
  const fe = trimJsWhitespaceEnd(fv, 0, formatted.len);
  if (fs < fe) writeWithLineEnding(fv, fs, fe, lineEnding, out);
  writeWithLineEnding(text, sliceEnd, n, lineEnding, out);
  return FORMAT_OK;
}

/**
 * Prettier's `coreFormat`. `text` has no byte order mark and no `\r`. `alignment`: the number of columns that every line is
 * indented by.
 */
function formatNormalized(text: Uint8Array, alignment: number, lineEnding: number, options: FormatOptions, out: ByteBuf): number {
  if (trimJsWhitespaceStart(text, 0, text.length) >= text.length) return FORMAT_OK;
  if (parse(text, tree) < 0) return because();
  attach(text, tree, attached);

  // Prettier's `addAlignmentToDoc`. The line break makes the indentation take effect.
  if (scratchSlot === null) scratchSlot = new Scratch(options);
  // The text is `f.source`, but its blocks are not looked at: the builder never asks which of them are plain.
  const f = startDocument(scratchSlot as Scratch, EMPTY, options, null);
  f.source = text;
  const tabWidth = options.indentWidth > 1 ? options.indentWidth : 1;
  const levels = Math.floor(alignment / tabWidth);
  const spaces = alignment % tabWidth;
  if (spaces > 0) f.startAlign(spaces);
  for (let i = 0; i < levels; i++) f.startIndent();
  if (alignment > 0) f.hardLineBreak();
  const b = builderFor(f, text, 0, tree, attached, false, lineEnding);
  b.print(tree.root());
  for (let i = 0; i < levels; i++) f.endIndent();
  if (spaces > 0) f.endAlign(spaces);
  return finishAndPrintWithLineEnding(f, lineEnding, out);
}
