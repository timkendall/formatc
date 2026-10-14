// Port of vendor/bun/src/format/js/jsdoc/tag_formatters.rs: the kinds of tags.
import { embeddedOptions, formatEmbeddedJs, formatTypeViaFormatter, isJsTsLang, updateTemplateDepth } from "./embedded.ts";
import { OPTIONAL_TYPE, appendTrailingDot, capitalizeFirst, normalizeMarkdownEmphasis, normalizeType, normalizeTypePreserveQuotes, normalizeTypeReturn, stripJsdocStarsPreserveNewlines, stripOptionalTypeSuffix } from "./normalize.ts";
import { CONTINUATION_INDENT, JsdocFormatter, formatDefaultValue, isKnownTag, isNamedGenericTag, shouldPreserveDescriptionVerbatim, shouldSkipDescriptionFormatting, stripDefaultIsSuffix } from "./serialize.ts";
import { lines, trimStartMatchesCp } from "./text.ts";
import { isAllUnicodeWhitespace, splitUnicodeWhitespace, trimUnicodeWhitespace, trimUnicodeWhitespaceStart, utf8Length } from "../../../base/ustr.ts";
import {
  partParsed,
  partParsedPreservingWhitespace,
  tagCommentEnd,
  tagCommentStart,
  tagHasName,
  tagHasType,
  tagNameRaw,
  tagTypeCommentStart,
  tagTypeNameCommentStart,
  tagTypeParsed,
  tagTypeRaw,
} from "../../../lint/ast/jsdoc.ts";

/** `text` without the indentation that all its lines have, but at most `baseIndent` of it. */
function dedentLines(text: string, baseIndent: number): string {
  const ls = lines(text);
  let minIndent = baseIndent;
  for (let i = 0; i < ls.length; i++) {
    if (isAllUnicodeWhitespace(ls[i])) continue;
    const ind = ls[i].length - trimUnicodeWhitespaceStart(ls[i]).length;
    if (ind < minIndent) minIndent = ind;
  }
  let result = "";
  for (let index = 0; index < ls.length; index++) {
    if (index > 0) result = result + "\n";
    const line = ls[index];
    if (!isAllUnicodeWhitespace(line)) result = result + (minIndent <= line.length ? line.substring(minIndent) : trimUnicodeWhitespaceStart(line));
  }
  return result;
}

/** Whether an empty line is between a tag and `raw`, what follows it. */
function startsWithBlankLine(raw: string): boolean {
  const rest = trimStartMatchesCp(raw, 32);
  return rest.startsWith("\n\n") || rest.startsWith("\n \n");
}

/** The result of `splitDash`: `HAS_DASH[0]`, and the text. */
const HAS_DASH = new Int32Array(1);
/** `- text` is (true, text). */
function splitDash(text: string): string {
  if (text.startsWith("- ")) {
    HAS_DASH[0] = 1;
    return text.substring(2);
  }
  if (text === "-") {
    HAS_DASH[0] = 1;
    return "";
  }
  HAS_DASH[0] = 0;
  return text;
}

function endsWithSentenceMark(s: string): boolean {
  if (s.length === 0) return false;
  const c = s.charCodeAt(s.length - 1);
  return c === 46 || c === 33 || c === 63;
}

/** Appends `. Default is `value``. */
function pushDefault(out: string, value: string): string {
  let r = out;
  if (r.length > 0) r = r + (endsWithSentenceMark(r) ? " " : ". ");
  return r + "Default is `" + value + "`";
}

export function formatExampleTag(fm: JsdocFormatter, normalizedKind: string, tag: number): void {
  const rawText = partParsedPreservingWhitespace(tagCommentStart(tag), tagCommentEnd(tag));
  let code = trimUnicodeWhitespace(rawText);
  fm.contentLines.beginLine();
  let head = "@" + normalizedKind;
  // A caption stays on the line of the tag.
  const END = "</caption>";
  if (code.startsWith("<caption>")) {
    const rest = code.substring(9);
    const end = rest.indexOf(END);
    if (end >= 0) {
      head = head + " <caption>" + rest.substring(0, end + END.length);
      code = trimUnicodeWhitespace(rest.substring(end + END.length));
    }
  }
  fm.contentLines.append(head);
  formatExampleCode(fm, code);
}

/** Pushes the lines of formatted code. What is in a template literal is not indented. */
function pushFormattedCodeLines(fm: JsdocFormatter, code: string, indent: string): void {
  let templateDepth = 0;
  const ls = lines(code);
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    fm.contentLines.beginLine();
    if (line.length > 0 && templateDepth === 0) fm.contentLines.append(indent);
    fm.contentLines.append(line);
    templateDepth = updateTemplateDepth(line, templateDepth);
  }
}

function pushRawCodeLines(fm: JsdocFormatter, code: string, indent: string): void {
  const ls = lines(code);
  for (let i = 0; i < ls.length; i++) {
    const content = fm.options.keepUnparsableExampleIndent ? ls[i] : trimUnicodeWhitespace(ls[i]);
    fm.contentLines.beginLine();
    if (content.length > 0) fm.contentLines.append(indent + content);
  }
}

function formatExampleCode(fm: JsdocFormatter, code: string): void {
  if (code.length === 0) return;
  // Three backticks are JavaScript too, so fences are looked for first.
  const nl = code.indexOf("\n");
  if (nl >= 0) {
    const firstLine = code.substring(0, nl);
    const rest = code.substring(nl + 1);
    if (firstLine.startsWith("```")) {
      const closing = rest.lastIndexOf("\n```");
      if (closing >= 0) {
        formatExampleFencedBlock(fm, firstLine, rest.substring(0, closing), trimUnicodeWhitespace(rest.substring(closing + 1)));
        return;
      }
      if (trimUnicodeWhitespace(rest) === "```") {
        formatExampleFencedBlock(fm, firstLine, "", trimUnicodeWhitespace(rest));
        return;
      }
    }
  }
  const indent = fm.codeIndent();
  const effectiveWidth = fm.wrapWidth > fm.codeIndentWidth() ? fm.wrapWidth - fm.codeIndentWidth() : 0;
  // Something that is not code can be parsed as code all the same. Then it has many more lines afterwards.
  let formatted = formatEmbeddedJs(code, effectiveWidth, fm.formatOptions);
  if (formatted !== null && lines(formatted).length > lines(code).length * 2 + 1) formatted = null;
  if (formatted !== null) pushFormattedCodeLines(fm, formatted, indent);
  else pushRawCodeLines(fm, code, indent);
}

function formatExampleFencedBlock(fm: JsdocFormatter, langLine: string, innerCode: string, closingFence: string): void {
  const indent = fm.codeIndent();
  const effectiveWidth = fm.wrapWidth > fm.codeIndentWidth() ? fm.wrapWidth - fm.codeIndentWidth() : 0;
  fm.contentLines.push(indent + langLine);
  if (innerCode.length > 0) {
    const formatted = isJsTsLang(trimUnicodeWhitespace(langLine.substring(3))) ? formatEmbeddedJs(innerCode, effectiveWidth, fm.formatOptions) : null;
    if (formatted !== null) pushFormattedCodeLines(fm, formatted, indent);
    else pushRawCodeLines(fm, innerCode, indent);
  }
  fm.contentLines.push(indent + closingFence);
}

/** ` {type}` appended to `tagLine`. */
function pushType(fm: JsdocFormatter, tagLine: string, typeStr: string, hasNoSpaceBeforeType: boolean): string {
  let r = tagLine;
  // `@type{{` gets its space.
  if (!hasNoSpaceBeforeType || typeStr.startsWith("{")) r = r + " ";
  r = r + (fm.options.bracketSpacing ? "{ " : "{");
  r = r + typeStr;
  r = r + (fm.options.bracketSpacing ? " }" : "}");
  return r;
}

/** Pushes `description`, broken into lines and indented. */
function pushWrappedDesc(fm: JsdocFormatter, description: string): void {
  const wrapped = fm.wrapText(description, fm.indentedWidth(), 0);
  fm.pushIndentedDesc(CONTINUATION_INDENT, wrapped);
}

/** The same without an empty line at the start, for where there is one already. */
function pushWrappedDescAfterBlankLine(fm: JsdocFormatter, description: string, indent: string, width: number): void {
  const wrapped = fm.wrapText(description, width, 0);
  fm.pushIndentedDesc(indent, wrapped.startsWith("\n") ? wrapped.substring(1) : wrapped);
}

/** Pushes `prefix` and `description` behind it, broken into lines of which all but the first are indented. */
function pushDescBehind(fm: JsdocFormatter, prefix: string, description: string): void {
  const tagStringLength = prefix.length > 2 ? prefix.length - 2 : 0;
  const wrapped = fm.wrapText(description, fm.indentedWidth(), tagStringLength);
  fm.contentLines.beginLine();
  let out = prefix;
  const ls = wrapped.split("\n");
  for (let index = 0; index < ls.length; index++) {
    if (index > 0) {
      out = out + "\n";
      if (ls[index].length > 0) out = out + CONTINUATION_INDENT;
    }
    out = out + ls[index];
  }
  fm.contentLines.append(out);
}

function firstWordWidth(text: string): number {
  const words = splitUnicodeWhitespace(text);
  return words.length > 0 ? words[0].length : 0;
}

export function formatTypeNameCommentTag(fm: JsdocFormatter, normalizedKind: string, tag: number, shouldCapitalize: boolean, hasNoSpaceBeforeType: boolean): void {
  const tagPrefixLen = 1 + normalizedKind.length;
  let tagLine = "@" + normalizedKind;
  let isTypeOptional = false;
  let normalizedType = "";
  // `@typedef{import(...)}`: the type is taken as it is.
  const preserveQuotes = hasNoSpaceBeforeType;

  if (tagHasType(tag) && tagTypeParsed(tag).length > 0) {
    const raw = tagTypeRaw(tag);
    const rawInner = raw.substring(1, raw.length > 0 ? raw.length - 1 : 0);
    const rawWasMultiline = rawInner.indexOf("\n") >= 0;
    const typeToNormalize = stripOptionalTypeSuffix(tagTypeParsed(tag));
    isTypeOptional = OPTIONAL_TYPE.s0 !== 0;
    normalizedType = preserveQuotes ? normalizeTypePreserveQuotes(typeToNormalize, fm.stack) : normalizeType(typeToNormalize, fm.quoteStyle(), fm.stack);
    if (!preserveQuotes) {
      const isMultiline = typeToNormalize.indexOf("\n") >= 0;
      const wasMultiline = rawWasMultiline || isMultiline;
      // The formatter gets a type over several lines with its line breaks, so that it keeps them.
      let formatterInput = normalizedType;
      if (wasMultiline) {
        const stripped = stripJsdocStarsPreserveNewlines(isMultiline ? typeToNormalize : rawInner);
        formatterInput = stripped.split("*").join(" any ");
      }
      const inputHasLineBreak = formatterInput.indexOf("\n") >= 0;
      const typeOptions = embeddedOptions(fm.formatOptions, fm.wrapWidth);
      const formatted = formatTypeViaFormatter(formatterInput, typeOptions);
      if (formatted !== null) {
        // It is on one line now, which is too long.
        if (wasMultiline && inputHasLineBreak && formatted.indexOf("\n") < 0 && tagPrefixLen + 3 + utf8Length(formatted) > fm.wrapWidth) normalizedType = formatterInput;
        else normalizedType = formatted;
      } else if (wasMultiline && inputHasLineBreak) normalizedType = formatterInput;
    }
  }

  // The name and the default value.
  let name = "";
  let defaultValue: string | null = null;
  if (tagHasName(tag)) {
    const raw = tagNameRaw(tag);
    name = raw;
    if (isTypeOptional && !raw.startsWith("[")) name = "[" + raw + "]";
    else if (raw.startsWith("[") && raw.endsWith("]") && raw.indexOf("=") >= 0) {
      const equals = raw.indexOf("=");
      const value = trimUnicodeWhitespace(raw.substring(equals + 1, raw.length - 1));
      name = value === "" ? "[" + raw.substring(1, equals) + "]" : "[" + raw.substring(1, equals) + "=" + value + "]";
      defaultValue = value.length > 0 ? value : null;
    }
  }

  if (normalizedType.length > 0) tagLine = pushType(fm, tagLine, normalizedType, hasNoSpaceBeforeType);
  if (name.length > 0) tagLine = tagLine + " " + name;

  const descWithWhitespace = partParsedPreservingWhitespace(tagTypeNameCommentStart(tag), tagCommentEnd(tag));
  const descNormalized = normalizeMarkdownEmphasis(trimUnicodeWhitespace(descWithWhitespace));
  let descRaw = trimUnicodeWhitespace(descNormalized);

  // A type over several lines: the description comes after it.
  if (tagLine.indexOf("\n") >= 0) {
    fm.contentLines.push(tagLine);
    if (descRaw.length > 0) pushWrappedDesc(fm, descRaw);
    return;
  }

  // The default of `@template [T=Value]` is syntax.
  const defaultValueForDesc: string | null = defaultValue !== null && fm.options.addDefaultToDescription && normalizedKind !== "template" ? defaultValue : null;
  if (defaultValueForDesc !== null) descRaw = trimUnicodeWhitespace(stripDefaultIsSuffix(descRaw));
  if (descRaw.length === 0 && defaultValue === null) {
    fm.contentLines.push(tagLine);
    return;
  }
  if (startsWithBlankLine(descWithWhitespace) && descRaw.length > 0) {
    fm.contentLines.push(tagLine);
    fm.contentLines.pushEmpty();
    pushWrappedDesc(fm, descRaw);
    return;
  }
  const nl = descRaw.indexOf("\n");
  const firstLine = nl >= 0 ? descRaw.substring(0, nl) : descRaw;
  const restOfDesc: string | null = nl >= 0 ? descRaw.substring(nl + 1) : null;
  const firstTextLine = trimUnicodeWhitespace(firstLine);
  // Two spaces at the end of a line are a line break in Markdown.
  const firstHardBreak = restOfDesc !== null && firstLine.endsWith("  ");
  if (firstTextLine.startsWith("```")) {
    fm.contentLines.push(tagLine);
    fm.contentLines.pushEmpty();
    pushWrappedDescAfterBlankLine(fm, descRaw, CONTINUATION_INDENT, fm.indentedWidth());
    return;
  }
  let firstText = splitDash(firstTextLine);
  const hasDash = HAS_DASH[0] !== 0;
  if (shouldCapitalize) firstText = capitalizeFirst(firstText);
  if (firstText.length === 0 && defaultValueForDesc === null && restOfDesc === null) {
    fm.contentLines.push(tagLine);
    return;
  }
  const separator = hasDash ? " - " : " ";
  const remainingDesc = restOfDesc !== null ? dedentLines(restOfDesc, firstTextLine.length === 0 ? 0x7fffffff : 0) : "";
  const hasRemaining = !isAllUnicodeWhitespace(remainingDesc);
  const prefix = tagLine + separator;
  const prefixLen = prefix.length;
  let oneLinerLen = prefixLen + firstText.length;
  if (defaultValueForDesc !== null && !hasRemaining) oneLinerLen = oneLinerLen + 13 + utf8Length(defaultValueForDesc) + (firstText.length === 0 ? 0 : 2);

  if (!hasRemaining && oneLinerLen <= fm.wrapWidth) {
    let description = firstText;
    if (defaultValueForDesc !== null) description = pushDefault(description, defaultValueForDesc);
    else if (fm.options.descriptionWithDot) description = appendTrailingDot(description);
    fm.contentLines.push(prefix + description);
    return;
  }
  // `@param {Type} name -` and the description on the next line.
  if (hasDash && firstText.length === 0 && hasRemaining) {
    fm.contentLines.push(tagLine + " -");
    pushWrappedDesc(fm, remainingDesc);
    return;
  }
  let fullDesc = firstText;
  if (hasRemaining) {
    if (firstHardBreak) fullDesc = fullDesc + "  ";
    fullDesc = fullDesc + "\n" + remainingDesc;
  }
  if (defaultValueForDesc !== null) {
    // Even where there is nothing before it.
    fullDesc = fullDesc + (endsWithSentenceMark(fullDesc) ? " " : ". ") + "Default is `" + defaultValueForDesc + "`";
  }
  if (prefixLen + firstWordWidth(fullDesc) > fm.wrapWidth) {
    if (hasDash) tagLine = tagLine + " -";
    fm.contentLines.push(tagLine);
    pushWrappedDesc(fm, fullDesc);
  } else pushDescBehind(fm, prefix, fullDesc);
}

export function formatTypeCommentTag(fm: JsdocFormatter, normalizedKind: string, tag: number, shouldCapitalize: boolean, hasNoSpaceBeforeType: boolean): void {
  let tagLine = "@" + normalizedKind;
  const preserveQuotes = normalizedKind === "type" || normalizedKind === "satisfies";

  if (tagHasType(tag) && tagTypeParsed(tag).length > 0) {
    const rawType = tagTypeParsed(tag);
    let normalizedType = preserveQuotes ? normalizeTypePreserveQuotes(rawType, fm.stack) : normalizeTypeReturn(rawType, fm.quoteStyle(), fm.stack);
    // `@type{import('...')}` stays as it is.
    if (!(preserveQuotes && hasNoSpaceBeforeType && !normalizedType.startsWith("{"))) {
      const starStripped: string | null = rawType.indexOf("\n") >= 0 ? stripJsdocStarsPreserveNewlines(rawType) : null;
      const typeOptions = embeddedOptions(fm.formatOptions, fm.wrapWidth);
      const formatted = formatTypeViaFormatter(starStripped !== null ? starStripped : normalizedType, typeOptions);
      if (formatted !== null && starStripped !== null && formatted.indexOf("\n") < 0) normalizedType = starStripped;
      else if (formatted !== null) normalizedType = formatted;
      else if (starStripped !== null) normalizedType = starStripped;
    }
    tagLine = pushType(fm, tagLine, normalizedType, hasNoSpaceBeforeType);
  }

  const parsed = partParsed(tagTypeCommentStart(tag), tagCommentEnd(tag));
  const descNormalized = normalizeMarkdownEmphasis(trimUnicodeWhitespace(parsed));
  let descText = trimUnicodeWhitespace(descNormalized);
  if (descText.length === 0) {
    fm.contentLines.push(tagLine);
    return;
  }
  if (shouldCapitalize) descText = capitalizeFirst(descText);

  // A type over several lines: one word stays on its last line, more go on a line of their own.
  const lastLineBreak = tagLine.lastIndexOf("\n");
  if (lastLineBreak >= 0) {
    const lastLineWidth = tagLine.length - (lastLineBreak + 1);
    if (descText.indexOf(" ") < 0 && lastLineWidth + 1 + descText.length <= fm.wrapWidth) {
      fm.contentLines.push(tagLine + " " + descText);
    } else {
      fm.contentLines.push(tagLine);
      pushWrappedDesc(fm, descText);
    }
    return;
  }

  // The dash is not the marker of a list.
  descText = splitDash(descText);
  const hasDash = HAS_DASH[0] !== 0;
  const prefix = tagLine + (hasDash ? " - " : " ");
  const prefixLen = prefix.length;
  if (prefixLen + descText.length <= fm.wrapWidth || descText.length === 0) {
    fm.contentLines.push(prefix + descText);
    return;
  }
  if (prefixLen + firstWordWidth(descText) > fm.wrapWidth) {
    fm.contentLines.push(tagLine);
    pushWrappedDesc(fm, descText);
  } else pushDescBehind(fm, prefix, descText);
}

/** Pushes lines as they are. One with nothing but white space is empty. */
function pushRawLines(fm: JsdocFormatter, text: string): void {
  const ls = text.split("\n");
  for (let i = 0; i < ls.length; i++) fm.contentLines.push(isAllUnicodeWhitespace(ls[i]) ? "" : ls[i]);
}

function indexOfAnyWs(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) return i;
  }
  return -1;
}

export function formatGenericTag(fm: JsdocFormatter, normalizedKind: string, tag: number, shouldCapitalize: boolean): void {
  const tagLine = "@" + normalizedKind;
  const rawWithWhitespace = partParsedPreservingWhitespace(tagCommentStart(tag), tagCommentEnd(tag));
  const hasLeadingBlankLine = startsWithBlankLine(rawWithWhitespace);
  const descStartsOnNewLine = trimStartMatchesCp(rawWithWhitespace, 32).startsWith("\n");

  const parsed = partParsed(tagCommentStart(tag), tagCommentEnd(tag));
  const descNormalized = normalizeMarkdownEmphasis(trimUnicodeWhitespace(parsed));
  let descText = trimUnicodeWhitespace(descNormalized);
  // With the empty lines and the indentation in it.
  const rawNormalized = normalizeMarkdownEmphasis(trimUnicodeWhitespace(rawWithWhitespace));
  const rawDesc = trimUnicodeWhitespace(rawNormalized);
  const isRawMultiline = rawDesc.indexOf("\n") >= 0;
  if (descText.length === 0) {
    fm.contentLines.push(tagLine);
    return;
  }

  const isNamed = isNamedGenericTag(normalizedKind);
  if (normalizedKind === "default" || normalizedKind === "defaultValue") {
    descText = isRawMultiline ? descText : formatDefaultValue(descText, fm.quoteStyle());
  } else if (shouldCapitalize && isNamed && !hasLeadingBlankLine) {
    // The first word is a name. A type in braces, with the white space in it, counts as a word.
    const nameEnd = descText.startsWith("{") ? findBalancedBraceEnd(descText) : indexOfAnyWs(descText);
    if (nameEnd >= 0) {
      const name = descText.substring(0, nameEnd);
      const description = trimUnicodeWhitespaceStart(descText.substring(nameEnd));
      if (description.length > 0) descText = name + " " + capitalizeFirst(description);
    }
  } else if (shouldCapitalize) descText = capitalizeFirstSkipType(descText);
  const skipFormatting = shouldSkipDescriptionFormatting(normalizedKind);

  if (hasLeadingBlankLine) {
    fm.contentLines.push(tagLine);
    fm.contentLines.pushEmpty();
    if (skipFormatting && isRawMultiline) pushRawLines(fm, rawDesc);
    else if (skipFormatting) pushWrappedDescAfterBlankLine(fm, rawDesc, "", fm.wrapWidth);
    else pushWrappedDescAfterBlankLine(fm, descText, CONTINUATION_INDENT, fm.indentedWidth());
    return;
  }
  if (normalizedKind === "remarks" || normalizedKind === "privateRemarks") {
    fm.contentLines.push(tagLine);
    pushWrappedDesc(fm, descText);
    return;
  }
  const prefix = tagLine + " ";

  // `@categoryDescription Component` and the description on the next line.
  if (isNamed && descStartsOnNewLine && !skipFormatting) {
    const found = indexOfAnyWs(descText);
    const space = found >= 0 ? found : descText.length;
    const description = trimUnicodeWhitespaceStart(descText.substring(space));
    if (description.length === 0) fm.contentLines.push(prefix + descText);
    else {
      fm.contentLines.push(prefix + descText.substring(0, space));
      pushWrappedDesc(fm, description);
    }
    return;
  }

  const prefixLen = prefix.length;
  const isUnknown = !isKnownTag(normalizedKind);
  const skipWrapping = skipFormatting || isUnknown;
  if (skipWrapping && descStartsOnNewLine) {
    fm.contentLines.push(tagLine);
    pushRawLines(fm, rawDesc);
    return;
  }
  const fitsOnOneLine = prefixLen + descText.length <= fm.wrapWidth;
  // Anything else is broken into lines, which makes one space of line breaks and of several spaces.
  const isPlainOneLiner = fitsOnOneLine && descText.indexOf("\n") < 0 && descText.indexOf("  ") < 0;
  if (skipWrapping && isRawMultiline) fm.contentLines.push(prefix + rawDesc);
  else if (isPlainOneLiner || (skipWrapping && fitsOnOneLine)) fm.contentLines.push(prefix + descText);
  else if (shouldPreserveDescriptionVerbatim(normalizedKind) || isUnknown) fm.contentLines.push(prefix + rawDesc);
  // `@deprecated` gets no capital letter, but it is broken into lines.
  else if (skipWrapping) pushDescBehind(fm, prefix, rawDesc);
  else if (prefixLen + firstWordWidth(descText) > fm.wrapWidth) {
    fm.contentLines.push(tagLine);
    pushWrappedDesc(fm, descText);
  } else pushDescBehind(fm, prefix, descText);
}

/** The index behind the `}` that closes the `{` that `text` starts with; -1 if there is none. */
function findBalancedBraceEnd(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const c = text.charCodeAt(index);
    if (c === 123) depth = depth + 1;
    else if (c === 125) {
      depth = depth > 0 ? depth - 1 : 0;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** `capitalizeFirst` for what follows the `{type}` that `text` starts with, if it does. */
function capitalizeFirstSkipType(text: string): string {
  const end = text.startsWith("{") ? findBalancedBraceEnd(text) : -1;
  if (end < 0) return capitalizeFirst(text);
  const rest = trimUnicodeWhitespaceStart(text.substring(end));
  const capitalized = capitalizeFirst(rest);
  return capitalized === rest ? text : text.substring(0, end) + " " + capitalized;
}
