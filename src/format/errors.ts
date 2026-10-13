// The parts of vendor/bun/src/format/lib.rs that are not JavaScript-specific: `FormatError` and `is_too_long`.
import { SyntaxError } from "./syntax_error.ts";

// `FormatError`. Rust has a variant with data (`SyntaxErrorAt(SyntaxError)`): here the code is an int and the
// syntax error itself is read from `syntax_error.ts` (`refusalReason()`) or passed along by the caller.
export const FORMAT_OK = 0;
// The file has syntax errors. It is left as it is. What they are is for the caller to know: the parser of scripts
// has told it.
export const FORMAT_SYNTAX_ERROR = 1;
// The same, from a parser of this crate: the place and the words are in `refusalReason()`.
export const FORMAT_SYNTAX_ERROR_AT = 2;
// The syntax is nested so deeply that formatting it would overflow the stack. The file is left as it is.
export const FORMAT_NESTED_TOO_DEEPLY = 3;
// The formatted text is longer than a string can be (`isTooLong`). The file is left as it is.
export const FORMAT_TOO_LONG = 4;
// A bug in the formatter: the document it wrote is malformed.
export const FORMAT_INVALID_DOCUMENT = 5;

export function formatErrorName(code: number): string {
  switch (code) {
    case FORMAT_OK: return "ok";
    case FORMAT_SYNTAX_ERROR: return "SyntaxError";
    case FORMAT_SYNTAX_ERROR_AT: return "SyntaxError";
    case FORMAT_NESTED_TOO_DEEPLY: return "RangeError: The code is nested too deeply.";
    case FORMAT_TOO_LONG: return "RangeError: Invalid string length";
    default: return "InvalidDocument";
  }
}

// The longest string of JavaScript: `bun_lint::fix::MAX_STRING_LENGTH` = 2^29 - 24.
export const MAX_STRING_LENGTH = 536870888;

// Whether a text of `len` bytes is longer than a string of JavaScript can be, which is where Prettier ends with
// `RangeError: Invalid string length`. What is nested `n` deep is indented by `n * n` blanks.
export function isTooLong(len: number): boolean {
  return len > MAX_STRING_LENGTH;
}

// Rust `FormatError::before_normalizing_end_of_line` for a syntax error: maps the offset back to `original`.
export function syntaxErrorBeforeNormalizing(error: SyntaxError, original: Uint8Array): SyntaxError {
  return error.beforeNormalizingEndOfLine(original);
}
