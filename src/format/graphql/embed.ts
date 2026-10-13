// Port of vendor/bun/src/format/graphql/embed.rs: GraphQL in the templates of JavaScript. Prettier's
// `language-js/embed/graphql.js`.
//
// What can be ported before the JavaScript formatter exists is here: the part of a template between two substitutions is
// parsed and printed (`writeTemplate`), and the line breaks between what Prettier's `printEmbedGraphQL` joins. What
// needs the JavaScript handles (`Expr`, `AstNodes`, the comments of the file) is not here and is marked `TODO(port)`:
//
//   - `isEmbedGraphql(e, f)` -- is this template GraphQL? (`gql`/`graphql` tag, `graphql(schema, `...`)`, or a
//     `/* GraphQL */` comment before it: `hasLanguageComment`, `followsLanguageComment`, `isLedByLanguageComment`,
//     `isBehindComment`; oxfmt's flavor takes the tag from `css/embed.ts` `rootNameOfTag`)
//   - `write_embedded_template_expression` -- `${expr}` written by the JavaScript formatter (`GqlTemplate.writeExpression`)
//
// THE ENTRY FOR THE JAVASCRIPT TEMPLATE PORTER (`js/print/template.ts`):
//
//   class JsGqlTemplate extends GqlTemplate { ... }   // overrides quasiCount, rawStart, rawEnd, cooked, writeExpression
//   if (isEmbedGraphql(e, f) && writeTemplate(new JsGqlTemplate(..), f)) return;   // else print the template as it is
//
// `writeTemplate` writes the template, from its first backtick to its last, to `f` (the formatter of the JavaScript file),
// and returns whether it did. It writes nothing and returns false if Prettier leaves the template alone: embedded
// formatting is off, a quasi has an invalid escape (`cooked` is null), or a part is not GraphQL.
// `hasEmbedLabel(template, f, tagAloneDecides)` is Rust `has_embed_label` without the tag test (the caller asks
// `isEmbedGraphql` first): whether Prettier gives the document of the template the label `embed`.
import { Formatter } from "../ir/formatter.ts";
import { token } from "../ir/element.ts";
import { EMBEDDED_AUTO, resolveLineEnding } from "../options.ts";
import { trimJsWhitespaceEnd, trimJsWhitespaceStart } from "../text.ts";
import { Attached, attach } from "./comments.ts";
import { builderFor } from "./mod.ts";
import { Tree, parse } from "./parser.ts";

const T_BACKTICK = token("`");
const T_EMPTY_TEMPLATE = token("``");

/**
 * The quasis of a template literal of JavaScript, as the JavaScript formatter has them. Subclass it (the methods must keep
 * these parameter lists): the defaults describe a template with one empty quasi.
 */
export class GqlTemplate {
  /** The number of quasis: one more than the number of substitutions. */
  quasiCount(): number {
    return 1;
  }
  /** Where the raw text of quasi `i` starts in `f.source`. */
  rawStart(i: number): number {
    return 0;
  }
  /** Where the raw text of quasi `i` ends in `f.source`. */
  rawEnd(i: number): number {
    return 0;
  }
  /** The cooked text of quasi `i` (WTF-8 bytes), or null if it has an escape that is not valid. */
  cooked(i: number): Uint8Array | null {
    return null;
  }
  /** Writes the substitution that follows quasi `i` to `f`: Rust `write_embedded_template_expression`. */
  writeExpression(i: number, f: Formatter): void {}
}

/** What is between two substitutions. */
const CONTENT_NOTHING = 0;
const CONTENT_COMMENTS = 1;
const CONTENT_DOCUMENT = 2;

/** The text between two substitutions. */
class Part {
  text: Uint8Array;
  /** Where `text` starts in `f.source` if it is a part of it, else -1. */
  srcOff: number;
  content: number;
  startsWithBlankLine: boolean;
  endsWithBlankLine: boolean;
  tree: Tree;
  att: Attached;
  constructor(text: Uint8Array, srcOff: number, content: number, startsWithBlankLine: boolean, endsWithBlankLine: boolean, tree: Tree, att: Attached) {
    this.text = text;
    this.srcOff = srcOff;
    this.content = content;
    this.startsWithBlankLine = startsWithBlankLine;
    this.endsWithBlankLine = endsWithBlankLine;
    this.tree = tree;
    this.att = att;
  }
}

function isAllWhitespace(text: Uint8Array, a: number, b: number): boolean {
  return trimJsWhitespaceStart(text, a, b) >= b;
}

/** `std::str::from_utf8(text).is_ok()` */
function isValidUtf8(text: Uint8Array): boolean {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const b = text[i] | 0;
    if (b < 0x80) {
      i = i + 1;
      continue;
    }
    let len = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) len = 2;
    else if (b >= 0xe0 && b <= 0xef) {
      len = 3;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      len = 4;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    } else return false;
    if (i + len > n) return false;
    const b1 = text[i + 1] | 0;
    if (b1 < lo || b1 > hi) return false;
    for (let k = 2; k < len; k++) {
      const c = text[i + k] | 0;
      if (c < 0x80 || c > 0xbf) return false;
    }
    i = i + len;
  }
  return true;
}

/** Null: Prettier leaves the template as it is. */
function parsePart(template: GqlTemplate, index: number, f: Formatter): Part | null {
  const source = f.source;
  const rawA = template.rawStart(index);
  const rawB = template.rawEnd(index);
  let hasBackslashOrCr = false;
  for (let i = rawA; i < rawB; i++) {
    const c = source[i] | 0;
    if (c === 92 || c === 13) {
      hasBackslashOrCr = true;
      break;
    }
  }
  const isAsWritten = !hasBackslashOrCr;
  let text: Uint8Array;
  let srcOff = -1;
  if (isAsWritten) {
    text = source.subarray(rawA, rawB);
    srcOff = rawA;
  } else {
    const cooked = template.cooked(index);
    if (cooked === null) return null;
    text = cooked;
    // Half of a surrogate pair, which an escape can stand for, is no character of GraphQL.
    if (!isValidUtf8(text)) return null;
  }
  const isLast = index + 1 === template.quasiCount();
  const n = text.length;

  // The lines: `text` split at `\n`.
  let count = 1;
  let lastLineStart = 0;
  let hasOnlyComments = true;
  let lineStart = 0;
  // The first two and the last two lines, for the blank lines at the ends.
  let firstBlank = false;
  let secondBlank = false;
  let prevBlank = false;
  let lastBlank = false;
  while (true) {
    let lineEnd = lineStart;
    while (lineEnd < n && (text[lineEnd] | 0) !== 10) lineEnd = lineEnd + 1;
    const s = trimJsWhitespaceStart(text, lineStart, lineEnd);
    const isBlank = s >= lineEnd;
    if (!(isBlank || (text[s] | 0) === 35)) hasOnlyComments = false;
    if (count === 1) firstBlank = isBlank;
    if (count === 2) secondBlank = isBlank;
    prevBlank = lastBlank;
    lastBlank = isBlank;
    lastLineStart = lineStart;
    if (lineEnd >= n) break;
    count = count + 1;
    lineStart = lineEnd + 1;
  }
  // A substitution in a comment.
  if (!isLast) {
    for (let i = lastLineStart; i < n; i++) {
      if ((text[i] | 0) === 35) return null;
    }
  }
  let content = CONTENT_NOTHING;
  const tree = new Tree();
  const att = new Attached();
  if (!hasOnlyComments) {
    if (parse(text, tree) < 0) return null;
    attach(text, tree, att);
    content = CONTENT_DOCUMENT;
  } else if (isAllWhitespace(text, 0, n)) {
    content = CONTENT_NOTHING;
  } else {
    content = CONTENT_COMMENTS;
  }
  return new Part(text, srcOff, content, count > 2 && firstBlank && secondBlank, count > 2 && prevBlank && lastBlank, tree, att);
}

/** Whether Prettier formats the template at all (it is `isEmbedGraphql` that says whether it is GraphQL). */
export function isCandidate(template: GqlTemplate, f: Formatter): boolean {
  if (f.options.embeddedLanguageFormatting !== EMBEDDED_AUTO) return false;
  const n = template.quasiCount();
  for (let i = 0; i < n; i++) {
    if (template.cooked(i) === null) return false;
  }
  return true;
}

function isBlankTemplate(template: GqlTemplate, f: Formatter): boolean {
  return template.quasiCount() === 1 && isAllWhitespace(f.source, template.rawStart(0), template.rawEnd(0));
}

/** The parts of the template, or null if one of them is not GraphQL. */
function parseParts(template: GqlTemplate, f: Formatter): Part[] | null {
  const parts: Part[] = [];
  const n = template.quasiCount();
  for (let i = 0; i < n; i++) {
    const part = parsePart(template, i, f);
    if (part === null) return null;
    parts.push(part);
  }
  return parts;
}

/**
 * Whether the template, with or without a tag, that `isEmbedGraphql` has said is GraphQL is more than ` `` `: for Prettier,
 * its document has the label `embed`. `tagAloneDecides`: Rust `css::embed::tag_alone_decides_what_is_around_a_template(f)`.
 */
export function hasEmbedLabel(template: GqlTemplate, f: Formatter, tagAloneDecides: boolean): boolean {
  return isCandidate(template, f) && (tagAloneDecides || (!isBlankTemplate(template, f) && parseParts(template, f) !== null));
}

/** The line breaks between what Prettier's `printEmbedGraphQL` joins. */
let separatorIsNeeded: boolean = false;
let separatorHasBlankLine: boolean = false;

function writeSeparator(f: Formatter): void {
  if (separatorIsNeeded) {
    if (separatorHasBlankLine) f.emptyLine();
    else f.hardLineBreak();
  }
  separatorIsNeeded = true;
  separatorHasBlankLine = false;
}

/**
 * Writes the template as GraphQL, if that is what Prettier takes it for (the caller has asked `isEmbedGraphql`). Returns
 * whether it has: if not, nothing is written.
 */
export function writeTemplate(template: GqlTemplate, f: Formatter): boolean {
  if (!isCandidate(template, f)) return false;
  if (isBlankTemplate(template, f)) {
    f.token(T_EMPTY_TEMPLATE);
    return true;
  }
  const parts = parseParts(template, f);
  if (parts === null) return false;

  const lineEnding = resolveLineEnding(f.options.lineEnding, f.source);
  f.token(T_BACKTICK);
  f.startIndent();
  f.hardLineBreak();
  separatorIsNeeded = false;
  separatorHasBlankLine = false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const isFirst = index === 0;
    const isLast = index + 1 === parts.length;
    if (part.content === CONTENT_NOTHING) {
      if (!isFirst && !isLast && part.startsWithBlankLine) separatorHasBlankLine = true;
    } else {
      if (!isFirst && part.startsWithBlankLine) separatorHasBlankLine = true;
      writeSeparator(f);
      const builder = builderFor(f, part.text, part.srcOff, part.tree, part.att, true, lineEnding);
      if (part.content === CONTENT_DOCUMENT) builder.printDefinitions();
      else builder.printCommentLines();
      if (!isLast && part.endsWithBlankLine) separatorHasBlankLine = true;
    }
    if (!isLast) {
      writeSeparator(f);
      // The substitution may hold a template of its own: the separator is state of this call.
      const isNeeded: boolean = separatorIsNeeded;
      const hasBlank: boolean = separatorHasBlankLine;
      template.writeExpression(index, f);
      separatorIsNeeded = isNeeded;
      separatorHasBlankLine = hasBlank;
    }
  }
  f.endIndent();
  f.hardLineBreak();
  f.token(T_BACKTICK);
  return true;
}
