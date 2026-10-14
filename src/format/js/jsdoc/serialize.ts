// Port of vendor/bun/src/format/js/jsdoc/serialize.rs: a whole comment.
import { Stack } from "../../../base/stack.ts";
import { COMMENT_LINE_KEEP, COMMENT_LINE_MULTILINE, FormatOptions, INDENT_TAB, JsdocOptions } from "../../options.ts";
import { isAllUnicodeWhitespace, trimUnicodeWhitespace, trimUnicodeWhitespaceEnd } from "../../../base/ustr.ts";
import {
  jsdocCommentEnd,
  jsdocCommentPartEnd,
  jsdocCommentPartStart,
  jsdocCommentStart,
  jsdocTag,
  jsdocTagCount,
  partParsed,
  partParsedPreservingWhitespace,
  sourceSlice,
  tagCommentEnd,
  tagCommentStart,
  tagHasNoSpaceBeforeType,
  tagKindParsed,
} from "../../../lint/ast/jsdoc.ts";
import { processImportTags } from "./imports.ts";
import { LineBuffer } from "./line_buffer.ts";
import { formatDescription } from "./markdown.ts";
import { normalizeTagKind } from "./normalize.ts";
import { EffTag, reorderParamTags } from "./param_order.ts";
import { stableSort, trimEndMatchesCp } from "./text.ts";
import { formatExampleTag, formatGenericTag, formatTypeCommentTag, formatTypeNameCommentTag } from "./tag_formatters.ts";
import { FJ_EMPTY, FJ_SINGLE_LINE, FJ_MULTI_LINE, LINE_PREFIX_LEN, UNKNOWN_TAG_PRIORITY } from "./serialize.consts.ts";
export { FJ_EMPTY, FJ_SINGLE_LINE, FJ_MULTI_LINE } from "./serialize.consts.ts";
import { CONTINUATION_INDENT } from "./serialize.consts.ts";
export { CONTINUATION_INDENT } from "./serialize.consts.ts";


export class FormattedJsdoc {
  kind: number;
  text: string;
  constructor(kind: number, text: string) {
    this.kind = kind;
    this.text = text;
  }
}

/** What formatting a comment goes by, and the lines so far. */
export class JsdocFormatter {
  options: JsdocOptions;
  formatOptions: FormatOptions;
  wrapWidth: number;
  contentLines: LineBuffer;
  stack: Stack;

  constructor(options: JsdocOptions, formatOptions: FormatOptions, wrapWidth: number, stack: Stack) {
    this.options = options;
    this.formatOptions = formatOptions;
    this.wrapWidth = wrapWidth;
    this.contentLines = new LineBuffer();
    this.stack = stack;
  }

  /** `d`: a comment of the file. null: it stays as it is. */
  format(d: number): FormattedJsdoc | null {
    const content = sourceSlice(jsdocCommentStart(d), jsdocCommentEnd(d));
    const description = partParsedPreservingWhitespace(jsdocCommentPartStart(d), jsdocCommentPartEnd(d));
    if (isAllUnicodeWhitespace(description) && jsdocTagCount(d) === 0) return new FormattedJsdoc(FJ_EMPTY, "");
    const sortedTags = sortTagsByGroups(d);

    // The description and the `@description` tags are one.
    let mergedDescription = trimUnicodeWhitespace(description);
    const effective: EffTag[] = [];
    for (let i = 0; i < sortedTags.length; i++) {
      const tag = sortedTags[i];
      const kind = tag.kind;
      if (shouldRemoveEmptyTag(kind) && isAllUnicodeWhitespace(partParsed(tagCommentStart(tag.row), tagCommentEnd(tag.row)))) continue;
      if (kind !== "description") {
        effective.push(tag);
        continue;
      }
      const parsed = trimUnicodeWhitespace(partParsed(tagCommentStart(tag.row), tagCommentEnd(tag.row)));
      if (parsed.length > 0) {
        if (mergedDescription.length > 0) mergedDescription = mergedDescription + "\n\n";
        mergedDescription = mergedDescription + parsed;
      }
    }
    const isSingleLine = content.indexOf("\n") < 0;

    // `/** @type */`
    if (
      mergedDescription.length === 0 &&
      isSingleLine &&
      effective.length === 1 &&
      effective[0].kind === "type" &&
      isAllUnicodeWhitespace(partParsed(tagCommentStart(effective[0].row), tagCommentEnd(effective[0].row)))
    ) {
      return null;
    }

    if (mergedDescription.length > 0) {
      const desc = formatDescription(mergedDescription, this.wrapWidth, 0, this.options.capitalizeDescriptions, this.formatOptions, this.stack);
      this.contentLines.beginLine();
      if (this.options.descriptionTag) this.contentLines.append("@description ");
      this.contentLines.append(desc);
    }

    reorderParamTags(effective, jsdocCommentEnd(d));
    const rows: number[] = [];
    const kinds: string[] = [];
    for (let i = 0; i < effective.length; i++) {
      rows.push(effective[i].row);
      kinds.push(effective[i].kind);
    }
    const imports = processImportTags(rows, kinds, this.quoteStyle());
    let importLines: LineBuffer | null = imports.lines.isEmpty() ? null : imports.lines;
    let importsEmitted = false;
    let prevKind: string | null = null;
    let prevTagHadTrailingBlank = false;
    let firstNonImportTagEmitted = false;

    for (let tagIndex = 0; tagIndex < effective.length; tagIndex++) {
      const tag = effective[tagIndex];
      const normalizedKind = tag.kind;
      if (imports.parsedIndices.indexOf(tagIndex) >= 0) {
        // All of them are where the first is.
        if (importLines !== null) {
          const il = importLines;
          importLines = null;
          if (!this.contentLines.isEmpty() && !this.contentLines.lastIsEmpty()) this.contentLines.pushEmpty();
          this.contentLines.push(il.intoBytes());
          importsEmitted = true;
          prevKind = "import";
        }
        continue;
      }
      const isFirstTag = !firstNonImportTagEmitted && !importsEmitted;
      const shouldCapitalize = this.options.capitalizeDescriptions && !shouldSkipCapitalize(normalizedKind) && isKnownTag(normalizedKind);
      if (isFirstTag) {
        if (!this.contentLines.isEmpty() && !this.contentLines.lastIsEmpty()) this.contentLines.pushEmpty();
      } else {
        const prev: string = prevKind === null ? "" : prevKind;
        const hasPrev = prevKind !== null;
        let shouldSeparate = false;
        if (hasPrev && prev === normalizedKind && (prev === "example" || isGroupHead(prev))) shouldSeparate = true;
        else if (this.options.separateTagGroups) shouldSeparate = hasPrev && prev !== normalizedKind;
        else if (this.options.separateReturnsFromParam) shouldSeparate = isReturn(normalizedKind) && hasPrev && !isReturn(prev);
        else shouldSeparate = isGroupHead(normalizedKind) && hasPrev && !isGroupHead(prev) && prev !== "import" && prev !== "template";
        // What is behind a tag that is not known stays, an empty line too.
        shouldSeparate = shouldSeparate || (prevTagHadTrailingBlank && hasPrev && !isKnownTag(prev));
        if (shouldSeparate && !this.contentLines.lastIsEmpty()) this.contentLines.pushEmpty();
      }
      firstNonImportTagEmitted = true;
      prevKind = normalizedKind;
      const sourceHasTrailingBlank = partParsedPreservingWhitespace(tagCommentStart(tag.row), tagCommentEnd(tag.row)).endsWith("\n\n");
      prevTagHadTrailingBlank = sourceHasTrailingBlank;
      const linesBefore = this.contentLines.byteLen();
      const hasNoSpaceBeforeType = tagHasNoSpaceBeforeType(tag.row);

      if (normalizedKind === "example") formatExampleTag(this, normalizedKind, tag.row);
      else if (isTypeNameCommentTag(normalizedKind)) formatTypeNameCommentTag(this, normalizedKind, tag.row, shouldCapitalize, hasNoSpaceBeforeType);
      else if (isTypeCommentTag(normalizedKind)) formatTypeCommentTag(this, normalizedKind, tag.row, shouldCapitalize, hasNoSpaceBeforeType);
      else formatGenericTag(this, normalizedKind, tag.row, shouldCapitalize);

      const hasNext = tagIndex + 1 < effective.length;
      const nextKind = hasNext ? effective[tagIndex + 1].kind : "";
      let needsTrailingBlank = false;
      if (normalizedKind === "example" && this.contentLines.lineCountSince(linesBefore) > 1) needsTrailingBlank = hasNext && nextKind !== normalizedKind;
      else needsTrailingBlank = hasNext && sourceHasTrailingBlank && this.contentLines.lastLineIsBlockEnd();
      if (needsTrailingBlank && !this.contentLines.lastIsEmpty()) this.contentLines.pushEmpty();
    }

    const all = trimEndMatchesCp(this.contentLines.intoBytes(), 10);
    const allLines = all.split("\n");
    let skip = 0;
    while (skip < allLines.length && allLines[skip].length === 0) skip = skip + 1;
    if (skip >= allLines.length) return new FormattedJsdoc(FJ_EMPTY, "");
    const first = allLines[skip];
    const hasOneLine = skip + 1 >= allLines.length;
    let useSingleLine = false;
    if (this.options.commentLineStrategy === COMMENT_LINE_MULTILINE) useSingleLine = false;
    else if (this.options.commentLineStrategy === COMMENT_LINE_KEEP) useSingleLine = hasOneLine && isSingleLine;
    else useSingleLine = hasOneLine;
    if (useSingleLine) {
      const isUnchanged = content.startsWith("/** ") && content.endsWith(" */") && content.length >= 7 && content.substring(4, content.length - 3) === first;
      return isUnchanged ? null : new FormattedJsdoc(FJ_SINGLE_LINE, first);
    }
    let whole = "/**";
    for (let i = skip; i < allLines.length; i++) {
      whole = whole + (allLines[i].length === 0 ? "\n *" : "\n * ") + allLines[i];
    }
    whole = whole + "\n */";
    return whole !== content ? new FormattedJsdoc(FJ_MULTI_LINE, all) : null;
  }

  /** Pushes a description with `indent` before each line that is not empty. */
  pushIndentedDesc(indent: string, description: string): void {
    if (description.length === 0) return;
    this.contentLines.beginLine();
    const ls = description.split("\n");
    let out = "";
    for (let index = 0; index < ls.length; index++) {
      if (index > 0) out = out + "\n";
      if (ls[index].length > 0) out = out + indent + ls[index];
    }
    this.contentLines.append(out);
  }

  /** How wide a description can be that is indented by `CONTINUATION_INDENT`. */
  indentedWidth(): number {
    return this.wrapWidth > 2 ? this.wrapWidth - 2 : 0;
  }

  /** What code is indented by. */
  codeIndent(): string {
    if (this.formatOptions.indentStyle === INDENT_TAB) return "\t";
    const w = this.formatOptions.indentWidth;
    if ((w >= 0 && w <= 1) || (w >= 3 && w <= 8)) return "        ".substring(0, w);
    return "  ";
  }

  codeIndentWidth(): number {
    return this.formatOptions.indentWidth;
  }

  quoteStyle(): number {
    return this.formatOptions.quoteStyle;
  }

  /** `wrap_text`: a description in lines of at most `maxWidth` columns, the first `tagStringLength` less. */
  wrapText(text: string, maxWidth: number, tagStringLength: number): string {
    return formatDescription(text, maxWidth, tagStringLength, false, this.formatOptions, this.stack);
  }
}

function isReturn(kind: string): boolean {
  return kind === "returns" || kind === "yields";
}

function isGroupHead(kind: string): boolean {
  return kind === "typedef" || kind === "callback";
}

/** Tags whose descriptions do not get a capital letter. */
function shouldSkipCapitalize(kind: string): boolean {
  switch (kind) {
    case "borrows":
    case "default":
    case "defaultValue":
    case "deprecated":
    case "import":
    case "memberof":
    case "module":
    case "satisfies":
    case "see":
    case "type":
      return true;
    default:
      return false;
  }
}

/** Tags whose descriptions are not formatted. */
export function shouldSkipDescriptionFormatting(kind: string): boolean {
  return shouldPreserveDescriptionVerbatim(kind) || kind === "deprecated" || kind === "internal";
}

/** `TAGS_PEV_FORMATE_DESCRIPTION`: tags whose descriptions stay as they are. */
export function shouldPreserveDescriptionVerbatim(kind: string): boolean {
  switch (kind) {
    case "borrows":
    case "default":
    case "defaultValue":
    case "import":
    case "memberof":
    case "module":
    case "see":
      return true;
    default:
      return false;
  }
}

/** `@tag {type} name description` */
function isTypeNameCommentTag(kind: string): boolean {
  return kind === "param" || kind === "property" || kind === "typedef" || kind === "template" || kind === "fires";
}

/** `@tag {type} description` */
function isTypeCommentTag(kind: string): boolean {
  switch (kind) {
    case "returns":
    case "yields":
    case "throws":
    case "type":
    case "satisfies":
    case "this":
    case "extends":
      return true;
    default:
      return false;
  }
}

/** `TAGS_ORDER`, times two. */
function tagSortPriority(kind: string): number {
  switch (kind) {
    case "import":
      return 0;
    case "remarks":
      return 2;
    case "privateRemarks":
      return 4;
    case "providesModule":
      return 6;
    case "module":
      return 8;
    case "license":
      return 10;
    case "flow":
      return 12;
    case "async":
      return 14;
    case "private":
      return 16;
    case "ignore":
      return 18;
    case "memberof":
      return 20;
    case "version":
      return 22;
    case "file":
      return 24;
    case "author":
      return 26;
    case "deprecated":
      return 28;
    case "since":
      return 30;
    case "category":
      return 32;
    case "description":
      return 34;
    case "example":
      return 36;
    case "abstract":
      return 38;
    case "augments":
      return 40;
    case "constant":
      return 42;
    case "default":
      return 44;
    case "defaultValue":
      return 46;
    case "external":
      return 48;
    case "overload":
      return 50;
    case "fires":
      return 52;
    case "template":
      return 54;
    case "typeParam":
      return 56;
    case "function":
      return 58;
    case "namespace":
      return 60;
    case "borrows":
      return 62;
    case "class":
      return 64;
    case "extends":
      return 66;
    case "member":
      return 68;
    case "typedef":
      return 70;
    case "type":
      return 72;
    case "satisfies":
      return 74;
    case "property":
      return 76;
    case "callback":
      return 78;
    case "this":
      return 79;
    case "param":
      return 80;
    case "yields":
      return 82;
    case "returns":
      return 84;
    case "throws":
      return 86;
    case "see":
      return 90;
    case "todo":
      return 92;
    default:
      return UNKNOWN_TAG_PRIORITY;
  }
}

export function isKnownTag(kind: string): boolean {
  return tagSortPriority(kind) !== UNKNOWN_TAG_PRIORITY;
}

/** `TAGS_GROUP_CONDITION` */
function isTagsGroupCondition(kind: string): boolean {
  switch (kind) {
    case "callback":
    case "typedef":
    case "type":
    case "property":
    case "param":
    case "returns":
    case "this":
    case "yields":
    case "throws":
      return true;
    default:
      return false;
  }
}

/** Tags without a type whose first word is a name, which gets no capital letter. */
export function isNamedGenericTag(kind: string): boolean {
  switch (kind) {
    case "abstract":
    case "async":
    case "augments":
    case "author":
    case "callback":
    case "categoryDescription":
    case "class":
    case "constant":
    case "external":
    case "flow":
    case "function":
    case "groupDescription":
    case "ignore":
    case "member":
    case "memberof":
    case "private":
    case "see":
    case "version":
    case "typeParam":
      return true;
    default:
      return false;
  }
}

function compareTagPriority(a: EffTag, b: EffTag): number {
  const x = tagSortPriority(a.kind);
  const y = tagSortPriority(b.kind);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** The tags, each with the name that stands for its kind, sorted. `@typedef` and `@callback` start a group, and the groups stay in their order. */
function sortTagsByGroups(d: number): EffTag[] {
  const sorted: EffTag[] = [];
  let groupStart = 0;
  let canGroupNextTags = false;
  const n = jsdocTagCount(d);
  for (let i = 0; i < n; i++) {
    const row = jsdocTag(d, i);
    const kind = normalizeTagKind(tagKindParsed(row));
    if (isGroupHead(kind) && canGroupNextTags && sorted.length > groupStart) {
      stableSort(sorted, groupStart, sorted.length, compareTagPriority);
      groupStart = sorted.length;
      canGroupNextTags = false;
    }
    canGroupNextTags = canGroupNextTags || isTagsGroupCondition(kind);
    sorted.push(new EffTag(row, kind));
  }
  stableSort(sorted, groupStart, sorted.length, compareTagPriority);
  return sorted;
}

/** `TAGS_DESCRIPTION_NEEDED`: tags that go away if nothing follows them. */
function shouldRemoveEmptyTag(kind: string): boolean {
  switch (kind) {
    case "borrows":
    case "category":
    case "description":
    case "example":
    case "import":
    case "privateRemarks":
    case "remarks":
    case "since":
    case "todo":
      return true;
    default:
      return false;
  }
}

/** Whether an odd number of backslashes is before `pos`. */
function isEscaped(text: string, pos: number): boolean {
  let n = 0;
  let i = pos - 1;
  while (i >= 0 && text.charCodeAt(i) === 92) {
    n = n + 1;
    i = i - 1;
  }
  return n % 2 !== 0;
}

/** The value of `@default`: what looks like JSON gets its spaces and the quotes of `quoteStyle`. */
export function formatDefaultValue(value: string, quoteStyle: number): string {
  const trimmed = trimUnicodeWhitespace(value);
  const targetQuote = quoteStyle === 0 ? 34 : 39;
  const otherQuote = quoteStyle === 0 ? 39 : 34;
  const len = trimmed.length;
  if (len === 0) return trimmed;
  const first = trimmed.charCodeAt(0);
  if (first === 123 || first === 91) {
    // JSON-like, below
  } else if (first === 34 || first === 39) {
    // A string, and maybe a description behind it.
    let i = 1;
    while (i < len && trimmed.charCodeAt(i) !== first) i = i + (trimmed.charCodeAt(i) === 92 ? 2 : 1);
    if (i >= len || first === targetQuote) return trimmed;
    let result = String.fromCharCode(targetQuote);
    for (let k = 1; k < i; k++) {
      const b = trimmed.charCodeAt(k);
      if (b === targetQuote) result = result + "\\";
      result = result + trimmed.charAt(k);
    }
    result = result + String.fromCharCode(targetQuote);
    return result + trimmed.substring(i + 1);
  } else return trimmed;
  let result = "";
  // The quote that the string that this is in has been opened with.
  let inQuote = 0;
  for (let i = 0; i < len; i++) {
    const byte = trimmed.charCodeAt(i);
    const next = i + 1 < len ? trimmed.charCodeAt(i + 1) : -1;
    if (inQuote !== 0) {
      if (byte === inQuote && !isEscaped(trimmed, i)) {
        result = result + String.fromCharCode(targetQuote);
        inQuote = 0;
      } else result = result + trimmed.charAt(i);
      continue;
    }
    if (byte === targetQuote || byte === otherQuote) {
      result = result + String.fromCharCode(targetQuote);
      inQuote = byte;
    } else if (byte === 58 || byte === 44) {
      result = result + trimmed.charAt(i);
      if (next !== -1 && next !== 32) result = result + " ";
    } else if (byte === 123) {
      result = result + "{";
      if (next !== -1 && next !== 125 && next !== 32) result = result + " ";
    } else if (byte === 125) {
      if (result.length > 0) {
        const last = result.charCodeAt(result.length - 1);
        if (last !== 123 && last !== 32) result = result + " ";
      }
      result = result + "}";
    } else if (byte === 91) {
      result = result + "[";
      if (next === 93) result = result + " ";
    } else result = result + trimmed.charAt(i);
  }
  return result;
}

function isSpaceByte(c: number): boolean {
  return c === 32 || c === 10 || c === 13 || c === 9;
}

/** `desc` without "Default is .." at its end, which is made anew from `[name=value]`. */
export function stripDefaultIsSuffix(desc: string): string {
  const before = (pos: number): string => {
    let b = trimEnd(desc.substring(0, pos));
    if (b.endsWith(".")) b = b.substring(0, b.length - 1);
    return trimEnd(b);
  };
  const pos = desc.indexOf("Default is ");
  if (pos >= 0) return before(pos);
  const trimmed = trimEnd(desc);
  if (trimmed.endsWith("Default is")) return before(trimmed.length - "Default is".length);
  // The two words can be on two lines.
  let from = 0;
  while (true) {
    const at = desc.indexOf("Default", from);
    if (at < 0) break;
    const afterStart = at + 7;
    let spaces = 0;
    while (afterStart + spaces < desc.length && isSpaceByte(desc.charCodeAt(afterStart + spaces))) spaces = spaces + 1;
    if (spaces > 0 && desc.startsWith("is", afterStart + spaces) && afterStart + spaces + 2 < desc.length && isSpaceByte(desc.charCodeAt(afterStart + spaces + 2))) {
      return before(at);
    }
    from = at + 7;
  }
  return desc;
}

function trimEnd(s: string): string {
  return trimUnicodeWhitespaceEnd(s);
}

/** The comment `d` of the file, formatted. null: it stays as it is. `availableWidth`: the width of a line without the indentation of the comment. */
export function formatJsdocComment(d: number, options: JsdocOptions, formatOptions: FormatOptions, availableWidth: number, stack: Stack): FormattedJsdoc | null {
  const wrapWidth = availableWidth > LINE_PREFIX_LEN ? availableWidth - LINE_PREFIX_LEN : 0;
  return new JsdocFormatter(options, formatOptions, wrapWidth, stack).format(d);
}
