// Port of vendor/bun/src/format/conformance/prettier.rs: Prettier's own tests.
//
// For every fixture and every set of options, Prettier's test runner
// (`tests/config/format-test/run-test.js`) checks
// - the output against a snapshot, or that the parser rejects the input,
// - that formatting the output again changes nothing,
// - that the output is the same if the lines of the input end with CRLF or with CR,
// - that a byte order mark in front of the input is in front of the output and changes nothing else.
//
// So does this. The message of a syntax error is not compared. All texts are byte strings (see lib.ts).
import { FormatOptions, LINE_ENDING_AUTO } from "../options.ts";
import { FT_NOT_PORTED, FT_OK, FT_SYNTAX } from "./dispatch.ts";
import {
  Bundle,
  Count,
  FormatResult,
  Flags,
  failureText,
  isValidUtf8,
  outputLine,
  percent,
  replaceAll,
  runFormat,
  setMock,
  showCursor,
  sortedKeys,
  trimAscii,
  trimAsciiStart,
  trimSet,
  utf16Length,
} from "./lib.ts";

const PROPOSAL = "syntax of a proposal at stage 2 or below, which only Babel parses";
const BABEL_TS = "an input that Prettier's `typescript` parser rejects: the snapshot is made with `babel-ts`";
const ONLY_BABEL_TS_REJECTS = "an input that only `babel-ts` rejects: Prettier's `typescript` parser accepts it, and the output is the same";
const HTML_LIKE_COMMENT =
  "`babel` rejects HTML-like comments, but the snapshots of js/comments/html-like and of jsx/jsx-test-suite, made with `acorn`, have them formatted";
const PLUGIN = "formatted by a plugin of Prettier";
const NOT_PORTED_REASON = "not ported yet";

// What is not run, and why. A case is left out if its path contains the text.
const EXCLUDED_PATHS: string[] = [];
const EXCLUDED_REASONS: string[] = [];

function exclude(path: string, reason: string): void {
  EXCLUDED_PATHS.push(path);
  EXCLUDED_REASONS.push(reason);
}

exclude("js/arrows-bind", PROPOSAL);
exclude("js/async-do-expressions", PROPOSAL);
exclude("js/bind-expressions", PROPOSAL);
exclude("js/comments-pipeline-own-line", PROPOSAL);
exclude("js/discard-binding", PROPOSAL);
exclude("js/do/", PROPOSAL);
exclude("jsx/do/", PROPOSAL);
exclude("js/export-default/export-default-from", PROPOSAL);
exclude("js/export-default/escaped", PROPOSAL);
exclude("js/module-blocks", PROPOSAL);
exclude("valid-module-block-top-level", PROPOSAL);
exclude("js/no-semi-babylon-extensions", PROPOSAL);
exclude("js/objects/expression.js", PROPOSAL);
exclude("js/partial-application", PROPOSAL);
exclude("js/pipeline-operator", PROPOSAL);
exclude("js/throw_expressions", PROPOSAL);
exclude("js/v8_intrinsic", PROPOSAL);
exclude("js/babel-plugins/async-do-expressions", PROPOSAL);
exclude("js/babel-plugins/discard-binding", PROPOSAL);
exclude("js/babel-plugins/do-expressions", PROPOSAL);
exclude("js/babel-plugins/export-default-from", PROPOSAL);
exclude("js/babel-plugins/function-bind", PROPOSAL);
exclude("js/babel-plugins/function-sent", PROPOSAL);
exclude("js/babel-plugins/module-blocks", PROPOSAL);
exclude("js/babel-plugins/partial-application", PROPOSAL);
exclude("js/babel-plugins/pipeline-operator", PROPOSAL);
exclude("js/babel-plugins/throw-expressions", PROPOSAL);
exclude("js/babel-plugins/v8intrinsic", PROPOSAL);
exclude("typescript/definite/definite.ts", BABEL_TS);
exclude("typescript/definite/without-annotation.ts", BABEL_TS);
exclude("misc/front-matter/with-plugins", PLUGIN);
exclude("handlebars/front-matter/toml", PLUGIN);
exclude("misc/plugins/embed-async-printer", PLUGIN);
exclude("vue/with-plugins", PLUGIN);
exclude("js/_errors_/html-like-comments.js", HTML_LIKE_COMMENT);
exclude("jsx/jsx-test-suite/rejected-snippets/0/0006-e58e.jsx", HTML_LIKE_COMMENT);
exclude("jsx/jsx-test-suite/rejected-snippets/1/0006-e58e.jsx", HTML_LIKE_COMMENT);
exclude("typescript/_errors_/babel-ts2/multiline-declaration-abstract-class.ts", ONLY_BABEL_TS_REJECTS);
exclude("typescript/_errors_/babel-ts2/multiline-declaration-interface.ts", ONLY_BABEL_TS_REJECTS);
exclude("typescript/_errors_/babel-ts2/multiline-declaration-module.ts", ONLY_BABEL_TS_REJECTS);
exclude("typescript/_errors_/babel-ts2/parenthesized-decorators-tagged-template.ts", ONLY_BABEL_TS_REJECTS);

// Formatting their output again changes it, in Prettier too: `unstableTests` of
// `tests/config/format-test/failed-format-tests.js`.
const UNSTABLE: string[] = [
  "js/ignore/semi/class-expression-decorator.js",
  "js/ignore/semi/head-ignored.js",
  "js/comments/return-statement.js",
  "js/comments/tagged-template-literal.js",
  "js/multiparser-markdown/codeblock.js",
  "typescript/prettier-ignore/mapped-types.ts",
  "typescript/prettier-ignore/issue-14238.ts",
  "js/for-of/comments.js",
  "js/sequence-expression/parenthesized.js",
  "typescript/satisfies-operators/comments-unstable.ts",
  "jsx/comments/in-attributes.js",
  "typescript/import-type/long-module-name/long-module-name4.ts",
  "typescript/method-chain/object/issue-17239.ts",
  "typescript/call/callee-comments.ts",
  "js/arrows/arrow-chain-with-trailing-comments.js",
  "typescript/as/comments/18160.ts",
  "js/sequence-expression/parenthesized-trailing-comment-unstable.js",
  "typescript/union/consistent-with-flow/single-type.ts",
];

const CURSOR = "<|>";
const RANGE_START = "<<<PRETTIER_RANGE_START>>>";
const RANGE_END = "<<<PRETTIER_RANGE_END>>>";
const BOM = "\xEF\xBB\xBF";
const SNAPSHOT = "/__snapshots__/format.test.js.snap";

// A fixture with a set of options.
class Case {
  // `arrow.js`, `snippet: #0`
  name: string;
  // `name: value`, without `parsers`.
  optionNames: string[] = [];
  optionValues: string[] = [];
  // The first is the one that the snapshot is made with.
  parsers: string[] = [];
  input: string = "";
  // `expected` of the Rust enum: an output, or the parsers that reject the input (empty: the only one there is).
  hasOutput: boolean = false;
  output: string = "";
  errorParsers: string[] = [];
  // The parsers that reject an input of which there is an output.
  rejectedBy: string[] = [];
  constructor(name: string) {
    this.name = name;
  }
}

function contains(list: string[], s: string): boolean {
  for (let i = 0; i < list.length; i++) if (list[i] === s) return true;
  return false;
}

// What `` ` `` quotes in a snapshot file.
function unescape(text: string): string {
  let at = text.indexOf("\\");
  if (at < 0) return text;
  const parts: string[] = [];
  let from = 0;
  const n = text.length;
  while (at >= 0) {
    parts.push(text.substring(from, at));
    // The byte after the backslash is the byte (a backslash at the very end is nothing).
    if (at + 1 < n) parts.push(text.charAt(at + 1));
    from = at + 2;
    at = from < n ? text.indexOf("\\", from) : -1;
  }
  if (from < n) parts.push(text.substring(from));
  return parts.join("");
}

// `====title====`, 80 wide.
function isSeparator(line: string, title: string): boolean {
  return line.length === 80 && line.startsWith("=") && line.endsWith("=") && trimSet(line, "=") === title;
}

// The text that a code frame shows: `> 1 | text`, with lines of `^` in between.
function textOfCodeFrame(frame: string[]): string {
  const lines: string[] = [];
  for (let i = 0; i < frame.length; i++) {
    const line = frame[i];
    const bar = line.indexOf("|");
    if (bar < 0) continue;
    const gutter = line.substring(0, bar);
    let hasDigit = false;
    for (let k = 0; k < gutter.length; k++) {
      const c = gutter.charCodeAt(k);
      if (c >= 48 && c <= 57) hasDigit = true;
    }
    if (!hasDigit) continue;
    const text = line.substring(bar + 1);
    lines.push(text.startsWith(" ") ? text.substring(1) : text);
  }
  return lines.join("\n");
}

// The options, the input and the output of a snapshot.
class Sections {
  options: string[] = [];
  input: string = "";
  output: string = "";
}

const SECTION_TITLES: string[] = ["options", "input", "output", ""];

// With a range, the input is a code frame, and the rest is moved to the right to line up with it: `    : text`.
// `line` without the offset; null if it does not have it.
function withoutOffset(line: string, offset: number): string | null {
  if (offset === 0) return line;
  if (line.length < offset) return null;
  if (trimAsciiStart(line.substring(0, offset)) !== ":") return null;
  const rest = line.substring(offset);
  return rest.startsWith(" ") ? rest.substring(1) : rest;
}

// The sections of a snapshot: the options, the input and the output. null: it is not one.
function sections(body: string): Sections | null {
  const lines = body.split("\n");
  const first = lines[0];
  let offset = 0;
  if (trimAsciiStart(first).startsWith(":")) {
    const colon = first.indexOf(":");
    if (colon < 0) return null;
    offset = colon + 1;
  }
  const options: string[] = [];
  const input: string[] = [];
  const output: string[] = [];
  let section = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const plain = withoutOffset(line, offset);
    if (section >= SECTION_TITLES.length) return null;
    const title = SECTION_TITLES[section];
    if (plain !== null && isSeparator(plain, title)) {
      section = section + 1;
      if (section === 4) break;
      continue;
    }
    if (section === 1) {
      if (plain === null) return null;
      options.push(plain);
    } else if (section === 2) {
      input.push(line);
    } else if (section === 3) {
      if (plain === null) return null;
      output.push(plain);
    } else {
      return null;
    }
  }
  if (section !== 4) return null;
  const s = new Sections();
  s.options = options;
  s.input = offset === 0 ? input.join("\n") : textOfCodeFrame(input);
  s.output = output.join("\n");
  return s;
}

function parseSnapshots(text: string): Case[] {
  // By the title without what is after the options.
  const cases = new Map<string, Case>();
  const entries = text.split("\nexports[`");
  for (let e = 1; e < entries.length; e++) {
    const entry = entries[e];
    const titleEnd = entry.indexOf("`] = `\n");
    if (titleEnd < 0) continue;
    let title = entry.substring(0, titleEnd);
    let body = entry.substring(titleEnd + "`] = `\n".length);
    const bodyEnd = body.lastIndexOf("\n`;");
    if (bodyEnd < 0) continue;
    body = body.substring(0, bodyEnd);
    // The number tells apart what has the same title: the same options with other parsers.
    const numberAt = title.lastIndexOf(" ");
    if (numberAt < 0) continue;
    const number = title.substring(numberAt + 1);
    title = title.substring(0, numberAt);
    // `format`, or `format[acorn]` for a parser that rejects what the first one takes.
    const kindAt = title.lastIndexOf(" ");
    if (kindAt < 0) continue;
    const kind = title.substring(kindAt + 1);
    title = title.substring(0, kindAt);
    if (!kind.startsWith("format")) continue;
    const key = title + " " + number;
    const parser = trimSet(kind.substring("format".length), "[]");
    const optionsAt = title.indexOf(" - {");
    const name = unescape(optionsAt < 0 ? title : title.substring(0, optionsAt));
    body = unescape(body);

    const parsed = sections(body);
    if (parsed === null) {
      let existing = cases.get(key);
      if (existing === undefined) {
        existing = new Case(name);
        cases.set(key, existing);
      }
      if (parser.length === 0) {
        // Nothing.
      } else if (!existing.hasOutput) {
        existing.errorParsers.push(parser);
      } else {
        existing.rejectedBy.push(parser);
      }
      continue;
    }
    const c = new Case(name);
    c.input = parsed.input;
    c.hasOutput = true;
    c.output = parsed.output;
    const previous = cases.get(key);
    cases.delete(key);
    if (previous !== undefined && !previous.hasOutput) c.rejectedBy = previous.errorParsers;
    for (let i = 0; i < parsed.options.length; i++) {
      const line = trimSet(parsed.options[i], " |");
      const colon = line.indexOf(": ");
      if (colon < 0) continue;
      const optionName = line.substring(0, colon);
      let value = line.substring(colon + 2);
      if (optionName === "parsers") {
        // `[]`: it is left to the name of the file.
        const names = trimSet(value, "[]").split(", ");
        for (let k = 0; k < names.length; k++) {
          if (names[k].length > 0) c.parsers.push(trimSet(names[k], '"'));
        }
      } else {
        if (value.endsWith(" (default)")) value = value.substring(0, value.length - " (default)".length);
        c.optionNames.push(optionName);
        c.optionValues.push(trimSet(value, '"'));
      }
    }
    cases.set(key, c);
  }
  const keys: string[] = [];
  for (const k of cases.keys()) keys.push(k);
  const sorted = sortedKeys(keys);
  const out: Case[] = [];
  for (let i = 0; i < sorted.length; i++) out.push(cases.get(sorted[i]) as Case);
  return out;
}

// Takes the placeholders out of `original`. Where they were goes into the options, in UTF-16 code units.
function replacePlaceholders(original: string, options: FormatOptions): string {
  const names: string[] = ["cursorOffset", "rangeStart", "rangeEnd"];
  const placeholders: string[] = [CURSOR, RANGE_START, RANGE_END];
  const foundAt: number[] = [];
  const foundWhich: number[] = [];
  for (let p = 0; p < 3; p++) {
    const at = original.indexOf(placeholders[p]);
    if (at >= 0) {
      foundAt.push(at);
      foundWhich.push(p);
    }
  }
  // Sorted by where they are (at most three, so an insertion sort; the places are different).
  for (let i = 1; i < foundAt.length; i++) {
    let k = i;
    while (k > 0 && foundAt[k - 1] > foundAt[k]) {
      const a = foundAt[k - 1];
      foundAt[k - 1] = foundAt[k];
      foundAt[k] = a;
      const w = foundWhich[k - 1];
      foundWhich[k - 1] = foundWhich[k];
      foundWhich[k] = w;
      k = k - 1;
    }
  }
  let text = "";
  let endOfPrevious = 0;
  for (let i = 0; i < foundAt.length; i++) {
    text = text + original.substring(endOfPrevious, foundAt[i]);
    endOfPrevious = foundAt[i] + placeholders[foundWhich[i]].length;
    options.set(names[foundWhich[i]], String(utf16Length(text)));
  }
  return text + original.substring(endOfPrevious);
}

// `<LF>`, `<CRLF>` and `<CR>` at the ends of the lines, the way the snapshots show them.
function visualizeEndOfLine(text: string): string {
  const parts: string[] = [];
  let from = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c !== 10 && c !== 13) continue;
    parts.push(text.substring(from, i));
    if (c === 13 && i + 1 < n && text.charCodeAt(i + 1) === 10) {
      parts.push("<CRLF>\n");
      i = i + 1;
    } else if (c === 13) {
      parts.push("<CR>\n");
    } else {
      parts.push("<LF>\n");
    }
    from = i + 1;
  }
  parts.push(text.substring(from));
  return parts.join("");
}

class Tally {
  // The output is that of the snapshot.
  format: Count = new Count();
  // Of those that are not: the parser reports a syntax error.
  syntaxErrors: number = 0;
  // The input is rejected, as it should be.
  errors: Count = new Count();
  secondFormat: Count = new Count();
  crlf: Count = new Count();
  cr: Count = new Count();
  bom: Count = new Count();
  // The cases whose language nobody has plugged in (dispatch.ts); no check of them is in the numbers above.
  notPorted: number = 0;

  merge(other: Tally): void {
    this.format.merge(other.format);
    this.syntaxErrors = this.syntaxErrors + other.syntaxErrors;
    this.errors.merge(other.errors);
    this.secondFormat.merge(other.secondFormat);
    this.crlf.merge(other.crlf);
    this.cr.merge(other.cr);
    this.bom.merge(other.bom);
    this.notPorted = this.notPorted + other.notPorted;
  }

  all(): Count {
    const all = new Count();
    all.merge(this.format);
    all.merge(this.errors);
    all.merge(this.secondFormat);
    all.merge(this.crlf);
    all.merge(this.cr);
    all.merge(this.bom);
    return all;
  }
}

// The parser of Prettier that a file with this name is read by.
function parserOf(name: string, language: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.substring(dot + 1);
  if (extension === "ts" || extension === "tsx" || extension === "mts" || extension === "cts") return "typescript";
  if (extension === "js" || extension === "jsx" || extension === "mjs" || extension === "cjs") return "babel";
  if (language === "typescript") return "typescript";
  return "babel";
}

// The parser that all of a directory is read by, whatever the names of the files; "" if there is none.
function parserOfDirectory(language: string): string {
  switch (language) {
    case "html":
      return "html";
    case "vue":
      return "vue";
    case "angular":
      return "angular";
    case "lwc":
      return "lwc";
    case "mjml":
      return "mjml";
    case "handlebars":
      return "glimmer";
    case "flow":
      return "flow";
    default:
      return "";
  }
}

function isJavascriptParser(name: string): boolean {
  switch (name) {
    case "babel":
    case "typescript":
    case "flow":
    case "babel-ts":
    case "babel-flow":
    case "acorn":
    case "espree":
    case "meriyah":
    case "oxc":
    case "oxc-ts":
      return true;
    default:
      return false;
  }
}

// JSON or a style sheet: the parser is not left to the name of the file.
function isNamed(it: string): boolean {
  if (it.startsWith("json")) return true;
  switch (it) {
    case "css":
    case "less":
    case "scss":
    case "graphql":
    case "yaml":
    case "markdown":
    case "mdx":
    case "glimmer":
    case "html":
    case "vue":
    case "angular":
    case "lwc":
    case "mjml":
    case "__ng_interpolation":
      return true;
    default:
      return false;
  }
}

function findNamed(list: string[]): string {
  for (let i = 0; i < list.length; i++) if (isNamed(list[i])) return list[i];
  return "";
}

function fail(kind: string, id: string, described: string): void {
  outputLine("FAIL " + kind + " " + id + described);
}

// `snippet-filenames.txt`: `<title>\t<file name>` per line. The name of a snippet; null if it has none.
function notedFilename(filenames: string, title: string): string | null {
  const lines = filenames.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const tab = lines[i].indexOf("\t");
    if (tab < 0) continue;
    if (lines[i].substring(0, tab) === title) return lines[i].substring(tab + 1);
  }
  return null;
}

let index = 0;
const byDirectory = new Map<string, Tally>();
const excluded = new Map<string, number>();

function tallyOf(group: string): Tally {
  let t = byDirectory.get(group);
  if (t === undefined) {
    t = new Tally();
    byDirectory.set(group, t);
  }
  return t;
}

function addExcluded(reason: string): void {
  const n = excluded.get(reason);
  excluded.set(reason, n === undefined ? 1 : n + 1);
}

// The options of the case on top of what `options` has (`options.set` for each); false if one is not accepted.
function setCaseOptions(c: Case, options: FormatOptions): boolean {
  for (let i = 0; i < c.optionNames.length; i++) {
    if (!options.set(c.optionNames[i], c.optionValues[i])) return false;
  }
  return true;
}

// One case: `FormatCase` of the checks below. `path`: the name the formatter gets; `original`: the text.
class Run {
  path: string = "";
  options: FormatOptions = new FormatOptions();
  // Set when a formatter says it is not ported.
  notPorted: boolean = false;

  // `format` of prettier.rs: the text of the formatter, with the cursor shown. Not-ported is noted.
  format(original: string): FormatResult {
    const options = this.options.copy();
    const input = replacePlaceholders(original, options);
    const r = runFormat(this.path, input, options);
    if (r.status === FT_NOT_PORTED) this.notPorted = true;
    if (r.status === FT_OK) return new FormatResult(FT_OK, showCursor(r.output, r.cursor), r.cursor);
    return r;
  }
}

function runCase(c: Case, language: string, relative: string, group: string, filenames: string, bundle: Bundle, flags: Flags): void {
  const id = relative + "/" + c.name;
  if (!flags.wants(id)) return;
  const firstParser = c.parsers.length > 0 ? c.parsers[0] : "";
  // What is rejected says by which parser in its title, or not at all.
  let rejectingParser = "";
  if (!c.hasOutput) {
    rejectingParser = findNamed(c.errorParsers);
    if (rejectingParser.length === 0) rejectingParser = parserOfDirectory(language);
  }
  let namedParser = firstParser.length > 0 && isNamed(firstParser) ? firstParser : "";
  if (namedParser.length === 0) namedParser = rejectingParser;
  const ours = namedParser.length > 0 ? namedParser : parserOf(c.name, language);
  if (c.parsers.length > 0 && namedParser.length === 0) {
    let anyJs = false;
    for (let i = 0; i < c.parsers.length; i++) if (isJavascriptParser(c.parsers[i])) anyJs = true;
    if (!anyJs) {
      addExcluded(PLUGIN);
      return;
    }
  }
  // A plugin for what is embedded is not asked where that is left as it is.
  let isEmbeddedLeft = false;
  for (let i = 0; i < c.optionNames.length; i++) {
    if (c.optionNames[i] === "embeddedLanguageFormatting" && c.optionValues[i] === "off") isEmbeddedLeft = true;
  }
  for (let i = 0; i < EXCLUDED_PATHS.length; i++) {
    if ((EXCLUDED_REASONS[i] !== PLUGIN || !isEmbeddedLeft) && id.includes(EXCLUDED_PATHS[i])) {
      addExcluded(EXCLUDED_REASONS[i]);
      return;
    }
  }
  index = index + 1;
  if ((index - 1) % flags.every !== flags.first % flags.every) return;
  const tally = tallyOf(group);

  // `bun fmt` does not format HTML in templates and in blocks of code by itself yet. Here it is judged.
  const options = new FormatOptions();
  options.embeddedHtml = true;
  if (namedParser.length > 0) {
    options.set("parser", namedParser);
  } else if (c.parsers.length > 0 && (contains(c.rejectedBy, ours) || !contains(c.parsers, ours))) {
    // The output is that of another parser, which takes what `babel` does not: types in a `.js` file.
    for (let i = 0; i < c.parsers.length; i++) {
      if (!contains(c.rejectedBy, c.parsers[i])) {
        options.set("parser", c.parsers[i]);
        break;
      }
    }
  }
  let described = "";
  for (let i = 0; i < c.optionNames.length; i++) {
    if (c.optionNames[i] === "printWidth" && c.optionValues[i] === "80") continue;
    described = described + " " + c.optionNames[i] + "=" + c.optionValues[i];
  }
  if (!setCaseOptions(c, options)) {
    tally.format.add(false);
    fail("unknown-option", id, described);
    return;
  }

  // The file has what the snapshot cannot show: line endings, a byte order mark.
  const fileText = bundle.read(id);
  const onDisk = fileText !== null && isValidUtf8(fileText);
  let path = "";
  let original = "";
  if (onDisk) {
    path = id;
    original = fileText as string;
  } else {
    // The name of a file that the test gives the text, which `sync.ts` has noted. Or `snippet: test.cjs`.
    // It is parsed as the parser of the test says, if it says.
    const hasTitle = c.name.startsWith("snippet: ");
    const title = hasTitle ? c.name.substring("snippet: ".length) : "";
    const noted = hasTitle ? notedFilename(filenames, title) : null;
    let name = "";
    if (noted !== null) name = noted;
    else if (hasTitle && title.indexOf(".") >= 0) name = title;
    options.set("filepath", name);
    let extension = "js";
    if (namedParser.startsWith("json")) extension = "json";
    else if (namedParser === "glimmer") extension = "hbs";
    // Prettier gives it no name, and what is not called `.html` keeps its doctype as it is written.
    else if (namedParser === "html" || namedParser === "angular" || namedParser === "lwc") extension = "text";
    else if (namedParser === "flow") extension = "js";
    else if (namedParser.length > 0) extension = namedParser;
    else if (language === "typescript") extension = "ts";
    else if (language === "jsx") extension = "jsx";
    else if (firstParser === "typescript" || firstParser === "babel-ts") extension = "ts";
    path = "snippet." + extension;
    original = c.input;
  }
  // Of a snippet with a range, the snapshot does not have the text with the placeholders.
  const hasPlaceholders = (options.rangeStart < 0 && options.rangeEnd < 0) || original.includes(RANGE_START) || original.includes(RANGE_END);
  const input = replacePlaceholders(original, options.copy());
  const run = new Run();
  run.path = path;
  run.options = options;

  if (!c.hasOutput) {
    // The text of a snippet that is rejected is not in the snapshot: `sync.ts` writes it to `rejected-snippets`.
    if ((c.errorParsers.length === 0 || contains(c.errorParsers, ours)) && onDisk) {
      setMock(input, "", false);
      const r = run.format(original);
      if (run.notPorted) {
        tally.notPorted = tally.notPorted + 1;
        return;
      }
      const isRejected = r.status === FT_SYNTAX;
      tally.errors.add(isRejected);
      if (!isRejected) fail("rejected", id, described);
    }
    return;
  }
  const expected = c.output;

  let isVisualized = false;
  for (let i = 0; i < c.optionNames.length; i++) if (c.optionNames[i] === "endOfLine") isVisualized = true;
  setMock(input, expected, true);
  const result = run.format(original);
  if (run.notPorted) {
    tally.notPorted = tally.notPorted + 1;
    return;
  }
  let actual = "";
  if (result.status === FT_OK) actual = isVisualized ? visualizeEndOfLine(result.output) : result.output;
  else actual = failureText(result);
  const passed = actual === expected;
  tally.format.add(passed);
  if (!passed) {
    if (actual === "<SyntaxError>") tally.syntaxErrors = tally.syntaxErrors + 1;
    fail("format", id, described);
    flags.writeReport(id + described, expected, actual, input);
    return;
  }
  const output = result.output;

  const hasPosition = options.rangeStart >= 0 || options.rangeEnd >= 0 || options.cursorOffset >= 0;
  if (!hasPosition && output !== input && !contains(UNSTABLE, id)) {
    const again = run.format(output);
    const isStable = again.status === FT_OK && again.output === output;
    tally.secondFormat.add(isStable);
    if (!isStable) fail("second-format", id, described);
  }
  if (!hasPlaceholders) return;
  const isLeftAlone = options.requirePragma || options.checkIgnorePragma || (options.rangeStart >= 0 && options.rangeEnd >= 0 && options.rangeStart >= options.rangeEnd);
  const skipsEndOfLine = trimAscii(input).length === 0 || input.indexOf("\r") >= 0 || isLeftAlone;
  if (!skipsEndOfLine) {
    for (let k = 0; k < 2; k++) {
      const endOfLine = k === 0 ? "\r\n" : "\r";
      const count = k === 0 ? tally.crlf : tally.cr;
      const kind = k === 0 ? "CRLF" : "CR";
      const expectedLines = options.lineEnding === LINE_ENDING_AUTO ? replaceAll(output, "\n", endOfLine) : output;
      const r = run.format(replaceAll(original, "\n", endOfLine));
      const isSame = r.status === FT_OK && r.output === expectedLines;
      count.add(isSame);
      if (!isSame) fail(kind, id, described);
    }
  }
  if (!input.startsWith(BOM)) {
    const r = run.format(BOM + original);
    const isSame = r.status === FT_OK && r.output.startsWith(BOM) && r.output.substring(BOM.length) === output;
    tally.bom.add(isSame);
    if (!isSame) fail("BOM", id, described);
  }
}

function show(name: string, it: Tally): void {
  let line =
    name +
    ": format " +
    it.format.toString() +
    " (" +
    it.syntaxErrors +
    " syntax errors), rejected " +
    it.errors.toString() +
    ", second format " +
    it.secondFormat.toString() +
    ", CRLF " +
    it.crlf.toString() +
    ", CR " +
    it.cr.toString() +
    ", BOM " +
    it.bom.toString();
  if (it.notPorted > 0) line = line + ", not ported " + it.notPorted;
  outputLine(line);
}

// Prints `FAIL <check> <case> <options>` for each check that fails, how many pass of each kind, and how many cases are
// not run for which reason. A case whose language is not ported (dispatch.ts) is in none of the numbers: it is in the
// last line, `not run: N: not ported yet`, and in `not ported` of its language.
export function run(bundle: Bundle, flags: Flags): void {
  index = 0;
  byDirectory.clear();
  excluded.clear();
  const languages = flags.languages.split(",");
  for (let l = 0; l < languages.length; l++) {
    const language = languages[l];
    const prefix = language + "/";
    for (let p = 0; p < bundle.sorted.length; p++) {
      const snapshotFile = bundle.sorted[p];
      if (!snapshotFile.startsWith(prefix) || !snapshotFile.endsWith(SNAPSHOT)) continue;
      const relative = snapshotFile.substring(0, snapshotFile.length - SNAPSHOT.length);
      // `js/arrows`, whatever is below it.
      const parts = relative.split("/");
      const group = parts.length >= 2 ? parts[0] + "/" + parts[1] : parts[0];
      const filenames = bundle.readOrEmpty(relative + "/snippet-filenames.txt");
      const cases = parseSnapshots(bundle.readOrEmpty(snapshotFile));
      for (let i = 0; i < cases.length; i++) runCase(cases[i], language, relative, group, filenames, bundle, flags);
    }
  }

  const byLanguage = new Map<string, Tally>();
  const directories = sortedKeys(Array.from(byDirectory.keys()));
  for (let i = 0; i < directories.length; i++) {
    const directory = directories[i];
    const tally = byDirectory.get(directory) as Tally;
    const slash = directory.indexOf("/");
    const language = slash < 0 ? directory : directory.substring(0, slash);
    let total = byLanguage.get(language);
    if (total === undefined) {
      total = new Tally();
      byLanguage.set(language, total);
    }
    total.merge(tally);
    if (flags.table) show(directory, tally);
  }
  const everything = new Tally();
  const languageNames = sortedKeys(Array.from(byLanguage.keys()));
  for (let i = 0; i < languageNames.length; i++) {
    const tally = byLanguage.get(languageNames[i]) as Tally;
    everything.merge(tally);
    show(languageNames[i], tally);
  }
  const all = everything.all();
  outputLine("format: " + everything.format.toString() + " (" + percent(everything.format) + "%)");
  outputLine("all checks: " + all.toString() + " (" + percent(all) + "%)");
  const reasons = sortedKeys(Array.from(excluded.keys()));
  for (let i = 0; i < reasons.length; i++) outputLine("not run: " + excluded.get(reasons[i]) + ": " + reasons[i]);
  if (everything.notPorted > 0) {
    let which = "";
    for (let i = 0; i < languageNames.length; i++) {
      const tally = byLanguage.get(languageNames[i]) as Tally;
      if (tally.notPorted > 0) which = which + (which.length > 0 ? ", " : "") + languageNames[i] + " " + tally.notPorted;
    }
    outputLine("not run: " + everything.notPorted + ": " + NOT_PORTED_REASON + " (" + which + ")");
  }
}

