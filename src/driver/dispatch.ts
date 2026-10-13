// The one place where the language formatters plug in. Port of `format()` in
// vendor/bun/src/lint/driver/fmt/mod.rs (the real path; `format_for_tests` is the same function).
//
//   formatFile(path, src, len, set, out): status
//
// - `path`: the absolute path of the file (the name decides the language).
// - `src`, `len`: the bytes of the file (`src` is the worker's reusable read buffer: only `src[0..len)` counts).
// - `set`: the options of the file, resolved by the driver (shared by the files that have the same options).
// - `out`: a ByteBuf the formatted text is appended to (the driver resets it before the call).
//
// Returns one of the ST_* codes. The details of a failure are in the module-level slots `errMessage`, `errOffset`,
// `errIsJs`. The driver compares `out` with `src` itself; a formatter that knows the text is unchanged may still
// append it.
//
// To plug a language in: replace the body of the `TODO(port)` function for it (`jsonFormat`, `cssFormat`, ...) with a call
// to the formatter, and return one of the R_* codes. Until then every language "formats" to its own text.
import { ByteBuf } from "../base/bytebuf.ts";
import { FormatOptions } from "../format/options.ts";
import { messageText, refusalMessage, refusalOffset } from "../format/syntax_error.ts";
import { formatJson } from "../format/json/mod.ts";
import { sortPackageJson } from "../format/json/sort_package_json.ts";
import { formatToml, tomlSyntaxError, tomlSyntaxMessage, tomlSyntaxOffset } from "../format/toml/mod.ts";
import { formatYaml } from "../format/yaml/mod.ts";
import { format as cssFormatText } from "../format/css/mod.ts";
import { format as formatMarkdown, formatMdx } from "../format/markdown/mod.ts";
import { format as formatGraphqlText } from "../format/graphql/mod.ts";
import { format as formatHandlebars } from "../format/handlebars/mod.ts";
import * as kinds from "./kinds.ts";
import * as pragma from "../format/pragma.ts";
import { formatScript, scriptErrorMessage, scriptErrorOffset } from "../format/js/script.ts";
import { cursorInFormattedText, cursorResult } from "../format/cursor.ts";
import { Resolved } from "./options.ts";
import { Settings as SortSettings, registerSortImports, sortImportsOf } from "../format/js/sort_imports/mod.ts";

export const ST_OK = 0;
// A syntax error: `errMessage`, `errOffset` (-1: about the whole file), `errIsJs`.
export const ST_SYNTAX = 1;
// A bug in the formatter: it could not print the file.
export const ST_BUG = 2;
// `--debug-check`: what would be written does not say what the file says (`errMessage` is the reason).
export const ST_CHANGED = 3;
// TOML that cannot be read, with what is wrong with it (oxfmt passes over such a file without a word).
export const ST_UNREAD = 4;

// The results of the language formatters (`FormatError` of bun_format).
export const R_OK = 0;
// `FormatError::SyntaxError`: "This is not valid <language>".
export const R_SYNTAX = 1;
// `FormatError::SyntaxErrorAt`: `fmtMessage` and `fmtOffset` are set.
export const R_SYNTAX_AT = 2;
export const R_NESTED_TOO_DEEPLY = 3;
export const R_TOO_LONG = 4;
export const R_INVALID_DOCUMENT = 5;

// What a language formatter says about an error (the slots it fills).
export let fmtMessage = "";
export let fmtOffset = -1;

// Where `options.cursorOffset` ended up in the output, in UTF-16 code units (-1: nowhere). Set by the language formatter that
// places a cursor (`setCursor`), or by `finish` through `cursor::cursor_in_formatted_text`. Printed on standard error for
// standard input, as Prettier does.
export let cursorSlot = -1;

export function setCursor(utf16Offset: number): void {
  cursorSlot = utf16Offset;
}

// The text of the file that `formatFile` is formatting: what `finish` asks `cursorInFormattedText` about.
let cursorText: Uint8Array = new Uint8Array(0);

// What the driver reads after a failure.
export let errMessage = "";
export let errOffset = -1;
export let errIsJs = false;

export function setSyntaxError(message: string, offset: number): void {
  fmtMessage = message;
  fmtOffset = offset;
}

// The options of a file, as the driver resolves them, for the formatters.
export class OptionSet {
  id: number;
  resolved: Resolved;
  // Whether the run verifies what it writes (`--debug-check`)
  verifies: boolean;
  constructor(id: number, resolved: Resolved, verifies: boolean) {
    this.id = id;
    this.resolved = resolved;
    this.verifies = verifies;
  }
}

// The `FormatOptions` of an option set, made once per thread (the formatters take them as they are). The names and values
// of the set are applied in order, as the driver of Bun applies them: `filepath`, the options of Prettier, `sortImports`..
const formatOptionsCache = new Map<number, FormatOptions>();

export function formatOptionsOf(set: OptionSet): FormatOptions {
  let o = formatOptionsCache.get(set.id);
  if (o === undefined) {
    o = new FormatOptions();
    o.embeddedHtml = true;
    o.toml = set.resolved.toml;
    const r = set.resolved;
    for (let i = 0; i < r.names.length; i++) {
      // TODO(port): `sortTailwindcss`: a handle owned by its module
      o.set(r.names[i], r.values[i]);
    }
    // How imports are sorted (the options were checked when they were resolved): compiled once per thread and option set.
    if (r.sortNames.length > 0) {
      const sort = new SortSettings();
      for (let i = 0; i < r.sortNames.length; i++) sort.set(r.sortNames[i], r.sortValues[i]);
      const how = sort.compile();
      if (how !== null) o.sortImports = registerSortImports(how);
    }
    o.formatJavascript = formatBlock;
    formatOptionsCache.set(set.id, o);
  }
  return o;
}

const NESTED_TOO_DEEPLY = "The code is nested too deeply";
const TOO_LONG = "The formatted code is too long for a string";

function failSyntax(message: string, offset: number, isJs: boolean): number {
  errMessage = message;
  errOffset = offset;
  errIsJs = isJs;
  return ST_SYNTAX;
}

function cannotResolveParser(parser: string): string {
  return "Couldn't resolve parser \"" + parser + '".';
}

// `without_final_newline`
function withoutFinalNewline(out: ByteBuf): void {
  const n = out.len;
  const d = out.data;
  if (n >= 2 && (d[n - 2] | 0) === 13 && (d[n - 1] | 0) === 10) out.len = n - 2;
  else if (n >= 1 && ((d[n - 1] | 0) === 10 || (d[n - 1] | 0) === 13)) out.len = n - 1;
}

// `finish` of `format()`: what to do with the result of a language formatter.
function finish(r: number, out: ByteBuf, what: string, set: OptionSet): number {
  if (r === R_OK) {
    if (set.resolved.omitsFinalNewline) withoutFinalNewline(out);
    const options = formatOptionsOf(set);
    if (options.cursorOffset >= 0) cursorSlot = cursorInFormattedText(cursorText, options, out.view());
    return ST_OK;
  }
  if (r === R_SYNTAX) return failSyntax("This is not valid " + what, -1, false);
  if (r === R_SYNTAX_AT) return failSyntax(fmtMessage, fmtOffset, false);
  if (r === R_NESTED_TOO_DEEPLY) return failSyntax(NESTED_TOO_DEEPLY, -1, false);
  if (r === R_TOO_LONG) return failSyntax(TOO_LONG, -1, false);
  errMessage = "";
  return ST_BUG;
}

// bun_format::json::format (`src/format/json/mod.ts`), after json::sort_package_json when `sortPackageJson` is set and the
// file is a `package.json`.
const sortedPackageJson = new ByteBuf(1 << 14);
function jsonFormat(path: string, src: Uint8Array, len: number, parser: number, set: OptionSet, out: ByteBuf): number {
  const o = formatOptionsOf(set);
  let text = src;
  let n = len;
  if (o.sortPackageJson && (path === "package.json" || path.endsWith("/package.json"))) {
    sortedPackageJson.reset();
    if (sortPackageJson(src, len, o.sortPackageJsonSortScripts, sortedPackageJson)) {
      text = sortedPackageJson.data;
      n = sortedPackageJson.len;
    }
  }
  const r = formatJson(text, n, parser, o, out);
  if (r === R_SYNTAX_AT) setSyntaxError(messageText(refusalMessage()), refusalOffset());
  return r;
}

// bun_format::css::format (`src/format/css/mod.ts`), `parser`: kinds.CSS_*
function cssFormat(src: Uint8Array, len: number, parser: number, set: OptionSet, out: ByteBuf): number {
  const r = cssFormatText(len === src.length ? src : src.subarray(0, len), parser, formatOptionsOf(set), out);
  if (r === R_SYNTAX_AT) setSyntaxError(messageText(refusalMessage()), refusalOffset());
  return r;
}

// bun_format::yaml::format (`src/format/yaml/mod.ts`)
function yamlFormat(src: Uint8Array, len: number, set: OptionSet, out: ByteBuf): number {
  const r = formatYaml(src, len, formatOptionsOf(set), out);
  if (r === R_SYNTAX_AT) setSyntaxError(messageText(refusalMessage()), refusalOffset());
  return r;
}

// bun_format::markdown::format_with / format_mdx_with (`src/format/markdown/mod.ts`). TODO(port): code in Markdown goes through
// `formatFile` again for JavaScript (`options.formatJavascript`, see `formatOptionsOf`).
function markdownFormat(src: Uint8Array, len: number, isMdx: boolean, set: OptionSet, out: ByteBuf): number {
  const text = len === src.length ? src : src.subarray(0, len);
  const options = formatOptionsOf(set);
  return isMdx ? formatMdx(text, options, out) : formatMarkdown(text, options, out);
}

// bun_format::graphql::format (`src/format/graphql/mod.ts`)
function graphqlFormat(src: Uint8Array, len: number, set: OptionSet, out: ByteBuf): number {
  const r = formatGraphqlText(len === src.length ? src : src.subarray(0, len), formatOptionsOf(set), out);
  if (r === R_SYNTAX_AT) setSyntaxError(messageText(refusalMessage()), refusalOffset());
  return r;
}

// bun_format::toml::format and bun_format::toml::syntax_error for the message (`src/format/toml/mod.ts`). Returns an ST_* code:
// oxfmt passes over a text that is not TOML (`ST_UNREAD`), Bun refuses it. TODO(port): `--debug-check` (`is_same_toml`: the two
// texts have to be the same value; needs a parser of TOML values).
function tomlFormat(src: Uint8Array, len: number, set: OptionSet, out: ByteBuf): number {
  const r = formatToml(src, len, formatOptionsOf(set), out);
  if (r === R_SYNTAX && tomlSyntaxError(src, len)) {
    failSyntax(tomlSyntaxMessage(), tomlSyntaxOffset(), false);
    return set.resolved.isOxfmt ? ST_UNREAD : ST_SYNTAX;
  }
  return finish(r, out, "TOML", set);
}

// bun_format::handlebars::format (`src/format/handlebars/mod.ts`). TODO(port): `--debug-check` (`handlebars.saysTheSame`).
function handlebarsFormat(src: Uint8Array, len: number, set: OptionSet, out: ByteBuf): number {
  const r = formatHandlebars(len === src.length ? src : src.subarray(0, len), formatOptionsOf(set), out);
  if (r === R_SYNTAX_AT) setSyntaxError(messageText(refusalMessage()), refusalOffset());
  return r;
}

// TODO(port): bun_format::html::format_with (+ bun_format::html::syntax_error for the message)
function htmlFormat(name: string, src: Uint8Array, len: number, parser: number, set: OptionSet, out: ByteBuf): number {
  out.append(src, 0, len);
  return R_OK;
}

// The JavaScript / TypeScript path of `format()` (vendor/bun/src/lint/driver/fmt/mod.rs): `pragma::before_parsing`, then the file is parsed as a
// module and, if that fails, as a script (`kinds(name)`), then `range::format_with_cursor`. TODO(port): flow (`goes_to_flow`,
// `babel-flow`), `sort_imports::sorted_text`, `refusal_of_prettier` / `refusal_of_oxfmt` (parser-C), `--debug-check`.
// On a syntax error `errIsJs = true` (positions count UTF-16 units and U+2028 ends a line) and the result is ST_SYNTAX.
function scriptFormat(path: string, name: string, src: Uint8Array, len: number, set: OptionSet, out: ByteBuf): number {
  return formatScriptWith(path, name, src, len, formatOptionsOf(set), out);
}

/** `format()` for a script with the options as they are. */
function formatScriptWith(path: string, name: string, src: Uint8Array, len: number, options: FormatOptions, out: ByteBuf): number {
  const whole = len === src.length ? src : src.subarray(0, len);
  const before = pragma.beforeParsing(whole, options);
  if (before === null) {
    out.append(src, 0, len);
    cursorSlot = options.cursorOffset;
    return ST_OK;
  }
  const code = formatScript(path, name, before, options, out);
  if (code === R_OK) {
    cursorSlot = cursorResult.value;
    return ST_OK;
  }
  if (code === R_SYNTAX) return failSyntax(scriptErrorMessage(), scriptErrorOffset(), true);
  if (code === R_NESTED_TOO_DEEPLY) return failSyntax(NESTED_TOO_DEEPLY, -1, false);
  if (code === R_TOO_LONG) return failSyntax(TOO_LONG, -1, false);
  errMessage = "";
  return ST_BUG;
}

// `format_block`: Rust `FormatOptions::format_javascript`. Appends `text[start, end)` formatted as the file at `path` (code in Markdown).
// false: it cannot be, and stays as it is.
function formatBlock(path: string, text: Uint8Array, start: number, end: number, options: FormatOptions, out: ByteBuf): boolean {
  // TODO(port): `sort_imports.filter(applies_to_embedded_code)`; flow.
  const kind = kinds.kindWithOptions(path, "", false, options.flavor === 1);
  if (kind !== kinds.KIND_SCRIPT) return false;
  // `sort_imports.filter(applies_to_embedded_code)`
  const how = options.sortImports >= 0 ? sortImportsOf(options.sortImports) : null;
  if (how !== null && !how.appliesToEmbeddedCode()) {
    const copy = options.copy();
    copy.sortImports = -1;
    options = copy;
  }
  const code = text.subarray(start, end);
  const tmp = new ByteBuf(code.length + 64);
  const savedCursor = cursorSlot;
  const status = formatScriptWith(path, path, code, code.length, options, tmp);
  cursorSlot = savedCursor;
  if (status !== ST_OK) return false;
  out.append(tmp.data, 0, tmp.len);
  return true;
}

// Formats the file at `path`. See the head of this file.
export function formatFile(path: string, src: Uint8Array, len: number, set: OptionSet, out: ByteBuf): number {
  cursorSlot = -1;
  cursorText = len === src.length ? src : src.subarray(0, len);
  // What `>` of Windows PowerShell writes. Some parsers take it for UTF-8 with a NUL next to every letter.
  if (len >= 2 && (((src[0] | 0) === 0xff && (src[1] | 0) === 0xfe) || ((src[0] | 0) === 0xfe && (src[1] | 0) === 0xff))) {
    return failSyntax("This file is UTF-16. bun fmt only reads UTF-8", -1, false);
  }
  const resolved = set.resolved;
  // The name says what kind of file it is.
  const name = path;
  const kind = kinds.kindWithOptions(name, resolved.parser, resolved.toml, resolved.isOxfmt);
  if (kind === kinds.KIND_NONE && resolved.parser.length > 0) return failSyntax(cannotResolveParser(resolved.parser), -1, false);
  const parser = kinds.outParser;
  switch (kind) {
    case kinds.KIND_JSON:
      return finish(jsonFormat(path, src, len, parser, set, out), out, "JSON", set);
    case kinds.KIND_CSS:
      return finish(cssFormat(src, len, parser, set, out), out, "CSS", set);
    case kinds.KIND_YAML:
      return finish(yamlFormat(src, len, set, out), out, "YAML", set);
    case kinds.KIND_MARKDOWN:
      return finish(markdownFormat(src, len, false, set, out), out, "Markdown", set);
    case kinds.KIND_MDX:
      return finish(markdownFormat(src, len, true, set, out), out, "MDX", set);
    case kinds.KIND_GRAPHQL:
      return finish(graphqlFormat(src, len, set, out), out, "GraphQL", set);
    case kinds.KIND_TOML:
      return tomlFormat(src, len, set, out);
    case kinds.KIND_HANDLEBARS:
      return finish(handlebarsFormat(src, len, set, out), out, "Handlebars", set);
    case kinds.KIND_HTML:
      return finish(htmlFormat(name, src, len, parser, set, out), out, "HTML", set);
    default:
      break;
  }
  const r = scriptFormat(path, name, src, len, set, out);
  if (r === ST_OK && resolved.omitsFinalNewline) withoutFinalNewline(out);
  return r;
}
