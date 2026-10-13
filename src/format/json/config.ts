// Port of `Config` and `Parser` of vendor/bun/src/format/json/mod.rs: what the options and the parser come down to.
// A leaf module (the parser, the writer and the document builder read it).
import {
  EXPAND_AUTO,
  FLAVOR_OXFMT,
  INDENT_TAB,
  LINE_ENDING_CR,
  LINE_ENDING_CRLF,
  QUOTE_DOUBLE,
  QUOTE_PROPS_PRESERVE,
  TRAILING_COMMAS_NONE,
  FormatOptions,
  resolveLineEnding,
} from "../options.ts";

// `json::Parser` (the numbers are those of `src/driver/kinds.ts`: JSON_JSON .. JSON_STRINGIFY).
/** Names are quoted, there are no trailing commas. */
export const PARSER_JSON = 0;
/** Names are quoted. Nothing but comments is a document too. */
export const PARSER_JSONC = 1;
/** Names and strings are quoted as `quoteProps` and `singleQuote` say. */
export const PARSER_JSON5 = 2;
/** `package.json`, `package-lock.json`, `composer.json` */
export const PARSER_STRINGIFY = 3;

/** Prettier's `parser` option: -1 if it is not one of the four. */
export function parserFromName(name: string): number {
  switch (name) {
    case "json": return PARSER_JSON;
    case "jsonc": return PARSER_JSONC;
    case "json5": return PARSER_JSON5;
    case "json-stringify": return PARSER_STRINGIFY;
    default: return -1;
  }
}

/** The line break of the output: `lineEnding`. */
export const LE_LF = 0;
export const LE_CRLF = 1;
export const LE_CR = 2;

/** `Option<QuoteStyle>` that is `None`. */
export const QUOTE_NONE = -1;

export class Config {
  parser: number = PARSER_JSON;
  isOxfmt: boolean = false;
  printWidth: number = 80;
  indentWidth: number = 2;
  isTab: boolean = false;
  /** `LE_*` */
  lineEnding: number = LE_LF;
  bracketSpacing: boolean = true;
  /** `objectWrap: "preserve"`: an object with a line break after its `{` stays broken. */
  preservesWrap: boolean = true;
  trailingComma: boolean = false;
  /** `QUOTE_PROPS_*` */
  quoteProperties: number = 0;
  /** The quotes of all strings (`QUOTE_DOUBLE`, `QUOTE_SINGLE`). `QUOTE_NONE`: those that take fewer escapes. */
  stringQuote: number = QUOTE_DOUBLE;
  /** The quotes of a string that has as many of one kind in it as of the other. */
  preferredQuote: number = QUOTE_DOUBLE;
  /** The quotes of a name that is written without. */
  nameQuote: number = QUOTE_DOUBLE;
  /** The number of columns that all lines are indented by: what is formatted is a part of a document. */
  alignment: number = 0;
  isInMarkdown: boolean = false;

  isStringify(): boolean {
    return this.parser === PARSER_STRINGIFY;
  }

  /** Rust `Config::new(parser, options, text)`. */
  set(parser: number, options: FormatOptions, text: Uint8Array): void {
    // Prettier's `printString`. `json5` with `quoteProps: "preserve"` is how JSON with trailing commas was asked for
    // before there was `jsonc`.
    const isDouble = parser !== PARSER_JSON5 || (options.quoteProperties === QUOTE_PROPS_PRESERVE && options.quoteStyle === QUOTE_DOUBLE);
    this.parser = parser;
    this.isOxfmt = options.flavor === FLAVOR_OXFMT;
    this.printWidth = options.lineWidth;
    this.indentWidth = options.indentWidth;
    this.isTab = options.indentStyle === INDENT_TAB;
    const le = resolveLineEnding(options.lineEnding, text);
    this.lineEnding = le === LINE_ENDING_CRLF ? LE_CRLF : le === LINE_ENDING_CR ? LE_CR : LE_LF;
    this.bracketSpacing = options.bracketSpacing;
    this.preservesWrap = options.expand === EXPAND_AUTO;
    this.trailingComma = (parser === PARSER_JSONC || parser === PARSER_JSON5) && options.trailingCommas !== TRAILING_COMMAS_NONE;
    this.quoteProperties = options.quoteProperties;
    this.stringQuote = isDouble ? QUOTE_DOUBLE : QUOTE_NONE;
    this.preferredQuote = options.quoteStyle;
    this.nameQuote = isDouble ? QUOTE_DOUBLE : options.quoteStyle;
    this.alignment = 0;
    this.isInMarkdown = options.isInMarkdown;
  }

  copyFrom(o: Config): void {
    this.parser = o.parser;
    this.isOxfmt = o.isOxfmt;
    this.printWidth = o.printWidth;
    this.indentWidth = o.indentWidth;
    this.isTab = o.isTab;
    this.lineEnding = o.lineEnding;
    this.bracketSpacing = o.bracketSpacing;
    this.preservesWrap = o.preservesWrap;
    this.trailingComma = o.trailingComma;
    this.quoteProperties = o.quoteProperties;
    this.stringQuote = o.stringQuote;
    this.preferredQuote = o.preferredQuote;
    this.nameQuote = o.nameQuote;
    this.alignment = o.alignment;
    this.isInMarkdown = o.isInMarkdown;
  }
}
