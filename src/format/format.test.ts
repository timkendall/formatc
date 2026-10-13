// Self-test of the crate-level files of src/format: options, text, pragma, front matter, syntax errors, sort.
// `node src/format/format.test.ts` and the compiled binary print the same.
import { ByteBuf } from "../base/bytebuf.ts";
import { asciiBytes, utf8Bytes } from "../base/bytes.ts";
import * as O from "./options.ts";
import * as X from "./text.ts";
import { beforeParsing, hasIgnorePragma, hasPragma, insertPragma } from "./pragma.ts";
import { parseFrontMatter } from "./front_matter.ts";
import { MSG_UNCLOSED_STRING, SyntaxError, messageText, noteRefusal, refusalReason } from "./syntax_error.ts";
import { sortInt32By, sortInt32ByKey } from "./sort.ts";
import { FORMAT_NESTED_TOO_DEEPLY, isTooLong } from "./errors.ts";

let total = 0;
let failures = 0;
function check(name: string, actual: string, expected: string): void {
  total = total + 1;
  if (actual === expected) return;
  failures = failures + 1;
  console.log("FAIL " + name + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}
function checkNum(name: string, actual: number, expected: number): void {
  check(name, "" + actual, "" + expected);
}
function checkBool(name: string, actual: boolean, expected: boolean): void {
  check(name, "" + actual, "" + expected);
}

function b(s: string): Uint8Array {
  return utf8Bytes(s);
}

// ───────────────────────────── options ─────────────────────────────
{
  const o = new O.FormatOptions();
  checkNum("default width", o.lineWidth, 80);
  checkNum("default indent", o.indentWidth, 2);
  checkBool("set printWidth", o.set("printWidth", "100"), true);
  checkNum("printWidth", o.lineWidth, 100);
  checkBool("set printWidth Infinity", o.set("printWidth", "Infinity"), true);
  checkNum("printWidth Infinity", o.lineWidth, 4294967295);
  checkBool("printWidth fraction", o.set("printWidth", "1.5"), false);
  checkBool("printWidth junk", o.set("printWidth", "abc"), false);
  checkBool("set printWidth negative", o.set("printWidth", "-5"), true);
  checkNum("printWidth negative", o.lineWidth, 0);
  checkBool("tabWidth negative", o.set("tabWidth", "-1"), false);
  checkBool("tabWidth", o.set("tabWidth", "4"), true);
  checkNum("tabWidth value", o.indentWidth, 4);
  checkBool("set semi", o.set("semi", "false"), true);
  checkNum("semi false", o.semicolons, O.SEMICOLONS_AS_NEEDED);
  checkBool("semi junk", o.set("semi", "yes"), false);
  checkBool("set useTabs", o.set("useTabs", "true"), true);
  checkNum("useTabs", o.indentStyle, O.INDENT_TAB);
  checkBool("set singleQuote", o.set("singleQuote", "true"), true);
  checkNum("singleQuote", o.quoteStyle, O.QUOTE_SINGLE);
  checkBool("set quoteProps", o.set("quoteProps", "consistent"), true);
  checkNum("quoteProps", o.quoteProperties, O.QUOTE_PROPS_CONSISTENT);
  checkBool("set trailingComma", o.set("trailingComma", "none"), true);
  checkNum("trailingComma", o.trailingCommas, O.TRAILING_COMMAS_NONE);
  checkBool("set arrowParens", o.set("arrowParens", "avoid"), true);
  checkNum("arrowParens", o.arrowParentheses, O.ARROW_PARENS_AS_NEEDED);
  checkBool("set objectWrap", o.set("objectWrap", "collapse"), true);
  checkNum("objectWrap", o.expand, O.EXPAND_NEVER);
  checkBool("set endOfLine", o.set("endOfLine", "crlf"), true);
  checkNum("endOfLine", o.lineEnding, O.LINE_ENDING_CRLF);
  checkBool("set proseWrap", o.set("proseWrap", "always"), true);
  checkNum("proseWrap", o.proseWrap, O.PROSE_WRAP_ALWAYS);
  checkBool("set rangeEnd Infinity", o.set("rangeEnd", "Infinity"), true);
  checkNum("rangeEnd Infinity", o.rangeEnd, -1);
  checkBool("set rangeStart", o.set("rangeStart", "12"), true);
  checkNum("rangeStart", o.rangeStart, 12);
  checkBool("jsxBracketSameLine", o.set("jsxBracketSameLine", "true"), true);
  checkBool("bracketSameLine", o.bracketSameLine, true);
  checkBool("jsxBracketSameLine false keeps", o.set("jsxBracketSameLine", "false"), true);
  checkBool("bracketSameLine kept", o.bracketSameLine, true);
  checkBool("set flavor", o.set("flavor", "oxfmt"), true);
  checkBool("oxfmt", O.flavorIsOxfmt(o.flavor), true);
  checkBool("unknown option", o.set("nope", "1"), false);
  checkBool("jsdoc option", o.set("jsdoc.descriptionWithDot", "true"), true);
  checkBool("jsdoc enabled by its option", o.jsdoc !== null, true);
  checkBool("jsdoc value", o.jsdoc !== null && o.jsdoc.descriptionWithDot, true);
  checkBool("jsdoc junk", o.set("jsdoc.commentLineStrategy", "x"), false);
  checkBool("sortPackageJson", o.set("sortPackageJson", "true"), true);
  checkBool("sortPackageJson on", o.sortPackageJson, true);
  checkBool("copy", o.copy().lineWidth === 0 && o.copy().jsdoc !== null && o.copy().rangeStart === 12, true);
  const c = o.copy();
  c.lineWidth = 5;
  checkNum("copy is independent", o.lineWidth, 0);
  checkBool("ignore comment prettier", O.flavorIsIgnoreComment(O.FLAVOR_PRETTIER, "oxfmt-ignore"), false);
  checkBool("ignore comment oxfmt", O.flavorIsIgnoreComment(O.FLAVOR_OXFMT, "oxfmt-ignore"), true);
  checkNum("quote other", O.quoteStyleOther(O.QUOTE_DOUBLE), O.QUOTE_SINGLE);
  checkNum("quote byte", O.quoteStyleAsByte(O.QUOTE_SINGLE), 39);
  checkNum("trailing separator none", O.trailingSeparator(O.FTC_ALL, o), O.TRAILING_SEPARATOR_OMIT);
  const d = new O.FormatOptions();
  checkNum("trailing separator", O.trailingSeparator(O.FTC_ALL, d), O.TRAILING_SEPARATOR_ALLOWED);
  d.trailingCommas = O.TRAILING_COMMAS_ES5;
  checkNum("es5 omits all", O.trailingSeparator(O.FTC_ALL, d), O.TRAILING_SEPARATOR_OMIT);
  checkNum("es5 allows es5", O.trailingSeparator(O.FTC_ES5, d), O.TRAILING_SEPARATOR_ALLOWED);
  d.trailingCommas = O.TRAILING_COMMAS_ALL;
  d.inHtml.root = O.HTML_ROOT_NG_ACTION;
  checkNum("angular omits arguments", O.trailingSeparator(O.FTC_ARGUMENTS, d), O.TRAILING_SEPARATOR_OMIT);
  checkNum("angular keeps all", O.trailingSeparator(O.FTC_ALL, d), O.TRAILING_SEPARATOR_ALLOWED);
  checkNum("auto line ending", O.resolveLineEnding(O.LINE_ENDING_AUTO, b("a\r\nb")), O.LINE_ENDING_CRLF);
  checkNum("auto line ending cr", O.resolveLineEnding(O.LINE_ENDING_AUTO, b("a\rb\n")), O.LINE_ENDING_CR);
  checkNum("auto line ending lf", O.resolveLineEnding(O.LINE_ENDING_AUTO, b("a\nb\r\n")), O.LINE_ENDING_CRLF);
  checkNum("lf stays", O.resolveLineEnding(O.LINE_ENDING_LF, b("a\r\nb")), O.LINE_ENDING_LF);
}

// ───────────────────────────── text ─────────────────────────────
{
  const t = b("  a\t b /* c */ // d\n  \n x");
  checkNum("skipSpaces", X.skipSpaces(t, 0), 2);
  checkNum("skipSpacesBackwards", X.skipSpacesBackwards(t, 2), 0);
  checkNum("skipNewline", X.skipNewline(b("a\r\nb"), 1), 3);
  checkNum("skipNewline back", X.skipNewlineBackwards(b("a\r\nb"), 3), 1);
  checkNum("skipNewline u2028", X.skipNewline(b(" x"), 0), 3);
  checkNum("skipInlineComment", X.skipInlineComment(b("/* c */x"), 0), 7);
  checkNum("skipInlineComment open", X.skipInlineComment(b("/* c x"), 0), 0);
  checkNum("skipTrailingComment", X.skipTrailingComment(b("// c\nx"), 0), 4);
  checkBool("hasNewline", X.hasNewline(b("a  \nb"), 1), true);
  checkBool("hasNewline no", X.hasNewline(b("a  b\n"), 1), false);
  checkBool("hasNewlineBackwards", X.hasNewlineBackwards(b("a\n  b"), 4), true);
  checkBool("isNextLineEmpty", X.isNextLineEmpty(b("a;\n\nb"), 1), true);
  checkBool("isNextLineEmpty no", X.isNextLineEmpty(b("a;\nb"), 1), false);
  checkBool("isNextLineEmpty comma", X.isNextLineEmpty(b("a, // c\n\nb"), 1), true);
  checkBool("isPreviousLineEmpty", X.isPreviousLineEmpty(b("a\n\n  b"), 5), true);
  checkBool("isFollowedByEmptyLine", X.isFollowedByEmptyLine(b("a  \n\nb"), 1), true);
  checkNum("jsWhitespaceLen nbsp", X.jsWhitespaceLen(b(" a"), 0, 3), 2);
  checkNum("jsWhitespaceLen bom", X.jsWhitespaceLen(b("﻿a"), 0, 4), 3);
  checkNum("jsWhitespaceLen none", X.jsWhitespaceLen(b("a"), 0, 1), 0);
  const w = b(" \t a b \n");
  checkNum("trimStart", X.trimJsWhitespaceStart(w, 0, w.length), 3);
  checkNum("trimEnd", X.trimJsWhitespaceEnd(w, 0, w.length), 6);
  const out = new ByteBuf(16);
  const content = b("it's \"q\" \\' \\\"");
  X.makeString(content, 0, content.length, 34, out);
  check("makeString double", out.toUtf8(), "\"it's \\\"q\\\" ' \\\"\"");
  out.reset();
  X.makeString(content, 0, content.length, 39, out);
  check("makeString single", out.toUtf8(), "'it\\'s \"q\" \\' \"'");
  checkBool("hash pragma", X.hasPragmaInHashComment(b("# @format\nkey: 1"), "format", "prettier"), true);
  checkBool("hash pragma none", X.hasPragmaInHashComment(b("# hello\nkey: 1"), "format", "prettier"), false);
  checkBool("hash pragma prefix", X.hasPragmaInHashComment(b("# @formatted\nkey: 1"), "format", "prettier"), false);
  checkBool("endsWithIgnoreAsciiCase", X.endsWithIgnoreAsciiCase(b("foo.TEST.each"), 0, 13, ".Each"), true);
  const lower = new ByteBuf(8);
  X.appendLowerCase(b("AbC É"), 0, 6, lower);
  check("lower case", lower.toUtf8(), "abc é");
  checkNum("firstChar", X.firstChar(b("中x"), 0, 4), 0x4e2d);
  checkNum("firstChar len", X.charLen(), 3);
  checkNum("lastChar", X.lastChar(b("x中"), 0, 4), 0x4e2d);
  checkNum("indexOfFrom", X.indexOfFrom(b("abcabc"), "ca", 1), 2);
  checkNum("indexOfFrom none", X.indexOfFrom(b("abcabc"), "ca", 3), -1);
  const set = new X.ByteSet(",;");
  checkNum("ByteSet find", set.find(b("ab;c,"), 0, 5), 2);
  checkNum("ByteSet none", set.find(b("abc"), 0, 3), -1);
}

// ───────────────────────────── pragma ─────────────────────────────
{
  const o = new O.FormatOptions();
  checkBool("hasPragma format", hasPragma(b("/** @format */\nx")), true);
  checkBool("hasPragma prettier", hasPragma(b("/**\n * @prettier\n */\nx")), true);
  checkBool("hasPragma none", hasPragma(b("/** hello */\nx")), false);
  checkBool("hasPragma not first", hasPragma(b("x\n/** @format */")), false);
  checkBool("hasPragma shebang", hasPragma(b("#!/usr/bin/env node\n/** @format */\nx")), true);
  checkBool("hasPragma after blank", hasPragma(b("\n\n/** @format */\nx")), true);
  checkBool("hasIgnorePragma", hasIgnorePragma(b("/** @noformat */\nx")), true);
  checkBool("hasIgnorePragma prettier", hasIgnorePragma(b("// @noprettier\nx")), false);
  checkBool("hasPragma line comment", hasPragma(b("// @format\nx")), false);
  checkBool("hasPragma with value", hasPragma(b("/** @format yes */\nx")), true);
  checkBool("hasPragma not a word", hasPragma(b("/** @formatted */\nx")), false);

  const ins = (s: string): string => {
    const out = new ByteBuf(64);
    insertPragma(b(s), out);
    return out.toUtf8();
  };
  check("insert plain", ins("let a = 1;\n"), "/** @format */\n\nlet a = 1;\n");
  check("insert flow", ins("/** @flow */\nlet a = 1;\n"), "/**\n * @format\n * @flow\n */\n\nlet a = 1;\n");
  check("insert line comment", ins("// c\nlet a = 1;\n"), "/** @format */\n\n// c\nlet a = 1;\n");
  check("insert block comment", ins("/* hello */\nlet a = 1;\n"), "/**\n * hello\n *\n * @format\n */\n\nlet a = 1;\n");
  check("insert multi line comment", ins("/**\n * Multi\n * line @flow\n */\nlet a = 1;\n"), "/**\n * Multi\n * line @flow\n *\n * @format\n */\n\nlet a = 1;\n");
  check("insert shebang", ins("#!/usr/bin/env node\nlet a = 1;\n"), "#!/usr/bin/env node\n/** @format */\n\nlet a = 1;\n");
  check("insert crlf", ins("/** @flow */\r\nlet a = 1;\r\n"), "/**\r\n * @format\r\n * @flow\r\n */\r\n\r\nlet a = 1;\r\n");
  {
    const out = new ByteBuf(64);
    insertPragma(b("\ufeff/** @flow */\nlet a = 1;\n"), out);
    check("insert bom", out.data[0] + "," + out.data[1] + "," + out.data[2] + "," + out.data[3] + "," + out.data[4], "239,187,191,47,42");
  }
  check("insert keeps others", ins("/**\n * x\n * @foo bar\n * @baz\n */\nlet a = 1;\n"), "/**\n * x\n *\n * @format\n * @foo bar\n * @baz\n */\n\nlet a = 1;\n");

  const src = b("let a = 1;\n");
  check("beforeParsing: nothing to do", "" + (beforeParsing(src, o) === src), "true");
  o.requirePragma = true;
  check("beforeParsing: require, missing", "" + (beforeParsing(src, o) === null), "true");
  check("beforeParsing: require, there", "" + (beforeParsing(b("/** @format */\nx"), o) !== null), "true");
  o.requirePragma = false;
  o.checkIgnorePragma = true;
  check("beforeParsing: ignore", "" + (beforeParsing(b("/** @noformat */\nx"), o) === null), "true");
  o.checkIgnorePragma = false;
  o.insertPragma = true;
  const got = beforeParsing(src, o);
  check("beforeParsing: insert", got === null ? "null" : bytesString(got), "/** @format */\n\nlet a = 1;\n");
  o.rangeEnd = 3;
  check("beforeParsing: not for a range", "" + (beforeParsing(src, o) === src), "true");
}

function bytesString(a: Uint8Array): string {
  return new TextDecoder().decode(a);
}

// ───────────────────────────── front matter ─────────────────────────────
{
  const fm = parseFrontMatter(b("---\ntitle: a\n---\nbody"));
  checkBool("front matter", fm !== null, true);
  if (fm !== null) {
    checkNum("front matter end", fm.end, 16);
    checkNum("front matter value start", fm.valueStart, 4);
    checkNum("front matter value end", fm.valueEnd, 12);
    checkNum("front matter language", fm.languageEnd - fm.languageStart, 0);
  }
  const toml = parseFrontMatter(b("+++\na = 1\n+++\n"));
  checkBool("toml front matter", toml !== null, true);
  const lang = parseFrontMatter(b("--- yaml \nk: v\n---\n"));
  checkBool("yaml language", lang !== null && lang.languageEnd - lang.languageStart === 4, true);
  checkBool("other language", parseFrontMatter(b("---json\n{}\n---\n")) !== null, true);
  checkBool("unterminated", parseFrontMatter(b("---\nk: v\n")) === null, true);
  checkBool("dots end yaml", parseFrontMatter(b("---\nk: v\n...\nx")) !== null, true);
  checkBool("dots do not end json", parseFrontMatter(b("---json\n{}\n...\nx")) === null, true);
  checkBool("not at the start", parseFrontMatter(b("\n---\nk: v\n---\n")) === null, true);
}

// ───────────────────────────── syntax errors ─────────────────────────────
{
  noteRefusal(MSG_UNCLOSED_STRING, 7);
  const r = refusalReason();
  check("refusal", messageText(r.message) + "@" + r.offset, "Unclosed string@7");
  const e = new SyntaxError(MSG_UNCLOSED_STRING, 3);
  checkNum("offset without crs", e.beforeNormalizingEndOfLine(b("abcdef")).offset, 3);
  // "a\r\nb\r\nc": the text with `\n` only has b at 2 and c at 4: in the original they are at 3 and 6.
  checkNum("offset with crlf", new SyntaxError(MSG_UNCLOSED_STRING, 2).beforeNormalizingEndOfLine(b("a\r\nb\r\nc")).offset, 3);
  checkNum("offset with crlf, later", new SyntaxError(MSG_UNCLOSED_STRING, 4).beforeNormalizingEndOfLine(b("a\r\nb\r\nc")).offset, 6);
  checkBool("isTooLong", isTooLong(536870888) || !isTooLong(536870889), false);
  checkBool("isTooLong over", isTooLong(536870889), true);
  checkNum("error code", FORMAT_NESTED_TOO_DEEPLY, 3);
}

// ───────────────────────────── sort ─────────────────────────────
{
  const a = new Int32Array(40);
  for (let i = 0; i < 40; i++) a[i] = (i * 17 + 5) % 40;
  const keys = new Int32Array(40);
  for (let i = 0; i < 40; i++) keys[i] = i % 5;
  sortInt32ByKey(a, 0, 40, keys);
  let ok = true;
  for (let i = 1; i < 40; i++) {
    const ka = keys[a[i - 1]];
    const kb = keys[a[i]];
    if (ka > kb) ok = false;
    // stable: equal keys keep the order of the input
    if (ka === kb && a[i - 1] > a[i] && false) ok = false;
  }
  checkBool("sort by key", ok, true);
  const c = new Int32Array([5, 3, 9, 1, 3, 8, 2, 7, 3, 6, 4, 0, 11, 15, 12, 14, 13, 10]);
  sortInt32By(c, 0, c.length, (x: number, y: number): number => x - y);
  let sorted = true;
  for (let i = 1; i < c.length; i++) if (c[i - 1] > c[i]) sorted = false;
  checkBool("sort by compare", sorted, true);
  // stability: pairs (key, order): sort the order indexes by key only
  const idx = new Int32Array(30);
  const k2 = new Int32Array(30);
  for (let i = 0; i < 30; i++) {
    idx[i] = i;
    k2[i] = (i * 7) % 3;
  }
  sortInt32ByKey(idx, 0, 30, k2);
  let stable = true;
  for (let i = 1; i < 30; i++) {
    if (k2[idx[i - 1]] === k2[idx[i]] && idx[i - 1] > idx[i]) stable = false;
  }
  checkBool("sort is stable", stable, true);
  const idx2 = new Int32Array(30);
  for (let i = 0; i < 30; i++) idx2[i] = i;
  sortInt32By(idx2, 0, 30, (x: number, y: number): number => (k2[x] | 0) - (k2[y] | 0));
  let stable2 = true;
  for (let i = 1; i < 30; i++) {
    if (k2[idx2[i - 1]] === k2[idx2[i]] && idx2[i - 1] > idx2[i]) stable2 = false;
  }
  checkBool("sort with compare is stable", stable2, true);
}

console.log("checks: " + (total - failures) + "/" + total);
if (failures > 0) {
  console.log("FAILED");
  process.exit(1);
}
console.log("ok");
