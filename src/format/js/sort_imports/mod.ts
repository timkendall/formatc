// Port of vendor/bun/src/format/js/sort_imports/mod.rs: sorting the imports of a file, the way the plugins of Prettier and oxfmt do it.
//
// The plugins of Prettier are preprocessors: they turn the text of a file into another text, which Prettier then parses and formats.
// `sortedText` is that text. It is byte for byte what the plugin makes, so that whatever Prettier makes of it, comments in odd places
// included, the formatter makes of it too. Most files have their imports sorted already: that is found out without parsing anything
// again (`layout.ts`).
//
//   const settings = new Settings(); settings.set(name, value) ..;
//   const how = settings.compile();              // SortImports | null (settings.error: why null)
//   options.sortImports = registerSortImports(how);   // the handle that FormatOptions holds
//   ...
//   const sorted = sortedText(path, how);         // the file that was parsed last, sorted: parse and format it instead; null: as it is
//   oxfmt / native: `print/program.ts` calls `importRunBegin` & co. of `oxfmt/run.ts`
import { fileHasParseErrors, hir } from "../../../lint/ast/index.ts";
import { Model } from "./babel.ts";
import { HOW_IANVS, HOW_NATIVE, HOW_ORGANIZE, HOW_OXFMT, HOW_TRIVAGO, SortImports, registerSortImports, sortImportsOf } from "./how.ts";
import { IanvsOptions, preprocess as ianvsPreprocess } from "./ianvs.ts";
import { Summary, preprocess as nativePreprocess, sameSummary, summary } from "./native.ts";
import { OrganizeOptions, preprocess as organizePreprocess } from "./organize.ts";
import { TrivagoOptions, preprocess as trivagoPreprocess } from "./trivago.ts";

export { Settings } from "./settings.ts";
export { SortImports, registerSortImports, sortImportsOf };

/** Prettier's `guessEndOfLine` */
function endOfLineOf(text: Uint8Array): string {
  for (let i = 0; i < text.length; i++) {
    if ((text[i] | 0) === 10) return i > 0 && (text[i - 1] | 0) === 13 ? "\r\n" : "\n";
  }
  return "\n";
}

/**
 * The text of the file that was parsed last (`parseFile` + `fileBegin`) with its imports sorted. It has to be parsed and formatted in place of
 * the file. null: formatting the file gives the same. `path`: the path of the file (`importOrderExclude`).
 */
export function sortedText(path: string, how: SortImports): Uint8Array | null {
  if (fileHasParseErrors() || how.how === HOW_OXFMT) return null;
  if (how.how === HOW_NATIVE) return nativePreprocess();
  const hir$ = hir;
  const text = hir$.text.subarray(0, hir$.sourceLen | 0);
  const endOfLine = endOfLineOf(text);
  if (how.how === HOW_ORGANIZE) return organizePreprocess(how.organize as OrganizeOptions, endOfLine);
  const model = Model.create();
  if (model === null) return null;
  if (how.how === HOW_TRIVAGO) return trivagoPreprocess(model, how.trivago as TrivagoOptions, endOfLine, path);
  if (how.how === HOW_IANVS) return ianvsPreprocess(model, how.ianvs as IanvsOptions, endOfLine);
  return null;
}

class Before {
  summary: Summary | null = null;
}
const before = new Before();

/** Call it with the file that was parsed last, before `sortedText`, if `keepsImports` is going to be asked. */
export function rememberImportsBefore(how: SortImports): void {
  before.summary = how.how === HOW_NATIVE ? summary() : null;
}

/**
 * Checks that the file that was parsed last, the parsed output of `sortedText`, still imports what the one before did
 * (`rememberImportsBefore`). Always true for the Prettier plugins, which may remove imports on purpose.
 */
export function keepsImports(how: SortImports): boolean {
  if (how.how !== HOW_NATIVE) return true;
  const b = before.summary;
  if (b === null) return true;
  return !fileHasParseErrors() && sameSummary(b, summary());
}
