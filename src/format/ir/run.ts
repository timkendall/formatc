// Port of vendor/bun/src/format/ir/run.rs: from a file to its formatted text.
//
// `Scratch` holds every buffer, so that formatting the next file allocates nothing (grow-only, per thread): the
// formatter (pool, tracker, text, variants) and the printer's arrays (module singleton in printer.ts). Rust's
// `format_with_marks`/`write_document` need a `File` and the JS comments, so they live in the JS formatter; what is
// here is the language-independent half.
import { ByteBuf } from "../../base/bytebuf.ts";
import { FormatOptions } from "../options.ts";
import {
  FORMAT_INVALID_DOCUMENT,
  FORMAT_NESTED_TOO_DEEPLY,
  FORMAT_OK,
  FORMAT_TOO_LONG,
} from "../errors.ts";
import { FormatContext } from "./context.ts";
import { Formatter } from "./formatter.ts";
import {
  PE_NESTED_TOO_DEEPLY,
  PE_TOO_LONG,
  getPrinter,
  printDocument,
  printDocumentWithLineEnding,
} from "./printer.ts";

/** Everything that is allocated to format a file. It is reused for the next one. */
export class Scratch {
  formatter: Formatter;
  constructor(options: FormatOptions) {
    this.formatter = new Formatter(options);
  }
}

/** Maps a printer error (`PE_*`) to a `FORMAT_*` error code (`PrintError` -> `FormatError`). */
export function formatErrorOfPrintError(pe: number): number {
  if (pe >= 0) return FORMAT_OK;
  if (pe === PE_NESTED_TOO_DEEPLY) return FORMAT_NESTED_TOO_DEEPLY;
  if (pe === PE_TOO_LONG) return FORMAT_TOO_LONG;
  return FORMAT_INVALID_DOCUMENT;
}

/**
 * Rust `write_with`: starts a document for `source`. Write it with the formatter's methods, then call `finishAndPrint`.
 * `context` may be null for a document that is not written for JavaScript.
 */
export function startDocument(scratch: Scratch, source: Uint8Array, options: FormatOptions, context: FormatContext | null): Formatter {
  const f = scratch.formatter;
  f.reset(source, options, context);
  return f;
}

/**
 * Rust `finish` + `print`: checks that the writer did not run out of stack, then prints the document that `f` wrote and
 * appends it to `out`. Returns a `FORMAT_*` code (`FORMAT_OK` is 0).
 */
export function finishAndPrint(f: Formatter, out: ByteBuf): number {
  if (f.stack.ranOut() || f.context.ranOutOfStack) return FORMAT_NESTED_TOO_DEEPLY;
  const r = printDocument(f.st, f.rootStart(), f.rootEnd(), f.source, f.options, out);
  return formatErrorOfPrintError(r);
}

/** The same with the line ending decided by the caller (a resolved `LINE_ENDING_*`). */
export function finishAndPrintWithLineEnding(f: Formatter, lineEnding: number, out: ByteBuf): number {
  if (f.stack.ranOut() || f.context.ranOutOfStack) return FORMAT_NESTED_TOO_DEEPLY;
  const r = printDocumentWithLineEnding(f.st, f.rootStart(), f.rootEnd(), f.source, f.options, lineEnding, out);
  return formatErrorOfPrintError(r);
}

/** Where the cursor marks were in what has been printed last: `marks0` (region start) and `marks1` (region end), -1 if none. */
export function marksStart(): number {
  return getPrinter().marks0;
}
export function marksEnd(): number {
  return getPrinter().marks1;
}
