// Port of vendor/bun/src/format/js/jsdoc/imports.rs: `@import` tags: those for the same module become one, and they are sorted.
import { LineBuffer } from "./line_buffer.ts";
import { lines, stableSort } from "./text.ts";
import { QUOTE_SINGLE } from "../../options.ts";
import { splitUnicodeWhitespace, trimUnicodeWhitespace } from "../../../base/ustr.ts";
import { trimEndMatchesCp } from "./text.ts";
import { partParsed, tagCommentEnd, tagCommentStart } from "../../../lint/ast/jsdoc.ts";

class ImportInfo {
  defaultImport: string | null;
  namedImports: string[];
  modulePath: string;
  constructor(defaultImport: string | null, namedImports: string[], modulePath: string) {
    this.defaultImport = defaultImport;
    this.namedImports = namedImports;
    this.modulePath = modulePath;
  }
}

function collapse(text: string): string {
  return splitUnicodeWhitespace(text).join(" ");
}

/** `Default, {Named1, Named2} from "module"` */
function parseImportTag(commentText: string): ImportInfo | null {
  const ls = lines(commentText);
  const trimmedLines: string[] = [];
  for (let i = 0; i < ls.length; i++) trimmedLines.push(trimUnicodeWhitespace(ls[i]));
  const text = trimUnicodeWhitespace(trimmedLines.join(" "));
  const fromIndex = text.lastIndexOf(" from ");
  if (fromIndex < 0) return null;
  const specifier = trimUnicodeWhitespace(text.substring(0, fromIndex));
  const modulePart = trimUnicodeWhitespace(text.substring(fromIndex + 6));
  if (modulePart.length === 0) return null;
  const quote = modulePart.charCodeAt(0);
  if (quote !== 34 && quote !== 39) return null;
  const rest = modulePart.substring(1);
  if (!(rest.length > 0 && rest.charCodeAt(rest.length - 1) === quote)) return null;
  const modulePath = rest.substring(0, rest.length - 1);
  if (modulePath.length === 0) return null;
  const braceStart = specifier.indexOf("{");
  if (braceStart >= 0) {
    const braceEnd = specifier.lastIndexOf("}");
    if (braceEnd < 0) return null;
    const defaultPart = trimUnicodeWhitespace(trimEndMatchesCp(trimUnicodeWhitespace(specifier.substring(0, braceStart)), 44));
    if (braceEnd < braceStart + 1) return null;
    const namedPart = specifier.substring(braceStart + 1, braceEnd);
    const named: string[] = [];
    const parts = namedPart.split(",");
    for (let i = 0; i < parts.length; i++) {
      const c = collapse(parts[i]);
      if (c.length > 0) named.push(c);
    }
    return new ImportInfo(defaultPart.length > 0 ? defaultPart : null, named, modulePath);
  }
  return new ImportInfo(collapse(specifier), [], modulePath);
}

function lowerAscii(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

function cmpAsciiCaseInsensitive(a: string, b: string): number {
  const common = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < common; i++) {
    const x = lowerAscii(a.charCodeAt(i));
    const y = lowerAscii(b.charCodeAt(i));
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** What a specifier is sorted by: `B1` of `B as B1`. */
function importSpecifierSortKey(specifier: string): string {
  const index = specifier.indexOf(" as ");
  return index >= 0 ? trimUnicodeWhitespace(specifier.substring(index + 4)) : trimUnicodeWhitespace(specifier);
}

function compareNamed(a: string, b: string): number {
  return cmpAsciiCaseInsensitive(importSpecifierSortKey(a), importSpecifierSortKey(b));
}

function isRelative(i: ImportInfo): boolean {
  return i.modulePath.startsWith(".");
}

function compareGroups(a: ImportInfo, b: ImportInfo): number {
  const ra = isRelative(a);
  const rb = isRelative(b);
  if (ra !== rb) return ra ? 1 : -1;
  return cmpAsciiCaseInsensitive(a.modulePath, b.modulePath);
}

function mergeAndSortImports(imports: ImportInfo[]): ImportInfo[] {
  const groups: ImportInfo[] = [];
  for (let k = 0; k < imports.length; k++) {
    const imp = imports[k];
    let existing: ImportInfo | null = null;
    for (let g = 0; g < groups.length; g++) {
      if (groups[g].modulePath === imp.modulePath) {
        existing = groups[g];
        break;
      }
    }
    if (existing === null) {
      groups.push(imp);
      continue;
    }
    if (imp.defaultImport !== null) existing.defaultImport = imp.defaultImport;
    for (let n = 0; n < imp.namedImports.length; n++) {
      const named = imp.namedImports[n];
      const key = importSpecifierSortKey(named);
      let found = false;
      for (let e = 0; e < existing.namedImports.length; e++) if (importSpecifierSortKey(existing.namedImports[e]) === key) found = true;
      if (!found) existing.namedImports.push(named);
    }
  }
  for (let g = 0; g < groups.length; g++) stableSort(groups[g].namedImports, 0, groups[g].namedImports.length, compareNamed);
  // Packages come before relative paths.
  stableSort(groups, 0, groups.length, compareGroups);
  return groups;
}

function formatImportLines(imp: ImportInfo, quote: string, contentLines: LineBuffer): void {
  if (imp.defaultImport === null && imp.namedImports.length === 0) return;
  contentLines.beginLine();
  let out = "@import ";
  if (imp.defaultImport !== null) {
    out = out + imp.defaultImport;
    if (imp.namedImports.length > 0) out = out + ", ";
  }
  const named = imp.namedImports;
  if (named.length === 1) out = out + "{" + named[0] + "}";
  else if (named.length > 1) {
    out = out + "{";
    for (let i = 0; i < named.length; i++) {
      out = out + "\n  " + named[i];
      if (i + 1 < named.length) out = out + ",";
    }
    out = out + "\n}";
  }
  out = out + " from " + quote + imp.modulePath + quote;
  contentLines.append(out);
}

/** The result of `processImportTags`. */
export class ImportTags {
  lines: LineBuffer = new LineBuffer();
  parsedIndices: number[] = [];
}

/** The lines for all `@import` tags of `tagRows` (kinds `kinds`) that can be parsed, and which of the tags those are. */
export function processImportTags(tagRows: number[], kinds: string[], quoteStyle: number): ImportTags {
  const imports: ImportInfo[] = [];
  const result = new ImportTags();
  for (let index = 0; index < tagRows.length; index++) {
    if (kinds[index] === "import") {
      const info = parseImportTag(partParsed(tagCommentStart(tagRows[index]), tagCommentEnd(tagRows[index])));
      if (info !== null) {
        imports.push(info);
        result.parsedIndices.push(index);
      }
    }
  }
  const merged = mergeAndSortImports(imports);
  const quote = quoteStyle === QUOTE_SINGLE ? "'" : '"';
  for (let i = 0; i < merged.length; i++) formatImportLines(merged[i], quote, result.lines);
  return result;
}
