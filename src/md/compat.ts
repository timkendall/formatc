// Port of vendor/bun/src/md/compat.rs.
//
// Where micromark, which Prettier parses Markdown with, does not do what CommonMark says, and what `bun fmt` prints for
// real documents depends on it. Each is behind `Options.micromark`, which only the formatter sets, or behind
// `Options.micromarkToTheLetter`: what oxfmt's parser, which follows micromark, leaves out on purpose. And what
// Prettier makes of MDX, with remark-parse 8: `Options.mdx`.
import type { Flags } from "./options.ts";

/**
 * A complete tag on a line of its own does not end a paragraph. To micromark it does if the line lacks the markers of
 * the containers that the paragraph is in, and the HTML is in those containers all the same.
 */
export function completeTagEndsLazyParagraph(flags: Flags): boolean {
  return flags.micromark;
}

/**
 * Whether `*` and `_` can open or close emphasis depends on what is next to them. To micromark, a run with another
 * marker (`*`, `_`, `~`) behind it is left-flanking, one with another marker before it right-flanking, whatever is on
 * the other side.
 */
export function markerNextToMarkerFlanks(flags: Flags): boolean {
  return flags.micromark;
}

/** micromark looks at UTF-16 code units: half of a surrogate pair is no punctuation and no white space. */
export function astralIsALetter(flags: Flags): boolean {
  return flags.micromarkToTheLetter;
}

/** Two blanks at the end of a line are a hard break. To micromark they are not if there is a tab in the white space before them. */
export function tabBeforeTheBlanksIsNoHardBreak(flags: Flags): boolean {
  return flags.micromark;
}

/**
 * An empty list item and an ordered list that does not start with 1 cannot interrupt a paragraph. To micromark they
 * cannot follow indented code either, with or without empty lines between, and on a line that interrupts one of the two
 * no container in the first one can be such a list.
 */
export function whatInterruptsDoesSoForTheWholeLine(flags: Flags): boolean {
  return flags.micromarkToTheLetter;
}

/** A title in parentheses has no `(` in it that is not escaped. To micromark it can: the first `)` ends it. */
export function parenthesisCanBeInATitle(flags: Flags): boolean {
  return flags.micromarkToTheLetter;
}

/** The last line of a paragraph is the header of a table if a delimiter row follows it. To micromark it is not if it is indented by four columns. */
export function indentedLineIsNoTableHeader(flags: Flags): boolean {
  return flags.micromark;
}

/** remark-parse 8 with the option `blocks` as Prettier sets it: a line that starts with any tag, whatever its name, starts HTML, also in a paragraph. */
export function everyTagStartsHtml(flags: Flags): boolean {
  return flags.mdx;
}

/** remark-parse 8: the header of a table is not a line of a paragraph. */
export function tableDoesNotInterruptAParagraph(flags: Flags): boolean {
  return flags.mdx;
}

/** remark-parse 8: the header of a table need not have as many cells as the row under it. */
export function tableHeaderHasAnyNumberOfCells(flags: Flags): boolean {
  return flags.mdx;
}

/** remark-parse 8: HTML ends a paragraph, but not the list items that the paragraph is in, however little it is indented. */
export function tagDoesNotEndAList(flags: Flags): boolean {
  return flags.mdx;
}

/** remark-parse 8: the line behind the marker of a list item with nothing else on its line is in the item, however little it is indented. */
export function textGoesOnInAnEmptyItem(flags: Flags): boolean {
  return flags.mdx;
}

/** remark-parse 8: `*` starts and ends emphasis whatever is next to it. */
export function asterisksDoNotLookAround(flags: Flags): boolean {
  return flags.mdx;
}

/** remark-parse 8: a line with nothing but blanks on it does not end HTML. */
export function onlyALineWithoutBlanksEndsHtml(flags: Flags): boolean {
  return flags.mdx;
}
