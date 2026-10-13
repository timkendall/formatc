// Port of vendor/bun/src/lint/ast/jsdoc.rs: the JSDoc comments of a file (`File::jsdoc`), as the crate oxc_jsdoc reads them. Where the parts are
// is read by src/sema/check/jsdoc.ts, once for a file (on the first question).
//
// Handles are numbers: a JSDoc comment `d` is its index among the JSDoc comments of the file (`jsdocAt(start)`), a tag `t` is a row of the tags of
// the file (`jsdocTag(d, i)`). A "part" (a description) is a range `(start, end)` of the text: `partParsed`, `partParsedPreservingWhitespace`,
// `partIsEmpty` read it. Text is a JavaScript string here (the formatter of JSDoc works on strings): white space is `char::is_whitespace` and bytes
// that are not UTF-8 are U+FFFD.
import { hir } from "../../sema/hir.ts";
import { F } from "./state.ts";
import { Outline, TAG_STRIDE, TG_AT, TG_DEFAULT_END, TG_END, TG_NAME_END, TG_NAME_START, TG_NAME_STOP, TG_TEXT, TG_TY_END, TG_TY_START, outlineRead } from "../../sema/check/jsdoc.ts";
import {
  codePointAt,
  decodeBytes,
  isAlphanumeric,
  linesOf,
  trimUnicodeWhitespace,
  trimUnicodeWhitespaceStart,
} from "../../base/ustr.ts";

const outline = new Outline();

function ensureOutline(): void {
  if (F.jsdocBuilt) return;
  F.jsdocBuilt = true;
  outlineRead(hir.text, hir.comments.data, (hir.comments.len / 2) | 0, outline);
}

/** `File::slice(start, end)` as a string; empty if it is not in the text. */
export function sourceSlice(start: number, end: number): string {
  if (start < 0 || end > (hir.sourceLen | 0) || start >= end) return "";
  return decodeBytes(hir.text, start, end);
}

/** `file.jsdoc().at(start)`: the comment whose `/**` is at `start`, or -1. */
export function jsdocAt(start: number): number {
  ensureOutline();
  return outline.indexAt(start);
}

/** With the `/**` and the `*&#47;`: `[jsdocCommentStart(d), jsdocCommentEnd(d))`. */
export function jsdocCommentStart(d: number): number {
  return outline.starts.data[d] | 0;
}
export function jsdocCommentEnd(d: number): number {
  return outline.ends.data[d] | 0;
}

/** `JSDoc::span`: what is between the `/**` and the `*&#47;`. */
export function jsdocSpanStart(d: number): number {
  return (outline.starts.data[d] | 0) + 3;
}
export function jsdocSpanEnd(d: number): number {
  const e = outline.ends.data[d] | 0;
  return e > 2 ? e - 2 : 0;
}

/** `/***&#47;`, `/*****&#47;`: no JSDoc comment for oxc. */
export function jsdocIsAllAsterisks(d: number): boolean {
  const s = jsdocSpanStart(d);
  const e = jsdocSpanEnd(d);
  for (let i = s; i < e; i++) if ((hir.text[i] | 0) !== 42) return false;
  return true;
}

export function jsdocTagCount(d: number): number {
  return outline.tagCount.data[d] | 0;
}

/** The tag `i` of the comment `d` (a row). */
export function jsdocTag(d: number, i: number): number {
  return ((outline.firstTag.data[d] | 0) + i) | 0;
}

/** `JSDoc::comment`: what is before the first tag. A part is `(start, end)`. */
export function jsdocCommentPartStart(d: number): number {
  return jsdocSpanStart(d);
}
export function jsdocCommentPartEnd(d: number): number {
  if ((outline.tagCount.data[d] | 0) > 0) return outline.tags.data[(outline.firstTag.data[d] | 0) * TAG_STRIDE + TG_AT] | 0;
  return jsdocSpanEnd(d);
}

function col(t: number, c: number): number {
  return outline.tags.data[t * TAG_STRIDE + c] | 0;
}

/** From the `@` to the next tag. */
export function tagStart(t: number): number {
  return col(t, TG_AT);
}
export function tagEnd(t: number): number {
  return col(t, TG_END);
}

/** `tag.kind.parsed()`: without the `@`. */
export function tagKindParsed(t: number): string {
  return sourceSlice(col(t, TG_AT) + 1, col(t, TG_NAME_END));
}

/** `@kind comment`: the part. */
export function tagCommentStart(t: number): number {
  return col(t, TG_NAME_END);
}
export function tagCommentEnd(t: number): number {
  return col(t, TG_END);
}

/** `@kind {type} comment`: the part after the type, if there is one. */
export function tagTypeCommentStart(t: number): number {
  return col(t, TG_TY_END) === 0 ? col(t, TG_NAME_END) : col(t, TG_TY_END);
}

/** `@kind {type} name comment`: the part after the name. */
export function tagTypeNameCommentStart(t: number): number {
  return col(t, TG_TEXT);
}

export function tagHasType(t: number): boolean {
  return col(t, TG_TY_END) !== 0;
}

/** With the braces. */
export function tagTypeRaw(t: number): string {
  return sourceSlice(col(t, TG_TY_START), col(t, TG_TY_END));
}

/** Without them and the white space in them. */
export function tagTypeParsed(t: number): string {
  const raw = tagTypeRaw(t);
  const end = raw.length > 0 ? raw.length - 1 : 0;
  return trimUnicodeWhitespace(raw.substring(1, end));
}

export function tagHasName(t: number): boolean {
  return col(t, TG_NAME_STOP) !== 0;
}

export function tagNameRaw(t: number): string {
  return sourceSlice(col(t, TG_NAME_START), col(t, TG_NAME_STOP));
}

/** It is in brackets. */
export function tagNameIsOptional(t: number): boolean {
  const raw = tagNameRaw(t);
  return raw.startsWith("[") && raw.endsWith("]");
}

/** And has a `=`. */
export function tagNameHasDefault(t: number): boolean {
  // `Range::is_some` is `end != 0`.
  return col(t, TG_DEFAULT_END) !== 0;
}

/** The name alone. */
export function tagNameParsed(t: number): string {
  const raw = tagNameRaw(t);
  if (!(raw.startsWith("[") && raw.endsWith("]"))) return raw;
  let a = 0;
  while (a < raw.length && raw.charCodeAt(a) === 91) a = a + 1;
  let b = raw.length;
  while (b > a && raw.charCodeAt(b - 1) === 93) b = b - 1;
  const inner = trimUnicodeWhitespace(raw.substring(a, b));
  const eq = inner.indexOf("=");
  return eq >= 0 ? trimUnicodeWhitespace(inner.substring(0, eq)) : inner;
}

/** `@kind{type}`. The formatter's own. */
export function tagHasNoSpaceBeforeType(t: number): boolean {
  const at = col(t, TG_NAME_END);
  return at < (hir.sourceLen | 0) && (hir.text[at] | 0) === 123;
}

/** `*word*` at the start of a line is emphasis, not the `*` that starts a line of the comment. Returns what follows the `*`, or null. */
function withoutStar(trimmed: string): string | null {
  if (trimmed.length === 0 || trimmed.charCodeAt(0) !== 42) return null;
  const rest = trimmed.substring(1);
  if (rest.length > 0) {
    const c = codePointAt(rest, 0);
    if (isAlphanumeric(c) || c === 95) return null;
  }
  return rest;
}

/** Without the `*` at the start of each line, the white space around each line, and empty lines. */
export function partParsed(start: number, end: number): string {
  const raw = sourceSlice(start, end);
  const isMultiline = raw.indexOf("\n") >= 0;
  const out: string[] = [];
  const parts = raw.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const trimmed = trimUnicodeWhitespace(parts[i]);
    let line = trimmed;
    if (isMultiline) {
      const rest = withoutStar(trimmed);
      if (rest !== null) line = trimUnicodeWhitespaceStart(rest);
    }
    if (line.length > 0) out.push(line);
  }
  return out.join("\n");
}

/**
 * Without the `*` at the start of each line. Empty lines stay, the indentation behind `* ` stays, two blanks at the end of a line stay.
 */
export function partParsedPreservingWhitespace(start: number, end: number): string {
  const raw = sourceSlice(start, end);
  if (raw.indexOf("\n") < 0) return trimUnicodeWhitespace(raw);
  let result = "";
  const lines = linesOf(raw);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (index > 0) result = result + "\n";
    const trimmed = trimUnicodeWhitespace(line);
    let content = trimmed;
    const rest = withoutStar(trimmed);
    if (rest !== null) content = rest.startsWith(" ") ? rest.substring(1) : rest;
    result = result + content;
    // Two spaces at the end of a line are a line break in Markdown.
    if (line.endsWith("  ") && content.length > 0) result = result + "  ";
  }
  return result;
}

/** `parsed().is_empty()` */
export function partIsEmpty(start: number, end: number): boolean {
  return partParsed(start, end).length === 0;
}
