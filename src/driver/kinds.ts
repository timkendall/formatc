// What kind of file a name stands for: port of `Kind`, `Language` and friends in
// vendor/bun/src/lint/driver/fmt/files.rs, with the `parser_for_path` functions of the formatters.
import * as fsx from "./fsx.ts";
import * as paths from "./paths.ts";

export const KIND_NONE = 0;
export const KIND_SCRIPT = 1;
export const KIND_JSON = 2;
export const KIND_CSS = 3;
export const KIND_YAML = 4;
export const KIND_MARKDOWN = 5;
export const KIND_MDX = 6;
export const KIND_GRAPHQL = 7;
export const KIND_HANDLEBARS = 8;
export const KIND_TOML = 9;
export const KIND_HTML = 10;

// json::Parser
export const JSON_JSON = 0;
export const JSON_JSONC = 1;
export const JSON_JSON5 = 2;
export const JSON_STRINGIFY = 3;
// css::Parser
export const CSS_CSS = 0;
export const CSS_LESS = 1;
export const CSS_SCSS = 2;
// html::Parser
export const HTML_HTML = 0;
export const HTML_ANGULAR = 1;
export const HTML_VUE = 2;
export const HTML_LWC = 3;
export const HTML_MJML = 4;
export const HTML_NG_ACTION = 5;
export const HTML_NG_BINDING = 6;
export const HTML_NG_DIRECTIVE = 7;
export const HTML_NG_INTERPOLATION = 8;

export const LANG_SUPPORTED = 0;
export const LANG_OTHER = 1;
export const LANG_UNKNOWN = 2;

// The sub-parser of the last classification (json / css / html parser).
export let outParser = 0;

function lastIndexOfDot(name: string): number {
  return name.lastIndexOf(".");
}

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

// Prettier's name for a parser -> kind. KIND_NONE if Prettier has none.
export function kindOfParser(parser: string): number {
  outParser = 0;
  switch (parser) {
    case "json":
      outParser = JSON_JSON;
      return KIND_JSON;
    case "jsonc":
      outParser = JSON_JSONC;
      return KIND_JSON;
    case "json5":
      outParser = JSON_JSON5;
      return KIND_JSON;
    case "json-stringify":
      outParser = JSON_STRINGIFY;
      return KIND_JSON;
    case "css":
      outParser = CSS_CSS;
      return KIND_CSS;
    case "less":
      outParser = CSS_LESS;
      return KIND_CSS;
    case "scss":
      outParser = CSS_SCSS;
      return KIND_CSS;
    case "html":
      outParser = HTML_HTML;
      return KIND_HTML;
    case "angular":
      outParser = HTML_ANGULAR;
      return KIND_HTML;
    case "vue":
      outParser = HTML_VUE;
      return KIND_HTML;
    case "lwc":
      outParser = HTML_LWC;
      return KIND_HTML;
    case "mjml":
      outParser = HTML_MJML;
      return KIND_HTML;
    case "__ng_action":
      outParser = HTML_NG_ACTION;
      return KIND_HTML;
    case "__ng_binding":
      outParser = HTML_NG_BINDING;
      return KIND_HTML;
    case "__ng_directive":
      outParser = HTML_NG_DIRECTIVE;
      return KIND_HTML;
    case "__ng_interpolation":
      outParser = HTML_NG_INTERPOLATION;
      return KIND_HTML;
    case "yaml":
      return KIND_YAML;
    case "markdown":
    case "remark":
      return KIND_MARKDOWN;
    case "mdx":
      return KIND_MDX;
    case "graphql":
      return KIND_GRAPHQL;
    case "glimmer":
      return KIND_HANDLEBARS;
    case "babel":
    case "babel-flow":
    case "babel-ts":
    case "flow":
    case "typescript":
    case "acorn":
    case "espree":
    case "meriyah":
    case "oxc":
    case "oxc-ts":
      return KIND_SCRIPT;
    default:
      return KIND_NONE;
  }
}

function endsWithIgnoreCase(s: string, ending: string): boolean {
  if (s.length < ending.length) return false;
  return s.substring(s.length - ending.length).toLowerCase() === ending;
}

function hasUpper(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) return true;
  }
  return false;
}

// json::parser_for_path: -1 if it is not JSON.
function jsonParserForName(name: string): number {
  // `name` is the lower-cased basename
  if (name === "package.json" || name === "package-lock.json" || name === "composer.json") return JSON_STRINGIFY;
  switch (name) {
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
      return JSON_JSON;
    default:
      break;
  }
  const dot = lastIndexOfDot(name);
  // The extension list contains two-part endings: `.json.example`, `.tfstate.backup`
  if (name.endsWith(".importmap")) return JSON_STRINGIFY;
  if (name.endsWith(".json5")) return JSON_JSON5;
  const jsonc = [".jsonc", ".code-snippets", ".code-workspace", ".sublime-build", ".sublime-color-scheme", ".sublime-commands", ".sublime-completions", ".sublime-keymap", ".sublime-macro", ".sublime-menu", ".sublime-mousemap", ".sublime-project", ".sublime-settings", ".sublime-theme", ".sublime-workspace", ".sublime_metrics", ".sublime_session"];
  for (let i = 0; i < jsonc.length; i++) if (name.endsWith(jsonc[i])) return JSON_JSONC;
  const json = [".json", ".avsc", ".geojson", ".gltf", ".har", ".ice", ".json.example", ".mcmeta", ".sarif", ".slnlaunch", ".tact", ".tfstate", ".tfstate.backup", ".topojson", ".webapp", ".webmanifest", ".yy", ".yyp"];
  for (let i = 0; i < json.length; i++) if (name.endsWith(json[i])) return JSON_JSON;
  if (dot < 0) return -1;
  return -1;
}

function cssParserForName(name: string): number {
  if (endsWithIgnoreCase(name, ".scss")) return CSS_SCSS;
  if (endsWithIgnoreCase(name, ".css") || endsWithIgnoreCase(name, ".wxss") || endsWithIgnoreCase(name, ".pcss") || endsWithIgnoreCase(name, ".postcss")) return CSS_CSS;
  if (endsWithIgnoreCase(name, ".less")) return CSS_LESS;
  return -1;
}

function isYamlName(lower: string): boolean {
  switch (lower) {
    case ".clang-format":
    case ".clang-tidy":
    case ".clangd":
    case ".gemrc":
    case "citation.cff":
    case "glide.lock":
    case "pixi.lock":
    case ".prettierrc":
    case ".stylelintrc":
    case ".lintstagedrc":
      return true;
    default:
      break;
  }
  const ext = [".yml", ".mir", ".reek", ".rviz", ".sublime-syntax", ".syntax", ".yaml", ".yaml-tmlanguage", ".yaml.sed", ".yml.mysql"];
  for (let i = 0; i < ext.length; i++) if (lower.endsWith(ext[i])) return true;
  return false;
}

function isMarkdownName(lower: string): boolean {
  if (lower === "contents.lr" || lower === "readme") return true;
  const ext = [".md", ".livemd", ".markdown", ".mdown", ".mdwn", ".mkd", ".mkdn", ".mkdown", ".ronn", ".scd", ".workbook"];
  for (let i = 0; i < ext.length; i++) if (lower.endsWith(ext[i])) return true;
  return false;
}

function htmlParserForName(lower: string): number {
  if (lower.endsWith(".component.html")) return HTML_ANGULAR;
  const html = [".html", ".hta", ".htm", ".html.hl", ".inc", ".xht", ".xhtml"];
  for (let i = 0; i < html.length; i++) if (lower.endsWith(html[i])) return HTML_HTML;
  if (lower.endsWith(".mjml")) return HTML_MJML;
  if (lower.endsWith(".vue")) return HTML_VUE;
  return -1;
}

// `Kind::of(path, parser)`. KIND_NONE if there is none. `parser` is "" when not set.
export function kindOf(path: string, parser: string): number {
  outParser = 0;
  if (parser.length > 0) return kindOfParser(parser);
  const base = paths.basename(path);
  const name = hasUpper(base) ? base.toLowerCase() : base;
  const dot = lastIndexOfDot(name);
  const extension = dot < 0 ? "" : name.substring(dot + 1);
  switch (extension) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
    case "wxs":
      return KIND_SCRIPT;
    default:
      break;
  }
  if (name.endsWith(".js.flow") || isJavascriptByAnotherName(name, extension) || name === "jakefile") return KIND_SCRIPT;
  const j = jsonParserForName(name);
  if (j >= 0) {
    outParser = j;
    return KIND_JSON;
  }
  const c = cssParserForName(name);
  if (c >= 0) {
    outParser = c;
    return KIND_CSS;
  }
  if (isYamlName(name)) return KIND_YAML;
  if (isMarkdownName(name)) return KIND_MARKDOWN;
  if (name.length >= 4 && name.endsWith(".mdx")) return KIND_MDX;
  if (name.endsWith(".graphql") || name.endsWith(".gql") || name.endsWith(".graphqls")) return KIND_GRAPHQL;
  if (name.endsWith(".hbs") || name.endsWith(".handlebars")) return KIND_HANDLEBARS;
  const h = htmlParserForName(name);
  if (h >= 0) {
    outParser = h;
    return KIND_HTML;
  }
  return KIND_NONE;
}

export function isToml(path: string): boolean {
  const name = paths.basename(path);
  if (name.endsWith(".toml") && name.length > 5) return true;
  return name === "Pipfile" || name === "Cargo.toml.orig" || name.endsWith(".toml.example");
}

// `Kind::with_options`: `parser` is the option (or ""), `toml` whether TOML is formatted in Prettier's flavor, `isOxfmt` the
// flavor.
export function kindWithOptions(path: string, parser: string, toml: boolean, isOxfmt: boolean): number {
  // No configuration file of oxfmt has `parser`. Its tests do.
  if (!isOxfmt || parser.length > 0) {
    const k = kindOf(path, parser);
    if (k !== KIND_NONE) return k;
    if (toml && parser.length === 0 && isToml(path)) return KIND_TOML;
    return KIND_NONE;
  }
  return classifyForOxfmt(path);
}

// `EXCLUDE_FILENAMES` of oxfmt: what a tool has written, and is never formatted.
function isLeftAloneByOxfmt(path: string): boolean {
  switch (paths.basename(path)) {
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

// oxfmt's `classify_file_kind`. Unlike Prettier it tells upper case from lower case.
export function classifyForOxfmt(path: string): number {
  outParser = 0;
  const name = paths.basename(path);
  // `Path::extension`: a name that starts with its only dot has none.
  const dot = name.lastIndexOf(".");
  const extension = dot <= 0 ? "" : name.substring(dot + 1);
  const isScript = extension === "js" || extension === "mjs" || extension === "cjs" || extension === "jsx" || extension === "ts" || extension === "mts" || extension === "cts" || extension === "tsx";
  if (!isScript && isLeftAloneByOxfmt(path)) return KIND_NONE;
  if (isScript || isJavascriptByAnotherName(name, extension)) return KIND_SCRIPT;
  if (isToml(path)) return KIND_TOML;
  switch (name) {
    case "package.json":
    case "composer.json":
      outParser = JSON_STRINGIFY;
      return KIND_JSON;
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
      outParser = JSON_JSON;
      return KIND_JSON;
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
      return KIND_YAML;
    case "contents.lr":
    case "README":
      return KIND_MARKDOWN;
    default:
      break;
  }
  if (extension === "mdx") return KIND_MDX;
  if (name.endsWith(".json.example") || name.endsWith(".tfstate.backup")) {
    outParser = JSON_JSON;
    return KIND_JSON;
  }
  if (name.endsWith(".component.html")) {
    outParser = HTML_ANGULAR;
    return KIND_HTML;
  }
  switch (extension) {
    case "importmap":
      outParser = JSON_STRINGIFY;
      return KIND_JSON;
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
      outParser = JSON_JSON;
      return KIND_JSON;
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
      outParser = JSON_JSONC;
      return KIND_JSON;
    case "json5":
      outParser = JSON_JSON5;
      return KIND_JSON;
    case "graphql":
    case "gql":
    case "graphqls":
      return KIND_GRAPHQL;
    case "css":
    case "wxss":
    case "pcss":
    case "postcss":
      outParser = CSS_CSS;
      return KIND_CSS;
    case "scss":
      outParser = CSS_SCSS;
      return KIND_CSS;
    case "less":
      outParser = CSS_LESS;
      return KIND_CSS;
    case "yml":
    case "mir":
    case "reek":
    case "rviz":
    case "sublime-syntax":
    case "syntax":
    case "yaml":
    case "yaml-tmlanguage":
      return KIND_YAML;
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
      return KIND_MARKDOWN;
    case "html":
    case "hta":
    case "htm":
    case "inc":
    case "xht":
    case "xhtml":
      outParser = HTML_HTML;
      return KIND_HTML;
    case "vue":
      outParser = HTML_VUE;
      return KIND_HTML;
    case "mjml":
      outParser = HTML_MJML;
      return KIND_HTML;
    case "handlebars":
    case "hbs":
      return KIND_HANDLEBARS;
    default:
      return KIND_NONE;
  }
}

// Whether oxfmt takes the file at `path` for a component of Svelte.
export function isSvelteForOxfmt(path: string): boolean {
  const name = paths.basename(path);
  return name.endsWith(".svelte") && name.length > 7;
}

// The same for oxfmt, which also has TOML and, if `formatsSvelte`, Svelte (as `LANG_OTHER`).
export function languageForOxfmt(path: string, formatsSvelte: boolean): number {
  if (classifyForOxfmt(path) !== KIND_NONE) return LANG_SUPPORTED;
  if (formatsSvelte && isSvelteForOxfmt(path)) return LANG_OTHER;
  return LANG_UNKNOWN;
}

// Prettier's `getLanguageByInterpreter`: the parser for a file whose name has no `.`, by its first line. "" if none.
export function parserByInterpreter(path: string): string {
  const base = paths.basename(path);
  if (base.indexOf(".") >= 0 || kindOf(path, "") !== KIND_NONE) return "";
  const start = fsx.readStart(path, 256);
  const nl = start.indexOf("\n");
  const line = nl < 0 ? start : start.substring(0, nl);
  let inBin: string;
  if (line.startsWith("#!/usr/local/bin/")) inBin = line.substring(17);
  else if (line.startsWith("#!/usr/bin/")) inBin = line.substring(11);
  else if (line.startsWith("#!/bin/")) inBin = line.substring(7);
  else return "";
  const word = (text: string): number => {
    let i = 0;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 32 || (c >= 9 && c <= 13)) break;
      i = i + 1;
    }
    return i;
  };
  let rest = inBin;
  if (inBin.startsWith("env")) {
    const after = inBin.substring(3);
    if (!line.startsWith("#!/usr/local/") && word(after) === 0) {
      const trimmed = after.replace(/^[ \t\n\r\f]+/, "");
      if (trimmed.length > 0) rest = trimmed;
    }
  }
  const w = rest.substring(0, word(rest));
  switch (w) {
    case "bun":
    case "chakra":
    case "d8":
    case "deno":
    case "gjs":
    case "js":
    case "node":
    case "nodejs":
    case "qjs":
    case "rhino":
    case "v8":
    case "v8-shell":
    case "zx":
      return "babel";
    case "ts-node":
    case "tsx":
      return "typescript";
    default:
      return "";
  }
}

// `language_of(path)`: whether Bun formats it, Prettier would with a plugin, or there is no parser.
export function languageOf(path: string): number {
  if (kindOf(path, "") !== KIND_NONE) return LANG_SUPPORTED;
  const name = paths.basename(path);
  if (name === ".prettierrc" || name === ".lintstagedrc" || name === ".stylelintrc" || name === ".clang-format") return LANG_OTHER;
  return LANG_UNKNOWN;
}

// Minified code and lock files, which a tool wrote and nobody wants reformatted.
export function isGenerated(path: string): boolean {
  const name = paths.basename(path);
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
    case "npm-shrinkwrap.json":
    case "glide.lock":
    case "pixi.lock":
      return true;
    default:
      break;
  }
  return name.endsWith(".min.js") || name.endsWith(".min.mjs") || name.endsWith(".min.cjs") || name.endsWith(".min.css");
}

// `.svelte` of `src/a.svelte`. The name of a file that has no ending.
export function endingOf(path: string): string {
  const name = paths.basename(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.substring(dot);
}
