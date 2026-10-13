// `format_for_tests` of vendor/bun/src/lint/driver/fmt/mod.rs: THE plug-in point of the language formatters for the
// conformance runner (tools/conformance.ts). It picks the formatter by `options.parser` or by the name of the file,
// as `format()` of the Rust driver does.
//
//   formatForTests(path, text, options): FormatOutcome { status, output, cursor }
//
// - `path`: what the name of the file decides (`a.ts`, `snippet.json`); `options.filepath`, if set, wins.
// - `text`: the bytes of the file (a byte order mark and line endings are part of it).
// - `options`: a `FormatOptions` (not changed: the function works on a copy).
// - `status`: FT_OK (`output` is the formatted text), FT_SYNTAX (the input is rejected: Rust `Failure::Syntax` or
//   `Unread`), FT_BUG (the formatter could not print it, or `FormatError::InvalidDocument`), FT_NOT_PORTED (nobody has
//   plugged this language in yet: the runner counts the case as "not ported", not as a failure).
// - `cursor`: where `options.cursorOffset` ends up in `output`, in UTF-16 code units; -1 for nowhere.
//
// HOW A PORTER ENABLES A LANGUAGE (one place, three steps; each language has a function `run<Lang>` below):
//   1. Add (or uncomment) the static import of `src/format/<lang>/mod.ts` in the block "the languages" below. scriptc
//      needs static imports, so nothing is imported until the language exists.
//   2. In `run<Lang>`, delete `return NOT_PORTED;` and call the formatter. It appends the formatted text to `out` and
//      returns one of the FORMAT_* codes of `src/format/errors.ts` (0 ok, 1 or 2 syntax error, 3 nested too deeply,
//      4 too long, 5 invalid document). The signature in the comment of each function is the one that the Rust crate has
//      (minus the scratch, which lives in the module); change the adapter if your module has another.
//   3. Run `node tools/conformance.ts --languages=<dir>` (the directories of Prettier's tests: json, css, less, scss,
//      graphql, yaml, markdown, mdx, handlebars, html, vue, angular, lwc, mjml, js, jsx, typescript, flow, misc).
//      A language whose `run<Lang>` still returns NOT_PORTED is reported as "not ported", never as a failure.
// If your language places a cursor (`options.cursorOffset`; HTML does, the others get it from `cursor.rs`), call
// `setCursor(n)` before you return.
//
// The code blocks of Markdown and the scripts of HTML are formatted by `options.formatJavascript` (Rust
// `format_javascript`): `formatForTests` sets it to `formatBlock` below, which calls `formatInner` again.
//
// src/driver/dispatch.ts (owned by the driver agent, not edited here) is the same switch for the real path; when you
// enable a language here, make its `TODO(port)` function there call the same module.
import { ByteBuf } from "../../base/bytebuf.ts";
import { FORMAT_OK } from "../errors.ts";
import { FLAVOR_OXFMT, FormatOptions } from "../options.ts";
import * as pragma from "../pragma.ts";
import * as kinds from "../../driver/kinds.ts";
import * as paths from "../../driver/paths.ts";

// ---------------------------------------------------------------------------------------------- the languages
// Uncomment / add the import of your language here (step 1):
//
import * as json from "../json/mod.ts";
import * as css from "../css/mod.ts";
import * as yaml from "../yaml/mod.ts";
import * as markdown from "../markdown/mod.ts";
import * as graphql from "../graphql/mod.ts";
import * as toml from "../toml/mod.ts";
import * as handlebars from "../handlebars/mod.ts";
import * as html from "../html/mod.ts";
import { formatScript } from "../js/script.ts";
import { cursorInFormattedText, cursorResult } from "../cursor.ts";

// What `run<Lang>` returns for a language that nobody has plugged in.
export const NOT_PORTED = -1;

export const FT_OK = 0;
export const FT_SYNTAX = 1;
export const FT_BUG = 2;
export const FT_NOT_PORTED = 3;

export class FormatOutcome {
  status: number;
  output: Uint8Array;
  cursor: number;
  constructor(status: number, output: Uint8Array, cursor: number) {
    this.status = status;
    this.output = output;
    this.cursor = cursor;
  }
}

// Where the cursor of the last formatted text ended up (-1: nowhere). Set by the language through `setCursor`.
let cursorSlot = -1;

export function setCursor(utf16Offset: number): void {
  cursorSlot = utf16Offset;
}

const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------------------------------------- one run<Lang> per language

// bun_format::json::format (and json::sort_package_json when `options.sortPackageJson` is set and the file is a
// `package.json`: TODO(port) for the json porter), `parser`: kinds.JSON_*
function runJson(text: Uint8Array, parser: number, name: string, options: FormatOptions, out: ByteBuf): number {
  return json.formatJson(text, text.length, parser, options, out);
}

// bun_format::css::format, `parser`: kinds.CSS_*
function runCss(text: Uint8Array, parser: number, options: FormatOptions, out: ByteBuf): number {
  return css.format(text, parser, options, out);
}

// bun_format::yaml::format
function runYaml(text: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  return yaml.format(text, options, out);
}

// bun_format::markdown::format_with / format_mdx_with. Its code blocks are formatted through `options.formatJavascript`.
function runMarkdown(text: Uint8Array, isMdx: boolean, options: FormatOptions, out: ByteBuf): number {
  return isMdx ? markdown.formatMdx(text, options, out) : markdown.format(text, options, out);
}

// bun_format::graphql::format
function runGraphql(text: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  return graphql.format(text, options, out);
}

// bun_format::toml::format (only oxfmt's flavor, or `options.toml`, gets here)
function runToml(text: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  return toml.formatToml(text, text.length, options, out);
}

// bun_format::handlebars::format
function runHandlebars(text: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  return handlebars.format(text, options, out);
}

// bun_format::html::format_with (name: the name of the file; `parser`: kinds.HTML_*). The Rust version also gets a
// `parse_javascript` for the scripts in HTML: TODO(port) for the html porter (add a field to FormatOptions or a
// parameter here). It places the cursor itself (`setCursor`).
function runHtml(name: string, text: Uint8Array, parser: number, options: FormatOptions, out: ByteBuf): number {
  const r = html.format(name, text, parser, options, out);
  setCursor(html.lastCursor());
  return r;
}

// The JavaScript / TypeScript path of `format()` from `pragma::before_parsing` on. TODO(port) for js-core:
// `beforeScriptParsing` (below) is the pragma step, then `babel` hands a file of Flow to `babel-flow`
// (`goes_to_flow`, `flow::goes_to_babel`, `flow::may_have_comment_types`, `flow::uncommented`), then `kinds(name)` --
// module, then script (a `.mjs`/`.mts` is a module only, a `.cjs`/`.cts` a script only); the first syntax error is the
// one that counts -- then parse, bind, sort imports (`sort_imports::sorted_text`), `refusal_of_prettier` /
// `refusal_of_oxfmt` (`formatsWhatHasErrors`: only the oxfmt flavor reads it) and `range::format_with_cursor`. Set the
// cursor with `setCursor`. `path` is what the parser sees, `name` what decides the language (`options.filepath` or
// `path`).
function runScript(path: string, name: string, text: Uint8Array, options: FormatOptions, out: ByteBuf, formatsWhatHasErrors: boolean): number {
  const before = beforeScriptParsing(text, options, out);
  if (before === null) return FORMAT_OK;
  void formatsWhatHasErrors;
  const code = formatScript(path, name, before, options, out);
  if (code === FORMAT_OK) cursorSlot = cursorResult.value;
  return code;
}

// `pragma::before_parsing` of `format()`: null if the file is to be left as it is (`LeaveAsItIs`: `out` has its text
// and the cursor is where it was); otherwise the text to parse.
export function beforeScriptParsing(text: Uint8Array, options: FormatOptions, out: ByteBuf): Uint8Array | null {
  const before = pragma.beforeParsing(text, options);
  if (before === null) {
    out.appendAll(text);
    cursorSlot = options.cursorOffset;
  }
  return before;
}


// ---------------------------------------------------------------------------------------------- what kind of file

function isJavascriptByAnotherName(name: string, extension: string): boolean {
  switch (extension) {
    case "_js":
    case "bones":
    case "es":
    case "es6":
    case "gs":
    case "jake":
    case "javascript":
    case "jsb":
    case "jscad":
    case "jsfl":
    case "jslib":
    case "jsm":
    case "jspre":
    case "jss":
    case "njs":
    case "pac":
    case "sjs":
    case "ssjs":
    case "xsjs":
    case "xsjslib":
      return true;
    default:
      break;
  }
  return name === "Jakefile" || name === "start.frag" || name === "end.frag" || name.endsWith(".start.frag") || name.endsWith(".end.frag");
}

function isLeftAloneByOxfmt(name: string): boolean {
  switch (name) {
    case "package-lock.json":
    case "pnpm-lock.yaml":
    case "yarn.lock":
    case "MODULE.bazel.lock":
    case "bun.lock":
    case "deno.lock":
    case "composer.lock":
    case "Package.resolved":
    case "Pipfile.lock":
    case "flake.lock":
    case "mcmod.info":
    case "Cargo.lock":
    case "Gopkg.lock":
    case "pdm.lock":
    case "poetry.lock":
    case "uv.lock":
      return true;
    default:
      return false;
  }
}

// The sub-parser (kinds.JSON_*, CSS_*, HTML_*) of the last `classify`.
let subParser = 0;

// oxfmt's `classify_file_kind` (`classify_for_oxfmt` of files.rs). Unlike Prettier it tells upper case from lower case.
function classifyForOxfmt(path: string): number {
  subParser = 0;
  const name = paths.basename(path);
  const dot = name.lastIndexOf(".");
  // `Path::extension`: a name that starts with its only dot has none.
  const extension = dot <= 0 ? "" : name.substring(dot + 1);
  const isScript = extension === "js" || extension === "mjs" || extension === "cjs" || extension === "jsx" || extension === "ts" || extension === "mts" || extension === "cts" || extension === "tsx";
  if (!isScript && isLeftAloneByOxfmt(name)) return kinds.KIND_NONE;
  if (isScript || isJavascriptByAnotherName(name, extension)) return kinds.KIND_SCRIPT;
  if (kinds.isToml(path)) return kinds.KIND_TOML;
  // By the name.
  switch (name) {
    case "package.json":
    case "composer.json":
      subParser = kinds.JSON_STRINGIFY;
      return kinds.KIND_JSON;
    case ".all-contributorsrc":
    case ".arcconfig":
    case ".auto-changelog":
    case ".c8rc":
    case ".htmlhintrc":
    case ".imgbotconfig":
    case ".nycrc":
    case ".tern-config":
    case ".tern-project":
    case ".watchmanconfig":
    case ".babelrc":
    case ".jscsrc":
    case ".jshintrc":
    case ".jslintrc":
    case ".swcrc":
      subParser = kinds.JSON_JSON;
      return kinds.KIND_JSON;
    case ".prettierrc":
    case ".stylelintrc":
    case ".lintstagedrc":
    case ".clang-format":
    case ".clang-tidy":
    case ".clangd":
    case ".gemrc":
    case "CITATION.cff":
    case "glide.lock":
    case "pixi.lock":
      return kinds.KIND_YAML;
    case "contents.lr":
    case "README":
      return kinds.KIND_MARKDOWN;
    default:
      break;
  }
  // It hands MDX to the Prettier that comes with it.
  if (extension === "mdx") return kinds.KIND_MDX;
  // By the ending.
  if (name.endsWith(".json.example") || name.endsWith(".tfstate.backup")) {
    subParser = kinds.JSON_JSON;
    return kinds.KIND_JSON;
  }
  if (name.endsWith(".component.html")) {
    subParser = kinds.HTML_ANGULAR;
    return kinds.KIND_HTML;
  }
  // By the extension.
  switch (extension) {
    case "importmap":
      subParser = kinds.JSON_STRINGIFY;
      return kinds.KIND_JSON;
    case "json":
    case "4DForm":
    case "4DProject":
    case "avsc":
    case "geojson":
    case "gltf":
    case "har":
    case "ice":
    case "JSON-tmLanguage":
    case "mcmeta":
    case "sarif":
    case "tact":
    case "tfstate":
    case "topojson":
    case "webapp":
    case "webmanifest":
    case "yy":
    case "yyp":
      subParser = kinds.JSON_JSON;
      return kinds.KIND_JSON;
    case "jsonc":
    case "code-snippets":
    case "code-workspace":
    case "sublime-build":
    case "sublime-color-scheme":
    case "sublime-commands":
    case "sublime-completions":
    case "sublime-keymap":
    case "sublime-macro":
    case "sublime-menu":
    case "sublime-mousemap":
    case "sublime-project":
    case "sublime-settings":
    case "sublime-theme":
    case "sublime-workspace":
    case "sublime_metrics":
    case "sublime_session":
      subParser = kinds.JSON_JSONC;
      return kinds.KIND_JSON;
    case "json5":
      subParser = kinds.JSON_JSON5;
      return kinds.KIND_JSON;
    case "graphql":
    case "gql":
    case "graphqls":
      return kinds.KIND_GRAPHQL;
    case "css":
    case "wxss":
    case "pcss":
    case "postcss":
      subParser = kinds.CSS_CSS;
      return kinds.KIND_CSS;
    case "scss":
      subParser = kinds.CSS_SCSS;
      return kinds.KIND_CSS;
    case "less":
      subParser = kinds.CSS_LESS;
      return kinds.KIND_CSS;
    case "yml":
    case "mir":
    case "reek":
    case "rviz":
    case "sublime-syntax":
    case "syntax":
    case "yaml":
    case "yaml-tmlanguage":
      return kinds.KIND_YAML;
    case "md":
    case "livemd":
    case "markdown":
    case "mdown":
    case "mdwn":
    case "mkd":
    case "mkdn":
    case "mkdown":
    case "ronn":
    case "scd":
    case "workbook":
      return kinds.KIND_MARKDOWN;
    case "html":
    case "hta":
    case "htm":
    case "inc":
    case "xht":
    case "xhtml":
      subParser = kinds.HTML_HTML;
      return kinds.KIND_HTML;
    case "vue":
      subParser = kinds.HTML_VUE;
      return kinds.KIND_HTML;
    case "mjml":
      subParser = kinds.HTML_MJML;
      return kinds.KIND_HTML;
    case "handlebars":
    case "hbs":
      return kinds.KIND_HANDLEBARS;
    default:
      return kinds.KIND_NONE;
  }
}

// `Kind::with_options`: the kind of the file `name` as `options` have it. KIND_NONE: there is none.
function classify(name: string, options: FormatOptions): number {
  // No configuration file of oxfmt has `parser`. Its tests do.
  if (options.flavor !== FLAVOR_OXFMT || options.parser.length > 0) {
    const k = kinds.kindWithOptions(name, options.parser, options.toml, false);
    subParser = kinds.outParser;
    return k;
  }
  return classifyForOxfmt(name);
}

// ---------------------------------------------------------------------------------------------- format()

// A FORMAT_* code of a language -> FT_*.
function statusOf(r: number): number {
  if (r === FORMAT_OK) return FT_OK;
  if (r === NOT_PORTED) return FT_NOT_PORTED;
  // 1 SyntaxError, 2 SyntaxErrorAt, 3 NestedTooDeeply, 4 TooLong: `Failure::Syntax`
  if (r >= 1 && r <= 4) return FT_SYNTAX;
  return FT_BUG;
}

// The formatted text of the file at `path`: `format()` of the Rust driver without the checks of `--debug-check`
// (`verifies` is false in the tests) and without the end-of-final-newline option. Appends to `out`.
function formatInner(path: string, text: Uint8Array, options: FormatOptions, out: ByteBuf, formatsWhatHasErrors: boolean): number {
  // What `>` of Windows PowerShell writes. Some parsers take it for UTF-8 with a NUL next to every letter.
  if (text.length >= 2 && ((text[0] === 0xff && text[1] === 0xfe) || (text[0] === 0xfe && text[1] === 0xff))) return FT_SYNTAX;
  // The name says what kind of file it is. Whether it is TypeScript is up to `path`.
  const name = options.filepath.length > 0 ? options.filepath : path;
  const kind = classify(name, options);
  const parser = subParser;
  if (kind === kinds.KIND_NONE && options.parser.length > 0) return FT_SYNTAX;
  let r = FORMAT_OK;
  switch (kind) {
    case kinds.KIND_JSON:
      r = runJson(text, parser, name, options, out);
      break;
    case kinds.KIND_CSS:
      r = runCss(text, parser, options, out);
      break;
    case kinds.KIND_YAML:
      r = runYaml(text, options, out);
      break;
    case kinds.KIND_MARKDOWN:
      r = runMarkdown(text, false, options, out);
      break;
    case kinds.KIND_MDX:
      r = runMarkdown(text, true, options, out);
      break;
    case kinds.KIND_GRAPHQL:
      r = runGraphql(text, options, out);
      break;
    case kinds.KIND_TOML:
      r = runToml(text, options, out);
      break;
    case kinds.KIND_HANDLEBARS:
      r = runHandlebars(text, options, out);
      break;
    case kinds.KIND_HTML:
      r = runHtml(name, text, parser, options, out);
      break;
    default:
      // JavaScript, TypeScript, or a name that says nothing: a script.
      return statusOf(runScript(path, name, text, options, out, formatsWhatHasErrors));
  }
  const status = statusOf(r);
  // `finish`: the cursor of what is not a script (HTML and the scripts have placed it already).
  if (status === FT_OK && kind !== kinds.KIND_HTML && options.cursorOffset >= 0) {
    cursorSlot = cursorInFormattedText(text, options, out.view());
  }
  return status;
}

// `format_block`: Rust `FormatOptions::format_javascript`. Appends `text[start, end)` formatted as the file at `path`.
// false: it cannot be, and stays as it is.
function formatBlock(path: string, text: Uint8Array, start: number, end: number, options: FormatOptions, out: ByteBuf): boolean {
  // TODO(port): `sort_imports.filter(applies_to_embedded_code)` for the js porter of `sortImports`.
  const o = options.copy();
  const tmp = new ByteBuf(end - start + 64);
  const saved = cursorSlot;
  const status = formatInner(path, text.subarray(start, end), o, tmp, false);
  cursorSlot = saved;
  if (status !== FT_OK) return false;
  out.append(tmp.data, 0, tmp.len);
  return true;
}

// The text of the file at `path` formatted with `options`, the way `bun fmt` does it, and where the cursor ends up.
// For the tests of the formatter.
export function formatForTests(path: string, text: Uint8Array, options: FormatOptions): FormatOutcome {
  const o = options.copy();
  o.formatJavascript = formatBlock;
  const out = new ByteBuf(text.length + 64);
  cursorSlot = -1;
  const status = formatInner(path, text, o, out, true);
  if (status !== FT_OK) return new FormatOutcome(status, EMPTY, -1);
  return new FormatOutcome(FT_OK, out.view(), cursorSlot);
}
