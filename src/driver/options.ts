// The options of a file as the driver resolves them, and the check of their values (`FormatOptions::set` of
// vendor/bun/src/format/options.rs says whether a value is accepted).

// The largest number that is read. It stands for `Infinity` and for `max_line_length = off`.
export const NO_END = "4294967295";

// What the file is formatted with. `names[i]` is set to `values[i]` in order (the last one wins): Prettier's option names,
// with the values as JSON text (a string without its quotes), plus Bun's `sortImports`, `sortPackageJson`, `jsdoc`.
export class Resolved {
  names: string[];
  values: string[];
  // The options about sorting imports (`Settings` of src/format/js/sort_imports), by name.
  sortNames: string[];
  sortValues: string[];
  // `insertFinalNewline: false`
  omitsFinalNewline: boolean;
  // Format TOML even in Prettier's flavor.
  toml: boolean;
  // The option `parser`, or "".
  parser: string;
  // Formatted as oxfmt formats: the configuration file is oxfmt's, or the run is like oxfmt.
  isOxfmt: boolean;
  // A canonical key: two files with the same key are formatted with the same options.
  key: string;
  constructor() {
    this.names = [];
    this.values = [];
    this.sortNames = [];
    this.sortValues = [];
    this.omitsFinalNewline = false;
    this.toml = false;
    this.parser = "";
    this.isOxfmt = false;
    this.key = "";
  }
  set(name: string, value: string): void {
    this.names.push(name);
    this.values.push(value);
    if (name === "parser") this.parser = value;
  }
  finish(): void {
    let k = this.omitsFinalNewline ? "n" : "-";
    k += this.toml ? "t" : "-";
    k += this.isOxfmt ? "o" : "-";
    for (let i = 0; i < this.names.length; i++) k += "\u0001" + this.names[i] + "\u0002" + this.values[i];
    for (let i = 0; i < this.sortNames.length; i++) k += "\u0003" + this.sortNames[i] + "\u0002" + this.sortValues[i];
    this.key = k;
  }
}

// `js_string_to_number`: what `Number(text)` makes of the text.
export function jsNumber(text: string): number {
  const t = text.replace(/^[\s﻿]+|[\s﻿]+$/g, "");
  if (t.length === 0) return 0;
  if (t === "Infinity" || t === "+Infinity") return Infinity;
  if (t === "-Infinity") return -Infinity;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  if (/^0[xX][0-9a-fA-F]+$/.test(t) || /^0[oO][0-7]+$/.test(t) || /^0[bB][01]+$/.test(t)) return Number(t);
  return NaN;
}

function isBoolean(v: string): boolean {
  return v === "true" || v === "false";
}

function oneOf(v: string, a: string[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] === v) return true;
  return false;
}

function isIntegerOption(v: string): boolean {
  const n = jsNumber(v);
  if (n !== n) return false;
  if (isFinite(n) && Math.floor(n) !== n) return false;
  return true;
}

function isUnsigned(v: string): boolean {
  if (v.length === 0) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

// Whether `FormatOptions::set(name, value)` accepts the value. Unknown names are not accepted either.
export function isValidOption(name: string, value: string): boolean {
  switch (name) {
    case "printWidth":
      return isIntegerOption(value);
    case "tabWidth":
      return isIntegerOption(value) && jsNumber(value) >= 0;
    case "useTabs":
    case "semi":
    case "singleQuote":
    case "jsxSingleQuote":
    case "bracketSpacing":
    case "bracketSameLine":
    case "jsxBracketSameLine":
    case "singleAttributePerLine":
    case "experimentalTernaries":
    case "vueIndentScriptAndStyle":
    case "insertPragma":
    case "requirePragma":
    case "checkIgnorePragma":
    case "sortPackageJson":
    case "sortPackageJson.sortScripts":
      return isBoolean(value);
    case "endOfLine":
      return oneOf(value, ["lf", "crlf", "cr", "auto"]);
    case "quoteProps":
      return oneOf(value, ["as-needed", "preserve", "consistent"]);
    case "trailingComma":
      return oneOf(value, ["all", "es5", "none"]);
    case "arrowParens":
      return oneOf(value, ["always", "avoid"]);
    case "objectWrap":
      return oneOf(value, ["preserve", "collapse"]);
    case "experimentalOperatorPosition":
      return oneOf(value, ["start", "end"]);
    case "embeddedLanguageFormatting":
      return oneOf(value, ["auto", "off"]);
    case "proseWrap":
      return oneOf(value, ["always", "never", "preserve"]);
    case "htmlWhitespaceSensitivity":
      return oneOf(value, ["css", "strict", "ignore"]);
    case "filepath":
    case "parser":
      return true;
    case "rangeStart":
      return isUnsigned(value) && Number(value) <= 4294967295;
    case "rangeEnd":
    case "cursorOffset":
      return true;
    case "flavor":
      return value === "prettier" || value === "oxfmt";
    case "jsdoc":
      return value === "{}" || isBoolean(value);
    default:
      break;
  }
  if (name.startsWith("jsdoc.")) {
    const key = name.substring(6);
    switch (key) {
      case "capitalizeDescriptions":
      case "separateTagGroups":
      case "separateReturnsFromParam":
      case "bracketSpacing":
      case "descriptionWithDot":
      case "addDefaultToDescription":
      case "preferCodeFences":
      case "descriptionTag":
      case "keepUnparsableExampleIndent":
        return isBoolean(value);
      case "commentLineStrategy":
        return oneOf(value, ["singleLine", "multiline", "keep"]);
      case "lineWrappingStyle":
        return oneOf(value, ["greedy", "balance"]);
      default:
        return false;
    }
  }
  return false;
}

// Whether a name is one of Prettier's options (which the formatter has).
const OPTIONS = [
  "cursorOffset",
  "parser",
  "jsxBracketSameLine",
  "rangeStart",
  "rangeEnd",
  "insertPragma",
  "requirePragma",
  "checkIgnorePragma",
  "printWidth",
  "tabWidth",
  "useTabs",
  "endOfLine",
  "semi",
  "singleQuote",
  "jsxSingleQuote",
  "quoteProps",
  "trailingComma",
  "bracketSpacing",
  "bracketSameLine",
  "arrowParens",
  "objectWrap",
  "singleAttributePerLine",
  "experimentalOperatorPosition",
  "experimentalTernaries",
  "embeddedLanguageFormatting",
  "proseWrap",
  "htmlWhitespaceSensitivity",
  "vueIndentScriptAndStyle",
];

export function isOptionOfPrettier(name: string): boolean {
  return oneOf(name, OPTIONS);
}

const OPTIONS_WITH_STRINGS = ["parser", "endOfLine", "quoteProps", "trailingComma", "arrowParens", "objectWrap", "experimentalOperatorPosition", "embeddedLanguageFormatting", "proseWrap", "htmlWhitespaceSensitivity"];

export function isOptionWithString(name: string): boolean {
  return oneOf(name, OPTIONS_WITH_STRINGS);
}

// Prettier's words for a `printWidth` or a `tabWidth` that is no integer. "" if it is one. `isFlag`: it is on the command line.
export function notAnInteger(name: string, value: string, isFlag: boolean): string {
  let flag: string;
  if (name === "printWidth") flag = "--print-width";
  else if (name === "tabWidth") flag = "--tab-width";
  else return "";
  const number = jsNumber(value);
  if (!isFinite(number) && number === number) return "";
  if (number === number && Math.floor(number) === number) return "";
  let shownName: string;
  let received: string;
  if (isFlag) {
    shownName = flag;
    received = number !== number ? "null" : String(number);
  } else {
    shownName = name;
    received = value;
  }
  return "Invalid " + shownName + " value. Expected an integer, but received " + received + ".";
}

export function isInvalidValue(error: string): boolean {
  return error.startsWith("Invalid ") && error.indexOf(" value. Expected ") >= 0;
}
