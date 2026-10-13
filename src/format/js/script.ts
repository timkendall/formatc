// The JavaScript / TypeScript path of `format()` of vendor/bun/src/lint/driver/fmt/mod.rs, from the parse on (`pragma::before_parsing` is
// the caller's): the file is parsed as a module and, if that fails, as a script (`kinds(name)`), `range::format_with_cursor` formats it.
//
//   formatScript(path, name, before, options, out): FORMAT_* code
//
// `path` is what the parser sees (it decides TypeScript, JSX, `.d.ts`), `name` what decides the language (`options.filepath` or `path`).
// `before`: the text to parse (what `pragma.beforeParsing` returned). Appends the formatted text to `out`. On `FORMAT_SYNTAX_ERROR` the
// place of the first error is `scriptErrorOffset()` (a byte offset in `before`, -1: unknown).
// Parsing is `src/sema/parser/script.ts` (`prepareScriptText`, `parseAttempt`: Flow / `babel-flow`, the recovering parse, `refusal_of_prettier`);
// the message of the error is `scriptErrorMessage()`.
// TODO(port): `sort_imports::sorted_text`, `refusal_of_oxfmt`, `--debug-check`.
import { ByteBuf } from "../../base/bytebuf.ts";
import { FORMAT_OK, FORMAT_SYNTAX_ERROR } from "../errors.ts";
import { FormatOptions, flavorIsOxfmt } from "../options.ts";
import { jsState } from "./state.ts";
import { formatWithCursor } from "../range.ts";
import { setJsdocReparse } from "./jsdoc/mod.ts";
import { fileBegin, hir } from "../../lint/ast/index.ts";
import { names } from "../../sema/parser/parser/mod.ts";
import { goesToFlow } from "../../lint/linter/syntax/mod.ts";
import { dialectBabel, dialectFlow, dialectFlowParser } from "../../sema/parser/lib.ts";
import { READ_PARSED, readFile } from "../../sema/parser/summarize.ts";
import { diagnosticMessage } from "../../sema/messages.ts";
import { sortImportsOf, sortedText } from "./sort_imports/mod.ts";
import {
  PS_OK,
  goesToBabel,
  parseAttempt,
  prepareScriptText,
  scriptError,
  scriptKinds,
  scriptText,
} from "../../sema/parser/script.ts";

class ScriptState {
  errorOffset: number = -1;
  errorMessage: string = "Unexpected token";
  isFlow: boolean = false;
  goesToBabel: boolean = false;
}
const state = new ScriptState();

/** Where the first syntax error was (a byte offset in the text without a BOM, as `FormatError::SyntaxErrorAt` counts), or -1. */
export function scriptErrorOffset(): number {
  return state.errorOffset;
}

/** What the first syntax error says. */
export function scriptErrorMessage(): string {
  return state.errorMessage;
}

function endsWith(path: string, suffix: string): boolean {
  return path.endsWith(suffix);
}

/** Whether the parser of TypeScript reads the file: `.ts`, `.tsx`, `.mts`, `.cts`. */
export function isTypeScriptPath(path: string): boolean {
  return endsWith(path, ".ts") || endsWith(path, ".tsx") || endsWith(path, ".mts") || endsWith(path, ".cts");
}

/** The offset the way the problem counts it: not with the BOM. */
function withoutBom(text: Uint8Array, len: number, at: number): number {
  if (at < 0) return at;
  if (len >= 3 && (text[0] | 0) === 0xef && (text[1] | 0) === 0xbb && (text[2] | 0) === 0xbf) return at >= 3 ? at - 3 : 0;
  return at;
}

function setError(message: string, at: number): void {
  state.errorMessage = message;
  state.errorOffset = withoutBom(scriptText.src, scriptText.len | 0, at);
}

/** `options.parser` is a parser that takes types in JavaScript files. */
function takesTypes(parser: string): boolean {
  return parser === "flow" || parser === "babel-flow" || parser === "typescript" || parser === "babel-ts";
}

/** `is_flow` of `format()`: `babel` hands a file of Flow to `babel-flow`; `--parser flow|babel-flow` asks for it. */
function isFlowFile(options: FormatOptions, name: string, text: Uint8Array): boolean {
  const parser = options.parser;
  if (parser === "flow" || parser === "babel-flow") return true;
  if (parser === "babel" || parser === "") {
    if (flavorIsOxfmt(options.flavor)) return false;
    return goesToFlow(text, text.length, name) || (parser === "" && name.toLowerCase().endsWith(".js.flow"));
  }
  return false;
}

export function formatScript(path: string, name: string, before: Uint8Array, options: FormatOptions, out: ByteBuf): number {
  state.errorOffset = -1;
  state.errorMessage = "Unexpected token";
  jsState.path = path;
  const isFlow = isFlowFile(options, name, before);
  const toBabel = goesToBabel(options.parser, path);
  const tolerated = takesTypes(options.parser);
  state.isFlow = isFlow;
  state.goesToBabel = toBabel;
  prepareScriptText(before, before.length, path, isFlow, toBabel);
  // What the file is parsed as, one after the other until there is no error: a module, then a script. The first syntax error counts.
  const kinds = scriptKinds(name);
  let failed = false;
  let usedSorted = false;
  const start = out.len;
  const hasRange = options.rangeStart >= 0 || options.rangeEnd >= 0;
  for (let attempt = 0; attempt <= 1; attempt++) {
    const isScript = attempt === 1;
    if (isScript ? (kinds & 2) === 0 : (kinds & 1) === 0) continue;
    if (usedSorted) {
      prepareScriptText(before, before.length, path, isFlow, toBabel);
      usedSorted = false;
    }
    if (parseAttempt(isScript, path, isFlow, toBabel, tolerated) !== PS_OK) {
      if (!failed) {
        failed = true;
        setError(scriptError.message, scriptError.at);
      }
      continue;
    }
    // Sorting the imports with a plugin of Prettier: the text that the plugin makes is parsed and formatted in place of the file.
    // TODO(port): `keeps_imports` (--debug-check).
    const how = options.sortImports >= 0 ? sortImportsOf(options.sortImports) : null;
    if (how !== null) {
      const sorted = sortedText(path, how);
      if (sorted !== null) {
        usedSorted = true;
        prepareScriptText(sorted, sorted.length, path, isFlow, toBabel);
        if (parseAttempt(isScript, path, isFlow, toBabel, tolerated) !== PS_OK) {
          if (!failed) {
            failed = true;
            setError(scriptError.message, scriptError.at);
          }
          continue;
        }
      }
    }
    // The tree is bound (`fileBegin` was called). The text is the text that was parsed (without comment types for `babel-flow`).
    const text = scriptText.src.subarray(0, scriptText.len | 0);
    out.len = start;
    const parseSlice = hasRange ? (slice: Uint8Array): boolean => reparse(slice, path, isScript) : null;
    if (options.jsdoc !== null) setJsdocReparse((t: Uint8Array): boolean => reparse(t, path, isScript));
    const code = formatWithCursor(text, options, out, parseSlice);
    if (options.jsdoc !== null) setJsdocReparse(null);
    if (code === FORMAT_OK) return code;
    if (code === FORMAT_SYNTAX_ERROR) {
      // The parser accepted it, but it has errors the formatter cannot print: the first one is the error.
      if (!failed) {
        failed = true;
        if (hir.diagnosticsLen >= 5) {
          const argsId = hir.diagnostics[4] | 0;
          setError(diagnosticMessage(hir.diagnostics[3] | 0, argsId >= 0 ? hir.diagArgs[argsId] : []), hir.diagnostics[1] | 0);
        } else {
          setError("Unexpected token", 0);
        }
      }
      continue;
    }
    return code;
  }
  out.len = start;
  return FORMAT_SYNTAX_ERROR;
}

/** Parses a part of the file like the file was parsed (range formatting): no refusal, only the tree. */
function reparse(slice: Uint8Array, path: string, isScript: boolean): boolean {
  const dialect = state.isFlow ? (state.goesToBabel ? dialectFlow(isScript) : dialectFlowParser(isScript)) : dialectBabel(isScript);
  if (readFile(slice, slice.length, path, dialect) !== READ_PARSED) return false;
  if (hir.hasErrors || hir.hasParseDiagnostics) return false;
  fileBegin(names, isTypeScriptPath(path), !isScript);
  return true;
}
