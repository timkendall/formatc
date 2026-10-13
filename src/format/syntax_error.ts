// Port of vendor/bun/src/format/syntax_error.rs: what the parsers of this crate refuse: what is wrong, and where.
//
// Rust: a parser *notes* why it refuses (`refusal.note(Message::UnclosedString, offset)`, which is `#[cold]`) and
// returns `Refused`, which has no size. Here a refusal is a module-level slot (`noteRefusal`) and the parser
// returns `false`/`-1`/its own failure sentinel; the top level asks `refusalMessage()`/`refusalOffset()`.
import { indexOfByte } from "../base/bytes.ts";

// A syntax error in a file that is not a script: what is wrong (`MSG_*`), and at which byte of the text, not
// counting a byte order mark. Rust: `SyntaxError(Message, u32)`.
export class SyntaxError {
  message: number;
  offset: number;
  constructor(message: number, offset: number) {
    this.message = message;
    this.offset = offset;
  }
  // `self` is in what `normalizeEndOfLine` has made of `original`. The same in `original`.
  beforeNormalizingEndOfLine(original: Uint8Array): SyntaxError {
    if (indexOfByte(original, 0, original.length, 13) < 0) return this;
    let left = this.offset;
    let at = 0;
    while (left > 0 && at < original.length) {
      at = at + ((original[at] | 0) === 13 && at + 1 < original.length && (original[at + 1] | 0) === 10 ? 2 : 1);
      left = left - 1;
    }
    return new SyntaxError(this.message, at);
  }
}

// Where a parser notes what it refuses: per thread, overwritten by every refusal (the last counts).
let refusalMessage_ = 51; // MSG_UNEXPECTED_TOKEN
let refusalOffset_ = 0;

// Notes why a text is refused. Returns -1, so that a parser can write `return noteRefusal(MSG_X, at)` where it
// returns an int status (negative = refused).
export function noteRefusal(message: number, offset: number): number {
  refusalMessage_ = message;
  refusalOffset_ = offset;
  return -1;
}
export function refusalMessage(): number {
  return refusalMessage_;
}
export function refusalOffset(): number {
  return refusalOffset_;
}
// What has been noted last.
export function refusalReason(): SyntaxError {
  return new SyntaxError(refusalMessage_, refusalOffset_);
}
export function clearRefusal(): void {
  refusalMessage_ = 51; // MSG_UNEXPECTED_TOKEN
  refusalOffset_ = 0;
}

// `Message`: one list for all languages. A text says what is wrong at the place that the offset points to, in our
// words: for something that is not closed, the place is where it was opened.
export const MSG_UNEXPECTED_END = 0;
export const MSG_NESTED_TOO_DEEPLY = 1;
export const MSG_TOO_LARGE = 2;
export const MSG_UNCLOSED_BLOCK = 3;
export const MSG_UNCLOSED_BRACKET = 4;
export const MSG_UNCLOSED_COMMENT = 5;
export const MSG_UNCLOSED_INTERPOLATION = 6;
export const MSG_UNCLOSED_STRING = 7;
// Style sheets
export const MSG_AT_RULE_WITHOUT_NAME = 8;
export const MSG_NEITHER_DECLARATION_NOR_RULE = 9;
export const MSG_PROPERTY_WITHOUT_NAME = 10;
export const MSG_RULE_WITHOUT_SELECTOR = 11;
export const MSG_UNEXPECTED_CLOSING_BRACE = 12;
export const MSG_UNEXPECTED_COLON = 13;
export const MSG_UNREADABLE_AT_RULE = 14;
export const MSG_UNREADABLE_VALUE = 15;
// GraphQL
export const MSG_EMPTY_EXTENSION = 16;
export const MSG_EXPECTED_CLOSING_BRACKET = 17;
export const MSG_EXPECTED_CLOSING_PARENTHESIS = 18;
export const MSG_EXPECTED_DEFINITION = 19;
export const MSG_EXPECTED_DIGIT = 20;
export const MSG_EXPECTED_DIRECTIVE_LOCATION = 21;
export const MSG_EXPECTED_NAME = 22;
export const MSG_EXPECTED_OPENING_BRACE = 23;
export const MSG_EXPECTED_VALUE = 24;
export const MSG_INVALID_ESCAPE_SEQUENCE = 25;
export const MSG_INVALID_NUMBER = 26;
export const MSG_UNEXPECTED_CHARACTER = 27;
// JSON
export const MSG_EXPECTED_END_OF_FILE = 28;
// Handlebars
export const MSG_ATTRIBUTE_IN_END_TAG = 29;
export const MSG_END_TAG_OF_VOID_ELEMENT = 30;
export const MSG_END_TAG_WITHOUT_START_TAG = 31;
export const MSG_EXPECTED_END_OF_MUSTACHE = 32;
export const MSG_INVALID_BLOCK_PARAMETERS = 33;
export const MSG_INVALID_DOCTYPE = 34;
export const MSG_INVALID_PATH = 35;
export const MSG_INVALID_TAG_NAME = 36;
export const MSG_MISPLACED_BLOCK = 37;
export const MSG_MISPLACED_MUSTACHE = 38;
export const MSG_SELF_CLOSING_END_TAG = 39;
export const MSG_UNCLOSED_ELEMENT = 40;
export const MSG_UNQUOTED_VALUE_WITH_MUSTACHE = 41;
export const MSG_UNSUPPORTED_MUSTACHE = 42;
export const MSG_WRONG_END_TAG = 43;
export const MSG_WRONG_NAME_AT_END_OF_BLOCK = 44;
// YAML
export const MSG_CANNOT_BE_FORMATTED = 45;
export const MSG_EXPECTED_COLON = 46;
export const MSG_INVALID_DIRECTIVE = 47;
export const MSG_INVALID_TAG = 48;
export const MSG_KEY_OVER_SEVERAL_LINES = 49;
export const MSG_MISPLACED_COMMENT = 50;
export const MSG_UNEXPECTED_TOKEN = 51; // the default of `Refusal`
export const MSG_REPEATED_PROPERTY = 52;
export const MSG_TAB_AS_INDENTATION = 53;

const MESSAGES: string[] = [
  "Unexpected end of file",
  "This file is nested too deeply",
  "The file is too large",
  "Unclosed block",
  "Unclosed bracket",
  "Unclosed comment",
  "Unclosed interpolation",
  "Unclosed string",
  "Expected a name after \"@\"",
  "Expected a declaration or a rule",
  "Expected a property name",
  "Expected a selector",
  "Unexpected \"}\"",
  "Unexpected \":\"",
  "Invalid at-rule parameters",
  "Invalid value",
  "This extension is empty",
  "Expected \"]\"",
  "Expected \")\"",
  "Expected a definition",
  "Expected a digit",
  "Expected a directive location",
  "Expected a name",
  "Expected \"{\"",
  "Expected a value",
  "Invalid escape sequence",
  "Invalid number",
  "Unexpected character",
  "Expected end of file",
  "An end tag cannot have attributes",
  "This element cannot have an end tag",
  "This end tag has no start tag",
  "Expected \"}}\"",
  "Invalid block parameters",
  "Invalid doctype",
  "\"..\", \".\" and \"this\" can only be at the start of a path",
  "Invalid element name",
  "A block can only be inside an element or another block",
  "A mustache is not allowed here",
  "An end tag cannot be self-closing",
  "Unclosed element",
  "An attribute value that mixes text and a mustache needs quotes",
  "Partials, decorators and raw blocks are not supported",
  "This end tag does not match the open element",
  "This name does not match the open block",
  "This cannot be formatted",
  "Expected \":\"",
  "Invalid directive",
  "This tag cannot be resolved",
  "A key without \"?\" must be on one line",
  "A comment is not allowed here",
  "Unexpected token",
  "A node can have at most one anchor and one tag",
  "Tabs cannot be used for indentation",
];

// The words of a message (slow path: diagnostics).
export function messageText(message: number): string {
  return MESSAGES[message];
}
