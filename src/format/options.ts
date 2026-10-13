// Port of vendor/bun/src/format/options.rs: the options of Prettier, with oxc's field names.
//
// | Prettier                       | here                            |
// | ------------------------------ | ------------------------------- |
// | `printWidth`                   | `lineWidth`                     |
// | `tabWidth`                     | `indentWidth`                   |
// | `useTabs`                      | `indentStyle`                   |
// | `endOfLine`                    | `lineEnding`                    |
// | `semi`                         | `semicolons`                    |
// | `singleQuote`                  | `quoteStyle`                    |
// | `jsxSingleQuote`               | `jsxQuoteStyle`                 |
// | `quoteProps`                   | `quoteProperties`               |
// | `trailingComma`                | `trailingCommas`                |
// | `bracketSpacing`               | `bracketSpacing`                |
// | `bracketSameLine`              | `bracketSameLine`               |
// | `arrowParens`                  | `arrowParentheses`              |
// | `objectWrap`                   | `expand`                        |
// | `singleAttributePerLine`       | `attributePosition`             |
// | `experimentalOperatorPosition` | `experimentalOperatorPosition`  |
// | `experimentalTernaries`        | `experimentalTernaries`         |
// | `embeddedLanguageFormatting`   | `embeddedLanguageFormatting`    |
//
// Rust enums without data are integer constants (`INDENT_TAB`, `QUOTE_SINGLE`, ...); the Rust methods
// (`is_tab`, `is_as_needed`, `other`, ...) are the small functions below. `Option<T>` fields are `-1`
// (numbers) or `""` (strings) when absent.
import { indexOfByte } from "../base/bytes.ts";
import type { ByteBuf } from "../base/bytebuf.ts";

// ---------------------------------------------------------------------------------------------- enums

// Flavor: whose output to produce where the two differ.
export const FLAVOR_PRETTIER = 0;
export const FLAVOR_OXFMT = 1;
export function flavorIsOxfmt(flavor: number): boolean {
  return flavor === FLAVOR_OXFMT;
}
// Whether a comment with nothing but `text` in it says that what follows stays as it is written. oxfmt knows
// Prettier's comment too, Prettier only its own. `text` is the comment text without `//` or `/* */`, trimmed.
export function flavorIsIgnoreComment(flavor: number, text: string): boolean {
  return text === "prettier-ignore" || (text === "oxfmt-ignore" && flavor === FLAVOR_OXFMT);
}

export const INDENT_SPACE = 0;
export const INDENT_TAB = 1;

export const LINE_ENDING_LF = 0;
export const LINE_ENDING_CRLF = 1;
export const LINE_ENDING_CR = 2;
// That of the first line of the file.
export const LINE_ENDING_AUTO = 3;

// Prettier's `guessEndOfLine`: the first `\r` decides, also if lines before it end in `\n`.
export function resolveLineEnding(lineEnding: number, text: Uint8Array): number {
  if (lineEnding !== LINE_ENDING_AUTO) return lineEnding;
  const at = indexOfByte(text, 0, text.length, 13);
  if (at < 0) return LINE_ENDING_LF;
  if (at + 1 < text.length && (text[at + 1] | 0) === 10) return LINE_ENDING_CRLF;
  return LINE_ENDING_CR;
}

export const QUOTE_DOUBLE = 0;
export const QUOTE_SINGLE = 1;
export function quoteStyleFromByte(byte: number): number {
  return byte === 34 ? QUOTE_DOUBLE : byte === 39 ? QUOTE_SINGLE : -1;
}
export function quoteStyleAsByte(q: number): number {
  return q === QUOTE_DOUBLE ? 34 : 39;
}
export function quoteStyleOther(q: number): number {
  return q === QUOTE_DOUBLE ? QUOTE_SINGLE : QUOTE_DOUBLE;
}

export const QUOTE_PROPS_AS_NEEDED = 0;
export const QUOTE_PROPS_PRESERVE = 1;
export const QUOTE_PROPS_CONSISTENT = 2;

export const TRAILING_COMMAS_ALL = 0;
export const TRAILING_COMMAS_ES5 = 1;
export const TRAILING_COMMAS_NONE = 2;

export const SEMICOLONS_ALWAYS = 0;
export const SEMICOLONS_AS_NEEDED = 1;

export const ARROW_PARENS_ALWAYS = 0;
export const ARROW_PARENS_AS_NEEDED = 1;

export const ATTRIBUTE_POSITION_AUTO = 0;
export const ATTRIBUTE_POSITION_MULTILINE = 1;

// `objectWrap`: "preserve" is AUTO, "collapse" is NEVER.
export const EXPAND_AUTO = 0;
export const EXPAND_NEVER = 1;

export const OPERATOR_POSITION_END = 0;
export const OPERATOR_POSITION_START = 1;

export const EMBEDDED_AUTO = 0;
export const EMBEDDED_OFF = 1;

export const PROSE_WRAP_ALWAYS = 0;
export const PROSE_WRAP_NEVER = 1;
export const PROSE_WRAP_PRESERVE = 2;

export const HTML_WS_CSS = 0;
export const HTML_WS_STRICT = 1;
export const HTML_WS_IGNORE = 2;

export const COMMENT_LINE_SINGLE_LINE = 0;
export const COMMENT_LINE_MULTILINE = 1;
export const COMMENT_LINE_KEEP = 2;

export const LINE_WRAPPING_GREEDY = 0;
export const LINE_WRAPPING_BALANCE = 1;

// What the code is, if it is in HTML.
export const HTML_ROOT_NONE = 0;
// `babel`, `typescript`, `css`, ..
export const HTML_ROOT_PROGRAM = 1;
// `__js_expression`, `__ts_expression`
export const HTML_ROOT_JS_EXPRESSION = 2;
// `__vue_expression`, `__vue_ts_expression`: `a | b` is a filter.
export const HTML_ROOT_VUE_EXPRESSION = 3;
// `__vue_event_binding`, `__vue_ts_event_binding`
export const HTML_ROOT_VUE_EVENT_BINDING = 4;
export const HTML_ROOT_NG_ACTION = 5;
export const HTML_ROOT_NG_BINDING = 6;
export const HTML_ROOT_NG_DIRECTIVE = 7;
export const HTML_ROOT_NG_INTERPOLATION = 8;
// Prettier's `NGRoot`: the code is an expression of Angular, in which `a | b(c)` stands for the pipe `a | b: c`.
export function htmlRootIsAngular(root: number): boolean {
  return root >= HTML_ROOT_NG_ACTION && root <= HTML_ROOT_NG_INTERPOLATION;
}

// What Prettier tells the formatter of code that is in HTML: the options whose names start with `__`, and the
// parsers for what is less than a program. Treat it as an immutable value (Rust: `Copy`): replace
// `options.inHtml` with a new object, or use `copy()`, rather than writing into a shared one.
export class InHtml {
  root: number;
  // `__isInHtmlAttribute`: the code is between double quotes.
  isInAttribute: boolean;
  // `__isInHtmlInterpolation`: `}}` follows the code.
  isInInterpolation: boolean;
  // `__isHtmlInlineEventHandler`
  isInlineEventHandler: boolean;
  // `__isHTMLStyleAttribute`
  isStyleAttribute: boolean;
  // `singleQuote`, which `quoteStyle` does not say in an attribute.
  quoteStyle: number;
  constructor() {
    this.root = HTML_ROOT_NONE;
    this.isInAttribute = false;
    this.isInInterpolation = false;
    this.isInlineEventHandler = false;
    this.isStyleAttribute = false;
    this.quoteStyle = QUOTE_DOUBLE;
  }
  copy(): InHtml {
    const c = new InHtml();
    c.root = this.root;
    c.isInAttribute = this.isInAttribute;
    c.isInInterpolation = this.isInInterpolation;
    c.isInlineEventHandler = this.isInlineEventHandler;
    c.isStyleAttribute = this.isStyleAttribute;
    c.quoteStyle = this.quoteStyle;
    return c;
  }
}

// oxfmt's `jsdoc`, which has the options of prettier-plugin-jsdoc.
export class JsdocOptions {
  // The first letter of a description is made a capital one.
  capitalizeDescriptions: boolean = true;
  commentLineStrategy: number = COMMENT_LINE_SINGLE_LINE;
  // An empty line between tags of different kinds.
  separateTagGroups: boolean = false;
  // An empty line between the last `@param` and `@returns`.
  separateReturnsFromParam: boolean = false;
  // `{ string }` instead of `{string}`.
  bracketSpacing: boolean = false;
  // A description ends with a dot.
  descriptionWithDot: boolean = false;
  // "Default is `value`" at the end of the description of `@param [name=value]`.
  addDefaultToDescription: boolean = true;
  // Code without a language is between fences instead of being indented.
  preferCodeFences: boolean = false;
  lineWrappingStyle: number = LINE_WRAPPING_GREEDY;
  // The description comes after `@description`.
  descriptionTag: boolean = false;
  // An `@example` that cannot be parsed keeps its indentation.
  keepUnparsableExampleIndent: boolean = false;
  copy(): JsdocOptions {
    const c = new JsdocOptions();
    c.capitalizeDescriptions = this.capitalizeDescriptions;
    c.commentLineStrategy = this.commentLineStrategy;
    c.separateTagGroups = this.separateTagGroups;
    c.separateReturnsFromParam = this.separateReturnsFromParam;
    c.bracketSpacing = this.bracketSpacing;
    c.descriptionWithDot = this.descriptionWithDot;
    c.addDefaultToDescription = this.addDefaultToDescription;
    c.preferCodeFences = this.preferCodeFences;
    c.lineWrappingStyle = this.lineWrappingStyle;
    c.descriptionTag = this.descriptionTag;
    c.keepUnparsableExampleIndent = this.keepUnparsableExampleIndent;
    return c;
  }
}

// Formats JavaScript or TypeScript, which the IR crate cannot parse by itself (Markdown code blocks). It is given the
// name of a file that says which of them it is, the code as `text[start, end)`, the options, and the buffer to
// append the result to. It returns whether the code could be formatted.
export type FormatJavaScript = (path: string, text: Uint8Array, start: number, end: number, options: FormatOptions, out: ByteBuf) => boolean;

// ---------------------------------------------------------------------------------------------- FormatOptions

export class FormatOptions {
  indentStyle: number = INDENT_SPACE;
  indentWidth: number = 2;
  lineEnding: number = LINE_ENDING_LF;
  // Up to 2^32-1 (`printWidth: Infinity`), so a plain double.
  lineWidth: number = 80;
  quoteStyle: number = QUOTE_DOUBLE;
  jsxQuoteStyle: number = QUOTE_DOUBLE;
  quoteProperties: number = QUOTE_PROPS_AS_NEEDED;
  trailingCommas: number = TRAILING_COMMAS_ALL;
  semicolons: number = SEMICOLONS_ALWAYS;
  arrowParentheses: number = ARROW_PARENS_ALWAYS;
  bracketSpacing: boolean = true;
  bracketSameLine: boolean = false;
  attributePosition: number = ATTRIBUTE_POSITION_AUTO;
  expand: number = EXPAND_AUTO;
  experimentalOperatorPosition: number = OPERATOR_POSITION_END;
  experimentalTernaries: boolean = false;
  embeddedLanguageFormatting: number = EMBEDDED_AUTO;
  // For YAML and Markdown.
  proseWrap: number = PROSE_WRAP_PRESERVE;
  // For HTML and what is like it.
  htmlWhitespaceSensitivity: number = HTML_WS_CSS;
  vueIndentScriptAndStyle: boolean = false;
  // The name of the file, if it is not the one that it was parsed under: text from stdin. "" is none.
  filepath: string = "";
  // Prettier's `parser`, if it is not left to the name of the file: `json5`, `babel`, .. "" is none.
  parser: string = "";
  // Only what is between the two is formatted. As in Prettier, they count UTF-16 code units. -1 is none
  // (`rangeStart` 0 / `rangeEnd` Infinity).
  rangeStart: number = -1;
  rangeEnd: number = -1;
  // Where the cursor is, in UTF-16 code units. Where it ends up is part of the result. -1 is none.
  cursorOffset: number = -1;
  // Puts `@format` in a comment at the top of the file.
  insertPragma: boolean = false;
  // Only a file with `@format` or `@prettier` in a comment at its top is formatted.
  requirePragma: boolean = false;
  // A file with `@noformat` or `@noprettier` in a comment at its top is not formatted.
  checkIgnorePragma: boolean = false;
  // The text is code in Markdown: Prettier's `parentParser`. A statement that is nothing but JSX gets no
  // semicolon. A line break that is part of a text (in a template, in a comment) is written as `\r\n`, to
  // tell it from the others: Markdown indents what follows it in another way.
  isInMarkdown: boolean = false;
  // The text is `<$>`, JSX that is in MDX, and `</$>`: Prettier's `rootMarker: "mdx"`.
  isMdxJsx: boolean = false;
  // The text is `import` and `export` declarations in MDX.
  isMdxEsSyntax: boolean = false;
  // Whether HTML in the templates of JavaScript and in the blocks of code of Markdown is formatted.
  embeddedHtml: boolean = false;
  // In how many templates of JavaScript that are written as HTML the text is.
  htmlTemplateDepth: number = 0;
  // The text is in a file whose name ends with `.html` or `.htm`.
  isInHtmlFile: boolean = false;
  // Formats the JavaScript and TypeScript in blocks of code in Markdown. Without it they stay as they are.
  formatJavascript: FormatJavaScript | null = null;
  // What the code is in, if it is in HTML.
  inHtml: InHtml = new InHtml();
  // Whose output to produce where the two differ.
  flavor: number = FLAVOR_PRETTIER;
  // oxfmt's `sortPackageJson`: the keys of a `package.json` are put in the usual order.
  sortPackageJson: boolean = false;
  sortPackageJsonSortScripts: boolean = true;
  // How imports are sorted, if they are: a handle owned by src/format/js/sort_imports (-1 is none).
  sortImports: number = -1;
  // oxfmt's `jsdoc`: how JSDoc comments are formatted, if they are. null is off.
  jsdoc: JsdocOptions | null = null;
  // oxfmt's `sortTailwindcss`: a handle owned by src/format/tailwind (-1 is none).
  tailwind: number = -1;
  // Format TOML even in Prettier's flavor. Only the caller that detects file types reads this.
  toml: boolean = false;

  copy(): FormatOptions {
    const c = new FormatOptions();
    c.indentStyle = this.indentStyle;
    c.indentWidth = this.indentWidth;
    c.lineEnding = this.lineEnding;
    c.lineWidth = this.lineWidth;
    c.quoteStyle = this.quoteStyle;
    c.jsxQuoteStyle = this.jsxQuoteStyle;
    c.quoteProperties = this.quoteProperties;
    c.trailingCommas = this.trailingCommas;
    c.semicolons = this.semicolons;
    c.arrowParentheses = this.arrowParentheses;
    c.bracketSpacing = this.bracketSpacing;
    c.bracketSameLine = this.bracketSameLine;
    c.attributePosition = this.attributePosition;
    c.expand = this.expand;
    c.experimentalOperatorPosition = this.experimentalOperatorPosition;
    c.experimentalTernaries = this.experimentalTernaries;
    c.embeddedLanguageFormatting = this.embeddedLanguageFormatting;
    c.proseWrap = this.proseWrap;
    c.htmlWhitespaceSensitivity = this.htmlWhitespaceSensitivity;
    c.vueIndentScriptAndStyle = this.vueIndentScriptAndStyle;
    c.filepath = this.filepath;
    c.parser = this.parser;
    c.rangeStart = this.rangeStart;
    c.rangeEnd = this.rangeEnd;
    c.cursorOffset = this.cursorOffset;
    c.insertPragma = this.insertPragma;
    c.requirePragma = this.requirePragma;
    c.checkIgnorePragma = this.checkIgnorePragma;
    c.isInMarkdown = this.isInMarkdown;
    c.isMdxJsx = this.isMdxJsx;
    c.isMdxEsSyntax = this.isMdxEsSyntax;
    c.embeddedHtml = this.embeddedHtml;
    c.htmlTemplateDepth = this.htmlTemplateDepth;
    c.isInHtmlFile = this.isInHtmlFile;
    c.formatJavascript = this.formatJavascript;
    c.inHtml = this.inHtml.copy();
    c.flavor = this.flavor;
    c.sortPackageJson = this.sortPackageJson;
    c.sortPackageJsonSortScripts = this.sortPackageJsonSortScripts;
    c.sortImports = this.sortImports;
    const j = this.jsdoc;
    c.jsdoc = j === null ? null : j.copy();
    c.tailwind = this.tailwind;
    c.toml = this.toml;
    return c;
  }

  // Sets the option that Prettier calls `name`. `value` is as it is written in JSON, a string without its quotes.
  // Returns false (and changes nothing) if the value is not accepted or there is no such option.
  set(name: string, value: string): boolean {
    switch (name) {
      // Less than nothing is nothing, and more than there is room for is all of it.
      case "printWidth": {
        const n = parseInteger(value);
        if (Number.isNaN(n)) return false;
        this.lineWidth = clampU32(n);
        return true;
      }
      // Prettier fails where it repeats a blank less than no times.
      case "tabWidth": {
        const n = parseInteger(value);
        if (Number.isNaN(n) || n < 0) return false;
        this.indentWidth = clampU32(n);
        return true;
      }
      case "useTabs": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.indentStyle = b === 1 ? INDENT_TAB : INDENT_SPACE;
        return true;
      }
      case "endOfLine":
        if (value === "lf") this.lineEnding = LINE_ENDING_LF;
        else if (value === "crlf") this.lineEnding = LINE_ENDING_CRLF;
        else if (value === "cr") this.lineEnding = LINE_ENDING_CR;
        else if (value === "auto") this.lineEnding = LINE_ENDING_AUTO;
        else return false;
        return true;
      case "semi": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.semicolons = b === 1 ? SEMICOLONS_ALWAYS : SEMICOLONS_AS_NEEDED;
        return true;
      }
      case "singleQuote": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.quoteStyle = b === 1 ? QUOTE_SINGLE : QUOTE_DOUBLE;
        return true;
      }
      case "jsxSingleQuote": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.jsxQuoteStyle = b === 1 ? QUOTE_SINGLE : QUOTE_DOUBLE;
        return true;
      }
      case "quoteProps":
        if (value === "as-needed") this.quoteProperties = QUOTE_PROPS_AS_NEEDED;
        else if (value === "preserve") this.quoteProperties = QUOTE_PROPS_PRESERVE;
        else if (value === "consistent") this.quoteProperties = QUOTE_PROPS_CONSISTENT;
        else return false;
        return true;
      case "trailingComma":
        if (value === "all") this.trailingCommas = TRAILING_COMMAS_ALL;
        else if (value === "es5") this.trailingCommas = TRAILING_COMMAS_ES5;
        else if (value === "none") this.trailingCommas = TRAILING_COMMAS_NONE;
        else return false;
        return true;
      case "bracketSpacing": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.bracketSpacing = b === 1;
        return true;
      }
      case "bracketSameLine": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.bracketSameLine = b === 1;
        return true;
      }
      // The name it had before 2.4. One of the two is enough.
      case "jsxBracketSameLine": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.bracketSameLine = b === 1 || this.bracketSameLine;
        return true;
      }
      case "arrowParens":
        if (value === "always") this.arrowParentheses = ARROW_PARENS_ALWAYS;
        else if (value === "avoid") this.arrowParentheses = ARROW_PARENS_AS_NEEDED;
        else return false;
        return true;
      case "objectWrap":
        if (value === "preserve") this.expand = EXPAND_AUTO;
        else if (value === "collapse") this.expand = EXPAND_NEVER;
        else return false;
        return true;
      case "singleAttributePerLine": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.attributePosition = b === 1 ? ATTRIBUTE_POSITION_MULTILINE : ATTRIBUTE_POSITION_AUTO;
        return true;
      }
      case "experimentalOperatorPosition":
        if (value === "start") this.experimentalOperatorPosition = OPERATOR_POSITION_START;
        else if (value === "end") this.experimentalOperatorPosition = OPERATOR_POSITION_END;
        else return false;
        return true;
      case "experimentalTernaries": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.experimentalTernaries = b === 1;
        return true;
      }
      case "embeddedLanguageFormatting":
        if (value === "auto") this.embeddedLanguageFormatting = EMBEDDED_AUTO;
        else if (value === "off") this.embeddedLanguageFormatting = EMBEDDED_OFF;
        else return false;
        return true;
      case "proseWrap":
        if (value === "always") this.proseWrap = PROSE_WRAP_ALWAYS;
        else if (value === "never") this.proseWrap = PROSE_WRAP_NEVER;
        else if (value === "preserve") this.proseWrap = PROSE_WRAP_PRESERVE;
        else return false;
        return true;
      case "htmlWhitespaceSensitivity":
        if (value === "css") this.htmlWhitespaceSensitivity = HTML_WS_CSS;
        else if (value === "strict") this.htmlWhitespaceSensitivity = HTML_WS_STRICT;
        else if (value === "ignore") this.htmlWhitespaceSensitivity = HTML_WS_IGNORE;
        else return false;
        return true;
      case "vueIndentScriptAndStyle": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.vueIndentScriptAndStyle = b === 1;
        return true;
      }
      case "filepath":
        this.filepath = value;
        return true;
      case "parser":
        this.parser = value;
        return true;
      case "rangeStart": {
        const n = parseCount(value);
        if (n < 0) return false;
        this.rangeStart = n;
        return true;
      }
      // `Infinity` is the default.
      case "rangeEnd":
        this.rangeEnd = parseCount(value);
        return true;
      // -1 is the default.
      case "cursorOffset":
        this.cursorOffset = parseCount(value);
        return true;
      case "insertPragma": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.insertPragma = b === 1;
        return true;
      }
      case "requirePragma": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.requirePragma = b === 1;
        return true;
      }
      case "checkIgnorePragma": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.checkIgnorePragma = b === 1;
        return true;
      }
      // oxfmt's: `true`, `false` or `{ "sortScripts": true }`.
      case "sortPackageJson": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.sortPackageJson = b === 1;
        if (b === 1) this.sortPackageJsonSortScripts = true;
        return true;
      }
      case "sortPackageJson.sortScripts": {
        const b = parseBool(value);
        if (b < 0) return false;
        this.sortPackageJson = true;
        this.sortPackageJsonSortScripts = b === 1;
        return true;
      }
      // oxfmt's: `true`, `false` or an object, whose properties come as `jsdoc.<name>`.
      case "jsdoc": {
        if (value === "{}") {
          this.jsdoc = new JsdocOptions();
          return true;
        }
        const b = parseBool(value);
        if (b < 0) return false;
        this.jsdoc = b === 1 ? new JsdocOptions() : null;
        return true;
      }
      // Not an option of Prettier. The kind of the configuration file decides.
      case "flavor":
        if (value === "prettier") this.flavor = FLAVOR_PRETTIER;
        else if (value === "oxfmt") this.flavor = FLAVOR_OXFMT;
        else return false;
        return true;
      default:
        if (name.startsWith("jsdoc.")) return this.setJsdoc(name.substring(6), value);
        return false;
    }
  }

  setJsdoc(name: string, value: string): boolean {
    let j = this.jsdoc;
    if (j === null) {
      j = new JsdocOptions();
      this.jsdoc = j;
    }
    switch (name) {
      case "capitalizeDescriptions": {
        const b = parseBool(value);
        if (b < 0) return false;
        j.capitalizeDescriptions = b === 1;
        return true;
      }
      case "commentLineStrategy":
        if (value === "singleLine") j.commentLineStrategy = COMMENT_LINE_SINGLE_LINE;
        else if (value === "multiline") j.commentLineStrategy = COMMENT_LINE_MULTILINE;
        else if (value === "keep") j.commentLineStrategy = COMMENT_LINE_KEEP;
        else return false;
        return true;
      case "separateTagGroups": {
        const b = parseBool(value);
        if (b < 0) return false;
        j.separateTagGroups = b === 1;
        return true;
      }
      case "separateReturnsFromParam": {
        const b = parseBool(value);
        if (b < 0) return false;
        j.separateReturnsFromParam = b === 1;
        return true;
      }
      case "bracketSpacing": {
        const b = parseBool(value);
        if (b < 0) return false;
        j.bracketSpacing = b === 1;
        return true;
      }
      case "descriptionWithDot": {
        const b = parseBool(value);
        if (b < 0) return false;
        j.descriptionWithDot = b === 1;
        return true;
      }
      case "addDefaultToDescription": {
        const b = parseBool(value);
        if (b < 0) return false;
        j.addDefaultToDescription = b === 1;
        return true;
      }
      case "preferCodeFences": {
        const b = parseBool(value);
        if (b < 0) return false;
        j.preferCodeFences = b === 1;
        return true;
      }
      case "lineWrappingStyle":
        if (value === "greedy") j.lineWrappingStyle = LINE_WRAPPING_GREEDY;
        else if (value === "balance") j.lineWrappingStyle = LINE_WRAPPING_BALANCE;
        else return false;
        return true;
      case "descriptionTag": {
        const b = parseBool(value);
        if (b < 0) return false;
        j.descriptionTag = b === 1;
        return true;
      }
      case "keepUnparsableExampleIndent": {
        const b = parseBool(value);
        if (b < 0) return false;
        j.keepUnparsableExampleIndent = b === 1;
        return true;
      }
      default:
        return false;
    }
  }
}

// "true" -> 1, "false" -> 0, else -1.
function parseBool(value: string): number {
  if (value === "true") return 1;
  if (value === "false") return 0;
  return -1;
}

// A non-negative decimal integer, saturating at 2^32-1; -1 if `value` is not one (Rust `number(u32::MAX)`).
function parseCount(value: string): number {
  const n = value.length;
  if (n === 0) return -1;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = value.charCodeAt(i);
    if (c < 48 || c > 57) return -1;
    v = v * 10 + (c - 48);
    if (v > 4294967295) v = 4294967295;
  }
  return v;
}

// What Prettier takes for an integer: `Number(value)` of what is on the command line, `Infinity` too.
// NaN (as the "invalid" result) for what is not one.
function parseInteger(value: string): number {
  const t = value.trim();
  const n = t.length === 0 ? 0 : Number(t);
  if (Number.isNaN(n)) return NaN;
  if (Number.isFinite(n) && n !== Math.floor(n)) return NaN;
  return n;
}

// Rust `f64 as u32`: saturating, NaN is 0.
function clampU32(n: number): number {
  if (n !== n) return 0;
  if (n <= 0) return 0;
  if (n >= 4294967295) return 4294967295;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------------------------- trailing commas

// Where a trailing comma is written if `trailingCommas` allows it: anywhere, or only where ES5 allows one.
export const FTC_ALL = 0;
// Like `All`, but Angular takes none after the last argument of a call and the last parameter of a function.
export const FTC_ARGUMENTS = 1;
export const FTC_ES5 = 2;

export const TRAILING_SEPARATOR_ALLOWED = 0; // Written if the enclosing group breaks.
export const TRAILING_SEPARATOR_DISALLOWED = 1; // A syntax error, after a rest element for example.
export const TRAILING_SEPARATOR_MANDATORY = 2;
export const TRAILING_SEPARATOR_OMIT = 3; // Left out because of the options.

export function trailingSeparator(kind: number, options: FormatOptions): number {
  const tc = options.trailingCommas;
  if (tc === TRAILING_COMMAS_NONE) return TRAILING_SEPARATOR_OMIT;
  if ((kind === FTC_ALL || kind === FTC_ARGUMENTS) && tc !== TRAILING_COMMAS_ALL) return TRAILING_SEPARATOR_OMIT;
  if (kind === FTC_ARGUMENTS && htmlRootIsAngular(options.inHtml.root)) return TRAILING_SEPARATOR_OMIT;
  return TRAILING_SEPARATOR_ALLOWED;
}
